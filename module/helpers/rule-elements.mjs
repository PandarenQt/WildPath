import {createTriggerDefinition} from "./automation-events.mjs";
import {createMovementCapability} from "./movement.mjs";
import {PREDICATE_CODES, evaluatePredicate} from "./predicates.mjs";
import {evaluateValueExpression} from "./value-expressions.mjs";

export const RULE_ELEMENT_TYPES = Object.freeze({
  MODIFIER: "Modifier",
  GRANT_RESOURCE: "GrantResource",
  GRANT_RESISTANCE: "GrantResistance",
  GRANT_IMMUNITY: "GrantImmunity",
  GRANT_VULNERABILITY: "GrantVulnerability",
  CONDITION_IMMUNITY: "ConditionImmunity",
  AVOID_OPPORTUNITY_ATTACKS: "AvoidOpportunityAttacks",
  EXTRA_ATTACK: "ExtraAttack",
  ARMOR_CLASS: "ArmorClass",
  REVEAL: "Reveal",
  GRANT_MOVEMENT: "GrantMovement",
  ROLL_MODE: "RollMode",
  RESOURCE_CAP: "ResourceCap",
  ABILITY_SCORE: "AbilityScore",
  ROLL_OUTCOME: "RollOutcome",
  EXTRA_DAMAGE: "ExtraDamage",
  AURA: "Aura",
  TRIGGER: "Trigger"
});

export const RULE_ELEMENT_CODES = Object.freeze({
  OK: "OK",
  DISABLED: "DISABLED",
  SUPPRESSED: "SUPPRESSED",
  PREDICATE_FAILED: "PREDICATE_FAILED",
  UNKNOWN_TYPE: "UNKNOWN_RULE_ELEMENT_TYPE",
  DUPLICATE_TYPE: "DUPLICATE_RULE_ELEMENT_TYPE",
  INVALID: "INVALID_RULE_ELEMENT",
  INVALID_VALUE: "INVALID_RULE_ELEMENT_VALUE"
});

export const RULE_ELEMENT_SCHEMA_VERSION = 1;

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
  grantresistance: RULE_ELEMENT_TYPES.GRANT_RESISTANCE,
  resistance: RULE_ELEMENT_TYPES.GRANT_RESISTANCE,
  grantimmunity: RULE_ELEMENT_TYPES.GRANT_IMMUNITY,
  immunity: RULE_ELEMENT_TYPES.GRANT_IMMUNITY,
  grantvulnerability: RULE_ELEMENT_TYPES.GRANT_VULNERABILITY,
  vulnerability: RULE_ELEMENT_TYPES.GRANT_VULNERABILITY,
  conditionimmunity: RULE_ELEMENT_TYPES.CONDITION_IMMUNITY,
  avoidopportunityattacks: RULE_ELEMENT_TYPES.AVOID_OPPORTUNITY_ATTACKS,
  extraattack: RULE_ELEMENT_TYPES.EXTRA_ATTACK,
  armorclass: RULE_ELEMENT_TYPES.ARMOR_CLASS,
  reveal: RULE_ELEMENT_TYPES.REVEAL,
  grantmovement: RULE_ELEMENT_TYPES.GRANT_MOVEMENT,
  movement: RULE_ELEMENT_TYPES.GRANT_MOVEMENT,
  rollmode: RULE_ELEMENT_TYPES.ROLL_MODE,
  resourcecap: RULE_ELEMENT_TYPES.RESOURCE_CAP,
  abilityscore: RULE_ELEMENT_TYPES.ABILITY_SCORE,
  rolloutcome: RULE_ELEMENT_TYPES.ROLL_OUTCOME,
  extradamage: RULE_ELEMENT_TYPES.EXTRA_DAMAGE,
  aura: RULE_ELEMENT_TYPES.AURA,
  trigger: RULE_ELEMENT_TYPES.TRIGGER
});

/* -------------------------------------------- */

export class RuleElementRegistry {
  constructor(entries=[]) {
    this.handlers = new Map();
    for ( const [type, handler] of entries ) this.register(type, handler);
  }

