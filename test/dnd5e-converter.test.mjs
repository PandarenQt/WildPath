import {test} from "node:test";
import assert from "node:assert/strict";
import {checkOf, convertActor, convertItem, creatureRef, describe, formulaExpression, houseText, lastingArea, moveAreaDefinition, isSrd2024, nameIndex,
  scaleTables, withRedirects} from "../scripts/content/dnd5e-to-wildpath.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import * as valueExpressions from "../module/helpers/value-expressions.mjs";

// Synthetic documents in dnd5e 6.x's shape (mechanics only), not copies of its compendium.
const SRD = {license: "CC-BY-4.0", rules: "2024", book: ""};
const activity = (type, data={}) => ({_id: `act${type}`, type, sort: 0, activation: {type: "action", override: false},
  range: {override: false}, target: {override: false, template: {}, affects: {}}, effects: [], consumption: {targets: []}, ...data});

const weapon = {_id: "testLongsword001", name: "Test Sword", type: "weapon", img: "icons/weapons/swords/sword.webp", system: {source: SRD,
  properties: ["ver", "fin"], range: {value: null, long: null, units: "ft", reach: null},
  damage: {base: {number: 1, denomination: 8, types: ["slashing"], bonus: ""}},
  activities: {a: activity("attack", {activation: {type: "action", value: 1, override: false}, range: {value: "5", units: "ft", override: false},
    attack: {ability: "", bonus: "", type: {value: "melee", classification: "weapon"}}, damage: {includeBase: true, parts: []}})}}};

const burst = {_id: "testBurst0000001", name: "Test Burst", type: "spell", img: "systems/dnd5e/icons/spell.webp", effects: [], system: {source: SRD,
  level: 3, preparation: {mode: "prepared"}, properties: ["vocal"], activation: {type: "action"}, range: {value: "150", units: "ft"},
  target: {template: {type: "sphere", size: "20", units: "ft"}, affects: {type: "creature"}},
  activities: {a: activity("save", {save: {ability: "dex", dc: {calculation: "spellcasting", formula: ""}},
    damage: {onSave: "half", parts: [{number: 8, denomination: 6, bonus: "", types: ["fire"], scaling: {mode: "whole", number: 1}}]}})}}};

const bolt = {_id: "testBolt00000001", name: "Test Bolt", type: "spell", effects: [], system: {source: SRD, level: 0, preparation: {mode: "always"},
  properties: [], activation: {type: "action"}, range: {value: "120", units: "ft"}, target: {affects: {count: "1", type: "creature"}, template: {}},
  activities: {a: activity("attack", {attack: {type: {value: "ranged", classification: ""}, ability: "", bonus: ""},
    damage: {parts: [{number: 1, denomination: 10, bonus: "", types: ["fire"], scaling: {mode: "whole"}}]}})}}};

const mend = {_id: "testMend00000001", name: "Test Mend", type: "spell", effects: [], system: {source: SRD, level: 1, preparation: {mode: "prepared"},
  properties: [], activation: {type: "action"}, range: {units: "touch"}, target: {affects: {count: "1", type: "creature"}, template: {}},
  activities: {a: activity("heal", {healing: {number: 2, denomination: 8, bonus: "@mod", types: ["healing"], scaling: {mode: "whole", number: 2}}})}}};

const secondWind = {_id: "testSecondWind01", name: "Test Wind", type: "feat", effects: [], system: {source: SRD,
  uses: {max: "@scale.fighter.second-wind", recovery: [{period: "lr", type: "recoverAll"}, {period: "sr", type: "formula", formula: "1"}]},
  activities: {a: activity("heal", {activation: {type: "bonus", override: false}, range: {units: "self", override: false},
    target: {affects: {type: "self"}, template: {}, override: false}, consumption: {targets: [{type: "itemUses", value: "1"}]},
    healing: {number: 1, denomination: 10, bonus: "@classes.fighter.levels", types: ["healing"]}})}}};

const hold = {_id: "testHold00000001", name: "Test Hold", type: "spell", system: {source: SRD, level: 2, preparation: {mode: "prepared"},
  properties: ["concentration"], activation: {type: "action"}, range: {value: "60", units: "ft"}, target: {affects: {count: "@item.level - 1"}, template: {}},
  activities: {a: activity("save", {save: {ability: "wis", dc: {calculation: "spellcasting"}}, damage: {parts: []},
    effects: [{_id: "paralyze", onSave: false}]})}}, effects: [{_id: "paralyze", name: "Paralyzed", statuses: ["paralyzed"]}]};

const trip = {_id: "testTrip00000001", name: "Test Trip", type: "feat", system: {source: SRD, properties: [],
  activities: {a: activity("save", {save: {ability: ["str", "dex"], dc: {calculation: "", formula: "13"}}, damage: {parts: []},
    effects: [{_id: "prone", onSave: false}]})}}, effects: [{_id: "prone", name: "Prone", statuses: ["prone"]}]};

const valid = item => assert.equal(validateActionDefinition(item.system.definition).ok, true, item.name);

test("only documents whose own source says SRD 5.2 (CC-BY-4.0, 2024) are converted", () => {
  assert.equal(isSrd2024(weapon), true);
  assert.equal(isSrd2024({system: {source: {license: "Unlicensed", rules: "2024"}}}), false, "the Free Rules are not SRD");
  assert.equal(isSrd2024({system: {source: {license: "CC-BY-4.0", rules: "2014"}}}), false);
  assert.deepEqual(convertItem({...weapon, system: {...weapon.system, source: {}}}), {ok: false, reason: "not SRD 5.2 (CC-BY-4.0)"});
});

test("a weapon becomes its attack: finesse, reach, and its own damage that the ability modifier joins", () => {
  const {items, notes} = convertItem(weapon);
  assert.equal(items.length, 2, "and its two-handed Action");
  valid(items[0]);
  assert.deepEqual(items[0].system.definition.attack, {type: "melee", statistic: "weapon", defenseKey: "ac", proficient: true,
    properties: ["finesse"]});
  assert.deepEqual(items[0].system.definition.range, {type: "reach", distance: {value: 5, unit: "ft"}});
  assert.deepEqual(items[0].system.definition.damage, [{id: "base", expression: {type: "dice", number: 1, faces: 8}, damageType: "slashing",
    provenance: "weapon-base"}]);
  assert.deepEqual(notes, []);
  assert.equal(items[0].img, "icons/weapons/swords/sword.webp", "core icons are kept");
  assert.deepEqual(items[0].flags.wildpath.source, {system: "dnd5e", pack: null, id: "testLongsword001", type: "weapon", book: "SRD 5.2",
    license: "CC-BY-4.0", rules: "2024", identifier: "test-sword", subtype: null});
});

test("an area save spell: a sphere, the spell save DC, half on a success, and a slot of its level or higher that scales", () => {
  const [item] = convertItem(burst).items;
  valid(item);
  const definition = item.system.definition;
  assert.deepEqual(definition.area, {shape: "radial", size: {value: 20, unit: "ft"}});
  const template = type => convertItem({...burst, system: {...burst.system, target: {...burst.system.target,
    template: {type, size: "10", height: "40", units: "ft"}}}}).items[0].system.definition.area;
  assert.deepEqual(template("cylinder"), {shape: "radial", size: {value: 10, unit: "ft"}, height: {value: 40, unit: "ft"}}, "a Cylinder's height");
  assert.deepEqual(template("circle").height, {value: 0, unit: "ft"}, "a circle lies on the ground");
  assert.equal(definition.save.ability, "agility");
  assert.deepEqual(definition.damage[0].saveOutcomePolicy, {success: "half", failure: "full"});
  assert.deepEqual(definition.configuration[0].cost.anyOf.map(branch => branch[0].capability), [3, 4, 5, 6, 7, 8, 9].map(level => `spell-slot.${level}`));
  assert.deepEqual(definition.configuration[0].effects, [{type: "scaleDamage", levelChoiceId: "spell-slot", baseLevel: 3,
    componentIds: ["damage-1"], dice: {number: 1, faces: 6}}]);
  assert.equal(item.img, "icons/svg/item-bag.svg", "a dnd5e system icon is not used");
});

test("an attack cantrip, a healing spell and a class feature with uses", () => {
  const cantrip = convertItem(bolt);
  valid(cantrip.items[0]);
  assert.equal(cantrip.items[0].system.definition.attack.statistic, "spell");
  assert.equal(cantrip.items[0].system.definition.configuration, undefined, "a cantrip spends no slot");
  assert.deepEqual(cantrip.items[0].system.definition.damage[0].expression, {type: "table", key: {type: "character-level"},
    rows: {1: {type: "dice", number: 1, faces: 10}, 5: {type: "dice", number: 2, faces: 10}, 11: {type: "dice", number: 3, faces: 10},
      17: {type: "dice", number: 4, faces: 10}}}, "a cantrip's dice grow at levels 5, 11 and 17");
  assert.deepEqual(cantrip.notes, []);

  const heal = convertItem(mend);
  valid(heal.items[0]);
  assert.deepEqual(heal.items[0].system.definition.healing[0].expression, {type: "add", terms: [{type: "dice", number: 2, faces: 8},
    {type: "spellcasting-modifier"}]});
  assert.deepEqual(heal.notes, []);
  assert.deepEqual(heal.items[0].system.definition.configuration[0].effects, [{type: "scaleHealing", levelChoiceId: "spell-slot", baseLevel: 1,
    componentIds: ["healing-1"], dice: {number: 2, faces: 8}}], "2d8 more healing per slot level above 1st");

  const scales = scaleTables([{name: "Fighter", system: {identifier: "fighter", advancement: {x: {type: "ScaleValue", title: "Second Wind",
    configuration: {identifier: "", type: "number", scale: {1: {value: 2}, 4: {value: 3}, 10: {value: 4}}}}}}}]);
  const wind = convertItem(secondWind, {scales});
  valid(wind.items[0]);
  assert.deepEqual(wind.items[0].system.definition.costs.allOf, [{capability: "bonus-action", amount: 1}, {capability: "test-wind", amount: 1}]);
  assert.deepEqual(wind.items[0].system.definition.targeting, {type: "self"});
  assert.deepEqual(wind.items[0].system.ruleElements, [{schemaVersion: 1, id: "test-wind-uses", type: "GrantResource",
    data: {resourceId: "test-wind", label: "Test Wind", maximum: {type: "table", key: {type: "class-level", class: "fighter"},
      rows: {1: 2, 4: 3, 10: 4}}, recovery: "longRest", regain: {shortRest: 1}}}], "all on a long rest, one on a short rest");
  assert.deepEqual(wind.notes, []);
  const wand = {...secondWind, system: {...secondWind.system, uses: {max: "7", recovery: [{period: "dawn", type: "formula", formula: "1d6 + 1"}]}}};
  assert.deepEqual(convertItem(wand, {scales}).items[0].system.ruleElements[0].data, {resourceId: "test-wind", label: "Test Wind",
    maximum: {type: "constant", value: 7}, recovery: "none", regain: {longRest: {type: "add", terms: [{type: "dice", number: 1, faces: 6},
      {type: "constant", value: 1}]}}}, "a wand's 1d6 + 1 charges at dawn");
});

test("what WildPath cannot automate is a manual Action that spends its cost, named, never approximated", () => {
  const paralysis = convertItem(hold);
  valid(paralysis.items[0]);
  assert.deepEqual(paralysis.items[0].system.definition.effects, [{id: "effect-1", type: "condition", conditionId: "paralyzed",
    saveOutcomePolicy: "failure", concentration: true}], "Paralyzed on a failed save, for as long as the caster concentrates");

  const held = convertItem({...hold, _id: "testSilence00001", name: "Test Silence",
    effects: [{_id: "paralyze", name: "Silenced", statuses: ["silenced"]}]});
  const [manual] = held.items;
  assert.equal(manual.type, "action");
  assert.deepEqual(manual.system.definition.costs, {allOf: [{capability: "action", amount: 1}]}, "it still costs an Action");
  assert.equal(manual.system.definition.configuration[0].id, "spell-slot", "and spends its slot");
  assert.equal(manual.system.definition.save.ability, "wits", "its save is still rolled (2026-10-18); what follows is by hand");
  assert.equal(validateActionDefinition(manual.system.definition).ok, true);
  assert.ok(held.notes.some(note => /"Silenced" marks its creature only/.test(note)));
  assert.deepEqual(manual.system.definition.effects.map(effect => [effect.type, effect.name, effect.saveOutcomePolicy, effect.concentration]),
    [["effect", "Silenced", "failure", true]], "a creature that fails is marked, by its effect's name, while the caster concentrates");
  assert.ok(held.notes.includes("effect: silenced is not a WildPath condition yet"));

  const tripped = convertItem(trip);
  valid(tripped.items[0]);
  assert.deepEqual(tripped.items[0].system.definition.save, {ability: "might", dc: {value: 13}});
  assert.deepEqual(tripped.items[0].system.definition.effects, [{id: "effect-1", type: "condition", conditionId: "prone", saveOutcomePolicy: "failure"}]);
  assert.deepEqual(tripped.notes, ["save: a choice of str/dex uses str"]);

  assert.deepEqual(formulaExpression("@abilities.str.mod"), {type: "ability-modifier", ability: "might"});
  assert.deepEqual(formulaExpression("max(1, @abilities.cha.mod)"), {type: "max", terms: [{type: "constant", value: 1},
    {type: "ability-modifier", ability: "presence"}]});
  assert.deepEqual(formulaExpression("1d8 + @prof"), {type: "add", terms: [{type: "dice", number: 1, faces: 8}, {type: "proficiency-bonus"}]});
  assert.equal(formulaExpression("@abilities.str.value"), null, "what WildPath cannot read stays out");
  const scales = {"rogue.sneak-attack": {1: {number: 1, faces: 6}, 3: {number: 2, faces: 6}}, "monk.martial-arts": {1: {number: 1, faces: 6}, 5: {number: 1, faces: 8}}};
  assert.deepEqual(formulaExpression("@scale.rogue.sneak-attack", {scales}), {type: "table", key: {type: "class-level", class: "rogue"},
    rows: {1: {type: "dice", number: 1, faces: 6}, 3: {type: "dice", number: 2, faces: 6}}});
  assert.deepEqual(formulaExpression("1@scale.monk.martial-arts.die + @mod", {scales, ability: "agility"}).terms[1],
    {type: "ability-modifier", ability: "agility"});
  assert.deepEqual(formulaExpression("@prof"), {type: "proficiency-bonus"});
  assert.deepEqual(formulaExpression("@mod", {ability: "might"}), {type: "ability-modifier", ability: "might"});
});

test("descriptions are the source's own text with dnd5e's enrichers resolved", () => {
  const names = {pageId: "Conditions"};
  const text = describe({system: {description: {value: "<p>[[lookup @labels.description.affects capitalize]] in a [[lookup @labels.description.template]] "
    + "makes a [[/save dex]]; see @UUID[Compendium.dnd5e.content24.JournalEntry.x.JournalEntryPage.pageId] and &Reference[prone]. "
    + "@Embed[Compendium.dnd5e.content24.JournalEntry.x]Roll [[/r 1d4]] or @UUID[Item.y]{the wand}.</p>"},
  target: {template: {type: "sphere", size: "20"}, affects: {type: "creature"}}, activities: {}}}, {names});
  assert.equal(text, "<p>Each creature in a 20-foot-radius Sphere makes a Dexterity saving throw; see Conditions and Prone. Roll 1d4 or the wand.</p>");
});

test("a creature: proficient saves, its stat block's text with its numbers, and its passive and manual abilities", () => {
  const scimitar = {...weapon, _id: "scimitar00000001", name: "Scimitar", system: {...weapon.system, properties: ["fin"],
    damage: {base: {number: 1, denomination: 6, types: ["slashing"]}},
    description: {value: "<p>[[/attack extended]]. [[/damage average extended]].</p>"}}};
  const multiattack = {_id: "multiattack00001", name: "Multiattack", type: "feat", system: {source: SRD,
    description: {value: "<p>The [[lookup @name lowercase]]{monster} makes two attacks, using [[/item .scimitar00000001]].</p>"},
    activities: {a: activity("utility")}}};
  const pack = {_id: "packTactics00001", name: "Pack Tactics", type: "feat", system: {source: SRD, description: {value: "<p>Advantage.</p>"},
    activities: {}}};
  const captain = {_id: "captain000000001", name: "Bandit Captain", type: "npc", system: {source: SRD, details: {cr: 2},
    abilities: {str: {value: 15, proficient: 1}, dex: {value: 16, proficient: 1}, con: {value: 14}, int: {value: 14}, wis: {value: 11, proficient: 1},
      cha: {value: 14}}, attributes: {hp: {max: 52}, movement: {walk: "30"}, ac: {calc: "natural", flat: 15}}, traits: {size: "med"}},
    items: [scimitar, multiattack, pack]};
  const {actor} = convertActor(captain);
  assert.deepEqual(Object.entries(actor.system.abilities).filter(([, ability]) => ability.saveProficient).map(([key]) => key),
    ["might", "agility", "wits"]);
  const byName = name => actor.items.find(item => item.name === name);
  assert.equal(byName("Scimitar").system.description, "<p>Melee Attack Roll: +5, reach 5 ft. Hit: 6 (1d6 + 3) Slashing damage.</p>");
  assert.equal(byName("Multiattack").type, "action", "Multiattack is used: a manual Action costing an Action");
  assert.equal(byName("Multiattack").system.description, "<p>The bandit captain makes two attacks, using Scimitar.</p>");
  assert.equal(byName("Pack Tactics").type, "feature", "a passive ability is a feature with its text");
  assert.equal(byName("Pack Tactics").system.description, "<p>Advantage.</p>");

  const golem = convertActor({...captain, _id: "golem00000000001", name: "Golem", items: [], system: {...captain.system,
    traits: {size: "lg", dv: {value: ["thunder"]}, ci: {value: ["charmed", "petrified", "diseased"]}}}});
  const rules = golem.actor.items.find(item => item.name === "Traits").system.ruleElements;
  assert.deepEqual(rules.filter(rule => ["GrantVulnerability", "ConditionImmunity"].includes(rule.type)).map(rule => rule.data),
    [{damageTypes: ["thunder"]}, {conditions: ["charmed", "petrified"]}]);
  assert.ok(golem.notes.includes("condition immunities (diseased) not converted"));
});

test("a book package keeps its art, and its script refuses to write inside the repository", async () => {
  const {execFileSync} = await import("node:child_process");
  const owned = {_id: "goblinWarrior001", name: "Goblin", type: "npc", img: "modules/book/art/goblin.webp",
    prototypeToken: {texture: {src: "modules/book/tokens/goblin-*.webp"}, randomImg: true},
    system: {source: {license: "", rules: "2024"}, details: {cr: 0.25}, abilities: {}, attributes: {hp: {max: 10}}}, items: []};
  assert.equal(convertActor(owned).ok, false, "without the book's licence check it is not converted as SRD");
  const {actor} = convertActor(owned, {licensed: () => true, book: "Monster Manual", images: ["icons/", "modules/book/"]});
  assert.equal(actor.img, "modules/book/art/goblin.webp");
  assert.deepEqual(actor.prototypeToken.texture, {src: "modules/book/tokens/goblin-*.webp"});
  assert.equal(actor.prototypeToken.randomImg, true);
  assert.equal(actor.flags.wildpath.source.book, "Monster Manual");
  assert.throws(() => execFileSync(process.execPath, ["scripts/content/convert-dnd5e-module.mjs", "dnd-monster-manual", "--data", "test"],
    {stdio: "pipe"}), /inside this repository/);
});

test("older dnd5e data (2014 modules, before activities) converts like the current format", async () => {
  const {upgradeLegacy} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  const legacy = {source: {license: "", rules: "2014"}};
  const own = {licensed: () => true, book: "A 2014 book"};
  const claw = {_id: "legacyClaw000001", name: "Claw", type: "weapon", system: {...legacy, actionType: "mwak", activation: {type: "action", cost: 1},
    range: {value: 5, units: "ft"}, properties: {fin: true}, damage: {parts: [["1d8 + @mod", "slashing"], ["1d6", "poison"]]}}};
  const [weaponAction] = convertItem(claw, own).items;
  assert.equal(validateActionDefinition(weaponAction.system.definition).ok, true);
  assert.deepEqual(weaponAction.system.definition.damage.map(entry => [entry.provenance, entry.damageType]), [["weapon-base", "slashing"], ["additional", "poison"]]);
  assert.deepEqual(weaponAction.system.definition.attack.properties, ["finesse"]);

  const breath = {_id: "legacyBreath0001", name: "Fire Breath", type: "feat", system: {...legacy, actionType: "save", activation: {type: "action", cost: 1},
    target: {value: 30, units: "ft", type: "cone"}, range: {units: "self"}, recharge: {value: 5}, uses: {},
    save: {ability: "dex", dc: 13, scaling: "flat"}, damage: {parts: [["7d6", "fire"]]}}};
  const result = convertItem(breath, own);
  const definition = result.items[0].system.definition;
  assert.deepEqual([definition.area.shape, definition.area.size.value, definition.save.dc.value], ["cone", 30, 13]);
  assert.deepEqual(definition.damage[0].saveOutcomePolicy, {success: "half", failure: "full"});
  assert.deepEqual(result.items[0].system.ruleElements[0].data, {resourceId: "fire-breath", label: "Fire Breath",
    maximum: {type: "constant", value: 1}, recovery: "none", recharge: 5}, "Recharge 5-6, rolled at the start of each turn");

  const bolt = upgradeLegacy({_id: "legacyBolt000001", name: "Bolt", type: "spell", system: {...legacy, level: 0, actionType: "rsak",
    activation: {type: "action", cost: 1}, range: {value: 120, units: "ft"}, scaling: {mode: "cantrip"}, damage: {parts: [["1d10", "fire"]]}}});
  assert.deepEqual(bolt.system.activities.legacy.damage.parts[0].scaling, {mode: "whole"});
  const cure = convertItem({_id: "legacyCure000001", name: "Cure", type: "spell", system: {...legacy, level: 1, actionType: "heal",
    activation: {type: "action", cost: 1}, range: {units: "touch"}, target: {value: 1, type: "creature"}, preparation: {mode: "prepared"},
    scaling: {mode: "level", formula: "1d8"}, damage: {parts: [["1d8 + @mod", "healing"]]}}}, own);
  assert.deepEqual(cure.items[0].system.definition.configuration[0].effects[0], {type: "scaleHealing", levelChoiceId: "spell-slot", baseLevel: 1,
    componentIds: ["healing-1"], dice: {number: 1, faces: 8}});
});

