import {
  FOUNDRY_PERSISTENCE_CODES,
  createFoundryV14EffectPersistenceAdapter
} from "../adapters/foundry-v14-persistence-adapter.mjs";
import {CONDITION_EFFECT_ACTIONS} from "./effect-resolver.mjs";

export const CONDITION_EFFECT_COMMIT_CODES = Object.freeze({
  OK: "OK",
  INVALID_PLAN: "INVALID_PLAN",
  ACTOR_COMMIT_UNAVAILABLE: "ACTOR_COMMIT_UNAVAILABLE",
  EFFECT_NOT_FOUND: "EFFECT_NOT_FOUND",
  COMMIT_FAILED: "COMMIT_FAILED",
  ROLLBACK_FAILED: "ROLLBACK_FAILED"
});

/* -------------------------------------------- */

export async function commitConditionEffectMutationPlan(actor, plan, {persistencePort=null}={}) {
  if ( !actor || plan?.type !== "conditionEffect" || !plan.conditionId ) {
    return commitFailure(CONDITION_EFFECT_COMMIT_CODES.INVALID_PLAN, "Condition effect commit requires an Actor and conditionEffect plan.", plan);
  }

  const persistence = persistencePort ?? createFoundryV14EffectPersistenceAdapter();
  try {
    const beforeEffect = findConditionEffect(actor, plan);
    const before = snapshotConditionEffect(beforeEffect);
    const afterEffect = await applyConditionDelta(actor, plan, beforeEffect, persistence);
    return {
      ok: true,
      code: CONDITION_EFFECT_COMMIT_CODES.OK,
      action: plan.action,
      conditionId: plan.conditionId,
      before,
      after: snapshotConditionEffect(afterEffect),
      effectId: afterEffect?.id ?? beforeEffect?.id ?? null
    };
  } catch (error) {
    return commitFailure(CONDITION_EFFECT_COMMIT_CODES.COMMIT_FAILED, error?.message ?? String(error), plan);
  }
}

/* -------------------------------------------- */

export async function rollbackConditionEffectMutationPlan(actor, plan, _mutationPlan=null, commitResult=null, {persistencePort=null}={}) {
  if ( !commitResult || commitResult.ok === false ) return false;

  const persistence = persistencePort ?? createFoundryV14EffectPersistenceAdapter();
  try {
    if ( commitResult.before ) {
      return await restoreConditionEffectSnapshot(actor, commitResult.before, persistence);
    }

    const created = commitResult.after ? findConditionEffect(actor, commitResult.after) : null;
    if ( created ) await deleteConditionEffect(created, persistence);
    return true;
  } catch (_error) {
    return false;
  }
}

/* -------------------------------------------- */

async function applyConditionDelta(actor, plan, existingEffect, persistence) {
  const levels = Number(plan.levels ?? 0);
  if ( !Number.isFinite(levels) || !Number.isInteger(levels) ) {
    throw new Error("Condition effect level delta must be a finite integer.");
  }

  if ( plan.stacking ) return applyStackingConditionDelta(actor, plan, existingEffect, levels, persistence);
  return applyBinaryConditionDelta(actor, plan, existingEffect, levels, persistence);
}

async function applyBinaryConditionDelta(actor, plan, existingEffect, levels, persistence) {
  if ( levels <= 0 ) {
    if ( existingEffect ) await deleteConditionEffect(existingEffect, persistence);
    return null;
  }

  const effect = existingEffect ?? await createConditionEffect(actor, plan, null, persistence);
  if ( existingEffect && effect && shouldPersistLifecycleMetadata(plan) ) {
    await updateConditionEffect(effect, lifecycleUpdates(plan, null), persistence);
  }
  return effect;
}

async function applyStackingConditionDelta(actor, plan, existingEffect, levels, persistence) {
  if ( existingEffect ) {
    const current = normalizeExistingLevel(existingEffect.system?.level ?? existingEffect.level ?? 1);
    const rawLevel = current + levels;
    if ( rawLevel <= 0 ) {
      await deleteConditionEffect(existingEffect, persistence);
      return null;
    }

    const level = clampLevel(rawLevel, plan.maxLevel);
    await updateConditionEffect(existingEffect, conditionEffectUpdates(plan, level), persistence);
    return existingEffect;
  }

  if ( levels <= 0 ) return null;
  const level = clampLevel(levels, plan.maxLevel);
  return createConditionEffect(actor, plan, level, persistence);
}