  register(type, handler, {replace=false}={}) {
    const normalized = normalizeRuleElementType(type);
    if ( !normalized ) throw new Error("RuleElementRegistry requires a rule element type.");
    if ( typeof handler !== "function" ) throw new Error(`RuleElement handler for ${normalized} must be a function.`);
    if ( this.handlers.has(normalized) && !replace ) {
      throw new Error(`RuleElement handler already registered for ${normalized}.`);
    }
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
    [RULE_ELEMENT_TYPES.ROLL_MODE, rollModeRuleElement],
    [RULE_ELEMENT_TYPES.RESOURCE_CAP, resourceCapRuleElement],
    [RULE_ELEMENT_TYPES.ABILITY_SCORE, abilityScoreRuleElement],
    [RULE_ELEMENT_TYPES.ROLL_OUTCOME, rollOutcomeRuleElement],
    [RULE_ELEMENT_TYPES.EXTRA_DAMAGE, extraDamageRuleElement],
    [RULE_ELEMENT_TYPES.AURA, auraRuleElement],
    [RULE_ELEMENT_TYPES.GRANT_RESOURCE, grantResourceRuleElement],
    [RULE_ELEMENT_TYPES.GRANT_RESISTANCE, grantResistanceRuleElement],
    [RULE_ELEMENT_TYPES.GRANT_IMMUNITY, grantImmunityRuleElement],
    [RULE_ELEMENT_TYPES.GRANT_VULNERABILITY, grantVulnerabilityRuleElement],
    [RULE_ELEMENT_TYPES.CONDITION_IMMUNITY, conditionImmunityRuleElement],
    [RULE_ELEMENT_TYPES.AVOID_OPPORTUNITY_ATTACKS, avoidOpportunityAttacksRuleElement],
    [RULE_ELEMENT_TYPES.EXTRA_ATTACK, extraAttackRuleElement],
    [RULE_ELEMENT_TYPES.ARMOR_CLASS, armorClassRuleElement],
    [RULE_ELEMENT_TYPES.REVEAL, revealRuleElement],
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
  const payload = clonePlain({
    ...clonePlain(raw.data ?? {}),
    ...directPayload(raw)
  });
  const type = normalizeRuleElementType(raw.type ?? raw.key ?? raw.rule ?? payload.type ?? payload.key);
  const id = raw.id ?? raw.slug ?? payload.id ?? (type ? `${type}:${index}` : `RuleElement:${index}`);
  return {
    schemaVersion: normalizeSchemaVersion(raw.schemaVersion ?? payload.schemaVersion) ?? RULE_ELEMENT_SCHEMA_VERSION,
    id: String(id),
    type,
    key: raw.key ?? raw.type ?? null,
    label: raw.label ?? raw.name ?? payload.label ?? null,
    predicate: clonePlain(raw.predicate ?? payload.predicate ?? null),
    priority: finiteNumber(raw.priority ?? raw.order ?? payload.priority) ?? 100,
    enabled: raw.enabled !== false,
    suppressed: raw.suppressed === true,
    source: clonePlain(raw.source ?? source),
    metadata: clonePlain(raw.metadata ?? payload.metadata ?? {}) ?? {},
    data: payload
  };
}

/* -------------------------------------------- */

export function validateRuleElementDefinition(definition={}, {source=null, index=0}={}) {
  if ( !isPlainObject(definition) ) {
    return validationFailure("RuleElement definition must be a plain object.", "ruleElement");
  }

  const definitionIssue = findNonSerializable(definition, "ruleElement");
  if ( definitionIssue ) return validationFailure(definitionIssue.reason, definitionIssue.path);

  const sourceIssue = findNonSerializable(source, "source");
  if ( sourceIssue ) return validationFailure(sourceIssue.reason, sourceIssue.path);

  const rawSchemaVersion = definition.schemaVersion ?? definition.data?.schemaVersion;
  if ( rawSchemaVersion != null && normalizeSchemaVersion(rawSchemaVersion) == null ) {
    return validationFailure("RuleElement schemaVersion must be a positive integer.", "schemaVersion");
  }

  const ruleElement = normalizeRuleElementDefinition(definition, {source, index});
  if ( !ruleElement.type ) return validationFailure("RuleElement requires a type.", "type", ruleElement);
  if ( normalizeSchemaVersion(ruleElement.schemaVersion) == null ) {
    return validationFailure("RuleElement schemaVersion must be a positive integer.", "schemaVersion", ruleElement);
  }

  for ( const candidate of predicateCandidates(ruleElement) ) {
    const result = evaluatePredicate(candidate.value, {});
    if ( result.code === PREDICATE_CODES.INVALID ) {
      return validationFailure(`Invalid Predicate at ${candidate.path}: ${result.reason}`, candidate.path, ruleElement);
    }
  }

  return {
    ok: true,
    code: RULE_ELEMENT_CODES.OK,
    ruleElement,
    failures: []
  };
}

/* -------------------------------------------- */

export function serializeRuleElementDefinition(definition={}, options={}) {
  const validation = validateRuleElementDefinition(definition, options);
  if ( !validation.ok ) {
    return {
      ...validation,
      definition: normalizeRuleElementDefinition(isPlainObject(definition) ? definition : {}, options)
    };
  }

  const ruleElement = validation.ruleElement;
  return {
    ok: true,
    code: RULE_ELEMENT_CODES.OK,
    definition: clonePlain({
      schemaVersion: ruleElement.schemaVersion,
      id: ruleElement.id,
      type: ruleElement.type,
      key: ruleElement.key,
      label: ruleElement.label,
      predicate: ruleElement.predicate,
      priority: ruleElement.priority,
      enabled: ruleElement.enabled,
      suppressed: ruleElement.suppressed,
      source: ruleElement.source,
      metadata: ruleElement.metadata,
      data: ruleElement.data
    })
  };
}

/* -------------------------------------------- */

export function evaluateRuleElement(definition, context={}, {
  registry=DEFAULT_RULE_ELEMENT_REGISTRY,
  source=null,
  index=0
}={}) {
  const validation = validateRuleElementDefinition(definition, {source, index});
  const ruleElement = normalizeRuleElementDefinition(definition, {source, index});
  if ( !validation.ok ) return ruleElementFailure(ruleElement, validation.code, validation.reason, null, validation);
  if ( !ruleElement.type ) return ruleElementFailure(ruleElement, RULE_ELEMENT_CODES.INVALID, "RuleElement requires a type.");
  if ( !ruleElement.enabled ) return ruleElementSkipped(ruleElement, RULE_ELEMENT_CODES.DISABLED, RULE_ELEMENT_TRACE_STATUS.DISABLED);
  if ( ruleElement.suppressed ) return ruleElementSkipped(ruleElement, RULE_ELEMENT_CODES.SUPPRESSED, RULE_ELEMENT_TRACE_STATUS.SUPPRESSED);

  const predicate = evaluatePredicate(ruleElement.predicate, {ruleElement, source: ruleElement.source, ...context});
  if ( predicate.code === PREDICATE_CODES.INVALID ) {
    return ruleElementFailure(ruleElement, RULE_ELEMENT_CODES.INVALID, predicate.reason, predicate);
  }
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

  let result;
  try {
    result = handler(ruleElement, context);
  } catch (error) {
    return ruleElementFailure(ruleElement, RULE_ELEMENT_CODES.INVALID, error?.message ?? String(error), predicate);
  }
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

/**
 * A creature's damage profile from its own grants: every damage adjustment (`GrantResistance`,
 * `GrantImmunity`, ...) its active owners contribute. `owners` are `{ruleElements, source}`, one per Item
 * or effect. Returns null when nothing is granted, so callers can omit the profile.
 */
export function damageProfileFromRuleElements(owners=[], context={}) {
  const profile = emptyContributions().damageAdjustments;
  for ( const {ruleElements=[], source=null} of owners ) {
    const {contributions} = collectRuleElementContributions({ruleElements, context, source});
    for ( const [kind, entries] of Object.entries(contributions.damageAdjustments) ) profile[kind].push(...entries);
  }
  return Object.values(profile).some(entries => entries.length) ? profile : null;
}

/**
 * The resources a creature's grants give (`GrantResource`), one entry per grant, from the same owners as
 * its damage profile. Each backs the creature's pool of the same id.
 */
export function grantedResourcesFromRuleElements(owners=[], context={}) {
  return owners.flatMap(({ruleElements=[], source=null}) =>
    collectRuleElementContributions({ruleElements, context, source}).contributions.resources);
}

/**
 * The advantage and disadvantage a creature's owners give in any of `domains` (`RollMode`), each with its
 * source. A RollMode's predicate sees `context` (for example `attack.adjacent` for "within 5 feet").
 */
export function rollModesFromRuleElements(owners=[], {domains=[], context={}}={}) {
  return contributionsInDomains(owners, "rollModes", domains, context);
}

/** The forced outcomes (`RollOutcome`) a creature's owners give in any of `domains`. */
export function rollOutcomesFromRuleElements(owners=[], {domains=[], context={}}={}) {
  return contributionsInDomains(owners, "rollOutcomes", domains, context);
}

/** The conditions a creature's owners make it immune to (`ConditionImmunity`), as condition ids. */
export function conditionImmunitiesFromRuleElements(owners=[], context={}) {
  return [...new Set(owners.flatMap(({ruleElements=[], source=null}) =>
    collectRuleElementContributions({ruleElements, context, source}).contributions.conditionImmunities))];
}

/**
 * Whether a creature's movement provokes Opportunity Attacks (`AvoidOpportunityAttacks`): `always` when one of its rules
 * names no movement mode, else the modes in which it does not (`["fly"]`: Flyby).
 */
export function opportunityAttackAvoidanceFromRuleElements(owners=[], context={}) {
  const entries = owners.flatMap(({ruleElements=[], source=null}) =>
    collectRuleElementContributions({ruleElements, context, source}).contributions.opportunityAttackAvoidance);
  return {always: entries.some(entry => !entry.movementModes.length), movementModes: [...new Set(entries.flatMap(entry => entry.movementModes))]};
}

/** The pools a creature's further attacks of an Attack action are paid from (`ExtraAttack`), as resource ids. */
export function extraAttacksFromRuleElements(owners=[], context={}) {
  return [...new Set(owners.flatMap(({ruleElements=[], source=null}) =>
    collectRuleElementContributions({ruleElements, context, source}).contributions.extraAttacks))];
}

/** The ways a creature's owners give it to work out its Armor Class (`ArmorClass`), as `{id, label, value, armor}`. */
export function armorClassesFromRuleElements(owners=[], context={}) {
  return owners.flatMap(({ruleElements=[], source=null}) =>
    collectRuleElementContributions({ruleElements, context, source}).contributions.armorClasses);
}

/** The auras (`Aura`) a creature's owners give it: each grants its rules to creatures within its radius. */
export function aurasFromRuleElements(owners=[], context={}) {
  return owners.flatMap(({ruleElements=[], source=null}) => collectRuleElementContributions({ruleElements, context, source}).contributions.auras);
}

/** The extra damage (`ExtraDamage`) a creature's owners add to an Action's damage in any of `domains`. */
export function extraDamageFromRuleElements(owners=[], {domains=[], context={}}={}) {
  return contributionsInDomains(owners, "extraDamage", domains, context);
}

function contributionsInDomains(owners, key, domains, context) {
  const wanted = new Set(domains);
  return owners.flatMap(({ruleElements=[], source=null}) =>
    collectRuleElementContributions({ruleElements, context, source}).contributions[key]
      .filter(entry => entry.domains.some(domain => wanted.has(domain))));
}

/** The lowest ceiling each resource has from a creature's owners (`ResourceCap`), as `{resourceId: maximum}`. */
export function resourceCapsFromRuleElements(owners=[], context={}) {
  const caps = {};
  for ( const {ruleElements=[], source=null} of owners ) {
    for ( const cap of collectRuleElementContributions({ruleElements, context, source}).contributions.resourceCaps ) {
      for ( const id of cap.resources ) caps[id] = Math.min(caps[id] ?? Infinity, cap.maximum);
    }
  }
  return caps;
}

/** The changes a creature's owners make to its ability scores (`AbilityScore`): `{ability, mode, value, maximum}`. */
export function abilityScoreChangesFromRuleElements(owners=[], context={}) {
  return owners.flatMap(({ruleElements=[], source=null}) =>
    collectRuleElementContributions({ruleElements, context, source}).contributions.abilityScores);
}

export const ABILITY_SCORE_MODES = Object.freeze(["add", "upgrade", "downgrade", "override"]);

/**
 * An ability score after its changes, in this order:
 * - `add` raises it, to at most `maximum` (20 unless the rule says: an Ioun Stone's +2, a Manual's +2 to 22);
 *   a score already above that maximum stays. A negative add lowers it (a Shadow's Strength drain);
 * - `upgrade` sets it to at least the value (a Belt of Giant Strength's 21);
 * - `downgrade` to at most the value;
 * - `override` sets it outright.
 */
export function abilityScoreAfter(base, changes=[]) {
  let score = Number(base) || 0;
  const of = mode => changes.filter(change => change.mode === mode);
  for ( const change of of("add") ) {
    score = change.value < 0 ? score + change.value : Math.max(score, Math.min(score + change.value, change.maximum ?? 20));
  }
  for ( const change of of("upgrade") ) score = Math.max(score, change.value);
  for ( const change of of("downgrade") ) score = Math.min(score, change.value);
  for ( const change of of("override") ) score = change.value;
  return Math.max(score, 0);
}

/** The Speeds a creature's grants give (`GrantMovement`): `{mode, distance}`, one per grant. */
export function grantedMovementFromRuleElements(owners=[], context={}) {
  return owners.flatMap(({ruleElements=[], source=null}) =>
    collectRuleElementContributions({ruleElements, context, source}).contributions.movement
      .map(entry => (entry.hover ? {...entry.capability, hover: true} : entry.capability)));
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
  if ( !domains.length ) {
    return handlerFailure(RULE_ELEMENT_CODES.INVALID, "Modifier RuleElement requires a selector or domain.");
  }
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
      // The grant's own rule id: one feature's grant copied onto each of its Actions counts once (getGrantedResources).
      ruleId: ruleElement.id ?? null,
      label: data.label ?? String(id),
      current: Math.max(current.value, 0),
      maximum: Math.max(maximum.value, 0),
      recovery: data.recovery ?? "none",
      // Multiattack's attacks: the pool is emptied at the start of each of the creature's turns.
      ...(data.emptiesAtTurnStart === true ? {emptiesAtTurnStart: true} : {}),
      // Recharge (a breath weapon): at the start of the creature's turn a d6 of this or more refills the pool.
      ...(Number.isInteger(Number(data.recharge)) && (Number(data.recharge) >= 2) && (Number(data.recharge) <= 6)
        ? {recharge: Number(data.recharge)} : {}),
      // A partial refill on a rest, a number or ValueExpression: `{shortRest: 1}` ("regain one use on a Short Rest"),
      // `{longRest: 1d6 + 1}` (a wand's charges at dawn). A full refill is `recovery`.
      ...(data.regain ? {regain: Object.fromEntries(["shortRest", "longRest"].filter(rest => data.regain[rest] != null)
        .map(rest => [rest, clonePlain(data.regain[rest])]))} : {}),
      source: ruleElementSource(ruleElement),
      metadata: contributionMetadata(ruleElement, data.metadata)
    }]
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

function grantVulnerabilityRuleElement(ruleElement) {
  const data = ruleElement.data;
  return success({
    damageAdjustments: {
      vulnerabilities: [{
        id: data.adjustmentId ?? data.id ?? ruleElement.id,
        damageTypes: normalizeStrings(data.damageTypes ?? data.types ?? data.damageType),
        tags: normalizeStrings(data.tags),
        metadata: contributionMetadata(ruleElement, data.metadata)
      }]
    }
  });
}

/** Immunity to conditions: applying one of `conditions` to the creature does nothing. */
function conditionImmunityRuleElement(ruleElement) {
  const conditions = normalizeStrings(ruleElement.data.conditions ?? ruleElement.data.conditionIds);
  if ( !conditions.length ) return handlerFailure(RULE_ELEMENT_CODES.INVALID, "ConditionImmunity RuleElement requires conditions.");
  return success({conditionImmunities: conditions});
}

/**
 * 2024 Extra Attack: the creature's weapon attacks that cost the Action may be paid from the `resourceId` pool instead,
 * and paying one with the Action fills that pool (the other attacks of that Attack action). Its `GrantResource` gives
 * the pool, empty, emptied at the start of each turn.
 */
function extraAttackRuleElement(ruleElement) {
  const resourceId = ruleElement.data.resourceId ?? ruleElement.data.resource ?? null;
  if ( !resourceId ) return handlerFailure(RULE_ELEMENT_CODES.INVALID, "ExtraAttack RuleElement requires a resourceId.");
  return success({extraAttacks: [String(resourceId)]});
}

/**
 * A way to work out the creature's Armor Class (2024): `value`, a number or ValueExpression ("11 + Agility modifier",
 * "10 + Agility + Fortitude modifiers"). `armor: true` is armor it wears; while it wears any, its unarmored ways
 * (Unarmored Defense, Mage Armor) do not count. Its AC uses the best that counts; bonuses (a Shield) add to it.
 */
function armorClassRuleElement(ruleElement, context) {
  const data = ruleElement.data;
  const value = evaluateNumeric(data.value ?? data.valueExpression, context);
  if ( !value.ok ) return value;
  return success({armorClasses: [{id: data.id ?? ruleElement.id, label: data.label ?? ruleElement.label ?? ruleElement.id,
    value: value.value, armor: data.armor === true, source: ruleElementSource(ruleElement)}]});
}

/** The creature provokes no Opportunity Attacks: when it moves in one of `movementModes`, or always when none is named. */
function avoidOpportunityAttacksRuleElement(ruleElement) {
  return success({opportunityAttackAvoidance: [{movementModes: normalizeStrings(ruleElement.data.movementModes)}]});
}

/**
 * What the creature bearing this rule reveals to whoever applied its effect: `defenses` (its AC and save bonuses,
 * so the odds against it show, whatever the table's house rule).
 */
function revealRuleElement(ruleElement) {
  return success({reveals: normalizeStrings(ruleElement.data.details ?? "defenses")});
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
      // A flying creature that can hover does not fall when it is knocked Prone (2024).
      ...(data.hover === true ? {hover: true} : {}),
      source: ruleElementSource(ruleElement),
      metadata: contributionMetadata(ruleElement, data.metadata)
    }]
  });
}

