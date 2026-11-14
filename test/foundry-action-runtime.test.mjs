import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {ECONOMY_CAPABILITIES} from "../module/helpers/action-economy.mjs";
import {CREATURE_SIZES} from "../module/helpers/grid-footprints.mjs";
import {RESOLUTION_STATE_STATUS, validateResolutionStateSerializable} from "../module/helpers/resolution-state.mjs";
import {createActionResolutionState, planStagedActionResolution, resumeStagedActionResolution} from "../module/resolvers/action-pipeline-resolver.mjs";
import {withFoundryActorSystem} from "./fixtures/foundry-actor-system.mjs";
import {portentHolders, portentPayment} from "../module/adapters/foundry-v14-portent.mjs";
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
import {createPhysicalDiceProvider, createTestRollProvider} from "../module/resolvers/roll-provider-resolver.mjs";
import {createTestPromptAdapter} from "../module/adapters/test-prompt-adapter.mjs";
import {createFoundryReactionProvider} from "../module/adapters/foundry-v14-reaction-provider.mjs";
import {areaCovers, areaExpired, areaFields, createFoundryPersistentAreas} from "../module/adapters/foundry-v14-persistent-areas.mjs";
import {automationTriggers, createFoundryAutomationDispatcher} from "../module/adapters/foundry-v14-automation-dispatcher.mjs";
import {inspectResolution} from "../module/helpers/resolution-inspection.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {convertItem} from "../scripts/content/dnd5e-to-wildpath.mjs";
import {damageProfileFromRuleElements, rollModesFromRuleElements, rollOutcomesFromRuleElements} from "../module/helpers/rule-elements.mjs";
import {WILDPATH} from "../module/config.mjs";
import {rollFormulaForRequest} from "../module/helpers/rolls.mjs";
import {
  actionCompletedEvent,
  actionCover,
  buildFoundryActionUseIntent,
  conditionsFrom,
  foundryActionIntentToStagedOptions,
  foundryActionOdds,
  reportActionCompleted,
  usedOptionActions
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
  const action = actionItem(definition, sourceActor);
  if ( actionFlags ) action.flags = actionFlags;
  const resolved = await foundryActionIntentToStagedOptions({senderUserId: "player-a", game: fakeGame({actors: [sourceActor, targetActor,
    ...extraActors], scenes: [scene]}), intent: {actorRef: sourceActor.uuid, actionRef: action.uuid,
    targetRefs: [{actorRef: targetActor.uuid, tokenId: targetToken.id, sceneId: scene.id}]}});
  assert.equal(resolved.ok, true, resolved.reason);
  if ( attackRoll ) resolved.options.attack = {...resolved.options.attack, roll: attackRoll};
  if ( saveRoll ) resolved.options.save = {...resolved.options.save, roll: saveRoll};
  return planStagedActionResolution(resolved.options);
}

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
  assert.equal(await offered({charges: 0}), 0, "no charge left");
  assert.equal(await offered({reaction: 0}), 0, "no Reaction left");

  // A Stunned creature fails its Agility save automatically; an offer with no Reaction still makes it a success, as Legendary
  // Resistance does (Q22). (Stunned is Incapacitated, whose cap leaves the ring's Reaction at 0, as above.)
  const stunned = await plannedWithConditions(fortitudeBlast("agility"), {target: ["stunned"], saveRoll: failing,
    prepareTarget: wearing({offer: {...RING, reaction: false}})});
  assert.equal(choose(stunned.state, "test-offer:ring").results.saveResolution.successes[0]?.succeededInstead, true);
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
  assert.deepEqual([gm.authority.kind, gm.payload.options.map(option => option.value)], ["gm", ["spend:Actor.hero", "keep"]]);
  const monsterRerolled = answer(answer(monster.state, "spend:Actor.hero").state, 2).state;
  assert.equal(monsterRerolled.results.attackResolution.hits.length, 0, "the monster's reroll misses");
  assert.ok(monsterRerolled.mutationPlans.some(plan => plan.payerRef === "Actor.hero"), "paid by the hero");

  // Its own failed save: the target's controller is asked, the reroll saves, and the target pays.
  const saving = await plannedWithConditions(fortitudeBlast("might"), {saveRoll: {total: 2, natural: 2, die: 2},
    prepareTarget: inspired(1)});
  const [saveChoice] = saving.state.pendingRequests;
  assert.deepEqual([saveChoice.authority.kind, saveChoice.payload.options[0].value], ["target-controller", "spend:Actor.roll-target"]);
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
function strandedSaveFixture(t, {player=null, planResolution=undefined}={}) {
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
    logger: {error() {}, warn() {}}, ...(planResolution ? {planResolution} : {}),
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
  queue=null, pick=null, items=null, holderItems=null, gmQueue=null, gmMessageMode=null, choose=null}={}) {
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
    ...(gmMessageMode ? {rollContext: {messageMode: gmMessageMode}} : {}),
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
        return {choices: {[request.payload.id]: (typeof choose === "function" ? choose(request, scene) : choose) ?? request.payload.defaultValue}};
      }
      offers.push(request);
      const candidates = request.payload.candidates;
      return {decision: "use", candidateId: (candidates.find(candidate => pick && String(candidate.actionId ?? "").includes(pick)) ?? candidates[0]).id};
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
    assert.deepEqual(posts.map(post => post.result.source?.tokenRef), [targetToken.uuid, sourceToken.uuid],
      "each card knows the Token its Action was used from, so that Token speaks");
    assert.equal(JSON.stringify(posts[0].result).includes('"defense"'), false, "the card sees only the public projection");
  } else {
    assert.equal(sourceActor.system.resources.health.value, 20);
    assert.equal(targetActor.system.resources.reaction.value, 1);
  }
});

