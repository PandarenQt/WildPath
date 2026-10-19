/**
 * Forced movement (G6, areas.md): when an Action with `push` completes, the active GM moves each creature it pushed
 * (a hit, or a failed save) straight away from its source, or toward it (`toward`: a pull), a field at a time. The
 * creature stops at a wall, another creature, or the Scene's edge. It moves as `forced` movement, which spends no
 * Speed and (2024) provokes no Opportunity Attack; a lasting area it is pushed into still sees it enter.
 */

type Data = Record<string, unknown>;
interface Point {x: number; y: number}
interface Offset {i: number; j: number}
interface PushToken {
  id: string; x: number; y: number; width?: number; height?: number;
  parent?: PushScene | null;
  getCenterPoint(position?: Point): Point;
  getSnappedPosition(position?: Point): Point;
  getOccupiedGridSpaceOffsets?(position?: Point): Offset[];
  update(data: Data, operation?: Data): Promise<unknown>;
  object?: {checkCollision?(destination: Point, options: {origin: Point; type: string; mode: string}): boolean} | null;
}
interface PushScene {
  grid: {isSquare?: boolean; sizeX?: number; sizeY?: number; size?: number; distance?: number};
  dimensions?: {sceneRect?: {contains(x: number, y: number): boolean}};
  tokens: Iterable<PushToken> & {get(id: string): PushToken | undefined};
}
interface PushSpec {distance?: number; toward?: boolean; maxSize?: string; on?: string}

/** The largest Token, in fields, of each size a push may be limited to ("a Large or smaller creature"). */
const LARGEST = Object.freeze({tiny: 0.5, small: 1, medium: 1, large: 2, huge: 3, gargantuan: 4} as Record<string, number>);
const key = (offset: Offset) => `${offset.i}.${offset.j}`;

/** Who an Action pushes: its failed saves (its successes, `on: "success"`), else its hits. */
function pushedTargets(state: Data, definition: {save?: unknown; attack?: unknown; push?: PushSpec}) {
  const results = (state.results ?? {}) as {saveResolution?: {results?: Array<{ok?: boolean; success?: boolean; target?: Data}>};
    attackResolution?: {hits?: Array<{target?: Data}>}};
  if ( definition.save ) return (results.saveResolution?.results ?? [])
    .filter(entry => entry.ok && (entry.success === (definition.push?.on === "success")))
    .map(entry => entry.target);
  if ( definition.attack ) return (results.attackResolution?.hits ?? []).map(entry => entry.target);
  return [];
}

/**
 * Where `token` ends up, pushed `fields` fields from `from` (or pulled toward it). Each step is one field along the
 * line between them: on a square grid the longer axis moves a whole field, so a diagonal push crosses diagonals.
 */
export function forcedDestination(token: PushToken, from: Point, fields: number, {toward=false, blocked}: {toward?: boolean;
  blocked: (origin: Point, destination: Point, position: Point) => boolean}): Point | null {
  const scene = token.parent!;
  const [sizeX, sizeY] = [scene.grid.sizeX ?? scene.grid.size ?? 100, scene.grid.sizeY ?? scene.grid.size ?? 100];
  const centre = token.getCenterPoint();
  const [dx, dy] = toward ? [from.x - centre.x, from.y - centre.y] : [centre.x - from.x, centre.y - from.y];
  const scale = scene.grid.isSquare ? Math.max(Math.abs(dx) / sizeX, Math.abs(dy) / sizeY) : Math.hypot(dx / sizeX, dy / sizeY);
  if ( !scale ) return null;
  let position = {x: token.x, y: token.y};
  for ( let step = 1; step <= fields; step++ ) {
    const next = token.getSnappedPosition({x: token.x + ((dx / scale) * step), y: token.y + ((dy / scale) * step)});
    if ( (next.x === position.x) && (next.y === position.y) ) continue;
    if ( blocked(token.getCenterPoint(position), token.getCenterPoint(next), next) ) break;
    position = next;
  }
  return ((position.x === token.x) && (position.y === token.y)) ? null : position;
}

export function createFoundryForcedMovement({game, logger=console, fromUuid}: {game: {users?: {activeGM?: {id?: string} | null};
  user?: {id?: string}}; logger?: Pick<Console, "warn">; fromUuid: (uuid: string) => Promise<unknown> | unknown}) {
  const isActiveGM = () => Boolean(game.user?.id) && (game.users?.activeGM?.id === game.user?.id);

  async function afterResolution({state}: {state?: Data}) {
    const definition = state?.actionDefinition as {push?: PushSpec; save?: unknown; attack?: unknown} | undefined;
    // Its own push, or a reaction's rider's on it (Forceful Blow: the creature its attack hit).
    const spec = definition?.push ?? ((state?.input as {riderPush?: PushSpec} | undefined)?.riderPush);
    if ( !spec || !state || !isActiveGM() ) return [];
    const source = await fromUuid(String((state.source as Data | undefined)?.tokenRef ?? "")) as PushToken | null;
    const scene = source?.parent ?? null;
    if ( !source || !scene ) {
      logger.warn("Wild Path | A push needs its source's Token on a Scene.");
      return [];
    }
    const fields = Math.floor((Number(spec.distance) || 0) / (Number(scene.grid.distance) || 5));
    const largest = spec.maxSize ? (LARGEST[spec.maxSize] ?? Infinity) : Infinity;
    const from = source.getCenterPoint();
    const distanceOf = (token: PushToken) => Math.hypot(token.getCenterPoint().x - from.x, token.getCenterPoint().y - from.y);
    const tokens = pushedTargets(state, definition ?? {}).map(target => scene.tokens.get(String(target?.tokenId ?? "")))
      .filter((token): token is PushToken => Boolean(token) && (token !== source)
        && (Math.max(Number(token!.width) || 1, Number(token!.height) || 1) <= largest))
      // The farthest moves first when pushed, the nearest when pulled, so none blocks another needlessly.
      .sort((a, b) => (spec.toward ? 1 : -1) * (distanceOf(a) - distanceOf(b)));
    const moved = [];
    for ( const token of tokens ) {
      const others = new Set([...scene.tokens].filter(other => other !== token)
        .flatMap(other => (other.getOccupiedGridSpaceOffsets?.() ?? []).map(key)));
      // shortcut: walls are tested through the Token's placeable, so only when the GM is viewing its Scene.
      const blocked = (origin: Point, destination: Point, position: Point) =>
        !(scene.dimensions?.sceneRect?.contains(destination.x, destination.y) ?? true)
        || Boolean(token.object?.checkCollision?.(destination, {origin, type: "move", mode: "any"}))
        || (token.getOccupiedGridSpaceOffsets?.(position) ?? []).some(offset => others.has(key(offset)));
      const destination = forcedDestination(token, from, fields, {toward: spec.toward === true, blocked});
      if ( !destination ) continue;
      await token.update({...destination}, {wildpath: {movementKind: "forced"}});
      moved.push(token);
    }
    return moved;
  }

  return {afterResolution};
}
