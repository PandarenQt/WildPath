import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync, readdirSync} from "node:fs";
import {ACTION_TEMPLATES, addBuilderRow, applyActionTemplate, builderGaps, builderIssues, builderToDefinition, definitionToBuilder,
  nextRowId, removeBuilderRow} from "../module/helpers/action-builder.mjs";
import {normalizeActionDefinition, validateActionDefinition} from "../module/helpers/action-definitions.mjs";

const folder = new URL("../packs/_source/actions/", import.meta.url);
const packDefinitions = readdirSync(folder).filter(name => name.endsWith(".json"))
  .map(file => [file, JSON.parse(readFileSync(new URL(file, folder), "utf8")).system.definition]);

/** Builder values as a submitted form sends them: rows keyed by index, read-only parts left out. */
function asForm(builder) {
  const rows = list => Object.fromEntries(list.map((row, index) => [index, row]));
  return {basics: builder.basics, costs: rows(builder.costs), range: builder.range, targets: builder.targets, area: builder.area,
    roll: builder.roll, slot: builder.slot, damage: rows(builder.damage), healing: rows(builder.healing), effects: rows(builder.effects),
    restores: rows(builder.restores), push: builder.push, summon: builder.summon, teleport: builder.teleport, choices: builder.choices};
}

/** Submit `changes` (section → fields, or rows by index) over the definition's current builder values. */
function submit(definition, changes, options={}) {
  const form = asForm(definitionToBuilder(definition));
  for ( const [section, fields] of Object.entries(changes) ) {
    for ( const [key, value] of Object.entries(fields) ) {
      if ( value && (typeof value === "object") && form[section][key] ) Object.assign(form[section][key], value);
      else form[section][key] = value;
    }
  }
  return builderToDefinition(form, definition, {abilities: ["might", "agility", "fortitude", "intellect", "wits", "presence"], ...options});
}

test("an unchanged form gives back every pack definition exactly", () => {
  const initial = {schemaVersion: 1, id: "", slug: "", label: "", category: "action", tags: [], source: null, origin: null, activation: null,
    costs: {}, controllerCosts: {}, transform: null, summon: null, stabilize: false, range: null, targeting: null, area: null, attack: null,
    save: null, check: null, damage: [], healing: [], effects: [], duration: null, configuration: [], ruleElements: [], policies: {},
    metadata: {}};
  for ( const [file, definition] of [...packDefinitions, ["initial", initial]] ) {
    const result = builderToDefinition(asForm(definitionToBuilder(definition)), definition);
    assert.equal(result.changed, false, file);
    assert.equal(result.definition, definition, file);
  }
});

test("Flame Burst can be built from a blank Action with the builder alone", () => {
  let definition = applyActionTemplate({id: "", label: ""}, "custom", {fallbackId: "action:flame-burst"});
  const step = changes => {
    const result = submit(definition, changes);
    assert.deepEqual(result.errors, []);
    definition = result.definition;
  };
  step({basics: {spell: true}});
  step({range: {type: "ranged", distance: 150}});
  step({targets: {type: "area"}});
  step({area: {shape: "radial", size: 20}});
  step({roll: {kind: "save", saveAbility: "agility"}});
  definition = addBuilderRow(definition, "damage");
  step({damage: {0: {formula: "8d6", damageType: "fire"}}});
  step({roll: {onSuccess: "half"}});

  assert.equal(validateActionDefinition(definition).ok, true);
  assert.deepEqual(builderIssues(definition), []);
  const expected = applyActionTemplate({id: "action:flame-burst", label: ""}, "areaSave");
  for ( const key of ["tags", "costs", "range", "targeting", "area", "save"] ) assert.deepEqual(definition[key], expected[key], key);
  assert.deepEqual(definition.damage, [{id: "damage-1", expression: {type: "dice", number: 8, faces: 6}, damageType: "fire",
    provenance: "spell-base", saveOutcomePolicy: {failure: "full", success: "half"}}]);
});

