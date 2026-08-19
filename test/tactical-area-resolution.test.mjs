import {test} from "node:test";
import assert from "node:assert/strict";
import {
  CREATURE_SIZES,
  GRID_TOPOLOGIES,
  createTokenGridFootprint
} from "../module/helpers/grid-footprints.mjs";
import {TARGET_OPERATIONS, TARGET_OVERRIDE_TYPES, attachTargetOverride} from "../module/helpers/targeting.mjs";
import {AREA_SHAPES, TACTICAL_AREA_CODES} from "../module/helpers/tactical-areas.mjs";
import {
  TACTICAL_AREA_RESOLUTION_CODES,
  resolvePlacedAreaTargets,
  resolveSourceBoundaryAreaTargets
} from "../module/helpers/tactical-area-resolution.mjs";
import {previewSourceBoundaryArea, selectSourceBoundaryOrigin} from "../module/helpers/tactical-areas.mjs";

function source(id, footprint) {
  return {
    id,
    token: {id: `token-${id}`},
    actor: {id: `actor-${id}`},
    footprint,
    controlled: true,
    present: true
  };
}

function target(id, footprint, data={}) {
  return {
    id,
    target: {id: `token-${id}`},
    actor: {id: `actor-${id}`},
    occupiedFields: footprint.fields,
    kind: data.kind ?? "creature",
    disposition: data.disposition ?? "enemy",
    tags: data.tags ?? []
  };
}

function directionVertexSquare(x, y) {
  return {id: `square-vertex:${x},${y}`, x, y, incidentFields: []};
}

test("source-boundary line placement resolves targets from the exact committed footprint", () => {
  const dragon = source("dragon", createTokenGridFootprint({
    size: CREATURE_SIZES.LARGE,
    topology: GRID_TOPOLOGIES.SQUARE
  }));
  const enemy = target("enemy", createTokenGridFootprint({
    size: CREATURE_SIZES.MEDIUM,
    topology: GRID_TOPOLOGIES.SQUARE,
    anchor: {x: 4, y: -1}
  }));
  const outside = target("outside", createTokenGridFootprint({
    size: CREATURE_SIZES.MEDIUM,
    topology: GRID_TOPOLOGIES.SQUARE,
    anchor: {x: 4, y: 4}
  }));
  const result = resolveSourceBoundaryAreaTargets({
    sources: [dragon],
    sourceId: "dragon",
    vertexId: "square-vertex:2,0",
    shape: AREA_SHAPES.LINE,
    directionVertex: directionVertexSquare(3, 0),
    rangeDistance: 30,
    gridDistance: 5,
    tokenFootprints: [enemy, outside],
    eligibilityPolicy: {kinds: ["creature"]}
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, TACTICAL_AREA_RESOLUTION_CODES.OK);
  assert.equal(result.placement.preview, result.placement.committed);
  assert.equal(result.placement.committed, result.placement.resolved);
  assert.equal(result.footprint, result.placement.resolved);
  assert.deepEqual(result.targeting.refinement.finalTargets.map(candidate => candidate.id), ["enemy"]);
});

test("source-boundary cone placement keeps large targets once and carries target overrides", () => {
  const dragon = source("dragon", createTokenGridFootprint({
    size: CREATURE_SIZES.HUGE,
    topology: GRID_TOPOLOGIES.HEX
  }));
  const ally = target("ally", createTokenGridFootprint({
    size: CREATURE_SIZES.LARGE,
    topology: GRID_TOPOLOGIES.HEX,
    anchor: {q: 1, r: 0}
  }), {disposition: "ally"});
  const enemy = target("enemy", createTokenGridFootprint({
    size: CREATURE_SIZES.HUGE,
    topology: GRID_TOPOLOGIES.HEX,
    anchor: {q: 1, r: -1}
  }));
  const result = resolveSourceBoundaryAreaTargets({
    sources: [dragon],
    vertexId: dragon.footprint.boundaryVertices[0].id,
    shape: AREA_SHAPES.CONE,
    direction: {q: 1, r: 0},
    rangeDistance: 15,
    gridDistance: 5,
    tokenFootprints: [ally, enemy],
    refinementPolicy: {
      allowedOperations: [TARGET_OPERATIONS.OVERRIDE],
      selectionPredicate: {equals: {path: "disposition", value: "ally"}},
      maxChoices: 1
    },
    decisions: [
      attachTargetOverride("ally", {type: TARGET_OVERRIDE_TYPES.AUTOMATIC_SUCCESS}, {type: "feature", slug: "protect"})
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.targeting.physical.candidates.length, 2);
  assert.equal(result.targeting.physical.candidates.find(candidate => candidate.id === "enemy").intersectingFields.length > 1, true);
  assert.equal(result.targeting.refinement.finalTargets.filter(candidate => candidate.id === "enemy").length, 1);
  assert.equal(result.targeting.refinement.overrides.ally[0].type, TARGET_OVERRIDE_TYPES.AUTOMATIC_SUCCESS);
});

test("invalid source-boundary click rejects before area targeting runs", () => {
  const dragon = source("dragon", createTokenGridFootprint({
    size: CREATURE_SIZES.LARGE,
    topology: GRID_TOPOLOGIES.SQUARE
  }));
  const result = resolveSourceBoundaryAreaTargets({
    sources: [dragon],
    vertexId: "square-vertex:1,1",
    shape: AREA_SHAPES.LINE,
    directionVertex: directionVertexSquare(2, 1),
    rangeDistance: 30,
    gridDistance: 5,
    tokenFootprints: []
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, TACTICAL_AREA_CODES.VERTEX_NOT_ON_SOURCE_BOUNDARY);
  assert.equal(result.targeting, null);
});

test("already placed areas can be retargeted without recalculating geometry", () => {
  const dragon = source("dragon", createTokenGridFootprint({
    size: CREATURE_SIZES.LARGE,
    topology: GRID_TOPOLOGIES.SQUARE
  }));
  const placement = selectSourceBoundaryOrigin({sources: [dragon], vertexId: "square-vertex:2,0"});
  const placedArea = previewSourceBoundaryArea({
    shape: AREA_SHAPES.LINE,
    placement,
    directionVertex: directionVertexSquare(3, 0),
    rangeDistance: 30,
    gridDistance: 5
  });
  const enemy = target("enemy", createTokenGridFootprint({
    topology: GRID_TOPOLOGIES.SQUARE,
    anchor: {x: 3, y: -1}
  }));
  const result = resolvePlacedAreaTargets({
    placedArea,
    tokenFootprints: [enemy]
  });

  assert.equal(result.ok, true);
  assert.equal(result.footprint, placedArea.resolved);
  assert.deepEqual(result.targeting.refinement.finalTargets.map(candidate => candidate.id), ["enemy"]);
});
