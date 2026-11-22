import assert from "node:assert/strict";
import test from "node:test";

import {areaWallData, cellPolygons, outlineEdges, sceneCollision, sectionWallData, segmentOutside, wallsBlock} from "../module/adapters/foundry-v14-walls.mjs";

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

// A square 100-px grid as Foundry's: a field {x, y} is the offset {i: x, j: y}, i the row.
const grid = {isSquare: true, getVertices: ({i, j}) => [{x: j * 100, y: i * 100}, {x: (j + 1) * 100, y: i * 100},
  {x: (j + 1) * 100, y: (i + 1) * 100}, {x: j * 100, y: (i + 1) * 100}]};
const sorted = edges => edges.map(c => c.join(",")).sort();

test("an area's outline: the cell edges its fields do not share, each a whole-pixel Wall c", () => {
  const polygons = cellPolygons({grid}, [{x: 0, y: 0}, {x: 0, y: 1}]);
  assert.equal(polygons.length, 2);
  const edges = outlineEdges(polygons);
  assert.equal(edges.length, 6, "two fields side by side: six unit edges, the shared one left out");
  assert.ok(!sorted(edges).some(c => ["100,0,100,100", "100,100,100,0"].includes(c)), "not the edge between them");
  assert.deepEqual(outlineEdges([[{x: 0.4, y: 0}, {x: 10.6, y: 0}, {x: 10.6, y: 10}]])[0], [0, 0, 11, 0], "rounded to whole pixels");
});

test("areaWallData stops only the senses listed, both ways, on its caster's Level, flagged with its area", () => {
  const [data] = areaWallData([[0, 0, 100, 0]], {blocks: ["move"], level: "level-1", flags: {wildpath: {areaRegion: "region-1"}}});
  assert.deepEqual(data, {c: [0, 0, 100, 0], move: 20, sight: 0, light: 0, sound: 0, dir: 0, levels: ["level-1"],
    flags: {wildpath: {areaRegion: "region-1"}}}, "a WallDocument's unlisted senses would default to NORMAL");
  const [seen] = areaWallData([[0, 0, 100, 0]], {blocks: ["move", "sight"]});
  assert.deepEqual([seen.move, seen.sight, seen.light, seen.sound, "levels" in seen], [20, 20, 0, 0, false]);
  const previous = globalThis.CONST;
  globalThis.CONST = {EDGE_SENSE_TYPES: {NONE: 0, LIMITED: 10, NORMAL: 20}, WALL_MOVEMENT_TYPES: {NONE: 0, NORMAL: 20},
    EDGE_DIRECTIONS: {BOTH: 0, LEFT: 1, RIGHT: 2}};
  try {
    assert.deepEqual(areaWallData([[0, 0, 100, 0]], {blocks: ["sound"]})[0].sound, 20, "V14's constants when Foundry has them");
  } finally {
    if ( previous === undefined ) delete globalThis.CONST;
    else globalThis.CONST = previous;
  }
});

test("an area's walls stop a line through its fields and one into them, for the senses they block", () => {
  const walls = areaWallData(outlineEdges(cellPolygons({grid}, [{x: 0, y: 1}, {x: 1, y: 1}])), {blocks: ["move"]});
  const across = [{x: 50, y: 100}, {x: 250, y: 100}];
  assert.equal(block(walls, across), true, "across the two fields");
  assert.equal(block(walls, [{x: 50, y: 100}, {x: 150, y: 100}]), true, "into them");
  assert.equal(block(walls, across, {type: "sight"}), false, "sight passes walls that block movement only");
  assert.equal(block(walls, [{x: 50, y: 300}, {x: 250, y: 300}]), false, "a line beside them");
});

