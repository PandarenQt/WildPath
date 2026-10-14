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
const ACTIVATION_COST = Object.freeze({action: "action", bonus: "bonus-action", reaction: "reaction", legendary: "legendary-action"});
const RECOVERY = Object.freeze({lr: "longRest", sr: "shortRest", turn: "turn", turnStart: "turn", round: "turn"});
const ACTIVITIES = new Set(["attack", "save", "damage", "heal", "utility"]);
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
    const shape = {sphere: "radial", cylinder: "radial", radius: rangeUnits === "self" ? "emanation" : "radial", cone: "cone", line: "line"}[template.type];
    if ( shape && size ) {
      if ( template.type === "cylinder" ) notes.push("area: a cylinder's height is not modeled");
      return {targeting: {type: "area"}, area: {shape, size: {value: size, unit: "ft"},
        ...(shape === "line" ? {width: {value: number(template.width) ?? 5, unit: "ft"}} : {})}};
    }
    notes.push(`area: ${template.size}-ft ${template.type} is not supported; the user picks the targets`);
    return {targeting: {type: "multiple", required: true, count: 20}};
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
  if ( count && (typeof count === "object") ) return {targeting: {type: "multiple", required: true, count}};
  if ( (count > 1) || perLevel ) return {targeting: {type: (count > 1) ? "multiple" : "single", required: true, count: Math.max(count, 1)}, perLevel};
  return {targeting: {type: "single", required: true, count: 1}};
}

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
export function convertItem(document, {scales={}, pack=null, saveDC=null, names={}, creature=null, licensed=isSrd2024, book="SRD 5.2",
  images=["icons/"]}={}) {
  if ( !licensed(document) ) return {ok: false, reason: "not SRD 5.2 (CC-BY-4.0)"};
  document = upgradeLegacy(document);
  const system = document.system ?? {};
  const activities = Object.values(system.activities ?? {}).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const spell = document.type === "spell";
  const level = number(system.level) ?? 0;
  const pool = usesPool({document, scales});
  const description = describe(document, {names, creature});
  const source = {system: "dnd5e", pack, id: document._id, type: document.type, book,
    license: document.system?.source?.license || null, rules: document.system?.source?.rules || "2024"};
  const img = kept(document.img, images) ?? "icons/svg/item-bag.svg";
  const items = [];
  const allNotes = [];
  // A spell without activities is still cast: it spends its slot like any other.
  const usable = activities.length ? activities : (spell ? [{type: "manual", activation: {override: false}}] : []);
  for ( const [index, activity] of usable.entries() ) {
    const notes = [...(pool?.notes ?? [])];
    const label = activity.name || activity.type;
    // A passive or triggered ability is not something a creature uses on its turn; its feature carries its text.
    const activation = pick(activity, system, "activation").type ?? "";
    if ( ["", "none", "special"].includes(activation) ) {
      allNotes.push(`"${label}" is passive or triggered: not automated`);
      continue;
    }
    let definition = ACTIVITIES.has(activity.type)
      ? convertActivity({document, activity, system, spell, level, scales, notes, pool, saveDC, creature}) : null;
    if ( !definition ) {
      // Used but not automated: using it spends its cost (and a spell's slot); its description says the rest.
      notes.unshift(`not automated${activity.type === "manual" ? "" : ` (${activity.type})`}: using it spends its cost; its description says the rest`);
      definition = manualDefinition({document, activity, system, spell, level, notes, pool});
    }
    const suffix = usable.length > 1 ? ` (${label})` : "";
    const id = index ? stableId(`${document._id}:${index}`) : document._id;
    items.push({
      _id: id, _key: `!items!${id}`, name: `${document.name}${suffix}`, type: "action", img,
      system: {active: true, description, definition: {...definition, label: `${document.name}${suffix}`},
        ruleElements: pool ? [pool.rule] : []},
      flags: {wildpath: {source, conversion: {notes}}}
    });
    allNotes.push(...notes);
  }
  // Nothing to use: a passive ability is a feature carrying its text (and any uses its other Actions spend).
  if ( !items.length ) {
    items.push({_id: document._id, _key: `!items!${document._id}`, name: document.name, type: "feature", img,
      system: {active: true, description, ruleElements: pool ? [pool.rule] : []},
      flags: {wildpath: {source, conversion: {notes: [...new Set(allNotes)]}}}});
  }
  return {ok: true, items, notes: [...new Set(allNotes)]};
}

