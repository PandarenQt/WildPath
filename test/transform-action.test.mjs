import {test} from "node:test";
import assert from "node:assert/strict";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {resolveActionConfiguration} from "../module/helpers/action-configuration.mjs";
import {applyActionTransformation} from "../module/resolvers/foundry-multiplayer-runtime.mjs";

const WILD_SHAPE = {schemaVersion: 1, id: "action:wild-shape", label: "Wild Shape", costs: {allOf: []}, transform: {choiceId: "form"},
  configuration: [{id: "form", type: "select-one", label: "Form", required: true,
    options: [{id: "Actor.bear", label: "Bear"}, {id: "Actor.wolf", label: "Wolf"}]}]};

test("a transform names exactly one of a fixed form, a configuration choice, or revert", () => {
  const definition = transform => ({schemaVersion: 1, id: "action:t", label: "T", costs: {allOf: []}, transform});
  assert.equal(validateActionDefinition(WILD_SHAPE).ok, true);
  assert.equal(validateActionDefinition(definition({formRef: "Actor.bear"})).ok, true);
  assert.equal(validateActionDefinition(definition({revert: true})).ok, true);
  assert.equal(validateActionDefinition(definition({formRef: "Actor.bear", revert: true})).ok, false);
  assert.equal(validateActionDefinition(definition({})).ok, false);
});

/** A creature that records what it is turned into. */
function shifter() {
  return {calls: [], async transform(form, policy) { this.calls.push(["transform", form.name, policy]); },
    async revertTransformation() { this.calls.push(["revert"]); }};
}
const forms = {"Actor.bear": {name: "Bear"}, "Actor.wolf": {name: "Wolf"}};

test("Wild Shape turns its creature into the form the Player chose, after the Action completes", async () => {
  const actor = shifter();
  const {configuration} = resolveActionConfiguration({actionDefinition: WILD_SHAPE, responses: {form: "Actor.wolf"}});
  await applyActionTransformation({options: {actor}, state: {actionDefinition: WILD_SHAPE, configuration}},
    {fromUuid: async uuid => forms[uuid] ?? null});
  assert.deepEqual(actor.calls, [["transform", "Wolf", {}]]);
});

test("a fixed form keeps its policy, a revert Action returns the creature, and an unknown form changes nothing", async () => {
  const actor = shifter();
  const fixed = {transform: {formRef: "Actor.bear", keepItemTypes: ["feature"]}};
  await applyActionTransformation({options: {actor}, state: {actionDefinition: fixed}}, {fromUuid: async uuid => forms[uuid] ?? null});
  await applyActionTransformation({options: {actor}, state: {actionDefinition: {transform: {revert: true}}}});
  await applyActionTransformation({options: {actor}, state: {actionDefinition: {transform: {formRef: "Actor.none"}}}},
    {fromUuid: async () => null, logger: {warn() {}}});
  assert.deepEqual(actor.calls, [["transform", "Bear", {keepItemTypes: ["feature"]}], ["revert"]]);
});
