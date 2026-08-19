/**
 * Pure action-economy primitives for Wild Path.
 *
 * The action economy is modeled as an extensible collection of spendable resources rather than
 * fixed Actor fields like "one action, one bonus action". Resources advertise which activation
 * requirements they can pay for, predicates decide when restricted resources are eligible, and
 * payment discovery is separated from payment commit so future resolution transactions can own
 * mutation timing.
 */

export const ECONOMY_UNITS = Object.freeze({
  USES: "uses",
  POINTS: "points",
  MOVEMENT: "movement"
});

export const ECONOMY_CAPABILITIES = Object.freeze({
  ACTION: "action",
  BONUS_ACTION: "bonus-action",
  REACTION: "reaction",
  MOVEMENT: "movement",
  LEGENDARY_ACTION: "legendary-action",
  LAIR_ACTION: "lair-action"
});

export const ECONOMY_REFRESH = Object.freeze({
  TURN_START: "turnStart",
  ROUND_START: "roundStart",
  COMBAT_START: "combatStart",
  SHORT_REST: "shortRest",
  LONG_REST: "longRest",
  MANUAL: "manual",
  NONE: "none"
});

export const ECONOMY_AVAILABILITY = Object.freeze({
  AVAILABLE: "AVAILABLE",
  NO_ELIGIBLE_RESOURCE: "NO_ELIGIBLE_RESOURCE",
  INSUFFICIENT_RESOURCE: "INSUFFICIENT_RESOURCE",
  RESOURCE_RESTRICTION_FAILED: "RESOURCE_RESTRICTION_FAILED"
});

/* -------------------------------------------- */

export const BUILTIN_ECONOMY_RESOURCE_DEFINITIONS = Object.freeze({
  "economy.action": Object.freeze({
    id: "economy.action",
    category: ECONOMY_CAPABILITIES.ACTION,
    unit: ECONOMY_UNITS.USES,
    paymentCapabilities: [ECONOMY_CAPABILITIES.ACTION],
    refreshPolicies: [ECONOMY_REFRESH.TURN_START],
    priority: 10,
    source: {type: "base", slug: "action"}
  }),
  "economy.bonus-action": Object.freeze({
    id: "economy.bonus-action",
    category: ECONOMY_CAPABILITIES.BONUS_ACTION,
    unit: ECONOMY_UNITS.USES,
    paymentCapabilities: [ECONOMY_CAPABILITIES.BONUS_ACTION],
    refreshPolicies: [ECONOMY_REFRESH.TURN_START],
    priority: 10,
    source: {type: "base", slug: "bonus-action"}
  }),
  "economy.reaction": Object.freeze({
    id: "economy.reaction",
    category: ECONOMY_CAPABILITIES.REACTION,
    unit: ECONOMY_UNITS.USES,
    paymentCapabilities: [ECONOMY_CAPABILITIES.REACTION],
    refreshPolicies: [ECONOMY_REFRESH.TURN_START],
    priority: 10,
    source: {type: "base", slug: "reaction"}
  }),
  "economy.movement": Object.freeze({
    id: "economy.movement",
    category: ECONOMY_CAPABILITIES.MOVEMENT,
    unit: ECONOMY_UNITS.MOVEMENT,
    paymentCapabilities: [ECONOMY_CAPABILITIES.MOVEMENT],
    refreshPolicies: [ECONOMY_REFRESH.TURN_START],
    priority: 10,
    source: {type: "base", slug: "movement"}
  }),
  "economy.legendary-action": Object.freeze({
    id: "economy.legendary-action",
    category: ECONOMY_CAPABILITIES.LEGENDARY_ACTION,
    unit: ECONOMY_UNITS.POINTS,
    paymentCapabilities: [ECONOMY_CAPABILITIES.LEGENDARY_ACTION],
    refreshPolicies: [ECONOMY_REFRESH.TURN_START],
    priority: 10,
    source: {type: "base", slug: "legendary-action"}
  }),
  "economy.lair-action": Object.freeze({
    id: "economy.lair-action",
    category: ECONOMY_CAPABILITIES.LAIR_ACTION,
    unit: ECONOMY_UNITS.USES,
    paymentCapabilities: [ECONOMY_CAPABILITIES.LAIR_ACTION],
    refreshPolicies: [ECONOMY_REFRESH.ROUND_START],
    priority: 10,
    source: {type: "base", slug: "lair-action"}
  })
});