test("a reaction's card follows its chooser's message mode", async t => {
  const {gm, player, posts, intent} = counterattackFixture(t, {gmMessageMode: "gm"});
  const declared = await player.declareActionIntent(intent);
  assert.equal(gm.getRecord(declared.resolutionId)?.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.deepEqual(posts.map(post => [post.result.action?.name, post.messageMode]), [["Counterattack", "gm"], ["Runtime Melee Strike", null]],
    "the GM chose the counterattack in GM-only mode; the player's own Action keeps theirs");
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
  assert.equal(record?.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify([record?.state.trace?.slice(-3), record?.state.pendingRequests]).slice(0, 3000));
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
});

/** A burst whose ground keeps burning; the Scene can hold Regions and the GM runs the turn. */
function lastingAreaFixture(t, {shape="radial", range=60, rounds=10, concentration=false, on=["turn.started"], light=null,
  affects=null, dismissSummon=null, failOn=null, rollProviders=[], rollContext={}}={}) {
  const fixture = areaFixture(t, {shape, range, persistence: {duration: {unit: "round", value: rounds}, elevation: {bottom: 0, top: 0},
    concentration, triggers: [{on, action: BURNING}], ...(light ? {light} : {}), ...(affects ? {affects} : {})}});
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
    rollContext: {physicalRolls: [{total: 13}]}});
  const health = targetActor.system.resources.health.value;
  assert.ok(game.combat, "in combat, where once per turn would otherwise apply");
  const results = await areas.apply(region, flag, targetToken, "area.moved", {feet: 15});
  assert.equal(results.length, 1, "one resolution for the step");
  assert.deepEqual(seen.map(request => rollFormulaForRequest(request).formula), ["6d4"], "2d4 for each of the three 5 feet");
  assert.equal(targetActor.system.resources.health.value, health - 13, "the table's physical dice are the damage");
  assert.equal(flag.applied[targetToken.id], undefined, "it spends no once per turn");
  await areas.apply(region, flag, targetToken, "area.moved", {feet: 5});
  assert.equal(seen.length, 2, "the next step in the same turn hurts again");
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

  // A Restrained it already has from elsewhere (a Net) is one effect with the webs': leaving the webs leaves it held.
  flag.applied = {};
  await areas.apply(region, flag, targetToken, "area.entered");
  delete held()[0].flags.wildpath.conditionEffect.metadata.regionId;
  flag.applied = {};
  await areas.apply(region, flag, targetToken, "area.entered");
  await areas.apply(region, flag, targetToken, "area.exited");
  assert.equal(held().length, 1, "the Net still holds it");
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

/** A summoned creature's Token (a Flaming Sphere, a Guardian of Faith) beside the lasting area fixture's creatures. */
function summonedToken(fixture, id, offset) {
  const {scene, sourceActor} = fixture;
  const actor = withFoundryActorSystem(fakeActor(`${id}-model`, {system: targetActorSystem(10, 10)}));
  const token = fakeTokenDocument({id, actor, scene, offset});
  Object.assign(actor, {uuid: `${token.uuid}.Actor.${actor.id}`, isToken: true, token, tokens: [token]});
  token.flags = {wildpath: {summon: {casterUuid: sourceActor.uuid, kind: "summon"}}};
  token.update = async data => { token.light = data.light; };
  token.getCenterPoint = () => ({x: token.x + (scene.grid.sizeX / 2), y: token.y + (scene.grid.sizeY / 2)});
  scene.tokens.push(token);
  return token;
}

