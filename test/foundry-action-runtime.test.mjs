import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {ECONOMY_CAPABILITIES} from "../module/helpers/action-economy.mjs";
import {CREATURE_SIZES} from "../module/helpers/grid-footprints.mjs";
import {RESOLUTION_STATE_STATUS} from "../module/helpers/resolution-state.mjs";
import {
  MULTIPLAYER_AUTHORITY_CODES,
  MULTIPLAYER_MESSAGE_TYPES,
  createResolutionSocketEnvelope
} from "../module/helpers/multiplayer-authority.mjs";
import {createTestResolutionTransportHub} from "../module/adapters/test-resolution-transport.mjs";
import {createTestDocumentPersistenceAdapter} from "../module/adapters/test-persistence-adapter.mjs";
import {createMultiplayerActionCoordinator} from "../module/resolvers/multiplayer-action-coordinator.mjs";
import {createTestRollProvider} from "../module/resolvers/roll-provider-resolver.mjs";
import {
  buildFoundryActionUseIntent,
  foundryActionIntentToStagedOptions
} from "../module/resolvers/foundry-multiplayer-runtime.mjs";
import {
  FOUNDRY_GRID_TYPES,
  createFoundryV14TacticalGridAdapter
} from "../module/adapters/foundry-v14-tactical-grid-adapter.mjs";

/*
 * These tests exercise the REAL production wiring between a Foundry Actor/Item Action-use and
 * the modern staged Action pipeline: buildFoundryActionUseIntent(), foundryActionIntentToStagedOptions(),
 * and createMultiplayerActionCoordinator() are called directly - the same functions Foundry's
 * runtime uses (see module/resolvers/foundry-multiplayer-runtime.mjs and module/documents/item.mjs).
 * Nothing here manually assembles staged-resolution options or hand-builds TacticalGrid footprints;
 * that would repeat the previous false-confidence problem the audit identified.
 */

/* -------------------------------------------- */
/*  Fixtures                                     */
/* -------------------------------------------- */

class FakeSquareGrid {
  constructor({distance=5, units="ft", size=50}={}) {
    this.type = FOUNDRY_GRID_TYPES.SQUARE;
    this.isSquare = true;
    this.isHexagonal = false;
    this.isGridless = false;
    this.distance = distance;
    this.units = units;
    this.size = size;
    this.sizeX = size;
    this.sizeY = size;
  }

  getOffset(point) {
    return {i: Math.floor(Number(point.x) / this.sizeX), j: Math.floor(Number(point.y) / this.sizeY)};
  }

  getCenterPoint(offset) {
    return {x: (Number(offset.i) + 0.5) * this.sizeX, y: (Number(offset.j) + 0.5) * this.sizeY};
  }

  getVertices(offset) {
    const x = Number(offset.i) * this.sizeX;
    const y = Number(offset.j) * this.sizeY;
    return [{x, y}, {x: x + this.sizeX, y}, {x: x + this.sizeX, y: y + this.sizeY}, {x, y: y + this.sizeY}];
  }

  getAdjacentOffsets(offset) {
    return [
      {i: offset.i, j: offset.j - 1},
      {i: offset.i + 1, j: offset.j},
      {i: offset.i, j: offset.j + 1},
      {i: offset.i - 1, j: offset.j}
    ];
  }
}

function fakeScene(grid, {id="scene-a", tokens=[]}={}) {
  return {
    id,
    uuid: `Scene.${id}`,
    name: "Test Scene",
    grid,
    dimensions: {
      distance: grid.distance,
      units: grid.units,
      size: grid.size,
      sceneX: 0,
      sceneY: 0,
      sceneWidth: 1000,
      sceneHeight: 1000,
      columns: 20,
      rows: 20
    },
    tokens
  };
}

function fakeTokenDocument({id, actor, scene, offset, disposition=-1}) {
  return {
    documentName: "Token",
    id,
    uuid: `Scene.${scene.id}.Token.${id}`,
    parent: scene,
    actor,
    x: Number(offset.i) * scene.grid.sizeX,
    y: Number(offset.j) * scene.grid.sizeY,
    disposition,
    getOccupiedGridSpaceOffsets() {
      return [offset];
    }
  };
}

function fakeActor(id, {system, size=CREATURE_SIZES.MEDIUM}={}) {
  const actor = {
    id,
    uuid: `Actor.${id}`,
    name: id,
    type: "character",
    system: {...system, traits: {...(system.traits ?? {}), size}},
    effects: [],
    token: null,
    tokens: [],
    getActiveTokens(linked, document) {
      return this.tokens;
    }
  };
  return actor;
}

