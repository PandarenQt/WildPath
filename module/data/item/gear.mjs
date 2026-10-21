import WildPathBaseItem from "./base.mjs";

const {BooleanField, HTMLField, NumberField, SchemaField, StringField} = foundry.data.fields;

/**
 * Physical equipment. Reuses the base `active` field to represent "equipped".
 */
export default class WildPathGear extends WildPathBaseItem {

  /** @inheritDoc */
  static defineSchema() {
    return {
      ...super.defineSchema(),
      quantity: new NumberField({required: true, integer: true, initial: 1, min: 0}),
      weight: new NumberField({required: true, initial: 0, min: 0}),
      slot: new StringField({required: true, blank: true}),
      // A magic item that needs attunement gives nothing until attuned: "" (none needed), "required", "attuned".
      attunement: new StringField({required: true, blank: true, initial: "", choices: ["", "required", "attuned"]}),
      // Armor's kind, which a character's armor training must name (G8): worn untrained, it hinders; a Shield protects not.
      armor: new StringField({required: true, blank: true, initial: "", choices: ["", "light", "medium", "heavy", "shield"]}),
      // Its price in gold, and a magic item's rarity (crafting and buying: helpers/crafting.mjs).
      price: new NumberField({required: false, initial: 0, min: 0}),
      rarity: new StringField({required: false, blank: true, initial: ""}),
      // A magic item not yet identified: its players see only what it looks like (documents/item.mjs). The GM decides.
      identified: new BooleanField({required: false, initial: true}),
      unidentified: new SchemaField({
        name: new StringField({required: false, blank: true, initial: ""}),
        description: new HTMLField({required: false, blank: true, initial: ""})
      }, {required: false})
    };
  }

  /**
   * Convenience alias: for gear, "active" reads as "equipped".
   * @type {boolean}
   */
  get equipped() {
    return this.active;
  }
}
