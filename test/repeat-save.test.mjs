import {test} from "node:test";
import assert from "node:assert/strict";
import {repeatSaveGroups} from "../module/adapters/foundry-v14-automation-dispatcher.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {planStagedActionResolution, resumeStagedActionResolution} from "../module/resolvers/action-pipeline-resolver.mjs";
import {RESOLUTION_REQUEST_TYPES} from "../module/helpers/resolution-state.mjs";

const effect = (id, actionDefinitionId, sourceRef, repeatSave, extra={}) => ({id, name: "Hold Person", ...extra,
  flags: {wildpath: {conditionEffect: {sourceRef, metadata: {actionDefinitionId, ...(repeatSave ? {repeatSave} : {})}}}}});

test("the saves a creature repeats at a turn boundary: one per Action and source, ending all it let in", () => {
  const held = {timing: "turnEnd", ability: "wits", dc: 15};
  const groups = repeatSaveGroups([
    effect("paralyzed", "action:hold-person", "uuid:Actor.mage", held),
    effect("marker", "action:hold-person", "uuid:Actor.mage", held),
    effect("other-caster", "action:hold-person", "uuid:Actor.lich", {...held, dc: 18}),
    effect("start", "action:x", "uuid:Actor.mage", {...held, timing: "turnStart"}),
    effect("plain", "action:y", "uuid:Actor.mage", null),
    effect("off", "action:z", "uuid:Actor.mage", held, {disabled: true})], "turn.ended");
  assert.deepEqual(groups.map(group => [group.ability, group.dc, group.effectIds]),
    [["wits", 15, ["paralyzed", "marker"]], ["wits", 18, ["other-caster"]]]);
  assert.deepEqual(repeatSaveGroups([effect("start", "action:x", "s", {...held, timing: "turnStart"})], "turn.started")[0].effectIds, ["start"]);
  assert.deepEqual(repeatSaveGroups([effect("a", "b", "c", held)], "round.ended"), []);
});

test("an effect whose save repeats keeps the save it was let in by: its ability and the DC it resolved to", () => {
  const hold = {schemaVersion: 1, id: "action:hold", label: "Hold Person", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1}, save: {ability: "wits", dc: {value: 14}},
    effects: [{id: "effect-1", type: "condition", conditionId: "paralyzed", saveOutcomePolicy: "failure", repeatSave: "turnEnd"}]};
  assert.equal(validateActionDefinition(hold).ok, true);
  assert.equal(validateActionDefinition({...hold, effects: [{...hold.effects[0], repeatSave: "never"}]}).ok, false);
  const plan = planStagedActionResolution({id: "resolution:hold", actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
    action: {id: hold.id, type: "action", name: hold.label, system: {definition: hold}}, source: {actorId: "actor-source"},
    targets: [{id: "orc", actorId: "actor-orc", tokenId: "token-orc", disposition: "enemy"}]});
  const request = plan.state.pendingRequests[0];
  const done = resumeStagedActionResolution({state: plan.state, response: {resolutionId: plan.state.id, requestId: request.id,
    type: RESOLUTION_REQUEST_TYPES.ROLL, value: {requestId: request.payload.rollRequest.id, resolutionId: plan.state.id,
      type: request.payload.rollRequest.type, natural: 3, total: 3}}});
  const condition = done.state.mutationPlans.find(entry => entry.type === "conditionEffect");
  assert.deepEqual(condition?.metadata?.repeatSave, {timing: "turnEnd", ability: "wits", dc: 14});
});

test("Bardic Inspiration: a failed save may add the die, which can turn it into a success, and ends the effect", async () => {
  const save = {schemaVersion: 1, id: "action:trip", label: "Trip", costs: {allOf: []}, targeting: {type: "single", required: true, count: 1},
    save: {ability: "might", dc: {value: 12}}, effects: [{id: "effect-1", type: "condition", conditionId: "prone", saveOutcomePolicy: "failure"}]};
  const ending = {type: "conditionEffect", conditionId: "custom:inspired", levels: -1, action: "delete", target: {id: "orc", tokenId: "token-orc"}};
  const offer = {own: true, chooser: "target-controller", label: "x",
    options: [{value: "add:inspired", addDice: {number: 1, faces: 8}, label: "Add Inspired (d8)", payment: ending}]};
  let state = planStagedActionResolution({id: "resolution:inspired", actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
    action: {id: save.id, type: "action", name: save.label, system: {definition: save}}, source: {actorId: "actor-source"},
    targets: [{id: "orc", actorId: "actor-orc", tokenId: "token-orc", disposition: "enemy"}],
    save: {inspirationByTarget: {"token-orc": offer}}}).state;
  const answer = value => {
    const request = state.pendingRequests[0];
    state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
      value: typeof value === "function" ? value(request) : value}}).state;
    return request;
  };
  answer(request => ({requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, natural: 8, total: 8}));
  const choice = answer("add:inspired");
  assert.equal(choice.type, "choice");
  const die = answer(request => ({requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, total: 5}));
  assert.equal(die.payload.rollRequest.formula, "1d8");
  assert.equal(state.results.saveResolution.results[0].success, true, "8 + 5 = 13 against DC 12");
  assert.ok(state.mutationPlans.some(plan => (plan.type === "conditionEffect") && (plan.conditionId === "custom:inspired")), "the effect ends");
  assert.equal(state.mutationPlans.some(plan => plan.conditionId === "prone"), false, "and no Prone");
});
