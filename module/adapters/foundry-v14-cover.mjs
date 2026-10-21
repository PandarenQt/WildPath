import { sceneCollision } from "./foundry-v14-walls.mjs";
/** What each degree adds to AC and Dexterity (Agility) saves. */
export const COVER_BONUS = Object.freeze({ none: 0, half: 2, threeQuarters: 5, total: 0 });
/** Inset `point` toward `center` by a pixel, so a line along a wall's end or a grid edge is not counted as blocked. */
const inset = (point, center) => {
    const dx = center.x - point.x;
    const dy = center.y - point.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: point.x + (dx / length), y: point.y + (dy / length) };
};
const centerOf = (points) => ({ x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length });
/** The corners of each space `token` occupies, each inset toward its space's center. */
function spaceCorners(token, scene) {
    return (token.getOccupiedGridSpaceOffsets?.() ?? []).map(offset => {
        const corners = scene.grid.getVertices(offset);
        const center = centerOf(corners);
        return corners.map(corner => inset(corner, center));
    });
}
/** Whether the segment a-b passes through any of `spaces` (another creature's squares, as polygons). */
function crosses(a, b, spaces) {
    const segments = (polygon) => polygon.map((point, index) => [point, polygon[(index + 1) % polygon.length]]);
    const intersects = (p, q, r, s) => {
        const d = (q.x - p.x) * (s.y - r.y) - (q.y - p.y) * (s.x - r.x);
        if (!d)
            return false;
        const t = ((r.x - p.x) * (s.y - r.y) - (r.y - p.y) * (s.x - r.x)) / d;
        const u = ((r.x - p.x) * (q.y - p.y) - (r.y - p.y) * (q.x - p.x)) / d;
        return (t > 0) && (t < 1) && (u >= 0) && (u <= 1);
    };
    return spaces.some(polygon => segments(polygon).some(([r, s]) => intersects(a, b, r, s)));
}
/**
 * The cover `target` has from `source` (a Token, its corners) or from `origin` (an area's point of origin), on its
 * Scene. `collides` tests a line against walls that block sight (Foundry's `polygonBackends.sight.testCollision`).
 */
export function coverBetween({ source = null, origin = null, target, collides }) {
    const scene = target.parent;
    if (!scene)
        return "none";
    const level = scene.levels?.get?.(String(target._source?.level ?? target.level ?? ""));
    const from = origin ? [origin] : (source ? spaceCorners(source, scene).flat() : []);
    const spaces = spaceCorners(target, scene);
    if (!from.length || !spaces.length)
        return "none";
    const blocked = (a, b) => Boolean(collides(a, b, { type: "sight", mode: "any", ...(level ? { level } : {}) }));
    // The attacker picks its best corner, and the target space it sees best: the fewest lines blocked.
    let best = { share: Infinity, from: from[0], corners: spaces[0] };
    for (const a of from) {
        for (const corners of spaces) {
            const share = corners.filter(corner => blocked(a, corner)).length / corners.length;
            if (share < best.share)
                best = { share, from: a, corners };
        }
    }
    const walls = (best.share === 0) ? "none" : (best.share <= 0.5) ? "half" : (best.share < 1) ? "threeQuarters" : "total";
    if (walls !== "none")
        return walls;
    // A creature between them (not either of them) gives Half Cover.
    const others = [...scene.tokens].filter(token => (token.id !== target.id) && (token.id !== source?.id))
        .flatMap(token => spaceCorners(token, scene));
    return best.corners.some(corner => crosses(best.from, corner, others)) ? "half" : "none";
}
/**
 * The sight-wall test for `coverBetween` on `scene`, whether or not the canvas shows it (foundry-v14-walls.mts); null
 * with no Scene.
 */
export function foundrySightCollision(scene) {
    if (!scene)
        return null;
    const collides = sceneCollision(scene);
    return (a, b, options) => collides(a, b, { ...options, type: "sight" });
}
