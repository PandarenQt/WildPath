import {test} from "node:test";
import assert from "node:assert/strict";
import {computeActionCostMap} from "../module/helpers/actions.mjs";

const BUILTINS = ["action", "bonus", "reaction", "movement"];

test("computeActionCostMap includes positive built-in costs", () => {
  const map = computeActionCostMap({action: 1, bonus: 0, reaction: 0, movement: 10, custom: []}, BUILTINS);
  assert.deepEqual(map, {action: 1, movement: 10});
});

test("computeActionCostMap ignores zero and negative built-in costs", () => {
  const map = computeActionCostMap({action: 0, bonus: -1, reaction: 0, movement: 0, custom: []}, BUILTINS);
  assert.deepEqual(map, {});
});

test("computeActionCostMap includes valid custom costs and merges with built-ins", () => {
  const map = computeActionCostMap({
    action: 1, bonus: 0, reaction: 0, movement: 0,
    custom: [{resource: "ki", amount: 2}, {resource: "action", amount: 1}]
  }, BUILTINS);
  assert.deepEqual(map, {action: 2, ki: 2});
});

test("computeActionCostMap ignores zero/negative/blank-resource custom costs", () => {
  const map = computeActionCostMap({
    action: 0, bonus: 0, reaction: 0, movement: 0,
    custom: [{resource: "ki", amount: 0}, {resource: "ki", amount: -1}, {resource: "", amount: 5}]
  }, BUILTINS);
  assert.deepEqual(map, {});
});

test("computeActionCostMap tolerates a missing custom array", () => {
  const map = computeActionCostMap({action: 1, bonus: 0, reaction: 0, movement: 0}, BUILTINS);
  assert.deepEqual(map, {action: 1});
});