test("an effect with its own changes becomes a custom effect with the rules they map to, and its duration (G3)", async () => {
  const {effectRules, changeValue} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  const attack = kind => ({key: `system.bonuses.${kind}.attack`, value: "1d4", type: "add"});
  const blessed = {name: "Blessed", system: {changes: [attack("mwak"), attack("rwak"), attack("msak"), attack("rsak"),
    {key: "system.bonuses.abilities.save", value: "1d4", type: "add"}]}};
  assert.deepEqual(effectRules(blessed).map(rule => [rule.type, rule.data.domains, rule.data.valueExpression]), [
    ["Modifier", ["attack"], {type: "dice", number: 1, faces: 4}], ["Modifier", ["save"], {type: "dice", number: 1, faces: 4}]]);
  const notes = [];
  const mixed = effectRules({name: "Mixed", system: {changes: [attack("mwak"), {key: "system.skills.ste.roll.mode", value: "-1", type: "add"},
    {key: "system.traits.ci.value", value: "charmed", type: "add"}, {key: "system.traits.ci.value", value: "diseased", type: "add"},
    {key: "system.attributes.movement.walk", value: "0", type: "override"}, {key: "system.attributes.movement.fly", value: "60", type: "upgrade"},
    {key: "system.attributes.ac.calc", value: "mage", type: "override"}]}}, notes);
  assert.deepEqual(mixed.map(rule => [rule.type, rule.predicate ?? null]), [["Modifier", {tagsAny: ["melee"]}], ["RollMode", null],
    ["ResourceCap", null], ["GrantMovement", null], ["ArmorClass", null], ["ConditionImmunity", null]]);
  assert.deepEqual(mixed[0].data.domains, ["attack.weapon"], "a melee weapon attack bonus");
  assert.deepEqual(mixed[1].data, {domains: ["check.stealth"], mode: "disadvantage"});
  assert.deepEqual(mixed[4].data.value, {type: "add", terms: [{type: "constant", value: 13}, {type: "ability-modifier", ability: "agility"}]},
    "Mage Armor: 13 + Agility modifier while unarmored");
  assert.deepEqual(notes, ['effect: "Mixed" condition immunity diseased not converted']);
  assert.deepEqual(changeValue("-1d4"), {type: "subtract", left: {type: "constant", value: 0}, right: {type: "dice", number: 1, faces: 4}});

  const spell = {_id: "testBless0000001", name: "Test Bless", type: "spell", system: {source: SRD, level: 1, preparation: {mode: "prepared"},
    properties: ["concentration"], activation: {type: "action"}, range: {value: "30", units: "ft"}, target: {affects: {type: "creature", count: "3"}, template: {}},
    activities: {a: activity("utility", {effects: [{_id: "blessed00000001"}]})}},
    effects: [{_id: "blessed00000001", name: "Blessed", img: "bless.webp", ...blessed, duration: {value: 60, units: "seconds", expiry: "turnStart"}}]};
  const converted = convertItem(spell);
  valid(converted.items[0]);
  const [effect] = converted.items[0].system.definition.effects;
  assert.deepEqual([effect.type, effect.name, effect.concentration, effect.duration], ["effect", "Blessed", true,
    {value: 60, units: "seconds", expiry: "turnStart"}]);
  const {actionDefinitionToResolverInput} = await import("../module/helpers/action-definitions.mjs");
  assert.deepEqual(actionDefinitionToResolverInput(converted.items[0].system.definition).targeting.refinementPolicy,
    {minSelections: 1, maxSelections: 3}, "up to three creatures: one is enough");
});

test("common monster traits (G5): Magic Resistance, Pack Tactics and Regeneration become their rules", () => {
  const trait = (id, name, activities={}, description="") => ({_id: `${id.replace(/-/g, "").slice(0, 12)}0000`, name, type: "feat",
    system: {source: SRD, identifier: id, activities, description: {value: description}}});
  const regenerating = description => trait("regeneration", "Regeneration", {a: activity("heal", {activation: {type: "special",
    condition: "starts its turn"}, healing: {number: null, denomination: null, bonus: "10", types: ["healing"], custom: {enabled: false}}})},
    description);
  const regeneration = regenerating("<p>The troll regains 10 Hit Points at the start of each of its turns. If the troll takes Acid or Fire "
    + "damage, this trait doesn't function on the troll's next turn. The troll dies only if it starts its turn with 0 Hit Points and "
    + "doesn't regenerate.</p>");
  const troll = {_id: "testTroll0000001", name: "Test Troll", type: "npc", system: {source: SRD, details: {cr: 5},
    abilities: {str: {value: 18}}, attributes: {hp: {max: 94}, movement: {walk: "30"}}, traits: {size: "lg"},
    resources: {legres: {max: 3, spent: 0}}},
    items: [trait("magic-resistance", "Magic Resistance"), trait("pack-tactics", "Pack Tactics"), regeneration, trait("flyby", "Flyby"),
      trait("legendary-resistance", "Legendary Resistance", {a: activity("utility", {activation: {type: "special", condition: "fails a saving throw"}})})]};
  const {actor} = convertActor(troll);
  const rules = name => actor.items.find(item => item.name === name).system.ruleElements;
  assert.deepEqual(rules("Magic Resistance").map(rule => [rule.type, rule.predicate, rule.data]),
    [["RollMode", {tagsAny: ["magical"]}, {domains: ["save"], mode: "advantage"}]]);
  assert.deepEqual(rules("Pack Tactics").map(rule => [rule.type, rule.predicate, rule.data]),
    [["RollMode", {equals: {path: "attack.allyNearTarget", value: true}}, {domains: ["attack"], mode: "advantage"}]]);
  const [regenerate] = rules("Regeneration");
  const stopped = type => ({not: {equals: {path: `actor.flags.wildpath.damageTaken.${type}`, value: true}}});
  assert.deepEqual([regenerate.type, regenerate.data.event, regenerate.data.stoppedBy, regenerate.data.deferDeath, regenerate.data.predicate],
    ["Trigger", "turn.started", ["acid", "fire"], true, {all: [stopped("acid"), stopped("fire")]}],
    "it works at 0 Hit Points, unless Acid or Fire stopped it; at 0 it dies only if it does not regenerate");
  assert.equal(describe(regenerating("<p>Regains [[lookup @healing.formula activity=actheal]] Hit Points.</p>")),
    "<p>Regains 10 Hit Points.</p>", "its healing, which dnd5e computes");
  const ruleOf = description => convertItem(regenerating(description), {creature: {name: "Test"}}).items[0].system.ruleElements[0].data;
  assert.deepEqual(ruleOf("<p>The oni regains 10 Hit Points at the start of each of its turns if it has at least 1 Hit Point.</p>").predicate,
    {not: {equals: {path: "actor.system.resources.health.value", value: 0}}}, "only while it has 1 Hit Point");
  const turnStart = convertItem({...regeneration, system: {...regeneration.system, activities: {a: {...regeneration.system.activities.a,
    activation: {type: "turnStart"}}}}}, {creature: {name: "Test"}}).items;
  assert.deepEqual(turnStart.map(item => [item.type, item.system.ruleElements[0].id]), [["feature", "regeneration"]],
    "healing activated at the start of the turn is the trait's too, not an Action");
  const vampire = ruleOf("<p>The vampire regains 20 Hit Points at the start of its turn if it has at least 1 Hit Point and isn't in sunlight "
    + "or running water. If it takes Radiant damage, this trait doesn't function at the start of its next turn.</p>");
  assert.deepEqual(vampire.predicate.all.map(entry => JSON.stringify(entry)).filter(entry => entry.includes("inSunlight")),
    [JSON.stringify({not: {equals: {path: "inSunlight", value: true}}})], "not in sunlight");
  const unstoppable = ruleOf("<p>The tarrasque regains 30 Hit Points at the start of each of its turns.</p>");
  assert.deepEqual([unstoppable.predicate, unstoppable.stoppedBy, unstoppable.deferDeath], [undefined, undefined, undefined],
    "nothing stops it");
  assert.deepEqual(regenerate.data.action.costs, {allOf: []});
  assert.equal(regenerate.data.action.healing[0].expression.value, 10);
  assert.equal(validateActionDefinition(regenerate.data.action).ok, true);
  assert.deepEqual(rules("Flyby").map(rule => [rule.type, rule.data]), [["AvoidOpportunityAttacks", {movementModes: ["fly"]}]]);
  // 2014 Lair Actions: one a round, from a pool its lair gives it.
  const lair = convertActor({...troll, _id: "testLair00000001", system: {...troll.system, resources: {lair: {value: true}}},
    items: [{_id: "lairEyeRay000001", name: "Lair Action: Eye Ray", type: "feat", system: {source: SRD,
      activities: {a: activity("utility", {activation: {type: "lair", value: 1}})}}}]}).actor;
  assert.deepEqual(lair.items.find(item => item.name === "Lair Action: Eye Ray").system.definition.costs,
    {allOf: [{capability: "lair-action", amount: 1}]});
  assert.deepEqual(lair.items.find(item => item.name === "Traits").system.ruleElements.find(rule => rule.id === "lair-actions").data,
    {resourceId: "lair-action", label: "Lair Action", maximum: 1, recovery: "none", refillsAtInitiative: 100});
  assert.deepEqual(convertItem(trait("two-extra-attacks", "Two Extra Attacks")).items[0].system.ruleElements.map(rule => [rule.type, rule.data]), [
    ["GrantResource", {resourceId: "extra-attack", label: "Extra Attack", maximum: 1, current: 0, recovery: "none", emptiesAtTurnStart: true}],
    ["ExtraAttack", {resourceId: "extra-attack"}]], "each Extra Attack feature adds one attack to the same pool");
  const sunlit = (id, name, text, activities={}) => convertItem(trait(id, name, activities, `<p>${text}</p>`), {creature: {name: "Test"}}).items;
  const domainsOf = items => items[0].system.ruleElements[0].data.domains;
  assert.deepEqual(domainsOf(sunlit("sunlight-sensitivity", "Sunlight Sensitivity",
    "While in sunlight, the drider has Disadvantage on ability checks and attack rolls.")), ["attack", "check"]);
  assert.deepEqual(domainsOf(sunlit("", "Sunlight Sensitivity",
    "While in sunlight, the wraith has disadvantage on attack rolls, as well as on Wisdom (Perception) checks that rely on sight.")),
    ["attack", "check.perception"], "the 2014 text, matched by name");
  assert.deepEqual(domainsOf(sunlit("sunlight-weakness", "Sunlight Weakness", "While in sunlight, the shadow has Disadvantage on D20 Tests.")),
    ["attack", "check", "save"]);
  const burning = sunlit("sunlight-hypersensitivity", "Sunlight Hypersensitivity", "The vampire takes 20 Radiant damage if it starts its "
    + "turn in sunlight. While in sunlight, it has Disadvantage on attack rolls and ability checks.", {a: activity("damage", {activation: {type: ""},
      damage: {parts: [{number: null, denomination: null, bonus: "20", types: ["radiant"]}]}})});
  assert.deepEqual(burning[0].system.ruleElements.map(rule => [rule.type, rule.predicate ?? rule.data.predicate]), [["RollMode", {equals: {path: "inSunlight", value: true}}],
    ["Trigger", {equals: {path: "inSunlight", value: true}}]], "and it burns at the start of its turn there");
  const daylight = convertItem({_id: "phbsplDaylight00", name: "Daylight", type: "spell", system: {source: SRD, identifier: "daylight", level: 3,
    preparation: {mode: "prepared"}, activation: {type: "action"}, range: {value: "60", units: "ft"}, duration: {value: "1", units: "hour"},
    target: {template: {type: "sphere", size: "60"}, affects: {}}, activities: {a: activity("utility", {target: {override: false, template: {}, affects: {}}})}}}).items[0];
  assert.deepEqual([daylight.system.definition.targeting.type, daylight.system.definition.area.persistence],
    ["area", {duration: {unit: "round", value: 600}, light: {bright: 60, dim: 120, sunlight: true, dispels: 3, spellLevel: 3},
      onObject: "on-object"}], "Daylight sheds sunlight for an hour, ends Darkness up to level 3, and can be cast on an object");
  assert.deepEqual(daylight.system.definition.configuration.at(-1), {id: "on-object", type: "boolean",
    label: "Cast on an object (the Token at its center)", required: false});
  assert.equal(validateActionDefinition(daylight.system.definition).ok, true);
  const [evade] = convertItem(trait("evasion", "Evasion")).items[0].system.ruleElements;
  assert.deepEqual([evade.type, evade.data, evade.predicate.not.any.length], ["RollOutcome", {domains: ["save.agility"], outcome: "evasion"}, 6]);
  const sneak = convertItem(trait("sneak-attack", "Sneak Attack", {a: activity("damage", {activation: {type: ""},
    damage: {parts: [{custom: {enabled: true, formula: "@scale.rogue.sneak-attack"}, types: ["piercing"]}]}})}),
    {scales: {"rogue.sneak-attack": {1: {number: 1, faces: 6}, 3: {number: 2, faces: 6}}}}).items;
  assert.deepEqual(sneak.map(item => item.type), ["feature"], "its damage activity is the trait's");
  const [extra] = sneak[0].system.ruleElements;
  assert.deepEqual([extra.type, extra.data.domains, extra.data.once, extra.data.damageType, extra.data.expression.type],
    ["ExtraDamage", ["damage.weapon"], "turn", undefined, "table"], "by Rogue level, of the weapon's damage type");
  const wand = convertItem({...weapon, _id: "testMagicSword01", system: {...weapon.system, properties: [...weapon.system.properties, "mgc"]}});
  assert.deepEqual(wand.items[0].system.definition.tags, ["magical"], "a magic item's Action is magical");
  assert.deepEqual(rules("Legendary Resistance").map(rule => rule.data), [{resourceId: "legendary-resistance", label: "Legendary Resistance",
    maximum: 3, recovery: "longRest"}], "its uses, the pool a failed save spends");
  assert.ok(!actor.flags.wildpath.conversion.notes.some(note => /passive or triggered/.test(note)), "nothing is left as passive text");
});

test("summons (G4): its creature, a choice of creatures, for the spell's duration, and what it gains with the spell's level", () => {
  const profile = (id, name="") => ({_id: `p${id}`, uuid: `Compendium.dnd5e.actors24.Actor.${id}`, name, count: "", level: {min: null, max: null}});
  const summoning = (activityData, extra={}) => ({_id: "summonSpell00001", name: "Summon Test", type: "spell", system: {source: SRD, level: 3,
    preparation: {mode: "prepared"}, activation: {type: "action"}, range: {value: "90", units: "ft"}, duration: {value: "1", units: "hour"},
    properties: ["concentration"], activities: {a: activity("summon", {profiles: [profile("spirit000000001")], bonuses: {}, summon: {mode: ""},
      ...activityData})}, ...extra}});
  const creatures = {spirit000000001: "Compendium.wildpath.srd-creatures.Actor.spirit000000001",
    beast00000000001: "Compendium.wildpath.srd-creatures.Actor.beast00000000001"};
  const one = convertItem(summoning({bonuses: {ac: "@item.level", hp: "10 * (@item.level - 2)", healing: "@item.level"}}), {creatures}).items[0];
  valid(one);
  const {summon} = one.system.definition;
  assert.deepEqual([summon.actorRef, summon.count, summon.rounds, summon.concentration, summon.spellLevel],
    ["Compendium.wildpath.srd-creatures.Actor.spirit000000001", 1, 600, true, 3]);
  assert.deepEqual(summon.bonuses.ac, {type: "context", path: "castLevel"}, "AC + the level it was cast at");
  assert.ok(one.flags.wildpath.conversion.notes.some(note => note.includes("(healing) is not added")), "healing is not converted");
  const choice = convertItem(summoning({profiles: [profile("spirit000000001", "Spirit"), profile("beast00000000001", "Beast")]}), {creatures}).items[0];
  valid(choice);
  assert.equal(choice.system.definition.summon.choiceId, "summon-creature");
  assert.deepEqual(choice.system.definition.configuration.at(-1).options.map(option => option.label), ["Spirit", "Beast"]);
  const byChallenge = convertItem(summoning({summon: {mode: "cr"}}), {creatures}).items[0];
  assert.equal(byChallenge.system.definition.summon, undefined, "a creature chosen by Challenge Rating stays by hand");
  assert.equal(convertItem(summoning({}), {creatures: {}}).items[0].system.definition.summon, undefined, "nor one not converted");
});

test("the monster toolkit (G4): Multiattack's attacks, a Spellcasting's spells at their own uses, and Recharge", async () => {
  const {multiattackCount} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  assert.equal(multiattackCount("<p>The dragon makes three Rend attacks. It can replace one attack.</p>"), 3);
  assert.equal(multiattackCount("makes one Claws attack and one Tail attack, or it makes two Hurl Flame attacks."), 2);
  assert.equal(multiattackCount("makes a number of Reaping Scythe attacks equal to half"), null);
  assert.equal(multiattackCount("The dracolich can use its Frightful Presence. It then makes three attacks: one with its bite and two with its claws."), 3);

  const rend = {_id: "rend000000000001", name: "Rend", type: "weapon", system: {source: SRD, properties: [], range: {value: null, units: "ft", reach: 10},
    damage: {base: {number: 2, denomination: 8, types: ["slashing"]}},
    activities: {a: activity("attack", {range: {value: "10", units: "ft", override: false},
      attack: {ability: "str", bonus: "", type: {value: "melee", classification: "weapon"}}, damage: {includeBase: true, parts: []}})}}};
  const multi = {_id: "multi00000000001", name: "Multiattack", type: "feat", system: {source: SRD,
    description: {value: "<p>The [[lookup @name lowercase]]{monster} makes two [[/item Rend]] attacks.</p>"}, activities: {a: activity("utility")}}};
  const fireball = {_id: "phbsplFireball00", name: "Fireball", type: "spell", system: {source: SRD, level: 3, preparation: {mode: "prepared"},
    activation: {type: "action"}, range: {value: "150", units: "ft"}, target: {template: {type: "sphere", size: "20"}, affects: {type: "creature"}},
    activities: {a: activity("save", {save: {ability: ["dex"], dc: {calculation: "spellcasting"}},
      damage: {onSave: "half", parts: [{number: 8, denomination: 6, types: ["fire"]}]}})}}};
  const casting = {_id: "spellcasting0001", name: "Spellcasting", type: "feat", system: {source: SRD, activities: {
    a: activity("cast", {spell: {uuid: "Compendium.dnd5e.spells24.Item.phbsplFireball00", level: 3, ability: ""},
      uses: {max: "2", recovery: [{period: "day", type: "recoverAll"}]}, consumption: {targets: [{type: "activityUses", value: "1"}]}})}}};
  const cached = {...fireball, _id: "cachedFireball01", flags: {dnd5e: {cachedFor: ".Item.spellcasting0001.Activity.a"}}};
  const caster = {_id: "testMage00000001", name: "Test Mage", type: "npc", system: {source: SRD, details: {cr: 6},
    abilities: {str: {value: 18}, int: {value: 17}}, attributes: {hp: {max: 80}, movement: {walk: "30"}, spellcasting: "int"}, traits: {size: "med"}},
    items: [rend, multi, casting, cached]};
  const {actor} = convertActor(caster, {spells: {phbsplFireball00: fireball}});
  const byName = name => actor.items.filter(item => item.name === name);
  assert.equal(byName("Fireball").length, 1, "the cached copy is not converted again");
  const [cast] = byName("Fireball");
  valid(cast);
  assert.deepEqual(cast.system.definition.costs, {allOf: [{capability: "action", amount: 1}, {capability: "spellcasting-phbsplfireball00", amount: 1}]});
  assert.equal(cast.system.definition.configuration, undefined, "no spell slot");
  assert.deepEqual(cast.system.definition.save.dc, {value: 14}, "8 + proficiency 3 + Intellect 3");
  assert.deepEqual(cast.system.ruleElements[0].data, {resourceId: "spellcasting-phbsplfireball00", label: "Spellcasting (Fireball)",
    maximum: {type: "constant", value: 2}, recovery: "longRest"});

  const [multiattack] = byName("Multiattack");
  valid(multiattack);
  assert.deepEqual(multiattack.system.definition.restores, [{resourceId: "multiattack-rend", amount: 2}], "the attacks it names");
  assert.deepEqual(multiattack.system.ruleElements.at(-1).data, {resourceId: "multiattack-rend", label: "Multiattack (Rend)", maximum: 2,
    current: 0, recovery: "none", emptiesAtTurnStart: true});
  assert.deepEqual(byName("Rend")[0].system.definition.costs, {anyOf: [[{capability: "multiattack-rend", amount: 1}], [{capability: "action", amount: 1}]]});
  assert.equal(multiattack.system.description, "<p>The test mage makes two Rend attacks.</p>", "an item named by name");
});

