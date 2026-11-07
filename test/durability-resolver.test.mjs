import {test} from "node:test";
import assert from "node:assert/strict";
import {
  DURABILITY_RESOLUTION_CODES,
  commitActorDurabilityMutationPlan,
  createActorDamageMutationPlan,
  createActorDurabilityMutationPlan,
  createActorHealingMutationPlan,
  rebaseActorDurabilityMutationPlan,
  revertActorDurabilityMutationPlan
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

test("Temporary Hit Points are lost first, never stack, and are rolled back with the damage", async () => {
  const shielded = actorSystem({resources: {health: {value: 10, max: 20, temp: 5}}});
  const hit = createActorDamageMutationPlan(shielded, {amount: 8});
  assert.deepEqual([hit.amount, hit.to, hit.temporary, hit.updates],
    [3, 7, {path: "system.resources.health.temp", from: 5, to: 0}, {"system.resources.health.temp": 0, "system.resources.health.value": 7}]);
  const grazed = createActorDamageMutationPlan(shielded, {amount: 3});
  assert.deepEqual([grazed.amount, grazed.updates], [0, {"system.resources.health.temp": 2}],
    "all absorbed: no damage reaches health (no failed death save at 0)");
  assert.equal(createActorDamageMutationPlan(actorSystem(), {amount: 3}).temporary, undefined, "none to lose");

  const gain = healingResult => createActorHealingMutationPlan(shielded, {healingResult});
  assert.deepEqual(gain({total: 9, byHealingType: {temporary: 9}}).updates, {"system.resources.health.temp": 9}, "False Life: higher replaces");
  assert.deepEqual(gain({total: 4, byHealingType: {temporary: 4}}).updates, {}, "lower is kept away: they never stack");
  assert.deepEqual(gain({total: 10, byHealingType: {healing: 4, temporary: 6}}).updates,
    {"system.resources.health.value": 14, "system.resources.health.temp": 6}, "healing and Temporary Hit Points apart");

  const {createActorUpdateTransactionOperation} = await import("../module/resolvers/resolution-transaction-resolver.mjs");
  assert.deepEqual(createActorUpdateTransactionOperation({mutationPlan: hit}).rollbackUpdates,
    {"system.resources.health.value": 10, "system.resources.health.temp": 5});
});

test("healing in a form whose Hit Points are Temporary Hit Points heals the form, up to its own (2014 Wild Shape)", () => {
  const wolf = (temp) => ({resources: {health: {value: 10, max: 20, temp}}, formHealth: 11});
  const some = createActorHealingMutationPlan(wolf(3), {amount: 5});
  assert.equal(some.ok, true);
  assert.equal(some.updates["system.resources.health.temp"], 8, "the form's 3 healed by 5");
  assert.equal(some.updates["system.resources.health.value"] ?? 10, 10, "the druid's own Hit Points are untouched");
  assert.equal(createActorHealingMutationPlan(wolf(3), {amount: 20}).updates["system.resources.health.temp"], 11, "no more than the form's");
  assert.equal(createActorHealingMutationPlan({resources: {health: {value: 10, max: 20, temp: 3}}}, {amount: 5}).updates["system.resources.health.value"],
    15, "out of a form, healing is as ever");
});

/* -------------------------------------------- */
/*  Rebase at commit (two Actions planned from one snapshot)  */
/* -------------------------------------------- */

const health = (value, max=20, temp=undefined) => ({resources: {health: {value, max, ...(temp === undefined ? {} : {temp})}}, pools: []});
const hurt = (system, amount) => createActorDamageMutationPlan(system, {amount, metadata: {damageResult: {byDamageType: {fire: amount}}}});
const fromTo = plan => [plan.from, plan.to, plan.updates];

test("rebase: a plan whose creature is as planned commits unchanged, the same object", () => {
  const plan = hurt(health(14), 6);
  assert.equal(rebaseActorDurabilityMutationPlan(health(14), plan), plan);
  const healing = createActorHealingMutationPlan(health(5), {amount: 3});
  assert.equal(rebaseActorDurabilityMutationPlan(health(5, 20, 4), healing), healing, "healing ignores Temporary Hit Points it does not set");
});

test("rebase: damage planned 14 -> 8 lands on the 8 another Action left, keeping its amount and damage types", () => {
  const plan = hurt(health(14), 6);
  const rebased = rebaseActorDurabilityMutationPlan(health(8), plan);
  assert.deepEqual(fromTo(rebased), [8, 2, {"system.resources.health.value": 2}]);
  assert.equal(rebased.rebased, true);
  assert.equal(rebased.amount, 6);
  assert.deepEqual(rebased.metadata.damageResult, {byDamageType: {fire: 6}}, "metadata is not wrapped twice");
  assert.equal(rebased.zeroHpUnchecked, undefined);
});

test("rebase: Temporary Hit Points gained since planning absorb first; ones lost since no longer do", () => {
  const gained = rebaseActorDurabilityMutationPlan(health(14, 20, 4), hurt(health(14), 6));
  assert.deepEqual(fromTo(gained), [14, 12, {"system.resources.health.value": 12, "system.resources.health.temp": 0}]);
  assert.deepEqual(gained.temporary, {path: "system.resources.health.temp", from: 4, to: 0});
  const planned = hurt(health(14, 20, 4), 6);
  assert.deepEqual(fromTo(planned), [14, 12, {"system.resources.health.value": 12, "system.resources.health.temp": 0}]);
  const lost = rebaseActorDurabilityMutationPlan(health(14, 20, 0), planned);
  assert.deepEqual(fromTo(lost), [14, 8, {"system.resources.health.value": 8}], "all 6 reach its Hit Points");
  assert.equal(lost.temporary, undefined);
});

test("rebase: a planned drop to 0 that the live health survives is plain damage; a new drop is flagged unless massive", () => {
  const planned = hurt(health(4), 6);
  assert.deepEqual([planned.to, planned.overflow], [0, 2]);
  const survived = rebaseActorDurabilityMutationPlan(health(10), planned);
  assert.deepEqual(fromTo(survived), [10, 4, {"system.resources.health.value": 4}]);
  assert.equal(survived.zeroHpUnchecked, undefined);
  const dropped = rebaseActorDurabilityMutationPlan(health(4), hurt(health(14), 6));
  assert.deepEqual([dropped.to, dropped.zeroHpUnchecked], [0, true], "planning saw no drop: its rescue is checked after commit");
  // Planned against 10 Temporary Hit Points that are gone by commit: all 9 reach its 4 Hit Points.
  const massive = rebaseActorDurabilityMutationPlan(health(4, 4, 0), hurt(health(4, 4, 10), 9));
  assert.deepEqual([massive.to, massive.overflow, massive.zeroHpUnchecked], [0, 5, undefined], "massive damage kills: no rescue");
});

test("rebase: a creature kept up at 0 (to raised) stays kept while it still drops, and takes plain damage once it no longer does", () => {
  const planned = hurt(health(4), 6);
  const kept = {...planned, to: 1, updates: {"system.resources.health.value": 1}};
  const still = rebaseActorDurabilityMutationPlan(health(3), kept);
  assert.deepEqual(fromTo(still), [3, 1, {"system.resources.health.value": 1}]);
  assert.equal(still.zeroHpUnchecked, undefined);
  const natural = rebaseActorDurabilityMutationPlan(health(12), kept);
  assert.deepEqual(fromTo(natural), [12, 6, {"system.resources.health.value": 6}]);
});

test("rebase: healing redoes its clamp on the live health; Temporary Hit Points take the higher", () => {
  const plan = createActorHealingMutationPlan(health(2), {amount: 5});
  assert.deepEqual(fromTo(rebaseActorDurabilityMutationPlan(health(0), plan)), [0, 5, {"system.resources.health.value": 5}]);
  assert.deepEqual(fromTo(rebaseActorDurabilityMutationPlan(health(9, 10), createActorHealingMutationPlan(health(2, 10), {amount: 5}))),
    [9, 10, {"system.resources.health.value": 10}]);
  const temporary = createActorHealingMutationPlan(health(10, 20, 2), {healingResult: {total: 6, byHealingType: {temporary: 6}}});
  assert.deepEqual(temporary.temporary, {path: "system.resources.health.temp", from: 2, to: 6});
  const higher = rebaseActorDurabilityMutationPlan(health(10, 20, 8), temporary);
  assert.equal(higher.updates["system.resources.health.temp"], 8, "8 it has now beats the 6 given");
  const lower = rebaseActorDurabilityMutationPlan(health(10, 20, 3), temporary);
  assert.deepEqual([lower.temporary.from, lower.updates["system.resources.health.temp"]], [3, 6]);
});

test("rebase: a pool's damage writes the pool's index in the live snapshot", () => {
  const plan = createActorDamageMutationPlan({resources: {}, pools: [{id: "ward", value: 10, max: 10}]}, {amount: 4, resourceId: "ward"});
  assert.equal(plan.path, "system.pools.0.value");
  const rebased = rebaseActorDurabilityMutationPlan({resources: {}, pools: [{id: "ki", value: 3, max: 3}, {id: "ward", value: 10, max: 10}]}, plan);
  assert.deepEqual(fromTo(rebased), [10, 6, {"system.pools.1.value": 6}]);
});

test("revert: takes back only its own change, so a write after it stays", () => {
  const committed = hurt(health(14), 6);
  assert.deepEqual(revertActorDurabilityMutationPlan(health(8), committed), {"system.resources.health.value": 14}, "nothing in between: its from");
  assert.deepEqual(revertActorDurabilityMutationPlan(health(2), committed), {"system.resources.health.value": 8}, "another 6 since stays");
  const absorbed = hurt(health(14, 20, 4), 6);
  assert.deepEqual(revertActorDurabilityMutationPlan(health(12, 20, 0), absorbed),
    {"system.resources.health.value": 14, "system.resources.health.temp": 4});
  assert.deepEqual(revertActorDurabilityMutationPlan(health(20, 20), createActorHealingMutationPlan(health(18), {amount: 5})),
    {"system.resources.health.value": 18});
});

test("rebase: a 2014 form's healing heals the form on what it has now, up to the form's own", () => {
  const form = temp => ({...health(30, 30, temp), formHealth: 20});
  const plan = createActorHealingMutationPlan(form(10), {healingResult: {total: 5, byHealingType: {healing: 5}}});
  assert.deepEqual([plan.temporary.from, plan.temporary.to], [10, 15]);
  const hit = rebaseActorDurabilityMutationPlan(form(2), plan);
  assert.equal(hit.updates["system.resources.health.temp"], 7, "8 damage to the form since stays taken");
  assert.equal(hit.updates["system.resources.health.value"], undefined, "its own Hit Points untouched");
  assert.equal(rebaseActorDurabilityMutationPlan(form(18), plan).updates["system.resources.health.temp"], 20, "capped at the form's 20");
});

test("revert: from what landed, so a heal the creature refused (no healing) takes nothing back", () => {
  const committed = createActorHealingMutationPlan(health(10), {amount: 5});
  assert.deepEqual(revertActorDurabilityMutationPlan(health(10), committed, health(10)), {"system.resources.health.value": 10});
  assert.deepEqual(revertActorDurabilityMutationPlan(health(15), committed, health(15)), {"system.resources.health.value": 10});
});
