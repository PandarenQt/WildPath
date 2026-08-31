import {resolveAreaTargetCandidates, resolveAreaTargetSet} from "../helpers/area-targeting.mjs";
import {createEntityRef, normalizeEntityRef, tokenRef} from "../helpers/entity-refs.mjs";
import {
  CREATURE_SIZE_ORDER,
  CREATURE_SIZES,
  DND5E_CREATURE_FOOTPRINT_PROVIDER,
  GRID_TOPOLOGIES,
  adjacentFields,
  createTokenFootprintDefinition,
  createTokenGridFootprint,
  distanceAdjacentFields,
  fieldKey,
  normalizeGridField,
  sortGridFields
} from "../helpers/grid-footprints.mjs";

export const FOUNDRY_GRID_TYPES = Object.freeze({
  GRIDLESS: 0,
  SQUARE: 1,
  HEXODDR: 2,
  HEXEVENR: 3,
  HEXODDQ: 4,
  HEXEVENQ: 5
});

export const FOUNDRY_HEX_OFFSET_VARIANTS = Object.freeze({
  ODD_R: "odd-r",
  EVEN_R: "even-r",
  ODD_Q: "odd-q",
  EVEN_Q: "even-q"
});

export const FOUNDRY_TACTICAL_GRID_CODES = Object.freeze({
  OK: "OK",
  GRIDLESS_UNSUPPORTED: "GRIDLESS_UNSUPPORTED",
  UNSUPPORTED_GRID: "UNSUPPORTED_GRID",
  INVALID_GRID_OFFSET: "INVALID_GRID_OFFSET",
  INVALID_GRID_FIELD: "INVALID_GRID_FIELD",
  INVALID_GRID_SCALE: "INVALID_GRID_SCALE",
  UNRESOLVABLE_POINT: "UNRESOLVABLE_POINT",
  UNRESOLVABLE_VERTEX: "UNRESOLVABLE_VERTEX",
  TOKEN_NOT_ON_SCENE: "TOKEN_NOT_ON_SCENE",
  UNRESOLVABLE_TOKEN: "UNRESOLVABLE_TOKEN",
  UNSUPPORTED_FOOTPRINT: "UNSUPPORTED_FOOTPRINT",
  FOUNDRY_OCCUPANCY_UNAVAILABLE: "FOUNDRY_OCCUPANCY_UNAVAILABLE",
  FOOTPRINT_MISMATCH: "FOOTPRINT_MISMATCH",
  ADJACENCY_MISMATCH: "ADJACENCY_MISMATCH",
  UNSUPPORTED_LEVEL_RELATION: "UNSUPPORTED_LEVEL_RELATION"
});

const HEX_GRID_TYPES = new Set([
  FOUNDRY_GRID_TYPES.HEXODDR,
  FOUNDRY_GRID_TYPES.HEXEVENR,
  FOUNDRY_GRID_TYPES.HEXODDQ,
  FOUNDRY_GRID_TYPES.HEXEVENQ
]);

/* -------------------------------------------- */

export function createFoundryV14TacticalGridAdapter({
  id="foundry-v14-tactical-grid",
  label="Foundry V14 Tactical Grid Adapter",
  scene=null,
  grid=null,
  tokens=null,
  footprintProvider=DND5E_CREATURE_FOOTPRINT_PROVIDER,
  sizeResolver=defaultTokenSizeResolver
}={}) {
  const resolvedGrid = grid ?? scene?.grid ?? null;
  return {
    id,
    type: "foundry-v14-tactical-grid",
    label,
    scene,
    grid: resolvedGrid,

    getSceneContext() {
      return createFoundryV14TacticalSceneContext({scene, grid: resolvedGrid});
    },

    getCapabilities() {
      const context = createFoundryV14TacticalSceneContext({scene, grid: resolvedGrid});
      if ( !context.ok ) return {
        ok: false,
        code: context.code,
        reason: context.reason,
        gridded: false,
        fields: false,
        vertices: false,
        tokenFootprints: false,
        gridless: false
      };
      return clonePlain(context.context.capabilities);
    },

    offsetToField(offset) {
      return foundryOffsetToGridField(offset, {grid: resolvedGrid, scene});
    },

    fieldToOffset(field) {
      return gridFieldToFoundryOffset(field, {grid: resolvedGrid, scene});
    },

    pointToField(point) {
      return foundryPointToGridField(point, {grid: resolvedGrid, scene});
    },

    fieldToCenterPoint(field) {
      return gridFieldToFoundryCenterPoint(field, {grid: resolvedGrid, scene});
    },

    fieldToVertices(field) {
      return gridFieldToGridVertices(field, {grid: resolvedGrid, scene});
    },

    pointToVertex(point) {
      return foundryPointToGridVertex(point, {grid: resolvedGrid, scene});
    },

    compareAdjacentOffsets(field) {
      return compareFoundryAdjacentOffsets(field, {grid: resolvedGrid, scene});
    },

    distanceToGridFields(distance) {
      return sceneDistanceToGridFields(distance, {grid: resolvedGrid, scene});
    },

    tokenToFootprint(token, options={}) {
      return foundryTokenToTokenGridFootprint(token, {
        grid: resolvedGrid,
        scene,
        footprintProvider,
        sizeResolver,
        ...options
      });
    },

    tokenToTargetFootprint(token, options={}) {
      return foundryTokenToTargetFootprint(token, {
        grid: resolvedGrid,
        scene,
        footprintProvider,
        sizeResolver,
        ...options
      });
    },

    collectTokenTargetFootprints(options={}) {
      return collectFoundryTokenTargetFootprints({
        scene,
        grid: resolvedGrid,
        tokens: options.tokens ?? tokens,
        footprintProvider,
        sizeResolver,
        ...options
      });
    },

    resolveAreaTargetCandidates(options={}) {
      const collected = collectFoundryTokenTargetFootprints({
        scene,
        grid: resolvedGrid,
        tokens: options.tokens ?? tokens,
        footprintProvider,
        sizeResolver,
        sourceToken: options.sourceToken,
        excludeUnsupportedLevels: options.excludeUnsupportedLevels
      });
      const physical = resolveAreaTargetCandidates({
        footprint: options.footprint,
        tokenFootprints: collected.tokenFootprints,
        metadata: options.metadata ?? {}
      });
      return {
        ...physical,
        tokenFootprints: collected.tokenFootprints,
        skipped: collected.skipped,
        failures: collected.failures
      };
    },

    resolveAreaTargetSet(options={}) {
      const collected = collectFoundryTokenTargetFootprints({
        scene,
        grid: resolvedGrid,
        tokens: options.tokens ?? tokens,
        footprintProvider,
        sizeResolver,
        sourceToken: options.sourceToken,
        excludeUnsupportedLevels: options.excludeUnsupportedLevels
      });
      const targeting = resolveAreaTargetSet({
        footprint: options.footprint,
        tokenFootprints: collected.tokenFootprints,
        eligibilityPolicy: options.eligibilityPolicy ?? {},
        refinementPolicy: options.refinementPolicy ?? {},
        decisions: options.decisions ?? [],
        context: options.context ?? {},
        metadata: options.metadata ?? {}
      });
      return {
        ...targeting,
        tokenFootprints: collected.tokenFootprints,
        skipped: collected.skipped,
        failures: collected.failures
      };
    },

    compareTokenOccupiedSpaces(token, options={}) {
      const footprint = options.footprint
        ?? this.tokenToFootprint(token, {...options, strictOccupancy: false}).footprint;
      return compareFoundryTokenOccupiedSpaces(token, footprint, {grid: resolvedGrid, scene});
    },

    validateTokenLevelRelation(sourceToken, targetToken, options={}) {
      return validateFoundryTokenLevelRelation(sourceToken, targetToken, options);
    }
  };
}

