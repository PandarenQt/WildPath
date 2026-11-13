import {test} from "node:test";
import assert from "node:assert/strict";
import {RESOLUTION_REQUEST_TYPES, RESOLUTION_STATE_STATUS} from "../module/helpers/resolution-state.mjs";
import {planStagedActionResolution, resumeStagedActionResolution} from "../module/resolvers/action-pipeline-resolver.mjs";
import {createPhysicalDiceProvider, executeRollRequest} from "../module/resolvers/roll-provider-resolver.mjs";
import {createPromptViewModel} from "../module/helpers/prompt-view-models.mjs";
import {actionDefinitionToResolverInput, validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {resolveActionEffects} from "../module/resolvers/action-resolver.mjs";
import {commitConditionEffectMutationPlan} from "../module/resolvers/condition-effect-commit-resolver.mjs";
import {modifiersFromRuleElements} from "../module/helpers/rule-elements.mjs";
import {WildPathStatistic} from "../module/helpers/modifiers.mjs";

// A Hit Point drain: an ordinary Modifier on the maximum, reading the amount stamped as the effect lands.
const drain = (amount, extra={}) => ({id: "effect-1", type: "effect", name: "Drained", stack: "separate", restsLeft: 1, amount,
  ruleElements: [{schemaVersion: 1, id: "hp-drain", type: "Modifier", data: {domains: ["resources.health.max"],
    valueExpression: {type: "multiply", terms: [{type: "context", path: "amount"}, -1]}}}], ...extra});
const action = ({damage=[], save=null, effects}) => ({schemaVersion: 1, id: "action:drain", label: "Drain", costs: {allOf: []},
  targeting: {type: "single", required: true, count: 1}, ...(save ? {save} : {}), damage, effects});
const hit = (value, damageType, extra={}) => ({id: `damage-${damageType}`, expression: {type: "constant", value}, damageType, ...extra});
const target = {id: "foe", actorId: "actor-foe", tokenId: "token-foe", name: "Foe", disposition: "enemy"};
const plan = (definition, health={value: 30, max: 30}) => planStagedActionResolution({id: "resolution:drain",
  actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
  action: {id: definition.id, type: "action", name: definition.label, system: {definition}}, source: {actorId: "actor-wraith"},
  targets: [target], durability: {targetSystems: {"token-foe": {resources: {health}, pools: []}}}}).state;
const answer = (state, value) => {
  const request = state.pendingRequests[0];
  assert.ok(request, "a request is pending");
  const roll = request.payload.rollRequest;
  return resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id,
    type: RESOLUTION_REQUEST_TYPES.ROLL, value: {requestId: roll.id, resolutionId: state.id, type: roll.type, ...value}}}).state;
};
const stamped = state => state.mutationPlans.filter(entry => entry.type === "conditionEffect")
  .map(entry => entry.definition.ruleElements[0].data.valueExpression);
const fail = {natural: 2, total: 2};
const succeed = {natural: 20, total: 25};

test("a drain by the damage taken: the Hit Points it took, Temporary Hit Points included, stamped as a constant", () => {
  const state = plan(action({damage: [hit(18, "necrotic")], effects: [drain({damage: "all"})]}), {value: 30, max: 30, temp: 10});
  assert.equal(state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(state.errors));
  assert.deepEqual(stamped(state), [{type: "multiply", terms: [{type: "constant", value: 18}, -1]}],
    "18 taken, though its Temporary Hit Points absorbed 10 (pending the owner, Q23)");
  const effect = state.mutationPlans.find(entry => entry.type === "conditionEffect");
  assert.deepEqual([effect.definition.amount.value, effect.definition.restsLeft, effect.definition.separate], [18, 1, true]);
});

