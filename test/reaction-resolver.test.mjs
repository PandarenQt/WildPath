import {test} from "node:test";
import assert from "node:assert/strict";
import {
  ECONOMY_CAPABILITIES,
  createBuiltinEconomyResource
} from "../module/helpers/action-economy.mjs";
import {
  AUTOMATION_CODES,
  AUTOMATION_EVENT_PHASES,
  AUTOMATION_EVENT_TYPES,
  createAutomationEvent,
  createReactionTrigger
} from "../module/helpers/automation-events.mjs";
import {
  MULTIPLAYER_AUTHORITY_CODES,
  MULTIPLAYER_MESSAGE_TYPES,
  createResolutionSocketEnvelope
} from "../module/helpers/multiplayer-authority.mjs";
import {
  RESOLUTION_PIPELINE_CODES,
  RESOLUTION_REQUEST_TYPES,
  RESOLUTION_STATE_STATUS,
  completeResolutionStage,
  createResolutionPipelineStage,
  createResolutionState,
  resumeResolutionPipeline,
  runResolutionPipeline,
  updateResolutionState,
  validateResolutionStateSerializable
} from "../module/helpers/resolution-state.mjs";
import {createTestDocumentPersistenceAdapter} from "../module/adapters/test-persistence-adapter.mjs";
import {createTestPromptAdapter} from "../module/adapters/test-prompt-adapter.mjs";
import {createTestResolutionTransportHub} from "../module/adapters/test-resolution-transport.mjs";
import {resolveAttackTargets} from "../module/resolvers/attack-resolver.mjs";
import {
  createActionResolutionState,
  executeStagedActionResolution
} from "../module/resolvers/action-pipeline-resolver.mjs";
import {createMultiplayerActionCoordinator} from "../module/resolvers/multiplayer-action-coordinator.mjs";
import {
  REACTION_CHOICE_DECISIONS,
  REACTION_PARENT_DIRECTIVES,
  REACTION_RESOLVER_CODES,
  REACTION_WINDOW_STATUS,
  REACTION_WINDOW_TIMINGS,
  completeReactionChildResolution,
  createReactionWindowStage,
  discoverReactionCandidates,
  planReactionWindow,
  resolveReactionChoiceResponse
} from "../module/resolvers/reaction-resolver.mjs";

function parentState(overrides={}) {
  return createResolutionState({
    id: "resolution:parent",
    status: RESOLUTION_STATE_STATUS.RUNNING,
    currentStageId: "action.attack-outcome",
    source: {actorId: "attacker", actorRef: "actor:attacker"},
    actionDefinition: {
      id: "action:parent-attack",
      label: "Parent Attack"
    },
    targets: [{id: "defender", actorId: "defender"}],
    results: {
      attackResolution: resolveAttackTargets({
        roll: {total: 18, die: 13},
        targets: [{id: "defender", actorId: "defender", defenses: {ac: {value: 16}}}]
      })
    },
    ...overrides
  });
}

function hitEvent(actorId="defender") {
  return createAutomationEvent({
    id: "event:preliminary-hit",
    type: AUTOMATION_EVENT_TYPES.ATTACK_HIT,
    phase: AUTOMATION_EVENT_PHASES.INTERRUPT,
    source: {actorId: "attacker"},
    targets: [{actorId}],
    tags: ["weapon-attack"],
    data: {
      outcome: "hit",
      attackTotal: 18,
      defenseValue: 16
    }
  });
}

function declaredEvent() {
  return createAutomationEvent({
    id: "event:declared",
    type: AUTOMATION_EVENT_TYPES.ACTION_DECLARED,
    phase: AUTOMATION_EVENT_PHASES.INTERRUPT,
    source: {actorId: "caster"},
    tags: ["spell"]
  });
}

function reactionActionDefinition({
  id="action:reactive-guard",
  label="Reactive Guard",
  cost={allOf: [{capability: ECONOMY_CAPABILITIES.REACTION, amount: 1}]}
}={}) {
  return {
    schemaVersion: 1,
    id,
    label,
    costs: cost
  };
}

function actionItem(definition) {
  return {
    id: definition.id,
    type: "action",
    name: definition.label,
    system: {definition}
  };
}

