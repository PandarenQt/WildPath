import {
  MULTIPLAYER_AUTHORITY_CODES,
  MULTIPLAYER_MESSAGE_TYPES,
  clonePlainData,
  createBoundedIdCache,
  createResolutionSocketEnvelope,
  normalizeAuthorityUsers,
  recipientMatchesEnvelope,
  selectResolutionAuthority,
  validateResolutionSocketEnvelope
} from "../helpers/multiplayer-authority.mjs";
import {fieldKey} from "../helpers/grid-footprints.mjs";
import {
  RESOURCE_RESOLUTION_CODES,
  commitActorResourceMutationPlan,
  createActorResourceMutationPlan
} from "./resource-resolver.mjs";
import {
  FOUNDRY_MOVEMENT_CODES,
  authorizeFoundryMovementIntent,
  createMovementPaymentPlan,
  currentTokenAnchor,
  expectedMovementDestinationAnchor,
  movementKey,
  movementResolutionId,
  resolveMovementCompletionDocuments,
  sanitizeMovementCompletion,
  sanitizeMovementIntent
} from "../adapters/foundry-v14-movement-adapter.mjs";

const DEFAULT_APPROVAL_TIMEOUT_MS = 15000;

/* -------------------------------------------- */

export function createMultiplayerMovementAuthority({
  userId=null,
  users=[],
  activeGMUserId=null,
  transport=null,
  game=globalThis.game,
  persistencePort=null,
  allowLocalWithoutGM=false,
  canCommitLocally=false,
  measurementMode=null,
  authorizeMovement=authorizeFoundryMovementIntent,
  approvalTimeoutMs=DEFAULT_APPROVAL_TIMEOUT_MS,
  duplicateCacheLimit=200,
  logger=null,
  notify=null
}={}) {
  const localUserId = stringOrNull(userId ?? transport?.userId ?? game?.user?.id ?? game?.userId);
  const approvedMovements = new Map();
  const committedMovements = createBoundedIdCache({limit: duplicateCacheLimit});
  const inFlightMovementCommits = new Map();
  const pendingApprovals = new Map();
  const initiatedAuthorities = new Map();
  const seenMessages = createBoundedIdCache({limit: duplicateCacheLimit});
  const notifications = [];
  const errors = [];

  const api = {
    userId: localUserId,
    approvedMovements,
    committedMovements,
    notifications,
    errors,
    register() {
      if ( !transport || typeof transport.register !== "function" ) return {
        ok: false,
        code: MULTIPLAYER_AUTHORITY_CODES.TRANSPORT_UNAVAILABLE,
        reason: "No ResolutionTransportPort is available."
      };
      return transport.register(envelope => handleEnvelope(envelope));
    },
    async requestMovementApproval(intent={}) {
      return requestMovementApproval(intent);
    },
    async observeMovementCompletion(completion={}, options={}) {
      return observeMovementCompletion(completion, options);
    },
    async commitMovementCompletion(completion={}) {
      return commitMovementCompletion(completion);
    },
    async handleEnvelope(envelope) {
      return handleEnvelope(envelope);
    },
    getApproval(value={}) {
      return approvedMovements.get(movementKey(value)) ?? null;
    },
    getCommitted(value={}) {
      return committedMovements.get(movementKey(value)) ?? null;
    }
  };

  return api;

  async function handleEnvelope(envelope) {
    const validation = validateResolutionSocketEnvelope(envelope);
    if ( !validation.ok ) return validation;
    const data = validation.envelope;
    if ( !recipientMatchesEnvelope(data, localUserId) ) return {
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.OK,
      ignored: true
    };
    if ( !isMovementMessageType(data.messageType) ) return {
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.OK,
      ignored: true
    };
    if ( seenMessages.has(data.messageId) ) return {
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.OK,
      duplicate: true
    };
    seenMessages.add(data.messageId);

    switch ( data.messageType ) {
      case MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_INTENT:
        return receiveMovementIntent(data);
      case MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_APPROVAL:
        return receiveMovementApproval(data);
      case MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_COMMIT:
        return receiveMovementCommit(data);
      case MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_RESULT:
        return receiveMovementResult(data);
      default:
        return {
          ok: false,
          code: MULTIPLAYER_AUTHORITY_CODES.UNKNOWN_MESSAGE_TYPE,
          reason: `Unknown movement message type: ${data.messageType}.`
        };
    }
  }

  async function requestMovementApproval(intent={}) {
    const sanitized = withLocalSourceUser(sanitizeMovementIntent(intent));
    if ( !sanitized.movementId ) return failure(FOUNDRY_MOVEMENT_CODES.MISSING_MOVEMENT_ID, "MovementIntent requires movementId.");

    const canUseLocalAuthority = await evaluateLocalCommitPermission(canCommitLocally, {
      intent: sanitized,
      userId: localUserId,
      users: userDirectory()
    });
    const authority = selectResolutionAuthority({
      initiatorUserId: sanitized.sourceUserId ?? localUserId,
      localUserId,
      users: userDirectory(),
      activeGMUserId: activeGMId(),
      allowLocalWithoutGM,
      canCommitLocally: canUseLocalAuthority
    });
    if ( !authority.ok ) return failAndNotify(authority);

    initiatedAuthorities.set(sanitized.resolutionId, authority.userId);
    if ( authority.userId === localUserId ) {
      const approval = await authorizeAndRecord(sanitized, {
        initiatorUserId: sanitized.sourceUserId ?? localUserId,
        localCommitAllowed: authority.mode === "local-no-active-gm"
      });
      notifyApproval(approval);
      return approval;
    }

    const pending = createPendingApproval({
      intent: sanitized,
      authorityUserId: authority.userId
    });
    pendingApprovals.set(sanitized.resolutionId, pending);
    const envelope = createResolutionSocketEnvelope({
      messageType: MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_INTENT,
      senderUserId: localUserId,
      recipientUserId: authority.userId,
      resolutionId: sanitized.resolutionId,
      payload: {
        intent: sanitized
      },
      metadata: {
        authority
      }
    });
    const sent = await sendEnvelope(envelope);
    if ( !sent.ok ) {
      pending.cancel();
      pendingApprovals.delete(sanitized.resolutionId);
      return failAndNotify(sent);
    }
    return pending.promise;
  }

  async function receiveMovementIntent(envelope) {
    const intent = withEnvelopeSourceUser(sanitizeMovementIntent(envelope.payload?.intent ?? envelope.payload), envelope);
    if ( intent.sourceUserId !== envelope.senderUserId ) return sendMovementApproval({
      recipientUserId: envelope.senderUserId,
      approval: {
        ok: true,
        approved: false,
        code: MULTIPLAYER_AUTHORITY_CODES.WRONG_USER,
        reason: "MovementIntent sourceUserId does not match the socket sender.",
        movementId: intent.movementId,
        resolutionId: envelope.resolutionId
      }
    });

    const authority = selectResolutionAuthority({
      initiatorUserId: envelope.senderUserId,
      localUserId,
      users: userDirectory(),
      activeGMUserId: activeGMId(),
      allowLocalWithoutGM,
      canCommitLocally: envelope.senderUserId === localUserId
        ? await evaluateLocalCommitPermission(canCommitLocally, {intent, userId: localUserId, users: userDirectory()})
        : false
    });
    if ( !authority.ok ) return sendMovementApproval({
      recipientUserId: envelope.senderUserId,
      approval: {
        ok: true,
        approved: false,
        code: authority.code,
        reason: authority.reason,
        movementId: intent.movementId,
        resolutionId: envelope.resolutionId
      }
    });
    if ( authority.userId !== localUserId ) return {
      ok: false,
      code: MULTIPLAYER_AUTHORITY_CODES.WRONG_AUTHORITY,
      reason: "This client is not the selected movement authority.",
      authorityUserId: authority.userId
    };

    const approval = await authorizeAndRecord(intent, {
      initiatorUserId: envelope.senderUserId,
      localCommitAllowed: authority.mode === "local-no-active-gm"
    });
    return sendMovementApproval({
      recipientUserId: envelope.senderUserId,
      approval
    });
  }

  function receiveMovementApproval(envelope) {
    const pending = pendingApprovals.get(envelope.resolutionId);
    if ( !pending ) return {
      ok: false,
      code: MULTIPLAYER_AUTHORITY_CODES.REQUEST_NOT_PENDING,
      reason: "No pending movement approval request exists for this movement."
    };
    if ( pending.authorityUserId !== envelope.senderUserId ) return {
      ok: false,
      code: MULTIPLAYER_AUTHORITY_CODES.WRONG_AUTHORITY,
      reason: "Movement approval did not come from the selected authority.",
      expectedAuthorityUserId: pending.authorityUserId,
      senderUserId: envelope.senderUserId
    };

    const approval = clonePlainData(envelope.payload?.approval ?? envelope.payload, "movementApproval");
    if ( approval?.movementId !== pending.intent.movementId ) return {
      ok: false,
      code: MULTIPLAYER_AUTHORITY_CODES.REQUEST_MISMATCH,
      reason: "Movement approval movementId does not match the pending request."
    };

    pending.resolve(approval);
    pendingApprovals.delete(envelope.resolutionId);
    notifyApproval(approval);
    return {
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.OK,
      approval
    };
  }

  async function observeMovementCompletion(completion={}, {tokenDocument=null}={}) {
    const sanitized = sanitizeMovementCompletion(completion);
    if ( !sanitized.movementId ) return failure(FOUNDRY_MOVEMENT_CODES.MISSING_MOVEMENT_ID, "MovementCompletion requires movementId.");

    const key = movementKey(sanitized);
    const record = approvedMovements.get(key);
    if ( record?.authorityUserId === localUserId ) {
      const result = await applyMovementCompletion(sanitized, {
        senderUserId: sanitized.sourceUserId ?? record.initiatorUserId ?? null,
        tokenDocument
      });
      if ( record.initiatorUserId && record.initiatorUserId !== localUserId ) {
        const sent = await sendMovementResult({
          recipientUserId: record.initiatorUserId,
          result
        });
        return {
          ...result,
          movementResultSent: sent.ok !== false
        };
      }
      return result;
    }

    const expectedAuthorityUserId = initiatedAuthorities.get(sanitized.resolutionId);
    if ( expectedAuthorityUserId && expectedAuthorityUserId !== localUserId ) return {
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.OK,
      ignored: true,
      reason: "Movement completion will be observed by the selected movement authority.",
      authorityUserId: expectedAuthorityUserId,
      movementId: sanitized.movementId
    };

    return {
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.OK,
      ignored: true,
      reason: "No local movement approval record exists for observed completion.",
      movementId: sanitized.movementId
    };
  }

  async function commitMovementCompletion(completion={}) {
    const sanitized = withLocalSourceUser(sanitizeMovementCompletion(completion));
    if ( !sanitized.movementId ) return failure(FOUNDRY_MOVEMENT_CODES.MISSING_MOVEMENT_ID, "MovementCompletion requires movementId.");

    const expectedAuthorityUserId = initiatedAuthorities.get(sanitized.resolutionId);
    if ( expectedAuthorityUserId && expectedAuthorityUserId === localUserId ) {
      return applyMovementCompletion(sanitized, {senderUserId: localUserId});
    }
    if ( expectedAuthorityUserId ) {
      const envelope = createResolutionSocketEnvelope({
        messageType: MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_COMMIT,
        senderUserId: localUserId,
        recipientUserId: expectedAuthorityUserId,
        resolutionId: sanitized.resolutionId,
        payload: {
          completion: sanitized
        },
        metadata: {
          authorityUserId: expectedAuthorityUserId
        }
      });
      const sent = await sendEnvelope(envelope);
      return sent.ok ? {
        ok: true,
        code: MULTIPLAYER_AUTHORITY_CODES.OK,
        movementId: sanitized.movementId,
        sent
      } : failAndNotify(sent);
    }

    const canUseLocalAuthority = await evaluateLocalCommitPermission(canCommitLocally, {
      completion: sanitized,
      userId: localUserId,
      users: userDirectory()
    });
    const authority = selectResolutionAuthority({
      initiatorUserId: sanitized.sourceUserId ?? localUserId,
      localUserId,
      users: userDirectory(),
      activeGMUserId: activeGMId(),
      allowLocalWithoutGM,
      canCommitLocally: canUseLocalAuthority
    });
    if ( !authority.ok ) return failAndNotify(authority);
    if ( authority.userId === localUserId ) {
      return applyMovementCompletion(sanitized, {senderUserId: localUserId});
    }
    const envelope = createResolutionSocketEnvelope({
      messageType: MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_COMMIT,
      senderUserId: localUserId,
      recipientUserId: authority.userId,
      resolutionId: sanitized.resolutionId,
      payload: {
        completion: sanitized
      },
      metadata: {
        authority
      }
    });
    const sent = await sendEnvelope(envelope);
    return sent.ok ? {
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.OK,
      movementId: sanitized.movementId,
      sent
    } : failAndNotify(sent);
  }

  async function receiveMovementCommit(envelope) {
    const completion = withEnvelopeSourceUser(sanitizeMovementCompletion(envelope.payload?.completion ?? envelope.payload), envelope);
    const senderCheck = validateEnvelopeSourceUser(completion, envelope);
    if ( !senderCheck.ok ) return sendMovementResult({
      recipientUserId: envelope.senderUserId,
      result: senderCheck
    });

    const authority = selectResolutionAuthority({
      initiatorUserId: envelope.senderUserId,
      localUserId,
      users: userDirectory(),
      activeGMUserId: activeGMId(),
      allowLocalWithoutGM,
      canCommitLocally: envelope.senderUserId === localUserId
        ? await evaluateLocalCommitPermission(canCommitLocally, {completion, userId: localUserId, users: userDirectory()})
        : false
    });
    if ( !authority.ok ) return sendMovementResult({
      recipientUserId: envelope.senderUserId,
      result: failure(authority.code, authority.reason, {movementId: completion.movementId})
    });
    if ( authority.userId !== localUserId ) return {
      ok: false,
      code: MULTIPLAYER_AUTHORITY_CODES.WRONG_AUTHORITY,
      reason: "This client is not the selected movement commit authority.",
      authorityUserId: authority.userId
    };

    const result = await applyMovementCompletion(completion, {senderUserId: envelope.senderUserId});
    return sendMovementResult({
      recipientUserId: envelope.senderUserId,
      result
    });
  }

  function receiveMovementResult(envelope) {
    const expectedAuthorityUserId = initiatedAuthorities.get(envelope.resolutionId);
    if ( expectedAuthorityUserId && expectedAuthorityUserId !== envelope.senderUserId ) return {
      ok: false,
      code: MULTIPLAYER_AUTHORITY_CODES.WRONG_AUTHORITY,
      reason: "Movement result did not come from the selected authority.",
      expectedAuthorityUserId,
      senderUserId: envelope.senderUserId
    };

    const result = clonePlainData(envelope.payload?.result ?? envelope.payload, "movementResult");
    const notification = {
      type: MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_RESULT,
      envelope,
      result
    };
    notifications.push(notification);
    if ( result?.ok === false ) {
      errors.push(notification);
      notify?.(notification);
    }
    return {
      ok: result?.ok !== false,
      code: result?.code ?? MULTIPLAYER_AUTHORITY_CODES.OK,
      result
    };
  }

  async function authorizeAndRecord(intent, {initiatorUserId=null, localCommitAllowed=false}={}) {
    let approval;
    try {
      approval = await authorizeMovement({
        intent,
        game,
        measurementMode
      });
    } catch (error) {
      approval = {
        ok: true,
        approved: false,
        code: FOUNDRY_MOVEMENT_CODES.MOVEMENT_REJECTED,
        reason: error?.message ?? String(error),
        movementId: intent.movementId,
        resolutionId: intent.resolutionId
      };
    }
    if ( approval?.approved === true ) {
      const key = movementKey(approval);
      approvedMovements.set(key, {
        key,
        movementId: approval.movementId,
        resolutionId: approval.resolutionId ?? movementResolutionId(approval.movementId),
        initiatorUserId: stringOrNull(initiatorUserId) ?? intent.sourceUserId ?? null,
        authorityUserId: localUserId,
        localCommitAllowed,
        approval: clonePlainData(approval, "movementApproval"),
        committed: false
      });
    }
    return clonePlainData(approval, "movementApproval");
  }

  async function applyMovementCompletion(completion, {senderUserId=null, tokenDocument=null}={}) {
    const key = movementKey(completion);
    const record = approvedMovements.get(key);
    if ( !record ) return failure(
      FOUNDRY_MOVEMENT_CODES.MOVEMENT_NOT_APPROVED,
      "No active-GM approval record exists for this completed movement.",
      {movementId: completion.movementId}
    );
    const sourceUserId = stringOrNull(senderUserId ?? completion.sourceUserId);
    const claimedSourceUserId = stringOrNull(completion.sourceUserId);
    if ( sourceUserId && claimedSourceUserId && sourceUserId !== claimedSourceUserId ) {
      return failure(
        MULTIPLAYER_AUTHORITY_CODES.WRONG_USER,
        "Movement completion sourceUserId does not match the socket sender.",
        {
          expectedUserId: sourceUserId,
          senderUserId: sourceUserId,
          claimedSourceUserId,
          movementId: completion.movementId
        }
      );
    }
    if ( record.initiatorUserId && sourceUserId && record.initiatorUserId !== sourceUserId ) {
      return failure(
        MULTIPLAYER_AUTHORITY_CODES.WRONG_USER,
        "Movement completion came from a user who did not receive the approval.",
        {
          expectedUserId: record.initiatorUserId,
          senderUserId: sourceUserId,
          movementId: completion.movementId
        }
      );
    }

    if ( committedMovements.has(key) ) return {
      ok: true,
      code: FOUNDRY_MOVEMENT_CODES.MOVEMENT_ALREADY_COMMITTED,
      movementId: completion.movementId,
      duplicate: true,
      committed: false,
      previous: committedMovements.get(key)
    };

    const inFlight = inFlightMovementCommits.get(key);
    if ( inFlight ) {
      const result = await inFlight;
      if ( committedMovements.has(key) ) return {
        ok: true,
        code: FOUNDRY_MOVEMENT_CODES.MOVEMENT_ALREADY_COMMITTED,
        movementId: completion.movementId,
        duplicate: true,
        committed: false,
        previous: committedMovements.get(key)
      };
      return result;
    }

    const commitPromise = Promise.resolve()
      .then(() => executeMovementCompletionCommit({key, record, completion, tokenDocument}));
    inFlightMovementCommits.set(key, commitPromise);
    try {
      return await commitPromise;
    } finally {
      inFlightMovementCommits.delete(key);
    }
  }

  async function executeMovementCompletionCommit({key, record, completion, tokenDocument=null}) {
    const documents = await resolveMovementCompletionDocuments({completion, game, tokenDocument});
    if ( !documents.ok ) return documents;

    const destination = currentTokenAnchor({
      tokenDocument: documents.token,
      scene: documents.scene,
      position: documents.sourcePosition ?? null
    });
    if ( !destination.ok ) return destination;
    const expectedDestination = expectedMovementDestinationAnchor(record.approval);
    if ( !expectedDestination || !anchorsMatch(destination.anchor, expectedDestination, destination.topology) ) {
      return failure(
        FOUNDRY_MOVEMENT_CODES.DESTINATION_MISMATCH,
        "Completed Token position does not match the approved movement destination.",
        {
          movementId: completion.movementId,
          expectedDestination,
          actualDestination: destination.anchor
        }
      );
    }

    const paymentPlan = createMovementPaymentPlan({
      movementId: completion.movementId,
      payment: record.approval.payment
    });
    if ( !paymentPlan.resources.length ) {
      record.committed = true;
      committedMovements.add(key, {
        movementId: completion.movementId,
        committed: true,
        spent: false,
        paymentPlan
      });
      return {
        ok: true,
        code: FOUNDRY_MOVEMENT_CODES.OK,
        movementId: completion.movementId,
        committed: true,
        spent: false,
        paymentPlan
      };
    }

    const mutationPlan = createActorResourceMutationPlan(documents.actor.system, paymentPlan);
    if ( !mutationPlan.ok ) return failure(
      mutationPlan.code ?? RESOURCE_RESOLUTION_CODES.COMMIT_FAILED,
      mutationPlan.reason ?? "Movement resource mutation could not be planned.",
      {movementId: completion.movementId, paymentPlan, mutationPlan}
    );

    let committed;
    try {
      committed = await commitActorResourceMutationPlan(documents.actor, mutationPlan, {persistencePort});
    } catch (error) {
      return failure(
        FOUNDRY_MOVEMENT_CODES.MOVEMENT_COMMIT_FAILED,
        error?.message ?? "Movement resource mutation could not be committed.",
        {movementId: completion.movementId, paymentPlan, mutationPlan}
      );
    }
    if ( committed !== true ) return failure(
      FOUNDRY_MOVEMENT_CODES.MOVEMENT_COMMIT_FAILED,
      "Movement resource mutation could not be committed.",
      {movementId: completion.movementId, paymentPlan, mutationPlan}
    );

    const result = {
      movementId: completion.movementId,
      committed: true,
      spent: true,
      paymentPlan,
      mutationPlan
    };
    record.committed = true;
    record.commit = clonePlainData(result, "movementCommitResult");
    committedMovements.add(key, result);
    return {
      ok: true,
      code: FOUNDRY_MOVEMENT_CODES.OK,
      ...clonePlainData(result, "movementCommitResult")
    };
  }

  function createPendingApproval({intent, authorityUserId}) {
    let timer = null;
    let settled = false;
    let resolve;
    const promise = new Promise(done => {
      resolve = approval => {
        if ( settled ) return;
        settled = true;
        if ( timer ) globalThis.clearTimeout(timer);
        done(approval);
      };
      if ( Number(approvalTimeoutMs) > 0 ) {
        timer = globalThis.setTimeout(() => {
          pendingApprovals.delete(intent.resolutionId);
          resolve(failure(
            MULTIPLAYER_AUTHORITY_CODES.AUTHORITY_UNAVAILABLE,
            "Timed out waiting for active-GM movement approval.",
            {movementId: intent.movementId}
          ));
        }, Number(approvalTimeoutMs));
      }
    });
    return {
      intent,
      authorityUserId,
      promise,
      resolve,
      cancel() {
        if ( timer ) globalThis.clearTimeout(timer);
        settled = true;
      }
    };
  }

  async function sendMovementApproval({recipientUserId, approval}) {
    const envelope = createResolutionSocketEnvelope({
      messageType: MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_APPROVAL,
      senderUserId: localUserId,
      recipientUserId,
      resolutionId: approval.resolutionId ?? movementResolutionId(approval.movementId),
      payload: {
        approval
      }
    });
    const sent = await sendEnvelope(envelope);
    return sent.ok ? {
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.OK,
      approval,
      sent
    } : sent;
  }

  async function sendMovementResult({recipientUserId, result}) {
    const envelope = createResolutionSocketEnvelope({
      messageType: MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_RESULT,
      senderUserId: localUserId,
      recipientUserId,
      resolutionId: result.resolutionId ?? movementResolutionId(result.movementId),
      payload: {
        result
      }
    });
    const sent = await sendEnvelope(envelope);
    return sent.ok ? {
      ok: result.ok !== false,
      code: result.code ?? MULTIPLAYER_AUTHORITY_CODES.OK,
      result,
      sent
    } : sent;
  }

  async function sendEnvelope(envelope) {
    if ( !transport || typeof transport.send !== "function" ) return {
      ok: false,
      code: MULTIPLAYER_AUTHORITY_CODES.TRANSPORT_UNAVAILABLE,
      reason: "No ResolutionTransportPort is available.",
      envelope
    };
    try {
      const sent = await transport.send(envelope);
      return sent?.ok === false
        ? sent
        : {ok: true, code: MULTIPLAYER_AUTHORITY_CODES.OK, envelope, sent};
    } catch (error) {
      return {
        ok: false,
        code: MULTIPLAYER_AUTHORITY_CODES.TRANSPORT_SEND_FAILED,
        reason: error?.message ?? String(error),
        envelope
      };
    }
  }

  function userDirectory() {
    const resolved = typeof users === "function" ? users() : users;
    return normalizeAuthorityUsers(resolved, {activeGMUserId: activeGMId()});
  }

  function activeGMId() {
    return typeof activeGMUserId === "function" ? activeGMUserId() : activeGMUserId;
  }

  async function evaluateLocalCommitPermission(predicate, context={}) {
    if ( typeof predicate === "function" ) return await predicate(context);
    return predicate === true;
  }

  function withLocalSourceUser(intent) {
    return {
      ...intent,
      sourceUserId: intent.sourceUserId ?? localUserId,
      resolutionId: intent.resolutionId ?? movementResolutionId(intent.movementId)
    };
  }

  function withEnvelopeSourceUser(intent, envelope) {
    return {
      ...intent,
      sourceUserId: intent.sourceUserId ?? envelope.senderUserId,
      resolutionId: intent.resolutionId ?? envelope.resolutionId
    };
  }

  function validateEnvelopeSourceUser(value, envelope) {
    const payloadSourceUserId = stringOrNull(envelope.payload?.completion?.sourceUserId ?? envelope.payload?.sourceUserId);
    const senderUserId = stringOrNull(envelope.senderUserId);
    if ( payloadSourceUserId && senderUserId && payloadSourceUserId !== senderUserId ) {
      return failure(
        MULTIPLAYER_AUTHORITY_CODES.WRONG_USER,
        "Movement completion sourceUserId does not match the socket sender.",
        {
          expectedUserId: senderUserId,
          senderUserId,
          claimedSourceUserId: payloadSourceUserId,
          movementId: value.movementId
        }
      );
    }
    return {ok: true, code: MULTIPLAYER_AUTHORITY_CODES.OK};
  }

  function failAndNotify(result) {
    const failureResult = clonePlainData(result, "movementFailure");
    errors.push({type: "movementFailure", error: failureResult});
    notify?.({type: "movementFailure", error: failureResult});
    return failureResult;
  }

  function notifyApproval(approval) {
    if ( approval?.approved !== false ) return;
    const notification = {
      type: MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_APPROVAL,
      error: {
        code: approval.code ?? FOUNDRY_MOVEMENT_CODES.MOVEMENT_REJECTED,
        reason: approval.reason ?? "Movement was rejected.",
        movementId: approval.movementId
      },
      approval
    };
    errors.push(notification);
    notify?.(notification);
  }
}

/* -------------------------------------------- */

function isMovementMessageType(type) {
  return [
    MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_INTENT,
    MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_APPROVAL,
    MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_COMMIT,
    MULTIPLAYER_MESSAGE_TYPES.MOVEMENT_RESULT
  ].includes(type);
}

function anchorsMatch(left, right, topology) {
  if ( !left || !right ) return false;
  return fieldKey(left, topology) === fieldKey(right, topology);
}

function failure(code, reason=null, data={}) {
  return {
    ok: false,
    code,
    reason,
    ...clonePlainData(data, "movementFailure")
  };
}

function stringOrNull(value) {
  if ( value == null ) return null;
  const string = String(value).trim();
  return string ? string : null;
}
