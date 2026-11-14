import {test} from "node:test";
import {readFileSync} from "node:fs";
import {projectPendingRequestPayloadForChooser, projectResolutionResultForDisclosure, sanitizeResolutionResultForTransport} from "../module/helpers/multiplayer-authority.mjs";
import {createResolutionCardViewModel} from "../module/helpers/chat-card-view-model.mjs";
import assert from "node:assert/strict";
import {ECONOMY_CAPABILITIES} from "../module/helpers/action-economy.mjs";
import {ACTION_CHOICE_TYPES} from "../module/helpers/action-configuration.mjs";
import {
  RESOLUTION_PIPELINE_CODES,
  RESOLUTION_REQUEST_TYPES,
  RESOLUTION_STATE_STATUS
} from "../module/helpers/resolution-state.mjs";
import {ROLL_TYPES, rollFormulaForRequest} from "../module/helpers/rolls.mjs";
import {targetLookupRefs} from "../module/helpers/target-actor-refs.mjs";
import {AUTOMATION_EVENT_TYPES} from "../module/helpers/automation-events.mjs";
import {
  createPhysicalDiceProvider,
  createTestRollProvider,
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
    ACTION_PIPELINE_STAGE_IDS.DRAW,
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

test("each target rolls its own save, all asked for at once, and gets its own outcome", () => {
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
  const [first, second] = plan.state.pendingRequests;
  assert.equal(plan.state.pendingRequests.length, 2, "both saves wait together, so their rollers roll side by side");
  assert.equal(first.id, "request:resolution:fan-out:save-roll", "the first save keeps the single-target id");
  assert.equal(first.payload.rollRequest.source.id, "orc", "the orc's controller rolls the orc's save");
  assert.equal(second.id, "request:resolution:fan-out:save-roll:2");
  assert.equal(second.payload.rollRequest.source.id, "goblin");
  const afterOrc = answer(plan.state, 15);
  assert.deepEqual(afterOrc.state.pendingRequests.map(request => request.id), [second.id], "the goblin's is still pending");
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

  // Its card names the roll a concentration save and says whether the caster kept its concentration, never the DC.
  const card = state => createResolutionCardViewModel(projectResolutionResultForDisclosure(
    sanitizeResolutionResultForTransport({state}), "broadcast-safe"));
  const rollLabel = state => sanitizeResolutionResultForTransport({state}).rolls.find(roll => roll.requestId === request.id)?.label;
  assert.deepEqual(rollLabel(broken.state), {key: "WILDPATH.CHAT.Roll.Concentration"});
  assert.deepEqual(card(broken.state).targets[0].concentration, {label: "WILDPATH.CHAT.Outcome.ConcentrationLost", tone: "failure"});
  assert.deepEqual(card(kept.state).targets[0].concentration, {label: "WILDPATH.CHAT.Outcome.ConcentrationKept", tone: "success"});
  assert.doesNotMatch(JSON.stringify(projectResolutionResultForDisclosure(sanitizeResolutionResultForTransport({state: broken.state}),
    "broadcast-safe").outcomes.concentration), /dc|total/u);
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

test("an Action's check with a minimum d20 (Reliable Talent) rolls min10, and a typed 3 at +2 succeeds against DC 12", () => {
  const definition = {schemaVersion: 1, id: "action:sneak", label: "Sneak", costs: {allOf: []}, targeting: {type: "self"},
    check: {skill: "stealth", ability: "agility", dc: {value: 12}}};
  const waiting = planStagedActionResolution({id: "resolution:reliable", actorSystem: actorSystem(1), action: definitionAction(definition),
    source: {actorId: "actor-source"}, check: {modifier: 2, naturalMinimum: 10}});
  const request = waiting.state.pendingRequests[0];
  assert.equal(request.payload.rollRequest.definition.dice[0].modifiers[0], "min10");
  assert.equal(request.payload.rollRequest.expected.naturalMinimum, 10);
  const rolled = resumeStagedActionResolution({state: waiting.state,
    response: {resolutionId: waiting.state.id, requestId: request.id, type: RESOLUTION_REQUEST_TYPES.ROLL, value: {die: 3}}});
  assert.equal(rolled.state.results.checkResolution.success, true, "3 counts as 10: 12");
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

test("a critical hit forced on one of several targets doubles the dice for that target only", () => {
  const definition = {schemaVersion: 1, id: "action:sweep", label: "Sweep", costs: {allOf: []},
    targeting: {type: "multiple", required: true, count: 2}, attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
    damage: [{id: "blade", expression: {type: "add", terms: [{type: "dice", number: 1, faces: 8}, {type: "constant", value: 1}]},
      damageType: "slashing", provenance: "weapon-base"}]};
  const strike = (id, outcomesByTarget, ids=["orc", "goblin"], extra={}) => planStagedActionResolution({id, actorSystem: actorSystem(1), action: definitionAction(definition),
    source: {actorId: "actor-source"}, damage: {modifierTotal: 3}, attack: {outcomesByTarget},
    targeting: {required: true, candidates: ids.map(id => ({id, target: target(id, {defenses: {ac: {value: 10}}, ...extra}),
      actor: {id: extra.actorId ?? `actor-${id}`}, disposition: "enemy", kind: "creature"}))}});
  const answer = (result, value) => {
    const request = result.state.pendingRequests[0];
    return {formula: rollFormulaForRequest(request.payload.rollRequest).formula,
      next: resumeStagedActionResolution({state: result.state, response: {resolutionId: result.state.id, requestId: request.id,
        type: RESOLUTION_REQUEST_TYPES.ROLL, value}})};
  };
  const totals = state => Object.fromEntries(state.results.damageResolution.results.map(entry => [entry.target.id, entry.total]));
  let step = answer(strike("resolution:sweep-paralyzed", {"token-orc": "critical-on-hit"}), {total: 17, die: 12});
  step = answer(step.next, {total: 9});
  assert.equal(step.formula, "1d8 + 4", "the goblin's hit is no critical, so the shared roll is not doubled");
  step = answer(step.next, {total: 5});
  assert.equal(step.formula, "1d8", "the orc's critical rolls the dice again, without the flat parts");
  assert.equal(step.next.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(step.next.state.errors));
  assert.deepEqual(totals(step.next.state), {orc: 14, goblin: 9});

  let both = answer(strike("resolution:sweep-both", {"token-orc": "critical-on-hit", "token-goblin": "critical-on-hit"}), {total: 17, die: 12});
  both = answer(both.next, {total: 15});
  assert.equal(both.formula, "2d8 + 4", "every hit a critical: one doubled roll, as before");
  assert.deepEqual(totals(both.next.state), {orc: 15, goblin: 15});

  // Two unlinked Tokens of one goblin Actor share its id: the critical is keyed by Token.
  let twins = answer(strike("resolution:sweep-twins", {"token-a": "critical-on-hit"}, ["a", "b"], {actorId: "actor-goblin"}), {total: 17, die: 12});
  twins = answer(twins.next, {total: 9});
  twins = answer(twins.next, {total: 5});
  assert.equal(twins.next.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(twins.next.state.errors));
  assert.deepEqual(totals(twins.next.state), {a: 14, b: 9}, "goblin B, not critically hit, takes the shared roll alone");
});

test("damage meant for one of two unlinked Tokens of one Actor reaches it alone, critical or not", () => {
  const definition = {schemaVersion: 1, id: "action:sweep", label: "Sweep", costs: {allOf: []},
    targeting: {type: "multiple", required: true, count: 2}, attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
    damage: [{id: "blade", expression: {type: "dice", number: 1, faces: 8}, damageType: "slashing", provenance: "weapon-base"}]};
  const goblin = id => target(id, {actorId: "actor-goblin", defenses: {ac: {value: 10}}});
  // Its own mark on goblin A (Hunter's Mark), by the refs the runtime gives a target: B shares A's actor refs.
  const mark = {id: "extra:mark", expression: {type: "dice", number: 1, faces: 6}, damageType: "force", provenance: "additional",
    metadata: {targetRefs: targetLookupRefs(goblin("a"))}};
  let state = planStagedActionResolution({id: "resolution:sweep-marked", actorSystem: actorSystem(1), action: definitionAction(definition),
    source: {actorId: "actor-source"}, damage: {extraComponents: [mark]}, attack: {outcomesByTarget: {"token-b": "critical-on-hit"}},
    targeting: {required: true, candidates: ["a", "b"].map(id => ({id, target: goblin(id), actor: {id: "actor-goblin"},
      disposition: "enemy", kind: "creature"}))}}).state;
  const asked = [];
  for ( const total of [17, 5, 3, 4] ) {
    const request = state.pendingRequests[0];
    if ( !request ) break;
    asked.push(request.payload.rollRequest.metadata?.componentId ?? request.payload.rollRequest.type);
    state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id,
      type: RESOLUTION_REQUEST_TYPES.ROLL, value: {total, die: 12}}}).state;
  }
  assert.equal(state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(state.errors));
  assert.equal(asked.includes("extra:mark:critical"), false, "no critical die for the mark: B is not marked");
  const totals = Object.fromEntries(state.results.damageResolution.results.map(entry => [entry.target.id,
    entry.components.map(component => component.id).sort()]));
  assert.deepEqual(totals, {a: ["blade", "extra:mark"], b: ["blade", "blade:critical"]}, "the mark on A only, the critical on B only");
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

test("damage and healing are planned on the targets as they are when they apply, not as declared", () => {
  const ally = {id: "actor-ally", now: {resources: {health: {value: 20, max: 30, temp: 0}}}};
  const services = {targetActors: {"actor:actor-ally": ally}, snapshotActor: actor => actor.now};
  const cure = planStagedActionResolution({id: "resolution:cure-later", actorSystem: actorSystem(1), source: {actorId: "actor-source"},
    action: definitionAction({schemaVersion: 1, id: "action:cure", label: "Cure", costs: {allOf: []}, targeting: {type: "single", required: true, count: 1},
      healing: [{id: "cure", healingType: "healing", expression: {type: "dice", number: 1, faces: 8}}]}),
    targets: [target("ally", {disposition: "friendly"})], services,
    durability: {targetSystems: {"actor:actor-ally": {resources: {health: {value: 3, max: 30}}}}}});
  const request = cure.state.pendingRequests[0];
  const healed = resumeStagedActionResolution({state: cure.state, services, response: {resolutionId: cure.state.id, requestId: request.id,
    type: RESOLUTION_REQUEST_TYPES.ROLL, value: {total: 5}}});
  const plan = healed.state.mutationPlans.find(entry => entry.type === "durabilityHealing")?.plan;
  assert.deepEqual([plan.from, plan.to], [20, 25], "healed while it waited: 20 + 5, not the declared 3 + 5");
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

test("Inspiring Help: a die added to the missed attack spends its effect, so the hit gets none of that effect's damage", () => {
  const definition = {schemaVersion: 1, id: "action:dagger", label: "Dagger", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1}, attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
    damage: [{id: "blade", expression: {type: "dice", number: 1, faces: 4}, damageType: "piercing", provenance: "weapon-base"}]};
  const ending = {type: "conditionEffect", conditionId: "custom:helped", levels: -1, action: "delete", existingEffectId: "helped",
    target: {id: "fighter"}};
  const offer = {own: true, chooser: "source-controller", label: "x",
    options: [{value: "add:helped", addDice: {number: 2, faces: 6}, label: "Add Inspiring Help (2d6)", payment: ending}]};
  const strike = id => planStagedActionResolution({id, actorSystem: actorSystem(1), action: definitionAction(definition),
    source: {actorId: "actor-source"}, attack: {inspiration: offer},
    damage: {extraComponents: [{id: "extra:inspiring-help-damage", expression: {type: "dice", number: 2, faces: 6}, damageType: "piercing",
      provenance: "additional", metadata: {ruleId: "inspiring-help-damage", effectId: "helped"}}]},
    targeting: {required: true, candidates: [{id: "orc", target: target("orc", {defenses: {ac: {value: 12}}}),
      actor: {id: "actor-orc"}, disposition: "enemy", kind: "creature"}]}});
  let state = null;
  const answer = value => {
    const request = state.pendingRequests[0];
    state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
      value: typeof value === "function" ? value(request) : value}}).state;
    return request.payload?.rollRequest ? rollFormulaForRequest(request.payload.rollRequest).formula : request.type;
  };
  const roll = total => request => ({requestId: request.payload.rollRequest.id, resolutionId: state.id,
    type: request.payload.rollRequest.type, total, die: total});
  state = strike("resolution:inspired-roll").state;
  answer(roll(8));
  assert.equal(answer("add:helped"), "choice", "the miss offers the die");
  assert.equal(answer(roll(5)), "2d6", "both dice on the roll: 8 + 5 hits AC 12");
  assert.equal(answer(roll(3)), "1d4", "the dagger's damage");
  assert.equal(state.pendingRequests.length, 0, "and no Inspiring Help damage after it");
  assert.ok(state.mutationPlans.some(plan => plan.existingEffectId === "helped"), "the effect is spent");
  state = strike("resolution:inspired-damage").state;
  answer(roll(15));
  assert.deepEqual([answer(roll(3)), answer(roll(7))], ["1d4", "2d6"], "a hit without the die deals it as damage");
});

test("a die or number an offer adds to a missed attack is named on the card by its offer, with the attack's new total", () => {
  const definition = {schemaVersion: 1, id: "action:longsword", label: "Longsword", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1}, attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
    damage: [{id: "blade", expression: {type: "dice", number: 1, faces: 8}, damageType: "slashing", provenance: "weapon-base"}]};
  const offer = {own: true, chooser: "source-controller", label: "x", options: [
    {value: "test-offer:pa", addDice: {number: 1, faces: 8}, name: "Precision Attack", label: "Add Precision Attack (d8)"},
    {value: "ally-offer:gs", addFlat: 10, name: "Guided Strike", label: "Add 10 with Cleric's Guided Strike"},
    {value: "spend:hero", title: "WILDPATH.INSPIRATION.Title", label: "Reroll"}]};
  let state = null;
  const answer = value => {
    const request = state.pendingRequests[0];
    state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
      value: typeof value === "function" ? value(request) : value}}).state;
  };
  const roll = (total, die=total) => request => ({requestId: request.payload.rollRequest.id, resolutionId: state.id,
    type: request.payload.rollRequest.type, total, die});
  const strike = id => planStagedActionResolution({id, actorSystem: actorSystem(1), action: definitionAction(definition),
    source: {actorId: "actor-source"}, attack: {inspiration: offer},
    targeting: {required: true, candidates: [{id: "orc", target: target("orc", {defenses: {ac: {value: 12}}}),
      actor: {id: "actor-orc"}, disposition: "enemy", kind: "creature"}]}}).state;
  const rows = () => sanitizeResolutionResultForTransport({state}).rolls.map(entry => [entry.label, entry.rollResult?.total]);
  state = strike("resolution:precision");
  answer(roll(8, 3));
  assert.equal(state.pendingRequests[0].metadata.title, "WILDPATH.INSPIRATION.OfferTitle",
    "Heroic Inspiration beside other offers: a neutral title");
  answer("test-offer:pa");
  answer(roll(4));
  answer(roll(5));
  assert.deepEqual(rows().slice(0, 2), [[{key: "WILDPATH.CHAT.Roll.Attack"}, 8],
    [{key: "WILDPATH.CHAT.Roll.Added", name: "Precision Attack", total: 12}, 4]], "8 + 4 = 12 hits AC 12");
  state = strike("resolution:guided");
  answer(roll(8, 3));
  answer("ally-offer:gs");
  answer(roll(5));
  assert.deepEqual(rows().slice(0, 2), [[{key: "WILDPATH.CHAT.Roll.Attack"}, 8],
    [{key: "WILDPATH.CHAT.Roll.Added", name: "Guided Strike", total: 18}, 10]], "+10, not the d20's 3 + the bonus");
  assert.equal(sanitizeResolutionResultForTransport({state}).rolls[1].formula, null);
});

