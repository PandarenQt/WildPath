import {test} from "node:test";
import assert from "node:assert/strict";
import {createReactionTrigger} from "../module/helpers/automation-events.mjs";
import {validateResolutionStateSerializable} from "../module/helpers/resolution-state.mjs";
import {createResolutionSocketEnvelope, MULTIPLAYER_MESSAGE_TYPES as MESSAGE} from "../module/helpers/multiplayer-authority.mjs";
import {createTestDocumentPersistenceAdapter} from "../module/adapters/test-persistence-adapter.mjs";
import {createTestResolutionTransportHub} from "../module/adapters/test-resolution-transport.mjs";
import {createTestPromptAdapter} from "../module/adapters/test-prompt-adapter.mjs";
import {createTestRollProvider} from "../module/resolvers/roll-provider-resolver.mjs";
import {createMultiplayerActionCoordinator} from "../module/resolvers/multiplayer-action-coordinator.mjs";
import {foundryMovementIntentToStagedOptions} from "../module/adapters/foundry-v14-staged-movement-adapter.mjs";
import {createMovementResolutionHost} from "../module/resolvers/movement-pipeline-resolver.mjs";
import {createTokenGridFootprint} from "../module/helpers/grid-footprints.mjs";
import {executeRollRequest} from "../module/resolvers/roll-provider-resolver.mjs";
import {movementTransitionRelations} from "../module/helpers/movement-transition.mjs";
import {isStagedMovementWrite, stagedMovementPersistence} from "../module/adapters/foundry-v14-staged-movement-commit.mjs";
import {createFoundryV14DocumentPersistenceAdapter} from "../module/adapters/foundry-v14-persistence-adapter.mjs";
import {onFoundryV14MoveToken} from "../module/resolvers/foundry-multiplayer-runtime.mjs";

