import {test} from "node:test";
import assert from "node:assert/strict";
import {createFoundryForcedMovement, forcedDestination} from "../module/adapters/foundry-v14-forced-movement.mjs";

/** A square 100-px, 5-ft grid Scene of 1x1 Tokens (`[id, x, y, width]`), and a wall document along `wallX` if given. */
function scene(tokens, {wallX=null}={}) {
  const world = {grid: {isSquare: true, size: 100, sizeX: 100, sizeY: 100, distance: 5},
    dimensions: {sceneRect: {contains: (x, y) => (x >= 0) && (y >= 0) && (x < 3000) && (y < 3000)}}, tokens: null,
    walls: (wallX == null) ? [] : [{c: [wallX, 0, wallX, 3000], move: 20, sight: 20, light: 20, dir: 0, door: 0, ds: 0}]};
  const list = tokens.map(([id, x, y, width=1]) => {
    const token = {id, x, y, width, height: width, parent: world, updates: [],
      getCenterPoint: (p=token) => ({x: p.x + (width * 50), y: p.y + (width * 50)}),
      getSnappedPosition: p => ({x: Math.round(p.x / 100) * 100, y: Math.round(p.y / 100) * 100}),
      getOccupiedGridSpaceOffsets: (p=token) => Array.from({length: width * width}, (_, n) =>
        ({i: (p.y / 100) + Math.floor(n / width), j: (p.x / 100) + (n % width)})),
      update: async (data, operation) => { token.updates.push({data, operation}); Object.assign(token, data); }};
    return token;
  });
  world.tokens = Object.assign(list, {get: id => list.find(token => token.id === id)});
  return world;
}
const never = () => false;

test("a push steps a field at a time straight away from its source; a pull steps toward it", () => {
  const world = scene([["caster", 1000, 1000], ["east", 1100, 1000], ["diagonal", 1100, 1100]]);
  const from = world.tokens.get("caster").getCenterPoint();
  assert.deepEqual(forcedDestination(world.tokens.get("east"), from, 2, {blocked: never}), {x: 1300, y: 1000});
  assert.deepEqual(forcedDestination(world.tokens.get("diagonal"), from, 2, {blocked: never}), {x: 1300, y: 1300},
    "a diagonal push crosses diagonals");
  const far = scene([["caster", 1000, 1000], ["far", 1600, 1000]]);
  assert.deepEqual(forcedDestination(far.tokens.get("far"), from, 2, {toward: true, blocked: never}), {x: 1400, y: 1000});
});

test("an Action's push moves the creatures it hit or that failed their saves, as forced movement, stopping at walls and creatures", async () => {
  const world = scene([["caster", 1000, 1000], ["failed", 1100, 1000], ["saved", 900, 1000], ["blocked", 1000, 1100],
    ["wall", 1000, 900], ["giant", 1000, 1300, 3]]);
  world.tokens.get("blocked").getOccupiedGridSpaceOffsets = (p=world.tokens.get("blocked")) => [{i: p.y / 100, j: p.x / 100}];
  const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}};
  const pushes = createFoundryForcedMovement({game, fromUuid: uuid => (uuid === "caster" ? world.tokens.get("caster") : null)});
  const state = {source: {tokenRef: "caster"}, actionDefinition: {save: {ability: "fortitude"}, push: {distance: 10, maxSize: "large"}},
    results: {saveResolution: {results: [{ok: true, success: false, target: {tokenId: "failed"}},
      {ok: true, success: true, target: {tokenId: "saved"}}, {ok: true, success: false, target: {tokenId: "giant"}},
      {ok: true, success: false, target: {tokenId: "blocked"}}]}}};
  const moved = await pushes.afterResolution({state});
  assert.deepEqual(moved.map(token => token.id).sort(), ["blocked", "failed"], "a success, and one too big, stay");
  assert.deepEqual(world.tokens.get("failed").updates, [{data: {x: 1300, y: 1000}, operation: {wildpath: {movementKind: "forced"}}}]);
  assert.deepEqual(world.tokens.get("blocked").updates[0].data, {x: 1000, y: 1200}, "stopped by the giant two fields behind it");
  const saved = await createFoundryForcedMovement({game, fromUuid: () => world.tokens.get("caster")}).afterResolution({state:
    {...state, actionDefinition: {...state.actionDefinition, push: {distance: 5, on: "success"}}}});
  assert.deepEqual(saved.map(token => token.id), ["saved"], "pushed on a success instead");

  const walled = scene([["caster", 1000, 1000], ["target", 1100, 1000]], {wallX: 1290});
  const wallPush = createFoundryForcedMovement({game, fromUuid: () => walled.tokens.get("caster")});
  await wallPush.afterResolution({state: {source: {tokenRef: "caster"}, actionDefinition: {attack: {type: "melee"}, push: {distance: 10}},
    results: {attackResolution: {hits: [{target: {tokenId: "target"}}]}}}});
  assert.deepEqual(walled.tokens.get("target").updates[0].data, {x: 1200, y: 1000}, "a wall stops it");
  assert.deepEqual(await createFoundryForcedMovement({game: {user: {id: "player"}, users: {activeGM: {id: "gm"}}},
    fromUuid: () => walled.tokens.get("caster")}).afterResolution({state}), [], "only the active GM moves them");
});
