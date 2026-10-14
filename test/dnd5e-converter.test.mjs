import {test} from "node:test";
import assert from "node:assert/strict";
import {convertItem, formulaExpression, isSrd2024, scaleTables} from "../scripts/content/dnd5e-to-wildpath.mjs";
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
  assert.deepEqual(items[0].system.definition.attack, {type: "melee", statistic: "weapon", defenseKey: "ac", properties: ["finesse"]});
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
  assert.deepEqual(cantrip.notes, ["damage 1: cantrip damage growing with character level not converted"]);

  const heal = convertItem(mend);
  valid(heal.items[0]);
  assert.deepEqual(heal.items[0].system.definition.healing[0].expression, {type: "add", terms: [{type: "dice", number: 2, faces: 8},
    {type: "spellcasting-modifier"}]});
  assert.deepEqual(heal.notes, ["healing: more healing at higher levels not converted"]);

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

test("what WildPath cannot run is left out and named, never approximated", () => {
  const held = convertItem(hold);
  assert.deepEqual(held.items, [], "a save with nothing converted on it is not an Action");
  assert.ok(held.notes.includes("effect: paralyzed is not a WildPath condition yet"));
  assert.ok(held.notes.some(note => note.startsWith("activity")));

  const tripped = convertItem(trip);
  valid(tripped.items[0]);
  assert.deepEqual(tripped.items[0].system.definition.save, {ability: "might", dc: {value: 13}});
  assert.deepEqual(tripped.items[0].system.definition.effects, [{id: "effect-1", type: "condition", conditionId: "prone", saveOutcomePolicy: "failure"}]);
  assert.deepEqual(tripped.notes, ["save: a choice of str/dex uses str"]);

  assert.equal(formulaExpression("@abilities.str.mod"), null);
  assert.deepEqual(formulaExpression("@prof"), {type: "proficiency-bonus"});
  assert.deepEqual(formulaExpression("@mod", {ability: "might"}), {type: "ability-modifier", ability: "might"});
});
