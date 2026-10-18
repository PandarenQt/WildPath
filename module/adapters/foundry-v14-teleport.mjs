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
/** After an Action that teleports its creature (`options.teleport`: its Token and where it lands), on the active GM. */
export function createFoundryTeleports({ game }) {
    async function afterResolution({ options }) {
        const teleport = options?.teleport;
        if (!teleport || !game.user?.id || (game.users?.activeGM?.id !== game.user.id))
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