/**
 * Advantage or disadvantage on d20 rolls in the named domains: a creature's own (`attack`, `attack.melee`,
 * `save`, `save.agility`, `check`, ...) or attack rolls made against it (`attacked`, `attacked.ranged`, ...).
 */
/**
 * Extra damage an Action deals in `domains` (the damage domains: `damage`, `damage.melee`, `damage.weapon`, ...):
 * "+1d6 fire when you hit with a melee attack" is `{domains: ["damage.melee"], expression: 1d6, damageType: "fire"}`.
 * It joins the Action's own damage (one roll, doubled on a critical); `once: "turn"` limits it to once per turn.
 */
function extraDamageRuleElement(ruleElement) {
  const data = ruleElement.data;
  const domains = normalizeStrings(data.domains ?? data.domain);
  const expression = data.expression ?? data.valueExpression ?? null;
  if ( !domains.length ) return handlerFailure(RULE_ELEMENT_CODES.INVALID, "ExtraDamage RuleElement requires domains.");
  if ( !expression || (typeof expression !== "object") ) {
    return handlerFailure(RULE_ELEMENT_CODES.INVALID, "ExtraDamage RuleElement requires a damage expression.");
  }
  if ( (data.once != null) && (data.once !== "turn") ) {
    return handlerFailure(RULE_ELEMENT_CODES.INVALID, "ExtraDamage RuleElement once must be \"turn\".");
  }
  return success({
    extraDamage: [{id: data.id ?? ruleElement.id, domains, expression: clonePlain(expression), damageType: data.damageType ?? null,
      once: data.once ?? null, source: ruleElementSource(ruleElement), metadata: contributionMetadata(ruleElement, data.metadata)}]
  });
}

