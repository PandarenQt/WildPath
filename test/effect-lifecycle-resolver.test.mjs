import {test} from "node:test";
import assert from "node:assert/strict";
import {TIMELINE_EVENT_TYPES} from "../module/helpers/combat-timeline.mjs";
import {
  EFFECT_LIFECYCLE_REASONS,
  planEffectLifecycle
} from "../module/resolvers/effect-lifecycle-resolver.mjs";

const CONDITION_DEFINITIONS = {
  restrained: {
    id: "restrained",
    name: "Restrained"
  },
  prone: {
    id: "prone",
    name: "Prone"
  },
  exhaustion: {
    id: "exhaustion",
    name: "Exhaustion",
    stacking: true,
    maxLevel: 6
  }
};

function conditionEffect({
  id="effect-restrained",
  conditionId="restrained",
  level=null,
  duration=null,
  concentration=null,
  sourceRef="actor:caster",
  originRef="item:spell",
  target={actorId: "actor-target"}
}={}) {
  return {
    id,
    type: "condition",
    name: conditionId,
    target,
    system: {
      type: conditionId,
      level
    },
    flags: {
      wildpath: {
        conditionEffect: {
          conditionId,
          level,
          duration,
          concentration,
          sourceRef,
          originRef,
          metadata: {spellSlug: "test-spell"}
        }
      }
    }
  };
}

