import {test} from "node:test";
import assert from "node:assert/strict";
import {RESOLUTION_REQUEST_TYPES, RESOLUTION_STATE_STATUS} from "../module/helpers/resolution-state.mjs";
import {planStagedActionResolution, resumeStagedActionResolution} from "../module/resolvers/action-pipeline-resolver.mjs";
import {createPhysicalDiceProvider, executeRollRequest} from "../module/resolvers/roll-provider-resolver.mjs";
import {createPromptViewModel} from "../module/helpers/prompt-view-models.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {discoverActionConfigurationChoices, resolveActionConfiguration} from "../module/helpers/action-configuration.mjs";
import {resolveActionEffects} from "../module/resolvers/action-resolver.mjs";
import {projectPendingRequestPayloadForChooser} from "../module/helpers/multiplayer-authority.mjs";

// Prismatic Spray's shape: a d8 for each creature picks its ray; Indigo and Violet are effects, 8 is two more rolls.
const colors = [["red", "fire"], ["orange", "acid"], ["yellow", "lightning"], ["green", "poison"], ["blue", "cold"]];
const spray = (draw={perTarget: true}) => ({schemaVersion: 1, id: "action:spray", label: "Spray", tags: ["spell"], costs: {allOf: []},
  targeting: {type: "multiple", required: true, count: 3, refinementPolicy: {minSelections: 1}}, save: {ability: "agility", dc: {value: 15}},
  damage: colors.map(([, type]) => ({id: `damage-1-${type}`, expression: {type: "dice", number: 2, faces: 6}, damageType: type,
    saveOutcomePolicy: {success: "half", failure: "full"}})),
  effects: [{id: "effect-1", type: "condition", conditionId: "restrained", saveOutcomePolicy: "failure"},
    {id: "effect-2", type: "condition", conditionId: "blinded", saveOutcomePolicy: "failure"}],
  configuration: [{id: "drawn", type: "option", label: "Rays", required: true,
    options: [...colors.map(([color], index) => ({id: color, label: color, range: [index + 1, index + 1]})),
      {id: "indigo", label: "Indigo", range: [6, 6]}, {id: "violet", label: "Violet", range: [7, 7]},
      {id: "special", label: "Special", range: [8, 8], again: 2}],
    effects: [{type: "keepEffect", effectIds: [...colors.map(([, type]) => `damage-1-${type}`), "effect-1", "effect-2"],
      keep: {...Object.fromEntries(colors.map(([color, type]) => [color, [`damage-1-${type}`]])), indigo: ["effect-1"],
        violet: ["effect-2"], special: []}}]}],
  draw: {choiceId: "drawn", formula: "1d8", ...draw}});
const target = id => ({id, actorId: `actor-${id}`, tokenId: `token-${id}`, name: id, disposition: "enemy"});
const candidate = id => ({id, target: target(id), actor: {id: `actor-${id}`}, disposition: "enemy", kind: "creature"});
const health = value => ({resources: {health: {value, max: value}}, pools: []});
const plan = (id, names, {definition=spray(), extra={}}={}) => planStagedActionResolution({id,
  actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
  action: {id: definition.id, type: "action", name: definition.label, system: {definition}},
  source: {actorId: "actor-caster", tokenId: "token-caster"}, targeting: {required: true, candidates: names.map(candidate)},
  durability: {targetSystems: Object.fromEntries(names.map(name => [`token-${name}`, health(60)]))}, ...extra});
const pendingIds = state => state.pendingRequests.map(entry => entry.id.replace(`request:${state.id}:`, ""));
const answer = (state, suffix, value) => {
  const request = state.pendingRequests.find(entry => entry.id === `request:${state.id}:${suffix}`);
  assert.ok(request, `${suffix} is asked for (pending: ${pendingIds(state)})`);
  const roll = request.payload.rollRequest;
  const resumed = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id,
    type: RESOLUTION_REQUEST_TYPES.ROLL, value: {requestId: roll.id, resolutionId: state.id, type: roll.type, ...value}}});
  assert.equal(resumed.ok, true, JSON.stringify(resumed.state.errors));
  return resumed.state;
};
// Every save fails, every damage roll is its dice's count.
const finish = state => {
  for ( let guard = 0; state.pendingRequests.length && (guard < 20); guard++ ) {
    const suffix = pendingIds(state)[0];
    state = answer(state, suffix, suffix.startsWith("damage-roll") ? {total: 7} : {natural: 2, total: 2});
  }
  return state;
};

