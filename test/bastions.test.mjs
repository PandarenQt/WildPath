import {test} from "node:test";
import assert from "node:assert/strict";
import {canAddSpecial, defendersLost, mapProblems, mapSize, recruited, specialSlots, tradeSale} from "../module/helpers/bastions.mjs";
import {bastionTurn} from "../module/applications/bastions.mjs";

test("a Bastion's special facility slots and map size grow with its character's level", () => {
  assert.deepEqual([4, 5, 8, 9, 13, 17, 20].map(specialSlots), [0, 2, 2, 4, 5, 6, 6]);
  assert.deepEqual([5, 9, 13, 17].map(mapSize), [12, 16, 20, 24]);
});

test("a special facility needs character level 5, its own level, and a free slot", () => {
  assert.equal(canAddSpecial({level: 4})?.key, "WILDPATH.BASTION.TooYoung");
  assert.equal(canAddSpecial({level: 5, facilityLevel: 9})?.key, "WILDPATH.BASTION.TooLow");
  assert.equal(canAddSpecial({level: 5, facilityLevel: 5, specialCount: 2})?.key, "WILDPATH.BASTION.NoSlot");
  assert.equal(canAddSpecial({level: 9, facilityLevel: 5, specialCount: 2}), null);
});

test("a Bastion map is refused squares outside it, shared squares, and a facility past its space", () => {
  const facilities = {a: "cramped", b: "roomy"};
  assert.deepEqual(mapProblems([{x: 0, y: 0, facilityId: "a"}, {x: 1, y: 0, facilityId: "b"}], {size: 12, facilities}), []);
  const problems = mapProblems([{x: 12, y: 0, facilityId: "b"}, {x: 0, y: 0, facilityId: "b"}, {x: 0, y: 0, facilityId: "a"},
    ...[1, 2, 3, 4].map(x => ({x, y: 1, facilityId: "a"}))], {size: 12, facilities});
  assert.deepEqual(problems.map(problem => problem.key), ["WILDPATH.BASTION.MapOutside", "WILDPATH.BASTION.MapOverlap", "WILDPATH.BASTION.MapTooBig"]);
  assert.deepEqual(problems[2].data, {id: "a", count: 5, most: 4});
});

test("orders: Recruit adds up to 4 within what the facilities house, Trade sells at its profit, an attack costs each 1", () => {
  assert.equal(recruited(0, 12), 4);
  assert.equal(recruited(10, 12), 2);
  assert.equal(recruited(12, 12), 0);
  assert.equal(tradeSale(500, 10), 550);
  assert.equal(defendersLost([1, 3, 1, 6, 2, 1]), 3);
});

test("a Bastion turn: the orders issued its special facilities, and a quiet one when every facility maintains", () => {
  const facility = (name, kind, order) => ({type: "facility", name, system: {kind, current: {order}}});
  const busy = bastionTurn({items: [facility("Bedroom", "basic", "maintain"), facility("Arcane Study", "special", "craft"),
    facility("Garden", "special", "maintain")]});
  assert.deepEqual([busy.orders.map(entry => [entry.facility.name, entry.order]), busy.quiet], [[["Arcane Study", "craft"]], false]);
  assert.equal(bastionTurn({items: [facility("Garden", "special", "maintain")]}).quiet, true);
  assert.equal(bastionTurn({items: [facility("Bedroom", "basic", "maintain")]}).quiet, false, "no special facility: no Bastion turn");
});
