import {modifiersField, ruleElementsField} from "../fields.mjs";

const {NumberField} = foundry.data.fields;

/**
 * Shared schema for every ActiveEffect sub-type in the WildPath system.
 * Adds a declarative `modifiers` array so effects (buffs, debuffs, spells) can contribute
 * to derived values using the same mechanism as Item modifiers (see data/item/base.mjs and
 * helpers/modifiers.mjs), in addition to whatever is expressed via core `changes`.
 */
export default class WildPathBaseEffect extends foundry.data.ActiveEffectTypeDataModel {

  /** @inheritDoc */
  static defineSchema() {
    const schema = super.defineSchema();
    schema.modifiers = modifiersField();
    schema.ruleElements = ruleElementsField();
    // How many of it there are, for a custom effect that counts down (Mirror Image's duplicates); null for the rest.
    schema.level = new NumberField({nullable: true, integer: true, initial: null, min: 1});
    return schema;
  }
}
