import {
  RESOLUTION_REQUEST_TYPES,
  RESOLUTION_STATE_STATUS,
  cancelResolutionState,
  createResolutionState,
  updateResolutionState
} from "../helpers/resolution-state.mjs";
import {
  MULTIPLAYER_AUTHORITY_CODES,
  MULTIPLAYER_MESSAGE_TYPES,
  clonePlainData,
  commitAuthorityForUser,
  createBoundedIdCache,
  createResolutionSocketEnvelope,
  normalizeAuthorityUsers,
  recipientMatchesEnvelope,
  resolveRequestChooser,
  sanitizeActionIntentPayload,
  sanitizePendingRequestForTransport,
  sanitizeResolutionResultForTransport,
  selectResolutionAuthority,
  validateResolutionSocketEnvelope
} from "../helpers/multiplayer-authority.mjs";
import {ROLL_PROVIDER_OUTCOMES} from "../helpers/rolls.mjs";
import {
  completeStagedReactionChildResolution,
  executeStagedActionResolution,
  planStagedActionResolution,
  resumeStagedActionResolution
} from "./action-pipeline-resolver.mjs";
import {createChoiceCoordinator} from "./choice-coordinator.mjs";
import {executeRollRequest} from "./roll-provider-resolver.mjs";

export function createMultiplayerActionCoordinator({
  userId=null,
  users=[],
  transport=null,
  promptPorts=[],
  rollProviders=[],
  promptContext={},
  rollContext={},
  actionIntentResolver=null,
  planResolution=planStagedActionResolution,
  resumeResolution=resumeStagedActionResolution,
  executeResolution=executeStagedActionResolution,
  completeChildResolution=completeStagedReactionChildResolution,
  allowLocalWithoutGM=false,
  allowGMRequestFallback=true,
  canCommitLocally=false,
  activeGMUserId=null,
  duplicateCacheLimit=200,
  logger=null
}={}) {
  const localUserId = stringOrNull(userId ?? transport?.userId);
  const records = new Map();
  const completedResults = new Map();
  const notifications = [];
  const errors = [];
  const seenMessages = createBoundedIdCache({limit: duplicateCacheLimit});
  const seenIntents = createBoundedIdCache({limit: duplicateCacheLimit});

  const api = {
    userId: localUserId,
    records,
    completedResults,
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
    async declareActionIntent(intent={}) {
      const sanitizedIntent = sanitizeActionIntentPayload(intent);
      const resolutionId = stringOrNull(sanitizedIntent.resolutionId) ?? createResolutionId("resolution:multiplayer");
      const intentId = stringOrNull(sanitizedIntent.intentId) ?? `intent:${resolutionId}:${localUserId ?? "unknown"}`;
      const canUseLocalAuthority = await evaluateLocalCommitPermission(canCommitLocally, {
        intent: sanitizedIntent,
        userId: localUserId,
        users: userDirectory()
      });
      const authority = selectResolutionAuthority({
        initiatorUserId: localUserId,
        localUserId,
        users: userDirectory(),
        activeGMUserId: activeGMId(),
        allowLocalWithoutGM,
        canCommitLocally: canUseLocalAuthority
      });
      if ( !authority.ok ) return authority;

      const envelope = createResolutionSocketEnvelope({
        messageType: MULTIPLAYER_MESSAGE_TYPES.ACTION_INTENT,
        senderUserId: localUserId,
        recipientUserId: authority.userId,
        resolutionId,
        payload: {
          ...sanitizedIntent,
          intentId,
          resolutionId
        },
        metadata: {
          authority,
          multiplayer: {
            intentOnly: true
          }
        }
      });
      const sent = await sendEnvelope(envelope);
      if ( !sent.ok ) return sent;
      return {
        ok: true,
        code: MULTIPLAYER_AUTHORITY_CODES.OK,
        resolutionId,
        intentId,
        authorityUserId: authority.userId,
        envelope
      };
    },
    async handleEnvelope(envelope) {
      return handleEnvelope(envelope);
    },
    getRecord(resolutionId) {
      return records.get(String(resolutionId)) ?? null;
    },
    getResult(resolutionId) {
      return completedResults.get(String(resolutionId)) ?? null;
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
    if ( seenMessages.has(data.messageId) ) return {
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.OK,
      duplicate: true
    };
    seenMessages.add(data.messageId);

    switch ( data.messageType ) {
      case MULTIPLAYER_MESSAGE_TYPES.ACTION_INTENT:
        return receiveActionIntent(data);
      case MULTIPLAYER_MESSAGE_TYPES.PENDING_REQUEST:
        return receivePendingRequest(data);
      case MULTIPLAYER_MESSAGE_TYPES.REQUEST_RESPONSE:
        return receiveRequestResponse(data);
      case MULTIPLAYER_MESSAGE_TYPES.RESOLUTION_CANCEL:
        return receiveResolutionCancel(data);
      case MULTIPLAYER_MESSAGE_TYPES.RESOLUTION_RESULT:
        return receiveResolutionResult(data);
      case MULTIPLAYER_MESSAGE_TYPES.RESOLUTION_ERROR:
        return receiveResolutionError(data);
      default:
        return {
          ok: false,
          code: MULTIPLAYER_AUTHORITY_CODES.UNKNOWN_MESSAGE_TYPE,
          reason: `Unknown multiplayer message type: ${data.messageType}.`
        };
    }
  }

  async function receiveActionIntent(envelope) {
    const authority = selectResolutionAuthority({
      initiatorUserId: envelope.senderUserId,
      localUserId,
      users: userDirectory(),
      activeGMUserId: activeGMId(),
      allowLocalWithoutGM,
      canCommitLocally: envelope.senderUserId === localUserId
        ? await evaluateLocalCommitPermission(canCommitLocally, {intent: envelope.payload, userId: localUserId, users: userDirectory()})
        : false
    });
    if ( !authority.ok ) return sendError({
      resolutionId: envelope.resolutionId,
      recipientUserId: envelope.senderUserId,
      code: authority.code,
      reason: authority.reason,
      data: authority
    });
    if ( authority.userId !== localUserId ) return {
      ok: false,
      code: MULTIPLAYER_AUTHORITY_CODES.WRONG_AUTHORITY,
      reason: "This client is not the selected resolution authority.",
      authorityUserId: authority.userId
    };

    const intentId = stringOrNull(envelope.payload?.intentId) ?? envelope.messageId;
    const duplicateKey = `${envelope.senderUserId}:${intentId}`;
    if ( seenIntents.has(duplicateKey) ) return {
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.DUPLICATE_ACTION_INTENT,
      resolutionId: envelope.resolutionId,
      duplicate: true
    };
    seenIntents.add(duplicateKey);

    if ( typeof actionIntentResolver !== "function" ) return sendError({
      resolutionId: envelope.resolutionId,
      recipientUserId: envelope.senderUserId,
      code: MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED,
      reason: "No authoritative action intent resolver is registered."
    });

    let resolved;
    try {
      resolved = await actionIntentResolver({
        intent: sanitizeActionIntentPayload(envelope.payload),
        envelope,
        coordinator: api
      });
    } catch (error) {
      resolved = {
        ok: false,
        code: MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED,
        reason: error?.message ?? String(error)
      };
    }
    if ( resolved?.ok === false ) return sendError({
      resolutionId: envelope.resolutionId,
      recipientUserId: envelope.senderUserId,
      code: resolved.code ?? MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED,
      reason: resolved.reason ?? "Action intent was rejected by the authoritative resolver.",
      data: resolved
    });

    const options = resolved.options ?? resolved;
    const record = {
      resolutionId: envelope.resolutionId,
      intentId,
      initiatorUserId: envelope.senderUserId,
      authorityUserId: localUserId,
      state: null,
      options: {
        ...options,
        id: envelope.resolutionId
      },
      services: resolved.services ?? options.services ?? {targetActors: options.targetActors ?? null},
      requestContext: resolved.requestContext ?? options.requestContext ?? {},
      localCommitAllowed: authority.mode === "local-no-active-gm",
      requestExpectations: new Map(),
      processedRequestIds: new Set(),
      routedRequestIds: new Set(),
      knownResolutionIds: new Set([envelope.resolutionId]),
      resultSent: false
    };
    records.set(record.resolutionId, record);
    return advanceRecord(record);
  }

  async function advanceRecord(record) {
    while ( true ) {
      if ( record.state == null ) {
        const planned = await planResolution({
          ...record.options,
          services: record.services
        });
        record.state = planned.state;
        rememberResolutionState(record, record.state);
        if ( !planned.ok && !planned.waiting ) return sendAuthorityError(record, planned);
        continue;
      }

      const execution = activeResolutionExecution(record.state);
      rememberResolutionState(record, execution.state);

      if ( execution.state?.pendingRequests?.length ) return routePendingRequests(record, execution);
      if ( execution.state?.status === RESOLUTION_STATE_STATUS.READY_TO_COMMIT ) {
        const committed = await executeResolution({
          ...optionsForResolutionState(record, execution.state),
          state: execution.state,
          services: record.services,
          authority: commitAuthorityForUser({
            userId: localUserId,
            users: userDirectory(),
            activeGMUserId: activeGMId(),
            canCommit: record.localCommitAllowed
          }),
          persistencePort: record.options.persistencePort
        });
        record.state = replaceResolutionInTree(record.state, execution.path, committed.state);
        rememberResolutionState(record, committed.state);
        if ( !committed.ok && !execution.nested ) return sendAuthorityError(record, committed);
        if ( !committed.ok && execution.nested && !isTerminalState(committed.state) ) {
          return sendAuthorityError(record, committed);
        }
        continue;
      }

      if ( isTerminalState(execution.state) ) {
        if ( execution.nested ) {
          const completed = completeActiveChildResolution(record, execution);
          record.state = completed.state;
          rememberResolutionState(record, record.state);
          if ( !completed.ok && activeResolutionExecution(record.state, execution.state.id) ) {
            return sendAuthorityError(record, completed);
          }
          continue;
        }
        return sendResolutionResult(record, {ok: record.state.status === RESOLUTION_STATE_STATUS.COMPLETED});
      }

      if ( execution.state?.status === RESOLUTION_STATE_STATUS.CREATED || execution.state?.status === RESOLUTION_STATE_STATUS.RUNNING ) {
        const planned = await planResolution({
          ...optionsForResolutionState(record, execution.state),
          state: execution.state,
          services: record.services
        });
        record.state = replaceResolutionInTree(record.state, execution.path, planned.state);
        rememberResolutionState(record, planned.state);
        if ( !planned.ok && !planned.waiting && !execution.nested ) return sendAuthorityError(record, planned);
        if ( !planned.ok && !planned.waiting && execution.nested && !isTerminalState(planned.state) ) {
          return sendAuthorityError(record, planned);
        }
        continue;
      }

      return {
        ok: true,
        code: MULTIPLAYER_AUTHORITY_CODES.WAITING,
        state: record.state
      };
    }
  }

  async function routePendingRequests(record, execution=activeResolutionExecution(record.state)) {
    const state = execution.state;
    const requests = state.pendingRequests ?? [];
    for ( const request of requests ) {
      const key = requestKey(request, state);
      if ( record.routedRequestIds.has(key) ) continue;
      const sourceControllerUserIds = sourceControllerUserIdsForRequest(record, request, state);
      const chooser = resolveRequestChooser({
        request,
        users: userDirectory(),
        initiatorUserId: execution.nested ? null : record.initiatorUserId,
        authorityUserId: record.authorityUserId,
        activeGMUserId: activeGMId(),
        sourceControllerUserIds,
        targetControllerUserIds: targetControllerUserIdsForRequest(record, request, state),
        allowGMFallback: record.requestContext.allowGMRequestFallback ?? allowGMRequestFallback
      });
      if ( !chooser.ok ) {
        const cancelled = cancelResolutionState(state, {
          stageId: request.stageId,
          code: MULTIPLAYER_AUTHORITY_CODES.REQUEST_AUTHORITY_UNAVAILABLE,
          reason: chooser.reason,
          data: {requestId: request.id, requestType: request.type, chooser}
        });
        record.state = replaceResolutionInTree(record.state, execution.path, cancelled);
        rememberResolutionState(record, cancelled);
        if ( execution.nested ) return advanceRecord(record);
        return sendAuthorityError(record, chooser, {requestId: request.id, resolutionId: state.id});
      }
      record.requestExpectations.set(key, {
        request: clonePlainData(request, "pendingRequest"),
        resolutionId: state.id,
        expectedUserId: chooser.userId,
        chooser
      });
      record.routedRequestIds.add(key);
      record.knownResolutionIds.add(state.id);

      if ( chooser.userId === localUserId ) {
        const answered = await answerPendingRequestLocally({
          request,
          promptPorts,
          rollProviders,
          context: localRequestContext(record, request, state)
        });
        if ( !answered.ok ) return sendAuthorityError(record, answered, {requestId: request.id, resolutionId: state.id});
        const localEnvelope = createResolutionSocketEnvelope({
          messageType: MULTIPLAYER_MESSAGE_TYPES.REQUEST_RESPONSE,
          senderUserId: localUserId,
          recipientUserId: localUserId,
          resolutionId: state.id,
          requestId: request.id,
          payload: {response: answered.response}
        });
        return applyRequestResponse(record, localEnvelope);
      }

      const envelope = createResolutionSocketEnvelope({
        messageType: MULTIPLAYER_MESSAGE_TYPES.PENDING_REQUEST,
        senderUserId: localUserId,
        recipientUserId: chooser.userId,
        resolutionId: state.id,
        requestId: request.id,
        payload: {
          request: sanitizePendingRequestForTransport(request, {
            expectedChooserUserId: chooser.userId,
            authority: {
              userId: localUserId,
              requestAuthority: chooser
            }
          })
        },
        metadata: {
          chooser,
          stateStatus: state.status,
          parentResolutionId: execution.parent?.id ?? null
        }
      });
      const sent = await sendEnvelope(envelope);
      if ( !sent.ok ) return sendAuthorityError(record, sent, {requestId: request.id, resolutionId: state.id});
    }
    return {
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.REQUEST_ROUTED,
      state,
      pendingRequests: requests.length
    };
  }

  async function receivePendingRequest(envelope) {
    const request = envelope.payload?.request ?? null;
    if ( !request ) return sendError({
      resolutionId: envelope.resolutionId,
      requestId: envelope.requestId,
      recipientUserId: envelope.senderUserId,
      code: MULTIPLAYER_AUTHORITY_CODES.INVALID_PAYLOAD,
      reason: "PENDING_REQUEST message is missing its request payload."
    });
    const expectedChooserUserId = request.metadata?.multiplayer?.expectedChooserUserId ?? envelope.recipientUserId ?? null;
    if ( expectedChooserUserId && expectedChooserUserId !== localUserId ) return {
      ok: false,
      code: MULTIPLAYER_AUTHORITY_CODES.WRONG_USER,
      reason: "Pending request was routed to a different chooser."
    };

    const answered = await answerPendingRequestLocally({
      request,
      promptPorts,
      rollProviders,
      context: {
        ...promptContext,
        ...rollContext,
        currentUserId: localUserId,
        users: userDirectory(),
        expectedChooserUserId
      }
    });
    if ( !answered.ok ) return sendError({
      resolutionId: envelope.resolutionId,
      requestId: envelope.requestId,
      recipientUserId: envelope.senderUserId,
      code: answered.code ?? MULTIPLAYER_AUTHORITY_CODES.PROMPT_FAILED,
      reason: answered.reason,
      data: answered
    });

    const responseEnvelope = createResolutionSocketEnvelope({
      messageType: MULTIPLAYER_MESSAGE_TYPES.REQUEST_RESPONSE,
      senderUserId: localUserId,
      recipientUserId: envelope.senderUserId,
      resolutionId: envelope.resolutionId,
      requestId: request.id,
      payload: {
        response: answered.response
      },
      metadata: {
        answeredByUserId: localUserId
      }
    });
    return sendEnvelope(responseEnvelope);
  }

  async function receiveRequestResponse(envelope) {
    const record = findRecordForResolutionId(envelope.resolutionId);
    if ( !record ) return {
      ok: false,
      code: MULTIPLAYER_AUTHORITY_CODES.RESOLUTION_NOT_FOUND,
      reason: `No authoritative resolution is registered for ${envelope.resolutionId}.`
    };
    if ( record.authorityUserId !== localUserId ) return {
      ok: false,
      code: MULTIPLAYER_AUTHORITY_CODES.WRONG_AUTHORITY,
      reason: "Only the authoritative client may resume a resolution."
    };
    return applyRequestResponse(record, envelope);
  }

  async function applyRequestResponse(record, envelope) {
    const response = responseFromEnvelope(envelope);
    if ( isTerminalState(record.state) ) return {
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.DUPLICATE_REQUEST_RESPONSE,
      duplicate: true,
      reason: "Request response arrived after the authoritative resolution had already completed.",
      state: record.state,
      resolutionId: response.resolutionId,
      requestId: response.requestId
    };
    const execution = activeResolutionExecution(record.state, response.resolutionId ?? envelope.resolutionId);
    const validation = validateRequestResponse(record, envelope, response, execution);
    if ( !validation.ok ) {
      if ( validation.code === MULTIPLAYER_AUTHORITY_CODES.DUPLICATE_REQUEST_RESPONSE ) return validation;
      await sendError({
        resolutionId: record.resolutionId,
        requestId: envelope.requestId,
        recipientUserId: envelope.senderUserId,
        code: validation.code,
        reason: validation.reason,
        data: validation
      });
      return validation;
    }

    const resumed = await resumeResolution({
      state: execution.state,
      response,
      services: record.services
    });
    record.state = replaceResolutionInTree(record.state, execution.path, resumed.state);
    rememberResolutionState(record, resumed.state);
    if ( !resumed.ok && !resumed.waiting && !execution.nested ) {
      return sendAuthorityError(record, resumed, {requestId: response.requestId, resolutionId: execution.state.id});
    }
    if ( !resumed.ok && !resumed.waiting && execution.nested && !isTerminalState(resumed.state) ) {
      return sendAuthorityError(record, resumed, {requestId: response.requestId, resolutionId: execution.state.id});
    }
    record.processedRequestIds.add(requestKey({id: response.requestId, resolutionId: execution.state.id}, execution.state));
    return advanceRecord(record);
  }

  function validateRequestResponse(record, envelope, response, execution=null) {
    const requestId = stringOrNull(response.requestId ?? envelope.requestId);
    if ( !requestId ) return failure(MULTIPLAYER_AUTHORITY_CODES.REQUEST_MISMATCH, "REQUEST_RESPONSE is missing requestId.");
    const state = execution?.state ?? activeResolutionExecution(record.state, response.resolutionId ?? envelope.resolutionId)?.state ?? null;
    const resolutionId = stringOrNull(response.resolutionId ?? envelope.resolutionId ?? state?.id);
    const key = requestKey({id: requestId, resolutionId}, state);
    if ( record.processedRequestIds.has(key) ) return {
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.DUPLICATE_REQUEST_RESPONSE,
      duplicate: true,
      reason: "Request response was already processed."
    };
    if ( !state ) return failure(MULTIPLAYER_AUTHORITY_CODES.REQUEST_NOT_PENDING, "Resolution request is not currently pending.");
    const expectation = record.requestExpectations.get(key);
    if ( !state.pendingRequests?.some(request => request.id === requestId) && isTerminalState(record.state) ) {
      if ( expectation && expectation.expectedUserId !== envelope.senderUserId ) {
        return failure(MULTIPLAYER_AUTHORITY_CODES.WRONG_USER, "Request response came from a user who was not the expected chooser.", {
          expectedUserId: expectation.expectedUserId,
          senderUserId: envelope.senderUserId
        });
      }
      if ( !expectation && !record.knownResolutionIds?.has(resolutionId) ) {
        return failure(MULTIPLAYER_AUTHORITY_CODES.REQUEST_NOT_PENDING, "Resolution request is not currently pending.");
      }
      return {
        ok: true,
        code: MULTIPLAYER_AUTHORITY_CODES.DUPLICATE_REQUEST_RESPONSE,
        duplicate: true,
        reason: "Request response was already processed."
      };
    }
    const pending = (state.pendingRequests ?? []).find(request => request.id === requestId);
    if ( !pending ) return failure(MULTIPLAYER_AUTHORITY_CODES.REQUEST_NOT_PENDING, "Resolution request is not currently pending.");
    if ( !expectation ) return failure(MULTIPLAYER_AUTHORITY_CODES.REQUEST_NOT_PENDING, "No routed request expectation exists.");
    if ( expectation.expectedUserId !== envelope.senderUserId ) {
      return failure(MULTIPLAYER_AUTHORITY_CODES.WRONG_USER, "Request response came from a user who was not the expected chooser.", {
        expectedUserId: expectation.expectedUserId,
        senderUserId: envelope.senderUserId
      });
    }
    if ( response.resolutionId !== state.id ) return failure(MULTIPLAYER_AUTHORITY_CODES.REQUEST_MISMATCH, "Response resolutionId does not match the authoritative state.");
    if ( response.type !== pending.type ) return failure(MULTIPLAYER_AUTHORITY_CODES.REQUEST_MISMATCH, "Response request type does not match the pending request.");
    return {
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.OK,
      request: pending,
      expectation
    };
  }

  async function receiveResolutionCancel(envelope) {
    const record = findRecordForResolutionId(envelope.resolutionId);
    if ( !record ) return {
      ok: false,
      code: MULTIPLAYER_AUTHORITY_CODES.RESOLUTION_NOT_FOUND,
      reason: `No authoritative resolution is registered for ${envelope.resolutionId}.`
    };
    if ( record.authorityUserId !== localUserId ) return {
      ok: false,
      code: MULTIPLAYER_AUTHORITY_CODES.WRONG_AUTHORITY,
      reason: "Only the authoritative client may cancel this resolution."
    };
    const execution = activeResolutionExecution(record.state, envelope.resolutionId);
    const state = execution?.state ?? record.state ?? createResolutionState({id: record.resolutionId});
    const cancelled = cancelResolutionState(state, {
      code: MULTIPLAYER_AUTHORITY_CODES.CANCELLED,
      reason: envelope.payload?.reason ?? "Resolution cancelled by socket request.",
      data: {senderUserId: envelope.senderUserId}
    });
    record.state = replaceResolutionInTree(record.state ?? cancelled, execution?.path ?? [state.id], cancelled);
    rememberResolutionState(record, cancelled);
    if ( execution?.nested ) return advanceRecord(record);
    return sendResolutionResult(record, {ok: false, code: MULTIPLAYER_AUTHORITY_CODES.CANCELLED});
  }

  function receiveResolutionResult(envelope) {
    const result = clonePlainData(envelope.payload?.result ?? envelope.payload, "resolutionResult");
    completedResults.set(envelope.resolutionId, result);
    notifications.push({
      type: MULTIPLAYER_MESSAGE_TYPES.RESOLUTION_RESULT,
      envelope,
      result
    });
    return {
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.OK,
      result
    };
  }

  function receiveResolutionError(envelope) {
    const error = clonePlainData(envelope.payload ?? {}, "resolutionError");
    errors.push({
      type: MULTIPLAYER_MESSAGE_TYPES.RESOLUTION_ERROR,
      envelope,
      error
    });
    return {
      ok: false,
      code: error.code ?? MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_RESOLUTION_FAILED,
      reason: error.reason ?? null,
      error
    };
  }

  async function sendResolutionResult(record, result={}) {
    if ( record.resultSent ) return {
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.COMPLETED,
      duplicate: true,
      state: record.state
    };
    record.resultSent = true;
    const sanitized = sanitizeResolutionResultForTransport({
      state: record.state,
      result,
      authorityUserId: record.authorityUserId,
      initiatorUserId: record.initiatorUserId
    });
    completedResults.set(record.resolutionId, sanitized);
    const envelope = createResolutionSocketEnvelope({
      messageType: MULTIPLAYER_MESSAGE_TYPES.RESOLUTION_RESULT,
      senderUserId: localUserId,
      recipientPolicy: "all",
      resolutionId: record.resolutionId,
      payload: {
        result: sanitized
      }
    });
    const sent = await sendEnvelope(envelope);
    return {
      ok: sent.ok,
      code: sent.ok ? MULTIPLAYER_AUTHORITY_CODES.COMPLETED : sent.code,
      state: record.state,
      result: sanitized,
      sent
    };
  }

  async function sendAuthorityError(record, result, extra={}) {
    const payload = {
      code: result.code ?? MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_RESOLUTION_FAILED,
      reason: result.reason ?? result.code ?? "Authoritative resolution failed.",
      resolutionId: record.resolutionId,
      status: record.state?.status ?? null,
      ...clonePlainData(extra, "error.extra")
    };
    await sendError({
      resolutionId: record.resolutionId,
      requestId: extra.requestId ?? null,
      recipientUserId: record.initiatorUserId,
      code: payload.code,
      reason: payload.reason,
      data: payload
    });
    if ( record.state && isTerminalState(record.state) ) {
      await sendResolutionResult(record, {ok: false, code: payload.code});
    }
    return {
      ok: false,
      code: payload.code,
      reason: payload.reason,
      state: record.state
    };
  }

  async function sendError({resolutionId, requestId=null, recipientUserId=null, code, reason=null, data={}}={}) {
    const payload = {
      code,
      reason,
      resolutionId,
      requestId,
      data: clonePlainData(data, "resolutionError.data") ?? {}
    };
    errors.push({
      type: MULTIPLAYER_MESSAGE_TYPES.RESOLUTION_ERROR,
      error: payload
    });
    const envelope = createResolutionSocketEnvelope({
      messageType: MULTIPLAYER_MESSAGE_TYPES.RESOLUTION_ERROR,
      senderUserId: localUserId,
      recipientUserId,
      resolutionId,
      requestId,
      payload
    });
    const sent = await sendEnvelope(envelope);
    return {
      ok: false,
      code,
      reason,
      sent,
      error: payload
    };
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
    const explicit = typeof activeGMUserId === "function" ? activeGMUserId() : activeGMUserId;
    return explicit ?? null;
  }

  function localRequestContext(record, request, state=record.state) {
    return {
      ...promptContext,
      ...rollContext,
      currentUserId: localUserId,
      users: userDirectory(),
      resolutionId: state?.id ?? record.resolutionId,
      parentResolutionId: state?.parentId ?? record.resolutionId,
      requestId: request.id
    };
  }

  function findRecordForResolutionId(resolutionId) {
    const id = stringOrNull(resolutionId);
    if ( !id ) return null;
    const direct = records.get(id);
    if ( direct ) return direct;
    for ( const record of records.values() ) {
      if ( record.knownResolutionIds?.has(id) ) return record;
      const execution = activeResolutionExecution(record.state, id);
      if ( execution ) {
        rememberResolutionState(record, record.state);
        return record;
      }
    }
    return null;
  }

  function completeActiveChildResolution(record, execution) {
    const childState = execution.state;
    const parentState = execution.parent;
    const completed = completeChildResolution({
      parentState,
      childState,
      services: record.services,
      targetActors: record.options.targetActors ?? record.services?.targetActors ?? null,
      failurePolicy: record.services?.reactions?.failurePolicy ?? record.options.reactionFailurePolicy ?? "continue"
    });
    return {
      ...completed,
      state: replaceResolutionInTree(record.state, execution.parentPath, completed.state)
    };
  }

  function optionsForResolutionState(record, state) {
    const actor = actorForResolutionState(record, state);
    const action = actionForResolutionState(record, state);
    return {
      ...record.options,
      actor,
      action,
      source: state?.source ?? record.options.source ?? null,
      targets: state?.targets?.length ? state.targets : record.options.targets,
      targetActors: record.options.targetActors ?? record.services?.targetActors ?? null
    };
  }
}

/* -------------------------------------------- */

export async function answerPendingRequestLocally({
  request,
  promptPorts=[],
  rollProviders=[],
  context={}
}={}) {
  if ( request?.type === RESOLUTION_REQUEST_TYPES.ROLL && rollProviders.length ) {
    const rollRequest = request.payload?.rollRequest ?? null;
    const provided = await executeRollRequest({
      request: rollRequest,
      providers: rollProviders,
      context
    });
    if ( provided.ok ) return {
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.OK,
      response: {
        resolutionId: request.resolutionId,
        requestId: request.id,
        type: request.type,
        value: provided.result,
        metadata: {
          rollProvider: provided.provider
        }
      }
    };
    if ( provided.status !== ROLL_PROVIDER_OUTCOMES.PENDING || !promptPorts.length ) {
      return {
        ok: false,
        code: provided.code ?? MULTIPLAYER_AUTHORITY_CODES.ROLL_FAILED,
        reason: provided.reason ?? "RollProvider failed to produce a result.",
        provided
      };
    }
  }

  const localState = createResolutionState({
    id: request.resolutionId,
    pendingRequests: [request]
  });
  const coordinator = createChoiceCoordinator({
    promptPorts,
    resume: async ({state, response}) => ({
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.OK,
      state,
      response
    })
  });
  const coordinated = await coordinator.coordinate({
    state: localState,
    context: {
      ...context,
      enforceLocalAuthority: false
    },
    queuePrompts: false
  });
  if ( !coordinated.ok ) return {
    ok: false,
    code: coordinated.code ?? MULTIPLAYER_AUTHORITY_CODES.PROMPT_FAILED,
    reason: coordinated.reason ?? "PromptPort failed to produce a response.",
    coordinated
  };
  return {
    ok: true,
    code: MULTIPLAYER_AUTHORITY_CODES.OK,
    response: coordinated.response
  };
}

function responseFromEnvelope(envelope) {
  const response = envelope.payload?.response ?? envelope.payload;
  return {
    resolutionId: stringOrNull(response?.resolutionId) ?? envelope.resolutionId,
    requestId: stringOrNull(response?.requestId ?? response?.id) ?? envelope.requestId,
    type: stringOrNull(response?.type ?? response?.requestType),
    value: clonePlainData(response?.value ?? response?.result ?? response?.response ?? null, "response.value"),
    metadata: clonePlainData(response?.metadata ?? {}, "response.metadata") ?? {}
  };
}

function activeResolutionExecution(rootState, resolutionId=null) {
  if ( !rootState ) return null;
  const desiredId = stringOrNull(resolutionId);
  const root = createResolutionState(rootState);
  let state = root;
  let parent = null;
  let path = [root.id];
  let parentPath = [];

  while ( state ) {
    if ( desiredId ? state.id === desiredId : !state.metadata?.activeChildResolution ) {
      return {
        state,
        parent,
        path,
        parentPath,
        nested: path.length > 1
      };
    }

    const child = state.metadata?.activeChildResolution;
    if ( !child ) break;
    parent = state;
    parentPath = path;
    state = createResolutionState(child);
    path = [...path, state.id];
  }

  if ( !desiredId ) return {
    state,
    parent,
    path,
    parentPath,
    nested: path.length > 1
  };
  return null;
}

function replaceResolutionInTree(rootState, path=[], replacementState=null) {
  const replacement = createResolutionState(replacementState);
  if ( !rootState ) return replacement;
  const ids = normalizeArray(path).map(stringOrNull).filter(Boolean);
  if ( ids.length <= 1 ) return replacement;
  const root = createResolutionState(rootState);

  function replaceAt(state, index) {
    if ( index >= ids.length - 1 ) return replacement;
    const current = createResolutionState(state);
    const child = current.metadata?.activeChildResolution;
    if ( !child ) return current;
    const nextChild = replaceAt(child, index + 1);
    return updateResolutionState(current, {
      metadata: {
        ...current.metadata,
        activeChildResolution: nextChild
      }
    });
  }

  return replaceAt(root, 0);
}

function rememberResolutionState(record, state) {
  if ( !record || !state ) return;
  if ( !record.knownResolutionIds ) record.knownResolutionIds = new Set();
  let current = createResolutionState(state);
  while ( current ) {
    record.knownResolutionIds.add(current.id);
    const child = current.metadata?.activeChildResolution;
    if ( !child ) break;
    current = createResolutionState(child);
  }
}

function requestKey(request, state=null) {
  const resolutionId = stringOrNull(request?.resolutionId ?? state?.id) ?? "resolution:unknown";
  const requestId = stringOrNull(request?.id ?? request?.requestId) ?? "request:unknown";
  return `${resolutionId}:${requestId}`;
}

function actorForResolutionState(record, state) {
  if ( !state ) return null;
  if ( state.id === record.resolutionId ) return record.options.actor ?? null;
  return lookupActorForState(record, state);
}

function lookupActorForState(record, state) {
  const refs = stateSourceRefs(state);
  const sources = [
    record.services?.actorsByActor,
    record.options?.actorsByActor,
    record.services?.targetActors,
    record.options?.targetActors,
    record.services?.reactions?.actorsByActor,
    record.services?.reactions?.actorDocumentsByActor,
    record.services?.reactions?.actorSystemsByActor
  ];
  for ( const source of sources ) {
    const actor = lookupActorMap(source, refs);
    if ( actor?.system ) return actor;
  }
  return null;
}

function actionForResolutionState(record, state) {
  if ( !state ) return record.options.action ?? null;
  if ( state.id === record.resolutionId ) return record.options.action ?? state.input?.action ?? actionFromStateDefinition(state);
  return state.input?.action ?? actionFromStateDefinition(state) ?? null;
}

function actionFromStateDefinition(state) {
  const definition = state?.actionDefinition ?? null;
  if ( !definition ) return null;
  return {
    id: stringOrNull(state.input?.action?.id ?? definition.id),
    uuid: stringOrNull(state.input?.action?.uuid ?? definition.uuid ?? definition.ref ?? definition.id),
    type: stringOrNull(state.input?.action?.type) ?? "action",
    name: stringOrNull(state.input?.action?.name ?? definition.label ?? definition.name ?? definition.id) ?? "Action",
    system: {
      ...(state.input?.action?.system ?? {}),
      definition
    }
  };
}

function sourceControllerUserIdsForRequest(record, request, state=null) {
  const perRequest = record.requestContext.sourceControllerUserIdsByRequestId?.[request.id];
  if ( perRequest ) return uniqueStrings(perRequest);
  const refs = uniqueStrings([
    ...requestSourceRefs(request),
    ...stateSourceRefs(state)
  ]);
  const perSource = lookupControllerUserIds(record.requestContext.sourceControllerUserIdsBySourceRef, refs);
  if ( perSource.length ) return perSource;
  const reactionSource = lookupControllerUserIds(record.services?.reactions?.controllerUserIdsByActor, refs);
  if ( reactionSource.length ) return reactionSource;
  const targetFallback = lookupControllerUserIds(record.requestContext.targetControllerUserIdsByTargetRef, refs);
  if ( targetFallback.length ) return targetFallback;
  return uniqueStrings(record.requestContext.sourceControllerUserIds ?? []);
}

function targetControllerUserIdsForRequest(record, request, state=null) {
  const perRequest = record.requestContext.targetControllerUserIdsByRequestId?.[request.id];
  if ( perRequest ) return uniqueStrings(perRequest);
  const refs = uniqueStrings([
    ...requestTargetRefs(request),
    ...requestSourceRefs(request),
    ...stateSourceRefs(state)
  ]);
  const perTarget = lookupControllerUserIds(record.requestContext.targetControllerUserIdsByTargetRef, refs);
  if ( perTarget.length ) return perTarget;
  return uniqueStrings(record.requestContext.targetControllerUserIds ?? []);
}

function requestSourceRefs(request) {
  return uniqueStrings([
    ...refsFromObject(request?.source),
    ...refsFromObject(request?.payload?.source),
    ...refsFromObject(request?.payload?.rollRequest?.source),
    ...refsFromObject(request?.metadata?.source)
  ]);
}

function requestTargetRefs(request) {
  const targets = [
    request?.target,
    request?.payload?.target,
    request?.payload?.rollRequest?.target,
    ...(Array.isArray(request?.targets) ? request.targets : []),
    ...(Array.isArray(request?.payload?.targets) ? request.payload.targets : [])
  ];
  return uniqueStrings(targets.flatMap(refsFromObject));
}

function stateSourceRefs(state) {
  return uniqueStrings([
    ...refsFromObject(state?.source),
    ...refsFromObject(state?.input?.source),
    ...refsFromObject(state?.actionContext?.source)
  ]);
}

function refsFromObject(value) {
  if ( !value || typeof value !== "object" ) return [];
  const actorId = stringOrNull(value.actorId ?? value.id);
  return uniqueStrings([
    actorId,
    actorId ? `actor:${actorId}` : null,
    value.actorRef,
    value.ref,
    value.uuid
  ]);
}

function lookupControllerUserIds(source, refs) {
  const value = lookupByRefs(source, refs);
  return uniqueStrings(value);
}

function lookupActorMap(source, refs) {
  const value = lookupByRefs(source, refs);
  if ( value ) return value;
  if ( source?.system && actorMatchesRefs(source, refs) ) return source;
  if ( Array.isArray(source) ) return source.find(entry => actorMatchesRefs(entry, refs)) ?? null;
  return null;
}

function lookupByRefs(source, refs) {
  if ( !source ) return null;
  const keys = expandedRefKeys(refs);
  if ( typeof source === "function" ) {
    for ( const key of keys ) {
      const value = source({actorId: key.replace(/^actor:/, ""), actorRef: key, ref: key, uuid: key});
      if ( value ) return value;
    }
    return null;
  }
  if ( source instanceof Map ) {
    for ( const key of keys ) {
      const value = source.get(key);
      if ( value ) return value;
    }
    return null;
  }
  if ( typeof source !== "object" || Array.isArray(source) ) return null;
  for ( const key of keys ) {
    const value = source[key];
    if ( value ) return value;
  }
  return null;
}

function actorMatchesRefs(actor, refs) {
  if ( !actor ) return false;
  const actorRefs = expandedRefKeys([
    actor.id,
    actor.actorId,
    actor.uuid,
    actor.actorRef,
    actor.ref
  ]);
  return expandedRefKeys(refs).some(ref => actorRefs.includes(ref));
}

function expandedRefKeys(refs) {
  return uniqueStrings(normalizeArray(refs).flatMap(ref => {
    const value = stringOrNull(ref);
    if ( !value ) return [];
    const withoutActorPrefix = value.replace(/^actor:/, "");
    return [
      value,
      withoutActorPrefix,
      `actor:${withoutActorPrefix}`
    ];
  }));
}

function uniqueStrings(values=[]) {
  return [...new Set(normalizeArray(values).map(stringOrNull).filter(Boolean))];
}

function normalizeArray(value) {
  if ( value == null ) return [];
  return Array.isArray(value) ? value : [value];
}

function isTerminalState(state) {
  return [
    RESOLUTION_STATE_STATUS.COMPLETED,
    RESOLUTION_STATE_STATUS.FAILED,
    RESOLUTION_STATE_STATUS.CANCELLED
  ].includes(state?.status);
}

function failure(code, reason, data={}) {
  return {
    ok: false,
    code,
    reason,
    ...clonePlainData(data, "failure")
  };
}

async function evaluateLocalCommitPermission(canCommitLocally, context) {
  if ( typeof canCommitLocally === "function" ) return await canCommitLocally(context) === true;
  return canCommitLocally === true;
}

function createResolutionId(prefix) {
  return `${prefix}:${Math.random().toString(36).slice(2, 10)}`;
}

function stringOrNull(value) {
  if ( value == null ) return null;
  const string = String(value).trim();
  return string ? string : null;
}
