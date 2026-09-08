import {
  buildFoundryMovementIntent
} from "../adapters/foundry-v14-movement-adapter.mjs";
import {prepareFoundryReactionCheckpoints} from "../adapters/foundry-v14-reaction-checkpoint-adapter.mjs";

const BaseTokenDocument = globalThis.TokenDocument ?? class {};

export default class WildPathTokenDocument extends BaseTokenDocument {
  async _preUpdate(changed, operation, user) {
    const runtime = movementRuntime();
    if ( runtime?.prepareReactionCheckpoints ) {
      try {
        await prepareFoundryReactionCheckpoints(this, changed, operation, user, runtime,
          operation.movement?.[this.id]?.id ?? globalThis.foundry.utils.randomID());
      } catch (error) {
        notifyMovementFailure(error.message);
        return false;
      }
    }
    return super._preUpdate(changed, operation, user);
  }
  /**
   * Foundry V14 awaits this protected lifecycle after it has determined final movement
   * waypoints. This remains an approve/reject gate; checkpoint preparation occurs earlier.
   * @param {object} movement
   * @param {object} operation
   * @returns {Promise<boolean|void>}
   */
  async _preUpdateMovement(movement, operation={}) {
    const parentResult = typeof super._preUpdateMovement === "function"
      ? await super._preUpdateMovement(movement, operation)
      : undefined;
    if ( parentResult === false ) return false;

    const runtime = movementRuntime();
    if ( !runtime || typeof runtime.requestMovementApproval !== "function" ) {
      notifyMovementFailure("WildPath movement authority is not available.");
      return false;
    }

    const intent = buildFoundryMovementIntent({
      tokenDocument: this,
      movement,
      operation,
      user: currentUser()
    });
    if ( !intent.ok ) {
      notifyMovementFailure(intent.reason ?? intent.code ?? "Movement could not be prepared for WildPath validation.");
      return false;
    }

    const approval = await runtime.requestMovementApproval(intent.intent);
    if ( approval?.approved !== true ) {
      notifyMovementFailure(approval?.reason ?? approval?.code ?? "Movement was rejected by WildPath.");
      return false;
    }
    if ( approval.reactionBoundary ) runtime.expectReactionPause(approval.reactionBoundary);
    return parentResult;
  }
}

function movementRuntime() {
  return globalThis.game?.wildpath?.movement
    ?? globalThis.game?.wildpath?.multiplayer?.movement
    ?? null;
}

function currentUser() {
  return globalThis.game?.user ?? null;
}

function notifyMovementFailure(reason) {
  if ( !reason ) return;
  if ( typeof globalThis.ui?.notifications?.warn === "function" ) {
    globalThis.ui.notifications.warn(`Wild Path | ${reason}`);
  } else if ( typeof globalThis.console?.warn === "function" ) {
    globalThis.console.warn("Wild Path | Movement", reason);
  }
}
