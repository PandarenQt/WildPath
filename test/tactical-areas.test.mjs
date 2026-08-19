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
  createRadialFootprint,
  createSourceBoundarySelectionRequest,
  gridlessAreaLimitation,
  previewSourceBoundaryArea,
  resolveEligibleOriginSources,
  selectSourceBoundaryOrigin
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
