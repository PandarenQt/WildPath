/**
 * Walls on any Scene, not only the one the canvas shows. On the rendered Scene, Foundry's own polygon backends decide
 * (thresholds, levels and every edge). On any other, the Scene's wall documents do, as Foundry reads them: a one-way
 * wall only from its side, an open door not at all, Limited walls only two at once (sight and light).
 * shortcut: off the rendered Scene a Proximity or Distance wall blocks at any distance; upgrade if a threshold matters.
 *
 * It also derives Wall documents from an area's fields (areas.md "Walls from an area"): `cellPolygons`, `outlineEdges`
 * and `areaWallData` raise walls on its outline, and `segmentOutside` clips a wall to what lies outside its cells (an area
 * that opens the walls under it).
 */
import {gridFieldToFoundryOffset} from "./foundry-v14-tactical-grid-adapter.mjs";

type Data = Record<string, unknown>;
export interface Point {x: number; y: number}
export interface CollisionOptions {type?: "move" | "sight" | "light" | "sound"; mode?: string; level?: unknown}
export type Collides = (origin: Point, destination: Point, options?: CollisionOptions) => unknown;
interface WallLike {c?: number[]; move?: number; sight?: number; light?: number; sound?: number; dir?: number; door?: number; ds?: number;
  levels?: Iterable<string> | null}
interface SceneLike {walls?: Iterable<WallLike> | null}

const NONE = 0;
const LIMITED = 10;
const OPEN = 1;

/** Which side of the wall `point` is on, as Foundry's `Edge#orientPoint`: 0 on its line, 1 left, 2 right. */
function sideOf([ax, ay, bx, by]: number[], point: Point) {
  const orientation = ((ay! - point.y) * (bx! - point.x)) - ((ax! - point.x) * (by! - point.y));
  return orientation === 0 ? 0 : (orientation < 0 ? 1 : 2);
}

/** Whether the segment from `origin` to `destination` crosses the wall (touching it at the far end counts). */
function crosses([ax, ay, bx, by]: number[], origin: Point, destination: Point) {
  const rx = destination.x - origin.x;
  const ry = destination.y - origin.y;
  const sx = bx! - ax!;
  const sy = by! - ay!;
  const denominator = (rx * sy) - (ry * sx);
  if ( denominator === 0 ) return false;
  const t = (((ax! - origin.x) * sy) - ((ay! - origin.y) * sx)) / denominator;
  const u = (((ax! - origin.x) * ry) - ((ay! - origin.y) * rx)) / denominator;
  return (t > 0) && (t <= 1) && (u >= 0) && (u <= 1);
}

/** Whether `scene`'s wall documents stop a line of `type` from `origin` to `destination`. */
export function wallsBlock(scene: SceneLike | null | undefined, origin: Point, destination: Point,
  {type="move", level=null}: CollisionOptions = {}) {
  let limited = 0;
  for ( const wall of scene?.walls ?? [] ) {
    const sense = Number(wall[type] ?? NONE);
    if ( (sense === NONE) || !Array.isArray(wall.c) || (wall.c.length < 4) ) continue;
    if ( Number(wall.door) && (Number(wall.ds) === OPEN) ) continue;
    const levels = wall.levels ? [...wall.levels] : [];
    if ( level && levels.length && !levels.includes(String((level as {id?: string}).id ?? level)) ) continue;
    const side = sideOf(wall.c, origin);
    if ( !side ) continue;
    // A one-way wall ignores a line from the side it faces away from (Foundry's ClockwiseSweepPolygon, normal mode).
    if ( Number(wall.dir) && (side === Number(wall.dir)) ) continue;
    if ( !crosses(wall.c, origin, destination) ) continue;
    if ( (sense === LIMITED) && (type !== "move") ) {
      if ( ++limited >= 2 ) return true;
      continue;
    }
    return true;
  }
  return false;
}

/** The wall test for lines on `scene`: Foundry's own while the canvas shows it, else its wall documents (`wallsBlock`). */
export function sceneCollision(scene: SceneLike | null | undefined,
  {canvas=(globalThis as {canvas?: {scene?: unknown}}).canvas,
    backends=(globalThis as {CONFIG?: {Canvas?: {polygonBackends?: Record<string, {testCollision?: Collides}>}}}).CONFIG?.Canvas?.polygonBackends}:
  {canvas?: {scene?: unknown} | undefined; backends?: Record<string, {testCollision?: Collides}> | undefined} = {}): Collides {
  return (origin, destination, options = {}) => {
    const type = options.type ?? "move";
    const backend = (canvas?.scene === scene) ? backends?.[type] : null;
    if ( backend?.testCollision ) return backend.testCollision.call(backend, origin, destination, {mode: "any", ...options, type} as Data);
    return wallsBlock(scene, origin, destination, {...options, type});
  };
}

/** The senses a wall can stop, as a Wall document's fields: an area's `persistence.blocks` lists some of them. */
export type WallSense = "move" | "sight" | "light" | "sound";
interface WallConstants {EDGE_SENSE_TYPES?: {NONE: number; NORMAL: number}; WALL_MOVEMENT_TYPES?: {NONE: number; NORMAL: number};
  EDGE_DIRECTIONS?: {BOTH: number}}
const toOffset = gridFieldToFoundryOffset as unknown as (field: unknown, options: {grid: unknown}) => {offset?: unknown};

