import { movementEventId } from "./movement-events.mjs";
/** Do not predict predicates or resource availability. Both can change during the route. */
export function needsMovementReactionCheckpoints(triggers) {
    return triggers.some(trigger => trigger.enabled && trigger.kind === "reaction"
        && (!trigger.event.type || trigger.event.type === "movement.transition")
        && (!trigger.event.phase || trigger.event.phase === "information"));
}
/** Reactions to a proposed step resolve before Foundry plays that step (inside its segment approval). */
export function needsBeforeStepReactions(triggers) {
    return triggers.some(trigger => trigger.enabled && trigger.kind === "reaction"
        && trigger.event.type === "movement.transition-proposed");
}
export function movementReactionBoundary(progress, operationId, transitionIndex) {
    if (!Number.isInteger(transitionIndex) || transitionIndex < 0 || transitionIndex >= progress.approvedTransitions.length) {
        throw new Error("Reaction boundary is outside the approved movement route.");
    }
    const eventId = movementEventId(progress, `transition:${transitionIndex}`);
    const windowId = `reaction-window:event-host:${eventId}:after-event:${eventId}`;
    return { rootMovementId: progress.movementId, operationId, transitionIndex, eventId, windowId,
        pauseKey: `wildpath:${windowId}` };
}
export function sameMovementReactionBoundary(a, b) {
    return ["rootMovementId", "operationId", "transitionIndex", "eventId", "windowId", "pauseKey"].every(key => a[key] === b[key]);
}
