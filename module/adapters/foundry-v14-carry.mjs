import { AUTOMATION_EVENT_TYPES } from "../helpers/automation-events.mjs";
import { effectsFrom } from "../helpers/effect-sources.mjs";
import { parseEntityRef } from "../helpers/entity-refs.mjs";
import { createFoundryV14TacticalGridAdapter } from "./foundry-v14-tactical-grid-adapter.mjs";
import { forcedStepBlocker } from "./foundry-v14-forced-movement.mjs";
const ENDS = new Set([AUTOMATION_EVENT_TYPES.MOVEMENT_COMPLETED, AUTOMATION_EVENT_TYPES.MOVEMENT_INTERRUPTED]);
const key = (offset) => `${offset.i}.${offset.j}`;
export function createFoundryCarry({ game }) {
    const isActiveGM = () => Boolean(game.user?.id) && (game.users?.activeGM?.id === game.user?.id);
    async function onMovementEvent(event) {
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
        const occupied = new Set(carrierSpace.map(offset => key(offset)));
        const moved = [];
        for (const token of carried) {
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
    return { onMovementEvent };
}