/** The corners of each of `fields`' cells in pixels, in the perimeter order Foundry's `grid.getVertices` gives them. */
export function cellPolygons(scene: {grid: {getVertices(offset: unknown): Point[]}}, fields: readonly unknown[]): Point[][] {
  return fields.flatMap(field => {
    const offset = toOffset(field, {grid: scene.grid}).offset;
    return offset ? [scene.grid.getVertices(offset)] : [];
  });
}

/**
 * The edges of `polygons` that no two of them share: the outline of the cells they make up, as `c` (whole pixels, as a
 * Wall's `c` must be). Each keeps its own cell's winding, so a square grid's outline is bastion-map's.
 */
export function outlineEdges(polygons: readonly Point[][]): number[][] {
  const edges = new Map<string, {c: number[]; count: number}>();
  for ( const polygon of polygons ) polygon.forEach((point, index) => {
    const next = polygon[(index + 1) % polygon.length]!;
    const c = [point.x, point.y, next.x, next.y].map(Math.round);
    const key = [`${c[0]},${c[1]}`, `${c[2]},${c[3]}`].sort().join(";");
    const entry = edges.get(key);
    if ( entry ) entry.count++;
    else edges.set(key, {c, count: 1});
  });
  return [...edges.values()].filter(entry => entry.count === 1).map(entry => entry.c);
}

/**
 * A Wall document's four senses, stopping those `blocks` lists and nothing else (CONST's NORMAL and NONE): with none
 * listed, a wall that stops nothing, as an opened wall is hidden.
 */
export function wallSenses(blocks: readonly string[]) {
  const sense = (globalThis as {CONST?: WallConstants}).CONST?.EDGE_SENSE_TYPES ?? {NONE, NORMAL: 20};
  const movement = (globalThis as {CONST?: WallConstants}).CONST?.WALL_MOVEMENT_TYPES ?? {NONE, NORMAL: 20};
  const stops = (name: WallSense, types: {NONE: number; NORMAL: number}) => (blocks.includes(name) ? types.NORMAL : types.NONE);
  return {move: stops("move", movement), sight: stops("sight", sense), light: stops("light", sense), sound: stops("sound", sense)};
}

/**
 * One two-way Wall document's data for each edge, stopping the senses `blocks` lists and nothing else: a WallDocument
 * starts every sense at NORMAL, so an unlisted one is written NONE. On the caster's Level (`level`) when it has one.
 */
export function areaWallData(edges: readonly number[][], {blocks, level=null, flags={}}: {blocks: readonly string[];
  level?: string | null; flags?: Data}) {
  const direction = (globalThis as {CONST?: WallConstants}).CONST?.EDGE_DIRECTIONS?.BOTH ?? 0;
  return edges.map(c => ({c: [...c], ...wallSenses(blocks), dir: direction, ...(level ? {levels: [level]} : {}), flags}));
}

/**
 * The part of the segment from `t` = enter to exit that lies strictly inside the convex `polygon` (Cyrus-Beck), or null:
 * a segment only touching it, or running along its edge, is outside.
 */
function clipInside(polygon: readonly Point[], [ax, ay, bx, by]: number[]): [number, number] | null {
  const [dx, dy] = [bx! - ax!, by! - ay!];
  const winding = Math.sign(polygon.reduce((sum, point, index) => {
    const next = polygon[(index + 1) % polygon.length]!;
    return sum + ((point.x * next.y) - (next.x * point.y));
  }, 0));
  let [enter, exit] = [0, 1];
  for ( const [index, point] of polygon.entries() ) {
    const next = polygon[(index + 1) % polygon.length]!;
    const [ex, ey] = [next.x - point.x, next.y - point.y];
    // How far inside this edge the segment's start is, and how fast that changes along it (positive is inward).
    const start = winding * ((ex * (ay! - point.y)) - (ey * (ax! - point.x)));
    const rate = winding * ((ex * dy) - (ey * dx));
    if ( rate === 0 ) {
      if ( start <= 0 ) return null;
      continue;
    }
    if ( rate > 0 ) enter = Math.max(enter, -start / rate);
    else exit = Math.min(exit, -start / rate);
  }
  return (exit - enter) > 1e-9 ? [enter, exit] : null;
}

/**
 * The pieces of the wall `c` outside every one of `polygons` (convex cells), whole pixels: `[c]` itself, unchanged, when
 * no cell cuts it, so that is the test for whether it crosses them; none when they cover it.
 */
export function segmentOutside(c: number[], polygons: readonly Point[][]): number[][] {
  const [ax, ay, bx, by] = c as [number, number, number, number];
  const inside = polygons.filter(polygon => {
    const xs = polygon.map(point => point.x);
    const ys = polygon.map(point => point.y);
    return (Math.max(ax, bx) > Math.min(...xs)) && (Math.min(ax, bx) < Math.max(...xs))
      && (Math.max(ay, by) > Math.min(...ys)) && (Math.min(ay, by) < Math.max(...ys));
  }).flatMap(polygon => {
    const span = clipInside(polygon, c);
    return span ? [span] : [];
  }).sort((a, b) => a[0] - b[0]);
  if ( !inside.length ) return [c];
  const spans: Array<[number, number]> = [];
  let from = 0;
  for ( const [enter, exit] of inside ) {
    if ( enter > from ) spans.push([from, enter]);
    from = Math.max(from, exit);
  }
  if ( from < 1 ) spans.push([from, 1]);
  return spans.map(([start, end]) => [ax + ((bx - ax) * start), ay + ((by - ay) * start), ax + ((bx - ax) * end), ay + ((by - ay) * end)]
    .map(Math.round)).filter(([x0, y0, x1, y1]) => (x0 !== x1) || (y0 !== y1));
}
