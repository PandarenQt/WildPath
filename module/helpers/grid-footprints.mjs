export const GRID_TOPOLOGIES = Object.freeze({
  SQUARE: "square",
  HEX: "hex"
});

export const CREATURE_SIZES = Object.freeze({
  TINY: "tiny",
  SMALL: "small",
  MEDIUM: "medium",
  LARGE: "large",
  HUGE: "huge",
  GARGANTUAN: "gargantuan"
});

export const CREATURE_SIZE_ORDER = Object.freeze([
  CREATURE_SIZES.TINY,
  CREATURE_SIZES.SMALL,
  CREATURE_SIZES.MEDIUM,
  CREATURE_SIZES.LARGE,
  CREATURE_SIZES.HUGE,
  CREATURE_SIZES.GARGANTUAN
]);

export const FOOTPRINT_CODES = Object.freeze({
  OK: "OK",
  UNKNOWN_TOPOLOGY: "UNKNOWN_TOPOLOGY",
  UNKNOWN_SIZE: "UNKNOWN_SIZE",
  DISCONNECTED_FOOTPRINT: "DISCONNECTED_FOOTPRINT"
});

const SQUARE_DIRECTIONS = Object.freeze([
  {name: "north", x: 0, y: -1},
  {name: "east", x: 1, y: 0},
  {name: "south", x: 0, y: 1},
  {name: "west", x: -1, y: 0}
]);

const SQUARE_DISTANCE_DIRECTIONS = Object.freeze([
  {x: -1, y: -1}, {x: 0, y: -1}, {x: 1, y: -1},
  {x: -1, y: 0}, {x: 1, y: 0},
  {x: -1, y: 1}, {x: 0, y: 1}, {x: 1, y: 1}
]);

const HEX_DIRECTIONS = Object.freeze([
  {name: "east", q: 1, r: 0},
  {name: "northeast", q: 1, r: -1},
  {name: "northwest", q: 0, r: -1},
  {name: "west", q: -1, r: 0},
  {name: "southwest", q: -1, r: 1},
  {name: "southeast", q: 0, r: 1}
]);

const TINY_SHARE_CAPACITY = 4;

/* -------------------------------------------- */

export function createDnd5eCreatureFootprintProvider({overrides={}}={}) {
  return {
    id: "dnd5e-default",
    getDefinition({size, topology}) {
      const normalizedTopology = normalizeTopology(topology);
      const normalizedSize = normalizeSize(size);
      const override = overrides?.[normalizedTopology]?.[normalizedSize]
        ?? overrides?.[`${normalizedTopology}:${normalizedSize}`];
      if ( override ) return createTokenFootprintDefinition({
        size: normalizedSize,
        topology: normalizedTopology,
        ...override
      });
      return createTokenFootprintDefinition(defaultDefinition(normalizedSize, normalizedTopology));
    }
  };
}

export const DND5E_CREATURE_FOOTPRINT_PROVIDER = createDnd5eCreatureFootprintProvider();

/* -------------------------------------------- */

export function createTokenFootprintDefinition({size, topology, offsets, creaturesPerField=1, minimumFields=null, metadata={}}) {
  const normalizedTopology = normalizeTopology(topology);
  const normalizedSize = normalizeSize(size);
  if ( !Object.values(GRID_TOPOLOGIES).includes(normalizedTopology) ) {
    throw new Error(`Unknown grid topology: ${topology}`);
  }
  if ( !offsets?.length ) throw new Error("TokenFootprintDefinition requires at least one offset.");

  const normalizedOffsets = uniqueFields(offsets.map(offset => normalizeOffset(offset, normalizedTopology)), normalizedTopology);
  return {
    size: normalizedSize,
    topology: normalizedTopology,
    offsets: normalizedOffsets,
    fieldCount: normalizedOffsets.length,
    creaturesPerField,
    minimumFields: minimumFields ?? normalizedOffsets.length,
    metadata: clonePlain(metadata)
  };
}

/* -------------------------------------------- */