test("Multiattack's named attacks: one pool each, an Action per alternative, and one shared pool when it names none", async () => {
  const {multiattackPlans} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  const plans = (text, names) => multiattackPlans(text, names)?.map(plan => plan.map(group => [group.names.join("|"), group.amount]));
  assert.deepEqual(plans("The griffon makes one Beak attack and two Claws attacks.", ["Beak", "Claws", "Tail"]), [[["Beak", 1], ["Claws", 2]]]);
  assert.deepEqual(plans("It makes three attacks: one with its bite and two with its claws.", ["Bite", "Claw"]), [[["Bite", 1], ["Claw", 2]]]);
  assert.deepEqual(plans("It makes two attacks: one Bite and one Claw.", ["Bite", "Claw"]), [[["Bite", 1], ["Claw", 1]]]);
  assert.deepEqual(plans("It makes two attacks, using Scimitar or Pistol in any combination.", ["Scimitar", "Pistol", "Kick"]),
    [[["Scimitar|Pistol", 2]]], "a count those attacks share");
  assert.equal(plans("It makes two attacks.", ["Slam"]), undefined, "it names none");
  const attack = (id, name) => ({_id: id, name, type: "weapon", system: {source: SRD, properties: [], range: {value: null, units: "ft", reach: 5},
    damage: {base: {number: 1, denomination: 8, types: ["bludgeoning"]}},
    activities: {a: activity("attack", {attack: {ability: "str", bonus: "", type: {value: "melee", classification: "weapon"}},
      damage: {includeBase: true, parts: []}})}}});
  const ogre = {_id: "testOgre00000001", name: "Test Ogre", type: "npc", system: {source: SRD, details: {cr: 2}, abilities: {str: {value: 19}},
    attributes: {hp: {max: 68}, movement: {walk: "40"}}, traits: {size: "lg"}},
    items: [attack("greatclub0000001", "Greatclub"), attack("javelin000000001", "Javelin"), attack("stomp00000000001", "Stomp"),
      {_id: "multiattack00002", name: "Multiattack", type: "feat", system: {source: SRD,
        description: {value: "<p>The ogre makes two Greatclub attacks, or it makes two Javelin attacks.</p>"}, activities: {a: activity("utility")}}}]};
  const {actor} = convertActor(ogre);
  const byName = name => actor.items.find(item => item.name === name);
  const [club, javelin] = ["Multiattack (2 Greatclub)", "Multiattack (2 Javelin)"].map(byName);
  for ( const item of [club, javelin] ) valid(item);
  assert.deepEqual([club.system.definition.restores, javelin.system.definition.restores],
    [[{resourceId: "multiattack-greatclub", amount: 2}], [{resourceId: "multiattack-javelin", amount: 2}]], "each alternative is an Action");
  assert.notEqual(club._id, javelin._id);
  assert.deepEqual(club.system.ruleElements.filter(rule => rule.type === "GrantResource").map(rule => rule.data.resourceId),
    ["multiattack-greatclub", "multiattack-javelin"], "the pools are granted once");
  assert.equal(javelin.system.ruleElements.filter(rule => rule.type === "GrantResource").length, 0);
  assert.deepEqual(byName("Javelin").system.definition.costs.anyOf[0], [{capability: "multiattack-javelin", amount: 1}]);
  assert.deepEqual(byName("Stomp").system.definition.costs, {allOf: [{capability: "action", amount: 1}]}, "an attack it does not name");

  // A summoned spirit: "a number of attacks equal to half this spell's level (round down)".
  const spirit = convertActor({...ogre, _id: "testSpirit000001", name: "Test Spirit", items: [attack("claws00000000001", "Claws"),
    {_id: "multiattack00004", name: "Multiattack", type: "feat", system: {source: SRD, description: {value: "<p>The spirit makes a number "
      + "of attacks equal to half this spell’s level (round down).</p>"}, activities: {a: activity("utility")}}}]}).actor;
  const spiritAttack = spirit.items.find(item => item.name === "Multiattack");
  assert.deepEqual(spiritAttack.system.ruleElements.at(-1).data.maximum, {type: "divide", numerator: {type: "context",
    path: "actor.flags.wildpath.summonLevel"}, denominator: {type: "constant", value: 2}, round: "floor"}, "half the level it was summoned at");
  assert.deepEqual(spiritAttack.system.definition.restores, [{resourceId: "multiattack", amount: 4}], "filled, whatever its size");
  assert.deepEqual(spirit.items.find(item => item.name === "Claws").system.definition.costs.anyOf[0], [{capability: "multiattack", amount: 1}]);
  assert.deepEqual(spiritAttack.flags.wildpath.conversion.notes, [], "naming none of them, any of them: the rule, not a shortcut");
  // "makes a number of Rend attacks equal to half this spell's level": its Rend's own pool, of that size.
  const render = convertActor({...ogre, _id: "testSpirit000002", name: "Test Rending Spirit", items: [attack("rend000000000001", "Rend"),
    attack("bite000000000001", "Bite"), {_id: "multiattack00005", name: "Multiattack", type: "feat", system: {source: SRD, description: {value:
      "<p>The spirit makes a number of Rend attacks equal to half this spell’s level (round down).</p>"}, activities: {a: activity("utility")}}}]}).actor;
  const rending = render.items.find(item => item.name === "Multiattack");
  assert.deepEqual([rending.system.definition.restores, rending.system.ruleElements.at(-1).data.maximum.numerator.path, rending.flags.wildpath.conversion.notes],
    [[{resourceId: "multiattack-rend", amount: 4}], "actor.flags.wildpath.summonLevel", []]);
  assert.deepEqual(render.items.find(item => item.name === "Bite").system.definition.costs, {allOf: [{capability: "action", amount: 1}]},
    "an attack it does not name");

  // "...and uses Constrict. It can replace the Claw attack with a use of Fire Breath."
  const save = (id, name, extra={}, consumption={targets: []}) => ({_id: id, name, type: "feat", system: {source: SRD, ...extra,
    activities: {a: activity("save", {save: {ability: ["str"], dc: {calculation: "str"}}, damage: {onSave: "none", parts: []}, consumption})}}});
  const chimera = {_id: "testChimera00001", name: "Test Chimera", type: "npc", system: {source: SRD, details: {cr: 6},
    abilities: {str: {value: 19}}, attributes: {hp: {max: 114}, movement: {walk: "30"}}, traits: {size: "lg"}},
    items: [attack("bite000000000001", "Bite"), attack("claw000000000001", "Claw"), save("constrict0000001", "Constrict"),
      save("firebreath000001", "Fire Breath", {uses: {max: "1", recovery: [{period: "recharge", formula: "5"}]}},
        {targets: [{type: "itemUses", value: "1"}]}),
      {_id: "multiattack00003", name: "Multiattack", type: "feat", system: {source: SRD, description: {value: "<p>The chimera makes one Bite "
        + "attack and one Claw attack and uses Constrict. It can replace the Claw attack with a use of Fire Breath.</p>"},
        activities: {a: activity("utility")}}}]};
  const beast = convertActor(chimera).actor;
  const named = name => beast.items.find(item => item.name === name);
  assert.deepEqual(named("Multiattack").system.definition.restores.map(entry => [entry.resourceId, entry.amount]), [["multiattack-bite", 1],
    ["multiattack-claw", 1], ["multiattack-constrict", 1], ["multiattack-replace", 1]]);
  assert.deepEqual(named("Multiattack").flags.wildpath.conversion.notes, [], "nothing left by hand");
  assert.deepEqual(named("Constrict").system.definition.costs.anyOf.map(option => option.map(cost => cost.capability)),
    [["multiattack-constrict"], ["action"]], "the Action it uses besides its attacks");
  assert.deepEqual(named("Fire Breath").system.definition.costs.anyOf.map(option => option.map(cost => cost.capability)),
    [["multiattack-replace", "multiattack-claw", "fire-breath"], ["action", "fire-breath"]],
    "instead of the Claw attack, still spending its own use");
  for ( const item of ["Multiattack", "Constrict", "Fire Breath"] ) valid(named(item));
});

test("forced movement (G6): a failed save pushes, a hit pulls, with any size limit; text with two distances is left", () => {
  const withText = (document, text) => ({...document, system: {...document.system, description: {value: `<p>${text}</p>`}}});
  const wave = convertItem(withText(burst, "On a failed save, a creature takes damage and is pushed 10 feet away from you. "
    + "Unsecured objects are pushed 10 feet away from you.")).items[0];
  valid(wave);
  assert.deepEqual(wave.system.definition.push, {distance: 10});
  const harpoon = convertItem(withText(bolt, "If the target is a Large or smaller creature, the merrow pulls the target up to "
    + "20 feet straight toward itself.")).items[0];
  valid(harpoon);
  assert.deepEqual(harpoon.system.definition.push, {distance: 20, toward: true, maxSize: "large"});
  assert.equal(convertItem(withText(bolt, "It is pushed 10 feet away from you, or pushed 20 feet away from you.")).items[0]
    .system.definition.push, undefined, "two distances");
  assert.equal(convertItem(withText(mend, "It is pushed 10 feet away from you.")).items[0].system.definition.push, undefined,
    "nothing decides it");
  assert.equal(convertItem(withText(burst, "A creature within 25 feet of the whirlpool is pulled 10 feet toward it.")).items[0]
    .system.definition.push, undefined, "toward something else");
  assert.deepEqual(convertItem(withText(burst, "Failure: 19 Bludgeoning damage, and the target has the Prone condition. "
    + "Success: Half damage, and the target is pushed 5 feet straight away from the bulette.")).items[0].system.definition.push,
  {distance: 5, on: "success"}, "pushed on a success");
  assert.equal(validateActionDefinition({...wave.system.definition, push: {distance: 0}}).ok, false);
  assert.equal(validateActionDefinition({...wave.system.definition, push: {distance: 5, maxSize: "big"}}).ok, false);
});

test("equipment is gear (G7): armor's AC by kind, a Shield's bonus, worn magic items' rules, and spells cast from items", () => {
  const armor = (name, type, armorData, extra={}) => ({_id: `test${name.replace(/\W/g, "")}`.padEnd(16, "0").slice(0, 16), name, type: "equipment",
    effects: [], system: {source: SRD, type: {value: type, baseItem: extra.baseItem ?? ""}, armor: {value: null, magicalBonus: null, dex: null,
      ...armorData}, strength: extra.strength ?? null, properties: extra.properties ?? [], weight: {value: 20, units: "lb"}, quantity: 1,
      activities: {}}});
  const gear = document => { const [item] = convertItem(document).items; assert.equal(item.type, "gear", document.name); return item; };
  const plate = gear(armor("Test Plate", "heavy", {value: 18, dex: 0}, {strength: 15, properties: ["stealthDisadvantage"]}));
  assert.equal(plate.system.active, false, "carried, not worn, until equipped");
  assert.deepEqual(plate.system.ruleElements.map(rule => [rule.type, rule.data.value ?? rule.data.valueExpression ?? rule.data.mode]), [
    ["ArmorClass", 18], ["Modifier", {type: "table", key: {type: "ability-score", ability: "might"}, rows: {0: -10, 15: 0}}],
    ["RollMode", "disadvantage"]]);
  assert.equal(plate.system.ruleElements[0].data.armor, true);
  const agility = {type: "ability-modifier", ability: "agility"};
  assert.deepEqual(gear(armor("Test Breastplate", "medium", {value: 14, dex: 2})).system.ruleElements[0].data.value,
    {type: "add", terms: [{type: "constant", value: 14}, {type: "min", terms: [agility, {type: "constant", value: 2}]}]});
  assert.deepEqual(gear(armor("Test Leather", "light", {value: 11, magicalBonus: 1})).system.ruleElements[0].data.value,
    {type: "add", terms: [{type: "constant", value: 12}, agility]}, "+1 light armor: 12 + Agility");
  assert.deepEqual(gear(armor("Test Dwarven", "", {value: 18, magicalBonus: 2}, {baseItem: "plate"})).system.ruleElements[0].data.value, 20,
    "magic armor that names only its base armor");
  assert.deepEqual(gear(armor("Test Shield", "shield", {value: 2})).system.ruleElements.map(rule => [rule.type, rule.data.domains, rule.data.value]),
    [["Modifier", ["defense.ac"], 2]]);
  const any = convertItem(armor("Test Armor +1", "", {})).items[0];
  assert.deepEqual(any.system.ruleElements, []);

  const cloak = {...armor("Test Cloak", "wondrous", {}), effects: [{_id: "cloak", name: "Cloak", transfer: true, disabled: false,
    system: {changes: [{key: "system.attributes.ac.bonus", value: "1", type: "add"}, {key: "system.bonuses.abilities.save", value: "1", type: "add"}]}},
    {_id: "variant", name: "Variant", transfer: true, disabled: true, system: {changes: [{key: "system.attributes.ac.bonus", value: "3", type: "add"}]}}]};
  assert.deepEqual(gear(cloak).system.ruleElements.map(rule => [rule.data.domains, rule.data.value]), [[["defense.ac"], 1], [["save"], 1]],
    "its passive effects, never a disabled variant");
  assert.equal(gear(cloak).system.attunement, "");
  assert.equal(gear({...cloak, system: {...cloak.system, attunement: "required"}}).system.attunement, "required", "until attuned");

  const fireball = {...burst, _id: "testFireball0001", name: "Test Fireball"};
  const wand = {...armor("Test Wand", "wand", {}), system: {...armor("Test Wand", "wand", {}).system, uses: {max: "7", spent: 0, recovery: []},
    activities: {c: activity("cast", {spell: {uuid: "Compendium.dnd5e.spells24.Item.testFireball0001", level: "3", ability: "",
      challenge: {attack: null, save: 15, override: true}}, consumption: {targets: [{type: "itemUses", value: "1"}]}})}}};
  const converted = convertItem(wand, {spells: {testFireball0001: fireball}}).items;
  assert.deepEqual(converted.map(item => [item.type, item.name]), [["gear", "Test Wand"], ["action", "Test Wand: Test Fireball"]]);
  assert.deepEqual(converted[0].flags.wildpath.grants, [converted[1]._id], "its Actions come with it");
  assert.equal(plate.flags.wildpath.grants, undefined);
  valid(converted[1]);
  assert.deepEqual(converted[1].system.definition.save.dc, {value: 15}, "the item's own save DC");
  assert.deepEqual(converted[1].system.definition.costs.allOf.map(cost => cost.capability), ["action", "test-wand"], "a charge");
});

test("weapons (G7): a Versatile weapon's two-handed Action, and a magic weapon's bonus to its own attack and damage", () => {
  const items = convertItem(weapon).items;
  assert.deepEqual(items.map(item => item.name), ["Test Sword", "Test Sword (Two-Handed)"]);
  items.forEach(valid);
  assert.deepEqual(items.map(item => item.system.definition.damage[0].expression.faces), [8, 10]);
  assert.notEqual(items[0]._id, items[1]._id);
  const spear = {...weapon, system: {...weapon.system, damage: {base: {number: 1, denomination: 6, types: ["piercing"], bonus: ""},
    versatile: {number: null, denomination: 0}}}};
  assert.equal(convertItem(spear).items[1].system.definition.damage[0].expression.faces, 8, "no die given: one larger");
  const magic = {...weapon, system: {...weapon.system, properties: [], magicalBonus: 2}};
  const [sword] = convertItem(magic).items;
  assert.deepEqual(sword.system.ruleElements.map(rule => [rule.type, rule.data.domains, rule.data.value]),
    [["Modifier", ["attack"], 2], ["Modifier", ["damage"], 2]], "an Action's own Modifiers count for it alone");
  assert.deepEqual(sword.flags.wildpath.conversion.notes, []);
});

test("classes, subclasses, species and backgrounds (G8): their fields and what each level gives", async () => {
  const {convertProgression, traitKey} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  assert.deepEqual(["skills:ath", "skills:*", "saves:con", "armor:hvy", "weapon:mar", "tool:art:calligrapher", "languages:standard:*"]
    .map(key => traitKey(key)), ["skills:athletics", "skills:*", "saves:fortitude", "armor:heavy", "weapons:martial", "tools:calligrapher", "languages:standard:*"]);
  assert.deepEqual(["languages:standard:elvish", "languages:exotic:primordial:aquan", "languages:exotic:*", "languages:*"]
    .map(key => traitKey(key)), ["languages:elvish", "languages:aquan", "languages:rare:*", "languages:*"]);
  assert.equal(traitKey("weapon:mar:*", {mastery: true}), "masteries:martial:*");
  const uuidOf = uuid => (uuid.endsWith("SecondWind") ? ["Compendium.wildpath.srd-items.Item.wind"] : []);
  const fighter = {_id: "testFighter00000", name: "Test Fighter", type: "class", system: {source: SRD, identifier: "fighter",
    hd: {denomination: "d10"}, spellcasting: {progression: "none", ability: ""}, advancement: {
      hp: {type: "HitPoints", configuration: {}},
      grant: {type: "ItemGrant", level: 1, title: "Class Features", configuration: {items: [{uuid: "Compendium.dnd5e.classes24.Item.SecondWind"},
        {uuid: "Compendium.dnd5e.classes24.Item.Missing"}]}},
      saves: {type: "Trait", level: 1, title: "Saves", classRestriction: "primary", configuration: {grants: ["saves:str", "saves:con"], choices: []}},
      skills: {type: "Trait", level: 1, title: "Skills", configuration: {grants: [], choices: [{count: 2, pool: ["skills:acr", "skills:ath"]}]}},
      asi: {type: "AbilityScoreImprovement", level: 4, configuration: {points: 2, cap: 2, locked: [], fixed: {}}},
      sub: {type: "Subclass", level: 3, configuration: {}},
      style: {type: "ItemChoice", title: "Fighting Style", configuration: {choices: {1: {count: 1}, 2: {count: null}},
        pool: [{uuid: "Compendium.dnd5e.classes24.Item.SecondWind"}]}}}}};
  const {item, notes} = convertProgression(fighter, {uuidOf});
  assert.deepEqual([item.type, item.system.identifier, item.system.hitDie, item.system.levels], ["class", "fighter", 10, 1]);
  assert.deepEqual(item.system.advancement.map(entry => [entry.level, entry.type]), [[1, "grant"], [1, "trait"], [1, "trait"], [4, "improvement"],
    [3, "subclass"], [1, "choice"]]);
  assert.deepEqual(item.system.advancement[0].items, ["Compendium.wildpath.srd-items.Item.wind"]);
  assert.deepEqual(item.system.advancement[1], {level: 1, title: "Saves", classRestriction: "primary", type: "trait",
    grants: ["saves:might", "saves:fortitude"], choices: []});
  assert.deepEqual(item.system.advancement[2].choices, [{count: 2, pool: ["skills:acrobatics", "skills:athletics"]}]);
  assert.equal(item.system.advancement[3].feat, true, "a class's ability increase may be a feat instead");
  assert.deepEqual(notes, ["grant: Missing was not converted"]);
  const background = {_id: "testBackground00", name: "Test Acolyte", type: "background", system: {source: SRD, advancement: {
    asi: {type: "AbilityScoreImprovement", level: 0, configuration: {points: 3, cap: 2, locked: ["str", "dex", "con"], fixed: {}}}}}};
  assert.deepEqual(convertProgression(background, {uuidOf}).item.system.advancement[0], {level: 0, title: null, type: "improvement", points: 3,
    cap: 2, abilities: ["intellect", "wits", "presence"], fixed: {}, feat: false});
  const species = {_id: "testSpecies00000", name: "Test Human", type: "race", system: {source: SRD, advancement: {
    size: {type: "Size", level: 0, configuration: {sizes: ["sm", "med"]}}}}};
  assert.deepEqual([convertProgression(species, {uuidOf}).item.type, convertProgression(species, {uuidOf}).item.system.size], ["species", "medium"]);
});

test("house text: the Defense Fighting Style's +1 AC needs no armor, and says so", () => {
  const html = "<p>While you're wearing Light, Medium, or Heavy armor, you gain a +1 bonus to Armor Class.</p>"
    + "<section id=\"secret-x\" class=\"secret\"><p>Disable it when you are not wearing armor.</p></section>";
  const defense = {name: "Defense", type: "feat", system: {type: {value: "feat", subtype: "fightingStyle"}}};
  assert.equal(houseText(defense, html), "<p>You gain a +1 bonus to Armor Class.</p>");
  assert.equal(houseText({...defense, name: "Archery"}, html), html, "other features keep their text");
});

test("a weapon's kind: its base (WildPath's name), simple or martial, and its mastery", async () => {
  const {weaponOf} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  assert.deepEqual(weaponOf({type: "weapon", system: {type: {value: "simpleR", baseItem: "lightcrossbow"}, mastery: "slow"}}),
    {category: "simple", base: "light-crossbow", mastery: "slow"});
  assert.deepEqual(weaponOf({type: "weapon", system: {type: {value: "martialM", baseItem: ""}}}), {category: "martial"});
  assert.equal(weaponOf({type: "weapon", system: {type: {value: "natural"}}}), null, "a claw is no weapon to train with");
  assert.equal(weaponOf({type: "spell", system: {}}), null);
});

test("a class's prepared spells by level, carried forward between its scale's entries", async () => {
  const {preparedTable} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  const table = preparedTable({advancement: {a: {type: "ScaleValue", configuration: {identifier: "max-prepared",
    scale: {1: {value: 2}, 2: {value: 3}, 5: {value: 6}, 19: {value: 15}}}}}});
  assert.deepEqual(table.slice(0, 6), [2, 3, 3, 3, 6, 6]);
  assert.deepEqual([table.length, table[18], table[19]], [20, 15, 15]);
  assert.deepEqual(preparedTable({advancement: {}}), []);
});

test("a check activity is its user's own check: its ability or skill, and its DC", () => {
  assert.deepEqual(checkOf({ability: "dex", associated: [], dc: {formula: "15"}}), {ability: "agility", dc: {value: 15}}, "Thieves' Tools");
  assert.deepEqual(checkOf({ability: "", associated: "slt", dc: {formula: "20"}}), {skill: "sleight-of-hand", dc: {value: 20}},
    "Manacles, with one associated skill as a string");
  const notes = [];
  assert.deepEqual(checkOf({associated: ["ath", "acr"], dc: {formula: "13"}}, {notes}), {skill: "athletics", dc: {value: 13}});
  assert.match(notes[0], /a choice of ath\/acr uses ath/u);
  assert.equal(checkOf({ability: "str", dc: {}}, {notes}), null, "no DC");
});

test("a save with nothing converted on it still rolls: its consequences are the description's", () => {
  const command = {...burst, _id: "testCommand00001", name: "Test Command", system: {...burst.system, level: 1,
    activities: {a: activity("save", {save: {ability: "wis", dc: {calculation: "spellcasting", formula: ""}}, damage: {parts: []}})}}};
  const [item] = convertItem(command).items;
  assert.deepEqual([item.type, item.system.definition.save.ability, item.system.definition.damage ?? []], ["action", "wits", []]);
  assert.ok(item.flags.wildpath.conversion.notes.includes("rolled (save); what it does is by hand"));
});

test("2024 Speed multipliers: Haste doubles, Slow halves every Speed or one mode's, and 0 stops every Speed", async () => {
  const {effectRules} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  const multiplier = (value, type="multiply", key="system.attributes.movement.multiplier") => ({name: "Speed",
    system: {changes: [{key, value, type}]}});
  const [hasted] = effectRules(multiplier(2));
  assert.deepEqual([hasted.type, hasted.data.domains, hasted.data.value], ["Modifier", ["speed.multiplier"], 2]);
  assert.deepEqual(effectRules(multiplier(0.5, "multiply", "system.attributes.movement.fly"))[0].data,
    {domains: ["speed.fly.multiplier"], modifierType: "untyped", value: 0.5});
  assert.deepEqual(effectRules(multiplier(-10, "add", "system.attributes.movement.swim"))[0].data,
    {domains: ["speed.swim"], modifierType: "untyped", value: -10}, "Ray of Frost on a swimming Speed");
  assert.deepEqual(effectRules(multiplier(0, "override", "system.attributes.movement.climb"))[0].data.domains, ["speed.climb.multiplier"],
    "a mode set to 0 (Caltrops)");
  const notes = [];
  assert.deepEqual(effectRules(multiplier(0, "override"), notes).map(rule => [rule.type, rule.data.maximum]), [["ResourceCap", 0]]);
  assert.deepEqual(notes, []);
});

