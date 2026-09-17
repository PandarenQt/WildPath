import {useQuenchFixtures} from "./fixtures.mjs";
import {qaActionData, verifyDigitalRoll} from "../../../docs/development/action-runtime-live-qa.mjs";
import {largeHexLayout} from "../../../docs/development/staged-movement-qa.mjs";
import {captureMovementQA, verifyPendingMovementQA, verifyMovementQA, footprintSnapshot}
  from "../../../docs/development/staged-movement-qa-proof.mjs";
import {createReactionTrigger} from "../../helpers/automation-events.mjs";
import {actionDefinitionFromAction} from "../../helpers/action-definitions.mjs";
import {fieldDistance, footprintDistance} from "../../helpers/grid-footprints.mjs";
import {MULTIPLAYER_MESSAGE_TYPES as MESSAGE} from "../../helpers/multiplayer-authority.mjs";
import {createTestPromptAdapter} from "../../adapters/test-prompt-adapter.mjs";
import {createFoundryDigitalRollProvider} from "../../adapters/foundry-digital-roll-provider.mjs";
import {createFoundryV14DocumentPersistenceAdapter} from "../../adapters/foundry-v14-persistence-adapter.mjs";
import {createFoundryV14TacticalGridAdapter} from "../../adapters/foundry-v14-tactical-grid-adapter.mjs";
import {foundryMovementIntentToStagedOptions} from "../../adapters/foundry-v14-staged-movement-adapter.mjs";
import {stagedMovementPersistence} from "../../adapters/foundry-v14-staged-movement-commit.mjs";
import {foundryUserDirectory} from "../../adapters/foundry-v14-resolution-socket-adapter.mjs";
import {createMultiplayerActionCoordinator} from "../../resolvers/multiplayer-action-coordinator.mjs";
import {executeStagedActionResolution} from "../../resolvers/action-pipeline-resolver.mjs";

const clone = value => JSON.parse(JSON.stringify(value));
const position = token => {
  const source = token.toObject(true);
  return Object.fromEntries(["x","y","elevation","width","height","depth","shape"]
    .filter(key => source[key] !== undefined).map(key => [key,source[key]]));
};

/** The real coordinator is suspended in request() until the pending proof finishes successfully. */
export function createScriptedMovementPrompt({mode, provePending}) {
  let calls = 0;
  return createTestPromptAdapter({id:"quench-staged-movement-choice", queue:[async request => {
    calls++;
    if (request.type !== "reaction-choice" || mode === "ordinary" || calls !== 1) {
      throw new Error("Unexpected staged movement prompt.");
    }
    if (!["decline","miss","hit","stop"].includes(mode) || request.payload?.candidates?.length !== 1) {
      throw new Error("Expected one scripted movement reaction candidate.");
    }
    await provePending(request);
    return mode === "decline" ? {decision:"decline"}
      : {decision:"use",candidateId:request.payload.candidates[0].id};
  }]});
}

/** Application-local delivery only. Normal result broadcasts are consumed by this one coordinator. */
export function createQuenchLocalTransport({userId, receive}) {
  return {async send(envelope) {
    const localResult = envelope.messageType === MESSAGE.RESOLUTION_RESULT && envelope.recipientPolicy === "all";
    if (envelope.senderUserId !== userId || (!localResult && envelope.recipientUserId !== userId)
      || envelope.messageType === MESSAGE.PENDING_REQUEST) {
      throw new Error("Quench staged movement cannot deliver remote requests or messages.");
    }
    return receive(envelope);
  }};
}

/** Only the exact fixture intent receives QA rules. Preserve even an absent own property. */
export async function withQuenchMovementServices(runtime, {resolutionId, tokenRef, services}, run) {
  const previous = Object.getOwnPropertyDescriptor(runtime,"reactionServices");
  const fallback = runtime.reactionServices;
  runtime.reactionServices = function (context) {
    return context.resolutionKind === "movement" && context.intent?.resolutionId === resolutionId
      && context.intent?.tokenRef === tokenRef ? services : fallback?.call(this,context) ?? {};
  };
  try {
    return await run();
  } finally {
    if (previous) Object.defineProperty(runtime,"reactionServices",previous);
    else delete runtime.reactionServices;
  }
}

