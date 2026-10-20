const key = (offset) => `${offset.i},${offset.j}`;
/**
 * Where `token` lands when teleported to the field at `point`, its top-left there: refused beyond `distance` feet
 * (center to center), off the Scene, or onto another Token's space.
 */
export function teleportDestination({ token, point, distance }) {
    const scene = token?.parent;
    if (!token || !scene)
        return { ok: false, code: "NoToken" };
    const position = scene.grid.getTopLeftPoint(scene.grid.getOffset(point));
    const center = token.getCenterPoint(position);
    if (!(scene.dimensions?.sceneRect?.contains(center.x, center.y) ?? true))
        return { ok: false, code: "OffScene" };
    const feet = scene.grid.measurePath([token.getCenterPoint(), center]).distance;
    if (!(feet <= (Number(distance) || 0)))
        return { ok: false, code: "OutOfRange" };
    const others = new Set([...scene.tokens].filter(other => other !== token)
        .flatMap(other => (other.getOccupiedGridSpaceOffsets?.() ?? []).map(key)));
    if ((token.getOccupiedGridSpaceOffsets?.(position) ?? []).some(offset => others.has(key(offset))))
        return { ok: false, code: "Occupied" };
    return { ok: true, position: { x: position.x, y: position.y } };
}
/**
 * The free space within 5 feet of `nextTo` nearest `token` (Protective Bond: "teleport to an unoccupied space within 5
 * feet of the first creature"): the fields around the spaces `nextTo` occupies, or null when none is free.
 */
export function spaceBeside(token, nextTo) {
    const scene = token.parent;
    if (!scene)
        return null;
    const occupied = nextTo.getOccupiedGridSpaceOffsets?.() ?? [];
    const taken = new Set(occupied.map(key));
    const around = new Map();
    for (const { i, j } of occupied)
        for (const di of [-1, 0, 1])
            for (const dj of [-1, 0, 1]) {
                const offset = { i: i + di, j: j + dj };
                if (!taken.has(key(offset)))
                    around.set(key(offset), offset);
            }
    const from = token.getCenterPoint();
    const landings = [...around.values()].map(offset => teleportDestination({ token, point: scene.grid.getTopLeftPoint(offset), distance: Infinity }))
        .flatMap(result => (result.ok ? [result.position] : []));
    const far = (point) => scene.grid.measurePath([from, token.getCenterPoint(point)]).distance;
    return landings.sort((a, b) => far(a) - far(b))[0] ?? null;
}
/**
 * After an Action that teleports its creature (`options.teleport`: its Token and where it lands), or a reaction's rider
 * that moves its creature beside the one it protects (`state.input.riderTeleport`), on the active GM.
 */
export function createFoundryTeleports({ game }) {
    async function afterResolution({ options, state }) {
        if (!game.user?.id || (game.users?.activeGM?.id !== game.user.id))
            return null;
        const beside = state?.input?.riderTeleport;
        if (beside) {
            const scene = [...(game.scenes ?? [])].find(each => each.tokens.get?.(beside.tokenId));
            const mover = scene?.tokens.get?.(beside.tokenId);
            const protectedToken = scene?.tokens.get?.(beside.nextTo);
            const point = (mover && protectedToken) ? spaceBeside(mover, protectedToken) : null;
            if (mover && point)
                await mover.update(point, { movement: { [mover.id]: { waypoints: [{ ...point, action: "blink" }], showRuler: false } },
                    wildpath: { movementKind: "teleport" } });
        }
        const teleport = options?.teleport;
        if (!teleport)
            return null;
        const token = game.scenes?.get(teleport.sceneId)?.tokens.get?.(teleport.tokenId);
        if (!token)
            return null;
        const { x, y } = teleport;
        await token.update({ x, y }, { movement: { [token.id]: { waypoints: [{ x, y, action: "blink" }], showRuler: false } },
            wildpath: { movementKind: "teleport" } });
        return token;
    }
    return { afterResolution };
}
