import {test} from "node:test";
import assert from "node:assert/strict";
import {WILDPATH} from "../module/config.mjs";
import {combineRollModes, createD20RollRequest, rollFormulaForRequest} from "../module/helpers/rolls.mjs";
import {rollModesFromRuleElements, validateRuleElementDefinition} from "../module/helpers/rule-elements.mjs";

const condition = id => ({ruleElements: WILDPATH.CONDITIONS[id].ruleElements});
const modes = (owners, domains, context={}) => rollModesFromRuleElements(owners, {domains, context}).map(entry => entry.mode);

test("advantage and disadvantage cancel source for source; the larger count wins", () => {
  assert.equal(combineRollModes([]), "normal");
  assert.equal(combineRollModes(["advantage", "advantage"]), "advantage");
  assert.equal(combineRollModes([{mode: "disadvantage"}]), "disadvantage");
  assert.equal(combineRollModes(["advantage", "disadvantage"]), "normal");
  assert.equal(combineRollModes(["advantage", "advantage", "disadvantage"]), "advantage");
  assert.equal(combineRollModes(["disadvantage", "advantage", "disadvantage"]), "disadvantage");
});

test("a RollMode RuleElement names its mode and domains, and contributes only to requested domains", () => {
  assert.equal(validateRuleElementDefinition({schemaVersion: 1, id: "a", type: "RollMode",
    data: {mode: "advantage", domains: ["attack"]}}).ok, true);
  assert.deepEqual(rollModesFromRuleElements([{ruleElements: [{schemaVersion: 1, id: "bad", type: "RollMode",
    data: {mode: "sideways", domains: ["attack"]}}]}], {domains: ["attack"]}), [], "an invalid mode contributes nothing");
  const owners = [{ruleElements: [{schemaVersion: 1, id: "keen", type: "RollMode", data: {mode: "advantage", domains: ["attack.ranged"]}}]}];
  assert.deepEqual(modes(owners, ["attack", "attack.ranged"]), ["advantage"]);
  assert.deepEqual(modes(owners, ["attack", "attack.melee"]), []);
});

test("2024 Prone: own attacks at disadvantage; attacks against it at advantage within 5 ft, else disadvantage", () => {
  assert.deepEqual(modes([condition("prone")], ["attack", "attack.melee"]), ["disadvantage"]);
  assert.deepEqual(modes([condition("prone")], ["attacked"], {attack: {adjacent: true}}), ["advantage"]);
  assert.deepEqual(modes([condition("prone")], ["attacked"], {attack: {adjacent: false}}), ["disadvantage"]);
  assert.deepEqual(modes([condition("prone")], ["attacked"], {attack: {}}), [], "unknown distance: neither");
});

test("2024 Blinded, Restrained, Poisoned, Stunned and Unconscious advantage and disadvantage", () => {
  assert.deepEqual(modes([condition("blinded")], ["attack"]), ["disadvantage"]);
  assert.deepEqual(modes([condition("blinded")], ["attacked"]), ["advantage"]);
  assert.deepEqual(modes([condition("restrained")], ["save", "save.agility"]), ["disadvantage"]);
  assert.deepEqual(modes([condition("restrained")], ["save", "save.might"]), []);
  assert.deepEqual(modes([condition("poisoned")], ["check"]), ["disadvantage"]);
  assert.deepEqual(modes([condition("stunned")], ["attacked"]), ["advantage"]);
  assert.deepEqual(modes([condition("unconscious")], ["attacked"]), ["advantage"]);
  // A Poisoned attacker against a Blinded target: one of each, so a normal roll; a Blinded and Poisoned
  // attacker against a Blinded target has two disadvantages to one advantage.
  assert.equal(combineRollModes([...modes([condition("poisoned")], ["attack"]), ...modes([condition("blinded")], ["attacked"])]), "normal");
  assert.equal(combineRollModes([...modes([condition("poisoned"), condition("blinded")], ["attack"]),
    ...modes([condition("blinded")], ["attacked"])]), "disadvantage");
});

test("an advantage d20 request rolls 2d20 and keeps the higher", () => {
  const request = createD20RollRequest({id: "r", resolutionId: "s", type: "attack", modifier: 4, rollMode: "advantage"});
  assert.equal(request.rollMode, "advantage");
  assert.equal(rollFormulaForRequest(request).formula, "2d20kh + 4");
});
