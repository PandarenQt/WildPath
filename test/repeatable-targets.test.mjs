import {test} from "node:test";
import assert from "node:assert/strict";
import {RESOLUTION_REQUEST_TYPES, RESOLUTION_STATE_STATUS} from "../module/helpers/resolution-state.mjs";
import {planStagedActionResolution, resumeStagedActionResolution} from "../module/resolvers/action-pipeline-resolver.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {projectPendingRequestPayloadForChooser} from "../module/helpers/multiplayer-authority.mjs";
import {createFoundryV14PromptAdapter} from "../module/adapters/foundry-v14-prompt-adapter.mjs";

// Magic Missile's shape: three darts, each a separate hit, sent at one creature or several (`targeting.repeatable`).
const darts = {schemaVersion: 1, id: "action:darts", label: "Darts", tags: ["spell"], costs: {allOf: []},
  targeting: {type: "multiple", required: true, count: 3, repeatable: true,
  refinementPolicy: {minSelections: 1}}, damage: [{id: "dart", expression: {type: "constant", value: 3}, damageType: "force"}]};
const action = {id: darts.id, type: "action", name: darts.label, system: {definition: darts}};
const target = id => ({id, actorId: `actor-${id}`, tokenId: `token-${id}`, disposition: "enemy"});
const candidate = id => ({id, target: target(id), actor: {id: `actor-${id}`}, disposition: "enemy", kind: "creature"});
const health = value => ({resources: {health: {value, max: value}}, pools: []});
const plan = (id, names, extra={}) => planStagedActionResolution({id, actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []}, action,
  source: {actorId: "actor-caster", tokenId: "token-caster"}, targeting: {required: true, candidates: names.map(candidate)},
  durability: {targetSystems: Object.fromEntries(names.map(name => [`token-${name}`, health(30)]))}, ...extra});
const damagePlans = state => state.mutationPlans.filter(entry => entry.type === "durabilityDamage")
  .map(entry => [entry.target.tokenId, entry.plan.from, entry.plan.to]);

test("every dart at the one creature targeted: three hits, each its own damage and its own concentration check", () => {
  const waiting = plan("resolution:darts-one", ["orc"], {concentration: {states: {"token-orc": {concentrating: true, actorId: "actor-orc",
    sourceRef: "token:token-orc"}}, dependents: []}});
  assert.deepEqual(waiting.state.results.damageResolution.results.map(result => [result.target.tokenId, result.total]),
    [["token-orc", 3], ["token-orc", 3], ["token-orc", 3]], "one target took all three darts, not one");
  assert.deepEqual(damagePlans(waiting.state), [["token-orc", 30, 27], ["token-orc", 27, 24], ["token-orc", 24, 21]],
    "each hit builds on the last");
  let state = waiting.state;
  for ( let check = 0; check < 3; check++ ) {
    const request = state.pendingRequests[0];
    assert.equal(request?.payload.rollKind, "concentration", `concentration check ${check + 1}`);
    const roll = request.payload.rollRequest;
    state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: RESOLUTION_REQUEST_TYPES.ROLL,
      value: {requestId: roll.id, resolutionId: state.id, type: roll.type, natural: 15, total: 15}}}).state;
  }
  assert.equal(state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(state.errors));
});

test("as many creatures as darts: one each, without asking", () => {
  const done = plan("resolution:darts-three", ["orc", "goblin", "kobold"]);
  assert.equal(done.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(done.state.errors));
  assert.deepEqual(damagePlans(done.state), [["token-orc", 30, 27], ["token-goblin", 30, 27], ["token-kobold", 30, 27]]);
});

test("two creatures and three darts: its user shares them in the prompt, and only shares adding up to three resolve", async () => {
  const waiting = plan("resolution:darts-two", ["orc", "goblin"]);
  const request = waiting.state.pendingRequests[0];
  assert.equal(request.type, RESOLUTION_REQUEST_TYPES.TARGET_REFINEMENT, "how two creatures share three darts is asked");
  const chooser = projectPendingRequestPayloadForChooser(request.type, request.payload);
  assert.equal(chooser.targeting.refinementPolicy.instances, 3);
  assert.deepEqual(chooser.candidates.map(entry => [entry.id, entry.share]), [["orc", 2], ["goblin", 1]], "an even spread is offered first");

  let rendered = "";
  const prompt = createFoundryV14PromptAdapter({DialogV2: {input: async ({content}) => {
    rendered = content;
    return {"share:orc": 1, "share:goblin": 2};
  }}});
  const answer = await prompt.request({...request, payload: chooser}, {isGM: true});
  assert.equal((rendered.match(/type="number"/g) ?? []).length, 2, "a number for each creature, not a tick");
  assert.deepEqual(answer.value.decisions, [{operation: "select", targetId: "orc", count: 1},
    {operation: "select", targetId: "goblin", count: 2}]);
  const respond = value => resumeStagedActionResolution({state: waiting.state, response: {resolutionId: waiting.state.id,
    requestId: request.id, type: RESOLUTION_REQUEST_TYPES.TARGET_REFINEMENT, value}});
  const resumed = respond(answer.value);
  assert.equal(resumed.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(resumed.state.errors));
  assert.deepEqual(damagePlans(resumed.state), [["token-orc", 30, 27], ["token-goblin", 30, 27], ["token-goblin", 27, 24]]);
  assert.equal(respond({decisions: [{operation: "select", targetId: "orc", count: 1}, {operation: "select", targetId: "goblin", count: 1}]}).ok,
    false, "two darts of three");
  assert.equal(respond({decisions: [{operation: "select", targetId: "orc", count: 3}, {operation: "select", targetId: "goblin", count: 0}]}).ok,
    false, "a creature kept with no dart");
  const all = respond({decisions: [{operation: "select", targetId: "orc", count: 3}, {operation: "deselect", targetId: "goblin"}]});
  assert.deepEqual(damagePlans(all.state).map(([token]) => token), ["token-orc", "token-orc", "token-orc"], "all three at one of the two");
});

test("repeatable targets need no attack roll: one roll cannot stand for each hit", () => {
  assert.equal(validateActionDefinition(darts).ok, true);
  const rays = {...darts, attack: {type: "ranged", statistic: "spell", defenseKey: "ac"}};
  assert.deepEqual(validateActionDefinition(rays).errors.map(error => error.path), ["targeting.repeatable"]);
});

test("a reaction answers one dart: its reduction comes off one hit and its redirect moves one hit", () => {
  // Stone's Endurance's 2 off the orc's damage: the first dart deals 1, the other two their 3.
  const reduced = plan("resolution:darts-reduced", ["orc"], {durability: {targetSystems: {"token-orc": health(30)},
    reductionsByTarget: {"token-orc": [{id: "rider:stone", type: "flat", amount: 2}]}}});
  assert.deepEqual(damagePlans(reduced.state), [["token-orc", 30, 29], ["token-orc", 29, 26], ["token-orc", 26, 23]]);
  // Protective Bond's ally takes one dart instead; the orc keeps the other two.
  const redirected = plan("resolution:darts-redirected", ["orc"], {durability: {targetSystems: {"token-orc": health(30),
    "token-ally": health(30)}, redirectsByTarget: {"token-orc": {id: "ally", actorId: "actor-ally", tokenId: "token-ally"}}}});
  assert.deepEqual(damagePlans(redirected.state), [["token-ally", 30, 27], ["token-orc", 30, 27], ["token-orc", 27, 24]]);
});
