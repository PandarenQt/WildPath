import {test} from "node:test";
import assert from "node:assert/strict";
import {ECONOMY_CAPABILITIES} from "../module/helpers/action-economy.mjs";
import {ACTION_CHOICE_TYPES} from "../module/helpers/action-configuration.mjs";
import {
  MULTIPLAYER_AUTHORITY_CODES,
  MULTIPLAYER_MESSAGE_TYPES,
  createResolutionSocketEnvelope,
  validateResolutionSocketEnvelope
} from "../module/helpers/multiplayer-authority.mjs";
import {
  RESOLUTION_REQUEST_TYPES,
  RESOLUTION_STATE_STATUS
} from "../module/helpers/resolution-state.mjs";
import {
  ROLL_PROVENANCE_TYPES
} from "../module/helpers/rolls.mjs";
import {createTestPromptAdapter} from "../module/adapters/test-prompt-adapter.mjs";
import {createTestDocumentPersistenceAdapter} from "../module/adapters/test-persistence-adapter.mjs";
import {createTestResolutionTransportHub} from "../module/adapters/test-resolution-transport.mjs";
import {createMultiplayerActionCoordinator} from "../module/resolvers/multiplayer-action-coordinator.mjs";
import {
  createPhysicalDiceProvider,
  createTestRollProvider,
  executeRollRequest
} from "../module/resolvers/roll-provider-resolver.mjs";

function actorSystem(overrides={}) {
  return {
    resources: {
      action: {value: 1, max: 1},
      bonus: {value: 1, max: 1},
      reaction: {value: 1, max: 1},
      movement: {value: 30, max: 30},
      ...(overrides.resources ?? {})
    },
    pools: overrides.pools ?? []
  };
}

function spellcastingActorSystem() {
  return actorSystem({
    pools: [
      {id: "spell-slot.1", label: "1st-level Slot", value: 1, max: 1},
      {id: "spell-slot.2", label: "2nd-level Slot", value: 1, max: 1},
      {id: "spell-slot.3", label: "3rd-level Slot", value: 1, max: 1},
      {id: "sorcery-point", label: "Sorcery Point", value: 1, max: 1}
    ]
  });
}

function targetActorSystem(value=20, max=20) {
  return {
    resources: {
      health: {value, max}
    },
    pools: []
  };
}