/* -------------------------------------------- */

export function createFoundryV14TacticalSceneContext({scene=null, grid=null}={}) {
  const resolvedGrid = grid ?? scene?.grid ?? null;
  const gridInfo = identifyFoundryGrid({scene, grid: resolvedGrid});
  if ( !gridInfo.ok ) return gridInfo;

  const distance = finiteNumber(
    resolvedGrid?.distance
      ?? scene?.dimensions?.distance
      ?? scene?._source?.grid?.distance
      ?? scene?.grid?.distance
  );
  const size = finiteNumber(
    resolvedGrid?.size
      ?? scene?.dimensions?.size
      ?? scene?._source?.grid?.size
      ?? scene?.grid?.size
  );
  const units = String(
    resolvedGrid?.units
      ?? scene?.dimensions?.units
      ?? scene?._source?.grid?.units
      ?? scene?.grid?.units
      ?? ""
  );

  if ( !gridInfo.gridless && !(distance > 0) ) {
    return failure(FOUNDRY_TACTICAL_GRID_CODES.INVALID_GRID_SCALE, "Gridded tactical scenes require a positive grid distance.");
  }

  const sceneId = scene?.id ?? scene?._id ?? null;
  const context = {
    type: "TacticalSceneContext",
    scene: {
      id: sceneId,
      ref: sceneId ? createEntityRef("scene", sceneId) : null,
      uuid: scene?.uuid ?? null,
      name: scene?.name ?? null
    },
    grid: {
      type: gridInfo.kind,
      topology: gridInfo.topology,
      gridless: gridInfo.gridless,
      foundryType: gridInfo.foundryType,
      distance: gridInfo.gridless ? (distance ?? 0) : distance,
      units,
      size: size ?? 0,
      sizeX: finiteNumber(resolvedGrid?.sizeX ?? scene?.dimensions?.size) ?? size ?? 0,
      sizeY: finiteNumber(resolvedGrid?.sizeY ?? scene?.dimensions?.size) ?? size ?? 0,
      columns: gridInfo.columns,
      even: gridInfo.even,
      orientation: gridInfo.orientation,
      offsetVariant: gridInfo.offsetVariant
    },
    dimensions: plainDimensions(scene?.dimensions),
    levels: {
      initialLevelRef: scene?.initialLevel?.id ? createEntityRef("scene-level", scene.initialLevel.id, {scope: sceneId}) : null,
      availableLevelRefs: Array.from(scene?.availableLevels ?? [])
        .map(level => level?.id ? createEntityRef("scene-level", level.id, {scope: sceneId}) : null)
        .filter(Boolean)
    },
    capabilities: {
      ok: true,
      code: FOUNDRY_TACTICAL_GRID_CODES.OK,
      gridded: !gridInfo.gridless,
      fields: !gridInfo.gridless,
      vertices: !gridInfo.gridless,
      tokenFootprints: !gridInfo.gridless,
      gridless: gridInfo.gridless,
      continuousGeometry: gridInfo.gridless
    },
    foundryApisUsed: [
      "Scene#grid",
      "Scene#dimensions",
      "foundry.grid.BaseGrid#isSquare",
      "foundry.grid.BaseGrid#isHexagonal",
      "foundry.grid.BaseGrid#isGridless",
      "foundry.grid.BaseGrid#getOffset",
      "foundry.grid.BaseGrid#getCenterPoint",
      "foundry.grid.BaseGrid#getVertices",
      "foundry.grid.BaseGrid#getAdjacentOffsets",
      "foundry.grid.HexagonalGrid#offsetToCube",
      "foundry.grid.HexagonalGrid#cubeToOffset",
      "TokenDocument#getOccupiedGridSpaceOffsets"
    ]
  };

  return {ok: true, code: FOUNDRY_TACTICAL_GRID_CODES.OK, context};
}

/* -------------------------------------------- */

export function identifyFoundryGrid({scene=null, grid=null}={}) {
  const resolvedGrid = grid ?? scene?.grid ?? null;
  const foundryType = finiteInteger(
    resolvedGrid?.type
      ?? scene?._source?.grid?.type
      ?? scene?.grid?.type
      ?? scene?.gridType
  );

  if ( resolvedGrid?.isGridless === true || foundryType === FOUNDRY_GRID_TYPES.GRIDLESS ) {
    return {
      ok: true,
      code: FOUNDRY_TACTICAL_GRID_CODES.OK,
      kind: "gridless",
      topology: null,
      gridless: true,
      foundryType: FOUNDRY_GRID_TYPES.GRIDLESS,
      columns: null,
      even: null,
      orientation: "gridless",
      offsetVariant: null
    };
  }

  if ( resolvedGrid?.isSquare === true || foundryType === FOUNDRY_GRID_TYPES.SQUARE ) {
    return {
      ok: true,
      code: FOUNDRY_TACTICAL_GRID_CODES.OK,
      kind: "square",
      topology: GRID_TOPOLOGIES.SQUARE,
      gridless: false,
      foundryType: FOUNDRY_GRID_TYPES.SQUARE,
      columns: false,
      even: null,
      orientation: "square",
      offsetVariant: null
    };
  }

  if ( resolvedGrid?.isHexagonal === true || HEX_GRID_TYPES.has(foundryType) ) {
    const hex = inferFoundryHexInfo({grid: resolvedGrid, foundryType});
    return {
      ok: true,
      code: FOUNDRY_TACTICAL_GRID_CODES.OK,
      kind: "hex",
      topology: GRID_TOPOLOGIES.HEX,
      gridless: false,
      foundryType: foundryType ?? hex.foundryType,
      columns: hex.columns,
      even: hex.even,
      orientation: hex.columns ? "columns" : "rows",
      displayOrientation: hex.columns ? "flat-topped" : "pointy-topped",
      offsetVariant: hex.offsetVariant
    };
  }

  return failure(FOUNDRY_TACTICAL_GRID_CODES.UNSUPPORTED_GRID, "Unsupported or missing Foundry V14 grid type.");
}

