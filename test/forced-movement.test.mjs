import {test} from "node:test";
import assert from "node:assert/strict";
import {createFoundryForcedMovement, forcedDestination, pushLanding} from "../module/adapters/foundry-v14-forced-movement.mjs";
import {FOUNDRY_GRID_TYPES} from "../module/adapters/foundry-v14-tactical-grid-adapter.mjs";
import {pushable} from "../module/helpers/forced-movement.mjs";

/** A square 100-px, 5-ft grid Scene of 1x1 Tokens (`[id, x, y, width]`), and a wall document along `wallX` if given. */
function scene(tokens, {wallX=null}={}) {
  const world = {grid: {isSquare: true, size: 100, sizeX: 100, sizeY: 100, distance: 5, units: "ft", type: FOUNDRY_GRID_TYPES.SQUARE,
    isHexagonal: false, isGridless: false,
    // As Foundry's square grid (offset i the row, j the column), for a chosen landing's checks (pushLanding).
    getOffset: point => ({i: Math.floor(point.y / 100), j: Math.floor(point.x / 100)}),
    getTopLeftPoint: offset => ({x: offset.j * 100, y: offset.i * 100}),
    getCenterPoint: offset => ({x: (offset.j * 100) + 50, y: (offset.i * 100) + 50}),
    getVertices: ({i, j}) => [{x: j * 100, y: i * 100}, {x: (j + 1) * 100, y: i * 100}, {x: (j + 1) * 100, y: (i + 1) * 100}, {x: j * 100, y: (i + 1) * 100}],
    getAdjacentOffsets: ({i, j}) => [{i: i - 1, j}, {i, j: j + 1}, {i: i + 1, j}, {i, j: j - 1}],
    measurePath: ([a, b]) => ({distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 100 * 5})},
    dimensions: {distance: 5, units: "ft", size: 100, sceneX: 0, sceneY: 0, sceneWidth: 3000, sceneHeight: 3000, columns: 30, rows: 30,
      sceneRect: {contains: (x, y) => (x >= 0) && (y >= 0) && (x < 3000) && (y < 3000)}}, tokens: null,
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
  // Repelling Blast: each beam that hits pushes its creature (one hit result per beam).
  const beams = scene([["caster", 1000, 1000], ["target", 1100, 1000]]);
  await createFoundryForcedMovement({game, fromUuid: () => beams.tokens.get("caster")}).afterResolution({state: {source: {tokenRef: "caster"},
    actionDefinition: {attack: {type: "ranged"}, push: {distance: 10}}, results: {attackResolution: {hits: [{target: {tokenId: "target"}},
      {target: {tokenId: "target"}}]}}}});
  assert.deepEqual(beams.tokens.get("target").updates.map(update => update.data), [{x: 1300, y: 1000}, {x: 1500, y: 1000}], "10 feet a beam");
  assert.deepEqual(await createFoundryForcedMovement({game: {user: {id: "player"}, users: {activeGM: {id: "gm"}}},
    fromUuid: () => walled.tokens.get("caster")}).afterResolution({state}), [], "only the active GM moves them");
});

test("a reaction shortens the push on its own creature only (Dwarven Plate: input.pushReduction by Token id)", async () => {
  const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}};
  const push = async (reduction, definition={save: {ability: "fortitude"}, push: {distance: 10}}, input={}) => {
    const world = scene([["caster", 1000, 1000], ["failed", 1100, 1000], ["other", 1000, 1100]]);
    const moved = await createFoundryForcedMovement({game, fromUuid: () => world.tokens.get("caster")}).afterResolution({state: {
      source: {tokenRef: "caster"}, actionDefinition: definition, input: {...input, pushReduction: reduction},
      results: {saveResolution: {results: [{ok: true, success: false, target: {tokenId: "failed"}},
        {ok: true, success: false, target: {tokenId: "other"}}]}, attackResolution: {hits: [{target: {tokenId: "failed"}}]}}}});
    return {world, moved: moved.map(token => token.id).sort()};
  };
  const full = await push({failed: 10});
  assert.deepEqual(full.moved, ["other"], "a 10-foot push shortened by 10 feet moves nobody");
  assert.deepEqual(full.world.tokens.get("failed").updates, []);
  assert.deepEqual(full.world.tokens.get("other").updates[0].data, {x: 1000, y: 1300}, "a creature without one still moves two fields");
  const part = await push({failed: 5});
  assert.equal(part.world.tokens.get("failed").x, 1200, "5 feet off leaves one field");
  // Forceful Blow: a reaction's push on its hit (`riderPush`), shortened the same way.
  const rider = await push({failed: 10}, {attack: {type: "melee"}}, {riderPush: {distance: 15}});
  assert.deepEqual(rider.moved, ["failed"]);
  assert.equal(rider.world.tokens.get("failed").x, 1200, "15 feet less 10 is one field");
});