function actorDocument(id, {system=actorSystem(), effects=[]}={}) {
  return {
    id,
    uuid: `Actor.${id}`,
    name: id,
    type: "character",
    system,
    effects
  };
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

function attackDefinition({damage=9}={}) {
  return {
    schemaVersion: 1,
    id: "action:socket-test-attack",
    label: "Socket Test Attack",
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

function scalingDefinition() {
  return {
    schemaVersion: 1,
    id: "action:socket-scaling-strike",
    label: "Socket Scaling Strike",
    tags: ["spell"],
    costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1},
    damage: [{
      id: "burst",
      expression: {type: "dice", number: 2, faces: 6},
      damageType: "fire",
      provenance: "spell-base"
    }],
    configuration: [{
      id: "casting-resource",
      type: ACTION_CHOICE_TYPES.RESOURCE,
      label: "Cast At",
      required: true,
      cost: {
        anyOf: [
          [{capability: "spell-slot.1", amount: 1}],
          [{capability: "spell-slot.2", amount: 1}],
          [{capability: "spell-slot.3", amount: 1}]
        ]
      },
      levelByResourceId: {
        "spell-slot.1": 1,
        "spell-slot.2": 2,
        "spell-slot.3": 3
      },
      effects: [{
        type: "scaleDamage",
        componentIds: ["burst"],
        levelChoiceId: "casting-resource",
        baseLevel: 1,
        dice: {number: 1, faces: 6}
      }]
    }]
  };
}

function conversionChoices() {
  return [
    {
      id: "enable-conversion",
      type: ACTION_CHOICE_TYPES.BOOLEAN,
      label: "Elemental Conversion",
      source: {type: "feature", slug: "elemental-conversion"},
      effects: [{
        type: "addCost",
        cost: {allOf: [{capability: "sorcery-point", amount: 1}]}
      }]
    },
    {
      id: "conversion-type",
      type: ACTION_CHOICE_TYPES.DAMAGE_TYPE,
      label: "Replacement Damage Type",
      required: true,
      dependsOn: {choiceId: "enable-conversion", equals: true},
      allowedDamageTypes: ["cold", "lightning"],
      source: {type: "feature", slug: "elemental-conversion"},
      effects: [{
        type: "replaceDamageType",
        componentIds: ["burst"],
        damageTypeChoiceId: "conversion-type"
      }]
    }
  ];
}

function attackFixture({sourceSystem=actorSystem(), targetHp=20, persistencePort=null}={}) {
  const actor = actorDocument("actor-source", {system: sourceSystem});
  const targetActor = actorDocument("actor-enemy", {system: targetActorSystem(targetHp, targetHp)});
  const target = {
    id: "enemy",
    actorId: "actor-enemy",
    actorRef: "Actor.actor-enemy",
    disposition: "enemy",
    defenses: {ac: {value: 12}}
  };
  return {
    actor,
    action: actionItem(attackDefinition()),
    targetActor,
    target,
    targetActors: {"actor:actor-enemy": targetActor, "Actor.actor-enemy": targetActor},
    persistencePort: persistencePort ?? createTestDocumentPersistenceAdapter()
  };
}

function users({activeGMId="gm-a", playerAActive=true, gmB=false}={}) {
  return [
    {id: "gm-a", active: activeGMId === "gm-a", isGM: true, isActiveGM: activeGMId === "gm-a"},
    ...(gmB ? [{id: "gm-b", active: activeGMId === "gm-b", isGM: true, isActiveGM: activeGMId === "gm-b"}] : []),
    {id: "player-a", active: playerAActive, isGM: false},
    {id: "player-b", active: true, isGM: false}
  ];
}

function createFixtureResolver(fixture, requestContext={}) {
  return ({intent}) => {
    assert.equal(intent.mutationPlans, undefined);
    assert.equal(intent.rollResults, undefined);
    return {
      ok: true,
      options: {
        actor: fixture.actor,
        action: fixture.action,
        source: {actorId: fixture.actor.id, actorRef: fixture.actor.uuid},
        targets: [fixture.target],
        targetActors: fixture.targetActors,
        attack: fixture.action.system.definition.attack ? {defense: {value: 12}} : null,
        durability: true,
        configurationContributions: requestContext.configurationContributions ?? [],
        persistencePort: fixture.persistencePort
      },
      services: {targetActors: fixture.targetActors},
      requestContext: {
        sourceControllerUserIds: ["player-a"],
        targetControllerUserIds: ["player-a"],
        ...requestContext
      }
    };
  };
}

function setupClients({
  userList=users(),
  activeGMUserId="gm-a",
  gmResolver=null,
  gmRollProviders=[],
  playerRollProviders=[],
  playerRollContext={},
  playerPromptPorts=[],
  allowGMRequestFallback=true
}={}) {
  const hub = createTestResolutionTransportHub({users: userList});
  const gmTransport = hub.createEndpoint({userId: activeGMUserId});
  const playerTransport = hub.createEndpoint({userId: "player-a"});
  const playerBTransport = hub.createEndpoint({userId: "player-b"});
  const gm = createMultiplayerActionCoordinator({
    userId: activeGMUserId,
    users: () => hub.userDirectory(),
    activeGMUserId,
    transport: gmTransport,
    actionIntentResolver: gmResolver,
    rollProviders: gmRollProviders,
    allowGMRequestFallback
  });
  const player = createMultiplayerActionCoordinator({
    userId: "player-a",
    users: () => hub.userDirectory(),
    activeGMUserId,
    transport: playerTransport,
    rollProviders: playerRollProviders,
    rollContext: playerRollContext,
    promptPorts: playerPromptPorts
  });
  const playerB = createMultiplayerActionCoordinator({
    userId: "player-b",
    users: () => hub.userDirectory(),
    activeGMUserId,
    transport: playerBTransport
  });
  gm.register();
  player.register();
  playerB.register();
  return {hub, gm, player, playerB, transports: {gmTransport, playerTransport, playerBTransport}};
}

test("player action intent routes to active GM authority, remote attack roll, single commit, and sanitized result", async () => {
  const fixture = attackFixture();
  const {hub, gm, player} = setupClients({
    gmResolver: createFixtureResolver(fixture),
    playerRollProviders: [createTestRollProvider({result: {natural: 18, total: 18}})]
  });

  const declared = await player.declareActionIntent({
    intentId: "intent:attack",
    resolutionId: "resolution:socket-attack",
    actorRef: fixture.actor.uuid,
    actionRef: fixture.action.uuid,
    targetRefs: [fixture.target.actorRef],
    mutationPlans: [{type: "forged-client-plan"}],
    rollResults: [{requestId: "forged-roll"}]
  });
  const record = gm.getRecord("resolution:socket-attack");
  const result = player.getResult("resolution:socket-attack");

  assert.equal(declared.ok, true);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(fixture.targetActor.system.resources.health.value, 11);
  assert.equal(fixture.actor.system.resources.action.value, 0);
  assert.equal(fixture.persistencePort.operations.filter(operation => operation.type === "updateActor").length, 2);
  assert.equal(result.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(result.mutationPlans, undefined);
  assert.equal(result.rolls[0].rollResult.requestId, "request:resolution:socket-attack:attack-roll");
  assert.equal(hub.messages.some(message => message.messageType === MULTIPLAYER_MESSAGE_TYPES.PENDING_REQUEST && message.recipientUserId === "player-a"), true);
  assert.equal(hub.messages.some(message => message.messageType === MULTIPLAYER_MESSAGE_TYPES.RESOLUTION_RESULT), true);
});

test("configured action choice and damage roll are routed to the source controller and spend resources only at authority commit", async () => {
  const sourceSystem = spellcastingActorSystem();
  const fixture = attackFixture({sourceSystem});
  fixture.action = actionItem(scalingDefinition());
  const choices = {
    "casting-resource": {resourceId: "spell-slot.3"},
    "enable-conversion": true,
    "conversion-type": "lightning"
  };
  const {gm, player} = setupClients({
    gmResolver: createFixtureResolver(fixture, {configurationContributions: conversionChoices()}),
    playerPromptPorts: [createTestPromptAdapter({
      queue: [() => {
        assert.equal(sourceSystem.pools.find(pool => pool.id === "spell-slot.3").value, 1);
        assert.equal(sourceSystem.pools.find(pool => pool.id === "sorcery-point").value, 1);
        return {choices};
      }]
    })],
    playerRollProviders: [createTestRollProvider({result: {total: 14}})]
  });

  await player.declareActionIntent({
    intentId: "intent:scaling",
    resolutionId: "resolution:socket-scaling",
    actorRef: fixture.actor.uuid,
    actionRef: fixture.action.uuid,
    targetRefs: [fixture.target.actorRef]
  });
  const record = gm.getRecord("resolution:socket-scaling");

  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(record.state.results.preview.damage.components[0].formula, "4d6");
  assert.equal(record.state.results.preview.damage.components[0].damageType, "lightning");
  assert.equal(record.state.input.damage.components[0].amount, 14);
  assert.equal(fixture.targetActor.system.resources.health.value, 6);
  assert.equal(sourceSystem.pools.find(pool => pool.id === "spell-slot.3").value, 0);
  assert.equal(sourceSystem.pools.find(pool => pool.id === "sorcery-point").value, 0);
});

test("remote physical d20 rolls flow through RollProvider and resolve like digital results", async () => {
  const fixture = attackFixture();
  const {gm, player} = setupClients({
    gmResolver: createFixtureResolver(fixture),
    playerRollProviders: [createPhysicalDiceProvider()],
    playerRollContext: {physicalRolls: [{natural: 19, total: 19}]},
    playerPromptPorts: []
  });

  await player.declareActionIntent({
    intentId: "intent:physical",
    resolutionId: "resolution:physical-roll",
    actorRef: fixture.actor.uuid,
    actionRef: fixture.action.uuid,
    targetRefs: [fixture.target.actorRef]
  });

  const record = gm.getRecord("resolution:physical-roll");
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(record.state.rollResults[0].rollResult.provenance.type, ROLL_PROVENANCE_TYPES.PHYSICAL);
});

test("duplicate request responses and duplicate action intents do not commit twice", async () => {
  const fixture = attackFixture();
  const {hub, gm, player, transports} = setupClients({
    gmResolver: createFixtureResolver(fixture),
    playerRollProviders: [createTestRollProvider({result: {natural: 18, total: 18}})]
  });

  await player.declareActionIntent({
    intentId: "intent:dedupe",
    resolutionId: "resolution:dedupe",
    actorRef: fixture.actor.uuid,
    actionRef: fixture.action.uuid,
    targetRefs: [fixture.target.actorRef]
  });
  const responseEnvelope = hub.messages.find(message => message.messageType === MULTIPLAYER_MESSAGE_TYPES.REQUEST_RESPONSE);
  const updateCount = fixture.persistencePort.operations.length;
  const hpAfterFirstCommit = fixture.targetActor.system.resources.health.value;

  await transports.playerTransport.send({
    ...responseEnvelope,
    messageId: "message:duplicate-response"
  });
  await player.declareActionIntent({
    intentId: "intent:dedupe",
    resolutionId: "resolution:dedupe",
    actorRef: fixture.actor.uuid,
    actionRef: fixture.action.uuid,
    targetRefs: [fixture.target.actorRef]
  });

  assert.equal(gm.getRecord("resolution:dedupe").state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(fixture.persistencePort.operations.length, updateCount);
  assert.equal(fixture.targetActor.system.resources.health.value, hpAfterFirstCommit);
});

test("wrong user, wrong request, and stale responses are rejected before resume", async () => {
  const fixture = attackFixture();
  const hub = createTestResolutionTransportHub({users: users()});
  const gmTransport = hub.createEndpoint({userId: "gm-a"});
  const playerTransport = hub.createEndpoint({userId: "player-a"});
  const playerBTransport = hub.createEndpoint({userId: "player-b"});
  const gm = createMultiplayerActionCoordinator({
    userId: "gm-a",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-a",
    transport: gmTransport,
    actionIntentResolver: createFixtureResolver(fixture)
  });
  const player = createMultiplayerActionCoordinator({
    userId: "player-a",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-a",
    transport: playerTransport
  });
  gm.register();
  player.register();

  await player.declareActionIntent({
    intentId: "intent:invalid-response",
    resolutionId: "resolution:invalid-response",
    actorRef: fixture.actor.uuid,
    actionRef: fixture.action.uuid,
    targetRefs: [fixture.target.actorRef]
  });
  const record = gm.getRecord("resolution:invalid-response");
  const request = record.state.pendingRequests[0];
  const provided = await executeRollRequest({
    request: request.payload.rollRequest,
    providers: [createTestRollProvider({result: {natural: 18, total: 18}})]
  });

  await playerBTransport.send(createResolutionSocketEnvelope({
    messageType: MULTIPLAYER_MESSAGE_TYPES.REQUEST_RESPONSE,
    senderUserId: "player-b",
    recipientUserId: "gm-a",
    resolutionId: record.resolutionId,
    requestId: request.id,
    payload: {
      response: {
        resolutionId: record.resolutionId,
        requestId: request.id,
        type: RESOLUTION_REQUEST_TYPES.ROLL,
        value: provided.result
      }
    }
  }));
  await playerTransport.send(createResolutionSocketEnvelope({
    messageType: MULTIPLAYER_MESSAGE_TYPES.REQUEST_RESPONSE,
    senderUserId: "player-a",
    recipientUserId: "gm-a",
    resolutionId: record.resolutionId,
    requestId: "request:missing",
    payload: {
      response: {
        resolutionId: record.resolutionId,
        requestId: "request:missing",
        type: RESOLUTION_REQUEST_TYPES.ROLL,
        value: provided.result
      }
    }
  }));
  await playerTransport.send(createResolutionSocketEnvelope({
    messageType: MULTIPLAYER_MESSAGE_TYPES.REQUEST_RESPONSE,
    senderUserId: "player-a",
    recipientUserId: "gm-a",
    resolutionId: record.resolutionId,
    requestId: request.id,
    payload: {
      response: {
        resolutionId: record.resolutionId,
        requestId: request.id,
        type: RESOLUTION_REQUEST_TYPES.ROLL,
        value: provided.result
      }
    }
  }));
  await playerTransport.send(createResolutionSocketEnvelope({
    messageType: MULTIPLAYER_MESSAGE_TYPES.REQUEST_RESPONSE,
    senderUserId: "player-a",
    recipientUserId: "gm-a",
    resolutionId: record.resolutionId,
    requestId: request.id,
    payload: {
      response: {
        resolutionId: record.resolutionId,
        requestId: request.id,
        type: RESOLUTION_REQUEST_TYPES.ROLL,
        value: provided.result
      }
    }
  }));

  assert.equal(gm.errors.some(entry => entry.error?.code === MULTIPLAYER_AUTHORITY_CODES.WRONG_USER), true);
  assert.equal(gm.errors.some(entry => entry.error?.code === MULTIPLAYER_AUTHORITY_CODES.REQUEST_NOT_PENDING), true);
  assert.equal(gm.getRecord(record.resolutionId).state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(fixture.targetActor.system.resources.health.value, 11);
});

test("disconnected chooser falls back only to GM when policy allows", async () => {
  const fixture = attackFixture();
  const fallback = setupClients({
    userList: users({playerAActive: false}),
    gmResolver: createFixtureResolver(fixture),
    gmRollProviders: [createTestRollProvider({result: {natural: 18, total: 18}})]
  });

  await fallback.player.declareActionIntent({
    intentId: "intent:fallback",
    resolutionId: "resolution:fallback",
    actorRef: fixture.actor.uuid,
    actionRef: fixture.action.uuid,
    targetRefs: [fixture.target.actorRef]
  });

  const unavailableFixture = attackFixture();
  const unavailable = setupClients({
    userList: users({playerAActive: false}),
    gmResolver: createFixtureResolver(unavailableFixture),
    allowGMRequestFallback: false
  });
  await unavailable.player.declareActionIntent({
    intentId: "intent:no-fallback",
    resolutionId: "resolution:no-fallback",
    actorRef: unavailableFixture.actor.uuid,
    actionRef: unavailableFixture.action.uuid,
    targetRefs: [unavailableFixture.target.actorRef]
  });

  assert.equal(fallback.gm.getRecord("resolution:fallback").state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(fixture.targetActor.system.resources.health.value, 11);
  assert.equal(unavailable.gm.errors.some(entry => entry.error?.code === MULTIPLAYER_AUTHORITY_CODES.REQUEST_AUTHORITY_UNAVAILABLE), true);
  assert.equal(unavailableFixture.targetActor.system.resources.health.value, 20);
});

test("no active GM allows owned local authority only when commit permission is proven", async () => {
  const userList = [{id: "player-a", active: true, isGM: false}];
  const fixture = attackFixture();
  const hub = createTestResolutionTransportHub({users: userList});
  const playerTransport = hub.createEndpoint({userId: "player-a"});
  const player = createMultiplayerActionCoordinator({
    userId: "player-a",
    users: () => hub.userDirectory(),
    activeGMUserId: null,
    transport: playerTransport,
    actionIntentResolver: createFixtureResolver(fixture),
    rollProviders: [createTestRollProvider({result: {natural: 18, total: 18}})],
    allowLocalWithoutGM: true,
    canCommitLocally: true
  });
  player.register();

  const allowed = await player.declareActionIntent({
    intentId: "intent:local",
    resolutionId: "resolution:local-authority",
    actorRef: fixture.actor.uuid,
    actionRef: fixture.action.uuid,
    targetRefs: [fixture.target.actorRef]
  });
  const denied = await createMultiplayerActionCoordinator({
    userId: "player-a",
    users: () => hub.userDirectory(),
    activeGMUserId: null,
    transport: hub.createEndpoint({userId: "player-a-denied"}),
    actionIntentResolver: createFixtureResolver(attackFixture()),
    allowLocalWithoutGM: true,
    canCommitLocally: false
  }).declareActionIntent({
    intentId: "intent:denied",
    resolutionId: "resolution:denied",
    actorRef: fixture.actor.uuid,
    actionRef: fixture.action.uuid,
    targetRefs: [fixture.target.actorRef]
  });

  assert.equal(allowed.ok, true);
  assert.equal(player.getRecord("resolution:local-authority").state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, MULTIPLAYER_AUTHORITY_CODES.AUTHORITY_UNAVAILABLE);
});

test("multiple active GM candidates still select exactly the designated active GM", async () => {
  const fixture = attackFixture();
  const userList = [
    {id: "gm-a", active: true, isGM: true, isActiveGM: false},
    {id: "gm-b", active: true, isGM: true, isActiveGM: true},
    {id: "player-a", active: true, isGM: false}
  ];
  const hub = createTestResolutionTransportHub({users: userList});
  const gmATransport = hub.createEndpoint({userId: "gm-a"});
  const gmBTransport = hub.createEndpoint({userId: "gm-b"});
  const playerTransport = hub.createEndpoint({userId: "player-a"});
  const gmA = createMultiplayerActionCoordinator({
    userId: "gm-a",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-b",
    transport: gmATransport,
    actionIntentResolver: createFixtureResolver(fixture),
    rollProviders: [createTestRollProvider({result: {natural: 18, total: 18}})]
  });
  const gmB = createMultiplayerActionCoordinator({
    userId: "gm-b",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-b",
    transport: gmBTransport,
    actionIntentResolver: createFixtureResolver(fixture),
    rollProviders: [createTestRollProvider({result: {natural: 18, total: 18}})]
  });
  const player = createMultiplayerActionCoordinator({
    userId: "player-a",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-b",
    transport: playerTransport,
    rollProviders: [createTestRollProvider({result: {natural: 18, total: 18}})]
  });
  gmA.register();
  gmB.register();
  player.register();

  const declared = await player.declareActionIntent({
    intentId: "intent:gm-b",
    resolutionId: "resolution:gm-b",
    actorRef: fixture.actor.uuid,
    actionRef: fixture.action.uuid,
    targetRefs: [fixture.target.actorRef]
  });

  assert.equal(declared.authorityUserId, "gm-b");
  assert.equal(gmA.getRecord("resolution:gm-b"), null);
  assert.equal(gmB.getRecord("resolution:gm-b").state.status, RESOLUTION_STATE_STATUS.COMPLETED);
});

test("socket envelopes reject non-plain data before transport", () => {
  const validation = validateResolutionSocketEnvelope({
    protocolVersion: 1,
    messageId: "message:bad",
    messageType: MULTIPLAYER_MESSAGE_TYPES.ACTION_INTENT,
    senderUserId: "player-a",
    recipientUserId: "gm-a",
    resolutionId: "resolution:bad",
    payload: {
      date: new Date()
    }
  });

  assert.equal(validation.ok, false);
  assert.equal(validation.code, MULTIPLAYER_AUTHORITY_CODES.NON_SERIALIZABLE_MESSAGE);
});
