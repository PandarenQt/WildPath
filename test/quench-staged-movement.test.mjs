// Portable orchestration checks only: these do not claim real Foundry integration evidence.
import {test} from "node:test";
import assert from "node:assert/strict";
import {createScriptedMovementPrompt,withQuenchMovementServices,createQuenchLocalTransport}
  from "../module/tests/quench/staged-movement.mjs";
import {createMultiplayerActionCoordinator} from "../module/resolvers/multiplayer-action-coordinator.mjs";
import {createResolutionState} from "../module/helpers/resolution-state.mjs";

const request = {id:"choice",resolutionId:"movement",type:"reaction-choice",expectedResponseType:"reaction-choice",
  payload:{candidates:[{id:"reactor-choice"}]}};

test("Quench movement response waits for successful pending proof before releasing the choice", async () => {
  let finishProof, entered;
  const started = new Promise(resolve => {entered = resolve;});
  const proof = new Promise(resolve => {finishProof = resolve;});
  const prompt = createScriptedMovementPrompt({mode:"decline",provePending:async input => {
    assert.strictEqual(input,request);
    entered();
    await proof;
  }});
  let answered = false;
  const response = prompt.request(request).then(value => {answered = true; return value;});
  await started;
  assert.equal(answered,false,"No response may escape while the pending proof is unresolved");
  finishProof();
  assert.deepEqual((await response).value,{decision:"decline"});
  assert.equal(answered,true);
});

test("Quench miss, hit, and stop select the offered reaction without synthesizing a roll", async () => {
  for (const mode of ["miss","hit","stop"]) {
    let proofs = 0;
    const prompt = createScriptedMovementPrompt({mode,provePending:() => proofs++});
    const response = await prompt.request(request);
    assert.equal(proofs,1);
    assert.deepEqual(response.value,{decision:"use",candidateId:"reactor-choice"});
    assert.equal(response.requestId,request.id);
    assert.equal(response.resolutionId,request.resolutionId);
    const unexpected = await prompt.request({...request,id:"unexpected-roll",type:"roll"});
    assert.equal(unexpected.ok,false,"The scripted boundary must never supply an attack RollResult");
  }
});

test("Quench pending proof failure rejects without answering and restores scoped runtime services", async () => {
  const previous = () => ({original:true});
  const runtime = {reactionServices:previous};
  const descriptor = Object.getOwnPropertyDescriptor(runtime,"reactionServices");
  const proofFailure = new Error("pending footprint proof failed");
  const scope = {resolutionId:"movement",tokenRef:"Token.fixture",services:{fixture:true}};
  await assert.rejects(withQuenchMovementServices(runtime,scope,async () => {
    const prompt = createScriptedMovementPrompt({mode:"hit",provePending:() => {throw proofFailure;}});
    await prompt.request(request);
    assert.fail("Failed proof must never return an accepted choice");
  }),error => error === proofFailure);
  assert.deepEqual(Object.getOwnPropertyDescriptor(runtime,"reactionServices"),descriptor);
});

test("Quench scripted choice rejects ordinary prompts, missing candidates, and duplicate choices", async () => {
  let proofs = 0;
  const provePending = () => proofs++;
  await assert.rejects(createScriptedMovementPrompt({mode:"ordinary",provePending}).request(request),/Unexpected/);
  await assert.rejects(createScriptedMovementPrompt({mode:"decline",provePending})
    .request({...request,payload:{candidates:[]}}),/one scripted/);
  await assert.rejects(createScriptedMovementPrompt({mode:"miss",provePending})
    .request({...request,type:"roll"}),/Unexpected/);
  assert.equal(proofs,0);
  const prompt = createScriptedMovementPrompt({mode:"decline",provePending});
  await prompt.request(request);
  assert.equal((await prompt.request(request)).ok,false);
  assert.equal(proofs,1,"A second choice must not get another scripted response");
});

