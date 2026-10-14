import {test} from "node:test";
import assert from "node:assert/strict";
import {ECONOMY_CAPABILITIES} from "../module/helpers/action-economy.mjs";
import {ACTION_CHOICE_TYPES} from "../module/helpers/action-configuration.mjs";
import {
  RESOLUTION_PIPELINE_CODES,
  RESOLUTION_REQUEST_TYPES,
  RESOLUTION_STATE_STATUS
} from "../module/helpers/resolution-state.mjs";
import {ROLL_TYPES, rollFormulaForRequest} from "../module/helpers/rolls.mjs";
import {AUTOMATION_EVENT_TYPES} from "../module/helpers/automation-events.mjs";
import {
  createPhysicalDiceProvider,
  executeRollRequest
} from "../module/resolvers/roll-provider-resolver.mjs";
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

function statistic(domain, totalModifier) {
  return {
    totalModifier,
    trace: {domain, total: totalModifier, applied: [{id: `${domain}:test`, value: totalModifier}]}
  };
}

function actorWithCalls(id, calls, {system=actorSystem(1), fail=false, statistics={}}={}) {
  return {
    id,
    name: id,
    type: "character",
    system,
    getStatistic(domains) {
      return [domains].flat().map(domain => statistics[domain]).find(Boolean) ?? null;
    },
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
    ACTION_PIPELINE_STAGE_IDS.RANGE,
    ACTION_PIPELINE_STAGE_IDS.CHECK_ROLL,
    ACTION_PIPELINE_STAGE_IDS.CHECK_OUTCOME,
    ACTION_PIPELINE_STAGE_IDS.ATTACK_ROLL,
    ACTION_PIPELINE_STAGE_IDS.ATTACK_OUTCOME,
    ACTION_PIPELINE_STAGE_IDS.SAVE_ROLL,
    ACTION_PIPELINE_STAGE_IDS.SAVE_OUTCOME,
    ACTION_PIPELINE_STAGE_IDS.DAMAGE_ROLL,
    ACTION_PIPELINE_STAGE_IDS.DAMAGE,
    ACTION_PIPELINE_STAGE_IDS.HEALING_ROLL,
    ACTION_PIPELINE_STAGE_IDS.HEALING,
    ACTION_PIPELINE_STAGE_IDS.EFFECTS,
    ACTION_PIPELINE_STAGE_IDS.CONCENTRATION,
    ACTION_PIPELINE_STAGE_IDS.PAYMENT,
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

test("ActionPipeline reads only choices from a configuration answer, never the chooser's effective definition", () => {
  // The intent path is closed at the transport boundary (sanitizeActionIntentPayload keeps choices only).
  const forged = {...configurableDefinition(), label: "Forged",
    damage: [{id: "forged", expression: {type: "constant", value: 999}, damageType: "fire"}]};
  const waiting = planStagedActionResolution({
    id: "resolution:forged-answer",
    actorSystem: actorSystem(1),
    action: definitionAction(configurableDefinition()),
    source: {actorId: "actor-source"}
  });
  const resumed = resumeStagedActionResolution({
    state: waiting.state,
    response: {
      resolutionId: "resolution:forged-answer",
      requestId: "request:resolution:forged-answer:configuration",
      type: RESOLUTION_REQUEST_TYPES.ACTION_CONFIGURATION,
      value: {configuration: {effectiveDefinition: forged, choices: {}}}
    }
  });
  assert.notEqual(resumed.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT,
    "a forged resolved configuration without the required choice does not satisfy configuration");
  assert.equal(resumed.state.actionDefinition.label, "Focused Stance");
});

test("ActionPipeline requests target selection but never accepts targets the authority did not offer", () => {
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
        targets: [target("orc", {defenses: {ac: {value: 1}}})],
        decisions: [{operation: "select", targetId: "orc"}]
      }
    }
  });

  assert.equal(waiting.state.status, RESOLUTION_STATE_STATUS.AWAITING_TARGETS);
  assert.equal(waiting.state.pendingRequests[0].type, RESOLUTION_REQUEST_TYPES.TARGET_SELECTION);
  // A chooser-supplied target (and its defense) is never trusted: nothing was offered, so nothing resolves.
  assert.equal(resumed.ok, false);
  assert.equal(resumed.state.status, RESOLUTION_STATE_STATUS.FAILED);
  assert.equal(JSON.stringify(resumed.state.results.actionResult?.context?.targets ?? []).includes("orc"), false);
});

