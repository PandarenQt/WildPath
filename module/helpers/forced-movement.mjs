/**
 * Who an Action's `push` moves (G6, areas.md): one rule for the before-push reaction window (Dwarven Plate) and the
 * adapter that moves the Tokens, so nobody is asked about a push that would not move them.
 */
import { CREATURE_SIZE_ORDER } from "./grid-footprints.mjs";
import { completedTargetRefs } from "./target-actor-refs.mjs";
/**
 * Whether a creature of `size` (its TokenGridFootprint's size name) is small enough for `maxSize` ("a Large or smaller
 * creature"). An unknown size is.
 */
export function pushable(size, maxSize) {
    if (!maxSize)
        return true;
    const order = CREATURE_SIZE_ORDER;
    const rank = order.indexOf(String(size ?? ""));
    const limit = order.indexOf(maxSize);
    return (rank < 0) || (limit < 0) || (rank <= limit);
}
/**
 * Who an Action pushes: its failed saves (its successes, `on: "success"`), else its hits, else (no roll at all: a Roper's
 * Reel) its targets.
 */
export function pushedTargets(state, definition) {
    const results = (state.results ?? {});
    if (definition.save)
        return (results.saveResolution?.results ?? [])
            .filter(entry => entry.ok && (entry.success === (definition.push?.on === "success")))
            .map(entry => entry.target);
    if (definition.attack)
        return (results.attackResolution?.hits ?? []).map(entry => entry.target);
    return completedTargetRefs(state);
}
