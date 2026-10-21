import {test} from "node:test";
import assert from "node:assert/strict";
import {bastionTurn} from "../module/applications/bastions.mjs";

test("a Bastion turn: the orders issued its special facilities, and a quiet one when every facility maintains", () => {
  const facility = (name, kind, order) => ({type: "facility", name, system: {kind, current: {order}}});
  const busy = bastionTurn({items: [facility("Bedroom", "basic", "maintain"), facility("Arcane Study", "special", "craft"),
    facility("Garden", "special", "maintain")]});
  assert.deepEqual([busy.orders.map(entry => [entry.facility.name, entry.order]), busy.quiet], [[["Arcane Study", "craft"]], false]);
  assert.equal(bastionTurn({items: [facility("Garden", "special", "maintain")]}).quiet, true);
  assert.equal(bastionTurn({items: [facility("Bedroom", "basic", "maintain")]}).quiet, false, "no special facility: no Bastion turn");
});