test("a changed field is written over its stored object; what the builder does not show survives", () => {
  const stored = {...packDefinitions.find(([file]) => file === "melee-strike.json")[1]};
  stored.damage = [{...stored.damage[0], metadata: {note: "kept"}, predicate: {tagsAny: ["blade"]}}];
  const result = submit(stored, {damage: {0: {formula: "2d6 + mod(might)"}}});
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.definition.damage[0], {...stored.damage[0], expression: {type: "add", terms: [{type: "dice", number: 2, faces: 6},
    {type: "ability-modifier", ability: "might"}]}});
  assert.deepEqual(result.definition.attack, stored.attack, "an untouched section is left alone");

  const ranged = submit(stored, {range: {type: "ranged", distance: 30, long: 120}}).definition;
  assert.deepEqual(ranged.range, {type: "ranged", normal: {value: 30, unit: "ft"}, long: {value: 120, unit: "ft"}}, "reach's distance goes");

  const finesse = submit(stored, {roll: {finesse: true}}).definition;
  assert.deepEqual(finesse.attack, {...stored.attack, properties: ["finesse"]});
  assert.deepEqual(submit(finesse, {roll: {finesse: false}}).definition.attack, stored.attack, "clearing finesse removes the property list");
});

test("text the builder cannot read is an error on its field, and nothing is written", () => {
  const stored = packDefinitions.find(([file]) => file === "venom-burst.json")[1];
  const result = submit(stored, {damage: {0: {formula: "2d6 + bananas"}}, range: {distance: 45}});
  assert.equal(result.changed, false);
  assert.equal(result.definition, stored);
  assert.deepEqual(result.errors.map(error => [error.field, error.key]), [["damage.0.formula", "UnknownWord"]]);
  assert.deepEqual(submit(stored, {roll: {dc: "10 + 1d4"}}).errors.map(error => error.key), ["DiceNotAllowed"], "a DC cannot roll");
  assert.deepEqual(submit(stored, {roll: {dc: "8 + prof + mod(luck)"}}).errors.map(error => error.key), ["UnknownAbility"]);

  const dc = submit(stored, {roll: {dc: "8 + prof + mod(wits)"}}).definition.save.dc;
  assert.deepEqual(dc, {valueExpression: {type: "add", terms: [{type: "constant", value: 8}, {type: "proficiency-bonus"},
    {type: "ability-modifier", ability: "wits"}]}}, "a formula DC replaces a fixed one");
  assert.deepEqual(submit({...stored, save: {...stored.save, dc}}, {roll: {dc: "15"}}).definition.save.dc, {value: 15});
});

test("a save sets what a success does to every damage row; effects can wait for a failed save", () => {
  const stored = packDefinitions.find(([file]) => file === "venom-burst.json")[1];
  const builder = definitionToBuilder(stored);
  assert.equal(builder.roll.onSuccess, "half");
  assert.equal(builder.effects[0].onFailedSave, true);
  const none = submit(stored, {roll: {onSuccess: "none"}}).definition;
  assert.deepEqual(none.damage[0].saveOutcomePolicy, {success: "none", failure: "full"});
  assert.equal("saveOutcomePolicy" in submit(stored, {roll: {onSuccess: "full"}}).definition.damage[0], false);
  assert.equal("saveOutcomePolicy" in submit(stored, {effects: {0: {onFailedSave: false}}}).definition.effects[0], false);
});

test("an effect row can be a condition or a custom effect with a duration", () => {
  const stored = packDefinitions.find(([file]) => file === "trip.json")[1];
  const custom = submit(stored, {effects: {0: {kind: "effect", name: "Off Balance"}}}).definition;
  assert.deepEqual(custom.effects[0], {id: "trip-prone", type: "effect", name: "Off Balance", ruleElements: [], duration: {value: 1, units: "rounds"}});
  const timed = submit(custom, {effects: {0: {durationValue: 1, durationUnits: "turns", expiry: "turnStart"}}}).definition;
  assert.deepEqual(timed.effects[0].duration, {value: 1, units: "turns", expiry: "turnStart"});
  assert.equal(validateActionDefinition(timed).ok, true);
  const back = submit(timed, {effects: {0: {kind: "condition", conditionId: "restrained"}}}).definition;
  assert.deepEqual(back.effects[0], {id: "trip-prone", type: "condition", conditionId: "restrained"});
});