test("a drain counting one damage type only (Clay Golem's Acid), and none when nothing was taken", () => {
  const golem = plan(action({damage: [hit(12, "bludgeoning"), hit(6, "acid")], effects: [drain({damage: ["acid"]})]}));
  assert.deepEqual(stamped(golem)[0].terms[0], {type: "constant", value: 6});
  const immune = plan(action({damage: [hit(12, "bludgeoning")], effects: [drain({damage: ["acid"]})]}));
  assert.equal(immune.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(immune.errors));
  assert.deepEqual(stamped(immune), [], "no Acid taken: no drain");
});

test("Harm: a drain only on a failed save, capped so the maximum stays at 1; Succubus: on either outcome", () => {
  const harm = action({save: {ability: "fortitude", dc: {value: 15}}, damage: [hit(40, "necrotic", {saveOutcomePolicy: {success: "half", failure: "full"}})],
    effects: [drain({damage: ["necrotic"], cap: {type: "subtract", left: {type: "resource-max", resource: "health"}, right: 1}},
      {saveOutcomePolicy: "failure"})]});
  assert.deepEqual(stamped(answer(plan(harm), fail))[0].terms[0], {type: "constant", value: 29}, "40 taken, at most 30 - 1");
  assert.deepEqual(stamped(answer(plan(harm), succeed)), [], "half damage only on a success");

  const kiss = action({save: {ability: "fortitude", dc: {value: 15}}, damage: [hit(20, "psychic", {saveOutcomePolicy: {success: "half", failure: "full"}})],
    effects: [drain({damage: "all"})]});
  assert.deepEqual(stamped(answer(plan(kiss), succeed))[0].terms[0], {type: "constant", value: 10}, "a success: half the damage, drained");
});

test("a rolled drain (Demilich 4d6) is its user's RollRequest for its creature: physical dice, never rolled twice", async () => {
  const definition = action({save: {ability: "fortitude", dc: {value: 15}}, effects: [drain({formula: "4d6"}, {saveOutcomePolicy: "failure"})]});
  const saved = answer(plan(definition), succeed);
  assert.equal(saved.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, "a success: nothing to roll");
  const waiting = answer(plan(definition), fail);
  const request = waiting.pendingRequests[0];
  assert.equal(request.id, `request:${waiting.id}:amount:effect-1:token-foe`);
  assert.deepEqual(createPromptViewModel(request).titleData, {label: "Drained", name: "Foe"}, "the prompt names its creature");
  const rollRequest = request.payload.rollRequest;
  const provided = await executeRollRequest({request: rollRequest, providers: [createPhysicalDiceProvider()], context: {physicalRolls: {
    [rollRequest.id]: {requestId: rollRequest.id, resolutionId: rollRequest.resolutionId, type: rollRequest.type, total: 14}}}});
  const rolled = resumeStagedActionResolution({state: waiting, response: {resolutionId: waiting.id, requestId: request.id,
    type: RESOLUTION_REQUEST_TYPES.ROLL, value: provided.result}}).state;
  assert.equal(rolled.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(rolled.errors));
  assert.deepEqual(stamped(rolled)[0].terms[0], {type: "constant", value: 14});
  assert.equal(rolled.input.drawn["amount:effect-1:token-foe"], 14);
  const again = resumeStagedActionResolution({state: rolled, response: {resolutionId: rolled.id, requestId: request.id,
    type: RESOLUTION_REQUEST_TYPES.ROLL, value: {...provided.result, total: 3}}}).state;
  assert.deepEqual(stamped(again)[0].terms[0], {type: "constant", value: 14}, "a second answer changes nothing");
});

