import {test} from "node:test";
import assert from "node:assert/strict";
import {WildPathModifier, WildPathStatistic, modifierDice} from "../module/helpers/modifiers.mjs";
import {createD20RollRequest, d20Chance, rollFormulaForRequest, createRollResultFromManualInput} from "../module/helpers/rolls.mjs";
import {createPromptViewModel} from "../module/helpers/prompt-view-models.mjs";
import {RESOLUTION_REQUEST_TYPES} from "../module/helpers/resolution-state.mjs";

const bless = {id: "bless", label: "Bless", domains: ["attack"], valueExpression: {type: "dice", number: 1, faces: 4}};
const bane = {id: "bane", label: "Bane", domains: ["attack"], valueExpression: {type: "subtract", left: {type: "constant", value: 0},
  right: {type: "dice", number: 1, faces: 4}}};

test("a dice Modifier (Bless +1d4, Bane -1d4) is rolled with the d20, not added as a number", () => {
  assert.deepEqual(modifierDice(bless.valueExpression), {number: 1, faces: 4, sign: 1});
  assert.deepEqual(modifierDice(bane.valueExpression), {number: 1, faces: 4, sign: -1});
  assert.deepEqual(modifierDice({type: "multiply", terms: [{type: "constant", value: -1}, {type: "dice", number: 2, faces: 6}]}),
    {number: 2, faces: 6, sign: -1});
  assert.equal(modifierDice({type: "constant", value: 2}), null);
  assert.equal(new WildPathModifier(bane).signedValue, "-1d4");
  const statistic = new WildPathStatistic("attack", [bless, bane, {id: "sword", label: "+1 sword", domains: ["attack"], value: 1}]);
  assert.equal(statistic.totalModifier, 1, "dice add nothing to the flat total");
  assert.deepEqual(statistic.dice.map(die => [die.id, die.number, die.faces, die.sign]).sort(), [["bane", 1, 4, -1], ["bless", 1, 4, 1]]);
});

test("bonus dice join the d20's formula after it, advantage stays on the d20, and the odds count every outcome", () => {
  const request = createD20RollRequest({id: "r", resolutionId: "s", modifier: 5, rollMode: "advantage",
    definition: {dice: [{id: "d20", number: 1, faces: 20, purpose: "d20"}, {id: "bless", number: 1, faces: 4, purpose: "bonus"},
      {id: "bane", number: 1, faces: 4, purpose: "bonus", sign: -1}]}, expected: {modifierTotal: null}});
  assert.equal(rollFormulaForRequest(request).formula, "2d20kh + 1d4 - 1d4 + 5");
  // A physical roller enters the d20 and the total; the total is checked against the formula's bounds only.
  const result = createRollResultFromManualInput({request, input: {natural: 12, total: 18}});
  assert.equal(result.ok, true, result.reason);
  assert.equal(createRollResultFromManualInput({request, input: {natural: 12, total: 40}}).ok, false);

  assert.equal(d20Chance({modifier: 0, target: 11, dice: [{number: 1, faces: 4, sign: 1}]}), (0.55 + 0.6 + 0.65 + 0.7) / 4);
  assert.equal(d20Chance({modifier: 0, target: 11, dice: [{number: 1, faces: 4, sign: -1}]}), (0.45 + 0.4 + 0.35 + 0.3) / 4);

  const prompt = createPromptViewModel({id: "q", resolutionId: "s", type: RESOLUTION_REQUEST_TYPES.ROLL, payload: {rollRequest: request}});
  assert.deepEqual([prompt.controls[0].type, prompt.controls[0].total?.label], ["roll-natural", "WILDPATH.PROMPT.Roll.TotalWithBonus"],
    "a physical roller is asked for the d20 and for the total");
});