test("a damage bonus with dice is extra damage on each hit: its own type, or the attack's", async () => {
  const {effectRules} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  const favor = effectRules({name: "Divine Favor", system: {changes: [{key: "system.bonuses.mwak.damage", value: "1d4[radiant]", type: "add"}]}});
  assert.deepEqual(favor.map(rule => [rule.type, rule.data.domains, rule.data.damageType, rule.predicate]),
    [["ExtraDamage", ["damage.weapon"], "radiant", {tagsAny: ["melee"]}]]);
  const notes = [];
  const reduced = effectRules({name: "Reduced", system: {changes: [{key: "system.bonuses.rwak.damage", value: "- 1d4", type: "add"}]}}, notes);
  assert.deepEqual([reduced.length, notes.length], [0, 1], "a penalty in dice is left for the GM");
});

test("spell effects dnd5e leaves empty take their 2024 rules by hand: Blur, even with no effect named", () => {
  const blur = {_id: "testBlur00000001", name: "Blur", type: "spell", img: "systems/dnd5e/icons/spell.webp",
    effects: [{_id: "blurred", name: "Blurred", transfer: false, system: {changes: []}, duration: {value: 60, units: "seconds"}}],
    system: {source: SRD, identifier: "blur", level: 2, preparation: {mode: "prepared"}, properties: ["vocal", "concentration"],
      activation: {type: "action"}, range: {units: "self"}, target: {affects: {type: "self"}, template: {}},
      activities: {a: activity("utility", {effects: []})}}};
  const [item] = convertItem(blur).items;
  const [effect] = item.system.definition.effects;
  assert.deepEqual([effect.name, effect.concentration, effect.ruleElements[0].data], ["Blurred", true, {domains: ["attacked"], mode: "disadvantage"}]);
  assert.deepEqual(item.flags.wildpath.conversion.notes, []);
});

test("an area that keeps acting by its 2024 wording becomes a lasting area repeating its save on a creature", () => {
  const definition = {id: "action:moonbeam", label: "Moonbeam", targeting: {type: "area"}, area: {shape: "radial", size: {value: 5, unit: "ft"}},
    save: {ability: "fortitude", dc: {value: 15}}, damage: [{id: "damage-1", expression: {type: "dice", number: 2, faces: 10},
      damageType: "radiant", saveOutcomePolicy: {success: "half", failure: "full"}}],
    effects: [{id: "effect-1", type: "condition", conditionId: "blinded", concentration: true}]};
  const spell = (text, duration={value: 1, units: "minute"}) => ({document: {name: "Moonbeam", system: {description: {value: text}}},
    system: {duration, properties: ["concentration"]}, definition});
  const lasting = lastingArea(spell("<p>A creature also makes this save when it enters the spell's area or ends its turn there.</p>"));
  const {duration, concentration, triggers: [trigger], affects} = lasting.area.persistence;
  assert.deepEqual([duration, concentration, trigger.on, affects], [{unit: "round", value: 10}, true, ["area.entered", "turn.ended"], undefined]);
  assert.deepEqual([trigger.action.save, trigger.action.damage.length, trigger.action.effects[0].concentration, trigger.action.costs],
    [definition.save, 1, undefined, {allOf: []}], "the same save and damage; the area holds the concentration");
  assert.equal(validateActionDefinition(lasting).ok, true);
  const guardians = lastingArea(spell("Whenever an enemy you can see enters the Emanation or ends its turn there, it makes a save."));
  assert.equal(guardians.area.persistence.affects, "enemies");
  assert.deepEqual(lastingArea(spell("The first time a creature enters the webs on a turn or starts its turn there, it saves."))
    .area.persistence.triggers[0].on, ["area.entered", "turn.started"]);
  assert.equal(lastingArea(spell("It burns when a creature enters it or ends its turn there.", {})), null, "no duration (Oil)");
  assert.equal(lastingArea(spell("Each creature in the area makes a save.")), null, "no repeating wording");
});

test("a lasting area its caster may move gets a Move Action: that action's cost and how far", () => {
  const moonbeam = {name: "Moonbeam", system: {description: {value: "<p>Until the spell ends, Dim Light fills the Cylinder, and you can take a "
    + "Magic action on later turns to move the Cylinder up to 60 feet.</p>"}}};
  const definition = {id: "action:moonbeam", area: {shape: "radial", persistence: {duration: {unit: "round", value: 10}}}};
  const move = moveAreaDefinition(moonbeam, definition);
  assert.deepEqual([move.costs.allOf[0].capability, move.moveArea, move.targeting.type], ["action", {of: "action:moonbeam", distance: 60}, "none"]);
  assert.equal(validateActionDefinition(move).ok, true);
  assert.equal(moveAreaDefinition(moonbeam, {id: "action:x", area: {shape: "radial"}}), null, "not a lasting area");
  assert.equal(validateActionDefinition({...move, moveArea: {of: "", distance: 60}}).ok, false);
});

test("a follow-up attack of a spell is at the level the spell was cast, answered by the authority, never asked", async () => {
  const blade = {_id: "testFlameBlade01", name: "Test Blade", type: "spell", img: "systems/dnd5e/icons/spell.webp", effects: [],
    system: {source: SRD, identifier: "test-blade", level: 2, preparation: {mode: "prepared"}, properties: ["vocal", "concentration"],
      activation: {type: "bonus"}, range: {units: "self"}, target: {affects: {}, template: {}},
      activities: {a: activity("utility", {name: "Evoke", consumption: {spellSlot: true}}),
        b: activity("attack", {name: "Slash", consumption: {spellSlot: false}, attack: {type: {value: "melee", classification: "spell"}},
          damage: {parts: [{number: 3, denomination: 6, bonus: "", types: ["fire"], scaling: {mode: "whole", number: 1}}]}})}}};
  const slash = convertItem(blade).items.find(item => item.name.includes("Slash"));
  const [choice] = slash.system.definition.configuration;
  assert.deepEqual([choice.id, choice.type, choice.fromCast, choice.options.map(option => option.value)],
    ["cast-level", "option", true, [2, 3, 4, 5, 6, 7, 8, 9]]);
  assert.deepEqual(choice.effects.map(effect => [effect.type, effect.levelChoiceId, effect.baseLevel]), [["scaleDamage", "cast-level", 2]]);
  assert.equal(validateActionDefinition(slash.system.definition).ok, true);
  const {castLevelChoices} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const action = {flags: {wildpath: {source: {id: "testFlameBlade01"}}}};
  assert.deepEqual(castLevelChoices(slash.system.definition, action, {flags: {wildpath: {castLevels: {testFlameBlade01: 4}}}}), {"cast-level": 4});
  assert.deepEqual(castLevelChoices(slash.system.definition, action, {flags: {}}), {"cast-level": 2}, "never cast: its own level");
  assert.equal(castLevelChoices({configuration: []}, action, {}), null);
});

test("Hunter's Mark and Hex mark their target: extra damage on the caster's hits, Hex's one chosen ability, no slot to move it", () => {
  const spell = (id, name, effects, activities) => ({_id: id, name, type: "spell", img: "systems/dnd5e/icons/spell.webp", effects,
    system: {source: SRD, identifier: name === "Hex" ? "hex" : "hunters-mark", level: 1, preparation: {mode: "prepared"},
      properties: ["vocal", "concentration"], activation: {type: "bonus"}, range: {units: "ft", value: 90},
      target: {affects: {type: "creature", count: 1}, template: {}}, activities}});
  const markEffect = {_id: "mark", name: "Hunter's Mark", transfer: false, statuses: ["marked"], system: {changes: []},
    duration: {value: 3600, units: "seconds"}};
  const markTarget = {affects: {type: "creature", count: 1}, template: {}};
  const hunters = convertItem(spell("testHuntersMark1", "Hunter's Mark", [markEffect], {
    a: activity("utility", {name: "Mark Creature", target: markTarget, effects: [{_id: "mark"}], consumption: {spellSlot: true}}),
    b: activity("utility", {name: "Move Mark", target: markTarget, effects: [{_id: "mark"}], consumption: {spellSlot: false}})})).items;
  const [mark, move] = hunters;
  const [effect] = mark.system.definition.effects;
  assert.deepEqual([effect.slug, effect.concentration, effect.ruleElements[0].type, effect.ruleElements[0].data.damageType,
    effect.ruleElements[0].predicate], ["hunters-mark", true, "ExtraDamage", "force", {equals: {path: "attack.fromAttacker.hunters-mark", value: true}}]);
  assert.equal(mark.system.definition.configuration?.length, 1, "marking spends a slot");
  assert.equal(move.system.definition.configuration, undefined, "moving the mark spends none");
  assert.deepEqual([mark.system.definition.metadata?.followUp, move.system.definition.metadata?.followUp], [undefined, true],
    "moving the mark continues its concentration");
  assert.deepEqual(mark.flags.wildpath.conversion.notes, []);
  assert.equal(validateActionDefinition(mark.system.definition).ok, true);

  const hexed = (id, name, key) => ({_id: id, name, transfer: false, statuses: ["cursed"], duration: {value: 3600, units: "seconds"},
    system: {changes: [{key: `system.abilities.${key}.check.roll.mode`, value: -1, type: "add"}]}});
  const [hex] = convertItem(spell("testHex000000001", "Hex", [hexed("s", "Hexed Strength", "str"), hexed("d", "Hexed Dexterity", "dex")], {
    a: activity("utility", {name: "Place Curse", target: markTarget, effects: [{_id: "s"}, {_id: "d"}]})})).items;
  const {effects, configuration} = hex.system.definition;
  assert.deepEqual(effects.map(entry => [entry.slug, entry.ruleElements.map(rule => rule.type)]),
    [["hex", ["RollMode", "ExtraDamage"]], ["hex", ["RollMode", "ExtraDamage"]]]);
  const choice = configuration.find(entry => entry.id === "effect-choice");
  assert.deepEqual([choice.type, choice.label, choice.options.map(option => option.label), choice.effects[0]],
    ["option", "Ability", ["Hexed Strength", "Hexed Dexterity"], {type: "keepEffect", effectIds: ["effect-1", "effect-2"],
      keep: {"effect-option-1": ["effect-1"], "effect-option-2": ["effect-2"]}}]);
  assert.equal(validateActionDefinition(hex.system.definition).ok, true);
});

test("ability score changes become AbilityScore rules: a Belt's at-least, an Ioun Stone's +2 to 20, a Tome's +2 to 30", async () => {
  const {effectRules} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  const effect = (name, changes) => ({name, changes: changes.map(([key, type, value]) => ({key, type, value}))});
  const notes = [];
  const rules = [
    ...effectRules(effect("Headband", [["system.abilities.int.value", "upgrade", 19]]), notes),
    ...effectRules(effect("Ioun Stone", [["system.abilities.str.value", "add", 2], ["system.abilities.str.value", "downgrade", 20]]), notes),
    ...effectRules(effect("Tome", [["system.abilities.wis.value", "add", 2], ["system.abilities.wis.max", "upgrade", 30]]), notes),
    ...effectRules(effect("Wish", [["system.abilities.str.value", "downgrade", 3]]), notes)];
  assert.deepEqual(rules.map(rule => [rule.type, rule.data]), [
    ["AbilityScore", {ability: "intellect", mode: "upgrade", value: 19}],
    ["AbilityScore", {ability: "might", mode: "add", value: 2, maximum: 20}],
    ["AbilityScore", {ability: "wits", mode: "add", value: 2, maximum: 30}],
    ["AbilityScore", {ability: "might", mode: "downgrade", value: 3}]]);
  assert.deepEqual(notes, []);
  effectRules(effect("Draining", [["system.abilities.str.value", "add", "-1d4"]]), notes);
  assert.equal(notes.length, 1, "a rolled change is left by hand");
});

test("an activity's several dnd5e effects are a choice of one: Blindness or Deafness, never both", () => {
  const blindness = {_id: "testBlindDeaf001", name: "Blindness/Deafness", type: "spell", img: "systems/dnd5e/icons/spell.webp",
    effects: [{_id: "blind", name: "Blindness", transfer: false, statuses: ["blinded"], system: {changes: []}},
      {_id: "deaf", name: "Deafness", transfer: false, statuses: ["deafened"], system: {changes: []}}],
    system: {source: SRD, identifier: "blindness-deafness", level: 2, preparation: {mode: "prepared"}, properties: ["vocal"],
      activation: {type: "action"}, range: {units: "ft", value: 120}, target: {affects: {type: "creature", count: 1}, template: {}},
      activities: {a: activity("save", {save: {ability: ["con"], dc: {calculation: "spellcasting"}},
        effects: [{_id: "blind", onSave: false}, {_id: "deaf", onSave: false}]})}}};
  const [item] = convertItem(blindness).items;
  const {effects, configuration} = item.system.definition;
  assert.deepEqual(effects.map(entry => entry.conditionId), ["blinded", "deafened"]);
  const choice = configuration.find(entry => entry.id === "effect-choice");
  assert.deepEqual([choice.label, choice.options.map(option => option.label)], ["Effect", ["Blindness", "Deafness"]]);
  assert.deepEqual(choice.effects[0].keep, {"effect-option-1": ["effect-1"], "effect-option-2": ["effect-2"]});
  assert.equal(validateActionDefinition(item.system.definition).ok, true);
});

test("scale values of a species, a subclass and a class feature follow the right level (Breath Weapon, Land's Aid, Divine Spark)", () => {
  const scale = (identifier, kind, rows) => ({x: {type: "ScaleValue", title: identifier, configuration: {identifier, type: kind, scale: rows}}});
  const scales = scaleTables([
    {type: "race", name: "Dragonborn", system: {identifier: "dragonborn", advancement: scale("breath", "dice",
      {0: {number: 1, faces: 10}, 5: {number: 2, faces: 10}})}},
    {type: "subclass", name: "Circle of the Land", system: {identifier: "land", classIdentifier: "druid", advancement: scale("lands-aid", "dice",
      {3: {number: 2, faces: 6}})}},
    {type: "feat", name: "Channel Divinity", system: {identifier: "channel-divinity-cleric", requirements: "Cleric",
      advancement: scale("spark", "number", {2: {value: 1}, 7: {value: 2}})}}]);
  assert.deepEqual(formulaExpression("@scale.dragonborn.breath", {scales}).key, {type: "character-level"});
  assert.deepEqual(formulaExpression("@scale.dragonborn.breath", {scales}).rows[5], {type: "dice", number: 2, faces: 10});
  assert.deepEqual(formulaExpression("@scale.land.lands-aid", {scales}).key, {type: "class-level", class: "druid"});
  const spark = formulaExpression("(@scale.channel-divinity-cleric.spark)d8 + @abilities.wis.mod", {scales});
  assert.notEqual(spark, null, "Divine Spark's dice count by Cleric level");
  assert.deepEqual(JSON.stringify(spark).includes("\"class\":\"cleric\""), true);
  assert.deepEqual(Object.keys(scales["dragonborn.breath"]), ["0", "5"], "the level key is not a row");
  const {selectTableRows, evaluateValueExpression} = valueExpressions;
  const atCleric = level => ({classLevels: {cleric: level}, actorSystem: {abilities: {wits: {value: 14}}}});
  assert.deepEqual(selectTableRows(spark, atCleric(7)).terms[0], {type: "dice", number: 2, faces: 8}, "2d8 at Cleric 7");
  assert.equal(evaluateValueExpression({...spark.terms[0], evaluation: "average"}, atCleric(2)).value, 4.5, "1d8 at Cleric 2");
});

test("a damage part of several types is a choice when used (Breath Weapon's acid, cold, fire, lightning or poison)", () => {
  const breath = {_id: "testBreath000001", name: "Breath Weapon", type: "feat", img: "icons/svg/fire.svg", effects: [],
    system: {source: SRD, identifier: "breath-weapon", activation: {type: "action"}, range: {}, target: {affects: {}, template: {}},
      activities: {a: activity("save", {save: {ability: ["dex"], dc: {formula: "13"}},
        damage: {onSave: "half", parts: [{number: 1, denomination: 10, types: ["acid", "cold", "fire"]}]},
        target: {override: false, template: {type: "cone", size: "15", units: "ft"}, affects: {}}})}}};
  const [item] = convertItem(breath).items;
  const choice = item.system.definition.configuration.find(entry => entry.id === "damage-type-1");
  assert.deepEqual([choice.type, choice.allowedDamageTypes, choice.effects[0]], ["damage-type", ["acid", "cold", "fire"],
    {type: "replaceDamageType", componentIds: ["damage-1"], damageTypeChoiceId: "damage-type-1"}]);
  assert.equal(item.flags.wildpath.conversion.notes.some(note => /a choice of/.test(note)), false);
  assert.equal(validateActionDefinition(item.system.definition).ok, true);
});

test("hovering goes on the fly Speed its effect grants (Fly, a Potion of Flying)", async () => {
  const {effectRules} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  const notes = [];
  const fly = effectRules({name: "Flight", changes: [{key: "system.attributes.movement.fly", type: "upgrade", value: 60},
    {key: "system.attributes.movement.hover", type: "override", value: true}]}, notes);
  const potion = effectRules({name: "Flyer", changes: [{key: "system.attributes.movement.hover", type: "override", value: "true"},
    {key: "system.attributes.movement.fly", type: "upgrade", value: "@attributes.movement.walk"}]}, notes);
  assert.deepEqual([fly[0].data, potion[0].data.hover], [{mode: "fly", distance: 60, hover: true}, true]);
  assert.deepEqual(notes, []);
});

test("an activity that takes a common action is that action at its own cost (Cunning Action); a \"Disengaged\" effect is Disengage's", () => {
  const feature = (id, name, activities, effects=[]) => ({_id: id, name, type: "feat", img: "icons/svg/walk.svg", effects,
    system: {source: SRD, identifier: name.toLowerCase().replace(/\W+/g, "-"), activation: {type: "bonus"}, range: {},
      target: {affects: {}, template: {}}, activities}});
  const bonus = name => activity("utility", {_id: `act${name}`, name, activation: {type: "bonus", override: false}});
  const items = convertItem(feature("testCunningAct01", "Cunning Action", {a: bonus("Dash"), b: bonus("Disengage"), c: bonus("Hide")})).items;
  const [dash, disengage, hide] = items.map(item => item.system.definition);
  assert.deepEqual(items.map(item => item.system.definition.costs.allOf[0].capability), ["bonus-action", "bonus-action", "bonus-action"]);
  assert.equal(dash.effects[0].slug, "dashing");
  assert.equal(disengage.effects[0].slug, "disengaged");
  assert.deepEqual(hide.check, {ability: "agility", skill: "stealth", dc: {value: 15}});
  assert.deepEqual(items.map(item => item.flags.wildpath.conversion.notes), [[], [], []]);
  for ( const definition of [dash, disengage, hide] ) assert.equal(validateActionDefinition(definition).ok, true);

  const [step] = convertItem(feature("testStepOfWind01", "Step of the Wind", {a: activity("utility", {name: "Step of the Wind",
    activation: {type: "bonus", override: false}, effects: [{_id: "disengaged"}]})},
  [{_id: "disengaged", name: "Disengaged", transfer: false, statuses: [], system: {changes: []}}])).items;
  assert.equal(step.system.definition.effects[0].slug, "disengaged", "Step of the Wind's Disengaged is the common one");
  assert.deepEqual(step.flags.wildpath.conversion.notes, []);

  const focus = convertItem({...feature("testMonksFocus01", "Monk's Focus", {a: bonus("Patient Defense (Focus Point)"), b: bonus("Step of the Wind")},
    [{_id: "dodging", name: "Patient Defense (Focus Point)", transfer: false, statuses: ["dodging"], system: {changes: []}}]),
  system: {...feature("x", "x", {}).system, identifier: "monks-focus", activities: {a: bonus("Patient Defense (Focus Point)"), b: bonus("Step of the Wind")}}}).items;
  assert.deepEqual(focus.map(item => item.system.definition.effects.map(effect => effect.slug)), [["disengaged", "dodging"], ["disengaged", "dashing"]],
    "2024: with a Focus Point, Disengage and Dodge, or Disengage and Dash");
  assert.deepEqual(focus.map(item => item.flags.wildpath.conversion.notes), [[], []]);
  const [stealth] = convertItem({...feature("testShadowSteal1", "Shadow Stealth", {a: bonus("Expend Use")}), system: {...feature("x", "x", {}).system,
    identifier: "shadow-stealth", activities: {a: bonus("Expend Use")}}}).items;
  assert.deepEqual([stealth.system.definition.check.skill, stealth.system.definition.effects[0].id], ["stealth", "hidden"], "the Hide action");

  const nimble = convertItem({...feature("testNimbleEscap1", "Nimble Escape", {a: bonus("Expend Use")}), system: {...feature("x", "x", {}).system,
    identifier: "nimble-escape", activities: {a: bonus("Expend Use")}}}).items;
  assert.deepEqual(nimble.map(item => [item.name, item.system.definition.costs.allOf[0].capability, item.system.definition.effects[0].id,
    item.system.definition.check?.skill ?? null]),
  [["Nimble Escape (Disengage)", "bonus-action", "disengaged", null], ["Nimble Escape (Hide)", "bonus-action", "hidden", "stealth"]],
  "Disengage or Hide: an Action each, as a Bonus Action");
  assert.notEqual(nimble[0]._id, nimble[1]._id);
  const [hasten] = convertItem({...feature("testHasten000001", "Hasten", {a: bonus("Expend Use")}), system: {...feature("x", "x", {}).system,
    identifier: "hasten", activities: {a: bonus("Expend Use")}}}).items;
  assert.deepEqual(hasten.system.definition.effects.map(effect => effect.id), ["dashing", "disengaged"], "Dash and Disengage");
});

