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
 * The conditions an Item's 2024 text gives on a failed save: "On a failed save, a creature has the Prone condition",
 * "Failure: The target has the Charmed condition", "must succeed on a Dexterity saving throw or have the Restrained
 * condition". Not one put on its user ("on you").
 */
function failedSaveConditions(document) {
  const found = new Set();
  const text = plainText(document).replace(/&amp;Reference\[(\w+)[^\]]*\]/g, "$1");
  for ( const sentence of text.split(/(?<=[.!?])\s+/) ) {
    if ( !/on a failed save|failure:|saving throw,? or (?:have|has)\b/i.test(sentence) || /\bon you\b/i.test(sentence) ) continue;
    for ( const [, name] of sentence.matchAll(/\b(?:has|have) the (\w+) condition/gi) ) {
      if ( CONDITION_MAP[name.toLowerCase()] ) found.add(CONDITION_MAP[name.toLowerCase()]);
    }
  }
  return [...found];
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

/** The Beasts a transformation may choose from, by their dnd5e creature documents: `{uuid, name, cr}`, weakest first. */
export function beastsOf(documents, uuidOf) {
  return documents.filter(document => (document.type === "npc") && (document.system?.details?.type?.value === "beast"))
    .map(document => ({uuid: uuidOf(document), name: document.name, cr: number(document.system?.details?.cr) ?? 0}))
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
  "deflect-energy": {event: "damage.applied", match: {phase: "before", targetTokenId: "{self}", tagsAll: ["hit"]}, reduces: DEFLECTION},
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
 * When its 2024 text has a creature repeat the save that let its effect in, ending it on a success: `turnEnd` ("repeats
 * the save at the end of each of its turns"), `turnStart`, or null. "repeats the save at ..." is read first, so a
 * text naming another start-of-turn event before it (a Pit Fiend's poison) still reads right.
 */
function repeatSaveTiming(document) {
  const text = plainText(document).replace(/&amp;Reference\[(\w+)[^\]]*\]/g, "$1");
  const found = /repeats? the save at the (end|start) of each of its turns[^.]*\b(?:ending|ends?)\b[^.]*on a success/i.exec(text)
    ?? /at the (end|start) of each of its turns,? [^.]*repeats? the save[^.]*\b(?:ending|ends?)\b[^.]*on a success/i.exec(text);
  return found ? (found[1].toLowerCase() === "end" ? "turnEnd" : "turnStart") : null;
}

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

/** What a spell ends on its target, by identifier: curses (effects tagged "curse"), or spells up to its own level. */
const ENDS = Object.freeze({
  "remove-curse": {tags: ["curse"]},
  "dispel-magic": {spells: "slot"}
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
 * the 2014 text has it. Null without Beasts to choose from, or for another preset.
 * shortcut: every eligible Beast is offered (not only Beasts seen), it lasts until reverted (not half its druid level
 * in hours), and healing in the form heals the druid's own Hit Points; upgrade with a form Hit Point pool.
 */
function wildShapeDefinition({document, activity, system, spell, level, notes, pool, beasts=[]}) {
  const settings = activity.transform ?? activity.settings ?? {};
  if ( (settings.preset !== "wildshape") || !beasts.length ) return null;
  const owner = settings.identifier || "druid";
  const rows = WILD_SHAPE_2014.limits;
  const highest = Math.max(...Object.values(rows).map(row => row.cr));
  const choice = {id: "form", type: "select-one", label: "Form", required: true,
    options: beasts.filter(beast => beast.cr <= highest).map(beast => ({id: beast.uuid, label: `${beast.name} (CR ${beast.cr})`}))};
  const definition = manualDefinition({document, activity, system, spell, level, notes: [], pool});
  return {...definition, range: {type: "self"}, targeting: {type: "self"},
    configuration: [...(definition.configuration ?? []), choice],
    transform: {choiceId: choice.id, limits: {class: owner, rows}, temporaryHealth: "form"}};
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
    rules: ["attack", "damage"].flatMap(domain => swap({type: "spellcasting-modifier"}, domain))}
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
    const value = number(change.value);
    if ( !value || (change.type !== "add") ) return [];
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
function itemEnchantDefinition({document, activity, system, spell, level, pool, usesOf={}, scales={}}) {
  const sources = (activity.effects ?? []).map(ref => (document.effects ?? []).find(effect => effect._id === ref._id)).filter(Boolean);
  const effects = sources.map(effect => ({name: effect.name, ...(effect.img ? {img: effect.img} : {}), ruleElements: enchantmentRules(effect)}))
    .filter(effect => effect.ruleElements.length);
  if ( !effects.length ) return null;
  const raised = /increases to \+(\d+) when you reach (\d+)(?:st|nd|rd|th) level/i.exec(plainText(document));
  const levelClass = SUBTYPE_CLASS[system.type?.subtype] ?? null;
  if ( raised && (effects.length > 1) ) for ( const effect of effects ) {
    const at = Number(raised[2]);
    effect.level = {...(/\+\d+$/.test(effect.name) ? {min: at} : {max: at - 1}), ...(levelClass ? {class: levelClass} : {})};
    effect.name = effect.name.replace(/\s*\+\d+$/, "");
  }
  // What it suits: a weapon (`restrictions.type`), armor and Shields (its AC bonus), else any Item.
  const kinds = (activity.restrictions?.type === "weapon") ? ["weapon"]
    : effects.some(effect => effect.ruleElements.some(rule => rule.data.domains.includes("defense.ac"))) ? ["armor", "shield"] : [];
  const limited = (activity.consumption?.targets ?? []).find(target => (target.type === "itemUses") && target.target);
  const limitId = limited ? String(limited.target).split(".").pop() : null;
  const limit = (limitId && usesOf[limitId]) ? formulaExpression(String(usesOf[limitId]), {scales}) : null;
  const definition = manualDefinition({document, activity, system, spell, level, notes: [], pool, scales});
  return {...definition, range: {type: "self"}, targeting: {type: "self"},
    configuration: [...(definition.configuration ?? []), {id: "item", type: "select-one", label: "Item", required: true, options: [],
      optionsFrom: {type: "gear", kinds}}],
    enchant: {choiceId: "item", key: limitId ?? identifierOf(document), ...(limit ? {limit} : {}), effects}};
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

/** Features the engine offers itself when they apply (Tactical Mind: withTacticalMind on a failed check). */
const OFFERED_BY_ENGINE = new Set(["tactical-mind", "eldritch-master", "indomitable"]);

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
 * 13, 15 and 17: a pool per level, which the spell its warlock marks as that level's arcanum may spend (on the sheet;
 * action-definitions withMysticArcanum).
 */
const MYSTIC_ARCANUM_POOLS = Object.freeze([[6, 11], [7, 13], [8, 15], [9, 17]].map(([level, from]) => ({schemaVersion: 1,
  id: `mystic-arcanum-${level}`, type: "GrantResource", data: {resourceId: `mystic-arcanum.${level}`, label: `Mystic Arcanum (level ${level})`,
    maximum: {type: "table", key: {type: "class-level", class: "warlock"}, rows: {[from]: 1}, default: 0}, recovery: "longRest"}})));

/**
 * A feature dnd5e leaves without automation, as the effects its use puts on its creature. 2024 Steady Aim: Advantage
 * on its next attack roll this turn, and Speed 0 until the turn ends; only while it hasn't moved this turn (`requires`).
 */
/** It hasn't moved this turn: no movement spent (Steady Aim). shortcut: outside combat movement is never reset. */
const NOT_MOVED = Object.freeze({equals: {path: "actorSystem.resources.movement.spent", value: 0}});

const SELF_EFFECTS = Object.freeze({
  "steady-aim": [{id: "effect-1", type: "effect", name: "Steady Aim", img: "icons/svg/target.svg", endsWhen: "attacks",
    duration: {value: 0, units: "turns", expiry: "turnEnd"},
    ruleElements: [{schemaVersion: 1, id: "steady-aim", type: "RollMode", data: {domains: ["attack"], mode: "advantage"}}]},
  {id: "effect-2", type: "effect", name: "Steady Aim (Speed 0)", img: "icons/svg/target.svg", duration: {value: 0, units: "turns", expiry: "turnEnd"},
    ruleElements: [{schemaVersion: 1, id: "steady-aim-speed", type: "Modifier", data: {domains: ["speed.multiplier"], modifierType: "untyped",
      value: 0}}]}]
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
  // 2024 Countercharm: a save failed against Charmed or Frightened, by itself or an ally within 30 ft, rerolled with
  // Advantage for its Reaction (withAllyTestOffers). Its pool is named here: its activity spends none.
  countercharm: {tests: ["save"], pool: "reaction", rollMode: "advantage", range: 30, against: ["charmed", "frightened"]},
  // Tasha's Flash of Genius: when it or a creature it sees within 30 feet fails an ability check or save, its Intelligence
  // modifier is added, for its Reaction and a use (its own pool, named by its identifier). shortcut: "you can see" is any
  // ally within range, and it is offered only on a failure (as every test offer is).
  "flash-of-genius": {tests: ["check", "save"], pool: "flash-of-genius", reaction: true, range: 30, addAbility: "intellect"},
  // 2024 Disciplined Survivor: a failed save rerolled for 1 Focus Point (its activity's).
  "disciplined-survivor": {tests: ["save"], reroll: true}
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
  "eldritch-smite/Smite": {...weaponHit("eldritch-smite"), dropNotes: /^consumption: attribute|custom formula/, definition: ({consumption: _consumption, ...definition}) => ({...definition,
    costs: {allOf: []}, damage: [{id: "damage-1", expression: {type: "dice", number: 1, faces: 8}, damageType: "force", provenance: "additional"}],
    configuration: [{id: "spell-slot", type: "resource", label: "Pact Magic slot", required: true,
      cost: {anyOf: [[{capability: PACT_SLOT_POOL, amount: 1}]]},
      effects: [{type: "scaleDamage", levelChoiceId: "spell-slot", baseLevel: 0, componentIds: ["damage-1"], dice: {number: 1, faces: 8}}]},
    {id: "prone", type: "option", label: "Prone", required: true, defaultValue: "prone",
      options: [{id: "prone", label: "Knock it Prone", value: "prone"}, {id: "standing", label: "Leave it standing", value: "standing"}],
      effects: [{type: "keepEffect", effectIds: ["effect-1"], keep: {prone: ["effect-1"], standing: []}}]}],
    effects: [{id: "effect-1", type: "condition", conditionId: "prone", maxSize: "huge"}]})},
  // 2024 Hurl Through Hell (Fiend Patron 14): once a turn, on any attack hit, a Charisma save; on a failure 8d10 Psychic
  // and Incapacitated until the end of the warlock's next turn. shortcut: a Fiend's immunity to the damage, and Regain
  // Use (a Pact Magic slot for its use), are by hand.
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
 * shortcut: monk weapons keep their own die and ability.
 */
function martialArtsActions(document, img, source, scales) {
  const {id: _id, label: _label, costs: _costs, ...unarmed} = commonAction({uuid: ""}, "unarmed").system.definition;
  const die = formulaExpression("@scale.monk.die", {scales}) ?? {type: "dice", number: 1, faces: 6};
  const strike = {...unarmed, attack: {...unarmed.attack, properties: ["finesse"]},
    damage: unarmed.damage.map(component => ({...component, expression: die}))};
  const make = (suffix, key, costs, extra={}, ruleElements=[]) => {
    const id = stableId(`${document._id}:${key}`);
    const name = `${document.name} (${suffix})`;
    return {_id: id, _key: `!items!${id}`, name, type: "action", img, system: {active: true, description: "", definition: {
      schemaVersion: 1, id: `action:srd-martial-arts-${key}`, label: name, costs: {allOf: costs}, ...structuredClone(strike), ...extra},
    ruleElements}, flags: {wildpath: {source, conversion: {notes: []}}}};
  };
  return [make("Unarmed Strike", "strike", [{capability: "action", amount: 1}]),
    make("Bonus Unarmed Strike", "bonus", [{capability: "bonus-action", amount: 1}]),
    make("Flurry of Blows Strike", "flurry", [{capability: "flurry-of-blows", amount: 1}], {tags: ["flurry"]}, [structuredClone(FLURRY_POOL)])];
}

/** The spell schools dnd5e abbreviates. */
const SCHOOLS = Object.freeze({abj: "abjuration", con: "conjuration", div: "divination", enc: "enchantment", evo: "evocation",
  ill: "illusion", nec: "necromancy", trs: "transmutation"});

/** An ability modifier added to spell damage under `predicate` (Potent Spellcasting, Empowered Evocation), once a roll. */
function spellDamageBonus(activities, ability, predicate) {
  return {rules: [{schemaVersion: 1, id: `spell-damage-${ability}`, type: "Modifier", predicate, data: {domains: ["damage.spell"],
    modifierType: "untyped", valueExpression: {type: "ability-modifier", ability}}}],
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
      data: {domains: ["damage.spell"], modifierType: "untyped", valueExpression: {type: "ability-modifier", ability: "presence"}}},
    {schemaVersion: 1, id: `affinity-${type}-resistance`, type: "GrantResistance", data: {damageTypes: [type]}}]});
  return {_id: id, _key: `!items!${id}`, name, type: "action", img, system: {active: true, description: "", definition: {schemaVersion: 1,
    id: "action:srd-elemental-affinity", label: name, costs: {allOf: []}, range: {type: "self"}, targeting: {type: "self"},
    effects: types.map(effect), configuration: [{id: "type", type: "select-one", label: "Damage type", required: true,
      options: types.map(type => ({id: type, label: title(type), value: type})), effects: [{type: "keepEffect", effectIds: types}]}]},
  ruleElements: []}, flags: {wildpath: {source, conversion: {notes: []}}}};
}

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
  "exhaustion", "charmed", "deafened", "frightened", "grappled", "incapacitated", "invisible", "paralyzed", "petrified", "dead"]
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

export function formulaExpression(formula, {spell=false, ability=null, scales={}, castLevel=null, challenge=null, spellDC=null}={}) {
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
  text = text
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
    .replace(/@details\.cr/g, challenge == null ? "@details.cr" : String(challenge));
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
function partExpression(part, {spell, ability, scales, notes, label}) {
  if ( part?.custom?.enabled ) {
    const custom = formulaExpression(part.custom.formula, {spell, ability, scales});
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
  const size = number(template.size);
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
        ...(height != null ? {height: {value: height, unit: "ft"}} : {})}};
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
  const perLevel = (typeof count === "number") && String(affects.count).includes("@item.level") && (typeof at(level + 1) === "number")
    ? at(level + 1) - count : 0;
  if ( affects.count && (count == null) ) notes.push(`targets: count "${affects.count}" not converted`);
  if ( count && (typeof count === "object") ) return {targeting: {type: "multiple", required: true, count, ...UP_TO}};
  if ( (count > 1) || perLevel ) return {targeting: {type: (count > 1) ? "multiple" : "single", required: true, count: Math.max(count, 1),
    ...((count > 1) ? UP_TO : {})}, perLevel};
  return {targeting: {type: "single", required: true, count: 1}};
}

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
 * and concentration from its components. A save's damage is halved on a success, as dnd5e's own migration assumes.
 */
export function upgradeLegacy(document) {
  const system = document.system ?? {};
  if ( system.activities || (system.actionType === undefined) ) return document;
  const upgraded = structuredClone(document);
  const s = upgraded.system;
  const [type, attackType, classification] = LEGACY_ACTIONS[system.actionType] ?? (system.activation?.type ? ["utility"] : []);
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
  const levelDice = /^(\d+)d(\d+)$/.exec(scaling.formula ?? "");
  if ( parts[0] && (scaling.mode === "cantrip") ) parts[0].scaling = {mode: "whole"};
  if ( parts[0] && (scaling.mode === "level") && levelDice ) parts[0].scaling = {mode: "whole", number: Number(levelDice[1]), faces: Number(levelDice[2])};
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
      onSave: type === "save" ? (((document.type === "spell") && !Number(system.level)) ? "none" : "half") : undefined},
    ...(type === "heal" ? {healing: parts[0] ?? null} : {}),
    ...(type === "save" ? {save: {ability: save.ability ? [save.ability] : [], dc: {calculation: save.scaling === "spell" ? "spellcasting"
      : (save.scaling === "flat" ? "" : (save.scaling ?? "")), formula: String(save.dc ?? "")}}} : {}),
    effects: (document.effects ?? []).filter(effect => !effect.transfer).map(effect => ({_id: effect._id, onSave: false}))}};
  return upgraded;
}

