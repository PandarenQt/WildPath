import {test} from "node:test";
import assert from "node:assert/strict";
import {
  CREATURE_SIZES,
  GRID_TOPOLOGIES,
  createTokenGridFootprint,
  fieldKey
} from "../module/helpers/grid-footprints.mjs";
import {
  AREA_SHAPES,
  ORIGIN_SOURCE_POLICIES,
  TACTICAL_AREA_CODES,
  createConeFootprint,
  createCubeFootprint,
  createRadialFootprint,
  createWallFootprint,
  cubeCornersAgainst,
  createSourceBoundarySelectionRequest,
  gridlessAreaLimitation,
  previewSourceBoundaryArea,
  resolveEligibleOriginSources,
  selectSourceBoundaryOrigin,
  suggestLanes,
  wallSections
} from "../module/helpers/tactical-areas.mjs";

function source(id, footprint, data={}) {
  return {
    id,
    token: {id: `token-${id}`},
    actor: {id: `actor-${id}`},
    footprint,
    controlled: data.controlled ?? true,
    present: data.present ?? true,
    kind: data.kind ?? "self"
  };
}

function directionVertexSquare(x, y) {
  return {id: `square-vertex:${x},${y}`, x, y, incidentFields: []};
}

test("radial footprints expand by tactical layers on square and hex grids", () => {
  const square = createRadialFootprint({
    topology: GRID_TOPOLOGIES.SQUARE,
    origin: {x: 0, y: 0},
    radiusDistance: 10,
    gridDistance: 5
  });
  const hex = createRadialFootprint({
    topology: GRID_TOPOLOGIES.HEX,
    origin: {q: 0, r: 0},
    radiusDistance: 10,
    gridDistance: 5
  });

  assert.equal(square.fields.length, 25);
  assert.equal(hex.fields.length, 19);
  assert.equal(square.metadata.layers, 2);
  assert.equal(hex.metadata.layers, 2);
});

test("self-only origin policy ignores additional controlled tokens", () => {
  const self = source("wizard", createTokenGridFootprint({size: CREATURE_SIZES.MEDIUM}));
  const familiar = source("familiar", createTokenGridFootprint({size: CREATURE_SIZES.MEDIUM, anchor: {x: 4, y: 0}}));
  const result = resolveEligibleOriginSources({
    source: self,
    controlled: [familiar],
    policy: ORIGIN_SOURCE_POLICIES.SELF
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.eligible.map(entry => entry.id), ["wizard"]);
});

test("self plus controlled origin policy separates permission and rules eligibility failures", () => {
  const self = source("wizard", createTokenGridFootprint({size: CREATURE_SIZES.MEDIUM}), {kind: "caster"});
  const familiar = source("familiar", createTokenGridFootprint({size: CREATURE_SIZES.MEDIUM, anchor: {x: 4, y: 0}}), {kind: "companion"});
  const unselected = source("construct", createTokenGridFootprint({size: CREATURE_SIZES.MEDIUM, anchor: {x: 8, y: 0}}), {
    controlled: false,
    kind: "companion"
  });
  const result = resolveEligibleOriginSources({
    source: self,
    controlled: [familiar, unselected],
    policy: ORIGIN_SOURCE_POLICIES.SELF_AND_ELIGIBLE_CONTROLLED,
    predicate: {oneOf: {path: "source.kind", values: ["caster", "companion"]}}
  });

  assert.deepEqual(result.eligible.map(entry => entry.id), ["wizard", "familiar"]);
  assert.equal(result.rejected[0].sourceId, "construct");
  assert.equal(result.rejected[0].code, TACTICAL_AREA_CODES.TOKEN_NOT_CONTROLLED);
});

test("source boundary selection exposes selectable boundary vertices and rejects internal or unrelated vertices", () => {
  const dragon = source("dragon", createTokenGridFootprint({
    size: CREATURE_SIZES.LARGE,
    topology: GRID_TOPOLOGIES.SQUARE
  }));
  const request = createSourceBoundarySelectionRequest({sources: [dragon]});
  const accepted = selectSourceBoundaryOrigin({
    sources: [dragon],
    vertexId: "square-vertex:2,0"
  });
  const internal = selectSourceBoundaryOrigin({
    sources: [dragon],
    vertexId: "square-vertex:1,1"
  });
  const unrelated = selectSourceBoundaryOrigin({
    sources: [dragon],
    vertexId: "square-vertex:20,20"
  });

  assert.equal(request.sources[0].boundaryVertices.some(vertex => vertex.id === "square-vertex:2,0"), true);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.sourceId, "dragon");
  assert.equal(internal.ok, false);
  assert.equal(internal.code, TACTICAL_AREA_CODES.VERTEX_NOT_ON_SOURCE_BOUNDARY);
  assert.equal(unrelated.code, TACTICAL_AREA_CODES.VERTEX_NOT_ON_SOURCE_BOUNDARY);
});