test("ActionPipeline target refinement accepts only decisions about the authority's own candidates", () => {
  const plan = id => planStagedActionResolution({
    id,
    actorSystem: actorSystem(1),
    action: definitionAction(targetedDefinition()),
    source: {actorId: "actor-source"},
    targeting: {
      required: true,
      refinementPolicy: {maxSelections: 1},
      candidates: ["orc", "goblin"].map(name => ({id: name, target: target(name), actor: {id: `actor-${name}`},
        disposition: "enemy", kind: "creature"}))
    }
  });
  const answer = (waiting, value) => resumeStagedActionResolution({
    state: waiting.state,
    response: {resolutionId: waiting.state.id, requestId: `request:${waiting.state.id}:target-refinement`,
      type: RESOLUTION_REQUEST_TYPES.TARGET_REFINEMENT, value}
  });

  const waiting = plan("resolution:refine");
  assert.equal(waiting.state.pendingRequests[0].type, RESOLUTION_REQUEST_TYPES.TARGET_REFINEMENT);
  // Overriding the authority's policy does not lift the one-target limit.
  assert.equal(answer(plan("resolution:policy"), {targeting: {refinementPolicy: {}}}).ok, false);
  // A target that was never offered is rejected.
  assert.equal(answer(plan("resolution:ghost"), {decisions: [{operation: "select", targetId: "ghost"}]}).ok, false);
  // A valid decision about an offered candidate resolves to exactly that selection.
  const resumed = answer(waiting, {decisions: [{operation: "deselect", targetId: "goblin"}]});
  assert.equal(resumed.ok, true, JSON.stringify(resumed.state.errors));
  assert.equal(resumed.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT);
  assert.deepEqual(resumed.state.results.actionResult.context.targets.map(entry => entry.id), ["orc"]);
});

test("a refinement prompt starts from the authority's default selection, so keeping one of three resolves to it", async () => {
  const {createFoundryV14PromptAdapter} = await import("../module/adapters/foundry-v14-prompt-adapter.mjs");
  const waiting = planStagedActionResolution({
    id: "resolution:keep-one",
    actorSystem: actorSystem(1),
    action: definitionAction(targetedDefinition()),
    source: {actorId: "actor-source"},
    targeting: {
      required: true,
      refinementPolicy: {maxSelections: 1},
      candidates: ["orc", "goblin", "kobold"].map(name => ({id: name, target: target(name), actor: {id: `actor-${name}`},
        disposition: "enemy", kind: "creature"}))
    }
  });
  const request = waiting.state.pendingRequests[0];
  assert.deepEqual(request.payload.candidates.map(candidate => candidate.selected), [true, true, true],
    "the default selection (all eligible) is shown");
  let rendered = "";
  const prompt = createFoundryV14PromptAdapter({DialogV2: {input: async ({content}) => {
    rendered = content;
    return {targetIds: ["goblin"]}; // the Player unticks Orc and Kobold
  }}});
  const answer = await prompt.request(request, {isGM: true});
  assert.equal((rendered.match(/ checked/g) ?? []).length, 3);
  assert.deepEqual(answer.value.decisions, [
    {operation: "deselect", targetId: "orc"},
    {operation: "deselect", targetId: "kobold"}
  ]);
  const resumed = resumeStagedActionResolution({state: waiting.state, response: {resolutionId: waiting.state.id,
    requestId: request.id, type: RESOLUTION_REQUEST_TYPES.TARGET_REFINEMENT, value: answer.value}});
  assert.equal(resumed.ok, true, JSON.stringify(resumed.state.errors));
  assert.deepEqual(resumed.state.results.actionResult.context.targets.map(entry => entry.id), ["goblin"]);
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
  assert.equal(waiting.state.pendingRequests[0].expectedResponseType, "roll-result");
  assert.equal(waiting.state.pendingRequests[0].payload.rollRequest.type, ROLL_TYPES.ATTACK);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT);
  assert.deepEqual(resumed.state.rollResults.map(result => result.roll.total), [17]);
  assert.deepEqual(resumed.state.rollResults.map(result => result.rollResult.natural), [12]);
  assert.equal(resumed.state.trace.filter(entry => entry.stageId === ACTION_PIPELINE_STAGE_IDS.CONFIGURATION).length, 1);
  assert.equal(resumed.state.results.actionResult.consequences.some(entry => entry.type === "attackResolved"), true);
});

