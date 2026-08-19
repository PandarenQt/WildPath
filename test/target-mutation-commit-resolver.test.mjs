import {test} from "node:test";
import assert from "node:assert/strict";
import {
  TARGET_MUTATION_COMMIT_CODES,
  commitTargetMutationPlans
} from "../module/resolvers/target-mutation-commit-resolver.mjs";

function mutationPlan() {
  return {
    type: "durabilityDamage",
    targetRef: "actor:actor-orc",
    target: {id: "orc", actorId: "actor-orc"},
    plan: {
      ok: true,
      updates: {"system.resources.health.value": 4}
    }
  };
}

test("target mutation commit adapter commits with explicit active GM authority", async () => {
  const calls = [];
  const targetActor = {
    id: "actor-orc",
    async update(updates) {
      calls.push(updates);
    }
  };
  const result = await commitTargetMutationPlans({
    mutationPlans: [mutationPlan()],
    targetActors: {"actor:actor-orc": targetActor},
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"}
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, TARGET_MUTATION_COMMIT_CODES.OK);
  assert.deepEqual(calls, [{"system.resources.health.value": 4}]);
  assert.equal(result.committed[0].targetRef, "actor:actor-orc");
});

test("target mutation commit adapter rejects missing authority and missing actors", async () => {
  const unauthorized = await commitTargetMutationPlans({
    mutationPlans: [mutationPlan()],
    targetActors: {"actor:actor-orc": {id: "actor-orc", async update() {}}},
    authority: {isGM: false, userId: "player-a"}
  });
  const missingActor = await commitTargetMutationPlans({
    mutationPlans: [mutationPlan()],
    targetActors: {},
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"}
  });

  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.code, TARGET_MUTATION_COMMIT_CODES.COMMIT_NOT_AUTHORIZED);
  assert.equal(missingActor.ok, false);
  assert.equal(missingActor.code, TARGET_MUTATION_COMMIT_CODES.TARGET_ACTOR_NOT_FOUND);
});

test("target mutation commit adapter supports authority functions", async () => {
  const calls = [];
  const result = await commitTargetMutationPlans({
    mutationPlans: [mutationPlan()],
    targetActors: [{id: "actor-orc", async update(updates) { calls.push(updates); }}],
    authority: ({target}) => target.actorId === "actor-orc"
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{"system.resources.health.value": 4}]);
});