const AURA_AFFECTS = Object.freeze(["allies", "enemies", "all"]);

/**
 * An aura: `{radius, affects: "allies" | "enemies" | "all", ruleElements: [...]}` grants its nested rules to the
 * creatures within `radius` feet of its bearer (allies and all include the bearer). The Foundry adapter works out
 * who is inside when a statistic is read.
 */
function auraRuleElement(ruleElement, context={}) {
  const data = ruleElement.data;
  // A radius may grow with its bearer (Aura of Protection: 30 feet from Aura Expansion), read as the bearer's.
  const evaluated = evaluateNumeric(data.radius, context);
  const radius = evaluated.ok ? Number(evaluated.value) : Number(data.radius);
  const affects = data.affects ?? "allies";
  const ruleElements = Array.isArray(data.ruleElements) ? data.ruleElements : [];
  if ( !(radius > 0) ) return handlerFailure(RULE_ELEMENT_CODES.INVALID, "Aura RuleElement requires a radius in feet.");
  if ( !AURA_AFFECTS.includes(affects) ) return handlerFailure(RULE_ELEMENT_CODES.INVALID, "Aura RuleElement affects allies, enemies or all.");
  for ( const [index, nested] of ruleElements.entries() ) {
    const validation = validateRuleElementDefinition(nested, {index});
    if ( !validation.ok ) return handlerFailure(RULE_ELEMENT_CODES.INVALID, `Aura rule ${index}: ${validation.reason ?? validation.code}`);
    if ( !DEFAULT_RULE_ELEMENT_REGISTRY.has(validation.ruleElement.type) ) {
      return handlerFailure(RULE_ELEMENT_CODES.INVALID, `Aura rule ${index}: unknown RuleElement type ${nested.type}`);
    }
  }
  // Its bonuses are its bearer's (Aura of Protection: the paladin's Charisma modifier), worked out here, not by whoever
  // stands in it.
  const granted = ruleElements.map(nested => {
    const expression = nested?.data?.valueExpression;
    if ( (nested?.type !== "Modifier") || !expression ) return clonePlain(nested);
    const value = evaluateNumeric(expression, context);
    if ( !value.ok ) return clonePlain(nested);
    const {valueExpression: _expression, ...rest} = nested.data;
    return {...clonePlain(nested), data: {...rest, value: value.value}};
  });
  return success({
    auras: [{id: data.id ?? ruleElement.id, radius, affects, ruleElements: granted, source: ruleElementSource(ruleElement),
      metadata: contributionMetadata(ruleElement, data.metadata)}]
  });
}

