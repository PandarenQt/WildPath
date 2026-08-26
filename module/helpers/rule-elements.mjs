import {createEconomyResource} from "./action-economy.mjs";
import {createTriggerDefinition} from "./automation-events.mjs";
import {createMovementCapability} from "./movement.mjs";
import {evaluatePredicate} from "./predicates.mjs";
import {evaluateValueExpression} from "./value-expressions.mjs";

export const RULE_ELEMENT_TYPES = Object.freeze({
  MODIFIER: "Modifier",
  GRANT_RESOURCE: "GrantResource",
  GRANT_ACTION_ECONOMY_RESOURCE: "GrantActionEconomyResource",
  GRANT_RESISTANCE: "GrantResistance",
  GRANT_IMMUNITY: "GrantImmunity",
  GRANT_MOVEMENT: "GrantMovement",
  TRIGGER: "Trigger"
});

export const RULE_ELEMENT_CODES = Object.freeze({
  OK: "OK",
  DISABLED: "DISABLED",
  SUPPRESSED: "SUPPRESSED",
  PREDICATE_FAILED: "PREDICATE_FAILED",
  UNKNOWN_TYPE: "UNKNOWN_RULE_ELEMENT_TYPE",
  INVALID: "INVALID_RULE_ELEMENT",
  INVALID_VALUE: "INVALID_RULE_ELEMENT_VALUE"
});

export const RULE_ELEMENT_TRACE_STATUS = Object.freeze({
  CONTRIBUTED: "contributed",
  DISABLED: "disabled",
  SUPPRESSED: "suppressed",
  PREDICATE_FAILED: "predicate-failed",
  FAILED: "failed"
});

const TYPE_ALIASES = Object.freeze({
  modifier: RULE_ELEMENT_TYPES.MODIFIER,
  grantresource: RULE_ELEMENT_TYPES.GRANT_RESOURCE,
  resource: RULE_ELEMENT_TYPES.GRANT_RESOURCE,
  grantactioneconomyresource: RULE_ELEMENT_TYPES.GRANT_ACTION_ECONOMY_RESOURCE,
  actioneconomyresource: RULE_ELEMENT_TYPES.GRANT_ACTION_ECONOMY_RESOURCE,
  economyresource: RULE_ELEMENT_TYPES.GRANT_ACTION_ECONOMY_RESOURCE,
  grantresistance: RULE_ELEMENT_TYPES.GRANT_RESISTANCE,
  resistance: RULE_ELEMENT_TYPES.GRANT_RESISTANCE,
  grantimmunity: RULE_ELEMENT_TYPES.GRANT_IMMUNITY,
  immunity: RULE_ELEMENT_TYPES.GRANT_IMMUNITY,
  grantmovement: RULE_ELEMENT_TYPES.GRANT_MOVEMENT,
  movement: RULE_ELEMENT_TYPES.GRANT_MOVEMENT,
  trigger: RULE_ELEMENT_TYPES.TRIGGER
});

/* -------------------------------------------- */

export class RuleElementRegistry {
  constructor(entries=[]) {
    this.handlers = new Map();
    for ( const [type, handler] of entries ) this.register(type, handler);
  }

  register(type, handler) {
    const normalized = normalizeRuleElementType(type);
    if ( !normalized ) throw new Error("RuleElementRegistry requires a rule element type.");
    if ( typeof handler !== "function" ) throw new Error(`RuleElement handler for ${normalized} must be a function.`);
    this.handlers.set(normalized, handler);
    return this;
  }

  get(type) {
    return this.handlers.get(normalizeRuleElementType(type));
  }

  has(type) {
    return this.handlers.has(normalizeRuleElementType(type));
  }
}

/* -------------------------------------------- */

export function createDefaultRuleElementRegistry() {
  return new RuleElementRegistry([
    [RULE_ELEMENT_TYPES.MODIFIER, modifierRuleElement],
    [RULE_ELEMENT_TYPES.GRANT_RESOURCE, grantResourceRuleElement],
    [RULE_ELEMENT_TYPES.GRANT_ACTION_ECONOMY_RESOURCE, grantActionEconomyResourceRuleElement],
    [RULE_ELEMENT_TYPES.GRANT_RESISTANCE, grantResistanceRuleElement],
    [RULE_ELEMENT_TYPES.GRANT_IMMUNITY, grantImmunityRuleElement],
    [RULE_ELEMENT_TYPES.GRANT_MOVEMENT, grantMovementRuleElement],
    [RULE_ELEMENT_TYPES.TRIGGER, triggerRuleElement]
  ]);
}

