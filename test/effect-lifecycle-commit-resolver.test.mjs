import {test} from "node:test";
import assert from "node:assert/strict";
import {TIMELINE_EVENT_TYPES} from "../module/helpers/combat-timeline.mjs";
import {CONCENTRATION_EVENT_TYPES} from "../module/resolvers/concentration-resolver.mjs";
import {
  EFFECT_LIFECYCLE_COMMIT_CODES,
  executeEffectLifecycleCommit,
  targetActorLookupFromActors
} from "../module/resolvers/effect-lifecycle-commit-resolver.mjs";
import {TARGET_MUTATION_COMMIT_CODES} from "../module/resolvers/target-mutation-commit-resolver.mjs";

const CONDITION_DEFINITIONS = {
  restrained: {
    id: "restrained",
    name: "Restrained"
  }
};

function actorWithCondition({duration, concentration=null}={}) {
  const actor = {
    id: "target",
    uuid: "Actor.target",
    name: "Target",
    effects: []
  };
  const effect = {
    id: "effect-restrained",
    uuid: "Actor.target.ActiveEffect.effect-restrained",
    type: "condition",
    name: "Restrained",
    system: {type: "restrained", level: null},
    flags: {
      wildpath: {
        conditionEffect: {
          conditionId: "restrained",
          level: null,
          duration,
          concentration,
          sourceRef: "actor:caster",
          originRef: "item:spell",
          metadata: {}
        }
      }
    },
    async delete() {
      actor.effects = actor.effects.filter(entry => entry !== effect);
      effect.deleted = true;
    }
  };
  actor.effects.push(effect);
  return {actor, effect};
}

test("EffectLifecycleCommitResolver commits expired condition removals through a transaction", async () => {
  const {actor, effect} = actorWithCondition({
    duration: {
      unit: "turn",
      value: 1,
      expires: "sourceTurnEnd"
    }
  });
  const result = await executeEffectLifecycleCommit({
    actors: [actor],
    events: [{
      type: TIMELINE_EVENT_TYPES.TURN_END,
      actorId: "caster"
    }],
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"},
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, EFFECT_LIFECYCLE_COMMIT_CODES.OK);
  assert.equal(effect.deleted, true);
  assert.equal(actor.effects.length, 0);
  assert.equal(result.transaction.committed[0].type, "conditionEffect");
});

test("EffectLifecycleCommitResolver noops when no lifecycle mutation is due", async () => {
  const {actor, effect} = actorWithCondition({
    duration: {
      unit: "turn",
      value: 1,
      expires: "sourceTurnEnd"
    }
  });
  const result = await executeEffectLifecycleCommit({
    actors: [actor],
    events: [{
      type: TIMELINE_EVENT_TYPES.TURN_END,
      actorId: "someone-else"
    }],
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"},
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, EFFECT_LIFECYCLE_COMMIT_CODES.NO_MUTATION_PLANS);
  assert.equal(effect.deleted, undefined);
  assert.equal(actor.effects.length, 1);
});

test("EffectLifecycleCommitResolver removes linked effects when a concentration save fails", async () => {
  const {actor, effect} = actorWithCondition({
    concentration: {
      required: true,
      sourceRef: "actor:caster",
      originRef: "item:spell",
      breakRemovesEffect: true
    }
  });
  const result = await executeEffectLifecycleCommit({
    actors: [actor],
    concentrationDecisions: [{
      actorId: "caster",
      success: false,
      dc: 10,
      total: 7
    }],
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"},
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, EFFECT_LIFECYCLE_COMMIT_CODES.OK);
  assert.equal(result.concentration.breakEvents.length, 1);
  assert.equal(effect.deleted, true);
  assert.equal(actor.effects.length, 0);
  assert.deepEqual(result.mutationPlans[0].metadata.lifecycle.reasons, ["concentrationBroken"]);
});

test("EffectLifecycleCommitResolver keeps linked effects when concentration is maintained", async () => {
  const {actor, effect} = actorWithCondition({
    concentration: {
      required: true,
      sourceRef: "actor:caster",
      breakRemovesEffect: true
    }
  });
  const result = await executeEffectLifecycleCommit({
    actors: [actor],
    concentrationDecisions: [{
      sourceRef: "actor:caster",
      success: true
    }],
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"},
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, EFFECT_LIFECYCLE_COMMIT_CODES.NO_MUTATION_PLANS);
  assert.equal(result.concentration.maintained.length, 1);
  assert.equal(effect.deleted, undefined);
  assert.equal(actor.effects.length, 1);
});

test("EffectLifecycleCommitResolver accepts concentration save events", async () => {
  const {actor, effect} = actorWithCondition({
    concentration: {
      required: true,
      sourceRef: "actor:caster",
      breakRemovesEffect: true
    }
  });
  const result = await executeEffectLifecycleCommit({
    actors: [actor],
    events: [{
      type: CONCENTRATION_EVENT_TYPES.SAVE_RESOLVED,
      data: {
        sourceRef: "actor:caster",
        outcome: "failed"
      }
    }],
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"},
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(result.ok, true);
  assert.equal(effect.deleted, true);
});

test("EffectLifecycleCommitResolver rejects lifecycle commits without authority", async () => {
  const {actor} = actorWithCondition({
    duration: {
      unit: "turn",
      value: 1,
      expires: "sourceTurnEnd"
    }
  });
  const result = await executeEffectLifecycleCommit({
    actors: [actor],
    events: [{
      type: TIMELINE_EVENT_TYPES.TURN_END,
      actorId: "caster"
    }],
    authority: {isGM: false, userId: "player-a"},
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, EFFECT_LIFECYCLE_COMMIT_CODES.COMMIT_PREP_FAILED);
  assert.equal(result.targetOperations.code, TARGET_MUTATION_COMMIT_CODES.COMMIT_NOT_AUTHORIZED);
});

test("targetActorLookupFromActors keys actors by opaque refs and raw ids", () => {
  const {actor} = actorWithCondition();
  const lookup = targetActorLookupFromActors([actor]);

  assert.equal(lookup["actor:target"], actor);
  assert.equal(lookup.target, actor);
  assert.equal(lookup["uuid:Actor.target"], actor);
  assert.equal(lookup["Actor.target"], actor);
});
