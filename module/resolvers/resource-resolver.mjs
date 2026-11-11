import {
  ACTOR_RESOURCE_TO_ECONOMY_ID,
  commitPaymentPlan,
  economyResourcesFromActorResources,
  resolvePaymentOptions,
  selectDefaultPaymentOption
} from "../helpers/action-economy.mjs";

import {createFoundryV14ActorPersistenceAdapter} from "../adapters/foundry-v14-persistence-adapter.mjs";
import {remainingMovement} from "../helpers/movement-modes.mjs";
import {evaluateValueExpression} from "../helpers/value-expressions.mjs";

export const RESOURCE_RESOLUTION_CODES = Object.freeze({
  OK: "OK",
  PAYMENT_UNAVAILABLE: "PAYMENT_UNAVAILABLE",
  PAYMENT_OPTION_NOT_FOUND: "PAYMENT_OPTION_NOT_FOUND",
  COMMIT_FAILED: "COMMIT_FAILED",
  RESOURCE_NOT_FOUND: "RESOURCE_NOT_FOUND",
  INSUFFICIENT_RESOURCE: "INSUFFICIENT_RESOURCE"
});

const ECONOMY_ID_TO_ACTOR_RESOURCE = Object.freeze(Object.fromEntries(
  Object.entries(ACTOR_RESOURCE_TO_ECONOMY_ID).map(([actorResourceId, economyId]) => [economyId, actorResourceId])
));

/* -------------------------------------------- */

/** @param {{actorSystem: unknown, cost: unknown, action?: object, policies?: object,
 * selectedPaymentOptionId?: string|null, selectedPaymentPlan?: object|null}} options */
export function resolveActorResourcePayment({
  actorSystem,
  cost,
  action={},
  policies={},
  selectedPaymentOptionId=null,
  selectedPaymentPlan=null
}={}) {
  const resources = economyResourcesFromActorResources(actorSystem);
  const discovery = resolvePaymentOptions({cost, resources, action, policies});
  if ( discovery.status !== "available" ) {
    return {
      ok: false,
      code: RESOURCE_RESOLUTION_CODES.PAYMENT_UNAVAILABLE,
      discovery,
      paymentPlan: null,
      resourcesBefore: resources,
      resourcesAfter: resources,
      mutationPlan: null
    };
  }

  const paymentPlan = selectPaymentOption(discovery.options, {
    selectedPaymentOptionId,
    selectedPaymentPlan
  });
  if ( !paymentPlan ) {
    return {
      ok: false,
      code: RESOURCE_RESOLUTION_CODES.PAYMENT_OPTION_NOT_FOUND,
      discovery,
      paymentPlan: null,
      resourcesBefore: resources,
      resourcesAfter: resources,
      mutationPlan: null
    };
  }

  const committed = commitPaymentPlan(resources, paymentPlan);
  if ( !committed.ok ) {
    return {
      ok: false,
      code: RESOURCE_RESOLUTION_CODES.COMMIT_FAILED,
      discovery,
      paymentPlan,
      resourcesBefore: resources,
      resourcesAfter: committed.resources,
      mutationPlan: null,
      commit: committed
    };
  }

  const mutationPlan = createActorResourceMutationPlan(actorSystem, paymentPlan);
  if ( !mutationPlan.ok ) {
    return {
      ok: false,
      code: mutationPlan.code,
      discovery,
      paymentPlan,
      resourcesBefore: resources,
      resourcesAfter: committed.resources,
      mutationPlan,
      commit: committed
    };
  }

  return {
    ok: true,
    code: RESOURCE_RESOLUTION_CODES.OK,
    discovery,
    paymentPlan,
    resourcesBefore: resources,
    resourcesAfter: committed.resources,
    mutationPlan,
    commit: committed
  };
}

/* -------------------------------------------- */

