import {test} from "node:test";
import assert from "node:assert/strict";
import {
  TARGET_CODES,
  TARGET_DEFAULT_SELECTION,
  TARGET_OPERATIONS,
  TARGET_OVERRIDE_TYPES,
  addTargetCandidate,
  applyTargetPredicate,
  attachTargetOverride,
  createTargetCandidate,
  createTargetRefinementTrace,
  createTargetSelectionRequest,
  createTargetSet,
  filterTargetSet,
  partitionTargetSet,
  refineTargetSet,
  removeTargetCandidate,
  resolveTargetEligibility,
  targetSetContains
} from "../module/helpers/targeting.mjs";

function candidate(id, data={}) {
  return createTargetCandidate({
    id,
    target: {id: `token-${id}`},
    actor: {id: `actor-${id}`},
    occupiedFields: data.occupiedFields ?? [{id: `${id}:field`}],
    intersectingFields: data.intersectingFields ?? [{id: `${id}:hit`}],
    disposition: data.disposition ?? "enemy",
    kind: "creature",
    tags: data.tags ?? [],
    conditions: data.conditions ?? []
  });
}

test("default target refinement selects all eligible AoE candidates", () => {
  const set = resolveTargetEligibility(createTargetSet([
    candidate("a"), candidate("b"), candidate("c"), candidate("d")
  ]));
  const result = refineTargetSet({targetSet: set});
  assert.equal(result.finalTargets.length, 4);
  assert.equal(result.code, TARGET_CODES.OK);
});

test("deselect up to N supports optional 0, 1, and 2 choices and rejects 3", () => {
  const set = resolveTargetEligibility(createTargetSet([
    candidate("a"), candidate("b"), candidate("c"), candidate("d"), candidate("e")
  ]));
  const policy = {
    defaultSelection: TARGET_DEFAULT_SELECTION.ALL,
    allowedOperations: [TARGET_OPERATIONS.DESELECT],
    maxChoices: 2
  };

  assert.equal(refineTargetSet({targetSet: set, policy, decisions: []}).ok, true);
  assert.equal(refineTargetSet({targetSet: set, policy, decisions: [
    {operation: TARGET_OPERATIONS.DESELECT, targetId: "a"}
  ]}).ok, true);
  assert.equal(refineTargetSet({targetSet: set, policy, decisions: [
    {operation: TARGET_OPERATIONS.DESELECT, targetId: "a"},
    {operation: TARGET_OPERATIONS.DESELECT, targetId: "b"}
  ]}).ok, true);

  const invalid = refineTargetSet({targetSet: set, policy, decisions: [
    {operation: TARGET_OPERATIONS.DESELECT, targetId: "a"},
    {operation: TARGET_OPERATIONS.DESELECT, targetId: "b"},
    {operation: TARGET_OPERATIONS.DESELECT, targetId: "c"}
  ]});
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, TARGET_CODES.SELECTION_LIMIT_REACHED);
});

test("select up to N from default none enforces maximum selections", () => {
  const set = resolveTargetEligibility(createTargetSet([candidate("a"), candidate("b"), candidate("c"), candidate("d")]));
  const policy = {
    defaultSelection: TARGET_DEFAULT_SELECTION.NONE,
    allowedOperations: [TARGET_OPERATIONS.SELECT],
    maxSelections: 3
  };
  const valid = refineTargetSet({targetSet: set, policy, decisions: [
    {operation: TARGET_OPERATIONS.SELECT, targetId: "a"},
    {operation: TARGET_OPERATIONS.SELECT, targetId: "b"},
    {operation: TARGET_OPERATIONS.SELECT, targetId: "c"}
  ]});
  const invalid = refineTargetSet({targetSet: set, policy, decisions: [
    {operation: TARGET_OPERATIONS.SELECT, targetId: "a"},
    {operation: TARGET_OPERATIONS.SELECT, targetId: "b"},
    {operation: TARGET_OPERATIONS.SELECT, targetId: "c"},
    {operation: TARGET_OPERATIONS.SELECT, targetId: "d"}
  ]});

  assert.equal(valid.finalTargets.length, 3);
  assert.equal(invalid.code, TARGET_CODES.SELECTION_LIMIT_REACHED);
});

