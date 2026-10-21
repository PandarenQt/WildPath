import {createFoundryV14TacticalGridAdapter} from "../adapters/foundry-v14-tactical-grid-adapter.mjs";
import {observersLeftBehind} from "../helpers/movement-transition.mjs";
import {areaCovers, sceneAreas} from "../adapters/foundry-v14-persistent-areas.mjs";
import {rulesVersion} from "../documents/actor.mjs";
import type {MovementObserver} from "../helpers/movement-transition.mjs";
import type {TokenGridFootprint} from "../types/contracts.js";

/**
 * Movement that warns (after Baldur's Gate 3): a dragged Token's destination label also shows the movement it would
 * have left, and each hostile creature whose reach the path leaves while it still has its Reaction (an Opportunity
 * Attack). The reactors are the production reaction provider's own observers, and the reach relations are the
 * authority's (`movementTransitionRelations`), sampled at each grid step of the path. It also names each lasting area
 * the path walks into (a Wall of Fire, Spike Growth). Difficult terrain is in Foundry's own cost on the label.
 */

type Data = Record<string, unknown>;
interface TokenDocumentLike {id: string; name?: string; hidden?: boolean; parent?: unknown; actor?: {system?: Data} | null; toObject(source: boolean): Data}
interface TokenLike {document: TokenDocumentLike; actor?: {system?: {resources?: {movement?: {value?: number}}}} | null;
  getSnappedPosition(position: {x: number; y: number}): {x: number; y: number}}
interface Waypoint {x: number; y: number; next?: unknown; previous?: Waypoint | null; measurement: {cost: number}}
interface Observer {id: string; token: TokenDocumentLike & {object?: {visible?: boolean} | null}; reachFields: number; context?: {hostile?: boolean}}
interface Globals {
  foundry: {canvas: {placeables: {tokens: {TokenRuler: new (...args: never[]) => {token: TokenLike;
    _getWaypointLabelContext(waypoint: Waypoint, state: object): Data | void}}}}};
  CONFIG: {Token: {rulerClass: unknown}};
  canvas: {grid: {size: number; units: string}};
  CONST: {REGION_VISIBILITY: {ALWAYS: number}};
  game: {user?: {isGM?: boolean}; i18n: {format(key: string, data: Data): string; localize(key: string): string};
    wildpath?: {reactionServices?(context: Data): {movement?: {observers?: Observer[]}}}};
};
const globals = globalThis as unknown as Globals;
const leftBehind = observersLeftBehind as unknown as (path: TokenGridFootprint[], observers: MovementObserver[]) => string[];

/** The Token's positions along the path to `last`: its waypoints, and each grid step between them, from the start. */
function pathPositions(token: TokenLike, last: Waypoint): Data[] {
  const source = token.document.toObject(true);
  const waypoints: Waypoint[] = [];
  for ( let waypoint: Waypoint | null | undefined = last; waypoint; waypoint = waypoint.previous ) waypoints.unshift(waypoint);
  const size = globals.canvas.grid.size;
  return waypoints.flatMap((waypoint, index) => {
    const from = waypoints[index - 1] ?? waypoint;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(waypoint.x - from.x), Math.abs(waypoint.y - from.y)) / size));
    return Array.from({length: steps + (index ? 0 : 1)}, (_, offset) => offset + (index ? 1 : 0)).map(step => ({...source,
      ...token.getSnappedPosition({x: from.x + ((waypoint.x - from.x) * step / steps), y: from.y + ((waypoint.y - from.y) * step / steps)})}));
  });
}

/**
 * The lasting areas that act on a creature (with triggers: Burning Ground, not a Daylight) that the path walks into,
 * not covering its start. Areas hidden from Players are named to the GM only.
 */
function areasEntered(token: TokenLike, positions: Data[]): string[] {
  const document = token.document as never;
  const [start, ...rest] = positions;
  const visible = (region: {visibility?: number}) => globals.game.user?.isGM || (region.visibility === globals.CONST.REGION_VISIBILITY.ALWAYS);
  const cover = areaCovers as unknown as (flag: unknown, token: unknown, options: {position: Data}) => boolean;
  return (sceneAreas((token.document.parent ?? {regions: []}) as never) as unknown as Array<{region: {name?: string; visibility?: number};
    flag: {persistence?: {triggers?: unknown[]}}}>).filter(({region, flag}) => visible(region) && (flag.persistence?.triggers?.length ?? 0)
      && (!start || !cover(flag, document, {position: start}))
      && rest.some(position => cover(flag, document, {position}))).map(({region}) => region.name ?? "?");
}