function rollModeRuleElement(ruleElement) {
  const data = ruleElement.data;
  const domains = normalizeStrings(data.domains ?? data.domain);
  if ( !["advantage", "disadvantage"].includes(data.mode) ) {
    return handlerFailure(RULE_ELEMENT_CODES.INVALID, "RollMode RuleElement mode must be advantage or disadvantage.");
  }
  if ( !domains.length ) return handlerFailure(RULE_ELEMENT_CODES.INVALID, "RollMode RuleElement requires domains.");
  return success({
    rollModes: [{id: data.id ?? ruleElement.id, mode: data.mode, domains, source: ruleElementSource(ruleElement),
      metadata: contributionMetadata(ruleElement, data.metadata)}]
  });
}

/**
 * A ceiling on resource maxima: `{resources: ["action", "bonus", "reaction"], maximum: 0}` is "can't take
 * actions", `{resources: ["movement"], maximum: 0}` is Speed 0 (every Speed, granted ones included).
 */
function resourceCapRuleElement(ruleElement, context) {
  const data = ruleElement.data;
  const resources = normalizeStrings(data.resources ?? data.resource);
  if ( !resources.length ) return handlerFailure(RULE_ELEMENT_CODES.INVALID, "ResourceCap RuleElement requires resources.");
  const maximum = evaluateNumeric(data.maximum ?? data.max ?? 0, context);
  if ( !maximum.ok ) return maximum;
  return success({
    resourceCaps: [{id: data.id ?? ruleElement.id, resources, maximum: Math.max(maximum.value, 0),
      source: ruleElementSource(ruleElement), metadata: contributionMetadata(ruleElement, data.metadata)}]
  });
}