function fakeGame({actors=[], items=[], scenes=[]}={}) {
  return {
    actors: new Map(actors.map(actor => [actor.id, actor])),
    items: new Map(items.map(item => [item.id, item])),
    scenes: new Map(scenes.map(scene => [scene.id, scene])),
    users: {activeGM: null}
  };
}

function actorSystem() {
  return {
    resources: {
      action: {value: 1, max: 1},
      bonus: {value: 1, max: 1},
      reaction: {value: 1, max: 1},
      movement: {value: 30, max: 30}
    },
    pools: []
  };
}

function targetActorSystem(value=20, max=20) {
  return {resources: {health: {value, max}}, pools: []};
}

function actionItem(definition) {
  return {id: definition.id, uuid: `Item.${definition.id}`, type: "action", name: definition.label, system: {definition}};
}

function meleeStrikeDefinition() {
  return {
    schemaVersion: 1,
    id: "action:runtime-melee-strike",
    label: "Runtime Melee Strike",
    costs: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]},
    range: {type: "reach", distance: {value: 5, unit: "ft"}},
    targeting: {type: "single", required: true, count: 1},
    attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
    damage: [{
      id: "weapon",
      expression: {type: "constant", value: 6},
      damageType: "slashing",
      provenance: "weapon-base"
    }]
  };
}

/* -------------------------------------------- */
/*  Canonical entry point                        */
/* -------------------------------------------- */

test("module/documents/item.mjs no longer authoritatively executes Action use through the legacy executeActionResolution resolver", () => {
  const source = readFileSync(fileURLToPath(new URL("../module/documents/item.mjs", import.meta.url)), "utf8");
  assert.equal(/executeActionResolution/.test(source), false,
    "Item#use() must not call the legacy executeActionResolution resolver - it bypasses the staged pipeline, reactions, prompts, and TacticalGrid context.");
  assert.equal(/executeActionIntent/.test(source), true,
    "Item#use() must declare its Action intent through the authoritative multiplayer runtime (game.wildpath.executeActionIntent).");
});

test("buildFoundryActionUseIntent constructs a stable, non-authoritative Action intent using game.user.targets", () => {
  const sourceActor = {id: "actor-a", uuid: "Actor.actor-a", token: null};
  const action = {id: "action-a", uuid: "Item.action-a"};
  const targetTokenDocument = {id: "tok-1", parent: {id: "scene-a"}, actor: {id: "actor-b", uuid: "Actor.actor-b"}};
  const game = {user: {targets: new Set([{document: targetTokenDocument}])}};

  const built = buildFoundryActionUseIntent({actor: sourceActor, action, game});

  assert.equal(built.ok, true);
  assert.equal(built.intent.actorRef, "Actor.actor-a");
  assert.equal(built.intent.actionRef, "Item.action-a");
  assert.equal(built.intent.targetRefs.length, 1);
  assert.equal(built.intent.targetRefs[0].actorRef, "Actor.actor-b");
  assert.equal(built.intent.targetRefs[0].tokenId, "tok-1");
  // Only stable references may be proposed by the client - no attack/damage/roll results.
  assert.equal(built.intent.attack, undefined);
  assert.equal(built.intent.damage, undefined);
  assert.equal(built.intent.mutationPlans, undefined);
});

test("buildFoundryActionUseIntent rejects when no actor or action is supplied", () => {
  const built = buildFoundryActionUseIntent({actor: null, action: null});
  assert.equal(built.ok, false);
  assert.equal(built.code, MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED);
});

/* -------------------------------------------- */
/*  TacticalGrid production wiring                */
/* -------------------------------------------- */

