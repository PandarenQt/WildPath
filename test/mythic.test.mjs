import {test} from "node:test";
import assert from "node:assert/strict";

// Only the globals needed to import the real Actor class; no Foundry schema emulation.
globalThis.Actor = class {};
globalThis.foundry = {
  data: {fields: {}, ActiveEffectTypeDataModel: class {}},
  utils: {isEmpty: value => Object.keys(value).length === 0, escapeHTML: value => String(value).replace(/</gu, "&lt;")}
};
Math.clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const {default: WildPathActor} = await import("../module/documents/actor.mjs");
const {evaluateRuleElement} = await import("../module/helpers/rule-elements.mjs");
const {zeroHpFor, beginPhase} = await import("../module/adapters/foundry-v14-zero-hp.mjs");
const {planStagedActionResolution} = await import("../module/resolvers/action-pipeline-resolver.mjs");

// A synthetic test creature (no book content): a feature whose Phase restores its Hit Point maximum, once, and an
// Action tagged `mythic` that waits for that phase.
const PHASE = {schemaVersion: 1, id: "phase", type: "Phase",
  data: {on: "zero-hp", restore: {type: "resource-max", resource: "health"}, once: true, flag: "mythicPhase"}};
const rising = {id: "rising", name: "Test Rising", type: "feature", system: {ruleElements: [PHASE]}};
const surge = {id: "action:surge", label: "Test Surge", tags: ["mythic"], costs: {allOf: [{capability: "legendary", amount: 1}]}};
const swipe = {id: "action:swipe", label: "Test Swipe", tags: [], costs: {allOf: [{capability: "legendary", amount: 1}]}};
const titan = (wildpath={}) => {
  const actor = Object.assign(Object.create(WildPathActor.prototype), {id: "titan", uuid: "Actor.titan", name: "Test Titan",
    items: [rising], effects: [], statuses: new Set(), flags: {wildpath}, system: {resources: {health: {value: 12, max: 40}}}});
  actor.allApplicableEffects = () => [];
  return actor;
};

test("a Phase begins on zero-hp and needs the Hit Points it restores; its flag is the one the mythic Forbid reads", () => {
  assert.equal(evaluateRuleElement(PHASE).ok, true);
  assert.equal(evaluateRuleElement({...PHASE, data: {...PHASE.data, on: "turn-start"}}).ok, false, "only zero-hp");
  assert.equal(evaluateRuleElement({...PHASE, data: {on: "zero-hp"}}).ok, false, "no restore");
  assert.equal(evaluateRuleElement({...PHASE, data: {...PHASE.data, flag: "a.b"}}).ok, false, "not a path");
  assert.equal(evaluateRuleElement({...PHASE, data: {...PHASE.data, flag: "otherPhase"}}).ok, false, "a flag nothing reads");
  assert.equal(evaluateRuleElement({...PHASE, data: {on: "zero-hp", restore: 1}}).ok, true, "mythicPhase by default");
});

test("zeroHpFor reads a Phase: its creature rises with its restore, naming the flag to set, once", () => {
  const actor = titan();
  assert.deepEqual(zeroHpFor(actor, actor.system), {name: "Test Rising", mode: "set", hitPoints: 40, flag: "mythicPhase",
    actorUuid: "Actor.titan"});
  const risen = titan({mythicPhase: true});
  assert.equal(zeroHpFor(risen, risen.system), null, "its phase already began");
  const again = {...rising, system: {ruleElements: [{...PHASE, data: {...PHASE.data, once: false}}]}};
  assert.equal(zeroHpFor({...risen, items: [again]}, risen.system)?.hitPoints, 40, "not once: it rises every time");
});

test("a Phase on an effect keeps its effect (unlike Death Ward, which ends): it names no effect to delete", () => {
  const actor = Object.assign(titan(), {items: [], effects: [{uuid: "Actor.titan.ActiveEffect.mythic", name: "Test Rising",
    disabled: false, system: {ruleElements: [PHASE]}}]});
  const rule = zeroHpFor(actor, actor.system);
  assert.equal(rule?.flag, "mythicPhase");
  assert.equal(rule.effectUuid, undefined);
});

test("damage dropping it to 0 leaves it at its restore instead; the record names the phase to begin", () => {
  const actor = titan();
  const blast = {schemaVersion: 1, id: "action:blast", label: "Blast", costs: {allOf: []}, targeting: {type: "single", required: true, count: 1},
    damage: [{id: "blast", expression: {type: "constant", value: 20}, damageType: "force"}]};
  const state = planStagedActionResolution({id: "resolution:mythic", actorSystem: {resources: {}, pools: []},
    action: {id: blast.id, type: "action", name: blast.label, system: {definition: blast}}, source: {actorId: "actor-source"},
    targets: [{id: "titan", actorId: "actor-titan", tokenId: "token-titan", disposition: "enemy"}],
    durability: {targetSystems: {"actor:actor-titan": {resources: {health: {value: 12, max: 40}}}},
      zeroHpByTarget: {"token-titan": zeroHpFor(actor, actor.system)}}}).state;
  assert.equal(state.mutationPlans.find(entry => entry.type === "durabilityDamage").plan.to, 40);
  const record = state.results.zeroHp[0];
  assert.deepEqual([record.kept, record.name, record.flag, record.actorUuid], [true, "Test Rising", "mythicPhase", "Actor.titan"]);
});

test("its mythic actions are forbidden, with the reason, until the phase begins; its others never are", () => {
  assert.equal(titan().forbiddingRule(surge)?.reason, "WILDPATH.REFUSAL.Mythic");
  assert.equal(titan().forbiddingRule(swipe), null);
  assert.equal(titan({mythicPhase: true}).forbiddingRule(surge), null);
});

test("beginPhase sets its flag and tells everyone, escaped", async () => {
  const flags = [];
  const posted = [];
  globalThis.ChatMessage = {create: async data => posted.push(data)};
  const actor = {name: "Test <Titan>", setFlag: async (scope, key, value) => flags.push([scope, key, value])};
  const game = {i18n: {format: (key, data) => `${key}|${data.name}|${data.feature}`}};
  await beginPhase(actor, {name: "Test Rising", flag: "mythicPhase"}, {game});
  assert.deepEqual(flags, [["wildpath", "mythicPhase", true]]);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].whisper, undefined, "a public line");
  assert.equal(posted[0].content, "<p>WILDPATH.NOTIFY.PhaseBegan|Test &lt;Titan>|Test Rising</p>");
  await beginPhase(actor, {name: "Relentless Endurance"}, {game});
  assert.equal(flags.length, 1, "a rule with no flag begins nothing");
  delete globalThis.ChatMessage;
});
