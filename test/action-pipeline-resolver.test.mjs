import {test} from "node:test";
import assert from "node:assert/strict";
import {ECONOMY_CAPABILITIES} from "../module/helpers/action-economy.mjs";
import {ACTION_CHOICE_TYPES} from "../module/helpers/action-configuration.mjs";
import {
  RESOLUTION_PIPELINE_CODES,
  RESOLUTION_REQUEST_TYPES,
  RESOLUTION_STATE_STATUS
} from "../module/helpers/resolution-state.mjs";
import {AUTOMATION_EVENT_TYPES} from "../module/helpers/automation-events.mjs";
import {
  ACTION_PIPELINE_STAGE_IDS,
  createActionResolutionState,
  executeStagedActionResolution,
  planStagedActionResolution,
  resumeStagedActionResolution
} from "../module/resolvers/action-pipeline-resolver.mjs";

function actorSystem(actionValue=1, overrides={}) {
  return {
    resources: {
      action: {value: actionValue, max: 1},
      bonus: {value: 1, max: 1},
      reaction: {value: 1, max: 1},
      movement: {value: 30, max: 30},
      ...(overrides.resources ?? {})
    },
    pools: overrides.pools ?? []
  };
}

function targetActorSystem(value=14, max=20) {
  return {
    resources: {
      health: {value, max}
    },
    pools: []
  };
}

function actorWithCalls(id, calls, {system=actorSystem(1), fail=false}={}) {
  return {
    id,
    name: id,
    type: "character",
    system,
    async update(updates) {
      calls.push({actorId: id, updates});
      if ( fail ) throw new Error(`update failed for ${id}`);
      return true;
    }
  };
}

function legacyAction(cost={allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]}) {
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

function definitionAction(definition) {
  return {
    id: definition.id,
    type: "action",
    name: definition.label,
    system: {
      definition
    }
  };
}

function attackDefinition() {
  return {
    schemaVersion: 1,
    id: "action:aimed-strike",
    label: "Aimed Strike",
    costs: {allOf: []},
    attack: {
      type: "melee",
      statistic: "weapon",
      defenseKey: "ac"
    }
  };
}

function configurableDefinition() {
  return {
    schemaVersion: 1,
    id: "action:focused-stance",
    label: "Focused Stance",
    costs: {allOf: []},
    configuration: [{
      id: "stance",
      type: ACTION_CHOICE_TYPES.BOOLEAN,
      label: "Stance",
      required: true
    }]
  };
}

function targetedDefinition() {
  return {
    schemaVersion: 1,
    id: "action:point",
    label: "Point",
    costs: {allOf: []},
    targeting: {
      type: "single",
      required: true,
      count: 1
    }
  };
}

function target(id, data={}) {
  return {
    id,
    actorId: `actor-${id}`,
    tokenId: `token-${id}`,
    disposition: "enemy",
    ...data
  };
}

test("ActionPipeline plans a complete action without waiting and records expected stage sequence", () => {
  const result = planStagedActionResolution({
    id: "resolution:no-wait",
    actorSystem: actorSystem(1),
    action: legacyAction(),
    source: {actorId: "actor-source"}
  });

  assert.equal(result.ok, true);
  assert.equal(result.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT);
  assert.deepEqual(result.state.trace.map(entry => entry.stageId), [
    ACTION_PIPELINE_STAGE_IDS.CONFIGURATION,
    ACTION_PIPELINE_STAGE_IDS.TARGETING,
    ACTION_PIPELINE_STAGE_IDS.ATTACK_ROLL,
    ACTION_PIPELINE_STAGE_IDS.SAVE_ROLL,
    ACTION_PIPELINE_STAGE_IDS.LEGACY_RESOLUTION,
    ACTION_PIPELINE_STAGE_IDS.READY_TO_COMMIT
  ]);
  assert.equal(result.state.results.actionResult.mutationPlans.length, 1);
});

test("ActionPipeline pauses for required configuration and resumes with the resolved configuration", () => {
  const waiting = planStagedActionResolution({
    id: "resolution:configuration",
    actorSystem: actorSystem(1),
    action: definitionAction(configurableDefinition()),
    source: {actorId: "actor-source"}
  });
  const resumed = resumeStagedActionResolution({
    state: waiting.state,
    response: {
      resolutionId: "resolution:configuration",
      requestId: "request:resolution:configuration:configuration",
      type: RESOLUTION_REQUEST_TYPES.ACTION_CONFIGURATION,
      value: {
        choices: {
          stance: true
        }
      }
    }
  });

  assert.equal(waiting.code, RESOLUTION_PIPELINE_CODES.WAITING);
  assert.equal(waiting.state.status, RESOLUTION_STATE_STATUS.AWAITING_CONFIGURATION);
  assert.equal(waiting.state.pendingRequests[0].type, RESOLUTION_REQUEST_TYPES.ACTION_CONFIGURATION);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT);
  assert.equal(resumed.state.configuration.choices[0].id, "stance");
});

