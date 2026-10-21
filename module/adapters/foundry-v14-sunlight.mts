import {wallsBlock} from "./foundry-v14-walls.mjs";

/**
 * Light at a Token. Sunlight (Sunlight Sensitivity, a Vampire's Regeneration): a Token stands in sunlight when its Scene
 * is tagged as sunlit (`flags.wildpath.sunlight`, daytime outdoors), or a light tagged as sunlight reaches it. Such a
 * light is an ambient light or a Token's own light: a Daylight spell, a sunbeam through a window. And whether it stands
 * in light, darkness or magical Darkness (`lightAt`: what can see it). On the viewed Scene Foundry's own light sources
 * decide (walls and elevation included); elsewhere a light's radius does.
 */

type Data = Record<string, unknown>;
interface Point {x: number; y: number; elevation: number}
interface LightSourceLike {active?: boolean; testPoint?(point: Point): boolean}
interface LightConfig {bright?: number; dim?: number; negative?: boolean}
interface SunlitDocument {
  id?: string; x?: number; y?: number; width?: number; height?: number; elevation?: number; hidden?: boolean;
  flags?: {wildpath?: {sunlight?: boolean}};
  config?: LightConfig; light?: LightConfig;
  object?: {center?: {x: number; y: number}; lightSource?: LightSourceLike; light?: LightSourceLike} | null;
}
interface SceneLike {
  flags?: {wildpath?: {sunlight?: boolean}}; tokenVision?: boolean; environment?: {globalLight?: {enabled?: boolean}};
  grid?: {size?: number; distance?: number};
  lights?: Iterable<SunlitDocument>; tokens?: Iterable<SunlitDocument>;
}
interface TokenLike extends SunlitDocument {parent?: SceneLike | null}

const tagged = (document: SunlitDocument) => document.flags?.wildpath?.sunlight === true;

type Accept = (document: SunlitDocument, config: LightConfig | undefined) => boolean;
interface CanvasLike {scene?: unknown; effects?: {testInsideDarkness?(point: Point): boolean; testInsideLight?(point: Point): boolean}}

/** Whether a light `accept`ed (an ambient light, another Token's or its own) reaches `token` on its Scene. */
function lightReaches(token: TokenLike, scene: SceneLike, accept: Accept, canvas: CanvasLike | undefined): boolean {
  const size = Number(scene.grid?.size) || 100;
  const pixelsPerUnit = size / (Number(scene.grid?.distance) || 5);
  // A Token's center from its corner and size; an ambient light's position is its center.
  const centerOf = (document: SunlitDocument) => document.object?.center ?? ((document.width == null)
    ? {x: Number(document.x) || 0, y: Number(document.y) || 0}
    : {x: (Number(document.x) || 0) + (Number(document.width) * size / 2), y: (Number(document.y) || 0) + ((Number(document.height) || 1) * size / 2)});
  const point = {...centerOf(token), elevation: Number(token.elevation) || 0};
  const rendered = canvas?.scene === scene;
  const reaches = (light: SunlitDocument, config: LightConfig | undefined, source: LightSourceLike | undefined) => {
    if ( !accept(light, config) || light.hidden ) return false;
    if ( rendered && source?.testPoint ) return (source.active !== false) && source.testPoint(point);
    // Off the viewed Scene: within the light's radius, with no wall that stops light between (foundry-v14-walls.mts).
    const radius = Math.max(Number(config?.bright) || 0, Number(config?.dim) || 0) * pixelsPerUnit;
    const center = centerOf(light);
    return (radius > 0) && (Math.hypot(point.x - center.x, point.y - center.y) <= radius)
      && !wallsBlock(scene as never, center, point, {type: "light"});
  };
  return [...(scene.lights ?? [])].some(light => reaches(light, light.config, light.object?.lightSource))
    || [...(scene.tokens ?? [])].some(other => (other.id !== token.id) && reaches(other, other.light, other.object?.light))
    || reaches(token, token.light, token.object?.light);
}

/** Whether `token` stands in sunlight. */
export function inSunlight(token: TokenLike | null | undefined,
  {canvas=(globalThis as {canvas?: CanvasLike}).canvas}: {canvas?: CanvasLike | undefined} = {}): boolean {
  const scene = token?.parent;
  if ( !token || !scene ) return false;
  return tagged(scene) || lightReaches(token, scene, tagged, canvas);
}

export type Light = "light" | "dark" | "magicalDarkness";

/**
 * The light `token` stands in (2024): in light, in darkness (Darkvision sees it), or in magical Darkness (only Devil's
 * Sight, Truesight or a sense other than sight). A Scene without Token vision is all light. On the viewed Scene,
 * Foundry's darkness and light sources decide (walls, elevation and global illumination included): any darkness source
 * is magical Darkness. Elsewhere a negative light's radius is magical Darkness; global illumination or a light's
 * radius is light; anywhere else is dark.
 */
export function lightAt(token: TokenLike | null | undefined,
  {canvas=(globalThis as {canvas?: CanvasLike}).canvas}: {canvas?: CanvasLike | undefined} = {}): Light {
  const scene = token?.parent;
  if ( !token || !scene || (scene.tokenVision === false) ) return "light";
  const effects = canvas?.effects;
  if ( (canvas?.scene === scene) && effects?.testInsideDarkness && effects.testInsideLight ) {
    const size = Number(scene.grid?.size) || 100;
    const point = {...(token.object?.center ?? {x: (Number(token.x) || 0) + ((Number(token.width) || 1) * size / 2),
      y: (Number(token.y) || 0) + ((Number(token.height) || 1) * size / 2)}), elevation: Number(token.elevation) || 0};
    if ( effects.testInsideDarkness(point) ) return "magicalDarkness";
    return effects.testInsideLight(point) ? "light" : "dark";
  }
  if ( lightReaches(token, scene, (_light, config) => config?.negative === true, canvas) ) return "magicalDarkness";
  if ( (scene.environment?.globalLight?.enabled === true) || tagged(scene) ) return "light";
  return lightReaches(token, scene, (_light, config) => config?.negative !== true, canvas) ? "light" : "dark";
}

/** What a creature's own roll's predicates see of the light it stands in: `inSunlight`. */
export function sunlightContext(token: TokenLike | null | undefined): Data {
  return inSunlight(token) ? {inSunlight: true} : {};
}
