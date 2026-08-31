import {test} from "node:test";
import assert from "node:assert/strict";
import {resolvePlacedAreaTargets} from "../module/helpers/tactical-area-resolution.mjs";
import {
  AREA_SHAPES,
  previewSourceBoundaryArea,
  selectSourceBoundaryOrigin
} from "../module/helpers/tactical-areas.mjs";
import {
  CREATURE_SIZES,
  GRID_TOPOLOGIES,
  createReachFootprint,
  createTokenGridFootprint,
  fieldDistance,
  fieldKey,
  footprintDistance
} from "../module/helpers/grid-footprints.mjs";
import {
  FOUNDRY_GRID_TYPES,
  FOUNDRY_HEX_OFFSET_VARIANTS,
  FOUNDRY_TACTICAL_GRID_CODES,
  createFoundryV14TacticalGridAdapter,
  sceneDistanceToGridFields
} from "../module/adapters/foundry-v14-tactical-grid-adapter.mjs";

const HEX_DIRECTIONS = [
  {q: 1, r: 0},
  {q: 1, r: -1},
  {q: 0, r: -1},
  {q: -1, r: 0},
  {q: -1, r: 1},
  {q: 0, r: 1}
];

class FakeSquareGrid {
  constructor({distance=5, units="ft", size=50}={}) {
    this.type = FOUNDRY_GRID_TYPES.SQUARE;
    this.isSquare = true;
    this.isHexagonal = false;
    this.isGridless = false;
    this.distance = distance;
    this.units = units;
    this.size = size;
    this.sizeX = size;
    this.sizeY = size;
  }

  getOffset(point) {
    const offset = {
      i: Math.floor(Number(point.x) / this.sizeX),
      j: Math.floor(Number(point.y) / this.sizeY)
    };
    if ( point.elevation != null ) offset.k = point.elevation;
    return offset;
  }

  getCenterPoint(offset) {
    return {
      x: (Number(offset.i) + 0.5) * this.sizeX,
      y: (Number(offset.j) + 0.5) * this.sizeY,
      ...(offset.k != null ? {elevation: offset.k} : {})
    };
  }

  getVertices(offset) {
    const x = Number(offset.i) * this.sizeX;
    const y = Number(offset.j) * this.sizeY;
    return [
      {x, y},
      {x: x + this.sizeX, y},
      {x: x + this.sizeX, y: y + this.sizeY},
      {x, y: y + this.sizeY}
    ];
  }

  getAdjacentOffsets(offset) {
    return [
      {i: offset.i, j: offset.j - 1},
      {i: offset.i + 1, j: offset.j},
      {i: offset.i, j: offset.j + 1},
      {i: offset.i - 1, j: offset.j}
    ];
  }

  getSnappedPoint(point) {
    const offset = this.getOffset(point);
    return this.getVertices(offset)
      .sort((a, b) => squaredDistance(a, point) - squaredDistance(b, point))[0];
  }
}

class FakeHexGrid {
  constructor(type, {distance=5, units="ft", size=50, useCubeMethods=false}={}) {
    this.type = type;
    this.isSquare = false;
    this.isHexagonal = true;
    this.isGridless = false;
    this.columns = type === FOUNDRY_GRID_TYPES.HEXODDQ || type === FOUNDRY_GRID_TYPES.HEXEVENQ;
    this.even = type === FOUNDRY_GRID_TYPES.HEXEVENR || type === FOUNDRY_GRID_TYPES.HEXEVENQ;
    this.distance = distance;
    this.units = units;
    this.size = size;
    this.sizeX = size;
    this.sizeY = size;
    this.offsetToCubeCalls = 0;
    this.cubeToOffsetCalls = 0;
    if ( useCubeMethods ) {
      this.offsetToCube = offset => {
        this.offsetToCubeCalls += 1;
        return {...offsetToAxial(offset, this.variant), s: null};
      };
      this.cubeToOffset = cube => {
        this.cubeToOffsetCalls += 1;
        return axialToOffset(cube, this.variant);
      };
    }
  }

