export const DURABILITY_RESOLUTION_CODES = Object.freeze({
  OK: "OK",
  RESOURCE_NOT_FOUND: "RESOURCE_NOT_FOUND",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  INVALID_CHANGE_TYPE: "INVALID_CHANGE_TYPE"
});

export const DURABILITY_CHANGE_TYPES = Object.freeze({
  DAMAGE: "damage",
  HEALING: "healing"
});

/* -------------------------------------------- */

export function createActorDamageMutationPlan(actorSystem, {
  amount=null,
  damageResult=null,
  resourceId="health",
  source=null,
  target=null,
  metadata={}
}={}) {
  return createActorDurabilityMutationPlan(actorSystem, {
    type: DURABILITY_CHANGE_TYPES.DAMAGE,
    amount: amount ?? damageResult?.total,
    resourceId,
    source,
    target: target ?? damageResult?.target ?? null,
    metadata: {
      damageResult: damageResult ? clonePlain(damageResult) : null,
      ...metadata
    }
  });
}

/* -------------------------------------------- */

export function createActorHealingMutationPlan(actorSystem, {
  amount=null,
  healingResult=null,
  resourceId="health",
  source=null,
  target=null,
  metadata={}
}={}) {
  return createActorDurabilityMutationPlan(actorSystem, {
    type: DURABILITY_CHANGE_TYPES.HEALING,
    amount: amount ?? healingResult?.total,
    resourceId,
    source,
    target: target ?? healingResult?.target ?? null,
    metadata: {
      healingResult: healingResult ? clonePlain(healingResult) : null,
      ...metadata
    }
  });
}

/* -------------------------------------------- */

export function createActorDurabilityMutationPlan(actorSystem, {
  type=DURABILITY_CHANGE_TYPES.DAMAGE,
  amount=0,
  resourceId="health",
  source=null,
  target=null,
  metadata={}
}={}) {
  if ( !Object.values(DURABILITY_CHANGE_TYPES).includes(type) ) {
    return durabilityFailure(DURABILITY_RESOLUTION_CODES.INVALID_CHANGE_TYPE, {
      type,
      amount,
      resourceId,
      reason: `Unsupported durability change type: ${type}`,
      source,
      target,
      metadata
    });
  }

  const normalizedAmount = normalizeAmount(amount);
  if ( normalizedAmount == null ) {
    return durabilityFailure(DURABILITY_RESOLUTION_CODES.INVALID_AMOUNT, {
      type,
      amount,
      resourceId,
      reason: "durability amount must be a finite non-negative number",
      source,
      target,
      metadata
    });
  }

  const ref = resolveActorResourceRef(actorSystem, resourceId);
  if ( !ref ) {
    return durabilityFailure(DURABILITY_RESOLUTION_CODES.RESOURCE_NOT_FOUND, {
      type,
      amount: normalizedAmount,
      resourceId,
      reason: `Actor resource not found for ${resourceId}`,
      source,
      target,
      metadata
    });
  }

  const to = type === DURABILITY_CHANGE_TYPES.DAMAGE
    ? clamp(ref.current - normalizedAmount, 0, ref.max)
    : clamp(ref.current + normalizedAmount, 0, ref.max);
  const appliedAmount = Math.abs(to - ref.current);
  const remainder = Math.max(normalizedAmount - appliedAmount, 0);
  const updates = to === ref.current ? {} : {[ref.path]: to};

  return {
    ok: true,
    code: DURABILITY_RESOLUTION_CODES.OK,
    type,
    resourceId: ref.resourceId,
    actorResourceId: ref.actorResourceId,
    path: ref.path,
    from: ref.current,
    to,
    max: ref.max,
    amount: normalizedAmount,
    appliedAmount,
    overflow: type === DURABILITY_CHANGE_TYPES.DAMAGE ? remainder : 0,
    overheal: type === DURABILITY_CHANGE_TYPES.HEALING ? remainder : 0,
    updates,
    source: source ? clonePlain(source) : null,
    target: target ? clonePlain(target) : null,
    metadata: clonePlain(metadata) ?? {}
  };
}

/* -------------------------------------------- */

export async function commitActorDurabilityMutationPlan(actor, mutationPlan) {
  if ( !mutationPlan?.ok ) return false;
  if ( !Object.keys(mutationPlan.updates ?? {}).length ) return true;
  await actor.update(mutationPlan.updates);
  return true;
}

/* -------------------------------------------- */

function resolveActorResourceRef(actorSystem, resourceId) {
  const builtin = actorSystem?.resources?.[resourceId];
  if ( builtin ) {
    return {
      resourceId,
      actorResourceId: resourceId,
      path: `system.resources.${resourceId}.value`,
      current: Number(builtin.value ?? 0) || 0,
      max: Number(builtin.max ?? builtin.value ?? 0) || 0
    };
  }

  const index = (actorSystem?.pools ?? []).findIndex(pool => pool.id === resourceId);
  if ( index < 0 ) return null;
  const pool = actorSystem.pools[index];
  return {
    resourceId,
    actorResourceId: resourceId,
    path: `system.pools.${index}.value`,
    current: Number(pool.value ?? 0) || 0,
    max: Number(pool.max ?? pool.value ?? 0) || 0
  };
}

function durabilityFailure(code, {type, amount, resourceId, reason, source, target, metadata}) {
  return {
    ok: false,
    code,
    type,
    resourceId,
    actorResourceId: null,
    path: null,
    from: null,
    to: null,
    max: null,
    amount,
    appliedAmount: 0,
    overflow: 0,
    overheal: 0,
    updates: {},
    reason,
    source: source ? clonePlain(source) : null,
    target: target ? clonePlain(target) : null,
    metadata: clonePlain(metadata) ?? {}
  };
}

function normalizeAmount(amount) {
  if ( amount == null || amount === "" ) return null;
  const number = Number(amount);
  if ( !Number.isFinite(number) || number < 0 ) return null;
  return number;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
