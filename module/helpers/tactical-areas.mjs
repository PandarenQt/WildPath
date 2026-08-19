import {evaluatePredicate} from "./predicates.mjs";
import {
  GRID_TOPOLOGIES,
  expandFootprint,
  fieldDistance,
  fieldKey,
  getGridDirections,
  normalizeGridField,
  offsetGridField,
  sortGridFields
} from "./grid-footprints.mjs";

export const AREA_SHAPES = Object.freeze({
  RADIAL: "radial",
  LINE: "line",
  CONE: "cone",
  WALL: "wall"
});

export const PLACEMENT_POLICIES = Object.freeze({
  SOURCE_BOUNDARY_DIRECTION: "source-boundary-direction",
  SOURCE_BOUNDARY_ENDPOINT: "source-boundary-endpoint",
  FREE_VERTEX_DIRECTION: "free-vertex-direction",
  FREE_VERTEX_ENDPOINT: "free-vertex-endpoint",
  TOKEN_CENTERED: "token-centered",
  TARGET_CENTERED: "target-centered",
  SELF: "self"
});

export const ORIGIN_SOURCE_POLICIES = Object.freeze({
  SELF: "self",
  ELIGIBLE_CONTROLLED: "eligible-controlled",
  SELF_AND_ELIGIBLE_CONTROLLED: "self-and-eligible-controlled"
});

export const TACTICAL_AREA_CODES = Object.freeze({
  OK: "OK",
  GRIDLESS_UNSUPPORTED: "GRIDLESS_UNSUPPORTED",
  SOURCE_NOT_ELIGIBLE: "SOURCE_NOT_ELIGIBLE",
  TOKEN_NOT_CONTROLLED: "TOKEN_NOT_CONTROLLED",
  SOURCE_NOT_PRESENT_ON_SCENE: "SOURCE_NOT_PRESENT_ON_SCENE",
  VERTEX_NOT_ON_SOURCE_BOUNDARY: "VERTEX_NOT_ON_SOURCE_BOUNDARY",
  DIRECTION_REQUIRED: "DIRECTION_REQUIRED",
  INVALID_DIRECTION: "INVALID_DIRECTION"
});

/* -------------------------------------------- */

export function createGridFootprint({
  topology=GRID_TOPOLOGIES.SQUARE,
  fields=[],
  shape=null,
  origin=null,
  direction=null,
  metadata={}
}={}) {
  const normalizedTopology = normalizeTopology(topology);
  const normalizedFields = sortGridFields(fields.map(field => normalizeGridField(field, normalizedTopology)), normalizedTopology);
  return {
    type: "GridFootprint",
    topology: normalizedTopology,
    shape,
    origin: origin ? clonePlain(origin) : null,
    direction: direction ? clonePlain(direction) : null,
    fields: normalizedFields,
    fieldKeys: normalizedFields.map(field => fieldKey(field, normalizedTopology)),
    metadata: clonePlain(metadata)
  };
}

/* -------------------------------------------- */

export function createRadialFootprint({
  topology=GRID_TOPOLOGIES.SQUARE,
  origin,
  radiusDistance=0,
  gridDistance=5,
  layers=null,
  includeOrigin=true,
  metadata={}
}={}) {
  const normalizedTopology = normalizeTopology(topology);
  const resolvedLayers = layers ?? distanceToLayers(radiusDistance, gridDistance);
  const source = {
    topology: normalizedTopology,
    fields: [normalizeGridField(origin, normalizedTopology)]
  };
  const fields = expandFootprint(source, resolvedLayers, {includeOrigin});
  return createGridFootprint({
    topology: normalizedTopology,
    fields,
    shape: AREA_SHAPES.RADIAL,
    origin: normalizeGridField(origin, normalizedTopology),
    metadata: {layers: resolvedLayers, radiusDistance, gridDistance, ...metadata}
  });
}

/* -------------------------------------------- */

