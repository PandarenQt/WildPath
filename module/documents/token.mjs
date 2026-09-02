import {
  buildFoundryMovementCompletion,
  buildFoundryMovementIntent
} from "../adapters/foundry-v14-movement-adapter.mjs";

const BaseTokenDocument = globalThis.TokenDocument ?? class {};

export default class WildPathTokenDocument extends BaseTokenDocument {
  /**
   * Foundry V14 awaits this protected lifecycle after it has determined final movement
   * waypoints. WildPath uses it only as an approve/reject gate; the waypoints are not mutated.
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
    return parentResult;
  }

  /**
   * Foundry fires post-movement processing on connected clients. Only the initiating client
   * reports completion, and budget commit waits for Foundry's finished movement promise.
   * @param {object} movement
   * @param {object} operation
   * @param {object} user
   * @returns {void}
   */
  _onUpdateMovement(movement, operation={}, user=null) {
    if ( typeof super._onUpdateMovement === "function" ) {
      super._onUpdateMovement(movement, operation, user);
    }
    this._wildpathLastMovementCommit = this._wildpathCommitMovementAfterFinish(movement, operation, user)
      .catch(error => {
        notifyMovementFailure(error?.message ?? String(error));
        return {
          ok: false,
          reason: error?.message ?? String(error)
        };
      });
  }

  async _wildpathCommitMovementAfterFinish(movement, operation={}, user=null) {
    if ( !movementInitiatedByThisClient(user, operation) ) return {
      ok: true,
      ignored: true,
      reason: "Movement was initiated by another client."
    };

    const finished = await movementFinished(movement);
    if ( finished !== true ) return {
      ok: true,
      ignored: true,
      reason: "Foundry movement did not complete."
    };

    const runtime = movementRuntime();
    if ( !runtime || typeof runtime.commitMovementCompletion !== "function" ) return {
      ok: false,
      reason: "WildPath movement authority is not available for completion commit."
    };

    const completion = buildFoundryMovementCompletion({
      tokenDocument: this,
      movement,
      operation,
      user: user ?? currentUser()
    });
    if ( !completion.ok ) {
      notifyMovementFailure(completion.reason ?? completion.code ?? "Completed movement could not be prepared for WildPath accounting.");
      return completion;
    }

    const committed = await runtime.commitMovementCompletion(completion.completion);
    if ( committed?.ok === false ) notifyMovementFailure(committed.reason ?? committed.code ?? "Movement budget commit failed.");
    return committed;
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

function movementInitiatedByThisClient(user=null, operation={}) {
  const currentUserId = globalThis.game?.user?.id ?? globalThis.game?.userId ?? null;
  const initiatingUserId = user?.id ?? operation?.userId ?? operation?.user?.id ?? null;
  if ( user?.isSelf === true ) return true;
  if ( user?.isSelf === false ) return false;
  if ( currentUserId && initiatingUserId ) return currentUserId === initiatingUserId;
  return true;
}

async function movementFinished(movement) {
  if ( movement?.finished == null ) return true;
  try {
    return await Promise.resolve(movement.finished);
  } catch {
    return false;
  }
}

function notifyMovementFailure(reason) {
  if ( !reason ) return;
  if ( typeof globalThis.ui?.notifications?.warn === "function" ) {
    globalThis.ui.notifications.warn(`Wild Path | ${reason}`);
  } else if ( typeof globalThis.console?.warn === "function" ) {
    globalThis.console.warn("Wild Path | Movement", reason);
  }
}
