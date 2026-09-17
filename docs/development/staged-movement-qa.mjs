// Development-only companion to staged-movement-qa.md; never loaded at system startup.
import {setupGM as setupActionGM, cleanupGM as cleanupActionGM, qaActionData, bounded} from "./action-runtime-live-qa.mjs";
import {createReactionTrigger} from "../../module/helpers/automation-events.mjs";
import {actionDefinitionFromAction} from "../../module/helpers/action-definitions.mjs";
import {createFoundryV14DocumentPersistenceAdapter} from "../../module/adapters/foundry-v14-persistence-adapter.mjs";
import {stagedMovementPersistence} from "../../module/adapters/foundry-v14-staged-movement-commit.mjs";
import {createFoundryV14TacticalGridAdapter} from "../../module/adapters/foundry-v14-tactical-grid-adapter.mjs";
import {footprintDistance} from "../../module/helpers/grid-footprints.mjs";
import {buildStagedMovementLevel5Evidence, captureMovementQA, footprintSnapshot, verifyPendingMovementQA, verifyMovementQA}
  from "./staged-movement-qa-proof.mjs";

const FLAG = "stagedMovementQA";
const check = (value, reason) => {if (!value) throw new Error(reason);};
const clone = value => JSON.parse(JSON.stringify(value));
const runtime = () => game.wildpath.multiplayer;
const markedMover = () => [...canvas.scene.tokens].find(t => t.getFlag("wildpath", FLAG)?.role === "mover");
const positionKeys = ["x","y","elevation","width","height","depth","shape"];
const position = token => Object.fromEntries(positionKeys.map(key => [key,token.toObject(true)[key]]).filter(([,value]) => value !== undefined));
/** Plain runtime identity read at export time; only stable primitive fields are serialized. */
export function foundryRuntimeMetadata() {
  return {foundryVersion:game.version, generation:game.release?.generation ?? null, build:game.release?.build ?? null,
    systemId:game.system?.id ?? null, systemVersion:game.system?.version ?? null};
}
const packageEvidence = object => ({object, json:JSON.stringify(object,null,2), file:object.evidenceFile});

function snapshot(mover, reactor) {
  return {x:mover.x,y:mover.y,movement:mover.actor.system.resources.movement.value,
    hp:mover.actor.system.resources.health.value,reaction:reactor.actor.system.resources.reaction.value,
    effects:[...mover.actor.effects].map(e => ({id:e.id,metadata:e.flags?.wildpath?.conditionEffect?.metadata}))};
}

function checkedFootprint(adapter, token, point=position(token)) {
  const result = adapter.tokenToFootprint(token,{position:{...position(token),...point},strictOccupancy:true});
  check(result.ok && !result.diagnostics.length,"QA Token occupancy must match its full tactical footprint.");
  return result.footprint;
}

export function largeHexLayout(adapter, mover, reactor) {
  const a = checkedFootprint(adapter,mover), b = checkedFootprint(adapter,reactor);
  check(a.topology === "hex" && a.size === "large" && a.fields.length === 3,
    "Use a Large three-field hex mover.");
  const at = (token, from, field) => {
    const start = adapter.fieldToCenterPoint(from), end = adapter.fieldToCenterPoint(field);
    check(start.ok && end.ok,"Cannot map QA hex anchors to Scene coordinates.");
    return {x:Math.round(token.x+end.point.x-start.point.x),y:Math.round(token.y+end.point.y-start.point.y)};
  };
  // Fixed axial fixture: one logical step within reach, then leave on the second step.
  // Coordinates and occupied fields are verified by the existing tactical adapter.
  const route = [1,2,3].map(n => at(mover,a.anchor,{q:a.anchor.q+n,r:a.anchor.r}));
  const reactorPosition = at(reactor,b.anchor,{q:a.anchor.q+1,r:a.anchor.r-1});
  const observer = checkedFootprint(adapter,reactor,reactorPosition);
  const footprints = [a,...route.map(p => checkedFootprint(adapter,mover,p))];
  check(footprints.every(f => f.topology === "hex" && f.fields.length === 3)
    && footprints.map(f => footprintDistance(observer,f)).join(",") === "1,1,2,3",
    "Hex fixture must retain three fields and leave reach after its first logical step.");
  return {route,reactorPosition};
}