test("ActionPipeline attack outcome snapshots target defense from targetActors before initial resolution", () => {
  const targetActor = actorWithCalls("actor-orc", [], {
    system: {
      ...targetActorSystem(14, 20),
      defenses: {ac: {value: 13}}
    },
    statistics: {
      "defense.ac": statistic("defense.ac", 2)
    }
  });
  const targetActors = {"actor:actor-orc": targetActor};
  const waiting = planStagedActionResolution({
    id: "resolution:actor-defense",
    actorSystem: actorSystem(1),
    action: definitionAction(attackDefinition()),
    source: {actorId: "actor-source"},
    targeting: {
      required: true,
      candidates: [{
        id: "orc",
        target: target("orc", {actorId: "actor-orc"}),
        actor: {id: "actor-orc", name: "Orc"},
        disposition: "enemy",
        kind: "creature"
      }]
    },
    targetActors
  });
  const resumed = resumeStagedActionResolution({
    state: waiting.state,
    response: {
      resolutionId: "resolution:actor-defense",
      requestId: "request:resolution:actor-defense:attack-roll",
      type: RESOLUTION_REQUEST_TYPES.ROLL,
      value: {
        total: 16,
        die: 16
      }
    },
    services: {targetActors}
  });

  assert.equal(resumed.ok, true);
  assert.equal(resumed.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT);
  assert.equal(resumed.state.input.attack.targetContexts[0].defenses.ac.value, 15);
  assert.equal(resumed.state.results.attackResolution.results[0].defense.value, 15);
  assert.equal(resumed.state.results.attackResolution.hits.length, 1);
});

