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
import {isPlainSerializableData, sanitizeActionIntentPayload} from "../module/helpers/multiplayer-authority.mjs";
import {createTestResolutionTransportHub} from "../module/adapters/test-resolution-transport.mjs";
import {DISCLOSURE_CLASSIFICATIONS} from "../module/helpers/multiplayer-disclosure.mjs";
import {createTestDocumentPersistenceAdapter} from "../module/adapters/test-persistence-adapter.mjs";
import {createMultiplayerActionCoordinator} from "../module/resolvers/multiplayer-action-coordinator.mjs";
import {createTestRollProvider} from "../module/resolvers/roll-provider-resolver.mjs";
import {createTestPromptAdapter} from "../module/adapters/test-prompt-adapter.mjs";
import {createFoundryReactionProvider} from "../module/adapters/foundry-v14-reaction-provider.mjs";
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
    },
    testUserPermission(user, level) {
      return actor?.testUserPermission?.(user, level) === true;
    }
  };
}

function runtimeStatistic(domain, totalModifier) {
  return {
    totalModifier,
    trace: {domain, total: totalModifier, applied: [{id: `${domain}:test`, value: totalModifier}]}
  };
}

function fakeActor(id, {system, size=CREATURE_SIZES.MEDIUM, statistics={}, owners=["player-a"]}={}) {
  const actor = {
    id,
    uuid: `Actor.${id}`,
    name: id,
    type: "character",
    system: {...(system ?? {}), traits: {...(system?.traits ?? {}), size}},
    effects: [],
    items: new Map(),
    token: null,
    tokens: [],
    testUserPermission(user, level) {
      assert.equal(level, "OWNER");
      return user?.isGM === true || owners.includes(user?.id);
    },
    getStatistic(domains) {
      return [domains].flat().map(domain => (typeof statistics === "function" ? statistics(domain) : statistics[domain]))
        .find(Boolean) ?? null;
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

function fakeGame({actors=[], scenes=[]}={}) {
  const users = new Map([
    ["gm-a", {id: "gm-a", isGM: true}],
    ["player-a", {id: "player-a", isGM: false}],
    ["player-b", {id: "player-b", isGM: false}]
  ]);
  users.activeGM = null;
  return {
    actors: new Map(actors.map(actor => [actor.id, actor])),
    scenes: new Map(scenes.map(scene => [scene.id, scene])),
    users
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

/** Action Items are embedded on their Actor; the runtime rejects Items owned by another Actor. */
function actionItem(definition, actor=null) {
  const item = {id: definition.id, uuid: `Item.${definition.id}`, type: "action", name: definition.label, system: {definition}};
  if ( actor ) {
    item.actor = actor;
    actor.items.set(item.id, item);
  }
  return item;
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
function syntheticRuntimeFixture(t, definition=meleeStrikeDefinition(), {targetHealth=20}={}) {
  const scene = fakeScene(new FakeSquareGrid(), {id: "scene-models"});
  const sourceActor = withFoundryActorSystem(fakeActor("source-model", {system: actorSystem(),
    statistics: {"attack.weapon": runtimeStatistic("attack.weapon", 4)}}));
  const targetSource = targetActorSystem(targetHealth, 10, {ac: 14});
  Object.assign(targetSource.resources.health, {base: 30, bonus: 0});
  const targetActor = withFoundryActorSystem(fakeActor("target-model", {system: targetSource}));
  targetActor.system.resources.health.max = 30;
  targetActor.toObject = source => {
    assert.equal(source, true);
    targetActor.sourceSnapshotCalls.push(source);
    return {system: structuredClone(targetSource)};
  };
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
  return {scene, sourceActor, targetActor, targetSource, sourceBase, targetBase, sourceToken, targetToken, action, game, intent: built.intent};
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

  const action = actionItem(meleeStrikeDefinition(), sourceActor);
  const game = fakeGame({actors: [sourceActor, targetActor], scenes: [scene]});

  const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a",
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
    targeting: {type: "self", required: true}, costs: {allOf: [{capability: "action", amount: 1}]}}, actor);
  const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a",
    intent: {actorRef: actor.uuid, actionRef: action.uuid}, game: fakeGame({actors: [actor]})
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
  const action = actionItem({schemaVersion: 1, id: "action:invalid-model", label: "Model action"}, actor);
  const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a",
    intent: {actorRef: actor.uuid, actionRef: action.uuid}, game: fakeGame({actors: [actor]})
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

  const action = actionItem(meleeStrikeDefinition(), sourceActor);
  const game = fakeGame({actors: [sourceActor, targetActor], scenes: [scene]});

  const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a",
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
  const action = actionItem(meleeStrikeDefinition(), sourceActor);
  const game = fakeGame({actors: [sourceActor]});

  const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a",
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
  const action = actionItem(meleeStrikeDefinition(), sourceActor);
  const game = fakeGame({actors: [sourceActor], scenes: [scene]});

  const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a",
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
  const {sourceActor, targetActor, targetSource, sourceBase, targetBase, targetToken, action, game} =
    syntheticRuntimeFixture(t, undefined, {targetHealth: 30});
  assert.deepEqual(targetSource.resources.health, {base: 30, bonus: 0, value: 30, max: 10});
  assert.equal(targetActor.system.resources.health.max, 30);
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
    actionIntentResolver: ({intent, envelope}) => foundryActionIntentToStagedOptions({intent, senderUserId: envelope.senderUserId, game, persistencePort})
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
  assert.deepEqual(record.state.input.durability.targetSystems[targetActor.uuid].resources.health,
    {base: 30, bonus: 0, value: 30, max: 30});
  const damage = record.state.results.damageResolution.results[0];
  assert.equal(damage.total, 6);
  assert.equal(damage.byDamageType.slashing, 6);
  const durability = record.state.mutationPlans.find(p => p.type === "durabilityDamage").plan;
  assert.equal(durability.from, 30);
  assert.equal(durability.to, 24);
  assert.equal(durability.max, 30);
  assert.equal(durability.amount, 6);
  assert.equal(durability.appliedAmount, 6);
  assert.equal(durability.overflow, 0);
  const payment = record.state.mutationPlans.find(p => p.type === "resourcePayment").plan;
  assert.deepEqual(payment.updates, {"system.resources.action.value": 0});
  assert.equal(payment.payments[0].from, 1);
  assert.equal(payment.payments[0].to, 0);
  assert.equal(payment.payments[0].amount, 1);
  assert.equal(record.state.completedStageIds.includes("action.damage"), true);
  assert.equal(record.state.completedStageIds.includes("action.payment"), true);
  assert.equal(record.state.completedStageIds.includes("action.ready-to-commit"), true);
  assert.equal(record.state.completedStageIds.includes("action.commit"), true);
  assert.equal(record.state.completedStageIds.includes("action.finalization"), true);
  assert.equal(record.state.results.actionResult.steps.findLast(s => s.data?.transaction).data.transaction.ok, true);

  assert.equal(targetActor.system.resources.health.value, 24);
  assert.equal(targetSource.resources.health.max, 10, "The raw maximum stays intentionally stale");
  assert.equal(sourceActor.system.resources.action.value, 0);
  assert.equal(sourceBase.system.resources.action.value, 0);
  assert.equal(targetBase.system.resources.health.value, 99);
  assert.deepEqual(targetBase.sourceSnapshotCalls, []);
  assert.deepEqual(persistencePort.operations.filter(o => o.type === "updateActor").map(o => o.actorRef).sort(),
    [sourceActor.uuid, targetActor.uuid].sort());

  const result = player.getResult(declared.resolutionId);
  assert.equal(result.status, RESOLUTION_STATE_STATUS.COMPLETED);
});

test("a completed Action is published once with the initiator's message mode; a failing publisher changes nothing", async t => {
  const {sourceActor, targetActor, targetToken, action, game} = syntheticRuntimeFixture(t, undefined, {targetHealth: 30});
  const persistencePort = createTestDocumentPersistenceAdapter();
  const hub = createTestResolutionTransportHub({users: [
    {id: "gm-a", active: true, isGM: true, isActiveGM: true},
    {id: "player-a", active: true, isGM: false}
  ]});
  const published = [];
  const gm = createMultiplayerActionCoordinator({
    userId: "gm-a",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}),
    actionIntentResolver: ({intent, envelope}) => foundryActionIntentToStagedOptions({intent, senderUserId: envelope.senderUserId, game, persistencePort}),
    publishResult: entry => {
      published.push(entry);
      throw new Error("chat is unavailable");
    },
    logger: {warn: () => {}}
  });
  const player = createMultiplayerActionCoordinator({
    userId: "player-a",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "player-a"}),
    rollProviders: [createTestRollProvider({result: {natural: 18, total: 22}})]
  });
  gm.register();
  player.register();

  const built = buildFoundryActionUseIntent({actor: sourceActor, action, game: {
    user: {targets: new Set([{document: targetToken}])},
    settings: {get: (namespace, key) => (namespace === "core" && key === "messageMode" ? "ic" : undefined)}
  }});
  assert.equal(built.intent.messageMode, "ic");
  const declared = await player.declareActionIntent(built.intent);
  assert.equal(declared.ok, true);
  assert.equal(gm.getRecord(declared.resolutionId).state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(player.getResult(declared.resolutionId).status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(targetActor.system.resources.health.value, 24, "a failing publisher neither blocks nor undoes the commit");

  assert.equal(published.length, 1);
  const [entry] = published;
  assert.equal(entry.resolutionId, declared.resolutionId);
  assert.equal(entry.initiatorUserId, "player-a");
  assert.equal(entry.messageMode, "ic");
  assert.equal(entry.action?.id, action.id);
  assert.equal(entry.result.disclosure, "BROADCAST_SAFE");
  const attackRoll = entry.result.rolls.find(roll => roll.type === "attack-roll");
  assert.deepEqual([attackRoll?.visibility, attackRoll?.total], ["public", 22], "an in-character mode publishes the attack roll");
  assert.equal(entry.result.committedMutations, undefined, "the publisher sees only the public projection");
});

test("a save is routed to the Player who owns the target Token, not to the GM fallback", async t => {
  const saveDefinition = {schemaVersion: 1, id: "action:routed-save", label: "Routed save",
    costs: {allOf: [{capability: "action", amount: 1}]}, targeting: {type: "single", required: true, count: 1},
    range: {type: "reach", distance: {value: 5, unit: "ft"}}, save: {ability: "fortitude", dc: {value: 100}},
    damage: [{id: "venom", expression: {type: "constant", value: 4}, damageType: "poison",
      saveOutcomePolicy: {success: "half", failure: "full"}}]};
  const {sourceActor, targetActor, targetToken, action, game} = syntheticRuntimeFixture(t, saveDefinition, {targetHealth: 30});
  const hub = createTestResolutionTransportHub({users: [
    {id: "gm-a", active: true, isGM: true, isActiveGM: true},
    {id: "player-a", active: true, isGM: false}
  ]});
  const gm = createMultiplayerActionCoordinator({
    userId: "gm-a",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}),
    actionIntentResolver: ({intent, envelope}) => foundryActionIntentToStagedOptions({intent,
      senderUserId: envelope.senderUserId, game, persistencePort: createTestDocumentPersistenceAdapter()})
  });
  const player = createMultiplayerActionCoordinator({
    userId: "player-a",
    users: () => hub.userDirectory(),
    activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "player-a"}),
    rollProviders: [createTestRollProvider({result: {natural: 3, total: 3}})]
  });
  gm.register();
  player.register();
  // The GM acts; the target is a synthetic Token Actor owned by player-a, identified by its Token in the save.
  const built = buildFoundryActionUseIntent({actor: sourceActor, action, game: {user: {targets: new Set([{document: targetToken}])}}});
  const declared = await gm.declareActionIntent(built.intent);
  assert.equal(declared.ok, true, JSON.stringify(declared));
  const record = gm.getRecord(declared.resolutionId);
  const save = [...record.requestExpectations.values()].find(entry => entry.request?.payload?.rollRequest?.type === "saving-throw");
  assert.equal(save?.expectedUserId, "player-a", "the target's owner rolls the save");
  assert.equal(save?.chooser?.fallback, undefined, "no GM fallback");
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors));
  assert.equal(targetActor.system.resources.health.value, 26);
});

