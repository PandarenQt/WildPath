import {WILDPATH} from "../config.mjs";

export const EFFECT_RESOLVER_CODES = Object.freeze({
  OK: "OK",
  INVALID_CONDITION: "INVALID_CONDITION",
  INVALID_LEVEL_DELTA: "INVALID_LEVEL_DELTA",
  COMMIT_ADAPTER_REQUIRED: "COMMIT_ADAPTER_REQUIRED",
  COMMIT_FAILED: "COMMIT_FAILED"
});

export const CONDITION_EFFECT_ACTIONS = Object.freeze({
  CREATE: "create",
  UPDATE: "update",
  DELETE: "delete",
  NOOP: "noop"
});

/* -------------------------------------------- */

export function planConditionEffect({
  conditionId=null,
  type=null,
  levels=1,
  actor=null,
  target=null,
  existingConditions=null,
  conditionDefinitions=WILDPATH.CONDITIONS,
  metadata={}
}={}) {
  const id = normalizeConditionId(conditionId ?? type);
  const definitions = normalizeConditionDefinitions(conditionDefinitions);
  const definition = definitions[id] ?? null;
  if ( !id || !definition ) {
    return conditionFailure(EFFECT_RESOLVER_CODES.INVALID_CONDITION, {
      reason: `Unknown condition: ${id ?? "<missing>"}`,
      conditionId: id,
      levels,
      target,
      metadata
    });
  }

  const delta = normalizeLevels(levels);
  if ( delta == null ) {
    return conditionFailure(EFFECT_RESOLVER_CODES.INVALID_LEVEL_DELTA, {
      reason: "Condition level delta must be a finite integer.",
      conditionId: id,
      levels,
      target,
      metadata
    });
  }

  const existing = findExistingCondition(existingConditions ?? actor?.effects ?? [], id);
  const stacking = definition.stacking === true;
  const maxLevel = stacking ? normalizeMaxLevel(definition.maxLevel) : null;
  const transition = stacking
    ? planStackingConditionTransition({existing, levels: delta, maxLevel})
    : planBinaryConditionTransition({existing, levels: delta});
  const plan = {
    type: "conditionEffect",
    conditionId: id,
    levels: delta,
    action: transition.action,
    stacking,
    maxLevel,
    fromLevel: transition.fromLevel,
    toLevel: transition.toLevel,
    existingEffectId: existing?.id ?? null,
    existingEffectUuid: existing?.uuid ?? null,
    target: clonePlain(target) ?? null,
    definition: clonePlain(definition) ?? {},
    metadata: clonePlain(metadata) ?? {}
  };

  return {
    ok: true,
    code: EFFECT_RESOLVER_CODES.OK,
    resolver: "EffectResolver",
    effectType: "condition",
    conditionId: id,
    action: transition.action,
    levels: delta,
    stacking,
    maxLevel,
    fromLevel: transition.fromLevel,
    toLevel: transition.toLevel,
    existingCondition: clonePlain(existing) ?? null,
    mutationPlan: plan,
    target: clonePlain(target) ?? null,
    metadata: clonePlain(metadata) ?? {}
  };
}

/* -------------------------------------------- */

export async function executeConditionEffect({
  actor=null,
  conditionId=null,
  type=null,
  levels=1,
  target=null,
  existingConditions=null,
  conditionDefinitions=WILDPATH.CONDITIONS,
  commitConditionPlan=null,
  metadata={}
}={}) {
  const conditionPlan = planConditionEffect({
    conditionId,
    type,
    levels,
    actor,
    target,
    existingConditions,
    conditionDefinitions,
    metadata
  });
  if ( !conditionPlan.ok ) return conditionPlan;

  if ( conditionPlan.action === CONDITION_EFFECT_ACTIONS.NOOP ) {
    return {
      ...conditionPlan,
      committed: false,
      effect: findExistingConditionDocument(actor, conditionPlan.conditionId)
    };
  }

  if ( typeof commitConditionPlan !== "function" ) {
    return {
      ok: false,
      code: EFFECT_RESOLVER_CODES.COMMIT_ADAPTER_REQUIRED,
      resolver: "EffectResolver",
      effectType: "condition",
      conditionId: conditionPlan.conditionId,
      reason: "Condition effects require a Foundry commit adapter before document mutation.",
      conditionPlan,
      mutationPlan: conditionPlan.mutationPlan,
      committed: false,
      effect: null
    };
  }

  try {
    const effect = await commitConditionPlan({
      actor,
      plan: conditionPlan.mutationPlan,
      conditionPlan
    });
    if ( effect === false ) {
      return conditionCommitFailure("Condition commit adapter returned false.", conditionPlan);
    }
    return {
      ...conditionPlan,
      committed: true,
      effect: effect ?? null
    };
  } catch (error) {
    return conditionCommitFailure(error?.message ?? String(error), conditionPlan);
  }
}

/* -------------------------------------------- */