/** The Action of something used but not automated: its cost, its uses and, for a spell, its slot. */
function manualDefinition({document, activity, system, spell, level, notes, pool}) {
  const definition = baseDefinition({document, activity, system, spell, notes, pool});
  if ( spell && level && SLOT_MODES.has(system.preparation?.mode ?? "prepared") ) definition.configuration = slotConfiguration(level, []);
  return definition;
}

/** An item's limited uses as a resource pool its Actions spend, with the dnd5e recovery. */
function usesPool({document, scales}) {
  const uses = document.system?.uses;
  if ( !uses?.max ) return null;
  const notes = [];
  const maximum = formulaExpression(uses.max, {scales});
  if ( !maximum ) notes.push(`uses: maximum "${uses.max}" not converted`);
  // Older dnd5e data (before 4.0) stores the recovery period as a plain string.
  const recoveries = Array.isArray(uses.recovery) ? uses.recovery : (uses.recovery ? [{period: uses.recovery}] : []);
  const periods = recoveries.map(entry => entry.period);
  // 2024 often recovers one use on a short rest and all on a long one; WildPath pools refill whole.
  const recovery = RECOVERY[periods.includes("sr") ? "sr" : periods[0]] ?? "none";
  if ( recoveries.some(entry => entry.type === "formula") ) notes.push("uses: a partial recovery refills the whole pool");
  const recharge = recoveries.find(entry => entry.period === "recharge");
  if ( recharge ) notes.push(`uses: Recharge ${recharge.formula}${recharge.formula === "6" ? "" : "–6"} is not rolled; refill the pool by hand`);
  const id = slugify(document.name);
  return {id, notes, rule: {schemaVersion: 1, id: `${id}-uses`, type: "GrantResource",
    data: {resourceId: id, label: document.name, maximum: maximum ?? 1, recovery}}};
}

