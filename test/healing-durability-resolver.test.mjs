import {test} from "node:test";
import assert from "node:assert/strict";
import {resolveHealingTargets} from "../module/resolvers/healing-resolver.mjs";
import {
  HEALING_DURABILITY_MUTATION_TYPES,
  HEALING_DURABILITY_RESOLUTION_CODES,
  planHealingDurabilityMutations
} from "../module/resolvers/healing-durability-resolver.mjs";

function actorSystem(value=4, max=12) {
  return {
    resources: {
      health: {value, max}
    },
    pools: []
  };
}

test("healing durability bridge creates target Actor healing plans", () => {
  const healingResolution = resolveHealingTargets({
    components: [{id: "cure", amount: 5, healingType: "vitality"}],
    targets: [{id: "ally", actorId: "actor-ally", tokenId: "token-ally"}]
  });
  const targetSystem = actorSystem(4, 12);
  const result = planHealingDurabilityMutations({
    healingResolution,
    targetSystems: {"actor:actor-ally": targetSystem},
    source: "actor:cleric"
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, HEALING_DURABILITY_RESOLUTION_CODES.OK);
  assert.equal(result.mutationPlans[0].type, HEALING_DURABILITY_MUTATION_TYPES.HEALING);
  assert.equal(result.mutationPlans[0].targetRef, "token:token-ally");
  assert.deepEqual(result.mutationPlans[0].plan.updates, {"system.resources.health.value": 9});
  assert.equal(targetSystem.resources.health.value, 4);
});

test("healing durability bridge clamps overheal and reports missing target systems", () => {
  const healingResolution = resolveHealingTargets({
    components: [{id: "cure", amount: 9}],
    targets: [
      {id: "ally", actorId: "actor-ally"},
      {id: "missing", actorId: "actor-missing"}
    ]
  });
  const result = planHealingDurabilityMutations({
    healingResolution,
    targetSystems: {"actor:actor-ally": actorSystem(10, 12)}
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, HEALING_DURABILITY_RESOLUTION_CODES.TARGET_ACTOR_SYSTEM_NOT_FOUND);
  assert.equal(result.mutationPlans[0].plan.to, 12);
  assert.equal(result.mutationPlans[0].plan.overheal, 7);
  assert.equal(result.failures[0].target.actorId, "actor-missing");
});
