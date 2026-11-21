import {test} from "node:test";
import assert from "node:assert/strict";
import {WILDPATH} from "../module/config.mjs";
import {d20FormulaWith} from "../module/helpers/rolls.mjs";
import {rollModesFromRuleElements} from "../module/helpers/rule-elements.mjs";
import {startsConcentration, validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {planStagedActionResolution, resumeStagedActionResolution} from "../module/resolvers/action-pipeline-resolver.mjs";
import {commitConditionEffectMutationPlan} from "../module/resolvers/condition-effect-commit-resolver.mjs";
import {readFileSync} from "node:fs";
import {endBrokenConcentration, endConcentrationOnIncapacitation, endEarlierConcentration, endEffectsWhenSaved, endLostConcentration, endReplacedEffects, markCasterConcentration,
  sustainedEffects}
  from "../module/resolvers/foundry-multiplayer-runtime.mjs";

test("initiative rolls 2d20 with advantage or disadvantage and adds its Modifiers", () => {
  assert.equal(d20FormulaWith("1d20", {rollMode: "disadvantage", modifier: -4}), "2d20kl - 4");
  assert.equal(d20FormulaWith("1d20 + @abilities.agility.mod", {rollMode: "advantage"}), "2d20kh + @abilities.agility.mod");
  assert.equal(d20FormulaWith("1d20"), "1d20");
});

test("2024 Incapacitated: disadvantage on initiative, concentration ends, and Unconscious is also Prone", () => {
  for ( const id of ["stunned", "unconscious"] ) {
    assert.deepEqual(rollModesFromRuleElements([{ruleElements: WILDPATH.CONDITIONS[id].ruleElements}], {domains: ["initiative"]})
      .map(entry => entry.mode), ["disadvantage"], id);
    assert.equal(WILDPATH.CONDITIONS[id].endsConcentration, true, id);
  }
  assert.equal(WILDPATH.CONDITIONS.dead.endsConcentration, true);
  assert.deepEqual(WILDPATH.CONDITIONS.unconscious.implies, ["prone"]);
  assert.equal(WILDPATH.CONDITIONS.prone.endsConcentration, undefined, "Prone alone does not");
});

/** A creature holding `effects`; it records what it deletes. */
function holder(id, effects=[]) {
  return {id, uuid: `Actor.${id}`, effects, deleted: [],
    async deleteEmbeddedDocuments(type, ids) { this.deleted.push(...ids); }};
}
const sustained = (id, sourceRef) => ({id, uuid: `Effect.${id}`, flags: {wildpath: {conditionEffect: {concentration: {sourceRef}}}}});

test("a caster who becomes Incapacitated ends every effect it sustains, wherever it is, and nothing else", async () => {
  const caster = holder("caster", [sustained("marker", "token:caster-token")]);
  const ally = holder("ally", [sustained("blessed", "token:scene-a.caster-token"), sustained("hasted", "Actor.someone-else")]);
  const enemy = holder("enemy", [sustained("held", "Actor.caster")]);
  const scene = {id: "scene-a", tokens: [{id: "caster-token", uuid: "Scene.scene-a.Token.caster-token", actorLink: true,
    actorId: "caster", actor: caster, parent: null}]};
  scene.tokens[0].parent = scene;
  const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, actors: [caster, ally, enemy], scenes: [scene]};
  const ended = await endConcentrationOnIncapacitation({system: {type: "stunned"}, parent: caster}, game);
  assert.deepEqual(ended.sort(), ["Effect.blessed", "Effect.held", "Effect.marker"]);
  assert.deepEqual([caster.deleted, ally.deleted, enemy.deleted], [["marker"], ["blessed"], ["held"]]);
  assert.deepEqual(await endConcentrationOnIncapacitation({system: {type: "prone"}, parent: caster}, game), [],
    "a condition that does not incapacitate ends nothing");
});