export async function setupGM(moverUserId, reactorUserId=game.user.id, {variant="square"}={}) {
  check(!globalThis.wpStagedMovementQA,"Detach the previous staged movement helper first.");
  check(["square","large-hex-decline"].includes(variant),"Unknown staged movement QA variant.");
  const hex = variant === "large-hex-decline";
  const old = await setupActionGM(moverUserId,{topology:hex ? "hex" : "square"});
  old.detach();
  const fixture = old.fixture, scene = game.scenes.get(fixture.sceneId);
  const mover = scene.tokens.get(fixture.sourceTokenId), reactor = scene.tokens.get(fixture.targetTokenId);
  if (hex) {
    await mover.actor.update({"system.traits.size":"large"});
    await mover.update({width:2,height:2,shape:CONST.TOKEN_SHAPES.ELLIPSE_1});
  }
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  const origin = position(mover), offset = canvas.grid.getOffset(origin);
  const {reactorPosition,route} = hex ? largeHexLayout(adapter,mover,reactor) : {
    reactorPosition:canvas.grid.getTopLeftPoint({i:offset.i-1,j:offset.j}),
    route:[1,2,3].map(n => canvas.grid.getTopLeftPoint({i:offset.i,j:offset.j+n}))};
  // Foundry square offsets are row/column. Adapter verification below owns the actual geometry.
  check(game.users.get(reactorUserId)?.active && reactorUserId !== moverUserId,"Choose an active reactor controller different from the mover.");
  await game.actors.get(fixture.targetActorId).update({ownership:{default:0,[reactorUserId]:3}});
  const data = qaActionData(fixture.runId);
  data.system.definition.costs = {allOf:[{capability:"reaction",amount:1}]};
  data.system.definition.id = `action:qa-movement-reaction:${fixture.runId}`;
  const [action] = await reactor.actor.createEmbeddedDocuments("Item",[data]);
  const previous = game.wildpath.reactionServices;
  const qa = globalThis.wpStagedMovementQA = {fixture, mover, reactor, action, current:null, previous,
    passed:[], envelopes:[], history:[], children:[], pending:null, captureErrors:[]};
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
    check(!hex || mode === "decline","Large hex variant is decline-only.");
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
    qa.current = {runId:fixture.runId,role:"mover",mode,variant,resolutionId,moverUserId,reactorUserId,
      moverTokenId:mover.id,reactorTokenId:reactor.id,sceneId:scene.id,origin:position(mover),route,
      before:snapshot(mover,reactor)};
    qa.envelopes = []; qa.history = []; qa.children = []; qa.pending = null; qa.captureErrors = [];
    await mover.setFlag("wildpath",FLAG,qa.current);
    return clone(qa.current);
  };
  qa.provePending = () => {
    const entry = qa.capture();
    verifyPendingMovementQA(entry,qa.current);
    qa.pending = clone(entry);
    return bounded({pendingProofPassed:true,...entry});
  };
  qa.prove = () => {
    const record = runtime().coordinator.getRecord(qa.current?.resolutionId), state = record?.state;
    const after = snapshot(mover,reactor), mode = qa.current.mode;
    const used = ["miss","hit","stop"].includes(mode);
    check(!qa.captureErrors.length,"QA observation failed; inspect captureErrors in dump().");
    verifyMovementQA({state,prepared:qa.current,after:{...after,footprint:checkedFootprint(adapter,mover)},
      pending:qa.pending,children:qa.children});
    const requests = [...record.requestExpectations.values()];
    check(requests.every(r => r.expectedUserId === reactorUserId),"Reaction request inherited the mover controller.");
    check(requests.length === (mode === "ordinary" ? 0 : used ? 2 : 1),"Unexpected choice/roll count.");
    const rollResponses = qa.envelopes.filter(
      e => e.messageType === "REQUEST_RESPONSE"
        && e.payload?.response?.type === "roll"
    );

    const socketDigitalRoll = rollResponses.some(
      e => e.payload?.response?.value?.provider?.id === "foundry-digital"
    );

    const childDigitalRoll = qa.children.some(
      entry => entry.child?.rollResults?.some(
        result =>
          result?.rollResult?.provider?.id === "foundry-digital"
          && result?.rollResult?.provenance?.type === "foundry-digital"
      )
    );

    check(
      !used || socketDigitalRoll || childDigitalRoll,
      "Missing real Foundry digital roll evidence."
    );
    qa.passed.push(qa.current.resolutionId);
    return qa.dump();
  };
  qa.dump = () => {
    const record = runtime().coordinator.getRecord(qa.current?.resolutionId);
    const ids = record?.knownResolutionIds ?? new Set([qa.current?.resolutionId]);
    return bounded({...qa.current,role:"gm",proofPassed:qa.passed.includes(qa.current?.resolutionId),
      after:snapshot(mover,reactor),footprintProof:{pending:qa.pending,children:qa.children,captureErrors:qa.captureErrors,
        route:record?.state?.input?.movement?.evaluation?.footprints?.map(footprintSnapshot),
        final:footprintSnapshot(adapter.tokenToFootprint(mover).footprint)},
      state:{status:record?.state?.status,errors:record?.state?.errors,
        movement:record?.state?.results?.movementOutcome,reactions:record?.state?.results?.reactions,
        windows:record?.state?.metadata?.reactionWindows?.map(w => ({id:w.id,status:w.status,
          offeredCandidateIds:w.offeredCandidateIds,declinedCandidateIds:w.declinedCandidateIds,childResolutionIds:w.childResolutionIds})),
        transaction:record?.state?.results?.transaction},routing:[...(record?.requestExpectations?.values() ?? [])],
      history:qa.history,envelopes:qa.envelopes.filter(e => ids.has(e.resolutionId)),
      result:runtime().coordinator.getResult(qa.current?.resolutionId)});
  };
  // Canonical Level-5 GM export: wraps the same bounded dump that prove() returns, refusing pre-proof
  // state, non-sentinel cases, or a missing served-build SHA. Use copy(movementQA.exportEvidence({gitSha}).json).
  qa.exportEvidence = ({gitSha, sentinel=null}={}) => packageEvidence(buildStagedMovementLevel5Evidence({
    role:"gm", evidence:qa.dump(), gitSha, sentinel, runtime:foundryRuntimeMetadata()}));
  const receive = envelope => {if (qa.current && envelope?.messageType) qa.envelopes.push(clone(envelope));};
  qa.incoming = envelope => receive(envelope);
  qa.outgoing = (channel,envelope) => {if (channel === "system.wildpath") receive(envelope);};
  game.socket.on("system.wildpath",qa.incoming); game.socket.onAnyOutgoing(qa.outgoing);
  qa.capture = () => {
    const state = runtime().coordinator.getRecord(qa.current?.resolutionId)?.state;
    if (!state?.results?.movement) return null;
    const entry = captureMovementQA(state,position(mover),checkedFootprint(adapter,mover));
    if (JSON.stringify(qa.history.at(-1)) !== JSON.stringify(entry)) qa.history.push(entry);
    if (entry.child && JSON.stringify(qa.children.at(-1)) !== JSON.stringify(entry)) qa.children.push(entry);
    return entry;
  };
  // Read-only observation at the normal child commit catches fast local-GM rolls.
  // Never throw from a Foundry hook or return false: evidence errors only fail the QA proof.
  const observe = () => {try {qa.capture();} catch (error) {qa.captureErrors.push(error.message);}};
  qa.actorHook = Hooks.on("preUpdateActor",observe);
  qa.timer = setInterval(observe,100);
  qa.detach = () => {clearInterval(qa.timer); game.socket.off("system.wildpath",qa.incoming);
    Hooks.off("preUpdateActor",qa.actorHook);
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

/** Canonical Level-5 player export: requires the completed terminal result for the prepared resolution. */
export function exportPlayerEvidence({gitSha, sentinel=null}={}) {
  return packageEvidence(buildStagedMovementLevel5Evidence({
    role:"player", evidence:dumpPlayer(), gitSha, sentinel, runtime:foundryRuntimeMetadata()}));
}