test("an offer's question says what the roll came to with its total, the AC only to the GM, from the whole option mix", () => {
  const definition = {schemaVersion: 1, id: "action:longsword", label: "Longsword", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1}, attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
    damage: [{id: "blade", expression: {type: "dice", number: 1, faces: 8}, damageType: "slashing", provenance: "weapon-base"}]};
  const precision = {value: "test-offer:pa", addDice: {number: 1, faces: 8}, name: "Precision Attack", label: "Add Precision Attack (d8)"};
  const asked = (offer, total, metadata={}, attack={}) => {
    let state = planStagedActionResolution({id: `resolution:outcome-${total}`, actorSystem: actorSystem(1), action: definitionAction(definition),
      source: {actorId: "actor-source"}, attack: {inspiration: offer, ...attack},
      targeting: {required: true, candidates: [{id: "orc", target: target("orc", {defenses: {ac: {value: 12}}}),
        actor: {id: "actor-orc"}, disposition: "enemy", kind: "creature"}]}}).state;
    const request = state.pendingRequests[0];
    state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
      value: {requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, total, die: 3,
        metadata}}}).state;
    const {label, labelData} = state.pendingRequests[0].payload;
    return [label, labelData ?? null];
  };
  // A player's own miss: the total it rolled, never the orc's AC.
  const own = {own: true, chooser: "source-controller", rollerName: "Hero", label: "x", options: [precision]};
  assert.deepEqual(asked(own, 8), ["WILDPATH.INSPIRATION.Outcome.attack.Failed", {name: "Hero", total: 8}]);
  assert.deepEqual(projectPendingRequestPayloadForChooser("choice", {label: "k", labelData: {name: "Hero", total: 8}}).labelData,
    {name: "Hero", total: 8}, "the total reaches the player's prompt");
  assert.deepEqual(asked(own, 8, {visibility: "blind"}), ["x", null], "a blind roll's total stays hidden from its player");
  // The GM's monster offer beside the monster's own options: a hit or a miss with the AC, whatever is offered.
  const spend = {value: "spend:Actor.hero", title: "WILDPATH.INSPIRATION.Title", label: "Reroll, spending Hero's point"};
  const monster = {own: false, chooser: "gm", rollerName: "Ogre", label: "monster", options: [spend,
    {...precision, failedOnly: true, offerLabel: "Ogre's roll failed."}]};
  assert.deepEqual(asked(monster, 15), ["WILDPATH.INSPIRATION.Outcome.attack.PassedAgainst", {name: "Ogre", total: 15, against: 12}]);
  assert.deepEqual(asked(monster, 8), ["WILDPATH.INSPIRATION.Outcome.attack.FailedAgainst", {name: "Ogre", total: 8, against: 12}]);
  // A hit a duplicate took (Mirror Image) beat the AC, so its miss names no AC.
  assert.deepEqual(asked(monster, 15, {}, {outcomesByTarget: {"token-orc": {type: "decoy"}}}),
    ["WILDPATH.INSPIRATION.Outcome.attack.Failed", {name: "Ogre", total: 15}]);
  // Without the roller's name: the monster's own options under its own words, not the players' Heroic Inspiration question.
  const unnamed = {...monster, rollerName: undefined};
  assert.deepEqual(asked(unnamed, 15), ["monster", null], "the players' reroll alone: their question");
  assert.deepEqual(asked(unnamed, 8), ["Ogre's roll failed.", null], "beside the monster's own options: what failed");
});