test("ActionPipeline resumes an attack from a physical RollResult and commits through ready-to-commit", async () => {
  const sourceCalls = [];
  const targetCalls = [];
  const actor = actorWithCalls("actor-source", sourceCalls, {system: actorSystem(1)});
  const action = definitionAction(attackDefinition());
  const targetActor = actorWithCalls("actor-orc", targetCalls, {
    system: targetActorSystem(14, 20)
  });
  const targetActors = {"actor:actor-orc": targetActor};
  const waiting = planStagedActionResolution({
    id: "resolution:physical-attack",
    actor,
    action,
    source: {actorId: "actor-source"},
    targeting: {
      required: true,
      candidates: [{
        id: "orc",
        target: target("orc", {actorId: "actor-orc", defenses: {ac: {value: 12}}}),
        actor: {id: "actor-orc", name: "Orc"},
        disposition: "enemy",
        kind: "creature"
      }]
    },
    damage: {
      components: [{id: "slash", amount: 6, damageType: "slashing"}]
    },
    durability: true,
    targetActors
  });
  const rollRequest = waiting.state.pendingRequests[0].payload.rollRequest;
  const provided = await executeRollRequest({
    request: rollRequest,
    providers: [createPhysicalDiceProvider()],
    context: {
      physicalRolls: {
        [rollRequest.id]: {
          requestId: rollRequest.id,
          resolutionId: rollRequest.resolutionId,
          type: rollRequest.type,
          natural: 12,
          total: 17
        }
      }
    }
  });
  const resumed = resumeStagedActionResolution({
    state: waiting.state,
    response: {
      resolutionId: waiting.state.id,
      requestId: rollRequest.id,
      type: RESOLUTION_REQUEST_TYPES.ROLL,
      value: provided.result
    },
    services: {targetActors}
  });
  const committed = await executeStagedActionResolution({
    state: resumed.state,
    actor,
    action,
    targetActors,
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"}
  });

  assert.equal(waiting.state.status, RESOLUTION_STATE_STATUS.AWAITING_ROLL);
  assert.equal(rollRequest.type, ROLL_TYPES.ATTACK);
  assert.equal(provided.ok, true);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT);
  assert.equal(resumed.state.rollResults[0].rollResult.provenance.type, "physical");
  assert.equal(committed.ok, true);
  assert.equal(committed.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.deepEqual(targetCalls, [{actorId: "actor-orc", updates: {"system.resources.health.value": 8}}]);
  assert.deepEqual(sourceCalls, []);
  assert.equal(committed.state.stageStatuses[ACTION_PIPELINE_STAGE_IDS.COMMIT], "completed");
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

test("ActionPipeline executes an already ready-to-commit state", async () => {
  const calls = [];
  const actor = actorWithCalls("actor-source", calls, {system: actorSystem(1)});
  const action = legacyAction();
  const planned = planStagedActionResolution({
    id: "resolution:execute-ready",
    actor,
    action
  });
  const result = await executeStagedActionResolution({
    state: planned.state,
    actor,
    action
  });

  assert.equal(planned.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT);
  assert.equal(result.ok, true);
  assert.equal(result.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.deepEqual(calls, [{actorId: "actor-source", updates: {"system.resources.action.value": 0}}]);
  assert.equal(result.state.stageStatuses[ACTION_PIPELINE_STAGE_IDS.COMMIT], "completed");
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

test("each target rolls its own save, routed one after another, and gets its own outcome", () => {
  const plan = planStagedActionResolution({
    id: "resolution:fan-out",
    actorSystem: actorSystem(1),
    action: legacyAction(),
    source: {actorId: "actor-source"},
    targets: [target("orc"), target("goblin")],
    save: {saveKey: "dex", dc: {value: 10}},
    damage: {saveOutcomePolicy: {success: "half", failure: "full"}, components: [{id: "burst", amount: 10, damageType: "fire"}]}
  });
  const answer = (state, natural) => {
    const request = state.pendingRequests[0];
    return resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id,
      type: RESOLUTION_REQUEST_TYPES.ROLL, value: {requestId: request.payload.rollRequest.id, resolutionId: state.id,
        type: request.payload.rollRequest.type, natural, total: natural}}});
  };
  const first = plan.state.pendingRequests[0];
  assert.equal(first.id, "request:resolution:fan-out:save-roll", "the first save keeps the single-target id");
  assert.equal(first.payload.rollRequest.source.id, "orc", "the orc's controller rolls the orc's save");
  const afterOrc = answer(plan.state, 15);
  const second = afterOrc.state.pendingRequests[0];
  assert.equal(second.id, "request:resolution:fan-out:save-roll:2");
  assert.equal(second.payload.rollRequest.source.id, "goblin");
  const done = answer(afterOrc.state, 3);
  assert.equal(done.ok, true, JSON.stringify(done.state.errors));
  const outcomes = Object.fromEntries(done.state.results.saveResolution.results.map(entry => [entry.target.id, entry.success]));
  assert.deepEqual(outcomes, {orc: true, goblin: false});
  const damage = Object.fromEntries(done.state.results.damageResolution.results.map(entry => [entry.target.id, entry.total]));
  assert.deepEqual(damage, {orc: 5, goblin: 10}, "half for the orc's success, full for the goblin's failure");
  assert.equal(done.state.rollResults.filter(entry => entry.type === "save-roll").length, 2);
});

test("a concentrating creature that is damaged checks to keep it, and a failure ends the effects it sustains", () => {
  const plan = id => planStagedActionResolution({
    id,
    actorSystem: actorSystem(1),
    action: legacyAction(),
    source: {actorId: "actor-source"},
    targets: [target("caster")],
    damage: {components: [{id: "bolt", amount: 22, damageType: "fire"}]},
    concentration: {
      states: {caster: {concentrating: true, actorId: "actor-caster", sourceRef: "token:token-caster"}},
      dependents: [{target: {id: "victim", actorId: "actor-victim"}, effects: [{id: "held", type: "condition",
        system: {type: "stunned"}, flags: {wildpath: {conditionEffect: {conditionId: "stunned",
          concentration: {required: true, sourceRef: "token:token-caster", breakRemovesEffect: true}}}}}]}]
    }
  });
  const answer = (state, natural) => {
    const request = state.pendingRequests[0];
    return resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id,
      type: RESOLUTION_REQUEST_TYPES.ROLL, value: {requestId: request.payload.rollRequest.id, resolutionId: state.id,
        type: request.payload.rollRequest.type, natural, total: natural}}});
  };
  const waiting = plan("resolution:concentration-break");
  const request = waiting.state.pendingRequests[0];
  assert.equal(request.payload.rollKind, "concentration");
  assert.equal(request.payload.rollRequest.source.id, "caster", "the damaged caster's controller rolls");
  assert.equal(request.payload.rollRequest.dc, null, "the DC (11 for 22 damage) stays on the authority");
  const broken = answer(waiting.state, 2);
  assert.equal(broken.ok, true, JSON.stringify(broken.state.errors));
  const ended = broken.state.mutationPlans.filter(entry => entry.type === "conditionEffect");
  assert.equal(ended.length, 1, "the stun it sustained ends with the damage");
  assert.equal(broken.state.results.concentrationResolution.checks.breakEvents.length, 1);
  const kept = answer(plan("resolution:concentration-kept").state, 19);
  assert.equal(kept.state.mutationPlans.filter(entry => entry.type === "conditionEffect").length, 0);
  assert.equal(kept.state.results.concentrationResolution.checks.maintained.length, 1);
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

test("an Action's own check is rolled by its controller, and its outcome picks the healing and effects that apply", async () => {
  const {validateActionDefinition} = await import("../module/helpers/action-definitions.mjs");
  const definition = {schemaVersion: 1, id: "action:steady", label: "Steady", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1},
    check: {ability: "wits", skill: "medicine", dc: {value: 10}},
    healing: [{id: "steady", expression: {type: "constant", value: 3}}],
    effects: [{id: "fumble", type: "condition", conditionId: "prone", checkOutcomePolicy: "failure"}]};
  assert.equal(validateActionDefinition(definition).ok, true);
  assert.equal(validateActionDefinition({...definition, check: {dc: {value: 10}}}).ok, false, "an ability or skill is required");
  assert.equal(validateActionDefinition({...definition, check: {ability: "wits"}}).ok, false, "a DC is required");
  const waiting = planStagedActionResolution({
    id: "resolution:check",
    actorSystem: actorSystem(1),
    action: definitionAction(definition),
    source: {actorId: "actor-source"},
    check: {modifier: 2},
    targeting: {required: true, candidates: [{id: "ally", target: target("ally", {disposition: "friendly"}),
      actor: {id: "actor-ally"}, disposition: "friendly", kind: "creature"}]}
  });
  const request = waiting.state.pendingRequests[0];
  assert.equal(request.payload.rollRequest.type, ROLL_TYPES.SKILL_CHECK);
  assert.equal(request.authority.kind, "source-controller");
  assert.equal(request.payload.rollRequest.expected.modifierTotal, 2);
  const roll = (total, die) => resumeStagedActionResolution({state: waiting.state,
    response: {resolutionId: waiting.state.id, requestId: request.id, type: RESOLUTION_REQUEST_TYPES.ROLL, value: {total, die}}});
  const steady = roll(12, 10);
  assert.equal(steady.state.results.checkResolution.success, true);
  assert.deepEqual(steady.state.results.actionResult.consequences.map(entry => entry.type).filter(type => /healing|effect/i.test(type)),
    ["healingResolved"], "success: the healing, not the failure's effect");
  const fumbled = roll(9, 7);
  assert.equal(fumbled.state.results.checkResolution.success, false);
  const types = fumbled.state.results.actionResult.consequences.map(entry => entry.type);
  assert.equal(types.includes("healingResolved"), false, "failure: no healing");
  assert.equal(types.some(type => /effect/i.test(type)), true, "failure: the failure's effect");
});

