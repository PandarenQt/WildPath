import {test} from "node:test";
import assert from "node:assert/strict";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";

const burn = {schemaVersion: 1, id: "action:burn", label: "Burn", costs: {allOf: []},
  damage: [{id: "fire", expression: {type: "dice", number: 2, faces: 6}, damageType: "fire", provenance: "spell-base"}]};
/** What a spent glyph leaves: a 60-ft sphere that acts on everyone in it as it appears (Symbol's). */
const sphere = (persistence={}) => ({shape: "radial", size: {value: 60, unit: "ft"},
  persistence: {duration: {unit: "round", value: 100}, triggers: [{on: ["area.created"], action: burn}], ...persistence}});
/** The validation errors' paths of a 5-ft lasting area with this budget and these triggers. */
const reasons = (budget, triggers=[{on: ["area.entered"]}]) => validateActionDefinition({schemaVersion: 1, id: "action:glyph",
  label: "Glyph", costs: {allOf: []}, targeting: {type: "area"},
  area: {shape: "radial", size: {value: 5, unit: "ft"}, persistence: {...(budget ? {budget} : {}), triggers}}})
  .errors.map(error => error.path);

test("a budget's springs and leaves: a glyph with an action-less trigger, damage and springs together, a sphere with its own duration", () => {
  assert.deepEqual(reasons({springs: 1, leaves: sphere()}), []);
  assert.deepEqual(reasons({damage: 60}, [{on: ["area.entered"], action: burn}]), [], "a damage budget, as before");
  assert.deepEqual(reasons({damage: 20, springs: 3}, [{on: ["area.entered"], action: burn}]), [], "either ends it");
  assert.deepEqual(reasons({springs: 1, leaves: sphere({clock: {}, obscures: "lightly"})}), [], "a clock and other keys of its own");
});

test("a budget's springs and leaves are refused in their bad forms", () => {
  const budget = ["area.persistence.budget"];
  for ( const bad of [{}, {springs: 0}, {springs: 1.5}, {springs: "1"}, {damage: 0}, {springs: 1, charges: 2}, {damage: 5, leaves: sphere()}] ) {
    assert.deepEqual(reasons(bad, [{on: ["area.entered"], action: burn}]), budget, JSON.stringify(bad));
  }
  const leaves = ["area.persistence.budget.leaves"];
  for ( const bad of [{...sphere(), shape: "cube"}, {...sphere(), size: {value: 0, unit: "ft"}}, {shape: "radial", size: {value: 10}}] ) {
    assert.deepEqual(reasons({springs: 1, leaves: bad}), leaves, JSON.stringify(bad));
  }
  for ( const own of [{concentration: true}, {budget: {damage: 5}}, {blocks: ["move"]}, {elevation: {bottom: 0, top: 10}}, {endsWhen: "sourceDies"}] ) {
    assert.deepEqual(reasons({springs: 1, leaves: sphere(own)}), ["area.persistence.budget.leaves.persistence"], JSON.stringify(own));
  }
  assert.deepEqual(reasons({springs: 1, leaves: sphere({triggers: [{on: ["area.created"]}]})}),
    ["area.persistence.budget.leaves.persistence.triggers.0.action"], "what it leaves has no springs, so each trigger runs an Action");
  assert.deepEqual(reasons({springs: 1, leaves: sphere({duration: {unit: "minute", value: 10}})}),
    ["area.persistence.budget.leaves.persistence.duration"], "its own persistence is checked as any lasting area's");
});

test("a trigger with no Action only springs an area with springs", () => {
  const at = ["area.persistence.triggers.0.action"];
  assert.deepEqual(reasons(null), at, "no budget");
  assert.deepEqual(reasons({damage: 10}), at, "a damage budget only");
  assert.deepEqual(reasons({springs: 2}), []);
});