export function createLineFootprint({
  topology=GRID_TOPOLOGIES.SQUARE,
  originVertex,
  directionVertex=null,
  direction=null,
  rangeDistance=0,
  gridDistance=5,
  steps=null,
  sourceFootprint=null,
  variableLength=false,
  metadata={}
}={}) {
  const normalizedTopology = normalizeTopology(topology);
  const resolvedDirection = resolveTacticalDirection({
    topology: normalizedTopology,
    originVertex,
    directionVertex,
    direction
  });
  if ( !resolvedDirection.ok ) return failedFootprint(resolvedDirection.code, resolvedDirection.reason);

  const configuredSteps = steps ?? distanceToLayers(rangeDistance, gridDistance);
  const maxSteps = variableLength && directionVertex
    ? Math.max(1, Math.min(configuredSteps, vertexDistance(originVertex, directionVertex, normalizedTopology)))
    : configuredSteps;
  const firstField = selectFirstAreaField({
    topology: normalizedTopology,
    originVertex,
    sourceFootprint,
    direction: resolvedDirection.direction
  });
  const fields = [];
  for ( let i = 0; i < maxSteps; i++ ) {
    fields.push(offsetGridField(firstField, multiplyDirection(resolvedDirection.direction, i), normalizedTopology));
  }

  return {
    ok: true,
    code: TACTICAL_AREA_CODES.OK,
    footprint: createGridFootprint({
      topology: normalizedTopology,
      fields,
      shape: AREA_SHAPES.LINE,
      origin: originVertex,
      direction: resolvedDirection.direction,
      metadata: {steps: maxSteps, configuredSteps, rangeDistance, gridDistance, variableLength, ...metadata}
    })
  };
}

/* -------------------------------------------- */

export function createConeFootprint({
  topology=GRID_TOPOLOGIES.SQUARE,
  originVertex,
  directionVertex=null,
  direction=null,
  rangeDistance=0,
  gridDistance=5,
  depth=null,
  sourceFootprint=null,
  policy="widen-by-layer",
  metadata={}
}={}) {
  const normalizedTopology = normalizeTopology(topology);
  const resolvedDirection = resolveTacticalDirection({
    topology: normalizedTopology,
    originVertex,
    directionVertex,
    direction
  });
  if ( !resolvedDirection.ok ) return failedFootprint(resolvedDirection.code, resolvedDirection.reason);

  const resolvedDepth = depth ?? distanceToLayers(rangeDistance, gridDistance);
  const firstField = selectFirstAreaField({
    topology: normalizedTopology,
    originVertex,
    sourceFootprint,
    direction: resolvedDirection.direction
  });
  const fields = [];
  for ( let layer = 0; layer < resolvedDepth; layer++ ) {
    const center = offsetGridField(firstField, multiplyDirection(resolvedDirection.direction, layer), normalizedTopology);
    fields.push(...coneLayerFields(center, resolvedDirection.direction, layer, normalizedTopology));
  }

  return {
    ok: true,
    code: TACTICAL_AREA_CODES.OK,
    footprint: createGridFootprint({
      topology: normalizedTopology,
      fields,
      shape: AREA_SHAPES.CONE,
      origin: originVertex,
      direction: resolvedDirection.direction,
      metadata: {depth: resolvedDepth, rangeDistance, gridDistance, policy, ...metadata}
    })
  };
}

/* -------------------------------------------- */

export function createWallFootprint({
  topology=GRID_TOPOLOGIES.SQUARE,
  origin,
  endpoint,
  metadata={}
}={}) {
  const normalizedTopology = normalizeTopology(topology);
  const line = gridLineFields(
    normalizeGridField(origin, normalizedTopology),
    normalizeGridField(endpoint, normalizedTopology),
    normalizedTopology
  );
  return createGridFootprint({
    topology: normalizedTopology,
    fields: line,
    shape: AREA_SHAPES.WALL,
    origin: normalizeGridField(origin, normalizedTopology),
    metadata
  });
}

/* -------------------------------------------- */