test("two unlinked Tokens of one base Actor each take their own hit, never each other's", async t => {
  const definition = {...meleeStrikeDefinition(), targeting: {type: "multiple", required: true, count: 2}};
  const {scene, sourceActor, targetActor, targetToken, action, game} = syntheticRuntimeFixture(t, definition, {targetHealth: 30});
  // A second goblin: the same base Actor id ("target-model"), its own Token, synthetic Actor and AC.
  const secondSource = targetActorSystem(30, 10, {ac: 14});
  Object.assign(secondSource.resources.health, {base: 30, bonus: 0});
  const second = withFoundryActorSystem(fakeActor(targetActor.id, {system: secondSource}));
  second.system.resources.health.max = 30;
  second.toObject = () => ({system: structuredClone(secondSource)});
  const secondToken = fakeTokenDocument({id: "second-token", actor: second, scene, offset: {i: 0, j: 1}});
  Object.assign(second, {uuid: `${secondToken.uuid}.Actor.${second.id}`, isToken: true, token: secondToken, tokens: [secondToken]});
  scene.tokens.push(secondToken);
  const resolveFirst = globalThis.fromUuid;
  globalThis.fromUuid = async ref => (ref === second.uuid ? second : resolveFirst(ref));
  const persistencePort = createTestDocumentPersistenceAdapter();
  const hub = createTestResolutionTransportHub({users: [
    {id: "gm-a", active: true, isGM: true, isActiveGM: true},
    {id: "player-a", active: true, isGM: false}
  ]});
  const gm = createMultiplayerActionCoordinator({userId: "gm-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}),
    actionIntentResolver: ({intent, envelope}) => foundryActionIntentToStagedOptions({intent,
      senderUserId: envelope.senderUserId, game, persistencePort})});
  const player = createMultiplayerActionCoordinator({userId: "player-a", users: () => hub.userDirectory(),
    activeGMUserId: "gm-a", transport: hub.createEndpoint({userId: "player-a"}),
    rollProviders: [createTestRollProvider({result: {natural: 18, total: 22}})]});
  gm.register();
  player.register();
  const built = buildFoundryActionUseIntent({actor: sourceActor, action,
    game: {user: {targets: new Set([{document: targetToken}, {document: secondToken}])}}});
  const declared = await player.declareActionIntent(built.intent);
  assert.equal(declared.ok, true, JSON.stringify(declared));
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors));
  assert.deepEqual(record.state.results.attackResolution.results.map(entry => entry.defense?.value).sort(), [14, 14],
    "each Token is attacked against its own defense");
  assert.equal(targetActor.system.resources.health.value, 24, "the first goblin takes its own 6");
  assert.equal(second.system.resources.health.value, 24, "the second goblin takes its own 6, not both hits");
});

