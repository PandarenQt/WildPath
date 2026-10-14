import {test} from "node:test";
import assert from "node:assert/strict";
import {computeResourceMax, clampResourceValue, clamp, remainingFromSpent, spentFromRemaining} from "../module/helpers/resources.mjs";

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

test("a counted resource remains max - spent, never below zero, and a written remaining value maps back to spent", () => {
  assert.equal(remainingFromSpent(2, 1), 1, "an effect raising the maximum to 2 leaves one of two");
  assert.equal(remainingFromSpent(0, 1), 0, "a lowered maximum never goes negative");
  assert.equal(spentFromRemaining(1, 0), 1);
  assert.equal(spentFromRemaining(2, 2), 0, "recovery to the maximum clears spent");
  assert.equal(spentFromRemaining(1, 3), 0, "a remaining value above the maximum is not negative spending");
});