test("a caster that failed the check to keep the concentration its Action started ends what it sustains once it completes", async () => {
  const caster = holder("caster", [sustained("wall-marker", "token:caster-token")]);
  const enemy = holder("enemy", [sustained("burning", "uuid:Actor.caster.Item.wall")]);
  const scene = {id: "scene-a", tokens: [{id: "caster-token", uuid: "Scene.scene-a.Token.caster-token", actorLink: true,
    actorId: "caster", actor: caster, parent: null}]};
  scene.tokens[0].parent = scene;
  const game = {actors: [caster, enemy], scenes: [scene]};
  const event = startedLost => ({options: {actor: caster},
    state: {results: {concentrationResolution: {checks: {}, endedEffects: 0, ...(startedLost ? {startedLost} : {})}}}});
  assert.deepEqual(await endLostConcentration(event(false), {game}), [], "kept");
  assert.deepEqual([caster.deleted, enemy.deleted], [[], []]);
  assert.deepEqual((await endLostConcentration(event(true), {game})).sort(), ["Effect.burning", "Effect.wall-marker"]);
  assert.deepEqual([caster.deleted, enemy.deleted], [["wall-marker"], ["burning"]]);
});

test("ends.concentration breaks its targets' concentration (with on, only failed saves), after the caster's own marker is made", async () => {
  const caster = holder("caster", []);
  caster.createEmbeddedDocuments = async (type, data) => {
    const made = data.map((source, index) => ({...source, id: `made-${index}`, uuid: `Effect.made-${index}`}));
    caster.effects.push(...made);
    return made;
  };
  const ally = holder("ally", [sustained("ally-bless", "token:ally-token")]);
  const enemy = holder("enemy", [sustained("caster-hold", "uuid:Actor.caster.Item.hold")]);
  for ( const actor of [caster, ally, enemy] ) actor.deleteEmbeddedDocuments = async function(type, ids) {
    this.deleted.push(...ids);
    this.effects = this.effects.filter(effect => !ids.includes(effect.id));
  };
  const token = (id, actor) => ({id, uuid: `Scene.scene-a.Token.${id}`, actorLink: true, actorId: actor.id, actor, parent: null});
  const tokens = [token("caster-token", caster), token("ally-token", ally), token("enemy-token", enemy)];
  const scene = {id: "scene-a", tokens: Object.assign(tokens, {get: id => tokens.find(entry => entry.id === id)})};
  for ( const entry of tokens ) entry.parent = scene;
  const game = {actors: [caster, ally, enemy], scenes: [scene], i18n: {format: (key, data) => `${key}:${data.area}`}};
  const fromUuid = async () => tokens[0];
  // Earthquake's save: the caster (its own ground) and the enemy fail, the ally makes it.
  const failed = id => ({ok: true, success: !["caster-token", "enemy-token"].includes(id), target: {tokenId: id}});
  const state = ends => ({source: {tokenRef: "Scene.scene-a.Token.caster-token", tokenId: "caster-token"},
    targets: tokens.map(entry => ({tokenId: entry.id})), results: {saveResolution: {results: tokens.map(entry => failed(entry.id))}},
    actionDefinition: {label: "Earthquake", save: {ability: "dexterity"}, concentration: {}, ends}});
  assert.deepEqual(await endBrokenConcentration({state: state({tags: ["curse"]})}, {fromUuid, game}), [], "no concentration key");
  // The runtime's own order: the marker the Action starts, then the break.
  await markCasterConcentration({options: {actor: caster}, state: state({concentration: true, on: "failure"})}, {game});
  assert.equal(caster.effects.length, 1, "its caster's marker");
  const ended = await endBrokenConcentration({state: state({concentration: true, on: "failure"})}, {fromUuid, game});
  assert.deepEqual(ended.sort(), ["Effect.caster-hold", "Effect.made-0"], "the caster loses the concentration it just started");
  assert.deepEqual([caster.deleted, ally.deleted, enemy.deleted], [["made-0"], [], ["caster-hold"]], "the ally saved: it keeps its own");
  assert.deepEqual(await endBrokenConcentration({state: state({concentration: true})}, {fromUuid, game}), ["Effect.ally-bless"],
    "without on, every target (the Tarrasque's)");
  const runtime = readFileSync(new URL("../module/resolvers/foundry-multiplayer-runtime.mjs", import.meta.url), "utf8");
  assert.ok(runtime.indexOf("await endBrokenConcentration(event") > runtime.indexOf("await markCasterConcentration(event"),
    "afterCompleted breaks it only after the marker exists");
});

