import {test} from "node:test";
import assert from "node:assert/strict";
import {
  ECONOMY_CAPABILITIES,
  createBuiltinEconomyResource
} from "../module/helpers/action-economy.mjs";
import {
  AUTOMATION_EVENT_PHASES,
  AUTOMATION_EVENT_TYPES,
  createReactionTrigger
} from "../module/helpers/automation-events.mjs";
import {
  MULTIPLAYER_AUTHORITY_CODES,
  MULTIPLAYER_MESSAGE_TYPES
} from "../module/helpers/multiplayer-authority.mjs";
import {
  RESOLUTION_REQUEST_TYPES,
  RESOLUTION_STATE_STATUS,
  updateResolutionState,
  validateResolutionStateSerializable
} from "../module/helpers/resolution-state.mjs";
import {ATTACK_OUTCOMES} from "../module/resolvers/attack-resolver.mjs";
import {
  createPhysicalDiceProvider,
  createTestRollProvider,
  executeRollRequest
} from "../module/resolvers/roll-provider-resolver.mjs";
import {createTestPromptAdapter} from "../module/adapters/test-prompt-adapter.mjs";
import {createTestDocumentPersistenceAdapter} from "../module/adapters/test-persistence-adapter.mjs";
import {createTestResolutionTransportHub} from "../module/adapters/test-resolution-transport.mjs";
import {createMultiplayerActionCoordinator} from "../module/resolvers/multiplayer-action-coordinator.mjs";
import {
  ACTION_PIPELINE_STAGE_IDS,
  completeStagedReactionChildResolution,
  createActionResolutionState,
  executeStagedActionResolution,
  planStagedActionResolution,
  resumeStagedActionResolution
} from "../module/resolvers/action-pipeline-resolver.mjs";
import {
  REACTION_CHOICE_DECISIONS,
  REACTION_PARENT_DIRECTIVES,
  REACTION_WINDOW_STATUS
} from "../module/resolvers/reaction-resolver.mjs";

const GUARD_DEFENSE_BONUS = 5;

function actorSystem({
  action=1,
  reaction=1,
  hp=null,
  maxHp=20,
  ac=16,
  pools=[]
}={}) {
  return {
    attributes: {
      ac: {value: ac}
    },
    resources: {
      action: {value: action, max: 1},
      bonus: {value: 1, max: 1},
      reaction: {value: reaction, max: 1},
      movement: {value: 30, max: 30},
      ...(hp == null ? {} : {health: {value: hp, max: maxHp}})
    },
    pools
  };
}

function actorDocument(id, {system=actorSystem(), effects=[]}={}) {
  const actor = {
    id,
    uuid: `Actor.${id}`,
    name: id,
    type: "character",
    system,
    effects
  };
  actor.getStatistic = domains => {
    const list = [domains].flat();
    const domain = list[0];
    if ( !list.includes("defense.ac") && !list.includes("ac") ) return {totalModifier: 0, trace: {domain}};
    // The effects' own Modifier rules on defense.ac, as a real creature's statistic reads them.
    const effectBonus = (actor.effects ?? []).flatMap(effect => effect.system?.ruleElements ?? [])
      .filter(rule => (rule.type === "Modifier") && (rule.data?.domains ?? []).some(entry => list.includes(entry)))
      .reduce((sum, rule) => sum + (Number(rule.data.value) || 0), 0);
    return {
      totalModifier: effectBonus,
      trace: {
        domain,
        source: "test-effect-statistic",
        effectBonus
      }
    };
  };
  return actor;
}

function actionItem(definition) {
  return {
    id: definition.id,
    uuid: `Item.${definition.id}`,
    type: "action",
    name: definition.label,
    system: {definition}
  };
}

function actionCost() {
  return {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]};
}

function reactionCost() {
  return {allOf: [{capability: ECONOMY_CAPABILITIES.REACTION, amount: 1}]};
}

function parentStrikeDefinition({damage=6}={}) {
  return {
    schemaVersion: 1,
    id: "action:test-parent-strike",
    label: "Test Parent Strike",
    tags: ["weapon-attack"],
    costs: actionCost(),
    targeting: {type: "single", required: true, count: 1},
    attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
    damage: [{
      id: "weapon",
      expression: {type: "constant", value: damage},
      damageType: "slashing",
      provenance: "weapon-base"
    }]
  };
}

function reactiveGuardDefinition() {
  return {
    schemaVersion: 1,
    id: "action:test-reactive-guard",
    label: "Reactive Guard",
    costs: reactionCost(),
    targeting: {type: "self", required: true},
    // 2024 Shield: +5 AC until the start of your next turn, including against the triggering attack.
    effects: [{
      id: "guard-defense-bonus",
      type: "effect",
      name: "Shield",
      slug: "shielded",
      ruleElements: [{schemaVersion: 1, id: "shield-ac", type: "Modifier", data: {domains: ["defense.ac"], value: GUARD_DEFENSE_BONUS}}],
      duration: {value: 1, units: "turns", expiry: "turnStart"}
    }]
  };
}