export const ACTOR_RESOURCE_TO_ECONOMY_ID = Object.freeze({
  action: "economy.action",
  bonus: "economy.bonus-action",
  reaction: "economy.reaction",
  movement: "economy.movement"
});

/* -------------------------------------------- */

/**
 * Build a normalized, immutable-shape action-economy resource state from a definition plus
 * current state.
 * @param {object} data
 * @returns {object}
 */
export function createEconomyResource(data) {
  const maximum = Math.max(Number(data.maximum ?? data.max ?? data.current ?? 0) || 0, 0);
  const current = clamp(Number(data.current ?? data.value ?? maximum) || 0, 0, maximum);
  return {
    id: String(data.id),
    category: data.category ?? data.id,
    current,
    maximum,
    unit: data.unit ?? ECONOMY_UNITS.USES,
    paymentCapabilities: [...(data.paymentCapabilities ?? [data.category ?? data.id])],
    predicate: data.predicate ?? null,
    refreshPolicies: normalizeRefreshPolicies(data.refreshPolicies ?? []),
    source: data.source ? clonePlain(data.source) : null,
    priority: Number(data.priority ?? 100),
    metadata: data.metadata ? clonePlain(data.metadata) : {}
  };
}

/* -------------------------------------------- */

/**
 * Create one built-in economy resource, optionally overriding its default current/maximum.
 * @param {string} id
 * @param {object} [state]
 * @returns {object}
 */
export function createBuiltinEconomyResource(id, state={}) {
  const definition = BUILTIN_ECONOMY_RESOURCE_DEFINITIONS[id];
  if ( !definition ) throw new Error(`Unknown built-in economy resource: ${id}`);
  return createEconomyResource({...definition, ...state});
}

/* -------------------------------------------- */

/**
 * Adapt the current Actor system resource shape into generic economy resources. This is a
 * compatibility bridge: it lets existing persisted Actor data feed the new payment resolver
 * without requiring a schema migration before the resolver layer exists.
 * @param {object} actorSystem
 * @returns {object[]}
 */
export function economyResourcesFromActorResources(actorSystem) {
  const resources = [];
  for ( const [actorResourceId, economyId] of Object.entries(ACTOR_RESOURCE_TO_ECONOMY_ID) ) {
    const pool = actorSystem?.resources?.[actorResourceId];
    if ( !pool ) continue;
    resources.push(createBuiltinEconomyResource(economyId, {
      current: pool.value,
      maximum: pool.max,
      source: {type: "actor", slug: actorResourceId}
    }));
  }

  for ( const pool of actorSystem?.pools ?? [] ) {
    resources.push(createEconomyResource({
      id: pool.id,
      category: pool.id,
      current: pool.value,
      maximum: pool.max,
      unit: ECONOMY_UNITS.POINTS,
      paymentCapabilities: [pool.id],
      refreshPolicies: [mapRecoveryToRefresh(pool.recovery)],
      source: {type: "actorPool", slug: pool.id},
      metadata: {label: pool.label}
    }));
  }
  return resources;
}

/* -------------------------------------------- */

/**
 * Normalize an activation cost into a shape the payment resolver understands.
 * @param {object|object[]} cost
 * @returns {{allOf?: object[], anyOf?: object[][]}}
 */
export function normalizeActivationCost(cost) {
  if ( Array.isArray(cost) ) return {allOf: normalizeRequirements(cost)};
  if ( cost?.anyOf ) return {anyOf: cost.anyOf.map(branch => {
    const requirements = Array.isArray(branch) ? branch : (branch.allOf ?? [branch]);
    return normalizeRequirements(requirements);
  })};
  if ( cost?.allOf ) return {allOf: normalizeRequirements(cost.allOf)};
  if ( cost?.requirements ) return {allOf: normalizeRequirements(cost.requirements)};
  return {allOf: normalizeRequirements([cost])};
}