test("a new concentration ends the caster's earlier one, as it stood when declared; a follow-up of the same spell does not", async () => {
  const mark = {effects: [{id: "mark", type: "effect", concentration: true}]};
  assert.equal(startsConcentration(mark), true, "a concentration effect");
  assert.equal(startsConcentration({area: {persistence: {concentration: true}}}), true, "a lasting concentration area");
  assert.equal(startsConcentration({summon: {actorRef: "x", concentration: true}}), true, "a concentration summon");
  assert.equal(startsConcentration({...mark, metadata: {followUp: true}}), false, "Move Mark continues the spell");
  assert.equal(startsConcentration({concentration: {}}), true, "a spell its caster concentrates on, sustaining nothing automated");
  assert.equal(startsConcentration({effects: [{id: "prone", type: "condition"}]}), false);

  const caster = holder("caster", [sustained("moonbeam-marker", "token:caster-token")]);
  // A spell's effect names its casting Item.
  const enemy = holder("enemy", [sustained("bane", "uuid:Actor.caster.Item.bane"), sustained("other", "Actor.someone-else")]);
  const scene = {id: "scene-a", tokens: [{id: "caster-token", uuid: "Scene.scene-a.Token.caster-token", actorLink: true,
    actorId: "caster", actor: caster, parent: null}]};
  scene.tokens[0].parent = scene;
  const game = {actors: [caster, enemy], scenes: [scene]};
  const snapshot = sustainedEffects(caster, game).map(({effect}) => effect.uuid);
  assert.deepEqual(snapshot.sort(), ["Effect.bane", "Effect.moonbeam-marker"]);
  const deleted = [];
  const documents = Object.fromEntries(snapshot.map(uuid => [uuid, {uuid, delete: async () => deleted.push(uuid)}]));
  const ended = await endEarlierConcentration({options: {endsConcentration: [...snapshot, "Effect.gone"]}},
    {fromUuid: async uuid => documents[uuid] ?? null});
  assert.deepEqual(ended.sort(), ["Effect.bane", "Effect.moonbeam-marker"], "what it sustained, not what this Action made");
  assert.deepEqual(deleted.sort(), ["Effect.bane", "Effect.moonbeam-marker"]);
});

