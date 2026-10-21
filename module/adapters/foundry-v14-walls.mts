/**
 * Walls on any Scene, not only the one the canvas shows. On the rendered Scene, Foundry's own polygon backends decide
 * (thresholds, levels and every edge). On any other, the Scene's wall documents do, as Foundry reads them: a one-way
 * wall only from its side, an open door not at all, Limited walls only two at once (sight and light).
 * shortcut: off the rendered Scene a Proximity or Distance wall blocks at any distance; upgrade if a threshold matters.
 */

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
