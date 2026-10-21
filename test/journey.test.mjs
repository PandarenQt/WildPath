import {test} from "node:test";
import assert from "node:assert/strict";
import {journeyPlan, paceEffect, travel} from "../module/applications/journey.mjs";

test("a journey's distance by pace, its pace effect, and a forced march past 8 hours", async () => {
  assert.deepEqual(journeyPlan("fast", 8), {miles: 32, forcedMarch: []});
  assert.deepEqual(journeyPlan("slow", 10), {miles: 20, forcedMarch: [11, 12]});
  assert.equal(paceEffect("normal", 8, "x"), null, "a normal pace changes nothing");
  assert.deepEqual(paceEffect("fast", 8, "Fast").system.ruleElements[0].data, {domains: ["check.perception", "check.survival"], mode: "disadvantage"});
  const created = [];
  const toggled = [];
  const rolls = [12, 5];
  const actor = {name: "Ana", effects: [], createEmbeddedDocuments: async (type, data) => created.push(...data),
    rollTest: async () => rolls.shift(), toggleCondition: async id => toggled.push(id)};
  const advanced = [];
  const result = await travel({pace: "slow", hours: 10, actors: [actor], time: {advance: async seconds => advanced.push(seconds)}});
  assert.deepEqual([result.miles, result.exhausted, toggled, advanced], [20, ["Ana"], ["exhaustion"], [36000]], "12 vs DC 11 passes; 5 vs 12 fails");
  assert.equal(created[0].system.ruleElements[0].data.mode, "advantage");
});