test("ActionPipeline requests target selection before resolver planning", () => {
  const waiting = planStagedActionResolution({
    id: "resolution:targets",
    actorSystem: actorSystem(1),
    action: definitionAction(targetedDefinition()),
    source: {actorId: "actor-source"}
  });
  const resumed = resumeStagedActionResolution({
    state: waiting.state,
    response: {
      resolutionId: "resolution:targets",
      requestId: "request:resolution:targets:targets",
      type: RESOLUTION_REQUEST_TYPES.TARGET_SELECTION,
      value: {
        targets: [target("orc")]
      }
    }
  });

  assert.equal(waiting.state.status, RESOLUTION_STATE_STATUS.AWAITING_TARGETS);
  assert.equal(waiting.state.pendingRequests[0].type, RESOLUTION_REQUEST_TYPES.TARGET_SELECTION);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT);
  assert.deepEqual(resumed.state.results.actionResult.context.targets.map(entry => entry.id), ["orc"]);
});

test("ActionPipeline requests an attack RollResult and resumes without rerunning prior stages", () => {
  const waiting = planStagedActionResolution({
    id: "resolution:roll",
    actorSystem: actorSystem(1),
    action: definitionAction(attackDefinition()),
    source: {actorId: "actor-source"},
    targeting: {
      required: true,
      candidates: [{
        id: "orc",
        target: target("orc", {defenses: {ac: {value: 12}}}),
        actor: {id: "actor-orc", name: "Orc"},
        disposition: "enemy",
        kind: "creature"
      }]
    }
  });
  const resumed = resumeStagedActionResolution({
    state: waiting.state,
    response: {
      resolutionId: "resolution:roll",
      requestId: "request:resolution:roll:attack-roll",
      type: RESOLUTION_REQUEST_TYPES.ROLL,
      value: {
        total: 17,
        die: 12
      }
    }
  });

  assert.equal(waiting.state.status, RESOLUTION_STATE_STATUS.AWAITING_ROLL);
  assert.equal(waiting.state.pendingRequests[0].expectedResponseType, "attack-roll");
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT);
  assert.deepEqual(resumed.state.rollResults.map(result => result.roll.total), [17]);
  assert.equal(resumed.state.trace.filter(entry => entry.stageId === ACTION_PIPELINE_STAGE_IDS.CONFIGURATION).length, 1);
  assert.equal(resumed.state.results.actionResult.consequences.some(entry => entry.type === "attackResolved"), true);
});

test("ActionPipeline planning produces mutation plans without mutating the source actor", () => {
  const calls = [];
  const actor = actorWithCalls("actor-source", calls, {system: actorSystem(1)});
  const result = planStagedActionResolution({
    id: "resolution:preview",
    actor,
    action: legacyAction()
  });

  assert.equal(result.ok, true);
  assert.equal(result.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT);
  assert.deepEqual(calls, []);
  assert.deepEqual(result.state.mutationPlans[0].plan.updates, {
    "system.resources.action.value": 0
  });
});

