/**
 * Sunlight (Sunlight Sensitivity, a Vampire's Regeneration): a Token stands in sunlight when its Scene is tagged as
 * sunlit (`flags.wildpath.sunlight`, daytime outdoors), or a light tagged as sunlight reaches it. Such a light is an
 * ambient light or a Token's own light: a Daylight spell, a sunbeam through a window. On the viewed Scene Foundry's
 * own light source decides (walls and elevation included); elsewhere the light's radius does.
 */
const tagged = (document) => document.flags?.wildpath?.sunlight === true;
/** Whether `token` stands in sunlight. */
export function inSunlight(token, { canvas = globalThis.canvas } = {}) {
    const scene = token?.parent;
    if (!token || !scene)
        return false;
    if (tagged(scene))
        return true;
    const size = Number(scene.grid?.size) || 100;
    const pixelsPerUnit = size / (Number(scene.grid?.distance) || 5);
    // A Token's center from its corner and size; an ambient light's position is its center.
    const centerOf = (document) => document.object?.center ?? ((document.width == null)
        ? { x: Number(document.x) || 0, y: Number(document.y) || 0 }
        : { x: (Number(document.x) || 0) + (Number(document.width) * size / 2), y: (Number(document.y) || 0) + ((Number(document.height) || 1) * size / 2) });
    const point = { ...centerOf(token), elevation: Number(token.elevation) || 0 };
    const rendered = canvas?.scene === scene;
    const reaches = (light, config, source) => {
        if (!tagged(light) || light.hidden)
            return false;
        if (rendered && source?.testPoint)
            return (source.active !== false) && source.testPoint(point);
        // shortcut: off the viewed Scene, walls are not considered; the light's own radius from its position decides.
        const radius = Math.max(Number(config?.bright) || 0, Number(config?.dim) || 0) * pixelsPerUnit;
        const center = centerOf(light);
        return (radius > 0) && (Math.hypot(point.x - center.x, point.y - center.y) <= radius);
    };
    return [...(scene.lights ?? [])].some(light => reaches(light, light.config, light.object?.lightSource))
        || [...(scene.tokens ?? [])].some(other => (other.id !== token.id) && reaches(other, other.light, other.object?.light))
        || reaches(token, token.light, token.object?.light);
}
/** What a creature's own roll's predicates see of the light it stands in: `inSunlight`. */
export function sunlightContext(token) {
    return inSunlight(token) ? { inSunlight: true } : {};
}