/** An Action's identity and costs: its activation in the action economy and the uses it spends. */
function baseDefinition({document, activity, system, spell, notes, pool}) {
  const activation = pick(activity, system, "activation");
  const definition = {schemaVersion: 1, id: `action:srd-${slugify(document.name)}${activity.name ? `-${slugify(activity.name)}` : ""}`,
    ...(spell ? {tags: ["spell"]} : {})};
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

function convertActivity({document, activity, system, spell, level, scales, notes, pool, saveDC, creature=null}) {
  const definition = baseDefinition({document, activity, system, spell, notes, pool});

  const attackData = activity.type === "attack" ? activity.attack ?? {} : null;
  const attack = attackData ? {type: attackData.type?.value || (document.system?.range?.long ? "ranged" : "melee"),
    statistic: (spell || attackData.type?.classification === "spell") ? "spell" : "weapon", defenseKey: "ac",
    // Spells and stat-block attacks are proficient; a character not proficient with a weapon unticks it.
    proficient: true} : null;
  if ( attack ) {
    if ( (system.properties ?? []).includes("fin") ) attack.properties = ["finesse"];
    if ( attackData.ability && ABILITY_MAP[attackData.ability] ) attack.ability = ABILITY_MAP[attackData.ability];
    if ( attackData.bonus ) notes.push(`attack: bonus "${attackData.bonus}" not converted`);
    if ( number(system.magicalBonus) ) notes.push(`attack: +${system.magicalBonus} magic bonus not converted`);
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
    const written = dc.formula ? formulaExpression(dc.formula, {spell, scales, spellDC: creature?.spellDC, challenge: creature?.challenge}) : null;
    const value = dc.calculation === "spellcasting" ? (creature?.spellDC ? {value: creature.spellDC} : {valueExpression: SPELL_DC})
      : (fromAbility ?? (written ? (written.type === "constant" ? {value: written.value} : {valueExpression: written}) : null));
    if ( !ability || !value ) {
      notes.push(`save: ${abilities.join("/") || "?"} DC (${dc.calculation || dc.formula || "?"}) not converted`);
      return null;
    }
    definition.save = {ability, dc: value};
  }

  // Damage: a weapon's own damage first (the ability modifier joins it), then the activity's parts.
  const damage = [];
  const label = document.name;
  const base = system.damage?.base;
  const baseExpression = base ? partExpression(base, {spell, ability: null, scales, notes, label: "base damage"}) : null;
  if ( activity.damage?.includeBase && (document.type === "weapon") && baseExpression ) {
    damage.push({id: "base", expression: baseExpression, damageType: base.types?.[0] ?? "untyped", provenance: "weapon-base"});
    if ( (system.properties ?? []).includes("ver") ) notes.push("damage: versatile two-handed damage not converted");
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
    for ( const status of statuses.filter(status => !CONDITION_MAP[status]) ) notes.push(`effect: ${status} is not a WildPath condition yet`);
    if ( !statuses.length && effect ) notes.push(`effect: "${effect.name}" (its own changes) not converted`);
    for ( const status of known ) {
      effects.push({id: `effect-${effects.length + 1}`, type: "condition", conditionId: CONDITION_MAP[status],
        ...(definition.save && (reference.onSave === false) ? {saveOutcomePolicy: "failure"} : {}),
        ...(concentration ? {concentration: true} : {})});
    }
  }

  if ( damage.length ) definition.damage = damage.map(({scaleDice: _scale, ...component}) => component);
  if ( healing.length ) definition.healing = healing.map(({scaleDice: _scale, ...component}) => component);
  if ( effects.length ) definition.effects = effects;

  // A spell of level 1 or higher spends a slot of its level or higher; damage dice that scale grow per level above.
  if ( spell && level && SLOT_MODES.has(system.preparation?.mode ?? "prepared") ) {
    definition.configuration = slotConfiguration(level, damage, {healing, perLevel});
  }
  if ( concentration && !effects.length ) notes.push("concentration: nothing it sustains was converted");
  // An attack or save with nothing converted on it would roll for nothing: such an Action is left out and noted.
  return (damage.length || healing.length || effects.length) ? definition : null;
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
export function convertActor(document, {scales={}, pack=null, names={}, licensed=isSrd2024, book="SRD 5.2", images=["icons/"]}={}) {
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
    spellDC: ABILITY_MAP[casting] ? 8 + proficiency + modifier(casting) : null,
    itemNames: Object.fromEntries((document.items ?? []).map(item => [item._id, item.name]))};

  const items = [];
  for ( const item of document.items ?? [] ) {
    if ( item.type === "equipment" ) continue;
    const result = convertItem(item, {scales, pack, saveDC, names, creature, licensed, book, images});
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
    if ( distance ) rules.push({schemaVersion: 1, id: `speed-${mode}`, type: "GrantMovement", data: {mode, distance}});
  }
  const legendary = number(system.resources?.legact?.max);
  if ( legendary ) rules.push({schemaVersion: 1, id: "legendary-actions", type: "GrantResource",
    data: {resourceId: "legendary-action", label: "Legendary Actions", maximum: legendary, recovery: "turn"}});
  return rules;
}

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
      case "/item": return label ?? creature?.itemNames?.[String(args[0] ?? "").replace(/^\./, "")] ?? names[String(args[0] ?? "").split(".").pop()] ?? "";
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
