import WildPathBaseActor from "./base.mjs";
import {resourceField} from "../fields.mjs";
import {trainingRuleElements} from "../../helpers/level-up.mjs";

const {SchemaField, NumberField, StringField, ArrayField} = foundry.data.fields;

/** What a creature aboard a vehicle is: crew use its Actions (their `requires` read `aboard.crew`), passengers ride. */
export const ABOARD_ROLES = Object.freeze(["crew", "passenger"]);

/**
 * Data model for "vehicle" Actors (vehicles-and-mythic.md, owner's Q6): a ship or the Apparatus of the Crab. It keeps the
 * shapes the rules already read (`defenses.ac`, `resources.health`, `resources.movement` as its combat Speed) and none of a
 * creature's: no ability scores, saves, skills, classes or death saves. It has no turn; a creature aboard as crew uses its
 * Actions at that creature's own cost (`controllerCosts`).
 */
export default class WildPathVehicle extends WildPathBaseActor {

  /** @inheritDoc */
  static defineSchema() {
    const {biography, defenses, pools} = super.defineSchema();
    const names = () => new ArrayField(new StringField({required: true, blank: false}));
    const count = () => new NumberField({required: true, integer: true, initial: 0, min: 0});
    return {
      biography, defenses, pools,
      resources: new SchemaField({
        // Its Hit Points with its Damage Threshold, which its damage adjustment profile reads (actor.mjs getDamageProfile).
        health: resourceField({initial: 1, recovery: "none", threshold: true}),
        movement: resourceField({initial: 0, recovery: "turn", counted: true})
      }),
      // Its overland Speed in miles per hour (the journey tool's, never the grid's).
      travelSpeed: new NumberField({required: true, initial: 0, min: 0}),
      // How many crew and passengers it carries, and its cargo in tons.
      capacity: new SchemaField({crew: count(), passengers: count(), cargo: new NumberField({required: true, initial: 0, min: 0})}),
      // Damage types and conditions it is immune to (a ship's Poison and Psychic, Blinded to Unconscious).
      immunities: new SchemaField({damage: names(), conditions: names()}),
      // The creatures aboard, by Actor uuid, each with its role.
      aboard: new ArrayField(new SchemaField({
        actorUuid: new StringField({required: true, blank: false}),
        role: new StringField({required: true, initial: "crew", choices: ABOARD_ROLES})
      }))
    };
  }

  /**
   * The rules its own data gives it, read with its Items' (actor.mjs grantOwners, getStatistic): its immunities, and a deck
   * creatures stand on and walk about (`occupancy.share`: neither its riders nor it block one another's moves).
   */
  get ownRules() {
    return [...trainingRuleElements([...this.immunities.damage.map(type => `di:${type}`),
      ...this.immunities.conditions.map(id => `ci:${id}`)]),
    {schemaVersion: 1, id: "vehicle-deck", type: "Modifier", data: {domains: ["occupancy.share"], modifierType: "untyped", value: 1}}];
  }
}
