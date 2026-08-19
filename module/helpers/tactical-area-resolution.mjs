import {resolveAreaTargetSet} from "./area-targeting.mjs";
import {
  AREA_SHAPES,
  TACTICAL_AREA_CODES,
  previewSourceBoundaryArea,
  selectSourceBoundaryOrigin
} from "./tactical-areas.mjs";

export const TACTICAL_AREA_RESOLUTION_CODES = Object.freeze({
  OK: "OK",
  PLACEMENT_FAILED: "PLACEMENT_FAILED",
  TARGETING_FAILED: "TARGETING_FAILED"
});

/* -------------------------------------------- */

export function resolvePlacedAreaTargets({
  placedArea,
  tokenFootprints=[],
  eligibilityPolicy={},
  refinementPolicy={},
  decisions=[],
  context={},
  metadata={}
}={}) {
  if ( !placedArea?.ok ) {
    return {
      ok: false,
      code: TACTICAL_AREA_RESOLUTION_CODES.PLACEMENT_FAILED,
      placement: placedArea ?? null,
      targeting: null,
      targetContexts: []
    };
  }

  const footprint = placedArea.resolved ?? placedArea.committed ?? placedArea.preview ?? placedArea.footprint;
  const targeting = resolveAreaTargetSet({
    footprint,
    tokenFootprints,
    eligibilityPolicy,
    refinementPolicy,
    decisions,
    context,
    metadata: {
      ...metadata,
      placement: placedArea.placement ?? null
    }
  });

  return {
    ok: targeting.ok,
    code: targeting.ok ? TACTICAL_AREA_RESOLUTION_CODES.OK : TACTICAL_AREA_RESOLUTION_CODES.TARGETING_FAILED,
    placement: placedArea,
    footprint,
    targeting,
    targetContexts: targeting.targetContexts
  };
}

/* -------------------------------------------- */

export function resolveSourceBoundaryAreaTargets({
  sources=[],
  sourceId=null,
  vertexId,
  shape=AREA_SHAPES.LINE,
  directionVertex=null,
  direction=null,
  rangeDistance=0,
  gridDistance=5,
  tokenFootprints=[],
  eligibilityPolicy={},
  refinementPolicy={},
  decisions=[],
  context={},
  metadata={}
}={}) {
  const placement = selectSourceBoundaryOrigin({sources, sourceId, vertexId});
  if ( !placement.ok ) {
    return {
      ok: false,
      code: TACTICAL_AREA_CODES.VERTEX_NOT_ON_SOURCE_BOUNDARY,
      placement,
      targeting: null,
      targetContexts: []
    };
  }

  const placedArea = previewSourceBoundaryArea({
    shape,
    placement,
    directionVertex,
    direction,
    rangeDistance,
    gridDistance
  });

  return resolvePlacedAreaTargets({
    placedArea,
    tokenFootprints,
    eligibilityPolicy,
    refinementPolicy,
    decisions,
    context,
    metadata
  });
}