test("Prismatic Spray's shape: each creature's d8 picks its ray, and only its ray's damage or condition reaches it", () => {
  let state = plan("resolution:spray", ["orc", "goblin", "kobold"]).state;
  assert.deepEqual(pendingIds(state), ["draw:token-orc"], "the caster rolls each creature's ray before anything else");
  state = answer(state, "draw:token-orc", {total: 1});
  state = answer(state, "draw:token-goblin", {total: 6});
  state = answer(state, "draw:token-kobold", {total: 8});
  state = answer(state, "draw:token-kobold:2", {total: 3});
  state = answer(state, "draw:token-kobold:3", {total: 8});
  assert.deepEqual(pendingIds(state), ["draw:token-kobold:4"], "an 8 among its two more rolls is rolled again");
  state = answer(state, "draw:token-kobold:4", {total: 2});
  assert.deepEqual(state.results.drawResolution.byTarget, {"token-orc": ["red"], "token-goblin": ["indigo"],
    "token-kobold": ["special", "yellow", "orange"]});
  state = finish(state);
  assert.equal(state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(state.errors));
  const rolled = state.rollRequests.filter(request => request.metadata?.rollKind === "damage").map(request => request.metadata.componentId);
  assert.deepEqual(rolled.sort(), ["damage-1-acid", "damage-1-fire", "damage-1-lightning"], "no die for a color nobody drew (Green, Blue)");
  const damage = Object.fromEntries(state.results.damageResolution.results.map(result => [result.target.tokenId,
    result.components.map(component => component.damageType).sort()]));
  assert.deepEqual(damage, {"token-orc": ["fire"], "token-goblin": [], "token-kobold": ["acid", "lightning"]}, "Indigo deals no damage");
  const conditions = state.results.effectResolution.conditionPlans.map(entry => [entry.target?.tokenId, entry.conditionId]);
  assert.deepEqual(conditions, [["token-goblin", "restrained"]], "Violet was drawn by nobody");
});

test("a physical draw roll is typed for its creature, and an answered draw is never asked again", async () => {
  const waiting = plan("resolution:spray-physical", ["orc"]).state;
  const request = waiting.pendingRequests[0];
  assert.equal(request.chooser, "source-controller", "its caster rolls it");
  const view = createPromptViewModel(request);
  assert.deepEqual([view.title, view.titleData], ["WILDPATH.PROMPT.Title.Draw", {label: "Rays", name: "orc"}], "the prompt names its creature");
  const remote = createPromptViewModel({...request, payload: projectPendingRequestPayloadForChooser(request.type, request.payload)});
  assert.deepEqual([remote.title, remote.titleData], [view.title, view.titleData], "on its roller's own client too");
  const rollRequest = request.payload.rollRequest;
  const provided = await executeRollRequest({request: rollRequest, providers: [createPhysicalDiceProvider()], context: {physicalRolls: {
    [rollRequest.id]: {requestId: rollRequest.id, resolutionId: rollRequest.resolutionId, type: rollRequest.type, total: 5}}}});
  assert.equal(provided.ok, true, JSON.stringify(provided));
  const drawn = resumeStagedActionResolution({state: waiting, response: {resolutionId: waiting.id, requestId: request.id,
    type: RESOLUTION_REQUEST_TYPES.ROLL, value: provided.result}}).state;
  assert.equal(drawn.rollResults[0].rollResult.provenance.type, "physical");
  assert.deepEqual(drawn.results.drawResolution.byTarget, {"token-orc": ["blue"]});
  assert.equal(pendingIds(drawn).some(id => id.startsWith("draw:")), false, "the draw is not asked again");
  const again = resumeStagedActionResolution({state: drawn, response: {resolutionId: drawn.id, requestId: request.id,
    type: RESOLUTION_REQUEST_TYPES.ROLL, value: {...provided.result, total: 1}}}).state;
  assert.deepEqual(again.results.drawResolution.byTarget, {"token-orc": ["blue"]}, "a second answer changes nothing");
  assert.equal(again.rollRequests.filter(entry => entry.metadata?.rollKind === "draw").length, 1, "one draw roll only");
});