function declaredDamageDefinition({damage=5}={}) {
  return {
    schemaVersion: 1,
    id: "action:test-declared-damage",
    label: "Test Declared Damage",
    tags: ["spell"],
    costs: actionCost(),
    targeting: {type: "single", required: true, count: 1},
    damage: [{
      id: "burst",
      expression: {type: "constant", value: damage},
      damageType: "force",
      provenance: "test-action"
    }]
  };
}

function disruptActionDefinition() {
  return {
    schemaVersion: 1,
    id: "action:test-disrupt-action",
    label: "Disrupt Action",
    costs: reactionCost(),
    targeting: {type: "single", required: true, count: 1},
    attack: {
      type: "reaction-check",
      statistic: "reaction",
      defenseKey: "ac"
    }
  };
}

function targetRef(actorId, extra={}) {
  return {
    id: actorId,
    actorId,
    actorRef: `Actor.${actorId}`,
    uuid: `Actor.${actorId}`,
    disposition: "enemy",
    ...extra
  };
}

function targetActorsFor(...actors) {
  return Object.fromEntries(actors.flatMap(actor => [
    [actor.id, actor],
    [`actor:${actor.id}`, actor],
    [actor.uuid, actor]
  ]));
}

function reactionResourcesFor(actor) {
  return [
    createBuiltinEconomyResource("economy.reaction", {
      current: actor.system.resources.reaction.value,
      maximum: actor.system.resources.reaction.max
    })
  ];
}

function guardTrigger(action=reactiveGuardDefinition(), {actorId="defender", userId="player-b"}={}) {
  return createReactionTrigger({
    id: "trigger:test-reactive-guard",
    event: AUTOMATION_EVENT_TYPES.ATTACK_HIT,
    match: {
      phase: AUTOMATION_EVENT_PHASES.INTERRUPT,
      targetActorId: actorId
    },
    actorId,
    actionId: action.id,
    actionRef: action.id,
    action,
    chooser: {kind: "specific", userId},
    priority: 10,
    metadata: {
      source: {type: "test-feature", slug: "reactive-guard"}
    }
  });
}

function disruptTrigger(action=disruptActionDefinition(), {actorId="defender", userId="player-b"}={}) {
  return createReactionTrigger({
    id: "trigger:test-disrupt-action",
    event: AUTOMATION_EVENT_TYPES.ACTION_DECLARED,
    match: {
      phase: AUTOMATION_EVENT_PHASES.INTERRUPT,
      tagsAny: ["spell"]
    },
    actorId,
    actionId: action.id,
    actionRef: action.id,
    action,
    chooser: {kind: "specific", userId},
    priority: 10,
    metadata: {
      source: {type: "test-feature", slug: "disrupt-action"}
    }
  });
}

function guardServices({defender, targetActors, action=reactiveGuardDefinition(), userId="player-b"}) {
  return {
    targetActors,
    reactions: {
      triggers: [guardTrigger(action, {actorId: defender.id, userId})],
      resourcesByActor: {[defender.id]: reactionResourcesFor(defender)},
      controllerUserIdsByActor: {[defender.id]: [userId]},
      actorDocumentsByActor: {[defender.id]: defender},
      actorSystemsByActor: {[defender.id]: defender.system}
    }
  };
}

function disruptServices({
  defender,
  attacker,
  targetActors,
  action=disruptActionDefinition(),
  userId="player-b"
}) {
  return {
    targetActors,
    reactions: {
      triggers: [disruptTrigger(action, {actorId: defender.id, userId})],
      resourcesByActor: {[defender.id]: reactionResourcesFor(defender)},
      controllerUserIdsByActor: {[defender.id]: [userId]},
      actorDocumentsByActor: {[defender.id]: defender},
      actorSystemsByActor: {[defender.id]: defender.system},
      createChildState({parentState, candidate, baseChildState}) {
        return createActionResolutionState({
          id: baseChildState.id,
          parentId: baseChildState.parentId,
          relationship: baseChildState.relationship,
          sourceEvent: baseChildState.sourceEvent,
          depth: baseChildState.depth,
          maxDepth: baseChildState.maxDepth,
          ancestry: baseChildState.ancestry,
          triggerIdentities: baseChildState.triggerIdentities,
          actorSystem: defender.system,
          action: actionItem(candidate.actionDefinition),
          source: candidate.reactor,
          targets: [targetRef(attacker.id, {defenses: {ac: {value: 15}}})],
          attack: {
            targetContexts: [{
              target: targetRef(attacker.id),
              selected: true,
              defenses: {ac: {value: 15}}
            }]
          },
          selectedPaymentOptionId: candidate.selectedPaymentOption?.id ?? null,
          metadata: {
            ...baseChildState.metadata,
            parentResolutionId: parentState.id
          }
        });
      }
    }
  };
}