  get variant() {
    if ( this.columns ) return this.even ? FOUNDRY_HEX_OFFSET_VARIANTS.EVEN_Q : FOUNDRY_HEX_OFFSET_VARIANTS.ODD_Q;
    return this.even ? FOUNDRY_HEX_OFFSET_VARIANTS.EVEN_R : FOUNDRY_HEX_OFFSET_VARIANTS.ODD_R;
  }

  getOffset(point) {
    return {
      i: Math.floor(Number(point.x) / this.sizeX),
      j: Math.floor(Number(point.y) / this.sizeY)
    };
  }

  getCenterPoint(offset) {
    return {
      x: (Number(offset.i) + 0.5) * this.sizeX,
      y: (Number(offset.j) + 0.5) * this.sizeY
    };
  }

  getVertices(offset) {
    const center = this.getCenterPoint(offset);
    return Array.from({length: 6}, (_, index) => {
      const angle = (Math.PI / 3) * index;
      return {
        x: center.x + (Math.cos(angle) * this.sizeX * 0.5),
        y: center.y + (Math.sin(angle) * this.sizeY * 0.5)
      };
    });
  }

  getAdjacentOffsets(offset) {
    const field = offsetToAxial(offset, this.variant);
    return HEX_DIRECTIONS.map(direction => axialToOffset({
      q: field.q + direction.q,
      r: field.r + direction.r
    }, this.variant));
  }
}

class FakeGridlessGrid {
  constructor({distance=0, units="", size=50}={}) {
    this.type = FOUNDRY_GRID_TYPES.GRIDLESS;
    this.isSquare = false;
    this.isHexagonal = false;
    this.isGridless = true;
    this.distance = distance;
    this.units = units;
    this.size = size;
    this.sizeX = size;
    this.sizeY = size;
  }
}

function fakeScene(grid, data={}) {
  return {
    id: data.id ?? "scene-a",
    uuid: data.uuid ?? `Scene.${data.id ?? "scene-a"}`,
    name: data.name ?? "Adapter Test Scene",
    grid,
    dimensions: {
      distance: grid.distance,
      units: grid.units,
      size: grid.size,
      sceneX: 0,
      sceneY: 0,
      sceneWidth: 1000,
      sceneHeight: 1000,
      columns: 20,
      rows: 20
    },
    tokens: data.tokens ?? []
  };
}

function fakeToken({id, scene, grid, offset={i: 0, j: 0}, size=CREATURE_SIZES.MEDIUM, representedFields=null, elevation=0, levelId=null, disposition=-1}) {
  const representedOffsets = representedFields
    ? representedFields.map(field => fieldToOffset(field, grid))
    : [offset];
  return {
    documentName: "Token",
    id,
    uuid: `Scene.${scene.id}.Token.${id}`,
    name: id,
    parent: scene,
    sceneId: scene.id,
    actor: {
      id: `actor-${id}`,
      uuid: `Actor.actor-${id}`,
      name: `Actor ${id}`,
      type: "npc",
      system: {traits: {size}}
    },
    x: Number(offset.i) * grid.sizeX,
    y: Number(offset.j) * grid.sizeY,
    elevation,
    levelId,
    disposition,
    wildpathSize: size,
    getOccupiedGridSpaceOffsets() {
      return representedOffsets;
    }
  };
}

function sourceFromAdapter(id, footprintResult) {
  return {
    id,
    token: footprintResult.token,
    actor: footprintResult.actor,
    footprint: footprintResult.footprint,
    controlled: true,
    present: true
  };
}