/** A summon Action whose creature carries a lasting area of BURNING, `damage` a time, on `on` (summon.area). */
const carrying = (damage, {on=["turn.ended"], size=5, persistence={}}={}) => ({schemaVersion: 1, id: "action:sphere", label: "Sphere",
  costs: {allOf: []}, summon: {actorRef: "Actor.sphere", count: 1, area: {shape: "emanation", size: {value: size, unit: "ft"},
    persistence: {...persistence, triggers: [{on, action: {...BURNING, damage: [{...BURNING.damage[0], expression: {type: "constant", value: damage}}]}}]}}}});

test("a summon's carried area: attached to its creature, drawn as it is worked out, its caster's, its slot's, never itself (summon.area)", async t => {
  const fixture = lastingAreaFixture(t);
  const {scene, sourceToken, targetActor, targetToken, far, farToken, areas, game} = fixture;
  const sphere = summonedToken(fixture, "sphere", {i: 2, j: 0});
  const light = {persistence: {light: {bright: 20, dim: 40}}};
  const event = {state: {source: {tokenId: sourceToken.id}, actionDefinition: carrying(4, light),
    configuration: {effectiveDefinition: carrying(6, light)}}};
  const [region] = await areas.carry(event, [sphere]);
  const flag = region.flags.wildpath.area;
  assert.deepEqual([region.attachment.token, flag.anchorTokenId, flag.sourceTokenId, flag.castLevel], ["sphere", "sphere", "source-token", null],
    "it follows the sphere; it is its caster's; no cast level of its own (Dispel Magic ends the summon)");
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
  game.users.activeGM = game.users.get("player-a");
  assert.deepEqual(await areas.carry(event, [sphere]), [], "only the active GM");
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

test("a carried area's cover is measured from the creature carrying it, not from its caster behind a wall, nor given by it", async t => {
  const fixture = lastingAreaFixture(t);
  const {scene, sourceToken, far, farToken, areas} = fixture;
  const guardian = summonedToken(fixture, "guardian", {i: 4, j: 0});
  const [region] = await areas.carry({state: {source: {tokenId: sourceToken.id}, actionDefinition: carrying(4, {on: ["turn.started"]})}},
    [guardian]);
  // A wall across x = 150 (a 50 px grid): between the caster at (0,0) and the far creature at (5,0), not the guardian at (4,0).
  const saved = {canvas: globalThis.canvas, CONFIG: globalThis.CONFIG};
  t.after(() => Object.assign(globalThis, saved));
  globalThis.canvas = {scene};
  globalThis.CONFIG = {...(saved.CONFIG ?? {}), Canvas: {polygonBackends: {sight: {testCollision: (a, b) => (Math.min(a.x, b.x) < 150)
    && (Math.max(a.x, b.x) > 150)}}}};
  assert.equal(actionCover({definition: BURNING, sourceToken, targetToken: farToken}), "total", "from the caster: Total Cover");
  const [state] = await areas.apply(region, region.flags.wildpath.area, farToken, "turn.started");
  assert.equal(far.system.resources.health.value, 26, "beside the guardian, it is still affected");
  // The guardian the lines start from gives no cover itself (live 2026-11-14: Half Cover on every save).
  assert.equal(state.input.context.cover, undefined, "nothing between the guardian and it: no cover");
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

test("an automatic trigger's predicate sees its creature: Regeneration needs at least 1 Hit Point", async t => {
  const {targetActor, targetToken, automation} = lastingAreaFixture(t);
  targetActor.items = [triggerFeature("regeneration", {event: "turn.started",
    predicate: {not: {equals: {path: "actor.system.resources.health.value", value: 0}}}})];
  targetActor.system.resources.health.value = 0;
  assert.deepEqual(await automation.dispatch("turn.started", {actor: targetActor, token: targetToken}), [], "at 0 Hit Points");
  targetActor.system.resources.health.value = 10;
  assert.equal((await automation.dispatch("turn.started", {actor: targetActor, token: targetToken})).length, 1);
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

test("an ethereal creature and one that is not can't target each other; two ethereal ones can", async t => {
  const strike = syntheticRuntimeFixture(t, meleeStrikeDefinition());
  strike.targetActor.statuses = new Set(["ethereal"]);
  const refused = await foundryActionIntentToStagedOptions({intent: strike.intent, senderUserId: "player-a", game: strike.game});
  assert.equal(refused.code, MULTIPLAYER_AUTHORITY_CODES.ACTION_REFUSED);
  assert.match(refused.reason, /REFUSAL.Ethereal|Ethereal Plane/);
  strike.sourceActor.statuses = new Set(["ethereal"]);
  const both = await foundryActionIntentToStagedOptions({intent: strike.intent, senderUserId: "player-a", game: strike.game});
  assert.equal(both.ok, true, JSON.stringify(both.reason));
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
});

/**
 * A ranger (the attacker) with the converted Superior Hunter's Prey, its target carrying a Hunter's Mark from `markedBy`
 * (the ranger by default), and other creatures at `others` ({id: rows below the target}: 5 ft a row); `preyItems`, the
 * one named prey's reactions; `preyState`, it hidden by the GM ("hidden") or already dead ("dead").
 */
async function huntersPreyFixture(t, {markedBy=null, others={prey: 3, far: 12}, natural=null, preyItems=null, preyState=null}={}) {
  const fs = await import("node:fs");
  // The converted feature: its reaction is its own Trigger carrying the Action (no Action Item to use by hand).
  const file = fs.readdirSync("packs/_source/srd-items").find(name => name.startsWith("superior-hunter-s-prey-"));
  const item = JSON.parse(fs.readFileSync(`packs/_source/srd-items/${file}`, "utf8"));
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

test("Superior Hunter's Prey: not offered for another creature's mark; with nobody else within 30 ft it rolls nothing and the hit still lands", async t => {
  const {record, offers} = await huntersPreyFixture(t, {markedBy: "Actor.another-ranger"});
  assert.equal(record.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(offers.length, 0, "the mark isn't its own");

  const alone = await huntersPreyFixture(t, {others: {far: 12}});
  assert.equal(alone.record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(alone.record.state.errors).slice(0, 1500));
  assert.equal(alone.offers.length, 1);
  assert.deepEqual(preyRolls(alone.playerRollRequests), [], "no die rolled for nobody");
  assert.equal((alone.record.state.results.reactions ?? []).some(entry => entry.childFailed), true, "it fails");
  assert.deepEqual([alone.targetActor.system.resources.health.value, alone.creatures.far.system.resources.health.value], [22, 20]);
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

test("Potent Spellcasting's pick: one candidate is taken unasked; none, or a pick no longer a candidate, fails the reaction", async t => {
  // Without itself, only the creature it damaged is within 60 ft.
  const one = await potentSpellcastingFixture(t, {others: {far: 14}, targetChoice: {from: "creatures", range: 60}});
  assert.equal(one.record.state.status, RESOLUTION_STATE_STATUS.COMPLETED, JSON.stringify(one.record.state.errors).slice(0, 1500));
  assert.deepEqual([one.asked.length, one.targetActor.system.resources.health.temp, one.sourceActor.system.resources.health.temp ?? 0],
    [0, 6, 0]);

  // Within 1 ft of it: nobody, not even the creature it damaged 5 ft away.
  const none = await potentSpellcastingFixture(t, {targetChoice: {from: "creatures", range: 1}});
  assert.equal(none.record.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(none.asked.length, 0);
  assert.equal((none.record.state.results.reactions ?? []).some(entry => entry.childFailed), true, "it fails");
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
    paths({from: "creatures", range: 60}), paths({from: "self"})],
    [["targetChoice.from"], ["targetChoice.range"], ["targetChoice.range"], [], []]);
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
 */
async function afterCastFixture(t, {tags=["spell", "school:enchantment"], slot=true, slots=1, trigger, choose=null,
  policy="always", pools=[], prepare=null, definition=null, actions=[], playerTotal=10, logger=undefined}={}) {
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
  const gmRollRequests = [];
  const asked = [];
  // Its Token, by uuid, as Foundry's fromUuid finds it.
  const tokenOf = async uuid => scene.tokens.find(token => token.uuid === uuid) ?? null;
  const gmProvider = createTestRollProvider({result: {natural: 10, total: 15}});
  let automation = null;
  const gm = createMultiplayerActionCoordinator({userId: "gm-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}),
    rollProviders: [{...gmProvider, execute: request => { gmRollRequests.push(request); return gmProvider.execute(request); }}],
    afterCompleted: async event => {
      completed.push(event);
      await reportActionCompleted(event, {automation, fromUuid: tokenOf});
    },
    actionIntentResolver: ({intent, envelope}) => foundryActionIntentToStagedOptions({intent, senderUserId: envelope.senderUserId,
      game, persistencePort})});
  automation = createFoundryAutomationDispatcher({game, coordinator: gm, fromUuid: globalThis.fromUuid, logger,
    resolveAction: options => foundryActionIntentToStagedOptions({...options, game, persistencePort})});
  const player = createMultiplayerActionCoordinator({userId: "player-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "player-a"}), rollProviders: [createTestRollProvider({result: {natural: playerTotal, total: playerTotal}})],
    promptPorts: [createTestPromptAdapter({id: "after-cast-choice", queue: Array.from({length: 4}, () => request => {
      asked.push(request);
      // Its "you can" (an Action's configuration), as offered; then the creature it picks.
      if ( request.type === "action-configuration" ) return {choices: Object.fromEntries(request.payload.requests
        .map(entry => [entry.id, entry.defaultValue]))};
      return {choices: {[request.payload.id]: choose ?? request.payload.defaultValue}};
    })})]});
  gm.register();
  player.register();
  // The scene as it stands when the spell is cast (a creature dead, Unaffected).
  prepare?.({...fixture, ...creatures});
  const declared = await player.declareActionIntent(fixture.intent);
  return {...fixture, ...creatures, declared, record: gm.getRecord(declared.resolutionId), completed, asked, gmRollRequests, automation, tokenOf};
}

/** A Beguiling Magic-shaped Trigger: after an Enchantment or Illusion spell cast with a slot, a save by a creature picked within 60 ft. */
const AFTER_CAST_SAVE = Object.freeze({kind: "automation", event: "action.completed",
  match: {tagsAll: ["cast", "slot"], tagsAny: ["school:enchantment", "school:illusion"]},
  action: {schemaVersion: 1, id: "action:after-cast", label: "After Cast", costs: {allOf: []}, range: {type: "ranged", normal: {value: 60, unit: "ft"}},
    targeting: {type: "single", required: true, count: 1}, targetChoice: {from: "creatures", range: 60},
    save: {ability: "presence", dc: {value: 30}},
    damage: [{id: "rider", expression: {type: "constant", value: 5}, damageType: "psychic", provenance: "feature-base",
      saveOutcomePolicy: {success: "none", failure: "full"}}]}});

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
});

test("reportActionCompleted: a completed move (no ActionDefinition) dispatches nothing", async () => {
  const dispatched = [];
  const automation = {dispatch: (...args) => { dispatched.push(args); return []; }};
  assert.deepEqual(await reportActionCompleted({resolutionId: "move:1", options: {actor: {id: "a", uuid: "Actor.a"}},
    state: {id: "move:1", source: {tokenRef: "Scene.s.Token.t"}}}, {automation, fromUuid: async () => null}), []);
  await reportActionCompleted({resolutionId: "use:1", options: {actor: {id: "a", uuid: "Actor.a"}},
    state: {id: "use:1", actionDefinition: {id: "action:strike", tags: ["weapon"]}, source: {}}}, {automation, fromUuid: async () => null});
  assert.equal(dispatched.length, 1, "an Action still reports");
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

test("useAction: a drawing Action a Trigger runs uses its Action too; one targeting itself runs on its creature; an area one is the GM's", async t => {
  // After its cast, a Trigger draws a ray at the spell's target (no user's own Action): the ray still runs.
  const trigger = {kind: "automation", event: "action.completed", match: {tagsAll: ["cast"]},
    action: {...drawsRays(), id: "action:surge", costs: {allOf: []}, targetChoice: {from: "trigger-target"}}};
  const surged = await afterCastFixture(t, {trigger, actions: structuredClone(RAYS), playerTotal: 3});
  assert.equal(surged.record.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.deepEqual(surged.completed.map(event => [event.state.actionDefinition.id, event.used]),
    [["action:charm", true], ["action:surge", false], ["action:bolt", false]]);
  assert.equal(surged.targetActor.system.resources.health.value, 24, "the spell's 1, then the drawn Bolt's 5");

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
  // An ally's, beside the players' monster offer: asked under the same label.
  targetActor.items = [];
  const cleric = withFoundryActorSystem(fakeActor("cleric", {system: {...targetActorSystem(), pools: [{id: "channel-divinity", value: 2, max: 2}]}}));
  cleric.items = [guided];
  scene.tokens.push(fakeTokenDocument({id: "cleric-token", actor: cleric, scene, offset: {i: 1, j: 3}, disposition: targetToken.disposition}));
  const monster = {own: false, chooser: "gm", label: "monster", options: []};
  assert.deepEqual(["attack", "save"].map(test => offered(test, monster).options[0].offerLabel), [own("OwnTest"), own("OwnSave")]);
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