export const DEFAULT_RULE_ELEMENT_REGISTRY = createDefaultRuleElementRegistry();

/* -------------------------------------------- */

export function normalizeRuleElementType(type) {
  if ( !type ) return null;
  return TYPE_ALIASES[String(type).replace(/[^a-z0-9]/gi, "").toLowerCase()] ?? String(type);
}

/* -------------------------------------------- */

export function normalizeRuleElementDefinition(data={}, {source=null, index=0}={}) {
  const raw = isPlainObject(data) ? data : {};
  const payload = {
    ...clonePlain(raw.data ?? {}),
    ...directPayload(raw)
  };
  const type = normalizeRuleElementType(raw.type ?? raw.key ?? raw.rule ?? payload.type ?? payload.key);
  const id = raw.id ?? raw.slug ?? payload.id ?? (type ? `${type}:${index}` : `RuleElement:${index}`);
  return {
    id: String(id),
    type,
    key: raw.key ?? raw.type ?? null,
    label: raw.label ?? raw.name ?? payload.label ?? null,
    predicate: raw.predicate ?? payload.predicate ?? null,
    priority: finiteNumber(raw.priority ?? raw.order ?? payload.priority) ?? 100,
    enabled: raw.enabled !== false,
    suppressed: raw.suppressed === true,
    source: clonePlain(raw.source ?? source),
    metadata: clonePlain(raw.metadata ?? payload.metadata ?? {}) ?? {},
    data: payload
  };
}

/* -------------------------------------------- */

export function evaluateRuleElement(definition, context={}, {
  registry=DEFAULT_RULE_ELEMENT_REGISTRY,
  source=null,
  index=0
}={}) {
  const ruleElement = normalizeRuleElementDefinition(definition, {source, index});
  if ( !ruleElement.type ) return ruleElementFailure(ruleElement, RULE_ELEMENT_CODES.INVALID, "RuleElement requires a type.");
  if ( !ruleElement.enabled ) return ruleElementSkipped(ruleElement, RULE_ELEMENT_CODES.DISABLED, RULE_ELEMENT_TRACE_STATUS.DISABLED);
  if ( ruleElement.suppressed ) return ruleElementSkipped(ruleElement, RULE_ELEMENT_CODES.SUPPRESSED, RULE_ELEMENT_TRACE_STATUS.SUPPRESSED);

  const predicate = evaluatePredicate(ruleElement.predicate, {ruleElement, source: ruleElement.source, ...context});
  if ( !predicate.ok ) {
    return ruleElementSkipped(
      ruleElement,
      RULE_ELEMENT_CODES.PREDICATE_FAILED,
      RULE_ELEMENT_TRACE_STATUS.PREDICATE_FAILED,
      predicate.reason,
      predicate
    );
  }

  const handler = registry.get(ruleElement.type);
  if ( !handler ) {
    return ruleElementFailure(ruleElement, RULE_ELEMENT_CODES.UNKNOWN_TYPE, `Unknown RuleElement type: ${ruleElement.type}`, predicate);
  }

  const result = handler(ruleElement, context);
  if ( !result.ok ) {
    return ruleElementFailure(ruleElement, result.code ?? RULE_ELEMENT_CODES.INVALID, result.reason, predicate, result);
  }

  const contributions = normalizeContributions(result.contributions);
  return {
    ok: true,
    code: RULE_ELEMENT_CODES.OK,
    active: true,
    ruleElement,
    contributions,
    trace: createTrace(ruleElement, RULE_ELEMENT_TRACE_STATUS.CONTRIBUTED, predicate, null, contributions)
  };
}

/* -------------------------------------------- */

