import assert from "node:assert/strict";
import test from "node:test";

import {DICE_POLICY_PROVIDERS, dicePolicyRollContext} from "../module/resolvers/foundry-multiplayer-runtime.mjs";
import {answerPendingRequestLocally} from "../module/resolvers/multiplayer-action-coordinator.mjs";
import {createPhysicalDiceProvider, createTestRollProvider} from "../module/resolvers/roll-provider-resolver.mjs";
import {createTestPromptAdapter} from "../module/adapters/test-prompt-adapter.mjs";
import {createD20RollRequest} from "../module/helpers/rolls.mjs";

const gameWithPolicy = policy => ({settings: {get: (namespace, key) => {
  if ( namespace !== "wildpath" || key !== "dicePolicy" ) throw new Error("unexpected setting");
  return policy;
}}});

test("the dice policy names the RollProvider, is read per roll, and degrades to provider order when unset", () => {
  let policy = "digital";
  const context = dicePolicyRollContext({settings: {get: () => policy}});
  assert.equal({...context}.providerId, DICE_POLICY_PROVIDERS.digital, "the coordinator spreads the context per roll");
  policy = "physical";
  assert.equal({...context}.providerId, "physical-dice", "a changed policy applies to the next roll");
  assert.equal({...dicePolicyRollContext({settings: {get: () => { throw new Error("not registered"); }}})}.providerId, null);
  assert.equal({...dicePolicyRollContext(null)}.providerId, null);
});

test("under the physical policy the roller is asked for the dice and the digital provider is never used", async () => {
  const rollRequest = createD20RollRequest({id: "request:physical", resolutionId: "resolution:physical", modifier: 4});
  const request = {id: "request:physical", resolutionId: "resolution:physical", type: "roll", payload: {rollRequest}};
  const digital = createTestRollProvider({id: "foundry-digital", result: {natural: 20, total: 24}});
  const prompted = [];
  const prompt = createTestPromptAdapter({queue: [{natural: 7, total: 11}], canHandle: incoming => {
    prompted.push(incoming.id);
    return true;
  }});
  const answered = await answerPendingRequestLocally({request, promptPorts: [prompt],
    rollProviders: [digital, createPhysicalDiceProvider()],
    context: {...dicePolicyRollContext(gameWithPolicy("physical"))}});
  assert.equal(answered.ok, true, JSON.stringify(answered));
  assert.deepEqual(prompted, ["request:physical"], "the physical provider defers to the roll prompt");
  assert.equal(answered.response.value.natural, 7);
  assert.equal(answered.response.value.provenance.type, "physical", "typed physical dice keep their provenance");

  const digitalAnswer = await answerPendingRequestLocally({request, promptPorts: [prompt],
    rollProviders: [digital, createPhysicalDiceProvider()],
    context: {...dicePolicyRollContext(gameWithPolicy("digital"))}});
  assert.equal(digitalAnswer.response.value.natural, 20, "the default policy keeps the digital provider");
});

test("a chooser whose typed roll the rules reject is told and asked again", async () => {
  const {createTestResolutionTransportHub} = await import("../module/adapters/test-resolution-transport.mjs");
  const {createMultiplayerActionCoordinator} = await import("../module/resolvers/multiplayer-action-coordinator.mjs");
  const {MULTIPLAYER_MESSAGE_TYPES, createResolutionSocketEnvelope} = await import("../module/helpers/multiplayer-authority.mjs");
  const {createDamageRollRequest} = await import("../module/helpers/rolls.mjs");
  const hub = createTestResolutionTransportHub({users: [
    {id: "gm-a", active: true, isGM: true, isActiveGM: true},
    {id: "player-a", active: true, isGM: false}
  ]});
  const received = [];
  const gm = hub.createEndpoint({userId: "gm-a"});
  gm.register(envelope => { received.push(envelope); return {ok: true}; });
  const notified = [];
  const player = createMultiplayerActionCoordinator({userId: "player-a", users: () => hub.userDirectory(),
    activeGMUserId: "gm-a", transport: hub.createEndpoint({userId: "player-a"}),
    promptPorts: [createTestPromptAdapter({queue: [{total: 9}, {total: 4}]})],
    rollProviders: [createPhysicalDiceProvider()], notify: event => notified.push(event)});
  player.register();
  const rollRequest = createDamageRollRequest({id: "request:typo", resolutionId: "resolution:typo",
    components: [{id: "blade", expression: {type: "dice", number: 1, faces: 8}}]});
  await gm.send(createResolutionSocketEnvelope({messageType: MULTIPLAYER_MESSAGE_TYPES.PENDING_REQUEST,
    senderUserId: "gm-a", recipientUserId: "player-a", resolutionId: "resolution:typo", requestId: "request:typo",
    payload: {request: {id: "request:typo", resolutionId: "resolution:typo", type: "roll", payload: {rollRequest},
      metadata: {multiplayer: {expectedChooserUserId: "player-a"}}}}}));
  const answer = () => received.find(envelope => envelope.messageType === MULTIPLAYER_MESSAGE_TYPES.REQUEST_RESPONSE);
  for ( let i = 0; i < 50 && !answer(); i++ ) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(answer()?.payload.response.value.total, 4, "the second, valid total is sent");
  assert.equal(notified.length, 1);
  assert.equal(notified[0].error.code, "INVALID_MANUAL_RESULT");
  assert.equal(received.some(envelope => envelope.messageType === MULTIPLAYER_MESSAGE_TYPES.RESOLUTION_ERROR), false);
});

test("a roller's own message mode decides the visibility of rolls the rules leave to them (saves)", async () => {
  const {sanitizeResolutionResultForTransport, projectResolutionResultForDisclosure} =
    await import("../module/helpers/multiplayer-authority.mjs");
  const {DISCLOSURE_CLASSIFICATIONS} = await import("../module/helpers/multiplayer-disclosure.mjs");
  const save = createD20RollRequest({id: "request:save", resolutionId: "resolution:save", type: "saving-throw", modifier: 2});
  const request = {id: "request:save", resolutionId: "resolution:save", type: "roll", payload: {rollRequest: save}};
  const digital = createTestRollProvider({id: "foundry-digital", result: {natural: 11, total: 13}});
  const answered = await answerPendingRequestLocally({request, rollProviders: [digital], context: {messageMode: "public"}});
  assert.equal(answered.response.value.metadata.visibility, "public");
  const unset = await answerPendingRequestLocally({request, rollProviders: [digital], context: {}});
  assert.equal(unset.response.value.metadata?.visibility, undefined);

  const resultWith = (rollRequest, rollResult) => projectResolutionResultForDisclosure(sanitizeResolutionResultForTransport({
    state: {id: "resolution:save", status: "completed", rollRequests: [rollRequest],
      rollResults: [{requestId: rollRequest.id, type: "save-roll", rollResult}]}
  }), DISCLOSURE_CLASSIFICATIONS.BROADCAST_SAFE).rolls;
  assert.deepEqual(resultWith(save, answered.response.value).map(roll => roll.visibility), ["public"],
    "a save the target's Player rolled in public mode is public");
  assert.deepEqual(resultWith(save, {...answered.response.value, metadata: {visibility: "everyone"}}), [],
    "an unknown mode stays system (not public)");
  const gmAttack = {...save, id: "request:attack", visibility: "gm-only"};
  assert.deepEqual(resultWith(gmAttack, {...answered.response.value, requestId: "request:attack"}), [],
    "a request's own visibility wins over the roller's");
});
