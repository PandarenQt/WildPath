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
    ["ResourceCap", null], ["GrantMovement", null], ["ConditionImmunity", null]]);
  assert.deepEqual(mixed[0].data.domains, ["attack.weapon"], "a melee weapon attack bonus");
  assert.deepEqual(mixed[1].data, {domains: ["check.stealth"], mode: "disadvantage"});
  assert.deepEqual(notes, ['effect: "Mixed" change system.attributes.ac.calc (override) not converted',
    'effect: "Mixed" condition immunity diseased not converted']);
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
