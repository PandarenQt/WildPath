import {test} from "node:test";
import assert from "node:assert/strict";
import {createFoundryV14PromptAdapter} from "../module/adapters/foundry-v14-prompt-adapter.mjs";
import {createPromptViewModel} from "../module/helpers/prompt-view-models.mjs";
import {createResolutionState} from "../module/helpers/resolution-state.mjs";
import {coordinateResolutionPrompt} from "../module/resolvers/choice-coordinator.mjs";

function reactionRequest() {
  return {id: "request:reaction", resolutionId: "resolution:reaction", type: "reaction-choice",
    expectedResponseType: "reaction-choice", payload: {options: [
      {id: "candidate:A", label: "QA reaction Action", value: {decision: "use", candidateId: "candidate:A"}},
      {id: "decline", label: "Decline", value: {decision: "decline"}}
    ]}};
}

for ( const shape of ["object", "FormData"] ) {
  for ( const selection of ["candidate:A", "decline"] ) {
    test(`Foundry reaction prompt decodes ${selection} from ${shape} into the offered semantic value`, async () => {
      const request = reactionRequest();
      const view = createPromptViewModel(request);
      assert.deepEqual(JSON.parse(JSON.stringify(view)), view);
      assert.deepEqual(view.controls[0].options.map(option => option.value), request.payload.options.map(option => option.value));
      const adapter = createFoundryV14PromptAdapter({DialogV2: {async input({content}) {
        assert.match(content, /<option value="candidate:A">QA reaction Action<\/option>/);
        assert.match(content, /<option value="decline" selected>Decline<\/option>/);
        assert.equal((content.match(/ selected/g) ?? []).length, 1);
        return shape === "object" ? {"choice:choice": selection} : new Map([["choice:choice", selection]]);
      }}});
      const result = await adapter.request(request);
      assert.equal(result.ok, true);
      assert.deepEqual(result.value, request.payload.options.find(option => option.id === selection).value);
      assert.equal(result.value.choices, undefined);
      result.value.decision = "mutated";
      assert.equal(request.payload.options[0].value.decision, "use");
      assert.equal(view.controls[0].options[0].value.decision, "use");
    });
  }
}

test("Foundry reaction prompt rejects missing, unoffered, and JSON form selections", async () => {
  for ( const selection of [undefined, "candidate:unoffered", '{"decision":"use","candidateId":"candidate:A"}',
    {decision: "use", candidateId: "candidate:A"}] ) {
    const adapter = createFoundryV14PromptAdapter({DialogV2: {async input() {
      return selection === undefined ? {} : {"choice:choice": selection};
    }}});
    await assert.rejects(adapter.request(reactionRequest()), /offered reaction option/);
  }
});

test("Foundry reaction prompt uses the offered value even when presentation ID and label differ", async () => {
  const request = reactionRequest();
  request.payload.options[0].id = "visible-option:A";
  request.payload.options[0].label = "Decline";
  const adapter = createFoundryV14PromptAdapter({DialogV2: {async input() {
    return {"choice:choice": "visible-option:A"};
  }}});
  assert.deepEqual((await adapter.request(request)).value, {decision: "use", candidateId: "candidate:A"});
});

test("unoffered Foundry reaction selection fails through ChoiceCoordinator without consuming the request", async () => {
  const request = reactionRequest();
  const state = createResolutionState({id: request.resolutionId, pendingRequests: [request]});
  let resumed = false;
  const result = await coordinateResolutionPrompt({state,
    resume: () => { resumed = true; throw new Error("Invalid option must never resume."); },
    promptPorts: [createFoundryV14PromptAdapter({DialogV2: {async input() {
      return {"choice:choice": "candidate:unoffered"};
    }}})]});
  assert.equal(result.ok, false);
  assert.equal(result.code, "PROMPT_PORT_FAILURE");
  assert.match(result.reason, /offered reaction option/);
  assert.equal(resumed, false);
  assert.deepEqual(result.state.pendingRequests, state.pendingRequests);
  assert.deepEqual(result.state.requestResponses, {});
});

test("Foundry reaction prompt dismissal remains cancellation and generic choice retains its ID response", async () => {
  const request = reactionRequest();
  const cancelled = await createFoundryV14PromptAdapter({DialogV2: {async input() { return null; }}}).request(request);
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.status, "cancelled");
  const generic = await createFoundryV14PromptAdapter({DialogV2: {async input() {
    return {"choice:choice": "candidate:A"};
  }}}).request({...request, type: "choice"});
  assert.deepEqual(generic.value, {choices: {choice: "candidate:A"}});
});