test("scene context detects square, gridless, and all Foundry V14 hex offset variants", () => {
  const square = createFoundryV14TacticalGridAdapter({scene: fakeScene(new FakeSquareGrid())}).getSceneContext();
  assert.equal(square.ok, true);
  assert.equal(square.context.grid.type, "square");
  assert.equal(square.context.grid.topology, GRID_TOPOLOGIES.SQUARE);
  assert.equal(square.context.capabilities.fields, true);

  const expectedHex = new Map([
    [FOUNDRY_GRID_TYPES.HEXODDR, FOUNDRY_HEX_OFFSET_VARIANTS.ODD_R],
    [FOUNDRY_GRID_TYPES.HEXEVENR, FOUNDRY_HEX_OFFSET_VARIANTS.EVEN_R],
    [FOUNDRY_GRID_TYPES.HEXODDQ, FOUNDRY_HEX_OFFSET_VARIANTS.ODD_Q],
    [FOUNDRY_GRID_TYPES.HEXEVENQ, FOUNDRY_HEX_OFFSET_VARIANTS.EVEN_Q]
  ]);
  for ( const [type, variant] of expectedHex ) {
    const context = createFoundryV14TacticalGridAdapter({scene: fakeScene(new FakeHexGrid(type))}).getSceneContext();
    assert.equal(context.ok, true);
    assert.equal(context.context.grid.type, "hex");
    assert.equal(context.context.grid.topology, GRID_TOPOLOGIES.HEX);
    assert.equal(context.context.grid.offsetVariant, variant);
  }

  const gridless = createFoundryV14TacticalGridAdapter({scene: fakeScene(new FakeGridlessGrid())});
  const context = gridless.getSceneContext();
  assert.equal(context.ok, true);
  assert.equal(context.context.grid.gridless, true);
  assert.equal(context.context.capabilities.fields, false);
  assert.equal(gridless.offsetToField({i: 0, j: 0}).code, FOUNDRY_TACTICAL_GRID_CODES.GRIDLESS_UNSUPPORTED);
});

test("square offsets, fields, centers, vertices, and adjacency round-trip through stable WildPath identities", () => {
  const grid = new FakeSquareGrid({size: 50});
  const scene = fakeScene(grid);
  const adapter = createFoundryV14TacticalGridAdapter({scene});

  const field = adapter.offsetToField({i: 2, j: 3});
  const offset = adapter.fieldToOffset(field.field);
  const center = adapter.fieldToCenterPoint(field.field);
  const point = adapter.pointToField({x: 126, y: 176});
  const verticesA = adapter.fieldToVertices({x: 0, y: 0});
  const verticesB = adapter.fieldToVertices({x: 1, y: 0});
  const shared = new Set(verticesA.vertices.map(vertex => vertex.id));
  const adjacency = adapter.compareAdjacentOffsets({x: 2, y: 3});

  assert.deepEqual(field.field, {x: 2, y: 3});
  assert.deepEqual(offset.offset, {i: 2, j: 3});
  assert.deepEqual(center.point, {x: 125, y: 175});
  assert.deepEqual(point.field, {x: 2, y: 3});
  assert.equal(verticesA.vertices.some(vertex => vertex.id === "square-vertex:1,0"), true);
  assert.equal(verticesB.vertices.some(vertex => shared.has(vertex.id)), true);
  assert.equal(verticesA.vertices[0].metadata.foundry.point != null, true);
  assert.equal(adjacency.ok, true);
  assert.deepEqual(adjacency.wildPathAdjacent.map(field => fieldKey(field, GRID_TOPOLOGIES.SQUARE)).sort(), [
    "square:1,3",
    "square:2,2",
    "square:2,4",
    "square:3,3"
  ]);
});

test("square click mapping can return a normalized GridVertex without storing pixel identity as the vertex id", () => {
  const grid = new FakeSquareGrid({size: 50});
  const adapter = createFoundryV14TacticalGridAdapter({scene: fakeScene(grid)});
  const vertex = adapter.pointToVertex({x: 49, y: 1});

  assert.equal(vertex.ok, true);
  assert.equal(vertex.vertex.id, "square-vertex:1,0");
  assert.deepEqual(vertex.point, {x: 50, y: 0});
});

