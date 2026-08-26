import {WILDPATH} from "../config.mjs";
import {evaluatePredicate} from "./predicates.mjs";
import {evaluateValueExpression} from "./value-expressions.mjs";

export const MODIFIER_TRACE_STATUS = Object.freeze({
  APPLIED: "applied",
  DISABLED: "disabled",
  SUPPRESSED: "suppressed",
  PREDICATE_FAILED: "predicate-failed",
  INVALID_VALUE: "invalid-value",
  SUPERSEDED: "superseded",
  STACKING_SUPPRESSED: "stacking-suppressed"
});

/**
 * A single declarative bonus or penalty contributing to some derived value.
 * Modifiers are serializable rules data: predicates and values use the shared Predicate and
 * ValueExpression primitives instead of arbitrary JavaScript.
 */
export class WildPathModifier {
  /**
   * @param {object} data
   * @param {string} [data.id]        Stable identifier used for de-duplication.
   * @param {string} [data.slug]      Back-compat stable identifier alias.
   * @param {string} data.label       Human-readable label, shown in breakdowns/tooltips.
   * @param {string} [data.selector]  Primary domain/selector this modifier targets.
   * @param {Iterable<string>|string} [data.domains] Additional targeted domains/selectors.
   * @param {string} [data.type]      One of CONFIG.WILDPATH.MODIFIER_TYPES (or any custom string).
   * @param {number|object} [data.valueExpression] The structured ValueExpression contribution.
   * @param {number} [data.value]     Back-compat fixed numeric contribution.
   * @param {object|null} [data.predicate]
   * @param {number} [data.priority=100]
   * @param {unknown} [data.source]   Optional UUID/name/provenance of the origin.
   * @param {object} [data.metadata]
   * @param {boolean} [data.enabled=true]
   * @param {boolean} [data.suppressed=false]
   * @param {object} [context]        Evaluation context for ValueExpression/Predicate.
   */
  constructor(data={}, context={}) {
    const label = data.label ?? data.type ?? "Modifier";
    const id = data.id ?? data.slug ?? slugify(label);

    this.label = label;
    this.id = String(id);
    this.slug = String(data.slug ?? id);
    this.selector = data.selector ?? data.domain ?? firstDomain(data.domains) ?? null;
    this.domains = normalizeDomains(data.domains ?? data.domain ?? data.selector);
    this.type = data.type ?? "untyped";
    this.valueExpression = normalizeValueExpression(data);
    this.predicate = data.predicate ?? null;
    this.priority = Number(data.priority ?? data.order ?? 100) || 100;
    this.order = Number(data.order ?? this.priority) || this.priority;
    this.source = data.source == null ? null : clonePlain(data.source);
    this.metadata = clonePlain(data.metadata ?? {});
    this.enabled = data.enabled !== false;
    this.suppressed = data.suppressed === true;

    const evaluation = this.evaluate(context);
    this.value = evaluation.valueResult.ok ? evaluation.valueResult.value : 0;
    this.valueResult = evaluation.valueResult;
    this.predicateResult = evaluation.predicateResult;
  }

  /** @returns {string} A "+N"/"-N" formatted string of this modifier's value. */
  get signedValue() {
    return this.value >= 0 ? `+${this.value}` : `${this.value}`;
  }

  /**
   * Re-evaluate this modifier in a statistic-specific context.
   * @param {object} [context]
   * @returns {object}
   */
  evaluate(context={}) {
    const evaluationContext = {
      ...context,
      domain: context.domain ?? this.selector,
      modifier: this,
      source: this.source,
      metadata: this.metadata
    };
    return {
      valueResult: evaluateValueExpression(this.valueExpression, evaluationContext),
      predicateResult: evaluatePredicate(this.predicate, evaluationContext)
    };
  }

  /**
   * @param {object} [context]
   * @returns {WildPathModifier}
   */
  withContext(context={}) {
    return new WildPathModifier(this.toObject(), context);
  }