test("parts only Advanced can edit stay read-only, and their data is kept", () => {
  const stored = packDefinitions.find(([file]) => file === "scaling-bolt.json")[1];
  const alternatives = {...stored, costs: {allOf: [{capability: "action", amount: 1, scaling: {per: "level"}}]},
    damage: [{...stored.damage[0], expression: {type: "table", key: {type: "character-level"}, rows: {1: 1, 5: 2}}}]};
  const builder = definitionToBuilder(alternatives);
  assert.equal(builder.costsReadOnly, true);
  assert.equal(builder.damage[0].formulaReadOnly, true);
  const form = asForm(builder);
  delete form.damage[0].formula;
  form.damage[0].damageType = "cold";
  const result = builderToDefinition(form, alternatives);
  assert.deepEqual(result.definition.damage[0], {...alternatives.damage[0], damageType: "cold"});
  assert.deepEqual(result.definition.costs, alternatives.costs);
});

test("templates are valid Actions, rows are added with valid defaults, and issues name their section", () => {
  for ( const key of Object.keys(ACTION_TEMPLATES) ) {
    const definition = applyActionTemplate({}, key, {fallbackId: `action:${key}`});
    assert.equal(validateActionDefinition(definition).ok, true, key);
    assert.deepEqual(builderIssues(definition).filter(issue => issue.level === "error"), [], key);
  }
  assert.equal(nextRowId([{id: "damage-1"}, {id: "damage-3"}], "damage"), "damage-4");
  assert.equal(nextRowId([{id: "damage-3"}], "damage"), "damage-2");

  const venom = packDefinitions.find(([file]) => file === "venom-burst.json")[1];
  const added = addBuilderRow(venom, "damage");
  assert.deepEqual(added.damage[1], {id: "damage-2", expression: {type: "dice", number: 1, faces: 6}, damageType: "poison",
    provenance: "additional", saveOutcomePolicy: {success: "half", failure: "full"}});
  assert.deepEqual(addBuilderRow(venom, "effects").effects[1], {id: "effect-2", type: "condition", conditionId: "prone", saveOutcomePolicy: "failure"});
  assert.deepEqual(removeBuilderRow(added, "damage", 0).damage.map(row => row.id), ["damage-2"]);
  assert.deepEqual(addBuilderRow({costs: {}}, "costs").costs, {allOf: [{capability: "action", amount: 1}]});
  assert.equal(validateActionDefinition(added).ok, true);

  const issues = builderIssues({schemaVersion: 1, id: "a", damage: [{id: "x", expression: {type: "constant", value: 1}, damageType: "fire!"}]});
  assert.deepEqual(issues.map(issue => [issue.level, issue.section, issue.key ?? issue.path]), [["error", "damage", "damage.0.damageType"],
    ["warning", "targets", "NoTargets"]]);
});

