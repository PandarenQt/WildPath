import { AUTOMATION_EVENT_TYPES } from "../helpers/automation-events.mjs";
import { effectsFrom } from "../helpers/effect-sources.mjs";
import { parseEntityRef } from "../helpers/entity-refs.mjs";
import { createFoundryV14TacticalGridAdapter } from "./foundry-v14-tactical-grid-adapter.mjs";
import { footprintDistance } from "../helpers/grid-footprints.mjs";
import { forcedStepBlocker } from "./foundry-v14-forced-movement.mjs";
const ENDS = new Set([AUTOMATION_EVENT_TYPES.MOVEMENT_COMPLETED, AUTOMATION_EVENT_TYPES.MOVEMENT_INTERRUPTED]);
const key = (offset) => `${offset.i}.${offset.j}`;
export function createFoundryCarry({ game }) {
    const isActiveGM = () => Boolean(game.user?.id) && (game.users?.activeGM?.id === game.user?.id);
    // One carry at a time: each reads its creatures where the one before left them (a monk's quick second move).
    let queue = Promise.resolve();
    function onMovementEvent(event) {
        const run = queue.then(() => carry(event), () => carry(event));
        queue = run.catch(() => undefined);
        return run;
    }
    async function carry(event) {
        const data = event?.data;
        // Only its own walking carries anyone: the carried creature's forced move never starts a chain.
        if (!ENDS.has(String(event?.type)) || (data?.movementKind !== "voluntary") || !isActiveGM())
            return [];
        const ref = parseEntityRef(data.tokenRef);
        const scene = ref.ok ? game.scenes?.get(String(ref.scope)) : undefined;
        const carrier = scene?.tokens.get(String(ref.id));
        const anchors = data.completedAnchors ?? [];
        if (!scene || !carrier?.actor || (anchors.length < 2))
            return [];
        if (Array.isArray(carrier.actor.system?.aboard))
            return rideAlong(scene, carrier, data);
        const carried = [...scene.tokens].filter(token => (token !== carrier) && effectsFrom(token.actor, carrier.actor, game)
            .some((effect) => effect.statuses?.has("carried")));
        if (!carried.length)
            return [];
        // A gridless Scene has no tactical anchors to follow: nothing is carried there.
        const adapter = createFoundryV14TacticalGridAdapter({ scene });
        const points = anchors.map(anchor => adapter.fieldToCenterPoint(anchor).point);
        const carrierSpace = (data.actualDestination?.footprint?.fields ?? []).map(field => adapter.fieldToOffset(field).offset);
        if (points.some(point => !point) || carrierSpace.some(offset => !offset))
            return [];
        const [start] = points;
        // Only a creature still beside its carrier where the move began: one left behind (a wall stopped it, its carrier was
        // pushed or teleported) is no longer moved with it.
        const origin = data.origin?.footprint;
        const besideOrigin = (token) => {
            const footprint = adapter.tokenToFootprint(token).footprint;
            return Boolean(origin && footprint) && ((footprintDistance(origin, footprint)
                * (Number(scene.grid?.distance) || 5)) <= 5);
        };
        const occupied = new Set(carrierSpace.map(offset => key(offset)));
        const moved = [];
        for (const token of carried.filter(besideOrigin)) {
            // It passes through its carrier's spaces on the way, but never stops on the one the carrier ends in.
            const blocked = forcedStepBlocker(scene, token, { except: [carrier] });
            const waypoints = [];
            let at = { x: token.x, y: token.y };
            for (const point of points.slice(1)) {
                const next = { x: token.x + point.x - start.x, y: token.y + point.y - start.y };
                if (blocked(token.getCenterPoint(at), token.getCenterPoint(next), next))
                    break;
                waypoints.push(next);
                at = next;
            }
            const onCarrier = (position) => (token.getOccupiedGridSpaceOffsets?.(position) ?? []).some(offset => occupied.has(key(offset)));
            while (waypoints.length && onCarrier(waypoints.at(-1)))
                waypoints.pop();
            const last = waypoints.at(-1);
            if (!last)
                continue;
            await token.update({ ...last }, { movement: { [token.id]: { waypoints, showRuler: false } }, wildpath: { movementKind: "forced" } });
            moved.push(token);
        }
        return moved;
    }
    /** A vehicle's riders: each Token standing wholly on its starting spaces, moved by the vehicle's own offset. */
    async function rideAlong(scene, vehicle, data) {
        const adapter = createFoundryV14TacticalGridAdapter({ scene });
        const anchors = data.completedAnchors ?? [];
        const [start, end] = [anchors[0], anchors.at(-1)].map(anchor => adapter.fieldToCenterPoint(anchor).point);
        const deck = new Set((data.origin?.footprint?.fields ?? []).map(field => `${field.x}.${field.y}`));
        if (!start || !end || !deck.size)
            return [];
        const riders = [...scene.tokens].filter(token => {
            if (token === vehicle)
                return false;
            const fields = (adapter.tokenToFootprint(token).footprint?.fields ?? []);
            return fields.length > 0 && fields.every(field => deck.has(`${field.x}.${field.y}`));
        });
        // The one furthest along the way first, so none lands where another still stands.
        const ahead = (token) => (token.x * (end.x - start.x)) + (token.y * (end.y - start.y));
        const moved = [];
        for (const token of riders.sort((a, b) => ahead(b) - ahead(a))) {
            const to = { x: token.x + end.x - start.x, y: token.y + end.y - start.y };
            // One jump, so a teleport's kind: a forced move must walk adjacent steps (found live: the jump was refused).
            await token.update(to, { movement: { [token.id]: { waypoints: [{ ...to, action: "blink" }], showRuler: false } }, wildpath: { movementKind: "teleport" } });
            moved.push(token);
        }
        return moved;
    }
    return { onMovementEvent };
}