test("a push judges size as the before-push window does: an actor's size on a 1x1 Token, not the Token's fields", async () => {
  const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}};
  const world = scene([["caster", 1000, 1000], ["giant", 1100, 1000], ["ogre", 900, 1000]]);
  world.tokens.get("giant").actor = {system: {traits: {size: "huge"}}};
  world.tokens.get("ogre").actor = {system: {traits: {size: "large"}}};
  const moved = await createFoundryForcedMovement({game, fromUuid: () => world.tokens.get("caster")}).afterResolution({state: {
    source: {tokenRef: "caster"}, actionDefinition: {attack: {type: "melee"}, push: {distance: 10, maxSize: "large"}},
    results: {attackResolution: {hits: [{target: {tokenId: "giant"}}, {target: {tokenId: "ogre"}}]}}}});
  assert.deepEqual(moved.map(token => token.id), ["ogre"], "a Huge creature on a 1x1 Token is too big to push");
  assert.deepEqual(world.tokens.get("giant").updates, []);
  assert.equal(pushable("medium", "small"), false, "a Medium creature is bigger than Small");
  assert.equal(pushable("small", "medium"), true);
  assert.equal(pushable(null, "large"), true, "an unknown size is pushed");
});

test("an aimed push stops on its landing (until), straight or diagonal; without it a pull walks its fields as before", () => {
  const world = scene([["target", 1000, 1000]]);
  const target = world.tokens.get("target");
  const landing = {x: 1300, y: 1000};
  assert.deepEqual(forcedDestination(target, target.getCenterPoint(landing), 6, {toward: true, blocked: never, until: landing}), landing,
    "3 fields of 6");
  assert.deepEqual(forcedDestination(target, target.getCenterPoint(landing), 6, {toward: true, blocked: never}), {x: 1600, y: 1000},
    "without until it walks all 6 (a pull's source blocks its end)");
  const diagonal = {x: 1200, y: 1300};
  assert.deepEqual(forcedDestination(target, target.getCenterPoint(diagonal), 6, {toward: true, blocked: never, until: diagonal}), diagonal);
});

test("an aimed push (choose) moves only its aimed creature to options.pushTo, as forced movement; walls stop it; none without a landing", async () => {
  const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}};
  const run = async (options, {wallX=null}={}) => {
    const world = scene([["caster", 1000, 1000], ["failed", 1200, 1000], ["other", 1000, 1200]], {wallX});
    const moved = await createFoundryForcedMovement({game, fromUuid: () => world.tokens.get("caster")}).afterResolution({options, state: {
      source: {tokenRef: "caster"}, actionDefinition: {save: {ability: "might"}, push: {distance: 30, choose: "space"}},
      results: {saveResolution: {results: [{ok: true, success: false, target: {tokenId: "failed"}},
        {ok: true, success: false, target: {tokenId: "other"}}]}}}});
    return {world, moved: moved.map(token => token.id)};
  };
  const aimed = await run({pushTo: {tokenId: "failed", x: 1200, y: 1300}});
  assert.deepEqual(aimed.moved, ["failed"], "the other failed creature is not aimed, so it stays");
  assert.deepEqual(aimed.world.tokens.get("failed").updates, [{data: {x: 1200, y: 1300}, operation: {wildpath: {movementKind: "forced"}}}]);
  assert.deepEqual(aimed.world.tokens.get("other").updates, []);
  const walled = await run({pushTo: {tokenId: "failed", x: 1500, y: 1000}}, {wallX: 1390});
  assert.equal(walled.world.tokens.get("failed").x, 1300, "a wall stops it short of its landing");
  assert.deepEqual((await run({})).moved, [], "nobody moves without a landing");
});

test("a push with no save or attack moves its targets (Reel)", async () => {
  const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}};
  const world = scene([["roper", 1000, 1000], ["held", 1500, 1000]]);
  const moved = await createFoundryForcedMovement({game, fromUuid: () => world.tokens.get("roper")}).afterResolution({state: {
    source: {tokenRef: "roper"}, actionDefinition: {push: {distance: 30, toward: true}}, targets: [{tokenId: "held"}]}});
  assert.deepEqual(moved.map(token => token.id), ["held"]);
  assert.equal(world.tokens.get("held").x, 1100, "pulled until the roper's own space stops it");
});

