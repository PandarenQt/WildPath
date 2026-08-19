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
        threat: new NumberField({required: true, integer: true, initial: 1, min: 0})
      })
    };
  }
}