/* -------------------------------------------- */

export function foundryOffsetToGridField(offset, {scene=null, grid=null}={}) {
  const gridInfo = identifyFoundryGrid({scene, grid});
  if ( !gridInfo.ok ) return gridInfo;
  if ( gridInfo.gridless ) return failure(FOUNDRY_TACTICAL_GRID_CODES.GRIDLESS_UNSUPPORTED, "Gridless scenes do not expose tactical GridFields.");

  const foundryOffset = normalizeFoundryOffset(offset);
  if ( !foundryOffset ) return failure(FOUNDRY_TACTICAL_GRID_CODES.INVALID_GRID_OFFSET, "Foundry grid offset requires finite i and j coordinates.");

  if ( gridInfo.topology === GRID_TOPOLOGIES.SQUARE ) {
    return {
      ok: true,
      code: FOUNDRY_TACTICAL_GRID_CODES.OK,
      topology: GRID_TOPOLOGIES.SQUARE,
      field: {x: foundryOffset.i, y: foundryOffset.j},
      offset: foundryOffset,
      grid: plainGridInfo(gridInfo)
    };
  }

  const cube = foundryHexOffsetToCube(foundryOffset, {grid, gridInfo});
  if ( !cube ) return failure(FOUNDRY_TACTICAL_GRID_CODES.INVALID_GRID_OFFSET, "Hex grid offset could not be converted to cube coordinates.");
  return {
    ok: true,
    code: FOUNDRY_TACTICAL_GRID_CODES.OK,
    topology: GRID_TOPOLOGIES.HEX,
    field: {q: cube.q, r: cube.r},
    offset: foundryOffset,
    cube,
    grid: plainGridInfo(gridInfo)
  };
}

/* -------------------------------------------- */

export function gridFieldToFoundryOffset(field, {scene=null, grid=null}={}) {
  const gridInfo = identifyFoundryGrid({scene, grid});
  if ( !gridInfo.ok ) return gridInfo;
  if ( gridInfo.gridless ) return failure(FOUNDRY_TACTICAL_GRID_CODES.GRIDLESS_UNSUPPORTED, "Gridless scenes do not expose tactical GridFields.");

  try {
    const normalized = normalizeGridField(field, gridInfo.topology);
    if ( gridInfo.topology === GRID_TOPOLOGIES.SQUARE ) {
      const offset = {i: finiteInteger(normalized.x), j: finiteInteger(normalized.y)};
      if ( offset.i == null || offset.j == null ) return failure(FOUNDRY_TACTICAL_GRID_CODES.INVALID_GRID_FIELD, "Square GridField requires finite x and y coordinates.");
      return {
        ok: true,
        code: FOUNDRY_TACTICAL_GRID_CODES.OK,
        topology: GRID_TOPOLOGIES.SQUARE,
        field: normalized,
        offset,
        grid: plainGridInfo(gridInfo)
      };
    }

    const q = finiteInteger(normalized.q);
    const r = finiteInteger(normalized.r);
    if ( q == null || r == null ) return failure(FOUNDRY_TACTICAL_GRID_CODES.INVALID_GRID_FIELD, "Hex GridField requires finite q and r coordinates.");
    const cube = {q, r, s: -q - r};
    const offset = foundryHexCubeToOffset(cube, {grid, gridInfo});
    if ( !offset ) return failure(FOUNDRY_TACTICAL_GRID_CODES.INVALID_GRID_FIELD, "Hex GridField could not be converted to a Foundry offset.");
    return {
      ok: true,
      code: FOUNDRY_TACTICAL_GRID_CODES.OK,
      topology: GRID_TOPOLOGIES.HEX,
      field: normalized,
      offset,
      cube,
      grid: plainGridInfo(gridInfo)
    };
  } catch (error) {
    return failure(FOUNDRY_TACTICAL_GRID_CODES.INVALID_GRID_FIELD, error?.message ?? String(error));
  }
}

/* -------------------------------------------- */

export function foundryPointToGridField(point, {scene=null, grid=null}={}) {
  const gridInfo = identifyFoundryGrid({scene, grid});
  if ( !gridInfo.ok ) return gridInfo;
  if ( gridInfo.gridless ) return failure(FOUNDRY_TACTICAL_GRID_CODES.GRIDLESS_UNSUPPORTED, "Gridless scenes do not expose tactical GridFields.");

  const normalizedPoint = normalizePoint(point);
  if ( !normalizedPoint ) return failure(FOUNDRY_TACTICAL_GRID_CODES.UNRESOLVABLE_POINT, "Point requires finite x and y coordinates.");

  if ( typeof grid?.getOffset === "function" ) {
    try {
      return foundryOffsetToGridField(grid.getOffset(normalizedPoint), {scene, grid});
    } catch (error) {
      return failure(FOUNDRY_TACTICAL_GRID_CODES.UNRESOLVABLE_POINT, error?.message ?? String(error));
    }
  }

  if ( gridInfo.topology === GRID_TOPOLOGIES.SQUARE ) {
    const dimensions = scene?.dimensions ?? {};
    const sizeX = finiteNumber(grid?.sizeX ?? dimensions.size) ?? finiteNumber(grid?.size) ?? 1;
    const sizeY = finiteNumber(grid?.sizeY ?? dimensions.size) ?? finiteNumber(grid?.size) ?? 1;
    const originX = finiteNumber(dimensions.sceneX) ?? 0;
    const originY = finiteNumber(dimensions.sceneY) ?? 0;
    return {
      ok: true,
      code: FOUNDRY_TACTICAL_GRID_CODES.OK,
      topology: GRID_TOPOLOGIES.SQUARE,
      field: {
        x: Math.floor((normalizedPoint.x - originX) / sizeX),
        y: Math.floor((normalizedPoint.y - originY) / sizeY)
      },
      point: normalizedPoint,
      grid: plainGridInfo(gridInfo)
    };
  }

  return failure(FOUNDRY_TACTICAL_GRID_CODES.UNRESOLVABLE_POINT, "Hex point conversion requires Foundry HexagonalGrid#getOffset.");
}

/* -------------------------------------------- */

