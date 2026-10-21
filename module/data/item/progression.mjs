import WildPathBaseItem from "./base.mjs";
import {SPELLCASTING_PROGRESSIONS} from "../../helpers/spellcasting.mjs";

const {ArrayField, BooleanField, NumberField, ObjectField, SchemaField, StringField} = foundry.data.fields;

/**
 * What an Item gives by level (G8, classes-and-spellcasting.md): entries `{level, type, ...}` of the advancement types
 * the level-up dialog applies (features granted, a choice of features, skills and training, an ability increase or
 * feat, a subclass). Plain data: the level-up dialog reads it.
 */
const advancementField = () => new ArrayField(new ObjectField({required: true, initial: () => ({})}));
const identifierField = () => new StringField({required: true, blank: true, initial: ""});
const spellcastingField = () => new SchemaField({
  progression: new StringField({required: true, initial: SPELLCASTING_PROGRESSIONS.NONE, choices: Object.values(SPELLCASTING_PROGRESSIONS)}),
  ability: new StringField({required: true, blank: true, initial: ""}),
  // How many spells it prepares at each level of its class (2024 class tables; index 0 is level 1).
  prepared: new ArrayField(new NumberField({required: true, integer: true, min: 0}))
});

/** A class (2024): its levels on this creature, its Hit Die, its spellcasting, and what each level gives. */
export class WildPathClass extends WildPathBaseItem {
  /** @inheritDoc */
  static defineSchema() {
    return {
      ...super.defineSchema(),
      identifier: identifierField(),
      levels: new NumberField({required: true, integer: true, initial: 1, min: 1, max: 20}),
      hitDie: new NumberField({required: true, integer: true, initial: 8, choices: [6, 8, 10, 12]}),
      // The class it started with (its level-1 class), whose proficiencies and spellcasting ability come first.
      original: new BooleanField({required: true, initial: false}),
      // Its primary abilities: multiclassing into or out of it wants 13 in all of them (`all`) or in one (a warning).
      primaryAbility: new SchemaField({
        abilities: new ArrayField(new StringField({required: true, blank: false})),
        all: new BooleanField({required: true, initial: true})
      }),
      spellcasting: spellcastingField(),
      advancement: advancementField()
    };
  }
}

/**
 * A subclass of one class (`classIdentifier`), and what each of that class's levels gives through it. A third caster's
 * spellcasting is its subclass's (Eldritch Knight, Arcane Trickster); for any other it stays "none".
 */
export class WildPathSubclass extends WildPathBaseItem {
  /** @inheritDoc */
  static defineSchema() {
    return {...super.defineSchema(), identifier: identifierField(), classIdentifier: identifierField(), advancement: advancementField(),
      spellcasting: spellcastingField()};
  }
}

/** A species (2024): its size and what it gives at level 1. */
export class WildPathSpecies extends WildPathBaseItem {
  /** @inheritDoc */
  static defineSchema() {
    return {...super.defineSchema(), identifier: identifierField(),
      size: new StringField({required: true, initial: "medium", choices: ["tiny", "small", "medium", "large", "huge", "gargantuan"]}),
      advancement: advancementField()};
  }
}

/** A background (2024): its ability increases, skills and training, and origin feat. */
export class WildPathBackground extends WildPathBaseItem {
  /** @inheritDoc */
  static defineSchema() {
    return {...super.defineSchema(), identifier: identifierField(), advancement: advancementField()};
  }
}