function planBinaryConditionTransition({existing, levels}) {
  const active = !!existing;
  if ( levels > 0 ) {
    return {
      action: active ? CONDITION_EFFECT_ACTIONS.NOOP : CONDITION_EFFECT_ACTIONS.CREATE,
      fromLevel: active ? 1 : null,
      toLevel: 1
    };
  }
  if ( levels < 0 ) {
    return {
      action: active ? CONDITION_EFFECT_ACTIONS.DELETE : CONDITION_EFFECT_ACTIONS.NOOP,
      fromLevel: active ? 1 : null,
      toLevel: null
    };
  }
  return {
    action: CONDITION_EFFECT_ACTIONS.NOOP,
    fromLevel: active ? 1 : null,
    toLevel: active ? 1 : null
  };
}

function planStackingConditionTransition({existing, levels, maxLevel}) {
  const currentLevel = existing ? normalizeExistingLevel(existing.level) : null;
  if ( !existing ) {
    if ( levels <= 0 ) {
      return {
        action: CONDITION_EFFECT_ACTIONS.NOOP,
        fromLevel: null,
        toLevel: null
      };
    }
    return {
      action: CONDITION_EFFECT_ACTIONS.CREATE,
      fromLevel: null,
      toLevel: clampLevel(levels, maxLevel)
    };
  }

  const rawLevel = currentLevel + levels;
  if ( rawLevel <= 0 ) {
    return {
      action: CONDITION_EFFECT_ACTIONS.DELETE,
      fromLevel: currentLevel,
      toLevel: null
    };
  }
  const level = clampLevel(rawLevel, maxLevel);
  return {
    action: level === currentLevel ? CONDITION_EFFECT_ACTIONS.NOOP : CONDITION_EFFECT_ACTIONS.UPDATE,
    fromLevel: currentLevel,
    toLevel: level
  };
}

function findExistingCondition(conditions, conditionId) {
  for ( const condition of collectionContents(conditions) ) {
    const normalized = normalizeConditionEntry(condition);
    if ( normalized?.conditionId === conditionId ) return normalized;
  }
  return null;
}

function findExistingConditionDocument(actor, conditionId) {
  return collectionContents(actor?.effects ?? []).find(effect => {
    const normalized = normalizeConditionEntry(effect);
    return normalized?.conditionId === conditionId;
  }) ?? null;
}

function normalizeConditionEntry(effect) {
  if ( !effect || typeof effect !== "object" ) return null;
  const explicitConditionId = effect.conditionId ?? effect.system?.type ?? effect.typeId;
  if ( effect.type && effect.type !== "condition" && !explicitConditionId ) return null;
  const conditionId = normalizeConditionId(explicitConditionId ?? effect.slug);
  if ( !conditionId ) return null;
  return {
    id: effect.id ?? effect.effectId ?? null,
    uuid: effect.uuid ?? null,
    conditionId,
    type: "condition",
    name: effect.name ?? null,
    level: normalizeExistingLevel(effect.level ?? effect.system?.level ?? 1),
    disabled: effect.disabled === true
  };
}

function normalizeConditionDefinitions(definitions) {
  if ( Array.isArray(definitions) ) {
    return Object.fromEntries(definitions
      .map(definition => [normalizeConditionId(definition?.id), definition])
      .filter(([id]) => !!id));
  }
  if ( definitions && typeof definitions === "object" ) return Object.fromEntries(
    Object.entries(definitions).map(([id, definition]) => [normalizeConditionId(definition?.id ?? id), definition])
  );
  return {};
}

function normalizeConditionId(value) {
  if ( value == null || value === "" ) return null;
  return String(value);
}

function normalizeLevels(value) {
  const number = Number(value);
  if ( !Number.isFinite(number) || !Number.isInteger(number) ) return null;
  return number;
}

function normalizeExistingLevel(value) {
  const number = Number(value);
  if ( !Number.isFinite(number) || number < 1 ) return 1;
  return Math.floor(number);
}

function normalizeMaxLevel(value) {
  const number = Number(value);
  if ( !Number.isFinite(number) || number < 1 ) return Infinity;
  return Math.floor(number);
}

function clampLevel(level, maxLevel) {
  return Math.min(Math.max(Math.floor(level), 1), maxLevel);
}

function conditionFailure(code, {reason, conditionId, levels, target, metadata}) {
  return {
    ok: false,
    code,
    resolver: "EffectResolver",
    effectType: "condition",
    conditionId,
    levels,
    reason,
    mutationPlan: null,
    target: clonePlain(target) ?? null,
    metadata: clonePlain(metadata) ?? {}
  };
}

function conditionCommitFailure(reason, conditionPlan) {
  return {
    ok: false,
    code: EFFECT_RESOLVER_CODES.COMMIT_FAILED,
    resolver: "EffectResolver",
    effectType: "condition",
    conditionId: conditionPlan.conditionId,
    reason,
    conditionPlan,
    mutationPlan: conditionPlan.mutationPlan,
    committed: false,
    effect: null
  };
}

function collectionContents(collection) {
  if ( collection == null ) return [];
  if ( Array.isArray(collection) ) return collection;
  if ( collection instanceof Map ) return [...collection.values()];
  if ( typeof collection.values === "function" ) return [...collection.values()];
  if ( typeof collection === "object" ) return Object.values(collection);
  return [];
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
