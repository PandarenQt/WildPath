import {test} from "node:test";
import assert from "node:assert/strict";
import {createFoundryCarry} from "../module/adapters/foundry-v14-carry.mjs";

/**
 * A square 100-px, 5-ft grid Scene of 1x1 Tokens (`[id, row, column, carriedBy]`), a wall along `wallX` if given. A
 * tactical field is `{x: row, y: column}` (the tactical grid adapter's reading of Foundry's `{i, j}` offsets).
 */
function world(tokens, {wallX=null, gridless=false}={}) {
  const scene = {id: "scene", grid: gridless ? {isGridless: true} : {isSquare: true, size: 100, sizeX: 100, sizeY: 100, distance: 5,
    getCenterPoint: ({i, j}) => ({x: (j * 100) + 50, y: (i * 100) + 50})},
  dimensions: {sceneRect: {contains: (x, y) => (x >= 0) && (y >= 0) && (x < 3000) && (y < 3000)}}, tokens: null,
  walls: (wallX == null) ? [] : [{c: [wallX, 0, wallX, 3000], move: 20, sight: 20, light: 20, dir: 0, door: 0, ds: 0}]};
  const list = tokens.map(([id, row, column, carriedBy=null]) => {
    const effects = carriedBy ? [{statuses: new Set(["carried"]), flags: {wildpath: {conditionEffect: {sourceRef: `Actor.${carriedBy}`}}}}] : [];
    const token = {id, x: column * 100, y: row * 100, parent: scene, updates: [], actor: {id, uuid: `Actor.${id}`, effects},
      getCenterPoint: (p=token) => ({x: p.x + 50, y: p.y + 50}),
      getOccupiedGridSpaceOffsets: (p=token) => [{i: p.y / 100, j: p.x / 100}],
      update: async (data, operation) => { token.updates.push({data, operation}); Object.assign(token, data); }};
    return token;
  });
  scene.tokens = Object.assign(list, {get: id => list.find(token => token.id === id)});
  const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, scenes: Object.assign([scene], {get: id => (id === "scene" ? scene : undefined)})};
  return {scene, game, carry: createFoundryCarry({game})};
}

/** The monk's move along `route` (`[row, column]` fields, its start first), as the authority reports it ending. */
function ended(route, {type="movement.completed", kind="voluntary", walked=route.length}={}) {
  const anchors = route.slice(0, walked).map(([x, y]) => ({x, y}));
  return {type, data: {movementKind: kind, tokenRef: "token:scene.monk", completedAnchors: anchors,
    origin: {anchor: anchors[0], footprint: {fields: [anchors[0]]}},
    actualDestination: {anchor: anchors.at(-1), footprint: {fields: [anchors.at(-1)]}}}};
}
const position = token => ({x: token.x, y: token.y});

test("a creature Carried by the monk walks the monk's route after it, as forced movement; nobody else moves", async () => {
  const {scene, carry} = world([["monk", 10, 10], ["ally", 10, 9, "monk"], ["bystander", 12, 9], ["other", 12, 12, "someone-else"]]);
  const moved = await carry.onMovementEvent(ended([[10, 10], [10, 11], [11, 12]]));
  assert.deepEqual(moved.map(token => token.id), ["ally"]);
  assert.deepEqual(scene.tokens.get("ally").updates, [{data: {x: 1100, y: 1100}, operation: {movement: {ally: {waypoints:
    [{x: 1000, y: 1000}, {x: 1100, y: 1100}], showRuler: false}}, wildpath: {movementKind: "forced"}}}], "its own route, step by step");
  assert.deepEqual([scene.tokens.get("bystander").updates, scene.tokens.get("other").updates], [[], []],
    "an uncarried creature, and one another creature carries, stay");
});

test("only the active GM carries, only after a voluntary move, and not on a gridless Scene or a move with no steps", async () => {
  const route = [[10, 10], [10, 11], [10, 12]];
  for ( const [label, event, setup] of [["forced", ended(route, {kind: "forced"})], ["teleport", ended(route, {kind: "teleport"})],
    ["not GM", ended(route), game => { game.user.id = "player"; }], ["no steps", ended(route, {walked: 1})],
    ["other event", ended(route, {type: "movement.transition"})], ["gridless", ended(route), null, true]] ) {
    const {scene, game, carry} = world([["monk", 10, 10], ["ally", 10, 9, "monk"]], {gridless: setup === null});
    setup?.(game);
    assert.deepEqual(await carry.onMovementEvent(event), [], label);
    assert.deepEqual(scene.tokens.get("ally").updates, [], label);
  }
});

test("a wall or another creature in the way stops the carried creature at its last free step", async () => {
  const walled = world([["monk", 10, 10], ["ally", 10, 9, "monk"]], {wallX: 1190});
  await walled.carry.onMovementEvent(ended([[10, 10], [10, 11], [10, 12], [10, 13]]));
  assert.deepEqual(position(walled.scene.tokens.get("ally")), {x: 1100, y: 1000}, "the wall between columns 11 and 12 stops it");
  const crowded = world([["monk", 10, 10], ["ally", 10, 9, "monk"], ["rock", 10, 12]]);
  await crowded.carry.onMovementEvent(ended([[10, 10], [10, 11], [10, 12], [10, 13]]));
  assert.deepEqual(position(crowded.scene.tokens.get("ally")), {x: 1100, y: 1000}, "a creature's space stops it");
});

test("an interrupted move carries it only as far as the monk walked", async () => {
  const {scene, carry} = world([["monk", 10, 10], ["ally", 10, 9, "monk"]]);
  await carry.onMovementEvent(ended([[10, 10], [10, 11], [10, 12], [10, 13]], {type: "movement.interrupted", walked: 2}));
  assert.deepEqual(position(scene.tokens.get("ally")), {x: 1000, y: 1000});
});

test("it passes through the monk's spaces on the way but never stops on the one the monk ends in", async () => {
  // The monk goes round a loop and ends at (10, 11); the ally, one column behind, reaches (10, 11) and is then blocked.
  const {scene, carry} = world([["monk", 10, 10], ["ally", 10, 9, "monk"], ["rock", 11, 11]]);
  await carry.onMovementEvent(ended([[10, 10], [10, 11], [10, 12], [11, 12], [11, 11], [10, 11]]));
  assert.deepEqual(position(scene.tokens.get("ally")), {x: 1000, y: 1000}, "it stops a step short instead");
});

test("a creature left behind (no longer within 5 feet of where its carrier set out) is not moved with it", async () => {
  const {scene, carry} = world([["monk", 10, 10], ["ally", 10, 7, "monk"]]);
  assert.deepEqual(await carry.onMovementEvent(ended([[10, 10], [9, 10], [8, 10]])), []);
  assert.deepEqual(scene.tokens.get("ally").updates, [], "15 feet away: it stays");
});

test("two quick moves carry in order: the second starts where the first left the creature", async () => {
  const {scene, carry} = world([["monk", 10, 10], ["ally", 10, 9, "monk"]]);
  // As the server does: the position lands only after a round trip.
  const ally = scene.tokens.get("ally");
  const write = ally.update;
  ally.update = async (data, operation) => { await new Promise(resolve => setTimeout(resolve, 20)); return write(data, operation); };
  const first = carry.onMovementEvent(ended([[10, 10], [10, 11]]));
  const second = carry.onMovementEvent(ended([[10, 11], [10, 12]]));
  await Promise.all([first, second]);
  assert.deepEqual(scene.tokens.get("ally").updates.map(update => update.data), [{x: 1000, y: 1000}, {x: 1100, y: 1000}]);
});