test("a spell slot level and its upcast dice scale the first damage row through the engine's own preview", async () => {
  const {createResolvedActionPreview} = await import("../module/helpers/action-configuration.mjs");
  const stored = packDefinitions.find(([file]) => file === "venom-burst.json")[1];
  const result = submit(stored, {slot: {level: 3, upcast: "1d6"}});
  assert.deepEqual(result.errors, []);
  const choice = result.definition.configuration[0];
  assert.deepEqual(choice.cost.anyOf.map(branch => branch[0].capability), [3, 4, 5, 6, 7, 8, 9].map(level => `spell-slot.${level}`));
  assert.deepEqual(choice.effects, [{type: "scaleDamage", levelChoiceId: "spell-slot", baseLevel: 3, componentIds: ["venom"],
    dice: {number: 1, faces: 6}}]);
  assert.equal(validateActionDefinition(result.definition).ok, true);
  const preview = createResolvedActionPreview({definition: result.definition, choices: {"spell-slot": {resourceId: "spell-slot.5"}},
    actorSystem: {resources: {action: {value: 1, max: 1}}, pools: [{id: "spell-slot.5", label: "5th", value: 1, max: 1}]}});
  assert.equal(preview.ok, true);
  assert.equal(preview.preview.damage.components[0].formula, "4d6", "two levels above the 3rd add 2d6");

  // Foundry stores `{"spell-slot.3": 3}` nested; the builder reads both, and an unchanged form writes nothing.
  const nested = {...result.definition, configuration: [{...choice, levelByResourceId: {"spell-slot": {3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9}}}]};
  assert.deepEqual(definitionToBuilder(nested).slot, {level: 3, upcast: "1d6"});
  assert.equal(builderToDefinition(asForm(definitionToBuilder(nested)), nested).changed, false);

  assert.deepEqual(submit(result.definition, {slot: {upcast: "1d6 + 1"}}).errors.map(error => error.key), ["DiceOnly"]);
  assert.deepEqual(submit(result.definition, {slot: {level: ""}}).definition.configuration, [], "no slot removes the choice");
  const scaling = packDefinitions.find(([file]) => file === "scaling-bolt.json")[1];
  assert.deepEqual(definitionToBuilder(scaling).slot, {level: 1, upcast: "1d6"});
});

test("the Proficient checkbox adds or removes the attack's proficiency; attack templates start proficient", () => {
  const melee = applyActionTemplate({}, "melee", {fallbackId: "action:melee"});
  assert.equal(melee.attack.proficient, true);
  assert.equal(definitionToBuilder(melee).roll.proficient, true);
  const off = submit(melee, {roll: {proficient: false}}).definition;
  assert.equal("proficient" in off.attack, false);
  assert.equal(submit(off, {roll: {proficient: true}}).definition.attack.proficient, true);
});

test("an unchanged form gives back every converted SRD Action exactly", () => {
  const srd = new URL("../packs/_source/srd-items/", import.meta.url);
  const definitions = readdirSync(srd).filter(name => name.endsWith(".json")).map(file => [file, JSON.parse(readFileSync(new URL(file, srd), "utf8"))])
    .filter(([, document]) => document.type === "action").map(([file, document]) => [file, document.system.definition]);
  assert.ok(definitions.length > 1000);
  for ( const [file, definition] of definitions ) {
    const result = builderToDefinition(asForm(definitionToBuilder(definition)), definition);
    assert.equal(result.changed, false, file);
  }
});

test("what the sheet's selects post for a skill-only check and a Cube changes nothing (no data loss)", () => {
  const chain = {schemaVersion: 1, id: "action:chain-burst", label: "Chain", costs: {allOf: [{capability: "action", amount: 1}]},
    targeting: {type: "self"}, check: {skill: "athletics", dc: {value: 20}}};
  // The check's ability select shows its blank "the skill's own" option, which posts "".
  const burst = submit(chain, {roll: {checkAbility: "", checkSkill: "athletics"}});
  assert.equal(burst.definition.check.ability, undefined, "no ability written into a skill-only check");
  const named = {...chain, check: {ability: "might", skill: "athletics", dc: {value: 20}}};
  assert.equal(submit(named, {roll: {checkAbility: ""}}).definition.check.ability, undefined,
    "choosing \"the skill's own\" clears a named ability");
  const web = {schemaVersion: 1, id: "action:web", label: "Web", costs: {allOf: [{capability: "action", amount: 1}]},
    targeting: {type: "area"}, area: {shape: "cube", size: {value: 20, unit: "ft"}}};
  const renamed = submit(web, {basics: {label: "Webbing"}, area: {shape: "cube"}});
  assert.equal(renamed.definition.area.shape, "cube", "renaming a Cube keeps its shape");
});