/**
 * Convert one dnd5e Item (spell, weapon, feat) to WildPath Action Items, one per activity.
 * `scales` maps `<class>.<scale>` to `{level: value}` rows (from the class's ScaleValue advancements).
 * @returns {{ok: true, items: object[], notes: string[]} | {ok: false, reason: string}}
 */
export function convertItem(document, {scales={}, pack=null, saveDC=null, spellDC=null, names={}, creature=null, licensed=isSrd2024, book="SRD 5.2",
  images=["icons/"], spells={}, creatures={}, beasts=[], usesOf={}}={}) {
  if ( !licensed(document) ) return {ok: false, reason: "not SRD 5.2 (CC-BY-4.0)"};
  document = upgradeLegacy(document);
  const system = document.system ?? {};
  // An activity with no type is a stale leftover (Tasha's infusions carry one), not something it does.
  const activities = Object.values(system.activities ?? {}).filter(activity => activity?.type)
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
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
  let testOffer = null;
  const trait = traitOf(document, {activities, system, spell, level, scales, pool, saveDC, creature});
  // A Metamagic option (Quickened Spell: "quickened"), which its sorcerer's spells offer (metamagic.mjs).
  const metamagic = (system.type?.subtype === "metamagic") ? identifierOf(document).replace(/-spell$/, "") : null;
  if ( trait ) allNotes.push(...trait.notes);
  // A spell without activities is still cast: it spends its slot like any other.
  const usable = activities.length ? activities : (spell ? [{type: "manual", activation: {override: false}}] : []);
  for ( const [index, activity] of usable.entries() ) {
    const notes = [...(pool?.notes ?? [])];
    const label = activity.name || activity.type;
    // An activity a common trait automates (Regeneration's healing) is the trait's, not an Action; one the engine offers
    // itself (Indomitable's reroll) is its feature's.
    if ( trait?.consumes?.includes(activity) || OFFERED_BY_ENGINE.has(identifierOf(document)) ) continue;
    // A test offer naming its own pool (Countercharm's Reaction) is its feature's flag, whatever its activation.
    if ( TEST_OFFERS[identifierOf(document)]?.pool ) {
      testOffer = structuredClone(TEST_OFFERS[identifierOf(document)]);
      continue;
    }
    // A passive or triggered ability is not something a creature uses on its turn; its feature carries its text.
    const activation = pick(activity, system, "activation").type ?? "";
    // A feature used when its creature hits (Stunning Strike): offered on that hit, though dnd5e leaves it passive.
    const onHit = OWN_HIT[`${identifierOf(document)}/${activity.name}`] ?? OWN_HIT[identifierOf(document)] ?? null;
    // An enchantment of one of its creature's weapons (Magic Weapon, Sacred Weapon): its weapon's attacks change instead.
    const enchant = ENCHANTS[identifierOf(document)] ?? null;
    if ( enchant && (activity.type !== "enchant") ) continue;
    // Brutal Strike's Actions are its own (brutalStrikeActions), not its dnd5e damage activity.
    if ( ["brutal-strike", "improved-brutal-strike", "elemental-affinity"].includes(identifierOf(document)) ) continue;
    // One pool traded for another (Wild Resurgence, Font of Magic, Restore Use): used, though dnd5e may leave it passive.
    const trades = tradesPools({document, activity, pool, names, scales});
    if ( ["", "none", "special"].includes(activation) && !onHit && !enchant && !trades && !USED_AT_TURN_START.has(identifierOf(document)) ) {
      // A recharge when its creature rolls Initiative (Persistent Rage, Uncanny Metabolism, Archdruid): automatic.
      const recharge = initiativeTrigger({document, activity, system, spell, level, scales, notes, pool, names, saveDC, spellDC, creature,
        beasts}) ?? restTrigger(document, activity);
      if ( recharge ) {
        initiativeRules.push(recharge);
        continue;
      }
      // A die the engine offers on a failed test (Peerless Skill): its feature's flag, paid from the pool it names.
      const offered = TEST_OFFERS[identifierOf(document)];
      const faces = offered ? testOfferFaces(activity.roll?.formula, scales) : null;
      const offerPool = offered ? targetPoolId(activity.consumption?.targets?.[0] ?? {}, pool, names) : null;
      if ( (faces || offered?.setNatural || offered?.reroll) && offerPool ) {
        testOffer = {...offered, pool: offerPool, ...(faces ? {faces} : {})};
        continue;
      }
      // A mark's bonus damage (Hunter's Mark's, Hex's, Favored Enemy's) is its effect's own rule.
      const marked = (activity.type === "damage") && Object.values(EFFECTS_BY_HAND).some(hand => hand.bonusDamage === label);
      // A feature the engine offers on its own (Tactical Mind, with a failed check) needs no Action; one that becomes its
      // own Action (Action Surge: FEATURE_ACTIONS) is not passive.
      if ( !trait && !marked && !metamagic && !OFFERED_BY_ENGINE.has(identifierOf(document)) && !FEATURE_ACTIONS[identifierOf(document)] ) {
        allNotes.push(`"${label}" is passive or triggered: not automated`);
      }
      continue;
    }
    // Monster spellcasting (G4): a cast activity is its spell, at the activity's cost and uses rather than a slot.
    if ( activity.type === "cast" ) {
      const cast = castSpell({document, activity, system, notes, pool, options: {scales, pack, saveDC, names, creature, book, images, spells,
        creatures, beasts}});
      if ( cast ) {
        items.push(cast);
        allNotes.push(...notes);
        continue;
      }
    }
    let definition = ((trades && (activity.type === "utility")) ? {...manualDefinition({document, activity, system, spell, level, notes,
      pool, names, scales}), range: {type: "self"}, targeting: {type: "self"}} : null)
      ?? commonActivity({document, activity, system, spell, level, pool}) ?? (ACTIVITIES.has(activity.type)
      ? convertActivity({document, activity, system, spell, level, scales, notes, pool, saveDC, spellDC, creature, beasts, names})
      : ((activity.type === "summon") ? summonDefinition({document, activity, system, spell, level, notes, pool, creatures, names, beasts, scales})
        : ((activity.type === "teleport") ? teleportDefinition({document, activity, system, spell, level, notes, pool})
          : ((activity.type === "transform") ? wildShapeDefinition({document, activity, system, spell, level, notes, pool, beasts})
            : (enchant ? enchantDefinition({document, activity, system, spell, level, pool, enchant})
              : (((activity.type === "enchant") && SUBTYPE_CLASS[system.type?.subtype])
                ? itemEnchantDefinition({document, activity, system, spell, level, pool, usesOf, scales})
                : null))))));
    if ( !definition ) {
      // Used but not automated: using it spends its cost (and a spell's slot); its description says the rest.
      notes.unshift(`not automated${activity.type === "manual" ? "" : ` (${activity.type})`}: using it spends its cost; its description says the rest`);
      definition = manualDefinition({document, activity, system, spell, level, notes, pool, names, scales});
    }
    const selfEffects = SELF_EFFECTS[identifierOf(document)];
    if ( selfEffects || USED_AT_TURN_START.has(identifierOf(document)) ) {
      definition = {...definition, range: {type: "self"}, targeting: {type: "self"},
        ...(selfEffects ? {effects: structuredClone(selfEffects)} : {}),
        ...((identifierOf(document) === "steady-aim") ? {requires: NOT_MOVED} : {})};
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated")));
    }
    // A spell that fills its area with light (2024 Daylight's sunlight) is a lasting area shedding it.
    const shedding = spell ? sheddingArea({document, activity, system, definition}) : null;
    if ( shedding ) {
      definition = {...definition, ...shedding.definition};
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated") && !note.startsWith("concentration: nothing")),
        ...shedding.notes);
    }
    // An area that keeps acting while it lasts (Moonbeam, Web, Cloudkill): a lasting area whose trigger repeats it.
    const lasting = shedding ? null : lastingArea({document, system, definition});
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
    // A spell's level, for what ends spells by level (Dispel Magic); a slot cast at a higher one says so when used.
    if ( spell && Number.isFinite(Number(level)) ) definition = {...definition, metadata: {...(definition.metadata ?? {}), spellLevel: Number(level)}};
    // A spell's tags say what it is, for rules on spell damage: a cantrip, its school (`school:evocation`: Empowered
    // Evocation), each damage type it deals (`damage:fire`: Elemental Affinity), and its components (Counterspell).
    if ( spell ) definition = {...definition, tags: [...new Set([...(definition.tags ?? []), ...(Number(level) === 0 ? ["cantrip"] : []),
      ...(SCHOOLS[system.school] ? [`school:${SCHOOLS[system.school]}`] : []), ...componentTags(system),
      ...(definition.damage ?? []).map(component => component.damageType).filter(Boolean).map(type => `damage:${type}`)])]};
    // Lay on Hands: "restore a number of Hit Points equal to the points spent", chosen when used, from its pool.
    if ( (identifierOf(document) === "lay-on-hands") && (activity.type === "heal") && pool ) {
      definition = {...definition, costs: {allOf: (definition.costs?.allOf ?? []).filter(cost => cost.capability !== pool.id)},
        targeting: definition.targeting ?? {type: "single", required: true, count: 1},
        // "touch a creature" (dnd5e records its range as self).
        range: {type: "touch", distance: {value: 5, unit: "ft"}},
        healing: [{id: "healing-1", expression: {type: "constant", value: 1}, healingType: "healing"}],
        configuration: [...(definition.configuration ?? []), {id: "points", type: "number", label: "Points", required: true, min: 1,
          effects: [{type: "spendAmount", resourceId: pool.id, componentIds: ["healing-1"]}]}]};
      notes.splice(0, notes.length, ...notes.filter(note => !/not automated|custom formula/.test(note)));
    }
    // What it ends on its target (Remove Curse: curses; Dispel Magic: spells up to its level).
    const ending = ENDS[identifierOf(document)];
    if ( ending ) {
      const range = definition.range ?? rangeOf({activity, system, document, attack: null});
      definition = {...definition, ends: structuredClone(ending), targeting: definition.targeting ?? {type: "single", required: true, count: 1},
        ...(range ? {range} : {})};
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated")),
        ...(ending.spells ? ["dispel: a spell above its level needs the caster's check, by hand; areas and objects by hand"] : []));
    }
    // Flurry of Blows: its Bonus Action and Focus Point fill the strikes Martial Arts' Flurry strike spends.
    const flurry = (identifierOf(document) === "monks-focus") && (activity.name === "Flurry of Blows");
    if ( flurry ) {
      definition = {...definition, range: {type: "self"}, targeting: {type: "self"}, restores: [...(definition.restores ?? []),
        {resourceId: FLURRY_POOL.data.resourceId, amount: 1, amountExpression: structuredClone(FLURRY_POOL.data.maximum)}]};
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated")));
    }
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
    const reaction = (activation === "reaction") ? REACTIONS[identifierOf(document)] : null;
    if ( reaction?.counters ) definition = {...definition, counters: true};
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
    const bonusAC = reaction?.acFromText ? (number(activity.roll?.formula)
      ?? number(/\badds (\d+) to its AC against that attack/i.exec(plainText(document))?.[1])) : null;
    if ( reaction?.halves && !definition.effects?.length ) {
      definition = {...definition, range: {type: "self"}, targeting: {type: "self"}, effects: [{id: "effect-1", type: "effect",
        name: document.name, ...(img ? {img} : {}), endsWhen: "attacked", ruleElements: [{schemaVersion: 1, id: "halved",
          type: "GrantResistance", data: {damageTypes: []}}]}]};
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated")));
    }
    // Its Trigger brings a common Action (Retaliation's melee attack), so its own utility does nothing more.
    if ( reaction?.commonAction ) notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated")));
    if ( reaction?.reduces || reaction?.redirect ) {
      const {healing: _healing, ...rest} = definition;
      definition = {...rest, range: {type: "self"}, targeting: {type: "self"}, rider: {
        ...(reaction.reduces ? {reduceDamage: structuredClone(reaction.reduces)} : {}),
        ...(reaction.redirect ? {redirectDamage: structuredClone(reaction.redirect)} : {}),
        ...(reaction.protects ? {protects: reaction.protects} : {})}};
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated")));
    }
    if ( bonusAC && !definition.effects?.length ) {
      definition = {...definition, range: {type: "self"}, targeting: {type: "self"}, effects: [{id: "effect-1", type: "effect",
        name: document.name, ...(img ? {img} : {}), endsWhen: "attacked", ruleElements: [{schemaVersion: 1, id: "parry", type: "Modifier",
          data: {domains: ["defense.ac"], modifierType: "untyped", value: bonusAC}}]}]};
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated")));
    }
    const smite = (identifierOf(document) === "divine-smite") ? SMITE_TRIGGER : null;
    if ( smite ) definition = smiteDefinition(definition);
    if ( onHit ) {
      definition = {...onHit.definition(definition), ...(onHit.self ? {range: {type: "self"}, targeting: {type: "self"}}
        : {range: {type: "special"}, targeting: {type: "single", required: true, count: 1}}),
      ...(onHit.rider ? {rider: structuredClone(onHit.rider)} : {})};
      // Its effects are its own now, not dnd5e's.
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("effect: ") && !note.startsWith("not automated")
        && !note.startsWith("save: a failure gives") && !onHit.dropNotes?.test(note)));
    }
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
    // A lasting area its caster can move ("a Magic action ... to move the Cylinder up to 60 feet"): its own Action.
    const moveArea = moveAreaDefinition(document, definition);
    if ( moveArea ) items.push(action(stableId(`${id}:move`), `${document.name}${suffix} (Move)`, moveArea));
    // Wild Shape's "leave the form early as a Bonus Action": its own Action.
    if ( definition.transform?.limits ) items.push(action(stableId(`${id}:revert`), `${document.name}${suffix} (Revert)`,
      {schemaVersion: 1, id: `${definition.id}-revert`, costs: {allOf: [{capability: "bonus-action", amount: 1}]},
        range: {type: "self"}, targeting: {type: "self"}, transform: {revert: true}}));
    // 2024 Versatile: the weapon with both hands is its own Action, rolling its larger die.
    const twoHanded = versatileDefinition({document, system, definition});
    if ( twoHanded ) items.push(action(stableId(`${id}:two-handed`), `${document.name}${suffix} (Two-Handed)`, twoHanded));
    allNotes.push(...notes);
  }
  // What it gives while it is had (worn, for gear): its passive effects' rules.
  const passive = [...passiveEffects(document).flatMap(effect => effectRules(effect, allNotes, {scales})), ...emptyPassiveRules(document, allNotes)];
  // Equipment is gear its owner equips (G7): armor's AC, and its passive effects. A potion or scroll is only its Actions.
  if ( GEAR_TYPES.has(document.type) && !((document.type === "consumable") && items.length) ) {
    const gearId = items.some(item => item._id === document._id) ? stableId(`${document._id}:gear`) : document._id;
    // Its training is its flag, no longer a note.
    if ( trainingKeys(document).length ) allNotes.splice(0, allNotes.length, ...allNotes.filter(note => !/traits\.(armorProf|weaponProf|languages)/.test(note)));
    items.unshift({_id: gearId, _key: `!items!${gearId}`, name: document.name, type: "gear", img,
      system: {active: false, description, quantity: Math.max(0, Math.round(number(system.quantity) ?? 1)),
        weight: number(system.weight?.value ?? system.weight) ?? 0, slot: "", ruleElements: [...armorRules(document, allNotes), ...passive],
        attunement: (system.attunement === "required") ? "required" : "", armor: (document.type === "equipment" ? armorKind(system) : null) ?? ""},
      // Its Actions come with it when it is added to a creature (WildPathItem).
      flags: {wildpath: {source, conversion: {notes: [...new Set(allNotes)]}, ...(items.length ? {grants: items.map(item => item._id)} : {}),
        ...(trainingKeys(document).length ? {training: trainingKeys(document)} : {})}}});
  }
  // Halfling Luck: its dnd5e flag is its test offer.
  if ( (document.effects ?? []).some(effect => effectChanges(effect)
    .some(change => change.key === "flags.dnd5e.halflingLucky")) ) testOffer ??= structuredClone(HALFLING_LUCK);
  // Nothing to use: a passive ability is a feature carrying its text (and any uses its other Actions spend).
  if ( !items.length ) {
    // Its training is its flag (`flags.wildpath.training`), no longer a note.
    if ( trainingKeys(document).length ) allNotes.splice(0, allNotes.length, ...allNotes.filter(note => !/traits\.(armorProf|weaponProf|languages)/.test(note)));
    items.push({_id: document._id, _key: `!items!${document._id}`, name: document.name, type: "feature", img,
      // Portent's and Infuse Item's dnd5e use counts are no pool: its dice are (portentDice), and its limit is the
      // enchantments' (itemEnchantDefinition).
      system: {active: true, description, ruleElements: [["portent", "infuse-item"].includes(identifierOf(document)) ? null : pool?.rule,
        ...(trait?.rules ?? []), ...initiativeRules,
        // A paladin's aura is what it grants those around it, not what its dnd5e effect gives the paladin alone.
        ...(PALADIN_AURAS[identifierOf(document)] ? [paladinAura(identifierOf(document))] : passive),
        ...((identifierOf(document) === "paladins-smite") ? [PALADINS_SMITE.pool] : []),
        ...((identifierOf(document) === "mystic-arcanum") ? structuredClone(MYSTIC_ARCANUM_POOLS) : []),
        ...structuredClone(FEAT_ADVANCEMENT[identifierOf(document)]?.rules ?? [])].filter(Boolean),
        ...(FEAT_ADVANCEMENT[identifierOf(document)] ? {advancement: structuredClone(FEAT_ADVANCEMENT[identifierOf(document)].advancement)} : {})},
      flags: {wildpath: {source, conversion: {notes: [...new Set(allNotes)]}, ...(metamagic ? {metamagic} : {}),
        ...(testOffer ? {testOffer} : {}), ...(trainingKeys(document).length ? {training: trainingKeys(document)} : {}),
        // The Diviner's Portent (a monster's, used when it sees a roll, is an Action of its own).
        ...((identifierOf(document) === "portent") ? {portentDice: structuredClone(PORTENT_DICE)} : {})}}});
    if ( identifierOf(document) === "paladins-smite" ) items.push(...paladinsSmiteActions(document, img, source));
    if ( identifierOf(document) === "brutal-strike" ) items.push(...brutalStrikeActions(document, img, source, scales));
    if ( identifierOf(document) === "improved-brutal-strike" ) items.push(...improvedBrutalStrikeActions(document, img, source));
    // Elemental Affinity brings the Action choosing its type.
    if ( identifierOf(document) === "elemental-affinity" ) {
      const choose = elementalAffinityAction(document, img, source);
      items[0].flags.wildpath.grants = [choose._id];
      items.push(choose);
    }
    // Martial Arts brings its Unarmed Strikes with it, so its class grants the feature alone.
    if ( identifierOf(document) === "martial-arts" ) {
      const strikes = martialArtsActions(document, img, source, scales);
      items[0].flags.wildpath.grants = strikes.map(strike => strike._id);
      items.push(...strikes);
    }
  }
  // An Item with Actions carries its automatic triggers on its first (Tireless' Short Rest trigger).
  if ( initiativeRules.length && items.length && (items[0].type !== "feature") ) items[0].system.ruleElements.push(...initiativeRules);
  // A feature used on its turn that dnd5e leaves without an Action (Action Surge): its Action, paid from its own pool.
  const featureAction = FEATURE_ACTIONS[identifierOf(document)];
  if ( featureAction && (pool?.rule || featureAction.free || featureAction.costs) && !items.some(item => item.type === "action") ) {
    const id = stableId(`${document._id}:use`);
    items.push({_id: id, _key: `!items!${id}`, name: document.name, type: "action", img,
      system: {active: true, description, definition: {schemaVersion: 1, id: `action:srd-${slugify(document.name)}`, label: document.name,
        costs: {allOf: featureAction.costs ?? (featureAction.free ? [] : [{capability: pool.id, amount: 1}])}, range: {type: "self"},
        targeting: {type: "self"}, effects: structuredClone(featureAction.effects ?? []),
        ...(featureAction.requires ? {requires: structuredClone(featureAction.requires)} : {})}, ruleElements: [pool?.rule].filter(Boolean)},
      flags: {wildpath: {source, conversion: {notes: []}}}});
  }
  // What it asks of its creature (a feat's, an Invocation's), on each Item it became (the level-up dialog offers it only then).
  const chosen = (system.type?.value === "feat") || ["eldritchInvocation", "artificerInfusion", "maneuver", "metamagic", "fightingStyle"]
    .includes(system.type?.subtype);
  const prerequisites = chosen ? prerequisitesOf(system) : null;
  if ( prerequisites ) for ( const item of items ) item.flags = {...(item.flags ?? {}), wildpath: {...(item.flags?.wildpath ?? {}), prerequisites}};
  return {ok: true, items, notes: [...new Set(allNotes)]};
}

