import {AUTOMATION_EVENT_TYPES} from "../helpers/automation-events.mjs";
import {effectsFrom} from "../helpers/effect-sources.mjs";
import {parseEntityRef} from "../helpers/entity-refs.mjs";
import {createFoundryV14TacticalGridAdapter} from "./foundry-v14-tactical-grid-adapter.mjs";
import {footprintDistance} from "../helpers/grid-footprints.mjs";
import {forcedStepBlocker, type PushScene, type PushToken} from "./foundry-v14-forced-movement.mjs";
/**
 * Carrying a creature along (2024 Heightened Focus' Step of the Wind: a `carried` effect from the mover). When a creature
 * finishes a voluntary move, or is interrupted in one, the active GM walks each creature carrying its `carried` effect
 * through the same steps, as forced movement: it spends none of that creature's Speed and provokes no Opportunity Attack,
 * and a lasting area it is carried into still sees it enter. It is the first consumer of the informational movement events
 * (`movement.completed`/`interrupted`, fired once, on the authority that committed the move).
 * shortcut: the carried creature stops at a wall, the Scene's edge or another creature's space (forced movement's rules,
 * stricter than 5e's moving through an ally) and keeps its own elevation; upgrade with a route evaluation of its own.
 * shortcut: without an active GM, nothing is carried (as pushes and teleports).
 *
 * Riding along (vehicles-and-mythic.md, owner's Q6): when a vehicle (an Actor with an `aboard` list) finishes a voluntary
 * move, every other Token standing wholly on the spaces it set out from moves with it by the same offset, at once, as a
 * forced move: no Speed spent, no Opportunity Attack. Its deck shares spaces (`occupancy.share`), so nothing blocks it.
 * shortcut: the riders jump to the end (no walls or edges checked on the way) and keep their elevation; upgrade with the
 * carried creatures' step-by-step route when a vehicle's walls matter.
 */

type Data = Record<string, unknown>;
interface Point {x: number; y: number}
interface CarryToken extends PushToken {actor?: {uuid?: string; effects?: unknown; system?: {aboard?: unknown}} | null}
interface CarryEvent {type?: string; data?: {movementKind?: string; tokenRef?: string; completedAnchors?: Data[];
  origin?: {footprint?: {fields?: Data[]}}; actualDestination?: {footprint?: {fields?: Data[]}}}}
interface GridAdapter {
  fieldToCenterPoint(field: Data): {ok: boolean; point?: Point};
  fieldToOffset(field: Data): {ok: boolean; offset?: {i: number; j: number}};
  tokenToFootprint(token: unknown): {ok: boolean; footprint?: Data};
}

const ENDS = new Set<string>([AUTOMATION_EVENT_TYPES.MOVEMENT_COMPLETED, AUTOMATION_EVENT_TYPES.MOVEMENT_INTERRUPTED]);
const key = (offset: {i: number; j: number}) => `${offset.i}.${offset.j}`;