test("a shared draw (no perTarget) is one roll for every creature; an Unaffected creature draws nothing", () => {
  let state = plan("resolution:spray-shared", ["orc", "goblin"], {definition: spray({})}).state;
  assert.deepEqual(pendingIds(state), ["draw:all"]);
  assert.equal(createPromptViewModel(state.pendingRequests[0]).title, "Rays", "its label, with no one creature to name");
  state = finish(answer(state, "draw:all", {total: 7}));
  assert.deepEqual(state.results.effectResolution.conditionPlans.map(entry => [entry.target?.tokenId, entry.conditionId]),
    [["token-orc", "blinded"], ["token-goblin", "blinded"]]);
  assert.equal(state.results.damageResolution, undefined, "no damage at all: no die rolled");

  const spared = plan("resolution:spray-unaffected", ["orc", "goblin"], {extra: {context: {unaffected: [target("goblin")]}}}).state;
  assert.deepEqual(pendingIds(answer(spared, "draw:token-orc", {total: 1})).filter(id => id.startsWith("draw:")), [],
    "the Unaffected goblin is not rolled for");
});

test("an effect meant for some targets only (metadata.targetRefs) skips the others, as damage does", () => {
  const targetResolution = {targetContexts: [{target: {id: "a", tokenId: "tok-a"}, selected: true},
    {target: {id: "b", tokenId: "tok-b"}, selected: true}]};
  const blinded = refs => [{id: "effect-1", type: "condition", conditionId: "blinded", ...(refs ? {metadata: {targetRefs: refs}} : {})}];
  const planned = refs => resolveActionEffects({effects: blinded(refs), targetResolution, actionContext: {source: {}}}).conditionPlans
    .map(entry => entry.target?.tokenId);
  assert.deepEqual(planned(null), ["tok-a", "tok-b"]);
  assert.deepEqual(planned(["Token.tok-b", "tok-b", "token:tok-b"]), ["tok-b"]);
});

test("a rolled choice is not asked of its user, nor missing; a keepEffect listing damage keeps only its option's damage", () => {
  const discovered = discoverActionConfigurationChoices({definition: spray()});
  assert.deepEqual(discovered.requests.map(request => request.id), [], "the drawn choice is rolled, not asked");
  const resolved = resolveActionConfiguration({definition: spray(), choices: {}});
  assert.equal(resolved.ok, true, JSON.stringify(resolved.errors));
  assert.equal(resolved.configuration.effectiveDefinition.damage.length, 5, "every ray's damage is left for the draw stage");
  const asked = {...spray(), draw: undefined};
  delete asked.draw;
  const red = resolveActionConfiguration({definition: asked, choices: {drawn: "red"}});
  assert.equal(red.ok, true, JSON.stringify(red.errors));
  assert.deepEqual(red.configuration.effectiveDefinition.damage.map(component => component.id), ["damage-1-fire"]);
  assert.deepEqual(red.configuration.effectiveDefinition.effects, [], "neither Indigo's nor Violet's effect");
});