test("a concentration spell recast on the creature holding its effect keeps what it refreshed; an old target's effect still ends", async () => {
  // Telekinesis's shape: Restrained on a failed save and a marker on its caster, both sustained by concentration.
  const hold = {schemaVersion: 1, id: "action:hold", label: "Hold", costs: {allOf: []}, targeting: {type: "single", required: true, count: 1},
    save: {ability: "fortitude", dc: {value: 15}}, effects: [
      {id: "effect-1", type: "condition", conditionId: "restrained", saveOutcomePolicy: "failure", concentration: true},
      {id: "effect-2", type: "effect", name: "Holding", appliesTo: "source", concentration: true, ruleElements: []}]};
  assert.equal(validateActionDefinition(hold).ok, true);
  const setPath = (document, path, value) => {
    const parts = path.split(".");
    let cursor = document;
    for ( const part of parts.slice(0, -1) ) cursor = (cursor[part] ??= {});
    cursor[parts.at(-1)] = structuredClone(value);
  };
  const run = async recastOn => {
    const creature = id => ({id, uuid: `Actor.${id}`, effects: []});
    const [caster, a, b] = ["caster", "a", "b"].map(creature);
    const actors = {caster, a, b};
    const game = {actors: [caster, a, b], scenes: []};
    let made = 0;
    const persistencePort = {
      async createEmbeddedDocuments({actor, documents}) {
        const created = documents.map(data => {
          const effect = {...structuredClone(data), id: `effect-${++made}`};
          Object.assign(effect, {uuid: `${actor.uuid}.ActiveEffect.${effect.id}`,
            async delete() { actor.effects.splice(actor.effects.indexOf(effect), 1); }});
          actor.effects.push(effect);
          return effect;
        });
        return {ok: true, result: created};
      },
      async updateDocument({document, updates}) {
        for ( const [path, value] of Object.entries(updates) ) setPath(document, path, value);
        return {ok: true};
      }
    };
    const cast = async (id, targetId) => {
      let state = planStagedActionResolution({id, actorSystem: {resources: {}, pools: []},
        action: {id: hold.id, uuid: "Actor.caster.Item.hold", type: "action", name: hold.label, system: {definition: hold}},
        source: {actorId: "caster"}, targets: [{id: targetId, actorId: targetId, tokenId: `token-${targetId}`, disposition: "enemy"}]}).state;
      const request = state.pendingRequests[0];
      state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
        value: {requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, natural: 3, total: 3}}}).state;
      for ( const plan of state.mutationPlans.filter(entry => entry.type === "conditionEffect") ) {
        const result = await commitConditionEffectMutationPlan((plan.conditionId === "restrained") ? actors[targetId] : caster, plan, {persistencePort});
        assert.equal(result.ok, true, result.reason);
      }
    };
    await cast("resolution:first", "a");
    const held = a.effects[0];
    // What the new cast's declaration records as the caster's earlier concentration.
    const endsConcentration = sustainedEffects(caster, game).map(({effect}) => effect.uuid);
    assert.equal(endsConcentration.length, 2);
    await cast("resolution:recast", recastOn);
    const all = Object.values(actors).flatMap(actor => actor.effects);
    const ended = await endEarlierConcentration({options: {endsConcentration}, state: {id: "resolution:recast"}},
      {fromUuid: async uuid => all.find(effect => effect.uuid === uuid) ?? null});
    return {ended, held, caster, a, b, sustained: sustainedEffects(caster, game).map(({holder, effect}) => `${holder.id}:${effect.flags.wildpath.conditionEffect.conditionId}`).sort()};
  };

  const same = await run("a");
  assert.deepEqual(same.ended, [], "the Restrained and the marker it refreshed in place are its own now");
  assert.equal(same.a.effects[0], same.held, "the same Restrained, refreshed");
  assert.deepEqual(same.sustained, ["a:restrained", "caster:action:hold:effect-2"], "and its new concentration still ends them");

  const other = await run("b");
  assert.deepEqual(other.ended, [other.held.uuid], "the old target's Restrained ends");
  assert.deepEqual([other.a.effects.length, other.b.effects.length, other.caster.effects.length], [0, 1, 1]);
  assert.deepEqual(other.sustained, ["b:restrained", "caster:action:hold:effect-2"]);
});