/** A GM-controlled target whose Token answers "a hit on me" by striking back (authored Trigger RuleElement). */
function counterattackFixture(t, {decision="use", reactor="target"}={}) {
  const fixture = syntheticRuntimeFixture(t, undefined, {targetHealth: 30});
  const {scene, sourceActor, targetActor, targetSource, game} = fixture;
  scene.tokens.get = id => scene.tokens.find(token => token.id === id);
  sourceActor.system.defenses = {ac: {value: 10}};
  sourceActor.system.resources.health = {value: 20, max: 20};
  for ( const system of [targetSource, targetActor.system] ) system.resources.reaction = {value: 1, max: 1};
  targetActor.testUserPermission = user => user?.isGM === true;
  let holder = targetActor;
  if ( reactor === "bystander" ) {
    holder = withFoundryActorSystem(fakeActor("bystander", {system: {...targetActorSystem(), resources: {
      health: {value: 20, max: 20}, reaction: {value: 1, max: 1}}}, owners: []}));
    const token = fakeTokenDocument({id: "bystander-token", actor: holder, scene, offset: {i: 0, j: 1}});
    Object.assign(holder, {uuid: `${token.uuid}.Actor.bystander`, isToken: true, token, tokens: [token]});
    scene.tokens.push(token);
  }
  holder.items = [{id: "counter", type: "action", name: "Counterattack", system: {active: true,
    definition: {schemaVersion: 1, id: "action:counterattack", label: "Counterattack",
      costs: {allOf: [{capability: ECONOMY_CAPABILITIES.REACTION, amount: 1}]},
      range: {type: "reach", distance: {value: 5, unit: "ft"}}, targeting: {type: "single", required: true, count: 1},
      attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
      damage: [{id: "riposte", expression: {type: "constant", value: 3}, damageType: "slashing", provenance: "weapon-base"}]},
    ruleElements: [{schemaVersion: 1, id: "riposte", type: "Trigger", data: {kind: "reaction", event: "attack.hit",
      match: {phase: "interrupt", targetTokenId: "{self}"}}}]}}];
  // Reactions route to active controllers (the GM when none is connected), as Foundry's Users report them.
  for ( const user of game.users.values() ) user.active = user.id !== "player-b";
  game.user = game.users.get("gm-a");
  game.wildpath = {reactionServices: createFoundryReactionProvider()};
  const persistencePort = createTestDocumentPersistenceAdapter();
  const hub = createTestResolutionTransportHub({users: [
    {id: "gm-a", active: true, isGM: true, isActiveGM: true},
    {id: "player-a", active: true, isGM: false}
  ]});
  const offers = [];
  const posts = [];
  const gm = createMultiplayerActionCoordinator({userId: "gm-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}), publishResult: post => { posts.push(post); },
    promptPorts: [createTestPromptAdapter({id: "counterattack-choice", queue: [request => {
      offers.push(request);
      return decision === "use" ? {decision, candidateId: request.payload.candidates[0].id} : {decision};
    }]})],
    rollProviders: [createTestRollProvider({result: {natural: 15, total: 15}})],
    actionIntentResolver: ({intent, envelope}) => foundryActionIntentToStagedOptions({intent,
      senderUserId: envelope.senderUserId, game, persistencePort})});
  const player = createMultiplayerActionCoordinator({userId: "player-a", users: () => hub.userDirectory(),
    activeGMUserId: "gm-a", transport: hub.createEndpoint({userId: "player-a"}),
    rollProviders: [createTestRollProvider({result: {natural: 18, total: 22}})]});
  gm.register();
  player.register();
  return {...fixture, gm, player, offers, holder, posts};
}

