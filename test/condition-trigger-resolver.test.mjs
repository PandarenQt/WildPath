import {test} from "node:test";
import assert from "node:assert/strict";
import {WILDPATH} from "../module/config.mjs";
import {TIMELINE_EVENT_TYPES} from "../module/helpers/combat-timeline.mjs";
import {
  CONDITION_TRIGGER_CODES,
  CONDITION_TRIGGER_PAYLOAD_TYPES,
  planConditionTriggerConsequences
} from "../module/resolvers/condition-trigger-resolver.mjs";

function actorSystem({health=10, max=12}={}) {
  return {
    resources: {
      health: {value: health, max}
    },
    pools: []
  };
}

function actor(id="actor-a") {
  return {
    id,
    uuid: `Actor.${id}`,
    name: id
  };
}

function turnStart(actorId="actor-a") {
  return {
    type: TIMELINE_EVENT_TYPES.TURN_START,
    actorId,
    round: 1,
    turn: 0
  };
}

function conditionEffect({id="effect-bleeding", conditionId="bleeding", ruleElements=[], dot=[]}={}) {
  return {
    id,
    uuid: `ActiveEffect.${id}`,
    type: "condition",
    name: conditionId,
    system: {
      type: conditionId,
      ruleElements,
      dot
    }
  };
}

function damageTrigger({id="condition.test.damage", amount=1}={}) {
  return {
    schemaVersion: 1,
    id,
    type: "Trigger",
    data: {
      event: "turn.started",
      payload: {
        type: CONDITION_TRIGGER_PAYLOAD_TYPES.DURABILITY_CHANGE,
        changeType: "damage",
        resourceId: "health",
        amount
      }
    }
  };
}

test("Bleeding condition plans turn-start damage through persisted Trigger RuleElements", () => {
  const system = actorSystem({health: 10});
  const result = planConditionTriggerConsequences({
    actor: actor("actor-a"),
    actorSystem: system,
    effects: [conditionEffect({
      ruleElements: WILDPATH.CONDITIONS.bleeding.ruleElements
    })],
    events: [turnStart("actor-a")]
  });

  assert.equal(WILDPATH.CONDITIONS.bleeding.generator, undefined);
  assert.equal(result.ok, true);
  assert.equal(result.dispatches.length, 1);
  assert.equal(result.dispatches[0].triggerId, "condition.bleeding.turn-start-damage");
  assert.equal(result.mutationPlans.length, 1);
  assert.equal(result.mutationPlans[0].type, "damage");
  assert.deepEqual(result.mutationPlans[0].updates, {"system.resources.health.value": 9});
  assert.equal(system.resources.health.value, 10);
});

test("condition Trigger RuleElements ignore other actors' turn-start events", () => {
  const result = planConditionTriggerConsequences({
    actor: actor("actor-a"),
    actorSystem: actorSystem({health: 10}),
    effects: [conditionEffect({
      ruleElements: WILDPATH.CONDITIONS.bleeding.ruleElements
    })],
    events: [turnStart("actor-b")]
  });

  assert.equal(result.ok, true);
  assert.equal(result.dispatches.length, 0);
  assert.equal(result.mutationPlans.length, 0);
});

test("legacy dot data is translated into synthetic Trigger RuleElements for compatibility", () => {
  const result = planConditionTriggerConsequences({
    actor: actor("actor-a"),
    actorSystem: actorSystem({health: 10}),
    effects: [conditionEffect({
      id: "effect-poisoned",
      conditionId: "poisoned",
      dot: [{resource: "health", amount: 2, restoration: false}]
    })],
    events: [turnStart("actor-a")]
  });

  assert.equal(result.ok, true);
  assert.equal(result.dispatches[0].triggerId, "legacy-dot:effect-poisoned:0");
  assert.deepEqual(result.mutationPlans[0].updates, {"system.resources.health.value": 8});
  assert.equal(result.traces[0].metadata.compatibility.legacyDot, true);
});

test("persisted condition RuleElements win over legacy dot compatibility data", () => {
  const result = planConditionTriggerConsequences({
    actor: actor("actor-a"),
    actorSystem: actorSystem({health: 10}),
    effects: [conditionEffect({
      ruleElements: [damageTrigger({amount: 2})],
      dot: [{resource: "health", amount: 9, restoration: false}]
    })],
    events: [turnStart("actor-a")]
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.mutationPlans[0].updates, {"system.resources.health.value": 8});
  assert.equal(result.dispatches[0].triggerId, "condition.test.damage");
});

test("condition durability triggers reject invalid payloads with structured failures", () => {
  const result = planConditionTriggerConsequences({
    actor: actor("actor-a"),
    actorSystem: actorSystem({health: 10}),
    effects: [conditionEffect({
      ruleElements: [{
        schemaVersion: 1,
        id: "condition.bad-trigger",
        type: "Trigger",
        data: {
          event: "turn.started",
          payload: {
            type: CONDITION_TRIGGER_PAYLOAD_TYPES.DURABILITY_CHANGE,
            changeType: "damage",
            resourceId: "health"
          }
        }
      }]
    })],
    events: [turnStart("actor-a")]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CONDITION_TRIGGER_CODES.INVALID_PAYLOAD);
  assert.match(result.failures[0].reason, /requires an amount/);
});
