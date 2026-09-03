import {test} from "node:test";
import assert from "node:assert/strict";
import {resolveAreaTargetCandidates} from "../module/helpers/area-targeting.mjs";
import {
  CREATURE_SIZES,
  GRID_TOPOLOGIES,
  createFootprintDebugInfo,
  createReachFootprint,
  createTokenGridFootprint,
  fieldDistance,
  fieldKey,
  footprintDistance,
  isConnectedFootprint
} from "../module/helpers/grid-footprints.mjs";

const STANDARD_SIZES = [
  CREATURE_SIZES.TINY,
  CREATURE_SIZES.SMALL,
  CREATURE_SIZES.MEDIUM,
  CREATURE_SIZES.LARGE,
  CREATURE_SIZES.HUGE,
  CREATURE_SIZES.GARGANTUAN
];

function tokenFootprint(size, topology, anchor={}) {
  return createTokenGridFootprint({size, topology, anchor});
}

function occupiedKeys(footprint) {
  return new Set(footprint.fields.map(field => fieldKey(field, footprint.topology)));
}

function assertBoundaryEdgesAreExternal(footprint) {
  const occupied = occupiedKeys(footprint);
  for ( const edge of footprint.boundaryEdges ) {
    assert.equal(occupied.has(fieldKey(edge.field, footprint.topology)), true);
    assert.equal(occupied.has(fieldKey(edge.outsideField, footprint.topology)), false);
  }
}

test("D&D-style standard size footprints cover all creature sizes on square and hex grids", () => {
  const expected = {
    [GRID_TOPOLOGIES.SQUARE]: {tiny: 1, small: 1, medium: 1, large: 4, huge: 9, gargantuan: 16},
    [GRID_TOPOLOGIES.HEX]: {tiny: 1, small: 1, medium: 1, large: 3, huge: 7, gargantuan: 12}
  };

  for ( const topology of Object.values(GRID_TOPOLOGIES) ) {
    for ( const size of STANDARD_SIZES ) {
      const footprint = tokenFootprint(size, topology);
      assert.equal(footprint.fields.length, expected[topology][size], `${topology} ${size}`);
      assert.equal(isConnectedFootprint(footprint.fields, topology), true, `${topology} ${size} connected`);
      if ( size === CREATURE_SIZES.TINY ) assert.equal(footprint.definition.creaturesPerField, 4);
    }
  }
});

test("Large square footprint is 2 by 2 with exterior boundary only", () => {
  const footprint = tokenFootprint(CREATURE_SIZES.LARGE, GRID_TOPOLOGIES.SQUARE, {x: 0, y: 0});
  assert.deepEqual(footprint.fields, [{x: 0, y: 0}, {x: 0, y: 1}, {x: 1, y: 0}, {x: 1, y: 1}]);
  assert.equal(footprint.boundaryEdges.length, 8);
  assert.equal(footprint.boundaryVertices.length, 8);
  assert.equal(footprint.boundaryVertices.some(vertex => vertex.id === "square-vertex:1,1"), false);
  assert.equal(footprint.internalVertices.some(vertex => vertex.id === "square-vertex:1,1"), true);
  assertBoundaryEdgesAreExternal(footprint);
});

test("square footprint connectivity remains edge-adjacent, not diagonal", () => {
  assert.equal(isConnectedFootprint([
    {x: 0, y: 0},
    {x: 1, y: 1}
  ], GRID_TOPOLOGIES.SQUARE), false);
});

test("Huge square footprint is 3 by 3 with internal vertices excluded", () => {
  const footprint = tokenFootprint(CREATURE_SIZES.HUGE, GRID_TOPOLOGIES.SQUARE, {x: 0, y: 0});
  assert.equal(footprint.fields.length, 9);
  assert.equal(footprint.boundaryEdges.length, 12);
  assert.equal(footprint.boundaryVertices.length, 12);
  for ( const id of ["square-vertex:1,1", "square-vertex:2,1", "square-vertex:1,2", "square-vertex:2,2"] ) {
    assert.equal(footprint.boundaryVertices.some(vertex => vertex.id === id), false);
    assert.equal(footprint.internalVertices.some(vertex => vertex.id === id), true);
  }
  assertBoundaryEdgesAreExternal(footprint);
});

