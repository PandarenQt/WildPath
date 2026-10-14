import {createFoundryV14TacticalGridAdapter} from "../adapters/foundry-v14-tactical-grid-adapter.mjs";
import {observersLeftBehind} from "../helpers/movement-transition.mjs";
import type {MovementObserver} from "../helpers/movement-transition.mjs";
import type {TokenGridFootprint} from "../types/contracts.js";

/**
 * Movement that warns (after Baldur's Gate 3): a dragged Token's destination label also shows the movement it would
 * have left, and each hostile creature whose reach the path leaves while it still has its Reaction (an Opportunity
 * Attack). The reactors are the production reaction provider's own observers, and the reach relations are the
 * authority's (`movementTransitionRelations`), sampled at each grid step of the path.
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
  game: {user?: {isGM?: boolean}; i18n: {format(key: string, data: Data): string; localize(key: string): string};
    wildpath?: {reactionServices?(context: Data): {movement?: {observers?: Observer[]}}}};
};
const globals = globalThis as unknown as Globals;
const leftBehind = observersLeftBehind as unknown as (path: TokenGridFootprint[], observers: MovementObserver[]) => string[];

/** The hostile creatures, still with their Reaction, whose reach the path to `last` leaves. Hidden ones only for the GM. */
function opportunityThreats(token: TokenLike, last: Waypoint): string[] {
  const document = token.document;
  const observers = (globals.game.wildpath?.reactionServices?.({scene: document.parent, token: document})?.movement?.observers ?? [])
    .filter(observer => observer.context?.hostile
      && (Number((observer.token.actor?.system as {resources?: {reaction?: {value?: number}}} | undefined)?.resources?.reaction?.value) > 0)
      && (globals.game.user?.isGM || (!observer.token.hidden && (observer.token.object?.visible !== false))));
  if ( !observers.length ) return [];
  const adapter = createFoundryV14TacticalGridAdapter({scene: document.parent as never});
  const source = document.toObject(true);
  const footprintAt = (position: {x: number; y: number}) => {
    const result = adapter.tokenToFootprint(document as never, {position: {...source, ...token.getSnappedPosition(position)}}) as
      {ok: boolean; footprint?: TokenGridFootprint};
    return result.ok ? result.footprint ?? null : null;
  };
  // The path's waypoints, then each grid step between them.
  const waypoints: Waypoint[] = [];
  for ( let waypoint: Waypoint | null | undefined = last; waypoint; waypoint = waypoint.previous ) waypoints.unshift(waypoint);
  const size = globals.canvas.grid.size;
  const path: TokenGridFootprint[] = [];
  waypoints.forEach((waypoint, index) => {
    const from = waypoints[index - 1] ?? waypoint;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(waypoint.x - from.x), Math.abs(waypoint.y - from.y)) / size));
    for ( let step = index ? 1 : 0; step <= steps; step++ ) {
      const footprint = footprintAt({x: from.x + ((waypoint.x - from.x) * step / steps), y: from.y + ((waypoint.y - from.y) * step / steps)});
      if ( footprint ) path.push(footprint);
    }
  });
  const footprints: MovementObserver[] = observers.flatMap(observer => {
    const result = adapter.tokenToFootprint(observer.token as never, {position: observer.token.toObject(true)}) as
      {ok: boolean; footprint?: TokenGridFootprint};
    return result.ok && result.footprint ? [{id: observer.id, footprint: result.footprint, reachFields: observer.reachFields}] : [];
  });
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
      const threats = opportunityThreats(this.token, waypoint);
      return {...context, wildpath: {
        ...(left === null ? {} : {left: left < 0 ? i18n.localize("WILDPATH.RULER.Over")
          : i18n.format("WILDPATH.RULER.Left", {distance: Math.round(left * 100) / 100, units: globals.canvas.grid.units}), over: left < 0}),
        threats: threats.map(name => i18n.format("WILDPATH.RULER.Threat", {name}))}};
    }
  }
  globals.CONFIG.Token.rulerClass = WildPathTokenRuler;
}