test("a concentration save adds the concentrating creature's save bonus, so 8 + 3 keeps a DC 11", () => {
  const waiting = planStagedActionResolution({
    id: "resolution:concentration-bonus",
    actorSystem: actorSystem(1),
    action: legacyAction(),
    source: {actorId: "actor-source"},
    targets: [target("caster")],
    damage: {components: [{id: "bolt", amount: 22, damageType: "fire"}]},
    concentration: {
      states: {caster: {concentrating: true, actorId: "actor-caster", sourceRef: "token:token-caster", saveBonus: 3}},
      dependents: [{target: {id: "victim", actorId: "actor-victim"}, effects: [{id: "held", type: "condition",
        system: {type: "stunned"}, flags: {wildpath: {conditionEffect: {conditionId: "stunned",
          concentration: {required: true, sourceRef: "token:token-caster", breakRemovesEffect: true}}}}}]}]
    }
  });
  const request = waiting.state.pendingRequests[0];
  assert.equal(request.payload.rollRequest.expected.modifierTotal, 3);
  const kept = resumeStagedActionResolution({state: waiting.state, response: {resolutionId: waiting.state.id, requestId: request.id,
    type: RESOLUTION_REQUEST_TYPES.ROLL, value: {requestId: request.payload.rollRequest.id, resolutionId: waiting.state.id,
      type: request.payload.rollRequest.type, natural: 8, total: 11}}});
  assert.equal(kept.ok, true, JSON.stringify(kept.state.errors));
  assert.equal(kept.state.results.concentrationResolution.checks.maintained.length, 1);
});

