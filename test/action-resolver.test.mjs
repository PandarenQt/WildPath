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

function attackCandidate(id, defense=null) {
  return {
    id,
    target: {
      id,
      actorId: `actor-${id}`,
      tokenId: `token-${id}`,
      disposition: "enemy",
      defenses: defense == null ? {} : {ac: {value: defense}}
    },
    actor: {id: `actor-${id}`, name: id},
    disposition: "enemy",
    kind: "creature"
  };
}

function damageComponent(id="base", amount=6, damageType="slashing") {
  return {id, amount, damageType};
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

test("ActionResolver can spend an Action for a Bonus Action activity after Bonus Actions are depleted", () => {
  const system = actorSystem(1);
  system.resources.bonus.value = 0;
  const result = planActionResolution({
    actorSystem: system,
    action: action({allOf: [{capability: ECONOMY_CAPABILITIES.BONUS_ACTION, amount: 1}]}),
    source: {actorId: "actor-a", tokenId: "token-a"}
  });

  assert.equal(result.ok, true);
  assert.equal(result.consequences.at(-1).paymentPlan.mode, "alternative");
  assert.equal(result.consequences.at(-1).paymentPlan.resources[0].resourceId, "economy.action");
  assert.equal(result.consequences.at(-1).paymentPlan.resources[0].policy, "action-for-spent-bonus-action");
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

test("ActionResolver can resolve an attack after targeting and before payment", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targeting: {
      required: true,
      candidates: [
        attackCandidate("orc", 14),
        attackCandidate("knight", 19)
      ],
      eligibilityPolicy: {dispositions: ["enemy"]}
    },
    attack: {
      roll: {total: 17, die: 12}
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map(step => step.stage), [
    ACTION_RESOLUTION_STAGES.VALIDATION,
    ACTION_RESOLUTION_STAGES.TARGETING,
    ACTION_RESOLUTION_STAGES.ROLL,
    ACTION_RESOLUTION_STAGES.RESOURCE_PAYMENT,
    ACTION_RESOLUTION_STAGES.COMPLETE
  ]);
  assert.deepEqual(result.events.map(event => event.type), [
    AUTOMATION_EVENT_TYPES.ACTION_DECLARED,
    AUTOMATION_EVENT_TYPES.TARGETS_SELECTED,
    AUTOMATION_EVENT_TYPES.ATTACK_ROLL,
    AUTOMATION_EVENT_TYPES.ATTACK_HIT,
    AUTOMATION_EVENT_TYPES.ATTACK_MISS,
    AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED
  ]);
  const attackStep = result.steps.find(step => step.stage === ACTION_RESOLUTION_STAGES.ROLL);
  assert.deepEqual(attackStep.data.attackResolution.hits.map(hit => hit.target.id), ["orc"]);
  assert.deepEqual(attackStep.data.attackResolution.misses.map(miss => miss.target.id), ["knight"]);
  assert.deepEqual(result.mutationPlans[0].plan.updates, {"system.resources.action.value": 0});
});

test("ActionResolver can resolve damage for attack hits before payment", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targeting: {
      required: true,
      candidates: [
        attackCandidate("orc", 14),
        attackCandidate("knight", 19)
      ]
    },
    attack: {
      roll: {total: 17, die: 12}
    },
    damage: {
      components: [damageComponent("slash", 6, "slashing")]
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map(step => step.stage), [
    ACTION_RESOLUTION_STAGES.VALIDATION,
    ACTION_RESOLUTION_STAGES.TARGETING,
    ACTION_RESOLUTION_STAGES.ROLL,
    ACTION_RESOLUTION_STAGES.CONSEQUENCE,
    ACTION_RESOLUTION_STAGES.RESOURCE_PAYMENT,
    ACTION_RESOLUTION_STAGES.COMPLETE
  ]);
  const damageStep = result.steps.find(step => step.stage === ACTION_RESOLUTION_STAGES.CONSEQUENCE);
  assert.deepEqual(damageStep.data.damageResolution.totals, {orc: 6});
  assert.deepEqual(damageStep.data.damageResolution.results.map(target => target.target.id), ["orc"]);
  assert.deepEqual(result.consequences.map(consequence => consequence.type), [
    "targetsSelected",
    "attackResolved",
    "damageResolved",
    "resourcePayment"
  ]);
  assert.deepEqual(result.mutationPlans[0].plan.updates, {"system.resources.action.value": 0});
});

test("ActionResolver skips damage when an attack misses but still plans payment", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targeting: {
      required: true,
      candidates: [attackCandidate("armored", 20)]
    },
    attack: {
      roll: {total: 12, die: 7}
    },
    damage: {
      components: [damageComponent("slash", 6, "slashing")]
    }
  });

  assert.equal(result.ok, true);
  const damageStep = result.steps.find(step => step.stage === ACTION_RESOLUTION_STAGES.CONSEQUENCE);
  assert.deepEqual(damageStep.data.damageResolution.totals, {});
  assert.deepEqual(damageStep.data.damageResolution.skipped.map(skip => skip.target.id), ["armored"]);
  assert.equal(damageStep.data.damageResolution.skipped[0].reason, "attack did not hit");
  assert.equal(result.events.some(event => event.type === AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED), true);
  assert.deepEqual(result.mutationPlans[0].plan.updates, {"system.resources.action.value": 0});
});

test("ActionResolver stops before payment when damage data is invalid", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targets: [{id: "target-a", actorId: "actor-b", disposition: "enemy"}],
    damage: {
      components: [{id: "missing-amount", damageType: "fire"}]
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, ACTION_RESOLVER_CODES.DAMAGE_FAILED);
  assert.equal(result.steps.at(-1).stage, ACTION_RESOLUTION_STAGES.CONSEQUENCE);
  assert.equal(result.errors[0].reason, "MISSING_AMOUNT");
  assert.equal(result.events.some(event => event.type === AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED), false);
  assert.equal(result.mutationPlans.length, 0);
});

test("ActionResolver stops before payment when attack data is invalid", () => {
  const result = planActionResolution({
    actorSystem: actorSystem(1),
    action: action(),
    source: {actorId: "actor-a"},
    targeting: {
      required: true,
      candidates: [attackCandidate("unknown")]
    },
    attack: {
      roll: {total: 17, die: 12}
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, ACTION_RESOLVER_CODES.ATTACK_FAILED);
  assert.equal(result.steps.at(-1).stage, ACTION_RESOLUTION_STAGES.ROLL);
  assert.equal(result.errors[0].reason, "MISSING_DEFENSE");
  assert.equal(result.events.some(event => event.type === AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED), false);
  assert.equal(result.mutationPlans.length, 0);
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

test("ActionResolver execution commits payment after an attack miss", async () => {
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
  const result = await executeActionResolution({
    actor,
    action: action(),
    targeting: {
      required: true,
      candidates: [attackCandidate("armored", 20)]
    },
    attack: {
      roll: {total: 12, die: 7}
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{"system.resources.action.value": 0}]);
  assert.equal(result.events.some(event => event.type === AUTOMATION_EVENT_TYPES.ATTACK_MISS), true);
  assert.equal(result.events.at(-1).type, AUTOMATION_EVENT_TYPES.PAYMENT_COMMITTED);
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
