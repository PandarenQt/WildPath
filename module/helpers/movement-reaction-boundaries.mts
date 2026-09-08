import type {TriggerDefinition} from "../types/contracts.js";
import {movementEventId, type MovementProgress} from "./movement-events.mjs";

export interface MovementReactionBoundary {
  readonly rootMovementId: string;
  readonly operationId: string;
  readonly transitionIndex: number;
  readonly eventId: string;
  readonly windowId: string;
  readonly pauseKey: string;
}

/** Do not predict predicates or resource availability. Both can change during the route. */
export function needsMovementReactionCheckpoints(triggers: readonly TriggerDefinition[]): boolean {
  return triggers.some(trigger => trigger.enabled && trigger.kind === "reaction"
    && (!trigger.event.type || trigger.event.type === "movement.transition")
    && (!trigger.event.phase || trigger.event.phase === "information"));
}

export function movementReactionBoundary(progress: MovementProgress, operationId: string, transitionIndex: number): MovementReactionBoundary {
  if ( !Number.isInteger(transitionIndex) || transitionIndex < 0 || transitionIndex >= progress.approvedTransitions.length ) {
    throw new Error("Reaction boundary is outside the approved movement route.");
  }
  const eventId = movementEventId(progress, `transition:${transitionIndex}`);
  const windowId = `reaction-window:event-host:${eventId}:after-event:${eventId}`;
  return {rootMovementId: progress.movementId, operationId, transitionIndex, eventId, windowId,
    pauseKey: `wildpath:${windowId}`};
}

export function sameMovementReactionBoundary(a: MovementReactionBoundary, b: MovementReactionBoundary): boolean {
  return ["rootMovementId", "operationId", "transitionIndex", "eventId", "windowId", "pauseKey"].every(
    key => a[key as keyof MovementReactionBoundary] === b[key as keyof MovementReactionBoundary]);
}