export function createFoundryCarry({game}: {game: {user?: {id?: string}; users?: {activeGM?: {id?: string} | null};
  scenes?: {get(id: string): PushScene | undefined}}}) {
  const isActiveGM = () => Boolean(game.user?.id) && (game.users?.activeGM?.id === game.user?.id);

  // One carry at a time: each reads its creatures where the one before left them (a monk's quick second move).
  let queue: Promise<unknown> = Promise.resolve();
  function onMovementEvent(event: CarryEvent) {
    const run = queue.then(() => carry(event), () => carry(event));
    queue = run.catch(() => undefined);
    return run;
  }

  async function carry(event: CarryEvent) {
    const data = event?.data;
    // Only its own walking carries anyone: the carried creature's forced move never starts a chain.
    if ( !ENDS.has(String(event?.type)) || (data?.movementKind !== "voluntary") || !isActiveGM() ) return [];
    const ref = parseEntityRef(data.tokenRef);
    const scene = ref.ok ? game.scenes?.get(String(ref.scope)) : undefined;
    const carrier = scene?.tokens.get(String(ref.id)) as CarryToken | undefined;
    const anchors = data.completedAnchors ?? [];
    if ( !scene || !carrier?.actor || (anchors.length < 2) ) return [];
    if ( Array.isArray(carrier.actor.system?.aboard) ) return rideAlong(scene, carrier, data);
    const carried = [...scene.tokens as Iterable<CarryToken>].filter(token => (token !== carrier) && effectsFrom(token.actor, carrier.actor, game)
      .some((effect: {statuses?: Set<string>}) => effect.statuses?.has("carried")));
    if ( !carried.length ) return [];
    // A gridless Scene has no tactical anchors to follow: nothing is carried there.
    const adapter = createFoundryV14TacticalGridAdapter({scene}) as GridAdapter;
    const points = anchors.map(anchor => adapter.fieldToCenterPoint(anchor).point);
    const carrierSpace = (data.actualDestination?.footprint?.fields ?? []).map(field => adapter.fieldToOffset(field).offset);
    if ( points.some(point => !point) || carrierSpace.some(offset => !offset) ) return [];
    const [start] = points as Point[];
    // Only a creature still beside its carrier where the move began: one left behind (a wall stopped it, its carrier was
    // pushed or teleported) is no longer moved with it.
    const origin = data.origin?.footprint;
    const besideOrigin = (token: CarryToken) => {
      const footprint = adapter.tokenToFootprint(token).footprint;
      return Boolean(origin && footprint) && ((footprintDistance(origin as never, footprint as never)
        * (Number((scene as {grid?: {distance?: number}}).grid?.distance) || 5)) <= 5);
    };
    const occupied = new Set(carrierSpace.map(offset => key(offset!)));
    const moved = [];
    for ( const token of carried.filter(besideOrigin) ) {
      // It passes through its carrier's spaces on the way, but never stops on the one the carrier ends in.
      const blocked = forcedStepBlocker(scene, token, {except: [carrier]});
      const waypoints: Point[] = [];
      let at = {x: token.x, y: token.y};
      for ( const point of (points as Point[]).slice(1) ) {
        const next = {x: token.x + point.x - start!.x, y: token.y + point.y - start!.y};
        if ( blocked(token.getCenterPoint(at), token.getCenterPoint(next), next) ) break;
        waypoints.push(next);
        at = next;
      }
      const onCarrier = (position: Point) => (token.getOccupiedGridSpaceOffsets?.(position) ?? []).some(offset => occupied.has(key(offset)));
      while ( waypoints.length && onCarrier(waypoints.at(-1)!) ) waypoints.pop();
      const last = waypoints.at(-1);
      if ( !last ) continue;
      await token.update({...last}, {movement: {[token.id]: {waypoints, showRuler: false}}, wildpath: {movementKind: "forced"}});
      moved.push(token);
    }
    return moved;
  }

  /** A vehicle's riders: each Token standing wholly on its starting spaces, moved by the vehicle's own offset. */
  async function rideAlong(scene: PushScene, vehicle: CarryToken, data: NonNullable<CarryEvent["data"]>) {
    const adapter = createFoundryV14TacticalGridAdapter({scene}) as GridAdapter;
    const anchors = data.completedAnchors ?? [];
    const [start, end] = [anchors[0], anchors.at(-1)].map(anchor => adapter.fieldToCenterPoint(anchor!).point);
    const deck = new Set((data.origin?.footprint?.fields ?? []).map(field => `${field.x}.${field.y}`));
    if ( !start || !end || !deck.size ) return [];
    const riders = [...scene.tokens as Iterable<CarryToken>].filter(token => {
      if ( token === vehicle ) return false;
      const fields = ((adapter.tokenToFootprint(token).footprint?.fields ?? []) as Data[]);
      return fields.length > 0 && fields.every(field => deck.has(`${field.x}.${field.y}`));
    });
    // The one furthest along the way first, so none lands where another still stands.
    const ahead = (token: CarryToken) => (token.x * (end.x - start.x)) + (token.y * (end.y - start.y));
    const moved = [];
    for ( const token of riders.sort((a, b) => ahead(b) - ahead(a)) ) {
      const to = {x: token.x + end.x - start.x, y: token.y + end.y - start.y};
      // One jump, so a teleport's kind: a forced move must walk adjacent steps (found live: the jump was refused).
      await token.update(to, {movement: {[token.id]: {waypoints: [{...to, action: "blink"}], showRuler: false}}, wildpath: {movementKind: "teleport"}});
      moved.push(token);
    }
    return moved;
  }

  return {onMovementEvent};
}