test("production Action intent conversion builds TacticalGrid spatial context from real Scene/Token data via the Foundry adapter", async () => {
  const grid = new FakeSquareGrid();
  const scene = fakeScene(grid, {id: "scene-attack"});
  const sourceActor = fakeActor("actor-source", {system: actorSystem()});
  const targetActor = fakeActor("actor-ogre", {system: targetActorSystem(30, 30), size: CREATURE_SIZES.LARGE});
  const sourceToken = fakeTokenDocument({id: "source", actor: sourceActor, scene, offset: {i: 0, j: 0}});
  const targetToken = fakeTokenDocument({id: "ogre", actor: targetActor, scene, offset: {i: 1, j: 0}});
  sourceActor.tokens = [sourceToken];
  targetActor.tokens = [targetToken];
  scene.tokens = [sourceToken, targetToken];

  const action = actionItem(meleeStrikeDefinition());
  const game = fakeGame({actors: [sourceActor, targetActor], items: [action], scenes: [scene]});

  const resolved = await foundryActionIntentToStagedOptions({
    intent: {
      actorRef: sourceActor.uuid,
      actionRef: action.uuid,
      targetRefs: [{actorRef: targetActor.uuid, tokenId: targetToken.id, sceneId: scene.id}]
    },
    game,
    persistencePort: createTestDocumentPersistenceAdapter()
  });

  assert.equal(resolved.ok, true);
  assert.ok(resolved.options.context.spatial, "Production intent conversion must build spatial context from real Scene/Token data.");
  assert.ok(resolved.options.context.spatial.sourceFootprint.fields.length >= 1);
  assert.equal(resolved.options.targeting.candidates.length, 1);

  const targetFootprint = resolved.options.targeting.candidates[0];
  // A Large target must occupy more than one TacticalGrid field - proves full-footprint semantics
  // reached production, not a single Token-center point (closes the previously identified gap).
  assert.ok(targetFootprint.footprint.fields.length > 1, "Expected the Large target to occupy more than one TacticalGrid field.");

  // Cross-check against directly invoking the same canonical adapter - proves the production
  // conversion path used the real adapter output rather than a parallel calculation.
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  const expected = adapter.tokenToTargetFootprint(targetToken, {disposition: "unknown"}).tokenFootprint;
  assert.deepEqual(targetFootprint.footprint.fields, expected.footprint.fields);
});

test("production Action intent conversion executes without spatial context when the Actor has no canvas Token", async () => {
  const sourceActor = fakeActor("actor-no-token", {system: actorSystem()});
  const action = actionItem(meleeStrikeDefinition());
  const game = fakeGame({actors: [sourceActor], items: [action]});

  const resolved = await foundryActionIntentToStagedOptions({
    intent: {actorRef: sourceActor.uuid, actionRef: action.uuid},
    game,
    persistencePort: createTestDocumentPersistenceAdapter()
  });

  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.options.context, {});
  assert.equal(resolved.options.targeting, null);
});

test("production Action intent conversion rejects ambiguous source Actors with more than one canvas Token", async () => {
  const grid = new FakeSquareGrid();
  const scene = fakeScene(grid, {id: "scene-ambiguous"});
  const sourceActor = fakeActor("actor-ambiguous", {system: actorSystem()});
  const tokenA = fakeTokenDocument({id: "a", actor: sourceActor, scene, offset: {i: 0, j: 0}});
  const tokenB = fakeTokenDocument({id: "b", actor: sourceActor, scene, offset: {i: 5, j: 5}});
  sourceActor.tokens = [tokenA, tokenB];
  const action = actionItem(meleeStrikeDefinition());
  const game = fakeGame({actors: [sourceActor], items: [action], scenes: [scene]});

  const resolved = await foundryActionIntentToStagedOptions({
    intent: {actorRef: sourceActor.uuid, actionRef: action.uuid},
    game,
    persistencePort: createTestDocumentPersistenceAdapter()
  });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED);
});

/* -------------------------------------------- */
/*  Multiplayer production entry                 */
/* -------------------------------------------- */

