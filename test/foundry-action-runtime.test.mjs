import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {ECONOMY_CAPABILITIES} from "../module/helpers/action-economy.mjs";
import {CREATURE_SIZES} from "../module/helpers/grid-footprints.mjs";
import {RESOLUTION_STATE_STATUS, validateResolutionStateSerializable} from "../module/helpers/resolution-state.mjs";
import {createActionResolutionState, planStagedActionResolution, resumeStagedActionResolution} from "../module/resolvers/action-pipeline-resolver.mjs";
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
import {areaCovers, areaExpired, createFoundryPersistentAreas} from "../module/adapters/foundry-v14-persistent-areas.mjs";
import {createFoundryAutomationDispatcher} from "../module/adapters/foundry-v14-automation-dispatcher.mjs";
import {inspectResolution} from "../module/helpers/resolution-inspection.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {damageProfileFromRuleElements, rollModesFromRuleElements, rollOutcomesFromRuleElements} from "../module/helpers/rule-elements.mjs";
import {WILDPATH} from "../module/config.mjs";
import {rollFormulaForRequest} from "../module/helpers/rolls.mjs";
import {
  buildFoundryActionUseIntent,
  conditionsFrom,
  foundryActionIntentToStagedOptions,
  foundryActionOdds
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
  allies=[], prepareTarget=null, prepareSource=null, extraActors=[], saveRoll=null, sunlit=false}={}) {
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
  scene.tokens = [sourceToken, targetToken, ...allyTokens, ...extraTokens];
  const action = actionItem(definition, sourceActor);
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

test("two unlinked Tokens of one base Actor each make their own save", async t => {
  const definition = {...fortitudeBlast("agility"), targeting: {type: "multiple", required: true, count: 2}};
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
});

/** A GM-controlled target whose Token answers "a hit on me" by striking back (authored Trigger RuleElement). */
function counterattackFixture(t, {decision="use", reactor="target", event="attack.hit", natural=null, once=false, rider=null, extra=null,
  queue=null, pick=null, items=null, holderItems=null, gmQueue=null}={}) {
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
  const posts = [];
  // The GM rolls the counterattack; its requests are kept for their roll mode.
  const gmRollRequests = [];
  const playerRollRequests = [];
  const playerRolls = provider => ({...provider, execute: request => { playerRollRequests.push(request); return provider.execute(request); }});
  const gmProvider = createTestRollProvider({result: {natural: 15, total: 15}, ...(gmQueue ? {queue: gmQueue} : {})});
  const gmRolls = {...gmProvider, execute: request => { gmRollRequests.push(request); return gmProvider.execute(request); }};
  const gm = createMultiplayerActionCoordinator({userId: "gm-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}), publishResult: post => { posts.push(post); },
    promptPorts: [createTestPromptAdapter({id: "counterattack-choice", queue: [request => {
      offers.push(request);
      return decision === "use" ? {decision, candidateId: request.payload.candidates[0].id} : {decision};
    }]})],
    rollProviders: [gmRolls],
    actionIntentResolver: ({intent, envelope}) => foundryActionIntentToStagedOptions({intent,
      senderUserId: envelope.senderUserId, game, persistencePort})});
  const player = createMultiplayerActionCoordinator({userId: "player-a", users: () => hub.userDirectory(),
    activeGMUserId: "gm-a", transport: hub.createEndpoint({userId: "player-a"}),
    // Its own reactions: the first candidate, or the one `pick` names (a Brutal Strike's blow).
    ...(reactor === "source" ? {promptPorts: [createTestPromptAdapter({id: "smite-choice", queue: Array.from({length: 4}, () => request => {
      offers.push(request);
      const candidates = request.payload.candidates;
      return {decision: "use", candidateId: (candidates.find(candidate => pick && String(candidate.actionId ?? "").includes(pick)) ?? candidates[0]).id};
    })})]} : {}),
    // Its attack, then (its own reaction's) 2d8 or 4d8.
    rollProviders: [playerRolls(createTestRollProvider({queue: queue ?? (reactor === "source" ? [{natural: natural ?? 18, total: (natural ?? 18) + 4}, {total: 9}] : []),
      result: {natural: natural ?? 18, total: 22}}))]});
  gm.register();
  player.register();
  return {...fixture, gm, player, offers, holder, posts, gmRollRequests, playerRollRequests};
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
function areaFixture(t, {range=30, persistence=null, shape="radial", size=5, self=false}={}) {
  const definition = {schemaVersion: 1, id: "action:runtime-burst", label: "Runtime Burst",
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
  assert.deepEqual(reasons({triggers: [{on: ["turn.started"], action: {label: "no id"}}]}), ["area.persistence.triggers.0.action"]);
});

/** A burst whose ground keeps burning; the Scene can hold Regions and the GM runs the turn. */
function lastingAreaFixture(t, {shape="radial", range=60, rounds=10, concentration=false, on=["turn.started"], light=null,
  affects=null}={}) {
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
  const persistencePort = createTestDocumentPersistenceAdapter();
  const hub = createTestResolutionTransportHub({users: [
    {id: "gm-a", active: true, isGM: true, isActiveGM: true},
    {id: "player-a", active: true, isGM: false}
  ]});
  let areas = null;
  const gm = createMultiplayerActionCoordinator({userId: "gm-a", users: () => hub.userDirectory(), activeGMUserId: "gm-a",
    transport: hub.createEndpoint({userId: "gm-a"}), afterCompleted: event => areas.create(event),
    actionIntentResolver: ({intent: sent, envelope}) => foundryActionIntentToStagedOptions({intent: sent,
      senderUserId: envelope.senderUserId, game, persistencePort})});
  areas = createFoundryPersistentAreas({game, coordinator: gm,
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

test("an aura whose caster walks away exits the creatures it leaves behind", async t => {
  const {scene, sourceToken, targetToken, player, areas, intent} = lastingAreaFixture(t, {shape: "emanation", on: ["area.exited"]});
  await player.declareActionIntent({...intent, area: {points: []}});
  sourceToken.getOccupiedGridSpaceOffsets = position => [position ? scene.grid.getOffset(position) : {i: 0, j: 0}];
  const sweeps = areas.swept(sourceToken, {previous: {x: 0, y: 0}, position: {x: 500, y: 0}});
  assert.deepEqual(sweeps.map(({event, tokens}) => [event, tokens.map(token => token.id)]), [["area.exited", [targetToken.id]]]);
  assert.deepEqual(areas.swept(sourceToken, {previous: {x: 500, y: 0}, position: {x: 0, y: 0}}), [],
    "walking back covers the creature again, which an exit-only aura does not answer");
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

test("an automatic trigger's predicate sees its creature: Regeneration needs at least 1 Hit Point", async t => {
  const {targetActor, targetToken, automation} = lastingAreaFixture(t);
  targetActor.items = [triggerFeature("regeneration", {event: "turn.started",
    predicate: {not: {equals: {path: "actor.system.resources.health.value", value: 0}}}})];
  targetActor.system.resources.health.value = 0;
  assert.deepEqual(await automation.dispatch("turn.started", {actor: targetActor, token: targetToken}), [], "at 0 Hit Points");
  targetActor.system.resources.health.value = 10;
  assert.equal((await automation.dispatch("turn.started", {actor: targetActor, token: targetToken})).length, 1);
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

test("an expired area is gone before anyone starts a turn in it", async t => {
  const {scene, targetActor, targetToken, game, player, areas, intent} = lastingAreaFixture(t, {rounds: 1});
  await player.declareActionIntent({...intent, area: {points: [{x: 125, y: 25}]}});
  assert.equal(scene.regions.length, 1);
  game.combat.round = 2;
  await areas.onTurn("turn.started", {combatant: {token: targetToken}});
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
  assert.deepEqual(inspected.payments.map(payment => [payment.payer, payment.resource, payment.from, payment.to]), [
    ["source", "economy.action", 1, 0], ["controller", "economy.bonus-action", 1, 0], ["controller", "economy.movement", 30, 20]]);
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

test("a transformed creature can't cast spells, but its other Actions still resolve (2024 Wild Shape)", async t => {
  const spell = syntheticRuntimeFixture(t, {...meleeStrikeDefinition(), tags: ["spell"]});
  spell.sourceActor.transformation = {effect: {}, policy: {formRef: "Actor.bear"}};
  const refused = await foundryActionIntentToStagedOptions({intent: spell.intent, senderUserId: "player-a", game: spell.game});
  assert.equal(refused.code, MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED);
  assert.match(refused.reason, /can't cast spells/);
  spell.sourceActor.transformation = null;
  const caster = await foundryActionIntentToStagedOptions({intent: spell.intent, senderUserId: "player-a", game: spell.game});
  assert.equal(caster.ok, true, JSON.stringify(caster.reason));

  const strike = syntheticRuntimeFixture(t);
  strike.sourceActor.transformation = {effect: {}, policy: {formRef: "Actor.bear"}};
  const bite = await foundryActionIntentToStagedOptions({intent: strike.intent, senderUserId: "player-a", game: strike.game});
  assert.equal(bite.ok, true, JSON.stringify(bite.reason));
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