test("the Builder edits Magical, a weapon's kind and mastery, and an effect's concentration; builderGaps names the rest", () => {
  const sword = {schemaVersion: 1, id: "action:longsword", label: "Longsword", tags: ["magical"], costs: {allOf: [{capability: "action", amount: 1}]},
    range: {type: "reach", distance: {value: 5, unit: "ft"}}, targeting: {type: "single", required: true, count: 1},
    attack: {type: "melee", statistic: "weapon", defenseKey: "ac", proficient: true, weapon: {category: "martial", base: "longsword", mastery: "sap"}},
    damage: [{id: "weapon", expression: {type: "dice", number: 1, faces: 8}, damageType: "slashing", provenance: "weapon-base"}],
    effects: [{id: "bane", type: "condition", conditionId: "frightened", concentration: true}]};
  assert.deepEqual(builderGaps(sword), [], "the whole Action can be rebuilt in the Builder");
  assert.deepEqual(builderGaps({...sword, slug: "", category: "action", source: null, controllerCosts: {}, ruleElements: [], stabilize: false}), [],
    "the data model's defaults are nothing to rebuild");
  const changed = submit(sword, {basics: {magical: false}, roll: {mastery: "vex", weaponBase: "Longsword"}, effects: {0: {concentration: false}}});
  assert.deepEqual(changed.definition.tags, []);
  assert.deepEqual(changed.definition.attack.weapon, {category: "martial", base: "longsword", mastery: "vex"});
  assert.equal(changed.definition.effects[0].concentration, undefined);
  assert.deepEqual(submit(sword, {roll: {weaponCategory: "", weaponBase: "", mastery: ""}}).definition.attack.weapon, undefined);
  const advanced = {...sword, costs: {anyOf: [[{capability: "action", amount: 1}], [{capability: "bonus-action", amount: 1}]]},
    summon: {actorRef: "Actor.x", count: 1}, effects: [{id: "e", type: "effect", name: "Hex", endsWhen: "attacked",
      ruleElements: [{id: "r", type: "ArmorClass", data: {}}]}]};
  assert.deepEqual(builderGaps(advanced), ["effects.endsWhen", "effects.ruleElements.ArmorClass"]);
});

test("a monster's Multiattack is built in the Builder: ways to pay by option, and the pools it refills", () => {
  const tentacle = {schemaVersion: 1, id: "action:tentacle", label: "Tentacle",
    costs: {anyOf: [[{capability: "multiattack-tentacle", amount: 1}], [{capability: "action", amount: 1}]]}};
  const view = definitionToBuilder(tentacle);
  assert.equal(view.costOptions, true);
  assert.deepEqual(view.costs.map(row => [row.capability, row.option]), [["multiattack-tentacle", 1], ["action", 2]]);
  assert.equal(submit(tentacle, {}).changed, false);
  assert.deepEqual(builderGaps(tentacle), []);
  // Paying with the Action also spends a use of Dominate Mind: a second row of option 2.
  const paired = submit(tentacle, {costs: {2: {capability: "dominate-mind", amount: 1, option: 2}}});
  assert.deepEqual(paired.definition.costs, {anyOf: [[{capability: "multiattack-tentacle", amount: 1}],
    [{capability: "action", amount: 1}, {capability: "dominate-mind", amount: 1}]]});
  assert.deepEqual(submit(tentacle, {costs: {1: {option: 1}}}).definition.costs,
    {allOf: [{capability: "multiattack-tentacle", amount: 1}, {capability: "action", amount: 1}]}, "one option is paid whole");
  const plain = {schemaVersion: 1, id: "action:bite", label: "Bite", costs: {allOf: [{capability: "action", amount: 1}]}};
  const alternative = addBuilderRow(plain, "costs", {alternative: true});
  assert.deepEqual(alternative.costs, {anyOf: [[{capability: "action", amount: 1}], [{capability: "action", amount: 1}]]});
  assert.deepEqual(removeBuilderRow(tentacle, "costs", 1).costs, {allOf: [{capability: "multiattack-tentacle", amount: 1}]});

  const multiattack = {schemaVersion: 1, id: "action:multiattack", label: "Multiattack", costs: {allOf: [{capability: "action", amount: 1}]},
    restores: [{resourceId: "multiattack-tentacle", amount: 2}]};
  assert.deepEqual(definitionToBuilder(multiattack).restores, [{resourceId: "multiattack-tentacle", amount: 2}]);
  assert.deepEqual(builderGaps(multiattack), []);
  const more = submit(multiattack, {restores: {0: {amount: "3"}}});
  assert.deepEqual(more.definition.restores, [{resourceId: "multiattack-tentacle", amount: 3}]);
  const added = addBuilderRow(multiattack, "restores");
  assert.equal(validateActionDefinition(added).ok, true, "a new refill row is valid");
  assert.deepEqual(removeBuilderRow(added, "restores", 0).restores, [{resourceId: "uses", amount: 1}]);
  assert.deepEqual(normalizeActionDefinition(paired.definition).costs.anyOf.length, 2);
});

