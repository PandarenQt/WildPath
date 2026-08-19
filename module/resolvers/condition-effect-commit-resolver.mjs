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

export async function commitConditionEffectMutationPlan(actor, plan) {
  if ( !actor || plan?.type !== "conditionEffect" || !plan.conditionId ) {
    return commitFailure(CONDITION_EFFECT_COMMIT_CODES.INVALID_PLAN, "Condition effect commit requires an Actor and conditionEffect plan.", plan);
  }

  try {
    const beforeEffect = findConditionEffect(actor, plan);
    const before = snapshotConditionEffect(beforeEffect);
    const afterEffect = await applyConditionDelta(actor, plan, beforeEffect);
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

export async function rollbackConditionEffectMutationPlan(actor, plan, _mutationPlan=null, commitResult=null) {
  if ( !commitResult || commitResult.ok === false ) return false;

  try {
    if ( commitResult.before ) {
      return await restoreConditionEffectSnapshot(actor, commitResult.before);
    }

    const created = commitResult.after ? findConditionEffect(actor, commitResult.after) : null;
    if ( created ) await created.delete();
    return true;
  } catch (_error) {
    return false;
  }
}

/* -------------------------------------------- */

async function applyConditionDelta(actor, plan, existingEffect) {
  const levels = Number(plan.levels ?? 0);
  if ( !Number.isFinite(levels) || !Number.isInteger(levels) ) {
    throw new Error("Condition effect level delta must be a finite integer.");
  }

  if ( plan.stacking ) return applyStackingConditionDelta(actor, plan, existingEffect, levels);
  return applyBinaryConditionDelta(actor, plan, existingEffect, levels);
}

async function applyBinaryConditionDelta(actor, plan, existingEffect, levels) {
  if ( levels <= 0 ) {
    if ( existingEffect ) await existingEffect.delete();
    return null;
  }

  const effect = existingEffect ?? await createConditionEffect(actor, plan, null);
  if ( effect && shouldPersistLifecycleMetadata(plan) ) {
    await updateConditionEffect(effect, lifecycleUpdates(plan, null));
  }
  return effect;
}

async function applyStackingConditionDelta(actor, plan, existingEffect, levels) {
  if ( existingEffect ) {
    const current = normalizeExistingLevel(existingEffect.system?.level ?? existingEffect.level ?? 1);
    const rawLevel = current + levels;
    if ( rawLevel <= 0 ) {
      await existingEffect.delete();
      return null;
    }

    const level = clampLevel(rawLevel, plan.maxLevel);
    await updateConditionEffect(existingEffect, conditionEffectUpdates(plan, level));
    return existingEffect;
  }

  if ( levels <= 0 ) return null;
  const level = clampLevel(levels, plan.maxLevel);
  return createConditionEffect(actor, plan, level);
}

async function createConditionEffect(actor, plan, level) {
  const data = conditionEffectDocumentData(plan, level);
  if ( typeof actor.toggleStatusEffect === "function" ) {
    const effect = await actor.toggleStatusEffect(plan.conditionId, {active: true});
    if ( effect ) {
      await updateConditionEffect(effect, conditionEffectUpdates(plan, level));
      return effect;
    }
  }

  if ( typeof actor.createEmbeddedDocuments === "function" ) {
    const created = await actor.createEmbeddedDocuments("ActiveEffect", [data]);
    return collectionContents(created)[0] ?? null;
  }

  throw new Error("Actor cannot create condition ActiveEffects.");
}

async function updateConditionEffect(effect, updates) {
  if ( !effect || !Object.keys(updates ?? {}).length ) return effect;
  if ( typeof effect.update !== "function" ) throw new Error("ActiveEffect cannot be updated.");
  await effect.update(updates);
  return effect;
}

async function restoreConditionEffectSnapshot(actor, snapshot) {
  const existing = findConditionEffect(actor, snapshot);
  if ( existing ) {
    await updateConditionEffect(existing, restoreUpdatesFromSnapshot(snapshot));
    return true;
  }

  if ( typeof actor.createEmbeddedDocuments !== "function" ) return false;
  await actor.createEmbeddedDocuments("ActiveEffect", [clonePlain(snapshot.data)]);
  return true;
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
