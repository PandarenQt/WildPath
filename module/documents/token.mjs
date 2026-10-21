import {
  buildFoundryMovementIntent
} from "../adapters/foundry-v14-movement-adapter.mjs";
import {movementMessage} from "../helpers/refusal-messages.mjs";
import {prepareFoundryReactionCheckpoints} from "../adapters/foundry-v14-reaction-checkpoint-adapter.mjs";
import {isStagedMovementWrite} from "../adapters/foundry-v14-staged-movement-commit.mjs";
import {applySensesToToken, sensesKey} from "../adapters/foundry-v14-senses.mjs";

const BaseTokenDocument = globalThis.TokenDocument ?? class {};

/**
 * Each Token's creature's senses as of its last preparation (its vision is prepared again when they change). Kept
 * beside it, not in a private field: Foundry prepares a Token while constructing it, before its fields exist.
 */
const PREPARED_SENSES = new WeakMap();

export default class WildPathTokenDocument extends BaseTokenDocument {
  /** @inheritDoc Its sight and detection modes follow its creature's senses (adapters/foundry-v14-senses.mts). */
  _prepareDetectionModes() {
    applySensesToToken(this);
    PREPARED_SENSES.set(this, sensesKey(this));
    super._prepareDetectionModes();
  }

  /** @inheritDoc When its creature's senses change, its vision is prepared and drawn again. */
  _onRelatedUpdate(update={}, operation={}) {
    super._onRelatedUpdate(update, operation);
    if ( sensesKey(this) === PREPARED_SENSES.get(this) ) return;
    this.reset();
    this.object?.initializeVisionSource?.();
  }

  async _preUpdate(changed, operation, user) {
    const runtime = movementRuntime();
    if ( runtime?.prepareReactionCheckpoints && !isStagedMovementWrite(this, operation, changed) ) {
      try {
        // A refused preparation was already notified by the movement authority.
        if ( await prepareFoundryReactionCheckpoints(this, changed, operation, user, runtime,
          operation.movement?.[this.id]?.id ?? globalThis.foundry.utils.randomID()) === false ) return false;
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
    if ( isStagedMovementWrite(this, operation, movement.destination) ) return parentResult;

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

    // The movement authority notifies every refusal it returns.
    const approval = await runtime.requestMovementApproval(intent.intent);
    if ( approval?.approved !== true ) return false;
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
    globalThis.ui.notifications.warn(movementMessage({reason}, globalThis.game));
  } else if ( typeof globalThis.console?.warn === "function" ) {
    globalThis.console.warn("Wild Path | Movement", reason);
  }
}