for ( const decision of ["use", "decline"] ) test(`a counterattack Trigger on the target's Token is offered after the hit and ${decision === "use" ? "strikes the attacker" : "can be declined"}`, async t => {
  const {sourceActor, targetActor, gm, player, offers, posts, intent} = counterattackFixture(t, {decision});
  const declared = await player.declareActionIntent(intent);
  assert.equal(declared.ok, true, JSON.stringify(declared));
  const record = gm.getRecord(declared.resolutionId);
  assert.ok(record, JSON.stringify({gm: gm.errors, player: player.errors}).slice(0, 2000));
  const active = record.state.metadata?.activeChildResolution;
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify({errors: record.state.errors,
    pending: record.state.pendingRequests.map(r => [r.id, r.type, r.chooser]), child: active && {status: active.status,
      pending: active.pendingRequests?.map(r => [r.id, r.type, r.chooser, r.authority]), errors: active.errors},
    expectations: [...record.requestExpectations.values()].map(e => [e.request?.id, e.recipientUserIds ?? e.userIds]),
    gmErrors: gm.errors, playerErrors: player.errors}).slice(0, 3000));
  assert.equal(offers.length, 1, "the GM, who controls the target, was offered the reaction once");
  assert.equal(offers[0].payload.candidates.length, 1);
  assert.equal(targetActor.system.resources.health.value, 24, "the attack's own damage still lands");
  if ( decision === "use" ) {
    assert.equal(sourceActor.system.resources.health.value, 17, "the counterattack hit the attacker for 3");
    assert.equal(targetActor.system.resources.reaction.value, 0, "the target spent its reaction");
    assert.deepEqual(posts.map(post => [post.result.action?.name, post.initiatorUserId, post.messageMode]),
      [["Counterattack", "gm-a", null], ["Runtime Melee Strike", "player-a", null]],
      "the reaction posts its own public card, authored by its controller, before the Action's card");
    assert.equal(JSON.stringify(posts[0].result).includes('"defense"'), false, "the card sees only the public projection");
  } else {
    assert.equal(sourceActor.system.resources.health.value, 20);
    assert.equal(targetActor.system.resources.reaction.value, 1);
  }
});