export function collectRuleElementContributions({
  ruleElements=[],
  context={},
  source=null,
  registry=DEFAULT_RULE_ELEMENT_REGISTRY
}={}) {
  const normalized = collectionContents(ruleElements)
    .map((definition, index) => normalizeRuleElementDefinition(definition, {source, index}))
    .sort(compareRuleElements);

  const contributions = emptyContributions();
  const traces = [];
  const failures = [];

  for ( const ruleElement of normalized ) {
    const result = evaluateRuleElement(ruleElement, {ruleElements: normalized, ...context}, {registry, source});
    traces.push(result.trace);
    if ( !result.ok ) {
      failures.push(result);
      continue;
    }
    mergeContributions(contributions, result.contributions);
  }

  sortContributions(contributions);
  return {
    ok: failures.length === 0,
    code: failures.length ? failures[0].code : RULE_ELEMENT_CODES.OK,
    contributions,
    traces,
    failures
  };
}

/* -------------------------------------------- */

export function modifiersFromRuleElements({ruleElements=[], domain=null, context={}, source=null}={}) {
  const result = collectRuleElementContributions({
    ruleElements,
    context: {domain, ...context},
    source
  });
  return {
    ...result,
    modifiers: result.contributions.modifiers.filter(modifier => modifierMatchesDomain(modifier, domain))
  };
}

/* -------------------------------------------- */

function modifierRuleElement(ruleElement) {
  const data = ruleElement.data;
  const domains = normalizeStrings(data.domains ?? data.domain ?? data.selector);
  const selector = data.selector ?? domains[0] ?? null;
  return success({
    modifiers: [{
      id: data.modifierId ?? data.id ?? ruleElement.id,
      slug: data.slug ?? data.modifierId ?? data.id ?? ruleElement.id,
      label: data.label ?? ruleElement.label ?? ruleElement.id,
      selector,
      domains,
      type: data.modifierType ?? data.type ?? "untyped",
      value: data.value,
      valueExpression: clonePlain(data.valueExpression ?? data.expression),
      predicate: clonePlain(data.modifierPredicate ?? data.appliesIf ?? ruleElement.predicate),
      priority: finiteNumber(data.priority ?? ruleElement.priority) ?? 100,
      source: ruleElementSource(ruleElement),
      metadata: contributionMetadata(ruleElement, data.metadata),
      enabled: data.enabled !== false,
      suppressed: data.suppressed === true
    }]
  });
}

function grantResourceRuleElement(ruleElement, context) {
  const data = ruleElement.data;
  const id = data.resourceId ?? data.resource ?? data.id ?? ruleElement.id;
  const maximum = evaluateNumeric(data.maximum ?? data.max ?? data.value ?? 0, context);
  if ( !maximum.ok ) return maximum;
  const current = data.current == null ? maximum : evaluateNumeric(data.current, context);
  if ( !current.ok ) return current;

  return success({
    resources: [{
      id: String(id),
      label: data.label ?? String(id),
      current: Math.max(current.value, 0),
      maximum: Math.max(maximum.value, 0),
      recovery: data.recovery ?? "none",
      source: ruleElementSource(ruleElement),
      metadata: contributionMetadata(ruleElement, data.metadata)
    }]
  });
}

function grantActionEconomyResourceRuleElement(ruleElement, context) {
  const data = ruleElement.data;
  const id = data.resourceId ?? data.id ?? ruleElement.id;
  const category = data.category ?? data.capability ?? id;
  const paymentCapabilities = normalizeStrings(data.paymentCapabilities ?? data.capabilities ?? data.capability ?? data.category);
  const maximum = evaluateNumeric(data.maximum ?? data.max ?? data.value ?? data.amount ?? 1, context);
  if ( !maximum.ok ) return maximum;
  const current = data.current == null ? maximum : evaluateNumeric(data.current, context);
  if ( !current.ok ) return current;

  return success({
    economyResources: [createEconomyResource({
      id,
      category,
      current: current.value,
      maximum: maximum.value,
      unit: data.unit ?? "uses",
      paymentCapabilities: paymentCapabilities.length ? paymentCapabilities : [category],
      predicate: data.resourcePredicate ?? data.paymentPredicate ?? data.predicate ?? null,
      refreshPolicies: normalizeRefreshPolicies(data.refreshPolicies ?? data.refresh ?? []),
      source: ruleElementSource(ruleElement),
      priority: finiteNumber(data.priority ?? ruleElement.priority) ?? 100,
      metadata: contributionMetadata(ruleElement, data.metadata)
    })]
  });
}