test("an effect that replaces its giver's earlier copies (Q64): a new use ends them anywhere, not another giver's nor one refreshed", async () => {
  // Blessing of the Trickster's shape: one creature, until its Long Rest, one at a time per cleric.
  const bless = {schemaVersion: 1, id: "action:blessing", label: "Blessing", costs: {allOf: []}, targeting: {type: "single", required: true, count: 1},
    effects: [{id: "effect-1", type: "effect", name: "Blessed", restsLeft: 1, replacesEarlier: true, ruleElements: []}]};
  assert.equal(validateActionDefinition(bless).ok, true);
  const setPath = (document, path, value) => {
    const parts = path.split(".");
    let cursor = document;
    for ( const part of parts.slice(0, -1) ) cursor = (cursor[part] ??= {});
    cursor[parts.at(-1)] = structuredClone(value);
  };
  const creature = id => ({id, uuid: `Actor.${id}`, documentName: "Actor", effects: [], async deleteEmbeddedDocuments(type, ids) {
    this.effects = this.effects.filter(effect => !ids.includes(effect.id));
  }});
  const actors = Object.fromEntries(["a", "b", "x", "y", "z"].map(id => [id, creature(id)]));
  const game = {actors: Object.values(actors), scenes: []};
  let made = 0;
  const persistencePort = {
    async createEmbeddedDocuments({actor, documents}) {
      const created = documents.map(data => ({...structuredClone(data), id: `effect-${++made}`, uuid: `${actor.uuid}.ActiveEffect.effect-${made}`}));
      actor.effects.push(...created);
      return {ok: true, result: created};
    },
    async updateDocument({document, updates}) {
      for ( const [path, value] of Object.entries(updates) ) setPath(document, path, value);
      return {ok: true};
    }
  };
  let uses = 0;
  // `cleric` blesses `target`; its afterCompleted ends what the blessing replaces (`definition`: another Action's shape).
  const give = async (cleric, target, definition=bless) => {
    const state = planStagedActionResolution({id: `resolution:${++uses}`, actorSystem: {resources: {}, pools: []},
      action: {id: definition.id, uuid: `Actor.${cleric}.Item.blessing`, type: "action", name: definition.label, system: {definition}},
      source: {actorId: cleric}, targets: [{id: target, actorId: target, tokenId: `token-${target}`, disposition: "ally"}]}).state;
    for ( const plan of state.mutationPlans.filter(entry => entry.type === "conditionEffect") ) {
      assert.equal((await commitConditionEffectMutationPlan(actors[target], plan, {persistencePort})).ok, true);
    }
    return endReplacedEffects({options: {actor: actors[cleric]}, state}, {game});
  };
  const held = () => Object.values(actors).flatMap(actor => actor.effects.map(effect => `${actor.id}:${effect.flags.wildpath.conditionEffect.sourceRef}`));

  assert.deepEqual(await give("a", "x"), [], "nothing earlier");
  assert.deepEqual(await give("b", "z"), [], "another cleric's first");
  const first = actors.x.effects[0];
  assert.deepEqual(await give("a", "y"), [first.uuid], "A's blessing on X ends once A blesses Y");
  assert.deepEqual(held().sort(), ["y:actor:a", "z:actor:b"], "B's on Z is its own");
  const onY = actors.y.effects[0];
  assert.deepEqual(await give("a", "y"), [], "blessing Y again refreshes it in place");
  assert.equal(actors.y.effects[0], onY);
  // Given where another cleric's is, it goes beside it, and that one stays once A's moves on (per caster).
  assert.deepEqual(await give("a", "z"), [onY.uuid]);
  assert.deepEqual(held().sort(), ["z:actor:a", "z:actor:b"], "beside B's, not B's taken over");
  const onZ = actors.z.effects.find(effect => effect.flags.wildpath.conditionEffect.sourceRef === "actor:a");
  assert.deepEqual(await give("a", "x"), [onZ.uuid]);
  assert.deepEqual(held().sort(), ["x:actor:a", "z:actor:b"], "Z keeps B's");
  // A use that gives none (its target saved) leaves the earlier one.
  const saved = {...bless, id: "action:blessing", save: {ability: "wits", dc: {value: 1}},
    effects: [{...bless.effects[0], saveOutcomePolicy: "failure"}]};
  const state = planStagedActionResolution({id: "resolution:saved", actorSystem: {resources: {}, pools: []},
    action: {id: saved.id, type: "action", name: saved.label, system: {definition: saved}}, source: {actorId: "a"},
    targets: [{id: "x", actorId: "x", tokenId: "token-x", disposition: "enemy"}]}).state;
  const request = state.pendingRequests[0];
  const done = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
    value: {requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, natural: 20, total: 20}}}).state;
  assert.equal(done.mutationPlans.some(plan => plan.type === "conditionEffect"), false, "X saved");
  assert.deepEqual(await endReplacedEffects({options: {actor: actors.a}, state: done}, {game}), []);
  assert.equal(actors.x.effects.length, 1, "X keeps A's blessing");
  // An effect without the key replaces nothing.
  const plain = {...bless, id: "action:plain", effects: [{...bless.effects[0], replacesEarlier: undefined}]};
  await give("a", "y", plain);
  await give("a", "z", plain);
  assert.equal(actors.y.effects.length, 1, "a plain effect stays on Y");
});