function attackFixture({attackTotal=18, natural=13, defenderAc=16, defenderHp=20}={}) {
  const attacker = actorDocument("attacker", {system: actorSystem({action: 1, reaction: 1, ac: 14})});
  const defender = actorDocument("defender", {
    system: actorSystem({action: 1, reaction: 1, hp: defenderHp, maxHp: defenderHp, ac: defenderAc})
  });
  const targetActors = targetActorsFor(attacker, defender);
  const target = targetRef(defender.id, {defenses: {ac: {value: defenderAc}}});
  const action = parentStrikeDefinition();
  return {
    attacker,
    defender,
    target,
    targetActors,
    action,
    actionItem: actionItem(action),
    attack: {
      roll: {total: attackTotal, die: natural},
      targetContexts: [{
        target,
        selected: true,
        defenses: {ac: {value: defenderAc}}
      }],
      defenseKey: "ac"
    },
    persistencePort: createTestDocumentPersistenceAdapter()
  };
}

function responseFor(request, value) {
  return {
    resolutionId: request.resolutionId,
    requestId: request.id,
    type: request.type,
    value
  };
}

function resultDiagnostic(result) {
  return JSON.stringify({
    code: result?.code,
    reason: result?.reason,
    status: result?.state?.status,
    errors: result?.state?.errors,
    trace: result?.state?.trace?.slice(-3),
    attackResolution: result?.state?.results?.attackResolution
  }, null, 2);
}

function acceptResponse(request) {
  return responseFor(request, {
    decision: REACTION_CHOICE_DECISIONS.USE,
    candidateId: request.payload.candidates[0].id
  });
}

function declineResponse(request) {
  return responseFor(request, {decision: REACTION_CHOICE_DECISIONS.DECLINE});
}

async function provideRoll(state, rollInput, services={}) {
  const request = state.pendingRequests[0];
  assert.equal(request.type, RESOLUTION_REQUEST_TYPES.ROLL);
  const provided = await executeRollRequest({
    request: request.payload.rollRequest,
    providers: [createTestRollProvider({result: rollInput})]
  });
  assert.equal(provided.ok, true, provided.reason ?? provided.code);
  return resumeStagedActionResolution({
    state,
    response: {
      resolutionId: state.id,
      requestId: request.id,
      type: RESOLUTION_REQUEST_TYPES.ROLL,
      value: provided.result
    },
    services
  });
}