const users = [{id: "gm", isGM: true, active: true}, {id: "mover-user", active: true}, {id: "reactor-user", active: true}];
function actor(id, owner) {
  return {id, uuid: `Actor.${id}`, effects: [], system: {traits: {size: "medium"}, defenses: {ac: {value: 12}},
    resources: {movement: {value: 30, max: 30}, reaction: {value: 1, max: 1}, health: {value: 20, max: 20}}, pools: []},
  toObject() {return {system: structuredClone(this.system)};},
  getStatistic(domain) {return domain.startsWith("attack") ? {totalModifier: 4, trace: {domain}} : null;},
  testUserPermission(user) {return user.isGM || user.id === owner;}};
}
function squareGrid() {
  return {type: 1, isSquare: true, isHexagonal: false, isGridless: false, distance: 5, units: "ft", size: 50, sizeX: 50, sizeY: 50,
    getOffset(p) {return {i: Math.floor(p.x / 50), j: Math.floor(p.y / 50)};},
    getCenterPoint(p) {return {x: (p.i + 0.5) * 50, y: (p.j + 0.5) * 50};},
    getVertices(p) {return [{x: p.i*50,y:p.j*50},{x:(p.i+1)*50,y:p.j*50},{x:(p.i+1)*50,y:(p.j+1)*50},{x:p.i*50,y:(p.j+1)*50}];}};
}
function token(id, actor, scene, x, y, size="medium") {
  const width = size === "large" ? 2 : 1;
  const result = {id, uuid: `Scene.${scene.id}.Token.${id}`, documentName: "Token", parent: scene, actor,
    x, y, width, height: width, depth: 1, elevation: 0, shape: 0, disposition: 1,
    toObject() {return Object.fromEntries(["x", "y", "width", "height", "depth", "elevation", "shape"].map(key => [key,this[key]]));},
    getOccupiedGridSpaceOffsets(data) {
      const p = data ?? this, base = scene.grid.getOffset(p);
      return Array.from({length: p.width * p.height}, (_,i) => ({i: base.i+i%p.width,j: base.j+Math.floor(i/p.width)}));
    },
    getCompleteMovementPath(points) {return points;},
    testUserPermission(user) {return actor.testUserPermission(user);}};
  actor.system.traits.size = size;
  scene.tokens.set(id, result);
  return result;
}
function reactionDefinition({stop=false}={}) {
  return {schemaVersion: 1, id: "reaction:leave", label: "Movement reaction",
    costs: {allOf: [{capability: "reaction", amount: 1}]}, targeting: {type: "single", required: true, count: 1},
    range: {type: "reach", distance: {value: 5, unit: "ft"}},
    attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
    damage: [{id: "weapon", expression: {type: "constant", value: 6}, damageType: "slashing", provenance: "weapon-base"}],
    ...(stop ? {effects: [{id: "test-stop", type: "condition", conditionId: "prone", metadata: {testMovementStop: true}}]} : {})};
}
function fixture({reaction=true, decision="decline", roll=10, stop=false, auto=true, size="medium", failOn=null, fields=false, count=1, hex=false}={}) {
  const mover = actor("mover", "mover-user"), reactors = Array.from({length: count}, (_,i) => actor(`reactor${i}`, "reactor-user"));
  const scene = {id: "scene", uuid: "Scene.scene", grid: squareGrid(), tokens: new Map(),
    dimensions: {sceneX: 0, sceneY: 0, sceneWidth: 1000, sceneHeight: 1000, columns: 20, rows: 20}};
  const movingToken = token("mover-token", mover, scene, 0, 50, size);
  if (hex) {
    Object.assign(scene.grid, {type: 2, isSquare: false, isHexagonal: true, columns: false, even: false,
      offsetToCube: p => ({q:p.i,r:p.j,s:-p.i-p.j}), cubeToOffset: p => ({i:p.q,j:p.r})});
    movingToken.getOccupiedGridSpaceOffsets = function(data) {
      const p = data ?? this, base = scene.grid.getOffset(p);
      return size === "large" ? [base, {i:base.i+1,j:base.j}, {i:base.i,j:base.j+1}] : [base];
    };
  }
  const reactorTokens = reactors.map((a,i) => token(`reactor-token${i}`, a, scene, 0, 0));
  const gameUsers = new Map(users.map(u => [u.id, {...u}])); gameUsers.activeGM = gameUsers.get("gm");
  const definition = reactionDefinition({stop});
  const game = {user: gameUsers.get("gm"), users: gameUsers, scenes: new Map([[scene.id, scene]]),
    settings: {get() {return fields ? "fields" : "distance";}}, wildpath: {reactionServices: () => ({
      movement: {observers: reactorTokens.map((token,i) => ({id: `observer${i}`, token, reachFields: 1, context: {hostile: true}})),
        validate: () => stop && mover.effects.some(e => e.flags?.wildpath?.conditionEffect?.metadata?.testMovementStop)
          ? {decision: "stop", reason: "Test effect prevents remaining traversal."} : {decision: "continue"}},
      reactions: {triggers: reaction ? reactors.map((a,i) => createReactionTrigger({id: `leave${i}`,
        event: "movement.transition-proposed", match: {phase: "interrupt"}, actorId: a.id, tokenId: reactorTokens[i].id,
        action: definition, actionId: definition.id,
        predicate: {all: [{equals: {path: "event.data.movementKind", value: "voluntary"}},
          {equals: {path: `event.data.relations.observer${i}.leavesReach`, value: true}},
          {equals: {path: `event.data.relations.observer${i}.context.hostile`, value: true}}]}})) : []}
    })}};
  const persistence = createTestDocumentPersistenceAdapter({actors: [mover, ...reactors], failOn});
  const hub = createTestResolutionTransportHub({users});
  const transports = Object.fromEntries(users.map(user => [user.id, hub.createEndpoint({userId: user.id})]));
  const gm = createMultiplayerActionCoordinator({userId: "gm", users, activeGMUserId: "gm", transport: transports.gm,
    actionIntentResolver: ({intent, envelope}) => foundryMovementIntentToStagedOptions({intent,
      resolutionId: envelope.resolutionId, senderUserId: envelope.senderUserId, game, persistencePort: persistence})});
  const player = createMultiplayerActionCoordinator({userId: "mover-user", users, activeGMUserId: "gm", transport: transports["mover-user"]});
  const reactorClient = createMultiplayerActionCoordinator({userId: "reactor-user", users, activeGMUserId: "gm", transport: transports["reactor-user"],
    promptPorts: [createTestPromptAdapter({queue: Array.from({length: count}, () => request => ({decision,
      ...(decision === "use" ? {candidateId: request.payload.candidates[0].id} : {})}))})],
    rollProviders: [createTestRollProvider({result: {total: roll + 4, natural: roll}})]});
  gm.register(); player.register(); if (auto) reactorClient.register();
  const intent = {resolutionKind: "movement", resolutionId: "resolution:movement", intentId: "intent:movement", movementId: "movement",
    sceneRef: scene.uuid, tokenRef: movingToken.uuid, origin: movingToken.toObject(true),
    waypoints: [50,100,150].map(x => ({...movingToken.toObject(true),x})), movementKind: "voluntary", movementMode: "walk"};
  return {mover, reactors, movingToken, reactorTokens, game, persistence, gm, player, reactorClient, hub, transports, intent,
    start: async () => {await player.declareActionIntent(intent);
      assert.ok(gm.getRecord(intent.resolutionId), JSON.stringify(hub.messages.at(-1)?.payload));},
    record: () => gm.getRecord(intent.resolutionId)};
}
const diagnostic = state => JSON.stringify({status: state?.status, errors: state?.errors,
  pending: state?.pendingRequests?.map(r => ({id:r.id,type:r.type})),
  child: state?.metadata?.activeChildResolution ? JSON.parse(diagnostic(state.metadata.activeChildResolution)) : null}, null, 2);

