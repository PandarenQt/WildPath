import { createFoundryV14TacticalGridAdapter } from "../adapters/foundry-v14-tactical-grid-adapter.mjs";
import { observersLeftBehind } from "../helpers/movement-transition.mjs";
;
const globals = globalThis;
const leftBehind = observersLeftBehind;
/** The hostile creatures, still with their Reaction, whose reach the path to `last` leaves. Hidden ones only for the GM. */
function opportunityThreats(token, last) {
    const document = token.document;
    const observers = (globals.game.wildpath?.reactionServices?.({ scene: document.parent, token: document })?.movement?.observers ?? [])
        .filter(observer => observer.context?.hostile
        && (Number(observer.token.actor?.system?.resources?.reaction?.value) > 0)
        && (globals.game.user?.isGM || (!observer.token.hidden && (observer.token.object?.visible !== false))));
    if (!observers.length)
        return [];
    const adapter = createFoundryV14TacticalGridAdapter({ scene: document.parent });
    const source = document.toObject(true);
    const footprintAt = (position) => {
        const result = adapter.tokenToFootprint(document, { position: { ...source, ...token.getSnappedPosition(position) } });
        return result.ok ? result.footprint ?? null : null;
    };
    // The path's waypoints, then each grid step between them.
    const waypoints = [];
    for (let waypoint = last; waypoint; waypoint = waypoint.previous)
        waypoints.unshift(waypoint);
    const size = globals.canvas.grid.size;
    const path = [];
    waypoints.forEach((waypoint, index) => {
        const from = waypoints[index - 1] ?? waypoint;
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(waypoint.x - from.x), Math.abs(waypoint.y - from.y)) / size));
        for (let step = index ? 1 : 0; step <= steps; step++) {
            const footprint = footprintAt({ x: from.x + ((waypoint.x - from.x) * step / steps), y: from.y + ((waypoint.y - from.y) * step / steps) });
            if (footprint)
                path.push(footprint);
        }
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
            const threats = opportunityThreats(this.token, waypoint);
            return { ...context, wildpath: {
                    ...(left === null ? {} : { left: left < 0 ? i18n.localize("WILDPATH.RULER.Over")
                            : i18n.format("WILDPATH.RULER.Left", { distance: Math.round(left * 100) / 100, units: globals.canvas.grid.units }), over: left < 0 }),
                    threats: threats.map(name => i18n.format("WILDPATH.RULER.Threat", { name }))
                } };
        }
    }
    globals.CONFIG.Token.rulerClass = WildPathTokenRuler;
}