/* -------------------------------------------- */

/**
 * Discover payment options for an activation cost without mutating resources.
 * @param {object} options
 * @param {object|object[]} options.cost
 * @param {object[]} options.resources
 * @param {object} [options.action]
 * @param {object} [options.policies]
 * @returns {{status: string, code: string, options: object[], failures: object[]}}
 */
export function resolvePaymentOptions({cost, resources, action={}, policies={}}) {
  const normalized = normalizeActivationCost(cost);
  const branches = normalized.anyOf ?? [normalized.allOf ?? []];
  const branchResults = branches.map(requirements => resolveAllOf(requirements, resources, action, policies));
  const options = branchResults.flatMap(result => result.options);
  const failures = branchResults.flatMap(result => result.failures);
  options.sort(comparePaymentOptions);

  return {
    status: options.length ? "available" : "unavailable",
    code: options.length ? ECONOMY_AVAILABILITY.AVAILABLE : summarizeFailureCode(failures),
    options,
    failures
  };
}

/* -------------------------------------------- */

/**
 * Select a deterministic default payment option from a discovered option list.
 * @param {object[]} options
 * @returns {object|null}
 */
export function selectDefaultPaymentOption(options) {
  return [...options].sort(comparePaymentOptions)[0] ?? null;
}

/* -------------------------------------------- */

/**
 * Commit a payment plan by returning a new resource-state array with selected costs consumed.
 * The input resource objects are not mutated.
 * @param {object[]} resources
 * @param {object} paymentPlan
 * @returns {{ok: boolean, code: string, resources: object[], committed: object[]}}
 */
export function commitPaymentPlan(resources, paymentPlan) {
  const next = resources.map(resource => ({...resource, metadata: clonePlain(resource.metadata ?? {})}));
  const byId = new Map(next.map(resource => [resource.id, resource]));

  for ( const payment of paymentPlan?.resources ?? [] ) {
    const resource = byId.get(payment.resourceId);
    if ( !resource ) {
      return {ok: false, code: ECONOMY_AVAILABILITY.NO_ELIGIBLE_RESOURCE, resources: next, committed: []};
    }
    if ( resource.current < payment.amount ) {
      return {ok: false, code: ECONOMY_AVAILABILITY.INSUFFICIENT_RESOURCE, resources: next, committed: []};
    }
    resource.current -= payment.amount;
  }

  return {
    ok: true,
    code: ECONOMY_AVAILABILITY.AVAILABLE,
    resources: next,
    committed: paymentPlan?.resources?.map(payment => ({...payment})) ?? []
  };
}

/* -------------------------------------------- */

/**
 * Refresh all resources whose refresh policy matches an event.
 * @param {object[]} resources
 * @param {string} event
 * @returns {object[]}
 */
export function refreshResources(resources, event) {
  return resources.map(resource => {
    if ( !hasRefreshPolicy(resource, event) ) return {...resource, metadata: clonePlain(resource.metadata ?? {})};
    return {...resource, current: resource.maximum, metadata: clonePlain(resource.metadata ?? {})};
  });
}

/* -------------------------------------------- */

function resolveAllOf(requirements, resources, action, policies) {
  const candidateGroups = requirements.map(requirement => {
    const direct = findCandidates(requirement, resources, action, "direct");
    if ( direct.available.length ) return {requirement, candidates: direct.available, failures: direct.failures};

    const alternative = maybeFindAlternativeCandidates(requirement, resources, action, policies);
    if ( alternative.available.length ) return {
      requirement,
      candidates: alternative.available,
      failures: [...direct.failures, ...alternative.failures]
    };

    return {requirement, candidates: [], failures: [...direct.failures, ...alternative.failures]};
  });

  if ( candidateGroups.some(group => !group.candidates.length) ) {
    return {options: [], failures: candidateGroups.flatMap(group => group.failures)};
  }

  const options = buildPaymentCombinations(candidateGroups, resources);
  return {options, failures: candidateGroups.flatMap(group => group.failures)};
}

