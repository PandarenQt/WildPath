import {WILDPATH} from "../config.mjs";

/**
 * A single discrete bonus or penalty contributing to some derived value.
 * Deliberately simple/serializable so it can be authored on an Item, ActiveEffect, or
 * generated dynamically at prepare-data time. Mirrors PF2e's `Modifier`/`RawModifier`.
 */
export class WildPathModifier {
  /**
   * @param {object} data
   * @param {string} data.slug        Stable identifier used for de-duplication (defaults to a slug of label).
   * @param {string} data.label       Human readable label, shown in breakdowns/tooltips.
   * @param {string} [data.type]      One of CONFIG.WILDPATH.MODIFIER_TYPES (or any custom string).
   * @param {number} data.value       The signed numeric contribution.
   * @param {string} [data.source]    Optional UUID/name of the origin (Item, ActiveEffect, etc).
   * @param {boolean} [data.enabled=true]
   */
  constructor({slug, label, type="untyped", value=0, source, enabled=true}={}) {
    this.label = label ?? type;
    this.slug = slug ?? this.label.slugify({strict: true});
    this.type = type;
    this.value = Number(value) || 0;
    this.source = source ?? null;
    this.enabled = enabled;
  }

  /** @returns {string} A "+N"/"-N" formatted string of this modifier's value. */
  get signedValue() {
    return this.value >= 0 ? `+${this.value}` : `${this.value}`;
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
      if ( !bucket.bonus || (modifier.value > bucket.bonus.value) ) bucket.bonus = modifier;
    }
    else {
      if ( !bucket.penalty || (modifier.value < bucket.penalty.value) ) bucket.penalty = modifier;
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
   */
  constructor(domain, modifiers=[]) {
    this.domain = domain;

    // De-duplication: prefer the higher-magnitude enabled modifier for a given slug.
    const bySlug = modifiers.reduce((result, modifier) => {
      const existing = result[modifier.slug];
      if ( !existing?.enabled || (Math.abs(modifier.value) > Math.abs(existing.value)) ) {
        result[modifier.slug] = modifier;
      }
      return result;
    }, {});
    const deduplicated = Object.values(bySlug);

    this.modifiers = deduplicated;
    this.applied = applyStackingRules(deduplicated.filter(m => m.enabled));
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
