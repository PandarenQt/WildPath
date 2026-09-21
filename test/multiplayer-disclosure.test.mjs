// Disclosure/confidentiality contract for the multiplayer transport. AUTHORITY (who decides),
// ROUTING (who processes) and DISCLOSURE (who may read) are tested as separate concerns here.
import {test} from "node:test";
import assert from "node:assert/strict";
import {ECONOMY_CAPABILITIES} from "../module/helpers/action-economy.mjs";
import {
  MULTIPLAYER_AUTHORITY_CODES,
  MULTIPLAYER_MESSAGE_TYPES,
  createResolutionSocketEnvelope,
  isPlainSerializableData,
  projectResolutionResultForDisclosure,
  projectRollRequestForChooser,
  sanitizePendingRequestForTransport,
  sanitizeResolutionErrorDataForTransport,
  validateResolutionSocketEnvelope
} from "../module/helpers/multiplayer-authority.mjs";
import {
  DEFAULT_DISCLOSURE_BY_MESSAGE_TYPE,
  DISCLOSURE_CLASSIFICATIONS as D,
  DISCLOSURE_CODES as C,
  DISCLOSURE_TRANSPORTS,
  PRIVATE_MESSAGE_TYPES,
  assertBroadcastSafe,
  classifyEnvelopeDisclosure,
  selectDisclosureTransport
} from "../module/helpers/multiplayer-disclosure.mjs";
import {RESOLUTION_REQUEST_TYPES, RESOLUTION_STATE_STATUS} from "../module/helpers/resolution-state.mjs";
import {createTestDocumentPersistenceAdapter} from "../module/adapters/test-persistence-adapter.mjs";
import {createTestResolutionTransportHub} from "../module/adapters/test-resolution-transport.mjs";
import {createDisclosureRoutedTransport} from "../module/adapters/disclosure-routed-transport.mjs";
import {createFoundryV14ResolutionSocketAdapter} from "../module/adapters/foundry-v14-resolution-socket-adapter.mjs";
import {createFoundryV14UserQueryTransport} from "../module/adapters/foundry-v14-user-query-transport.mjs";
import {createMultiplayerActionCoordinator} from "../module/resolvers/multiplayer-action-coordinator.mjs";
import {createTestRollProvider, executeRollRequest} from "../module/resolvers/roll-provider-resolver.mjs";

const M = MULTIPLAYER_MESSAGE_TYPES;

/* -------------------------------------------- */
/*  Fixtures                                     */
/* -------------------------------------------- */

function actorSystem() {
  return {resources: {action: {value: 1, max: 1}, bonus: {value: 1, max: 1}, reaction: {value: 1, max: 1},
    movement: {value: 30, max: 30}}, pools: []};
}

function actorDocument(id, system) {
  return {id, uuid: `Actor.${id}`, name: id, type: "character", system, effects: []};
}

function attackFixture() {
  const definition = {
    schemaVersion: 1, id: "action:disclosure-attack", label: "Disclosure Attack",
    costs: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]},
    targeting: {type: "single", required: true, count: 1},
    attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
    damage: [{id: "weapon", expression: {type: "constant", value: 9}, damageType: "slashing", provenance: "weapon-base"}]
  };
  const actor = actorDocument("actor-source", actorSystem());
  const targetActor = actorDocument("actor-enemy", {resources: {health: {value: 20, max: 20}}, pools: []});
  const target = {id: "enemy", actorId: "actor-enemy", actorRef: "Actor.actor-enemy", disposition: "enemy",
    defenses: {ac: {value: 12}}};
  return {
    actor,
    action: {id: definition.id, uuid: `Item.${definition.id}`, type: "action", name: definition.label, system: {definition}},
    targetActor,
    target,
    targetActors: {"actor:actor-enemy": targetActor, "Actor.actor-enemy": targetActor},
    persistencePort: createTestDocumentPersistenceAdapter()
  };
}

function users() {
  return [
    {id: "gm-a", active: true, isGM: true, isActiveGM: true},
    {id: "player-a", active: true, isGM: false},
    {id: "player-b", active: true, isGM: false}
  ];
}

function fixtureResolver(fixture) {
  return () => ({
    ok: true,
    options: {
      actor: fixture.actor, action: fixture.action,
      source: {actorId: fixture.actor.id, actorRef: fixture.actor.uuid},
      targets: [fixture.target], targetActors: fixture.targetActors,
      attack: {defense: {value: 12}}, durability: true, configurationContributions: [],
      persistencePort: fixture.persistencePort
    },
    services: {targetActors: fixture.targetActors},
    requestContext: {sourceControllerUserIds: ["player-a"], targetControllerUserIds: ["player-a"]}
  });
}

function setupClients({playerRollProviders=[]}={}) {
  const fixture = attackFixture();
  const hub = createTestResolutionTransportHub({users: users()});
  const transports = {
    gm: hub.createEndpoint({userId: "gm-a"}),
    playerA: hub.createEndpoint({userId: "player-a"}),
    playerB: hub.createEndpoint({userId: "player-b"})
  };
  const shared = {users: () => hub.userDirectory(), activeGMUserId: "gm-a"};
  const gm = createMultiplayerActionCoordinator({...shared, userId: "gm-a", transport: transports.gm,
    actionIntentResolver: fixtureResolver(fixture)});
  const playerA = createMultiplayerActionCoordinator({...shared, userId: "player-a", transport: transports.playerA,
    rollProviders: playerRollProviders});
  const playerB = createMultiplayerActionCoordinator({...shared, userId: "player-b", transport: transports.playerB});
  gm.register(); playerA.register(); playerB.register();
  return {fixture, hub, transports, gm, playerA, playerB};
}

const INTENT = {intentId: "intent:disclosure", resolutionId: "resolution:disclosure"};

async function declare(clients) {
  return clients.playerA.declareActionIntent({...INTENT, actorRef: clients.fixture.actor.uuid,
    actionRef: clients.fixture.action.uuid, targetRefs: [clients.fixture.target.actorRef]});
}

