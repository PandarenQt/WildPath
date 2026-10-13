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

  const digitalAnswer = await answerPendingRequestLocally({request, promptPorts: [prompt],
    rollProviders: [digital, createPhysicalDiceProvider()],
    context: {...dicePolicyRollContext(gameWithPolicy("digital"))}});
  assert.equal(digitalAnswer.response.value.natural, 20, "the default policy keeps the digital provider");
});