test("all Foundry V14 hex offset variants round-trip into canonical axial WildPath fields", () => {
  const fixtures = [
    {type: FOUNDRY_GRID_TYPES.HEXODDR, offset: {i: 3, j: 3}, field: {q: 2, r: 3}},
    {type: FOUNDRY_GRID_TYPES.HEXEVENR, offset: {i: 3, j: 3}, field: {q: 1, r: 3}},
    {type: FOUNDRY_GRID_TYPES.HEXODDQ, offset: {i: 3, j: 4}, field: {q: 3, r: 3}},
    {type: FOUNDRY_GRID_TYPES.HEXEVENQ, offset: {i: 3, j: 4}, field: {q: 3, r: 2}}
  ];

  for ( const fixture of fixtures ) {
    const grid = new FakeHexGrid(fixture.type);
    const adapter = createFoundryV14TacticalGridAdapter({scene: fakeScene(grid)});
    const converted = adapter.offsetToField(fixture.offset);
    const roundTrip = adapter.fieldToOffset(converted.field);
    const adjacency = adapter.compareAdjacentOffsets(converted.field);
    const adjacentKeys = adjacency.wildPathAdjacent.map(field => fieldKey(field, GRID_TOPOLOGIES.HEX)).sort();

    assert.deepEqual(converted.field, fixture.field);
    assert.deepEqual(roundTrip.offset, fixture.offset);
    assert.equal(adjacency.ok, true);
    assert.equal(adjacentKeys.length, 6);
  }
});

test("hex conversion uses injected V14 HexagonalGrid cube/offset methods when they are available", () => {
  const grid = new FakeHexGrid(FOUNDRY_GRID_TYPES.HEXODDR, {useCubeMethods: true});
  const adapter = createFoundryV14TacticalGridAdapter({scene: fakeScene(grid)});

  const converted = adapter.offsetToField({i: 3, j: 3});
  const roundTrip = adapter.fieldToOffset(converted.field);

  assert.equal(converted.ok, true);
  assert.deepEqual(roundTrip.offset, {i: 3, j: 3});
  assert.equal(grid.offsetToCubeCalls > 0, true);
  assert.equal(grid.cubeToOffsetCalls > 0, true);
});

test("square Token placement becomes full WildPath footprints for Medium through Gargantuan sizes", () => {
  const grid = new FakeSquareGrid();
  const scene = fakeScene(grid);
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  const expectations = [
    [CREATURE_SIZES.MEDIUM, 1],
    [CREATURE_SIZES.LARGE, 4],
    [CREATURE_SIZES.HUGE, 9],
    [CREATURE_SIZES.GARGANTUAN, 16]
  ];

  for ( const [size, count] of expectations ) {
    const expected = createTokenGridFootprint({size, topology: GRID_TOPOLOGIES.SQUARE, anchor: {x: 2, y: 2}});
    const token = fakeToken({id: `square-${size}`, scene, grid, offset: {i: 2, j: 2}, size, representedFields: expected.fields});
    const result = adapter.tokenToFootprint(token);

    assert.equal(result.ok, true, size);
    assert.equal(result.code, FOUNDRY_TACTICAL_GRID_CODES.OK, size);
    assert.equal(result.footprint.fields.length, count, size);
    if ( size !== CREATURE_SIZES.MEDIUM ) {
      assert.equal(result.footprint.boundaryVertices.some(vertex => vertex.id === "square-vertex:3,3"), false, size);
      assert.equal(result.footprint.internalVertices.some(vertex => vertex.id === "square-vertex:3,3"), true, size);
    }
  }
});

