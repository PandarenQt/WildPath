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
});

test("a d20 set to a number shows on the card as entered, seen as the roll it replaced", async () => {
  const {sanitizeResolutionResultForTransport} = await import("../module/helpers/multiplayer-authority.mjs");
  const request = {id: "r1", type: "attack", visibility: "public", authority: {kind: "gm"}, formula: "1d20 + 5"};
  const state = {rollResults: [{requestId: "r1", rollRequest: request, rollResult: {total: 15, natural: 10}},
    {requestId: null, type: "attack-set-natural", roll: {total: 20, natural: 15}, portent: {holderRef: "Actor.d", slot: "2", value: 15}}]};
  const [, foretold] = sanitizeResolutionResultForTransport({state}).rolls;
  assert.deepEqual([foretold.visibility, foretold.formula, foretold.rollResult.total], ["public", "15 + 5", 20]);
});