async function executeGuardChild({parentState, defender, targetActors, action, persistencePort}) {
  const childState = parentState.metadata.activeChildResolution;
  assert.equal(validateResolutionStateSerializable(childState).ok, true);
  const child = await executeStagedActionResolution({
    state: childState,
    actor: defender,
    action: actionItem(action),
    targetActors,
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"},
    persistencePort
  });
  assert.equal(child.ok, true);
  assert.equal(child.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  return child;
}

async function executeParentAfterReaction({fixture, state, services}) {
  return executeStagedActionResolution({
    state,
    actor: fixture.attacker,
    action: fixture.actionItem,
    targetActors: fixture.targetActors,
    services,
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"},
    persistencePort: fixture.persistencePort
  });
}

test("Reactive Guard child action commits effect and reaction payment before parent re-evaluates hit to miss", async () => {
  const fixture = attackFixture({attackTotal: 18, natural: 13});
  const guardAction = reactiveGuardDefinition();
  const services = guardServices({
    defender: fixture.defender,
    targetActors: fixture.targetActors,
    action: guardAction
  });
  const waiting = planStagedActionResolution({
    id: "resolution:guard-hit-to-miss",
    actor: fixture.attacker,
    action: fixture.actionItem,
    source: {actorId: fixture.attacker.id, actorRef: fixture.attacker.uuid},
    targets: [fixture.target],
    attack: fixture.attack,
    durability: true,
    targetActors: fixture.targetActors,
    services
  });

  assert.equal(waiting.ok, true, resultDiagnostic(waiting));
  assert.equal(waiting.state.status, RESOLUTION_STATE_STATUS.AWAITING_CHOICE);
  assert.equal(waiting.state.currentStageId, ACTION_PIPELINE_STAGE_IDS.REACTION_AFTER_ATTACK_OUTCOME);
  assert.equal(waiting.state.pendingRequests[0].type, RESOLUTION_REQUEST_TYPES.REACTION_CHOICE);
  assert.equal(fixture.defender.system.resources.health.value, 20);
  assert.equal(fixture.defender.effects.length, 0);

  const selected = resumeStagedActionResolution({
    state: waiting.state,
    response: acceptResponse(waiting.state.pendingRequests[0]),
    services
  });
  assert.equal(selected.state.status, RESOLUTION_STATE_STATUS.PAUSED, resultDiagnostic(selected));
  assert.equal(selected.state.metadata.reactionWindows.some(window => window.status === REACTION_WINDOW_STATUS.RESOLVING), true);

  const child = await executeGuardChild({
    parentState: selected.state,
    defender: fixture.defender,
    targetActors: fixture.targetActors,
    action: guardAction,
    persistencePort: fixture.persistencePort
  });
  assert.equal(fixture.defender.system.resources.reaction.value, 0);
  assert.equal(fixture.defender.effects.length, 1);

  const resumedParent = completeStagedReactionChildResolution({
    parentState: selected.state,
    childState: child.state,
    services
  });
  assert.equal(resumedParent.ok, true);
  assert.equal(resumedParent.state.status, RESOLUTION_STATE_STATUS.RUNNING);
  assert.equal(resumedParent.state.metadata.activeChildResolution, undefined);
  assert.equal(resumedParent.state.results.attackResolution.results[0].outcome, ATTACK_OUTCOMES.MISS);

  const committed = await executeParentAfterReaction({
    fixture,
    state: resumedParent.state,
    services
  });
  assert.equal(committed.ok, true);
  assert.equal(committed.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(fixture.defender.system.resources.health.value, 20);
  assert.equal(fixture.attacker.system.resources.action.value, 0);
  assert.equal(committed.state.results.damageResolution.results.length, 0);
  assert.equal(committed.state.results.damageResolution.skipped[0].reason, "attack did not hit");
  assert.equal(committed.state.results.reactions[0].reevaluation.after.hitCount, 0);
  assert.equal(fixture.persistencePort.operations.some(operation => operation.type === "createEmbeddedDocuments"), true);
  assert.equal(fixture.persistencePort.operations.some(operation => {
    return operation.type === "updateActor"
      && operation.actorRef === fixture.defender.uuid
      && operation.updates["system.resources.reaction.value"] === 0;
  }), true);
});

test("Shield raises AC by 5 against the triggering attack, but a natural 20 still hits as a critical", async () => {
  const fixture = attackFixture({attackTotal: 18, natural: 20});
  const guardAction = reactiveGuardDefinition();
  const services = guardServices({defender: fixture.defender, targetActors: fixture.targetActors, action: guardAction});
  const waiting = planStagedActionResolution({id: "resolution:guard-natural-20", actor: fixture.attacker, action: fixture.actionItem,
    source: {actorId: fixture.attacker.id, actorRef: fixture.attacker.uuid}, targets: [fixture.target], attack: fixture.attack,
    durability: true, targetActors: fixture.targetActors, services});
  const selected = resumeStagedActionResolution({state: waiting.state, response: acceptResponse(waiting.state.pendingRequests[0]), services});
  const child = await executeGuardChild({parentState: selected.state, defender: fixture.defender, targetActors: fixture.targetActors,
    action: guardAction, persistencePort: fixture.persistencePort});
  assert.deepEqual(fixture.defender.effects.map(effect => effect.name), ["Shield"], "the reaction's custom effect is on the defender");
  const resumed = completeStagedReactionChildResolution({parentState: selected.state, childState: child.state, services});
  assert.equal(resumed.state.results.attackResolution.results[0].outcome, ATTACK_OUTCOMES.CRITICAL_HIT,
    "18 is under AC 21, but a natural 20 always hits");
});

test("Reactive Guard decline leaves the hit intact while a still-hit guard applies damage after re-evaluation", async () => {
  const declined = attackFixture({attackTotal: 18, natural: 13});
  const guardAction = reactiveGuardDefinition();
  const declineServices = guardServices({
    defender: declined.defender,
    targetActors: declined.targetActors,
    action: guardAction
  });
  const waitingDecline = planStagedActionResolution({
    id: "resolution:guard-declined",
    actor: declined.attacker,
    action: declined.actionItem,
    source: {actorId: declined.attacker.id, actorRef: declined.attacker.uuid},
    targets: [declined.target],
    attack: declined.attack,
    durability: true,
    targetActors: declined.targetActors,
    services: declineServices
  });
  assert.equal(waitingDecline.ok, true, resultDiagnostic(waitingDecline));
  const readyAfterDecline = resumeStagedActionResolution({
    state: waitingDecline.state,
    response: declineResponse(waitingDecline.state.pendingRequests[0]),
    services: declineServices
  });
  const committedDecline = await executeParentAfterReaction({
    fixture: declined,
    state: readyAfterDecline.state,
    services: declineServices
  });

  assert.equal(readyAfterDecline.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, resultDiagnostic(readyAfterDecline));
  assert.equal(committedDecline.ok, true);
  assert.equal(declined.defender.system.resources.health.value, 14);
  assert.equal(declined.defender.system.resources.reaction.value, 1);
  assert.equal(declined.defender.effects.length, 0);
  assert.equal(committedDecline.state.results.attackResolution.results[0].outcome, ATTACK_OUTCOMES.HIT);

  const stillHit = attackFixture({attackTotal: 26, natural: 19});
  const hitServices = guardServices({
    defender: stillHit.defender,
    targetActors: stillHit.targetActors,
    action: guardAction
  });
  const waitingHit = planStagedActionResolution({
    id: "resolution:guard-still-hit",
    actor: stillHit.attacker,
    action: stillHit.actionItem,
    source: {actorId: stillHit.attacker.id, actorRef: stillHit.attacker.uuid},
    targets: [stillHit.target],
    attack: stillHit.attack,
    durability: true,
    targetActors: stillHit.targetActors,
    services: hitServices
  });
  assert.equal(waitingHit.ok, true, resultDiagnostic(waitingHit));
  const selected = resumeStagedActionResolution({
    state: waitingHit.state,
    response: acceptResponse(waitingHit.state.pendingRequests[0]),
    services: hitServices
  });
  const child = await executeGuardChild({
    parentState: selected.state,
    defender: stillHit.defender,
    targetActors: stillHit.targetActors,
    action: guardAction,
    persistencePort: stillHit.persistencePort
  });
  const resumedParent = completeStagedReactionChildResolution({
    parentState: selected.state,
    childState: child.state,
    services: hitServices
  });
  const committedHit = await executeParentAfterReaction({
    fixture: stillHit,
    state: resumedParent.state,
    services: hitServices
  });

  assert.equal(resumedParent.state.results.attackResolution.results[0].outcome, ATTACK_OUTCOMES.HIT);
  assert.equal(resumedParent.state.results.attackResolution.results[0].defense.value, 21);
  assert.equal(committedHit.ok, true);
  assert.equal(stillHit.defender.system.resources.health.value, 14);
  assert.equal(stillHit.defender.system.resources.reaction.value, 0);
  assert.equal(stillHit.defender.effects.length, 1);
});

test("Disrupt Action can cancel at action declaration or fail and let the parent continue", async () => {
  const success = await runDisruptScenario({
    id: "resolution:disrupt-success",
    roll: {natural: 16, total: 18}
  });
  assert.equal(success.completed.ok, false);
  assert.equal(success.completed.state.status, RESOLUTION_STATE_STATUS.CANCELLED);
  assert.equal(success.defender.system.resources.health.value, 20);
  assert.equal(success.attacker.system.resources.action.value, 1);
  assert.equal(success.defender.system.resources.reaction.value, 0);

  const failure = await runDisruptScenario({
    id: "resolution:disrupt-failure",
    roll: {natural: 4, total: 9}
  });
  assert.equal(failure.completed.ok, true);
  assert.equal(failure.completed.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(failure.defender.system.resources.health.value, 15);
  assert.equal(failure.attacker.system.resources.action.value, 0);
  assert.equal(failure.defender.system.resources.reaction.value, 0);
  assert.equal(failure.completed.state.results.reactions[0].directive.type, REACTION_PARENT_DIRECTIVES.CONTINUE);
});

test("multiplayer authority routes reaction choice to defender controller and commits child plus parent only on GM adapter", async () => {
  const fixture = attackFixture({attackTotal: 18, natural: 13});
  const guardAction = reactiveGuardDefinition();
  const services = guardServices({
    defender: fixture.defender,
    targetActors: fixture.targetActors,
    action: guardAction,
    userId: "player-b"
  });
  const hub = createTestResolutionTransportHub({
    users: [
      {id: "gm-a", active: true, isGM: true, isActiveGM: true},
      {id: "player-a", active: true, isGM: false},
      {id: "player-b", active: true, isGM: false}
    ]
  });
  const gmTransport = hub.createEndpoint({userId: "gm-a"});
  const playerATransport = hub.createEndpoint({userId: "player-a"});
  const playerBTransport = hub.createEndpoint({userId: "player-b"});
  const gm = createMultiplayerActionCoordinator({
    userId: "gm-a",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-a",
    transport: gmTransport,
    actionIntentResolver: () => ({
      ok: true,
      options: {
        actor: fixture.attacker,
        action: fixture.actionItem,
        source: {actorId: fixture.attacker.id, actorRef: fixture.attacker.uuid},
        targets: [fixture.target],
        attack: fixture.attack,
        durability: true,
        targetActors: fixture.targetActors,
        persistencePort: fixture.persistencePort
      },
      services,
      requestContext: {
        sourceControllerUserIds: ["player-a"],
        targetControllerUserIds: ["player-b"]
      }
    })
  });
  const playerA = createMultiplayerActionCoordinator({
    userId: "player-a",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-a",
    transport: playerATransport
  });
  const playerB = createMultiplayerActionCoordinator({
    userId: "player-b",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-a",
    transport: playerBTransport,
    promptPorts: [createTestPromptAdapter({
      queue: [(request) => ({
        decision: REACTION_CHOICE_DECISIONS.USE,
        candidateId: request.payload.candidates[0].id
      })]
    })]
  });
  gm.register();
  playerA.register();
  playerB.register();

  await playerA.declareActionIntent({
    intentId: "intent:multiplayer-reaction",
    resolutionId: "resolution:multiplayer-reaction-proof",
    actorRef: fixture.attacker.uuid,
    actionRef: fixture.actionItem.uuid,
    targetRefs: [fixture.target.actorRef]
  });

  const record = gm.getRecord("resolution:multiplayer-reaction-proof");
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, resultDiagnostic({state: record.state}));
  assert.equal(fixture.defender.system.resources.health.value, 20);
  assert.equal(fixture.defender.system.resources.reaction.value, 0);
  assert.equal(fixture.attacker.system.resources.action.value, 0);
  assert.equal(record.state.results.attackResolution.results[0].outcome, ATTACK_OUTCOMES.MISS);
  assert.equal(hub.messages.some(message => {
    return message.messageType === MULTIPLAYER_MESSAGE_TYPES.PENDING_REQUEST
      && message.recipientUserId === "player-b"
      && message.payload.request.type === RESOLUTION_REQUEST_TYPES.REACTION_CHOICE;
  }), true);
  assert.equal(hub.messages.some(message => {
    return message.messageType === MULTIPLAYER_MESSAGE_TYPES.RESOLUTION_RESULT
      && message.senderUserId === "gm-a";
  }), true);
  const reactionChoiceResponse = hub.messages.find(message => {
    return message.messageType === MULTIPLAYER_MESSAGE_TYPES.REQUEST_RESPONSE
      && message.senderUserId === "player-b"
      && message.payload?.response?.type === RESOLUTION_REQUEST_TYPES.REACTION_CHOICE;
  });
  const operationCountBeforeDuplicate = fixture.persistencePort.operations.length;
  const duplicate = await gm.handleEnvelope({
    ...reactionChoiceResponse,
    messageId: "message:duplicate-reaction-choice-response"
  });

  assert.equal(duplicate.code, MULTIPLAYER_AUTHORITY_CODES.DUPLICATE_REQUEST_RESPONSE);
  assert.equal(duplicate.duplicate, true);
  assert.equal(fixture.persistencePort.operations.length, operationCountBeforeDuplicate);
  assert.equal(fixture.defender.effects.length, 1);
  assert.equal(fixture.defender.system.resources.health.value, 20);
  assert.equal(fixture.defender.system.resources.reaction.value, 0);
  assert.equal(fixture.attacker.system.resources.action.value, 0);
  assert.equal(fixture.persistencePort.operations.every(operation => {
    return operation.type === "createEmbeddedDocuments"
      || operation.type === "updateDocument"
      || operation.type === "updateActor";
  }), true);
});

test("multiplayer authority advances a reaction child roll through the existing request flow", async () => {
  const attacker = actorDocument("attacker", {system: actorSystem({action: 1, reaction: 1, ac: 14})});
  const defender = actorDocument("defender", {
    system: actorSystem({action: 1, reaction: 1, hp: 20, maxHp: 20, ac: 16})
  });
  const targetActors = targetActorsFor(attacker, defender);
  const parentAction = declaredDamageDefinition();
  const parentActionDoc = actionItem(parentAction);
  const disrupt = disruptActionDefinition();
  const target = targetRef(defender.id);
  const services = disruptServices({
    defender,
    attacker,
    targetActors,
    action: disrupt,
    userId: "player-b"
  });
  const persistencePort = createTestDocumentPersistenceAdapter();
  const hub = createTestResolutionTransportHub({
    users: [
      {id: "gm-a", active: true, isGM: true, isActiveGM: true},
      {id: "player-a", active: true, isGM: false},
      {id: "player-b", active: true, isGM: false}
    ]
  });
  const gm = createMultiplayerActionCoordinator({
    userId: "gm-a",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}),
    actionIntentResolver: () => ({
      ok: true,
      options: {
        actor: attacker,
        action: parentActionDoc,
        source: {actorId: attacker.id, actorRef: attacker.uuid},
        targets: [target],
        durability: true,
        targetActors,
        persistencePort
      },
      services,
      requestContext: {
        sourceControllerUserIds: ["player-a"],
        targetControllerUserIds: ["player-b"]
      }
    })
  });
  const playerA = createMultiplayerActionCoordinator({
    userId: "player-a",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "player-a"})
  });
  const playerB = createMultiplayerActionCoordinator({
    userId: "player-b",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "player-b"}),
    promptPorts: [createTestPromptAdapter({
      queue: [(request) => ({
        decision: REACTION_CHOICE_DECISIONS.USE,
        candidateId: request.payload.candidates[0].id
      })]
    })],
    rollProviders: [createPhysicalDiceProvider()],
    rollContext: {
      physicalRolls: [{natural: 16, total: 16}]
    }
  });
  gm.register();
  playerA.register();
  playerB.register();

  await playerA.declareActionIntent({
    intentId: "intent:multiplayer-reaction-child-roll",
    resolutionId: "resolution:multiplayer-reaction-child-roll",
    actorRef: attacker.uuid,
    actionRef: parentActionDoc.uuid,
    targetRefs: [target.actorRef]
  });

  const record = gm.getRecord("resolution:multiplayer-reaction-child-roll");
  const childRollMessage = hub.messages.find(message => {
    return message.messageType === MULTIPLAYER_MESSAGE_TYPES.PENDING_REQUEST
      && message.payload?.request?.type === RESOLUTION_REQUEST_TYPES.ROLL;
  });
  const childRollResponse = hub.messages.find(message => {
    return message.messageType === MULTIPLAYER_MESSAGE_TYPES.REQUEST_RESPONSE
      && message.resolutionId === childRollMessage?.resolutionId;
  });

  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, resultDiagnostic({state: record.state}));
  assert.equal(childRollMessage.recipientUserId, "player-b");
  assert.notEqual(childRollMessage.resolutionId, "resolution:multiplayer-reaction-child-roll");
  assert.equal(childRollMessage.metadata.parentResolutionId, "resolution:multiplayer-reaction-child-roll");
  assert.equal(childRollMessage.payload.request.payload.rollRequest.source.actorId, defender.id);
  assert.equal(childRollResponse.senderUserId, "player-b");
  assert.equal(childRollResponse.payload.response.metadata.rollProvider.type, "physical");
  assert.equal(record.state.results.reactions[0].childResolutionId, childRollMessage.resolutionId);
  assert.equal(record.state.results.reactions[0].childStatus, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(defender.system.resources.reaction.value, 0);
  assert.equal(attacker.system.resources.action.value, 0);
  assert.equal(defender.system.resources.health.value, 15);
});

