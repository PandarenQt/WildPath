import {test} from "node:test";
import assert from "node:assert/strict";
import {observersLeftBehind} from "../module/helpers/movement-transition.mjs";

const at = (x, y) => ({topology: "square", fields: [{x, y}]});

test("a path warns of every observer whose reach it leaves at some step, not those it only enters or passes far from", () => {
  const observers = [
    {id: "ogre", footprint: at(1, 1), reachFields: 1},
    {id: "pike", footprint: at(5, 5), reachFields: 2},
    {id: "far", footprint: at(20, 20), reachFields: 1}
  ];
  // From beside the ogre, through the pikeman's reach, out the other side.
  const path = [at(0, 0), at(-1, 0), at(-1, 3), at(4, 3), at(4, 8)];
  assert.deepEqual(observersLeftBehind(path, observers).sort(), ["ogre", "pike"]);
  assert.deepEqual(observersLeftBehind([at(0, 0)], observers), [], "standing still leaves no one");
  assert.deepEqual(observersLeftBehind([at(-1, -1), at(0, 0)], observers), [], "stepping into reach provokes nothing");
});
