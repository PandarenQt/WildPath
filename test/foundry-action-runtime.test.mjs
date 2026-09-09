import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {ECONOMY_CAPABILITIES} from "../module/helpers/action-economy.mjs";
import {CREATURE_SIZES} from "../module/helpers/grid-footprints.mjs";
import {RESOLUTION_STATE_STATUS, validateResolutionStateSerializable} from "../module/helpers/resolution-state.mjs";
import {createActionResolutionState, planStagedActionResolution} from "../module/resolvers/action-pipeline-resolver.mjs";
import {withFoundryActorSystem} from "./fixtures/foundry-actor-system.mjs";
import {
  MULTIPLAYER_AUTHORITY_CODES,
  MULTIPLAYER_MESSAGE_TYPES,
  createResolutionSocketEnvelope
} from "../module/helpers/multiplayer-authority.mjs";
import {isPlainSerializableData} from "../module/helpers/multiplayer-authority.mjs";
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

function runtimeStatistic(domain, totalModifier) {
  return {
    totalModifier,
    trace: {domain, total: totalModifier, applied: [{id: `${domain}:test`, value: totalModifier}]}
  };
}

function fakeActor(id, {system, size=CREATURE_SIZES.MEDIUM, statistics={}}={}) {
  const actor = {
    id,
    uuid: `Actor.${id}`,
    name: id,
    type: "character",
    system: {...(system ?? {}), traits: {...(system?.traits ?? {}), size}},
    effects: [],
    token: null,
    tokens: [],
    getStatistic(domain) {
      return typeof statistics === "function" ? statistics(domain) : statistics[domain] ?? null;
    },
    getActiveTokens(linked, document) {
      return this.tokens;
    },
    toObject(source) {
      assert.equal(source, true);
      return {system: structuredClone(this.system)};
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

function targetActorSystem(value=20, max=20, {ac=12}={}) {
  return {
    defenses: {ac: {value: ac}},
    resources: {health: {value, max}},
    pools: []
  };
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

// Synthetic Actors deliberately differ from their world bases and expose non-plain DataModels.
function syntheticRuntimeFixture(t, definition=meleeStrikeDefinition()) {
  const scene = fakeScene(new FakeSquareGrid(), {id: "scene-models"});
  const sourceActor = withFoundryActorSystem(fakeActor("source-model", {system: actorSystem(),
    statistics: {"attack.weapon": runtimeStatistic("attack.weapon", 4)}}));
  const targetActor = withFoundryActorSystem(fakeActor("target-model", {system: targetActorSystem(20, 30, {ac: 14})}));
  const sourceBase = withFoundryActorSystem(fakeActor(sourceActor.id, {system: actorSystem()}));
  sourceBase.system.resources.action.value = 0;
  const targetBase = withFoundryActorSystem(fakeActor(targetActor.id, {system: targetActorSystem(99, 99)}));
  const sourceToken = fakeTokenDocument({id: "source-token", actor: sourceActor, scene, offset: {i: 0, j: 0}});
  const targetToken = fakeTokenDocument({id: "target-token", actor: targetActor, scene, offset: {i: 1, j: 0}});
  for (const [actor, token] of [[sourceActor, sourceToken], [targetActor, targetToken]]) {
    actor.uuid = `${token.uuid}.Actor.${actor.id}`;
    actor.isToken = true; actor.token = token; actor.tokens = [token];
  }
  scene.tokens = [sourceToken, targetToken];
  const action = actionItem(definition);
  action.uuid = `${sourceActor.uuid}.Item.${action.id}`;
  action.actor = sourceActor;
  sourceActor.items = new Map([[action.id, action]]);
  const refs = new Map([sourceActor, targetActor, action].map(d => [d.uuid, d]));
  refs.set("Actor.target-alias", targetActor);
  const previous = globalThis.fromUuid;
  globalThis.fromUuid = async ref => refs.get(ref) ?? null;
  t.after(() => { if (previous === undefined) delete globalThis.fromUuid; else globalThis.fromUuid = previous; });
  const game = fakeGame({actors: [sourceBase, targetBase], scenes: [scene]});
  const built = buildFoundryActionUseIntent({actor: sourceActor, action,
    game: {user: {targets: new Set([{document: targetToken}])}}});
  assert.equal(built.ok, true);
  return {scene, sourceActor, targetActor, sourceBase, targetBase, sourceToken, targetToken, action, game, intent: built.intent};
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

test("ordinary Foundry Action planning snapshots a live Actor DataModel before ResolutionState", async () => {
  const actor = withFoundryActorSystem(fakeActor("model-actor", {system: actorSystem()}));
  const action = actionItem({schemaVersion: 1, id: "action:model", label: "Model action",
    targeting: {type: "self", required: true}, costs: {allOf: [{capability: "action", amount: 1}]}});
  const resolved = await foundryActionIntentToStagedOptions({
    intent: {actorRef: actor.uuid, actionRef: action.uuid}, game: fakeGame({actors: [actor], items: [action]})
  });
  assert.equal(resolved.ok, true, JSON.stringify(resolved.reason));
  assert.equal(resolved.options.actor, actor, "Commit keeps the live document handle.");
  const planned = await planStagedActionResolution(resolved.options);
  assert.equal(planned.ok, true, JSON.stringify(planned.state.errors));
  assert.equal(planned.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT);
  assert.equal(Object.getPrototypeOf(planned.state.input.actorSystem), Object.prototype);
  assert.equal(validateResolutionStateSerializable(planned.state).ok, true);
  assert.deepEqual(actor.sourceSnapshotCalls, [true]);
  planned.state.input.actorSystem.resources.action.value = 0;
  assert.equal(actor.system.resources.action.value, 1);
});

test("ordinary Foundry Action rejects invalid serialized system data at the Foundry boundary", async () => {
  const actor = withFoundryActorSystem(fakeActor("invalid-model", {system: actorSystem()}));
  actor.toObject = () => ({system: actor.system});
  const action = actionItem({schemaVersion: 1, id: "action:invalid-model", label: "Model action"});
  const resolved = await foundryActionIntentToStagedOptions({
    intent: {actorRef: actor.uuid, actionRef: action.uuid}, game: fakeGame({actors: [actor], items: [action]})
  });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED);
  assert.match(resolved.reason, /Cannot snapshot Foundry Actor Actor.invalid-model system/);
  assert.equal(resolved.options, undefined);
  assert.equal(actor.system.resources.action.value, 1);
});

test("production Action intent conversion snapshots Actor combat statistics into plain staged inputs", async () => {
  const grid = new FakeSquareGrid();
  const scene = fakeScene(grid, {id: "scene-combat-stat"});
  const sourceActor = fakeActor("actor-source", {
    system: actorSystem(),
    statistics: {"attack.weapon": runtimeStatistic("attack.weapon", 4)}
  });
  const targetActor = fakeActor("actor-enemy", {
    system: targetActorSystem(20, 20, {ac: 14}),
    statistics: {"defense.ac": runtimeStatistic("defense.ac", 2)}
  });
  const sourceToken = fakeTokenDocument({id: "source", actor: sourceActor, scene, offset: {i: 0, j: 0}});
  const targetToken = fakeTokenDocument({id: "enemy", actor: targetActor, scene, offset: {i: 1, j: 0}});
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
  assert.equal(resolved.options.attack.modifierTotal, 4);
  assert.equal(resolved.options.attack.statistic.domain, "attack.weapon");
  assert.equal(resolved.options.targets[0].defenses.ac.value, 16);
  assert.equal(resolved.options.targets[0].defenses.ac.source.base, 14);
  assert.equal(resolved.options.targets[0].defenses.ac.source.modifier, 2);

  const candidate = resolved.options.targeting.candidates[0];
  assert.equal(candidate.defenses.ac.value, 16);
  assert.equal(candidate.actor.defenses.ac.value, 16);
  assert.equal(candidate.target.defenses.ac.value, 16);
  assert.deepEqual(JSON.parse(JSON.stringify(candidate.defenses.ac)), candidate.defenses.ac);
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

test("a player's Action use reaches the staged pipeline through the production multiplayer entry point with synthetic DataModels and TacticalGrid", async t => {
  const {sourceActor, targetActor, sourceBase, targetBase, targetToken, action, game} = syntheticRuntimeFixture(t);
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
    // spatial, targeting, attack, or defense options.
    actionIntentResolver: ({intent}) => foundryActionIntentToStagedOptions({intent, game, persistencePort})
  });
  const player = createMultiplayerActionCoordinator({
    userId: "player-a",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-a",
    transport: playerTransport,
    // Every real Foundry client (GM or player) registers the same digital roll provider; the
    // attacking player answers their own attack-roll pending request.
    rollProviders: [createTestRollProvider({result: {natural: 18, total: 22}})]
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
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors));
  assert.ok(record.options.context.spatial, "The production multiplayer entry point must reach a real TacticalGrid spatial context.");
  assert.equal(record.options.context.spatial.sourceFootprint.fields.length >= 1, true);
  assert.equal(record.options.attack.modifierTotal, 4);
  assert.equal(record.state.results.attackResolution.results[0].defense.value, 14);
  assert.equal(record.state.results.attackResolution.hits.length, 1);
  assert.equal(isPlainSerializableData(sourceActor.system), false);
  assert.equal(isPlainSerializableData(targetActor.system), false);
  assert.equal(isPlainSerializableData(record.state.input.actorSystem), true);
  assert.equal(isPlainSerializableData(record.state.input.durability.targetSystems), true);
  assert.equal(validateResolutionStateSerializable(record.state).ok, true);
  assert.equal(record.options.targetActors[targetActor.uuid], targetActor);
  assert.equal(record.state.input.durability.targetSystems[targetActor.uuid].resources.health.value, 20);
  assert.equal(record.state.completedStageIds.includes("action.damage"), true);
  assert.equal(record.state.completedStageIds.includes("action.commit"), true);
  assert.equal(record.state.results.actionResult.steps.findLast(s => s.data?.transaction).data.transaction.ok, true);

  assert.equal(targetActor.system.resources.health.value, 14);
  assert.equal(sourceActor.system.resources.action.value, 0);
  assert.equal(sourceBase.system.resources.action.value, 0);
  assert.equal(targetBase.system.resources.health.value, 99);
  assert.deepEqual(targetBase.sourceSnapshotCalls, []);
  assert.deepEqual(persistencePort.operations.filter(o => o.type === "updateActor").map(o => o.actorRef).sort(),
    [sourceActor.uuid, targetActor.uuid].sort());

  const result = player.getResult(declared.resolutionId);
  assert.equal(result.status, RESOLUTION_STATE_STATUS.COMPLETED);
});

test("target snapshots retain all live-document aliases, serialize once, and detach synthetic source data", async t => {
  const f = syntheticRuntimeFixture(t);
  const resolved = await foundryActionIntentToStagedOptions({intent: {...f.intent,
    targetRefs: [...f.intent.targetRefs, {actorRef: "Actor.target-alias"}]}, game: f.game});
  assert.equal(resolved.ok, true, resolved.reason);
  const systems = resolved.options.durability.targetSystems;
  assert.ok(systems, "Foundry reconstruction must provide explicit plain target systems");
  const snapshot = systems[f.targetActor.uuid];
  for (const key of [f.targetActor.uuid, f.targetActor.id, `actor:${f.targetActor.id}`, "Actor.target-alias"]) {
    assert.equal(resolved.options.targetActors[key], f.targetActor);
    assert.equal(systems[key], snapshot);
  }
  assert.deepEqual(f.targetActor.sourceSnapshotCalls, [true]);
  assert.deepEqual(f.targetBase.sourceSnapshotCalls, []);
  assert.equal(isPlainSerializableData(f.targetActor.system), false);
  assert.equal(isPlainSerializableData(systems), true);
  assert.equal(snapshot.resources.health.value, 20);
  assert.equal(validateResolutionStateSerializable(createActionResolutionState(resolved.options)).ok, true);
  snapshot.resources.health.value = 1;
  assert.equal(f.targetActor.system.resources.health.value, 20);
  assert.equal(f.targetBase.system.resources.health.value, 99);
});

test("invalid target source serialization rejects the Action intent with the synthetic target identity", async t => {
  const f = syntheticRuntimeFixture(t);
  f.targetActor.toObject = () => ({system: f.targetActor.system});
  const resolved = await foundryActionIntentToStagedOptions({intent: f.intent, game: f.game});
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED);
  assert.ok(resolved.reason.includes(f.targetActor.uuid));
  assert.match(resolved.reason, /target|Target/);
  assert.equal(resolved.options, undefined);
  assert.equal(f.sourceActor.system.resources.action.value, 1);
  assert.equal(f.targetActor.system.resources.health.value, 20);
});

test("production Healing uses the same plain synthetic target durability snapshots through both shared stages", async t => {
  const f = syntheticRuntimeFixture(t, {schemaVersion: 1, id: "healing:model", label: "Healing model",
    targeting: {type: "single", required: true, count: 1},
    healing: [{id: "fixed", expression: {type: "constant", value: 6}}]});
  const resolved = await foundryActionIntentToStagedOptions({intent: f.intent, game: f.game});
  assert.equal(resolved.ok, true, resolved.reason);
  const planned = await planStagedActionResolution(resolved.options);
  assert.equal(planned.ok, true, JSON.stringify(planned.state.errors));
  assert.equal(planned.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT);
  assert.equal(planned.state.completedStageIds.includes("action.damage"), true);
  assert.equal(planned.state.completedStageIds.includes("action.healing"), true);
  assert.equal(planned.state.results.healingDurabilityResolution.ok, true);
  assert.equal(planned.state.mutationPlans.some(p => p.type === "durabilityHealing"), true);
  assert.equal(validateResolutionStateSerializable(planned.state).ok, true);
  assert.equal(planned.state.input.durability.targetSystems[f.targetActor.uuid].resources.health.value, 20);
  assert.equal(f.targetActor.system.resources.health.value, 20, "Planning does not commit");
  assert.equal(f.targetBase.system.resources.health.value, 99);
});

test("production multiplayer entry point resolves Actor-derived defense misses without applying damage", async () => {
  const grid = new FakeSquareGrid();
  const scene = fakeScene(grid, {id: "scene-mp-miss"});
  const sourceActor = fakeActor("actor-source-miss", {
    system: actorSystem(),
    statistics: {"attack.weapon": runtimeStatistic("attack.weapon", 4)}
  });
  const targetActor = fakeActor("actor-enemy-miss", {system: targetActorSystem(20, 20, {ac: 18})});
  const sourceToken = fakeTokenDocument({id: "source-miss", actor: sourceActor, scene, offset: {i: 0, j: 0}});
  const targetToken = fakeTokenDocument({id: "enemy-miss", actor: targetActor, scene, offset: {i: 1, j: 0}});
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
  const gm = createMultiplayerActionCoordinator({
    userId: "gm-a",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}),
    actionIntentResolver: ({intent}) => foundryActionIntentToStagedOptions({intent, game, persistencePort})
  });
  const player = createMultiplayerActionCoordinator({
    userId: "player-a",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "player-a"}),
    rollProviders: [createTestRollProvider({result: {natural: 5, total: 9}})]
  });
  gm.register();
  player.register();

  const built = buildFoundryActionUseIntent({
    actor: sourceActor,
    action,
    game: {user: {targets: new Set([{document: targetToken}])}}
  });
  const declared = await player.declareActionIntent(built.intent);

  assert.equal(declared.ok, true);
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(record.state.results.attackResolution.results[0].defense.value, 18);
  assert.equal(record.state.results.attackResolution.misses.length, 1);
  assert.equal(targetActor.system.resources.health.value, 20);
  assert.equal(sourceActor.system.resources.action.value, 0);
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