/** A completed attack: player-a initiates, gm resolves, player-a rolls remotely, gm commits. */
async function completedAttack() {
  const clients = setupClients({playerRollProviders: [createTestRollProvider({result: {natural: 18, total: 22}})]});
  const declared = await declare(clients);
  assert.equal(declared.ok, true, JSON.stringify(declared));
  assert.equal(clients.gm.getRecord(INTENT.resolutionId)?.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  return {...clients, declared};
}

/** An attack paused on the attack roll: player-a has no roll provider, so the request stays pending. */
async function pendingAttack() {
  const clients = setupClients();
  const declared = await declare(clients);
  assert.equal(declared.ok, true, JSON.stringify(declared));
  const pending = clients.hub.targetedMessages.find(m => m.envelope.messageType === M.PENDING_REQUEST);
  assert.ok(pending, "the attack roll request must have been routed on the targeted transport");
  const request = pending.envelope.payload.request;
  const provided = await executeRollRequest({request: request.payload.rollRequest,
    providers: [createTestRollProvider({result: {natural: 18, total: 22}})]});
  assert.equal(provided.ok, true);
  const response = (senderUserId, overrides={}) => createResolutionSocketEnvelope({
    messageType: M.REQUEST_RESPONSE, senderUserId, recipientUserId: "gm-a",
    resolutionId: request.resolutionId, requestId: request.id,
    payload: {response: {resolutionId: request.resolutionId, requestId: request.id, type: RESOLUTION_REQUEST_TYPES.ROLL,
      value: provided.result}},
    ...overrides
  });
  return {...clients, declared, request, response};
}

function envelope(overrides={}) {
  return createResolutionSocketEnvelope({
    messageType: M.PENDING_REQUEST, senderUserId: "gm-a", recipientUserId: "player-a",
    resolutionId: "resolution:disclosure", requestId: "request:1",
    payload: {request: {id: "request:1", type: "roll", payload: {rollRequest: {id: "request:1", secretDC: 17}}}},
    ...overrides
  });
}

function fakeSocket() {
  const listeners = new Map();
  const emitted = [];
  return {
    emitted,
    on(name, fn) { listeners.set(name, fn); },
    emit(name, ...args) { emitted.push({name, args}); },
    async receive(name, ...args) { await listeners.get(name)?.(...args); }
  };
}

function fakeGame({id="gm-a", isGM=true}={}) {
  return {socket: fakeSocket(), user: {id, isGM, active: true}, userId: id, users: []};
}

function recorder() {
  const warnings = [];
  return {warnings, logger: {warn: (...args) => warnings.push(args)}};
}

/* -------------------------------------------- */
/*  1-4: broadcast adapter fails closed          */
/* -------------------------------------------- */

test("1. a BROADCAST_SAFE envelope may use system.wildpath (real adapter and test bus)", async () => {
  const game = fakeGame();
  const adapter = createFoundryV14ResolutionSocketAdapter({game});
  const intent = envelope({messageType: M.ACTION_INTENT, senderUserId: "player-a", recipientUserId: "gm-a",
    requestId: null, payload: {actorRef: "Actor.actor-source"}});
  assert.equal(intent.disclosure, D.BROADCAST_SAFE, "ACTION_INTENT is classified BROADCAST_SAFE by policy");
  const sent = await adapter.send(intent);
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(game.socket.emitted.length, 1);
  assert.equal(game.socket.emitted[0].name, "system.wildpath");
  assert.equal(game.socket.emitted[0].args[0].disclosure, D.BROADCAST_SAFE);

  const hub = createTestResolutionTransportHub({users: users()});
  const gm = hub.createEndpoint({userId: "gm-a"});
  const player = hub.createEndpoint({userId: "player-a"});
  const seen = [];
  gm.register(e => { seen.push(e); return {ok: true}; });
  player.register(() => ({ok: true}));
  const routed = await player.send(intent);
  assert.equal(routed.ok, true);
  assert.equal(routed.transport, DISCLOSURE_TRANSPORTS.BROADCAST);
  assert.equal(hub.broadcastMessages.length, 1);
  assert.equal(seen.length, 1);
});

test("2. a PARTICIPANT_PRIVATE envelope is refused by the broadcast adapter with a structured code", async () => {
  const game = fakeGame();
  const adapter = createFoundryV14ResolutionSocketAdapter({game});
  const sent = await adapter.send(envelope());
  assert.equal(sent.ok, false);
  assert.equal(sent.code, C.PRIVATE_PAYLOAD_REQUIRES_TARGETED_TRANSPORT);
  assert.equal(sent.classification, D.PARTICIPANT_PRIVATE);
  assert.equal(game.socket.emitted.length, 0, "nothing may reach socket.emit");
});

test("3. a GM_PRIVATE envelope is refused by the broadcast adapter", async () => {
  const game = fakeGame();
  const adapter = createFoundryV14ResolutionSocketAdapter({game});
  const sent = await adapter.send(envelope({disclosure: D.GM_PRIVATE, recipientUserId: "gm-a", senderUserId: "player-a"}));
  assert.equal(sent.ok, false);
  assert.equal(sent.code, C.PRIVATE_PAYLOAD_REQUIRES_TARGETED_TRANSPORT);
  assert.equal(sent.classification, D.GM_PRIVATE);
  assert.equal(game.socket.emitted.length, 0);
  const hub = createTestResolutionTransportHub({users: users()});
  const gm = hub.createEndpoint({userId: "gm-a"});
  const bus = await gm.broadcast.send(envelope({disclosure: D.GM_PRIVATE}));
  assert.equal(bus.code, C.PRIVATE_PAYLOAD_REQUIRES_TARGETED_TRANSPORT);
  assert.equal(hub.broadcastMessages.length, 0);
});

test("4. an unclassified envelope fails closed everywhere; RESOLUTION_RESULT has no implicit classification", async () => {
  const unclassified = envelope({messageType: M.RESOLUTION_RESULT, requestId: null, recipientPolicy: "all",
    recipientUserId: null, payload: {result: {status: "completed"}}});
  assert.equal(unclassified.disclosure, null);
  assert.equal(classifyEnvelopeDisclosure(unclassified).code, C.UNCLASSIFIED_DISCLOSURE);

  const game = fakeGame();
  const adapter = createFoundryV14ResolutionSocketAdapter({game});
  assert.equal((await adapter.send(unclassified)).code, C.UNCLASSIFIED_DISCLOSURE);
  assert.equal(game.socket.emitted.length, 0);

  const hub = createTestResolutionTransportHub({users: users()});
  const gm = hub.createEndpoint({userId: "gm-a"});
  hub.createEndpoint({userId: "player-a"});
  const routed = await gm.send(unclassified);
  assert.equal(routed.ok, false);
  assert.equal(routed.code, C.UNCLASSIFIED_DISCLOSURE);
  assert.equal(hub.refusals.at(-1)?.code, C.UNCLASSIFIED_DISCLOSURE);
  assert.equal(hub.messages.length, 0);
  assert.equal((await gm.targeted.send(unclassified)).code, C.UNCLASSIFIED_DISCLOSURE);

  // Unknown classifications are invalid envelopes, not silently unclassified.
  const unknown = validateResolutionSocketEnvelope({...envelope(), disclosure: "SECRET"});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, MULTIPLAYER_AUTHORITY_CODES.INVALID_ENVELOPE);
  assert.throws(() => envelope({disclosure: "public"}), /Unknown disclosure classification/);

  // Every current message type except RESOLUTION_RESULT has an audited default.
  for ( const type of Object.values(M) ) {
    if ( type === M.RESOLUTION_RESULT ) assert.equal(DEFAULT_DISCLOSURE_BY_MESSAGE_TYPE[type], undefined);
    else assert.ok(DEFAULT_DISCLOSURE_BY_MESSAGE_TYPE[type], `${type} needs an audited default classification`);
  }
  assert.deepEqual(DEFAULT_DISCLOSURE_BY_MESSAGE_TYPE, {
    ACTION_INTENT: D.BROADCAST_SAFE, MOVEMENT_INTENT: D.BROADCAST_SAFE, MOVEMENT_COMMIT: D.BROADCAST_SAFE,
    PENDING_REQUEST: D.PARTICIPANT_PRIVATE, REQUEST_RESPONSE: D.PARTICIPANT_PRIVATE, RESOLUTION_CANCEL: D.PARTICIPANT_PRIVATE,
    RESOLUTION_ERROR: D.PARTICIPANT_PRIVATE, MOVEMENT_APPROVAL: D.PARTICIPANT_PRIVATE, MOVEMENT_RESULT: D.PARTICIPANT_PRIVATE,
    MOVEMENT_CONTINUATION: D.PARTICIPANT_PRIVATE
  });
  assert.deepEqual([...PRIVATE_MESSAGE_TYPES].sort(), ["MOVEMENT_APPROVAL", "MOVEMENT_CONTINUATION", "MOVEMENT_RESULT",
    "PENDING_REQUEST", "REQUEST_RESPONSE", "RESOLUTION_CANCEL", "RESOLUTION_ERROR"]);
});

