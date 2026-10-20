import {test} from "node:test";
import assert from "node:assert/strict";
import {bestSenses, onGround, perceives} from "../module/helpers/senses.mjs";
import {rollModesFromRuleElements} from "../module/helpers/rule-elements.mjs";
import {combineRollModes} from "../module/helpers/rolls.mjs";
import {WILDPATH} from "../module/config.mjs";

test("a creature's senses are the best range each grant gives", () => {
  assert.deepEqual(bestSenses([{sense: "darkvision", range: 60}, {sense: "darkvision", range: 120}, {sense: "truesight", range: 30},
    {sense: "smell", range: 10}]), {darkvision: 120, blindsight: 0, tremorsense: 0, truesight: 30});
});

test("perceiving despite Blinded and Invisible: Blindsight, Truesight and Tremorsense within range", () => {
  const creature = (statuses=[], senses={}) => ({statuses: new Set(statuses), system: {senses}});
  assert.equal(perceives(creature(), creature()), true);
  assert.equal(perceives(creature(), creature(["invisible"])), false);
  assert.equal(perceives(creature([], {truesight: 30}), creature(["invisible"]), {distance: 30}), true);
  assert.equal(perceives(creature([], {truesight: 30}), creature(["invisible"]), {distance: 35}), false, "out of range");
  assert.equal(perceives(creature(["blinded"], {truesight: 120}), creature()), false, "Truesight is sight");
  assert.equal(perceives(creature(["blinded"], {blindsight: 10}), creature(["invisible"]), {distance: 10}), true);
  assert.equal(perceives(creature(["blinded"], {tremorsense: 60}), creature(), {distance: 20, grounded: false}), false, "a flier");
  assert.equal(onGround({elevation: 20, level: "l", parent: {levels: {get: () => ({elevation: {bottom: 0}})}}}), false);
});

test("Invisible and Blinded give their roll modes only while the other creature can't perceive them", () => {
  const modes = (condition, domains, attack) => combineRollModes(rollModesFromRuleElements([{ruleElements: WILDPATH.CONDITIONS[condition].ruleElements}],
    {domains, context: {attack}}));
  assert.equal(modes("invisible", ["attacked"], {}), "disadvantage", "attacking an Invisible creature");
  assert.equal(modes("invisible", ["attacked"], {seesTarget: true}), "normal", "with Truesight in range");
  assert.equal(modes("invisible", ["attack"], {seenByTarget: true}), "normal", "its target sees it");
  assert.equal(modes("blinded", ["attack"], {seesTarget: true}), "normal", "Blindsight");
  assert.equal(modes("blinded", ["attacked"], {}), "advantage");
});