export function createTokenGridFootprint({
  anchor=null,
  size=CREATURE_SIZES.MEDIUM,
  effectiveSize=null,
  topology=GRID_TOPOLOGIES.SQUARE,
  provider=DND5E_CREATURE_FOOTPRINT_PROVIDER,
  definition=null,
  metadata={}
}={}) {
  const normalizedTopology = normalizeTopology(topology);
  const normalizedSize = normalizeSize(effectiveSize ?? size);
  const resolvedDefinition = definition ?? provider.getDefinition({size: normalizedSize, topology: normalizedTopology});
  const normalizedAnchor = normalizeAnchor(anchor, normalizedTopology);
  const fields = sortFields(resolvedDefinition.offsets.map(offset => addOffset(normalizedAnchor, offset, normalizedTopology)), normalizedTopology);
  const validation = validateFootprintFields(fields, normalizedTopology);
  if ( !validation.ok ) throw new Error(`Invalid TokenGridFootprint: ${validation.code}`);

  const footprint = {
    type: "TokenGridFootprint",
    topology: normalizedTopology,
    size: normalizeSize(size),
    effectiveSize: normalizedSize,
    anchor: normalizedAnchor,
    definition: resolvedDefinition,
    fields,
    fieldKeys: fields.map(field => fieldKey(field, normalizedTopology)),
    metadata: clonePlain(metadata)
  };

  const vertices = getFootprintVertices(footprint);
  return {
    ...footprint,
    boundaryFields: getBoundaryFields(footprint),
    boundaryEdges: getBoundaryEdges(footprint),
    boundaryVertices: vertices.filter(vertex => vertex.external),
    internalVertices: vertices.filter(vertex => !vertex.external)
  };
}

/* -------------------------------------------- */

export function validateFootprintDefinition(definition) {
  const normalized = createTokenFootprintDefinition(definition);
  return validateFootprintFields(normalized.offsets, normalized.topology);
}

export function validateFootprintFields(fields, topology) {
  const normalizedTopology = normalizeTopology(topology);
  if ( !Object.values(GRID_TOPOLOGIES).includes(normalizedTopology) ) {
    return {ok: false, code: FOOTPRINT_CODES.UNKNOWN_TOPOLOGY};
  }
  if ( !fields.length ) return {ok: false, code: FOOTPRINT_CODES.DISCONNECTED_FOOTPRINT};
  return isConnectedFootprint(fields, normalizedTopology)
    ? {ok: true, code: FOOTPRINT_CODES.OK}
    : {ok: false, code: FOOTPRINT_CODES.DISCONNECTED_FOOTPRINT};
}

export function isConnectedFootprint(fields, topology) {
  const normalizedTopology = normalizeTopology(topology);
  const keys = new Set(fields.map(field => fieldKey(field, normalizedTopology)));
  const queue = [fields[0]];
  const visited = new Set();

  while ( queue.length ) {
    const field = queue.shift();
    const key = fieldKey(field, normalizedTopology);
    if ( visited.has(key) ) continue;
    visited.add(key);
    for ( const neighbor of adjacentFields(field, normalizedTopology) ) {
      if ( keys.has(fieldKey(neighbor, normalizedTopology)) && !visited.has(fieldKey(neighbor, normalizedTopology)) ) {
        queue.push(neighbor);
      }
    }
  }

  return visited.size === keys.size;
}

/* -------------------------------------------- */

export function getBoundaryFields(footprint) {
  const topology = normalizeTopology(footprint.topology);
  const occupied = fieldKeySet(footprint.fields, topology);
  return footprint.fields.filter(field => {
    return adjacentFields(field, topology).some(neighbor => !occupied.has(fieldKey(neighbor, topology)));
  }).map(field => cloneField(field, topology));
}

