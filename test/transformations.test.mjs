import {test} from "node:test";
import assert from "node:assert/strict";
import {formOverrides, itemContributesWhileTransformed} from "../module/helpers/transformations.mjs";

test("a form provides the listed statistics it has; others stay the creature's", () => {
  const beast = {abilities: {might: {value: 18}, agility: {value: 14}, fortitude: {value: 16}, intellect: {value: 2}},
    defenses: {ac: {value: 13}}, resources: {movement: {base: 40}}};
  assert.deepEqual(Object.fromEntries(formOverrides(beast)), {"abilities.might.value": 18, "abilities.agility.value": 14,
    "abilities.fortitude.value": 16, "defenses.ac.value": 13, "resources.movement.base": 40}, "Wild Shape by default: no mental abilities");
  assert.deepEqual(formOverrides(beast, ["abilities.intellect.value", "abilities.wits.value"]), [["abilities.intellect.value", 2]],
    "a statistic the form lacks is skipped");
});

test("while transformed the creature keeps its features and gear by default, and a policy can narrow that", () => {
  const policy = {formRef: "Actor.beast"};
  assert.deepEqual(["feature", "gear", "action"].map(type => itemContributesWhileTransformed(type, policy)), [true, true, false]);
  assert.equal(itemContributesWhileTransformed("gear", {...policy, keepItemTypes: ["feature"]}), false, "gear that melds into the form");
});
