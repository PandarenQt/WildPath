import {createFoundryV14TacticalGridAdapter} from "./foundry-v14-tactical-grid-adapter.mjs";
import {
  AREA_SHAPES, createCubeFootprint, createRadialFootprint, createWallFootprint, cubeCornersAgainst, previewSourceBoundaryArea,
  selectSourceBoundaryOrigin
} from "../helpers/tactical-areas.mjs";
import {createReachFootprint, footprintDistance} from "../helpers/grid-footprints.mjs";

type Data = Record<string, unknown>;
interface Point {x: number; y: number}
interface Field {[key: string]: unknown}
interface Footprint {topology: string; fields: Field[]; boundaryVertices?: Array<{id: string}>; [key: string]: unknown}
interface Token {id: string; parent: unknown}
interface AreaDefinition {
  area?: {shape?: string | null; size?: {value?: number} | null} | null;
  range?: {type?: string; normal?: {value?: number}; distance?: {value?: number}} | null;
}
/** Why a placement is not (yet) valid; the placement UI shows `WILDPATH.AREA.<code>`. */
export type AreaCode = "NoGrid" | "NoFootprint" | "NeedOrigin" | "OffGrid" | "OutOfRange" | "UnsupportedShape"
  | "NotOnEdge" | "NeedDirection" | "BadDirection";
type AreaResult = {ok: true; footprint: Footprint} | {ok: false; code: AreaCode; reason: string; needs?: "origin" | "direction"};
// The JS area helpers infer narrow default types; these are the only places their shapes are asserted.
const radialFootprint = createRadialFootprint as unknown as (options: Data) => Footprint;
const selectOrigin = selectSourceBoundaryOrigin as unknown as (options: Data) => {ok: boolean};
const boundaryArea = previewSourceBoundaryArea as unknown as (options: Data) => {ok: boolean; resolved?: Footprint; reason?: string};
const reachFootprint = createReachFootprint as unknown as (options: Data) => {fields: Field[]};
const createCube = createCubeFootprint as unknown as (options: Data) => Footprint | null;
const createWall = createWallFootprint as unknown as (options: Data) => Footprint | null;
const cornersAgainst = cubeCornersAgainst as unknown as (fields: Array<{x: number; y: number}>, side: number) => Array<{x: number; y: number}>;

/** Clicks that place this area: none for an emanation, one field for a radial area or a Cube, a corner and a direction otherwise. */
export function areaClickCount(definition: AreaDefinition): number {
  const shape = definition.area?.shape;
  return shape === AREA_SHAPES.EMANATION ? 0 : (((shape === AREA_SHAPES.RADIAL) || (shape === AREA_SHAPES.CUBE)) ? 1 : 2);
}

/**
 * The grid fields an area Action covers, from the canvas points that placed it. The client's preview and the
 * authority's resolution both call this, so the highlighted fields are exactly the ones that resolve.
 * Radial: `points[0]` picks the center field, within the Action's range of the caster. Cone and line:
 * `points[0]` picks a corner on the caster's Token edge and `points[1]` the direction.
 */
/** Whether a canvas point's field is within the Action's range of the caster; true when the Action has no range. */
export function foundryPointInRange({definition, sourceToken, point}: {definition: AreaDefinition; sourceToken: Token; point: Point}) {
  const range = Number(definition.range?.normal?.value ?? definition.range?.distance?.value);
  if (!Number.isFinite(range)) return true;
  const adapter = createFoundryV14TacticalGridAdapter({scene: sourceToken.parent});
  const scene = adapter.getSceneContext();
  if (!scene.ok || !("context" in scene)) return true;
  const {topology, distance: gridDistance} = (scene.context as {grid: {topology: string; distance: number}}).grid;
  const source = adapter.tokenToFootprint(sourceToken);
  const field = adapter.pointToField(point) as {ok: boolean; field?: Field};
  if (!source.ok || !("footprint" in source) || !source.footprint || !field.ok || !field.field) return false;
  return footprintDistance(source.footprint as Footprint, {topology, fields: [field.field]}) * gridDistance <= range;
}