test("Large and Huge hex footprints use explicit connected hex layouts", () => {
  const large = tokenFootprint(CREATURE_SIZES.LARGE, GRID_TOPOLOGIES.HEX, {q: 0, r: 0});
  const huge = tokenFootprint(CREATURE_SIZES.HUGE, GRID_TOPOLOGIES.HEX, {q: 0, r: 0});

  assert.equal(large.fields.length, 3);
  assert.equal(large.boundaryEdges.length, 12);
  assert.equal(large.internalVertices.length > 0, true);
  assertBoundaryEdgesAreExternal(large);

  assert.equal(huge.fields.length, 7);
  assert.equal(huge.boundaryEdges.length, 18);
  assert.equal(huge.fields.every(field => fieldDistance({q: 0, r: 0}, field, GRID_TOPOLOGIES.HEX) <= 1), true);
  assert.equal(huge.internalVertices.length > 0, true);
  assertBoundaryEdgesAreExternal(huge);
});

test("full source footprint determines range for Large and Huge square and hex creatures", () => {
  const fixtures = [
    {size: CREATURE_SIZES.LARGE, topology: GRID_TOPOLOGIES.SQUARE, targetAnchor: {x: 2, y: 0}},
    {size: CREATURE_SIZES.HUGE, topology: GRID_TOPOLOGIES.SQUARE, targetAnchor: {x: 3, y: 1}},
    {size: CREATURE_SIZES.LARGE, topology: GRID_TOPOLOGIES.HEX, targetAnchor: {q: 2, r: 0}},
    {size: CREATURE_SIZES.HUGE, topology: GRID_TOPOLOGIES.HEX, targetAnchor: {q: 2, r: 0}}
  ];

  for ( const fixture of fixtures ) {
    const source = tokenFootprint(fixture.size, fixture.topology);
    const target = tokenFootprint(CREATURE_SIZES.MEDIUM, fixture.topology, fixture.targetAnchor);
    assert.equal(footprintDistance(source, target), 1, `${fixture.topology} ${fixture.size}`);
  }
});

test("full target footprint determines the endpoint of tactical range", () => {
  const squareSource = tokenFootprint(CREATURE_SIZES.SMALL, GRID_TOPOLOGIES.SQUARE, {x: 0, y: 0});
  const squareLarge = tokenFootprint(CREATURE_SIZES.LARGE, GRID_TOPOLOGIES.SQUARE, {x: 2, y: 0});
  const squareHuge = tokenFootprint(CREATURE_SIZES.HUGE, GRID_TOPOLOGIES.SQUARE, {x: 3, y: 0});
  assert.equal(footprintDistance(squareSource, squareLarge), 2);
  assert.equal(footprintDistance(squareSource, squareHuge), 3);

  const hexSource = tokenFootprint(CREATURE_SIZES.SMALL, GRID_TOPOLOGIES.HEX, {q: 0, r: 0});
  const hexLarge = tokenFootprint(CREATURE_SIZES.LARGE, GRID_TOPOLOGIES.HEX, {q: 2, r: 0});
  const hexHuge = tokenFootprint(CREATURE_SIZES.HUGE, GRID_TOPOLOGIES.HEX, {q: 3, r: 0});
  assert.equal(footprintDistance(hexSource, hexLarge), 2);
  assert.equal(footprintDistance(hexSource, hexHuge), 2);
});

test("full-footprint distance works when both source and target are Large or Huge", () => {
  const squareLarge = tokenFootprint(CREATURE_SIZES.LARGE, GRID_TOPOLOGIES.SQUARE, {x: 0, y: 0});
  const squareHuge = tokenFootprint(CREATURE_SIZES.HUGE, GRID_TOPOLOGIES.SQUARE, {x: 3, y: 0});
  const squareHugeSource = tokenFootprint(CREATURE_SIZES.HUGE, GRID_TOPOLOGIES.SQUARE, {x: 0, y: 0});
  const squareHugeTarget = tokenFootprint(CREATURE_SIZES.HUGE, GRID_TOPOLOGIES.SQUARE, {x: 4, y: 0});
  assert.equal(footprintDistance(squareLarge, squareHuge), 2);
  assert.equal(footprintDistance(squareHugeSource, squareHugeTarget), 2);

  const hexLarge = tokenFootprint(CREATURE_SIZES.LARGE, GRID_TOPOLOGIES.HEX, {q: 0, r: 0});
  const hexHuge = tokenFootprint(CREATURE_SIZES.HUGE, GRID_TOPOLOGIES.HEX, {q: 4, r: 0});
  const hexHugeSource = tokenFootprint(CREATURE_SIZES.HUGE, GRID_TOPOLOGIES.HEX, {q: 0, r: 0});
  const hexHugeTarget = tokenFootprint(CREATURE_SIZES.HUGE, GRID_TOPOLOGIES.HEX, {q: 4, r: 0});
  assert.equal(footprintDistance(hexLarge, hexHuge), 2);
  assert.equal(footprintDistance(hexHugeSource, hexHugeTarget), 2);
});