for (const size of ["medium", "large"]) test(`ordered ${size} square movement commits once without reactions`, async () => {
  const f = fixture({reaction: false, size}); await f.start();
  const state = f.record()?.state;
  assert.equal(state?.status, "completed", diagnostic(state));
  assert.equal(state.results.movement.completedTransitionCount, 3);
  assert.equal(state.input.movement.evaluation.footprints[0].fields.length, size === "large" ? 4 : 1);
  assert.equal(f.movingToken.x, 150);
  assert.equal(f.mover.system.resources.movement.value, 15);
  assert.equal(f.persistence.operations.filter(o => o.type === "updateDocument").length, 1);
  assert.equal(validateResolutionStateSerializable(state).ok, true);
  const result = f.hub.messages.find(m => m.messageType === MESSAGE.RESOLUTION_RESULT);
  assert.equal(result.payload.result.outcomes.movement.committed, true);
});

test("declining a leave-reach window keeps ordered movement and consumes no reaction", async () => {
  const f = fixture(); await f.start();
  assert.equal(f.record()?.state.status, "completed", diagnostic(f.record()?.state));
  assert.equal(f.hub.messages.filter(m => m.messageType === MESSAGE.PENDING_REQUEST).length, 1);
  assert.equal(f.reactors[0].system.resources.reaction.value, 1);
  assert.equal(f.mover.system.resources.movement.value, 15);
});

for (const [name,roll,hp] of [["miss",2,20],["hit",10,14]]) test(`nested reaction ${name} uses logical footprint and normal action commit`, async () => {
  const f = fixture({decision: "use", roll}); await f.start();
  const state = f.record()?.state;
  assert.equal(state?.status, "completed", diagnostic(state) + JSON.stringify(f.hub.messages.map(m => ({type:m.messageType,to:m.recipientUserId,code:m.payload.code,reason:m.payload.reason}))));
  assert.equal(f.mover.system.resources.health.value, hp);
  assert.equal(f.mover.system.resources.movement.value, 15);
  assert.equal(f.reactors[0].system.resources.reaction.value, 0);
  const requests = f.hub.messages.filter(m => m.messageType === MESSAGE.PENDING_REQUEST);
  assert.deepEqual(requests.map(m => m.recipientUserId), ["reactor-user","reactor-user"]);
  assert.notEqual(requests[1].resolutionId, state.id);
});

test("child effect stops the suffix and charges only the completed prefix", async () => {
  const f = fixture({decision: "use", stop: true}); await f.start();
  const state = f.record()?.state;
  assert.equal(state?.status, "completed", diagnostic(state));
  assert.equal(state.results.movement.stopped, true);
  assert.equal(state.results.movement.completedTransitionCount, 1);
  assert.equal(f.movingToken.x, 50);
  assert.equal(f.mover.system.resources.movement.value, 25);
  assert.equal(f.reactors[0].system.resources.reaction.value, 0);
});

