import WildPathBaseItem from "./base.mjs";

const {NumberField, StringField} = foundry.data.fields;

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
      slot: new StringField({required: true, blank: true})
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
