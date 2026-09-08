import {sameMovementReactionBoundary, type MovementReactionBoundary} from "../helpers/movement-reaction-boundaries.mjs";

export interface MovementContinuationDirective {
  readonly boundary: MovementReactionBoundary;
  readonly directive: "continue" | "cancel-parent";
}
interface PausableToken {
  readonly movement: {readonly id: string; readonly state: string};
  pauseMovement(key: string): Promise<boolean> | null;
  resumeMovement(movementId: string, key: string): void;
  stopMovement(): void;
}

/** Runtime handles stay here. Approvals and directives contain only plain identities. */
export function createFoundryV14ReactionPauseAdapter() {
  const entries = new Map<string, {boundary: MovementReactionBoundary; token?: PausableToken;
    paused: boolean; released: boolean; directive?: MovementContinuationDirective}>();
  function apply(entry: ReturnType<typeof entries.get>) {
    if ( !entry?.paused || entry.released || !entry.directive || !entry.token ) return;
    const {token, boundary, directive} = entry;
    entry.released = true;
    delete entry.token;
    if ( token.movement.id !== boundary.operationId || token.movement.state !== "paused" ) return;
    if ( directive.directive === "cancel-parent" ) token.stopMovement();
    else token.resumeMovement(boundary.operationId, boundary.pauseKey);
  }
  return {
    expect(boundary: MovementReactionBoundary) {
      const existing = entries.get(boundary.operationId);
      if ( existing && !sameMovementReactionBoundary(existing.boundary, boundary) ) throw new Error("Movement pause identity changed.");
      if ( !existing ) entries.set(boundary.operationId, {boundary: structuredClone(boundary), paused: false, released: false});
    },
    pause(token: PausableToken, operationId: string) {
      const entry = entries.get(operationId);
      if ( !entry || entry.paused || entry.released ) return;
      if ( token.movement.id !== operationId ) throw new Error("Reaction pause does not match current Foundry movement.");
      // This call must happen synchronously in moveToken, before returning to Foundry.
      entry.token = token;
      entry.paused = true;
      const continuation = token.pauseMovement(entry.boundary.pauseKey);
      if ( !continuation ) { token.stopMovement(); throw new Error("Foundry could not establish the approved reaction pause."); }
      // Promise is a runtime handle, never part of pause or socket data.
      void continuation.catch(() => { if (token.movement.id === operationId) token.stopMovement(); });
      apply(entry);
    },
    release(directive: MovementContinuationDirective) {
      const entry = entries.get(directive.boundary.operationId);
      if ( !entry || !sameMovementReactionBoundary(entry.boundary, directive.boundary)
        || !["continue", "cancel-parent"].includes(directive.directive) ) return {ok: false, code: "MOVEMENT_BOUNDARY_MISMATCH"};
      if ( entry.released || entry.directive ) return {ok: true, duplicate: true};
      entry.directive = structuredClone(directive);
      apply(entry);
      return {ok: true};
    }
  };
}
