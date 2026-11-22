/**
 * Who an Action's `push` moves (G6, areas.md): one rule for the before-push reaction window (Dwarven Plate) and the
 * adapter that moves the Tokens, so nobody is asked about a push that would not move them; and which targets any part
 * gated by a save's outcome acts on (`outcomeTargets`).
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
 * The completed targets a part gated by a save's outcome acts on (a push's, `ends.on`'s): with `on` ("failure" or
 * "success") and a save, those whose save rolled with that outcome; otherwise every completed target. A target the save
 * skipped (Unaffected, excluded: TARGET_SKIPPED, written ok with success false) rolled nothing, so it is neither.
 */
export function outcomeTargets(state, definition, on) {
    if (!on || !definition.save)
        return completedTargetRefs(state);
    const results = (state.results ?? {});
    return (results.saveResolution?.results ?? [])
        .filter(entry => entry.ok && (entry.code !== "TARGET_SKIPPED") && (entry.success === (on === "success")))
        .map(entry => entry.target);
}
/**
 * The targets whose concentration an Action's `ends.concentration` breaks (with `ends.on`, only those whose save had that
 * outcome): one rule for the runtime that ends what they sustain and a lasting area that answers no more after it.
 */
export function brokenConcentrationTargets(state) {
    const definition = state.actionDefinition;
    return (definition?.ends?.concentration === true) ? outcomeTargets(state, definition, definition.ends.on) : [];
}
/**
 * Who a part an Action's roll gates acts on (a push, a fall): its failed saves (its successes, `on: "success"`), else
 * its hits, else (no roll at all: a Roper's Reel) its targets.
 */
export function rolledTargets(state, definition, on) {
    const results = (state.results ?? {});
    if (definition.save)
        return outcomeTargets(state, definition, on ?? "failure");
    if (definition.attack)
        return (results.attackResolution?.hits ?? []).map(entry => entry.target);
    return completedTargetRefs(state);
}
/** Who an Action pushes (rolledTargets with `push.on`); a throw, its one target whatever it rolled (Q42). */
export function pushedTargets(state, definition) {
    if (definition.push?.thrown)
        return completedTargetRefs(state).slice(0, 1);
    return rolledTargets(state, definition, definition.push?.on);
}
