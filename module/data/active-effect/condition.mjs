import WildPathBaseEffect from "./base.mjs";
import {dotField} from "../fields.mjs";
import {WILDPATH} from "../../config.mjs";

const {StringField, NumberField, ArrayField} = foundry.data.fields;

/**
 * System data model for "condition"-type ActiveEffects (statuses like Prone, Stunned,
 * Exhaustion, Poisoned...). Mirrors dnd5e's leveled-condition pattern: `type` identifies which
 * condition config entry (CONFIG.WILDPATH.CONDITIONS) this effect represents, and `level`
 * (nullable) tracks stacks for conditions flagged `stacking: true` (e.g. Exhaustion).
 * `dot` carries any damage/healing-over-time payload, normally populated from the condition's
 * `generator()` function when the effect is first applied.
 */
export default class WildPathConditionEffect extends WildPathBaseEffect {

  /** @inheritDoc */
  static defineSchema() {
    return {
      ...super.defineSchema(),
      type: new StringField({required: true, blank: false}),
      level: new NumberField({nullable: true, integer: true, initial: null, min: 1}),
      dot: new ArrayField(dotField())
    };
  }

  /* -------------------------------------------- */

  /**
   * Does the given condition type support numeric stacking levels?
   * @param {string} type
   * @returns {boolean}
   */
  static hasLevels(type) {
    return !!WILDPATH.CONDITIONS[type]?.stacking;
  }

  /** @type {boolean} */
  get hasLevels() {
    return this.constructor.hasLevels(this.type);
  }

  /** @type {number|null} */
  get maxLevel() {
    return this.hasLevels ? (WILDPATH.CONDITIONS[this.type]?.maxLevel ?? Infinity) : null;
  }

  /* -------------------------------------------- */

  /**
   * The display name for this condition at its current level (e.g. "Exhaustion (3)"), for use by
   * sheets/tooltips/UI. Purely computed from `type`/`level` - never mutates the parent document.
   * @type {string}
   */
  get displayName() {
    const label = game.i18n.localize(WILDPATH.CONDITIONS[this.type]?.name ?? this.type);
    return this.hasLevels ? `${label} (${this.level})` : label;
  }

  /* -------------------------------------------- */

  /** @inheritDoc */
  prepareDerivedData() {
    super.prepareDerivedData();
    // Level clamping is pure derived state on this data model; it must NOT also mutate
    // `this.parent.name` here; data preparation can run more than once per update and mutating
    // Document fields mid-preparation is unsafe. The persisted name is instead kept in sync
    // explicitly by `applyDelta` whenever the level actually changes (see below).
    this.level = this.hasLevels ? Math.clamp(this.level ?? 1, 1, this.maxLevel) : null;
  }

  /* -------------------------------------------- */

  /**
   * Increase (or decrease, with a negative value) the level of this condition, creating or
   * deleting the underlying ActiveEffect as required. Mirrors dnd5e's ConditionData#_applyDelta.
   * @param {string} type                 The condition identifier.
   * @param {import("../../documents/actor.mjs").default} actor
   * @param {number} [levels=1]           The signed change in levels.
   * @returns {Promise<ActiveEffect|null>}
   */
  static async applyDelta(type, actor, levels=1) {
    const existing = actor.effects.find(e => (e.type === "condition") && (e.system.type === type));

    if ( !WILDPATH.CONDITIONS[type]?.stacking ) {
      if ( levels > 0 ) return existing ?? actor.toggleStatusEffect(type, {active: true});
      if ( existing ) await existing.delete();
      return null;
    }

    if ( existing ) {
      const rawLevel = (existing.system.level ?? 1) + levels;
      if ( rawLevel <= 0 ) {
        await existing.delete();
        return null;
      }
      const level = this.#clampLevelFor(type, rawLevel);
      await existing.update({"system.level": level, name: this.#displayNameFor(type, level)});
      return existing;
    }

    if ( levels <= 0 ) return null;
    const level = this.#clampLevelFor(type, levels);
    const effect = await actor.toggleStatusEffect(type, {active: true});
    if ( effect ) await effect.update({"system.level": level, name: this.#displayNameFor(type, level)});
    return effect;
  }

  /* -------------------------------------------- */

  /**
   * Compute the leveled display name for a condition type ("Exhaustion (3)"), used to persist
   * the ActiveEffect's `name` only at the moment its level actually changes (see `applyDelta`),
   * rather than mutating it on every derived-data preparation pass.
   * @param {string} type
   * @param {number} level
   * @returns {string}
   */
  static #displayNameFor(type, level) {
    const label = game.i18n.localize(WILDPATH.CONDITIONS[type]?.name ?? type);
    return `${label} (${level})`;
  }

  /* -------------------------------------------- */

  /**
   * Clamp a stacking condition level before persisting it, keeping stored level and displayed
   * name in sync with the same bounds used during data preparation.
   * @param {string} type
   * @param {number} level
   * @returns {number}
   */
  static #clampLevelFor(type, level) {
    const max = WILDPATH.CONDITIONS[type]?.maxLevel ?? Infinity;
    return Math.min(Math.max(level, 1), max);
  }
}
