import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync, readdirSync} from "node:fs";
import {ACTION_TEMPLATES, addBuilderRow, applyActionTemplate, builderIssues, builderToDefinition, definitionToBuilder,
  nextRowId, removeBuilderRow} from "../module/helpers/action-builder.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";

const folder = new URL("../packs/_source/actions/", import.meta.url);
const packDefinitions = readdirSync(folder).filter(name => name.endsWith(".json"))
  .map(file => [file, JSON.parse(readFileSync(new URL(file, folder), "utf8")).system.definition]);

/** Builder values as a submitted form sends them: rows keyed by index, read-only parts left out. */
function asForm(builder) {
  const rows = list => Object.fromEntries(list.map((row, index) => [index, row]));
  return {basics: builder.basics, costs: rows(builder.costs), range: builder.range, targets: builder.targets, area: builder.area,
    roll: builder.roll, damage: rows(builder.damage), healing: rows(builder.healing), effects: rows(builder.effects)};
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
  const alternatives = {...stored, costs: {anyOf: [[{capability: "action", amount: 1}], [{capability: "bonus-action", amount: 1}]]},
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