export function resolveEligibleOriginSources({
  source=null,
  controlled=[],
  policy=ORIGIN_SOURCE_POLICIES.SELF,
  predicate=null,
  context={}
}={}) {
  const candidates = [];
  if ( policy === ORIGIN_SOURCE_POLICIES.SELF || policy === ORIGIN_SOURCE_POLICIES.SELF_AND_ELIGIBLE_CONTROLLED ) {
    if ( source ) candidates.push({...source, sourceRole: "self"});
  }
  if ( policy === ORIGIN_SOURCE_POLICIES.ELIGIBLE_CONTROLLED
    || policy === ORIGIN_SOURCE_POLICIES.SELF_AND_ELIGIBLE_CONTROLLED ) {
    candidates.push(...controlled.map(candidate => ({...candidate, sourceRole: "controlled"})));
  }

  const eligible = [];
  const rejected = [];
  for ( const candidate of candidates ) {
    const evaluation = evaluateOriginCandidate(candidate, predicate, context);
    if ( evaluation.ok ) eligible.push(normalizeOriginSource(candidate));
    else rejected.push({...evaluation, sourceId: candidate.id ?? candidate.token?.id ?? null});
  }

  return {
    ok: eligible.length > 0,
    code: eligible.length > 0 ? TACTICAL_AREA_CODES.OK : TACTICAL_AREA_CODES.SOURCE_NOT_ELIGIBLE,
    eligible,
    rejected
  };
}

/* -------------------------------------------- */

export function createSourceBoundarySelectionRequest({sources=[]}={}) {
  return {
    sources: sources.map(source => ({
      sourceId: source.id,
      token: clonePlain(source.token),
      actor: source.actor ? clonePlain(source.actor) : null,
      boundaryVertices: (source.footprint?.boundaryVertices ?? []).map(vertex => ({
        ...clonePlain(vertex),
        sourceId: source.id,
        selectable: true
      }))
    }))
  };
}

/* -------------------------------------------- */

export function selectSourceBoundaryOrigin({sources=[], sourceId=null, vertexId}={}) {
  for ( const source of sources ) {
    if ( sourceId && source.id !== sourceId ) continue;
    const vertex = (source.footprint?.boundaryVertices ?? []).find(candidate => candidate.id === vertexId);
    if ( vertex ) {
      return {
        ok: true,
        code: TACTICAL_AREA_CODES.OK,
        source,
        sourceId: source.id,
        token: clonePlain(source.token),
        actor: source.actor ? clonePlain(source.actor) : null,
        originVertex: clonePlain(vertex)
      };
    }
    const internal = (source.footprint?.internalVertices ?? []).find(candidate => candidate.id === vertexId);
    if ( internal ) {
      return {
        ok: false,
        code: TACTICAL_AREA_CODES.VERTEX_NOT_ON_SOURCE_BOUNDARY,
        reason: "vertex is internal to the source footprint"
      };
    }
  }
  return {
    ok: false,
    code: TACTICAL_AREA_CODES.VERTEX_NOT_ON_SOURCE_BOUNDARY,
    reason: "vertex is not on any eligible source boundary"
  };
}

/* -------------------------------------------- */

export function previewSourceBoundaryArea({
  shape,
  placement,
  directionVertex=null,
  direction=null,
  rangeDistance=0,
  gridDistance=5,
  topology=null
}={}) {
  if ( !placement?.ok ) return {ok: false, code: placement?.code ?? TACTICAL_AREA_CODES.SOURCE_NOT_ELIGIBLE};
  const resolvedTopology = normalizeTopology(topology ?? placement.source.footprint.topology);
  const common = {
    topology: resolvedTopology,
    originVertex: placement.originVertex,
    directionVertex,
    direction,
    rangeDistance,
    gridDistance,
    sourceFootprint: placement.source.footprint,
    metadata: {sourceId: placement.sourceId, token: placement.token, actor: placement.actor}
  };
  const result = shape === AREA_SHAPES.CONE ? createConeFootprint(common) : createLineFootprint(common);
  if ( !result.ok ) return result;
  return {
    ok: true,
    code: TACTICAL_AREA_CODES.OK,
    preview: result.footprint,
    committed: result.footprint,
    resolved: result.footprint,
    placement: {
      sourceId: placement.sourceId,
      token: placement.token,
      actor: placement.actor,
      originVertex: placement.originVertex
    }
  };
}

