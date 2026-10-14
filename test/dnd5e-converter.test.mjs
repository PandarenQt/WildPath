import {test} from "node:test";
import assert from "node:assert/strict";
import {convertActor, convertItem, describe, formulaExpression, isSrd2024, scaleTables} from "../scripts/content/dnd5e-to-wildpath.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";

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
  assert.equal(items.length, 1);
  valid(items[0]);
  assert.deepEqual(items[0].system.definition.attack, {type: "melee", statistic: "weapon", defenseKey: "ac", proficient: true,
    properties: ["finesse"]});
  assert.deepEqual(items[0].system.definition.range, {type: "reach", distance: {value: 5, unit: "ft"}});
  assert.deepEqual(items[0].system.definition.damage, [{id: "base", expression: {type: "dice", number: 1, faces: 8}, damageType: "slashing",
    provenance: "weapon-base"}]);
  assert.deepEqual(notes, ["damage: versatile two-handed damage not converted"]);
  assert.equal(items[0].img, "icons/weapons/swords/sword.webp", "core icons are kept");
  assert.deepEqual(items[0].flags.wildpath.source, {system: "dnd5e", pack: null, id: "testLongsword001", type: "weapon", book: "SRD 5.2",
    license: "CC-BY-4.0", rules: "2024"});
});

test("an area save spell: a sphere, the spell save DC, half on a success, and a slot of its level or higher that scales", () => {
  const [item] = convertItem(burst).items;
  valid(item);
  const definition = item.system.definition;
  assert.deepEqual(definition.area, {shape: "radial", size: {value: 20, unit: "ft"}});
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
      rows: {1: 2, 4: 3, 10: 4}}, recovery: "shortRest"}}]);
  assert.deepEqual(wind.notes, ["uses: a partial recovery refills the whole pool"]);
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
  assert.equal(manual.system.definition.save, undefined, "but rolls nothing it cannot resolve");
  assert.equal(validateActionDefinition(manual.system.definition).ok, true);
  assert.match(held.notes[0], /^not automated/);
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
  assert.ok(result.notes.some(note => note.includes("Recharge 5")));

  const bolt = upgradeLegacy({_id: "legacyBolt000001", name: "Bolt", type: "spell", system: {...legacy, level: 0, actionType: "rsak",
    activation: {type: "action", cost: 1}, range: {value: 120, units: "ft"}, scaling: {mode: "cantrip"}, damage: {parts: [["1d10", "fire"]]}}});
  assert.deepEqual(bolt.system.activities.legacy.damage.parts[0].scaling, {mode: "whole"});
  const cure = convertItem({_id: "legacyCure000001", name: "Cure", type: "spell", system: {...legacy, level: 1, actionType: "heal",
    activation: {type: "action", cost: 1}, range: {units: "touch"}, target: {value: 1, type: "creature"}, preparation: {mode: "prepared"},
    scaling: {mode: "level", formula: "1d8"}, damage: {parts: [["1d8 + @mod", "healing"]]}}}, own);
  assert.deepEqual(cure.items[0].system.definition.configuration[0].effects[0], {type: "scaleHealing", levelChoiceId: "spell-slot", baseLevel: 1,
    componentIds: ["healing-1"], dice: {number: 1, faces: 8}});
});
