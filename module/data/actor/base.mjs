import {WILDPATH} from "../../config.mjs";
import {resourceField, poolsField} from "../fields.mjs";
import {computeResourceMax, clampResourceValue} from "../../helpers/resources.mjs";

const {SchemaField, NumberField, HTMLField} = foundry.data.fields;

/**
 * Shared data schema, derived-data preparation, and helper methods used by every Actor
 * sub-type in the WildPath system (character, npc, ...).
 *
 * Ability keys are fixed at the schema level (mirrors dnd5e/crucible): CONFIG.WILDPATH.ABILITIES
 * only controls labels/ordering for existing keys. Adding a wholly new ability requires extending
 * this schema (documented here as a known follow-up rather than solved generically), whereas
 * *resources* (see `pools`) and *modifiers* are fully data-driven and need no schema changes.
 */
export default class WildPathBaseActor extends foundry.abstract.TypeDataModel {

  /** @inheritDoc */
  static defineSchema() {
    const abilitySchema = () => new SchemaField({
      value: new NumberField({required: true, integer: true, initial: 10, min: 0})
    });
    const abilities = {};
    for ( const key of Object.keys(WILDPATH.ABILITIES) ) abilities[key] = abilitySchema();

    return {
      biography: new HTMLField({required: true, blank: true}),
      abilities: new SchemaField(abilities),
      resources: new SchemaField({
        health: resourceField({initial: 10, recovery: "none"}),
        action: resourceField({initial: 1, recovery: "turn"}),
        bonus: resourceField({initial: 1, recovery: "turn"}),
        reaction: resourceField({initial: 1, recovery: "turn"}),
        movement: resourceField({initial: 30, recovery: "turn"})
      }),
      pools: poolsField(),
      status: new SchemaField({
        turnsTaken: new NumberField({required: true, integer: true, initial: 0, min: 0})
      })
    };
  }

  /* -------------------------------------------- */
  /*  Data Preparation                             */
  /* -------------------------------------------- */

  /** @inheritDoc */
  prepareBaseData() {
    super.prepareBaseData();
    // `bonus` is a persisted/manual value; `modifierBonus` is a transient, per-cycle property
    // (not part of the schema) recomputed fresh in #applyResourceModifiers every prepare pass.
    for ( const resource of Object.values(this.resources) ) {
      resource.bonus ??= 0;
      resource.modifierBonus = 0;
    }
    for ( const pool of this.pools ) {
      pool.bonus ??= 0;
      pool.modifierBonus = 0;
    }
  }

  /* -------------------------------------------- */

  /** @inheritDoc */
  prepareDerivedData() {
    super.prepareDerivedData();
    this.#applyResourceModifiers();
    this.#finalizeResources();
  }

  /* -------------------------------------------- */

  /**
   * Collect modifiers targeting each resource's max value from Items/ActiveEffects (via the
   * PF2e-style `Actor#getStatistic` domain lookup) into the transient `modifierBonus` property.
   * Always *assigns* (never accumulates) so this stays idempotent across repeated prepare passes
   * - Foundry does not guarantee `prepareDerivedData()` runs only once per update, and `+=` onto
   * a field here would silently inflate `max` the more times preparation happens to run.
   */
  #applyResourceModifiers() {
    for ( const id of Object.keys(this.resources) ) {
      this.resources[id].modifierBonus = this.parent.getStatistic?.(`resources.${id}.max`)?.totalModifier ?? 0;
    }
    for ( const pool of this.pools ) {
      pool.modifierBonus = this.parent.getStatistic?.(`pools.${pool.id}.max`)?.totalModifier ?? 0;
    }
  }

  /* -------------------------------------------- */

  /**
   * Compute final max values and clamp current values within [0, max] for every resource pool,
   * built-in and custom alike. Delegates the actual math to the pure, unit-tested helpers in
   * helpers/resources.mjs so the same idempotent computation is verifiable outside Foundry.
   */
  #finalizeResources() {
    for ( const resource of Object.values(this.resources) ) {
      resource.max = computeResourceMax(resource, resource.modifierBonus);
      resource.value = clampResourceValue(resource.value, resource.max);
    }
    for ( const pool of this.pools ) {
      pool.max = computeResourceMax(pool, pool.modifierBonus);
      pool.value = clampResourceValue(pool.value, pool.max);
    }
  }

  /* -------------------------------------------- */
  /*  Helpers                                      */
  /* -------------------------------------------- */

  /**
   * Retrieve a resource pool (built-in or custom) by id.
   * @param {string} id
   * @returns {{base: number, bonus: number, max: number, value: number, recovery: string}|null}
   */
  getResource(id) {
    if ( id in this.resources ) return this.resources[id];
    return this.pools.find(p => p.id === id) ?? null;
  }
}