test("a foe's offer on a hit: its dice taken off (named on the card), its critical hit made normal, or a reroll; never on a miss", () => {
  const definition = {schemaVersion: 1, id: "action:longsword", label: "Longsword", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1}, attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
    damage: [{id: "blade", expression: {type: "dice", number: 1, faces: 8}, damageType: "slashing", provenance: "weapon-base"}]};
  const seer = {kind: "specific", userIds: ["player-b"]};
  const foe = (value, extra) => ({value, name: "Boon of Fate", payerRef: "Actor.seer", authority: seer, succeededOnly: true,
    offerLabel: "Orc's roll succeeded. Change the result?", label: value, ...extra});
  const subtract = foe("foe-offer:fate", {addDice: {number: 2, faces: 4, subtract: true}});
  const uncritical = foe("foe-offer:emblem", {uncritical: true, criticalOnly: true});
  const reroll = foe("foe-offer:shield", {});
  const own = {value: "test-offer:pa", addDice: {number: 1, faces: 8}, name: "Precision Attack", label: "Add Precision Attack (d8)"};
  let state = null;
  const answer = value => {
    const request = state.pendingRequests[0];
    state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
      value: typeof value === "function" ? value(request) : value}}).state;
    return request;
  };
  const roll = (total, die=total) => request => ({requestId: request.payload.rollRequest.id, resolutionId: state.id,
    type: request.payload.rollRequest.type, total, die});
  const strike = (id, options, outcomesByTarget=null) => planStagedActionResolution({id, actorSystem: actorSystem(1),
    action: definitionAction(definition), source: {actorId: "actor-source"},
    attack: {inspiration: {own: true, chooser: "source-controller", label: "x", options}, ...(outcomesByTarget ? {outcomesByTarget} : {})},
    targeting: {required: true, candidates: [{id: "orc", target: target("orc", {defenses: {ac: {value: 12}}}),
      actor: {id: "actor-orc"}, disposition: "enemy", kind: "creature"}]}}).state;
  const asked = () => state.pendingRequests[0]?.payload?.options?.map(option => option.value) ?? null;

  // 8 + 5 = 13 hits AC 12: the bearer is asked in its own words (not the roller's own Precision Attack), and its 2 taken
  // off makes 11, a miss.
  state = strike("resolution:foe-subtract", [own, subtract]);
  answer(roll(13, 8));
  assert.deepEqual([asked(), state.pendingRequests[0].authority, state.pendingRequests[0].payload.label],
    [["foe-offer:fate", "keep"], seer, "Orc's roll succeeded. Change the result?"]);
  answer("foe-offer:fate");
  assert.equal(rollFormulaForRequest(state.pendingRequests[0].payload.rollRequest).formula, "2d4");
  answer(roll(2));
  assert.equal(state.results.attackResolution.hits.length, 0, "13 - 2 = 11 misses AC 12");
  assert.deepEqual(sanitizeResolutionResultForTransport({state}).rolls.map(entry => [entry.label, entry.rollResult?.total]).slice(0, 2),
    [[{key: "WILDPATH.CHAT.Roll.Attack"}, 13], [{key: "WILDPATH.CHAT.Roll.Subtracted", name: "Boon of Fate", total: 11}, 2]]);
  // A miss: its own option only, never the foe's.
  state = strike("resolution:foe-miss", [own, subtract]);
  answer(roll(8));
  assert.deepEqual(asked(), ["test-offer:pa", "keep"]);

  // A natural 20: dice taken off change nothing, so only its critical made normal is offered; the hit then rolls 1d8, not 2d8.
  state = strike("resolution:foe-uncritical", [subtract, uncritical]);
  answer(roll(25, 20));
  assert.deepEqual(asked(), ["foe-offer:emblem", "keep"]);
  answer("foe-offer:emblem");
  assert.equal(state.results.attackResolution.hits[0].outcome, "hit");
  assert.equal(rollFormulaForRequest(state.pendingRequests[0].payload.rollRequest).formula, "1d8");
  // A plain hit is no critical: nothing to make normal.
  state = strike("resolution:foe-plain", [uncritical]);
  answer(roll(15));
  assert.equal(state.pendingRequests[0].type, RESOLUTION_REQUEST_TYPES.ROLL, "straight to its damage");
  // A critical hit from the target's state (Paralyzed, within 5 ft) still needs the attack to hit, so dice are offered,
  // and taking them off below AC makes it a miss.
  state = strike("resolution:foe-override", [subtract, uncritical], {"token-orc": "critical-on-hit"});
  answer(roll(13, 8));
  assert.deepEqual(asked(), ["foe-offer:fate", "foe-offer:emblem", "keep"]);
  answer("foe-offer:fate");
  answer(roll(3));
  assert.equal(state.results.attackResolution.hits.length, 0);
  // A foe's reroll: the attacker rolls its d20 again and keeps the new roll.
  state = strike("resolution:foe-reroll", [reroll]);
  answer(roll(15));
  answer("foe-offer:shield");
  assert.equal(state.pendingRequests[0].payload.rollRequest.type, "attack", "the attack's own d20 again");
  answer(roll(6));
  assert.equal(state.results.attackResolution.hits.length, 0, "the new 6 misses");
});

