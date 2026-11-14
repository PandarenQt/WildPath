/**
 * Where a creature stands: the tags of the place its Token is in, which rule predicates read as `environment.<tag>`
 * (`{equals: {path: "environment.runningWater", value: true}}`). A Scene's `flags.wildpath.environment` tags all of it
 * (an underwater Scene); a Region's tags its space within its elevation band (a river). Tags in use: `water` and
 * `runningWater` (a Vampire's Running Water, an Aboleth's Mucus Cloud); any other key works for homebrew.
 * shortcut: a Token is in a Region by its center, as for sunlight; there is no surface or depth model.
 */

import {standingPoint} from "./foundry-v14-sunlight.mjs";

type Tags = Record<string, unknown>;
interface Point {x: number; y: number; elevation: number}
interface Tagged {flags?: {wildpath?: {environment?: Tags | null}}}
interface EnvironmentRegion extends Tagged {testPoint?(point: Point): boolean}
interface EnvironmentScene extends Tagged {regions?: Iterable<EnvironmentRegion>; grid?: {size?: number}}
type EnvironmentToken = Parameters<typeof standingPoint>[0] & {parent?: EnvironmentScene | null};

/** Its tags that are set (an unticked box submits false, which must not untag the Scene under a Region). */
const tagsOf = (document: Tagged) => Object.entries(document.flags?.wildpath?.environment ?? {}).filter(([, value]) => value === true);

/** What a creature's rules' predicates see of the place its Token stands in: `{environment: {water: true, ...}}`. */
export function environmentContext(token: EnvironmentToken | null | undefined): {environment?: Tags} {
  const scene = token?.parent;
  if ( !token || !scene ) return {};
  const point = standingPoint(token, Number(scene.grid?.size) || 100);
  const tags = tagsOf(scene);
  // Only tagged Regions are tested, so a Scene's lasting areas cost nothing here; V14's testPoint checks the elevation band.
  for ( const region of scene.regions ?? [] ) if ( tagsOf(region).length && region.testPoint?.(point) ) tags.push(...tagsOf(region));
  // Running water is water, however its tags were written (Water unticked afterwards, a macro), so "in water" rules hold in a river.
  if ( tags.some(([tag]) => tag === "runningWater") ) tags.push(["water", true]);
  return tags.length ? {environment: Object.fromEntries(tags)} : {};
}
