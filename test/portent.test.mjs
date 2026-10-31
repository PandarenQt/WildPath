import {test} from "node:test";
import assert from "node:assert/strict";
import {portentDice, portentFeature, replacedTotal} from "../module/adapters/foundry-v14-portent.mjs";

test("Portent: its unused dice, its feature, and a card's total with a foretold d20", () => {
  const actor = {flags: {wildpath: {portent: {1: 14, 2: 0, 3: 21}}}, items: [{system: {active: false}, flags: {wildpath: {portentDice: {}}}}]};
  assert.deepEqual(portentDice(actor), [{slot: "1", value: 14}], "a used (0) or impossible die is not offered");
  assert.equal(portentFeature(actor), null, "an inactive feature gives nothing");
  // 2d20kh (12, kept) + 5 = 17; a foretold 3 makes it 8.
  assert.equal(replacedTotal({total: 17, dice: [{faces: 20, total: 12}]}, 3), 8);
  assert.equal(replacedTotal({total: 9, dice: [{faces: 20, total: 4}, {faces: 4, total: 2}]}, 20), 25, "Bless's d4 stays");
  assert.equal(replacedTotal({total: 9, dice: []}, 20), null, "no d20, nothing to replace");
  // A sheet roll's floor (Indomitable Might 20) holds after a foretold 2: 9 - 4 + 2 = 7 counts as 20.
  assert.equal(replacedTotal({total: 9, dice: [{faces: 20, total: 4}]}, 2, 20), 20);
  assert.equal(replacedTotal({total: 9, dice: [{faces: 20, total: 4}]}, 18, 20), 23, "above the floor: as rolled");
});

test("a d20 set to a number shows on the card as entered, seen as the roll it replaced", async () => {
  const {sanitizeResolutionResultForTransport} = await import("../module/helpers/multiplayer-authority.mjs");
  const request = {id: "r1", type: "attack", visibility: "public", authority: {kind: "gm"}, formula: "1d20 + 5"};
  const state = {rollResults: [{requestId: "r1", rollRequest: request, rollResult: {total: 15, natural: 10}},
    {requestId: null, type: "attack-set-natural", roll: {total: 20, natural: 15}, portent: {holderRef: "Actor.d", slot: "2", value: 15}}]};
  const [, foretold] = sanitizeResolutionResultForTransport({state}).rolls;
  assert.deepEqual([foretold.visibility, foretold.formula, foretold.rollResult.total], ["public", "15 + 5", 20]);
  // A floored save's set d20 keeps its floor, so the card can show what it counted as.
  const floored = sanitizeResolutionResultForTransport({state: {...state, rollResults: [state.rollResults[0],
    {requestId: null, type: "save-set-natural", roll: {total: 6, natural: 2, totalMinimum: 18}}]}}).rolls[1];
  assert.equal(floored.rollResult.totalMinimum, 18);
});

test("the Rules Inspector shows a floored save at the total it was judged at", async () => {
  const {inspectResolution} = await import("../module/helpers/resolution-inspection.mjs");
  const inspected = inspectResolution({state: {rollResults: [{rollResult: {total: 7, natural: 3, totalMinimum: 18}}],
    results: {saveResolution: {results: [{target: {name: "Barbarian"}, roll: {total: 7, totalMinimum: 18}, total: 18, dc: {value: 15},
      outcome: "success"}]}}}});
  assert.deepEqual([inspected.rolls[0].total, inspected.saves[0].total], [18, 18]);
});