/**
 * A change to one ability score while it applies (a Belt of Giant Strength, an Ioun Stone, Feeblemind):
 * `{ability, mode: "add" | "upgrade" | "downgrade" | "override", value, maximum?}` (abilityScoreAfter).
 */
function abilityScoreRuleElement(ruleElement, context) {
  const data = ruleElement.data;
  const ability = String(data.ability ?? "").trim();
  if ( !ability ) return handlerFailure(RULE_ELEMENT_CODES.INVALID, "AbilityScore RuleElement requires an ability.");
  const mode = String(data.mode ?? "add");
  if ( !ABILITY_SCORE_MODES.includes(mode) ) {
    return handlerFailure(RULE_ELEMENT_CODES.INVALID, `AbilityScore mode must be one of ${ABILITY_SCORE_MODES.join(", ")}.`);
  }
  const value = evaluateNumeric(data.value ?? 0, context);
  if ( !value.ok ) return value;
  const maximum = data.maximum == null ? null : evaluateNumeric(data.maximum, context);
  if ( maximum && !maximum.ok ) return maximum;
  return success({
    abilityScores: [{id: data.id ?? ruleElement.id, ability, mode, value: value.value, maximum: maximum?.value ?? null,
      source: ruleElementSource(ruleElement), metadata: contributionMetadata(ruleElement, data.metadata)}]
  });
}