/* -------------------------------------------- */
/*  5-9: targeted delivery and unchanged authority */
/* -------------------------------------------- */

test("5. a targeted private request reaches only the intended logical user", async () => {
  const hub = createTestResolutionTransportHub({users: users()});
  const seen = {};
  const endpoints = Object.fromEntries(["gm-a", "player-a", "player-b"].map(id => {
    const endpoint = hub.createEndpoint({userId: id});
    endpoint.register(e => { (seen[id] ??= []).push(e); return {ok: true}; });
    return [id, endpoint];
  }));
  const sent = await endpoints["gm-a"].send(envelope());
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.transport, DISCLOSURE_TRANSPORTS.TARGETED);
  assert.equal(seen["player-a"].length, 1);
  assert.equal(seen["player-a"][0].payload.request.payload.rollRequest.secretDC, 17);
  assert.equal(seen["player-b"], undefined);
  assert.equal(seen["gm-a"], undefined);
  assert.equal(endpoints["player-b"].received.length, 0);
  assert.equal(hub.broadcastMessages.length, 0);
  assert.deepEqual(hub.targetedMessages.map(m => [m.senderUserId, m.recipientUserId]), [["gm-a", "player-a"]]);
  assert.equal(hub.messages.length, 1);
});

test("6. a wrong user cannot answer a targeted request, and cannot forge the chooser's identity", async () => {
  const f = await pendingAttack();
  const pendingStatus = f.gm.getRecord(INTENT.resolutionId).state.status;
  assert.notEqual(pendingStatus, RESOLUTION_STATE_STATUS.COMPLETED);
  const hp = () => f.fixture.targetActor.system.resources.health.value;

  const wrongUser = await f.transports.playerB.send(f.response("player-b"));
  assert.equal(wrongUser.ok, true, "transport delivered the answer; the authority rejects it");
  assert.equal(f.gm.errors.some(e => e.error?.code === MULTIPLAYER_AUTHORITY_CODES.WRONG_USER), true);
  assert.equal(f.playerB.errors.some(e => e.error?.code === MULTIPLAYER_AUTHORITY_CODES.WRONG_USER), true,
    "the rejection is delivered to the wrong user on the targeted transport");
  assert.equal(f.gm.getRecord(INTENT.resolutionId).state.status, pendingStatus);
  assert.equal(hp(), 20);

  const forged = await f.transports.playerB.send(f.response("player-a"));
  assert.equal(forged.ok, false);
  assert.equal(forged.code, C.DISCLOSURE_SENDER_MISMATCH, "the attested sender identity wins over the claimed one");
  assert.equal(f.gm.getRecord(INTENT.resolutionId).state.status, pendingStatus);

  const genuine = await f.transports.playerA.send(f.response("player-a"));
  assert.equal(genuine.ok, true);
  assert.equal(f.gm.getRecord(INTENT.resolutionId).state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(hp(), 11);
});

test("7. a stale (replayed) request response remains rejected after completion", async () => {
  const f = await pendingAttack();
  await f.transports.playerA.send(f.response("player-a"));
  assert.equal(f.gm.getRecord(INTENT.resolutionId).state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  const operations = f.fixture.persistencePort.operations.length;
  const replay = await f.transports.playerA.send(f.response("player-a", {messageId: "message:replay"}));
  assert.equal(replay.ok, true);
  assert.equal(replay.receipt?.duplicate, true, JSON.stringify(replay.receipt));
  assert.equal(replay.receipt?.code, MULTIPLAYER_AUTHORITY_CODES.DUPLICATE_REQUEST_RESPONSE);
  assert.equal(f.fixture.persistencePort.operations.length, operations, "no second commit");
  assert.equal(f.fixture.targetActor.system.resources.health.value, 11);
});

test("8. a response with the wrong resolution id remains rejected", async () => {
  const f = await pendingAttack();
  const wrong = await f.transports.playerA.send(f.response("player-a", {resolutionId: "resolution:other",
    payload: {response: {resolutionId: "resolution:other", requestId: f.request.id, type: RESOLUTION_REQUEST_TYPES.ROLL, value: {}}}}));
  assert.equal(wrong.ok, true);
  assert.equal(wrong.receipt?.code, MULTIPLAYER_AUTHORITY_CODES.RESOLUTION_NOT_FOUND);
  assert.notEqual(f.gm.getRecord(INTENT.resolutionId).state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(f.fixture.targetActor.system.resources.health.value, 20);
});

test("9. active-GM authority checks are unchanged; GM_PRIVATE additionally requires a GM recipient", async () => {
  const f = await completedAttack();
  assert.equal(f.declared.authorityUserId, "gm-a");
  assert.equal(f.gm.getRecord(INTENT.resolutionId).authorityUserId, "gm-a");

  // A forged result from a non-authority is still ignored, even though it is BROADCAST_SAFE.
  const before = f.playerA.getResult(INTENT.resolutionId);
  const forged = await f.transports.playerB.send(createResolutionSocketEnvelope({
    messageType: M.RESOLUTION_RESULT, senderUserId: "player-b", recipientPolicy: "all", disclosure: D.BROADCAST_SAFE,
    resolutionId: INTENT.resolutionId, payload: {result: {status: RESOLUTION_STATE_STATUS.COMPLETED, forged: true}}
  }));
  assert.equal(forged.ok, true);
  assert.deepEqual(f.playerA.getResult(INTENT.resolutionId), before);
  assert.equal(f.playerB.getResult(INTENT.resolutionId).forged, undefined);

  const toPlayer = await f.transports.gm.send(envelope({disclosure: D.GM_PRIVATE, resolutionId: "resolution:gm-note",
    payload: {request: {id: "request:1"}}}));
  assert.equal(toPlayer.ok, false);
  assert.equal(toPlayer.code, C.GM_PRIVATE_REQUIRES_GM_RECIPIENT);
  const toGM = await f.transports.playerA.send(envelope({disclosure: D.GM_PRIVATE, senderUserId: "player-a",
    recipientUserId: "gm-a", resolutionId: "resolution:gm-note", payload: {request: {id: "request:1"}}}));
  assert.equal(toGM.ok, true, JSON.stringify(toGM));
  assert.equal(toGM.transport, DISCLOSURE_TRANSPORTS.TARGETED);
  assert.equal(hubTypes(f.hub.broadcastMessages).includes("GM_PRIVATE"), false);
});

function hubTypes(messages) {
  return messages.map(m => `${m.messageType}:${m.disclosure}`);
}

/* -------------------------------------------- */
/*  11, 13-15: private contents, projections, serialization, routing vs disclosure */
/* -------------------------------------------- */

test("11. private roll request contents never appear in recorded broadcast envelopes, and the chooser payload is minimized", async () => {
  const f = await completedAttack();
  const bus = f.hub.broadcastMessages;
  assert.deepEqual([...new Set(bus.map(m => m.messageType))].sort(), [M.ACTION_INTENT, M.RESOLUTION_RESULT]);
  assert.equal(bus.every(m => m.disclosure === D.BROADCAST_SAFE), true);
  const text = JSON.stringify(bus);
  for ( const marker of ["rollRequest", "\"defense\"", "\"defenses\"", "\"dc\"", "committedMutations", "paymentPlan", "preview", "\"terms\""] ) {
    assert.equal(text.includes(marker), false, `broadcast traffic must not contain ${marker}`);
  }
  const pending = f.hub.targetedMessages.find(m => m.envelope.messageType === M.PENDING_REQUEST);
  assert.equal(pending.recipientUserId, "player-a");
  const rollRequest = pending.envelope.payload.request.payload.rollRequest;
  assert.equal(rollRequest.type, "attack");
  assert.equal(rollRequest.dc, undefined);
  assert.equal(rollRequest.data, undefined);
  assert.deepEqual(Object.keys(rollRequest.target ?? {}).filter(k => ["defense", "defenses", "actor", "system"].includes(k)), []);
  assert.equal(rollRequest.target.actorId, "actor-enemy", "the roller still learns which target it attacks");
  assert.ok(rollRequest.definition?.dice?.length, "the roller keeps the dice definition");
  assert.equal(rollRequest.expected?.primaryDieFaces, 20, "the roller keeps its expectations");
  assert.ok(Array.isArray(rollRequest.modifiers), "the roller keeps its modifier list");
  const response = f.hub.targetedMessages.find(m => m.envelope.messageType === M.REQUEST_RESPONSE);
  assert.equal(response.recipientUserId, "gm-a");
  assert.equal(response.envelope.payload.response.value.total, 22);
});

test("13. result traffic still works: the initiator gets the participant projection, everyone gets the public one", async () => {
  const f = await completedAttack();
  const results = f.hub.messages.filter(m => m.messageType === M.RESOLUTION_RESULT);
  assert.deepEqual(results.map(m => [m.disclosure, m.recipientUserId ?? m.recipientPolicy]),
    [[D.PARTICIPANT_PRIVATE, "player-a"], [D.BROADCAST_SAFE, "all"]]);

  const initiator = f.playerA.getResult(INTENT.resolutionId);
  assert.equal(initiator.disclosure, D.PARTICIPANT_PRIVATE, "the later broadcast projection must not downgrade the stored result");
  assert.equal(initiator.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(initiator.rolls[0].rollResult.total, 22);
  assert.equal(initiator.outcomes.attack.results[0].hit, true);
  assert.equal(initiator.outcomes.attack.results[0].defense.value, 12);
  assert.ok(initiator.committedMutations, "the initiator keeps the full sanitized result");

  const unrelated = f.playerB.getResult(INTENT.resolutionId);
  assert.equal(unrelated.disclosure, D.BROADCAST_SAFE);
  assert.equal(unrelated.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(unrelated.ok, true);
  assert.equal(unrelated.initiatorUserId, "player-a");
  assert.equal(unrelated.outcomes.attack.results[0].hit, true);
  assert.equal(unrelated.outcomes.attack.results[0].defense, undefined);
  assert.equal(unrelated.outcomes.attack.results[0].margin, undefined);
  assert.equal(unrelated.targets[0].defenses, undefined);
  assert.equal(unrelated.committedMutations, undefined);
  assert.equal(unrelated.outcomes.damage, undefined);
  assert.equal(unrelated.outcomes.payment, undefined);
  assert.equal(unrelated.preview, undefined);
  assert.equal(unrelated.configuration, undefined);
  assert.deepEqual(unrelated.rolls, [], "system-visibility rolls are not broadcast");

  assert.equal(f.gm.getResult(INTENT.resolutionId).disclosure, D.PARTICIPANT_PRIVATE);
  assert.equal(f.playerB.notifications.length, 1);
  assert.equal(f.playerA.notifications.length, 2);
});

test("14. serialization remains plain-data safe with the disclosure field", async () => {
  const f = await completedAttack();
  for ( const message of f.hub.messages ) assert.equal(isPlainSerializableData(message), true);
  for ( const entry of f.hub.targetedMessages ) assert.equal(isPlainSerializableData(entry.envelope), true);
  const sample = envelope();
  const round = JSON.parse(JSON.stringify(sample));
  assert.deepEqual(round, sample);
  const validated = validateResolutionSocketEnvelope(round);
  assert.equal(validated.ok, true);
  assert.equal(validated.envelope.disclosure, D.PARTICIPANT_PRIVATE);
  assert.throws(() => createResolutionSocketEnvelope({...sample, payload: {request: {answer: () => 1}}}), /serializable/);
});

test("15. routing metadata never overrides the disclosure classification", async () => {
  const hub = createTestResolutionTransportHub({users: users()});
  const gm = hub.createEndpoint({userId: "gm-a"});
  const seen = {};
  for ( const id of ["player-a", "player-b"] ) {
    hub.createEndpoint({userId: id}).register(e => { (seen[id] ??= []).push(e); return {ok: true}; });
  }
  gm.register(() => ({ok: true}));

  // Private + "all" policy: refused, never widened.
  const everyone = await gm.send(envelope({recipientUserId: null, recipientPolicy: "all"}));
  assert.equal(everyone.code, C.PRIVATE_PAYLOAD_REQUIRES_SINGLE_RECIPIENT);
  // Private + several recipients: refused.
  const several = await gm.send(envelope({recipientUserId: null, recipientUserIds: ["player-a", "player-b"]}));
  assert.equal(several.code, C.PRIVATE_PAYLOAD_REQUIRES_SINGLE_RECIPIENT);
  assert.equal(hub.messages.length, 0);
  assert.equal(seen["player-a"], undefined);

  // Broadcast-safe + single recipient: the bus carries it, routing decides who processes it.
  const intent = envelope({messageType: M.ACTION_INTENT, senderUserId: "gm-a", recipientUserId: "player-a", requestId: null, payload: {}});
  const routed = await gm.send(intent);
  assert.equal(routed.transport, DISCLOSURE_TRANSPORTS.BROADCAST);
  assert.equal(seen["player-a"].length, 1);
  assert.equal(seen["player-b"], undefined);
  assert.equal(hub.broadcastMessages.length, 1);

  const matrix = [
    [{disclosure: D.BROADCAST_SAFE, recipientPolicy: "all"}, DISCLOSURE_TRANSPORTS.BROADCAST],
    [{disclosure: D.BROADCAST_SAFE, recipientUserId: "gm-a"}, DISCLOSURE_TRANSPORTS.LOCAL],
    [{disclosure: D.PARTICIPANT_PRIVATE, recipientUserId: "gm-a"}, DISCLOSURE_TRANSPORTS.LOCAL],
    [{disclosure: D.PARTICIPANT_PRIVATE, recipientUserId: "player-a"}, DISCLOSURE_TRANSPORTS.TARGETED],
    [{disclosure: D.GM_PRIVATE, recipientUserId: "gm-a"}, DISCLOSURE_TRANSPORTS.LOCAL]
  ];
  for ( const [fields, expected] of matrix ) {
    const route = selectDisclosureTransport({messageType: "X", messageId: "m", ...fields}, {localUserId: "gm-a", users: users(), targetedAvailable: true});
    assert.equal(route.transport, expected, JSON.stringify(fields));
  }
  const noTargeted = selectDisclosureTransport({disclosure: D.PARTICIPANT_PRIVATE, recipientUserId: "player-a"}, {localUserId: "gm-a", targetedAvailable: false});
  assert.equal(noTargeted.code, C.PRIVATE_PAYLOAD_REQUIRES_TARGETED_TRANSPORT);
});

test("regression: recipientUserId !== confidentiality — an addressed private envelope still cannot broadcast", async () => {
  const addressed = envelope({recipientUserId: "player-a"});
  assert.equal(addressed.recipientUserId, "player-a");
  assert.equal(addressed.disclosure, D.PARTICIPANT_PRIVATE);

  const {warnings, logger} = recorder();
  const game = fakeGame();
  const adapter = createFoundryV14ResolutionSocketAdapter({game, logger});
  const sent = await adapter.send(addressed);
  assert.equal(sent.ok, false);
  assert.equal(sent.code, C.PRIVATE_PAYLOAD_REQUIRES_TARGETED_TRANSPORT);
  assert.equal(game.socket.emitted.length, 0);
  assert.equal(assertBroadcastSafe(addressed).code, C.PRIVATE_PAYLOAD_REQUIRES_TARGETED_TRANSPORT);

  const hub = createTestResolutionTransportHub({users: users()});
  const gm = hub.createEndpoint({userId: "gm-a"});
  hub.createEndpoint({userId: "player-a"}).register(() => { throw new Error("must never be dispatched from the bus"); });
  const bus = await gm.broadcast.send(addressed);
  assert.equal(bus.code, C.PRIVATE_PAYLOAD_REQUIRES_TARGETED_TRANSPORT);
  assert.equal(hub.broadcastMessages.length, 0);
  assert.equal(hub.refusals.length, 1);

  // Receipt side: a private envelope that somehow arrives on the bus is dropped, not processed.
  const received = [];
  adapter.register(e => { received.push(e); return {ok: true}; });
  await game.socket.receive("system.wildpath", addressed, "gm-a");
  assert.equal(received.length, 0);
  assert.equal(warnings.at(-1)?.[1]?.code, C.PRIVATE_PAYLOAD_ON_BROADCAST_TRANSPORT);
});

/* -------------------------------------------- */
/*  Adapters: real socket receipt, User#query transport, local delivery */
/* -------------------------------------------- */

test("broadcast receipt drops envelopes whose claimed sender differs from the server-attested sender", async () => {
  const {warnings, logger} = recorder();
  const game = fakeGame({id: "gm-a"});
  const adapter = createFoundryV14ResolutionSocketAdapter({game, logger});
  const received = [];
  adapter.register((e, context) => { received.push({e, context}); return {ok: true}; });
  const intent = envelope({messageType: M.ACTION_INTENT, senderUserId: "player-a", recipientUserId: "gm-a", requestId: null, payload: {}});
  await game.socket.receive("system.wildpath", intent, "player-b");
  assert.equal(received.length, 0);
  assert.equal(warnings.at(-1)?.[1]?.code, C.DISCLOSURE_SENDER_MISMATCH);
  await game.socket.receive("system.wildpath", intent, "player-a");
  assert.equal(received.length, 1);
  assert.equal(received[0].context.attestedSenderUserId, "player-a");
  await game.socket.receive("system.wildpath", {...intent, messageId: "legacy-relay"});
  assert.equal(received.length, 2, "a relay that supplies no attested sender still delivers");
});

/** Two clients with their own CONFIG.queries registries and a simulated server relay for User#query. */
function queryWorld({permissions={"gm-a": true, "player-a": true}, active={"gm-a": true, "player-a": true}, timeoutFor=null}={}) {
  const userList = [{id: "gm-a", isGM: true}, {id: "player-a", isGM: false}];
  const registries = {};
  const games = {};
  const queryCalls = [];
  const makeUser = (viewer, user) => ({
    id: user.id, isGM: user.isGM,
    get active() { return active[user.id] !== false; },
    isSelf: viewer === user.id,
    async query(name, data, options={}) {
      queryCalls.push({from: viewer, to: user.id, name, timeout: options.timeout});
      if ( !permissions[viewer] ) throw new Error("You do not have permission to query users");
      if ( timeoutFor === user.id ) throw new Error("operation has timed out");
      const handler = registries[user.id]?.[name];
      // The real recipient throws before acknowledging, so the sender only ever sees its timeout.
      if ( !handler ) throw new Error("operation has timed out");
      // socket.io serializes; the recipient sees the attested sender as a User document.
      return handler(JSON.parse(JSON.stringify(data)), {timeout: options.timeout, user: games[user.id].users.get(viewer)});
    }
  });
  for ( const user of userList ) {
    registries[user.id] = {};
    const view = new Map(userList.map(other => [other.id, makeUser(user.id, other)]));
    games[user.id] = {user: view.get(user.id), userId: user.id, users: view};
  }
  const adapters = Object.fromEntries(userList.map(user => [user.id,
    createFoundryV14UserQueryTransport({game: games[user.id], queries: registries[user.id], timeoutMs: 50, logger: {warn() {}}})]));
  return {registries, games, adapters, queryCalls, permissions, active};
}

test("User#query transport registers a prefixed CONFIG.queries handler and delivers only to the addressed user", async () => {
  const world = queryWorld();
  const received = {};
  for ( const [id, adapter] of Object.entries(world.adapters) ) {
    const registration = adapter.register((e, context) => { (received[id] ??= []).push({e, context}); return {ok: true}; });
    assert.equal(registration.ok, true);
    assert.equal(registration.queryName, "wildpath.resolutionEnvelope");
    assert.equal(typeof world.registries[id]["wildpath.resolutionEnvelope"], "function");
  }
  const sent = await world.adapters["gm-a"].send(envelope());
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.deepEqual(world.queryCalls, [{from: "gm-a", to: "player-a", name: "wildpath.resolutionEnvelope", timeout: 50}]);
  assert.equal(sent.receipt.receivedByUserId, "player-a");
  assert.equal(sent.receipt.messageId, envelope().messageId === sent.envelope.messageId ? sent.envelope.messageId : sent.envelope.messageId);
  await Promise.resolve();
  assert.equal(received["player-a"].length, 1);
  assert.equal(received["player-a"][0].context.attestedSenderUserId, "gm-a");
  assert.equal(received["player-a"][0].e.payload.request.payload.rollRequest.secretDC, 17);
  assert.equal(received["gm-a"], undefined);
});

test("User#query transport validates the attested sender and the addressed recipient, and fails closed on transport errors", async () => {
  const world = queryWorld();
  for ( const adapter of Object.values(world.adapters) ) adapter.register(() => ({ok: true}));

  const forged = await world.adapters["gm-a"].send(envelope({senderUserId: "player-a", recipientUserId: "player-a"}));
  assert.equal(forged.ok, false);
  assert.equal(forged.code, C.DISCLOSURE_SENDER_MISMATCH);

  const misaddressed = world.registries["player-a"]["wildpath.resolutionEnvelope"];
  await assert.rejects(() => misaddressed(envelope({recipientUserId: "gm-a"}), {user: world.games["player-a"].users.get("gm-a")}),
    new RegExp(C.DISCLOSURE_RECIPIENT_MISMATCH));
  await assert.rejects(() => misaddressed({...envelope(), disclosure: null}, {user: world.games["player-a"].users.get("gm-a")}),
    new RegExp(C.UNCLASSIFIED_DISCLOSURE));

  assert.equal((await world.adapters["gm-a"].send(envelope({recipientUserId: null, recipientPolicy: "all"}))).code,
    C.PRIVATE_PAYLOAD_REQUIRES_SINGLE_RECIPIENT);
  assert.equal((await world.adapters["gm-a"].send(envelope({recipientUserId: "nobody"}))).code, C.TARGETED_RECIPIENT_UNAVAILABLE);
  assert.equal((await world.adapters["gm-a"].send({...envelope(), disclosure: null})).code, C.UNCLASSIFIED_DISCLOSURE);

  world.active["player-a"] = false;
  assert.equal((await world.adapters["gm-a"].send(envelope())).code, C.TARGETED_RECIPIENT_UNAVAILABLE);
  world.active["player-a"] = true;

  world.permissions["player-a"] = false;
  const forbidden = await world.adapters["player-a"].send(envelope({senderUserId: "player-a", recipientUserId: "gm-a"}));
  assert.equal(forbidden.code, C.TARGETED_TRANSPORT_FORBIDDEN);
  world.permissions["player-a"] = true;

  delete world.registries["player-a"]["wildpath.resolutionEnvelope"];
  assert.equal((await world.adapters["gm-a"].send(envelope())).code, C.TARGETED_TRANSPORT_TIMEOUT,
    "a recipient whose handler is not registered cannot acknowledge; the sender times out");

  const slow = queryWorld({timeoutFor: "player-a"});
  for ( const adapter of Object.values(slow.adapters) ) adapter.register(() => ({ok: true}));
  assert.equal((await slow.adapters["gm-a"].send(envelope())).code, C.TARGETED_TRANSPORT_TIMEOUT);
});

test("User#query transport short-circuits self-addressed envelopes without touching the socket", async () => {
  const world = queryWorld();
  const received = [];
  world.adapters["gm-a"].register(e => { received.push(e); return {ok: true}; });
  const sent = await world.adapters["gm-a"].send(envelope({recipientUserId: "gm-a"}));
  assert.equal(sent.ok, true);
  assert.equal(sent.local, true);
  assert.equal(world.queryCalls.length, 0);
  assert.equal(received.length, 1);
});

test("self-addressed envelopes are delivered locally: Foundry never echoes a custom socket message to its sender", async () => {
  // A GM initiating its own action addresses the ACTION_INTENT to itself; the bus would drop it.
  const fixture = attackFixture();
  const hub = createTestResolutionTransportHub({users: users()});
  const gmTransport = hub.createEndpoint({userId: "gm-a"});
  hub.createEndpoint({userId: "player-a"}).register(() => ({ok: true}));
  const gm = createMultiplayerActionCoordinator({userId: "gm-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: gmTransport, actionIntentResolver: fixtureResolver(fixture),
    rollProviders: [createTestRollProvider({result: {natural: 18, total: 22}})]});
  gm.register();
  const declared = await gm.declareActionIntent({...INTENT, resolutionId: "resolution:gm-self", actorRef: fixture.actor.uuid,
    actionRef: fixture.action.uuid, targetRefs: [fixture.target.actorRef]});
  assert.equal(declared.ok, true, JSON.stringify(declared));
  assert.equal(gm.getRecord("resolution:gm-self")?.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(hub.localMessages.filter(m => m.messageType === M.ACTION_INTENT).length, 1);
  assert.equal(hub.broadcastMessages.filter(m => m.messageType === M.ACTION_INTENT).length, 0);
  assert.equal(hub.broadcastMessages.filter(m => m.messageType === M.RESOLUTION_RESULT).length, 1);
  assert.equal(hub.targetedMessages.length, 0, "the authority is the initiator: no participant projection is sent");

  // Production parity: detached local delivery does not wait for the handler to finish processing.
  const stubBus = {register: () => ({ok: true}), send: async () => ({ok: true})};
  const slowHandler = order => async () => { await new Promise(resolve => setTimeout(resolve, 5)); order.push("handled"); return {ok: true}; };
  const detachedOrder = [];
  const detached = createDisclosureRoutedTransport({userId: "u", broadcast: stubBus});
  detached.register(slowHandler(detachedOrder));
  const sent = await detached.send(envelope({senderUserId: "u", recipientUserId: "u"}));
  detachedOrder.push("returned");
  assert.equal(sent.local, true);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(detachedOrder, ["returned", "handled"]);
  const awaitedOrder = [];
  const awaited = createDisclosureRoutedTransport({userId: "u", broadcast: stubBus, localDelivery: "await"});
  awaited.register(slowHandler(awaitedOrder));
  await awaited.send(envelope({senderUserId: "u", recipientUserId: "u"}));
  awaitedOrder.push("returned");
  assert.deepEqual(awaitedOrder, ["handled", "returned"]);
});

/* -------------------------------------------- */
/*  Projections and minimization                 */
/* -------------------------------------------- */

function sampleResult() {
  return {
    resolutionId: "resolution:sample", status: "completed", code: null, ok: true, authorityUserId: "gm-a", initiatorUserId: "player-a",
    action: {id: "action:x", actionRef: "Item.x", label: "Strike", effectiveDefinition: {damage: []}},
    source: {actorId: "a", actorRef: "Actor.a", tokenId: "t", actorSystem: {resources: {health: {value: 9}}}},
    targets: [{id: "enemy", actorId: "e", actorRef: "Actor.e", defense: {value: 12}, defenses: {ac: {value: 12}}}],
    configuration: {id: "c", choices: {level: 3}, selectedPaymentOptionId: "p"},
    preview: {damage: [{total: 9}]},
    rolls: [
      {requestId: "r1", type: "attack", visibility: "public", rollResult: {natural: 18, total: 22, terms: [{faces: 20}]}},
      {requestId: "r2", type: "save", visibility: "gm-only", rollResult: {natural: 3, total: 5}},
      {requestId: "r3", type: "damage", visibility: "system", rollResult: {total: 9}}
    ],
    outcomes: {
      attack: {ok: true, results: [{target: {id: "enemy", actorRef: "Actor.e", defenses: {ac: {value: 12}}}, hit: true, critical: false,
        outcome: "hit", margin: 10, defense: {value: 12}, roll: {total: 22}}], hits: [], misses: []},
      save: {ok: true, results: [{target: {id: "enemy", actorRef: "Actor.e"}, success: false, critical: false, outcome: "failure",
        margin: -10, dc: {value: 15}}]},
      damage: {results: [{target: {id: "enemy"}, total: 9}]},
      healing: null, effects: {applied: []},
      payment: {resources: [{id: "economy.action", amount: 1}]},
      movement: {completedTransitionCount: 3, intendedTransitionCount: 3, committed: true}
    },
    committedMutations: [{documentRef: "Actor.e", updates: {"system.resources.health.value": 11}}],
    trace: [{stageId: "action.commit", status: "completed"}]
  };
}

test("result projection: BROADCAST_SAFE is an allow-list; PARTICIPANT_PRIVATE is the tagged full result", () => {
  const sample = sampleResult();
  const publicResult = projectResolutionResultForDisclosure(sample, D.BROADCAST_SAFE);
  assert.deepEqual(publicResult, {
    resolutionId: "resolution:sample", status: "completed", code: null, ok: true, authorityUserId: "gm-a", initiatorUserId: "player-a",
    action: {id: "action:x", actionRef: "Item.x", label: "Strike"},
    source: {actorId: "a", actorRef: "Actor.a", tokenId: "t"},
    targets: [{id: "enemy", actorId: "e", actorRef: "Actor.e"}],
    outcomes: {
      attack: {ok: true, results: [{target: {id: "enemy", actorRef: "Actor.e"}, hit: true, critical: false, outcome: "hit"}]},
      save: {ok: true, results: [{target: {id: "enemy", actorRef: "Actor.e"}, success: false, critical: false, outcome: "failure"}]},
      movement: {completedTransitionCount: 3, intendedTransitionCount: 3, committed: true}
    },
    rolls: [{requestId: "r1", type: "attack", visibility: "public", natural: 18, total: 22}],
    disclosure: D.BROADCAST_SAFE
  });
  const participant = projectResolutionResultForDisclosure(sample, D.PARTICIPANT_PRIVATE);
  assert.deepEqual(participant, {...sample, disclosure: D.PARTICIPANT_PRIVATE});
  assert.notStrictEqual(participant.outcomes, sample.outcomes, "projections are detached copies");
  assert.throws(() => projectResolutionResultForDisclosure(sample, null), /requires a disclosure classification/);
  assert.throws(() => projectResolutionResultForDisclosure(sample, "everyone"), /requires a disclosure classification/);
  assert.equal(isPlainSerializableData(publicResult), true);
});

test("chooser minimization: roll requests lose target defenses, DC and roll data; payload denylist keys are stripped", () => {
  const rollRequest = {
    id: "r1", resolutionId: "res", type: "attack", formula: "1d20+4", rollMode: "normal",
    definition: {dice: [{id: "d20", number: 1, faces: 20}]}, modifiers: [{id: "m", value: 4}], expected: {primaryDieFaces: 20},
    metadata: {rollKind: "attack"}, chooser: {kind: "specific", userId: "player-a"}, authority: {kind: "specific", userId: "player-a"},
    source: {actorId: "a", actorRef: "Actor.a", tokenId: "t", actorSystem: {resources: {}}},
    target: {id: "enemy", actorId: "e", actorRef: "Actor.e", uuid: "Actor.e", name: "Goblin", defense: {value: 12}, defenses: {ac: {value: 12}}},
    dc: {value: 15}, data: {mod: 4}
  };
  const projected = projectRollRequestForChooser(rollRequest);
  assert.equal(projected.dc, undefined);
  assert.equal(projected.data, undefined);
  assert.deepEqual(projected.target, {id: "enemy", actorId: "e", actorRef: "Actor.e", uuid: "Actor.e", name: "Goblin"});
  assert.deepEqual(projected.source, {actorId: "a", actorRef: "Actor.a", tokenId: "t"});
  assert.deepEqual(projected.definition, rollRequest.definition);
  assert.deepEqual(projected.modifiers, rollRequest.modifiers);
  assert.equal(projected.chooser.userId, "player-a");
  assert.equal(projectRollRequestForChooser(null), null);

  const sanitized = sanitizePendingRequestForTransport({
    id: "r1", resolutionId: "res", stageId: "attack", type: "roll", expectedResponseType: "roll-result",
    chooser: {kind: "specific", userId: "player-a"}, validation: {required: true},
    payload: {rollRequest, state: {secret: true}, dc: 15, defenses: {ac: 12}, targetSystems: {}, label: "Attack roll"}
  }, {expectedChooserUserId: "player-a"});
  assert.deepEqual(Object.keys(sanitized.payload).sort(), ["label", "rollRequest"]);
  assert.equal(sanitized.payload.rollRequest.target.defenses, undefined);
  assert.equal(sanitized.metadata.multiplayer.expectedChooserUserId, "player-a");

  const choice = sanitizePendingRequestForTransport({id: "c", resolutionId: "res", type: "reaction-choice",
    payload: {candidates: [{id: "cand"}], options: [{id: "use"}], state: {secret: true}}});
  assert.deepEqual(Object.keys(choice.payload).sort(), ["candidates", "options"]);
});

test("error diagnostics on the wire keep scalar values only", () => {
  const data = sanitizeResolutionErrorDataForTransport({
    code: "WRONG_USER", reason: "x".repeat(2000), ok: false, count: 2, nothing: null,
    state: {pendingRequests: [{payload: {rollRequest: {}}}]}, provided: {request: {target: {defense: 12}}}, list: [1, 2]
  });
  assert.deepEqual(Object.keys(data).sort(), ["code", "count", "nothing", "ok", "reason"]);
  assert.equal(data.reason.length, 1024);
  assert.deepEqual(sanitizeResolutionErrorDataForTransport(null), {});
  assert.deepEqual(sanitizeResolutionErrorDataForTransport([1, 2]), {});
});

test("authority errors cross the transport privately with scalar diagnostics while the local log keeps the full failure", async () => {
  const f = await pendingAttack();
  await f.transports.playerB.send(f.response("player-b"));
  const wire = f.hub.targetedMessages.find(m => m.envelope.messageType === M.RESOLUTION_ERROR && m.recipientUserId === "player-b");
  assert.ok(wire, "the rejection travels on the targeted transport");
  assert.equal(wire.envelope.disclosure, D.PARTICIPANT_PRIVATE);
  assert.equal(wire.envelope.payload.code, MULTIPLAYER_AUTHORITY_CODES.WRONG_USER);
  for ( const value of Object.values(wire.envelope.payload.data) ) assert.equal(typeof value === "object" && value !== null, false);
  const local = f.gm.errors.find(e => e.error?.code === MULTIPLAYER_AUTHORITY_CODES.WRONG_USER);
  assert.equal(local.error.data.ok, false);
  assert.equal(f.hub.broadcastMessages.some(m => m.messageType === M.RESOLUTION_ERROR), false);
});