test("Savage Attacker: a hit's weapon dice are rolled twice, the higher kept, doubled on a critical; the hit records its use", () => {
  const definition = {schemaVersion: 1, id: "action:axe", label: "Axe", costs: {allOf: []}, tags: ["weapon"],
    targeting: {type: "single", required: true, count: 1}, attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
    damage: [{id: "blade", expression: {type: "dice", number: 1, faces: 8}, damageType: "slashing", provenance: "weapon-base"}]};
  const strike = id => planStagedActionResolution({id, actorSystem: actorSystem(1), action: definitionAction(definition),
    source: {actorId: "actor-source"}, damage: {modifierTotal: 3, bestOfTwo: {once: {key: "savage-attacker", turn: "c:1:0"}}},
    targeting: {required: true, candidates: [{id: "orc", target: target("orc", {defenses: {ac: {value: 12}}}),
      actor: {id: "actor-orc"}, disposition: "enemy", kind: "creature"}]}});
  const answer = (result, value) => {
    const request = result.state.pendingRequests[0];
    return {formula: rollFormulaForRequest(request.payload.rollRequest).formula,
      next: resumeStagedActionResolution({state: result.state, response: {resolutionId: result.state.id, requestId: request.id,
        type: RESOLUTION_REQUEST_TYPES.ROLL, value}})};
  };
  let step = answer(strike("resolution:savage"), {total: 15, die: 15});
  step = answer(step.next, {total: 9});
  assert.equal(step.formula, "{1d8,1d8}kh + 3");
  assert.deepEqual(step.next.state.mutationPlans.find(entry => entry.type === "sourceUpdate")?.updates,
    {"flags.wildpath.onceUsed.savage-attacker": "c:1:0"});
  step = answer(strike("resolution:savage-crit"), {total: 20, die: 20});
  assert.equal(answer(step.next, {total: 12}).formula, "{2d8,2d8}kh + 3", "a critical doubles the dice in both rolls");
});

test("Piercer: a critical piercing hit rolls one more die; a hit's lowest die below average is rolled again, once a turn", () => {
  const definition = {schemaVersion: 1, id: "action:spear", label: "Spear", costs: {allOf: []}, tags: ["weapon"],
    targeting: {type: "single", required: true, count: 1}, attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
    damage: [{id: "point", expression: {type: "dice", number: 1, faces: 8}, damageType: "piercing", provenance: "weapon-base"}]};
  const strike = (id, damage) => planStagedActionResolution({id, actorSystem: actorSystem(1), action: definitionAction(definition),
    source: {actorId: "actor-source"}, damage, targeting: {required: true, candidates: [{id: "orc",
      target: target("orc", {defenses: {ac: {value: 12}}}), actor: {id: "actor-orc"}, disposition: "enemy", kind: "creature"}]}});
  const answer = (result, value) => {
    const request = result.state.pendingRequests[0];
    return {formula: rollFormulaForRequest(request.payload.rollRequest).formula,
      next: resumeStagedActionResolution({state: result.state, response: {resolutionId: result.state.id, requestId: request.id,
        type: RESOLUTION_REQUEST_TYPES.ROLL, value}})};
  };
  const dice = results => ({total: results.reduce((sum, value) => sum + value, 0),
    dice: [{number: results.length, faces: 8, results: results.map(result => ({result, active: true}))}]});
  const used = state => state.mutationPlans.filter(entry => entry.type === "sourceUpdate").map(entry => entry.updates);
  const crit = answer(strike("resolution:piercer-crit", {criticalDice: [{dice: 1, damageTypes: ["piercing"]}]}), {total: 20, die: 20});
  assert.equal(answer(crit.next, dice([5, 5, 5])).formula, "3d8", "doubled, then one more");
  const puncture = {rerollDice: [{count: 1, once: {key: "f-piercer-puncture", turn: "c:1:0"}}]};
  let step = answer(strike("resolution:puncture", puncture), {total: 15, die: 15});
  step = answer(step.next, dice([2]));
  step = answer(step.next, dice([7]));
  assert.equal(step.formula, "1d8", "the 2, below the average 4.5, is rolled again");
  assert.equal(step.next.state.input.damage.components[0].amount, 7);
  assert.deepEqual(used(step.next.state), [{"flags.wildpath.onceUsed.f-piercer-puncture": "c:1:0"}]);
  step = answer(strike("resolution:puncture-high", puncture), {total: 15, die: 15});
  step = answer(step.next, dice([6]));
  assert.deepEqual([step.next.state.pendingRequests.length, used(step.next.state)], [0, []], "no die to reroll: its use is kept");
  const missed = answer(strike("resolution:puncture-miss", puncture), {total: 3, die: 3}).next;
  assert.deepEqual(used(missed.state), [], "a miss rolls nothing");
});