export function registerStagedMovementTests(quench) {
  quench.registerBatch("wildpath.staged-movement", context => {
    const {describe,it,assert} = context;
    describe("Staged movement through real Foundry Documents and production resolution (GM)", function () {
      this.timeout(60000);
      const fixtures = useQuenchFixtures(context);

      async function runCase(mode, {hex=false}={}) {
        assert.equal(game.release.generation,14,"Run the integration gate in Foundry V14.367");
        assert.equal(Number(game.release.build),367,"Run the integration gate in Foundry V14.367");
        assert.equal(game.users.activeGM?.id,game.user.id,"Run as the active GM");
        assert.exists(game.wildpath?.multiplayer,"WildPath must finish runtime initialization");
        const viewedScene = game.scenes.viewed?.id;
        const baseMover = await fixtures.createActor({name:`${mode} mover`,system:{
          traits:{size:hex ? "large" : "medium"}, defenses:{ac:{value:mode === "miss" ? 100 : 1}},
          resources:{health:{base:30,value:30},movement:{base:30,value:30}}}});
        const baseReactor = await fixtures.createActor({name:`${mode} reactor`,system:{
          traits:{size:"medium"},resources:{reaction:{base:1,value:1}}}});
        // Explicit fixture ownership keeps connected players out of this local integration gate.
        for (const base of [baseMover,baseReactor]) await base.update({ownership:{default:0,[game.user.id]:3}});
        const scene = await fixtures.createScene({name:`staged ${hex ? "Large hex" : "square"} ${mode}`,
          grid:{type:hex ? CONST.GRID_TYPES.HEXODDR : CONST.GRID_TYPES.SQUARE}});
        // V14 occupancy consults Level edges. Public initialization works on the disposable Scene;
        // no Scene#view, activation, canvas replacement, or selected Token is needed.
        scene.initializeEdges();
        const start = scene.grid.getTopLeftPoint({i:3,j:3});
        const mover = await fixtures.createToken(scene,baseMover,{name:"mover",...start,elevation:0,
          level:scene.initialLevel.id,...(hex ? {width:2,height:2,shape:CONST.TOKEN_SHAPES.ELLIPSE_1} : {})});
        const reactor = await fixtures.createToken(scene,baseReactor,{name:"reactor",
          ...scene.grid.getTopLeftPoint({i:2,j:3}),elevation:0,level:scene.initialLevel.id});
        await reactor.update({disposition:CONST.TOKEN_DISPOSITIONS.HOSTILE});
        for (const [token,base] of [[mover,baseMover],[reactor,baseReactor]]) {
          assert.isFalse(token.actorLink,"Fixture Tokens must be unlinked");
          assert.isTrue(token.actor.isToken,"Fixture Actors must be synthetic");
          assert.notStrictEqual(token.actor,base,"Synthetic Actor must differ from base Actor");
          assert.notEqual(token.actor.uuid,base.uuid,"Synthetic Actor identity must be Token-scoped");
          assert.strictEqual(token.actor.parent,token,"Synthetic Actor must belong to the exact Token");
          assert.instanceOf(token.delta,foundry.documents.ActorDelta,"Real ActorDelta required");
        }
        const runId = mover.getFlag("wildpath","quenchRunId");
        const persistencePort = createFoundryV14DocumentPersistenceAdapter();
        const adapter = createFoundryV14TacticalGridAdapter({scene});
        const footprint = (token, point=position(token)) => {
          const result = adapter.tokenToFootprint(token,{position:{...position(token),...point},strictOccupancy:true});
          assert.isTrue(result.ok,`Real Token occupancy failed: ${JSON.stringify(result)}`);
          assert.isEmpty(result.diagnostics,"Foundry occupancy must equal the complete tactical footprint");
          return result.footprint;
        };
        const origin = position(mover);
        let route;
        if (hex) {
          const layout = largeHexLayout(adapter,mover,reactor);
          route = layout.route;
          await stagedMovementPersistence(persistencePort,reactor,`quench-layout:${runId}`,
            () => game.users.activeGM?.id === game.user.id)
            .updateDocument({document:reactor,updates:layout.reactorPosition});
        } else route = [1,2,3].map(n => scene.grid.getTopLeftPoint({i:3,j:3+n}));
        const routeFootprints = [origin,...route].map(point => footprint(mover,point));
        const observer = footprint(reactor);
        assert.deepEqual(routeFootprints.map(f => footprintDistance(observer,f)),[1,1,2,3],
          "Real footprint distances must leave reach before transition 1");
        for (const f of routeFootprints) {
          assert.equal(f.topology,hex ? "hex" : "square");
          assert.equal(f.size,hex ? "large" : "medium");
          assert.equal(f.effectiveSize,hex ? "large" : "medium");
          assert.lengthOf(f.fields,hex ? 3 : 1,"Every evaluated footprint must retain its full size");
        }
        assert.deepEqual(routeFootprints.slice(1).map((f,i) => fieldDistance(
          f.anchor,routeFootprints[i].anchor,f.topology)),[1,1,1],
        "Every route anchor must be one adjacent field away");

        const data = qaActionData(runId);
        data.system.definition.id = `action:quench-movement-reaction:${runId}`;
        data.system.definition.costs = {allOf:[{capability:"reaction",amount:1}]};
        data.system.definition.effects = mode === "stop" ? [{id:"qa-stop",type:"condition",conditionId:"prone",
          metadata:{stagedMovementRun:runId}}] : [];
        const action = await fixtures.createItem(reactor.actor,{name:"movement reaction",type:"action",system:data.system});
        assert.instanceOf(action,CONFIG.Item.documentClass,"Reaction must use a real Action Item");
        assert.strictEqual(action.parent,reactor.actor,"Action must belong to the synthetic reactor");
        const definition = actionDefinitionFromAction(action);
        assert.isTrue(definition.ok,"Persisted ActionDefinition must validate");
        const baseBefore = [baseMover,baseReactor].map(a => a.toObject(true));
        const resolutionId = `quench-movement:${runId}`;
        const prepared = {mode,variant:hex ? "large-hex-decline" : "square",resolutionId,
          moverTokenId:mover.id,origin,route};
        const snapshot = () => ({...position(mover),movement:mover.actor.getResource("movement").value,
          hp:mover.actor.getResource("health").value,reaction:reactor.actor.getResource("reaction").value,
          footprint:footprint(mover)});
        assert.deepEqual([snapshot().movement,snapshot().hp,snapshot().reaction],[30,30,1]);
        const stopEffects = () => [...mover.actor.effects].filter(effect =>
          effect.flags?.wildpath?.conditionEffect?.metadata?.stagedMovementRun === runId);
        const services = {movement:{observers:[{id:"qaReactor",token:reactor,reachFields:1,context:{hostile:true}}],
          validate:() => stopEffects().length ? {decision:"stop",reason:"QA effect prevents further movement."}
            : {decision:"continue"}},
        reactions:{triggers:mode === "ordinary" ? [] : [createReactionTrigger({
          id:`qa-leave:${runId}`,event:"movement.transition-proposed",match:{phase:"interrupt"},
          actorId:reactor.actor.uuid,tokenId:reactor.id,action:definition.definition,actionId:definition.definition.id,
          predicate:{all:[{equals:{path:"event.data.movementKind",value:"voluntary"}},
            {equals:{path:"event.data.relations.qaReactor.leavesReach",value:true}},
            {equals:{path:"event.data.relations.qaReactor.context.hostile",value:true}}]}})]}};
        let coordinator, pending = null;
        const children = [], committedChildren = [];
        const capture = () => captureMovementQA(coordinator.getRecord(resolutionId).state,position(mover),footprint(mover));
        const prompt = createScriptedMovementPrompt({mode,provePending:request => {
          assert.equal(request.resolutionId,resolutionId,"Choice must belong to the fixture movement");
          const entry = capture();
          verifyPendingMovementQA(entry,prepared);
          assert.deepEqual([snapshot().movement,snapshot().hp,snapshot().reaction],[30,30,1],
            "Pending discovery must not spend movement, reaction, or HP");
          pending = entry; // A failed proof never releases a scripted response.
        }});
        // Local application transport deliberately has no socket subscription. It drives the same
        // coordinator entry/result handling and fails if anything attempts remote delivery.
        coordinator = createMultiplayerActionCoordinator({userId:game.user.id,
          users:() => foundryUserDirectory(game),activeGMUserId:() => game.users.activeGM?.id,
          transport:createQuenchLocalTransport({userId:game.user.id,receive:envelope => coordinator.handleEnvelope(envelope)}),
          promptPorts:[prompt],rollProviders:[createFoundryDigitalRollProvider()],
          actionIntentResolver:({intent,envelope}) => foundryMovementIntentToStagedOptions({intent,
            resolutionId:envelope.resolutionId,senderUserId:envelope.senderUserId,game,persistencePort}),
          executeResolution:async options => {
            // Observe the actual ready child before calling the unmodified production commit.
            // This catches fast GM digital rolls without Hooks, timers, or fabricated RollResults.
            children.push(capture());
            const result = await executeStagedActionResolution(options);
            committedChildren.push({state:clone(result.state),after:snapshot(),effects:stopEffects().map(e => e.toObject(true))});
            return result;
          }});
        await withQuenchMovementServices(game.wildpath,{resolutionId,tokenRef:mover.uuid,services},async () => {
          const submitted = await coordinator.declareActionIntent({resolutionKind:"movement",resolutionId,
            intentId:resolutionId,movementId:resolutionId,sceneRef:scene.uuid,tokenRef:mover.uuid,origin,
            waypoints:route.map(p => ({...p,elevation:mover.elevation})),movementKind:"voluntary",movementMode:"walk"});
          assert.isTrue(submitted.ok,JSON.stringify(submitted));
        });
        const record = coordinator.getRecord(resolutionId), state = record?.state;
        assert.isTrue(coordinator.getResult(resolutionId)?.ok,
          JSON.stringify({errors:coordinator.errors,stateErrors:state?.errors,notifications:coordinator.notifications}));
        verifyMovementQA({state,prepared,after:snapshot(),pending,children});
        assert.deepEqual(state.input.movement.evaluation.footprints.map(footprintSnapshot),
          routeFootprints.map(footprintSnapshot),"Production evaluation must preserve the adapter-proven route");
        assert.isTrue(state.results.transaction.ok,"Parent movement transaction must succeed");
        const used = ["miss","hit","stop"].includes(mode);
        assert.lengthOf(children,used ? 1 : 0,"Exactly one child commit for each used reaction");
        assert.lengthOf(committedChildren,used ? 1 : 0);
        assert.equal(record.knownResolutionIds.size,used ? 2 : 1,"No extra nested resolutions");
        const requests = [...record.requestExpectations.values()];
        assert.deepEqual(requests.map(r => r.request.type),mode === "ordinary" ? [] : used ? ["reaction-choice","roll"] : ["reaction-choice"]);
        assert.isTrue(requests.every(r => r.expectedUserId === game.user.id),"Every choice and roll must be GM-local");
        for (const child of committedChildren) {
          assert.equal(child.state.status,"completed","Child must commit independently before parent resumes");
          assert.lengthOf(child.state.rollResults,1,"The child must contain one real attack RollResult");
          verifyDigitalRoll(child.state.rollResults[0].rollResult,child.state.id);
          const attack = child.state.results.attackResolution;
          assert.lengthOf(attack.results,1);
          assert.equal(attack.results[0].defense.value,mode === "miss" ? 100 : 1,"Attack must use the real target AC");
          assert.lengthOf(attack.hits,mode === "miss" ? 0 : 1,"AC 1 must be hit");
          assert.lengthOf(attack.misses,mode === "miss" ? 1 : 0,"AC 100 must be missed");
          const transaction = child.state.results.actionResult.steps.findLast(s => s.data?.transaction)?.data.transaction;
          assert.isTrue(transaction?.ok,"Child transaction must succeed");
          assert.isFalse(transaction.rolledBack,"Committed child must not be rolled back");
          assert.deepEqual([child.after.x,child.after.y,child.after.movement],[origin.x,origin.y,30],
            "Child commits before parent position or movement payment");
          assert.deepEqual([child.after.hp,child.after.reaction],[mode === "miss" ? 30 : 24,0]);
          const reaction = state.results.reactions.find(r => r.childResolutionId === child.state.id);
          assert.equal(reaction?.childStatus,"completed","Parent must retain the independently completed child status");
          assert.isFalse(reaction.childFailed);
          assert.lengthOf(child.effects,mode === "stop" ? 1 : 0,"Stop effect must persist during the child commit");
        }
        assert.lengthOf(stopEffects(),mode === "stop" ? 1 : 0);
        if (mode === "stop") {
          const [effect] = stopEffects();
          assert.instanceOf(effect,CONFIG.ActiveEffect.documentClass,"Stop must apply a real ActiveEffect");
          assert.strictEqual(effect.parent,mover.actor);
          assert.isTrue(effect.statuses.has("prone"),"Stop must use the existing QA Prone condition path");
          assert.isFalse(effect.disabled);
          assert.isTrue(mover.actor.toObject(true).effects.some(e => e._id === effect.id));
          assert.isTrue(mover.delta.toObject(true).effects.some(e => e._id === effect.id),"Stop effect must persist in ActorDelta");
        }
        const expectedMovement = mode === "stop" ? 25 : 15;
        const expectedHP = ["hit","stop"].includes(mode) ? 24 : 30;
        for (const [token,key,value] of [[mover,"movement",expectedMovement],[mover,"health",expectedHP],
          [reactor,"reaction",used ? 0 : 1]]) {
          assert.equal(token.actor.toObject(true).system.resources[key].value,value,"Synthetic source must persist resources");
          if (key === "movement" || (key === "health" && expectedHP !== 30) || (key === "reaction" && used)) {
            assert.equal(token.delta.toObject(true).system.resources[key].value,value,"Changed resources must persist in ActorDelta");
          }
        }
        assert.deepEqual([baseMover,baseReactor].map(a => a.toObject(true)),baseBefore,"Base Actors must stay unchanged");
        assert.strictEqual(game.scenes.get(scene.id).tokens.get(mover.id),mover,"Final Token must remain persisted");
        assert.isFalse(scene.active,"Fixture Scene must never activate");
        assert.equal(game.scenes.viewed?.id,viewedScene,"Quench must preserve the viewed Scene");
      }

      it("ordinary square/Medium movement", () => runCase("ordinary"));
      it("square/Medium reaction decline", () => runCase("decline"));
      it("square/Medium reaction miss", () => runCase("miss"));
      it("square/Medium reaction hit", () => runCase("hit"));
      it("square/Medium reaction stop", () => runCase("stop"));
      it("Large-hex reaction decline", () => runCase("decline",{hex:true}));
    });
  }, {displayName:"WILDPATH: Staged Movement",preSelected:false});
}