test("fixed-length line placement begins at selected source boundary and ignores second-click distance", () => {
  const dragon = source("dragon", createTokenGridFootprint({
    size: CREATURE_SIZES.LARGE,
    topology: GRID_TOPOLOGIES.SQUARE
  }));
  const placement = selectSourceBoundaryOrigin({sources: [dragon], vertexId: "square-vertex:2,0"});
  const preview = previewSourceBoundaryArea({
    shape: AREA_SHAPES.LINE,
    placement,
    directionVertex: directionVertexSquare(3, 0),
    rangeDistance: 30,
    gridDistance: 5
  });
  const occupied = new Set(dragon.footprint.fields.map(field => fieldKey(field, GRID_TOPOLOGIES.SQUARE)));

  assert.equal(preview.ok, true);
  assert.equal(preview.preview.fields.length, 6);
  assert.equal(preview.preview, preview.committed);
  assert.equal(preview.committed, preview.resolved);
  assert.equal(preview.preview.fields.every(field => !occupied.has(fieldKey(field, GRID_TOPOLOGIES.SQUARE))), true);
  assert.equal(preview.placement.sourceId, "dragon");
});

test("opposite Large-source boundary origins are both legal and produce different line footprints", () => {
  const dragon = source("dragon", createTokenGridFootprint({
    size: CREATURE_SIZES.LARGE,
    topology: GRID_TOPOLOGIES.SQUARE
  }));
  const top = previewSourceBoundaryArea({
    shape: AREA_SHAPES.LINE,
    placement: selectSourceBoundaryOrigin({sources: [dragon], vertexId: "square-vertex:2,0"}),
    directionVertex: directionVertexSquare(3, 0),
    rangeDistance: 30,
    gridDistance: 5
  });
  const bottom = previewSourceBoundaryArea({
    shape: AREA_SHAPES.LINE,
    placement: selectSourceBoundaryOrigin({sources: [dragon], vertexId: "square-vertex:2,2"}),
    directionVertex: directionVertexSquare(3, 2),
    rangeDistance: 30,
    gridDistance: 5
  });

  assert.equal(top.ok, true);
  assert.equal(bottom.ok, true);
  assert.equal(top.preview.fields.length, 6);
  assert.equal(bottom.preview.fields.length, 6);
  assert.notDeepEqual(top.preview.fieldKeys, bottom.preview.fieldKeys);
});

test("hex source boundary placement supports deterministic line and cone footprints", () => {
  const dragon = source("dragon", createTokenGridFootprint({
    size: CREATURE_SIZES.HUGE,
    topology: GRID_TOPOLOGIES.HEX
  }));
  const vertexId = dragon.footprint.boundaryVertices[0].id;
  const placement = selectSourceBoundaryOrigin({sources: [dragon], vertexId});
  const line = previewSourceBoundaryArea({
    shape: AREA_SHAPES.LINE,
    placement,
    direction: {q: 1, r: 0},
    rangeDistance: 30,
    gridDistance: 5
  });
  const cone = previewSourceBoundaryArea({
    shape: AREA_SHAPES.CONE,
    placement,
    direction: {q: 1, r: 0},
    rangeDistance: 15,
    gridDistance: 5
  });

  assert.equal(placement.ok, true);
  assert.equal(line.preview.fields.length, 6);
  assert.equal(cone.preview.metadata.depth, 3);
  assert.equal(cone.preview.fields.length, 9);
});