export function createActorResourceMutationPlan(actorSystem, paymentPlan) {
  const payments = paymentPlan?.resources ?? [];
  const grouped = new Map();
  for ( const payment of payments ) {
    const ref = resolveActorResourceRef(actorSystem, payment.resourceId);
    if ( !ref ) {
      return {
        ok: false,
        code: RESOURCE_RESOLUTION_CODES.RESOURCE_NOT_FOUND,
        reason: `Actor resource not found for ${payment.resourceId}`,
        updates: {},
        payments: []
      };
    }
    const entry = grouped.get(ref.path) ?? {
      ...ref,
      // Movement in another mode has what that mode's Speed leaves (movement-modes.mts).
      ...(ref.counted && payment.source?.movementMode && actorSystem?.speeds
        ? {current: remainingMovement(payment.source.movementMode, actorSystem.speeds, ref.spent)} : {}),
      amount: 0,
      payments: []
    };
    const amount = Math.max(Number(payment.amount ?? 0) || 0, 0);
    entry.amount += amount;
    entry.payments.push({...clonePlain(payment), amount});
    grouped.set(ref.path, entry);
  }

  const updates = {};
  const plannedPayments = [];
  for ( const entry of grouped.values() ) {
    if ( entry.current < entry.amount ) {
      return {
        ok: false,
        code: RESOURCE_RESOLUTION_CODES.INSUFFICIENT_RESOURCE,
        reason: `${entry.resourceId} has ${entry.current} but needs ${entry.amount}`,
        updates: {},
        payments: []
      };
    }
    // The insufficient-resource check above guarantees this stays >= 0; spend exactly the cost.
    const value = entry.current - entry.amount;
    // A counted resource stores what was spent (so movement spent in a faster mode can exceed walking Speed);
    // the Actor derives its stored remaining value from that. `from`/`to` are what the path holds, for rollback.
    updates[entry.path] = entry.counted ? entry.spent + entry.amount : value;
    plannedPayments.push({
      resourceId: entry.resourceId,
      actorResourceId: entry.actorResourceId,
      path: entry.path,
      from: entry.counted ? entry.spent : entry.current,
      to: updates[entry.path],
      amount: entry.amount,
      payments: entry.payments
    });
  }

  return {
    ok: true,
    code: RESOURCE_RESOLUTION_CODES.OK,
    updates,
    payments: plannedPayments
  };
}

/* -------------------------------------------- */

/**
 * Add to a payment's mutation plan the pools the Action refills (`restores`: Multiattack's attacks, a use given
 * back), each up to its maximum, after what the payment itself spends. A pool the creature lacks is skipped. A restore
 * with `refuseWhenFull` makes the plan fail (`RESOURCE_FULL`) while its pool is full; `amountExpression` is its amount
 * worked out for the creature.
 */
export function withResourceRestores(actorSystem, mutationPlan, restores=[], costs=null) {
  if ( !mutationPlan?.ok || !restores.length ) return mutationPlan;
  // An extra Action given for listed Actions (a pool with `pays`) is one use of the Action: paid from it, the Action
  // refills no pool its own costs could pay from instead (Extra Attack's, `costs`), so Haste's "one attack only" starts
  // no sequence. Its other restores (a Flurry of Blows' strikes) are its effect and still happen.
  const extra = new Set((actorSystem?.pools ?? []).filter(pool => pool.pays?.length).map(pool => pool.id));
  if ( (mutationPlan.payments ?? []).some(payment => extra.has(payment.resourceId)
    && ((Number(payment.from) || 0) > (Number(payment.to) || 0))) ) {
    const own = new Set([...(costs?.allOf ?? []), ...(costs?.anyOf ?? []).flat()].map(cost => cost?.capability));
    restores = restores.filter(restore => !own.has(restore.resourceId));
    if ( !restores.length ) return mutationPlan;
  }
  const updates = {...mutationPlan.updates};
  // Each restore is recorded with what the pool held before, so the transaction can roll it back.
  const payments = (mutationPlan.payments ?? []).map(payment => ({...payment}));
  const restored = [];
  for ( const {resourceId, amount: fixed, amountExpression, refuseWhenFull} of restores ) {
    const amountOf = () => (amountExpression
      ? Math.max(Math.trunc(Number(evaluateValueExpression(amountExpression, {actorSystem}).value) || 0), 0) : fixed);
    // A counted built-in resource (movement: Pounce's "moves up to half its Speed") gives back what was spent.
    const counted = actorSystem?.resources?.[resourceId];
    if ( counted && Number.isFinite(Number(counted.spent)) ) {
      const path = `system.resources.${resourceId}.spent`;
      const from = Number(updates[path] ?? counted.spent) || 0;
      updates[path] = Math.max(from - amountOf(), 0);
      payments.push({resourceId, actorResourceId: resourceId, path, from: Number(counted.spent) || 0, to: updates[path], amount: 0});
      restored.push({resourceId, path, from, to: updates[path], amount: from - updates[path]});
      continue;
    }
    const index = (actorSystem?.pools ?? []).findIndex(pool => pool.id === resourceId);
    if ( index < 0 ) continue;
    const pool = actorSystem.pools[index];
    const path = `system.pools.${index}.value`;
    // A payment never refills a pool it drew from (an Extra Attack paid from its own pool).
    if ( payments.some(payment => (payment.path === path) && ((Number(payment.from) || 0) > (Number(payment.to) || 0))) ) continue;
    const from = Number(updates[path] ?? pool.value ?? 0) || 0;
    if ( refuseWhenFull && (from >= (Number(pool.max ?? 0) || 0)) ) {
      return {...mutationPlan, ok: false, code: "RESOURCE_FULL", reason: `${resourceId} is full`};
    }
    const amount = amountOf();
    updates[path] = Math.min(from + amount, Number(pool.max ?? 0) || 0);
    const paid = payments.find(payment => payment.path === path);
    if ( paid ) paid.to = updates[path];
    else payments.push({resourceId, actorResourceId: resourceId, path, from: Number(pool.value ?? 0) || 0, to: updates[path], amount: 0});
    restored.push({resourceId, path, from, to: updates[path], amount, ...(refuseWhenFull ? {refuseWhenFull} : {})});
  }
  return {...mutationPlan, updates, payments, restores: restored};
}

