/**
 * Teleporting an Action's own creature (Misty Step, Dimension Door: `teleport: {distance}`). The player clicks where
 * its Token lands; the client and the authority check that point the same way (`teleportDestination`), and once the
 * Action completes the active GM moves the Token as a teleport: V14's Blink, so it spends no movement, provokes no
 * Opportunity Attack and walks no path (`movementKind: "teleport"`).
 */
import {completedTargetRefs} from "../helpers/target-actor-refs.mjs";

interface Point {x: number; y: number}
interface Offset {i: number; j: number}
export interface TeleportToken {
  id: string; x: number; y: number; parent: TeleportScene | null;
  getCenterPoint(data?: Partial<Point>): Point;
  getOccupiedGridSpaceOffsets?(data?: Partial<Point>): Offset[];
  update(data: object, operation?: object): Promise<unknown>;
}
export interface TeleportScene {
  id: string;
  tokens: Iterable<TeleportToken> & {get?(id: string): TeleportToken | undefined};
  grid: {getOffset(point: Point): unknown; getTopLeftPoint(offset: unknown): Point; measurePath(points: Point[]): {distance: number}};
  dimensions?: {sceneRect?: {contains(x: number, y: number): boolean}};
}

/** Why a destination is refused: a lang key under WILDPATH.TELEPORT. */
export type TeleportCode = "OutOfRange" | "Occupied" | "OffScene" | "NoToken";

const key = (offset: Offset) => `${offset.i},${offset.j}`;

/**
 * Where `token` lands when teleported to the field at `point`, its top-left there: refused beyond `distance` feet
 * (center to center), off the Scene, or onto another Token's space.
 */
export function teleportDestination({token, point, distance}: {token: TeleportToken | null; point: Point; distance: number}):
  {ok: true; position: Point} | {ok: false; code: TeleportCode} {
  const scene = token?.parent;
  if ( !token || !scene ) return {ok: false, code: "NoToken"};
  const position = scene.grid.getTopLeftPoint(scene.grid.getOffset(point));
  const center = token.getCenterPoint(position);
  if ( !(scene.dimensions?.sceneRect?.contains(center.x, center.y) ?? true) ) return {ok: false, code: "OffScene"};
  const feet = scene.grid.measurePath([token.getCenterPoint(), center]).distance;
  if ( !(feet <= (Number(distance) || 0)) ) return {ok: false, code: "OutOfRange"};
  const others = new Set([...scene.tokens].filter(other => other !== token)
    .flatMap(other => (other.getOccupiedGridSpaceOffsets?.() ?? []).map(key)));
  if ( (token.getOccupiedGridSpaceOffsets?.(position) ?? []).some(offset => others.has(key(offset))) ) return {ok: false, code: "Occupied"};
  return {ok: true, position: {x: position.x, y: position.y}};
}

/**
 * The free space within 5 feet of `nextTo` nearest `token` (Protective Bond: "teleport to an unoccupied space within 5
 * feet of the first creature"): the fields around the spaces `nextTo` occupies, or null when none is free.
 */
export function spaceBeside(token: TeleportToken, nextTo: TeleportToken): Point | null {
  const scene = token.parent;
  if ( !scene ) return null;
  const occupied = nextTo.getOccupiedGridSpaceOffsets?.() ?? [];
  const taken = new Set(occupied.map(key));
  const around = new Map<string, Offset>();
  for ( const {i, j} of occupied ) for ( const di of [-1, 0, 1] ) for ( const dj of [-1, 0, 1] ) {
    const offset = {i: i + di, j: j + dj};
    if ( !taken.has(key(offset)) ) around.set(key(offset), offset);
  }
  const from = token.getCenterPoint();
  const landings = [...around.values()].map(offset => teleportDestination({token, point: scene.grid.getTopLeftPoint(offset), distance: Infinity}))
    .flatMap(result => (result.ok ? [result.position] : []));
  const far = (point: Point) => scene.grid.measurePath([from, token.getCenterPoint(point)]).distance;
  return landings.sort((a, b) => far(a) - far(b))[0] ?? null;
}

/** Moves `token` to `point` as V14's Blink: no movement spent, no Opportunity Attack, no path walked. */
export function blink(token: Pick<TeleportToken, "id" | "update">, point: Point) {
  return token.update(point, {movement: {[token.id]: {waypoints: [{...point, action: "blink"}], showRuler: false}},
    wildpath: {movementKind: "teleport"}});
}

type TargetRef = {tokenId?: string | null} | null | undefined;

/**
 * After an Action that teleports its creature (`options.teleport`: its Token and where it lands), or a reaction's rider
 * that moves its creature beside the one it protects (`state.input.riderTeleport`), on the active GM. With
 * `teleport.withTargets` the Action's targets go too (Dimension Door's willing creature, a Fey Steed's rider), each to the
 * free space beside the landing nearest it.
 * shortcut: a target with no free space beside the landing stays where it is (Dimension Door's 'teleportation fails, 4d6
 * Force' is the separate manual damage item); upgrade by refusing the cast up front.
 */
export function createFoundryTeleports({game}: {game: {user?: {id?: string}; users?: {activeGM?: {id?: string} | null};
  scenes?: {get(id: string): TeleportScene | undefined}}}) {
  async function afterResolution({options, state}: {options?: {teleport?: {sceneId: string; tokenId: string; x: number; y: number}};
    state?: {source?: {tokenRef?: string | null}; input?: {riderTeleport?: {tokenId: string; nextTo: string}};
      actionDefinition?: {teleport?: {withTargets?: boolean}} | null; targets?: TargetRef[]; results?: object}}) {
    if ( !game.user?.id || (game.users?.activeGM?.id !== game.user.id) ) return null;
    const beside = state?.input?.riderTeleport;
    if ( beside ) {
      const scene = [...((game.scenes as unknown as Iterable<TeleportScene> | undefined) ?? [])].find(each => each.tokens.get?.(beside.tokenId));
      const mover = scene?.tokens.get?.(beside.tokenId);
      const protectedToken = scene?.tokens.get?.(beside.nextTo);
      const point = (mover && protectedToken) ? spaceBeside(mover, protectedToken) : null;
      if ( mover && point ) await blink(mover, point);
    }
    const teleport = options?.teleport;
    if ( !teleport ) return null;
    const scene = game.scenes?.get(teleport.sceneId);
    const token = scene?.tokens.get?.(teleport.tokenId);
    if ( !token ) return null;
    await blink(token, {x: teleport.x, y: teleport.y});
    if ( !state?.actionDefinition?.teleport?.withTargets ) return token;
    for ( const target of completedTargetRefs(state) as TargetRef[] ) {
      const other = scene?.tokens.get?.(String(target?.tokenId ?? ""));
      if ( !other || (other === token) ) continue;
      const point = spaceBeside(other, token);
      if ( point ) await blink(other, point);
    }
    return token;
  }
  return {afterResolution};
}