test("hex Token placement remains topology-aware across all Foundry offset variants", () => {
  for ( const type of [
    FOUNDRY_GRID_TYPES.HEXODDR,
    FOUNDRY_GRID_TYPES.HEXEVENR,
    FOUNDRY_GRID_TYPES.HEXODDQ,
    FOUNDRY_GRID_TYPES.HEXEVENQ
  ] ) {
    const grid = new FakeHexGrid(type);
    const scene = fakeScene(grid);
    const adapter = createFoundryV14TacticalGridAdapter({scene});
    const anchor = adapter.offsetToField({i: 4, j: 5}).field;
    const largeExpected = createTokenGridFootprint({size: CREATURE_SIZES.LARGE, topology: GRID_TOPOLOGIES.HEX, anchor});
    const hugeExpected = createTokenGridFootprint({size: CREATURE_SIZES.HUGE, topology: GRID_TOPOLOGIES.HEX, anchor});
    const largeToken = fakeToken({id: `hex-large-${type}`, scene, grid, offset: {i: 4, j: 5}, size: CREATURE_SIZES.LARGE, representedFields: largeExpected.fields});
    const hugeToken = fakeToken({id: `hex-huge-${type}`, scene, grid, offset: {i: 4, j: 5}, size: CREATURE_SIZES.HUGE, representedFields: hugeExpected.fields});

    assert.equal(adapter.tokenToFootprint(largeToken).footprint.fields.length, 3);
    assert.equal(adapter.tokenToFootprint(hugeToken).footprint.fields.length, 7);
  }
});

test("Foundry occupied-space mismatches are diagnostics and do not rewrite WildPath creature-size rules", () => {
  const grid = new FakeSquareGrid();
  const scene = fakeScene(grid);
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  const representedAsLarge = createTokenGridFootprint({
    size: CREATURE_SIZES.LARGE,
    topology: GRID_TOPOLOGIES.SQUARE,
    anchor: {x: 0, y: 0}
  });
  const token = fakeToken({
    id: "mismatched-huge",
    scene,
    grid,
    size: CREATURE_SIZES.HUGE,
    representedFields: representedAsLarge.fields
  });

  const permissive = adapter.tokenToFootprint(token);
  const strict = adapter.tokenToFootprint(token, {strictOccupancy: true});

  assert.equal(permissive.ok, true);
  assert.equal(permissive.code, FOUNDRY_TACTICAL_GRID_CODES.FOOTPRINT_MISMATCH);
  assert.equal(permissive.footprint.fields.length, 9);
  assert.equal(permissive.representedFields.length, 4);
  assert.equal(permissive.diagnostics[0].code, FOUNDRY_TACTICAL_GRID_CODES.FOOTPRINT_MISMATCH);
  assert.equal(strict.ok, false);
  assert.equal(strict.footprint.fields.length, 9);
});

test("scene scale conversion centralizes physical distance to tactical fields", () => {
  const fiveFoot = sceneDistanceToGridFields(30, {scene: fakeScene(new FakeSquareGrid({distance: 5}))});
  const tenFoot = sceneDistanceToGridFields(30, {scene: fakeScene(new FakeSquareGrid({distance: 10}))});

  assert.equal(fiveFoot.fields, 6);
  assert.equal(tenFoot.fields, 3);
});