test("a grapple or restraint keeps its escape DC, from the Escape Check activity or \"escape DC 14\" in its text", () => {
  const grappled = {_id: "grappled", name: "Grappled", transfer: false, statuses: ["grappled"], system: {changes: []}};
  const restrained = {_id: "restrained", name: "Restrained", transfer: false, statuses: ["restrained"], system: {changes: []}};
  const strike = (id, name, effects, activities, text) => ({_id: id, name, type: "weapon", img: "icons/svg/net.svg", effects,
    system: {source: SRD, description: {value: text}, properties: [], range: {}, damage: {base: {number: 1, denomination: 6, types: ["bludgeoning"], bonus: ""}},
      activities}});
  const attack = effect => activity("attack", {range: {value: "5", units: "ft", override: false}, effects: [{_id: effect}],
    attack: {ability: "", bonus: "", type: {value: "melee", classification: "weapon"}}, damage: {includeBase: true, parts: []}});
  const [tentacle] = convertItem(strike("testTentacle0001", "Tentacle", [grappled], {a: attack("grappled")},
    "<p>The target has the Grappled condition (escape DC 14).</p>")).items;
  assert.deepEqual(tentacle.system.definition.effects.map(effect => [effect.conditionId, effect.metadata]), [["grappled", {escapeDC: 14}]]);

  const [net] = convertItem(strike("testNetEscape001", "Net", [restrained], {a: attack("restrained"),
    b: activity("check", {_id: "actescape", name: "Escape Check", check: {ability: "str", dc: {formula: "10"}}})}, "<p>Escape DC 99 is not it.</p>")).items;
  assert.deepEqual(net.system.definition.effects[0].metadata, {escapeDC: 10}, "its Escape Check's DC, before the text");
  assert.equal(validateActionDefinition(net.system.definition).ok, true);

  const passive = strike("testConstrict001", "Constrict", [grappled], {a: attack("grappled"), b: activity("check", {_id: "actescape",
    name: "Escape Check", check: {ability: "", dc: {calculation: "", formula: "@skills.ath.passive"}}})},
    "<p>It has the &amp;Reference[Grappled apply=false] condition (escape DC [[lookup @skills.ath.passive]]).</p>");
  const snake = {_id: "testSnake0000001", name: "Snake", type: "npc", img: "icons/svg/mystery-man.svg", items: [passive], effects: [],
    system: {source: SRD, abilities: {str: {value: 19}}, skills: {ath: {ability: "str", value: 1, bonuses: {passive: ""}}}, details: {cr: 2},
      attributes: {hp: {value: 30, max: 30}, ac: {flat: 12}, movement: {walk: 30}}, traits: {size: "lg"}}};
  const converted = convertActor({...snake, system: {...snake.system, skills: {...snake.system.skills, ste: {value: 2}, prc: {value: 0.5}},
    attributes: {...snake.system.attributes, init: {bonus: "@prof * 2"}}}}).actor;
  assert.deepEqual(converted.items.find(item => item.name === "Traits").system.ruleElements.find(rule => rule.id === "initiative").data,
    {domains: ["initiative"], modifierType: "untyped", valueExpression: {type: "multiply", terms: [{type: "proficiency-bonus"}, {type: "constant", value: 2}]}},
    "2024 Initiative: twice its proficiency, beyond Agility");
  assert.deepEqual(converted.system.skills, {athletics: {proficiency: 1}, stealth: {proficiency: 2}}, "its skills; half proficiency is none");
  const constrict = convertActor(snake).actor.items.find(item => item.name.startsWith("Constrict"));
  assert.deepEqual(constrict.system.definition.effects[0].metadata, {escapeDC: 10 + 4 + 2}, "its passive Athletics");
});

test("an effect with nothing WildPath maps still marks its creature, for its duration and concentration (Alter Self)", () => {
  const alter = {_id: "testAlterSelf001", name: "Alter Self", type: "spell", img: "systems/dnd5e/icons/spell.webp",
    effects: [{_id: "altered", name: "Aquatic Adaptation", img: "icons/svg/water.svg", transfer: false, statuses: [], duration: {value: 1, units: "hours"},
      system: {changes: [{key: "flags.dnd5e.unknownTrait", mode: 2, value: "1"}]}}],
    system: {source: SRD, identifier: "alter-self", level: 2, preparation: {mode: "prepared"}, properties: ["vocal", "concentration"],
      activation: {type: "action"}, range: {units: "self"}, target: {affects: {type: "self"}, template: {}},
      activities: {a: activity("utility", {effects: [{_id: "altered"}]})}}};
  const [spell] = convertItem(alter).items;
  const [marker] = spell.system.definition.effects;
  assert.deepEqual([marker.type, marker.name, marker.img, marker.ruleElements, marker.concentration], ["effect", "Aquatic Adaptation",
    "icons/svg/water.svg", [], true]);
  assert.ok(marker.duration, "its own duration");
  assert.ok(spell.flags.wildpath.conversion.notes.some(note => /marks its creature only/.test(note)));
  assert.equal(spell.flags.wildpath.conversion.notes.some(note => /concentration: nothing/.test(note)), false);
  assert.equal(validateActionDefinition(spell.system.definition).ok, true);
});

test("a feature used as its creature hits, by its text, is offered on its own hits (a maneuver; once a turn when it says)", () => {
  const feature = (id, name, text, condition) => ({_id: id, name, type: "feat", effects: [], system: {source: SRD, description: {value: text},
    activities: {a: activity("damage", {activation: {type: "", condition, override: false}, range: {units: "self", override: false},
      damage: {parts: [{number: 1, denomination: 8, types: ["force"], bonus: ""}]}})}}});
  const [trip] = convertItem(feature("testTripAttack01", "Trip Attack", "<p>When you hit a creature with an attack roll using a weapon, you "
    + "can expend one Superiority Die.</p>", "When you hit a creature with an attack roll")).items;
  assert.equal(trip.type, "action");
  assert.equal(trip.flags.wildpath.conversion.notes.some(note => /passive or triggered/.test(note)), false);
  const [foe] = convertItem(feature("testFavoredFoe01", "Favored Foe", "<p>Once on each of your turns when you hit a creature with a weapon, "
    + "you can deal an extra 1d8.</p>", "")).items;
  assert.equal(foe.type, "action");
  const all = ["acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic", "radiant", "slashing",
    "thunder"];
  const menacing = feature("testMenacing0001", "Menacing Attack", "<p>When you hit a creature with an attack roll, add the die to the "
    + "attack's damage roll.</p>", "");
  menacing.system.activities.a.damage.parts[0].types = all;
  const [menace] = convertItem(menacing).items;
  assert.deepEqual([menace.system.definition.damage, menace.system.definition.rider.damage.map(component => component.damageType)],
    [[], [undefined]], "any type: the attack's own, as a rider");
  assert.equal(menace.flags.wildpath.conversion.notes.some(note => /a choice of/.test(note)), false);
  const [still] = convertItem(feature("testPassive00001", "Thick Hide", "<p>It has resistance.</p>", "")).items;
  assert.ok(still.flags.wildpath.conversion.notes.some(note => /passive or triggered/.test(note)), "nothing about a hit");
});

test("a magic item template enchants an Item of its kind: a choice of its options, each with the effects it brings (Armor of Resistance)", () => {
  const option = (id, type) => ({_id: id, name: `Armor of ${type} Resistance`, type: "enchantment",
    system: {changes: [{key: "name", value: `{} of ${type} Resistance`, type: "override"}]}});
  const rider = (id, type) => ({_id: id, name: `${type} Resistance`, system: {changes: [{key: "system.traits.dr.value", value: type.toLowerCase(), type: "add"}]}});
  const armor = {_id: "testArmorResist1", name: "Armor of Resistance", type: "equipment", system: {source: SRD, description: {value: ""},
    activities: {a: activity("enchant", {effects: [{_id: "acid", riders: {effect: ["acidr"]}}, {_id: "fire", riders: {effect: ["firer"]}}]})}},
    effects: [option("acid", "Acid"), option("fire", "Fire"), rider("acidr", "Acid"), rider("firer", "Fire")]};
  const enchant = convertItem(armor).items.find(item => item.type === "action").system.definition;
  assert.deepEqual(enchant.configuration.map(choice => [choice.id, choice.optionsFrom?.kinds ?? choice.options.map(entry => entry.value)]),
    [["item", ["armor", "shield"]], ["enchantment", ["0", "1"]]]);
  assert.deepEqual(enchant.enchant.effects.map(effect => effect.ruleElements.map(rule => rule.data.damageTypes)), [[["acid"]], [["fire"]]]);
  assert.equal(enchant.enchant.optionChoiceId, "enchantment");
});

test("a trap's tier is an Action that sets it: a lasting 5-foot square anywhere that springs on each creature entering it", () => {
  const roof = {_id: "testTrapRoof0001", name: "Collapsing Roof", type: "equipment", effects: [], system: {source: SRD,
    description: {value: "<p>Deadly Trap.</p>"}, activities: {a: activity("save", {name: "Trigger (5-10)", activation: {type: "", override: false},
      save: {ability: ["dex"], dc: {calculation: "", formula: "15"}}, damage: {parts: [{number: 4, denomination: 10, types: ["bludgeoning"], bonus: ""}]}})}}};
  const tier = convertItem(roof).items.find(item => item.type === "action");
  const {area, targeting, range, costs} = tier.system.definition;
  assert.deepEqual([targeting, range, costs, area.shape, area.size.value, area.persistence.duration], [{type: "area"}, {type: "special"},
    {allOf: []}, "cube", 5, null]);
  const [sprung] = area.persistence.triggers;
  assert.deepEqual([sprung.on, sprung.action.label, sprung.action.save.dc, sprung.action.damage[0].damageType],
    [["area.entered"], "Collapsing Roof", {value: 15}, "bludgeoning"]);
  assert.equal(validateActionDefinition(tier.system.definition).ok, true);
  assert.deepEqual(tier.flags.wildpath.conversion.notes, []);
});

test("a summon's creature by its id, an old id a module redirects, or a PHB appendix id by its name", () => {
  const creatures = withRedirects({mmGriffon0000000: "griffon", mmWeasel00000000: "weasel", mmGiantCentipede: "centipede"},
    'CONFIG.compendium.uuidRedirects["Compendium.dnd-dungeon-masters-guide.actors.Actor.h052EIIUmRwJum65"] = "Compendium.dnd5e.actors24.Actor.mmGriffon0000000";');
  assert.equal(creatureRef(creatures, "Compendium.dnd5e.actors24.Actor.mmGriffon0000000"), "griffon");
  assert.equal(creatureRef(creatures, "Compendium.dnd5e.actors24.Actor.h052EIIUmRwJum65"), "griffon", "redirected");
  assert.equal(creatureRef(creatures, "Compendium.dnd5e.actors24.Actor.phbmobWeasel0000"), "weasel", "by name");
  assert.equal(creatureRef(creatures, "Compendium.dnd5e.actors24.Actor.phbmobGiantCenti"), "centipede", "a name cut short");
  assert.equal(creatureRef(creatures, "Compendium.dnd5e.monsters.Actor.OBujQLLPSmlJiZnL"), null, "a random id it does not know");
  assert.equal(creatureRef(withRedirects(creatures, {zzz: "mmGriffon0000000"}), "x.zzz"), "griffon", "a plain id map");
});

test("what a creature does around itself at a turn boundary is an automatic Emanation Trigger (Fire Aura, Fear Aura)", () => {
  const passive = (id, name, text, data, effects=[]) => ({_id: id, name, type: "feat", effects, system: {source: SRD,
    description: {value: text}, activities: {a: activity(data.save ? "save" : "damage", {activation: {type: "", override: false},
      range: {units: "self", override: false}, ...data})}}});
  const [fire] = convertItem(passive("testFireAura0001", "Fire Aura", "<p>At the end of each of the azer's turns, each creature of the "
    + "azer's choice in a 5-foot Emanation originating from the azer takes 5 (1d10) Fire damage unless the azer has the Incapacitated condition.</p>",
    {target: {template: {type: "radius", size: "5"}, affects: {type: "creature"}, override: false},
      damage: {parts: [{number: 1, denomination: 10, types: ["fire"], bonus: ""}]}})).items;
  const [burn] = fire.system.ruleElements;
  assert.deepEqual([burn.type, burn.data.event, burn.data.around, burn.data.predicate], ["Trigger", "turn.ended",
    {radius: 5, affects: "enemies"}, {missingCondition: "incapacitated"}]);
  assert.equal(burn.data.action.damage[0].damageType, "fire");
  assert.equal(fire.flags.wildpath.conversion.notes.some(note => /passive or triggered/.test(note)), false);

  const [fear] = convertItem(passive("testFearAura0001", "Fear Aura", "<p>The fiend emanates an aura in a 20-foot Emanation while it doesn't "
    + "have the Incapacitated condition.</p><p>Wisdom Saving Throw: DC 21, [[lookup @target.affects.special]].</p><p>Failure: The target "
    + "has the Frightened condition until the start of its next turn.</p><p>Success: The target is immune to this fiend's Fear Aura for 24 hours.</p>",
    {target: {template: {type: "radius", size: "20"}, affects: {type: "enemy", special: "any enemy that starts its turn in the aura"}, override: false},
      save: {ability: ["wis"], dc: {calculation: "", formula: "21"}}, damage: {parts: []}, effects: [{_id: "afraid", onSave: false}]},
    [{_id: "afraid", name: "Frightened", statuses: ["frightened"], duration: {value: 1, units: "turns", expiry: "turnStart"}}])).items;
  const [burst] = convertItem(passive("testDeathBurst01", "Death Burst", "<p>The mephit explodes [[lookup @activation.condition]].</p>",
    {activation: {type: "special", condition: "when it dies", override: false}, target: {template: {type: "radius", size: "5"},
      affects: {type: "creature"}, override: false}, save: {ability: ["dex"], dc: {calculation: "", formula: "11"}},
      damage: {parts: [{number: 2, denomination: 6, types: ["fire"], bonus: ""}]}})).items;
  assert.deepEqual([burst.system.ruleElements[0].data.event, burst.system.ruleElements[0].data.around], ["creature.died",
    {radius: 5, affects: "others"}], "as it dies");
  const [aura] = fear.system.ruleElements;
  assert.deepEqual([aura.data.event, aura.data.around, aura.data.predicate], ["turn.started",
    {radius: 20, affects: "enemies", on: "others"}, {missingCondition: "incapacitated"}]);
  const [frightened, immune] = aura.data.action.effects;
  assert.deepEqual([frightened.conditionId, frightened.duration], ["frightened", {value: 1, units: "turns", expiry: "turnStart"}],
    "until the start of its next turn");
  assert.deepEqual([immune.saveOutcomePolicy, immune.duration, immune.metadata.immuneTo], ["success", {value: 24, units: "hours"},
    aura.data.action.id]);
});

test("an empty effect known by its name gets its 2024 rules (Barkskin, a Morningstar's next attack, See Invisibility)", () => {
  // dnd5e's own changes for them do not convert (Barkskin's `system.attributes.ac.min`).
  const spell = (id, identifier, effect) => ({_id: id, name: effect, type: "spell", img: "systems/dnd5e/icons/spell.webp",
    effects: [{_id: "named", name: effect, transfer: false, statuses: [], duration: {value: 1, units: "hours"},
      system: {changes: [{key: "system.attributes.ac.min", value: 17, type: "upgrade"}]}}],
    system: {source: SRD, identifier, level: 2, preparation: {mode: "prepared"}, properties: ["vocal"], activation: {type: "action"},
      range: {units: "touch"}, target: {affects: {type: "creature", count: 1}, template: {}},
      activities: {a: activity("utility", {effects: [{_id: "named"}]})}}});
  const rulesOf = (id, identifier, effect) => {
    const [item] = convertItem(spell(id, identifier, effect)).items;
    assert.equal(item.flags.wildpath.conversion.notes.some(note => /marks its creature|not converted/.test(note)), false, effect);
    return item.system.definition.effects[0];
  };
  assert.deepEqual(rulesOf("testBarkskin0001", "barkskin", "Bark-like Skin").ruleElements[0].data, {value: 17, minimum: true});
  const next = rulesOf("testNextAttack01", "morningstar", "Next Attack: Disadv.");
  assert.deepEqual([next.endsWhen, next.ruleElements[0].data], ["attacks", {domains: ["attack"], mode: "disadvantage"}]);
  assert.deepEqual(rulesOf("testSeeInvisib01", "see-invisibility", "See Invisibility").ruleElements[0].data,
    {sense: "seeInvisibility", range: 5280});
  assert.deepEqual(rulesOf("testProtection01", "protection-from-evil-and-good", "Protected").ruleElements[0].predicate.oneOf.path,
    "attack.attackerType");
});

test("a save with nothing else converted: the conditions its text gives on a failure, else a marker while it lasts", () => {
  const spell = (id, name, text, extra={}) => ({_id: id, name, type: "spell", img: "systems/dnd5e/icons/spell.webp", effects: [],
    system: {source: SRD, identifier: name.toLowerCase().replace(/\W+/g, "-"), level: 1, preparation: {mode: "prepared"}, properties: ["vocal"],
      activation: {type: "action"}, range: {value: "60", units: "ft"}, target: {affects: {type: "creature", count: 1}, template: {}},
      description: {value: text}, duration: {value: "", units: "inst"}, ...extra,
      activities: {a: activity("save", {save: {ability: ["dex"], dc: {calculation: "spellcasting", formula: ""}}})}}});
  const [grease] = convertItem(spell("testGreaseSpell1", "Grease",
    "<p>Each creature in its area must succeed on a Dexterity saving throw or have the &amp;Reference[Prone apply=false] condition.</p>")).items;
  assert.deepEqual(grease.system.definition.effects.map(effect => [effect.conditionId, effect.saveOutcomePolicy]), [["prone", "failure"]]);
  assert.ok(grease.flags.wildpath.conversion.notes.some(note => /a failure gives prone/.test(note)));

  const [truth] = convertItem(spell("testZoneOfTruth1", "Zone of Truth", "<p>A creature that fails can't lie.</p>",
    {duration: {value: "10", units: "minute"}})).items;
  assert.deepEqual(truth.system.definition.effects.map(effect => [effect.type, effect.name, effect.duration, effect.saveOutcomePolicy, effect.ruleElements]),
    [["effect", "Zone of Truth", {value: 10, units: "minutes"}, "failure", []]]);
  assert.equal(validateActionDefinition(truth.system.definition).ok, true);

  const [counter] = convertItem(spell("testCounterspel1", "Counterspell", "<p>The creature's spell fails.</p>")).items;
  assert.equal(counter.system.definition.effects, undefined, "instantaneous: nothing to mark");
  const [orb] = convertItem(spell("testDragonOrb001", "Orb", "<p>On a failed save, the orb imposes the Charmed condition on you.</p>")).items;
  assert.equal(orb.system.definition.effects, undefined, "not a condition on its user");

  const [visage] = convertItem(spell("testVisage000001", "Horrifying Visage", "<p>Each non-undead creature within 60 feet that can see it "
    + "must succeed on a DC 13 Wisdom saving throw or be frightened for 1 minute.</p>")).items;
  assert.deepEqual(visage.system.definition.effects.map(effect => [effect.conditionId, effect.duration]), [["frightened", {value: 1, units: "minutes"}]],
    "2014 wording, and how long");
  const [gust] = convertItem(spell("testGustOfWind01", "Gust of Wind", "<p>Each creature in the Line must succeed on a Strength saving "
    + "throw or be pushed 15 feet away from you in a direction following the Line.</p>")).items;
  assert.deepEqual([gust.system.definition.effects, gust.system.definition.push.distance], [undefined, 15], "its push, no marker");
  const [scry] = convertItem(spell("testScrying00001", "Scrying", "<p>The target makes a Wisdom saving throw.</p>",
    {duration: {value: "10", units: "minute"}})).items;
  assert.ok(scry.flags.wildpath.conversion.notes.includes("save: a failure marks its creature (narrative)"));
});

test("Polymorph: a failed save transforms the creature into a Beast its caster chooses; a wand casting it keeps the choice", () => {
  const polymorph = {_id: "testPolymorph001", name: "Polymorph", type: "spell", img: "systems/dnd5e/icons/spell.webp", effects: [],
    system: {source: SRD, identifier: "polymorph", level: 4, preparation: {mode: "prepared"}, properties: ["vocal", "concentration"],
      activation: {type: "action"}, range: {value: "60", units: "ft"}, target: {affects: {type: "creature", count: 1}, template: {}},
      duration: {value: "1", units: "hour"}, activities: {a: activity("save", {save: {ability: ["wis"], dc: {calculation: "spellcasting", formula: ""}}})}}};
  const beasts = [{uuid: "Compendium.wildpath.srd-creatures.Actor.bear", name: "Brown Bear", cr: 1}];
  const [spell] = convertItem(polymorph, {beasts}).items;
  const {transform, configuration} = spell.system.definition;
  assert.deepEqual([transform.choiceId, transform.targets, transform.temporaryHealth, transform.concentration, transform.keepItemTypes],
    ["form", true, "form", true, []]);
  assert.deepEqual(configuration.find(choice => choice.id === "form").options, [{id: beasts[0].uuid, label: "Brown Bear (CR 1)"}]);
  assert.equal(validateActionDefinition(spell.system.definition).ok, true);
  assert.equal(convertItem(polymorph).items[0].system.definition.transform, undefined, "no Beasts to choose: a marker instead");

  const wand = {_id: "testWandPolymor1", name: "Wand of Polymorph", type: "wand", img: "icons/svg/wand.svg", effects: [],
    system: {source: SRD, identifier: "wand-of-polymorph", uses: {max: "7"}, activities: {a: activity("cast", {spell: {uuid: "Compendium.x.testPolymorph001"}})}}};
  const cast = convertItem(wand, {beasts, spells: {testPolymorph001: polymorph}}).items.find(item => item.type === "action");
  assert.deepEqual(cast?.system.definition.configuration?.map(choice => choice.id), ["form"], "no slot; its Beast choice stays");
  const charged = convertItem({...wand, system: {...wand.system, description: {value: "<p>You can expend 1 of its charges to cast Polymorph.</p>"}}},
    {beasts, spells: {testPolymorph001: polymorph}}).items.find(item => item.type === "action");
  assert.deepEqual(charged.system.definition.costs.allOf.map(cost => cost.capability), ["action", "wand-of-polymorph"],
    "its charge, from its text when dnd5e leaves it out");
});