test("weapon damage adds the attack's ability modifier once: after the dice, kept single on a critical, and on fixed damage", () => {
  const strike = (damage, id) => planStagedActionResolution({
    id,
    actorSystem: actorSystem(1),
    action: definitionAction({...attackDefinition(), damage: [damage]}),
    source: {actorId: "actor-source"},
    damage: {modifierTotal: 3},
    targeting: {required: true, candidates: [{id: "orc", target: target("orc", {defenses: {ac: {value: 12}}}),
      actor: {id: "actor-orc"}, disposition: "enemy", kind: "creature"}]}
  });
  const hit = (waiting, natural) => resumeStagedActionResolution({state: waiting.state, response: {resolutionId: waiting.state.id,
    requestId: waiting.state.pendingRequests[0].id, type: RESOLUTION_REQUEST_TYPES.ROLL, value: {total: natural + 5, die: natural}}});
  const sword = {id: "blade", expression: {type: "dice", number: 1, faces: 8}, damageType: "slashing", provenance: "weapon-base"};
  const formula = state => rollFormulaForRequest(state.pendingRequests[0].payload.rollRequest).formula;
  assert.equal(formula(hit(strike(sword, "resolution:sword"), 12).state), "1d8 + 3");
  assert.equal(formula(hit(strike(sword, "resolution:sword-crit"), 20).state), "2d8 + 3", "a critical doubles the dice, not the 3");
  const fist = hit(strike({id: "fist", expression: {type: "constant", value: 1}, damageType: "bludgeoning", provenance: "weapon-base"},
    "resolution:fist"), 12);
  assert.equal(fist.ok, true, JSON.stringify(fist.state.errors));
  assert.deepEqual(fist.state.results.damageResolution.results.map(entry => entry.total), [4], "an Unarmed Strike's 1 + 3");
});

test("each damage component is its own roll: a Flaming Longsword rolls 1d8 + 3 and 1d6, and fire resistance halves only the fire", () => {
  const definition = {schemaVersion: 1, id: "action:flaming-longsword", label: "Flaming Longsword", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1}, attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
    damage: [{id: "blade", expression: {type: "dice", number: 1, faces: 8}, damageType: "slashing", provenance: "weapon-base"},
      {id: "flame", expression: {type: "dice", number: 1, faces: 6}, damageType: "fire", provenance: "additional"}]};
  const strike = id => planStagedActionResolution({id, actorSystem: actorSystem(1), action: definitionAction(definition),
    source: {actorId: "actor-source"}, damage: {modifierTotal: 3},
    targeting: {required: true, candidates: [{id: "orc", target: target("orc", {defenses: {ac: {value: 10}}}),
      actor: {id: "actor-orc"}, disposition: "enemy", kind: "creature"}]},
    durability: {targetSystems: {"actor:actor-orc": {resources: {health: {value: 30, max: 30}}}},
      adjustmentProfiles: {"actor:actor-orc": {resistances: [{damageTypes: ["fire"], multiplier: 0.5}]}}}});
  const answer = (result, value) => {
    const request = result.state.pendingRequests[0];
    return {formula: rollFormulaForRequest(request.payload.rollRequest).formula,
      next: resumeStagedActionResolution({state: result.state, response: {resolutionId: result.state.id, requestId: request.id,
        type: RESOLUTION_REQUEST_TYPES.ROLL, value}})};
  };
  let step = answer(strike("resolution:longsword"), {total: 15, die: 10});
  step = answer(step.next, {total: 9});
  assert.equal(step.formula, "1d8 + 3", "the weapon's ability modifier rides on the weapon's own dice");
  step = answer(step.next, {total: 4});
  assert.equal(step.formula, "1d6");
  assert.equal(step.next.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(step.next.state.errors));
  const plan = step.next.state.mutationPlans.find(entry => entry.type === "durabilityDamage")?.plan;
  assert.equal(plan.appliedAmount, 11, "9 slashing (the 3 is in that roll), and 4 fire halved to 2");

  let crit = answer(strike("resolution:longsword-crit"), {total: 25, die: 20});
  crit = answer(crit.next, {total: 13});
  assert.equal(crit.formula, "2d8 + 3", "a critical hit doubles the dice, not the modifier");
  assert.equal(answer(crit.next, {total: 7}).formula, "2d6");
});

