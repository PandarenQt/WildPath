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

/** dnd5e ability keys to WildPath's. */
export const ABILITY_MAP = Object.freeze({str: "might", dex: "agility", con: "fortitude", int: "intellect", wis: "wits", cha: "presence"});
/** dnd5e statuses WildPath has conditions for. */
const CONDITION_MAP = Object.freeze(Object.fromEntries(["prone", "blinded", "restrained", "stunned", "unconscious", "poisoned",
  "exhaustion", "charmed", "deafened", "frightened", "grappled", "incapacitated", "invisible", "paralyzed", "petrified", "dead"]
  .map(id => [id, id])));
const ACTIVATION_COST = Object.freeze({action: "action", bonus: "bonus-action", reaction: "reaction", legendary: "legendary-action",
  lair: "lair-action"});
const RECOVERY = Object.freeze({lr: "longRest", sr: "shortRest", day: "longRest", dawn: "longRest", dusk: "longRest", turn: "turn", turnStart: "turn",
  round: "turn"});
const ACTIVITIES = new Set(["attack", "save", "check", "damage", "heal", "utility"]);
const SPELL_DC = {type: "add", terms: [{type: "constant", value: 8}, {type: "proficiency-bonus"}, {type: "spellcasting-modifier"}]};
const SLOT_MODES = new Set(["prepared", "always", "spell", "pact", "ritual"]);

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
export function formulaExpression(formula, {spell=false, ability=null, scales={}, castLevel=null, challenge=null, spellDC=null}={}) {
  let text = String(formula ?? "").trim();
  if ( !text ) return null;
  const variables = {};
  const variable = expression => {
    const name = `scale${Object.keys(variables).length}x`;
    variables[name] = expression;
    return ` ${name} `;
  };
  text = text
    .replace(/(\d*)@scale\.([a-z0-9-]+)\.([a-z0-9-]+)(?:\.(value|die|faces|number|formula))?/gi, (match, count, owner, id, part) => {
      const rows = scales[`${owner}.${id}`];
      if ( !rows ) return match;
      const row = value => {
        if ( typeof value !== "object" ) return value;
        if ( part === "number" ) return value.number ?? 1;
        if ( part === "faces" ) return value.faces;
        return dice(Number(count) || (part === "die" ? 1 : (value.number ?? 1)), value.faces);
      };
      return variable({type: "table", key: {type: "class-level", class: owner}, rows: Object.fromEntries(Object.entries(rows)
        .map(([level, value]) => [level, row(value)]))});
    })
    // A creature's spell save DC is its number; a character's is 8 + proficiency + spellcasting modifier.
    .replace(/@attributes\.spell\.dc/g, spellDC == null ? "(8 + prof + spellmod)" : String(spellDC))
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
const pick = (activity, system, key) => ((activity?.[key]?.override || !says(system?.[key])) ? activity?.[key] : system[key]) ?? {};

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
  images=["icons/"], spells={}, creatures={}}={}) {
  if ( !licensed(document) ) return {ok: false, reason: "not SRD 5.2 (CC-BY-4.0)"};
  document = upgradeLegacy(document);
  const system = document.system ?? {};
  const activities = Object.values(system.activities ?? {}).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const spell = document.type === "spell";
  const level = number(system.level) ?? 0;
  const pool = usesPool({document, scales});
  const description = houseText(document, describe(document, {names, creature}));
  const source = {system: "dnd5e", pack, id: document._id, type: document.type, book,
    license: document.system?.source?.license || null, rules: document.system?.source?.rules || "2024",
    // A feat's category (origin, general, fightingStyle, epicBoon), which the level-up dialog offers (G8).
    ...((system.type?.value === "feat") ? {feat: system.type.subtype || "general"} : {})};
  const img = kept(document.img, images) ?? "icons/svg/item-bag.svg";
  const items = [];
  const allNotes = [];
  const trait = traitOf(document, {activities, system, spell, level, scales, pool, saveDC, creature});
  if ( trait ) allNotes.push(...trait.notes);
  // A spell without activities is still cast: it spends its slot like any other.
  const usable = activities.length ? activities : (spell ? [{type: "manual", activation: {override: false}}] : []);
  for ( const [index, activity] of usable.entries() ) {
    const notes = [...(pool?.notes ?? [])];
    const label = activity.name || activity.type;
    // An activity a common trait automates (Regeneration's healing) is the trait's, not an Action.
    if ( trait?.consumes?.includes(activity) ) continue;
    // A passive or triggered ability is not something a creature uses on its turn; its feature carries its text.
    const activation = pick(activity, system, "activation").type ?? "";
    if ( ["", "none", "special"].includes(activation) ) {
      if ( !trait ) allNotes.push(`"${label}" is passive or triggered: not automated`);
      continue;
    }
    // Monster spellcasting (G4): a cast activity is its spell, at the activity's cost and uses rather than a slot.
    if ( activity.type === "cast" ) {
      const cast = castSpell({document, activity, system, notes, pool, options: {scales, pack, saveDC, names, creature, book, images, spells,
        creatures}});
      if ( cast ) {
        items.push(cast);
        allNotes.push(...notes);
        continue;
      }
    }
    let definition = ACTIVITIES.has(activity.type)
      ? convertActivity({document, activity, system, spell, level, scales, notes, pool, saveDC, spellDC, creature})
      : ((activity.type === "summon") ? summonDefinition({document, activity, system, spell, level, notes, pool, creatures, names}) : null);
    if ( !definition ) {
      // Used but not automated: using it spends its cost (and a spell's slot); its description says the rest.
      notes.unshift(`not automated${activity.type === "manual" ? "" : ` (${activity.type})`}: using it spends its cost; its description says the rest`);
      definition = manualDefinition({document, activity, system, spell, level, notes, pool});
    }
    // A spell that fills its area with light (2024 Daylight's sunlight) is a lasting area shedding it.
    const shedding = spell ? sheddingArea({document, activity, system, definition}) : null;
    if ( shedding ) {
      definition = {...definition, ...shedding.definition};
      notes.splice(0, notes.length, ...notes.filter(note => !note.startsWith("not automated") && !note.startsWith("concentration: nothing")),
        ...shedding.notes);
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
    items.push(action(id, `${document.name}${suffix}`, definition));
    // 2024 Versatile: the weapon with both hands is its own Action, rolling its larger die.
    const twoHanded = versatileDefinition({document, system, definition});
    if ( twoHanded ) items.push(action(stableId(`${id}:two-handed`), `${document.name}${suffix} (Two-Handed)`, twoHanded));
    allNotes.push(...notes);
  }
  // What it gives while it is had (worn, for gear): its passive effects' rules.
  const passive = (document.effects ?? []).filter(effect => effect.transfer && !effect.disabled).flatMap(effect => effectRules(effect, allNotes));
  // Equipment is gear its owner equips (G7): armor's AC, and its passive effects. A potion or scroll is only its Actions.
  if ( GEAR_TYPES.has(document.type) && !((document.type === "consumable") && items.length) ) {
    const gearId = items.some(item => item._id === document._id) ? stableId(`${document._id}:gear`) : document._id;
    items.unshift({_id: gearId, _key: `!items!${gearId}`, name: document.name, type: "gear", img,
      system: {active: false, description, quantity: Math.max(0, Math.round(number(system.quantity) ?? 1)),
        weight: number(system.weight?.value ?? system.weight) ?? 0, slot: "", ruleElements: [...armorRules(document, allNotes), ...passive],
        attunement: (system.attunement === "required") ? "required" : "", armor: (document.type === "equipment" ? armorKind(system) : null) ?? ""},
      // Its Actions come with it when it is added to a creature (WildPathItem).
      flags: {wildpath: {source, conversion: {notes: [...new Set(allNotes)]}, ...(items.length ? {grants: items.map(item => item._id)} : {})}}});
  }
  // Nothing to use: a passive ability is a feature carrying its text (and any uses its other Actions spend).
  if ( !items.length ) {
    items.push({_id: document._id, _key: `!items!${document._id}`, name: document.name, type: "feature", img,
      system: {active: true, description, ruleElements: [pool?.rule, ...(trait?.rules ?? []), ...passive].filter(Boolean)},
      flags: {wildpath: {source, conversion: {notes: [...new Set(allNotes)]}}}});
  }
  return {ok: true, items, notes: [...new Set(allNotes)]};
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
    case "weapon": return `${mastery ? "masteries" : "weapons"}:${rest.map(part => WEAPON_TRAINING[part] ?? part).join(":")}`;
    case "tool": return `tools:${rest.at(-1)}`;
    case "languages": return null;
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
    if ( !found.length ) notes.push(`grant: ${String(entry.uuid).split(".").pop()} was not converted`);
    return found;
  });
  const advancement = Object.values(system.advancement ?? {}).flatMap(entry => {
    const config = entry.configuration ?? {};
    const base = {level: Number(entry.level) || 0, title: entry.title || null,
      ...(entry.classRestriction ? {classRestriction: entry.classRestriction} : {})};
    switch ( entry.type ) {
      case "HitPoints": case "ScaleValue": return [];
      case "ItemGrant": return [{...base, type: "grant", items: uuids(config.items ?? []), optional: config.optional === true}];
      case "ItemChoice": return Object.entries(config.choices ?? {}).filter(([, choice]) => Number(choice?.count) > 0)
        .map(([level, choice]) => ({...base, level: Number(level) || 0, type: "choice", count: Number(choice.count),
          replacement: choice.replacement === true, items: uuids(config.pool ?? [])}));
      case "Trait": {
        const mastery = config.mode === "mastery";
        const keys = list => list.map(key => traitKey(key, {mastery})).filter(Boolean);
        if ( [...(config.grants ?? []), ...(config.choices ?? []).flatMap(choice => choice.pool ?? [])].some(key => String(key).startsWith("languages")) ) {
          notes.push("languages are not tracked");
        }
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
  if ( type === "class" ) {
    const progression = system.spellcasting?.progression ?? "none";
    // shortcut: the Artificer rounds up like a half caster; third casters and pact magic are not converted.
    const mapped = {full: "full", half: "half", artificer: "half"}[progression] ?? "none";
    if ( !["none", "full", "half"].includes(progression) ) notes.push(`spellcasting: ${progression} is treated as ${mapped}`);
    Object.assign(fields, {levels: 1, hitDie: Number(String(system.hd?.denomination ?? "d8").slice(1)) || 8, original: false,
      primaryAbility: {abilities: (system.primaryAbility?.value ?? []).map(key => ABILITY_MAP[key] ?? key), all: system.primaryAbility?.all !== false},
      spellcasting: {progression: mapped, ability: ABILITY_MAP[system.spellcasting?.ability] ?? "", prepared: preparedTable(system)}});
  }
  if ( type === "subclass" ) fields.classIdentifier = system.classIdentifier ?? "";
  if ( type === "species" ) {
    const sizes = advancement.find(entry => entry.type === "size")?.sizes ?? [];
    fields.size = sizes.includes("medium") ? "medium" : (sizes[0] ?? "medium");
  }
  const source = {system: "dnd5e", pack, id: document._id, type: document.type, book,
    license: system.source?.license || null, rules: system.source?.rules || "2024"};
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
  const base = baseDefinition({document, activity, system, spell: false, notes, pool: itemPool});
  const definition = {...action.system.definition, id: `${base.id}-${slugify(spellDocument.name)}`,
    label: options.creature ? spellDocument.name : `${document.name}: ${spellDocument.name}`,
    tags: [...new Set([...(action.system.definition.tags ?? []), "spell"])], costs: base.costs};
  delete definition.configuration;
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
    system: {active: true, description: action.system.description, definition, ruleElements: [itemPool?.rule, pool?.rule].filter(Boolean)},
    flags: {wildpath: {source: {...action.flags.wildpath.source, castBy: document.name}, conversion: {notes: [...notes]}}}};
}

/**
 * A summon activity (G4) as an Action whose creatures appear where its caster chooses, for the spell's duration (in
 * rounds) or while it concentrates: its creature, or a choice of its creatures, from `creatures` (dnd5e Actor id to
 * WildPath uuid). Null when it chooses by Challenge Rating, or names a creature not converted.
 */
function summonDefinition({document, activity, system, spell, level, notes, pool, creatures, names}) {
  if ( activity.summon?.mode === "cr" ) {
    notes.push("summon: a creature chosen by Challenge Rating is not converted");
    return null;
  }
  const profiles = (activity.profiles ?? []).map(profile => ({profile, ref: creatures[String(profile.uuid ?? "").split(".").pop()] ?? null}));
  if ( !profiles.length || profiles.some(entry => !entry.ref) ) {
    notes.push("summon: its creature is not among the converted creatures");
    return null;
  }
  const counts = profiles.map(({profile}) => (String(profile.count ?? "").trim() === "" ? 1 : Number(profile.count)));
  if ( counts.some(count => !Number.isInteger(count) || (count < 1)) || (new Set(counts).size > 1) ) {
    notes.push(`summon: a count of "${profiles.map(({profile}) => profile.count).join(", ")}" is not converted`);
    return null;
  }
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
    const expression = ["hp", "ac", "attackDamage", "saveDamage"].includes(name) ? summonBonus(formula) : null;
    if ( expression ) bonuses[name] = expression;
    else lost.push(name);
  }
  if ( lost.length ) notes.push(`summon: what it gains with the spell's level (${lost.join(", ")}) is not added`);
  const timing = {count: counts[0], ...(rounds ? {rounds} : {}), ...(concentration ? {concentration: true} : {}),
    ...(Object.keys(bonuses).length ? {bonuses} : {}), ...((spell && level) ? {spellLevel: level} : {})};
  if ( profiles.length === 1 ) return {...definition, ...(range ? {range} : {}), summon: {actorRef: profiles[0].ref, ...timing}};
  const choice = {id: "summon-creature", type: "select-one", label: "Creature", required: true,
    options: profiles.map(({profile, ref}) => ({id: ref, label: profile.name || names[String(profile.uuid).split(".").pop()] || ref}))};
  return {...definition, ...(range ? {range} : {}), configuration: [...(definition.configuration ?? []), choice],
    summon: {choiceId: choice.id, ...timing}};
}

/** A summon bonus as a ValueExpression of the spell's cast level (`castLevel`): "10 * (@item.level - 4)", "(@item.level - 3)d10". */
function summonBonus(formula) {
  const text = String(formula).replace(/@item\.level/g, "castlevelx").trim();
  const variables = {castlevelx: {type: "context", path: "castLevel"}};
  const dice = /^\((.+)\)\s*d\s*(\d+)$/.exec(text);
  const parsed = parseFormula(dice ? dice[1] : text, {variables});
  if ( !parsed.ok ) return null;
  return dice ? {type: "dice", number: parsed.expression, faces: Number(dice[2])} : parsed.expression;
}

/** The Action of something used but not automated: its cost, its uses and, for a spell, its slot. */
function manualDefinition({document, activity, system, spell, level, notes, pool}) {
  const definition = baseDefinition({document, activity, system, spell, notes, pool});
  if ( spell && level && SLOT_MODES.has(system.preparation?.mode ?? "prepared") ) definition.configuration = slotConfiguration(level, []);
  return definition;
}

/** An item's limited uses as a resource pool its Actions spend, with the dnd5e recovery. */
function usesPool({document, scales}) {
  return poolOf(document.system?.uses, {id: slugify(document.name), label: document.name, scales});
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

/** An Action's identity and costs: its activation in the action economy and the uses it spends. */
function baseDefinition({document, activity, system, spell, notes, pool}) {
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
  for ( const target of activity.consumption?.targets ?? [] ) {
    const amount = target.value === "" || target.value == null ? 1 : number(target.value);
    // A negative consumption gives a use back; that is not a cost.
    if ( (target.type === "itemUses") && pool && (amount > 0) ) definition.costs.allOf.push({capability: pool.id, amount});
    else if ( (target.type === "activityUses") && activityPool({document, activity}) && (amount > 0) ) {
      definition.costs.allOf.push({capability: activityPool({document, activity}).id, amount});
    }
    else notes.push(`consumption: ${target.type} ${target.value ?? ""} not converted`.trim());
  }
  return definition;
}

/**
 * A spell of `level` spends a slot of that level or higher. Per level above, damage and healing with scaling dice grow,
 * and `perLevel` more creatures can be targeted.
 */
function slotConfiguration(level, damage, {healing=[], perLevel=0}={}) {
  const levels = Array.from({length: 10 - level}, (_, offset) => level + offset);
  const scale = (type, components) => components.filter(component => component.scaleDice).map(component => ({type, levelChoiceId: "spell-slot",
    baseLevel: level, componentIds: [component.id], dice: component.scaleDice}));
  const scaling = [...scale("scaleDamage", damage), ...scale("scaleHealing", healing),
    ...(perLevel ? [{type: "scaleTargets", levelChoiceId: "spell-slot", baseLevel: level, perLevel}] : [])];
  return [{id: "spell-slot", type: "resource", label: "Spell slot", required: true,
    cost: {anyOf: levels.map(each => [{capability: `spell-slot.${each}`, amount: 1}])},
    levelByResourceId: Object.fromEntries(levels.map(each => [`spell-slot.${each}`, each])), effects: scaling}];
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

function convertActivity({document, activity, system, spell, level, scales, notes, pool, saveDC, spellDC=null, creature=null}) {
  const definition = baseDefinition({document, activity, system, spell, notes, pool});

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
  for ( const [index, part] of (activity.damage?.parts ?? []).entries() ) {
    const expression = partExpression(part, {spell, ability: null, scales, notes, label: `damage ${index + 1}`});
    if ( !expression ) continue;
    if ( (part.types ?? []).length > 1 ) notes.push(`damage ${index + 1}: a choice of ${part.types.join("/")} uses ${part.types[0]}`);
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
    if ( (activity.healing.types ?? []).includes("temphp") ) notes.push("healing: temporary Hit Points not converted");
    else if ( expression ) healing.push({id: "healing-1", expression, healingType: "healing", ...(scale ? {scaleDice: scale} : {})});
  }

  const effects = [];
  const concentration = (system.properties ?? []).includes("concentration");
  for ( const reference of activity.effects ?? [] ) {
    const effect = (document.effects ?? []).find(entry => entry._id === reference._id);
    const statuses = effect?.statuses ?? [];
    const known = statuses.filter(status => CONDITION_MAP[status]);
    const onFailure = definition.save && (reference.onSave === false) ? {saveOutcomePolicy: "failure"} : {};
    for ( const status of statuses.filter(status => !CONDITION_MAP[status]) ) notes.push(`effect: ${status} is not a WildPath condition yet`);
    for ( const status of known ) {
      effects.push({id: `effect-${effects.length + 1}`, type: "condition", conditionId: CONDITION_MAP[status], ...onFailure,
        ...(concentration ? {concentration: true} : {})});
    }
    // Its own changes (Bless, Shield of Faith, Haste) become a custom effect with the rules they map to.
    const rules = effect ? effectRules(effect, notes) : [];
    if ( rules.length ) {
      const duration = effectDuration(effect.duration);
      effects.push({id: `effect-${effects.length + 1}`, type: "effect", name: effect.name, ...(effect.img ? {img: effect.img} : {}),
        ruleElements: rules, ...(duration ? {duration} : {}), ...onFailure, ...(concentration ? {concentration: true} : {})});
    } else if ( effect && !statuses.length ) notes.push(`effect: "${effect.name}" (its own changes) not converted`);
  }

  if ( damage.length ) definition.damage = damage.map(({scaleDice: _scale, ...component}) => component);
  if ( healing.length ) definition.healing = healing.map(({scaleDice: _scale, ...component}) => component);
  if ( effects.length ) definition.effects = effects;

  // A spell of level 1 or higher spends a slot of its level or higher; damage dice that scale grow per level above.
  if ( spell && level && SLOT_MODES.has(system.preparation?.mode ?? "prepared") ) {
    definition.configuration = slotConfiguration(level, damage, {healing, perLevel});
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
export function scaleTables(classDocuments=[]) {
  const tables = {};
  for ( const document of classDocuments ) {
    const owner = document.system?.identifier ?? slugify(document.name);
    // Stored sources keep advancements by id; prepared documents as a list.
    for ( const advancement of Object.values(document.system?.advancement ?? {}) ) {
      const kind = advancement.configuration?.type;
      if ( (advancement.type !== "ScaleValue") || !["number", "dice"].includes(kind) ) continue;
      const id = advancement.configuration.identifier || slugify(advancement.title);
      // A number scale is its numbers; a dice scale is {number, faces} (Sneak Attack 1d6 ... 10d6; Martial Arts d6 ... d12).
      tables[`${owner}.${id}`] = Object.fromEntries(Object.entries(advancement.configuration.scale ?? {})
        .map(([level, entry]) => [level, kind === "dice" ? {number: number(entry.number) ?? 1, faces: number(entry.faces)} : Number(entry.value)])
        .filter(([, value]) => (typeof value === "object") ? Number.isFinite(value.faces) : Number.isFinite(value)));
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
  creatures={}}={}) {
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
  const creature = {name: document.name, modifier, proficiency, saveDC, challenge,
    spellDC: ABILITY_MAP[casting] ? 8 + proficiency + modifier(casting) : null, castingAbility: ABILITY_MAP[casting] ?? null,
    legendaryResistances: number(system.resources?.legres?.max) ?? 0,
    itemNames: Object.fromEntries((document.items ?? []).map(item => [item._id, item.name]))};

  const items = [];
  for ( const item of document.items ?? [] ) {
    // dnd5e's cached copy of a spell a cast activity casts: the cast activity converts it.
    if ( (item.type === "equipment") || item.flags?.dnd5e?.cachedFor ) continue;
    const result = convertItem(item, {scales, pack, saveDC, names, creature, licensed, book, images, spells, creatures});
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
  if ( traits.length ) items.push({_id: `${String(actorId).slice(0, 12)}trts`, _key: `!actors.items!${actorId}.${String(actorId).slice(0, 12)}trts`,
    name: "Traits", type: "feature", img: "icons/svg/aura.svg", system: {active: true, description: "", ruleElements: traits},
    flags: {wildpath: {conversion: {notes: []}}}});

  const walk = number(system.attributes?.movement?.walk) ?? 30;
  const health = number(system.attributes?.hp?.max) ?? number(system.attributes?.hp?.value) ?? 1;
  const size = SIZES[system.traits?.size] ?? 1;
  return {ok: true, notes, actor: {
    _id: actorId, _key: `!actors!${actorId}`, name: document.name, type: "npc",
    img: kept(document.img, images) ?? "icons/svg/mystery-man.svg",
    system: {
      abilities: Object.fromEntries(Object.entries(ABILITY_MAP).map(([key, ability]) => [ability, {value: score(key),
        ...((number(system.abilities?.[key]?.proficient) ?? 0) >= 1 ? {saveProficient: true} : {})}])),
      defenses: {ac: {value: armorClass(document, modifier("dex"), notes)}},
      resources: {health: {base: health, value: health}, movement: {base: walk, value: walk}},
      details: {threat: Math.floor(challenge)},
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
export function changeValue(value) {
  const text = String(value ?? "").trim().replace(/^\+\s*/, "");
  if ( !text.startsWith("-") ) return formulaExpression(text);
  const rest = formulaExpression(text.slice(1).trim());
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
export function effectRules(effect, notes=[]) {
  const changes = effect?.system?.changes ?? effect?.changes ?? [];
  const rules = [];
  const base = slugify(effect?.name) || "effect";
  const rule = (type, data, predicate=null) => rules.push({schemaVersion: 1, id: `${base}-${rules.length + 1}`, type,
    ...(predicate ? {predicate} : {}), data});
  const modifier = (domains, value, predicate=null) => rule("Modifier", {domains, modifierType: "untyped",
    ...(value.type === "constant" ? {value: value.value} : {valueExpression: value})}, predicate);
  const adjustments = {dr: [], di: [], dv: [], ci: []};
  // Bonuses on all four kinds of attack with one value are one Modifier on every attack.
  const attackChanges = changes.filter(change => /^system\.bonuses\.(mwak|rwak|msak|rsak)\.attack$/.test(change.key));
  const everyAttack = (attackChanges.length === 4) && (new Set(attackChanges.map(change => String(change.value))).size === 1);
  let everyAttackDone = false;
  for ( const change of changes ) {
    const key = String(change.key ?? "");
    const type = change.type ?? CHANGE_MODES[change.mode] ?? "add";
    const value = changeValue(change.value);
    const number = Number(change.value);
    const unmapped = () => notes.push(`effect: "${effect.name}" change ${key} (${type}) not converted`);
    let match;
    if ( (match = /^system\.bonuses\.(mwak|rwak|msak|rsak)\.attack$/.exec(key)) && (type === "add") && value ) {
      if ( everyAttack ) {
        if ( !everyAttackDone ) modifier(["attack"], value);
        everyAttackDone = true;
      } else modifier([`attack.${ATTACK_KEYS[match[1]][0]}`], value, {tagsAny: [ATTACK_KEYS[match[1]][1]]});
    } else if ( (match = /^system\.bonuses\.(mwak|rwak|msak|rsak)\.damage$/.exec(key)) && (type === "add") && (value?.type === "constant") ) {
      modifier([`damage.${ATTACK_KEYS[match[1]][0]}`], value, {tagsAny: [ATTACK_KEYS[match[1]][1]]});
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
    } else if ( ["system.attributes.movement.walk", "system.attributes.movement.multiplier"].includes(key) && (type === "multiply")
      && Number.isFinite(number) ) {
      // Haste doubles it, Slow and Spirit Guardians halve it: the walking Speed's own maximum times (factor - 1), added.
      // shortcut: dnd5e's multiplier scales every Speed; a fly or swim Speed keeps its own here.
      modifier(["resources.movement.max"], {type: "floor", value: {type: "multiply", terms: [{type: "constant", value: number - 1},
        {type: "add", terms: [{type: "context", path: "actorSystem.resources.movement.base"},
          {type: "context", path: "actorSystem.resources.movement.bonus"}]}]}});
    } else if ( (match = /^system\.attributes\.movement\.(fly|swim|climb|burrow)$/.exec(key)) && ["upgrade", "override", "add"].includes(type) ) {
      const distance = /^@attributes\.movement\.walk$/.test(String(change.value).trim())
        ? {type: "context", path: "actorSystem.resources.movement.max"} : (Number.isFinite(number) && (number > 0) ? number : null);
      if ( distance ) rule("GrantMovement", {mode: match[1], distance});
      else unmapped();
    } else unmapped();
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
    for ( const key of ["items", "pages", "results", "effects"] ) if ( value[key] ) visit(value[key]);
  };
  visit(documents);
  return names;
}