test("adapter footprints compose with existing full-footprint range and reach on square and hex scenes", () => {
  const squareGrid = new FakeSquareGrid();
  const squareScene = fakeScene(squareGrid);
  const squareAdapter = createFoundryV14TacticalGridAdapter({scene: squareScene});
  const squareSource = squareAdapter.tokenToFootprint(fakeToken({
    id: "square-source",
    scene: squareScene,
    grid: squareGrid,
    offset: {i: 0, j: 0},
    size: CREATURE_SIZES.LARGE,
    representedFields: createTokenGridFootprint({size: CREATURE_SIZES.LARGE, topology: GRID_TOPOLOGIES.SQUARE}).fields
  })).footprint;
  const squareTarget = squareAdapter.tokenToFootprint(fakeToken({
    id: "square-target",
    scene: squareScene,
    grid: squareGrid,
    offset: {i: 3, j: 0},
    size: CREATURE_SIZES.HUGE,
    representedFields: createTokenGridFootprint({size: CREATURE_SIZES.HUGE, topology: GRID_TOPOLOGIES.SQUARE, anchor: {x: 3, y: 0}}).fields
  })).footprint;

  const hexGrid = new FakeHexGrid(FOUNDRY_GRID_TYPES.HEXODDR);
  const hexScene = fakeScene(hexGrid);
  const hexAdapter = createFoundryV14TacticalGridAdapter({scene: hexScene});
  const hexSource = hexAdapter.tokenToFootprint(fakeToken({
    id: "hex-source",
    scene: hexScene,
    grid: hexGrid,
    offset: {i: 0, j: 0},
    size: CREATURE_SIZES.LARGE,
    representedFields: createTokenGridFootprint({size: CREATURE_SIZES.LARGE, topology: GRID_TOPOLOGIES.HEX}).fields
  })).footprint;
  const hexTarget = hexAdapter.tokenToFootprint(fakeToken({
    id: "hex-target",
    scene: hexScene,
    grid: hexGrid,
    offset: fieldToOffset({q: 4, r: 0}, hexGrid),
    size: CREATURE_SIZES.HUGE,
    representedFields: createTokenGridFootprint({size: CREATURE_SIZES.HUGE, topology: GRID_TOPOLOGIES.HEX, anchor: {q: 4, r: 0}}).fields
  })).footprint;

  assert.equal(fieldDistance(squareSource.anchor, squareTarget.anchor, GRID_TOPOLOGIES.SQUARE), 3);
  assert.equal(footprintDistance(squareSource, squareTarget), 2);
  assert.equal(createReachFootprint({source: squareSource, reachDistance: 10, gridDistance: 5}).fields.some(field => {
    return Math.min(...squareSource.fields.map(source => fieldDistance(source, field, GRID_TOPOLOGIES.SQUARE))) === 2;
  }), true);

  assert.equal(fieldDistance(hexSource.anchor, hexTarget.anchor, GRID_TOPOLOGIES.HEX), 4);
  assert.equal(footprintDistance(hexSource, hexTarget), 2);
  assert.equal(createReachFootprint({source: hexSource, reachDistance: 10, gridDistance: 5}).fields.some(field => {
    return Math.min(...hexSource.fields.map(source => fieldDistance(source, field, GRID_TOPOLOGIES.HEX))) === 2;
  }), true);
});

test("area candidate discovery consumes mechanical GridFootprints and deduplicates multi-field targets", () => {
  const grid = new FakeSquareGrid();
  const scene = fakeScene(grid);
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  const huge = createTokenGridFootprint({
    size: CREATURE_SIZES.HUGE,
    topology: GRID_TOPOLOGIES.SQUARE,
    anchor: {x: 2, y: 0}
  });
  const hugeToken = fakeToken({
    id: "huge-target",
    scene,
    grid,
    offset: {i: 2, j: 0},
    size: CREATURE_SIZES.HUGE,
    representedFields: huge.fields
  });
  scene.tokens = [hugeToken];
  const area = {
    type: "GridFootprint",
    topology: GRID_TOPOLOGIES.SQUARE,
    fields: [{x: 2, y: 0}, {x: 3, y: 0}, {x: 4, y: 0}]
  };

  const result = adapter.resolveAreaTargetCandidates({footprint: area});

  assert.equal(result.ok, true);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].intersectingFields.length, 3);
});