export function gridFieldToFoundryCenterPoint(field, {scene=null, grid=null}={}) {
  const offsetResult = gridFieldToFoundryOffset(field, {scene, grid});
  if ( !offsetResult.ok ) return offsetResult;

  if ( typeof grid?.getCenterPoint === "function" ) {
    try {
      return {
        ok: true,
        code: FOUNDRY_TACTICAL_GRID_CODES.OK,
        topology: offsetResult.topology,
        field: offsetResult.field,
        offset: offsetResult.offset,
        point: clonePlain(grid.getCenterPoint(offsetResult.offset))
      };
    } catch (error) {
      return failure(FOUNDRY_TACTICAL_GRID_CODES.UNRESOLVABLE_POINT, error?.message ?? String(error));
    }
  }

  if ( offsetResult.topology === GRID_TOPOLOGIES.SQUARE ) {
    const dimensions = scene?.dimensions ?? {};
    const sizeX = finiteNumber(grid?.sizeX ?? dimensions.size) ?? finiteNumber(grid?.size) ?? 1;
    const sizeY = finiteNumber(grid?.sizeY ?? dimensions.size) ?? finiteNumber(grid?.size) ?? 1;
    const originX = finiteNumber(dimensions.sceneX) ?? 0;
    const originY = finiteNumber(dimensions.sceneY) ?? 0;
    return {
      ok: true,
      code: FOUNDRY_TACTICAL_GRID_CODES.OK,
      topology: offsetResult.topology,
      field: offsetResult.field,
      offset: offsetResult.offset,
      point: {
        x: originX + ((offsetResult.offset.i + 0.5) * sizeX),
        y: originY + ((offsetResult.offset.j + 0.5) * sizeY)
      }
    };
  }

  return failure(FOUNDRY_TACTICAL_GRID_CODES.UNRESOLVABLE_POINT, "Hex center conversion requires Foundry HexagonalGrid#getCenterPoint.");
}

/* -------------------------------------------- */

export function gridFieldToGridVertices(field, {scene=null, grid=null}={}) {
  const gridInfo = identifyFoundryGrid({scene, grid});
  if ( !gridInfo.ok ) return gridInfo;
  if ( gridInfo.gridless ) return failure(FOUNDRY_TACTICAL_GRID_CODES.GRIDLESS_UNSUPPORTED, "Gridless scenes do not expose tactical GridVertices.");

  const offsetResult = gridFieldToFoundryOffset(field, {scene, grid});
  if ( !offsetResult.ok ) return offsetResult;

  const zeroOffset = gridInfo.topology === GRID_TOPOLOGIES.HEX ? {q: 0, r: 0} : {x: 0, y: 0};
  const definition = createTokenFootprintDefinition({
    size: CREATURE_SIZES.MEDIUM,
    topology: gridInfo.topology,
    offsets: [zeroOffset]
  });
  const footprint = createTokenGridFootprint({
    topology: gridInfo.topology,
    anchor: offsetResult.field,
    definition
  });
  const foundryVertices = foundryVerticesForOffset(offsetResult.offset, grid);
  const vertices = footprint.boundaryVertices.map((vertex, index) => ({
    ...clonePlain(vertex),
    metadata: {
      foundry: {
        point: clonePlain(foundryPointForVertex(vertex, offsetResult.offset, gridInfo, foundryVertices, index))
      }
    }
  }));

  return {
    ok: true,
    code: FOUNDRY_TACTICAL_GRID_CODES.OK,
    topology: gridInfo.topology,
    field: offsetResult.field,
    offset: offsetResult.offset,
    vertices,
    foundryVertices: foundryVertices.map(clonePlain)
  };
}

/* -------------------------------------------- */

export function foundryPointToGridVertex(point, {scene=null, grid=null}={}) {
  const fieldResult = foundryPointToGridField(point, {scene, grid});
  if ( !fieldResult.ok ) return fieldResult;
  const gridInfo = identifyFoundryGrid({scene, grid});
  if ( !gridInfo.ok ) return gridInfo;

  const snapped = snapPointToVertex(point, grid);
  const candidateFields = sortGridFields([
    fieldResult.field,
    ...distanceAdjacentFields(fieldResult.field, gridInfo.topology)
  ], gridInfo.topology);
  const candidates = [];
  for ( const field of candidateFields ) {
    const verticesResult = gridFieldToGridVertices(field, {scene, grid});
    if ( !verticesResult.ok ) continue;
    for ( const vertex of verticesResult.vertices ) {
      const pointValue = vertex.metadata?.foundry?.point;
      if ( pointValue ) candidates.push({vertex, point: pointValue});
    }
  }
  if ( !candidates.length ) return failure(FOUNDRY_TACTICAL_GRID_CODES.UNRESOLVABLE_VERTEX, "No Foundry grid vertices were available for this point.");

  const nearest = candidates.sort((a, b) => {
    const distance = squaredDistance(a.point, snapped) - squaredDistance(b.point, snapped);
    if ( distance ) return distance;
    return a.vertex.id.localeCompare(b.vertex.id);
  })[0];
  return {
    ok: true,
    code: FOUNDRY_TACTICAL_GRID_CODES.OK,
    topology: gridInfo.topology,
    field: fieldResult.field,
    vertex: clonePlain(nearest.vertex),
    point: clonePlain(nearest.point),
    snappedPoint: clonePlain(snapped)
  };
}

/* -------------------------------------------- */

export function compareFoundryAdjacentOffsets(field, {scene=null, grid=null}={}) {
  const gridInfo = identifyFoundryGrid({scene, grid});
  if ( !gridInfo.ok ) return gridInfo;
  if ( gridInfo.gridless ) return failure(FOUNDRY_TACTICAL_GRID_CODES.GRIDLESS_UNSUPPORTED, "Gridless scenes do not expose tactical adjacency.");

  const offsetResult = gridFieldToFoundryOffset(field, {scene, grid});
  if ( !offsetResult.ok ) return offsetResult;

  const foundryAdjacent = typeof grid?.getAdjacentOffsets === "function"
    ? grid.getAdjacentOffsets(offsetResult.offset)
      .map(offset => foundryOffsetToGridField(offset, {scene, grid}))
      .filter(result => result.ok)
      .map(result => result.field)
    : [];
  const wildPathAdjacent = adjacentFields(offsetResult.field, gridInfo.topology);
  const foundryKeys = foundryAdjacent.map(candidate => fieldKey(candidate, gridInfo.topology)).sort();
  const wildPathKeys = wildPathAdjacent.map(candidate => fieldKey(candidate, gridInfo.topology)).sort();
  const matches = foundryAdjacent.length === 0 || sameStringArray(foundryKeys, wildPathKeys);

  return {
    ok: matches,
    code: matches ? FOUNDRY_TACTICAL_GRID_CODES.OK : FOUNDRY_TACTICAL_GRID_CODES.ADJACENCY_MISMATCH,
    topology: gridInfo.topology,
    field: offsetResult.field,
    foundryAdjacent: foundryAdjacent.map(clonePlain),
    wildPathAdjacent: wildPathAdjacent.map(clonePlain),
    reason: matches ? null : "Foundry adjacent offsets do not match WildPath tactical adjacency for the translated field."
  };
}

/* -------------------------------------------- */