/**
 * A forced roll outcome: `automatic-failure` on the creature's saves in its domains (`save.might`),
 * `critical-on-hit` on attacks against it (`attacked`), or `evasion` on its saves (damage a success halves: none on a
 * success, half on a failure), each gated by the RuleElement's predicate.
 */
function rollOutcomeRuleElement(ruleElement) {
  const data = ruleElement.data;
  const domains = normalizeStrings(data.domains ?? data.domain);
  // `critical-range`: its attacks score a Critical Hit on a d20 of `threshold` or more (Improved Critical: 19).
  // `minimum-natural`: a d20 below `threshold` counts as it (Reliable Talent: 10, on checks with a proficiency).
  if ( !["automatic-failure", "critical-on-hit", "evasion", "critical-range", "minimum-natural"].includes(data.outcome) ) {
    return handlerFailure(RULE_ELEMENT_CODES.INVALID,
      "RollOutcome RuleElement outcome must be automatic-failure, critical-on-hit, evasion, critical-range or minimum-natural.");
  }
  if ( !domains.length ) return handlerFailure(RULE_ELEMENT_CODES.INVALID, "RollOutcome RuleElement requires domains.");
  const threshold = Number(data.threshold);
  if ( (data.outcome === "critical-range") && !(Number.isInteger(threshold) && (threshold >= 2) && (threshold <= 20)) ) {
    return handlerFailure(RULE_ELEMENT_CODES.INVALID, "A critical-range RollOutcome needs a threshold from 2 to 20.");
  }
  if ( (data.outcome === "minimum-natural") && !(Number.isInteger(threshold) && (threshold >= 1) && (threshold <= 20)) ) {
    return handlerFailure(RULE_ELEMENT_CODES.INVALID, "A minimum-natural RollOutcome needs a threshold from 1 to 20.");
  }
  const thresholded = ["critical-range", "minimum-natural"].includes(data.outcome);
  return success({
    rollOutcomes: [{id: data.id ?? ruleElement.id, outcome: data.outcome, domains, ...(thresholded ? {threshold} : {}),
      source: ruleElementSource(ruleElement),
      metadata: contributionMetadata(ruleElement, data.metadata)}]
  });
}