test("a counterattack Trigger on a bystander's Token ignores an attack on someone else", async t => {
  const {targetActor, holder, gm, player, offers, intent} = counterattackFixture(t, {reactor: "bystander"});
  const declared = await player.declareActionIntent(intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.ok(record, JSON.stringify(gm.errors).slice(0, 2000));
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors));
  assert.equal(offers.length, 0, "{self} is the bystander's own Token, not the target's");
  assert.equal(holder.system.resources.reaction.value, 1);
  assert.equal(targetActor.system.resources.health.value, 24);
});

/** A 5-ft radial burst, 6 damage, cast from (0,0) at range 30 ft. A bystander stands at (5,0). */
function areaFixture(t, {range=30}={}) {
  const definition = {schemaVersion: 1, id: "action:runtime-burst", label: "Runtime Burst",
    costs: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]},
    range: {type: "ranged", normal: {value: range, unit: "ft"}}, targeting: {type: "area"},
    area: {shape: "radial", size: {value: 5, unit: "ft"}},
    damage: [{id: "burst", expression: {type: "constant", value: 6}, damageType: "fire", provenance: "spell-base"}]};
  const fixture = syntheticRuntimeFixture(t, definition, {targetHealth: 30});
  const {scene} = fixture;
  const far = withFoundryActorSystem(fakeActor("far-model", {system: targetActorSystem(30, 30)}));
  const farToken = fakeTokenDocument({id: "far-token", actor: far, scene, offset: {i: 5, j: 0}});
  Object.assign(far, {uuid: `${farToken.uuid}.Actor.far-model`, isToken: true, token: farToken, tokens: [farToken]});
  scene.tokens.push(farToken);
  scene.tokens.get = id => scene.tokens.find(token => token.id === id);
  const resolveFirst = globalThis.fromUuid;
  globalThis.fromUuid = async ref => (ref === far.uuid ? far : resolveFirst(ref));
  return {...fixture, far, farToken};
}