test("a penalty die is rolled once even on a critical, then taken off the hit's damage, down to its minimum", () => {
  const definition = {schemaVersion: 1, id: "action:dagger", label: "Dagger", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1}, attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
    damage: [{id: "blade", expression: {type: "dice", number: 1, faces: 4}, damageType: "piercing", provenance: "weapon-base"}]};
  const strike = (id, minimum) => planStagedActionResolution({id, actorSystem: actorSystem(1), action: definitionAction(definition),
    source: {actorId: "actor-source"}, damage: {extraComponents: [{id: "extra:reduced", expression: {type: "dice", number: 1, faces: 4},
      damageType: "piercing", provenance: "additional", metadata: {ruleId: "reduced", subtract: true, ...(minimum ? {minimum} : {})}}]},
    targeting: {required: true, candidates: [{id: "orc", target: target("orc", {defenses: {ac: {value: 12}}}),
      actor: {id: "actor-orc"}, disposition: "enemy", kind: "creature"}]}});
  const answer = (result, value) => {
    const request = result.state.pendingRequests[0];
    return {formula: rollFormulaForRequest(request.payload.rollRequest).formula,
      next: resumeStagedActionResolution({state: result.state, response: {resolutionId: result.state.id, requestId: request.id,
        type: RESOLUTION_REQUEST_TYPES.ROLL, value}})};
  };
  const dealt = state => state.input.damage.components.map(component => component.amount);
  let step = answer(strike("resolution:reduced-crit"), {total: 20, die: 20});
  step = answer(step.next, {total: 6});
  assert.equal(step.formula, "2d4", "the dagger's own dice are doubled");
  step = answer(step.next, {total: 2});
  assert.equal(step.formula, "1d4", "the penalty's are not");
  assert.deepEqual(dealt(step.next.state), [4, 0], "6 less 2");
  assert.equal(step.next.state.input.damage.components[1].metadata.subtracted, 2);
  const lessFour = (id, minimum) => dealt(answer(answer(answer(strike(id, minimum), {total: 15, die: 15}).next, {total: 2}).next,
    {total: 4}).next.state);
  assert.deepEqual(lessFour("resolution:reduced-floor", 1), [1, 0], "Reduce: 2 less 4 is still 1 damage");
  assert.deepEqual(lessFour("resolution:enfeebled", undefined), [0, 0], "Ray of Enfeeblement: none");
  // The card names each roll from the authority's own requests: the dagger's damage, then the penalty.
  const labels = sanitizeResolutionResultForTransport({state: step.next.state}).rolls.map(roll => roll.label);
  assert.deepEqual(labels, [{key: "WILDPATH.CHAT.Roll.Attack"}, {key: "WILDPATH.CHAT.Roll.Damage", damageType: "piercing"},
    {key: "WILDPATH.CHAT.Roll.LessDamage"}]);
});

test("a rider's dice may keep only their highest (Mirror Image's d6 per duplicate): the roll asked is 2d6kh", () => {
  const images = {schemaVersion: 1, id: "action:images", label: "Mirror Image", costs: {allOf: []}, targeting: {type: "self"},
    rider: {missChance: {dice: {type: "dice", number: 2, faces: 6}, keep: "highest", atLeast: 3}}};
  const plan = planStagedActionResolution({id: "resolution:images", actorSystem: actorSystem(1), action: definitionAction(images),
    source: {actorId: "actor-source"}});
  const request = plan.state.pendingRequests[0];
  assert.equal(rollFormulaForRequest(request.payload.rollRequest).formula, "2d6kh");
  const done = resumeStagedActionResolution({state: plan.state, response: {resolutionId: plan.state.id, requestId: request.id,
    type: RESOLUTION_REQUEST_TYPES.ROLL, value: {total: 4}}});
  assert.deepEqual([done.state.results.parentDirective.data.missChance.total, done.state.results.parentDirective.data.missChance.missed], [4, true]);
  // Its d6s are a roll of its own, on its card.
  assert.deepEqual(sanitizeResolutionResultForTransport({state: done.state}).rolls.map(roll => [roll.formula, roll.rollResult?.total]),
    [["2d6kh", 4]]);
});

/** A spell (unless `tags` say otherwise) paid with the Action and one slot, cast by a caster with Boon of Spell Recall. */
function recalledCast(id, {cost="spell-slot.2", pool=cost, tags=["spell"], classes=[],
  recall={dice: {type: "dice", number: 1, faces: 4}, maxLevel: 4}}={}) {
  const bolt = {schemaVersion: 1, id: "action:bolt", label: "Bolt", tags, targeting: {type: "self"},
    costs: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}, {capability: cost, amount: 1}]}};
  return planStagedActionResolution({id, actorSystem: {...actorSystem(1, {pools: [{id: pool, value: 1, max: 2}]}), classes},
    action: definitionAction(bolt), source: {actorId: "actor-source"}, slotRecall: recall});
}

function answerRoll(plan, value) {
  const request = plan.state.pendingRequests[0];
  return resumeStagedActionResolution({state: plan.state, response: {resolutionId: plan.state.id, requestId: request.id,
    type: RESOLUTION_REQUEST_TYPES.ROLL, value}});
}

const paidUpdates = state => state.mutationPlans.find(entry => entry.type === "resourcePayment").plan.updates;

test("Boon of Spell Recall: a spell cast with a level-2 slot rolls 1d4; a 2 keeps the slot, a 3 spends it", () => {
  const plan = recalledCast("resolution:recall");
  assert.equal(plan.state.status, RESOLUTION_STATE_STATUS.AWAITING_ROLL);
  assert.equal(plan.state.pendingRequests[0].chooser, "source-controller", "its caster rolls it");
  assert.equal(rollFormulaForRequest(plan.state.pendingRequests[0].payload.rollRequest).formula, "1d4");
  const kept = answerRoll(plan, {total: 2});
  assert.equal(kept.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT);
  assert.deepEqual(paidUpdates(kept.state), {"system.resources.action.value": 0}, "the Action is spent, the slot is not");
  assert.deepEqual(kept.state.results.paymentResolution.paymentPlan.resources.map(entry => entry.resourceId), ["economy.action", "spell-slot.2"],
    "the spell was still cast with the slot");
  const step = kept.state.results.actionResult.steps.find(entry => entry.stage === "resourcePayment");
  assert.deepEqual(step.data.slotRecall, {level: 2, total: 2, kept: true});
  assert.deepEqual(sanitizeResolutionResultForTransport({state: kept.state}).rolls.map(roll => [roll.formula, roll.rollResult?.total, roll.label]),
    [["1d4", 2, {key: "WILDPATH.CHAT.Roll.SlotKept"}]], "its d4 is on the card");
  const spent = answerRoll(recalledCast("resolution:recall-spent"), {total: 3});
  assert.deepEqual(paidUpdates(spent.state), {"system.resources.action.value": 0, "system.pools.0.value": 0});
  assert.deepEqual(sanitizeResolutionResultForTransport({state: spent.state}).rolls.map(roll => roll.label), [{key: "WILDPATH.CHAT.Roll.SlotSpent"}]);
});

test("Boon of Spell Recall: no d4 for a level-5 slot, a slot spent by no spell (Eldritch Smite), a free cast, or without the boon", () => {
  const cases = {
    "a level-5 slot": recalledCast("resolution:recall-5", {cost: "spell-slot.5"}),
    "Eldritch Smite's untagged pact slot": recalledCast("resolution:recall-eldritch", {cost: "spell-slot.pact", tags: [],
      classes: [{id: "warlock", level: 5, spellcasting: {progression: "pact"}}]}),
    "a free cast": recalledCast("resolution:recall-free", {cost: "fey-touched"}),
    "no boon": recalledCast("resolution:recall-none", {recall: null})
  };
  for ( const [name, plan] of Object.entries(cases) ) {
    assert.equal(plan.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, name);
    assert.equal(paidUpdates(plan.state)["system.pools.0.value"], 0, `${name}: spent as usual`);
  }
});

test("Boon of Spell Recall: a Pact Magic slot rolls at its Pact Magic level, even paying for a lower-level spell", () => {
  const warlock = {pool: "spell-slot.pact", classes: [{id: "warlock", level: 5, spellcasting: {progression: "pact"}}]};
  assert.deepEqual(paidUpdates(answerRoll(recalledCast("resolution:pact", {...warlock, cost: "spell-slot.1"}), {total: 3}).state),
    {"system.resources.action.value": 0}, "a 3 keeps a level-3 pact slot");
  assert.equal(paidUpdates(answerRoll(recalledCast("resolution:pact-1", {...warlock, cost: "spell-slot.1"}), {total: 1}).state)["system.pools.0.value"], 0,
    "a 1 does not: the slot is level 3");
});