test("a rolled formula's flat part rolls with its dice, and healing dice are rolled too", () => {
  const rolled = (definition, extra={}) => planStagedActionResolution({id: `resolution:${definition.id}`,
    actorSystem: {...actorSystem(1), abilities: {wits: {value: 14}}}, action: definitionAction(definition),
    source: {actorId: "actor-source"}, targets: [target("ally", {disposition: "friendly"})], ...extra});
  const base = {schemaVersion: 1, costs: {allOf: []}, targeting: {type: "single", required: true, count: 1}};
  const formula = result => rollFormulaForRequest(result.state.pendingRequests[0].payload.rollRequest).formula;
  const club = rolled({...base, id: "action:club", label: "Club", damage: [{id: "club", damageType: "bludgeoning",
    expression: {type: "add", terms: [{type: "dice", number: 1, faces: 8}, {type: "constant", value: 3}]}}]});
  assert.equal(formula(club), "1d8 + 3", "a bonus written into the damage is not dropped");

  const cure = rolled({...base, id: "action:cure", label: "Cure", healing: [{id: "cure", healingType: "healing",
    expression: {type: "add", terms: [{type: "dice", number: 2, faces: 8}, {type: "ability-modifier", ability: "wits"}]}}]},
  {durability: {targetSystems: {"actor:actor-ally": {resources: {health: {value: 3, max: 30}}}}}});
  const request = cure.state.pendingRequests[0];
  assert.equal(request.payload.rollRequest.type, ROLL_TYPES.HEALING);
  assert.equal(formula(cure), "2d8 + 2", "2d8 plus the Wits modifier");
  const healed = resumeStagedActionResolution({state: cure.state, response: {resolutionId: cure.state.id, requestId: request.id,
    type: RESOLUTION_REQUEST_TYPES.ROLL, value: {total: 11}}});
  assert.equal(healed.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(healed.state.errors));
  assert.equal(healed.state.mutationPlans.find(entry => entry.type === "durabilityHealing")?.plan?.to, 14);
});

test("extra damage is its own roll, doubled on a critical, and a hit records its once-per-turn use while a miss does not", () => {
  const definition = {schemaVersion: 1, id: "action:dagger", label: "Dagger", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1}, attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
    damage: [{id: "blade", expression: {type: "dice", number: 1, faces: 4}, damageType: "piercing", provenance: "weapon-base"}]};
  const strike = id => planStagedActionResolution({id, actorSystem: actorSystem(1), action: definitionAction(definition),
    source: {actorId: "actor-source"}, damage: {extraComponents: [{id: "extra:feat-sneak", expression: {type: "dice", number: 1, faces: 6},
      damageType: "fire", provenance: "additional", once: {key: "feat-sneak", turn: "c:1:0"}}]},
    targeting: {required: true, candidates: [{id: "orc", target: target("orc", {defenses: {ac: {value: 12}}}),
      actor: {id: "actor-orc"}, disposition: "enemy", kind: "creature"}]}});
  const answer = (result, value) => {
    const request = result.state.pendingRequests[0];
    return {formula: rollFormulaForRequest(request.payload.rollRequest).formula,
      next: resumeStagedActionResolution({state: result.state, response: {resolutionId: result.state.id, requestId: request.id,
        type: RESOLUTION_REQUEST_TYPES.ROLL, value}})};
  };
  let step = answer(strike("resolution:sneak-crit"), {total: 20, die: 20});
  step = answer(step.next, {total: 5});
  assert.equal(step.formula, "2d4");
  step = answer(step.next, {total: 7});
  assert.equal(step.formula, "2d6", "the extra damage is its own roll, doubled on a critical");
  const used = step.next.state.mutationPlans.find(entry => entry.type === "sourceUpdate");
  assert.deepEqual(used?.updates, {"flags.wildpath.onceUsed.feat-sneak": "c:1:0"}, "the hit records the use for this turn");
  const missed = answer(strike("resolution:sneak-miss"), {total: 3, die: 3}).next;
  assert.equal(missed.state.mutationPlans.some(entry => entry.type === "sourceUpdate"), false, "a miss uses nothing");
});
