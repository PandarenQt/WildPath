import {test} from "node:test";
import assert from "node:assert/strict";
import {ECONOMY_CAPABILITIES} from "../module/helpers/action-economy.mjs";
import {
  RESOURCE_RESOLUTION_CODES,
  commitActorResourceMutationPlan,
  createActorResourceMutationPlan,
  resolveActorResourcePayment
} from "../module/resolvers/resource-resolver.mjs";

function actorSystem(overrides={}) {
  return {
    resources: {
      action: {value: 1, max: 1},
      bonus: {value: 1, max: 1},
      reaction: {value: 1, max: 1},
      movement: {value: 30, max: 30},
      ...(overrides.resources ?? {})
    },
    pools: overrides.pools ?? []
  };
}

test("resource resolver maps Action payment to Actor update paths without mutation", () => {
  const system = actorSystem();
  const result = resolveActorResourcePayment({
    actorSystem: system,
    cost: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]},
    action: {id: "strike", tags: ["weapon-attack"]}
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, RESOURCE_RESOLUTION_CODES.OK);
  assert.deepEqual(result.mutationPlan.updates, {"system.resources.action.value": 0});
  assert.equal(result.resourcesAfter.find(resource => resource.id === "economy.action").current, 0);
  assert.equal(system.resources.action.value, 1);
});

test("selected alternative payment can spend Action for a Bonus Action requirement", () => {
  const system = actorSystem({
    resources: {
      bonus: {value: 0, max: 1}
    }
  });
  const result = resolveActorResourcePayment({
    actorSystem: system,
    cost: {allOf: [{capability: ECONOMY_CAPABILITIES.BONUS_ACTION, amount: 1}]},
    policies: {allowActionForSpentBonusAction: true}
  });

  assert.equal(result.ok, true);
  assert.equal(result.paymentPlan.mode, "alternative");
  assert.equal(result.paymentPlan.resources[0].resourceId, "economy.action");
  assert.deepEqual(result.mutationPlan.updates, {"system.resources.action.value": 0});
});

test("resource resolver uses Action for spent Bonus Action requirements by default", () => {
  const system = actorSystem({
    resources: {
      action: {value: 1, max: 1},
      bonus: {value: 0, max: 1}
    }
  });
  const result = resolveActorResourcePayment({
    actorSystem: system,
    cost: {allOf: [{capability: ECONOMY_CAPABILITIES.BONUS_ACTION, amount: 1}]}
  });

  assert.equal(result.ok, true);
  assert.equal(result.paymentPlan.mode, "alternative");
  assert.equal(result.paymentPlan.resources[0].resourceId, "economy.action");
  assert.equal(result.paymentPlan.resources[0].policy, "action-for-spent-bonus-action");
  assert.deepEqual(result.mutationPlan.updates, {"system.resources.action.value": 0});
});

test("custom Actor pools map to indexed Actor update paths", () => {
  const system = actorSystem({
    pools: [
      {id: "focus", value: 3, max: 3},
      {id: "ki", value: 2, max: 2}
    ]
  });
  const result = resolveActorResourcePayment({
    actorSystem: system,
    cost: {allOf: [{capability: "ki", amount: 2}]}
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.mutationPlan.updates, {"system.pools.1.value": 0});
  assert.equal(result.mutationPlan.payments[0].actorResourceId, "ki");
});

test("payment planning rejects insufficient resources before mutation planning", () => {
  const result = resolveActorResourcePayment({
    actorSystem: actorSystem({resources: {action: {value: 0, max: 1}}}),
    cost: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]}
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, RESOURCE_RESOLUTION_CODES.PAYMENT_UNAVAILABLE);
  assert.equal(result.mutationPlan, null);
});

test("mutation planning rejects missing custom resources", () => {
  const plan = createActorResourceMutationPlan(actorSystem(), {
    resources: [{resourceId: "spell-slot.1", amount: 1}]
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.code, RESOURCE_RESOLUTION_CODES.RESOURCE_NOT_FOUND);
  assert.deepEqual(plan.updates, {});
});

test("zero-cost resource payment succeeds with an empty mutation plan", async () => {
  const result = resolveActorResourcePayment({
    actorSystem: actorSystem(),
    cost: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 0}]}
  });
  const actor = {
    called: false,
    async update() {
      this.called = true;
    }
  };

  assert.equal(result.ok, true);
  assert.deepEqual(result.mutationPlan.updates, {});
  assert.equal(await commitActorResourceMutationPlan(actor, result.mutationPlan), true);
  assert.equal(actor.called, false);
});

test("commit adapter calls Actor.update with the planned updates", async () => {
  const result = resolveActorResourcePayment({
    actorSystem: actorSystem(),
    cost: {allOf: [{capability: ECONOMY_CAPABILITIES.REACTION, amount: 1}]}
  });
  const calls = [];
  const actor = {
    async update(updates) {
      calls.push(updates);
    }
  };

  assert.equal(await commitActorResourceMutationPlan(actor, result.mutationPlan), true);
  assert.deepEqual(calls, [{"system.resources.reaction.value": 0}]);
});
