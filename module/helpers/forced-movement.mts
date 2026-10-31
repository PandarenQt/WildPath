/**
 * Who an Action's `push` moves (G6, areas.md): one rule for the before-push reaction window (Dwarven Plate) and the
 * adapter that moves the Tokens, so nobody is asked about a push that would not move them.
 */

type Data = Record<string, unknown>;
export interface PushSpec {distance?: number; toward?: boolean; maxSize?: string; on?: string}

/** The largest Token, in fields, of each size a push may be limited to ("a Large or smaller creature"). */
export const LARGEST = Object.freeze({tiny: 0.5, small: 1, medium: 1, large: 2, huge: 3, gargantuan: 4} as Record<string, number>);

/** Whether a creature of `size` (a size name, or its Token's fields) is small enough for `maxSize`. An unknown size is. */
export function pushable(size: string | number | null | undefined, maxSize?: string | null): boolean {
  if ( !maxSize ) return true;
  const fields = (typeof size === "number") ? size : LARGEST[String(size ?? "")];
  return (fields === undefined) || (fields <= (LARGEST[maxSize] ?? Infinity));
}

/** Who an Action pushes: its failed saves (its successes, `on: "success"`), else its hits. */
export function pushedTargets(state: Data, definition: {save?: unknown; attack?: unknown; push?: PushSpec}) {
  const results = (state.results ?? {}) as {saveResolution?: {results?: Array<{ok?: boolean; success?: boolean; target?: Data}>};
    attackResolution?: {hits?: Array<{target?: Data}>}};
  if ( definition.save ) return (results.saveResolution?.results ?? [])
    .filter(entry => entry.ok && (entry.success === (definition.push?.on === "success")))
    .map(entry => entry.target);
  if ( definition.attack ) return (results.attackResolution?.hits ?? []).map(entry => entry.target);
  return [];
}