test("Large hex traversal retains its three-field footprint and field measurement", async () => {
  const f = fixture({reaction:false, size:"large", hex:true, fields:true}); await f.start();
  const state = f.record().state;
  assert.equal(state.status, "completed", diagnostic(state));
  assert.equal(state.input.movement.evaluation.footprints[0].fields.length, 3);
  assert.equal(state.results.movement.cumulativeCost, 3);
  assert.equal(f.mover.system.resources.movement.value, 15);
});

test("entering reach does not trigger the configured leave rule", async () => {
  const f = fixture(); f.movingToken.x = 150; f.intent.origin = f.movingToken.toObject(true);
  f.intent.waypoints = [100,50,0].map(x => ({...f.intent.origin,x}));
  await f.start();
  assert.equal(f.record().state.status, "completed", diagnostic(f.record().state));
  assert.equal(f.hub.messages.filter(m => m.messageType === MESSAGE.PENDING_REQUEST).length, 0);
});

test("a reactor without payable reaction has no executable candidate", async () => {
  const f = fixture(); f.reactors[0].system.resources.reaction.value = 0; await f.start();
  assert.equal(f.record().state.status, "completed");
  assert.equal(f.hub.messages.filter(m => m.messageType === MESSAGE.PENDING_REQUEST).length, 0);
});

test("two reactors use the existing ordered groups and each pays once", async () => {
  const f = fixture({decision:"use", count:2}); await f.start();
  assert.equal(f.record().state.status, "completed", diagnostic(f.record().state));
  assert.deepEqual(f.reactors.map(a => a.system.resources.reaction.value), [0,0]);
  assert.equal(f.mover.system.resources.health.value, 8);
  assert.equal(f.mover.system.resources.movement.value, 15);
  assert.equal(f.hub.messages.filter(m => m.messageType === MESSAGE.PENDING_REQUEST).length, 4);
});

function response(request, value, senderUserId="reactor-user") {
  return createResolutionSocketEnvelope({messageType: MESSAGE.REQUEST_RESPONSE, senderUserId, recipientUserId:"gm",
    resolutionId:request.resolutionId, requestId:request.requestId,
    payload:{response:{resolutionId:request.resolutionId, requestId:request.requestId, type:request.payload.request.type,value}}});
}
const pending = f => f.hub.messages.filter(m => m.messageType === MESSAGE.PENDING_REQUEST).at(-1);
test("wrong, duplicate and stale choice/roll responses cannot execute or spend twice", async () => {
  const f = fixture({auto:false}); await f.start();
  const choice = pending(f), value = {decision:"use",candidateId:choice.payload.request.payload.candidates[0].id};
  assert.equal(f.record().state.results.movement.completedTransitionCount, 1);
  assert.equal(f.record().state.results.proposedMovement.data.transitionIndex, 1);
  assert.equal(f.movingToken.x, 0); assert.equal(f.persistence.operations.length, 0);
  assert.equal((await f.gm.handleEnvelope(response(choice,value,"mover-user"))).code,"WRONG_USER");
  const accepted = response(choice,value); await f.gm.handleEnvelope(accepted);
  const rollRequest = pending(f);
  assert.equal(rollRequest.recipientUserId,"reactor-user");
  assert.notEqual(rollRequest.resolutionId, f.intent.resolutionId);
  const child = f.record().state.metadata.activeChildResolution;
  assert.equal(child.input.context.spatial.targetFootprints[0].footprint.anchor.x, 1);
  assert.equal(validateResolutionStateSerializable(child).ok,true);
  const rolled = await executeRollRequest({request:rollRequest.payload.request.payload.rollRequest,
    providers:[createTestRollProvider({total:14,natural:10})]});
  assert.equal(rolled.ok,true);
  const rollValue = rolled.result;
  assert.equal((await f.gm.handleEnvelope(response(rollRequest,rollValue,"mover-user"))).code,"WRONG_USER");
  const stale = response(rollRequest,rollValue);
  stale.requestId = "stale-request"; stale.payload.response.requestId = "stale-request";
  assert.equal((await f.gm.handleEnvelope(stale)).ok,false);
  await f.gm.handleEnvelope(response(rollRequest,rollValue));
  assert.equal(f.record().state.status,"completed",diagnostic(f.record().state));
  const operations = f.persistence.operations.length;
  assert.equal((await f.gm.handleEnvelope({...accepted,messageId:"duplicate-choice"})).code,"DUPLICATE_REQUEST_RESPONSE");
  assert.equal((await f.gm.handleEnvelope(response(rollRequest,rollValue))).code,"DUPLICATE_REQUEST_RESPONSE");
  await f.player.declareActionIntent(f.intent);
  assert.equal(f.persistence.operations.length,operations);
  assert.equal(f.reactors[0].system.resources.reaction.value,0);
  assert.equal(f.mover.system.resources.movement.value,15);
});