function actorSystem({reaction=1, action=1}={}) {
  return {
    resources: {
      action: {value: action, max: 1},
      bonus: {value: 1, max: 1},
      reaction: {value: reaction, max: 1},
      movement: {value: 30, max: 30}
    },
    pools: []
  };
}

function actorDocument(id, system=actorSystem()) {
  return {
    id,
    uuid: `Actor.${id}`,
    name: id,
    type: "character",
    system
  };
}

function reactionTrigger({
  id="trigger:reactive-guard",
  actorId="defender",
  action=reactionActionDefinition(),
  priority=10,
  predicate=null
}={}) {
  return createReactionTrigger({
    id,
    event: AUTOMATION_EVENT_TYPES.ATTACK_HIT,
    match: {
      phase: AUTOMATION_EVENT_PHASES.INTERRUPT,
      targetActorId: actorId
    },
    actorId,
    actionId: action.id,
    actionRef: action.id,
    action,
    predicate,
    priority,
    metadata: {
      source: {type: "feature", slug: id}
    }
  });
}

function reactionResources(current=1) {
  return [createBuiltinEconomyResource("economy.reaction", {current, maximum: 1})];
}

function responseFor(request, value) {
  return {
    resolutionId: request.resolutionId,
    requestId: request.id,
    type: RESOLUTION_REQUEST_TYPES.REACTION_CHOICE,
    value
  };
}

