import {test} from "node:test";
import assert from "node:assert/strict";
import {carryingLoad, carryingRules, carryingSizeFactor} from "../module/helpers/carrying.mjs";

test("2024 carrying capacity: Might × 15 lb by size; carrying more caps Speed at 5 feet", () => {
  assert.deepEqual([carryingSizeFactor(0.5), carryingSizeFactor(1), carryingSizeFactor(2), carryingSizeFactor(3), carryingSizeFactor(4)],
    [0.5, 1, 2, 4, 8]);
  const light = carryingLoad({weight: 100, might: 10});
  assert.deepEqual([light.capacity, light.over, carryingRules(light)], [150, false, []]);
  const heavy = carryingLoad({weight: 151, might: 10});
  assert.deepEqual(carryingRules(heavy).map(rule => [rule.type, rule.data.maximum]), [["ResourceCap", 5]]);
  assert.equal(carryingLoad({weight: 151, might: 10, sizeFactor: 2}).over, false, "a Large creature carries twice as much");
});

test("variant encumbrance: −10 ft over 5 × Might, −20 ft and Disadvantage over 10 × Might; off: nothing", () => {
  const rules = weight => carryingRules(carryingLoad({weight, might: 10, mode: "variant"})).map(rule => rule.type === "Modifier"
    ? rule.data.value : rule.type);
  assert.deepEqual([rules(50), rules(51), rules(101), rules(151)], [[], [-10], [-20, "RollMode"], ["ResourceCap", -20, "RollMode"]]);
  assert.deepEqual(carryingRules(carryingLoad({weight: 1000, might: 10, mode: "off"})), []);
});
