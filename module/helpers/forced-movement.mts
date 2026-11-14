/**
 * Who an Action's `push` moves (G6, areas.md): one rule for the before-push reaction window (Dwarven Plate) and the
 * adapter that moves the Tokens, so nobody is asked about a push that would not move them.
 */

import {CREATURE_SIZE_ORDER} from "./grid-footprints.mjs";
import {completedTargetRefs} from "./target-actor-refs.mjs";

type Data = Record<string, unknown>;
/**
 * `choose`: its user picks where its one target lands ("space": any free field within `distance`; "line": one on the
 * straight line through its source, toward or away), `inRange`: a landing within the Action's range of its source too.
 */
export interface PushSpec {distance?: number; toward?: boolean; maxSize?: string; on?: string; choose?: "space" | "line"; inRange?: boolean}

/**
 * Whether a creature of `size` (its TokenGridFootprint's size name) is small enough for `maxSize` ("a Large or smaller
 * creature"). An unknown size is.
 */
export function pushable(size: string | null | undefined, maxSize?: string | null): boolean {
  if ( !maxSize ) return true;
  const order = CREATURE_SIZE_ORDER as readonly string[];
  const rank = order.indexOf(String(size ?? ""));
  const limit = order.indexOf(maxSize);
  return (rank < 0) || (limit < 0) || (rank <= limit);
}

/**
 * Who an Action pushes: its failed saves (its successes, `on: "success"`), else its hits, else (no roll at all: a Roper's
 * Reel) its targets.
 */
export function pushedTargets(state: Data, definition: {save?: unknown; attack?: unknown; push?: PushSpec}) {
  const results = (state.results ?? {}) as {saveResolution?: {results?: Array<{ok?: boolean; success?: boolean; target?: Data}>};
    attackResolution?: {hits?: Array<{target?: Data}>}};
  if ( definition.save ) return (results.saveResolution?.results ?? [])
    .filter(entry => entry.ok && (entry.success === (definition.push?.on === "success")))
    .map(entry => entry.target);
  if ( definition.attack ) return (results.attackResolution?.hits ?? []).map(entry => entry.target);
  return completedTargetRefs(state) as Data[];
}