/* -------------------------------------------- */

export function gridlessAreaLimitation(shape) {
  return {
    ok: false,
    code: TACTICAL_AREA_CODES.GRIDLESS_UNSUPPORTED,
    shape,
    reason: "Gridless scenes do not provide tactical fields or boundary vertices for this gridded area operation."
  };
}

/* -------------------------------------------- */

export function resolveTacticalDirection({topology=GRID_TOPOLOGIES.SQUARE, originVertex=null, directionVertex=null, direction=null}={}) {
  const normalizedTopology = normalizeTopology(topology);
  if ( direction ) {
    const normalized = normalizeDirection(direction, normalizedTopology);
    if ( isZeroDirection(normalized, normalizedTopology) ) {
      return {ok: false, code: TACTICAL_AREA_CODES.INVALID_DIRECTION, reason: "direction must not be zero"};
    }
    return {ok: true, code: TACTICAL_AREA_CODES.OK, direction: normalized};
  }
  if ( !originVertex || !directionVertex ) {
    return {ok: false, code: TACTICAL_AREA_CODES.DIRECTION_REQUIRED, reason: "direction vertex is required"};
  }
  if ( normalizedTopology === GRID_TOPOLOGIES.HEX ) {
    const vector = hexVertexVector(originVertex, directionVertex);
    return nearestDirection(vector, normalizedTopology);
  }
  const dx = Math.sign(Number(directionVertex.x) - Number(originVertex.x));
  const dy = Math.sign(Number(directionVertex.y) - Number(originVertex.y));
  return nearestDirection({x: dx, y: dy}, normalizedTopology);
}

/* -------------------------------------------- */

function evaluateOriginCandidate(candidate, predicate, context) {
  if ( candidate.present === false ) {
    return {ok: false, code: TACTICAL_AREA_CODES.SOURCE_NOT_PRESENT_ON_SCENE, reason: "source is not present"};
  }
  if ( candidate.sourceRole === "controlled" && candidate.controlled === false ) {
    return {ok: false, code: TACTICAL_AREA_CODES.TOKEN_NOT_CONTROLLED, reason: "token is not controlled"};
  }
  if ( !candidate.footprint ) {
    return {ok: false, code: TACTICAL_AREA_CODES.SOURCE_NOT_PRESENT_ON_SCENE, reason: "source has no footprint"};
  }
  const predicateResult = evaluatePredicate(predicate, {source: candidate, token: candidate.token, actor: candidate.actor, ...context});
  if ( !predicateResult.ok ) {
    return {ok: false, code: TACTICAL_AREA_CODES.SOURCE_NOT_ELIGIBLE, reason: predicateResult.reason};
  }
  return {ok: true, code: TACTICAL_AREA_CODES.OK};
}

function normalizeOriginSource(candidate) {
  return {
    id: String(candidate.id ?? candidate.token?.id),
    token: clonePlain(candidate.token ?? {id: candidate.id}),
    actor: candidate.actor ? clonePlain(candidate.actor) : null,
    footprint: candidate.footprint,
    sourceRole: candidate.sourceRole,
    provenance: candidate.provenance ? clonePlain(candidate.provenance) : null
  };
}

function selectFirstAreaField({topology, originVertex, sourceFootprint, direction}) {
  const incident = (originVertex.incidentFields ?? []).map(field => normalizeGridField(field, topology));
  const occupied = new Set((sourceFootprint?.fields ?? []).map(field => fieldKey(field, topology)));
  const outside = incident.filter(field => !occupied.has(fieldKey(field, topology)));
  const candidates = outside.length ? outside : incident;
  return candidates.sort((a, b) => {
    const projection = projectField(b, direction, topology) - projectField(a, direction, topology);
    if ( projection ) return projection;
    return fieldKey(a, topology).localeCompare(fieldKey(b, topology));
  })[0];
}