test("a stored cast (storedCast) is bound to the chosen spell and slot level, reaches its effect, and a new one ends the old", async () => {
  // Contingency's shape: a self effect for 10 days holding the chosen spell, a new copy on each cast that ends the old one.
  const slot = {id: "contingent-slot", type: "resource", label: "Slot", required: true, effects: [{type: "bindChoice"}],
    cost: {anyOf: [[{capability: "spell-slot.1", amount: 1}], [{capability: "spell-slot.2", amount: 1}]]},
    levelByResourceId: {"spell-slot.1": 1, "spell-slot.2": 2}};
  const contingency = {schemaVersion: 1, id: "action:contingency", label: "Contingency", costs: {allOf: []}, targeting: {type: "self"},
    configuration: [{id: "contingent", type: "select-one", label: "Spell", required: true, effects: [{type: "bindChoice"}],
      options: [{value: "cure-item", label: "Cure Wounds"}, {value: "shield-item", label: "Shield of Faith"}]}, slot],
    effects: [{id: "contingency", type: "effect", name: "Contingency", slug: "contingency", ruleElements: [],
      duration: {value: 10, units: "days"}, stack: "separate", replacesEarlier: true,
      storedCast: {action: "{{contingent}}", level: "{{contingent-slot}}"}}]};
  assert.equal(validateActionDefinition(contingency).ok, true);
  const refused = storedCast => validateActionDefinition({...contingency, effects: [{...contingency.effects[0], storedCast}]})
    .errors.some(entry => entry.path === "effects.0.storedCast");
  for ( const bad of ["cure-item", {level: 2}, {action: "", level: 2}, {action: "cure-item", level: 10}, {action: "cure-item", level: 1.5},
    {action: "cure-item", level: "2"}, {action: "cure-item"}] ) assert.equal(refused(bad), true, JSON.stringify(bad));
  assert.equal(refused({action: "cure-item", level: 0}), false, "a cantrip's level 0");

  const deletions = [];
  const caster = {id: "wizard", uuid: "Actor.wizard", documentName: "Actor", effects: [], async deleteEmbeddedDocuments(type, ids, options) {
    deletions.push(options);
    this.effects = this.effects.filter(effect => !ids.includes(effect.id));
  }};
  const game = {actors: [caster], scenes: []};
  let made = 0;
  const persistencePort = {async createEmbeddedDocuments({actor, documents}) {
    const created = documents.map(data => ({...structuredClone(data), id: `effect-${++made}`, uuid: `${actor.uuid}.ActiveEffect.effect-${made}`}));
    actor.effects.push(...created);
    return {ok: true, result: created};
  }};
  let uses = 0;
  const cast = async (spell, resourceId, {commit=true}={}) => {
    const id = `resolution:${++uses}`;
    const waiting = planStagedActionResolution({id, actorSystem: {resources: {action: {value: 1, max: 1}},
      pools: [{id: "spell-slot.1", value: 1, max: 1}, {id: "spell-slot.2", value: 1, max: 1}]},
    action: {id: contingency.id, uuid: "Actor.wizard.Item.contingency", type: "action", name: "Contingency", system: {definition: contingency}},
    source: {actorId: "wizard"}, targets: [{id: "wizard", actorId: "wizard", tokenId: "token-wizard", disposition: "ally"}]});
    const {state} = resumeStagedActionResolution({state: waiting.state, response: {resolutionId: id, requestId: `request:${id}:configuration`,
      type: waiting.state.pendingRequests[0].type, value: {choices: {contingent: spell, "contingent-slot": {resourceId}}}}});
    const plans = state.mutationPlans.filter(entry => entry.type === "conditionEffect");
    assert.equal(plans.length, 1, JSON.stringify(state.errors ?? state));
    if ( !commit ) return [];
    assert.equal((await commitConditionEffectMutationPlan(caster, plans[0], {persistencePort})).ok, true);
    return endReplacedEffects({options: {actor: caster}, state}, {game});
  };
  const stored = () => caster.effects.map(effect => [effect.id, effect.flags.wildpath.conditionEffect.definition.storedCast]);

  assert.deepEqual(await cast("cure-item", "spell-slot.2"), []);
  assert.deepEqual(stored(), [["effect-1", {action: "cure-item", level: 2}]], "the Item id and the slot's level, a number");
  assert.deepEqual(caster.effects[0].duration, {value: 10, units: "days"});
  assert.equal(caster.effects[0].flags.wildpath.conditionEffect.sourceRef, "actor:wizard", "its giver, whose Item the id is");
  const first = caster.effects[0];
  assert.deepEqual(await cast("shield-item", "spell-slot.1"), [first.uuid], "the earlier one ends");
  assert.deepEqual(stored(), [["effect-2", {action: "shield-item", level: 1}]], "the new copy, with its own record and its own clock");
  assert.deepEqual(deletions, [undefined], "ended as an ending, not NOT_ENDED");
  // A cast that never committed (cancelled) gave no new copy, so it ends nothing.
  assert.deepEqual(await cast("cure-item", "spell-slot.2", {commit: false}), []);
  assert.deepEqual(await endReplacedEffects({options: {actor: caster}, state: {id: `resolution:${uses}`, actionDefinition: contingency}}, {game}), []);
  assert.deepEqual(stored(), [["effect-2", {action: "shield-item", level: 1}]]);
});

