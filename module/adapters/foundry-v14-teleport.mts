/**
 * Teleporting an Action's own creature (Misty Step, Dimension Door: `teleport: {distance}`). The player clicks where
 * its Token lands; the client and the authority check that point the same way (`teleportDestination`), and once the
 * Action completes the active GM moves the Token as a teleport: V14's Blink, so it spends no movement, provokes no
 * Opportunity Attack and walks no path (`movementKind: "teleport"`).
 */
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

/** After an Action that teleports its creature (`options.teleport`: its Token and where it lands), on the active GM. */
export function createFoundryTeleports({game}: {game: {user?: {id?: string}; users?: {activeGM?: {id?: string} | null};
  scenes?: {get(id: string): TeleportScene | undefined}}}) {
  async function afterResolution({options}: {options?: {teleport?: {sceneId: string; tokenId: string; x: number; y: number}}}) {
    const teleport = options?.teleport;
    if ( !teleport || !game.user?.id || (game.users?.activeGM?.id !== game.user.id) ) return null;
    const token = game.scenes?.get(teleport.sceneId)?.tokens.get?.(teleport.tokenId);
    if ( !token ) return null;
    const {x, y} = teleport;
    await token.update({x, y}, {movement: {[token.id]: {waypoints: [{x, y, action: "blink"}], showRuler: false}},
      wildpath: {movementKind: "teleport"}});
    return token;
  }
  return {afterResolution};
}
