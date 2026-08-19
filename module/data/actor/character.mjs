import WildPathBaseActor from "./base.mjs";

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
}