test("source position changing during a pending window invalidates the stale route", async () => {
  const f = fixture({auto:false}); await f.start(); f.movingToken.x = 250;
  await f.gm.handleEnvelope(response(pending(f),{decision:"decline"}));
  assert.equal(f.record().state.status,"failed");
  assert.equal(f.persistence.operations.length,0);
  assert.equal(f.movingToken.x,250);
});

test("current movement resource is revalidated after the reaction window", async () => {
  const f = fixture({auto:false}); await f.start(); f.mover.system.resources.movement.value = 5;
  await f.gm.handleEnvelope(response(pending(f),{decision:"decline"}));
  assert.equal(f.record().state.status,"completed",diagnostic(f.record().state));
  assert.equal(f.movingToken.x,50);
  assert.equal(f.mover.system.resources.movement.value,0);
});

test("movement payment failure rolls back the final position", async () => {
  const f = fixture({reaction:false,failOn:o => o.type === "updateActor"}); await f.start();
  assert.equal(f.record().state.status,"failed");
  assert.equal(f.record().state.results.transaction.rolledBack,true);
  assert.equal(f.movingToken.x,0);
  assert.equal(f.mover.system.resources.movement.value,30);
  assert.deepEqual(f.persistence.operations.map(o => o.type),["updateDocument","updateActor","updateDocument"]);
});

test("position failure leaves movement resources untouched", async () => {
  const f = fixture({reaction:false,failOn:o => o.type === "updateDocument"}); await f.start();
  assert.equal(f.record().state.status,"failed");
  assert.equal(f.mover.system.resources.movement.value,30);
  assert.equal(f.movingToken.x,0);
  assert.equal(f.persistence.operations.length,1);
});

test("a movement intent requires ownership even when sourceUserId is forged", async () => {
  const f = fixture();
  await assert.rejects(foundryMovementIntentToStagedOptions({intent:{...f.intent,sourceUserId:"mover-user"},
    resolutionId:"unowned",senderUserId:"reactor-user",game:f.game,persistencePort:f.persistence}),/own/);
  assert.equal(f.persistence.operations.length,0);
});

test("a staged write bypass requires a locally registered exact document and position", async () => {
  const f = fixture(); const op = {wildpathStagedMovement:"forged"};
  assert.equal(isStagedMovementWrite(f.movingToken,op,{x:50,y:50}),false);
  let checked = false;
  const base = {...f.persistence,updateDocument: async input => {
    checked = true;
    assert.equal(isStagedMovementWrite(f.movingToken,input.operation,input.updates),true);
    assert.equal(isStagedMovementWrite(f.movingToken,input.operation,{x:999,y:50}),false);
    return f.persistence.updateDocument(input);
  }};
  const port = stagedMovementPersistence(base,f.movingToken,"test",() => true);
  await port.updateDocument({document:f.movingToken,updates:{x:50,y:50}});
  assert.equal(checked,true); assert.equal(isStagedMovementWrite(f.movingToken,op),false);
  await assert.rejects(stagedMovementPersistence(base,f.movingToken,"test",() => false)
    .updateDocument({document:f.movingToken,updates:{x:100,y:50}}),/authority/);
});

test("configured pool payment and custom step costs use the shared resource resolver", async () => {
  const f = fixture({reaction:false}); f.mover.system.pools.push({id:"stamina",value:10,max:10,label:"Stamina"});
  const base = f.game.wildpath.reactionServices;
  f.game.wildpath.reactionServices = context => {const services = base(context); return {...services,
    movement:{...services.movement,payment:{capability:"stamina",unit:"points",scale:1},
      evaluationOptions:{measurementMode:"fields",stepCostPolicy:() => 2}}};};
  await f.start();
  assert.equal(f.record().state.status,"completed",diagnostic(f.record().state));
  assert.equal(f.mover.system.pools[0].value,4);
  assert.equal(f.mover.system.resources.movement.value,30);
});

