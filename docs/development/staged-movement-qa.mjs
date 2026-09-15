// Development-only companion to staged-movement-qa.md; never loaded at system startup.
import {setupGM as setupActionGM, cleanupGM as cleanupActionGM, qaActionData, bounded} from "./action-runtime-live-qa.mjs";
import {createReactionTrigger} from "../../module/helpers/automation-events.mjs";
import {actionDefinitionFromAction} from "../../module/helpers/action-definitions.mjs";
import {createFoundryV14DocumentPersistenceAdapter} from "../../module/adapters/foundry-v14-persistence-adapter.mjs";
import {stagedMovementPersistence} from "../../module/adapters/foundry-v14-staged-movement-commit.mjs";

const FLAG = "stagedMovementQA";
const check = (value, reason) => {if (!value) throw new Error(reason);};
const clone = value => JSON.parse(JSON.stringify(value));
const runtime = () => game.wildpath.multiplayer;
const markedMover = () => [...canvas.scene.tokens].find(t => t.getFlag("wildpath", FLAG)?.role === "mover");
const positionKeys = ["x","y","elevation","width","height","depth","shape"];
const position = token => Object.fromEntries(positionKeys.map(key => [key,token.toObject(true)[key]]).filter(([,value]) => value !== undefined));
function snapshot(mover, reactor) {
  return {x:mover.x,y:mover.y,movement:mover.actor.system.resources.movement.value,
    hp:mover.actor.system.resources.health.value,reaction:reactor.actor.system.resources.reaction.value,
    effects:[...mover.actor.effects].map(e => ({id:e.id,metadata:e.flags?.wildpath?.conditionEffect?.metadata}))};
}

