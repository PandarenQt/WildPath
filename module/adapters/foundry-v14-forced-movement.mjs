import { gmNotice } from "../helpers/gm-notice.mjs";
/** The largest Token, in fields, of each size a push may be limited to ("a Large or smaller creature"). */
const LARGEST = Object.freeze({ tiny: 0.5, small: 1, medium: 1, large: 2, huge: 3, gargantuan: 4 });
const key = (offset) => `${offset.i}.${offset.j}`;
/** Who an Action pushes: its failed saves (its successes, `on: "success"`), else its hits. */
function pushedTargets(state, definition) {
    const results = (state.results ?? {});
    if (definition.save)
        return (results.saveResolution?.results ?? [])
            .filter(entry => entry.ok && (entry.success === (definition.push?.on === "success")))
            .map(entry => entry.target);
    if (definition.attack)
        return (results.attackResolution?.hits ?? []).map(entry => entry.target);
    return [];
}
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
        const fields = Math.floor((Number(spec.distance) || 0) / (Number(scene.grid.distance) || 5));
        const largest = spec.maxSize ? (LARGEST[spec.maxSize] ?? Infinity) : Infinity;
        const from = source.getCenterPoint();
        const distanceOf = (token) => Math.hypot(token.getCenterPoint().x - from.x, token.getCenterPoint().y - from.y);
        const tokens = pushedTargets(state, definition ?? {}).map(target => scene.tokens.get(String(target?.tokenId ?? "")))
            .filter((token) => Boolean(token) && (token !== source)
            && (Math.max(Number(token.width) || 1, Number(token.height) || 1) <= largest))
            // The farthest moves first when pushed, the nearest when pulled, so none blocks another needlessly.
            .sort((a, b) => (spec.toward ? 1 : -1) * (distanceOf(a) - distanceOf(b)));
        const moved = [];
        for (const token of tokens) {
            const others = new Set([...scene.tokens].filter(other => other !== token)
                .flatMap(other => (other.getOccupiedGridSpaceOffsets?.() ?? []).map(key)));
            // shortcut: walls are tested through the Token's placeable, so only when the GM is viewing its Scene.
            const blocked = (origin, destination, position) => !(scene.dimensions?.sceneRect?.contains(destination.x, destination.y) ?? true)
                || Boolean(token.object?.checkCollision?.(destination, { origin, type: "move", mode: "any" }))
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