function coneLayerFields(center, direction, layer, topology) {
  if ( layer === 0 ) return [center];
  const sideDirections = lateralDirections(direction, topology);
  const fields = [center];
  for ( let distance = 1; distance <= layer; distance++ ) {
    for ( const side of sideDirections ) fields.push(offsetGridField(center, multiplyDirection(side, distance), topology));
  }
  return fields;
}

function lateralDirections(direction, topology) {
  const directions = getGridDirections(topology, {includeDiagonals: topology === GRID_TOPOLOGIES.SQUARE});
  const forwardKey = directionKey(normalizeDirection(direction, topology), topology);
  const reverseKey = directionKey(multiplyDirection(direction, -1), topology);
  if ( topology === GRID_TOPOLOGIES.SQUARE ) {
    const forward = normalizeDirection(direction, topology);
    return [
      {x: -forward.y, y: forward.x},
      {x: forward.y, y: -forward.x}
    ].filter(side => !isZeroDirection(side, topology));
  }
  const index = directions.findIndex(candidate => directionKey(candidate, topology) === forwardKey);
  if ( index >= 0 ) return [
    directions[(index + 1) % directions.length],
    directions[(index + directions.length - 1) % directions.length]
  ];
  return directions.filter(candidate => {
    const key = directionKey(candidate, topology);
    return key !== forwardKey && key !== reverseKey && dotDirection(candidate, direction, topology) >= 0;
  }).slice(0, 2);
}

function gridLineFields(start, end, topology) {
  const distance = fieldDistance(start, end, topology);
  if ( distance === 0 ) return [start];
  const fields = [];
  for ( let i = 0; i <= distance; i++ ) {
    const t = i / distance;
    const field = topology === GRID_TOPOLOGIES.HEX
      ? roundAxial({
        q: lerp(Number(start.q), Number(end.q), t),
        r: lerp(Number(start.r), Number(end.r), t)
      })
      : {
        x: Math.round(lerp(Number(start.x), Number(end.x), t)),
        y: Math.round(lerp(Number(start.y), Number(end.y), t))
      };
    fields.push(field);
  }
  return sortGridFields(fields, topology);
}

function nearestDirection(vector, topology) {
  const normalizedTopology = normalizeTopology(topology);
  if ( isZeroDirection(vector, normalizedTopology) ) {
    return {ok: false, code: TACTICAL_AREA_CODES.INVALID_DIRECTION, reason: "direction must not be zero"};
  }
  const directions = getGridDirections(normalizedTopology, {includeDiagonals: normalizedTopology === GRID_TOPOLOGIES.SQUARE});
  const exact = directions.find(candidate => directionKey(candidate, normalizedTopology) === directionKey(vector, normalizedTopology));
  if ( exact ) return {ok: true, code: TACTICAL_AREA_CODES.OK, direction: normalizeDirection(exact, normalizedTopology)};
  const best = [...directions].sort((a, b) => {
    const projection = dotDirection(b, vector, normalizedTopology) - dotDirection(a, vector, normalizedTopology);
    if ( projection ) return projection;
    return directionKey(a, normalizedTopology).localeCompare(directionKey(b, normalizedTopology));
  })[0];
  return {ok: true, code: TACTICAL_AREA_CODES.OK, direction: normalizeDirection(best, normalizedTopology)};
}

function hexVertexVector(originVertex, directionVertex) {
  const origin = vertexCentroid(originVertex, GRID_TOPOLOGIES.HEX);
  const target = vertexCentroid(directionVertex, GRID_TOPOLOGIES.HEX);
  return {q: target.q - origin.q, r: target.r - origin.r};
}