test("a concentration spell sustaining nothing automated (Fog Cloud) marks its caster for its duration", async () => {
  const created = [];
  const actor = {async createEmbeddedDocuments(type, data) { created.push({type, data}); return data; }};
  const state = {actionDefinition: {label: "Fog Cloud", concentration: {duration: {value: 1, units: "hours"}}}, source: {tokenId: "caster-token"}};
  const game = {i18n: {format: (key, data) => `${key}:${data.area}`}};
  await markCasterConcentration({options: {actor}, state}, {game});
  assert.deepEqual(created, [{type: "ActiveEffect", data: [{name: "WILDPATH.AREA.Concentrating:Fog Cloud", type: "effect", system: {},
    duration: {value: 1, units: "hours"}, flags: {wildpath: {concentrationMarker: true,
      conditionEffect: {concentration: {sourceRef: "token:caster-token"}}}}}]}]);
  assert.equal(await markCasterConcentration({options: {actor}, state: {actionDefinition: {label: "Bless"}, source: {tokenId: "t"}}}, {game}), null,
    "nothing for an Action without it");
  assert.equal(created.length, 1);
});

test("an effect that ends when its creature saves (Staggering Blow) ends after an Action's save on it", async () => {
  const deleted = [];
  const staggered = {id: "staggered", flags: {wildpath: {conditionEffect: {definition: {endsWhen: "saves"}}}}};
  const other = {id: "other", flags: {wildpath: {conditionEffect: {definition: {}}}}};
  const actor = {effects: [staggered, other], async deleteEmbeddedDocuments(type, ids) { deleted.push(...ids); }};
  const scene = {tokens: {get: id => (id === "orc-token" ? {actor} : null)}};
  const state = {source: {tokenRef: "Scene.s.Token.caster"}, results: {saveResolution: {results: [{ok: true, success: true, target: {tokenId: "orc-token"}}]}}};
  assert.deepEqual(await endEffectsWhenSaved({state}, {fromUuid: async () => ({parent: scene})}), ["staggered"]);
  assert.deepEqual(deleted, ["staggered"]);
});

test("an effect that ends on a save against its source (Eldritch Strike) ends only on that creature's Action, not on one it just applied", async () => {
  const deleted = [];
  const knight = {uuid: "Actor.knight", id: "knight"};
  const marked = (id, sourceRef, resolutionIds=[]) => ({id, flags: {wildpath: {conditionEffect: {sourceRef, definition: {endsWhen: "savedBySource"},
    metadata: {resolutionIds}}}}});
  const actor = {effects: [marked("mine", "Actor.knight"), marked("theirs", "Actor.other"), marked("new", "Actor.knight", ["resolution:now"])],
    async deleteEmbeddedDocuments(type, ids) { deleted.push(...ids); }};
  const scene = {tokens: {get: id => (id === "orc-token" ? {actor} : null)}};
  const state = {id: "resolution:now", source: {tokenRef: "Scene.s.Token.knight"},
    results: {saveResolution: {results: [{ok: true, success: false, target: {tokenId: "orc-token"}}]}}};
  const previous = globalThis.game;
  globalThis.game = {scenes: []};
  try {
    assert.deepEqual(await endEffectsWhenSaved({state}, {fromUuid: async () => ({parent: scene, actor: knight})}), ["mine"]);
  } finally {
    globalThis.game = previous;
  }
  assert.deepEqual(deleted, ["mine"]);
});