test("Boon of Spell Recall: 2024 Wild Companion casts Find Familiar with its slot, so a 1 keeps a level-1 slot", () => {
  const companion = JSON.parse(readFileSync("packs/_source/srd-items/wild-companion-summon-with-spell-slot-phbdrdWildCompan.json", "utf8"))
    .system.definition;
  assert.ok(companion.tags.includes("component:verbal") && !companion.tags.includes("component:material"), "Counterspell sees it; no Material");
  const plan = planStagedActionResolution({id: "resolution:wild-companion", actorSystem: actorSystem(1, {pools: [{id: "spell-slot.1", value: 1, max: 2}]}),
    action: definitionAction(companion), source: {actorId: "actor-source"}, slotRecall: {dice: {type: "dice", number: 1, faces: 4}, maxLevel: 4}});
  const configured = resumeStagedActionResolution({state: plan.state, response: {resolutionId: plan.state.id, requestId: plan.state.pendingRequests[0].id,
    type: RESOLUTION_REQUEST_TYPES.ACTION_CONFIGURATION,
    value: {choices: {slot: "spell-slot.1", "summon-creature": companion.configuration[1].options[0].id}}}});
  assert.equal(configured.state.status, RESOLUTION_STATE_STATUS.AWAITING_ROLL, "its d4 is rolled");
  assert.deepEqual(paidUpdates(answerRoll(configured, {total: 1}).state), {"system.resources.action.value": 0}, "the slot is kept");
});

test("Boon of Spell Recall: physical and digital d4s keep the slot alike, and an answered d4 is not asked again", async () => {
  const kept = async (id, providers, context={}) => {
    const plan = recalledCast(id);
    const rollRequest = plan.state.pendingRequests[0].payload.rollRequest;
    const provided = await executeRollRequest({request: rollRequest, providers, context: {physicalRolls: {[rollRequest.id]: {
      requestId: rollRequest.id, resolutionId: rollRequest.resolutionId, type: rollRequest.type, total: 2}}, ...context}});
    assert.equal(provided.ok, true, JSON.stringify(provided));
    return answerRoll(plan, provided.result);
  };
  const physical = await kept("resolution:recall-physical", [createPhysicalDiceProvider()]);
  const digital = await kept("resolution:recall-digital", [createTestRollProvider({result: {total: 2}})]);
  for ( const done of [physical, digital] ) assert.deepEqual(paidUpdates(done.state), {"system.resources.action.value": 0});
  assert.equal(physical.state.rollResults[0].rollResult.provenance.type, "physical");
  const again = resumeStagedActionResolution({state: physical.state, response: {resolutionId: physical.state.id,
    requestId: physical.state.rollResults[0].requestId, type: RESOLUTION_REQUEST_TYPES.ROLL, value: {total: 3}}});
  assert.equal(again.state.rollRequests.filter(request => request.id.endsWith("slot-recall")).length, 1, "one d4 only");
  assert.deepEqual(paidUpdates(again.state), {"system.resources.action.value": 0});
});

test("a reaction that counters (Counterspell): its target's failed save asks the parent to be cancelled; a success does not", () => {
  const counterspell = {schemaVersion: 1, id: "action:counterspell", label: "Counterspell", costs: {allOf: []}, counters: true,
    targeting: {type: "single", required: true, count: 1}, save: {ability: "fortitude", dc: {value: 15}}};
  const cast = (id, natural) => {
    const plan = planStagedActionResolution({id, actorSystem: actorSystem(1), action: definitionAction(counterspell),
      source: {actorId: "actor-source"}, targets: [target("caster")]});
    const request = plan.state.pendingRequests[0];
    return resumeStagedActionResolution({state: plan.state, response: {resolutionId: plan.state.id, requestId: request.id,
      type: RESOLUTION_REQUEST_TYPES.ROLL, value: {requestId: request.payload.rollRequest.id, resolutionId: plan.state.id,
        type: request.payload.rollRequest.type, natural, total: natural}}});
  };
  assert.deepEqual(cast("resolution:countered", 4).state.results.parentDirective,
    {type: "cancel-parent", code: "COUNTERED", reason: "Counterspell stopped it."});
  assert.equal(cast("resolution:resisted", 18).state.results.parentDirective, undefined);
});

test("a target's save floor (Indomitable Might) rides its save request: a typed 2 at +1 counts as 18 against DC 15", () => {
  const shove = {schemaVersion: 1, id: "action:shove", label: "Shove", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1}, save: {ability: "might", dc: {value: 15}}};
  const plan = planStagedActionResolution({id: "resolution:might", actorSystem: actorSystem(1), action: definitionAction(shove),
    source: {actorId: "actor-source"}, targets: [target("barbarian")],
    save: {modifiersByTarget: {"token-barbarian": 1}, totalMinimumByTarget: {"token-barbarian": 18}}});
  const request = plan.state.pendingRequests[0];
  assert.equal(request.payload.rollRequest.expected.totalMinimum, 18);
  const rolled = resumeStagedActionResolution({state: plan.state, response: {resolutionId: plan.state.id, requestId: request.id,
    type: RESOLUTION_REQUEST_TYPES.ROLL, value: {die: 2}}});
  assert.equal(rolled.state.results.saveResolution?.results?.[0]?.success ?? rolled.state.results.saveResolution?.success, true,
    JSON.stringify(rolled.state.results.saveResolution));
});

test("an Action its creature cannot pay for is refused before anything is rolled (Command's Halt, Incapacitated)", () => {
  const strike = {schemaVersion: 1, id: "action:strike", label: "Strike", costs: {allOf: [{capability: "action", amount: 1}]},
    targeting: {type: "single", required: true, count: 1}, attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
    damage: [{id: "blade", expression: {type: "dice", number: 1, faces: 8}, damageType: "slashing", provenance: "weapon-base"}]};
  const plan = planStagedActionResolution({id: "resolution:halted", actorSystem: actorSystem(0), action: definitionAction(strike),
    source: {actorId: "actor-source"}, targets: [target("orc")]});
  assert.equal(plan.state.status, RESOLUTION_STATE_STATUS.FAILED);
  assert.equal(plan.state.errors.at(-1).code, "PAYMENT_UNAVAILABLE");
  assert.deepEqual(plan.state.pendingRequests, [], "no attack roll was asked for");
});

test("an extra action given for listed Actions (Haste's) pays them by the tags a Forbid tests them by", () => {
  const hasted = actorSystem(0, {pools: [{id: "haste-extra-action", value: 1, max: 1, recovery: "turn", pays: ["action"],
    actions: {tagsAny: ["attack", "id:common:dash"]}}]});
  const strike = {schemaVersion: 1, id: "action:strike", label: "Strike", costs: {allOf: [{capability: "action", amount: 1}]},
    targeting: {type: "single", required: true, count: 1}, attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
    damage: [{id: "blade", expression: {type: "dice", number: 1, faces: 8}, damageType: "slashing", provenance: "weapon-base"}]};
  const attack = planStagedActionResolution({id: "resolution:hasted-strike", actorSystem: hasted, action: definitionAction(strike),
    source: {actorId: "actor-source"}, targets: [target("orc")]});
  assert.notEqual(attack.state.status, RESOLUTION_STATE_STATUS.FAILED, JSON.stringify(attack.state.errors));
  // The payment stage pays it from the extra action too.
  const dash = {schemaVersion: 1, id: "common:dash", label: "Dash", costs: {allOf: [{capability: "action", amount: 1}]},
    targeting: {type: "self"}};
  const dashed = planStagedActionResolution({id: "resolution:hasted-dash", actorSystem: hasted, action: definitionAction(dash),
    source: {actorId: "actor-source"}});
  assert.equal(dashed.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(dashed.state.errors));
  assert.deepEqual(paidUpdates(dashed.state), {"system.pools.0.value": 0});
});

