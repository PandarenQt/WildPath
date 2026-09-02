import {test} from "node:test";
import assert from "node:assert/strict";
import {
  CONDITION_EFFECT_ACTIONS,
  EFFECT_RESOLVER_CODES,
  executeConditionEffect,
  planConditionEffect
} from "../module/resolvers/effect-resolver.mjs";

const CONDITION_DEFINITIONS = {
  prone: {
    id: "prone",
    name: "Prone",
    img: "icons/svg/falling.svg"
  },
  exhaustion: {
    id: "exhaustion",
    name: "Exhaustion",
    img: "icons/svg/stoned.svg",
    stacking: true,
    maxLevel: 6
  }
};

function conditionEffect(conditionId, level=null) {
  return {
    id: `effect-${conditionId}`,
    uuid: `ActiveEffect.${conditionId}`,
    type: "condition",
    name: conditionId,
    system: {
      type: conditionId,
      level
    }
  };
}

test("EffectResolver plans applying and removing a binary condition", () => {
  const apply = planConditionEffect({
    conditionId: "prone",
    levels: 1,
    conditionDefinitions: CONDITION_DEFINITIONS
  });
  const remove = planConditionEffect({
    conditionId: "prone",
    levels: -1,
    existingConditions: [conditionEffect("prone")],
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(apply.ok, true);
  assert.equal(apply.action, CONDITION_EFFECT_ACTIONS.CREATE);
  assert.equal(apply.mutationPlan.action, CONDITION_EFFECT_ACTIONS.CREATE);
  assert.equal(remove.ok, true);
  assert.equal(remove.action, CONDITION_EFFECT_ACTIONS.DELETE);
  assert.equal(remove.mutationPlan.existingEffectId, "effect-prone");
});

test("EffectResolver treats redundant binary condition changes as no-ops", () => {
  const alreadyActive = planConditionEffect({
    conditionId: "prone",
    levels: 1,
    existingConditions: [conditionEffect("prone")],
    conditionDefinitions: CONDITION_DEFINITIONS
  });
  const alreadyInactive = planConditionEffect({
    conditionId: "prone",
    levels: -1,
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(alreadyActive.action, CONDITION_EFFECT_ACTIONS.NOOP);
  assert.equal(alreadyActive.toLevel, 1);
  assert.equal(alreadyInactive.action, CONDITION_EFFECT_ACTIONS.NOOP);
  assert.equal(alreadyInactive.toLevel, null);
});

test("EffectResolver ignores non-condition ActiveEffects when finding existing conditions", () => {
  const result = planConditionEffect({
    conditionId: "prone",
    levels: 1,
    existingConditions: [{
      id: "effect-buff",
      type: "effect",
      slug: "prone"
    }],
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(result.action, CONDITION_EFFECT_ACTIONS.CREATE);
  assert.equal(result.existingCondition, null);
});

test("EffectResolver plans leveled condition creation, update, clamp, and deletion", () => {
  const create = planConditionEffect({
    conditionId: "exhaustion",
    levels: 3,
    conditionDefinitions: CONDITION_DEFINITIONS
  });
  const update = planConditionEffect({
    conditionId: "exhaustion",
    levels: 2,
    existingConditions: [conditionEffect("exhaustion", 3)],
    conditionDefinitions: CONDITION_DEFINITIONS
  });
  const clamped = planConditionEffect({
    conditionId: "exhaustion",
    levels: 2,
    existingConditions: [conditionEffect("exhaustion", 6)],
    conditionDefinitions: CONDITION_DEFINITIONS
  });
  const remove = planConditionEffect({
    conditionId: "exhaustion",
    levels: -3,
    existingConditions: [conditionEffect("exhaustion", 2)],
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(create.action, CONDITION_EFFECT_ACTIONS.CREATE);
  assert.equal(create.toLevel, 3);
  assert.equal(update.action, CONDITION_EFFECT_ACTIONS.UPDATE);
  assert.equal(update.fromLevel, 3);
  assert.equal(update.toLevel, 5);
  assert.equal(clamped.action, CONDITION_EFFECT_ACTIONS.NOOP);
  assert.equal(clamped.toLevel, 6);
  assert.equal(remove.action, CONDITION_EFFECT_ACTIONS.DELETE);
  assert.equal(remove.toLevel, null);
});

test("EffectResolver reports invalid condition ids and invalid level deltas", () => {
  const unknown = planConditionEffect({
    conditionId: "not-real",
    conditionDefinitions: CONDITION_DEFINITIONS
  });
  const invalidDelta = planConditionEffect({
    conditionId: "prone",
    levels: 1.5,
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, EFFECT_RESOLVER_CODES.INVALID_CONDITION);
  assert.equal(invalidDelta.ok, false);
  assert.equal(invalidDelta.code, EFFECT_RESOLVER_CODES.INVALID_LEVEL_DELTA);
});

test("EffectResolver carries duration, concentration, source, and origin metadata on condition plans", () => {
  const result = planConditionEffect({
    conditionId: "prone",
    levels: 1,
    conditionDefinitions: CONDITION_DEFINITIONS,
    duration: {
      unit: "round",
      value: 1,
      expires: "sourceTurnEnd"
    },
    concentration: true,
    source: "actor:caster",
    origin: "item:hold-person",
    metadata: {
      spell: "hold-person"
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.duration, {
    unit: "round",
    value: 1,
    expires: "sourceTurnEnd"
  });
  assert.deepEqual(result.concentration, {
    required: true,
    sourceRef: "actor:caster",
    originRef: "item:hold-person",
    breakRemovesEffect: true
  });
  assert.equal(result.sourceRef, "actor:caster");
  assert.equal(result.originRef, "item:hold-person");
  assert.equal(result.mutationPlan.metadata.spell, "hold-person");
});

test("EffectResolver execution requires an explicit commit adapter for mutating condition plans", async () => {
  const result = await executeConditionEffect({
    actor: {effects: []},
    conditionId: "prone",
    levels: 1,
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, EFFECT_RESOLVER_CODES.COMMIT_ADAPTER_REQUIRED);
  assert.equal(result.committed, false);
});

test("EffectResolver execution invokes the supplied commit adapter for condition mutations", async () => {
  const calls = [];
  const effect = {id: "effect-prone"};
  const result = await executeConditionEffect({
    actor: {id: "actor-a", effects: []},
    conditionId: "prone",
    levels: 1,
    conditionDefinitions: CONDITION_DEFINITIONS,
    commitConditionPlan: async ({actor, plan}) => {
      calls.push({actorId: actor.id, conditionId: plan.conditionId, levels: plan.levels, action: plan.action});
      return effect;
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.committed, true);
  assert.equal(result.effect, effect);
  assert.deepEqual(calls, [{
    actorId: "actor-a",
    conditionId: "prone",
    levels: 1,
    action: CONDITION_EFFECT_ACTIONS.CREATE
  }]);
});

test("EffectResolver execution does not invoke the commit adapter for no-op condition plans", async () => {
  const calls = [];
  const existing = conditionEffect("prone");
  const result = await executeConditionEffect({
    actor: {id: "actor-a", effects: [existing]},
    conditionId: "prone",
    levels: 1,
    conditionDefinitions: CONDITION_DEFINITIONS,
    commitConditionPlan: async () => {
      calls.push("called");
      return false;
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.committed, false);
  assert.equal(result.effect, existing);
  assert.deepEqual(calls, []);
});
