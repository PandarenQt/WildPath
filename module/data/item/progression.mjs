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
      spellcasting: new SchemaField({
        progression: new StringField({required: true, initial: SPELLCASTING_PROGRESSIONS.NONE, choices: Object.values(SPELLCASTING_PROGRESSIONS)}),
        ability: new StringField({required: true, blank: true, initial: ""})
      }),
      advancement: advancementField()
    };
  }
}

/** A subclass of one class (`classIdentifier`), and what each of that class's levels gives through it. */
export class WildPathSubclass extends WildPathBaseItem {
  /** @inheritDoc */
  static defineSchema() {
    return {...super.defineSchema(), identifier: identifierField(), classIdentifier: identifierField(), advancement: advancementField()};
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
