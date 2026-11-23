import {test} from "node:test";
import assert from "node:assert/strict";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {FOUNDRY_GRID_TYPES} from "../module/adapters/foundry-v14-tactical-grid-adapter.mjs";
import {foundryAreaFootprint} from "../module/adapters/foundry-v14-area-placement.mjs";
import {areaOfFlag, persistentAreaRegionData} from "../module/adapters/foundry-v14-persistent-areas.mjs";

/** The validation errors' paths of an area Action of this shape, size (feet), width (feet) and persistence. */
const reasons = (shape, size, width, persistence=null) => validateActionDefinition({schemaVersion: 1, id: "action:ring", label: "Ring",
  costs: {allOf: []}, targeting: {type: "area"}, area: {shape, size: {value: size, unit: "ft"},
    ...(width === undefined ? {} : {width: {value: width, unit: "ft"}}), ...(persistence ? {persistence} : {})}})
  .errors.map(error => error.path);

test("an area's width is validated: a ring below its size, a wall above 0, refused where ignored; a line's as before", () => {
  assert.deepEqual(reasons("radial", 30, 5), [], "Blade Barrier's ring");
  assert.deepEqual(reasons("radial", 15, 1), [], "a thin globe");
  assert.deepEqual(reasons("wall", 300, 50), [], "Tsunami");
  assert.deepEqual(reasons("radial", 30, undefined), [], "no width, filled");
  for ( const [shape, size, width] of [["radial", 30, 30], ["radial", 30, 40], ["radial", 30, 0], ["wall", 60, 0], ["wall", 60, "thick"]] ) {
    assert.deepEqual(reasons(shape, size, width), ["area.width.value"], `${shape} ${size} ${width}`);
  }
  assert.deepEqual(reasons("wall", 100, 1, {blocks: ["move"], sections: {size: 10, ac: 12, hp: 30}}), [],
    "Wall of Ice's 1-ft sections (wallSections cuts across a thick wall too)");
  // Where it would be ignored, it is refused: another shape, or an area laid out again around its object.
  for ( const shape of ["emanation", "cube", "cone", "cylinder"] ) assert.deepEqual(reasons(shape, 30, 5), ["area.width.value"], shape);
  assert.deepEqual(reasons("radial", 30, 5, {onObject: "object"}), ["area.width.value"], "a hollow area on an object");
  assert.deepEqual(reasons("line", 30, 1), [], "a line's width is not checked here, as before");
  assert.deepEqual(reasons("line", 30, 60), []);
});

/** A 100-px, 5-ft square Scene with a 1x1 caster at its top-left square. */
function world() {
  const scene = {id: "scene", grid: {isSquare: true, size: 100, sizeX: 100, sizeY: 100, distance: 5, units: "ft",
    type: FOUNDRY_GRID_TYPES.SQUARE, isHexagonal: false, isGridless: false,
    getOffset: point => ({i: Math.floor(point.y / 100), j: Math.floor(point.x / 100)}),
    getTopLeftPoint: offset => ({x: offset.j * 100, y: offset.i * 100}),
    getCenterPoint: offset => ({x: (offset.j * 100) + 50, y: (offset.i * 100) + 50}),
    getVertices: ({i, j}) => [{x: j * 100, y: i * 100}, {x: (j + 1) * 100, y: i * 100}, {x: (j + 1) * 100, y: (i + 1) * 100}, {x: j * 100, y: (i + 1) * 100}],
    getAdjacentOffsets: ({i, j}) => [{i: i - 1, j}, {i, j: j + 1}, {i: i + 1, j}, {i, j: j - 1}]},
  dimensions: {distance: 5, units: "ft", size: 100, sceneX: 0, sceneY: 0, sceneWidth: 3000, sceneHeight: 3000, columns: 30, rows: 30}};
  const caster = {id: "caster", x: 0, y: 0, width: 1, height: 1, elevation: 0, parent: scene, actor: {uuid: "Actor.caster", statuses: new Set()},
    getCenterPoint: (p=caster) => ({x: p.x + 50, y: p.y + 50}),
    getOccupiedGridSpaceOffsets: (p=caster) => [{i: p.y / 100, j: p.x / 100}]};
  scene.tokens = Object.assign([caster], {get: id => (id === "caster" ? caster : undefined)});
  return {scene, caster};
}

const span = (fields, axis) => Math.max(...fields.map(field => field[axis])) - Math.min(...fields.map(field => field[axis])) + 1;

test("placing a radial area with a width lays out a ring, and a wall with one a thick wall of its own length", () => {
  const {caster} = world();
  const place = (area, points) => foundryAreaFootprint({definition: {area, targeting: {type: "area"}}, sourceToken: caster, points});
  const ring = place({shape: "radial", size: {value: 10}, width: {value: 5}}, [{x: 1050, y: 1050}]);
  assert.equal(ring.ok, true);
  assert.equal(ring.footprint.fields.length, 25 - 9, "a 5x5 block less its 3x3 middle");
  assert.equal(place({shape: "radial", size: {value: 10}}, [{x: 1050, y: 1050}]).footprint.fields.length, 25, "no width, filled");
  const wall = place({shape: "wall", size: {value: 30}, width: {value: 15}}, [{x: 550, y: 550}, {x: 1550, y: 550}]);
  assert.equal(wall.ok, true);
  assert.equal(wall.footprint.fields.length, 6 * 3);
  const axes = ["x", "y"].map(axis => span(wall.footprint.fields, axis)).sort();
  assert.deepEqual(axes, [3, 6], "30 feet long and 15 thick");
  assert.equal(place({shape: "wall", size: {value: 30}, width: {value: 1}}, [{x: 550, y: 550}, {x: 1550, y: 550}]).footprint.fields.length, 6,
    "a 1-ft wall is one field thick");
});

test("a lasting area's Region flag keeps its width in feet, so a moved area keeps it; one without has none", () => {
  const {caster} = world();
  const flag = area => persistentAreaRegionData({sourceToken: caster, combat: null, placement: {footprint: {topology: "square", fields: []},
    definition: {id: "action:ring", label: "Ring", area: {persistence: {}, ...area}}}}).flags.wildpath.area;
  assert.equal(flag({shape: "radial", size: {value: 30}, width: {value: 5, unit: "ft"}}).width, 5);
  assert.equal("width" in flag({shape: "radial", size: {value: 30}}), false, "an older or filled area");
  // What the client's move preview and the authority's placement both lay out again (areaOfFlag).
  assert.deepEqual(areaOfFlag(flag({shape: "radial", size: {value: 30}, width: {value: 5, unit: "ft"}})),
    {shape: "radial", size: {value: 30, unit: "ft"}, width: {value: 5, unit: "ft"}});
  assert.deepEqual(areaOfFlag(flag({shape: "radial", size: {value: 30}})), {shape: "radial", size: {value: 30, unit: "ft"}});
});
