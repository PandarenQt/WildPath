import { wallsBlock } from "./foundry-v14-walls.mjs";
const tagged = (document) => document.flags?.wildpath?.sunlight === true;
/**
 * Where a placed document stands, for what is there (its light, its environment): a Token's center by Foundry's own
 * shape when it can tell, else from its corner and size; an ambient light's position is its center. Always where it was
 * committed to (`_source`), never mid-animation: V14 writes each movement frame onto the Token document's own x and y,
 * so they still hold the old square when its updateToken hook fires.
 */
export function standingPoint(document, size) {
    const at = document._source ?? document;
    const elevation = Number(at.elevation) || 0;
    if (document.getCenterPoint)
        return { ...document.getCenterPoint(at), elevation };
    if (at.width == null)
        return { x: Number(at.x) || 0, y: Number(at.y) || 0, elevation };
    return { x: (Number(at.x) || 0) + (Number(at.width) * size / 2), y: (Number(at.y) || 0) + ((Number(at.height) || 1) * size / 2), elevation };
}
/**
 * Whether a light `accept`ed (an ambient light, another Token's or its own) reaches `token` on its Scene; with
 * `brightOnly`, its Bright Light (Foundry's rendered test does not tell bright from dim: its bright radius does).
 */
function lightReaches(token, scene, accept, canvas, { brightOnly = false } = {}) {
    const size = Number(scene.grid?.size) || 100;
    const pixelsPerUnit = size / (Number(scene.grid?.distance) || 5);
    const point = standingPoint(token, size);
    const rendered = canvas?.scene === scene;
    const reaches = (light, config, source) => {
        if (!accept(light, config) || light.hidden)
            return false;
        const center = standingPoint(light, size);
        const bright = (Number(config?.bright) || 0) * pixelsPerUnit;
        if (rendered && source?.testPoint)
            return (source.active !== false) && source.testPoint(point)
                && (!brightOnly || (Math.hypot(point.x - center.x, point.y - center.y) <= bright));
        // Off the viewed Scene: within the light's radius, with no wall that stops light between (foundry-v14-walls.mts).
        const radius = brightOnly ? bright : Math.max(bright, (Number(config?.dim) || 0) * pixelsPerUnit);
        return (radius > 0) && (Math.hypot(point.x - center.x, point.y - center.y) <= radius)
            && !wallsBlock(scene, center, point, { type: "light" });
    };
    return [...(scene.lights ?? [])].some(light => reaches(light, light.config, light.object?.lightSource))
        || [...(scene.tokens ?? [])].some(other => (other.id !== token.id) && reaches(other, other.light, other.object?.light))
        // Its own light (a carried torch) moves with it: by its radius (distance 0), never its drawn source, which follows
        // the animation and still sits on the old square when the move's updateToken fires.
        || reaches(token, token.light, undefined);
}
/** Whether `token` stands in sunlight. */
export function inSunlight(token, { canvas = globalThis.canvas } = {}) {
    const scene = token?.parent;
    if (!token || !scene)
        return false;
    return tagged(scene) || lightReaches(token, scene, tagged, canvas);
}
/**
 * The light `token` stands in (2024): in light, in darkness (Darkvision sees it), or in magical Darkness (only Devil's
 * Sight, Truesight or a sense other than sight). A Scene without Token vision is all light. On the viewed Scene,
 * Foundry's darkness and light sources decide (walls, elevation and global illumination included): any darkness source
 * is magical Darkness. Elsewhere a negative light's radius is magical Darkness; global illumination or a light's
 * radius is light; anywhere else is dark.
 */
export function lightAt(token, { canvas = globalThis.canvas } = {}) {
    const scene = token?.parent;
    if (!token || !scene || (scene.tokenVision === false))
        return "light";
    const effects = canvas?.effects;
    if ((canvas?.scene === scene) && effects?.testInsideDarkness && effects.testInsideLight) {
        const point = standingPoint(token, Number(scene.grid?.size) || 100);
        if (effects.testInsideDarkness(point))
            return "magicalDarkness";
        // Foundry's test still holds its own light at the old square mid-move (lightReaches): that one by its radius.
        return (effects.testInsideLight(point)
            || lightReaches(token, scene, (light, config) => (light === token) && (config?.negative !== true), undefined)) ? "light" : "dark";
    }
    if (lightReaches(token, scene, (_light, config) => config?.negative === true, canvas))
        return "magicalDarkness";
    if ((scene.environment?.globalLight?.enabled === true) || tagged(scene))
        return "light";
    return lightReaches(token, scene, (_light, config) => config?.negative !== true, canvas) ? "light" : "dark";
}
/**
 * Whether `token` stands in Bright Light (2024 Light Sensitivity): sunlight, a Scene without Token vision, bright global
 * illumination, or a light whose bright radius reaches it; never in magical Darkness.
 */
export function inBrightLight(token, { canvas = globalThis.canvas } = {}) {
    const scene = token?.parent;
    if (!token || !scene)
        return false;
    if (inSunlight(token, { canvas }) || (scene.tokenVision === false))
        return true;
    if (lightAt(token, { canvas }) === "magicalDarkness")
        return false;
    if ((scene.environment?.globalLight?.enabled === true) && (scene.environment.globalLight.bright === true))
        return true;
    return lightReaches(token, scene, (_light, config) => config?.negative !== true, canvas, { brightOnly: true });
}
/** What a creature's own roll's predicates see of the light it stands in: `inSunlight`, `inBrightLight`. */
export function sunlightContext(token) {
    return { ...(inSunlight(token) ? { inSunlight: true } : {}), ...(inBrightLight(token) ? { inBrightLight: true } : {}) };
}
