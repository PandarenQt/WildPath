import WildPathBaseActor from "./base.mjs";
import {WILDPATH} from "../../config.mjs";

const {StringField, NumberField} = foundry.data.fields;

/**
 * Data model for player-controlled "character" Actors.
 */
export default class WildPathCharacter extends WildPathBaseActor {

  /** @inheritDoc */
  static defineSchema() {
    return {
      ...super.defineSchema(),
      details: new foundry.data.fields.SchemaField({
        ancestry: new StringField({required: true, blank: true}),
        background: new StringField({required: true, blank: true}),
        level: new NumberField({required: true, integer: true, initial: 1, min: 1})
      })
    };
  }

  /**
   * A character keeps its Heroic Inspiration points in a pool of up to 4 (G8, BG3). The checkbox it replaced counts
   * as one point.
   */
  static migrateData(source, options) {
    const {pool: id, max} = WILDPATH.HEROIC_INSPIRATION;
    // A new character (not a partial update) gets the pool from the start.
    if ( !options?.partial ) source.pools ??= [];
    if ( Array.isArray(source.pools) && !source.pools.some(pool => pool?.id === id) ) {
      const label = globalThis.game?.i18n?.localize?.("WILDPATH.SHEET.HeroicInspiration");
      source.pools.push({id, label: (label && (label !== "WILDPATH.SHEET.HeroicInspiration")) ? label : "Heroic Inspiration",
        base: max, bonus: 0, max, value: source.heroicInspiration === true ? 1 : 0, recovery: "none"});
    }
    delete source.heroicInspiration;
    return super.migrateData(source, options);
  }
}