test("the same cone geometry works with free-vertex-style inputs", () => {
  const originVertex = {
    id: "square-vertex:0,0",
    x: 0,
    y: 0,
    incidentFields: [{x: -1, y: -1}, {x: 0, y: -1}, {x: -1, y: 0}, {x: 0, y: 0}]
  };
  const cone = createConeFootprint({
    topology: GRID_TOPOLOGIES.SQUARE,
    originVertex,
    directionVertex: directionVertexSquare(1, 0),
    rangeDistance: 15,
    gridDistance: 5
  });

  assert.equal(cone.ok, true);
  assert.equal(cone.footprint.fields.length, 9);
  assert.equal(cone.footprint.shape, AREA_SHAPES.CONE);
});

test("gridless source-border placement returns a structured limitation", () => {
  const result = gridlessAreaLimitation(AREA_SHAPES.LINE);
  assert.equal(result.ok, false);
  assert.equal(result.code, TACTICAL_AREA_CODES.GRIDLESS_UNSUPPORTED);
});

test("a Cube is a square block of fields; one originating from a creature touches its edge without covering it", () => {
  const cube = createCubeFootprint({corner: {x: 2, y: 3}, side: 2});
  assert.deepEqual(cube.fields.map(field => [field.x, field.y]).sort(), [[2, 3], [2, 4], [3, 3], [3, 4]]);
  assert.equal(cube.shape, AREA_SHAPES.CUBE);
  assert.equal(createCubeFootprint({topology: GRID_TOPOLOGIES.HEX, corner: {x: 0, y: 0}, side: 2}), null, "square grids only");
  const corners = cubeCornersAgainst([{x: 0, y: 0}], 3);
  assert.equal(corners.length, 5 * 5 - 9, "every 3x3 block touching a 1x1 creature that does not cover it");
  assert.ok(corners.every(({x, y}) => !((x <= 0) && (x + 2 >= 0) && (y <= 0) && (y + 2 >= 0))));
});

test("a wall runs from its start toward the second point, at any angle, for its whole length", () => {
  const straight = createWallFootprint({start: {x: 0, y: 0}, end: {x: 0, y: 2}, length: 4});
  assert.deepEqual(straight.fields.map(field => [field.x, field.y]), [[0, 0], [0, 1], [0, 2], [0, 3]], "past the second point, to its length");
  const slanted = createWallFootprint({start: {x: 0, y: 0}, end: {x: 2, y: 4}, length: 5});
  assert.equal(slanted.fields.length, 5);
  assert.deepEqual(slanted.fields.map(field => field.y).sort((a, b) => a - b), [0, 1, 2, 3, 4], "one field a step");
  assert.equal(createWallFootprint({topology: GRID_TOPOLOGIES.HEX, start: {x: 0, y: 0}, end: {x: 1, y: 0}, length: 2}), null);
});