function grantResistanceRuleElement(ruleElement) {
  const data = ruleElement.data;
  return success({
    damageAdjustments: {
      resistances: [{
        id: data.adjustmentId ?? data.id ?? ruleElement.id,
        damageTypes: normalizeStrings(data.damageTypes ?? data.types ?? data.damageType),
        tags: normalizeStrings(data.tags),
        multiplier: finiteNumber(data.multiplier ?? data.amountMultiplier) ?? 0.5,
        metadata: contributionMetadata(ruleElement, data.metadata)
      }]
    }
  });
}

function grantImmunityRuleElement(ruleElement) {
  const data = ruleElement.data;
  return success({
    damageAdjustments: {
      immunities: [{
        id: data.adjustmentId ?? data.id ?? ruleElement.id,
        damageTypes: normalizeStrings(data.damageTypes ?? data.types ?? data.damageType),
        tags: normalizeStrings(data.tags),
        metadata: contributionMetadata(ruleElement, data.metadata)
      }]
    }
  });
}

function grantMovementRuleElement(ruleElement, context) {
  const data = ruleElement.data;
  const distance = evaluateNumeric(data.distance ?? data.value ?? 0, context);
  if ( !distance.ok ) return distance;
  return success({
    movement: [{
      id: data.movementId ?? data.id ?? ruleElement.id,
      capability: createMovementCapability({
        mode: data.mode ?? data.movementMode ?? "walk",
        distance: distance.value,
        unit: data.unit ?? "ft"
      }),
      source: ruleElementSource(ruleElement),
      metadata: contributionMetadata(ruleElement, data.metadata)
    }]
  });
}

function triggerRuleElement(ruleElement) {
  const data = ruleElement.data;
  return success({
    triggers: [createTriggerDefinition({
      id: data.triggerId ?? data.id ?? ruleElement.id,
      kind: data.kind ?? data.triggerKind,
      event: data.event ?? data.eventType ?? null,
      match: data.match ?? {},
      predicate: data.triggerPredicate ?? data.eventPredicate ?? data.predicate ?? null,
      priority: finiteNumber(data.priority ?? ruleElement.priority) ?? 100,
      once: data.once === true,
      enabled: data.triggerEnabled ?? true,
      payload: data.payload ?? {},
      owner: data.owner ?? null,
      reaction: data.reaction ?? null,
      metadata: contributionMetadata(ruleElement, data.metadata)
    })]
  });
}

/* -------------------------------------------- */

function evaluateNumeric(expression, context) {
  const result = evaluateValueExpression(expression, context);
  if ( !result.ok ) {
    return {ok: false, code: RULE_ELEMENT_CODES.INVALID_VALUE, reason: result.reason, valueResult: result};
  }
  return result;
}

function success(contributions) {
  return {ok: true, code: RULE_ELEMENT_CODES.OK, contributions};
}

function ruleElementSkipped(ruleElement, code, status, reason=null, predicateResult=null) {
  const contributions = emptyContributions();
  return {
    ok: true,
    code,
    active: false,
    ruleElement,
    contributions,
    trace: createTrace(ruleElement, status, predicateResult, reason, contributions)
  };
}

function ruleElementFailure(ruleElement, code, reason=null, predicateResult=null, result=null) {
  const contributions = emptyContributions();
  return {
    ok: false,
    code,
    active: false,
    reason,
    ruleElement,
    contributions,
    result,
    trace: createTrace(ruleElement, RULE_ELEMENT_TRACE_STATUS.FAILED, predicateResult, reason, contributions)
  };
}

function emptyContributions() {
  return {
    modifiers: [],
    resources: [],
    economyResources: [],
    damageAdjustments: {
      immunities: [],
      resistances: [],
      vulnerabilities: [],
      reductions: [],
      absorptions: []
    },
    movement: [],
    triggers: []
  };
}

function normalizeContributions(contributions={}) {
  const normalized = emptyContributions();
  mergeContributions(normalized, contributions);
  return normalized;
}

