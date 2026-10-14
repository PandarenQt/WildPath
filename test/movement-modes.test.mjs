import {test} from "node:test";
import assert from "node:assert/strict";
import {movementAllowance, movementSpeeds, remainingMovement} from "../module/helpers/movement-modes.mjs";

test("Speeds are walking Speed plus the fastest grant for each mode", () => {
  assert.deepEqual(movementSpeeds(30, [{mode: "fly", distance: 30}, {mode: "fly", distance: 60}, {mode: "walk", distance: 25}]),
    {walk: 30, fly: 60});
  assert.deepEqual(movementSpeeds(30, [{mode: "walk", distance: 40}]), {walk: 40});
});

test("2024 modes: own Speed, double cost without a swim or climb Speed, crawling always double, flying needs its Speed", () => {
  const speeds = {walk: 30, swim: 40};
  assert.deepEqual(movementAllowance("swim", speeds), {ok: true, speed: 40, costMultiplier: 1});
  assert.deepEqual(movementAllowance("climb", speeds), {ok: true, speed: 30, costMultiplier: 2});
  assert.deepEqual(movementAllowance("crawl", speeds), {ok: true, speed: 30, costMultiplier: 2});
  assert.deepEqual(movementAllowance("jump", speeds), {ok: true, speed: 30, costMultiplier: 1});
  assert.equal(movementAllowance("fly", speeds).code, "MOVEMENT_MODE_NOT_SUPPORTED");
  assert.equal(movementAllowance("burrow", speeds).ok, false);
  assert.deepEqual(movementAllowance("blink", speeds), {ok: true, speed: 30, costMultiplier: 1}, "an unknown mode walks");
});

test("switching modes subtracts what was already moved from the new Speed", () => {
  const speeds = {walk: 30, fly: 60};
  assert.equal(remainingMovement("fly", speeds, 35), 25);
  assert.equal(remainingMovement("walk", speeds, 35), 0);
  assert.equal(remainingMovement("burrow", speeds, 0), 0);
});