test("a radial area with a width is hollow: only its fields farther than its size less its width (a ring, a globe)", () => {
  const ring = createRadialFootprint({origin: {x: 0, y: 0}, radiusDistance: 30, widthDistance: 5, gridDistance: 5});
  assert.equal(ring.fields.length, (13 * 13) - (11 * 11), "the outer row of a 13x13 block");
  assert.ok(ring.fields.every(({x, y}) => Math.max(Math.abs(x), Math.abs(y)) === 6), "its inside left out");
  const thick = createRadialFootprint({origin: {x: 0, y: 0}, radiusDistance: 30, widthDistance: 10, gridDistance: 5});
  assert.equal(thick.fields.length, (13 * 13) - (9 * 9), "two rows thick");
  const shell = createRadialFootprint({origin: {x: 0, y: 0}, radiusDistance: 15, widthDistance: 1, gridDistance: 5});
  assert.ok(shell.fields.length && shell.fields.every(({x, y}) => Math.max(Math.abs(x), Math.abs(y)) === 3), "a thin shell is one ring of fields");
  const hex = createRadialFootprint({topology: GRID_TOPOLOGIES.HEX, origin: {q: 0, r: 0}, radiusDistance: 10, widthDistance: 5, gridDistance: 5});
  assert.equal(hex.fields.length, 19 - 7, "a hex ring");
  // Its size and its inside flooring to one layer keep its outer row, not nothing.
  const globe = createRadialFootprint({origin: {x: 0, y: 0}, radiusDistance: 15, widthDistance: 5, gridDistance: 10});
  assert.equal(globe.fields.length, 9 - 1, "Prismatic Wall's globe on a 10-ft grid: a 3x3 block less its middle");
  assert.equal(createRadialFootprint({origin: {x: 0, y: 0}, radiusDistance: 12, widthDistance: 1, gridDistance: 5}).fields.length, 25 - 9);
  assert.equal(createRadialFootprint({origin: {x: 0, y: 0}, radiusDistance: 30, gridDistance: 5}).fields.length, 13 * 13, "no width, filled");
});

test("a thick wall grows across its main axis only, so its length stays its own", () => {
  const along = createWallFootprint({start: {x: 0, y: 0}, end: {x: 5, y: 0}, length: 60, thickness: 10});
  assert.equal(along.fields.length, 600);
  assert.deepEqual([Math.min(...along.fields.map(f => f.x)), Math.max(...along.fields.map(f => f.x))], [0, 59], "300 feet long, not longer");
  assert.deepEqual([Math.min(...along.fields.map(f => f.y)), Math.max(...along.fields.map(f => f.y))], [-4, 5], "4 fields to one side, 5 to the other");
  const down = createWallFootprint({start: {x: 3, y: 3}, end: {x: 3, y: 0}, length: 2, thickness: 3});
  assert.deepEqual(down.fields.map(f => [f.x, f.y]).sort(), [[2, 2], [2, 3], [3, 2], [3, 3], [4, 2], [4, 3]], "a wall along y grows along x");
  assert.equal(createWallFootprint({start: {x: 0, y: 0}, end: {x: 0, y: 2}, length: 4, thickness: 1}).fields.length, 4, "one field thick, as before");
});

test("a wall's sections: its fields in order from its start, so many to a section, the last perhaps shorter", () => {
  const wall = createWallFootprint({start: {x: 0, y: 0}, end: {x: 0, y: 1}, length: 20}).fields;
  const sections = wallSections(wall, 2);
  assert.equal(sections.length, 10, "100 feet in 10-foot sections on a 5-foot grid");
  assert.deepEqual(sections[1], [{x: 0, y: 2}, {x: 0, y: 3}], "the second section is the wall's third and fourth fields");
  assert.deepEqual(wallSections(wall.slice(0, 3), 2).map(section => section.length), [2, 1]);
  assert.deepEqual(wallSections(wall.slice(0, 3), 0).map(section => section.length), [1, 1, 1], "at least one field a section");
  // Across a change in digit count the footprint's string-sorted fields run 10..14, 9: each section is still adjacent.
  const across = createWallFootprint({start: {x: 9, y: 5}, end: {x: 20, y: 5}, length: 6}).fields;
  assert.deepEqual(wallSections(across, 2).map(section => section.map(field => field.x)), [[9, 10], [11, 12], [13, 14]]);
  // A slanted wall rising as it goes right: ordered by x, its longer axis, not by y.
  const slanted = createWallFootprint({start: {x: 8, y: 12}, end: {x: 12, y: 10}, length: 5}).fields;
  assert.deepEqual(wallSections(slanted, 2).map(section => section.map(field => [field.x, field.y])),
    [[[8, 12], [9, 12]], [[10, 11], [11, 11]], [[12, 10]]]);
  // A thick wall's section is so many steps along it, across its whole thickness.
  const thick = createWallFootprint({start: {x: 0, y: 0}, end: {x: 5, y: 0}, length: 4, thickness: 3}).fields;
  assert.deepEqual(wallSections(thick, 2).map(section => [...new Set(section.map(field => field.x))]), [[0, 1], [2, 3]]);
  assert.deepEqual(wallSections(thick, 2).map(section => section.length), [6, 6]);
});

