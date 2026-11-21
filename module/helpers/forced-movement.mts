/**
 * Who an Action's `push` moves (G6, areas.md): one rule for the before-push reaction window (Dwarven Plate) and the
 * adapter that moves the Tokens, so nobody is asked about a push that would not move them; and which targets any part
 * gated by a save's outcome acts on (`outcomeTargets`).
 */

import {CREATURE_SIZE_ORDER} from "./grid-footprints.mjs";
import {completedTargetRefs} from "./target-actor-refs.mjs";

type Data = Record<string, unknown>;
/**
 * `choose`: its user picks where its one target lands ("space": any free field within `distance`; "line": one on the
 * straight line through its source, toward or away), `inRange`: a landing within the Action's range of its source too.
 * `thrown` (with "space"): the creature flies there, `distance` measured from its source, onto any field (one already
 * occupied puts it in the nearest free space beside, and the creatures there are targets too), whatever its roll;
 * `seen`: a landing its source sees.
 */
export interface PushSpec {distance?: number; toward?: boolean; maxSize?: string; on?: string; choose?: "space" | "line"; inRange?: boolean;
  thrown?: boolean; seen?: boolean}

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
 * The completed targets a part gated by a save's outcome acts on (a push's, `ends.on`'s): with `on` ("failure" or
 * "success") and a save, those whose save rolled with that outcome; otherwise every completed target. A target the save
 * skipped (Unaffected, excluded: TARGET_SKIPPED, written ok with success false) rolled nothing, so it is neither.
 */
export function outcomeTargets(state: Data, definition: {save?: unknown}, on?: string | null) {
  if ( !on || !definition.save ) return completedTargetRefs(state) as Data[];
  const results = (state.results ?? {}) as {saveResolution?: {results?: Array<{ok?: boolean; code?: string; success?: boolean; target?: Data}>}};
  return (results.saveResolution?.results ?? [])
    .filter(entry => entry.ok && (entry.code !== "TARGET_SKIPPED") && (entry.success === (on === "success")))
    .map(entry => entry.target as Data);
}

/**
 * The targets whose concentration an Action's `ends.concentration` breaks (with `ends.on`, only those whose save had that
 * outcome): one rule for the runtime that ends what they sustain and a lasting area that answers no more after it.
 */
export function brokenConcentrationTargets(state: Data) {
  const definition = state.actionDefinition as {save?: unknown; ends?: {concentration?: unknown; on?: string}} | undefined;
  return (definition?.ends?.concentration === true) ? outcomeTargets(state, definition, definition.ends.on) : [];
}

/**
 * Who an Action pushes: its failed saves (its successes, `on: "success"`), else its hits, else (no roll at all: a Roper's
 * Reel) its targets.
 */
export function pushedTargets(state: Data, definition: {save?: unknown; attack?: unknown; push?: PushSpec}) {
  const results = (state.results ?? {}) as {attackResolution?: {hits?: Array<{target?: Data}>}};
  // A throw moves its creature whatever it rolled (Q42): its one target.
  if ( definition.push?.thrown ) return (completedTargetRefs(state) as Data[]).slice(0, 1);
  if ( definition.save ) return outcomeTargets(state, definition, definition.push?.on ?? "failure");
  if ( definition.attack ) return (results.attackResolution?.hits ?? []).map(entry => entry.target);
  return completedTargetRefs(state) as Data[];
}
