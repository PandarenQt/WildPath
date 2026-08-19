import {test} from "node:test";
import assert from "node:assert/strict";
import {
  TARGET_DEFAULT_SELECTION,
  TARGET_OPERATIONS,
  createTargetSet
} from "../module/helpers/targeting.mjs";
import {
  TARGET_RESOLVER_CODES,
  createSelfTargetSet,
  resolveActionTargets
} from "../module/resolvers/target-resolver.mjs";

const target = (id, data={}) => ({
  id,
  actorId: `actor-${id}`,
  tokenId: `token-${id}`,
  disposition: data.disposition ?? "enemy",
  type: data.type ?? "creature",
  tags: data.tags ?? []
});

test("TargetResolver allows empty target sets when no target is required", () => {
  const result = resolveActionTargets();

  assert.equal(result.ok, true);
  assert.equal(result.code, TARGET_RESOLVER_CODES.OK);
  assert.equal(result.targetContexts.length, 0);
});

test("TargetResolver reports a required target missing before eligibility", () => {
  const result = resolveActionTargets({required: true});

  assert.equal(result.ok, false);
  assert.equal(result.code, TARGET_RESOLVER_CODES.NO_TARGETS);
  assert.equal(result.reason, "at least one target is required");
});

test("self target set normalizes source references into a target context", () => {
  const self = createSelfTargetSet({
    actorId: "actor-a",
    tokenId: "token-a",
    name: "Aria",
    type: "creature",
    tags: ["self"]
  });
  const result = resolveActionTargets({targetSet: self, required: true});

  assert.equal(result.ok, true);
  assert.deepEqual(result.refinement.finalTargets.map(target => target.id), ["token-a"]);
  assert.equal(result.targetContexts[0].target.actor.id, "actor-a");
});

test("TargetResolver applies eligibility policy and keeps rejected candidates for audit", () => {
  const result = resolveActionTargets({
    targets: [
      target("ally", {disposition: "ally"}),
      target("enemy", {disposition: "enemy"})
    ],
    eligibilityPolicy: {dispositions: ["enemy"]},
    required: true
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.refinement.finalTargets.map(target => target.id), ["enemy"]);
  assert.equal(result.eligible.candidates.find(candidate => candidate.id === "ally").eligibility.ok, false);
  assert.equal(result.eligible.candidates.find(candidate => candidate.id === "enemy").eligibility.ok, true);
});

test("TargetResolver returns structured targeting failures from refinement validation", () => {
  const result = resolveActionTargets({
    targets: [target("a"), target("b"), target("c")],
    refinementPolicy: {
      defaultSelection: TARGET_DEFAULT_SELECTION.NONE,
      allowedOperations: [TARGET_OPERATIONS.SELECT],
      maxSelections: 2
    },
    decisions: [
      {operation: TARGET_OPERATIONS.SELECT, targetId: "a"},
      {operation: TARGET_OPERATIONS.SELECT, targetId: "b"},
      {operation: TARGET_OPERATIONS.SELECT, targetId: "c"}
    ],
    required: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, TARGET_RESOLVER_CODES.TARGETING_FAILED);
  assert.equal(result.selectionRequest.validation.length, 1);
});

test("TargetResolver reports no valid targets when required targets are deselected", () => {
  const result = resolveActionTargets({
    targets: [target("a")],
    refinementPolicy: {
      allowedOperations: [TARGET_OPERATIONS.DESELECT]
    },
    decisions: [{operation: TARGET_OPERATIONS.DESELECT, targetId: "a"}],
    required: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, TARGET_RESOLVER_CODES.NO_VALID_TARGETS);
});

test("TargetResolver does not mutate an input target set", () => {
  const input = createTargetSet([
    {
      id: "original",
      target: {id: "token-original"},
      actor: {id: "actor-original"},
      disposition: "enemy",
      tags: ["spell"]
    }
  ]);
  const result = resolveActionTargets({
    targetSet: input,
    eligibilityPolicy: {dispositions: ["ally"]},
    refinementPolicy: {
      defaultSelection: TARGET_DEFAULT_SELECTION.NONE,
      allowedOperations: [TARGET_OPERATIONS.SELECT]
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.eligible.candidates[0].eligibility.ok, false);
  assert.equal(input.candidates[0].eligibility.ok, true);
  assert.deepEqual(input.candidates[0].tags, ["spell"]);
});
