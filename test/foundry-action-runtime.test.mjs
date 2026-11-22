import {test} from "node:test";
import assert from "node:assert/strict";
import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {ECONOMY_CAPABILITIES} from "../module/helpers/action-economy.mjs";
import {CREATURE_SIZES} from "../module/helpers/grid-footprints.mjs";
import {RESOLUTION_REQUEST_TYPES, RESOLUTION_STATE_STATUS, validateResolutionStateSerializable} from "../module/helpers/resolution-state.mjs";
import {createActionResolutionState, planStagedActionResolution, resumeStagedActionResolution} from "../module/resolvers/action-pipeline-resolver.mjs";
import {withFoundryActorSystem} from "./fixtures/foundry-actor-system.mjs";
import {portentHolders, portentPayment} from "../module/adapters/foundry-v14-portent.mjs";
import {
  MULTIPLAYER_AUTHORITY_CODES,
  MULTIPLAYER_MESSAGE_TYPES,
  createResolutionSocketEnvelope
} from "../module/helpers/multiplayer-authority.mjs";
import {isPlainSerializableData, projectPendingRequestPayloadForChooser, sanitizeActionIntentPayload} from "../module/helpers/multiplayer-authority.mjs";
import {createTestResolutionTransportHub} from "../module/adapters/test-resolution-transport.mjs";
import {DISCLOSURE_CLASSIFICATIONS} from "../module/helpers/multiplayer-disclosure.mjs";
import {createTestDocumentPersistenceAdapter} from "../module/adapters/test-persistence-adapter.mjs";
import {createMultiplayerActionCoordinator} from "../module/resolvers/multiplayer-action-coordinator.mjs";
import {createPhysicalDiceProvider, createTestRollProvider} from "../module/resolvers/roll-provider-resolver.mjs";
import {createTestPromptAdapter} from "../module/adapters/test-prompt-adapter.mjs";
import {CHOICE_COORDINATOR_CODES, PROMPT_PORT_OUTCOMES} from "../module/resolvers/choice-coordinator.mjs";
import {createFoundryReactionProvider} from "../module/adapters/foundry-v14-reaction-provider.mjs";
import {areaCovers, areaExpired, areaFields, createFoundryPersistentAreas, DERIVED_AREA_COLORS, OBJECT_IMG, objectActorData,
  sectionTokenPlacement, spellAreasWithin} from "../module/adapters/foundry-v14-persistent-areas.mjs";
import {automationTriggers, createFoundryAutomationDispatcher, RELEASE_QUERY, storedCastOf, storedReleaseLabel}
  from "../module/adapters/foundry-v14-automation-dispatcher.mjs";
import {createFoundryDying} from "../module/adapters/foundry-v14-dying.mjs";
import {createFoundryRemoved} from "../module/adapters/foundry-v14-removed.mjs";
import {inspectResolution} from "../module/helpers/resolution-inspection.mjs";
import {ACTION_DEFINITION_CODES, validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {convertItem} from "../scripts/content/dnd5e-to-wildpath.mjs";
import {damageProfileFromRuleElements, OBJECT_RULE, rollModesFromRuleElements, rollOutcomesFromRuleElements, unaffectingRule} from "../module/helpers/rule-elements.mjs";
import {WILDPATH} from "../module/config.mjs";
import {rollFormulaForRequest} from "../module/helpers/rolls.mjs";
import {
  actionCompletedEvent,
  actionCover,
  buildFoundryActionUseIntent,
  conditionsFrom,
  counteredCastEvent,
  foundryActionIntentToStagedOptions,
  foundryActionOdds,
  recordAttackHostility,
  recordCastLevel,
  reportActionCompleted,
  actionCompletedFollowUps,
  reportCountered,
  usedOptionActions,
  monsterRerollPayers
} from "../module/resolvers/foundry-multiplayer-runtime.mjs";
import {
  FOUNDRY_GRID_TYPES,
  createFoundryV14TacticalGridAdapter
} from "../module/adapters/foundry-v14-tactical-grid-adapter.mjs";

// The real Actor class, for what the authority asks of its Actor (its rules' Forbids). Only the globals importing it
// needs, restored once it is loaded so the rest of this file runs without them.
const {default: WildPathActor} = await (async () => {
  const saved = {Actor: globalThis.Actor, foundry: globalThis.foundry};
  globalThis.Actor = class {};
  globalThis.foundry = {data: {fields: {}, ActiveEffectTypeDataModel: class {}}, utils: {isEmpty: value => !Object.keys(value).length}};
  try { return await import("../module/documents/actor.mjs"); }
  finally { Object.assign(globalThis, saved); }
})();

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
    // No Token vision: all of it is lit (lightAt).
    tokenVision: false,
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
      return linked ? this.tokens.filter(token => token.actorLink !== false) : this.tokens;
    },
    forbiddingRule: WildPathActor.prototype.forbiddingRule,
    unaffectingRule: WildPathActor.prototype.unaffectingRule,
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

test("a linked Actor's Action names its Token on its user's canvas, so the authority viewing another Scene still finds it", async () => {
  const scene = fakeScene(new FakeSquareGrid(), {id: "scene-player"});
  const sourceActor = fakeActor("linked-hero", {system: actorSystem()});
  const targetActor = fakeActor("linked-ogre", {system: targetActorSystem(30, 30)});
  const sourceToken = fakeTokenDocument({id: "hero", actor: sourceActor, scene, offset: {i: 0, j: 0}});
  const targetToken = fakeTokenDocument({id: "ogre", actor: targetActor, scene, offset: {i: 1, j: 0}});
  scene.tokens = [sourceToken, targetToken];
  const action = actionItem(meleeStrikeDefinition(), sourceActor);
  // The player's canvas shows the hero's Scene.
  sourceActor.tokens = [sourceToken];
  const built = buildFoundryActionUseIntent({actor: sourceActor, action, game: {user: {targets: new Set([{document: targetToken}])}}});
  assert.deepEqual(built.intent.source, {tokenId: "hero", tokenRef: sourceToken.uuid, sceneId: "scene-player"});
  // The GM's canvas shows another Scene: getActiveTokens finds none of the hero's there.
  sourceActor.tokens = [];
  const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a", intent: built.intent,
    game: fakeGame({actors: [sourceActor, targetActor], scenes: [scene]}), persistencePort: createTestDocumentPersistenceAdapter()});
  assert.equal(resolved.ok, true, resolved.reason);
  assert.equal(resolved.options.context.spatial?.sourceFootprint?.fields.length, 1, "measured from the hero's own Token");
  // Several of its Tokens on the user's canvas: none is guessed, and the authority asks for one as before.
  sourceActor.tokens = [sourceToken, fakeTokenDocument({id: "hero-2", actor: sourceActor, scene, offset: {i: 3, j: 0}})];
  assert.equal(buildFoundryActionUseIntent({actor: sourceActor, action, game: {}}).intent.source.tokenId, null);
  // An unlinked Token of the same base Actor is a separate creature, never its source.
  sourceActor.tokens = [Object.assign(fakeTokenDocument({id: "copy", actor: sourceActor, scene, offset: {i: 3, j: 0}}), {actorLink: false})];
  assert.equal(buildFoundryActionUseIntent({actor: sourceActor, action, game: {}}).intent.source.tokenId, null);
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

/**
 * A fake creature under these conditions: its roll modes come from their real 2024 RollMode RuleElements. An array
 * instead of a condition id is the creature's own rules (a trait).
 */
function withConditions(actor, ...ids) {
  const owners = ids.map(id => ({ruleElements: Array.isArray(id) ? id : WILDPATH.CONDITIONS[id].ruleElements}));
  // As the real Actor does, predicates see the creature's conditions.
  const conditions = ids.filter(id => typeof id === "string");
  actor.getRollModes = (domains, {context={}}={}) => rollModesFromRuleElements(owners, {domains, context: {conditions, ...context}});
  actor.getRollOutcomes = (domains, {context={}}={}) => rollOutcomesFromRuleElements(owners, {domains, context: {conditions, ...context}});
  return actor;
}

/** The first roll request an Action asks for, with the target `offset` fields away from the attacker. */
async function firstRollRequest(definition, options={}) {
  return (await plannedWithConditions(definition, options)).state.rollRequests[0];
}

/** The planned resolution of an Action between two conditioned creatures (`attackRoll` answers the attack). */
async function plannedWithConditions(definition, {attacker=[], target=[], offset={i: 1, j: 0}, targetStatistics={}, attackRoll=null,
  allies=[], prepareTarget=null, prepareSource=null, extraActors=[], saveRoll=null, sunlit=false, actionFlags=null}={}) {
  const scene = fakeScene(new FakeSquareGrid(), {id: "scene-roll-modes"});
  if ( sunlit ) scene.flags = {wildpath: {sunlight: true}};
  const sourceActor = withConditions(fakeActor("roll-source", {system: actorSystem(),
    statistics: {"attack.weapon": runtimeStatistic("attack.weapon", 4)}}), ...attacker);
  const targetActor = withConditions(fakeActor("roll-target", {system: targetActorSystem(20, 20, {ac: 14}),
    statistics: targetStatistics}), ...target);
  prepareTarget?.(targetActor);
  prepareSource?.(sourceActor);
  const sourceToken = fakeTokenDocument({id: "source", actor: sourceActor, scene, offset: {i: 0, j: 0}});
  const targetToken = fakeTokenDocument({id: "enemy", actor: targetActor, scene, offset});
  sourceActor.tokens = [sourceToken];
  targetActor.tokens = [targetToken];
  // The attacker's allies (its disposition), each at an offset and under its own conditions.
  const allyTokens = allies.map(({offset: at, conditions=[]}, index) => fakeTokenDocument({id: `ally-${index}`, scene, offset: at,
    actor: Object.assign(fakeActor(`roll-ally-${index}`, {system: actorSystem()}), {statuses: new Set(conditions)})}));
  // Others at the table: each has a Token on the Scene, out of the way.
  const extraTokens = extraActors.map((actor, index) => fakeTokenDocument({id: `extra-${index}`, actor, scene, offset: {i: 6 + index, j: 6}}));
  for ( const [index, actor] of extraActors.entries() ) if ( !actor.tokens?.length ) actor.tokens = [extraTokens[index]];
  scene.tokens = [sourceToken, targetToken, ...allyTokens, ...extraTokens];
  scene.tokens.get = id => scene.tokens.find(token => token.id === id);
  const action = actionItem(definition, sourceActor);
  if ( actionFlags ) action.flags = actionFlags;
  const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a", game: fakeGame({actors: [sourceActor, targetActor,
    ...extraActors], scenes: [scene]}), intent: {actorRef: sourceActor.uuid, actionRef: action.uuid,
    targetRefs: [{actorRef: targetActor.uuid, tokenId: targetToken.id, sceneId: scene.id}]}});
  assert.equal(resolved.ok, true, resolved.reason);
  if ( attackRoll ) resolved.options.attack = {...resolved.options.attack, roll: attackRoll};
  if ( saveRoll ) resolved.options.save = {...resolved.options.save, roll: saveRoll};
  // Who its commit writes to besides its source (a paying ally).
  return {...planStagedActionResolution(resolved.options), targetActors: resolved.options.targetActors};
}

test("an Action's source carries its Token's name for the events it makes (a reaction prompt), never a hidden Token's", async () => {
  for ( const hidden of [false, true] ) {
    const scene = fakeScene(new FakeSquareGrid(), {id: "scene-named"});
    const sourceActor = fakeActor("named-source", {system: actorSystem(), statistics: {"attack.weapon": runtimeStatistic("attack.weapon", 4)}});
    const targetActor = fakeActor("named-target", {system: targetActorSystem(20, 20, {ac: 14})});
    const sourceToken = Object.assign(fakeTokenDocument({id: "source", actor: sourceActor, scene, offset: {i: 0, j: 0}}),
      {name: "QA8 Archer", hidden});
    const targetToken = Object.assign(fakeTokenDocument({id: "enemy", actor: targetActor, scene, offset: {i: 1, j: 0}}), {name: "QA8 Ward"});
    sourceActor.tokens = [sourceToken];
    targetActor.tokens = [targetToken];
    scene.tokens = [sourceToken, targetToken];
    const action = actionItem(meleeStrikeDefinition(), sourceActor);
    const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a", game: fakeGame({actors: [sourceActor, targetActor],
      scenes: [scene]}), intent: {actorRef: sourceActor.uuid, actionRef: action.uuid,
      targetRefs: [{actorRef: targetActor.uuid, tokenId: targetToken.id, sceneId: scene.id}]}});
    assert.equal(resolved.ok, true, resolved.reason);
    assert.equal(resolved.options.source.name, hidden ? undefined : "QA8 Archer");
  }
});

test("2024 advantage: an attack on a Prone creature within 5 ft has advantage, cancelled by a Poisoned attacker", async () => {
  assert.equal((await firstRollRequest(meleeStrikeDefinition())).rollMode, "normal");
  const prone = await firstRollRequest(meleeStrikeDefinition(), {target: ["prone"]});
  assert.equal(prone.rollMode, "advantage");
  assert.equal((await firstRollRequest(meleeStrikeDefinition(), {attacker: ["poisoned"], target: ["prone"]})).rollMode, "normal");
  const ranged = {...meleeStrikeDefinition(), id: "action:runtime-shot", attack: {type: "ranged", statistic: "weapon", defenseKey: "ac"},
    range: {type: "ranged", normal: {value: 60, unit: "ft"}}};
  assert.equal((await firstRollRequest(ranged, {target: ["prone"], offset: {i: 3, j: 0}})).rollMode, "disadvantage",
    "a Prone creature farther than 5 ft is harder to hit");
});

test("rays (repeatable attacks): each creature's roll-mode sources by its Token, one an attack uses up marked so one ray has it", async () => {
  // Guiding Bolt's Advantage on the next attack against its creature (an effect that ends when it is attacked).
  const guided = target => {
    target.effects = [{id: "guided", name: "Guided", flags: {wildpath: {conditionEffect: {definition: {endsWhen: "attacked"}}}}}];
    target.getRollModes = domains => (domains.includes("attacked")
      ? [{id: "guided", mode: "advantage", source: {type: "ruleElement", parent: {type: "effect", id: "guided"}}}] : []);
  };
  const rays = {...meleeStrikeDefinition(), id: "action:runtime-rays", targeting: {type: "multiple", required: true, count: 3,
    repeatable: true, refinementPolicy: {minSelections: 1}}};
  const planned = await plannedWithConditions(rays, {prepareTarget: guided});
  assert.deepEqual(planned.state.input.attack.rollModeSourcesByTarget, {enemy: [{mode: "advantage", once: "attacked"}]});
  assert.deepEqual(planned.state.pendingRequests.map(entry => entry.payload.rollRequest.rollMode), ["advantage", "normal", "normal"],
    "the first ray at it has the Advantage, the other two not");
  // An attack with one roll needs none (its `rollMode` is the creature's).
  const single = await plannedWithConditions(meleeStrikeDefinition(), {prepareTarget: guided});
  assert.equal(single.state.input.attack.rollModeSourcesByTarget, undefined);
});

const fortitudeBlast = ability => ({schemaVersion: 1, id: `action:runtime-${ability}-blast`, label: "Blast", costs: {allOf: []},
  targeting: {type: "single", required: true, count: 1}, range: {type: "reach", distance: {value: 5, unit: "ft"}},
  save: {ability, dc: {value: 13}},
  damage: [{id: "blast", expression: {type: "constant", value: 4}, damageType: "force", provenance: "spell-base"}]});

test("a save or attack with nothing converted on it still rolls, and is ready to commit with nothing to apply", async () => {
  const {damage: _damage, ...command} = fortitudeBlast("presence");
  const saving = await plannedWithConditions(command, {saveRoll: {total: 5, natural: 5, die: 5}});
  assert.deepEqual([saving.state.status, saving.state.results.saveResolution.failures.length], ["ready-to-commit", 1]);
  const {damage: _strike, ...net} = meleeStrikeDefinition();
  const attacking = await plannedWithConditions(net, {attackRoll: {total: 25, natural: 20, die: 20}});
  assert.deepEqual([attacking.state.status, attacking.state.results.attackResolution.hits.length], ["ready-to-commit", 1]);
});

test("common traits (G5): Magic Resistance is Advantage on saves against spells, Pack Tactics needs an ally by the target", async () => {
  const magicResistance = [{schemaVersion: 1, id: "magic-resistance", type: "RollMode", predicate: {tagsAny: ["magical"]},
    data: {domains: ["save"], mode: "advantage"}}];
  const spell = {...fortitudeBlast("wits"), id: "action:runtime-spell-blast", tags: ["spell"]};
  const wand = {...fortitudeBlast("wits"), id: "action:runtime-wand-blast", tags: ["magical"]};
  assert.equal((await firstRollRequest(spell, {target: [magicResistance]})).rollMode, "advantage", "every spell is magical");
  assert.equal((await firstRollRequest(wand, {target: [magicResistance]})).rollMode, "advantage", "a magic item's Action");
  assert.equal((await firstRollRequest(fortitudeBlast("wits"), {target: [magicResistance]})).rollMode, "normal", "nothing magical");

  const packTactics = [{schemaVersion: 1, id: "pack-tactics", type: "RollMode", predicate: {equals: {path: "attack.allyNearTarget", value: true}},
    data: {domains: ["attack"], mode: "advantage"}}];
  const strike = meleeStrikeDefinition();
  assert.equal((await firstRollRequest(strike, {attacker: [packTactics]})).rollMode, "normal", "alone");
  assert.equal((await firstRollRequest(strike, {attacker: [packTactics], allies: [{offset: {i: 2, j: 0}}]})).rollMode, "advantage",
    "an ally on the target's far side");
  assert.equal((await firstRollRequest(strike, {attacker: [packTactics], allies: [{offset: {i: 3, j: 0}}]})).rollMode, "normal",
    "an ally 10 ft from the target");
  assert.equal((await firstRollRequest(strike, {attacker: [packTactics], allies: [{offset: {i: 2, j: 0}, conditions: ["unconscious"]}]}))
    .rollMode, "normal", "an Incapacitated ally");
});

test("Legendary Resistance: a failed save succeeds instead, at once or when its controller chooses, paid from its own pool", async () => {
  const legendary = policy => actor => {
    actor.system.pools = [{id: "legendary-resistance", label: "Legendary Resistance", value: 3, max: 3, recovery: "longRest"}];
    if ( policy ) actor.flags = {wildpath: {commonPolicies: {"legendary-resistance": policy}}};
  };
  // A Stunned creature fails its Might save automatically; Legendary Resistance still turns that into a success.
  const always = await plannedWithConditions(fortitudeBlast("might"), {target: ["stunned"], prepareTarget: legendary("always")});
  const [saved] = always.state.results.saveResolution.successes;
  assert.deepEqual([saved.success, saved.succeededInstead], [true, true]);
  const payment = always.state.mutationPlans.find(plan => plan.payerRef === "Actor.roll-target");
  assert.deepEqual(payment.plan.updates, {"system.pools.0.value": 2}, "one use, paid by the creature that saved");

  const asked = await plannedWithConditions(fortitudeBlast("might"), {target: ["stunned"], prepareTarget: legendary(null)});
  const [request] = asked.state.pendingRequests;
  assert.deepEqual([request.type, request.authority.kind, request.payload.options.map(option => option.value)],
    ["choice", "target-controller", ["use", "decline"]], "by default its controller is asked");
  assert.equal(request.metadata.title, "WILDPATH.LEGENDARY.Title");
  const answer = value => resumeStagedActionResolution({state: asked.state, response: {resolutionId: asked.state.id, requestId: request.id,
    type: request.type, value: {choices: {"legendary-resistance": value}}}});
  assert.equal(answer("use").state.results.saveResolution.successes.length, 1);
  const declined = answer("decline").state;
  assert.deepEqual([declined.results.saveResolution.failures.length, declined.mutationPlans.some(plan => plan.payerRef)], [1, false]);

  const never = await plannedWithConditions(fortitudeBlast("might"), {target: ["stunned"], prepareTarget: legendary("never")});
  assert.deepEqual([never.state.pendingRequests.length, never.state.results.saveResolution.failures.length], [0, 1]);
  const spent = await plannedWithConditions(fortitudeBlast("might"), {target: ["stunned"],
    prepareTarget: actor => { legendary("always")(actor); actor.system.pools[0].value = 0; }});
  assert.equal(spent.state.results.saveResolution.failures.length, 1, "no use left");
});

test("succeed instead (a test offer): a failed save its item covers succeeds, for a charge and its Reaction, only while worn and attuned", async () => {
  const RING = {tests: ["save"], succeed: true, reaction: true, pool: "charges", predicate: {oneOf: {path: "save.ability", values: ["agility"]}}};
  // Its creature wears a ring (gear) that brings the offer and its charges (a feature it grants).
  const wearing = ({active=true, attunement="", charges=3, reaction=1, offer=RING, legendary=false}={}) => actor => {
    actor.system.resources = {...actor.system.resources, reaction: {value: reaction, max: 1}};
    actor.system.pools = [{id: "charges", label: "Charges", value: charges, max: 3},
      ...(legendary ? [{id: "legendary-resistance", label: "Legendary Resistance", value: 3, max: 3}] : [])];
    actor.items = [{id: "gear", name: "Ring", type: "gear", system: {active, attunement}},
      {id: "ring", name: "Ring of Evasion", type: "feature", system: {active: true}, flags: {wildpath: {grantedBy: "gear", testOffer: offer}}}];
  };
  const failing = {total: 5, natural: 5, die: 5};
  const choose = (state, value) => {
    const [request] = state.pendingRequests;
    return resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
      value: {choices: {[request.payload.id]: value}}}}).state;
  };
  const asked = await plannedWithConditions(fortitudeBlast("agility"), {saveRoll: failing, prepareTarget: wearing()});
  const [request] = asked.state.pendingRequests;
  assert.deepEqual([request.authority.kind, request.payload.options.map(option => [option.value, option.label])],
    ["target-controller", [["test-offer:ring", "WILDPATH.INSPIRATION.SucceedInstead"], ["keep", "WILDPATH.INSPIRATION.Keep"]]]);
  const saved = choose(asked.state, "test-offer:ring");
  const [success] = saved.results.saveResolution.successes;
  assert.deepEqual([saved.status, saved.pendingRequests.length, success?.succeededInstead, success?.succeededBy],
    ["ready-to-commit", 0, true, "Ring of Evasion"], "nothing rolled, nothing asked again");
  const payment = saved.mutationPlans.find(plan => plan.payerRef === "Actor.roll-target");
  assert.deepEqual(payment.plan.updates, {"system.pools.0.value": 2, "system.resources.reaction.value": 0}, "a charge and its Reaction");
  const kept = choose(asked.state, "keep");
  assert.deepEqual([kept.results.saveResolution.failures.length, kept.mutationPlans.some(plan => plan.payerRef)], [1, false]);

  const offered = async (options, definition=fortitudeBlast("agility"), extra={}) => (await plannedWithConditions(definition,
    {saveRoll: failing, prepareTarget: wearing(options), ...extra})).state.pendingRequests.length;
  assert.equal(await offered({}, fortitudeBlast("might")), 0, "not on a Might save");
  assert.equal(await offered({active: false}), 0, "not while unequipped");
  assert.equal(await offered({attunement: "required"}), 0, "not while unattuned");
  // A magic ring (a rarity) inside an Antimagic Field: a Suppress rule of its creature on magical sources silences its offer.
  const field = suppressing => actor => {
    wearing()(actor);
    actor.items[0].system.rarity = "rare";
    if ( suppressing ) actor.suppressingRules = () => [{id: "antimagic.suppress", actions: {tagsAny: ["spell", "magical"]}}];
  };
  assert.equal(await offered({}, fortitudeBlast("agility"), {prepareTarget: field(false)}), 1, "a rare ring outside the field");
  assert.equal(await offered({}, fortitudeBlast("agility"), {prepareTarget: field(true)}), 0, "not inside it");
  assert.equal(await offered({charges: 0}), 0, "no charge left");
  assert.equal(await offered({reaction: 0}), 0, "no Reaction left");

  // A Stunned creature fails its Agility save automatically; an offer with no Reaction still makes it a success, as Legendary
  // Resistance does (Q22). (Stunned is Incapacitated, whose cap leaves the ring's Reaction at 0, as above.)
  const stunned = await plannedWithConditions(fortitudeBlast("agility"), {target: ["stunned"], saveRoll: failing,
    prepareTarget: wearing({offer: {...RING, reaction: false}})});
  assert.equal(choose(stunned.state, "test-offer:ring").results.saveResolution.successes[0]?.succeededInstead, true);
  // An Unconscious one cannot use it, even when it costs no Reaction (`unlessStatus`, Q22); a Stunned one still can.
  const asleep = (statuses, offer={...RING, reaction: false, unlessStatus: "unconscious"}) => offered({}, fortitudeBlast("agility"),
    {target: statuses, prepareTarget: actor => { wearing({offer})(actor); actor.statuses = new Set(statuses); }});
  assert.equal(await asleep(["unconscious"]), 0, "not while Unconscious");
  assert.equal(await asleep(["stunned"]), 1, "still while only Stunned");
  assert.equal(await asleep(["unconscious"], {...RING, reaction: false}), 1, "an offer without the key is unchanged");
  // A success needs no Legendary Resistance: it is not asked after the ring.
  const legendary = await plannedWithConditions(fortitudeBlast("agility"), {saveRoll: failing, prepareTarget: wearing({legendary: true})});
  const afterRing = choose(legendary.state, "test-offer:ring");
  assert.deepEqual([afterRing.pendingRequests.length, afterRing.results.saveResolution.successes.length], [0, 1]);

  // Scarab of Protection: a save against a Necromancy spell, or forced by an Undead (the save's `sourceType`).
  const SCARAB = {tests: ["save"], succeed: true, reaction: true, pool: "charges",
    predicate: {any: [{tagsAll: ["school:necromancy"]}, {equals: {path: "save.sourceType", value: "undead"}}]}};
  const necromancy = {...fortitudeBlast("fortitude"), id: "action:runtime-necromancy", tags: ["spell", "school:necromancy"]};
  assert.equal(await offered({offer: SCARAB}, necromancy), 1, "a Necromancy spell");
  assert.equal(await offered({offer: SCARAB}, fortitudeBlast("fortitude"), {prepareSource: actor => { actor.system.details = {type: "undead"}; }}),
    1, "an Undead's");
  assert.equal(await offered({offer: SCARAB}, fortitudeBlast("fortitude")), 0, "neither");
  // Mage Slayer's Guarded Mind: an Intelligence, Wisdom or Charisma save, no Reaction.
  const GUARDED = {tests: ["save"], succeed: true, pool: "charges", predicate: {oneOf: {path: "save.ability", values: ["intellect", "wits", "presence"]}}};
  assert.deepEqual([await offered({offer: GUARDED, reaction: 0}, fortitudeBlast("wits")), await offered({offer: GUARDED}, fortitudeBlast("agility"))],
    [1, 0]);
});

test("a given test offer (Protection of the Talisman, Q34): its wearer's failed save, asked of the wearer, paid by its warlock", async () => {
  const warlock = Object.assign(fakeActor("talisman-warlock", {system: {...actorSystem(), pools: [{id: "protection-of-the-talisman",
    label: "Protection", value: 2, max: 2}]}}), {documentName: "Actor"});
  warlock.items = [{id: "protection", name: "Protection of the Talisman", system: {active: true}, flags: {wildpath: {testOffer: {tests: ["save"],
    givenStatus: "talisman", pool: "protection-of-the-talisman", faces: {type: "constant", value: 4}}}}}];
  const wearing = actor => actor.effects.push({id: "talisman", name: "Talisman", statuses: new Set(["talisman"]),
    flags: {wildpath: {conditionEffect: {conditionId: "talisman", sourceRef: `actor:${warlock.id}`}}}});
  const asked = await plannedWithConditions(fortitudeBlast("agility"), {saveRoll: {total: 5, natural: 5, die: 5}, prepareTarget: wearing,
    extraActors: [warlock]});
  const [request] = asked.state.pendingRequests;
  assert.deepEqual([request.authority.kind, request.payload.options.map(option => option.value)],
    ["target-controller", [`given-offer:${warlock.uuid}:protection`, "keep"]], "its wearer decides");
  const taken = resumeStagedActionResolution({state: asked.state, response: {resolutionId: asked.state.id, requestId: request.id,
    type: request.type, value: {choices: {[request.payload.id]: `given-offer:${warlock.uuid}:protection`}}}}).state;
  assert.equal(taken.pendingRequests[0]?.payload?.rollRequest?.formula, "1d4");
  assert.equal(asked.targetActors?.[warlock.uuid], warlock, "its warlock is committed on");
  assert.equal((await plannedWithConditions(fortitudeBlast("agility"), {saveRoll: {total: 5, natural: 5, die: 5}, extraActors: [warlock]}))
    .state.pendingRequests.length, 0, "not without the talisman");
  // Pact of the Talisman on the wearer's own check: the warlock is committed on there too.
  warlock.items.push({id: "pact", name: "Pact of the Talisman", system: {active: true}, flags: {wildpath: {testOffer: {tests: ["check"],
    givenStatus: "talisman", pool: "protection-of-the-talisman", faces: {type: "constant", value: 4}}}}});
  const sneak = {schemaVersion: 1, id: "action:runtime-talisman-sneak", label: "Sneak", costs: {allOf: []}, targeting: {type: "self"},
    check: {ability: "agility", skill: "stealth", dc: {value: 15}}};
  const checking = await plannedWithConditions(sneak, {prepareSource: wearing, extraActors: [warlock]});
  const check = checking.state.pendingRequests[0];
  const failed = resumeStagedActionResolution({state: checking.state, response: {resolutionId: checking.state.id, requestId: check.id,
    type: check.type, value: {requestId: check.payload.rollRequest.id, resolutionId: checking.state.id, type: check.payload.rollRequest.type,
      natural: 2, total: 2}}}).state;
  assert.deepEqual(failed.pendingRequests[0]?.payload?.options?.map(option => option.value), [`given-offer:${warlock.uuid}:pact`, "keep"]);
  assert.equal(checking.targetActors?.[warlock.uuid], warlock, "its warlock is committed on for a check");
});

test("Heroic Inspiration (BG3): a player character rerolls its own failure with its own point; the GM a monster's roll with a player's", async () => {
  // A player's character with `value` of its 4 points.
  const inspired = value => actor => {
    Object.assign(actor, {type: "character", hasPlayerOwner: true});
    actor.system.pools = [...(actor.system.pools ?? []), {id: "heroic-inspiration", label: "Heroic Inspiration", base: 4, value, max: 4,
      recovery: "none"}];
  };
  const answer = (state, value) => {
    const request = state.pendingRequests[0];
    return resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
      value: request.type === "roll" ? {requestId: request.payload.rollRequest.id, resolutionId: state.id,
        type: request.payload.rollRequest.type, natural: value, total: value + (request.payload.rollRequest.expected?.modifierTotal ?? 0)}
        : {choices: {"heroic-inspiration": value}}}});
  };
  const miss = {total: 5, natural: 1, die: 1};

  // Its own miss: its controller is asked, the reroll hits, and one point is paid by the attacker.
  const asked = await plannedWithConditions(meleeStrikeDefinition(), {attackRoll: miss, prepareSource: inspired(2)});
  const [choice] = asked.state.pendingRequests;
  assert.deepEqual([choice.type, choice.authority.kind, choice.payload.options.map(option => option.value)],
    ["choice", "source-controller", ["spend:Actor.roll-source", "keep"]]);
  assert.equal(choice.metadata.title, "WILDPATH.INSPIRATION.Title", "only Heroic Inspiration offered: titled so");
  assert.deepEqual([choice.payload.label, choice.payload.labelData], ["WILDPATH.INSPIRATION.Outcome.attack.Failed",
    {name: "roll-source", total: 5}], "its player is asked what its roll came to, without the target's AC");
  const rolling = answer(asked.state, "spend:Actor.roll-source");
  assert.match(rolling.state.pendingRequests[0].id, /attack-roll:reroll:attack$/u, "a fresh request for the new d20");
  const rerolled = answer(rolling.state, 18).state;
  assert.equal(rerolled.results.attackResolution.hits.length, 1);
  assert.deepEqual(rerolled.mutationPlans.find(plan => plan.payerRef === "Actor.roll-source")?.plan.updates,
    {"system.pools.0.value": 1}, "one point, paid by the attacker");
  assert.deepEqual(rerolled.rollResults.map(entry => [entry.type, entry.roll.natural]), [["attack-roll", 18]],
    "the rerolled d20 is recorded");

  const kept = answer(asked.state, "keep").state;
  assert.deepEqual([kept.results.attackResolution.hits.length, kept.mutationPlans.some(plan => plan.payerRef)], [0, false]);
  const hit = await plannedWithConditions(meleeStrikeDefinition(), {attackRoll: {total: 25, natural: 20, die: 20},
    prepareSource: inspired(2)});
  assert.equal(hit.state.pendingRequests.length, 0, "a success is not offered to a player");
  const empty = await plannedWithConditions(meleeStrikeDefinition(), {attackRoll: miss, prepareSource: inspired(0)});
  assert.deepEqual([empty.state.pendingRequests.length, empty.state.results.attackResolution.misses.length], [0, 1], "no point, no prompt");

  // A monster's hit: the GM may spend a player character's point (the hero is not in the Action) to reroll it.
  const hero = Object.assign(fakeActor("hero", {system: actorSystem()}), {});
  inspired(1)(hero);
  const monster = await plannedWithConditions(meleeStrikeDefinition(), {attackRoll: {total: 25, natural: 20, die: 20},
    extraActors: [hero]});
  const [gm] = monster.state.pendingRequests;
  assert.deepEqual([gm.authority.kind, gm.payload.options.map(option => option.value), gm.metadata.title],
    ["gm", ["spend:Actor.hero", "keep"], "WILDPATH.INSPIRATION.Title"]);
  assert.deepEqual([gm.payload.label, gm.payload.labelData], ["WILDPATH.INSPIRATION.Outcome.attack.PassedAgainst",
    {name: "roll-source", total: 25, against: 14}], "the GM's question has the AC it hit");
  // Live 9: behind Half cover the question read "21 hit AC 15" where the card showed 23. Cover raises the AC (2024): the
  // total stays the card's, the AC the one it had to meet.
  const behindCover = await plannedWithConditions(meleeStrikeDefinition(), {attackRoll: {total: 25, natural: 20, die: 20},
    extraActors: [hero], prepareTarget: actor => { actor.statuses = new Set(["coverHalf"]); }});
  assert.deepEqual(behindCover.state.pendingRequests[0].payload.labelData, {name: "roll-source", total: 25, against: 16});
  const monsterRerolled = answer(answer(monster.state, "spend:Actor.hero").state, 2).state;
  assert.equal(monsterRerolled.results.attackResolution.hits.length, 0, "the monster's reroll misses");
  assert.ok(monsterRerolled.mutationPlans.some(plan => plan.payerRef === "Actor.hero"), "paid by the hero");

  // Its own failed save: the target's controller is asked, the reroll saves, and the target pays.
  const saving = await plannedWithConditions(fortitudeBlast("might"), {saveRoll: {total: 2, natural: 2, die: 2},
    prepareTarget: inspired(1)});
  const [saveChoice] = saving.state.pendingRequests;
  assert.deepEqual([saveChoice.authority.kind, saveChoice.payload.options[0].value], ["target-controller", "spend:Actor.roll-target"]);
  assert.deepEqual([saveChoice.payload.label, saveChoice.payload.labelData], ["WILDPATH.INSPIRATION.Outcome.save.Failed",
    {name: "roll-target", total: 2}], "a failed save, without its DC");
  const saved = answer(answer(saving.state, "spend:Actor.roll-target").state, 19).state;
  assert.deepEqual([saved.results.saveResolution.successes.length, saved.mutationPlans.some(plan => plan.payerRef === "Actor.roll-target")],
    [1, true]);

  // Its own failed check (Hide's kind): rerolled, then the success applies.
  const sneak = {schemaVersion: 1, id: "action:runtime-sneak", label: "Sneak", costs: {allOf: []}, targeting: {type: "self"},
    check: {ability: "agility", skill: "stealth", dc: {value: 15}}};
  const checking = await plannedWithConditions(sneak, {prepareSource: inspired(1)});
  const failedCheck = answer(checking.state, 2).state;
  assert.equal(failedCheck.pendingRequests[0]?.type, "choice", "a failed check is offered");
  const passed = answer(answer(failedCheck, "spend:Actor.roll-source").state, 18).state;
  assert.deepEqual([passed.results.checkResolution.success, passed.mutationPlans.some(plan => plan.payerRef === "Actor.roll-source")],
    [true, true]);
});

test("a monster's reroll is paid by the party on its Scene, never by a summoned copy of a player character (Q137 (f))", () => {
  const hero = {type: "character", hasPlayerOwner: true, system: {}};
  const copy = {type: "character", hasPlayerOwner: true, system: {companion: {kind: "summon", controllers: ["Actor.hero"]}}};
  const goblin = {type: "npc", hasPlayerOwner: false, system: {}};
  const scene = {tokens: [{actor: hero}, {actor: hero}, {actor: copy}, {actor: goblin}]};
  assert.deepEqual(monsterRerollPayers({}, scene), [hero]);
});

test("Evasion: an Agility save that halves takes none on a success and half on a failure, unless the creature is Incapacitated", async () => {
  const evasion = [{schemaVersion: 1, id: "evasion", type: "RollOutcome", data: {domains: ["save.agility"], outcome: "evasion"},
    predicate: {not: {any: [{hasCondition: "stunned"}, {hasCondition: "incapacitated"}]}}}];
  const burst = {...fortitudeBlast("agility"), id: "action:runtime-burst", damage: [{id: "burst", expression: {type: "constant", value: 10},
    damageType: "fire", provenance: "spell-base", saveOutcomePolicy: {success: "half", failure: "full"}}]};
  const taken = async (roll, conditions=[]) => (await plannedWithConditions(burst, {target: [evasion, ...conditions],
    saveRoll: {total: roll, natural: roll, die: roll}})).state.results.damageResolution.results[0].total;
  assert.equal(await taken(15), 0, "a success: none");
  assert.equal(await taken(5), 5, "a failure: half");
  assert.equal(await taken(15, ["restrained"]), 0, "Restrained is not Incapacitated");
  const stunned = await plannedWithConditions(burst, {target: [evasion, "stunned"]});
  assert.equal(stunned.state.results.damageResolution.results[0].total, 10, "Stunned fails, and takes it all");
  const wits = {...burst, id: "action:runtime-wits-burst", save: {ability: "wits", dc: {value: 13}}};
  assert.equal((await plannedWithConditions(wits, {target: [evasion], saveRoll: {total: 15, natural: 15, die: 15}}))
    .state.results.damageResolution.results[0].total, 5, "only Agility saves");
});

test("Sunlight Sensitivity: Disadvantage on attacks while the attacker stands in sunlight", async () => {
  const sensitive = [{schemaVersion: 1, id: "sunlight", type: "RollMode", predicate: {equals: {path: "inSunlight", value: true}},
    data: {domains: ["attack", "check"], mode: "disadvantage"}}];
  assert.equal((await firstRollRequest(meleeStrikeDefinition(), {attacker: [sensitive]})).rollMode, "normal", "at night");
  assert.equal((await firstRollRequest(meleeStrikeDefinition(), {attacker: [sensitive], sunlit: true})).rollMode, "disadvantage");
  assert.equal((await firstRollRequest(meleeStrikeDefinition(), {target: [sensitive], sunlit: true})).rollMode, "normal",
    "the target's own sensitivity does not hinder attacks on it");
});

test("each target adds its own save bonus from its save Modifiers", async () => {
  const request = await firstRollRequest(fortitudeBlast("might"), {targetStatistics: {"save.might": runtimeStatistic("save.might", 3)}});
  assert.equal(request.expected.modifierTotal, 3);
});

test("2024 Stunned: a Might save fails automatically, with no roll asked of anyone", async () => {
  const planned = await plannedWithConditions(fortitudeBlast("might"), {target: ["stunned"]});
  assert.equal(planned.state.rollRequests.length, 0, "nobody rolls");
  const [failure] = planned.state.results.saveResolution.failures;
  assert.deepEqual([failure.automatic, failure.outcome], [true, "failure"]);
  assert.equal(planned.state.status, "ready-to-commit");
  assert.equal((await firstRollRequest(fortitudeBlast("wits"), {target: ["stunned"]})).type, "saving-throw",
    "a Wits save is still rolled");
});

test("2024 Unconscious: a hit from within 5 ft is a critical hit, and a critical rolls the damage dice twice", async () => {
  const hit = {total: 15, natural: 11, die: 11};
  const critical = await plannedWithConditions(meleeStrikeDefinition(), {target: ["unconscious"], attackRoll: hit});
  assert.equal(critical.state.results.attackResolution.hits[0].outcome, "criticalHit");
  const dice = {...meleeStrikeDefinition(), id: "action:runtime-dice-strike",
    damage: [{id: "blade", expression: {type: "dice", number: 1, faces: 8}, damageType: "slashing", provenance: "weapon-base"}]};
  const doubled = await plannedWithConditions(dice, {target: ["unconscious"], attackRoll: hit});
  assert.deepEqual(doubled.state.rollRequests.find(request => request.type === "damage").definition.dice.map(die => [die.number, die.faces]),
    [[2, 8]], "1d8 becomes 2d8");
  const shot = {...dice, id: "action:runtime-dice-shot", attack: {type: "ranged", statistic: "weapon", defenseKey: "ac"},
    range: {type: "ranged", normal: {value: 60, unit: "ft"}}};
  const normal = await plannedWithConditions(shot, {target: ["unconscious"], attackRoll: hit, offset: {i: 3, j: 0}});
  assert.equal(normal.state.results.attackResolution.hits[0].outcome, "hit", "from farther it is a normal hit");
});

test("2024 disadvantage: each target makes its own save with its own conditions", async () => {
  const save = ability => ({schemaVersion: 1, id: `action:runtime-${ability}-save`, label: "Save", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1}, range: {type: "reach", distance: {value: 5, unit: "ft"}},
    save: {ability, dc: {value: 13}},
    damage: [{id: "burst", expression: {type: "constant", value: 4}, damageType: "fire", provenance: "spell-base"}]});
  assert.equal((await firstRollRequest(save("agility"), {target: ["restrained"]})).rollMode, "disadvantage");
  assert.equal((await firstRollRequest(save("might"), {target: ["restrained"]})).rollMode, "normal");
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

test("a save waiting on a Player who disconnects goes to the GM instead of hanging", async t => {
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
  const gm = createMultiplayerActionCoordinator({userId: "gm-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}), rollProviders: [createTestRollProvider({result: {natural: 5, total: 5}})],
    actionIntentResolver: ({intent, envelope}) => foundryActionIntentToStagedOptions({intent,
      senderUserId: envelope.senderUserId, game, persistencePort: createTestDocumentPersistenceAdapter()})});
  gm.register();
  // The Player's client receives the request but never answers it.
  const silent = hub.createEndpoint({userId: "player-a"});
  silent.register(() => ({ok: true}));
  const built = buildFoundryActionUseIntent({actor: sourceActor, action, game: {user: {targets: new Set([{document: targetToken}])}}});
  const declared = await gm.declareActionIntent(built.intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.AWAITING_ROLL, "the save waits on the target's Player");
  hub.setActive("player-a", false);
  await gm.releaseRequestsOf("player-a");
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors));
  assert.equal(targetActor.system.resources.health.value, 26, "the GM rolled the save; it failed against DC 100");
  // Back online, the Player's answer for a resolution the GM no longer has is refused back to them, not dropped.
  hub.setActive("player-a", true);
  const errors = [];
  silent.register(envelope => { errors.push(envelope); return {ok: true}; });
  await silent.send(createResolutionSocketEnvelope({messageType: "REQUEST_RESPONSE", senderUserId: "player-a",
    recipientUserId: "gm-a", resolutionId: "resolution:gone", requestId: "request:gone", payload: {response: {value: {}}}}));
  assert.equal(errors.find(envelope => envelope.messageType === "RESOLUTION_ERROR")?.payload?.code, "RESOLUTION_NOT_FOUND");
});

test("a save released from a Player who left can be passed back once they return; a stale or repeated answer is refused", async t => {
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
  // The GM's prompt presses Pass back: at once (the Player still away), then once the Player is back.
  const asked = [];
  let reopen = null;
  const passedBack = request => ({ok: false, status: "failure", code: "REQUEST_PASSED_BACK", requestId: request.id,
    resolutionId: request.resolutionId});
  const answers = [passedBack, request => new Promise(resolve => { reopen = () => resolve(passedBack(request)); })];
  const gmDialog = {id: "gm-dialog", type: "test", label: "GM dialog", canHandle: () => true,
    request: async (request, context) => { asked.push(context.passBackUserId); return answers.shift()(request); }};
  const gm = createMultiplayerActionCoordinator({userId: "gm-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}), promptPorts: [gmDialog],
    actionIntentResolver: ({intent, envelope}) => foundryActionIntentToStagedOptions({intent,
      senderUserId: envelope.senderUserId, game, persistencePort: createTestDocumentPersistenceAdapter()})});
  gm.register();
  const received = [];
  const away = hub.createEndpoint({userId: "player-a"});
  away.register(envelope => { received.push(envelope); return {ok: true}; });
  const player = createMultiplayerActionCoordinator({userId: "player-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: away, rollProviders: [createTestRollProvider({result: {natural: 3, total: 3}})]});
  const built = buildFoundryActionUseIntent({actor: sourceActor, action, game: {user: {targets: new Set([{document: targetToken}])}}});
  const declared = await gm.declareActionIntent(built.intent);
  const record = gm.getRecord(declared.resolutionId);
  const requests = () => received.filter(envelope => envelope.messageType === "PENDING_REQUEST");
  assert.equal(requests().length, 1, "the save waits on the target's Player");

  // They leave: the save is released to the GM, as before, and the GM's prompt knows whose it was.
  hub.setActive("player-a", false);
  const releasing = gm.releaseRequestsOf("player-a");
  for ( let tick = 0; (tick < 50) && !reopen; tick++ ) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(asked, ["player-a", "player-a"], "passed back while still away, it comes back to the GM");
  assert.equal(requests().length, 1, "nothing is sent to a Player who is away");
  assert.deepEqual(gm.waitingRequests(), [], "the GM's own prompt is not waiting on anyone else");

  // Back online: passed back, the same request goes to them again and leaves the GM.
  hub.setActive("player-a", true);
  reopen();
  await releasing;
  const [first, again] = requests();
  assert.equal(again?.requestId, first.requestId, "re-sent to the Player");
  assert.deepEqual(gm.waitingRequests().map(entry => entry.userId), ["player-a"]);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.AWAITING_ROLL);

  // The GM's answer now is stale: refused, as the Player is the expected chooser.
  const stale = await gm.handleEnvelope(createResolutionSocketEnvelope({messageType: "REQUEST_RESPONSE", senderUserId: "gm-a",
    recipientUserId: "gm-a", resolutionId: again.resolutionId, requestId: again.requestId,
    payload: {response: {resolutionId: again.resolutionId, requestId: again.requestId, type: "roll", value: {natural: 20, total: 20}}}}));
  assert.equal(stale.code, "WRONG_USER");
  assert.equal(targetActor.system.resources.health.value, 30);

  // The Player's answer is the first accepted one; a repeat of it changes nothing.
  await player.handleEnvelope(again);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors));
  assert.equal(targetActor.system.resources.health.value, 26, "the Player's 3 failed against DC 100");
  const repeated = await gm.handleEnvelope(createResolutionSocketEnvelope({messageType: "REQUEST_RESPONSE", senderUserId: "player-a",
    recipientUserId: "gm-a", resolutionId: again.resolutionId, requestId: again.requestId,
    payload: {response: {resolutionId: again.resolutionId, requestId: again.requestId, type: "roll", value: {natural: 1, total: 1}}}}));
  assert.equal(repeated.duplicate, true);
  assert.equal(targetActor.system.resources.health.value, 26);
});

test("a Player whose client is ready again gets what it waits on; one passed back who leaves again is released to the GM", async t => {
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
  // The GM's prompt: first it passes the save back (the Player is back), then it answers the save itself.
  const asked = [];
  const answers = [request => ({ok: false, status: "failure", code: "REQUEST_PASSED_BACK", requestId: request.id,
    resolutionId: request.resolutionId}), request => ({ok: true, response: {resolutionId: request.resolutionId, requestId: request.id,
    type: request.type, value: {natural: 2, total: 2}}})];
  const gmDialog = {id: "gm-dialog", type: "test", label: "GM dialog", canHandle: () => true,
    request: async (request, context) => { asked.push(context.passBackUserId); return answers.shift()(request); }};
  const ready = [];
  const gm = createMultiplayerActionCoordinator({userId: "gm-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}), promptPorts: [gmDialog], onClientReady: userId => ready.push(userId),
    actionIntentResolver: ({intent, envelope}) => foundryActionIntentToStagedOptions({intent,
      senderUserId: envelope.senderUserId, game, persistencePort: createTestDocumentPersistenceAdapter()})});
  gm.register();
  const received = [];
  const endpoint = hub.createEndpoint({userId: "player-a"});
  endpoint.register(envelope => { received.push(envelope); return {ok: true}; });
  const player = createMultiplayerActionCoordinator({userId: "player-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: endpoint});
  const built = buildFoundryActionUseIntent({actor: sourceActor, action, game: {user: {targets: new Set([{document: targetToken}])}}});
  const declared = await gm.declareActionIntent(built.intent);
  const record = gm.getRecord(declared.resolutionId);
  const requests = () => received.filter(envelope => envelope.messageType === "PENDING_REQUEST");
  assert.equal(requests().length, 1);

  // The Player's page reloads: Foundry calls them connected before WildPath listens, so the save sent then is lost. Their
  // client's CLIENT_READY has the GM send it again, and lets the GM's prompts pass back to them.
  assert.equal((await player.announceReady()).ok, true);
  assert.deepEqual(ready, ["player-a"]);
  assert.equal(requests().length, 2, "sent again once their client listens");
  assert.equal(requests()[1].requestId, requests()[0].requestId);
  assert.deepEqual(gm.waitingRequests().map(entry => entry.userId), ["player-a"]);

  // They leave: released to the GM, who passes it back (they are back at once); they leave again before answering: it is
  // released to the GM again, whose prompt knows whose it was, and the GM's answer completes the Action.
  hub.setActive("player-a", false);
  const releasing = gm.releaseRequestsOf("player-a");
  hub.setActive("player-a", true);
  await releasing;
  assert.equal(requests().length, 3, "passed back: sent to the Player");
  hub.setActive("player-a", false);
  await gm.releaseRequestsOf("player-a");
  assert.deepEqual(asked, ["player-a", "player-a"], "released again, the GM's prompt can still pass it back");
  assert.equal(requests().length, 3, "nothing more sent to a Player who is away");
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors));
  assert.equal(targetActor.system.resources.health.value, 26, "the GM's 2 failed against DC 100");
});

test("the GM answers a save a connected Player leaves waiting; the Player is told, and a late answer is refused", async t => {
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
  const gm = createMultiplayerActionCoordinator({userId: "gm-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}), rollProviders: [createTestRollProvider({result: {natural: 5, total: 5}})],
    actionIntentResolver: ({intent, envelope}) => foundryActionIntentToStagedOptions({intent,
      senderUserId: envelope.senderUserId, game, persistencePort: createTestDocumentPersistenceAdapter()})});
  gm.register();
  // The Player stays connected but never answers.
  const received = [];
  const away = hub.createEndpoint({userId: "player-a"});
  away.register(envelope => { received.push(envelope); return {ok: true}; });
  const built = buildFoundryActionUseIntent({actor: sourceActor, action, game: {user: {targets: new Set([{document: targetToken}])}}});
  const declared = await gm.declareActionIntent(built.intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.AWAITING_ROLL);
  const [waiting] = gm.waitingRequests();
  assert.deepEqual([waiting.resolutionId, waiting.userId, waiting.type], [declared.resolutionId, "player-a", "roll"]);
  const request = received.find(envelope => envelope.messageType === "PENDING_REQUEST");

  await gm.answerForUsers(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors));
  assert.equal(targetActor.system.resources.health.value, 26, "the GM rolled the save; it failed against DC 100");
  assert.deepEqual(gm.waitingRequests(), []);
  const told = received.find(envelope => envelope.messageType === "RESOLUTION_ERROR");
  assert.deepEqual([told?.payload?.code, told?.requestId], ["REQUEST_ANSWERED_BY_GM", request.requestId]);
  // The Player's answer, arriving after the GM's, changes nothing.
  await away.send(createResolutionSocketEnvelope({messageType: "REQUEST_RESPONSE", senderUserId: "player-a", recipientUserId: "gm-a",
    resolutionId: request.resolutionId, requestId: request.requestId,
    payload: {response: {resolutionId: request.resolutionId, requestId: request.requestId, type: "roll", value: {natural: 20, total: 20}}}}));
  assert.equal(targetActor.system.resources.health.value, 26);
  assert.equal((await gm.answerForUsers(declared.resolutionId)).ok, false, "nothing is left to answer");
});

/** A GM and a Player, the Player's client wired by `player`; the save of `saveDefinition` waits on the Player. */
function strandedSaveFixture(t, {player=null, planResolution=undefined, afterCompleted=undefined}={}) {
  const saveDefinition = {schemaVersion: 1, id: "action:routed-save", label: "Routed save",
    costs: {allOf: [{capability: "action", amount: 1}]}, targeting: {type: "single", required: true, count: 1},
    range: {type: "reach", distance: {value: 5, unit: "ft"}}, save: {ability: "fortitude", dc: {value: 100}},
    damage: [{id: "venom", expression: {type: "constant", value: 4}, damageType: "poison",
      saveOutcomePolicy: {success: "half", failure: "full"}}]};
  const fixture = syntheticRuntimeFixture(t, saveDefinition, {targetHealth: 30});
  const hub = createTestResolutionTransportHub({users: [
    {id: "gm-a", active: true, isGM: true, isActiveGM: true},
    {id: "player-a", active: true, isGM: false}
  ]});
  const gm = createMultiplayerActionCoordinator({userId: "gm-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}), rollProviders: [createTestRollProvider({result: {natural: 5, total: 5}})],
    logger: {error() {}, warn() {}}, ...(planResolution ? {planResolution} : {}), ...(afterCompleted ? {afterCompleted} : {}),
    actionIntentResolver: ({intent, envelope}) => foundryActionIntentToStagedOptions({intent,
      senderUserId: envelope.senderUserId, game: fixture.game, persistencePort: createTestDocumentPersistenceAdapter()})});
  gm.register();
  const received = [];
  if ( player ) player(hub, received);
  else {
    const away = hub.createEndpoint({userId: "player-a"});
    away.register(envelope => { received.push(envelope); return {ok: true}; });
  }
  const declare = () => gm.declareActionIntent(buildFoundryActionUseIntent({actor: fixture.sourceActor, action: fixture.action,
    game: {user: {targets: new Set([{document: fixture.targetToken}])}}}).intent);
  return {...fixture, gm, received, declare};
}

test("the GM cancels an Action a Player's client left waiting: nothing applies, the prompt is withdrawn, the creature acts again", async t => {
  const {gm, received, declare, targetActor} = strandedSaveFixture(t);
  const declared = await declare();
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.AWAITING_ROLL);
  assert.equal((await declare()).ok, true, "the second intent is sent");
  assert.equal(gm.errors.at(-1)?.error?.reason, "This creature is still resolving another Action.");
  const request = received.find(envelope => envelope.messageType === "PENDING_REQUEST");

  const cancelled = await gm.cancelResolution(declared.resolutionId);
  assert.equal(cancelled.code, "RESOLUTION_CANCELLED_BY_GM");
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.CANCELLED);
  assert.equal(targetActor.system.resources.health.value, 30, "nothing applied");
  assert.deepEqual(gm.waitingRequests(), []);
  const withdrawn = received.find(envelope => (envelope.messageType === "RESOLUTION_ERROR") && envelope.requestId);
  assert.deepEqual([withdrawn?.payload?.code, withdrawn?.requestId], ["RESOLUTION_CANCELLED_BY_GM", request.requestId]);
  assert.equal((await gm.cancelResolution(declared.resolutionId)).ok, false, "an ended resolution is not cancelled twice");
  // The Player's late answer changes nothing.
  await gm.handleEnvelope(createResolutionSocketEnvelope({messageType: "REQUEST_RESPONSE", senderUserId: "player-a",
    recipientUserId: "gm-a", resolutionId: request.resolutionId, requestId: request.requestId,
    payload: {response: {resolutionId: request.resolutionId, requestId: request.requestId, type: "roll", value: {natural: 1, total: 1}}}}));
  assert.equal(targetActor.system.resources.health.value, 30);

  const again = await declare();
  assert.equal(gm.getRecord(again.resolutionId)?.state?.status, RESOLUTION_STATE_STATUS.AWAITING_ROLL, "the creature can act again");
});

test("a creature's second Action is refused until the first's follow-ups are written, then it acts again", async t => {
  let entered, release;
  const inFollowUp = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const {gm, declare} = strandedSaveFixture(t, {afterCompleted: async () => { entered(); await gate; }});
  const guarded = () => gm.errors.filter(entry => entry?.error?.reason === "This creature is still resolving another Action.").length;
  const declared = await declare();
  const answering = gm.answerForUsers(declared.resolutionId);
  await inFollowUp;
  assert.equal(gm.getRecord(declared.resolutionId).state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  await declare();
  const refused = guarded();
  assert.ok(refused > 0, "refused while the first's follow-ups are still being written");
  release();
  await answering;
  const again = await declare();
  assert.equal(guarded(), refused, "once they are written, the creature acts again");
  assert.equal(gm.getRecord(again.resolutionId)?.state?.errors?.[0]?.code, "PAYMENT_UNAVAILABLE", "it resolves; its one Action is spent");
});

test("a Player's prompt that throws is reported, and the GM answers that request so the Action goes on", async t => {
  const {gm, declare, targetActor} = strandedSaveFixture(t, {player(hub) {
    const broken = {id: "broken", type: "digital", label: "Broken", canHandle: () => true,
      request: () => { throw new Error("notification failed"); }};
    createMultiplayerActionCoordinator({userId: "player-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
      transport: hub.createEndpoint({userId: "player-a"}), rollProviders: [broken], logger: {error() {}, warn() {}}}).register();
  }});
  const declared = await declare();
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors));
  assert.equal(targetActor.system.resources.health.value, 26, "the GM rolled the save; it failed against DC 100");
});

test("a cancel while the Action is still being planned sticks: nothing is committed once the plan returns", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const {gm, declare, sourceActor, targetActor} = strandedSaveFixture(t, {planResolution: async options => {
    calls += 1;
    if ( calls === 1 ) await gate;
    return planStagedActionResolution(options);
  }});
  const spent = () => JSON.stringify(sourceActor.system.resources);
  const before = spent();
  const declaring = declare();
  await new Promise(resolve => setTimeout(resolve, 0));
  const [record] = [...gm.records.values()];
  assert.equal(record.state, null, "still planning");
  assert.deepEqual(gm.waitingRequests(), [], "an unplanned record waits on no one");
  assert.equal((await gm.cancelResolution(record.resolutionId)).code, "RESOLUTION_CANCELLED_BY_GM");
  release();
  await declaring;
  assert.equal(gm.getRecord(record.resolutionId), null);
  assert.equal(record.state, null, "the plan that returned afterwards is dropped");
  assert.equal(targetActor.system.resources.health.value, 30);
  assert.equal(spent(), before, "nothing spent");
  const again = await declare();
  assert.equal(gm.getRecord(again.resolutionId)?.state?.status, RESOLUTION_STATE_STATUS.AWAITING_ROLL, "the creature can act again");
});

test("an error no step expected ends its resolution instead of locking its creature", async t => {
  let calls = 0;
  const {gm, declare} = strandedSaveFixture(t, {planResolution: async options => {
    calls += 1;
    if ( calls === 1 ) throw new Error("planning broke");
    return planStagedActionResolution(options);
  }});
  const first = await declare();
  assert.equal(gm.getRecord(first.resolutionId), null, "a resolution with no state is dropped");
  assert.equal(gm.errors.at(-1)?.error?.reason, "planning broke");
  const again = await declare();
  assert.equal(gm.getRecord(again.resolutionId)?.state?.status, RESOLUTION_STATE_STATUS.AWAITING_ROLL, "the creature can act again");
});

test("a creature's own grants form its damage profile, and nothing granted means no profile", () => {
  const resist = {schemaVersion: 1, id: "hide", type: "GrantResistance", data: {damageTypes: ["slashing"]}};
  const immune = {schemaVersion: 1, id: "ward", type: "GrantImmunity", data: {damageTypes: ["poison"]}};
  const profile = damageProfileFromRuleElements([{ruleElements: [resist]}, {ruleElements: [immune]}]);
  assert.deepEqual(profile.resistances.map(entry => entry.damageTypes), [["slashing"]]);
  assert.deepEqual(profile.immunities.map(entry => entry.damageTypes), [["poison"]]);
  assert.equal(damageProfileFromRuleElements([{ruleElements: [{schemaVersion: 1, id: "m", type: "Modifier",
    data: {selector: "attack", value: 1}}]}]), null);
});

test("a target's granted resistance halves the damage it takes through the production runtime", async t => {
  const {sourceActor, targetActor, targetToken, action, game} = syntheticRuntimeFixture(t, undefined, {targetHealth: 30});
  targetActor.getDamageProfile = () => damageProfileFromRuleElements([{ruleElements: [
    {schemaVersion: 1, id: "hide", type: "GrantResistance", data: {damageTypes: ["slashing"]}}]}]);
  const hub = createTestResolutionTransportHub({users: [
    {id: "gm-a", active: true, isGM: true, isActiveGM: true},
    {id: "player-a", active: true, isGM: false}
  ]});
  const gm = createMultiplayerActionCoordinator({userId: "gm-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}),
    actionIntentResolver: ({intent, envelope}) => foundryActionIntentToStagedOptions({intent,
      senderUserId: envelope.senderUserId, game, persistencePort: createTestDocumentPersistenceAdapter()})});
  const player = createMultiplayerActionCoordinator({userId: "player-a", users: () => hub.userDirectory(),
    activeGMUserId: "gm-a", transport: hub.createEndpoint({userId: "player-a"}),
    rollProviders: [createTestRollProvider({result: {natural: 18, total: 22}})]});
  gm.register();
  player.register();
  const built = buildFoundryActionUseIntent({actor: sourceActor, action, game: {user: {targets: new Set([{document: targetToken}])}}});
  const declared = await player.declareActionIntent(built.intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors));
  assert.equal(targetActor.system.resources.health.value, 27, "6 slashing, resisted, is 3");
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

test("two unlinked Tokens of one base Actor each make their own save, and take its outcome", async t => {
  // Fireball's shape: half damage on a success, a condition on a failure.
  const blast = fortitudeBlast("agility");
  const definition = {...blast, targeting: {type: "multiple", required: true, count: 2},
    damage: blast.damage.map(entry => ({...entry, saveOutcomePolicy: {success: "half", failure: "full"}})),
    effects: [{id: "prone", type: "condition", conditionId: "prone", saveOutcomePolicy: "failure"}]};
  const {scene, sourceActor, targetActor, targetToken, action, game} = syntheticRuntimeFixture(t, definition, {targetHealth: 30});
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
  const built = buildFoundryActionUseIntent({actor: sourceActor, action,
    game: {user: {targets: new Set([{document: targetToken}, {document: secondToken}])}}});
  const resolved = await foundryActionIntentToStagedOptions({intent: built.intent, senderUserId: "player-a", game,
    persistencePort: createTestDocumentPersistenceAdapter()});
  assert.equal(resolved.ok, true, resolved.reason);
  const plan = planStagedActionResolution(resolved.options);
  const answer = (state, natural) => {
    const request = state.pendingRequests[0];
    return resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
      value: {requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, natural,
        total: natural + (request.payload.rollRequest.expected?.modifierTotal ?? 0)}}});
  };
  const done = answer(answer(plan.state, 19).state, 2).state;
  const outcomes = done.results.saveResolution.results.map(entry => [entry.target.tokenId, entry.success]);
  assert.deepEqual(outcomes, [[targetToken.id, true], ["second-token", false]], "each goblin saves with its own roll");
  const taken = done.results.damageResolution.results.map(entry => [entry.target.tokenId, entry.total]);
  assert.deepEqual(taken, [[targetToken.id, 2], ["second-token", 4]], "the one that saved takes half, the other all of it");
  const prone = done.results.effectResolution.conditionPlans.map(entry => entry.target?.tokenId);
  assert.deepEqual(prone, ["second-token"], "only the one that failed falls Prone");
});

/** A GM-controlled target whose Token answers "a hit on me" by striking back (authored Trigger RuleElement). */
function counterattackFixture(t, {decision="use", reactor="target", event="attack.hit", natural=null, once=false, rider=null, extra=null,
  queue=null, pick=null, items=null, holderItems=null, gmQueue=null, gmMessageMode=null, choose=null, point=null, afterChild=null}={}) {
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
    // An ally of the target: hostile to the attacker (Cutting Words answers only a hostile creature).
    const token = fakeTokenDocument({id: "bystander-token", actor: holder, scene, offset: {i: 0, j: 1}, disposition: 1});
    Object.assign(holder, {uuid: `${token.uuid}.Actor.bystander`, isToken: true, token, tokens: [token]});
    scene.tokens.push(token);
  }
  // Its own hit (a 2014 Divine Smite): no cost, damage to the creature hit, kept beside its attack.
  if ( reactor === "source" ) {
    holder = sourceActor;
    const smite = {id: "smite", type: "action", name: "Smite", system: {active: true,
      definition: {schemaVersion: 1, id: "action:smite", label: "Smite", costs: {allOf: []}, range: {type: "special"},
        targeting: {type: "single", required: true, count: 1}, ...(rider ? {rider} : {}),
        damage: [{id: "smite", expression: {type: "dice", number: 2, faces: 8}, damageType: "radiant", provenance: "spell-base"}]},
      ruleElements: [{schemaVersion: 1, id: "smite", type: "Trigger", data: {kind: "reaction", event: "attack.hit",
        match: {phase: "interrupt", sourceTokenId: "{self}", tagsAll: ["melee"]}, ...(once ? {once: "turn"} : {})}}]}};
    sourceActor.items = new (class extends Map { [Symbol.iterator]() { return this.values(); } })([...sourceActor.items.entries(),
      ...(items ?? [smite]).map(item => [item.id, item])]);
    sourceActor.system.resources.reaction = {value: 1, max: 1};
    // Its own extra damage on this attack (a Sneak Attack).
    if ( extra ) sourceActor.getExtraDamage = domains => (domains.includes("damage.weapon") ? structuredClone(extra) : []);
  } else if ( holderItems ) holder.items = holderItems;
  else holder.items = [{id: "counter", type: "action", name: "Counterattack", system: {active: true,
    definition: {schemaVersion: 1, id: "action:counterattack", label: "Counterattack",
      costs: {allOf: [{capability: ECONOMY_CAPABILITIES.REACTION, amount: 1}]},
      range: {type: "reach", distance: {value: 5, unit: "ft"}}, targeting: {type: "single", required: true, count: 1},
      attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
      damage: [{id: "riposte", expression: {type: "constant", value: 3}, damageType: "slashing", provenance: "weapon-base"}]},
    ruleElements: [{schemaVersion: 1, id: "riposte", type: "Trigger", data: {kind: "reaction", event,
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
  const asked = [];
  const posts = [];
  // The GM rolls the counterattack; its requests are kept for their roll mode.
  const gmRollRequests = [];
  const playerRollRequests = [];
  const playerRolls = provider => ({...provider, execute: request => { playerRollRequests.push(request); return provider.execute(request); }});
  const gmProvider = createTestRollProvider({result: {natural: 15, total: 15}, ...(gmQueue ? {queue: gmQueue} : {})});
  const gmRolls = {...gmProvider, execute: request => { gmRollRequests.push(request); return gmProvider.execute(request); }};
  const gm = createMultiplayerActionCoordinator({userId: "gm-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}), publishResult: post => { posts.push(post); },
    ...(gmMessageMode ? {rollContext: {messageMode: gmMessageMode}} : {}), ...(afterChild ? {afterChildCompleted: afterChild} : {}),
    // One answer for each creature asked in turn (a bard's Cutting Words, then the target's own reaction).
    promptPorts: [createTestPromptAdapter({id: "counterattack-choice", queue: Array.from({length: 2}, () => request => {
      offers.push(request);
      return decision === "use" ? {decision, candidateId: request.payload.candidates[0].id} : {decision};
    })})],
    rollProviders: [gmRolls],
    actionIntentResolver: ({intent, envelope}) => foundryActionIntentToStagedOptions({intent,
      senderUserId: envelope.senderUserId, game, persistencePort})});
  const player = createMultiplayerActionCoordinator({userId: "player-a", users: () => hub.userDirectory(),
    activeGMUserId: "gm-a", transport: hub.createEndpoint({userId: "player-a"}),
    // Its own reactions: the first candidate, or the one `pick` names (a Brutal Strike's blow).
    ...(reactor === "source" ? {promptPorts: [createTestPromptAdapter({id: "smite-choice", queue: Array.from({length: 4}, () => request => {
      // A choice its reaction asks for (whom it acts on): the Token `choose` names (or returns), else the default.
      if ( !request.payload?.candidates ) {
        asked.push(request);
        // Its Action's configuration (a damage type): `choose` for each choice it asks, or closed ("close").
        if ( (request.type === "action-configuration") && (decision === "close") ) return {ok: false,
          status: PROMPT_PORT_OUTCOMES.CANCELLED, code: CHOICE_COORDINATOR_CODES.PROMPT_CANCELLED, reason: "Prompt was cancelled."};
        if ( request.type === "action-configuration" ) return {choices: Object.fromEntries(request.payload.requests
          .map(entry => [entry.id, choose ?? entry.defaultValue]))};
        return {choices: {[request.payload.id]: (typeof choose === "function" ? choose(request, scene) : choose) ?? request.payload.defaultValue}};
      }
      offers.push(request);
      if ( decision === "decline" ) return {decision};
      const candidates = request.payload.candidates;
      // A landing for an aimed push (`point`), as the client's placement gives it.
      return {decision: "use", candidateId: (candidates.find(candidate => pick && String(candidate.actionId ?? "").includes(pick)) ?? candidates[0]).id,
        ...(point ? {point} : {})};
    })})]} : {}),
    // Its attack, then (its own reaction's) 2d8 or 4d8.
    rollProviders: [playerRolls(createTestRollProvider({queue: queue ?? (reactor === "source" ? [{natural: natural ?? 18, total: (natural ?? 18) + 4}, {total: 9}] : []),
      result: {natural: natural ?? 18, total: 22}}))]});
  gm.register();
  player.register();
  return {...fixture, gm, player, offers, asked, holder, posts, gmRollRequests, playerRollRequests};
}

for ( const decision of ["use", "decline"] ) test(`a counterattack Trigger on the target's Token is offered after the hit and ${decision === "use" ? "strikes the attacker" : "can be declined"}`, async t => {
  const {sourceActor, targetActor, sourceToken, targetToken, gm, player, offers, posts, intent} = counterattackFixture(t, {decision});
  const declared = await player.declareActionIntent(intent);
  assert.equal(declared.ok, true, JSON.stringify(declared));
  const record = gm.getRecord(declared.resolutionId);
  assert.ok(record, JSON.stringify({gm: gm.errors, player: player.errors}).slice(0, 2000));
  const active = record.state.metadata?.activeChildResolution;
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify({errors: record.state.errors,
    pending: record.state.pendingRequests.map(r => [r.id, r.type, r.chooser]), child: active && {status: active.status,
      pending: active.pendingRequests?.map(r => [r.id, r.type, r.chooser, r.authority]), errors: active.errors},
    expectations: [...record.requestExpectations.values()].map(e => [e.request?.id, e.recipientUserIds ?? e.userIds]),
    gmErrors: gm.errors, playerErrors: player.errors}).slice(-2500));
  assert.equal(offers.length, 1, "the GM, who controls the target, was offered the reaction once");
  assert.equal(offers[0].payload.candidates.length, 1);
  assert.equal(targetActor.system.resources.health.value, 24, "the attack's own damage still lands");
  if ( decision === "use" ) {
    assert.equal(sourceActor.system.resources.health.value, 17, "the counterattack hit the attacker for 3");
    assert.equal(targetActor.system.resources.reaction.value, 0, "the target spent its reaction");
    assert.deepEqual(posts.map(post => [post.result.action?.name, post.initiatorUserId, post.messageMode]),
      [["Counterattack", "gm-a", null], ["Runtime Melee Strike", "player-a", null]],
      "the reaction posts its own public card, authored by its controller, before the Action's card");
    assert.deepEqual(posts.map(post => post.result.source?.tokenRef), [targetToken.uuid, sourceToken.uuid],
      "each card knows the Token its Action was used from, so that Token speaks");
    assert.equal(JSON.stringify(posts[0].result).includes('"defense"'), false, "the card sees only the public projection");
  } else {
    assert.equal(sourceActor.system.resources.health.value, 20);
    assert.equal(targetActor.system.resources.reaction.value, 1);
  }
});

test("a hit offer's aimed push (Gathered Swarm, Q56): accepted with a landing, its completed child goes to the push follow-up with it", async t => {
  const swarm = dc => ({id: "swarm", type: "action", name: "Swarm (Push)", system: {active: true,
    definition: {schemaVersion: 1, id: "action:swarm-push", label: "Swarm (Push)", costs: {allOf: []}, range: {type: "special"},
      targeting: {type: "single", required: true, count: 1}, save: {ability: "might", dc: {value: dc}}, push: {distance: 15, choose: "space"}},
    ruleElements: [{schemaVersion: 1, id: "swarm", type: "Trigger", data: {kind: "reaction", event: "attack.hit",
      match: {phase: "interrupt", sourceTokenId: "{self}"}}}]}});
  const run = async (dc, point) => {
    const followed = [];
    const {gm, player, offers, intent} = counterattackFixture(t, {reactor: "source", items: [swarm(dc)], point,
      afterChild: ({state}) => { followed.push(state); }});
    const declared = await player.declareActionIntent(intent);
    assert.equal(gm.getRecord(declared.resolutionId)?.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
    return {offers, followed};
  };
  const failed = await run(20, {x: 160, y: 10});
  const aim = failed.offers[0].payload.candidates[0].aim;
  assert.deepEqual([aim.tokenId, aim.push, aim.range.type], ["target-token", {distance: 15, choose: "space"}, "special"], "the offer says whom it moves");
  assert.equal(failed.followed.length, 1, "its completed child, once");
  assert.deepEqual(failed.followed[0].input.pushTo, {tokenId: "target-token", x: 160, y: 10});
  assert.equal(failed.followed[0].results.saveResolution.results[0].success, false, "the push follows the child's own save");
  const saved = await run(10, {x: 160, y: 10});
  assert.equal(saved.followed[0].results.saveResolution.results[0].success, true, "a made save: forced movement moves nobody (pushedTargets)");
});

test("a reaction's plain push (Open Hand Technique (Push)) moves the creature that failed its save once the reaction completes, not one that saved", async t => {
  const {createFoundryForcedMovement} = await import("../module/adapters/foundry-v14-forced-movement.mjs");
  const push = dc => ({id: "palm", type: "action", name: "Open Hand (Push)", system: {active: true,
    definition: {schemaVersion: 1, id: "action:palm-push", label: "Open Hand (Push)", costs: {allOf: []}, range: {type: "special"},
      targeting: {type: "single", required: true, count: 1}, save: {ability: "might", dc: {value: dc}}, push: {distance: 15}},
    ruleElements: [{schemaVersion: 1, id: "palm", type: "Trigger", data: {kind: "reaction", event: "attack.hit",
      match: {phase: "interrupt", sourceTokenId: "{self}"}}}]}});
  const run = async dc => {
    let fixture = null;
    // As the runtime wires it (afterChildCompleted: the forced-movement adapter on the child's own state).
    const afterChild = async ({state}) => createFoundryForcedMovement({game: {user: {id: "gm-a"}, users: {activeGM: {id: "gm-a"}}},
      fromUuid: () => fixture.sourceToken}).afterResolution({state});
    fixture = counterattackFixture(t, {reactor: "source", items: [push(dc)], afterChild});
    fixture.scene.walls = [];
    for ( const token of fixture.scene.tokens ) Object.assign(token, {updates: [],
      getCenterPoint: (at=token) => ({x: at.x + 25, y: at.y + 25}),
      getSnappedPosition: at => ({x: Math.round(at.x / 50) * 50, y: Math.round(at.y / 50) * 50}),
      getOccupiedGridSpaceOffsets: (at=token) => [{i: Math.floor(at.x / 50), j: Math.floor(at.y / 50)}],
      update: async (data, operation) => { token.updates.push({data, operation}); Object.assign(token, data); }});
    const declared = await fixture.player.declareActionIntent(fixture.intent);
    assert.equal(fixture.gm.getRecord(declared.resolutionId)?.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
    return fixture.targetToken.updates;
  };
  assert.deepEqual(await run(20), [{data: {x: 200, y: 0}, operation: {wildpath: {movementKind: "forced"}}}], "failed: pushed 15 feet away");
  assert.deepEqual(await run(10), [], "saved: not moved");
});

test("a reaction's card follows its chooser's message mode", async t => {
  const {gm, player, posts, intent} = counterattackFixture(t, {gmMessageMode: "gm"});
  const declared = await player.declareActionIntent(intent);
  assert.equal(gm.getRecord(declared.resolutionId)?.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.deepEqual(posts.map(post => [post.result.action?.name, post.messageMode]), [["Counterattack", "gm"], ["Runtime Melee Strike", null]],
    "the GM chose the counterattack in GM-only mode; the player's own Action keeps theirs");
  // Live 2026-11-14: a GM-only card showed the GM none of its rolls. Whispered to the GMs alone, it shows them all, and
  // the counterattack's fixed 3 damage as openly as its attack roll (live 9, 4c).
  assert.deepEqual(posts.map(post => [post.result.disclosure, post.result.rolls.map(roll => [roll.type, roll.visibility, roll.total])]),
    [["GM_PRIVATE", [["attack-roll", "gm-only", 15], ["fixed-damage", "gm-only", 3]]], ["BROADCAST_SAFE", []]],
    "the public card keeps public rolls only");
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

for ( const critical of [false, true] ) test(`a creature's own Trigger answers its own hit (2014 Divine Smite): no Reaction spent, the creature hit takes it${critical ? ", dice doubled on a critical hit" : ""}`, async t => {
  const {sourceActor, targetActor, player, gm, offers, intent, playerRollRequests} = counterattackFixture(t, {reactor: "source",
    natural: critical ? 20 : null});
  const declared = await player.declareActionIntent(intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.ok(record, JSON.stringify(gm.errors).slice(0, 2000));
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors));
  assert.equal(offers.length, 1, "offered to the attacker's own controller");
  assert.equal(sourceActor.system.resources.reaction.value, 1, "no Reaction spent");
  const smite = playerRollRequests.find(request => request.definition?.dice?.[0]?.id === "smite:die:0");
  assert.equal(smite?.definition.dice[0].number, critical ? 4 : 2);
  assert.equal(targetActor.system.resources.health.value, 15, "the attack's 6 and the smite's 9 both land");
});

test("a reaction's rider on the attack it answers (Cunning Strike): a Sneak Attack die forgone, and 1d10 more on its damage roll", async t => {
  const {targetActor, player, gm, offers, intent, playerRollRequests} = counterattackFixture(t, {reactor: "source",
    rider: {forgoDice: {ruleId: "sneak-attack", dice: 1}, damage: [{id: "brutal", expression: {type: "dice", number: 1, faces: 10}}]},
    extra: [{id: "sneak-attack", expression: {type: "dice", number: 3, faces: 6}}],
    queue: [{natural: 18, total: 22}, {total: 9}, {total: 5}, {total: 4}]});
  const declared = await player.declareActionIntent(intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.equal(offers.length, 1);
  const rolled = playerRollRequests.filter(request => request.type === "damage").map(request => request.definition.dice
    .map(die => `${die.number}d${die.faces}`).join("+"));
  assert.deepEqual(rolled, ["2d8", "2d6", "1d10"], "the smite; then 3d6 less one, and the rider's 1d10");
  assert.equal(targetActor.system.resources.health.value, 6, "the smite's 9, the weapon's 6, 5 and 4");
});

test("a rider's damage is one hit with its attack's: Resistance halves the type's total, not each part (Q20)", async t => {
  const {targetActor, player, gm, intent} = counterattackFixture(t, {reactor: "source",
    rider: {forgoDice: {ruleId: "sneak-attack", dice: 1}, damage: [{id: "brutal", expression: {type: "dice", number: 1, faces: 10}}]},
    extra: [{id: "sneak-attack", expression: {type: "dice", number: 3, faces: 6}}],
    queue: [{natural: 18, total: 22}, {total: 9}, {total: 5}, {total: 3}]});
  targetActor.getDamageProfile = () => damageProfileFromRuleElements([{ruleElements: [
    {schemaVersion: 1, id: "hide", type: "GrantResistance", data: {damageTypes: ["slashing"]}}]}]);
  const declared = await player.declareActionIntent(intent);
  assert.equal(gm.getRecord(declared.resolutionId).state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(targetActor.system.resources.health.value, 14, "the smite's 9 radiant, and half of 6 + 5 + 3 slashing (7, not 3 + 2 + 1)");
});

test("Brutal Strike: a reckless Strength attack gives up its Advantage for 1d10 more, and a blow follows the hit", async t => {
  const fs = await import("node:fs");
  const pack = name => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${fs.readdirSync("packs/_source/srd-items")
    .find(file => file.startsWith(name))}`, "utf8"));
  const brutal = ["brutal-strike-64ccyd1w6x7hf000", "brutal-strike-forceful-blow", "brutal-strike-hamstring-blow"].map(pack)
    .map(item => ({id: item._id, type: "action", name: item.name, system: item.system}));
  const {sourceActor, player, gm, offers, intent, playerRollRequests} = counterattackFixture(t, {reactor: "source", items: brutal,
    pick: "hamstring", queue: [{natural: 18, total: 22}, {total: 4}]});
  sourceActor.statuses = new Set(["reckless"]);
  sourceActor.getRollModes = domains => (domains.includes("attack") ? [{id: "reckless", mode: "advantage"}] : []);
  sourceActor.system.classes = [{id: "barbarian", level: 9}];
  const declared = await player.declareActionIntent(intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.deepEqual(offers.map(offer => offer.payload.candidates.map(candidate => candidate.actionId)),
    [["action:srd-brutal-strike"], ["action:srd-brutal-strike-forceful-blow", "action:srd-brutal-strike-hamstring-blow"]]);
  assert.equal(playerRollRequests[0].rollMode, "normal", "its Advantage given up");
  assert.ok(playerRollRequests.some(request => (request.type === "damage") && request.definition.dice.some(die => die.faces === 10)), "1d10 more");
});

test("an injury poison's coat: its next weapon hit offers the poison's save to the creature hit", async t => {
  const fs = await import("node:fs");
  const venom = JSON.parse(fs.readFileSync(`packs/_source/srd-items/${fs.readdirSync("packs/_source/srd-items")
    .find(file => file.startsWith("serpent-venom"))}`, "utf8"));
  const coat = venom.system.definition.effects[0];
  const {sourceActor, player, gm, offers, intent} = counterattackFixture(t, {reactor: "source", items: [],
    queue: [{natural: 18, total: 22}, {total: 4}], gmQueue: [{natural: 2, total: 2}]});
  sourceActor.effects = [{id: "coat", name: coat.name, disabled: false, system: {ruleElements: coat.ruleElements}, flags: {}}];
  const declared = await player.declareActionIntent(intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.deepEqual(offers.map(offer => offer.payload.candidates.map(candidate => candidate.actionId)),
    [["action:srd-serpent-venom-use-poison:coat"]], "offered on the weapon hit");
});

test("Cutting Words (Damage): a bard's die comes off another creature's damage roll", async t => {
  const fs = await import("node:fs");
  const words = JSON.parse(fs.readFileSync("packs/_source/srd-items/cutting-words-damage-1lx8h2edtoko0000.json", "utf8"));
  const taken = async decision => {
    const {targetActor, holder, gm, player, offers, intent} = counterattackFixture(t, {reactor: "bystander", decision,
      holderItems: [{id: words._id, type: "action", name: words.name, system: words.system}], gmQueue: [{total: 3}]});
    holder.system.classes = [{id: "bard", level: 10}];
    holder.system.pools = [{id: "bardic-inspiration", value: 2, max: 2}];
    const declared = await player.declareActionIntent(intent);
    assert.equal(gm.getRecord(declared.resolutionId).state.status, RESOLUTION_STATE_STATUS.COMPLETED);
    return {offered: offers.length, damage: 30 - targetActor.system.resources.health.value};
  };
  const plain = await taken("decline");
  const cut = await taken("use");
  assert.deepEqual([plain.offered, cut.offered], [1, 1], "offered on the hostile attacker's damage roll");
  assert.ok(plain.damage > 3, `the attack deals ${plain.damage}`);
  assert.equal(cut.damage, plain.damage - 3, "the 3 it rolled comes off that damage");
});

test("Cutting Words: a bard's die comes off another creature's hit, which is checked again and misses", async t => {
  const fs = await import("node:fs");
  const words = JSON.parse(fs.readFileSync("packs/_source/srd-items/cutting-words-phbbrdCuttingWor.json", "utf8"));
  const {targetActor, holder, gm, player, offers, intent} = counterattackFixture(t, {reactor: "bystander",
    holderItems: [{id: words._id, type: "action", name: words.name, system: words.system}], gmQueue: [{total: 10}]});
  holder.system.classes = [{id: "bard", level: 10}];
  holder.system.pools = [{id: "bardic-inspiration", value: 2, max: 2}];
  const declared = await player.declareActionIntent(intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.equal(offers.length, 1, "offered to the bard");
  assert.equal(record.state.results.attackResolution.hits.length, 0, "22 less a d10 of 10: 12 against AC 14");
  assert.equal(targetActor.system.resources.health.value, 30, "no damage");
  assert.equal(holder.system.resources.reaction.value, 0);
  assert.equal(holder.system.pools.find(pool => pool.id === "bardic-inspiration").value, 1);
});

test("two options sharing a once-key with uses 2 (Improved Cunning Strike) are both taken on one hit, one after the other", async t => {
  const previous = globalThis.game;
  globalThis.game = {combat: {id: "c", round: 1, turn: 0, started: true}};
  t.after(() => { globalThis.game = previous; });
  const option = (id, value) => ({id, type: "action", name: id, system: {active: true,
    definition: {schemaVersion: 1, id: `action:${id}`, label: id, costs: {allOf: []}, range: {type: "special"},
      targeting: {type: "single", required: true, count: 1},
      damage: [{id, expression: {type: "constant", value}, damageType: "poison", provenance: "spell-base"}]},
    ruleElements: [{schemaVersion: 1, id, type: "Trigger", data: {kind: "reaction", event: "attack.hit",
      match: {phase: "interrupt", sourceTokenId: "{self}"}, once: "turn", onceKey: "cunning", uses: 2}}]}});
  const {targetActor, player, gm, offers, intent} = counterattackFixture(t, {reactor: "source",
    items: [option("poison", 2), option("trip", 3)], queue: [{natural: 18, total: 22}]});
  const declared = await player.declareActionIntent(intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.deepEqual(offers.map(offer => offer.payload.candidates.map(candidate => candidate.actionId)),
    [["action:poison", "action:trip"], ["action:trip"]], "the other offered again after the first");
  assert.equal(targetActor.system.resources.health.value, 30 - 6 - 2 - 3);
});

test("two options sharing a key with uses 2 and no once a turn (Rend Mind's free and paid uses, Q53) are both taken on one hit and recorded nowhere", async t => {
  const previous = globalThis.game;
  globalThis.game = {combat: {id: "c", round: 1, turn: 0, started: true}};
  t.after(() => { globalThis.game = previous; });
  const option = (id, value) => ({id, type: "action", name: id, system: {active: true,
    definition: {schemaVersion: 1, id: `action:${id}`, label: id, costs: {allOf: []}, range: {type: "special"},
      targeting: {type: "single", required: true, count: 1},
      damage: [{id, expression: {type: "constant", value}, damageType: "psychic", provenance: "spell-base"}]},
    ruleElements: [{schemaVersion: 1, id, type: "Trigger", data: {kind: "reaction", event: "attack.hit",
      match: {phase: "interrupt", sourceTokenId: "{self}"}, onceKey: "rend-mind", uses: 2}}]}});
  const {sourceActor, targetActor, player, gm, offers, intent} = counterattackFixture(t, {reactor: "source",
    items: [option("free", 2), option("paid", 3)], queue: [{natural: 18, total: 22}]});
  const declared = await player.declareActionIntent(intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.deepEqual(offers.map(offer => offer.payload.candidates.map(candidate => candidate.actionId)),
    [["action:free", "action:paid"], ["action:paid"]], "the other offered again after the first");
  assert.equal(targetActor.system.resources.health.value, 30 - 6 - 2 - 3);
  assert.equal(sourceActor.flags?.wildpath?.onceUsed?.["rend-mind"], undefined, "no once-a-turn record: a later hit offers both again");
});

for ( const decision of ["use", "decline"] ) test(`an effect's retaliation and the attacker's own save, both used at once at no cost, wait for the target's asked reaction (${decision}) and both resolve`, async t => {
  const free = (id, damageType, value) => ({schemaVersion: 1, id: `action:${id}`, label: id, costs: {allOf: []}, range: {type: "special"},
    targeting: {type: "single", required: true, count: 1},
    damage: [{id, expression: {type: "constant", value}, damageType, provenance: "spell-base"}]});
  const {sourceActor, targetActor, gm, player, offers, intent} = counterattackFixture(t, {decision});
  // Fire Shield's shape: a Trigger with its own Action on the target's effect, used at once (`policy: "always"`).
  targetActor.effects = [{id: "warm-shield", name: "Warm Shield", disabled: false, flags: {}, system: {ruleElements: [{schemaVersion: 1,
    id: "retaliation", type: "Trigger", data: {kind: "reaction", event: "attack.hit", policy: "always",
      match: {phase: "interrupt", targetTokenId: "{self}", tagsAny: ["melee"]}, action: free("flame", "fire", 4)}}]}}];
  // A Ghoul's Claw save's shape: its own hit, used at once.
  const claw = {id: "claw", type: "action", name: "Claw", flags: {wildpath: {reactionPolicy: "always"}}, system: {active: true,
    definition: free("claw", "poison", 2), ruleElements: [{schemaVersion: 1, id: "claw", type: "Trigger", data: {kind: "reaction",
      event: "attack.hit", match: {phase: "interrupt", sourceTokenId: "{self}"}}}]}};
  sourceActor.items = new (class extends Map { [Symbol.iterator]() { return this.values(); } })([...sourceActor.items.entries(), ["claw", claw]]);
  const declared = await player.declareActionIntent(intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.deepEqual(offers.map(offer => offer.payload.candidates.map(candidate => candidate.actionId)), [["action:counterattack"]],
    "only the Counterattack is asked about, first");
  assert.equal(sourceActor.system.resources.health.value, 20 - 4 - (decision === "use" ? 3 : 0), "the flame burns the attacker");
  assert.equal(targetActor.system.resources.health.value, 30 - 6 - 2, "the attack and its claw's own damage land");
});

test("two creatures' reactions to one hit: once the bard's Cutting Words leaves it a hit, the target is still asked for its own", async t => {
  const fs = await import("node:fs");
  const words = JSON.parse(fs.readFileSync("packs/_source/srd-items/cutting-words-phbbrdCuttingWor.json", "utf8"));
  const {sourceActor, targetActor, holder, gm, player, offers, intent} = counterattackFixture(t, {reactor: "bystander",
    holderItems: [{id: words._id, type: "action", name: words.name, system: words.system}], gmQueue: [{total: 1}]});
  holder.system.classes = [{id: "bard", level: 10}];
  holder.system.pools = [{id: "bardic-inspiration", value: 2, max: 2}];
  targetActor.items = [{id: "counter", type: "action", name: "Counterattack", system: {active: true,
    definition: {schemaVersion: 1, id: "action:counterattack", label: "Counterattack",
      costs: {allOf: [{capability: ECONOMY_CAPABILITIES.REACTION, amount: 1}]},
      range: {type: "reach", distance: {value: 5, unit: "ft"}}, targeting: {type: "single", required: true, count: 1},
      attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
      damage: [{id: "riposte", expression: {type: "constant", value: 3}, damageType: "slashing", provenance: "weapon-base"}]},
    ruleElements: [{schemaVersion: 1, id: "riposte", type: "Trigger", data: {kind: "reaction", event: "attack.hit",
      match: {phase: "interrupt", targetTokenId: "{self}"}}}]}}];
  const declared = await player.declareActionIntent(intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.deepEqual(offers.map(offer => offer.payload.candidates.map(candidate => candidate.actionId)),
    [[words.system.definition.id], ["action:counterattack"]], "each creature asked once, in order");
  assert.equal(record.state.results.attackResolution.hits.length, 1, "22 less 1 still hits AC 14");
  assert.deepEqual([holder.system.resources.reaction.value, targetActor.system.resources.reaction.value], [0, 0],
    "each spent its own Reaction");
  assert.equal(sourceActor.system.resources.health.value, 17, "the counterattack hit the attacker for 3");
  assert.equal(targetActor.system.resources.health.value, 24, "the attack's own damage still lands");
});

test("an effect's retaliation is not used when an asked reaction turned the hit into a miss (Cutting Words)", async t => {
  const fs = await import("node:fs");
  const words = JSON.parse(fs.readFileSync("packs/_source/srd-items/cutting-words-phbbrdCuttingWor.json", "utf8"));
  const {sourceActor, targetActor, holder, gm, player, offers, intent} = counterattackFixture(t, {reactor: "bystander",
    holderItems: [{id: words._id, type: "action", name: words.name, system: words.system}], gmQueue: [{total: 10}]});
  holder.system.classes = [{id: "bard", level: 10}];
  holder.system.pools = [{id: "bardic-inspiration", value: 2, max: 2}];
  targetActor.effects = [{id: "warm-shield", name: "Warm Shield", disabled: false, flags: {}, system: {ruleElements: [{schemaVersion: 1,
    id: "retaliation", type: "Trigger", data: {kind: "reaction", event: "attack.hit", policy: "always",
      match: {phase: "interrupt", targetTokenId: "{self}"}, action: {schemaVersion: 1, id: "action:flame", label: "Flame",
        costs: {allOf: []}, range: {type: "special"}, targeting: {type: "single", required: true, count: 1},
        damage: [{id: "flame", expression: {type: "constant", value: 4}, damageType: "fire", provenance: "spell-base"}]}}}]}}];
  const declared = await player.declareActionIntent(intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.equal(offers.length, 1, "the bard is asked first");
  assert.equal(record.state.results.attackResolution.hits.length, 0, "the hit became a miss");
  assert.equal(sourceActor.system.resources.health.value, 20, "so the flame does not burn the attacker");
});

test("on a critical hit, its own reaction without damage (Trip) still resolves", async t => {
  const trip = {id: "trip", type: "action", name: "Trip", system: {active: true,
    definition: {schemaVersion: 1, id: "action:trip", label: "Trip", costs: {allOf: []}, range: {type: "special"},
      targeting: {type: "single", required: true, count: 1}, effects: [{id: "prone", type: "condition", conditionId: "prone"}]},
    ruleElements: [{schemaVersion: 1, id: "trip", type: "Trigger", data: {kind: "reaction", event: "attack.hit",
      match: {phase: "interrupt", sourceTokenId: "{self}"}}}]}};
  const {player, gm, offers, intent} = counterattackFixture(t, {reactor: "source", items: [trip], natural: 20,
    queue: [{natural: 20, total: 24}]});
  const declared = await player.declareActionIntent(intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.equal(offers.length, 1);
  assert.equal((record.state.results.reactions ?? []).some(entry => entry.childFailed), false, "the child did not fail");
});

test("a once-a-turn Trigger on its own hit (Stunning Strike) records its use for the combat turn, and is not offered again", async t => {
  const previous = globalThis.game;
  globalThis.game = {combat: {id: "c", round: 1, turn: 0, started: true}};
  t.after(() => { globalThis.game = previous; });
  const {sourceActor, gm, player, offers, intent, game} = counterattackFixture(t, {reactor: "source", once: true});
  const declared = await player.declareActionIntent(intent);
  assert.equal(gm.getRecord(declared.resolutionId).state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(offers.length, 1);
  assert.deepEqual(sourceActor.flags?.wildpath?.onceUsed, {"smite-smite": "c:1:0"}, "its use is recorded for this turn");
  const services = game.wildpath.reactionServices({scene: game.scenes.contents?.[0] ?? [...game.scenes.values()][0],
    token: sourceActor.token});
  assert.equal((services.reactions?.triggers ?? []).some(trigger => trigger.owner.tokenId === sourceActor.token.id), false,
    "not offered again this turn");
});

for ( const turn of ["own", "another's"] ) test(`an ownTurn Trigger on its own hit ("on each of your turns": Divine Fury) is offered only on its creature's own turn: ${turn}`, async t => {
  const previous = globalThis.game;
  globalThis.game = {combat: {id: "c", round: 1, turn: 0, started: true, combatant: null}};
  t.after(() => { globalThis.game = previous; });
  const fury = {id: "fury", type: "action", name: "Fury", system: {active: true,
    definition: {schemaVersion: 1, id: "action:fury", label: "Fury", costs: {allOf: []}, range: {type: "special"},
      targeting: {type: "single", required: true, count: 1},
      damage: [{id: "fury", expression: {type: "constant", value: 2}, damageType: "radiant", provenance: "feature"}]},
    ruleElements: [{schemaVersion: 1, id: "fury", type: "Trigger", data: {kind: "reaction", event: "attack.hit",
      match: {phase: "interrupt", sourceTokenId: "{self}"}, ownTurn: true}}]}};
  const {sourceToken, targetToken, gm, player, offers, intent} = counterattackFixture(t, {reactor: "source", items: [fury]});
  globalThis.game.combat.combatant = {tokenId: (turn === "own") ? sourceToken.id : targetToken.id};
  const declared = await player.declareActionIntent(intent);
  assert.equal(gm.getRecord(declared.resolutionId).state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(offers.length, (turn === "own") ? 1 : 0);
});

/** Divine Fury (Q52): an own-hit Trigger once a turn, its 2 Necrotic or Radiant chosen; `attack` makes another hit. */
function divineFuryFixture(t, {policy="always", decision="use"}={}) {
  const previous = globalThis.game;
  globalThis.game = {combat: {id: "c", round: 1, turn: 0, started: true, combatant: null}};
  t.after(() => { globalThis.game = previous; });
  const fury = {id: "fury", type: "action", name: "Fury", flags: {wildpath: {reactionPolicy: policy}}, system: {active: true,
    definition: {schemaVersion: 1, id: "action:fury", label: "Fury", costs: {allOf: []}, range: {type: "special"},
      targeting: {type: "single", required: true, count: 1},
      damage: [{id: "damage-1", expression: {type: "constant", value: 2}, damageType: "necrotic", provenance: "additional"}],
      configuration: [{id: "damage-type-1", type: "damage-type", label: "Damage type", required: true, allowedDamageTypes: ["necrotic", "radiant"],
        effects: [{type: "replaceDamageType", componentIds: ["damage-1"], damageTypeChoiceId: "damage-type-1"}]}]},
    ruleElements: [{schemaVersion: 1, id: "fury", type: "Trigger", data: {kind: "reaction", event: "attack.hit",
      match: {phase: "interrupt", sourceTokenId: "{self}"}, once: "turn", onceKey: "divine-fury", ownTurn: true}}]}};
  const {sourceActor, sourceToken, targetActor, gm, player, offers, asked, intent} = counterattackFixture(t, {reactor: "source", items: [fury],
    decision, choose: "radiant", queue: Array.from({length: 3}, () => ({natural: 18, total: 22}))});
  globalThis.game.combat.combatant = {tokenId: sourceToken.id};
  // Immune to Necrotic: the chosen type, not the listed one, is what lands.
  targetActor.getDamageProfile = () => damageProfileFromRuleElements([{ruleElements: [{schemaVersion: 1, id: "ward", type: "GrantImmunity",
    data: {damageTypes: ["necrotic"]}}]}]);
  const attack = async (status=RESOLUTION_STATE_STATUS.COMPLETED) => {
    // Another attack the same turn (Extra Attack).
    sourceActor.system.resources.action = {value: 1, max: 1};
    const declared = await player.declareActionIntent(intent);
    const record = gm.getRecord(declared.resolutionId);
    assert.equal(record.state.status, status, JSON.stringify(record.state.errors).slice(0, 1500));
  };
  return {sourceActor, targetActor, offers, asked, attack};
}

test("an automatic once-a-turn Trigger on its own hit with a damage-type choice (Divine Fury, Q52) asks only the type, deals it and waits for the next turn", async t => {
  const {sourceActor, targetActor, offers, asked, attack} = divineFuryFixture(t);
  await attack();
  assert.equal(offers.length, 0, "no Use or Decline: it is used on the hit");
  assert.deepEqual(asked.map(request => [request.type, request.payload.requests.map(entry => entry.id)]),
    [["action-configuration", ["damage-type-1"]]], "only its type, asked of its controller");
  assert.equal(targetActor.system.resources.health.value, 30 - 6 - 2, "the attack's 6 and Fury's 2 Radiant");
  assert.deepEqual(sourceActor.flags?.wildpath?.onceUsed, {"divine-fury": "c:1:0"}, "spent for this turn");
  await attack();
  assert.equal(asked.length, 1, "a second hit this turn asks nothing");
  assert.equal(targetActor.system.resources.health.value, 30 - 6 - 2 - 6);
  globalThis.game.combat.round = 2;
  await attack();
  assert.equal(asked.length, 2, "its next turn's first hit uses it again");
});

// Q116 (a)'s default: only the rider's own commit spends the turn's use.
for ( const [policy, decision] of [["ask", "decline"], ["always", "close"]] ) test(`a once-a-turn hit rider ${decision === "decline"
  ? "declined" : "whose type prompt is closed"} spends nothing, so the turn's next hit offers it again (Q116)`, async t => {
  const {sourceActor, targetActor, offers, asked, attack} = divineFuryFixture(t, {policy, decision});
  const prompts = () => offers.length + asked.length;
  // A closed prompt ends its whole Action, as any closed prompt does: that attack then lands nothing either.
  const closed = decision === "close";
  await attack(closed ? RESOLUTION_STATE_STATUS.CANCELLED : RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(prompts(), 1);
  assert.equal(targetActor.system.resources.health.value, closed ? 30 : 30 - 6, closed ? "nothing" : "the attack's 6 only");
  assert.equal(sourceActor.flags?.wildpath?.onceUsed?.["divine-fury"], undefined, "not spent");
  await attack(closed ? RESOLUTION_STATE_STATUS.CANCELLED : RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(prompts(), 2, "asked again on the same turn");
});

/** A 5-ft radial burst, 6 damage, cast from (0,0) at range 30 ft. A bystander stands at (5,0). */
function areaFixture(t, {range=30, persistence=null, shape="radial", size=5, self=false, tags=null}={}) {
  const definition = {schemaVersion: 1, id: "action:runtime-burst", label: "Runtime Burst", ...(tags ? {tags} : {}),
    costs: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]},
    range: self ? {type: "self"} : {type: "ranged", normal: {value: range, unit: "ft"}}, targeting: {type: "area"},
    area: {shape, size: {value: size, unit: "ft"}, ...(persistence ? {persistence} : {})},
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

test("a Cube (2024) is a block of fields: centered where it is cast, or against its caster's edge toward the click", async t => {
  // The caster stands on field (0,0), the target on (1,0) and a bystander on (5,0); fields are 50 px.
  const caught = async (options, point) => {
    const {game, intent} = areaFixture(t, {shape: "cube", ...options});
    const resolved = await foundryActionIntentToStagedOptions({intent: {...intent, area: {points: [point]}}, senderUserId: "player-a", game});
    assert.equal(resolved.ok, true, resolved.reason);
    return resolved.options.targets.map(target => target.tokenId);
  };
  assert.deepEqual(await caught({size: 10}, {x: 75, y: 25}), ["target-token"], "a 10-ft Cube at the target: two fields across");
  assert.deepEqual(await caught({size: 10}, {x: 275, y: 25}), ["far-token"], "and at the bystander");
  assert.deepEqual(await caught({size: 15, self: true}, {x: 175, y: 25}), ["target-token"],
    "a 15-ft Cube originating from the caster lies against its edge, toward the click, and leaves the caster out");
  // A "self" range limits where the area goes, not whom it covers: the target 5 ft away is hit.
  const fixture = areaFixture(t, {shape: "cube", size: 15, self: true});
  const resolved = await foundryActionIntentToStagedOptions({intent: {...fixture.intent, area: {points: [{x: 175, y: 25}]}},
    senderUserId: "player-a", game: fixture.game});
  const planned = planStagedActionResolution(resolved.options);
  assert.equal(planned.state.status, "ready-to-commit", JSON.stringify(planned.state.errors ?? planned.state.trace?.at(-1)));
  const {game, intent} = areaFixture(t, {shape: "cube", size: 10, range: 5});
  const far = await foundryActionIntentToStagedOptions({intent: {...intent, area: {points: [{x: 275, y: 25}]}}, senderUserId: "player-a", game});
  assert.deepEqual([far.ok, far.reason], [false, "That point is out of range."]);
});

test("a wall starts within range and runs toward the second click for its length, catching whoever is in it", async t => {
  const {game, intent} = areaFixture(t, {shape: "wall", size: 25});
  const wall = await foundryActionIntentToStagedOptions({intent: {...intent, area: {points: [{x: 75, y: 25}, {x: 125, y: 25}]}},
    senderUserId: "player-a", game});
  assert.equal(wall.ok, true, wall.reason);
  assert.deepEqual(wall.options.targets.map(target => target.tokenId), ["target-token", "far-token"], "25 ft: five fields from the target on");
  const half = await foundryActionIntentToStagedOptions({intent: {...intent, area: {points: [{x: 75, y: 25}]}}, senderUserId: "player-a", game});
  assert.deepEqual([half.ok, half.reason], [false, "Choose the area's direction."]);
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

/** An effect on a creature leaving it untouched by Actions tagged `spell:spell-a` (`Unaffected`). */
const SPELL_A_IMMUNITY = {name: "Spell Immunity", disabled: false, isSuppressed: false, system: {ruleElements: [{schemaVersion: 1,
  id: "immune", type: "Unaffected", data: {actions: {tagsAny: ["spell:spell-a"]}}}]}};

/** Declares `intent` from player-a and resolves it on gm-a (every d20 a 1); the GM's record of it, and its card's data. */
async function declaredRecord(game, intent) {
  const posts = [];
  const rollProviders = [createTestRollProvider({result: {natural: 1, total: 1}})];
  const hub = createTestResolutionTransportHub({users: [{id: "gm-a", active: true, isGM: true, isActiveGM: true},
    {id: "player-a", active: true, isGM: false}]});
  const gm = createMultiplayerActionCoordinator({userId: "gm-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}), rollProviders, publishResult: post => { posts.push(post); },
    actionIntentResolver: ({intent: sent, envelope}) => foundryActionIntentToStagedOptions({
      intent: sent, senderUserId: envelope.senderUserId, game, persistencePort: createTestDocumentPersistenceAdapter()})});
  const player = createMultiplayerActionCoordinator({userId: "player-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "player-a"}), rollProviders});
  gm.register();
  player.register();
  const declared = await player.declareActionIntent(intent);
  assert.equal(declared.ok, true, JSON.stringify(declared));
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record?.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify([record?.state.trace?.slice(-3), record?.state.pendingRequests]).slice(-2500));
  return {...record, posts};
}

test("Unaffected: an area passing over a creature immune to its spell leaves it out; the others take its damage", async t => {
  const {sourceActor, targetActor, far, game, intent} = areaFixture(t, {shape: "wall", size: 25, tags: ["spell", "spell:spell-a"]});
  targetActor.effects = [SPELL_A_IMMUNITY];
  const record = await declaredRecord(game, {...intent, area: {points: [{x: 75, y: 25}, {x: 125, y: 25}]}});
  assert.deepEqual(record.options.targets.map(target => target.tokenId), ["far-token"], "left out of the area's targets");
  assert.equal(targetActor.system.resources.health.value, 30, "untouched");
  assert.equal(far.system.resources.health.value, 24);
  assert.equal(sourceActor.system.resources.action.value, 0);
});

test("Unaffected: a spell aimed at a creature immune to it is cast, its slot spent, and does nothing to it", async t => {
  const spell = tag => ({schemaVersion: 1, id: "action:spell-a", label: "Spell A", tags: ["spell", tag],
    costs: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}, {capability: "spell-slot.1", amount: 1}]},
    range: {type: "ranged", normal: {value: 120, unit: "ft"}}, targeting: {type: "single", required: true, count: 1},
    save: {ability: "agility", dc: {value: 30}},
    damage: [{id: "bolt", expression: {type: "constant", value: 6}, damageType: "force", provenance: "spell-base"}]});
  const cast = async tag => {
    const fixture = syntheticRuntimeFixture(t, spell(tag));
    fixture.sourceActor.system.pools = [{id: "spell-slot.1", value: 1, max: 1}];
    fixture.targetActor.effects = [SPELL_A_IMMUNITY];
    return {...fixture, record: await declaredRecord(fixture.game, fixture.intent)};
  };
  const immune = await cast("spell:spell-a");
  assert.equal(immune.targetActor.system.resources.health.value, 20, "no damage");
  assert.equal(immune.sourceActor.system.pools[0].value, 0, "its slot is spent");
  assert.equal(immune.sourceActor.system.resources.action.value, 0, "and its Action");
  assert.equal(immune.record.state.results.saveResolution ?? null, null, "no save is asked of it");
  assert.deepEqual(immune.record.posts.map(post => post.result.outcomes.unaffected?.map(target => target.tokenId)), [["target-token"]],
    "its card names it");
  assert.deepEqual(immune.record.state.results.targetResolution.targetContexts.map(context => [context.excluded, context.unaffected]),
    [[true, true]]);
  const other = await cast("spell:spell-b");
  assert.equal(other.targetActor.system.resources.health.value, 14, "a spell it is not immune to affects it");
  assert.equal(other.record.state.results.saveResolution.results.length, 1, "and asks its save");
  assert.equal(other.record.options.context.unaffected, undefined);
});

test("Unaffected after saving: a success's immunity leaves its creature out of the same Action, not an attack of its id", async t => {
  // A converted "Success: The target is immune to this ghost's Horrifying Visage for 24 hours" (saveImmunity).
  const immunity = {id: "effect-2", type: "effect", name: "Visage: immune", saveOutcomePolicy: "success", duration: {value: 24, units: "hours"},
    ruleElements: [{schemaVersion: 1, id: "immune", type: "Unaffected", data: {actions: {tagsAny: ["id:action:visage"], notTagsAny: ["attack"]}}}]};
  const visage = {schemaVersion: 1, id: "action:visage", label: "Visage", costs: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]},
    range: {type: "ranged", normal: {value: 60, unit: "ft"}}, targeting: {type: "single", required: true, count: 1},
    save: {ability: "agility", dc: {value: 1}}, damage: [{id: "fright", expression: {type: "constant", value: 6}, damageType: "psychic",
      provenance: "feature-base"}], effects: [immunity]};
  const fixture = syntheticRuntimeFixture(t, visage);
  await declaredRecord(fixture.game, fixture.intent);
  assert.deepEqual([...fixture.targetActor.effects].map(effect => effect.name), ["Visage: immune"], "its save succeeded");
  assert.equal(fixture.targetActor.system.resources.health.value, 14, "it still took the damage");
  fixture.sourceActor.system.resources.action.value = 1;
  const again = await declaredRecord(fixture.game, fixture.intent);
  assert.equal(fixture.targetActor.system.resources.health.value, 14, "untouched the second time");
  assert.deepEqual(again.posts.map(post => post.result.outcomes.unaffected?.map(target => target.tokenId)), [["target-token"]],
    "its card names it Unaffected");
  assert.equal(fixture.targetActor.unaffectingRule({...meleeStrikeDefinition(), id: "action:visage"}), null,
    "an attack of the same id still reaches it (a lycanthrope's Bite)");
});

test("the resolution card shows the effect and condition an Action gave its target as chips (live round 10)", async t => {
  // Live: a custom effect landed on a failed save, but its card had no "+ name" chip: the published effect named the
  // plan's target context, which the card could not match to its target.
  const sway = {schemaVersion: 1, id: "action:sway", label: "Sway", costs: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]},
    range: {type: "ranged", normal: {value: 60, unit: "ft"}}, targeting: {type: "single", required: true, count: 1},
    save: {ability: "agility", dc: {value: 30}}, effects: [{id: "effect-1", type: "effect", name: "Swayed", ruleElements: []},
      {id: "effect-2", type: "condition", conditionId: "prone"}]};
  const fixture = syntheticRuntimeFixture(t, sway);
  const record = await declaredRecord(fixture.game, fixture.intent);
  const {createResolutionCardViewModel} = await import("../module/helpers/chat-card-view-model.mjs");
  assert.deepEqual(createResolutionCardViewModel(record.posts[0].result).targets.map(target => target.effects),
    [[{label: "Swayed", conditionId: null, removed: false}, {label: "prone", conditionId: "prone", removed: false}]]);
});

const BURNING = {schemaVersion: 1, id: "action:burning-ground", label: "Burning Ground", costs: {allOf: []},
  damage: [{id: "flames", expression: {type: "constant", value: 4}, damageType: "fire", provenance: "spell-base"}]};

test("a lasting area's persistence is validated: rounds, an elevation band, and triggers carrying ActionDefinitions", () => {
  const area = persistence => ({schemaVersion: 1, id: "action:a", label: "A", costs: {allOf: []}, targeting: {type: "area"},
    area: {shape: "radial", size: {value: 5, unit: "ft"}, persistence}});
  assert.equal(validateActionDefinition(area({duration: {unit: "round", value: 10}, elevation: {bottom: 0, top: 0},
    triggers: [{on: ["area.entered", "turn.started"], action: BURNING}]})).ok, true);
  const reasons = persistence => validateActionDefinition(area(persistence)).errors.map(error => error.path);
  assert.deepEqual(reasons({duration: {unit: "minute", value: 1}}), ["area.persistence.duration"]);
  assert.deepEqual(reasons({elevation: {bottom: 10, top: 0}}), ["area.persistence.elevation"]);
  assert.deepEqual(reasons({triggers: [{on: ["attack.hit"], action: BURNING}]}), ["area.persistence.triggers.0.on"]);
  assert.deepEqual(reasons({triggers: [{on: ["area.moved"], per: 5, action: BURNING}]}), [], "damage for every 5 feet moved in it");
  assert.deepEqual(reasons({triggers: [{on: ["area.moved"], per: 0, action: BURNING}]}), ["area.persistence.triggers.0.per"]);
  assert.deepEqual(reasons({triggers: [{on: ["turn.started"], action: {label: "no id"}}]}), ["area.persistence.triggers.0.action"]);
  assert.deepEqual(reasons({triggers: [{on: ["turn.started"], once: "turn", action: BURNING}]}), []);
  assert.deepEqual(reasons({triggers: [{on: ["turn.started"], once: "round", action: BURNING}]}), ["area.persistence.triggers.0.once"]);
  assert.deepEqual([reasons({obscures: "heavily"}), reasons({obscures: "lightly"}), reasons({obscures: "thickly"})],
    [[], [], ["area.persistence.obscures"]], "Fog Cloud's and Web's degrees");
  assert.deepEqual([reasons({dispellable: false}), reasons({dispellable: true}), reasons({dispellable: "no"})],
    [[], [], ["area.persistence.dispellable"]], "dispellable is a boolean");
  const surrounding = persistence => validateActionDefinition({...area(persistence), area: {shape: "emanation", size: {value: 10, unit: "ft"},
    persistence}}).errors.map(error => error.path);
  assert.deepEqual([surrounding({includesAnchor: true}), surrounding({includesAnchor: false}), surrounding({includesAnchor: "yes"}),
    reasons({includesAnchor: true}), reasons({includesAnchor: true, onObject: "object"}), reasons({includesAnchor: false})],
  [[], [], ["area.persistence.includesAnchor"], ["area.persistence.includesAnchor"], [], []],
  "includesAnchor is a boolean, true only on an area that surrounds a Token (an emanation, or one cast on an object)");
  assert.deepEqual([reasons({endsWhen: "sourceDies"}), reasons({endsWhen: "leavesArea"})], [[], ["area.persistence.endsWhen"]],
    "a lasting area ends only with its caster's death");
  assert.deepEqual([reasons({affects: "enemies"}), reasons({affects: "allies"}), reasons({affects: "friends"})],
    [[], [], ["area.persistence.affects"]], "a lasting area affects everyone, its caster's enemies or its caster's allies");
});

/** A burst whose ground keeps burning; the Scene can hold Regions and the GM runs the turn. */
function lastingAreaFixture(t, {shape="radial", range=60, rounds=10, concentration=false, on=["turn.started"], light=null,
  affects=null, dismissSummon=null, failOn=null, rollProviders=[], rollContext={}, action=BURNING, obscures=null, triggers=null, persistence={}}={}) {
  const fixture = areaFixture(t, {shape, range, persistence: {duration: {unit: "round", value: rounds}, elevation: {bottom: 0, top: 0},
    concentration, triggers: triggers ?? [{on, action}], ...(light ? {light} : {}), ...(affects ? {affects} : {}), ...(obscures ? {obscures} : {}),
    ...persistence}});
  const {scene, game} = fixture;
  scene.regions = [];
  scene.lights = new Map();
  scene.createEmbeddedDocuments = async (type, data) => data.map(source => {
    if ( type === "AmbientLight" ) {
      const ambient = {id: `light-${scene.lights.size + 1}`, ...structuredClone(source), async delete() { scene.lights.delete(this.id); }};
      scene.lights.set(ambient.id, ambient);
      return ambient;
    }
    assert.equal(type, "Region");
    const region = {id: `region-${scene.regions.length + 1}`, parent: scene, ...structuredClone(source),
      async update(changes) {
        for ( const [path, value] of Object.entries(changes) ) {
          const keys = path.split(".");
          const last = keys.pop();
          keys.reduce((node, key) => (node[key] ??= {}), this)[last] = value;
        }
      },
      async delete() { scene.regions.splice(scene.regions.indexOf(this), 1); }};
    scene.regions.push(region);
    return region;
  });
  for ( const user of game.users.values() ) user.active = user.id !== "player-b";
  game.user = game.users.get("gm-a");
  game.users.activeGM = game.user;
  game.combat = {id: "combat-1", round: 1, turn: 0};
  game.scenes[Symbol.iterator] = function* () { yield* this.values(); };
  fixture.sourceActor.effects = [];
  fixture.sourceActor.createEmbeddedDocuments = async (type, data) => data.map(source => {
    const effect = {...structuredClone(source), uuid: `${fixture.sourceActor.uuid}.ActiveEffect.marker`,
      async delete() { fixture.sourceActor.effects.splice(fixture.sourceActor.effects.indexOf(this), 1); }};
    fixture.sourceActor.effects.push(effect);
    return effect;
  });
  const persistencePort = createTestDocumentPersistenceAdapter({failOn});
  const hub = createTestResolutionTransportHub({users: [
    {id: "gm-a", active: true, isGM: true, isActiveGM: true},
    {id: "player-a", active: true, isGM: false}
  ]});
  let areas = null;
  const gm = createMultiplayerActionCoordinator({userId: "gm-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}), afterCompleted: event => areas.create(event), rollProviders, rollContext,
    actionIntentResolver: ({intent: sent, envelope}) => foundryActionIntentToStagedOptions({intent: sent,
      senderUserId: envelope.senderUserId, game, persistencePort})});
  areas = createFoundryPersistentAreas({game, coordinator: gm, dismissSummon,
    resolveAction: options => foundryActionIntentToStagedOptions({...options, game, persistencePort})});
  const automation = createFoundryAutomationDispatcher({game, coordinator: gm, fromUuid: globalThis.fromUuid,
    resolveAction: options => foundryActionIntentToStagedOptions({...options, game, persistencePort})});
  const player = createMultiplayerActionCoordinator({userId: "player-a", users: () => hub.userDirectory(),
    activeGMUserId: "gm-a", transport: hub.createEndpoint({userId: "player-a"})});
  gm.register();
  player.register();
  return {...fixture, gm, player, areas, automation};
}

test("a lasting area becomes a Region and burns a creature that starts its turn in it, once per turn", async t => {
  const {scene, targetActor, targetToken, far, farToken, game, player, areas, intent} = lastingAreaFixture(t);
  const declared = await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  assert.equal(declared.ok, true, JSON.stringify(declared));
  assert.equal(targetActor.system.resources.health.value, 24, "the burst itself hits once when cast");
  assert.equal(scene.regions.length, 1, "the completed Action leaves its lasting area behind");
  const [region] = scene.regions;
  const flag = region.flags.wildpath.area;
  assert.deepEqual(region.shapes[0].offsets.length, 9, "Foundry draws exactly the covered fields");
  assert.deepEqual([region.elevation, region.attachment.token], [{bottom: 0, top: 0}, null]);
  assert.deepEqual([flag.sourceTokenId, flag.persistence.oncePerTurn, flag.createdAt], ["source-token", true,
    {combatId: "combat-1", round: 1, turn: 0}]);

  await areas.onTurn("turn.started", {combatant: {token: targetToken}});
  assert.equal(targetActor.system.resources.health.value, 20, "starting its turn in the fire costs 4");
  await areas.onTurn("turn.started", {combatant: {token: targetToken}});
  assert.equal(targetActor.system.resources.health.value, 20, "at most once per turn");
  game.combat.turn = 1;
  await areas.onTurn("turn.started", {combatant: {token: targetToken}});
  assert.equal(targetActor.system.resources.health.value, 16, "a new turn burns again");
  await areas.onTurn("turn.started", {combatant: {token: farToken}});
  assert.equal(far.system.resources.health.value, 30, "a creature outside is untouched");
  // A creature flying above the burning ground is out of its band.
  targetToken.elevation = 30;
  assert.equal(areaCovers(flag, targetToken), false);
});

test("an area's start- and end-of-turn triggers share once per turn, unless oncePerTurn is false (Hunger of Hadar)", async t => {
  for ( const [oncePerTurn, health] of [[true, 20], [false, 16]] ) {
    const {scene, targetActor, targetToken, player, areas, intent} = lastingAreaFixture(t);
    await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
    const {persistence} = scene.regions[0].flags.wildpath.area;
    persistence.oncePerTurn = oncePerTurn;
    persistence.triggers = [{on: ["turn.started"], action: BURNING}, {on: ["turn.ended"], action: {...BURNING, id: "action:burning-end"}}];
    await areas.onTurn("turn.started", {combatant: {token: targetToken}});
    await areas.onTurn("turn.ended", {combatant: {token: targetToken}});
    assert.equal(targetActor.system.resources.health.value, health, `oncePerTurn ${oncePerTurn}`);
  }
});

// Foundry runs `_onEndTurn` after the Combat has advanced: the ended turn is its context's, not the tracker's.
const endTurn = (areas, game, token, turn) => areas.onTurn("turn.ended",
  {combatant: {token, combat: game.combat}, context: {round: game.combat.round, turn}});

test("a turn end counts in the turn that ended, not the one Foundry has already advanced to (Spirit Guardians, Moonbeam)", async t => {
  const {scene, targetActor, targetToken, player, areas, intent, game} = lastingAreaFixture(t, {on: ["area.entered", "turn.ended"]});
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  const [region] = scene.regions;
  const flag = region.flags.wildpath.area;
  await areas.apply(region, flag, targetToken, "area.entered");
  assert.equal(targetActor.system.resources.health.value, 20, "entering on its own turn");
  game.combat.turn = 1;
  await endTurn(areas, game, targetToken, 0);
  assert.equal(targetActor.system.resources.health.value, 20, "its turn end is the same turn: once per turn");
  await areas.apply(region, flag, targetToken, "area.entered");
  assert.equal(targetActor.system.resources.health.value, 16, "moved back in on the next creature's turn, a new turn");
});

test("a trigger with once: \"turn\" keeps its own record: an entering neither repeats nor cancels the turn end's repeat", async t => {
  for ( const oncePerTurn of [true, false] ) {
    const {scene, targetActor, targetToken, player, areas, intent, game} = lastingAreaFixture(t);
    await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
    const [region] = scene.regions;
    const flag = region.flags.wildpath.area;
    flag.persistence.oncePerTurn = oncePerTurn;
    flag.persistence.triggers = [{on: ["area.entered", "turn.started"], once: "turn", action: BURNING},
      {on: ["turn.ended"], action: {...BURNING, id: "action:burning-end"}}];
    await areas.onTurn("turn.started", {combatant: {token: targetToken, combat: game.combat}, context: {round: 1, turn: 0}});
    assert.equal(targetActor.system.resources.health.value, 20, `starting its turn (oncePerTurn ${oncePerTurn})`);
    assert.deepEqual(await areas.apply(region, flag, targetToken, "area.entered"), [], "re-entering the same turn: nothing, the move goes on");
    assert.equal(flag.applied[`${targetToken.id}-0`], "combat-1:1:0", "its own record");
    game.combat.turn = 1;
    await endTurn(areas, game, targetToken, 0);
    assert.equal(targetActor.system.resources.health.value, 16, `the turn end still repeats (oncePerTurn ${oncePerTurn})`);
  }
});

test("a lasting area's trigger may answer its caster's turn (turnOf: \"source\") and come once in the area's life (once: \"area\")", () => {
  const reasons = trigger => validateActionDefinition({schemaVersion: 1, id: "action:a", label: "A", costs: {allOf: []},
    targeting: {type: "area"}, area: {shape: "radial", size: {value: 5, unit: "ft"}, persistence: {triggers: [trigger]}}})
    .errors.map(error => error.path);
  assert.deepEqual(reasons({on: ["turn.ended"], turnOf: "source", once: "area", action: BURNING}), []);
  assert.deepEqual(reasons({on: ["turn.ended"], turnOf: "caster", action: BURNING}), ["area.persistence.triggers.0.turnOf"]);
  assert.deepEqual(reasons({on: ["turn.ended"], once: "life", action: BURNING}), ["area.persistence.triggers.0.once"]);
});

test("a caster-turn trigger (turnOf: \"source\") acts as its caster's turn ends, one Action for every creature in the area, never on theirs", async t => {
  const pulse = {on: ["turn.ended"], turnOf: "source", action: {...BURNING, id: "action:pulse"}};
  const {targetActor, targetToken, far, farToken, sourceToken, player, areas, intent, game} = lastingAreaFixture(t, {triggers: [pulse]});
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  assert.equal(targetActor.system.resources.health.value, 24, "the cast's own burst");
  farToken.getOccupiedGridSpaceOffsets = () => [{i: 3, j: 0}]; // a second creature in the area
  const health = () => [targetActor.system.resources.health.value, far.system.resources.health.value];
  assert.deepEqual(await endTurn(areas, game, targetToken, 0), [], "a creature in it ending its own turn: nothing");
  assert.equal((await endTurn(areas, game, sourceToken, 0)).length, 1, "one Action for both");
  assert.deepEqual(health(), [20, 26]);
  assert.deepEqual(await endTurn(areas, game, sourceToken, 0), [], "once a turn");
  game.combat.turn = 1;
  await endTurn(areas, game, sourceToken, 1);
  assert.deepEqual(health(), [16, 22], "its next turn, again");
  farToken.elevation = 30;
  game.combat.turn = 2;
  await endTurn(areas, game, sourceToken, 2);
  assert.deepEqual(health(), [12, 22], "a flyer above its band is left out");
});

test("a self-targeted caster-turn trigger with once: \"area\" acts on its caster once: at once with no combat turn, else as its turn ends", async t => {
  const opens = {on: ["turn.ended"], turnOf: "source", once: "area", action: {...BURNING, id: "action:opens", targeting: {type: "self"}}};
  for ( const fighting of [false, true] ) {
    const {sourceActor, targetActor, sourceToken, scene, player, areas, intent, game} = lastingAreaFixture(t, {triggers: [opens]});
    sourceActor.system.resources.health = {value: 20, max: 20};
    if ( fighting ) game.combats = [{...game.combat, started: true, combatants: [{tokenId: sourceToken.id, sceneId: scene.id}]}];
    await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
    assert.equal(sourceActor.system.resources.health.value, fighting ? 20 : 16, fighting ? "a Combatant waits for its turn" : "at once");
    await endTurn(areas, game, sourceToken, 0);
    assert.equal(sourceActor.system.resources.health.value, 16, `on its caster, outside the area (fighting ${fighting})`);
    assert.equal(targetActor.system.resources.health.value, 24, "not on the creature in it: the cast's burst only");
    game.combat.turn = 1;
    await endTurn(areas, game, sourceToken, 1);
    assert.equal(sourceActor.system.resources.health.value, 16, "never again");
    assert.equal(scene.regions[0].flags.wildpath.area.applied["area-0"], fighting ? "combat-1:1:0" : "area");
  }
});

test("a caster-turn trigger finds its area gone once an earlier one ended it, and answers no more", async t => {
  const triggers = ["first", "second"].map(id => ({on: ["turn.ended"], turnOf: "source", action: {...BURNING, id: `action:${id}`}}));
  const {scene, targetActor, sourceToken, player, areas, intent, game, gm} = lastingAreaFixture(t, {triggers});
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  const resolve = gm.resolveAuthorityAction;
  gm.resolveAuthorityAction = async options => { await scene.regions[0]?.delete(); return resolve.call(gm, options); };
  assert.equal((await endTurn(areas, game, sourceToken, 0)).length, 1);
  assert.equal(targetActor.system.resources.health.value, 20, "the first acts; the second does not");
});

test("a caster-turn trigger that breaks its caster's concentration ends the area's later triggers before its Region goes", async t => {
  const triggers = ["first", "second"].map(id => ({on: ["turn.ended"], turnOf: "source", action: {...BURNING, id: `action:${id}`}}));
  const {scene, targetActor, sourceToken, player, areas, intent, game, gm} = lastingAreaFixture(t, {triggers, concentration: true});
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  // The Action returns as it completes; the area is deleted only by its follow-ups after that (afterResolution).
  const resolve = gm.resolveAuthorityAction;
  gm.resolveAuthorityAction = options => resolve.call(gm, {...options, onComplete: ({state, ...rest}) => options.onComplete({...rest,
    state: {...state, results: {...state.results, concentrationResolution: {checks: {breakEvents: [{sourceRef: "token:source-token"}]}}}}})});
  assert.equal((await endTurn(areas, game, sourceToken, 0)).length, 1);
  assert.equal(scene.regions.length, 1, "its Region is still there");
  assert.equal(targetActor.system.resources.health.value, 20, "the first acts; the second does not");
});

test("a caster-turn trigger whose ends.concentration reaches its caster ends the area's later triggers; one reaching others does not", async t => {
  const second = {on: ["turn.ended"], turnOf: "source", action: {...BURNING, id: "action:second"}};
  // A self trigger deals no damage unless `hurts`: a concentrating caster it hurt would wait on a check nobody answers.
  const first = (self, ends, {hurts=!self}={}) => ({on: ["turn.ended"], turnOf: "source", action: {...BURNING, id: "action:first",
    ...(self ? {targeting: {type: "self"}} : {}), ...(hurts ? {} : {damage: []}), ...(ends ? {ends} : {})}});
  const run = async (trigger, status=null) => {
    const {sourceActor, targetActor, sourceToken, scene, player, areas, intent, game, gm} = lastingAreaFixture(t,
      {triggers: [trigger, second], concentration: true});
    sourceActor.system.resources.health = {value: 20, max: 20};
    await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
    // Its marker, read as a document when the caster is a target (its concentration context).
    for ( const effect of sourceActor.effects ) effect.toObject = () => ({name: effect.name, flags: structuredClone(effect.flags)});
    // `status`: the first trigger's Action as returned failed, with a broken check too.
    if ( status ) {
      const resolve = gm.resolveAuthorityAction;
      gm.resolveAuthorityAction = options => resolve.call(gm, {...options, onComplete: ({state, ...rest}) => options.onComplete({...rest,
        state: (state.actionDefinition?.id === "action:first") ? {...state, status, results: {...state.results,
          concentrationResolution: {checks: {breakEvents: [{sourceRef: "token:source-token"}]}}}} : state})});
    }
    await endTurn(areas, game, sourceToken, 0);
    return {regions: scene.regions.length, health: targetActor.system.resources.health.value};
  };
  // The runtime ends it only after the Action returns (endBrokenConcentration), so the Region is still there.
  assert.deepEqual(await run(first(true, {concentration: true})), {regions: 1, health: 24}, "the caster's own: the second does not act");
  assert.deepEqual(await run(first(false, {concentration: true})), {regions: 1, health: 16}, "the creatures in it only: the second acts");
  assert.deepEqual(await run(first(true, null)), {regions: 1, health: 20}, "no ends: the second acts");
  // A first trigger that did not complete ran no follow-ups, so it broke nothing (ends.concentration's or a check's).
  assert.deepEqual(await run(first(true, {concentration: true}, {hurts: true})), {regions: 1, health: 20},
    "cancelled at its caster's unanswered concentration check: the second acts");
  assert.deepEqual(await run(first(true, {concentration: true}), "failed"), {regions: 1, health: 20}, "a failed one: the second acts");
  const reasons = ends => validateActionDefinition({...BURNING, ends}).errors.map(error => error.path);
  assert.deepEqual(reasons({concentration: true, on: "failure"}), []);
  assert.deepEqual(reasons({concentration: "yes", on: "failed"}), ["ends.on", "ends.concentration"]);
});

test("a caster-turn trigger that ends another area of its caster's leaves that area untouched", async t => {
  const triggers = [{on: ["turn.ended"], turnOf: "source", action: BURNING}];
  const {scene, sourceActor, targetActor, sourceToken, player, areas, intent, game, gm} = lastingAreaFixture(t, {triggers});
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  sourceActor.system.resources.action.value = 1;
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  const [, second] = scene.regions;
  const update = second.update;
  second.update = function(changes) {
    if ( !scene.regions.includes(this) ) throw new Error("a deleted Region");
    return update.call(this, changes);
  };
  const health = targetActor.system.resources.health.value;
  const resolve = gm.resolveAuthorityAction;
  gm.resolveAuthorityAction = async options => {
    if ( scene.regions.includes(second) ) await second.delete();
    return resolve.call(gm, options); };
  assert.equal((await endTurn(areas, game, sourceToken, 0)).length, 1);
  assert.equal(targetActor.system.resources.health.value, health - 4, "the first area's trigger alone");
});

test("a repeating self-targeted caster-turn trigger keeps its own record and acts in an area that spares its caster", async t => {
  const tick = {on: ["turn.ended"], turnOf: "source", action: {...BURNING, id: "action:tick", targeting: {type: "self"}}};
  const {scene, sourceActor, sourceToken, player, areas, intent, game} = lastingAreaFixture(t, {triggers: [tick], affects: "enemies"});
  sourceActor.system.resources.health = {value: 20, max: 20};
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  // The caster's shared record already spent this turn (burned entering its own area).
  scene.regions[0].flags.wildpath.area.applied[sourceToken.id] = "combat-1:1:0";
  await endTurn(areas, game, sourceToken, 0);
  assert.equal(sourceActor.system.resources.health.value, 16);
  game.combat.turn = 1;
  await endTurn(areas, game, sourceToken, 1);
  assert.equal(sourceActor.system.resources.health.value, 12, "again its next turn");
});

test("a caster-turn trigger giving what it holds only while in the area resolves once per creature, each stamped with its Region", async t => {
  const webs = {on: ["turn.ended"], turnOf: "source", action: {schemaVersion: 1, id: "action:webs", label: "Webs", costs: {allOf: []},
    effects: [{id: "stuck", type: "condition", conditionId: "restrained", metadata: {endsWhen: "leavesArea"}}]}};
  const {scene, targetActor, far, farToken, sourceToken, player, areas, intent, game} = lastingAreaFixture(t, {triggers: [webs]});
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  farToken.getOccupiedGridSpaceOffsets = () => [{i: 3, j: 0}];
  assert.equal((await endTurn(areas, game, sourceToken, 0)).length, 2, "one Action per creature");
  for ( const actor of [targetActor, far] ) {
    assert.deepEqual([...actor.effects].filter(effect => effect.system?.type === "restrained")
      .map(effect => effect.flags?.wildpath?.conditionEffect?.metadata?.regionId), [scene.regions[0].id]);
  }
});

test("once per turn keys a move on the creature's own combat, as its turn does, not the one the GM's tracker shows", async t => {
  const {scene, targetActor, targetToken, player, areas, intent, game} = lastingAreaFixture(t, {on: ["area.entered", "turn.started"]});
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  const [region] = scene.regions;
  const flag = region.flags.wildpath.area;
  const own = {id: "combat-own", round: 3, turn: 0, started: true, combatants: [{tokenId: targetToken.id, sceneId: scene.id}]};
  game.combats = [game.combat, own];
  await areas.onTurn("turn.started", {combatant: {token: targetToken, combat: own}, context: {round: 3, turn: 0}});
  assert.equal(targetActor.system.resources.health.value, 20, "starting its turn in its own combat");
  assert.deepEqual(await areas.apply(region, flag, targetToken, "area.entered"), [], "stepping out and back in the same turn");
  assert.equal(targetActor.system.resources.health.value, 20);
});

test("a Heavily Obscured lasting area (Fog Cloud) hides a creature in it from sight, but not from Blindsight", async t => {
  const {heavilyObscuredAt} = await import("../module/adapters/foundry-v14-persistent-areas.mjs");
  const {attackSight} = await import("../module/adapters/foundry-v14-senses.mjs");
  const {scene, targetToken, farToken, player, intent} = lastingAreaFixture(t);
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  const [region] = scene.regions;
  assert.equal(heavilyObscuredAt(targetToken), false, "an area that doesn't obscure hides nothing");
  region.flags.wildpath.area.persistence.obscures = "heavily";
  assert.deepEqual([heavilyObscuredAt(targetToken), heavilyObscuredAt(farToken)], [true, false]);
  const {areaObscurityAt} = await import("../module/adapters/foundry-v14-persistent-areas.mjs");
  const {obscurityAt} = await import("../module/adapters/foundry-v14-senses.mjs");
  assert.deepEqual([areaObscurityAt(targetToken), obscurityAt(targetToken), obscurityAt(farToken)], ["heavily", "heavily", null]);
  // A Lightly Obscured area (Web) hides no one, but obscures a creature in it in Bright Light (Nature's Mantle).
  region.flags.wildpath.area.persistence.obscures = "lightly";
  assert.deepEqual([heavilyObscuredAt(targetToken), areaObscurityAt(targetToken), obscurityAt(targetToken), obscurityAt(farToken)],
    [false, "lightly", "lightly", null]);
  region.flags.wildpath.area.persistence.obscures = "heavily";
  // Its area's flag keeps either degree it was cast with.
  const web = lastingAreaFixture(t, {obscures: "lightly"});
  await web.player.declareActionIntent({...web.intent, area: {points: [{x: 125, y: 25}]}});
  assert.equal(web.scene.regions[0].flags.wildpath.area.persistence.obscures, "lightly");
  const creature = senses => ({statuses: new Set(), system: {senses}});
  const sight = senses => attackSight({attacker: creature(senses), target: creature({}), attackerToken: farToken, targetToken, distance: 10});
  assert.deepEqual(sight({truesight: 120}), {seesTarget: false, seenByTarget: false, targetHidden: true, attackerHidden: true},
    "Truesight doesn't see through fog, and the one in it sees nothing out");
  assert.equal(sight({blindsight: 30}).seesTarget, true, "Blindsight within range ignores it");
});

test("a lasting area keeps the slot it was cast with: its stored repeat is the configured one (3d10)", async t => {
  const {scene, areas, sourceToken} = lastingAreaFixture(t);
  const fields = [{i: 2, j: 0}];
  const repeat = dice => ({schemaVersion: 1, id: "action:moonbeam:lasting", costs: {allOf: []}, save: {ability: "fortitude", dc: {value: 15}},
    damage: [{id: "damage-1", expression: {type: "dice", number: dice, faces: 10}, damageType: "radiant"}]});
  const moonbeam = dice => ({id: "action:moonbeam", label: "Moonbeam", area: {shape: "radial", size: {value: 5, unit: "ft"},
    persistence: {duration: {unit: "round", value: 10}, triggers: [{on: ["area.entered", "turn.ended"], action: repeat(dice)}]}}});
  const region = await areas.create({options: {persistentArea: {footprint: {topology: "square", fields}, definition: moonbeam(2),
    sourceTokenId: sourceToken.id, sceneId: scene.id}}, state: {configuration: {castingLevel: 3, effectiveDefinition: moonbeam(3)}}});
  const [trigger] = region.flags.wildpath.area.persistence.triggers;
  assert.deepEqual([trigger.action.damage[0].expression.number, region.flags.wildpath.area.castLevel], [3, 3]);
});

test("moving a lasting area takes its fields and its cast level along, and a creature it moves onto saves", async t => {
  const {scene, areas, sourceToken, targetActor, targetToken} = lastingAreaFixture(t, {on: ["area.entered"]});
  const region = await areas.create({options: {persistentArea: {footprint: {topology: "square", fields: [{x: 9, y: 9}]},
    definition: {id: "action:burn", label: "Burn", area: {shape: "radial", size: {value: 5, unit: "ft"}, persistence: {
      duration: {unit: "round", value: 10}, triggers: [{on: ["area.entered"], action: BURNING}]}}},
    sourceTokenId: sourceToken.id, sceneId: scene.id}}, state: {configuration: {castingLevel: 3}}});
  const health = targetActor.system.resources.health.value;
  // Onto the target's own field: it enters the area ("when it moves into its space").
  const onto = createFoundryV14TacticalGridAdapter({scene}).tokenToFootprint(targetToken).footprint.fields;
  await areas.move({options: {areaMove: {sceneId: scene.id, regionId: region.id, fields: onto}}});
  assert.deepEqual(region.flags.wildpath.area.fields, onto, "the area's fields are where it was moved");
  assert.equal(region.shapes[0].offsets.length, onto.length, "and Foundry draws it there");
  assert.equal(targetActor.system.resources.health.value, health - 4, "the creature it moved onto takes its damage");
  assert.equal(region.flags.wildpath.area.persistence.triggers[0].action.id, BURNING.id, "its triggers go with it");
});

test("a lasting area's blocks: a list of wall senses, on an area placed where it stays only", () => {
  const area = (persistence, shape="wall") => ({schemaVersion: 1, id: "action:a", label: "A", costs: {allOf: []}, targeting: {type: "area"},
    area: {shape, size: {value: 30, unit: "ft"}, persistence}});
  const reasons = (...args) => validateActionDefinition(area(...args)).errors.map(error => error.path);
  assert.deepEqual(reasons({blocks: ["move", "sight"]}), []);
  assert.deepEqual([reasons({blocks: ["move", "smell"]}), reasons({blocks: []}), reasons({blocks: "move"})],
    [["area.persistence.blocks"], ["area.persistence.blocks"], ["area.persistence.blocks"]], "only Wall senses, at least one");
  assert.deepEqual(reasons({blocks: ["move"]}, "emanation"), ["area.persistence.blocks"], "an emanation moves with its creature");
  assert.deepEqual(reasons({blocks: ["move"], onObject: "on-object"}, "radial"), ["area.persistence.blocks"], "nor one cast on an object");
  const summon = {schemaVersion: 1, id: "action:s", label: "S", costs: {allOf: []}, summon: {actorRef: "Actor.x",
    area: {shape: "emanation", size: {value: 5, unit: "ft"}, persistence: {blocks: ["move"]}}}};
  assert.ok(validateActionDefinition(summon).errors.some(error => error.path === "summon.area.persistence.blocks"), "nor a summon's carried area");
});

test("a lasting area's walls: \"open\" only, not beside blocks, on an area placed where it stays only", () => {
  const area = (persistence, shape="line") => ({schemaVersion: 1, id: "action:a", label: "A", costs: {allOf: []}, targeting: {type: "area"},
    area: {shape, size: {value: 30, unit: "ft"}, persistence}});
  const reasons = (...args) => validateActionDefinition(area(...args)).errors.map(error => error.path);
  assert.deepEqual(reasons({walls: "open"}), []);
  assert.deepEqual([reasons({walls: "block"}), reasons({walls: true})], [["area.persistence.walls"], ["area.persistence.walls"]]);
  assert.deepEqual(reasons({walls: "open", blocks: ["move"]}), ["area.persistence.walls"], "it opens walls or raises its own");
  assert.deepEqual(reasons({walls: "open"}, "emanation"), ["area.persistence.walls"], "an emanation moves with its creature");
  assert.deepEqual(reasons({walls: "open", onObject: "on-object"}, "radial"), ["area.persistence.walls"], "nor one cast on an object");
  const summon = {schemaVersion: 1, id: "action:s", label: "S", costs: {allOf: []}, summon: {actorRef: "Actor.x",
    area: {shape: "emanation", size: {value: 5, unit: "ft"}, persistence: {walls: "open"}}}};
  assert.ok(validateActionDefinition(summon).errors.some(error => error.path === "summon.area.persistence.walls"), "nor a summon's carried area");
});

/**
 * A lasting area fixture whose Scene keeps Wall documents and whose Tokens move: each Token's footprint follows its x/y
 * (50-px fields, field {x, y} the offset {i: x, j: y}) and its update moves it.
 */
function walledAreaFixture(t) {
  const fixture = lastingAreaFixture(t);
  const {scene} = fixture;
  const created = scene.createEmbeddedDocuments;
  scene.walls = [];
  fixture.log = [];
  scene.createEmbeddedDocuments = async (type, data) => {
    if ( type !== "Wall" ) return created(type, data);
    fixture.log.push("walls");
    const walls = data.map((source, index) => ({id: `wall-${scene.walls.length + index + 1}`, ...structuredClone(source)}));
    scene.walls.push(...walls);
    return walls;
  };
  scene.deleteEmbeddedDocuments = async (type, ids) => {
    assert.equal(type, "Wall");
    await null; // a database round trip, as Foundry's
    // Foundry refuses to delete a document that is already gone.
    assert.ok(ids.every(id => scene.walls.some(wall => wall.id === id)), `no wall is deleted twice: ${ids}`);
    scene.walls = scene.walls.filter(wall => !ids.includes(wall.id));
  };
  scene.updateEmbeddedDocuments = async (type, updates) => {
    assert.equal(type, "Wall");
    for ( const {_id, ...changes} of updates ) {
      const wall = scene.walls.find(entry => entry.id === _id);
      for ( const [path, value] of Object.entries(changes) ) {
        const keys = path.split(".");
        const last = keys.pop();
        keys.reduce((node, key) => (node[key] ??= {}), wall)[last] = value;
      }
    }
  };
  Object.assign(scene.grid, {getTopLeftPoint: ({i, j}) => ({x: i * 50, y: j * 50}),
    measurePath: ([a, b]) => ({distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 50 * 5})});
  for ( const token of scene.tokens ) Object.assign(token, {width: 1, height: 1, updates: [],
    getCenterPoint(data={}) { return {x: (data.x ?? this.x) + 25, y: (data.y ?? this.y) + 25}; },
    getOccupiedGridSpaceOffsets(data={}) { return [{i: Math.floor((data.x ?? this.x) / 50), j: Math.floor((data.y ?? this.y) / 50)}]; },
    async update(data, operation) {
      fixture.log.push(`moved ${this.id}`);
      this.updates.push({data, operation});
      Object.assign(this, data);
    }});
  return fixture;
}

/** A Wall of Ice-like area: three fields down column 3, blocking movement and sight. */
const ICE_WALL = {id: "action:ice-wall", label: "Ice Wall", area: {shape: "wall", size: {value: 15, unit: "ft"},
  persistence: {duration: {unit: "round", value: 10}, blocks: ["move", "sight"]}}};
const ICE_FIELDS = [{x: 3, y: 2}, {x: 3, y: 3}, {x: 3, y: 4}];

test("a blocking area (persistence.blocks) pushes the creatures in it aside, then walls its outline; its Region's end removes only its walls", async t => {
  const fixture = walledAreaFixture(t);
  const {scene, areas, sourceToken, targetToken} = fixture;
  sourceToken.level = "level-1";
  Object.assign(targetToken, {x: 150, y: 150, level: "level-1"});
  scene.walls.push({id: "hand-drawn", c: [0, 0, 0, 50], flags: {}}, {id: "other-area", c: [0, 0, 50, 0], flags: {wildpath: {areaRegion: "region-9"}}});
  const region = await areas.create({options: {persistentArea: {footprint: {topology: "square", fields: ICE_FIELDS}, definition: ICE_WALL,
    sourceTokenId: sourceToken.id, sceneId: scene.id}}, state: {configuration: {}}});
  assert.deepEqual(region.flags.wildpath.area.persistence.blocks, ["move", "sight"], "its flag keeps what its walls block");
  assert.deepEqual(fixture.log, ["moved target-token", "walls"], "the creature steps out before any wall stands");
  assert.deepEqual(targetToken.updates.map(update => [update.data, update.operation.wildpath.movementKind]), [[{x: 100, y: 100}, "forced"]],
    "to the nearest free space beside the wall (field 2, 2: not one of its own), as forced movement");
  const own = scene.walls.filter(wall => wall.flags?.wildpath?.areaRegion === region.id);
  assert.equal(own.length, 8, "three fields in a column: eight outline edges");
  assert.deepEqual([...new Set(own.map(wall => [wall.move, wall.sight, wall.light, wall.sound, wall.dir, wall.levels.join()].join()))],
    ["20,20,0,0,0,level-1"], "two-way, the listed senses only, on the caster's Level");
  assert.equal(scene.walls.length, 10);
  await areas.onRegionDeleted(region);
  assert.deepEqual(scene.walls.map(wall => wall.id), ["hand-drawn", "other-area"], "a hand-drawn wall and another area's stay");
});

test("a blocking area's walls stand the whole height of its Level: a flier above its band steps out, a creature on another Level stays", async t => {
  const band = {...ICE_WALL, area: {...ICE_WALL.area, persistence: {...ICE_WALL.area.persistence, elevation: {bottom: 0, top: 10}}}};
  for ( const [level, moved] of [["level-1", 1], ["level-2", 0]] ) {
    const {scene, areas, sourceToken, targetToken} = walledAreaFixture(t);
    sourceToken.level = "level-1";
    Object.assign(targetToken, {x: 150, y: 150, elevation: 30, level});
    await areas.create({options: {persistentArea: {footprint: {topology: "square", fields: ICE_FIELDS}, definition: band,
      sourceTokenId: sourceToken.id, sceneId: scene.id}}, state: {configuration: {}}});
    assert.equal(targetToken.updates.length, moved, `on ${level}`);
  }
});

test("a blocking area pushes no creature on another plane than its caster: an Ethereal one stays, until the caster is Ethereal too", async t => {
  for ( const [casterStatuses, moved] of [[[], 0], [["ethereal"], 1]] ) {
    const fixture = walledAreaFixture(t);
    const {scene, areas, sourceToken, targetToken} = fixture;
    Object.assign(targetToken, {x: 150, y: 150});
    targetToken.actor.statuses = new Set(["ethereal"]);
    sourceToken.actor.statuses = new Set(casterStatuses);
    await areas.create({options: {persistentArea: {footprint: {topology: "square", fields: ICE_FIELDS}, definition: ICE_WALL,
      sourceTokenId: sourceToken.id, sceneId: scene.id}}, state: {configuration: {}}});
    assert.equal(targetToken.updates.length, moved, `a caster with [${casterStatuses}]`);
    assert.ok(fixture.log.includes("walls"), "the walls stand either way");
  }
});

test("a blocking area pushes no Token its rules leave untouched by the area's Action: an object (another wall's section) stays", async t => {
  const fixture = walledAreaFixture(t);
  const {scene, areas, sourceToken, targetToken} = fixture;
  Object.assign(targetToken, {x: 150, y: 150});
  targetToken.actor.unaffectingRule = definition => unaffectingRule([{ruleElements: [OBJECT_RULE], source: {name: "Section"}}], definition);
  await areas.create({options: {persistentArea: {footprint: {topology: "square", fields: ICE_FIELDS}, definition: ICE_WALL,
    sourceTokenId: sourceToken.id, sceneId: scene.id}}, state: {configuration: {}}});
  assert.deepEqual(fixture.log, ["walls"], "the walls stand, the object is not moved");
});

test("an area without blocks raises no walls and moves nobody, as before", async t => {
  const fixture = walledAreaFixture(t);
  const {scene, areas, sourceToken, targetToken} = fixture;
  Object.assign(targetToken, {x: 150, y: 150});
  const {blocks: _blocks, ...persistence} = ICE_WALL.area.persistence;
  await areas.create({options: {persistentArea: {footprint: {topology: "square", fields: ICE_FIELDS},
    definition: {...ICE_WALL, area: {...ICE_WALL.area, persistence}}, sourceTokenId: sourceToken.id, sceneId: scene.id}}, state: {configuration: {}}});
  assert.deepEqual([fixture.log, scene.walls], [[], []]);
});

test("a blocking area stays where it was made: a GM drag is drawn back, and its Action's move is refused before anything is spent", async t => {
  const fixture = walledAreaFixture(t);
  const {scene, areas, sourceToken} = fixture;
  const warned = t.mock.method(console, "warn", () => {});
  const region = await areas.create({options: {persistentArea: {footprint: {topology: "square", fields: ICE_FIELDS}, definition: ICE_WALL,
    sourceTokenId: sourceToken.id, sceneId: scene.id}}, state: {configuration: {}}});
  const drawn = structuredClone(region.shapes);
  region.shapes = [{type: "grid", offsets: [{i: 9, j: 9}]}];
  assert.deepEqual(await areas.onRegionUpdated(region, {shapes: region.shapes}), []);
  assert.deepEqual([region.shapes, region.flags.wildpath.area.fields], [drawn, ICE_FIELDS], "drawn back on its own fields");
  assert.match(String(warned.mock.calls.at(-1)?.arguments[0]), /WILDPATH\.NOTICE\.AreaFixed/, "and the GM is told");
  // Without blocks the drag moves it, as before.
  delete region.flags.wildpath.area.persistence.blocks;
  region.shapes = [{type: "grid", offsets: [{i: 9, j: 9}]}];
  await areas.onRegionUpdated(region, {shapes: region.shapes});
  assert.deepEqual(region.flags.wildpath.area.fields, [{x: 9, y: 9}]);
  region.flags.wildpath.area.persistence.blocks = ["move"];

  const mover = {schemaVersion: 1, id: "action:move-wall", label: "Move Wall", costs: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]},
    targeting: {type: "none"}, moveArea: {of: ICE_WALL.id, distance: 60}};
  const moving = syntheticRuntimeFixture(t, mover);
  moving.scene.grid.measurePath = ([a, b]) => ({distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 50 * 5});
  moving.scene.regions = [{...region, flags: {wildpath: {area: {...region.flags.wildpath.area, sourceActorRef: moving.sourceActor.uuid,
    fields: ICE_FIELDS, shape: "radial", size: 5}}}}];
  const use = () => foundryActionIntentToStagedOptions({senderUserId: "player-a", game: moving.game,
    intent: {...moving.intent, area: {points: [{x: 175, y: 175}]}}});
  const refused = await use();
  assert.deepEqual([refused.ok, refused.reason], [false, "WILDPATH.REFUSAL.AreaFixed"]);
  assert.equal(moving.sourceActor.system.resources.action.value, 1, "its Action is not spent");
  delete moving.scene.regions[0].flags.wildpath.area.persistence.blocks;
  const moved = await use();
  assert.equal(moved.ok, true, `an area without blocks moves: ${moved.reason}`);
});

/** Wall of Ice-like sections: 10 feet each, AC 12 and 30 HP, immune to cold and vulnerable to fire. */
const ICE_SECTIONS = {size: 10, ac: 12, hp: 30, ruleElements: [
  {schemaVersion: 1, id: "section-immune", type: "GrantImmunity", data: {damageTypes: ["cold"]}},
  {schemaVersion: 1, id: "section-vulnerable", type: "GrantVulnerability", data: {damageTypes: ["fire"]}}]};

/** walledAreaFixture whose Scene also makes and deletes Tokens, and whose Actor class makes world Actors (game.actors). */
function sectionedFixture(t) {
  const fixture = walledAreaFixture(t);
  const {scene, game} = fixture;
  const [create, remove] = [scene.createEmbeddedDocuments, scene.deleteEmbeddedDocuments];
  scene.createEmbeddedDocuments = async (type, data) => {
    if ( type !== "Token" ) return create(type, data);
    fixture.log.push("tokens");
    const tokens = data.map((source, index) => ({id: `section-${scene.tokens.length + index + 1}`, parent: scene, ...structuredClone(source)}));
    scene.tokens.push(...tokens);
    return tokens;
  };
  scene.deleteEmbeddedDocuments = async (type, ids) => {
    if ( type !== "Token" ) return remove(type, ids);
    assert.ok(ids.every(id => scene.tokens.some(token => token.id === id)), `no Token is deleted twice: ${ids}`);
    for ( const id of ids ) scene.tokens.splice(scene.tokens.findIndex(token => token.id === id), 1);
  };
  game.actors = new Map();
  const saved = globalThis.CONFIG;
  t.after(() => { globalThis.CONFIG = saved; });
  globalThis.CONFIG = {...(saved ?? {}), Actor: {documentClass: {async create(data) {
    fixture.log.push("actor");
    const actor = {id: `actor-${game.actors.size + 1}`, source: structuredClone(data),
      async getTokenDocument(tokenData, {parent}) {
        assert.equal(parent, scene);
        return {toObject: () => ({...structuredClone(data.prototypeToken), actorId: this.id, ...structuredClone(tokenData)})};
      },
      async delete() { game.actors.delete(this.id); }};
    game.actors.set(actor.id, actor);
    return actor;
  }}}};
  return fixture;
}

test("a wall in sections (persistence.sections): one object Actor, a Token and its own walls per section; its Region's end removes them all", async t => {
  const fixture = sectionedFixture(t);
  const {scene, areas, sourceToken, targetToken, game} = fixture;
  sourceToken.level = "level-1";
  Object.assign(targetToken, {x: 150, y: 150, level: "level-1"});
  scene.walls.push({id: "hand-drawn", c: [0, 0, 0, 50], flags: {}});
  const definition = {...ICE_WALL, area: {...ICE_WALL.area, persistence: {...ICE_WALL.area.persistence, sections: ICE_SECTIONS}}};
  const region = await areas.create({options: {persistentArea: {footprint: {topology: "square", fields: ICE_FIELDS}, definition,
    sourceTokenId: sourceToken.id, sceneId: scene.id}}, state: {configuration: {}}});
  assert.deepEqual(fixture.log, ["moved target-token", "actor", "tokens", "walls"], "the creature steps out before anything stands");
  assert.deepEqual(region.flags.wildpath.area.persistence.sections, ICE_SECTIONS, "its flag keeps the sections");
  const actor = game.actors.get(region.flags.wildpath.area.sectionActorId);
  assert.deepEqual(actor.source, objectActorData(ICE_SECTIONS, "Ice Wall"));
  const sections = scene.tokens.filter(token => token.flags?.wildpath?.section);
  assert.deepEqual(sections.map(token => [token.x, token.y, token.width, token.height]), [[150, 100, 1, 2], [150, 200, 1, 1]],
    "three fields in 10-foot sections: one over the first two, one over the last");
  assert.deepEqual(sections.map(token => [token.flags.wildpath.section, token.flags.wildpath.leavesAtDeath, token.actorId,
    token.actorLink, token.disposition, token.level]),
  [[{regionId: region.id, index: 0}, true, actor.id, false, 0, "level-1"], [{regionId: region.id, index: 1}, true, actor.id, false, 0, "level-1"]],
  "unlinked and neutral, each knowing its section, and leaving at its death");
  assert.deepEqual(sections.map(token => token.texture?.src), [OBJECT_IMG, OBJECT_IMG], "a standing object's image, not the creature silhouette");
  const own = section => scene.walls.filter(wall => (wall.flags?.wildpath?.areaRegion === region.id) && (wall.flags.wildpath.section === section));
  assert.deepEqual([own(0).length, own(1).length], [12, 8], "each section's own outline, a movement and a sight wall per edge");
  assert.equal(scene.walls.length, 21);
  scene.tokens.push({id: "bystander", flags: {}});
  await areas.onRegionDeleted(region);
  assert.deepEqual(scene.walls.map(wall => wall.id), ["hand-drawn"], "its walls go, a hand-drawn one stays");
  assert.equal(scene.tokens.some(token => token.flags?.wildpath?.section), false, "its sections' Tokens go");
  assert.ok(scene.tokens.some(token => token.id === "bystander"));
  assert.equal(game.actors.size, 0, "and the Actor they stood for");
});

/** A sectioned Ice Wall cast in sectionedFixture: its Region, its section Tokens and a helper for a section's walls. */
async function castSections(fixture) {
  const {scene, areas, sourceToken} = fixture;
  sourceToken.level = "level-1";
  scene.walls.push({id: "hand-drawn", c: [0, 0, 0, 50], flags: {}});
  const definition = {...ICE_WALL, area: {...ICE_WALL.area, persistence: {...ICE_WALL.area.persistence, sections: ICE_SECTIONS}}};
  const region = await areas.create({options: {persistentArea: {footprint: {topology: "square", fields: ICE_FIELDS}, definition,
    sourceTokenId: sourceToken.id, sceneId: scene.id}}, state: {configuration: {}}});
  const own = section => scene.walls.filter(wall => (wall.flags?.wildpath?.areaRegion === region.id) && (wall.flags.wildpath.section === section));
  return {region, sections: scene.tokens.filter(token => token.flags?.wildpath?.section), own};
}

test("a section's Token deleted opens that section: its own walls go, its neighbour's and a hand-drawn wall stay (wave D A15)", async t => {
  const fixture = sectionedFixture(t);
  const {scene, areas, game, targetToken} = fixture;
  const {region, sections, own} = await castSections(fixture);
  assert.deepEqual([own(0).length, own(1).length], [12, 8]);
  // Foundry's deleteToken hook runs on every client after the Token is gone; only the active GM opens the section.
  await scene.deleteEmbeddedDocuments("Token", [sections[0].id]);
  const activeGM = game.users.activeGM;
  game.users.activeGM = {id: "someone-else"};
  await areas.onTokenDeleted(sections[0]);
  assert.equal(own(0).length, 12, "not on a client other than the active GM");
  game.users.activeGM = activeGM;
  await areas.onTokenDeleted(sections[0]);
  assert.deepEqual([own(0).length, own(1).length], [0, 8], "the section's walls go, its neighbour's stay");
  assert.ok(scene.walls.some(wall => wall.id === "hand-drawn"));
  await areas.onTokenDeleted(targetToken);
  assert.equal(scene.walls.length, 9, "a creature's Token leaving opens nothing");
  // The Region's end then deletes the rest, never a wall twice (the fixture refuses it).
  await areas.onRegionDeleted(region);
  assert.deepEqual(scene.walls.map(wall => wall.id), ["hand-drawn"]);
  await areas.onTokenDeleted(sections[1]);
  assert.deepEqual(scene.walls.map(wall => wall.id), ["hand-drawn"], "a section Token its Region's end removed finds no walls left");
});

test("a pasted copy of a section Token deleted leaves the section standing in its original closed (wave D A15 review)", async t => {
  const fixture = sectionedFixture(t);
  const {scene, areas} = fixture;
  const {sections, own} = await castSections(fixture);
  // Foundry's copy and paste keeps the Token's flags.
  const copy = {...sections[0], id: "section-0-copy", flags: structuredClone(sections[0].flags)};
  scene.tokens.push(copy);
  await scene.deleteEmbeddedDocuments("Token", [copy.id]);
  await areas.onTokenDeleted(copy);
  assert.equal(own(0).length, 12, "the original still stands, so its walls stay");
  await scene.deleteEmbeddedDocuments("Token", [sections[0].id]);
  await areas.onTokenDeleted(sections[0]);
  assert.deepEqual([own(0).length, own(1).length], [0, 8], "the last Token of the section gone opens it");
});

test("a section brought to 0 opens through the death settle step: settleDeaths removes its Token, whose deletion takes its walls (wave D A15)", async t => {
  const fixture = sectionedFixture(t);
  const {scene, areas} = fixture;
  const {sections, own} = await castSections(fixture);
  const section = {uuid: "Scene.scene.Token.section-1.Actor.ice", isToken: true, token: sections[1], effects: []};
  const dying = createFoundryDying({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, combats: [], actors: [], scenes: []},
    coordinator: {}, resolveAction: async () => ({ok: false}), fromUuid: uuid => (uuid === section.uuid ? section : null),
    // The runtime's removeTokens deletes the Token; Foundry's deleteToken hook then reaches the areas adapter.
    removeTokens: async (parent, ids) => {
      const tokens = ids.map(id => parent.tokens.find(token => token.id === id));
      await parent.deleteEmbeddedDocuments("Token", ids);
      for ( const token of tokens ) await areas.onTokenDeleted(token);
    }});
  await dying.settleDeaths([section.uuid]);
  assert.equal(scene.tokens.includes(sections[1]), false, "its Token leaves at its death");
  assert.deepEqual([own(0).length, own(1).length], [12, 0], "the dead section's walls go; the standing one keeps its own");
});

/** Frigid Air-like: what an opened section leaves, its one trigger on entering and leaving, once a turn. */
const FRIGID_AIR = {...BURNING, id: "action:frigid-air", label: "Frigid Air"};
const FRIGID_LEAVES = {triggers: [{on: ["area.entered", "area.exited"], once: "turn", action: FRIGID_AIR}]};

/** An Ice Wall whose sections leave FRIGID_LEAVES, cast at level 7 in a band, on a Scene that deletes Regions too. */
async function castLeavingSections(fixture, leaves=FRIGID_LEAVES) {
  const {scene, areas, sourceToken} = fixture;
  sourceToken.level = "level-1";
  const remove = scene.deleteEmbeddedDocuments;
  scene.deleteEmbeddedDocuments = async (type, ids) => {
    if ( type !== "Region" ) return remove(type, ids);
    for ( const id of ids ) await scene.regions.find(region => region.id === id).delete();
  };
  const definition = {...ICE_WALL, area: {...ICE_WALL.area, persistence: {...ICE_WALL.area.persistence, elevation: {bottom: 0, top: 10},
    sections: {...ICE_SECTIONS, leaves}}}};
  const region = await areas.create({options: {persistentArea: {footprint: {topology: "square", fields: ICE_FIELDS}, definition,
    sourceTokenId: sourceToken.id, sceneId: scene.id}}, state: {configuration: {castingLevel: 7}}});
  const sections = scene.tokens.filter(token => token.flags?.wildpath?.section);
  const open = async section => {
    await scene.deleteEmbeddedDocuments("Token", [section.id]);
    await areas.onTokenDeleted(section);
  };
  const children = () => scene.regions.filter(entry => entry.flags.wildpath.area.parentRegionId === region.id);
  return {region, sections, open, children};
}

test("an opened section leaves its child area (sections.leaves) over its own fields, with the wall's caster, band, Level and cast level (wave D A16)", async t => {
  const fixture = sectionedFixture(t);
  const {scene, sourceToken} = fixture;
  fixture.game.user.color = "#cc2889";
  const {region, sections, open, children} = await castLeavingSections(fixture);
  assert.deepEqual(region.flags.wildpath.area.persistence.sections.leaves, FRIGID_LEAVES, "the wall's flag keeps what it leaves");
  assert.deepEqual(children(), [], "nothing is left while every section stands");
  await open(sections[0]);
  const [child] = children();
  const flag = child.flags.wildpath.area;
  assert.deepEqual([child.name, flag.actionDefinitionId, flag.sourceTokenId, flag.shape, flag.fields],
    ["Frigid Air", "action:ice-wall:leaves", sourceToken.id, "wall", [{x: 3, y: 2}, {x: 3, y: 3}]], "the first section's two fields");
  assert.deepEqual([flag.band, child.elevation, child.levels, flag.castLevel], [{bottom: 0, top: 10}, {bottom: 0, top: 10}, ["level-1"], 7],
    "the wall's band, Level and cast level, so Dispel Magic sees it as the wall's spell");
  assert.deepEqual([region.color, child.color], ["#cc2889", DERIVED_AREA_COLORS.derived], "drawn in its own colour, not its caster's");
  assert.deepEqual([flag.persistence.triggers, flag.persistence.concentration, flag.persistence.duration], [FRIGID_LEAVES.triggers, false, null],
    "an ordinary lasting area of its triggers, lasting as long as the wall");
  await open(sections[1]);
  assert.deepEqual(children().map(entry => entry.flags.wildpath.area.fields), [[{x: 3, y: 2}, {x: 3, y: 3}], [{x: 3, y: 4}]],
    "each opened section leaves its own");
  assert.equal(scene.regions.length, 3);
});

test("crossing what a section left is one save on a turn; stopping in it and leaving on a later turn is two (Q144 default)", async t => {
  const fixture = sectionedFixture(t);
  const {areas, targetActor, targetToken, game} = fixture;
  const {sections, open, children} = await castLeavingSections(fixture);
  await open(sections[0]);
  const [child] = children();
  const health = () => targetActor.system.resources.health.value;
  const start = health();
  await areas.apply(child, child.flags.wildpath.area, targetToken, "area.entered");
  await areas.apply(child, child.flags.wildpath.area, targetToken, "area.exited");
  assert.equal(health(), start - 4, "in and out on one turn: one save");
  game.combat.turn = 1;
  await areas.apply(child, child.flags.wildpath.area, targetToken, "area.entered");
  assert.equal(health(), start - 8, "it stops in it on its next turn");
  game.combat.turn = 2;
  await areas.apply(child, child.flags.wildpath.area, targetToken, "area.exited");
  assert.equal(health(), start - 12, "and leaving on a later turn saves again");
});

test("outside combat a once-a-turn trigger acts once while its creature stays: crossing what a section left is one save, entering again another", async t => {
  const fixture = sectionedFixture(t);
  const {areas, targetActor, targetToken, game} = fixture;
  const {sections, open, children} = await castLeavingSections(fixture);
  await open(sections[0]);
  const [child] = children();
  game.combat = null;
  const health = () => targetActor.system.resources.health.value;
  const start = health();
  await areas.apply(child, child.flags.wildpath.area, targetToken, "area.entered");
  await areas.apply(child, child.flags.wildpath.area, targetToken, "area.exited");
  assert.equal(health(), start - 4, "in and out: one save, not one for each");
  await areas.apply(child, child.flags.wildpath.area, targetToken, "area.entered");
  assert.equal(health(), start - 8, "its leaving freed it: entering again is another");
});

test("what a section leaves is made as any area: a light it sheds that dispels ends an overlapping weaker Darkness", async t => {
  const fixture = sectionedFixture(t);
  const {scene} = fixture;
  const {sections, open, children} = await castLeavingSections(fixture, {light: {bright: 10, dim: 20, dispels: 3}});
  scene.regions.push({id: "shadow", flags: {wildpath: {area: {fields: [{x: 3, y: 3}], topology: "square", castLevel: 2,
    persistence: {light: {bright: 15, darkness: true}}}}},
  async delete() { scene.regions.splice(scene.regions.indexOf(this), 1); }});
  await open(sections[0]);
  const [child] = children();
  assert.equal(scene.regions.some(region => region.id === "shadow"), false, "the Darkness over the opened space ended");
  assert.equal(scene.lights.get(child.flags.wildpath.area.lightId)?.config.bright, 10, "and its light is shed");
});

test("what a section left ends with its wall, and ending it ends the wall; a section its wall's end removes leaves nothing (wave D A16)", async t => {
  const fixture = sectionedFixture(t);
  const {scene, areas} = fixture;
  const {region, sections, open, children} = await castLeavingSections(fixture);
  await open(sections[0]);
  const [child] = children();
  // Dispel Magic choosing the sheet (endEffectsOnTargets' endArea) ends the wall's Region instead.
  await areas.end(child);
  assert.deepEqual(scene.regions.map(entry => entry.id), [child.id], "the wall's Region is deleted");
  // Foundry's deleteRegion hook: the wall's end takes its walls, its standing section, its Actor and the sheet.
  await areas.onRegionDeleted(region);
  assert.deepEqual([scene.regions, scene.walls.length, scene.tokens.some(token => token.flags?.wildpath?.section)], [[], 0, false]);
  await areas.onTokenDeleted(sections[1]);
  assert.deepEqual(scene.regions, [], "the section its end removed finds no wall Region, so leaves nothing");
});

test("an opened section leaves nothing without leaves, and nothing with its caster's Token gone (the GM is told)", async t => {
  const fixture = sectionedFixture(t);
  const {scene, areas} = fixture;
  const {sections} = await castSections(fixture);
  await scene.deleteEmbeddedDocuments("Token", [sections[0].id]);
  await areas.onTokenDeleted(sections[0]);
  assert.equal(scene.regions.length, 1, "a wall without leaves leaves nothing");
  const other = sectionedFixture(t);
  const warned = t.mock.method(console, "warn", () => {});
  const {sections: leaving, open, children} = await castLeavingSections(other);
  other.scene.tokens.splice(other.scene.tokens.indexOf(other.sourceToken), 1);
  await open(leaving[0]);
  assert.deepEqual(children(), []);
  assert.match(String(warned.mock.calls.at(-1)?.arguments[0]), /WILDPATH\.NOTICE\.AreaLeavesNoCaster/u);
});

test("what a wall's sections leave is a lasting area's persistence on a wall that lasts and stands as the wall does", () => {
  const area = persistence => ({schemaVersion: 1, id: "action:a", label: "A", costs: {allOf: []}, targeting: {type: "area"},
    area: {shape: "wall", size: {value: 30, unit: "ft"}, persistence: {blocks: ["move"], sections: {...ICE_SECTIONS, ...persistence}}}});
  const reasons = persistence => validateActionDefinition(area(persistence)).errors.map(error => error.path);
  assert.deepEqual(reasons({leaves: FRIGID_LEAVES}), []);
  assert.deepEqual(reasons({leaves: {difficultTerrain: {}, obscures: "lightly"}}), [], "rubble or shards, with no trigger");
  assert.deepEqual(reasons({leaves: "frigid"}), ["area.persistence.sections.leaves"]);
  assert.deepEqual([reasons({img: "icons/svg/frozen.svg"}), reasons({img: "worlds/w/ice.WEBP?v=2"}), reasons({img: ""}), reasons({img: 3}),
    reasons({img: "ice"}), reasons({img: "icons/wall.mp4"})],
  [[], [], ...Array(4).fill(["area.persistence.sections"])], "an img is a path Foundry takes as an image");
  assert.deepEqual(reasons({leaves: {triggers: [{on: ["area.left"], action: FRIGID_AIR}]}}), ["area.persistence.sections.leaves.triggers.0.on"],
    "its triggers are checked as any area's");
  for ( const key of ["duration", "concentration", "blocks"] ) {
    const own = {duration: {unit: "round", value: 10}, concentration: true, blocks: ["move"]}[key];
    assert.deepEqual(reasons({leaves: {...FRIGID_LEAVES, [key]: own}}), ["area.persistence.sections.leaves"], `no ${key} of its own`);
  }
});

test("the runtime opens a section from its deleteToken hook", () => {
  const runtime = readFileSync(new URL("../module/resolvers/foundry-multiplayer-runtime.mjs", import.meta.url), "utf8");
  assert.match(runtime, /Hooks\?\.on\?\.\("deleteToken", token => void areas\.onTokenDeleted\(token\)/u);
});

test("a section is an object: the object rule passes it by but for attacks and Actions that affect objects; its own rules make its damage profile", () => {
  const data = objectActorData(ICE_SECTIONS, "Ice Wall");
  assert.deepEqual([data.type, data.system.details.threat, data.system.defenses.ac.value, data.system.resources.health.base,
    data.system.resources.health.value, data.prototypeToken], ["npc", 0, 12, 30, 30, {actorLink: false, disposition: 0, texture: {src: OBJECT_IMG}}]);
  assert.equal(data.img, OBJECT_IMG, "a neutral object image when the sections name none");
  const painted = objectActorData({...ICE_SECTIONS, img: "icons/svg/frozen.svg"}, "Ice Wall");
  assert.deepEqual([painted.img, painted.prototypeToken.texture.src], ["icons/svg/frozen.svg", "icons/svg/frozen.svg"], "its own img when given");
  const [feature] = data.items;
  assert.deepEqual(feature.system.ruleElements[0], OBJECT_RULE, "the object rule first, then its own");
  const owners = [{ruleElements: feature.system.ruleElements, source: {name: "Ice Wall"}}];
  const blast = {schemaVersion: 1, id: "action:blast", tags: ["spell"], save: {ability: "agility", dc: {value: 15}}};
  assert.ok(unaffectingRule(owners, blast), "a save spell passes it by");
  assert.equal(unaffectingRule(owners, {...blast, attack: {type: "ranged", statistic: "spell"}}), null, "an attack reaches it");
  assert.equal(unaffectingRule(owners, {...blast, tags: ["spell", "affects:objects"]}), null, "so does an Action that affects objects");
  const profile = damageProfileFromRuleElements(owners);
  assert.deepEqual([profile.immunities.flatMap(entry => entry.damageTypes), profile.vulnerabilities.flatMap(entry => entry.damageTypes)],
    [["cold"], ["fire"]]);
  const grid = {isSquare: true, getTopLeftPoint: ({i, j}) => ({x: i * 50, y: j * 50})};
  assert.deepEqual(sectionTokenPlacement({grid}, [{x: 0, y: 0}, {x: 1, y: 1}]), {x: 0, y: 0, width: 1, height: 1},
    "a diagonal section's Token stands on its first field");
  assert.deepEqual(sectionTokenPlacement({grid}, [{x: 3, y: 1}, {x: 2, y: 1}]), {x: 100, y: 50, width: 2, height: 1},
    "a straight one's covers it, whichever way the wall runs");
});

test("a lasting area's sections: {size, ac, hp, ruleElements?} on a wall whose blocks stop movement", () => {
  const area = (persistence, shape="wall") => ({schemaVersion: 1, id: "action:a", label: "A", costs: {allOf: []}, targeting: {type: "area"},
    area: {shape, size: {value: 30, unit: "ft"}, persistence}});
  const reasons = (...args) => validateActionDefinition(area(...args)).errors.map(error => error.path);
  assert.deepEqual(reasons({blocks: ["move", "sight"], sections: ICE_SECTIONS}), []);
  assert.deepEqual(reasons({blocks: ["move"], sections: {size: 10, ac: 12, hp: 30}}), [], "its own rules are optional");
  for ( const sections of [{size: 10, ac: 12, hp: 30.5}, {size: 0, ac: 12, hp: 30}, {size: 10, ac: "12", hp: 30},
    {size: 10, ac: 12, hp: 30, ruleElements: {}}, "10"] ) {
    assert.deepEqual(reasons({blocks: ["move"], sections}), ["area.persistence.sections"], JSON.stringify(sections));
  }
  assert.deepEqual(reasons({blocks: ["sight"], sections: ICE_SECTIONS}), ["area.persistence.sections"], "its walls must stop movement");
  assert.deepEqual(reasons({sections: ICE_SECTIONS}), ["area.persistence.sections"], "nor without walls");
  assert.deepEqual(reasons({blocks: ["move"], sections: ICE_SECTIONS}, "line"), ["area.persistence.sections"], "only a wall");
  const nonsense = area({blocks: ["move"], sections: {...ICE_SECTIONS, ruleElements: [{schemaVersion: 1, id: "x", type: "Nonsense", data: {}}]}});
  assert.deepEqual(validateActionDefinition(nonsense).errors.map(error => [error.path, error.code]),
    [["area.persistence.sections.ruleElements.0", ACTION_DEFINITION_CODES.INVALID_RULE_ELEMENT]], "its rules are checked as any, with their code");
});

/** A fissure-like area that opens the walls under it (`walls: "open"`), and a full wall (all senses NORMAL) on Level 1. */
const FISSURE = {id: "action:fissure", label: "Fissure", area: {shape: "line", size: {value: 10, unit: "ft"},
  persistence: {duration: {unit: "round", value: 10}, walls: "open"}}};
const fullWall = (id, c, extra={}) => ({id, c, move: 20, sight: 20, light: 20, sound: 20, dir: 0, door: 0, levels: ["level-1"], flags: {},
  ...extra});
const openArea = (fixture, fields) => fixture.areas.create({options: {persistentArea: {footprint: {topology: "square", fields},
  definition: FISSURE, sourceTokenId: fixture.sourceToken.id, sceneId: fixture.scene.id}}, state: {configuration: {}}});
const piecesOf = (scene, id) => scene.walls.filter(wall => wall.flags?.wildpath?.pieceOf === id).map(wall => wall.c)
  .sort((a, b) => a[0] - b[0]);
const endArea = async (areas, region) => {
  await region.delete();
  await areas.onRegionDeleted(region);
};

test("an opening area (walls: \"open\") hides each original wall its cells cut and stands it again outside them; its end restores it", async t => {
  const fixture = walledAreaFixture(t);
  const {scene, areas, sourceToken, game} = fixture;
  sourceToken.level = "level-1";
  // Field (3, 2) is pixels 150-200 by 100-150: the first four walls cross it.
  scene.walls.push(fullWall("crossing", [0, 125, 400, 125]), fullWall("upstairs", [0, 120, 400, 120], {levels: ["level-2"]}),
    fullWall("door", [175, 0, 175, 400], {door: 1}), fullWall("ice", [160, 0, 160, 400], {flags: {wildpath: {areaRegion: "region-9"}}}),
    fullWall("beside", [0, 25, 400, 25]));
  const region = await openArea(fixture, [{x: 3, y: 2}]);
  assert.equal(region.flags.wildpath.area.persistence.walls, "open", "its flag keeps the key");
  const crossing = scene.walls.find(wall => wall.id === "crossing");
  assert.deepEqual([crossing.move, crossing.sight, crossing.light, crossing.sound], [0, 0, 0, 0], "the original stops nothing");
  assert.deepEqual([crossing.c, crossing.flags.wildpath.openedBy, crossing.flags.wildpath.senses],
    [[0, 125, 400, 125], [region.id], {move: 20, sight: 20, light: 20, sound: 20}], "hidden, not moved, its own senses kept");
  assert.deepEqual(piecesOf(scene, "crossing"), [[0, 125, 150, 125], [200, 125, 400, 125]], "its pieces stand outside the cell");
  const piece = scene.walls.find(wall => wall.flags?.wildpath?.pieceOf === "crossing");
  assert.deepEqual([piece.move, piece.sight, piece.dir, piece.levels, piece.id !== "crossing"], [20, 20, 0, ["level-1"], true],
    "a piece is the original as drawn, as a wall of its own");
  const door = scene.walls.find(wall => wall.id === "door");
  assert.deepEqual([door.move, piecesOf(scene, "door")], [0, []], "a door is opened whole (shortcut)");
  for ( const id of ["upstairs", "ice", "beside"] ) {
    assert.deepEqual(scene.walls.find(wall => wall.id === id).move, 20, `${id} is untouched`);
    assert.equal(scene.walls.find(wall => wall.id === id).flags?.wildpath?.openedBy, undefined, `${id} is not opened`);
  }
  // Only the active GM writes walls.
  game.users.activeGM = {id: "gm-b"};
  await areas.onRegionDeleted(region);
  assert.equal(scene.walls.length, 7, "a client that is not the active GM changes nothing");
  game.users.activeGM = game.user;
  await endArea(areas, region);
  assert.deepEqual(scene.walls.map(wall => [wall.id, wall.move, wall.sight, wall.light, wall.sound, wall.flags?.wildpath?.openedBy ?? null]),
    [["crossing", 20, 20, 20, 20, null], ["upstairs", 20, 20, 20, 20, null], ["door", 20, 20, 20, 20, null], ["ice", 20, 20, 20, 20, null],
      ["beside", 20, 20, 20, 20, null]], "its end restores every wall and removes the pieces");
});

test("two opening areas over one wall, ended in either order, give the same pieces and then the original", async t => {
  for ( const order of [[0, 1], [1, 0]] ) {
    const fixture = walledAreaFixture(t);
    const {scene, areas} = fixture;
    scene.walls.push(fullWall("crossing", [0, 125, 400, 125], {levels: []}));
    const regions = [await openArea(fixture, [{x: 3, y: 2}]), await openArea(fixture, [{x: 6, y: 2}])];
    assert.deepEqual(piecesOf(scene, "crossing"), [[0, 125, 150, 125], [200, 125, 300, 125], [350, 125, 400, 125]], "cut by both");
    assert.deepEqual(scene.walls.find(wall => wall.id === "crossing").flags.wildpath.openedBy, ["region-1", "region-2"]);
    await endArea(areas, regions[order[0]]);
    assert.deepEqual(piecesOf(scene, "crossing"), order[0] ? [[0, 125, 150, 125], [200, 125, 400, 125]] : [[0, 125, 300, 125], [350, 125, 400, 125]],
      `the area still standing still cuts it (${order})`);
    assert.equal(scene.walls.find(wall => wall.id === "crossing").move, 0);
    await endArea(areas, regions[order[1]]);
    assert.deepEqual([scene.walls.length, scene.walls[0].move, scene.walls[0].flags.wildpath.openedBy], [1, 20, null], "then restored");
  }
  // Ended in one batch, their delete hooks run at once: one after the other on the walls, never deleting a piece twice.
  const fixture = walledAreaFixture(t);
  const {scene, areas} = fixture;
  scene.walls.push(fullWall("crossing", [0, 125, 400, 125], {levels: []}));
  const regions = [await openArea(fixture, [{x: 3, y: 2}]), await openArea(fixture, [{x: 6, y: 2}])];
  for ( const region of regions ) await region.delete();
  await Promise.all(regions.map(region => areas.onRegionDeleted(region)));
  assert.deepEqual([scene.walls.length, scene.walls[0].move], [1, 20], "both ended together restore the wall");
});

test("a wall on several Levels is opened on each only by the areas there, and stands whole on a Level none opens it", async t => {
  const fixture = walledAreaFixture(t);
  const {scene, areas, sourceToken} = fixture;
  scene.levels = new Map([["level-1", {elevation: {bottom: 0}}], ["level-2", {elevation: {bottom: 20}}]]);
  scene.walls.push(fullWall("crossing", [0, 125, 400, 125], {levels: []}));
  const piecesOn = () => scene.walls.filter(wall => wall.flags?.wildpath?.pieceOf === "crossing")
    .map(wall => [wall.levels.join(), wall.c.join()]).sort((a, b) => a.join().localeCompare(b.join()));
  sourceToken.level = "level-1";
  const below = await openArea(fixture, [{x: 3, y: 2}]);
  assert.deepEqual(piecesOn(), [["level-1", "0,125,150,125"], ["level-1", "200,125,400,125"], ["level-2", "0,125,400,125"]],
    "an all-Level wall is cut on the area's Level and stands whole on the other");
  sourceToken.level = "level-2";
  const above = await openArea(fixture, [{x: 6, y: 2}]);
  assert.deepEqual(piecesOn(), [["level-1", "0,125,150,125"], ["level-1", "200,125,400,125"],
    ["level-2", "0,125,300,125"], ["level-2", "350,125,400,125"]], "each Level cut only by its own area");
  await endArea(areas, below);
  assert.deepEqual(piecesOn(), [["level-1", "0,125,400,125"], ["level-2", "0,125,300,125"], ["level-2", "350,125,400,125"]]);
  await endArea(areas, above);
  assert.deepEqual([scene.walls.length, scene.walls[0].move, scene.walls[0].levels], [1, 20, []], "then restored");
});

test("dragging an opening area restores the walls it left and opens the ones it now crosses", async t => {
  const fixture = walledAreaFixture(t);
  const {scene, areas} = fixture;
  scene.walls.push(fullWall("left", [0, 125, 400, 125]), fullWall("reached", [0, 425, 400, 425]));
  const region = await openArea(fixture, [{x: 3, y: 2}]);
  assert.deepEqual([scene.walls.find(wall => wall.id === "left").move, piecesOf(scene, "reached")], [0, []]);
  region.shapes = [{type: "grid", offsets: [{i: 3, j: 8}]}];
  await areas.onRegionUpdated(region, {shapes: region.shapes});
  assert.deepEqual(region.flags.wildpath.area.fields, [{x: 3, y: 8}], "the drag moved it");
  const left = scene.walls.find(wall => wall.id === "left");
  assert.deepEqual([left.move, left.flags.wildpath.openedBy, piecesOf(scene, "left")], [20, null, []], "the wall it left stands whole again");
  assert.deepEqual([scene.walls.find(wall => wall.id === "reached").move, piecesOf(scene, "reached")],
    [0, [[0, 425, 150, 425], [200, 425, 400, 425]]], "the wall it now crosses is opened");
});

/**
 * Earthquake-like openings (hand-written, no converter yet: wave D A19): 1d4 fissures, each 1d10 x 10 feet deep and 10 feet
 * wide, not dispellable, opening the walls under them; each burns the creatures in it as it opens and those who enter it.
 */
const OPENINGS = {label: "Fissure", count: {type: "dice", number: 1, faces: 4},
  depth: {type: "multiply", terms: [{type: "dice", number: 1, faces: 10}, {type: "constant", value: 10}]}, width: {value: 10, unit: "ft"},
  persistence: {walls: "open", dispellable: false, elevation: {bottom: 0, top: 0},
    triggers: [{on: ["area.created", "area.entered"], action: BURNING}]}};
/** A 5 by 5 block of fields, columns and rows 0 to 4, as the area that ran the Action stood. */
const QUAKE_FIELDS = [0, 1, 2, 3, 4].flatMap(x => [0, 1, 2, 3, 4].map(y => ({x, y})));
/** The fixture's dice: the policy answers each RollRequest with the next total, and Foundry's Roll is a stand-in. */
function openingDice(t, game, totals) {
  const asked = [];
  game.wildpath = {...game.wildpath, requestRoll: async request => (asked.push(request.formula), (totals.length ? {total: totals.shift()} : null))};
  // Once a test (a second table in it keeps the first's), so its end puts the real globals back.
  if ( globalThis.foundry?.dice?.openingStub ) return asked;
  const saved = globalThis.foundry;
  globalThis.foundry = {...saved, utils: {...saved?.utils, randomID: () => "roll"},
    dice: {openingStub: true, Roll: class { constructor(formula) { this.formula = formula; } async evaluate() { return this; } }}};
  t.after(() => { globalThis.foundry = saved; });
  return asked;
}
async function laidOpenings(t, totals=[2, 3, 5], {walls=null, prepare=() => {}}={}) {
  const fixture = walledAreaFixture(t);
  const {scene, areas, sourceToken, game} = fixture;
  sourceToken.level = "level-1";
  // A wall along row 2 and a post down column 4: the bands that cross fewest of them are rows 0-1 and 3-4.
  scene.walls.push(...(walls ?? [fullWall("row", [0, 125, 400, 125]), fullWall("post", [225, 0, 225, 400])]));
  prepare(fixture);
  const asked = openingDice(t, game, totals);
  const card = {sceneId: scene.id, sourceTokenId: sourceToken.id};
  const entry = {opens: OPENINGS, parentArea: {sceneId: scene.id, regionId: "quake", topology: "square", fields: QUAKE_FIELDS, castLevel: 8},
    actionId: "action:quake", name: "Fissure", tags: ["spell"]};
  const laid = await areas.rollOpenings(entry, card);
  return {...fixture, asked, card, laid};
}

test("opens rolls its count and each depth once and lays pending openings across the area, off the walls, seen by the GM only", async t => {
  const {scene, laid, asked, targetToken, targetActor, areas, game} = await laidOpenings(t);
  assert.deepEqual(asked, ["1d4", "1d10", "1d10"], "the count, then one depth for each opening placed, by the dice policy");
  assert.deepEqual([laid.count, laid.depths, laid.regionIds], [2, [30, 50], ["region-1", "region-2"]]);
  assert.deepEqual(laid.definition, {id: "action:quake:opens", label: "Fissure", tags: ["spell"], area: {shape: "line", persistence: OPENINGS.persistence}});
  const rows = region => [...new Set(region.flags.wildpath.area.fields.map(field => field.y))].sort();
  assert.deepEqual(scene.regions.map(rows), [[0, 1], [3, 4]], "along the row wall, off it: fewest walls crossed");
  assert.deepEqual(scene.regions.map(region => [region.visibility, region.flags.wildpath.area.pending, region.flags.wildpath.area.depth,
    region.flags.wildpath.area.castLevel]), [[1, true, 30, null], [1, true, 50, null]],
    "the GM's only, pending, its own depth, and no cast level (dispellable: false)");
  assert.deepEqual(scene.regions.map(region => region.color), [DERIVED_AREA_COLORS.pending, DERIVED_AREA_COLORS.pending],
    "marked pending in their own colour, not the caster's");
  assert.deepEqual(scene.walls.map(wall => [wall.id, wall.move]), [["row", 20], ["post", 20]], "a pending opening opens no wall");
  Object.assign(targetToken, {x: 100, y: 0});
  assert.deepEqual(await areas.apply(scene.regions[0], scene.regions[0].flags.wildpath.area, targetToken, "area.entered"), [],
    "and answers nothing");
  assert.equal(targetActor.system.resources.health.value, 30);
  // The GM drags one before Open (Q92 (b)): it lies where drawn, still opening nothing.
  scene.regions[0].shapes = [{type: "grid", offsets: [{i: 3, j: 6}, {i: 4, j: 6}]}];
  await areas.onRegionUpdated(scene.regions[0], {shapes: scene.regions[0].shapes});
  assert.deepEqual([scene.regions[0].flags.wildpath.area.fields, scene.walls.map(wall => wall.move)], [[{x: 3, y: 6}, {x: 4, y: 6}], [20, 20]],
    "dragged across the post, it still opens nothing");
  // A die closed unrolled (physical dice): nothing is written.
  const closed = await laidOpenings(t, [2, 3]);
  assert.deepEqual([closed.laid, closed.scene.regions.length], [null, 0], "the second depth closed: no opening, the roll to press again");
  assert.equal(game.users.activeGM.id, game.user.id);
});

test("Open brings each pending opening into effect: seen by all, the walls under it opened, one Action over the creatures in it", async t => {
  const {scene, laid, card, areas, targetToken, targetActor, farToken, far, sourceToken, gm, game} = await laidOpenings(t);
  Object.assign(sourceToken, {x: 400, y: 400});
  Object.assign(targetToken, {x: 100, y: 0});
  // Over the second opening, but 30 feet up: above its ground band.
  Object.assign(farToken, {x: 100, y: 200, elevation: 30});
  const seen = [];
  const persistencePort = createTestDocumentPersistenceAdapter();
  const spied = createFoundryPersistentAreas({game, coordinator: gm, resolveAction: options => {
    seen.push(options);
    return foundryActionIntentToStagedOptions({...options, game, persistencePort});
  }});
  // The GM deleted the second before Open: only the first opens.
  const second = scene.regions[1];
  await second.delete();
  const opened = await spied.openOpenings({regionIds: laid.regionIds, definition: laid.definition}, card);
  assert.deepEqual(opened, {regionIds: ["region-1"]});
  const [region] = scene.regions;
  assert.deepEqual([region.visibility, region.flags.wildpath.area.pending, region.color], [2, false, DERIVED_AREA_COLORS.derived],
    "seen by everyone, in effect, in an opened area's colour");
  assert.deepEqual(scene.walls.find(wall => wall.id === "post").move, 0, "the post under it is opened");
  assert.deepEqual(piecesOf(scene, "post").length > 0, true);
  assert.equal(targetActor.system.resources.health.value, 26, "the creature in it as it opens: one Action");
  assert.equal(far.system.resources.health.value, 30);
  assert.deepEqual(seen.map(options => [options.intent.targetRefs.map(target => target.tokenId), options.noCover, options.parentArea]),
    [[["target-token"], true, {sceneId: scene.id, regionId: "region-1"}]], "with no cover, and the opening as its parentArea");
  assert.equal(await spied.openOpenings({regionIds: laid.regionIds, definition: laid.definition}, card).then(result => result.regionIds.length), 0,
    "an opened one opens no more");
  // Its caster's Token gone: nothing opens, and the GM is told.
  const warned = t.mock.method(console, "warn", () => {});
  assert.equal(await spied.openOpenings({regionIds: laid.regionIds, definition: laid.definition}, {...card, sourceTokenId: "gone"}), null);
  assert.match(String(warned.mock.calls[0]?.arguments[0]), /WILDPATH\.NOTICE\.OpensNoCaster/);
});

test("walls drawn on grid lines steer the openings off them and are opened under them at Open", async t => {
  // Walls on the grid lines inside each row band (y 50 and 200): a row band runs along one (every cell of it touching it),
  // any other band only crosses them. Uncounted, every band would cost nothing and the first direction (rows) win.
  const {scene, laid, card, areas} = await laidOpenings(t, [2, 3, 5],
    {walls: [fullWall("north", [0, 50, 250, 50]), fullWall("south", [0, 200, 250, 200])]});
  const rows = region => new Set(region.flags.wildpath.area.fields.map(field => field.y)).size;
  assert.deepEqual(scene.regions.map(rows).map(count => count > 2), [true, true], "the grid-line walls counted: not along them");
  await areas.openOpenings({regionIds: laid.regionIds, definition: laid.definition}, card);
  assert.deepEqual(scene.walls.filter(wall => ["north", "south"].includes(wall.id)).map(wall => wall.move), [0, 0],
    "both opened: each runs between two cells of an opening");
});

test("a creation that fails partway deletes the openings it made; none laid tells the GM and adds nothing", async t => {
  let failed = null;
  const failing = laidOpenings(t, [2, 3, 5], {prepare: ({scene}) => {
    failed = scene;
    const create = scene.createEmbeddedDocuments;
    let regions = 0;
    scene.createEmbeddedDocuments = async (type, data) => {
      if ( (type === "Region") && (++regions === 2) ) throw new Error("refused");
      return create(type, data);
    };
  }});
  await assert.rejects(failing, /refused/);
  assert.deepEqual(failed.regions.length, 0, "the first opening, made before the second failed, is gone");
  const warned = t.mock.method(console, "warn", () => {});
  const none = await laidOpenings(t, [0]);
  assert.deepEqual([none.laid.regionIds, none.scene.regions.length, none.asked], [[], 0, ["1d4"]], "a count of 0: no depth rolled");
  assert.match(String(warned.mock.calls[0]?.arguments[0]), /WILDPATH\.NOTICE\.OpensNone/);
});

test("a lasting area made in effect answers area.created at once; the Action it runs reads that area as its parentArea", async t => {
  const fixture = walledAreaFixture(t);
  const {scene, areas, sourceToken, targetToken, targetActor, game} = fixture;
  Object.assign(sourceToken, {x: 400, y: 400});
  Object.assign(targetToken, {x: 100, y: 0});
  const definition = {id: "action:pit", label: "Pit", area: {shape: "line", size: {value: 10, unit: "ft"},
    persistence: {depth: 10, triggers: [{on: ["area.created"], action: BURNING}]}}};
  const region = await areas.create({options: {persistentArea: {footprint: {topology: "square", fields: [{x: 2, y: 0}, {x: 3, y: 0}]},
    definition, sourceTokenId: sourceToken.id, sceneId: scene.id}}, state: {configuration: {}}});
  assert.equal(targetActor.system.resources.health.value, 26, "the creature in it as it appears");
  assert.equal(region.flags.wildpath.area.depth, 10, "its own depth (a pit's), for a fall with no feet");
  await areas.apply(region, region.flags.wildpath.area, targetToken, "area.entered");
  assert.equal(targetActor.system.resources.health.value, 26, "area.created answers its appearing only");
  // The authority reads the area that runs an Action as it stands when the Action starts.
  Object.assign(region.flags.wildpath.area, {depth: 40, castLevel: 7});
  const options = await foundryActionIntentToStagedOptions({intent: {actorRef: fixture.sourceActor.uuid, source: {tokenId: sourceToken.id,
    sceneId: scene.id}, targetRefs: [{actorRef: targetActor.uuid, tokenId: targetToken.id, sceneId: scene.id}]}, game,
    senderUserId: game.user.id, action: {id: "x", type: "action", name: "X", system: {definition: BURNING}},
    parentArea: {sceneId: scene.id, regionId: region.id}, persistencePort: createTestDocumentPersistenceAdapter()});
  assert.equal(options.ok, true, JSON.stringify(options.reason ?? ""));
  assert.deepEqual(options.options.parentArea, {sceneId: scene.id, regionId: region.id, topology: "square",
    fields: [{x: 2, y: 0}, {x: 3, y: 0}], castLevel: 7, depth: 40});
});

test("an area without walls: \"open\" leaves the walls under it alone, as before", async t => {
  const fixture = walledAreaFixture(t);
  const {scene, areas, sourceToken} = fixture;
  scene.walls.push(fullWall("crossing", [0, 125, 400, 125]));
  const {walls: _walls, ...persistence} = FISSURE.area.persistence;
  const region = await areas.create({options: {persistentArea: {footprint: {topology: "square", fields: [{x: 3, y: 2}]},
    definition: {...FISSURE, area: {...FISSURE.area, persistence}}, sourceTokenId: sourceToken.id, sceneId: scene.id}}, state: {configuration: {}}});
  await endArea(areas, region);
  assert.deepEqual(scene.walls, [fullWall("crossing", [0, 125, 400, 125])]);
});

test("Unaffected: a lasting area's trigger leaves out a creature immune to its spell, spending nothing of its turn", async t => {
  const {scene, areas, sourceToken, targetActor, targetToken} = lastingAreaFixture(t);
  const onto = createFoundryV14TacticalGridAdapter({scene}).tokenToFootprint(targetToken).footprint.fields;
  const region = await areas.create({options: {persistentArea: {footprint: {topology: "square", fields: onto},
    definition: {id: "action:burn", label: "Burn", area: {shape: "radial", size: {value: 5, unit: "ft"}, persistence: {
      duration: {unit: "round", value: 10}, triggers: [{on: ["turn.started"], action: {...BURNING, tags: ["spell", "spell:spell-a"]}}]}}},
    sourceTokenId: sourceToken.id, sceneId: scene.id}}, state: {configuration: {}}});
  const health = targetActor.system.resources.health.value;
  targetActor.effects = [SPELL_A_IMMUNITY];
  await areas.onTurn("turn.started", {combatant: {token: targetToken}});
  assert.equal(targetActor.system.resources.health.value, health, "untouched");
  assert.equal(region.flags.wildpath.area.applied?.[targetToken.id], undefined, "its once-per-turn use is not spent");
  targetActor.effects = [];
  await areas.onTurn("turn.started", {combatant: {token: targetToken}});
  assert.equal(targetActor.system.resources.health.value, health - 4, "without the immunity it burns");
});

test("a lasting area for enemies only (Spirit Guardians) spares its caster's side", async t => {
  const {targetActor, targetToken, sourceToken, player, areas, intent, game} = lastingAreaFixture(t, {affects: "enemies"});
  const declared = await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  assert.equal(declared.ok, true, JSON.stringify(declared));
  const cast = targetActor.system.resources.health.value;
  Object.assign(sourceToken, {disposition: 1});
  Object.assign(targetToken, {disposition: 1});
  await areas.onTurn("turn.started", {combatant: {token: targetToken}});
  assert.equal(targetActor.system.resources.health.value, cast, "an ally starting its turn there is spared");
  targetToken.disposition = -1;
  game.combat.turn = 1;
  await areas.onTurn("turn.started", {combatant: {token: targetToken}});
  assert.equal(targetActor.system.resources.health.value, cast - 4, "an enemy burns");
});

test("a lasting area for allies only (\"you and your allies\") acts on its caster's side and spends nothing on the rest", async t => {
  const {scene, targetActor, targetToken, sourceToken, player, areas, intent, game} = lastingAreaFixture(t, {affects: "allies"});
  const declared = await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  assert.equal(declared.ok, true, JSON.stringify(declared));
  const [region] = scene.regions;
  assert.equal(region.flags.wildpath.area.persistence.affects, "allies", "the Region's flag keeps its side");
  const cast = targetActor.system.resources.health.value;
  sourceToken.disposition = 1;
  for ( const disposition of [-1, 0] ) {
    targetToken.disposition = disposition;
    await areas.onTurn("turn.started", {combatant: {token: targetToken}});
  }
  assert.equal(targetActor.system.resources.health.value, cast, "a hostile and a neutral creature are spared");
  assert.deepEqual(region.flags.wildpath.area.applied, {}, "and spend none of its once-per-turn use");
  targetToken.disposition = 1;
  await areas.onTurn("turn.started", {combatant: {token: targetToken}});
  assert.equal(targetActor.system.resources.health.value, cast - 4, "an ally is affected");
});

test("a dead creature is an object: a lasting area and an aura pass it by", async t => {
  // Live 9: a dead creature in an area still rolled its save.
  const {targetActor, targetToken, sourceActor, sourceToken, player, areas, automation, intent, game} = lastingAreaFixture(t);
  const declared = await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  assert.equal(declared.ok, true, JSON.stringify(declared));
  const cast = targetActor.system.resources.health.value;
  targetActor.statuses = new Set(["dead"]);
  assert.deepEqual(await areas.onTurn("turn.started", {combatant: {token: targetToken}}), [], "a lasting area");
  // Its caster's own Emanation as its turn starts, and the aura around it as the dead creature's turn starts.
  sourceActor.items = [triggerFeature("fire-aura", {event: "turn.started", around: {radius: 5, affects: "others"}})];
  assert.deepEqual(await automation.dispatch("turn.started", {actor: sourceActor, token: sourceToken}), [], "its own Emanation");
  sourceActor.items = [triggerFeature("fear-aura", {event: "turn.started", around: {radius: 5, affects: "others", on: "others"}})];
  assert.deepEqual(await automation.dispatch("turn.started", {actor: targetActor, token: targetToken}), [], "another's aura");
  assert.equal(targetActor.system.resources.health.value, cast, "untouched");
  targetActor.statuses = new Set();
  game.combat.turn = 1;
  await areas.onTurn("turn.started", {combatant: {token: targetToken}});
  assert.equal(targetActor.system.resources.health.value, cast - 4, "alive, the area reaches it");
});

test("a lasting area that sheds light (Daylight) places it at its center, as sunlight, and takes it away when it ends", async t => {
  const {scene, player, areas, intent} = lastingAreaFixture(t, {light: {bright: 10, dim: 20, sunlight: true}});
  const declared = await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  assert.equal(declared.ok, true, JSON.stringify(declared));
  const [region] = scene.regions;
  const light = scene.lights.get(region.flags.wildpath.area.lightId);
  assert.deepEqual([light.config, light.flags.wildpath.sunlight, light.flags.wildpath.areaRegion],
    [{bright: 10, dim: 20, negative: false}, true, region.id]);
  assert.ok(Number.isFinite(light.x) && Number.isFinite(light.y), "at the area's center");
  await region.delete();
  await areas.onRegionDeleted(region);
  assert.equal(scene.lights.size, 0, "it goes with the area");
});

test("Daylight cast on an object follows it with that Token's own light, and ends weaker Darkness it overlaps", async t => {
  const darkness = {bright: 15, darkness: true, dispels: 2, spellLevel: 2};
  const {scene, areas, sourceToken, farToken: targetToken, player, gm, intent} = lastingAreaFixture(t, {light: darkness});
  // The object at the area's center: a Token with a light of its own, which the area borrows and gives back.
  const original = targetToken.toObject?.bind(targetToken);
  Object.assign(targetToken, {light: {bright: 5, dim: 10}, flags: {},
    toObject(...args) { return {...(original?.(...args) ?? {}), light: {...this.light}}; },
    async update(changes) {
      if ( changes.light ) this.light = changes.light;
      if ( "flags.wildpath.sunlight" in changes ) this.flags = {wildpath: {sunlight: changes["flags.wildpath.sunlight"]}};
    }});
  const declaredShadow = await player.declareActionIntent({...intent, area: {points: [{x: 275, y: 25}]}});
  assert.equal(declaredShadow.ok, true);
  const [shadow] = scene.regions;
  assert.ok(shadow, JSON.stringify(gm.errors ?? null).slice(0, 300));
  assert.deepEqual([shadow.flags.wildpath.area.castLevel, scene.lights.get(shadow.flags.wildpath.area.lightId).config.negative], [2, true],
    "Darkness sheds darkness; with no slot chosen, its own level");
  const {topology, fields} = shadow.flags.wildpath.area;
  const daylight = {id: "action:daylight", label: "Daylight", area: {shape: "radial", size: {value: 5, unit: "ft"},
    persistence: {light: {bright: 60, dim: 120, sunlight: true, dispels: 3, spellLevel: 3}, onObject: "on-object"}}};
  const cast = (definition, configuration) => areas.create({options: {persistentArea: {footprint: {topology, fields}, definition,
    sourceTokenId: sourceToken.id, sceneId: scene.id}}, state: {configuration}});
  const day = await cast(daylight, {castingLevel: 3, choices: [{id: "on-object", value: true}]});
  assert.equal(scene.regions.includes(shadow), false, "Darkness of level 2 is ended");
  assert.deepEqual([day.attachment.token, day.flags.wildpath.area.anchorTokenId, day.flags.wildpath.area.attached],
    [targetToken.id, targetToken.id, true], "cast on the Token at its center, it goes where that Token goes");
  assert.deepEqual([targetToken.light, targetToken.flags.wildpath.sunlight], [{bright: 60, dim: 120, negative: false}, true]);
  await day.delete();
  await areas.onRegionDeleted(day);
  assert.deepEqual([targetToken.light, targetToken.flags.wildpath.sunlight], [{bright: 5, dim: 10}, false], "its own light comes back");

  const deep = await cast({...daylight, id: "action:darkness", area: {...daylight.area, persistence: {light: darkness}}}, {castingLevel: 4});
  await cast(daylight, {castingLevel: 3});
  assert.ok(scene.regions.includes(deep), "Darkness cast at level 4 outlasts Daylight");
});

test("a lasting area with dispellable: false keeps no cast level: Dispel Magic never lists it and no light ends it (S7)", async t => {
  const {scene, sourceToken, areas} = lastingAreaFixture(t);
  const cast = (label, persistence, castingLevel) => areas.create({options: {persistentArea: {footprint: {topology: "square",
    fields: [{x: 1, y: 0}]}, definition: {id: `action:${label}`, label, metadata: {spellLevel: 2}, area: {shape: "radial",
      size: {value: 15, unit: "ft"}, persistence}}, sourceTokenId: sourceToken.id, sceneId: scene.id}}, state: {configuration: {castingLevel}}});
  const darkness = {light: {bright: 15, darkness: true, spellLevel: 2}};
  const ward = await cast("Ward", {...darkness, dispellable: false}, 2);
  const shadow = await cast("Shadow", {...darkness, dispellable: true}, 2);
  const plain = await cast("Plain", darkness, null);
  assert.deepEqual([ward, shadow, plain].map(region => region.flags.wildpath.area.castLevel), [null, 2, 2],
    "no cast level whatever its slot or spell level; true and absent as before");
  assert.deepEqual(spellAreasWithin(sourceToken, 120).map(entry => entry.region), [shadow, plain], "Dispel Magic lists only the others");
  await cast("Daylight", {light: {bright: 60, dim: 120, sunlight: true, dispels: 9, spellLevel: 3}}, 3);
  assert.deepEqual([ward, shadow, plain].map(region => scene.regions.includes(region)), [true, false, false],
    "a light dispelling darkness of any level ends the others, not it");
});

test("endWithSource ends only its creature's lasting areas with endsWhen: \"sourceDies\" (S2)", async t => {
  const {scene, sourceToken, sourceActor, targetToken, targetActor, game, areas} = lastingAreaFixture(t);
  const cast = (label, token, persistence) => areas.create({options: {persistentArea: {footprint: {topology: "square",
    fields: [{x: 1, y: 0}]}, definition: {id: `action:${label}`, label, area: {shape: "radial", size: {value: 5, unit: "ft"},
      persistence}}, sourceTokenId: token.id, sceneId: scene.id}}, state: {}});
  const mirror = await cast("Mirror", sourceToken, {endsWhen: "sourceDies"});
  const lasting = await cast("Lasting", sourceToken, {});
  const theirs = await cast("Theirs", targetToken, {endsWhen: "sourceDies"});
  assert.deepEqual([mirror, lasting].map(region => region.flags.wildpath.area.persistence.endsWhen), ["sourceDies", undefined],
    "the key reaches the Region's flag");
  game.users.activeGM = game.users.get("player-a");
  await areas.endWithSource(sourceActor);
  assert.equal(scene.regions.length, 3, "only the active GM ends them");
  game.users.activeGM = game.user;
  await areas.endWithSource(null);
  await areas.endWithSource(sourceActor);
  assert.deepEqual(scene.regions, [lasting, theirs], "its own keyed area ends; one without the key and another's stay");
  await areas.endWithSource(targetActor);
  assert.deepEqual(scene.regions, [lasting]);
});

test("endWithSource dismisses a summoned cast once and leaves its other Tokens' Regions to Foundry, then ends the rest (S2)", async t => {
  const dismissed = [];
  const fixture = lastingAreaFixture(t, {dismissSummon: async (scene, ids) => {
    dismissed.push(...ids);
    // dismissCast: the whole cast leaves, and V14 deletes the Tokens' attached Regions itself.
    for ( const token of scene.tokens.filter(entry => entry.flags?.wildpath?.summon) ) scene.tokens.splice(scene.tokens.indexOf(token), 1);
    for ( const region of scene.regions.filter(entry => entry.flags.wildpath.area.anchorTokenId) ) await region.delete();
  }});
  const {scene, sourceToken, sourceActor, areas} = fixture;
  const wolves = [summonedToken(fixture, "wolf-a", {i: 2, j: 0}), summonedToken(fixture, "wolf-b", {i: 4, j: 0})];
  const carried = await areas.carry({state: {source: {tokenId: sourceToken.id},
    actionDefinition: carrying(4, {persistence: {endsWhen: "sourceDies"}})}}, wolves);
  const placed = await areas.create({options: {persistentArea: {footprint: {topology: "square", fields: [{x: 1, y: 0}]},
    definition: {id: "action:mirror", label: "Mirror", area: {shape: "radial", size: {value: 5, unit: "ft"},
      persistence: {endsWhen: "sourceDies"}}}, sourceTokenId: sourceToken.id, sceneId: scene.id}}, state: {}});
  assert.equal(carried.length, 2);
  // A Region Foundry already deleted cannot be deleted again (the server's "does not exist").
  for ( const region of scene.regions ) {
    const remove = region.delete;
    region.delete = async function() {
      if ( !scene.regions.includes(this) ) throw new Error(`Region "${this.id}" does not exist!`);
      return remove.call(this);
    };
  }
  await areas.endWithSource(sourceActor);
  assert.deepEqual([dismissed, scene.regions.includes(placed), scene.regions.length], [["wolf-a"], false, 0],
    "the cast is dismissed once, the second wolf's Region is not deleted again, and the placed area after it still ends");
});

test("a death settled by settleDeaths ends its sourceDies areas before the sourceDies effects it gave (Checkpoint 1, S2)", async t => {
  const {scene, sourceToken, sourceActor, areas} = lastingAreaFixture(t);
  const cast = (label, persistence) => areas.create({options: {persistentArea: {footprint: {topology: "square",
    fields: [{x: 1, y: 0}]}, definition: {id: `action:${label}`, label, area: {shape: "radial", size: {value: 5, unit: "ft"},
      persistence}}, sourceTokenId: sourceToken.id, sceneId: scene.id}}, state: {}});
  const mirror = await cast("Mirror", {endsWhen: "sourceDies"});
  const lasting = await cast("Lasting", {});
  const deleted = [];
  const effect = (id, metadata) => ({id, flags: {wildpath: {conditionEffect: {sourceRef: sourceActor.uuid, metadata}}}});
  const prisoner = {uuid: "Actor.prisoner", id: "prisoner", effects: [effect("trapped", {endsWhen: "sourceDies"}), effect("lasting", {})],
    async deleteEmbeddedDocuments(type, ids) { deleted.push({type, ids, mirrorStanding: scene.regions.includes(mirror)}); }};
  // The runtime's wiring: the dying adapter's endWithSource port is the areas adapter's.
  const dying = createFoundryDying({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, combats: [], actors: [prisoner], scenes: []},
    coordinator: {}, resolveAction: async () => ({ok: false}), fromUuid: uuid => (uuid === sourceActor.uuid ? sourceActor : null),
    endWithSource: actor => areas.endWithSource(actor)});
  await dying.settleDeaths([sourceActor.uuid]);
  assert.deepEqual(scene.regions, [lasting], "its sourceDies area ended; its area without the key stays");
  assert.deepEqual(deleted, [{type: "ActiveEffect", ids: ["trapped"], mirrorStanding: false}],
    "its sourceDies effect is deleted after its area is gone; its other effect stays");
});

/*
 * Mirror of Life Trapping as data (wave D B6): the converter's SRD Actions (wave D MI1), free Actions its GM uses from the
 * mirror's own object Token, as for a trap (its user's Magic action by hand). Its trap asks the save only of a creature
 * that sees it (Q92 (e)) and is not a Construct (Q126 (b) not built).
 */
const mirrorDefinition = prefix => JSON.parse(readFileSync(`packs/_source/srd-items/${
  readdirSync("packs/_source/srd-items").find(file => file.startsWith(prefix))}`, "utf8")).system.definition;
const MIRROR_ACTIVATE = mirrorDefinition("mirror-of-life-trapping-activate-");
const MIRROR_FREE = mirrorDefinition("mirror-of-life-trapping-free-trapped-creature-");

/**
 * The lasting area fixture's caster as the mirror at (0,0), the target 15 feet away at (3,0) and the far creature at
 * (5,0), every save failing. Each creature's statuses come from its effects, and a change to its effects runs the
 * removed adapter as Foundry's effect hooks do (not awaited); its Tokens move, hide and are marked a server trip later,
 * the movement authority fixing a move's area entries as it approves it (`entered`).
 */
function mirrorFixture(t) {
  const rolls = [];
  const provider = createTestRollProvider({result: {natural: 2, total: 2}});
  const execute = provider.execute;
  provider.execute = request => { rolls.push(request); return execute.call(provider, request); };
  const fixture = lastingAreaFixture(t, {rollProviders: [provider]});
  const {scene, game, areas, sourceActor, sourceToken, targetActor, targetToken, far, farToken, action} = fixture;
  action.system.definition = MIRROR_ACTIVATE;
  const free = actionItem(MIRROR_FREE, sourceActor);
  free.uuid = `${sourceActor.uuid}.Item.${free.id}`;
  const resolveFirst = globalThis.fromUuid;
  globalThis.fromUuid = async ref => (ref === free.uuid ? free : resolveFirst(ref));
  const {grid} = scene;
  Object.assign(grid, {getTopLeftPoint: offset => ({x: offset.i * grid.sizeX, y: offset.j * grid.sizeY}),
    measurePath: ([a, b]) => ({distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / grid.sizeX * grid.distance})});
  scene.dimensions.sceneRect = {contains: (x, y) => (x >= 0) && (y >= 0) && (x < 1000) && (y < 1000)};
  sourceActor.documentName = "Actor";
  // A Foundry Collection iterates its documents, as the fixture's Scenes already do.
  game.actors[Symbol.iterator] = function* () { yield* this.values(); };
  const removed = createFoundryRemoved({game, fromUuidSync: ref => [sourceActor, targetActor, far].find(actor => actor.uuid === ref) ?? null});
  const hooks = [];
  const entered = [];
  for ( const [token, field] of [[sourceToken, 0], [targetToken, 3], [farToken, 5]] ) {
    Object.assign(token, {x: field * grid.sizeX, y: 0, hidden: false, flags: {},
      getCenterPoint(position) { return {x: (position?.x ?? this.x) + (grid.sizeX / 2), y: (position?.y ?? this.y) + (grid.sizeY / 2)}; },
      getOccupiedGridSpaceOffsets(position) { return [grid.getOffset({x: (position?.x ?? this.x) + 1, y: (position?.y ?? this.y) + 1})]; },
      async update(data, operation) {
        if ( operation?.movement ) entered.push(...areas.entered(this, {previous: {x: this.x, y: this.y}, position: {x: data.x, y: data.y}}));
        await new Promise(resolve => setTimeout(resolve));
        for ( const [path, value] of Object.entries(data) ) {
          if ( path === "flags.wildpath.removed" ) this.flags = {...this.flags, wildpath: {...this.flags.wildpath, removed: value}};
          else this[path] = value;
        }
      }});
    const actor = token.actor;
    let effects = [...(actor.effects ?? [])];
    Object.defineProperties(actor, {
      statuses: {configurable: true, get: () => new Set(effects.flatMap(effect => [...(effect.statuses ?? [])]))},
      effects: {configurable: true, get: () => effects, set(next) {
        const before = effects;
        effects = [...next];
        for ( const effect of [...before.filter(entry => !effects.includes(entry)), ...effects.filter(entry => !before.includes(entry))] ) {
          hooks.push(removed.onEffectChanged(effect));
        }
      }}});
    actor.deleteEmbeddedDocuments = async (type, ids) => { actor.effects = effects.filter(effect => !ids.includes(effect.id)); };
  }
  const trapped = actor => [...actor.effects].filter(effect => effect.statuses?.includes?.("trapped") || effect.statuses?.has?.("trapped"));
  const settled = () => Promise.all(hooks.splice(0));
  const startTurn = async (token, turn) => {
    game.combat.turn = turn;
    await areas.onTurn("turn.started", {combatant: {token}});
    await settled();
  };
  const activate = async () => {
    const declared = await fixture.player.declareActionIntent({...fixture.intent, area: {points: []}});
    assert.equal(declared.ok, true, JSON.stringify(declared));
    await settled();
  };
  return {...fixture, free, removed, entered, rolls, trapped, settled, startTurn, activate};
}

test("Mirror of Life Trapping (converted): a creature that sees it within 30 feet and fails its save is trapped and removed from the scene; a Blinded one and a Construct are not asked", async t => {
  assert.equal(validateActionDefinition(MIRROR_ACTIVATE).ok, true, JSON.stringify(validateActionDefinition(MIRROR_ACTIVATE).errors));
  assert.equal(validateActionDefinition(MIRROR_FREE).ok, true, JSON.stringify(validateActionDefinition(MIRROR_FREE).errors));
  const {scene, game, areas, sourceActor, targetActor, targetToken, far, farToken, rolls, trapped, settled, startTurn, activate} = mirrorFixture(t);
  far.system.details = {type: "construct"};
  await activate();
  const [region] = scene.regions;
  assert.deepEqual([region.attachment.token, region.flags.wildpath.area.persistence.endsWhen], ["source-token", "sourceDies"]);
  assert.deepEqual([trapped(targetActor), trapped(far)], [[], []], "appearing around a creature asks no save; entering or a turn start does");

  targetActor.effects = [{id: "blind", statuses: new Set(["blinded"]), flags: {}}];
  await startTurn(targetToken, 1);
  assert.deepEqual(trapped(targetActor), [], "a Blinded creature sees no reflection");
  targetActor.effects = [];
  await areas.apply(region, region.flags.wildpath.area, targetToken, "area.entered");
  await settled();
  const [cell] = trapped(targetActor);
  assert.deepEqual([cell?.flags.wildpath.conditionEffect.metadata.returns, cell?.flags.wildpath.conditionEffect.metadata.endsWhen],
    ["source", "sourceDies"], "seeing it in the same turn (being left out spent nothing), it fails the Charisma save and is trapped");
  assert.equal(conditionsFrom(targetActor, sourceActor, game).trapped, true, "by the mirror");
  assert.deepEqual([targetToken.hidden, targetToken.flags.wildpath.removed], [true, {hidden: false}], "its Token is hidden");

  await startTurn(farToken, 2);
  assert.deepEqual(trapped(far), [], "a Construct is not asked");
  const asked = rolls.length;
  assert.ok(asked > 0, "the trapped creature's save was rolled");
  game.combat.turn = 3;
  const spent = structuredClone(region.flags.wildpath.area.applied);
  // Live round 10: the run went ahead and the authority, leaving out a creature on another plane, asked the GM for targets.
  assert.deepEqual(await areas.onTurn("turn.started", {combatant: {token: targetToken}}), [], "a prisoner's turn start in the area runs nothing");
  await settled();
  assert.deepEqual(region.flags.wildpath.area.applied, spent, "nor spends its once per turn there");
  assert.equal(trapped(targetActor).length, 1, "a prisoner's turn start in the area traps it no further");
  assert.equal(rolls.length, asked, "and asks it no save");
});

test("Mirror of Life Trapping (converted): Free from the mirror brings its prisoner back beside it, saved against only at its next turn start (Q135)", async t => {
  const {scene, gm, sourceActor, sourceToken, targetActor, targetToken, free, entered, trapped, settled, startTurn, activate} = mirrorFixture(t);
  await activate();
  await startTurn(targetToken, 1);
  assert.equal(trapped(targetActor).length, 1, "caught as its turn starts in sight of the mirror");
  // The mirror carried 60 feet away: where it was caught is outside the area now, so reappearing beside it is a step in.
  sourceToken.x = 600;
  const area = scene.regions[0].flags.wildpath.area;
  assert.equal(areaCovers(area, targetToken), false, "its hidden Token stands outside the area");
  const intent = buildFoundryActionUseIntent({actor: sourceActor, action: free, game: {user: {targets: new Set([{document: targetToken}])}}});
  const declared = await gm.declareActionIntent(intent.intent);
  assert.equal(declared.ok, true, JSON.stringify(declared));
  await settled();
  assert.deepEqual(trapped(targetActor), [], "freed");
  assert.deepEqual([Math.abs(targetToken.x - 600) <= 50, targetToken.y <= 50, targetToken.hidden, targetToken.flags.wildpath.removed],
    [true, true, false, null], "beside the mirror, shown again");
  assert.equal(areaCovers(area, targetToken), true, "in the mirror's area");
  assert.deepEqual(entered, [], "reappearing in the mirror's area enters it as no walk in does: no save");
  await startTurn(targetToken, 2);
  assert.equal(trapped(targetActor).length, 1, "its next turn start in sight of the mirror: saved against again");
  assert.equal(scene.regions.length, 1, "the mirror stays active");
});

test("Mirror of Life Trapping (converted): the mirror shattering ends its area and frees every prisoner, each beside it in its own space", async t => {
  const {scene, game, sourceActor, targetActor, targetToken, far, farToken, areas, trapped, settled, startTurn, activate} = mirrorFixture(t);
  await activate();
  await startTurn(targetToken, 1);
  await startTurn(farToken, 2);
  assert.deepEqual([trapped(targetActor).length, trapped(far).length, targetToken.hidden, farToken.hidden], [1, 1, true, true]);
  const dying = createFoundryDying({game, coordinator: {}, resolveAction: async () => ({ok: false}),
    fromUuid: uuid => (uuid === sourceActor.uuid ? sourceActor : null), endWithSource: actor => areas.endWithSource(actor)});
  // Its object Token's 10 Hit Points gone: the Action that killed it settles its death (settleDeaths).
  await dying.settleDeaths([sourceActor.uuid]);
  await settled();
  assert.deepEqual(scene.regions, [], "its area ended with it");
  assert.deepEqual([trapped(targetActor), trapped(far)], [[], []], "every prisoner freed");
  assert.deepEqual([[targetToken.x, targetToken.y, targetToken.hidden], [farToken.x, farToken.y, farToken.hidden]],
    [[50, 0, false], [50, 50, false]], "each beside the mirror, the second beside the first rather than on it");
});

test("an emanation is attached to its caster and covers whoever is next to the caster now", async t => {
  const {scene, sourceToken, targetActor, targetToken, player, areas, intent} = lastingAreaFixture(t, {shape: "emanation"});
  const declared = await player.declareActionIntent({...intent, area: {points: []}});
  assert.equal(declared.ok, true, JSON.stringify(declared));
  assert.equal(targetActor.system.resources.health.value, 24, "the emanation's own hit lands on the adjacent target");
  const [region] = scene.regions;
  assert.deepEqual([region.attachment.token, region.flags.wildpath.area.attached], ["source-token", true]);
  await areas.onTurn("turn.started", {combatant: {token: targetToken}});
  assert.equal(targetActor.system.resources.health.value, 20, "starting a turn next to the caster burns");
  // The caster walks away: the aura goes with it and no longer covers the target.
  sourceToken.getOccupiedGridSpaceOffsets = () => [{i: 6, j: 0}];
  scene.regions[0].flags.wildpath.area.applied = {};
  await areas.onTurn("turn.started", {combatant: {token: targetToken}});
  assert.equal(targetActor.system.resources.health.value, 20);
});

test("an area that catches nobody still happens and leaves its lasting area", async t => {
  const {scene, targetActor, player, gm, intent} = lastingAreaFixture(t);
  // Field (8,8) is in range (40 ft) and empty.
  const declared = await player.declareActionIntent({...intent, area: {points: [{x: 425, y: 425}]}});
  assert.equal(declared.ok, true, JSON.stringify(declared));
  const state = gm.getRecord(declared.resolutionId).state;
  assert.equal(state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(state.errors));
  assert.equal(scene.regions.length, 1);
  assert.equal(targetActor.system.resources.health.value, 30);
});

test("a creature that steps out of a lasting area exits it, and only an area answering exits notices", async t => {
  const {scene, targetActor, targetToken, player, areas, intent} = lastingAreaFixture(t, {on: ["area.exited"]});
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  const [region] = scene.regions;
  targetToken.getOccupiedGridSpaceOffsets = position => [position ? scene.grid.getOffset(position) : {i: 1, j: 0}];
  const inside = {x: 50, y: 0};
  const outside = {x: 500, y: 0};
  assert.deepEqual(areas.exited(targetToken, {previous: inside, position: outside}).map(entry => entry.region.id), [region.id]);
  assert.deepEqual(areas.exited(targetToken, {previous: outside, position: inside}), [], "walking in is not leaving");
  assert.deepEqual(areas.entered(targetToken, {previous: outside, position: inside}), [], "an exit-only area ignores entries");
  await areas.apply(region, region.flags.wildpath.area, targetToken, "area.exited");
  assert.equal(targetActor.system.resources.health.value, 20, "leaving it burns (after the cast's own 6)");
});

test("a Token removed from the scene (flags.wildpath.removed) enters and moves in no lasting area, but still leaves one", async t => {
  const {scene, targetToken, player, areas, intent} = lastingAreaFixture(t, {on: ["area.entered", "area.exited"]});
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  const [region] = scene.regions;
  targetToken.getOccupiedGridSpaceOffsets = position => [position ? scene.grid.getOffset(position) : {i: 1, j: 0}];
  const into = {previous: {x: 500, y: 0}, position: {x: 50, y: 0}};
  const out = {previous: {x: 50, y: 0}, position: {x: 500, y: 0}};
  const ids = entries => entries.map(entry => entry.region.id);
  assert.deepEqual(ids(areas.entered(targetToken, into)), [region.id], "unmarked, it enters");
  // Hand-set as the removed adapter leaves it while the release places the Token.
  targetToken.flags = {...targetToken.flags, wildpath: {...targetToken.flags?.wildpath, removed: {hidden: false}}};
  assert.deepEqual(areas.entered(targetToken, into), [], "marked, it enters nothing: reappearing calls for no save");
  assert.deepEqual(ids(areas.exited(targetToken, out)), [region.id], "marked, it still leaves, releasing what it held there");
});

test("a Token removed from the scene moves in no area answering moving in it", async t => {
  const {region, feet, targetToken} = await thornsFixture(t);
  assert.deepEqual(feet(2, 5), [[region.id, 15]]);
  targetToken.flags = {...targetToken.flags, wildpath: {...targetToken.flags?.wildpath, removed: {hidden: true}}};
  assert.deepEqual(feet(2, 5), [], "marked, no feet are counted");
});

/** A strip of thorns over fields 2 to 6 of row 0 that hurt 2d4 for every 5 feet moved in it (Spike Growth's shape). */
async function thornsFixture(t, options={}) {
  const fixture = lastingAreaFixture(t, options);
  const {scene, areas, sourceToken, targetToken} = fixture;
  const thorns = {schemaVersion: 1, id: "action:thorns:lasting", label: "Thorns", costs: {allOf: []},
    damage: options.damage ?? [{id: "damage-1", expression: {type: "dice", number: 2, faces: 4}, damageType: "piercing"}]};
  const region = await areas.create({options: {persistentArea: {footprint: {topology: "square",
    fields: [2, 3, 4, 5, 6].map(x => ({x, y: 0}))}, definition: {id: "action:thorns", label: "Thorns", area: {shape: "radial",
    size: {value: 5, unit: "ft"}, persistence: {duration: {unit: "round", value: 10}, difficultTerrain: {types: []},
      triggers: [{on: ["area.moved"], per: 5, action: thorns}]}}}, sourceTokenId: sourceToken.id, sceneId: scene.id}},
  state: {configuration: {}}});
  targetToken.getOccupiedGridSpaceOffsets = position => [position ? scene.grid.getOffset(position) : {i: 1, j: 0}];
  const at = field => ({x: field * 50, y: 0});
  const feet = (from, to) => areas.moved(targetToken, {previous: at(from), position: at(to)}).map(entry => [entry.region.id, entry.feet]);
  return {...fixture, region, flag: region.flags.wildpath.area, feet};
}

test("moving in a lasting area counts the feet moved inside it on that step, and nothing outside it", async t => {
  const {region, flag, feet, areas, scene} = await thornsFixture(t);
  assert.equal(areas.hasCrossingAreas(scene), true, "moves on its Scene are checkpointed per step");
  assert.deepEqual(feet(2, 5), [[region.id, 15]], "three spaces inside: 15 feet");
  assert.deepEqual(feet(0, 3), [[region.id, 10]], "in from outside: only the two spaces inside count");
  assert.deepEqual(feet(0, 1), [], "outside it: nothing");
  assert.deepEqual(feet(6, 7), [], "a step out of it ends outside: nothing");
  assert.deepEqual(flag.difficultTerrain, {types: []});
  assert.deepEqual(feet(3, 4), [[region.id, 5]], "Difficult Terrain costs double but is 5 feet moved, as one step");
  assert.deepEqual(areas.entered(scene.tokens.get("target-token"), {previous: {x: 0, y: 0}, position: {x: 150, y: 0}}), [],
    "it answers no entering of its own");
});

test("moving 15 feet in a lasting area deals its damage three times over in one resolution, with physical dice", async t => {
  const seen = [];
  const physical = createPhysicalDiceProvider();
  const recording = {...physical, execute(request, context) { seen.push(request); return physical.execute.call(this, request, context); }};
  const {region, flag, targetActor, targetToken, areas, game} = await thornsFixture(t, {rollProviders: [recording],
    rollContext: {physicalRolls: [{total: 7}]}});
  const health = targetActor.system.resources.health.value;
  assert.ok(game.combat, "in combat, where once per turn would otherwise apply");
  const results = await areas.apply(region, flag, targetToken, "area.moved", {feet: 15});
  assert.equal(results.length, 1, "one resolution for the step");
  assert.deepEqual(seen.map(request => rollFormulaForRequest(request).formula), ["6d4"], "2d4 for each of the three 5 feet");
  assert.equal(targetActor.system.resources.health.value, health - 7, "the table's physical dice are the damage");
  assert.equal(flag.applied[targetToken.id], undefined, "it spends no once per turn");
  // The one supplied total (7) is possible on both 6d4 and 2d4, so neither roll is rejected and asked again.
  await areas.apply(region, flag, targetToken, "area.moved", {feet: 5});
  assert.equal(seen.length, 2, "the next step in the same turn hurts again");
  assert.equal(targetActor.system.resources.health.value, health - 14);
  assert.deepEqual(await areas.apply(region, flag, targetToken, "area.moved", {feet: 0}), [], "no distance inside: nothing");
  assert.deepEqual(await areas.apply(region, flag, targetToken, "area.moved", {feet: 4}), [], "less than 5 feet: nothing");
  assert.equal(seen.length, 2);
});

test("damage for each 5 feet moved repeats any spelling of its damage: plain dice merge, counted or bonused by an expression add copies", async t => {
  const byLevel = {type: "context", path: "castLevel"};
  const bonused = {type: "dice", number: 1, faces: 6, bonus: {type: "constant", value: 1}};
  const {region, flag, targetToken, areas} = await thornsFixture(t, {rollProviders: [createPhysicalDiceProvider()],
    rollContext: {physicalRolls: [{total: 13}]},
    damage: [{id: "damage-1", dice: {count: 2, faces: 4}, damageType: "piercing"},
      {id: "damage-2", valueExpression: bonused, damageType: "fire"},
      {id: "damage-3", expression: {type: "dice", number: byLevel, faces: 4}, damageType: "cold"},
      {id: "damage-4", amount: 2, damageType: "acid"}]});
  const [state] = await areas.apply(region, flag, targetToken, "area.moved", {feet: 15});
  const thrice = expression => ({type: "add", terms: [expression, expression, expression]});
  assert.deepEqual(state.actionDefinition.damage.map(part => part.expression), [
    {type: "dice", count: 2, faces: 4, number: 6},
    thrice(bonused),
    thrice({type: "dice", number: byLevel, faces: 4}),
    thrice({type: "constant", value: 2})]);
});

test("a hold its area gives only while in it (Web's Restrained: endsWhen leavesArea) ends on leaving, or with the area", async t => {
  const {scene, targetActor, targetToken, player, areas, intent} = lastingAreaFixture(t, {on: ["area.entered"]});
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  const [region] = scene.regions;
  const flag = region.flags.wildpath.area;
  flag.persistence.triggers = [{on: ["area.entered"], action: {schemaVersion: 1, id: "action:webs", label: "Webs", costs: {allOf: []},
    effects: [{id: "stuck", type: "condition", conditionId: "restrained", metadata: {endsWhen: "leavesArea"}}]}}];
  targetToken.getOccupiedGridSpaceOffsets = position => [position ? scene.grid.getOffset(position) : {i: 1, j: 0}];
  const step = {previous: {x: 50, y: 0}, position: {x: 500, y: 0}};
  assert.deepEqual(areas.exited(targetToken, step).map(entry => entry.region.id), [region.id],
    "an area whose hold ends on leaving notices exits without a trigger of its own");
  const held = () => [...targetActor.effects].filter(effect => effect.system?.type === "restrained");
  targetActor.deleteEmbeddedDocuments = async (type, ids) => {
    assert.equal(type, "ActiveEffect");
    targetActor.effects = [...targetActor.effects].filter(effect => !ids.includes(effect.id));
  };
  await areas.apply(region, flag, targetToken, "area.entered");
  assert.deepEqual(held().map(effect => effect.flags?.wildpath?.conditionEffect?.metadata?.regionId), [region.id],
    "the hold names the Region it came from");
  await areas.apply(region, flag, targetToken, "area.exited");
  assert.deepEqual(held(), [], "leaving the webs ends it");

  // The webs moved off it (the GM drags the Region) end it as leaving them does.
  flag.applied = {};
  await areas.apply(region, flag, targetToken, "area.entered");
  assert.equal(held().length, 1);
  const fields = flag.fields;
  await areas.move({options: {areaMove: {sceneId: scene.id, regionId: region.id, fields: [{x: 9, y: 9}]}}});
  assert.deepEqual(held(), [], "the area moved off it ends it");
  await areas.move({options: {areaMove: {sceneId: scene.id, regionId: region.id, fields}}});

  // The area ending ends it too, on whoever it still holds.
  flag.applied = {};
  await areas.apply(region, flag, targetToken, "area.entered");
  assert.equal(held().length, 1);
  await areas.onRegionDeleted(region);
  assert.deepEqual(held(), []);

  // A Restrained it already has from elsewhere (a Net: another Action and source) is its own instance (Q19): the webs'
  // is stamped beside it, and leaving the webs ends only theirs.
  targetActor.effects = [...targetActor.effects, {id: "net", type: "condition", name: "Restrained", statuses: new Set(["restrained"]),
    system: {type: "restrained"}, flags: {wildpath: {conditionEffect: {conditionId: "restrained", sourceRef: "uuid:Actor.hunter",
      metadata: {actionDefinitionId: "action:net", escapeDC: 10}}}}}];
  flag.applied = {};
  await areas.apply(region, flag, targetToken, "area.entered");
  assert.deepEqual(held().map(effect => effect.flags?.wildpath?.conditionEffect?.metadata?.regionId ?? null), [null, region.id],
    "the webs' Restrained beside the Net's, naming the Region");
  await areas.apply(region, flag, targetToken, "area.exited");
  assert.deepEqual(held().map(effect => effect.id), ["net"], "the Net still holds it");
});

test("a custom effect its area gives only while in it (Spirit Guardians' Half Speed) is on it while it is in the area, beside other effects", async t => {
  const halved = {id: "effect-1", type: "effect", name: "Half Speed", ruleElements: [{schemaVersion: 1, id: "half-speed-1", type: "Modifier",
    data: {domains: ["speed.multiplier"], modifierType: "untyped", value: 0.5}}], duration: {value: 600, units: "seconds", expiry: "turnStart"},
    metadata: {endsWhen: "leavesArea"}};
  const {scene, targetActor, targetToken, player, areas, intent} = lastingAreaFixture(t, {on: ["area.entered"],
    action: {...BURNING, id: "action:guardians:lasting", effects: [halved]}});
  // An unrelated custom effect it already has (another spell's, unstamped, no condition type) is not this one held elsewhere.
  targetActor.effects = [...targetActor.effects, {id: "blessed", name: "Blessed", statuses: new Set(["action:bless:effect-1"]), system: {},
    flags: {wildpath: {conditionEffect: {metadata: {}}}}}];
  targetActor.deleteEmbeddedDocuments = async (type, ids) => {
    assert.equal(type, "ActiveEffect");
    targetActor.effects = [...targetActor.effects].filter(effect => !ids.includes(effect.id));
  };
  const slowed = () => [...targetActor.effects].filter(effect => effect.name === "Half Speed");
  const health = () => targetActor.system.resources.health.value;
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  const [region] = scene.regions;
  const flag = region.flags.wildpath.area;
  assert.deepEqual(slowed().map(effect => effect.flags?.wildpath?.conditionEffect?.metadata?.regionId), [region.id],
    "the area appearing around it gives it Half Speed, naming the Region");
  assert.equal(health(), 24, "only the cast's burst: appearing repeats none of the area's damage");
  await areas.apply(region, flag, targetToken, "area.exited");
  assert.deepEqual(slowed(), [], "leaving the Emanation ends it");
  await areas.apply(region, flag, targetToken, "area.entered");
  assert.deepEqual([slowed().length, health()], [1, 20]);
  await areas.apply(region, flag, targetToken, "area.exited");
  await areas.apply(region, flag, targetToken, "area.entered");
  assert.deepEqual([slowed().length, health()], [1, 20], "back in on the same turn: slowed again, but no second damage");
  await areas.onRegionDeleted(region);
  assert.deepEqual(slowed(), [], "the Emanation ending (its caster's concentration moved on) ends it");
  assert.deepEqual([...targetActor.effects].map(effect => effect.id), ["blessed"], "the other spell's effect stays");
});

/** A lasting area's trigger that only holds a custom effect on whoever is in it (an Antimagic Field's, by hand). */
const FIELD = {schemaVersion: 1, id: "action:field:lasting", label: "Field", costs: {allOf: []}, effects: [{id: "effect-1", type: "effect",
  name: "In the Field", ruleElements: [{schemaVersion: 1, id: "field-1", type: "Modifier", data: {domains: ["speed.multiplier"],
    modifierType: "untyped", value: 0.5}}], metadata: {endsWhen: "leavesArea"}}]};

test("an emanation that includesAnchor covers its own Token from the cast on and through its steps (Antimagic Field, Q138 (a))", async t => {
  for ( const includesAnchor of [true, false] ) {
    const {scene, sourceActor, sourceToken, targetActor, player, areas, intent} = lastingAreaFixture(t, {shape: "emanation",
      on: ["area.entered"], action: FIELD, persistence: {includesAnchor}});
    await player.declareActionIntent({...intent, area: {points: []}});
    const [region] = scene.regions;
    const flag = region.flags.wildpath.area;
    const fielded = actor => [...actor.effects].filter(effect => effect.name === "In the Field")
      .map(effect => effect.flags?.wildpath?.conditionEffect?.metadata?.regionId);
    assert.deepEqual([flag.persistence.includesAnchor, areaCovers(flag, sourceToken), fielded(sourceActor), fielded(targetActor)],
      includesAnchor ? [true, true, [region.id], [region.id]] : [undefined, false, [], [region.id]],
      `includesAnchor ${includesAnchor}: the caster is inside its own field, held by it as it appears, as the creature beside it is`);
    sourceToken.getOccupiedGridSpaceOffsets = position => [position ? scene.grid.getOffset(position) : {i: 0, j: 0}];
    const step = {previous: {x: 0, y: 0}, position: {x: 500, y: 0}};
    assert.deepEqual([areas.exited(sourceToken, step), areas.entered(sourceToken, {previous: step.position, position: step.previous})],
      [[], []], "a long step neither leaves nor enters the field it carries");
    flag.persistence.triggers.push({on: ["area.moved"], action: BURNING});
    assert.deepEqual(areas.moved(sourceToken, step), [], "nor moves in it");
  }
});

test("overlapping areas holding one custom effect hand it over: entering the second keeps the first's, leaving or ending the first hands it on", async t => {
  const {scene, sourceToken, targetActor, targetToken, player, areas, intent} = lastingAreaFixture(t, {on: ["area.entered"], action: FIELD});
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  const [first] = scene.regions;
  const [second] = await scene.createEmbeddedDocuments("Region", [{name: first.name, shapes: first.shapes,
    flags: {wildpath: {area: {...structuredClone(first.flags.wildpath.area), applied: {}}}}}]);
  const writes = [];
  targetActor.deleteEmbeddedDocuments = async (type, ids) => {
    writes.push(["delete", ids]);
    targetActor.effects = [...targetActor.effects].filter(effect => !ids.includes(effect.id));
  };
  targetActor.updateEmbeddedDocuments = async (type, updates) => {
    assert.equal(type, "ActiveEffect");
    writes.push(["update", updates.map(update => update._id)]);
    for ( const update of updates ) {
      [...targetActor.effects].find(effect => effect.id === update._id).flags.wildpath.conditionEffect.metadata.regionId
        = update["flags.wildpath.conditionEffect.metadata.regionId"];
    }
  };
  const fielded = () => [...targetActor.effects].filter(effect => effect.name === "In the Field")
    .map(effect => [effect.id, effect.flags?.wildpath?.conditionEffect?.metadata?.regionId]);
  const [[id]] = fielded();
  assert.deepEqual(fielded(), [[id, first.id]], "the first field appearing around it gives it the effect");
  assert.equal((await areas.apply(second, second.flags.wildpath.area, targetToken, "area.entered")).length, 1,
    "entering the second still acts (refreshing it), so it stops a mover as entering any area does (Q139 (b) default)");
  assert.deepEqual(fielded(), [[id, first.id]], "the first keeps its stamp");
  await areas.apply(first, first.flags.wildpath.area, targetToken, "area.exited");
  assert.deepEqual([fielded(), writes], [[[id, second.id]], [["update", [id]]]], "leaving the first hands it to the second: one update");
  const away = {x: 500, y: 0};
  targetToken.getOccupiedGridSpaceOffsets = position => [position ? scene.grid.getOffset(position) : {i: 1, j: 0}];
  await areas.apply(first, first.flags.wildpath.area, targetToken, "area.entered");
  await areas.apply(second, second.flags.wildpath.area, targetToken, "area.exited", {position: away});
  assert.deepEqual(fielded(), [], "a step that left both (judged where it ended, not where the Token stands now) removes it");
  writes.length = 0;
  first.flags.wildpath.area.applied = {};
  await areas.apply(first, first.flags.wildpath.area, targetToken, "area.entered");
  await areas.onRegionDeleted(first);
  assert.deepEqual([fielded().map(([, regionId]) => regionId), writes], [[second.id], [["update", [fielded()[0][0]]]]],
    "the first ending hands it on too");
  await areas.apply(second, second.flags.wildpath.area, targetToken, "area.exited", {position: away});
  assert.deepEqual(fielded(), [], "leaving the last removes it");
  // An area that spares the creature (its caster's side, affects: "enemies") takes nothing over.
  second.flags.wildpath.area.persistence.affects = "enemies";
  targetToken.disposition = sourceToken.disposition;
  first.flags.wildpath.area.applied = {};
  await areas.apply(first, first.flags.wildpath.area, targetToken, "area.entered");
  await areas.apply(first, first.flags.wildpath.area, targetToken, "area.exited");
  assert.deepEqual(fielded(), [], "spared by the second, it loses the effect with the first");
  // A removed Token (it enters no area) or a dead creature (passed by) is not handed over either.
  second.flags.wildpath.area.persistence.affects = null;
  for ( const [removed, statuses] of [[true, []], [false, ["dead"]]] ) {
    targetToken.flags = {wildpath: removed ? {removed: {}} : {}};
    first.flags.wildpath.area.applied = {};
    await areas.apply(first, first.flags.wildpath.area, targetToken, "area.entered");
    assert.equal(fielded().length, 1, "the first gives it while the creature can still enter");
    targetActor.statuses = new Set(statuses);
    await areas.apply(first, first.flags.wildpath.area, targetToken, "area.exited");
    assert.deepEqual(fielded(), [], removed ? "a removed Token loses it with the first" : "so does a dead creature");
    targetActor.statuses = new Set();
  }
});

/** Antimagic Field's second trigger, hand-written (wave D B12): creatures summoned by ongoing spells wink out while inside. */
const WINKED_OUT_RULES = [{schemaVersion: 1, id: "winked-out.unaffected", type: "Unaffected", data: {actions: {}}},
  {schemaVersion: 1, id: "winked-out.sealed", type: "Forbid", data: {actions: {}}},
  {schemaVersion: 1, id: "winked-out.still", type: "ResourceCap", data: {resources: ["movement"], maximum: 0}}];
const WINKED_OUT = {schemaVersion: 1, id: "action:field:lasting-summons", label: "Field", costs: {allOf: []},
  targeting: {eligible: {atLeast: {path: "summon.castLevel", value: 0}}},
  effects: [{id: "effect-1", type: "effect", name: "Winked Out", metadata: {endsWhen: "leavesArea"}, ruleElements: WINKED_OUT_RULES}]};

test("a lasting area's trigger for creatures ongoing spells summoned (summon.castLevel, wave D B12): Winked Out while inside, a Simulacrum's copy too, never a familiar", async t => {
  assert.deepEqual(validateActionDefinition({schemaVersion: 1, id: "action:field", label: "Field", costs: {allOf: []},
    targeting: {type: "area"}, area: {shape: "emanation", size: {value: 10, unit: "ft"},
      persistence: {triggers: [{on: ["area.entered"], action: WINKED_OUT}]}}}).errors, []);
  const {scene, targetActor, targetToken, player, areas, intent} = lastingAreaFixture(t, {on: ["area.entered"], action: WINKED_OUT});
  targetActor.deleteEmbeddedDocuments = async (type, ids) => {
    targetActor.effects = [...targetActor.effects].filter(effect => !ids.includes(effect.id));
  };
  const winked = () => [...targetActor.effects].filter(effect => effect.name === "Winked Out");
  // Its Token's summon flag, as the summons adapter writes it: a level only when Dispel Magic could end it.
  const summoned = extra => { targetToken.flags = {wildpath: {summon: {casterUuid: "Actor.wizard", kind: "summon", ...extra}}}; };
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  assert.deepEqual(winked(), [], "a creature no spell summoned stays itself as the field appears around it");
  const [region] = scene.regions;
  const flag = region.flags.wildpath.area;
  const enter = async extra => { summoned(extra); await areas.apply(region, flag, targetToken, "area.entered"); return winked().length; };
  assert.equal(await enter({}), 0, "an instantaneous spell's creature (Find Familiar) has no cast level");
  assert.equal(await enter({castLevel: 3}), 1, "a conjured creature winks out");
  assert.deepEqual(winked()[0].flags.wildpath.conditionEffect.metadata.regionId, region.id, "held by the field");
  await areas.apply(region, flag, targetToken, "area.exited");
  assert.equal(winked().length, 0, "back when it leaves");
  assert.equal(await enter({castLevel: 0}), 1, "a lasting cantrip's (Mage Hand) at level 0");
  await areas.apply(region, flag, targetToken, "area.exited");
  // The Simulacrum cross-check (plan S7): a dispellable copy keeps its cast level, so it winks out as the 2024 text says.
  assert.equal(await enter({castLevel: 7, of: "Actor.simulacrum"}), 1, "a Simulacrum's copy winks out");
});

test("two overlapping fields: the first ending hands its Winked Out and its other held effect to the second, not barred by Winked Out's own Unaffected", async t => {
  const {scene, targetActor, targetToken, player, areas, intent} = lastingAreaFixture(t, {on: ["area.entered"], action: WINKED_OUT});
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  const [first] = scene.regions;
  // Antimagic Field's two triggers: its held effect (here FIELD's), then Winked Out for a conjured creature.
  first.flags.wildpath.area.persistence.triggers.unshift({on: ["area.entered"], action: FIELD});
  first.flags.wildpath.area.applied = {};
  targetActor.effects = [];
  targetToken.flags = {wildpath: {summon: {casterUuid: "Actor.wizard", kind: "summon", castLevel: 3}}};
  await areas.apply(first, first.flags.wildpath.area, targetToken, "area.entered");
  const [second] = await scene.createEmbeddedDocuments("Region", [{name: first.name, shapes: first.shapes,
    flags: {wildpath: {area: {...structuredClone(first.flags.wildpath.area), applied: {}}}}}]);
  const writes = [];
  targetActor.deleteEmbeddedDocuments = async (type, ids) => {
    writes.push(["delete", ids]);
    targetActor.effects = [...targetActor.effects].filter(effect => !ids.includes(effect.id));
  };
  targetActor.updateEmbeddedDocuments = async (type, updates) => {
    writes.push(["update", updates.map(update => update._id)]);
    for ( const update of updates ) {
      [...targetActor.effects].find(effect => effect.id === update._id).flags.wildpath.conditionEffect.metadata.regionId
        = update["flags.wildpath.conditionEffect.metadata.regionId"];
    }
  };
  const held = () => [...targetActor.effects].filter(effect => ["Winked Out", "In the Field"].includes(effect.name))
    .map(effect => [effect.name, effect.flags.wildpath.conditionEffect.metadata.regionId]).sort();
  assert.deepEqual(held(), [["In the Field", first.id], ["Winked Out", first.id]]);
  assert.ok(targetActor.unaffectingRule(WINKED_OUT), "Winked Out leaves it untouched by the second field's trigger");
  await areas.apply(first, first.flags.wildpath.area, targetToken, "area.exited");
  assert.deepEqual(held(), [["In the Field", second.id], ["Winked Out", second.id]], "both handed to the second");
  assert.equal(writes.some(([kind]) => kind === "delete"), false, "nothing deleted");
});

test("an aura whose caster walks away exits the creatures it leaves behind", async t => {
  const {scene, sourceToken, targetToken, player, areas, intent} = lastingAreaFixture(t, {shape: "emanation", on: ["area.exited"]});
  await player.declareActionIntent({...intent, area: {points: []}});
  sourceToken.getOccupiedGridSpaceOffsets = position => [position ? scene.grid.getOffset(position) : {i: 0, j: 0}];
  const sweeps = areas.swept(sourceToken, {previous: {x: 0, y: 0}, position: {x: 500, y: 0}});
  assert.deepEqual(sweeps.map(({event, tokens}) => [event, tokens.map(token => token.id)]), [["area.exited", [targetToken.id]]]);
  assert.deepEqual(areas.swept(sourceToken, {previous: {x: 500, y: 0}, position: {x: 0, y: 0}}), [],
    "walking back covers the creature again, which an exit-only aura does not answer");
});

test("an aura enters no creature while it or its caster is removed from the scene (flags.wildpath.removed), but still exits", async t => {
  const {scene, sourceToken, targetToken, player, areas, intent} = lastingAreaFixture(t, {shape: "emanation",
    on: ["area.entered", "area.exited"]});
  await player.declareActionIntent({...intent, area: {points: []}});
  sourceToken.getOccupiedGridSpaceOffsets = position => [position ? scene.grid.getOffset(position) : {i: 0, j: 0}];
  const away = {previous: {x: 0, y: 0}, position: {x: 500, y: 0}};
  const back = {previous: {x: 500, y: 0}, position: {x: 0, y: 0}};
  const sweeps = step => areas.swept(sourceToken, step).map(({event, tokens}) => [event, tokens.map(token => token.id)]);
  assert.deepEqual(sweeps(back), [["area.entered", [targetToken.id]]], "unmarked, walking back enters it");
  const mark = token => { token.flags = {...token.flags, wildpath: {...token.flags?.wildpath, removed: {hidden: false}}}; };
  const unmark = token => { delete token.flags.wildpath.removed; };
  mark(targetToken);
  assert.deepEqual(sweeps(back), [], "a marked creature is not entered");
  assert.deepEqual(sweeps(away), [["area.exited", [targetToken.id]]], "a marked creature is still exited");
  unmark(targetToken);
  mark(sourceToken);
  assert.deepEqual(sweeps(back), [], "a marked caster's aura enters nobody");
  assert.deepEqual(sweeps(away), [["area.exited", [targetToken.id]]], "a marked caster's aura still exits");
});

/** A summoned creature's Token (a Flaming Sphere, a Guardian of Faith) beside the lasting area fixture's creatures. */
function summonedToken(fixture, id, offset, actionId="action:sphere") {
  const {scene, sourceActor} = fixture;
  const actor = withFoundryActorSystem(fakeActor(`${id}-model`, {system: targetActorSystem(10, 10)}));
  const token = fakeTokenDocument({id, actor, scene, offset});
  Object.assign(actor, {uuid: `${token.uuid}.Actor.${actor.id}`, isToken: true, token, tokens: [token]});
  token.flags = {wildpath: {summon: {casterUuid: sourceActor.uuid, kind: "summon", actionId}}};
  token.update = async data => { token.light = data.light; };
  scene.tokens.push(token);
  return token;
}

/** A summon Action whose creature carries a lasting area of BURNING, `damage` a time, on `on` (summon.area). */
const carrying = (damage, {on=["turn.ended"], size=5, persistence={}, targeting=null}={}) => ({schemaVersion: 1, id: "action:sphere", label: "Sphere",
  costs: {allOf: []}, summon: {actorRef: "Actor.sphere", count: 1, area: {shape: "emanation", size: {value: size, unit: "ft"},
    persistence: {...persistence, triggers: [{on, action: {...BURNING, damage: [{...BURNING.damage[0], expression: {type: "constant", value: damage}}],
      ...(targeting ? {targeting} : {})}}]}}}});

test("a summon's carried area: attached to its creature, drawn as it is worked out, its caster's, its slot's, never itself (summon.area)", async t => {
  const fixture = lastingAreaFixture(t);
  const {scene, sourceToken, targetActor, targetToken, far, farToken, areas, game} = fixture;
  const sphere = summonedToken(fixture, "sphere", {i: 2, j: 0});
  const light = {persistence: {light: {bright: 20, dim: 40}}};
  const spell = definition => ({...definition, metadata: {spellLevel: 2}});
  const event = {state: {source: {tokenId: sourceToken.id}, actionDefinition: spell(carrying(4, light)),
    configuration: {castingLevel: 3, effectiveDefinition: spell(carrying(6, light))}}};
  const [region] = await areas.carry(event, [sphere]);
  const flag = region.flags.wildpath.area;
  assert.deepEqual([region.attachment.token, flag.anchorTokenId, flag.sourceTokenId, flag.castLevel], ["sphere", "sphere", "source-token", 3],
    "it follows the sphere; it is its caster's; the slot it was cast with, so Dispel Magic can choose it (Q31)");
  assert.deepEqual(spellAreasWithin(sourceToken, 120).map(entry => entry.region), [region], "Dispel Magic lists it");
  assert.deepEqual(flag.fields, areaFields(flag, scene), "drawn where it is worked out");
  assert.equal(region.shapes[0].offsets.length, flag.fields.length);
  assert.ok(flag.fields.length > 1, "its ring, not the sphere's own space");
  assert.deepEqual(sphere.light, {bright: 20, dim: 40, negative: false}, "its light is the sphere's");
  await endTurn(areas, game, targetToken, 0);
  assert.equal(targetActor.system.resources.health.value, 24, "the configured (upcast) damage, as its turn ends beside the sphere");
  const sphereHealth = sphere.actor.system.resources.health.value;
  await endTurn(areas, game, sphere, 0);
  await endTurn(areas, game, farToken, 0);
  assert.deepEqual([sphere.actor.system.resources.health.value, far.system.resources.health.value], [sphereHealth, 30],
    "never the sphere itself, nor one out of reach");
  const [unslotted] = await areas.carry({state: {source: {tokenId: sourceToken.id}, actionDefinition: spell(carrying(4))}},
    [summonedToken(fixture, "sphere-2", {i: 6, j: 0})]);
  assert.equal(unslotted.flags.wildpath.area.castLevel, 2, "with no slot chosen, its spell's own level");
  // An undispellable summon's area keeps no level either: dispelling it would end the summon (wave D S7).
  const undispellable = spell(carrying(4));
  undispellable.summon.dispellable = false;
  const [kept] = await areas.carry({state: {source: {tokenId: sourceToken.id}, actionDefinition: undispellable,
    configuration: {castingLevel: 3}}}, [summonedToken(fixture, "sphere-3", {i: 8, j: 0})]);
  assert.equal(kept.flags.wildpath.area.castLevel, null, "summon.dispellable: false reaches the area it carries");
  game.users.activeGM = game.users.get("player-a");
  assert.deepEqual(await areas.carry(event, [sphere]), [], "only the active GM");
});

test("a ram ending in a creature's space: the area its creature carries answers area.rammed there, and its move is over (Q33)", async t => {
  const fixture = lastingAreaFixture(t);
  const {scene, sourceToken, targetActor, far, areas, game} = fixture;
  // Rolled into the target's square (1,0); the far creature at (5,0) is out of its 5-foot reach.
  const sphere = summonedToken(fixture, "sphere", {i: 1, j: 0});
  await areas.carry({state: {source: {tokenId: sourceToken.id}, actionDefinition: carrying(4, {on: ["turn.ended", "area.rammed"]})}}, [sphere]);
  const updates = [];
  sphere.actor.update = async data => { updates.push(data); };
  sphere.actor.system.resources.movement = {spent: 10, max: 30};
  const event = {type: "movement.completed", data: {movementKind: "voluntary", tokenRef: `token:${scene.id}.sphere`}};
  assert.deepEqual(await areas.rammed(event), [], "a creature without occupancy.ram rams nothing");
  sphere.actor.getStatistic = domains => ([domains].flat().includes("occupancy.ram") ? {totalModifier: 1} : null);
  assert.deepEqual(await areas.rammed({...event, data: {...event.data, movementKind: "forced"}}), [], "only its own move");
  assert.deepEqual(await areas.rammed({...event, type: "movement.interrupted"}), [], "only a completed one");
  assert.equal(targetActor.system.resources.health.value, 30);
  assert.equal((await areas.rammed(event)).length, 1);
  assert.deepEqual([targetActor.system.resources.health.value, far.system.resources.health.value], [26, 30],
    "the creature it was rolled into takes its spell's damage, no one else");
  assert.deepEqual(updates, [{"system.resources.movement.spent": 30}], "it moves no more this turn");
  const {footprint} = createFoundryV14TacticalGridAdapter({scene}).tokenToFootprint(sphere);
  assert.deepEqual(await areas.rammed({...event, data: {...event.data, origin: {footprint}}}), [],
    "a move that set out in the creature's space (on within a Large one) rams it no more");
  assert.deepEqual([targetActor.system.resources.health.value, updates.length], [26, 1]);
  game.users.activeGM = game.users.get("player-a");
  assert.deepEqual(await areas.rammed(event), [], "only the active GM");
});

test("a lasting area's budget: it ends once its triggers dealt that much, dismissing the summon carrying it; the rest of a sweep is spared", async t => {
  const dismissed = [];
  const fixture = lastingAreaFixture(t, {dismissSummon: async (scene, ids) => dismissed.push(...ids)});
  const {scene, sourceToken, targetActor, targetToken, far, farToken, areas, game} = fixture;
  // A guardian at (3,0): 10 feet reaches both the target at (1,0) and the far creature at (5,0).
  const guardian = summonedToken(fixture, "guardian", {i: 3, j: 0});
  const [region] = await areas.carry({state: {source: {tokenId: sourceToken.id},
    actionDefinition: carrying(4, {on: ["area.entered"], size: 10, persistence: {budget: {damage: 10}}})}}, [guardian]);
  const flag = region.flags.wildpath.area;
  for ( const turn of [1, 2] ) {
    game.combat.turn = turn;
    await areas.apply(region, flag, targetToken, "area.entered");
  }
  assert.deepEqual([targetActor.system.resources.health.value, flag.dealt, dismissed], [22, 8, []], "8 of 10 dealt");
  game.combat.turn = 3;
  await areas.apply(region, {...flag}, farToken, "area.entered");
  assert.deepEqual([far.system.resources.health.value, flag.dealt, dismissed], [26, 12, ["guardian"]],
    "the strike crossing it deals its full damage, then the guardian vanishes");
  // Foundry deletes its Region with its Token without waiting: a creature the same sweep listed after it is spared.
  game.combat.turn = 4;
  assert.deepEqual(await areas.apply(region, {...flag, dealt: 0}, targetToken, "area.entered"), [], "read from the live Region");
  assert.equal(targetActor.system.resources.health.value, 22);
  // An area no summon carries is deleted instead.
  const placed = await areas.create({options: {persistentArea: {footprint: {topology: "square",
    fields: createFoundryV14TacticalGridAdapter({scene}).tokenToFootprint(targetToken).footprint.fields},
    definition: {id: "action:ward", label: "Ward", area: {shape: "radial", size: {value: 5, unit: "ft"}, persistence: {budget: {damage: 4},
      triggers: [{on: ["area.entered"], action: BURNING}]}}}, sourceTokenId: sourceToken.id, sceneId: scene.id}}, state: {}});
  game.combat.turn = 5;
  await areas.apply(placed, placed.flags.wildpath.area, targetToken, "area.entered");
  assert.equal(scene.regions.includes(placed), false);
});

test("a carried area's spell ends with it: its summon dismissed when it is dispelled or 2024 Darkness of its level covers its light (Q31, Q99 (f))", async t => {
  const dismissed = [];
  const fixture = lastingAreaFixture(t, {dismissSummon: async (scene, ids) => dismissed.push(...ids)});
  const {scene, sourceToken, areas} = fixture;
  const sphere = summonedToken(fixture, "sphere", {i: 2, j: 0});
  const lit = {...carrying(4, {persistence: {light: {bright: 20, dim: 40}}}), metadata: {spellLevel: 2}};
  const carry = castingLevel => areas.carry({state: {source: {tokenId: sourceToken.id}, actionDefinition: lit,
    configuration: {castingLevel}}}, [sphere]);
  const [region] = await carry(2);
  await areas.end(region);
  assert.deepEqual([dismissed, scene.regions.includes(region)], [["sphere"], true],
    "the sphere is dismissed (its Region goes with its Token), not its Region deleted alone");
  // 2024 Darkness at level 2 cast over the sphere's light ends a sphere cast at level 2, not one cast at level 3.
  const darkness = castingLevel => areas.create({options: {persistentArea: {footprint: {topology: region.flags.wildpath.area.topology,
    fields: region.flags.wildpath.area.fields}, definition: {id: "action:darkness", label: "Darkness", area: {shape: "radial",
    size: {value: 15, unit: "ft"}, persistence: {light: {bright: 15, darkness: true, dispels: 2, spellLevel: 2}}}},
    sourceTokenId: sourceToken.id, sceneId: scene.id}}, state: {configuration: {castingLevel}}});
  dismissed.length = 0;
  await darkness(2);
  assert.deepEqual(dismissed, ["sphere"], "Darkness ends the sphere's spell");
  scene.regions.splice(0);
  dismissed.length = 0;
  const [stronger] = await carry(3);
  await darkness(2);
  assert.deepEqual([dismissed, scene.regions.includes(stronger)], [[], true], "a sphere cast at level 3 outlasts it");
  // An area no summon carries: its Region is deleted.
  await areas.end(stronger);
  assert.deepEqual(dismissed, ["sphere"]);
  const placed = scene.regions.find(entry => entry.flags.wildpath.area.label === "Darkness");
  await areas.end(placed);
  assert.equal(scene.regions.includes(placed), false);
  // Darkness cast on another spell's summon (a Spiritual Weapon): dispelling it ends only the Darkness.
  const weapon = summonedToken(fixture, "weapon", {i: 9, j: 9}, "action:spiritual-weapon");
  const anchored = await areas.create({options: {persistentArea: {footprint: {topology: "square", fields: [{x: 9, y: 9}]},
    definition: {id: "action:darkness", label: "Darkness", area: {shape: "radial",
      size: {value: 15, unit: "ft"}, persistence: {light: {bright: 15, darkness: true}}}}, sourceTokenId: sourceToken.id,
    sceneId: scene.id}}}, {anchor: weapon});
  await areas.end(anchored);
  assert.deepEqual([dismissed, scene.regions.includes(anchored)], [["sphere"], false], "the weapon stays; the Darkness goes");
});

test("2024 Darkness ends a carried area's light where it reaches, its dim light, not only its own ring (Q99 (f))", async t => {
  const dismissed = [];
  const fixture = lastingAreaFixture(t, {dismissSummon: async (scene, ids) => dismissed.push(...ids)});
  const {scene, sourceToken, areas} = fixture;
  const sphere = summonedToken(fixture, "sphere", {i: 2, j: 0});
  const lit = {...carrying(4, {persistence: {light: {bright: 20, dim: 40}}}), metadata: {spellLevel: 2}};
  await areas.carry({state: {source: {tokenId: sourceToken.id}, actionDefinition: lit, configuration: {castingLevel: 2}}}, [sphere]);
  const darkness = x => areas.create({options: {persistentArea: {footprint: {topology: "square", fields: [{x, y: 0}]},
    definition: {id: "action:darkness", label: "Darkness", area: {shape: "radial", size: {value: 15, unit: "ft"},
      persistence: {light: {bright: 15, darkness: true, dispels: 2, spellLevel: 2}}}}, sourceTokenId: sourceToken.id, sceneId: scene.id}},
    state: {configuration: {castingLevel: 2}}});
  await darkness(14);
  assert.deepEqual(dismissed, [], "past its 40 feet of dim light");
  await darkness(8);
  assert.deepEqual(dismissed, ["sphere"], "30 feet off, in its dim light, though far from its 5-foot ring");
});

test("a lasting area's budget counts only completed runs, and two runs resolved together both", async t => {
  let fail = () => false;
  const fixture = lastingAreaFixture(t, {failOn: operation => fail(operation)});
  const {sourceToken, targetToken, targetActor, far, farToken, areas, game} = fixture;
  const guardian = summonedToken(fixture, "guardian", {i: 3, j: 0});
  const [region] = await areas.carry({state: {source: {tokenId: sourceToken.id},
    actionDefinition: carrying(4, {on: ["area.entered"], size: 10, persistence: {budget: {damage: 100}}})}}, [guardian]);
  const flag = region.flags.wildpath.area;
  // Its damage planned, then its commit fails: no Hit Points changed, so nothing is spent.
  fail = operation => (operation.type === "updateActor") && (operation.actorRef === far.uuid);
  game.combat.turn = 1;
  const [failed] = await areas.apply(region, flag, farToken, "area.entered");
  assert.notEqual(failed.status, "completed");
  assert.deepEqual([far.system.resources.health.value, flag.dealt ?? 0], [30, 0], "a failed run spends nothing");
  fail = () => false;
  // A Region's update lands only after its round trip, as Foundry's does: two runs ending together must both count.
  const update = region.update;
  region.update = async changes => { await new Promise(resolve => setTimeout(resolve, 5)); return update.call(region, changes); };
  game.combat.turn = 2;
  await Promise.all([areas.apply(region, flag, targetToken, "area.entered"), areas.apply(region, flag, farToken, "area.entered")]);
  assert.deepEqual([targetActor.system.resources.health.value, far.system.resources.health.value, flag.dealt], [26, 26, 8],
    "neither run's damage is lost");
});

test("a carried area's trigger gives no cover (Q37): not from its caster behind a wall, nor from the creature carrying it", async t => {
  const fixture = lastingAreaFixture(t);
  const {scene, sourceToken, far, farToken, areas} = fixture;
  const guardian = summonedToken(fixture, "guardian", {i: 4, j: 0});
  const [region] = await areas.carry({state: {source: {tokenId: sourceToken.id}, actionDefinition: carrying(4, {on: ["turn.started"]})}},
    [guardian]);
  // A wall across x = 150 (a 50 px grid): between the caster at (0,0) and the far creature at (5,0), not the guardian at (4,0).
  walled(t, scene, (a, b) => (Math.min(a.x, b.x) < 150) && (Math.max(a.x, b.x) > 150));
  assert.equal(actionCover({definition: BURNING, sourceToken, targetToken: farToken}), "total", "from the caster: Total Cover");
  const [state] = await areas.apply(region, region.flags.wildpath.area, farToken, "turn.started");
  assert.equal(far.system.resources.health.value, 26, "beside the guardian, it is still affected");
  // The guardian the lines start from gives no cover itself (live 2026-11-14: Half Cover on every save).
  assert.equal(state.input.context.cover, undefined, "nothing between the guardian and it: no cover");
});

test("a carried area's trigger for those its caster sees (targeting.eligible seenBySource, 2024 Conjure Animals, Q30): not one behind a wall or its caster Blinded", async t => {
  const fixture = lastingAreaFixture(t);
  const {scene, sourceToken, sourceActor, far, farToken, areas} = fixture;
  const pack = summonedToken(fixture, "pack", {i: 4, j: 0});
  const carry = async targeting => (await areas.carry({state: {source: {tokenId: sourceToken.id},
    actionDefinition: carrying(4, {on: ["turn.ended", "area.entered"], persistence: {oncePerTurn: true}, targeting})}}, [pack]))[0];
  const seen = await carry({type: "single", eligible: {equals: {path: "seenBySource", value: true}}});
  // Its caster Blinded: the creature beside the pack is left alone, on entering and ending its turn alike.
  sourceActor.statuses = new Set(["blinded"]);
  for ( const event of ["area.entered", "turn.ended"] ) {
    assert.deepEqual(await areas.apply(seen, seen.flags.wildpath.area, farToken, event), [], event);
  }
  assert.equal(far.system.resources.health.value, 30);
  sourceActor.statuses = new Set();
  // A wall across x = 150 (a 50 px grid): between the caster at (0,0) and the creature at (5,0), not the pack at (4,0).
  const unwalled = await carry(null);
  walled(t, scene, (a, b) => (Math.min(a.x, b.x) < 150) && (Math.max(a.x, b.x) > 150));
  assert.deepEqual(await areas.apply(seen, seen.flags.wildpath.area, farToken, "turn.ended"), [], "unseen behind the wall");
  assert.equal(far.system.resources.health.value, 30);
  // Without the flag the same creature is reached (Flaming Sphere: any creature).
  await areas.apply(unwalled, unwalled.flags.wildpath.area, farToken, "turn.ended");
  assert.equal(far.system.resources.health.value, 26);
  // Seen again, it saves, in the same turn: being left out spent none of its once per turn.
  globalThis.CONFIG.Canvas.polygonBackends.sight.testCollision = () => false;
  await areas.apply(seen, seen.flags.wildpath.area, farToken, "turn.ended");
  assert.equal(far.system.resources.health.value, 22);
});

/** Walls everywhere `blocks(a, b)` says on the fixture's Scene, for the length of the test. */
function walled(t, scene, blocks=() => true) {
  const saved = {canvas: globalThis.canvas, CONFIG: globalThis.CONFIG};
  t.after(() => Object.assign(globalThis, saved));
  globalThis.canvas = {scene};
  globalThis.CONFIG = {...(saved.CONFIG ?? {}), Canvas: {polygonBackends: {sight: {testCollision: blocks}}}};
}

test("no cover against a lasting area's or an aura's own trigger (Q37); a creature's own Total Cover still keeps it out (Q103)", async t => {
  const fixture = syntheticRuntimeFixture(t, fortitudeBlast("agility"));
  const {targetActor, sourceToken, targetToken, action, intent, game} = fixture;
  const resolve = (statuses, options) => {
    targetActor.statuses = new Set(statuses);
    return foundryActionIntentToStagedOptions({intent, senderUserId: "player-a", game, ...options});
  };
  const covered = resolved => [(resolved.options.context.cover ?? []).map(entry => entry.degree),
    resolved.options.save?.modifiersByTarget?.["target-token"] ?? 0];
  assert.deepEqual(covered(await resolve(["coverHalf"], {action})), [["half"], 2], "an automatic Action keeps cover");
  assert.deepEqual(covered(await resolve(["coverHalf"], {action, noCover: true})), [[], 0], "a lasting area's trigger: none");
  assert.deepEqual(covered(await resolve(["coverHalf"], {noCover: true})), [["half"], 2], "only the authority's own Actions");
  const swallowed = await resolve(["coverTotal"], {action, noCover: true});
  assert.deepEqual([swallowed.ok, swallowed.options.targets.length], [true, 0], "a swallowed creature is left out");
  targetActor.statuses = new Set();
  walled(t, fixture.scene);
  const definition = fortitudeBlast("agility");
  assert.deepEqual([actionCover({definition, sourceToken, targetToken}), actionCover({definition, sourceToken, targetToken, noCover: true})],
    ["total", "none"], "walls give it nothing");
});

test("a placed area's trigger reaches a creature its caster sees only through a wall, with no cover (Q37)", async t => {
  const {scene, targetActor, targetToken, player, areas, intent} = lastingAreaFixture(t);
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  assert.equal(targetActor.system.resources.health.value, 24);
  walled(t, scene);
  const [state] = await areas.apply(scene.regions[0], scene.regions[0].flags.wildpath.area, targetToken, "turn.started");
  assert.equal(targetActor.system.resources.health.value, 20, "still burned, though its caster has Total Cover from it");
  assert.equal(state.input.context.cover, undefined);
});

test("an aura on a turn gives no cover (Q37); a death burst keeps cover from its creature (Q103)", async t => {
  const {scene, sourceActor, sourceToken, targetActor, targetToken, automation} = lastingAreaFixture(t);
  let walls = true;
  walled(t, scene, () => walls);
  sourceActor.items = [triggerFeature("fear-aura", {event: "turn.started", around: {radius: 5, affects: "others", on: "others"}})];
  await automation.dispatch("turn.started", {actor: targetActor, token: targetToken});
  assert.equal(targetActor.system.resources.health.value, 26, "another's aura reaches it through the wall");
  sourceActor.items = [triggerFeature("fire-aura", {event: "turn.ended", around: {radius: 5, affects: "others"}})];
  await automation.dispatch("turn.ended", {actor: sourceActor, token: sourceToken});
  assert.equal(targetActor.system.resources.health.value, 22, "its own aura as its turn ends, too");
  sourceActor.items = [triggerFeature("death-burst", {event: "creature.died", around: {radius: 5, affects: "others"}})];
  await automation.dispatch("creature.died", {actor: sourceActor, token: sourceToken});
  assert.equal(targetActor.system.resources.health.value, 22, "a death burst is an instant area: Total Cover leaves it out");
  walls = false;
  await automation.dispatch("creature.died", {actor: sourceActor, token: sourceToken});
  assert.equal(targetActor.system.resources.health.value, 18, "without the wall it burns");
});

test("an aura's trigger leaves out a creature its Action's targeting.eligible doesn't admit (\"that can hear it\"), its own and another's", async t => {
  const {sourceActor, sourceToken, targetActor, targetToken, automation} = lastingAreaFixture(t);
  const hearing = {...BURNING, targeting: {type: "single", eligible: {missingCondition: "deafened"}}};
  const aura = (id, event, around) => triggerFeature(id, {event, around, action: hearing});
  targetActor.statuses = new Set(["deafened"]);
  sourceActor.items = [aura("whisper", "turn.ended", {radius: 5, affects: "others"})];
  await automation.dispatch("turn.ended", {actor: sourceActor, token: sourceToken});
  sourceActor.items = [aura("whisper-others", "turn.started", {radius: 5, affects: "others", on: "others"})];
  await automation.dispatch("turn.started", {actor: targetActor, token: targetToken});
  assert.equal(targetActor.system.resources.health.value, 30, "a Deafened creature: neither its own aura's nor another's");
  targetActor.statuses = new Set();
  await automation.dispatch("turn.started", {actor: targetActor, token: targetToken});
  assert.equal(targetActor.system.resources.health.value, 26, "one that hears it burns");
});

/** A feature carrying one Trigger RuleElement whose inline Action is BURNING. */
const triggerFeature = (id, data, {active=true}={}) => ({id, type: "feature", name: id,
  system: {active, ruleElements: [{id: "trigger", type: "Trigger", data: {action: BURNING, ...data}}]}});

test("an Item's automatic trigger runs its Action on its owner through the authority when its event happens", async t => {
  const {targetActor, targetToken, automation} = lastingAreaFixture(t);
  targetActor.items = [
    triggerFeature("cursed-blood", {event: "turn.started"}),
    triggerFeature("inactive", {event: "turn.started"}, {active: false}),
    triggerFeature("a-reaction", {event: "turn.started", kind: "reaction"}),
    triggerFeature("never", {event: "turn.started", predicate: {equals: {path: "event.data.never", value: true}}})
  ];
  await automation.dispatch("turn.ended", {actor: targetActor, token: targetToken});
  assert.equal(targetActor.system.resources.health.value, 30, "another event reaches nothing");
  const states = await automation.dispatch("turn.started", {actor: targetActor, token: targetToken});
  assert.deepEqual(states.map(state => state.status), [RESOLUTION_STATE_STATUS.COMPLETED],
    "only the active automatic trigger whose predicate holds runs");
  assert.equal(targetActor.system.resources.health.value, 26);
});

test("another creature's aura its creature may use on one starting its turn there follows its Item's Never or Always", async t => {
  const {sourceActor, targetActor, targetToken, automation} = lastingAreaFixture(t);
  // "the spirit can target it" (Stony Lethargy): a `use` choice, as a creature's own "you can".
  const use = {id: "use", type: "option", label: "Use", required: true, defaultValue: "use",
    options: [{id: "use", label: "Use it", value: "use"}, {id: "decline", label: "Not now", value: "decline"}], effects: [{type: "decline"}]};
  const aura = policy => ({...triggerFeature("lethargy", {event: "turn.started", around: {radius: 5, affects: "others", on: "others"},
    action: {...BURNING, configuration: [use]}}), flags: {wildpath: {reactionPolicy: policy}}});
  sourceActor.items = [aura("never")];
  assert.deepEqual(await automation.dispatch("turn.started", {actor: targetActor, token: targetToken}), []);
  assert.equal(targetActor.system.resources.health.value, 30, "Never lets it be");
  sourceActor.items = [aura("always")];
  await automation.dispatch("turn.started", {actor: targetActor, token: targetToken});
  assert.equal(targetActor.system.resources.health.value, 26, "Always uses it");
});

test("a summon's aura with around.notSummoner spares its summoner, not the summoner's allies (Festering Aura, Q76)", async t => {
  const {sourceActor, sourceToken, targetActor, targetToken, automation} = lastingAreaFixture(t);
  sourceActor.items = [triggerFeature("festering", {event: "turn.started", around: {radius: 5, affects: "others", on: "others",
    notSummoner: true}})];
  sourceToken.flags = {wildpath: {summon: {casterUuid: targetActor.uuid}}};
  assert.deepEqual(await automation.dispatch("turn.started", {actor: targetActor, token: targetToken}), []);
  assert.equal(targetActor.system.resources.health.value, 30, "its summoner starting its turn beside it");
  // Another's summon (the creature is that summoner's ally), and one placed by hand, naming nobody: it is reached.
  for ( const flags of [{wildpath: {summon: {casterUuid: "Actor.someone-else"}}}, {}] ) {
    sourceToken.flags = flags;
    targetActor.system.resources.health.value = 30;
    await automation.dispatch("turn.started", {actor: targetActor, token: targetToken});
    assert.equal(targetActor.system.resources.health.value, 26, JSON.stringify(flags));
  }
});

test("an aura skips a creature immune to its Action: an Unaffected effect, or the immuneTo mark of effects converted before it", async t => {
  const {sourceActor, targetActor, targetToken, automation} = lastingAreaFixture(t);
  sourceActor.items = [triggerFeature("fear-aura", {event: "turn.started", around: {radius: 5, affects: "others", on: "others"}})];
  const unaffected = {name: "Fear Aura: immune", disabled: false, isSuppressed: false, system: {ruleElements: [{schemaVersion: 1,
    id: "immune", type: "Unaffected", data: {actions: {tagsAny: [`id:${BURNING.id}`], notTagsAny: ["attack"]}}}]}};
  const marked = {name: "Fear Aura: immune", disabled: false, flags: {wildpath: {conditionEffect: {metadata: {immuneTo: BURNING.id}}}}};
  for ( const effect of [unaffected, marked] ) {
    targetActor.effects = [effect];
    assert.deepEqual(await automation.dispatch("turn.started", {actor: targetActor, token: targetToken}), [], effect.system ? "Unaffected" : "immuneTo");
    assert.equal(targetActor.system.resources.health.value, 30, "no card, no damage");
  }
  targetActor.effects = [];
  await automation.dispatch("turn.started", {actor: targetActor, token: targetToken});
  assert.equal(targetActor.system.resources.health.value, 26, "without it the aura reaches it");
});

test("an effect's automatic trigger sees its giver: how far its nearest Token stands and its statuses (Pipes of the Sewers' Swayed, Q18.6)", async t => {
  const {sourceActor, sourceToken, targetActor, targetToken, scene, automation} = lastingAreaFixture(t);
  const previous = globalThis.fromUuidSync;
  globalThis.fromUuidSync = ref => ((ref === sourceActor.uuid) ? sourceActor : null);
  t.after(() => { if ( previous === undefined ) delete globalThis.fromUuidSync; else globalThis.fromUuidSync = previous; });
  sourceActor.documentName = "Actor";
  sourceActor.statuses = new Set(["pipes-playing"]);
  // A world Actor's linked Token (creatureTokens), so its Token can leave the Scene while it is still found.
  Object.assign(sourceActor, {isToken: false, getDependentTokens: () => scene.tokens.filter(each => each === sourceToken)});
  const burns = async (predicate, {item=false}={}) => {
    targetActor.system.resources.health.value = 30;
    const trigger = {id: "trigger", type: "Trigger", data: {event: "turn.started", predicate, action: BURNING}};
    const owner = item ? triggerFeature("feature", {event: "turn.started", predicate})
      : {id: "swayed", type: "effect", name: "Swayed", disabled: false, flags: {wildpath: {conditionEffect: {sourceRef: sourceActor.uuid}}},
        system: {ruleElements: [trigger]}};
    targetActor.effects = item ? [] : [owner];
    targetActor.items = item ? [owner] : [];
    await automation.dispatch("turn.started", {actor: targetActor, token: targetToken});
    return targetActor.system.resources.health.value < 30;
  };
  assert.equal(await burns({atMost: {path: "giver.distance", value: 5}}), true, "its giver stands 5 feet away");
  assert.equal(await burns({atMost: {path: "giver.distance", value: 0}}), false);
  const playing = {equals: {path: "giver.statuses.pipes-playing", value: true}};
  assert.equal(await burns(playing), true, "its giver is playing");
  sourceActor.statuses = new Set();
  assert.equal(await burns(playing), false, "and once it stops");
  assert.equal(await burns(playing, {item: true}), false, "an Item's Trigger has no giver");
  // Its giver gone from the Scene: no distance, so "more than 30 feet away" holds.
  scene.tokens.splice(scene.tokens.indexOf(sourceToken), 1);
  assert.equal(await burns({not: {atMost: {path: "giver.distance", value: 30}}}), true);
});

test("an automatic trigger's predicate sees form.distance, how far a possession's Token stands from its body's (wave D B18)", async t => {
  const {targetActor, targetToken, automation} = lastingAreaFixture(t);
  targetActor.items = [triggerFeature("far", {event: "turn.started", predicate: {atLeast: {path: "form.distance", value: 101}}})];
  const burns = async distance => {
    targetActor.system.resources.health.value = 30;
    targetActor.formDistance = distance;
    await automation.dispatch("turn.started", {actor: targetActor, token: targetToken});
    return targetActor.system.resources.health.value < 30;
  };
  assert.equal(await burns(120), true, "more than 100 feet from its body");
  assert.equal(await burns(100), false);
  assert.equal(await burns(null), false, "no possession standing in its body's place");
});

test("an automatic trigger's predicate sees its creature: Regeneration needs at least 1 Hit Point", async t => {
  const {targetActor, targetToken, automation} = lastingAreaFixture(t);
  targetActor.items = [triggerFeature("regeneration", {event: "turn.started",
    predicate: {not: {equals: {path: "actor.system.resources.health.value", value: 0}}}})];
  targetActor.system.resources.health.value = 0;
  assert.deepEqual(await automation.dispatch("turn.started", {actor: targetActor, token: targetToken}), [], "at 0 Hit Points");
  targetActor.system.resources.health.value = 10;
  assert.equal((await automation.dispatch("turn.started", {actor: targetActor, token: targetToken})).length, 1);
});

test("a turn Trigger acts on the creatures a condition binds to its own (around.condition): held by it, holding it, or both", async t => {
  const {sourceActor, sourceToken, targetActor, far, automation} = lastingAreaFixture(t);
  // A Grappled effect names whoever gave it; one a GM toggles by hand names nobody.
  const grappled = by => ({name: "Grappled", disabled: false, statuses: ["grappled"], flags: {wildpath: {conditionEffect: {sourceRef: by}}}});
  const hide = from => {
    sourceActor.items = [triggerFeature("barbed-hide", {event: "turn.started", around: {condition: "grappled", from}})];
    for ( const actor of [targetActor, far] ) actor.system.resources.health.value = 30;
  };
  hide("it");
  targetActor.effects = [grappled(sourceActor.uuid)];
  far.effects = [grappled("Actor.someone-else"), {...grappled(null), flags: {}}];
  await automation.dispatch("turn.started", {actor: sourceActor, token: sourceToken});
  assert.deepEqual([targetActor.system.resources.health.value, far.system.resources.health.value], [26, 30],
    "the creature it grapples; not one grappled by another or by nobody named");
  // "Any creature grappling it": its own Grappled names the other.
  hide("them");
  sourceActor.effects = [grappled(far.uuid)];
  await automation.dispatch("turn.started", {actor: sourceActor, token: sourceToken});
  assert.deepEqual([targetActor.system.resources.health.value, far.system.resources.health.value], [30, 26]);
  hide("either");
  await automation.dispatch("turn.started", {actor: sourceActor, token: sourceToken});
  assert.deepEqual([targetActor.system.resources.health.value, far.system.resources.health.value], [26, 26], "both, one roll");
  sourceActor.effects = [grappled(targetActor.uuid)];
  far.effects = [];
  hide("either");
  await automation.dispatch("turn.started", {actor: sourceActor, token: sourceToken});
  assert.deepEqual([targetActor.system.resources.health.value, far.system.resources.health.value], [26, 30],
    "a creature both grappling it and grappled by it is reached once");
  far.effects = [grappled(sourceActor.uuid)];
  for ( const from of [undefined, "its"] ) {
    hide(from);
    assert.deepEqual(await automation.dispatch("turn.started", {actor: sourceActor, token: sourceToken}), [], `from ${from}`);
    assert.deepEqual([targetActor.system.resources.health.value, far.system.resources.health.value], [30, 30],
      "no relation named, nobody reached: never both ways");
  }
  // A creature that died held (or swallowed, which is held the same way) is an object: no longer reached.
  hide("it");
  far.statuses = new Set(["dead"]);
  await automation.dispatch("turn.started", {actor: sourceActor, token: sourceToken});
  assert.deepEqual([targetActor.system.resources.health.value, far.system.resources.health.value], [26, 30], "not the dead one");
});

/** An Item whose time.elapsed Trigger runs `action` every 10 minutes, keeping what its update writes (its carry). */
const intervalFeature = (data={}) => {
  const feature = {...triggerFeature("ring", {event: "time.elapsed", every: {value: 10, units: "minutes"}, ...data}), flags: {}};
  feature.update = async changes => {
    // Written only after a round trip, as the server's update is.
    await Promise.resolve();
    for ( const [path, value] of Object.entries(changes) ) {
      const keys = path.split(".");
      const last = keys.pop();
      keys.reduce((node, key) => (node[key] ??= {}), feature)[last] = value;
    }
  };
  return feature;
};

test("a time.elapsed Trigger runs once per interval the world time covered, counting on from what was left over", async t => {
  const {targetActor, automation} = lastingAreaFixture(t);
  const ring = intervalFeature();
  targetActor.items = [ring];
  const elapse = seconds => automation.dispatch("time.elapsed", {actor: targetActor, data: {seconds}});
  assert.deepEqual(await elapse(300), [], "half an interval runs nothing");
  assert.equal(ring.flags.wildpath.elapsed.trigger, 300, "and is kept on its Item");
  assert.equal((await elapse(300)).length, 1, "the other half completes one");
  assert.equal(ring.flags.wildpath.elapsed.trigger, 0);
  assert.equal((await elapse(3600)).length, 6, "an hour is six");
  assert.equal(targetActor.system.resources.health.value, 2);
  assert.deepEqual(await elapse(-3600), [], "time turned back counts nothing");
  assert.equal(ring.flags.wildpath.elapsed.trigger, 0);

  targetActor.system.resources.health = {value: 1000, max: 1000};
  assert.equal((await elapse((10 * 86400) + 123)).length, 24, "ten days run a day of hourly intervals at most");
  assert.equal(ring.flags.wildpath.elapsed.trigger, 123, "the rest of the jump is dropped");
});

test("a time.elapsed Trigger stops as soon as its predicate no longer holds: healing stops once its creature is full", async t => {
  const {targetActor, automation} = lastingAreaFixture(t);
  const elapse = () => automation.dispatch("time.elapsed", {actor: targetActor, data: {seconds: 3600}});
  targetActor.items = [intervalFeature({predicate: {atLeast: {path: "actor.system.resources.health.value", value: 20}}})];
  assert.equal((await elapse()).length, 3, "30, 26 and 22 Hit Points; not 18");
  const MEND = {schemaVersion: 1, id: "action:mend", label: "Mend", costs: {allOf: []},
    healing: [{id: "fixed", expression: {type: "constant", value: 4}}]};
  targetActor.items = [intervalFeature({action: MEND, predicate: {equals: {path: "damaged", value: true}}})];
  targetActor.system.resources.health = {value: 25, max: 30};
  assert.equal((await elapse()).length, 2, "25 to 29 to 30, then full");
  assert.equal(targetActor.system.resources.health.value, 30);
  const unattuned = {...intervalFeature({predicate: {not: {equals: {path: "owner.system.attunement", value: "required"}}}})};
  unattuned.system.attunement = "required";
  targetActor.system.resources.health.value = 20;
  targetActor.items = [unattuned];
  assert.deepEqual(await elapse(), [], "an Item not yet attuned");
  assert.equal(unattuned.flags.wildpath, undefined, "counts no time");
});

test("world time moving on runs each creature's intervals on the active GM only, one time change after another", async t => {
  const {targetActor, game, automation} = lastingAreaFixture(t);
  game.actors[Symbol.iterator] = function* () { yield* this.values(); };
  const ring = intervalFeature();
  targetActor.items = [ring];
  const gm = game.users.activeGM;
  game.users.activeGM = game.users.get("player-a");
  await automation.onWorldTime(600);
  game.users.activeGM = gm;
  await automation.onWorldTime(0);
  assert.equal(targetActor.system.resources.health.value, 30, "another client, or no time, runs nothing");
  assert.equal(ring.flags.wildpath, undefined);
  void automation.onWorldTime(300);
  await automation.onWorldTime(300);
  assert.equal(targetActor.system.resources.health.value, 26, "two quick changes count on from each other: one interval");
  assert.equal(ring.flags.wildpath.elapsed.trigger, 0);

  game.scenes[Symbol.iterator] = () => { throw new Error("broken scene"); };
  await assert.rejects(automation.onWorldTime(600), /broken scene/);
  await assert.doesNotReject(automation.onWorldTime(-600), "time turned back does not report the earlier failure again");
});

test("world time passes for each Token's creature, with its Token, and not for a template whose Tokens are unlinked", async t => {
  const {sourceActor, targetActor, targetBase, game, automation} = lastingAreaFixture(t);
  game.actors[Symbol.iterator] = function* () { yield* this.values(); };
  targetBase.prototypeToken = {actorLink: false};
  targetBase.items = [intervalFeature()];
  // A burning aura on the source's own Token: it reaches the target beside it only through that Token.
  sourceActor.items = [intervalFeature({around: {radius: 5}})];
  await automation.onWorldTime(600);
  assert.equal(targetActor.system.resources.health.value, 26, "the aura around the source's Token burned the target");
  assert.equal(targetBase.system.resources.health.value, 99, "the template counted nothing");
  assert.equal(targetBase.items[0].flags.wildpath, undefined);
});

test("a time.elapsed Trigger after another interval's Actions counts only while its predicate still holds", async t => {
  const {targetActor, automation} = lastingAreaFixture(t);
  const MEND = {schemaVersion: 1, id: "action:mend", label: "Mend", costs: {allOf: []},
    healing: [{id: "fixed", expression: {type: "constant", value: 4}}]};
  const whileDamaged = every => ({...intervalFeature({action: MEND, every, predicate: {equals: {path: "damaged", value: true}}}),
    id: `mend-${every.units}`});
  const hourly = whileDamaged({value: 1, units: "hours"});
  targetActor.items = [whileDamaged({value: 10, units: "minutes"}), hourly];
  targetActor.system.resources.health = {value: 26, max: 30};
  const states = await automation.dispatch("time.elapsed", {actor: targetActor, data: {seconds: 3600}});
  assert.equal(states.length, 1, "the first heals it full; the hourly one finds it full and does not run");
  assert.equal(hourly.flags.wildpath, undefined, "nor counts the time");
});

test("an automatic trigger's predicate sees where its creature stands: running water as its turn ends, a curse outside water", async t => {
  const {scene, targetActor, targetToken, automation} = lastingAreaFixture(t);
  const river = {id: "river", flags: {wildpath: {environment: {water: true, runningWater: true}}}, testPoint: () => true};
  const RUNNING_WATER = {equals: {path: "environment.runningWater", value: true}};
  targetActor.items = [triggerFeature("vampire-weakness", {event: "turn.ended", predicate: RUNNING_WATER})];
  assert.deepEqual(await automation.dispatch("turn.ended", {actor: targetActor, token: targetToken}), [], "on dry land");
  scene.regions = [river];
  assert.equal((await automation.dispatch("turn.ended", {actor: targetActor, token: targetToken})).length, 1, "in the river");
  assert.equal(targetActor.system.resources.health.value, 26);

  // A curse's effect deals its damage every 10 minutes while its creature is cursed and out of water (Mucus Cloud).
  const curse = {...intervalFeature({predicate: {all: [{hasCondition: "cursed"},
    {not: {equals: {path: "environment.water", value: true}}}]}}), type: "effect", disabled: false};
  targetActor.items = [];
  targetActor.effects = [curse];
  targetActor.statuses = new Set(["cursed"]);
  const elapse = () => automation.dispatch("time.elapsed", {actor: targetActor, token: targetToken, data: {seconds: 600}});
  assert.deepEqual(await elapse(), [], "in water");
  scene.regions = [];
  assert.equal((await elapse()).length, 1, "out of water");
  assert.equal(targetActor.system.resources.health.value, 22);
  targetActor.statuses = new Set();
  assert.deepEqual(await elapse(), [], "no longer cursed");
});

test("time.elapsed Triggers without an id, or with a dotted one, each keep their own carry", async t => {
  const {targetActor, automation} = lastingAreaFixture(t);
  const item = intervalFeature();
  const rule = item.system.ruleElements[0];
  item.system.ruleElements = [{type: "Trigger", data: rule.data},
    {type: "Trigger", data: {...rule.data, every: {value: 1, units: "hours"}}}, {...rule, id: "regen.v2"}];
  targetActor.items = [item];
  const elapse = seconds => automation.dispatch("time.elapsed", {actor: targetActor, data: {seconds}});
  assert.deepEqual(await elapse(300), []);
  assert.deepEqual(item.flags.wildpath.elapsed, {"Trigger:0": 300, "Trigger:1": 300, "regen-v2": 300});
  assert.equal((await elapse(300)).length, 2, "the two 10-minute intervals run once each");
  assert.deepEqual(item.flags.wildpath.elapsed, {"Trigger:0": 0, "Trigger:1": 600, "regen-v2": 0});
});

test("every automatic trigger's predicate sees whether its creature is missing Hit Points, an aura's bearer too", () => {
  const actor = {id: "bearer", uuid: "Actor.bearer", system: {resources: {health: {value: 5, max: 10}}},
    items: [triggerFeature("wounded", {event: "turn.started", predicate: {equals: {path: "damaged", value: true}}})]};
  assert.equal(automationTriggers(actor, {type: "turn.started"}, {}).length, 1);
  actor.system.resources.health.value = 10;
  assert.equal(automationTriggers(actor, {type: "turn.started"}, {}).length, 0);
});

test("a rest a Player reports is dispatched only for an Actor that Player owns, with only the rest type taken", async t => {
  const {targetActor, game, automation} = lastingAreaFixture(t);
  targetActor.items = [triggerFeature("long-rest-curse", {event: "rest.completed",
    predicate: {equals: {path: "event.data.restType", value: "longRest"}}})];
  const owner = game.users.get("player-a");
  const stranger = {id: "player-b", isGM: false};
  assert.deepEqual(await automation.handleQuery({type: "turn.started", actorUuid: targetActor.uuid}, {user: owner}), {ok: false},
    "a client cannot raise the GM's own events");
  assert.deepEqual(await automation.handleQuery({type: "rest.completed", actorUuid: targetActor.uuid,
    data: {restType: "longRest"}}, {user: stranger}), {ok: false}, "nor rest someone else's creature");
  assert.deepEqual(await automation.handleQuery({type: "rest.completed", actorUuid: targetActor.uuid,
    data: {restType: "shortRest"}}, {user: owner}), {ok: true});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(targetActor.system.resources.health.value, 30, "a short rest does not match the long-rest trigger");
  await automation.handleQuery({type: "rest.completed", actorUuid: targetActor.uuid, data: {restType: "longRest"}}, {user: owner});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(targetActor.system.resources.health.value, 26);
});

test("a lasting area runs out after its rounds, at the turn it was created on", () => {
  const flag = {persistence: {duration: {unit: "round", value: 2}}, createdAt: {combatId: "c", round: 1, turn: 3}};
  assert.equal(areaExpired(flag, {id: "c", round: 3, turn: 2}), false);
  assert.equal(areaExpired(flag, {id: "c", round: 3, turn: 3}), true);
  assert.equal(areaExpired(flag, {id: "other", round: 9, turn: 0}), false, "rounds pass only in its own combat");
  assert.equal(areaExpired(flag, null), false);
});

test("an expired area is gone before anyone starts a turn in it, its rounds counted in its caster's combat", async t => {
  const {scene, targetActor, targetToken, game, player, areas, intent} = lastingAreaFixture(t, {rounds: 1});
  const fight = {id: "fight", round: 1, turn: 0, started: true, combatants: [{tokenId: "source-token", sceneId: scene.id}]};
  // The GM's tracker (`game.combat`) shows a fight elsewhere, which never reaches round 2.
  game.combats = [game.combat, fight];
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  assert.equal(scene.regions.length, 1);
  assert.equal(scene.regions[0].flags.wildpath.area.createdAt.combatId, "fight");
  fight.round = 2;
  await areas.onTurn("turn.started", {combatant: {token: targetToken, combat: fight}});
  assert.equal(scene.regions.length, 0);
  assert.equal(targetActor.system.resources.health.value, 24, "only the cast itself hit");
});

test("a concentration area marks its caster, and ends when that concentration ends", async t => {
  const {scene, sourceActor, player, areas, intent} = lastingAreaFixture(t, {concentration: true});
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  const [region] = scene.regions;
  const [marker] = sourceActor.effects;
  assert.deepEqual(marker.flags.wildpath.conditionEffect.concentration, {sourceRef: "token:source-token"},
    "the existing concentration checks see the caster as concentrating");
  assert.equal(region.flags.wildpath.area.concentrationEffect, marker.uuid);
  // A check broken on someone else leaves the area; one broken on the caster ends it.
  await areas.afterResolution({state: {results: {concentrationResolution: {checks: {breakEvents: [{sourceRef: "token:other"}]}}}}});
  assert.equal(scene.regions.length, 1);
  await areas.afterResolution({state: {results: {concentrationResolution: {checks: {breakEvents: [{sourceRef: "token:source-token"}]}}}}});
  assert.equal(scene.regions.length, 0, "a broken concentration ends the area");
  // Removing the marker by hand ends the area too (a fresh cast; the first one spent the caster's action).
  sourceActor.system.resources.action.value = 1;
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  assert.equal(scene.regions.length, 1);
  await areas.onEffectDeleted(sourceActor.effects.at(-1));
  assert.equal(scene.regions.length, 0);
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

/** A companion whose Bite costs its own Action and its controller's Bonus Action and 10 ft of movement. */
function companionFixture(t) {
  const definition = {schemaVersion: 1, id: "action:companion-bite", label: "Companion Bite",
    costs: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]},
    controllerCosts: {allOf: [{capability: ECONOMY_CAPABILITIES.BONUS_ACTION, amount: 1},
      {capability: ECONOMY_CAPABILITIES.MOVEMENT, amount: 10}]},
    range: {type: "reach", distance: {value: 5, unit: "ft"}}, targeting: {type: "single", required: true, count: 1},
    damage: [{id: "bite", expression: {type: "constant", value: 6}, damageType: "piercing", provenance: "weapon-base"}]};
  const fixture = syntheticRuntimeFixture(t, definition, {targetHealth: 30});
  const ranger = withFoundryActorSystem(fakeActor("ranger", {system: actorSystem()}));
  const stranger = withFoundryActorSystem(fakeActor("stranger", {system: actorSystem(), owners: []}));
  fixture.sourceActor.system.companion = {kind: "companion", controllers: [stranger.uuid, ranger.uuid]};
  const resolve = globalThis.fromUuid;
  globalThis.fromUuid = async ref => [ranger, stranger].find(actor => actor.uuid === ref) ?? resolve(ref);
  const persistencePort = createTestDocumentPersistenceAdapter();
  const hub = createTestResolutionTransportHub({users: [
    {id: "gm-a", active: true, isGM: true, isActiveGM: true},
    {id: "player-a", active: true, isGM: false}
  ]});
  const gm = createMultiplayerActionCoordinator({userId: "gm-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}),
    actionIntentResolver: ({intent, envelope}) => foundryActionIntentToStagedOptions({intent,
      senderUserId: envelope.senderUserId, game: fixture.game, persistencePort})});
  const player = createMultiplayerActionCoordinator({userId: "player-a", users: () => hub.userDirectory(),
    activeGMUserId: "gm-a", transport: hub.createEndpoint({userId: "player-a"})});
  gm.register();
  player.register();
  return {...fixture, ranger, stranger, gm, player};
}

test("a companion's Action also costs the controller its sender owns, committed with the rest", async t => {
  const {sourceActor, targetActor, ranger, stranger, gm, player, intent} = companionFixture(t);
  const declared = await player.declareActionIntent(intent);
  const state = gm.getRecord(declared.resolutionId).state;
  assert.equal(state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(state.errors));
  assert.equal(targetActor.system.resources.health.value, 24);
  assert.equal(sourceActor.system.resources.action.value, 0, "the companion pays its own Action");
  assert.deepEqual([ranger.system.resources.bonus.value, ranger.system.resources.movement.value], [0, 20],
    "the controller the Player owns pays the Bonus Action and 10 ft");
  assert.deepEqual([stranger.system.resources.bonus.value, stranger.system.resources.movement.value], [1, 30],
    "a controller the Player does not own is never charged");
});

test("the Rules Inspector reads a completed resolution: its stages, health changes and every payment", async t => {
  const {gm, player, intent} = companionFixture(t);
  const declared = await player.declareActionIntent(intent);
  const inspected = inspectResolution(gm.getRecord(declared.resolutionId));
  assert.deepEqual([inspected.label, inspected.status, inspected.initiatorUserId], ["Companion Bite", "completed", "player-a"]);
  assert.ok(inspected.stages.includes("action.payment"));
  assert.deepEqual(inspected.changes.map(change => [change.type, change.amount, change.from, change.to]), [["damage", 6, 30, 24]]);
  assert.deepEqual(inspected.payments.map(payment => [payment.resource, payment.from, payment.to]), [
    ["economy.action", 1, 0], ["economy.bonus-action", 1, 0], ["economy.movement", 30, 20]]);
  assert.deepEqual(inspected.payments.map(payment => [payment.payerLabel, payment.resourceLabel]), [
    ["WILDPATH.INSPECTOR.Payer.Source", "WILDPATH.RESOURCES.Action"], ["WILDPATH.INSPECTOR.Payer.Other", "WILDPATH.RESOURCES.BonusAction"],
    ["WILDPATH.INSPECTOR.Payer.Other", "WILDPATH.RESOURCES.Movement"]], "each payment in words, from the real record");
  assert.deepEqual(inspected.errors, []);
});

test("a companion's controller cost needs a controller the sender owns, with enough left to pay", async t => {
  const {sourceActor, targetActor, ranger, stranger, game, intent} = companionFixture(t);
  const named = await foundryActionIntentToStagedOptions({intent: {...intent, controllerRef: stranger.uuid},
    senderUserId: "player-a", game});
  assert.deepEqual([named.ok, named.code], [false, MULTIPLAYER_AUTHORITY_CODES.WRONG_USER], "naming someone else's controller");
  sourceActor.system.companion.controllers = [stranger.uuid];
  const none = await foundryActionIntentToStagedOptions({intent, senderUserId: "player-a", game});
  assert.deepEqual([none.ok, none.code], [false, MULTIPLAYER_AUTHORITY_CODES.WRONG_USER]);
  sourceActor.system.companion.controllers = [ranger.uuid];
  ranger.system.resources.movement.value = 5; // 10 ft needed
  const spent = await foundryActionIntentToStagedOptions({intent, senderUserId: "player-a", game});
  assert.equal(spent.ok, true);
  const result = planStagedActionResolution(spent.options);
  assert.equal(result.state.status, RESOLUTION_STATE_STATUS.FAILED);
  assert.equal(result.state.errors.at(-1)?.reason, "PAYMENT_UNAVAILABLE");
  assert.deepEqual([sourceActor.system.resources.action.value, targetActor.system.resources.health.value], [1, 30],
    "nothing is paid or done when the controller cannot pay");
});

test("a free Action its controller takes (byController) needs a controller the sender owns, read on its turn and movement (Q33)", async t => {
  const definition = {schemaVersion: 1, id: "action:pack-move", label: "Move", costs: {allOf: []}, byController: true,
    requires: {all: [{equals: {path: "controller.ownTurn", value: true}},
      {atLeast: {path: "controller.actorSystem.resources.movement.spent", value: 1}}]},
    range: {type: "reach", distance: {value: 5, unit: "ft"}}, targeting: {type: "single", required: true, count: 1}};
  const {sourceActor, game, intent} = syntheticRuntimeFixture(t, definition, {targetHealth: 30});
  const [caster, stranger] = ["caster", "stranger"].map(id => withFoundryActorSystem(fakeActor(id, {system: actorSystem(),
    owners: (id === "caster") ? ["player-a"] : []})));
  const resolve = globalThis.fromUuid;
  globalThis.fromUuid = async ref => [caster, stranger].find(actor => actor.uuid === ref) ?? resolve(ref);
  sourceActor.system.companion = {kind: "summon", controllers: [caster.uuid]};
  const turnOf = actor => ({id: "combat-1", started: true, round: 1, turn: 0, combatant: {actor}, combatants: []});
  game.combat = turnOf(caster);
  const sent = async () => (await foundryActionIntentToStagedOptions({intent, senderUserId: "player-a", game})).ok;
  assert.equal(await sent(), false, "its caster has not moved yet");
  caster.system.resources.movement.spent = 10;
  assert.equal(await sent(), true, "its caster has moved on its own turn");
  game.combat = turnOf(stranger);
  assert.equal(await sent(), false, "not on another creature's turn");
  game.combat = turnOf(caster);
  sourceActor.system.companion.controllers = [stranger.uuid];
  const unowned = await foundryActionIntentToStagedOptions({intent, senderUserId: "player-a", game});
  assert.deepEqual([unowned.ok, unowned.code], [false, MULTIPLAYER_AUTHORITY_CODES.WRONG_USER], "only its controller takes it");
});

/** A vehicle's Claw: no cost of its own (it has no turn); its crew member's Action, while that creature is aboard as crew. */
function crewFixture(t, {roles=["passenger", "crew"]}={}) {
  const definition = {schemaVersion: 1, id: "action:vehicle-claw", label: "Claw", costs: {allOf: []},
    controllerCosts: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]},
    requires: {equals: {path: "aboard.crew", value: true}},
    range: {type: "reach", distance: {value: 5, unit: "ft"}}, targeting: {type: "single", required: true, count: 1},
    damage: [{id: "claw", expression: {type: "constant", value: 7}, damageType: "bludgeoning", provenance: "weapon-base"}]};
  const fixture = syntheticRuntimeFixture(t, definition, {targetHealth: 30});
  const [guest, pilot] = ["guest", "pilot"].map(id => withFoundryActorSystem(fakeActor(id, {system: actorSystem()})));
  fixture.sourceActor.system.aboard = roles.map((role, index) => ({actorUuid: [guest, pilot][index].uuid, role}));
  const resolve = globalThis.fromUuid;
  globalThis.fromUuid = async ref => [guest, pilot].find(actor => actor.uuid === ref) ?? resolve(ref);
  const hub = createTestResolutionTransportHub({users: [{id: "gm-a", active: true, isGM: true, isActiveGM: true},
    {id: "player-a", active: true, isGM: false}]});
  const gm = createMultiplayerActionCoordinator({userId: "gm-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}), actionIntentResolver: ({intent, envelope}) => foundryActionIntentToStagedOptions({intent,
      senderUserId: envelope.senderUserId, game: fixture.game, persistencePort: createTestDocumentPersistenceAdapter()})});
  const player = createMultiplayerActionCoordinator({userId: "player-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "player-a"})});
  gm.register();
  player.register();
  return {...fixture, guest, pilot, gm, player};
}

test("a vehicle's Action is used by a creature aboard as crew, at that creature's Action; a passenger can't", async t => {
  const {sourceActor, targetActor, guest, pilot, game, intent, gm, player} = crewFixture(t);
  const declared = await player.declareActionIntent(intent);
  const state = gm.getRecord(declared.resolutionId).state;
  assert.equal(state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(state.errors));
  assert.equal(targetActor.system.resources.health.value, 23);
  assert.deepEqual([pilot.system.resources.action.value, guest.system.resources.action.value, sourceActor.system.resources.action.value],
    [0, 1, 1], "the crew member it found among those the sender owns pays; the passenger and the vehicle don't");
  const named = await foundryActionIntentToStagedOptions({intent: {...intent, controllerRef: guest.uuid}, senderUserId: "player-a", game});
  assert.deepEqual([named.ok, named.code], [false, MULTIPLAYER_AUTHORITY_CODES.ACTION_REFUSED], "a passenger named from its own bar");
  const {game: passengers, intent: alone} = crewFixture(t, {roles: ["passenger", "passenger"]});
  const refused = await foundryActionIntentToStagedOptions({intent: alone, senderUserId: "player-a", game: passengers});
  assert.deepEqual([refused.ok, refused.code], [false, MULTIPLAYER_AUTHORITY_CODES.ACTION_REFUSED], "no crew aboard");
});

test("an Action's `requires` reads where its user's Token stands: its light (Shadow Stealth) and its place's tags", async t => {
  const dark = syntheticRuntimeFixture(t, {...meleeStrikeDefinition(), requires: {not: {equals: {path: "inBrightLight", value: true}}}});
  const lit = await foundryActionIntentToStagedOptions({intent: dark.intent, senderUserId: "player-a", game: dark.game});
  assert.deepEqual([lit.ok, lit.code], [false, MULTIPLAYER_AUTHORITY_CODES.ACTION_REFUSED], "a Scene without Token vision is all Bright Light");
  dark.scene.tokenVision = true;
  const unlit = await foundryActionIntentToStagedOptions({intent: dark.intent, senderUserId: "player-a", game: dark.game});
  assert.equal(unlit.ok, true, "no global light and no light: dim light or darkness");
  const wet = syntheticRuntimeFixture(t, {...meleeStrikeDefinition(), requires: {equals: {path: "environment.water", value: true}}});
  const dry = await foundryActionIntentToStagedOptions({intent: wet.intent, senderUserId: "player-a", game: wet.game});
  assert.deepEqual([dry.ok, dry.code], [false, MULTIPLAYER_AUTHORITY_CODES.ACTION_REFUSED]);
  wet.scene.flags = {wildpath: {environment: {water: true}}};
  const underwater = await foundryActionIntentToStagedOptions({intent: wet.intent, senderUserId: "player-a", game: wet.game});
  assert.equal(underwater.ok, true, "a Scene tagged water");

  // Nature's Mantle (Q59): where its Token is obscured at all (`obscured`), Heavily Obscured too (Q118 (a) default).
  const mantle = syntheticRuntimeFixture(t, {...meleeStrikeDefinition(), requires: {oneOf: {path: "obscured", values: ["lightly", "heavily"]}}});
  const use = async () => (await foundryActionIntentToStagedOptions({intent: mantle.intent, senderUserId: "player-a", game: mantle.game})).ok;
  assert.equal(await use(), false, "an untagged Scene without Token vision is all Bright Light (Q60)");
  mantle.scene.flags = {wildpath: {environment: {lightlyObscured: true}}};
  assert.equal(await use(), true, "fog the GM tags is Lightly Obscured, even in Bright Light");
  mantle.scene.flags = {};
  mantle.scene.tokenVision = true;
  assert.equal(await use(), true, "darkness is Heavily Obscured");

  // 2024 Hide (Q118 (b) default): only while Heavily Obscured, or behind Three-Quarters or Total Cover from every foe.
  const {commonAction} = await import("../module/helpers/common-actions.mjs");
  const hide = syntheticRuntimeFixture(t, {...meleeStrikeDefinition(), requires: commonAction({}, "hide").system.definition.requires});
  const hides = async () => (await foundryActionIntentToStagedOptions({intent: hide.intent, senderUserId: "player-a", game: hide.game})).ok;
  assert.equal(await hides(), true, "no foe on the Scene sees it");
  hide.scene.tokens.push(fakeTokenDocument({id: "foe-token", actor: fakeActor("foe", {system: actorSystem()}), scene: hide.scene,
    offset: {i: 0, j: 1}, disposition: 1}));
  assert.equal(await hides(), false, "a foe beside it in Bright Light, with no cover");
  hide.scene.walls = [{c: [-1000, 50, 1000, 50], sight: 20}];
  assert.equal(await hides(), true, "a wall that blocks sight between them: Total Cover");
  hide.scene.walls = [];
  hide.scene.tokenVision = true;
  assert.equal(await hides(), true, "in darkness, Heavily Obscured");
});

test("the authority refuses what a magic item's binding carries while no binding of its key gives its benefits (Q43)", async t => {
  const f = syntheticRuntimeFixture(t, {...meleeStrikeDefinition(), requires: {equals: {path: "enchantments.luck-blade", value: true}}});
  const unbound = await foundryActionIntentToStagedOptions({intent: f.intent, senderUserId: "player-a", game: f.game});
  assert.deepEqual([unbound.ok, unbound.code], [false, MULTIPLAYER_AUTHORITY_CODES.ACTION_REFUSED]);
  // A Foundry Collection lists its documents, not [id, document] pairs.
  const binding = {flags: {wildpath: {enchantment: {key: "luck-blade", attunement: "required"}}}, disabled: false, isSuppressed: true};
  const longsword = {id: "longsword", type: "action", system: {active: true}, effects: [binding]};
  f.sourceActor.items = new (class extends Map { [Symbol.iterator]() { return this.values(); } })([[f.action.id, f.action], [longsword.id, longsword]]);
  const unattuned = await foundryActionIntentToStagedOptions({intent: f.intent, senderUserId: "player-a", game: f.game});
  assert.deepEqual([unattuned.ok, unattuned.code], [false, MULTIPLAYER_AUTHORITY_CODES.ACTION_REFUSED], "bound but not attuned");
  binding.isSuppressed = false;
  const attuned = await foundryActionIntentToStagedOptions({intent: f.intent, senderUserId: "player-a", game: f.game});
  assert.equal(attuned.ok, true);
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

test("creatures on different planes can't target each other (an ethereal one, a homebrew plane); two ethereal ones can", async t => {
  const strike = syntheticRuntimeFixture(t, meleeStrikeDefinition());
  strike.targetActor.statuses = new Set(["ethereal"]);
  const refused = await foundryActionIntentToStagedOptions({intent: strike.intent, senderUserId: "player-a", game: strike.game});
  assert.equal(refused.code, MULTIPLAYER_AUTHORITY_CODES.ACTION_REFUSED);
  assert.match(refused.reason, /REFUSAL.OtherPlane|different planes/);
  strike.sourceActor.statuses = new Set(["ethereal"]);
  const both = await foundryActionIntentToStagedOptions({intent: strike.intent, senderUserId: "player-a", game: strike.game});
  assert.equal(both.ok, true, JSON.stringify(both.reason));
  // A homebrew status's plane is another one: neither ethereal nor the world (the old ethereal-or-not check let it through).
  WILDPATH.CONDITIONS.shadowed = {id: "shadowed", plane: "shadow", ruleElements: []};
  t.after(() => { delete WILDPATH.CONDITIONS.shadowed; });
  strike.targetActor.statuses = new Set(["shadowed"]);
  const shadow = await foundryActionIntentToStagedOptions({intent: strike.intent, senderUserId: "player-a", game: strike.game});
  assert.match(shadow.reason, /REFUSAL.OtherPlane|different planes/);
  strike.sourceActor.statuses = new Set();
  const world = await foundryActionIntentToStagedOptions({intent: strike.intent, senderUserId: "player-a", game: strike.game});
  assert.match(world.reason, /REFUSAL.OtherPlane|different planes/, "the world creature and the shadowed one");
});

test("an Action reaching a creature its source holds with a plane status (sourceCondition: trapped) is not refused for the plane", async t => {
  // A mirror's Free: only its own prisoner, held away from the scene on the plane "removed".
  const trapped = sourceRef => ({id: "cell", statuses: new Set(["trapped"]), flags: {wildpath: {conditionEffect: {sourceRef}}}});
  const holding = () => {
    const fixture = syntheticRuntimeFixture(t, {schemaVersion: 1, id: "action:free", label: "Free", costs: {allOf: []},
      targeting: {type: "single", required: true, count: 1, sourceCondition: "trapped"},
      effects: [{id: "freed", type: "condition", conditionId: "trapped", levels: -1}]});
    fixture.targetActor.statuses = new Set(["trapped"]);
    fixture.targetActor.effects = [trapped(fixture.sourceActor.uuid)];
    return fixture;
  };
  const free = holding();
  const own = await foundryActionIntentToStagedOptions({intent: free.intent, senderUserId: "player-a", game: free.game});
  assert.equal(own.ok, true, JSON.stringify(own.reason));
  // Another mirror's prisoner: not held by this one, so still on another plane from it.
  free.targetActor.effects = [trapped("Actor.another-mirror")];
  const other = await foundryActionIntentToStagedOptions({intent: free.intent, senderUserId: "player-a", game: free.game});
  assert.match(other.reason, /REFUSAL.OtherPlane|different planes/);
  const otherAutomatic = await foundryActionIntentToStagedOptions({intent: free.intent, senderUserId: "player-a", game: free.game, action: free.action});
  assert.deepEqual(otherAutomatic.options.targets, [], "an automatic Action leaves it out");
  // An Action without the key, or one naming a status with no plane, still can't reach it.
  const strike = syntheticRuntimeFixture(t, meleeStrikeDefinition());
  strike.targetActor.statuses = new Set(["trapped"]);
  strike.targetActor.effects = [trapped(strike.sourceActor.uuid)];
  assert.match((await foundryActionIntentToStagedOptions({intent: strike.intent, senderUserId: "player-a", game: strike.game})).reason,
    /REFUSAL.OtherPlane|different planes/);
  const grab = syntheticRuntimeFixture(t, {schemaVersion: 1, id: "action:reel", label: "Reel", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1, sourceCondition: "grappled"}});
  grab.targetActor.statuses = new Set(["trapped", "grappled"]);
  grab.targetActor.effects = [{...trapped(grab.sourceActor.uuid), statuses: new Set(["trapped", "grappled"])}];
  assert.match((await foundryActionIntentToStagedOptions({intent: grab.intent, senderUserId: "player-a", game: grab.game})).reason,
    /REFUSAL.OtherPlane|different planes/);
  // A wall now between the mirror and where its own prisoner was caught: still reached, with no cover; by the authority
  // too (a broken mirror frees everyone in it), where an automatic Action leaves out a creature on another plane.
  const walledFree = holding();
  walled(t, walledFree.scene);
  const behind = await foundryActionIntentToStagedOptions({intent: walledFree.intent, senderUserId: "player-a", game: walledFree.game});
  assert.deepEqual([behind.ok, behind.options?.context?.cover ?? []], [true, []], JSON.stringify(behind.reason));
  const automatic = await foundryActionIntentToStagedOptions({intent: walledFree.intent, senderUserId: "player-a", game: walledFree.game,
    action: walledFree.action});
  assert.deepEqual(automatic.options.targets.map(target => target.tokenId), ["target-token"]);
});

test("a target's cover reaches its card only where it changed a roll: an attack's AC or a Dexterity save's bonus", async t => {
  // Live 2026-11-14: "Half cover" showed on a Wisdom save and on damage alone.
  const coverOf = async definition => {
    const fixture = syntheticRuntimeFixture(t, definition);
    fixture.targetActor.statuses = new Set(["coverHalf"]);
    const resolved = await foundryActionIntentToStagedOptions({intent: fixture.intent, senderUserId: "player-a", game: fixture.game});
    assert.equal(resolved.ok, true, JSON.stringify(resolved.reason));
    return [(resolved.options.context.cover ?? []).map(entry => entry.degree), resolved.options.save?.modifiersByTarget?.["target-token"] ?? 0];
  };
  const {save: _save, ...damageOnly} = fortitudeBlast("agility");
  assert.deepEqual([await coverOf(meleeStrikeDefinition()), await coverOf(fortitudeBlast("agility")), await coverOf(fortitudeBlast("wits")),
    await coverOf(damageOnly)], [[["half"], 0], [["half"], 2], [[], 0], [[], 0]], "an attack, a Dexterity save, a Wisdom save, damage alone");
});

test("an Action's own cover.ignored (Sacred Flame's save) leaves out Half and Three-Quarters Cover, its chip too; Total Cover stays", async t => {
  // Live 9: Sacred Flame's target still got +2 and the cover chip.
  const fixture = syntheticRuntimeFixture(t, fortitudeBlast("agility"));
  // Its own rule counts for that Action alone (the Action Item's Modifiers: actor.getStatistic's `item`).
  fixture.sourceActor.getStatistic = (domain, {item=null}={}) => (((domain === "cover.ignored") && (item === fixture.action))
    ? {totalModifier: 2} : null);
  const resolve = statuses => {
    fixture.targetActor.statuses = new Set(statuses);
    return foundryActionIntentToStagedOptions({intent: fixture.intent, senderUserId: "player-a", game: fixture.game});
  };
  const covered = resolved => [(resolved.options.context.cover ?? []).map(entry => entry.degree),
    resolved.options.save?.modifiersByTarget?.["target-token"] ?? 0];
  assert.deepEqual([covered(await resolve(["coverHalf"])), covered(await resolve(["coverThreeQuarters"]))], [[[], 0], [[], 0]]);
  assert.equal((await resolve(["coverTotal"])).ok, false, "Total Cover still keeps it from being targeted");
  fixture.targetActor.statuses = new Set(["coverThreeQuarters"]);
  assert.equal(actionCover({definition: fortitudeBlast("agility"), sourceToken: fixture.sourceToken, targetToken: fixture.targetToken}),
    "threeQuarters", "another Action of its creature keeps the cover");
});

test("a creature in Gaseous Form can't attack or cast spells; it can still Dash", async t => {
  const strike = syntheticRuntimeFixture(t);
  strike.sourceActor.statuses = new Set(["gaseous"]);
  const refused = await foundryActionIntentToStagedOptions({intent: strike.intent, senderUserId: "player-a", game: strike.game});
  assert.equal(refused.code, MULTIPLAYER_AUTHORITY_CODES.ACTION_REFUSED);
  assert.match(refused.reason, /REFUSAL.Gaseous|can.t attack or cast/);
  const dash = syntheticRuntimeFixture(t, {schemaVersion: 1, id: "common:dash", label: "Dash", costs: {allOf: []}, targeting: {type: "self"}});
  dash.sourceActor.statuses = new Set(["gaseous"]);
  const dashed = await foundryActionIntentToStagedOptions({intent: dash.intent, senderUserId: "player-a", game: dash.game});
  assert.notEqual(dashed.code, MULTIPLAYER_AUTHORITY_CODES.ACTION_REFUSED, JSON.stringify(dashed.reason));
});

test("a transformed creature can't cast spells, but its other Actions still resolve (2024 Wild Shape)", async t => {
  const spell = syntheticRuntimeFixture(t, {...meleeStrikeDefinition(), tags: ["spell"]});
  spell.sourceActor.transformation = {effect: {}, policy: {formRef: "Actor.bear"}};
  const refused = await foundryActionIntentToStagedOptions({intent: spell.intent, senderUserId: "player-a", game: spell.game});
  assert.equal(refused.code, MULTIPLAYER_AUTHORITY_CODES.ACTION_REFUSED);
  assert.match(refused.reason, /REFUSAL.Transformed|can.t cast spells/);
  spell.sourceActor.transformation = null;
  const caster = await foundryActionIntentToStagedOptions({intent: spell.intent, senderUserId: "player-a", game: spell.game});
  assert.equal(caster.ok, true, JSON.stringify(caster.reason));

  const strike = syntheticRuntimeFixture(t);
  strike.sourceActor.transformation = {effect: {}, policy: {formRef: "Actor.bear"}};
  const bite = await foundryActionIntentToStagedOptions({intent: strike.intent, senderUserId: "player-a", game: strike.game});
  assert.equal(bite.ok, true, JSON.stringify(bite.reason));
});

test("Shapechange: a form above its user's level is refused before anything is paid; one within it is not", async t => {
  const shapechange = form => ({schemaVersion: 1, id: "action:shapechange", label: "Shapechange", tags: ["spell"],
    costs: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]}, range: {type: "self"}, targeting: {type: "self"},
    transform: {formRef: form, limits: {challenge: "self"}, keepsSpellcasting: true}});
  const forms = {"Actor.mammoth": {name: "Mammoth", system: {details: {threat: 6}}}, "Actor.crocodile": {name: "Giant Crocodile", system: {details: {threat: 5}}}};
  for ( const [form, refused] of [["Actor.mammoth", true], ["Actor.crocodile", false]] ) {
    const fixture = syntheticRuntimeFixture(t, shapechange(form));
    fixture.sourceActor.system.details = {level: 5};
    const resolve = globalThis.fromUuid;
    globalThis.fromUuid = async ref => forms[ref] ?? resolve(ref);
    const staged = await foundryActionIntentToStagedOptions({intent: fixture.intent, senderUserId: "player-a", game: fixture.game});
    globalThis.fromUuid = resolve;
    if ( refused ) {
      assert.equal(staged.code, MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED);
      assert.match(staged.reason, /BeyondChallenge|beyond level or CR 5/);
      assert.equal(fixture.sourceActor.system.resources.action.value, 1, "nothing paid");
    } else assert.equal(staged.ok, true, JSON.stringify(staged.reason));
  }
});

test("an effect's Forbid (Spell Taxed) refuses its creature's spells, saying which effect; its attacks still resolve", async t => {
  const taxed = {name: "Spell Taxed", disabled: false, isSuppressed: false, system: {ruleElements: [{schemaVersion: 1, id: "taxed",
    type: "Forbid", data: {actions: {tagsAny: ["spell"]}}}]}};
  const spell = syntheticRuntimeFixture(t, {...meleeStrikeDefinition(), tags: ["spell"]});
  spell.sourceActor.effects = [taxed];
  const refused = await foundryActionIntentToStagedOptions({intent: spell.intent, senderUserId: "player-a", game: spell.game});
  assert.equal(refused.code, MULTIPLAYER_AUTHORITY_CODES.ACTION_REFUSED);
  assert.match(refused.reason, /REFUSAL.Forbidden|Spell Taxed/);
  const strike = syntheticRuntimeFixture(t);
  strike.sourceActor.effects = [taxed];
  const struck = await foundryActionIntentToStagedOptions({intent: strike.intent, senderUserId: "player-a", game: strike.game});
  assert.equal(struck.ok, true, JSON.stringify(struck.reason));
});

test("a save knows what it is against: a target's \"Advantage on saves against Poisoned\" applies to a poisoning save only", async t => {
  const sting = condition => ({schemaVersion: 1, id: "action:sting", label: "Sting", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1}, save: {ability: "fortitude", dc: {value: 12}},
    effects: [{id: "effect-1", type: "condition", conditionId: condition, saveOutcomePolicy: "failure"}]});
  const modeAgainst = async condition => {
    const fixture = syntheticRuntimeFixture(t, sting(condition));
    // Dwarven Resilience, Antitoxin: a RollMode on the `against:poisoned` tag, read by the real Actor method.
    fixture.targetActor.getRollModes = WildPathActor.prototype.getRollModes;
    fixture.targetActor.auraOwners = () => [];
    fixture.targetActor.effects = [{name: "Antitoxin", disabled: false, isSuppressed: false, system: {ruleElements: [{schemaVersion: 1,
      id: "antitoxin", type: "RollMode", predicate: {tagsAny: ["against:poisoned"]}, data: {domains: ["save"], mode: "advantage"}}]}}];
    const built = await foundryActionIntentToStagedOptions({intent: fixture.intent, senderUserId: "player-a", game: fixture.game});
    assert.equal(built.ok, true, JSON.stringify(built.reason));
    return Object.values(built.options.save.rollModesByTarget)[0];
  };
  assert.equal(await modeAgainst("poisoned"), "advantage");
  assert.equal(await modeAgainst("frightened"), "normal", "a save against something else");
});

test("Dispel Magic takes a creature or a lasting spell area within its range, never both and never neither", async t => {
  const dispel = range => ({schemaVersion: 1, id: "action:dispel", label: "Dispel Magic", tags: ["spell"], costs: {allOf: []},
    range: {type: "ranged", normal: {value: range, unit: "ft"}}, targeting: {type: "single", required: false, count: 1},
    ends: {spells: "slot", areas: true}});
  const use = async (range, changes) => {
    const fixture = syntheticRuntimeFixture(t, dispel(range));
    // A lasting Web on the target's space (5 ft away), cast at level 2; a lasting area of no known level beside it.
    const {footprint} = createFoundryV14TacticalGridAdapter({scene: fixture.scene}).tokenToFootprint(fixture.targetToken);
    const area = (id, castLevel) => ({id, flags: {wildpath: {area: {label: id, castLevel, topology: footprint.topology, fields: footprint.fields,
      attached: false, band: {bottom: null, top: null}}}}});
    fixture.scene.regions = [area("web", 2), area("cloud", null)];
    return foundryActionIntentToStagedOptions({intent: {...fixture.intent, ...changes}, senderUserId: "player-a", game: fixture.game});
  };
  const none = {targetRefs: [], targets: []};
  // A spell on an object (2024 RAW): Magic Weapon on the target's sword, 5 ft away; an enchantment of no spell level beside it.
  const enchanted = async (range, effectUuid, extra={}) => {
    const fixture = syntheticRuntimeFixture(t, dispel(range));
    fixture.scene.regions = [];
    fixture.targetActor.items = [{id: "sword", name: "Longsword", effects: [
      {uuid: "Actor.target.Item.sword.ActiveEffect.magic", name: "Magic Weapon", flags: {wildpath: {enchantment: {key: "magic-weapon", spellLevel: 2}}}},
      {uuid: "Actor.target.Item.sword.ActiveEffect.infused", name: "Enhanced Weapon", flags: {wildpath: {enchantment: {key: "infusion"}}}}]}];
    return foundryActionIntentToStagedOptions({intent: {...fixture.intent, ...none, dispelObject: {effectUuid}, ...extra},
      senderUserId: "player-a", game: fixture.game});
  };
  const sword = await enchanted(120, "Actor.target.Item.sword.ActiveEffect.magic");
  assert.equal(sword.ok, true, JSON.stringify(sword.reason));
  assert.deepEqual(sword.options.dispelObject, {effectUuid: "Actor.target.Item.sword.ActiveEffect.magic"});
  assert.match((await enchanted(0, "Actor.target.Item.sword.ActiveEffect.magic")).reason, /DISPEL.OutOfRange|out of range/);
  assert.match((await enchanted(120, "Actor.target.Item.sword.ActiveEffect.infused")).reason, /DISPEL.OutOfRange|out of range/,
    "an enchantment that is no spell");
  const chosen = await use(120, {...none, dispelArea: {regionId: "web"}});
  assert.equal(chosen.ok, true, JSON.stringify(chosen.reason));
  assert.deepEqual(chosen.options.dispelArea, {sceneId: "scene-models", regionId: "web"});
  assert.match((await use(0, {...none, dispelArea: {regionId: "web"}})).reason, /DISPEL.OutOfRange|out of range/, "beyond its range");
  assert.match((await use(120, {...none, dispelArea: {regionId: "cloud"}})).reason, /DISPEL.OutOfRange|out of range/,
    "an area of no known spell level is not a spell to dispel");
  assert.match((await use(120, {dispelArea: {regionId: "web"}})).reason, /DISPEL.OneTarget|one target/, "a creature and an area");
  assert.match((await use(120, none)).reason, /DISPEL.NoTarget|Target a creature/, "neither");
  const creature = await use(120, {});
  assert.equal(creature.ok, true, "a targeted creature, as before");
  assert.equal(creature.options.dispelArea, undefined);
  // Found live: the transport only passes intent fields it knows; the Region id crosses it, and nothing else of it.
  assert.deepEqual(sanitizeActionIntentPayload({intent: {dispelArea: {regionId: "web", sceneId: "elsewhere"}}}).dispelArea, {regionId: "web"});
  assert.equal(sanitizeActionIntentPayload({intent: {dispelArea: {regionId: 7}}}).dispelArea, undefined);
  assert.deepEqual(sanitizeActionIntentPayload({intent: {dispelObject: {effectUuid: "Actor.a.Item.b.ActiveEffect.c", item: "x"}}}).dispelObject,
    {effectUuid: "Actor.a.Item.b.ActiveEffect.c"});
});

test("a weapon attack adds the attacker's Might to the attack and its damage; a spell attack's damage adds nothing", async t => {
  const weapon = syntheticRuntimeFixture(t);
  weapon.sourceActor.system.abilities = {might: {value: 16}};
  const built = await foundryActionIntentToStagedOptions({intent: weapon.intent, senderUserId: "player-a", game: weapon.game});
  assert.equal(built.ok, true, JSON.stringify(built.reason));
  assert.equal(built.options.attack.modifierTotal, 7, "the weapon statistic's 4 plus Might's 3");
  assert.deepEqual(built.options.damage, {modifierTotal: 3});

  const spell = syntheticRuntimeFixture(t, {...meleeStrikeDefinition(), tags: ["spell"]});
  spell.sourceActor.system.abilities = {might: {value: 16}, wits: {value: 14}};
  spell.sourceActor.system.spellcasting = {ability: "wits"};
  const cast = await foundryActionIntentToStagedOptions({intent: spell.intent, senderUserId: "player-a", game: spell.game});
  assert.equal(cast.options.attack.modifierTotal, 6, "the statistic's 4 plus the spellcasting ability's 2");
  assert.equal(cast.options.damage, undefined);
});

test("a self-targeted Action targets its own creature whatever the Player has targeted; a no-target Action targets nobody", async t => {
  const self = syntheticRuntimeFixture(t, {...meleeStrikeDefinition(), attack: null, damage: [], targeting: {type: "self"}});
  const built = await foundryActionIntentToStagedOptions({intent: self.intent, senderUserId: "player-a", game: self.game});
  assert.equal(built.ok, true, JSON.stringify(built.reason));
  assert.ok(self.intent.targetRefs?.length, "the Player had the other creature targeted");
  assert.deepEqual(built.options.targets.map(entry => entry.actorRef), [self.sourceActor.uuid]);

  const none = syntheticRuntimeFixture(t, {...meleeStrikeDefinition(), attack: null, damage: [], targeting: {type: "none"}});
  const nobody = await foundryActionIntentToStagedOptions({intent: none.intent, senderUserId: "player-a", game: none.game});
  assert.deepEqual(nobody.options.targets, []);
});

test("an aura grants its rules to allies within its radius and to its bearer, but not to enemies or allies further away", async () => {
  const {createFoundryAuras} = await import("../module/adapters/foundry-v14-auras.mjs");
  const {evaluateRuleElement} = await import("../module/helpers/rule-elements.mjs");
  const ward = {schemaVersion: 1, id: "ward", type: "Modifier", data: {domains: ["defense.ac"], value: 1}};
  const aura = {schemaVersion: 1, id: "protection", type: "Aura", data: {radius: 10, affects: "allies", ruleElements: [ward]}};
  assert.equal(evaluateRuleElement(aura).ok, true);
  assert.equal(evaluateRuleElement({...aura, data: {...aura.data, radius: 0}}).ok, false, "a radius is required");
  assert.equal(evaluateRuleElement({...aura, data: {...aura.data, ruleElements: [{schemaVersion: 1, id: "x", type: "Nope"}]}}).ok, false);

  const scene = fakeScene(new FakeSquareGrid(), {id: "aura-scene"});
  const creature = (id, offset, disposition, auras=[]) => {
    const actor = {id, isToken: true, getAuras: () => auras};
    actor.token = fakeTokenDocument({id: `token-${id}`, actor, scene, offset, disposition});
    scene.tokens.push(actor.token);
    return actor;
  };
  const paladin = creature("paladin", {i: 5, j: 5}, 1, evaluateRuleElement(aura).result?.contributions?.auras
    ?? [{id: "protection", radius: 10, affects: "allies", ruleElements: [ward]}]);
  const near = creature("near", {i: 7, j: 5}, 1);
  const far = creature("far", {i: 8, j: 5}, 1);
  const enemy = creature("enemy", {i: 6, j: 5}, -1);
  const auras = createFoundryAuras();
  const granted = actor => auras.ownersFor(actor).flatMap(owner => owner.ruleElements.map(rule => rule.id));
  assert.deepEqual(granted(near), ["ward"], "an ally 10 ft away");
  assert.deepEqual(granted(paladin), ["ward"], "the bearer itself");
  assert.deepEqual(granted(far), [], "an ally 15 ft away");
  assert.deepEqual(granted(enemy), [], "an enemy inside the aura");
  // A creature on another plane (planeOf) is out of reach: no aura across it, and no ally by the target across it.
  const ghost = creature("ghost", {i: 6, j: 6}, 1);
  ghost.statuses = new Set(["ethereal"]);
  assert.deepEqual(granted(ghost), [], "an Ethereal ally inside the aura");
  const {allyNearTarget} = await import("../module/adapters/foundry-v14-auras.mjs");
  assert.equal(allyNearTarget(near.token, enemy.token), true, "the paladin stands by the enemy");
  paladin.statuses = new Set(["ethereal"]);
  assert.equal(allyNearTarget(near.token, enemy.token), false, "not once it is Ethereal");
  assert.deepEqual(granted(near), [], "nor does its aura reach the world");
  assert.deepEqual(granted(ghost), ["ward"], "it reaches an Ethereal ally");
});

test("Rage of the Wilds' Wolf: an ally's attack on an enemy within 5 ft of the barbarian has Advantage, not the barbarian's own (Q120 (a))", async () => {
  const {createFoundryAuras, alliesOf} = await import("../module/adapters/foundry-v14-auras.mjs");
  const {evaluateRuleElement, rollModesFromRuleElements} = await import("../module/helpers/rule-elements.mjs");
  const {convertItem} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  const [eagle] = convertItem({_id: "ragewilds0000002", name: "Rage of the Wilds", type: "feat", img: "icons/svg/walk.svg", effects: [],
    system: {source: {license: "CC-BY-4.0", rules: "2024", book: ""}, identifier: "rage-of-the-wilds", activation: {type: "bonus"}, range: {},
      target: {affects: {}, template: {}}, description: {value: "<p><strong>Eagle.</strong> While your Rage is active, you can take a Bonus "
        + "Action to take both of those actions.</p>"}, activities: {a: {_id: "actEagle", type: "utility", name: "Eagle",
        activation: {type: "bonus", override: false}, range: {override: false}, target: {affects: {}, template: {}}, effects: [],
        consumption: {targets: []}}}}}).items;
  const wolf = eagle.flags.wildpath.choiceFor.choice.options.find(option => option.value === "wolf").effects[0].ruleElements[0];
  const scene = fakeScene(new FakeSquareGrid(), {id: "wolf-scene"});
  const creature = (id, offset, disposition, auras=[]) => {
    const actor = {id, isToken: true, getAuras: () => auras};
    actor.token = fakeTokenDocument({id: `token-${id}`, actor, scene, offset, disposition});
    scene.tokens.push(actor.token);
    return actor;
  };
  const barbarian = creature("barbarian", {i: 5, j: 5}, 1, evaluateRuleElement(wolf).contributions.auras);
  const ally = creature("ally", {i: 9, j: 9}, 1);
  const enemy = creature("enemy", {i: 6, j: 5}, -1);
  const farEnemy = creature("far-enemy", {i: 8, j: 5}, -1);
  const otherEnemy = creature("other-enemy", {i: 7, j: 7}, -1);
  const auras = createFoundryAuras();
  const modes = (attacker, target) => rollModesFromRuleElements(auras.ownersFor(target), {domains: ["attacked"],
    context: {attack: {attackerAllies: alliesOf(attacker.token)}}}).map(entry => entry.mode);
  assert.deepEqual(modes(ally, enemy), ["advantage"], "an ally anywhere, against an enemy beside the barbarian");
  assert.deepEqual(modes(barbarian, enemy), [], "never the barbarian's own attack");
  assert.deepEqual(modes(otherEnemy, enemy), [], "nor an enemy's");
  assert.deepEqual(modes(ally, farEnemy), [], "nor against an enemy 15 ft from the barbarian");
  assert.deepEqual(alliesOf(barbarian.token), ["token-ally"]);
  // A second Wolf barbarian beside the same enemy: each bearer's copy is kept, so each barbarian's attack has the other's
  // Wolf (one copy, the lower Token id's, used to be kept, and the first barbarian lost it).
  const second = creature("barbarian-2", {i: 6, j: 4}, 1, evaluateRuleElement(wolf).contributions.auras);
  assert.deepEqual([modes(barbarian, enemy), modes(second, enemy)], [["advantage"], ["advantage"]], "each by the other's Wolf");
  assert.deepEqual(modes(ally, farEnemy), [], "still not against an enemy 15 ft from both");
});

test("a creature benefits from one copy of the same aura, the most potent, while different auras stack", async () => {
  const {createFoundryAuras} = await import("../module/adapters/foundry-v14-auras.mjs");
  const scene = fakeScene(new FakeSquareGrid(), {id: "aura-copies-scene"});
  const creature = (id, offset, auras=[], disposition=1) => {
    const actor = {id, isToken: true, getAuras: () => auras};
    actor.token = fakeTokenDocument({id: `token-${id}`, actor, scene, offset, disposition});
    scene.tokens.push(actor.token);
    return actor;
  };
  const feature = name => ({type: "ruleElement", ruleElementId: "rule-1", ruleElementType: "Aura", parent: {type: "item", name}});
  const protection = value => ({id: "aura-of-protection", radius: 10, affects: "allies", source: feature("Aura of Protection"),
    ruleElements: [{schemaVersion: 1, id: `protection-${value}`, type: "Modifier", data: {domains: ["save"], value}}]});
  const courage = {id: "aura-of-courage", radius: 10, affects: "allies", source: feature("Aura of Courage"),
    ruleElements: [{schemaVersion: 1, id: "courage", type: "ConditionImmunity", data: {conditions: ["frightened"]}}]};
  // Homebrew built in the sheet: its rule id repeats ("rule-1"), its feature's name does not.
  const warding = {id: "rule-1", radius: 10, affects: "allies", source: feature("Warding Hum"),
    ruleElements: [{schemaVersion: 1, id: "hum", type: "Modifier", data: {domains: ["defense.ac"], value: 1}}]};
  const glow = {id: "rule-1", radius: 10, affects: "allies", source: feature("Soft Glow"),
    ruleElements: [{schemaVersion: 1, id: "glow", type: "Modifier", data: {domains: ["defense.ac"], value: 1}}]};
  const dread = value => ({id: "dread", radius: 10, affects: "enemies", source: feature("Dread Hum"),
    ruleElements: [{schemaVersion: 1, id: `dread${value}`, type: "Modifier", data: {domains: ["save"], value}}]});
  creature("paladin-b", {i: 5, j: 5}, [protection(2), courage, warding]);
  // The higher-id copy comes first in scene.tokens, so only the tie-break, not the order, keeps paladin-a's.
  creature("paladin-c", {i: 6, j: 6}, [protection(4)]);
  creature("paladin-a", {i: 7, j: 5}, [protection(4), glow]);
  creature("fiend-a", {i: 4, j: 5}, [dread(-1)], -1);
  creature("fiend-b", {i: 6, j: 4}, [dread(-3)], -1);
  const ally = creature("ally", {i: 6, j: 5});
  const granted = createFoundryAuras().ownersFor(ally);
  assert.deepEqual(granted.flatMap(owner => owner.ruleElements.map(rule => rule.id)).sort(),
    ["courage", "dread-3", "glow", "hum", "protection-4"],
    "one Aura of Protection, the higher; one enemy aura, the bigger penalty; the different auras all apply");
  assert.equal(granted.find(owner => owner.source.aura === "aura-of-protection").source.bearerTokenId, "token-paladin-a",
    "a tie keeps the lowest bearer Token id");
});

test("a bearerOnly aura grants its bearer alone, only while a creature it affects stands within its radius (Steadfast)", async () => {
  const {createFoundryAuras} = await import("../module/adapters/foundry-v14-auras.mjs");
  const {evaluateRuleElement} = await import("../module/helpers/rule-elements.mjs");
  const brave = {schemaVersion: 1, id: "brave", type: "ConditionImmunity", data: {conditions: ["frightened"]}};
  const rule = {schemaVersion: 1, id: "steadfast", type: "Aura", data: {radius: 30, affects: "allies", bearerOnly: true, ruleElements: [brave]}};
  const [contribution] = evaluateRuleElement(rule).contributions.auras;
  assert.equal(contribution.bearerOnly, true);
  const granted = (others) => {
    const scene = fakeScene(new FakeSquareGrid(), {id: "steadfast-scene"});
    const creature = (id, offset, disposition, auras=[]) => {
      const actor = {id, isToken: true, getAuras: () => auras};
      actor.token = fakeTokenDocument({id: `token-${id}`, actor, scene, offset, disposition});
      scene.tokens.push(actor.token);
      return actor;
    };
    const bearer = creature("bearer", {i: 5, j: 5}, 1, [contribution]);
    const placed = others.map(([id, offset, disposition]) => creature(id, offset, disposition));
    const auras = createFoundryAuras();
    const of = actor => auras.ownersFor(actor).flatMap(owner => owner.ruleElements.map(entry => entry.id));
    return [of(bearer), ...placed.map(of)];
  };
  assert.deepEqual(granted([["ally", {i: 7, j: 5}, 1]]), [["brave"], []], "an ally 10 ft away: the bearer only");
  assert.deepEqual(granted([]), [[]], "alone");
  assert.deepEqual(granted([["enemy", {i: 6, j: 5}, -1]]), [[], []], "only an enemy near");
  assert.deepEqual(granted([["far", {i: 12, j: 5}, 1]]), [[], []], "an ally 35 ft away");
});

test("a creature's conditions from another are the effects naming it, its Tokens or its Items as their source", () => {
  const charmer = {uuid: "Actor.charmer", id: "charmer"};
  const token = {uuid: "Scene.s.Token.t", id: "t", parent: {id: "s"}, actorLink: true, actorId: "charmer", actor: charmer};
  const game = {scenes: [{tokens: [token]}]};
  const effect = (statuses, flags={}, origin=null) => ({statuses: new Set(statuses), flags, origin});
  const holder = {effects: [
    effect(["charmed"], {wildpath: {conditionEffect: {sourceRef: "uuid:Actor.charmer.Item.gaze"}}}),
    effect(["grappled"], {wildpath: {conditionEffect: {sourceRef: "token:t"}}}),
    effect(["prone"], {}, "Actor.charmerling.Item.x"),
    effect(["frightened"], {}, "Actor.other.Item.roar")
  ]};
  assert.deepEqual(conditionsFrom(holder, charmer, game), {charmed: true, grappled: true});
  assert.deepEqual(conditionsFrom(holder, null, game), {});
});

test("the odds of an attack and of a save use the authority's own numbers, and show only to those who may see them", () => {
  const scene = fakeScene(new FakeSquareGrid(), {id: "scene-odds"});
  const attacker = withConditions(fakeActor("odds-source", {system: actorSystem(),
    statistics: {"attack.weapon": runtimeStatistic("attack.weapon", 4)}}));
  const target = withConditions(fakeActor("odds-target", {system: targetActorSystem(20, 20, {ac: 14}),
    statistics: {"save.might": runtimeStatistic("save.might", 3)}}), "prone");
  const sourceToken = fakeTokenDocument({id: "odds-source", actor: attacker, scene, offset: {i: 0, j: 0}});
  const targetToken = {...fakeTokenDocument({id: "odds-target", actor: target, scene, offset: {i: 1, j: 0}}), name: "Goblin"};
  attacker.tokens = [sourceToken];
  target.tokens = [targetToken];
  scene.tokens = [sourceToken, targetToken];
  const game = fakeGame({actors: [attacker, target], scenes: [scene]});
  const odds = (definition, user={isGM: true}) => foundryActionOdds({actor: attacker, action: actionItem(definition, attacker),
    sourceToken, targetTokens: [targetToken], user, game});

  const [hit] = odds(meleeStrikeDefinition());
  assert.deepEqual([hit.kind, hit.modifier, hit.defense, hit.rollMode], ["attack", 4, 14, "advantage"], "Prone within 5 ft: advantage");
  assert.equal(hit.chance.toFixed(4), "0.7975", "+4 against AC 14 is 55%, with advantage 79.75%");
  // Its Half cover raises the AC shown, as the attack is judged; the attack's own modifier is unchanged.
  target.statuses = new Set(["coverHalf"]);
  const [covered] = odds(meleeStrikeDefinition());
  assert.deepEqual([covered.modifier, covered.defense, covered.chance.toFixed(4)], [4, 16, "0.6975"], "+4 against AC 16: 45%, 69.75%");
  delete target.statuses;
  const [save] = odds(fortitudeBlast("might"));
  assert.deepEqual([save.kind, save.dc, save.modifier, save.chance.toFixed(2)], ["save", 13, 3, "0.45"], "+3 against DC 13 fails 45%");
  withConditions(target, "stunned");
  assert.deepEqual(odds(fortitudeBlast("might")).map(entry => [entry.automatic, entry.chance]), [[true, 1]]);

  assert.deepEqual(odds(meleeStrikeDefinition(), {isGM: false}), [], "players see no odds by default");
  target.effects = [{statuses: new Set(), flags: {wildpath: {conditionEffect: {sourceRef: `actor:${attacker.id}`}}},
    system: {ruleElements: [{schemaVersion: 1, id: "sized-up", type: "Reveal", data: {details: ["defenses"]}}]}}];
  assert.equal(odds(meleeStrikeDefinition(), {isGM: false}).length, 1, "unless the target reveals its defenses to the attacker");
  game.settings = {get: (scope, key) => key === "playersSeeOdds"};
  target.effects = [];
  assert.equal(odds(meleeStrikeDefinition(), {isGM: false}).length, 1, "or the house rule shows odds to players");
});

test("a save's own Advantage while its target fights the caster's side (Charm Person): the target loop and the odds agree", async () => {
  const scene = fakeScene(new FakeSquareGrid(), {id: "scene-fighting"});
  const caster = withConditions(fakeActor("fighting-source", {system: actorSystem()}));
  const target = withConditions(fakeActor("fighting-target", {system: targetActorSystem(20, 20, {ac: 14}),
    statistics: {"save.wits": runtimeStatistic("save.wits", 0)}}));
  const sourceToken = fakeTokenDocument({id: "fighting-source", actor: caster, scene, offset: {i: 0, j: 0}, disposition: 1});
  const targetToken = fakeTokenDocument({id: "fighting-target", actor: target, scene, offset: {i: 1, j: 0}});
  caster.tokens = [sourceToken];
  target.tokens = [targetToken];
  scene.tokens = [sourceToken, targetToken];
  scene.tokens.get = id => scene.tokens.find(token => token.id === id);
  const game = fakeGame({actors: [caster, target], scenes: [scene]});
  const charm = {...fortitudeBlast("wits"), id: "action:runtime-charm", save: {ability: "wits", dc: {value: 13}, rollModes: [{schemaVersion: 1,
    id: "fighting-advantage", type: "RollMode", data: {domains: ["save"], mode: "advantage"}, predicate: {equals: {path: "save.fighting", value: true}}}]}};
  const action = actionItem(charm, caster);
  const modes = async () => {
    const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a", game, intent: {actorRef: caster.uuid,
      actionRef: action.uuid, targetRefs: [{actorRef: target.uuid, tokenId: targetToken.id, sceneId: scene.id}]}});
    assert.equal(resolved.ok, true, resolved.reason);
    const planned = await planStagedActionResolution(resolved.options);
    return [planned.state.rollRequests[0].rollMode,
      foundryActionOdds({actor: caster, action, sourceToken, targetTokens: [targetToken], user: {isGM: true}, game})[0].rollMode];
  };
  assert.deepEqual(await modes(), ["normal", "normal"], "no combat");
  const fight = {started: true, round: 1, turn: 0, id: "fight", combatants: [{tokenId: "fighting-target", sceneId: scene.id}]};
  game.combats = [fight];
  assert.deepEqual(await modes(), ["advantage", "advantage"], "a Combatant of a started combat, hostile to the caster");
  // The authority's viewed combat is another Scene's: the saver's own combat still counts.
  game.combat = {started: true, round: 1, turn: 0, id: "elsewhere", combatants: []};
  game.combats = [game.combat, fight];
  assert.deepEqual(await modes(), ["advantage", "advantage"], "its own combat, not the viewed one");
  sourceToken.disposition = -1;
  assert.deepEqual(await modes(), ["normal", "normal"], "on the caster's side");
  sourceToken.disposition = 1;
  fight.combatants = [{tokenId: "fighting-target", sceneId: "another-scene"}];
  assert.deepEqual(await modes(), ["normal", "normal"], "a same-id Token of another Scene");
  fight.combatants = [];
  assert.deepEqual(await modes(), ["normal", "normal"], "not in the combat");
  fight.combatants = [{tokenId: "fighting-target", sceneId: scene.id}];
  fight.started = false;
  assert.deepEqual(await modes(), ["normal", "normal"], "the combat not started");
});

test("a save's own outcomes by its saver's creature type (save.rollOutcomes, the Vrock's \"demons succeed automatically\"): the target loop, the choice of save and the odds agree", async () => {
  const {bestSaveAbility} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const scene = fakeScene(new FakeSquareGrid(), {id: "scene-screech"});
  const vrock = withConditions(fakeActor("screech-source", {system: actorSystem()}));
  const target = withConditions(fakeActor("screech-target", {system: targetActorSystem(20, 20, {ac: 14}),
    statistics: {"save.fortitude": runtimeStatistic("save.fortitude", 0)}}));
  const sourceToken = fakeTokenDocument({id: "screech-source", actor: vrock, scene, offset: {i: 0, j: 0}});
  const targetToken = fakeTokenDocument({id: "screech-target", actor: target, scene, offset: {i: 1, j: 0}});
  vrock.tokens = [sourceToken];
  target.tokens = [targetToken];
  scene.tokens = [sourceToken, targetToken];
  scene.tokens.get = id => scene.tokens.find(token => token.id === id);
  const game = fakeGame({actors: [vrock, target], scenes: [scene]});
  const demons = domains => [{schemaVersion: 1, id: "demons-succeed", type: "RollOutcome", data: {domains, outcome: "automatic-success"},
    predicate: {equals: {path: "save.saverSubtype", value: "demon"}}}];
  const screech = {...fortitudeBlast("fortitude"), id: "action:runtime-screech", save: {ability: "fortitude", dc: {value: 15}, rollOutcomes: demons(["save"])}};
  const action = actionItem(screech, vrock);
  const judged = async () => {
    const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a", game, intent: {actorRef: vrock.uuid,
      actionRef: action.uuid, targetRefs: [{actorRef: target.uuid, tokenId: targetToken.id, sceneId: scene.id}]}});
    assert.equal(resolved.ok, true, resolved.reason);
    const planned = planStagedActionResolution({...resolved.options, save: {...resolved.options.save, roll: {total: 1, natural: 1, die: 1}}});
    const odds = foundryActionOdds({actor: vrock, action, sourceToken, targetTokens: [targetToken], user: {isGM: true}, game})[0];
    return [planned.state.results.saveResolution.results[0].success, odds.automatic, odds.chance];
  };
  target.system.details = {type: "fiend", subtype: ""};
  assert.deepEqual(await judged(), [false, false, 0.7], "another fiend rolls: +0 against DC 15 fails 70%");
  target.system.details = {type: "fiend", subtype: "demon"};
  assert.deepEqual(await judged(), [true, true, 0], "a demon succeeds unrolled, and its odds say so");
  // A choice of saves (Grapple's): the one the Action's outcome passes.
  const choice = {save: {abilities: ["might", "agility"], dc: {value: 13}, rollOutcomes: demons(["save.agility"])}};
  assert.equal(bestSaveAbility({definition: choice, targetActor: target, saverToken: targetToken, actor: vrock, sourceToken, game}), "agility");
  target.system.details = {type: "fiend", subtype: ""};
  assert.equal(bestSaveAbility({definition: choice, targetActor: target, saverToken: targetToken, actor: vrock, sourceToken, game}), "might",
    "another fiend: equal odds keep the first");
});

test("a common action is built by the authority from its id: a client names it, never supplies its rules", async () => {
  const scene = fakeScene(new FakeSquareGrid(), {id: "scene-common"});
  const hero = fakeActor("common-hero", {system: {...actorSystem(), abilities: {might: {value: 16}}, details: {level: 5}},
    statistics: {}});
  const ogre = fakeActor("common-ogre", {system: targetActorSystem(20, 20, {ac: 11})});
  const heroToken = fakeTokenDocument({id: "common-hero", actor: hero, scene, offset: {i: 0, j: 0}});
  const ogreToken = fakeTokenDocument({id: "common-ogre", actor: ogre, scene, offset: {i: 1, j: 0}});
  hero.tokens = [heroToken];
  ogre.tokens = [ogreToken];
  scene.tokens = [heroToken, ogreToken];
  const game = {...fakeGame({actors: [hero, ogre], scenes: [scene]}), i18n: {localize: key => `loc:${key}`}};
  const intent = ref => ({actorRef: hero.uuid, actionRef: ref, targetRefs: [{actorRef: ogre.uuid, tokenId: ogreToken.id, sceneId: scene.id}]});
  const shove = await foundryActionIntentToStagedOptions({senderUserId: "player-a", game, intent: intent("common:shove")});
  assert.equal(shove.ok, true, shove.reason);
  assert.equal(shove.options.action.name, "loc:WILDPATH.COMMON.Shove");
  const planned = await planStagedActionResolution(shove.options);
  assert.equal(planned.state.rollRequests[0].type, "saving-throw");
  assert.equal(planned.state.rollRequests[0].dc.value, 14, "8 + Might +3 + proficiency +3");
  const unknown = await foundryActionIntentToStagedOptions({senderUserId: "player-a", game, intent: intent("common:fireball")});
  assert.equal(unknown.ok, false, "only the system's own common actions exist");

  // Free: built from its first declared target's hold; refused while that creature has no hold another may free it from.
  assert.equal((await foundryActionIntentToStagedOptions({senderUserId: "player-a", game, intent: intent("common:free")})).ok, false,
    "no hold to free it from");
  ogre.effects = [{id: "net", statuses: new Set(["restrained"]), system: {type: "restrained"},
    flags: {wildpath: {conditionEffect: {metadata: {escapeDC: 10, escapeByOthers: true}}}}}];
  // Charmed by the netted ogre: freeing it only takes a condition off it, which is not harmful.
  hero.effects = [{id: "charm", statuses: new Set(["charmed"]), flags: {wildpath: {conditionEffect: {sourceRef: `uuid:${ogre.uuid}`}}}}];
  const free = await foundryActionIntentToStagedOptions({senderUserId: "player-a", game, intent: intent("common:free")});
  assert.equal(free.ok, true, free.reason);
  assert.equal(free.options.action.system.definition.check.dc.value, 10);
  assert.equal(free.options.targetActors[free.options.targets[0].actorRef], ogre, "endEffectsWhenEscaped's held creature");
  const shoved = await foundryActionIntentToStagedOptions({senderUserId: "player-a", game, intent: intent("common:shove")});
  assert.equal(shoved.ok, false, "a Shove of its charmer is still harmful");

  // Two nets from two hunters (Q19): the helper frees it from the harder net alone, with no choice (Q19 (a)).
  ogre.effects = [...ogre.effects, {id: "net-2", statuses: new Set(["restrained"]), system: {type: "restrained"},
    flags: {wildpath: {conditionEffect: {sourceRef: "uuid:Actor.other-hunter", metadata: {escapeDC: 13, escapeByOthers: true}}}}}];
  const twoNets = await foundryActionIntentToStagedOptions({senderUserId: "player-a", game, intent: intent("common:free")});
  assert.equal(twoNets.ok, true, twoNets.reason);
  const twoNetsState = (await planStagedActionResolution(twoNets.options)).state;
  assert.equal(twoNetsState.rollRequests.find(request => request.type === "skill-check")?.dc?.value, 13, "the harder net's DC");
});

test("a reaction's attack rolls with the same advantage as any attack: a Prone attacker within 5 ft is easier to hit", async t => {
  const {sourceActor, gm, player, intent, gmRollRequests} = counterattackFixture(t, {decision: "use"});
  withConditions(sourceActor, "prone");
  const declared = await player.declareActionIntent(intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors));
  const counter = gmRollRequests.find(request => request.type === "attack");
  assert.equal(counter.rollMode, "advantage");
});

test("a Blessed attacker rolls 1d20 + 1d4 + its bonus, and a Baned target's save subtracts its 1d4", async () => {
  const scene = fakeScene(new FakeSquareGrid(), {id: "scene-bless"});
  const blessed = {...runtimeStatistic("attack.weapon", 4), dice: [{id: "bless", label: "Bless", number: 1, faces: 4, sign: 1}]};
  const baned = {...runtimeStatistic("save.might", 3), dice: [{id: "bane", label: "Bane", number: 1, faces: 4, sign: -1}]};
  const sourceActor = withConditions(fakeActor("bless-source", {system: actorSystem(), statistics: {"attack.weapon": blessed}}));
  const targetActor = withConditions(fakeActor("bless-target", {system: targetActorSystem(20, 20, {ac: 14}), statistics: {"save.might": baned}}));
  const sourceToken = fakeTokenDocument({id: "bless-source", actor: sourceActor, scene, offset: {i: 0, j: 0}});
  const targetToken = fakeTokenDocument({id: "bless-target", actor: targetActor, scene, offset: {i: 1, j: 0}});
  sourceActor.tokens = [sourceToken];
  targetActor.tokens = [targetToken];
  scene.tokens = [sourceToken, targetToken];
  const game = fakeGame({actors: [sourceActor, targetActor], scenes: [scene]});
  const first = async definition => {
    const action = actionItem(definition, sourceActor);
    const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a", game, intent: {actorRef: sourceActor.uuid,
      actionRef: action.uuid, targetRefs: [{actorRef: targetActor.uuid, tokenId: targetToken.id, sceneId: scene.id}]}});
    assert.equal(resolved.ok, true, resolved.reason);
    return (await planStagedActionResolution(resolved.options)).state.rollRequests[0];
  };
  const attack = await first(meleeStrikeDefinition());
  assert.equal(rollFormulaForRequest(attack).formula, "1d20 + 1d4 + 4");
  assert.equal(attack.expected.modifierTotal, null, "the total is no longer the d20 plus a known modifier");
  const save = await first(fortitudeBlast("might"));
  assert.equal(rollFormulaForRequest(save).formula, "1d20 - 1d4 + 3");
});

test("a reaction to taking damage (Hellish Rebuke) is offered once the damage is planned, and strikes whoever dealt it", async t => {
  const {sourceActor, targetActor, player, offers, intent} = counterattackFixture(t, {event: "damage.applied"});
  const declared = await player.declareActionIntent(intent);
  assert.equal(declared.ok, true, JSON.stringify(declared));
  assert.equal(offers.length, 1, "offered to the damaged creature's controller");
  assert.equal(offers[0].payload.candidates[0].event?.type ?? "damage.applied", "damage.applied");
  assert.equal(sourceActor.system.resources.health.value, 17, "the reaction hit the attacker for 3");
  assert.equal(targetActor.system.resources.health.value, 24, "and the Action's own damage still lands");
});

test("Unaffected: a reaction spell at a creature immune to it is spent, and does nothing to it", async t => {
  const rebuke = tag => [{id: "rebuke", type: "action", name: "Rebuke", system: {active: true,
    definition: {schemaVersion: 1, id: "action:rebuke", label: "Rebuke", tags: ["spell", tag],
      costs: {allOf: [{capability: ECONOMY_CAPABILITIES.REACTION, amount: 1}]},
      range: {type: "ranged", normal: {value: 60, unit: "ft"}}, targeting: {type: "single", required: true, count: 1},
      save: {ability: "agility", dc: {value: 30}},
      damage: [{id: "flames", expression: {type: "constant", value: 3}, damageType: "fire", provenance: "spell-base"}]},
    ruleElements: [{schemaVersion: 1, id: "rebuke", type: "Trigger", data: {kind: "reaction", event: "damage.applied",
      match: {phase: "interrupt", targetTokenId: "{self}"}}}]}}];
  const cast = async tag => {
    const fixture = counterattackFixture(t, {holderItems: rebuke(tag)});
    fixture.sourceActor.effects = [SPELL_A_IMMUNITY];
    const declared = await fixture.player.declareActionIntent(fixture.intent);
    assert.equal(declared.ok, true, JSON.stringify(declared));
    assert.equal(fixture.gm.getRecord(declared.resolutionId)?.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
    return fixture;
  };
  const immune = await cast("spell:spell-a");
  assert.equal(immune.offers.length, 1, "offered to the damaged creature's controller");
  assert.equal(immune.sourceActor.system.resources.health.value, 20, "no damage to the immune attacker");
  assert.equal(immune.targetActor.system.resources.reaction.value, 0, "the reaction is spent");
  assert.deepEqual(immune.posts[0].result.outcomes.unaffected?.map(target => target.tokenId), [immune.sourceToken.id], "its card names it");
  const other = await cast("spell:spell-b");
  assert.equal(other.sourceActor.system.resources.health.value, 17, "a spell it is not immune to affects it");
});

test("a weapon attack's hit carries the `weapon` tag, so an own-hit reaction on any weapon (Divine Strike) is offered", async t => {
  const strike = {id: "strike", type: "action", name: "Divine Strike", system: {active: true,
    definition: {schemaVersion: 1, id: "action:strike", label: "Divine Strike", costs: {allOf: []}, range: {type: "special"},
      targeting: {type: "single", required: true, count: 1},
      damage: [{id: "radiant", expression: {type: "constant", value: 4}, damageType: "radiant", provenance: "additional"}]},
    ruleElements: [{schemaVersion: 1, id: "strike", type: "Trigger", data: {kind: "reaction", event: "attack.hit",
      match: {phase: "interrupt", sourceTokenId: "{self}", tagsAll: ["weapon"], notTagsAny: ["spell"]}}}]}};
  const {player, gm, offers, intent} = counterattackFixture(t, {reactor: "source", items: [strike]});
  const declared = await player.declareActionIntent(intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.equal(offers.length, 1, "offered on the weapon's hit");
});

for ( const identifier of ["psychic-blade", "dagger"] ) test(`a hit Trigger reads the used Item's identifier (Rend Mind on a Psychic Blade's hit): ${identifier}`, async t => {
  const rend = {id: "rend", type: "action", name: "Rend Mind", system: {active: true,
    definition: {schemaVersion: 1, id: "action:rend", label: "Rend Mind", costs: {allOf: []}, range: {type: "special"},
      targeting: {type: "single", required: true, count: 1}, effects: [{id: "stunned", type: "condition", conditionId: "stunned"}]},
    ruleElements: [{schemaVersion: 1, id: "rend", type: "Trigger", data: {kind: "reaction", event: "attack.hit",
      match: {phase: "interrupt", sourceTokenId: "{self}"},
      triggerPredicate: {oneOf: {path: "event.data.action.identifier", values: ["psychic-blades", "psychic-blade"]}}}}]}};
  const {player, gm, offers, intent, action} = counterattackFixture(t, {reactor: "source", items: [rend]});
  action.flags = {...(action.flags ?? {}), wildpath: {...(action.flags?.wildpath ?? {}), source: {identifier}}};
  const declared = await player.declareActionIntent(intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.equal(offers.length, (identifier === "psychic-blade") ? 1 : 0, "offered only on that Item's hit");
});

for ( const identifier of ["psychic-blade", "dagger"] ) test(`an attack made as a reaction carries its Item's identifier to its own hit Triggers: ${identifier}`, async t => {
  const rend = {id: "rend", type: "action", name: "Rend Mind", system: {active: true,
    definition: {schemaVersion: 1, id: "action:rend", label: "Rend Mind", costs: {allOf: []}, range: {type: "special"},
      targeting: {type: "single", required: true, count: 1}, effects: [{id: "stunned", type: "condition", conditionId: "stunned"}]},
    ruleElements: [{schemaVersion: 1, id: "rend", type: "Trigger", data: {kind: "reaction", event: "attack.hit",
      match: {phase: "interrupt", sourceTokenId: "{self}"},
      triggerPredicate: {oneOf: {path: "event.data.action.identifier", values: ["psychic-blades", "psychic-blade"]}}}}]}};
  const counter = {id: "counter", type: "action", name: "Counterattack", flags: {wildpath: {source: {identifier}}}, system: {active: true,
    definition: {schemaVersion: 1, id: "action:counterattack", label: "Counterattack",
      costs: {allOf: [{capability: ECONOMY_CAPABILITIES.REACTION, amount: 1}]},
      range: {type: "reach", distance: {value: 5, unit: "ft"}}, targeting: {type: "single", required: true, count: 1},
      attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
      damage: [{id: "riposte", expression: {type: "constant", value: 3}, damageType: "slashing", provenance: "weapon-base"}]},
    ruleElements: [{schemaVersion: 1, id: "riposte", type: "Trigger", data: {kind: "reaction", event: "attack.hit",
      match: {phase: "interrupt", targetTokenId: "{self}"}}}]}};
  const {player, gm, offers, intent} = counterattackFixture(t, {holderItems: [counter, rend]});
  const declared = await player.declareActionIntent(intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.deepEqual(offers.map(offer => offer.payload.candidates[0].actionId), (identifier === "psychic-blade")
    ? ["action:counterattack", "action:rend"] : ["action:counterattack"], "Rend Mind answers only the Psychic Blade's hit");
});

test("Stone's Endurance: as an attack on it hits, 1d12 + its Fortitude modifier comes off that attack's damage", async t => {
  const fs = await import("node:fs");
  const stone = JSON.parse(fs.readFileSync("packs/_source/srd-items/stone-s-endurance-phbsptStonesEndu.json", "utf8"));
  const {targetActor, targetSource, gm, player, offers, intent, holder} = counterattackFixture(t, {
    holderItems: [{id: stone._id, type: "action", name: stone.name, system: stone.system}], gmQueue: [{total: 3}]});
  for ( const system of [targetSource, targetActor.system] ) {
    system.abilities = {...(system.abilities ?? {}), fortitude: {value: 14}};
    system.pools = [{id: "stone-s-endurance", value: 2, max: 2}];
  }
  const declared = await player.declareActionIntent(intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.equal(offers.length, 1, "offered to the creature hit");
  assert.equal(targetActor.system.resources.health.value, 29, "6 damage less 3 + 2");
  assert.equal(holder.system.resources.reaction.value, 0);
  assert.equal(holder.system.pools.find(pool => pool.id === "stone-s-endurance").value, 1);
});

test("a damage event carries its attack's kind: Arrow-Catching Shield answers a converted Shortbow's hit, never a melee one", async t => {
  const fs = await import("node:fs");
  const shield = JSON.parse(fs.readFileSync("packs/_source/srd-items/arrow-catching-shield-dmgArrowcatching.json", "utf8"));
  const boss = JSON.parse(fs.readFileSync("packs/_source/srd-creatures/goblin-boss-mmGoblinBoss0000.json", "utf8"));
  const shortbow = boss.items.find(item => item.system.definition?.id === "action:srd-shortbow").system.definition;
  assert.equal(shortbow.tags, undefined, "its kind is only in its attack");
  const run = async (ranged, options) => {
    const fixture = counterattackFixture(t, options);
    // Its kind and range, not its proficiency (the fixture's roll is the strike's +4).
    const {type, statistic} = shortbow.attack;
    if ( ranged ) Object.assign(fixture.action.system.definition, {attack: {type, statistic, defenseKey: "ac"}, range: shortbow.range});
    const record = fixture.gm.getRecord((await fixture.player.declareActionIntent(fixture.intent)).resolutionId);
    assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
    return fixture;
  };
  // Beside the Shortbow's target, its wielder becomes the target (the same 22 hits it) and takes the 6 instead.
  const shieldOptions = () => ({reactor: "bystander", holderItems: [{id: shield._id, type: "action", name: shield.name, system: shield.system}]});
  const caught = await run(true, shieldOptions());
  assert.equal(caught.offers.length, 1, "offered on the ranged hit");
  assert.deepEqual([caught.targetActor.system.resources.health.value, caught.holder.system.resources.health.value], [30, 14]);
  const melee = await run(false, shieldOptions());
  assert.equal(melee.offers.length, 0, "a melee hit is not a ranged attack");
  assert.equal(melee.targetActor.system.resources.health.value, 24);

  // The same kind once the damage lands (`interrupt`): "when a ranged weapon attack damages you" answers only the Shortbow.
  const strikeBack = {id: "strike-back", type: "action", name: "Strike Back", system: {active: true,
    definition: {schemaVersion: 1, id: "action:strike-back", label: "Strike Back", costs: {allOf: [{capability: ECONOMY_CAPABILITIES.REACTION, amount: 1}]},
      range: {type: "reach", distance: {value: 5, unit: "ft"}}, targeting: {type: "single", required: true, count: 1},
      attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
      damage: [{id: "riposte", expression: {type: "constant", value: 3}, damageType: "slashing", provenance: "weapon-base"}]},
    ruleElements: [{schemaVersion: 1, id: "strike-back", type: "Trigger", data: {kind: "reaction", event: "damage.applied",
      match: {phase: "interrupt", targetTokenId: "{self}", tagsAll: ["ranged", "weapon"]}}}]}};
  assert.equal((await run(true, {holderItems: [strikeBack]})).offers.length, 1);
  assert.equal((await run(false, {holderItems: [strikeBack]})).offers.length, 0);
});

test("Dwarven Plate: an attack that pushes its wearer offers its Reaction, which takes 10 feet off that push", async t => {
  const fs = await import("node:fs");
  const plate = JSON.parse(fs.readFileSync("packs/_source/srd-items/dwarven-plate-reduce-unwilling-movement-gj4f476ga3f70000.json", "utf8"));
  const gear = {id: "plate-gear", type: "gear", name: "Dwarven Plate", system: {active: true, attunement: ""}};
  const {targetActor, gm, player, offers, intent, holder, action} = counterattackFixture(t, {
    holderItems: [gear, {id: plate._id, type: "action", name: plate.name, system: plate.system, flags: {wildpath: {grantedBy: gear.id}}}]});
  action.system.definition.push = {distance: 10};
  const declared = await player.declareActionIntent(intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.equal(offers.length, 1, "offered to the creature pushed");
  assert.equal(holder, targetActor);
  assert.equal(holder.system.resources.reaction.value, 0);
  assert.deepEqual(record.state.input.pushReduction, {"target-token": 10});
});

test("Countercharm: offered for a save failed against Charmed or Frightened, by the creature itself or an ally within 30 ft", async t => {
  const {withAllyTestOffers} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const {scene, targetActor, targetToken, targetSource} = syntheticRuntimeFixture(t);
  const countercharm = {id: "cc", name: "Countercharm", system: {active: true}, flags: {wildpath: {testOffer: {tests: ["save"], pool: "reaction",
    rollMode: "advantage", range: 30, against: ["charmed", "frightened"]}}}};
  const bardAt = (id, j, disposition=targetToken.disposition) => {
    const actor = withFoundryActorSystem(fakeActor(id, {system: {...targetActorSystem(), resources: {reaction: {value: 1, max: 1}}}}));
    actor.items = [countercharm];
    scene.tokens.push(fakeTokenDocument({id: `${id}-token`, actor, scene, offset: {i: 1, j}, disposition}));
    return actor;
  };
  const charm = {effects: [{conditionId: "charmed"}]};
  const payers = [];
  const offerFor = definition => withAllyTestOffers(null, targetToken, definition, {}, "save", {chooser: "target-controller",
    register: payer => payers.push(payer.id)});
  bardAt("far-bard", 7);
  bardAt("foe-bard", 1, -targetToken.disposition);
  assert.equal(offerFor(charm), null, "35 ft away, or not an ally");
  bardAt("bard", 6);
  const offer = offerFor(charm);
  assert.deepEqual(offer.options.map(option => [option.payerRef, option.rollMode]), [["Actor.bard", "advantage"]], "30 ft away");
  assert.deepEqual(offer.options[0].authority, {kind: "gm"}, "an ally's is its controller's to decide; with no one active, the GM's");
  assert.deepEqual(payers, ["bard"], "registered to pay");
  assert.equal(offerFor({effects: [{conditionId: "prone"}]}), null, "a save against Prone");
  targetActor.items = [countercharm];
  for ( const system of [targetSource, targetActor.system] ) system.resources.reaction = {value: 1, max: 1};
  const both = offerFor({effects: [{conditionId: "frightened"}]});
  assert.deepEqual(both.options.map(option => option.authority?.kind ?? "saver"), ["saver", "gm"], "its own too, the saver's to decide");
  // A GM creature's save, which the players' Heroic Inspiration may reroll whatever it rolls: the ally's Countercharm
  // still joins, for a failure only (seen live 2026-10-31: it was dropped whenever a player had Inspiration).
  const monster = {own: false, chooser: "gm", label: "Monster", options: [{value: "spend:Actor.pc", payerRef: "Actor.pc"}]};
  const joined = withAllyTestOffers(monster, targetToken, charm, {}, "save", {chooser: "target-controller"});
  assert.equal(joined.own, false);
  assert.deepEqual(joined.options.map(option => [option.value.split(":")[0], option.failedOnly ?? false]),
    [["spend", false], ["ally-offer", true]]);
  assert.equal(joined.options[1].payerRef, "Actor.bard", "the ally's, not the GM creature's own");
});

test("Boon of Fate: 2d4 added to a failed D20 Test of its bearer or an ally within 60 feet, from its use", async t => {
  const {withAllyTestOffers} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const fs = await import("node:fs");
  const {scene, targetToken} = syntheticRuntimeFixture(t);
  const boon = JSON.parse(fs.readFileSync("packs/_source/srd-items/boon-of-fate-phbBoonofFate000.json", "utf8"));
  const fate = {id: "fate", name: "Boon of Fate", system: {active: true}, flags: {wildpath: {testOffer: boon.flags.wildpath.testOffer}}};
  const actor = withFoundryActorSystem(fakeActor("seer", {system: {...targetActorSystem(), pools: [{id: "boon-of-fate", value: 1, max: 1}]}}));
  actor.items = [fate];
  scene.tokens.push(fakeTokenDocument({id: "seer-token", actor, scene, offset: {i: 1, j: 6}, disposition: targetToken.disposition}));
  const offer = withAllyTestOffers(null, targetToken, {}, {}, "attack", {chooser: "target-controller"});
  assert.deepEqual(offer.options.map(option => [option.payerRef, option.addDice]), [["Actor.seer", {number: 2, faces: 4}]]);
  assert.equal(boon.system.ruleElements.find(rule => rule.id === "boon-of-fate-initiative").data.event, "initiative.rolled", "back on Initiative");
});

test("a test offer's foe side (`side`): Boon of Fate's 2d4 off a hostile roller's success in sight; `rangeTo` the attack's target", async t => {
  const {withAllyTestOffers} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const fs = await import("node:fs");
  const {scene, targetActor, targetToken} = syntheticRuntimeFixture(t);
  const boon = JSON.parse(fs.readFileSync("packs/_source/srd-items/boon-of-fate-phbBoonofFate000.json", "utf8"));
  assert.deepEqual([boon.flags.wildpath.testOffer.side, boon.flags.wildpath.testOffer.unseen, boon.flags.wildpath.conversion.notes],
    ["both", true, []], "its penalty is no longer by hand, and needs no sight");
  const bearers = [];
  // The roller (targetToken, hostile: -1) stands at (1, 0); each square is 5 ft.
  const bearerAt = (id, j, offer, disposition=-targetToken.disposition) => {
    const actor = withFoundryActorSystem(fakeActor(id, {system: {...targetActorSystem(), resources: {reaction: {value: 1, max: 1}},
      pools: [{id: "boon-of-fate", value: 1, max: 1}]}}));
    actor.items = [{id: `${id}-offer`, name: `${id} offer`, system: {active: true}, flags: {wildpath: {testOffer: offer}}}];
    const token = fakeTokenDocument({id: `${id}-token`, actor, scene, offset: {i: 1, j}, disposition});
    scene.tokens.push(token);
    bearers.push(token);
    return token;
  };
  const clear = () => { scene.tokens = scene.tokens.filter(token => !bearers.includes(token)); };
  const game = {i18n: {format: (key, data) => `${key}:${data.name}`}};
  const offered = (test="attack", extra={}) => withAllyTestOffers(extra.offer ?? null, targetToken, {}, game, test,
    {chooser: "target-controller", ...extra});
  const fate = boon.flags.wildpath.testOffer;

  // A foe 60 ft away: 2d4 taken off the success, asked of its bearer in its own words; 65 ft away: none.
  bearerAt("far", 13, fate);
  assert.equal(offered(), null, "65 ft");
  bearerAt("seer", 12, fate);
  const foe = offered().options;
  assert.deepEqual(foe.map(option => [option.payerRef, option.addDice, option.succeededOnly, option.authority, option.offerLabel, option.label]),
    [["Actor.seer", {number: 2, faces: 4, subtract: true}, true, {kind: "gm"}, "WILDPATH.INSPIRATION.FoeTest:target-model",
      "WILDPATH.INSPIRATION.FoeDice:seer"]]);
  assert.equal(offered("save").options[0].offerLabel, "WILDPATH.INSPIRATION.FoeSave:target-model");
  // Beside the players' monster offer it keeps its own words and is not made a failure-only option.
  const monster = {own: false, chooser: "gm", label: "Monster", options: [{value: "spend:Actor.pc", payerRef: "Actor.pc"}]};
  const joined = offered("attack", {offer: monster}).options[1];
  assert.deepEqual([joined.failedOnly, joined.offerLabel], [undefined, "WILDPATH.INSPIRATION.FoeTest:target-model"]);
  // Boon of Fate (`unseen`) answers an Invisible roller; an offer without it needs its bearer to see the roller. Neither
  // answers a GM-hidden roller for a player's creature.
  targetActor.statuses = new Set(["invisible"]);
  assert.equal(offered().options.length, 1, "an Invisible roller, unseen");
  bearers.at(-1).actor.items[0].flags.wildpath.testOffer = {...fate, unseen: false};
  assert.equal(offered(), null, "an Invisible roller, needing sight");
  bearers.at(-1).actor.items[0].flags.wildpath.testOffer = fate;
  targetActor.statuses = new Set();
  targetToken.hidden = true;
  bearers.at(-1).actor.hasPlayerOwner = true;
  assert.equal(offered(), null, "hidden by the GM");
  targetToken.hidden = false;
  // An ally's failure still gets the bonus (no succeededOnly).
  clear();
  bearerAt("friend", 6, fate, targetToken.disposition);
  assert.deepEqual(offered().options.map(option => [option.addDice, option.succeededOnly]), [[{number: 2, faces: 4}, undefined]]);
  // `side: "foes"` gives an ally nothing.
  clear();
  bearerAt("friend", 6, {...fate, side: "foes"}, targetToken.disposition);
  assert.equal(offered(), null);

  // Bend Luck's shape: no range, any distance; `others` keeps it off its bearer's own roll.
  clear();
  const bend = {tests: ["check", "save", "attack"], pool: "boon-of-fate", faces: {type: "constant", value: 4}, reaction: true, others: true,
    side: "both"};
  bearerAt("sorcerer", 40, bend);
  assert.deepEqual(Object.keys(offered("check").options[0].plan.updates).sort(), ["system.pools.0.value", "system.resources.reaction.value"],
    "200 ft away, for a use and its Reaction");
  // "Another creature you can see" (Q71): an ally's failure too only when its bearer sees it; an ally-only row with
  // `seen` alike (Flash of Genius, Q125); one without either answers an ally it can't see.
  clear();
  bearerAt("sorcerer", 40, bend, targetToken.disposition);
  assert.equal(offered("check").options.length, 1, "an ally seen 200 ft away");
  targetActor.statuses = new Set(["invisible"]);
  assert.equal(offered("check"), null, "an Invisible ally");
  clear();
  bearerAt("inventor", 4, {tests: ["check"], pool: "boon-of-fate", reaction: true, range: 30, add: 2, seen: true}, targetToken.disposition);
  assert.equal(offered("check"), null, "an ally-only row with `seen`: an Invisible ally");
  bearers.at(-1).actor.items[0].flags.wildpath.testOffer = {tests: ["check"], pool: "boon-of-fate", reaction: true, range: 30, add: 2};
  assert.equal(offered("check").options.length, 1, "without `seen`: no sight asked of an ally");
  targetActor.statuses = new Set();
  clear();
  targetActor.items = [{id: "own-bend", name: "Bend Luck", system: {active: true}, flags: {wildpath: {testOffer: bend}}}];
  assert.equal(offered("check"), null, "its own roll");
  targetActor.items = [];

  // Runic Shield: measured to the attack's target, which it must see; never its own; none with several targets.
  const shield = {tests: ["attack"], pool: "boon-of-fate", reroll: true, reaction: true, range: 60, rangeTo: "target", others: true, side: "foes"};
  const victim = bearerAt("victim", 20, {tests: []}, -targetToken.disposition);
  bearerAt("knight", 30, shield);
  assert.equal(offered("attack"), null, "no single target");
  const rerolled = offered("attack", {targetToken: victim}).options;
  assert.deepEqual(rerolled.map(option => [option.payerRef, option.addDice, option.label]),
    [["Actor.knight", undefined, "WILDPATH.INSPIRATION.FoeReroll:knight"]], "50 ft from the target, 150 ft from the attacker");
  victim.actor.statuses = new Set(["invisible"]);
  assert.equal(offered("attack", {targetToken: victim}), null, "an unseen target");
  victim.actor.statuses = new Set();
  assert.equal(offered("attack", {targetToken: bearers.at(-1)}), null, "the target is the knight itself");
  // A neutral roller's first attack on the victim (Q47, Q110 (b)): a foe's for the knight on the victim's side once its own
  // turn to hostility (`turns`, from hostileTurns) counts, before the Combat records it.
  const side = targetToken.disposition;
  targetToken.disposition = 0;
  assert.equal(offered("attack", {targetToken: victim}), null, "a neutral roller is no foe");
  assert.equal(offered("attack", {targetToken: victim, turns: [{id: targetToken.id, side: victim.disposition, combat: {}}]}).options.length, 1);
  targetToken.disposition = side;
  // Guardian Emblem: a critical hit made normal, on a foe's attack only.
  clear();
  const emblem = {tests: ["attack"], pool: "boon-of-fate", uncritical: true, reaction: true, range: 30, rangeTo: "target", side: "foes"};
  const cleric = bearerAt("cleric", 6, emblem);
  assert.deepEqual(offered("attack", {targetToken: cleric}).options.map(option => [option.uncritical, option.criticalOnly]), [[true, true]],
    "its own critical hit taken");
  clear();
  bearerAt("cleric", 6, {...emblem, side: "both"}, targetToken.disposition);
  assert.equal(offered("attack", {targetToken: bearers.at(-1)}), null, "an ally's critical hit is never made normal");
});

test("a roll-mode offer's bearers (Restore Balance, Q72): within 60 ft and in sight, an ally's or a foe's roll, for a use and its Reaction", async t => {
  const {withRollModeOffers} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const {scene, targetActor, targetSource, targetToken} = syntheticRuntimeFixture(t);
  const BALANCE = {tests: ["attack", "check", "save"], range: 60, reaction: true, side: "both", pool: "restore-balance"};
  const bearers = [];
  // The roller (targetToken) stands at (1, 0); each square is 5 ft.
  const bearerAt = (id, j, {offer=BALANCE, disposition=-targetToken.disposition, reaction=1, uses=2}={}) => {
    const actor = withFoundryActorSystem(fakeActor(id, {system: {...targetActorSystem(), resources: {reaction: {value: reaction, max: 1}},
      pools: [{id: "restore-balance", value: uses, max: 2}]}}));
    actor.items = [{id: "balance", name: "Restore Balance", system: {active: true}, flags: {wildpath: {rollModeOffer: offer}}}];
    const token = fakeTokenDocument({id: `${id}-token`, actor, scene, offset: {i: 1, j}, disposition});
    scene.tokens.push(token);
    bearers.push(token);
    return token;
  };
  const clear = () => { scene.tokens = scene.tokens.filter(token => !bearers.includes(token)); };
  const game = {i18n: {format: (key, data) => `${key}:${data.name}`}};
  const payers = [];
  const offered = (test="attack") => withRollModeOffers(targetToken, game, test, {chooser: "target-controller",
    register: payer => payers.push(payer.id)});

  // A foe 60 ft away, its bearer deciding, for a use and its Reaction; 65 ft away: none. The roller is named by its Token
  // (a disguise the GM gave it), not its Actor.
  targetToken.name = "Hooded figure";
  bearerAt("far", 13);
  assert.equal(offered(), null, "65 ft");
  bearerAt("sorcerer", 12);
  const foe = offered();
  assert.deepEqual([foe.chooser, foe.rollerName, foe.options.map(option => [option.value, option.authority, option.label,
    Object.keys(option.plan.updates).sort()])],
  ["target-controller", "Hooded figure", [["roll-mode-offer:Actor.sorcerer:balance", {kind: "gm"}, "WILDPATH.ROLLMODEOFFER.Use:sorcerer",
    ["system.pools.0.value", "system.resources.reaction.value"]]]]);
  assert.deepEqual(payers, ["sorcerer"], "its payer is committed on");
  assert.equal(offered("save").options.length, 1, "a save too");
  // Not out of sight, not for a GM-hidden roller to a player's creature, not without its Reaction or a use.
  targetActor.statuses = new Set(["invisible"]);
  assert.equal(offered(), null, "an Invisible roller");
  targetActor.statuses = new Set();
  targetToken.hidden = true;
  bearers.at(-1).actor.hasPlayerOwner = true;
  assert.equal(offered(), null, "hidden by the GM");
  targetToken.hidden = false;
  clear();
  bearerAt("tired", 6, {reaction: 0});
  assert.equal(offered(), null, "no Reaction left");
  clear();
  bearerAt("spent", 6, {uses: 0});
  assert.equal(offered(), null, "no use left");
  // An ally's (no `side`: allies only); `side: "foes"` gives an ally nothing; a test it lacks nothing.
  clear();
  bearerAt("friend", 6, {disposition: targetToken.disposition, offer: {...BALANCE, side: undefined}});
  assert.deepEqual(offered().options.map(option => option.authority), [{kind: "gm"}]);
  // `reaction: "others"` costs a Reaction on another creature's roll, as a test offer's: none left, none offered.
  clear();
  bearerAt("friend", 6, {disposition: targetToken.disposition, reaction: 0, offer: {...BALANCE, reaction: "others"}});
  assert.equal(offered(), null, "another's roll needs its Reaction");
  clear();
  bearerAt("friend", 6, {disposition: targetToken.disposition, offer: {...BALANCE, side: "foes"}});
  assert.equal(offered(), null);
  clear();
  bearerAt("friend", 6, {disposition: targetToken.disposition, offer: {...BALANCE, tests: ["save"]}});
  assert.equal(offered("attack"), null);
  clear();
  // Its own roll ("a creature you can see"): its own controller decides, as the roll's own chooser.
  targetActor.items = [{id: "own-balance", name: "Restore Balance", system: {active: true}, flags: {wildpath: {rollModeOffer: BALANCE}}}];
  for ( const system of [targetSource, targetActor.system] ) {
    system.resources.reaction = {value: 1, max: 1};
    system.pools = [{id: "restore-balance", value: 1, max: 2}];
  }
  assert.deepEqual(offered("check").options.map(option => option.authority), [undefined]);
  // With `reaction: "others"` its own roll costs only the use, its Reaction spent or not.
  targetActor.items[0].flags.wildpath.rollModeOffer = {...BALANCE, reaction: "others"};
  for ( const system of [targetSource, targetActor.system] ) system.resources.reaction = {value: 0, max: 1};
  assert.deepEqual(offered("check").options.map(option => Object.keys(option.plan.updates)), [["system.pools.0.value"]]);
  targetActor.items = [];
});

test("Restore Balance end to end (Q72): an ally's attack and save with Disadvantage roll normally once its bearer takes it, paid by the bearer", async () => {
  const sorcerer = Object.assign(fakeActor("balance-sorcerer", {system: {...actorSystem(), pools: [{id: "restore-balance",
    label: "Restore Balance", value: 2, max: 2}]}}), {documentName: "Actor"});
  sorcerer.items = [{id: "balance", name: "Restore Balance", system: {active: true}, flags: {wildpath: {rollModeOffer: {tests: ["attack", "check", "save"],
    range: 60, reaction: true, side: "both", pool: "restore-balance"}}}}];
  const take = (state, value) => {
    const [request] = state.pendingRequests;
    return resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
      value: {choices: {[request.payload.id]: value}}}}).state;
  };
  const roll = (state, natural) => {
    const [request] = state.pendingRequests;
    return resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
      value: {requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, natural,
        total: natural + (request.payload.rollRequest.expected?.modifierTotal ?? 0)}}}).state;
  };
  const value = `roll-mode-offer:${sorcerer.uuid}:balance`;
  // A Poisoned attacker's Disadvantage: asked before the d20, which then rolls normally.
  const attacking = await plannedWithConditions(meleeStrikeDefinition(), {attacker: ["poisoned"], extraActors: [sorcerer]});
  const [asked] = attacking.state.pendingRequests;
  assert.deepEqual([asked.type, asked.payload.label, asked.payload.options.map(option => option.value)],
    ["choice", "WILDPATH.ROLLMODEOFFER.Disadvantage", [value, "keep"]]);
  assert.equal(attacking.targetActors?.[sorcerer.uuid], sorcerer, "its bearer is committed on");
  const normal = take(attacking.state, value);
  assert.equal(normal.pendingRequests[0].payload.rollRequest.rollMode, "normal");
  let done = roll(normal, 15);
  while ( done.pendingRequests.length ) done = roll(done, 3);
  assert.deepEqual(done.mutationPlans.find(plan => plan.payerRef === sorcerer.uuid)?.plan.updates,
    {"system.pools.0.value": 1, "system.resources.reaction.value": 0}, "a use and its Reaction");
  assert.equal(take(attacking.state, "keep").pendingRequests[0].payload.rollRequest.rollMode, "disadvantage", "declined");
  // Without Disadvantage: no question, straight to the d20.
  assert.equal((await plannedWithConditions(meleeStrikeDefinition(), {extraActors: [sorcerer]})).state.pendingRequests[0].type, "roll");
  // A Restrained creature's Dexterity save.
  const saving = await plannedWithConditions(fortitudeBlast("agility"), {target: ["restrained"], extraActors: [sorcerer]});
  assert.deepEqual(saving.state.pendingRequests.map(request => [request.type, request.payload.labelData?.name]), [["choice", "roll-target"]]);
  assert.equal(take(saving.state, value).pendingRequests[0].payload.rollRequest.rollMode, "normal");
});

test("a test offer's side may need its own status (`whileStatus: {allies, foes}`): Cosmic Omen's Weal or Woe, from its Long Rest roll (Q69)", async t => {
  const {withAllyTestOffers} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const {scene, targetToken} = syntheticRuntimeFixture(t);
  const omen = {tests: ["check", "save", "attack"], pool: "cosmic-omen", faces: {type: "constant", value: 6}, reaction: true, range: 30,
    side: "both", whileStatus: {allies: "cosmic-omen-weal", foes: "cosmic-omen-woe"}};
  const druid = withFoundryActorSystem(fakeActor("druid", {system: {...targetActorSystem(), resources: {reaction: {value: 1, max: 1}},
    pools: [{id: "cosmic-omen", value: 3, max: 3}]}}));
  druid.items = [{id: "omen", name: "Cosmic Omen", system: {active: true}, flags: {wildpath: {testOffer: omen}}}];
  // The roller (targetToken) stands at (1, 0), the druid 20 ft away.
  const token = fakeTokenDocument({id: "druid-token", actor: druid, scene, offset: {i: 1, j: 4}, disposition: -targetToken.disposition});
  scene.tokens.push(token);
  const game = {i18n: {format: (key, data) => `${key}:${data.name}`}};
  const kinds = (roller=targetToken) => (withAllyTestOffers(null, roller, {}, game, "save", {chooser: "target-controller"})?.options ?? [])
    .map(option => (option.succeededOnly ? "woe" : "weal"));
  const asFoe = () => { token.disposition = -targetToken.disposition; return kinds(); };
  const asAlly = () => { token.disposition = targetToken.disposition; return kinds(); };
  // Before its first Long Rest roll neither side (Q124 default); Weal answers only an ally's failure, Woe only a foe's success.
  druid.statuses = new Set();
  assert.deepEqual([asAlly(), asFoe()], [[], []], "no omen yet");
  druid.statuses = new Set(["cosmic-omen-weal"]);
  assert.deepEqual([asAlly(), asFoe()], [["weal"], []], "Weal");
  druid.statuses = new Set(["cosmic-omen-woe"]);
  assert.deepEqual([asAlly(), asFoe()], [[], ["woe"]], "Woe");
  // Its own roll is its allies' side.
  assert.deepEqual(kinds(token), [], "its own failure, under Woe");
  druid.statuses = new Set(["cosmic-omen-weal"]);
  assert.deepEqual(kinds(token), ["weal"], "its own failure, under Weal");
  // A side it leaves out is ungated, and a plain string still gates both.
  druid.statuses = new Set();
  druid.items[0].flags.wildpath.testOffer = {...omen, whileStatus: {foes: "cosmic-omen-woe"}};
  assert.deepEqual([asAlly(), asFoe()], [["weal"], []], "only its foe side gated");
  druid.items[0].flags.wildpath.testOffer = {...omen, whileStatus: "raging"};
  assert.deepEqual([asAlly(), asFoe()], [[], []], "a plain status gates both sides");
  druid.statuses = new Set(["raging"]);
  assert.deepEqual([asAlly(), asFoe()], [["weal"], ["woe"]]);
});

/** The converted Boon of Spell Recall, as its bearer's feature. */
function spellRecallItem() {
  const boon = JSON.parse(readFileSync("packs/_source/srd-items/boon-of-spell-recall-phbBoonofSpellRe.json", "utf8"));
  assert.deepEqual(boon.flags.wildpath.conversion.notes, [], "its Free Cast Roll is automated");
  return {id: "recall", type: "feature", name: boon.name, system: {active: true}, flags: {wildpath: {slotRecall: boon.flags.wildpath.slotRecall}}};
}

test("Boon of Spell Recall: its active feature gives the bearer's Actions its d4 (the pipeline judges which payments roll)", async t => {
  const {sourceActor, game, intent} = syntheticRuntimeFixture(t);
  const recall = spellRecallItem();
  // A Foundry Collection: iterating gives its Items.
  sourceActor.items = new (class extends Map { [Symbol.iterator]() { return this.values(); } })([...sourceActor.items.entries(),
    [recall.id, recall]]);
  const options = async () => (await foundryActionIntentToStagedOptions({intent, senderUserId: "player-a", game,
    persistencePort: createTestDocumentPersistenceAdapter()})).options;
  assert.deepEqual((await options()).slotRecall, {dice: {type: "dice", number: 1, faces: 4}, maxLevel: 4});
  recall.system.active = false;
  assert.equal((await options()).slotRecall, undefined, "not while inactive");
});

for ( const d4 of [1, 2] ) test(`Boon of Spell Recall: a spell cast as a Reaction (a 2024 Divine Smite) rolls the d4 for its level-1 slot; a ${d4} ${d4 === 1 ? "keeps" : "spends"} it`, async t => {
  const smite = {id: "smite", type: "action", name: "Divine Smite", system: {active: true,
    definition: {schemaVersion: 1, id: "action:divine-smite", label: "Divine Smite", tags: ["spell"],
      costs: {allOf: [{capability: "spell-slot.1", amount: 1}]}, range: {type: "special"}, targeting: {type: "single", required: true, count: 1},
      damage: [{id: "smite", expression: {type: "dice", number: 2, faces: 8}, damageType: "radiant", provenance: "spell-base"}]},
    ruleElements: [{schemaVersion: 1, id: "smite", type: "Trigger", data: {kind: "reaction", event: "attack.hit",
      match: {phase: "interrupt", sourceTokenId: "{self}", tagsAll: ["melee"]}}}]}};
  const {sourceActor, player, gm, intent, playerRollRequests} = counterattackFixture(t, {reactor: "source", items: [smite, spellRecallItem()],
    queue: [{natural: 18, total: 22}, {total: 9}, {total: d4}]});
  sourceActor.system.pools = [{id: "spell-slot.1", value: 1, max: 1}];
  const declared = await player.declareActionIntent(intent);
  const record = gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.deepEqual(playerRollRequests.map(request => rollFormulaForRequest(request).formula).slice(-1), ["1d4"],
    "the d4 is rolled by the smiting creature's player");
  assert.equal(sourceActor.system.pools[0].value, d4 === 1 ? 1 : 0);
});

test("Portent (2024 Diviner, replacing a rolled d20): offered to a Diviner who sees the roller, once per turn", async () => {
  const diviner = fakeActor("diviner", {system: actorSystem(), owners: ["player-b"]});
  diviner.items = [{id: "portent", name: "Portent", system: {active: true}, flags: {wildpath: {portentDice: {type: "constant", value: 2}}}}];
  diviner.flags = {wildpath: {portent: {1: 3, 2: 17, 3: 0}}};
  const answer = (state, value) => {
    const request = state.pendingRequests[0];
    return resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
      value: {choices: {[request.payload.id]: value}}}});
  };
  // A monster's attack that missed: the Diviner's player is asked, before Heroic Inspiration.
  const asked = await plannedWithConditions(meleeStrikeDefinition(), {attackRoll: {total: 5, natural: 1, die: 1}, extraActors: [diviner]});
  const [choice] = asked.state.pendingRequests;
  assert.deepEqual([choice.payload.id, choice.authority.kind, choice.payload.options.map(option => option.value)],
    ["portent:0", "specific", ["use:1", "use:2", "keep"]]);
  const foretold = answer(asked.state, "use:2").state;
  assert.equal(foretold.results.attackResolution.hits.length, 1, "5 - 1 + 17 = 21 hits AC 14");
  assert.deepEqual(foretold.rollResults.find(entry => entry.portent)?.portent, {holderRef: "Actor.diviner", slot: "2", value: 17});
  const kept = answer(asked.state, "keep").state;
  assert.equal(kept.results.attackResolution.misses.length, 1);
  // A save: its target's d20 replaced; 2 - 2 + 17 = 17 saves against DC 13.
  // (Its Token found through its Actor: the fake Scene's Tokens are a plain list.)
  const saving = await plannedWithConditions(fortitudeBlast("might"), {saveRoll: {total: 2, natural: 2, die: 2}, extraActors: [diviner],
    prepareTarget: actor => Object.defineProperty(actor, "token", {get: () => actor.tokens[0] ?? null})});
  assert.match(saving.state.pendingRequests[0].id, /portent:0:enemy$/u);
  assert.equal(answer(saving.state, "use:2").state.results.saveResolution.successes.length, 1);

  // Its die is spent by the Diviner in the Action's transaction: that slot becomes 0 (rolled back with it).
  const portentPayments = state => (state.mutationPlans ?? []).filter(plan => plan.payerRef === "Actor.diviner");
  assert.deepEqual(portentPayments(foretold).map(plan => [plan.type, plan.plan.updates, plan.plan.payments[0].from]),
    [["resourcePayment", {"flags.wildpath.portent.2": 0}, 17]]);
  assert.equal(portentPayments(kept).length, 0, "a die not used is not spent");
  assert.equal(portentPayments(answer(saving.state, "use:2").state).length, 1, "a save's too");
  // In a combat its turn is marked too, and restored if the transaction rolls back.
  const turnGame = {combat: {started: true, id: "combat", round: 2, turn: 1}};
  assert.deepEqual(portentPayment(diviner, {slot: "1", value: 3}, turnGame), {updates: {"flags.wildpath.portent.1": 0,
    "flags.wildpath.portentTurn": "combat:2:1"}, payments: [{path: "flags.wildpath.portent.1", resourceId: "portent", from: 3, to: 0}],
  path: "flags.wildpath.portentTurn", from: null});

  // Used this turn: not offered again.
  // Its own roll needs no sight; a die used this combat turn is not offered again until the next.
  const scene = fakeScene(new FakeSquareGrid(), {id: "scene-portent"});
  const own = fakeTokenDocument({id: "diviner-token", actor: diviner, scene, offset: {i: 0, j: 0}});
  scene.tokens = [own];
  const turnOf = turn => ({combat: {started: true, id: "combat", round: 1, turn}});
  diviner.flags.wildpath.portentTurn = "combat:1:0";
  assert.deepEqual([portentHolders(own, turnOf(0)).length, portentHolders(own, turnOf(1)).length], [0, 1]);
  const spent = await plannedWithConditions(meleeStrikeDefinition(), {attackRoll: {total: 5, natural: 1, die: 1}, extraActors: [{...diviner,
    flags: {wildpath: {portent: {1: 0, 2: 0}}}}]});
  assert.equal(spent.state.pendingRequests.length, 0, "no dice left");
});

test("damage reactions for another creature: Interception reduces an ally's damage, Cloud Rune moves it to a third creature", async t => {
  const reaction = (id, rider, triggerPredicate) => ({id, type: "action", name: id, system: {active: true,
    definition: {schemaVersion: 1, id: `action:${id}`, label: id, costs: {allOf: [{capability: ECONOMY_CAPABILITIES.REACTION, amount: 1}]},
      range: {type: "self"}, targeting: {type: "self"}, rider},
    ruleElements: [{schemaVersion: 1, id: "reaction", type: "Trigger", data: {kind: "reaction", event: "damage.applied",
      match: {phase: "before", tagsAll: ["hit"], notSourceTokenId: "{self}"}, triggerPredicate}}]}});
  const near = feet => [{equals: {path: "toTarget.{self}.sees", value: true}}, {atMost: {path: "toTarget.{self}.distance", value: feet}}];

  // Interception: its bystander beside the target takes 4 off the 6 the target takes.
  const intercept = reaction("interception", {reduceDamage: {dice: {type: "constant", value: 4}}, protects: "target"},
    {all: [...near(5), {not: {equals: {path: "toTarget.{self}.self", value: true}}}]});
  const guarded = counterattackFixture(t, {reactor: "bystander", holderItems: [intercept]});
  const declared = await guarded.player.declareActionIntent(guarded.intent);
  const record = guarded.gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.equal(guarded.offers.length, 1, "offered to the creature beside the target");
  assert.equal(guarded.targetActor.system.resources.health.value, 28, "6 less 4");
  assert.equal(guarded.holder.system.resources.health.value, 20, "its own health untouched");

  // Cloud Rune: the damage goes to the one other creature within 30 ft of its rune knight.
  const rune = reaction("cloud-rune", {redirectDamage: {to: "chosen", range: 30}, protects: "target"}, {all: near(30)});
  const moved = counterattackFixture(t, {reactor: "bystander", holderItems: [rune]});
  const decoy = withFoundryActorSystem(fakeActor("decoy", {system: {...targetActorSystem(), resources: {health: {value: 20, max: 20}}}}));
  const decoyToken = fakeTokenDocument({id: "decoy-token", actor: decoy, scene: moved.scene, offset: {i: 0, j: 3}});
  Object.assign(decoy, {uuid: `${decoyToken.uuid}.Actor.decoy`, isToken: true, token: decoyToken, tokens: [decoyToken]});
  // It concentrates on something: taking the damage instead, it makes the check a target would.
  const held = {id: "held", name: "Held", flags: {wildpath: {conditionEffect: {concentration: {sourceRef: "token:decoy-token"}}}}};
  decoy.effects = [{...held, toObject: () => structuredClone(held)}];
  moved.scene.tokens.push(decoyToken);
  const redirected = await moved.player.declareActionIntent(moved.intent);
  const after = moved.gm.getRecord(redirected.resolutionId);
  assert.equal(after.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(after.state.errors).slice(0, 1500));
  assert.deepEqual([moved.targetActor.system.resources.health.value, decoy.system.resources.health.value], [30, 14],
    "the target takes nothing; the decoy takes the 6");
  assert.match(JSON.stringify(after.state.results.concentrationResolution ?? null), /decoy/u, "the decoy makes a concentration check");

  // 2024 Cloud Rune: the decoy becomes the attack's target "using the same roll": 22 misses its AC 25.
  const sameRoll = reaction("cloud-rune", {redirectDamage: {to: "chosen", range: 30, sameRoll: true}, protects: "target"}, {all: near(30)});
  const armored = counterattackFixture(t, {reactor: "bystander", holderItems: [sameRoll]});
  const knight = withFoundryActorSystem(fakeActor("knight", {system: {...targetActorSystem(20, 20, {ac: 25})}}));
  const knightToken = fakeTokenDocument({id: "knight-token", actor: knight, scene: armored.scene, offset: {i: 0, j: 3}});
  Object.assign(knight, {uuid: `${knightToken.uuid}.Actor.knight`, isToken: true, token: knightToken, tokens: [knightToken]});
  armored.scene.tokens.push(knightToken);
  const missed = armored.gm.getRecord((await armored.player.declareActionIntent(armored.intent)).resolutionId);
  assert.equal(missed.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(missed.state.errors).slice(0, 1500));
  assert.deepEqual([armored.targetActor.system.resources.health.value, knight.system.resources.health.value], [30, 20],
    "the attack becomes the knight's and misses: nobody takes the 6");
  // Q114 default: its AC with its cover from the attacker. Behind the rune knight it has Half cover: 22 hits its AC 20 + 2;
  // with its own Three-Quarters cover (20 + 5) it misses.
  const covered = async statuses => {
    const fixture = counterattackFixture(t, {reactor: "bystander", holderItems: [sameRoll]});
    const decoyKnight = withFoundryActorSystem(fakeActor("knight", {system: {...targetActorSystem(20, 20, {ac: 20})}}));
    const token = fakeTokenDocument({id: "knight-token", actor: decoyKnight, scene: fixture.scene, offset: {i: 0, j: 3}});
    Object.assign(decoyKnight, {uuid: `${token.uuid}.Actor.knight`, isToken: true, token, tokens: [token], statuses: new Set(statuses)});
    fixture.scene.tokens.push(token);
    const record = fixture.gm.getRecord((await fixture.player.declareActionIntent(fixture.intent)).resolutionId);
    assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
    return [record.state.input.durability?.redirectsByTarget?.["target-token"]?.sameRollAgainst ?? null,
      decoyKnight.system.resources.health.value, fixture.targetActor.system.resources.health.value];
  };
  assert.deepEqual([await covered([]), await covered(["coverThreeQuarters"]), await covered(["coverTotal"])],
    [[22, 14, 30], [25, 20, 30], [null, 20, 24]],
    "Half cover: 22 against 22 lands the 6; Three-Quarters: 22 against 25 misses; Total: never offered, the target takes it");

  // `notHostile` (the Golden Goblin Bicuspid's "an ally"): a creature hostile to its reactor is never offered; an ally is.
  const allies = reaction("bicuspid", {redirectDamage: {to: "chosen", range: 30, notHostile: true}, protects: "target"}, {all: near(30)});
  const picky = counterattackFixture(t, {reactor: "bystander", holderItems: [allies]});
  const foe = withFoundryActorSystem(fakeActor("foe", {system: {...targetActorSystem(), resources: {health: {value: 20, max: 20}}}}));
  const foeToken = fakeTokenDocument({id: "foe-token", actor: foe, scene: picky.scene, offset: {i: 0, j: 2}});
  Object.assign(foe, {uuid: `${foeToken.uuid}.Actor.foe`, isToken: true, token: foeToken, tokens: [foeToken]});
  picky.scene.tokens.push(foeToken);
  const kept = picky.gm.getRecord((await picky.player.declareActionIntent(picky.intent)).resolutionId);
  assert.equal(kept.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(kept.state.errors).slice(0, 1500));
  assert.deepEqual([picky.targetActor.system.resources.health.value, foe.system.resources.health.value], [24, 20],
    "only a hostile creature near: nobody to move it to, the target takes the 6");
  // Q47: then it is not offered, and its Reaction is not spent.
  assert.deepEqual([picky.offers.length, picky.holder.system.resources.reaction.value], [0, 1]);
  const friendly = counterattackFixture(t, {reactor: "bystander", holderItems: [allies]});
  const ally = withFoundryActorSystem(fakeActor("ally", {system: {...targetActorSystem(), resources: {health: {value: 20, max: 20}}}}));
  const allyToken = fakeTokenDocument({id: "ally-token", actor: ally, scene: friendly.scene, offset: {i: 0, j: 2}, disposition: 1});
  Object.assign(ally, {uuid: `${allyToken.uuid}.Actor.ally`, isToken: true, token: allyToken, tokens: [allyToken]});
  friendly.scene.tokens.push(allyToken);
  const moved2 = friendly.gm.getRecord((await friendly.player.declareActionIntent(friendly.intent)).resolutionId);
  assert.equal(moved2.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(moved2.state.errors).slice(0, 1500));
  assert.deepEqual([friendly.targetActor.system.resources.health.value, ally.system.resources.health.value], [30, 14], "the ally takes it");
});

test("redirect recipients (Q47): the sizes it allows, nobody to take it spending nothing, a neutral creature until it turns hostile", async t => {
  const bicuspid = spec => ({id: "bicuspid", type: "action", name: "bicuspid", system: {active: true,
    definition: {schemaVersion: 1, id: "action:bicuspid", label: "bicuspid", costs: {allOf: [{capability: ECONOMY_CAPABILITIES.REACTION, amount: 1}]},
      range: {type: "self"}, targeting: {type: "self"}, rider: {redirectDamage: spec, protects: "target"}},
    ruleElements: [{schemaVersion: 1, id: "reaction", type: "Trigger", data: {kind: "reaction", event: "damage.applied",
      match: {phase: "before", tagsAll: ["hit"], notSourceTokenId: "{self}"}}}]}});
  const smallOrMedium = {to: "chosen", range: 30, notHostile: true, eligible: {oneOf: {path: "size", values: ["small", "medium"]}}};
  // The bystander's reaction, with another creature 10 ft from it of `size` and `disposition`.
  const run = async ({spec=smallOrMedium, size="medium", disposition=1, setup=() => {}}={}) => {
    const fixture = counterattackFixture(t, {reactor: "bystander", holderItems: [bicuspid(spec)]});
    const other = withFoundryActorSystem(fakeActor("other", {size, system: {...targetActorSystem(), resources: {health: {value: 20, max: 20}}}}));
    const token = fakeTokenDocument({id: "other-token", actor: other, scene: fixture.scene, offset: {i: 0, j: 3}, disposition});
    Object.assign(other, {uuid: `${token.uuid}.Actor.other`, isToken: true, token, tokens: [token]});
    fixture.scene.tokens.push(token);
    await setup(fixture);
    const record = fixture.gm.getRecord((await fixture.player.declareActionIntent(fixture.intent)).resolutionId);
    assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
    return [fixture.offers.length, fixture.holder.system.resources.reaction.value, fixture.targetActor.system.resources.health.value,
      other.system.resources.health.value];
  };
  assert.deepEqual(await run(), [1, 0, 30, 14], "a Medium ally takes the 6");
  assert.deepEqual(await run({size: "small"}), [1, 0, 30, 14], "a Small one too");
  assert.deepEqual(await run({size: "large"}), [0, 1, 24, 20], "a Large ally only: not offered, nothing spent");
  assert.deepEqual(await run({size: "tiny"}), [0, 1, 24, 20], "nor a Tiny one");
  assert.deepEqual(await run({spec: {...smallOrMedium, eligible: {equals: {path: "actor.system.details.subtype", value: "goblinoid"}}}}),
    [0, 1, 24, 20], "a creature type its predicate asks for (how Q111 would map \"another goblin\")");
  // Offered, but nobody may take it when it is paid for (the ally fell meanwhile): it fails, spending nothing, and the hit lands.
  const stale = fixture => {
    const provider = fixture.game.wildpath.reactionServices;
    fixture.game.wildpath.reactionServices = context => {
      const services = provider(context);
      const read = services.reactions?.context;
      return read ? {...services, reactions: {...services.reactions, context: input => ({...read(input),
        redirectable: {"bystander-token-bicuspid-reaction": true}})}} : services;
    };
  };
  assert.deepEqual(await run({size: "large", setup: stale}), [1, 1, 24, 20], "taken, failed, its Reaction kept");
  // A neutral creature counts as an ally, until the Combat records it turned hostile to the bystander's side.
  assert.deepEqual(await run({disposition: 0}), [1, 0, 30, 14]);
  const fighting = sides => fixture => {
    const previous = globalThis.game;
    globalThis.game = fixture.game;
    t.after(() => { globalThis.game = previous; });
    fixture.game.combats = [{started: true, combatants: fixture.scene.tokens.map(token => ({tokenId: token.id, sceneId: fixture.scene.id})),
      flags: {wildpath: {turnedHostile: {"other-token": sides}}}}];
  };
  assert.deepEqual(await run({disposition: 0, setup: fighting([1])}), [0, 1, 24, 20], "turned hostile to its side: no ally near");
  assert.deepEqual(await run({disposition: 0, setup: fighting([-1])}), [1, 0, 30, 14], "turned hostile to the other side only");
});

test("Redirect Attack's swap (rider.swap): its creature and the ally its redirect picked swap places once the attack resolves (Q49)", async t => {
  const redirect = swap => ({id: "redirect", type: "action", name: "Redirect Attack", system: {active: true,
    definition: {schemaVersion: 1, id: "action:redirect-attack", label: "Redirect Attack",
      costs: {allOf: [{capability: ECONOMY_CAPABILITIES.REACTION, amount: 1}]}, range: {type: "self"}, targeting: {type: "self"},
      rider: {redirectDamage: {to: "chosen", range: 5, sameRoll: true, notHostile: true}, protects: "target", ...(swap ? {swap: true} : {})}},
    ruleElements: [{schemaVersion: 1, id: "reaction", type: "Trigger", data: {kind: "reaction", event: "damage.applied",
      match: {phase: "before", tagsAll: ["hit"], targetTokenId: "{self}", notSourceTokenId: "{self}"}}}]}});
  const run = async swap => {
    const fixture = counterattackFixture(t, {holderItems: [redirect(swap)]});
    // An ally of the goblin (its disposition) 5 feet from it (AC 10: the same roll hits it too).
    const ally = withFoundryActorSystem(fakeActor("ally", {system: {...targetActorSystem(20, 20, {ac: 10})}}));
    const token = fakeTokenDocument({id: "ally-token", actor: ally, scene: fixture.scene, offset: {i: 2, j: 0}, disposition: -1});
    Object.assign(ally, {uuid: `${token.uuid}.Actor.ally`, isToken: true, token, tokens: [token]});
    fixture.scene.tokens.push(token);
    const record = fixture.gm.getRecord((await fixture.player.declareActionIntent(fixture.intent)).resolutionId);
    assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
    return [fixture.targetActor.system.resources.health.value, ally.system.resources.health.value, record.state.input.riderSwap ?? null];
  };
  assert.deepEqual(await run(true), [30, 14, {"target-token": "ally-token"}],
    "the ally takes the hit, and the two swap after the attack (the teleport adapter moves them on the active GM)");
  assert.deepEqual(await run(false), [30, 14, null], "without the key the redirect alone");
});

test("a neutral creature's attack: hostile for its own reads from the start, recorded on the Combat once it completes (Q47, Q110 (b))", async t => {
  // A Warding Flare-shaped reaction: a hostile creature within 30 feet declares an attack roll.
  const flare = {id: "flare", type: "action", name: "Flare", system: {active: true,
    definition: {schemaVersion: 1, id: "action:flare", label: "Flare", costs: {allOf: [{capability: ECONOMY_CAPABILITIES.REACTION, amount: 1}]},
      range: {type: "self"}, targeting: {type: "self"}, rider: {addRollMode: "disadvantage"}},
    ruleElements: [{schemaVersion: 1, id: "reaction", type: "Trigger", data: {kind: "reaction", event: "action.declared",
      match: {phase: "interrupt", notSourceTokenId: "{self}"}, triggerPredicate: {all: [
        {equals: {path: "toSource.{self}.hostile", value: true}}, {atMost: {path: "toSource.{self}.distance", value: 30}}]}}}]}};
  // Dark One's Blessing's shape on the attacker: Temporary Hit Points for dropping a hostile creature.
  const blessing = {id: "blessing", type: "feature", name: "Blessing", system: {active: true, ruleElements: [{schemaVersion: 1, id: "blessing",
    type: "Trigger", data: {event: "health.reduced", temporaryHitPoints: {type: "constant", value: 5}, hostileOnly: true}}]}};
  const run = async ({combat=true, payable=true}={}) => {
    const fixture = counterattackFixture(t, {reactor: "bystander", holderItems: [flare]});
    // The attacker is neutral; its target is on the bystander's side.
    fixture.sourceToken.disposition = 0;
    fixture.targetToken.disposition = 1;
    fixture.sourceActor.items = new (class extends Map { [Symbol.iterator]() { return this.values(); } })([...fixture.sourceActor.items.entries(),
      ["blessing", blessing]]);
    if ( !payable ) fixture.sourceActor.system.resources.action.value = 0;
    const previous = globalThis.game;
    globalThis.game = fixture.game;
    t.after(() => { globalThis.game = previous; });
    const fight = {started: true, flags: {}, combatants: fixture.scene.tokens.map(token => ({tokenId: token.id, sceneId: fixture.scene.id})),
      async setFlag(scope, key, value) { this.flags = {...this.flags, [scope]: {...this.flags[scope], [key]: value}}; }};
    fixture.game.combats = combat ? [fight] : [];
    const record = fixture.gm.getRecord((await fixture.player.declareActionIntent(fixture.intent)).resolutionId);
    // Nothing is written while it is planned or resolved: only the runtime's afterCompleted records it.
    const planned = fight.flags.wildpath?.turnedHostile ?? null;
    const fromUuid = async ref => (ref === fixture.sourceToken.uuid ? fixture.sourceToken : null);
    if ( record.state.status === RESOLUTION_STATE_STATUS.COMPLETED ) await recordAttackHostility({state: record.state}, {game: fixture.game, fromUuid});
    return {status: record.state.status, offers: fixture.offers.length, planned, recorded: fight.flags.wildpath?.turnedHostile ?? null,
      hostileKeys: record.options?.durability?.onReduce?.hostileKeys ?? null};
  };
  assert.deepEqual(await run(), {status: RESOLUTION_STATE_STATUS.COMPLETED, offers: 1, planned: null, recorded: {"source-token": [1]},
    hostileKeys: ["target-token"]}, "its very first attack is a hostile creature's, for the flare and the blessing alike");
  assert.deepEqual(await run({combat: false}), {status: RESOLUTION_STATE_STATUS.COMPLETED, offers: 0, planned: null, recorded: null,
    hostileKeys: []}, "outside combat it stays neutral");
  // One refused when it is paid for (no Action left) never happened: nothing recorded.
  const refused = await run({payable: false});
  assert.notEqual(refused.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.deepEqual([refused.planned, refused.recorded], [null, null]);
  // Nobody attacked (no attack resolution): nothing to record.
  assert.equal(await recordAttackHostility({state: {source: {tokenRef: "x"}, results: {}}}, {fromUuid: async () => null}), false);
});

test("Glorious Defense: the paladin's Charisma modifier (at least 1) off an ally's hit, which is checked again", async t => {
  // The converted shape (REACTIONS "glorious-defense"): a fixed penalty worked out by the reactor, on the attacker.
  const glorious = {id: "glorious", type: "action", name: "Glorious Defense", system: {active: true,
    definition: {schemaVersion: 1, id: "action:glorious", label: "Glorious Defense", costs: {allOf: [{capability: ECONOMY_CAPABILITIES.REACTION, amount: 1}]},
      range: {type: "special"}, targeting: {type: "single", required: true, count: 1},
      rider: {attackPenalty: {dice: {type: "constant", value: 0}, bonus: {type: "max", terms: [{type: "constant", value: 1},
        {type: "ability-modifier", ability: "presence"}]}}}},
    ruleElements: [{schemaVersion: 1, id: "reaction", type: "Trigger", data: {kind: "reaction", event: "attack.hit",
      match: {phase: "interrupt", notSourceTokenId: "{self}"}, triggerPredicate: {all: [{equals: {path: "toTarget.{self}.sees", value: true}},
        {atMost: {path: "toTarget.{self}.distance", value: 10}}]}}}]}};
  const defended = async ({paladin, ally, total}) => {
    const fixture = counterattackFixture(t, {reactor: "bystander", holderItems: [glorious],
      queue: Array.from({length: 4}, () => ({natural: total - 4, total}))});
    fixture.holder.system.abilities = {presence: {value: paladin}};
    fixture.targetActor.system.abilities = {presence: {value: ally}};
    const record = fixture.gm.getRecord((await fixture.player.declareActionIntent(fixture.intent)).resolutionId);
    assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
    assert.equal(fixture.offers.length, 1, "offered to the paladin");
    return [record.state.results.attackResolution.hits.length, fixture.targetActor.system.resources.health.value];
  };
  assert.deepEqual(await defended({paladin: 16, ally: 10, total: 15}), [0, 30], "15 less the paladin's +3 is 12 against AC 14: a miss");
  assert.deepEqual(await defended({paladin: 12, ally: 20, total: 16}), [1, 24], "the paladin's +1, not the ally's +5: 15 still hits");
});

/**
 * A ranger (the attacker) with the converted Superior Hunter's Prey, its target carrying a Hunter's Mark from `markedBy`
 * (the ranger by default), and other creatures at `others` ({id: rows below the target}: 5 ft a row); `preyItems`, the
 * one named prey's reactions; `preyState`, it hidden by the GM ("hidden") or already dead ("dead").
 */
async function huntersPreyFixture(t, {markedBy=null, others={prey: 3, far: 12}, natural=null, preyItems=null, preyState=null, retarget=null,
  types={}}={}) {
  const fs = await import("node:fs");
  // The converted feature: its reaction is its own Trigger carrying the Action (no Action Item to use by hand).
  const file = fs.readdirSync("packs/_source/srd-items").find(name => name.startsWith("superior-hunter-s-prey-"));
  const item = JSON.parse(fs.readFileSync(`packs/_source/srd-items/${file}`, "utf8"));
  if ( retarget ) item.system.ruleElements[0].data.action.retarget = retarget;
  const fixture = counterattackFixture(t, {reactor: "source", items: [{id: item._id, type: item.type, name: item.name, system: item.system}],
    natural, queue: [{natural: natural ?? 18, total: (natural ?? 18) + 4}, {total: 4}],
    // The ranger's weapon damage bonus (a Dueling): its attack's, not the mark's die.
    extra: [{id: "dueling", expression: {type: "constant", value: 2}}]});
  const mark = {id: "mark", name: "Hunter's Mark", statuses: new Set(["hunters-mark"]),
    flags: {wildpath: {conditionEffect: {sourceRef: markedBy ?? fixture.sourceActor.uuid}}}};
  fixture.targetActor.effects = [mark];
  const creatures = Object.fromEntries(Object.entries(others).map(([id, rows]) => {
    const actor = withFoundryActorSystem(fakeActor(id, {system: {...targetActorSystem(), resources: {health: {value: 20, max: 20},
      reaction: {value: 1, max: 1}}}}));
    if ( (id === "prey") && preyItems ) actor.items = preyItems;
    if ( types[id] ) actor.system.details = {...actor.system.details, type: types[id]};
    const token = fakeTokenDocument({id: `${id}-token`, actor, scene: fixture.scene, offset: {i: 1, j: rows}});
    Object.assign(actor, {uuid: `${token.uuid}.Actor.${id}`, isToken: true, token, tokens: [token]});
    if ( (id === "prey") && (preyState === "hidden") ) token.hidden = true;
    if ( (id === "prey") && (preyState === "dead") ) actor.statuses = new Set(["dead"]);
    fixture.scene.tokens.push(token);
    return [id, actor];
  }));
  const declared = await fixture.player.declareActionIntent(fixture.intent);
  return {...fixture, creatures, record: fixture.gm.getRecord(declared.resolutionId)};
}

const preyRolls = requests => requests.filter(request => request.definition?.dice?.[0]?.id === "damage-1:die:0")
  .map(request => `${request.definition.dice[0].number}d${request.definition.dice[0].faces}`);

for ( const critical of [false, true] ) test(`Superior Hunter's Prey: a hit on its own Hunter's Mark sends the mark's die to another creature within 30 ft, once a turn${critical ? "; a Critical Hit doesn't double it" : ""}`, async t => {
  const previous = globalThis.game;
  globalThis.game = {combat: {id: "c", round: 1, turn: 0, started: true}};
  t.after(() => { globalThis.game = previous; });
  const {record, offers, targetActor, sourceActor, creatures, playerRollRequests} = await huntersPreyFixture(t, {natural: critical ? 20 : null});
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.equal(offers.length, 1, "offered to the ranger's controller");
  assert.deepEqual(preyRolls(playerRollRequests), ["1d6"], "the mark's die, not doubled: the second creature isn't the attack's target");
  assert.equal((record.state.results.reactions ?? []).some(entry => entry.childFailed), false);
  assert.deepEqual([targetActor.system.resources.health.value, creatures.prey.system.resources.health.value, creatures.far.system.resources.health.value],
    [22, 16, 20], "the target takes only the attack's 6 + 2; the creature 15 ft away the 4 (no Dueling on it); the one 60 ft away nothing");
  assert.equal(sourceActor.flags?.wildpath?.onceUsed?.["superior-hunters-prey"], "c:1:0", "its use is recorded for this turn");
});

test("Superior Hunter's Prey: the creature its die moves to is the one asked about the damage coming (a Stone's Endurance)", async t => {
  const guard = {id: "guard", type: "action", name: "Guard", system: {active: true, definition: {schemaVersion: 1, id: "action:guard",
    label: "Guard", costs: {allOf: [{capability: ECONOMY_CAPABILITIES.REACTION, amount: 1}]}, range: {type: "self"}, targeting: {type: "self"},
    rider: {reduceDamage: {dice: {type: "constant", value: 3}}}},
  ruleElements: [{schemaVersion: 1, id: "reaction", type: "Trigger", data: {kind: "reaction", event: "damage.applied",
    match: {phase: "before", targetTokenId: "{self}"}}}]}};
  const {record, offers, creatures} = await huntersPreyFixture(t, {preyItems: [guard]});
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.equal(offers.length, 2, "the ranger's, then the second creature's own");
  assert.deepEqual([creatures.prey.system.resources.health.value, creatures.prey.system.resources.reaction.value], [19, 0], "4 less 3");
});

test("Superior Hunter's Prey: not offered for another creature's mark, nor with nobody else within 30 ft (Q47); the hit still lands", async t => {
  const {record, offers} = await huntersPreyFixture(t, {markedBy: "Actor.another-ranger"});
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(offers.length, 0, "the mark isn't its own");

  const alone = await huntersPreyFixture(t, {others: {far: 12}});
  assert.equal(alone.record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(alone.record.state.errors).slice(0, 1500));
  assert.equal(alone.offers.length, 0, "nobody to move the die to: not offered");
  assert.deepEqual(preyRolls(alone.playerRollRequests), [], "no die rolled for nobody");
  assert.deepEqual([alone.targetActor.system.resources.health.value, alone.creatures.far.system.resources.health.value], [22, 20]);
});

test("a retarget's `eligible`: only the creatures its predicate admits are offered and picked (Q47)", async t => {
  const previous = globalThis.game;
  globalThis.game = {combat: {id: "c", round: 1, turn: 0, started: true}};
  t.after(() => { globalThis.game = previous; });
  const undead = {range: 30, eligible: {equals: {path: "actor.system.details.type", value: "undead"}}};
  const picked = await huntersPreyFixture(t, {others: {prey: 3, other: 4, far: 12}, retarget: undead, types: {other: "undead", far: "undead"}});
  assert.equal(picked.record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(picked.record.state.errors).slice(0, 1500));
  assert.deepEqual([picked.offers.length, ...[picked.creatures.prey, picked.creatures.other, picked.creatures.far]
    .map(actor => actor.system.resources.health.value)], [1, 20, 16, 20], "the one Undead within 30 ft takes it, unasked");
  const none = await huntersPreyFixture(t, {retarget: undead, types: {far: "undead"}});
  assert.deepEqual([none.offers.length, none.creatures.prey.system.resources.health.value], [0, 20], "none within 30 ft: not offered");
});

for ( const preyState of ["hidden", "dead"] ) test(`Superior Hunter's Prey: a ${preyState} creature within 30 ft isn't one its die can move to`, async t => {
  const previous = globalThis.game;
  globalThis.game = {combat: {id: "c", round: 1, turn: 0, started: true}};
  t.after(() => { globalThis.game = previous; });
  const {record, creatures} = await huntersPreyFixture(t, {others: {prey: 3, other: 4, far: 12}, preyState});
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.deepEqual([creatures.prey, creatures.other, creatures.far].map(actor => actor.system.resources.health.value), [20, 16, 20],
    "the only other creature in range takes it, unasked");
});

test("Rod of Lordly Might's Drain Life (converted): a reaction to its own hit heals its user half the Necrotic damage of the failed save", async t => {
  const fs = await import("node:fs");
  const item = JSON.parse(fs.readFileSync("packs/_source/srd-items/rod-of-lordly-might-drain-life-11s9q2m1aai2eq00.json", "utf8"));
  const fixture = counterattackFixture(t, {reactor: "source", items: [{id: item._id, type: item.type, name: item.name, system: item.system}]});
  fixture.sourceActor.system.pools = [{id: "rod-of-lordly-might-drain-life", value: 1, max: 1}];
  fixture.sourceActor.system.resources.health.value = 10;
  const declared = await fixture.player.declareActionIntent(fixture.intent);
  const record = fixture.gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.equal(fixture.offers.length, 1, "offered on its own hit");
  assert.deepEqual([fixture.targetActor.system.resources.health.value, fixture.sourceActor.system.resources.health.value], [15, 14],
    "the target fails DC 17 with 15: 6 from the hit and 9 Necrotic; its user regains 4, half of 9 rounded down");
});

test("Superior Hunter's Prey: nothing to use straight from the sheet; its reaction is its feature's own Trigger", async () => {
  const fs = await import("node:fs");
  const files = fs.readdirSync("packs/_source/srd-items").filter(name => name.startsWith("superior-hunter-s-prey-"));
  assert.equal(files.length, 1, "no Action Item beside the feature");
  const feature = JSON.parse(fs.readFileSync(`packs/_source/srd-items/${files[0]}`, "utf8"));
  const trigger = feature.system.ruleElements.find(rule => rule.type === "Trigger");
  assert.deepEqual([feature.type, trigger.data.event, trigger.data.action.retarget], ["feature", "damage.applied", {range: 30}]);
});

/**
 * A cleric (the attacker, Wisdom 16) with the converted Improved Blessed Strikes and, unless `option` is false, its Potent
 * Spellcasting option; its attack a cantrip unless `cantrip` is false; other creatures at `others` ({id: rows below the
 * cleric}: 5 ft a row). `choose`: the Token its controller picks for the Temporary Hit Points.
 */
async function potentSpellcastingFixture(t, {option=true, cantrip=true, others={ally: 3, far: 14}, choose=null, targetChoice=null}={}) {
  const improved = convertItem({_id: "phbclcImprovedBl", name: "Improved Blessed Strikes", type: "feat", img: "icons/svg/item-bag.svg",
    effects: [], system: {source: {license: "CC-BY-4.0", rules: "2024", book: ""}, identifier: "improved-blessed-strikes",
      type: {value: "class"}, description: {value: "<p>Rule text.</p>"}, activities: {}}}).items[0];
  const potent = {id: "potent", type: "feature", name: "Potent Spellcasting", system: {active: true, ruleElements: []},
    flags: {wildpath: {source: {identifier: "blessed-strikes-potent-spellcasting"}}}};
  const fixture = counterattackFixture(t, {reactor: "source", queue: [{natural: 18, total: 22}], choose,
    items: [{id: improved._id, type: improved.type, name: improved.name, system: improved.system, flags: improved.flags},
      ...(option ? [potent] : [])]});
  if ( cantrip ) fixture.action.system.definition.tags = ["spell", "cantrip"];
  if ( targetChoice ) improved.system.ruleElements[0].data.action.targetChoice = targetChoice;
  fixture.sourceActor.system.abilities = {wits: {value: 16}};
  const creatures = Object.fromEntries(Object.entries(others).map(([id, rows]) => {
    const actor = withFoundryActorSystem(fakeActor(id, {system: {...targetActorSystem(), resources: {health: {value: 20, max: 20}}}}));
    const token = fakeTokenDocument({id: `${id}-token`, actor, scene: fixture.scene, offset: {i: 0, j: rows}});
    Object.assign(actor, {uuid: `${token.uuid}.Actor.${id}`, isToken: true, token, tokens: [token]});
    fixture.scene.tokens.push(token);
    return [id, actor];
  }));
  const declared = await fixture.player.declareActionIntent(fixture.intent);
  return {...fixture, creatures, record: fixture.gm.getRecord(declared.resolutionId)};
}

test("Potent Spellcasting (Improved Blessed Strikes): after its cantrip's damage, Temporary Hit Points to a creature its controller picks within 60 ft", async t => {
  const {record, offers, asked, creatures, sourceActor, targetActor} = await potentSpellcastingFixture(t, {choose: "ally-token"});
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.equal(offers.length, 1, "offered to the cleric's controller");
  assert.deepEqual(asked.map(request => request.payload.options.map(option => option.value)),
    [["source-token", "target-token", "ally-token"]], "itself first, then every creature within 60 ft, the one it damaged too");
  assert.equal(creatures.ally.system.resources.health.temp, 6, "twice its Wisdom modifier");
  assert.deepEqual([sourceActor, targetActor, creatures.far].map(actor => actor.system.resources.health.temp ?? 0), [0, 0, 0],
    "nobody else, not the creature its child was built on");
  assert.equal(targetActor.system.resources.health.value, 24, "the cantrip's own damage lands");

  // Only the creature it damaged within 60 ft: still asked, between it and itself.
  const alone = await potentSpellcastingFixture(t, {others: {far: 14}});
  assert.equal(alone.record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(alone.record.state.errors).slice(0, 1500));
  assert.equal(alone.asked.length, 1, "the creature it damaged is still one to pick");
  assert.equal(alone.sourceActor.system.resources.health.temp, 6, "the default is itself");
});

test("Potent Spellcasting's pick: one candidate is taken unasked; with none it is not offered; a pick no longer a candidate fails the reaction", async t => {
  // Without itself, only the creature it damaged is within 60 ft.
  const one = await potentSpellcastingFixture(t, {others: {far: 14}, targetChoice: {from: "creatures", range: 60}});
  assert.equal(one.record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(one.record.state.errors).slice(0, 1500));
  assert.deepEqual([one.asked.length, one.targetActor.system.resources.health.temp, one.sourceActor.system.resources.health.temp ?? 0],
    [0, 6, 0]);

  // Within 1 ft of it: nobody, not even the creature it damaged 5 ft away, so it is not offered (Q47).
  const none = await potentSpellcastingFixture(t, {targetChoice: {from: "creatures", range: 1}});
  assert.equal(none.record.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.deepEqual([none.offers.length, none.asked.length], [0, 0]);
  assert.deepEqual([none.sourceActor, none.targetActor, none.creatures.ally].map(actor => actor.system.resources.health.temp ?? 0),
    [0, 0, 0]);

  // Its pick is hidden before the answer is resumed: no other creature takes its place.
  const stale = await potentSpellcastingFixture(t, {choose: (request, scene) => {
    scene.tokens.find(token => token.id === "ally-token").hidden = true;
    return "ally-token";
  }});
  assert.equal(stale.asked.length, 1);
  assert.equal((stale.record.state.results.reactions ?? []).some(entry => entry.childFailed), true, "it fails");
  assert.deepEqual([stale.sourceActor, stale.targetActor, stale.creatures.ally].map(actor => actor.system.resources.health.temp ?? 0),
    [0, 0, 0], "not the first candidate in its place");
});

test("a reaction's fixed target (targetChoice.from): itself, or the creature its event names, unasked; a malformed one is refused", async t => {
  const self = await potentSpellcastingFixture(t, {targetChoice: {from: "self"}});
  assert.equal(self.record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(self.record.state.errors).slice(0, 1500));
  assert.deepEqual([self.asked.length, self.sourceActor.system.resources.health.temp], [0, 6]);
  const damaged = await potentSpellcastingFixture(t, {targetChoice: {from: "trigger-target"}});
  assert.equal(damaged.record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(damaged.record.state.errors).slice(0, 1500));
  assert.deepEqual([damaged.asked.length, damaged.targetActor.system.resources.health.temp, damaged.sourceActor.system.resources.health.temp ?? 0],
    [0, 6, 0]);

  // A misspelt source, or picking creatures with no positive range, is refused rather than falling back.
  const paths = targetChoice => validateActionDefinition({schemaVersion: 1, id: "action:x", label: "X", targetChoice}).errors.map(entry => entry.path);
  assert.deepEqual([paths({from: "trigger_source"}), paths({from: "creatures"}), paths({from: "creatures", range: "far"}),
    paths({from: "creatures", range: 60}), paths({from: "self"}), paths({from: "around"})],
    [["targetChoice.from"], ["targetChoice.range"], ["targetChoice.range"], [], [], []]);
});

test("Potent Spellcasting (Improved Blessed Strikes): only with that option, and only after a cantrip", async t => {
  for ( const settings of [{option: false}, {cantrip: false}] ) {
    const {record, offers} = await potentSpellcastingFixture(t, settings);
    assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
    assert.equal(offers.length, 0, JSON.stringify(settings));
  }
});

/**
 * A caster (the source, its player's) casts `tags` (its Action's, with a level 1 slot unless `slot` is false) at the
 * target; its feature's `action.completed` Trigger (`trigger`, its Item's reaction setting `policy`) is run by the GM's
 * dispatcher, as the runtime's afterCompleted does (reportActionCompleted), awaited here. Another creature, `ally` (the
 * GM's, +5 to Presence saves), stands 15 ft away and `far` 70 ft. `choose`: the Token its player picks for a `targetChoice`.
 * `follow`: the follow-ups run as the runtime runs them (actionCompletedFollowUps, not awaited; each kept in `followUps`);
 * `waitRoll`: awaited before each of its player's rolls.
 */
async function afterCastFixture(t, {tags=["spell", "school:enchantment"], slot=true, slots=1, trigger, choose=null,
  policy="always", pools=[], prepare=null, definition=null, actions=[], playerTotal=10, logger=undefined, follow=false,
  waitRoll=null, configure=null}={}) {
  const spell = definition ?? {schemaVersion: 1, id: "action:charm", label: "Charm", tags,
    costs: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}, ...(slot ? [{capability: "spell-slot.1", amount: 1}] : [])]},
    range: {type: "ranged", normal: {value: 60, unit: "ft"}}, targeting: {type: "single", required: true, count: 1},
    damage: [{id: "bolt", expression: {type: "constant", value: 1}, damageType: "psychic", provenance: "spell-base"}]};
  const fixture = syntheticRuntimeFixture(t, spell, {targetHealth: 30});
  const {scene, sourceActor, game} = fixture;
  scene.tokens.get = id => scene.tokens.find(token => token.id === id);
  sourceActor.system.pools = [{id: "spell-slot.1", value: slots, max: 1}, ...pools];
  const feature = {id: "after-cast", type: "feature", name: "After Cast", system: {active: true,
    ruleElements: [{schemaVersion: 1, id: "after-cast", type: "Trigger", data: trigger}]}, flags: {wildpath: {reactionPolicy: policy}}};
  sourceActor.items.set(feature.id, feature);
  for ( const item of actions ) sourceActor.items.set(item.id, item);
  sourceActor.items[Symbol.iterator] = function* () { yield* this.values(); };
  const creatures = Object.fromEntries(Object.entries({ally: 3, far: 14}).map(([id, rows]) => {
    const actor = withFoundryActorSystem(fakeActor(id, {system: {...targetActorSystem(), resources: {health: {value: 20, max: 20}}},
      statistics: {"save.presence": runtimeStatistic("save.presence", 5)}, owners: []}));
    const token = fakeTokenDocument({id: `${id}-token`, actor, scene, offset: {i: 0, j: rows}});
    Object.assign(actor, {uuid: `${token.uuid}.Actor.${id}`, isToken: true, token, tokens: [token]});
    scene.tokens.push(token);
    return [id, actor];
  }));
  // Foundry finds them by uuid too (syntheticRuntimeFixture restores its own fromUuid afterwards).
  const found = globalThis.fromUuid;
  globalThis.fromUuid = async ref => Object.values(creatures).find(actor => actor.uuid === ref) ?? found(ref);
  for ( const user of game.users.values() ) user.active = user.id !== "player-b";
  game.user = game.users.get("gm-a");
  game.users.activeGM = game.user;
  const persistencePort = createTestDocumentPersistenceAdapter();
  const hub = createTestResolutionTransportHub({users: [{id: "gm-a", active: true, isGM: true, isActiveGM: true},
    {id: "player-a", active: true, isGM: false}]});
  const completed = [];
  const followUps = [];
  const gmRollRequests = [];
  const asked = [];
  // The chat cards it would post, by resolution id.
  const posted = [];
  // Its Token, by uuid, as Foundry's fromUuid finds it.
  const tokenOf = async uuid => scene.tokens.find(token => token.uuid === uuid) ?? null;
  const gmProvider = createTestRollProvider({result: {natural: 10, total: 15}});
  let automation = null;
  const playerProvider = createTestRollProvider({result: {natural: playerTotal, total: playerTotal}});
  const playerRolls = waitRoll ? {...playerProvider, execute: request => waitRoll(request).then(() => playerProvider.execute(request))}
    : playerProvider;
  const gm = createMultiplayerActionCoordinator({userId: "gm-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}),
    rollProviders: [{...gmProvider, execute: request => { gmRollRequests.push(request); return gmProvider.execute(request); }}],
    publishResult: post => { posted.push(post.resolutionId); },
    afterCompleted: async event => {
      completed.push(event);
      if ( !follow ) return void await reportActionCompleted(event, {automation, fromUuid: tokenOf});
      followUps.push(actionCompletedFollowUps(event, {automation, fromUuid: tokenOf, onError: error => { throw error; }}));
      return followUps.at(-1);
    },
    actionIntentResolver: ({intent, envelope}) => foundryActionIntentToStagedOptions({intent, senderUserId: envelope.senderUserId,
      game, persistencePort})});
  automation = createFoundryAutomationDispatcher({game, coordinator: gm, fromUuid: globalThis.fromUuid, logger,
    resolveAction: options => foundryActionIntentToStagedOptions({...options, game, persistencePort})});
  const player = createMultiplayerActionCoordinator({userId: "player-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "player-a"}), rollProviders: [playerRolls],
    promptPorts: [createTestPromptAdapter({id: "after-cast-choice", queue: Array.from({length: 8}, () => request => {
      asked.push(request);
      // Its "you can" (an Action's configuration), as offered (or as `configure` answers it); then the creature it picks.
      if ( (request.type === "action-configuration") && configure ) return configure(request);
      if ( request.type === "action-configuration" ) return {choices: Object.fromEntries(request.payload.requests
        .map(entry => [entry.id, entry.defaultValue]))};
      return {choices: {[request.payload.id]: choose ?? request.payload.defaultValue}};
    })})]});
  gm.register();
  player.register();
  // The scene as it stands when the spell is cast (a creature dead, Unaffected).
  prepare?.({...fixture, ...creatures});
  const declared = await player.declareActionIntent(fixture.intent);
  return {...fixture, ...creatures, declared, record: gm.getRecord(declared.resolutionId), completed, asked, gmRollRequests, automation, tokenOf,
    persistencePort, gm, player, followUps, posted};
}

/** A Beguiling Magic-shaped Trigger: after an Enchantment or Illusion spell cast with a slot, a save by a creature picked within 60 ft. */
const AFTER_CAST_SAVE = Object.freeze({kind: "automation", event: "action.completed",
  match: {tagsAll: ["cast", "slot"], tagsAny: ["school:enchantment", "school:illusion"]},
  action: {schemaVersion: 1, id: "action:after-cast", label: "After Cast", costs: {allOf: []}, range: {type: "ranged", normal: {value: 60, unit: "ft"}},
    targeting: {type: "single", required: true, count: 1}, targetChoice: {from: "creatures", range: 60},
    save: {ability: "presence", dc: {value: 30}},
    damage: [{id: "rider", expression: {type: "constant", value: 5}, damageType: "psychic", provenance: "feature-base",
      saveOutcomePolicy: {success: "none", failure: "full"}}]}});

test("action.completed: an automatic Trigger's cost and restore worked out from the event read the spell's level", async t => {
  const level = {type: "context", path: "event.data.castLevel"};
  const definition = {schemaVersion: 1, id: "action:charm", label: "Charm", tags: ["spell", "school:enchantment"], metadata: {spellLevel: 2},
    costs: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]},
    range: {type: "ranged", normal: {value: 60, unit: "ft"}}, targeting: {type: "single", required: true, count: 1},
    damage: [{id: "bolt", expression: {type: "constant", value: 1}, damageType: "psychic", provenance: "spell-base"}]};
  const trigger = {kind: "automation", event: "action.completed", match: {tagsAll: ["cast"]},
    action: {schemaVersion: 1, id: "action:ward", label: "Ward", range: {type: "self"}, targeting: {type: "self"},
      costs: {allOf: [{capability: "charges", amount: 1, amountExpression: level}]},
      restores: [{resourceId: "ward", amount: 1, amountExpression: level}]}};
  const {record, sourceActor} = await afterCastFixture(t, {trigger, definition, slot: false,
    pools: [{id: "charges", value: 5, max: 5}, {id: "ward", value: 0, max: 10}]});
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  const pool = id => sourceActor.system.pools.find(entry => entry.id === id)?.value;
  assert.deepEqual([pool("charges"), pool("ward")], [3, 2], "2 spent and 2 gained: the event reaches an automatic Trigger's Action");
});

test("action.completed: after its creature's own cast, its Trigger acts on the creature its player picks, which rolls its own save", async t => {
  const {record, completed, asked, ally, far, targetActor, sourceActor, gmRollRequests, automation, tokenOf} = await afterCastFixture(t, {trigger: AFTER_CAST_SAVE,
    choose: "ally-token"});
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.equal(targetActor.system.resources.health.value, 29, "the spell itself lands");
  assert.deepEqual(asked.map(request => request.payload.options.map(option => option.value)), [["target-token", "ally-token"]],
    "every creature within 60 ft but itself, asked of its player");
  assert.equal(ally.system.resources.health.value, 15, "the creature picked fails its save and takes the rider");
  assert.deepEqual([targetActor.system.resources.health.value, far.system.resources.health.value, sourceActor.system.resources.health?.value],
    [29, 20, undefined], "nobody else");
  const save = gmRollRequests.find(request => request.type === "saving-throw");
  assert.deepEqual(save?.modifiers?.map(entry => entry.value), [5], "its own Presence save bonus, prepared as a target before the pick");
  // The follow-up is the authority's: it completes but reports nothing itself, so it never answers its own completion.
  assert.deepEqual(completed.map(event => event.used), [true, false]);

  // The same completion again (a duplicate dispatch) runs nothing: its run is keyed by the completed resolution.
  await reportActionCompleted(completed[0], {automation, fromUuid: tokenOf});
  assert.deepEqual([ally.system.resources.health.value, asked.length], [15, 1], "once, however often its completion is reported");
});

test("action.completed: a Trigger answers only the casts its tags name; a Trigger without tags never answers its own follow-up", async t => {
  for ( const [settings, why] of [[{tags: ["spell", "school:evocation"]}, "another school"], [{slot: false}, "no slot spent"],
    [{tags: ["school:enchantment"]}, "not a spell"]] ) {
    const {record, completed, ally, asked} = await afterCastFixture(t, {trigger: AFTER_CAST_SAVE, choose: "ally-token", ...settings});
    assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, why);
    assert.deepEqual([completed.length, asked.length, ally.system.resources.health.value], [1, 0, 20], why);
  }
  // "You can" (a `use` choice, its Item set to Ask) is asked of the player whose cast it follows, before the pick.
  const use = {id: "use", type: "option", label: "Use", required: true, defaultValue: "use", options: [{id: "use", label: "Use it", value: "use"},
    {id: "decline", label: "Not now", value: "decline"}], effects: [{type: "decline"}]};
  const asking = await afterCastFixture(t, {trigger: {...AFTER_CAST_SAVE, action: {...AFTER_CAST_SAVE.action, configuration: [use]}},
    choose: "ally-token", policy: "ask"});
  assert.deepEqual([asking.asked.map(request => request.type), asking.ally.system.resources.health.value],
    [["action-configuration", "choice"], 15]);
  const any = await afterCastFixture(t, {trigger: {...AFTER_CAST_SAVE, match: {}}, choose: "ally-token"});
  assert.deepEqual([any.completed.length, any.ally.system.resources.health.value], [2, 15], "its follow-up ran once, and only once");
  // No slot to pay with: the cast fails and reports nothing.
  const failed = await afterCastFixture(t, {trigger: AFTER_CAST_SAVE, choose: "ally-token", slots: 0});
  assert.notEqual(failed.record?.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.deepEqual([failed.completed.length, failed.ally.system.resources.health.value], [0, 20]);
});

test("action.completed: nothing asked when it can't be paid for or nobody it may pick lives; only a prepared creature is picked; the spell's own target", async t => {
  const use = {id: "use", type: "option", label: "Use", required: true, defaultValue: "use", options: [{id: "use", label: "Use it", value: "use"},
    {id: "decline", label: "Not now", value: "decline"}], effects: [{type: "decline"}]};
  const paid = {...AFTER_CAST_SAVE, action: {...AFTER_CAST_SAVE.action, costs: {allOf: [{capability: "after-cast", amount: 1}]},
    configuration: [use]}};
  // Its pool spent (once per Long Rest): skipped, not asked "you can" and the pick only to be refused.
  const spent = await afterCastFixture(t, {trigger: paid, choose: "ally-token", policy: "ask", pools: [{id: "after-cast", value: 0, max: 1}]});
  assert.equal(spent.record.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.deepEqual([spent.asked.length, spent.completed.length, spent.ally.system.resources.health.value], [0, 1, 20]);
  const ready = await afterCastFixture(t, {trigger: paid, choose: "ally-token", policy: "ask", pools: [{id: "after-cast", value: 1, max: 1}]});
  assert.deepEqual([ready.asked.length, ready.ally.system.resources.health.value], [2, 15], "with a use left, as before");

  // Only dead creatures within range: skipped as when nobody is there, not asked and then refused.
  const dead = await afterCastFixture(t, {trigger: {...AFTER_CAST_SAVE, action: {...AFTER_CAST_SAVE.action, configuration: [use]}},
    choose: "ally-token", policy: "ask", prepare: ({ally, targetActor}) => {
      for ( const actor of [ally, targetActor] ) actor.statuses = new Set(["dead"]);
    }});
  assert.equal(dead.record.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.deepEqual([dead.asked.length, dead.completed.length], [0, 1]);

  // A creature in range but not prepared with its save (Unaffected by it) is never offered: the save would roll without
  // its bonus and roll modes.
  const unprepared = await afterCastFixture(t, {trigger: AFTER_CAST_SAVE, choose: "ally-token", prepare: ({ally}) => {
    ally.unaffectingRule = () => ({id: "unaffected"});
  }});
  assert.deepEqual([unprepared.asked.length, unprepared.ally.system.resources.health.value, unprepared.targetActor.system.resources.health.value],
    [0, 20, 24], "only the spell's target was prepared, so it takes the rider");

  // `trigger-target`: the completed Action's own target, not its caster.
  const onTarget = await afterCastFixture(t, {trigger: {kind: "automation", event: "action.completed", match: {tagsAll: ["cast"]},
    action: {schemaVersion: 1, id: "action:after-cast-target", label: "After Cast", costs: {allOf: []},
      range: {type: "ranged", normal: {value: 60, unit: "ft"}}, targeting: {type: "single", required: true, count: 1},
      targetChoice: {from: "trigger-target"},
      damage: [{id: "rider", expression: {type: "constant", value: 5}, damageType: "psychic", provenance: "feature-base"}]}}});
  assert.deepEqual([onTarget.targetActor.system.resources.health.value, onTarget.ally.system.resources.health.value,
    onTarget.sourceActor.system.resources.health?.value], [24, 20, undefined]);
});

/** A "when you cast" rider (Q24): AFTER_CAST_SAVE on `action.cast`, which a countered cast reaches too. */
const WHEN_CAST_SAVE = Object.freeze({...AFTER_CAST_SAVE, event: "action.cast"});

/** The fixture's cast as a counter left it (cancelled, nothing paid), reported as the coordinator's afterCancelled is. */
const counteredCast = (fixture, id, code="COUNTERED") => ({resolutionId: id, used: true, initiatorUserId: "player-a",
  options: {actor: fixture.sourceActor}, state: {...fixture.record.state, id, status: RESOLUTION_STATE_STATUS.CANCELLED, results: {},
    warnings: [{code, reason: "Counterspell stopped it."}]}});

test("action.cast: a completed cast runs its \"when you cast\" Trigger once, as it runs an \"after\" one", async t => {
  const {record, ally, completed, automation, tokenOf} = await afterCastFixture(t, {trigger: WHEN_CAST_SAVE, choose: "ally-token"});
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.equal(ally.system.resources.health.value, 15, "the creature picked fails its save and takes the rider");
  await reportActionCompleted(completed[0], {automation, fromUuid: tokenOf});
  assert.equal(ally.system.resources.health.value, 15, "once, however often its completion is reported");
});

test("action.cast: a countered cast still runs a \"when you cast\" Trigger, as cast with the slot it would have spent; never an \"after\" one (Q24, Q97)", async t => {
  const when = await afterCastFixture(t, {trigger: WHEN_CAST_SAVE, choose: "ally-token"});
  const slot = when.sourceActor.system.pools.find(pool => pool.id === "spell-slot.1");
  // Its Action back, as when a counter answers (before the cast is paid for); its slot spent by the completed cast, so a
  // countered one now would have had none to be cast with.
  when.sourceActor.system.resources.action.value = 1;
  assert.equal(slot.value, 0);
  assert.deepEqual(counteredCastEvent(counteredCast(when, "countered:0")).tags.filter(tag => ["cast", "slot", "countered"].includes(tag)),
    ["cast", "countered"]);
  slot.value = 1;
  const cast = counteredCastEvent(counteredCast(when, "countered:1"));
  assert.deepEqual(cast.tags.filter(tag => ["cast", "slot", "countered"].includes(tag)), ["cast", "slot", "countered"],
    "the slot that would have paid, though a counter spends none (Q97 (b) default)");
  assert.equal(slot.value, 1, "worked out, not spent");
  await reportCountered(counteredCast(when, "countered:1"), cast, {automation: when.automation, fromUuid: when.tokenOf});
  assert.equal(when.ally.system.resources.health.value, 10, "its rider runs on the countered cast");
  await reportCountered(counteredCast(when, "countered:1"), cast, {automation: when.automation, fromUuid: when.tokenOf});
  assert.equal(when.ally.system.resources.health.value, 10, "keyed by the countered resolution: once");

  // An "after you cast" Trigger: the counter never reaches it.
  const after = await afterCastFixture(t, {trigger: AFTER_CAST_SAVE, choose: "ally-token"});
  after.sourceActor.system.pools.find(pool => pool.id === "spell-slot.1").value = 1;
  after.sourceActor.system.resources.action.value = 1;
  const afterCast = counteredCastEvent(counteredCast(after, "countered:2"));
  assert.deepEqual(await reportCountered(counteredCast(after, "countered:2"), afterCast, {automation: after.automation, fromUuid: after.tokenOf}), []);
  assert.equal(after.ally.system.resources.health.value, 15, "only its completed cast's rider");

  // A GM's cancel, or a countered Action that is no cast, reports nothing (Q97 (c) default).
  assert.equal(counteredCastEvent(counteredCast(when, "cancelled:1", "RESOLUTION_CANCELLED_BY_GM")), null);
  const strike = counteredCast(when, "countered:3");
  strike.state.actionDefinition = {...strike.state.actionDefinition, tags: ["weapon"]};
  assert.equal(counteredCastEvent(strike), null);
});

test("reportActionCompleted: a completed cast reports action.cast before action.completed, under one key; anything else only action.completed", async () => {
  const dispatched = [];
  const automation = {dispatch: async (type, event) => { dispatched.push([type, event.key]); return []; }};
  const actor = {id: "a", uuid: "Actor.a"};
  await reportActionCompleted({resolutionId: "cast:1", options: {actor}, state: {id: "cast:1", actionDefinition: {id: "action:charm",
    tags: ["spell"]}, source: {}}}, {automation, fromUuid: async () => null});
  await reportActionCompleted({resolutionId: "strike:1", options: {actor}, state: {id: "strike:1", actionDefinition: {id: "action:strike",
    tags: ["weapon"]}, source: {}}}, {automation, fromUuid: async () => null});
  assert.deepEqual(dispatched, [["action.cast", "cast:1"], ["action.completed", "cast:1"], ["action.completed", "strike:1"]]);
});

/** A Faithful Hound-shaped Trigger: as its creature's turn starts, a save by one creature around it its controller picks. */
const TURN_PICK = Object.freeze({kind: "automation", event: "turn.started", around: {radius: 20, affects: "others"},
  action: {...AFTER_CAST_SAVE.action, id: "action:turn-pick", targetChoice: {from: "around"}}});

test("turn.started: one of those its around reaches, picked by its creature's owner (not the GM listed first), only that one takes it", async t => {
  const use = {id: "use", type: "option", label: "Use", required: true, defaultValue: "use", options: [{id: "use", label: "Use it", value: "use"},
    {id: "decline", label: "Not now", value: "decline"}], effects: [{type: "decline"}]};
  const {asked, ally, far, targetActor, sourceActor, sourceToken, automation} = await afterCastFixture(t,
    {trigger: {...TURN_PICK, action: {...TURN_PICK.action, configuration: [use]}}, choose: "ally-token", policy: "ask"});
  const states = await automation.dispatch("turn.started", {actor: sourceActor, token: sourceToken});
  assert.deepEqual(states.map(state => state.status), [RESOLUTION_STATE_STATUS.COMPLETED],
    "not cancelled waiting on a GM who has no say in it");
  assert.deepEqual(asked.map(request => request.type), ["action-configuration", "choice"], "its \"you can\" and its pick, asked of its player");
  assert.deepEqual(asked[1].payload.options.map(option => option.value), ["target-token", "ally-token"], "only those within 20 feet");
  assert.deepEqual([ally.system.resources.health.value, targetActor.system.resources.health.value, far.system.resources.health.value],
    [15, 29, 20], "the one picked fails its save; nobody else");
});

test("turn.started: another creature's aura with a \"can\" (on: \"others\") is asked of that aura's owner, not the GM listed first", async t => {
  const use = {id: "use", type: "option", label: "Use", required: true, defaultValue: "use", options: [{id: "use", label: "Use it", value: "use"},
    {id: "decline", label: "Not now", value: "decline"}], effects: [{type: "decline"}]};
  const {targetChoice: _picked, ...lethargy} = AFTER_CAST_SAVE.action;
  const {asked, targetActor, targetToken, automation} = await afterCastFixture(t, {policy: "ask", trigger: {kind: "automation",
    event: "turn.started", around: {radius: 20, affects: "others", on: "others"}, action: {...lethargy, id: "action:lethargy", configuration: [use]}}});
  const states = await automation.dispatch("turn.started", {actor: targetActor, token: targetToken});
  assert.deepEqual(states.map(state => state.status), [RESOLUTION_STATE_STATUS.COMPLETED], "not cancelled waiting on the GM");
  assert.deepEqual(asked.map(request => request.type), ["action-configuration"], "its \"can\", asked of the aura's player");
  assert.equal(targetActor.system.resources.health.value, 24, "the creature starting its turn there fails its save");
});

test("a declined \"you can\" does nothing: its save is never rolled, on a creature it reaches or one it picks", async t => {
  const notNow = {id: "use", type: "option", label: "Use", required: true, defaultValue: "decline", options: [{id: "use", label: "Use it", value: "use"},
    {id: "decline", label: "Not now", value: "decline"}], effects: [{type: "decline"}]};
  const {targetChoice: _picked, ...lethargy} = AFTER_CAST_SAVE.action;
  const aura = await afterCastFixture(t, {policy: "ask", trigger: {kind: "automation", event: "turn.started",
    around: {radius: 20, affects: "others", on: "others"}, action: {...lethargy, id: "action:lethargy", configuration: [notNow]}}});
  const states = await aura.automation.dispatch("turn.started", {actor: aura.targetActor, token: aura.targetToken});
  assert.deepEqual(states.map(state => state.status), [RESOLUTION_STATE_STATUS.COMPLETED]);
  assert.deepEqual(aura.asked.map(request => request.type), ["action-configuration"]);
  assert.deepEqual([aura.gmRollRequests.length, aura.targetActor.system.resources.health.value], [0, 29], "no save rolled, no damage");

  const hound = await afterCastFixture(t, {trigger: {...TURN_PICK, action: {...TURN_PICK.action, configuration: [notNow]}},
    choose: "ally-token", policy: "ask"});
  const bitten = await hound.automation.dispatch("turn.started", {actor: hound.sourceActor, token: hound.sourceToken});
  assert.deepEqual(bitten.map(state => state.status), [RESOLUTION_STATE_STATUS.COMPLETED]);
  // shortcut: its pick (targetChoice) is still asked, the declined Action keeping whom it is aimed at, as before; upgrade
  // by skipping the pick of an Action that does nothing.
  assert.deepEqual(hound.asked.map(request => request.type), ["action-configuration", "choice"]);
  assert.deepEqual([hound.gmRollRequests.length, hound.ally.system.resources.health.value, hound.targetActor.system.resources.health.value],
    [0, 20, 29], "the one picked rolls no save and takes nothing");
});

test("a declined \"you can\" keeps nothing the runtime prepared from its Action as written: no concentration ended, no area left or moved, no teleport, no check's effect spent", async t => {
  const {configuredOptions} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const notNow = {id: "use", type: "option", label: "Use", required: true, defaultValue: "decline", options: [{id: "use", label: "Use it", value: "use"},
    {id: "decline", label: "Not now", value: "decline"}], effects: [{type: "decline"}]};
  const {targetChoice: _picked, ...lethargy} = AFTER_CAST_SAVE.action;
  const aura = await afterCastFixture(t, {policy: "ask", trigger: {kind: "automation", event: "turn.started",
    around: {radius: 20, affects: "others", on: "others"}, action: {...lethargy, id: "action:lethargy", configuration: [notNow],
      check: {skill: "athletics", dc: {value: 15}},
      effects: [{id: "slowed", type: "condition", conditionId: "prone", saveOutcomePolicy: "failure", concentration: true}]}}});
  const states = await aura.automation.dispatch("turn.started", {actor: aura.targetActor, token: aura.targetToken});
  assert.deepEqual(states.map(state => state.status), [RESOLUTION_STATE_STATUS.COMPLETED]);
  const declined = aura.completed.at(-1);
  assert.ok(Array.isArray(declined.options.endsConcentration), "the runtime prepared its concentration from the Action as written");
  assert.equal(configuredOptions(declined).endsConcentration, undefined, "declined: its caster's earlier concentration is not ended");
  // afterCompleted spends an "ends when it checks" effect (endEffectsWhenChecked) on the check the state's input carries.
  assert.deepEqual([Boolean(declined.options.check), declined.state.input?.check ?? null, Boolean(declined.state.results?.checkResolution)],
    [true, null, false], "its check was prepared from the Action as written but is not carried, nor made");

  // Each option prepared for a part its configured definition no longer has is dropped; one it still has stays.
  const options = {actor: "actor", endsConcentration: ["Effect.haste"], persistentArea: {sceneId: "s"}, areaMove: {regionId: "r"},
    teleport: {tokenId: "t"}};
  const used = {area: {shape: "sphere", size: 20, persistence: {concentration: true}}, moveArea: {distance: 20}, teleport: {distance: 30}};
  assert.deepEqual(configuredOptions({options, state: {actionDefinition: used}}), options, "used: all kept");
  assert.deepEqual(configuredOptions({options, state: {actionDefinition: {area: {shape: "sphere", size: 20}}}}), {actor: "actor"},
    "declined: only what is not a part");
  assert.equal(configuredOptions({options, state: {}}), options, "no definition: unchanged");
});

test("turn.started: a pick around it takes the only one there unasked, and runs nothing when nobody it may pick is there", async t => {
  // Only the creature beside it (an enemy within 5 feet): taken without asking.
  const lone = await afterCastFixture(t, {trigger: {...TURN_PICK, around: {radius: 5, affects: "enemies"}},
    prepare: ({sourceToken}) => { sourceToken.disposition = 1; }});
  await lone.automation.dispatch("turn.started", {actor: lone.sourceActor, token: lone.sourceToken});
  assert.deepEqual([lone.asked.length, lone.targetActor.system.resources.health.value], [0, 24]);
  // Its ally beside it (the hound's caster) is no enemy: nothing runs.
  const friendly = await afterCastFixture(t, {trigger: {...TURN_PICK, around: {radius: 5, affects: "enemies"}},
    prepare: ({sourceToken, targetToken}) => { sourceToken.disposition = targetToken.disposition = 1; }});
  assert.deepEqual(await friendly.automation.dispatch("turn.started", {actor: friendly.sourceActor, token: friendly.sourceToken}), []);
  assert.equal(friendly.targetActor.system.resources.health.value, 29);
  // Everyone it reaches dead: nothing runs, nothing is asked.
  const dead = await afterCastFixture(t, {trigger: TURN_PICK, prepare: ({ally, targetActor}) => {
    for ( const actor of [ally, targetActor] ) actor.statuses = new Set(["dead"]);
  }});
  assert.deepEqual(await dead.automation.dispatch("turn.started", {actor: dead.sourceActor, token: dead.sourceToken}), []);
  assert.equal(dead.asked.length, 0);
});

test("turn.started: a pick around it (the Faithful Hound's bite) is no aura: a wall still keeps its one enemy out (Q37)", async t => {
  const hound = await afterCastFixture(t, {trigger: {...TURN_PICK, around: {radius: 5, affects: "enemies"}},
    prepare: ({sourceToken}) => { sourceToken.disposition = 1; }});
  walled(t, hound.scene);
  await hound.automation.dispatch("turn.started", {actor: hound.sourceActor, token: hound.sourceToken});
  assert.equal(hound.targetActor.system.resources.health.value, 29, "Total Cover from the wall: not bitten");
});

test("actionCompletedEvent: cast, slot and Metamagic tags; a follow-up of a spell already cast is no cast", () => {
  const state = (definition, {choices={}, paid=[]}={}) => ({id: "resolution:x", actionDefinition: definition, targets: [{actorId: "a", tokenId: "t"}],
    configuration: {choices, castingLevel: 2}, results: {paymentResolution: {paymentPlan: {resources: paid.map(resourceId => ({resourceId}))}}}});
  const spell = {id: "action:sleep", tags: ["spell", "school:enchantment"], metadata: {spellLevel: 1}};
  const event = actionCompletedEvent({state: state(spell, {choices: {metamagic: "transmuted-fire", empowered: "no"}, paid: ["spell-slot.2"]})});
  assert.deepEqual(event.tags, ["spell", "school:enchantment", "spell:leveled", "id:action:sleep", "cast", "slot", "metamagic",
    "metamagic:transmuted"]);
  assert.deepEqual([event.targets, event.data], [[{actorId: "a", tokenId: "t"}], {actionDefinitionId: "action:sleep", castLevel: 2,
    resolutionId: "resolution:x"}]);
  assert.deepEqual(actionCompletedEvent({state: state(spell, {choices: [{id: "metamagic", value: "none"}, {id: "empowered", value: "empowered"}],
    paid: ["spell-slot.pact"]})}).tags.slice(-4), ["cast", "slot", "metamagic", "metamagic:empowered"]);
  const flameBladeAttack = {...spell, configuration: [{id: "spell-level", fromCast: true, options: []}]};
  assert.equal(actionCompletedEvent({state: state(flameBladeAttack)}).tags.includes("cast"), false);
  // A follow-up that does not scale has no such choice, only its mark (Dispel Evil and Good's Dismissal).
  assert.equal(actionCompletedEvent({state: state({...spell, metadata: {followUp: true}})}).tags.includes("cast"), false);
  assert.deepEqual(actionCompletedEvent({state: state({id: "action:strike", tags: ["weapon"]})}).tags.filter(tag => ["cast", "slot"].includes(tag)), []);
  // Its cast level is action.declared's (castLevelOf): the spell's own with no slot chosen (a 1/Day spell, a cantrip),
  // null for no spell.
  const unslotted = definition => actionCompletedEvent({state: {actionDefinition: definition, configuration: {}}}).data.castLevel;
  assert.deepEqual([unslotted({...spell, metadata: {spellLevel: 3}}), unslotted({...spell, metadata: {spellLevel: 0}}),
    unslotted({id: "action:strike", tags: ["weapon"]})], [3, 0, null]);
});

test("reportActionCompleted: a completed move (no ActionDefinition) dispatches nothing", async () => {
  const dispatched = [];
  const automation = {dispatch: (...args) => { dispatched.push(args); return []; }};
  assert.deepEqual(await reportActionCompleted({resolutionId: "move:1", options: {actor: {id: "a", uuid: "Actor.a"}},
    state: {id: "move:1", source: {tokenRef: "Scene.s.Token.t"}}}, {automation, fromUuid: async () => null}), []);
  await reportActionCompleted({resolutionId: "use:1", options: {actor: {id: "a", uuid: "Actor.a"}},
    state: {id: "use:1", actionDefinition: {id: "action:strike", tags: ["weapon"]}, source: {}}}, {automation, fromUuid: async () => null});
  assert.equal(dispatched.length, 1, "an Action still reports");
  // Its Triggers run, but never hold its creature: only Actions its drawn options use do (Q27).
  const followed = actionCompletedFollowUps({resolutionId: "use:2", options: {actor: {id: "a", uuid: "Actor.a"}},
    state: {id: "use:2", actionDefinition: {id: "action:strike", tags: ["weapon"]}, source: {}}}, {automation, fromUuid: async () => null});
  assert.equal(followed.holdUntil, undefined);
  await followed.reported;
  assert.equal(dispatched.length, 2);
});

/** An Eye Rays-shaped Action: its 1d4 draws one of two rays, each another Action of its creature (`useAction`). */
const drawsRays = (bolt="action:bolt") => ({schemaVersion: 1, id: "action:eye-rays", label: "Eye Rays",
  costs: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]}, range: {type: "ranged", normal: {value: 120, unit: "ft"}},
  targeting: {type: "single", required: true, count: 1},
  configuration: [{id: "drawn", type: "option", label: "Eye Rays", required: true, options: [
    {id: "zap", label: "Zap", range: [1, 2], useAction: "action:zap"}, {id: "bolt", label: "Bolt", range: [3, 4], useAction: bolt}]}],
  draw: {choiceId: "drawn", formula: "1d4"}});
const rayItem = (id, definition) => ({id, type: "action", name: `Eye Rays (${definition.label})`, system: {active: true,
  definition: {schemaVersion: 1, range: {type: "ranged", normal: {value: 120, unit: "ft"}}, targeting: {type: "single", required: true, count: 1},
    ...definition}}});
// Bolt costs its own pool and an Action, Zap its Action: used by a draw, neither is paid.
const RAYS = Object.freeze([rayItem("zap-item", {id: "action:zap", label: "Zap", costs: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]},
  damage: [{id: "zap", expression: {type: "constant", value: 7}, damageType: "fire", provenance: "feature-base"}]}),
rayItem("bolt-item", {id: "action:bolt", label: "Bolt", costs: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1},
  {capability: "bolt-uses", amount: 1}]}, save: {ability: "presence", dc: {value: 30}},
damage: [{id: "bolt", expression: {type: "constant", value: 5}, damageType: "psychic", provenance: "feature-base",
  saveOutcomePolicy: {success: "none", failure: "full"}}]})]);

test("useAction: a drawn option uses another of its creature's Actions at the creature that drew it, paying nothing, once", async t => {
  const told = [];
  const {record, completed, targetActor, sourceActor, automation, tokenOf, scene} = await afterCastFixture(t, {definition: drawsRays(),
    actions: structuredClone(RAYS), playerTotal: 3, pools: [{id: "bolt-uses", value: 1, max: 1}],
    logger: {warn: (...args) => told.push(args.join(" ")), info: () => {}, error: () => {}}});
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.deepEqual(record.state.results.drawResolution.byTarget, {all: ["bolt"]});
  assert.equal(targetActor.system.resources.health.value, 25, "Bolt's failed save lands; Zap, not drawn, does nothing");
  assert.equal(sourceActor.system.pools.find(pool => pool.id === "bolt-uses").value, 1, "Bolt's own cost is not paid");
  // Its save is its target's controller's to roll, asked on behalf of the user whose Eye Rays it follows.
  assert.deepEqual(completed[1].state.rollRequests.map(request => [request.type, request.chooser]), [["saving-throw", "target-controller"]]);
  assert.deepEqual(completed.map(event => [event.used, event.initiatorUserId]), [[true, "player-a"], [false, "player-a"]]);
  assert.equal(completed[1].state.actionDefinition.id, "action:bolt");

  await reportActionCompleted(completed[0], {automation, fromUuid: tokenOf});
  assert.deepEqual([targetActor.system.resources.health.value, completed.length], [25, 2], "once, however often its completion is reported");

  // Its target gone from the scene before the ray runs (another completion of it): the GM is told, and the ray never
  // turns on its own creature instead.
  scene.tokens.splice(scene.tokens.findIndex(token => token.actor === targetActor), 1);
  await reportActionCompleted({...completed[0], resolutionId: "eye-rays:again"}, {automation, fromUuid: tokenOf});
  assert.deepEqual([completed.length, told.filter(line => line.includes("WILDPATH.NOTICE.UsedActionFailed")).length], [2, 1], told.join("\n"));

  // An Action its creature lacks: the GM is told, and nothing runs in its place.
  const warned = [];
  const missing = await afterCastFixture(t, {definition: drawsRays("action:missing"), actions: structuredClone(RAYS), playerTotal: 4,
    logger: {warn: (...args) => warned.push(args.join(" "))}});
  assert.equal(missing.record.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.deepEqual([missing.targetActor.system.resources.health.value, missing.completed.length], [30, 1]);
  assert.equal(warned.some(line => line.includes("WILDPATH.NOTICE.UsedActionFailed")), true, warned.join("\n"));
});

test("useAction: its creature's next Action waits until the drawn ray and its follow-ups have resolved, or the GM cancels the ray (Q27)", async t => {
  const guard = "This creature is still resolving another Action.";
  for ( const end of ["save", "cancel"] ) {
    let reached, release;
    const atSave = new Promise(resolve => { reached = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const fixture = await afterCastFixture(t, {definition: drawsRays(), actions: structuredClone(RAYS), playerTotal: 3, follow: true,
      waitRoll: request => { if ( request.type !== "saving-throw" ) return Promise.resolve(); reached(); return gate; }});
    const {record, completed, followUps, gm, player, sourceActor, targetActor, targetToken, action, declared} = fixture;
    const again = () => player.declareActionIntent(buildFoundryActionUseIntent({actor: sourceActor, action,
      game: {user: {targets: new Set([{document: targetToken}])}}}).intent);
    const refused = () => gm.errors.filter(entry => entry?.error?.reason === guard).length;
    await atSave;
    assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, end);
    assert.equal(typeof followUps[0].holdUntil?.then, "function", "the drawn ray holds its creature");
    await again();
    assert.equal(refused(), 1, `${end}: Eye Rays again is refused while its ray waits on its target's save`);
    const ray = gm.getRecord(`${declared.resolutionId}:use:action:bolt`);
    // Cancelled, the Player's late save (the test transport waits on it) changes nothing.
    if ( end === "cancel" ) assert.equal((await gm.cancelResolution(ray.resolutionId)).code, "RESOLUTION_CANCELLED_BY_GM");
    release();
    await followUps[0].holdUntil;
    await followUps[0].reported;
    for ( let tick = 0; (tick < 50) && ray.followingUp; tick++ ) await new Promise(resolve => setImmediate(resolve));
    assert.equal(targetActor.system.resources.health.value, end === "save" ? 25 : 30, end);
    assert.deepEqual(completed.map(event => event.state.actionDefinition.id), end === "save" ? ["action:eye-rays", "action:bolt"]
      : ["action:eye-rays"], end);
    const next = await again();
    assert.equal(refused(), 1, `${end}: once the ray is done, its creature acts again`);
    assert.notEqual(gm.getRecord(next.resolutionId), null, "it resolves (its one Action is spent)");
  }
});

test("useAction: a drawing Action a Trigger runs uses its Action too; one targeting itself runs on its creature; an area one is the GM's", async t => {
  // After its cast, a Trigger draws a ray at the spell's target (no user's own Action): the ray still runs.
  const trigger = {kind: "automation", event: "action.completed", match: {tagsAll: ["cast"]},
    action: {...drawsRays(), id: "action:surge", costs: {allOf: []}, targetChoice: {from: "trigger-target"}}};
  const surged = await afterCastFixture(t, {trigger, actions: structuredClone(RAYS), playerTotal: 3});
  assert.equal(surged.record.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.deepEqual(surged.completed.map(event => [event.state.actionDefinition.id, event.used]),
    [["action:charm", true], ["action:surge", false], ["action:bolt", false]]);
  assert.equal(surged.targetActor.system.resources.health.value, 24, "the spell's 1, then the drawn Bolt's 5");

  // A ray a Trigger's draw uses never holds its creature: its next Action is taken while that ray waits on a save (Q27).
  let reached, release;
  const atSave = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = await afterCastFixture(t, {trigger, actions: structuredClone(RAYS), playerTotal: 3, follow: true, slots: 2,
    waitRoll: request => { if ( request.type !== "saving-throw" ) return Promise.resolve(); reached(); return gate; }});
  await atSave;
  assert.deepEqual(waiting.completed.map(event => event.state.actionDefinition.id), ["action:charm", "action:surge"],
    "the drawn Bolt waits on its target's save");
  const next = await waiting.player.declareActionIntent(buildFoundryActionUseIntent({actor: waiting.sourceActor, action: waiting.action,
    game: {user: {targets: new Set([{document: waiting.targetToken}])}}}).intent);
  assert.equal(waiting.gm.errors.some(entry => entry?.error?.reason === "This creature is still resolving another Action."), false);
  assert.notEqual(waiting.gm.getRecord(next.resolutionId), null, "its next Action is taken");
  release();
  await Promise.all(waiting.followUps.map(followUp => followUp.reported));

  // A ray whose own targeting is itself lands on its creature, not on the creature the draw was aimed at.
  const ward = rayItem("ward-item", {id: "action:bolt", label: "Ward", targeting: {type: "self"}, costs: {allOf: []},
    damage: [{id: "ward", expression: {type: "constant", value: 3}, damageType: "fire", provenance: "feature-base"}]});
  const warded = await afterCastFixture(t, {definition: drawsRays(), actions: [structuredClone(RAYS[0]), ward], playerTotal: 3,
    prepare: ({sourceActor}) => { sourceActor.system.resources.health = {value: 20, max: 20}; }});
  assert.deepEqual(warded.completed.map(event => event.state.actionDefinition.id), ["action:eye-rays", "action:bolt"]);
  assert.deepEqual(warded.completed[1].state.targets.map(target => target.actorId), [warded.sourceActor.id]);
  assert.deepEqual([warded.sourceActor.system.resources.health.value, warded.targetActor.system.resources.health.value], [17, 30]);

  // One covering an area needs placing by its user: the GM is told, and nothing runs.
  const told = [];
  const blast = rayItem("blast-item", {id: "action:bolt", label: "Blast", targeting: {type: "area"}, costs: {allOf: []},
    area: {shape: "radial", size: {value: 10, unit: "ft"}}, damage: [{id: "blast", expression: {type: "constant", value: 3}, damageType: "fire",
      provenance: "feature-base"}]});
  assert.deepEqual(validateActionDefinition(blast.system.definition).errors, [], "a valid Action, refused only for its area");
  const blasted = await afterCastFixture(t, {definition: drawsRays(), actions: [structuredClone(RAYS[0]), blast], playerTotal: 3,
    logger: {warn: (...args) => told.push(args.join(" "))}});
  assert.deepEqual([blasted.completed.length, blasted.targetActor.system.resources.health.value], [1, 30]);
  assert.equal(told.some(line => line.includes("WILDPATH.NOTICE.UsedActionFailed")), true, told.join("\n"));
});

/** A Cure Wounds-shaped spell Item (2d8, 2d8 more a level above 1st): the spell a stored cast names by Item id. */
const STORED_CURE = Object.freeze({id: "cure-item", type: "action", name: "Cure Wounds", flags: {wildpath: {source: {id: "srd-cure-wounds"}}},
  system: {active: true, definition: {schemaVersion: 1, id: "action:cure-wounds", label: "Cure Wounds", tags: ["spell"],
    costs: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]}, range: {type: "touch", distance: {value: 5, unit: "ft"}},
    targeting: {type: "single", required: true, count: 1},
    healing: [{id: "healing-1", expression: {type: "dice", number: 2, faces: 8}, healingType: "healing"}],
    configuration: [{id: "spell-slot", type: "resource", label: "Spell slot", required: true,
      cost: {anyOf: [[{capability: "spell-slot.1", amount: 1}], [{capability: "spell-slot.2", amount: 1}]]},
      levelByResourceId: {"spell-slot.1": 1, "spell-slot.2": 2},
      effects: [{type: "scaleHealing", levelChoiceId: "spell-slot", baseLevel: 1, componentIds: ["healing-1"], dice: {number: 2, faces: 8}}]}]}}});

/** A Contingency-shaped effect on `actor` holding a stored cast (bound), given by `giver`; deleting it removes it. */
function holdCast(actor, storedCast, {id="contingency", giver=actor}={}) {
  const effect = {id, uuid: `${actor.uuid}.ActiveEffect.${id}`, name: "Contingency", type: "effect", disabled: false, parent: actor,
    flags: {wildpath: {conditionEffect: {sourceRef: giver.uuid, definition: {storedCast}}}}};
  actor.documentName = "Actor";
  actor.effects = [effect];
  actor.effects.get = effectId => actor.effects.find(entry => entry.id === effectId);
  actor.deleteEmbeddedDocuments = async (type, ids) => {
    assert.equal(type, "ActiveEffect");
    for ( const effectId of ids ) actor.effects.splice(actor.effects.findIndex(entry => entry.id === effectId), 1);
  };
  return effect;
}

/** Its user's answer to a release prompt: `pick()` for Release or Not now, the one free slot option, the rest as offered. */
const releaseAnswer = pick => request => ({choices: Object.fromEntries(request.payload.requests.map(entry => [entry.id,
  (entry.id === "release") ? pick() : (entry.type === "resource") ? {paymentOptionId: entry.options[0].paymentOptionId} : entry.defaultValue]))});

test("storedCastOf and atCastLevel: a bound stored cast, and a spell made free at a level with its own level and scaling kept", async () => {
  const {atCastLevel, spellBaseLevel} = await import("../module/helpers/spellcasting.mjs");
  const {discoverActionConfigurationChoices, resolveActionConfiguration} = await import("../module/helpers/action-configuration.mjs");
  const stored = storedCast => ({flags: {wildpath: {conditionEffect: {definition: {storedCast}}}}});
  assert.deepEqual(storedCastOf(stored({action: "cure-item", level: 2})), {action: "cure-item", level: 2});
  assert.deepEqual([storedCastOf(stored({action: "cure-item", level: "{{contingent-slot}}"})), storedCastOf(stored({action: "", level: 2})),
    storedCastOf(stored({action: "cure-item", level: 10})), storedCastOf({flags: {}}), storedCastOf(null)], [null, null, null, null, null],
  "unbound, malformed or absent");
  // What the release prompt and the GM sheet's Release button call it: a cantrip without "at level 0" (live round 10).
  assert.deepEqual([storedReleaseLabel("Cure Wounds", 2), storedReleaseLabel("Light", 0)],
    [{label: "WILDPATH.STORED.ReleaseAt", labelData: {name: "Cure Wounds", level: 2}},
      {label: "WILDPATH.STORED.Release", labelData: {name: "Light"}}]);
  const sheet = readFileSync(new URL("../module/applications/actor-sheet.mjs", import.meta.url), "utf8");
  assert.match(sheet, /entry\.release = label \? game\.i18n\.format\(label\.label, label\.labelData\)/u, "the sheet says it so");

  const written = STORED_CURE.system.definition;
  const free = atCastLevel(written, 2);
  const slot = free.configuration[0];
  assert.deepEqual([slot.cost, slot.metadata.freeCastLevel, slot.levelByResourceId, slot.effects], [{anyOf: [[]]}, 2,
    written.configuration[0].levelByResourceId, written.configuration[0].effects]);
  assert.equal(spellBaseLevel(free), 1, "the spell's own level");
  assert.deepEqual(written.configuration[0].cost.anyOf.length, 2, "the written definition is unchanged");
  const actorSystem = {resources: {action: {value: 1, max: 1}}, pools: [{id: "spell-slot.2", value: 0, max: 1}]};
  const [option, ...more] = discoverActionConfigurationChoices({definition: free, actorSystem}).requests[0].options;
  assert.deepEqual([option.resources.length, more.length], [0, 0], "only the free option");
  const resolved = resolveActionConfiguration({definition: free, actorSystem, choices: {"spell-slot": {paymentOptionId: option.paymentOptionId}}});
  assert.equal(resolved.ok, true, JSON.stringify(resolved.errors));
  assert.equal(resolved.configuration.castingLevel, 2, "cast at the stored level with no slot left");
  const cantrip = {id: "action:light", configuration: [{id: "use", type: "option", options: []}]};
  assert.equal(atCastLevel(cantrip, 0), cantrip, "no slot choice: unchanged");
});

test("releaseStored: the GM's release casts the stored spell free at its level on its creature; Not now, a missing spell or a second press keep it", async t => {
  let pick = "decline";
  const told = [];
  const fixture = await afterCastFixture(t, {actions: [structuredClone(STORED_CURE)], pools: [{id: "spell-slot.2", value: 1, max: 1}],
    configure: request => releaseAnswer(() => pick)(request), logger: {warn: (...args) => told.push(args.join(" ")), info: () => {}, error: () => {}},
    prepare: ({sourceActor}) => { sourceActor.system.resources.health = {value: 5, max: 100}; }});
  const {sourceActor, automation, completed, asked, posted} = fixture;
  // Its Action and its Reaction are spent already: the release needs neither.
  sourceActor.system.resources.reaction.value = 0;
  const effect = holdCast(sourceActor, {action: "cure-item", level: 2});
  const health = () => sourceActor.system.resources.health.value;
  const slots = () => sourceActor.system.pools.find(pool => pool.id === "spell-slot.2").value;

  // Not now: nothing rolled, nothing spent, the effect kept.
  const ran = completed.length;
  assert.deepEqual(await automation.releaseStored(effect), []);
  const prompt = asked.at(-1).payload.requests;
  assert.deepEqual([prompt[0].id, prompt[0].label, prompt[0].options.map(option => [option.label, option.labelData])],
    ["release", "Contingency", [["WILDPATH.STORED.ReleaseAt", {name: "Cure Wounds", level: 2}], ["WILDPATH.STORED.NotNow", undefined]]],
    "Release (naming the spell and its level) or Not now first (Q133 default)");
  assert.deepEqual(prompt[1].options.map(option => [option.label, option.labelData]), [["WILDPATH.PROMPT.FreeAtLevel", {level: 2}]],
    "its slot reads free at the stored level, not \"No resource\"");
  assert.deepEqual([health(), slots(), sourceActor.effects.length], [5, 1, 1]);
  // It cast nothing, so no level is recorded for an active copy's follow-ups, though its configuration still has one.
  const declined = completed.at(-1);
  assert.deepEqual([completed.length - ran, declined.state.configuration.castingLevel], [1, 2]);
  assert.equal(posted.includes(declined.resolutionId), false, "Not now posts no chat card");
  const notRecorded = [];
  await recordCastLevel({options: {...declined.options, actor: {flags: {}, setFlag: async (...args) => notRecorded.push(args)}},
    state: declined.state});
  assert.deepEqual(notRecorded, [], "Not now records no cast level");
  // One held at level 0 (a cantrip) is named without a level, as its free slot reads "No resource".
  const cantrip = holdCast(sourceActor, {action: "cure-item", level: 0}, {id: "cantrip"});
  assert.deepEqual(await automation.releaseStored(cantrip), []);
  assert.deepEqual(asked.at(-1).payload.requests[0].options.map(option => [option.label, option.labelData]),
    [["WILDPATH.STORED.Release", {name: "Cure Wounds"}], ["WILDPATH.STORED.NotNow", undefined]], "not \"at level 0\"");
  sourceActor.effects.splice(0, 1, effect);

  // Inside an Antimagic Field (a Suppress over its spell's tags) it waits: nothing asked, cast or ended.
  pick = "use";
  const asks = asked.length;
  const hadSuppress = Object.hasOwn(sourceActor, "suppressingRules");
  const ownSuppress = sourceActor.suppressingRules;
  Object.assign(effect, {documentName: "ActiveEffect"});
  effect.flags.wildpath.conditionEffect.metadata = {spellLevel: 6};
  sourceActor.suppressingRules = () => [{actions: {tagsAny: ["spell"]}}];
  assert.deepEqual(await automation.releaseStored(effect), []);
  assert.deepEqual([asked.length - asks, health(), sourceActor.effects.length], [0, 5, 1], "suppressed: refused");
  if ( hadSuppress ) sourceActor.suppressingRules = ownSuppress;
  else delete sourceActor.suppressingRules;

  // Release: Cure Wounds at 2nd level (4d8) on its caster, no slot spent; the effect ends.
  pick = "use";
  const [released] = await automation.releaseStored(effect);
  assert.equal(released?.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(released?.errors ?? released).slice(0, 1500));
  const cast = completed.at(-1);
  assert.equal(posted.includes(cast.resolutionId), true, "a release does post its card");
  assert.equal(cast.state.actionDefinition.id, "action:cure-wounds");
  assert.equal(cast.state.configuration.castingLevel, 2);
  assert.deepEqual(cast.state.actionDefinition.healing[0].expression, {type: "dice", number: 4, faces: 8}, "4d8 at 2nd level");
  assert.deepEqual(cast.state.targets.map(target => target.actorId), [sourceActor.id], "on itself");
  assert.equal(health() > 5, true, "healed");
  assert.deepEqual([slots(), sourceActor.system.resources.reaction.value, sourceActor.effects.length], [1, 0, 0], "nothing spent; the effect gone");
  // Its level is recorded under its spell, for its follow-ups (recordCastLevel reads the Item's source).
  const recorded = [];
  await recordCastLevel({options: {...cast.options, actor: {flags: {}, setFlag: async (...args) => recorded.push(args)}}, state: cast.state});
  assert.deepEqual(recorded, [["wildpath", "castLevels.srd-cure-wounds", 2]]);

  // Its spell gone: the GM is told and the effect stays.
  const lost = holdCast(sourceActor, {action: "gone-item", level: 2}, {id: "lost"});
  assert.deepEqual(await automation.releaseStored(lost), []);
  assert.equal(told.some(line => line.includes("WILDPATH.NOTICE.ReleaseFailed")), true, told.join("\n"));
  assert.equal(told.some(line => line.includes("WILDPATH.NOTICE.UsedActionFailed")), false, "not the rolled result's notice");
  assert.equal(sourceActor.effects.length, 1);

  // Two presses at once: one release.
  const twice = holdCast(sourceActor, {action: "cure-item", level: 1}, {id: "twice"});
  const before = completed.length;
  const runs = await Promise.all([automation.releaseStored(twice), automation.releaseStored(twice)]);
  assert.deepEqual([runs.map(run => run.length), completed.length - before, sourceActor.effects.length], [[1, 0], 1, 0]);
});

test("releaseStored: a GM's query, Assistant GMs too, answered at once; another GM's press goes to the active GM; another creature's held spell is its giver's", async t => {
  let open;
  const gate = new Promise(resolve => { open = resolve; });
  const fixture = await afterCastFixture(t, {actions: [structuredClone(STORED_CURE)],
    configure: async request => { await gate; return releaseAnswer(() => "use")(request); },
    prepare: ({sourceActor}) => { sourceActor.system.resources.health = {value: 5, max: 100}; }});
  const {sourceActor, targetActor, game, gm, persistencePort} = fixture;
  const effect = holdCast(sourceActor, {action: "cure-item", level: 1});
  const automation = createFoundryAutomationDispatcher({game, coordinator: gm, fromUuid: async ref => ((ref === effect.uuid) ? effect : null),
    resolveAction: options => foundryActionIntentToStagedOptions({...options, game, persistencePort})});
  assert.deepEqual(await automation.handleRelease({effectUuid: effect.uuid}, {user: {id: "player-a", isGM: false}}), {ok: false},
    "a player may not release");
  assert.deepEqual(await automation.handleRelease({effectUuid: "nothing"}, {user: {id: "assistant", isGM: true}}), {ok: false});
  assert.deepEqual(await automation.handleRelease({effectUuid: effect.uuid}, {user: {id: "assistant", isGM: true}}), {ok: true},
    "an Assistant GM may, answered before its user picks");
  assert.equal(sourceActor.effects.length, 1);
  open();
  for ( let tick = 0; (tick < 200) && sourceActor.effects.length; tick++ ) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([sourceActor.effects.length, sourceActor.system.resources.health.value > 5], [0, true]);

  // Pressed on another GM's client: the active GM is asked.
  const sent = [];
  const other = createFoundryAutomationDispatcher({game: {user: {id: "gm-b"}, users: {activeGM: {id: "gm-a",
    query: async (...args) => { sent.push(args); return {ok: true}; }}}}, coordinator: gm, resolveAction: async () => ({ok: false})});
  assert.deepEqual(await other.releaseStored(effect), []);
  assert.deepEqual(sent, [[RELEASE_QUERY, {effectUuid: effect.uuid}, {timeout: 15000}]]);

  // Given to another creature: its giver casts its own spell at it.
  const previous = globalThis.fromUuidSync;
  globalThis.fromUuidSync = uuid => ((uuid === sourceActor.uuid) ? sourceActor : null);
  t.after(() => { if ( previous === undefined ) delete globalThis.fromUuidSync; else globalThis.fromUuidSync = previous; });
  targetActor.system.resources.health.value = 10;
  const boon = holdCast(targetActor, {action: "cure-item", level: 1}, {id: "boon", giver: sourceActor});
  const healed = sourceActor.system.resources.health.value;
  const [state] = await fixture.automation.releaseStored(boon);
  assert.equal(state?.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(state?.errors ?? state).slice(0, 1500));
  assert.deepEqual([state.targets.map(target => target.actorId), targetActor.system.resources.health.value > 10,
    sourceActor.system.resources.health.value, targetActor.effects.length], [[targetActor.id], true, healed, 0]);
});

test("usedOptionActions: each drawn option's Action once, at the creatures that drew it; a picked option or none uses nothing", () => {
  const definition = {...drawsRays(), draw: {choiceId: "drawn", formula: "1d4", perTarget: true}};
  const targets = ["a", "b", "c"].map(id => ({actorId: `actor-${id}`, tokenId: id}));
  const state = byTarget => ({actionDefinition: definition, targets, results: {drawResolution: {byTarget}}});
  assert.deepEqual(usedOptionActions(state({a: ["bolt"], b: ["zap"], c: ["bolt"]})), [
    {actionId: "action:bolt", label: "Bolt", targets: [targets[0], targets[2]]}, {actionId: "action:zap", label: "Zap", targets: [targets[1]]}]);
  assert.deepEqual(usedOptionActions(state({all: ["zap"]})), [{actionId: "action:zap", label: "Zap", targets}]);
  // A creature's roll no target names (keyed by another of its refs) keeps its key, so it is looked for, not dropped:
  // no targets would turn the Action on its own creature.
  assert.deepEqual(usedOptionActions(state({"token-x": ["zap"]})), [{actionId: "action:zap", label: "Zap",
    targets: [{actorId: null, tokenId: "token-x"}]}]);
  const plain = {...definition, configuration: [{...definition.configuration[0], options: definition.configuration[0].options
    .map(({useAction: _use, ...option}) => option)}]};
  assert.deepEqual(usedOptionActions({...state({all: ["zap"]}), actionDefinition: plain}), []);
  assert.deepEqual(usedOptionActions({actionDefinition: definition, targets, configuration: {choices: {drawn: "zap"}}}), []);

  // Only a drawn option uses another Action: a picked one would make any limited Action free.
  const paths = candidate => validateActionDefinition(candidate).errors.map(entry => `${entry.path}: ${entry.message}`);
  assert.deepEqual(paths(drawsRays()), []);
  const picked = {...drawsRays(), draw: undefined};
  assert.deepEqual(paths(picked).map(line => line.split(":")[0]), ["configuration.0.options.0.useAction", "configuration.0.options.1.useAction"]);
  assert.deepEqual(paths(drawsRays("")).map(line => line.split(":")[0]), ["configuration.0.options.1.useAction"]);
  assert.deepEqual(paths(drawsRays("action:eye-rays")).map(line => line.split(":")[0]), ["configuration.0.options.1.useAction"], "not itself");
});

test("useAction: a Charmed creature's draw at its charmer is refused, as the Action it would use is", async t => {
  const {game, intent, sourceActor, targetActor} = syntheticRuntimeFixture(t, drawsRays());
  sourceActor.effects = [{id: "charm", statuses: new Set(["charmed"]), flags: {wildpath: {conditionEffect: {sourceRef: `uuid:${targetActor.uuid}`}}}}];
  const refused = await foundryActionIntentToStagedOptions({senderUserId: "player-a", game, intent});
  assert.equal(refused.ok, false, "Eye Rays at its charmer");
  const harmless = syntheticRuntimeFixture(t, {...drawsRays(), configuration: [{...drawsRays().configuration[0],
    options: drawsRays().configuration[0].options.map(({useAction: _use, ...option}) => option)}]});
  harmless.sourceActor.effects = [{id: "charm", statuses: new Set(["charmed"]),
    flags: {wildpath: {conditionEffect: {sourceRef: `uuid:${harmless.targetActor.uuid}`}}}}];
  const allowed = await foundryActionIntentToStagedOptions({senderUserId: "player-a", game: harmless.game, intent: harmless.intent});
  assert.equal(allowed.ok, true, allowed.reason);
});

test("draw.noRepeat: the draw reads its creature's record of this turn live, as it rolls, not when the intent arrives (Q25)", async t => {
  const {game, intent, sourceActor} = syntheticRuntimeFixture(t, {...drawsRays(), draw: {...drawsRays().draw, noRepeat: "turn"}});
  game.combat = {id: "combat-1", started: true, round: 1, turn: 0};
  const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a", game, intent});
  assert.equal(resolved.ok, true, resolved.reason);
  assert.deepEqual(resolved.services.drawnThisTurn("action:eye-rays"), []);
  // An earlier Eye Rays completing after this intent arrived (it waited on the one-Action guard) is still seen.
  sourceActor.flags = {wildpath: {drawnTurn: {turn: "combat-1:1:0", drawn: [["action:eye-rays", "zap"], ["action:other", "bolt"]]}}};
  assert.deepEqual(resolved.services.drawnThisTurn("action:eye-rays"), ["zap"]);
  const planned = planStagedActionResolution({...resolved.options, services: resolved.services}).state;
  assert.deepEqual(planned.input.drawExcluded, ["zap"], "kept for the draw's rolls");
  game.combat = {...game.combat, turn: 1};
  assert.deepEqual(resolved.services.drawnThisTurn("action:eye-rays"), [], "a new turn");
});

test("Protective Bond: a reaction an effect gives (Bonded), offered while its giver has the feature; it takes the damage", async t => {
  const {action} = {action: {schemaVersion: 1, id: "action:protective-bond", label: "Protective Bond",
    costs: {allOf: [{capability: ECONOMY_CAPABILITIES.REACTION, amount: 1}]}, range: {type: "self"}, targeting: {type: "self"},
    rider: {redirectDamage: {to: "self"}, protects: "target", teleportNextTo: true}}};
  const trigger = {schemaVersion: 1, id: "protective-bond", type: "Trigger", data: {kind: "reaction", event: "damage.applied",
    match: {phase: "before", notSourceTokenId: "{self}"}, giverItem: "protective-bond", action,
    triggerPredicate: {all: [{equals: {path: "targetEffects.bonded", value: true}}, {atMost: {path: "toTarget.{self}.distance", value: 30}},
      {not: {equals: {path: "toTarget.{self}.self", value: true}}}]}}};
  const cleric = {uuid: "Actor.cleric", items: [{system: {active: true}, flags: {wildpath: {source: {identifier: "protective-bond"}}}}]};
  const previous = globalThis.fromUuidSync;
  globalThis.fromUuidSync = uuid => (uuid === cleric.uuid ? cleric : null);
  t.after(() => { if ( previous === undefined ) delete globalThis.fromUuidSync; else globalThis.fromUuidSync = previous; });
  const bonded = {id: "bonded", name: "Bonded", system: {ruleElements: [trigger]}, flags: {wildpath: {conditionEffect: {sourceRef: cleric.uuid}}}};
  const fixture = counterattackFixture(t, {reactor: "bystander", holderItems: []});
  fixture.holder.effects = [bonded];
  fixture.targetActor.effects = [...(fixture.targetActor.effects ?? []), {id: "bonded-too", name: "Bonded", system: {ruleElements: []}}];
  const declared = await fixture.player.declareActionIntent(fixture.intent);
  const record = fixture.gm.getRecord(declared.resolutionId);
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(record.state.errors).slice(0, 1500));
  assert.equal(fixture.offers.length, 1, "offered to the other bonded creature");
  assert.deepEqual([fixture.targetActor.system.resources.health.value, fixture.holder.system.resources.health.value], [30, 14],
    "it takes the 6 instead");
  assert.deepEqual(record.state.input.riderTeleport, {tokenId: "bystander-token", nextTo: "target-token"}, "and teleports beside it");
  // A bodyguard that swaps instead (rider.swap with a redirect to itself, Q49): it trades places with the creature it protects.
  action.rider = {redirectDamage: {to: "self"}, protects: "target", swap: true};
  const guard = counterattackFixture(t, {reactor: "bystander", holderItems: []});
  guard.holder.effects = [bonded];
  guard.targetActor.effects = [...(guard.targetActor.effects ?? []), {id: "bonded-too", name: "Bonded", system: {ruleElements: []}}];
  const guarded = guard.gm.getRecord((await guard.player.declareActionIntent(guard.intent)).resolutionId);
  assert.equal(guarded.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(guarded.state.errors).slice(0, 1500));
  assert.deepEqual([guard.holder.system.resources.health.value, guarded.state.input.riderSwap], [14, {"bystander-token": "target-token"}]);
  action.rider = {redirectDamage: {to: "self"}, protects: "target", teleportNextTo: true};

  // Its cleric without Protective Bond: no reaction.
  cleric.items = [];
  const plain = counterattackFixture(t, {reactor: "bystander", holderItems: []});
  plain.holder.effects = [bonded];
  plain.targetActor.effects = [{id: "bonded-too", name: "Bonded", system: {ruleElements: []}}];
  await plain.player.declareActionIntent(plain.intent);
  assert.equal(plain.offers.length, 0);
});

test("Flash of Genius: any failed check or save of an ally within 30 ft, adding its Intelligence modifier for its Reaction and a use", async t => {
  const {withAllyTestOffers} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const {scene, targetToken} = syntheticRuntimeFixture(t);
  const flash = {id: "fog", name: "Flash of Genius", system: {active: true}, flags: {wildpath: {testOffer: {tests: ["check", "save"],
    pool: "flash-of-genius", reaction: true, range: 30, addAbility: "intellect"}}}};
  const inventor = withFoundryActorSystem(fakeActor("inventor", {system: {...targetActorSystem(), abilities: {intellect: {value: 18}},
    resources: {reaction: {value: 1, max: 1}}, pools: [{id: "flash-of-genius", value: 2, max: 4}]}}));
  inventor.items = [flash];
  scene.tokens.push(fakeTokenDocument({id: "inventor-token", actor: inventor, scene, offset: {i: 1, j: 3}, disposition: targetToken.disposition}));
  const payers = [];
  const offer = withAllyTestOffers(null, targetToken, {effects: []}, {}, "save", {chooser: "target-controller", register: payer => payers.push(payer.id)});
  assert.deepEqual(offer.options.map(option => [option.payerRef, option.addFlat]), [["Actor.inventor", 4]], "any save, +4");
  assert.deepEqual(Object.keys(offer.options[0].plan.updates).sort(), ["system.pools.0.value", "system.resources.reaction.value"].sort(),
    "a use and its Reaction");
  inventor.system.resources.reaction.value = 0;
  assert.equal(withAllyTestOffers(null, targetToken, {effects: []}, {}, "save", {chooser: "target-controller"}), null, "no Reaction left");
});

test("Flash of Genius in an Action: a failed save gets the inventor's Intelligence modifier added, and saves", async () => {
  const inventor = withFoundryActorSystem(fakeActor("inventor", {system: {...actorSystem(), abilities: {intellect: {value: 18}},
    pools: [{id: "flash-of-genius", value: 2, max: 4}]}}));
  inventor.items = [{id: "fog", name: "Flash of Genius", system: {active: true}, flags: {wildpath: {testOffer: {tests: ["check", "save"],
    pool: "flash-of-genius", reaction: true, range: 30, addAbility: "intellect"}}}}];
  // The target's ally, beside it (the attacker's allies are on the other side).
  const planned = await plannedWithConditions(fortitudeBlast("might"), {saveRoll: {total: 10, natural: 7, die: 7}, extraActors: [inventor],
    prepareTarget: actor => Object.defineProperty(actor, "token", {get: () => actor.tokens[0] ?? null})});
  const offerState = planned.state;
  const [choice] = offerState.pendingRequests;
  assert.ok(choice?.payload?.options?.some(option => /inventor/.test(option.value)), JSON.stringify(choice?.payload?.options));
  const answered = resumeStagedActionResolution({state: offerState, response: {resolutionId: offerState.id, requestId: choice.id, type: choice.type,
    value: {choices: {"heroic-inspiration": choice.payload.options.find(option => /inventor/.test(option.value)).value}}}}).state;
  assert.equal(answered.results.saveResolution.successes.length, 1, "10 + 4 = 14 saves against DC 13");
  assert.ok(answered.mutationPlans.some(plan => plan.payerRef === inventor.uuid), "the inventor pays");
});

test("an ally's test offer honours `predicate` and `succeed`: a Might save its ally makes succeed instead, not an Agility one", async () => {
  const guardian = withFoundryActorSystem(fakeActor("guardian", {system: {...actorSystem(), pools: [{id: "ward", value: 1, max: 1}]}}));
  guardian.items = [{id: "ward", name: "Ward", system: {active: true}, flags: {wildpath: {testOffer: {tests: ["save"], succeed: true,
    pool: "ward", range: 30, predicate: {oneOf: {path: "save.ability", values: ["might"]}}}}}}];
  const planning = ability => plannedWithConditions(fortitudeBlast(ability), {saveRoll: {total: 5, natural: 5, die: 5}, extraActors: [guardian],
    prepareTarget: actor => Object.defineProperty(actor, "token", {get: () => actor.tokens[0] ?? null})});
  const offerState = (await planning("might")).state;
  const [choice] = offerState.pendingRequests;
  const option = choice?.payload?.options?.find(entry => /guardian/.test(entry.value));
  assert.equal(option?.label, "WILDPATH.INSPIRATION.SucceedInstead", JSON.stringify(choice?.payload?.options));
  const answered = resumeStagedActionResolution({state: offerState, response: {resolutionId: offerState.id, requestId: choice.id,
    type: choice.type, value: {choices: {"heroic-inspiration": option.value}}}}).state;
  assert.deepEqual([answered.pendingRequests.length, answered.results.saveResolution.successes[0]?.succeededBy], [0, "Ward"],
    "no new d20: it succeeds");
  assert.ok(answered.mutationPlans.some(plan => plan.payerRef === guardian.uuid), "the ally pays");
  assert.equal((await planning("agility")).state.pendingRequests.length, 0, "its predicate refuses an Agility save");
});

test("an own attack test offer's `predicate` reads the attack's context (its target's type)", async () => {
  const hunter = (type, value=1) => ({prepareSource: actor => {
    actor.system.pools = [{id: "hunt", value, max: 1}];
    actor.items = new (class extends Map { [Symbol.iterator]() { return this.values(); } })([["hunt", {id: "hunt", name: "Hunt",
      system: {active: true}, flags: {wildpath: {testOffer: {tests: ["attack"], reroll: true, pool: "hunt",
        predicate: {equals: {path: "attack.targetType", value: "undead"}}}}}}]]);
  }, prepareTarget: actor => { actor.system.details = {...(actor.system.details ?? {}), type}; }});
  const miss = {total: 5, natural: 2, die: 2};
  const offered = async type => (await plannedWithConditions(meleeStrikeDefinition(), {attackRoll: miss, ...hunter(type)}))
    .state.pendingRequests[0]?.payload?.options?.map(option => option.value) ?? [];
  assert.deepEqual(await offered("undead"), ["test-offer:hunt", "keep"], "against an Undead");
  assert.deepEqual(await offered("beast"), [], "not against a Beast");
});

test("an own test offer's `predicate` reads its Action's Item (`identifier`) and its check (`check.proficient`)", async () => {
  const offerOn = (spec, value=1) => ({prepareSource: actor => {
    actor.system.pools = [{id: "psi", value, max: 4}];
    actor.system.skills = {...(actor.system.skills ?? {}), stealth: {proficiency: 1}};
    actor.items = new (class extends Map { [Symbol.iterator]() { return this.values(); } })([["psi", {id: "psi", name: "Psi",
      system: {active: true}, flags: {wildpath: {testOffer: {pool: "psi", faces: {type: "constant", value: 6}, refundOnFail: true, ...spec}}}}]]);
  }});
  // Homing Strikes: only a miss with its Psychic Blade.
  const homing = {tests: ["attack"], predicate: {oneOf: {path: "identifier", values: ["psychic-blade"]}}};
  const miss = {total: 5, natural: 2, die: 2};
  const attackOptions = async identifier => (await plannedWithConditions(meleeStrikeDefinition(), {attackRoll: miss, ...offerOn(homing),
    actionFlags: {wildpath: {source: {identifier}}}})).state.pendingRequests[0]?.payload?.options ?? [];
  assert.deepEqual((await attackOptions("psychic-blade")).map(option => option.value), ["test-offer:psi", "keep"], "a Psychic Blade's miss");
  assert.deepEqual(await attackOptions("dagger"), [], "not a dagger's");
  // Psi-Bolstered Knack: only a failed check with a proficient skill.
  const knack = {tests: ["check"], predicate: {equals: {path: "check.proficient", value: true}}};
  const failedCheck = async skill => {
    const planned = await plannedWithConditions({schemaVersion: 1, id: "action:runtime-sneak", label: "Sneak", costs: {allOf: []},
      targeting: {type: "self"}, check: {ability: "agility", skill, dc: {value: 15}}}, offerOn(knack));
    const [request] = planned.state.pendingRequests;
    return resumeStagedActionResolution({state: planned.state, response: {resolutionId: planned.state.id, requestId: request.id, type: request.type,
      value: {requestId: request.payload.rollRequest.id, resolutionId: planned.state.id, type: request.payload.rollRequest.type, natural: 2, total: 2}}})
      .state.pendingRequests[0]?.payload?.options?.map(option => option.value) ?? [];
  };
  assert.deepEqual(await failedCheck("stealth"), ["test-offer:psi", "keep"], "a proficient Stealth check");
  assert.deepEqual(await failedCheck("athletics"), [], "not an Athletics check without proficiency");
});

test("an ally test offer's `reaction: \"others\"` (Guided Strike): free on its own roll, its Reaction too on an ally's", async t => {
  const {withAllyTestOffers} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const {scene, targetActor, targetToken, targetSource} = syntheticRuntimeFixture(t);
  const guided = {id: "gs", name: "Guided Strike", system: {active: true}, flags: {wildpath: {testOffer: {tests: ["attack"], range: 30, add: 10,
    reaction: "others", pool: "channel-divinity"}}}};
  targetActor.items = [guided];
  for ( const system of [targetSource, targetActor.system] ) {
    system.resources.reaction = {value: 1, max: 1};
    system.pools = [{id: "channel-divinity", value: 2, max: 2}];
  }
  const own = withAllyTestOffers(null, targetToken, {}, {}, "attack", {chooser: "target-controller"});
  assert.deepEqual([own.options.map(option => option.addFlat), Object.keys(own.options[0].plan.updates)], [[10], ["system.pools.0.value"]],
    "its own miss: a Channel Divinity, no Reaction");
  targetActor.items = [];
  const cleric = withFoundryActorSystem(fakeActor("cleric", {system: {...targetActorSystem(), resources: {reaction: {value: 1, max: 1}},
    pools: [{id: "channel-divinity", value: 2, max: 2}]}}));
  cleric.items = [guided];
  scene.tokens.push(fakeTokenDocument({id: "cleric-token", actor: cleric, scene, offset: {i: 1, j: 3}, disposition: targetToken.disposition}));
  const ally = withAllyTestOffers(null, targetToken, {}, {}, "attack", {chooser: "target-controller"});
  assert.deepEqual(Object.keys(ally.options[0].plan.updates).sort(), ["system.pools.0.value", "system.resources.reaction.value"].sort(),
    "an ally's miss: its Reaction too");
  cleric.system.resources.reaction.value = 0;
  assert.equal(withAllyTestOffers(null, targetToken, {}, {}, "attack", {chooser: "target-controller"}), null, "no Reaction left");
  targetActor.items = [guided];
  assert.deepEqual(withAllyTestOffers(null, targetToken, {}, {}, "attack", {chooser: "target-controller"}).options.map(option => option.payerRef),
    [targetActor.uuid], "its own still is, with no Reaction");

  // `nonhostile: true` (Q36): a neutral creature's miss within 30 feet is offered too, not one beyond, nor a hostile's.
  targetActor.items = [];
  cleric.system.resources.reaction.value = 1;
  const clericToken = scene.tokens.at(-1);
  const payers = () => withAllyTestOffers(null, targetToken, {}, {}, "attack", {chooser: "target-controller"})?.options.map(option => option.payerRef) ?? [];
  clericToken.disposition = 0;
  assert.deepEqual(payers(), [], "without the key a neutral creature is no ally");
  guided.flags.wildpath.testOffer.nonhostile = true;
  assert.deepEqual(payers(), [cleric.uuid], "a neutral creature's miss 15 feet away");
  // Never a GM-hidden one's to a player's creature (its prompt would name it), as a foe's is not; the GM's still is.
  targetToken.hidden = true;
  cleric.hasPlayerOwner = true;
  assert.deepEqual(payers(), [], "not a GM-hidden neutral creature's to a player's cleric");
  cleric.hasPlayerOwner = false;
  assert.deepEqual(payers(), [cleric.uuid], "a GM's cleric still sees it");
  targetToken.hidden = false;
  clericToken.y = 8 * scene.grid.sizeY;
  clericToken.getOccupiedGridSpaceOffsets = () => [{i: 1, j: 8}];
  assert.deepEqual(payers(), [], "not 40 feet away");
  clericToken.y = 3 * scene.grid.sizeY;
  clericToken.getOccupiedGridSpaceOffsets = () => [{i: 1, j: 3}];
  clericToken.disposition = -targetToken.disposition;
  assert.deepEqual(payers(), [], "never a hostile creature's");
  // `unlessStatus` (a status or a list) bars its bearer too.
  clericToken.disposition = targetToken.disposition;
  assert.deepEqual(payers(), [cleric.uuid]);
  guided.flags.wildpath.testOffer.unlessStatus = ["unconscious"];
  cleric.statuses = new Set(["unconscious"]);
  assert.deepEqual(payers(), [], "not while its bearer is Unconscious");
  // And its sibling `whileStatus` asks its bearer for its status there too.
  delete guided.flags.wildpath.testOffer.unlessStatus;
  guided.flags.wildpath.testOffer.whileStatus = "raging";
  cleric.statuses = new Set();
  assert.deepEqual(payers(), [], "not while its bearer is not raging");
  cleric.statuses = new Set(["raging"]);
  assert.deepEqual(payers(), [cleric.uuid], "while it is");
});

test("an ally test offer's prompt names the roll it answers: a failed roll on an attack or a check, a failed save on a save", async t => {
  const {withAllyTestOffers} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const {scene, targetActor, targetToken, targetSource} = syntheticRuntimeFixture(t);
  const guided = {id: "gs", name: "Guided Strike", system: {active: true}, flags: {wildpath: {testOffer: {tests: ["attack", "check", "save"],
    range: 30, add: 10, pool: "channel-divinity"}}}};
  targetActor.items = [guided];
  for ( const system of [targetSource, targetActor.system] ) system.pools = [{id: "channel-divinity", value: 2, max: 2}];
  const game = {i18n: {format: (key, data) => `${key}:${data.name}`}};
  const offered = (test, offer=null) => withAllyTestOffers(offer, targetToken, {}, game, test, {chooser: "target-controller"});
  const own = key => `WILDPATH.INSPIRATION.${key}:${targetActor.name}`;
  assert.deepEqual(["attack", "check", "save"].map(test => offered(test).label), [own("OwnTest"), own("OwnTest"), own("OwnSave")]);
  assert.equal(offered("attack").options[0].name, "Guided Strike", "its option carries its offer's name for the card");
  assert.equal(offered("attack").rollerName, targetActor.name, "and names its roller, for the question with the roll's numbers");
  // An ally's, beside the players' monster offer: asked under the same label.
  targetActor.items = [];
  const cleric = withFoundryActorSystem(fakeActor("cleric", {system: {...targetActorSystem(), pools: [{id: "channel-divinity", value: 2, max: 2}]}}));
  cleric.items = [guided];
  scene.tokens.push(fakeTokenDocument({id: "cleric-token", actor: cleric, scene, offset: {i: 1, j: 3}, disposition: targetToken.disposition}));
  const monster = {own: false, chooser: "gm", label: "monster", options: []};
  assert.deepEqual(["attack", "save"].map(test => offered(test, monster).options[0].offerLabel), [own("OwnTest"), own("OwnSave")]);
  // Beside a player's own Heroic Inspiration too: the ally is asked about the roll, not about Heroic Inspiration.
  const heroic = {own: true, chooser: "source-controller", label: "WILDPATH.INSPIRATION.Own", options: []};
  assert.deepEqual(["attack", "save"].map(test => offered(test, heroic).options[0]).map(option => [option.offerLabel, option.failedOnly]),
    [[own("OwnTest"), undefined], [own("OwnSave"), undefined]]);
});

test("Bountiful Luck: an ally's natural 1 only, never its own roll", async t => {
  const {withAllyTestOffers} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const {scene, targetToken, targetActor} = syntheticRuntimeFixture(t);
  const luck = {id: "bl", name: "Bountiful Luck", system: {active: true}, flags: {wildpath: {testOffer: {tests: ["check", "save"],
    pool: "reaction", range: 30, natural: 1, others: true}}}};
  const halfling = withFoundryActorSystem(fakeActor("halfling", {system: {...targetActorSystem(), resources: {reaction: {value: 1, max: 1}}}}));
  halfling.items = [luck];
  scene.tokens.push(fakeTokenDocument({id: "halfling-token", actor: halfling, scene, offset: {i: 1, j: 2}, disposition: targetToken.disposition}));
  const offer = withAllyTestOffers(null, targetToken, {effects: []}, {}, "save", {chooser: "target-controller"});
  assert.deepEqual(offer.options.map(option => [option.payerRef, option.natural]), [["Actor.halfling", 1]]);
  targetActor.items = [luck];
  targetActor.system.resources.reaction = {value: 1, max: 1};
  assert.equal(withAllyTestOffers(null, targetToken, {effects: []}, {}, "save", {chooser: "target-controller"}).options.length, 1,
    "its own Bountiful Luck is not offered on its own roll");
});

test("a refusal reaches its player in words: its own, a known lower-level reason, else a plain sentence (the GM sees why)", async () => {
  const {refusalMessage} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const game = isGM => ({user: {isGM}, i18n: {localize: key => `loc:${key}`, format: (key, data) => `fmt:${key}:${data.reason}`}});
  assert.equal(refusalMessage({code: "ACTION_REFUSED", reason: "A charmed creature can't harm its charmer."}, game(false)),
    "A charmed creature can't harm its charmer.");
  assert.equal(refusalMessage({code: "X", reason: "Option is not available: abc123"}, game(false)), "loc:WILDPATH.REFUSAL.OptionUnavailable");
  assert.equal(refusalMessage({code: "X", reason: "spell-slot.3 has 0 but needs 1"}, game(false)), "loc:WILDPATH.NOTIFY.PaymentUnavailable");
  assert.equal(refusalMessage({code: "X", reason: "The Action sender must own the acting Actor."}, game(false)), "loc:WILDPATH.REFUSAL.Generic");
  assert.equal(refusalMessage({code: "X", reason: "The Action sender must own the acting Actor."}, game(true)),
    "fmt:WILDPATH.NOTIFY.ActionFailed:The Action sender must own the acting Actor.");
});

test("Trance: a save against sleep magic succeeds unrolled; Relentless Hunter: damage calls for no check on its Hunter's Mark", async () => {
  const trance = [{schemaVersion: 1, id: "trance", type: "RollOutcome", predicate: {tagsAny: ["sleep"]},
    data: {domains: ["save"], outcome: "automatic-success"}}];
  const sleep = {...fortitudeBlast("wits"), id: "action:runtime-sleep", tags: ["spell", "sleep"], damage: [],
    effects: [{id: "effect-1", type: "condition", conditionId: "incapacitated", saveOutcomePolicy: "failure"}]};
  const slept = await plannedWithConditions(sleep, {target: [trance], saveRoll: {total: 1, natural: 1, die: 1}});
  assert.equal(slept.state.results.saveResolution.results[0].success, true, "a 1 still succeeds: magic can't put it to sleep");
  const awake = await plannedWithConditions({...sleep, tags: ["spell"]}, {target: [trance], saveRoll: {total: 1, natural: 1, die: 1}});
  assert.equal(awake.state.results.saveResolution.results[0].success, false, "other magic: rolled as usual");

  const relentless = [{schemaVersion: 1, id: "relentless-hunter", type: "RollOutcome",
    predicate: {equals: {path: "concentration.sustains.hunters-mark", value: true}}, data: {domains: ["concentration"], outcome: "automatic-success"}}];
  // A ranger on the Scene concentrating on Hunter's Mark (as a bystander a redirected hit may reach, it is planned for).
  const ranger = rules => {
    const actor = withConditions(fakeActor("ranger", {system: actorSystem()}), rules);
    Object.defineProperty(actor, "token", {get: () => actor.tokens[0] ?? null});
    const mark = {id: "mark", name: "Hunter's Mark", statuses: new Set(["hunters-mark"]),
      flags: {wildpath: {conditionEffect: {concentration: {sourceRef: "token:extra-0"}}}}};
    actor.effects = [{...mark, toObject: () => ({...structuredClone({...mark, statuses: []}), statuses: ["hunters-mark"]})}];
    return actor;
  };
  const checks = async rules => JSON.stringify((await plannedWithConditions(meleeStrikeDefinition(), {extraActors: [ranger(rules)],
    attackRoll: {total: 20, natural: 15, die: 15}})).state.input?.concentration ?? null);
  assert.match(await checks([]), /token:extra-0/u, "without it, damage would call for a concentration check");
  assert.doesNotMatch(await checks(relentless), /token:extra-0/u, "with it, none on the mark");
});

test("a willing creature only (targeting.notHostile): a target hostile to its source is refused, one on its side is not", async t => {
  const definition = {schemaVersion: 1, id: "action:carry", label: "Carry", costs: {allOf: []},
    range: {type: "touch", distance: {value: 5, unit: "ft"}}, targeting: {type: "single", required: true, count: 1, notHostile: true}};
  const fixture = syntheticRuntimeFixture(t, definition);
  const ally = await foundryActionIntentToStagedOptions({senderUserId: "player-a", intent: fixture.intent, game: fixture.game});
  assert.equal(ally.ok, true, JSON.stringify(ally.reason));
  fixture.targetToken.disposition = 1;
  const enemy = await foundryActionIntentToStagedOptions({senderUserId: "player-a", intent: fixture.intent, game: fixture.game});
  assert.deepEqual([enemy.ok, enemy.reason], [false, "WILDPATH.COMMON.NotWilling"]);
});

test("another creature only (targeting.notSelf): its source targeting itself is refused, another creature is not", async t => {
  const definition = {schemaVersion: 1, id: "action:help", label: "Help", costs: {allOf: []},
    range: {type: "ranged", normal: {value: 30, unit: "ft"}}, targeting: {type: "single", required: true, count: 1, notHostile: true, notSelf: true}};
  const fixture = syntheticRuntimeFixture(t, definition);
  const other = await foundryActionIntentToStagedOptions({senderUserId: "player-a", intent: fixture.intent, game: fixture.game});
  assert.equal(other.ok, true, JSON.stringify(other.reason));
  const built = buildFoundryActionUseIntent({actor: fixture.sourceActor, action: fixture.action,
    game: {user: {targets: new Set([{document: fixture.sourceToken}])}}});
  const self = await foundryActionIntentToStagedOptions({senderUserId: "player-a", intent: built.intent, game: fixture.game});
  assert.deepEqual([self.ok, self.reason], [false, "WILDPATH.COMMON.NotSelf"]);
});

test("a target size limit (targeting.maxSize): a larger creature is refused before anything is rolled or spent (Telekinesis, Q41)", async t => {
  const definition = {schemaVersion: 1, id: "action:telekinesis", label: "Telekinesis", costs: {allOf: [{capability: "action", amount: 1}]},
    range: {type: "ranged", normal: {value: 60, unit: "ft"}}, targeting: {type: "single", required: true, count: 1, maxSize: "huge"},
    save: {ability: "might", dc: {value: 15}}};
  const fixture = syntheticRuntimeFixture(t, definition);
  const use = () => foundryActionIntentToStagedOptions({senderUserId: "player-a", intent: fixture.intent, game: fixture.game});
  Object.assign(fixture.targetToken, {width: 3, height: 3});
  const huge = await use();
  assert.equal(huge.ok, true, JSON.stringify(huge.reason));
  Object.assign(fixture.targetToken, {width: 4, height: 4});
  // The refusal names the largest size allowed.
  const previous = globalThis.game;
  globalThis.game = {i18n: {localize: key => `loc:${key}`, format: (key, data) => `${key}:${data.size}`}};
  t.after(() => { globalThis.game = previous; });
  const gargantuan = await use();
  assert.deepEqual([gargantuan.ok, gargantuan.reason, gargantuan.options], [false, "WILDPATH.COMMON.TargetTooLarge:loc:WILDPATH.SIZES.huge", undefined]);
  assert.equal(fixture.sourceActor.system.resources.action.value, 1, "its Action is not spent");
});

test("a swap with its target (swap: Bait and Switch) is refused before anything is spent when a creature would land on a third (Q49, Q113)", async t => {
  const definition = {schemaVersion: 1, id: "action:bait-and-switch", label: "Bait and Switch", costs: {allOf: [{capability: "action", amount: 1}]},
    range: {type: "ranged", normal: {value: 30, unit: "ft"}}, targeting: {type: "single", required: true, count: 1, notHostile: true}, swap: true};
  const fixture = syntheticRuntimeFixture(t, definition);
  Object.assign(fixture.scene.grid, {getTopLeftPoint: offset => ({x: offset.i * 50, y: offset.j * 50}),
    measurePath: ([a, b]) => ({distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 10})});
  // A Token `size` fields square with its top-left on field (i, j), placed as Foundry measures it.
  const place = (token, i, j, size=1) => Object.assign(token, {x: i * 50, y: j * 50, width: size, height: size,
    getCenterPoint(data={}) { return {x: (data.x ?? this.x) + (25 * size), y: (data.y ?? this.y) + (25 * size)}; },
    getOccupiedGridSpaceOffsets(data={}) {
      const [i0, j0] = [Math.floor((data.x ?? this.x) / 50), Math.floor((data.y ?? this.y) / 50)];
      return Array.from({length: size * size}, (_, n) => ({i: i0 + (n % size), j: j0 + Math.floor(n / size)}));
    }});
  // A Large ally on fields (0..1, 0..1), the user beside it on (2, 0): the ally lands on (2..3, 0..1), the user on (0, 0).
  place(fixture.targetToken, 0, 0, 2);
  place(fixture.sourceToken, 2, 0);
  const use = () => foundryActionIntentToStagedOptions({senderUserId: "player-a", intent: fixture.intent, game: fixture.game});
  const free = await use();
  assert.equal(free.ok, true, JSON.stringify(free.reason));
  assert.equal(planStagedActionResolution({...free.options, services: free.services}).state.actionDefinition.swap, true,
    "the definition the teleport adapter reads once it completes keeps it");
  const wolf = withFoundryActorSystem(fakeActor("wolf", {system: targetActorSystem()}));
  fixture.scene.tokens.push(place(fakeTokenDocument({id: "wolf-token", actor: wolf, scene: fixture.scene, offset: {i: 3, j: 1}}), 3, 1));
  const crowded = await use();
  assert.deepEqual([crowded.ok, crowded.reason, crowded.options], [false, "WILDPATH.TELEPORT.Occupied", undefined]);
  assert.equal(fixture.sourceActor.system.resources.action.value, 1, "its Action is not spent");
});

test("only an eligible target (targeting.eligible): sight one way or the other, a condition, a subtype; refused, nothing spent (Q75, Q127)", async t => {
  const glare = eligible => ({schemaVersion: 1, id: "action:glare", label: "Dreadful Glare", costs: {allOf: [{capability: "action", amount: 1}]},
    range: {type: "ranged", normal: {value: 60, unit: "ft"}}, targeting: {type: "single", required: true, count: 1, eligible},
    save: {ability: "wits", dc: {value: 11}}});
  const seesSource = {equals: {path: "seesSource", value: true}};
  assert.equal(validateActionDefinition(glare(seesSource)).ok, true);
  assert.deepEqual(validateActionDefinition(glare({sees: true})).errors.map(error => error.path), ["targeting.eligible"]);
  const use = async (definition, {source=[], target=[], details}={}) => {
    const fixture = syntheticRuntimeFixture(t, definition);
    fixture.sourceActor.statuses = new Set(source);
    fixture.targetActor.statuses = new Set(target);
    if ( details ) fixture.targetActor.system.details = details;
    const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a", intent: fixture.intent, game: fixture.game});
    assert.equal(fixture.sourceActor.system.resources.action.value, 1, "its Action is not spent");
    return resolved.ok ? true : resolved.reason;
  };
  // 2014 Dreadful Glare: "If the target can see the mummy". A Blinded target can't; the mummy Blinded still is seen.
  assert.equal(await use(glare(seesSource)), true);
  assert.equal(await use(glare(seesSource), {target: ["blinded"]}), "WILDPATH.COMMON.NotEligible");
  assert.equal(await use(glare(seesSource), {source: ["blinded"]}), true, "one way: the target sees the mummy");
  assert.equal(await use(glare(seesSource), {source: ["invisible"]}), "WILDPATH.COMMON.NotEligible", "an Invisible mummy is unseen");
  // 2024: "one creature the mummy can see": the other way.
  const seenBySource = glare({equals: {path: "seenBySource", value: true}});
  assert.equal(await use(seenBySource, {source: ["blinded"]}), "WILDPATH.COMMON.NotEligible");
  assert.equal(await use(seenBySource, {target: ["blinded"]}), true);
  // What else it reads of the target: its conditions and its creature data.
  const screech = glare({all: [{missingCondition: "deafened"}, {not: {equals: {path: "actor.system.details.subtype", value: "demon"}}}]});
  assert.equal(await use(screech), true);
  assert.equal(await use(screech, {target: ["deafened"]}), "WILDPATH.COMMON.NotEligible");
  assert.equal(await use(screech, {details: {type: "fiend", subtype: "demon"}}), "WILDPATH.COMMON.NotEligible");
});

test("targeting.eligible reads a target's stat block name and its controllers: a Swarm of Rats no one controls (Pipes of the Sewers, Q18.6)", async t => {
  const sway = {schemaVersion: 1, id: "action:sway", label: "Sway Rats", costs: {allOf: []}, range: {type: "ranged", normal: {value: 30, unit: "ft"}},
    targeting: {type: "single", required: true, count: 1, eligible: {all: [{equals: {path: "actor.name", value: "Swarm of Rats"}},
      {atMost: {path: "actor.system.companion.controllers.length", value: 0}}]}}, save: {ability: "wits", dc: {value: 15}}};
  const use = async ({name="Swarm of Rats", controllers=[]}={}) => {
    const fixture = syntheticRuntimeFixture(t, sway);
    fixture.targetActor.name = name;
    fixture.targetActor.system.companion = {kind: "companion", controllers};
    const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a", intent: fixture.intent, game: fixture.game});
    return resolved.ok ? true : resolved.reason;
  };
  assert.equal(await use(), true, "a swarm of rats no one controls");
  assert.equal(await use({name: "Swarm of Bats"}), "WILDPATH.COMMON.NotEligible", "another swarm");
  assert.equal(await use({controllers: ["Actor.druid"]}), "WILDPATH.COMMON.NotEligible", "under another creature's control");

  // Its `requires` reads whether such a creature stands in its range at all (`eligibleTargetInRange`): the owner's "enable
  // taking another swarm when an eligible uncontrolled swarm is available", as the action bar greys it out.
  const available = async ({range=30, ...target}={}) => {
    const fixture = syntheticRuntimeFixture(t, {...sway, range: {type: "ranged", normal: {value: range, unit: "ft"}},
      requires: {equals: {path: "eligibleTargetInRange", value: true}}});
    fixture.targetActor.name = target.name ?? "Swarm of Rats";
    fixture.targetActor.system.companion = {kind: "companion", controllers: target.controllers ?? []};
    const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a", intent: fixture.intent, game: fixture.game});
    const {eligibleTargetInRange} = await import("../module/adapters/foundry-v14-auras.mjs");
    return [resolved.ok ? true : resolved.reason, eligibleTargetInRange({range: {normal: {value: range}}, targeting: sway.targeting}, fixture.sourceToken)];
  };
  assert.deepEqual(await available(), [true, true], "a swarm no one controls within 30 feet");
  assert.deepEqual(await available({name: "Swarm of Bats"}), ["WILDPATH.ITEM.CannotUse", false], "none eligible: not available");
  assert.deepEqual(await available({controllers: ["Actor.druid"]}), ["WILDPATH.ITEM.CannotUse", false]);
  assert.deepEqual(await available({range: 0}), ["WILDPATH.ITEM.CannotUse", false], "none in its range");
});

test("an area leaves out a creature its targeting.eligible doesn't admit (a 2014 Vrock's screech: one that can hear it and isn't a demon, Q74)", async t => {
  const {game, intent, action, targetActor, far, scene} = areaFixture(t, {size: 30, self: true, shape: "emanation"});
  const screech = {all: [{missingCondition: "deafened"}, {not: {any: [{equals: {path: "actor.system.details.type", value: "demon"}},
    {equals: {path: "actor.system.details.subtype", value: "demon"}}]}}]};
  action.system.definition.targeting = {type: "area", eligible: screech};
  const caught = async () => {
    const resolved = await foundryActionIntentToStagedOptions({intent: {...intent, area: {points: [{x: 25, y: 25}]}}, senderUserId: "player-a", game});
    assert.equal(resolved.ok, true, resolved.reason);
    return resolved.options.targets.map(target => target.tokenId);
  };
  assert.deepEqual(await caught(), ["target-token", "far-token"], "both hear it");
  targetActor.statuses = new Set(["deafened"]);
  assert.deepEqual(await caught(), ["far-token"], "a Deafened creature is left out");
  targetActor.statuses = new Set();
  far.system.details = {type: "fiend", subtype: "demon"};
  assert.deepEqual(await caught(), ["target-token"], "a demon is left out");
  far.system.details = {};
  // The Robe of Scintillating Colors in a dark room (Q75): its own Bright Light isn't on the Scene yet as its targets are
  // judged, so `seesSource` would leave out all without Darkvision; `seesLitSource` counts its wearer lit.
  scene.tokenVision = true;
  action.system.definition.targeting = {type: "area", eligible: {equals: {path: "seesSource", value: true}}};
  assert.deepEqual(await caught(), [], "in the dark, unseen by both");
  action.system.definition.targeting = {type: "area", eligible: {equals: {path: "seesLitSource", value: true}}};
  assert.deepEqual(await caught(), ["target-token", "far-token"], "lit by its own light, seen by both");
  targetActor.statuses = new Set(["blinded"]);
  assert.deepEqual(await caught(), ["far-token"], "a Blinded creature still doesn't see it");
});

test("an area and an Action the authority runs leave out a creature on another plane than their source's (planeOf)", async t => {
  const {game, intent, sourceActor, targetActor, far} = areaFixture(t, {size: 30, self: true, shape: "emanation"});
  const caught = async () => {
    const resolved = await foundryActionIntentToStagedOptions({intent: {...intent, area: {points: [{x: 25, y: 25}]}}, senderUserId: "player-a", game});
    assert.equal(resolved.ok, true, resolved.reason);
    return resolved.options.targets.map(target => target.tokenId);
  };
  targetActor.statuses = new Set(["ethereal"]);
  assert.deepEqual(await caught(), ["far-token"], "an ethereal creature");
  WILDPATH.CONDITIONS.shadowed = {id: "shadowed", plane: "shadow", ruleElements: []};
  t.after(() => { delete WILDPATH.CONDITIONS.shadowed; });
  far.statuses = new Set(["shadowed"]);
  assert.deepEqual(await caught(), [], "a homebrew plane's creature too");
  sourceActor.statuses = new Set(["shadowed"]);
  assert.deepEqual(await caught(), ["far-token"], "the source on its plane reaches it, not the ethereal one");
  // A lasting area's or an aura's own Action (the authority's) skips its target on another plane rather than failing.
  const fixture = syntheticRuntimeFixture(t, fortitudeBlast("agility"));
  fixture.targetActor.statuses = new Set(["ethereal"]);
  const skipped = await foundryActionIntentToStagedOptions({intent: fixture.intent, senderUserId: "player-a", game: fixture.game, action: fixture.action});
  assert.deepEqual([skipped.ok, skipped.options.targets.length], [true, 0]);
});

test("a held creature only (targeting.sourceCondition): a target without that condition from its source is refused (Reel)", async t => {
  const definition = {schemaVersion: 1, id: "action:reel", label: "Reel", costs: {allOf: []}, push: {distance: 30, toward: true},
    targeting: {type: "multiple", required: true, count: 20, sourceCondition: "grappled"}};
  const fixture = syntheticRuntimeFixture(t, definition);
  // The refusal names the condition it needs.
  const previous = globalThis.game;
  globalThis.game = {i18n: {localize: key => `loc:${key}`, format: (key, data) => `${key}:${data.condition}`}};
  t.after(() => { globalThis.game = previous; });
  const free = await foundryActionIntentToStagedOptions({senderUserId: "player-a", intent: fixture.intent, game: fixture.game});
  assert.deepEqual([free.ok, free.reason], [false, "WILDPATH.COMMON.NotHeld:loc:WILDPATH.CONDITIONS.Grappled"]);
  // Grappled by another creature is not held by this one.
  const grappled = sourceRef => ({id: "grab", statuses: new Set(["grappled"]), flags: {wildpath: {conditionEffect: {sourceRef}}}});
  fixture.targetActor.effects = [grappled("Actor.someone-else")];
  assert.equal((await foundryActionIntentToStagedOptions({senderUserId: "player-a", intent: fixture.intent, game: fixture.game})).ok, false);
  fixture.targetActor.effects = [grappled(fixture.sourceActor.uuid)];
  const held = await foundryActionIntentToStagedOptions({senderUserId: "player-a", intent: fixture.intent, game: fixture.game});
  assert.equal(held.ok, true, JSON.stringify(held.reason));
});

test("an aimed push (push.choose): the authority checks its landing again and passes options.pushTo; none or a far one is refused", async t => {
  const definition = {schemaVersion: 1, id: "action:telekinesis", label: "Telekinesis", costs: {allOf: []},
    range: {type: "ranged", normal: {value: 60, unit: "ft"}}, targeting: {type: "single", required: true, count: 1},
    save: {ability: "might", dc: {value: 15}}, push: {distance: 30, choose: "space", inRange: true}};
  const fixture = syntheticRuntimeFixture(t, definition);
  // What a landing's checks ask of the Scene and Tokens (FakeSquareGrid: offset i the column, j the row).
  Object.assign(fixture.scene.grid, {getTopLeftPoint: ({i, j}) => ({x: i * 50, y: j * 50}),
    measurePath: ([a, b]) => ({distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 50 * 5})});
  for ( const token of fixture.scene.tokens ) Object.assign(token, {
    getCenterPoint: (at=token) => ({x: at.x + 25, y: at.y + 25}),
    getSnappedPosition: at => ({x: Math.round(at.x / 50) * 50, y: Math.round(at.y / 50) * 50}),
    getOccupiedGridSpaceOffsets: (at=token) => [fixture.scene.grid.getOffset({x: at.x + 1, y: at.y + 1})]});
  const use = push => foundryActionIntentToStagedOptions({senderUserId: "player-a", intent: {...fixture.intent, ...push}, game: fixture.game});
  assert.deepEqual([(await use({})).ok, (await use({})).reason], [false, "WILDPATH.PUSH.Place"]);
  const far = await use({push: {point: {x: 50 + 25, y: 400 + 25}}});
  assert.deepEqual([far.ok, far.reason], [false, "WILDPATH.PUSH.OutOfRange"], "40 feet from the creature");
  const near = await use({push: {point: {x: 60, y: 260}}});
  assert.equal(near.ok, true, JSON.stringify(near.reason));
  assert.deepEqual(near.options.pushTo, {tokenId: "target-token", x: 50, y: 250});
  // A creature on the straight way there stops the walk short, so the authority refuses that landing too.
  const blocker = fakeTokenDocument({id: "blocker-token", actor: withFoundryActorSystem(fakeActor("blocker", {system: targetActorSystem()})),
    scene: fixture.scene, offset: {i: 1, j: 2}});
  Object.assign(blocker, {getCenterPoint: (at=blocker) => ({x: at.x + 25, y: at.y + 25}),
    getOccupiedGridSpaceOffsets: (at=blocker) => [fixture.scene.grid.getOffset({x: at.x + 1, y: at.y + 1})]});
  fixture.scene.tokens.push(blocker);
  const blocked = await use({push: {point: {x: 60, y: 260}}});
  assert.deepEqual([blocked.ok, blocked.reason], [false, "WILDPATH.PUSH.Blocked"]);
  const beside = await use({push: {point: {x: 160, y: 260}}});
  assert.equal(beside.ok, true, `a landing whose way passes beside it: ${beside.reason}`);
});

test("a throw (push.thrown, Fling, Q42): the creatures on its landing are targets too, each saving, unchosen; the thrown one still held and small enough", async t => {
  const definition = {schemaVersion: 1, id: "action:fling", label: "Fling", costs: {allOf: []},
    range: {type: "ranged", normal: {value: 60, unit: "ft"}}, targeting: {type: "single", required: true, count: 1, sourceCondition: "grappled",
      maxSize: "large"}, save: {ability: "agility", dc: {value: 25}},
    damage: [{id: "fling", expression: {type: "dice", number: 4, faces: 8}, damageType: "bludgeoning", saveOutcomePolicy: {success: "half", failure: "full"}}],
    effects: [{id: "prone", type: "condition", conditionId: "prone", saveOutcomePolicy: "failure"}],
    push: {distance: 60, choose: "space", thrown: true, seen: true}};
  assert.equal(validateActionDefinition(definition).ok, true);
  assert.deepEqual(validateActionDefinition({...definition, push: {distance: 60, thrown: true}}).errors.map(error => error.path), ["push.thrown"]);
  assert.deepEqual(validateActionDefinition({...definition, push: {...definition.push, on: "failure"}}).errors.map(error => error.path), ["push.on"],
    "a throw only on a failed save is refused, not ignored");
  assert.deepEqual(validateActionDefinition({...definition, targetChoice: {from: "creatures", range: 30}}).errors.map(error => error.path),
    ["push.choose"], "an aimed push on a creature picked after its offer");
  const fixture = syntheticRuntimeFixture(t, definition);
  Object.assign(fixture.scene.grid, {getTopLeftPoint: ({i, j}) => ({x: i * 50, y: j * 50}),
    measurePath: ([a, b]) => ({distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 50 * 5})});
  fixture.scene.walls = [];
  const shaped = token => Object.assign(token, {
    getCenterPoint: (at=token) => ({x: at.x + (25 * (token.width ?? 1)), y: at.y + (25 * (token.width ?? 1))}),
    getOccupiedGridSpaceOffsets: (at=token) => Array.from({length: (token.width ?? 1) ** 2}, (_, n) =>
      ({i: Math.floor(at.x / 50) + (n % (token.width ?? 1)), j: Math.floor(at.y / 50) + Math.floor(n / (token.width ?? 1))}))});
  for ( const token of fixture.scene.tokens ) shaped(token);
  // An ally standing where the creature is thrown: a Huge one the kraken does not hold.
  const ally = withFoundryActorSystem(fakeActor("ally", {system: targetActorSystem()}));
  const allyToken = shaped(Object.assign(fakeTokenDocument({id: "ally-token", actor: ally, scene: fixture.scene, offset: {i: 6, j: 0}}),
    {width: 3, height: 3}));
  Object.assign(ally, {uuid: `${allyToken.uuid}.Actor.ally`, isToken: true, token: allyToken, tokens: [allyToken]});
  fixture.scene.tokens.push(allyToken);
  const fromFixture = globalThis.fromUuid;
  globalThis.fromUuid = async ref => ((ref === ally.uuid) ? ally : fromFixture(ref));
  const use = (point=null) => foundryActionIntentToStagedOptions({senderUserId: "player-a", game: fixture.game,
    intent: {...fixture.intent, ...(point ? {push: {point}} : {})}});
  const previous = globalThis.game;
  globalThis.game = {i18n: {localize: key => key, format: key => key}};
  t.after(() => { globalThis.game = previous; });
  assert.equal((await use({x: 310, y: 10})).reason, "WILDPATH.COMMON.NotHeld", "not held by the kraken");
  fixture.targetActor.effects = [{id: "grab", statuses: new Set(["grappled"]), flags: {wildpath: {conditionEffect: {sourceRef: fixture.sourceActor.uuid}}}}];
  assert.equal((await use()).reason, "WILDPATH.PUSH.Place");
  const open = await use({x: 210, y: 210});
  assert.equal(open.ok, true, JSON.stringify(open.reason));
  assert.deepEqual([open.options.targets.map(target => target.tokenId), open.options.pushTo], [["target-token"], {tokenId: "target-token", x: 200, y: 200}]);
  const onAlly = await use({x: 310, y: 10});
  assert.equal(onAlly.ok, true, JSON.stringify(onAlly.reason));
  assert.deepEqual(onAlly.options.targets.map(target => target.tokenId), ["target-token", "ally-token"],
    "the ally where it lands saves too, though Huge, not held and not chosen");
  assert.equal(onAlly.options.pushTo.x, 250, "the thrown creature ends beside it");
  const planned = planStagedActionResolution({...onAlly.options, services: onAlly.services});
  assert.notEqual(planned.state.status, "failed", JSON.stringify(planned.state.trace?.at?.(-1) ?? planned.state.failure ?? null));
  assert.deepEqual(planned.state.pendingRequests.filter(request => request.payload?.rollKind === "save")
    .map(request => request.payload.targets.map(target => target.tokenId ?? target.target?.tokenId)), [["target-token"], ["ally-token"]], "each makes its own save");
  assert.equal((await use({x: 960, y: 10})).reason, "WILDPATH.PUSH.OutOfRange", "beyond 60 feet of the kraken");
  Object.assign(fixture.targetToken, {width: 3, height: 3});
  assert.equal((await use({x: 210, y: 210})).reason, "WILDPATH.COMMON.TargetTooLarge", "the thrown creature is Huge");
});

test("shared healing (a Trigger of kind shared-healing: Life Bond, homebrew): a summoned creature near its healed summoner shares the healing", async t => {
  const {sharedHealingRule, healedOthersFor} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const trigger = data => ({schemaVersion: 1, id: "t", type: "Trigger", data: {event: "healing.applied", ...data}});
  const vitality = {id: "sv", name: "Shared Vitality", system: {active: true, ruleElements: [trigger({kind: "shared-healing", from: "summoner",
    range: 10, minimumCastLevel: 0, tagsAll: ["spell"]})]}};
  assert.deepEqual(sharedHealingRule({items: [vitality]}), {name: "Shared Vitality", range: 10, minimumCastLevel: 0, tagsAll: ["spell"]});
  assert.equal(sharedHealingRule({items: [{...vitality, system: {...vitality.system, active: false}}]}), null, "an inactive feature");
  assert.equal(sharedHealingRule({items: []}), null);
  assert.deepEqual(sharedHealingRule({items: [{name: "Life Bond", system: {ruleElements: [trigger({kind: "shared-healing"})]}}]}),
    {name: "Life Bond", range: 5, minimumCastLevel: 1, tagsAll: ["spell"]}, "the defaults");
  // Blessed Healer's reward reads only its own kind: a shared-healing Trigger is no healer reward.
  const healer = {name: "Blessed Healer", system: {ruleElements: [trigger({kind: "healer", othersOnly: true, hitPoints: {type: "add",
    terms: [{type: "constant", value: 2}, {type: "context", path: "castLevel"}]}})]}};
  assert.equal(healedOthersFor({uuid: "Actor.c", items: [vitality]}, {}, 3), null);
  assert.equal(healedOthersFor({uuid: "Actor.c", items: [healer]}, {}, 3)?.hitPoints, 5, "2 + the slot's level");
  // In play: the healed target's summon 5 feet away, with the homebrew rule, shares a spell's healing (no slot needed).
  const f = syntheticRuntimeFixture(t, {schemaVersion: 1, id: "healing:spell", label: "Healing spell", tags: ["spell"],
    targeting: {type: "single", required: true, count: 1}, healing: [{id: "fixed", expression: {type: "constant", value: 6}}]});
  const familiar = withFoundryActorSystem(fakeActor("familiar", {system: targetActorSystem()}));
  familiar.items = [vitality];
  const token = fakeTokenDocument({id: "familiar-token", actor: familiar, scene: f.scene, offset: {i: 2, j: 0}, disposition: f.targetToken.disposition});
  token.flags = {wildpath: {summon: {casterUuid: f.targetActor.uuid}}};
  f.scene.tokens.push(token);
  const bonds = async () => (await foundryActionIntentToStagedOptions({senderUserId: "player-a", intent: f.intent, game: f.game}))
    .options.durability.lifeBonds ?? [];
  assert.deepEqual((await bonds()).map(bond => bond.target.tokenId), ["familiar-token"]);
  familiar.items = [{...vitality, system: {active: true, ruleElements: [trigger({kind: "shared-healing", tagsAll: ["spell"]})]}}];
  assert.deepEqual(await bonds(), [], "Life Bond's own defaults: a cantrip-level cast (0) is not level 1+");
});

test("healing its own creature by the damage dealt (appliesTo: \"source\") commits on it; a spell's is shared with its bonded steed, another's not", async t => {
  const touch = tags => ({schemaVersion: 1, id: "action:touch", label: "Touch", ...(tags ? {tags} : {}),
    costs: {allOf: [{capability: ECONOMY_CAPABILITIES.ACTION, amount: 1}]}, range: {type: "touch"},
    targeting: {type: "single", required: true, count: 1},
    damage: [{id: "necrotic", expression: {type: "constant", value: 6}, damageType: "necrotic", provenance: "spell-base"}],
    healing: [{id: "share", healingType: "healing", appliesTo: "source", amount: {damage: ["necrotic"]}}]});
  const used = async tags => {
    const fixture = syntheticRuntimeFixture(t, touch(tags));
    fixture.sourceActor.system.resources.health = {value: 10, max: 30};
    const steed = withFoundryActorSystem(fakeActor("steed", {system: targetActorSystem(5, 20)}));
    steed.items = [{name: "Life Bond", system: {active: true, ruleElements: [{schemaVersion: 1, id: "bond", type: "Trigger",
      data: {event: "healing.applied", kind: "shared-healing", minimumCastLevel: 0, tagsAll: ["spell"]}}]}}];
    const token = fakeTokenDocument({id: "steed-token", actor: steed, scene: fixture.scene, offset: {i: 0, j: 1}});
    Object.assign(steed, {uuid: `${token.uuid}.Actor.steed`, isToken: true, token, tokens: [token]});
    token.flags = {wildpath: {summon: {casterUuid: fixture.sourceActor.uuid}}};
    fixture.scene.tokens.push(token);
    const resolved = await foundryActionIntentToStagedOptions({intent: fixture.intent, senderUserId: "player-a", game: fixture.game});
    assert.equal(resolved.ok, true, resolved.reason);
    assert.equal(resolved.options.targetActors[fixture.sourceActor.uuid], fixture.sourceActor, "committed on like a target");
    const record = await declaredRecord(fixture.game, fixture.intent);
    return [fixture.targetActor.system.resources.health.value, fixture.sourceActor.system.resources.health.value, steed.system.resources.health.value,
      record.state.results.healingResolution.results.map(result => [result.target.tokenId, result.total])];
  };
  assert.deepEqual(await used(["spell"]), [14, 16, 11, [["source-token", 6]]], "6 Necrotic dealt, 6 regained, and its steed 5 ft away regains 6 too");
  assert.deepEqual(await used(null), [14, 16, 5, [["source-token", 6]]], "not a spell: its steed's Life Bond gives nothing");
});

for ( const hiddenOrDead of ["hidden", "dead"] ) test(`healing one creature an area covered (appliesTo: {from: "area"}): a ${hiddenOrDead} creature in it is never offered`, async t => {
  const fixture = areaFixture(t, {shape: "wall", size: 25});
  fixture.action.system.definition.healing = [{id: "aid", healingType: "healing", expression: {type: "constant", value: 5}, appliesTo: {from: "area"}}];
  if ( hiddenOrDead === "hidden" ) fixture.farToken.hidden = true;
  else fixture.far.statuses = new Set(["dead"]);
  const record = await declaredRecord(fixture.game, {...fixture.intent, area: {points: [{x: 75, y: 25}, {x: 125, y: 25}]}});
  // Live 9: a dead creature is an object, so the area passes it by (no save, no damage); a hidden one is still in it.
  const dead = hiddenOrDead === "dead";
  assert.deepEqual(record.options.targets.map(target => target.tokenId), dead ? ["target-token"] : ["target-token", "far-token"],
    dead ? "the dead creature is not in the area" : "both in the area");
  assert.deepEqual([fixture.targetActor.system.resources.health.value, fixture.far.system.resources.health.value], [29, dead ? 30 : 24],
    "the only creature it may go to takes it unasked: 30 less 6, then 5");
});

/**
 * A 25-foot wall over the target and the bystander, its targeting `extra` (a refinementPolicy); `prepare` changes the fixture.
 * The plan, its target refinement request (if any) and a resume answering it with `decisions` (by Token id).
 */
async function chosenAreaPlan(t, extra, prepare=() => {}) {
  const fixture = areaFixture(t, {shape: "wall", size: 25});
  Object.assign(fixture.action.system.definition.targeting, extra);
  prepare(fixture);
  const resolved = await foundryActionIntentToStagedOptions({intent: {...fixture.intent, area: {points: [{x: 75, y: 25}, {x: 125, y: 25}]}},
    senderUserId: "player-a", game: fixture.game});
  assert.equal(resolved.ok, true, resolved.reason);
  const planned = planStagedActionResolution({...resolved.options, services: resolved.services});
  const request = planned.state.pendingRequests.find(entry => entry.type === RESOLUTION_REQUEST_TYPES.TARGET_REFINEMENT) ?? null;
  const idOf = tokenId => request.payload.candidates.find(candidate => candidate.target?.tokenId === tokenId)?.id;
  const answer = decisions => resumeStagedActionResolution({state: planned.state, services: resolved.services, response: {resolutionId: planned.state.id,
    requestId: request.id, type: request.type, value: {decisions: decisions.map(([operation, tokenId]) => ({operation,
      targetId: idOf(tokenId) ?? tokenId}))}}});
  const plans = (state, type) => state.mutationPlans.filter(entry => entry.type === type).map(entry => [entry.target.tokenId, entry.plan.to]);
  return {fixture, planned, request, answer, plans, services: resolved.services};
}

test("each creature of its user's choice in an area (refinementPolicy.requiresSelection, Q105 (b)): asked, all ticked; those left out are spared", async t => {
  const plain = await chosenAreaPlan(t, {});
  assert.equal(plain.request, null, "a plain area asks no one: every creature in it");
  const {request, answer, plans} = await chosenAreaPlan(t, {refinementPolicy: {requiresSelection: true}});
  const chooser = projectPendingRequestPayloadForChooser(request.type, request.payload);
  assert.deepEqual(chooser.candidates.map(candidate => [candidate.target.tokenId, candidate.selected]),
    [["target-token", true], ["far-token", true]], "its user is asked, every creature in it ticked at first");
  const spared = answer([["deselect", "target-token"]]);
  assert.equal(spared.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(spared.state.errors));
  assert.deepEqual(plans(spared.state, "durabilityDamage"), [["far-token", 24]], "the creature left out takes nothing");
  const none = answer([["deselect", "target-token"], ["deselect", "far-token"]]);
  assert.deepEqual([none.state.status, plans(none.state, "durabilityDamage")], [RESOLUTION_STATE_STATUS.READY_TO_COMMIT, []],
    "every creature left out: it still happens");
  assert.equal(answer([["deselect", "source-token"]]).ok, false, "one not in the area is refused");
  const empty = await chosenAreaPlan(t, {refinementPolicy: {requiresSelection: true}}, fixture => {
    for ( const actor of [fixture.targetActor, fixture.far] ) actor.statuses = new Set(["dead"]);
  });
  assert.deepEqual([empty.request, empty.planned.state.status], [null, RESOLUTION_STATE_STATUS.READY_TO_COMMIT],
    "an area that caught no one asks no one");
  // Slow: "up to six creatures of your choice" - at most that many (here one) stay chosen.
  const one = await chosenAreaPlan(t, {count: 1, refinementPolicy: {requiresSelection: true}});
  assert.equal(one.answer([]).ok, false, "both left chosen: too many");
  assert.deepEqual(plans(one.answer([["deselect", "far-token"]]).state, "durabilityDamage"), [["target-token", 24]]);
});

test("each creature of a player's choice in an area: a GM-hidden one is not offered to the player and stays chosen", async t => {
  const hidden = fixture => {
    fixture.farToken.hidden = true;
    fixture.sourceActor.hasPlayerOwner = true;
  };
  const {request, answer, plans} = await chosenAreaPlan(t, {refinementPolicy: {requiresSelection: true}}, hidden);
  const chooser = projectPendingRequestPayloadForChooser(request.type, request.payload);
  assert.deepEqual(chooser.candidates.map(candidate => candidate.target.tokenId), ["target-token"], "not listed, not even unnamed");
  assert.deepEqual(plans(answer([["deselect", "target-token"]]).state, "durabilityDamage"), [["far-token", 24]], "still caught");
  const gm = await chosenAreaPlan(t, {refinementPolicy: {requiresSelection: true}}, fixture => { fixture.farToken.hidden = true; });
  assert.deepEqual(projectPendingRequestPayloadForChooser(gm.request.type, gm.request.payload).candidates
    .map(candidate => candidate.target.tokenId), ["target-token", "far-token"], "the GM's creature's choice lists it");
});

test("an area's from: \"area\" healing goes to a creature it covered, chosen or not, though none was chosen (Land's Aid, Q77, Q105 (b))", async t => {
  const aid = fixture => {
    fixture.action.system.definition.healing = [{id: "aid", healingType: "healing", expression: {type: "constant", value: 5},
      appliesTo: {from: "area"}}];
    fixture.targetActor.statuses = new Set(["dead"]);
    fixture.far.system.resources.health.value = 20;
  };
  const {answer, plans} = await chosenAreaPlan(t, {refinementPolicy: {requiresSelection: true}}, aid);
  const spared = answer([["deselect", "far-token"]]);
  assert.equal(spared.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(spared.state.errors));
  assert.deepEqual([plans(spared.state, "durabilityDamage"), plans(spared.state, "durabilityHealing")], [[], [["far-token", 25]]],
    "the only living creature in it was left out: no damage, and it regains 5");
  // Gated on a failed save, it is earned and received only by a target that failed it, never by one left out.
  const gated = await chosenAreaPlan(t, {refinementPolicy: {requiresSelection: true}}, fixture => {
    aid(fixture);
    fixture.targetActor.statuses = new Set();
    fixture.targetActor.system.resources.health.value = 20;
    Object.assign(fixture.action.system.definition, {damage: [], save: {ability: "agility", dc: {value: 13}}});
    fixture.action.system.definition.healing[0].saveOutcomePolicy = "failure";
  });
  const saving = gated.answer([["deselect", "far-token"]]).state;
  const save = saving.pendingRequests.find(entry => entry.payload?.rollKind === "save");
  const roll = save.payload.rollRequest;
  const saved = resumeStagedActionResolution({state: saving, services: gated.services, response: {resolutionId: saving.id,
    requestId: save.id, type: save.type, value: {requestId: roll.id, resolutionId: saving.id, type: roll.type, natural: 1, total: 1}}}).state;
  assert.deepEqual([saved.pendingRequests.map(entry => entry.type), plans(saved, "durabilityHealing")], [[], [["target-token", 25]]],
    "the target that failed takes it unasked; the creature left out is not offered");
});

test("an Action that may damage its own creature (a choice adding sourceDamage) plans and commits on the caster too", async t => {
  const definition = {...meleeStrikeDefinition(), configuration: [{id: "backlash", type: "select-one", label: "Backlash", required: false,
    options: [{id: "on", value: "on", label: "On", effects: [{type: "add-source-damage", damage: [{id: "self", damageType: "necrotic",
      expression: {type: "constant", value: 3}}]}]}]}]};
  const f = syntheticRuntimeFixture(t, definition);
  const resolved = await foundryActionIntentToStagedOptions({intent: f.intent, senderUserId: "player-a", game: f.game});
  assert.equal(resolved.ok, true, resolved.reason);
  assert.equal(resolved.options.targetActors[f.sourceActor.uuid], f.sourceActor, "committed on like a target");
  assert.ok(resolved.options.durability.targetSystems[f.sourceActor.uuid]?.resources, "its snapshot is planned on");
  const g = syntheticRuntimeFixture(t);
  const plain = await foundryActionIntentToStagedOptions({intent: g.intent, senderUserId: "player-a", game: g.game});
  assert.equal(plain.options.durability.targetSystems[g.sourceActor.uuid], undefined, "not without one");
});

test("an Action that damages its own creature and starts a concentration gives the caster a Concentration state, concentrating before or not", async t => {
  const backlash = {configuration: [{id: "backlash", type: "select-one", label: "Backlash", required: false,
    options: [{id: "on", value: "on", label: "On", effects: [{type: "add-source-damage", damage: [{id: "self", damageType: "necrotic",
      expression: {type: "constant", value: 3}}]}]}]}]};
  const state = async definition => {
    const f = syntheticRuntimeFixture(t, definition);
    const resolved = await foundryActionIntentToStagedOptions({intent: f.intent, senderUserId: "player-a", game: f.game});
    assert.equal(resolved.ok, true, resolved.reason);
    return resolved.options.concentration?.states?.[f.sourceActor.uuid] ?? null;
  };
  const starting = await state({...meleeStrikeDefinition(), ...backlash, concentration: {}});
  assert.equal(starting?.concentrating, true, "its check keeps the concentration this Action starts");
  const policy = async () => {
    const f = syntheticRuntimeFixture(t, {...meleeStrikeDefinition(), ...backlash, concentration: {}});
    return (await foundryActionIntentToStagedOptions({intent: f.intent, senderUserId: "player-a", game: f.game})).options.concentration.policy;
  };
  assert.equal((await policy()).maximumDC, 30, "2024: its DC is at most 30");
  const modern = {...WILDPATH.CONCENTRATION};
  Object.assign(WILDPATH.CONCENTRATION, WILDPATH.CONCENTRATION_2014);
  try {
    assert.equal((await policy()).maximumDC, null, "2014: no cap");
  } finally {
    Object.assign(WILDPATH.CONCENTRATION, modern);
  }
  assert.equal(await state({...meleeStrikeDefinition(), ...backlash}), null, "none without a concentration");
  assert.equal(await state({...meleeStrikeDefinition(), concentration: {}}), null, "none without damage to itself");
});

test("a potion given to a willing creature within 5 feet hastes that creature, its giver its source, and spends the potion once (Potion of Speed)", async t => {
  const fs = await import("node:fs");
  const potion = JSON.parse(fs.readFileSync("packs/_source/srd-items/potion-of-speed-haste-1epg8pfsxegr5000.json", "utf8"));
  const fixture = syntheticRuntimeFixture(t, potion.system.definition);
  fixture.sourceActor.system.pools = [{id: "potion-of-speed", value: 1, max: 1}];
  const plan = async intent => {
    const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a", intent, game: fixture.game});
    if ( !resolved.ok ) return resolved;
    const planned = await planStagedActionResolution(resolved.options);
    assert.equal(planned.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(planned.state.errors));
    return planned.state.mutationPlans;
  };
  const given = await plan(fixture.intent);
  assert.deepEqual(given.filter(entry => entry.type === "conditionEffect").map(entry => [entry.definition.name, entry.target.actor.ref, entry.sourceRef]),
    [["Hasted", "actor:target-model", "token:source-token"]], "Hasted on the creature it is given to, its giver the source");
  assert.deepEqual(given.filter(entry => entry.type === "resourcePayment").map(entry => entry.plan.updates),
    [{"system.resources.bonus.value": 0, "system.pools.0.value": 0}], "its giver's Bonus Action and the potion's one use, once");
  const drunk = buildFoundryActionUseIntent({actor: fixture.sourceActor, action: fixture.action,
    game: {user: {targets: new Set([{document: fixture.sourceToken}])}}});
  assert.deepEqual((await plan(drunk.intent)).filter(entry => entry.type === "conditionEffect").map(entry => entry.target.actor.ref),
    ["actor:source-model"], "drunk: Hasted on its drinker");
  const untargeted = buildFoundryActionUseIntent({actor: fixture.sourceActor, action: fixture.action, game: {user: {targets: new Set()}}});
  assert.deepEqual((await plan(untargeted.intent)).filter(entry => entry.type === "conditionEffect").map(entry => entry.target.actor.ref),
    ["actor:source-model"], "nothing targeted: drunk by its user (selfIfNone)");
  fixture.targetToken.disposition = 1;
  const foe = await plan(fixture.intent);
  assert.deepEqual([foe.ok, foe.reason], [false, "WILDPATH.COMMON.NotWilling"], "never given to a hostile creature");
});

test("a potion is drunk by a user with no Token the authority sees: its range needs none to reach its own drinker", async t => {
  const fs = await import("node:fs");
  const potion = JSON.parse(fs.readFileSync("packs/_source/srd-items/potion-of-speed-haste-1epg8pfsxegr5000.json", "utf8"));
  const fixture = syntheticRuntimeFixture(t, potion.system.definition);
  fixture.sourceActor.system.pools = [{id: "potion-of-speed", value: 1, max: 1}];
  // Its Token on a Scene the authority does not view, or none at all.
  fixture.scene.tokens = [fixture.targetToken];
  Object.assign(fixture.sourceActor, {isToken: false, token: null, tokens: []});
  const intent = buildFoundryActionUseIntent({actor: fixture.sourceActor, action: fixture.action, game: {user: {targets: new Set()}}}).intent;
  const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a", intent, game: fixture.game});
  assert.equal(resolved.ok, true, resolved.reason);
  const planned = await planStagedActionResolution(resolved.options);
  assert.equal(planned.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(planned.state.errors));
  assert.deepEqual(planned.state.mutationPlans.filter(entry => entry.type === "conditionEffect").map(entry => entry.target.target.actorId),
    ["source-model"], "Hasted on its drinker");
});