/**
 * Features dnd5e gives no usable activity that are used on their creature's turn, as an Action of their own (2024 Action
 * Surge: "you can take one additional action", no Action itself: one more Action this turn).
 */
const FEATURE_ACTIONS = Object.freeze({
  "action-surge": {effects: [{id: "effect-1", type: "effect", name: "Action Surge", duration: {value: 0, units: "turns", expiry: "turnEnd"},
    ruleElements: [{schemaVersion: 1, id: "action-surge", type: "Modifier", data: {domains: ["resources.action.max"], modifierType: "untyped", value: 1}}]}]},
  // 2024 Reckless Attack (free): "when you make your first attack roll on your turn", Advantage on its Strength attack rolls
  // this turn, and attack rolls against it have Advantage until its next turn; its "reckless" status gates Brutal Strike.
  "reckless-attack": {free: true, requires: {not: {equals: {path: "attackedThisTurn", value: true}}}, effects: [{id: "effect-1", type: "effect", name: "Reckless", slug: "reckless",
    duration: {value: 1, units: "rounds", expiry: "turnStart"}, ruleElements: [
      {schemaVersion: 1, id: "reckless-attacks", type: "RollMode", data: {domains: ["attack.might"], mode: "advantage"}},
      {schemaVersion: 1, id: "reckless-attacked", type: "RollMode", data: {domains: ["attacked"], mode: "advantage"}}]}]},
});

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
  return {...definition, id: `${definition.id}-two-handed`, damage: definition.damage.map(entry => (entry === component
    ? {...entry, expression} : entry))};
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
function passiveEffects(document) {
  const summoned = new Set(Object.values(document.system?.activities ?? {}).filter(activity => activity.type === "summon")
    .flatMap(activity => (activity.effects ?? []).map(effect => effect._id)));
  return (document.effects ?? []).filter(effect => effect.transfer && !effect.disabled && !summoned.has(effect._id));
}

