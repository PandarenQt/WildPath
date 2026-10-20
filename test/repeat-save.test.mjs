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

test("Tactical Mind: a failed check may add 1d10 from Second Wind, spent only when the check then succeeds", async () => {
  const {withTacticalMind} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const fighter = level => ({pools: [{id: "second-wind", value: 2, max: 2}], classes: [{id: "fighter", level}], resources: {}});
  const roller = {uuid: "Actor.fighter", name: "Fighter"};
  assert.equal(withTacticalMind(null, roller, fighter(1), null), null, "fighter level 2");
  assert.equal(withTacticalMind(null, roller, {...fighter(2), pools: [{id: "second-wind", value: 0, max: 2}]}, null), null, "a use left");
  const offer = withTacticalMind(null, roller, fighter(2), null);
  assert.deepEqual([offer.options[0].addDice, offer.options[0].refundOnFail], [{number: 1, faces: 10}, true]);
  const definition = {schemaVersion: 1, id: "action:climb", label: "Climb", costs: {allOf: []}, targeting: {type: "self"},
    check: {skill: "athletics", ability: "might", dc: {value: 15}}};
  const run = die => {
    let state = planStagedActionResolution({id: `resolution:tactical-${die}`, actorSystem: fighter(2),
      action: {id: definition.id, type: "action", name: definition.label, system: {definition}}, source: {actorId: "actor-fighter"},
      check: {modifier: 2, inspiration: offer}}).state;
    const answer = value => {
      const request = state.pendingRequests[0];
      state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
        value: typeof value === "function" ? value(request) : value}}).state;
    };
    answer(request => ({requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, die: 8}));
    answer(offer.options[0].value);
    answer(request => ({requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, total: die}));
    return state;
  };
  const succeeded = run(6);
  assert.equal(succeeded.results.checkResolution.success, true, "10 + 6 = 16 against DC 15");
  assert.ok(succeeded.mutationPlans.some(plan => (plan.type === "resourcePayment") && (plan.payerRef === "Actor.fighter")), "the use is spent");
  const failed = run(2);
  assert.equal(failed.results.checkResolution.success, false, "10 + 2 = 12");
  assert.equal(failed.mutationPlans.some(plan => plan.payerRef === "Actor.fighter"), false, "the use is kept");
});

test("test offers (SRD): Peerless Skill's Bardic Inspiration die on a check or attack, Dark One's Own Luck's d10 on a check or save", async () => {
  const fs = await import("node:fs");
  const {withTestOffers} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const feature = file => {
    const item = JSON.parse(fs.readFileSync(`packs/_source/srd-items/${file}.json`, "utf8"));
    return {id: item._id, name: item.name, flags: item.flags, system: item.system};
  };
  const system = {classes: [{id: "bard", level: 10}], resources: {},
    pools: [{id: "bardic-inspiration", value: 1, max: 4}, {id: "dark-one-s-own-luck", value: 0, max: 2}]};
  const roller = {uuid: "Actor.hero", name: "Hero", items: [feature("peerless-skill-phbbrdPeerlessSk"), feature("dark-one-s-own-luck-phbwlkDarkOnesOw")]};
  const offer = withTestOffers(null, roller, system, null, "attack");
  assert.deepEqual(offer.options.map(option => [option.addDice.faces, option.refundOnFail]), [[10, true]], "a d10 at bard 10; no luck left");
  assert.equal(withTestOffers(null, roller, system, null, "save"), null, "Peerless Skill is no save's");
  const lucky = withTestOffers(null, roller, {...system, pools: [{id: "dark-one-s-own-luck", value: 1, max: 2}]}, null, "save");
  assert.deepEqual(lucky.options.map(option => option.addDice.faces), [10]);
});

test("zeroHpFor (SRD Relentless Rage): while raging, DC 10 + 5 a use spent, 2x its barbarian level, a use paid", async () => {
  const fs = await import("node:fs");
  const {zeroHpFor} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const item = JSON.parse(fs.readFileSync("packs/_source/srd-items/relentless-rage-phbbrbRelentless.json", "utf8"));
  const barbarian = (statuses, value) => ({uuid: "Actor.barb", statuses: new Set(statuses),
    items: [{id: item._id, name: item.name, system: item.system}]});
  const system = value => ({classes: [{id: "barbarian", level: 11}], resources: {}, pools: [{id: "relentless-rage", value, max: 20}]});
  assert.equal(zeroHpFor(barbarian([], 20), system(20)), null, "not raging");
  const first = zeroHpFor(barbarian(["raging"]), system(20));
  assert.deepEqual([first.mode, first.dc, first.hitPoints, first.payment.payerRef], ["save", 10, 22, "Actor.barb"]);
  assert.equal(zeroHpFor(barbarian(["raging"]), system(18)).dc, 20, "two uses spent");
});