test("push or pull, a cylinder's height and \"up to N targets\" are Builder fields", () => {
  const harpoon = {schemaVersion: 1, id: "action:harpoon", label: "Harpoon", costs: {allOf: [{capability: "action", amount: 1}]},
    targeting: {type: "multiple", required: true, count: 3, refinementPolicy: {minSelections: 1}},
    area: {shape: "radial", size: {value: 10, unit: "ft"}, height: {value: 40, unit: "ft"}},
    push: {distance: 25, toward: true, maxSize: "huge"}};
  assert.deepEqual(builderGaps(harpoon), []);
  const view = definitionToBuilder(harpoon);
  assert.deepEqual([view.targets.atLeast, view.area.height, view.push], [1, 40, {distance: 25, toward: true, maxSize: "huge", onSuccess: false}]);
  assert.equal(submit(harpoon, {}).changed, false);
  const changed = submit(harpoon, {push: {toward: false, maxSize: "", onSuccess: true}, area: {height: ""}, targets: {atLeast: ""}});
  assert.deepEqual(changed.definition.push, {distance: 25, on: "success"});
  assert.equal(changed.definition.area.height, undefined);
  assert.equal(changed.definition.targeting.refinementPolicy, undefined);
  assert.equal(submit(harpoon, {push: {distance: ""}}).definition.push, null, "no distance: no push");
});

test("a summon's creature, count, rounds and concentration are Builder fields; one chosen when cast stays Advanced", () => {
  const familiar = {schemaVersion: 1, id: "action:find-familiar", label: "Find Familiar", costs: {allOf: [{capability: "action", amount: 1}]},
    summon: {actorRef: "Compendium.wildpath.srd-creatures.Actor.owl", count: 1, rounds: 600, spellLevel: 1}};
  assert.deepEqual(builderGaps(familiar), []);
  assert.equal(submit(familiar, {}).changed, false);
  const changed = submit(familiar, {summon: {count: "3", rounds: "", concentration: true}});
  assert.deepEqual(changed.definition.summon, {actorRef: "Compendium.wildpath.srd-creatures.Actor.owl", count: 3, spellLevel: 1, concentration: true});
  assert.equal(submit(familiar, {summon: {creature: ""}}).definition.summon, null, "no creature: no summon");
  const chosen = {...familiar, summon: {choiceId: "form", count: 1}, configuration: [{id: "form", type: "option", options: []}]};
  assert.equal(definitionToBuilder(chosen).summonReadOnly, true);
  assert.deepEqual(submit(chosen, {summon: {creature: "x"}}).definition.summon, chosen.summon, "a read-only summon is never written");
  assert.deepEqual(builderGaps(chosen), ["configuration", "summon.choiceId"]);
});