function triggerRuleElement(ruleElement) {
  const data = ruleElement.data;
  const event = data.event ?? data.eventType ?? null;
  const match = data.match ?? {};
  if ( !event && !match.type ) {
    return handlerFailure(RULE_ELEMENT_CODES.INVALID, "Trigger RuleElement requires an event type.");
  }
  return success({
    triggers: [createTriggerDefinition({
      id: data.triggerId ?? data.id ?? ruleElement.id,
      kind: data.kind ?? data.triggerKind,
      event,
      match,
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

function handlerFailure(code, reason) {
  return {ok: false, code, reason, contributions: emptyContributions()};
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
    damageAdjustments: {
      immunities: [],
      resistances: [],
      vulnerabilities: [],
      reductions: [],
      absorptions: []
    },
    movement: [],
    rollModes: [],
    resourceCaps: [],
    abilityScores: [],
    rollOutcomes: [],
    extraDamage: [],
    auras: [],
    conditionImmunities: [],
    opportunityAttackAvoidance: [],
    extraAttacks: [],
    armorClasses: [],
    reveals: [],
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
  target.movement.push(...(source.movement ?? source.movements ?? []));
  target.rollModes.push(...(source.rollModes ?? []));
  target.resourceCaps.push(...(source.resourceCaps ?? []));
  target.abilityScores.push(...(source.abilityScores ?? []));
  target.rollOutcomes.push(...(source.rollOutcomes ?? []));
  target.extraDamage.push(...(source.extraDamage ?? []));
  target.auras.push(...(source.auras ?? []));
  target.conditionImmunities.push(...(source.conditionImmunities ?? []));
  target.opportunityAttackAvoidance.push(...(source.opportunityAttackAvoidance ?? []));
  target.extraAttacks.push(...(source.extraAttacks ?? []));
  target.armorClasses.push(...(source.armorClasses ?? []));
  target.reveals.push(...(source.reveals ?? []));
  target.triggers.push(...(source.triggers ?? []));

  const damage = source.damageAdjustments ?? {};
  for ( const key of Object.keys(target.damageAdjustments) ) {
    target.damageAdjustments[key].push(...(damage[key] ?? []));
  }
  return target;
}

function sortContributions(contributions) {
  for ( const key of ["modifiers", "resources", "movement", "rollModes", "resourceCaps", "rollOutcomes",
    "extraDamage", "auras", "triggers"] ) {
    contributions[key].sort(compareContributions);
  }
  for ( const entries of Object.values(contributions.damageAdjustments) ) {
    entries.sort(compareContributions);
  }
}

function createTrace(ruleElement, status, predicateResult=null, reason=null, contributions=emptyContributions()) {
  return {
    schemaVersion: ruleElement.schemaVersion,
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
      damageAdjustments: Object.values(contributions.damageAdjustments).reduce((sum, entries) => sum + entries.length, 0),
      movement: contributions.movement.length,
      rollModes: contributions.rollModes.length,
      resourceCaps: contributions.resourceCaps.length,
      rollOutcomes: contributions.rollOutcomes.length,
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
  const ignored = new Set(["schemaVersion", "id", "slug", "type", "key", "rule", "label", "name", "predicate", "priority", "order", "enabled", "suppressed", "source", "metadata", "data"]);
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !ignored.has(key)));
}

function isPlainObject(value) {
  if ( typeof value !== "object" || value === null || Array.isArray(value) ) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function finiteNumber(value) {
  if ( value == null || value === "" ) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeSchemaVersion(value) {
  if ( value == null || value === "" ) return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function validationFailure(reason, path, ruleElement=null) {
  return {
    ok: false,
    code: RULE_ELEMENT_CODES.INVALID,
    reason,
    path,
    ruleElement,
    failures: [{code: RULE_ELEMENT_CODES.INVALID, reason, path}]
  };
}

function predicateCandidates(ruleElement) {
  const data = ruleElement.data ?? {};
  return [
    ["predicate", ruleElement.predicate],
    ["data.predicate", data.predicate],
    ["data.modifierPredicate", data.modifierPredicate],
    ["data.appliesIf", data.appliesIf],
    ["data.resourcePredicate", data.resourcePredicate],
    ["data.paymentPredicate", data.paymentPredicate],
    ["data.triggerPredicate", data.triggerPredicate],
    ["data.eventPredicate", data.eventPredicate]
  ]
    .filter(([, value]) => value != null)
    .map(([path, value]) => ({path, value}));
}

function findNonSerializable(value, path, seen=new Set()) {
  const type = typeof value;
  if ( value == null || type === "string" || type === "boolean" ) return null;
  if ( type === "number" ) {
    return Number.isFinite(value) ? null : {path, reason: `${path} must be a finite JSON number.`};
  }
  if ( type === "function" || type === "symbol" || type === "bigint" || type === "undefined" ) {
    return {path, reason: `${path} must be JSON-serializable data, not ${type}.`};
  }
  if ( seen.has(value) ) return {path, reason: `${path} must not contain circular references.`};
  seen.add(value);

  if ( Array.isArray(value) ) {
    for ( const [index, entry] of value.entries() ) {
      const issue = findNonSerializable(entry, `${path}.${index}`, seen);
      if ( issue ) return issue;
    }
    seen.delete(value);
    return null;
  }

  if ( !isPlainObject(value) ) {
    return {path, reason: `${path} must be plain JSON-serializable data.`};
  }

  for ( const [key, entry] of Object.entries(value) ) {
    const issue = findNonSerializable(entry, `${path}.${key}`, seen);
    if ( issue ) return issue;
  }
  seen.delete(value);
  return null;
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