async function runDisruptScenario({id, roll}) {
  const attacker = actorDocument("attacker", {system: actorSystem({action: 1, reaction: 1, ac: 14})});
  const defender = actorDocument("defender", {
    system: actorSystem({action: 1, reaction: 1, hp: 20, maxHp: 20, ac: 16})
  });
  const targetActors = targetActorsFor(attacker, defender);
  const action = declaredDamageDefinition();
  const actionDoc = actionItem(action);
  const disrupt = disruptActionDefinition();
  const target = targetRef(defender.id);
  const services = disruptServices({
    defender,
    attacker,
    targetActors,
    action: disrupt
  });
  const persistencePort = createTestDocumentPersistenceAdapter();
  const waiting = planStagedActionResolution({
    id,
    actor: attacker,
    action: actionDoc,
    source: {actorId: attacker.id, actorRef: attacker.uuid},
    targets: [target],
    durability: true,
    targetActors,
    services
  });
  assert.equal(waiting.ok, true, resultDiagnostic(waiting));
  assert.equal(waiting.state.currentStageId, ACTION_PIPELINE_STAGE_IDS.REACTION_AFTER_ACTION_DECLARED);
  assert.equal(waiting.state.pendingRequests[0].type, RESOLUTION_REQUEST_TYPES.REACTION_CHOICE);

  const selected = resumeStagedActionResolution({
    state: waiting.state,
    response: acceptResponse(waiting.state.pendingRequests[0]),
    services
  });
  const childWaiting = await executeStagedActionResolution({
    state: selected.state.metadata.activeChildResolution,
    actor: defender,
    action: actionItem(disrupt),
    targetActors,
    services: {targetActors},
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"},
    persistencePort
  });
  assert.equal(childWaiting.state.status, RESOLUTION_STATE_STATUS.AWAITING_ROLL);
  const childReady = await provideRoll(childWaiting.state, roll, {targetActors});
  const childCommitted = await executeStagedActionResolution({
    state: childReady.state,
    actor: defender,
    action: actionItem(disrupt),
    targetActors,
    services: {targetActors},
    authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"},
    persistencePort
  });
  assert.equal(childCommitted.ok, true);
  const disrupted = childCommitted.state.results.attackResolution.hits.length > 0;
  const childWithDirective = updateResolutionState(childCommitted.state, {
    results: {
      ...childCommitted.state.results,
      parentDirective: disrupted
        ? {
            type: REACTION_PARENT_DIRECTIVES.CANCEL_PARENT,
            code: "PARENT_INTERRUPTED_BY_TEST_REACTION",
            reason: "Synthetic disruption succeeded."
          }
        : {
            type: REACTION_PARENT_DIRECTIVES.CONTINUE,
            reason: "Synthetic disruption failed."
          }
    }
  });
  const resumedParent = completeStagedReactionChildResolution({
    parentState: selected.state,
    childState: childWithDirective,
    services
  });
  const completed = resumedParent.state.status === RESOLUTION_STATE_STATUS.CANCELLED
    ? resumedParent
    : await executeStagedActionResolution({
        state: resumedParent.state,
        actor: attacker,
        action: actionDoc,
        targetActors,
        services,
        authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"},
        persistencePort
      });

  return {
    attacker,
    defender,
    targetActors,
    waiting,
    selected,
    childCommitted,
    completed,
    persistencePort
  };
}