test("square vertical proof adapts source boundary line placement through existing area targeting", () => {
  const grid = new FakeSquareGrid();
  const scene = fakeScene(grid);
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  const sourceExpected = createTokenGridFootprint({size: CREATURE_SIZES.LARGE, topology: GRID_TOPOLOGIES.SQUARE});
  const targetExpected = createTokenGridFootprint({
    size: CREATURE_SIZES.HUGE,
    topology: GRID_TOPOLOGIES.SQUARE,
    anchor: {x: 4, y: -1}
  });
  const sourceToken = fakeToken({id: "dragon", scene, grid, size: CREATURE_SIZES.LARGE, representedFields: sourceExpected.fields});
  const targetToken = fakeToken({
    id: "ogre",
    scene,
    grid,
    offset: {i: 4, j: -1},
    size: CREATURE_SIZES.HUGE,
    representedFields: targetExpected.fields
  });
  const sourceFootprint = adapter.tokenToFootprint(sourceToken);
  const targetFootprint = adapter.tokenToTargetFootprint(targetToken);
  const source = sourceFromAdapter("dragon", sourceFootprint);
  const rejected = selectSourceBoundaryOrigin({sources: [source], vertexId: "square-vertex:1,1"});
  const placement = selectSourceBoundaryOrigin({sources: [source], vertexId: "square-vertex:2,0"});
  const placedArea = previewSourceBoundaryArea({
    shape: AREA_SHAPES.LINE,
    placement,
    directionVertex: {id: "square-vertex:3,0", x: 3, y: 0, incidentFields: []},
    rangeDistance: 30,
    gridDistance: 5
  });
  const result = resolvePlacedAreaTargets({
    placedArea,
    tokenFootprints: [targetFootprint.tokenFootprint]
  });

  assert.equal(rejected.ok, false);
  assert.equal(placement.ok, true);
  assert.equal(placedArea.preview, placedArea.committed);
  assert.equal(placedArea.committed, placedArea.resolved);
  assert.equal(result.ok, true);
  assert.deepEqual(result.targeting.refinement.finalTargets.map(target => target.id), [`token:${scene.id}.ogre`]);
  assert.equal(result.targeting.physical.candidates[0].intersectingFields.length, 3);
});

test("hex vertical proof adapts source boundary cone placement through existing area targeting", () => {
  const grid = new FakeHexGrid(FOUNDRY_GRID_TYPES.HEXEVENQ);
  const scene = fakeScene(grid);
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  const sourceExpected = createTokenGridFootprint({size: CREATURE_SIZES.LARGE, topology: GRID_TOPOLOGIES.HEX});
  const targetExpected = createTokenGridFootprint({
    size: CREATURE_SIZES.HUGE,
    topology: GRID_TOPOLOGIES.HEX,
    anchor: {q: 3, r: 0}
  });
  const sourceToken = fakeToken({id: "wyvern", scene, grid, size: CREATURE_SIZES.LARGE, representedFields: sourceExpected.fields});
  const targetToken = fakeToken({
    id: "giant",
    scene,
    grid,
    offset: fieldToOffset({q: 3, r: 0}, grid),
    size: CREATURE_SIZES.HUGE,
    representedFields: targetExpected.fields
  });
  const sourceFootprint = adapter.tokenToFootprint(sourceToken);
  const targetFootprint = adapter.tokenToTargetFootprint(targetToken);
  const source = sourceFromAdapter("wyvern", sourceFootprint);
  const origin = boundaryVertexWithOutsideField(source.footprint, {q: 2, r: 0});
  const placement = selectSourceBoundaryOrigin({sources: [source], vertexId: origin.id});
  const placedArea = previewSourceBoundaryArea({
    shape: AREA_SHAPES.CONE,
    placement,
    direction: {q: 1, r: 0},
    rangeDistance: 15,
    gridDistance: 5
  });
  const result = resolvePlacedAreaTargets({
    placedArea,
    tokenFootprints: [targetFootprint.tokenFootprint]
  });

  assert.equal(origin.external, true);
  assert.equal(placement.ok, true);
  assert.equal(placedArea.ok, true);
  assert.equal(placedArea.preview, placedArea.resolved);
  assert.equal(result.ok, true);
  assert.deepEqual(result.targeting.refinement.finalTargets.map(target => target.id), [`token:${scene.id}.giant`]);
});