async function createConditionEffect(actor, plan, level, persistence) {
  const data = conditionEffectDocumentData(plan, level);
  if ( typeof actor.toggleStatusEffect === "function" ) {
    const toggle = await persistence.toggleStatusEffect({
      actor,
      actorRef: actor?.uuid ?? (actor?.id ? `actor:${actor.id}` : null),
      statusId: plan.conditionId,
      active: true,
      metadata: {
        resolver: "ConditionEffectCommitResolver",
        mutationPlan: plan
      }
    });
    if ( toggle?.ok === false && toggle.code !== FOUNDRY_PERSISTENCE_CODES.UNSUPPORTED_OPERATION ) {
      throw new Error(toggle.reason ?? toggle.code ?? "Actor status toggle failed.");
    }
    const effect = toggle?.ok ? toggle.result : null;
    if ( effect ) {
      await updateConditionEffect(effect, conditionEffectUpdates(plan, level), persistence);
      return effect;
    }
  }

  const created = await persistence.createEmbeddedDocuments({
    actor,
    actorRef: actor?.uuid ?? (actor?.id ? `actor:${actor.id}` : null),
    embeddedName: "ActiveEffect",
    documents: [data],
    metadata: {
      resolver: "ConditionEffectCommitResolver",
      mutationPlan: plan
    }
  });
  if ( created?.ok === false ) {
    throw new Error(created.reason ?? created.code ?? "Actor cannot create condition ActiveEffects.");
  }
  return collectionContents(created?.result ?? created)[0] ?? null;
}

async function updateConditionEffect(effect, updates, persistence) {
  if ( !effect || !Object.keys(updates ?? {}).length ) return effect;
  const updated = await persistence.updateDocument({
    document: effect,
    documentRef: effect.uuid ?? effect.id ?? null,
    updates,
    metadata: {
      resolver: "ConditionEffectCommitResolver",
      effectId: effect.id ?? null
    }
  });
  if ( updated?.ok === false ) throw new Error(updated.reason ?? updated.code ?? "ActiveEffect cannot be updated.");
  return effect;
}

async function deleteConditionEffect(effect, persistence) {
  const deleted = await persistence.deleteDocument({
    document: effect,
    documentRef: effect.uuid ?? effect.id ?? null,
    metadata: {
      resolver: "ConditionEffectCommitResolver",
      effectId: effect.id ?? null
    }
  });
  if ( deleted?.ok === false ) throw new Error(deleted.reason ?? deleted.code ?? "ActiveEffect cannot be deleted.");
  return true;
}

async function restoreConditionEffectSnapshot(actor, snapshot, persistence) {
  const existing = findConditionEffect(actor, snapshot);
  if ( existing ) {
    await updateConditionEffect(existing, restoreUpdatesFromSnapshot(snapshot), persistence);
    return true;
  }

  const created = await persistence.createEmbeddedDocuments({
    actor,
    actorRef: actor?.uuid ?? (actor?.id ? `actor:${actor.id}` : null),
    embeddedName: "ActiveEffect",
    documents: [clonePlain(snapshot.data)],
    metadata: {
      resolver: "ConditionEffectCommitResolver",
      rollback: true
    }
  });
  return created !== false && created?.ok !== false;
}

function conditionEffectDocumentData(plan, level) {
  const data = {
    type: "condition",
    name: conditionDisplayName(plan, level),
    img: plan.definition?.img ?? undefined,
    statuses: [plan.conditionId],
    system: {
      type: plan.conditionId,
      level: plan.stacking ? level : null
    }
  };
  const updates = conditionEffectUpdates(plan, level);
  applyUpdatesToData(data, updates);
  return pruneUndefined(data);
}

function conditionEffectUpdates(plan, level) {
  return {
    ...(plan.stacking ? {
      "system.level": level,
      name: conditionDisplayName(plan, level)
    } : {}),
    ...lifecycleUpdates(plan, level)
  };
}