/**
 * The hostile creatures around a dragged Token and where they stand: the label is redrawn at each mouse move, so they are
 * kept until a rule moves (a Token moved, a creature prepared: WildPathActor's rules tick).
 */
const HOSTILES = new WeakMap<object, {version: number; observers: Observer[]; footprints: Map<string, MovementObserver>}>();
function hostilesAround(document: TokenDocumentLike) {
  const version = rulesVersion();
  const kept = HOSTILES.get(document);
  if ( kept?.version === version ) return kept;
  const observers = (globals.game.wildpath?.reactionServices?.({scene: document.parent, token: document})?.movement?.observers ?? [])
    .filter(observer => observer.context?.hostile);
  const adapter = createFoundryV14TacticalGridAdapter({scene: document.parent as never});
  const footprints = new Map<string, MovementObserver>(observers.flatMap(observer => {
    const result = adapter.tokenToFootprint(observer.token as never, {position: observer.token.toObject(true)}) as
      {ok: boolean; footprint?: TokenGridFootprint};
    return result.ok && result.footprint ? [[observer.id, {id: observer.id, footprint: result.footprint, reachFields: observer.reachFields}]] as const : [];
  }));
  const entry = {version, observers, footprints};
  HOSTILES.set(document, entry);
  return entry;
}

/** The hostile creatures, still with their Reaction, whose reach the path leaves. Hidden ones only for the GM. */
function opportunityThreats(token: TokenLike, positions: Data[]): string[] {
  const document = token.document;
  const hostiles = hostilesAround(document);
  const observers = hostiles.observers.filter(observer =>
    (Number((observer.token.actor?.system as {resources?: {reaction?: {value?: number}}} | undefined)?.resources?.reaction?.value) > 0)
      && (globals.game.user?.isGM || (!observer.token.hidden && (observer.token.object?.visible !== false))));
  if ( !observers.length ) return [];
  const adapter = createFoundryV14TacticalGridAdapter({scene: document.parent as never});
  const path = positions.flatMap(position => {
    const result = adapter.tokenToFootprint(document as never, {position}) as {ok: boolean; footprint?: TokenGridFootprint};
    return result.ok && result.footprint ? [result.footprint] : [];
  });
  const footprints = observers.flatMap(observer => hostiles.footprints.get(observer.id) ?? []);
  const ids = new Set(leftBehind(path, footprints));
  return observers.filter(observer => ids.has(observer.id)).map(observer => observer.token.name ?? "?");
}

/** Use the WildPath Token ruler (at init). */
export function registerTokenRuler() {
  const {TokenRuler} = globals.foundry.canvas.placeables.tokens;
  class WildPathTokenRuler extends TokenRuler {
    static WAYPOINT_LABEL_TEMPLATE = "systems/wildpath/templates/hud/waypoint-label.hbs";

    override _getWaypointLabelContext(waypoint: Waypoint, state: object) {
      const context = super._getWaypointLabelContext(waypoint, state);
      if ( !context || waypoint.next ) return context;
      const {i18n} = globals.game;
      const value = this.token.actor?.system?.resources?.movement?.value;
      const left = Number.isFinite(value) && Number.isFinite(waypoint.measurement.cost) ? value! - waypoint.measurement.cost : null;
      const positions = pathPositions(this.token, waypoint);
      const threats = opportunityThreats(this.token, positions);
      const areas = areasEntered(this.token, positions);
      return {...context, wildpath: {
        ...(left === null ? {} : {left: left < 0 ? i18n.localize("WILDPATH.RULER.Over")
          : i18n.format("WILDPATH.RULER.Left", {distance: Math.round(left * 100) / 100, units: globals.canvas.grid.units}), over: left < 0}),
        threats: [...threats.map(name => i18n.format("WILDPATH.RULER.Threat", {name})),
          ...areas.map(name => i18n.format("WILDPATH.RULER.Area", {name}))]}};
    }
  }
  globals.CONFIG.Token.rulerClass = WildPathTokenRuler;
}
