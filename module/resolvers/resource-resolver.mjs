import {
  ACTOR_RESOURCE_TO_ECONOMY_ID,
  commitPaymentPlan,
  economyResourcesFromActorResources,
  resolvePaymentOptions,
  selectDefaultPaymentOption
} from "../helpers/action-economy.mjs";

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
    const value = clamp(entry.current - entry.amount, 0, entry.max);
    updates[entry.path] = value;
    plannedPayments.push({
      resourceId: entry.resourceId,
      actorResourceId: entry.actorResourceId,
      path: entry.path,
      from: entry.current,
      to: value,
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

export async function commitActorResourceMutationPlan(actor, mutationPlan) {
  if ( !mutationPlan?.ok ) return false;
  if ( !Object.keys(mutationPlan.updates ?? {}).length ) return true;
  await actor.update(mutationPlan.updates);
  return true;
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
    return {
      resourceId: economyResourceId,
      actorResourceId,
      path: `system.resources.${actorResourceId}.value`,
      current: Number(resource.value ?? 0) || 0,
      max: Number(resource.max ?? resource.value ?? 0) || 0
    };
  }

  const index = (actorSystem?.pools ?? []).findIndex(pool => pool.id === economyResourceId);
  if ( index < 0 ) return null;
  const pool = actorSystem.pools[index];
  return {
    resourceId: economyResourceId,
    actorResourceId: economyResourceId,
    path: `system.pools.${index}.value`,
    current: Number(pool.value ?? 0) || 0,
    max: Number(pool.max ?? pool.value ?? 0) || 0
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