test("a draw is a table or a formula and names its choice; a rolled option has a range, and its again leaves a result", () => {
  const definition = spray();
  const valid = draft => validateActionDefinition(draft);
  assert.equal(valid(definition).ok, true, JSON.stringify(valid(definition).errors));
  const options = change => ({...definition, configuration: [{...definition.configuration[0],
    options: definition.configuration[0].options.map(change)}]});
  for ( const [label, draft] of [
    ["no choice", {...definition, draw: {choiceId: "missing", formula: "1d8"}}],
    ["both", {...definition, draw: {...definition.draw, table: "RollTable.x"}}],
    ["neither", {...definition, draw: {choiceId: "drawn"}}],
    ["no range", options(option => ((option.id === "red") ? {...option, range: undefined} : option))],
    ["again over the whole die", options(option => ((option.id === "special") ? {...option, range: [1, 8]} : option))],
    ["again not whole", options(option => ((option.id === "special") ? {...option, again: 0} : option))]
  ] ) {
    const result = valid(draft);
    assert.equal(result.ok, false, label);
    assert.equal(result.errors[0].path, "draw", label);
  }
  assert.equal(valid({...definition, draw: {table: "RollTable.x", choiceId: "drawn"}}).ok, true, "a table draw needs no ranges");
});

test("a drawn part on the Action's own user (appliesTo source) reaches it, from a shared roll or any creature's", () => {
  const withSelf = draw => {
    const definition = spray(draw);
    definition.effects.push({id: "effect-3", type: "condition", conditionId: "invisible", appliesTo: "source"});
    const keep = definition.configuration[0].effects[0];
    keep.effectIds.push("effect-3");
    keep.keep.violet = ["effect-2", "effect-3"];
    return definition;
  };
  const conditions = state => state.results.effectResolution.conditionPlans.map(entry => [entry.target?.tokenId ?? entry.target, entry.conditionId]);
  let own = plan("resolution:spray-self", ["orc", "goblin"], {definition: withSelf({perTarget: true})}).state;
  own = finish(answer(answer(own, "draw:token-orc", {total: 7}), "draw:token-goblin", {total: 1}));
  assert.deepEqual(conditions(own), [["token-orc", "blinded"], ["token:token-caster", "invisible"]], "the orc's Violet makes its caster invisible");
  const shared = finish(answer(plan("resolution:spray-self-shared", ["orc"], {definition: withSelf({})}).state, "draw:all", {total: 7}));
  assert.deepEqual(conditions(shared), [["token-orc", "blinded"], ["token:token-caster", "invisible"]], "a shared roll's part is everyone's");
  const none = finish(answer(plan("resolution:spray-self-none", ["orc"], {definition: withSelf({perTarget: true})}).state,
    "draw:token-orc", {total: 6}));
  assert.deepEqual(conditions(none), [["token-orc", "restrained"]], "nobody drew Violet: its caster is not invisible");
});

test("a draw reads the keep-effect spelling configuration reads, and the prompt has a title without a choice label", () => {
  const definition = spray();
  definition.configuration[0].effects[0].type = "keep-effect";
  delete definition.configuration[0].label;
  let state = plan("resolution:spray-alias", ["orc"], {definition}).state;
  assert.deepEqual(createPromptViewModel(state.pendingRequests[0]).titleData, {label: "WILDPATH.PROMPT.Title.Roll", name: "orc"});
  state = finish(answer(state, "draw:token-orc", {total: 1}));
  assert.deepEqual(state.rollRequests.filter(request => request.metadata?.rollKind === "damage").map(request => request.metadata.componentId),
    ["damage-1-fire"], "only the drawn ray's damage");
});

test("a rolled choice does only its keepEffect: any other effect, on it or an option, is refused", () => {
  const definition = spray();
  const choice = definition.configuration[0];
  for ( const [label, draft] of [
    ["choice effect", {...definition, configuration: [{...choice, effects: [...choice.effects, {type: "replaceDamageType", damageType: "fire"}]}]}],
    ["option effect", {...definition, configuration: [{...choice, options: choice.options.map(option => ((option.id === "red")
      ? {...option, effects: [{type: "add-effects", effects: []}]} : option))}]}]
  ] ) {
    const result = validateActionDefinition(draft);
    assert.equal(result.ok, false, label);
    assert.equal(result.errors[0].path, "draw", label);
  }
});