test("level and elevation metadata reject unsupported cross-level targeting predictably", () => {
  const grid = new FakeSquareGrid();
  const scene = fakeScene(grid);
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  const source = fakeToken({id: "source", scene, grid, levelId: "ground", elevation: 0});
  const same = fakeToken({id: "same", scene, grid, levelId: "ground", elevation: 0});
  const otherLevel = fakeToken({id: "other-level", scene, grid, levelId: "balcony", elevation: 0});
  const otherElevation = fakeToken({id: "other-elevation", scene, grid, levelId: "ground", elevation: 10});

  assert.equal(adapter.validateTokenLevelRelation(source, same).ok, true);
  assert.equal(adapter.validateTokenLevelRelation(source, otherLevel).code, FOUNDRY_TACTICAL_GRID_CODES.UNSUPPORTED_LEVEL_RELATION);
  assert.equal(adapter.validateTokenLevelRelation(source, otherElevation).code, FOUNDRY_TACTICAL_GRID_CODES.UNSUPPORTED_LEVEL_RELATION);
});

test("target candidates keep Foundry disposition as metadata rather than automatic enemy eligibility", () => {
  const grid = new FakeSquareGrid();
  const scene = fakeScene(grid);
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  const token = fakeToken({id: "hostile-looking", scene, grid, disposition: -1});

  const result = adapter.tokenToTargetFootprint(token);
  const targeting = adapter.resolveAreaTargetSet({
    footprint: {fields: [{x: 0, y: 0}]},
    tokens: [token],
    eligibilityPolicy: {dispositions: ["enemy"]}
  });

  assert.equal(result.tokenFootprint.disposition, "unknown");
  assert.equal(result.tokenFootprint.metadata.foundry.disposition, -1);
  assert.equal(targeting.refinement.finalTargets.length, 0);
});

function boundaryVertexWithOutsideField(footprint, outsideField) {
  const outsideKey = fieldKey(outsideField, footprint.topology);
  return footprint.boundaryVertices.find(vertex => {
    return vertex.incidentFields.some(field => fieldKey(field, footprint.topology) === outsideKey);
  });
}

function fieldToOffset(field, grid) {
  if ( grid.type === FOUNDRY_GRID_TYPES.SQUARE ) return {i: field.x, j: field.y};
  return axialToOffset(field, grid.variant);
}

function offsetToAxial(offset, variant) {
  const col = Number(offset.i);
  const row = Number(offset.j);
  switch ( variant ) {
    case FOUNDRY_HEX_OFFSET_VARIANTS.ODD_R:
      return {q: col - ((row - parity(row)) / 2), r: row};
    case FOUNDRY_HEX_OFFSET_VARIANTS.EVEN_R:
      return {q: col - ((row + parity(row)) / 2), r: row};
    case FOUNDRY_HEX_OFFSET_VARIANTS.ODD_Q:
      return {q: col, r: row - ((col - parity(col)) / 2)};
    case FOUNDRY_HEX_OFFSET_VARIANTS.EVEN_Q:
      return {q: col, r: row - ((col + parity(col)) / 2)};
    default:
      throw new Error(`Unsupported hex variant: ${variant}`);
  }
}

function axialToOffset(field, variant) {
  const q = Number(field.q);
  const r = Number(field.r);
  switch ( variant ) {
    case FOUNDRY_HEX_OFFSET_VARIANTS.ODD_R:
      return {i: q + ((r - parity(r)) / 2), j: r};
    case FOUNDRY_HEX_OFFSET_VARIANTS.EVEN_R:
      return {i: q + ((r + parity(r)) / 2), j: r};
    case FOUNDRY_HEX_OFFSET_VARIANTS.ODD_Q:
      return {i: q, j: r + ((q - parity(q)) / 2)};
    case FOUNDRY_HEX_OFFSET_VARIANTS.EVEN_Q:
      return {i: q, j: r + ((q + parity(q)) / 2)};
    default:
      throw new Error(`Unsupported hex variant: ${variant}`);
  }
}

function parity(value) {
  return Math.abs(Number(value)) % 2;
}

function squaredDistance(a, b) {
  return ((Number(a.x) || 0) - (Number(b.x) || 0)) ** 2
    + (((Number(a.y) || 0) - (Number(b.y) || 0)) ** 2);
}
