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
import {normalizeEntityRef, uuidRef} from "../helpers/entity-refs.mjs";
import {
  advanceMovementProgress, completedMovementPrefix, createMovementProgress, movementPaymentDelta, sameMovementFootprint
} from "../helpers/movement-events.mjs";
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
  expectedMovementDestinationState,
  foundryMovementCompletionToMovementPath,
  movementKey,
  movementResolutionId,
  movementPaymentFromEvaluation,
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
  notify=null,
  onAutomationEvent=null
}={}) {
  const localUserId = stringOrNull(userId ?? transport?.userId ?? game?.user?.id ?? game?.userId);
  const approvedMovements = new Map();
  const operationRoots = new Map();
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
    async observeMovementProgress(observation={}, options={}) {
      return observeMovementCompletion(observation, options);
    },
    async commitMovementCompletion(completion={}) {
      return commitMovementCompletion(completion);
    },
    async handleEnvelope(envelope) {
      return handleEnvelope(envelope);
    },
    getApproval(value={}) {
      return approvedMovements.get(recordKey(value)) ?? null;
    },
    getCommitted(value={}) {
      return committedMovements.get(recordKey(value)) ?? null;
    },
    getMovementProgress(value={}) {
      const record = approvedMovements.get(recordKey(value));
      return record ? progressSnapshot(record) : null;
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

  async function observeMovementCompletion(completion={}, {tokenDocument=null, sourcePosition=null}={}) {
    const sanitized = sanitizeMovementCompletion(completion);
    if ( !sanitized.movementId ) return failure(FOUNDRY_MOVEMENT_CODES.MISSING_MOVEMENT_ID, "MovementCompletion requires movementId.");

    const key = recordKey(sanitized);
    const record = approvedMovements.get(key);
    if ( record?.authorityUserId === localUserId ) {
      const result = await applyMovementCompletion(sanitized, {
        senderUserId: sanitized.sourceUserId ?? record.initiatorUserId ?? null,
        tokenDocument,
        sourcePosition
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

    if ( activeGMId() === localUserId ) return failure(FOUNDRY_MOVEMENT_CODES.MOVEMENT_NOT_APPROVED,
      "No local approval/progress record exists; movement cannot be reconstructed after reload or authority handoff.",
      {movementId: sanitized.movementId});
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
    const chain = intent.foundry?.chain === undefined ? [] : intent.foundry.chain;
    if ( !Array.isArray(chain) || chain.some(id => typeof id !== "string" || !id) ) {
      return rejectedContinuation(intent, "Foundry movement chain must contain movement IDs.");
    }
    const key = movementKey({...intent, movementId: chain[0] ?? intent.movementId});
    return serializeMovement(key, () => authorizeOperation(intent, {initiatorUserId, localCommitAllowed, chain, key}));
  }

  async function authorizeOperation(intent, {initiatorUserId, localCommitAllowed, chain, key}) {
    const authorityContext = {initiatorUserId, localCommitAllowed};
    const authority = verifyCurrentAuthority(authorityContext, intent);
    if ( !authority.ok ) return {...authority, approved: false, resolutionId: intent.resolutionId};
    const record = approvedMovements.get(key);
    const existing = record?.operations.find(operation => operation.id === intent.movementId);
    if ( existing ) return JSON.stringify(existing.intent) === JSON.stringify(intent)
      && record.initiatorUserId === initiatorUserId
      ? clonePlainData(existing.approval) : rejectedContinuation(intent, "Movement identity was reused with different intent.");
    if ( chain.length && (!record?.progress || record.initiatorUserId !== initiatorUserId
      || ["interrupted", "completed"].includes(record.progress.status)
      || JSON.stringify(chain) !== JSON.stringify(record.operations.map(operation => operation.id))
      || !intent.foundry.subpathId || intent.foundry.subpathId !== record.operations[0].subpathId
      || intent.foundry.split === true
      || record.operations.at(-1).observedTransitionCount !== record.progress.completedTransitionCount) ) {
      return rejectedContinuation(intent, "Continuation requires the observed prior operation chain and the same subpath.");
    }
    const baseTransitionCount = record?.progress?.completedTransitionCount ?? 0;
    let approval;
    let progress = null;
    try {
      approval = await authorizeMovement({
        intent: chain.length ? {...intent, movementKind: record.approval.path.movementKind,
          movementMode: record.approval.path.movementMode} : intent,
        game,
        measurementMode: record?.progress?.measurementMode ?? measurementMode
      });
      if ( chain.length && approval.approved ) {
        const end = completedMovementPrefix(record.progress, approval.path.anchors, baseTransitionCount);
        if ( end !== record.progress.approvedTransitions.length
          || !approval.evaluation.footprints.every((footprint, index) =>
            sameMovementFootprint(footprint, record.progress.approvedFootprints[baseTransitionCount + index]))
          || JSON.stringify(approval.evaluation.transitions.map(step => step.cost)) !== JSON.stringify(
            record.progress.approvedTransitions.slice(baseTransitionCount).map(step => step.cost))
          || approval.actorRef?.uuid !== record.approval.actorRef?.uuid ) {
          return rejectedContinuation(intent, "Continuation route, footprint, Actor, or costs differ from the approved suffix.");
        }
      }
      if ( !chain.length && approval.approved && approval.path ) progress = createMovementProgress({
        movementId: approval.movementId,
        source: {
          actorRef: approval.actorRef?.uuid ? uuidRef(approval.actorRef.uuid) : normalizeEntityRef(approval.actorRef),
          actorId: approval.actorRef?.id ?? null,
          tokenRef: normalizeEntityRef(approval.tokenRef),
          tokenId: approval.tokenRef?.id,
          sceneRef: normalizeEntityRef(approval.sceneRef)
        },
        authority: {userId: localUserId, mode: localCommitAllowed ? "local-no-active-gm" : "active-gm"},
        evaluation: approval.evaluation
      });
    } catch (error) {
      approval = {
        ok: true,
        approved: false,
        code: chain.length ? FOUNDRY_MOVEMENT_CODES.MOVEMENT_CONTINUATION_MISMATCH : FOUNDRY_MOVEMENT_CODES.MOVEMENT_REJECTED,
        reason: error?.message ?? String(error),
        movementId: intent.movementId,
        resolutionId: intent.resolutionId
      };
    }
    if ( approval?.approved === true ) {
      const currentAuthority = verifyCurrentAuthority(authorityContext, intent);
      if ( !currentAuthority.ok ) return {...currentAuthority, approved: false, resolutionId: intent.resolutionId};
      const operation = {id: intent.movementId, chain, subpathId: intent.foundry?.subpathId ?? null,
        baseTransitionCount, observedTransitionCount: null,
        intent: clonePlainData(intent), approval: clonePlainData(approval)};
      if ( chain.length ) record.operations.push(operation);
      else approvedMovements.set(key, {
        key,
        movementId: approval.movementId,
        resolutionId: approval.resolutionId ?? movementResolutionId(approval.movementId),
        initiatorUserId: stringOrNull(initiatorUserId) ?? intent.sourceUserId ?? null,
        authorityUserId: localUserId,
        localCommitAllowed,
        approval: clonePlainData(approval, "movementApproval"),
        originState: clonePlainData(approval.foundryOriginState, "movementOrigin"),
        progress,
        operations: [operation],
        paidMovementCost: 0,
        paidTransitionCount: 0,
        paymentFailure: null,
        semanticEvents: [],
        eventDeliveryErrors: [],
        committed: false
      });
      operationRoots.set(movementKey(intent), key);
    }
    return clonePlainData(approval, "movementApproval");
  }

  async function applyMovementCompletion(completion, {senderUserId=null, tokenDocument=null, sourcePosition=null}={}) {
    const key = recordKey(completion);
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

    return serializeMovement(key, () => executeMovementCompletionCommit({key, record, completion, tokenDocument, sourcePosition}));
  }

  async function verifyMovementCompletion({record, completion, tokenDocument=null, sourcePosition=null}) {
    const documents = await resolveMovementCompletionDocuments({completion, game, tokenDocument});
    if ( !documents.ok ) return documents;

    const destination = currentTokenAnchor({
      tokenDocument: documents.token,
      scene: documents.scene,
      position: sourcePosition ?? documents.sourcePosition ?? null
    });
    if ( !destination.ok ) return destination;
    const expectedDestination = expectedMovementDestinationAnchor(record.approval);
    const partial = record.progress && completion.foundry?.progressStatus;
    if ( !partial && (!expectedDestination || !anchorsMatch(destination.anchor, expectedDestination, destination.topology)) ) {
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
    const expectedState = expectedMovementDestinationState(record.approval);
    const stateCheck = expectedState
      ? movementDestinationStateMatches(sourcePosition ?? documents.sourcePosition, expectedState)
      : {matches: true, mismatches: []};
    if ( !stateCheck.matches ) {
      return failure(
        FOUNDRY_MOVEMENT_CODES.DESTINATION_MISMATCH,
        "Completed Token footprint state does not match the approved resize destination.",
        {
          movementId: completion.movementId,
          mismatches: stateCheck.mismatches,
          expectedDestination: expectedState,
          actualDestination: documents.sourcePosition
        }
      );
    }
    return {ok: true, documents, destination};
  }

  function verifyCurrentAuthority(record, completion) {
    const authority = selectResolutionAuthority({
      initiatorUserId: record.initiatorUserId,
      localUserId,
      users: userDirectory(),
      activeGMUserId: activeGMId(),
      allowLocalWithoutGM,
      canCommitLocally: record.localCommitAllowed
    });
    if ( !authority.ok ) return {...authority, movementId: completion.movementId};
    if ( authority.userId !== localUserId ) return failure(MULTIPLAYER_AUTHORITY_CODES.WRONG_AUTHORITY,
      "Movement authority changed before the operation could be reconciled.", {movementId: completion.movementId});
    return {ok: true};
  }

  function reconcileMovementFacts({record, completion, verified}) {
    if ( !record.progress ) return {ok: true};
    const operation = record.operations.find(entry => entry.id === completion.movementId);
    if ( !operation || JSON.stringify(completion.foundry?.chain === undefined ? [] : completion.foundry.chain) !== JSON.stringify(operation.chain)
      || (operation.subpathId && completion.foundry?.subpathId !== operation.subpathId)
      || completion.waypoints.some(waypoint => waypoint.movementId != null && waypoint.movementId !== operation.id) ) {
      return failure(FOUNDRY_MOVEMENT_CODES.MOVEMENT_CONTINUATION_MISMATCH,
        "Observed movement does not match its approved operation and subpath.", {movementId: completion.movementId});
    }
    const observed = foundryMovementCompletionToMovementPath({
      completion,
      approval: operation.approval,
      originState: operation.approval.foundryOriginState,
      tokenDocument: verified.documents.token,
      scene: verified.documents.scene
    });
    if ( !observed.ok ) return {...observed, movementId: completion.movementId};
    const status = completion.foundry?.progressStatus ?? "completed";
    let reconciled;
    let count = null;
    try {
      if ( observed.path.topology !== record.approval.path.topology ) throw new Error("Observed topology differs from approval.");
      count = completedMovementPrefix(record.progress, observed.path.anchors, operation.baseTransitionCount);
      // Identity and ordered route must match before classifying history. A strictly
      // older prefix cannot change facts/payment and may arrive against a newer source.
      if ( count < record.progress.completedTransitionCount ) return {ok: true, duplicate: true, stale: true};
      if ( !sameMovementFootprint(verified.destination.footprint, record.progress.approvedFootprints[count]) ) {
        throw new Error("Observed source footprint differs from the completed prefix.");
      }
      if ( count === record.progress.completedTransitionCount && record.progress.status === "paused" && status === "moving" ) {
        return {ok: true, duplicate: true, stale: true};
      }
      if ( count === record.progress.completedTransitionCount && ["interrupted", "completed"].includes(record.progress.status) ) {
        return {ok: true, duplicate: true};
      }
      const provenance = {source: "foundry-v14", lifecycle: completion.metadata?.foundryLifecycle ?? "moveToken",
        timing: status === "completed" ? "completion-reconciled" : "prefix-reconciled", finished: status === "completed"};
      if ( status !== "completed" || operation.chain.length ) Object.assign(provenance, {
        operationId: operation.id, chain: operation.chain, subpathId: operation.subpathId,
        split: completion.foundry?.split === true, state: completion.foundry?.state ?? null
      });
      reconciled = advanceMovementProgress(record.progress, {
        completedTransitionCount: count,
        actualFootprint: verified.destination.footprint,
        status,
        provenance,
        ...(status === "interrupted" ? {interruption: {
          reason: completion.foundry?.constrained ? "foundry-constrained" : "foundry-stopped",
          source: "foundry-v14", resumable: false
        }} : {})
      });
      operation.observedTransitionCount = count;
    } catch (error) {
      return failure(status === "completed" ? FOUNDRY_MOVEMENT_CODES.COMPLETION_ROUTE_MISMATCH
        : FOUNDRY_MOVEMENT_CODES.MOVEMENT_PREFIX_MISMATCH, error.message, {
        movementId: completion.movementId,
        observation: {
          lifecycle: completion.metadata?.foundryLifecycle ?? null,
          operationId: operation.id, rootMovementId: record.movementId,
          chain: operation.chain, subpathId: operation.subpathId,
          state: completion.foundry?.state ?? null, status,
          observedTransitionCount: count,
          authoritativeTransitionCount: record.progress.completedTransitionCount,
          observedAnchors: observed.path.anchors,
          observedSourceFootprint: verified.destination.footprint,
          expectedFootprint: count === null ? null : record.progress.approvedFootprints[count],
          authoritativeActualFootprint: record.progress.actualFootprint
        }
      });
    }
    // Facts describe verified locomotion independently of payment success. Store the new
    // prefix before notifying consumers so reentrant or retried delivery cannot re-emit it.
    record.progress = reconciled.progress;
    record.semanticEvents.push(...clonePlainData(reconciled.events, "movementEvents"));
    for ( const event of reconciled.events ) {
      try {
        onAutomationEvent?.(clonePlainData(event, "movementEvent"));
      } catch (error) {
        const deliveryError = failure(FOUNDRY_MOVEMENT_CODES.MOVEMENT_EVENT_DELIVERY_FAILED,
          error?.message ?? String(error), {movementId: completion.movementId, eventId: event.id});
        record.eventDeliveryErrors.push(deliveryError);
        errors.push(deliveryError);
        logger?.error?.("Wild Path | Movement event consumer failed", deliveryError);
      }
    }
    return {ok: true, duplicate: reconciled.duplicate};
  }

  async function executeMovementCompletionCommit({key, record, completion, tokenDocument=null, sourcePosition=null}) {
    const authority = verifyCurrentAuthority(record, completion);
    if ( !authority.ok ) return authority;
    let documents;
    let duplicate = false;
    if ( tokenDocument ) {
      const verified = await verifyMovementCompletion({record, completion, tokenDocument, sourcePosition});
      if ( !verified.ok ) return {...verified, movementId: completion.movementId};
      documents = verified.documents;
      const currentAuthority = verifyCurrentAuthority(record, completion);
      if ( !currentAuthority.ok ) return currentAuthority;
      if ( record.approval.actorRef?.uuid && documents.actor?.uuid !== record.approval.actorRef.uuid ) {
        return failure(FOUNDRY_MOVEMENT_CODES.ACTOR_NOT_FOUND, "The approved Token Actor association changed.", {movementId: completion.movementId});
      }
      const facts = reconcileMovementFacts({record, completion, verified});
      if ( !facts.ok ) return facts;
      if ( facts.stale ) return {ok: true, code: FOUNDRY_MOVEMENT_CODES.MOVEMENT_ALREADY_COMMITTED,
        movementId: completion.movementId, duplicate: true, stale: true, committed: false, progress: progressSnapshot(record)};
      duplicate = facts.duplicate === true;
    } else {
      // Socket messages can retry a debt already proved locally, never authorize a prefix.
      if ( !record.progress || record.progress.status === "pending" ) return failure(
        FOUNDRY_MOVEMENT_CODES.MOVEMENT_PROGRESS_UNVERIFIED,
        "Payment requires a locally verified movement prefix before a retry can be requested.", {movementId: completion.movementId});
      documents = await resolveMovementCompletionDocuments({completion, game});
      if ( !documents.ok ) return {...documents, movementId: completion.movementId};
      if ( documents.actor?.uuid !== record.approval.actorRef?.uuid ) return failure(
        FOUNDRY_MOVEMENT_CODES.ACTOR_NOT_FOUND, "The approved Token Actor association changed.", {movementId: completion.movementId});
      duplicate = true;
    }
    const paymentAuthority = verifyCurrentAuthority(record, completion);
    if ( !paymentAuthority.ok ) return paymentAuthority;
    let delta = {amount: 0, cumulativeCost: 0};
    try {
      if ( record.progress ) delta = movementPaymentDelta(record.progress, record.paidMovementCost);
    } catch (error) {
      return failure(FOUNDRY_MOVEMENT_CODES.MOVEMENT_PAYMENT_MISMATCH, error.message, {movementId: completion.movementId});
    }
    const payment = record.progress ? movementPaymentFromEvaluation({
      ...record.approval.evaluation,
      cost: {...record.approval.evaluation.cost, amount: delta.amount}
    }) : record.approval.payment;
    const paymentPlan = createMovementPaymentPlan({movementId: record.movementId, payment});
    paymentPlan.id += `:prefix:${record.progress?.completedTransitionCount ?? 0}`;
    let mutationPlan = null;
    let paymentFailure = null;
    if ( paymentPlan.resources.length ) {
      mutationPlan = createActorResourceMutationPlan(documents.actor.system, paymentPlan);
      if ( !mutationPlan.ok ) paymentFailure = failure(
        mutationPlan.code ?? RESOURCE_RESOLUTION_CODES.COMMIT_FAILED, mutationPlan.reason, {movementId: completion.movementId});
      else {
        try {
          if ( await commitActorResourceMutationPlan(documents.actor, mutationPlan, {persistencePort}) !== true ) {
            paymentFailure = failure(FOUNDRY_MOVEMENT_CODES.MOVEMENT_COMMIT_FAILED,
              "Movement resource mutation could not be committed.", {movementId: completion.movementId});
          }
        } catch (error) {
          paymentFailure = failure(FOUNDRY_MOVEMENT_CODES.MOVEMENT_COMMIT_FAILED, error?.message ?? String(error), {movementId: completion.movementId});
        }
      }
    }
    if ( paymentFailure ) {
      record.paymentFailure = clonePlainData(paymentFailure);
      return {...paymentFailure, paymentPlan, mutationPlan, progress: progressSnapshot(record)};
    }
    record.paidMovementCost = delta.cumulativeCost;
    record.paidTransitionCount = record.progress?.completedTransitionCount ?? 0;
    record.paymentFailure = null;
    const alreadyCommitted = record.committed;
    record.committed = !record.progress || ["completed", "interrupted"].includes(record.progress.status);
    const result = {
      ok: true,
      code: (duplicate || alreadyCommitted) && !delta.amount ? FOUNDRY_MOVEMENT_CODES.MOVEMENT_ALREADY_COMMITTED : FOUNDRY_MOVEMENT_CODES.OK,
      movementId: completion.movementId,
      rootMovementId: record.movementId,
      duplicate: (duplicate || alreadyCommitted) && !delta.amount,
      committed: !((duplicate || alreadyCommitted) && !delta.amount),
      spent: paymentPlan.resources.length > 0,
      paymentPlan,
      mutationPlan,
      progress: progressSnapshot(record)
    };
    record.commit = clonePlainData(result);
    if ( record.committed ) committedMovements.add(key, result);
    return result;
  }

  function recordKey(value) {
    const key = movementKey(value);
    return operationRoots.get(key) ?? key;
  }

  function rejectedContinuation(intent, reason) {
    return {ok: true, approved: false, code: FOUNDRY_MOVEMENT_CODES.MOVEMENT_CONTINUATION_MISMATCH,
      reason, movementId: intent.movementId, resolutionId: intent.resolutionId};
  }

  async function serializeMovement(key, run) {
    const previous = inFlightMovementCommits.get(key) ?? Promise.resolve();
    const pending = previous.then(run, run);
    inFlightMovementCommits.set(key, pending);
    try { return await pending; }
    finally { if ( inFlightMovementCommits.get(key) === pending ) inFlightMovementCommits.delete(key); }
  }

  function progressSnapshot(record) {
    const progress = record.progress;
    if ( !progress ) return null;
    return clonePlainData({
      movementId: record.movementId,
      operationIds: record.operations.map(operation => operation.id),
      approvedTransitionCount: progress.approvedTransitions.length,
      completedTransitionCount: progress.completedTransitionCount,
      remainingTransitionCount: progress.approvedTransitions.length - progress.completedTransitionCount,
      actualDestination: {anchor: progress.actualFootprint.anchor, footprint: progress.actualFootprint},
      status: progress.status,
      cumulativeMovementCost: progress.cumulativeCost,
      committedMovementCost: record.paidMovementCost,
      paidTransitionCount: record.paidTransitionCount,
      measurementMode: progress.measurementMode,
      paymentFailure: record.paymentFailure
    });
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

function movementDestinationStateMatches(actual=null, expected=null) {
  const mismatches = [];
  for ( const field of ["x", "y", "elevation", "width", "height", "depth", "shape"] ) {
    if ( expected?.[field] == null ) continue;
    if ( actual?.[field] == null || Number(actual[field]) !== Number(expected[field]) ) {
      mismatches.push({
        field,
        expected: expected[field],
        actual: actual?.[field] ?? null
      });
    }
  }
  return {
    matches: mismatches.length === 0,
    mismatches
  };
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