  /** @returns {object} */
  toObject() {
    return {
      id: this.id,
      slug: this.slug,
      label: this.label,
      selector: this.selector,
      domains: [...this.domains],
      type: this.type,
      valueExpression: clonePlain(this.valueExpression),
      value: this.value,
      predicate: clonePlain(this.predicate),
      priority: this.priority,
      order: this.order,
      source: clonePlain(this.source),
      metadata: clonePlain(this.metadata),
      enabled: this.enabled,
      suppressed: this.suppressed
    };
  }
}

/* -------------------------------------------- */

/**
 * Apply standard typed-modifier stacking rules to a list of modifiers and return the applied
 * subset (PF2e "typed bonus" convention):
 * - Modifier types flagged in CONFIG.WILDPATH.MODIFIER_TYPES_ALWAYS_STACK (untyped, circumstance
 *   by default) always stack - every enabled instance contributes.
 * - For every other type, only the single highest positive (bonus) value AND the single lowest
 *   negative (penalty) value of that type apply; duplicates of the same sign are ignored.
 * @param {WildPathModifier[]} modifiers   Already-enabled candidate modifiers.
 * @returns {WildPathModifier[]}           The subset that actually applies.
 */
function applyStackingRules(modifiers) {
  const alwaysStack = WILDPATH.MODIFIER_TYPES_ALWAYS_STACK;

  /** @type {Map<string, {bonus: WildPathModifier|null, penalty: WildPathModifier|null}>} */
  const byType = new Map();
  const applied = [];

  for ( const modifier of modifiers ) {
    if ( alwaysStack.has(modifier.type) ) {
      applied.push(modifier);
      continue;
    }
    if ( !byType.has(modifier.type) ) byType.set(modifier.type, {bonus: null, penalty: null});
    const bucket = byType.get(modifier.type);
    if ( modifier.value >= 0 ) {
      if ( !bucket.bonus || isPreferredBonus(modifier, bucket.bonus) ) bucket.bonus = modifier;
    }
    else {
      if ( !bucket.penalty || isPreferredPenalty(modifier, bucket.penalty) ) bucket.penalty = modifier;
    }
  }

  for ( const {bonus, penalty} of byType.values() ) {
    if ( bonus ) applied.push(bonus);
    if ( penalty ) applied.push(penalty);
  }
  return applied;
}

/* -------------------------------------------- */

/**
 * A named collection of modifiers contributing to one derived value ("domain"), following
 * PF2e's `StatisticModifier` pattern:
 * 1. De-duplicate by `slug`, keeping only the highest-magnitude enabled instance of each slug
 *    (mirrors PF2e allowing homebrew content to safely override/replace a named modifier rather
 *    than stacking duplicates of itself).
 * 2. Reduce the de-duplicated set via typed-bonus stacking rules (see `applyStackingRules`).
 * This is the calculation-engine primitive used by `WildPathActor#getStatistic` and is the
 * single place derived-value math happens, so future rules only need to change one function.
 */
export class WildPathStatistic {
  /**
   * @param {string} domain                  The derived-value key this statistic represents.
   * @param {WildPathModifier[]} [modifiers]  Candidate modifiers gathered from Items/ActiveEffects.
   * @param {object} [options]
   * @param {object} [options.context]       ValueExpression/Predicate evaluation context.
   */
  constructor(domain, modifiers=[], {context={}}={}) {
    this.domain = domain;
    this.candidates = modifiers.map(modifier => {
      const data = modifier instanceof WildPathModifier ? modifier.toObject() : modifier;
      return new WildPathModifier(data, {...context, domain});
    });

    const eligible = this.candidates.filter(modifier => isEligibleModifier(modifier));
    const deduplicated = deduplicateModifiers(eligible);

    this.modifiers = deduplicated;
    this.applied = applyStackingRules(deduplicated.filter(m => m.enabled));
    this.trace = createModifierTrace(domain, this.candidates, this.modifiers, this.applied);
  }

  /** @type {number} The final, stacking-adjusted total for this domain. */
  get totalModifier() {
    return this.applied.reduce((sum, m) => sum + m.value, 0);
  }

  /** @type {string} A human-readable "Label +N, Label -N, ..." breakdown of applied modifiers. */
  get breakdown() {
    return this.applied.map(m => `${m.label} ${m.signedValue}`).join(", ");
  }
}