export function sceneDistanceToGridFields(distance, {scene=null, grid=null}={}) {
  const context = createFoundryV14TacticalSceneContext({scene, grid});
  if ( !context.ok ) return context;
  if ( !context.context.capabilities.fields ) {
    return failure(FOUNDRY_TACTICAL_GRID_CODES.GRIDLESS_UNSUPPORTED, "Gridless scenes do not convert physical distance into tactical fields.");
  }
  const gridDistance = context.context.grid.distance;
  if ( !(gridDistance > 0) ) return failure(FOUNDRY_TACTICAL_GRID_CODES.INVALID_GRID_SCALE, "Scene grid distance must be positive.");
  return {
    ok: true,
    code: FOUNDRY_TACTICAL_GRID_CODES.OK,
    distance: Number(distance) || 0,
    gridDistance,
    fields: Math.floor(Math.max(Number(distance) || 0, 0) / gridDistance),
    units: context.context.grid.units
  };
}

/* -------------------------------------------- */

export function foundryTokenToTokenGridFootprint(token, {
  scene=null,
  grid=null,
  size=null,
  effectiveSize=null,
  definition=null,
  footprintProvider=DND5E_CREATURE_FOOTPRINT_PROVIDER,
  sizeResolver=defaultTokenSizeResolver,
  anchor=null,
  strictOccupancy=false,
  metadata={}
}={}) {
  const tokenDocument = resolveTokenDocument(token);
  if ( !tokenDocument ) return failure(FOUNDRY_TACTICAL_GRID_CODES.UNRESOLVABLE_TOKEN, "A TokenDocument or Token placeable is required.");

  const gridInfo = identifyFoundryGrid({scene, grid});
  if ( !gridInfo.ok ) return gridInfo;
  if ( gridInfo.gridless ) return failure(FOUNDRY_TACTICAL_GRID_CODES.GRIDLESS_UNSUPPORTED, "Gridless scenes do not expose tactical TokenGridFootprints.");

  const sceneCheck = validateTokenScene(tokenDocument, scene);
  if ( !sceneCheck.ok ) return sceneCheck;

  const resolvedSize = normalizeCreatureSize(size ?? sizeResolver(tokenDocument, {scene, grid}) ?? CREATURE_SIZES.MEDIUM);
  const resolvedEffectiveSize = normalizeCreatureSize(effectiveSize ?? resolvedSize);
  if ( !resolvedSize || !resolvedEffectiveSize ) {
    return failure(FOUNDRY_TACTICAL_GRID_CODES.UNSUPPORTED_FOOTPRINT, "Token creature size is not supported by the configured footprint provider.");
  }

  const represented = getFoundryTokenOccupiedGridSpaceFields(tokenDocument, {scene, grid});
  const anchorResult = resolveTokenAnchor({
    tokenDocument,
    scene,
    grid,
    gridInfo,
    representedFields: represented.fields,
    size: resolvedSize,
    effectiveSize: resolvedEffectiveSize,
    definition,
    footprintProvider,
    explicitAnchor: anchor
  });
  if ( !anchorResult.ok ) return anchorResult;

  let footprint;
  try {
    footprint = createTokenGridFootprint({
      anchor: anchorResult.anchor,
      size: resolvedSize,
      effectiveSize: resolvedEffectiveSize,
      topology: gridInfo.topology,
      provider: footprintProvider,
      definition,
      metadata: {
        ...clonePlain(metadata),
        scene: plainSceneRef(scene),
        token: plainTokenRef(tokenDocument, scene),
        adapter: "foundry-v14-tactical-grid"
      }
    });
  } catch (error) {
    return failure(FOUNDRY_TACTICAL_GRID_CODES.UNSUPPORTED_FOOTPRINT, error?.message ?? String(error));
  }

  const occupancy = compareFieldSets(footprint.fields, represented.fields, gridInfo.topology);
  const diagnostics = [];
  if ( !represented.available ) diagnostics.push({
    ok: false,
    code: FOUNDRY_TACTICAL_GRID_CODES.FOUNDRY_OCCUPANCY_UNAVAILABLE,
    reason: represented.reason,
    representedFields: []
  });
  else if ( !occupancy.matches ) diagnostics.push({
    ok: false,
    code: FOUNDRY_TACTICAL_GRID_CODES.FOOTPRINT_MISMATCH,
    reason: "Foundry represented occupied spaces differ from the WildPath footprint definition.",
    expectedFields: footprint.fields.map(clonePlain),
    representedFields: represented.fields.map(clonePlain),
    missingFields: occupancy.missing.map(clonePlain),
    extraFields: occupancy.extra.map(clonePlain)
  });

  const hasMismatch = diagnostics.some(diagnostic => diagnostic.code === FOUNDRY_TACTICAL_GRID_CODES.FOOTPRINT_MISMATCH);
  return {
    ok: !(strictOccupancy && hasMismatch),
    code: hasMismatch ? FOUNDRY_TACTICAL_GRID_CODES.FOOTPRINT_MISMATCH : FOUNDRY_TACTICAL_GRID_CODES.OK,
    topology: gridInfo.topology,
    token: plainTokenRef(tokenDocument, scene),
    actor: plainActorRef(tokenDocument.actor ?? token?.actor ?? null),
    anchor: anchorResult.anchor,
    footprint,
    representedFields: represented.fields.map(clonePlain),
    diagnostics,
    metadata: {
      anchorSource: anchorResult.source,
      foundryOccupancyAvailable: represented.available
    }
  };
}

/* -------------------------------------------- */

export function compareFoundryTokenOccupiedSpaces(token, footprint, {scene=null, grid=null}={}) {
  const tokenDocument = resolveTokenDocument(token);
  if ( !tokenDocument ) return failure(FOUNDRY_TACTICAL_GRID_CODES.UNRESOLVABLE_TOKEN, "A TokenDocument or Token placeable is required.");
  const gridInfo = identifyFoundryGrid({scene, grid});
  if ( !gridInfo.ok ) return gridInfo;
  if ( gridInfo.gridless ) return failure(FOUNDRY_TACTICAL_GRID_CODES.GRIDLESS_UNSUPPORTED, "Gridless scenes do not expose tactical TokenGridFootprints.");

  const represented = getFoundryTokenOccupiedGridSpaceFields(tokenDocument, {scene, grid});
  if ( !represented.available ) {
    return {
      ok: false,
      code: FOUNDRY_TACTICAL_GRID_CODES.FOUNDRY_OCCUPANCY_UNAVAILABLE,
      reason: represented.reason,
      expectedFields: footprint?.fields?.map(clonePlain) ?? [],
      representedFields: []
    };
  }
  const comparison = compareFieldSets(footprint?.fields ?? [], represented.fields, gridInfo.topology);
  return {
    ok: comparison.matches,
    code: comparison.matches ? FOUNDRY_TACTICAL_GRID_CODES.OK : FOUNDRY_TACTICAL_GRID_CODES.FOOTPRINT_MISMATCH,
    reason: comparison.matches ? null : "Foundry represented occupied spaces differ from the WildPath footprint definition.",
    expectedFields: (footprint?.fields ?? []).map(clonePlain),
    representedFields: represented.fields.map(clonePlain),
    missingFields: comparison.missing.map(clonePlain),
    extraFields: comparison.extra.map(clonePlain)
  };
}