test("reactions by their 2024 trigger: Shield and Parry when hit, Counterspell when a spell is declared", () => {
  const reactionSpell = (id, identifier, name, activities, extra={}) => ({_id: id, name, type: "spell", img: "systems/dnd5e/icons/spell.webp", effects: [],
    system: {source: SRD, identifier, level: 3, preparation: {mode: "prepared"}, properties: ["somatic"], activation: {type: "reaction"},
      range: {value: "60", units: "ft"}, target: {affects: {type: "creature", count: 1}, template: {}}, activities, ...extra}});
  const reacts = item => item.system.ruleElements.find(rule => rule.type === "Trigger")?.data;
  const [counter] = convertItem(reactionSpell("testCounterspl01", "counterspell", "Counterspell",
    {a: activity("save", {activation: {type: "reaction", override: false}, save: {ability: ["con"], dc: {calculation: "spellcasting", formula: ""}}})})).items;
  assert.deepEqual(reacts(counter), {kind: "reaction", event: "action.declared",
    match: {phase: "interrupt", tagsAll: ["spell"], notTagsAny: ["component:none"],
      notSourceTokenId: "{self}"}, triggerPredicate: {all: [{equals: {path: "toSource.{self}.sees", value: true}},
      {equals: {path: "toSource.{self}.hostile", value: true}}, {atMost: {path: "toSource.{self}.distance", value: 60}}]}},
    "another creature's spell, unless it has no component, a hostile one it sees within 60 feet, never its own");
  assert.ok(counter.system.definition.tags.includes("component:somatic"), "its own components are tags");
  const [silent] = convertItem(reactionSpell("testSilentSpel01", "silent", "Silent", {a: activity("utility", {})}, {properties: []})).items;
  assert.ok(silent.system.definition.tags.includes("component:none"), "no component: it can't be countered");
  assert.equal(counter.system.definition.counters, true);
  assert.equal(validateActionDefinition(counter.system.definition).ok, true);

  const parry = {_id: "testParry0000001", name: "Parry", type: "feat", img: "icons/svg/sword.svg", effects: [],
    system: {source: SRD, identifier: "parry", activation: {type: "reaction"}, range: {}, target: {affects: {}, template: {}},
      description: {value: "<p>It adds [[lookup @roll.formula]] to its AC against that attack.</p>"},
      activities: {a: activity("utility", {activation: {type: "reaction", override: false}, roll: {formula: "3"}})}}};
  const [guard] = convertItem(parry).items;
  assert.deepEqual(reacts(guard).match, {phase: "interrupt", targetTokenId: "{self}", tagsAny: ["melee"]}, "a melee attack on itself");
  assert.deepEqual([guard.system.definition.targeting, guard.system.definition.effects[0].endsWhen,
    guard.system.definition.effects[0].ruleElements[0].data], [{type: "self"}, "attacked",
    {domains: ["defense.ac"], modifierType: "untyped", value: 3}], "+3 AC on itself until that attack is over");
  assert.equal(validateActionDefinition(guard.system.definition).ok, true);

  const [dodge] = convertItem({...parry, _id: "testUncannyDodg1", name: "Uncanny Dodge", system: {...parry.system, identifier: "uncanny-dodge",
    description: {value: "<p>Halve the attack's damage against you.</p>"}}}).items;
  assert.deepEqual([reacts(dodge).event, dodge.system.definition.effects[0].ruleElements[0], dodge.system.definition.effects[0].endsWhen],
    ["attack.hit", {schemaVersion: 1, id: "halved", type: "GrantResistance", data: {damageTypes: []}}, "attacked"],
    "halving that attack's damage: resistance to all of it until the attack is over");
  const [rebuke] = convertItem(reactionSpell("testHellishRebk1", "hellish-rebuke", "Hellish Rebuke",
    {a: activity("save", {activation: {type: "reaction", override: false}, save: {ability: ["dex"], dc: {calculation: "spellcasting", formula: ""}},
      damage: {parts: [{number: 2, denomination: 10, types: ["fire"]}]}})})).items;
  assert.deepEqual(reacts(rebuke), {kind: "reaction", event: "damage.applied",
    match: {phase: "interrupt", targetTokenId: "{self}", notSourceTokenId: "{self}"}}, "damage to it, from another creature");
});

test("Command's five commands and Bestow Curse's curses: chosen when used, applied on a failed save", () => {
  const spell = (id, identifier, name, activities, effects=[], extra={}) => ({_id: id, name, type: "spell", img: "systems/dnd5e/icons/spell.webp", effects,
    system: {source: SRD, identifier, level: 1, preparation: {mode: "prepared"}, properties: ["vocal"], activation: {type: "action"},
      range: {value: "60", units: "ft"}, target: {affects: {type: "creature", count: 1}, template: {}}, duration: {value: "", units: "inst"},
      activities, ...extra}});
  const save = (data={}) => activity("save", {save: {ability: ["wis"], dc: {calculation: "spellcasting", formula: ""}}, ...data});
  const [command] = convertItem(spell("testCommandSpel1", "command", "Command", {a: save()})).items;
  const {effects, configuration} = command.system.definition;
  assert.deepEqual(configuration.find(choice => choice.id === "effect-choice").options.map(option => option.label),
    ["Approach", "Drop", "Flee", "Grovel", "Halt"]);
  assert.deepEqual(effects.find(effect => effect.conditionId).conditionId, "prone", "Grovel: Prone");
  assert.deepEqual(effects.at(-1).ruleElements[0].data, {resources: ["movement", "action", "bonus"], maximum: 0}, "Halt");
  // Approach, Drop and Flee are statuses the movement authority and the runtime enforce; their turn's caps.
  assert.deepEqual(effects.filter(effect => effect.slug).map(effect => [effect.slug, effect.ruleElements.flatMap(rule => rule.data.resources)]),
    [["commanded-approach", ["action", "bonus"]], ["commanded-drop", ["movement", "action", "bonus"]], ["commanded-flee", []]]);
  assert.equal(effects.filter(effect => (effect.name === "Commanded: Grovel")).length, 1, "Grovel ends its turn too");
  assert.ok(effects.every(effect => effect.saveOutcomePolicy === "failure"));
  assert.equal(validateActionDefinition(command.system.definition).ok, true);

  const cursed = name => ({_id: name, name, transfer: false, statuses: ["cursed"], system: {changes: []}});
  const curse = spell("testBestowCurse1", "bestow-curse", "Bestow Curse", {
    a: save({_id: "actattacks", name: "Curse Attacks", effects: [{_id: "attacks"}]}),
    b: save({_id: "actresilien", name: "Curse Resilience", effects: [{_id: "resilience"}]})}, [cursed("attacks"), cursed("resilience")],
  {properties: ["vocal", "concentration"], level: 3, duration: {value: "1", units: "minute"}});
  const [attacks, resilience] = convertItem(curse).items.map(item => item.system.definition.effects[0]);
  assert.deepEqual([attacks.slug, attacks.ruleElements[0].predicate, attacks.saveOutcomePolicy, attacks.concentration],
    ["cursed-attacks", {equals: {path: "attack.fromTarget.cursed-attacks", value: true}}, "failure", true],
    "Disadvantage on its attacks against its caster, on a failed save (dnd5e's onSave defaults to false)");
  assert.deepEqual(resilience.ruleElements[0].data.expression, {type: "dice", number: 1, faces: 8});
  assert.deepEqual([attacks.metadata.tags, resilience.metadata.tags], [["curse"], ["curse"]], "curses, for Remove Curse");

  const remove = spell("testRemoveCurse1", "remove-curse", "Remove Curse", {a: activity("utility")}, [], {level: 3, range: {units: "touch"}});
  const dispel = spell("testDispelMagic1", "dispel-magic", "Dispel Magic", {a: activity("utility")}, [], {level: 3, range: {value: "120", units: "ft"}});
  const [removing, dispelling] = [remove, dispel].map(document => convertItem(document).items[0].system.definition);
  assert.deepEqual([removing.ends, removing.targeting.count, removing.metadata.spellLevel], [{tags: ["curse"]}, 1, 3]);
  assert.deepEqual([dispelling.ends, dispelling.range.normal.value], [{spells: "slot"}, 120]);
  assert.equal(validateActionDefinition(dispelling).ok, true);
});

test("a save its 2024 text repeats at each of the creature's turns marks the effects it gives (Hold Person)", () => {
  const held = text => convertItem({...hold, _id: "testHoldRepeat01", system: {...hold.system, description: {value: text}}}).items[0]
    .system.definition.effects[0].repeatSave;
  assert.equal(held("<p>At the end of each of its turns, the target repeats the save, ending the spell on itself on a success.</p>"), "turnEnd");
  assert.equal(held("<p>It repeats the save at the start of each of its turns, ending the effect on itself on a success.</p>"), "turnStart");
  assert.equal(held("<p>It takes 21 Poison damage at the start of each of its turns, and it repeats the save at the end of each of its"
    + " turns, ending the effect on itself on a success.</p>"), "turnEnd", "a Pit Fiend's: the save is at the end");
  assert.equal(held("<p>The target repeats the save at the end of each of its turns.</p>"), undefined, "nothing ends on a success");
});

test("a paladin's auras are auras: Protection to saves, Courage and Devotion to conditions, for allies in range", () => {
  const feature = (id, identifier, name, effects=[]) => ({_id: id, name, type: "feat", img: "icons/svg/aura.svg", effects,
    system: {source: SRD, identifier, type: {value: "class"}, activities: {}}});
  const [protection] = convertItem(feature("testAuraProtect1", "aura-of-protection", "Aura of Protection", [{_id: "p", name: "Protected",
    transfer: true, statuses: [], changes: [{key: "system.bonuses.abilities.save", mode: 2, value: "@abilities.cha.mod"}]}])).items;
  const [aura] = protection.system.ruleElements;
  assert.deepEqual([aura.type, aura.data.affects, aura.data.radius.rows, aura.predicate], ["Aura", "allies", {1: 10, 18: 30},
    {missingCondition: "incapacitated"}]);
  assert.equal(protection.system.ruleElements.length, 1, "not its dnd5e effect, which gave the paladin alone the bonus");
  const [courage] = convertItem(feature("testAuraCourage1", "aura-of-courage", "Aura of Courage")).items;
  assert.deepEqual(courage.system.ruleElements[0].data.ruleElements[0].data, {conditions: ["frightened"]});
});

test("class features' dnd5e changes: a critical range, Advantage on Initiative and Concentration, Hit Points", async () => {
  const {effectRules} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  const rules = changes => effectRules({name: "Feature", changes}).map(rule => [rule.type, rule.data]);
  assert.deepEqual(rules([{key: "flags.dnd5e.weaponCriticalThreshold", mode: 3, value: "19"}]),
    [["RollOutcome", {domains: ["attack.weapon"], outcome: "critical-range", threshold: 19}]], "Improved Critical");
  assert.deepEqual(rules([{key: "system.attributes.init.roll.mode", mode: 2, value: "1"}]), [["RollMode", {domains: ["initiative"], mode: "advantage"}]]);
  assert.deepEqual(rules([{key: "system.attributes.concentration.roll.mode", mode: 2, value: "1"}]),
    [["RollMode", {domains: ["concentration"], mode: "advantage"}]], "Eldritch Mind");
  assert.deepEqual(rules([{key: "system.attributes.hp.bonuses.overall", mode: 2, value: "@classes.sorcerer.levels"}])[0][1].domains,
    ["resources.health.max"], "Draconic Resilience");
  assert.deepEqual(rules([{key: "system.attributes.hp.bonuses.level", mode: 2, value: "2"}])[0][1].valueExpression,
    {type: "multiply", terms: [{type: "constant", value: 2}, {type: "character-level"}]}, "2 per level");
});

test("Action Surge: an Action of its own, paid from its uses, for one more Action this turn", () => {
  const surge = {_id: "testActionSurge1", name: "Action Surge", type: "feat", img: "icons/svg/aura.svg", effects: [],
    system: {source: SRD, identifier: "action-surge", type: {value: "class"}, uses: {max: "1", recovery: [{period: "sr", type: "recoverAll"}]},
      activities: {a: activity("utility", {activation: {type: "special", override: false}})}}};
  const items = convertItem(surge).items;
  const action = items.find(item => item.type === "action");
  assert.deepEqual(action.system.definition.costs, {allOf: [{capability: "action-surge", amount: 1}]}, "no Action of its own");
  assert.deepEqual(action.system.definition.effects[0].ruleElements[0].data, {domains: ["resources.action.max"], modifierType: "untyped", value: 1});
  assert.deepEqual(action.system.definition.effects[0].duration, {value: 0, units: "turns", expiry: "turnEnd"});
  assert.equal(validateActionDefinition(action.system.definition).ok, true);
  assert.deepEqual(convertItem(surge).notes, [], "its blank activity is the Action, not a passive ability");
});

test("broken dnd5e effect data: a blank change is no change, and a status stored as \"[object Set]\" is read from the name", async () => {
  const {effectChanges, effectStatuses} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  assert.deepEqual(effectChanges({changes: [{key: "", value: "", type: "add"}, {key: "system.attributes.ac.bonus", value: "1", type: "add"}]})
    .map(change => change.key), ["system.attributes.ac.bonus"]);
  assert.deepEqual(effectStatuses({name: "Prone", statuses: ["[object Set]"]}), ["prone"]);
  assert.deepEqual(effectStatuses({name: "Charmed (Destructive)", statuses: ["[object Set]"]}), ["charmed"]);
  assert.deepEqual(effectStatuses({name: "Glowing", statuses: ["[object Set]"]}), [], "no condition in its name: none");
  assert.deepEqual(effectStatuses({name: "Anything", statuses: ["blinded"]}), ["blinded"], "good data is as it is");
});