function mergeContributions(target, source={}) {
  target.modifiers.push(...(source.modifiers ?? []));
  target.resources.push(...(source.resources ?? []));
  target.economyResources.push(...(source.economyResources ?? []));
  target.movement.push(...(source.movement ?? source.movements ?? []));
  target.triggers.push(...(source.triggers ?? []));

  const damage = source.damageAdjustments ?? {};
  for ( const key of Object.keys(target.damageAdjustments) ) {
    target.damageAdjustments[key].push(...(damage[key] ?? []));
  }
  return target;
}

function sortContributions(contributions) {
  for ( const key of ["modifiers", "resources", "economyResources", "movement", "triggers"] ) {
    contributions[key].sort(compareContributions);
  }
  for ( const entries of Object.values(contributions.damageAdjustments) ) {
    entries.sort(compareContributions);
  }
}

function createTrace(ruleElement, status, predicateResult=null, reason=null, contributions=emptyContributions()) {
  return {
    id: ruleElement.id,
    type: ruleElement.type,
    label: ruleElement.label,
    priority: ruleElement.priority,
    source: clonePlain(ruleElement.source),
    predicate: clonePlain(ruleElement.predicate),
    predicateResult: clonePlain(predicateResult),
    status,
    reason,
    contributionCounts: {
      modifiers: contributions.modifiers.length,
      resources: contributions.resources.length,
      economyResources: contributions.economyResources.length,
      damageAdjustments: Object.values(contributions.damageAdjustments).reduce((sum, entries) => sum + entries.length, 0),
      movement: contributions.movement.length,
      triggers: contributions.triggers.length
    },
    metadata: clonePlain(ruleElement.metadata) ?? {}
  };
}

function compareRuleElements(a, b) {
  const priority = (a.priority ?? 100) - (b.priority ?? 100);
  if ( priority ) return priority;
  return String(a.id).localeCompare(String(b.id));
}

function compareContributions(a, b) {
  const priority = (a.priority ?? a.metadata?.ruleElement?.priority ?? 100)
    - (b.priority ?? b.metadata?.ruleElement?.priority ?? 100);
  if ( priority ) return priority;
  return String(a.id ?? a.slug ?? a.triggerId ?? "").localeCompare(String(b.id ?? b.slug ?? b.triggerId ?? ""));
}

function ruleElementSource(ruleElement) {
  return {
    type: "ruleElement",
    ruleElementId: ruleElement.id,
    ruleElementType: ruleElement.type,
    parent: clonePlain(ruleElement.source)
  };
}

function contributionMetadata(ruleElement, metadata={}) {
  return {
    ...(clonePlain(metadata) ?? {}),
    ruleElement: {
      id: ruleElement.id,
      type: ruleElement.type,
      priority: ruleElement.priority,
      source: clonePlain(ruleElement.source)
    }
  };
}

function normalizeRefreshPolicies(policies) {
  return normalizeArray(policies).map(policy => typeof policy === "string" ? {event: policy} : clonePlain(policy));
}

function modifierMatchesDomain(modifier, domain) {
  if ( !domain ) return true;
  const domains = normalizeStrings(modifier.domains ?? modifier.domain ?? modifier.selector);
  return domains.includes(domain) || domains.includes("all");
}

function normalizeStrings(values) {
  return normalizeArray(values)
    .filter(value => value != null && value !== "")
    .map(String)
    .filter((value, index, array) => array.indexOf(value) === index);
}

function normalizeArray(value) {
  if ( value == null || value === false ) return [];
  if ( Array.isArray(value) ) return value;
  if ( value instanceof Set ) return [...value];
  return [value];
}

function collectionContents(collection) {
  if ( collection == null ) return [];
  if ( Array.isArray(collection) ) return collection;
  if ( collection instanceof Map ) return [...collection.values()];
  if ( typeof collection.values === "function" ) return [...collection.values()];
  if ( typeof collection === "object" ) return Object.values(collection);
  return [];
}

function directPayload(raw) {
  const ignored = new Set(["id", "slug", "type", "key", "rule", "label", "name", "predicate", "priority", "order", "enabled", "suppressed", "source", "metadata", "data"]);
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !ignored.has(key)));
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value) {
  if ( value == null || value === "" ) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
