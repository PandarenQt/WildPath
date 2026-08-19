import {test} from "node:test";
import assert from "node:assert/strict";
import {ACTION_RESOLUTION_STAGES, ACTION_RESULT_STATUS} from "../module/helpers/action-resolution.mjs";
import {AUTOMATION_EVENT_TYPES} from "../module/helpers/automation-events.mjs";
import {ECONOMY_CAPABILITIES} from "../module/helpers/action-economy.mjs";
import {TARGET_DEFAULT_SELECTION, TARGET_OPERATIONS} from "../module/helpers/targeting.mjs";
import {
  ACTION_RESOLVER_CODES,
  executeActionResolution,
  planActionResolution
} from "../module/resolvers/action-resolver.mjs";

function actorSystem(actionValue=1) {
  return {
    resources: {
      action: {value: actionValue, max: 1},
      bonus: {value: 1, max: 1},
      reaction: {value: 1, max: 1},
      movement: {value: 30, max: 30}
    },
    pools: []
  };
}

function action(cost={allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]}) {
  return {
    id: "strike",
    type: "action",
    name: "Strike",
    system: {
      tags: ["weapon-attack"],
      getActivationCost: () => cost
    }
  };
}

test("ActionResolver plans current cost-only action resolution without mutating Actor system", () => {
  const system = actorSystem(1);
  const result = planActionResolution({
    actorSystem: system,
    action: action(),
    source: {actorId: "actor-a", tokenId: "token-a"}
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, ACTION_RESULT_STATUS.SUCCEEDED);
  assert.deepEqual(result.events.map(event => event.type), [
    AUTOMATION_EVENT_TYPES.ACTION_DECLARED,
    AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED
  ]);
  assert.deepEqual(result.mutationPlans[0].plan.updates, {"system.resources.action.value": 0});
  assert.equal(system.resources.action.value, 1);
});

test("ActionResolver reports payment failure as a failed action result", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(0),
    action: action(),
    source: {actorId: "actor-a"}
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, ACTION_RESULT_STATUS.FAILED);
  assert.equal(result.code, ACTION_RESOLVER_CODES.PAYMENT_UNAVAILABLE);
  assert.equal(result.steps.at(-1).stage, ACTION_RESOLUTION_STAGES.RESOURCE_PAYMENT);
  assert.equal(result.mutationPlans.length, 0);
});

test("ActionResolver can resolve explicit targets before payment", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targets: [{id: "target-a", actorId: "actor-b", disposition: "enemy"}],
    targeting: {
      required: true,
      eligibilityPolicy: {dispositions: ["enemy"]}
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.events.map(event => event.type), [
    AUTOMATION_EVENT_TYPES.ACTION_DECLARED,
    AUTOMATION_EVENT_TYPES.TARGETS_SELECTED,
    AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED
  ]);
  assert.deepEqual(result.context.targets.map(target => target.id), ["target-a"]);
  assert.equal(result.steps.find(step => step.stage === ACTION_RESOLUTION_STAGES.TARGETING).code, "OK");
});

test("ActionResolver stops before payment when required targets are missing", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targeting: {required: true}
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, ACTION_RESOLVER_CODES.TARGETING_FAILED);
  assert.equal(result.events.some(event => event.type === AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED), false);
  assert.equal(result.mutationPlans.length, 0);
});

test("ActionResolver preserves TargetResolver refinement failures", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targets: [
      {id: "target-a", actorId: "actor-a"},
      {id: "target-b", actorId: "actor-b"}
    ],
    targeting: {
      required: true,
      refinementPolicy: {
        defaultSelection: TARGET_DEFAULT_SELECTION.NONE,
        allowedOperations: [TARGET_OPERATIONS.SELECT],
        maxSelections: 1
      },
      decisions: [
        {operation: TARGET_OPERATIONS.SELECT, targetId: "target-a"},
        {operation: TARGET_OPERATIONS.SELECT, targetId: "target-b"}
      ]
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, ACTION_RESOLVER_CODES.TARGETING_FAILED);
  assert.equal(result.errors[0].reason, "TARGETING_FAILED");
});

test("ActionResolver execution commits resource plans and emits payment committed", async () => {
  const calls = [];
  const actor = {
    id: "actor-a",
    name: "Aria",
    type: "character",
    system: actorSystem(1),
    async update(updates) {
      calls.push(updates);
    }
  };
  const result = await executeActionResolution({actor, action: action()});

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{"system.resources.action.value": 0}]);
  assert.deepEqual(result.events.map(event => event.type), [
    AUTOMATION_EVENT_TYPES.ACTION_DECLARED,
    AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED,
    AUTOMATION_EVENT_TYPES.PAYMENT_COMMITTED
  ]);
  assert.equal(result.steps.at(-1).stage, ACTION_RESOLUTION_STAGES.COMPLETE);
});

test("ActionResolver execution supports zero-cost actions without Actor updates", async () => {
  const calls = [];
  const actor = {
    id: "actor-a",
    system: actorSystem(1),
    async update(updates) {
      calls.push(updates);
    }
  };
  const result = await executeActionResolution({
    actor,
    action: action({allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 0}]})
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, []);
  assert.equal(result.events.at(-1).type, AUTOMATION_EVENT_TYPES.PAYMENT_COMMITTED);
});
