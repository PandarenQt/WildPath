import WildPathBaseItem from "./base.mjs";

const {ArrayField, ObjectField} = foundry.data.fields;

/**
 * A passive trait, talent, or feature. A feat may give choices when taken (`advancement`, as a class's at level 0:
 * Eldritch Adept's Invocation, Metamagic Adept's two options), which the level-up dialog asks.
 */
export default class WildPathFeature extends WildPathBaseItem {
  /** @inheritDoc */
  static defineSchema() {
    return {...super.defineSchema(), advancement: new ArrayField(new ObjectField({required: true, initial: () => ({})}))};
  }
}