export function foundryAreaFootprint({definition, sourceToken, points}: {
  definition: AreaDefinition; sourceToken: Token; points: readonly Point[];
}): AreaResult {
  const adapter = createFoundryV14TacticalGridAdapter({scene: sourceToken.parent});
  const scene = adapter.getSceneContext();
  if (!scene.ok || !("context" in scene)) return {ok: false, code: "NoGrid", reason: "Areas need a square or hex grid."};
  const {topology, distance: gridDistance} = (scene.context as {grid: {topology: string; distance: number}}).grid;
  const sourceResult = adapter.tokenToFootprint(sourceToken);
  if (!sourceResult.ok || !("footprint" in sourceResult) || !sourceResult.footprint) return {ok: false, code: "NoFootprint", reason: "The caster's Token has no footprint."};
  const source = sourceResult.footprint as Footprint;
  const shape = definition.area?.shape;
  const size = Number(definition.area?.size?.value) || 0;
  // An emanation surrounds the caster; its own fields are not part of it.
  if (shape === AREA_SHAPES.EMANATION) {
    const fields = reachFootprint({source, reachDistance: size, gridDistance}).fields;
    return {ok: true, footprint: {topology, fields, shape}};
  }
  const [first, second] = points;
  if (!first) return {ok: false, code: "NeedOrigin", reason: "Choose where the area starts.", needs: "origin"};

  if (shape === AREA_SHAPES.RADIAL) {
    const fieldResult = adapter.pointToField(first) as {ok: boolean; field?: Field};
    if (!fieldResult.ok || !fieldResult.field) return {ok: false, code: "OffGrid", reason: "That point is not on the grid.", needs: "origin"};
    const range = Number(definition.range?.normal?.value ?? definition.range?.distance?.value);
    if (Number.isFinite(range) && (footprintDistance(source, {topology, fields: [fieldResult.field]}) * gridDistance > range)) {
      return {ok: false, code: "OutOfRange", reason: "That point is out of range.", needs: "origin"};
    }
    return {ok: true, footprint: radialFootprint({topology, origin: fieldResult.field, radiusDistance: size, gridDistance})};
  }
  if (shape === AREA_SHAPES.CUBE) return cubeFootprint({definition, adapter, source, point: first, topology, size, gridDistance});
  if (shape === AREA_SHAPES.WALL) return wallFootprint({definition, adapter, source, points: [first, second], topology, size, gridDistance});
  if ((shape !== AREA_SHAPES.CONE) && (shape !== AREA_SHAPES.LINE)) return {ok: false, code: "UnsupportedShape", reason: `Unsupported area shape: ${shape}.`};

  const vertexResult = adapter.pointToVertex(first) as {ok: boolean; vertex?: {id: string}};
  const placement = vertexResult.ok && vertexResult.vertex
    ? selectOrigin({sources: [{id: sourceToken.id, footprint: source, token: {id: sourceToken.id}}], vertexId: vertexResult.vertex.id})
    : {ok: false};
  if (!placement.ok) return {ok: false, code: "NotOnEdge", reason: "Start the area at a corner on your Token's edge.", needs: "origin"};
  if (!second) return {ok: false, code: "NeedDirection", reason: "Choose the area's direction.", needs: "direction"};
  const directionResult = adapter.pointToVertex(second) as {ok: boolean; vertex?: Data};
  if (!directionResult.ok || !directionResult.vertex) return {ok: false, code: "BadDirection", reason: "That direction is not on the grid.", needs: "direction"};
  const preview = boundaryArea({shape, placement, directionVertex: directionResult.vertex,
    rangeDistance: size, gridDistance, topology});
  if (!preview.ok || !preview.resolved) return {ok: false, code: "BadDirection", reason: preview.reason ?? "That direction is not allowed.", needs: "direction"};
  return {ok: true, footprint: preview.resolved};
}

/**
 * A Cube (2024) on a square grid, `size` across. Originating from its caster ("a 15-foot Cube originating from you",
 * a `self` range), it touches the caster's Token on the side toward the click; otherwise it is centered on the click,
 * within range when any of its fields is.
 */