/** A disc of square fields `radius` fields around 0,0; a hex one `radius` steps around 0,0. */
const squareDisc = radius => Array.from({length: (2 * radius) + 1}, (_, i) => i - radius)
  .flatMap(x => Array.from({length: (2 * radius) + 1}, (_, j) => ({x, y: j - radius}))).filter(({x, y}) => (x * x) + (y * y) <= radius * radius);
const hexDisc = radius => Array.from({length: (2 * radius) + 1}, (_, i) => i - radius)
  .flatMap(q => Array.from({length: (2 * radius) + 1}, (_, j) => ({q, r: j - radius})))
  .filter(({q, r}) => Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= radius);

test("suggestLanes lays 1 to 6 disjoint bands of whole lanes across a disc, edge to edge, a lane apart", () => {
  const disc = squareDisc(10);
  for ( let count = 1; count <= 6; count++ ) {
    const bands = suggestLanes({fields: disc, gridDistance: 5, width: 10, count});
    assert.equal(bands.length, count, `${count} placed`);
    const keys = bands.flat().map(field => fieldKey(field));
    assert.equal(new Set(keys).size, keys.length, "no field in two bands");
    const rows = bands.map(band => [...new Set(band.map(field => field.y))].sort((a, b) => a - b));
    for ( const [index, band] of bands.entries() ) {
      assert.equal(rows[index].length, 2, "10 feet wide: two lanes");
      assert.equal(band.length, disc.filter(field => rows[index].includes(field.y)).length, "each lane whole: from edge to edge");
      if ( index ) assert.ok(rows[index][0] - rows[index - 1][1] >= 2, "at least one lane between two bands");
    }
  }
  assert.deepEqual(suggestLanes({fields: []}), []);
});

test("suggestLanes keeps the direction whose bands cross the fewest walls, and places fewer bands when they do not fit", () => {
  const disc = squareDisc(10);
  // A wall down column 0: every row and diagonal band crosses it; the columns -5, -4 and 3, 4 do not.
  const bands = suggestLanes({fields: disc, gridDistance: 5, width: 10, count: 2, cost: field => ((field.x === 0) ? 1 : 0)});
  assert.deepEqual(bands.map(band => [...new Set(band.map(field => field.x))].sort((a, b) => a - b)), [[-5, -4], [3, 4]]);
  assert.equal(suggestLanes({fields: squareDisc(2), gridDistance: 5, width: 10, count: 6}).length, 2, "a 10-foot disc fits two");
  const hex = suggestLanes({fields: hexDisc(4), topology: "hex", gridDistance: 5, width: 5, count: 3});
  assert.deepEqual(hex.map(band => [...new Set(band.map(field => field.r))]), [[-3], [0], [3]], "hex: along its own axes, evenly spread");
  assert.deepEqual(suggestLanes({fields: hexDisc(4), topology: "hex", gridDistance: 5, width: 5, count: 2,
    cost: field => ((field.q === 0) ? 1 : 0)}).map(band => [...new Set(band.map(field => field.q))]), [[-2], [2]],
    "the hex direction clear of a wall along q = 0");
});

test("suggestLanes slides its bands off a structure at the area's center, which every direction crosses", () => {
  const disc = squareDisc(10);
  const structure = field => (((Math.abs(field.x) <= 1) && (Math.abs(field.y) <= 1)) ? 1 : 0);
  for ( const count of [1, 3] ) {
    const bands = suggestLanes({fields: disc, gridDistance: 5, width: 10, count, cost: structure});
    assert.equal(bands.length, count);
    assert.equal(bands.flat().filter(structure).length, 0, `${count}: no band over the structure`);
  }
  const [band] = suggestLanes({fields: disc, gridDistance: 5, width: 10, count: 1, cost: structure});
  assert.deepEqual([...new Set(band.map(field => field.y))].sort((a, b) => a - b), [-3, -2], "the smallest slide clear of it");
});