export function getBoundaryEdges(footprint) {
  const topology = normalizeTopology(footprint.topology);
  const occupied = fieldKeySet(footprint.fields, topology);
  const directions = topology === GRID_TOPOLOGIES.HEX ? HEX_DIRECTIONS : SQUARE_DIRECTIONS;
  const edges = [];

  for ( const field of footprint.fields ) {
    for ( const direction of directions ) {
      const neighbor = addOffset(field, direction, topology);
      if ( occupied.has(fieldKey(neighbor, topology)) ) continue;
      edges.push({
        id: `${fieldKey(field, topology)}>${direction.name}`,
        topology,
        field: cloneField(field, topology),
        outsideField: cloneField(neighbor, topology),
        direction: direction.name
      });
    }
  }

  return edges.sort((a, b) => a.id.localeCompare(b.id));
}

export function getFootprintVertices(footprint) {
  const topology = normalizeTopology(footprint.topology);
  const occupied = fieldKeySet(footprint.fields, topology);
  const byId = new Map();

  for ( const field of footprint.fields ) {
    const vertices = topology === GRID_TOPOLOGIES.HEX ? hexFieldVertices(field) : squareFieldVertices(field);
    for ( const vertex of vertices ) {
      const existing = byId.get(vertex.id);
      if ( existing ) continue;
      const occupiedIncidentFields = vertex.incidentFields.filter(incident => occupied.has(fieldKey(incident, topology)));
      byId.set(vertex.id, {
        ...vertex,
        topology,
        occupiedIncidentFields: occupiedIncidentFields.map(field => cloneField(field, topology)),
        external: occupiedIncidentFields.length > 0 && occupiedIncidentFields.length < vertex.incidentFields.length
      });
    }
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/* -------------------------------------------- */

export function footprintDistance(sourceFootprint, targetFootprint) {
  const topology = normalizeTopology(sourceFootprint.topology ?? targetFootprint.topology);
  let distance = Infinity;
  for ( const source of sourceFootprint.fields ) {
    for ( const target of targetFootprint.fields ) {
      distance = Math.min(distance, fieldDistance(source, target, topology));
    }
  }
  return distance;
}

export function fieldDistance(a, b, topology) {
  const normalizedTopology = normalizeTopology(topology);
  if ( normalizedTopology === GRID_TOPOLOGIES.HEX ) {
    const dq = Number(a.q) - Number(b.q);
    const dr = Number(a.r) - Number(b.r);
    const ds = (-Number(a.q) - Number(a.r)) - (-Number(b.q) - Number(b.r));
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2;
  }
  return Math.max(Math.abs(Number(a.x) - Number(b.x)), Math.abs(Number(a.y) - Number(b.y)));
}

/* -------------------------------------------- */

export function expandFootprint(footprint, layers, {includeOrigin=false}={}) {
  const topology = normalizeTopology(footprint.topology);
  const maxLayers = Math.max(Math.floor(Number(layers) || 0), 0);
  const occupied = fieldKeySet(footprint.fields, topology);
  const reached = new Map();

  for ( const field of footprint.fields ) reached.set(fieldKey(field, topology), cloneField(field, topology));
  let frontier = footprint.fields.map(field => cloneField(field, topology));

  for ( let layer = 0; layer < maxLayers; layer++ ) {
    const next = [];
    for ( const field of frontier ) {
      const directions = topology === GRID_TOPOLOGIES.HEX ? HEX_DIRECTIONS : SQUARE_DISTANCE_DIRECTIONS;
      for ( const direction of directions ) {
        const neighbor = addOffset(field, direction, topology);
        const key = fieldKey(neighbor, topology);
        if ( reached.has(key) ) continue;
        reached.set(key, cloneField(neighbor, topology));
        next.push(neighbor);
      }
    }
    frontier = next;
  }

  const fields = [...reached.values()].filter(field => includeOrigin || !occupied.has(fieldKey(field, topology)));
  return sortFields(fields, topology);
}

export function createReachFootprint({source, reachDistance=5, gridDistance=5, layers=null, includeOccupied=false}={}) {
  const resolvedLayers = layers ?? Math.floor(Math.max(Number(reachDistance) || 0, 0) / Math.max(Number(gridDistance) || 1, 1));
  const fields = expandFootprint(source, resolvedLayers, {includeOrigin: includeOccupied});
  return {
    type: "ReachFootprint",
    topology: source.topology,
    source,
    layers: resolvedLayers,
    reachDistance,
    gridDistance,
    fields,
    fieldKeys: fields.map(field => fieldKey(field, source.topology))
  };
}

/* -------------------------------------------- */

export function createFootprintDebugInfo({actor=null, effectiveSize, grid, footprint}) {
  return {
    actor,
    effectiveSize: effectiveSize ?? footprint.effectiveSize,
    grid: grid ?? footprint.topology,
    occupiedFieldCount: footprint.fields.length,
    fields: footprint.fields.map(field => cloneField(field, footprint.topology)),
    boundaryFields: footprint.boundaryFields.map(field => cloneField(field, footprint.topology)),
    boundaryEdges: footprint.boundaryEdges.map(edge => clonePlain(edge)),
    boundaryVertices: footprint.boundaryVertices.map(vertex => clonePlain(vertex))
  };
}

/* -------------------------------------------- */

export function adjacentFields(field, topology) {
  const normalizedTopology = normalizeTopology(topology);
  const directions = normalizedTopology === GRID_TOPOLOGIES.HEX ? HEX_DIRECTIONS : SQUARE_DIRECTIONS;
  return directions.map(direction => addOffset(field, direction, normalizedTopology));
}

export function fieldKey(field, topology=GRID_TOPOLOGIES.SQUARE) {
  const normalizedTopology = normalizeTopology(topology);
  if ( normalizedTopology === GRID_TOPOLOGIES.HEX ) return `hex:${Number(field.q)},${Number(field.r)}`;
  return `square:${Number(field.x)},${Number(field.y)}`;
}

/* -------------------------------------------- */

function defaultDefinition(size, topology) {
  const common = {size, topology};
  if ( topology === GRID_TOPOLOGIES.SQUARE ) {
    const width = squareWidthForSize(size);
    return {
      ...common,
      offsets: rectangleOffsets(width, width),
      creaturesPerField: size === CREATURE_SIZES.TINY ? TINY_SHARE_CAPACITY : 1,
      metadata: {ruleset: "dnd5e", squareWidth: width}
    };
  }

  return {
    ...common,
    offsets: hexOffsetsForSize(size),
    creaturesPerField: size === CREATURE_SIZES.TINY ? TINY_SHARE_CAPACITY : 1,
    metadata: {ruleset: "dnd5e"}
  };
}

function squareWidthForSize(size) {
  switch ( size ) {
    case CREATURE_SIZES.TINY:
    case CREATURE_SIZES.SMALL:
    case CREATURE_SIZES.MEDIUM:
      return 1;
    case CREATURE_SIZES.LARGE:
      return 2;
    case CREATURE_SIZES.HUGE:
      return 3;
    case CREATURE_SIZES.GARGANTUAN:
      return 4;
    default:
      throw new Error(`Unknown creature size: ${size}`);
  }
}

function hexOffsetsForSize(size) {
  switch ( size ) {
    case CREATURE_SIZES.TINY:
    case CREATURE_SIZES.SMALL:
    case CREATURE_SIZES.MEDIUM:
      return [{q: 0, r: 0}];
    case CREATURE_SIZES.LARGE:
      return [{q: 0, r: 0}, {q: 1, r: 0}, {q: 0, r: 1}];
    case CREATURE_SIZES.HUGE:
      return hexRadiusOffsets(1);
    case CREATURE_SIZES.GARGANTUAN:
      return [
        {q: -1, r: -1}, {q: 0, r: -1}, {q: 1, r: -1},
        {q: -2, r: 0}, {q: -1, r: 0}, {q: 0, r: 0}, {q: 1, r: 0},
        {q: -2, r: 1}, {q: -1, r: 1}, {q: 0, r: 1},
        {q: -2, r: 2}, {q: -1, r: 2}
      ];
    default:
      throw new Error(`Unknown creature size: ${size}`);
  }
}

function rectangleOffsets(width, height) {
  const offsets = [];
  for ( let y = 0; y < height; y++ ) {
    for ( let x = 0; x < width; x++ ) offsets.push({x, y});
  }
  return offsets;
}

function hexRadiusOffsets(radius) {
  const offsets = [];
  for ( let q = -radius; q <= radius; q++ ) {
    const r1 = Math.max(-radius, -q - radius);
    const r2 = Math.min(radius, -q + radius);
    for ( let r = r1; r <= r2; r++ ) offsets.push({q, r});
  }
  return sortFields(offsets, GRID_TOPOLOGIES.HEX);
}

function squareFieldVertices(field) {
  const x = Number(field.x);
  const y = Number(field.y);
  return [
    squareVertex(x, y),
    squareVertex(x + 1, y),
    squareVertex(x + 1, y + 1),
    squareVertex(x, y + 1)
  ];
}

function squareVertex(x, y) {
  const incidentFields = [
    {x: x - 1, y: y - 1},
    {x, y: y - 1},
    {x: x - 1, y},
    {x, y}
  ];
  return {
    id: `square-vertex:${x},${y}`,
    x,
    y,
    incidentFields: incidentFields.map(field => cloneField(field, GRID_TOPOLOGIES.SQUARE))
  };
}

function hexFieldVertices(field) {
  const vertices = [];
  for ( let i = 0; i < HEX_DIRECTIONS.length; i++ ) {
    const incidentFields = [
      normalizeOffset(field, GRID_TOPOLOGIES.HEX),
      addOffset(field, HEX_DIRECTIONS[i], GRID_TOPOLOGIES.HEX),
      addOffset(field, HEX_DIRECTIONS[(i + 1) % HEX_DIRECTIONS.length], GRID_TOPOLOGIES.HEX)
    ];
    const id = `hex-vertex:${incidentFields.map(f => fieldKey(f, GRID_TOPOLOGIES.HEX)).sort().join("|")}`;
    vertices.push({
      id,
      incidentFields: incidentFields.map(f => cloneField(f, GRID_TOPOLOGIES.HEX))
    });
  }
  return vertices;
}

function normalizeAnchor(anchor, topology) {
  if ( anchor ) return normalizeOffset(anchor, topology);
  return topology === GRID_TOPOLOGIES.HEX ? {q: 0, r: 0} : {x: 0, y: 0};
}

function normalizeOffset(offset, topology) {
  if ( topology === GRID_TOPOLOGIES.HEX ) {
    return {q: Number(offset.q ?? offset.x ?? 0), r: Number(offset.r ?? offset.y ?? 0)};
  }
  return {x: Number(offset.x ?? offset.q ?? 0), y: Number(offset.y ?? offset.r ?? 0)};
}

function addOffset(field, offset, topology) {
  if ( topology === GRID_TOPOLOGIES.HEX ) {
    return {q: Number(field.q) + Number(offset.q ?? 0), r: Number(field.r) + Number(offset.r ?? 0)};
  }
  return {x: Number(field.x) + Number(offset.x ?? 0), y: Number(field.y) + Number(offset.y ?? 0)};
}

function fieldKeySet(fields, topology) {
  return new Set(fields.map(field => fieldKey(field, topology)));
}

function uniqueFields(fields, topology) {
  return [...new Map(fields.map(field => [fieldKey(field, topology), cloneField(field, topology)])).values()];
}

function sortFields(fields, topology) {
  const normalizedTopology = normalizeTopology(topology);
  return uniqueFields(fields, normalizedTopology).sort((a, b) => fieldKey(a, normalizedTopology).localeCompare(fieldKey(b, normalizedTopology)));
}

function cloneField(field, topology) {
  return normalizeOffset(field, topology);
}

function normalizeTopology(topology) {
  return String(topology ?? GRID_TOPOLOGIES.SQUARE).toLowerCase();
}

function normalizeSize(size) {
  const normalized = String(size ?? CREATURE_SIZES.MEDIUM).toLowerCase();
  if ( !CREATURE_SIZE_ORDER.includes(normalized) ) throw new Error(`Unknown creature size: ${size}`);
  return normalized;
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}