function findCandidates(requirement, resources, action, mode) {
  const available = [];
  const failures = [];

  for ( const resource of resources ) {
    const evaluation = evaluateResourceForRequirement(resource, requirement, action);
    if ( evaluation.code === ECONOMY_AVAILABILITY.AVAILABLE ) {
      available.push({
        resourceId: resource.id,
        amount: requirement.amount,
        capability: requirement.capability,
        unit: requirement.unit ?? resource.unit,
        mode,
        priority: resource.priority,
        source: resource.source ? clonePlain(resource.source) : null,
        trace: evaluation.trace
      });
    }
    else failures.push(evaluation);
  }

  return {available, failures};
}

function maybeFindAlternativeCandidates(requirement, resources, action, policies) {
  if ( requirement.capability !== ECONOMY_CAPABILITIES.BONUS_ACTION ) return {available: [], failures: []};
  if ( !policies.allowActionForSpentBonusAction ) return {available: [], failures: []};

  const alternativeRequirement = {
    ...requirement,
    capability: ECONOMY_CAPABILITIES.ACTION,
    alternativeFor: requirement.capability
  };
  const result = findCandidates(alternativeRequirement, resources, action, "alternative");
  return {
    available: result.available.map(candidate => ({
      ...candidate,
      alternativeFor: requirement.capability,
      policy: "action-for-spent-bonus-action"
    })),
    failures: result.failures
  };
}

function evaluateResourceForRequirement(resource, requirement, action) {
  if ( !resource.paymentCapabilities.includes(requirement.capability) ) {
    return failure(resource, requirement, ECONOMY_AVAILABILITY.NO_ELIGIBLE_RESOURCE);
  }
  if ( requirement.unit && (resource.unit !== requirement.unit) ) {
    return failure(resource, requirement, ECONOMY_AVAILABILITY.NO_ELIGIBLE_RESOURCE);
  }
  if ( resource.current < requirement.amount ) {
    return failure(resource, requirement, ECONOMY_AVAILABILITY.INSUFFICIENT_RESOURCE);
  }

  const predicate = evaluatePredicate(resource.predicate, {resource, requirement, action});
  if ( !predicate.ok ) {
    return failure(resource, requirement, ECONOMY_AVAILABILITY.RESOURCE_RESTRICTION_FAILED, predicate.reason);
  }

  return {
    code: ECONOMY_AVAILABILITY.AVAILABLE,
    resourceId: resource.id,
    requirement,
    trace: `${resource.id} can pay ${requirement.amount} ${requirement.capability}`
  };
}

function evaluatePredicate(predicate, context) {
  if ( !predicate ) return {ok: true};
  if ( typeof predicate === "function" ) return predicate(context) ? {ok: true} : {
    ok: false,
    reason: "function predicate returned false"
  };

  const tags = new Set(context.action?.tags ?? []);
  if ( predicate.tagsAny?.length && !predicate.tagsAny.some(tag => tags.has(tag)) ) {
    return {ok: false, reason: `requires one of tags: ${predicate.tagsAny.join(", ")}`};
  }
  if ( predicate.tagsAll?.length && !predicate.tagsAll.every(tag => tags.has(tag)) ) {
    return {ok: false, reason: `requires all tags: ${predicate.tagsAll.join(", ")}`};
  }
  if ( predicate.notTagsAny?.length && predicate.notTagsAny.some(tag => tags.has(tag)) ) {
    return {ok: false, reason: `forbids one of tags: ${predicate.notTagsAny.join(", ")}`};
  }

  return {ok: true};
}

