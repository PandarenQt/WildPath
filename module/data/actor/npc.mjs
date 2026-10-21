import WildPathBaseActor from "./base.mjs";

const {NumberField} = foundry.data.fields;

/**
 * Data model for GM-controlled "npc" Actors.
 */
export default class WildPathNPC extends WildPathBaseActor {

  /** @inheritDoc */
  static defineSchema() {
    return {
      ...super.defineSchema(),
      details: new foundry.data.fields.SchemaField({
        // Its Challenge Rating, fractions included (1/8, 1/4, 1/2).
        threat: new NumberField({required: true, initial: 1, min: 0})
      })
    };
  }
}
