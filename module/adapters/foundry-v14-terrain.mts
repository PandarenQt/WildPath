/**
 * Difficult Terrain (2024: "every foot of movement in Difficult Terrain costs 1 extra foot"). A Region with V14's core
 * "Modify Movement Cost" behavior makes its space cost that many times as much for each movement action (2 is Difficult
 * Terrain); a lasting area that makes Difficult Terrain (Web, Spike Growth) carries that behavior too. A creature's
 * voluntary step into such a space costs the highest difficulty there, unless it ignores that terrain: a `terrain.ignore`
 * Modifier ignores all of it (Freedom of Movement), `terrain.ignore.<kind>` only a lasting area's terrain of that kind
 * (Boots of the Winterlands: ice and snow).
 */

import {gridFieldToFoundryCenterPoint} from "./foundry-v14-tactical-grid-adapter.mjs";

type Data = Record<string, unknown>;
interface Behavior {type?: string; disabled?: boolean; system?: {difficulties?: Record<string, number | null>}}
interface TerrainRegion {
  behaviors?: Iterable<Behavior>; testPoint?(point: {x: number; y: number; elevation: number}): boolean;
  flags?: {wildpath?: {area?: {difficultTerrain?: {types?: string[]} | null}}};
}
interface TerrainToken {
  elevation?: number; parent?: {regions?: Iterable<TerrainRegion>; grid?: unknown} | null;
  actor?: {getStatistic?(domains: string[]): {totalModifier?: number} | null} | null;
}
interface Step {toFootprint?: {fields?: Data[]}; defaultAmount?: number; movementKind?: string; movementMode?: string}

const toCenter = gridFieldToFoundryCenterPoint as unknown as (field: Data, options: {scene: unknown; grid: unknown}) =>
  {point?: {x: number; y: number}};

/** How much more a Region's space costs to move through by `action` (walking, flying): 1 when it costs nothing extra. */
export function regionDifficulty(region: TerrainRegion, action="walk") {
  return Math.max(1, ...[...(region.behaviors ?? [])].filter(behavior => (behavior.type === "modifyMovementCost") && !behavior.disabled)
    .map(behavior => Number(behavior.system?.difficulties?.[action] ?? behavior.system?.difficulties?.walk) || 1));
}

/**
 * The step cost policy (movement-paths.mjs) of `token`'s voluntary moves through Difficult Terrain; null when its Scene
 * has none. Forced movement and teleports cost no movement anyway.
 */
export function difficultTerrainPolicy(token: TerrainToken | null | undefined) {
  const scene = token?.parent;
  const regions = [...(scene?.regions ?? [])].filter(region => region.testPoint
    && [...(region.behaviors ?? [])].some(behavior => (behavior.type === "modifyMovementCost") && !behavior.disabled));
  if ( !scene || !regions.length ) return null;
  const ignores = (domain: string) => (Number(token?.actor?.getStatistic?.([domain])?.totalModifier) || 0) > 0;
  if ( ignores("terrain.ignore") ) return null;
  const elevation = Number(token?.elevation) || 0;
  return ({toFootprint, defaultAmount, movementKind, movementMode}: Step) => {
    if ( (movementKind && (movementKind !== "voluntary")) || !toFootprint?.fields?.length ) return null;
    const points = toFootprint.fields.map(field => toCenter(field, {scene, grid: scene.grid}).point).filter(Boolean) as Array<{x: number; y: number}>;
    let worst = 1;
    for ( const region of regions ) {
      const types = region.flags?.wildpath?.area?.difficultTerrain?.types ?? [];
      if ( types.length && types.every(type => ignores(`terrain.ignore.${type}`)) ) continue;
      if ( points.some(point => region.testPoint!({...point, elevation})) ) worst = Math.max(worst, regionDifficulty(region, movementMode ?? "walk"));
    }
    return (worst > 1) ? {amount: (Number(defaultAmount) || 0) * worst, source: "difficult-terrain"} : null;
  };
}

/** The core behavior a lasting area's Region gets when it is Difficult Terrain: twice the cost for each movement action. */
export function difficultTerrainBehavior() {
  const actions = (globalThis as {CONFIG?: {Token?: {movement?: {actions?: Record<string, {terrainAction?: unknown;
    deriveTerrainDifficulty?: unknown}>}}}}).CONFIG?.Token?.movement?.actions ?? {walk: {}};
  // The base actions (walk, fly, swim, burrow); the others (crawl, climb) derive theirs from them, as V14 does.
  const difficulties = Object.fromEntries(Object.entries(actions).filter(([, config]) => (config.terrainAction == null)
    && (typeof config.deriveTerrainDifficulty !== "function")).map(([action]) => [action, 2]));
  return {type: "modifyMovementCost", name: "Difficult Terrain", system: {difficulties}};
}
