/**
 * Convert dnd5e (6.x) documents from the 2024 SRD (SRD 5.2, CC-BY-4.0) into WildPath source documents.
 *
 * - Only a document whose own `system.source` says `license: "CC-BY-4.0"` and `rules: "2024"` is converted.
 * - Spells, weapons and features become Action Items, one per activity. An item's uses become a resource pool its
 *   Action spends (`GrantResource`).
 * - Mechanics only: names, numbers and rules, no descriptions (AGENTS §22).
 * - What WildPath cannot express yet is listed in `flags.wildpath.conversion.notes` and left out. It is never
 *   approximated.
 */

/** dnd5e ability keys to WildPath's. */
export const ABILITY_MAP = Object.freeze({str: "might", dex: "agility", con: "fortitude", int: "intellect", wis: "wits", cha: "presence"});
/** dnd5e statuses WildPath has conditions for. */
const CONDITION_MAP = Object.freeze({prone: "prone", blinded: "blinded", restrained: "restrained", stunned: "stunned",
  unconscious: "unconscious", poisoned: "poisoned", exhaustion: "exhaustion"});
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

export const slugify = text => String(text ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const number = value => (Number.isFinite(Number(value)) && (value !== "") && (value !== null) ? Number(value) : null);
const dice = (count, faces) => ({type: "dice", number: count, faces});
const add = terms => (terms.length === 1 ? terms[0] : {type: "add", terms});

/**
 * A dnd5e roll-data formula as a WildPath ValueExpression, or null when it uses something WildPath cannot read.
 * `@mod` is the spellcasting modifier for a spell and the ability modifier otherwise.
 */
export function formulaExpression(formula, {spell=false, ability=null, scales={}}={}) {
  const text = String(formula ?? "").trim();
  if ( !text ) return null;
  if ( /^-?\d+$/.test(text) ) return {type: "constant", value: Number(text)};
  if ( text === "@prof" ) return {type: "proficiency-bonus"};
  if ( text === "@mod" ) return spell || !ability ? {type: "spellcasting-modifier"} : {type: "ability-modifier", ability};
  const classLevels = /^@classes\.([a-z-]+)\.levels$/.exec(text);
  if ( classLevels ) return {type: "class-level", class: classLevels[1]};
  const scale = /^@scale\.([a-z-]+)\.([a-z0-9-]+)$/.exec(text);
  if ( scale && scales[`${scale[1]}.${scale[2]}`] ) {
    return {type: "table", key: {type: "class-level", class: scale[1]}, rows: {...scales[`${scale[1]}.${scale[2]}`]}};
  }
  return null;
}

/** A dnd5e damage or healing part as a ValueExpression; notes what it leaves out. */
function partExpression(part, {spell, ability, scales, notes, label}) {
  if ( part?.custom?.enabled ) {
    notes.push(`${label}: custom formula "${part.custom.formula}" not converted`);
    return null;
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

/** The activity's own value for `key` when it overrides the item's, else the item's. */
const pick = (activity, system, key) => ((activity?.[key]?.override || !system?.[key]) ? activity?.[key] : system[key]) ?? {};

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
function targetingOf({activity, system, notes}) {
  const target = pick(activity, system, "target");
  const template = {...(system.target?.template ?? {}), ...(activity?.target?.override ? target.template : {})};
  const affects = {...(system.target?.affects ?? {}), ...(activity?.target?.override ? target.affects : {})};
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
  const count = number(affects.count);
  if ( (affects.count && (count == null)) ) notes.push(`targets: count "${affects.count}" not converted`);
  if ( count && (count > 1) ) return {targeting: {type: "multiple", required: true, count}};
  return {targeting: {type: "single", required: true, count: 1}};
}

/**
 * Convert one dnd5e Item (spell, weapon, feat) to WildPath Action Items, one per activity.
 * `scales` maps `<class>.<scale>` to `{level: value}` rows (from the class's ScaleValue advancements).
 * @returns {{ok: true, items: object[], notes: string[]} | {ok: false, reason: string}}
 */
export function convertItem(document, {scales={}, pack=null, saveDC=null}={}) {
  if ( !isSrd2024(document) ) return {ok: false, reason: "not SRD 5.2 (CC-BY-4.0)"};
  const system = document.system ?? {};
  const activities = Object.values(system.activities ?? {}).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const spell = document.type === "spell";
  const level = number(system.level) ?? 0;
  const pool = usesPool({document, scales});
  const items = [];
  const allNotes = [];
  for ( const [index, activity] of activities.entries() ) {
    const notes = [...(pool?.notes ?? [])];
    if ( !ACTIVITIES.has(activity.type) ) {
      allNotes.push(`activity "${activity.name || activity.type}" (${activity.type}) not converted`);
      continue;
    }
    // A passive or triggered activity (no activation, or "special") is not something a creature uses on its turn.
    const activation = pick(activity, system, "activation").type ?? "";
    if ( ["", "none", "special"].includes(activation) ) {
      allNotes.push(`activity "${activity.name || activity.type}" is passive or triggered; not converted`);
      continue;
    }
    const definition = convertActivity({document, activity, system, spell, level, scales, notes, pool, saveDC});
    if ( !definition ) {
      allNotes.push(...notes, `activity "${activity.name || activity.type}" does nothing WildPath can run`);
      continue;
    }
    const suffix = activities.length > 1 ? ` (${activity.name || activity.type})` : "";
    const id = index ? `${String(document._id).slice(0, 13)}a${String(index).padStart(2, "0")}` : document._id;
    items.push({
      _id: id, _key: `!items!${id}`, name: `${document.name}${suffix}`, type: "action",
      img: String(document.img ?? "").startsWith("icons/") ? document.img : "icons/svg/item-bag.svg",
      system: {active: true, description: "", definition: {...definition, label: `${document.name}${suffix}`},
        ruleElements: pool ? [pool.rule] : []},
      flags: {wildpath: {source: {system: "dnd5e", pack, id: document._id, type: document.type, book: "SRD 5.2",
        license: "CC-BY-4.0", rules: "2024"}, conversion: {notes}}}
    });
    allNotes.push(...notes);
  }
  return {ok: true, items, notes: [...new Set(allNotes)]};
}

/** An item's limited uses as a resource pool its Actions spend, with the dnd5e recovery. */
function usesPool({document, scales}) {
  const uses = document.system?.uses;
  if ( !uses?.max ) return null;
  const notes = [];
  const maximum = formulaExpression(uses.max, {scales});
  if ( !maximum ) notes.push(`uses: maximum "${uses.max}" not converted`);
  const periods = (uses.recovery ?? []).map(entry => entry.period);
  // 2024 often recovers one use on a short rest and all on a long one; WildPath pools refill whole.
  const recovery = RECOVERY[periods.includes("sr") ? "sr" : periods[0]] ?? "none";
  if ( (uses.recovery ?? []).some(entry => entry.type === "formula") ) notes.push("uses: a partial recovery refills the whole pool");
  const id = slugify(document.name);
  return {id, notes, rule: {schemaVersion: 1, id: `${id}-uses`, type: "GrantResource",
    data: {resourceId: id, label: document.name, maximum: maximum ?? 1, recovery}}};
}

function convertActivity({document, activity, system, spell, level, scales, notes, pool, saveDC}) {
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
    if ( (target.type === "itemUses") && pool ) definition.costs.allOf.push({capability: pool.id, amount: number(target.value) || 1});
    else notes.push(`consumption: ${target.type} not converted`);
  }

  const attackData = activity.type === "attack" ? activity.attack ?? {} : null;
  const attack = attackData ? {type: attackData.type?.value || (document.system?.range?.long ? "ranged" : "melee"),
    statistic: (spell || attackData.type?.classification === "spell") ? "spell" : "weapon", defenseKey: "ac"} : null;
  if ( attack ) {
    if ( (system.properties ?? []).includes("fin") ) attack.properties = ["finesse"];
    if ( attackData.ability && ABILITY_MAP[attackData.ability] ) attack.ability = ABILITY_MAP[attackData.ability];
    if ( attackData.bonus ) notes.push(`attack: bonus "${attackData.bonus}" not converted`);
    if ( number(system.magicalBonus) ) notes.push(`attack: +${system.magicalBonus} magic bonus not converted`);
    definition.attack = attack;
  }
  const range = rangeOf({activity, system, document, attack});
  if ( range ) definition.range = range;
  Object.assign(definition, targetingOf({activity, system, notes}));

  if ( activity.type === "save" ) {
    const abilities = [].concat(activity.save?.ability ?? []);
    const ability = ABILITY_MAP[abilities[0]] ?? null;
    if ( abilities.length > 1 ) notes.push(`save: a choice of ${abilities.join("/")} uses ${abilities[0]}`);
    const dc = activity.save?.dc ?? {};
    const flat = number(dc.formula);
    const value = dc.calculation === "spellcasting" ? {valueExpression: SPELL_DC}
      : (flat != null ? {value: flat} : (saveDC?.(dc.calculation) ?? null));
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
  if ( activity.damage?.includeBase && (document.type === "weapon") && base?.number ) {
    damage.push({id: "base", expression: dice(number(base.number), number(base.denomination)), damageType: base.types?.[0] ?? "untyped",
      provenance: "weapon-base"});
    if ( (system.properties ?? []).includes("ver") ) notes.push("damage: versatile two-handed damage not converted");
  } else if ( activity.damage?.includeBase && base?.number ) {
    notes.push("damage: the item's base damage not converted");
  }
  for ( const [index, part] of (activity.damage?.parts ?? []).entries() ) {
    const expression = partExpression(part, {spell, ability: null, scales, notes, label: `damage ${index + 1}`});
    if ( !expression ) continue;
    if ( (part.types ?? []).length > 1 ) notes.push(`damage ${index + 1}: a choice of ${part.types.join("/")} uses ${part.types[0]}`);
    const scale = scaledDice(part, {spell, level, notes, label: `damage ${index + 1}`});
    damage.push({id: `damage-${index + 1}`, expression, damageType: part.types?.[0] ?? "untyped", provenance: spell ? "spell-base" : "additional",
      ...(scale ? {scaleDice: scale} : {})});
  }
  const onSave = activity.damage?.onSave;
  if ( definition.save && damage.length && (onSave === "half" || onSave === "none") ) {
    for ( const component of damage ) component.saveOutcomePolicy = {success: onSave, failure: "full"};
  }

  const healing = [];
  if ( activity.type === "heal" && activity.healing ) {
    const expression = partExpression(activity.healing, {spell, ability: null, scales, notes, label: "healing"});
    if ( (activity.healing.types ?? []).includes("temphp") ) notes.push("healing: temporary Hit Points not converted");
    else if ( expression ) healing.push({id: "healing-1", expression, healingType: "healing"});
    if ( spell && level && activity.healing.scaling?.number ) notes.push("healing: more healing at higher levels not converted");
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
  if ( healing.length ) definition.healing = healing;
  if ( effects.length ) definition.effects = effects;

  // A spell of level 1 or higher spends a slot of its level or higher; damage dice that scale grow per level above.
  if ( spell && level && SLOT_MODES.has(system.preparation?.mode ?? "prepared") ) {
    const levels = Array.from({length: 10 - level}, (_, offset) => level + offset);
    const scaling = damage.filter(component => component.scaleDice).map(component => ({type: "scaleDamage", levelChoiceId: "spell-slot",
      baseLevel: level, componentIds: [component.id], dice: component.scaleDice}));
    definition.configuration = [{id: "spell-slot", type: "resource", label: "Spell slot", required: true,
      cost: {anyOf: levels.map(each => [{capability: `spell-slot.${each}`, amount: 1}])},
      levelByResourceId: Object.fromEntries(levels.map(each => [`spell-slot.${each}`, each])), effects: scaling}];
  }
  if ( concentration && !effects.length ) notes.push("concentration: nothing it sustains was converted");
  // An attack or save with nothing converted on it would roll for nothing: such an Action is left out and noted.
  return (damage.length || healing.length || effects.length) ? definition : null;
}

/** A damage part's dice per spell level above its own (`scaling.mode: "whole"`), or null. Cantrips are noted. */
function scaledDice(part, {spell, level, notes, label}) {
  if ( !spell || (part.scaling?.mode !== "whole") ) return null;
  if ( !level ) {
    notes.push(`${label}: cantrip damage growing with character level not converted`);
    return null;
  }
  const count = number(part.scaling?.number) ?? 1;
  const faces = number(part.denomination);
  return faces ? {number: count, faces} : null;
}

/** `<class>.<scale>` → `{level: value}` rows from dnd5e class documents' ScaleValue advancements. */
export function scaleTables(classDocuments=[]) {
  const tables = {};
  for ( const document of classDocuments ) {
    const owner = document.system?.identifier ?? slugify(document.name);
    // Stored sources keep advancements by id; prepared documents as a list.
    for ( const advancement of Object.values(document.system?.advancement ?? {}) ) {
      if ( (advancement.type !== "ScaleValue") || (advancement.configuration?.type !== "number") ) continue;
      const id = advancement.configuration.identifier || slugify(advancement.title);
      tables[`${owner}.${id}`] = Object.fromEntries(Object.entries(advancement.configuration.scale ?? {})
        .map(([level, entry]) => [level, Number(entry.value)]).filter(([, value]) => Number.isFinite(value)));
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
export function convertActor(document, {scales={}, pack=null}={}) {
  if ( !isSrd2024(document) ) return {ok: false, reason: "not SRD 5.2 (CC-BY-4.0)"};
  if ( document.type !== "npc" ) return {ok: false, reason: `a ${document.type} is not converted`};
  const system = document.system ?? {};
  const notes = [];
  const score = key => number(system.abilities?.[key]?.value) ?? 10;
  const modifier = key => Math.floor((score(key) - 10) / 2);
  const challenge = number(system.details?.cr) ?? 0;
  const proficiency = proficiencyForChallenge(challenge);
  const saveDC = calculation => (ABILITY_MAP[calculation] ? {value: 8 + proficiency + modifier(calculation)} : null);
  const actorId = document._id;

  const items = [];
  for ( const item of document.items ?? [] ) {
    if ( item.type === "equipment" ) continue;
    const result = convertItem(item, {scales, pack, saveDC});
    if ( !result.ok ) {
      notes.push(`${item.name}: ${result.reason}`);
      continue;
    }
    notes.push(...result.notes.map(note => `${item.name}: ${note}`));
    for ( const converted of result.items ) {
      // Legendary Actions are paid from the creature's own pool, not a pool per item.
      converted.system.ruleElements = converted.system.ruleElements.filter(rule => rule.type !== "GrantResource" || !converted.system
        .definition.costs.allOf.some(cost => cost.capability === "legendary-action"));
      items.push({...converted, _key: `!actors.items!${actorId}.${converted._id}`});
    }
  }

  const traits = traitRules(system, notes);
  if ( traits.length ) items.push({_id: `${String(actorId).slice(0, 12)}trts`, _key: `!actors.items!${actorId}.${String(actorId).slice(0, 12)}trts`,
    name: "Traits", type: "feature", img: "icons/svg/aura.svg", system: {active: true, description: "", ruleElements: traits},
    flags: {wildpath: {conversion: {notes: []}}}});

  // shortcut: WildPath adds no proficiency bonus to attack rolls or saves; the stat block's numbers include it.
  notes.push(`attacks and proficient saves: the stat block adds +${proficiency} proficiency, which WildPath does not`);
  const walk = number(system.attributes?.movement?.walk) ?? 30;
  const health = number(system.attributes?.hp?.max) ?? number(system.attributes?.hp?.value) ?? 1;
  const size = SIZES[system.traits?.size] ?? 1;
  return {ok: true, notes, actor: {
    _id: actorId, _key: `!actors!${actorId}`, name: document.name, type: "npc",
    img: String(document.img ?? "").startsWith("icons/") ? document.img : "icons/svg/mystery-man.svg",
    system: {
      abilities: Object.fromEntries(Object.entries(ABILITY_MAP).map(([key, ability]) => [ability, {value: score(key)}])),
      defenses: {ac: {value: armorClass(document, modifier("dex"), notes)}},
      resources: {health: {base: health, value: health}, movement: {base: walk, value: walk}},
      details: {threat: Math.floor(challenge)},
      dyingMode: "auto"
    },
    prototypeToken: {name: document.name, width: size, height: size, disposition: -1, actorLink: false},
    items,
    flags: {wildpath: {source: {system: "dnd5e", pack, id: document._id, type: document.type, book: "SRD 5.2", license: "CC-BY-4.0",
      rules: "2024", challenge}, conversion: {notes}}}
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
  if ( types("dv").length ) notes.push(`vulnerabilities (${types("dv").join(", ")}) not converted`);
  if ( types("ci").length ) notes.push(`condition immunities (${types("ci").join(", ")}) not converted`);
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
