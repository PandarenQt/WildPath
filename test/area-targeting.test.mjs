import {test} from "node:test";
import assert from "node:assert/strict";
import {
  AREA_TARGETING_CODES,
  resolveAreaTargetCandidates,
  resolveAreaTargetSet
} from "../module/helpers/area-targeting.mjs";
import {
  TARGET_OPERATIONS,
  TARGET_OVERRIDE_TYPES,
  attachTargetOverride
} from "../module/helpers/targeting.mjs";

function token(id, fields, data={}) {
  return {
    id,
    target: {id: `token-${id}`},
    actor: {id: `actor-${id}`},
    occupiedFields: fields.map(field => ({id: field})),
    kind: data.kind ?? "creature",
    disposition: data.disposition ?? "enemy",
    tags: data.tags ?? [],
    conditions: data.conditions ?? []
  };
}

test("area targeting adapts physical grid intersections without mutating the footprint", () => {
  const footprint = {id: "burst", fields: [{id: "a"}, {id: "b"}, {id: "c"}]};
  const result = resolveAreaTargetCandidates({
    footprint,
    tokenFootprints: [
      token("inside", ["a"]),
      token("large", ["b", "c", "d"]),
      token("outside", ["z"])
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, AREA_TARGETING_CODES.OK);
  assert.deepEqual(result.candidates.map(candidate => candidate.id), ["inside", "large"]);
  assert.deepEqual(result.targetSet.candidates.find(candidate => candidate.id === "large").intersectingFields.map(f => f.id), ["b", "c"]);
  assert.deepEqual(footprint.fields.map(field => field.id), ["a", "b", "c"]);
});

test("area targeting reports a structured failure when no footprint fields exist", () => {
  const result = resolveAreaTargetCandidates({footprint: {id: "empty", fields: []}, tokenFootprints: [token("a", ["a"])]});
  assert.equal(result.ok, false);
  assert.equal(result.code, AREA_TARGETING_CODES.NO_FOOTPRINT);
  assert.equal(result.targetSet.candidates.length, 0);
});

test("area targeting pipeline supports eligibility, refinement, and per-target overrides", () => {
  const footprint = {id: "fireball", fields: ["a", "b", "c", "d", "e", "f"]};
  const result = resolveAreaTargetSet({
    footprint,
    tokenFootprints: [
      token("enemy-a", ["a"], {disposition: "enemy"}),
      token("enemy-b", ["b"], {disposition: "enemy"}),
      token("enemy-c", ["c"], {disposition: "enemy"}),
      token("ally-a", ["d"], {disposition: "ally"}),
      token("ally-b", ["e"], {disposition: "ally"}),
      token("crate", ["f"], {kind: "object", disposition: "neutral"})
    ],
    eligibilityPolicy: {kinds: ["creature"]},
    refinementPolicy: {
      allowedOperations: [TARGET_OPERATIONS.OVERRIDE],
      selectionPredicate: {equals: {path: "disposition", value: "ally"}},
      maxChoices: 2
    },
    decisions: [
      attachTargetOverride("ally-a", {type: TARGET_OVERRIDE_TYPES.AUTOMATIC_SUCCESS}, {type: "feature", slug: "protect"}),
      attachTargetOverride("ally-b", {type: TARGET_OVERRIDE_TYPES.ZERO_DAMAGE}, {type: "feature", slug: "protect"})
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.physical.candidates.length, 6);
  assert.equal(result.eligible.candidates.filter(candidate => candidate.eligibility.ok).length, 5);
  assert.equal(result.refinement.finalTargets.length, 5);
  assert.equal(Object.keys(result.refinement.overrides).length, 2);
  assert.deepEqual(result.refinement.unchanged.map(target => target.id), ["enemy-a", "enemy-b", "enemy-c"]);
});