test("drop to 0: Relentless Endurance keeps 1 HP for a use; a save keeps it up (or not); radiant bars Undead Fortitude; massive damage kills", () => {
  const blast = (damageType, amount) => ({schemaVersion: 1, id: `action:blast-${damageType}-${amount}`, label: "Blast", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1},
    damage: [{id: "blast", expression: {type: "constant", value: amount}, damageType}]});
  const run = (definition, zeroHp, extra={}) => planStagedActionResolution({id: `resolution:${definition.id}:${zeroHp?.mode ?? "none"}`,
    actorSystem: actorSystem(1), action: definitionAction(definition), source: {actorId: "actor-source"},
    targets: [target("orc")], durability: {targetSystems: {"actor:actor-orc": {resources: {health: {value: 3, max: 30}}}},
      ...(zeroHp ? {zeroHpByTarget: {"token-orc": zeroHp}} : {}), ...extra}});
  const health = state => state.mutationPlans.find(entry => entry.type === "durabilityDamage")?.plan.to;
  const payment = {plan: {ok: true, updates: {"system.pools.0.value": 0}, payments: []}, payerRef: "Actor.orc"};
  const endurance = run(blast("slashing", 10), {name: "Relentless Endurance", mode: "set", hitPoints: 1, payment});
  assert.equal(health(endurance.state), 1);
  assert.ok(endurance.state.mutationPlans.some(entry => (entry.type === "resourcePayment") && (entry.payerRef === "Actor.orc")), "its use is paid");
  assert.equal(health(run(blast("slashing", 40), {name: "Relentless Endurance", mode: "set", hitPoints: 1, payment}).state), 0, "massive damage");

  const fortitude = {name: "Undead Fortitude", mode: "save", ability: "fortitude", saveBonus: 3, dcPlusDamage: 5, hitPoints: 1, notOn: ["radiant", "critical"]};
  const asked = run(blast("slashing", 10), fortitude);
  assert.equal(asked.state.pendingRequests[0].payload.rollKind, "zero-hp");
  const answer = total => resumeStagedActionResolution({state: asked.state, response: {resolutionId: asked.state.id,
    requestId: asked.state.pendingRequests[0].id, type: RESOLUTION_REQUEST_TYPES.ROLL, value: {total, die: total - 3}}});
  assert.equal(health(answer(15).state), 1, "15 against DC 5 + 10");
  assert.equal(health(answer(14).state), 0);
  const radiant = run(blast("radiant", 10), fortitude);
  assert.deepEqual([radiant.state.pendingRequests.length, health(radiant.state)], [0, 0], "radiant damage bars it");
});

test("Blessed Healer: healing another creature with a spell heals its caster 2 + the slot's level, once; on top when it is healed too", () => {
  const definition = count => ({schemaVersion: 1, id: "action:cure", label: "Cure", costs: {allOf: []},
    targeting: (count > 1) ? {type: "multiple", required: true, count} : {type: "single", required: true, count: 1},
    tags: ["spell"], healing: [{id: "cure", healingType: "healing", expression: {type: "constant", value: 4}}]});
  const run = (targets, allyHealth=3, casterHealth=10, caster={resources: {health: {value: casterHealth, max: 30, temp: 0}}}) =>
    planStagedActionResolution({id: `resolution:healer-${targets.length}-${allyHealth}-${casterHealth}`,
    actorSystem: actorSystem(1, caster), action: definitionAction(definition(targets.length)), source: {actorId: "actor-source", tokenId: "token-source"},
    targets, durability: {targetSystems: {"actor:actor-ally": {resources: {health: {value: allyHealth, max: 30}}},
      "actor:actor-source": caster}, onHeal: {name: "Blessed Healer", hitPoints: 5, sourceRef: "Actor.source"}}});
  const ownPlans = state => state.mutationPlans.filter(entry => (entry.type === "durabilityHealing") && ((entry.targetRef === "Actor.source")
    || (entry.target?.tokenId === "token-source")));
  const ally = target("ally");
  const self = {...target("source"), tokenId: "token-source"};
  const healed = run([ally]).state;
  assert.deepEqual(ownPlans(healed).map(entry => [entry.plan.from, entry.plan.to]), [[10, 15]], "2 + level as the runtime gives it");
  assert.deepEqual(ownPlans(run([ally], 30).state), [], "an ally at full Hit Points regained none");
  assert.deepEqual(ownPlans(run([self]).state).map(entry => [entry.plan.from, entry.plan.to]), [[10, 14]], "only itself: no reward");
  assert.deepEqual(ownPlans(run([self, ally]).state).map(entry => [entry.plan.from, entry.plan.to, entry.plan.amount]), [[10, 19, 9]],
    "itself and an ally: one plan, 4 + 5 (its amount too, so a commit rebased on other healing keeps the reward)");
  assert.deepEqual(ownPlans(run([self, ally], 3, 28).state).map(entry => [entry.plan.from, entry.plan.to, entry.plan.amount]), [[28, 30, 9]],
    "clamped at its maximum, its amount still counts the whole reward, for a commit rebased on damage taken since");
});

test("Life Bond: a bonded steed regains what its summoner regained from the spell, on top of its own healing; nothing at full", () => {
  const definition = count => ({schemaVersion: 1, id: "action:cure", label: "Cure", costs: {allOf: []},
    targeting: {type: "multiple", required: true, count}, tags: ["spell"],
    healing: [{id: "cure", healingType: "healing", expression: {type: "constant", value: 4}}]});
  const steed = {...target("steed"), tokenId: "token-steed"};
  const run = (targets, riderHealth) => planStagedActionResolution({id: `resolution:bond-${targets.length}-${riderHealth}`,
    actorSystem: actorSystem(1), action: definitionAction(definition(targets.length)), source: {actorId: "actor-source"}, targets,
    durability: {targetSystems: {"actor:actor-rider": {resources: {health: {value: riderHealth, max: 30}}},
      "actor:actor-steed": {resources: {health: {value: 5, max: 20}}}},
    lifeBonds: [{casterTokenId: "token-rider", sourceRef: "Actor.steed", target: steed,
      actorSystem: {resources: {health: {value: 5, max: 20}}}}]}});
  const steedPlans = state => state.mutationPlans.filter(entry => (entry.type === "durabilityHealing") && (entry.target?.tokenId === "token-steed"))
    .map(entry => [entry.plan.from, entry.plan.to]);
  assert.deepEqual(steedPlans(run([target("rider")], 10).state), [[5, 9]], "4, as its rider regained");
  assert.deepEqual(steedPlans(run([target("rider")], 28).state), [[5, 7]], "the 2 its rider regained");
  assert.deepEqual(steedPlans(run([target("rider")], 30).state), [], "a rider at full regained none");
  assert.deepEqual(steedPlans(run([target("rider"), steed], 10).state), [[5, 13]], "healed too: one plan, 4 + 4");
  assert.equal(run([target("rider"), steed], 10).state.mutationPlans.find(entry => entry.target?.tokenId === "token-steed").plan.amount, 8,
    "its amount counts the bond's 4");
  // A Blessed Healer healing only itself gains nothing for its steed's Life Bond healing.
  const healer = planStagedActionResolution({id: "resolution:bond-healer", actorSystem: actorSystem(1, {resources: {health: {value: 10, max: 30}}}),
    action: definitionAction(definition(1)), source: {actorId: "actor-rider", tokenId: "token-rider"}, targets: [target("rider")],
    durability: {targetSystems: {"actor:actor-rider": {resources: {health: {value: 10, max: 30}}}},
      onHeal: {name: "Blessed Healer", hitPoints: 5, sourceRef: "Actor.rider"},
      lifeBonds: [{casterTokenId: "token-rider", sourceRef: "Actor.steed", target: steed, actorSystem: {resources: {health: {value: 5, max: 20}}}}]}});
  assert.deepEqual(healer.state.mutationPlans.filter(entry => entry.type === "durabilityHealing")
    .map(entry => [entry.target?.tokenId, entry.plan.from, entry.plan.to]), [["token-rider", 10, 14], ["token-steed", 5, 9]], "no Blessed Healer");
});

