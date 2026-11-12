/**
 * Convert dnd5e (6.x) documents from the 2024 SRD (SRD 5.2, CC-BY-4.0) into WildPath source documents.
 *
 * - Only a document whose own `system.source` says `license: "CC-BY-4.0"` and `rules: "2024"` is converted.
 * - Spells, weapons and features become Action Items, one per activity. An item's uses become a resource pool its
 *   Action spends (`GrantResource`).
 * - Something a creature uses that WildPath cannot automate is a manual Action: using it spends its cost (an
 *   Action, a Reaction, a spell slot) and its description says the rest. A passive ability is a feature item.
 * - Descriptions are the source's own text, copied as placeholders (maintainer decision; AGENTS §22 forbids only
 *   generated prose), with dnd5e's enrichers resolved against the document's data.
 * - What WildPath cannot automate is listed in `flags.wildpath.conversion.notes`. It is never approximated.
 */

import {parseFormula} from "../../module/helpers/formula.mjs";
import {evaluateValueExpression} from "../../module/helpers/value-expressions.mjs";
import {commonAction} from "../../module/helpers/common-actions.mjs";

/** dnd5e ability keys to WildPath's. */
export const ABILITY_MAP = Object.freeze({str: "might", dex: "agility", con: "fortitude", int: "intellect", wis: "wits", cha: "presence"});
/**
 * The conditions an Item's text gives on a failed save: 2024 "On a failed save, a creature has the Prone condition",
 * "Failure: The target has the Charmed condition"; 2014 "or become frightened for 1 minute", with how long the 2014
 * wording says (`duration`, when every one says the same). Not one put on its user ("on you").
 */
function failedSaveOutcome(document, {onHit=false}={}) {
  const found = new Set();
  const durations = new Set();
  const levels = {};
  const text = plainText(document).replace(/&amp;Reference\[(\w+)[^\]]*\]/g, "$1");
  // An attack's: those its hit gives ("Hit: The target has the Grappled condition (escape DC 15)").
  const outcome = onHit ? /\bhit:/i : /on a failed save|failure:|saving throw,?(?: \([^)]*\))? or (?:the target )?(?:have|has|be|become|gain)\b/i;
  for ( const sentence of text.split(/(?<=[.!?])\s+/) ) {
    if ( !outcome.test(sentence) || /\bon you\b/i.test(sentence) ) continue;
    for ( const match of sentence.matchAll(/\b(?:(?:has|have) the (\w+) condition|(?:be|becomes?) (\w+)(?= for\b| until\b|[.,;]))/gi) ) {
      const [, named, plain] = match;
      const condition = CONDITION_MAP[String(named ?? plain).toLowerCase()];
      if ( !condition ) continue;
      found.add(condition);
      // 2014 "become frightened for 1 minute" anywhere in its sentence; 2024 "have the Poisoned condition for 1 minute" right after.
      const lasting = plain ? /\bfor (\d+|one) (round|minute|hour)s?\b/i.exec(sentence)
        : /^ for (\d+|one) (round|minute|hour)s?\b/i.exec(sentence.slice(match.index + match[0].length));
      durations.add(lasting ? `${Number(lasting[1]) || 1}:${LASTING_UNITS[lasting[2].toLowerCase()]}` : "");
    }
    // "or gain 1 Exhaustion level" (a Ring of X-ray Vision's): that many levels.
    const exhaustion = /\bor gains? (\d+) Exhaustion levels?\b/i.exec(sentence);
    if ( exhaustion ) {
      found.add("exhaustion");
      levels.exhaustion = Number(exhaustion[1]);
      durations.add("");
    }
  }
  // "The creature also has the Paralyzed condition while Poisoned in this way" (Crawler Mucus): it comes with the other.
  // shortcut: two effects, so ending the first early (Lesser Restoration) leaves the second; upgrade when an effect can
  // end with another's.
  for ( const [, extra, carrier] of text.matchAll(/\balso (?:has|have) the (\w+) condition while (\w+) in this way\b/gi) ) {
    if ( found.has(CONDITION_MAP[carrier.toLowerCase()]) && CONDITION_MAP[extra.toLowerCase()] ) found.add(CONDITION_MAP[extra.toLowerCase()]);
  }
  const [only] = durations.size === 1 ? [...durations] : [""];
  const [value, units] = (only ?? "").split(":");
  return {conditions: [...found], ...(Object.keys(levels).length ? {levels} : {}), ...(units ? {duration: {value: Number(value), units}} : {})};
}

/**
 * Saves whose failure only tells its caster something or hides it (2024 Scrying, Detect Thoughts' probe, Seeming,
 * Light on a held object): the marker on those that fail, for as long as it lasts, is all there is to automate.
 */
const NARRATIVE_SAVES = new Set(["scrying", "detect-thoughts", "seeming", "light", "read-thoughts", "crystal-ball", "crystal-ball-of-mind-reading",
  "crystal-ball-of-telepathy", "crystal-ball-of-true-seeing", "helm-of-telepathy", "medallion-of-thoughts", "potion-of-mind-reading",
  // A Sprite's Heart Sight (emotions and alignment); a creature sent off the Scene (Plane Shift's precedent: it leaves): an
  // Iron Flask's prisoner, Dispel Evil and Good's Dismissal; Reverse Gravity's upward fall (heights are not tracked).
  "heart-sight", "iron-flask", "dispel-evil-and-good", "reverse-gravity"]);

/**
 * Saves whose failure the conditions its text gives (failedSaveOutcome) are all of, with their duration, size limit,
 * escape DC, repeated save and Exhaustion levels: nothing of them is by hand. Not a Net: its own AC and Hit Points
 * (destroying it frees its creature) are by hand, so its note stays until objects are modelled.
 */
const FAILURE_TEXT_COMPLETE = new Set(["crawler-mucus", "ring-of-x-ray-vision", "grasping-hand",
  // Its Difficult Terrain and its repeat on entering or ending a turn there are its lasting area's (lastingArea).
  "grease"]);

/** The sizes of creatures, smallest first. */
const CREATURE_SIZES = ["tiny", "small", "medium", "large", "huge", "gargantuan"];

/**
 * The largest creature its failed save's conditions take: "grapple a Huge or smaller creature"; "The target succeeds
 * automatically if it is Huge or larger" (a Net) is one size smaller. Null when its text sets none.
 */
function sizeLimitOf(document) {
  const text = plainText(document);
  const smaller = /\b(Tiny|Small|Medium|Large|Huge) or smaller creature\b/i.exec(text);
  if ( smaller ) return smaller[1].toLowerCase();
  const larger = /\bsucceeds automatically if it is (Small|Medium|Large|Huge|Gargantuan) or larger\b/i.exec(text);
  return larger ? CREATURE_SIZES[CREATURE_SIZES.indexOf(larger[1].toLowerCase()) - 1] : null;
}

/**
 * What a summoned creature's feature costs its summoner instead of itself: dnd5e's activation condition "Bonus Action used
 * by summoner", or its text's "As a Bonus Action, you can move the eye up to 30 feet" (you: the summoner). `{capability,
 * feet}` (feet: how far it moves, when it says), or null.
 */
function summonerPaid(document, activity) {
  const used = /\bused by (?:its |the )?summoner\b/i.test(activity.activation?.condition ?? "");
  const move = /\bAs an? (Bonus Action|Magic action|action), you can move the [^.]*?\bup to (\d+) feet\b/i.exec(plainText(document));
  if ( !used && !move ) return null;
  const type = used ? activity.activation?.type : (/bonus/i.test(move[1]) ? "bonus" : "action");
  return {capability: (type === "bonus") ? "bonus-action" : "action", feet: move ? Number(move[2]) : null};
}

/** An ability by its name in a dnd5e activity's name (dnd5e's "Activate Sword: Stength" too). */
const ABILITY_WORDS = Object.freeze({str: /\bStr?ength\b/i, dex: /\bDexterity\b/i, con: /\bConstitution\b/i, int: /\bIntelligence\b/i,
  wis: /\bWisdom\b/i, cha: /\bCharisma\b/i});

/** The save a "coat the blade with poison" enchantment applies on its next hit (a Dagger of Venom's Poison Save), or null. */
const coatingSave = (document, activities) => ((/\bcoat (?:the|its) blade with poison\b/iu.test(plainText(document))
  && activities.some(entry => entry.type === "enchant")) ? (activities.find(entry => entry.type === "save") ?? null) : null);

/** A save whose failure is narrative: by its document (NARRATIVE_SAVES) or its activity's dnd5e name (NARRATIVE_ACTIVITIES). */
const narrativeSave = (document, activity) => NARRATIVE_SAVES.has(identifierOf(document)) || NARRATIVE_ACTIVITIES.has(activity?.name ?? "");

/**
 * A stat block's "Failure by 5 or More:" section (2024 Homunculus, Pseudodragon): the conditions only it names (not the
 * plain "Failure:" one's), how long they last (its own "for 1 minute", else the plain failure's), and whether they end
 * early when the target takes damage. Null when there is no such section.
 */
export function failureByMargin(raw) {
  const text = String(raw ?? "").replace(/&(?:amp;)?Reference\[(\w+)[^\]]*\]/gu, "$1");
  const found = /Failure by (\d+) or More:\s*(.*?)(?=\b(?:Success|Failure|Hit|Miss|Trigger|Response)\b[^:.]{0,20}:|$)/iu.exec(text);
  if ( !found ) return null;
  const base = /\bFailure:\s*(.*?)(?=Failure by|$)/iu.exec(text)?.[1] ?? "";
  const named = section => new Set([...section.matchAll(/\bthe (\w+) condition\b/giu)].map(match => CONDITION_MAP[match[1].toLowerCase()])
    .filter(Boolean));
  const inBase = named(base);
  const lasting = /\bfor (\d+|one) (round|minute|hour)s?\b/iu.exec(found[2]) ?? /\bfor (\d+|one) (round|minute|hour)s?\b/iu.exec(base);
  return {by: Number(found[1]), only: [...named(found[2])].filter(condition => !inBase.has(condition)),
    duration: lasting ? {value: Number(lasting[1]) || 1, units: LASTING_UNITS[lasting[2].toLowerCase()]} : null,
    endsOnDamage: /\bends early if the target takes (?:any )?damage\b/iu.test(found[2])};
}

/** dnd5e's duration units, as WildPath's. */
const LASTING_UNITS = Object.freeze({turn: "turns", round: "rounds", minute: "minutes", hour: "hours", day: "days", month: "months",
  year: "years"});

/** How long a spell or feature lasts ("1 minute"), or null when it is instantaneous, permanent or special. */
function lastingDuration(duration) {
  const value = number(duration?.value);
  const units = LASTING_UNITS[duration?.units];
  return (units && (value > 0)) ? {value, units} : null;
}

/**
 * Spells whose failed save transforms the creature (2024 Polymorph): every statistic of the Beast's stat block (its
 * abilities, AC and Speed), none of its own Items, and the Beast's Hit Points as Temporary Hit Points, until they are
 * gone. Its caster chooses the Beast; the authority refuses one above the creature's Challenge Rating or level.
 */
const TRANSFORM_ON_FAILURE = Object.freeze({
  polymorph: {takes: ["abilities.might.value", "abilities.agility.value", "abilities.fortitude.value", "abilities.intellect.value",
    "abilities.wits.value", "abilities.presence.value", "defenses.ac.value", "resources.movement.base"], keepItemTypes: [],
  temporaryHealth: "form"}
});

/**
 * Spells that transform their caster (2024 Shapechange): into one of the converted creatures but those of the types it
 * excludes, of a Challenge Rating no higher than the caster's level or Challenge Rating (refused before anything is paid).
 * The caster keeps its Intelligence, Wisdom and Charisma (the default form statistics) and its spellcasting, gains the form's
 * Hit Points as Temporary Hit Points, which vanish when it ends (it does not end when they are gone), and concentrates on it
 * for up to its hour. shortcut: shape-shifting into another form with a Magic action during the spell is a recast, which
 * costs a caster with slots another slot; upgrade when a spell's follow-up Action can transform.
 */
const SELF_TRANSFORM = Object.freeze({
  shapechange: {temporaryHealth: "form", untilTemporaryHealthLost: false, concentration: true, keepsSpellcasting: true,
    limits: {challenge: "self"}, duration: {value: 1, units: "hours"}, excludeTypes: ["construct", "undead"]}
});

/**
 * The creatures a transformation may choose from, by their dnd5e creature documents: `{uuid, name, cr, type}` (its creature
 * type: Polymorph's and Wild Shape's are the Beasts), weakest first. Not a spell's or an item's own stat block, which has no
 * creature type of its own ("custom": an Arcane Eye, a Carpet of Flying, an illusion) or no Challenge Rating (a summon
 * whose statistics scale with its spell: Draconic Spirit, Find Steed's steeds, Giant Insect, the Animated Objects).
 */
export function creatureFormsOf(documents, uuidOf) {
  return documents.filter(document => (document.type === "npc") && (document.system?.details?.cr != null)
    && !["", "custom"].includes(document.system?.details?.type?.value ?? ""))
    .map(document => ({uuid: uuidOf(document), name: document.name, cr: number(document.system?.details?.cr) ?? 0,
      type: document.system?.details?.type?.value ?? ""}))
    .sort((a, b) => (a.cr - b.cr) || a.name.localeCompare(b.name));
}

/**
 * A spell with no Verbal, Somatic or Material component (`component:none`, as a Subtle one is) can't be countered; any
 * other spell can, a homebrew one whose components aren't tagged included.
 */
const UNCOUNTERABLE = "component:none";

/**
 * "A creature you can see within `feet` feet": the event's source, hostile to the reactor (the maintainer's choice:
 * no prompt on an ally's spell or hit), seen by it (senses, light, walls: relationsToSource).
 */
const seenHostileWithin = feet => ({all: [{equals: {path: "toSource.{self}.sees", value: true}},
  {equals: {path: "toSource.{self}.hostile", value: true}}, {atMost: {path: "toSource.{self}.distance", value: feet}}]});
/** The creature its event damages (`toTarget`, from that creature; itself included as `self`) is within `feet` and seen. */
const seenTargetWithin = feet => [{equals: {path: "toTarget.{self}.sees", value: true}}, {atMost: {path: "toTarget.{self}.distance", value: feet}}];
/** 2024 Deflect Attacks' reduction: 1d10 + its Dexterity modifier + its monk level. */
const DEFLECTION = Object.freeze({dice: {type: "dice", number: 1, faces: 10}, bonus: {type: "add", terms: [
  {type: "ability-modifier", ability: "agility"}, {type: "class-level", class: "monk"}]}});

/**
 * What hitting its creature with a melee attack costs the attacker (2024 Black Pudding's Corrosive Form: "A creature that
 * hits the pudding with a melee attack roll takes 4 (1d8) Acid damage"; an Azer's Heated Body, "touches ... or hits it
 * with a melee attack"): its damage on the attacker, at once, whenever such an attack hits. shortcut: "while within 5
 * feet of it" is not measured (a reach weapon's hit counts too), and touching it is the GM's.
 */
const RETALIATION_TEXT = /\b(?:a|any) creature that (?:touches [^.]{0,60}? or )?hits (?:it|the [^.,]{1,40}?|[^.,]{1,40}?) with a melee attack\b[^.]*\btakes\b/iu;
const RETALIATION = Object.freeze({event: "attack.hit", match: {phase: "interrupt", targetTokenId: "{self}", tagsAny: ["melee"]}});
/** Its answering Action: no cost, at the attacker. */
const RETALIATION_ACTION = Object.freeze({costs: {allOf: []}, range: {type: "special"}, targeting: {type: "single", required: true, count: 1}});
/**
 * The same hit answered by an effect on the creature hit, while it lasts (carriedRetaliation): 2024 Fire Shield's "whenever
 * a creature within 5 feet of you hits you with a melee attack roll", Armor of Agathys' "If a creature hits you with a melee
 * attack roll", Holy Aura's "when a Fiend or an Undead hits an affected creature with a melee attack roll". Its attacker's
 * creature types (1) and distance in feet (2) are the Trigger's predicate.
 */
const CARRIED_RETALIATION_TEXT = /\b(?:[Aa] creature|[Aa]n? ([A-Z][a-z]+(?:,? or an? [A-Z][a-z]+)*))(?: within (\d+) feet(?: of you)?)? hits (?:you|an affected creature) with a melee attack\b/u;

/**
 * Reactions by their 2024 trigger, as a reaction Trigger on their Action: Shield and a Parry when an attack on their
 * creature hits (the attack is then checked again against its new AC; Parry's only a melee attack), Counterspell when a
 * hostile creature it sees within 60 feet casts a spell with a component (a failed save cancels it, `counters`).
 */
const REACTIONS = Object.freeze({
  shield: {event: "attack.hit", match: {phase: "interrupt", targetTokenId: "{self}"}},
  parry: {event: "attack.hit", match: {phase: "interrupt", targetTokenId: "{self}", tagsAny: ["melee"]}, acFromText: true},
  // Halving that attack's damage is resistance to all of it, until the attack is over.
  "uncanny-dodge": {event: "attack.hit", match: {phase: "interrupt", targetTokenId: "{self}"}, halves: true},
  // "when you take damage from a creature": that creature is the reaction's target.
  "hellish-rebuke": {event: "damage.applied", match: {phase: "interrupt", targetTokenId: "{self}", notSourceTokenId: "{self}"}},
  // Goliath Stone's Endurance: "when you take damage", from anything (an attack, a save, a fall), before that damage is
  // planned: 1d12 + its Constitution modifier off the damage it takes (`rider.reduceDamage`).
  "stones-endurance": {event: "damage.applied", match: {phase: "before", targetTokenId: "{self}"},
    reduces: {dice: {type: "dice", number: 1, faces: 12}, bonus: {type: "ability-modifier", ability: "fortitude"}}},
  // 2024 Deflect Attacks: "When an attack roll hits you and its damage includes Bludgeoning, Piercing, or Slashing damage";
  // Deflect Energy, any damage. Its Redirect is a new attack, not this damage (by hand).
  "deflect-attacks": {event: "damage.applied", match: {phase: "before", targetTokenId: "{self}", tagsAll: ["hit"],
    tagsAny: ["damage:bludgeoning", "damage:piercing", "damage:slashing"]}, reduces: DEFLECTION},
  // Dwarven Plate: "moves you against your will along the ground" is a push or pull, before its Tokens move; it takes off
  // the full 10 feet (`rider.reducePush`). shortcut: never less than 10 feet (5 is by hand) and "along the ground" isn't
  // checked; upgrade with a choice on the reaction and an elevation predicate. shortcut: a creature the same Action drops
  // to 0 Hit Points is still asked, as in every planned-damage window; upgrade with an incapacitation check in discovery.
  "dwarven-plate": {event: "push.applied", match: {phase: "before", targetTokenId: "{self}"}, reducesPush: 10},
  "deflect-energy": {event: "damage.applied", match: {phase: "before", targetTokenId: "{self}", tagsAll: ["hit"]}, reduces: DEFLECTION},
  // "hit by an attack roll made with a Ranged or Thrown weapon" (a thrown weapon's attack is a ranged one): 1d10 + its
  // Dexterity modifier off it. shortcut: its free hand and catching the missile are not checked.
  "gloves-of-missile-snaring": {event: "damage.applied", match: {phase: "before", targetTokenId: "{self}", tagsAll: ["hit", "ranged", "weapon"]},
    reduces: {dice: {type: "dice", number: 1, faces: 10}, bonus: {type: "ability-modifier", ability: "agility"}}},
  // Attack Deflection: "gaining a +5 bonus to your Armor Class against the triggering attack" (its text, acFromText).
  "quarterstaff-of-the-acrobat": {event: "attack.hit", match: {phase: "interrupt", targetTokenId: "{self}"}, acFromText: true},
  // 2024 Feather Fall: a falling creature it sees within 60 feet (itself too) "takes no damage from the fall": all of that
  // fall's damage (20d6 at most) comes off, and with none taken its Prone (`whenDamaged`) goes too. shortcut: one creature
  // a reaction (not up to five), and its 60 feet a round of descent is not tracked; upgrade with several protected targets.
  "feather-fall": {event: "damage.applied", match: {phase: "before", tagsAll: ["fall"]}, triggerPredicate: {all: seenTargetWithin(60)},
    reduces: {dice: {type: "constant", value: 120}}, protects: "target"},
  // 2024 Interception: "When a creature you can see hits another creature within 5 feet of you with an attack roll": 1d10 +
  // its Proficiency Bonus off the damage that creature takes. shortcut: its "holding a Shield or a Simple or Martial
  // weapon" isn't checked; upgrade with an equipment predicate.
  interception: {event: "damage.applied", match: {phase: "before", tagsAll: ["hit"], notSourceTokenId: "{self}"},
    triggerPredicate: {all: [{equals: {path: "toSource.{self}.sees", value: true}}, ...seenTargetWithin(5),
      {not: {equals: {path: "toTarget.{self}.self", value: true}}}]},
    reduces: {dice: {type: "dice", number: 1, faces: 10}, bonus: {type: "proficiency-bonus"}}, protects: "target"},
  // Tasha's Cloud Rune: "when you or a creature you can see within 30 feet of you is hit by an attack roll ... choose a
  // different creature within 30 feet of you, other than the attacker": the damage goes to it (redirectedDamage).
  "cloud-rune": {event: "damage.applied", match: {phase: "before", tagsAll: ["hit"], notSourceTokenId: "{self}"},
    triggerPredicate: {all: seenTargetWithin(30)}, redirect: {to: "chosen", range: 30, sameRoll: true}, protects: "target"},
  "storms-thunder": {event: "damage.applied", match: {phase: "interrupt", targetTokenId: "{self}", notSourceTokenId: "{self}"}},
  // "when you take damage from a creature within 5 feet": that creature is the target of its common melee attack (its
  // first melee attack or Unarmed Strike, `commonAction`). A damager with no position (a fall) is not within 5 feet.
  retaliation: {event: "damage.applied", match: {phase: "interrupt", targetTokenId: "{self}", notSourceTokenId: "{self}"},
    triggerPredicate: {atMost: {path: "event.data.relations.{self}.distance", value: 5}}, commonAction: "opportunity"},
  counterspell: {event: "action.declared", match: {phase: "interrupt", tagsAll: ["spell"], notTagsAny: [UNCOUNTERABLE],
    notSourceTokenId: "{self}"}, triggerPredicate: seenHostileWithin(60), counters: true},
  // A hostile creature it sees within 60 feet hits with an attack or succeeds on an ability check: its die (Bardic
  // Inspiration's) is subtracted from that roll, which is then checked again. Its damage roll: Cutting Words (Damage).
  "cutting-words": {event: "attack.hit", match: {phase: "interrupt", notSourceTokenId: "{self}"}, triggerPredicate: seenHostileWithin(60),
    attackPenalty: true}
});

/**
 * A spell's component tags from dnd5e's properties (Counterspell, Subtle Spell): a material with a cost, or consumed, is
 * also `costly-material`; none at all is `component:none`.
 */
function componentTags(system) {
  const properties = new Set(system?.properties ?? []);
  const material = properties.has("material");
  const tags = [...(properties.has("vocal") ? ["component:verbal"] : []), ...(properties.has("somatic") ? ["component:somatic"] : []),
    ...(material ? ["component:material"] : []),
    ...((material && ((Number(system?.materials?.cost) > 0) || system?.materials?.consumed)) ? ["component:costly-material"] : [])];
  return tags.length ? tags : [UNCOUNTERABLE];
}

/**
 * When its text has a creature repeat the save that let its effect in, ending it on a success: `repeatSave` `turnEnd`
 * ("repeats the save at the end of each of its turns"; 2014 "can repeat the saving throw at the end of each of its
 * turns", "the target can make another Wisdom saving throw. On a success, the spell ends") or `turnStart`, and
 * `repeatOnDamage` ("Whenever the target takes damage, it repeats the save": Dominate Person). "repeats the save at ..."
 * is read first, so a text naming another start-of-turn event before it (a Pit Fiend's poison) still reads right.
 * `qualifier`: a roll mode the repeat has in a case its text names ("with disadvantage if the tarrasque is within line
 * of sight"), for a by-hand note.
 * A repeat whose failure deals damage, ending on a success (2024 Phantasmal Killer: "makes a Wisdom saving throw at the
 * end of each of its turns. On a failed save, it takes the Psychic damage again. On a successful save, the spell ends";
 * Weird's "it takes 5d10 Psychic damage"; 2014 "At the end of each of the target's turns before the spell ends, the
 * target must succeed on a Wisdom saving throw or take 4d10 psychic damage. On a successful save, the spell ends"):
 * `repeatSave` and `repeatDamage`. "Again", or the same dice, is the Action's own `damage` component of that type, its
 * id kept so a higher slot's dice reach the repeat too. `wording`: the words it was read from.
 */
function repeatSaveFields(document, damage=[]) {
  const text = repeatText(plainText(document));
  const hurt = String.raw`(?:the (\w+) damage again|(\d+)d(\d+) (\w+) damage)\. On a successful save, the spell ends\b`;
  const hurts = new RegExp(String.raw`\bmakes an? \w+ saving throw at the (end|start) of each of its turns\. On a failed save, it takes ${hurt}`, "i").exec(text)
    ?? new RegExp(String.raw`\bat the (end|start) of each of the target[’']s turns[^.]*, the target must succeed on an? \w+ saving throw or take ${hurt}`, "i").exec(text);
  const [, , again, number, faces, type] = hurts ?? [];
  const same = component => (component.damageType === (again ?? type)?.toLowerCase()) && (again || ((component.expression?.type === "dice")
    && (component.expression.number === Number(number)) && (component.expression.faces === Number(faces))));
  const repeatDamage = !hurts ? [] : damage.some(same)
    ? damage.filter(same).map(({saveOutcomePolicy: _policy, ...component}) => structuredClone(component))
    : (again ? [] : [{id: "repeat-damage-1", expression: {type: "dice", number: Number(number), faces: Number(faces)}, damageType: type.toLowerCase()}]);
  // "it makes another Wisdom saving throw. The target has Advantage on ... . On a successful save, the spell ends."
  const another = String.raw`(?:the target|it) (?:can make|makes) another \w+ saving throw\b[^.]*\.(?: [^.]*\.)? On a success(?:ful save)?, the (?:spell|effect) ends`;
  const found = /repeats? the sav(?:e|ing throw) at the (end|start) of each of its turns[^.]*\b(?:ending|ends?)\b[^.]*on a success/i.exec(text)
    ?? /at the (end|start) of each of its turns,? [^.]*repeats? the save[^.]*\b(?:ending|ends?)\b[^.]*on a success/i.exec(text)
    ?? new RegExp(String.raw`at the (end|start) of each of its turns(?:,? and each time it takes damage)?,? ${another}`, "i").exec(text);
  const onDamage = /\brepeats? the save whenever it takes damage\b[^.]*\bon a success/i.test(text)
    || /\b(?:whenever|each time) (?:the target|it) takes damage, it repeats the save\b[^.]*\bon a success/i.test(text)
    || new RegExp(String.raw`\beach time it takes damage, ${another}`, "i").test(text);
  const qualifier = found && /\bwith (dis)?advantage if ([^,.]+)/i.exec(found[0]);
  const timing = (found ?? (repeatDamage.length ? hurts : null))?.[1].toLowerCase();
  return {...(timing ? {repeatSave: timing === "end" ? "turnEnd" : "turnStart", wording: (found ?? hurts)[0]} : {}),
    ...(repeatDamage.length ? {repeatDamage} : {}),
    ...(onDamage ? {repeatOnDamage: true} : {}),
    ...(qualifier ? {qualifier: `${qualifier[1] ? "Disadvantage" : "Advantage"} if ${qualifier[2]}`} : {})};
}
// An inline save ("another [[/save ability=wis dc=@attributes.spell.dc]] saving throw") is a word, its dots no sentence end;
// an inline damage roll ("[[/damage 5d10 type=psychic]]") its dice and type.
const repeatText = text => text.replace(/&amp;Reference\[(\w+)[^\]]*\]/g, "$1")
  .replace(/\[\[\/damage (\d+d\d+) (?:type=)?(\w+)[^\]]*\]\](?:\{[^}]*\})?/g, "$1 $2").replace(/\[\[[^\]]*\]\](?:\{[^}]*\})?/g, "it");

/**
 * Reactions an effect gives the creatures it is on, by "<feature>/<effect name>" (reaction-provider effectReactionItems).
 * Tasha's Protective Bond: when a creature with Emboldening Bond's effect is about to take damage, another bonded
 * creature within 30 feet of it may use its Reaction to teleport beside it and take all the damage instead; only while
 * the cleric who bonded them has Protective Bond (`giverItem`). shortcut: Expansive Bond's 60 feet and resistance are
 * not applied; upgrade with a range from the giver's features.
 */
const EFFECT_REACTIONS = Object.freeze({
  "emboldening-bond/Bonded": [{schemaVersion: 1, id: "protective-bond", type: "Trigger", data: {kind: "reaction",
    event: "damage.applied", match: {phase: "before", notSourceTokenId: "{self}"}, giverItem: "protective-bond",
    triggerPredicate: {all: [{equals: {path: "targetEffects.bonded", value: true}}, {atMost: {path: "toTarget.{self}.distance", value: 30}},
      {not: {equals: {path: "toTarget.{self}.self", value: true}}}]},
    action: {schemaVersion: 1, id: "action:protective-bond", label: "Protective Bond", costs: {allOf: [{capability: "reaction", amount: 1}]},
      range: {type: "self"}, targeting: {type: "self"}, rider: {redirectDamage: {to: "self"}, protects: "target", teleportNextTo: true}}}}]
});

/**
 * 2024 Mirror Image's duplicates: "Each time a creature hits you with an attack roll ..., roll a d6 for each of your
 * remaining duplicates. If any of the d6s rolls a 3 or higher, one of the duplicates is hit instead of you, and the
 * duplicate is destroyed." Its effect's reaction, used at once: the highest of a d6 per level (`"{{level}}"`, filled in
 * when it is offered) at 3 or more turns the hit into a miss (`missChance`), and spendDecoys takes a level off.
 * "A creature is unaffected by this spell if it has the Blinded condition, Blindsight, or Truesight": not offered when
 * the attacker is undeceived (`toSource.{self}.undeceived`, its sense reaching this creature).
 */
const MIRROR_IMAGE = Object.freeze({schemaVersion: 1, id: "mirror-image", type: "Trigger", data: {kind: "reaction", event: "attack.hit",
  match: {phase: "interrupt", targetTokenId: "{self}"}, policy: "always",
  triggerPredicate: {not: {equals: {path: "toSource.{self}.undeceived", value: true}}},
  action: {schemaVersion: 1, id: "action:mirror-image-duplicates", label: "Mirror Image", costs: {allOf: []}, range: {type: "self"},
    targeting: {type: "self"}, rider: {missChance: {dice: {type: "dice", number: "{{level}}", faces: 6}, keep: "highest", atLeast: 3}}}}});

/**
 * What a spell ends on its target, by identifier: curses (effects tagged "curse"), magical contagions (`contagions`), or
 * spells up to its own level; with `areas`, a lasting spell area chosen in place of a creature (Dispel Magic's "magical effect").
 */
const ENDS = Object.freeze({
  "remove-curse": {tags: ["curse"]},
  "dispel-magic": {spells: "slot", areas: true},
  // "you are cured of all magical contagions" (helpers/contagions.mjs).
  "elixir-of-health": {contagions: true}
});

/** The spell a feature casts with a spell slot, as its tags: 2024 Wild Companion's Find Familiar, without its Material component. */
const SLOT_CASTS = Object.freeze({
  "wild-companion": ["spell", "school:conjuration", "component:verbal", "component:somatic"]
});

/**
 * A paladin's auras (2024): what "you and your allies" in the paladin's 10-foot Emanation (30 feet from Aura Expansion,
 * paladin level 18) get, inactive while the paladin has the Incapacitated condition. Aura of Protection adds its
 * Charisma modifier to saves (at least +1); Courage and Devotion give immunity to Frightened and Charmed, and an ally
 * already Frightened or Charmed has that condition suppressed while inside (WildPathActiveEffect#isSuppressed).
 */
const PALADIN_AURAS = Object.freeze({
  "aura-of-protection": [{schemaVersion: 1, id: "protection", type: "Modifier", data: {domains: ["save"], modifierType: "untyped",
    valueExpression: {type: "max", terms: [{type: "constant", value: 1}, {type: "ability-modifier", ability: "presence"}]}}}],
  "aura-of-courage": [{schemaVersion: 1, id: "courage", type: "ConditionImmunity", data: {conditions: ["frightened"]}}],
  "aura-of-devotion": [{schemaVersion: 1, id: "devotion", type: "ConditionImmunity", data: {conditions: ["charmed"]}}]
});

/** A paladin aura's Aura rule. */
const paladinAura = identifier => ({schemaVersion: 1, id: identifier, type: "Aura",
  predicate: {missingCondition: "incapacitated"},
  data: {radius: {type: "table", key: {type: "class-level", class: "paladin"}, rows: {1: 10, 18: 30}}, affects: "allies",
    ruleElements: PALADIN_AURAS[identifier]}});

/**
 * Wild Shape's transformation by the 2014 rules (SRD 5.1; the maintainer's choice over 2024's), by druid level: a Beast of CR 1/4 with
 * no Fly or Swim Speed, CR 1/2 with no Fly Speed from level 4, CR 1 from level 8. Twice per Short or Long Rest.
 */
const WILD_SHAPE_2014 = Object.freeze({
  limits: {2: {cr: 0.25, fly: false, swim: false}, 4: {cr: 0.5, fly: false, swim: true}, 8: {cr: 1, fly: true, swim: true}},
  uses: {max: "2", recovery: [{period: "sr", type: "recoverAll"}]}
});

/**
 * A transform activity (Wild Shape: the 2024 Bonus Action, its transformation by the 2014 rules): a Beast form its user
 * picks, within its druid level's limits. The form's Strength, Dexterity, Constitution, AC and Speed replace its own, and its Hit Points come
 * as Temporary Hit Points: the druid reverts when they are gone, and damage beyond them carries over to its own, as
 * the 2014 text has it; healing in the form heals the form, up to its Hit Points. It lasts half its druid level in
 * hours (rounded down). Null without Beasts to choose from, or for another preset.
 * The maintainer's rules choice: every eligible Beast is offered; that the druid has seen it is the player's to keep.
 */
function wildShapeDefinition({document, activity, system, spell, level, notes, pool, beasts=[]}) {
  const settings = activity.transform ?? activity.settings ?? {};
  if ( (settings.preset !== "wildshape") || !beasts.length ) return null;
  const owner = settings.identifier || "druid";
  const rows = WILD_SHAPE_2014.limits;
  const highest = Math.max(...Object.values(rows).map(row => row.cr));
  const choice = {id: "form", type: "select-one", label: "Form", required: true,
    options: beasts.filter(beast => beast.cr <= highest).map(beast => ({id: beast.uuid, label: `${beast.name} (CR ${beast.cr})`}))};
  const definition = manualDefinition({document, activity, system, spell, level, notes, pool});
  return {...definition, range: {type: "self"}, targeting: {type: "self"},
    configuration: [...(definition.configuration ?? []), choice],
    transform: {choiceId: choice.id, limits: {class: owner, rows}, temporaryHealth: "form",
      duration: {class: owner, perLevel: 0.5, units: "hours"}}};
}

/** A spell that transforms its caster (SELF_TRANSFORM): a choice of form. Null for another, or without creatures to choose. */
function selfTransformDefinition({document, activity, system, spell, level, notes, pool, forms=[]}) {
  const entry = SELF_TRANSFORM[identifierOf(document)];
  const eligible = entry ? forms.filter(form => !entry.excludeTypes.includes(form.type)) : [];
  if ( !eligible.length ) return null;
  const {excludeTypes, ...transform} = structuredClone(entry);
  const choice = {id: "form", type: "select-one", label: "Form", required: true,
    options: eligible.map(form => ({id: form.uuid, label: `${form.name} (CR ${form.cr})`}))};
  const definition = manualDefinition({document, activity, system, spell, level, notes, pool});
  return {...definition, range: {type: "self"}, targeting: {type: "self"}, configuration: [...(definition.configuration ?? []), choice],
    transform: {choiceId: choice.id, ...transform}};
}

/**
 * Divine Smite: offered when its creature hits with a melee attack that is not a spell's, on the creature hit. The 2024
 * spell is a Bonus Action; its second activity ("Unholy Creature") is the one against an Undead or a Fiend, 1d8 more.
 * Both are tagged `smite`. A critical hit doubles their dice, as part of the attack's damage. The Undead or Fiend one is
 * offered only on such a creature (`targetType`), the other only on any other.
 */
const SMITE_TRIGGER = Object.freeze({event: "attack.hit",
  match: {phase: "interrupt", sourceTokenId: "{self}", tagsAll: ["melee"], notTagsAny: ["spell"]}});
const UNHOLY = Object.freeze({oneOf: {path: "targetType", values: ["undead", "fiend"]}});

/**
 * Enchantments of one of its creature's own weapons (dnd5e enchant activities): when used it picks the weapon (a
 * `weapons` choice), and an effect on the creature gives that weapon's attacks (`weapon:{{weapon}}`) these rules, for
 * its duration.
 * - Magic Weapon (2024): +1 to attack and damage rolls, +2 from a 3rd-level slot, +3 from a 6th.
 * - Sacred Weapon: its Charisma modifier (at least +1) on attack rolls, for 10 minutes, paid from Channel Divinity.
 * - Pact of the Blade: its Charisma in place of Strength or Dexterity on attack and damage rolls, until used again.
 * - Shillelagh: a club or quarterstaff uses its spellcasting ability in place of Strength.
 * shortcut: Magic Weapon's weapon becoming magical, Sacred Weapon's Radiant option and "when you take the Attack action",
 * Pact of the Blade's proficiency and damage types, and Shillelagh's larger die and Force damage are by hand; one such
 * effect is held at a time.
 */
const swap = (value, domain) => ["might", "agility"].map(ability => ({type: "Modifier", data: {domains: [domain], modifierType: "untyped",
  valueExpression: {type: "max", terms: [{type: "constant", value: 0}, {type: "subtract", left: value,
    right: {type: "ability-modifier", ability}}]}}, predicate: {tagsAll: ["weapon:{{weapon}}", ability]}}));
const ENCHANTS = Object.freeze({
  "magic-weapon": {bySlot: true, rules: ["attack", "damage"].map(domain => ({type: "Modifier", data: {domains: [domain],
    modifierType: "untyped", valueExpression: {type: "table", key: {type: "constant", value: "{{spell-slot}}"}, rows: {2: 1, 3: 2, 6: 3}}},
    predicate: {tagsAny: ["weapon:{{weapon}}"]}}))},
  "sacred-weapon": {rules: [{type: "Modifier", data: {domains: ["attack"], modifierType: "untyped", valueExpression: {type: "max",
    terms: [{type: "constant", value: 1}, {type: "ability-modifier", ability: "presence"}]}}, predicate: {tagsAny: ["weapon:{{weapon}}"]}}]},
  "pact-of-the-blade": {melee: true, rules: ["attack", "damage"].flatMap(domain => swap({type: "ability-modifier", ability: "presence"}, domain))},
  shillelagh: {melee: true, bases: ["club", "quarterstaff"],
    rules: ["attack", "damage"].flatMap(domain => swap({type: "spellcasting-modifier"}, domain))},
  // 2024 Helm of Brilliance's Fire Opal Flames: the weapon's hits deal an extra 1d6 Fire, and it sheds Bright Light 10 feet
  // and Dim Light 10 more, until its wielder ends it. shortcut: "at least one fire opal" left, putting the flames out with
  // a Bonus Action (ending the effect) and dropping or sheathing the weapon are by hand.
  "helm-of-brilliance/Fire Opal Flames": {rules: [{type: "ExtraDamage", data: {domains: ["damage.weapon"],
    expression: {type: "dice", number: 1, faces: 6}, damageType: "fire"}, predicate: {tagsAny: ["weapon:{{weapon}}"]}},
  {type: "GrantLight", data: {bright: 10, dim: 20}}]}
});

/** The class whose level an enchantment of this kind reads (Tasha's infusions: "when you reach 10th level in this class"). */
const SUBTYPE_CLASS = Object.freeze({artificerInfusion: "artificer"});

/**
 * What a dnd5e enchantment changes on its Item, as rules for whoever holds it: a weapon's magical bonus on attack and
 * damage rolls with that weapon (`weapon:{{host}}`, bound to the Item: hostedRules), armor's or a Shield's on AC.
 * Its name, description, properties and attunement are left out.
 */
function enchantmentRules(effect) {
  const id = slugify(effect.name);
  return effectChanges(effect).flatMap(change => {
    // dnd5e's 2014-era enchantments (Tasha's infusions) keep only the numeric `mode`.
    const type = change.type ?? CHANGE_MODES[change.mode];
    // Dice its weapon adds on each hit (Flame Tongue's 2d6 Fire, Frost Brand's 1d6 Cold; a Vicious Weapon's 2d6 of the
    // weapon's type). Only literal dice: True Strike's formula is not a bonus.
    if ( (type === "add") && ["system.damage.parts", "system.damage.base.bonus"].includes(change.key) ) {
      const [formula, type] = String(change.value ?? "").split(",").map(part => part.trim());
      const extra = /^\d+d\d+$/u.test(formula) ? extraDamageOf(type ? `${formula}[${type}]` : formula) : null;
      return extra ? [{schemaVersion: 1, id: `${id}-damage`, type: "ExtraDamage", data: {domains: ["damage.weapon"], ...extra},
        predicate: {tagsAny: ["weapon:{{host}}"]}}] : [];
    }
    const value = number(change.value);
    // A magic bonus is added, or raised to (`upgrade`: a +1 Shield, a +2 Weapon).
    if ( !value || !["add", "upgrade"].includes(type) ) return [];
    if ( change.key === "system.magicalBonus" ) return ["attack", "damage"].map(domain => ({schemaVersion: 1, id: `${id}-${domain}`,
      type: "Modifier", data: {domains: [domain], modifierType: "untyped", value}, predicate: {tagsAny: ["weapon:{{host}}"]}}));
    if ( change.key === "system.armor.magicalBonus" ) return [{schemaVersion: 1, id: `${id}-ac`, type: "Modifier",
      data: {domains: ["defense.ac"], modifierType: "untyped", value}}];
    return [];
  });
}

/**
 * An enchantment of one of its creature's Items (Tasha's infusions): when used its creature picks one of its own Items of
 * the kinds it suits (`gear` choice), and that Item gets the effect for its creature's level. "The bonus increases to +2
 * when you reach 10th level in this class": its "+2" effect from that level, the other below it. The Item whose uses it
 * spends (Infuse Item) is its limit and key: past it, the oldest ends (adapters/foundry-v14-enchantments).
 * shortcut: its riders (Radiant Weapon's reaction), the Item's new name and attunement are by hand. Null when nothing it
 * changes is a rule.
 */
/**
 * What a template's text adds to each of its enchantments beyond dnd5e's changes. 2024 Wand of the War Mage: "you ignore
 * Half Cover when making a spell attack roll" (`cover.ignored`, the authority's cover).
 */
const ENCHANT_TEXT_RULES = Object.freeze({
  // 2024 Oathbow: against its sworn enemy (the `sworn-enemy` mark its Swear Oath gives), Advantage on its attack rolls and
  // an extra 3d6 Piercing on a hit. shortcut: ignoring Half and Three-Quarters Cover and long range's Disadvantage, one
  // sworn enemy at a time, and Disadvantage with other weapons while it lives are by hand; upgrade when cover rules see
  // the attack's weapon and its target's marks.
  oathbow: ["attack", "damage"].map(domain => ({schemaVersion: 1, id: `oathbow-${domain}`,
    ...((domain === "attack") ? {type: "RollMode", data: {domains: ["attack"], mode: "advantage"}}
      : {type: "ExtraDamage", data: {domains: ["damage.weapon"], expression: {type: "dice", number: 3, faces: 6}, damageType: "piercing"}}),
    predicate: {all: [{tagsAny: ["weapon:{{host}}"]}, {equals: {path: "attack.fromAttacker.sworn-enemy", value: true}}]}})),
  "1-wand-of-the-war-mage": [{schemaVersion: 1, id: "war-mage-cover", type: "Modifier", predicate: {tagsAll: ["spell", "attack"]},
    data: {domains: ["cover.ignored"], modifierType: "untyped", value: 1}}]
});

function itemEnchantDefinition({document, activity, system, spell, level, pool, usesOf={}, scales={}}) {
  // Each enchantment with the effects it brings along on its Item (`riders.effect`: Armor of Resistance's Acid Resistance).
  const byId = id => (document.effects ?? []).find(effect => effect._id === id);
  const effects = (activity.effects ?? []).map(ref => ({ref, effect: byId(ref._id)})).filter(({effect}) => effect)
    .map(({ref, effect}) => ({name: effect.name, ...(effect.img ? {img: effect.img} : {}), ruleElements: [...enchantmentRules(effect),
      ...(ref.riders?.effect ?? []).map(byId).filter(Boolean).flatMap(rider => effectRules(rider, [])),
      ...structuredClone(ENCHANT_TEXT_RULES[identifierOf(document)] ?? [])]}))
    .filter(effect => effect.ruleElements.length);
  if ( !effects.length ) return null;
  const raised = /increases to \+(\d+) when you reach (\d+)(?:st|nd|rd|th) level/i.exec(plainText(document));
  const levelClass = SUBTYPE_CLASS[system.type?.subtype] ?? null;
  if ( raised && (effects.length > 1) ) for ( const effect of effects ) {
    const at = Number(raised[2]);
    effect.level = {...(/\+\d+$/.test(effect.name) ? {min: at} : {max: at - 1}), ...(levelClass ? {class: levelClass} : {})};
    effect.name = effect.name.replace(/\s*\+\d+$/, "");
  }
  // What it suits: a weapon (`restrictions.type`, or a weapon's own template); a magic Shield's a Shield and a magic armor's
  // armor, by its name or `restrictions.type` (Shield +1, Armor +1, Armor of Resistance, Dragon Scale Mail); else armor and
  // Shields when it gives AC (an infusion's Enhanced Defense); else any Item. shortcut: a weapon's category (Vorpal Sword's
  // martial melee) is not narrowed; upgrade when gear choices filter by category.
  const named = (document.type === "equipment") ? (/\bshield\b/iu.test(document.name) ? ["shield"]
    : (/\b(?:armor|mail)\b/iu.test(document.name) || (activity.restrictions?.type === "equipment")) ? ["armor"] : null) : null;
  const kinds = ((activity.restrictions?.type === "weapon") || (document.type === "weapon")) ? ["weapon"]
    : named ?? (effects.some(effect => effect.ruleElements.some(rule => rule.data?.domains?.includes("defense.ac"))) ? ["armor", "shield"] : []);
  // Several with no level between them are a choice of one (+1, +2 or +3; Acid or Fire Resistance), by its index.
  const choose = (effects.length > 1) && !(raised && (effects.length === 2));
  const limited = (activity.consumption?.targets ?? []).find(target => (target.type === "itemUses") && target.target);
  const limitId = limited ? String(limited.target).split(".").pop() : null;
  const limit = (limitId && usesOf[limitId]) ? formulaExpression(String(usesOf[limitId]), {scales}) : null;
  const definition = manualDefinition({document, activity, system, spell, level, notes: [], pool, scales});
  return {...definition, range: {type: "self"}, targeting: {type: "self"},
    configuration: [...(definition.configuration ?? []), {id: "item", type: "select-one", label: "Item", required: true, options: [],
      optionsFrom: {type: "gear", kinds}},
    ...(choose ? [{id: "enchantment", type: "option", label: document.name, required: true,
      options: effects.map((effect, index) => ({id: String(index), label: effect.name, value: String(index)}))}] : [])],
    enchant: {choiceId: "item", key: limitId ?? identifierOf(document), ...(limit ? {limit} : {}), ...(choose ? {optionChoiceId: "enchantment"} : {}),
      effects}};
}

/** An enchantment's Action: its cost (and slot), a choice of its creature's weapon, and the effect on it. */
function enchantDefinition({document, activity, system, spell, level, pool, enchant}) {
  const definition = manualDefinition({document, activity, system, spell, level, notes: [], pool});
  const choice = {id: "weapon", type: "select-one", label: "Weapon", required: true, options: [],
    optionsFrom: {type: "weapons", ...(enchant.melee ? {melee: true} : {}), ...(enchant.bases ? {bases: enchant.bases} : {})},
    effects: [{type: "bindChoice"}]};
  const configuration = (definition.configuration ?? []).map(entry => ((enchant.bySlot && entry.levelByResourceId)
    ? {...entry, effects: [...(entry.effects ?? []), {type: "bindChoice"}]} : entry));
  const duration = lastingDuration(pick(activity, system, "duration")) ?? lastingDuration(activity.duration);
  const concentration = (system.properties ?? []).includes("concentration");
  return {...definition, range: {type: "self"}, targeting: {type: "self"}, configuration: [...configuration, choice],
    effects: [{id: "effect-1", type: "effect", name: document.name, ...(document.img ? {img: document.img} : {}),
      ruleElements: enchant.rules.map((rule, index) => ({schemaVersion: 1, id: `${identifierOf(document)}-${index + 1}`, ...structuredClone(rule)})),
      ...(duration ? {duration} : {}), ...(concentration ? {concentration: true} : {})}]};
}

/**
 * Features a creature uses when it hits with a melee attack that is not a spell's, which dnd5e leaves passive: offered
 * on that hit, on the creature hit (as Divine Smite is). `once: "turn"`: at most once a turn. Stunning Strike (2024):
 * 1 Focus Point, a Constitution save; on a failure the target has the Stunned condition until the start of the monk's
 * next turn; on a success its Speed is halved and the next attack roll against it has Advantage until then. shortcut:
 * "with a Monk weapon or an Unarmed Strike" is any melee hit.
 */
/**
 * 2024 Cunning Strike: when its Sneak Attack deals damage (an attack whose planned extra damage includes it), one d6 of it
 * given up for one effect, once a turn among them: Poison (a Constitution save or Poisoned, repeated at the end of each
 * of its turns) and Trip (an Agility save or Prone), on the creature hit; Withdraw: its rogue moves up to half its Speed
 * without provoking Opportunity Attacks (Disengaged, and that much more movement this turn).
 * Trip is only for a creature Large or smaller. shortcut: Poison's Poisoner's Kit and 1-minute limit (its repeated save
 * ends it) are by hand.
 */
// Improved Cunning Strike (rogue level 11): two of them on one Sneak Attack, each with its own die.
const CUNNING_USES = {type: "table", key: {type: "class-level", class: "rogue"}, rows: {1: 1, 11: 2}};
// A Devious Strikes option's one effect, with its own duration (the feature's shared text would give each a repeated save).
/** Daze (2024): once its creature moves, takes an action or a Bonus Action, the other two are capped at 0 this turn. */
const spentAny = resource => ({atLeast: {path: `actorSystem.resources.${resource}.spent`, value: 1}});
const DAZED = Object.freeze([
  {schemaVersion: 1, id: "dazed-moved", type: "ResourceCap", predicate: spentAny("movement"), data: {resources: ["action", "bonus"], maximum: 0}},
  {schemaVersion: 1, id: "dazed-acted", type: "ResourceCap", predicate: spentAny("action"), data: {resources: ["movement", "bonus"], maximum: 0}},
  {schemaVersion: 1, id: "dazed-bonus", type: "ResourceCap", predicate: spentAny("bonus"), data: {resources: ["movement", "action"], maximum: 0}}
]);
const deviousStrike = (timing={duration: {value: 1, units: "rounds", expiry: "turnEnd"}}) => definition => ({...definition,
  effects: (definition.effects ?? []).map(({repeatSave: _repeat, duration: _duration, ...effect}) => ({...effect, ...structuredClone(timing)}))});
const cunning = (extra={}) => ({once: "turn", onceKey: "cunning-strike", uses: CUNNING_USES, tagsAll: ["extra:sneak-attack"],
  rider: {forgoDice: {ruleId: "sneak-attack", dice: 1}}, definition: definition => definition, ...extra});
const WITHDRAW = {id: "effect-1", type: "effect", name: "Withdraw", slug: "disengaged", img: "icons/svg/walk.svg",
  duration: {value: 0, units: "turns", expiry: "turnEnd"}, ruleElements: [{schemaVersion: 1, id: "withdraw", type: "Modifier",
    data: {domains: ["resources.movement.max"], modifierType: "untyped", valueExpression: {type: "floor", value: {type: "divide",
      numerator: {type: "add", terms: [{type: "context", path: "actorSystem.resources.movement.base"},
        {type: "context", path: "actorSystem.resources.movement.bonus"}]}, denominator: {type: "constant", value: 2}}}}}]};

/**
 * Choices a feature adds to another feature's Actions, by that feature's identifier (action-definitions.mjs,
 * withContributedChoices). 2024 Restoring Touch: "When you use Lay On Hands on a creature, you can also remove one or more
 * of the following conditions ... You must expend 5 Hit Points from the healing pool of Lay On Hands for each of these
 * conditions you remove; those points don't also restore Hit Points to the creature."
 */
const CHOICES_FOR = Object.freeze({
  "restoring-touch": {identifier: "lay-on-hands", choice: {id: "restoring-touch", type: "select-many", label: "Restoring Touch",
    options: ["blinded", "charmed", "deafened", "frightened", "paralyzed", "stunned"].map(conditionId => ({id: conditionId, value: conditionId,
      label: conditionId.charAt(0).toUpperCase() + conditionId.slice(1),
      effects: [{type: "add-cost", cost: {allOf: [{capability: "lay-on-hands", amount: 5}]}},
        {type: "add-effects", effects: [{id: `restoring-touch-${conditionId}`, type: "condition", conditionId, levels: -1}]}]}))}},
  // Eldritch Hex: Hex also gives its target Disadvantage on saves of Hex's chosen ability, while the curse lasts. The
  // marker (`hex-saves`, its caster's concentration) switches on Hex's save rules (EFFECTS_BY_HAND.hex `savesToo`).
  // shortcut: the marker is not tied to its own Hex, so a creature hexed by two warlocks, one with this, has the save
  // Disadvantage for both abilities; upgrade by reading the marker from the hex's own source.
  "eldritch-hex": {identifier: "hex", choice: {id: "eldritch-hex", type: "option", label: "Eldritch Hex", required: true, defaultValue: "on",
    options: [{id: "on", label: "Eldritch Hex", value: "on", effects: [{type: "add-effects", effects: [{id: "hex-saves", type: "effect",
      name: "Eldritch Hex", slug: "hex-saves", img: "icons/svg/daze.svg", concentration: true, ruleElements: []}]}]}]}},
  // 2024 Overchannel (SRD 5.2): a wizard spell of level 1+ that deals damage, cast with a slot of level 1 to 5, may deal
  // its maximum damage. Each use spends one of its uses (its dnd5e `overchannel` pool, full again after a Long Rest), so
  // the uses before this one are its maximum less what is left. The first is free; each later one deals its caster d12s
  // of Necrotic damage per slot level, one more than the uses before it (2, then 3...), ignoring Resistance and Immunity.
  overchannel: {spell: {lists: ["wizard"], minLevel: 1, damage: true}, choice: {id: "overchannel", type: "select-one",
    label: "Overchannel", required: true, defaultValue: "no", options: [{id: "no", label: "WILDPATH.PROMPT.No", value: "no"},
      {id: "overchannel", label: "Overchannel: maximum damage", value: "overchannel", effects: [
        {type: "require-level", levelChoiceId: "spell-slot", min: 1, max: 5},
        {type: "add-cost", cost: {allOf: [{capability: "overchannel", amount: 1}]}},
        {type: "maximize-damage"},
        {type: "add-source-damage", damage: [{id: "overchannel", expression: {type: "dice", number: 0, faces: 12},
          damageType: "necrotic", ignoreResistance: true, ignoreImmunity: true}]},
        {type: "scale-damage", collection: "sourceDamage", componentIds: ["overchannel"], levelChoiceId: "spell-slot", baseLevel: 0,
          dice: {faces: 12, number: overchannelDice()}}]}]}}
});

/** Overchannel's d12s per slot level: none on its first use since a Long Rest, else one more than the uses before it. */
function overchannelDice() {
  const before = {type: "subtract", terms: [{type: "resource-max", resource: "overchannel"}, {type: "resource-current", resource: "overchannel"}]};
  return {type: "multiply", terms: [{type: "min", terms: [before, {type: "constant", value: 1}]},
    {type: "add", terms: [before, {type: "constant", value: 1}]}]};
}

/**
 * Features the engine offers itself when they apply, or that are
 * rows of another feature's Action (Eldritch Master in Magical Cunning; Heightened Focus in Monk's Focus: Flurry's third
 * strike, Patient Defense's Temporary Hit Points; its carrying Step of the Wind is its own Action, FEATURE_ACTIONS), or that mark a spell on the sheet (Spell Mastery, Signature Spells:
 * SPELL_CHOICES). Their dnd5e activities are neither Actions nor notes.
 */
const OFFERED_BY_ENGINE = new Set(["eldritch-master", "heightened-focus", "spell-mastery", "signature-spells"]);

/** The pool of Pact Magic slots (helpers/spellcasting.mts). */
const PACT_SLOT_POOL = "spell-slot.pact";

/**
 * 2024 Magical Cunning: Pact Magic slots back, half the maximum rounded up; all of them from warlock level 20
 * (Eldritch Master), refused while none is spent. shortcut: its 1-minute rite is not timed.
 */
const MAGICAL_CUNNING_RESTORE = Object.freeze({resourceId: PACT_SLOT_POOL, amount: 1, refuseWhenFull: true, amountExpression: {
  type: "table", key: {type: "class-level", class: "warlock"}, rows: {
    1: {type: "divide", numerator: {type: "resource-max", resource: PACT_SLOT_POOL}, denominator: {type: "constant", value: 2}, round: "ceil"},
    20: {type: "resource-max", resource: PACT_SLOT_POOL}}}});

/**
 * 2024 Mystic Arcanum: one spell of each level 6 to 9 cast without a slot once per Long Rest, from warlock levels 11,
 * 13, 15 and 17: a pool per level, which the spell its warlock marks as that level's arcanum may spend (SPELL_CHOICES).
 */
const MYSTIC_ARCANUM_POOLS = Object.freeze([[6, 11], [7, 13], [8, 15], [9, 17]].map(([level, from]) => ({schemaVersion: 1,
  id: `mystic-arcanum-${level}`, type: "GrantResource", data: {resourceId: `mystic-arcanum.${level}`, label: `Mystic Arcanum (level ${level})`,
    maximum: {type: "table", key: {type: "class-level", class: "warlock"}, rows: {[from]: 1}, default: 0}, recovery: "longRest"}})));

/**
 * 2024 Signature Spells (wizard 20): two level 3 spells, each cast at level 3 without a slot once per Short or Long Rest:
 * a pool for each, which the spell its wizard marks as that signature spell may spend (SPELL_CHOICES). Spell Mastery's
 * spells cost nothing and need no pool.
 */
const SIGNATURE_SPELL_POOLS = Object.freeze([1, 2].map(n => ({schemaVersion: 1, id: `signature-spell-${n}`, type: "GrantResource",
  data: {resourceId: `signature-spell.${n}`, label: `Signature Spell ${n}`, maximum: 1, recovery: "shortRest"}})));

/**
 * Features that let their creature mark spells on the sheet (`flags.wildpath.spellChoice`, spellcasting.mts): the spell's
 * own flag, the levels it may mark, how many, the costs it needs, the pool it then spends (`{n}`, `{level}`) or none (free).
 * Mystic Arcanum: one spell of each level 6 to 9, from that level's arcanum. Spell Mastery: a level 1 and a level 2 spell
 * cast with an Action, free. Signature Spells: two level 3 spells, each from its own pool.
 */
const SPELL_CHOICES = Object.freeze({
  "mystic-arcanum": {flag: "arcanum", levels: [6, 7, 8, 9], resourceId: "mystic-arcanum.{level}"},
  "spell-mastery": {flag: "mastered", levels: [1, 2], costs: ["action"]},
  "signature-spells": {flag: "signature", levels: [3], count: 2, resourceId: "signature-spell.{n}"}
});

/**
 * A spell a feature lets its creature cast without a slot, from a pool of the feature's (action-definitions withFreeCasts):
 * Faithful Steed's Find Steed once per Long Rest (its paladin class grants the spell, always prepared).
 */
const FREE_CASTS = Object.freeze({"faithful-steed": {spells: ["find-steed"], recovery: "longRest"},
  // 2024 Dragon Companion: Summon Dragon once per Long Rest without a slot (its dnd5e uses are this pool). shortcut: casting it
  // without Concentration (1 minute) is by hand; upgrade with a free cast's own configuration.
  "dragon-companion": {spells: ["summon-dragon"], recovery: "longRest", note: "free cast: Summon Dragon without Concentration (1 minute) is by hand"},
  // Its level 1 spell, whichever it gave (`granted`); each copy of the feat its own pool (`perItem`: `{item}` in the pool's
  // id is the feat Item's id), since the feat may be taken again with another list.
  "magic-initiate": {spells: [], granted: true, perItem: true, recovery: "longRest"},
  // The PHB's Favored Enemy is a feature beside the Hunter's Mark its ranger is granted (the SRD's is a Hunter's Mark
  // Action with this pool): its free casts by ranger level.
  "favored-enemy": {spells: ["hunters-mark"], recovery: "longRest",
    maximum: {type: "table", key: {type: "class-level", class: "ranger"}, rows: {1: 2, 5: 3, 9: 4, 13: 5, 17: 6}}},
  // 2024 Natural Recovery: one of the level 1+ spells its Circle of the Land Spells gave, once per Long Rest.
  "natural-recovery": {spells: [], fromFeatures: ["circle-of-the-land-spells"], recovery: "longRest"}});
const freeCastResource = identifier => `free-cast.${identifier}${FREE_CASTS[identifier]?.perItem ? ".{item}" : ""}`;

/**
 * A feature dnd5e leaves without automation, as the effects its use puts on its creature. 2024 Steady Aim: Advantage
 * on its next attack roll this turn, and Speed 0 until the turn ends; only while it hasn't moved this turn (`requires`).
 */
/** It hasn't moved this turn: no movement spent (Steady Aim). shortcut: outside combat movement is never reset. */
const NOT_MOVED = Object.freeze({equals: {path: "actorSystem.resources.movement.spent", value: 0}});

const SELF_EFFECTS = Object.freeze({
  // A monk's Elemental Attunement, 10 minutes: the `elemental-attunement` status Stride of the Elements reads.
  "elemental-attunement/Activate Attunement": [{id: "effect-1", type: "effect", name: "Elemental Attunement", slug: "elemental-attunement",
    img: "icons/svg/fire.svg", duration: {value: 10, units: "minutes"}}],
  "steady-aim": [{id: "effect-1", type: "effect", name: "Steady Aim", img: "icons/svg/target.svg", endsWhen: "attacks",
    duration: {value: 0, units: "turns", expiry: "turnEnd"},
    ruleElements: [{schemaVersion: 1, id: "steady-aim", type: "RollMode", data: {domains: ["attack"], mode: "advantage"}}]},
  {id: "effect-2", type: "effect", name: "Steady Aim (Speed 0)", img: "icons/svg/target.svg", duration: {value: 0, units: "turns", expiry: "turnEnd"},
    // Not an Assassin's (Infiltration Expertise: its Speed isn't 0).
    ruleElements: [{schemaVersion: 1, id: "steady-aim-speed", type: "Modifier", predicate: {not: {hasFeature: "infiltration-expertise"}},
      data: {domains: ["speed.multiplier"], modifierType: "untyped", value: 0}}]}]
});

/**
 * Its own die for a failed d20 test, which the engine offers (`flags.wildpath.testOffer`): 2024 Peerless Skill (its
 * Bardic Inspiration die on a check or attack roll, kept if it still fails), Dark One's Own Luck (a d10 on a check or
 * save). shortcut: offered only on a failed roll (Dark One's Own Luck may also be added to one that succeeded).
 */
/**
 * 2024 Portent (Diviner, PHB): the d20s it rolls after each Long Rest, two, three from level 14 (Greater Portent).
 * Its feature's flag (`flags.wildpath.portentDice`); the engine rolls and offers them (adapters/foundry-v14-portent).
 */
const PORTENT_DICE = Object.freeze({type: "table", key: {type: "class-level", class: "wizard"}, rows: {1: 2, 14: 3}});

const TEST_OFFERS = Object.freeze({
  "peerless-skill": {tests: ["check", "attack"], refundOnFail: true},
  "dark-ones-own-luck": {tests: ["check", "save"]},
  // 2024 Stroke of Luck: a failed D20 Test becomes a 20, once per Short Rest.
  "stroke-of-luck": {tests: ["check", "save", "attack"], setNatural: 20},
  // 2024 Boon of Combat Prowess, Peerless Aim: "When you miss with an attack roll, you can hit instead", once until the start
  // of its next turn (its own pool, which TRAITS gives: dnd5e gives the boon no activity). shortcut: one d20 against several
  // targets hits each it missed.
  "boon-of-combat-prowess": {tests: ["attack"], pool: "boon-of-combat-prowess", forceHit: true},
  // 2024 Countercharm: a save failed against Charmed or Frightened, by itself or an ally within 30 ft, rerolled with
  // Advantage for its Reaction (withAllyTestOffers). Its pool is named here: its activity spends none.
  countercharm: {tests: ["save"], pool: "reaction", rollMode: "advantage", range: 30, against: ["charmed", "frightened"]},
  // Tasha's Flash of Genius: when it or a creature it sees within 30 feet fails an ability check or save, its Intelligence
  // modifier is added, for its Reaction and a use (its own pool, named by its identifier). shortcut: "you can see" is any
  // ally within range, and it is offered only on a failure (as every test offer is).
  "flash-of-genius": {tests: ["check", "save"], pool: "flash-of-genius", reaction: true, range: 30, addAbility: "intellect"},
  // A Sphinx of Wonder's Burst of Ingenuity: when it or a creature within 30 feet makes a check or save, 2 added to the
  // roll, for its Reaction and a use (2/Day). shortcut: offered only on a failure, and to its allies only.
  "burst-of-ingenuity": {tests: ["check", "save"], pool: "burst-of-ingenuity", reaction: true, range: 30, add: 2},
  // 2024 Boon of Fate (Improve Fate): when it or a creature within 60 feet fails a D20 Test, 2d4 added to the roll, once
  // per Short Rest or Initiative (TRAITS restores it). shortcut: offered on a failure only, so the 2d4 penalty on another
  // creature's success is by hand (noted).
  "boon-of-fate": {tests: ["check", "save", "attack"], pool: "boon-of-fate", range: 60, faces: {type: "constant", value: 4}, number: 2},
  // 2024 Disciplined Survivor: a failed save rerolled for 1 Focus Point (its activity's).
  "disciplined-survivor": {tests: ["save"], reroll: true},
  // 2024 Indomitable: a failed save rerolled with a bonus of its activity's roll (its fighter level), from its own uses.
  indomitable: {tests: ["save"], reroll: true},
  // 2024 Tactical Mind: a failed check adds its 1d10, paid from Second Wind (its activity's), not spent if it still fails.
  "tactical-mind": {tests: ["check"], refundOnFail: true},
  // 2024 Seeking Spell: a missed spell attack rerolled for a Sorcery Point (its activity's Font of Magic).
  "seeking-spell": {tests: ["attack"], reroll: true, tagsAll: ["spell"]},
  // Fanatical Focus: while raging, a failed save rerolled with its Rage Damage bonus, once per Rage (its own pool, refilled
  // by its Rage: FEATURE_ACTIONS). dnd5e gives it no activity, so its bonus is a formula here.
  "fanatical-focus": {tests: ["save"], reroll: true, pool: "fanatical-focus", whileStatus: "raging", bonusFormula: "@scale.barbarian.rage-damage"}
});

/** 2024 Luck (halfling): a 1 on the d20 of a D20 Test rerolled, free. shortcut: offered only when the roll failed. */
const HALFLING_LUCK = Object.freeze({tests: ["check", "save", "attack"], reroll: true, natural: 1});

/** The die of a test offer: "1d10", or a scale's die ("@scale.bard.inspiration") as its faces. */
function testOfferFaces(formula, scales) {
  const text = String(formula ?? "").trim();
  const flat = /^1?d(\d+)$/i.exec(text);
  if ( flat ) return {type: "constant", value: Number(flat[1])};
  return /^@scale\.[a-z0-9-]+\.[a-z0-9-]+$/i.test(text) ? formulaExpression(`${text}.faces`, {scales}) : null;
}

/** Used at the start of its creature's turn, though dnd5e gives it no activation (2024 Superior Defense): a free Action. */
const USED_AT_TURN_START = new Set(["superior-defense"]);

// 2024 Open Hand Technique: a hit of a Flurry of Blows strike (tagged `flurry`) offers one of three, each its own offer.
const openHand = (extra={}) => ({tagsAll: ["flurry"], definition: definition => definition, ...extra});

// A weapon hit's extra damage of a type its creature picks, once a turn: each type an offer (Divine Strike's Radiant
// or Necrotic) or a type choice (Primal Strike's four), on a hit with any weapon, melee or ranged.
const weaponHit = onceKey => ({tagsAll: ["weapon"], once: "turn", onceKey, definition: definition => definition});

/** A hit offer only on a creature no bigger than `size` (Hill's Tumble's Large or smaller): its whole point. */
const sizeAtMost = size => ({not: {oneOf: {path: "event.data.targetSize",
  values: ["tiny", "small", "medium", "large", "huge", "gargantuan"].slice(["tiny", "small", "medium", "large", "huge", "gargantuan"].indexOf(size) + 1)}}});

/**
 * A feature its creature uses as it hits, by its text: "When you hit a creature with an attack roll, you can expend one
 * Superiority Die" (a Battle Master's maneuvers), "once on each of your turns when you hit a creature with a weapon"
 * (Favored Foe). Offered on its own hits as OWN_HIT's are: a weapon's when its text says weapon, else any attack's; once
 * a turn when it says so. Its cost, damage, save and effects are its activity's.
 */
/**
 * The paragraph of an item's 2024 text its activity names ("Thunderclap. You can take a Magic action ..."), up to the
 * next one another activity names; the whole text when it names none. So one property's "when you hit" (a Staff of
 * Thunder and Lightning's Lightning) does not make its Magic actions hit offers.
 */
export function activityText(document, activity) {
  const text = plainText(document);
  const escape = name => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const at = name => {
    const found = new RegExp(`(?:^\\s*|[.)]\\s+)${escape(name)}\\.\\s`, "u").exec(text);
    return found ? found.index + found[0].indexOf(name) : -1;
  };
  const start = activity?.name ? at(activity.name) : -1;
  if ( start < 0 ) return text;
  const ends = Object.values(document.system?.activities ?? {}).map(entry => entry?.name)
    .filter(name => name && (name !== activity.name)).map(at).filter(index => index > start);
  return text.slice(start, ends.length ? Math.min(...ends) : undefined);
}

function hitOffer(document, activity) {
  if ( !["damage", "save"].includes(activity?.type) ) return null;
  const text = `${activity.activation?.condition ?? ""} ${activityText(document, activity)}`;
  const hit = /\bwhen (?:you|it|the [^.,]{1,40}?) hits? (?:a creature|a target|an enemy|one or more creatures|a creature or an object)? ?with (an attack roll|a weapon|a melee weapon|a melee attack|an attack)/iu
    .exec(text);
  if ( !hit ) return null;
  const once = /\bonce (?:per turn|on each of (?:your|its) turns)\b/iu.test(text);
  // A part of any type (dnd5e lists every one: "add the die to the attack's damage roll") is the attack's own type: a
  // rider on the attack it answers, whose type is the attack's.
  const anyType = (activity.damage?.parts ?? []).map(part => (part.types ?? []).length >= DAMAGE_TYPES.length);
  // No Action is taken in the middle of a hit: dnd5e's "action" activation on such an offer (a Staff of Striking's Charge
  // Damage) costs nothing of the turn's economy. A Bonus Action or Reaction it names stays.
  const free = definition => ({...definition, costs: {...(definition.costs ?? {}),
    allOf: (definition.costs?.allOf ?? []).filter(cost => cost.capability !== "action")}});
  const riding = definition => {
    const ride = (definition.damage ?? []).filter((_, index) => anyType[index]);
    return free(ride.length ? {...definition, damage: (definition.damage ?? []).filter((_, index) => !anyType[index]),
      rider: {...(definition.rider ?? {}), damage: ride.map(({damageType: _type, ...component}) => component)}} : definition);
  };
  return {...(/weapon/iu.test(hit[1]) ? {tagsAll: ["weapon"]} : {spell: true, tagsAll: []}),
    ...(once ? {once: "turn", onceKey: slugify(document.name)} : {}), ...(anyType.some(Boolean) ? {dropNotes: /: a choice of acid\//u} : {}),
    definition: riding};
}

/**
 * A stat block attack's save on the creature it hits (2024 Ghoul's Claw: "it is subjected to the following effect"): an
 * automatic offer on this Item's own hits (its attack's Action carries `hit:<item>`). Not one with a condition of its own
 * (an Otyugh's after a Long Rest). shortcut: a clause on who is spared ("unless it is an Undead or an Elf") is by hand;
 * upgrade when an offer reads its text's creature types.
 */
function attackRider(document, activity, activities) {
  if ( (activity?.type !== "save") || !["", "none", "special"].includes(activity.activation?.type ?? "") || activity.activation?.condition
    || !activities.some(entry => entry.type === "attack") || !saveAbilitiesOf(document, activity).length
    || !/\b(?:is )?subject(?:ed)? to the following effect\b|\bmust make the following saving throw\b/iu.test(plainText(document)) ) return null;
  return {spell: true, tagsAll: [`hit:${slugify(document.name)}`], always: true, keepNotes: true,
    definition: definition => ({...definition, costs: {allOf: []}})};
}

/**
 * A save activity's abilities (dnd5e's: `str`, `dex`, ...). None set: the one its text names, in a spell's wording ("a
 * Dexterity saving throw": 2024 Lightning Arrow) or a stat block's ("Constitution Saving Throw: DC 21": a Pit Fiend's Bite).
 */
function saveAbilitiesOf(document, activity) {
  const abilities = [].concat(activity?.save?.ability ?? []).filter(Boolean);
  if ( abilities.length ) return abilities;
  const named = [...new Set([...plainText(document).matchAll(/\b(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) saving throw/giu)]
    .map(match => match[1].slice(0, 3).toLowerCase()))];
  return (named.length === 1) ? named : [];
}

const OWN_HIT = Object.freeze({
  // 2024 Blessed Strikes: Divine Strike, 1d8 (2d8 from cleric level 14, its scale).
  "blessed-strikes-divine-strike/Necrotic Divine Strike": weaponHit("divine-strike"),
  "blessed-strikes-divine-strike/Radiant Divine Strike": weaponHit("divine-strike"),
  // 2024 Elemental Fury: Primal Strike, Cold, Fire, Lightning or Thunder.
  "elemental-fury-primal-strike/Primal Strike": weaponHit("primal-strike"),
  // Eldritch Invocation Lifedrinker: Necrotic, Psychic or Radiant 1d6. shortcut: any weapon, not only its pact weapon;
  // its Hit Die heal is by hand.
  "lifedrinker/": weaponHit("lifedrinker"),
  // Eldritch Invocation Repelling Blast: a cantrip's attack hit may push its creature 10 feet away (house rule: a
  // feature changing a chosen cantrip changes every cantrip). The push rides on the attack it answers (`rider.push`, as
  // Forceful Blow's), only on a creature Large or smaller.
  "repelling-blast/Make Repelling": {tagsAll: ["cantrip"], spell: true, triggerPredicate: sizeAtMost("large"),
    rider: {push: {distance: 10, maxSize: "large"}}, definition: definition => definition},
  "open-hand-technique/Addle": openHand({definition: definition => ({...definition, effects: [{id: "effect-1", type: "effect",
    name: "Addled", slug: "no-opportunity-attacks", img: "icons/svg/daze.svg", duration: {value: 1, units: "rounds", expiry: "turnStart"},
    ruleElements: []}]})}),
  // The feature's one text gives both its push and its Prone: Push pushes, Topple knocks Prone.
  "open-hand-technique/Push": openHand({definition: definition => ({...definition, effects: []})}),
  "open-hand-technique/Topple": openHand({definition: ({push: _push, ...definition}) => definition}),
  "cunning-strike/Poison": cunning(),
  // Poison's repeated save is in the same text; Prone has none.
  "cunning-strike/Trip": cunning({triggerPredicate: sizeAtMost("large"), definition: definition => ({...definition,
    effects: (definition.effects ?? []).map(({repeatSave, ...effect}) => ({...effect, maxSize: "large"}))})}),
  "cunning-strike/Withdraw": cunning({self: true, definition: definition => ({...definition, effects: [structuredClone(WITHDRAW)]})}),
  // 2024 Devious Strikes (rogue 14): three more Cunning Strike options, each giving up more Sneak Attack dice. Only
  // Knock Out repeats its save (its text names it) and ends when the creature takes damage (`metadata.endsWhen`); Daze
  // and Obscure last until the end of the target's next turn. Daze: "it can do only one of the following: move or take an
  // action or a Bonus Action" (DAZED: once one is used, the others are capped at 0).
  "devious-strikes/Daze": cunning({rider: {forgoDice: {ruleId: "sneak-attack", dice: 2}}, definition: definition => {
    const dazed = deviousStrike()(definition);
    return {...dazed, effects: dazed.effects.map(effect => ({...effect, slug: "dazed", ruleElements: structuredClone(DAZED)}))};
  }}),
  "devious-strikes/Knock Out": cunning({rider: {forgoDice: {ruleId: "sneak-attack", dice: 6}}, definition: definition => {
    const out = deviousStrike({duration: {value: 1, units: "minutes"}, repeatSave: "turnEnd"})(definition);
    return {...out, effects: out.effects.map(effect => ({...effect, metadata: {...(effect.metadata ?? {}), endsWhen: "damaged"}}))};
  }}),
  "devious-strikes/Obscure": cunning({rider: {forgoDice: {ruleId: "sneak-attack", dice: 3}}, definition: deviousStrike()}),
  // Eldritch Invocation Eldritch Smite: a Pact Magic slot spent on a weapon hit, (1 + its level)d8 Force, and Prone if its
  // warlock chooses ("can"; on by default) and the creature is Huge or smaller. shortcut: any weapon, not only its pact
  // weapon.
  "eldritch-smite/Smite": {...weaponHit("eldritch-smite"), dropNotes: /custom formula/, definition: ({consumption: _consumption, ...definition}) => ({...definition,
    costs: {allOf: []}, damage: [{id: "damage-1", expression: {type: "dice", number: 1, faces: 8}, damageType: "force", provenance: "additional"}],
    configuration: [{id: "spell-slot", type: "resource", label: "Pact Magic slot", required: true,
      cost: {anyOf: [[{capability: PACT_SLOT_POOL, amount: 1}]]},
      effects: [{type: "scaleDamage", levelChoiceId: "spell-slot", baseLevel: 0, componentIds: ["damage-1"], dice: {number: 1, faces: 8}}]},
    {id: "prone", type: "option", label: "Prone", required: true, defaultValue: "prone",
      options: [{id: "prone", label: "Knock it Prone", value: "prone"}, {id: "standing", label: "Leave it standing", value: "standing"}],
      effects: [{type: "keepEffect", effectIds: ["effect-1"], keep: {prone: ["effect-1"], standing: []}}]}],
    effects: [{id: "effect-1", type: "condition", conditionId: "prone", maxSize: "huge"}]})},
  // 2024 Hurl Through Hell (Fiend Patron 14): once a turn, on any attack hit, a Charisma save; on a failure 8d10 Psychic
  // and Incapacitated until the end of the warlock's next turn. shortcut: a Fiend's immunity to the damage is by hand.
  "hurl-through-hell/Hurl Through Hell": {spell: true, tagsAll: [], once: "turn", definition: definition => ({...definition,
    damage: (definition.damage ?? []).map(component => ({...component, saveOutcomePolicy: {success: "none", failure: "full"}})),
    effects: [{id: "effect-1", type: "condition", conditionId: "incapacitated", saveOutcomePolicy: "failure",
      duration: {value: 1, units: "rounds", expiry: "sourceTurnEnd"}}]})},
  // 2024 Goliath Giant Ancestry: on any attack hit, a use of its pool (Proficiency Bonus a Long Rest).
  "fires-burn/Burn": {spell: true, tagsAll: [], definition: definition => definition},
  // shortcut: its Speed penalty lasts until the start of the goliath's next turn, as Hamstrung's.
  "frosts-chill/Chill": {spell: true, tagsAll: [], definition: definition => ({...definition, effects: [{id: "effect-1", type: "effect",
    name: "Frost's Chill", img: "icons/svg/frozen.svg", duration: {value: 1, units: "rounds", expiry: "turnStart"},
    ruleElements: [{schemaVersion: 1, id: "chilled", type: "Modifier", data: {domains: ["resources.movement.max", "speed"], modifierType: "untyped",
      value: -10}}]}]})},
  // Only on a creature Large or smaller.
  "hills-tumble/Hill's Tumble": {spell: true, tagsAll: [], triggerPredicate: sizeAtMost("large"), definition: definition => ({...definition,
    effects: [{id: "effect-1", type: "condition", conditionId: "prone", maxSize: "large"}]})},
  "stunning-strike": {once: "turn", definition: definition => ({...definition,
    configuration: (definition.configuration ?? []).filter(choice => choice.id !== "effect-choice"),
    effects: [{id: "effect-1", type: "condition", conditionId: "stunned", saveOutcomePolicy: "failure",
      duration: {value: 1, units: "rounds", expiry: "sourceTurnStart"}},
    // A success: the next attack roll against it before the monk's next turn has Advantage.
    {id: "effect-2", type: "effect", name: "Stunning Strike", img: "icons/svg/daze.svg", saveOutcomePolicy: "success",
      ruleElements: [{schemaVersion: 1, id: "staggered", type: "RollMode", data: {domains: ["attacked"], mode: "advantage"}}],
      duration: {value: 1, units: "rounds", expiry: "turnStart"}, endsWhen: "attacked"},
    // and its Speed is halved until then.
    {id: "effect-3", type: "effect", name: "Slowed", img: "icons/svg/daze.svg", saveOutcomePolicy: "success",
      ruleElements: [{schemaVersion: 1, id: "slowed", type: "Modifier", data: {domains: ["speed.multiplier"], modifierType: "untyped", value: 0.5}}],
      duration: {value: 1, units: "rounds", expiry: "turnStart"}}]})}
});

/**
 * 2024 Brutal Strike: while Reckless, its barbarian may give up the Advantage of a Strength attack roll on its turn (one
 * without Disadvantage); if it hits, the target takes 1d10 more of the weapon's damage type (2d10 from level 17), and
 * one blow follows: Forceful Blow pushes it 15 feet and lets the barbarian move half its Speed without provoking
 * Opportunity Attacks; Hamstring Blow lowers its Speed by 15 feet until the start of the barbarian's next turn.
 * - Brutal Strike answers its own declared attack (`action.declared`, `whileStatus: "reckless"`, a predicate on the
 *   attack's mode and ability), once a turn; its rider gives up the Advantage, adds the damage and tags the attack.
 * - Each blow answers a hit so tagged, once a turn between them.
 * shortcut: Forceful Blow's "toward the target" is by hand.
 */
/**
 * 2024 Flurry of Blows' strikes: a pool its Flurry fills (2; 3 from monk level 10, Heightened Focus), empty at the start
 * of each turn.
 */
const FLURRY_POOL = Object.freeze({schemaVersion: 1, id: "flurry-of-blows-strikes", type: "GrantResource", data: {
  resourceId: "flurry-of-blows", label: "Flurry of Blows", maximum: {type: "table", key: {type: "class-level", class: "monk"},
    rows: {1: 2, 10: 3}}, current: 0, recovery: "none", emptiesAtTurnStart: true}});

/**
 * 2024 Martial Arts: Unarmed Strikes with the Martial Arts die (a table by monk level) and the better of Strength and
 * Dexterity (the finesse property). One costs its Action (Extra Attack pays it too), one a Bonus Action, and one a
 * Flurry of Blows strike, tagged `flurry` (Open Hand Technique answers its hits).
 */
function martialArtsActions(document, img, source, scales) {
  const {id: _id, label: _label, costs: _costs, ...unarmed} = commonAction({uuid: ""}, "unarmed").system.definition;
  const die = formulaExpression("@scale.monk.die", {scales}) ?? {type: "dice", number: 1, faces: 6};
  const strike = {...unarmed, attack: {...unarmed.attack, properties: ["finesse"]},
    damage: unarmed.damage.map(component => ({...component, expression: die}))};
  // The Bonus strike and the Action's need no armor or Shield (Martial Arts); a Flurry strike its Focus already paid for
  // doesn't. shortcut: an armored monk's Flurry strike keeps the Martial Arts die.
  const make = (suffix, key, costs, extra={}, ruleElements=[], gated=true) => {
    const id = stableId(`${document._id}:${key}`);
    const name = `${document.name} (${suffix})`;
    return {_id: id, _key: `!items!${id}`, name, type: "action", img, system: {active: true, description: "", definition: {
      schemaVersion: 1, id: `action:srd-martial-arts-${key}`, label: name, costs: {allOf: costs}, ...structuredClone(strike), ...extra,
      ...(gated ? {requires: structuredClone(UNARMORED)} : {})},
    ruleElements}, flags: {wildpath: {source, conversion: {notes: []}}}};
  };
  return [make("Unarmed Strike", "strike", [{capability: "action", amount: 1}]),
    make("Bonus Unarmed Strike", "bonus", [{capability: "bonus-action", amount: 1}]),
    make("Flurry of Blows Strike", "flurry", [{capability: "flurry-of-blows", amount: 1}], {tags: ["flurry"]}, [structuredClone(FLURRY_POOL)], false)];
}

/**
 * 2024 Martial Arts with Monk weapons (Simple Melee weapons, and Martial Melee weapons with the Light property): the
 * Martial Arts die in place of the weapon's own when larger, and Dexterity in place of Strength when better.
 */
/** Features whose passive rules hold only while their creature wears what their 2024 text allows (`wearing`). */
const WEARING_GATES = Object.freeze({"unarmored-movement": {armor: false, shield: false}, "fast-movement": {heavy: false}});
/** Actions used only while their creature wears what their 2024 text allows (`requires`). */
const USED_WHILE_WEARING = Object.freeze({rage: {heavy: false}});

/** 2024 Martial Arts and Unarmored Movement: "while you aren't wearing armor or wielding a Shield". */
const UNARMORED = Object.freeze({wearing: {armor: false, shield: false}});
const MONK_WEAPON = Object.freeze({all: [{tagsAll: ["melee"]}, {any: [{tagsAll: ["category:simple"]}, {tagsAll: ["category:martial", "light"]}]},
  UNARMORED]});
function monkWeaponRules(scales) {
  const die = formulaExpression("@scale.monk.die", {scales}) ?? {type: "dice", number: 1, faces: 6};
  return [{schemaVersion: 1, id: "martial-arts-die", type: "ExtraDamage", predicate: MONK_WEAPON,
    data: {domains: ["damage.weapon"], expression: die, replacesBase: true}},
  ...["attack", "damage"].map(domain => ({schemaVersion: 1, id: `martial-arts-dexterity-${domain}`, type: "Modifier",
    predicate: {all: [MONK_WEAPON, {tagsAll: ["might"]}]}, data: {domains: [domain], modifierType: "untyped",
      valueExpression: {type: "max", terms: [{type: "constant", value: 0}, {type: "subtract",
        left: {type: "ability-modifier", ability: "agility"}, right: {type: "ability-modifier", ability: "might"}}]}}}))];
}

/** The spell schools dnd5e abbreviates. */
const SCHOOLS = Object.freeze({abj: "abjuration", con: "conjuration", div: "divination", enc: "enchantment", evo: "evocation",
  ill: "illusion", nec: "necromancy", trs: "transmutation"});

/**
 * An ability modifier added to spell damage under `predicate` (Potent Spellcasting, Empowered Evocation), once a roll;
 * `oneRoll`, to only one damage roll of the spell ("one damage roll of that spell": not each of Scorching Ray's rays).
 */
function spellDamageBonus(activities, ability, predicate, {oneRoll=false}={}) {
  return {rules: [{schemaVersion: 1, id: `spell-damage-${ability}`, type: "Modifier", predicate, data: {domains: ["damage.spell"],
    modifierType: "untyped", valueExpression: {type: "ability-modifier", ability}, ...(oneRoll ? {metadata: {oneRoll: true}} : {})}}],
  consumes: activities.filter(entry => entry.type === "damage"), notes: []};
}

/**
 * 2024 Elemental Affinity: its type, chosen once (Acid, Cold, Fire, Lightning or Poison), is a lasting effect on the
 * sorcerer: Resistance to it, and its Charisma modifier on a spell's damage of that type. shortcut: the choice is an
 * Action used once, not tied to its Draconic ancestry.
 */
function elementalAffinityAction(document, img, source) {
  const types = ["acid", "cold", "fire", "lightning", "poison"];
  const title = type => `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
  const id = stableId(`${document._id}:choose`);
  const name = `${document.name} (Choose)`;
  const effect = type => ({id: type, type: "effect", name: `${document.name} (${title(type)})`, slug: "elemental-affinity", img,
    ruleElements: [{schemaVersion: 1, id: `affinity-${type}`, type: "Modifier", predicate: {tagsAll: [`damage:${type}`]},
      // "one damage roll of that spell"
      data: {domains: ["damage.spell"], modifierType: "untyped", valueExpression: {type: "ability-modifier", ability: "presence"},
        metadata: {oneRoll: true}}},
    {schemaVersion: 1, id: `affinity-${type}-resistance`, type: "GrantResistance", data: {damageTypes: [type]}}]});
  return {_id: id, _key: `!items!${id}`, name, type: "action", img, system: {active: true, description: "", definition: {schemaVersion: 1,
    id: "action:srd-elemental-affinity", label: name, costs: {allOf: []}, range: {type: "self"}, targeting: {type: "self"},
    effects: types.map(effect), configuration: [{id: "type", type: "select-one", label: "Damage type", required: true,
      options: types.map(type => ({id: type, label: title(type), value: type})), effects: [{type: "keepEffect", effectIds: types}]}]},
  ruleElements: []}, flags: {wildpath: {source, conversion: {notes: []}}}};
}

/**
 * Genie's Wrath: once a turn, an attack roll's hit deals extra damage equal to its Proficiency Bonus, of its patron's
 * type: an Action choosing that type once (Elemental Affinity's shape). The `damage.melee`/`damage.ranged` domains are an
 * attack roll's alone. shortcut: once a turn on any turn, not only its own (no own-turn predicate), as Favored Foe;
 * upgrade when predicates see whose turn it is.
 */
function geniesWrathAction(document, img, source) {
  const types = ["bludgeoning", "thunder", "fire", "cold"];
  const title = type => `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
  const id = stableId(`${document._id}:choose`);
  const name = `${document.name} (Choose)`;
  const effect = type => ({id: type, type: "effect", name: `${document.name} (${title(type)})`, slug: "genies-wrath", img,
    ruleElements: [{schemaVersion: 1, id: `genies-wrath-${type}`, type: "ExtraDamage", data: {domains: ["damage.melee", "damage.ranged"],
      expression: {type: "proficiency-bonus"}, damageType: type, once: "turn"}}]});
  return {_id: id, _key: `!items!${id}`, name, type: "action", img, system: {active: true, description: "", definition: {schemaVersion: 1,
    id: "action:srd-genies-wrath", label: name, costs: {allOf: []}, range: {type: "self"}, targeting: {type: "self"},
    effects: types.map(effect), configuration: [{id: "type", type: "select-one", label: "Damage type", required: true,
      options: types.map(type => ({id: type, label: title(type), value: type})), effects: [{type: "keepEffect", effectIds: types}]}]},
  ruleElements: []}, flags: {wildpath: {source, conversion: {notes: []}}}};
}

/**
 * 2024 Fiendish Resilience: "Choose one damage type, other than Force, whenever you finish a Short or Long Rest. You have
 * Resistance to that damage type until you choose a different one": an Action choosing it, once per rest (its feature's
 * pool), each choice replacing the last. shortcut: chosen with the Action after a rest, not asked as the rest ends.
 */
function fiendishResilienceAction(document, img, source) {
  const types = DAMAGE_TYPES.filter(type => type !== "force");
  const title = type => `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
  const id = stableId(`${document._id}:choose`);
  const name = `${document.name} (Choose)`;
  const effect = type => ({id: type, type: "effect", name: `${document.name} (${title(type)})`, slug: "fiendish-resilience", img,
    ruleElements: [{schemaVersion: 1, id: `resilience-${type}`, type: "GrantResistance", data: {damageTypes: [type]}}]});
  return {_id: id, _key: `!items!${id}`, name, type: "action", img, system: {active: true, description: "", definition: {schemaVersion: 1,
    id: "action:srd-fiendish-resilience", label: name, costs: {allOf: [{capability: "fiendish-resilience", amount: 1}]},
    range: {type: "self"}, targeting: {type: "self"}, effects: types.map(effect),
    configuration: [{id: "type", type: "select-one", label: "Damage type", required: true,
      options: types.map(type => ({id: type, label: title(type), value: type})), effects: [{type: "keepEffect", effectIds: types}]}]},
  ruleElements: []}, flags: {wildpath: {source, conversion: {notes: []}}}};
}

/**
 * 2024 Defensive Tactics (Hunter 7): one of two options, which a Short or Long Rest lets it change (its pool), as Fiendish
 * Resilience's types. Escape the Horde: Opportunity Attacks against it have Disadvantage (`attack.opportunity`, the
 * reaction's). Multiattack Defense: "When a creature hits you with an attack roll, that creature has Disadvantage on all
 * other attack rolls against you this turn": a free reaction marking the attacker (`attack.fromTarget`, Bestow Curse's
 * pattern).
 */
function defensiveTacticsAction(document, img, source) {
  const id = stableId(`${document._id}:choose`);
  const name = `${document.name} (Choose)`;
  const rule = (ruleId, predicate, domains) => ({schemaVersion: 1, id: ruleId, type: "RollMode", predicate, data: {domains, mode: "disadvantage"}});
  const defended = {id: "effect-1", type: "effect", name: "Multiattack Defense", slug: "multiattack-defended",
    duration: {value: 0, units: "turns", expiry: "turnEnd"},
    ruleElements: [rule("multiattack-defended", {equals: {path: "attack.fromTarget.multiattack-defended", value: true}}, ["attack"])]};
  const options = [
    {id: "escape-the-horde", label: "Escape the Horde",
      ruleElements: [rule("escape-the-horde", {equals: {path: "attack.opportunity", value: true}}, ["attacked"])]},
    {id: "multiattack-defense", label: "Multiattack Defense", ruleElements: [{schemaVersion: 1, id: "multiattack-defense", type: "Trigger",
      data: {kind: "reaction", event: "attack.hit", match: {phase: "interrupt", targetTokenId: "{self}"}, policy: "always",
        action: {schemaVersion: 1, id: "action:srd-multiattack-defense", label: "Multiattack Defense", costs: {allOf: []},
          range: {type: "special"}, targeting: {type: "single", required: true, count: 1}, effects: [defended]}}}]}];
  return {_id: id, _key: `!items!${id}`, name, type: "action", img, system: {active: true, description: "", definition: {schemaVersion: 1,
    id: "action:srd-defensive-tactics", label: name, costs: {allOf: [{capability: "defensive-tactics", amount: 1}]},
    range: {type: "self"}, targeting: {type: "self"},
    effects: options.map(option => ({id: option.id, type: "effect", name: `${document.name} (${option.label})`, slug: "defensive-tactics", img,
      ruleElements: option.ruleElements})),
    configuration: [{id: "tactic", type: "select-one", label: "Tactic", required: true,
      options: options.map(option => ({id: option.id, label: option.label, value: option.id})),
      effects: [{type: "keepEffect", effectIds: options.map(option => option.id)}]}]},
  ruleElements: []}, flags: {wildpath: {source, conversion: {notes: []}}}};
}

/**
 * 2024 Arcane Recovery and Natural Recovery: "When you finish a Short Rest, you can choose expended spell slots to recover.
 * The spell slots can have a combined level equal to no more than half your [class] level (round up), and none of the
 * slots can be level 6 or higher", once per Long Rest (`poolId`; one of its own unless `ownPool`): a rest Trigger asking
 * which slots, each pick a slot of its level, their levels limited by a `budget`. shortcut: every pick up to level 10 is
 * listed; a pick of a level with none expended is refused, and "use" with nothing picked spends the use.
 */
function slotRecovery({id, poolId, label, classId, ownPool=false}) {
  const picks = [1, 2, 3, 4, 5].flatMap(level => Array.from({length: Math.floor(10 / level)}, (_, index) => ({id: `level-${level}-${index + 1}`,
    label: `Level ${level}`, value: level, effects: [{type: "restore", resourceId: `spell-slot.${level}`, amount: 1}]})));
  return {rules: [
    ...(ownPool ? [] : [{schemaVersion: 1, id: `${id}-uses`, type: "GrantResource", data: {resourceId: poolId, label, maximum: 1,
      recovery: "longRest"}}]),
    {schemaVersion: 1, id, type: "Trigger", data: {kind: "automation", event: "rest.completed",
      predicate: {all: [{equals: {path: "event.data.restType", value: "shortRest"}}, {not: {poolEmpty: poolId}}]},
      action: {schemaVersion: 1, id: `action:srd-${id}`, label, costs: {allOf: [{capability: poolId, amount: 1}]}, range: {type: "self"},
        targeting: {type: "self"}, configuration: [
          {id: "use", type: "option", label, required: true, defaultValue: "use",
            options: [{id: "use", label: "Use it", value: "use"}, {id: "decline", label: "Not now", value: "decline"}], effects: [{type: "decline"}]},
          {id: "slots", type: "select-many", label: "Spell slots", required: false, min: 0, options: picks,
            budget: {type: "divide", numerator: {type: "class-level", class: classId}, denominator: {type: "constant", value: 2}, round: "ceil"}}]}}}],
    notes: []};
}

/**
 * A choice asked as each Long Rest ends whose option gives Items (`grantItems`, runtime grantChosenItems): one option per
 * captioned table of its description ("Arid Land"), each row a `classId` level and the Items linked in it (dnd5e uuids,
 * which the SRD driver maps to the Items they became, as a progression's grants).
 */
function longRestGrantChoice(document, {id, choiceId, label, classId}) {
  const tables = [...String(document.system?.description?.value ?? "").matchAll(/<table><caption>(.*?)<\/caption>(.*?)<\/table>/gsu)]
    .map(([, caption, body]) => ({value: slugify(caption), label: caption, rows: Object.fromEntries([...body.matchAll(/<tr><td>(\d+)<\/td><td>(.*?)<\/td><\/tr>/gsu)]
      .map(([, level, cell]) => [level, [...cell.matchAll(/@UUID\[([^\]]+)\]/gu)].map(match => match[1])]))}));
  return {schemaVersion: 1, id, type: "Trigger", data: {kind: "automation", event: "rest.completed",
    predicate: {equals: {path: "event.data.restType", value: "longRest"}},
    action: {schemaVersion: 1, id: `action:srd-${id}`, label: document.name, costs: {allOf: []}, range: {type: "self"}, targeting: {type: "self"},
      configuration: [{id: choiceId, type: "select-one", label, required: true,
        options: tables.map(table => ({id: table.value, label: table.label, value: table.value}))}],
      grantItems: {choiceId, class: classId, options: Object.fromEntries(tables.map(table => [table.value, table.rows]))}}}};
}

/** A rest choice's Items (longRestGrantChoice) as the Items they became (`uuidOf`, a driver's), as a progression's grants. */
export function mapGrantItems(items, uuidOf) {
  for ( const rule of items.flatMap(item => item.system?.ruleElements ?? []) ) {
    for ( const rows of Object.values(rule?.data?.action?.grantItems?.options ?? {}) ) {
      for ( const level of Object.keys(rows) ) rows[level] = rows[level].flatMap(uuid => uuidOf(uuid));
    }
  }
}

/** When its creature rolls Initiative, a pool of its own comes back up to `upTo` (an automation Trigger). */
const refillOnInitiative = (id, poolId, label, upTo) => ({schemaVersion: 1, id, type: "Trigger", data: {kind: "automation",
  event: "initiative.rolled", predicate: {all: [{poolBelowMax: poolId}]}, action: {schemaVersion: 1, id: `action:srd-${id}`, label,
    costs: {allOf: []}, range: {type: "self"}, targeting: {type: "self"}, restores: [{resourceId: poolId, amount: 0,
      amountExpression: {type: "subtract", terms: [{type: "constant", value: upTo}, {type: "resource-current", resource: poolId}]}}]}}});

/** A movement mode equal to its creature's Speed (a Climb or Swim Speed "equal to your Speed"). */
const movementEqualToSpeed = (id, mode) => ({schemaVersion: 1, id, type: "GrantMovement", data: {mode,
  distance: {type: "context", path: "actorSystem.resources.movement.max"}}});

/** A drop-to-0 rule (`health.zero`) on its feature, standing for its activities (their saves and heals). */
function zeroHpTrait(activities, zeroHp) {
  return {rules: [{schemaVersion: 1, id: "zero-hp", type: "Trigger", data: {kind: "zero-hp", event: "health.zero", zeroHp}}],
    consumes: [...activities], notes: []};
}

/** A damage activity as once-a-turn extra weapon damage of the weapon's type, under `predicate` (Frenzy, Colossus Slayer). */
function weaponExtra(activities, scales, label, predicate) {
  const activity = activities.find(entry => entry.type === "damage");
  const notes = [];
  const expression = activity ? partExpression(activity.damage?.parts?.[0], {spell: false, ability: null, scales, notes, label}) : null;
  if ( !expression ) return null;
  return {rules: [{schemaVersion: 1, id: slugify(label), type: "ExtraDamage", predicate,
    data: {domains: ["damage.weapon"], expression, once: "turn"}}], consumes: [activity], notes};
}

/** Improved Brutal Strike (barbarian level 17): two blows on one Brutal Strike's hit. */
const BLOW_USES = {type: "table", key: {type: "class-level", class: "barbarian"}, rows: {1: 1, 17: 2}};

/** One of Brutal Strike's own Actions: no cost, its reaction Trigger, named "<feature> (<suffix>)". */
function brutalAction(document, img, source, suffix, definition, trigger) {
  const id = stableId(`${document._id}:${suffix || "strike"}`);
  const name = `${document.name}${suffix ? ` (${suffix})` : ""}`;
  return {_id: id, _key: `!items!${id}`, name, type: "action", img,
    system: {active: true, description: "", definition: {schemaVersion: 1, id: `action:srd-brutal-strike${suffix ? `-${slugify(suffix)}` : ""}`,
      label: name, costs: {allOf: []}, ...definition}, ruleElements: [{schemaVersion: 1, id: "reaction", type: "Trigger", data: trigger}]},
    flags: {wildpath: {source, conversion: {notes: []}}}};
}

/**
 * 2024 Improved Brutal Strike: two more blows, answering a Brutal Strike's hit like the others (one a turn between them),
 * on the creature hit and until the start of the barbarian's next turn.
 * - Staggering Blow: Disadvantage on its next saving throw, and it can't make Opportunity Attacks.
 * - Sundering Blow: the next attack roll another creature makes against it has +5.
 * shortcut: a save outside an Action (a repeated save, Concentration) does not end Staggering Blow.
 */
function improvedBrutalStrikeActions(document, img, source) {
  const hit = {kind: "reaction", event: "attack.hit", match: {phase: "interrupt", sourceTokenId: "{self}", tagsAll: ["brutal-strike"]},
    once: "turn", onceKey: "brutal-blow", uses: BLOW_USES};
  const onTarget = {range: {type: "special"}, targeting: {type: "single", required: true, count: 1}};
  const untilNextTurn = {value: 1, units: "rounds", expiry: "turnStart"};
  const named = {...document, name: "Brutal Strike"};
  return [
    brutalAction(named, img, source, "Staggering Blow", {...onTarget, effects: [
      {id: "effect-1", type: "effect", name: "Staggered", img: "icons/svg/daze.svg", duration: untilNextTurn, endsWhen: "saves",
        ruleElements: [{schemaVersion: 1, id: "staggered", type: "RollMode", data: {domains: ["save"], mode: "disadvantage"}}]},
      {id: "effect-2", type: "effect", name: "Staggered (no Opportunity Attacks)", slug: "no-opportunity-attacks", img: "icons/svg/daze.svg",
        duration: untilNextTurn, ruleElements: []}]}, hit),
    brutalAction(named, img, source, "Sundering Blow", {...onTarget, effects: [
      {id: "effect-1", type: "effect", name: "Sundered", slug: "sundered", img: "icons/svg/sword.svg", duration: untilNextTurn,
        endsWhen: "attackedByOther", ruleElements: [{schemaVersion: 1, id: "sundered", type: "Modifier",
          data: {domains: ["attacked"], modifierType: "untyped", value: 5}, predicate: {not: {tagsAny: ["from:sundered"]}}}]}]}, hit)
  ];
}

function brutalStrikeActions(document, img, source, scales) {
  const declared = {all: [{equals: {path: "event.data.attackRollMode", value: "advantage"}},
    {equals: {path: "event.data.attackAbility", value: "might"}}]};
  const extra = formulaExpression("@scale.barbarian.brutal-strike", {scales}) ?? {type: "dice", number: 1, faces: 10};
  const own = (event, extraMatch={}) => ({kind: "reaction", event, match: {phase: "interrupt", sourceTokenId: "{self}", ...extraMatch}});
  const make = (suffix, definition, trigger) => brutalAction(document, img, source, suffix, definition, trigger);
  const self = {range: {type: "self"}, targeting: {type: "self"}};
  return [
    make("", {...self, rider: {rollMode: "normal", tags: ["brutal-strike"], damage: [{id: "brutal-strike", expression: extra}]}},
      {...own("action.declared", {notTagsAny: ["spell"]}), whileStatus: "reckless", once: "turn", triggerPredicate: declared}),
    make("Forceful Blow", {...self, rider: {push: {distance: 15}}, effects: [{...structuredClone(WITHDRAW), name: "Forceful Blow"}]},
      {...own("attack.hit", {tagsAll: ["brutal-strike"]}), once: "turn", onceKey: "brutal-blow", uses: BLOW_USES}),
    make("Hamstring Blow", {range: {type: "special"}, targeting: {type: "single", required: true, count: 1},
      effects: [{id: "effect-1", type: "effect", name: "Hamstrung", img: "icons/svg/net.svg", duration: {value: 1, units: "rounds", expiry: "turnStart"},
        ruleElements: [{schemaVersion: 1, id: "hamstrung", type: "Modifier", data: {domains: ["resources.movement.max", "speed"],
          modifierType: "untyped", value: -15}}]}]},
    {...own("attack.hit", {tagsAll: ["brutal-strike"]}), once: "turn", onceKey: "brutal-blow", uses: BLOW_USES})
  ];
}

/**
 * Paladin's Smite (the maintainer's rule): its free cast of Divine Smite (once per Long Rest, no slot) is an option of
 * every Divine Smite's slot choice, as a 1st-level cast. It also lets its paladin cast Divine Smite by the 2014 rules
 * (SRD 5.1): no action, 2d8 radiant and 1d8 more a slot level above 1st, at most 5d8 (a slot above 4th adds nothing, so
 * it is not offered), as often as it hits, while it has cast no other spell with a slot this turn
 * (`onlyWithoutOtherSlotSpell`, reactions.md). The 2024 spell is offered beside it: both are options.
 */
const PALADINS_SMITE = Object.freeze({resourceId: "paladins-smite",
  pool: {schemaVersion: 1, id: "paladins-smite-uses", type: "GrantResource",
    data: {resourceId: "paladins-smite", label: "Paladin's Smite", maximum: 1, recovery: "longRest"}}});

/** Divine Smite's definition on its own hit: the creature hit, its slot choice with Paladin's Smite's free cast. */
function smiteDefinition(definition, {highest=9}={}) {
  const configuration = (definition.configuration ?? []).map(choice => (!choice.levelByResourceId ? choice : {...choice,
    cost: {anyOf: [...(choice.cost?.anyOf ?? []).filter(option => (choice.levelByResourceId[option[0]?.capability] ?? 0) <= highest),
      [{capability: PALADINS_SMITE.resourceId, amount: 1}]]},
    levelByResourceId: {...Object.fromEntries(Object.entries(choice.levelByResourceId).filter(([, slot]) => slot <= highest)),
      [PALADINS_SMITE.resourceId]: 1}}));
  return {...definition, tags: [...new Set([...(definition.tags ?? []), "smite"])], range: {type: "special"},
    targeting: {type: "single", required: true, count: 1}, configuration};
}

/** Paladin's Smite's 2014 Divine Smites (and the one against an Undead or a Fiend), as Actions its feature brings. */
function paladinsSmiteActions(document, img, source) {
  return [["", 2], [" (Undead or Fiend)", 3]].map(([suffix, dice]) => {
    const id = stableId(`${document._id}:smite${suffix}`);
    const damage = [{id: "damage-1", expression: {type: "dice", number: dice, faces: 8}, damageType: "radiant", provenance: "spell-base"}];
    const definition = smiteDefinition({schemaVersion: 1, id: `action:srd-paladins-smite${suffix ? "-undead-or-fiend" : ""}`,
      label: `${document.name}${suffix}`, tags: ["spell"], costs: {allOf: []},
      damage, configuration: slotConfiguration(1, [{id: "damage-1", scaleDice: {number: 1, faces: 8}}]), metadata: {spellLevel: 1}},
      {highest: 4});
    return {_id: id, _key: `!items!${id}`, name: `${document.name}${suffix}`, type: "action", img,
      system: {active: true, description: "", definition, ruleElements: [{schemaVersion: 1, id: "reaction", type: "Trigger",
        data: {kind: "reaction", event: SMITE_TRIGGER.event, match: SMITE_TRIGGER.match, onlyWithoutOtherSlotSpell: true}}]},
      flags: {wildpath: {source, conversion: {notes: []}}}};
  });
}

/** dnd5e skill keys as WildPath's skills. */
const SKILL_MAP = Object.freeze({acr: "acrobatics", ani: "animal-handling", arc: "arcana", ath: "athletics", dec: "deception",
  his: "history", ins: "insight", itm: "intimidation", inv: "investigation", med: "medicine", nat: "nature", prc: "perception",
  prf: "performance", per: "persuasion", rel: "religion", slt: "sleight-of-hand", ste: "stealth", sur: "survival"});

/** dnd5e statuses WildPath has conditions for. */
const CONDITION_MAP = Object.freeze(Object.fromEntries(["prone", "blinded", "restrained", "stunned", "unconscious", "poisoned",
  "exhaustion", "charmed", "deafened", "silenced", "frightened", "grappled", "incapacitated", "invisible", "paralyzed", "petrified", "dead",
  "burning", "cursed", "ethereal", "coverHalf", "coverThreeQuarters", "coverTotal"]
  // Nature's Ward names the Poisoned condition "poison".
  .map(id => [id, id]).concat([["poison", "poisoned"]])));
const ACTIVATION_COST = Object.freeze({action: "action", bonus: "bonus-action", reaction: "reaction", legendary: "legendary-action",
  lair: "lair-action"});
const RECOVERY = Object.freeze({lr: "longRest", sr: "shortRest", day: "longRest", dawn: "longRest", dusk: "longRest", turn: "turn", turnStart: "turn",
  round: "turn"});
const ACTIVITIES = new Set(["attack", "save", "check", "damage", "heal", "utility"]);
const SPELL_DC = {type: "add", terms: [{type: "constant", value: 8}, {type: "proficiency-bonus"}, {type: "spellcasting-modifier"}]};
const SLOT_MODES = new Set(["prepared", "always", "spell", "pact", "ritual"]);

/** An effect's changes (dnd5e keeps them on the effect, or under `system` in newer data). */
export function effectChanges(effect) {
  // A blank row (no key; Boots and Cloak of Elvenkind) changes nothing: the effect is as good as empty.
  return (effect?.changes ?? effect?.system?.changes ?? []).filter(change => change?.key);
}

/**
 * An effect's statuses (see above for its changes). Some dnd5e data stored a Set as the string "[object Set]"
 * (Tasha's Fulminating Treatise, Far Realm Shard, Mighty Servant of Leuk-o): its condition is then only in the effect's
 * name ("Prone", "Charmed (Destructive)").
 */
export function effectStatuses(effect) {
  const statuses = effect?.statuses ?? [];
  // An empty effect named for its conditions ("Deafened", "Blinded, Deafened": Blindness/Deafness's) gives them.
  if ( !statuses.length && !effectChanges(effect).length ) {
    const names = String(effect?.name ?? "").toLowerCase().replace(/[.!]+$/u, "").split(/\s*(?:,|\band\b)\s*/u).filter(Boolean);
    if ( names.length && names.every(name => CONDITION_MAP[name]) ) return names;
  }
  const slugs = statuses.filter(status => /^[a-z][\w-]*$/u.test(status));
  if ( slugs.length === statuses.length ) return statuses;
  const named = String(effect?.name ?? "").toLowerCase().match(/^[a-z]+/u)?.[0];
  return [...slugs, ...((named && CONDITION_MAP[named] && !slugs.includes(named)) ? [named] : [])];
}

/** Whether a dnd5e document is SRD 5.2 content its source says may be shared (CC-BY-4.0, 2024 rules). */
export function isSrd2024(document) {
  const source = document?.system?.source ?? {};
  return (source.license === "CC-BY-4.0") && (source.rules === "2024");
}

/** A 16-character Document id derived from `seed` (FNV-1a), the same on every run. */
export function stableId(seed) {
  let a = 0x811c9dc5, b = 0x01000193;
  for ( const char of String(seed) ) {
    a = Math.imul(a ^ char.charCodeAt(0), 0x01000193) >>> 0;
    b = Math.imul(b ^ char.charCodeAt(0), 0x811c9dc5) >>> 0;
  }
  return `${a.toString(36)}${b.toString(36)}`.padEnd(16, "0").slice(0, 16);
}

/** An image path when it is under one of `prefixes` (art that ships where the converted content is used), else null. */
const kept = (path, prefixes) => (prefixes.some(prefix => String(path ?? "").startsWith(prefix)) ? path : null);

export const slugify = text => String(text ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const number = value => (Number.isFinite(Number(value)) && (value !== "") && (value !== null) ? Number(value) : null);
const dice = (count, faces) => ({type: "dice", number: count, faces});
const add = terms => (terms.length === 1 ? terms[0] : {type: "add", terms});

/**
 * A dnd5e roll-data formula as a WildPath ValueExpression, or null when it uses something WildPath cannot read.
 * - Ability modifiers, the proficiency bonus, class and character levels and `max`/`min`/`floor`/`ceil` translate.
 * - A class scale value becomes a table on its class level: numbers, or dice (Sneak Attack, Martial Arts).
 * - `@mod` is the spellcasting modifier for a spell and the ability modifier otherwise.
 * - `@item.level` is `castLevel` when given (a spell's level, to work out what a higher slot changes).
 * - `@attributes.spell.dc` is `spellDC` when given (a creature's), else the caster's own spell save DC.
 */
/** Scale values dnd5e's own formulas name differently from the class's table (Persistent Rage's "@scale.barbarian.rage"). */
const SCALE_ALIASES = Object.freeze({"barbarian.rage": "barbarian.rages"});

export function formulaExpression(formula, {spell=false, ability=null, scales={}, castLevel=null, challenge=null, spellDC=null, pool=null}={}) {
  let text = String(formula ?? "").trim();
  if ( !text ) return null;
  const variables = {};
  const variable = expression => {
    const name = `scale${Object.keys(variables).length}x`;
    variables[name] = expression;
    return ` ${name} `;
  };
  // A scale value as a table on its level (rows.key), or null when there is none.
  const table = (owner, id, part, count) => {
    const rows = scales[SCALE_ALIASES[`${owner}.${id}`] ?? `${owner}.${id}`];
    if ( !rows ) return null;
    const row = value => {
      if ( typeof value !== "object" ) return value;
      if ( part === "number" ) return value.number ?? 1;
      if ( part === "faces" ) return value.faces;
      return dice(Number(count) || (part === "die" ? 1 : (value.number ?? 1)), value.faces);
    };
    return {type: "table", key: rows.key ?? {type: "class-level", class: owner}, rows: Object.fromEntries(Object.entries(rows)
      .map(([level, value]) => [level, row(value)]))};
  };
  // A summoned spirit's numbers (2024 Summon Beast's "1d8 + 4 + the spell's level"): the level it was summoned at and its
  // summoner's spellcasting modifier, which the summons adapter writes in as numbers when it appears (`summon.level`).
  const summonLevel = {type: "context", path: "summon.level"};
  text = text
    .replace(/\(([^()]*@flags\.dnd5e\.summon\.level[^()]*)\)\s*d\s*(\d+)/gi, (match, inner, faces) => {
      const count = parseFormula(inner.replace(/@flags\.dnd5e\.summon\.level/g, " summonlevelx ").trim(), {variables: {summonlevelx: summonLevel}});
      return count.ok ? variable({type: "dice", number: count.expression, faces: Number(faces)}) : match;
    })
    .replace(/@flags\.dnd5e\.summon\.level/g, () => variable(summonLevel))
    .replace(/@flags\.dnd5e\.summon\.mod/g, () => variable({type: "context", path: "summon.mod"}))
    // "(@scale.channel-divinity-cleric.spark)d8": dice whose count is the scale (Divine Spark's 1d8 to 4d8).
    .replace(/\(@scale\.([a-z0-9-]+)\.([a-z0-9-]+)\)\s*d\s*(\d+)/gi, (match, owner, id, faces) => {
      const count = table(owner, id, "value", "");
      return count ? variable({type: "dice", number: count, faces: Number(faces)}) : match;
    })
    .replace(/(\d*)@scale\.([a-z0-9-]+)\.([a-z0-9-]+)(?:\.(value|die|faces|number|formula))?/gi, (match, count, owner, id, part) => {
      const expression = table(owner, id, part, count);
      return expression ? variable(expression) : match;
    })
    // A creature's spell save DC is its number; a character's is 8 + proficiency + spellcasting modifier.
    .replace(/@attributes\.spell\.dc/g, spellDC == null ? "(8 + prof + spellmod)" : String(spellDC))
    // "(@abilities.wis.mod)d8": dice as many as an ability modifier (Sear Undead).
    .replace(/\(@abilities\.(str|dex|con|int|wis|cha)\.mod\)\s*d\s*(\d+)/gi, (_, key, faces) => variable({type: "dice",
      number: {type: "ability-modifier", ability: ABILITY_MAP[key.toLowerCase()]}, faces: Number(faces)}))
    .replace(/@abilities\.(str|dex|con|int|wis|cha)\.mod/gi, (_, key) => `mod(${ABILITY_MAP[key.toLowerCase()]})`)
    .replace(/@mod\b/g, (spell || !ability) ? "spellmod" : `mod(${ability})`)
    .replace(/@(?:attributes\.)?prof\b/g, "prof")
    .replace(/@classes\.([a-z0-9-]+)\.levels/gi, (_, id) => `level(${id.toLowerCase()})`)
    .replace(/@details\.level/g, "level")
    .replace(/@item\.level/g, castLevel == null ? "@item.level" : String(castLevel))
    .replace(/@details\.cr/g, challenge == null ? "@details.cr" : String(challenge))
    // Its item's pool (`pool`): its charges left (a Staff of Power's "16 * @item.uses.value"), its maximum, and what is spent
    // (an Ivory Goat's "-@item.uses.spent": all of it given back).
    .replace(/@item\.uses\.(value|max|spent)\b/g, (match, part) => (!pool ? match : variable({value: {type: "resource-current", resource: pool},
      max: {type: "resource-max", resource: pool}, spent: {type: "subtract", terms: [{type: "resource-max", resource: pool},
        {type: "resource-current", resource: pool}]}}[part])));
  // "(max(1,@abilities.wis.mod))d6", "(@prof)d4": dice as many as the parentheses work out to.
  text = text.replace(/\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)\s*d\s*(\d+)/g, (match, inner, faces) => {
    const count = inner.includes("@") ? null : parseFormula(inner.trim(), {variables});
    return count?.ok ? variable({type: "dice", number: count.expression, faces: Number(faces)}) : match;
  });
  if ( text.includes("@") ) return null;
  const result = parseFormula(text, {variables});
  return result.ok ? result.expression : null;
}

/** The expression with every dice count multiplied by `factor` (a cantrip's dice at 5th, 11th and 17th level). */
function multiplyDice(expression, factor) {
  if ( !expression || (typeof expression !== "object") ) return expression;
  if ( expression.type === "dice" ) return {...expression, number: (expression.number ?? 1) * factor};
  return {...expression, ...(Array.isArray(expression.terms) ? {terms: expression.terms.map(term => multiplyDice(term, factor))} : {})};
}

/** 2024 cantrips: more dice at character levels 5, 11 and 17. */
const cantripTable = expression => ({type: "table", key: {type: "character-level"},
  rows: {1: expression, 5: multiplyDice(expression, 2), 11: multiplyDice(expression, 3), 17: multiplyDice(expression, 4)}});

/** A dnd5e damage or healing part as a ValueExpression; notes what it leaves out. */
function partExpression(part, {spell, ability, scales, notes, label, pool=null}) {
  // Exploding dice (2024 Sorcerous Burst's "1d8x@mod=8"): its dice. shortcut: an 8 rolls no extra die; upgrade when dice explode.
  const exploding = /^\s*(\d+)d(\d+)x/iu.exec(String(part?.custom?.formula ?? ""));
  if ( part?.custom?.enabled && exploding ) {
    notes.push(`${label}: its dice don't explode ("${part.custom.formula}")`);
    return dice(Number(exploding[1]), Number(exploding[2]));
  }
  if ( part?.custom?.enabled ) {
    const custom = formulaExpression(part.custom.formula, {spell, ability, scales, pool});
    if ( !custom ) notes.push(`${label}: custom formula "${part.custom.formula}" not converted`);
    return custom;
  }
  const count = number(part?.number);
  const faces = number(part?.denomination);
  const terms = [];
  if ( count && faces ) terms.push(dice(count, faces));
  if ( part?.bonus ) {
    const bonus = formulaExpression(part.bonus, {spell, ability, scales});
    if ( bonus ) terms.push(bonus);
    else notes.push(`${label}: bonus "${part.bonus}" not converted`);
  }
  return terms.length ? add(terms) : null;
}

/** Whether a range, target or activation says anything (an item may carry an empty one its activities fill). */
const says = value => Boolean(value?.units || value?.type || value?.value || value?.template?.type || value?.affects?.type);

/** The activity's own value for `key` when it overrides the item's or the item's says nothing, else the item's. */
// An Item's leftover "none" activation (a Steel Defender's natural weapon) gives way to its activity's own.
const pick = (activity, system, key) => ((activity?.[key]?.override || !says(system?.[key])
  || ((key === "activation") && (system[key]?.type === "none") && activity?.[key]?.type)) ? activity?.[key] : system[key]) ?? {};

function rangeOf({activity, system, document, attack}) {
  const range = pick(activity, system, "range");
  const units = range.units || system.range?.units || "";
  if ( units === "self" ) return {type: "self"};
  if ( units === "touch" ) return {type: "touch", distance: {value: 5, unit: "ft"}};
  if ( (document.type === "weapon") && (attack?.type === "melee") ) {
    const reach = number(system.range?.reach) ?? ((system.properties ?? []).includes("rch") ? 10 : 5);
    return {type: "reach", distance: {value: reach, unit: "ft"}};
  }
  const value = number(range.value ?? system.range?.value);
  const long = number(system.range?.long);
  if ( (units === "ft") && value ) {
    if ( attack?.type === "melee" ) return {type: "reach", distance: {value, unit: "ft"}};
    return {type: "ranged", normal: {value, unit: "ft"}, ...(long ? {long: {value: long, unit: "ft"}} : {})};
  }
  if ( ["spec", "any"].includes(units) ) return {type: "special"};
  return null;
}

/** Targeting and area; an unsupported shape leaves the targets to the user and is noted. */
function targetingOf({activity, system, notes, level=0, scales={}}) {
  const target = pick(activity, system, "target");
  const template = target.template ?? {};
  const affects = target.affects ?? {};
  // A size that grows with the spell's level (Fog Cloud's "20 * @item.level"): its size at the spell's own level, and
  // what each level above adds (`areaPerLevel`, a slot choice's scaleArea).
  const sizeAt = castLevel => {
    const expression = formulaExpression(template.size, {scales, castLevel});
    const value = expression ? evaluateValueExpression(expression, {}) : null;
    return value?.ok ? Number(value.value) : null;
  };
  const leveled = /@item\.level/.test(String(template.size ?? "")) && (sizeAt(level) > 0) && (sizeAt(level + 1) != null);
  // One its user scales when using it (an Eversmoking Bottle's "50 + @scaling * 10": 60 to 120 feet): its size at a
  // scaling of 1, and what each step adds (`areaScaling`, a number choice's scaleArea, scalingChoice).
  const steps = activity.consumption?.scaling?.allowed ? (number(activity.consumption.scaling.max) || 0) : 0;
  const scaledAt = step => {
    const expression = formulaExpression(String(template.size ?? "").replaceAll("@scaling", String(step)), {scales});
    const value = expression ? evaluateValueExpression(expression, {}) : null;
    return value?.ok ? Number(value.value) : null;
  };
  const scaled = !leveled && (steps > 1) && /@scaling\b/.test(String(template.size ?? "")) && (scaledAt(1) > 0) && (scaledAt(2) != null);
  const size = number(template.size) ?? (leveled ? sizeAt(level) : (scaled ? scaledAt(1) : null));
  const areaPerLevel = leveled ? sizeAt(level + 1) - size : 0;
  const areaScaling = scaled ? {perStep: scaledAt(2) - size, steps} : null;
  const rangeUnits = pick(activity, system, "range").units ?? system.range?.units;
  if ( template.type ) {
    // A Cube (or a square) is a block of fields; a circle is radial, as a sphere is.
    const shape = {sphere: "radial", cylinder: "radial", circle: "radial", radius: rangeUnits === "self" ? "emanation" : "radial", cone: "cone",
      line: "line", cube: "cube", square: "cube", wall: "wall"}[template.type];
    if ( shape && size ) {
      // A panel wall (Wall of Stone: ten 10-foot panels) is its panels end to end; shortcut: in a straight line.
      const length = (shape === "wall") ? size * (number(template.count) || 1) : size;
      // How high it reaches: a Cylinder's or a wall's height; a circle lies on the ground.
      const height = (template.type === "circle") ? 0 : (["cylinder", "wall"].includes(template.type) ? number(template.height) : null);
      return {targeting: {type: "area"}, area: {shape, size: {value: length, unit: "ft"},
        ...(shape === "line" ? {width: {value: number(template.width) ?? 5, unit: "ft"}} : {}),
        ...(height != null ? {height: {value: height, unit: "ft"}} : {})}, ...(areaPerLevel ? {areaPerLevel} : {}),
        ...(areaScaling ? {areaScaling} : {})};
    }
    notes.push(`area: ${template.size}-ft ${template.type} is not supported; the user picks the targets`);
    return {targeting: {type: "multiple", required: true, count: 20, ...UP_TO}};
  }
  if ( (affects.type === "self") || (rangeUnits === "self") ) return {targeting: {type: "self"}};
  // A count may be a formula, and grow with the spell's level ("@item.level - 1"): its value at the spell's own level,
  // and what each level above adds.
  const at = castLevel => {
    const expression = formulaExpression(affects.count, {scales, castLevel});
    const value = expression ? evaluateValueExpression(expression, {}) : null;
    return value?.ok ? value.value : (expression ?? null);
  };
  const count = number(affects.count) ?? (affects.count ? at(level) : null);
  const fromCount = (typeof count === "number") && String(affects.count).includes("@item.level") && (typeof at(level + 1) === "number")
    ? at(level + 1) - count : 0;
  // Else its text's ("You can target one additional creature for each spell slot level above 1": Jump).
  const perLevel = fromCount || (level ? textTargetsPerLevel(plainText({system})) : 0);
  if ( affects.count && (count == null) ) notes.push(`targets: count "${affects.count}" not converted`);
  // One growing with its character's level (Eldritch Blast's beams): a table by level, as a cantrip's dice are.
  const byLevel = (count && (typeof count === "object") && /@details\.level\b/u.test(String(affects.count))) ? levelTable(count) : null;
  if ( count && (typeof count === "object") ) return {targeting: {type: "multiple", required: true, count: byLevel ?? count, ...UP_TO}};
  if ( (count > 1) || perLevel ) return {targeting: {type: (count > 1) ? "multiple" : "single", required: true, count: Math.max(count, 1),
    ...((count > 1) ? UP_TO : {})}, perLevel};
  return {targeting: {type: "single", required: true, count: 1}};
}

/**
 * An expression of its character's level as a table on that level, a row wherever its value changes (Eldritch Blast's
 * "floor((level + 1) / 6) + 1": 1, 2 at 5, 3 at 11, 4 at 17). Null when it can't be worked out at every level.
 */
function levelTable(expression) {
  const rows = {};
  let last = null;
  for ( let characterLevel = 1; characterLevel <= 20; characterLevel++ ) {
    const value = evaluateValueExpression(expression, {characterLevel});
    if ( !value.ok ) return null;
    if ( value.value !== last ) rows[characterLevel] = value.value;
    last = value.value;
  }
  return {type: "table", key: {type: "character-level"}, rows};
}

/** The more creatures a spell's text lets it target per slot level above its own, or 0. */
function textTargetsPerLevel(text) {
  const word = /\byou can (?:target|affect) (one|two|three|\d+) additional (?:creature|target|Beast|Humanoid)s?\b[^.]*\bslot level above\b/i.exec(text)?.[1];
  return word ? (COUNTS[word.toLowerCase()] ?? Number(word)) : 0;
}

/**
 * More targets, rays or darts its text gives per slot level that no count holds (Scorching Ray's rays, Etherealness'
 * willing creatures): noted as by hand.
 */
const MORE_PER_SLOT = /\b(?:one|two|three|\d+) (?:additional|more) (?:creature|target|ray|dart|bolt|beam|Beast|Humanoid)s?\b[^.]*\bslot level above\b|\bup to \w+ willing creatures\b[^.]*\bslot level above\b/i;

/** A roll table its text links or embeds: the SRD's (`dnd5e.tables24`) or a book's (`dnd-players-handbook.tables`), by id. */
const TABLE_LINK = /@(?:UUID|Embed)\[Compendium\.[\w-]+\.tables(?:24)?\.RollTable\.(\w+)/u;

/** Hits its user may share among creatures, one or several ("direct them to hit one creature or several"). */
const REPEATED_HITS = /\b(?:to hit one creature or several|at one target within range or at several|at the same target or at different ones)\b/iu;

/** dnd5e's inline count of them in its description ("[[@item.level + 1]]{Total Rays}"): its formula. */
const INLINE_TOTAL = /\[\[([^\]]+)\]\]\{Total\b/u;

/** dnd5e's target types that are another creature, not its own (`self`) nor a space or an object. */
const CREATURE_TARGETS = new Set(["creature", "enemy", "ally", "creatureOrObject"]);

/** dnd5e's "up to three creatures": at least one, at most the count. */
const UP_TO = Object.freeze({refinementPolicy: {minSelections: 1}});

const LEGACY_ACTIONS = Object.freeze({mwak: ["attack", "melee", "weapon"], rwak: ["attack", "ranged", "weapon"],
  msak: ["attack", "melee", "spell"], rsak: ["attack", "ranged", "spell"], save: ["save"], heal: ["heal"], abil: ["check"],
  util: ["utility"], other: ["utility"], summ: ["summon"], ench: ["enchant"]});
const LEGACY_PERIODS = Object.freeze({sr: "sr", lr: "lr", day: "lr", dawn: "lr", dusk: "lr"});
const TEMPLATE_TYPES = new Set(["sphere", "cone", "line", "cube", "cylinder", "radius", "square", "wall"]);

/**
 * An item in dnd5e's older data (before activities, dnd5e 3.x and earlier, as 2014 modules store it) in the shape the
 * converter reads: one activity from its action type, damage parts from their formulas, uses, Recharge, the template,
 * and concentration from its components. A save's damage is halved on a success, as dnd5e's own migration assumes,
 * unless its text never says "half" ("must succeed on a Wisdom saving throw ... or take 2d6 psychic damage").
 */
export function upgradeLegacy(document) {
  const system = document.system ?? {};
  if ( system.activities || (system.actionType === undefined) ) return document;
  const upgraded = structuredClone(document);
  const s = upgraded.system;
  // A legacy copy of an enchanting spell (a stat block's Magic Weapon) enchants, as the 2024 spell's activity does.
  const [type, attackType, classification] = ((document.type === "spell") && ENCHANTS[identifierOf(document)]) ? ["enchant"]
    : (LEGACY_ACTIONS[system.actionType] ?? (system.activation?.type ? ["utility"] : []));
  const parts = (system.damage?.parts ?? []).map(([formula, damageType]) => ({custom: {enabled: true, formula: String(formula ?? "")},
    types: damageType ? [damageType] : []}));
  s.activation = {...(system.activation ?? {}), value: system.activation?.cost ?? system.activation?.value ?? null};
  if ( system.properties && !Array.isArray(system.properties) ) {
    s.properties = Object.entries(system.properties).filter(([, on]) => on).map(([key]) => key);
  }
  if ( system.components?.concentration ) s.properties = [...new Set([...(s.properties ?? []), "concentration"])];
  // A weapon's first part ("1d8 + @mod") is its own damage, which the ability modifier joins.
  let includeBase = false;
  const weaponBase = (document.type === "weapon") && /^\s*(\d+)d(\d+)\s*(?:\+\s*@mod\s*)?$/.exec(parts[0]?.custom.formula ?? "");
  if ( weaponBase ) {
    s.damage = {base: {number: Number(weaponBase[1]), denomination: Number(weaponBase[2]), types: parts[0].types}};
    parts.shift();
    includeBase = true;
  }
  const scaling = system.scaling ?? {};
  if ( parts[0] && (scaling.mode === "cantrip") ) parts[0].scaling = {mode: "whole"};
  // Its formula added per level ("1d6", 2014 False Life's "5"), as slotScaling reads it.
  if ( parts[0] && (scaling.mode === "level") && String(scaling.formula ?? "").trim() ) parts[0].scaling = {mode: "whole", number: null,
    formula: String(scaling.formula)};
  const target = system.target ?? {};
  s.target = TEMPLATE_TYPES.has(target.type) ? {template: {type: target.type, size: String(target.value ?? ""), width: target.width, units: target.units},
    affects: {type: "creature"}} : {template: {}, affects: {type: target.type ?? "", count: target.value ? String(target.value) : ""}};
  if ( system.recharge?.value ) s.uses = {max: "1", recovery: [{period: "recharge", formula: String(system.recharge.value)}]};
  else if ( system.uses?.max ) s.uses = {max: String(system.uses.max), recovery: LEGACY_PERIODS[system.uses.per]
    ? [{period: LEGACY_PERIODS[system.uses.per], type: "recoverAll"}] : []};
  else s.uses = {};
  const save = system.save ?? {};
  s.activities = {legacy: {_id: "legacy", type: type ?? "utility", sort: 0, activation: {override: false}, range: {override: false},
    target: {override: false}, consumption: {targets: s.uses.max ? [{type: "itemUses", value: "1"}] : []},
    ...(type === "attack" ? {attack: {type: {value: attackType, classification}, ability: system.ability || "",
      bonus: system.attack?.bonus ?? system.attackBonus ?? ""}} : {}),
    damage: {includeBase, parts: type === "heal" ? [] : parts,
      onSave: type === "save" ? ((((document.type === "spell") && !Number(system.level))
        || (plainText(document).trim() && !/\bhalf\b/iu.test(plainText(document)))) ? "none" : "half") : undefined},
    ...(type === "heal" ? {healing: parts[0] ?? null} : {}),
    ...(type === "save" ? {save: {ability: save.ability ? [save.ability] : [], dc: {calculation: save.scaling === "spell" ? "spellcasting"
      : (save.scaling === "flat" ? "" : (save.scaling ?? "")), formula: String(save.dc ?? "")}}} : {}),
    effects: (document.effects ?? []).filter(effect => !effect.transfer).map(effect => ({_id: effect._id, onSave: false}))}};
  return upgraded;
}

/** The SRD's plain weapons' damage by their base-weapon id (`longbow`, `lightcrossbow`), for magic weapons that name one. */
export function baseWeapons(documents) {
  return Object.fromEntries(documents.filter(document => (document.type === "weapon") && document.system?.type?.baseItem
    && number(document.system?.damage?.base?.denomination) && !document.system?.magicalBonus && !(document.system?.properties ?? []).includes("mgc"))
    .map(document => [document.system.type.baseItem, document.system.damage.base]));
}

/**
 * Convert one dnd5e Item (spell, weapon, feat) to WildPath Action Items, one per activity.
 * `scales` maps `<class>.<scale>` to `{level: value}` rows (from the class's ScaleValue advancements).
 * @returns {{ok: true, items: object[], notes: string[]} | {ok: false, reason: string}}
 */
export function convertItem(document, {scales={}, pack=null, saveDC=null, spellDC=null, names={}, creature=null, licensed=isSrd2024, book="SRD 5.2",
  images=["icons/"], spells={}, creatures={}, forms=[], beasts=forms.filter(form => form.type === "beast"), usesOf={}, tables={}, spellLists={},
  weapons={}}={}) {
  if ( !licensed(document) ) return {ok: false, reason: "not SRD 5.2 (CC-BY-4.0)"};
  document = upgradeLegacy(document);
  // A magic weapon dnd5e leaves without damage of its own (an Energy Bow): its base weapon's, as dnd5e fills it when used.
  const baseWeapon = ((document.type === "weapon") && !number(document.system?.damage?.base?.denomination))
    ? weapons[document.system?.type?.baseItem] : null;
  if ( baseWeapon ) document = {...document, system: {...document.system, damage: {...document.system.damage, base: baseWeapon}}};
  const system = document.system ?? {};
  // An activity with no type is a stale leftover (Tasha's infusions carry one), not something it does.
  const activities = Object.values(system.activities ?? {}).filter(activity => activity?.type)
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)).map(activity => activationByHand(document, poisonUse(activity)))
    // "Action or Bonus Action" (2024 Scimitar of Speed: "one attack with it as a Bonus Action on each of your turns"): an
    // attack that costs the Action, and a copy that costs the Bonus Action.
    .map(activity => (((activity.type === "attack") && (activity.activation?.type === "special")
      && /^Action or Bonus Action$/iu.test(activity.activation?.condition ?? ""))
      ? {...activity, activation: {...activity.activation, type: "action", override: true}, bonusToo: true} : activity));
  activities.push(...missingCasts(document, activities));
  activities.unshift(...missingTeleport(document, activities));
  const spell = document.type === "spell";
  const level = number(system.level) ?? 0;
  const pool = usesPool({document, scales}) ?? spentPool(activities, names);
  const description = houseText(document, describe(document, {names, creature}));
  const source = {system: "dnd5e", pack, id: document._id, type: document.type, book,
    license: document.system?.source?.license || null, rules: document.system?.source?.rules || "2024",
    // What it is, for prerequisites and pools by kind (an Eldritch Invocation, a Fighting Style, an infusion).
    identifier: identifierOf(document), subtype: system.type?.subtype || null,
    // A feat's category (origin, general, fightingStyle, epicBoon), which the level-up dialog offers (G8).
    ...((system.type?.value === "feat") ? {feat: system.type.subtype || "general"} : {})};
  const img = kept(document.img, images) ?? "icons/svg/item-bag.svg";
  const items = [];
  const allNotes = [];
  const initiativeRules = [];
  // Activities another Action folds in (a lasting area's repeat: areaRepeat; ACTIONS_BY_HAND `folds`): not passive abilities.
  const folded = new Set();
  let testOffer = null;
  const trait = traitOf(document, {activities, system, spell, level, scales, pool, saveDC, creature});
  // A Metamagic option (Quickened Spell: "quickened"), which its sorcerer's spells offer (metamagic.mjs).
  const metamagic = (system.type?.subtype === "metamagic") ? identifierOf(document).replace(/-spell$/, "") : null;
  if ( trait ) allNotes.push(...trait.notes);
  // A spell without activities is still cast: it spends its slot like any other.
  const usable = activities.length ? activities : (spell ? [{type: "manual", activation: {override: false}}] : []);
  // The tag a stat block attack's own save answers (attackRider), on that attack's Action.
  const riderTag = activities.map(entry => attackRider(document, entry, activities)).find(Boolean)?.tagsAll[0] ?? null;
  const raised = raisedFromKilled(document, activities, creatures, system);
  let carried = carriedRetaliation({document, activities, system, spell, level, scales, saveDC, spellDC, creature, beasts, names});
  // What its effect gives while it lasts and when it ends (Haste's extra action and lethargy): on the first effect it applies.
  let ended = effectEndedTrigger({document, activities, system, spell, level, scales, saveDC, spellDC, creature, beasts, names});
  let extra = extraActionGrant(document);
  for ( const [index, listed] of usable.entries() ) {
    let activity = listed;
    const notes = [...(pool?.notes ?? [])];
    const label = activity.name || activity.type;
    // An activity a common trait automates (Regeneration's healing) is the trait's, not an Action; one the engine offers
    // itself (Indomitable's reroll) is its feature's.
    // One whose feature's rules the converter writes itself (a paladin's aura; Martial Arts' Monk weapons, which dnd5e
    // enchants one weapon at a time) is those rules'.
    if ( trait?.consumes?.includes(activity) || OFFERED_BY_ENGINE.has(identifierOf(document)) || PALADIN_AURAS[identifierOf(document)]
      || (identifierOf(document) === "martial-arts") ) continue;
    // A test offer is its feature's flag, whatever its activation: one naming its own pool (Countercharm's Reaction), or
    // a die (Peerless Skill), a natural, or a reroll paid from the pool its activity spends (its own, else Second Wind for
    // Tactical Mind). A reroll's roll is its bonus ("@classes.fighter.levels": Indomitable's).
    const offered = TEST_OFFERS[identifierOf(document)];
    if ( offered ) {
      const faces = offered.reroll ? null : testOfferFaces(activity.roll?.formula, scales);
      const offerPool = offered.pool ?? targetPoolId(activity.consumption?.targets?.[0] ?? {}, pool, names);
      // What it spends of that pool (2014 Seeking Spell's 2 Sorcery Points; one when unsaid).
      const offerAmount = number(activity.consumption?.targets?.[0]?.value) ?? 1;
      const bonus = (offered.reroll && activity.roll?.formula) ? formulaExpression(activity.roll.formula, {scales}) : null;
      if ( offered.pool || ((faces || offered.setNatural || offered.reroll) && offerPool) ) {
        const {bonusFormula: _formula, ...row} = offered;
        testOffer = offered.pool ? structuredClone(row)
          : {...row, pool: offerPool, ...((offerAmount > 1) ? {amount: offerAmount} : {}), ...(faces ? {faces} : {}), ...(bonus ? {bonus} : {})};
        continue;
      }
    }
    // A passive or triggered ability is not something a creature uses on its turn; its feature carries its text.
    const activation = pick(activity, system, "activation").type ?? "";
    // A feature used when its creature hits (Stunning Strike): offered on that hit, though dnd5e leaves it passive.
    const onHit = OWN_HIT[`${identifierOf(document)}/${activity.name}`] ?? OWN_HIT[identifierOf(document)] ?? hitOffer(document, activity)
      ?? attackRider(document, activity, activities);
    // An enchantment of one of its creature's weapons (Magic Weapon, Sacred Weapon): its weapon's attacks change instead.
    // Not a weapon of the same name (a creature's Sacred Weapon attack is no Channel Divinity).
    // One of its activities by name (a Helm of Brilliance's Fire Opal Flames) leaves its others be (its casts and saves).
    const enchantByName = ENCHANTS[`${identifierOf(document)}/${activity.name}`] ?? null;
    const enchant = (document.type !== "weapon") ? (enchantByName ?? ENCHANTS[identifierOf(document)] ?? null) : null;
    if ( enchant && !enchantByName && (activity.type !== "enchant") ) continue;
    // A template's enchantment is an Action even with no activation (null when it changes nothing: Adamantine Armor).
    const template = templateEnchant(document, activities)
      ? itemEnchantDefinition({document, activity, system, spell, level, pool, usesOf, scales}) : null;
    // A template makes one Item that magic item: using it again moves the enchantment (its older one ends).
    if ( template?.enchant ) template.enchant.limit ??= {type: "constant", value: 1};
    // Wall of Fire's later damage is its lasting area's repeat (lastingArea).
    if ( spell && (activity === unsavedRepeat(system)) && LASTING_WORDING.test(plainText(document)) ) continue;
    // Acid Arrow's and Vitriolic Sphere's later damage is their Lingering Acid effect's own (lingeringAcid).
    if ( (activity.type === "damage") && LATER_ACID.test(activity.name ?? "")
      && (document.effects ?? []).some(effect => effect.name === "Lingering Acid") ) continue;
    // A stat block's damage at the start of each of the target's turns while its save's condition lasts (a Pit Fiend's
    // Bite) is that condition's effect's own (turnStartDamageEffects), not an Action.
    if ( turnStartDamage(document, activity) ) continue;
    // One another of its Actions stands in for (ACTIONS_BY_HAND `drops`: an Oathbow's Attack Sworn Enemy) is none of its own.
    if ( activities.some(entry => ACTIONS_BY_HAND[`${identifierOf(document)}/${entry.name}`]?.drops?.includes(activity.name)) ) continue;
    // The save a coating applies on its next hit (a Dagger of Venom's Poison Save) is that coating's own (below).
    if ( (activity.type === "save") && (coatingSave(document, activities)?._id === activity._id) ) continue;
    // The check escaping its grapple ("escape DC 15") is the DC on that condition (escapeDCOf), which the common Escape
    // action rolls against with the better of Athletics and Acrobatics: not an Action of its own, whatever its activation
    // (a vehicle's are all Actions). Escaping Manacles or a Net, with no "escape DC", stays its own check.
    if ( (activity.type === "check") && /escape/i.test(activity.name ?? "") && /\bescape DC\b/i.test(plainText(document)) ) continue;
    // So is a passive check its text frees its creature with (escapeCheckOf: Iron Bands' Break Check, DC 20 Athletics).
    // One its user takes an action for stays its own (a Portable Hole's way out is no condition's).
    if ( (activity.type === "check") && !pick(activity, system, "activation").type && (number(activity.check?.dc?.formula) != null)
      && (escapeCheckOf(document)?.dc === number(activity.check.dc.formula)) ) continue;
    // Brutal Strike's Actions are its own (brutalStrikeActions), not its dnd5e damage activity.
    if ( ["brutal-strike", "improved-brutal-strike", "elemental-affinity", "defensive-tactics"].includes(identifierOf(document)) ) continue;
    // A choice it adds to another feature's Action (Restoring Touch on Lay on Hands) is its flag, not an Action.
    if ( CHOICES_FOR[identifierOf(document)] ) continue;
    // One pool traded for another (Wild Resurgence, Font of Magic, Restore Use, Regain Use): used, though dnd5e may leave
    // it passive.
    const trades = tradesPools({document, activity, pool, names, scales});
    // A trap's tier ("Trigger (5-10)", 2024 DMG) is set by the GM as a lasting area (trapDefinition).
    const trapTier = /^Trigger \(\d+[–-]\d+\)$/u.test(activity.name ?? "") && ["save", "damage", "attack"].includes(activity.type);
    // What hitting it costs the attacker (a Black Pudding's Corrosive Form, an Azer's Heated Body): an Action of its own,
    // answering the hit at once (RETALIATION).
    const retaliates = (activity.type === "damage") && RETALIATION_TEXT.test(plainText(document));
    // The others' save of an Action dnd5e splits in two ("Retributive Strike" and its "Retributive Strike: Save": the
    // explosion around a broken Staff of Power) is that Action: its cost, the save in an Emanation around its user. Not a
    // free Action of its own. What else the Action does (its user's own damage, a chance to escape it, the staff's
    // destruction) is noted by hand.
    const companionOf = entry => (entry.type === "save") && usable.some(main => (main !== entry) && (`${main.name}: Save` === entry.name)
      && !["", "none", "special"].includes(main.activation?.type ?? ""));
    if ( companionOf(activity) ) continue;
    const split = usable.find(entry => companionOf(entry) && (entry.name === `${activity.name}: Save`));
    if ( split ) {
      activity = {...split, _id: listed._id, name: listed.name, activation: listed.activation, range: {units: "self", override: true}};
      notes.push(`"${label}": what it does besides the others' save (to its user, to the item) is by hand`);
    }
    // A light source's Light (a Candle's, which dnd5e leaves without an activation) is lit with a Bonus Action (below).
    const lights = (activity.name === "Light") && Boolean(LIGHT_SOURCES[identifierOf(document)]);
    // A creature made over days (a Manual of Golems' golem: "special", its time the table's) is still summoned when it is
    // done, spending the item's one use (madeOnce: "the book is consumed"). shortcut: its holder picks any of its golems,
    // not the one the GM chose.
    const crafted = (activity.type === "summon") && (activation === "special");
    if ( crafted && madeOnce(document) ) activity = {...activity, consumption: {...(activity.consumption ?? {}),
      targets: [...(activity.consumption?.targets ?? []), {type: "itemUses", value: "1"}]}};
    if ( ["", "none", "special"].includes(activation) && !onHit && !enchant && !template && !trades && !trapTier && !retaliates
      && !lights && !crafted && !listed.activation?.free && !USED_AT_TURN_START.has(identifierOf(document)) ) {
      // A recharge when its creature rolls Initiative (Persistent Rage, Uncanny Metabolism, Archdruid): automatic.
      const recharge = initiativeTrigger({document, activity, system, spell, level, scales, notes, pool, names, saveDC, spellDC, creature,
        beasts}) ?? restTrigger(document, activity);
      if ( recharge ) {
        initiativeRules.push(recharge);
        continue;
      }
      // Healing as world time passes (Ring of Regeneration's "every 10 minutes"): a time.elapsed Trigger.
      const interval = intervalTrigger({document, activity, system, spell, level, scales, notes, pool, names, saveDC, spellDC, creature,
        beasts});
      if ( interval ) {
        initiativeRules.push(interval);
        allNotes.push(...notes);
        continue;
      }
      // A swallower's regurgitating save (a Purple Worm's): the dispatcher's, after a turn that cost it enough.
      const regurgitation = regurgitateTrigger({document, activity, system, spell, level, scales, pool, names, saveDC, spellDC, creature,
        beasts});
      if ( regurgitation ) {
        initiativeRules.push(regurgitation);
        continue;
      }
      // Advantage it gives those around it (Aura of Authority): an Aura of roll modes.
      const aura = rollModeAura(document, activity);
      if ( aura ) {
        initiativeRules.push(aura);
        continue;
      }
      // What it does to those around it when its own turn starts or ends (an Azer Sentinel's Fire Aura): automatic.
      const turnArea = turnAreaTrigger({document, activity, system, spell, level, scales, notes, pool, names, saveDC, spellDC, creature,
        beasts});
      if ( turnArea ) {
        initiativeRules.push(turnArea);
        // What it leaves by hand ("(other than you)", "or the spell ends").
        allNotes.push(...notes);
        continue;
      }
      // A mark's bonus damage (Hunter's Mark's, Hex's, Favored Enemy's) is its effect's own rule.
      const marked = (activity.type === "damage") && Object.values(EFFECTS_BY_HAND).some(hand => hand.bonusDamage === label);
      // A feature the engine offers on its own (Eldritch Master, in Magical Cunning) needs no Action; one that becomes its
      // own Action (Action Surge: FEATURE_ACTIONS) is not passive.
      const escape = (activity.type === "check") && /escape/i.test(activity.name ?? "");
      // A free cast's own use (Dragon Companion's Expend Use) is its free cast.
      if ( !trait && !marked && !metamagic && !escape && !OFFERED_BY_ENGINE.has(identifierOf(document)) && !FEATURE_ACTIONS[identifierOf(document)]
        && !FREE_CASTS[identifierOf(document)] ) {
        // A trait whose text names no game rule (an option's heading, a 2014 trait's flavor) is its own description.
        const narrative = NARRATIVE_ACTIVITIES.has(activity.name ?? "")
          || !MECHANICAL_TEXT.test(`${plainText(document)} ${activity.description?.chatFlavor ?? ""}`);
        allNotes.push(`"${label}" is passive or triggered${narrative ? " (narrative)" : ""}: not automated`);
      }
      continue;
    }
    // Monster spellcasting (G4): a cast activity is its spell, at the activity's cost and uses rather than a slot.
    if ( activity.type === "cast" ) {
      const cast = castSpell({document, activity, system, notes, pool, options: {scales, pack, saveDC, names, creature, book, images, spells,
        creatures, forms, beasts, tables}});
      if ( cast ) {
        items.push(...cast);
        allNotes.push(...notes);
        continue;
      }
    }
    const ownTeleport = utilityTeleport(document, activity, system);
    let definition = selfTransformDefinition({document, activity, system, spell, level, notes, pool, forms})
      ?? ((trades && (activity.type === "utility")) ? {...manualDefinition({document, activity, system, spell, level, notes,
      pool, names, scales}), range: {type: "self"}, targeting: {type: "self"}} : null)
      ?? (ownTeleport ? teleportDefinition({document, activity: ownTeleport, system, spell, level, notes, pool}) : null)
      ?? commonActivity({document, activity, system, spell, level, pool}) ?? (ACTIVITIES.has(activity.type)
      ? convertActivity({document, activity, system, spell, level, scales, notes, pool, saveDC, spellDC, creature, beasts, names})
      : ((activity.type === "summon") ? summonDefinition({document, activity, system, spell, level, notes, pool, creatures, names, beasts, scales,
        tables})
        : ((activity.type === "teleport") ? teleportDefinition({document, activity, system, spell, level, notes, pool})
          : ((activity.type === "transform") ? wildShapeDefinition({document, activity, system, spell, level, notes, pool, beasts})
            : (enchant ? enchantDefinition({document, activity, system, spell, level, pool, enchant})
              : ((activity.type === "enchant")
                ? (template ?? itemEnchantDefinition({document, activity, system, spell, level, pool, usesOf, scales}))
                : null))))))
      ?? moveUse({document, activity, system, spell, level, pool}) ?? commonAgainDefinition({document, activity, system, spell, level, pool, img});
    if ( definition && trapTier ) definition = trapDefinition(definition, document.name);
    // 2024 Confusion: "must roll 1d10 at the start of each of its turns to determine its behavior for that turn, consulting
    // the table below": its effect draws that table as each of its creature's turns starts (the dispatcher's).
    const turnTable = tables[TABLE_LINK.exec(String(system.description?.value ?? ""))?.[1]];
    if ( turnTable && definition?.effects?.length && /\bat the start of each of its turns to determine its behavior\b/iu.test(plainText(document)) ) {
      const marked = definition.effects.filter(effect => effect.type === "effect").map(effect => effect.name);
      definition = {...definition, effects: definition.effects.map(effect => ((effect.type === "effect") ? {...effect, drawsAtTurnStart: turnTable} : effect))};
      notes.splice(0, notes.length, ...notes.filter(note => !marked.some(name => note === `effect: "${name}" marks its creature only; its rules are by hand`)));
    }
    const byHand = ACTIONS_BY_HAND[`${identifierOf(document)}/${activity.name}`];
    if ( byHand ) {
      definition = byHand.definition(definition ?? manualDefinition({document, activity, system, spell, level, notes: [], pool, names, scales}));
      for ( const entry of activities.filter(entry => byHand.folds.includes(entry.name || entry.type)) ) folded.add(entry);
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated")), ...(byHand.notes ?? []));
    }
    const light = (activity.name === "Light") ? LIGHT_SOURCES[identifierOf(document)] : null;
    if ( light ) {
      definition ??= manualDefinition({document, activity, system, spell, level, notes: [], pool, names, scales});
      definition = lightDefinition({...definition, ...(["", "none", "special"].includes(activation)
        ? {costs: {allOf: [{capability: "bonus-action", amount: 1}, ...(definition.costs?.allOf ?? []).filter(cost => cost.capability !== "action")]}}
        : {})}, light, document, img);
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated")));
    }
    if ( definition && (system.type?.value === "poison") && (system.type?.subtype === "injury") && (activity.name === "Use Poison") ) {
      definition = coatDefinition(definition, document, img);
    }
    // "You can take a Bonus Action to magically coat the blade with poison" (a Dagger of Venom): its enchantment is the
    // coating, and its save the poison's, as a poison's Use Poison is (coatDefinition). shortcut: the coating's next hit
    // with any weapon of its creature's spends it, not only this one's; upgrade when a hit's event names its weapon.
    const coated = (!definition && (activity.type === "enchant")) ? coatingSave(document, activities) : null;
    const poison = coated ? convertActivity({document, activity: coated, system, spell, level, scales, notes: [], pool, saveDC, spellDC, creature,
      beasts, names}) : null;
    if ( poison ) {
      const own = manualDefinition({document, activity, system, spell, level, notes: [], pool, names, scales});
      definition = coatDefinition({...poison, id: own.id, costs: own.costs}, document, img);
    }
    definition ??= shedsLightDefinition({document, activity, system, spell, level, pool, names, scales, img})
      ?? etherealDefinition({document, activity, system, spell, level, pool, names, scales})
      ?? otherFormDefinition({document, activity, system, spell, level, pool, names, scales, img})
      ?? swallowDefinition({document, activity, system, spell, level, pool, names, scales});
    // What a text rule made it sustain (Flame Blade's light, Expeditious Retreat's marker) is what it concentrates on.
    if ( definition && sustainsConcentration(definition) ) notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("concentration: nothing")));
    if ( !definition ) {
      // Used but not automated: using it spends its cost (and a spell's slot); its description says the rest.
      // A use whose text names no game rule (Alarm, Create or Destroy Water, a Tinderbox) is narrative: spending its cost is
      // all there is to automate.
      // So is a Spellcasting feature's own heading beside the spells it casts (its cast activities are the rules).
      const casts = Object.values(system.activities ?? {}).some(entry => entry.type === "cast");
      definition = manualDefinition({document, activity, system, spell, level, notes, pool, names, scales});
      // So is a teleport off the Scene (Teleport, Plane Shift, Word of Recall: miles, another plane): its creature leaves.
      // So is a spell's use that fills its own pool for its other Actions (Freezing Sphere's Cast and Hold): that is all it does.
      const narrative = ((activity.type === "utility") && (casts || NARRATIVE_USES.has(identifierOf(document))
        || !MECHANICAL_TEXT.test(`${plainText(document)} ${activity.description?.chatFlavor ?? ""}`) || (spell && definition.restores?.length)))
        || ((activity.type === "teleport") && !((number(activity.teleport?.value) > 0) && ((activity.teleport?.units ?? "ft") === "ft")))
        || NARRATIVE_ACTIVITIES.has(activity.name ?? "");
      // A narrative use's area is what it is used on (Sovereign Glue's surfaces). One named narrative (NARRATIVE_ACTIVITIES,
      // NARRATIVE_USES) keeps its counter (a Deck of Illusions' missing cards) and summons (an Iron Flask's trapped creature,
      // whatever it is) as its table's bookkeeping; any other's (a staff's charges from a spell it absorbs) stay noted.
      const named = NARRATIVE_ACTIVITIES.has(activity.name ?? "") || NARRATIVE_USES.has(identifierOf(document));
      if ( narrative ) notes.splice(0, notes.length, ...notes.filter(note => !(named ? /^(?:area|consumption|summon): / : /^area: /).test(note)));
      notes.unshift(`not automated${activity.type === "manual" ? "" : ` (${activity.type}${narrative ? ", narrative" : ""})`}: using it spends its cost; its description says the rest`);
    }
    // A creature it kills rising as its user's (raisedFromKilled) is its damaging Action's summon.
    if ( raised && !folded.has(raised.activity) && definition.damage?.length && !definition.summon ) {
      definition = {...definition, summon: raised.summon};
      folded.add(raised.activity);
      notes.push(...raised.notes);
    }
    // A melee hit on the creature its effects are on answered by them (carriedRetaliation): each effect's reaction. A self
    // spell with none (Armor of Agathys) gives its caster one for its duration to carry it.
    const carrierLasts = (carried && spell && (definition.targeting?.type === "self") && !definition.effects?.length)
      ? lastingDuration(system.duration) : null;
    if ( carrierLasts && carried.ruleFor({name: document.name}) ) definition = {...definition, effects: [{id: "effect-1", type: "effect",
      name: document.name, img, duration: carrierLasts, ruleElements: [],
      ...((system.properties ?? []).includes("concentration") ? {concentration: true} : {})}]};
    const carrying = carried ? (definition.effects ?? []).filter(effect => (effect.type === "effect") && carried.ruleFor(effect)) : [];
    if ( carrying.length ) {
      definition = bindSlot({...definition, effects: definition.effects.map(effect => (carrying.includes(effect)
        ? {...effect, ruleElements: [...(effect.ruleElements ?? []), carried.ruleFor(effect)]} : effect))});
      if ( carried.activity ) folded.add(carried.activity);
      notes.push(...carried.notes);
      carried = null;
    }
    const bearers = (ended || extra) ? (definition.effects ?? []).filter(effect => effect.type === "effect") : [];
    if ( bearers.length ) {
      const rules = [extra?.rule, ended?.rule].filter(Boolean);
      definition = {...definition, effects: definition.effects.map(effect => (bearers.includes(effect)
        ? {...effect, ruleElements: [...(effect.ruleElements ?? []), ...structuredClone(rules)]} : effect))};
      if ( ended ) folded.add(ended.activity);
      notes.push(...(extra?.notes ?? []), ...(ended?.notes ?? []));
      ended = extra = null;
    }
    // What a summoned creature does at its summoner's cost (dnd5e's "Bonus Action used by summoner"; "As a Bonus Action,
    // you can move the sphere up to 30 feet"): its summoner pays (`controllerCosts`), and moving it is a move of that many
    // feet more this turn (an Arcane Eye's Move). shortcut: the move is its Dash (a Speed's worth), or that many feet added
    // to its Speed when they differ; a creature its moving reaches (a Flaming Sphere's save) is the GM's to pick.
    const paid = (creature && !spell) ? summonerPaid(document, activity) : null;
    if ( paid ) {
      definition = {...definition, costs: {allOf: []}, controllerCosts: {allOf: [{capability: paid.capability, amount: 1}]},
        ...((activity.type === "utility") && paid.feet ? {range: {type: "self"}, targeting: {type: "self"}, effects: [{id: "effect-1",
          type: "effect", name: document.name, img: "icons/svg/wingfoot.svg", duration: {value: 0, units: "turns", expiry: "turnEnd"},
          ruleElements: [{schemaVersion: 1, id: "moved", type: "Modifier", data: (paid.feet === creature.speed)
            ? {domains: ["speed.dash"], modifierType: "untyped", value: 1}
            : {domains: ["resources.movement.max"], modifierType: "untyped", value: paid.feet}}]}]} : {})};
      if ( (activity.type === "utility") && paid.feet ) notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated")));
    }
    // Spare the Dying, a Healer's Kit: the creature it touches at 0 Hit Points becomes Stable (the dying adapter's
    // `stabilize`), not a marker beside it.
    if ( STABILIZES.has(identifierOf(document)) ) {
      // shortcut: Spare the Dying's range is its base 15 feet (it doubles at 5th, 11th and 17th level); upgrade when a range
      // can be a ValueExpression.
      definition = {...definition, stabilize: true, targeting: {type: "single", required: true, count: 1},
        range: spell ? {type: "ranged", normal: {value: 15, unit: "ft"}} : {type: "touch", distance: {value: 5, unit: "ft"}},
        effects: (definition.effects ?? []).filter(effect => effect.name !== "Stabilized")};
      if ( !definition.effects.length ) delete definition.effects;
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated") && !/^effect: (?:"Stabilized"|stable )/.test(note)));
    }
    // One that acts on what its user touches (a Feather Token's Anchor on a vessel, Manacles on a creature): that one.
    if ( TOUCHES.has(`${identifierOf(document)}/${activity.name}`) ) definition = {...definition,
      range: {type: "touch", distance: {value: 5, unit: "ft"}}, targeting: {type: "single", required: true, count: 1}};
    // What it may be used only while wearing (2024 Rage: "if you aren't wearing Heavy armor"). shortcut: a Rage going on
    // isn't ended by donning Heavy armor.
    if ( USED_WHILE_WEARING[identifierOf(document)] ) definition = {...definition, requires: definition.requires
      ? {all: [definition.requires, {wearing: USED_WHILE_WEARING[identifierOf(document)]}]} : {wearing: USED_WHILE_WEARING[identifierOf(document)]}};
    // By the activity first (Elemental Attunement's Activate Attunement, not its Elemental Strike), else by the feature.
    const selfEffects = SELF_EFFECTS[`${identifierOf(document)}/${activity.name}`] ?? SELF_EFFECTS[identifierOf(document)];
    if ( selfEffects || USED_AT_TURN_START.has(identifierOf(document)) ) {
      definition = {...definition, range: {type: "self"}, targeting: {type: "self"},
        ...(selfEffects ? {effects: structuredClone(selfEffects)} : {}),
        ...((identifierOf(document) === "steady-aim") ? {requires: NOT_MOVED} : {})};
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated")));
    }
    // A spell that fills its area with light (2024 Daylight's sunlight) is a lasting area shedding it.
    // So does an item whose utility area is Heavily Obscured (an Eversmoking Bottle's smoke). shortcut: with no duration of
    // its own it lasts until removed; the bottle's growth each minute is its size step, and closing it is by hand.
    // Its area's repeat, a save dnd5e leaves passive (Stinking Cloud's Start of Turn Save, Wall of Thorns' Traversal Save):
    // what the lasting area does to a creature in it, not an Action.
    const repeatActivity = areaRepeat(system, activity);
    const repeat = repeatActivity ? convertActivity({document, activity: repeatActivity, system, spell, level, scales, notes: [], pool, saveDC,
      spellDC, creature, beasts, names}) : null;
    const shedding = sheddingArea({document, activity, system, definition, scales, spell: Boolean(spell), repeat});
    if ( shedding ) {
      definition = {...definition, ...shedding.definition};
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated") && !note.startsWith("concentration: nothing")),
        ...shedding.notes);
    }
    // An area that keeps acting while it lasts (Moonbeam, Web, Cloudkill): a lasting area whose trigger repeats it.
    const lasting = shedding ? null : lastingArea({document, system, definition, activity, repeat});
    if ( shedding?.repeated || (lasting && repeat && lasting.area.persistence.triggers.length) ) folded.add(repeatActivity);
    // Or the repeated save of an effect it gives, whose failure deals damage (Weird's End of Turn Save: repeatDamage).
    if ( repeatActivity && !shedding && !lasting && definition.effects?.some(effect => effect.repeatDamage) ) folded.add(repeatActivity);
    if ( lasting ) {
      definition = lasting;
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("concentration: nothing")));
    }
    // A concentration spell that sustains nothing converted (Fog Cloud, Detect Thoughts): its caster still concentrates
    // on it, for its duration. What it sustains is by hand.
    // A cantrip spends no slot, so its later activities (Dancing Lights' Move Lights) are follow-ups of its first.
    if ( spell && (system.properties ?? []).includes("concentration") && !sustainsConcentration(definition)
      && !definition.metadata?.followUp && !(!level && (index > 0)) ) {
      const duration = lastingDuration(pick(activity, system, "duration"));
      definition = {...definition, concentration: duration ? {duration} : {}};
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("concentration: nothing")),
        "concentration: its caster concentrates; what it sustains is by hand");
    }
    // A cantrip's later activity (Dancing Lights' Move Lights) goes on with its first's concentration; it sustains nothing itself.
    else if ( spell && !level && (index > 0) ) notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("concentration: nothing")));
    // A spell's level, for what ends spells by level (Dispel Magic); a slot cast at a higher one says so when used. And
    // the class spell lists it is on (`spellLists`: who may read its Spell Scroll).
    if ( spell && Number.isFinite(Number(level)) ) definition = {...definition, metadata: {...(definition.metadata ?? {}), spellLevel: Number(level),
      ...(spellLists[document._id]?.length ? {spellLists: [...spellLists[document._id]]} : {})}};
    // A spell's tags say what it is, for rules on spell damage: a cantrip, its school (`school:evocation`: Empowered
    // Evocation), itself (`spell:fireball`: a creature immune to it), each damage type it deals (`damage:fire`: Elemental
    // Affinity), and its components (Counterspell). Its lasting area's trigger is the same spell (its school and itself).
    const identity = spell ? [...(SCHOOLS[system.school] ? [`school:${SCHOOLS[system.school]}`] : []), `spell:${identifierOf(document)}`] : [];
    if ( spell && definition.area?.persistence?.triggers?.length ) definition = {...definition, area: {...definition.area,
      persistence: {...definition.area.persistence, triggers: definition.area.persistence.triggers.map(trigger => ({...trigger,
        action: {...trigger.action, tags: [...new Set([...(trigger.action?.tags ?? []), ...identity])]}}))}}};
    if ( spell ) definition = {...definition, tags: [...new Set([...(definition.tags ?? []), ...(Number(level) === 0 ? ["cantrip"] : []),
      ...identity, ...componentTags(system),
      // Sleep magic, which a creature that doesn't sleep shrugs off (2024 Sleep: "Creatures that don't sleep ...").
      ...(/\bdon['’]t sleep\b/iu.test(plainText(document)) ? ["sleep"] : []),
      ...(definition.damage ?? []).map(component => component.damageType).filter(Boolean).map(type => `damage:${type}`)])]};
    // A feature that casts a spell with a slot is that spell's cast (Boon of Spell Recall's d4, Counterspell): its spell's
    // tags. Its use paid otherwise (Wild Companion's Wild Shape) has no slot level, so it would sit among cantrips; it stays a feature's.
    const castsWithSlot = SLOT_CASTS[identifierOf(document)];
    if ( castsWithSlot && definition && (activity.consumption?.targets ?? []).some(target => target.type === "spellSlots") ) {
      definition = {...definition, tags: [...new Set([...(definition.tags ?? []), ...castsWithSlot])]};
    }
    // Lay on Hands: "restore a number of Hit Points equal to the points spent", chosen when used, from its pool.
    if ( (identifierOf(document) === "lay-on-hands") && (activity.type === "heal") && pool ) {
      definition = {...definition, costs: {allOf: (definition.costs?.allOf ?? []).filter(cost => cost.capability !== pool.id)},
        targeting: definition.targeting ?? {type: "single", required: true, count: 1},
        // "touch a creature" (dnd5e records its range as self).
        range: {type: "touch", distance: {value: 5, unit: "ft"}},
        healing: [{id: "healing-1", expression: {type: "constant", value: 1}, healingType: "healing"}],
        // 0 when it only ends Restoring Touch's conditions.
        configuration: [...(definition.configuration ?? []), {id: "points", type: "number", label: "Points", required: true, min: 0,
          effects: [{type: "spendAmount", resourceId: pool.id, componentIds: ["healing-1"]}]}]};
      notes.splice(0, notes.length, ...notes.filter(note => !/not automated|custom formula/.test(note)));
    }
    // Its Remove Poison touches a creature too (dnd5e records its range as self).
    if ( (identifierOf(document) === "lay-on-hands") && (activity.name === "Remove Poison") ) definition = {...definition,
      targeting: {type: "single", required: true, count: 1}, range: {type: "touch", distance: {value: 5, unit: "ft"}}};
    // What it ends on its target (Remove Curse: curses; Dispel Magic: spells up to its level).
    const ending = ENDS[identifierOf(document)];
    if ( ending ) {
      const range = definition.range ?? rangeOf({activity, system, document, attack: null});
      // One that may end an area has no creature to require: the authority asks for a creature or an area.
      definition = {...definition, ends: structuredClone(ending),
        targeting: ending.areas ? {type: "single", required: false, count: 1} : (definition.targeting ?? {type: "single", required: true, count: 1}),
        ...(range ? {range} : {})};
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated")));
    }
    // Flurry of Blows: its Bonus Action and Focus Point fill the strikes Martial Arts' Flurry strike spends.
    const flurry = (identifierOf(document) === "monks-focus") && (activity.name === "Flurry of Blows");
    if ( flurry ) {
      definition = {...definition, range: {type: "self"}, targeting: {type: "self"}, restores: [...(definition.restores ?? []),
        {resourceId: FLURRY_POOL.data.resourceId, amount: 1, amountExpression: structuredClone(FLURRY_POOL.data.maximum)}]};
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated")));
    }
    // 2024 Heightened Focus (monk 10): Patient Defense with a Focus Point also gives Temporary Hit Points of two rolls of the
    // Martial Arts die; none below level 10.
    if ( (identifierOf(document) === "monks-focus") && (activity.name === "Patient Defense (Focus Point)") ) definition = {...definition,
      healing: [...(definition.healing ?? []), {id: "heightened-focus", healingType: "temporary", expression: {type: "table",
        key: {type: "class-level", class: "monk"}, rows: {10: formulaExpression("2@scale.monk.die", {scales})},
        default: {type: "constant", value: 0}}}]};
    if ( identifierOf(document) === "magical-cunning" ) {
      definition = {...definition, range: {type: "self"}, targeting: {type: "self"},
        restores: [...(definition.restores ?? []), structuredClone(MAGICAL_CUNNING_RESTORE)]};
      notes.splice(0, notes.length, ...notes.filter(note => !/^not automated|^consumption: attribute|^activation: 1 minute/.test(note)));
    }
    const push = forcedMovement(document, definition);
    if ( push ) definition = {...definition, push};
    const suffix = usable.length > 1 ? ` (${label})` : "";
    const id = index ? stableId(`${document._id}:${index}`) : document._id;
    const action = (actionId, name, actionDefinition) => ({
      _id: actionId, _key: `!items!${actionId}`, name, type: "action", img,
      system: {active: true, description, definition: {...actionDefinition, label: name},
        ruleElements: [pool?.rule, activityPool({document, activity, scales})?.rule, ...attackModifiers({activity, system,
          definition: actionDefinition, notes})].filter(Boolean)},
      flags: {wildpath: {source, conversion: {notes}}}
    });
    // "Disengage or Hide" (Nimble Escape): this Action is the first, and each other is an Action of its own.
    const choices = (activity.type === "utility") ? COMMON_CHOICES[`${identifierOf(document)}/${activity.name}`] : null;
    const title = common => ` (${common.charAt(0).toUpperCase()}${common.slice(1)})`;
    // A reaction its 2024 text triggers (Shield, Parry, Counterspell): a Trigger on its Action, which the engine offers.
    const reaction = (activation === "reaction") ? REACTIONS[identifierOf(document)] : (retaliates ? RETALIATION : null);
    if ( retaliates ) definition = {...definition, ...structuredClone(RETALIATION_ACTION)};
    // Its failed save cancels the spell it answers: that is what it does.
    if ( reaction?.counters ) {
      definition = {...definition, counters: true};
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("rolled (save)")));
    }
    // Cutting Words: on the attacker within its range, rolling its die (`@scale.bard.inspiration`) off that attack roll.
    const penaltyDie = reaction?.attackPenalty ? formulaExpression(String(activity.roll?.formula ?? ""), {scales}) : null;
    if ( penaltyDie ) {
      const range = rangeOf({activity, system, document, attack: null});
      definition = {...definition, ...(range ? {range} : {}), targeting: {type: "single", required: true, count: 1},
        rider: {attackPenalty: {dice: penaltyDie}}};
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated")));
    }
    // "adds 2 to its AC against that attack" (a Parry; dnd5e keeps the 2 in its activity's roll): that much AC on itself
    // until the attack is over.
    // A number, or a formula (the 2024 Monster Manual's "adds its Proficiency Bonus": `@prof`).
    const bonusAC = reaction?.acFromText ? (number(activity.roll?.formula)
      ?? number(/\b(?:adds (\d+) to its AC|gaining a \+(\d+) bonus to your Armor Class) against (?:that|the triggering) attack/i
        .exec(plainText(document))?.slice(1).find(Boolean))
      ?? formulaExpression(String(activity.roll?.formula ?? ""), {scales})) : null;
    if ( reaction?.halves && !definition.effects?.length ) {
      definition = {...definition, range: {type: "self"}, targeting: {type: "self"}, effects: [{id: "effect-1", type: "effect",
        name: document.name, ...(img ? {img} : {}), endsWhen: "attacked", ruleElements: [{schemaVersion: 1, id: "halved",
          type: "GrantResistance", data: {damageTypes: []}}]}]};
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated")));
    }
    // Its Trigger brings a common Action (Retaliation's melee attack), so its own utility does nothing more.
    if ( reaction?.commonAction ) notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated")));
    if ( reaction?.reduces || reaction?.redirect || reaction?.reducesPush ) {
      const {healing: _healing, ...rest} = definition;
      definition = {...rest, range: {type: "self"}, targeting: {type: "self"}, rider: {
        ...(reaction.reduces ? {reduceDamage: structuredClone(reaction.reduces)} : {}),
        ...(reaction.reducesPush ? {reducePush: reaction.reducesPush} : {}),
        ...(reaction.redirect ? {redirectDamage: structuredClone(reaction.redirect)} : {}),
        ...(reaction.protects ? {protects: reaction.protects} : {})}};
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated")));
    }
    if ( bonusAC && !definition.effects?.length ) {
      definition = {...definition, range: {type: "self"}, targeting: {type: "self"}, effects: [{id: "effect-1", type: "effect",
        name: document.name, ...(img ? {img} : {}), endsWhen: "attacked", ruleElements: [{schemaVersion: 1, id: "parry", type: "Modifier",
          data: {domains: ["defense.ac"], modifierType: "untyped", ...((typeof bonusAC === "number") ? {value: bonusAC} : {valueExpression: bonusAC})}}]}]};
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated")));
    }
    const smite = (identifierOf(document) === "divine-smite") ? SMITE_TRIGGER : null;
    if ( smite ) definition = smiteDefinition(definition);
    if ( onHit ) {
      definition = {...onHit.definition(definition), ...(onHit.self ? {range: {type: "self"}, targeting: {type: "self"}}
        : {range: {type: "special"}, targeting: {type: "single", required: true, count: 1}}),
      ...(onHit.rider ? {rider: structuredClone(onHit.rider)} : {})};
      // Its effects are its own now, not dnd5e's; a stat block's rider keeps what its effects still leave by hand.
      notes.splice(0, notes.length, ...notes.filter(note => onHit.keepNotes ? !/^(?:not automated|activation:)/u.test(note)
        : (!note.startsWith("effect: ") && !note.startsWith("not automated") && !note.startsWith("save: a failure gives")
          && !onHit.dropNotes?.test(note))));
    }
    if ( riderTag && (activity.type === "attack") ) definition = {...definition, tags: [...new Set([...(definition.tags ?? []), riderTag])]};
    const named = smite ? (/unholy/i.test(activity.name ?? "") ? " (Undead or Fiend)" : "") : suffix;
    const reacting = action(id, `${document.name}${named}${choices ? title(choices[0]) : ""}`, definition);
    // A spell's hit too, for an offer marked `spell` (Repelling Blast on Eldritch Blast).
    const {notTagsAny: _spells, ...anyHit} = SMITE_TRIGGER.match;
    const smiting = smite ? {...smite, triggerPredicate: /unholy/i.test(activity.name ?? "") ? UNHOLY : {not: UNHOLY}} : null;
    const trigger = reaction ?? smiting ?? (onHit ? {...SMITE_TRIGGER, match: {...(onHit.spell ? anyHit : SMITE_TRIGGER.match),
      ...(onHit.tagsAll ? {tagsAll: onHit.tagsAll} : {})}, once: onHit.once, onceKey: onHit.onceKey, uses: onHit.uses,
      triggerPredicate: onHit.triggerPredicate} : null);
    if ( trigger ) reacting.system.ruleElements.push({schemaVersion: 1, id: "reaction", type: "Trigger",
      data: {kind: "reaction", event: trigger.event, match: trigger.match, ...(trigger.commonAction ? {commonAction: trigger.commonAction} : {}),
        ...(trigger.triggerPredicate ? {triggerPredicate: structuredClone(trigger.triggerPredicate)} : {}),
        ...(trigger.once ? {once: trigger.once} : {}),
        ...(trigger.onceKey ? {onceKey: trigger.onceKey} : {}), ...(trigger.uses ? {uses: trigger.uses} : {})}});
    if ( flurry ) reacting.system.ruleElements.push(structuredClone(FLURRY_POOL));
    // Retaliation is no choice: it happens whenever it is hit (`reactionPolicy: always`).
    if ( retaliates || onHit?.always ) reacting.flags.wildpath.reactionPolicy = "always";
    items.push(reacting);
    // Cutting Words on an ability check (the same die off it, then judged again), and on a damage roll: an Action of its
    // own, which comes with it (`grants`), whose die comes off that roll before anyone's share of it.
    if ( penaltyDie ) {
      reacting.system.ruleElements.push({schemaVersion: 1, id: "reaction-check", type: "Trigger", data: {kind: "reaction",
        event: "check.succeeded", match: {phase: "interrupt", notSourceTokenId: "{self}"}, triggerPredicate: seenHostileWithin(60)}});
      const damageId = stableId(`${id}:damage`);
      const onDamage = action(damageId, `${document.name}${suffix} (Damage)`, {...definition, id: `${definition.id}-damage`,
        rider: {damagePenalty: {dice: structuredClone(penaltyDie)}}});
      onDamage.system.ruleElements.push({schemaVersion: 1, id: "reaction", type: "Trigger", data: {kind: "reaction",
        event: "damage.applied", match: {phase: "before", notSourceTokenId: "{self}"}, triggerPredicate: seenHostileWithin(60)}});
      reacting.flags.wildpath.grants = [damageId];
      items.push(onDamage);
    }
    for ( const other of choices?.slice(1) ?? [] ) items.push(action(stableId(`${id}:${other}`), `${document.name}${suffix}${title(other)}`,
      commonActivity({document, activity, system, spell, level, pool}, [other])));
    // Its common action again as a Bonus Action while its spell lasts (Expeditious Retreat): its own Action, no slot spent.
    const again = commonAgain(document, activity);
    if ( again ) items.push(action(stableId(`${id}:again`), `${document.name}${suffix}${title(again)}`, {schemaVersion: 1,
      id: `${definition.id}-again`, costs: {allOf: [{capability: "bonus-action", amount: 1}]}, ...commonRules(again),
      requires: {hasCondition: identifierOf(document)}}));
    // A lasting area its caster can move ("a Magic action ... to move the Cylinder up to 60 feet"): its own Action.
    const moveArea = moveAreaDefinition(document, definition);
    if ( moveArea ) items.push(action(stableId(`${id}:move`), `${document.name}${suffix} (Move)`, moveArea));
    // Wild Shape's "leave the form early as a Bonus Action" (its class level's limits): its own Action. A concentration
    // form (Shapechange) ends as its concentration does.
    if ( definition.transform?.limits?.rows ) items.push(action(stableId(`${id}:revert`), `${document.name}${suffix} (Revert)`,
      {schemaVersion: 1, id: `${definition.id}-revert`, costs: {allOf: [{capability: "bonus-action", amount: 1}]},
        range: {type: "self"}, targeting: {type: "self"}, transform: {revert: true}}));
    // Its Bonus Action attack (Scimitar of Speed), once a turn as the Bonus Action is.
    if ( activity.bonusToo ) items.push(action(stableId(`${id}:bonus`), `${document.name}${suffix} (Bonus Action)`,
      {...definition, id: `${definition.id}-bonus`, costs: {allOf: [{capability: "bonus-action", amount: 1}]}}));
    // Thrown: the weapon thrown is its own Action, a ranged attack at its range.
    const thrown = thrownDefinition({document, system, definition});
    if ( thrown ) items.push(action(stableId(`${id}:thrown`), `${document.name}${suffix} (Thrown)`, thrown));
    // 2024 Versatile: the weapon with both hands is its own Action, rolling its larger die.
    const twoHanded = versatileDefinition({document, system, definition});
    if ( twoHanded ) items.push(action(stableId(`${id}:two-handed`), `${document.name}${suffix} (Two-Handed)`, twoHanded));
    allNotes.push(...notes);
  }
  for ( const entry of folded ) {
    const note = `"${entry.name || entry.type}" is passive or triggered`;
    allNotes.splice(0, allNotes.length, ...allNotes.filter(each => !each.startsWith(note)));
  }
  // What it gives while it is had (worn, for gear): its passive effects' rules.
  const passive = [...passiveEffects(document).flatMap(effect => effectRules(effect, allNotes, {scales, text: plainText(document)})), ...emptyPassiveRules(document, allNotes)]
    // Only while its creature wears what its text allows (Unarmored Movement: no armor or Shield; Fast Movement: no Heavy armor).
    .map(rule => (WEARING_GATES[identifierOf(document)] ? {...rule, predicate: rule.predicate
      ? {all: [rule.predicate, {wearing: WEARING_GATES[identifierOf(document)]}]} : {wearing: WEARING_GATES[identifierOf(document)]}} : rule));
  // What its 2024 wording gives that dnd5e leaves out (Dwarven Resilience's Advantage on saves against Poisoned), unless
  // its Action's effect already carries it (a vial of Antitoxin, for its hour).
  const onEffect = items.some(item => (item.system?.definition?.effects ?? []).some(effect => (effect.ruleElements ?? [])
    .some(rule => rule.predicate?.tagsAny?.some(tag => String(tag).startsWith("against:")))));
  if ( !onEffect ) {
    // A trait's own "can't regain Hit Points" too (a swarm's), only a feature's: a weapon's text speaks of its target.
    const phrased = [...savesAgainstRules(plainText(document), identifierOf(document)),
      ...((document.type === "feat") ? bearerHealingRules(plainText(document), identifierOf(document)) : [])];
    for ( const rule of phrased ) {
      if ( !passive.some(entry => entry.id === rule.id) ) passive.push(rule);
    }
  }
  // A trait that moves through or shares other creatures' spaces (a swarm's, Incorporeal Movement).
  if ( document.type === "feat" ) {
    for ( const rule of occupancyRules(plainText(document), identifierOf(document)) ) {
      if ( !passive.some(entry => entry.id === rule.id) ) passive.push(rule);
    }
  }
  // Equipment is gear its owner equips (G7): armor's AC, and its passive effects. A potion or scroll is only its Actions.
  if ( GEAR_TYPES.has(document.type) && !((document.type === "consumable") && items.length) ) {
    const gearId = items.some(item => item._id === document._id) ? stableId(`${document._id}:gear`) : document._id;
    // Its training is its flag, no longer a note.
    if ( trainingKeys(document).length ) allNotes.splice(0, allNotes.length, ...allNotes.filter(note => !/traits\.(armorProf|weaponProf|languages)/.test(note)));
    items.unshift({_id: gearId, _key: `!items!${gearId}`, name: document.name, type: "gear", img,
      system: {active: false, description, quantity: Math.max(0, Math.round(number(system.quantity) ?? 1)),
        weight: number(system.weight?.value ?? system.weight) ?? 0, slot: "", ruleElements: [...armorRules(document, allNotes), ...(trait?.rules ?? []), ...passive],
        attunement: (system.attunement === "required") ? "required" : "", armor: (document.type === "equipment" ? armorKind(system) : null) ?? "",
        // Its price in gold, and its rarity (crafting it).
        price: priceInGold(system.price), ...(system.rarity ? {rarity: system.rarity} : {}),
        // What it looks like before it is identified (dnd5e's own), for its GM to hand out unidentified.
        ...(system.unidentified?.name ? {unidentified: {name: system.unidentified.name, description: system.unidentified.description ?? ""}} : {})},
      // Its Actions come with it when it is added to a creature (WildPathItem).
      flags: {wildpath: {source, conversion: {notes: [...new Set(allNotes)]}, ...(items.length ? {grants: items.map(item => item._id)} : {}),
        ...(trainingKeys(document).length ? {training: trainingKeys(document)} : {})}}});
  }
  // Halfling Luck: its dnd5e flag is its test offer.
  if ( (document.effects ?? []).some(effect => effectChanges(effect)
    .some(change => change.key === "flags.dnd5e.halflingLucky")) ) testOffer ??= structuredClone(HALFLING_LUCK);
  // A test offer of a feature dnd5e gives no activity (Boon of Combat Prowess, Fanatical Focus): its own entry, its pool
  // its trait's or its Action's, its bonus its own formula.
  if ( !activities.length && TEST_OFFERS[identifierOf(document)]?.pool ) {
    const {bonusFormula, ...row} = TEST_OFFERS[identifierOf(document)];
    testOffer ??= {...structuredClone(row), ...(bonusFormula ? {bonus: formulaExpression(bonusFormula, {scales})} : {})};
  }
  if ( FREE_CASTS[identifierOf(document)]?.note ) allNotes.push(FREE_CASTS[identifierOf(document)].note);
  // Nothing to use: a passive ability is a feature carrying its text (and any uses its other Actions spend).
  if ( !items.length ) {
    // Its training is its flag (`flags.wildpath.training`), no longer a note.
    if ( trainingKeys(document).length ) allNotes.splice(0, allNotes.length, ...allNotes.filter(note => !/traits\.(armorProf|weaponProf|languages)/.test(note)));
    // An extra cantrip is its cantrip choice (FEAT_ADVANCEMENT), not dnd5e's raised cantrips-known scale.
    if ( FEAT_ADVANCEMENT[identifierOf(document)]?.advancement.some(entry => entry.pool?.spellLevel === 0) ) {
      allNotes.splice(0, allNotes.length, ...allNotes.filter(note => !/change system\.scale\.\w+\.cantrips-known\.value/.test(note)));
    }
    items.push({_id: document._id, _key: `!items!${document._id}`, name: document.name, type: "feature", img,
      // Portent's and Infuse Item's dnd5e use counts are no pool: its dice are (portentDice), and its limit is the
      // enchantments' (itemEnchantDefinition).
      system: {active: true, description, ruleElements: [(["portent", "infuse-item"].includes(identifierOf(document)) || FREE_CASTS[identifierOf(document)]) ? null : pool?.rule,
        ...(trait?.rules ?? []), ...initiativeRules,
        // A paladin's aura is what it grants those around it, not what its dnd5e effect gives the paladin alone.
        ...(PALADIN_AURAS[identifierOf(document)] ? [paladinAura(identifierOf(document))] : passive),
        ...((identifierOf(document) === "paladins-smite") ? [PALADINS_SMITE.pool] : []),
        ...((identifierOf(document) === "mystic-arcanum") ? structuredClone(MYSTIC_ARCANUM_POOLS) : []),
        ...((identifierOf(document) === "signature-spells") ? structuredClone(SIGNATURE_SPELL_POOLS) : []),
        ...(FREE_CASTS[identifierOf(document)] ? [{schemaVersion: 1, id: `${identifierOf(document)}-free-cast`, type: "GrantResource",
          data: {resourceId: freeCastResource(identifierOf(document)), label: document.name,
            maximum: structuredClone(FREE_CASTS[identifierOf(document)].maximum ?? 1),
            recovery: FREE_CASTS[identifierOf(document)].recovery}}] : []),
        ...structuredClone(FEAT_ADVANCEMENT[identifierOf(document)]?.rules ?? [])].filter(Boolean),
        ...(FEAT_ADVANCEMENT[identifierOf(document)] ? {advancement: structuredClone(FEAT_ADVANCEMENT[identifierOf(document)].advancement)} : {})},
      flags: {wildpath: {source, conversion: {notes: [...new Set(allNotes)]}, ...(metamagic ? {metamagic} : {}),
        ...(testOffer ? {testOffer} : {}), ...(trainingKeys(document).length ? {training: trainingKeys(document)} : {}),
        ...(IGNORES_RESISTANCE[identifierOf(document)] ? {ignoresResistance: [...IGNORES_RESISTANCE[identifierOf(document)]]} : {}),
        ...((identifierOf(document) === "savage-attacker") ? {damageTwice: true} : {}),
        ...((identifierOf(document) === "boon-of-spell-recall") ? {slotRecall: structuredClone(SLOT_RECALL)} : {}),
        ...(SPELL_CHOICES[identifierOf(document)] ? {spellChoice: structuredClone(SPELL_CHOICES[identifierOf(document)])} : {}),
        ...(CHOICES_FOR[identifierOf(document)] ? {choiceFor: structuredClone(CHOICES_FOR[identifierOf(document)])} : {}),
        ...(FREE_CASTS[identifierOf(document)] ? {freeCast: {spells: [...FREE_CASTS[identifierOf(document)].spells],
          ...(FREE_CASTS[identifierOf(document)].granted ? {granted: true} : {}),
          ...(FREE_CASTS[identifierOf(document)].fromFeatures ? {fromFeatures: [...FREE_CASTS[identifierOf(document)].fromFeatures]} : {}),
          resourceId: freeCastResource(identifierOf(document))}} : {}),
        ...(FEAT_ADVANCEMENT[identifierOf(document)]?.castingAbilities
          ? {castingAbilities: [...FEAT_ADVANCEMENT[identifierOf(document)].castingAbilities]} : {}),
        // The Diviner's Portent (a monster's, used when it sees a roll, is an Action of its own).
        ...((identifierOf(document) === "portent") ? {portentDice: structuredClone(PORTENT_DICE)} : {})}}});
    if ( identifierOf(document) === "paladins-smite" ) items.push(...paladinsSmiteActions(document, img, source));
    if ( identifierOf(document) === "brutal-strike" ) items.push(...brutalStrikeActions(document, img, source, scales));
    if ( identifierOf(document) === "improved-brutal-strike" ) items.push(...improvedBrutalStrikeActions(document, img, source));
    // Elemental Affinity brings the Action choosing its type.
    // So does Genie's Wrath.
    if ( ["elemental-affinity", "genies-wrath"].includes(identifierOf(document)) ) {
      const choose = ((identifierOf(document) === "genies-wrath") ? geniesWrathAction : elementalAffinityAction)(document, img, source);
      items[0].flags.wildpath.grants = [choose._id];
      items.push(choose);
    }
    // Fiendish Resilience too, once per Short or Long Rest (its feature's pool).
    if ( identifierOf(document) === "fiendish-resilience" ) {
      const choose = fiendishResilienceAction(document, img, source);
      items[0].system.ruleElements.push({schemaVersion: 1, id: "fiendish-resilience-uses", type: "GrantResource",
        data: {resourceId: "fiendish-resilience", label: "Fiendish Resilience", maximum: 1, recovery: "shortRest"}});
      items[0].flags.wildpath.grants = [choose._id];
      items.push(choose);
    }
    // Defensive Tactics too: one of its two options, changed on a rest.
    if ( identifierOf(document) === "defensive-tactics" ) {
      const choose = defensiveTacticsAction(document, img, source);
      items[0].system.ruleElements.push({schemaVersion: 1, id: "defensive-tactics-uses", type: "GrantResource",
        data: {resourceId: "defensive-tactics", label: "Defensive Tactics", maximum: 1, recovery: "shortRest"}});
      items[0].flags.wildpath.grants = [choose._id];
      items.push(choose);
    }
    // Martial Arts brings its Unarmed Strikes with it, so its class grants the feature alone; its Monk weapons' rules are
    // its own.
    if ( identifierOf(document) === "martial-arts" ) {
      const strikes = martialArtsActions(document, img, source, scales);
      items[0].system.ruleElements.push(...monkWeaponRules(scales));
      items[0].flags.wildpath.grants = strikes.map(strike => strike._id);
      items.push(...strikes);
    }
  }
  // An Item with Actions carries its automatic triggers on its first (Tireless' Short Rest trigger).
  if ( initiativeRules.length && items.length && (items[0].type !== "feature") ) items[0].system.ruleElements.push(...initiativeRules);
  // A light source dnd5e gives no Light activity (a Torch): lighting it, a Bonus Action with a Tinderbox.
  const unlit = LIGHT_SOURCES[identifierOf(document)];
  if ( unlit && !activities.some(activity => activity.name === "Light") ) {
    const id = stableId(`${document._id}:light`);
    items.push({_id: id, _key: `!items!${id}`, name: `${document.name} (Light)`, type: "action", img,
      system: {active: true, description, definition: lightDefinition({schemaVersion: 1, id: `action:srd-${slugify(document.name)}-light`,
        label: `${document.name} (Light)`, costs: {allOf: [{capability: "bonus-action", amount: 1}]}}, unlit, document, img), ruleElements: []},
      flags: {wildpath: {source, conversion: {notes: []}}}});
  }
  // A feature used on its turn that dnd5e leaves without an Action (Action Surge): its Action, paid from its own pool.
  // One Action, or several, each named (Slasher's Hamstring and Enhanced Critical).
  const featureActions = [FEATURE_ACTIONS[identifierOf(document)] ?? []].flat();
  const hasAction = items.some(item => item.type === "action");
  for ( const [index, featureAction] of featureActions.entries() ) {
    if ( !(pool?.rule || featureAction.free || featureAction.costs) || hasAction ) continue;
    const id = stableId(index ? `${document._id}:use:${index}` : `${document._id}:use`);
    const name = featureAction.name ? `${document.name} (${featureAction.name})` : document.name;
    // An entry may bring its own uses (`pool`), reach a creature (`range`, `targeting`), or answer an event of its user's
    // own (`trigger`: Tactical Shift on its Second Wind), offered as its `policy` says.
    const definition = {schemaVersion: 1, id: `action:srd-${slugify(name)}`, label: name,
      costs: {allOf: featureAction.costs ?? (featureAction.free ? [] : [{capability: pool.id, amount: 1}])},
      range: structuredClone(featureAction.range ?? {type: "self"}), targeting: structuredClone(featureAction.targeting ?? {type: "self"}),
      effects: structuredClone(featureAction.effects ?? []),
      ...(featureAction.damage ? {damage: structuredClone(featureAction.damage)} : {}),
      ...(featureAction.retarget ? {retarget: structuredClone(featureAction.retarget)} : {}),
      ...(featureAction.healing ? {healing: structuredClone(featureAction.healing)} : {}),
      ...(featureAction.targetChoice ? {targetChoice: structuredClone(featureAction.targetChoice)} : {}),
      ...(featureAction.configuration ? {configuration: structuredClone(featureAction.configuration)} : {}),
      ...(featureAction.teleport ? {teleport: structuredClone(featureAction.teleport)} : {}),
      ...(featureAction.requires ? {requires: structuredClone(featureAction.requires)} : {}),
      ...(featureAction.restores ? {restores: structuredClone(featureAction.restores)} : {})};
    // A free one answering its event (Fanatical Focus's refill, Studied Attacks' mark, Tactical Shift's move) is its
    // feature's own Trigger carrying the Action, so there is no free Action Item to use by hand. Each of a feature's
    // several has its own Trigger id (Slasher's Hamstring and Enhanced Critical).
    if ( featureAction.free && featureAction.trigger && (items[0]?.type === "feature") ) {
      items[0].system.ruleElements.push(...[pool?.rule ? null : structuredClone(featureAction.pool ?? null), {schemaVersion: 1,
        id: featureAction.name ? `reaction-${slugify(featureAction.name)}` : "reaction", type: "Trigger",
        data: {...structuredClone(featureAction.trigger), action: definition,
          ...(featureAction.policy ? {policy: featureAction.policy} : {})}}].filter(Boolean));
      continue;
    }
    items.push({_id: id, _key: `!items!${id}`, name, type: "action", img,
      system: {active: true, description, definition,
      ruleElements: [pool?.rule ?? structuredClone(featureAction.pool ?? null),
        featureAction.trigger ? {schemaVersion: 1, id: "reaction", type: "Trigger", data: structuredClone(featureAction.trigger)} : null]
        .filter(Boolean)},
      flags: {wildpath: {source, conversion: {notes: []}, ...(featureAction.policy ? {reactionPolicy: featureAction.policy} : {})}}});
    // A feat is taken alone (an Epic Boon chosen at level 19), so its feature brings its Action; a class grants both. Gear
    // brings its own (a Deck of Many Things card).
    if ( ((system.type?.value === "feat") && (items[0]?.type === "feature")) || (items[0]?.type === "gear") ) {
      items[0].flags.wildpath.grants = [...(items[0].flags.wildpath.grants ?? []), id];
    }
  }
  // What it costs and how rare it is, on Actions that stand for it with no gear (an SRD Longbow, a Potion of Healing).
  const price = priceInGold(system.price);
  if ( price || system.rarity ) for ( const item of items.filter(entry => entry.type === "action") ) {
    item.flags.wildpath = {...item.flags.wildpath, price, ...(system.rarity ? {rarity: system.rarity} : {})};
  }
  // What it asks of its creature (a feat's, an Invocation's), on each Item it became (the level-up dialog offers it only then).
  const chosen = (system.type?.value === "feat") || ["eldritchInvocation", "artificerInfusion", "maneuver", "metamagic", "fightingStyle"]
    .includes(system.type?.subtype);
  const prerequisites = chosen ? prerequisitesOf(system) : null;
  if ( prerequisites ) for ( const item of items ) item.flags = {...(item.flags ?? {}), wildpath: {...(item.flags?.wildpath ?? {}), prerequisites}};
  // A feature that became nothing that acts (no rules, no Actions, nothing flagged for the engine) while its text names a
  // rule is said to be by hand, so the census counts it: 2024 Brave was one until its wording was read.
  const [only] = items;
  if ( (items.length === 1) && (only.type === "feature") && !allNotes.length && !only.system.ruleElements.length
    && !only.system.advancement && !Object.keys(only.flags.wildpath).some(key => !["source", "conversion", "prerequisites"].includes(key))
    && !ENGINE_FEATURES.has(identifierOf(document)) && !OFFERED_BY_ENGINE.has(identifierOf(document)) && SILENT_MECHANICS.test(plainText(document)) ) {
    const note = NARRATIVE_FEATURES.has(identifierOf(document)) ? `"${document.name}" is passive or triggered (narrative): not automated`
      : "silent: its text names a rule that is not converted (by hand)";
    allNotes.push(note);
    only.flags.wildpath.conversion.notes.push(note);
  }
  return {ok: true, items, notes: [...new Set(allNotes)]};
}

/**
 * Damage types whose Resistance its creature's damage ignores (`flags.wildpath.ignoresResistance`, read by the runtime):
 * 2024 Boon of Irresistible Offense's Overcome Defenses. shortcut: its Overwhelming Strike (a 20's extra damage) is by hand.
 */
const IGNORES_RESISTANCE = Object.freeze({"boon-of-irresistible-offense": ["bludgeoning", "piercing", "slashing"]});

/**
 * 2024 Boon of Spell Recall's Free Casting (`flags.wildpath.slotRecall`, read by the runtime): a spell paid with a slot
 * of level 1-4 rolls 1d4, and a roll equal to the slot's level leaves the slot unspent.
 */
const SLOT_RECALL = Object.freeze({dice: {type: "dice", number: 1, faces: 4}, maxLevel: 4});

/*
 * 2024 Savage Attacker (`flags.wildpath.damageTwice`): once a turn, its weapon's damage dice are rolled twice and the
 * higher total is kept (combat-statistics `bestOfTwo`; Foundry's dice pool `{2d6,2d6}kh`). Its user would always
 * choose the higher, so nothing is asked.
 */

/** Words that name a rule in a feature's text (silent features, above). */
// Also what refills, rerolls or changes dice (Perfect Focus, Great Weapon Fighting were missed by the first list), and
// "damage dice" (Savage Attacker's rolling them twice).
const SILENT_MECHANICS = /\b(?:Advantage|Disadvantage|Resistance|Immunity|immune|Speed|bonus to|can't|Hit Point maximum|Armor Class|regain|reroll|roll Initiative|damage dice?|extra damage|Temporary Hit Points|saving throw)\b/u;
/**
 * Features whose rule is their class's or species' advancement, which the level-up dialog runs (`improvement`, `choice`),
 * or another feature's rule reading them (Infiltration Expertise: Steady Aim's `hasFeature`): the feature Item is only
 * its name and text.
 */
const ENGINE_FEATURES = new Set(["ability-score-improvement", "divine-order", "primal-order", "eldritch-invocations", "giant-ancestry",
  "druidic", "celestial-resistance", "elven-lineage", "fiendish-legacy", "infiltration-expertise",
  // A class's spellcasting and Pact Magic (its slots), a lineage's spells (its species' grants), Improved Brutal Strike's
  // second option and 2d10 (Brutal Strike's own level tables).
  "spellcasting", "pact-magic", "elven-lineage-drow", "elven-lineage-high-elf", "gnomish-lineage-forest", "improved-brutal-strike-2",
  // A subclass's Bonus Proficiencies (Order and Twilight Domains, Rune Knight, College of Lore, the sidekicks): its
  // subclass's or class's trait steps give them.
  "bonus-proficiencies",
  // A Rune Knight's Rune Carver: its runes are its subclass's "Runes Known" choices, each rune's Items one option.
  "rune-carver",
  // A Draconic Spirit's Shared Resistances: Summon Dragon's choice as it is cast (SUMMON_RULES).
  "shared-resistances"]);
/**
 * Features whose rule nothing in play exercises, so their text is their rule (an informational note, not a gap): what a
 * creature can't carry (Ephemeral), thoughts no one reads (Shielded Mind, Inscrutable: an Insight check is the GM's call
 * on a self-targeted Search, with no creature to read a rule from), rock it tunnels through (Tunneler), an object's own
 * stat block (Magic Rope, Soul Bag), a revival a day later (Undead Restoration), an object a fiend keeps its soul in (Soul
 * Tome, Soul Gem), a warding of a place against travel (Forbiddance). Two feats lift penalties WildPath doesn't impose:
 * Crossbow Expert (Loading, firing with an enemy beside it, the Light attack's modifier) and Mounted Combatant (there
 * are no mounts). Move them out when those rules come.
 */
const NARRATIVE_FEATURES = new Set(["ephemeral", "shielded-mind", "inscrutable", "tunneler", "magic-rope", "soul-bag",
  "undead-restoration", "soul-tome", "soul-gem", "forbiddance", "crossbow-expert", "mounted-combatant"]);

// Hunter's Mark's die, dnd5e's @scale.ranger.mark: a d10 from ranger level 20 (Foe Slayer), read from its caster; a d6 for
// anyone else (a table's default when its key can't be read). Superior Hunter's Prey deals the same.
const HUNTERS_MARK_DIE = {type: "table", key: {type: "class-level", class: "ranger"},
  rows: {1: {type: "dice", number: 1, faces: 6}, 20: {type: "dice", number: 1, faces: 10}}, default: {type: "dice", number: 1, faces: 6}};

/**
 * Inspiring Help (an Expert sidekick, 2014): its own Help puts one effect on another creature it helps, not on an enemy
 * (`notHostile`, `notSelf`), with a die for the roll that Help covers. The creature adds it after that roll fails
 * (`addDie`, offered on that kind of roll only), or on an attack it hits without it, deals it as damage (an ExtraDamage
 * rider). Adding it to the roll spends the effect and drops its damage (withoutSpentEffect); the attack or check ends it
 * either way. Its dice (1d6, 2d6 from expert level 20) are the sidekick's, worked out from the effect's giver
 * (`fromSource`). Help: Advantage, the die and the damage on the creature's next attack only against a target an ally of
 * it stands beside (`attack.allyNearTarget`, on all three). Assist: Advantage and the die on its next check.
 * shortcut: any ally beside the target counts, not only the sidekick; upgrade when a predicate can name the effect's giver.
 */
const INSPIRING_DICE = Object.freeze({type: "table", key: {type: "class-level", class: "expert"}, rows: {1: 1, 20: 2}, default: 1});
const ALLY_NEAR_TARGET = Object.freeze({equals: {path: "attack.allyNearTarget", value: true}});
const inspiringHelp = (name, test, endsWhen, rules, predicate=null) => ({name, costs: [{capability: "action", amount: 1}],
  range: {type: "ranged", normal: {value: 30, unit: "ft"}}, targeting: {type: "single", required: true, count: 1, notHostile: true, notSelf: true},
  effects: [{id: "effect-1", type: "effect", name: "Inspiring Help", img: "icons/svg/upgrade.svg",
    duration: {value: 1, units: "rounds", expiry: "sourceTurnStart"}, endsWhen,
    metadata: {addDie: {faces: 6, number: structuredClone(INSPIRING_DICE), tests: [test], ...(predicate ? {predicate: structuredClone(predicate)} : {})}},
    ruleElements: rules}]});

/**
 * Features dnd5e gives no usable activity that are used on their creature's turn, as an Action of their own (2024 Action
 * Surge: "you can take one additional action", no Action itself: one more Action this turn).
 */
const FEATURE_ACTIONS = Object.freeze({
  "inspiring-help": [inspiringHelp("Help", "attack", "attacks", [{schemaVersion: 1, id: "inspiring-help-attack", type: "RollMode",
    predicate: structuredClone(ALLY_NEAR_TARGET), data: {domains: ["attack"], mode: "advantage"}},
  {schemaVersion: 1, id: "inspiring-help-damage", type: "ExtraDamage", predicate: structuredClone(ALLY_NEAR_TARGET),
    data: {domains: ["damage.melee", "damage.ranged"], expression: {type: "dice", number: structuredClone(INSPIRING_DICE), faces: 6},
      metadata: {fromSource: true}}}], ALLY_NEAR_TARGET),
  inspiringHelp("Assist", "check", "checks", [{schemaVersion: 1, id: "inspiring-help-check", type: "RollMode",
    data: {domains: ["check"], mode: "advantage"}}])],
  "action-surge": {effects: [{id: "effect-1", type: "effect", name: "Action Surge", duration: {value: 0, units: "turns", expiry: "turnEnd"},
    ruleElements: [{schemaVersion: 1, id: "action-surge", type: "Modifier", data: {domains: ["resources.action.max"], modifierType: "untyped", value: 1}}]}]},
  // Slasher: once a turn its Slashing damage on a hit takes 10 feet off the creature's Speed until the start of its next
  // turn; on a Critical Hit, the creature has Disadvantage on attack rolls until then too. Free, always.
  slasher: [{name: "Hamstring", free: true, policy: "always", range: {type: "special"}, targeting: {type: "single", required: true, count: 1},
    trigger: {kind: "reaction", event: "damage.applied", match: {phase: "before", sourceTokenId: "{self}", tagsAll: ["hit", "damage:slashing"]},
      once: "turn", onceKey: "slasher-hamstring"},
    effects: [{id: "effect-1", type: "effect", name: "Hamstrung", img: "icons/svg/net.svg", duration: {value: 1, units: "rounds", expiry: "sourceTurnStart"},
      ruleElements: [{schemaVersion: 1, id: "slasher-hamstring", type: "Modifier", data: {domains: ["resources.movement.max", "speed"], modifierType: "untyped",
        value: -10}}]}]},
  {name: "Enhanced Critical", free: true, policy: "always", range: {type: "special"}, targeting: {type: "single", required: true, count: 1},
    trigger: {kind: "reaction", event: "damage.applied", match: {phase: "before", sourceTokenId: "{self}",
      tagsAll: ["hit", "critical", "damage:slashing"]}},
    effects: [{id: "effect-1", type: "effect", name: "Slashed", img: "icons/svg/downgrade.svg", duration: {value: 1, units: "rounds", expiry: "sourceTurnStart"},
      ruleElements: [{schemaVersion: 1, id: "slasher-critical", type: "RollMode", data: {domains: ["attack"], mode: "disadvantage"}}]}]}],
  // Sentinel's Halt: a creature its Opportunity Attack hits has a Speed of 0 for the rest of the turn (free, always).
  sentinel: {free: true, policy: "always", range: {type: "special"}, targeting: {type: "single", required: true, count: 1},
    trigger: {kind: "reaction", event: "attack.hit", match: {phase: "interrupt", sourceTokenId: "{self}", tagsAll: ["opportunity"]}},
    effects: [{id: "effect-1", type: "effect", name: "Halted", img: "icons/svg/net.svg", duration: {value: 0, units: "turns", expiry: "turnEnd"},
      ruleElements: [{schemaVersion: 1, id: "halted", type: "ResourceCap", data: {resources: ["movement"], maximum: 0}}]}]},
  // 2024 Heightened Focus (monk 10): Step of the Wind with a Focus Point can take a willing Large-or-smaller creature within
  // 5 feet along; it moves with the monk until the end of the monk's turn, spending none of its own movement and provoking
  // no Opportunity Attacks. The monk is Disengaged and Dashing as usual; the creature is Carried, which the active GM's carry
  // adapter follows (foundry-v14-carry.mts). `turnEnd`, as its Disengaged and Dashing: the end of the turn it is used in.
  // Willing: never a creature hostile to the monk (`targeting.notHostile`). shortcut: an ally's owner isn't asked; upgrade
  // with a consent prompt if an unwilling ally matters.
  // shortcut: out of combat, Carried does not expire; the GM removes it.
  "heightened-focus": {name: "Step of the Wind", costs: [{capability: "bonus-action", amount: 1}, {capability: "monk-s-focus", amount: 1}],
    range: {type: "touch", distance: {value: 5, unit: "ft"}}, targeting: {type: "single", required: true, count: 1, notHostile: true},
    effects: [...commonRules("disengage").effects, ...commonRules("dash").effects].map(effect => ({...effect, appliesTo: "source"}))
      .concat({id: "carried", type: "effect", name: "Carried", slug: "carried", img: "icons/svg/wingfoot.svg", maxSize: "large",
        duration: {value: 0, units: "turns", expiry: "turnEnd"}, ruleElements: []})},
  // 2024 Hunter's Superior Hunter's Prey: once a turn, after its damage lands on a creature carrying its own Hunter's Mark
  // (the after-damage window: nothing is offered when no damage was dealt), the mark's die goes to another creature within
  // 30 feet of that one, its controller's pick (`retarget`). Free; asked, so it can be declined when only an ally is near.
  // shortcut: "that you can see" isn't checked for that creature, only the first creature an Action damages is checked for
  // the mark, and once a turn is checked per Action (an own reaction damaging the marked creature inside the same Action
  // can offer it twice); upgrade by filtering redirectCandidates by attackSight and reading every damaged target.
  // shortcut: reaction children carry no concentration input, so a concentrating creature it damages makes no check;
  // upgrade by giving reactionChildState the runtime's concentration states.
  "superior-hunters-prey": {free: true, range: {type: "special"}, targeting: {type: "single", required: true, count: 1},
    damage: [{id: "damage-1", expression: HUNTERS_MARK_DIE, damageType: "force"}], retarget: {range: 30},
    trigger: {kind: "reaction", event: "damage.applied", match: {phase: "interrupt", sourceTokenId: "{self}"},
      once: "turn", onceKey: "superior-hunters-prey", triggerPredicate: {equals: {path: "targetFrom.{self}.hunters-mark", value: true}}}},
  // 2024 Improved Blessed Strikes, its Potent Spellcasting option (`whileFeature`: only a cleric who took that option): after
  // its cantrip damages a creature, Temporary Hit Points of twice its Wisdom modifier to itself or any creature within 60
  // feet of it, its controller's pick as it is used (`targetChoice`). Free; asked. shortcut: any cantrip, not only a cleric
  // one (spells carry no class), as Potent Spellcasting's damage.
  "improved-blessed-strikes": {free: true, range: {type: "special"}, targeting: {type: "single", required: true, count: 1},
    targetChoice: {from: "creatures", range: 60, includeSelf: true},
    healing: [{id: "potent-spellcasting", healingType: "temporary", expression: {type: "multiply",
      terms: [{type: "constant", value: 2}, {type: "ability-modifier", ability: "wits"}]}}],
    trigger: {kind: "reaction", event: "damage.applied", match: {phase: "interrupt", sourceTokenId: "{self}", tagsAll: ["cantrip"]},
      whileFeature: "blessed-strikes-potent-spellcasting"}},
  // 2024 Boon of Dimensional Travel (Blink Steps): "Immediately after you take the Attack action or the Magic action, you can
  // teleport up to 30 feet": once a turn, after an attack roll or a spell cast with the Action this turn. shortcut:
  // "immediately" is not enforced (later in the same turn works too).
  "boon-of-dimensional-travel": {costs: [{capability: "boon-of-dimensional-travel", amount: 1}], teleport: {distance: 30},
    pool: {schemaVersion: 1, id: "boon-of-dimensional-travel-uses", type: "GrantResource", data: {resourceId: "boon-of-dimensional-travel",
      label: "Blink Steps", maximum: 1, recovery: "turn"}},
    requires: {any: [{equals: {path: "attackedThisTurn", value: true}}, {equals: {path: "magicActionThisTurn", value: true}}]}},
  // 2024 Archdruid, Nature Magician (no action, once per Long Rest: its pool): "convert uses of Wild Shape into a single spell
  // slot ... each use contributing 2 spell levels". At most 4 uses (level 8). shortcut: a slot level that is full is refused
  // (as Font of Magic's).
  "archdruid": {free: true, configuration: [{id: "slot-level", type: "select-one", label: "Spell slot", required: true,
    options: [1, 2, 3, 4].map(uses => ({id: `level-${2 * uses}`, label: `Level ${2 * uses} (${uses} Wild Shape)`, value: 2 * uses,
      effects: [{type: "add-cost", cost: {allOf: [{capability: "wild-shape", amount: uses}]}},
        {type: "restore", resourceId: `spell-slot.${2 * uses}`, amount: 1}]}))}],
    costs: [{capability: "archdruid", amount: 1}]},
  // 2024 Reckless Attack (free): "when you make your first attack roll on your turn", Advantage on its Strength attack rolls
  // this turn, and attack rolls against it have Advantage until its next turn; its "reckless" status gates Brutal Strike.
  "reckless-attack": {free: true, requires: {not: {equals: {path: "attackedThisTurn", value: true}}}, effects: [{id: "effect-1", type: "effect", name: "Reckless", slug: "reckless",
    duration: {value: 1, units: "rounds", expiry: "turnStart"}, ruleElements: [
      {schemaVersion: 1, id: "reckless-attacks", type: "RollMode", data: {domains: ["attack.might"], mode: "advantage"}},
      {schemaVersion: 1, id: "reckless-attacked", type: "RollMode", data: {domains: ["attacked"], mode: "advantage"}}]}]},
  // 2024 Tactical Shift: activating Second Wind lets the fighter move up to half its Speed without provoking Opportunity
  // Attacks this turn (Withdraw's effect), answering its own Second Wind. shortcut: Second Wind paid with an Action under
  // the Action-for-Bonus-Action rule counts too.
  "tactical-shift": {free: true, policy: "always", trigger: ownDeclared("action:srd-second-wind"),
    effects: [{...WITHDRAW, name: "Tactical Shift"}]},
  // 2024 Instinctive Pounce: "As part of the Bonus Action you take to enter your Rage, you can move up to half your Speed"
  // (Withdraw's movement, without Disengage), answering its own Rage.
  "instinctive-pounce": {free: true, policy: "always", trigger: ownDeclared("action:srd-rage-expend-rage"),
    effects: [{...Object.fromEntries(Object.entries(WITHDRAW).filter(([key]) => key !== "slug")), name: "Instinctive Pounce"}]},
  // 2024 Studied Attacks: a missed attack roll marks its target (`studied`, from this fighter); the fighter's next attack
  // roll against it before the end of its next turn has Advantage and spends the mark (Vex's rule, on a miss).
  "studied-attacks": {free: true, policy: "always", range: {type: "special"}, targeting: {type: "single", required: true, count: 1},
    trigger: {kind: "reaction", event: "attack.miss", match: {phase: "interrupt", sourceTokenId: "{self}"}},
    effects: [{id: "effect-1", type: "effect", name: "Studied", slug: "studied", img: "icons/svg/target.svg",
      duration: {value: 1, units: "rounds", expiry: "turnEnd"}, endsWhen: "attackedBySource",
      ruleElements: [{schemaVersion: 1, id: "studied", type: "RollMode", predicate: {equals: {path: "attack.fromAttacker.studied", value: true}},
        data: {domains: ["attacked"], mode: "advantage"}}]}]},
  // Eldritch Strike: a creature its weapon attack hits is marked (`eldritch-struck`, from this knight) until the end of the
  // knight's next turn; its next save against one of the knight's spells has Disadvantage, and any save the knight forces
  // spends the mark (`savedBySource`). shortcut: a save the knight forces that is not a spell's (a Topple) spends it too,
  // without the Disadvantage; upgrade when `endsWhen` can filter on tags.
  "eldritch-strike": {free: true, policy: "always", range: {type: "special"}, targeting: {type: "single", required: true, count: 1},
    trigger: {kind: "reaction", event: "attack.hit", match: {phase: "interrupt", sourceTokenId: "{self}", tagsAll: ["weapon"]}},
    effects: [{id: "effect-1", type: "effect", name: "Eldritch Strike", slug: "eldritch-struck", img: "icons/svg/daze.svg",
      duration: {value: 1, units: "rounds", expiry: "turnEnd"}, endsWhen: "savedBySource",
      ruleElements: [{schemaVersion: 1, id: "eldritch-struck", type: "RollMode", predicate: {all: [{tagsAny: ["spell"]},
        {equals: {path: "save.fromSource.eldritch-struck", value: true}}]}, data: {domains: ["save"], mode: "disadvantage"}}]}]},
  // Fanatical Focus: its once-per-Rage reroll (TEST_OFFERS) is refilled whenever its barbarian enters a Rage with the Rage
  // Action. shortcut: a Rage begun another way (an effect giving `raging`) refills nothing.
  "fanatical-focus": {name: "Rage", free: true, policy: "always", trigger: ownDeclared("action:srd-rage-expend-rage"),
    restores: [{resourceId: "fanatical-focus", amount: 1}], pool: {schemaVersion: 1, id: "fanatical-focus-uses", type: "GrantResource",
      data: {resourceId: "fanatical-focus", label: "Fanatical Focus", maximum: 1, recovery: "none"}}},
  // 2024 Contact Patron: once per Long Rest, Contact Other Plane with no slot to contact its patron, its save an automatic
  // success (so no damage): an Action with no save. What the patron answers is the GM's.
  "contact-patron": {costs: [{capability: "contact-patron", amount: 1}], pool: {schemaVersion: 1, id: "contact-patron-uses",
    type: "GrantResource", data: {resourceId: "contact-patron", label: "Contact Patron", maximum: 1, recovery: "longRest"}}},
  // Deck of Many Things cards (2024 DMG), drawn: Euryale's curse ("a -2 penalty to saving throws while cursed in this way",
  // ended only by a god or the Fates card: no duration, not a curse Remove Curse ends); the Fool's Disadvantage and the
  // Jester's Advantage on D20 Tests for 72 hours (the Fool's further draw and the Jester's two more cards are the table's);
  // the Sun's 10 Temporary Hit Points daily at dawn (its magic item is the GM's).
  // Each spends its card's one use (dnd5e's pool), so it is drawn once.
  euryale: {effects: [{id: "effect-1", type: "effect", name: "Euryale's Curse", img: "icons/svg/skull.svg", ruleElements: [
    {schemaVersion: 1, id: "euryale-curse", type: "Modifier", data: {domains: ["save"], modifierType: "untyped", value: -2}}]}]},
  fool: {effects: [{id: "effect-1", type: "effect", name: "Fool", img: "icons/svg/downgrade.svg",
    duration: {value: 72, units: "hours"}, ruleElements: [{schemaVersion: 1, id: "fool", type: "RollMode",
      data: {domains: ["attack", "check", "save"], mode: "disadvantage"}}]}]},
  jester: {name: "Advantage", effects: [{id: "effect-1", type: "effect", name: "Jester", img: "icons/svg/upgrade.svg",
    duration: {value: 72, units: "hours"}, ruleElements: [{schemaVersion: 1, id: "jester", type: "RollMode",
      data: {domains: ["attack", "check", "save"], mode: "advantage"}}]}]},
  sun: {effects: [{id: "effect-1", type: "effect", name: "Sun", img: "icons/svg/sun.svg", ruleElements: [{schemaVersion: 1,
    id: "sun-dawn", type: "Trigger", data: {kind: "automation", event: "rest.completed", predicate: {equals: {path: "event.data.restType",
      value: "longRest"}}, action: {schemaVersion: 1, id: "action:srd-sun-dawn", label: "Sun", costs: {allOf: []}, range: {type: "self"},
      targeting: {type: "self"}, healing: [{id: "healing-1", healingType: "temporary", expression: {type: "constant", value: 10}}]}}}]}]},
  // 2024 Water Elemental's Freeze: "If the elemental takes Cold damage, its Speed decreases by 20 feet until the end of its
  // next turn" (free, always).
  freeze: {free: true, policy: "always", trigger: {kind: "reaction", event: "damage.applied", match: {phase: "before", targetTokenId: "{self}",
    tagsAll: ["damage:cold"]}},
  effects: [{id: "effect-1", type: "effect", name: "Frozen", img: "icons/svg/frozen.svg", duration: {value: 1, units: "rounds", expiry: "turnEnd"},
    ruleElements: [{schemaVersion: 1, id: "freeze", type: "Modifier", data: {domains: ["resources.movement.max", "speed"], modifierType: "untyped",
      value: -20}}]}]},
  // 2024 Nightmare: "can grant Resistance to Fire damage to a rider while it is on the nightmare". shortcut: there are no
  // mounts, so it lasts until removed and any creature it touches may have it.
  "confer-fire-resistance": {free: true, range: {type: "touch", distance: {value: 5, unit: "ft"}},
    targeting: {type: "single", required: true, count: 1}, effects: [{id: "effect-1", type: "effect", name: "Fire Resistance",
      img: "icons/svg/fire-shield.svg", ruleElements: [{schemaVersion: 1, id: "confer-fire-resistance", type: "GrantResistance",
        data: {damageTypes: ["fire"]}}]}]},
});

/** A reaction to its own Action of `definitionId` as it is declared (Brutal Strike's shape): its user, before it resolves. */
function ownDeclared(definitionId) {
  return {kind: "reaction", event: "action.declared", match: {phase: "interrupt", sourceTokenId: "{self}"},
    triggerPredicate: {equals: {path: "event.data.actionDefinitionId", value: definitionId}}};
}

/**
 * Light sources (2024 PHB), by identifier: Bright Light out to `bright` feet and Dim Light out to `dim` (a Torch's 20 and
 * 20 more: 40), for `hours`. Lighting one puts its light on its user (`GrantLight`) for that long; its Token sheds it.
 * dnd5e gives a Torch no Light activity (only its attack), so its lighting is an Action of its own, a Bonus Action
 * with a Tinderbox (2024), as a Candle's is. shortcut: a Hooded Lantern's lowered hood (Dim Light 5 feet) is by hand.
 */
const LIGHT_SOURCES = Object.freeze({
  torch: {bright: 20, dim: 40, hours: 1}, candle: {bright: 5, dim: 10, hours: 1}, lamp: {bright: 15, dim: 45, hours: 6},
  "lantern-hooded": {bright: 30, dim: 60, hours: 6}, "lantern-bullseye": {bright: 60, dim: 120, angle: 60, hours: 6}
});

/** Lighting a light source (LIGHT_SOURCES): its user sheds its light for its hours. */
function lightDefinition(definition, light, document, img) {
  return {...definition, range: {type: "self"}, targeting: {type: "self"}, effects: [{id: "effect-1", type: "effect",
    name: `${document.name} (lit)`, img, duration: {value: light.hours, units: "hours"}, ruleElements: [{schemaVersion: 1, id: "light",
      type: "GrantLight", data: {bright: light.bright, dim: light.dim, ...(light.angle ? {angle: light.angle} : {})}}]}]};
}

/**
 * A use whose text says what it lights "sheds Bright Light in a 10-foot radius and Dim Light for an additional 10 feet"
 * (Flame Blade, Produce Flame, a Gem of Brightness, a Lantern of Revealing, a Magmin): its user sheds that light
 * (`GrantLight`), for its spell's duration and concentration, else as long as its text says it "burns" ("for 6 hours"),
 * else until removed. Not "emits" (an Energy Bow's arrow: the light of what it makes). Null for anything else.
 * shortcut: putting it out early (a second command word, extinguishing a Magmin) is removing its effect.
 */
const SHEDS_LIGHT_TEXT = /\b(?:sheds|shedding) Bright Light in an? (\d+)-foot radius and Dim Light for an additional (\d+) feet/iu;
function shedsLightDefinition({document, activity, system, spell, level, pool, names, scales, img}) {
  const light = (activity.type === "utility") ? SHEDS_LIGHT_TEXT.exec(plainText(document)) : null;
  if ( !light ) return null;
  const burns = /\bburns for (\d+) (hour|minute)s?\b/iu.exec(plainText(document));
  const duration = spell ? lastingDuration(system.duration) : (burns ? {value: Number(burns[1]), units: `${burns[2].toLowerCase()}s`} : null);
  const concentration = Boolean(spell) && (system.properties ?? []).includes("concentration");
  // "Invisible creatures and objects are visible as long as they are in the lantern's Bright Light" (a Lantern of
  // Revealing): its user sees the Invisible that far. shortcut: only its user, where its text reveals them to everyone in
  // that light; upgrade with a light that reveals.
  const reveals = /\bInvisible\b[^.]*\bvisible\b[^.]*\bBright Light\b/iu.test(plainText(document));
  return {...manualDefinition({document, activity, system, spell, level, notes: [], pool, names, scales}), range: {type: "self"},
    targeting: {type: "self"}, effects: [{id: "effect-1", type: "effect", name: document.name, ...(img ? {img} : {}),
      ...(duration ? {duration} : {}), ...(concentration ? {concentration: true} : {}), ruleElements: [{schemaVersion: 1, id: "light",
        type: "GrantLight", data: {bright: Number(light[1]), dim: Number(light[1]) + Number(light[2])}},
      ...(reveals ? [{schemaVersion: 1, id: "reveals", type: "GrantSense", data: {sense: "seeInvisibility", range: Number(light[1])}}] : [])]}]};
}

/**
 * A use that "teleports from the Material Plane to the Ethereal Plane" (a Phase Spider's Ethereal Jaunt; a Nightmare's
 * Ethereal Stride, "and up to three willing creatures within 5 feet of it"): the Ethereal condition on its user, and on
 * the creatures it takes. Null for anything else.
 * shortcut: "or vice versa" (back to the Material Plane) is removing the condition.
 */
function etherealDefinition({document, activity, system, spell, level, pool, names, scales}) {
  if ( (activity.type !== "utility") || !/\bteleports? (?:from the Material Plane )?to the Ethereal Plane\b/iu.test(plainText(document)) ) return null;
  const ethereal = {type: "condition", conditionId: "ethereal"};
  const {targeting} = targetingOf({activity, system, notes: [], level, scales});
  const range = rangeOf({activity, system, document, attack: null});
  // "up to three": none at all too (it may go alone).
  const {refinementPolicy: _least, ...open} = targeting ?? {};
  const others = ["single", "multiple"].includes(targeting?.type) ? {targeting: {...open, required: false}, ...(range ? {range} : {})} : null;
  return {...manualDefinition({document, activity, system, spell, level, notes: [], pool, names, scales}),
    ...(others ?? {range: {type: "self"}, targeting: {type: "self"}}),
    effects: others ? [{id: "effect-1", ...ethereal}, {id: "effect-2", ...ethereal, appliesTo: "source"}] : [{id: "effect-1", ...ethereal}]};
}

/**
 * A shape-shift whose other form loses a Speed ("its Fly Speed is available only in its true form": a Succubus): in that
 * form (an effect on its user), that Speed's factor is 0 (`speed.<mode>.multiplier`). Null for anything else.
 * shortcut: returning to its true form is removing the effect; how it looks is the table's.
 */
function otherFormDefinition({document, activity, system, spell, level, pool, names, scales, img}) {
  const lost = (activity.type === "utility") ? /\bits (\w+) Speed is available only in its true form\b/iu.exec(plainText(document)) : null;
  if ( !lost ) return null;
  const mode = lost[1].toLowerCase();
  return {...manualDefinition({document, activity, system, spell, level, notes: [], pool, names, scales}), range: {type: "self"},
    targeting: {type: "self"}, effects: [{id: "effect-1", type: "effect", name: document.name, ...(img ? {img} : {}),
      ruleElements: [{schemaVersion: 1, id: `no-${mode}`, type: "Modifier", data: {domains: [`speed.${mode}.multiplier`], modifierType: "untyped",
        value: 0}}]}]};
}

/**
 * A swallow with no save ("swallows a Medium or smaller target it is grappling. While swallowed, the target ... has the
 * Blinded and Restrained conditions, and it has Total Cover": a Giant Toad's): those conditions on the creature it
 * touches, no larger than that, as a Purple Worm's save gives them (the dispatcher's swallowed creatures are those with
 * the Total Cover it gave). Null for anything else.
 * shortcut: its grapple ending, one creature at a time and its Bite barred meanwhile are by hand.
 */
function swallowDefinition({document, activity, system, spell, level, pool, names, scales}) {
  const text = plainText(document);
  const swallows = (activity.type === "utility") ? /\bswallows an? (\w+) or smaller (?:target|creature)\b[^.]*\bgrappl/iu.exec(text) : null;
  const maxSize = CREATURE_SIZES.find(size => size === swallows?.[1].toLowerCase());
  if ( !maxSize || !/\bBlinded\b/u.test(text) || !/\bRestrained\b/u.test(text) || !/\bTotal Cover\b/u.test(text) ) return null;
  return {...manualDefinition({document, activity, system, spell, level, notes: [], pool, names, scales}),
    range: {type: "touch", distance: {value: 5, unit: "ft"}}, targeting: {type: "single", required: true, count: 1},
    effects: ["coverTotal", "blinded", "restrained"].map((conditionId, index) => ({id: `effect-${index + 1}`, type: "condition", conditionId, maxSize}))};
}

/** Each dnd5e base armor's kind. */
const ARMOR_KINDS = Object.freeze({padded: "light", leather: "light", studded: "light", hide: "medium", chainshirt: "medium",
  scalemail: "medium", breastplate: "medium", halfplate: "medium", ringmail: "heavy", chainmail: "heavy", splint: "heavy",
  plate: "heavy", shield: "shield"});

/**
 * What an attack adds for itself (G7), as Modifiers of its own Action: a weapon's magic bonus (+1) to its attack and
 * damage rolls, and an attack's own bonus to its attack roll.
 */
function attackModifiers({activity, system, definition, notes}) {
  if ( !definition.attack ) return [];
  const rules = [];
  const modifier = (id, domains, value) => rules.push({schemaVersion: 1, id, type: "Modifier", data: {domains, modifierType: "untyped",
    ...(value.type === "constant" ? {value: value.value} : {valueExpression: value})}});
  const magic = number(system.magicalBonus);
  if ( magic ) {
    modifier("magic-attack", ["attack"], {type: "constant", value: magic});
    modifier("magic-damage", ["damage"], {type: "constant", value: magic});
  }
  const bonus = activity.attack?.bonus;
  const expression = bonus ? formulaExpression(String(bonus)) : null;
  if ( expression ) modifier("attack-bonus", ["attack"], expression);
  else if ( bonus ) notes.push(`attack: bonus "${bonus}" not converted`);
  return rules;
}

/** One die larger: a Versatile weapon's die when its own is not given (a Spear's d6 becomes a d8). */
const LARGER_DIE = Object.freeze({4: 6, 6: 8, 8: 10, 10: 12});

/** A Versatile weapon's two-handed attack: its definition with the larger die, or null. */
function versatileDefinition({document, system, definition}) {
  if ( (document.type !== "weapon") || !(system.properties ?? []).includes("ver") ) return null;
  const base = system.damage?.base ?? {};
  const component = definition.damage?.find(entry => entry.provenance === "weapon-base");
  const faces = number(system.damage?.versatile?.denomination) || LARGER_DIE[number(base.denomination)];
  if ( !component || !faces ) return null;
  const count = number(system.damage?.versatile?.number) || number(base.number) || 1;
  const bonus = base.bonus ? formulaExpression(String(base.bonus)) : null;
  const expression = bonus ? add([dice(count, faces), bonus]) : dice(count, faces);
  // Held with two hands (Great Weapon Fighting reads it).
  return {...definition, id: `${definition.id}-two-handed`, damage: definition.damage.map(entry => (entry === component
    ? {...entry, expression} : entry)), ...(definition.attack ? {attack: {...definition.attack,
    properties: [...new Set([...(definition.attack.properties ?? []), "two-handed"])]}} : {})};
}

/**
 * 2024 Thrown: a melee weapon with the property (a Dagger, a Handaxe) may be thrown at its range: a ranged attack of its
 * own, the same damage (Thrown Weapon Fighting's +2 reads it). Null for anything else.
 */
function thrownDefinition({document, system, definition}) {
  const normal = number(system.range?.value);
  if ( (document.type !== "weapon") || !(system.properties ?? []).includes("thr") || (definition.attack?.type !== "melee") || !(normal > 0) ) return null;
  const long = number(system.range?.long);
  return {...definition, id: `${definition.id}-thrown`, attack: {...definition.attack, type: "ranged"},
    range: {type: "ranged", normal: {value: normal, unit: "ft"}, ...(long ? {long: {value: long, unit: "ft"}} : {})}};
}

/**
 * A class's prepared spells at each level 1 to 20 (2024), from its `max-prepared` scale; empty when it has none.
 */
export function preparedTable(system) {
  const scale = Object.values(system?.advancement ?? {}).find(entry => (entry.type === "ScaleValue")
    && (entry.configuration?.identifier === "max-prepared"))?.configuration?.scale;
  if ( !scale ) return [];
  let value = 0;
  return Array.from({length: 20}, (_, index) => (value = Number(scale[index + 1]?.value ?? value) || value));
}

/**
 * The effects an Item gives its holder while it is had: its enabled transfer effects, but not one a summon applies to
 * the creature it summons (an Onyx Dog's "Mastiff Figurine" is the mastiff's Intellect, Common and Blindsight).
 */
function passiveEffects(document, {riders=false}={}) {
  const activities = Object.values(document.system?.activities ?? {}).filter(activity => activity?.type);
  const summoned = new Set(activities.filter(activity => activity.type === "summon")
    .flatMap(activity => (activity.effects ?? []).map(effect => effect._id)));
  // An enchantment's riders (Armor of Resistance's ten Resistances) come with the enchantment its Action applies, not
  // all at once on the gear. One with no rules of its own stays the gear's (Demon Armor's Abyssal); `riders` keeps them
  // all (their training).
  const ridden = riders ? new Set() : new Set(activities.filter(activity => (activity.type === "enchant")
    && (ACTIVATION_COST[activity.activation?.type] || templateEnchant(document, activities)))
    .flatMap(activity => (activity.effects ?? []).flatMap(ref => ref.riders?.effect ?? [])));
  return (document.effects ?? []).filter(effect => effect.transfer && !effect.disabled && !summoned.has(effect._id)
    && !(ridden.has(effect._id) && effectRules(effect, []).length));
}

/**
 * A magic item that is only a template (Armor, Weapon or Wand of the War Mage +1/+2/+3, Vorpal Sword, Armor of
 * Vulnerability, Dragon Scale Mail): its one activity enchants an Item, whatever activation dnd5e left it.
 */
const templateEnchant = (document, activities) => ["equipment", "weapon"].includes(document.type) && (activities.length === 1)
  && (activities[0].type === "enchant");

/**
 * What an Item's passive effects, left empty in dnd5e, name in its text: "Advantage on Dexterity (Stealth) checks" (Boots
 * and Cloak of Elvenkind) is that skill's roll mode. Read only when every passive effect has no changes and no statuses; a
 * sentence of Advantage or Disadvantage it can't read is noted (the Cloak's "Perception checks made to see you").
 */
/**
 * "Advantage on saving throws (you make) to avoid or end the Poisoned condition" (2024 Dwarven Resilience, Brave, Fey
 * Ancestry, a Periapt of Proof against Poison, Antitoxin): a RollMode on saves against it (the runtime tags a save
 * `against:<condition>` by what a failure gives, or what a repeated save ends). Not when the text says "not".
 */
function savesAgainstRules(text, base) {
  // A condition may be a dnd5e reference ("the &Reference[Frightened] condition").
  const plain = String(text ?? "").replace(/&(?:amp;)?Reference\[(\w+)[^\]]*\]/gu, "$1");
  return [...plain.matchAll(SAVES_AGAINST)].map(match => CONDITION_MAP[match[1].toLowerCase()]).filter(Boolean)
    .map(condition => ({schemaVersion: 1, id: `${base || "rule"}-against-${condition}`, type: "RollMode",
      predicate: {tagsAny: [`against:${condition}`]}, data: {domains: ["save"], mode: "advantage"}}));
}
// "you make", "it makes", "they make" or "made" (a creature's trait reads in the third person: Poison Tolerant).
const SAVES_AGAINST = /(?<!\bnot )\bAdvantage on saving throws(?: (?:you|it|they) makes?| made)? to avoid or end the (\w+) condition/giu;

/**
 * A creature's own trait that says it "can't regain Hit Points" caps its healing at 0, and "or gain Temporary Hit Points"
 * those too (2024 swarms). Not a sentence about a target or a state ("While Poisoned, the target can't regain Hit
 * Points" belongs to the effect that poisons).
 */
function bearerHealingRules(text, base) {
  const sentences = String(text ?? "").split(/(?<=\.)\s+/u).map(sentence => sentence.trim())
    .filter(sentence => /\bcan[’']t regain Hit Points\b/u.test(sentence) && !/\btarget\b/iu.test(sentence) && !/^(?:While|Until)\b/u.test(sentence));
  if ( !sentences.length ) return [];
  const temporary = sentences.some(sentence => /\bgain Temporary Hit Points\b/u.test(sentence));
  return [{schemaVersion: 1, id: `${base || "rule"}-no-healing`, type: "ResourceCap",
    data: {resources: ["healing", ...(temporary ? ["temporaryHealth"] : [])], maximum: 0}}];
}

/**
 * A creature's own trait about other creatures' spaces (foundry-v14-occupancy): a swarm "can occupy another creature's
 * space and vice versa" (`occupancy.share`); Incorporeal Movement "can move through other creatures and objects as if they
 * were Difficult Terrain" (`occupancy.pass`, `occupancy.difficult`).
 */
function occupancyRules(text, base) {
  const plain = String(text ?? "");
  const domains = [...(/\bcan occupy another creature[’']s space\b/u.test(plain) ? ["occupancy.share"] : []),
    ...(/\bcan move through other creatures\b/u.test(plain) ? ["occupancy.pass", "occupancy.difficult"] : [])];
  return domains.map(domain => ({schemaVersion: 1, id: `${base || "rule"}-${domain.replaceAll(".", "-")}`, type: "Modifier",
    data: {domains: [domain], modifierType: "untyped", value: 1}}));
}

/**
 * The conditions a stat block's text says a target can't regain Hit Points while it has ("While Poisoned, the target
 * can't regain Hit Points", "Until this poison ends, ...", "While cursed, ...").
 */
export function healingBlockedWhile(text) {
  const plain = String(text ?? "").replace(/&(?:amp;)?Reference\[(\w+)[^\]]*\]/gu, "$1");
  return [...new Set([...plain.matchAll(/\b(?:While (\w+)|Until this (\w+) ends),? the target can[’']t regain Hit Points/giu)]
    .map(match => CONDITION_MAP[(match[1] ?? (match[2] === "poison" ? "poisoned" : match[2])).toLowerCase()]).filter(Boolean))];
}

/**
 * What an effect's words say it does that its changes may not (Stony Lethargy: "the target can't make Opportunity
 * Attacks, and its Speed is halved"; 2014: "can't use reactions"): the engine's `no-opportunity-attacks` slug, a 0.5
 * `speed.multiplier` and no Reaction. Read from the effect's own description, else from its item's failed save
 * ("Failure: ...", "On a failed save, ..."). A rule of a kind `given` already holds (its own changes', or an earlier
 * effect's of the same Action: the Beholder's Slowing Ray and its copy) is left out, so Speed is not halved twice.
 * "Disadvantage on attack rolls against creatures other than you" (Compelled Duel, Goading Attack, Thunder Gauntlets),
 * where "you" is the effect's source: the effect's own slug, and a RollMode on its creature's attacks unless
 * `attack.fromTarget` holds that slug (the target is where the effect came from), lasting to the start or end of its
 * source's next turn when that sentence says so.
 * shortcut: any Speed Modifier given stands for "Speed is halved"; upgrade if one ever adds rather than halves.
 * shortcut: two copies from different sources share the slug, so attacking either source lifts both (as Grappled's);
 * upgrade with one effect per source (questions-for-owner Q19).
 */
function effectTextRules(document, effect, given=[]) {
  const own = String(effect?.description ?? "").replace(/<[^>]+>/gu, " ");
  // The 2024 books link their rules ("can't take &Reference[Reaction]{Reactions}").
  const words = (own.trim() ? own : (/\b(?:Failure:|On a failed save\b)(.*?)(?:\bSuccess:|$)/su.exec(plainText(document))?.[1] ?? ""))
    .replace(/&(?:amp;)?Reference\[(\w+)[^\]]*\](?:\{[^}]*\})?/gu, "$1");
  const sentences = words.split(/(?<=\.)\s+/u);
  // "While Poisoned, the creature ... can't take Reactions" (a Dretch's Fetid Cloud): only while it has that condition,
  // so a creature immune to it, or cured of it, keeps its Reactions.
  const rule = (pattern, made) => {
    const sentence = sentences.find(part => pattern.test(part));
    const conditionId = sentence ? CONDITION_MAP[/^\s*While (\w+),/u.exec(sentence)?.[1]?.toLowerCase()] : null;
    return sentence ? [{schemaVersion: 1, ...made, ...(conditionId ? {predicate: {hasCondition: conditionId}} : {})}] : [];
  };
  const kinds = entry => (entry.data?.domains ?? entry.data?.resources ?? []).map(key => `${entry.type}:${String(key).split(".")[0]}`);
  const held = new Set(given.flatMap(kinds));
  // "has Disadvantage on ability checks and attack rolls for the duration" (2024 Phantasmal Killer): those rolls.
  const hindered = [...(sentences.map(part => DISADVANTAGE_ON.exec(part)?.[1]).find(Boolean) ?? "").matchAll(/ability checks|attack rolls|saving throws/giu)]
    .map(([kind]) => ({"ability checks": "check", "attack rolls": "attack", "saving throws": "save"})[kind.toLowerCase()]);
  const others = sentences.find(part => OTHERS_THAN_SOURCE.test(part));
  const slug = /\bcan(?:not|[’']t) make Opportunity ?Attacks\b/iu.test(words) ? "no-opportunity-attacks"
    : (others ? (slugify(effect?.name) || null) : null);
  const read = [...rule(/\bSpeed is halved\b/iu, {id: "speed-halved", type: "Modifier", data: {domains: ["speed.multiplier"], modifierType: "untyped", value: 0.5}}),
    ...rule(/\bcan(?:not|[’']t) (?:use|take) (?:a )?reactions?\b/iu, {id: "no-reaction", type: "ResourceCap",
      data: {resources: ["reaction"], maximum: 0}}),
    ...(hindered.length ? rule(DISADVANTAGE_ON, {id: "disadvantage", type: "RollMode", data: {domains: hindered, mode: "disadvantage"}}) : []),
    ...((others && slug) ? [{schemaVersion: 1, id: "others-disadvantage", type: "RollMode", data: {domains: ["attack"], mode: "disadvantage"},
      predicate: {not: {equals: {path: `attack.fromTarget.${slug}`, value: true}}}}] : [])];
  const ruleElements = read.filter(made => !kinds(made).some(kind => held.has(kind)));
  const until = others ? /\buntil the (start|end) of your next turn\b/iu.exec(others)?.[1]?.toLowerCase() : null;
  // `repeats`: some of what it says is already given. `unread`: its sentences but one that is only a plain Disadvantage.
  const unread = sentences.filter(part => part.trim() && !(hindered.length && PLAIN_DISADVANTAGE.test(part)));
  return {slug, ruleElements, unread, repeats: ruleElements.length < read.length,
    ...(until ? {duration: {value: 1, units: "rounds", expiry: (until === "end") ? "sourceTurnEnd" : "sourceTurnStart"}} : {})};
}
// The sentence of an effect that hinders its creature's attacks on anyone but its source (effectTextRules). Not one that
// spares others too ("other than you or another Barbarian": Power of the Wilds' Lion), which one slug cannot say.
const OTHERS_THAN_SOURCE = /\bdisadvantage on attack rolls against (?:targets|creatures) other than you\b(?! or\b)/iu;
// An effect's plain Disadvantage on its creature's own rolls (effectTextRules): not one that goes on to say whose or which
// ("against creatures other than you", "that rely on sight", "until ..."), nor one in a sentence with a condition.
const DISADVANTAGE_ON = /^(?:(?!\b(?:if|when|whenever|while|unless)\b)[^.])*\bhas Disadvantage on ((?:ability checks|attack rolls|saving throws)(?:(?:,|,? and|,? or) (?:ability checks|attack rolls|saving throws))*)(?= for the duration\b|\s*[.;]|\s*$|, and\b)/iu;
// A sentence saying that and nothing else ("The target has Disadvantage on ability checks and attack rolls for the duration.").
const PLAIN_DISADVANTAGE = /^\s*(?:the target|it|the creature) has Disadvantage on (?:ability checks|attack rolls|saving throws)(?:(?:,|,? and|,? or) (?:ability checks|attack rolls|saving throws))*(?: for the duration)?\.?\s*$/iu;

/**
 * The rules an effect with none of its own takes from its item's text (Antitoxin's Advantage on saves against Poisoned)
 * and from its own words (`told`: effectTextRules).
 */
function textEffect(document, told) {
  const rules = [...savesAgainstRules(plainText(document), identifierOf(document)), ...told.ruleElements];
  return (rules.length || told.slug) ? {...(told.slug ? {slug: told.slug} : {}), ruleElements: rules,
    ...(told.duration ? {duration: told.duration} : {})} : null;
}

function emptyPassiveRules(document, notes=[]) {
  const effects = passiveEffects(document);
  if ( !effects.length || effects.some(effect => effectChanges(effect).length || effectStatuses(effect).length) ) return [];
  const text = String(document.system?.description?.value ?? "").replace(/<[^>]+>/gu, " ");
  const skills = new Set(Object.values(SKILL_MAP));
  const own = /\b(Advantage|Disadvantage) on (?:[A-Z][a-z]+ )?\(([A-Z][A-Za-z ]+)\) checks/gu;
  const rules = [];
  for ( const sentence of text.split(/(?<=\.)\s+/u).filter(sentence => /\b(?:Advantage|Disadvantage)\b/u.test(sentence)) ) {
    let rest = sentence;
    for ( const [phrase, mode, name] of sentence.matchAll(own) ) {
      const skill = name.toLowerCase().replace(/ /gu, "-");
      if ( !skills.has(skill) ) continue;
      rules.push({schemaVersion: 1, id: `${identifierOf(document)}-${skill}`, type: "RollMode",
        data: {domains: [`check.${skill}`], mode: mode.toLowerCase()}});
      rest = rest.replace(phrase, "");
    }
    // What an effect it applies does to its creature's attacks (Goading Attack's Goaded) is that effect's rule, when one
    // of its effects reads it.
    rest = rest.replace(SAVES_AGAINST, "");
    if ( (document.effects ?? []).some(effect => effectTextRules(document, effect).ruleElements.some(rule => rule.id === "others-disadvantage")) ) {
      rest = rest.replace(OTHERS_THAN_SOURCE, "");
    }
    // What else it says of Advantage (others' checks "made to see you") is not read.
    if ( /\b(?:Advantage|Disadvantage)\b/u.test(rest) ) notes.push(`text: "${sentence.trim()}" not converted`);
  }
  return rules;
}

/**
 * The armor and weapon training a feature's passive effects give (2024 Divine Order: Protector's martial weapons and
 * heavy armor), as trait keys its creature gains when the Item is added (`flags.wildpath.training`).
 */
function trainingKeys(document) {
  // An enchantment's rider's training stays the gear's (Efreeti Chain's Primordial): the enchantment carries rules only.
  const changes = passiveEffects(document, {riders: true})
    .flatMap(effectChanges);
  return [...new Set(changes.flatMap(change => {
    // 2024 Disciplined Survivor: proficiency in every saving throw.
    if ( change.key === "flags.dnd5e.diamondSoul" ) return Object.values(ABILITY_MAP).map(ability => `saves:${ability}`);
    // A language it gives (a Belt of Dwarvenkind's Dwarvish; a Helm of Telepathy's free text).
    if ( (change.type === "add") && /^system\.traits\.languages\.(value|custom)$/.test(change.key) ) {
      // Telepathy (a Helm of Telepathy's) is its rule instead (effectRules), with its range.
      return String(change.value ?? "").split(/[,;]/).map(entry => entry.trim()).filter(entry => entry && !telepathyRange(entry))
        .map(value => `languages:${value}`);
    }
    const kind = {"system.traits.armorProf.value": "armor", "system.traits.weaponProf.value": "weapon"}[change.key];
    if ( !kind || (change.type !== "add") ) return [];
    return String(change.value ?? "").split(/[,;]/).map(entry => entry.trim()).filter(Boolean).map(value => traitKey(`${kind}:${value}`));
  }).filter(Boolean))];
}

/** dnd5e's progression Item types and WildPath's (G8). */
export const PROGRESSION_TYPES = Object.freeze({class: "class", subclass: "subclass", race: "species", background: "background"});
const DND_SIZES = Object.freeze({tiny: "tiny", sm: "small", med: "medium", lg: "large", huge: "huge", grg: "gargantuan"});
const ARMOR_TRAINING = Object.freeze({lgt: "light", med: "medium", hvy: "heavy", shl: "shield"});
const WEAPON_TRAINING = Object.freeze({sim: "simple", mar: "martial"});

/**
 * A dnd5e trait key as WildPath's (G8): `skills:ath` is `skills:athletics`, `saves:str` `saves:might`, `armor:lgt`
 * `armor:light`, `weapon:mar` `weapons:martial` (or `masteries:martial` for Weapon Mastery), `tool:art:calligrapher`
 * `tools:calligrapher`. Languages are not tracked: null.
 */
export function traitKey(key, {mastery=false}={}) {
  const [kind, ...rest] = String(key).split(":");
  const tail = rest.join(":");
  switch ( kind ) {
    case "skills": return `skills:${tail === "*" ? "*" : slugify(DND_SKILLS[tail] ?? tail)}`;
    case "saves": return `saves:${ABILITY_MAP[tail] ?? tail}`;
    case "armor": return `armor:${ARMOR_TRAINING[tail] ?? tail}`;
    // A category (`weapon:mar`, `weapon:mar:*`) keeps it; one weapon (`weapon:mar:handcrossbow`) is its base, as an
    // attack names it (`hand-crossbow`).
    case "weapon": return `${mastery ? "masteries" : "weapons"}:${((rest.length === 2) && (rest[1] !== "*"))
      ? (WEAPON_BASES[rest[1]] ?? rest[1]) : rest.map(part => WEAPON_TRAINING[part] ?? part).join(":")}`;
    case "tool": return `tools:${rest.at(-1)}`;
    // A language (`languages:standard:elvish`, `languages:exotic:primordial:aquan`) is its own key; a choice of any
    // standard or rare (dnd5e's exotic) language keeps its pool.
    case "languages": {
      const last = rest.at(-1);
      if ( last !== "*" ) return `languages:${last}`;
      return {standard: "languages:standard:*", exotic: "languages:rare:*"}[rest[0]] ?? "languages:*";
    }
    default: return String(key);
  }
}

/**
 * A dnd5e class, subclass, species or background as its WildPath Item (G8): its fields and its by-level advancement,
 * with what it grants found through `uuidOf` (a dnd5e uuid to the WildPath uuids it converted to). Hit points and
 * scale values need no entry: a class's Hit Die, and the tables its features read.
 */
export function convertProgression(document, {uuidOf=() => [], licensed=isSrd2024, book="SRD 5.2", pack=null, names={},
  images=["icons/"]}={}) {
  if ( !licensed(document) ) return {ok: false, reason: "not SRD 5.2 (CC-BY-4.0, 2024)"};
  const type = PROGRESSION_TYPES[document.type];
  if ( !type ) return {ok: false, reason: `not a progression Item: ${document.type}`};
  const system = document.system ?? {};
  const notes = [];
  const uuids = list => list.flatMap(entry => {
    const found = uuidOf(entry.uuid);
    // The Barbarian's and Monk's Unarmed Strike grants are unlicensed; every creature has the common Unarmed Strike.
    const id = String(entry.uuid).split(".").pop();
    if ( !found.length && !["phbUnarmedStrike", "phbmnkUnarmedStr"].includes(id) ) notes.push(`grant: ${id} was not converted`);
    return found;
  });
  const advancement = Object.values(system.advancement ?? {}).flatMap(entry => {
    const config = entry.configuration ?? {};
    const base = {level: Number(entry.level) || 0, title: entry.title || null,
      ...(entry.classRestriction ? {classRestriction: entry.classRestriction} : {})};
    switch ( entry.type ) {
      case "HitPoints": case "ScaleValue": return [];
      case "ItemGrant": return [{...base, type: "grant", items: uuids(config.items ?? []), optional: config.optional === true}];
      // A level that only lets one be replaced (a Fighter's Fighting Style, a Warlock's Invocations: `count: null`) is
      // kept; Tasha's infusions may be replaced at every artificer level from 3rd ("whenever you gain a level").
      case "ItemChoice": {
        const infusions = config.restriction?.subtype === "artificerInfusion";
        const levels = Object.entries(config.choices ?? {}).filter(([, choice]) => (Number(choice?.count) > 0) || choice?.replacement)
          .map(([level, choice]) => [Number(level) || 0, choice]);
        if ( infusions ) for ( let level = 3; level <= 20; level++ ) if ( !levels.some(([at]) => at === level) ) levels.push([level, {count: 0}]);
        return levels.sort(([a], [b]) => a - b).map(([level, choice]) => ({...base, level, type: "choice", count: Number(choice.count) || 0,
          replacement: (choice.replacement === true) || (infusions && (level >= 3)), items: uuids(config.pool ?? [])}));
      }
      case "Trait": {
        const mastery = config.mode === "mastery";
        // An Expertise step (Rogue, Bard, Ranger): its skills become Expertise (`expertise:<skill>`).
        const expertise = ["expertise", "forcedExpertise"].includes(config.mode);
        const keys = list => list.map(key => traitKey(key, {mastery})).filter(Boolean)
          .map(key => (expertise ? key.replace(/^skills:/, "expertise:") : key));
        const grants = keys(config.grants ?? []);
        const choices = (config.choices ?? []).map(choice => ({count: Number(choice.count) || 1, pool: keys(choice.pool ?? [])}))
          .filter(choice => choice.pool.length);
        return (grants.length || choices.length) ? [{...base, type: "trait", grants, choices}] : [];
      }
      case "AbilityScoreImprovement": {
        const locked = new Set(config.locked ?? []);
        return [{...base, type: "improvement", points: Number(config.points) || 0, cap: Number(config.cap) || 2,
          abilities: Object.keys(ABILITY_MAP).filter(key => !locked.has(key)).map(key => ABILITY_MAP[key]),
          fixed: Object.fromEntries(Object.entries(config.fixed ?? {}).filter(([, value]) => Number(value)).map(([key, value]) => [ABILITY_MAP[key], Number(value)])),
          // An ability increase may be a feat instead (2024), unless it is a background's.
          feat: type !== "background"}];
      }
      case "Subclass": return [{...base, type: "subclass"}];
      case "Size": return [{...base, type: "size", sizes: (config.sizes ?? []).map(size => DND_SIZES[size] ?? size)}];
      default:
        notes.push(`advancement: ${entry.type} not converted`);
        return [];
    }
  });
  const fields = {identifier: system.identifier || slugify(document.name), advancement};
  // Its spellcasting: the Artificer rounds up like a half caster (2024 and Tasha's), and a third caster's is its subclass's.
  const progression = system.spellcasting?.progression ?? "none";
  const mapped = {full: "full", half: "half", artificer: "half", third: "third", pact: "pact"}[progression] ?? "none";
  if ( !["none", "full", "half", "third", "pact", "artificer"].includes(progression) ) notes.push(`spellcasting: ${progression} is treated as ${mapped}`);
  const spellcasting = {progression: mapped, ability: ABILITY_MAP[system.spellcasting?.ability] ?? "", prepared: preparedTable(system)};
  if ( type === "class" ) {
    Object.assign(fields, {levels: 1, hitDie: Number(String(system.hd?.denomination ?? "d8").slice(1)) || 8, original: false,
      primaryAbility: {abilities: (system.primaryAbility?.value ?? []).map(key => ABILITY_MAP[key] ?? key), all: system.primaryAbility?.all !== false},
      spellcasting});
  }
  if ( type === "subclass" ) Object.assign(fields, {classIdentifier: system.classIdentifier ?? "", ...((mapped !== "none") ? {spellcasting} : {})});
  if ( type === "species" ) {
    const sizes = advancement.find(entry => entry.type === "size")?.sizes ?? [];
    fields.size = sizes.includes("medium") ? "medium" : (sizes[0] ?? "medium");
    // Its senses (Darkvision 60 ft) are its creature's while it is theirs.
    const senses = senseRules(system.senses);
    if ( senses.length ) fields.ruleElements = senses;
  }
  const source = {system: "dnd5e", pack, id: document._id, type: document.type, book,
    license: system.source?.license || null, rules: system.source?.rules || "2024", identifier: identifierOf(document)};
  return {ok: true, notes, item: {_id: document._id, _key: `!items!${document._id}`, name: document.name, type,
    img: kept(document.img, images) ?? "icons/svg/book.svg",
    system: {active: true, description: describe(document, {names}), ...fields},
    flags: {wildpath: {source, conversion: {notes: [...new Set(notes)]}}}}};
}

/** dnd5e Item types that are things a creature carries: WildPath gear. */
const GEAR_TYPES = new Set(["equipment", "consumable", "tool", "loot", "container"]);

/**
 * Armor's rules (2024): its AC, the whole Agility modifier for light armor, up to its cap for medium (2), none for
 * heavy, plus any magic bonus; a Shield adds its AC. Heavy armor whose Strength the wearer lacks costs 10 feet of
 * Speed, and some armor gives Disadvantage on Stealth. Armor of any kind ("Armor, +1") is left to the GM.
 */
/** An armor's kind (`light`, `medium`, `heavy`, `shield`), which armor training must name (G8); null for anything else. */
export function armorKind(system) {
  const base = number(system?.armor?.value);
  // Specific magic armor (Dwarven Plate) may name only its base armor, or only its Agility cap.
  const cap = number(system?.armor?.dex);
  const kind = system?.type?.value || ((base == null) ? null : (ARMOR_KINDS[system?.type?.baseItem] ?? {0: "heavy", 2: "medium"}[cap] ?? "light"));
  return ["light", "medium", "heavy", "shield"].includes(kind) ? kind : null;
}

function armorRules(document, notes) {
  const system = document.system ?? {};
  const base = number(system.armor?.value);
  const cap = number(system.armor?.dex);
  const kind = armorKind(system);
  if ( !kind ) return [];
  // A Shield is one kind (2024: +2); only armor of another kind needs its base by hand.
  if ( (base == null) && (kind === "shield") ) return [{schemaVersion: 1, id: slugify(document.name), type: "Modifier",
    data: {domains: ["defense.ac"], modifierType: "untyped", value: 2 + (number(system.armor?.magicalBonus) ?? 0)}}];
  if ( base == null ) {
    notes.push("armor: of any kind; give it its armor's AC by hand");
    return [];
  }
  const id = slugify(document.name);
  const value = base + (number(system.armor?.magicalBonus) ?? 0);
  if ( kind === "shield" ) return [{schemaVersion: 1, id, type: "Modifier", data: {domains: ["defense.ac"], modifierType: "untyped", value}}];
  const limit = cap ?? {medium: 2, heavy: 0}[kind] ?? null;
  const agility = {type: "ability-modifier", ability: "agility"};
  const bonus = (limit == null) ? agility : {type: "min", terms: [agility, {type: "constant", value: limit}]};
  const rules = [{schemaVersion: 1, id, type: "ArmorClass", data: {label: document.name, armor: true,
    value: (limit === 0) ? value : {type: "add", terms: [{type: "constant", value}, bonus]}}}];
  const strength = number(system.strength);
  if ( strength ) rules.push({schemaVersion: 1, id: `${id}-strength`, type: "Modifier", data: {domains: ["resources.movement.max", "speed"],
    modifierType: "untyped", valueExpression: {type: "table", key: {type: "ability-score", ability: "might"},
      rows: {0: -10, [strength]: 0}}}});
  if ( (system.properties ?? []).includes("stealthDisadvantage") ) {
    rules.push({schemaVersion: 1, id: `${id}-stealth`, type: "RollMode", data: {domains: ["check.stealth"], mode: "disadvantage"}});
  }
  return rules;
}

/**
 * Common monster traits (G5), by dnd5e identifier: the rules each gives its creature, and what is left to the GM.
 * The activities a trait automates (`consumes`: Regeneration's healing, however dnd5e activates it) are not Actions.
 */
const TRAITS = Object.freeze({
  // A Draconic Spirit's Shared Resistances: its summoner's choice as Summon Dragon is cast (SUMMON_RULES), not the spirit's.
  "shared-resistances": (document, {activities}) => ({rules: [], consumes: [...activities], notes: []}),
  // Talismans (2024 DMG): a Fiend or an Undead holding a Talisman of Pure Good takes its Radiant damage each time it ends
  // its turn; any other creature holding a Talisman of Ultimate Evil takes its Necrotic damage.
  "talisman-of-pure-good": (document, options) => heldTurnEndDamage(document, options, "Fiend and Undead Damage", FIEND_OR_UNDEAD),
  "talisman-of-ultimate-evil": (document, options) => heldTurnEndDamage(document, options, "Non-Fiend or Undead Damage",
    {not: FIEND_OR_UNDEAD}),
  // 2024 Robe of Eyes: "A Light spell cast on the robe ... gives you the Blinded condition for 1 minute. At the end of each
  // of your turns, you make a Constitution saving throw (DC 11 for Light ...), ending the condition on yourself on a
  // success": Light cast on its wearer (free, always). shortcut: it blinds as Light is declared, even if Light is
  // countered. Daylight "cast within 5 feet of the robe" (DC 15) is by hand until a cast area's distance reaches a Trigger.
  "robe-of-eyes": (document, {activities}) => {
    const light = activities.find(entry => entry.name === "Light Save");
    return light ? {rules: [{schemaVersion: 1, id: "robe-of-eyes-light", type: "Trigger", data: {kind: "reaction", event: "action.declared",
      match: {phase: "interrupt", targetTokenId: "{self}", tagsAll: ["spell:light"]}, policy: "always",
      action: {schemaVersion: 1, id: "action:srd-robe-of-eyes-light", label: document.name, costs: {allOf: []}, range: {type: "self"},
        targeting: {type: "self"}, effects: [{id: "effect-1", type: "condition", conditionId: "blinded", duration: {value: 1, units: "minutes"},
          metadata: {repeatSave: {timing: "turnEnd", ability: "fortitude", dc: 11}}}]}}}], consumes: [light],
    notes: activities.filter(entry => entry !== light).map(entry => `"${entry.name || entry.type}" is passive or triggered: not automated`)} : null;
  },
  // Human Resourceful: a point of Heroic Inspiration on each Long Rest, kept in the character's pool of 4 (BG3, G8).
  "resourceful": () => ({rules: [{schemaVersion: 1, id: "resourceful", type: "GrantResource",
    data: {resourceId: "heroic-inspiration", maximum: 0, regain: {longRest: 1}}}], notes: []}),
  // Every spell is magical, and so is an Action tagged `magical` (a magic item's).
  "magic-resistance": () => ({rules: [{schemaVersion: 1, id: "magic-resistance", type: "RollMode",
    predicate: {tagsAny: ["magical"]}, data: {domains: ["save"], mode: "advantage"}}], notes: []}),
  // Its uses are the creature's ("3/Day"); a failed save may succeed instead, at once or when its controller chooses.
  "legendary-resistance": (document, {creature}) => (creature?.legendaryResistances ? {rules: [{schemaVersion: 1,
    id: "legendary-resistance", type: "GrantResource", data: {resourceId: "legendary-resistance", label: "Legendary Resistance",
      maximum: creature.legendaryResistances, recovery: "longRest"}}], notes: []} : null),
  // "You can attack twice instead of once whenever you take the Attack action on your turn"; three and four times later.
  "extra-attack": () => extraAttackTrait(),
  "two-extra-attacks": () => extraAttackTrait(),
  "three-extra-attacks": () => extraAttackTrait(),
  // "When you're subjected to an effect that allows you to make a Dexterity saving throw to take only half damage, you
  // instead take no damage if you succeed on the saving throw and only half damage if you fail", unless Incapacitated.
  evasion: () => ({rules: [{schemaVersion: 1, id: "evasion", type: "RollOutcome", predicate: NOT_INCAPACITATED,
    data: {domains: ["save.agility"], outcome: "evasion"}}], notes: []}),
  // 2024 Primal Bond (a Beast Master's beast): its controller's Proficiency Bonus on the beast's checks and saves.
  "primal-bond": () => ({rules: [{schemaVersion: 1, id: "primal-bond", type: "Modifier",
    data: {domains: ["check", "save"], modifierType: "untyped", valueExpression: {type: "controller-proficiency-bonus"}}}], notes: []}),
  // A monster's Avoidance: Evasion on every save, not only Dexterity's, unless Incapacitated.
  avoidance: () => ({rules: [{schemaVersion: 1, id: "avoidance", type: "RollOutcome", predicate: NOT_INCAPACITATED,
    data: {domains: ["save"], outcome: "evasion"}}], notes: []}),
  // 2024 Elusive: "No attack roll can have Advantage against you unless you have the Incapacitated condition."
  elusive: () => ({rules: [{schemaVersion: 1, id: "elusive", type: "RollOutcome", predicate: NOT_INCAPACITATED,
    data: {domains: ["attacked"], outcome: "no-advantage"}}], notes: []}),
  // 2024 Indomitable Might: a Strength check's or save's total counts as at least the Strength (Might) score.
  "indomitable-might": () => ({rules: [{schemaVersion: 1, id: "indomitable-might", type: "RollOutcome",
    data: {domains: ["check.might", "save.might"], outcome: "minimum-score"}}], notes: []}),
  // A feat's weapon or spell attacks ignore Half and Three-Quarters Cover (`cover.ignored` 2): Sharpshooter's ranged weapon
  // attacks; Spell Sniper's spell attacks, which also reach 60 feet farther (`range.spell`). Their other parts lift
  // penalties WildPath doesn't impose (long range, attacking beside an enemy).
  sharpshooter: () => ({rules: [{schemaVersion: 1, id: "sharpshooter-cover", type: "Modifier", predicate: {tagsAll: ["weapon", "ranged"]},
    data: {domains: ["cover.ignored"], modifierType: "untyped", value: 2}}], notes: []}),
  "spell-sniper": () => ({rules: ["cover.ignored", "range.spell"].map(domain => ({schemaVersion: 1, id: `spell-sniper-${domain.split(".")[0]}`,
    type: "Modifier", predicate: {tagsAll: ["spell", "attack"]}, data: {domains: [domain], modifierType: "untyped",
      value: (domain === "range.spell") ? 60 : 2}})), notes: []}),
  // 2024 Improved Elemental Fury: with Potent Spellcasting, a cantrip with a range of 10 feet or more reaches 300 feet farther
  // (withRangeBonus reads only those). Like Potent Spellcasting it reads any cantrip: spells carry no class. Primal Strike's
  // 2d8 is already its damage table's row at druid level 15.
  "improved-elemental-fury": () => ({rules: [{schemaVersion: 1, id: "improved-elemental-fury", type: "Modifier",
    predicate: {all: [{tagsAll: ["cantrip"]}, {hasFeature: "elemental-fury-potent-spellcasting"}]},
    data: {domains: ["range.spell"], modifierType: "untyped", value: 300}}], notes: []}),
  // +2 damage with a thrown weapon's ranged attack (Thrown Weapon Fighting); drawing it as part of the attack needs nothing.
  "thrown-weapon-fighting": () => ({rules: [{schemaVersion: 1, id: "thrown-weapon-fighting", type: "Modifier",
    predicate: {tagsAll: ["ranged", "thrown"]}, data: {domains: ["damage.weapon"], modifierType: "untyped", value: 2}}], notes: []}),
  // A creature's Fey Ancestry that says magic can't put it to sleep: Trance's rule (the saves part is SAVES_AGAINST's).
  "fey-ancestry": document => (/\bmagic can[’']t put (?:it|you) to sleep\b/u.test(plainText(document)) ? TRAITS.trance() : null),
  // Sentinel (Guardian): an Opportunity Attack against a hostile creature within 5 feet that takes the Disengage action
  // (any that disengages: Cunning Action's too; as it declares it: shortcut, not after) or hits a creature other than it. Its Halt is its own Action (FEATURE_ACTIONS).
  sentinel: () => ({rules: [
    {schemaVersion: 1, id: "sentinel-disengage", type: "Trigger", data: {kind: "reaction", event: "action.declared",
      match: {phase: "interrupt", notSourceTokenId: "{self}"}, commonAction: "opportunity", opportunity: true, triggerPredicate: {all: [
        {equals: {path: "event.data.disengages", value: true}}, {equals: {path: "toSource.{self}.hostile", value: true}},
        {atMost: {path: "toSource.{self}.distance", value: 5}}]}}},
    {schemaVersion: 1, id: "sentinel-guardian", type: "Trigger", data: {kind: "reaction", event: "attack.hit",
      match: {phase: "interrupt", notSourceTokenId: "{self}"}, commonAction: "opportunity", opportunity: true, triggerPredicate: {all: [
        {equals: {path: "toSource.{self}.hostile", value: true}}, {atMost: {path: "toSource.{self}.distance", value: 5}},
        {not: {equals: {path: "toTarget.{self}.self", value: true}}}]}}}], notes: []}),
  // Advantage on saves against spells and Resistance to their damage (Spell Resistance; spell damage is tagged "spell").
  "spell-resistance": () => ({rules: [{schemaVersion: 1, id: "spell-resistance-saves", type: "RollMode", predicate: {tagsAny: ["spell"]},
    data: {domains: ["save"], mode: "advantage"}}, {schemaVersion: 1, id: "spell-resistance-damage", type: "GrantResistance",
    data: {tags: ["spell"]}}], notes: []}),
  // A Fly and a Swim Speed equal to its Speed while its Elemental Attunement lasts (Stride of the Elements).
  "stride-of-the-elements": () => ({rules: [movementEqualToSpeed("stride-fly", "fly"), movementEqualToSpeed("stride-swim", "swim")]
    .map(rule => ({...rule, predicate: {hasCondition: "elemental-attunement"}})), notes: []}),
  // Advantage on melee attacks against a Bloodied creature (the DMG's Warrior's Wrath; `attack.targetBloodied`).
  "warriors-wrath": () => ({rules: [{schemaVersion: 1, id: "warriors-wrath", type: "RollMode",
    predicate: {equals: {path: "attack.targetBloodied", value: true}}, data: {domains: ["attack.melee"], mode: "advantage"}}], notes: []}),
  // Resistance to Bludgeoning, Piercing and Slashing damage while in its Starry Form (a Stars druid's Full of Stars).
  "full-of-stars": (document, {activities}) => ({rules: [{schemaVersion: 1, id: "full-of-stars", type: "GrantResistance",
    predicate: {hasCondition: "starry-form"}, data: {damageTypes: ["bludgeoning", "piercing", "slashing"]}}],
  consumes: activities.filter(entry => entry.type === "utility"), notes: []}),
  // Resistance to all damage but Force, Psychic and Radiant while not in Bright Light (a shadow dragon's Living Shadow).
  "living-shadow": () => ({rules: [{schemaVersion: 1, id: "living-shadow", type: "GrantResistance",
    predicate: {not: {equals: {path: "inBrightLight", value: true}}},
    data: {damageTypes: DAMAGE_TYPES.filter(type => !["force", "psychic", "radiant"].includes(type))}}], notes: []}),
  // 2024 Trance: "magic can't put you to sleep" (Sleep: a creature that doesn't sleep succeeds on its saves). shortcut: its
  // 4-hour Long Rest is by hand (a party rest is 8 hours).
  trance: () => ({rules: [{schemaVersion: 1, id: "trance", type: "RollOutcome", predicate: {tagsAny: ["sleep"]},
    data: {domains: ["save"], outcome: "automatic-success"}}], notes: []}),
  // 2024 Foe Slayer: "The damage die of your Hunter's Mark is a d10 rather than a d6": the mark's own table (ranger 20).
  "foe-slayer": () => ({rules: [], notes: []}),
  // 2024 Relentless Hunter: "Taking damage can't break your Concentration on Hunter's Mark" (no damage check while what
  // it sustains is the mark; 2024 concentration holds one spell).
  "relentless-hunter": () => ({rules: [{schemaVersion: 1, id: "relentless-hunter", type: "RollOutcome",
    predicate: {equals: {path: "concentration.sustains.hunters-mark", value: true}},
    data: {domains: ["concentration"], outcome: "automatic-success"}}], notes: []}),
  // Immune to the spells its text links (`spell:<identifier>`, by each link's name, apostrophes dropped as dnd5e's
  // identifiers drop them), from any spell pack: its maker's usual three. Another choice is its Unaffected rule's tags,
  // edited by hand.
  "spell-immunity": document => {
    const spells = [...String(document.system?.description?.value ?? "")
      .matchAll(/@UUID\[Compendium\.[\w-]+\.[\w-]*spells[\w-]*\.Item\.[\w-]+\]\{([^}]+)\}/g)]
      .map(([, name]) => `spell:${slugify(name.replace(/['’]/g, ""))}`);
    return spells.length ? {rules: [{schemaVersion: 1, id: "spell-immunity", type: "Unaffected", data: {actions: {tagsAny: spells}}}],
      notes: []} : null;
  },
  // Immune to Divination spells; its Bonus Action suppressing or restoring that is its feature's active toggle.
  "telepathic-shroud": () => ({rules: [{schemaVersion: 1, id: "telepathic-shroud", type: "Unaffected",
    data: {actions: {tagsAll: ["school:divination"]}}}],
  notes: ["Telepathic Shroud: immunity to mind-reading effects other than spells is by hand"]}),
  // A Tarrasque's Reflective Carapace: Magic Missile and spells with a ranged attack roll targeting it leave it
  // unaffected, whatever its d6 shows (`attack:ranged`, actionTags). Reflecting the spell on a 6 stays by hand.
  "reflective-carapace": (document, {activities}) => ({rules: [{schemaVersion: 1, id: "reflective-carapace", type: "Unaffected",
    data: {actions: {any: [{tagsAny: ["spell:magic-missile"]}, {tagsAll: ["spell", "attack:ranged"]}]}}}],
  consumes: [...activities], notes: ["Reflective Carapace: reflecting the spell back at its caster on a 6 is by hand"]}),
  // Beast Spells (druid 18): casting in a form it keeps its features in (Wild Shape) lifts the transformed Forbid, but
  // for a spell with a costly or consumed Material component (2024), or any Material component (2014).
  "beast-spells": document => {
    const text = plainText(document);
    const costly = /\bMaterial component with a cost\b/u.test(text);
    if ( !costly && !/\bmaterial components\b/iu.test(text) ) return null;
    return {rules: [{schemaVersion: 1, id: "beast-spells", type: "Allow", data: {lifts: "transformed",
      actions: {tagsAny: ["spell"], notTagsAny: [costly ? "component:costly-material" : "component:material"]}}}],
    notes: costly ? [] : ["Beast Spells: only druid spells is by hand"]};
  },
  // A golem's Immutable Form: "can't shape-shift" (2014: immune to effects that alter its form); no Polymorph takes it.
  "immutable-form": () => ({rules: [{schemaVersion: 1, id: "immutable-form", type: "ConditionImmunity",
    data: {conditions: ["transformed"]}}], notes: []}),
  // Once per turn, extra damage of the weapon's type to a creature hit with a Finesse or Ranged weapon, if the attack has
  // Advantage, or an ally is within 5 ft of the target and the attack has no Disadvantage.
  // 2024 Frenzy: while raging and Reckless, the first target hit with a Strength attack on its turn takes its Rage
  // Damage in d6s more.
  frenzy: (document, {activities, scales}) => weaponExtra(activities, scales, "Frenzy", {all: [{tagsAll: ["might"]},
    {hasCondition: "raging"}, {hasCondition: "reckless"}]}),
  // 2024 Hunter's Prey, as Colossus Slayer: once a turn, 1d8 more to a creature hit with a weapon that is missing Hit
  // Points. shortcut: Horde Breaker, its other option, is by hand.
  "hunters-prey": (document, {activities, scales}) => weaponExtra(activities, scales, "Colossus Slayer",
    {equals: {path: "attack.targetDamaged", value: true}}),
  // 2024 Precise Hunter: Advantage on attack rolls against the creature its own Hunter's Mark marks (the mark's damage
  // reads the same `fromAttacker` flag; another caster's mark does not count).
  "precise-hunter": () => ({rules: [{schemaVersion: 1, id: "precise-hunter", type: "RollMode",
    predicate: {equals: {path: "attack.fromAttacker.hunters-mark", value: true}}, data: {domains: ["attack"], mode: "advantage"}}],
    notes: []}),
  // 2024 Grappler. Attack Advantage: against a creature it Grappled (`attack.fromAttacker.grappled`). Punch and Grab: once
  // a turn, its Unarmed Strike's hit may also Grapple, free. shortcut: any of its Unarmed Strike hits qualifies, not only
  // one of the Attack action's. Fast Wrestler needs nothing: moving a Grappled creature costs no extra movement here.
  // A Find Steed steed's Life Bond: it regains what a level 1+ spell heals its summoner within 5 feet (a shared-healing
  // Trigger the runtime reads: durability.lifeBonds).
  "life-bond": () => ({rules: [{schemaVersion: 1, id: "life-bond", type: "Trigger", data: {kind: "shared-healing", event: "healing.applied",
    from: "summoner", range: 5, minimumCastLevel: 1, tagsAll: ["spell"]}}], notes: []}),
  // 2024 Potent Cantrip: a saved cantrip deals half its damage (a `half-on-success` RollOutcome on the saves it imposes).
  "potent-cantrip": () => ({rules: [{schemaVersion: 1, id: "potent-cantrip", type: "RollOutcome", predicate: {tagsAll: ["cantrip"]},
    data: {outcome: "half-on-success", domains: ["imposed.save"]}}],
  notes: ["Potent Cantrip: half damage on a missed cantrip attack is by hand"]}),
  // 2024 Perfect Focus (monk 15) and Superior Inspiration (bard 18): when it rolls Initiative, its pool comes back up to
  // 4 Focus Points, or 2 Bardic Inspiration dice. shortcut: Perfect Focus doesn't check that Uncanny Metabolism wasn't used.
  "perfect-focus": () => ({rules: [refillOnInitiative("perfect-focus", "monk-s-focus", "Perfect Focus", 4)], notes: []}),
  "superior-inspiration": () => ({rules: [refillOnInitiative("superior-inspiration", "bardic-inspiration", "Superior Inspiration", 2)],
    notes: []}),
  // 2024 Great Weapon Fighting: a 1 or 2 on a damage die of a melee attack with a weapon held in two hands counts as a 3
  // (a Two-Handed weapon, or a Versatile one's two-handed Action).
  "great-weapon-fighting": () => ({rules: [{schemaVersion: 1, id: "great-weapon-fighting", type: "DamageDieMinimum",
    predicate: {tagsAll: ["melee", "two-handed"]}, data: {domains: ["damage.weapon"], minimum: 3}}], notes: []}),
  // A Climb or Swim Speed equal to its Speed: Athlete (standing up and running jumps cost nothing extra here anyway),
  // Aquatic Affinity, a thief's Second-Story Work (unless its effect gives it already, as the SRD copy's does).
  athlete: () => ({rules: [movementEqualToSpeed("athlete-climb", "climb")], notes: []}),
  "aquatic-affinity": () => ({rules: [movementEqualToSpeed("aquatic-affinity-swim", "swim")], notes: []}),
  "second-story-work": document => (passiveEffects(document).length ? null
    : {rules: [movementEqualToSpeed("second-story-work-1", "climb")], notes: []}),
  // Advantage on saves against Charmed and Frightened (Tasha's Psychic Defenses), its activity the rule's.
  "psychic-defenses": (document, {activities}) => ({rules: [{schemaVersion: 1, id: "psychic-defenses", type: "RollMode",
    predicate: {tagsAny: ["against:charmed", "against:frightened"]}, data: {domains: ["save"], mode: "advantage"}}],
  consumes: activities.filter(entry => entry.type === "utility"), notes: []}),
  // Advantage on Initiative (the DMG's Battle Ready); not the Battle Smith's feature of the same name, an enchantment.
  "battle-ready": document => (/\bAdvantage on Initiative rolls\b/u.test(plainText(document))
    ? {rules: [{schemaVersion: 1, id: "battle-ready", type: "RollMode", data: {domains: ["initiative"], mode: "advantage"}}], notes: []} : null),
  // Magic Resistance as a supernatural gift (the DMG's Blessing of Magic Resistance).
  "blessing-of-magic-resistance": (...args) => TRAITS["magic-resistance"](...args),
  // Attacks against it have Disadvantage unless it is Incapacitated (a displacer beast's Displacement).
  displacement: () => ({rules: [{schemaVersion: 1, id: "displacement", type: "RollMode", predicate: NOT_INCAPACITATED,
    data: {domains: ["attacked"], mode: "disadvantage"}}], notes: []}),
  // Disadvantage in sunlight (a myconid's Sun Sickness), as Sunlight Sensitivity's; its slow death in sunlight is the GM's.
  "sun-sickness": (document, options) => sunlightTrait(document, options),
  grappler: () => ({rules: [
    {schemaVersion: 1, id: "grappler-advantage", type: "RollMode", predicate: {equals: {path: "attack.fromAttacker.grappled", value: true}},
      data: {domains: ["attack"], mode: "advantage"}},
    {schemaVersion: 1, id: "punch-and-grab", type: "Trigger", data: {kind: "reaction", event: "attack.hit",
      match: {phase: "interrupt", sourceTokenId: "{self}", tagsAll: ["unarmed"]}, commonAction: "grapple", free: true,
      once: "turn", onceKey: "punch-and-grab"}}], notes: []}),
  // 2024 Boon of Combat Prowess: Peerless Aim's use, once until the start of its next turn (its test offer is TEST_OFFERS').
  "boon-of-combat-prowess": () => ({rules: [{schemaVersion: 1, id: "boon-of-combat-prowess-uses", type: "GrantResource",
    data: {resourceId: "boon-of-combat-prowess", label: "Peerless Aim", maximum: 1, recovery: "turn"}}], notes: []}),
  // 2024 Boon of Irresistible Offense: its Overcome Defenses is IGNORES_RESISTANCE's; its Overwhelming Strike is by hand.
  "boon-of-irresistible-offense": () => ({rules: [], notes: ["Overwhelming Strike: a 20's extra damage of the attack's type is by hand"]}),
  // Magical Ambush: while its rogue is Invisible, a creature saving against its spell has Disadvantage (`imposed.save`,
  // read while that spell resolves, so "this turn" needs nothing more). shortcut: a later save the same spell forces
  // this turn by another path (its lasting area entered) has none.
  "magical-ambush": () => ({rules: [{schemaVersion: 1, id: "magical-ambush", type: "RollMode",
    predicate: {all: [{tagsAny: ["spell"]}, {hasCondition: "invisible"}]}, data: {domains: ["imposed.save"], mode: "disadvantage"}}], notes: []}),
  // Piercer: once a turn, one die of an attack's Piercing damage rerolled (its lowest below average, as Empowered Spell);
  // a Critical Hit's Piercing damage rolls one more die. Its +1 ability increase is by hand, as every feat's.
  piercer: () => ({rules: [{schemaVersion: 1, id: "piercer-puncture", type: "RollOutcome", data: {domains: ["damage.melee", "damage.ranged"],
    outcome: "reroll-damage-die", count: 1, once: "turn", damageTypes: ["piercing"]}},
  {schemaVersion: 1, id: "piercer-critical", type: "RollOutcome", data: {domains: ["damage.melee", "damage.ranged"],
    outcome: "critical-dice", dice: 1, damageTypes: ["piercing"]}}], notes: []}),
  // Steadfast: no Frightened while an ally stands within 30 feet of it (`bearerOnly`). shortcut: that it can see the ally is
  // not checked; upgrade when auras have a sight test.
  steadfast: () => ({rules: [{schemaVersion: 1, id: "steadfast", type: "Aura", data: {radius: 30, affects: "allies", bearerOnly: true,
    ruleElements: [{schemaVersion: 1, id: "steadfast-frightened", type: "ConditionImmunity", data: {conditions: ["frightened"]}}]}}], notes: []}),
  // Twinkling Constellations: its 2d8 is Starry Form's die at druid level 10 already. The Dragon's flight waits on Starry
  // Form's constellations being statuses (then a GrantMovement gated on the Dragon's).
  "twinkling-constellations": () => ({rules: [], notes: ["Twinkling Constellations: the Dragon constellation's 20 ft Fly Speed (hover) and "
    + "changing constellation at the start of each turn are by hand"]}),
  // 2024 Boon of Spell Recall: its Free Cast Roll is SLOT_RECALL's.
  "boon-of-spell-recall": (document, {activities}) => ({rules: [], consumes: [...activities], notes: []}),
  // 2024 Commoner's Training: "proficiency in one skill of the DM's choice and ... Advantage whenever it makes an ability
  // check using that skill". The GM sets the skill on its sheet. shortcut: every skill it is proficient in.
  training: () => ({rules: [{schemaVersion: 1, id: "training", type: "RollMode", data: {domains: ["check.proficient"], mode: "advantage"}}],
    notes: []}),
  // 2024 Mindless Rage: Immunity to Charmed and Frightened while raging. One it already has is suppressed while the Rage
  // lasts, as under Aura of Courage. shortcut: that condition returns when the Rage ends instead of ending; upgrade when
  // entering a Rage can end conditions.
  "mindless-rage": () => ({rules: [{schemaVersion: 1, id: "mindless-rage", type: "ConditionImmunity",
    predicate: {hasCondition: "raging"}, data: {conditions: ["charmed", "frightened"]}}], notes: []}),
  // 2024 Wood Elf lineage: "Your Speed increases to 35 feet" (the Elf's 30, +5). Its cantrip and spells are the
  // species' advancement.
  "elven-lineage-wood-elf": () => ({rules: [{schemaVersion: 1, id: "wood-elf-speed", type: "Modifier",
    data: {domains: ["resources.movement.max"], modifierType: "untyped", value: 5}}], notes: []}),
  // 2024 Fiendish Legacy, level 1 (every character): Resistance to Poison (Abyssal), Necrotic (Chthonic) or Fire
  // (Infernal) damage. shortcut: its spells' free cast once per Long Rest and its casting ability are by hand.
  "fiendish-legacy-abyssal": () => fiendishLegacy("poison"),
  "fiendish-legacy-chthonic": () => fiendishLegacy("necrotic"),
  "fiendish-legacy-infernal": () => fiendishLegacy("fire"),
  // 2024 Potent Spellcasting (cleric, druid): its Wisdom modifier on a cantrip's damage. shortcut: any cantrip, not only
  // its class's.
  "blessed-strikes-potent-spellcasting": (document, {activities}) => spellDamageBonus(activities, "wits", {tagsAll: ["cantrip"]}),
  "elemental-fury-potent-spellcasting": (document, {activities}) => spellDamageBonus(activities, "wits", {tagsAll: ["cantrip"]}),
  // Eldritch Invocation Agonizing Blast: its Charisma modifier on every cantrip's damage (house rule: a feature changing
  // a chosen cantrip changes every cantrip).
  "agonizing-blast": (document, {activities}) => spellDamageBonus(activities, "presence", {tagsAll: ["cantrip"]}),
  // 2024 Eldritch Spear: a chosen damaging cantrip with a range of 10+ feet reaches 30 feet farther per warlock level (house
  // rule: every such cantrip). An `item` Modifier, so a second copy adds nothing (withRangeBonus reads `range.spell`).
  "eldritch-spear": (document, {activities}) => ({rules: [{schemaVersion: 1, id: "eldritch-spear", type: "Modifier",
    predicate: {tagsAll: ["cantrip"], tagsAny: DAMAGE_TYPES.map(type => `damage:${type}`)}, data: {domains: ["range.spell"], modifierType: "item",
      valueExpression: {type: "multiply", terms: [{type: "constant", value: 30}, {type: "class-level", class: "warlock"}]}}}],
  consumes: activities.filter(entry => entry.type === "enchant"), notes: []}),
  // 2024 Empowered Evocation: its Intelligence modifier on one damage roll of an evocation spell.
  "empowered-evocation": (document, {activities}) => spellDamageBonus(activities, "intellect", {tagsAll: ["school:evocation"]},
    {oneRoll: true}),
  // 2024 Disciple of Life: a spell cast with a slot heals 2 + the slot's level more.
  "disciple-of-life": (document, {activities}) => ({rules: [{schemaVersion: 1, id: "disciple-of-life", type: "Modifier",
    predicate: {oneOf: {path: "castLevel", values: [1, 2, 3, 4, 5, 6, 7, 8, 9]}}, data: {domains: ["healing.spell"], modifierType: "untyped",
      valueExpression: {type: "add", terms: [{type: "constant", value: 2}, {type: "context", path: "castLevel"}]}}}],
  consumes: activities.filter(entry => entry.type === "heal"), notes: []}),
  // 2024 Survivor (Heroic Rally): at the start of each of its turns, while Bloodied and at 1 Hit Point or more, it
  // regains 5 + its Constitution modifier.
  survivor: (document, {activities}) => {
    const activity = activities.find(entry => entry.type === "heal");
    if ( !activity ) return null;
    return {rules: [{schemaVersion: 1, id: "heroic-rally", type: "Trigger", data: {event: "turn.started",
      predicate: {all: [{bloodied: true}, {not: {equals: {path: "actor.system.resources.health.value", value: 0}}}]},
      action: {schemaVersion: 1, id: "action:srd-survivor-heroic-rally", label: "Heroic Rally", costs: {allOf: []}, range: {type: "self"},
        targeting: {type: "self"}, healing: [{id: "healing-1", healingType: "healing", expression: {type: "add",
          terms: [{type: "constant", value: 5}, {type: "ability-modifier", ability: "fortitude"}]}}]}}}],
    consumes: [activity], notes: []};
  },
  // What keeps a creature up when damage would drop it to 0 Hit Points (`Trigger`, `event: "health.zero"`, read by the
  // runtime): 2024 Relentless Endurance (1 HP, once per Long Rest), Relentless Rage (while raging, a DC 10 Constitution
  // save, +5 each use until a rest: 2x its barbarian level), Undead Fortitude (a Constitution save, DC 5 + the damage
  // taken, not against radiant damage or a critical hit: 1 HP).
  "relentless-endurance": (document, {activities, pool}) => zeroHpTrait(activities, {mode: "set", hitPoints: 1, pool: pool?.id}),
  "relentless-rage": (document, {activities, pool}) => zeroHpTrait(activities, {mode: "save", ability: "fortitude",
    dc: {base: 10, perUse: 5, usesPool: pool?.id}, whileStatus: "raging",
    hitPoints: {type: "multiply", terms: [{type: "constant", value: 2}, {type: "class-level", class: "barbarian"}]}}),
  "undead-fortitude": (document, {activities}) => zeroHpTrait(activities, {mode: "save", ability: "fortitude", dc: {plusDamage: 5},
    hitPoints: 1, notOn: ["radiant", "critical"]}),
  // Arcane Recovery and Natural Recovery's slots, chosen when a Short Rest ends (slotRecovery).
  "arcane-recovery": (document, {activities}) => ({...slotRecovery({id: "arcane-recovery-slots", poolId: "arcane-recovery",
    label: document.name, classId: "wizard", ownPool: true}), consumes: activities.filter(entry => entry.type === "utility")}),
  // Its free Circle Spell is a free cast (FREE_CASTS).
  "natural-recovery": (document, {activities}) => ({...slotRecovery({id: "natural-recovery-slots", poolId: "natural-recovery-recover-spell-slots",
    label: "Natural Recovery (Recover Spell Slots)", classId: "druid"}),
    consumes: activities.filter(entry => ["Recover Spell Slots", "Cast Spell"].includes(entry.name))}),
  // 2024 Circle of the Land Spells: "Whenever you finish a Long Rest, choose one type of land ... you have the spells listed
  // for your Druid level and lower prepared."
  "circle-of-the-land-spells": document => ({rules: [longRestGrantChoice(document, {id: "circle-of-the-land-spells", choiceId: "land",
    label: "Land", classId: "druid"})], notes: []}),
  // 2024 Boon of Fate: its use comes back when it rolls Initiative, as on a Short Rest.
  "boon-of-fate": () => ({rules: [{schemaVersion: 1, id: "boon-of-fate-initiative", type: "Trigger", data: {kind: "automation",
    event: "initiative.rolled", predicate: {all: [{poolBelowMax: "boon-of-fate"}]}, action: {schemaVersion: 1,
      id: "action:srd-boon-of-fate-initiative", label: "Improve Fate", costs: {allOf: []}, range: {type: "self"}, targeting: {type: "self"},
      restores: [{resourceId: "boon-of-fate", amount: 1, refuseWhenFull: true}]}}}],
  notes: ["Improve Fate: the 2d4 penalty on another creature's successful D20 Test is by hand"]}),
  // 2024 Blessed Healer: "when you cast a spell with a spell slot and that spell restores Hit Points to any creature other
  // than you, you regain Hit Points equal to 2 plus the spell slot's level" (`event: "healing.applied"`, the runtime's).
  "blessed-healer": (document, {activities}) => ({rules: [{schemaVersion: 1, id: "blessed-healer", type: "Trigger",
    data: {kind: "healer", event: "healing.applied", othersOnly: true, hitPoints: {type: "add", terms: [{type: "constant", value: 2},
      {type: "context", path: "castLevel"}]}}}], consumes: activities.filter(entry => entry.type === "heal"), notes: []}),
  // 2024 Dark One's Blessing: when it reduces a hostile creature to 0 Hit Points, Temporary Hit Points of its Charisma
  // modifier + its warlock level (`event: "health.reduced"`).
  "dark-ones-blessing": (document, {activities}) => ({rules: [{schemaVersion: 1, id: "dark-ones-blessing", type: "Trigger",
    data: {kind: "zero-hp", event: "health.reduced", hostileOnly: true, temporaryHitPoints: {type: "max", terms: [{type: "constant", value: 1},
      {type: "add", terms: [{type: "ability-modifier", ability: "presence"}, {type: "class-level", class: "warlock"}]}]}}}],
  consumes: activities.filter(entry => entry.type === "heal"), notes: []}),
  "sneak-attack": (document, {activities, scales}) => {
    const activity = activities.find(entry => entry.type === "damage");
    const notes = [];
    const expression = activity ? partExpression(activity.damage?.parts?.[0], {spell: false, ability: null, scales, notes,
      label: "Sneak Attack"}) : null;
    if ( !expression ) return null;
    return {rules: [{schemaVersion: 1, id: "sneak-attack", type: "ExtraDamage", predicate: SNEAK_ATTACK,
      data: {domains: ["damage.weapon"], expression, once: "turn"}}], consumes: [activity], notes};
  },
  // "While in sunlight, the drider has Disadvantage on ability checks and attack rolls" (2014: Perception checks that rely
  // on sight); Sunlight Weakness, on D20 Tests; Sunlight Hypersensitivity also burns it at the start of its turn there.
  "sunlight-sensitivity": (document, options) => sunlightTrait(document, options),
  "sunlight-weakness": (document, options) => sunlightTrait(document, options),
  "sunlight-hypersensitivity": (document, options) => sunlightTrait(document, options),
  // A 2024 Vampire's: "takes 20 Radiant damage if it starts its turn in sunlight"; its Running Water damage stays a note.
  "vampire-weakness": (document, options) => sunlightTrait(document, options),
  // "Doesn't provoke an Opportunity Attack when it flies out of an enemy's reach."
  flyby: () => ({rules: [{schemaVersion: 1, id: "flyby", type: "AvoidOpportunityAttacks", data: {movementModes: ["fly"]}}], notes: []}),
  "pack-tactics": () => ({rules: [{schemaVersion: 1, id: "pack-tactics", type: "RollMode",
    predicate: {equals: {path: "attack.allyNearTarget", value: true}}, data: {domains: ["attack"], mode: "advantage"}}], notes: []}),
  // 2024 Flesh Golem: "If the flesh golem takes Fire damage, it has Disadvantage on attack rolls and ability checks until the
  // end of its next turn": a `damage.taken` trigger (the dying adapter dispatches it with the types taken).
  "aversion-to-fire": document => ({rules: [{schemaVersion: 1, id: "aversion-to-fire", type: "Trigger", data: {event: "damage.taken",
    predicate: {equals: {path: "event.data.damageTaken.fire", value: true}},
    action: {schemaVersion: 1, id: "action:srd-aversion-to-fire", label: document.name, costs: {allOf: []}, range: {type: "self"},
      targeting: {type: "self"}, effects: [{id: "effect-1", type: "effect", name: document.name, img: "icons/svg/fire.svg",
        duration: {value: 1, units: "rounds", expiry: "turnEnd"},
        ruleElements: [{schemaVersion: 1, id: "aversion-to-fire", type: "RollMode", data: {domains: ["attack", "check"], mode: "disadvantage"}}]}]}}}],
    notes: []}),
  // 2024 Cloaker: "While in Bright Light, the cloaker has Disadvantage on attack rolls" (inBrightLight, beside inSunlight).
  "light-sensitivity": () => ({rules: [{schemaVersion: 1, id: "light-sensitivity", type: "RollMode",
    predicate: {equals: {path: "inBrightLight", value: true}}, data: {domains: ["attack"], mode: "disadvantage"}}], notes: []}),
  // 2024 Berserker: "While Bloodied, the berserker has Advantage on attack rolls and saving throws."
  "bloodied-frenzy": () => ({rules: [{schemaVersion: 1, id: "bloodied-frenzy", type: "RollMode", predicate: {bloodied: true},
    data: {domains: ["attack", "save"], mode: "advantage"}}], notes: []}),
  // 2024 Boar, Giant Boar: "While Bloodied, the boar has Advantage on attack rolls."
  "bloodied-fury": () => ({rules: [{schemaVersion: 1, id: "bloodied-fury", type: "RollMode", predicate: {bloodied: true},
    data: {domains: ["attack"], mode: "advantage"}}], notes: []}),
  // Sahuagin: "Advantage on attack rolls against any creature that doesn't have all its Hit Points" (2014: melee ones).
  "blood-frenzy": document => ({rules: [{schemaVersion: 1, id: "blood-frenzy", type: "RollMode",
    predicate: {equals: {path: "attack.targetDamaged", value: true}},
    data: {domains: [/\bmelee attack rolls\b/iu.test(plainText(document)) ? "attack.melee" : "attack"], mode: "advantage"}}], notes: []}),
  // 2024 Steam Mephit: "Attack rolls against the steam mephit are made with Disadvantage unless [it] has the Incapacitated
  // condition."
  "blurred-form": () => ({rules: [{schemaVersion: 1, id: "blurred-form", type: "RollMode", predicate: NOT_INCAPACITATED,
    data: {domains: ["attacked"], mode: "disadvantage"}}], notes: []}),
  regeneration: (document, {activities, ...options}) => {
    const activity = activities.find(entry => entry.type === "heal");
    const heal = activity ? convertActivity({document, activity, ...options, notes: []}) : null;
    if ( !heal?.healing?.length ) return null;
    const text = plainText(document);
    // "If the troll takes Acid or Fire damage, this trait doesn't function on its next turn": only the types it names.
    const stopping = text.split(/(?<=\.)\s+/).find(sentence => /\btakes\b/i.test(sentence) && /function/i.test(sentence)) ?? "";
    const stoppedBy = DAMAGE_TYPES.filter(type => new RegExp(`\\b${type}\\b`, "i").test(stopping));
    const predicates = [
      ...(/at least 1 hit point/i.test(text) ? [AT_LEAST_ONE_HIT_POINT] : []),
      // A Vampire's: "if it ... isn't in sunlight".
      ...(/isn't in sunlight|isn’t in sunlight/i.test(text) ? [{not: IN_SUNLIGHT}] : []),
      ...stoppedBy.map(type => ({not: {equals: {path: `actor.flags.wildpath.damageTaken.${type}`, value: true}}}))];
    // "The troll dies only if it starts its turn with 0 Hit Points and doesn't regenerate."
    const deferDeath = /only if it starts its turn with 0 hit points/i.test(text);
    return {rules: [{schemaVersion: 1, id: "regeneration", type: "Trigger", data: {event: "turn.started",
      ...(stoppedBy.length ? {stoppedBy} : {}), ...(deferDeath ? {deferDeath: true} : {}),
      ...(predicates.length ? {predicate: predicates.length > 1 ? {all: predicates} : predicates[0]} : {}),
      action: {...heal, costs: {allOf: []}}}}], consumes: [activity],
      // A Vampire's running water is the GM's to track (maintainer, 2026-10-15).
      notes: []};
  }
});

/**
 * One more attack whenever the creature takes the Attack action: a pool of further attacks, empty until it pays an
 * attack with the Action, emptied at the start of each turn. The pools of Extra Attack and its Fighter upgrades add up.
 */
const fiendishLegacy = type => ({rules: [{schemaVersion: 1, id: "fiendish-legacy-resistance", type: "GrantResistance",
  data: {damageTypes: [type]}}], notes: []});

const extraAttackTrait = () => ({rules: [
  {schemaVersion: 1, id: "extra-attack-pool", type: "GrantResource", data: {resourceId: "extra-attack", label: "Extra Attack",
    maximum: 1, current: 0, recovery: "none", emptiesAtTurnStart: true}},
  {schemaVersion: 1, id: "extra-attack", type: "ExtraAttack", data: {resourceId: "extra-attack"}}], notes: []});

/**
 * Spells whose area is filled with light or darkness, by dnd5e identifier: the light, given the area's size. 2024
 * Daylight: "the sunlight's area is Bright Light and sheds Dim Light for an additional 60 feet"; it ends overlapping
 * Darkness of a spell of level 3 or lower. 2024 Darkness: magical Darkness over its area; it ends overlapping light of a
 * spell of level 2 or lower.
 */
const SHEDS_LIGHT = Object.freeze({
  daylight: size => ({bright: size, dim: size + 60, sunlight: true, dispels: 3}),
  darkness: size => ({bright: size, darkness: true, dispels: 2})
});
/** A creature's or item's own (not a spell's): a Darkmantle's Darkness Aura, which no light illuminates. */
const OWN_LIGHT = Object.freeze({
  "darkness-aura": size => ({bright: size, darkness: true})
});
/** "Alternatively, you cast the spell on an object that isn't being worn or carried": the Token at its center. */
const ON_OBJECT = Object.freeze({id: "on-object", type: "boolean", label: "Cast on an object (the Token at its center)", required: false});
const ROUNDS = Object.freeze({round: 1, minute: 10, hour: 600});

/**
 * "The Sphere is Heavily Obscured", "the area is Difficult Terrain and Heavily Obscured" (2024; dnd5e writes
 * `&Reference[heavilyobscured]`): the area itself. Not fog somewhere in it (Guards and Wards: "corridors, making them").
 */
const HEAVILY_OBSCURED = /\b(?:is|are)\b[^.]{0,60}?\bheavily ?obscured\b/iu;

/**
 * Whether its area is Heavily Obscured from the moment it is made: not when the text says so only for later turns (Storm
 * of Vengeance's "Turns 5-10"). shortcut: an area has no stages; upgrade when lasting areas gain per-round stages.
 */
function obscuredFromCast(document) {
  const text = plainText(document);
  const match = HEAVILY_OBSCURED.exec(text);
  return Boolean(match) && !/\bTurns? \d/u.test(text.slice(0, match.index));
}

/**
 * A spell whose area is all it makes, for its duration: one that sheds light (SHEDS_LIGHT), or a utility spell whose area
 * is Heavily Obscured (2024 Fog Cloud: "The Sphere is Heavily Obscured"), its radius growing with a higher slot. Null when
 * the spell is neither or has no area.
 */
function sheddingArea({document, activity, system, definition, scales={}, spell=true, repeat=null}) {
  const light = (spell ? SHEDS_LIGHT : OWN_LIGHT)[system.identifier] ?? null;
  const obscures = !light && (activity.type === "utility") && obscuredFromCast(document);
  const level = spell ? (Number(system.level) || 0) : 0;
  const {targeting, area, areaPerLevel=0, areaScaling=null} = (light || obscures) ? targetingOf({activity, system, notes: [], level, scales}) : {};
  if ( targeting?.type !== "area" ) return null;
  // An item's or creature's with no duration of its own, the one its text names for the obscurement ("Heavily Obscured for
  // 1 minute": an Ink Cloud). Else none: an Eversmoking Bottle's smoke lasts while it is open, until removed.
  const written = spell ? null : /\bheavily ?obscured\b[^.]{0,40}?\bfor (\d+) (minute|hour)s?\b/iu.exec(plainText(document));
  // A creature's own lasts as its activity says ("maintains Concentration on it, up to 10 minutes").
  const lasting = pick(activity, system, "duration");
  const rounds = (Number(system.duration?.value) || 0) * (ROUNDS[system.duration?.units] ?? 0)
    || (written ? Number(written[1]) * ROUNDS[written[2].toLowerCase()] : 0)
    || ((!spell && light) ? (Number(lasting.value) || 0) * (ROUNDS[lasting.units] ?? 0) : 0);
  const concentration = (system.properties ?? []).includes("concentration") || Boolean(!spell && light && lasting.concentration);
  const configuration = [...(definition.configuration ?? []).filter(choice => choice.id !== "area-scaling")
    .map(choice => ((areaPerLevel && (choice.id === "spell-slot"))
      ? {...choice, effects: [...(choice.effects ?? []), ...levelScaling("spell-slot", level, [], {areaPerLevel})]} : choice)),
  ...(areaScaling ? [scalingChoice(areaScaling)] : [])];
  // Its repeat on a creature that starts or ends its turn in it (Stinking Cloud's Constitution save).
  const turn = (!light && repeat) ? /\b(starts|ends) (?:its|their) turn in\b/iu.exec(plainText(document)) : null;
  const triggers = turn ? [{on: [(turn[1].toLowerCase() === "starts") ? "turn.started" : "turn.ended"], action: repeatAction(definition, document, repeat)}] : [];
  return {...(triggers.length ? {repeated: true} : {}), definition: {targeting, range: rangeOf({activity, system, document, attack: null}),
    configuration: (light && spell) ? [...configuration, {...ON_OBJECT}] : configuration,
    area: {...area, persistence: {
      ...(rounds ? {duration: {unit: "round", value: rounds}} : {}), ...(concentration ? {concentration: true} : {}),
      ...(light ? {light: {...light(area.size.value), spellLevel: level}, ...(spell ? {onObject: ON_OBJECT.id} : {})} : {obscures: "heavily"}),
      ...(triggers.length ? {triggers} : {})}}},
    // Its fog is its area; what else it does with no repeat of its own stays by hand.
    notes: (!light && !triggers.length && (!spell || (Object.keys(system.activities ?? {}).length > 1)))
      ? ["not automated (utility): its area obscures; the rest of its description is by hand"] : []};
}

/** A number choice of how far its user scales an area (1 to `steps`), each step past the first `perStep` feet larger. */
function scalingChoice({perStep, steps}) {
  return {id: "area-scaling", type: "number", label: "Size step", required: true, min: 1, max: steps,
    effects: [{type: "scaleArea", levelChoiceId: "area-scaling", baseLevel: 1, perLevel: perStep}]};
}

/** "A creature also makes this save when it enters the spell's area or ends its turn there": an area's repeat. */
/**
 * A lasting area's repeat dnd5e gives as a save of its own with no activation, beside `activity` (an Action): Stinking
 * Cloud's Start of Turn Save, Wall of Thorns' Traversal Save. Null for none, or several.
 */
function areaRepeat(system, activity) {
  if ( !ACTIVATION_COST[activity?.activation?.type] ) return null;
  const saves = Object.values(system.activities ?? {}).filter(entry => (entry !== activity) && (entry.type === "save")
    && !entry.activation?.type);
  return (saves.length === 1) ? saves[0] : null;
}

/** The trigger Action a lasting area repeats from its own repeat (areaRepeat's, converted), at no cost. */
function repeatAction(definition, document, repeat) {
  return {schemaVersion: 1, id: `${definition.id}:lasting`, label: definition.label ?? document.name, costs: {allOf: []},
    ...(definition.tags ? {tags: definition.tags} : {}), ...(repeat.save ? {save: repeat.save} : {}),
    ...(repeat.damage?.length ? {damage: repeat.damage} : {}),
    ...(repeat.effects?.length ? {effects: repeat.effects.map(({concentration: _held, ...effect}) => effect)} : {})};
}

const LASTING_WORDING = /[^.]*\b(?:enters?|moves? into)\b[^.]*?\b(starts|ends) (?:its|their) turn\b/iu;
/** A lasting area's later damage as an unnamed passive activity with no save (Wall of Fire's): the repeat's, unsaved. */
const unsavedRepeat = system => Object.values(system.activities ?? {}).find(entry => (entry.type === "damage") && !entry.name
  && !entry.activation?.type && !entry.save?.ability) ?? null;

/**
 * An area that keeps acting while it lasts, by its 2024 wording ("A creature also makes this save when it enters the
 * spell's area or ends its turn there": Moonbeam, Web, Cloudkill, Wall of Fire): a lasting area whose trigger repeats
 * the save, damage and effects on a creature that enters it, or starts or ends its turn there. The engine affects a
 * creature once per turn. Null for an area without that wording, or with nothing to repeat. Its damage keeps the ids of
 * the Action's own, so a higher slot's dice reach the repeat too (action-configuration.mjs `applyScaleDamageEffect`).
 */
export function lastingArea({document, system, definition, activity=null, repeat=null}) {
  if ( (definition.targeting?.type !== "area") || !definition.area || definition.area.persistence ) return null;
  // An area that is Difficult Terrain lasts for that alone (Spike Growth, Entangle).
  const terrain = difficultTerrainOf(document, activity);
  // One that is Heavily Obscured (Cloudkill, Sleet Storm) hides those in it while it lasts.
  const obscures = obscuredFromCast(document);
  if ( !(definition.damage?.length || definition.effects?.length || terrain) ) return null;
  const wording = LASTING_WORDING.exec(plainText(document));
  const rounds = (Number(system.duration?.value) || 0) * (ROUNDS[system.duration?.units] ?? 0);
  // Something with no duration of its own (a flask of Oil; Ice Storm's terrain "until the end of your next turn") is not
  // a lasting area. shortcut: Ice Storm's Difficult Terrain is by hand.
  if ( !(wording || terrain) || !rounds ) return null;
  // The repeat is the same save and outcome on one creature; the area itself holds the concentration.
  // Its damage with no save of its own (2024 Wall of Fire: "A creature takes the same damage when it enters the wall").
  const unsaved = Boolean(unsavedRepeat(system));
  // A repeat of its own (Wall of Thorns' Traversal Save: Slashing, where its creation is Piercing) is the repeat.
  const action = repeat ? repeatAction(definition, document, repeat) : {schemaVersion: 1, id: `${definition.id}:lasting`,
    label: definition.label ?? document.name, costs: {allOf: []},
    ...(definition.tags ? {tags: definition.tags} : {}), ...((definition.save && !unsaved) ? {save: definition.save} : {}),
    ...(definition.damage?.length ? {damage: unsaved ? definition.damage.map(({saveOutcomePolicy: _saved, ...part}) => part)
      : definition.damage} : {}),
    ...(definition.effects?.length ? {effects: definition.effects.map(({concentration: _held, ...effect}) => effect)} : {})};
  // "enters it for the first time on a turn or starts its turn there", and nothing when it appears (2024 Sleet Storm, Web,
  // Zone of Truth): one already in it saves as its turn starts, so the casting itself affects nobody.
  const castActs = Boolean(repeat) || !wording || (wording[1].toLowerCase() !== "starts") || /\balso\b/iu.test(wording[0])
    || /\b(?:appears|when you cast)\b/iu.test(plainText(document));
  const {save: _save, damage: _damage, effects: _effects, ...cast} = definition;
  return {...(castActs ? definition : cast), area: {...definition.area, persistence: {duration: {unit: "round", value: rounds},
    concentration: (system.properties ?? []).includes("concentration"),
    // "Whenever an enemy you can see enters", or "you can designate creatures to be unaffected" (Spirit Guardians): its
    // caster's side is spared. shortcut: the designated creatures are always the caster's allies.
    ...((/\benem(?:y|ies)\b/iu.test(wording?.[0] ?? "") || /designate creatures to be unaffected/iu.test(plainText(document)))
      ? {affects: "enemies"} : {}),
    ...(terrain ? {difficultTerrain: terrain} : {}), ...(obscures ? {obscures: "heavily"} : {}),
    triggers: wording ? [{on: ["area.entered", wording[1].toLowerCase() === "starts" ? "turn.started" : "turn.ended"], action}] : []}}};
}

/** "Its space is Difficult Terrain", "turns it into Difficult Terrain" (2024 Grease, Blade Barrier, Earthquake). */
const DIFFICULT_TEXT = /\b(?:is|are|becomes?|into)\s+(?:&(?:amp;)?Reference\[difficult ?terrain[^\]]*\]|Difficult Terrain\b)/iu;

/** The Difficult Terrain an area makes: dnd5e's region behavior on its activity (Web's `web`), else its text's; or null. */
function difficultTerrainOf(document, activity) {
  const behaviors = (activity?.behaviors ?? []).filter(behavior => behavior?.type === "difficultTerrain");
  if ( behaviors.length ) return {types: [...new Set(behaviors.flatMap(behavior => behavior.config?.types ?? []))]};
  // Not one its caster only may make ("you can turn ordinary terrain ... into Difficult Terrain": Speak with Plants).
  const sentence = plainText(document).split(/(?<=\.)\s/u).find(text => DIFFICULT_TEXT.test(text));
  return (sentence && !/\bcan\b/iu.test(sentence)) ? {types: []} : null;
}

/**
 * The Action that moves a lasting area its 2024 text lets its caster move ("you can take a Magic action on later turns
 * to move the Cylinder up to 60 feet", Moonbeam): that action's cost and `moveArea {of, distance}`. Null otherwise.
 */
export function moveAreaDefinition(document, definition) {
  if ( !definition?.area?.persistence ) return null;
  const wording = /\byou can take an? (Magic|Bonus) action\b[^.]*?\bto move the \w+(?: \w+)? up to (\d+) feet/iu.exec(plainText(document));
  if ( !wording ) return null;
  const capability = wording[1].toLowerCase() === "bonus" ? "bonus-action" : "action";
  return {schemaVersion: 1, id: `${definition.id}:move`, costs: {allOf: [{capability, amount: 1}]}, targeting: {type: "none"},
    moveArea: {of: definition.id, distance: Number(wording[2])}};
}

/** A feature's description as plain text, one space between words. */
const plainText = document => String(document.system?.description?.value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/**
 * Effects that only remind the table of what a creature can sense, say or seem (Detect Magic, Zone of Truth's "Cannot
 * Lie", Disguise Self): the marker on its creature, for its duration and concentration, is all there is to automate.
 */
const NARRATIVE_MARKERS = new Set(["Detect Magic", "Detect Evil and Good", "Detect Poison and Disease", "Disguised", "Cannot Lie",
  "Water Breathing", "Water Walking", "Speaking with Plants", "Speaking with Animals", "Carrying Message", "Altered Appearance",
  "Hidden from Divination", "Comprehending Languages", "Tongues", "Telepathic Bond", "Scrying",
  // Mind Spike: "you always know the target's location"; Calm Emotions' indifference; Jump's 30-foot jumps.
  "Spiked", "Indifference", "Jump",
  // Arcanist's Magic Aura's "Masked"; telepathy and speech only.
  "Masked", "Psychic Whispers", "Telepathically Linked", "Universal Speech",
  // Levitate's hovering (heights are not tracked), Divine Sense, a cloak's water breathing, a changed look, a ring's sight.
  "Levitating", "Divine Sense", "Water Breather", "Changed Appearance", "X-Ray Vision",
  // An Animated Shield hovering (hands are not tracked; its AC counts while equipped), Arcane Hand's Interposing Hand
  // (its Half Cover is the other option), a Fan token's wind (a ship's travel speed is not a rule), and Alter Self's
  // chosen Natural Weapons (their attacks are Actions of their own). Not Phantasmal Force's "Seeing Illusions": its
  // phantasm's damage each turn is by hand, noted on the marker.
  "Animated Shield", "Interposed", "Feather Token: Fan", "Natural Weapon"]);

/**
 * Activities that only tell the table something, by their dnd5e name: Scrying's sensor, a revival or re-forming days
 * later (a Lemure, a Lich). Not counting a Bag of Beans' beans: its 3d4 is the bag's starting count (its pool starts full,
 * at 12), a gap.
 */
const NARRATIVE_ACTIVITIES = new Set(["Create Sensor", "Revive: Days", "Days to Reform", "Determine Number of Pots",
  "Count Number of Cards",
  // An Iron Flask's trapped creature: whatever it holds, which the GM keeps track of.
  "Add Trapped Creature", "Release Creature",
  // Rolling a necklace's starting beads; a rope's own Hit Points and an Immovable Rod's shifting (objects are not modelled);
  // a bean planted (the GM's table a minute later) and a Jester's two more cards.
  "Determine Number of Beads", "Damage Rope", "Repair Rope", "Attempt to Move", "Plant Bean", "Card Effect: Draw Two",
  // Ending a turn inside an object (the Scene has no object volumes), looking years older, a vampire's rest once its mist
  // reaches its coffin (hours later), a wight's zombie a day later.
  "Self Damage", "Years Older", "Paralyzed", "Zombie Rises",
  // An Aboleth's new body days later; a broom flown off alone; commanding or keeping control of what a spell made (its
  // creatures' controller moves and acts with them); Prismatic Spray's violet ray (another plane: it leaves the Scene).
  "Days: New Body", "Send Alone or Recall", "Mentally Command", "Reassert Control", "Move Lights", "Violet Save (Wis)",
  // An Energy Bow's climbable ladder (climbing is not modelled); a Faithful Hound moved by its summoner (its controller moves it).
  "Energy Ladder", "Move Hound"]);

/**
 * Items and spells whose use only lights or starts something else (a Tinderbox lights a Torch, whose own Action sheds its
 * light), or whose effect is the table's to describe (Prestidigitation, Mending, a Portable Hole, reading thoughts).
 */
const NARRATIVE_USES = new Set(["tinderbox", "prestidigitation", "mending", "illusory-script", "rope-trick", "find-traps", "creation",
  "demiplane", "mirage-arcane", "hallucinatory-terrain", "private-sanctum", "control-water", "create-or-destroy-water",
  "decanter-of-endless-water", "boat-utility", "swan-boat-feather-token", "portable-hole", "rope-of-climbing", "instant-fortress",
  "immovable-rod", "instant-summons", "dust-of-dryness", "detect-thoughts", "helm-of-telepathy", "medallion-of-thoughts",
  "mind-reading-crystal-ball-of", "gaze-of-two-minds", "whispers-of-the-grave", "word-of-recall", "awaken", "divine-intervention",
  "gift-of-the-protectors", "true-resurrection", "apparatus-of-the-crab",
  // Breaking an object (objects have no Hit Points here); a demiplane off the Scene; an alarm; the nearest foe's direction.
  "ring-of-the-ram", "rod-of-security", "shriek", "wand-of-enemy-detection"]);

/**
 * Features whose casts dnd5e pays with a spell slot though its caster has one that needs none (Investment of the Chain
 * Master's Find Familiar, cast through Pact of the Chain "without expending a spell slot").
 */
const SLOTLESS = new Set(["investment-of-the-chain-master"]);

/** What makes a creature at 0 Hit Points Stable when it touches it (`stabilize`). */
const STABILIZES = new Set(["spare-the-dying", "healers-kit"]);

/** Words of a game rule in a use's text: one without any is narrative (its cost spent is all there is). */
const MECHANICAL_TEXT = /\b(damage|saving throw|save\b|DC \d|Advantage|Disadvantage|attack roll|Hit Points?|Armor Class|\bAC\b|Speed|Blinded|Charmed|Deafened|Frightened|Grappled|Incapacitated|Invisible|Paralyzed|Petrified|Poisoned|Prone|Restrained|Stunned|Unconscious|Exhaustion|Resistance|Immunity|teleport|Bright Light|Dim Light|ability check|bonus|darkvision|blindsight|tremorsense|truesight|difficult terrain|reaction|Bonus Action|extra attack|spell slot)/i;

/**
 * The push or pull (G6) its text gives an Action that hits or forces a save: "pushed up to 10 feet (straight) away
 * from you", "pulls the target up to 30 feet straight toward itself", with any limit ("If the target is a Large or
 * smaller creature"). A push in its "Success:" text is on a success (the Bulette's Deadly Leap). Text that pushes or
 * pulls by more than one distance or way, or toward something else (a whirlpool), is left to the GM.
 */
function forcedMovement(document, definition) {
  if ( !definition.attack && !definition.save ) return null;
  const text = plainText(document);
  const found = [...text.matchAll(/\b(?:push|pull)(?:s|es|ed)?(?: the target| it| the creature)? (?:up to )?(\d+) feet (?:straight )?(away from|toward (?:itself|you)\b)/gi)];
  if ( new Set(found.map(([, feet, way]) => `${feet}:${way.toLowerCase()}`)).size !== 1 ) return null;
  const [, feet, way] = found[0];
  const size = text.match(/\bif the target is an? (tiny|small|medium|large|huge|gargantuan) or smaller creature/i)?.[1].toLowerCase();
  const outcome = [...text.slice(0, found[0].index).matchAll(/\b(Failure or Success|Failure|Success|On a failed save|On a successful save)\b/gi)]
    .at(-1)?.[1].toLowerCase();
  return {distance: Number(feet), ...(way.toLowerCase().startsWith("toward") ? {toward: true} : {}), ...(size ? {maxSize: size} : {}),
    ...((definition.save && ["success", "on a successful save"].includes(outcome)) ? {on: "success"} : {})};
}

/** A spell's damage at the end of its target's next turn (Acid Arrow's "Lingering Acid Damage"). */
const LATER_ACID = /^(?:Lingering Acid Damage|End of Turn Damage)$/;

/** Its Lingering Acid effect, dealing its spell's own later damage: Vitriolic Sphere's 5d4, Acid Arrow's 2d4. */
function lingeringAcid(document) {
  const later = Object.values(document.system?.activities ?? {}).find(entry => (entry.type === "damage") && LATER_ACID.test(entry.name ?? ""));
  const [count, faces] = [number(later?.damage?.parts?.[0]?.number), number(later?.damage?.parts?.[0]?.denomination)];
  const acid = structuredClone(EFFECTS_BY_NAME["Lingering Acid"]);
  if ( count && faces ) acid.ruleElements[0].data.action.damage[0].expression = dice(count, faces);
  return acid;
}

/**
 * A stat block's damage activity dnd5e fires at the start of the target's turn (`turnStart`: a Pit Fiend's "Bite (Add'l
 * Poison Damage)") beside a save that gives a condition: it belongs to that condition's effect (turnStartDamageEffects).
 * So does one dnd5e leaves without an activation whose text deals it "at the start of each of its turns" (a Kraken's
 * swallowed creature, a Shambling Mound's engulfed one).
 */
function turnStartDamage(document, activity) {
  const activation = activity?.activation?.type ?? "";
  return (activity?.type === "damage")
    && ((activation === "turnStart") || (!activation && /\bat the start of each of its turns\b/iu.test(plainText(document))))
    && Object.values(document.system?.activities ?? {}).some(entry => (entry.type === "save") && ((entry.effects ?? []).length
      // A save with nothing but how long it lasts (a Bearded Devil's infernal wound, 1 minute): its marker carries it.
      || (!(entry.damage?.parts ?? []).length && lastingDuration(entry.duration))));
}

/**
 * Its turn-start damage as an effect beside the save's first condition (`effects`, as converted): while the creature has
 * that condition, the damage at the start of each of its turns (an automation Trigger, as Lingering Acid's), lasting as
 * long and applied on the same outcome. `slotted`: its Action has a spell-slot choice, whose slot its damage grows with.
 */
function turnStartDamageEffects(document, effects, {spell, scales, notes, slotted}) {
  const carrier = effects.find(effect => effect.type === "condition");
  if ( !carrier ) return [];
  return turnStartDamageRules(document, {spell, scales, notes, slotted, predicate: {hasCondition: carrier.conditionId}}).map((rule, index) => ({
    id: `effect-${effects.length + index + 1}`, type: "effect", name: `${document.name} (start of turn)`, slug: rule.id,
    img: "icons/svg/poison.svg", ...(carrier.saveOutcomePolicy ? {saveOutcomePolicy: carrier.saveOutcomePolicy} : {}),
    ...(carrier.duration ? {duration: structuredClone(carrier.duration)} : {}), ruleElements: [rule]}));
}

/**
 * Its damage at the start of each of its creature's turns (turnStartDamage) as automation Triggers, while `predicate`
 * holds (its condition), else while the effect carrying them lasts. Damage of no type ("loses 5 (1d10) Hit Points") is
 * untyped. With `slotted` (a spell-slot choice), damage that grows with a higher slot is a table on it (slotGrowth:
 * Ensnaring Strike's 1d6 more per level).
 */
function turnStartDamageRules(document, {spell, scales, notes, slotted=false, predicate=null}) {
  return Object.values(document.system?.activities ?? {}).filter(activity => turnStartDamage(document, activity)).map((activity, index) => {
    let byHand = false;
    const damage = (activity.damage?.parts ?? []).map((part, at) => {
      const expression = partExpression(part, {spell, ability: null, scales, notes, label: activity.name ?? "damage"});
      const grown = expression ? slotGrowth(expression, part, {spell, level: document.system?.level}) : null;
      if ( grown && !(slotted && grown.expression) ) byHand = true;
      return {id: `turn-${at + 1}`, expression: (slotted && grown?.expression) || expression,
        ...(part.types?.length === 1 ? {damageType: part.types[0]} : (part.types?.length ? {} : {damageType: "untyped"})), provenance: "additional"};
    }).filter(component => component.expression);
    if ( !damage.length ) return null;
    if ( byHand ) notes.push(`"${activity.name ?? "damage"}": its damage at the start of each turn doesn't grow with a higher spell slot (by hand)`);
    const slug = `${slugify(document.name)}-turn-damage${index ? `-${index + 1}` : ""}`;
    return {schemaVersion: 1, id: slug, type: "Trigger", data: {kind: "automation", event: "turn.started", ...(predicate ? {predicate} : {}),
      action: {schemaVersion: 1, id: `action:${slug}`, label: document.name, costs: {allOf: []}, damage}}};
  }).filter(Boolean);
}

/** A DC dnd5e leaves unset (no calculation, no formula) that its text states once: a 2014 stat block's "DC 21". */
function textDC(document, dc) {
  if ( dc.calculation || dc.formula ) return null;
  const values = [...new Set([...plainText(document).matchAll(/\bDC (\d+)\b/g)].map(match => Number(match[1])))];
  return (values.length === 1) ? {value: values[0]} : null;
}

/** The creature stands in sunlight: its Scene is tagged sunlit, or a light tagged as sunlight reaches it. */
const IN_SUNLIGHT = Object.freeze({equals: {path: "inSunlight", value: true}});
// "if you have at least 1 Hit Point" (Regeneration, a Ring of Regeneration).
const AT_LEAST_ONE_HIT_POINT = Object.freeze({not: {equals: {path: "actor.system.resources.health.value", value: 0}}});

/** Disadvantage in sunlight on the rolls its text names, and its damage there at the start of its turn. */
function sunlightTrait(document, {activities, ...options}) {
  const text = plainText(document);
  const domains = /d20 tests/i.test(text) ? ["attack", "check", "save"] : [
    ...(/attack rolls/i.test(text) ? ["attack"] : []),
    ...(/ability checks/i.test(text) ? ["check"] : (/perception/i.test(text) ? ["check.perception"] : [])),
    ...(/saving throws/i.test(text) ? ["save"] : [])];
  if ( !domains.length ) return null;
  const rules = [{schemaVersion: 1, id: "sunlight", type: "RollMode", predicate: IN_SUNLIGHT, data: {domains, mode: "disadvantage"}}];
  const damages = activities.filter(entry => entry.type === "damage");
  const activity = damages.find(entry => /sunlight/i.test(entry.name ?? "")) ?? ((damages.length === 1) ? damages[0] : null);
  const burn = activity ? convertActivity({document, activity, ...options, notes: []}) : null;
  if ( burn?.damage?.length ) rules.push({schemaVersion: 1, id: "sunlight-damage", type: "Trigger", data: {event: "turn.started",
    predicate: IN_SUNLIGHT, action: {...burn, costs: {allOf: []}}}});
  return {rules, consumes: burn?.damage?.length ? [activity] : [], notes: damages.filter(entry => entry !== activity)
    .map(entry => `"${entry.name || entry.type}" is passive or triggered: not automated`)};
}

/** Its creature is a Fiend or an Undead (`actor`: the one whose Trigger it is). */
const FIEND_OR_UNDEAD = Object.freeze({oneOf: {path: "actor.system.details.type", values: ["fiend", "undead"]}});

/**
 * The damage activity `name` its holder takes each time it ends its turn while `predicate` holds (a Talisman of Pure
 * Good's on a Fiend or an Undead): an automation Trigger on its gear, which counts only while equipped. shortcut: the
 * damage of first touching it is by hand.
 */
function heldTurnEndDamage(document, {activities, ...options}, name, predicate) {
  const activity = activities.find(entry => entry.name === name);
  const burn = activity ? convertActivity({document, activity, ...options, notes: []}) : null;
  if ( !burn?.damage?.length ) return null;
  return {rules: [{schemaVersion: 1, id: `${identifierOf(document)}-held`, type: "Trigger", data: {event: "turn.ended",
    predicate: structuredClone(predicate), action: {...burn, costs: {allOf: []}, range: {type: "self"}, targeting: {type: "self"}}}}],
  consumes: [activity], notes: []};
}

/** Not Incapacitated: none of the conditions that include it. */
const NOT_INCAPACITATED = Object.freeze({not: {any: ["incapacitated", "stunned", "paralyzed", "petrified", "unconscious", "dead"]
  .map(condition => ({hasCondition: condition}))}});
/** Sneak Attack's terms: a Finesse or Ranged weapon, and Advantage, or an ally beside the target and no Disadvantage. */
const SNEAK_ATTACK = Object.freeze({all: [
  {tagsAny: ["finesse", "ranged"]},
  {any: [{equals: {path: "attack.rollMode", value: "advantage"}}, {all: [{equals: {path: "attack.allyNearTarget", value: true}},
    {not: {equals: {path: "attack.rollMode", value: "disadvantage"}}}]}]}]});

/**
 * Spell effects dnd5e leaves without changes, given their 2024 rules by hand (by the spell's identifier). Only those
 * the engine expresses exactly; the rest stay the GM's.
 */
/** A mark's extra damage: 1d6 on each attack its own caster hits it with (`attack.fromAttacker`: marks it bears from them). */
const markDamage = (slug, damageType, faces=6, expression=null) => ({schemaVersion: 1, id: `${slug}-damage`, type: "ExtraDamage",
  data: {domains: ["attacked"], expression: expression ?? {type: "dice", number: 1, faces}, damageType},
  predicate: {equals: {path: `attack.fromAttacker.${slug}`, value: true}}});

const EFFECTS_BY_HAND = Object.freeze({
  // "Any attack roll against an affected creature or object has Advantage if the attacker can see it."
  "faerie-fire": {ruleElements: [{schemaVersion: 1, id: "faerie-fire", type: "RollMode", data: {domains: ["attacked"], mode: "advantage"}}]},
  // 2024 Innate Sorcery: Advantage on the attack rolls of its creature's spells while it lasts (dnd5e's effect has only the
  // +1 save DC). shortcut: any spell, not only Sorcerer spells.
  "innate-sorcery": {extraRules: [{schemaVersion: 1, id: "innate-sorcery-attacks", type: "RollMode", predicate: {tagsAny: ["spell"]},
    data: {domains: ["attack"], mode: "advantage"}}]},
  // An Oathbow's sworn enemy: its own mark (slug), which its wielder's Oathbow rules read (ENCHANT_TEXT_RULES). shortcut:
  // "until it dies or until dawn 7 days later": it lasts until removed.
  "oathbow/Swear Oath": {slug: "sworn-enemy", ruleElements: []},
  // "Any creature has Disadvantage on attack rolls against you."
  "blur": {ruleElements: [{schemaVersion: 1, id: "blur", type: "RollMode", data: {domains: ["attacked"], mode: "disadvantage"}}]},
  // "It has Disadvantage on the next attack roll it makes before the end of its next turn."
  // shortcut: it lasts until the end of the caster's next turn, not the target's; its next attack ends it either way.
  "vicious-mockery": {endsWhen: "attacks", duration: {value: 1, units: "rounds", expiry: "turnEnd"},
    ruleElements: [{schemaVersion: 1, id: "vicious-mockery", type: "RollMode", data: {domains: ["attack"], mode: "disadvantage"}}]},
  // "You deal an extra 1d6 Force damage to the target whenever you hit it with an attack roll." The mark is its own
  // effect (slug), so only its caster's attacks see it. Its die: HUNTERS_MARK_DIE.
  "hunters-mark": {slug: "hunters-mark", bonusDamage: "Bonus Mark Damage", ruleElements: [markDamage("hunters-mark", "force", 6,
    structuredClone(HUNTERS_MARK_DIE))]},
  // A Stars druid's form is the `starry-form` status (Full of Stars reads it).
  "starry-form": {slug: "starry-form"},
  // Rage's effect is the `raging` status (Frenzy reads it).
  "rage": {slug: "raging"},
  // Hex: the same, Necrotic, and Disadvantage on checks of one ability the caster chooses (its six effects, one kept).
  // Its check rules apply to saves of that ability too while its creature bears Eldritch Hex's marker (`savesToo`).
  "hex": {slug: "hex", bonusDamage: "Bonus Hex Damage", extraRules: [markDamage("hex", "necrotic")], chooseOne: "Ability",
    savesToo: {hasCondition: "hex-saves"}},
  // Bestow Curse, by activity: "Disadvantage on attack rolls against you" (its caster: the curse's source) ...
  "bestow-curse/Curse Attacks": {slug: "cursed-attacks", ruleElements: [{schemaVersion: 1, id: "cursed-attacks", type: "RollMode",
    data: {domains: ["attack"], mode: "disadvantage"}, predicate: {equals: {path: "attack.fromTarget.cursed-attacks", value: true}}}]},
  // ... and "an extra 1d8 Necrotic damage" when its caster hits it. shortcut: its caster's spells add none; upgrade when
  // spell damage reads `attacked`-style rules.
  "bestow-curse/Curse Resilience": {slug: "cursed-resilience", ruleElements: [markDamage("cursed-resilience", "necrotic", 8)]}
});

/** What an activity's own row in EFFECTS_BY_HAND is (Bestow Curse's Curse Attacks), else its document's. */
const effectsByHand = (document, activity) => EFFECTS_BY_HAND[`${identifierOf(document)}/${activity?.name}`]
  ?? EFFECTS_BY_HAND[identifierOf(document)] ?? null;

/**
 * One command until the end of its next turn (2024 Command): its creature's marker (its status `slug`), with what it
 * enforces: caps on its turn's resources, and the movement and Actions its status allows.
 */
const commanded = (name, rules=[], slug=null) => ({type: "effect", name: `Commanded: ${name}`, ...(slug ? {slug} : {}),
  ruleElements: rules, duration: {value: 1, units: "rounds", expiry: "turnEnd"}});
const turnCap = (id, resources) => ({schemaVersion: 1, id, type: "ResourceCap", data: {resources, maximum: 0}});

/**
 * Options an Action's effect is chosen from when it is used, by its 2024 text (Command's five commands). Each option is
 * one or more effects; a failed save applies the one chosen:
 * - Approach: it moves toward its commander, and can't move away (`commanded-approach`) or take an action.
 * - Drop: it drops what it holds when its turn starts (documents/actor.mjs) and ends its turn.
 * - Flee: it moves away (`commanded-flee`: it can't move closer), with only Dash or Disengage as its action.
 * - Grovel: Prone, and its turn ends. Halt: it doesn't move or take an action or Bonus Action.
 */
const CHOICES_BY_HAND = Object.freeze({
  command: {chooseOne: "Command", options: [
    {label: "Approach", effects: [commanded("Approach", [turnCap("approach", ["action", "bonus"])], "commanded-approach")]},
    {label: "Drop", effects: [commanded("Drop", [turnCap("drop", ["movement", "action", "bonus"])], "commanded-drop")]},
    {label: "Flee", effects: [commanded("Flee", [], "commanded-flee")]},
    {label: "Grovel", effects: [{type: "condition", conditionId: "prone"}, commanded("Grovel", [turnCap("grovel", ["movement", "action", "bonus"])])]},
    {label: "Halt", effects: [commanded("Halt", [turnCap("halt", ["movement", "action", "bonus"])])]}
  ]}
});

/**
 * Conditions a spell or feature ends, by its 2024 text (dnd5e leaves them to the description): one removal each
 * (`levels: -1`, so Exhaustion loses one level). `chooseOne` makes them a choice; `activity` limits it to one activity.
 */
const REMOVALS = Object.freeze({
  "lesser-restoration": {conditions: ["blinded", "deafened", "paralyzed", "poisoned"], chooseOne: "Condition"},
  "greater-restoration": {conditions: ["exhaustion", "charmed", "petrified"], chooseOne: "Condition"},
  "heal": {conditions: ["blinded", "deafened", "poisoned"]},
  "power-word-heal": {conditions: ["charmed", "frightened", "paralyzed", "poisoned", "stunned"]},
  "protection-from-poison": {conditions: ["poisoned"]},
  "lay-on-hands": {conditions: ["poisoned"], activity: "Remove Poison"},
  // shortcut: only a Celestial's, Elemental's, Fey's, Fiend's or Undead's Charmed or Frightened ends, and its spell with
  // it, and possession ends too: by hand; upgrade when a condition records the kind of creature that gave it.
  "dispel-evil-and-good": {conditions: ["charmed", "frightened"], activity: "Break Enchantment"},
  // Its magical contagions end too (ENDS).
  "elixir-of-health": {conditions: ["blinded", "deafened", "paralyzed", "poisoned"]}
});

/** A dnd5e document's identifier, else its name as a slug. */
const identifierOf = document => document?.system?.identifier || slugify(String(document?.name ?? ""));

/** The 2024 damage types, as a text names them. */
const DAMAGE_TYPES = Object.freeze(["acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison",
  "psychic", "radiant", "slashing", "thunder"]);

/** The common trait `document` is, by its dnd5e identifier or its name, as rules; null when it is none of them. */
function traitOf(document, options) {
  const key = document.system?.identifier || slugify(String(document.name ?? "").replace(/\s*\(.*\)\s*$/, ""));
  return Object.hasOwn(TRAITS, key) ? TRAITS[key](document, options) : null;
}

/**
 * The spells a Spellcasting feature's list links that dnd5e gives no cast activity (2024 Adult Brass Dragon's Scorching
 * Ray), as cast activities like its others, at their list's frequency ("At Will:", "1/Day Each:"). None for a document
 * with no cast activity. A listed cast dnd5e leaves without its list's uses (2024 Adult Silver Dragon's Zone of Truth,
 * "1/Day Each:") is given them in `activities`.
 */
function missingCasts(document, activities) {
  const casts = activities.filter(activity => activity.type === "cast");
  if ( !casts.length ) return [];
  const cast = new Set(casts.map(activity => String(activity.spell?.uuid ?? "").split(".").pop()));
  const added = [];
  for ( const paragraph of String(document.system?.description?.value ?? "").split(/<\/p>/i) ) {
    const heading = /<strong>\s*(At Will|(\d+)\/Day(?: Each)?)\s*:\s*<\/strong>/i.exec(paragraph);
    if ( !heading ) continue;
    const perDay = number(heading[2]);
    const listed = like => ({consumption: {...(like.consumption ?? {}), targets: perDay ? [{type: "activityUses", value: "1"}] : []},
      uses: perDay ? {spent: 0, max: String(perDay), recovery: [{period: "day", type: "recoverAll"}]} : {spent: 0, max: "", recovery: []}});
    for ( const [, uuid, id] of paragraph.matchAll(/@UUID\[(Compendium\.dnd5e\.spells\w*\.Item\.(\w+))\]/g) ) {
      const at = activities.findIndex(activity => (activity.type === "cast") && (String(activity.spell?.uuid ?? "").split(".").pop() === id));
      const free = activities[at];
      if ( free && perDay && !number(free.uses?.max) && !(free.consumption?.targets ?? []).length ) activities[at] = {...free, ...listed(free)};
      if ( cast.has(id) ) continue;
      cast.add(id);
      added.push({...structuredClone(casts[0]), _id: id, name: "", sort: (casts.at(-1).sort ?? 0) + added.length + 1,
        spell: {...(casts[0].spell?.ability ? {ability: casts[0].spell.ability} : {}), uuid},
        ...listed(casts[0])});
    }
  }
  return added;
}

/** "You teleport to a location within range" (2024 Dimension Door), "You teleport yourself ... to any other spot within range". */
const TELEPORTS_WITHIN_RANGE = /\bYou teleport (?:yourself )?(?:from your current location )?to (?:a location|any other spot|an unoccupied space)\b[^.]*?\bwithin range\b/iu;

/**
 * A spell that teleports its caster within its range but whose data has no teleport activity (the Player's Handbook
 * module's Dimension Door, from before dnd5e had one, holds only its failed arrival's damage): that teleport, first, as the
 * SRD's newer data gives it.
 */
function missingTeleport(document, activities) {
  const range = document.system?.range ?? {};
  if ( (document.type !== "spell") || activities.some(activity => activity.type === "teleport") || (range.units !== "ft")
    || !(number(range.value) > 0) || !TELEPORTS_WITHIN_RANGE.test(plainText(document)) ) return [];
  return [{_id: "missingteleport0", type: "teleport", name: "", sort: Math.min(0, ...activities.map(activity => activity.sort ?? 0)) - 1,
    activation: {override: false}, range: {override: false}, target: {override: false, template: {}, affects: {}}, effects: [],
    consumption: {targets: [], spellSlot: true}, teleport: {value: range.value, units: "ft"}}];
}

/**
 * 2014 spells a 2024 item still casts by their old compendium id, as their 2024 SRD id (a Rod of Alertness's Detect Evil
 * and Good).
 */
const LEGACY_SPELLS = Object.freeze({Mzh95utKDPIrjiH8: "phbsplDetectEvil"});

/**
 * The 2024 spell among `spells` with `name` (slugified: "protection from evil and good"), or null: what a 2014
 * document's spell is now (a Tasha's item's cast link, a 2014 stat block's copy), the choice LEGACY_SPELLS takes. The SRD
 * drops a spell's wizard ("Tasha’s Hideous Laughter" is Hideous Laughter), so a name not found is tried without one.
 */
const spellIndexes = new WeakMap();
function spell2024Named(spells, name) {
  if ( !spells || !name ) return null;
  if ( !spellIndexes.has(spells) ) spellIndexes.set(spells, Object.fromEntries(Object.values(spells)
    .filter(spell => spell.system?.source?.rules === "2024").map(spell => [slugify(spell.name), spell])));
  const index = spellIndexes.get(spells);
  return index[slugify(name)] ?? index[slugify(name.replace(/^\S+['’]s\s+/u, ""))] ?? null;
}

/**
 * A 2014 stat block's copy of a spell (no activities) as the 2024 spell of its name, cast as the copy is: its name, its
 * preparation (so a slot, or none at will or innate) and its uses a day, which each slot-spending activity spends.
 * The copy itself when there is no such 2024 spell; a restricted copy ("Invisibility (Self Only)") names none, so it
 * stays as it was rather than lose its restriction.
 */
function modernSpellCopy(copy, spells) {
  const spell = ((copy.type === "spell") && !copy.system?.activities) ? spell2024Named(spells, copy.name) : null;
  if ( !spell ) return copy;
  const uses = upgradeLegacy(copy).system?.uses ?? {};
  const activities = Object.fromEntries(Object.entries(spell.system.activities ?? {}).map(([id, activity]) => [id,
    (uses.max && (activity.consumption?.spellSlot !== false)) ? {...activity, consumption: {...activity.consumption,
      targets: [...(activity.consumption?.targets ?? []), {type: "itemUses", value: "1"}]}} : activity]));
  return {...spell, _id: copy._id, name: copy.name, system: {...spell.system, preparation: copy.system.preparation, uses, activities}};
}

/**
 * 2014 class features (dnd5e's classfeatures pack) whose uses a Tasha's option spends, as the 2024 feature that is
 * that pool now (Ki is Monk's Focus).
 */
const LEGACY_FEATURES = Object.freeze({"10b6z2W1txNkrGP7": "Monk's Focus", LBKChJY5n02Afhnq: "Font of Magic",
  "8M7uOPhbTxoxxJSo": "Channel Divinity", YpiLQEKGalROn7iJ: "Channel Divinity", swK0r5TOIxredxWS: "Wild Shape",
  hpLNiGq7y67d2EHA: "Bardic Inspiration"});

/** The name of the feature a dnd5e consumption target names (`feat:<identifier>` or a uuid), or null. */
function targetName(target, names) {
  const id = String(target).split(".").pop();
  return names[target] ?? names[id] ?? LEGACY_FEATURES[id] ?? null;
}

/**
 * A cast activity (a monster's Spellcasting, an item's spell) as its spell's Action: the spell converted with the
 * creature's own save DC and casting ability, at the activity's cost and uses, with no spell slot. Null when the
 * spell is not among `spells`, so the activity stays a manual Action.
 */
function castSpell({document, activity, system, notes, pool: itemPool=null, options}) {
  const linked = String(activity.spell?.uuid ?? "").split(".").pop();
  // A 2014 link (Compendium.dnd5e.spells) is the 2024 spell its label names ("@UUID[...Item.<id>]{sanctuary}").
  const label = linked && new RegExp(`@UUID\\[[^\\]]*\\.Item\\.${linked}\\]\\{([^}]+)\\}`).exec(String(document.system?.description?.value ?? ""))?.[1];
  const spellDocument = options.spells?.[LEGACY_SPELLS[linked] ?? linked] ?? spell2024Named(options.spells, label);
  if ( !spellDocument ) {
    notes.push("cast: its spell was not found among the converted spells");
    return null;
  }
  // A spell cast as a rest finishes (Human Molar's Sanctuary) is no Action: as one it would be free and unlimited.
  const restCast = pick(activity, system, "activation").type;
  if ( ["shortRest", "longRest"].includes(restCast) ) {
    notes.push(`cast: ${spellDocument.name} is cast as a ${restCast} finishes, which is by hand`);
    return null;
  }
  const casting = ABILITY_MAP[activity.spell?.ability] ?? options.creature?.castingAbility ?? null;
  const creature = options.creature && casting
    ? {...options.creature, spellDC: options.creature.saveDC?.(Object.keys(ABILITY_MAP).find(key => ABILITY_MAP[key] === casting))?.value
      ?? options.creature.spellDC} : options.creature;
  // A magic item's own save DC ("Wand of Fireballs: DC 15"), else its user's spell save DC.
  const challenge = activity.spell?.challenge;
  // dnd5e leaves some items' DC out of their cast activity (Demonomicon of Iggwilv); its text gives it ("spells (save DC 20)").
  const fixedDC = challenge?.override ? number(challenge.save)
    : (options.creature ? null : number(/\(save DC (\d+)\)/i.exec(plainText(document))?.[1]));
  const converted = convertItem(spellDocument, {...options, creature, spellDC: fixedDC, licensed: () => true});
  const action = converted.items?.find(item => item.type === "action");
  if ( !action ) return null;
  // A wand's charges (the item's uses) or the activity's own uses pay for it.
  // dnd5e leaves some wands' charge out of their cast activity (Wand of Polymorph); its text gives it ("expend 1 charge to cast").
  const charge = (activity.consumption?.targets ?? []).length ? null
    : /\bexpend (\d+) (?:of its )?charges?\b[^.]*\bcast\b/i.exec(plainText(document));
  // A consumable's use is one of its own (Oil of Slipperiness's Pour on Ground, which dnd5e leaves spending nothing).
  const used = !charge && !(activity.consumption?.targets ?? []).length && (document.type === "consumable")
    && (number(document.system?.uses?.max) > 0);
  const spends = charge?.[1] ?? (used ? "1" : null);
  const paying = spends ? {...activity, consumption: {...activity.consumption, targets: [{type: "itemUses", value: spends}]}} : activity;
  // "duplicating the effect of the Grease spell in that area for 8 hours": a length its text gives other than the spell's is by hand.
  const spellName = spellDocument.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lasts = new RegExp(`\\b${spellName}\\}? spell\\b[^.]*?\\bfor (\\d+) (minute|hour)s?\\b`, "i").exec(plainText(document));
  const spellRounds = (Number(spellDocument.system?.duration?.value) || 0) * (ROUNDS[spellDocument.system?.duration?.units] ?? 0);
  if ( lasts && (Number(lasts[1]) * ROUNDS[lasts[2].toLowerCase()] !== spellRounds) ) {
    notes.push(`cast: its ${lasts[1]} ${lasts[2].toLowerCase()}${(lasts[1] === "1") ? "" : "s"} (its text) is by hand; it lasts as the spell does`);
  }
  const base = baseDefinition({document, activity: paying, system, spell: false, notes, pool: itemPool, names: options.names ?? {},
    scales: options.scales ?? {}});
  // A reaction spell (a ring's Feather Fall) is still cast with its Reaction, whatever the item's cast activity says.
  const reacts = (action.system.definition.costs?.allOf ?? []).some(cost => cost.capability === "reaction");
  const costs = reacts ? {...base.costs, allOf: [...(base.costs?.allOf ?? []).filter(cost => !["action", "bonus-action", "reaction"]
    .includes(cost.capability)), {capability: "reaction", amount: 1}]} : base.costs;
  // A magic item's is named after the item too ("Wand of Fireballs: Fireball"), and after its activity when that says more of
  // the spell ("Telekinesis Using Psionic Die"); a limit the name gives ("Plane Shift (to layers of the Abyss only)") is by hand.
  const own = String(activity.name ?? "");
  const named = own.toLowerCase().startsWith(spellDocument.name.toLowerCase()) ? own : spellDocument.name;
  const name = options.creature ? spellDocument.name : `${document.name}: ${named}`;
  const definition = {...action.system.definition, id: `${base.id}-${slugify(spellDocument.name)}`, label: name,
    tags: [...new Set([...(action.system.definition.tags ?? []), "spell"])], costs};
  // "without suffering the wave of lethargy that typically occurs when the effect ends" (2024 Potion of Speed): nothing
  // befalls its creature when its effect ends (effectEndedTrigger).
  if ( definition.effects && /\bwithout suffering\b[^.]*\bwhen the (?:effect|spell) ends\b/iu.test(plainText(document)) ) {
    definition.effects = definition.effects.map(effect => ({...effect, ruleElements: (effect.ruleElements ?? [])
      .filter(rule => !((rule.type === "Trigger") && (rule.data?.event === "effect.ended")))}));
  }
  // "the Haste spell for 1 minute (no Concentration required)" (2024 potions): nothing of this cast is concentrated on.
  const unheld = !options.creature
    && new RegExp(`\\b${spellName}\\}? spell\\b[^.]*\\(no Concentration required\\)`, "i").test(plainText(document));
  if ( unheld ) {
    delete definition.concentration;
    if ( definition.effects ) definition.effects = definition.effects.map(({concentration: _held, ...effect}) => effect);
    for ( const key of ["summon", "transform"] ) if ( definition[key] ) {
      definition[key] = {...definition[key]};
      delete definition[key].concentration;
    }
    if ( definition.area?.persistence ) definition.area = {...definition.area, persistence: {...definition.area.persistence, concentration: false}};
  }
  // Cast without a slot; its other choices stay (Polymorph's Beast, a damage type, one of its effects). One cast above its
  // own level (a Lich's 5th-level Fireball) keeps the slot choice's scaling at that level, a choice the authority answers.
  const castLevel = Number(activity.spell?.level);
  const slot = (definition.configuration ?? []).find(choice => choice.id === "spell-slot");
  const choices = (definition.configuration ?? []).filter(choice => choice.id !== "spell-slot");
  if ( slot?.effects?.length && (castLevel > (Number(spellDocument.system?.level) || 0)) ) choices.push({id: "spell-slot", type: "option",
    label: "WILDPATH.PROMPT.CastLevel", required: true, fromCast: true,
    options: [{id: `level-${castLevel}`, label: String(castLevel), value: castLevel, metadata: {castingLevel: castLevel}}], effects: slot.effects});
  if ( choices.length ) definition.configuration = choices;
  else delete definition.configuration;
  // A limit in parentheses, in an item's activity name or after the spell's link in a creature's text ("Shapechange (Beast or
  // Humanoid form only, no Temporary Hit Points gained from the spell, and no Concentration ...)"): a transform's is read.
  const limit = !options.creature ? /\((.+)\)/.exec(named)?.[1]
    : new RegExp(`@UUID\\[[^\\]]*\\.Item\\.${linked}\\]\\{[^}]*\\}(?:</em>)?\\s*\\(([^)]+)\\)`).exec(String(document.system?.description?.value ?? ""))?.[1];
  const unread = (limit && definition.transform) ? limitTransform(definition, limit, options.forms ?? []) : [limit];
  if ( limit && unread.length && (!options.creature || definition.transform) ) {
    notes.push(`cast: "${options.creature ? `${named} (${limit})` : named}" is the whole spell; its limit is by hand`);
  }
  if ( definition.attack && casting ) definition.attack = {...definition.attack, ability: casting};
  // Cast at its own level, nothing is upcast by hand.
  const above = castLevel > (Number(spellDocument.system?.level) || 0);
  notes.push(...converted.notes.filter(note => !note.startsWith("uses:") && !(unheld && note.startsWith("concentration:")) && (above || !note.startsWith("upcast:"))));
  const pool = activityPool({document, activity, scales: options.scales, spellName: spellDocument.name});
  const id = stableId(`${document._id}:cast:${activity._id ?? spellDocument._id}`);
  // A pool the cast fills (Heroes' Feast's servings) comes with it, and so do the spell's Actions that spend it (Consume Feast).
  const filled = new Set((definition.restores ?? []).map(entry => entry.resourceId));
  const spellPools = (action.system.ruleElements ?? []).filter(rule => (rule.type === "GrantResource") && filled.has(rule.data?.resourceId));
  const followUps = converted.items.filter(item => (item !== action) && (item.type === "action")
    && (item.system.definition?.costs?.allOf ?? []).some(cost => filled.has(cost.capability)));
  const source = {...action.flags.wildpath.source, castBy: document.name};
  return [{_id: id, _key: `!items!${id}`, name, type: "action",
    img: kept(spellDocument.img, options.images ?? ["icons/"]) ?? action.img,
    system: {active: true, description: action.system.description, definition, ruleElements: [itemPool?.rule, pool?.rule, ...spellPools,
      // A spell's reaction Trigger (a Mage's Counterspell) comes with it.
      ...(action.system.ruleElements ?? []).filter(rule => rule.type === "Trigger")].filter(Boolean)},
    flags: {wildpath: {source, conversion: {notes: [...notes]}}}},
  ...followUps.map(item => {
    const followUpId = stableId(`${id}:${item._id}`);
    return {...structuredClone(item), _id: followUpId, _key: `!items!${followUpId}`,
      name: options.creature ? item.name : `${document.name}: ${item.name}`, flags: {wildpath: {source, conversion: {notes: []}}}};
  })];
}

/**
 * A cast copy's limit on its transform, clause by clause: "Beast or Humanoid form only" keeps only forms of those creature
 * types, "no Temporary Hit Points ..." drops the form's Temporary Hit Points, "no Concentration ..." its concentration.
 * Changes `definition`; returns the clauses it could not read.
 */
function limitTransform(definition, limit, forms) {
  const typeOf = new Map(forms.map(form => [form.uuid, form.type]));
  const transform = definition.transform = {...definition.transform};
  return limit.split(/,\s*(?:and\s+)?/u).filter(clause => {
    const only = /^(.+?) forms? only$/iu.exec(clause);
    if ( only ) {
      const types = only[1].toLowerCase().split(/,\s*(?:or\s+)?|\s+or\s+/u);
      const choice = (definition.configuration ?? []).find(entry => entry.id === transform.choiceId);
      const options = (choice?.options ?? []).filter(option => types.includes(typeOf.get(option.id)));
      if ( !options.length ) return true;
      definition.configuration = definition.configuration.map(entry => ((entry === choice) ? {...entry, options} : entry));
      return false;
    }
    if ( /^no Temporary Hit Points\b/iu.test(clause) ) {
      delete transform.temporaryHealth;
      delete transform.untilTemporaryHealthLost;
      return false;
    }
    if ( /^no Concentration\b/iu.test(clause) ) {
      delete transform.concentration;
      return false;
    }
    return true;
  });
}

/**
 * A poison's use (2024 DMG), which dnd5e leaves without an activation: the Utilize action, on one creature within 5 feet
 * (a contact, ingested or inhaled poison), its save and what a failure does as dnd5e gives them. An injury poison coats
 * a weapon instead (coatDefinition).
 */
function poisonUse(activity) {
  // By its name, whatever its type: a Truth Serum is a potion.
  if ( (activity.name !== "Use Poison") || !["", "none", "special"].includes(activity.activation?.type ?? "") ) {
    return activity;
  }
  return {...activity, activation: {type: "action", value: 1, override: true}, range: {value: "5", units: "ft", override: true},
    target: {...(activity.target ?? {}), affects: {...(activity.target?.affects ?? {}), type: "creature", count: "1"}, override: true}};
}

/**
 * Actions whose 2024 text the converter writes, by `<identifier>/<activity name>`: the definition dnd5e's activity
 * leaves out, and the activities of the same item it folds in (`folds`, by name, else type), which are then no passive
 * abilities of their own. What of its text stays by hand is its `notes`.
 */
const ACTIONS_BY_HAND = Object.freeze({
  // 2024 Oathbow: "The target of your attack becomes your sworn enemy until it dies or until dawn seven days later": the
  // creature it is about to shoot, marked for 7 days; sworn once until dawn (its use: ACTIVATIONS_BY_HAND). Its "Attack
  // Sworn Enemy" (a flat 3d6 attack with no bow die) is the Oathbow's own rules on the bow's attacks instead (`drops`).
  "oathbow/Swear Oath": {folds: [], drops: ["Attack Sworn Enemy"], definition: definition => ({...definition, range: {type: "special"},
    targeting: {type: "single", required: true, count: 1}, effects: (definition.effects ?? []).map(effect => ((effect.name === "Sworn Enemy")
      ? {...effect, duration: {value: 7, units: "days"}} : effect))}),
  notes: ["Swear Oath: one sworn enemy at a time (a new one only after it dies) and Disadvantage with other weapons are by hand"]},
  // 2024 Robe of Scintillating Colors: a Magic action and a charge; "until the end of your next turn" the robe sheds Bright
  // Light 30 feet and Dim Light 30 more, and attack rolls against its wearer have Disadvantage; each creature in the Bright
  // Light makes a DC 15 Wisdom save or is Stunned for as long. shortcut: "that can see you" is not checked.
  "robe-of-scintillating-colors/Display Dazzling Hues": {folds: ["save"], definition: definition => {
    const until = {value: 1, units: "rounds", expiry: "sourceTurnEnd"};
    return {...definition, range: {type: "self"}, targeting: {type: "area"}, area: {shape: "emanation", size: {value: 30, unit: "ft"}},
      save: {ability: "wits", dc: {value: 15}}, effects: [
        {id: "effect-1", type: "condition", conditionId: "stunned", saveOutcomePolicy: "failure", duration: until},
        {id: "effect-2", type: "effect", name: "Dazzling Hues", img: "icons/svg/light.svg", appliesTo: "source", duration: until,
          ruleElements: [{schemaVersion: 1, id: "dazzling-light", type: "GrantLight", data: {bright: 30, dim: 60}},
            {schemaVersion: 1, id: "dazzling-hues", type: "RollMode", data: {domains: ["attacked"], mode: "disadvantage"}}]}]};
  }}
});

/**
 * Uses dnd5e leaves without an activation though their text gives one, by `<identifier>/<activity name>`: dumping a Bag
 * of Beans (the Utilize action), peering into a Dragon Orb (a Magic action). One that happens at once, at no cost, is
 * `free`: the Skull card's Avatar of Death, appearing as it is drawn. One its text limits (`uses`, spent when used) is
 * `{type, uses}`: an Oathbow's oath, sworn once until dawn.
 */
const ACTIVATIONS_BY_HAND = Object.freeze({"bag-of-beans/Dump Beans": "action", "dragon-orb/Attunement Save": "action",
  "skull/Card Effect": "free", "oathbow/Swear Oath": {type: "free", uses: {max: "1", recovery: [{period: "dawn", type: "recoverAll"}]}}});

function activationByHand(document, activity) {
  const byHand = ACTIVATIONS_BY_HAND[`${identifierOf(document)}/${activity.name}`];
  if ( !byHand ) return activity;
  const {type, uses} = (typeof byHand === "string") ? {type: byHand} : byHand;
  return {...activity, activation: {...(activity.activation ?? {}), override: true,
    ...((type === "free") ? {type: "", value: null, free: true} : {type, value: 1})},
    ...(uses ? {uses: structuredClone(uses), consumption: {...(activity.consumption ?? {}),
      targets: [...(activity.consumption?.targets ?? []), {type: "activityUses", value: "1"}]}} : {})};
}

/**
 * An injury poison (2024): using it coats its user's weapon. The coat is an effect on its user for 1 minute whose
 * reaction, on its next weapon hit, makes the creature hit take the poison's save; the hit ends it (`endsWhen: "hits"`).
 * shortcut: any weapon hit delivers it, not only a Piercing or Slashing one; upgrade when a hit's damage types reach
 * its trigger.
 */
function coatDefinition(definition, document, img) {
  const {costs, range: _range, targeting: _targeting, ...poison} = definition;
  const strike = {...poison, id: `${definition.id}:coat`, label: document.name, costs: {allOf: []}, range: {type: "special"},
    targeting: {type: "single", required: true, count: 1}};
  return {schemaVersion: 1, id: definition.id, label: document.name, costs, ...(definition.tags ? {tags: definition.tags} : {}),
    range: {type: "self"}, targeting: {type: "self"}, effects: [{id: "effect-1", type: "effect", name: document.name, img,
      duration: {value: 1, units: "minutes"}, endsWhen: "hits", ruleElements: [{schemaVersion: 1, id: "coat", type: "Trigger",
        data: {kind: "reaction", event: "attack.hit", match: {phase: "interrupt", sourceTokenId: "{self}", tagsAll: ["weapon"]}, action: strike}}]}]};
}

/**
 * A trap's tier (2024 DMG: "Trigger (5-10)", by the characters' levels) as the Action its GM sets it with: a lasting
 * 5-foot square placed anywhere, with no duration, that springs on each creature entering it: its save or attack, and
 * its damage and effects. Setting it does nothing else. shortcut: finding it (Wisdom (Perception)) and disarming it are
 * by hand (delete its area), and so is a trap that springs only once; upgrade with hazard Regions that hold their DCs.
 */
function trapDefinition(definition, name) {
  const sprung = {schemaVersion: 1, id: `${definition.id}:sprung`, label: name, costs: {allOf: []},
    ...Object.fromEntries(["tags", "save", "attack", "damage", "effects"].filter(key => definition[key] && !(Array.isArray(definition[key])
      && !definition[key].length)).map(key => [key, definition[key]]))};
  return {schemaVersion: 1, id: definition.id, ...(definition.label ? {label: definition.label} : {}), costs: {allOf: []},
    range: {type: "special"}, targeting: {type: "area"}, area: {shape: "cube", size: {value: 5, unit: "ft"},
      persistence: {duration: null, concentration: false, triggers: [{on: ["area.entered"], action: sprung}]}}};
}

/**
 * A dnd5e RollTable (2024): drawn as Foundry draws any table. A result naming a document converted here (`uuidOf`: a
 * spell, a magic item, a creature) names WildPath's; one naming any other is its text. Links in its text are rewritten
 * the same way, or left as their label. Only Foundry's own art is kept. `source` is the SRD magic item or spell it
 * belongs to.
 */
export function convertTable(table, {uuidOf, source}) {
  // A link with no label to anything but a converted document (an effect of its Item) is dropped.
  const text = html => String(html ?? "").replace(/@UUID\[([^\]]+)\](?:\{([^}]*)\})?/g, (_match, uuid, label) => {
    const to = /^Compendium\.[\w-]+\.[\w-]+\.(?:Item|Actor)\.[\w-]+$/.test(uuid) ? uuidOf(uuid) : null;
    return to ? `@UUID[${to}]${label ? `{${label}}` : ""}` : (label ?? "");
  });
  const icon = img => kept(img, ["icons/"]) ?? "icons/svg/d20-black.svg";
  return {_id: table._id, _key: `!tables!${table._id}`, name: table.name, img: icon(table.img), description: text(table.description),
    formula: table.formula || `1d${Math.max(...(table.results ?? []).map(result => Number(result.range?.[1]) || 1))}`,
    replacement: table.replacement !== false, displayRoll: table.displayRoll !== false,
    results: (table.results ?? []).map(result => {
      const to = (result.type === "document") ? uuidOf(result.documentUuid) : null;
      return {_id: result._id, _key: `!tables.results!${table._id}.${result._id}`, type: to ? "document" : "text",
        range: result.range, weight: result.weight ?? 1, drawn: false, img: icon(result.img), name: result.name ?? "",
        description: text(result.description), ...(to ? {documentUuid: to} : {})};
    }),
    flags: {wildpath: {source}}};
}

/**
 * The class spell lists each spell is on, by its dnd5e id, from dnd5e's spell list pages (a "Wizard Spell List" journal
 * page: `type: "spells"`, `system.identifier`, `system.spells` uuids): `{phbsplFireball00: ["sorcerer", "wizard"]}`.
 */
export function spellListsOf(journals=[]) {
  const lists = {};
  for ( const page of journals.flatMap(journal => journal.pages ?? []) ) {
    const identifier = page?.type === "spells" ? page.system?.identifier : null;
    if ( !identifier ) continue;
    for ( const uuid of page.system?.spells ?? [] ) {
      const id = String(uuid).split(".").pop();
      (lists[id] ??= []).includes(identifier) || lists[id].push(identifier);
    }
  }
  return lists;
}

/**
 * A dnd5e Bastion facility (2024 DMG) as WildPath's (`facility`): basic or special, the character level it needs, its
 * size, hirelings and the order it takes; its text says what each order does.
 */
export function convertFacility(document, {licensed=isSrd2024, book="SRD 5.2", images=["icons/"], pack=null, names={}}={}) {
  if ( !licensed(document) || (document.type !== "facility") ) return {ok: false, reason: "not a licensed facility"};
  const system = document.system ?? {};
  return {ok: true, item: {_id: document._id, _key: `!items!${document._id}`, name: document.name, type: "facility",
    img: kept(document.img, images) ?? "icons/environment/settlement/house-cottage.webp",
    system: {active: true, description: houseText(document, describe(document, {names})), ruleElements: [],
      kind: (system.type?.value === "basic") ? "basic" : "special", level: Number(system.level) || 0, size: system.size ?? "",
      hirelings: Number(system.hirelings?.max) || 0, order: system.order ?? "", defenders: Number(system.defenders?.max) || 0,
      trade: {profit: Number(system.trade?.profit) || 0, stockMax: Number(system.trade?.stock?.max) || 0, stock: 0},
      current: {order: "maintain", craft: "", progress: 0}},
    flags: {wildpath: {source: {system: "dnd5e", pack, id: document._id, type: document.type, book,
      license: system.source?.license || null, rules: system.source?.rules || "2024", identifier: identifierOf(document)},
      conversion: {notes: []}}}}};
}

/** A dnd5e price (`{value, denomination}`) in gold. */
const priceInGold = price => Math.max(0, (Number(price?.value) || 0) * ({pp: 10, gp: 1, ep: 0.5, sp: 0.1, cp: 0.01}[price?.denomination ?? "gp"] ?? 1));

/** A creature id's name part: `phbmobWeasel0000` and `mmWeasel00000000` are both `weasel`; a random id has none. */
const creatureKey = id => (/^(?:phbmob|mm|dmg|phb)[A-Z]/u.test(id) ? id.replace(/^(?:phbmob|mm|dmg|phb)/u, "").replace(/0+$/u, "").toLowerCase() : "");

/**
 * The converted creature a summon's dnd5e uuid names, from `creatures` (dnd5e id to WildPath uuid, with any redirects:
 * withRedirects). A PHB appendix creature (`phbmobWeasel0000`) is the SRD's own of that name (`mmWeasel00000000`);
 * a name cut short by the id's 16 characters matches the longer one it starts.
 */
export function creatureRef(creatures, uuid) {
  const id = String(uuid ?? "").split(".").pop();
  if ( creatures[id] ) return creatures[id];
  const key = creatureKey(id);
  if ( key.length < 3 ) return null;
  const match = Object.keys(creatures).find(other => {
    const theirs = creatureKey(other);
    return theirs && ((theirs === key) || ((Math.min(theirs.length, key.length) >= 8) && (theirs.startsWith(key) || key.startsWith(theirs))));
  });
  return match ? creatures[match] : null;
}

/**
 * `creatures` with a content module's uuid redirects (its `scripts/redirects.mjs`, `CONFIG.compendium.uuidRedirects[old]
 * = new`, or a plain `{oldId: newId}`) as extra ids: a summon naming an old Actor brings the one it now points to.
 */
export function withRedirects(creatures, redirects) {
  const pairs = typeof redirects === "string"
    ? [...redirects.matchAll(/uuidRedirects\["([^"]+)"\]\s*=\s*"([^"]+)"/gu)].map(([, from, to]) => [from, to])
    : Object.entries(redirects ?? {});
  const aliases = {};
  for ( const [from, to] of pairs ) {
    const id = from.split(".").pop();
    const target = creatures[to.split(".").pop()];
    if ( target && !creatures[id] && !aliases[id] ) aliases[id] = target;
  }
  return {...creatures, ...aliases};
}

/** "A Humanoid killed by this spell rises ...", "A Humanoid reduced to 0 Hit Points by this damage dies, and a Shadow rises". */
const KILLED_RISES = /\bAn? (Aberration|Beast|Celestial|Construct|Dragon|Elemental|Fey|Fiend|Giant|Humanoid|Monstrosity|Ooze|Plant|Undead) (?:killed by this\b|reduced to 0 Hit Points by this\b[^.]*\bdies\b)[^.]*\brises\b/iu;

/**
 * A creature its damage kills rising as its user's (Finger of Death's Raise Zombie, a Shadow Dragon's Shadow Rises): dnd5e's
 * summon activity with no activation, which its damaging Action takes as `summon: {actorRef, fromKilled: {types}}`. Null
 * when its text says no such thing or its creature is not converted.
 */
function raisedFromKilled(document, activities, creatures, system) {
  // A link's dots ("@UUID[Compendium.….mmShadow00000000]{Shadow}") would end its sentence: its label.
  const match = KILLED_RISES.exec(plainText(document).replace(/@UUID\[[^\]]*\]\{([^}]*)\}/gu, "$1"));
  const activity = match && activities.find(entry => (entry.type === "summon") && ["", "none"].includes(pick(entry, system, "activation").type ?? "")
    && (entry.profiles ?? []).length === 1);
  const actorRef = activity ? creatureRef(creatures, activity.profiles[0].uuid) : null;
  // "reduced to 0 Hit Points by this damage dies": a character it drops is dying, not dead, so none rises from one.
  return actorRef ? {activity, summon: {actorRef, fromKilled: {types: [match[1].toLowerCase()]}},
    notes: /\bdies\b/iu.test(match[0]) ? [`summon: "${activity.name}" raises no character: one reduced to 0 Hit Points is dying, not dead as its text says (by hand)`] : []}
    : null;
}

/**
 * What a melee hit on the creature its effect is on costs the attacker (CARRIED_RETALIATION_TEXT): dnd5e's damage or save
 * activity with no activation (Armor of Agathys' Frost Damage, Holy Aura's Fiend/Undead Save), else the damage its text
 * rolls (the SRD's Fire Shield has no such activity), as an Action its effect carries in a reaction Trigger (`data.action`,
 * effectReactionItems), used at once. `ruleFor(effect)` is that Trigger for one of the effects its use applies: a damage of
 * several types is the one its text gives that effect by a word of its name ("2d8 Fire damage from a warm shield": Warm
 * Shield), none when it gives none. Its save is at the DC of the creature that gave the effect (`fromSource`); more damage
 * from a higher slot is a table on the slot chosen (slotGrowth, which bindSlot has its spell-slot choice fill).
 * Null when its text says no such thing, or neither damage nor a save converts.
 */
function carriedRetaliation({document, activities, system, spell, level, scales, saveDC, spellDC, creature, beasts, names}) {
  const passive = activities.find(entry => ["damage", "save"].includes(entry.type)
    && ["", "none", "special"].includes(pick(entry, system, "activation").type ?? ""));
  const text = plainText(document);
  const match = CARRIED_RETALIATION_TEXT.exec(passive?.activation?.condition ?? "") ?? CARRIED_RETALIATION_TEXT.exec(text);
  if ( !match ) return null;
  // "The attacker takes [[/damage 2d8 type=fire]] damage from a warm shield or [[/damage 2d8 type=cold]] damage from a chill shield."
  const rolled = [...text.matchAll(/\[\[\/damage (\d+)d(\d+) type=(\w+)\]\](?: damage from an? (\w+))?/gu)];
  const byWord = Object.fromEntries(rolled.filter(entry => entry[4]).map(entry => [entry[4].toLowerCase(), entry[3]]));
  const activity = passive ?? ((rolled.length && rolled.every(entry => (entry[1] === rolled[0][1]) && (entry[2] === rolled[0][2])))
    ? {_id: "retaliation", type: "damage", activation: {type: "", override: true}, range: {units: "any", override: true},
      target: {affects: {type: "creature", count: "1"}, template: {}, override: true}, effects: [], consumption: {targets: []},
      damage: {parts: [{number: Number(rolled[0][1]), denomination: Number(rolled[0][2]), bonus: "", types: [...new Set(rolled.map(entry => entry[3]))]}]}}
    : null);
  const notes = [];
  const converted = activity ? convertActivity({document, activity, system, spell, level, scales, notes, pool: null, saveDC, spellDC, creature,
    beasts, names}) : null;
  if ( !converted?.damage?.length && !converted?.save ) return null;
  // Answering the hit is its activation (dnd5e's "special").
  notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("activation:")));
  // A higher slot's more damage (slotGrowth): dice or a flat amount ("increase by 5 for each spell slot level above 1").
  const damage = (converted.damage ?? []).map(component => {
    const grown = slotGrowth(component.expression, activity.damage?.parts?.[Number(component.id.split("-").pop()) - 1], {spell, level});
    if ( grown?.byHand ) notes.push(`"${document.name}": the damage its effect deals doesn't grow with a higher spell slot (by hand)`);
    return grown?.expression ? {...component, expression: grown.expression} : component;
  });
  const dc = converted.save?.dc;
  const save = converted.save ? {...converted.save, dc: dc.valueExpression ? {...dc, fromSource: true} : dc} : null;
  const types = match[1] ? match[1].split(/,? or an? /u).map(type => type.toLowerCase()) : [];
  const predicates = [...(types.length ? [{oneOf: {path: "sourceType", values: types}}] : []),
    ...(match[2] ? [{atMost: {path: "toSource.{self}.distance", value: Number(match[2])}}] : [])];
  // Several damage types (Flame Eruption's Cold or Fire) are the one its effect's name gives.
  const chosen = (converted.configuration ?? []).some(choice => choice.type === "damage-type");
  // What a failed save gives the attacker (Holy Aura's Blinded) is no concentration of the creature hit.
  const effects = carriedEffects(converted, activity, system, text);
  if ( /\bends early if you have no Temporary Hit Points\b/iu.test(text) ) {
    notes.push(`"${document.name}": ending early when its Temporary Hit Points are gone is by hand`);
  }
  return {activity: passive, notes, ruleFor: effect => {
    const word = Object.keys(byWord).find(each => String(effect.name ?? "").toLowerCase().split(/\W+/u).includes(each));
    if ( chosen && !word ) return null;
    return {schemaVersion: 1, id: "retaliation", type: "Trigger", data: {kind: "reaction", ...structuredClone(RETALIATION), policy: "always",
      ...(predicates.length ? {triggerPredicate: (predicates.length > 1) ? {all: predicates} : predicates[0]} : {}),
      action: {schemaVersion: 1, id: `action:${slugify(document.name)}-retaliation`, label: document.name, ...(spell ? {tags: ["magical"]} : {}),
        ...structuredClone(RETALIATION_ACTION),
        ...(damage.length ? {damage: damage.map(component => (word ? {...component, damageType: byWord[word]} : component))} : {}),
        ...(save ? {save} : {}), ...(effects.length ? {effects} : {})}}};
  }};
}

/**
 * The effects a passive activity's Action gives when another effect carries it (carriedRetaliation, effectEndedTrigger):
 * no concentration of their own (the effect carrying them holds it), and one whose dnd5e effect has no duration (the
 * SRD's) lasts as its activity does, to the turn boundary its text names.
 */
function carriedEffects(converted, activity, system, text) {
  const lasts = textBoundExpiry(lastingDuration(pick(activity, system, "duration")), text);
  return (converted.effects ?? []).map(({concentration: _held, ...entry}) => ((entry.duration || !lasts) ? entry : {...entry, duration: lasts}));
}

/**
 * What befalls the target when its effect ends ("When the spell ends, the target is Incapacitated and has a Speed of 0 until
 * the end of its next turn": Haste's lethargy): dnd5e's passive activity applying it, as an `effect.ended` Trigger its
 * effect carries, whose Action the active GM runs on that creature when the effect is deleted (but for a rollback). Null
 * when its text says no such thing, or no such activity gives an effect.
 */
function effectEndedTrigger({document, activities, system, spell, level, scales, saveDC, spellDC, creature, beasts, names}) {
  const text = plainText(document);
  if ( !/\bWhen the (?:spell|effect) ends, the target\b/u.test(text) ) return null;
  const activity = activities.find(entry => ["", "none"].includes(pick(entry, system, "activation").type ?? "") && (entry.effects ?? []).length);
  if ( !activity ) return null;
  const notes = [];
  const converted = convertActivity({document, activity, system, spell, level, scales, notes, pool: null, saveDC, spellDC, creature, beasts,
    names});
  const effects = carriedEffects(converted, activity, system, text);
  if ( !effects.length ) return null;
  return {activity, notes: notes.filter(note => !note.startsWith("activation:")), rule: {schemaVersion: 1, id: "effect-ended", type: "Trigger",
    data: {kind: "automation", event: "effect.ended", action: {schemaVersion: 1, id: `action:${slugify(document.name)}-ended`,
      label: document.name, costs: {allOf: []}, effects}}}};
}

/** The tags of each action a limited extra action may take (extraActionGrant): the Attack action's attack, Grapple or Shove. */
const EXTRA_ACTION_TAGS = Object.freeze({Attack: ["attack", "id:common:grapple", "id:common:shove", "id:common:push"],
  Dash: ["id:common:dash"], Disengage: ["id:common:disengage"], Hide: ["id:common:hide"], Utilize: ["id:common:utilize"],
  "Use an Object": ["id:common:utilize"]});

/**
 * "gains an additional action on each of its turns. That action can be used to take only the Attack (one attack only), Dash,
 * Disengage, Hide, or Utilize action" (2024 Haste): a pool of 1 refilled each turn that pays an Action (or Bonus Action)
 * for those actions only (GrantResource `pays`, `actions`), never a spell or what always costs a Bonus Action. Using it
 * refills nothing, so its attack is one attack. An action not in EXTRA_ACTION_TAGS is noted by hand. Null when its text
 * says no such thing.
 */
function extraActionGrant(document) {
  // "can be used only to take the" (2014) or "can be used to take only the" (2024).
  const match = /\bgains? an additional (action|Bonus Action) on each of its turns\. That action can be used (?:only )?to take (?:only )?the (.+?) actions?\./u
    .exec(plainText(document));
  if ( !match ) return null;
  const names = match[2].replace(/\([^)]*\)/gu, "").split(/,\s*(?:or\s+)?|\s+or\s+/u).map(name => name.trim()).filter(Boolean);
  const notes = names.filter(name => !EXTRA_ACTION_TAGS[name]).map(name => `extra action: "${name}" is by hand`);
  const id = `${identifierOf(document)}-extra-action`;
  const tagsAny = names.flatMap(name => EXTRA_ACTION_TAGS[name] ?? []);
  const action = match[1] === "action";
  // None read: no grant, since an empty list would pay for anything.
  return {notes, rule: tagsAny.length ? {schemaVersion: 1, id, type: "GrantResource", data: {resourceId: id,
    label: "WILDPATH.RESOURCES.ExtraAction", maximum: 1, recovery: "turn", pays: [action ? "action" : "bonus-action"],
    actions: {tagsAny, notTagsAny: ["spell", ...(action ? ["cost:bonus-action"] : [])]}}} : null};
}

/**
 * A summon activity (G4) as an Action whose creatures appear where its caster chooses, for the spell's duration (in
 * rounds) or while it concentrates: its creature, or a choice of its creatures, from `creatures` (dnd5e Actor id to
 * WildPath uuid). Null when it chooses by Challenge Rating, or names a creature not converted.
 */
function summonDefinition({document, activity, system, spell, level, notes, pool, creatures, names, beasts=[], scales={}, tables={}}) {
  // Chosen by Challenge Rating (Find Familiar, Pact of the Chain, Wild Companion): each converted Beast of a profile's
  // CR or lower. shortcut: a Celestial, Fey or Fiend form (Find Familiar) and other creature types are by hand.
  const byChallenge = activity.summon?.mode === "cr";
  const profiles = byChallenge
    ? [...new Map((activity.profiles ?? []).filter(profile => (profile.types ?? []).includes("beast"))
      .flatMap(profile => beasts.filter(beast => beast.cr <= (number(profile.cr) ?? 0))
        .map(beast => [beast.uuid, {profile: {count: profile.count, name: `${beast.name} (CR ${beast.cr})`}, ref: beast.uuid}]))).values()]
    : (activity.profiles ?? []).map(profile => ({profile, ref: creatureRef(creatures, profile.uuid)}));
  if ( byChallenge && !profiles.length ) {
    notes.push("summon: a creature chosen by Challenge Rating is not converted");
    return null;
  }
  // Forms dnd5e splits from the one stat block the SRD prints ("uses the Giant Insect stat block": its centipede, spider
  // and wasp), none converted: that stat block. shortcut: what the form chosen changes in it (Web Bolt, a spider's only)
  // is its player's to pick; upgrade when a summon can pick a stat block's variant.
  const block = (!byChallenge && profiles.length && profiles.every(entry => !entry.ref)
    && (new Set(profiles.map(({profile}) => String(profile.count ?? ""))).size === 1))
    ? creatureRef(creatures, /\buses the @UUID\[[^\]]*\.Actor\.(\w+)\][^.]*?\bstat block\b/iu.exec(plainText(document))?.[1] ?? "")
    : null;
  if ( block ) profiles.splice(0, profiles.length, {profile: {...profiles[0].profile, name: ""}, ref: block});
  // Forms dnd5e has that the SRD does not (Pact of the Chain's Slaad Tadpole): left out, the others kept.
  const unlicensed = profiles.filter(entry => !entry.ref);
  if ( unlicensed.length && (unlicensed.length < profiles.length)
    && unlicensed.every(({profile}) => names?.[String(profile.uuid ?? "").split(".").pop()]) ) {
    notes.push(`summon: not in the SRD, so not offered: ${unlicensed.map(({profile}) => names[String(profile.uuid).split(".").pop()]).join(", ")}`);
    profiles.splice(0, profiles.length, ...profiles.filter(entry => entry.ref));
  }
  if ( !profiles.length || profiles.some(entry => !entry.ref) ) {
    notes.push("summon: its creature is not among the converted creatures");
    return null;
  }
  // Each creature's count: a whole number, or worked out when cast (Animate Dead's 1 + 2 per slot level above 3rd,
  // Animate Objects' spellcasting modifier); different counts per creature (Dancing Lights: 4 small or 1 medium).
  // A count of "@scaling" with scaling allowed is chosen when used (`chosenCount`): Pipes of the Sewers' "one Swarm of
  // Rats with each expended charge" spends that many charges; a Horn of Valhalla's up to 5 spirits cost nothing more.
  const scaling = activity.consumption?.scaling?.allowed ? activity.consumption.scaling : null;
  const chosenCount = scaling && profiles.every(({profile}) => String(profile.count ?? "").trim() === "@scaling");
  const counts = profiles.map(({profile}) => (chosenCount || (String(profile.count ?? "").trim() === "") ? 1
    : (Number.isInteger(Number(profile.count)) ? Number(profile.count) : summonCount(profile.count, level))));
  // A spell's creature only from a higher slot (Create Undead's Ghasts and Wights from 8th, Mummies from 9th): none below it.
  if ( spell ) for ( const [index, {profile}] of profiles.entries() ) {
    const from = number(profile.level?.min);
    if ( (from > (Number(level) || 0)) && (counts[index] !== null) ) counts[index] = {type: "table", key: {type: "context", path: "castLevel"},
      rows: {[from]: (typeof counts[index] === "object") ? counts[index] : {type: "constant", value: counts[index]}}, default: {type: "constant", value: 0}};
  }
  if ( counts.some(count => (count === null) || (Number.isInteger(count) && (count < 1))) ) {
    notes.push(`summon: a count of "${profiles.map(({profile}) => profile.count).join(", ")}" is not converted`);
    return null;
  }
  const uniform = counts.every(count => Number.isInteger(count)) && (new Set(counts).size === 1);
  // A list, not a map: a uuid's dots would be read as nested keys when stored.
  const byCreature = uniform ? null : profiles.map(({ref}, index) => ({actorRef: ref, count: counts[index]}));
  const definition = manualDefinition({document, activity, system, spell, level, notes, pool});
  if ( chosenCount ) {
    const spending = (activity.consumption.targets ?? []).find(target => (target.type === "itemUses") && (target.scaling?.mode === "amount"));
    const spendId = spending ? targetPoolId(spending, pool, names) : null;
    // Spent by the number chosen, not its fixed cost.
    if ( spendId ) definition.costs = {...definition.costs, allOf: (definition.costs?.allOf ?? []).filter(cost => cost.capability !== spendId)};
    notes.splice(0, notes.length, ...notes.filter(note => !note.endsWith(MORE_BY_HAND)));
    definition.configuration = [...(definition.configuration ?? []), {id: "summon-count", type: "number", label: "Creatures",
      required: true, min: 1, ...(number(scaling.max) ? {max: number(scaling.max)} : {}),
      effects: [{type: "spendAmount", collection: "summon", ...(spendId ? {resourceId: spendId} : {})}]}];
  }
  const rounds = (Number(system.duration?.value) || 0) * (ROUNDS[system.duration?.units] ?? 0);
  const concentration = (system.properties ?? []).includes("concentration");
  const range = rangeOf({activity, system, document, attack: null});
  // What it gains with the spell's level: Hit Points, AC, damage and healing, as expressions of the cast level. Hit
  // Dice (spent only on a rest: noted), and formulas of anything but the level, are not converted.
  const bonuses = {};
  const lost = [];
  for ( const [name, formula] of Object.entries(activity.bonuses ?? {}) ) {
    if ( !formula || (String(formula).trim() === "0") ) continue;
    // A spell's by its level; a class feature's by its summoner (a Steel Defender's: Intelligence + 5 per artificer level).
    // A magic item's by its wielder, with the ability its use names (a Dancing Sword's "Activate Sword: Dexterity": `@mod`).
    const wielded = (!spell && (document.type !== "feat")) ? Object.entries(ABILITY_WORDS).find(([, pattern]) => pattern.test(activity.name ?? ""))?.[0]
      : null;
    const expression = ["hp", "ac", "attackDamage", "saveDamage", "healing"].includes(name)
      ? (summonBonus(formula, level, spell) ?? ((document.type === "feat") ? formulaExpression(formula, {scales})
        : (wielded ? formulaExpression(String(formula).replace(/@mod\b/g, `@abilities.${wielded}.mod`), {scales}) : null))) : null;
    if ( expression ) bonuses[name] = expression;
    else lost.push(name);
  }
  if ( lost.includes("hd") ) notes.push("summon: its Hit Dice by the spell's level are not added (spent only on a rest)");
  if ( lost.some(name => name !== "hd") ) notes.push(`summon: what it gains with the spell's level (${lost.filter(name => name !== "hd").join(", ")}) is not added`);
  const rules = SUMMON_RULES[identifierOf(document)] ?? {};
  const limit = (rules.limit === "uses") ? formulaExpression(String(system.uses?.max ?? ""), {scales}) : rules.limit;
  const timing = {count: uniform ? counts[0] : 1, ...(byCreature ? {counts: byCreature} : {}), ...(rounds ? {rounds} : {}),
    ...(concentration ? {concentration: true} : {}),
    ...(Object.keys(bonuses).length ? {bonuses} : {}), ...((spell && level) ? {spellLevel: level} : {}),
    // A spell's or class feature's creature attacks with its summoner's spell attack bonus (dnd5e `match.attacks`,
    // matchedAttack); a magic item's (Dancing Sword: its wielder's attack) keeps its own.
    ...((activity.match?.attacks && (spell || (document.type === "feat"))) ? {match: {attacks: true}} : {}), ...(limit ? {limit} : {}),
    ...(rules.endsWithSummoner ? {endsWithSummoner: true} : {})};
  // A creature by its summoner's level (a Steel Defender from 3rd, its improved form from 15th: `summon.identifier`'s class).
  const levelOf = profile => (((profile.level?.min ?? null) !== null) || ((profile.level?.max ?? null) !== null)
    ? {level: {...(profile.level.min != null ? {min: profile.level.min} : {}), ...(profile.level.max != null ? {max: profile.level.max} : {}),
      ...(activity.summon?.identifier ? {class: activity.summon.identifier} : {})}} : {});
  const gains = rules.choose ? summonerChoice(rules.choose, concentration) : null;
  if ( gains ) Object.assign(definition, {effects: [...(definition.effects ?? []), ...gains.effects],
    configuration: [...(definition.configuration ?? []), ...gains.configuration]});
  if ( profiles.length === 1 ) return {...definition, ...(range ? {range} : {}), summon: {actorRef: profiles[0].ref, ...timing}};
  const choice = {id: "summon-creature", type: "select-one", label: "Creature", required: true,
    options: profiles.map(({profile, ref}) => ({id: ref, label: profile.name || names[String(profile.uuid).split(".").pop()]
      || names[String(ref).split(".").pop()] || ref,
      // A spell's profile level is its slot's (Find Steed): not its creature's level.
      ...(spell ? {} : levelOf(profile))}))};
  // A magic item whose table picks the creature (a Bag of Tricks): its use draws it (`draw`, Item#use).
  const table = TABLE_LINK.exec(String(system.description?.value ?? ""))?.[1];
  const drawn = table && tables[table] ? {draw: {table: tables[table], choiceId: choice.id}} : {};
  return {...definition, ...(range ? {range} : {}), configuration: [...(definition.configuration ?? []), choice],
    summon: {choiceId: choice.id, ...timing}, ...drawn};
}

/** The 2024 common actions an activity may take by name (Cunning Action's Dash, Disengage or Hide). */
const COMMON_ACTIVITIES = Object.freeze(["dash", "disengage", "dodge", "hide"]);

/**
 * Activities that take common actions by their 2024 text rather than their name, by identifier and activity name:
 * with a Focus Point, Patient Defense is Disengage and Dodge and Step of the Wind is Disengage and Dash (dnd5e gives
 * one effect of each); a Shadow's Shadow Stealth is the Hide action.
 */
const COMMON_BY_TEXT = Object.freeze({
  "monks-focus/Patient Defense (Focus Point)": ["disengage", "dodge"],
  "monks-focus/Step of the Wind": ["disengage", "dash"],
  "shadow-stealth/Expend Use": ["hide"],
  "hasten/Expend Use": ["dash", "disengage"]
});

/** Activities that take one common action of several (a goblin's Nimble Escape: Disengage or Hide): an Action each. */
const COMMON_CHOICES = Object.freeze({
  "nimble-escape/Expend Use": ["disengage", "hide"],
  "deathless-agility/Expend Use": ["dash", "disengage"]
});

/** The common actions a utility activity takes, by its text or its name; null for none. */
function commonIdsOf(document, activity) {
  if ( activity.type !== "utility" ) return null;
  const key = `${identifierOf(document)}/${activity.name}`;
  const id = String(activity.name ?? "").split(":").pop().trim().toLowerCase();
  return COMMON_BY_TEXT[key] ?? COMMON_CHOICES[key]?.slice(0, 1) ?? (COMMON_ACTIVITIES.includes(id) ? [id] : null);
}

/** WildPath's own rules of a common action (Dash's extra Speed, Disengage's effect, Hide's check), without its cost. */
function commonRules(id) {
  const {id: _id, label: _label, costs: _costs, ...rules} = commonAction({uuid: ""}, id).system.definition;
  return rules;
}

/**
 * A utility activity that takes a common action ("Dash", "Cunning Action: Disengage" as a Bonus Action): that
 * action's own rules at the activity's cost. Null for any other activity.
 */
function commonActivity({document, activity, system, spell, level, pool}, ids=commonIdsOf(document, activity)) {
  if ( !ids ) return null;
  // Several at once (Step of the Wind): each one's rules, and all their effects.
  const rules = ids.map(commonRules);
  return {...manualDefinition({document, activity, system, spell, level, notes: [], pool}), ...Object.assign({}, ...rules),
    effects: rules.flatMap(rule => rule.effects ?? [])};
}

/**
 * A creature's move written as a use ("moves up to half its Swim Speed without provoking Opportunity Attacks": a Giant
 * Seahorse's Bubble Dash; "flies up to half its Fly Speed": a Roc's Swoop): a Dash of that much (its Speed once more, or
 * half of it: `speed.dash` 0.5), Disengage when it provokes none, and Hide when it "can take the Hide action" after (a
 * Weretiger's Prowl). Null for anything else, and for a move that ends in an attack (moveThenAttack's) or a reaction's.
 * shortcut: its movement mode ("Swim", "Fly") and "while underwater" are not checked: every Speed gains it; Hide is
 * rolled when it is used, not after the move.
 */
const MOVE_USE = /\b(?:moves|flies|swims) up to (half )?its (?:\w+ )?Speed\b([^.]*?\bwithout provoking (?:&(?:amp;)?Reference\[)?Opportunity ?Attacks)?/iu;
function moveUse({document, activity, system, spell, level, pool}) {
  if ( (activity.type !== "utility") || (pick(activity, system, "activation").type === "reaction") ) return null;
  const text = plainText(document);
  const match = MOVE_USE.exec(text);
  // "..., and it makes one [[/item .mmBite]] attack" (a link's dot is no sentence's end).
  if ( !match || /^[^.]*?,? (?:and|then) (?:it )?(?:can )?makes? one\b/iu.test(text.slice(match.index + match[0].length)) ) return null;
  const hides = /\bcan take the (?:&(?:amp;)?Reference\[)?Hide\b/iu.test(text);
  const definition = commonActivity({document, activity, system, spell, level, pool}, ["dash", ...(match[2] ? ["disengage"] : []),
    ...(hides ? ["hide"] : [])]);
  if ( match[1] ) definition.effects = definition.effects.map(effect => ((effect.slug === "dashing") ? {...effect, ruleElements: effect.ruleElements
    .map(rule => ({...rule, data: {...rule.data, value: 0.5}}))} : effect));
  return definition;
}

/**
 * "You take the Dash action, and until the spell ends, you can take that action again as a Bonus Action" (Expeditious
 * Retreat): its common action's id, else null. Its cast is that action and a marker of the spell on its caster (its
 * identifier as a status, for its duration and concentration); the action again is an Action of its own, a Bonus Action
 * that requires the marker (`requires: {hasCondition}`).
 */
const COMMON_AGAIN = /\byou take the (Dash|Disengage|Dodge|Hide) action, and until the spell ends, you can take that action again as a Bonus Action\b/iu;
const commonAgain = (document, activity) => ((activity.type === "utility") ? COMMON_AGAIN.exec(plainText(document))?.[1].toLowerCase() ?? null : null);
function commonAgainDefinition({document, activity, system, spell, level, pool, img}) {
  const id = commonAgain(document, activity);
  if ( !id ) return null;
  const duration = lastingDuration(system.duration);
  const definition = commonActivity({document, activity, system, spell, level, pool}, [id]);
  return {...definition, effects: [...definition.effects, {id: `effect-${definition.effects.length + 1}`, type: "effect", name: document.name,
    slug: identifierOf(document), ...(img ? {img} : {}), ...(duration ? {duration} : {}),
    ...((system.properties ?? []).includes("concentration") ? {concentration: true} : {}), ruleElements: []}]};
}

/**
 * The escape DC of what an Item grapples or restrains with: its "Escape Check" activity's DC (a number, a creature's
 * passive Athletics `@skills.ath.passive`, or 8 + proficiency + an ability's modifier), else "escape DC 13" in its text.
 */
function escapeDCOf(document, {creature=null, saveDC=null}={}) {
  const check = Object.values(document.system?.activities ?? {}).find(activity => (activity.type === "check") && /escape/i.test(activity.name ?? ""));
  const dc = check?.check?.dc ?? {};
  const passive = /^@skills\.(\w+)\.passive$/.exec(String(dc.formula ?? "").trim());
  const written = number(dc.formula) ?? (passive ? creature?.passive?.(passive[1]) : null)
    ?? (dc.calculation ? saveDC?.(dc.calculation)?.value : null);
  if ( Number.isFinite(written) ) return written;
  const text = /\bescape DC (\d+)/i.exec(plainText(document))
    ?? /(?:\bDC (\d+) Strength \(Athletics\)|\[\[\/skill ath (\d+)\]\]) check,? freeing\b/i.exec(plainText(document));
  return text ? Number(text[1] ?? text[2]) : null;
}

/**
 * "can take an action to make a [DC N] Strength (Athletics) check [against your spell save DC]", with the roll written
 * out or inline ([[/check ability=str skill=ath dc=@attributes.spell.dc]], [[/skill ath 10]]): how a held creature
 * frees itself (2024 Web, Entangle, Iron Bands, a Net).
 */
const ESCAPE_CHECK = /\b(?:can|must) take an action to make an? (?:DC (\d+) )?(?:\w+ \(([\w ]+)\)|\[\[\/(check|skill) ([^\]]+)\]\]) check\b( against (?:your|its) spell save DC)?/iu;

/**
 * The check its text frees a held creature with (ESCAPE_CHECK): its skill (a WildPath id, or null), its written DC (or
 * `spell` for its caster's spell save DC), whether a success ends the whole spell ("On a success, the spell ends":
 * Ensnaring Strike) and whether another creature may make it for the held one ("or a creature within 5 feet of it",
 * "freeing itself or another creature": the hold's `escapeByOthers`), and whether its outcome does more ("On a successful check, the item is destroyed", "On a failed
 * check, any further attempts ... automatically fail": Iron Bands). Null for none.
 */
function escapeCheckOf(document) {
  const text = plainText(document);
  const check = ESCAPE_CHECK.exec(text);
  if ( !check ) return null;
  const inline = check[4] ?? "";
  const rolled = (check[3]?.toLowerCase() === "skill") ? inline.split(" ") : [];
  const name = DND_SKILLS[/\bskill=(\w+)/u.exec(inline)?.[1] ?? rolled[0]] ?? check[2];
  const rest = text.slice(check.index + check[0].length);
  const sentence = `${text.slice(text.lastIndexOf(".", check.index) + 1, check.index)} ${rest.split(".")[0]}`;
  return {skill: Object.values(DND_SKILLS).includes(name) ? slugify(name) : null,
    dc: number(check[1] ?? /\bdc=(\d+)/u.exec(inline)?.[1] ?? rolled[1])
      ?? ((check[5] || /\bdc=@attributes\.spell\.dc\b/u.test(inline)) ? "spell" : null),
    endsAll: /^[^.]*\.\s*(?:On a success|If it succeeds), the spell ends\b/iu.test(rest),
    others: /\b(?:or a creature|creature that can touch|or another creature)\b/iu.test(sentence),
    aftermath: /\bOn a (?:successful|failed) check, [^.]*\b(?:is destroyed|automatically fail)/iu.test(rest.split(".").slice(0, 3).join("."))};
}

/**
 * What a hold an Item grapples or restrains with carries for its creature to end it (the common Escape reads it): its
 * escape DC (escapeDCOf, else its text's check: N, or its save's DC for "your spell save DC", the number when written,
 * else `"save"`, the DC its save resolves to when applied); that check's skill, the only one it rolls (`escapeSkills`);
 * `escapeEndsAll` when a success ends the spell; `escapeByOthers` when another creature may make that check for it
 * (the common Free); and `endsWhen: "leavesArea"` for "the ... condition while in the webs" (its lasting area's:
 * foundry-v14-persistent-areas.mts). Null with no escape. Destroying what holds it ("Destroying the Net ... frees") is noted.
 */
function holdMetadata(document, {creature=null, saveDC=null, save=null, notes=null}={}) {
  const check = escapeCheckOf(document);
  const spellDC = (check?.dc === "spell") || /\bescape DC equal to (?:your|its) spell save DC\b/iu.test(plainText(document));
  const escapeDC = escapeDCOf(document, {creature, saveDC}) ?? ((check?.dc !== "spell") ? check?.dc : null)
    ?? ((spellDC && save) ? (number(save.dc?.value) ?? "save") : null);
  if ( escapeDC == null ) return null;
  // Damaging what holds it (a Net's AC and Hit Points) is no check: by hand.
  const destroyed = "escape: destroying what holds it is by hand";
  if ( /\b(?:destroying|reducing) the \w+\b[^.]*\bfrees\b|\buntil the \w+ is destroyed\b/iu.test(plainText(document)) && notes
    && !notes.includes(destroyed) ) notes.push(destroyed);
  const aftermath = "escape: what its check does besides freeing it is by hand";
  if ( check?.aftermath && notes && !notes.includes(aftermath) ) notes.push(aftermath);
  return {escapeDC, ...(check?.skill ? {escapeSkills: [check.skill]} : {}), ...(check?.endsAll ? {escapeEndsAll: true} : {}),
    ...(check?.others ? {escapeByOthers: true} : {}),
    ...(/\bcondition while in the \w+/iu.test(plainText(document)) ? {endsWhen: "leavesArea"} : {})};
}

/** Effects named as a common action's own (Step of the Wind's "Disengaged"): that action's effect. */
const COMMON_EFFECTS = Object.freeze({Disengaged: "disengage", Dashing: "dash", Dodging: "dodge"});

const rollModeRule = (id, domains, mode, predicate=null) => ({schemaVersion: 1, id, type: "RollMode",
  data: {domains, mode}, ...(predicate ? {predicate} : {})});
const NEXT_ATTACK_DISADVANTAGE = {endsWhen: "attacks", ruleElements: [rollModeRule("next-attack", ["attack"], "disadvantage")]};

/**
 * Rules for dnd5e effects left without changes, by their name wherever they come from (a spell, a stat block's
 * action, a staff's or rod's cast), from the 2024 texts:
 * - "the target has Disadvantage on the next attack roll it makes" (an Ettin's Morningstar, a Fire Giant's Hammer
 *   Throw, Ray of Enfeeblement on a success): its next attack ends it.
 * - "Advantage on attack rolls" (a Frost Giant's War Cry); "Disadvantage on saving throws to maintain Concentration"
 *   (a black dragon's Cloud of Insects); "a −2 penalty to AC" (a green dragon's Noxious Miasma).
 * - Barkskin: "an Armor Class of 17 if its AC is lower than that" (an ArmorClass floor).
 * - Protection from Evil and Good: Aberrations, Celestials, Elementals, Fey, Fiends and Undead have Disadvantage on
 *   attack rolls against it. shortcut: its Charmed and Frightened protection from them is by hand; upgrade when a
 *   ConditionImmunity reads its condition's source.
 * - See Invisibility: it sees the Invisible as far as it sees (a mile).
 */
const EFFECTS_BY_NAME = Object.freeze({
  "Next Attack: Disadv.": NEXT_ATTACK_DISADVANTAGE,
  "Disadv.: Attacks": NEXT_ATTACK_DISADVANTAGE,
  "Brief Enfeeblement": NEXT_ATTACK_DISADVANTAGE,
  "Attack: Advantage": {ruleElements: [rollModeRule("attack-advantage", ["attack"], "advantage")]},
  "Concentration Disadvantage": {ruleElements: [rollModeRule("concentration-disadvantage", ["concentration"], "disadvantage")]},
  "Damaged: −2 AC": {ruleElements: [{schemaVersion: 1, id: "ac-penalty", type: "Modifier",
    data: {domains: ["defense.ac"], modifierType: "untyped", value: -2}}]},
  "Bark-like Skin": {ruleElements: [{schemaVersion: 1, id: "barkskin", type: "ArmorClass", data: {value: 17, minimum: true}}]},
  "Protected": {ruleElements: [rollModeRule("protected", ["attacked"], "disadvantage", {oneOf: {path: "attack.attackerType",
    values: ["aberration", "celestial", "elemental", "fey", "fiend", "undead"]}})]},
  // Dispel Evil and Good: "Celestials, Elementals, Fey, Fiends, and Undead have Disadvantage on attack rolls against you".
  "Dispelling Evil and Good": {duration: {value: 10, units: "rounds"}, ruleElements: [rollModeRule("dispelling", ["attacked"], "disadvantage", {oneOf: {path: "attack.attackerType",
    values: ["celestial", "elemental", "fey", "fiend", "undead"]}})]},
  // Stinking Cloud (2024): "While Poisoned in this way, the creature can't take an action or a Bonus Action" (that turn).
  "Stinking Poison": {duration: {value: 0, units: "turns", expiry: "turnEnd"}, ruleElements: [{schemaVersion: 1, id: "stinking-poison",
    type: "ResourceCap", data: {resources: ["action", "bonus"], maximum: 0}}]},
  // Starry Wisp (2024): "the target emits Dim Light in a 10-foot radius and can't benefit from the Invisible condition until
  // the end of your next turn" (an immune condition is suppressed).
  "Illuminated": {duration: {value: 1, units: "rounds", expiry: "sourceTurnEnd"}, ruleElements: [
    {schemaVersion: 1, id: "illuminated-light", type: "GrantLight", data: {bright: 0, dim: 10}},
    {schemaVersion: 1, id: "illuminated-visible", type: "ConditionImmunity", data: {conditions: ["invisible"]}}]},
  "See Invisibility": {ruleElements: [{schemaVersion: 1, id: "see-invisibility", type: "GrantSense",
    data: {sense: "seeInvisibility", range: 5280}}]},
  "Disadv.: Attacks & Checks": {ruleElements: [rollModeRule("attacks-checks", ["attack", "check"], "disadvantage")]},
  "Attacks: Disadvantage": {ruleElements: [rollModeRule("attacks", ["attack"], "disadvantage")]},
  "Adv: Attacks & Saves": {ruleElements: [rollModeRule("attacks-saves", ["attack", "save"], "advantage")]},
  "Bolstered: Test Advantage": {ruleElements: [rollModeRule("d20-tests", ["attack", "check", "save"], "advantage")]},
  // Acid Arrow: "2d4 Acid damage at the end of its next turn": at the end of its creature's turn, before the end of its
  // caster's next one (V14 starts the effect on the caster's turn). shortcut: the later damage does not grow with the
  // slot (+1d4 a level above 2); upgrade when an effect's trigger reads the cast level it was applied at.
  "Lingering Acid": {duration: {value: 1, units: "rounds", expiry: "turnEnd"}, ruleElements: [{schemaVersion: 1, id: "lingering-acid",
    type: "Trigger", data: {kind: "automation", event: "turn.ended", action: {schemaVersion: 1, id: "action:lingering-acid", label: "Lingering Acid",
      costs: {allOf: []}, damage: [{id: "acid", expression: {type: "dice", number: 2, faces: 4}, damageType: "acid", provenance: "spell-base"}]}}}]},
  // Resurrection's Taxing Cast: "Until you finish a Long Rest, you can't cast spells again, and you have Disadvantage on
  // D20 Tests". On its caster, whoever it revives.
  "Spell Taxed": {appliesTo: "source", restsLeft: 1, ruleElements: [
    rollModeRule("spell-taxed", ["attack", "save", "check", "initiative"], "disadvantage"),
    {schemaVersion: 1, id: "spell-taxed-casting", type: "Forbid", data: {actions: {tagsAny: ["spell"]}}}]},
  // "can't take Reactions".
  "No Reaction": {ruleElements: [{schemaVersion: 1, id: "no-reaction", type: "ResourceCap", data: {resources: ["reaction"], maximum: 0}}]},
  "Cursed: No Reaction": {ruleElements: [{schemaVersion: 1, id: "no-reaction", type: "ResourceCap", data: {resources: ["reaction"], maximum: 0}}]},
  // Shocking Grasp (2024): "it can't make Opportunity Attacks until the start of its next turn" (the engine's own slug).
  "Shocked": {slug: "no-opportunity-attacks", duration: {value: 1, units: "rounds", expiry: "turnStart"}, ruleElements: []},
  // Aim, a Scout Captain's: "Advantage on its next attack roll".
  "Aiming: Attack Advantage": {endsWhen: "attacks", ruleElements: [rollModeRule("next-attack", ["attack"], "advantage")]},
  // Sap (weapon mastery), Pesky Swarm: "Disadvantage on its next attack roll".
  "Target: Disadvantage": NEXT_ATTACK_DISADVANTAGE,
  // Sanctuary (2024): "any creature who targets the warded creature with an attack roll or a damaging spell must succeed
  // on a Wisdom saving throw or either choose a new target or lose the attack or spell"; it ends when the warded creature
  // attacks. The save is at its caster's spell save DC (`fromSource`), and a failure loses the attack (`counters`).
  // shortcut: choosing a new target is losing it, and casting a spell or dealing damage do not end it; upgrade when an
  // Action can be redirected.
  "Warded": {endsWhen: "attacks", ruleElements: [{schemaVersion: 1, id: "sanctuary", type: "Trigger", data: {kind: "reaction",
    event: "action.declared", match: {phase: "interrupt", targetTokenId: "{self}", notSourceTokenId: "{self}"},
    triggerPredicate: {equals: {path: "event.data.harmsTarget", value: true}}, policy: "always",
    action: {schemaVersion: 1, id: "action:sanctuary-ward", label: "Sanctuary", costs: {allOf: []}, range: {type: "special"},
      targeting: {type: "single", required: true, count: 1}, counters: true,
      save: {ability: "wits", dc: {fromSource: true, valueExpression: {type: "add", terms: [{type: "constant", value: 8},
        {type: "proficiency-bonus"}, {type: "spellcasting-modifier"}]}}}}}}]},
  // Death Ward (2024): "The first time the target would drop to 0 Hit Points before the spell ends, the target instead drops
  // to 1 Hit Point, and the spell ends" (zeroHpFor reads it from the effect, which then ends).
  "Protection from Death": {ruleElements: [{schemaVersion: 1, id: "death-ward", type: "Trigger",
    data: {kind: "zero-hp", event: "health.zero", zeroHp: {mode: "set", hitPoints: 1}}}]},
  // Chill Touch, a Death Cultist's scythe: "can't regain Hit Points" (WildPathActor#_preUpdate keeps them where they are).
  "Blocked Healing": {duration: {value: 1, units: "rounds", expiry: "turnEnd"},
    ruleElements: [{schemaVersion: 1, id: "no-healing", type: "ResourceCap", data: {resources: ["healing"], maximum: 0}}]},
  "Healing Restriction": {ruleElements: [{schemaVersion: 1, id: "no-healing", type: "ResourceCap", data: {resources: ["healing"], maximum: 0}}]},
  // "<Type> Protection": Resistance to that damage (an Armor or Potion of Resistance's choice).
  ...Object.fromEntries(["acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic", "radiant",
    "slashing", "thunder"].map(type => [`${type[0].toUpperCase()}${type.slice(1)} Protection`,
    {ruleElements: [{schemaVersion: 1, id: `${type}-resistance`, type: "GrantResistance", data: {damageTypes: [type]}}]}])),
  // An Ancient Black Dragon's Cloud of Insects: "Disadvantage on saving throws to maintain Concentration".
  "Clouded": {ruleElements: [rollModeRule("concentration-disadvantage", ["concentration"], "disadvantage")]},
  // Arms of Hadar: "it can't take Reactions until the start of its next turn".
  "No Reactions": {ruleElements: [{schemaVersion: 1, id: "no-reaction", type: "ResourceCap", data: {resources: ["reaction"], maximum: 0}}]},
  // A Kuo-toa Monitor's, a Bone Whip's: "it can't make Opportunity Attacks" (dnd5e's duration).
  "Whipped: No Opportunity Attacks": {slug: "no-opportunity-attacks", ruleElements: []},
  "No Opportunity Attacks": {slug: "no-opportunity-attacks", ruleElements: []},
  // A Psychic Gray Ooze's: "Disadvantage on Intelligence saving throws".
  "Save Disadvantage: Intelligence": {ruleElements: [rollModeRule("int-saves", ["save.intellect"], "disadvantage")]},
  // Regenerate: "regains 1 Hit Point at the start of each of its turns".
  "Regenerating": {ruleElements: [{schemaVersion: 1, id: "regenerating", type: "Trigger", data: {kind: "automation", event: "turn.started",
    action: {schemaVersion: 1, id: "action:regenerating", label: "Regenerate", costs: {allOf: []},
      healing: [{id: "healing-1", expression: {type: "constant", value: 1}, healingType: "healing"}]}}}]},
  // A Potion of Climbing: "a Climb Speed equal to your Speed". shortcut: its Advantage on Athletics checks to climb is by
  // hand; upgrade when a check knows it is a climb.
  "Climber": {ruleElements: [{schemaVersion: 1, id: "climber", type: "GrantMovement",
    data: {mode: "climb", distance: {type: "context", path: "actorSystem.resources.movement.max"}}}]},
  // A Potion of Flying: "a Fly Speed equal to your Speed and can hover".
  "Flyer": {ruleElements: [{schemaVersion: 1, id: "flyer", type: "GrantMovement",
    data: {mode: "fly", distance: {type: "context", path: "actorSystem.resources.movement.max"}, hover: true}}]},
  // A Broom of Flying: "a Fly Speed of 50 feet"; 30 feet carrying over 200 pounds. It hovers.
  "Riding Broom (Low Weight)": {ruleElements: [{schemaVersion: 1, id: "broom", type: "GrantMovement", data: {mode: "fly", distance: 50, hover: true}}]},
  // Prayer of Healing: "a target can't regain Hit Points from it again until it finishes a Long Rest" (dnd5e gives it no
  // duration). shortcut: refusing the spell on a creature that has it is by hand.
  "Healed by Prayer": {restsLeft: 1, ruleElements: []},
  // Glibness: "When you make a Charisma check, you can replace the number you roll with 15".
  "Glib": {ruleElements: [{schemaVersion: 1, id: "glib", type: "RollOutcome", data: {domains: ["check.presence"], outcome: "minimum-natural",
    threshold: 15}}]},
  "Riding Broom (High Weight)": {ruleElements: [{schemaVersion: 1, id: "broom", type: "GrantMovement", data: {mode: "fly", distance: 30, hover: true}}]},
  // Draconic Flight: "a Fly Speed equal to your Speed". shortcut: its end on the Incapacitated condition is by hand.
  "Draconic Flight": {ruleElements: [{schemaVersion: 1, id: "draconic-flight", type: "GrantMovement",
    data: {mode: "fly", distance: {type: "context", path: "actorSystem.resources.movement.max"}}}]},
  // Befuddlement: "can't cast spells or take the Magic action" (a magic item's Actions are tagged `magical`). shortcut:
  // its repeat save every 30 days, and its end by Greater Restoration or Heal, are by hand.
  "Befuddled": {ruleElements: [{schemaVersion: 1, id: "befuddled", type: "Forbid", data: {actions: {tagsAny: ["spell", "magical"]}}}]},
  // A lit Candle of Invocation: Dim Light in a 30-foot radius and "Advantage on D20 Tests" within it. shortcut: on its
  // bearer, not those in its light; a Cleric's or Druid's slotless level 1 spells in it are by hand.
  "Lit Candle of Invocation": {ruleElements: [rollModeRule("d20-tests", ["attack", "check", "save"], "advantage"),
    {schemaVersion: 1, id: "candle-light", type: "GrantLight", data: {bright: 0, dim: 30}}]},
  // Resilient Sphere (a Cube of Force's too): nothing from outside affects its creature, and it can't damage anything
  // outside. shortcut: rolling the sphere at half Speed, and Disintegrate ending it, are by hand.
  "Enclosed in Sphere": {ruleElements: [{schemaVersion: 1, id: "sphere-unaffected", type: "Unaffected", data: {actions: {}}},
    {schemaVersion: 1, id: "sphere-sealed", type: "Forbid", data: {actions: {any: [{tagsAny: ["attack"]},
      {tagsAny: ["acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic", "radiant",
        "slashing", "thunder"].map(type => `damage:${type}`)}]}}}]},
  // Imprisonment's Burial, Hedged Prison and Minimus Containment: sealed away, nothing gets in or out. shortcut: a
  // creature that saves being immune to the spell for 24 hours is by hand.
  ...Object.fromEntries(["Burial", "Hedged Prison", "Minimus Containment"].map(name => [name, {ruleElements: [
    {schemaVersion: 1, id: "imprisoned-unaffected", type: "Unaffected", data: {actions: {}}},
    {schemaVersion: 1, id: "imprisoned-sealed", type: "Forbid", data: {actions: {}}}]}])),
  // A Feather Token's Anchor: "the vessel can't be moved by any means". shortcut: its moves are capped; being pushed or
  // pulled anyway is by hand.
  "Anchor": {ruleElements: [{schemaVersion: 1, id: "anchored", type: "ResourceCap", data: {resources: ["movement"], maximum: 0}}]},
  // Irresistible Dance, on a successful save: "dances comically until the end of its next turn, during which it must spend
  // all its movement to dance in place".
  "Short Dance": {saveOutcomePolicy: "success", duration: {value: 1, units: "rounds", expiry: "turnEnd"},
    ruleElements: [{schemaVersion: 1, id: "short-dance", type: "ResourceCap", data: {resources: ["movement"], maximum: 0}}]},
  // On a failure, beside its Charmed condition: all its movement spent dancing, "Disadvantage on Dexterity saving throws and
  // attack rolls, and other creatures have Advantage on attack rolls against it".
  "Irresistible Dance": {ruleElements: [{schemaVersion: 1, id: "dancing", type: "ResourceCap", data: {resources: ["movement"], maximum: 0}},
    rollModeRule("dancing-clumsy", ["save.agility", "attack"], "disadvantage"), rollModeRule("dancing-exposed", ["attacked"], "advantage")]},
  // Manacles: "While bound, a creature has Disadvantage on attack rolls". shortcut: Restrained when chained in place, and
  // escaping or bursting them (its own checks), are the GM's.
  "Manacled": {ruleElements: [rollModeRule("manacled", ["attack"], "disadvantage")]},
  // Dimensional Shackles: "can't use any method of extradimensional movement, including teleportation or travel to a
  // different plane of existence": any Action that teleports (`teleport`, actionTags) and the spells that do. shortcut:
  // escaping or breaking them (their own checks) is the GM's.
  "Dimensionally Bound": {ruleElements: [{schemaVersion: 1, id: "dimensionally-bound", type: "Forbid", data: {actions: {tagsAny: [
    "teleport", ...["arcane-gate", "astral-projection", "blink", "dimension-door", "etherealness", "far-step", "gate",
      "misty-step", "plane-shift", "scatter", "teleport", "teleportation-circle", "thunder-step", "transport-via-plants",
      "tree-stride", "word-of-recall"].map(spell => `spell:${spell}`)]}}}]}
});

/** Uses that act on the creature or vessel they touch, though dnd5e leaves them on their user: by identifier and activity. */
const TOUCHES = new Set(["anchor-feather-token/Use", "manacles/Bind"]);

/**
 * A creature's own teleport written as a utility use (2024 Blink Dog: "teleports up to 40 feet to an unoccupied space it
 * can see"; its range is the distance), as a teleport activity. Null for anything else, and for one that moves others too
 * ("teleports itself or a willing demon": a Balor's).
 */
function utilityTeleport(document, activity, system) {
  if ( activity?.type !== "utility" ) return null;
  // Only a teleport alone: not a reaction that does more (a Mummy Lord's Whirlwind of Sand), nor an area or damage.
  if ( (pick(activity, system, "activation").type === "reaction") || pick(activity, system, "target").template?.type
    || activity.damage?.parts?.length ) return null;
  const text = plainText(document);
  // "you magically teleport up to 30 feet" (Cloud's Jaunt); "teleports itself or a willing demon within 10 feet of itself
  // up to 60 feet" (a Balor); "teleports, along with its rider, to an unoccupied space ... up to 60 feet away" (a Fey
  // Steed: its rider goes too, teleportDefinition's `withTargets`). shortcut: a Balor's demon is not taken along.
  const teleports = /\bteleports?(?:, along with (?:its|their) riders?,)? (?:\[\[lookup @target[^\]]*\]\] of itself |itself(?: or [^.]*?)? |to [^.]{0,60}?)?up to (?:\[\[lookup @range\.value[^\]]*\]\]|(\d+))/iu
    .exec(text);
  // "teleports to an unoccupied space within 5 feet of a second tree that is within 60 feet of the previous tree" (a
  // Dryad's Tree Stride): as far as both (65 feet). shortcut: that a tree is there is not checked.
  const beside = teleports ? null : /\bteleports? to an unoccupied space within (?:\[\[lookup @range\.value[^\]]*\]\]|(\d+)) feet of an? (?:[^.]|\.(?=\w))*?\bwithin (\d+) feet of\b/iu
    .exec(text);
  const found = teleports ?? beside;
  // Not one that attacks too (a Sphinx's Arcane Prowl: "and it makes one Claw attack").
  if ( !found || /\battack\b/iu.test(text.slice(found.index).split(/(?<=[.!?])\s/u)[0]) ) return null;
  const near = number(pick(activity, system, "range").value) ?? number(found[1]);
  const value = beside ? (near ?? 0) + Number(beside[2]) : near;
  return (value > 0) ? {...activity, teleport: {value, units: "ft"}} : null;
}

/**
 * A teleport of its own creature to a space within a distance (Misty Step's 30 feet, Dimension Door's 500): its cost
 * and `teleport: {distance}`. Null for one with no distance in feet (Teleport, Plane Shift), which stays by hand. One
 * that brings a willing creature (Dimension Door) or its rider (a Fey Steed) along targets it (`withTargets`), and may go
 * alone.
 */
export function teleportDefinition({document, activity, system, spell, level, notes, pool}) {
  const distance = number(activity.teleport?.value);
  if ( !(distance > 0) || ((activity.teleport?.units ?? "ft") !== "ft") ) return null;
  const manual = manualDefinition({document, activity, system, spell, level, notes, pool});
  // One creature within 5 feet: Dimension Door's "one willing creature ... within 5 feet of you"; a rider is adjacent.
  if ( /\bwilling creature\b|\balong with (?:its|their) riders?\b/i.test(plainText(document)) ) return {...manual,
    range: {type: "ranged", normal: {value: 5, unit: "ft"}},
    targeting: {type: "single", required: false, count: 1, notHostile: true, notSelf: true}, teleport: {distance, withTargets: true}};
  return {...manual, targeting: {type: "self"}, teleport: {distance}};
}

/** A summon bonus as a ValueExpression of the spell's cast level (`castLevel`): "10 * (@item.level - 4)", "(@item.level - 3)d10". */
/**
 * A summon's count worked out when cast: dnd5e's `@scaling.increase` is the slot levels above the spell's own, and
 * `@attributes.spell.mod` its caster's spellcasting modifier. Null when it does not parse.
 */
function summonCount(formula, level) {
  const text = String(formula).replace(/@scaling\.increase/g, "scalingx").replace(/@attributes\.spell\.mod/g, "spellmodx")
    .replace(/@item\.level/g, "itemlevelx").trim();
  const parsed = parseFormula(text, {variables: {itemlevelx: {type: "context", path: "castLevel"},
    scalingx: {type: "subtract", left: {type: "context", path: "castLevel"}, right: {type: "constant", value: Number(level) || 0}},
    spellmodx: {type: "spellcasting-modifier"}}});
  return parsed.ok ? parsed.expression : null;
}

/**
 * Tasha's creatures an artificer commands with a Bonus Action, by dnd5e id: a Steel Defender and its improved form ("the
 * only action it takes on its turn is the Dodge action, unless you take a bonus action on your turn to command it"; its
 * Dodge is the common action, which stays free), and a Homunculus Servant's homunculus. shortcut: an Eldritch Cannon's
 * features are its description (nothing to command yet).
 */
const COMMANDED = new Set(["tcoeSmithSteelDe", "tcoeImprovedStee", "oHIHDsxgQ8zoPyHl"]);

/**
 * How many of a feature's summons may be out at once, and whether they go when their summoner dies: one Steel Defender,
 * one Homunculus Servant (which dies with its artificer), an artillerist's Eldritch Cannons by its uses (1, 2 from 15).
 * What its summoner gains, chosen as it summons (`choose`): Summon Dragon's Draconic Spirit's Shared Resistances, "choose
 * one of its Resistances. You have Resistance to the chosen damage type until the spell ends".
 */
const SUMMON_RULES = Object.freeze({
  "steel-defender": {limit: 1},
  "homunculus-servant": {limit: 1, endsWithSummoner: true},
  "eldritch-cannon": {limit: "uses"},
  "summon-dragon": {choose: {label: "Shared Resistance", options: ["acid", "cold", "fire", "lightning", "poison"].map(type => ({id: type,
    label: `${type.charAt(0).toUpperCase()}${type.slice(1)}`, effect: {id: type, type: "effect", name: "Shared Resistance",
      img: "icons/svg/fire-shield.svg", appliesTo: "source", ruleElements: [{schemaVersion: 1, id: `shared-${type}-resistance`,
        type: "GrantResistance", data: {damageTypes: [type]}}]}}))}}
});

/** A summon's choice of what its summoner gains (SUMMON_RULES `choose`), as its effects on the summoner and that choice. */
function summonerChoice(choose, concentration) {
  return {effects: choose.options.map(option => ({...structuredClone(option.effect), ...(concentration ? {concentration: true} : {})})),
    configuration: [{id: "summoner-gains", type: "select-one", label: choose.label, required: true,
      options: choose.options.map(option => ({id: option.id, label: option.label, value: option.id})),
      effects: [{type: "keepEffect", effectIds: choose.options.map(option => option.effect.id)}]}]};
}

function summonBonus(formula, level=0, spell=true) {
  // The summoner's numbers, worked out when cast: its spellcasting modifier (a spell's `@mod`: Conjure Fey's), its Hit
  // Point maximum (Arcane Hand's), and the levels above the spell's own (`@scaling`: Conjure Elemental's dice).
  const text = String(formula).replace(/@item\.level/g, "castlevelx").replace(/@scaling\b/g, "scalingx")
    .replace(spell ? /@attributes\.spell\.mod|@mod\b/g : /@attributes\.spell\.mod/g, "spellmodx")
    .replace(/@attributes\.hp\.(?:effectiveMax|max)\b/g, "hpmaxx").trim();
  const variables = {castlevelx: {type: "context", path: "castLevel"},
    scalingx: {type: "subtract", left: {type: "context", path: "castLevel"}, right: {type: "constant", value: Number(level) || 0}},
    spellmodx: {type: "spellcasting-modifier"}, hpmaxx: {type: "resource-max", resource: "health"}};
  const terms = [];
  for ( const part of text.split(/\s*\+\s*(?![^(]*\))/) ) {
    const dice = /^\((.+)\)\s*d\s*(\d+)$/.exec(part);
    const parsed = parseFormula(dice ? dice[1] : part, {variables});
    if ( !parsed.ok ) return null;
    terms.push(dice ? {type: "dice", number: parsed.expression, faces: Number(dice[2])} : parsed.expression);
  }
  return (terms.length === 1) ? terms[0] : {type: "add", terms};
}

/** The Action of something used but not automated: its cost, its uses and, for a spell, its slot. */
function manualDefinition({document, activity, system, spell, level, notes, pool, names={}, scales={}}) {
  const definition = baseDefinition({document, activity, system, spell, notes, pool, names, scales});
  if ( spell && level && SLOT_MODES.has(system.preparation?.mode ?? "prepared") && (activity.consumption?.spellSlot !== false) ) {
    definition.configuration = slotConfiguration(level, []);
  }
  if ( spell && level && (activity.consumption?.spellSlot === false) ) definition.metadata = {...(definition.metadata ?? {}), followUp: true};
  return definition;
}

/**
 * The pool of another feature whose uses its activities spend, for a feature without uses of its own (Channel
 * Divinity's options, Cutting Words' Bardic Inspiration, Land's Aid's Wild Shape): `{id}`, named as that feature's own
 * pool is (its name), with no rule, as that feature grants it. dnd5e names it `feat:<identifier>` or by uuid.
 */
function spentPool(activities, names) {
  const target = activities.flatMap(activity => activity.consumption?.targets ?? [])
    .find(entry => (entry.type === "itemUses") && entry.target)?.target;
  const name = target ? targetName(target, names) : null;
  return name ? {id: slugify(name), notes: [], rule: null} : null;
}

/** Whether a converted definition sustains something on concentration (an effect, a lasting area, a summon, a form). */
function sustainsConcentration(definition) {
  return (definition.effects ?? []).some(effect => effect?.concentration) || Boolean(definition.area?.persistence?.concentration)
    || Boolean(definition.summon?.concentration) || Boolean(definition.transform?.concentration);
}

/** An item's limited uses as a resource pool its Actions spend, with the dnd5e recovery. */
function usesPool({document, scales}) {
  const uses = (identifierOf(document) === "wild-shape") ? WILD_SHAPE_2014.uses
    : (document.system?.uses?.max ? document.system.uses : (chargesInText(document) ?? drunkOnce(document) ?? madeOnce(document)
      ?? document.system?.uses));
  const pool = poolOf(uses, {id: slugify(document.name), label: document.name, scales});
  // A spell's pool dnd5e starts spent (Freezing Sphere's held globe, Heroes' Feast's servings) starts empty: an Action
  // of the spell fills it.
  if ( pool && (document.type === "spell") && (number(uses.spent) > 0) && (number(uses.spent) >= number(uses.max)) ) pool.rule.data.current = 0;
  return pool;
}

/** A potion whose uses dnd5e leaves empty though drinking it spends one (Potion of Mind Reading): one use, as every other potion's. */
function drunkOnce(document) {
  const spends = Object.values(document.system?.activities ?? {}).some(activity => (activity?.consumption?.targets ?? [])
    .some(target => (target.type === "itemUses") && !target.target && !givesBack(target.value)));
  return ((document.type === "consumable") && (document.system?.type?.value === "potion") && spends) ? {max: "1", recovery: []} : null;
}

/** An item a creature is made from over days, used up when it is done (2024 Manual of Golems: "the book is consumed"): one use. */
function madeOnce(document) {
  const crafts = Object.values(document.system?.activities ?? {}).some(activity => (activity?.type === "summon")
    && (activity.activation?.type === "special"));
  return (crafts && /\bis consumed\b/iu.test(plainText(document))) ? {max: "1", recovery: []} : null;
}

/** Charges its text gives when dnd5e leaves its uses empty though its activities spend them (2024 Dragon Orb: "The orb has 7
 *  charges and regains 1d4 + 3 expended charges daily at dawn"). Null otherwise. */
function chargesInText(document) {
  const spends = Object.values(document.system?.activities ?? {}).some(activity => (activity.consumption?.targets ?? [])
    .some(target => (target.type === "itemUses") && !target.target && !givesBack(target.value)));
  const text = spends ? plainText(document) : "";
  const max = /\bhas (\d+) charges\b/iu.exec(text)?.[1];
  if ( !max ) return null;
  const regain = /\bregains? (\d+d\d+(?:\s*[+-]\s*\d+)?|\d+) expended charges daily at dawn\b/iu.exec(text)?.[1];
  return {max, recovery: regain ? [{period: "dawn", type: "formula", formula: regain}] : []};
}

/** An activity's own uses ("3/Day each" spells, a once-a-day option) as a pool of its own (G4). */
function activityPool({document, activity, scales={}, spellName=null}) {
  // Each activity's own pool: by its name, else by the spell it casts (2/Day each), else by its id.
  const key = activity?.name || String(activity?.spell?.uuid ?? "").split(".").pop() || activity?._id || activity?.type || "use";
  return poolOf(activity?.uses, {id: `${slugify(document.name)}-${slugify(key)}`,
    label: `${document.name} (${activity?.name || spellName || key})`, scales});
}

/** Limited uses (`{max, recovery}`) as a GrantResource pool with the dnd5e recovery and Recharge. */
function poolOf(uses, {id, label, scales}) {
  if ( !uses?.max ) return null;
  const notes = [];
  const maximum = formulaExpression(uses.max, {scales});
  if ( !maximum ) notes.push(`uses: maximum "${uses.max}" not converted`);
  // Older dnd5e data (before 4.0) stores the recovery period as a plain string.
  const recoveries = Array.isArray(uses.recovery) ? uses.recovery : (uses.recovery ? [{period: uses.recovery}] : []);
  // A full refill on its rest; a partial one ("regain one use on a Short Rest", "1d6 + 1 charges at dawn") is `regain`.
  const periods = recoveries.filter(entry => !["formula", "loseAll"].includes(entry.type) && (entry.period !== "recharge"))
    .map(entry => entry.period);
  const recovery = RECOVERY[periods.includes("sr") ? "sr" : periods[0]] ?? "none";
  const regain = {};
  for ( const entry of recoveries.filter(each => each.type === "formula") ) {
    const rest = ["shortRest", "longRest"].includes(RECOVERY[entry.period]) ? RECOVERY[entry.period] : null;
    const amount = rest ? formulaExpression(String(entry.formula ?? ""), {scales}) : null;
    if ( amount ) regain[rest] = (amount.type === "constant") ? amount.value : amount;
    else notes.push(`uses: regaining "${entry.formula}" (${entry.period}) not converted`);
  }
  // Recharge 5-6: rolled at the start of the creature's turn.
  const recharge = Number(recoveries.find(entry => entry.period === "recharge")?.formula);
  return {id, notes, rule: {schemaVersion: 1, id: `${id}-uses`, type: "GrantResource",
    data: {resourceId: id, label, maximum: maximum ?? 1, recovery, ...(recharge >= 2 && recharge <= 6 ? {recharge} : {}),
      ...(Object.keys(regain).length ? {regain} : {})}}};
}

/** A consumption value that gives back ("-1", "-@scale.barbarian.rage", "0 - @scaling"). */
const givesBack = value => /^(-|0\s*-)/.test(String(value ?? "").trim());

/**
 * An activity used when its creature rolls Initiative that gives a pool back (2024 Persistent Rage: all Rage; Uncanny
 * Metabolism: all Focus Points and a heal; Archdruid: a Wild Shape use) as an automatic Trigger on `initiative.rolled`.
 * It runs while a pool it gives back is below its maximum and its own uses are not spent. Null otherwise.
 * shortcut: "you can" is automatic whenever that holds.
 */
function initiativeTrigger({document, activity, system, spell, level, scales, notes, pool, names, saveDC, spellDC, creature, beasts}) {
  const targets = activity?.consumption?.targets ?? [];
  if ( !/initiative/i.test(`${activity?.name ?? ""} ${activity?.activation?.condition ?? ""}`) || !targets.some(target => givesBack(target.value)) ) {
    return null;
  }
  const own = [];
  const definition = (ACTIVITIES.has(activity.type)
    ? convertActivity({document, activity, system, spell, level, scales, notes: own, pool, saveDC, spellDC, creature, beasts, names}) : null)
    ?? manualDefinition({document, activity, system, spell, level, notes: own, pool, names, scales});
  if ( own.some(note => note.startsWith("consumption:")) || !definition.restores?.length ) return null;
  notes.push(...own);
  const predicate = {all: [{any: definition.restores.map(entry => ({poolBelowMax: entry.resourceId}))},
    ...(definition.costs?.allOf ?? []).map(cost => ({not: {poolEmpty: cost.capability}}))]};
  return {schemaVersion: 1, id: `initiative-${slugify(activity.name || "recharge")}`, type: "Trigger", data: {kind: "automation",
    event: "initiative.rolled", predicate, action: {...definition, label: activity.name || document.name, range: {type: "self"},
      targeting: {type: "self"}, configuration: [...(definition.configuration ?? []), useChoice(activity.name || document.name)]}}};
}

/** "You can": its creature is asked (its Item's reaction policy may say Always or Never), and may let it be. */
const useChoice = label => ({id: "use", type: "option", label, required: true, defaultValue: "use",
  options: [{id: "use", label: "Use it", value: "use"}, {id: "decline", label: "Not now", value: "decline"}],
  effects: [{type: "decline"}]});

/**
 * A save or damage its creature deals around itself when its own turn starts or ends (2024 Azer Sentinel's Fire Aura:
 * "At the end of each of the azer's turns, each creature of the azer's choice in a 5-foot Emanation originating from the
 * azer takes 5 (1d10) Fire damage unless the azer has the Incapacitated condition"), as an automatic Trigger whose
 * Action reaches each creature in that Emanation (`around`): only its enemies when it chooses ("of its choice").
 * Or one as it dies (a mephit's Death Burst: "explodes when it dies"; a 2024 spirit's Death Throes: "When the spirit
 * drops to 0 Hit Points"; `creature.died`).
 * Or one that reaches a creature whose own turn starts or ends in its Emanation (a Pit Fiend's Fear Aura: "any enemy
 * that starts its turn in the aura"; Stony Lethargy: "When a creature starts its turn within 10 feet of the spirit, the
 * spirit can target it"; `around.on: "others"`). A success that makes it immune for 24 hours marks it so
 * (`metadata.immuneTo`). Not one that works only somewhere ("While underwater", an Aboleth's Mucus Cloud), nor a
 * target's next turn.
 */
function turnAreaTrigger({document, activity, system, spell, level, scales, notes, pool, names, saveDC, spellDC, creature, beasts}) {
  if ( !["save", "damage"].includes(activity?.type) ) return null;
  // dnd5e keeps who it reaches ("any enemy that starts its turn in the aura") and when ("when it dies") on the activity.
  // Its 2024 stat block's lookups ("any [[lookup @target.affects.type]] that starts its turn within [[lookup
  // @target.template.size]] feet") read as words, so their dots end no sentence.
  const raw = `${plainText(document)} ${activity.target?.affects?.special ?? ""} ${activity.activation?.condition ?? ""}`;
  // The books' curly apostrophe ("the spirit’s turns") reads as a straight one.
  const text = raw.replace(/\[\[lookup [^\]]*\]\](?:\{[^}]*\})?/gu, "it").replace(/’/gu, "'");
  // Or "When a creature starts its turn within 10 feet of the spirit, the spirit can target it" (Stony Lethargy).
  const whenOthers = /\bWhen an? ([^.]{1,80}?) (starts|ends) its turn within \d+ feet\b/iu.exec(text);
  const others = /\b(?:any|each) ([^.]{1,80}?) that (starts|ends) its turn (?:in|within)\b/iu.exec(text) ?? whenOthers;
  const own = others ? null : /\b(?:at|by) the (start|end) of (?:each of )?(?:its|their|your|the (?!target)[^.,]{1,60}?'s) turns?\b/iu.exec(text);
  // Or as it dies ("The mephit explodes when it dies": a Death Burst; "When the spirit drops to 0 Hit Points": Death Throes).
  const dies = !others && !own && /\bwhen (?:it|the [^.,]{1,60}?) (?:dies|drops to 0 hit points)\b/iu.test(text);
  const when = others ? others[2].replace(/s$/u, "") : own?.[1];
  if ( (!when && !dies) || /\bnext\b/iu.test(own?.[0] ?? "") || /^\s*While\b/u.test(text) ) return null;
  // What a swallowing creature does to those inside it ("takes 17 (5d6) Acid damage at the start of each of the purple
  // worm's turns"): a damage activity dnd5e names for the swallowed.
  const swallowed = own && /\bthe (?!target)[^.,]{1,60}?'s turns?\b/iu.test(own[0]) && (activity.type === "damage")
    && /\bswallowed\b/iu.test(`${activity.name ?? ""} ${activity.target?.affects?.special ?? ""}`);
  const template = activity.target?.template ?? {};
  // Its template's, its text's ("a 10-foot Emanation", "ends its turn within 5 feet of the sphere", "each creature (other
  // than you) within 5 feet of the spirit": not "one enemy within 5 feet of it", a Faithful Hound's bite), or its range's
  // ("within [[lookup @range.value]] feet": a Sea Hag's Vile Appearance).
  const size = ["radius", "emanation", "sphere"].includes(template.type) ? Number(template.size)
    : (Number(/\b(\d+)-foot(?:-radius)? Emanation\b/iu.exec(text)?.[1])
      || Number(/\b(?:starts|ends) its turn within (\d+) feet\b/iu.exec(text)?.[1])
      || Number(/\b(?:each|any) creature\b[^.]{0,30}?\bwithin (\d+) feet of (?:it|itself|the [^.,]{1,40}?)\b/iu.exec(text)?.[1])
      || (/\bwithin \[\[lookup @range\.value\b/u.test(raw) ? Number(pick(activity, system, "range").value) : 0));
  if ( !(size > 0) && !swallowed ) return null;
  const its = [];
  const definition = convertActivity({document, activity, system, spell, level, scales, notes: its, pool, saveDC, spellDC, creature, beasts,
    names});
  if ( !definition || !(definition.damage?.length || definition.effects?.length) ) return null;
  // Its area is the Emanation, and as a Trigger it costs nothing.
  notes.push(...its.filter(note => !note.startsWith("area") && !note.startsWith("activation:")));
  const immunity = definition.save ? /\bSuccess:[^.]*\bimmune to (?:this|the|its)\b[^.]*\bfor (\d+|an?|one) (hour|minute|day)s?\b/iu.exec(text) : null;
  const immune = immunity ? [{id: `effect-${(definition.effects?.length ?? 0) + 1}`, type: "effect", name: `${document.name}: immune`,
    ruleElements: [], duration: {value: (Number(immunity[1]) || 1) * ({day: 24}[immunity[2].toLowerCase()] ?? 1),
      units: immunity[2].toLowerCase() === "minute" ? "minutes" : "hours"},
    saveOutcomePolicy: "success", metadata: {immuneTo: definition.id}}] : [];
  // "the spirit can target it" (not "can see it") is its choice: asked of its controller each time (its Item's reaction
  // policy may say Always or Never), and only of its enemies.
  const chooses = Boolean(whenOthers) && (others === whenOthers) &&/\bcan (?!see\b)\w/iu.test(text);
  const enemies = others ? (/\benem(?:y|ies)\b/iu.test(others[1]) || (activity.target?.affects?.type === "enemy") || chooses)
    : /\bof (?:its|their|your|the [^.,]{1,60}?'s) choice\b/iu.test(text);
  // What it says of whom or when that the Trigger does not check.
  for ( const qualifier of [/\(other than you\)/iu, /\bcan see(?: it\b)?/iu, /\bor the spell ends\b/iu] ) {
    const said = qualifier.exec(text)?.[0];
    if ( said ) notes.push(`trigger: "${said}" is by hand`);
  }
  // "unless the azer has the Incapacitated condition", "while (if) it doesn't have the Incapacitated condition",
  // "provided that the aberration isn't &Reference[incapacitated]".
  const predicate = /\b(?:unless (?:the|it|its) [^.]{0,60}?|(?:while|if) (?:it|the [^.]{0,60}?) (?:doesn't|does not) have the |provided (?:that )?[^.]{0,60}?(?:isn't|is not) (?:&(?:amp;)?Reference\[)?)Incapacitated\b/iu.test(text)
    ? {missingCondition: "incapacitated"} : null;
  return {schemaVersion: 1, id: `turn-${slugify(activity.name || document.name)}`, type: "Trigger", data: {kind: "automation",
    event: dies ? "creature.died" : (when.toLowerCase() === "start" ? "turn.started" : "turn.ended"), ...(predicate ? {predicate} : {}),
    around: swallowed ? {swallowed: true} : {radius: size, affects: enemies ? "enemies" : "others", ...(others ? {on: "others"} : {})},
    action: {schemaVersion: 1, id: definition.id, label: document.name, costs: {allOf: []}, ...(definition.tags ? {tags: definition.tags} : {}),
      ...(chooses ? {configuration: [useChoice(document.name)]} : {}),
      ...(definition.save ? {save: definition.save} : {}), ...(definition.damage?.length ? {damage: definition.damage} : {}),
      ...((definition.effects?.length || immune.length) ? {effects: [...(definition.effects ?? []), ...immune]} : {})}}};
}

/**
 * A swallower's regurgitating save (2024 Purple Worm: "If the purple worm takes 30 damage or more on a single turn from a
 * creature inside it, the purple worm must succeed on a DC 22 Constitution saving throw at the end of that turn or
 * regurgitate all swallowed creatures"): a Trigger the dispatcher runs after a swallowed creature's turn (`around: {on:
 * "swallowed", threshold}`), with only the save; what a failure does (out, Prone, beside it) is the dispatcher's.
 */
function regurgitateTrigger({document, activity, system, spell, level, scales, pool, names, saveDC, spellDC, creature, beasts}) {
  if ( (activity?.type !== "save") || !/regurgitate/iu.test(activity.name ?? "") ) return null;
  const threshold = Number(/\btakes (\d+) damage or more on a single turn\b/iu.exec(plainText(document))?.[1]);
  if ( !(threshold > 0) ) return null;
  const definition = convertActivity({document, activity, system, spell, level, scales, notes: [], pool, saveDC, spellDC, creature, beasts,
    names});
  if ( !definition?.save ) return null;
  return {schemaVersion: 1, id: `regurgitate-${slugify(document.name)}`, type: "Trigger", data: {kind: "automation", event: "turn.ended",
    around: {on: "swallowed", threshold}, action: {schemaVersion: 1, id: definition.id, label: `${document.name}: Regurgitate`,
      costs: {allOf: []}, save: definition.save}}};
}

/**
 * A passive aura of Advantage or Disadvantage (2024 Aura of Authority: "While in a 10-foot Emanation originating from the
 * warlord, the warlord and its allies have Advantage on attack rolls and saving throws, provided the warlord doesn't have
 * the Incapacitated condition"): an `Aura` of RollModes on its allies. Null for any other text.
 */
function rollModeAura(document, activity) {
  const text = plainText(document);
  const match = /\bWhile in an? (\d+|\[\[lookup [^\]]*\]\])-foot Emanation originating from [^,]+, (?:[^,.]*?\band its allies|its allies) have (Advantage|Disadvantage) on ([^.,]+)/iu
    .exec(text);
  if ( !match ) return null;
  const radius = Number(match[1]) || Number(activity?.target?.template?.size);
  const domains = [["attack rolls", "attack"], ["saving throws", "save"], ["ability checks", "check"]]
    .filter(([words]) => match[3].toLowerCase().includes(words)).map(([, domain]) => domain);
  if ( !(radius > 0) || !domains.length ) return null;
  const id = `aura-${slugify(document.name)}`;
  return {schemaVersion: 1, id, type: "Aura",
    ...(/\b(?:provided|unless|while) [^.]{0,60}?Incapacitated\b/iu.test(text.replace(/\[\[[^\]]*\]\](?:\{[^}]*\})?/g, "it"))
      ? {predicate: {missingCondition: "incapacitated"}} : {}),
    data: {radius, affects: "allies", ruleElements: [rollModeRule(id, domains, match[2].toLowerCase())]}};
}

/**
 * What a feature does when its creature finishes a rest, as an automatic Trigger on `rest.completed`. 2024 Tireless:
 * "Whenever you finish a Short Rest, your Exhaustion level, if any, decreases by 1."
 */
function restTrigger(document, activity) {
  if ( !((identifierOf(document) === "tireless") && (activity?.name === "Decrease Exhaustion")) ) return null;
  return {schemaVersion: 1, id: "tireless-rest", type: "Trigger", data: {event: "rest.completed",
    predicate: {equals: {path: "event.data.restType", value: "shortRest"}},
    action: {schemaVersion: 1, id: "action:srd-tireless-decrease-exhaustion", label: "Tireless", costs: {allOf: []}, range: {type: "self"},
      targeting: {type: "self"}, effects: [{id: "effect-1", type: "condition", conditionId: "exhaustion", levels: -1}]}}};
}

/**
 * Healing its creature regains as world time passes (Ring of Regeneration: "you regain 1d6 Hit Points every 10 minutes if
 * you have at least 1 Hit Point"; Ioun Stone of Regeneration: "once per hour"), as an automatic Trigger on `time.elapsed`
 * with `every` its interval. It runs while its creature is missing Hit Points, has at least 1 when its text says so, and
 * holds the item attuned when it needs attunement. Null for any other activity.
 */
function intervalTrigger({document, activity, system, spell, level, scales, notes, pool, names, saveDC, spellDC, creature, beasts}) {
  const text = `${activity?.activation?.condition ?? ""} ${plainText(document)}`;
  const match = (activity?.type === "heal") && text.match(/\b(?:every|each|per)\s+(?:(\d+)\s+)?(minute|hour|day)s?\b/iu);
  if ( !match ) return null;
  const heal = convertActivity({document, activity, system, spell, level, scales, notes: [], pool, saveDC, spellDC, creature, beasts, names});
  if ( !heal?.healing?.length ) return null;
  const predicates = [{equals: {path: "damaged", value: true}}, ...(/at least 1 hit point/iu.test(text) ? [AT_LEAST_ONE_HIT_POINT] : []),
    ...((document.system?.attunement === "required") ? [{not: {equals: {path: "owner.system.attunement", value: "required"}}}] : [])];
  // Its rule is one paragraph; another sentence there (the Ring's lost body part regrowing) is by hand.
  const paragraph = String(document.system?.description?.value ?? "").split(/<\/p>/iu).map(part => part.replace(/<[^>]+>/g, " ").trim())
    .find(part => /\b(?:every|each|per)\s+(?:\d+\s+)?(?:minute|hour|day)s?\b/iu.test(part)) ?? "";
  if ( paragraph.split(/(?<=\.)\s+/u).filter(Boolean).length > 1 ) notes.push("interval: what else its description says is by hand");
  return {schemaVersion: 1, id: `interval-${slugify(activity.name || "heal")}`, type: "Trigger", data: {event: "time.elapsed",
    every: {value: Number(match[1] ?? 1), units: `${match[2].toLowerCase()}s`}, predicate: {all: predicates},
    action: {...heal, costs: {allOf: []}, range: {type: "self"}, targeting: {type: "self"}}}};
}

/**
 * Whether an activity trades one pool for another, all of it converted (it spends one and gives another back): Wild
 * Resurgence, Font of Magic, Font of Inspiration's and Holy Nimbus' recharges, Hurl Through Hell's for a Pact Magic slot.
 * Not one used when its creature rolls Initiative.
 */
function tradesPools({document, activity, pool, names, scales}) {
  const targets = activity?.consumption?.targets ?? [];
  if ( /initiative/i.test(`${activity?.name ?? ""} ${activity?.activation?.condition ?? ""}`)
    || !targets.some(target => givesBack(target.value)) || !targets.some(target => !givesBack(target.value)) ) return false;
  const notes = [];
  consumptionDefinition({costs: {allOf: []}}, {document, activity, notes, pool, names, scales});
  return !notes.length;
}

/**
 * The pool a dnd5e consumption target names: its item's own (no target), else another feature's, by its name; without
 * the names (a converter path that has none), the item's pool.
 */
function targetPoolId(target, pool, names) {
  if ( !target.target ) return pool?.id ?? null;
  const name = targetName(target.target, names);
  return name ? slugify(name) : (pool?.id ?? null);
}

/** The end of the note on a spend whose larger amount, chosen when used, nothing spends (consumptionDefinition). */
const MORE_BY_HAND = "spent; more chosen is by hand";

/**
 * Its consumption targets (dnd5e), on the definition:
 * - what it spends: a cost on the pool each names (its own, or another feature's: Dragon Wings' Sorcery Points);
 * - what it gives back: `restores`, refused while full, a formula worked out when used (`amountExpression`);
 * - a spell slot it spends: a slot choice from that level up (scaling with it: Regain Sorcery Points' points);
 * - a spell slot it gives back by level: a choice of level, each costing its points (Font of Magic's 2/3/5/6/7).
 */
function consumptionDefinition(definition, {document, activity, notes, pool, names, scales}) {
  const targets = activity.consumption?.targets ?? [];
  const scaling = activity.consumption?.scaling ?? {};
  const byLevel = scaling.allowed ? targets.find(target => (target.type === "spellSlots") && (target.scaling?.mode === "level")) : null;
  // A spell's own uses given back are its bookkeeping (Tsunami's rounds), not a pool its caster refills.
  const spell = document.type === "spell";
  const restores = [];
  const slotLevels = [];
  const scaled = [];
  let elsewhere = false;
  const note = target => notes.push(`consumption: ${target.type} ${target.value ?? ""} not converted`.trim());
  // An activity's own uses, else (dnd5e keeps a once-a-day on the item, its activity spending "activityUses": a Dretch's
  // Fetid Cloud) the item's.
  // A Pact Magic slot (Hurl Through Hell's Regain Use, a Rod of the Pact Keeper) is the pact pool. Magical Cunning's
  // half of them back stays noted (formulaExpression reads no `@spells.pact.max`): MAGICAL_CUNNING_RESTORE gives them.
  const poolOfTarget = target => ((target.type === "itemUses") ? targetPoolId(target, pool, names)
    : ((target.type === "activityUses") ? (activityPool({document, activity})?.id ?? (document.system?.uses?.max ? pool?.id : null) ?? null)
      : (((target.type === "attribute") && (target.target === "spells.pact.value")) ? PACT_SLOT_POOL : null)));
  for ( const target of targets ) {
    if ( target === byLevel ) continue;
    // dnd5e's own count of the Legendary or Lair Action its activation already costs (Pounce): paid as that.
    if ( (target.type === "attribute") && ({"resources.legact.value": "legendary", "resources.lair.value": "lair"}[target.target]
      === activity.activation?.type) ) continue;
    // A spell slot its text says it doesn't spend (2024 Pact of the Chain: "cast it as a Magic action without expending a
    // spell slot"), or that a feature casting that way spends in dnd5e (Investment of the Chain Master's Find Familiar).
    if ( (target.type === "attribute") && /^spells\.\w+\.value$/.test(String(target.target ?? ""))
      && (SLOTLESS.has(identifierOf(document)) || /\bwithout expending a spell slot\b/i.test(plainText(document))) ) continue;
    // Its own uses when it has none (a Torch's attack, a Cloud Giant's Misty Step: dnd5e spends nothing either).
    if ( (target.type === "itemUses") && !target.target && !pool ) continue;
    const text = String(target.value ?? "").trim();
    // A spell's own pool given back where another of its Actions spends it (Freezing Sphere's held globe, Heroes' Feast's
    // servings) is what that Action draws on: a restore.
    const refills = spell && (target.type === "itemUses") && !target.target && (number(text) < 0) && Object.values(document.system?.activities ?? {})
      .some(other => (other !== activity) && !["", "none", "special"].includes(other?.activation?.type ?? "")
        && (other.consumption?.targets ?? []).some(entry => (entry.type === "itemUses") && !entry.target && !givesBack(entry.value)));
    // An amount chosen when used (Ioun Stone of Reserve's "by level"), or rolled (Bag of Beans' 3d4), stays by hand.
    if ( !refills && givesBack(text) && ((scaling.allowed && (target.scaling?.mode === "amount") && !text.includes("@scaling"))
      || /\dd\d/i.test(text) || spell) ) {
      note(target);
      continue;
    }
    if ( text.includes("@scaling") ) {
      if ( byLevel && poolOfTarget(target) ) scaled.push({target, id: poolOfTarget(target), text});
      else note(target);
      continue;
    }
    // All of its own uses (a Horn of Valhalla's 7, one regained a day: "can't be used again until 7 days have passed").
    const allOwn = (target.type === "itemUses") && !target.target && (text === "@item.uses.max") ? number(document.system?.uses?.max) : null;
    const amount = (text === "") ? 1 : (allOwn ?? number(text));
    if ( target.type === "spellSlots" ) {
      const slot = number(target.target) || 1;
      if ( amount > 0 ) slotLevels.push(slot);
      else if ( amount < 0 ) restores.push({resourceId: `spell-slot.${slot}`, amount: -amount, refuseWhenFull: true});
      else note(target);
      continue;
    }
    const id = poolOfTarget(target);
    if ( (target.type === "itemUses") && target.target && id && pool && (id !== pool.id) ) elsewhere = true;
    // A formula given back (Persistent Rage's "-@scale.barbarian.rage"): worked out for its creature when used.
    const expression = ((amount == null) && text.startsWith("-")) ? formulaExpression(text.slice(1), {scales, pool: id}) : null;
    if ( !id || !(amount || expression) ) note(target);
    else if ( amount > 0 ) {
      definition.costs.allOf.push({capability: id, amount});
      // More of another feature's pool chosen when used (Bastion of Law's 1 to 5 Sorcery Points): its least is spent, the
      // rest by hand, unless a number chosen spends it (`spendAmount`: Staff of Striking's dice, a summon's count).
      // shortcut: its own pool's larger amount (Ioun Stone of Absorption's) is spent at its least without this note; upgrade
      // with a by-hand census pass over own-pool spends.
      const more = `consumption: ${target.type} ${text} ${MORE_BY_HAND}`;
      // Once, though a by-hand Action works its definition out again (convertActivity's fallback).
      if ( target.target && scaling.allowed && (target.scaling?.mode === "amount") && !notes.includes(more) ) notes.push(more);
    }
    else restores.push({resourceId: id, amount: expression ? 1 : -amount, ...(expression ? {amountExpression: expression} : {}),
      refuseWhenFull: true});
  }
  // Its own uses, which no activity of it spends, beside another feature's pool it spends or gives back (Hand of Ultimate
  // Mercy's once a long rest, for Ki; a Rhythm-Maker's Drum's once a dawn, giving back Bardic Inspiration): one of them too.
  if ( elsewhere && !Object.values(document.system?.activities ?? {}).some(other => (other?.consumption?.targets ?? [])
    .some(entry => ((entry.type === "activityUses") || ((entry.type === "itemUses") && (targetPoolId(entry, pool, names) === pool.id)))
      && !givesBack(entry.value))) ) definition.costs.allOf.push({capability: pool.id, amount: 1});
  const lowest = byLevel ? (number(byLevel.target) || 1) : null;
  const highest = byLevel ? Math.min(number(scaling.max) ?? 9, 9) : 9;
  if ( byLevel && (number(byLevel.value) < 0) ) {
    // A slot given back by level: each level an option, costing what its scaled targets say at that level.
    if ( number(scaling.max) == null ) {
      note(byLevel);
      return definition;
    }
    const options = [];
    for ( let level = lowest; level <= highest; level++ ) {
      const costs = scaled.map(({target, id, text}) => ({target, id, amount: evaluateValueExpression(formulaExpression(
        text.replaceAll("@scaling", String(level - lowest + 1)), {scales}), {}).value}));
      const label = costs.map(({target, amount}) => `${amount} ${target.target ? (targetName(target.target, names) ?? "") : document.name}`).join(", ");
      options.push({id: `level-${level}`, label: `Level ${level}${label ? ` (${label})` : ""}`, value: level, effects: [
        ...costs.filter(cost => cost.amount > 0).map(cost => ({type: "add-cost", cost: {allOf: [{capability: cost.id, amount: cost.amount}]}})),
        {type: "restore", resourceId: `spell-slot.${level}`, amount: 1}]});
    }
    definition.configuration = [...(definition.configuration ?? []), {id: "slot-level", type: "select-one", label: "Spell slot",
      required: true, options}];
  } else if ( byLevel || slotLevels.length ) {
    // A slot spent: that level or higher. Its level is what a scaled target gives back (Regain Sorcery Points: the
    // slot's level in points).
    const from = byLevel ? lowest : Math.min(...slotLevels);
    const levels = Array.from({length: highest - from + 1}, (_, offset) => from + offset);
    const effects = scaled.flatMap(({target, id, text}) => ((/^(0\s*-|-)\s*@scaling$/.test(text) && (from === 1))
      ? [{type: "restore", resourceId: id, levelChoiceId: "slot"}] : (note(target), [])));
    definition.configuration = [...(definition.configuration ?? []), {id: "slot", type: "resource", label: "Spell slot", required: true,
      cost: {anyOf: levels.map(level => [{capability: `spell-slot.${level}`, amount: 1}])},
      levelByResourceId: Object.fromEntries(levels.map(level => [`spell-slot.${level}`, level])), ...(effects.length ? {effects} : {})}];
  } else for ( const {target} of scaled ) note(target);
  if ( restores.length ) definition.restores = restores;
  return definition;
}

/** An Action's identity and costs: its activation in the action economy and the uses it spends. */
function baseDefinition({document, activity, system, spell, notes, pool, names={}, scales={}}) {
  const activation = pick(activity, system, "activation");
  // A magic item's Action is magical (Magic Resistance); a spell is magical without saying so.
  const tags = [...(spell ? ["spell"] : []), ...((system.properties ?? []).includes("mgc") ? ["magical"] : [])];
  const definition = {schemaVersion: 1, id: `action:srd-${slugify(document.name)}${activity.name ? `-${slugify(activity.name)}` : ""}`,
    ...(tags.length ? {tags} : {})};
  const capability = ACTIVATION_COST[activation.type];
  if ( capability ) definition.costs = {allOf: [{capability, amount: number(activation.value) || 1}]};
  else {
    definition.costs = {allOf: []};
    if ( activation.type ) notes.push(`activation: ${activation.value ?? ""} ${activation.type} is not an action-economy cost`.replace(/\s+/g, " "));
  }
  return consumptionDefinition(definition, {document, activity, notes, pool, names, scales});
}

/**
 * A spell of `level` spends a slot of that level or higher. Per level above, damage and healing with scaling dice grow,
 * and `perLevel` more creatures can be targeted.
 */
function slotConfiguration(level, damage, {healing=[], perLevel=0, areaPerLevel=0}={}) {
  const levels = Array.from({length: 10 - level}, (_, offset) => level + offset);
  return [{id: "spell-slot", type: "resource", label: "Spell slot", required: true,
    cost: {anyOf: levels.map(each => [{capability: `spell-slot.${each}`, amount: 1}])},
    levelByResourceId: Object.fromEntries(levels.map(each => [`spell-slot.${each}`, each])),
    effects: levelScaling("spell-slot", level, damage, {healing, perLevel, areaPerLevel})}];
}

/** What a higher level adds to a spell's dice and targets, read from the level its choice `choiceId` names. */
function levelScaling(choiceId, level, damage, {healing=[], perLevel=0, areaPerLevel=0}={}) {
  const scale = (type, components) => components.filter(component => component.scaleDice || component.scaleBonus).map(component => ({type,
    levelChoiceId: choiceId, baseLevel: level, componentIds: [component.id], ...(component.scaleDice ? {dice: component.scaleDice} : {}),
    ...(component.scaleBonus ? {bonus: component.scaleBonus} : {})}));
  return [...scale("scaleDamage", damage), ...scale("scaleHealing", healing),
    ...(perLevel ? [{type: "scaleTargets", levelChoiceId: choiceId, baseLevel: level, perLevel}] : []),
    ...(areaPerLevel ? [{type: "scaleArea", levelChoiceId: choiceId, baseLevel: level, perLevel: areaPerLevel}] : [])];
}

/**
 * A follow-up of a spell already cast (Flame Blade's attack, Hunter's Mark's Move Mark) is at the level the spell was
 * cast: its `cast-level` choice is `fromCast`, answered by the authority from its caster's record, never asked.
 */
function castLevelConfiguration(level, damage, {healing=[], perLevel=0, areaPerLevel=0}={}) {
  const scaling = levelScaling("cast-level", level, damage, {healing, perLevel, areaPerLevel});
  if ( !scaling.length ) return [];
  const levels = Array.from({length: 10 - level}, (_, offset) => level + offset);
  return [{id: "cast-level", type: "option", label: "WILDPATH.PROMPT.CastLevel", required: true, fromCast: true,
    options: levels.map(each => ({id: `level-${each}`, label: String(each), value: each})), effects: scaling}];
}

/** dnd5e's base weapon ids where WildPath's differ (`light-crossbow`, as the training lists name them). */
const WEAPON_BASES = Object.freeze({lightcrossbow: "light-crossbow", handcrossbow: "hand-crossbow", heavycrossbow: "heavy-crossbow",
  lighthammer: "light-hammer", warpick: "war-pick"});

/**
 * A weapon's kind (G8): its base weapon (`longsword`), `simple` or `martial`, and its 2024 mastery (`sap`), which
 * training and Weapon Mastery read. Null for anything not a weapon.
 */
export function weaponOf(document) {
  const type = document?.type === "weapon" ? document.system?.type ?? {} : null;
  const category = /^(simple|martial)/u.exec(type?.value ?? "")?.[1];
  if ( !category ) return null;
  const base = type.baseItem ? (WEAPON_BASES[type.baseItem] ?? type.baseItem) : null;
  return {category, ...(base ? {base} : {}), ...(document.system?.mastery ? {mastery: document.system.mastery} : {})};
}

function convertActivity({document, activity, system, spell, level, scales, notes, pool, saveDC, spellDC=null, creature=null, beasts=[],
  names={}}) {
  const definition = baseDefinition({document, activity, system, spell, notes, pool, names, scales});

  const attackData = activity.type === "attack" ? activity.attack ?? {} : null;
  const attack = attackData ? {type: attackData.type?.value || (document.system?.range?.long ? "ranged" : "melee"),
    statistic: (spell || attackData.type?.classification === "spell") ? "spell" : "weapon", defenseKey: "ac",
    // Spells and stat-block attacks are proficient; a character not proficient with a weapon unticks it.
    proficient: true} : null;
  if ( attack ) {
    // Its properties a rule or the engine reads: finesse (its better ability), light (a Monk weapon, two-weapon fighting).
    // Thrown too (Thrown Weapon Fighting's bonus reads it), and Two-Handed (Great Weapon Fighting's).
    const properties = [["fin", "finesse"], ["lgt", "light"], ["thr", "thrown"], ["two", "two-handed"]].filter(([key]) => (system.properties ?? []).includes(key)).map(([, name]) => name);
    if ( properties.length ) attack.properties = properties;
    if ( attackData.ability && ABILITY_MAP[attackData.ability] ) attack.ability = ABILITY_MAP[attackData.ability];
    const weapon = weaponOf(document);
    if ( weapon ) attack.weapon = weapon;
    definition.attack = attack;
    // The ammunition it fires (a Longbow's arrows), which its character's gear supplies.
    if ( (system.properties ?? []).includes("amm") && system.ammunition?.type ) definition.ammunition = system.ammunition.type;
  }
  const range = rangeOf({activity, system, document, attack});
  if ( range ) definition.range = range;
  // A melee attack hits one creature: a template on it is something else's (a Torch's 40-foot light).
  const melee = (attack?.type === "melee") ? {...activity, target: {...(activity.target ?? {}), template: {}, override: true}} : activity;
  // Several hits its user may send at one creature or several, each its own hit (Magic Missile's darts) or its own attack
  // roll (Scorching Ray's rays, Eldritch Blast's beams): `repeatable`. How many is its text's inline total when dnd5e gives
  // one ("[[@item.level + 1]]{Total Rays}"), as its target count holds none (Scorching Ray) or one (Eldritch Blast).
  const repeats = REPEATED_HITS.test(plainText(document));
  const total = repeats ? INLINE_TOTAL.exec(String(document.system?.description?.value ?? ""))?.[1] : null;
  const aimed = total ? {...melee, target: {...pick(melee, system, "target"), affects: {...(pick(melee, system, "target").affects ?? {}),
    count: total}, override: true}} : melee;
  const {perLevel=0, areaPerLevel=0, areaScaling=null, ...targets} = targetingOf({activity: aimed, system, notes, level, scales});
  Object.assign(definition, targets);
  if ( spell && level && !perLevel && MORE_PER_SLOT.test(plainText(document)) ) {
    notes.push("upcast: the more targets its text gives for each slot level above its own are by hand");
  }
  if ( repeats && (definition.targeting?.type === "multiple") ) definition.targeting.repeatable = true;
  if ( areaScaling ) definition.configuration = [...(definition.configuration ?? []), scalingChoice(areaScaling)];
  // A melee attack dnd5e leaves at "self" (a Torch's) is one creature within its reach.
  if ( (attack?.type === "melee") && (definition.targeting?.type === "self") ) Object.assign(definition,
    {range: {type: "reach", distance: {value: 5, unit: "ft"}}, targeting: {type: "single", required: true, count: 1}});
  // Something done to another creature that dnd5e leaves at "self" range (a Gelatinous Cube's Engulf save, a Basilisk's
  // second Petrifying Gaze save, Raise Dead's dead creature, a smite's creature hit): that creature, wherever it is.
  // A heal stays its user's unless it is a spell's (a potion is drunk; an Aboleth's Psychic Drain heals the aboleth).
  const affected = pick(activity, system, "target").affects?.type ?? "";
  if ( (definition.targeting?.type === "self") && CREATURE_TARGETS.has(affected) && !["utility", "summon", "transform"].includes(activity.type)
    && ((activity.type !== "heal") || spell) )
    Object.assign(definition, {range: {type: "special"}, targeting: {type: "single", required: true, count: 1}});

  if ( activity.type === "save" ) {
    const abilities = saveAbilitiesOf(document, activity);
    const ability = ABILITY_MAP[abilities[0]] ?? null;
    // Several: its target makes the one it is likelier to pass (`save.abilities`, as the common Grapple and Shove).
    const choices = abilities.map(key => ABILITY_MAP[key]).filter(Boolean);
    const dc = activity.save?.dc ?? {};
    // An ability calculation wins (dnd5e keeps a stale `formula` beside it): a creature's is fixed from its numbers, a
    // character's is 8 + proficiency + that ability's modifier. Else a written formula ("@attributes.spell.dc + 2").
    const fromAbility = ABILITY_MAP[dc.calculation] ? (saveDC?.(dc.calculation) ?? {valueExpression: {type: "add", terms: [
      {type: "constant", value: 8}, {type: "proficiency-bonus"}, {type: "ability-modifier", ability: ABILITY_MAP[dc.calculation]}]}}) : null;
    // A fixed spell save DC: a magic item's own, else a creature's.
    const fixed = spellDC ?? creature?.spellDC;
    const written = dc.formula ? formulaExpression(dc.formula, {spell, scales, spellDC: fixed, challenge: creature?.challenge}) : null;
    const value = dc.calculation === "spellcasting" ? (fixed ? {value: fixed} : {valueExpression: SPELL_DC})
      : (fromAbility ?? (written ? (written.type === "constant" ? {value: written.value} : {valueExpression: written}) : null)
        ?? textDC(document, dc));
    if ( !ability || !value ) {
      notes.push(`save: ${abilities.join("/") || "?"} DC (${dc.calculation || dc.formula || "?"}) not converted`);
      return null;
    }
    definition.save = {ability, ...((choices.length > 1) ? {abilities: choices} : {}), dc: value};
  }

  // An ability check its user makes against a DC (picking a lock, slipping manacles): the creature's own check.
  if ( activity.type === "check" ) {
    // A spell's check is its target's (Maze's escape), not the caster's: by hand.
    if ( spell ) return null;
    // One whose DC the GM sets (Fast Hands' Sleight of Hand): its skill, chosen and checked when it is used, the GM judging
    // it (Search's shape: `metadata.test`).
    const judged = judgedCheck(activity.check ?? {});
    const check = judged ? null : checkOf(activity.check ?? {}, {spell, scales, notes});
    if ( !check && !judged ) return null;
    if ( check ) definition.check = check;
    else definition.metadata = {...(definition.metadata ?? {}), test: judged};
    // The user checks; nobody else is targeted.
    definition.targeting = {type: "self"};
    delete definition.range;
  }

  // Damage: a weapon's own damage first (the ability modifier joins it), then the activity's parts.
  const damage = [];
  const label = document.name;
  const base = system.damage?.base;
  const baseExpression = base ? partExpression(base, {spell, ability: null, scales, notes, label: "base damage"}) : null;
  if ( activity.damage?.includeBase && (document.type === "weapon") && baseExpression ) {
    damage.push({id: "base", expression: baseExpression, damageType: base.types?.[0] ?? "untyped", provenance: "weapon-base"});
  } else if ( activity.damage?.includeBase && baseExpression ) {
    notes.push("damage: the item's base damage not converted");
  }
  // A part of several types is the user's choice when used (Dragonborn's Breath Weapon, Chromatic Orb). A weapon attack's
  // `@mod` is its ability's (dnd5e's blank one: Strength in melee, Dexterity at range), not a spellcasting modifier.
  const typeChoices = [];
  // "(@scaling)d6": as many dice as the uses its user spends (2024 Staff of Striking: "1d6 Force damage per charge
  // spent"), a number chosen when used (`spendAmount` with `faces`).
  const spending = activity.consumption?.scaling?.allowed ? (activity.consumption.targets ?? [])
    .find(target => (target.type === "itemUses") && (target.scaling?.mode === "amount")) : null;
  const spendId = spending ? targetPoolId(spending, pool, names) : null;
  const perUse = part => (spendId ? /^\(\s*@scaling\s*\)\s*d\s*(\d+)$/iu.exec(String(part?.custom?.enabled ? part.custom.formula : "").trim()) : null);
  let spent = null;
  const attackAbility = (!spell && definition.attack && (activity.attack?.ability !== "spellcasting")) ? (ABILITY_MAP[activity.attack?.ability]
    ?? (definition.attack.type === "ranged" ? "agility" : "might")) : null;
  for ( const [index, part] of (activity.damage?.parts ?? []).entries() ) {
    const faces = perUse(part)?.[1];
    if ( faces ) spent = {id: `damage-${index + 1}`, faces: Number(faces), collection: "damage"};
    const expression = faces ? dice(1, Number(faces))
      : partExpression(part, {spell, ability: attackAbility, scales, notes, label: `damage ${index + 1}`, pool: pool?.id});
    if ( !expression ) continue;
    const types = (part.types ?? []).filter(type => DAMAGE_TYPES.includes(type));
    if ( types.length > 1 ) typeChoices.push({id: `damage-type-${index + 1}`, type: "damage-type", label: "Damage type", required: true,
      allowedDamageTypes: types, effects: [{type: "replaceDamageType", componentIds: [`damage-${index + 1}`],
        damageTypeChoiceId: `damage-type-${index + 1}`}]});
    else if ( (part.types ?? []).length > 1 ) notes.push(`damage ${index + 1}: a choice of ${part.types.join("/")} uses ${part.types[0]}`);
    const scale = slotScaling(part, {spell, level});
    if ( scale?.byHand ) notes.push(`upcast: damage ${index + 1} ${scale.byHand} (by hand)`);
    const cantrip = spell && !level && (part.scaling?.mode === "whole");
    damage.push({id: `damage-${index + 1}`, expression: cantrip ? cantripTable(expression) : expression, damageType: part.types?.[0] ?? "untyped",
      provenance: spell ? "spell-base" : "additional", ...(scale?.dice ? {scaleDice: scale.dice} : {}), ...(scale?.bonus ? {scaleBonus: scale.bonus} : {})});
  }
  const onSave = activity.damage?.onSave;
  if ( definition.save && damage.length && (onSave === "half" || onSave === "none") ) {
    for ( const component of damage ) component.saveOutcomePolicy = {success: onSave, failure: "full"};
  }
  // Damage dealt whatever the save, whose dice its text gives only apart from any saving throw (2024 Web: "dealing 2d4
  // Fire damage to any creature that starts its turn in the fire"), is not the save's: by hand, and the save does what
  // a failure gives.
  const apart = String(system.description?.value ?? "").split(/<\/p>/i)
    .filter(paragraph => (activity.damage?.parts ?? []).some(part => paragraph.includes(`${part.number}d${part.denomination}`)));
  if ( definition.save && damage.length && (onSave === "full") && apart.length && !apart.some(paragraph => /\bsaving throw\b/i.test(paragraph)) ) {
    notes.push("damage: what its text deals apart from the save is by hand");
    damage.length = 0;
  }

  const healing = [];
  if ( activity.type === "heal" && activity.healing ) {
    const faces = perUse(activity.healing)?.[1];
    if ( faces ) spent = {id: "healing-1", faces: Number(faces), collection: "healing"};
    const expression = faces ? dice(1, Number(faces)) : partExpression(activity.healing, {spell, ability: null, scales, notes, label: "healing"});
    const scale = slotScaling(activity.healing, {spell, level});
    if ( scale?.byHand ) notes.push(`upcast: healing ${scale.byHand} (by hand)`);
    // Temporary Hit Points (False Life, Inspiring Leader) are their own healing type.
    const healingType = (activity.healing.types ?? []).includes("temphp") ? "temporary" : "healing";
    if ( expression ) healing.push({id: "healing-1", expression, healingType, ...(scale?.dice ? {scaleDice: scale.dice} : {}),
      ...(scale?.bonus ? {scaleBonus: scale.bonus} : {})});
  }

  const effects = [];
  const concentration = (system.properties ?? []).includes("concentration");
  // A spell given its rules by hand whose activity names no effect (Blur's) uses the spell's own effect.
  // A utility whose item's only effect is one dnd5e leaves switched off for its user to enable (a Werebear's "Speed: Bear
  // Form", which its Shape-Shift doesn't link; a Werewolf's does) is that effect's use. A feature's on its user only: an
  // item's switched-off effect is its enchantment or its passive (Dwarven Plate, an Arrow-Catching Shield).
  const toggled = ((activity.type === "utility") && (document.type === "feat") && (pick(activity, system, "target").affects?.type === "self")
    && ((document.effects ?? []).length === 1) && document.effects[0].transfer && document.effects[0].disabled) ? [{_id: document.effects[0]._id}] : [];
  const references = activity.effects?.length ? activity.effects : (effectsByHand(document, activity)
    ? (document.effects ?? []).filter(effect => !effect.transfer).map(effect => ({_id: effect._id})) : toggled);
  const byHand = effectsByHand(document, activity);
  // A grapple's or restraint's escape (holdMetadata): its DC, from its Escape Check activity, "(escape DC 13)" or the check
  // its text names, and what else ends it. Null for any other condition.
  const holding = conditionId => (["grappled", "restrained"].includes(conditionId)
    ? holdMetadata(document, {creature, saveDC, save: definition.save, notes}) : null);
  // What each of the activity's dnd5e effects became (one can be several conditions), for the choice below.
  const groups = [];
  for ( const reference of references ) {
    const effect = (document.effects ?? []).find(entry => entry._id === reference._id);
    const first = effects.length;
    const statuses = effectStatuses(effect);
    // dnd5e's "cursed" is the Cursed condition only on an effect with nothing else (a Mummy's curse); Hex's and Bestow
    // Curse's own effects carry their rules, tagged `curse` below.
    const known = statuses.filter(status => CONDITION_MAP[status]
      && !((status === "cursed") && (byHand || effectChanges(effect).length || (identifierOf(document) === "hex"))));
    // dnd5e applies an effect on a successful save only when it says so (`onSave` defaults to false).
    const onFailure = definition.save && (reference.onSave !== true) ? {saveOutcomePolicy: "failure"} : {};
    // A mark given by hand (its slug) is its own status ("marked", "cursed").
    // dnd5e's "transformed" on a misty or cloud form (Gaseous Form, Wind Walk): `gaseous`, which can't attack or cast spells.
    const gaseous = statuses.includes("transformed") && /\b(?:gaseous|cloud form|misty cloud)\b/i.test(plainText(document));
    // dnd5e's "flying" on an effect that gives a fly Speed (a Broom of Flying's) is that Speed in use.
    const flies = (EFFECTS_BY_NAME[effect?.name]?.ruleElements ?? []).some(rule => (rule.type === "GrantMovement") && (rule.data?.mode === "fly"));
    if ( !byHand?.slug ) for ( const status of statuses.filter(status => !CONDITION_MAP[status] && !["marked", "suffocation"].includes(status)
      && !(gaseous && (status === "transformed")) && !((status === "flying") && flies)) ) {
      notes.push(`effect: ${status} is not a WildPath condition yet`);
    }
    // As long as its dnd5e effect says ("until the start of its next turn"); none lasts until it is ended.
    const lasts = effect ? textBoundExpiry(effectDuration(effect.duration), plainText(document)) : null;
    for ( const status of known ) {
      const escape = holding(CONDITION_MAP[status]);
      effects.push({id: `effect-${effects.length + 1}`, type: "condition", conditionId: CONDITION_MAP[status], ...onFailure,
        ...(lasts ? {duration: lasts} : {}),
        ...(concentration ? {concentration: true} : {}), ...(escape ? {metadata: escape} : {})});
    }
    // dnd5e's "suffocation": it can't breathe (`suffocating`: out of breath, it gains Exhaustion; the automation dispatcher).
    if ( statuses.includes("suffocation") ) effects.push({id: `effect-${effects.length + 1}`, type: "effect", name: "Suffocating",
      slug: "suffocating", ruleElements: [], ...onFailure, ...(lasts ? {duration: lasts} : {}), ...(concentration ? {concentration: true} : {})});
    // Its own changes (Bless, Shield of Faith, Haste) become a custom effect with the rules they map to; an effect dnd5e
    // leaves empty (Faerie Fire's) takes its rules from the 2024 text, by hand.
    const hand = effect && !effectChanges(effect).length ? byHand : null;
    // An effect named as a common action's (Step of the Wind's Disengaged) is that action's own.
    const common = effect && !hand && !effectChanges(effect).length ? COMMON_EFFECTS[effect.name] : null;
    if ( common ) {
      effects.push({...commonRules(common).effects[0], id: `effect-${effects.length + 1}`, ...onFailure,
        ...(concentration ? {concentration: true} : {})});
      groups.push({label: effect.name, ids: [effects.at(-1).id]});
      continue;
    }
    // Its changes, else the rules its name gives when none of them converts (Barkskin's `ac.min`: an AC floor).
    const changeNotes = [];
    const converted = hand?.ruleElements ?? (effect ? effectRules(effect, changeNotes, {scales, text: plainText(document)}) : []);
    // What its words say that its changes, and this Action's earlier effects, don't (Stony Lethargy's "can't make
    // Opportunity Attacks"; 2014 Stony Lethargy's no Reaction beside its halved Speed).
    const told = effectTextRules(document, effect, [...converted, ...effects.flatMap(entry => entry.ruleElements ?? [])]);
    const named = (!hand && !converted.length && effect) ? ((effect.name === "Lingering Acid") ? lingeringAcid(document)
      : (EFFECTS_BY_NAME[effect.name] ?? textEffect(document, told))) : null;
    // One whose words only repeat what this Action's earlier effects give (the Beholder's Slowing Ray's copy) adds nothing.
    if ( !hand && !named && !converted.length && !known.length && told.repeats && !told.ruleElements.length && !told.slug ) continue;
    if ( !named ) notes.push(...changeNotes);
    // A marker with no condition of its own read from its words alone (Mind Whip's no Reaction) keeps its by-hand note
    // for what else they say ("it must choose whether it gets a move, an action, or a bonus action"), unless all else is
    // the repeated save its Action reads (repeatSaveFields: Phantasmal Killer's Fears Manifested).
    const read = [...told.ruleElements.map(rule => rule.id), ...(told.slug ? [told.slug] : [])];
    const repeated = (definition.save && (onFailure.saveOutcomePolicy === "failure") && repeatSaveFields(document, damage).repeatSave)
      ? repeatSaveFields({system: {description: {value: effect?.description ?? ""}}}, damage).wording?.split(/(?<=\.)\s+/u) : null;
    const unread = told.unread.map(repeatText).filter(sentence => !repeated?.some(part => sentence.includes(part) || part.includes(sentence.trim())));
    if ( named && !known.length && !EFFECTS_BY_NAME[effect.name] && (effect.name !== "Lingering Acid") && read.length && unread.length ) {
      notes.push(`effect: "${effect.name}" takes ${read.join(", ")} from its words; anything else they say is by hand`);
    }
    const rules = [...(named?.ruleElements ?? [...converted, ...(hand ? [] : told.ruleElements)]), ...(byHand?.extraRules ?? []),
      ...structuredClone(EFFECT_REACTIONS[`${identifierOf(document)}/${effect?.name}`] ?? []),
      // Each check's roll mode on that ability's saves as well, while `savesToo` holds (Eldritch Hex on Hex).
      ...(byHand?.savesToo ? converted.filter(rule => (rule.type === "RollMode") && rule.data.domains.some(domain => domain.startsWith("check.")))
        .map(rule => ({...structuredClone(rule), id: `${rule.id}-save`, predicate: structuredClone(byHand.savesToo),
          data: {...structuredClone(rule.data), domains: rule.data.domains.map(domain => domain.replace(/^check\./u, "save."))}})) : [])];
    // dnd5e's "marked" (Guiding Bolt, Shining Smite): attack rolls against its creature have Advantage; only the next
    // one when its text says so, and the effect then ends after that attack.
    const marked = statuses.includes("marked") && !byHand?.slug;
    if ( marked ) rules.push({schemaVersion: 1, id: "marked", type: "RollMode", data: {domains: ["attacked"], mode: "advantage"}});
    const nextAttack = marked && /\bnext attack roll[^.]*against/i.test(plainText(document));
    // Holy Aura: "other creatures have Disadvantage on attack rolls against them", unless its rules already set attacks on it.
    // A ward it gives, not what a failed save puts on someone (its Fiend/Undead Save's Blinded).
    if ( effect && !definition.save && /\bother creatures have Disadvantage on attack rolls against them\b/u.test(plainText(document))
      && !rules.some(rule => (rule.type === "RollMode") && rule.data?.domains?.includes("attacked")) ) {
      rules.push(rollModeRule("attacked-disadvantage", ["attacked"], "disadvantage"));
    }
    if ( rules.length || named?.slug || named?.restsLeft || byHand?.slug ) {
      // "before the end of your next turn": a round, from its caster's turn (V14 starts it on the source's Combatant).
      const untilNextTurnEnd = nextAttack && /before the end of your next turn/i.test(plainText(document))
        ? {value: 1, units: "rounds", expiry: "turnEnd"} : null;
      // One a rest ends by name (Spell Taxed: "until you finish a Long Rest") has no time limit besides.
      const duration = named?.restsLeft ? null : ((hand ?? named)?.duration ?? textBoundExpiry(effectDuration(effect.duration), plainText(document)) ?? untilNextTurnEnd);
      const onUser = (hand ?? named)?.appliesTo === "source";
      const slug = byHand?.slug ?? named?.slug ?? (gaseous ? "gaseous" : null) ?? (hand ? null : told.slug);
      // As many Long Rests as it lasts: Raise Dead's "Resurrection Sickness (Day 3)" (each rest lifts 1 of its -4).
      const restsLeft = (hand ?? named)?.restsLeft ?? (Number(/\(Day (\d+)\)$/u.exec(effect.name ?? "")?.[1]) || null);
      effects.push({id: `effect-${effects.length + 1}`, type: "effect", name: effect.name, ...(slug ? {slug} : {}),
        ...(restsLeft ? {restsLeft} : {}),
        ...(effect.img ? {img: effect.img} : {}),
        ruleElements: rules, ...(duration ? {duration} : {}), ...(((hand ?? named)?.endsWhen ?? (nextAttack ? "attacked" : null))
          ? {endsWhen: (hand ?? named)?.endsWhen ?? "attacked"} : {}),
        // One its text gives on a successful save only (Irresistible Dance's Short Dance), where dnd5e applies it on either.
        ...(onUser ? {appliesTo: "source"} : ((definition.save && named?.saveOutcomePolicy) ? {saveOutcomePolicy: named.saveOutcomePolicy} : onFailure)),
        ...(concentration ? {concentration: true} : {})});
    } else if ( effect && !known.length && !statuses.length
      && failedSaveOutcome(document, {onHit: !definition.save}).conditions.length ) {
      // One with no status whose text names the conditions it gives (a Poisoned Needle's "has the Poisoned condition for
      // 1 hour"): those conditions, for its duration.
      for ( const conditionId of failedSaveOutcome(document, {onHit: !definition.save}).conditions ) {
        effects.push({id: `effect-${effects.length + 1}`, type: "condition", conditionId, ...onFailure, ...(lasts ? {duration: lasts} : {}),
          ...(concentration ? {concentration: true} : {})});
      }
    } else if ( effect && !known.length ) {
      // Nothing of it maps (Alter Self, Acid Arrow's lingering acid): it still marks its creature, for its duration and
      // its caster's concentration, and what it does is by hand.
      const duration = effectDuration(effect.duration);
      effects.push({id: `effect-${effects.length + 1}`, type: "effect", name: effect.name, ...(effect.img ? {img: effect.img} : {}),
        ruleElements: [], ...(duration ? {duration} : {}), ...onFailure, ...(concentration ? {concentration: true} : {})});
      notes.push(NARRATIVE_MARKERS.has(effect.name) ? `effect: "${effect.name}" marks its creature (narrative)`
        : `effect: "${effect.name}" marks its creature only; its rules are by hand`);
    }
    // dnd5e's "cursed" status (Bestow Curse, Hex) tags what it became, so Remove Curse ends it.
    if ( statuses.includes("cursed") || (identifierOf(document) === "hex") ) for ( const entry of effects.slice(first) ) {
      entry.metadata = {...(entry.metadata ?? {}), tags: [...new Set([...(entry.metadata?.tags ?? []), "curse"])]};
    }
    if ( effects.length > first ) groups.push({label: effect?.name ?? `Effect ${groups.length + 1}`, ids: effects.slice(first).map(entry => entry.id)});
  }
  // The effects its text lets its user choose from (Command's five commands), on a failed save.
  const choices = effects.length ? null : CHOICES_BY_HAND[identifierOf(document)];
  for ( const option of choices?.options ?? [] ) {
    const first = effects.length;
    for ( const effect of option.effects ) effects.push({...structuredClone(effect), id: `effect-${effects.length + 1}`,
      ...(definition.save ? {saveOutcomePolicy: "failure"} : {}), ...(concentration ? {concentration: true} : {})});
    groups.push({label: option.label, ids: effects.slice(first).map(entry => entry.id)});
  }
  // The conditions it ends (Lesser Restoration: one of four, chosen; Heal: three).
  const removal = REMOVALS[identifierOf(document)];
  if ( removal && (!removal.activity || (removal.activity === activity.name)) ) {
    for ( const conditionId of removal.conditions ) {
      effects.push({id: `effect-${effects.length + 1}`, type: "condition", conditionId, levels: -1});
      if ( removal.chooseOne ) groups.push({label: conditionId.charAt(0).toUpperCase() + conditionId.slice(1), ids: [effects.at(-1).id]});
    }
  }

  if ( damage.length ) definition.damage = damage.map(({scaleDice: _scale, scaleBonus: _bonus, ...component}) => component);
  if ( healing.length ) definition.healing = healing.map(({scaleDice: _scale, scaleBonus: _bonus, ...component}) => component);
  // 2024 Mirror Image: dnd5e's "Duplicate" effects (each adds 1 to a `mirrorImages` flag) are one effect with a level for
  // each duplicate, whose reaction rolls a d6 per duplicate left when its creature is hit.
  const duplicates = (document.effects ?? []).filter(effect => effectChanges(effect).some(change => /\.mirrorImages$/u.test(String(change.key))));
  if ( duplicates.length > 1 ) {
    const names = new Set(duplicates.map(effect => effect.name));
    const first = effects.find(effect => names.has(effect.name));
    effects.splice(0, effects.length, ...effects.filter(effect => !names.has(effect.name)), {id: first?.id ?? "effect-1", type: "effect",
      name: document.name, slug: "mirror-image", levels: duplicates.length, ...(first?.img ? {img: first.img} : {}),
      ...(first?.duration ? {duration: first.duration} : {}), ruleElements: [structuredClone(MIRROR_IMAGE)]});
    notes.splice(0, notes.length, ...notes.filter(note => ![...names].some(name => note.includes(`"${name}"`))));
  }
  // Bardic Inspiration: the creature may add the bard's die to a failed d20 test (its size on the bard's level).
  if ( identifierOf(document) === "bardic-inspiration" ) {
    const faces = formulaExpression("@scale.bard.inspiration.faces", {scales});
    if ( faces ) for ( const effect of effects.filter(entry => entry.type === "effect") ) {
      effect.metadata = {...(effect.metadata ?? {}), addDie: {faces}};
      // Its die is its rule (effect-sources.mjs offers it), not a bare marker.
      notes.splice(0, notes.length, ...notes.filter(note => note !== `effect: "${effect.name}" marks its creature only; its rules are by hand`));
    }
  }
  // "At the end of each of its turns, the target repeats the save, ending the spell on itself on a success" (Hold
  // Person): each effect a failed save gives is saved against again then, or as its creature takes damage.
  const {qualifier, repeatDamage, wording: _wording, ...repeat} = definition.save ? repeatSaveFields(document, definition.damage) : {};
  // Rolled without it, the repeat would be too easy, so it is noted (a Tarrasque's Frightful Presence).
  if ( qualifier ) notes.push(`save: its repeat's ${qualifier} is by hand`);
  const repeating = effects.filter(effect => (effect.saveOutcomePolicy === "failure") && !((effect.levels ?? 1) < 0));
  for ( const effect of repeating ) Object.assign(effect, repeat);
  // A failure's damage once per repeat: on its first effect (repeatSaveGroups takes it from there).
  if ( repeatDamage && repeating.length ) repeating[0].repeatDamage = repeatDamage;
  const repeated = effects.find(effect => effect.repeatOnDamage);
  const advantageIf = definition.save
    ? /\b(?:has Advantage on the sav(?:e|ing throw)|does so with Advantage) if ([^.]+)\./i.exec(plainText(document))?.[1] : null;
  // "The target has Advantage on the save if the save is triggered by damage" (Hideous Laughter; 2014 "on the saving throw
  // if it's triggered by damage"): a marker its repeated save ends with the rest, giving Advantage on the save its damage
  // brings (`repeat:damaged`). The repeated save keeps its spell's tags, so `spell:<identifier>` keeps the Advantage off
  // another spell's damage-repeated save (Dominate Person).
  if ( repeated && spell && /^(?:the save is|it is|it[’']s) triggered by damage$/i.test(advantageIf ?? "") ) {
    effects.push({id: `effect-${effects.length + 1}`, type: "effect", name: document.name, ruleElements: [{schemaVersion: 1,
      id: "damaged-save-advantage", type: "RollMode", data: {domains: ["save"], mode: "advantage"},
      predicate: {tagsAll: ["repeat:damaged", `spell:${identifierOf(document)}`]}}],
      saveOutcomePolicy: "failure", ...(repeated.duration ? {duration: structuredClone(repeated.duration)} : {}),
      ...(repeated.concentration ? {concentration: true} : {}), ...repeat});
  } else if ( /^you or your (?:allies|companions) are fighting it$/i.test(advantageIf ?? "") ) {
    // "The target has Advantage on the save if you or your allies are fighting it" (the Dominate spells; Charm Person's
    // "It does so with Advantage if ...", 2014 "your companions"): the Action's own RollMode for its saver, while it is
    // fighting the caster's side (`save.fighting`). Only the first save: a repeated one keeps no roll modes of its Action.
    definition.save.rollModes = [{schemaVersion: 1, id: "fighting-advantage", type: "RollMode",
      data: {domains: ["save"], mode: "advantage"}, predicate: {equals: {path: "save.fighting", value: true}}}];
  } else if ( advantageIf ) notes.push(`save: its Advantage if ${advantageIf} is by hand`);
  // "it can't end the Prone condition on itself" (Hideous Laughter): standing up is not stopped.
  const kept = definition.save ? /\bcan[’']t end the (\w+) condition on itself\b/i.exec(plainText(document))?.[1] : null;
  if ( kept ) notes.push(`effect: its creature can't end ${kept} on itself, which is by hand`);
  if ( effects.length ) definition.effects = effects;

  // A spell of level 1 or higher spends a slot of its level or higher; damage dice that scale grow per level above.
  // A follow-up activity that spends none (Hunter's Mark's Move Mark, Flame Blade's attack) has no slot choice: it is at
  // the level its spell was cast (castLevelConfiguration).
  if ( spell && level && SLOT_MODES.has(system.preparation?.mode ?? "prepared") && (activity.consumption?.spellSlot !== false) ) {
    definition.configuration = slotConfiguration(level, damage, {healing, perLevel, areaPerLevel});
  } else if ( spell && level && (activity.consumption?.spellSlot === false) ) {
    const followUp = castLevelConfiguration(level, damage, {healing, perLevel, areaPerLevel});
    if ( followUp.length ) definition.configuration = [...(definition.configuration ?? []), ...followUp];
  }
  // Such a follow-up continues its spell's concentration rather than starting one (startsConcentration).
  if ( spell && level && (activity.consumption?.spellSlot === false) ) definition.metadata = {...(definition.metadata ?? {}), followUp: true};
  if ( typeChoices.length ) definition.configuration = [...(definition.configuration ?? []), ...typeChoices];
  // The uses spent are chosen when used, and `spendAmount` spends them (so the pool's fixed cost goes).
  if ( spent ) {
    // A maximum that reads its creature ("@abilities.cha.mod": Healing Light's "up to your Charisma modifier (minimum
    // of one)") is a formula, never below 1.
    const formula = number(activity.consumption.scaling.max) == null && activity.consumption.scaling.max
      ? formulaExpression(String(activity.consumption.scaling.max), {scales}) : null;
    const max = number(activity.consumption.scaling.max) ?? (formula ? {type: "max", terms: [{type: "constant", value: 1}, formula]} : null);
    definition.costs = {...definition.costs, allOf: (definition.costs?.allOf ?? []).filter(cost => cost.capability !== spendId)};
    notes.splice(0, notes.length, ...notes.filter(note => !note.endsWith(MORE_BY_HAND)));
    definition.configuration = [...(definition.configuration ?? []), {id: "spent", type: "number",
      label: (pool?.id === spendId ? pool?.rule?.data?.label : null) ?? document.name, required: true, min: 1, ...(max ? {max} : {}),
      effects: [{type: "spendAmount", resourceId: spendId, componentIds: [spent.id], collection: spent.collection, faces: spent.faces}]}];
  }
  // dnd5e lists an activity's effects as options its user applies (Blindness or Deafness, one of Hex's abilities, a
  // Shadow's -1 to -4): a choice keeps one, with every condition it brings.
  // A condition only a "Failure by 5 or More:" section names lands on such a failure alone (`failedBy`), as long as it says;
  // its options are then the save's to settle, not its user's. shortcut: a condition both sections name keeps the plain
  // failure's duration (a Homunculus's 1-minute Poisoned on a big failure lasts a turn); upgrade when an effect can take
  // its duration from the margin.
  const margined = definition.save ? failureByMargin(plainText(document)) : null;
  let settled = false;
  // One dnd5e's data leaves out (a Pseudodragon's Unconscious) is added from the text.
  for ( const conditionId of margined?.only ?? [] ) {
    if ( effects.length && !effects.some(effect => effect.conditionId === conditionId) ) {
      effects.push({id: `effect-${effects.length + 1}`, type: "condition", conditionId});
    }
  }
  for ( const effect of effects ) {
    if ( (effect.type !== "condition") || !margined?.only.includes(effect.conditionId) ) continue;
    effect.saveOutcomePolicy = {failedBy: margined.by};
    if ( margined.duration ) effect.duration = margined.duration;
    if ( margined.endsOnDamage ) effect.metadata = {...(effect.metadata ?? {}), endsWhen: "damaged"};
    settled = true;
  }
  // Its damage at the start of each of the target's turns while the condition this save gives lasts (a Pit Fiend's Bite,
  // a Vrock's Spores, an Invisible Stalker's Vortex, a Water Elemental's Whelm): an effect beside that condition's.
  const slotted = (definition.configuration ?? []).some(choice => choice.id === "spell-slot");
  if ( activity.type === "save" ) effects.push(...turnStartDamageEffects(document, effects, {spell, scales, notes, slotted}));
  // "While Poisoned, the target can't regain Hit Points" (a Bone Devil's Sting; "Until this poison ends": a Bearded
  // Devil's Beard; "While cursed": a Mummy's Rotting Fist): beside the effect bringing that condition, one capping its
  // healing at 0 for as long as it has the condition (Lesser Restoration ending it ends the cap too).
  for ( const conditionId of healingBlockedWhile(plainText(document)) ) {
    const carrier = effects.find(effect => (effect.type === "condition") && (effect.conditionId === conditionId));
    if ( !carrier ) continue;
    effects.push({id: `effect-${effects.length + 1}`, type: "effect", name: "Can't Regain Hit Points", slug: `no-healing-while-${conditionId}`,
      img: "icons/svg/blood.svg", ...(carrier.saveOutcomePolicy ? {saveOutcomePolicy: carrier.saveOutcomePolicy} : {}),
      ...(carrier.duration ? {duration: structuredClone(carrier.duration)} : {}),
      ruleElements: [{schemaVersion: 1, id: "no-healing", type: "ResourceCap", predicate: {hasCondition: conditionId},
        data: {resources: ["healing"], maximum: 0}}]});
  }
  if ( (groups.length > 1) && !settled ) {
    const option = index => `effect-option-${index + 1}`;
    definition.configuration = [...(definition.configuration ?? []), {id: "effect-choice", type: "option",
      label: removal?.chooseOne ?? byHand?.chooseOne ?? choices?.chooseOne ?? "Effect", required: true,
      options: groups.map((group, index) => ({id: option(index), label: group.label, value: option(index)})),
      effects: [{type: "keepEffect", effectIds: effects.map(entry => entry.id),
        keep: Object.fromEntries(groups.map((group, index) => [option(index), group.ids]))}]}];
  }
  // 2024 Polymorph: a creature that fails takes the form of a Beast its caster chooses (the converted Beasts).
  const transform = TRANSFORM_ON_FAILURE[identifierOf(document)];
  if ( transform && definition.save && beasts.length && !effects.length ) {
    const choice = {id: "form", type: "select-one", label: "Beast", required: true,
      options: beasts.map(beast => ({id: beast.uuid, label: `${beast.name} (CR ${beast.cr})`}))};
    definition.configuration = [...(definition.configuration ?? []), choice];
    definition.transform = {choiceId: choice.id, targets: true, ...transform, ...(concentration ? {concentration: true} : {})};
    notes.push("transform: a Beast the caster chooses; what the creature may do in its form is by hand");
    return definition;
  }
  // A save with nothing else converted (Grease, Zone of Truth): the conditions its 2024 text gives on a failure, else a
  // marker on the creatures that fail it, for as long as it lasts. What else it does is by hand.
  // A push or pull is its own (forcedMovement, added after: Gust of Wind).
  // An attack with nothing else converted: the conditions its hit gives, from its text (an Apparatus of the Crab's claw).
  if ( definition.attack && !definition.save && !damage.length && !healing.length && !effects.length ) {
    const {conditions, duration: lasts} = failedSaveOutcome(document, {onHit: true});
    for ( const conditionId of conditions ) {
      const escape = holding(conditionId);
      effects.push({id: `effect-${effects.length + 1}`, type: "condition", conditionId, ...(lasts ? {duration: lasts} : {}),
        ...(escape ? {metadata: escape} : {})});
    }
    if ( effects.length ) definition.effects = effects;
  }
  if ( definition.save && !damage.length && !healing.length && !effects.length && !definition.check && !forcedMovement(document, definition) ) {
    const {conditions, levels, duration: lasts} = failedSaveOutcome(document);
    // "a Huge or smaller creature", "succeeds automatically if it is Huge or larger" (a Net): none bigger is affected.
    const maxSize = sizeLimitOf(document);
    for ( const conditionId of conditions ) effects.push({id: `effect-${effects.length + 1}`, type: "condition", conditionId,
      saveOutcomePolicy: "failure", ...(levels?.[conditionId] ? {levels: levels[conditionId]} : {}), ...(lasts ? {duration: lasts} : {}),
      ...(maxSize ? {maxSize} : {}), ...((conditionId !== "exhaustion") ? repeat : {}),
      ...(concentration ? {concentration: true} : {}), ...(holding(conditionId) ? {metadata: holding(conditionId)} : {})});
    const lasting = conditions.length ? null : lastingDuration(pick(activity, system, "duration"));
    // Its damage at the start of each of its creature's turns while it lasts (a Bearded Devil's infernal wound): the
    // marker's own. A spell restoring its Hit Points, or a creature's Stanch Wound check, ends it by hand (noted); upgrade
    // with an `endsWhen` for healing.
    const wound = (lasting && (activity.type === "save")) ? turnStartDamageRules(document, {spell, scales, notes, slotted}) : [];
    if ( lasting || (!conditions.length && concentration) ) effects.push({id: "effect-1", type: "effect", name: document.name,
      ...(document.img ? {img: document.img} : {}), ruleElements: wound, ...(lasting ? {duration: lasting} : {}), saveOutcomePolicy: "failure",
      ...(concentration ? {concentration: true} : {})});
    if ( effects.length && wound.length ) {
      definition.effects = effects;
      notes.push("save: what ends its wound early (its text) is by hand");
    }
    else if ( effects.length ) {
      definition.effects = effects;
      if ( !conditions.length || !FAILURE_TEXT_COMPLETE.has(identifierOf(document)) ) notes.push(conditions.length
        ? `save: a failure gives ${conditions.join(", ")} (its text); the rest is by hand`
        : (narrativeSave(document, activity) ? "save: a failure marks its creature (narrative)"
          : "save: a failure marks its creature only; what it does is by hand"));
    }
  }
  // A follow-up (Flame Blade's attack, Heat Metal's reheat) goes on with its spell's concentration; it sustains nothing.
  if ( concentration && !effects.length && (activity.consumption?.spellSlot !== false) ) notes.push("concentration: nothing it sustains was converted");
  if ( damage.length || healing.length || effects.length || definition.check || definition.metadata?.test ) return bindSlot(definition);
  // An attack or save with nothing converted on it still rolls (Command, Counterspell, a Net): the card shows who
  // saved or was hit, and the description says what follows.
  if ( definition.save || definition.attack ) {
    // Its push or pull is what follows (Gust of Wind, Open Hand Technique's Push), added after. A save whose failure only
    // tells or sends its creature off the Scene (Heart Sight, an Iron Flask) is narrative: who failed is all there is.
    if ( !forcedMovement(document, definition) ) notes.push((definition.save && narrativeSave(document, activity))
      ? "rolled (save, narrative): who failed is all there is; its description says the rest" : `rolled (${activity.type}); what it does is by hand`);
    return definition;
  }
  return null;
}

/**
 * A dnd5e check activity as a WildPath check (G8): its ability, its skill (the first of `associated` that is a skill),
 * and its DC. Null, with a note, when either is missing.
 * shortcut: a tool's proficiency bonus is not added; add it when tool training feeds checks.
 */
export function checkOf(check, {spell=false, scales={}, notes=[]}={}) {
  const skills = [].concat(check.associated ?? []).filter(key => DND_SKILLS[key]);
  if ( skills.length > 1 ) notes.push(`check: a choice of ${skills.join("/")} uses ${skills[0]}`);
  const skill = skills[0] ? slugify(DND_SKILLS[skills[0]]) : null;
  const ability = ABILITY_MAP[check.ability] ?? null;
  const dc = check.dc?.formula ? formulaExpression(check.dc.formula, {spell, scales}) : null;
  if ( (!ability && !skill) || !dc ) {
    notes.push(`check: ${check.ability || skills.join("/") || "?"} DC (${check.dc?.formula || check.dc?.calculation || "?"}) not converted`);
    return null;
  }
  return {...(ability ? {ability} : {}), ...(skill ? {skill} : {}), dc: dc.type === "constant" ? {value: dc.value} : {valueExpression: dc}};
}

/**
 * Tools whose check stands in as a skill's. shortcut: Thieves' Tools is checked as Sleight of Hand; upgrade when tool
 * checks exist.
 */
const TOOL_SKILLS = Object.freeze({thief: "sleight-of-hand"});

/** A dnd5e check with no DC (the GM's to set) as the skills its user checks (`metadata.test`), or null. */
function judgedCheck(check) {
  if ( check.dc?.formula || check.dc?.calculation ) return null;
  const skills = [...new Set([].concat(check.associated ?? []).map(key => (DND_SKILLS[key] ? slugify(DND_SKILLS[key]) : TOOL_SKILLS[key]))
    .filter(Boolean))];
  return skills.length ? {skills} : null;
}

/**
 * What a damage or healing part adds per slot level above its own, as dnd5e's DamageData#scaledFormula reads it: null,
 * `{dice?, bonus?}`, or `{byHand: reason}`. Only mode "whole" grows ("" is none, though dnd5e stores `number: 1` on every
 * part); its `number` more dice of its first die (a missing key is 1, null none), and its `formula` added per level (a
 * constant is `bonus`). A cantrip (no level) grows by character level instead.
 */
function slotScaling(part, {spell, level}) {
  const scaling = part?.scaling;
  if ( !spell || !level || !scaling ) return null;
  if ( scaling.mode === "half" ) return {byHand: "grows every other slot level"};
  if ( scaling.mode !== "whole" ) return null;
  const lead = part.custom?.enabled ? /^\s*(\d+)d(\d+)/.exec(part.custom.formula ?? "") : null;
  const faces = number(scaling.faces) ?? (lead ? Number(lead[2]) : (part.custom?.enabled ? null : number(part.denomination)));
  const count = ("number" in scaling) ? (number(scaling.number) ?? 0) : 1;
  const formula = String(scaling.formula ?? "").trim();
  const rolled = /^(\d+)d(\d+)$/.exec(formula);
  const diced = Boolean(count && faces);
  if ( formula && (number(formula) == null) && !(rolled && !diced) ) return {byHand: `grows by "${formula}" a slot level`};
  const dice = diced ? {number: count, faces} : (rolled ? {number: Number(rolled[1]), faces: Number(rolled[2])} : null);
  const bonus = number(formula);
  return (dice || bonus) ? {...(dice ? {dice} : {}), ...(bonus ? {bonus} : {})} : null;
}

const SLOT_TOKEN = "{{spell-slot}}";

/**
 * `expression`, converted from dnd5e's `part`, growing as the part does with a higher slot (slotScaling) where an effect
 * carries it and scaleDamage can't reach (a retaliation's, a start-of-turn Trigger's): `{expression}`, a table on the slot
 * chosen (SLOT_TOKEN, which bindSlot has its spell-slot choice fill) with a row per slot from `level`. `{byHand: true}`
 * when it grows in a way no such table gives, null when it doesn't grow.
 */
function slotGrowth(expression, part, {spell, level}) {
  const scale = slotScaling(part, {spell, level});
  if ( !scale ) return null;
  const {dice, bonus} = scale;
  const grows = (dice && !bonus && (expression.type === "dice") && (expression.faces === dice.faces))
    ? offset => ({...expression, number: expression.number + (dice.number * offset)})
    : ((!dice && bonus && (expression.type === "constant")) ? offset => expression.value + (bonus * offset) : null);
  return grows ? {expression: {type: "table", key: {type: "constant", value: SLOT_TOKEN}, default: expression,
    rows: Object.fromEntries(Array.from({length: 10 - level}, (_, offset) => [level + offset, grows(offset)]))}} : {byHand: true};
}

/** `definition` with its spell-slot choice filling the slot chosen into its effects (bindChoice) once one reads it (slotGrowth). */
function bindSlot(definition) {
  if ( !definition.configuration || !JSON.stringify(definition.effects ?? []).includes(SLOT_TOKEN) ) return definition;
  return {...definition, configuration: definition.configuration.map(choice => (((choice.id === "spell-slot")
    && !(choice.effects ?? []).some(effect => effect.type === "bindChoice"))
    ? {...choice, effects: [...(choice.effects ?? []), {type: "bindChoice"}]} : choice))};
}

/** `<class>.<scale>` → `{level: value}` rows from dnd5e class documents' ScaleValue advancements. */
export function scaleTables(documents=[]) {
  const tables = {};
  for ( const document of documents ) {
    const owner = document.system?.identifier ?? slugify(document.name);
    // The level its rows follow: a class's own; a subclass's class; a feature naming its class (Channel Divinity,
    // "Cleric") that class's; a species' (Dragonborn's Breath Weapon) the character's.
    const named = slugify(String(document.system?.requirements ?? "").split(/\s+/)[0] ?? "");
    const key = (!document.type || (document.type === "class")) ? {type: "class-level", class: owner}
      : (document.type === "subclass") && document.system?.classIdentifier ? {type: "class-level", class: document.system.classIdentifier}
        : (document.type === "feat") && named ? {type: "class-level", class: named} : {type: "character-level"};
    // Stored sources keep advancements by id; prepared documents as a list.
    for ( const advancement of Object.values(document.system?.advancement ?? {}) ) {
      const kind = advancement.configuration?.type;
      // A distance scale (Unarmored Movement's +10 to +30 feet) is its numbers, in feet.
      if ( (advancement.type !== "ScaleValue") || !["number", "dice", "distance"].includes(kind) ) continue;
      const id = advancement.configuration.identifier || slugify(advancement.title);
      // A number scale is its numbers; a dice scale is {number, faces} (Sneak Attack 1d6 ... 10d6; Martial Arts d6 ... d12).
      const rows = Object.fromEntries(Object.entries(advancement.configuration.scale ?? {})
        .map(([level, entry]) => [level, kind === "dice" ? {number: number(entry.number) ?? 1, faces: number(entry.faces)} : Number(entry.value)])
        .filter(([, value]) => (typeof value === "object") ? Number.isFinite(value.faces) : Number.isFinite(value)));
      // Not a row: the level the rows follow.
      tables[`${owner}.${id}`] = Object.defineProperty(rows, "key", {value: key, enumerable: false});
    }
  }
  return tables;
}

const SIZES = Object.freeze({tiny: 0.5, sm: 1, med: 1, lg: 2, huge: 3, grg: 4});
const SPEEDS = Object.freeze(["fly", "swim", "climb", "burrow"]);

/**
 * A stat block's text dnd5e left as an unfilled template, by creature and item id: the SRD 5.2.1 wording, in dnd5e's
 * enricher form ("makes {count} [[/item]] attacks and uses [[/item]].": the 2024 Ancient Gold Dragon's Multiattack).
 */
const SOURCE_TEXT = Object.freeze({
  "mmAncientGoldDra/mmMultiattack000": "<p>The [[lookup @name lowercase]]{monster} makes three [[/item Rend]] attacks. It can replace one attack "
    + "with a use of (A) [[/item Spellcasting]] to cast <em>Guiding Bolt</em> (level 4 version) or (B) [[/item Weakening Breath]].</p>"
});

/** An item's note on its creature, under the item's name unless the note already starts with it. */
const itemNote = (name, note) => (note.startsWith(`${name}: `) ? note : `${name}: ${note}`);

/** 2024 proficiency bonus by Challenge Rating. */
export const proficiencyForChallenge = challenge => Math.max(2, Math.floor((Math.max(Number(challenge) || 0, 1) - 1) / 4) + 2);

/**
 * Convert a dnd5e creature (an `npc` Actor) to a WildPath NPC with its Actions.
 * - Abilities, Hit Points, AC (worn armor and shield, or the stat block's natural AC), Speeds and size carry over.
 * - Its weapons and abilities become Action Items; a save DC from an ability is fixed at 8 + proficiency + modifier.
 * - Resistances and immunities, and Legendary Actions (a pool that refills each turn), go on a Traits feature.
 * @returns {{ok: true, actor: object, notes: string[]} | {ok: false, reason: string}}
 */
export function convertActor(document, options={}) {
  const {scales={}, pack=null, names={}, licensed=isSrd2024, book="SRD 5.2", images=["icons/"], spells={}, creatures={}, forms=[],
    tables={}} = options;
  if ( !licensed(document) ) return {ok: false, reason: "not SRD 5.2 (CC-BY-4.0)"};
  if ( document.type === "vehicle" ) return convertVehicle(document, options);
  if ( document.type !== "npc" ) return {ok: false, reason: `a ${document.type} is not converted`};
  const system = document.system ?? {};
  const notes = [];
  const score = key => number(system.abilities?.[key]?.value) ?? 10;
  const modifier = key => Math.floor((score(key) - 10) / 2);
  const challenge = number(system.details?.cr) ?? 0;
  const proficiency = proficiencyForChallenge(challenge);
  const saveDC = calculation => (ABILITY_MAP[calculation] ? {value: 8 + proficiency + modifier(calculation)} : null);
  const actorId = document._id;
  // What a stat block's text reads from its creature: its name, numbers and its own items' names.
  const casting = system.attributes?.spellcasting;
  // dnd5e's passive skill: 10 + its ability modifier, its proficiency (half, once or twice), and its passive bonus.
  const passive = key => {
    const skill = system.skills?.[key] ?? {};
    return 10 + modifier(skill.ability || "str") + Math.floor(proficiency * (number(skill.value) ?? 0)) + (number(skill.bonuses?.passive) ?? 0);
  };
  const creature = {name: document.name, modifier, proficiency, saveDC, challenge, passive,
    spellDC: ABILITY_MAP[casting] ? 8 + proficiency + modifier(casting) : null, castingAbility: ABILITY_MAP[casting] ?? null,
    legendaryResistances: number(system.resources?.legres?.max) ?? 0,
    // Its fastest Speed (an Arcane Eye's fly 30), for a move its summoner pays (summonerPaid).
    speed: Math.max(0, ...Object.values(system.attributes?.movement ?? {}).map(number).filter(Number.isFinite)),
    itemNames: Object.fromEntries((document.items ?? []).map(item => [item._id, item.name]))};

  const items = [];
  for ( const own of document.items ?? [] ) {
    // dnd5e's cached copy of a spell a cast activity casts: the cast activity converts it.
    if ( (own.type === "equipment") || own.flags?.dnd5e?.cachedFor ) continue;
    const source = modernSpellCopy(own, spells);
    const fixed = SOURCE_TEXT[`${actorId}/${source._id}`];
    // A part of its licensed stat block that dnd5e leaves without a license of its own (a Deva's Divine Aid) is the stat block's.
    const inherited = (!source.system?.source?.license && (source.system?.source?.rules === "2024") && document.system?.source?.license)
      ? {...source, system: {...source.system, source: {...source.system.source, license: document.system.source.license}}} : source;
    const item = fixed ? {...inherited, system: {...inherited.system, description: {...inherited.system?.description, value: fixed}}} : inherited;
    const result = convertItem(item, {scales, pack, saveDC, names, creature, licensed, book, images, spells, creatures, forms, tables});
    if ( !result.ok ) {
      notes.push(itemNote(item.name, result.reason));
      continue;
    }
    notes.push(...result.notes.map(note => itemNote(item.name, note)));
    for ( const converted of result.items ) {
      // Legendary Actions are paid from the creature's own pool, not a pool per item.
      converted.system.ruleElements = converted.system.ruleElements.filter(rule => rule.type !== "GrantResource" || !converted.system
        .definition?.costs.allOf.some(cost => cost.capability === "legendary-action"));
      items.push({...converted, _key: `!actors.items!${actorId}.${converted._id}`});
    }
  }

  multiattack(items, notes);
  moveThenAttack(items, notes);

  const traits = traitRules(system, notes);
  // Its initiative bonus beyond Agility (2024 stat blocks: proficiency once or twice, "@prof * 2"): an initiative Modifier.
  const initiative = formulaExpression(system.attributes?.init?.bonus);
  if ( initiative ) traits.push({schemaVersion: 1, id: "initiative", type: "Modifier",
    data: {domains: ["initiative"], modifierType: "untyped", valueExpression: initiative}});
  if ( traits.length ) items.push({_id: `${String(actorId).slice(0, 12)}trts`, _key: `!actors.items!${actorId}.${String(actorId).slice(0, 12)}trts`,
    name: "Traits", type: "feature", img: "icons/svg/aura.svg", system: {active: true, description: "", ruleElements: traits},
    flags: {wildpath: {conversion: {notes: []}}}});
  // A creature its summoner commands: what costs it its Action also costs its summoner's Bonus Action (`controllerCosts`);
  // its reactions and movement stay its own.
  if ( COMMANDED.has(document._id) ) for ( const item of items ) {
    if ( (item.system?.definition?.costs?.allOf ?? []).some(cost => cost?.capability === "action") ) {
      item.system.definition.controllerCosts = {allOf: [{capability: "bonus-action", amount: 1}]};
    }
  }

  const walk = number(system.attributes?.movement?.walk) ?? 30;
  const health = number(system.attributes?.hp?.max) ?? number(system.attributes?.hp?.value) ?? 1;
  const size = SIZES[system.traits?.size] ?? 1;
  return {ok: true, notes, actor: {
    _id: actorId, _key: `!actors!${actorId}`, name: document.name, type: "npc",
    img: kept(document.img, images) ?? "icons/svg/mystery-man.svg",
    system: {
      abilities: Object.fromEntries(Object.entries(ABILITY_MAP).map(([key, ability]) => [ability, {value: score(key),
        ...((number(system.abilities?.[key]?.proficient) ?? 0) >= 1 ? {saveProficient: true} : {})}])),
      // Its skills: proficient once or twice (expertise); dnd5e's half proficiency is none.
      skills: Object.fromEntries(Object.entries(SKILL_MAP).flatMap(([key, skill]) => {
        const level = Math.min(Math.floor(number(system.skills?.[key]?.value) ?? 0), 2);
        return level > 0 ? [[skill, {proficiency: level}]] : [];
      })),
      // Its languages ("exotic" is WildPath's "rare"), what it says of them ("understands Common but can't speak"), and
      // its Telepathy with its range ("telepathy 120 ft.").
      ...(creatureLanguages(system.traits?.languages).length ? {training: {languages: creatureLanguages(system.traits?.languages)}} : {}),
      defenses: {ac: {value: armorClass(document, modifier("dex"), notes)}},
      resources: {health: {base: health, value: health}, movement: {base: walk, value: walk}},
      // Its creature type; a custom one ("custom") is its own label ("object").
      details: {threat: challenge, type: slugify(String(((system.details?.type?.value === "custom") ? system.details.type.custom
        : system.details?.type?.value) ?? "")), subtype: String(system.details?.type?.subtype ?? "").toLowerCase()},
      dyingMode: "auto"
    },
    prototypeToken: {name: document.name, width: size, height: size, disposition: -1, actorLink: false,
      ...(kept(document.prototypeToken?.texture?.src, images) ? {texture: {src: document.prototypeToken.texture.src},
        // A wildcard path ("goblin-*.webp") picks one of several images.
        ...(document.prototypeToken.randomImg ? {randomImg: true} : {})} : {})},
    items,
    flags: {wildpath: {source: {system: "dnd5e", pack, id: document._id, type: document.type, book,
      license: document.system?.source?.license || null, rules: document.system?.source?.rules || "2024", challenge}, conversion: {notes}}}
  }};
}

/** What a vehicle's Actions require of the creature using one: to be aboard as crew (requiresContext's `aboard`). */
const CREW = Object.freeze({equals: {path: "aboard.crew", value: true}});

/**
 * Convert a dnd5e `vehicle` Actor (a ship, the Apparatus of the Crab) to a WildPath vehicle (vehicles-and-mythic.md).
 * - AC, Hit Points, Damage Threshold, Speed, cargo and immunities from its data; its travel Speed, crew and passengers from
 *   its stat block's lines ("Speed: 8 mph", "Crew: 10"), which dnd5e keeps only as text; without them, every creature it
 *   holds counts as crew.
 * - Its Items become its Actions, used by a creature aboard as crew at the cost of that creature's Action (2024: "a
 *   creature in the compartment can take a Utilize action"): `controllerCosts`, and `requires` its crew role.
 * @returns {{ok: true, actor: object, notes: string[]} | {ok: false, reason: string}}
 */
export function convertVehicle(document, {scales={}, pack=null, names={}, licensed=isSrd2024, book="SRD 5.2", images=["icons/"]}={}) {
  if ( !licensed(document) ) return {ok: false, reason: "not SRD 5.2 (CC-BY-4.0)"};
  const system = document.system ?? {};
  const attributes = system.attributes ?? {};
  const notes = [];
  const actorId = document._id;
  const text = String(system.details?.biography?.value ?? "").replace(/<[^>]+>/g, " ");
  // A stat block's number, a mixed fraction too ("Speed: 1 1/2 mph", "1½"): the Rowboat's 1.5, not 1.
  const line = label => {
    const match = new RegExp(`\\b${label}:\\s*([\\d.,]*)\\s*(?:(\\d+)/(\\d+)|([½¼¾]))?`, "i").exec(text);
    if ( !match || (!match[1] && !match[2] && !match[4]) ) return null;
    const fraction = match[2] ? Number(match[2]) / Number(match[3]) : ({"½": 0.5, "¼": 0.25, "¾": 0.75}[match[4]] ?? 0);
    return (number(match[1]?.replaceAll(",", "")) ?? 0) + fraction;
  };
  const holds = number(attributes.capacity?.creature) ?? 0;
  const items = [];
  for ( const source of document.items ?? [] ) {
    // A vehicle has no turn: dnd5e marks what its crew works "special"; here every one is an Action of the vehicle.
    const item = structuredClone(source);
    for ( const activity of Object.values(item.system?.activities ?? {}) ) {
      if ( activity?.activation?.type === "special" ) activity.activation.type = "action";
    }
    const result = convertItem(item, {scales, pack, names, licensed, book, images, creature: {name: document.name, itemNames: {}}});
    if ( !result.ok ) {
      notes.push(itemNote(item.name, result.reason));
      continue;
    }
    notes.push(...result.notes.map(note => itemNote(item.name, note)));
    // Its attack bonus is the stat block's own ("+8 to hit"): a vehicle has no ability scores to add.
    const flat = Object.values(item.system?.activities ?? {}).find(activity => (activity?.type === "attack") && activity.attack?.flat);
    for ( const converted of result.items ) {
      const definition = converted.system?.definition;
      if ( definition?.attack && (number(flat?.attack?.bonus) != null) ) definition.attack.fixedBonus = number(flat.attack.bonus);
      if ( definition ) Object.assign(definition, {costs: {allOf: []}, controllerCosts: {allOf: [{capability: "action", amount: 1}]},
        requires: definition.requires ? {all: [definition.requires, structuredClone(CREW)]} : structuredClone(CREW)});
      items.push({...converted, _key: `!actors.items!${actorId}.${converted._id}`});
    }
  }
  const health = number(attributes.hp?.max) ?? number(attributes.hp?.value) ?? 1;
  const walk = number(attributes.movement?.walk) ?? number(attributes.movement?.swim) ?? number(attributes.movement?.fly) ?? 0;
  const size = SIZES[system.traits?.size] ?? 1;
  const crew = line("Crew") ?? holds;
  return {ok: true, notes, actor: {
    _id: actorId, _key: `!actors!${actorId}`, name: document.name, type: "vehicle",
    img: kept(document.img, images) ?? "icons/svg/mystery-man.svg",
    system: {
      defenses: {ac: {value: number(attributes.ac?.flat) ?? 10}},
      resources: {health: {base: health, value: health, damageThreshold: number(attributes.hp?.dt) ?? 0}, movement: {base: walk, value: walk}},
      travelSpeed: line("Speed") ?? 0,
      capacity: {crew, passengers: line("Passengers") ?? Math.max(holds - crew, 0), cargo: number(attributes.capacity?.cargo?.value) ?? 0},
      immunities: {damage: [...(system.traits?.di?.value ?? [])], conditions: [...(system.traits?.ci?.value ?? [])]},
      aboard: []
    },
    prototypeToken: {name: document.name, width: number(document.prototypeToken?.width) ?? size, height: number(document.prototypeToken?.height) ?? size,
      disposition: 0, actorLink: false,
      ...(kept(document.prototypeToken?.texture?.src, images) ? {texture: {src: document.prototypeToken.texture.src}} : {})},
    items,
    flags: {wildpath: {source: {system: "dnd5e", pack, id: document._id, type: document.type, book,
      license: document.system?.source?.license || null, rules: document.system?.source?.rules || "2024"}, conversion: {notes}}}
  }};
}

/**
 * Spells that give an understanding of languages, by their effect's name (2024): Comprehend Languages understands any
 * language; Tongues understands any spoken one and is understood by anyone with a language; Speak with Animals talks to
 * Beasts; Telepathic Bond links its creatures by telepathy.
 */
const LANGUAGE_EFFECTS = Object.freeze({
  "Comprehension": {language: "any"},
  "Universal Communication": {language: "any", spokenOnly: true, understood: true},
  "Bestial Communication": {language: "beasts", spokenOnly: true},
  "Bonded Telepathy": {language: "telepathy", bond: true}
});

/** A creature's languages as its training list: dnd5e's keys, its free text split at semicolons, and Telepathy. */
function creatureLanguages(languages) {
  const keys = [...(languages?.value ?? [])].map(key => ((key === "exotic") ? "rare" : String(key)));
  // Its Telepathy with a range is a rule (telepathyRule); "Telepathy 1 mile (works only with you)" stays its text.
  const custom = String(languages?.custom ?? "").split(";").map(text => text.trim()).filter(Boolean)
    .filter(text => !telepathyRange(text));
  return [...new Set([...keys, ...custom])];
}

/** Telepathy's range in feet from its text ("telepathy 120 ft.", "Telepathy (30 feet)"), or null. */
function telepathyRange(text) {
  const match = /telepathy\W*(\d+)\s*(?:ft|feet|foot)\b/i.exec(String(text ?? ""));
  return match ? Number(match[1]) : null;
}

const ABILITY_NAMES = Object.freeze({strength: "might", dexterity: "agility", constitution: "fortitude", intelligence: "intellect",
  wisdom: "wits", charisma: "presence"});

/**
 * A feat's or class option's prerequisites (`flags.wildpath.prerequisites`), from dnd5e's `prerequisites` and its
 * `requirements` text: `level` (a feat's character level, a class option's class level), `items` (identifiers of
 * features it must have: "fighting-style", "pact-of-the-blade"), `abilities` (any of them at its minimum: "Strength or
 * Dexterity 13+"), `training` ("Heavy Armor Training", a martial weapon), `spellcasting`, `classLevel`
 * ("Warlock 5"), `repeatable`, and `text` for anything else (it is still offered, its text shown). Null when none.
 */
export function prerequisitesOf(system) {
  const given = system?.prerequisites ?? {};
  const text = String(system?.requirements ?? "").trim();
  const result = {};
  if ( Number(given.level) > 0 ) result.level = Number(given.level);
  if ( given.items?.length ) result.items = [...given.items];
  if ( given.repeatable === true ) result.repeatable = true;
  let match;
  if ( (match = /^(?:(\w+), )?(?:(\w+),? or )?(\w+) (\d+)\+$/i.exec(text)) && [match[1], match[2], match[3]].filter(Boolean)
    .every(name => ABILITY_NAMES[name.toLowerCase()]) ) {
    result.abilities = [match[1], match[2], match[3]].filter(Boolean).map(name => ({ability: ABILITY_NAMES[name.toLowerCase()], min: Number(match[4])}));
  } else if ( (match = /^(Light|Medium|Heavy) Armor Training$/i.exec(text)) ) result.training = {armor: match[1].toLowerCase()};
  else if ( /^Shield Training$/i.test(text) ) result.training = {armor: "shield"};
  else if ( /^Proficiency with a martial weapon$/i.test(text) ) result.training = {weapons: "martial"};
  else if ( /^Spellcasting or Pact Magic( Feature)?$/i.test(text) ) result.spellcasting = true;
  else if ( (match = /^Level (\d+)$/i.exec(text)) ) result.level = Number(match[1]);
  else if ( (match = /^(Artificer|Barbarian|Bard|Cleric|Druid|Fighter|Monk|Paladin|Ranger|Rogue|Sorcerer|Warlock|Wizard)(?: (\d+))?$/i.exec(text)) ) {
    result.classLevel = {class: match[1].toLowerCase(), min: Number(match[2]) || 1};
  } else if ( (match = /^(.+) Invocation$/i.exec(text)) ) result.items = [...(result.items ?? []), slugify(match[1])];
  else if ( text ) result.text = text;
  return Object.keys(result).length ? result : null;
}

/**
 * Feats that give another class's options when taken (Tasha's): their choices, at level 0, from a pool of a kind
 * (`pool.subtype`, by the options' source subtype), which the level-up dialog asks once the feat is added. Metamagic
 * Adept's 2 Sorcery Points join its sorcerer's own (grants on one pool add up). shortcut: Artificer Initiate's cantrip,
 * spell and tool are taken by hand.
 */
const FEAT_ADVANCEMENT = Object.freeze({
  "eldritch-adept": {advancement: [{level: 0, type: "choice", title: "Eldritch Invocation", count: 1, pool: {subtype: "eldritchInvocation"}}]},
  "fighting-initiate": {advancement: [{level: 0, type: "choice", title: "Fighting Style", count: 1, pool: {subtype: "fightingStyle"}}]},
  // 2024 Magic Initiate: two cantrips and a level 1 spell from the Cleric, Druid or Wizard list (dnd5e offers the three
  // lists together too), cast with the best of Intelligence, Wisdom and Charisma; the level 1 spell once a Long Rest free.
  "magic-initiate": {advancement: [["Cantrips", 2, 0], ["Level 1 Spell", 1, 1]].map(([title, count, spellLevel]) => ({level: 0,
    type: "choice", title, count, pool: {spellLists: ["cleric", "druid", "wizard"], spellLevel}})),
  castingAbilities: ["intellect", "wits", "presence"]},
  // 2024 Resilient: saving throw proficiency in one ability it lacks it in. shortcut: the feat's +1 to that ability is
  // by hand, as every feat's ability increase is.
  resilient: {advancement: [{level: 0, type: "trait", title: "Saving Throw Proficiency", grants: [], choices: [{count: 1,
    pool: ["might", "agility", "fortitude", "intellect", "wits", "presence"].map(ability => `saves:${ability}`)}]}]},
  // 2024 Elemental Adept's Energy Mastery: a damage type (an `adept:<type>` recorded choice) its own rules name with
  // `{training:adept}`: its spells' dice of that type count a 1 as a 2, and their damage ignores Resistance to it.
  // shortcut: its +1 to an ability is by hand, as every feat's is.
  "elemental-adept": {advancement: [{level: 0, type: "trait", title: "Energy Mastery", grants: [], choices: [{count: 1,
    pool: ["acid", "cold", "fire", "lightning", "thunder"].map(type => `adept:${type}`)}]}],
  rules: [{schemaVersion: 1, id: "elemental-adept-dice", type: "DamageDieMinimum",
    data: {domains: ["damage.spell"], minimum: 2, damageTypes: ["{training:adept}"]}},
  {schemaVersion: 1, id: "elemental-adept-resistance", type: "RollOutcome", predicate: {tagsAll: ["spell"]},
    data: {outcome: "ignore-resistance", domains: ["damage.spell"], damageTypes: ["{training:adept}"]}}]},
  // 2024 Divine Order: Thaumaturge and Primal Order: Magician: "You know one extra cantrip" from the Cleric or Druid list
  // (dnd5e raises the class's cantrips-known scale instead).
  "divine-order-thaumaturge": {advancement: [{level: 0, type: "choice", title: "Cantrip", count: 1, pool: {spellLists: ["cleric"], spellLevel: 0}}]},
  "primal-order-magician": {advancement: [{level: 0, type: "choice", title: "Cantrip", count: 1, pool: {spellLists: ["druid"], spellLevel: 0}}]},
  "metamagic-adept": {advancement: [{level: 0, type: "choice", title: "Metamagic", count: 2, pool: {subtype: "metamagic"}}],
    rules: [{schemaVersion: 1, id: "metamagic-adept-points", type: "GrantResource", data: {resourceId: "font-of-magic", label: "Sorcery Points",
      maximum: 2, recovery: "longRest"}}]}
});

/** A creature's Telepathy as a GrantLanguage rule with its range, or nothing. */
function telepathyRule(languages) {
  const range = number(languages?.communication?.telepathy?.value)
    ?? String(languages?.custom ?? "").split(";").map(telepathyRange).find(Boolean) ?? null;
  return range ? [{schemaVersion: 1, id: "telepathy", type: "GrantLanguage", data: {language: "telepathy", range}}] : [];
}

/** The stat block's AC: its natural or flat AC, else worn armor (with its Agility cap) and a shield. */
function armorClass(document, agility, notes) {
  const ac = document.system?.attributes?.ac ?? {};
  if ( ["flat", "natural"].includes(ac.calc) && (number(ac.flat) != null) ) return number(ac.flat);
  const equipped = (document.items ?? []).filter(item => (item.type === "equipment") && (item.system?.equipped !== false));
  const armor = equipped.find(item => ["light", "medium", "heavy"].includes(item.system?.type?.value));
  const shield = equipped.find(item => item.system?.type?.value === "shield");
  if ( ac.calc && (ac.calc !== "default") ) notes.push(`AC: "${ac.calc}" worked out as worn armor`);
  let value = 10 + agility;
  if ( armor ) {
    const base = number(armor.system.armor?.value) ?? 10;
    const kind = armor.system.type.value;
    const cap = number(armor.system.armor?.dex) ?? (kind === "medium" ? 2 : null);
    value = kind === "heavy" ? base : base + (cap == null ? agility : Math.min(agility, cap));
  }
  if ( shield ) value += number(shield.system.armor?.value) ?? 2;
  return value;
}

const COUNTS = Object.freeze({one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8});

/**
 * How many attacks a Multiattack's text makes: each "one/two/... attack(s)" of its first sentence, up to an
 * alternative (", or"). Null when it does not say ("a number of attacks equal to...").
 */
export function multiattackCount(description) {
  // The sentence that makes the attacks (2014 text may first use Frightful Presence).
  const sentences = String(description ?? "").replace(/<[^>]+>/g, " ").split(/(?<=\.)\s/);
  const sentence = sentences.find(text => /\bmakes\b/i.test(text)) ?? sentences[0] ?? "";
  const first = sentence.split(/,\s*or\s/)[0];
  let total = 0;
  for ( const [, count] of first.matchAll(/\b(one|two|three|four|five|six|seven|eight|\d+)\s+(?:[^.,;]*?\s)??attacks?\b/gi) ) {
    total += COUNTS[count.toLowerCase()] ?? Number(count);
  }
  return total > 0 ? total : null;
}

/** A name as a whole word, its plural too ("Claws" matches "Claw attacks"), ignoring a parenthetical. */
const nameWord = name => {
  const base = String(name).replace(/\s*\(.*\)\s*$/, "").trim().replace(/s$/i, "");
  return new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`, "i");
};

const COUNT = "(one|two|three|four|five|six|seven|eight|\\d+)";

/**
 * Which attacks a Multiattack makes, one plan per alternative, each a list of groups `{names, amount}`:
 * - "one Bite attack and two Claw attacks", or "three attacks: one with its bite and two with its claws":
 *   `[[{names: ["Bite"], amount: 1}, {names: ["Claw"], amount: 2}]]`;
 * - "two attacks, using Scimitar or Shortbow in any combination": `[[{names: ["Scimitar", "Shortbow"], amount: 2}]]`;
 * - "two Greatclub attacks, or it makes two Javelin attacks": one plan each.
 * Null when a part names no attack of `attackNames`, or its parts do not add up to its count.
 */
export function multiattackPlans(description, attackNames=[]) {
  // Sentences end at a period, with or without a space after it ("attacks.It can replace...").
  const sentences = String(description ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").split(/(?<=\.)\s*/);
  const sentence = sentences.find(text => /\bmakes\b/i.test(text)) ?? sentences.find(text => /\battacks\b/i.test(text)) ?? "";
  if ( !sentence ) return null;
  const find = words => attackNames.find(entry => nameWord(entry).test(words));
  // "Using Scimitar or Shortbow in any combination": a count shared by those attacks, beside any it names on their own
  // ("one Bite attack and three other attacks, using Claw or Tail in any combination").
  const any = /\b(one|two|three|four|five|six|seven|eight|\d+)\s+(?:other\s+)?attacks?,?\s+using\s+(.+?)\s*in any combination/i.exec(sentence);
  const shared = [];
  if ( any ) {
    const names = any[2].split(/\s*,\s*|\s+or\s+|\s+and\s+/).filter(Boolean).map(find);
    if ( !names.length || !names.every(Boolean) ) return null;
    shared.push({names, amount: COUNTS[any[1].toLowerCase()] ?? Number(any[1])});
  }
  const rest = any ? sentence.replace(any[0], "") : sentence;
  const plans = [];
  for ( const text of rest.split(/,\s*or\s/) ) {
    const colon = text.indexOf(":");
    const total = colon >= 0 ? (COUNTS[(new RegExp(`\\b${COUNT}\\s+attacks\\b`, "i").exec(text.slice(0, colon))?.[1] ?? "").toLowerCase()] ?? null) : null;
    const parts = colon >= 0
      ? [...text.slice(colon + 1).matchAll(new RegExp(`\\b${COUNT}\\s+(?:with\\s+(?:its|their|his|her)\\s+)?([^,.;]+?)(?=\\s+and\\b|,|\\.|;|$)`, "gi"))]
      : [...text.matchAll(new RegExp(`\\b${COUNT}\\s+((?:[^.,;]*?\\s)??)attacks?\\b`, "gi"))];
    const groups = [...shared];
    // An alternative that makes no attacks ("uses Fling, Lightning Strike, or Swallow") is not a plan of its own.
    if ( !parts.length && plans.length ) continue;
    for ( const [, count, words] of parts ) {
      const name = find(words);
      if ( !name ) return null;
      const amount = COUNTS[count.toLowerCase()] ?? Number(count);
      const group = groups.find(entry => entry.names[0] === name);
      if ( group ) group.amount += amount;
      else groups.push({names: [name], amount});
    }
    const sum = groups.reduce((total, group) => total + group.amount, 0);
    if ( !sum || ((total !== null) && (sum !== total)) ) return null;
    plans.push(groups);
    if ( any ) break;
  }
  return plans.length ? plans : null;
}

/** Half the level its creature was summoned at, rounded down. */
const HALF_SUMMON_LEVEL = Object.freeze({type: "divide", numerator: {type: "context", path: "actor.flags.wildpath.summonLevel"},
  denominator: {type: "constant", value: 2}, round: "floor"});

/** Half its summoner's Proficiency Bonus, rounded up (0 while it has no controller). */
const HALF_CONTROLLER_PROFICIENCY = Object.freeze({type: "divide", numerator: {type: "controller-proficiency-bonus"},
  denominator: {type: "constant", value: 2}, round: "ceil"});

/**
 * What a Multiattack lets its creature do besides, or instead of, its attacks, as the Actions its text names:
 * - `uses`: "makes two Tentacle attacks and uses Constrict" (or "either A or B"): one use, shared by those Actions;
 * - `replace`: "it can replace one attack with a use of (A) Sleep Breath or (B) Spellcasting to cast Scorching Ray"
 *   (`of` names the attack only it replaces: "replace the Claw attack with..."). "Spellcasting to cast X" is X;
 *   "Spellcasting" alone is any spell it casts (`SPELLS`).
 * Each is null when its text says nothing of it, or names an Action the creature does not have (`unknown`).
 */
export function multiattackExtras(description, actionNames=[]) {
  const text = String(description ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const find = phrase => {
    const words = phrase.replace(/^(?:a use of|an?|its|the)\s+/i, "").replace(/\s*\(level \d+ version\)/i, "").replace(/\s+if available$/i, "")
      .replace(/\s+attacks?$/i, "").replace(/\s+(?:twice|two times)$/i, "").trim();
    // "Spellcasting", or "Spellcasting to cast" a spell whose name the text lost: any spell it casts.
    const spell = /^Spellcasting(?:\s+to cast\s*(.*))?$/i.exec(words);
    if ( spell && !spell[1]?.trim() ) return [SPELLS];
    const name = spell ? spell[1].trim() : words;
    // The Action's own name within the text's ("Acid Arrow" in "Melf's Acid Arrow").
    const found = actionNames.filter(entry => nameWord(entry).test(name));
    return found.length ? found : null;
  };
  const namesOf = list => {
    const found = list.replace(/^a use of\s+/i, "").split(/\s*\([A-Z]\)\s*|\s*,\s*(?:or\s+)?|\s+or\s+|\s+and\s+/).map(entry => entry.trim()).filter(Boolean).map(find);
    return found.every(Boolean) ? found.flat() : null;
  };
  // "...and uses Constrict", "and can use Entangling Rope", "uses Reel, and makes two Bite attacks", "uses Antennae twice".
  const uses = /\b(?:and\s+)?(?:can\s+use|uses)\s+(?:either\s+)?(.+?)\s*(?:,\s*and\b|\.|$)/i
    .exec(text.split(/(?<=\.)\s*/).find(sentence => /\bmakes\b/i.test(sentence)) ?? "");
  const twice = uses ? /\b(?:twice|two times)\b/i.test(uses[1]) : false;
  const replace = /\breplace\s+(one|two|any|the\s+(.+?))\s+attacks?\s+with\s+(.+?)\s*\.(?:\s|$)/i.exec(text);
  const usesNames = uses ? namesOf(uses[1]) : null;
  const replaceNames = replace ? namesOf(replace[3]) : null;
  const of = replace?.[2] ? actionNames.find(entry => nameWord(entry).test(replace[2])) ?? null : null;
  return {
    uses: usesNames ? {names: usesNames, amount: twice ? 2 : 1} : null,
    // "Replace any attack": as many as it makes (null).
    replace: replaceNames ? {names: replaceNames, amount: replace[2] ? 1 : (/^any$/i.test(replace[1]) ? null : (COUNTS[replace[1].toLowerCase()] ?? 1)),
      of} : null,
    unknown: Boolean((uses && !usesNames) || (replace && !replaceNames) || (replace?.[2] && !of))
  };
}
/** "Spellcasting" with no spell named: any spell its creature casts. */
const SPELLS = "*spells*";

/**
 * A creature's Multiattack (G4): using it spends the Action and fills its pools for this turn, which start empty and
 * empty at the start of each turn. Each group of attacks its text names has a pool of its own ("one Bite and two Claw
 * attacks"; "two attacks, using Scimitar or Shortbow in any combination" shares one), and attacks it does not name
 * cost the Action as before; each alternative ("or it makes two Javelin attacks") is a Multiattack Action of its own.
 * When its text names no attacks, any of them may be each of them. An attack is paid from a pool it belongs to, or
 * with the Action.
 */
function multiattack(items, notes) {
  const item = items.find(entry => (entry.name === "Multiattack") && (entry.type === "action"));
  if ( !item ) return;
  // A spell the creature casts is not one of its Multiattack's attacks.
  const costsAction = action => (action.system?.definition?.costs?.allOf ?? []).some(cost => cost.capability === "action");
  const attacks = items.filter(action => (action !== item) && action.system?.definition?.attack && !action.flags?.wildpath?.source?.castBy
    && costsAction(action));
  const bare = name => name.replace(/\s*\(.*\)\s*$/, "");
  // "Makes three Rend." (2024 Ancient Bronze Dragon): a count before one of its attacks' names is that many of those attacks.
  const attackNames = attacks.map(action => bare(action.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const description = attackNames.length ? String(item.system.description).replace(new RegExp(`\\b${COUNT}\\s+(${attackNames.join("|")})\\b(?!\\s+attacks?\\b)`,
    "gi"), "$1 $2 attacks") : String(item.system.description);
  const text = description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const count = multiattackCount(description);
  // A summoned spirit's: "a number of attacks equal to half this spell's level (round down)", by the level it was
  // summoned at (`flags.wildpath.summonLevel`, set when it is summoned); a summoned avatar's: "equal to half the
  // summoner's Proficiency Bonus (rounded up)", its controller's (`controller-proficiency-bonus`).
  const byProficiency = !count && /half the summoner['’]s Proficiency Bonus/i.test(text);
  const byLevel = !count && (byProficiency || /half (?:this|the) spell['’]s level/i.test(text));
  if ( !count && !byLevel ) return;
  // "makes a number of Rend attacks equal to half this spell's level": its Rend; an Action that hits without an attack
  // roll (an Avatar of Death's Reaping Scythe) too.
  const levelName = byLevel ? /\bmakes a number of ([\w'’ -]+?) attacks equal to half/i.exec(text)?.[1] : null;
  const levelAttack = levelName ? [...attacks, ...items.filter(action => (action !== item) && (action.type === "action") && costsAction(action)
    && !action.flags?.wildpath?.source?.castBy)].find(action => bare(action.name).toLowerCase() === levelName.trim().toLowerCase()) : null;
  if ( levelAttack && !attacks.includes(levelAttack) ) attacks.push(levelAttack);
  // At most half of 9th level, or of a Proficiency Bonus of 9: a restore that fills the pool whatever its size.
  const plans = (byLevel ? (levelAttack ? [[{names: [levelAttack.name], amount: byProficiency ? 5 : 4}]] : null)
    : multiattackPlans(description, attacks.map(action => action.name)))
    ?? [[{names: null, amount: count ?? 4}]];
  const poolOf = group => (group.names?.length === 1 ? `multiattack-${slugify(bare(group.names[0]))}` : "multiattack");
  const labelOf = group => (group.names?.length === 1 ? `Multiattack (${bare(group.names[0])})` : "Multiattack");
  // Each pool is granted once, as large as its largest plan; each plan fills only its own.
  const pools = new Map();
  for ( const group of plans.flat() ) {
    const pool = pools.get(poolOf(group)) ?? {id: poolOf(group), label: labelOf(group), maximum: 0, names: group.names};
    pool.maximum = Math.max(pool.maximum, group.amount);
    pools.set(pool.id, pool);
  }
  const named = plans.flat().every(group => group.names);
  // What else it lets the creature do: another Action it uses, or one that replaces an attack.
  const others = items.filter(action => (action !== item) && (action.type === "action") && !action.name.startsWith("Multiattack"));
  // A spell is named by the ability casting it too (a Succubus's "uses Charm": Dominate Person, cast by Charm).
  const extras = multiattackExtras(description, [...new Set(others.flatMap(action => [action.name, action.flags?.wildpath?.source?.castBy])
    .filter(Boolean))]);
  const extraActions = names => others.filter(action => names.includes(action.name) || names.includes(action.flags?.wildpath?.source?.castBy)
    || (names.includes(SPELLS) && action.flags?.wildpath?.source?.castBy));
  const usesPool = extras.uses ? {id: extras.uses.names.length === 1 ? `multiattack-${slugify(bare(extras.uses.names[0]))}`
    : `multiattack-${slugify(extras.uses.names.map(bare).join(" or "))}`, label: `Multiattack (${extras.uses.names.map(bare).join(" or ")})`
    .replace(SPELLS, "Spellcasting"), maximum: extras.uses.amount} : null;
  const replacePool = extras.replace ? {id: "multiattack-replace", label: "Multiattack (replace an attack)", maximum: extras.replace.amount ?? count}
    : null;
  for ( const pool of [usesPool, replacePool] ) if ( pool ) pools.set(pool.id, {...pool, names: []});
  // shortcut: without names, any of the creature's attacks may be each of them; other parts of it are used by hand.
  // Other parts it does not name ("and uses Frightful Presence" when it has no such Action) are used by hand too.
  const rest = /\breplace|\buses?\b/i.test(text) && (extras.unknown
    || !(extras.uses || extras.replace));
  // A text that names none of its attacks ("makes a number of attacks equal to half this spell's level") means any of them.
  const mentions = attacks.some(action => nameWord(bare(action.name)).test(text));
  const note = (!named && mentions) ? "Multiattack: any of its attacks may be each of the attacks; other parts of it are used by hand"
    : (rest ? "Multiattack: its other parts (a replacement, an ability it uses) are used by hand" : null);
  const multiattacks = plans.map((plan, index) => {
    // Alternatives by what they make: "Multiattack (2 Slam)", "Multiattack (3 Slam)".
    const label = (plans.length > 1)
      ? `Multiattack (${plan.map(group => `${group.amount} ${(group.names ?? []).map(bare).join(" or ")}`).join(", ")})` : "Multiattack";
    const id = index ? stableId(`${item._id}:alternative:${index}`) : item._id;
    const action = index ? {...structuredClone(item), _id: id, _key: item._key.replace(item._id, id)} : item;
    action.name = label;
    action.system.definition = {...action.system.definition, id: `${item.system.definition.id}${index ? `-${index + 1}` : ""}`, label,
      costs: {allOf: [{capability: "action", amount: 1}]}, targeting: {type: "none"},
      restores: [...plan.map(group => ({resourceId: poolOf(group), amount: group.amount})),
        ...[usesPool, replacePool].filter(Boolean).map(pool => ({resourceId: pool.id, amount: pool.maximum}))]};
    action.system.ruleElements = [...(action.system.ruleElements ?? [])];
    action.flags.wildpath.conversion.notes = note ? [note] : [];
    return action;
  });
  multiattacks[0].system.ruleElements.push(...[...pools.values()].map(pool => ({schemaVersion: 1, id: `${pool.id}-uses`,
    type: "GrantResource", data: {resourceId: pool.id, label: pool.label,
      maximum: (byLevel && (!pool.names || ((pool.names.length === 1) && (pool.names[0] === levelAttack?.name))))
        ? (byProficiency ? HALF_CONTROLLER_PROFICIENCY : HALF_SUMMON_LEVEL) : pool.maximum,
      current: 0, recovery: "none", emptiesAtTurnStart: true}})));
  items.splice(items.indexOf(item) + 1, 0, ...multiattacks.slice(1));
  notes.splice(0, notes.length, ...notes.filter(entry => !entry.startsWith("Multiattack: not automated")), ...(note ? [`Multiattack: ${note.slice(13)}`] : []));
  const attackPools = [...pools.values()].filter(pool => ![usesPool?.id, replacePool?.id].includes(pool.id));
  for ( const action of attacks ) {
    const own = attackPools.filter(pool => !pool.names || pool.names.includes(action.name));
    if ( !own.length ) continue;
    const definition = action.system.definition;
    const rest = definition.costs.allOf.filter(cost => cost.capability !== "action");
    definition.costs = {anyOf: [...own.map(pool => [{capability: pool.id, amount: 1}, ...rest]), [{capability: "action", amount: 1}, ...rest]]};
  }
  // An Action it uses besides its attacks is paid from its own use; one that replaces an attack, from the replacement
  // and one of the attacks it could replace. Its other costs (a spell's uses) are still paid.
  const payable = (action, options) => {
    const definition = action.system.definition;
    const original = definition.costs.anyOf ?? [definition.costs.allOf ?? []];
    const rest = original[0].filter(cost => cost.capability !== "action");
    definition.costs = {anyOf: [...options.map(option => [...option, ...rest]), ...original]};
  };
  if ( usesPool ) for ( const action of extraActions(extras.uses.names) ) payable(action, [[{capability: usesPool.id, amount: 1}]]);
  if ( replacePool ) {
    const replaceable = extras.replace.of ? attackPools.filter(pool => !pool.names || pool.names.includes(extras.replace.of)) : attackPools;
    for ( const action of extraActions(extras.replace.names) ) {
      payable(action, replaceable.map(pool => [{capability: replacePool.id, amount: 1}, {capability: pool.id, amount: 1}]));
    }
  }
}

/**
 * 2024 "moves up to half its Speed, and it makes one Rend attack" (a dragon's Pounce, a Charge, a Rampage): the Action
 * gives back that much movement, and fills a one-attack pool its named attack may be paid from (as a Multiattack's), for
 * the creature to move and strike. Its note goes; what else its text says (extra damage, a push) stays by hand.
 * One whose whole text is "makes one Tentacle attack" (an Aboleth's Lash, a dragon's Tail Swipe) fills the pool alone.
 * "one Claw or Tail attack" (a Tarrasque's Onslaught): either may be paid from it. "without provoking Opportunity Attacks"
 * (a Unicorn's Charging Horn): Disengaged too, until its turn ends. "can teleport up to 30 feet ..., and it makes one Claw
 * attack" (a Sphinx's Arcane Prowl): that teleport (`teleport.distance`) in place of the movement.
 */
function moveThenAttack(items, notes) {
  const attacks = items.filter(action => action.system?.definition?.attack);
  const bare = name => name.replace(/\s*\(.*\)\s*$/, "").toLowerCase();
  for ( const action of items.filter(entry => entry.type === "action") ) {
    const text = String(action.system?.description ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    // The describer leaves "Opportunity" of "&Reference[Opportunity Attacks]" (and "OpportunityAttacks" unspaced).
    const moving = /moves? (?:up to )?(?<half>half )?(?:its|their) Speed(?: or less)?(?<free> without provoking Opportunity(?: ?Attacks)?)?,? (?:and|then) (?:it )?(?:can )?makes? one (?<names>[\w' -]+?) attack/i.exec(text);
    const jumping = moving ? null : /\bcan teleport up to (?<feet>\d+) feet\b[^.]*?, (?:and|then) (?:it )?(?:can )?makes? one (?<names>[\w' -]+?) attack/i.exec(text);
    const groups = (moving ?? jumping ?? /^\s*(?:The [\w' -]+?|It) makes one (?<names>[\w' -]+?) attack\.?\s*$/i.exec(text))?.groups;
    if ( !groups ) continue;
    const teleport = Number(groups.feet) || null;
    const named = groups.names.trim().toLowerCase().split(/ or /u);
    // One Action of each name (a weapon's Two-Handed or Thrown is another Action of it).
    const struck = named.map(name => attacks.find(entry => (entry !== action) && (bare(entry.name) === name))).filter(Boolean);
    if ( !struck.length || (struck.length < named.length) ) continue;
    const pool = `move-attack-${slugify(struck[0].name.replace(/\s*\(.*\)\s*$/, ""))}`;
    const movement = {type: "floor", value: {type: "multiply", terms: [{type: "resource-max", id: "movement"}, {type: "constant",
      value: groups.half ? 0.5 : 1}]}};
    const definition = action.system.definition;
    const disengages = Boolean(groups.free);
    action.system.definition = {...definition, ...((disengages || teleport) ? {range: {type: "self"}, targeting: {type: "self"}} : {targeting: {type: "none"}}),
      ...(teleport ? {teleport: {distance: teleport}} : {}),
      ...(disengages ? {effects: [...(definition.effects ?? []), {...commonRules("disengage").effects[0], id: `effect-${(definition.effects?.length ?? 0) + 1}`}]} : {}),
      restores: [...(definition.restores ?? []), ...(moving ? [{resourceId: "movement", amount: 1, amountExpression: movement}] : []),
        {resourceId: pool, amount: 1}]};
    action.system.ruleElements = [...(action.system.ruleElements ?? []), {schemaVersion: 1, id: `${pool}-uses`, type: "GrantResource",
      data: {resourceId: pool, label: `${action.name} (${struck.map(entry => entry.name).join(" or ")})`, maximum: 1, current: 0, recovery: "none",
        emptiesAtTurnStart: true}}];
    for ( const each of struck ) {
      const costs = each.system.definition.costs;
      const options = costs.anyOf ?? [costs.allOf ?? []];
      // Its other costs (a use) still paid: those beside its Action, not another pool's option (a Multiattack's).
      const own = options.find(option => option.some(cost => cost.capability === "action")) ?? [];
      const rest = own.filter(cost => cost.capability !== "action");
      each.system.definition.costs = {anyOf: [[{capability: pool, amount: 1}, ...rest], ...options]};
    }
    action.flags.wildpath.conversion.notes = (action.flags.wildpath.conversion.notes ?? []).filter(note => !note.startsWith("not automated"));
    notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith(`${action.name}: not automated`)));
  }
}

/** Resistances, immunities and Legendary Actions as rules on the creature's Traits feature. */
/** The senses dnd5e names, as WildPath's (helpers/senses.mts); a misspelt key in the SRD data reads as its sense. */
const SENSE_KEYS = Object.freeze({darkvision: "darkvision", blindsight: "blindsight", tremorsense: "tremorsense", truesight: "truesight",
  trueseight: "truesight"});

/**
 * A creature's or species' senses (dnd5e 6: `senses.ranges.<sense>`; older data and species: `senses.<sense>`) as
 * GrantSense rules, one per sense with a range.
 */
export function senseRules(senses) {
  const ranges = {...(senses ?? {}), ...(senses?.ranges ?? {})};
  return Object.entries(SENSE_KEYS).flatMap(([key, sense]) => {
    const range = number(ranges[key]);
    return range ? [{schemaVersion: 1, id: `sense-${sense}`, type: "GrantSense", data: {sense, range}}] : [];
  });
}

function traitRules(system, notes) {
  const rules = [];
  const traits = system.traits ?? {};
  const types = trait => [...(traits[trait]?.value ?? [])];
  if ( types("dr").length ) rules.push({schemaVersion: 1, id: "resistances", type: "GrantResistance", data: {damageTypes: types("dr")}});
  if ( types("di").length ) rules.push({schemaVersion: 1, id: "immunities", type: "GrantImmunity", data: {damageTypes: types("di")}});
  if ( types("dv").length ) rules.push({schemaVersion: 1, id: "vulnerabilities", type: "GrantVulnerability", data: {damageTypes: types("dv")}});
  const conditions = types("ci").filter(id => CONDITION_MAP[id]);
  if ( conditions.length ) rules.push({schemaVersion: 1, id: "condition-immunities", type: "ConditionImmunity",
    data: {conditions: conditions.map(id => CONDITION_MAP[id])}});
  if ( conditions.length < types("ci").length ) {
    notes.push(`condition immunities (${types("ci").filter(id => !CONDITION_MAP[id]).join(", ")}) not converted`);
  }
  if ( ["dr", "di"].some(trait => traits[trait]?.bypasses?.length) ) notes.push("resistances that magic or silvered weapons bypass are kept whole");
  for ( const mode of SPEEDS ) {
    const distance = number(system.attributes?.movement?.[mode]);
    if ( distance ) rules.push({schemaVersion: 1, id: `speed-${mode}`, type: "GrantMovement", data: {mode, distance,
      ...(((mode === "fly") && system.attributes?.movement?.hover) ? {hover: true} : {})}});
  }
  rules.push(...senseRules(system.attributes?.senses));
  rules.push(...telepathyRule(traits.languages));
  if ( system.attributes?.senses?.special ) notes.push(`senses: "${system.attributes.senses.special}" by hand`);
  const legendary = number(system.resources?.legact?.max);
  if ( legendary ) rules.push({schemaVersion: 1, id: "legendary-actions", type: "GrantResource",
    data: {resourceId: "legendary-action", label: "Legendary Actions", maximum: legendary, recovery: "turn"}});
  // 2014: in its lair, one Lair Action a round, at the top of the round (WildPathCombat refills it then).
  if ( system.resources?.lair?.value ) rules.push({schemaVersion: 1, id: "lair-actions", type: "GrantResource",
    data: {resourceId: "lair-action", label: "Lair Action", maximum: 1, recovery: "none", refillsAtInitiative: 100}});
  return rules;
}

/* -------------------------------------------- */
/*  Active Effect changes (G3)                   */
/* -------------------------------------------- */

/** V11-era numeric change modes, as V14's change types. */
const CHANGE_MODES = Object.freeze({0: "custom", 1: "multiply", 2: "add", 3: "downgrade", 4: "upgrade", 5: "override"});
/** dnd5e's attack bonus keys: the attack domain, and the attack type a predicate narrows it to. */
// A damage bonus on one kind of attack: dnd5e's `bonuses.mwak.damage`, or 2024's `rolls.damage.mwak.bonus`.
const DAMAGE_BONUS_KEY = /^system\.(?:bonuses\.(mwak|rwak|msak|rsak)\.damage|rolls\.damage\.(mwak|rwak|msak|rsak)\.bonus)$/;
const ATTACK_KEYS = Object.freeze({mwak: ["weapon", "melee"], rwak: ["weapon", "ranged"], msak: ["spell", "melee"], rsak: ["spell", "ranged"]});
const DURATION_UNITS = new Set(["years", "months", "days", "hours", "minutes", "seconds", "rounds", "turns"]);
const EXPIRY_EVENTS = new Set(["combatStart", "roundStart", "turnStart", "combatEnd", "roundEnd", "turnEnd"]);

/** A change's value as a ValueExpression: a dnd5e formula, "+2", or a penalty die ("-1d4" is 0 - 1d4). */
export function changeValue(value, {scales={}}={}) {
  const text = String(value ?? "").trim().replace(/^\+\s*/, "");
  if ( !text.startsWith("-") ) return formulaExpression(text, {scales});
  const rest = formulaExpression(text.slice(1).trim(), {scales});
  if ( rest?.type === "constant" ) return {type: "constant", value: -rest.value};
  return rest ? {type: "subtract", left: {type: "constant", value: 0}, right: rest} : null;
}

/**
 * A damage bonus with dice (`1d4[radiant]`, `1d4`) as ExtraDamage data: `{expression, damageType?}`, null for one that
 * does not parse. A negative one (`- 1d4`), or one `subtract`ed (Reduce's subtract change of `1d4`), is a penalty:
 * `{expression, subtract: true}`.
 */
export function extraDamageOf(value, {subtract=false}={}) {
  let text = String(value ?? "").trim();
  if ( text.startsWith("-") ) {
    text = text.slice(1).trim();
    subtract = !subtract;
  }
  const typed = /\[(\w+)\]/u.exec(text)?.[1]?.toLowerCase();
  const expression = formulaExpression(text.replace(/\[\w+\]/gu, "").replace(/^\+\s*/u, ""));
  if ( !expression || (expression.type === "constant") ) return null;
  return {expression, ...(DAMAGE_TYPES.includes(typed) ? {damageType: typed} : {}), ...(subtract ? {subtract: true} : {})};
}

/**
 * A one-turn duration takes the boundary its 2024 text names, "until the end of its next turn" or "... the start of ...":
 * dnd5e's data often says the start where the text says the end (a Ghoul's Paralyzed). Longer durations keep their
 * data, whose text names a next turn only in passing (Haste's lethargy).
 */
export function textBoundExpiry(duration, text) {
  if ( !duration || (Number(duration.value) !== 1) || !["turns", "rounds"].includes(duration.units) ) return duration;
  const ends = new Set([...String(text ?? "").matchAll(/until the (start|end) of (?:its|the target's|that creature's|the creature's) next turn/giu)]
    .map(match => match[1].toLowerCase()));
  if ( ends.size !== 1 ) return duration;
  return {...duration, expiry: ends.has("end") ? "turnEnd" : "turnStart"};
}

/**
 * An effect's dnd5e duration as a WildPath custom effect's V14 duration, or null when it has none. Older modules' data
 * (Tasha's) keeps it as `{rounds, turns, seconds}`.
 */
function effectDuration(duration) {
  const legacy = ["rounds", "turns", "seconds"].find(units => Number(duration?.[units]) > 0);
  if ( (duration?.value == null) && legacy ) return {value: Number(duration[legacy]), units: legacy};
  const value = Number(duration?.value);
  if ( !(value > 0) || !DURATION_UNITS.has(duration.units) ) return null;
  return {value, units: duration.units, ...(EXPIRY_EVENTS.has(duration.expiry) ? {expiry: duration.expiry} : {})};
}

/**
 * The rules a dnd5e Active Effect's changes become (G3): bonuses as Modifiers (dice ones roll with the d20),
 * advantage and disadvantage as RollModes, damage adjustments, condition immunities, and Speeds. Each change WildPath
 * has no equivalent for is noted, never approximated. `text` is its item's: a penalty its text keeps at 1 damage or more
 * ("this can't reduce the damage below 1", Reduce) says so.
 */
export function effectRules(effect, notes=[], {scales={}, text=""}={}) {
  const changes = effectChanges(effect);
  const rules = [];
  const base = slugify(effect?.name) || "effect";
  const rule = (type, data, predicate=null) => rules.push({schemaVersion: 1, id: `${base}-${rules.length + 1}`, type,
    ...(predicate ? {predicate} : {}), data});
  const modifier = (domains, value, predicate=null) => rule("Modifier", {domains, modifierType: "untyped",
    ...(value.type === "constant" ? {value: value.value} : {valueExpression: value})}, predicate);
  const adjustments = {dr: [], di: [], dv: [], ci: []};
  // Ability score changes, by ability: written as AbilityScore rules once every change is read.
  const scores = {};
  let hover = false;
  // Bonuses on all four kinds of attack with one value are one Modifier on every attack.
  const attackChanges = changes.filter(change => /^system\.bonuses\.(mwak|rwak|msak|rsak)\.attack$/.test(change.key));
  const everyAttack = (attackChanges.length === 4) && (new Set(attackChanges.map(change => String(change.value))).size === 1);
  let everyAttackDone = false;
  // The same penalty in dice on all four is one on every damage roll (Ray of Enfeeblement's "all its damage rolls").
  const penalties = changes.filter(change => DAMAGE_BONUS_KEY.test(String(change.key ?? ""))
    && extraDamageOf(change.value, {subtract: (change.type ?? CHANGE_MODES[change.mode]) === "subtract"})?.subtract);
  const everyDamage = (penalties.length === 4) && (new Set(penalties.map(change => String(change.value))).size === 1);
  let everyDamageDone = false;
  for ( const change of changes ) {
    const key = String(change.key ?? "");
    const type = change.type ?? CHANGE_MODES[change.mode] ?? "add";
    // A class's scale ("+ @scale.barbarian.rage-damage", "@scale.monk.unarmored-movement") reads its table.
    const value = changeValue(change.value, {scales});
    const number = Number(change.value);
    const unmapped = () => notes.push(`effect: "${effect.name}" change ${key} (${type}) not converted`);
    let match;
    if ( (match = /^system\.bonuses\.(mwak|rwak|msak|rsak)\.attack$/.exec(key)) && (type === "add") && value ) {
      if ( everyAttack ) {
        if ( !everyAttackDone ) modifier(["attack"], value);
        everyAttackDone = true;
      } else modifier([`attack.${ATTACK_KEYS[match[1]][0]}`], value, {tagsAny: [ATTACK_KEYS[match[1]][1]]});
    } else if ( (match = /^system\.bonuses\.(mwak|rwak|msak|rsak)\.damage$/.exec(key)) && (type === "add") && value
      && !JSON.stringify(value).includes('"dice"') ) {
      // A flat bonus, or one on a table (Rage's +2 to +4, on Strength-based attacks only).
      modifier([`damage.${ATTACK_KEYS[match[1]][0]}`], value, (effect?.name === "Rage") ? {tagsAll: [ATTACK_KEYS[match[1]][1], "might"]}
        : {tagsAny: [ATTACK_KEYS[match[1]][1]]});
    } else if ( (match = DAMAGE_BONUS_KEY.exec(key))
      && ["add", "subtract"].includes(type) && extraDamageOf(change.value, {subtract: type === "subtract"}) ) {
      // Dice on each hit (Divine Favor's 1d4 Radiant, Enlarge's 1d4): extra damage, of its own type or the attack's.
      // Taken away (Reduce's 1d4 less), the dice come off the hit's damage instead.
      const kind = ATTACK_KEYS[match[1] ?? match[2]];
      const extra = extraDamageOf(change.value, {subtract: type === "subtract"});
      const leavesOne = extra.subtract && /can[’']?t reduce (?:the |its )?damage below 1/iu.test(text);
      const data = {...extra, ...(leavesOne ? {minimum: 1} : {})};
      if ( !(extra.subtract && everyDamage) ) rule("ExtraDamage", {domains: [`damage.${kind[0]}`], ...data}, {tagsAny: [kind[1]]});
      else if ( !everyDamageDone ) rule("ExtraDamage", {domains: ["damage"], ...data});
      everyDamageDone ||= extra.subtract && everyDamage;
    } else if ( (key === "system.traits.size") && ["add", "subtract"].includes(type) && Number.isInteger(number) && number ) {
      // Enlarge/Reduce: sizes larger or smaller; its Tokens grow or shrink while it lasts (foundry-v14-token-size).
      modifier(["size"], {type: "constant", value: (type === "add") ? number : -number});
    } else if ( (match = /^system\.bonuses\.abilities\.(save|check)$/.exec(key)) && (type === "add") && value ) {
      modifier([match[1]], value);
    } else if ( (match = /^system\.abilities\.(\w+)\.bonuses\.(save|check)$/.exec(key)) && ABILITY_MAP[match[1]] && (type === "add") && value ) {
      modifier([`${match[2]}.${ABILITY_MAP[match[1]]}`], value);
    } else if ( (match = /^system\.skills\.(\w+)\.bonuses\.check$/.exec(key)) && DND_SKILLS[match[1]] && (type === "add") && value ) {
      modifier([`check.${slugify(DND_SKILLS[match[1]])}`], value);
    } else if ( (match = /^system\.abilities\.(\w+)\.(save|check)\.roll\.mode$/.exec(key)) && ABILITY_MAP[match[1]] && number ) {
      rule("RollMode", {domains: [`${match[2]}.${ABILITY_MAP[match[1]]}`], mode: number > 0 ? "advantage" : "disadvantage"});
    } else if ( (match = /^system\.skills\.(\w+)\.roll\.mode$/.exec(key)) && DND_SKILLS[match[1]] && number ) {
      rule("RollMode", {domains: [`check.${slugify(DND_SKILLS[match[1]])}`], mode: number > 0 ? "advantage" : "disadvantage"});
    } else if ( (key === "system.attributes.ac.bonus") && (type === "add") && value ) {
      modifier(["defense.ac"], value);
    } else if ( (key === "system.attributes.ac.calc") && UNARMORED_AC[change.value] ) {
      // Mage Armor, Unarmored Defense, Draconic Resilience: a way to work out AC while wearing no armor.
      // A monk's or a dancing bard's without a Shield too; the others' beside one.
      rule("ArmorClass", {label: effect.name, value: {type: "add", terms: [{type: "constant", value: UNARMORED_AC[change.value][0]},
        ...UNARMORED_AC[change.value].slice(1).map(ability => ({type: "ability-modifier", ability}))]}},
      {wearing: {armor: false, ...(["unarmoredMonk", "unarmoredBard"].includes(change.value) ? {shield: false} : {})}});
    } else if ( (key === "system.attributes.ac.calc") && (change.value === "custom")
      && formulaExpression(changes.find(entry => entry.key === "system.attributes.ac.formula")?.value) ) {
      // A formula of its own (Robe of the Archmagi: "15 + @abilities.dex.mod" if you aren't wearing armor).
      rule("ArmorClass", {label: effect.name, value: formulaExpression(changes.find(entry => entry.key === "system.attributes.ac.formula").value)},
        {wearing: {armor: false}});
    } else if ( (key === "system.attributes.ac.formula") && changes.some(entry => (entry.key === "system.attributes.ac.calc")
      && (entry.value === "custom")) && formulaExpression(change.value) ) {
      // Read with its "custom" calculation, above.
    } else if ( (key === "system.attributes.init.bonus") && (type === "add") && value ) {
      modifier(["initiative"], value);
    } else if ( (key === "system.attributes.init.roll.mode") && number ) {
      // Feral Instinct, an Ioun Stone of Awareness: Advantage on Initiative.
      rule("RollMode", {domains: ["initiative"], mode: number > 0 ? "advantage" : "disadvantage"});
    } else if ( (key === "system.attributes.concentration.roll.mode") && number ) {
      // Eldritch Mind: Advantage on saves to keep Concentration.
      rule("RollMode", {domains: ["concentration"], mode: number > 0 ? "advantage" : "disadvantage"});
    } else if ( key === "flags.dnd5e.jackOfAllTrades" ) {
      // 2024 Jack of All Trades: half the Proficiency Bonus (round down) on a skill check without that skill's proficiency.
      modifier(["check.unproficient"], {type: "floor", value: {type: "divide", numerator: {type: "proficiency-bonus"},
        denominator: {type: "constant", value: 2}}});
    } else if ( (key === "system.attributes.death.roll.mode") && number ) {
      // Beacon of Hope: Advantage on Death Saving Throws.
      rule("RollMode", {domains: ["save.death"], mode: number > 0 ? "advantage" : "disadvantage"});
    } else if ( key === "flags.dnd5e.initiativeAdv" ) {
      rule("RollMode", {domains: ["initiative"], mode: "advantage"});
    } else if ( key === "flags.dnd5e.initiativeAlert" ) {
      // 2024 Alert: its Proficiency Bonus on Initiative. shortcut: swapping Initiative with an ally is by hand.
      modifier(["initiative"], {type: "proficiency-bonus"});
    } else if ( (key === "system.bonuses.spell.dc") && (type === "add") && value ) {
      // Innate Sorcery's +1: the save DC of its creature's spells.
      modifier(["dc.spell"], value);
    } else if ( key === "flags.dnd5e.powerfulBuild" ) {
      // 2024 Powerful Build: Advantage on a check to end the Grappled condition, and one size larger for carrying.
      rule("RollMode", {domains: ["check"], mode: "advantage"}, {equals: {path: "check.escapes", value: "grappled"}});
      modifier(["carrying.size"], 1);
    } else if ( ["flags.dnd5e.diamondSoul", "flags.dnd5e.halflingLucky"].includes(key) ) {
      // Disciplined Survivor's saves are its training (trainingKeys), Luck its test offer (HALFLING_LUCK).
    } else if ( key === "flags.dnd5e.halflingNimbleness" ) {
      // Halfling Nimbleness: through the space of any larger creature, without stopping there (foundry-v14-occupancy).
      modifier(["occupancy.pass.larger"], {type: "constant", value: 1});
    } else if ( key === "flags.dnd5e.reliableTalent" ) {
      // 2024 Reliable Talent: on a check with a skill proficiency, a d20 of 9 or lower counts as 10.
      rule("RollOutcome", {domains: ["check.proficient"], outcome: "minimum-natural", threshold: 10});
    } else if ( key === "flags.dnd5e.remarkableAthlete" ) {
      // 2024 Remarkable Athlete: Advantage on Initiative rolls and Strength (Athletics) checks.
      rule("RollMode", {domains: ["initiative", "check.athletics"], mode: "advantage"});
    } else if ( (key === "flags.dnd5e.weaponCriticalThreshold") && ["downgrade", "override"].includes(type) && Number.isInteger(number) ) {
      // Improved Critical, Superior Critical: each widens its weapon attacks' critical range by 1, so they stack (18-20
      // with both; owner's ruling, 2026-10-31). dnd5e's 18 for Superior Critical assumes Improved Critical's 19 before it.
      rule("RollOutcome", {domains: ["attack.weapon"], outcome: "critical-range", widen: 1});
    } else if ( (key === "system.attributes.hp.bonuses.overall") && (type === "add") && value ) {
      // Draconic Resilience: Hit Points, one per sorcerer level.
      modifier(["resources.health.max"], value);
    } else if ( (key === "system.attributes.hp.bonuses.level") && (type === "add") && value ) {
      // Tough, Dwarven Toughness: that much per character level.
      modifier(["resources.health.max"], {type: "multiply", terms: [value, {type: "character-level"}]});
    } else if ( (key === "system.attributes.hp.tempmax") && (type === "add") && value ) {
      modifier(["resources.health.max"], value);
    } else if ( (match = /^system\.traits\.(dr|di|dv|ci)\.value$/.exec(key)) && (type === "add") ) {
      // dnd5e misspells one (Armor of Vulnerability's "bludegoning").
      adjustments[match[1]].push(...String(change.value ?? "").split(/[,;]/).map(entry => entry.trim().toLowerCase()).filter(Boolean)
        .map(entry => ((entry === "bludegoning") ? "bludgeoning" : entry)));
    } else if ( (key === "system.attributes.movement.walk") && ["override", "downgrade"].includes(type) && Number.isFinite(number) ) {
      // shortcut: a walking Speed set to a value only caps it; raising a Speed this way is not converted.
      rule("ResourceCap", {resources: ["movement"], maximum: Math.max(number, 0)});
    } else if ( (key === "system.attributes.movement.walk") && (type === "add") && value ) {
      modifier(["resources.movement.max"], value);
    } else if ( (key === "system.attributes.movement.ignoredDifficultTerrain") && (type === "add") && slugify(change.value) ) {
      // Freedom of Movement ("all"), Boots of the Winterlands ("ice", "snow"): that Difficult Terrain costs nothing extra.
      const kind = slugify(change.value);
      modifier([(kind === "all") ? "terrain.ignore" : `terrain.ignore.${kind}`], {type: "constant", value: 1});
    } else if ( (key === "system.attributes.movement.bonus") && (type === "add") && value ) {
      // Every Speed (Ray of Frost's -10), as Exhaustion's.
      modifier(["resources.movement.max", "speed"], value);
    } else if ( (key === "system.attributes.movement.multiplier") && (number === 0) && ["override", "multiply"].includes(type) ) {
      // Every Speed 0 (Power Word Stun, Haste's Lethargy): movement capped at 0, which caps the other Speeds too.
      rule("ResourceCap", {resources: ["movement"], maximum: 0});
    } else if ( (match = /^system\.attributes\.movement\.(multiplier|walk|fly|swim|climb|burrow)$/.exec(key)) && (type === "multiply")
      && Number.isFinite(number) ) {
      // Haste doubles a Speed, Slow and Spirit Guardians halve it: a factor on every Speed (dnd5e's multiplier) or one mode's.
      modifier([(match[1] === "multiplier") ? "speed.multiplier" : `speed.${match[1]}.multiplier`], {type: "constant", value: number});
    } else if ( (match = /^system\.attributes\.movement\.(fly|swim|climb|burrow)$/.exec(key)) && (type === "add") && (number < 0) ) {
      // Ray of Frost's -10 ft on each Speed.
      modifier([`speed.${match[1]}`], {type: "constant", value: number});
    } else if ( (match = /^system\.attributes\.movement\.(fly|swim|climb|burrow)$/.exec(key)) && ["override", "downgrade"].includes(type)
      && (number === 0) ) {
      // A mode's Speed set to 0 (Caltrops, Freezing Burst): a factor of 0 on it.
      modifier([`speed.${match[1]}.multiplier`], {type: "constant", value: 0});
    } else if ( (match = /^system\.attributes\.movement\.(fly|swim|climb|burrow)$/.exec(key)) && ["upgrade", "override", "add"].includes(type) ) {
      const distance = /^@attributes\.movement\.(walk|speed)$/.test(String(change.value).trim())
        ? {type: "context", path: "actorSystem.resources.movement.max"} : (Number.isFinite(number) && (number > 0) ? number : null);
      if ( distance ) rule("GrantMovement", {mode: match[1], distance});
      else unmapped();
    } else if ( (match = /^system\.attributes\.senses\.(?:ranges\.)?(\w+)$/.exec(key)) && SENSE_KEYS[match[1]]
      && ["upgrade", "override", "add"].includes(type) && (number > 0) ) {
      // Darkvision, Feral Senses, Witch Sight, True Seeing, Stonecunning's Tremorsense; Devil's Sight (dnd5e's
      // Darkvision) is its own sense, which sees through magical Darkness.
      const sense = (/devil.?s sight/i.test(String(effect.name ?? "")) && (SENSE_KEYS[match[1]] === "darkvision")) ? "devilsSight" : SENSE_KEYS[match[1]];
      rule("GrantSense", {sense, range: number});
    } else if ( /^system\.traits\.languages\.(value|custom)$/.test(key) && (type === "add") ) {
      // A language it gives: a language spell's understanding by its effect's name (Comprehend Languages, Tongues, Speak
      // with Animals, Telepathic Bond), Telepathy with its range (a Helm of Telepathy), or, for an effect a spell or
      // feature applies, the language itself (Alter Self's Aquan; worn gear's are its training: trainingKeys).
      const named = LANGUAGE_EFFECTS[String(effect.name ?? "")];
      const telepathy = telepathyRange(change.value);
      const languages = String(change.value ?? "").split(/[,;]/).map(entry => entry.trim().toLowerCase()).filter(Boolean);
      if ( named ) { if ( !rules.some(entry => entry.type === "GrantLanguage") ) rule("GrantLanguage", structuredClone(named)); }
      else if ( telepathy ) rule("GrantLanguage", {language: "telepathy", range: telepathy});
      else if ( !effect.transfer && languages.length ) for ( const language of languages ) rule("GrantLanguage", {language});
      else if ( !effect.transfer ) unmapped();
    } else if ( key === "system.attributes.movement.hover" ) {
      // Fly, Gaseous Form, a Potion of Flying: hovering, on the fly Speed the same effect grants (below).
      hover = ["true", "1"].includes(String(change.value).trim().toLowerCase());
    } else if ( (match = /^system\.abilities\.(\w+)\.(value|max)$/.exec(key)) && ABILITY_MAP[match[1]] && Number.isFinite(number)
      && ((match[2] === "value") ? ["add", "upgrade", "downgrade", "override"].includes(type) : (type === "upgrade")) ) {
      // A Belt of Giant Strength (upgrade), an Ioun Stone (add, with a downgrade as its cap), a Tome (add, with a raised max).
      (scores[ABILITY_MAP[match[1]]] ??= {})[match[2] === "max" ? "max" : type] = number;
    } else if ( (key === "system.traits.languages.communication.telepathy.value") && ["upgrade", "add"].includes(type) && (number > 0) ) {
      // A Myconid's "Telepathy 30 ft.", a Mind Flayer Tooth's: Telepathy with its range.
      rule("GrantLanguage", {language: "telepathy", range: number});
    } else if ( (key === "system.attributes.prof") && (type === "add") && value ) {
      // An Ioun Stone of Mastery: "Your Proficiency Bonus increases by 1."
      modifier(["proficiency"], value);
    } else unmapped();
  }
  if ( hover ) {
    const flying = rules.find(entry => (entry.type === "GrantMovement") && (entry.data.mode === "fly"));
    if ( flying ) flying.data.hover = true;
    else notes.push(`effect: "${effect.name}" hovers without a fly Speed of its own, not converted`);
  }
  for ( const [ability, entry] of Object.entries(scores) ) {
    // "+2, to a maximum of 20": dnd5e's add with a downgrade (an Ioun Stone) or a raised maximum (a Tome's 30).
    const cap = entry.max ?? entry.downgrade ?? null;
    if ( entry.add != null ) rule("AbilityScore", {ability, mode: "add", value: entry.add, ...(cap != null ? {maximum: cap} : {})});
    if ( entry.upgrade != null ) rule("AbilityScore", {ability, mode: "upgrade", value: entry.upgrade});
    if ( (entry.downgrade != null) && (entry.add == null) ) rule("AbilityScore", {ability, mode: "downgrade", value: entry.downgrade});
    if ( entry.override != null ) rule("AbilityScore", {ability, mode: "override", value: entry.override});
    if ( (entry.max != null) && (entry.add == null) ) notes.push(`effect: "${effect.name}" raises ${ability}'s maximum only, not converted`);
  }
  if ( adjustments.dr.length ) rule("GrantResistance", {damageTypes: adjustments.dr});
  if ( adjustments.di.length ) rule("GrantImmunity", {damageTypes: adjustments.di});
  if ( adjustments.dv.length ) rule("GrantVulnerability", {damageTypes: adjustments.dv});
  const conditions = adjustments.ci.filter(id => CONDITION_MAP[id]).map(id => CONDITION_MAP[id]);
  if ( conditions.length ) rule("ConditionImmunity", {conditions});
  for ( const id of adjustments.ci.filter(id => !CONDITION_MAP[id]) ) notes.push(`effect: "${effect.name}" condition immunity ${id} not converted`);
  return rules;
}

/** dnd5e's unarmored AC calculations: base, then the abilities whose modifiers add. */
const UNARMORED_AC = Object.freeze({mage: [13, "agility"], draconic: [13, "agility"], unarmoredMonk: [10, "agility", "wits"],
  unarmoredBarb: [10, "agility", "fortitude"], unarmoredBard: [10, "agility", "presence"]});

const DND_ABILITY_NAMES = Object.freeze({str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom",
  cha: "Charisma"});
const DND_SKILLS = Object.freeze({acr: "Acrobatics", ani: "Animal Handling", arc: "Arcana", ath: "Athletics", dec: "Deception",
  his: "History", ins: "Insight", itm: "Intimidation", inv: "Investigation", med: "Medicine", nat: "Nature", prc: "Perception",
  prf: "Performance", per: "Persuasion", rel: "Religion", slt: "Sleight of Hand", ste: "Stealth", sur: "Survival"});
const capitalize = text => String(text ?? "").charAt(0).toUpperCase() + String(text ?? "").slice(1);
const titleCase = text => String(text ?? "").split(/\s+/).map(capitalize).join(" ");
const average = (count, faces) => Math.floor((count * (faces + 1)) / 2);
const signed = value => (value < 0 ? `- ${-value}` : `+ ${value}`);

/** The words for an area: "20-foot-radius Sphere". */
function templateText(template={}) {
  const size = number(template.size);
  if ( !size ) return "";
  switch ( template.type ) {
    case "sphere": return `${size}-foot-radius Sphere`;
    case "cylinder": return `${size}-foot-radius, ${number(template.height) ?? size}-foot-high Cylinder`;
    case "cone": return `${size}-foot Cone`;
    case "cube": return `${size}-foot Cube`;
    case "line": return `${size}-foot-long, ${number(template.width) ?? 5}-foot-wide Line`;
    case "radius": return `${size}-foot Emanation`;
    default: return `${size}-foot ${capitalize(template.type)}`;
  }
}

/**
 * The source's own description with dnd5e's enrichers resolved: links become their labels, and inline rolls,
 * stat-block attacks, damage, saves and checks become the words dnd5e shows. A creature's numbers come from it.
 */
/** Features WildPath automates where dnd5e's GM note says it does not, or says to track it by hand: the note goes. */
const AUTOMATED_NOTES = new Set(["circle-of-the-land-spells", "natural-recovery"]);

/**
 * A feature's text where WildPath's rules differ from the book's (maintainer decisions): the Defense Fighting Style's
 * +1 AC needs no armor (2026-10-15), so its armor clause and dnd5e's note about turning the effect off go.
 */
export function houseText(document, html) {
  if ( AUTOMATED_NOTES.has(identifierOf(document)) ) return html.replace(/<section[^>]*class="secret"[^>]*>[\s\S]*?<\/section>/gu, "");
  if ( (document.type !== "feat") || (document.system?.type?.subtype !== "fightingStyle") || (document.name !== "Defense") ) return html;
  return html.replace(/While you(?:'re|’re| are) wearing [^<.]*?armor, you gain/u, "You gain")
    .replace(/<section[^>]*class="secret"[^>]*>[\s\S]*?<\/section>/gu, "");
}

export function describe(document, {names={}, creature=null}={}) {
  const html = String(document.system?.description?.value ?? "");
  if ( !html.trim() ) return "";
  const system = document.system ?? {};
  const activities = Object.values(system.activities ?? {}).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const activityFor = id => (id ? activities.find(activity => activity._id === id) : null);
  const firstOf = type => activities.find(activity => activity.type === type) ?? null;
  const caseAs = (text, flags) => (flags.has("lowercase") ? text.toLowerCase() : flags.has("uppercase") ? text.toUpperCase()
    : flags.has("capitalize") ? capitalize(text) : text);

  /** The attack's ability modifier for a creature: its own, a finesse weapon's better one, else by attack type. */
  const attackModifier = activity => {
    if ( !creature ) return null;
    const ability = activity?.attack?.ability;
    if ( ability && ability !== "spellcasting" ) return creature.modifier(ability);
    if ( (system.properties ?? []).includes("fin") ) return Math.max(creature.modifier("str"), creature.modifier("dex"));
    return activity?.attack?.type?.value === "ranged" ? creature.modifier("dex") : creature.modifier("str");
  };
  const attackText = activity => {
    const type = activity?.attack?.type?.value === "ranged" ? "Ranged" : "Melee";
    const modifier = attackModifier(activity);
    const range = pick(activity, system, "range");
    const reach = number(system.range?.reach) ?? number(range.value) ?? 5;
    // The source text supplies the sentence's own period.
    const where = type === "Melee" ? `reach ${reach} ft`
      : `range ${number(system.range?.value) ?? number(range.value) ?? 0}${number(system.range?.long) ? `/${system.range.long}` : ""} ft`;
    return `${type} Attack Roll: ${modifier == null ? "" : `${modifier + creature.proficiency >= 0 ? "+" : ""}${modifier + creature.proficiency}, `}${where}`;
  };
  const damageText = (activity, flags) => {
    const parts = [];
    const base = system.damage?.base;
    const modifier = attackModifier(activity);
    if ( activity?.damage?.includeBase && (base?.number || base?.bonus) ) parts.push({count: number(base.number), faces: number(base.denomination),
      bonus: (modifier ?? 0) + (number(base.bonus) ?? 0), types: base.types ?? []});
    for ( const part of activity?.damage?.parts ?? (activity?.healing ? [activity.healing] : []) ) {
      const bonus = part.bonus === "@mod" ? (modifier ?? 0) : (number(part.bonus) ?? 0);
      if ( (number(part.number) && number(part.denomination)) || bonus ) parts.push({count: number(part.number), faces: number(part.denomination),
        bonus, types: part.types ?? []});
    }
    const text = parts.map(({count, faces, bonus, types}) => {
      const kind = types.length ? ` ${types.map(capitalize).join(" or ")}` : "";
      if ( !(count && faces) ) return `${bonus}${kind}`;
      const dice = `${count}d${faces}${bonus ? ` ${signed(bonus)}` : ""}`;
      return flags.has("average") ? `${average(count, faces) + bonus} (${dice})${kind}` : `${dice}${kind}`;
    }).join(" plus ");
    if ( !text ) return "";
    if ( !flags.has("extended") ) return text;
    return `${activity?.type === "attack" ? "Hit: " : ""}${text}${activity?.healing ? " Hit Points" : " damage"}`;
  };
  const saveText = (activity, params, args) => {
    const ability = params.ability ?? args.find(arg => DND_ABILITY_NAMES[arg]) ?? [].concat(activity?.save?.ability ?? [])[0];
    const dc = number(params.dc) ?? saveValue(activity);
    return `${dc ? `DC ${dc} ` : ""}${DND_ABILITY_NAMES[ability] ?? titleCase(ability ?? "")} saving throw`;
  };
  const checkText = (params, args) => {
    const skill = params.skill ?? args.find(arg => DND_SKILLS[arg]);
    const ability = params.ability ?? args.find(arg => DND_ABILITY_NAMES[arg]);
    const named = [DND_ABILITY_NAMES[ability], DND_SKILLS[skill] ? `(${DND_SKILLS[skill]})` : (params.tool ? `(${titleCase(params.tool)})` : "")]
      .filter(Boolean).join(" ");
    return `${params.dc ? `DC ${params.dc} ` : ""}${named || "ability"} check`;
  };

  /** An activity's save DC: a creature's from its ability, else a flat one. */
  const saveValue = activity => {
    const dc = activity?.save?.dc;
    if ( !dc ) return null;
    return (creature && ABILITY_MAP[dc.calculation] ? creature.saveDC(dc.calculation)?.value : null) ?? number(dc.formula);
  };
  const lookupPath = (data, path) => String(path ?? "").replace(/^@(item.)?/, "").split(".").reduce((value, key) => value?.[key], data ?? null);

  const inline = (inner, label) => {
    const [command, ...rest] = inner.split(/\s+/);
    const params = Object.fromEntries(rest.filter(arg => arg.includes("=")).map(arg => arg.split("=")));
    const args = rest.filter(arg => !arg.includes("="));
    const flags = new Set(args);
    const activity = activityFor(params.activity);
    switch ( command ) {
      case "lookup": {
        const path = args[0];
        if ( path === "@name" ) return creature ? caseAs(creature.name, flags) : (label ?? document.name);
        const source = activity ?? activities[0];
        if ( path === "@activation.condition" ) return source?.activation?.condition || label || "";
        if ( path === "@roll.formula" ) return source?.roll?.formula || label || "";
        if ( String(path).startsWith("@scale.") ) return label ?? "(by class level)";
        if ( path === "@save.dc.value" ) return String(saveValue(source) ?? label ?? "");
        // Regeneration's "regains [[lookup @healing.formula]] Hit Points": its dice and bonus, which dnd5e prepares.
        if ( path === "@healing.formula" ) {
          const {number: count, denomination, bonus} = source?.healing ?? {};
          return [count && denomination ? `${count}d${denomination}` : "", bonus ?? ""].filter(Boolean).join(" + ") || label || "";
        }
        const found = lookupPath(source, path) ?? lookupPath(system, path);
        if ( (found != null) && (typeof found !== "object") ) return caseAs(String(found), flags);
        if ( path === "@labels.description.template" ) return caseAs(templateText(system.target?.template), flags) || label || "";
        if ( path === "@labels.description.affects" ) {
          const type = system.target?.affects?.type || "creature";
          return caseAs(`each ${type === "creatureOrObject" ? "creature or object" : type}`, flags);
        }
        return label ?? "";
      }
      case "/attack": return label ?? attackText(activity ?? firstOf("attack"));
      case "/damage": return label ?? damageText(activity ?? firstOf("attack") ?? activities.find(entry => entry.damage?.parts?.length), flags);
      case "/heal": case "/healing": return label ?? damageText(activity ?? firstOf("heal"), flags);
      case "/save": return label ?? saveText(activity ?? firstOf("save"), params, args);
      case "/check": case "/skill": case "/tool": return label ?? checkText(params, args);
      // An item by id (".abc"), by uuid, or by its own name ("[[/item Rend]]", "[[/item Thunderous Slam]]").
      case "/item": return label ?? creature?.itemNames?.[String(args[0] ?? "").replace(/^\./, "")] ?? names[String(args[0] ?? "").split(".").pop()]
        ?? (String(args[0] ?? "").includes(".") ? "" : args.join(" "));
      case "/award": return label ?? args.join(" ");
      case "/r": case "/roll": case "/gmr": case "/br": case "/sr": case "/pr": return label ?? args.join(" ").replace(/#.*$/, "").trim();
      default: return label ?? inner.replace(/@prof/g, creature ? String(creature.proficiency) : "PB");
    }
  };

  const links = text => text
    .replace(/@(?:UUID|Compendium)\[([^\]]+)\](?:\{([^}]*)\})?/g, (_, uuid, label) => label ?? names[uuid.split(".").pop()] ?? "")
    .replace(/@Embed\[[^\]]*\](?:\{[^}]*\})?/g, "")
    .replace(/&(?:amp;)?reference\[([^\]]+)\](?:\{([^}]*)\})?/gi, (_, inner, label) => label ?? titleCase(inner.split(/\s+/)[0].replace(/^\w+=/, "")));
  // Links first, then inline rolls, then links again: a looked-up value may itself hold a link.
  const rolls = text => text.replace(/\[\[(.*?)\]\](?:\{([^}]*)\})?/g, (_, inner, label) => inline(inner.trim(), label));
  return links(rolls(rolls(links(html))));
}

/** Document ids to names, from every extracted pack (Items, Actors, journal entries and their pages). */
export function nameIndex(documents=[]) {
  const names = {};
  const visit = value => {
    if ( Array.isArray(value) ) return value.forEach(visit);
    if ( !value || (typeof value !== "object") ) return;
    if ( (typeof value._id === "string") && (typeof value.name === "string") ) names[value._id] = value.name;
    // dnd5e's "feat:channel-divinity-cleric": a consumption target by identifier.
    if ( value.type && value.system?.identifier && (typeof value.name === "string") ) names[`${value.type}:${value.system.identifier}`] = value.name;
    for ( const key of ["items", "pages", "results", "effects"] ) if ( value[key] ) visit(value[key]);
  };
  visit(documents);
  return names;
}
