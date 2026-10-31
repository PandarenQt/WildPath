import { sceneCollision } from "./foundry-v14-walls.mjs";
import { gmNotice } from "../helpers/gm-notice.mjs";
import { pushable, pushedTargets } from "../helpers/forced-movement.mjs";
import { foundryTokenCreatureSize } from "./foundry-v14-tactical-grid-adapter.mjs";
const key = (offset) => `${offset.i}.${offset.j}`;
/**
 * Where `token` ends up, pushed `fields` fields from `from` (or pulled toward it). Each step is one field along the
 * line between them: on a square grid the longer axis moves a whole field, so a diagonal push crosses diagonals.
 */
export function forcedDestination(token, from, fields, { toward = false, blocked }) {
    const scene = token.parent;
    const [sizeX, sizeY] = [scene.grid.sizeX ?? scene.grid.size ?? 100, scene.grid.sizeY ?? scene.grid.size ?? 100];
    const centre = token.getCenterPoint();
    const [dx, dy] = toward ? [from.x - centre.x, from.y - centre.y] : [centre.x - from.x, centre.y - from.y];
    const scale = scene.grid.isSquare ? Math.max(Math.abs(dx) / sizeX, Math.abs(dy) / sizeY) : Math.hypot(dx / sizeX, dy / sizeY);
    if (!scale)
        return null;
    let position = { x: token.x, y: token.y };
    for (let step = 1; step <= fields; step++) {
        const next = token.getSnappedPosition({ x: token.x + ((dx / scale) * step), y: token.y + ((dy / scale) * step) });
        if ((next.x === position.x) && (next.y === position.y))
            continue;
        if (blocked(token.getCenterPoint(position), token.getCenterPoint(next), next))
            break;
        position = next;
    }
    return ((position.x === token.x) && (position.y === token.y)) ? null : position;
}
export function createFoundryForcedMovement({ game, logger = console, fromUuid }) {
    const isActiveGM = () => Boolean(game.user?.id) && (game.users?.activeGM?.id === game.user?.id);
    async function afterResolution({ state }) {
        const definition = state?.actionDefinition;
        // Its own push, or a reaction's rider's on it (Forceful Blow: the creature its attack hit).
        const spec = definition?.push ?? (state?.input?.riderPush);
        if (!spec || !state || !isActiveGM())
            return [];
        const source = await fromUuid(String(state.source?.tokenRef ?? ""));
        const scene = source?.parent ?? null;
        if (!source || !scene) {
            gmNotice("WILDPATH.NOTICE.PushNoToken", {}, undefined, { logger });
            return [];
        }
        const gridDistance = Number(scene.grid.distance) || 5;
        const reduction = state.input?.pushReduction ?? {};
        const from = source.getCenterPoint();
        const distanceOf = (token) => Math.hypot(token.getCenterPoint().x - from.x, token.getCenterPoint().y - from.y);
        const tokens = pushedTargets(state, definition ?? {}).map(target => scene.tokens.get(String(target?.tokenId ?? "")))
            .filter((token) => Boolean(token) && (token !== source)
            // The size the before-push window judged (actor size on a 1x1 Token), so nobody asked is left behind, or moved unasked.
            && pushable(foundryTokenCreatureSize(token), spec.maxSize))
            // The farthest moves first when pushed, the nearest when pulled, so none blocks another needlessly.
            .sort((a, b) => (spec.toward ? 1 : -1) * (distanceOf(a) - distanceOf(b)));
        const moved = [];
        const collides = sceneCollision(scene);
        for (const token of tokens) {
            const fields = Math.floor(Math.max((Number(spec.distance) || 0) - (Number(reduction[token.id]) || 0), 0) / gridDistance);
            if (!fields)
                continue;
            const others = new Set([...scene.tokens].filter(other => other !== token)
                .flatMap(other => (other.getOccupiedGridSpaceOffsets?.() ?? []).map(key)));
            // Walls stop it on any Scene, viewed or not (foundry-v14-walls.mts).
            const blocked = (origin, destination, position) => !(scene.dimensions?.sceneRect?.contains(destination.x, destination.y) ?? true)
                || Boolean(collides(origin, destination, { type: "move" }))
                || (token.getOccupiedGridSpaceOffsets?.(position) ?? []).some(offset => others.has(key(offset)));
            const destination = forcedDestination(token, from, fields, { toward: spec.toward === true, blocked });
            if (!destination)
                continue;
            await token.update({ ...destination }, { wildpath: { movementKind: "forced" } });
            moved.push(token);
        }
        return moved;
    }
    return { afterResolution };
}