test("two drains on one creature add up: each copy's rules have ids of their own", async () => {
  const state = plan(action({damage: [hit(7, "necrotic")], effects: [drain({damage: "all"})]}));
  const effectPlan = state.mutationPlans.find(entry => entry.type === "conditionEffect");
  const actor = {effects: [], async createEmbeddedDocuments(_name, documents) {
    const created = documents.map((data, index) => ({id: `effect-${actor.effects.length + index + 1}`, ...structuredClone(data)}));
    actor.effects.push(...created);
    return created;
  }};
  for ( let copy = 0; copy < 2; copy++ ) assert.equal((await commitConditionEffectMutationPlan(actor, structuredClone(effectPlan))).ok, true);
  const total = () => new WildPathStatistic("resources.health.max", actor.effects.flatMap(effect => modifiersFromRuleElements({
    ruleElements: effect.system.ruleElements, domain: "resources.health.max"}).modifiers)).totalModifier;
  assert.equal(total(), -14);
  // Another Action's drain reusing the rule id (every converted drain does) adds up too.
  const other = plan({...action({damage: [hit(10, "necrotic")], effects: [drain({damage: "all"})]}), id: "action:other-drain"})
    .mutationPlans.find(entry => entry.type === "conditionEffect");
  assert.notEqual(other.conditionId, effectPlan.conditionId);
  assert.equal((await commitConditionEffectMutationPlan(actor, other)).ok, true);
  assert.equal(total(), -24);
  // A middle copy removed by hand: the next drain takes the free id instead of one still in use.
  actor.effects.splice(1, 1);
  assert.equal((await commitConditionEffectMutationPlan(actor, structuredClone(effectPlan))).ok, true);
  assert.equal(total(), -24);
  assert.deepEqual(actor.effects.map(effect => effect.system.ruleElements[0].id), ["hp-drain", "hp-drain:3", "hp-drain:2"]);
});

test("the amount part is not the Hit Point maximum's only: an AbilityScore drain, and rules with no amount fail", () => {
  const sap = {id: "effect-1", type: "effect", name: "Sapped", stack: "separate", amount: {formula: "1d4"},
    ruleElements: [{schemaVersion: 1, id: "sap", type: "AbilityScore", data: {ability: "might", mode: "add",
      value: {type: "multiply", terms: [{type: "context", path: "amount"}, -1]}}}]};
  const definition = action({effects: [sap]});
  assert.equal(validateActionDefinition(definition).ok, true);
  const effects = actionDefinitionToResolverInput(definition).effects;
  const targetResolution = {targetContexts: [{target, selected: true}]};
  const resolved = resolveActionEffects({effects, targetResolution, actionContext: {source: {}}, amountOf: () => 3});
  assert.deepEqual(resolved.mutationPlans[0].definition.ruleElements[0].data.value, {type: "multiply", terms: [{type: "constant", value: 3}, -1]});
  const none = resolveActionEffects({effects, targetResolution, actionContext: {source: {}}});
  assert.deepEqual([none.ok, none.code], [false, "AMOUNT_UNAVAILABLE"], "never a rule reading nothing");
});

test("an effect's amount is its damage taken or a formula, and a formula is dice", () => {
  const refused = amount => validateActionDefinition(action({effects: [drain(amount)]})).errors.map(entry => entry.path);
  assert.deepEqual(refused({damage: "all"}), []);
  assert.deepEqual(refused({damage: ["acid"], cap: 5}), []);
  assert.deepEqual(refused({damage: "all", formula: "1d6"}), ["effects.0.amount"]);
  assert.deepEqual(refused({}), ["effects.0.amount"]);
  assert.deepEqual(refused({damage: []}), ["effects.0.amount"]);
  assert.deepEqual(refused({formula: "@abilities.con"}), ["effects.0.amount"]);
});

test("a custom effect lasting some Long Rests carries the count to the applied effect (Resurrection Sickness)", () => {
  const definition = action({effects: [{id: "sick", type: "effect", name: "Resurrection Sickness", ruleElements: [], restsLeft: 3}]});
  const effects = actionDefinitionToResolverInput(definition).effects;
  const resolved = resolveActionEffects({effects, targetResolution: {targetContexts: [{target, selected: true}]}, actionContext: {source: {}}});
  assert.equal(resolved.mutationPlans[0].definition.restsLeft, 3, "Actor#rest reads it there");
});