export async function setupGM(moverUserId, reactorUserId=game.user.id) {
  check(!globalThis.wpStagedMovementQA,"Detach the previous staged movement helper first.");
  const old = await setupActionGM(moverUserId);
  old.detach();
  const fixture = old.fixture, scene = game.scenes.get(fixture.sceneId);
  const mover = scene.tokens.get(fixture.sourceTokenId), reactor = scene.tokens.get(fixture.targetTokenId);
  const origin = position(mover), offset = canvas.grid.getOffset(origin);
  const reactorPosition = canvas.grid.getTopLeftPoint({i:offset.i-1,j:offset.j});
  const route = [1,2,3].map(n => canvas.grid.getTopLeftPoint({i:offset.i,j:offset.j+n}));
  // Foundry square offsets are row/column. Adapter verification below owns the actual geometry.
  check(game.users.get(reactorUserId)?.active && reactorUserId !== moverUserId,"Choose an active reactor controller different from the mover.");
  await game.actors.get(fixture.targetActorId).update({ownership:{default:0,[reactorUserId]:3}});
  const data = qaActionData(fixture.runId);
  data.system.definition.costs = {allOf:[{capability:"reaction",amount:1}]};
  data.system.definition.id = `action:qa-movement-reaction:${fixture.runId}`;
  const [action] = await reactor.actor.createEmbeddedDocuments("Item",[data]);
  const previous = game.wildpath.reactionServices;
  const qa = globalThis.wpStagedMovementQA = {fixture, mover, reactor, action, current:null, previous, passed:[], envelopes:[], history:[]};
  game.wildpath.reactionServices = context => {
    if (context.resolutionKind !== "movement" || context.intent?.tokenRef !== mover.uuid) return previous?.(context) ?? {};
    check(qa.current && context.intent.resolutionId === qa.current.resolutionId,"Prepare a case before submitting its movement intent.");
    const definition = actionDefinitionFromAction(action);
    check(definition.ok,"Persisted reaction ActionDefinition is invalid.");
    return {movement:{observers:[{id:"qaReactor",token:reactor,reachFields:1,context:{hostile:true}}],
      validate:() => [...mover.actor.effects].some(e => e.flags?.wildpath?.conditionEffect?.metadata?.stagedMovementRun === fixture.runId)
        ? {decision:"stop",reason:"QA effect prevents further movement."} : {decision:"continue"}},
    reactions:{triggers:qa.current.mode === "ordinary" ? [] : [createReactionTrigger({
      id:`qa-leave:${fixture.runId}`,event:"movement.transition-proposed",match:{phase:"interrupt"},
      actorId:reactor.actor.uuid,tokenId:reactor.id,action:definition.definition,actionId:definition.definition.id,
      predicate:{all:[{equals:{path:"event.data.movementKind",value:"voluntary"}},
        {equals:{path:"event.data.relations.qaReactor.leavesReach",value:true}},
        {equals:{path:"event.data.relations.qaReactor.context.hostile",value:true}}]}})]}};
  };
  qa.prepare = async mode => {
    check(["ordinary","decline","miss","hit","stop"].includes(mode),"Unknown QA case.");
    if (qa.current) check(qa.passed.includes(qa.current.resolutionId),"Prove and export the preceding case first.");
    const persistence = createFoundryV14DocumentPersistenceAdapter();
    for (const [token,point] of [[mover,origin],[reactor,reactorPosition]]) {
      await stagedMovementPersistence(persistence,token,`qa-reset:${fixture.runId}`,() => game.users.activeGM?.id === game.user.id)
        .updateDocument({document:token,updates:{x:point.x,y:point.y}});
    }
    const effects = [...mover.actor.effects].filter(e => e.flags?.wildpath?.conditionEffect?.metadata?.stagedMovementRun === fixture.runId);
    if (effects.length) await mover.actor.deleteEmbeddedDocuments("ActiveEffect",effects.map(e => e.id));
    await mover.actor.update({"system.resources.movement.base":30,"system.resources.movement.value":30,
      "system.resources.health.value":30,"system.defenses.ac.value":mode === "miss" ? 100 : 1});
    await reactor.actor.update({"system.resources.reaction.base":1,"system.resources.reaction.value":1});
    await action.update({"system.definition.effects":mode === "stop" ? [{id:"qa-stop",type:"condition",conditionId:"prone",
      metadata:{stagedMovementRun:fixture.runId}}] : []});
    const resolutionId = `qa-movement:${fixture.runId}:${foundry.utils.randomID()}`;
    qa.current = {runId:fixture.runId,role:"mover",mode,resolutionId,moverUserId,reactorUserId,
      moverTokenId:mover.id,reactorTokenId:reactor.id,sceneId:scene.id,origin:position(mover),route,
      before:snapshot(mover,reactor)};
    qa.envelopes = []; qa.history = [];
    await mover.setFlag("wildpath",FLAG,qa.current);
    return clone(qa.current);
  };
  qa.prove = () => {
    const record = runtime().coordinator.getRecord(qa.current?.resolutionId), state = record?.state;
    check(state?.status === "completed","Movement has not completed; inspect dump() and pending prompts.");
    const after = snapshot(mover,reactor), mode = qa.current.mode;
    const used = ["miss","hit","stop"].includes(mode), stopped = mode === "stop";
    const expected = route[stopped ? 0 : 2];
    check(after.x === expected.x && after.y === expected.y,"Unexpected completed position.");
    check(after.movement === (stopped ? 25 : 15),"Unexpected movement payment.");
    check(after.reaction === (used ? 0 : 1),"Unexpected reaction payment.");
    check(after.hp === (["hit","stop"].includes(mode) ? 24 : 30),"Unexpected child damage.");
    check(state.results.movementOutcome.stopped === stopped,"Unexpected continuation outcome.");
    const requests = [...record.requestExpectations.values()];
    check(requests.every(r => r.expectedUserId === reactorUserId),"Reaction request inherited the mover controller.");
    check(requests.length === (mode === "ordinary" ? 0 : used ? 2 : 1),"Unexpected choice/roll count.");
    const rollResponses = qa.envelopes.filter(e => e.messageType === "REQUEST_RESPONSE" && e.payload?.response?.type === "roll");
    check(!used || rollResponses.some(e => e.payload.response.value?.provider?.id === "foundry-digital"),"Missing real Foundry digital roll evidence.");
    qa.passed.push(qa.current.resolutionId);
    return qa.dump();
  };
  qa.dump = () => {
    const record = runtime().coordinator.getRecord(qa.current?.resolutionId);
    const ids = record?.knownResolutionIds ?? new Set([qa.current?.resolutionId]);
    return bounded({...qa.current,role:"gm",proofPassed:qa.passed.includes(qa.current?.resolutionId),
      after:snapshot(mover,reactor),state:{status:record?.state?.status,errors:record?.state?.errors,
        movement:record?.state?.results?.movementOutcome,reactions:record?.state?.results?.reactions,
        transaction:record?.state?.results?.transaction},routing:[...(record?.requestExpectations?.values() ?? [])],
      history:qa.history,envelopes:qa.envelopes.filter(e => ids.has(e.resolutionId)),
      result:runtime().coordinator.getResult(qa.current?.resolutionId)});
  };
  const receive = envelope => {if (qa.current && envelope?.messageType) qa.envelopes.push(clone(envelope));};
  qa.incoming = envelope => receive(envelope);
  qa.outgoing = (channel,envelope) => {if (channel === "system.wildpath") receive(envelope);};
  game.socket.on("system.wildpath",qa.incoming); game.socket.onAnyOutgoing(qa.outgoing);
  qa.timer = setInterval(() => {
    const state = runtime().coordinator.getRecord(qa.current?.resolutionId)?.state;
    const child = state?.metadata?.activeChildResolution;
    const entry = {status:state?.status,stage:state?.currentStageId,cursor:state?.results?.movement,
      child:child ? {id:child.id,status:child.status,source:child.source,rollResults:child.rollResults,
        targetFootprints:child.input?.context?.spatial?.targetFootprints} : null};
    if (state && JSON.stringify(qa.history.at(-1)) !== JSON.stringify(entry)) qa.history.push(clone(entry));
  },100);
  qa.detach = () => {clearInterval(qa.timer); game.socket.off("system.wildpath",qa.incoming);
    game.socket.offAnyOutgoing(qa.outgoing); game.wildpath.reactionServices = previous;};
  qa.cleanup = async () => {
    if (qa.current) check(["completed","failed","cancelled"].includes(runtime().coordinator.getRecord(qa.current.resolutionId)?.state?.status),
      "Export evidence and finish the pending resolution before cleanup.");
    qa.detach(); await cleanupActionGM(fixture.runId); delete globalThis.wpStagedMovementQA;
  };
  return qa;
}

export async function submitPlayer() {
  const mover = markedMover(), prepared = mover?.getFlag("wildpath",FLAG);
  check(prepared?.moverUserId === game.user.id,"Use the prepared mover's controller.");
  const origin = position(mover);
  const intent = {resolutionId:prepared.resolutionId,intentId:prepared.resolutionId,movementId:prepared.resolutionId,
    sceneRef:canvas.scene.uuid,tokenRef:mover.uuid,origin,
    waypoints:prepared.route.map(point => ({...point,elevation:mover.elevation})),movementKind:"voluntary",movementMode:"walk"};
  check(origin.x === prepared.origin.x && origin.y === prepared.origin.y,"Player has not received the prepared origin.");
  return game.wildpath.executeMovementIntent(intent);
}

export function dumpPlayer() {
  const mover = markedMover(), prepared = mover?.getFlag("wildpath",FLAG);
  check(prepared,"No prepared staged movement case.");
  const reactor = canvas.scene.tokens.get(prepared.reactorTokenId);
  return bounded({...prepared,role:"player",after:snapshot(mover,reactor),
    result:runtime().coordinator.getResult(prepared.resolutionId),
    notifications:runtime().coordinator.notifications.filter(n => n.envelope?.resolutionId === prepared.resolutionId)});
}