test("pure movement host rejects nonauthority commit and coalesces concurrent commit attempts", async () => {
  const mover = actor("test","mover-user"), document = {x:0,y:0};
  const persistence = createTestDocumentPersistenceAdapter();
  const host = createMovementResolutionHost({id:"pure-move",source:{actorRef:mover.uuid},
    path:{anchors:[{q:0,r:0},{q:1,r:0},{q:2,r:0}],topology:"hex",size:"large"},
    evaluationOptions:{measurementMode:"distance",grid:{distance:5,units:"ft"}},
    payment:{capability:"movement",unit:"movement",scale:1}},
  {actor:mover,document,documentRef:"Token.test",persistencePort:persistence,originalPosition:{x:0,y:0},
    readActorSystem:() => mover.system,positionUpdates:footprint => ({x:footprint.anchor.q,y:footprint.anchor.r}),
    validate:() => ({decision:"continue"})});
  const planned = host.plan({state:JSON.parse(JSON.stringify(host.state))});
  assert.equal(planned.state.status,"ready-to-commit"); assert.equal(persistence.operations.length,0);
  assert.equal((await host.execute({state:planned.state,authority:{canCommit:false}})).ok,false);
  const attempts = await Promise.all([1,2].map(() => host.execute({state:planned.state,authority:{canCommit:true}})));
  assert.equal(attempts.every(r => r.ok),true);
  assert.equal(persistence.operations.length,2); assert.equal(mover.system.resources.movement.value,20);
  assert.equal((await host.execute({state:attempts[0].state,authority:{canCommit:true}})).duplicate,true);
});

test("observer facts retain Large occupied fields and reject conflicting identities", () => {
  const from = createTokenGridFootprint({anchor:{x:0,y:0},size:"large",topology:"square"});
  const to = createTokenGridFootprint({anchor:{x:1,y:0},size:"large",topology:"square"});
  const observer = {id:"watcher",reachFields:1,footprint:createTokenGridFootprint({anchor:{x:2,y:1},size:"medium",topology:"square"})};
  const facts = movementTransitionRelations(from,to,[observer]).watcher;
  assert.equal(facts.before,1); assert.equal(facts.after,0); assert.equal(facts.leavesReach,false);
  assert.throws(() => movementTransitionRelations(from,to,[observer,observer]),/unique/);
});

test("distinct synthetic Actors sharing a base ID retain independent payment and damage", async () => {
  const f = fixture({decision:"use"});
  f.reactors[0].id = f.mover.id;
  f.reactors[0].uuid = `Scene.scene.Token.reactor-token0.Actor.${f.mover.id}`;
  const provider = f.game.wildpath.reactionServices;
  f.game.wildpath.reactionServices = context => {
    const services = provider(context);
    services.reactions.triggers[0].reaction.actorId = f.reactors[0].uuid;
    return services;
  };
  await f.start();
  assert.equal(f.record().state.status,"completed",diagnostic(f.record().state));
  assert.equal(f.mover.system.resources.health.value,14,JSON.stringify(f.record().state.results.reactions));
  assert.equal(f.mover.system.resources.reaction.value,1);
  assert.equal(f.reactors[0].system.resources.health.value,20);
  assert.equal(f.reactors[0].system.resources.reaction.value,0);
  assert.equal(f.hub.messages.filter(m => m.messageType === MESSAGE.PENDING_REQUEST).every(m => m.recipientUserId === "reactor-user"),true);
});

test("partial Foundry position application is restored before reporting failure", async () => {
  const f = fixture(); let attempts = 0;
  const base = {...f.persistence,updateDocument:async input => {
    attempts++;
    if (attempts === 1) {f.movingToken.x = input.updates.x; return {ok:true};}
    return f.persistence.updateDocument(input);
  }};
  const port = stagedMovementPersistence(base,f.movingToken,"partial",() => true);
  await assert.rejects(port.updateDocument({document:f.movingToken,updates:{x:100,y:100}}),/did not persist/);
  assert.equal(f.movingToken.x,0); assert.equal(f.movingToken.y,50);
  assert.equal(attempts,2);
});