test("predicate-limited refinement rejects selecting invalid targets", () => {
  const set = resolveTargetEligibility(createTargetSet([
    candidate("ally", {disposition: "ally"}),
    candidate("enemy", {disposition: "enemy"})
  ]));
  const policy = {
    defaultSelection: TARGET_DEFAULT_SELECTION.NONE,
    allowedOperations: [TARGET_OPERATIONS.SELECT],
    selectionPredicate: {equals: {path: "disposition", value: "ally"}}
  };
  const result = refineTargetSet({targetSet: set, policy, decisions: [
    {operation: TARGET_OPERATIONS.SELECT, targetId: "enemy"}
  ]});

  assert.equal(result.ok, false);
  assert.equal(result.code, TARGET_CODES.TARGET_PREDICATE_FAILED);
});

test("selection limits can use ValueExpressions", () => {
  const set = resolveTargetEligibility(createTargetSet([candidate("a"), candidate("b"), candidate("c")]));
  const policy = {
    defaultSelection: TARGET_DEFAULT_SELECTION.NONE,
    allowedOperations: [TARGET_OPERATIONS.SELECT],
    maxSelections: {type: "context", path: "actor.proficiencyBonus"}
  };
  const result = refineTargetSet({
    targetSet: set,
    policy,
    context: {actor: {proficiencyBonus: 2}},
    decisions: [
      {operation: TARGET_OPERATIONS.SELECT, targetId: "a"},
      {operation: TARGET_OPERATIONS.SELECT, targetId: "b"},
      {operation: TARGET_OPERATIONS.SELECT, targetId: "c"}
    ]
  });
  assert.equal(result.code, TARGET_CODES.SELECTION_LIMIT_REACHED);
});

test("pure exclusion removes a target from final resolution", () => {
  const set = resolveTargetEligibility(createTargetSet([candidate("a"), candidate("b")]));
  const result = refineTargetSet({targetSet: set, decisions: [
    {operation: TARGET_OPERATIONS.EXCLUDE, targetId: "a"}
  ]});

  assert.deepEqual(result.finalTargets.map(t => t.id), ["b"]);
  assert.deepEqual(result.excluded, ["a"]);
});

test("resolution override keeps target in final set with override data", () => {
  const set = resolveTargetEligibility(createTargetSet([candidate("fighter", {disposition: "ally"})]));
  const result = refineTargetSet({targetSet: set, decisions: [
    attachTargetOverride("fighter", {type: TARGET_OVERRIDE_TYPES.AUTOMATIC_SUCCESS}, {type: "feature", slug: "protective-magic"})
  ]});

  assert.equal(result.finalTargets.length, 1);
  assert.equal(result.overrides.fighter[0].type, TARGET_OVERRIDE_TYPES.AUTOMATIC_SUCCESS);
  assert.deepEqual(result.overrides.fighter[0].source, {type: "feature", slug: "protective-magic"});
});

test("mixed target result separates excluded, overridden, and normal targets", () => {
  const set = resolveTargetEligibility(createTargetSet([
    candidate("excluded"),
    candidate("protected"),
    candidate("normal-a"),
    candidate("normal-b")
  ]));
  const result = refineTargetSet({targetSet: set, decisions: [
    {operation: TARGET_OPERATIONS.EXCLUDE, targetId: "excluded"},
    attachTargetOverride("protected", {type: TARGET_OVERRIDE_TYPES.HALF_DAMAGE})
  ]});

  assert.deepEqual(result.excluded, ["excluded"]);
  assert.equal(result.overrides.protected[0].type, TARGET_OVERRIDE_TYPES.HALF_DAMAGE);
  assert.deepEqual(result.finalTargets.map(t => t.id), ["protected", "normal-a", "normal-b"]);
  assert.equal(result.targetContexts.find(ctx => ctx.target.id === "excluded").resolutionState, "excluded");
});