test("an area Action hits the creatures in its fields, recomputed by the authority from the placement clicks", async t => {
  const {sourceActor, targetActor, far, farToken, game, intent} = areaFixture(t);
  // The click lands in field (2,0): the burst covers (1..3, -1..1) - the target at (1,0), not the caster at
  // (0,0) or the bystander at (5,0). The forged client target list is ignored.
  const placed = {...intent, area: {points: [{x: 125, y: 25}]},
    targetRefs: [{actorRef: far.uuid, tokenId: farToken.id, sceneId: "scene-models"}]};
  const persistencePort = createTestDocumentPersistenceAdapter();
  const hub = createTestResolutionTransportHub({users: [
    {id: "gm-a", active: true, isGM: true, isActiveGM: true},
    {id: "player-a", active: true, isGM: false}
  ]});
  const gm = createMultiplayerActionCoordinator({userId: "gm-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}),
    actionIntentResolver: ({intent: sent, envelope}) => foundryActionIntentToStagedOptions({intent: sent,
      senderUserId: envelope.senderUserId, game, persistencePort})});
  const player = createMultiplayerActionCoordinator({userId: "player-a", users: () => hub.userDirectory(),
    activeGMUserId: "gm-a", transport: hub.createEndpoint({userId: "player-a"})});
  gm.register();
  player.register();
  const declared = await player.declareActionIntent(placed);
  assert.equal(declared.ok, true, JSON.stringify(declared));
  const record = gm.getRecord(declared.resolutionId);
  assert.ok(record, JSON.stringify(gm.errors).slice(0, 1500));
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors));
  assert.deepEqual(record.options.targets.map(target => target.tokenId), ["target-token"]);
  assert.equal(targetActor.system.resources.health.value, 24);
  assert.equal(far.system.resources.health.value, 30, "the bystander outside the burst is untouched");
  assert.equal(sourceActor.system.resources.action.value, 0);
});

test("an area placed out of range, or not placed at all, is refused by the authority", async t => {
  const {game, intent} = areaFixture(t, {range: 5});
  const far = await foundryActionIntentToStagedOptions({intent: {...intent, area: {points: [{x: 125, y: 25}]}},
    senderUserId: "player-a", game});
  assert.deepEqual([far.ok, far.reason], [false, "That point is out of range."]);
  const unplaced = await foundryActionIntentToStagedOptions({intent, senderUserId: "player-a", game});
  assert.deepEqual([unplaced.ok, unplaced.reason], [false, "Choose where the area starts."]);
  assert.deepEqual(sanitizeActionIntentPayload({area: {points: [{x: 1, y: 2}, {x: "3", y: 4}, {x: 5, y: 6}],
    footprint: "forged"}}).area, {points: [{x: 1, y: 2}, {x: 3, y: 4}]}, "at most two finite points travel");
  assert.deepEqual(sanitizeActionIntentPayload({area: {points: [{x: "SECRET", y: 1}]}}).area, {points: []});
});

