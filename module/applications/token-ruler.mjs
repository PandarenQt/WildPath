import { createFoundryV14TacticalGridAdapter } from "../adapters/foundry-v14-tactical-grid-adapter.mjs";
import { observersLeftBehind } from "../helpers/movement-transition.mjs";
import { areaCovers, sceneAreas } from "../adapters/foundry-v14-persistent-areas.mjs";
;
const globals = globalThis;
const leftBehind = observersLeftBehind;
/** The Token's positions along the path to `last`: its waypoints, and each grid step between them, from the start. */
function pathPositions(token, last) {
    const source = token.document.toObject(true);
    const waypoints = [];
    for (let waypoint = last; waypoint; waypoint = waypoint.previous)
        waypoints.unshift(waypoint);
    const size = globals.canvas.grid.size;
    return waypoints.flatMap((waypoint, index) => {
        const from = waypoints[index - 1] ?? waypoint;
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(waypoint.x - from.x), Math.abs(waypoint.y - from.y)) / size));
        return Array.from({ length: steps + (index ? 0 : 1) }, (_, offset) => offset + (index ? 1 : 0)).map(step => ({ ...source,
            ...token.getSnappedPosition({ x: from.x + ((waypoint.x - from.x) * step / steps), y: from.y + ((waypoint.y - from.y) * step / steps) }) }));
    });
}
/**
 * The lasting areas that act on a creature (with triggers: Burning Ground, not a Daylight) that the path walks into,
 * not covering its start. Areas hidden from Players are named to the GM only.
 */
function areasEntered(token, positions) {
    const document = token.document;
    const [start, ...rest] = positions;
    const visible = (region) => globals.game.user?.isGM || (region.visibility === globals.CONST.REGION_VISIBILITY.ALWAYS);
    const cover = areaCovers;
    return sceneAreas((token.document.parent ?? { regions: [] })).filter(({ region, flag }) => visible(region) && (flag.persistence?.triggers?.length ?? 0)
        && (!start || !cover(flag, document, { position: start }))
        && rest.some(position => cover(flag, document, { position }))).map(({ region }) => region.name ?? "?");
}
/** The hostile creatures, still with their Reaction, whose reach the path leaves. Hidden ones only for the GM. */
function opportunityThreats(token, positions) {
    const document = token.document;
    const observers = (globals.game.wildpath?.reactionServices?.({ scene: document.parent, token: document })?.movement?.observers ?? [])
        .filter(observer => observer.context?.hostile
        && (Number(observer.token.actor?.system?.resources?.reaction?.value) > 0)
        && (globals.game.user?.isGM || (!observer.token.hidden && (observer.token.object?.visible !== false))));
    if (!observers.length)
        return [];
    const adapter = createFoundryV14TacticalGridAdapter({ scene: document.parent });
    const path = positions.flatMap(position => {
        const result = adapter.tokenToFootprint(document, { position });
        return result.ok && result.footprint ? [result.footprint] : [];
    });
    const footprints = observers.flatMap(observer => {
        const result = adapter.tokenToFootprint(observer.token, { position: observer.token.toObject(true) });
        return result.ok && result.footprint ? [{ id: observer.id, footprint: result.footprint, reachFields: observer.reachFields }] : [];
    });
    const ids = new Set(leftBehind(path, footprints));
    return observers.filter(observer => ids.has(observer.id)).map(observer => observer.token.name ?? "?");
}
/** Use the WildPath Token ruler (at init). */
export function registerTokenRuler() {
    const { TokenRuler } = globals.foundry.canvas.placeables.tokens;
    class WildPathTokenRuler extends TokenRuler {
        static WAYPOINT_LABEL_TEMPLATE = "systems/wildpath/templates/hud/waypoint-label.hbs";
        _getWaypointLabelContext(waypoint, state) {
            const context = super._getWaypointLabelContext(waypoint, state);
            if (!context || waypoint.next)
                return context;
            const { i18n } = globals.game;
            const value = this.token.actor?.system?.resources?.movement?.value;
            const left = Number.isFinite(value) && Number.isFinite(waypoint.measurement.cost) ? value - waypoint.measurement.cost : null;
            const positions = pathPositions(this.token, waypoint);
            const threats = opportunityThreats(this.token, positions);
            const areas = areasEntered(this.token, positions);
            return { ...context, wildpath: {
                    ...(left === null ? {} : { left: left < 0 ? i18n.localize("WILDPATH.RULER.Over")
                            : i18n.format("WILDPATH.RULER.Left", { distance: Math.round(left * 100) / 100, units: globals.canvas.grid.units }), over: left < 0 }),
                    threats: [...threats.map(name => i18n.format("WILDPATH.RULER.Threat", { name })),
                        ...areas.map(name => i18n.format("WILDPATH.RULER.Area", { name }))]
                } };
        }
    }
    globals.CONFIG.Token.rulerClass = WildPathTokenRuler;
}