test("an Item whose passive effect dnd5e left blank takes its skill roll mode from its text (Boots of Elvenkind)", () => {
  const boots = {_id: "testElvenBoots01", name: "Test Boots", type: "equipment", img: "icons/svg/item-bag.svg",
    effects: [{_id: "e1", name: "Test Boots", transfer: true, disabled: false, changes: [{key: "", value: "", type: "add"}]}],
    system: {source: SRD, identifier: "test-boots", type: {value: "wondrous"}, activities: {},
      description: {value: "<p>While you wear these boots, your steps make no sound. You also have Advantage on Dexterity (Stealth) checks.</p>"}}};
  const {items, notes} = convertItem(boots);
  const gear = items.find(item => item.type === "gear");
  assert.deepEqual(gear.system.ruleElements.map(rule => [rule.type, rule.data]),
    [["RollMode", {domains: ["check.stealth"], mode: "advantage"}]]);
  assert.deepEqual(notes, [], "no note for its blank change");
  const cloak = {...boots, _id: "testElvenCloak01", name: "Test Cloak", system: {...boots.system, identifier: "test-cloak", description: {value:
    "<p>While you wear this cloak, Wisdom (Perception) checks made to see you have Disadvantage, and you have Advantage on Dexterity (Stealth) checks.</p>"}}};
  const converted = convertItem(cloak);
  assert.deepEqual(converted.items.find(item => item.type === "gear").system.ruleElements.map(rule => rule.data.domains), [["check.stealth"]]);
  assert.equal(converted.notes.length, 1, "others' checks against it are noted, not dropped");
  assert.match(converted.notes[0], /^text: "While you wear this cloak/u);
});

test("a change on a class's scale reads its table: Rage's damage (Strength-based melee), Unarmored Movement", async () => {
  const {effectRules} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  const table = (owner, rows) => Object.defineProperty(rows, "key", {value: {type: "class-level", class: owner}, enumerable: false});
  const scales = {"barbarian.rage-damage": table("barbarian", {1: 2, 9: 3, 16: 4}), "monk.unarmored-movement": table("monk", {2: 10, 6: 15})};
  const [rage] = effectRules({name: "Rage", changes: [{key: "system.bonuses.mwak.damage", mode: 2, value: "+ @scale.barbarian.rage-damage"}]}, [], {scales});
  assert.deepEqual([rage.type, rage.data.valueExpression.rows, rage.predicate], ["Modifier", {1: 2, 9: 3, 16: 4}, {tagsAll: ["melee", "might"]}]);
  const [move] = effectRules({name: "Unarmored Movement", changes: [{key: "system.attributes.movement.walk", mode: 2,
    value: "@scale.monk.unarmored-movement"}]}, [], {scales});
  assert.deepEqual([move.data.domains, move.data.valueExpression.rows], [["resources.movement.max"], {2: 10, 6: 15}]);
});

test("Wild Shape: a Bonus Action, its transformation by the 2014 rules (limits, the Beast's Hit Points), and a Revert", () => {
  const wildShape = {_id: "testWildShape001", name: "Wild Shape", type: "feat", img: "icons/svg/aura.svg", effects: [],
    system: {source: SRD, identifier: "wild-shape", type: {value: "class"}, uses: {max: "@scale.druid.wild-shape-uses",
      recovery: [{period: "lr", type: "recoverAll"}, {period: "sr", type: "formula", formula: "1"}]},
      activities: {a: activity("transform", {activation: {type: "bonus", override: false}, consumption: {targets: [{type: "itemUses", value: "1"}]},
        transform: {preset: "wildshape", identifier: "druid"}, profiles: [{cr: "0.25", movement: ["fly"], level: {min: null, max: 3}}]})}}};
  const beasts = [{uuid: "Compendium.x.Actor.wolf", name: "Wolf", cr: 0.25}, {uuid: "Compendium.x.Actor.bear", name: "Brown Bear", cr: 1},
    {uuid: "Compendium.x.Actor.mammoth", name: "Mammoth", cr: 6}];
  const [shape, revert] = convertItem(wildShape, {beasts}).items;
  const {transform, configuration, costs} = shape.system.definition;
  assert.deepEqual(costs.allOf.map(cost => cost.capability), ["bonus-action", "wild-shape"]);
  assert.deepEqual(configuration.find(choice => choice.id === "form").options.map(option => option.label), ["Wolf (CR 0.25)", "Brown Bear (CR 1)"]);
  assert.deepEqual(transform.limits.rows, {2: {cr: 0.25, fly: false, swim: false}, 4: {cr: 0.5, fly: false, swim: true},
    8: {cr: 1, fly: true, swim: true}});
  assert.equal(transform.temporaryHealth, "form");
  assert.deepEqual(shape.system.ruleElements.find(rule => rule.type === "GrantResource").data,
    {resourceId: "wild-shape", label: "Wild Shape", maximum: {type: "constant", value: 2}, recovery: "shortRest"});
  assert.equal(validateActionDefinition(shape.system.definition).ok, true);
  assert.deepEqual([revert.name, revert.system.definition.transform], ["Wild Shape (Revert)", {revert: true}]);
});

test("Divine Smite: the 2024 spell on its own melee hit; Paladin's Smite brings the 2014 one and its free cast", () => {
  const damage = number => ({parts: [{number, denomination: 8, types: ["radiant"], scaling: {mode: "whole", number: 1}}]});
  const smite = {_id: "testDivineSmite1", name: "Divine Smite", type: "spell", img: "icons/svg/sun.svg", effects: [],
    system: {source: SRD, identifier: "divine-smite", level: 1, school: "evo", properties: ["vocal"], activation: {type: "bonus"},
      activities: {a: activity("damage", {name: "Cast", activation: {type: "bonus", override: false}, damage: damage(2), consumption: {scaling: {allowed: true}}}),
        b: activity("damage", {name: "Unholy Creature Damage", activation: {type: "bonus", override: false}, damage: damage(3), consumption: {scaling: {allowed: true}}})}}};
  const [plain, unholy] = convertItem(smite).items;
  assert.deepEqual([plain.name, unholy.name], ["Divine Smite", "Divine Smite (Undead or Fiend)"]);
  const {definition} = plain.system;
  assert.deepEqual([definition.tags, definition.costs.allOf.map(cost => cost.capability), definition.targeting.type],
    [["spell", "school:evocation", "component:verbal", "damage:radiant", "smite"], ["bonus-action"], "single"]);
  assert.deepEqual(Object.keys(definition.configuration[0].levelByResourceId).slice(-2), ["spell-slot.9", "paladins-smite"]);
  const unholyType = {oneOf: {path: "targetType", values: ["undead", "fiend"]}};
  assert.deepEqual(plain.system.ruleElements.find(rule => rule.type === "Trigger").data, {kind: "reaction", event: "attack.hit",
    match: {phase: "interrupt", sourceTokenId: "{self}", tagsAll: ["melee"], notTagsAny: ["spell"]}, triggerPredicate: {not: unholyType}});
  assert.deepEqual(unholy.system.ruleElements.find(rule => rule.type === "Trigger").data.triggerPredicate, unholyType,
    "the Undead or Fiend one only on such a creature");
  assert.equal(unholy.system.definition.damage[0].expression.number, 3);
  assert.equal(validateActionDefinition(definition).ok, true);

  const feature = {_id: "testPaladinSmite", name: "Paladin's Smite", type: "feat", img: "icons/svg/sun.svg", effects: [],
    system: {source: SRD, identifier: "paladins-smite", type: {value: "class"}, activities: {}}};
  const [text, free, freeUnholy] = convertItem(feature).items;
  assert.deepEqual(text.system.ruleElements.map(rule => rule.data), [{resourceId: "paladins-smite", label: "Paladin's Smite",
    maximum: 1, recovery: "longRest"}], "its free cast, once per Long Rest");
  assert.deepEqual([free.name, freeUnholy.name], ["Paladin's Smite", "Paladin's Smite (Undead or Fiend)"]);
  assert.deepEqual([free.system.definition.costs, free.system.definition.tags], [{allOf: []}, ["spell", "smite"]]);
  assert.deepEqual(Object.values(free.system.definition.configuration[0].levelByResourceId), [1, 2, 3, 4, 1], "5d8 at most");
  assert.equal(free.system.ruleElements[0].data.onlyWithoutOtherSlotSpell, true);
  assert.equal(freeUnholy.system.definition.damage[0].expression.number, 3);
  assert.equal(validateActionDefinition(free.system.definition).ok, true);
});

test("Temporary Hit Points are healing of their own type (False Life)", () => {
  const life = {_id: "testFalseLife001", name: "False Life", type: "spell", img: "systems/dnd5e/icons/spell.webp", effects: [],
    system: {source: SRD, identifier: "false-life", level: 1, preparation: {mode: "prepared"}, properties: ["vocal"], activation: {type: "action"},
      range: {units: "self"}, target: {affects: {type: "self"}, template: {}},
      activities: {a: activity("heal", {healing: {number: 2, denomination: 4, bonus: "4", types: ["temphp"]}})}}};
  const [spell] = convertItem(life).items;
  assert.deepEqual(spell.system.definition.healing.map(row => row.healingType), ["temporary"]);
  assert.equal(spell.flags.wildpath.conversion.notes.some(note => /temporary/i.test(note)), false);
});

test("spells that end conditions: Lesser Restoration's choice of four, Heal's three, Lay on Hands' Remove Poison only", () => {
  const spell = (id, identifier, name, activities, level=2) => ({_id: id, name, type: "spell", img: "systems/dnd5e/icons/spell.webp", effects: [],
    system: {source: SRD, identifier, level, preparation: {mode: "prepared"}, properties: ["vocal"], activation: {type: "action"},
      range: {units: "touch"}, target: {affects: {type: "creature", count: 1}, template: {}}, activities}});
  const [lesser] = convertItem(spell("testLesserResto1", "lesser-restoration", "Lesser Restoration", {a: activity("utility")})).items;
  const {effects, configuration} = lesser.system.definition;
  assert.deepEqual(effects.map(effect => [effect.conditionId, effect.levels]),
    [["blinded", -1], ["deafened", -1], ["paralyzed", -1], ["poisoned", -1]]);
  const choice = configuration.find(entry => entry.id === "effect-choice");
  assert.deepEqual([choice.label, choice.options.map(option => option.label)], ["Condition", ["Blinded", "Deafened", "Paralyzed", "Poisoned"]]);
  assert.deepEqual(lesser.flags.wildpath.conversion.notes, []);
  assert.equal(validateActionDefinition(lesser.system.definition).ok, true);

  const [heal] = convertItem(spell("testHealSpell001", "heal", "Heal", {a: activity("heal", {healing: {number: 70, bonus: ""}})}, 6)).items;
  assert.deepEqual(heal.system.definition.effects.map(effect => effect.conditionId), ["blinded", "deafened", "poisoned"]);
  assert.equal(heal.system.definition.configuration.some(entry => entry.id === "effect-choice"), false, "Heal ends all three");

  const hands = {_id: "testLayOnHands01", name: "Lay on Hands", type: "feat", img: "icons/svg/heal.svg", effects: [],
    system: {source: SRD, identifier: "lay-on-hands", activation: {type: "bonus"}, range: {units: "touch"}, target: {affects: {}, template: {}},
      activities: {a: activity("heal", {healing: {number: 5, bonus: ""}}), b: activity("utility", {_id: "actpoison", name: "Remove Poison"})}}};
  const [healing, poison] = convertItem(hands).items;
  assert.equal(healing.system.definition.effects, undefined, "its healing ends nothing");
  assert.deepEqual(poison.system.definition.effects.map(effect => [effect.conditionId, effect.levels]), [["poisoned", -1]]);
});

test("a feature spending another feature's uses spends that feature's pool (Channel Divinity's options, Land's Aid's Wild Shape)", () => {
  const names = nameIndex([{_id: "phbclcChannelDiv", name: "Channel Divinity", type: "feat", system: {identifier: "channel-divinity-cleric"}},
    {_id: "phbdrdWildShape0", name: "Wild Shape", type: "feat", system: {identifier: "wild-shape"}}]);
  const spending = (id, target) => ({_id: id, name: id, type: "feat", img: "icons/svg/sun.svg", effects: [],
    system: {source: SRD, identifier: id, type: {value: "class"}, uses: {max: "", recovery: []},
      activities: {a: activity("heal", {activation: {type: "action", override: false}, consumption: {targets: [{type: "itemUses", value: "1", target}]},
        healing: {number: 1, denomination: 6, types: ["healing"]}})}}});
  for ( const [target, pool] of [["feat:channel-divinity-cleric", "channel-divinity"], ["Compendium.dnd5e.classes24.Item.phbdrdWildShape0", "wild-shape"]] ) {
    const [item] = convertItem(spending("preserve", target), {names}).items;
    assert.deepEqual(item.system.definition.costs.allOf.map(cost => cost.capability), ["action", pool]);
    assert.deepEqual(item.system.ruleElements.filter(rule => rule.type === "GrantResource"), [], "the spent feature grants the pool");
  }
});

test("a concentration spell that sustains nothing converted has its caster concentrate for its duration (Fog Cloud)", () => {
  const fog = {_id: "testFogCloud0001", name: "Fog Cloud", type: "spell", img: "icons/svg/cloud.svg", effects: [],
    system: {source: SRD, identifier: "fog-cloud", level: 1, school: "con", properties: ["vocal", "somatic", "concentration"],
      duration: {value: "1", units: "hour"}, activities: {a: activity("utility", {duration: {override: false}})}}};
  const [item] = convertItem(fog).items;
  assert.deepEqual(item.system.definition.concentration, {duration: {value: 1, units: "hours"}});
  assert.equal(validateActionDefinition(item.system.definition).ok, true);
  assert.ok(item.flags.wildpath.conversion.notes.includes("concentration: its caster concentrates; what it sustains is by hand"));
  const plain = {...fog, _id: "testMinorIllus01", system: {...fog.system, identifier: "minor", properties: ["vocal"]}};
  assert.equal(convertItem(plain).items[0].system.definition.concentration, undefined, "not a concentration spell");
});

test("Stunning Strike: offered once a turn on its own melee hit, 1 Focus Point, Stunned on a failed save until the monk's next turn", () => {
  const names = nameIndex([{_id: "phbmnkMonksFocus", name: "Monk's Focus", type: "feat", system: {identifier: "monks-focus"}}]);
  const stunning = {_id: "testStunningStr1", name: "Stunning Strike", type: "feat", img: "icons/svg/daze.svg", effects: [],
    system: {source: SRD, identifier: "stunning-strike", type: {value: "class"}, uses: {max: "", recovery: []},
      activities: {a: activity("save", {activation: {type: "", override: false},
        consumption: {targets: [{type: "itemUses", value: "1", target: "Compendium.dnd5e.classes24.Item.phbmnkMonksFocus"}]},
        save: {ability: ["con"], dc: {calculation: "wis", formula: ""}}})}}};
  const [item] = convertItem(stunning, {names}).items;
  const {definition} = item.system;
  assert.deepEqual(definition.costs.allOf, [{capability: "monk-s-focus", amount: 1}], "no action, a Focus Point");
  assert.deepEqual(definition.effects[0], {id: "effect-1", type: "condition", conditionId: "stunned", saveOutcomePolicy: "failure",
    duration: {value: 1, units: "rounds", expiry: "sourceTurnStart"}});
  assert.deepEqual([definition.effects[1].saveOutcomePolicy, definition.effects[1].endsWhen, definition.effects[1].ruleElements[0].data],
    ["success", "attacked", {domains: ["attacked"], mode: "advantage"}], "a success: Advantage on the next attack against it");
  assert.deepEqual([definition.effects[2].saveOutcomePolicy, definition.effects[2].ruleElements[0].data.domains,
    definition.effects[2].ruleElements[0].data.value], ["success", ["speed.multiplier"], 0.5], "and its Speed halved");
  assert.equal(definition.targeting.type, "single");
  const trigger = item.system.ruleElements.find(rule => rule.type === "Trigger").data;
  assert.deepEqual([trigger.event, trigger.match.sourceTokenId, trigger.once], ["attack.hit", "{self}", "turn"]);
  assert.equal(validateActionDefinition(definition).ok, true);
});

test("Jack of All Trades and Remarkable Athlete: dnd5e's flags as WildPath rules", () => {
  const flagged = (id, key) => ({_id: id, name: id, type: "feat", img: "icons/svg/sun.svg", system: {source: SRD, identifier: id, type: {value: "class"},
    activities: {}}, effects: [{_id: `${id}eff`, name: id, transfer: true, disabled: false, changes: [{key, mode: 5, value: "1"}]}]});
  const [jack] = convertItem(flagged("jack", "flags.dnd5e.jackOfAllTrades")).items;
  assert.deepEqual(jack.system.ruleElements[0].data.domains, ["check.unproficient"]);
  assert.deepEqual(valueExpressions.evaluateValueExpression(jack.system.ruleElements[0].data.valueExpression,
    {actorSystem: {proficiencyBonus: 3}}).value, 1, "half of 3, rounded down");
  const [talent] = convertItem(flagged("talent", "flags.dnd5e.reliableTalent")).items;
  assert.deepEqual(talent.system.ruleElements[0].data, {domains: ["check.proficient"], outcome: "minimum-natural", threshold: 10});
  const [athlete] = convertItem(flagged("athlete", "flags.dnd5e.remarkableAthlete")).items;
  assert.deepEqual(athlete.system.ruleElements[0], {schemaVersion: 1, id: "athlete-1", type: "RollMode",
    data: {domains: ["initiative", "check.athletics"], mode: "advantage"}});
});

test("dnd5e's marked status: attack rolls against its creature have Advantage; only the next one when its text says so (Guiding Bolt)", () => {
  const bolt = (text) => ({_id: "testGuidingBolt1", name: "Guiding Bolt", type: "spell", img: "icons/svg/sun.svg",
    effects: [{_id: "markedEffect0001", name: "Guiding Bolt", statuses: ["marked"], changes: [], transfer: false, disabled: false, duration: {}}],
    system: {source: SRD, identifier: "guiding-bolt", level: 1, school: "evo", description: {value: text},
      activities: {a: activity("attack", {attack: {type: {value: "ranged", classification: "spell"}}, effects: [{_id: "markedEffect0001"}],
        damage: {parts: [{number: 4, denomination: 6, types: ["radiant"]}]}})}}});
  const next = convertItem(bolt("<p>The next attack roll made against it before the end of your next turn has Advantage.</p>")).items[0];
  const [effect] = next.system.definition.effects;
  assert.deepEqual(effect.ruleElements.at(-1).data, {domains: ["attacked"], mode: "advantage"});
  assert.deepEqual([effect.endsWhen, effect.duration], ["attacked", {value: 1, units: "rounds", expiry: "turnEnd"}]);
  assert.ok(!next.flags.wildpath.conversion.notes.some(note => note.includes("marked")));
  const lasting = convertItem(bolt("<p>Attack rolls against it have Advantage.</p>")).items[0].system.definition.effects[0];
  assert.equal(lasting.endsWhen, undefined, "every attack against it, for as long as it lasts");
});

test("weapon enchantments: Sacred Weapon (no longer passive) and Shillelagh pick a weapon; a rider attack is not an Action", () => {
  const names = nameIndex([{_id: "phbpdnChannelDiv", name: "Channel Divinity", type: "feat", system: {identifier: "channel-divinity-paladin"}}]);
  const sacred = {_id: "testSacredWeap01", name: "Sacred Weapon", type: "feat", img: "icons/svg/sun.svg", effects: [],
    system: {source: SRD, identifier: "sacred-weapon", type: {value: "class"}, uses: {max: "", recovery: []},
      activities: {a: activity("enchant", {activation: {type: "special", override: false},
        consumption: {targets: [{type: "itemUses", value: "1", target: "feat:channel-divinity-paladin"}]},
        duration: {units: "minute", value: "10", override: false}})}}};
  const [item] = convertItem(sacred, {names}).items;
  const {definition} = item.system;
  assert.deepEqual(definition.costs.allOf.map(cost => cost.capability), ["channel-divinity"]);
  assert.deepEqual(definition.configuration.map(choice => [choice.id, choice.optionsFrom]), [["weapon", {type: "weapons"}]]);
  assert.deepEqual([definition.effects[0].duration, definition.effects[0].ruleElements[0].predicate],
    [{value: 10, units: "minutes"}, {tagsAny: ["weapon:{{weapon}}"]}]);
  const shillelagh = {_id: "testShillelagh01", name: "Shillelagh", type: "spell", img: "icons/svg/oak.svg", effects: [],
    system: {source: SRD, identifier: "shillelagh", level: 0, school: "trs", duration: {value: "1", units: "minute"},
      activities: {a: activity("enchant", {name: "Imbue Weapon", activation: {type: "bonus", override: false}}),
        b: activity("attack", {name: "Spellcasting Attack", attack: {type: {value: "melee", classification: "weapon"}}})}}};
  const converted = convertItem(shillelagh).items;
  assert.equal(converted.length, 1, "its Spellcasting Attack is the weapon's own, now");
  assert.deepEqual(converted[0].system.definition.configuration.at(-1).optionsFrom, {type: "weapons", melee: true, bases: ["club", "quarterstaff"]});
  assert.equal(validateActionDefinition(converted[0].system.definition).ok, true);
});

test("Reckless Attack: a free Action whose effect (reckless) gives Advantage on Strength attacks and on attacks against it", () => {
  const reckless = {_id: "testReckless0001", name: "Reckless Attack", type: "feat", img: "icons/svg/fire.svg",
    effects: [{_id: "recklessEff00001", name: "Reckless", changes: [], transfer: false, disabled: false}],
    system: {source: SRD, identifier: "reckless-attack", type: {value: "class"}, uses: {max: "", recovery: []}, activities: {}}};
  const [, action] = convertItem(reckless).items;
  const {definition} = action.system;
  assert.deepEqual([definition.costs, definition.effects[0].slug, definition.effects[0].ruleElements.map(rule => rule.data)],
    [{allOf: []}, "reckless", [{domains: ["attack.might"], mode: "advantage"}, {domains: ["attacked"], mode: "advantage"}]]);
  assert.equal(validateActionDefinition(definition).ok, true);
});

test("Cunning Strike: Poison, Trip and Withdraw, each offered when Sneak Attack is in the hit and paid with one of its d6s", () => {
  const cunning = {_id: "testCunningStr01", name: "Cunning Strike", type: "feat", img: "icons/svg/dagger.svg",
    effects: [{_id: "poisonedEffect01", name: "Cunning Strike: Poisoned", statuses: ["poisoned"], changes: [], transfer: false, disabled: false},
      {_id: "trippedEffect001", name: "Cunning Strike: Tripped", statuses: ["prone"], changes: [], transfer: false, disabled: false}],
    system: {source: SRD, identifier: "cunning-strike", type: {value: "class"}, uses: {max: "", recovery: []},
      description: {value: "<p>Poison. The target repeats the save at the end of each of its turns, ending the effect on itself on a success.</p>"},
      activities: {
        a: activity("save", {_id: "actpoison", name: "Poison", activation: {type: "", override: false}, effects: [{_id: "poisonedEffect01"}],
          save: {ability: ["con"], dc: {calculation: "dex", formula: ""}}}),
        b: activity("save", {_id: "acttrip", name: "Trip", activation: {type: "", override: false}, effects: [{_id: "trippedEffect001"}],
          save: {ability: ["dex"], dc: {calculation: "dex", formula: ""}}}),
        c: activity("damage", {_id: "actcunning", name: "Cunning Sneak Attack", activation: {type: "", override: false}}),
        d: activity("utility", {_id: "actwithdraw", name: "Withdraw", activation: {type: "", override: false}})}}};
  const items = convertItem(cunning).items.filter(item => item.type === "action");
  assert.deepEqual(items.map(item => item.name), ["Cunning Strike (Poison)", "Cunning Strike (Trip)", "Cunning Strike (Withdraw)"]);
  for ( const item of items ) {
    const trigger = item.system.ruleElements.find(rule => rule.type === "Trigger").data;
    assert.deepEqual([trigger.match.tagsAll, trigger.once, trigger.onceKey], [["extra:sneak-attack"], "turn", "cunning-strike"]);
    assert.deepEqual(trigger.uses.rows, {1: 1, 11: 2}, "two at rogue level 11");
    assert.deepEqual(item.system.definition.rider, {forgoDice: {ruleId: "sneak-attack", dice: 1}});
    assert.equal(validateActionDefinition(item.system.definition).ok, true, item.name);
  }
  const [poison, trip, withdraw] = items.map(item => item.system.definition);
  assert.deepEqual([poison.effects[0].conditionId, poison.effects[0].repeatSave], ["poisoned", "turnEnd"]);
  assert.deepEqual([trip.effects[0].conditionId, trip.effects[0].repeatSave], ["prone", undefined], "Prone repeats nothing");
  assert.deepEqual([withdraw.targeting.type, withdraw.effects[0].slug], ["self", "disengaged"]);
});

test("Brutal Strike: its own Actions, a reckless Strength attack's rider and two blows", () => {
  const brutal = {_id: "testBrutalStrk01", name: "Brutal Strike", type: "feat", img: "icons/svg/fire.svg", effects: [],
    system: {source: SRD, identifier: "brutal-strike", type: {value: "class"}, uses: {max: "", recovery: []},
      activities: {a: activity("damage", {activation: {type: "special", override: false}})}}};
  const items = convertItem(brutal, {scales: {"barbarian.brutal-strike": {9: {number: 1, faces: 10}, 17: {number: 2, faces: 10}}}}).items;
  assert.deepEqual(items.map(item => [item.type, item.name]), [["feature", "Brutal Strike"], ["action", "Brutal Strike"],
    ["action", "Brutal Strike (Forceful Blow)"], ["action", "Brutal Strike (Hamstring Blow)"]]);
  const [, strike, forceful, hamstring] = items;
  const trigger = strike.system.ruleElements[0].data;
  assert.deepEqual([trigger.event, trigger.whileStatus, trigger.once], ["action.declared", "reckless", "turn"]);
  assert.deepEqual([strike.system.definition.rider.rollMode, strike.system.definition.rider.tags], ["normal", ["brutal-strike"]]);
  assert.deepEqual(forceful.system.definition.rider.push, {distance: 15});
  assert.deepEqual([forceful.system.ruleElements[0].data.onceKey, hamstring.system.ruleElements[0].data.match.tagsAll],
    ["brutal-blow", ["brutal-strike"]]);
  assert.equal(hamstring.system.definition.effects[0].ruleElements[0].data.value, -15);
  for ( const item of [strike, forceful, hamstring] ) assert.equal(validateActionDefinition(item.system.definition).ok, true, item.name);
});

test("summons chosen by Challenge Rating (Find Familiar) and counted by formula (Animate Dead) or by creature (Dancing Lights)", () => {
  const creatures = {mmSkeleton000000: "Compendium.x.Actor.skeleton", mmZombie00000000: "Compendium.x.Actor.zombie",
    tinyLight: "Compendium.x.Actor.tiny", mediumLight: "Compendium.x.Actor.medium"};
  const beasts = [{uuid: "Compendium.x.Actor.owl", name: "Owl", cr: 0}, {uuid: "Compendium.x.Actor.bat", name: "Bat", cr: 0},
    {uuid: "Compendium.x.Actor.wolf", name: "Wolf", cr: 0.25}];
  const spell = (id, name, level, summon, profiles) => ({_id: id, name, type: "spell", img: "icons/svg/aura.svg", effects: [],
    system: {source: SRD, identifier: name.toLowerCase().replace(/ /g, "-"), level, school: "con", activities: {a: activity("summon", {summon, profiles})}}});
  const [familiar] = convertItem(spell("testFamiliar0001", "Find Familiar", 1, {mode: "cr"},
    [{count: "1", cr: "0", types: ["beast"], uuid: "x.mmBat"}]), {beasts}).items;
  assert.deepEqual(familiar.system.definition.configuration.find(choice => choice.id === "summon-creature").options.map(option => option.id),
    ["Compendium.x.Actor.owl", "Compendium.x.Actor.bat"], "CR 0 Beasts only");
  const [dead] = convertItem(spell("testAnimateDead1", "Animate Dead", 3, {mode: ""},
    [{count: "1 + @scaling.increase * 2", uuid: "x.mmSkeleton000000"}, {count: "1 + @scaling.increase * 2", uuid: "x.mmZombie00000000"}]), {creatures}).items;
  const expression = dead.system.definition.summon.counts.find(entry => entry.actorRef === "Compendium.x.Actor.skeleton").count;
  assert.equal(valueExpressions.evaluateValueExpression(expression, {castLevel: 5}).value, 5);
  const [lights] = convertItem(spell("testDancingLigh1", "Dancing Lights", 0, {mode: ""},
    [{count: "4", uuid: "x.tinyLight"}, {count: "1", uuid: "x.mediumLight"}]), {creatures}).items;
  assert.deepEqual(lights.system.definition.summon.counts, [{actorRef: "Compendium.x.Actor.tiny", count: 4},
    {actorRef: "Compendium.x.Actor.medium", count: 1}]);
  for ( const item of [familiar, dead, lights] ) assert.equal(validateActionDefinition(item.system.definition).ok, true, item.name);
});

test("Cutting Words: a reaction to another creature's hit within 60 ft, its Bardic Inspiration die taken off that attack roll", () => {
  const words = {_id: "testCuttingWord1", name: "Cutting Words", type: "feat", img: "icons/svg/sound.svg", effects: [],
    system: {source: SRD, identifier: "cutting-words", type: {value: "class"}, uses: {max: "", recovery: []},
      activities: {a: activity("utility", {name: "Cut with Words", activation: {type: "reaction", override: false},
        range: {value: "60", units: "ft", override: false}, roll: {formula: "@scale.bard.inspiration"}})}}};
  const [item] = convertItem(words, {scales: {"bard.inspiration": {1: {number: 1, faces: 6}, 5: {number: 1, faces: 8}}}}).items;
  const {definition} = item.system;
  assert.deepEqual(item.system.ruleElements[0].data.match, {phase: "interrupt", notSourceTokenId: "{self}"});
  assert.deepEqual([definition.range.normal.value, definition.targeting.type, definition.rider.attackPenalty.dice.type], [60, "single", "table"]);
  assert.equal(validateActionDefinition(definition).ok, true);
});

test("Improved Brutal Strike: Staggering and Sundering Blows answer a Brutal Strike's hit, one a turn with the others", () => {
  const improved = {_id: "testImpBrutal001", name: "Improved Brutal Strike", type: "feat", img: "icons/svg/fire.svg", effects: [],
    system: {source: SRD, identifier: "improved-brutal-strike", type: {value: "class"}, uses: {max: "", recovery: []},
      activities: {a: activity("utility", {name: "Sundering Blow", activation: {type: "", override: false}})}}};
  const items = convertItem(improved).items.filter(item => item.type === "action");
  assert.deepEqual(items.map(item => item.name), ["Brutal Strike (Staggering Blow)", "Brutal Strike (Sundering Blow)"]);
  const [staggering, sundering] = items;
  for ( const item of items ) {
    assert.deepEqual([item.system.ruleElements[0].data.match.tagsAll, item.system.ruleElements[0].data.onceKey], [["brutal-strike"], "brutal-blow"]);
    assert.deepEqual(item.system.ruleElements[0].data.uses.rows, {1: 1, 17: 2}, "two blows at barbarian level 17");
    assert.equal(validateActionDefinition(item.system.definition).ok, true, item.name);
  }
  assert.deepEqual(staggering.system.definition.effects.map(effect => [effect.endsWhen ?? null, effect.slug ?? null]),
    [["saves", null], [null, "no-opportunity-attacks"]]);
  const [sundered] = sundering.system.definition.effects;
  assert.deepEqual([sundered.endsWhen, sundered.ruleElements[0].data.value, sundered.ruleElements[0].predicate],
    ["attackedByOther", 5, {not: {tagsAny: ["from:sundered"]}}]);
});

test("consumption targets: a pool traded for another is an Action spending one and restoring the other (2024 recoveries)", async () => {
  const fs = await import("node:fs");
  const read = file => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${file}.json`, "utf8"));
  const shape = file => { const {costs, restores, configuration} = read(file).system.definition;
    return {costs: costs.allOf.map(cost => cost.capability), restores: (restores ?? []).map(entry => entry.resourceId),
      choices: (configuration ?? []).map(choice => choice.id)}; };
  assert.deepEqual(shape("dragon-wings-restore-use-mc17dmye4h5e0000"), {costs: ["font-of-magic"], restores: ["dragon-wings"], choices: []},
    "3 Sorcery Points, not 3 of its own uses");
  assert.deepEqual(shape("intimidating-presence-recharge-with-rage-1yhh5661p9dup600"), {costs: ["rage"], restores: ["intimidating-presence"], choices: []});
  assert.deepEqual(shape("wild-resurgence-regain-wild-shape-phbdrdWildResurg"), {costs: [], restores: ["wild-shape"], choices: ["slot"]});
  assert.deepEqual(shape("wild-resurgence-regain-spell-slot-ioonfu2p71060000"), {costs: ["wild-resurgence", "wild-shape"],
    restores: ["spell-slot.1"], choices: []});
  assert.ok(read("sacred-weapon-phbpdnSacredWeap").system.definition.costs.allOf.some(cost => cost.capability === "channel-divinity"),
    "a converter path without names still charges its feature's pool");
  assert.equal(fs.readdirSync("packs/_source/srd-items").some(file => file.startsWith("bag-of-beans-count-beans")), false,
    "a rolled give-back (3d4 beans) is no Action");
});

test("monk: Martial Arts brings three Unarmed Strikes, Flurry of Blows fills its strikes, Open Hand answers a Flurry hit", async () => {
  const fs = await import("node:fs");
  const read = prefix => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${fs.readdirSync("packs/_source/srd-items")
    .find(file => file.startsWith(prefix))}`, "utf8"));
  const feature = read("martial-arts-phbmnkMartialArt");
  assert.equal(feature.flags.wildpath.grants.length, 3);
  // Monk weapons: the Martial Arts die in place of their own when larger, Dexterity in place of Strength.
  const {evaluatePredicate} = await import("../module/helpers/predicates.mjs");
  const [die, dexterity] = feature.system.ruleElements;
  assert.deepEqual([die.type, die.data.replacesBase, dexterity.data.domains], ["ExtraDamage", true, ["attack"]]);
  const monkWeapon = tags => evaluatePredicate(die.predicate, {tags}).ok;
  assert.deepEqual([monkWeapon(["melee", "category:martial", "light"]), monkWeapon(["melee", "category:simple"]),
    monkWeapon(["melee", "category:martial"]), monkWeapon(["ranged", "category:simple"])], [true, true, false, false],
    "a shortsword and a quarterstaff are Monk weapons; a longsword and a dart are not");
  const flurryStrike = read("martial-arts-flurry-of-blows-strike");
  const definition = flurryStrike.system.definition;
  assert.deepEqual([definition.costs.allOf[0].capability, definition.tags, definition.attack.properties],
    ["flurry-of-blows", ["flurry"], ["finesse"]]);
  assert.deepEqual(definition.damage[0].expression.rows["5"], {type: "dice", number: 1, faces: 8}, "the Martial Arts die");
  assert.equal(read("martial-arts-unarmed-strike").system.definition.costs.allOf[0].capability, "action", "Extra Attack pays it");
  const flurry = read("monk-s-focus-flurry-of-blows").system.definition;
  assert.deepEqual(flurry.restores.map(entry => entry.resourceId), ["flurry-of-blows"]);
  const push = read("open-hand-technique-push").system;
  const topple = read("open-hand-technique-topple").system;
  assert.deepEqual(push.ruleElements[0].data.match.tagsAll, ["flurry"]);
  assert.deepEqual([push.definition.push?.distance, push.definition.effects.length], [15, 0]);
  assert.deepEqual([topple.definition.push, topple.definition.effects.map(effect => effect.conditionId)], [undefined, ["prone"]]);
  assert.equal(JSON.parse(fs.readFileSync("packs/_source/srd-classes/monk-phbmnkMonk000000.json", "utf8")).system.advancement
    .some(entry => (entry.items ?? []).some(uuid => uuid.endsWith(flurryStrike._id))), false, "the class grants the feature, which brings it");
});