test("ReactionResolver discovers matching Trigger RuleElements as ordered candidates without mutation", () => {
  const event = hitEvent();
  const action = reactionActionDefinition();
  const resources = reactionResources();
  const trigger = reactionTrigger({
    action,
    predicate: {equals: {path: "event.data.outcome", value: "hit"}}
  });
  const rejectedTrigger = reactionTrigger({
    id: "trigger:too-late",
    action: reactionActionDefinition({id: "action:late"}),
    predicate: {equals: {path: "event.data.outcome", value: "miss"}}
  });
  const before = JSON.stringify(resources);
  const result = discoverReactionCandidates({
    event,
    triggers: [rejectedTrigger, trigger],
    resourcesByActor: {defender: resources},
    controllerUserIdsByActor: {defender: ["player-b"]}
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates.map(candidate => candidate.id), [
    "reaction-candidate:trigger:reactive-guard:defender:action:reactive-guard:event:preliminary-hit"
  ]);
  assert.equal(result.candidates[0].actionDefinition.id, action.id);
  assert.equal(result.candidates[0].chooser.kind, "specific");
  assert.equal(result.candidates[0].chooser.userId, "player-b");
  assert.equal(result.candidates[0].selectedPaymentOption.resources[0].resourceId, "economy.reaction");
  assert.equal(result.candidates[0].provenance.source.slug, "trigger:reactive-guard");
  assert.equal(result.rejected.find(entry => entry.triggerId === "trigger:too-late").code, AUTOMATION_CODES.PREDICATE_FAILED);
  assert.equal(JSON.stringify(resources), before);
});

test("ReactionResolver reports spent reaction resources as unavailable through Action Economy", () => {
  const result = discoverReactionCandidates({
    event: hitEvent(),
    triggers: [reactionTrigger()],
    resourcesByActor: {defender: reactionResources(0)}
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected.find(entry => entry.triggerId === "trigger:reactive-guard").code, AUTOMATION_CODES.REACTION_UNAVAILABLE);
});

test("ReactionResolver opens serializable reaction-choice requests and closes zero-candidate windows", () => {
  const waiting = planReactionWindow({
    parentState: parentState(),
    event: hitEvent(),
    timing: REACTION_WINDOW_TIMINGS.AFTER_OUTCOME,
    stageId: "reaction.after-outcome",
    triggers: [reactionTrigger()],
    resourcesByActor: {defender: reactionResources()},
    controllerUserIdsByActor: {defender: ["player-b"]}
  });
  const closed = planReactionWindow({
    parentState: parentState({id: "resolution:quiet"}),
    event: hitEvent(),
    timing: REACTION_WINDOW_TIMINGS.AFTER_OUTCOME,
    triggers: [],
    resourcesByActor: {defender: reactionResources()}
  });

  assert.equal(waiting.waiting, true);
  assert.equal(waiting.state.status, RESOLUTION_STATE_STATUS.AWAITING_CHOICE);
  assert.equal(waiting.state.pendingRequests[0].type, RESOLUTION_REQUEST_TYPES.REACTION_CHOICE);
  assert.equal(waiting.state.pendingRequests[0].chooser.userId, "player-b");
  assert.equal(waiting.state.pendingRequests[0].payload.candidates[0].actionDefinition, undefined);
  assert.equal(waiting.state.metadata.reactionWindows[0].status, REACTION_WINDOW_STATUS.WAITING);
  assert.equal(validateResolutionStateSerializable(waiting.state).ok, true);
  assert.equal(closed.waiting, false);
  assert.equal(closed.code, REACTION_RESOLVER_CODES.NO_CANDIDATES);
  assert.equal(closed.state.metadata.reactionWindows[0].status, REACTION_WINDOW_STATUS.CLOSED);
});

test("ReactionResolver offers multiple reactors in deterministic order and advances after decline", () => {
  const alphaTrigger = reactionTrigger({
    id: "trigger:alpha",
    actorId: "alpha",
    action: reactionActionDefinition({id: "action:alpha"})
  });
  const betaTrigger = reactionTrigger({
    id: "trigger:beta",
    actorId: "beta",
    action: reactionActionDefinition({id: "action:beta"})
  });
  const event = createAutomationEvent({
    id: "event:multi",
    type: AUTOMATION_EVENT_TYPES.ATTACK_HIT,
    phase: AUTOMATION_EVENT_PHASES.INTERRUPT,
    targets: [{actorId: "alpha"}, {actorId: "beta"}]
  });
  const first = planReactionWindow({
    parentState: parentState({id: "resolution:multi"}),
    event,
    triggers: [betaTrigger, alphaTrigger],
    resourcesByActor: {alpha: reactionResources(), beta: reactionResources()},
    controllerUserIdsByActor: {alpha: ["player-a"], beta: ["player-b"]},
    ordering: {initiativeActorIds: ["alpha", "beta"]}
  });
  const declined = resolveReactionChoiceResponse({
    state: first.state,
    response: responseFor(first.request, {decision: REACTION_CHOICE_DECISIONS.DECLINE}),
    event,
    triggers: [betaTrigger, alphaTrigger],
    resourcesByActor: {alpha: reactionResources(), beta: reactionResources()},
    controllerUserIdsByActor: {alpha: ["player-a"], beta: ["player-b"]},
    ordering: {initiativeActorIds: ["alpha", "beta"]}
  });

  assert.deepEqual(first.request.payload.candidates.map(candidate => candidate.reactor.actorId), ["alpha"]);
  assert.equal(declined.waiting, true);
  assert.deepEqual(declined.request.payload.candidates.map(candidate => candidate.reactor.actorId), ["beta"]);
  assert.equal(declined.state.metadata.reactionWindows[0].declinedCandidateIds.length, 1);
});

test("ReactionWindowStage pauses parent resolution and resumes after a decline", () => {
  let finalizationRuns = 0;
  const stages = [
    createReactionWindowStage({
      id: "reaction.after-outcome",
      timing: REACTION_WINDOW_TIMINGS.AFTER_OUTCOME,
      event: hitEvent(),
      discovery: {
        triggers: [reactionTrigger()],
        resourcesByActor: {defender: reactionResources()},
        controllerUserIdsByActor: {defender: ["player-b"]}
      }
    }),
    createResolutionPipelineStage({
      id: "action.finalization",
      run(state) {
        finalizationRuns += 1;
        return completeResolutionStage({state});
      }
    })
  ];
  const waiting = runResolutionPipeline({
    state: parentState({id: "resolution:stage"}),
    stages
  });
  const resumed = resumeResolutionPipeline({
    state: waiting.state,
    stages,
    response: {
      resolutionId: "resolution:stage",
      requestId: waiting.state.pendingRequests[0].id,
      type: RESOLUTION_REQUEST_TYPES.REACTION_CHOICE,
      value: {decision: REACTION_CHOICE_DECISIONS.DECLINE}
    }
  });

  assert.equal(waiting.state.status, RESOLUTION_STATE_STATUS.AWAITING_CHOICE);
  assert.equal(waiting.state.pendingRequests[0].type, RESOLUTION_REQUEST_TYPES.REACTION_CHOICE);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(finalizationRuns, 1);
  assert.equal(resumed.state.metadata.reactionWindows[0].status, REACTION_WINDOW_STATUS.CLOSED);
});

test("ReactionWindowStage advances multiple decline prompts without replaying earlier responses", () => {
  let finalizationRuns = 0;
  const event = createAutomationEvent({
    id: "event:multi-stage",
    type: AUTOMATION_EVENT_TYPES.ATTACK_HIT,
    phase: AUTOMATION_EVENT_PHASES.INTERRUPT,
    targets: [{actorId: "alpha"}, {actorId: "beta"}]
  });
  const alphaTrigger = reactionTrigger({
    id: "trigger:alpha-stage",
    actorId: "alpha",
    action: reactionActionDefinition({id: "action:alpha-stage"})
  });
  const betaTrigger = reactionTrigger({
    id: "trigger:beta-stage",
    actorId: "beta",
    action: reactionActionDefinition({id: "action:beta-stage"})
  });
  const stages = [
    createReactionWindowStage({
      id: "reaction.after-outcome",
      timing: REACTION_WINDOW_TIMINGS.AFTER_OUTCOME,
      event,
      discovery: {
        triggers: [betaTrigger, alphaTrigger],
        resourcesByActor: {alpha: reactionResources(), beta: reactionResources()},
        controllerUserIdsByActor: {alpha: ["player-a"], beta: ["player-b"]},
        ordering: {initiativeActorIds: ["alpha", "beta"]}
      }
    }),
    createResolutionPipelineStage({
      id: "action.finalization",
      run(state) {
        finalizationRuns += 1;
        return completeResolutionStage({state});
      }
    })
  ];
  const waitingFirst = runResolutionPipeline({
    state: parentState({id: "resolution:stage-multi"}),
    stages
  });
  const firstRequest = waitingFirst.state.pendingRequests[0];
  const waitingSecond = resumeResolutionPipeline({
    state: waitingFirst.state,
    stages,
    response: {
      resolutionId: "resolution:stage-multi",
      requestId: firstRequest.id,
      type: RESOLUTION_REQUEST_TYPES.REACTION_CHOICE,
      value: {decision: REACTION_CHOICE_DECISIONS.DECLINE}
    }
  });
  const secondRequest = waitingSecond.state.pendingRequests[0];
  const completed = resumeResolutionPipeline({
    state: waitingSecond.state,
    stages,
    response: {
      resolutionId: "resolution:stage-multi",
      requestId: secondRequest.id,
      type: RESOLUTION_REQUEST_TYPES.REACTION_CHOICE,
      value: {decision: REACTION_CHOICE_DECISIONS.DECLINE}
    }
  });

  assert.equal(waitingFirst.state.pendingRequests[0].payload.candidates[0].reactor.actorId, "alpha");
  assert.equal(waitingSecond.state.status, RESOLUTION_STATE_STATUS.AWAITING_CHOICE);
  assert.notEqual(secondRequest.id, firstRequest.id);
  assert.equal(secondRequest.payload.candidates[0].reactor.actorId, "beta");
  assert.equal(completed.ok, true);
  assert.equal(completed.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(completed.state.metadata.reactionWindows[0].declinedCandidateIds.length, 2);
  assert.equal(finalizationRuns, 1);
});

test("ReactionResolver creates normal child action states and parent remains paused while child is active", async () => {
  const defenderSystem = actorSystem({reaction: 1});
  const defender = actorDocument("defender", defenderSystem);
  const persistencePort = createTestDocumentPersistenceAdapter({actors: {"Actor.defender": defender}});
  const action = reactionActionDefinition();
  const waiting = planReactionWindow({
    parentState: parentState(),
    event: hitEvent(),
    triggers: [reactionTrigger({action})],
    resourcesByActor: {defender: reactionResources()},
    controllerUserIdsByActor: {defender: ["player-b"]}
  });
  const selected = resolveReactionChoiceResponse({
    state: waiting.state,
    response: responseFor(waiting.request, {
      decision: REACTION_CHOICE_DECISIONS.USE,
      candidateId: waiting.request.payload.candidates[0].id
    }),
    childResolutionId: "resolution:reaction-child",
    createChildState({candidate, baseChildState}) {
      return createActionResolutionState({
        id: baseChildState.id,
        parentId: baseChildState.parentId,
        relationship: baseChildState.relationship,
        sourceEvent: baseChildState.sourceEvent,
        depth: baseChildState.depth,
        maxDepth: baseChildState.maxDepth,
        ancestry: baseChildState.ancestry,
        triggerIdentities: baseChildState.triggerIdentities,
        actorSystem: defenderSystem,
        action: actionItem(candidate.actionDefinition),
        source: {actorId: "defender", actorRef: "Actor.defender"},
        metadata: baseChildState.metadata
      });
    }
  });
  const childCommitted = await executeStagedActionResolution({
    state: selected.childState,
    actor: defender,
    action: actionItem(action),
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"},
    persistencePort
  });

  assert.equal(selected.ok, true);
  assert.equal(selected.state.status, RESOLUTION_STATE_STATUS.PAUSED);
  assert.equal(selected.state.pendingRequests.length, 0);
  assert.equal(selected.childState.parentId, "resolution:parent");
  assert.equal(selected.childState.relationship, "reaction");
  assert.equal(childCommitted.ok, true);
  assert.equal(childCommitted.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(defender.system.resources.reaction.value, 0);
  assert.deepEqual(persistencePort.operations.map(operation => operation.type), ["updateActor"]);
});

test("ReactionResolver resumes parent and stores generic outcome re-evaluation after child completion", () => {
  const action = reactionActionDefinition();
  const waiting = planReactionWindow({
    parentState: parentState(),
    event: hitEvent(),
    triggers: [reactionTrigger({action})],
    resourcesByActor: {defender: reactionResources()}
  });
  const selected = resolveReactionChoiceResponse({
    state: waiting.state,
    response: responseFor(waiting.request, {
      decision: REACTION_CHOICE_DECISIONS.USE,
      candidateId: waiting.request.payload.candidates[0].id
    })
  });
  const child = updateResolutionState(selected.childState, {
    status: RESOLUTION_STATE_STATUS.COMPLETED
  });
  const completed = completeReactionChildResolution({
    parentState: selected.state,
    childState: child,
    reevaluate({parentState: current}) {
      const before = current.results.attackResolution;
      const after = resolveAttackTargets({
        roll: {total: 18, die: 13},
        targets: [{id: "defender", actorId: "defender", defenses: {ac: {value: 21}}}]
      });
      return {
        ok: true,
        type: "attack-outcome",
        before: before.results[0].outcome,
        after: after.results[0].outcome,
        results: {attackResolution: after}
      };
    }
  });
  const highHit = completeReactionChildResolution({
    parentState: selected.state,
    childState: child,
    reevaluate() {
      const after = resolveAttackTargets({
        roll: {total: 26, die: 19},
        targets: [{id: "defender", actorId: "defender", defenses: {ac: {value: 21}}}]
      });
      return {
        ok: true,
        type: "attack-outcome",
        after: after.results[0].outcome,
        results: {attackResolution: after}
      };
    }
  });

  assert.equal(completed.ok, true);
  assert.equal(completed.state.status, RESOLUTION_STATE_STATUS.RUNNING);
  assert.equal(completed.state.results.attackResolution.misses.length, 1);
  assert.equal(completed.reevaluation.before, "hit");
  assert.equal(completed.reevaluation.after, "miss");
  assert.equal(highHit.state.results.attackResolution.hits.length, 1);
});

test("ReactionResolver treats repeated child completion as an idempotent no-op", () => {
  const action = reactionActionDefinition();
  const waiting = planReactionWindow({
    parentState: parentState(),
    event: hitEvent(),
    triggers: [reactionTrigger({action})],
    resourcesByActor: {defender: reactionResources()}
  });
  const selected = resolveReactionChoiceResponse({
    state: waiting.state,
    response: responseFor(waiting.request, {
      decision: REACTION_CHOICE_DECISIONS.USE,
      candidateId: waiting.request.payload.candidates[0].id
    })
  });
  const child = updateResolutionState(selected.childState, {
    status: RESOLUTION_STATE_STATUS.COMPLETED
  });

  const completed = completeReactionChildResolution({
    parentState: selected.state,
    childState: child
  });
  const duplicate = completeReactionChildResolution({
    parentState: completed.state,
    childState: child
  });

  assert.equal(completed.ok, true);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.code, REACTION_RESOLVER_CODES.CHILD_RESOLUTION_ALREADY_COMPLETED);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.state, completed.state);
  assert.equal(duplicate.state.results.reactions.length, 1);
});

test("ReactionResolver supports explicit parent cancellation directives without throwing", () => {
  const action = reactionActionDefinition({id: "action:disrupt", label: "Disrupt"});
  const trigger = createReactionTrigger({
    id: "trigger:disrupt",
    event: AUTOMATION_EVENT_TYPES.ACTION_DECLARED,
    match: {phase: AUTOMATION_EVENT_PHASES.INTERRUPT, tagsAny: ["spell"]},
    actorId: "defender",
    actionId: action.id,
    actionRef: action.id,
    action
  });
  const waiting = planReactionWindow({
    parentState: parentState({id: "resolution:interrupt"}),
    event: declaredEvent(),
    timing: REACTION_WINDOW_TIMINGS.AFTER_ACTION_DECLARED,
    triggers: [trigger],
    resourcesByActor: {defender: reactionResources()}
  });
  const selected = resolveReactionChoiceResponse({
    state: waiting.state,
    response: responseFor(waiting.request, {
      decision: REACTION_CHOICE_DECISIONS.USE,
      candidateId: waiting.request.payload.candidates[0].id
    }),
    childResolutionId: "resolution:interrupt-child"
  });
  const child = updateResolutionState(selected.childState, {
    status: RESOLUTION_STATE_STATUS.COMPLETED,
    results: {
      parentDirective: {
        type: REACTION_PARENT_DIRECTIVES.CANCEL_PARENT,
        code: "CANCELLED_BY_REACTION",
        reason: "Synthetic interrupt succeeded."
      }
    }
  });
  const cancelled = completeReactionChildResolution({
    parentState: selected.state,
    childState: child
  });

  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.code, "CANCELLED_BY_REACTION");
  assert.equal(cancelled.state.status, RESOLUTION_STATE_STATUS.CANCELLED);
  assert.equal(cancelled.state.metadata.activeChildResolution, undefined);
  assert.equal(cancelled.state.warnings.at(-1).reason, "Synthetic interrupt succeeded.");
});

test("ReactionResolver clears active child state when failed child policy cancels the parent", () => {
  const action = reactionActionDefinition({id: "action:failing-reaction", label: "Failing Reaction"});
  const waiting = planReactionWindow({
    parentState: parentState({id: "resolution:failed-child-parent"}),
    event: hitEvent(),
    triggers: [reactionTrigger({action})],
    resourcesByActor: {defender: reactionResources()}
  });
  const selected = resolveReactionChoiceResponse({
    state: waiting.state,
    response: responseFor(waiting.request, {
      decision: REACTION_CHOICE_DECISIONS.USE,
      candidateId: waiting.request.payload.candidates[0].id
    }),
    childResolutionId: "resolution:failed-child"
  });
  const child = updateResolutionState(selected.childState, {
    status: RESOLUTION_STATE_STATUS.FAILED,
    errors: [{code: "TEST_CHILD_FAILED", reason: "Synthetic child failure."}]
  });

  const cancelled = completeReactionChildResolution({
    parentState: selected.state,
    childState: child,
    childResult: {ok: false, resolutionId: child.id, status: child.status, reason: "Synthetic child failure."},
    failurePolicy: "cancel-parent"
  });
  const duplicate = completeReactionChildResolution({
    parentState: cancelled.state,
    childState: child,
    childResult: {ok: false, resolutionId: child.id, status: child.status},
    failurePolicy: "cancel-parent"
  });

  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.code, REACTION_RESOLVER_CODES.CHILD_RESOLUTION_FAILED);
  assert.equal(cancelled.state.status, RESOLUTION_STATE_STATUS.CANCELLED);
  assert.equal(cancelled.state.metadata.activeChildResolution, undefined);
  assert.equal(cancelled.window.status, REACTION_WINDOW_STATUS.CANCELLED);
  assert.equal(duplicate.code, REACTION_RESOLVER_CODES.CHILD_RESOLUTION_ALREADY_COMPLETED);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.state, cancelled.state);
});

