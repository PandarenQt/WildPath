import {test} from "node:test";
import assert from "node:assert/strict";
import {resolveDamageTargets} from "../module/resolvers/damage-resolver.mjs";
import {
  DAMAGE_DURABILITY_MUTATION_TYPES,
  DAMAGE_DURABILITY_RESOLUTION_CODES,
  planDamageDurabilityMutations
} from "../module/resolvers/damage-durability-resolver.mjs";

function actorSystem(value=12, max=20) {
  return {
    resources: {
      health: {value, max}
    },
    pools: []
  };
}

test("damage durability bridge creates target Actor mutation plans from damage results", () => {
  const damageResolution = resolveDamageTargets({
    components: [{id: "slash", amount: 5, damageType: "slashing"}],
    targets: [{id: "orc", actorId: "actor-orc", tokenId: "token-orc"}]
  });
  const targetSystem = actorSystem(12, 20);
  const result = planDamageDurabilityMutations({
    damageResolution,
    targetSystems: {
      "actor:actor-orc": targetSystem
    },
    source: "actor:attacker"
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, DAMAGE_DURABILITY_RESOLUTION_CODES.OK);
  assert.equal(result.mutationPlans[0].type, DAMAGE_DURABILITY_MUTATION_TYPES.DAMAGE);
  assert.equal(result.mutationPlans[0].targetRef, "token:token-orc");
  assert.deepEqual(result.mutationPlans[0].plan.updates, {"system.resources.health.value": 7});
  assert.equal(targetSystem.resources.health.value, 12);
});

test("damage durability bridge applies target damage adjustments before HP planning", () => {
  const damageResolution = resolveDamageTargets({
    components: [
      {id: "flame", amount: 10, damageType: "fire"},
      {id: "slash", amount: 5, damageType: "slashing"}
    ],
    targets: [{id: "tiefling", actorId: "actor-tiefling"}]
  });
  const result = planDamageDurabilityMutations({
    damageResolution,
    targetSystems: {"actor:actor-tiefling": actorSystem(20, 20)},
    adjustmentProfiles: {
      "actor:actor-tiefling": {
        resistances: ["fire"],
        reductions: [{id: "shield", type: "flat", amount: 2, damageTypes: ["slashing"]}]
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.mutationPlans[0].plan.amount, 8);
  assert.deepEqual(result.mutationPlans[0].plan.updates, {"system.resources.health.value": 12});
  assert.equal(result.mutationPlans[0].plan.metadata.damageResult.total, 8);
  assert.equal(result.mutationPlans[0].plan.metadata.originalDamageResult.total, 15);
});

test("damage durability bridge can look up target systems by raw ids or Map refs", () => {
  const damageResolution = resolveDamageTargets({
    components: [{id: "bolt", amount: 3, damageType: "force"}],
    targets: [
      {id: "goblin", actorId: "actor-goblin"},
      {id: "kobold", actorId: "actor-kobold"}
    ]
  });
  const targetSystems = new Map([
    ["actor-goblin", actorSystem(8, 10)],
    ["actor:actor-kobold", actorSystem(6, 8)]
  ]);
  const result = planDamageDurabilityMutations({damageResolution, targetSystems});

  assert.equal(result.ok, true);
  assert.deepEqual(result.mutationPlans.map(entry => entry.plan.to), [5, 3]);
});

test("damage durability bridge reports missing target systems explicitly", () => {
  const damageResolution = resolveDamageTargets({
    components: [{id: "burn", amount: 2, damageType: "fire"}],
    targets: [{id: "wisp", actorId: "actor-wisp"}]
  });
  const result = planDamageDurabilityMutations({damageResolution, targetSystems: {}});

  assert.equal(result.ok, false);
  assert.equal(result.code, DAMAGE_DURABILITY_RESOLUTION_CODES.TARGET_ACTOR_SYSTEM_NOT_FOUND);
  assert.equal(result.failures[0].target.actorId, "actor-wisp");
  assert.equal(result.mutationPlans.length, 0);
});

test("damage durability bridge treats skipped damage targets as non-mutating", () => {
  const damageResolution = {
    ok: true,
    code: "OK",
    results: [{
      ok: true,
      code: "TARGET_SKIPPED",
      target: {id: "missed", actorId: "actor-missed"},
      total: 0,
      reason: "attack did not hit"
    }]
  };
  const result = planDamageDurabilityMutations({
    damageResolution,
    targetSystems: {"actor:actor-missed": actorSystem()}
  });

  assert.equal(result.ok, true);
  assert.equal(result.mutationPlans.length, 0);
  assert.equal(result.skipped[0].target.id, "missed");
});
