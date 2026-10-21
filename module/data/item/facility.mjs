import WildPathBaseItem from "./base.mjs";

const {NumberField, SchemaField, StringField} = foundry.data.fields;

/** The orders a special facility may be issued (2024 DMG), "maintain" being none. */
export const FACILITY_ORDERS = Object.freeze(["maintain", "craft", "empower", "harvest", "recruit", "research", "trade"]);

/**
 * A Bastion facility (2024 DMG, 2026-10-22), kept by its character: a basic one (a Bedroom, a Kitchen) or a special one
 * the character gains from level 5 (an Arcane Study), with the order it takes (`order`) and the one it was issued for
 * this Bastion turn (`current.order`). applications/bastions.mjs runs Bastion turns.
 */
export default class WildPathFacility extends WildPathBaseItem {
  /** @inheritDoc */
  static defineSchema() {
    return {
      ...super.defineSchema(),
      kind: new StringField({required: true, initial: "special", choices: ["basic", "special"]}),
      level: new NumberField({required: true, integer: true, initial: 5, min: 0}),
      size: new StringField({required: true, blank: true, initial: ""}),
      hirelings: new NumberField({required: true, integer: true, initial: 0, min: 0}),
      order: new StringField({required: true, blank: true, initial: ""}),
      current: new SchemaField({order: new StringField({required: true, initial: "maintain", choices: FACILITY_ORDERS})})
    };
  }
}