test("the Builder edits a damage row's type chosen when used, and \"apply one of these effects\"; grouped options stay Advanced", () => {
  const breath = {schemaVersion: 1, id: "action:breath", label: "Breath", costs: {allOf: [{capability: "action", amount: 1}]},
    targeting: {type: "area"}, area: {shape: "cone", size: {value: 15, unit: "ft"}}, save: {ability: "agility", dc: {value: 13}},
    damage: [{id: "damage-1", expression: {type: "dice", number: 2, faces: 10}, damageType: "acid", provenance: "additional",
      saveOutcomePolicy: {success: "half", failure: "full"}}],
    configuration: [{id: "damage-type-1", type: "damage-type", label: "Damage type", required: true, allowedDamageTypes: ["acid", "cold", "fire"],
      effects: [{type: "replaceDamageType", componentIds: ["damage-1"], damageTypeChoiceId: "damage-type-1"}]}]};
  assert.deepEqual(builderGaps(breath), []);
  assert.equal(definitionToBuilder(breath).damage[0].chooseFrom, "acid, cold, fire");
  assert.equal(submit(breath, {}).changed, false);
  assert.deepEqual(submit(breath, {damage: {0: {chooseFrom: "fire, cold"}}}).definition.configuration[0].allowedDamageTypes, ["fire", "cold"]);
  assert.deepEqual(submit(breath, {damage: {0: {chooseFrom: ""}}}).definition.configuration, [], "one fixed type: no choice");

  const blindness = {schemaVersion: 1, id: "action:bd", label: "Blindness/Deafness", costs: {allOf: [{capability: "action", amount: 1}]},
    targeting: {type: "single", required: true, count: 1}, save: {ability: "fortitude", dc: {value: 13}},
    effects: [{id: "effect-1", type: "condition", conditionId: "blinded", saveOutcomePolicy: "failure"},
      {id: "effect-2", type: "condition", conditionId: "deafened", saveOutcomePolicy: "failure"}],
    configuration: [{id: "effect-choice", type: "option", label: "Effect", required: true,
      options: [{id: "effect-option-1", label: "Blindness", value: "effect-option-1"}, {id: "effect-option-2", label: "Deafness", value: "effect-option-2"}],
      effects: [{type: "keepEffect", effectIds: ["effect-1", "effect-2"], keep: {"effect-option-1": ["effect-1"], "effect-option-2": ["effect-2"]}}]}]};
  assert.deepEqual(builderGaps(blindness), []);
  assert.equal(definitionToBuilder(blindness).choices.effectOne, true);
  assert.deepEqual(submit(blindness, {choices: {effectOne: false}}).definition.configuration, []);
  const added = addBuilderRow(blindness, "effects", {conditions: ["prone"]});
  assert.deepEqual(added.configuration[0].options.map(option => option.label), ["Blindness", "Deafness", "prone"],
    "a new effect joins the choice; the others keep their labels");
  const plain = {...blindness, configuration: []};
  assert.deepEqual(submit(plain, {choices: {effectOne: true}}).definition.configuration[0].options.map(option => option.label),
    ["blinded", "deafened"]);

  const word = {...blindness, configuration: [{...blindness.configuration[0],
    effects: [{type: "keepEffect", effectIds: ["effect-1", "effect-2"], keep: {"effect-option-1": ["effect-1", "effect-2"], "effect-option-2": []}}]}]};
  assert.equal(definitionToBuilder(word).effectChoiceReadOnly, true);
  assert.deepEqual(builderGaps(word), ["configuration"]);
  assert.deepEqual(submit(word, {choices: {effectOne: false}}).definition.configuration, word.configuration, "read-only: kept");
});

test("a condition row can end its condition instead (Lesser Restoration); Exhaustion loses its levels", () => {
  const restore = {schemaVersion: 1, id: "action:restore", label: "Restore", costs: {allOf: [{capability: "action", amount: 1}]},
    targeting: {type: "single", required: true, count: 1}, effects: [{id: "effect-1", type: "condition", conditionId: "poisoned", levels: -1}]};
  assert.deepEqual([definitionToBuilder(restore).effects[0].removes, definitionToBuilder(restore).effects[0].levels], [true, 1]);
  assert.deepEqual(builderGaps(restore), []);
  assert.equal(submit(restore, {}).changed, false);
  assert.equal(submit(restore, {effects: {0: {removes: false}}}).definition.effects[0].levels, 1, "applies it again");
  const tired = {...restore, effects: [{id: "effect-1", type: "condition", conditionId: "exhaustion", levels: 2}]};
  assert.equal(submit(tired, {effects: {0: {removes: true}}}).definition.effects[0].levels, -2, "removes two levels");
});
