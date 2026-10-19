import {createFoundryV14ActorPersistenceAdapter} from "../adapters/foundry-v14-persistence-adapter.mjs";

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
  // Temporary Hit Points are lost first (2024): only what is left reaches the resource, so damage they absorb at 0
  // health is no failed death save. `temporary` records their loss.
  const total = amount ?? damageResult?.total;
  const temp = temporaryOf(actorSystem, resourceId);
  const absorbed = Math.min(temp, normalizeAmount(total) ?? 0);
  const plan = createActorDurabilityMutationPlan(actorSystem, {
    type: DURABILITY_CHANGE_TYPES.DAMAGE,
    amount: absorbed ? normalizeAmount(total) - absorbed : total,
    resourceId,
    source,
    target: target ?? damageResult?.target ?? null,
    metadata: {
      damageResult: damageResult ? clonePlain(damageResult) : null,
      ...metadata
    }
  });
  return absorbed ? withTemporary(plan, resourceId, temp, temp - absorbed) : plan;
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
  // Temporary Hit Points (`healingType: "temporary"`, False Life) heal nothing; they replace the creature's own only
  // when higher, as they never stack (2024).
  const temporary = Math.max(Number(healingResult?.byHealingType?.temporary) || 0, 0);
  const total = amount ?? healingResult?.total;
  const plan = createActorDurabilityMutationPlan(actorSystem, {
    type: DURABILITY_CHANGE_TYPES.HEALING,
    amount: temporary ? Math.max((normalizeAmount(total) ?? 0) - temporary, 0) : total,
    resourceId,
    source,
    target: target ?? healingResult?.target ?? null,
    metadata: {
      healingResult: healingResult ? clonePlain(healingResult) : null,
      ...metadata
    }
  });
  const temp = temporaryOf(actorSystem, resourceId);
  return (temporary > temp) ? withTemporary(plan, resourceId, temp, temporary) : plan;
}

/** A built-in resource's Temporary Hit Points (`health.temp`), 0 without any. */
function temporaryOf(actorSystem, resourceId) {
  return Math.max(Number(actorSystem?.resources?.[resourceId]?.temp) || 0, 0);
}

/** The plan, also setting the resource's Temporary Hit Points from `from` to `to` (rolled back with it). */
function withTemporary(plan, resourceId, from, to) {
  if ( !plan.ok ) return plan;
  const path = `system.resources.${resourceId}.temp`;
  return {...plan, temporary: {path, from, to}, updates: {...plan.updates, [path]: to}};
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

  // A stale upper maximum must not amplify damage or turn healing into resource loss.
  const isDamage = type === DURABILITY_CHANGE_TYPES.DAMAGE;
  const to = isDamage
    ? Math.max(ref.current - normalizedAmount, 0)
    : Math.max(ref.current, Math.min(ref.current + normalizedAmount, ref.max));
  const appliedAmount = isDamage ? ref.current - to : to - ref.current;
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

export async function commitActorDurabilityMutationPlan(actor, mutationPlan, {persistencePort=null}={}) {
  if ( !mutationPlan?.ok ) return false;
  if ( !Object.keys(mutationPlan.updates ?? {}).length ) return true;
  const persistence = persistencePort ?? createFoundryV14ActorPersistenceAdapter();
  // Its damage types, most first, for the floating text over the creature (floating-text.mts).
  const byType = mutationPlan.metadata?.damageResult?.byDamageType ?? {};
  const damageTypes = Object.keys(byType).filter(type => Number(byType[type]) > 0).sort((a, b) => byType[b] - byType[a]);
  const result = await persistence.updateActor({
    actor,
    actorRef: actor?.uuid ?? (actor?.id ? `actor:${actor.id}` : null),
    updates: mutationPlan.updates,
    ...(damageTypes.length ? {operation: {wildpath: {damageTypes}}} : {}),
    metadata: {
      resolver: "DurabilityResolver",
      mutationPlan
    }
  });
  return result !== false && result?.ok !== false;
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

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
