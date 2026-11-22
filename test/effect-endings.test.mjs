import {test} from "node:test";
import assert from "node:assert/strict";
import {effectEndings, endsOn} from "../module/helpers/effect-sources.mjs";
import {actionDefinitionToResolverInput, normalizeActionDefinition, validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {commonAction} from "../module/helpers/common-actions.mjs";
import {planStagedActionResolution, resumeStagedActionResolution} from "../module/resolvers/action-pipeline-resolver.mjs";
import {endEffectsWhenAttacked, endEffectsWhenChecked, endEffectsWhenDamaged, endEffectsWhenSaved}
  from "../module/resolvers/foundry-multiplayer-runtime.mjs";

const applied = (id, {definition, metadata}={}) => ({id, flags: {wildpath: {conditionEffect: {
  ...(definition ? {definition} : {}), ...(metadata ? {metadata} : {})}}}});
const holder = effects => {
  const deleted = [];
  return {deleted, actor: {effects, deleteEmbeddedDocuments: async (_type, ids) => deleted.push(...ids)}};
};

test("effectEndings reads an effect's own endsWhen and its metadata.endsWhen, as a string, a {when} or a list", () => {
  const effect = applied("e", {definition: {endsWhen: ["attacks", {when: "saves"}]}, metadata: {endsWhen: "damaged"}});
  assert.deepEqual(effectEndings(effect), [{when: "attacks"}, {when: "saves"}, {when: "damaged"}]);
  assert.deepEqual(effectEndings({type: "condition", metadata: {endsWhen: {when: "leavesArea"}}}), [{when: "leavesArea"}],
    "an Action definition's row");
  assert.deepEqual(effectEndings({type: "effect", endsWhen: "attacked", metadata: {endsWhen: ["sourceDies"]}}),
    [{when: "attacked"}, {when: "sourceDies"}]);
  assert.deepEqual(effectEndings({definition: {endsWhen: "hits"}, metadata: {}}), [{when: "hits"}], "a resolver entry");
  assert.deepEqual([effectEndings(null), effectEndings(applied("plain")), effectEndings({id: "x", flags: {}})], [[], [], []]);
  assert.deepEqual(endsOn(effect, "saves"), {when: "saves"});
  assert.equal(endsOn(effect, "checks"), null);
});

test("an effect's endings are validated in both places: one list, a {when} object, nothing else", () => {
  const help = commonAction({}, "help").system.definition;
  const row = help.effects[0];
  const prone = endsWhen => ({id: "p", type: "condition", conditionId: "prone", metadata: {endsWhen}});
  const valid = effects => validateActionDefinition({...help, effects});
  const paths = effects => valid(effects).errors.map(error => error.path);
  assert.equal(valid([{...row, endsWhen: ["attacked", {when: "damaged"}, "sourceDies"]}]).ok, true);
  assert.equal(valid([row, prone("damaged"), prone("leavesArea"), prone(["damaged", {when: "sourceDies"}])]).ok, true,
    "every value shipped data writes in metadata.endsWhen");
  // Until the areas adapter asks endsOn (A16), leavesArea is honoured only as a plain metadata string, so no other form passes.
  assert.deepEqual(paths([prone(["leavesArea", "sourceDies"]), prone({when: "leavesArea"}), {...row, endsWhen: "leavesArea"}]),
    ["effects.0.metadata.endsWhen.0", "effects.1.metadata.endsWhen", "effects.2.endsWhen"], "leavesArea only as a metadata string");
  assert.deepEqual(paths([prone("moved")]), ["effects.0.metadata.endsWhen"], "metadata.endsWhen is validated now");
  assert.deepEqual(paths([{...row, endsWhen: ["attacked", "moved", {when: "saves", feet: 5}, {}]}]),
    ["effects.0.endsWhen.1", "effects.0.endsWhen.2", "effects.0.endsWhen.3"], "an unknown ending, a key no ending reads, no when");
  assert.deepEqual(paths([{...row, endsWhen: {when: "acts"}}]), ["effects.0.endsWhen"]);
  // The list reaches the applied effect's definition, kept whole.
  const definition = normalizeActionDefinition({...help, effects: [{...row, endsWhen: ["attacked", {when: "saves"}]}]});
  assert.deepEqual(definition.effects[0].endsWhen, ["attacked", {when: "saves"}]);
  const [entry] = actionDefinitionToResolverInput(definition).effects.conditions;
  assert.deepEqual(Object.values(entry.conditionDefinitions)[0].endsWhen, ["attacked", {when: "saves"}]);
});

test("each ending reader finds its ending in a list, in either place", async () => {
  const scene = actor => ({tokens: {get: id => (id === "t" ? {actor} : null)}});
  const saved = holder([applied("saves", {definition: {endsWhen: ["attacked", {when: "saves"}]}}), applied("attacked", {definition: {endsWhen: "attacked"}})]);
  const saveState = {source: {tokenRef: "Scene.s.Token.c"}, results: {saveResolution: {results: [{ok: true, target: {tokenId: "t"}}]}}};
  assert.deepEqual(await endEffectsWhenSaved({state: saveState}, {fromUuid: async () => ({parent: scene(saved.actor)})}), ["saves"]);

  const damaged = holder([applied("own", {definition: {endsWhen: ["damaged"]}}), applied("meta", {metadata: {endsWhen: ["leavesArea", "damaged"]}}),
    applied("spared", {metadata: {endsWhen: ["damaged"], resolutionIds: ["now"]}})]);
  const damageState = {id: "now", mutationPlans: [{type: "durabilityDamage", target: {uuid: "Scene.s.Token.t"}, plan: {ok: true, amount: 3}}]};
  assert.deepEqual(await endEffectsWhenDamaged({state: damageState}, {fromUuid: async () => ({actor: damaged.actor})}), ["own", "meta"]);

  const checked = holder([{...applied("assist", {definition: {endsWhen: [{when: "checks"}]}}),
    system: {ruleElements: [{type: "RollMode", data: {domains: ["check.stealth"]}}]}}]);
  assert.deepEqual(await endEffectsWhenChecked(checked.actor, {ability: "agility", skill: "stealth"}), ["assist"]);

  const target = holder([applied("distracted", {metadata: {endsWhen: ["attacked"]}})]);
  const attacker = holder([applied("sap", {definition: {endsWhen: ["saves", "attacks"]}}), applied("coat", {definition: {endsWhen: [{when: "hits"}]}})]);
  const attackState = {source: {tokenRef: "Scene.s.Token.a"}, results: {attackResolution: {results: [{ok: true, hit: false, target: {tokenId: "t"}}]}}};
  await endEffectsWhenAttacked({state: attackState}, {fromUuid: async () => ({parent: scene(target.actor), actor: attacker.actor})});
  assert.deepEqual([target.deleted, attacker.deleted], [["distracted"], ["sap"]], "a miss spends attacks, not hits");
});

test("a condition with any ending in its metadata remembers the resolution that applied it, so that Action never ends it", () => {
  const shove = {schemaVersion: 1, id: "action:shove", label: "Shove", costs: {allOf: []}, targeting: {type: "single", required: true, count: 1},
    save: {ability: "fortitude", dc: {value: 12}}, effects: [
      {id: "effect-1", type: "condition", conditionId: "prone", saveOutcomePolicy: "failure", metadata: {endsWhen: ["attacked"]}},
      {id: "effect-2", type: "condition", conditionId: "poisoned", saveOutcomePolicy: "failure"}]};
  assert.equal(validateActionDefinition(shove).ok, true);
  let state = planStagedActionResolution({id: "resolution:shove", actorSystem: {resources: {}, pools: []},
    action: {id: shove.id, type: "action", name: shove.label, system: {definition: shove}}, source: {actorId: "actor-source"},
    targets: [{id: "fighter", actorId: "actor-fighter", tokenId: "token-fighter", disposition: "enemy"}]}).state;
  const request = state.pendingRequests[0];
  state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
    value: {requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, natural: 2, total: 2}}}).state;
  const stamped = Object.fromEntries(state.mutationPlans.filter(entry => entry.conditionId)
    .map(entry => [entry.conditionId, entry.metadata?.resolutionIds ?? null]));
  assert.deepEqual(stamped, {prone: ["resolution:shove"], poisoned: null});
});