function cubeFootprint({definition, adapter, source, point, topology, size, gridDistance}: {definition: AreaDefinition;
  adapter: ReturnType<typeof createFoundryV14TacticalGridAdapter>; source: Footprint; point: Point; topology: string; size: number;
  gridDistance: number}): AreaResult {
  const side = Math.max(1, Math.round(size / gridDistance));
  const fieldResult = adapter.pointToField(point) as {ok: boolean; field?: {x: number; y: number}};
  if (!fieldResult.ok || !fieldResult.field) return {ok: false, code: "OffGrid", reason: "That point is not on the grid.", needs: "origin"};
  const clicked = fieldResult.field;
  const cube = (corner: {x: number; y: number}) => createCube({topology, corner, side}) as Footprint | null;
  if (definition.range?.type === "self") {
    // The block touching the caster whose center is nearest the click.
    const centerOf = (corner: {x: number; y: number}) => ({x: corner.x + ((side - 1) / 2), y: corner.y + ((side - 1) / 2)});
    const corners = cornersAgainst(source.fields as Array<{x: number; y: number}>, side);
    const best = corners.sort((a, b) => Math.hypot(centerOf(a).x - clicked.x, centerOf(a).y - clicked.y)
      - Math.hypot(centerOf(b).x - clicked.x, centerOf(b).y - clicked.y))[0];
    const footprint = best ? cube(best) : null;
    return footprint ? {ok: true, footprint} : {ok: false, code: "UnsupportedShape", reason: "Cubes need a square grid.", needs: "origin"};
  }
  const footprint = cube({x: clicked.x - Math.floor((side - 1) / 2), y: clicked.y - Math.floor((side - 1) / 2)});
  if (!footprint) return {ok: false, code: "UnsupportedShape", reason: "Cubes need a square grid.", needs: "origin"};
  const range = Number(definition.range?.normal?.value ?? definition.range?.distance?.value);
  if (Number.isFinite(range) && (footprintDistance(source, footprint) * gridDistance > range)) {
    return {ok: false, code: "OutOfRange", reason: "That point is out of range.", needs: "origin"};
  }
  return {ok: true, footprint};
}

/**
 * A wall (2024: Wall of Fire, Wall of Thorns, Blade Barrier) on a square grid: it starts on the first clicked field,
 * within range, and runs toward the second for its whole length, in a straight grid path at any angle.
 */
function wallFootprint({definition, adapter, source, points, topology, size, gridDistance}: {definition: AreaDefinition;
  adapter: ReturnType<typeof createFoundryV14TacticalGridAdapter>; source: Footprint; points: Array<Point | undefined>; topology: string;
  size: number; gridDistance: number}): AreaResult {
  const field = (point: Point) => (adapter.pointToField(point) as {ok: boolean; field?: {x: number; y: number}}).field ?? null;
  const start = points[0] ? field(points[0]) : null;
  if (!start) return {ok: false, code: "OffGrid", reason: "That point is not on the grid.", needs: "origin"};
  const range = Number(definition.range?.normal?.value ?? definition.range?.distance?.value);
  if (Number.isFinite(range) && (footprintDistance(source, {topology, fields: [start]}) * gridDistance > range)) {
    return {ok: false, code: "OutOfRange", reason: "That point is out of range.", needs: "origin"};
  }
  if (!points[1]) return {ok: false, code: "NeedDirection", reason: "Choose the area's direction.", needs: "direction"};
  const end = field(points[1]);
  if (!end) return {ok: false, code: "BadDirection", reason: "That direction is not on the grid.", needs: "direction"};
  const footprint = createWall({topology, start, end, length: Math.max(1, Math.round(size / gridDistance))});
  return footprint ? {ok: true, footprint} : {ok: false, code: "UnsupportedShape", reason: "Walls need a square grid.", needs: "origin"};
}

/** Every Token on the caster's Scene and Level that any covered field touches, the caster included. */
export function foundryAreaTargetTokens({sourceToken, footprint}: {sourceToken: Token; footprint: Footprint}) {
  const scene = sourceToken.parent as {tokens: {get(id: string): unknown}};
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  const candidates = adapter.resolveAreaTargetCandidates({footprint, sourceToken}) as unknown as {
    candidates: Array<{metadata?: {foundry?: {tokenId?: string}}}>;
  };
  return candidates.candidates.map(candidate => scene.tokens.get(String(candidate.metadata?.foundry?.tokenId))).filter(Boolean);
}