/* -------------------------------------------- */

/**
 * A payment's mutation plan redone on its payer's resources as they are now (`liveSystem`), for a commit after another
 * write landed on them since the Action began (another Action's payment, a refill): each resource keeps its own change
 * (`to - from`), a restore up to its maximum, and a spend that what is left can no longer pay fails
 * (`INSUFFICIENT_RESOURCE`). The same plan when nothing changed.
 * shortcut: counted movement is not checked against Speed again; do so if a move between plan and commit shows in play.
 */
export function rebaseActorResourceMutationPlan(liveSystem, plan) {
  if ( !plan?.ok || !plan.payments?.length ) return plan;
  // Each planned path: where it is now (a pool found by its id), and how far it moved since planning.
  const moved = new Map();
  for ( const payment of plan.payments ) {
    if ( moved.has(payment.path) || !Object.hasOwn(plan.updates ?? {}, payment.path) ) continue;
    // A restore of a counted built-in resource names it by its actor id (Pounce's "movement"), a spend by its economy id.
    const ref = resolveActorResourceRef(liveSystem, payment.resourceId)
      ?? resolveActorResourceRef(liveSystem, ACTOR_RESOURCE_TO_ECONOMY_ID[payment.resourceId]);
    if ( !ref ) return {...plan, ok: false, code: RESOURCE_RESOLUTION_CODES.RESOURCE_NOT_FOUND,
      reason: `Actor resource not found for ${payment.resourceId}`};
    const live = ref.counted ? (Number(ref.spent) || 0) : ref.current;
    const max = ref.counted ? Infinity : Number(valueAtPath(liveSystem, ref.path.replace(/\.value$/u, ".max")));
    moved.set(payment.path, {path: ref.path, counted: !!ref.counted, live, offset: live - (Number(payment.from) || 0),
      max: Number.isFinite(max) ? Math.max(max, live) : Infinity});
  }
  // A use given back only while there is room (Regain Use): another Action may have filled its pool meanwhile.
  const full = (plan.restores ?? []).find(restore => restore.refuseWhenFull && moved.has(restore.path)
    && (moved.get(restore.path).live >= moved.get(restore.path).max));
  if ( full ) return {...plan, ok: false, code: "RESOURCE_FULL", reason: `${full.resourceId} is full`};
  if ( [...moved].every(([path, entry]) => !entry.offset && (entry.path === path)) ) return plan;
  // Its own change on what is there now: movement spent never below 0, a pool never refilled above its maximum.
  const shifted = (entry, value) => (entry.counted ? Math.max(value + entry.offset, 0) : Math.min(value + entry.offset, entry.max));
  const updates = {};
  for ( const [path, value] of Object.entries(plan.updates ?? {}) ) {
    const entry = moved.get(path);
    if ( !entry ) {
      updates[path] = value;
      continue;
    }
    const to = shifted(entry, value);
    if ( to < 0 ) return {...plan, ok: false, code: RESOURCE_RESOLUTION_CODES.INSUFFICIENT_RESOURCE,
      reason: `${path} has ${entry.live} but needs ${entry.live - to}`};
    updates[entry.path] = to;
  }
  const payments = plan.payments.map(payment => {
    const entry = moved.get(payment.path);
    return entry ? {...payment, path: entry.path, from: payment.from + entry.offset, to: shifted(entry, payment.to)} : payment;
  });
  return {...plan, updates, payments, rebased: true};
}