test("Cutting Words on an ability check: a successful check is lowered by its die and judged again (a failed escape)", async () => {
  const escaper = actorDocument("escaper", {system: actorSystem({action: 1, reaction: 1, ac: 14})});
  const bard = actorDocument("bard", {system: actorSystem({action: 1, reaction: 1, hp: 20, ac: 12})});
  const targetActors = targetActorsFor(escaper, bard);
  const escape = {schemaVersion: 1, id: "action:test-escape", label: "Escape", costs: actionCost(), targeting: {type: "self"},
    check: {ability: "agility", skill: "acrobatics", dc: {value: 13}}};
  const words = {schemaVersion: 1, id: "action:test-cutting-words", label: "Cutting Words", costs: reactionCost(),
    targeting: {type: "single", required: true, count: 1}, rider: {attackPenalty: {dice: {type: "constant", value: 5}}}};
  const trigger = createReactionTrigger({id: "trigger:test-cutting-words", event: AUTOMATION_EVENT_TYPES.CHECK_SUCCEEDED,
    match: {phase: AUTOMATION_EVENT_PHASES.INTERRUPT}, actorId: bard.id, actionId: words.id, actionRef: words.id, action: words,
    chooser: {kind: "specific", userId: "player-b"}});
  const services = {targetActors, reactions: {triggers: [trigger], resourcesByActor: {[bard.id]: reactionResourcesFor(bard)},
    controllerUserIdsByActor: {[bard.id]: ["player-b"]}, actorDocumentsByActor: {[bard.id]: bard}, actorSystemsByActor: {[bard.id]: bard.system},
    // Its target is the creature whose check it answers, as the Foundry reaction services make it.
    createChildState: ({parentState, candidate, baseChildState}) => createActionResolutionState({...baseChildState,
      actorSystem: bard.system, action: actionItem(candidate.actionDefinition), source: candidate.reactor, targets: [targetRef(escaper.id)],
      metadata: {...baseChildState.metadata, parentResolutionId: parentState.id}})}};
  const waiting = planStagedActionResolution({id: "resolution:cutting-check", actor: escaper, action: actionItem(escape),
    source: {actorId: escaper.id, actorRef: escaper.uuid}, targets: [], check: {ability: "agility", skill: "acrobatics", dc: 13,
      roll: {total: 16, die: 12}}, targetActors, services});
  assert.equal(waiting.ok, true, resultDiagnostic(waiting));
  assert.equal(waiting.state.currentStageId, ACTION_PIPELINE_STAGE_IDS.REACTION_AFTER_CHECK_OUTCOME, "offered once the check succeeds");
  assert.equal(waiting.state.results.checkResolution.success, true);
  const selected = resumeStagedActionResolution({state: waiting.state, response: acceptResponse(waiting.state.pendingRequests[0]), services});
  const child = await executeStagedActionResolution({state: selected.state.metadata.activeChildResolution, actor: bard,
    action: actionItem(words), targetActors, authority: {isGM: true, userId: "gm-a", activeGMId: "gm-a"},
    persistencePort: createTestDocumentPersistenceAdapter()});
  assert.equal(child.state.status, RESOLUTION_STATE_STATUS.COMPLETED, resultDiagnostic(child));
  const resumed = completeStagedReactionChildResolution({parentState: selected.state, childState: child.state, services});
  assert.equal(resumed.ok, true, resultDiagnostic(resumed));
  assert.deepEqual([resumed.state.results.checkResolution.success, resumed.state.input.check.roll.total], [false, 11],
    "16 less 5 is 11 against DC 13: the escape fails");
});