test("Action targets carry the Token's public name, never a hidden Token's or the base Actor's", async t => {
  const {targetActor, targetToken, game, intent} = syntheticRuntimeFixture(t, undefined, {targetHealth: 30});
  targetActor.name = "Vampire Lord";
  targetToken.name = "Masked Figure";
  const named = await foundryActionIntentToStagedOptions({intent, senderUserId: "player-a", game});
  assert.equal(named.options.targets[0].name, "Masked Figure");
  targetToken.hidden = true;
  const hidden = await foundryActionIntentToStagedOptions({intent, senderUserId: "player-a", game});
  assert.equal(hidden.options.targets[0].name, null);
});

test("target snapshots retain all live-document aliases, serialize once, and detach synthetic source data", async t => {
  const f = syntheticRuntimeFixture(t);
  const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a", intent: {...f.intent,
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
  assert.equal(snapshot.resources.health.max, 30);
  assert.equal(f.targetSource.resources.health.max, 10);
  assert.equal(validateResolutionStateSerializable(createActionResolutionState(resolved.options)).ok, true);
  snapshot.resources.health.value = 1;
  assert.equal(f.targetActor.system.resources.health.value, 20);
  assert.equal(f.targetBase.system.resources.health.value, 99);
});

test("the authority only resolves Actions sent by an owner of the acting Actor, using that Actor's own Item", async t => {
  const f = syntheticRuntimeFixture(t);
  // A player who does not own the acting Actor is refused before any rules input is built.
  const stranger = await foundryActionIntentToStagedOptions({intent: f.intent, senderUserId: "player-b", game: f.game});
  assert.equal(stranger.ok, false);
  assert.equal(stranger.code, MULTIPLAYER_AUTHORITY_CODES.WRONG_USER);
  assert.equal(stranger.options, undefined);
  // An unattested or missing sender is never treated as an owner.
  const anonymous = await foundryActionIntentToStagedOptions({intent: f.intent, game: f.game});
  assert.equal(anonymous.code, MULTIPLAYER_AUTHORITY_CODES.WRONG_USER);

  // An Item that belongs to a different Actor is refused even when the sender owns the acting Actor.
  const otherActor = fakeActor("other-actor", {system: actorSystem()});
  const foreign = actionItem({...meleeStrikeDefinition(), id: "action:foreign"}, otherActor);
  foreign.uuid = `${otherActor.uuid}.Item.${foreign.id}`;
  const previous = globalThis.fromUuid;
  globalThis.fromUuid = async ref => ref === foreign.uuid ? foreign : previous(ref);
  const borrowed = await foundryActionIntentToStagedOptions({intent: {...f.intent, actionRef: foreign.uuid},
    senderUserId: "player-a", game: f.game});
  globalThis.fromUuid = previous;
  assert.equal(borrowed.ok, false);
  assert.equal(borrowed.code, MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED);
  assert.match(borrowed.reason, /does not belong to the acting Actor/);

  // The GM may act through any Actor.
  const gm = await foundryActionIntentToStagedOptions({intent: f.intent, senderUserId: "gm-a", game: f.game});
  assert.equal(gm.ok, true, JSON.stringify(gm.reason));
});

test("invalid target source serialization rejects the Action intent with the synthetic target identity", async t => {
  const f = syntheticRuntimeFixture(t);
  f.targetActor.toObject = () => ({system: f.targetActor.system});
  const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a", intent: f.intent, game: f.game});
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
  const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a", intent: f.intent, game: f.game});
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
  assert.equal(planned.state.input.durability.targetSystems[f.targetActor.uuid].resources.health.max, 30);
  assert.equal(f.targetSource.resources.health.max, 10);
  const plan = planned.state.mutationPlans.find(p => p.type === "durabilityHealing").plan;
  assert.equal(plan.from, 20);
  assert.equal(plan.to, 26);
  assert.equal(plan.max, 30);
  assert.equal(plan.appliedAmount, 6);
  assert.equal(plan.overheal, 0);
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
  const action = actionItem(meleeStrikeDefinition(), sourceActor);
  const game = fakeGame({actors: [sourceActor, targetActor], scenes: [scene]});
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
    actionIntentResolver: ({intent, envelope}) => foundryActionIntentToStagedOptions({intent, senderUserId: envelope.senderUserId, game, persistencePort})
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
    disclosure: DISCLOSURE_CLASSIFICATIONS.BROADCAST_SAFE,
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
    disclosure: DISCLOSURE_CLASSIFICATIONS.BROADCAST_SAFE,
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