test("ReactionResolver uses ResolutionState ancestry for loop protection", () => {
  const event = hitEvent();
  const action = reactionActionDefinition();
  const parent = parentState({
    triggerIdentities: [`trigger:reactive-guard:${event.id}:defender:${action.id}`]
  });
  const waiting = planReactionWindow({
    parentState: parent,
    event,
    triggers: [reactionTrigger({action})],
    resourcesByActor: {defender: reactionResources()}
  });
  const selected = resolveReactionChoiceResponse({
    state: waiting.state,
    response: responseFor(waiting.request, {
      decision: REACTION_CHOICE_DECISIONS.USE,
      candidateId: waiting.request.payload.candidates[0].id
    })
  });

  assert.equal(selected.ok, false);
  assert.equal(selected.code, RESOLUTION_PIPELINE_CODES.REPEATED_TRIGGER);
});

test("multiplayer coordinator routes reaction-choice requests to the expected chooser and rejects wrong users", async () => {
  const event = hitEvent();
  const trigger = reactionTrigger();
  const hub = createTestResolutionTransportHub({
    users: [
      {id: "gm-a", active: true, isGM: true, isActiveGM: true},
      {id: "player-a", active: true, isGM: false},
      {id: "player-b", active: true, isGM: false}
    ]
  });
  const gmTransport = hub.createEndpoint({userId: "gm-a"});
  const playerATransport = hub.createEndpoint({userId: "player-a"});
  hub.createEndpoint({userId: "player-b"});
  const gm = createMultiplayerActionCoordinator({
    userId: "gm-a",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-a",
    transport: gmTransport,
    actionIntentResolver: () => ({
      ok: true,
      options: {},
      requestContext: {}
    }),
    planResolution: async () => planReactionWindow({
      parentState: parentState({id: "resolution:multiplayer-reaction"}),
      event,
      triggers: [trigger],
      resourcesByActor: {defender: reactionResources()},
      controllerUserIdsByActor: {defender: ["player-b"]}
    }),
    resumeResolution: async ({state, response}) => {
      const resolved = resolveReactionChoiceResponse({
        state,
        response,
        event,
        triggers: [trigger],
        resourcesByActor: {defender: reactionResources()},
        controllerUserIdsByActor: {defender: ["player-b"]}
      });
      const finalState = resolved.waiting
        ? resolved.state
        : updateResolutionState(resolved.state, {status: RESOLUTION_STATE_STATUS.COMPLETED});
      return {
        ...resolved,
        state: finalState,
        completed: finalState.status === RESOLUTION_STATE_STATUS.COMPLETED
      };
    }
  });
  const playerA = createMultiplayerActionCoordinator({
    userId: "player-a",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-a",
    transport: playerATransport
  });
  gm.register();
  playerA.register();

  await playerA.declareActionIntent({
    intentId: "intent:reaction-route",
    resolutionId: "resolution:multiplayer-reaction",
    actorRef: "Actor.attacker",
    actionRef: "Item.parent-action"
  });
  const request = gm.getRecord("resolution:multiplayer-reaction").state.pendingRequests[0];
  await playerATransport.send(createResolutionSocketEnvelope({
    messageType: MULTIPLAYER_MESSAGE_TYPES.REQUEST_RESPONSE,
    senderUserId: "player-a",
    recipientUserId: "gm-a",
    resolutionId: "resolution:multiplayer-reaction",
    requestId: request.id,
    payload: {
      response: responseFor(request, {decision: REACTION_CHOICE_DECISIONS.DECLINE})
    }
  }));

  assert.equal(hub.messages.some(message => {
    return message.messageType === MULTIPLAYER_MESSAGE_TYPES.PENDING_REQUEST
      && message.recipientUserId === "player-b"
      && message.payload.request.type === RESOLUTION_REQUEST_TYPES.REACTION_CHOICE;
  }), true);
  assert.equal(gm.errors.some(entry => entry.error?.code === MULTIPLAYER_AUTHORITY_CODES.WRONG_USER), true);
  assert.equal(gm.getRecord("resolution:multiplayer-reaction").state.status, RESOLUTION_STATE_STATUS.AWAITING_CHOICE);
});