test("a section's walls: movement both ways, sight one way facing out, so its own cells are seen and nothing past them", () => {
  // Two cells side by side, pixels 0-200 by 0-100.
  const walls = sectionWallData(cellPolygons({grid}, [{x: 0, y: 0}, {x: 0, y: 1}]), {blocks: ["move", "sight"], level: "level-1",
    flags: {wildpath: {areaRegion: "region-1", section: 0}}});
  assert.equal(walls.length, 12, "two documents for each of its six outline edges");
  assert.deepEqual([...new Set(walls.map(wall => [wall.move, wall.sight, wall.light, wall.sound, wall.dir === 0].join()))].sort(),
    ["0,20,0,0,false", "20,0,0,0,true"], "a two-way movement wall and a one-way sight wall");
  assert.ok(walls.every(wall => (wall.levels.join() === "level-1") && (wall.flags.wildpath.section === 0)));
  const above = {x: 100, y: -100};
  const below = {x: 100, y: 300};
  assert.equal(block(walls, [above, {x: 50, y: 50}], {type: "sight"}), false, "a line from outside into it is not stopped");
  assert.equal(block(walls, [below, {x: 150, y: 50}], {type: "sight"}), false, "nor from the other side");
  assert.equal(block(walls, [{x: -100, y: 50}, {x: 150, y: 50}], {type: "sight"}), false, "nor along it, into its far cell");
  assert.equal(block(walls, [above, below], {type: "sight"}), true, "a line through it is");
  assert.equal(block(walls, [below, above], {type: "sight"}), true, "either way");
  assert.equal(block(walls, [above, {x: 50, y: 50}], {type: "move"}), true, "nothing moves into it");
  assert.deepEqual(sectionWallData(cellPolygons({grid}, [{x: 0, y: 0}]), {blocks: ["move"]}).map(wall => wall.dir), [0, 0, 0, 0],
    "blocking movement only: one two-way wall per edge");
});

test("segmentOutside: a wall's pieces outside the cells; itself when no cell cuts it, none when they cover it", () => {
  const cells = cellPolygons({grid}, [{x: 0, y: 1}]);
  assert.deepEqual(segmentOutside([0, 50, 300, 50], cells), [[0, 50, 100, 50], [200, 50, 300, 50]], "split around the cell");
  const beside = [0, 150, 300, 150];
  assert.equal(segmentOutside(beside, cells)[0], beside, "uncut: the same wall, the crossing test");
  assert.equal(segmentOutside([100, 0, 100, 100], cells).length, 1, "a wall along the cell's edge is not cut");
  assert.deepEqual(segmentOutside([120, 50, 180, 50], cells), [], "covered by the cell");
  assert.deepEqual(segmentOutside([0, 50, 300, 50], cellPolygons({grid}, [{x: 0, y: 1}, {x: 0, y: 2}])), [[0, 50, 100, 50]],
    "two cells together, the piece between them none");
  const corner = [0, 0, 200, 200];
  assert.equal(segmentOutside(corner, cells)[0], corner, "a diagonal touching only its corner is not cut");
  assert.deepEqual(segmentOutside([100, 0, 200, 100], cells), [], "one along its diagonal is");
  // A wall on a grid line: cut where cells lie on both sides of it, not along their outline. The block spans x 100-300, y 0-200.
  const block = cellPolygons({grid}, [{x: 0, y: 1}, {x: 1, y: 1}, {x: 0, y: 2}, {x: 1, y: 2}]);
  assert.deepEqual(segmentOutside([0, 100, 400, 100], block), [[0, 100, 100, 100], [300, 100, 400, 100]], "between its two rows: cut");
  assert.deepEqual(segmentOutside([200, 0, 200, 300], block), [[200, 200, 200, 300]], "between its two columns: cut");
  const rim = [0, 0, 400, 0];
  assert.equal(segmentOutside(rim, block)[0], rim, "along its outline: not cut");
});

test("segmentOutside on a hex cell: a wall through it is cut where it meets the hex's sides", () => {
  // A pointy-top hex of radius 50 around (100, 100), in the perimeter order grid.getVertices gives.
  const hex = [0, 1, 2, 3, 4, 5].map(index => ({x: 100 + (50 * Math.cos((Math.PI / 3 * index) - (Math.PI / 2))),
    y: 100 + (50 * Math.sin((Math.PI / 3 * index) - (Math.PI / 2)))}));
  assert.deepEqual(segmentOutside([0, 100, 200, 100], [hex]), [[0, 100, 57, 100], [143, 100, 200, 100]], "its flat sides at 100 -/+ 43.3");
  assert.deepEqual(segmentOutside([100, 0, 100, 200], [hex]), [[100, 0, 100, 50], [100, 150, 100, 200]], "its points at 50 and 150");
  const past = [0, 160, 200, 160];
  assert.equal(segmentOutside(past, [hex])[0], past, "a wall below its bottom point is not cut");
});
