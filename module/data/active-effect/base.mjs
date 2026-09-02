import {modifiersField, ruleElementsField} from "../fields.mjs";

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
    return schema;
  }
}