test("resources changing during the position write fail payment and restore position", async () => {
  const f = fixture({reaction:false}); const write = f.persistence.updateDocument;
  f.persistence.updateDocument = async input => {
    const result = await write(input);
    if (!input.metadata?.rollback) f.mover.system.resources.movement.value = 25;
    return result;
  };
  await f.start();
  assert.equal(f.record().state.status,"failed");
  assert.equal(f.record().state.results.transaction.rolledBack,true);
  assert.equal(f.movingToken.x,0);
  assert.equal(f.mover.system.resources.movement.value,25);
});

for (const change of ["grid","deletion","ownership"]) test(`${change} changes during a pending reaction invalidate the route`, async () => {
  const f = fixture({auto:false}); await f.start();
  if (change === "grid") f.movingToken.parent.grid.distance = 10;
  if (change === "deletion") f.movingToken.parent.tokens.delete(f.movingToken.id);
  if (change === "ownership") f.movingToken.testUserPermission = () => false;
  await f.gm.handleEnvelope(response(pending(f),{decision:"decline"}));
  assert.equal(f.record().state.status,"failed");
  assert.equal(f.persistence.operations.length,0);
});

test("another intent cannot replace a pending movement with the same resolution ID", async () => {
  const f = fixture({auto:false}); await f.start();
  const record = f.record();
  await f.player.declareActionIntent({...f.intent,intentId:"replacement-intent"});
  assert.equal(f.record(),record);
  assert.equal(f.hub.messages.at(-1).payload.code,"ACTION_INTENT_REJECTED");
  assert.equal(f.persistence.operations.length,0);
});

test("registered final position uses Foundry persistence and skips duplicate native approval/observation", async () => {
  const originals = {TokenDocument:globalThis.TokenDocument,game:globalThis.game};
  try {
    globalThis.TokenDocument = class {
      async _preUpdate(changes,operation) {return this._preUpdateMovement({destination:changes},operation);}
      async _preUpdateMovement() {}
    };
    const {default:TokenClass} = await import("../module/documents/token.mjs?staged-movement-test");
    const f = fixture(); globalThis.game = f.game;
    let approvals = 0, observations = 0;
    f.game.wildpath.movement = {prepareReactionCheckpoints:true,requestMovementApproval:() => {approvals++; throw new Error("Unexpected native approval");}};
    Object.setPrototypeOf(f.movingToken,TokenClass.prototype);
    f.movingToken.update = async function(changes,operation) {
      assert.equal(operation.movement[this.id].waypoints[0].action,"displace");
      assert.notEqual(await this._preUpdate(changes,operation,f.game.user),false);
      Object.assign(this,changes);
      const result = await onFoundryV14MoveToken(this,{id:"rendered"},operation,f.game.user,{game:f.game});
      if (!result.ignored) observations++;
      return this;
    };
    await stagedMovementPersistence(createFoundryV14DocumentPersistenceAdapter(),f.movingToken,"registered",() => true)
      .updateDocument({document:f.movingToken,updates:{x:100,y:50}});
    assert.equal(f.movingToken.x,100); assert.equal(approvals,0); assert.equal(observations,0);
  } finally {
    for (const [key,value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});

for (const failurePolicy of ["continue","cancel-parent"]) test(`failed child cleans up through the existing ${failurePolicy} policy`, async () => {
  const f = fixture({decision:"use",failOn:operation => operation.type === "updateActor"
    && operation.updates["system.resources.reaction.value"] === 0});
  const provider = f.game.wildpath.reactionServices;
  f.game.wildpath.reactionServices = context => {
    const services = provider(context); services.reactions.failurePolicy = failurePolicy; return services;
  };
  await f.start();
  const state = f.record().state;
  assert.equal(state.status,"completed",diagnostic(state));
  assert.equal(state.metadata.activeChildResolution ?? null,null);
  assert.equal(state.results.reactions[0].childFailed,true);
  assert.equal(state.results.reactions[0].childOutcome.transaction.rolledBack,true);
  assert.equal(f.mover.system.resources.health.value,20);
  assert.equal(f.reactors[0].system.resources.reaction.value,1);
  assert.equal(f.movingToken.x,failurePolicy === "continue" ? 150 : 50);
  assert.equal(f.mover.system.resources.movement.value,failurePolicy === "continue" ? 15 : 25);
});
