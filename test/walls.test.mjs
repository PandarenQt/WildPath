import assert from "node:assert/strict";
import test from "node:test";

import {sceneCollision, wallsBlock} from "../module/adapters/foundry-v14-walls.mjs";

// A vertical wall at x = 100 from y = 0 to 200; lines cross it from (0, 100) to (200, 100) and back.
const wall = (data={}) => ({c: [100, 0, 100, 200], move: 20, sight: 20, light: 20, sound: 20, dir: 0, door: 0, ds: 0, ...data});
const east = [{x: 0, y: 100}, {x: 200, y: 100}];
const west = [{x: 200, y: 100}, {x: 0, y: 100}];
const block = (walls, [from, to], options={}) => wallsBlock({walls}, from, to, options);

test("a wall on the line stops it; one beside it or behind its end does not", () => {
  assert.equal(block([wall()], east), true);
  assert.equal(block([wall({c: [300, 0, 300, 200]})], east), false, "beyond the destination");
  assert.equal(block([wall({c: [100, 150, 100, 300]})], east), false, "the line passes its end");
  assert.equal(block([], east), false);
});

test("what a wall stops: its own senses, an open door nothing, a one-way wall one side only", () => {
  assert.equal(block([wall({move: 0})], east, {type: "move"}), false, "a wall that lets bodies through");
  assert.equal(block([wall({move: 0})], east, {type: "sight"}), true, "still stops sight");
  assert.equal(block([wall({door: 1, ds: 1})], east), false, "an open door");
  assert.equal(block([wall({door: 1, ds: 0})], east), true, "a closed door");
  const oneWay = [wall({dir: 1})];
  assert.notEqual(block(oneWay, east), block(oneWay, west), "a one-way wall stops one direction only");
});

test("Limited walls stop sight and light only two at once, movement at once", () => {
  const limited = wall({sight: 10, light: 10, move: 20});
  assert.equal(block([limited], east, {type: "sight"}), false);
  assert.equal(block([limited, wall({c: [150, 0, 150, 200], sight: 10})], east, {type: "sight"}), true);
  assert.equal(block([limited], east, {type: "move"}), true);
});

test("on the Scene the canvas shows, Foundry's own backend decides", () => {
  const scene = {walls: [wall()]};
  const asked = [];
  const backends = {sight: {testCollision: (origin, destination, options) => { asked.push(options.type); return false; }}};
  assert.equal(sceneCollision(scene, {canvas: {scene}, backends})(east[0], east[1], {type: "sight"}), false);
  assert.deepEqual(asked, ["sight"]);
  assert.equal(sceneCollision(scene, {canvas: {scene: {}}, backends})(east[0], east[1], {type: "sight"}), true, "another Scene: its walls");
});