function deduplicateModifiers(modifiers) {
  const byId = new Map();
  for ( const modifier of modifiers ) {
    const existing = byId.get(modifier.id);
    if ( !existing || isPreferredDuplicate(modifier, existing) ) byId.set(modifier.id, modifier);
  }
  return [...byId.values()].sort(compareModifierOrder);
}

function isEligibleModifier(modifier) {
  return modifier.enabled
    && !modifier.suppressed
    && modifier.valueResult.ok
    && modifier.predicateResult.ok;
}

function isPreferredDuplicate(candidate, existing) {
  const magnitude = Math.abs(candidate.value) - Math.abs(existing.value);
  if ( magnitude ) return magnitude > 0;
  return compareModifierOrder(candidate, existing) < 0;
}

function isPreferredBonus(candidate, existing) {
  if ( candidate.value !== existing.value ) return candidate.value > existing.value;
  return compareModifierOrder(candidate, existing) < 0;
}

function isPreferredPenalty(candidate, existing) {
  if ( candidate.value !== existing.value ) return candidate.value < existing.value;
  return compareModifierOrder(candidate, existing) < 0;
}

function compareModifierOrder(a, b) {
  const priority = (a.priority ?? 100) - (b.priority ?? 100);
  if ( priority ) return priority;
  const order = (a.order ?? a.priority ?? 100) - (b.order ?? b.priority ?? 100);
  if ( order ) return order;
  return a.id.localeCompare(b.id);
}

function createModifierTrace(domain, candidates, deduplicated, applied) {
  return {
    domain,
    total: applied.reduce((sum, modifier) => sum + modifier.value, 0),
    candidates: candidates.map(modifier => traceEntry(modifier, modifierStatus(modifier, deduplicated, applied))),
    applied: applied.map(modifier => traceEntry(modifier, MODIFIER_TRACE_STATUS.APPLIED))
  };
}

function modifierStatus(modifier, deduplicated, applied) {
  if ( !modifier.enabled ) return MODIFIER_TRACE_STATUS.DISABLED;
  if ( modifier.suppressed ) return MODIFIER_TRACE_STATUS.SUPPRESSED;
  if ( !modifier.predicateResult.ok ) return MODIFIER_TRACE_STATUS.PREDICATE_FAILED;
  if ( !modifier.valueResult.ok ) return MODIFIER_TRACE_STATUS.INVALID_VALUE;
  if ( !deduplicated.includes(modifier) ) return MODIFIER_TRACE_STATUS.SUPERSEDED;
  if ( !applied.includes(modifier) ) return MODIFIER_TRACE_STATUS.STACKING_SUPPRESSED;
  return MODIFIER_TRACE_STATUS.APPLIED;
}

function traceEntry(modifier, status) {
  return {
    id: modifier.id,
    slug: modifier.slug,
    label: modifier.label,
    selector: modifier.selector,
    domains: [...modifier.domains],
    type: modifier.type,
    value: modifier.value,
    valueExpression: clonePlain(modifier.valueExpression),
    valueResult: clonePlain(modifier.valueResult),
    predicate: clonePlain(modifier.predicate),
    predicateResult: clonePlain(modifier.predicateResult),
    priority: modifier.priority,
    source: clonePlain(modifier.source),
    metadata: clonePlain(modifier.metadata),
    status
  };
}

function normalizeValueExpression(data) {
  if ( data.valueExpression != null ) return clonePlain(data.valueExpression);
  if ( data.expression != null ) return clonePlain(data.expression);
  return {type: "constant", value: Number(data.value ?? 0) || 0};
}

function normalizeDomains(domains) {
  if ( domains == null ) return new Set();
  if ( typeof domains === "string" ) return new Set([domains].filter(Boolean));
  if ( domains instanceof Set ) return new Set([...domains].filter(Boolean));
  if ( Array.isArray(domains) ) return new Set(domains.filter(Boolean));
  return new Set();
}

function firstDomain(domains) {
  return normalizeDomains(domains).values().next().value ?? null;
}

function slugify(value) {
  const string = String(value ?? "modifier");
  return (string.slugify?.({strict: true}) ?? string.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    ) || "modifier";
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
