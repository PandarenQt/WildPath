import {test} from "node:test";
import assert from "node:assert/strict";
import {
  CONCENTRATION_CHECK_COMMIT_CODES,
  executeConcentrationCheckCommit
} from "../module/resolvers/concentration-check-commit-resolver.mjs";
import {CONCENTRATION_CODES} from "../module/resolvers/concentration-resolver.mjs";
import {EFFECT_LIFECYCLE_COMMIT_CODES} from "../module/resolvers/effect-lifecycle-commit-resolver.mjs";

const CONDITION_DEFINITIONS = {
  restrained: {
    id: "restrained",
    name: "Restrained"
  }
};

function actorWithConcentrationEffect() {
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
          duration: null,
          concentration: {
            required: true,
            sourceRef: "actor:caster",
            originRef: "item:spell",
            breakRemovesEffect: true
          },
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

function concentrationCheckRequest({dc=10}={}) {
  return {
    id: "concentration-check:actor:caster:0",
    type: "damage",
    actorId: "caster",
    actorRef: "actor:caster",
    sourceRef: "actor:caster",
    originRef: "item:spell",
    itemRef: null,
    target: {id: "caster", actorId: "caster"},
    targetRef: "actor:caster",
    damageTaken: 20,
    dc,
    saveKey: "concentration",
    ability: "con",
    damageResult: {total: 20},
    metadata: {}
  };
}

test("ConcentrationCheckCommitResolver removes linked effects after a failed check", async () => {
  const {actor, effect} = actorWithConcentrationEffect();
  const result = await executeConcentrationCheckCommit({
    actors: [actor],
    checkRequests: [concentrationCheckRequest()],
    rolls: {
      "actor:caster": {total: 7, die: 3, mode: "physical-entry"}
    },
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"},
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, CONCENTRATION_CHECK_COMMIT_CODES.OK);
  assert.equal(result.checkResolution.code, CONCENTRATION_CODES.OK);
  assert.equal(result.lifecycleCommit.code, EFFECT_LIFECYCLE_COMMIT_CODES.OK);
  assert.equal(result.breakEvents.length, 1);
  assert.equal(effect.deleted, true);
  assert.equal(actor.effects.length, 0);
});

test("ConcentrationCheckCommitResolver keeps linked effects after a successful check", async () => {
  const {actor, effect} = actorWithConcentrationEffect();
  const result = await executeConcentrationCheckCommit({
    actors: [actor],
    checkRequests: [concentrationCheckRequest()],
    rolls: {
      "concentration-check:actor:caster:0": {total: 16, die: 12, mode: "digital"}
    },
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"},
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, CONCENTRATION_CHECK_COMMIT_CODES.OK);
  assert.equal(result.lifecycleCommit.code, EFFECT_LIFECYCLE_COMMIT_CODES.NO_MUTATION_PLANS);
  assert.equal(effect.deleted, undefined);
  assert.equal(actor.effects.length, 1);
});

test("ConcentrationCheckCommitResolver stops before lifecycle commit when results are missing", async () => {
  const {actor, effect} = actorWithConcentrationEffect();
  const result = await executeConcentrationCheckCommit({
    actors: [actor],
    checkRequests: [concentrationCheckRequest()],
    rolls: [],
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"},
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CONCENTRATION_CHECK_COMMIT_CODES.CHECK_RESOLUTION_FAILED);
  assert.equal(result.checkResolution.code, CONCENTRATION_CODES.NO_CHECK_RESULTS);
  assert.equal(result.lifecycleCommit, null);
  assert.equal(effect.deleted, undefined);
  assert.equal(actor.effects.length, 1);
});

test("ConcentrationCheckCommitResolver reports lifecycle authority failures", async () => {
  const {actor, effect} = actorWithConcentrationEffect();
  const result = await executeConcentrationCheckCommit({
    actors: [actor],
    checkRequests: [concentrationCheckRequest()],
    rolls: {
      "actor:caster": {total: 7, die: 3}
    },
    authority: {isGM: false, userId: "player-a"},
    conditionDefinitions: CONDITION_DEFINITIONS
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CONCENTRATION_CHECK_COMMIT_CODES.LIFECYCLE_COMMIT_FAILED);
  assert.equal(result.lifecycleCommit.code, EFFECT_LIFECYCLE_COMMIT_CODES.COMMIT_PREP_FAILED);
  assert.equal(effect.deleted, undefined);
  assert.equal(actor.effects.length, 1);
});