test("EffectLifecycleResolver plans condition removal when duration expires", () => {
  const result = planEffectLifecycle({
    actor: {id: "actor-target", name: "Target"},
    effects: [conditionEffect({
      duration: {
        unit: "turn",
        value: 1,
        expires: "sourceTurnEnd"
      }
    })],
    events: [{
      type: TIMELINE_EVENT_TYPES.TURN_END,
      actorId: "caster"
    }],
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(result.ok, true);
  assert.equal(result.expired.length, 1);
  assert.equal(result.conditionPlans.length, 1);
  assert.equal(result.mutationPlans[0].action, "delete");
  assert.equal(result.mutationPlans[0].levels, -1);
  assert.equal(result.mutationPlans[0].target.actorId, "actor-target");
  assert.deepEqual(result.mutationPlans[0].metadata.lifecycle.reasons, [
    EFFECT_LIFECYCLE_REASONS.DURATION_EXPIRED
  ]);
});

test("EffectLifecycleResolver keeps durations when timeline events do not match", () => {
  const effect = conditionEffect({
    duration: {
      unit: "turn",
      value: 1,
      expires: "sourceTurnEnd"
    }
  });
  const result = planEffectLifecycle({
    actor: {id: "actor-target"},
    effects: [effect],
    events: [{
      type: TIMELINE_EVENT_TYPES.TURN_END,
      actorId: "someone-else"
    }],
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(result.ok, true);
  assert.equal(result.mutationPlans.length, 0);
  assert.deepEqual(result.unchanged.map(entry => entry.id), ["effect-restrained"]);
});

test("EffectLifecycleResolver defaults incomplete duration metadata to one tick", () => {
  const effect = conditionEffect({
    duration: {
      unit: "turn",
      expires: "sourceTurnEnd"
    }
  });
  const result = planEffectLifecycle({
    actor: {id: "actor-target"},
    effects: [effect],
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(result.ok, true);
  assert.equal(result.mutationPlans.length, 0);
  assert.deepEqual(result.unchanged.map(entry => entry.id), ["effect-restrained"]);
});

test("EffectLifecycleResolver plans concentration-bound condition removal when concentration breaks", () => {
  const result = planEffectLifecycle({
    actor: {id: "actor-target"},
    effects: [conditionEffect({
      concentration: {
        required: true,
        sourceRef: "actor:caster",
        originRef: "item:spell",
        breakRemovesEffect: true
      }
    })],
    concentrationBreaks: ["actor:caster"],
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(result.ok, true);
  assert.equal(result.concentrationBroken.length, 1);
  assert.equal(result.mutationPlans[0].conditionId, "restrained");
  assert.equal(result.mutationPlans[0].action, "delete");
  assert.deepEqual(result.mutationPlans[0].metadata.lifecycle.reasons, [
    EFFECT_LIFECYCLE_REASONS.CONCENTRATION_BROKEN
  ]);
});

test("EffectLifecycleResolver accepts concentration break events", () => {
  const result = planEffectLifecycle({
    actor: {id: "actor-target"},
    effects: [conditionEffect({
      concentration: {
        required: true,
        sourceRef: "actor:caster",
        breakRemovesEffect: true
      }
    })],
    events: [{
      type: "concentration.broken",
      data: {sourceRef: "actor:caster"}
    }],
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.mutationPlans[0].metadata.lifecycle.reasons, [
    EFFECT_LIFECYCLE_REASONS.CONCENTRATION_BROKEN
  ]);
});

test("EffectLifecycleResolver respects concentration metadata that keeps effects after breaks", () => {
  const result = planEffectLifecycle({
    actor: {id: "actor-target"},
    effects: [conditionEffect({
      concentration: {
        required: true,
        sourceRef: "actor:caster",
        breakRemovesEffect: false
      }
    })],
    concentrationBreaks: ["actor:caster"],
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(result.ok, true);
  assert.equal(result.mutationPlans.length, 0);
});

test("EffectLifecycleResolver removes all stacks for expired stacking conditions", () => {
  const result = planEffectLifecycle({
    actor: {id: "actor-target"},
    effects: [conditionEffect({
      id: "effect-exhaustion",
      conditionId: "exhaustion",
      level: 3,
      duration: {
        unit: "round",
        value: 1,
        expires: "roundEnd"
      }
    })],
    events: [{
      type: TIMELINE_EVENT_TYPES.ROUND_END
    }],
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(result.ok, true);
  assert.equal(result.mutationPlans[0].conditionId, "exhaustion");
  assert.equal(result.mutationPlans[0].levels, -3);
  assert.equal(result.mutationPlans[0].fromLevel, 3);
  assert.equal(result.mutationPlans[0].toLevel, null);
});

test("EffectLifecycleResolver deduplicates duration and concentration removal into one plan", () => {
  const result = planEffectLifecycle({
    actor: {id: "actor-target"},
    effects: [conditionEffect({
      duration: {
        unit: "turn",
        value: 1,
        expires: "sourceTurnEnd"
      },
      concentration: {
        required: true,
        sourceRef: "actor:caster",
        breakRemovesEffect: true
      }
    })],
    events: [{
      type: TIMELINE_EVENT_TYPES.TURN_END,
      actorId: "caster"
    }],
    concentrationBreaks: ["actor:caster"],
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(result.ok, true);
  assert.equal(result.mutationPlans.length, 1);
  assert.deepEqual(result.mutationPlans[0].metadata.lifecycle.reasons, [
    EFFECT_LIFECYCLE_REASONS.DURATION_EXPIRED,
    EFFECT_LIFECYCLE_REASONS.CONCENTRATION_BROKEN
  ]);
});

test("lifecycle plans keep a Token's identity, not just the base Actor id its copies share", () => {
  const result = planEffectLifecycle({
    target: {id: "Scene.s.Token.v1", actorId: "base", actorRef: "Scene.s.Token.v1.Actor.base", uuid: "Scene.s.Token.v1.Actor.base", tokenId: "v1"},
    effects: [{id: "held", type: "condition", system: {type: "stunned"}, flags: {wildpath: {conditionEffect: {
      conditionId: "stunned", concentration: {required: true, sourceRef: "token:caster", breakRemovesEffect: true}}}}}],
    events: [{type: "concentration.broken", ref: "token:caster", sourceRef: "token:caster"}]
  });
  assert.equal(result.mutationPlans.length, 1);
  assert.equal(result.mutationPlans[0].target.uuid, "Scene.s.Token.v1.Actor.base");
  assert.equal(result.mutationPlans[0].target.tokenId, "v1");
});