/* -------------------------------------------- */

export function foundryTokenToTargetFootprint(token, options={}) {
  const footprintResult = foundryTokenToTokenGridFootprint(token, options);
  if ( !footprintResult.footprint ) return footprintResult;
  const tokenDocument = resolveTokenDocument(token);
  const tokenData = plainTokenRef(tokenDocument, options.scene);
  const actorData = plainActorRef(tokenDocument.actor ?? token?.actor ?? null);
  return {
    ok: footprintResult.ok,
    code: footprintResult.code,
    tokenFootprint: {
      id: tokenData.ref ?? tokenData.id,
      target: tokenData,
      actor: actorData,
      occupiedFields: footprintResult.footprint.fields.map(clonePlain),
      footprint: footprintResult.footprint,
      kind: options.kind ?? "creature",
      disposition: options.disposition ?? options.relationship?.disposition ?? "unknown",
      willing: options.willing === true,
      size: footprintResult.footprint.effectiveSize,
      tags: [...(options.tags ?? [])],
      conditions: [...(options.conditions ?? [])],
      metadata: {
        ...clonePlain(options.metadata ?? {}),
        foundry: {
          tokenId: tokenData.id,
          tokenRef: tokenData.ref,
          actorRef: actorData?.ref ?? null,
          sceneRef: tokenData.sceneRef,
          disposition: tokenDocument.disposition ?? null,
          hidden: tokenDocument.hidden === true,
          level: extractTokenLevelMetadata(tokenDocument)
        },
        diagnostics: footprintResult.diagnostics.map(clonePlain)
      }
    },
    footprint: footprintResult.footprint,
    diagnostics: footprintResult.diagnostics.map(clonePlain),
    representedFields: footprintResult.representedFields.map(clonePlain)
  };
}

/* -------------------------------------------- */

export function collectFoundryTokenTargetFootprints({
  scene=null,
  grid=null,
  tokens=null,
  sourceToken=null,
  excludeUnsupportedLevels=true,
  ...options
}={}) {
  const sourceDocument = sourceToken ? resolveTokenDocument(sourceToken) : null;
  const tokenDocuments = normalizeTokenCollection(tokens ?? scene?.tokens ?? []);
  const tokenFootprints = [];
  const skipped = [];
  const failures = [];

  for ( const tokenDocument of tokenDocuments ) {
    const levelRelation = sourceDocument
      ? validateFoundryTokenLevelRelation(sourceDocument, tokenDocument)
      : {ok: true, code: FOUNDRY_TACTICAL_GRID_CODES.OK};
    if ( !levelRelation.ok && excludeUnsupportedLevels ) {
      skipped.push({
        token: plainTokenRef(tokenDocument, scene),
        code: levelRelation.code,
        reason: levelRelation.reason,
        levelRelation
      });
      continue;
    }

    const result = foundryTokenToTargetFootprint(tokenDocument, {scene, grid, ...options});
    if ( result.tokenFootprint ) tokenFootprints.push(result.tokenFootprint);
    else failures.push({
      token: plainTokenRef(tokenDocument, scene),
      code: result.code,
      reason: result.reason ?? null
    });
  }

  return {
    ok: failures.length === 0,
    code: failures.length ? failures[0].code : FOUNDRY_TACTICAL_GRID_CODES.OK,
    tokenFootprints,
    skipped,
    failures
  };
}

/* -------------------------------------------- */

export function validateFoundryTokenLevelRelation(sourceToken, targetToken, {strictElevation=true}={}) {
  const source = extractTokenLevelMetadata(resolveTokenDocument(sourceToken) ?? sourceToken);
  const target = extractTokenLevelMetadata(resolveTokenDocument(targetToken) ?? targetToken);
  if ( source.levelRef && target.levelRef && source.levelRef !== target.levelRef ) {
    return {
      ok: false,
      code: FOUNDRY_TACTICAL_GRID_CODES.UNSUPPORTED_LEVEL_RELATION,
      reason: "Tokens are on different Foundry scene levels; WildPath has no complete vertical tactical model yet.",
      source,
      target
    };
  }
  if ( strictElevation && source.elevation != null && target.elevation != null && source.elevation !== target.elevation ) {
    return {
      ok: false,
      code: FOUNDRY_TACTICAL_GRID_CODES.UNSUPPORTED_LEVEL_RELATION,
      reason: "Tokens have different elevations; WildPath has no complete vertical tactical model yet.",
      source,
      target
    };
  }
  return {
    ok: true,
    code: FOUNDRY_TACTICAL_GRID_CODES.OK,
    source,
    target
  };
}

/* -------------------------------------------- */

function inferFoundryHexInfo({grid=null, foundryType=null}={}) {
  const type = foundryType ?? finiteInteger(grid?.type);
  const columns = type === FOUNDRY_GRID_TYPES.HEXODDQ || type === FOUNDRY_GRID_TYPES.HEXEVENQ
    ? true
    : type === FOUNDRY_GRID_TYPES.HEXODDR || type === FOUNDRY_GRID_TYPES.HEXEVENR
      ? false
      : grid?.columns === true;
  const even = type === FOUNDRY_GRID_TYPES.HEXEVENR || type === FOUNDRY_GRID_TYPES.HEXEVENQ
    ? true
    : type === FOUNDRY_GRID_TYPES.HEXODDR || type === FOUNDRY_GRID_TYPES.HEXODDQ
      ? false
      : grid?.even === true;
  return {
    foundryType: type,
    columns,
    even,
    offsetVariant: hexOffsetVariant({columns, even})
  };
}

function hexOffsetVariant({columns, even}) {
  if ( columns ) return even ? FOUNDRY_HEX_OFFSET_VARIANTS.EVEN_Q : FOUNDRY_HEX_OFFSET_VARIANTS.ODD_Q;
  return even ? FOUNDRY_HEX_OFFSET_VARIANTS.EVEN_R : FOUNDRY_HEX_OFFSET_VARIANTS.ODD_R;
}

function foundryHexOffsetToCube(offset, {grid=null, gridInfo}) {
  if ( typeof grid?.offsetToCube === "function" ) {
    const cube = normalizeCube(grid.offsetToCube(offset));
    if ( cube ) return cube;
  }
  const qrs = offsetToAxial(offset, gridInfo.offsetVariant);
  return qrs ? {q: qrs.q, r: qrs.r, s: -qrs.q - qrs.r, ...(offset.k != null ? {k: offset.k} : {})} : null;
}

