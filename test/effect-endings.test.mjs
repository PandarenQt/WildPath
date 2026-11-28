import {test} from "node:test";
import assert from "node:assert/strict";
import {effectEndings, endsOn} from "../module/helpers/effect-sources.mjs";
import {actionDefinitionToResolverInput, normalizeActionDefinition, validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {commonAction} from "../module/helpers/common-actions.mjs";
import {planStagedActionResolution, resumeStagedActionResolution} from "../module/resolvers/action-pipeline-resolver.mjs";
import {endEffectsOnActing, endEffectsWhenAttacked, endEffectsWhenChecked, endEffectsWhenDamaged, endEffectsWhenHealed,
  endEffectsWhenSaved} from "../module/resolvers/foundry-multiplayer-runtime.mjs";

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
  assert.deepEqual(paths([{...row, endsWhen: {when: "moves"}}]), ["effects.0.endsWhen"]);
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

// Invisibility's: "ends early immediately after the target makes an attack roll, deals damage, or casts a spell".
const INVISIBILITY = ["attacks", "damages", {when: "acts", actions: {tagsAny: ["cast"]}}];

test("an ending narrowed to some Actions (actions) matches only their tags, and validates as a predicate on an Action's ending", () => {
  const effect = applied("e", {metadata: {endsWhen: [{when: "acts", actions: {tagsAll: ["cast", "component:verbal"]}}]}});
  assert.deepEqual(endsOn(effect, "acts", ["spell", "cast", "component:verbal"]), {when: "acts", actions: {tagsAll: ["cast", "component:verbal"]}});
  assert.equal(endsOn(effect, "acts", ["spell", "cast", "component:somatic"]), null);
  assert.equal(endsOn(effect, "acts"), null, "without the acting Action's tags");
  assert.deepEqual(endsOn(applied("plain", {metadata: {endsWhen: "acts"}}), "acts"), {when: "acts"}, "an unnarrowed one needs none");

  const help = commonAction({}, "help").system.definition;
  const row = help.effects[0];
  const prone = endsWhen => ({id: "p", type: "condition", conditionId: "prone", metadata: {endsWhen}});
  const paths = effects => validateActionDefinition({...help, effects}).errors.map(error => error.path);
  assert.deepEqual(paths([{...row, endsWhen: [...INVISIBILITY, "forcesSave", {when: "healed", actions: {tagsAny: ["spell"]}},
    {when: "savedBySource", actions: {tagsAny: ["spell"]}}]}, prone(INVISIBILITY)]), [], "the new endings, narrowed or not, in both places");
  assert.equal(validateActionDefinition(commonAction({}, "hide").system.definition).ok, true, "the common Hide's");
  assert.deepEqual(paths([prone([{when: "checks", actions: {tagsAny: ["spell"]}}, {when: "sourceDies", actions: {}}]),
    {...row, endsWhen: [{when: "acts", actions: "cast"}, {when: "acts", actions: {spell: true}}]}]),
  ["effects.0.metadata.endsWhen.0", "effects.0.metadata.endsWhen.1", "effects.1.endsWhen.0.actions", "effects.1.endsWhen.1.actions"],
  "actions only on an ending an Action brings about (a sheet check has none), and only a predicate");
});

test("every Action ending reader honours actions: a save, damage and an attack narrowed to other Actions end nothing", async () => {
  const scene = actor => ({tokens: {get: id => (id === "t" ? {actor} : null)}});
  const saveState = tags => ({id: "now", source: {tokenRef: "Scene.s.Token.c"}, actionDefinition: {id: "x", tags},
    results: {saveResolution: {results: [{ok: true, target: {tokenId: "t"}}]}}});
  for ( const [tags, ended] of [[["spell"], ["strike"]], [["mastery"], []]] ) {
    const saved = holder([applied("strike", {definition: {endsWhen: {when: "saves", actions: {tagsAny: ["spell"]}}}})]);
    assert.deepEqual(await endEffectsWhenSaved({state: saveState(tags)}, {fromUuid: async () => ({parent: scene(saved.actor)})}), ended,
      `a save against ${tags} (Eldritch Strike is not spent by Topple)`);
  }
  for ( const [type, ended] of [["ranged", ["marked"]], ["melee", []]] ) {
    const damaged = holder([applied("marked", {metadata: {endsWhen: [{when: "damaged", actions: {tagsAny: ["attack:ranged"]}}]}})]);
    const state = {id: "now", actionDefinition: {id: "x", attack: {type}},
      mutationPlans: [{type: "durabilityDamage", target: {uuid: "Scene.s.Token.t"}, plan: {ok: true, amount: 3}}]};
    assert.deepEqual(await endEffectsWhenDamaged({state}, {fromUuid: async () => ({actor: damaged.actor})}), ended, `${type} damage`);
    const attacker = holder([applied("poised", {definition: {endsWhen: {when: "attacks", actions: {tagsAny: ["attack:melee"]}}}})]);
    const attackState = {id: "now", source: {tokenRef: "Scene.s.Token.a"}, actionDefinition: {id: "x", attack: {type}},
      results: {attackResolution: {results: [{ok: true, hit: true, target: {tokenId: "t"}}]}}};
    await endEffectsWhenAttacked({state: attackState}, {fromUuid: async () => ({parent: scene(holder([]).actor), actor: attacker.actor})});
    assert.deepEqual(attacker.deleted, (type === "melee") ? ["poised"] : [], `a ${type} attack`);
  }
});

test("an effect ends once its creature acts: damages another, makes another save, or uses an Action its ending names (acts)", async () => {
  const run = async (state, {used=true, ownUse=false, effects=[applied("invisible", {metadata: {endsWhen: INVISIBILITY}})]}={}) => {
    const caster = holder(effects);
    caster.actor.uuid = "Actor.caster";
    const documents = {"Scene.s.Token.c": {id: "c", actor: caster.actor}, "Scene.s.Token.o": {actor: {uuid: "Actor.other"}},
      "Scene.s.Token.self": {actor: caster.actor}};
    const ended = await endEffectsOnActing({state: {id: "now", source: {tokenRef: "Scene.s.Token.c"}, ...state}, used, ownUse},
      {fromUuid: async uuid => documents[uuid] ?? null});
    assert.deepEqual(ended, caster.deleted);
    return ended;
  };
  const strike = {id: "strike", tags: ["weapon"]};
  const bolt = {id: "bolt", tags: ["spell"]};
  const damage = (uuid, plan={amount: 4}) => [{type: "durabilityDamage", target: {uuid}, plan: {ok: true, ...plan}}];
  assert.deepEqual(await run({actionDefinition: strike, mutationPlans: damage("Scene.s.Token.o")}), ["invisible"], "damage to another");
  assert.deepEqual(await run({actionDefinition: strike, mutationPlans: damage("Scene.s.Token.o", {amount: 0, temporary: {from: 5, to: 1}})}),
    ["invisible"], "Temporary Hit Points lost count (Q23)");
  assert.deepEqual(await run({actionDefinition: strike, mutationPlans: damage("Scene.s.Token.self")}), [], "its own damage is not");
  assert.deepEqual(await run({actionDefinition: strike, mutationPlans: damage("Scene.s.Token.o", {amount: 0})}), [], "no damage dealt");
  assert.deepEqual(await run({actionDefinition: bolt}), ["invisible"], "a spell cast it used");
  assert.deepEqual(await run({actionDefinition: bolt}, {used: false}), [], "an area's or a Trigger's run casts nothing");
  assert.deepEqual(await run({actionDefinition: bolt}, {used: false, ownUse: true}), ["invisible"],
    "a spell its own Action used (uses) is cast by it");
  assert.deepEqual(await run({actionDefinition: bolt, mutationPlans: damage("Scene.s.Token.o")}, {used: false}), ["invisible"],
    "but the damage of its automatic runs counts (Q152 (a) default)");
  assert.deepEqual(await run({actionDefinition: {...bolt, metadata: {followUp: true}}}), [], "a spell's follow-up (moving Moonbeam) is no cast");
  assert.deepEqual(await run({actionDefinition: bolt}, {effects: [applied("invisible", {metadata: {endsWhen: INVISIBILITY, resolutionIds: ["now"]}})]}),
    [], "the cast that made it Invisible");
  const save = tokenId => ({saveResolution: {results: [{ok: false, target: {tokenId}}]}});
  const ward = () => [applied("ward", {definition: {endsWhen: "forcesSave"}})];
  assert.deepEqual(await run({actionDefinition: strike, results: save("o")}, {effects: ward()}), ["ward"], "another creature's save");
  assert.deepEqual(await run({actionDefinition: strike, results: save("c")}, {effects: ward()}), [], "its own save");
  // A move reaches afterCompleted too (used, no ActionDefinition): it is no Action, so "until it acts" stays.
  const stance = () => [applied("stance", {metadata: {endsWhen: ["acts", {when: "acts", actions: {notTagsAny: ["spell"]}}]}})];
  assert.deepEqual(await run({}, {effects: stance()}), [], "a move");
  assert.deepEqual(await run({actionDefinition: strike}, {effects: stance()}), ["stance"], "an Action");
});

test("a countered cast is still cast: a Verbal one ends Hide's Invisible (acts, with counteredCastEvent's tags), a Somatic one does not", async () => {
  const {afterActionCancelled} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const [row] = commonAction({}, "hide").system.definition.effects;
  const cancelled = async (tags, used=true) => {
    const rogue = holder([applied("hidden", {metadata: row.metadata})]);
    const system = {resources: {}, pools: []};
    const actor = {...rogue.actor, system, toObject: () => ({system: structuredClone(system)})};
    await afterActionCancelled({resolutionId: "bolt:1", used, options: {actor}, state: {id: "bolt:1", source: {tokenRef: "Scene.s.Token.r"},
      warnings: [{code: "COUNTERED", reason: "Counterspell stopped it."}], actionDefinition: {id: "bolt", tags, costs: {allOf: []}},
      mutationPlans: [{type: "durabilityDamage", target: {uuid: "Scene.s.Token.o"}, plan: {ok: true, amount: 4}}]}},
    {game: {}, fromUuid: async uuid => (uuid === "Scene.s.Token.r" ? {id: "r", actor} : {actor: {uuid: "Actor.other"}})});
    return rogue.deleted;
  };
  assert.deepEqual(await cancelled(["spell", "component:verbal"]), ["hidden"]);
  assert.deepEqual(await cancelled(["spell", "component:somatic"]), [], "a silent cast");
  assert.deepEqual(await cancelled(["spell", "component:verbal"], false), [], "not for a Trigger's run");
});

test("the common Hide's Invisible ends on an attack roll or a spell with a Verbal component, not a silent one", async () => {
  const [row] = commonAction({}, "hide").system.definition.effects;
  const hidden = () => {
    const rogue = holder([applied("hidden", {metadata: row.metadata})]);
    rogue.actor.uuid = "Actor.rogue";
    return rogue;
  };
  for ( const [tags, ended] of [[["spell", "component:verbal"], ["hidden"]], [["spell", "component:somatic"], []], [["component:verbal"], []]] ) {
    const rogue = hidden();
    const state = {id: "later", source: {tokenRef: "Scene.s.Token.r"}, actionDefinition: {id: "x", tags}};
    assert.deepEqual(await endEffectsOnActing({state}, {fromUuid: async () => ({id: "r", actor: rogue.actor})}), ended, String(tags));
  }
  const rogue = hidden();
  const attackState = {id: "later", source: {tokenRef: "Scene.s.Token.r"}, actionDefinition: {id: "shot", attack: {type: "ranged"}},
    results: {attackResolution: {results: [{ok: true, hit: false, target: {tokenId: "t"}}]}}};
  await endEffectsWhenAttacked({state: attackState}, {fromUuid: async () => ({parent: {tokens: {get: () => ({actor: holder([]).actor})}},
    actor: rogue.actor})});
  assert.deepEqual(rogue.deleted, ["hidden"], "a missed attack roll");
});

test("an effect ends once an Action restores Hit Points to its creature, narrowed to spells (healed)", async () => {
  const run = async (tags, plan={}, metadata={}) => {
    const devil = holder([applied("wound", {metadata: {endsWhen: {when: "healed", actions: {tagsAny: ["spell"]}}, ...metadata}})]);
    const state = {id: "now", actionDefinition: {id: "heal", tags},
      mutationPlans: [{type: "durabilityHealing", target: {uuid: "Scene.s.Token.t"}, plan: {ok: true, appliedAmount: 5, ...plan}}]};
    return endEffectsWhenHealed({state}, {fromUuid: async () => ({actor: devil.actor})});
  };
  assert.deepEqual(await run(["spell"]), ["wound"], "a spell's healing");
  assert.deepEqual(await run(["potion"]), [], "a potion is no spell");
  assert.deepEqual(await run(["spell"], {appliedAmount: 0, temporary: {from: 0, to: 8}}), [], "Temporary Hit Points heal nothing");
  assert.deepEqual(await run(["spell"], {appliedAmount: 0}), [], "nothing restored");
  assert.deepEqual(await run(["spell"], {}, {resolutionIds: ["now"]}), [], "the Action that gave it");
});