test("reach expands from the entire occupied footprint by tactical layers", () => {
  for ( const topology of Object.values(GRID_TOPOLOGIES) ) {
    for ( const size of STANDARD_SIZES ) {
      const source = tokenFootprint(size, topology);
      const occupied = occupiedKeys(source);
      const reach5 = createReachFootprint({source, reachDistance: 5, gridDistance: 5});
      const reach10 = createReachFootprint({source, reachDistance: 10, gridDistance: 5});

      assert.equal(reach5.fields.every(field => !occupied.has(fieldKey(field, topology))), true);
      assert.equal(reach5.fields.every(field => Math.min(...source.fields.map(sourceField => fieldDistance(sourceField, field, topology))) === 1), true);
      assert.equal(reach10.fields.some(field => Math.min(...source.fields.map(sourceField => fieldDistance(sourceField, field, topology))) === 2), true);
      assert.equal(reach10.fields.length > reach5.fields.length, true);
    }
  }
});

test("AoE intersection affects Large and Huge targets on one-field overlap only once", () => {
  for ( const topology of Object.values(GRID_TOPOLOGIES) ) {
    for ( const size of [CREATURE_SIZES.LARGE, CREATURE_SIZES.HUGE] ) {
      const target = tokenFootprint(size, topology);
      const area = {id: `${topology}-${size}-area`, fields: [target.fields[0]]};
      const result = resolveAreaTargetCandidates({
        footprint: area,
        tokenFootprints: [{
          id: `${topology}-${size}`,
          target: {id: `${topology}-${size}`},
          actor: {id: `${topology}-${size}-actor`},
          occupiedFields: target.fields
        }]
      });

      assert.equal(result.candidates.length, 1);
      assert.equal(result.candidates[0].intersectingFields.length, 1);
    }
  }
});

test("line and cone origin candidates come from exterior boundary vertices only", () => {
  const squareLarge = tokenFootprint(CREATURE_SIZES.LARGE, GRID_TOPOLOGIES.SQUARE);
  assert.equal(squareLarge.boundaryVertices.some(vertex => vertex.id === "square-vertex:0,0"), true);
  assert.equal(squareLarge.boundaryVertices.some(vertex => vertex.id === "square-vertex:1,1"), false);

  const hexHuge = tokenFootprint(CREATURE_SIZES.HUGE, GRID_TOPOLOGIES.HEX);
  const boundaryIds = new Set(hexHuge.boundaryVertices.map(vertex => vertex.id));
  assert.equal(hexHuge.boundaryVertices.length > 6, true);
  assert.equal(hexHuge.internalVertices.every(vertex => !boundaryIds.has(vertex.id)), true);
});

test("footprint debug output exposes size, topology, fields, and tactical boundary data", () => {
  const footprint = tokenFootprint(CREATURE_SIZES.HUGE, GRID_TOPOLOGIES.HEX);
  const debug = createFootprintDebugInfo({
    actor: {name: "Ancient Dragon"},
    effectiveSize: CREATURE_SIZES.HUGE,
    grid: GRID_TOPOLOGIES.HEX,
    footprint
  });

  assert.equal(debug.actor.name, "Ancient Dragon");
  assert.equal(debug.effectiveSize, CREATURE_SIZES.HUGE);
  assert.equal(debug.grid, GRID_TOPOLOGIES.HEX);
  assert.equal(debug.occupiedFieldCount, 7);
  assert.equal(debug.boundaryFields.length, 6);
  assert.equal(debug.boundaryVertices.length, footprint.boundaryVertices.length);
});