function vertexCentroid(vertex, topology) {
  const fields = vertex.incidentFields ?? [];
  const total = fields.reduce((sum, field) => {
    const normalized = normalizeGridField(field, topology);
    if ( topology === GRID_TOPOLOGIES.HEX ) return {q: sum.q + normalized.q, r: sum.r + normalized.r};
    return {x: sum.x + normalized.x, y: sum.y + normalized.y};
  }, topology === GRID_TOPOLOGIES.HEX ? {q: 0, r: 0} : {x: 0, y: 0});
  const divisor = Math.max(fields.length, 1);
  return topology === GRID_TOPOLOGIES.HEX
    ? {q: total.q / divisor, r: total.r / divisor}
    : {x: total.x / divisor, y: total.y / divisor};
}

function projectField(field, direction, topology) {
  return dotDirection(field, direction, topology);
}

function dotDirection(a, b, topology) {
  if ( topology === GRID_TOPOLOGIES.HEX ) return Number(a.q ?? 0) * Number(b.q ?? 0) + Number(a.r ?? 0) * Number(b.r ?? 0);
  return Number(a.x ?? 0) * Number(b.x ?? 0) + Number(a.y ?? 0) * Number(b.y ?? 0);
}

function directionKey(direction, topology) {
  const normalized = normalizeDirection(direction, topology);
  return topology === GRID_TOPOLOGIES.HEX ? `${normalized.q},${normalized.r}` : `${normalized.x},${normalized.y}`;
}

function normalizeDirection(direction, topology) {
  if ( topology === GRID_TOPOLOGIES.HEX ) {
    const q = Math.sign(Number(direction.q ?? direction.x ?? 0));
    const r = Math.sign(Number(direction.r ?? direction.y ?? 0));
    const directions = getGridDirections(GRID_TOPOLOGIES.HEX);
    const exact = directions.find(candidate => candidate.q === q && candidate.r === r);
    return exact ? {q: exact.q, r: exact.r} : {q, r};
  }
  return {x: Math.sign(Number(direction.x ?? direction.q ?? 0)), y: Math.sign(Number(direction.y ?? direction.r ?? 0))};
}

function multiplyDirection(direction, amount) {
  if ( "q" in direction || "r" in direction ) return {q: Number(direction.q ?? 0) * amount, r: Number(direction.r ?? 0) * amount};
  return {x: Number(direction.x ?? 0) * amount, y: Number(direction.y ?? 0) * amount};
}

function isZeroDirection(direction, topology) {
  if ( topology === GRID_TOPOLOGIES.HEX ) return !(Number(direction.q ?? 0) || Number(direction.r ?? 0));
  return !(Number(direction.x ?? 0) || Number(direction.y ?? 0));
}

function vertexDistance(originVertex, directionVertex, topology) {
  const origin = vertexCentroid(originVertex, topology);
  const target = vertexCentroid(directionVertex, topology);
  if ( topology === GRID_TOPOLOGIES.HEX ) return Math.max(1, fieldDistance(roundAxial(origin), roundAxial(target), topology));
  return Math.max(1, Math.max(Math.abs(Math.round(target.x - origin.x)), Math.abs(Math.round(target.y - origin.y))));
}

function roundAxial({q, r}) {
  let x = q;
  let z = r;
  let y = -x - z;
  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);
  const xDiff = Math.abs(rx - x);
  const yDiff = Math.abs(ry - y);
  const zDiff = Math.abs(rz - z);
  if ( xDiff > yDiff && xDiff > zDiff ) rx = -ry - rz;
  else if ( yDiff > zDiff ) ry = -rx - rz;
  else rz = -rx - ry;
  return {q: rx, r: rz};
}

function distanceToLayers(distance, gridDistance) {
  return Math.max(Math.floor((Number(distance) || 0) / Math.max(Number(gridDistance) || 1, 1)), 0);
}

function failedFootprint(code, reason=null) {
  return {ok: false, code, reason, footprint: null};
}

function normalizeTopology(topology) {
  return String(topology ?? GRID_TOPOLOGIES.SQUARE).toLowerCase();
}

function lerp(a, b, t) {
  return a + ((b - a) * t);
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}