function lifecycleUpdates(plan, level) {
  return {
    ...(plan.duration ? {duration: clonePlain(plan.duration)} : {}),
    ...(plan.originRef ? {origin: plan.originRef} : {}),
    ...(shouldPersistLifecycleMetadata(plan) ? {
      "flags.wildpath.conditionEffect": {
        conditionId: plan.conditionId,
        level,
        duration: clonePlain(plan.duration) ?? null,
        concentration: clonePlain(plan.concentration) ?? null,
        sourceRef: plan.sourceRef ?? null,
        originRef: plan.originRef ?? null,
        metadata: clonePlain(plan.metadata) ?? {}
      }
    } : {})
  };
}

function shouldPersistLifecycleMetadata(plan) {
  return !!(plan.duration || plan.concentration || plan.sourceRef || plan.originRef || Object.keys(plan.metadata ?? {}).length);
}

function conditionDisplayName(plan, level) {
  const label = plan.definition?.name ?? plan.conditionId;
  return plan.stacking && level != null ? `${label} (${level})` : label;
}

function restoreUpdatesFromSnapshot(snapshot) {
  const data = clonePlain(snapshot.data) ?? {};
  delete data.id;
  delete data._id;
  delete data.uuid;
  return data;
}

function snapshotConditionEffect(effect) {
  if ( !effect ) return null;
  const data = effect.toObject ? effect.toObject() : {
    id: effect.id ?? null,
    uuid: effect.uuid ?? null,
    type: effect.type ?? "condition",
    name: effect.name ?? null,
    img: effect.img ?? null,
    statuses: collectionContents(effect.statuses),
    system: clonePlain(effect.system) ?? {},
    duration: clonePlain(effect.duration) ?? null,
    origin: effect.origin ?? null,
    flags: clonePlain(effect.flags) ?? {}
  };
  return {
    id: effect.id ?? data._id ?? data.id ?? null,
    uuid: effect.uuid ?? data.uuid ?? null,
    conditionId: effect.system?.type ?? data.system?.type ?? effect.conditionId ?? data.conditionId ?? null,
    data: clonePlain(data)
  };
}

function findConditionEffect(actor, planOrSnapshot) {
  const conditionId = planOrSnapshot?.conditionId ?? planOrSnapshot?.data?.system?.type ?? null;
  const id = planOrSnapshot?.existingEffectId ?? planOrSnapshot?.id ?? planOrSnapshot?.data?._id ?? planOrSnapshot?.data?.id ?? null;
  const uuid = planOrSnapshot?.existingEffectUuid ?? planOrSnapshot?.uuid ?? planOrSnapshot?.data?.uuid ?? null;
  return collectionContents(actor?.effects ?? []).find(effect => {
    if ( id && (effect.id === id || effect._id === id) ) return true;
    if ( uuid && effect.uuid === uuid ) return true;
    return conditionId && effect.type === "condition" && effect.system?.type === conditionId;
  }) ?? null;
}

function normalizeExistingLevel(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : 1;
}

function clampLevel(level, maxLevel) {
  const max = Number.isFinite(maxLevel) ? maxLevel : Infinity;
  return Math.min(Math.max(Math.floor(level), 1), max);
}

function applyUpdatesToData(data, updates) {
  for ( const [path, value] of Object.entries(updates ?? {}) ) {
    if ( !path.includes(".") ) {
      data[path] = clonePlain(value);
      continue;
    }

    const parts = path.split(".");
    let cursor = data;
    for ( const part of parts.slice(0, -1) ) {
      cursor[part] ??= {};
      cursor = cursor[part];
    }
    cursor[parts.at(-1)] = clonePlain(value);
  }
}

function pruneUndefined(value) {
  if ( Array.isArray(value) ) return value.map(pruneUndefined);
  if ( !value || typeof value !== "object" ) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([_key, entry]) => entry !== undefined)
    .map(([key, entry]) => [key, pruneUndefined(entry)]));
}

function commitFailure(code, reason, plan) {
  return {
    ok: false,
    code,
    reason,
    action: plan?.action ?? null,
    conditionId: plan?.conditionId ?? null,
    before: null,
    after: null,
    effectId: null
  };
}

function collectionContents(collection) {
  if ( collection == null ) return [];
  if ( Array.isArray(collection) ) return collection;
  if ( collection instanceof Set ) return [...collection.values()];
  if ( collection instanceof Map ) return [...collection.values()];
  if ( typeof collection.values === "function" ) return [...collection.values()];
  if ( typeof collection === "object" ) return Object.values(collection);
  return [];
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