function foundryHexCubeToOffset(cube, {grid=null, gridInfo}) {
  if ( typeof grid?.cubeToOffset === "function" ) {
    const offset = normalizeFoundryOffset(grid.cubeToOffset(cube));
    if ( offset ) return offset;
  }
  return axialToOffset(cube, gridInfo.offsetVariant);
}

function offsetToAxial(offset, variant) {
  const col = finiteInteger(offset.i);
  const row = finiteInteger(offset.j);
  if ( col == null || row == null ) return null;
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
      return null;
  }
}

function axialToOffset(field, variant) {
  const q = finiteInteger(field.q);
  const r = finiteInteger(field.r);
  if ( q == null || r == null ) return null;
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
      return null;
  }
}

function parity(value) {
  return Math.abs(Number(value)) % 2;
}

function normalizeFoundryOffset(offset) {
  if ( !offset || typeof offset !== "object" ) return null;
  const i = finiteInteger(offset.i ?? offset.x ?? offset.column ?? offset.col);
  const j = finiteInteger(offset.j ?? offset.y ?? offset.row);
  if ( i == null || j == null ) return null;
  const k = finiteInteger(offset.k ?? offset.elevation ?? offset.z);
  return k == null ? {i, j} : {i, j, k};
}

function normalizeCube(cube) {
  if ( !cube || typeof cube !== "object" ) return null;
  const q = finiteInteger(cube.q ?? cube.i ?? cube.x);
  const r = finiteInteger(cube.r ?? cube.j ?? cube.y);
  const s = finiteInteger(cube.s ?? cube.k ?? cube.z ?? (q != null && r != null ? -q - r : null));
  if ( q == null || r == null || s == null ) return null;
  return {q, r, s, ...(cube.k != null && cube.s != null ? {k: finiteInteger(cube.k)} : {})};
}

function resolveTokenAnchor({
  tokenDocument,
  scene,
  grid,
  gridInfo,
  representedFields,
  size,
  effectiveSize,
  definition,
  footprintProvider,
  explicitAnchor
}) {
  const candidates = [];
  if ( explicitAnchor ) candidates.push({source: "explicit", field: normalizeGridField(explicitAnchor, gridInfo.topology)});

  const explicitOffset = tokenDocument.gridOffset ?? tokenDocument.offset ?? tokenDocument.flags?.wildpath?.gridOffset;
  if ( explicitOffset ) {
    const offsetField = foundryOffsetToGridField(explicitOffset, {scene, grid});
    if ( offsetField.ok ) candidates.push({source: "token-grid-offset", field: offsetField.field});
  }

  const point = tokenPositionPoint(tokenDocument);
  if ( point ) {
    const pointField = foundryPointToGridField(point, {scene, grid});
    if ( pointField.ok ) candidates.push({source: "token-position", field: pointField.field});
  }

  for ( const field of representedFields ?? [] ) candidates.push({source: "foundry-occupied-space", field});

  const uniqueCandidates = uniqueAnchorCandidates(candidates, gridInfo.topology);
  if ( !uniqueCandidates.length ) return failure(FOUNDRY_TACTICAL_GRID_CODES.UNRESOLVABLE_TOKEN, "Token placement could not be translated to a tactical GridField anchor.");

  if ( representedFields?.length ) {
    for ( const candidate of uniqueCandidates ) {
      try {
        const footprint = createTokenGridFootprint({
          anchor: candidate.field,
          size,
          effectiveSize,
          topology: gridInfo.topology,
          provider: footprintProvider,
          definition
        });
        if ( compareFieldSets(footprint.fields, representedFields, gridInfo.topology).matches ) {
          return {ok: true, code: FOUNDRY_TACTICAL_GRID_CODES.OK, anchor: candidate.field, source: candidate.source};
        }
      } catch {
        continue;
      }
    }
  }

  return {
    ok: true,
    code: FOUNDRY_TACTICAL_GRID_CODES.OK,
    anchor: uniqueCandidates[0].field,
    source: uniqueCandidates[0].source
  };
}

function getFoundryTokenOccupiedGridSpaceFields(tokenDocument, {scene=null, grid=null}={}) {
  if ( typeof tokenDocument?.getOccupiedGridSpaceOffsets !== "function" ) {
    return {
      available: false,
      reason: "TokenDocument#getOccupiedGridSpaceOffsets is not available.",
      fields: []
    };
  }
  try {
    const offsets = tokenDocument.getOccupiedGridSpaceOffsets() ?? [];
    const fields = [];
    for ( const offset of offsets ) {
      const converted = foundryOffsetToGridField(offset, {scene, grid});
      if ( converted.ok ) fields.push(converted.field);
    }
    return {
      available: true,
      reason: null,
      fields: sortGridFields(fields, identifyFoundryGrid({scene, grid}).topology)
    };
  } catch (error) {
    return {
      available: false,
      reason: error?.message ?? String(error),
      fields: []
    };
  }
}

function compareFieldSets(expectedFields, representedFields, topology) {
  const expected = sortGridFields(expectedFields ?? [], topology);
  const represented = sortGridFields(representedFields ?? [], topology);
  const expectedKeys = new Set(expected.map(field => fieldKey(field, topology)));
  const representedKeys = new Set(represented.map(field => fieldKey(field, topology)));
  const missing = expected.filter(field => !representedKeys.has(fieldKey(field, topology)));
  const extra = represented.filter(field => !expectedKeys.has(fieldKey(field, topology)));
  return {
    matches: missing.length === 0 && extra.length === 0,
    missing,
    extra
  };
}

function validateTokenScene(tokenDocument, scene) {
  const sceneId = scene?.id ?? scene?._id ?? null;
  const tokenSceneId = tokenDocument?.parent?.id ?? tokenDocument?.scene?.id ?? tokenDocument?.sceneId ?? null;
  if ( sceneId && tokenSceneId && sceneId !== tokenSceneId ) {
    return failure(FOUNDRY_TACTICAL_GRID_CODES.TOKEN_NOT_ON_SCENE, "Token belongs to a different Scene.");
  }
  return {ok: true, code: FOUNDRY_TACTICAL_GRID_CODES.OK};
}

function resolveTokenDocument(token) {
  if ( !token ) return null;
  if ( token.documentName === "Token" ) return token;
  return token.document ?? token;
}

function normalizeTokenCollection(tokens) {
  if ( !tokens ) return [];
  if ( Array.isArray(tokens) ) return tokens.map(resolveTokenDocument).filter(Boolean);
  if ( Array.isArray(tokens.contents) ) return tokens.contents.map(resolveTokenDocument).filter(Boolean);
  if ( typeof tokens.values === "function" ) return Array.from(tokens.values()).map(resolveTokenDocument).filter(Boolean);
  return Object.values(tokens).map(resolveTokenDocument).filter(Boolean);
}

