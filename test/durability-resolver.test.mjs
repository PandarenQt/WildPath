import {test} from "node:test";
import assert from "node:assert/strict";
import {
  DURABILITY_RESOLUTION_CODES,
  commitActorDurabilityMutationPlan,
  createActorDamageMutationPlan,
  createActorDurabilityMutationPlan,
  createActorHealingMutationPlan
} from "../module/resolvers/durability-resolver.mjs";

function actorSystem(overrides={}) {
  return {
    resources: {
      health: {value: 10, max: 20},
      ...(overrides.resources ?? {})
    },
    pools: overrides.pools ?? []
  };
}

test("damage mutation planning reduces health without mutating Actor system data", () => {
  const system = actorSystem();
  const plan = createActorDamageMutationPlan(system, {
    amount: 7,
    source: {actorId: "attacker"},
    target: {actorId: "defender"}
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.code, DURABILITY_RESOLUTION_CODES.OK);
  assert.equal(plan.from, 10);
  assert.equal(plan.to, 3);
  assert.equal(plan.appliedAmount, 7);
  assert.equal(plan.overflow, 0);
  assert.deepEqual(plan.updates, {"system.resources.health.value": 3});
  assert.equal(system.resources.health.value, 10);
});

test("damage mutation planning clamps at zero and records overflow", () => {
  const plan = createActorDamageMutationPlan(actorSystem(), {amount: 15});

  assert.equal(plan.to, 0);
  assert.equal(plan.appliedAmount, 10);
  assert.equal(plan.overflow, 5);
  assert.deepEqual(plan.updates, {"system.resources.health.value": 0});
});

for ( const max of [30, 10] ) {
  test(`six damage from 30 health applies exactly six with maximum ${max}`, () => {
    const plan = createActorDamageMutationPlan(actorSystem({resources: {health: {value: 30, max}}}), {amount: 6});
    assert.equal(plan.ok, true);
    assert.equal(plan.from, 30);
    assert.equal(plan.to, 24);
    assert.equal(plan.max, max);
    assert.equal(plan.appliedAmount, 6);
    assert.equal(plan.overflow, 0);
    assert.deepEqual(plan.updates, {"system.resources.health.value": 24});
  });
}

test("over-max healing is a no-op with the whole request recorded as overheal", async () => {
  const plan = createActorHealingMutationPlan(actorSystem({resources: {health: {value: 30, max: 10}}}), {amount: 6});
  assert.equal(plan.ok, true);
  assert.equal(plan.from, 30);
  assert.equal(plan.to, 30);
  assert.equal(plan.appliedAmount, 0);
  assert.equal(plan.overheal, 6);
  assert.deepEqual(plan.updates, {});
  assert.equal(await commitActorDurabilityMutationPlan({update() { assert.fail("No-op healing must not persist"); }}, plan), true);
});

test("damage and healing preserve direction and amount invariants for built-ins and custom pools", () => {
  for ( const type of ["damage", "healing"] ) {
    for ( const value of [0, 0.5, 10, 30] ) {
      for ( const max of [0, 0.5, 10, 30, 35] ) {
        for ( const amount of [0, 0.25, 6, 15, 40] ) {
          for ( const resourceId of ["health", "ward"] ) {
            const system = actorSystem({resources: {health: {value, max}}, pools: [{id: "ward", value, max}]});
            const plan = createActorDurabilityMutationPlan(system, {type, amount, resourceId});
            const context = JSON.stringify({type, value, max, amount, resourceId});
            const remainder = type === "damage" ? plan.overflow : plan.overheal;
            assert.equal(plan.ok, true, context);
            assert.ok(type === "damage" ? plan.to <= plan.from : plan.to >= plan.from, context);
            assert.ok(plan.appliedAmount >= 0 && plan.appliedAmount <= amount, context);
            assert.ok(remainder >= 0, context);
            assert.equal(plan.appliedAmount + remainder, amount, context);
            assert.equal(Math.abs(plan.to - plan.from), plan.appliedAmount, context);
            if (type === "damage") assert.ok(plan.to >= 0, context);
            else if (value <= max) assert.ok(plan.to <= max, context);
            assert.equal(system.resources.health.value, value);
            assert.equal(system.pools[0].value, value);
          }
        }
      }
    }
  }
});

test("healing mutation planning clamps at maximum and records overheal", () => {
  const plan = createActorHealingMutationPlan(actorSystem(), {amount: 15});

  assert.equal(plan.to, 20);
  assert.equal(plan.appliedAmount, 10);
  assert.equal(plan.overheal, 5);
  assert.deepEqual(plan.updates, {"system.resources.health.value": 20});
});

test("zero or capped durability changes can produce no-op mutation plans", () => {
  const zeroDamage = createActorDamageMutationPlan(actorSystem(), {amount: 0});
  const fullHealing = createActorHealingMutationPlan(actorSystem({resources: {health: {value: 20, max: 20}}}), {amount: 5});

  assert.equal(zeroDamage.ok, true);
  assert.deepEqual(zeroDamage.updates, {});
  assert.equal(fullHealing.ok, true);
  assert.equal(fullHealing.overheal, 5);
  assert.deepEqual(fullHealing.updates, {});
});

test("durability mutation planning can target custom resource pools", () => {
  const plan = createActorDurabilityMutationPlan(actorSystem({
    pools: [
      {id: "shield", value: 6, max: 10},
      {id: "ward", value: 3, max: 3}
    ]
  }), {
    type: "damage",
    resourceId: "shield",
    amount: 4
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.path, "system.pools.0.value");
  assert.deepEqual(plan.updates, {"system.pools.0.value": 2});
});

test("durability mutation planning rejects missing resources and invalid amounts", () => {
  const missing = createActorDamageMutationPlan(actorSystem(), {resourceId: "stamina", amount: 2});
  const invalidAmount = createActorDamageMutationPlan(actorSystem(), {amount: -1});
  const invalidType = createActorDurabilityMutationPlan(actorSystem(), {type: "drain", amount: 1});

  assert.equal(missing.ok, false);
  assert.equal(missing.code, DURABILITY_RESOLUTION_CODES.RESOURCE_NOT_FOUND);
  assert.equal(invalidAmount.ok, false);
  assert.equal(invalidAmount.code, DURABILITY_RESOLUTION_CODES.INVALID_AMOUNT);
  assert.equal(invalidType.ok, false);
  assert.equal(invalidType.code, DURABILITY_RESOLUTION_CODES.INVALID_CHANGE_TYPE);
});

test("damage mutation planning can consume a DamageResolver target result", () => {
  const damageResult = {
    target: {id: "orc", actorId: "actor-orc"},
    total: 6,
    byDamageType: {slashing: 6}
  };
  const plan = createActorDamageMutationPlan(actorSystem(), {damageResult});

  assert.equal(plan.to, 4);
  assert.deepEqual(plan.target, {id: "orc", actorId: "actor-orc"});
  assert.deepEqual(plan.metadata.damageResult.byDamageType, {slashing: 6});
});

test("commit adapter calls Actor.update with planned durability updates", async () => {
  const plan = createActorDamageMutationPlan(actorSystem(), {amount: 4});
  const calls = [];
  const actor = {
    async update(updates) {
      calls.push(updates);
    }
  };

  assert.equal(await commitActorDurabilityMutationPlan(actor, plan), true);
  assert.deepEqual(calls, [{"system.resources.health.value": 6}]);
});

test("commit adapter treats no-op plans as successful without calling update", async () => {
  const plan = createActorDamageMutationPlan(actorSystem(), {amount: 0});
  const actor = {
    called: false,
    async update() {
      this.called = true;
    }
  };

  assert.equal(await commitActorDurabilityMutationPlan(actor, plan), true);
  assert.equal(actor.called, false);
});