/** The updates that take back what a committed payment plan changed, from its payer's resources as they are now. */
export function revertActorResourceMutationPlan(liveSystem, committed) {
  const updates = {};
  for ( const [path, to] of Object.entries(committed?.updates ?? {}) ) {
    const payment = (committed.payments ?? []).find(entry => entry.path === path);
    if ( !payment ) continue;
    const live = Number(valueAtPath(liveSystem, path));
    updates[path] = Math.max((Number.isFinite(live) ? live : to) - (to - payment.from), 0);
  }
  return updates;
}

/** What `system.<path>` holds in an Actor system snapshot. */
function valueAtPath(system, path) {
  return String(path).replace(/^system\./u, "").split(".").reduce((node, key) => node?.[key], system);
}

export async function commitActorResourceMutationPlan(actor, mutationPlan, {persistencePort=null}={}) {
  if ( !mutationPlan?.ok ) return false;
  if ( !Object.keys(mutationPlan.updates ?? {}).length ) return true;
  const persistence = persistencePort ?? createFoundryV14ActorPersistenceAdapter();
  const result = await persistence.updateActor({
    actor,
    actorRef: actor?.uuid ?? (actor?.id ? `actor:${actor.id}` : null),
    updates: mutationPlan.updates,
    metadata: {
      resolver: "ResourceResolver",
      mutationPlan
    }
  });
  return result !== false && result?.ok !== false;
}

/* -------------------------------------------- */

function selectPaymentOption(options, {selectedPaymentOptionId=null, selectedPaymentPlan=null}={}) {
  if ( selectedPaymentPlan ) return findMatchingPaymentOption(options, selectedPaymentPlan);
  if ( selectedPaymentOptionId == null ) return selectDefaultPaymentOption(options);
  return options.find(option => option.id === selectedPaymentOptionId) ?? null;
}

function findMatchingPaymentOption(options, selectedPaymentPlan) {
  return options.find(option => paymentPlansMatch(option, selectedPaymentPlan)) ?? null;
}

function paymentPlansMatch(left, right) {
  return JSON.stringify(paymentResourcesSignature(left?.resources ?? []))
    === JSON.stringify(paymentResourcesSignature(right?.resources ?? []));
}

function paymentResourcesSignature(resources) {
  return resources.map(resource => ({
    resourceId: resource.resourceId,
    capability: resource.capability,
    amount: resource.amount,
    unit: resource.unit ?? null,
    mode: resource.mode ?? null,
    alternativeFor: resource.alternativeFor ?? null,
    policy: resource.policy ?? null
  })).sort((a, b) => `${a.resourceId}:${a.capability}`.localeCompare(`${b.resourceId}:${b.capability}`));
}

function resolveActorResourceRef(actorSystem, economyResourceId) {
  const actorResourceId = ECONOMY_ID_TO_ACTOR_RESOURCE[economyResourceId] ?? null;
  if ( actorResourceId ) {
    const resource = actorSystem?.resources?.[actorResourceId];
    if ( !resource ) return null;
    const counted = Number.isFinite(resource.spent);
    return {
      resourceId: economyResourceId,
      actorResourceId,
      path: `system.resources.${actorResourceId}.${counted ? "spent" : "value"}`,
      current: Number(resource.value ?? 0) || 0,
      ...(counted ? {counted, spent: resource.spent} : {})
    };
  }

  const index = (actorSystem?.pools ?? []).findIndex(pool => pool.id === economyResourceId);
  if ( index < 0 ) return null;
  const pool = actorSystem.pools[index];
  return {
    resourceId: economyResourceId,
    actorResourceId: economyResourceId,
    path: `system.pools.${index}.value`,
    current: Number(pool.value ?? 0) || 0
  };
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