function tokenPositionPoint(tokenDocument) {
  const x = finiteNumber(tokenDocument.x ?? tokenDocument.object?.x);
  const y = finiteNumber(tokenDocument.y ?? tokenDocument.object?.y);
  if ( x == null || y == null ) return null;
  const elevation = finiteNumber(tokenDocument.elevation);
  return elevation == null ? {x, y} : {x, y, elevation};
}

function foundryVerticesForOffset(offset, grid) {
  if ( typeof grid?.getVertices !== "function" ) return [];
  try {
    return (grid.getVertices(offset) ?? []).map(clonePlain);
  } catch {
    return [];
  }
}

function foundryPointForVertex(vertex, offset, gridInfo, foundryVertices, fallbackIndex) {
  if ( gridInfo.topology === GRID_TOPOLOGIES.SQUARE && foundryVertices.length >= 4 ) {
    const x = Number(vertex.x);
    const y = Number(vertex.y);
    const i = Number(offset.i);
    const j = Number(offset.j);
    if ( x === i && y === j ) return foundryVertices[0];
    if ( x === i + 1 && y === j ) return foundryVertices[1];
    if ( x === i + 1 && y === j + 1 ) return foundryVertices[2];
    if ( x === i && y === j + 1 ) return foundryVertices[3];
  }
  return foundryVertices[fallbackIndex] ?? null;
}

function snapPointToVertex(point, grid) {
  const normalizedPoint = normalizePoint(point);
  if ( !normalizedPoint ) return {x: 0, y: 0};
  if ( typeof grid?.getSnappedPoint !== "function" ) return normalizedPoint;
  try {
    const snapped = grid.getSnappedPoint(normalizedPoint, {mode: "vertex"});
    return normalizePoint(snapped) ?? normalizedPoint;
  } catch {
    return normalizedPoint;
  }
}

function normalizePoint(point) {
  if ( !point || typeof point !== "object" ) return null;
  const x = finiteNumber(point.x);
  const y = finiteNumber(point.y);
  if ( x == null || y == null ) return null;
  const elevation = finiteNumber(point.elevation ?? point.z);
  return elevation == null ? {x, y} : {x, y, elevation};
}

function squaredDistance(a, b) {
  return ((Number(a.x) || 0) - ((Number(b.x) || 0))) ** 2
    + (((Number(a.y) || 0) - (Number(b.y) || 0)) ** 2);
}

function defaultTokenSizeResolver(tokenDocument) {
  return tokenDocument?.wildpathSize
    ?? tokenDocument?.actor?.system?.traits?.size
    ?? tokenDocument?.actor?.system?.details?.size
    ?? tokenDocument?.actor?.system?.size
    ?? CREATURE_SIZES.MEDIUM;
}

function normalizeCreatureSize(size) {
  const normalized = String(size ?? CREATURE_SIZES.MEDIUM).toLowerCase();
  return CREATURE_SIZE_ORDER.includes(normalized) ? normalized : null;
}

function plainSceneRef(scene) {
  const sceneId = scene?.id ?? scene?._id ?? null;
  return {
    id: sceneId,
    ref: sceneId ? createEntityRef("scene", sceneId) : null,
    uuid: scene?.uuid ?? null,
    name: scene?.name ?? null
  };
}

function plainTokenRef(tokenDocument, scene) {
  const id = tokenDocument?.id ?? tokenDocument?._id ?? null;
  const sceneId = scene?.id ?? scene?._id ?? tokenDocument?.parent?.id ?? tokenDocument?.scene?.id ?? tokenDocument?.sceneId ?? null;
  return {
    id,
    ref: id ? tokenRef(id, {sceneId}) : null,
    tokenId: id,
    sceneId,
    sceneRef: sceneId ? createEntityRef("scene", sceneId) : null,
    actorId: tokenDocument?.actor?.id ?? tokenDocument?.actorId ?? null,
    actorRef: plainActorRef(tokenDocument?.actor)?.ref ?? null,
    uuid: tokenDocument?.uuid ?? null,
    name: tokenDocument?.name ?? tokenDocument?.actor?.name ?? null,
    hidden: tokenDocument?.hidden === true
  };
}

function plainActorRef(actor) {
  if ( !actor ) return null;
  const ref = normalizeEntityRef({actor});
  return {
    id: actor.id ?? actor._id ?? null,
    ref,
    uuid: actor.uuid ?? null,
    name: actor.name ?? null,
    type: actor.type ?? null
  };
}

function extractTokenLevelMetadata(tokenDocument) {
  if ( !tokenDocument ) return {levelRef: null, levelId: null, elevation: null};
  const sceneId = tokenDocument.parent?.id ?? tokenDocument.scene?.id ?? tokenDocument.sceneId ?? null;
  const levelId = tokenDocument.levelId
    ?? tokenDocument.level?.id
    ?? tokenDocument.flags?.core?.level
    ?? tokenDocument.flags?.levels?.level
    ?? null;
  const elevation = finiteNumber(tokenDocument.elevation);
  return {
    levelId,
    levelRef: levelId ? createEntityRef("scene-level", levelId, {scope: sceneId}) : null,
    elevation
  };
}

function plainDimensions(dimensions) {
  if ( !dimensions || typeof dimensions !== "object" ) return {};
  const keys = [
    "columns",
    "rows",
    "distance",
    "distancePixels",
    "size",
    "units",
    "sceneX",
    "sceneY",
    "sceneWidth",
    "sceneHeight",
    "width",
    "height"
  ];
  return Object.fromEntries(keys.filter(key => dimensions[key] != null).map(key => [key, dimensions[key]]));
}

function plainGridInfo(gridInfo) {
  return {
    kind: gridInfo.kind,
    topology: gridInfo.topology,
    gridless: gridInfo.gridless,
    foundryType: gridInfo.foundryType,
    columns: gridInfo.columns,
    even: gridInfo.even,
    orientation: gridInfo.orientation,
    offsetVariant: gridInfo.offsetVariant
  };
}

function uniqueAnchorCandidates(candidates, topology) {
  const byKey = new Map();
  for ( const candidate of candidates ) {
    const field = normalizeGridField(candidate.field, topology);
    const key = fieldKey(field, topology);
    if ( !byKey.has(key) ) byKey.set(key, {source: candidate.source, field});
  }
  return [...byKey.values()];
}

function sameStringArray(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function finiteInteger(value) {
  if ( value == null || value === "" ) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : null;
}

function finiteNumber(value) {
  if ( value == null || value === "" ) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function failure(code, reason) {
  return {ok: false, code, reason};
}

function clonePlain(value) {
  if ( value === undefined ) return undefined;
  if ( value === null ) return null;
  return JSON.parse(JSON.stringify(value));
}