test("ActionPipeline executes target save, damage, and transactional commit through existing resolvers", async () => {
  const sourceCalls = [];
  const targetCalls = [];
  const actor = actorWithCalls("actor-source", sourceCalls, {system: actorSystem(1)});
  const targetActor = actorWithCalls("actor-ogre", targetCalls, {
    system: targetActorSystem(14, 20)
  });
  const result = await executeStagedActionResolution({
    id: "resolution:commit",
    actor,
    action: legacyAction(),
    targeting: {
      required: true,
      candidates: [{
        id: "ogre",
        target: target("ogre", {
          actorId: "actor-ogre",
          saves: {
            dex: {total: 9, die: 4}
          }
        }),
        actor: {id: "actor-ogre", name: "Ogre"},
        disposition: "enemy",
        kind: "creature"
      }]
    },
    save: {
      saveKey: "dex",
      dc: {value: 15}
    },
    damage: {
      saveOutcomePolicy: {
        success: "half",
        failure: "full"
      },
      components: [{id: "burst", amount: 6, damageType: "fire"}]
    },
    durability: true,
    targetActors: {"actor:actor-ogre": targetActor},
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"}
  });

  assert.equal(result.ok, true);
  assert.equal(result.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.deepEqual(targetCalls, [{actorId: "actor-ogre", updates: {"system.resources.health.value": 8}}]);
  assert.deepEqual(sourceCalls, [{actorId: "actor-source", updates: {"system.resources.action.value": 0}}]);
  assert.equal(result.state.events.at(-1).type, AUTOMATION_EVENT_TYPES.PAYMENT_COMMITTED);
  assert.equal(result.state.stageStatuses[ACTION_PIPELINE_STAGE_IDS.COMMIT], "completed");
});

test("ActionPipeline preserves transaction rollback when commit fails after target mutation", async () => {
  const sourceCalls = [];
  const targetCalls = [];
  const actor = actorWithCalls("actor-source", sourceCalls, {
    system: actorSystem(1),
    fail: true
  });
  const targetActor = actorWithCalls("actor-orc", targetCalls, {
    system: targetActorSystem(14, 20)
  });
  const result = await executeStagedActionResolution({
    id: "resolution:rollback",
    actor,
    action: legacyAction(),
    targets: [target("orc", {actorId: "actor-orc"})],
    damage: {
      components: [{id: "slash", amount: 6, damageType: "slashing"}]
    },
    durability: true,
    targetActors: {"actor:actor-orc": targetActor},
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"}
  });

  assert.equal(result.ok, false);
  assert.equal(result.state.status, RESOLUTION_STATE_STATUS.FAILED);
  assert.deepEqual(sourceCalls, [{actorId: "actor-source", updates: {"system.resources.action.value": 0}}]);
  assert.deepEqual(targetCalls, [
    {actorId: "actor-orc", updates: {"system.resources.health.value": 8}},
    {actorId: "actor-orc", updates: {"system.resources.health.value": 14}}
  ]);
  assert.equal(result.state.results.actionResult.steps.at(-1).data.transaction.rolledBack, true);
});

test("ActionPipeline can create a child action state with parent provenance", () => {
  const parent = createActionResolutionState({
    id: "resolution:parent",
    actorSystem: actorSystem(1),
    action: legacyAction(),
    source: {actorId: "actor-source"}
  });
  const child = createActionResolutionState({
    id: "resolution:child",
    parentId: parent.id,
    relationship: "triggered-action",
    sourceEvent: {id: "event:after-hit", type: "afterHit"},
    depth: parent.depth + 1,
    ancestry: [{id: parent.id, parentId: parent.parentId, relationship: parent.relationship, sourceEvent: parent.sourceEvent, depth: parent.depth}],
    triggerIdentities: ["trigger:after-hit"],
    actorSystem: actorSystem(1),
    action: definitionAction(attackDefinition()),
    source: {actorId: "actor-source"}
  });

  assert.equal(child.parentId, "resolution:parent");
  assert.equal(child.relationship, "triggered-action");
  assert.equal(child.ancestry[0].id, "resolution:parent");
  assert.deepEqual(child.triggerIdentities, ["trigger:after-hit"]);
});