/**
 * What an Item's passive effects, left empty in dnd5e, name in its text: "Advantage on Dexterity (Stealth) checks" (Boots
 * and Cloak of Elvenkind) is that skill's roll mode. Read only when every passive effect has no changes and no statuses; a
 * sentence of Advantage or Disadvantage it can't read is noted (the Cloak's "Perception checks made to see you").
 */
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
  const changes = passiveEffects(document)
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
  // 2024 Potent Spellcasting (cleric, druid): its Wisdom modifier on a cantrip's damage. shortcut: any cantrip, not only
  // its class's.
  "blessed-strikes-potent-spellcasting": (document, {activities}) => spellDamageBonus(activities, "wits", {tagsAll: ["cantrip"]}),
  "elemental-fury-potent-spellcasting": (document, {activities}) => spellDamageBonus(activities, "wits", {tagsAll: ["cantrip"]}),
  // Eldritch Invocation Agonizing Blast: its Charisma modifier on every cantrip's damage (house rule: a feature changing
  // a chosen cantrip changes every cantrip).
  "agonizing-blast": (document, {activities}) => spellDamageBonus(activities, "presence", {tagsAll: ["cantrip"]}),
  // 2024 Empowered Evocation: its Intelligence modifier on one damage roll of an evocation spell.
  "empowered-evocation": (document, {activities}) => spellDamageBonus(activities, "intellect", {tagsAll: ["school:evocation"]}),
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
  // "Doesn't provoke an Opportunity Attack when it flies out of an enemy's reach."
  flyby: () => ({rules: [{schemaVersion: 1, id: "flyby", type: "AvoidOpportunityAttacks", data: {movementModes: ["fly"]}}], notes: []}),
  "pack-tactics": () => ({rules: [{schemaVersion: 1, id: "pack-tactics", type: "RollMode",
    predicate: {equals: {path: "attack.allyNearTarget", value: true}}, data: {domains: ["attack"], mode: "advantage"}}], notes: []}),
  regeneration: (document, {activities, ...options}) => {
    const activity = activities.find(entry => entry.type === "heal");
    const heal = activity ? convertActivity({document, activity, ...options, notes: []}) : null;
    if ( !heal?.healing?.length ) return null;
    const text = plainText(document);
    // "If the troll takes Acid or Fire damage, this trait doesn't function on its next turn": only the types it names.
    const stopping = text.split(/(?<=\.)\s+/).find(sentence => /\btakes\b/i.test(sentence) && /function/i.test(sentence)) ?? "";
    const stoppedBy = DAMAGE_TYPES.filter(type => new RegExp(`\\b${type}\\b`, "i").test(stopping));
    const predicates = [
      ...(/at least 1 hit point/i.test(text) ? [{not: {equals: {path: "actor.system.resources.health.value", value: 0}}}] : []),
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
/** "Alternatively, you cast the spell on an object that isn't being worn or carried": the Token at its center. */
const ON_OBJECT = Object.freeze({id: "on-object", type: "boolean", label: "Cast on an object (the Token at its center)", required: false});
const ROUNDS = Object.freeze({round: 1, minute: 10, hour: 600});

/** A light-shedding spell's lasting area, for its duration; null when the spell is not one or has no area. */
function sheddingArea({document, activity, system, definition}) {
  const light = SHEDS_LIGHT[system.identifier];
  const {targeting, area} = light ? targetingOf({activity, system, notes: []}) : {};
  if ( targeting?.type !== "area" ) return null;
  const rounds = (Number(system.duration?.value) || 0) * (ROUNDS[system.duration?.units] ?? 0);
  return {definition: {targeting, range: rangeOf({activity, system, document, attack: null}),
    configuration: [...(definition.configuration ?? []), {...ON_OBJECT}],
    area: {...area, persistence: {
      ...(rounds ? {duration: {unit: "round", value: rounds}} : {}), ...((system.properties ?? []).includes("concentration") ? {concentration: true} : {}),
      light: {...light(area.size.value), spellLevel: Number(system.level) || 0}, onObject: ON_OBJECT.id}}},
    notes: []};
}

/**
 * An area that keeps acting while it lasts, by its 2024 wording ("A creature also makes this save when it enters the
 * spell's area or ends its turn there": Moonbeam, Web, Cloudkill, Wall of Fire): a lasting area whose trigger repeats
 * the save, damage and effects on a creature that enters it, or starts or ends its turn there. The engine affects a
 * creature once per turn. Null for an area without that wording, or with nothing to repeat. Its damage keeps the ids of
 * the Action's own, so a higher slot's dice reach the repeat too (action-configuration.mjs `applyScaleDamageEffect`).
 */
export function lastingArea({document, system, definition}) {
  if ( (definition.targeting?.type !== "area") || !definition.area || definition.area.persistence ) return null;
  if ( !(definition.damage?.length || definition.effects?.length) ) return null;
  const wording = /[^.]*\b(?:enters?|moves? into)\b[^.]*?\b(starts|ends) (?:its|their) turn\b/iu.exec(plainText(document));
  const rounds = (Number(system.duration?.value) || 0) * (ROUNDS[system.duration?.units] ?? 0);
  // Something with no duration of its own (a flask of Oil) is not a lasting area.
  if ( !wording || !rounds ) return null;
  // The repeat is the same save and outcome on one creature; the area itself holds the concentration.
  const action = {schemaVersion: 1, id: `${definition.id}:lasting`, label: definition.label ?? document.name, costs: {allOf: []},
    ...(definition.tags ? {tags: definition.tags} : {}), ...(definition.save ? {save: definition.save} : {}),
    ...(definition.damage?.length ? {damage: definition.damage} : {}),
    ...(definition.effects?.length ? {effects: definition.effects.map(({concentration: _held, ...effect}) => effect)} : {})};
  return {...definition, area: {...definition.area, persistence: {duration: {unit: "round", value: rounds},
    concentration: (system.properties ?? []).includes("concentration"),
    // "Whenever an enemy you can see enters", or "you can designate creatures to be unaffected" (Spirit Guardians): its
    // caster's side is spared. shortcut: the designated creatures are always the caster's allies.
    ...((/\benem(?:y|ies)\b/iu.test(wording[0]) || /designate creatures to be unaffected/iu.test(plainText(document)))
      ? {affects: "enemies"} : {}),
    triggers: [{on: ["area.entered", wording[1].toLowerCase() === "starts" ? "turn.started" : "turn.ended"], action}]}}};
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

/** The creature stands in sunlight: its Scene is tagged sunlit, or a light tagged as sunlight reaches it. */
const IN_SUNLIGHT = Object.freeze({equals: {path: "inSunlight", value: true}});

/** Disadvantage in sunlight on the rolls its text names, and its damage there at the start of its turn. */
function sunlightTrait(document, {activities, ...options}) {
  const text = plainText(document);
  const domains = /d20 tests/i.test(text) ? ["attack", "check", "save"] : [
    ...(/attack rolls/i.test(text) ? ["attack"] : []),
    ...(/ability checks/i.test(text) ? ["check"] : (/perception/i.test(text) ? ["check.perception"] : [])),
    ...(/saving throws/i.test(text) ? ["save"] : [])];
  if ( !domains.length ) return null;
  const rules = [{schemaVersion: 1, id: "sunlight", type: "RollMode", predicate: IN_SUNLIGHT, data: {domains, mode: "disadvantage"}}];
  const activity = activities.find(entry => entry.type === "damage");
  const burn = activity ? convertActivity({document, activity, ...options, notes: []}) : null;
  if ( burn?.damage?.length ) rules.push({schemaVersion: 1, id: "sunlight-damage", type: "Trigger", data: {event: "turn.started",
    predicate: IN_SUNLIGHT, action: {...burn, costs: {allOf: []}}}});
  return {rules, consumes: burn?.damage?.length ? [activity] : [], notes: []};
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
const markDamage = (slug, damageType, faces=6) => ({schemaVersion: 1, id: `${slug}-damage`, type: "ExtraDamage",
  data: {domains: ["attacked"], expression: {type: "dice", number: 1, faces}, damageType},
  predicate: {equals: {path: `attack.fromAttacker.${slug}`, value: true}}});

const EFFECTS_BY_HAND = Object.freeze({
  // "Any attack roll against an affected creature or object has Advantage if the attacker can see it."
  "faerie-fire": {ruleElements: [{schemaVersion: 1, id: "faerie-fire", type: "RollMode", data: {domains: ["attacked"], mode: "advantage"}}]},
  // 2024 Innate Sorcery: Advantage on the attack rolls of its creature's spells while it lasts (dnd5e's effect has only the
  // +1 save DC). shortcut: any spell, not only Sorcerer spells.
  "innate-sorcery": {extraRules: [{schemaVersion: 1, id: "innate-sorcery-attacks", type: "RollMode", predicate: {tagsAny: ["spell"]},
    data: {domains: ["attack"], mode: "advantage"}}]},
  // "Any creature has Disadvantage on attack rolls against you."
  "blur": {ruleElements: [{schemaVersion: 1, id: "blur", type: "RollMode", data: {domains: ["attacked"], mode: "disadvantage"}}]},
  // "It has Disadvantage on the next attack roll it makes before the end of its next turn."
  // shortcut: it lasts until the end of the caster's next turn, not the target's; its next attack ends it either way.
  "vicious-mockery": {endsWhen: "attacks", duration: {value: 1, units: "rounds", expiry: "turnEnd"},
    ruleElements: [{schemaVersion: 1, id: "vicious-mockery", type: "RollMode", data: {domains: ["attack"], mode: "disadvantage"}}]},
  // "You deal an extra 1d6 Force damage to the target whenever you hit it with an attack roll." The mark is its own
  // effect (slug), so only its caster's attacks see it.
  "hunters-mark": {slug: "hunters-mark", bonusDamage: "Bonus Mark Damage", ruleElements: [markDamage("hunters-mark", "force")]},
  // Rage's effect is the `raging` status (Frenzy reads it).
  "rage": {slug: "raging"},
  // Hex: the same, Necrotic, and Disadvantage on checks of one ability the caster chooses (its six effects, one kept).
  "hex": {slug: "hex", bonusDamage: "Bonus Hex Damage", extraRules: [markDamage("hex", "necrotic")], chooseOne: "Ability"},
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
  "lay-on-hands": {conditions: ["poisoned"], activity: "Remove Poison"}
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
 * A cast activity (a monster's Spellcasting, an item's spell) as its spell's Action: the spell converted with the
 * creature's own save DC and casting ability, at the activity's cost and uses, with no spell slot. Null when the
 * spell is not among `spells`, so the activity stays a manual Action.
 */
function castSpell({document, activity, system, notes, pool: itemPool=null, options}) {
  const spellDocument = options.spells?.[String(activity.spell?.uuid ?? "").split(".").pop()];
  if ( !spellDocument ) {
    notes.push("cast: its spell was not found among the converted spells");
    return null;
  }
  const casting = ABILITY_MAP[activity.spell?.ability] ?? options.creature?.castingAbility ?? null;
  const creature = options.creature && casting
    ? {...options.creature, spellDC: options.creature.saveDC?.(Object.keys(ABILITY_MAP).find(key => ABILITY_MAP[key] === casting))?.value
      ?? options.creature.spellDC} : options.creature;
  // A magic item's own save DC ("Wand of Fireballs: DC 15"), else its user's spell save DC.
  const challenge = activity.spell?.challenge;
  const fixedDC = challenge?.override ? number(challenge.save) : null;
  const converted = convertItem(spellDocument, {...options, creature, spellDC: fixedDC, licensed: () => true});
  const action = converted.items?.find(item => item.type === "action");
  if ( !action ) return null;
  // A wand's charges (the item's uses) or the activity's own uses pay for it.
  // dnd5e leaves some wands' charge out of their cast activity (Wand of Polymorph); its text gives it ("expend 1 charge to cast").
  const charge = (activity.consumption?.targets ?? []).length ? null
    : /\bexpend (\d+) (?:of its )?charges?\b[^.]*\bcast\b/i.exec(plainText(document));
  const paying = charge ? {...activity, consumption: {...activity.consumption, targets: [{type: "itemUses", value: charge[1]}]}} : activity;
  const base = baseDefinition({document, activity: paying, system, spell: false, notes, pool: itemPool, names: options.names ?? {},
    scales: options.scales ?? {}});
  const definition = {...action.system.definition, id: `${base.id}-${slugify(spellDocument.name)}`,
    label: options.creature ? spellDocument.name : `${document.name}: ${spellDocument.name}`,
    tags: [...new Set([...(action.system.definition.tags ?? []), "spell"])], costs: base.costs};
  // Cast without a slot; its other choices stay (Polymorph's Beast, a damage type, one of its effects).
  const choices = (definition.configuration ?? []).filter(choice => choice.id !== "spell-slot");
  if ( choices.length ) definition.configuration = choices;
  else delete definition.configuration;
  if ( definition.attack && casting ) definition.attack = {...definition.attack, ability: casting};
  const castLevel = Number(activity.spell?.level);
  if ( castLevel > (Number(spellDocument.system?.level) || 0) ) notes.push(`cast: ${spellDocument.name} at level ${castLevel} is cast at its own level`);
  notes.push(...converted.notes.filter(note => !note.startsWith("uses:")));
  const pool = activityPool({document, activity, scales: options.scales, spellName: spellDocument.name});
  const id = stableId(`${document._id}:cast:${activity._id ?? spellDocument._id}`);
  // A creature's spell keeps its name; a magic item's is named after the item too ("Wand of Fireballs: Fireball").
  const name = options.creature ? spellDocument.name : `${document.name}: ${spellDocument.name}`;
  return {_id: id, _key: `!items!${id}`, name, type: "action",
    img: kept(spellDocument.img, options.images ?? ["icons/"]) ?? action.img,
    system: {active: true, description: action.system.description, definition, ruleElements: [itemPool?.rule, pool?.rule,
      // A spell's reaction Trigger (a Mage's Counterspell) comes with it.
      ...(action.system.ruleElements ?? []).filter(rule => rule.type === "Trigger")].filter(Boolean)},
    flags: {wildpath: {source: {...action.flags.wildpath.source, castBy: document.name}, conversion: {notes: [...notes]}}}};
}

/**
 * A summon activity (G4) as an Action whose creatures appear where its caster chooses, for the spell's duration (in
 * rounds) or while it concentrates: its creature, or a choice of its creatures, from `creatures` (dnd5e Actor id to
 * WildPath uuid). Null when it chooses by Challenge Rating, or names a creature not converted.
 */
function summonDefinition({document, activity, system, spell, level, notes, pool, creatures, names, beasts=[], scales={}}) {
  // Chosen by Challenge Rating (Find Familiar, Pact of the Chain, Wild Companion): each converted Beast of a profile's
  // CR or lower. shortcut: a Celestial, Fey or Fiend form (Find Familiar) and other creature types are by hand.
  const byChallenge = activity.summon?.mode === "cr";
  const profiles = byChallenge
    ? [...new Map((activity.profiles ?? []).filter(profile => (profile.types ?? []).includes("beast"))
      .flatMap(profile => beasts.filter(beast => beast.cr <= (number(profile.cr) ?? 0))
        .map(beast => [beast.uuid, {profile: {count: profile.count, name: `${beast.name} (CR ${beast.cr})`}, ref: beast.uuid}]))).values()]
    : (activity.profiles ?? []).map(profile => ({profile, ref: creatures[String(profile.uuid ?? "").split(".").pop()] ?? null}));
  if ( byChallenge && !profiles.length ) {
    notes.push("summon: a creature chosen by Challenge Rating is not converted");
    return null;
  }
  if ( !profiles.length || profiles.some(entry => !entry.ref) ) {
    notes.push("summon: its creature is not among the converted creatures");
    return null;
  }
  // Each creature's count: a whole number, or worked out when cast (Animate Dead's 1 + 2 per slot level above 3rd,
  // Animate Objects' spellcasting modifier); different counts per creature (Dancing Lights: 4 small or 1 medium).
  const counts = profiles.map(({profile}) => (String(profile.count ?? "").trim() === "" ? 1
    : (Number.isInteger(Number(profile.count)) ? Number(profile.count) : summonCount(profile.count, level))));
  if ( counts.some(count => (count === null) || (Number.isInteger(count) && (count < 1))) ) {
    notes.push(`summon: a count of "${profiles.map(({profile}) => profile.count).join(", ")}" is not converted`);
    return null;
  }
  const uniform = counts.every(count => Number.isInteger(count)) && (new Set(counts).size === 1);
  // A list, not a map: a uuid's dots would be read as nested keys when stored.
  const byCreature = uniform ? null : profiles.map(({ref}, index) => ({actorRef: ref, count: counts[index]}));
  const definition = manualDefinition({document, activity, system, spell, level, notes: [], pool});
  const rounds = (Number(system.duration?.value) || 0) * (ROUNDS[system.duration?.units] ?? 0);
  const concentration = (system.properties ?? []).includes("concentration");
  const range = rangeOf({activity, system, document, attack: null});
  // What it gains with the spell's level: Hit Points, AC and damage, as expressions of the cast level. Healing and
  // Hit Dice, and formulas of anything but the level, are not converted.
  const bonuses = {};
  const lost = [];
  for ( const [name, formula] of Object.entries(activity.bonuses ?? {}) ) {
    if ( !formula || (String(formula).trim() === "0") ) continue;
    // A spell's by its level; a class feature's by its summoner (a Steel Defender's: Intelligence + 5 per artificer level).
    const expression = ["hp", "ac", "attackDamage", "saveDamage"].includes(name)
      ? (summonBonus(formula) ?? ((document.type === "feat") ? formulaExpression(formula, {scales}) : null)) : null;
    if ( expression ) bonuses[name] = expression;
    else lost.push(name);
  }
  if ( lost.length ) notes.push(`summon: what it gains with the spell's level (${lost.join(", ")}) is not added`);
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
  if ( profiles.length === 1 ) return {...definition, ...(range ? {range} : {}), summon: {actorRef: profiles[0].ref, ...timing}};
  const choice = {id: "summon-creature", type: "select-one", label: "Creature", required: true,
    options: profiles.map(({profile, ref}) => ({id: ref, label: profile.name || names[String(profile.uuid).split(".").pop()] || ref,
      // A spell's profile level is its slot's (Find Steed): not its creature's level.
      ...(spell ? {} : levelOf(profile))}))};
  return {...definition, ...(range ? {range} : {}), configuration: [...(definition.configuration ?? []), choice],
    summon: {choiceId: choice.id, ...timing}};
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
  const text = /\bescape DC (\d+)/i.exec(plainText(document));
  return text ? Number(text[1]) : null;
}

/** Effects named as a common action's own (Step of the Wind's "Disengaged"): that action's effect. */
const COMMON_EFFECTS = Object.freeze({Disengaged: "disengage", Dashing: "dash", Dodging: "dodge"});

/**
 * A teleport of its own creature to a space within a distance (Misty Step's 30 feet, Dimension Door's 500): its cost
 * and `teleport: {distance}`. Null for one with no distance in feet (Teleport, Plane Shift), which stays by hand.
 */
export function teleportDefinition({document, activity, system, spell, level, notes, pool}) {
  const distance = number(activity.teleport?.value);
  if ( !(distance > 0) || ((activity.teleport?.units ?? "ft") !== "ft") ) return null;
  // shortcut: only its creature goes; a willing creature it brings (Dimension Door) is moved by hand.
  if ( /\bwilling creature\b/i.test(plainText(document)) ) notes.push("teleport: a creature it brings along is moved by hand");
  return {...manualDefinition({document, activity, system, spell, level, notes: [], pool}), targeting: {type: "self"}, teleport: {distance}};
}

/** A summon bonus as a ValueExpression of the spell's cast level (`castLevel`): "10 * (@item.level - 4)", "(@item.level - 3)d10". */
/**
 * A summon's count worked out when cast: dnd5e's `@scaling.increase` is the slot levels above the spell's own, and
 * `@attributes.spell.mod` its caster's spellcasting modifier. Null when it does not parse.
 */
function summonCount(formula, level) {
  const text = String(formula).replace(/@scaling\.increase/g, "scalingx").replace(/@attributes\.spell\.mod/g, "spellmodx").trim();
  const parsed = parseFormula(text, {variables: {
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
 */
const SUMMON_RULES = Object.freeze({
  "steel-defender": {limit: 1},
  "homunculus-servant": {limit: 1, endsWithSummoner: true},
  "eldritch-cannon": {limit: "uses"}
});

function summonBonus(formula) {
  const text = String(formula).replace(/@item\.level/g, "castlevelx").trim();
  const variables = {castlevelx: {type: "context", path: "castLevel"}};
  const dice = /^\((.+)\)\s*d\s*(\d+)$/.exec(text);
  const parsed = parseFormula(dice ? dice[1] : text, {variables});
  if ( !parsed.ok ) return null;
  return dice ? {type: "dice", number: parsed.expression, faces: Number(dice[2])} : parsed.expression;
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
  const name = target ? (names[target] ?? names[String(target).split(".").pop()]) : null;
  return name ? {id: slugify(name), notes: [], rule: null} : null;
}

/** Whether a converted definition sustains something on concentration (an effect, a lasting area, a summon, a form). */
function sustainsConcentration(definition) {
  return (definition.effects ?? []).some(effect => effect?.concentration) || Boolean(definition.area?.persistence?.concentration)
    || Boolean(definition.summon?.concentration) || Boolean(definition.transform?.concentration);
}

/** An item's limited uses as a resource pool its Actions spend, with the dnd5e recovery. */
function usesPool({document, scales}) {
  const uses = (identifierOf(document) === "wild-shape") ? WILD_SHAPE_2014.uses : document.system?.uses;
  return poolOf(uses, {id: slugify(document.name), label: document.name, scales});
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
  // "You can": its creature is asked (its reaction policy may say Always or Never), and may let it be.
  const use = {id: "use", type: "option", label: activity.name || document.name, required: true, defaultValue: "use",
    options: [{id: "use", label: "Use it", value: "use"}, {id: "decline", label: "Not now", value: "decline"}],
    effects: [{type: "decline"}]};
  return {schemaVersion: 1, id: `initiative-${slugify(activity.name || "recharge")}`, type: "Trigger", data: {kind: "automation",
    event: "initiative.rolled", predicate, action: {...definition, label: activity.name || document.name, range: {type: "self"},
      targeting: {type: "self"}, configuration: [...(definition.configuration ?? []), use]}}};
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
 * Whether an activity trades one pool for another, all of it converted (it spends one and gives another back): Wild
 * Resurgence, Font of Magic, Font of Inspiration's and Holy Nimbus' recharges. Not one used when its creature rolls
 * Initiative, nor a pact slot's (Hurl Through Hell).
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
  const name = names[target.target] ?? names[String(target.target).split(".").pop()];
  return name ? slugify(name) : (pool?.id ?? null);
}

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
  const note = target => notes.push(`consumption: ${target.type} ${target.value ?? ""} not converted`.trim());
  const poolOfTarget = target => ((target.type === "itemUses") ? targetPoolId(target, pool, names)
    : ((target.type === "activityUses") ? activityPool({document, activity})?.id ?? null : null));
  for ( const target of targets ) {
    if ( target === byLevel ) continue;
    const text = String(target.value ?? "").trim();
    // An amount chosen when used (Ioun Stone of Reserve's "by level"), or rolled (Bag of Beans' 3d4), stays by hand.
    if ( givesBack(text) && ((scaling.allowed && (target.scaling?.mode === "amount") && !text.includes("@scaling"))
      || /\dd\d/i.test(text) || spell) ) {
      note(target);
      continue;
    }
    if ( text.includes("@scaling") ) {
      if ( byLevel && poolOfTarget(target) ) scaled.push({target, id: poolOfTarget(target), text});
      else note(target);
      continue;
    }
    const amount = (text === "") ? 1 : number(text);
    if ( target.type === "spellSlots" ) {
      const slot = number(target.target) || 1;
      if ( amount > 0 ) slotLevels.push(slot);
      else if ( amount < 0 ) restores.push({resourceId: `spell-slot.${slot}`, amount: -amount, refuseWhenFull: true});
      else note(target);
      continue;
    }
    const id = poolOfTarget(target);
    // A formula given back (Persistent Rage's "-@scale.barbarian.rage"): worked out for its creature when used.
    const expression = ((amount == null) && text.startsWith("-")) ? formulaExpression(text.slice(1), {scales}) : null;
    if ( !id || !(amount || expression) ) note(target);
    else if ( amount > 0 ) definition.costs.allOf.push({capability: id, amount});
    else restores.push({resourceId: id, amount: expression ? 1 : -amount, ...(expression ? {amountExpression: expression} : {}),
      refuseWhenFull: true});
  }
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
      const label = costs.map(({target, amount}) => `${amount} ${target.target ? (names[target.target] ?? names[String(target.target)
        .split(".").pop()] ?? "") : document.name}`).join(", ");
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
function slotConfiguration(level, damage, {healing=[], perLevel=0}={}) {
  const levels = Array.from({length: 10 - level}, (_, offset) => level + offset);
  return [{id: "spell-slot", type: "resource", label: "Spell slot", required: true,
    cost: {anyOf: levels.map(each => [{capability: `spell-slot.${each}`, amount: 1}])},
    levelByResourceId: Object.fromEntries(levels.map(each => [`spell-slot.${each}`, each])),
    effects: levelScaling("spell-slot", level, damage, {healing, perLevel})}];
}

/** What a higher level adds to a spell's dice and targets, read from the level its choice `choiceId` names. */
function levelScaling(choiceId, level, damage, {healing=[], perLevel=0}={}) {
  const scale = (type, components) => components.filter(component => component.scaleDice).map(component => ({type, levelChoiceId: choiceId,
    baseLevel: level, componentIds: [component.id], dice: component.scaleDice}));
  return [...scale("scaleDamage", damage), ...scale("scaleHealing", healing),
    ...(perLevel ? [{type: "scaleTargets", levelChoiceId: choiceId, baseLevel: level, perLevel}] : [])];
}

/**
 * A follow-up of a spell already cast (Flame Blade's attack, Hunter's Mark's Move Mark) is at the level the spell was
 * cast: its `cast-level` choice is `fromCast`, answered by the authority from its caster's record, never asked.
 */
function castLevelConfiguration(level, damage, {healing=[], perLevel=0}={}) {
  const scaling = levelScaling("cast-level", level, damage, {healing, perLevel});
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
    if ( (system.properties ?? []).includes("fin") ) attack.properties = ["finesse"];
    if ( attackData.ability && ABILITY_MAP[attackData.ability] ) attack.ability = ABILITY_MAP[attackData.ability];
    const weapon = weaponOf(document);
    if ( weapon ) attack.weapon = weapon;
    definition.attack = attack;
  }
  const range = rangeOf({activity, system, document, attack});
  if ( range ) definition.range = range;
  const {perLevel=0, ...targets} = targetingOf({activity, system, notes, level, scales});
  Object.assign(definition, targets);

  if ( activity.type === "save" ) {
    const abilities = [].concat(activity.save?.ability ?? []);
    const ability = ABILITY_MAP[abilities[0]] ?? null;
    if ( abilities.length > 1 ) notes.push(`save: a choice of ${abilities.join("/")} uses ${abilities[0]}`);
    const dc = activity.save?.dc ?? {};
    // An ability calculation wins (dnd5e keeps a stale `formula` beside it): a creature's is fixed from its numbers, a
    // character's is 8 + proficiency + that ability's modifier. Else a written formula ("@attributes.spell.dc + 2").
    const fromAbility = ABILITY_MAP[dc.calculation] ? (saveDC?.(dc.calculation) ?? {valueExpression: {type: "add", terms: [
      {type: "constant", value: 8}, {type: "proficiency-bonus"}, {type: "ability-modifier", ability: ABILITY_MAP[dc.calculation]}]}}) : null;
    // A fixed spell save DC: a magic item's own, else a creature's.
    const fixed = spellDC ?? creature?.spellDC;
    const written = dc.formula ? formulaExpression(dc.formula, {spell, scales, spellDC: fixed, challenge: creature?.challenge}) : null;
    const value = dc.calculation === "spellcasting" ? (fixed ? {value: fixed} : {valueExpression: SPELL_DC})
      : (fromAbility ?? (written ? (written.type === "constant" ? {value: written.value} : {valueExpression: written}) : null));
    if ( !ability || !value ) {
      notes.push(`save: ${abilities.join("/") || "?"} DC (${dc.calculation || dc.formula || "?"}) not converted`);
      return null;
    }
    definition.save = {ability, dc: value};
  }

  // An ability check its user makes against a DC (picking a lock, slipping manacles): the creature's own check.
  if ( activity.type === "check" ) {
    // A spell's check is its target's (Maze's escape), not the caster's: by hand.
    if ( spell ) return null;
    const check = checkOf(activity.check ?? {}, {spell, scales, notes});
    if ( !check ) return null;
    definition.check = check;
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
  // A part of several types is the user's choice when used (Dragonborn's Breath Weapon, Chromatic Orb).
  const typeChoices = [];
  for ( const [index, part] of (activity.damage?.parts ?? []).entries() ) {
    const expression = partExpression(part, {spell, ability: null, scales, notes, label: `damage ${index + 1}`});
    if ( !expression ) continue;
    const types = (part.types ?? []).filter(type => DAMAGE_TYPES.includes(type));
    if ( types.length > 1 ) typeChoices.push({id: `damage-type-${index + 1}`, type: "damage-type", label: "Damage type", required: true,
      allowedDamageTypes: types, effects: [{type: "replaceDamageType", componentIds: [`damage-${index + 1}`],
        damageTypeChoiceId: `damage-type-${index + 1}`}]});
    else if ( (part.types ?? []).length > 1 ) notes.push(`damage ${index + 1}: a choice of ${part.types.join("/")} uses ${part.types[0]}`);
    const scale = scaledDice(part, {spell, level});
    const cantrip = spell && !level && (part.scaling?.mode === "whole");
    damage.push({id: `damage-${index + 1}`, expression: cantrip ? cantripTable(expression) : expression, damageType: part.types?.[0] ?? "untyped",
      provenance: spell ? "spell-base" : "additional", ...(scale ? {scaleDice: scale} : {})});
  }
  const onSave = activity.damage?.onSave;
  if ( definition.save && damage.length && (onSave === "half" || onSave === "none") ) {
    for ( const component of damage ) component.saveOutcomePolicy = {success: onSave, failure: "full"};
  }

  const healing = [];
  if ( activity.type === "heal" && activity.healing ) {
    const expression = partExpression(activity.healing, {spell, ability: null, scales, notes, label: "healing"});
    const scale = scaledDice(activity.healing, {spell, level});
    // Temporary Hit Points (False Life, Inspiring Leader) are their own healing type.
    const healingType = (activity.healing.types ?? []).includes("temphp") ? "temporary" : "healing";
    if ( expression ) healing.push({id: "healing-1", expression, healingType, ...(scale ? {scaleDice: scale} : {})});
  }

  const effects = [];
  const concentration = (system.properties ?? []).includes("concentration");
  // A spell given its rules by hand whose activity names no effect (Blur's) uses the spell's own effect.
  const references = activity.effects?.length ? activity.effects : (effectsByHand(document, activity)
    ? (document.effects ?? []).filter(effect => !effect.transfer).map(effect => ({_id: effect._id})) : []);
  const byHand = effectsByHand(document, activity);
  // A grapple's or restraint's escape DC, from its Escape Check activity or "(escape DC 13)" in the text.
  const escapeDC = escapeDCOf(document, {creature, saveDC});
  // What each of the activity's dnd5e effects became (one can be several conditions), for the choice below.
  const groups = [];
  for ( const reference of references ) {
    const effect = (document.effects ?? []).find(entry => entry._id === reference._id);
    const first = effects.length;
    const statuses = effectStatuses(effect);
    const known = statuses.filter(status => CONDITION_MAP[status]);
    // dnd5e applies an effect on a successful save only when it says so (`onSave` defaults to false).
    const onFailure = definition.save && (reference.onSave !== true) ? {saveOutcomePolicy: "failure"} : {};
    // A mark given by hand (its slug) is its own status ("marked", "cursed").
    if ( !byHand?.slug ) for ( const status of statuses.filter(status => !CONDITION_MAP[status] && (status !== "marked")) ) {
      notes.push(`effect: ${status} is not a WildPath condition yet`);
    }
    for ( const status of known ) {
      const escapes = (escapeDC != null) && ["grappled", "restrained"].includes(CONDITION_MAP[status]);
      effects.push({id: `effect-${effects.length + 1}`, type: "condition", conditionId: CONDITION_MAP[status], ...onFailure,
        ...(concentration ? {concentration: true} : {}), ...(escapes ? {metadata: {escapeDC}} : {})});
    }
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
    const rules = [...(hand?.ruleElements ?? (effect ? effectRules(effect, notes, {scales}) : [])), ...(byHand?.extraRules ?? []),
      ...structuredClone(EFFECT_REACTIONS[`${identifierOf(document)}/${effect?.name}`] ?? [])];
    // dnd5e's "marked" (Guiding Bolt, Shining Smite): attack rolls against its creature have Advantage; only the next
    // one when its text says so, and the effect then ends after that attack.
    const marked = statuses.includes("marked") && !byHand?.slug;
    if ( marked ) rules.push({schemaVersion: 1, id: "marked", type: "RollMode", data: {domains: ["attacked"], mode: "advantage"}});
    const nextAttack = marked && /\bnext attack roll[^.]*against/i.test(plainText(document));
    if ( rules.length ) {
      // "before the end of your next turn": a round, from its caster's turn (V14 starts it on the source's Combatant).
      const untilNextTurnEnd = nextAttack && /before the end of your next turn/i.test(plainText(document))
        ? {value: 1, units: "rounds", expiry: "turnEnd"} : null;
      const duration = hand?.duration ?? effectDuration(effect.duration) ?? untilNextTurnEnd;
      effects.push({id: `effect-${effects.length + 1}`, type: "effect", name: effect.name, ...(byHand?.slug ? {slug: byHand.slug} : {}),
        ...(effect.img ? {img: effect.img} : {}),
        ruleElements: rules, ...(duration ? {duration} : {}), ...((hand?.endsWhen ?? (nextAttack ? "attacked" : null))
          ? {endsWhen: hand?.endsWhen ?? "attacked"} : {}), ...onFailure,
        ...(concentration ? {concentration: true} : {})});
    } else if ( effect && !known.length ) {
      // Nothing of it maps (Alter Self, Acid Arrow's lingering acid): it still marks its creature, for its duration and
      // its caster's concentration, and what it does is by hand.
      const duration = effectDuration(effect.duration);
      effects.push({id: `effect-${effects.length + 1}`, type: "effect", name: effect.name, ...(effect.img ? {img: effect.img} : {}),
        ruleElements: [], ...(duration ? {duration} : {}), ...onFailure, ...(concentration ? {concentration: true} : {})});
      notes.push(`effect: "${effect.name}" marks its creature only; its rules are by hand`);
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

  if ( damage.length ) definition.damage = damage.map(({scaleDice: _scale, ...component}) => component);
  if ( healing.length ) definition.healing = healing.map(({scaleDice: _scale, ...component}) => component);
  // Bardic Inspiration: the creature may add the bard's die to a failed d20 test (its size on the bard's level).
  if ( identifierOf(document) === "bardic-inspiration" ) {
    const faces = formulaExpression("@scale.bard.inspiration.faces", {scales});
    if ( faces ) for ( const effect of effects.filter(entry => entry.type === "effect") ) {
      effect.metadata = {...(effect.metadata ?? {}), addDie: {faces}};
    }
  }
  // "At the end of each of its turns, the target repeats the save, ending the spell on itself on a success" (Hold
  // Person): each effect a failed save gives is saved against again then.
  const repeat = definition.save ? repeatSaveTiming(document) : null;
  if ( repeat ) for ( const effect of effects ) {
    if ( (effect.saveOutcomePolicy === "failure") && !((effect.levels ?? 1) < 0) ) effect.repeatSave = repeat;
  }
  if ( effects.length ) definition.effects = effects;

  // A spell of level 1 or higher spends a slot of its level or higher; damage dice that scale grow per level above.
  // A follow-up activity that spends none (Hunter's Mark's Move Mark, Flame Blade's attack) has no slot choice: it is at
  // the level its spell was cast (castLevelConfiguration).
  if ( spell && level && SLOT_MODES.has(system.preparation?.mode ?? "prepared") && (activity.consumption?.spellSlot !== false) ) {
    definition.configuration = slotConfiguration(level, damage, {healing, perLevel});
  } else if ( spell && level && (activity.consumption?.spellSlot === false) ) {
    const followUp = castLevelConfiguration(level, damage, {healing, perLevel});
    if ( followUp.length ) definition.configuration = [...(definition.configuration ?? []), ...followUp];
  }
  // Such a follow-up continues its spell's concentration rather than starting one (startsConcentration).
  if ( spell && level && (activity.consumption?.spellSlot === false) ) definition.metadata = {...(definition.metadata ?? {}), followUp: true};
  if ( typeChoices.length ) definition.configuration = [...(definition.configuration ?? []), ...typeChoices];
  // dnd5e lists an activity's effects as options its user applies (Blindness or Deafness, one of Hex's abilities, a
  // Shadow's -1 to -4): a choice keeps one, with every condition it brings.
  if ( groups.length > 1 ) {
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
  if ( definition.save && !damage.length && !healing.length && !effects.length && !definition.check ) {
    const conditions = failedSaveConditions(document);
    for ( const conditionId of conditions ) effects.push({id: `effect-${effects.length + 1}`, type: "condition", conditionId,
      saveOutcomePolicy: "failure", ...(concentration ? {concentration: true} : {})});
    const lasting = conditions.length ? null : lastingDuration(pick(activity, system, "duration"));
    if ( lasting || (!conditions.length && concentration) ) effects.push({id: "effect-1", type: "effect", name: document.name,
      ...(document.img ? {img: document.img} : {}), ruleElements: [], ...(lasting ? {duration: lasting} : {}), saveOutcomePolicy: "failure",
      ...(concentration ? {concentration: true} : {})});
    if ( effects.length ) {
      definition.effects = effects;
      notes.push(conditions.length ? `save: a failure gives ${conditions.join(", ")} (its text); the rest is by hand`
        : "save: a failure marks its creature only; what it does is by hand");
    }
  }
  if ( concentration && !effects.length ) notes.push("concentration: nothing it sustains was converted");
  if ( damage.length || healing.length || effects.length || definition.check ) return definition;
  // An attack or save with nothing converted on it still rolls (Command, Counterspell, a Net): the card shows who
  // saved or was hit, and the description says what follows.
  if ( definition.save || definition.attack ) {
    notes.push(`rolled (${activity.type}); what it does is by hand`);
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

/** A damage or healing part's dice per spell level above its own, or null (a cantrip grows by character level instead). */
function scaledDice(part, {spell, level}) {
  if ( !spell || !level || !part?.scaling ) return null;
  if ( (part.scaling.mode !== "whole") && !number(part.scaling.number) ) return null;
  const count = number(part.scaling.number) ?? 1;
  const faces = number(part.scaling.faces) ?? number(part.denomination);
  return faces ? {number: count, faces} : null;
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

/** 2024 proficiency bonus by Challenge Rating. */
export const proficiencyForChallenge = challenge => Math.max(2, Math.floor((Math.max(Number(challenge) || 0, 1) - 1) / 4) + 2);

/**
 * Convert a dnd5e creature (an `npc` Actor) to a WildPath NPC with its Actions.
 * - Abilities, Hit Points, AC (worn armor and shield, or the stat block's natural AC), Speeds and size carry over.
 * - Its weapons and abilities become Action Items; a save DC from an ability is fixed at 8 + proficiency + modifier.
 * - Resistances and immunities, and Legendary Actions (a pool that refills each turn), go on a Traits feature.
 * @returns {{ok: true, actor: object, notes: string[]} | {ok: false, reason: string}}
 */
export function convertActor(document, {scales={}, pack=null, names={}, licensed=isSrd2024, book="SRD 5.2", images=["icons/"], spells={},
  creatures={}, beasts=[]}={}) {
  if ( !licensed(document) ) return {ok: false, reason: "not SRD 5.2 (CC-BY-4.0)"};
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
    itemNames: Object.fromEntries((document.items ?? []).map(item => [item._id, item.name]))};

  const items = [];
  for ( const item of document.items ?? [] ) {
    // dnd5e's cached copy of a spell a cast activity casts: the cast activity converts it.
    if ( (item.type === "equipment") || item.flags?.dnd5e?.cachedFor ) continue;
    const result = convertItem(item, {scales, pack, saveDC, names, creature, licensed, book, images, spells, creatures, beasts});
    if ( !result.ok ) {
      notes.push(`${item.name}: ${result.reason}`);
      continue;
    }
    notes.push(...result.notes.map(note => `${item.name}: ${note}`));
    for ( const converted of result.items ) {
      // Legendary Actions are paid from the creature's own pool, not a pool per item.
      converted.system.ruleElements = converted.system.ruleElements.filter(rule => rule.type !== "GrantResource" || !converted.system
        .definition?.costs.allOf.some(cost => cost.capability === "legendary-action"));
      items.push({...converted, _key: `!actors.items!${actorId}.${converted._id}`});
    }
  }

  multiattack(items, notes);

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
  const count = item ? multiattackCount(item.system.description) : null;
  // A summoned spirit's: "a number of attacks equal to half this spell's level (round down)", by the level it was
  // summoned at (`flags.wildpath.summonLevel`, set when it is summoned).
  const byLevel = !count && item && /half (?:this|the) spell['’]s level/i.test(String(item.system.description).replace(/<[^>]+>/g, " "));
  if ( !count && !byLevel ) return;
  // A spell the creature casts is not one of its Multiattack's attacks.
  const attacks = items.filter(action => (action !== item) && action.system?.definition?.attack && !action.flags?.wildpath?.source?.castBy
    && (action.system.definition.costs?.allOf ?? []).some(cost => cost.capability === "action"));
  // At most half of 9th level: a restore that fills the spirit's pool whatever its size.
  const plans = (byLevel ? null : multiattackPlans(item.system.description, attacks.map(action => action.name)))
    ?? [[{names: null, amount: count ?? 4}]];
  const bare = name => name.replace(/\s*\(.*\)\s*$/, "");
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
  const extras = multiattackExtras(item.system.description, others.map(action => action.name));
  const extraActions = names => others.filter(action => names.includes(action.name)
    || (names.includes(SPELLS) && action.flags?.wildpath?.source?.castBy));
  const usesPool = extras.uses ? {id: extras.uses.names.length === 1 ? `multiattack-${slugify(bare(extras.uses.names[0]))}`
    : `multiattack-${slugify(extras.uses.names.map(bare).join(" or "))}`, label: `Multiattack (${extras.uses.names.map(bare).join(" or ")})`
    .replace(SPELLS, "Spellcasting"), maximum: extras.uses.amount} : null;
  const replacePool = extras.replace ? {id: "multiattack-replace", label: "Multiattack (replace an attack)", maximum: extras.replace.amount ?? count}
    : null;
  for ( const pool of [usesPool, replacePool] ) if ( pool ) pools.set(pool.id, {...pool, names: []});
  // shortcut: without names, any of the creature's attacks may be each of them; other parts of it are used by hand.
  // Other parts it does not name ("and uses Frightful Presence" when it has no such Action) are used by hand too.
  const rest = /\breplace|\buses?\b/i.test(String(item.system.description).replace(/<[^>]+>/g, " ")) && (extras.unknown
    || !(extras.uses || extras.replace));
  const note = !named ? "Multiattack: any of its attacks may be each of the attacks; other parts of it are used by hand"
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
    type: "GrantResource", data: {resourceId: pool.id, label: pool.label, maximum: (byLevel && !pool.names) ? HALF_SUMMON_LEVEL : pool.maximum,
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
  // 2014: in its lair, one Lair Action a round (on initiative 20); shortcut: it comes back at the start of its turn.
  if ( system.resources?.lair?.value ) rules.push({schemaVersion: 1, id: "lair-actions", type: "GrantResource",
    data: {resourceId: "lair-action", label: "Lair Action", maximum: 1, recovery: "turn"}});
  return rules;
}

/* -------------------------------------------- */
/*  Active Effect changes (G3)                   */
/* -------------------------------------------- */

/** V11-era numeric change modes, as V14's change types. */
const CHANGE_MODES = Object.freeze({0: "custom", 1: "multiply", 2: "add", 3: "downgrade", 4: "upgrade", 5: "override"});
/** dnd5e's attack bonus keys: the attack domain, and the attack type a predicate narrows it to. */
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
 * A damage bonus with dice (`1d4[radiant]`, `1d4`) as ExtraDamage data: `{expression, damageType?}`; null for a negative
 * one (Reduce's `- 1d4`) or one that does not parse.
 */
export function extraDamageOf(value) {
  const text = String(value ?? "").trim();
  if ( text.startsWith("-") ) return null;
  const typed = /\[(\w+)\]/u.exec(text)?.[1]?.toLowerCase();
  const expression = formulaExpression(text.replace(/\[\w+\]/gu, "").replace(/^\+\s*/u, ""));
  if ( !expression || (expression.type === "constant") ) return null;
  return {expression, ...(DAMAGE_TYPES.includes(typed) ? {damageType: typed} : {})};
}

/** An effect's dnd5e duration as a WildPath custom effect's V14 duration, or null when it has none. */
function effectDuration(duration) {
  const value = Number(duration?.value);
  if ( !(value > 0) || !DURATION_UNITS.has(duration.units) ) return null;
  return {value, units: duration.units, ...(EXPIRY_EVENTS.has(duration.expiry) ? {expiry: duration.expiry} : {})};
}

/**
 * The rules a dnd5e Active Effect's changes become (G3): bonuses as Modifiers (dice ones roll with the d20),
 * advantage and disadvantage as RollModes, damage adjustments, condition immunities, and Speeds. Each change WildPath
 * has no equivalent for is noted, never approximated.
 */
export function effectRules(effect, notes=[], {scales={}}={}) {
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
    } else if ( (match = /^system\.(?:bonuses\.(mwak|rwak|msak|rsak)\.damage|rolls\.damage\.(mwak|rwak|msak|rsak)\.bonus)$/.exec(key))
      && (type === "add") && extraDamageOf(change.value) ) {
      // Dice on each hit (Divine Favor's 1d4 Radiant, Enlarge's 1d4): extra damage, of its own type or the attack's.
      const kind = ATTACK_KEYS[match[1] ?? match[2]];
      rule("ExtraDamage", {domains: [`damage.${kind[0]}`], ...extraDamageOf(change.value)}, {tagsAny: [kind[1]]});
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
      rule("ArmorClass", {label: effect.name, value: {type: "add", terms: [{type: "constant", value: UNARMORED_AC[change.value][0]},
        ...UNARMORED_AC[change.value].slice(1).map(ability => ({type: "ability-modifier", ability}))]}});
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
    } else if ( key === "flags.dnd5e.initiativeAlert" ) {
      // 2024 Alert: its Proficiency Bonus on Initiative. shortcut: swapping Initiative with an ally is by hand.
      modifier(["initiative"], {type: "proficiency-bonus"});
    } else if ( (key === "system.bonuses.spell.dc") && (type === "add") && value ) {
      // Innate Sorcery's +1: the save DC of its creature's spells.
      modifier(["dc.spell"], value);
    } else if ( key === "flags.dnd5e.powerfulBuild" ) {
      // 2024 Powerful Build: Advantage on a check to end the Grappled condition. shortcut: carrying capacity is not tracked.
      rule("RollMode", {domains: ["check"], mode: "advantage"}, {equals: {path: "check.escapes", value: "grappled"}});
    } else if ( ["flags.dnd5e.diamondSoul", "flags.dnd5e.halflingLucky"].includes(key) ) {
      // Disciplined Survivor's saves are its training (trainingKeys), Luck its test offer (HALFLING_LUCK).
    } else if ( key === "flags.dnd5e.reliableTalent" ) {
      // 2024 Reliable Talent: on a check with a skill proficiency, a d20 of 9 or lower counts as 10.
      rule("RollOutcome", {domains: ["check.proficient"], outcome: "minimum-natural", threshold: 10});
    } else if ( key === "flags.dnd5e.remarkableAthlete" ) {
      // 2024 Remarkable Athlete: Advantage on Initiative rolls and Strength (Athletics) checks.
      rule("RollMode", {domains: ["initiative", "check.athletics"], mode: "advantage"});
    } else if ( (key === "flags.dnd5e.weaponCriticalThreshold") && ["downgrade", "override"].includes(type) && Number.isInteger(number) ) {
      // Improved Critical (19), Superior Critical (18): its weapon attacks score a Critical Hit on that d20 or more.
      rule("RollOutcome", {domains: ["attack.weapon"], outcome: "critical-range", threshold: number});
    } else if ( (key === "system.attributes.hp.bonuses.overall") && (type === "add") && value ) {
      // Draconic Resilience: Hit Points, one per sorcerer level.
      modifier(["resources.health.max"], value);
    } else if ( (key === "system.attributes.hp.bonuses.level") && (type === "add") && value ) {
      // Tough, Dwarven Toughness: that much per character level.
      modifier(["resources.health.max"], {type: "multiply", terms: [value, {type: "character-level"}]});
    } else if ( (key === "system.attributes.hp.tempmax") && (type === "add") && value ) {
      modifier(["resources.health.max"], value);
    } else if ( (match = /^system\.traits\.(dr|di|dv|ci)\.value$/.exec(key)) && (type === "add") ) {
      adjustments[match[1]].push(...String(change.value ?? "").split(/[,;]/).map(entry => entry.trim().toLowerCase()).filter(Boolean));
    } else if ( (key === "system.attributes.movement.walk") && ["override", "downgrade"].includes(type) && Number.isFinite(number) ) {
      // shortcut: a walking Speed set to a value only caps it; raising a Speed this way is not converted.
      rule("ResourceCap", {resources: ["movement"], maximum: Math.max(number, 0)});
    } else if ( (key === "system.attributes.movement.walk") && (type === "add") && value ) {
      modifier(["resources.movement.max"], value);
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
/**
 * A feature's text where WildPath's rules differ from the book's (maintainer decisions): the Defense Fighting Style's
 * +1 AC needs no armor (2026-10-15), so its armor clause and dnd5e's note about turning the effect off go.
 */
export function houseText(document, html) {
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
