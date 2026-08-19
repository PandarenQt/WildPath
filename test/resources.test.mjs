import {test} from "node:test";
import assert from "node:assert/strict";
import {computeResourceMax, clampResourceValue, clamp} from "../module/helpers/resources.mjs";

test("clamp restricts a value to [min, max]", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(15, 0, 10), 10);
});

test("computeResourceMax sums base + bonus + modifierBonus and floors at 0", () => {
  assert.equal(computeResourceMax({base: 10, bonus: 2}, 3), 15);
  assert.equal(computeResourceMax({base: 1, bonus: 0}, -10), 0);
  assert.equal(computeResourceMax({base: 0, bonus: 0}), 0);
});

test("computeResourceMax is idempotent across repeated calls with the same inputs", () => {
  // Regression test for the += accumulation bug: recomputing from the same base/bonus/
  // modifierBonus inputs must always produce the same result, no matter how many times
  // prepareDerivedData happens to run.
  const pool = {base: 10, bonus: 2};
  const modifierBonus = 4;
  const first = computeResourceMax(pool, modifierBonus);
  const second = computeResourceMax(pool, modifierBonus);
  const third = computeResourceMax(pool, modifierBonus);
  assert.equal(first, 16);
  assert.equal(second, 16);
  assert.equal(third, 16);
});

test("clampResourceValue clamps within [0, max] and defaults missing value to 0", () => {
  assert.equal(clampResourceValue(5, 10), 5);
  assert.equal(clampResourceValue(-5, 10), 0);
  assert.equal(clampResourceValue(15, 10), 10);
  assert.equal(clampResourceValue(undefined, 10), 0);
});