test("pushLanding: a free field on the Scene within the push's distance, within range with inRange, on the line with choose: line", () => {
  const world = scene([["caster", 1000, 1000], ["target", 1200, 1000], ["ogre", 1400, 1000]]);
  const [token, sourceToken] = [world.tokens.get("target"), world.tokens.get("caster")];
  const land = (point, push, definition={}) => pushLanding({token, sourceToken, point, push, definition});
  assert.deepEqual(land({x: 1250, y: 1650}, {distance: 30, choose: "space"}), {ok: true, position: {x: 1200, y: 1600}});
  assert.deepEqual(land({x: 1950, y: 1050}, {distance: 30, choose: "space"}), {ok: false, key: "WILDPATH.PUSH.OutOfRange"});
  assert.deepEqual(land({x: 1450, y: 1050}, {distance: 30, choose: "space"}), {ok: false, key: "WILDPATH.TELEPORT.Occupied"});
  assert.deepEqual(land({x: 1250, y: -50}, {distance: 30, choose: "space"}), {ok: false, key: "WILDPATH.TELEPORT.OffScene"});
  const range = {range: {type: "ranged", normal: {value: 20, unit: "ft"}}};
  assert.deepEqual(land({x: 1250, y: 1650}, {distance: 30, choose: "space", inRange: true}, range),
    {ok: false, key: "WILDPATH.PUSH.OutOfReach"}, "30 feet from the caster, beyond its 20-foot range");
  assert.equal(land({x: 1250, y: 1350}, {distance: 30, choose: "space", inRange: true}, range).ok, true, "within its range");
  assert.deepEqual(land({x: 1350, y: 1050}, {distance: 5, choose: "line"}), {ok: true, position: {x: 1300, y: 1000}}, "5 feet away");
  assert.deepEqual(land({x: 1150, y: 1050}, {distance: 5, choose: "line"}), {ok: true, position: {x: 1100, y: 1000}}, "5 feet toward");
  assert.deepEqual(land({x: 1250, y: 1150}, {distance: 5, choose: "line"}), {ok: false, key: "WILDPATH.PUSH.OffLine"}, "off the line");
  assert.deepEqual(land({x: 950, y: 1050}, {distance: 20, choose: "line"}), {ok: false, key: "WILDPATH.PUSH.OffLine"},
    "toward ends at the caster's space: the walk never reaches the far side");
  assert.deepEqual(pushLanding({token: null, sourceToken, point: {x: 0, y: 0}, push: {distance: 5, choose: "space"}, definition: {}}),
    {ok: false, key: "WILDPATH.PUSH.NoTarget"});
});

test("pushLanding refuses a landing its creature's walk could not reach: a creature or a wall on the straight way stops it first", async () => {
  // A free space past the ogre beside it was accepted, and the walk, stopped at once, moved nothing (the suspected
  // cause of a live 2026-11-14 report; the live Tokens' positions were not checked).
  const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}};
  const world = scene([["caster", 1000, 1000], ["target", 1200, 1000], ["ogre", 1300, 1000]], {wallX: 1190});
  const [token, sourceToken] = [world.tokens.get("target"), world.tokens.get("caster")];
  const land = (point, push={distance: 30, choose: "space"}) => pushLanding({token, sourceToken, point, push, definition: {}});
  assert.deepEqual(land({x: 1550, y: 1050}), {ok: false, key: "WILDPATH.PUSH.Blocked"}, "the ogre stands on the way");
  const moved = await createFoundryForcedMovement({game, fromUuid: () => sourceToken}).afterResolution({options: {pushTo: {tokenId: "target", x: 1500, y: 1000}},
    state: {source: {tokenRef: "caster"}, actionDefinition: {save: {ability: "might"}, push: {distance: 30, choose: "space"}},
      results: {saveResolution: {results: [{ok: true, success: false, target: {tokenId: "target"}}]}}}});
  assert.deepEqual(moved, [], "which is why: its walk there moves it nowhere");
  assert.deepEqual(land({x: 1150, y: 1150}), {ok: false, key: "WILDPATH.PUSH.Blocked"}, "a wall on the way");
  assert.deepEqual(land({x: 1550, y: 1350}), {ok: true, position: {x: 1500, y: 1300}}, "a way around the ogre's space");
  assert.deepEqual(land({x: 1250, y: 1650}), {ok: true, position: {x: 1200, y: 1600}});
  assert.deepEqual(land({x: 1150, y: 1050}, {distance: 5, choose: "line"}), {ok: false, key: "WILDPATH.PUSH.Blocked"},
    "a line landing behind a wall");
});