test("a player's Action use reaches the staged pipeline through the production multiplayer entry point with a real TacticalGrid footprint", async () => {
  const grid = new FakeSquareGrid();
  const scene = fakeScene(grid, {id: "scene-mp"});
  const sourceActor = fakeActor("actor-source", {system: actorSystem()});
  const targetActor = fakeActor("actor-enemy", {system: targetActorSystem(20, 20)});
  const sourceToken = fakeTokenDocument({id: "source", actor: sourceActor, scene, offset: {i: 0, j: 0}});
  const targetToken = fakeTokenDocument({id: "enemy", actor: targetActor, scene, offset: {i: 1, j: 0}});
  sourceActor.tokens = [sourceToken];
  targetActor.tokens = [targetToken];
  scene.tokens = [sourceToken, targetToken];
  const action = actionItem(meleeStrikeDefinition());
  const game = fakeGame({actors: [sourceActor, targetActor], items: [action], scenes: [scene]});
  const persistencePort = createTestDocumentPersistenceAdapter();

  const hub = createTestResolutionTransportHub({users: [
    {id: "gm-a", active: true, isGM: true, isActiveGM: true},
    {id: "player-a", active: true, isGM: false}
  ]});
  const gmTransport = hub.createEndpoint({userId: "gm-a"});
  const playerTransport = hub.createEndpoint({userId: "player-a"});

  const gm = createMultiplayerActionCoordinator({
    userId: "gm-a",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-a",
    transport: gmTransport,
    // The GM's authoritative resolver is the REAL production intent translator - no hand-built
    // spatial/targeting options. WildPath's Actor data model does not yet define an Armor Class /
    // defense field (a separate, pre-existing content-system gap - see completion report), so a
    // fixed defense is supplied here exactly as the existing multiplayer-authority.test.mjs fixture
    // resolver already does; everything spatial/targeting still comes from production conversion.
    actionIntentResolver: async ({intent}) => {
      const resolved = await foundryActionIntentToStagedOptions({intent, game, persistencePort});
      if ( resolved.ok ) resolved.options.attack = {defense: {value: 12}};
      return resolved;
    }
  });
  const player = createMultiplayerActionCoordinator({
    userId: "player-a",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-a",
    transport: playerTransport,
    // Every real Foundry client (GM or player) registers the same digital roll provider; the
    // attacking player answers their own attack-roll pending request.
    rollProviders: [createTestRollProvider({result: {natural: 18, total: 18}})]
  });
  gm.register();
  player.register();

  // The client-side intent is built the same way the real Item#use() would build it.
  const built = buildFoundryActionUseIntent({
    actor: sourceActor,
    action,
    game: {user: {targets: new Set([{document: targetToken}])}}
  });
  assert.equal(built.ok, true);

  const declared = await player.declareActionIntent(built.intent);
  assert.equal(declared.ok, true);
  assert.equal(declared.authorityUserId, "gm-a");

  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.ok(record.options.context.spatial, "The production multiplayer entry point must reach a real TacticalGrid spatial context.");
  assert.equal(record.options.context.spatial.sourceFootprint.fields.length >= 1, true);

  assert.equal(targetActor.system.resources.health.value < 20, true);
  assert.equal(sourceActor.system.resources.action.value, 0);

  const result = player.getResult(declared.resolutionId);
  assert.equal(result.status, RESOLUTION_STATE_STATUS.COMPLETED);
});

/* -------------------------------------------- */
/*  H-2: resolution result/error authority       */
/* -------------------------------------------- */

test("resolution result/error envelopes are rejected unless they come from the expected authoritative client", async () => {
  const hub = createTestResolutionTransportHub({users: [
    {id: "gm-a", active: true, isGM: true, isActiveGM: true},
    {id: "player-a", active: true, isGM: false},
    {id: "player-b", active: true, isGM: false}
  ]});
  const playerTransport = hub.createEndpoint({userId: "player-a"});
  const playerBTransport = hub.createEndpoint({userId: "player-b"});
  const gmTransport = hub.createEndpoint({userId: "gm-a"});

  const player = createMultiplayerActionCoordinator({
    userId: "player-a",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-a",
    transport: playerTransport
  });
  player.register();

  const declared = await player.declareActionIntent({
    intentId: "intent:h2",
    resolutionId: "resolution:h2",
    actorRef: "Actor.actor-a",
    actionRef: "Item.action-a"
  });
  assert.equal(declared.ok, true);
  assert.equal(declared.authorityUserId, "gm-a");

  // player-b is not the authoritative client for this resolution - a forged result must be rejected.
  await playerBTransport.send(createResolutionSocketEnvelope({
    messageType: MULTIPLAYER_MESSAGE_TYPES.RESOLUTION_RESULT,
    senderUserId: "player-b",
    recipientPolicy: "all",
    resolutionId: declared.resolutionId,
    payload: {result: {status: RESOLUTION_STATE_STATUS.COMPLETED, forged: true}}
  }));
  assert.equal(player.getResult(declared.resolutionId), null,
    "A resolution result from a non-authoritative sender must not be accepted.");

  // The real authority (gm-a) sends the genuine result - must be accepted.
  await gmTransport.send(createResolutionSocketEnvelope({
    messageType: MULTIPLAYER_MESSAGE_TYPES.RESOLUTION_RESULT,
    senderUserId: "gm-a",
    recipientPolicy: "all",
    resolutionId: declared.resolutionId,
    payload: {result: {status: RESOLUTION_STATE_STATUS.COMPLETED, forged: false}}
  }));
  assert.equal(player.getResult(declared.resolutionId)?.forged, false);

  // Same protection applies to RESOLUTION_ERROR envelopes.
  await playerBTransport.send(createResolutionSocketEnvelope({
    messageType: MULTIPLAYER_MESSAGE_TYPES.RESOLUTION_ERROR,
    senderUserId: "player-b",
    recipientUserId: "player-a",
    resolutionId: declared.resolutionId,
    payload: {code: "FORGED", reason: "forged error"}
  }));
  assert.equal(player.errors.some(entry => entry.error?.code === "FORGED"), false,
    "A forged resolution error from a non-authoritative sender must be rejected before being recorded.");
});