test("drop to 0: Dark One's Blessing gives its source Temporary Hit Points for a hostile creature dropped", () => {
  const definition = {schemaVersion: 1, id: "action:blast", label: "Blast", costs: {allOf: []}, targeting: {type: "single", required: true, count: 1},
    damage: [{id: "blast", expression: {type: "constant", value: 10}, damageType: "force"}]};
  const run = hostileKeys => planStagedActionResolution({id: `resolution:blessing-${hostileKeys.length}`,
    actorSystem: actorSystem(1, {resources: {health: {value: 10, max: 10, temp: 0}}}),
    action: definitionAction(definition), source: {actorId: "actor-source"}, targets: [target("orc")],
    durability: {targetSystems: {"actor:actor-orc": {resources: {health: {value: 3, max: 30}}}},
      onReduce: {name: "Dark One's Blessing", temporaryHitPoints: 7, hostileOnly: true, hostileKeys, sourceRef: "Actor.source"}}});
  const reward = state => state.mutationPlans.find(entry => (entry.type === "durabilityHealing") && (entry.targetRef === "Actor.source"));
  assert.ok(reward(run(["token-orc"]).state), "a hostile creature dropped");
  assert.equal(reward(run([]).state), undefined, "not an ally");
});

test("source damage (Overchannel's backlash): rolled after the maximized damage, ignoring Resistance and Immunity, checks the caster's Concentration", () => {
  const plan = (id, backlashDice) => planStagedActionResolution({id, actorSystem: actorSystem(1),
    action: definitionAction({schemaVersion: 1, id: "action:bolt", label: "Bolt", tags: ["spell"], costs: {allOf: []},
      targeting: {type: "single", required: true, count: 1}, metadata: {maximized: true},
      damage: [{id: "fire", expression: {type: "dice", number: 3, faces: 6}, damageType: "fire"}],
      sourceDamage: [{id: "backlash", expression: {type: "dice", number: backlashDice, faces: 12}, damageType: "necrotic",
        ignoreResistance: true, ignoreImmunity: true}]}),
    source: {actorId: "actor-caster", tokenId: "token-caster"}, targets: [target("orc")],
    durability: {targetSystems: {"token-orc": targetActorSystem(30, 30), "token-caster": targetActorSystem(40, 40)},
      adjustmentProfiles: {"token-caster": {resistances: ["necrotic"], immunities: ["necrotic"]}}},
    concentration: {states: {"token-caster": {concentrating: true, actorId: "actor-caster", sourceRef: "token:token-caster"}}, dependents: []}});
  const answer = (state, total) => {
    const request = state.pendingRequests[0];
    return resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: RESOLUTION_REQUEST_TYPES.ROLL,
      value: {requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, natural: total, total}}});
  };
  const waiting = plan("resolution:backlash", 2);
  assert.deepEqual(waiting.state.pendingRequests.map(request => request.payload.rollKind), ["sourceDamage"],
    "its own damage is not rolled: 3d6 at their maximum");
  assert.deepEqual(waiting.state.pendingRequests[0].payload.rollRequest.definition.dice.map(die => [die.number, die.faces]), [[2, 12]]);
  const damaged = answer(waiting.state, 13);
  assert.deepEqual(damaged.state.results.damageResolution.results.map(result => [result.target.tokenId, result.total]),
    [["token-orc", 18], ["token-caster", 13]]);
  assert.equal(damaged.state.pendingRequests[0].payload.rollKind, "concentration", "the caster checks its Concentration");
  assert.equal(damaged.state.pendingRequests[0].payload.targets[0].tokenId, "token-caster");
  const done = answer(damaged.state, 15);
  assert.equal(done.ok, true, JSON.stringify(done.state.errors));
  assert.deepEqual(done.state.mutationPlans.filter(entry => entry.type === "durabilityDamage").map(entry => [entry.targetRef, entry.plan.updates]),
    [["token:token-orc", {"system.resources.health.value": 12}], ["token:token-caster", {"system.resources.health.value": 27}]],
    "13 Necrotic though the caster resists and is immune to it");
  const free = plan("resolution:free", 0);
  assert.equal(free.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, "no backlash die: nothing to roll or check");
  assert.deepEqual(free.state.results.damageResolution.results.map(result => result.target.tokenId), ["token-orc"]);
});

test("source damage threatens the concentration its Action starts: a failed check keeps none of it, though the caster held none before", () => {
  const plan = id => planStagedActionResolution({id, actorSystem: actorSystem(1),
    action: definitionAction({schemaVersion: 1, id: "action:wall", label: "Wall", tags: ["spell"], costs: {allOf: []},
      targeting: {type: "single", required: true, count: 1},
      damage: [{id: "fire", expression: {type: "constant", value: 5}, damageType: "fire"}],
      effects: [{id: "blind", type: "condition", conditionId: "blinded", concentration: true}],
      sourceDamage: [{id: "backlash", expression: {type: "constant", value: 30}, damageType: "necrotic"}]}),
    source: {actorId: "actor-caster", tokenId: "token-caster"}, targets: [target("orc")],
    durability: {targetSystems: {"token-orc": targetActorSystem(30, 30), "token-caster": targetActorSystem(40, 40)}}});
  const check = (id, total) => {
    const {state} = plan(id);
    const request = state.pendingRequests[0];
    assert.equal(request?.payload.rollKind, "concentration", "no concentration before, yet the caster checks the new one");
    assert.equal(request.payload.targets[0].tokenId, "token-caster");
    return resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: RESOLUTION_REQUEST_TYPES.ROLL,
      value: {requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, natural: total, total}}});
  };
  const effects = done => done.state.mutationPlans.filter(entry => entry.type === "conditionEffect").map(entry => entry.conditionId);
  const lost = check("resolution:lost", 3);
  assert.equal(lost.ok, true, JSON.stringify(lost.state.errors));
  assert.deepEqual(effects(lost), [], "its concentration effect is never created");
  assert.deepEqual(lost.state.results.concentrationResolution.checks.decisions.map(decision => [decision.dc, decision.outcome]),
    [[15, "broken"]], "DC half its 30 backlash");
  assert.equal(lost.state.results.concentrationResolution.startedLost, true, "the runtime ends its area, summons or marker");
  assert.equal(lost.state.mutationPlans.filter(entry => entry.type === "durabilityDamage").length, 2, "the damage still lands");
  const kept = check("resolution:kept", 20);
  assert.deepEqual(effects(kept), ["blinded"]);
  assert.equal(kept.state.results.concentrationResolution.startedLost, undefined);
});