test("large token intersecting multiple fields appears once with merged fields", () => {
  const set = createTargetSet([
    candidate("large", {intersectingFields: [{id: "a"}], occupiedFields: [{id: "o1"}]}),
    candidate("large", {intersectingFields: [{id: "b"}], occupiedFields: [{id: "o2"}]})
  ]);
  assert.equal(set.candidates.length, 1);
  assert.deepEqual(set.candidates[0].intersectingFields.map(f => f.id), ["a", "b"]);
  assert.deepEqual(set.candidates[0].occupiedFields.map(f => f.id), ["o1", "o2"]);
});

test("target refinement does not mutate the AoE footprint", () => {
  const footprint = {id: "fireball-footprint", fields: [{id: "f1"}, {id: "f2"}]};
  const set = resolveTargetEligibility(createTargetSet([candidate("a"), candidate("b")], {footprint}));
  const result = refineTargetSet({targetSet: set, decisions: [
    {operation: TARGET_OPERATIONS.DESELECT, targetId: "a"}
  ]});

  assert.equal(result.footprint, footprint);
  assert.deepEqual(footprint.fields.map(f => f.id), ["f1", "f2"]);
});

test("selection request exposes future UI battlefield states", () => {
  const set = resolveTargetEligibility(createTargetSet([
    candidate("ally", {disposition: "ally"}),
    candidate("enemy", {disposition: "enemy"})
  ]));
  const request = createTargetSelectionRequest({
    targetSet: set,
    policy: {
      defaultSelection: TARGET_DEFAULT_SELECTION.NONE,
      allowedOperations: [TARGET_OPERATIONS.SELECT],
      selectionPredicate: {equals: {path: "disposition", value: "ally"}}
    }
  });

  assert.equal(request.candidates.find(c => c.targetId === "ally").selectable, true);
  assert.equal(request.candidates.find(c => c.targetId === "enemy").selectable, false);
});

test("TargetSet operations add, remove, filter, partition, and apply predicates immutably", () => {
  const original = createTargetSet([
    candidate("ally", {disposition: "ally"}),
    candidate("enemy", {disposition: "enemy"})
  ]);
  const added = addTargetCandidate(original, candidate("object", {disposition: "neutral"}));
  const removed = removeTargetCandidate(added, "enemy");
  const allies = filterTargetSet(added, {equals: {path: "disposition", value: "ally"}});
  const partition = partitionTargetSet(added, {equals: {path: "disposition", value: "enemy"}});
  const applied = applyTargetPredicate(added, {oneOf: {path: "disposition", values: ["ally", "enemy"]}});

  assert.equal(targetSetContains(original, "object"), false);
  assert.equal(targetSetContains(added, "object"), true);
  assert.deepEqual(removed.candidates.map(t => t.id), ["ally", "object"]);
  assert.deepEqual(allies.candidates.map(t => t.id), ["ally"]);
  assert.deepEqual(partition.matching.candidates.map(t => t.id), ["enemy"]);
  assert.deepEqual(partition.rest.candidates.map(t => t.id), ["ally", "object"]);
  assert.equal(applied.ok, false);
  assert.deepEqual(applied.rejected.map(t => t.id), ["object"]);
});

test("target refinement trace preserves audit data for selected, excluded, and overridden targets", () => {
  const set = resolveTargetEligibility(createTargetSet([
    candidate("excluded"),
    candidate("protected"),
    candidate("normal")
  ], {footprint: {id: "aoe"}}));
  const result = refineTargetSet({targetSet: set, decisions: [
    {operation: TARGET_OPERATIONS.EXCLUDE, targetId: "excluded"},
    attachTargetOverride("protected", {type: TARGET_OVERRIDE_TYPES.ZERO_DAMAGE}, {type: "feature", slug: "ward"})
  ]});
  const trace = createTargetRefinementTrace(result, {label: "audit"});

  assert.equal(trace.label, "audit");
  assert.equal(trace.footprint.id, "aoe");
  assert.equal(trace.counts.physical, 3);
  assert.equal(trace.targets.find(t => t.targetId === "excluded").status, "excluded");
  assert.equal(trace.targets.find(t => t.targetId === "protected").status, "overridden");
  assert.equal(trace.targets.find(t => t.targetId === "normal").status, "selected");
  assert.equal(result.unchanged.length, 1);
  assert.equal(result.selectionDecisions.length, 2);
});
