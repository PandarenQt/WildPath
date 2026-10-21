import {test} from "node:test";
import assert from "node:assert/strict";
import {coinsInCopper, craftingPlan, spendGold} from "../module/helpers/crafting.mjs";

test("2024 crafting: mundane by price, magic by rarity (half for consumables), a scroll by its spell's level", () => {
  assert.deepEqual(craftingPlan({price: 50}), {days: 5, cost: 25}, "a Longbow");
  assert.deepEqual(craftingPlan({price: 1}), {days: 1, cost: 0.5});
  assert.deepEqual(craftingPlan({price: 400, rarity: "uncommon"}), {days: 10, cost: 200});
  assert.deepEqual(craftingPlan({price: 50, rarity: "common", consumable: true}), {days: 3, cost: 25}, "a Potion of Healing");
  assert.deepEqual(craftingPlan({scrollLevel: 3}), {days: 5, cost: 150});
});

test("spending gold makes change from a character's coins, or refuses when it has too little", () => {
  assert.equal(coinsInCopper({gp: 3, sp: 5, cp: 2, pp: 1, ep: 2}), 1452);
  assert.deepEqual(spendGold({gp: 30}, 25), {pp: 0, gp: 5, sp: 0, cp: 0, ep: 0});
  assert.deepEqual(spendGold({pp: 1}, 0.5), {pp: 0, gp: 9, sp: 5, cp: 0, ep: 0});
  assert.equal(spendGold({gp: 1}, 2), null);
});