test("Quench runtime service override matches only its exact movement and restores after success", async () => {
  const seen = [];
  const runtime = {reactionServices(context) {assert.strictEqual(this,runtime); seen.push(context); return {original:true};}};
  const original = runtime.reactionServices;
  const scope = {resolutionId:"movement",tokenRef:"Token.fixture",services:{fixture:true}};
  const matching = {resolutionKind:"movement",intent:{resolutionId:scope.resolutionId,tokenRef:scope.tokenRef}};
  const result = await withQuenchMovementServices(runtime,scope,async () => {
    assert.strictEqual(runtime.reactionServices(matching),scope.services);
    for (const context of [{...matching,resolutionKind:"action"},
      {...matching,intent:{...matching.intent,resolutionId:"other"}},
      {...matching,intent:{...matching.intent,tokenRef:"Token.other"}}]) {
      assert.deepEqual(runtime.reactionServices(context),{original:true});
    }
    await Promise.resolve();
    assert.notStrictEqual(runtime.reactionServices,original,"Override must last until execution settles");
    return "complete";
  });
  assert.equal(result,"complete");
  assert.equal(seen.length,3);
  assert.strictEqual(runtime.reactionServices,original);
});

test("Quench service restoration preserves absent and inherited properties even after failure", async () => {
  for (const runtime of [{},Object.create({reactionServices:() => ({inherited:true})})]) {
    const previous = runtime.reactionServices;
    await assert.rejects(withQuenchMovementServices(runtime,{resolutionId:"r",tokenRef:"t",services:{}},async () => {
      throw new Error("execution failed");
    }),/execution failed/);
    assert.equal(Object.hasOwn(runtime,"reactionServices"),false);
    assert.strictEqual(runtime.reactionServices,previous);
  }
});

test("Quench local transport completes the coordinator intent and result broadcast without sockets", async () => {
  const delivered = [];
  const coordinator = createMultiplayerActionCoordinator({userId:"gm",activeGMUserId:"gm",
    users:[{id:"gm",isGM:true,active:true}],
    transport:createQuenchLocalTransport({userId:"gm",receive:envelope => {
      delivered.push(envelope);
      return coordinator.handleEnvelope(envelope);
    }}),
    // A terminal test state isolates transport orchestration; it is not a movement/persistence fake.
    actionIntentResolver:({intent}) => ({ok:true,options:{id:intent.resolutionId}}),
    planResolution:options => ({ok:true,state:createResolutionState({id:options.id,status:"completed"})})});
  const result = await coordinator.declareActionIntent({resolutionId:"local-transport"});
  assert.equal(result.ok,true,JSON.stringify({result,delivered,errors:coordinator.errors}));
  assert.equal(coordinator.getResult("local-transport").status,"completed");
  assert.deepEqual(delivered.map(e => e.messageType),["ACTION_INTENT","RESOLUTION_RESULT"]);
  assert.equal(delivered[1].recipientPolicy,"all");
});

test("Quench local transport rejects remote delivery and propagates receiver failures", async () => {
  let calls = 0;
  const port = createQuenchLocalTransport({userId:"gm",receive:() => {calls++; throw new Error("receiver failed");}});
  for (const envelope of [
    {messageType:"PENDING_REQUEST",senderUserId:"gm",recipientUserId:"gm"},
    {messageType:"PENDING_REQUEST",senderUserId:"gm",recipientUserId:"player"},
    {messageType:"ACTION_INTENT",senderUserId:"player",recipientUserId:"gm"},
    {messageType:"ACTION_INTENT",senderUserId:"gm",recipientUserId:"other-gm"}
  ]) await assert.rejects(port.send(envelope),/cannot deliver remote/);
  assert.equal(calls,0);
  await assert.rejects(port.send({messageType:"ACTION_INTENT",senderUserId:"gm",recipientUserId:"gm"}),/receiver failed/);
  assert.equal(calls,1);
});
