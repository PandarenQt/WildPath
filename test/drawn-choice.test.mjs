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
// Each creature's damage results (one per damage instance), read by `read`.
const perToken = (state, read) => state.results.damageResolution.results.reduce((out, result) =>
  ({...out, [result.target.tokenId]: [...(out[result.target.tokenId] ?? []), read(result)]}), {});
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
  const damage = perToken(state, result => result.components.map(component => component.damageType));
  assert.deepEqual(damage, {"token-orc": [["fire"]], "token-goblin": [[]], "token-kobold": [["acid"], ["lightning"]]},
    "Indigo deals no damage; the kobold's two rays are two damages");
  const conditions = state.results.effectResolution.conditionPlans.map(entry => [entry.target?.tokenId, entry.conditionId]);
  assert.deepEqual(conditions, [["token-goblin", "restrained"]], "Violet was drawn by nobody");
});

test("unlinked Tokens of one Actor each take only their own ray, though they share its actor refs", () => {
  const ogre = id => ({...candidate(id), target: {...target(id), actorId: "actor-ogre"}, actor: {id: "actor-ogre"}});
  const names = ["a", "b", "c"];
  let state = plan("resolution:spray-ogres", names, {extra: {targeting: {required: true, candidates: names.map(ogre)}}}).state;
  state = answer(state, "draw:token-a", {total: 1});
  state = answer(state, "draw:token-b", {total: 6});
  state = answer(state, "draw:token-c", {total: 2});
  state = finish(state);
  assert.equal(state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(state.errors));
  const damage = perToken(state, result => result.components.map(component => component.damageType));
  assert.deepEqual(damage, {"token-a": [["fire"]], "token-b": [[]], "token-c": [["acid"]]}, "Red on A and Orange on C only");
  const conditions = state.results.effectResolution.conditionPlans.map(entry => [entry.target?.tokenId, entry.conditionId]);
  assert.deepEqual(conditions, [["token-b", "restrained"]], "Indigo on B only");
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

test("a noRepeat draw rolls again on an option its creature drew this turn, read once and kept for a resumed stage (Q25)", () => {
  const asked = [];
  const services = {drawnThisTurn: id => {
    asked.push(id);
    return ["red", "orange"];
  }};
  let state = plan("resolution:rays-again", ["orc"], {definition: spray({perTarget: true, noRepeat: "turn"}), extra: {services}}).state;
  assert.deepEqual([asked, state.input.drawExcluded], [["action:spray"], ["red", "orange"]], "read as the draw rolls, and kept");
  state = answer(state, "draw:token-orc", {total: 1});
  assert.deepEqual(pendingIds(state), ["draw:token-orc:2"], "Red, already drawn this turn, is rolled again");
  state = answer(state, "draw:token-orc:2", {total: 2});
  state = answer(state, "draw:token-orc:3", {total: 5});
  assert.deepEqual(state.results.drawResolution.byTarget, {"token-orc": ["blue"]}, "resumed without the service, the record still holds");
  assert.equal(state.rollRequests.filter(entry => entry.metadata?.rollKind === "draw").length, 3);
  state = finish(state);
  assert.deepEqual(perToken(state, result => result.components.map(component => component.damageType)), {"token-orc": [["cold"]]});

  // An 8 still rolls its two more, which are not skipped (no shipped noRepeat draw has `again`).
  let special = plan("resolution:rays-special", ["orc"], {definition: spray({perTarget: true, noRepeat: "turn"}),
    extra: {services: {drawnThisTurn: () => ["red"]}}}).state;
  special = answer(answer(answer(special, "draw:token-orc", {total: 8}), "draw:token-orc:2", {total: 1}), "draw:token-orc:3", {total: 2});
  assert.deepEqual(special.results.drawResolution.byTarget, {"token-orc": ["special", "red", "orange"]});

  // Every option drawn already: the first roll stands.
  const every = ["red", "orange", "yellow", "green", "blue", "indigo", "violet", "special"];
  const all = answer(plan("resolution:rays-all", ["orc"], {definition: spray({perTarget: true, noRepeat: "turn"}),
    extra: {services: {drawnThisTurn: () => every}}}).state, "draw:token-orc", {total: 3});
  assert.deepEqual(all.results.drawResolution.byTarget, {"token-orc": ["yellow"]});

  // Without noRepeat the record is not read, and a repeat stands.
  const plain = plan("resolution:rays-plain", ["orc"], {extra: {services: {drawnThisTurn: () => ["red"]}}}).state;
  assert.equal(plain.input?.drawExcluded, undefined);
  assert.deepEqual(answer(plain, "draw:token-orc", {total: 1}).results.drawResolution.byTarget, {"token-orc": ["red"]});
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
  // A 9 on a d8 is never rolled: with every other option drawn this turn, a noRepeat draw would reroll forever.
  const unreachable = options(option => ((option.id === "red") ? {...option, range: [9, 9]} : option));
  // The draw stage keeps only the Action's own parts, so a lasting area's trigger named in its keep would stay (S2).
  const keep = definition.configuration[0].effects[0];
  const zone = ids => ({...definition, area: {shape: "sphere", size: {value: 10, unit: "ft"}, persistence: {triggers: [{id: "zone",
    on: ["turn.ended"], action: {schemaVersion: 1, id: "action:zone", costs: {allOf: []}, effects: [{id: "effect-1", type: "condition", conditionId: "restrained"}]}}]}},
    configuration: [{...definition.configuration[0], effects: [{...keep, effectIds: [...keep.effectIds, ...ids]}]}]});
  for ( const [label, draft] of [
    ["no choice", {...definition, draw: {choiceId: "missing", formula: "1d8"}}],
    ["both", {...definition, draw: {...definition.draw, table: "RollTable.x"}}],
    ["neither", {...definition, draw: {choiceId: "drawn"}}],
    ["no range", options(option => ((option.id === "red") ? {...option, range: undefined} : option))],
    ["again over the whole die", options(option => ((option.id === "special") ? {...option, range: [1, 8]} : option))],
    ["again not whole", options(option => ((option.id === "special") ? {...option, again: 0} : option))],
    ["noRepeat not turn", {...definition, draw: {...definition.draw, noRepeat: "round"}}],
    ["noRepeat on a table", {...definition, draw: {table: "RollTable.x", choiceId: "drawn", noRepeat: "turn"}}],
    ["noRepeat option out of reach", {...unreachable, draw: {...definition.draw, noRepeat: "turn"}}],
    ["a lasting area's trigger kept", zone(["zone"])]
  ] ) {
    const result = valid(draft);
    assert.equal(result.ok, false, label);
    assert.equal(result.errors[0].path, "draw", label);
  }
  assert.equal(valid({...definition, draw: {table: "RollTable.x", choiceId: "drawn"}}).ok, true, "a table draw needs no ranges");
  assert.equal(valid({...definition, draw: {...definition.draw, noRepeat: "turn"}}).ok, true, "noRepeat on a formula draw");
  assert.equal(valid(unreachable).ok, true, "an unreachable option is refused only on a noRepeat draw");
  assert.equal(valid(zone([])).ok, true, "an own effect a trigger's row shares the id of is kept as before");
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

test("two rays of one colour on a creature are two damage rolls for it alone, two damages and two concentration checks; a condition twice is one", () => {
  const concentrating = name => [`token-${name}`, {concentrating: true, actorId: `actor-${name}`, sourceRef: `token:token-${name}`}];
  let state = plan("resolution:spray-twice", ["orc", "kobold", "goblin", "troll", "ogre"], {definition: {...spray(),
    targeting: {...spray().targeting, count: 5}}, extra: {concentration: {states: Object.fromEntries(
    ["orc", "kobold", "ogre"].map(concentrating)), dependents: []}}}).state;
  for ( const [suffix, total] of [["draw:token-orc", 1], ["draw:token-kobold", 8], ["draw:token-kobold:2", 1], ["draw:token-kobold:3", 1],
    ["draw:token-goblin", 8], ["draw:token-goblin:2", 6], ["draw:token-goblin:3", 6], ["draw:token-troll", 2],
    ["draw:token-ogre", 8], ["draw:token-ogre:2", 1], ["draw:token-ogre:3", 1]] ) state = answer(state, suffix, {total});
  assert.deepEqual(state.results.drawResolution.byTarget, {"token-orc": ["red"], "token-kobold": ["special", "red", "red"],
    "token-goblin": ["special", "indigo", "indigo"], "token-troll": ["orange"], "token-ogre": ["special", "red", "red"]});
  const totals = {"damage-roll": 12, "damage-roll:1": 5, "damage-roll:2": 9, "damage-roll:3": 4};
  for ( let guard = 0; state.pendingRequests.length && (guard < 20); guard++ ) {
    const suffix = pendingIds(state)[0];
    state = answer(state, suffix, (suffix in totals) ? {total: totals[suffix]} : {natural: 2, total: 2});
  }
  assert.equal(state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(state.errors));
  const rolled = state.rollRequests.filter(request => request.metadata?.rollKind === "damage").map(request => request.metadata.componentId);
  assert.deepEqual(rolled, ["damage-1-fire", "damage-1-acid", "damage-1-fire:2", "damage-1-fire:3"],
    "each creature's second red ray is its own roll");
  const damage = perToken(state, result => result.components.map(component => component.amount));
  assert.deepEqual(damage, {"token-orc": [[12]], "token-kobold": [[12], [9]], "token-goblin": [[]], "token-troll": [[5]],
    "token-ogre": [[12], [4]]}, "the orc shares the first red roll only; each second ray is its own damage");
  const plans = state.mutationPlans.filter(entry => (entry.resolver === "DurabilityResolver") && (entry.target?.tokenId === "token-kobold"));
  assert.equal(plans.length, 2, "two damages, so its death saves and damage hooks see two hits");
  const conditions = state.results.effectResolution.conditionPlans.map(entry => [entry.target?.tokenId, entry.conditionId]);
  assert.deepEqual(conditions, [["token-goblin", "restrained"]], "Indigo twice restrains the goblin once");
  const checks = state.results.concentrationResolution.checks.decisions.map(check => [check.checkRequest.target.tokenId, check.damageTaken]);
  assert.deepEqual(checks, [["token-orc", 12], ["token-kobold", 12], ["token-kobold", 9], ["token-ogre", 12], ["token-ogre", 4]],
    "each ray is its own damage: two checks for the kobold, not one for 21");
});

test("a shared draw's repeated ray is one more roll for everyone; two colours on a creature are two damage instances", () => {
  let state = plan("resolution:spray-shared-twice", ["orc", "goblin"], {definition: spray({})}).state;
  for ( const [suffix, total] of [["draw:all", 8], ["draw:all:2", 2], ["draw:all:3", 2]] ) state = answer(state, suffix, {total});
  state = finish(state);
  assert.equal(state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(state.errors));
  assert.deepEqual(state.rollRequests.filter(request => request.metadata?.rollKind === "damage").map(request => request.metadata.componentId),
    ["damage-1-acid", "damage-1-acid:2"]);
  assert.deepEqual(perToken(state, result => result.components.map(component => component.metadata?.damageInstance)),
    {"token-orc": [["orange"], ["orange:2"]], "token-goblin": [["orange"], ["orange:2"]]});

  let mixed = plan("resolution:spray-two-colours", ["orc"], {extra: {concentration: {
    states: {"token-orc": {concentrating: true, actorId: "actor-orc", sourceRef: "token:token-orc"}}, dependents: []}}}).state;
  for ( const [suffix, total] of [["draw:token-orc", 8], ["draw:token-orc:2", 1], ["draw:token-orc:3", 2]] ) mixed = answer(mixed, suffix, {total});
  mixed = finish(mixed);
  assert.deepEqual(mixed.results.concentrationResolution.checks.decisions.map(check => check.damageTaken), [7, 7], "Red and Orange: two checks");
});

test("one ray keeping a part another option also keeps is one damage, not two", () => {
  const definition = spray();
  const keep = definition.configuration[0].effects[0].keep;
  keep.orange = ["damage-1-acid", "damage-1-fire"];
  let state = plan("resolution:spray-shared-part", ["orc"], {definition, extra: {concentration: {
    states: {"token-orc": {concentrating: true, actorId: "actor-orc", sourceRef: "token:token-orc"}}, dependents: []}}}).state;
  state = finish(answer(state, "draw:token-orc", {total: 2}));
  assert.equal(state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(state.errors));
  assert.deepEqual(perToken(state, result => result.components.map(component => component.damageType)), {"token-orc": [["fire", "acid"]]});
  assert.deepEqual(state.results.concentrationResolution.checks.decisions.map(check => check.damageTaken), [14], "one check for its one ray");
});

test("Cosmic Omen's Long Rest roll (Q69): its self-targeted d6 keeps Weal on an even number, Woe on an odd one", async () => {
  const {convertItem} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  const item = convertItem({_id: "testcosmicomen00", name: "Cosmic Omen", type: "feat", img: "icons/svg/sun.svg", effects: [],
    system: {source: {license: "CC-BY-4.0", rules: "2024", book: ""}, identifier: "cosmic-omen", type: {value: "class"}, description: {value: "<p>Text.</p>"},
      uses: {max: "@abilities.wis.mod", recovery: [{period: "lr", type: "recoverAll"}]}, activities: {}}}).items[0];
  const definition = item.system.ruleElements.find(rule => rule.data?.event === "rest.completed").data.action;
  const omen = total => {
    const planned = planStagedActionResolution({id: `resolution:omen-${total}`, actorSystem: {resources: {}, pools: []},
      action: {id: definition.id, type: "action", name: definition.label, system: {definition}}, source: {actorId: "actor-druid", tokenId: "token-druid"}});
    assert.equal(planned.ok, true, JSON.stringify(planned.state?.errors));
    assert.deepEqual(pendingIds(planned.state), ["draw:all"], "rolled, not asked");
    const state = answer(planned.state, "draw:all", {total});
    assert.equal(state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(state.errors));
    return state.results.effectResolution.conditionPlans.map(entry => entry.conditionId);
  };
  assert.deepEqual([omen(4), omen(6)], [["cosmic-omen-weal"], ["cosmic-omen-weal"]]);
  assert.deepEqual([omen(1), omen(5)], [["cosmic-omen-woe"], ["cosmic-omen-woe"]]);
});