function buildPaymentCombinations(candidateGroups, resources) {
  const currentById = new Map(resources.map(resource => [resource.id, resource.current]));
  let combinations = [{resources: [], cost: 0, hasAlternative: false, priority: 0}];

  for ( const group of candidateGroups ) {
    const next = [];
    for ( const combination of combinations ) {
      for ( const candidate of group.candidates ) {
        const used = totalUsedByResource(combination.resources, candidate.resourceId) + candidate.amount;
        if ( used > (currentById.get(candidate.resourceId) ?? 0) ) continue;
        next.push({
          resources: [...combination.resources, withoutInternalFields(candidate)],
          cost: combination.cost + candidate.amount,
          hasAlternative: combination.hasAlternative || candidate.mode === "alternative",
          priority: combination.priority + candidate.priority
        });
      }
    }
    combinations = next;
  }

  return combinations.map((combination, index) => ({
    id: `payment-${index + 1}`,
    code: ECONOMY_AVAILABILITY.AVAILABLE,
    mode: combination.hasAlternative ? "alternative" : "direct",
    priority: combination.priority,
    resources: combination.resources,
    selection: "deterministic-priority",
    trace: combination.resources.map(payment => ({
      resourceId: payment.resourceId,
      capability: payment.capability,
      amount: payment.amount,
      mode: payment.mode,
      policy: payment.policy ?? null
    }))
  })).sort(comparePaymentOptions);
}

function normalizeRequirement(requirement) {
  return {
    capability: requirement?.capability ?? requirement?.type,
    amount: Math.max(Number(requirement?.amount ?? 1) || 0, 0),
    unit: requirement?.unit ?? null
  };
}

function normalizeRequirements(requirements) {
  return requirements.map(normalizeRequirement).filter(requirement => requirement.capability && requirement.amount > 0);
}

function normalizeRefreshPolicies(policies) {
  return policies.map(policy => typeof policy === "string" ? {event: policy} : {...policy});
}

function hasRefreshPolicy(resource, event) {
  return (resource.refreshPolicies ?? []).some(policy => policy.event === event);
}

function mapRecoveryToRefresh(recovery) {
  switch ( recovery ) {
    case "turn": return ECONOMY_REFRESH.TURN_START;
    case "shortRest": return ECONOMY_REFRESH.SHORT_REST;
    case "longRest": return ECONOMY_REFRESH.LONG_REST;
    default: return ECONOMY_REFRESH.NONE;
  }
}

function summarizeFailureCode(failures) {
  if ( failures.some(failure => failure.code === ECONOMY_AVAILABILITY.RESOURCE_RESTRICTION_FAILED) ) {
    return ECONOMY_AVAILABILITY.RESOURCE_RESTRICTION_FAILED;
  }
  if ( failures.some(failure => failure.code === ECONOMY_AVAILABILITY.INSUFFICIENT_RESOURCE) ) {
    return ECONOMY_AVAILABILITY.INSUFFICIENT_RESOURCE;
  }
  return ECONOMY_AVAILABILITY.NO_ELIGIBLE_RESOURCE;
}

function comparePaymentOptions(a, b) {
  const alternative = Number(a.mode === "alternative") - Number(b.mode === "alternative");
  if ( alternative ) return alternative;
  const priority = (a.priority ?? optionPriority(a)) - (b.priority ?? optionPriority(b));
  if ( priority ) return priority;
  return optionResourceIds(a).localeCompare(optionResourceIds(b));
}

function optionPriority(option) {
  return (option.resources ?? []).reduce((sum, payment) => sum + (payment.priority ?? 100), 0);
}

function optionResourceIds(option) {
  return (option.resources ?? []).map(payment => payment.resourceId).join("|");
}

function totalUsedByResource(payments, resourceId) {
  return payments.filter(payment => payment.resourceId === resourceId)
    .reduce((sum, payment) => sum + payment.amount, 0);
}

function failure(resource, requirement, code, reason=null) {
  return {code, resourceId: resource.id, requirement, reason};
}

function withoutInternalFields(candidate) {
  const {priority, trace, ...payment} = candidate;
  return payment;
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