test("weapon hit extras: Divine Strike's two types, Primal Strike's choice and Lifedrinker answer any weapon hit, once a turn", async () => {
  const fs = await import("node:fs");
  const read = prefix => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${fs.readdirSync("packs/_source/srd-items")
    .find(file => file.startsWith(prefix))}`, "utf8")).system;
  for ( const [prefix, key] of [["blessed-strikes-divine-strike-radiant", "divine-strike"], ["blessed-strikes-divine-strike-necrotic", "divine-strike"],
    ["elemental-fury-primal-strike", "primal-strike"], ["lifedrinker-damage", "lifedrinker"]] ) {
    const {data} = read(prefix).ruleElements.find(rule => rule.type === "Trigger");
    assert.deepEqual([data.match.tagsAll, data.once, data.onceKey], [["weapon"], "turn", key], prefix);
  }
  assert.deepEqual(read("elemental-fury-primal-strike").definition.configuration[0].allowedDamageTypes, ["cold", "fire", "lightning", "thunder"]);
  assert.deepEqual(read("rage-phbbrbRage000000").definition.effects.map(effect => effect.slug), ["raging"]);
});

test("gaps: Nature's Ward, Second-Story Work, Sear Undead's (Wis)d8, Steady Aim and Superior Defense convert", async () => {
  const fs = await import("node:fs");
  const read = prefix => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${fs.readdirSync("packs/_source/srd-items")
    .find(file => file.startsWith(prefix))}`, "utf8")).system;
  assert.deepEqual(read("nature-s-ward-").ruleElements.find(rule => rule.type === "ConditionImmunity").data.conditions, ["poisoned"]);
  assert.equal(read("second-story-work-").ruleElements.find(rule => rule.type === "GrantMovement").data.mode, "climb");
  assert.deepEqual(read("sear-undead-").definition.damage[0].expression.number, {type: "ability-modifier", ability: "wits"});
  const aim = read("steady-aim-").definition;
  assert.deepEqual([aim.costs.allOf[0].capability, aim.effects.map(effect => effect.ruleElements[0].type)], ["bonus-action", ["RollMode", "Modifier"]]);
  const defense = read("superior-defense-").definition;
  assert.deepEqual([defense.costs.allOf, defense.effects[0].ruleElements[0].type], [[{capability: "monk-s-focus", amount: 3}], "GrantResistance"]);
});

test("Divine Order: Protector and Primal Order: Warden carry the training they give, added as a trait step adds it", async () => {
  const fs = await import("node:fs");
  const {traitUpdates} = await import("../module/helpers/level-up.mjs");
  const read = prefix => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${fs.readdirSync("packs/_source/srd-items")
    .find(file => file.startsWith(prefix))}`, "utf8"));
  const protector = read("divine-order-protector-").flags.wildpath.training;
  assert.deepEqual(protector, ["weapons:martial", "armor:heavy"]);
  assert.deepEqual(read("primal-order-warden-").flags.wildpath.training, ["armor:medium", "weapons:martial"]);
  assert.deepEqual(traitUpdates(protector, {training: {armor: ["light", "medium"], weapons: ["simple"]}}),
    {"system.training.weapons": ["simple", "martial"], "system.training.armor": ["light", "medium", "heavy"]});
});

test("warlock: Pact Magic classes, Magical Cunning's slots back (all at level 20), Mystic Arcanum pools", async () => {
  const fs = await import("node:fs");
  const {withResourceRestores} = await import("../module/resolvers/resource-resolver.mjs");
  const read = (dir, prefix) => JSON.parse(fs.readFileSync(`packs/_source/${dir}/${fs.readdirSync(`packs/_source/${dir}`)
    .find(file => file.startsWith(prefix))}`, "utf8"));
  assert.equal(read("srd-classes", "warlock-").system.spellcasting.progression, "pact");
  const {restores} = read("srd-items", "magical-cunning-").system.definition;
  const regained = (level, max) => {
    const actorSystem = {classes: [{id: "warlock", level, spellcasting: {progression: "pact"}}],
      pools: [{id: "spell-slot.pact", value: 0, max}]};
    return withResourceRestores(actorSystem, {ok: true, updates: {}, payments: []}, restores).updates["system.pools.0.value"];
  };
  assert.deepEqual([regained(11, 3), regained(5, 2), regained(20, 4)], [2, 1, 4]);
  const arcanum = read("srd-items", "mystic-arcanum-").system.ruleElements.map(rule => [rule.data.resourceId, Object.keys(rule.data.maximum.rows)[0]]);
  assert.deepEqual(arcanum, [["mystic-arcanum.6", "11"], ["mystic-arcanum.7", "13"], ["mystic-arcanum.8", "15"], ["mystic-arcanum.9", "17"]]);
  const slot = item => item.system.definition.configuration.find(choice => choice.id === "spell-slot");
  assert.equal(JSON.stringify(slot(read("srd-items", "disintegrate-")).cost).includes("mystic-arcanum"), false,
    "no spell offers an arcanum by itself: only the one its warlock marks (withMysticArcanum)");
});

test("on-hit features: Devious Strikes, Eldritch Smite (a Pact Magic slot), Hurl Through Hell and Giant Ancestry answer a hit", async () => {
  const fs = await import("node:fs");
  const {createResolvedActionPreview} = await import("../module/helpers/action-configuration.mjs");
  const read = prefix => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${fs.readdirSync("packs/_source/srd-items")
    .find(file => file.startsWith(prefix))}`, "utf8")).system;
  const trigger = system => system.ruleElements.find(rule => rule.type === "Trigger").data;
  for ( const [prefix, dice, condition, repeat] of [["devious-strikes-daze", 2, undefined, undefined],
    ["devious-strikes-knock-out", 6, "unconscious", "turnEnd"], ["devious-strikes-obscure", 3, "blinded", undefined]] ) {
    const system = read(prefix);
    assert.deepEqual([trigger(system).onceKey, trigger(system).match.tagsAll, system.definition.rider.forgoDice.dice], ["cunning-strike",
      ["extra:sneak-attack"], dice], prefix);
    assert.deepEqual([system.definition.effects[0].conditionId, system.definition.effects[0].repeatSave], [condition, repeat], prefix);
    assert.equal(validateActionDefinition(system.definition).ok, true, prefix);
  }
  const smite = read("eldritch-smite-");
  assert.deepEqual([trigger(smite).match.tagsAll, trigger(smite).once], [["weapon"], "turn"]);
  const actorSystem = {resources: {action: {value: 1, max: 1}, bonus: {value: 1, max: 1}, reaction: {value: 1, max: 1}},
    classes: [{id: "warlock", level: 5, spellcasting: {progression: "pact"}}], pools: [{id: "spell-slot.pact", value: 2, max: 2}]};
  const preview = createResolvedActionPreview({definition: smite.definition, actorSystem, choices: {"spell-slot": {resourceId: "spell-slot.pact"}, prone: "prone"}});
  assert.equal(preview.preview.damage.components[0].formula, "4d8", "(1 + pact level 3)d8");
  const hurl = read("hurl-through-hell-hurl");
  assert.deepEqual([trigger(hurl).match.tagsAll, trigger(hurl).once, hurl.definition.costs.allOf[0].capability,
    hurl.definition.effects[0].conditionId], [[], "turn", "hurl-through-hell", "incapacitated"]);
  for ( const [prefix, pool] of [["fire-s-burn", "fire-s-burn"], ["frost-s-chill", "frost-s-chill"], ["hill-s-tumble", "hill-s-tumble"]] ) {
    const system = read(prefix);
    assert.deepEqual([trigger(system).match.tagsAll, system.definition.costs.allOf[0].capability], [[], pool], prefix);
  }
  assert.equal(read("hill-s-tumble").definition.effects[0].conditionId, "prone");
});

test("reactions: Retaliation's common attack, Countercharm's ally reroll, Stone's Endurance's reduction; Indomitable is the engine's", async () => {
  const fs = await import("node:fs");
  const read = prefix => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${fs.readdirSync("packs/_source/srd-items")
    .find(file => file.startsWith(prefix))}`, "utf8"));
  const trigger = item => item.system.ruleElements.find(rule => rule.type === "Trigger")?.data;
  const retaliation = read("retaliation-");
  assert.deepEqual([trigger(retaliation).event, trigger(retaliation).commonAction, trigger(retaliation).match.notSourceTokenId],
    ["damage.applied", "opportunity", "{self}"]);
  const countercharm = read("countercharm-");
  assert.deepEqual([countercharm.type, countercharm.flags.wildpath.testOffer], ["feature", {tests: ["save"], pool: "reaction",
    rollMode: "advantage", range: 30, against: ["charmed", "frightened"]}]);
  const stone = read("stone-s-endurance-");
  assert.deepEqual([trigger(stone).event, trigger(stone).match.targetTokenId, stone.system.definition.healing,
    stone.system.definition.rider.reduceDamage.dice.faces], ["damage.applied", "{self}", undefined, 12]);
  assert.equal(trigger(stone).match.phase, "before", "before its damage is planned, from anything");
  // Deflect Attacks: a hit with bludgeoning, piercing or slashing damage, reduced by 1d10 + Dex + monk level (no longer a heal).
  const deflect = read("deflect-attacks-reduce-");
  assert.deepEqual([trigger(deflect).match.tagsAll, trigger(deflect).match.tagsAny.length, deflect.system.definition.healing,
    deflect.system.definition.rider.reduceDamage.dice.faces], [["hit"], 3, undefined, 10]);
  assert.equal(trigger(read("deflect-energy-reduce-")).match.tagsAny, undefined, "Deflect Energy: any damage type");
  assert.equal(validateActionDefinition(stone.system.definition).ok, true);
  const indomitable = read("indomitable-phbftr");
  assert.deepEqual([indomitable.type, indomitable.system.ruleElements.map(rule => rule.data.resourceId)], ["feature", ["indomitable"]],
    "no Action that does nothing; its pool stays for the engine's reroll");
});

test("small rules: Alert, Innate Sorcery, Disciplined Survivor, Luck and Powerful Build", async () => {
  const fs = await import("node:fs");
  const read = prefix => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${fs.readdirSync("packs/_source/srd-items")
    .find(file => file.startsWith(prefix))}`, "utf8"));
  assert.deepEqual(read("alert-phbft").system.ruleElements.map(rule => [rule.data.domains, rule.data.valueExpression]),
    [[["initiative"], {type: "proficiency-bonus"}]]);
  const innate = read("innate-sorcery-").system.definition.effects[0].ruleElements;
  assert.deepEqual(innate.map(rule => [rule.type, rule.data.domains, rule.predicate ?? null]),
    [["Modifier", ["dc.spell"], null], ["RollMode", ["attack"], {tagsAny: ["spell"]}]]);
  const survivor = read("disciplined-survivor-").flags.wildpath;
  assert.deepEqual([survivor.testOffer, survivor.training.length], [{tests: ["save"], reroll: true, pool: "monk-s-focus"}, 6]);
  assert.deepEqual(read("luck-phbspt").flags.wildpath.testOffer, {tests: ["check", "save", "attack"], reroll: true, natural: 1});
  const build = read("powerful-build-").system.ruleElements[0];
  assert.deepEqual([build.type, build.data.domains, build.predicate], ["RollMode", ["check"], {equals: {path: "check.escapes", value: "grappled"}}]);
});

test("size and range limits on offers: Hill's Tumble, Trip and Repelling Blast Large or smaller; Retaliation within 5 ft", async () => {
  const fs = await import("node:fs");
  const {evaluatePredicate} = await import("../module/helpers/predicates.mjs");
  const read = prefix => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${fs.readdirSync("packs/_source/srd-items")
    .find(file => file.startsWith(prefix))}`, "utf8")).system;
  const predicate = prefix => read(prefix).ruleElements.find(rule => rule.type === "Trigger").data.triggerPredicate;
  const sized = (prefix, size) => evaluatePredicate(predicate(prefix), {event: {data: {targetSize: size}}}).ok;
  for ( const prefix of ["hill-s-tumble", "cunning-strike-trip", "repelling-blast"] ) {
    assert.deepEqual([sized(prefix, "large"), sized(prefix, "huge"), sized(prefix, undefined)], [true, false, true], prefix);
  }
  assert.equal(read("cunning-strike-trip").definition.effects[0].maxSize, "large");
  assert.equal(read("eldritch-smite-").definition.effects[0].maxSize, "huge");
  const near = distance => evaluatePredicate(predicate("retaliation-").atMost ? {atMost: {...predicate("retaliation-").atMost,
    path: "event.data.relations.me.distance"}} : null, {event: {data: {relations: {me: {distance}}}}}).ok;
  assert.deepEqual([near(5), near(10)], [true, false]);
});

test("senses: creatures', species' and effects' Darkvision, Blindsight, Tremorsense and Truesight become GrantSense", async () => {
  const fs = await import("node:fs");
  const {senseRules} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  assert.deepEqual(senseRules({ranges: {darkvision: 120, blindsight: null}}).map(rule => rule.data), [{sense: "darkvision", range: 120}]);
  assert.deepEqual(senseRules({darkvision: 60, trueseight: 30}).map(rule => rule.data), [{sense: "darkvision", range: 60},
    {sense: "truesight", range: 30}], "older keys, and the SRD's misspelling");
  const read = (dir, prefix) => JSON.parse(fs.readFileSync(`packs/_source/${dir}/${fs.readdirSync(`packs/_source/${dir}`)
    .find(file => file.startsWith(prefix))}`, "utf8"));
  assert.deepEqual(read("srd-classes", "dwarf-").system.ruleElements.map(rule => rule.data), [{sense: "darkvision", range: 120}]);
  assert.deepEqual(read("srd-items", "witch-sight-").system.ruleElements.map(rule => [rule.type, rule.data.sense, rule.data.range]),
    [["GrantSense", "truesight", 30]]);
  assert.deepEqual(read("srd-items", "devil-s-sight-").system.ruleElements.map(rule => rule.data), [{sense: "devilsSight", range: 120}],
    "Devil's Sight is its own sense (it sees through magical Darkness), not Darkvision");
});

test("languages convert: a background's choices and a creature's own, with its free text and Telepathy", async () => {
  const fs = await import("node:fs");
  const read = (dir, prefix) => JSON.parse(fs.readFileSync(`packs/_source/${dir}/${fs.readdirSync(`packs/_source/${dir}`)
    .find(file => file.startsWith(prefix))}`, "utf8"));
  const acolyte = read("srd-classes", "acolyte-");
  assert.ok(JSON.stringify(acolyte.system.advancement).includes("languages:"), "its language step");
  assert.equal(JSON.stringify(acolyte.flags.wildpath.conversion.notes).includes("languages are not tracked"), false);
  const aboleth = read("srd-creatures", "aboleth-");
  assert.deepEqual(aboleth.system.training.languages, ["deep"]);
  assert.deepEqual(aboleth.items.flatMap(item => item.system.ruleElements ?? []).filter(rule => rule.type === "GrantLanguage")
    .map(rule => rule.data), [{language: "telepathy", range: 120}], "its Telepathy is a rule with its range");
  // Gear's Telepathy is its rule while worn (30 feet), no longer a note.
  const helm = read("srd-items", "helm-of-telepathy-dmg");
  assert.deepEqual(helm.system.ruleElements.filter(rule => rule.type === "GrantLanguage").map(rule => rule.data), [{language: "telepathy", range: 30}]);
  assert.equal(JSON.stringify(helm.flags.wildpath.conversion.notes).includes("traits.languages"), false);
  // The language spells: their understanding as rules.
  const understood = prefix => read("srd-items", prefix).system.definition.effects.flatMap(effect => effect.ruleElements).map(rule => rule.data);
  assert.deepEqual([understood("comprehend-languages-"), understood("tongues-"), understood("speak-with-animals-"), understood("telepathic-bond-")],
    [[{language: "any"}], [{language: "any", spokenOnly: true, understood: true}], [{language: "beasts", spokenOnly: true}],
      [{language: "telepathy", bond: true}]]);
  // An effect a summon applies is the summoned creature's: the Onyx Dog's holder gets no Common, Blindsight or Intellect.
  const onyx = read("srd-items", "onyx-dog-");
  assert.deepEqual([onyx.system.ruleElements, onyx.flags.wildpath.training], [[], undefined]);
});

test("the Diviner's Portent carries its dice by wizard level; nothing to use, no note", () => {
  const portent = convertItem({_id: "testPortent00001", name: "Portent", type: "feat",
    system: {identifier: "portent", description: {value: "<p>Roll two d20s.</p>"}, activities: {}, source: {license: "test"},
      uses: {max: "1", spent: 0, recovery: [{period: "lr", type: "recoverAll"}]}}},
  {licensed: () => true, book: "PHB"});
  const [feature] = portent.items;
  assert.equal(feature.type, "feature");
  assert.deepEqual(feature.flags.wildpath.portentDice, {type: "table", key: {type: "class-level", class: "wizard"}, rows: {1: 2, 14: 3}});
  assert.deepEqual(feature.flags.wildpath.conversion.notes, []);
  assert.deepEqual(feature.system.ruleElements, [], "its dnd5e use count is no pool");
});

test("prerequisites from dnd5e's data and requirements text, on chosen things only", async () => {
  const {prerequisitesOf} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  assert.deepEqual(prerequisitesOf({prerequisites: {level: 4}, requirements: "Strength or Dexterity 13+"}),
    {level: 4, abilities: [{ability: "might", min: 13}, {ability: "agility", min: 13}]});
  assert.deepEqual(prerequisitesOf({requirements: "Intelligence, Wisdom, or Charisma 13+"}).abilities.map(entry => entry.ability),
    ["intellect", "wits", "presence"]);
  assert.deepEqual(prerequisitesOf({requirements: "Heavy Armor Training"}), {training: {armor: "heavy"}});
  assert.deepEqual(prerequisitesOf({requirements: "Warlock 5"}), {classLevel: {class: "warlock", min: 5}});
  assert.deepEqual(prerequisitesOf({requirements: "Pact of the Blade Invocation"}), {items: ["pact-of-the-blade"]});
  assert.deepEqual(prerequisitesOf({requirements: "Spellcasting or Pact Magic Feature"}), {spellcasting: true});
  assert.deepEqual(prerequisitesOf({prerequisites: {level: 2, repeatable: true}, requirements: "Warlock Cantrip That Deals Damage"}),
    {level: 2, repeatable: true, text: "Warlock Cantrip That Deals Damage"});
  assert.equal(prerequisitesOf({}), null);
});

test("a feat giving another class's options: its choice from a pool by kind, and Metamagic Adept's 2 Sorcery Points", () => {
  const feat = identifier => convertItem({_id: `test${identifier.slice(0, 12)}`, name: identifier, type: "feat",
    system: {identifier, type: {value: "feat", subtype: ""}, description: {value: ""}, activities: {}, source: {license: "test"}}},
  {licensed: () => true, book: "Tasha"}).items[0];
  const adept = feat("eldritch-adept");
  assert.deepEqual(adept.system.advancement, [{level: 0, type: "choice", title: "Eldritch Invocation", count: 1, pool: {subtype: "eldritchInvocation"}}]);
  const metamagic = feat("metamagic-adept");
  assert.equal(metamagic.system.advancement[0].count, 2);
  assert.deepEqual(metamagic.system.ruleElements.map(rule => [rule.type, rule.data.resourceId, rule.data.maximum]), [["GrantResource", "font-of-magic", 2]]);
});
