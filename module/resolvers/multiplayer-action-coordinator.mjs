import {
  RESOLUTION_REQUEST_TYPES,
  RESOLUTION_STATE_STATUS,
  cancelResolutionState,
  createResolutionState
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
      resultSent: false
    };
    records.set(record.resolutionId, record);
    return advanceRecord(record);
  }

  async function advanceRecord(record) {
    while ( true ) {
      if ( record.state?.pendingRequests?.length ) return routePendingRequests(record);
      if ( record.state?.status === RESOLUTION_STATE_STATUS.READY_TO_COMMIT ) {
        const committed = await executeStagedActionResolution({
          ...record.options,
          state: record.state,
          services: record.services,
          authority: commitAuthorityForUser({
            userId: localUserId,
            users: userDirectory(),
            activeGMUserId: activeGMId(),
            canCommit: record.localCommitAllowed
          }),
          persistencePort: record.options.persistencePort
        });
        record.state = committed.state;
        if ( !committed.ok ) return sendAuthorityError(record, committed);
        continue;
      }
      if ( isTerminalState(record.state) ) return sendResolutionResult(record, {ok: record.state.status === RESOLUTION_STATE_STATUS.COMPLETED});
      if ( record.state == null ) {
        const planned = planStagedActionResolution({
          ...record.options,
          services: record.services
        });
        record.state = planned.state;
        if ( !planned.ok && !planned.waiting ) return sendAuthorityError(record, planned);
        continue;
      }
      return {
        ok: true,
        code: MULTIPLAYER_AUTHORITY_CODES.WAITING,
        state: record.state
      };
    }
  }

  async function routePendingRequests(record) {
    const requests = record.state.pendingRequests ?? [];
    for ( const request of requests ) {
      if ( record.routedRequestIds.has(request.id) ) continue;
      const chooser = resolveRequestChooser({
        request,
        users: userDirectory(),
        initiatorUserId: record.initiatorUserId,
        authorityUserId: record.authorityUserId,
        activeGMUserId: activeGMId(),
        sourceControllerUserIds: record.requestContext.sourceControllerUserIds ?? [],
        targetControllerUserIds: targetControllerUserIdsForRequest(record, request),
        allowGMFallback: record.requestContext.allowGMRequestFallback ?? allowGMRequestFallback
      });
      if ( !chooser.ok ) {
        record.state = cancelResolutionState(record.state, {
          stageId: request.stageId,
          code: MULTIPLAYER_AUTHORITY_CODES.REQUEST_AUTHORITY_UNAVAILABLE,
          reason: chooser.reason,
          data: {requestId: request.id, requestType: request.type, chooser}
        });
        return sendAuthorityError(record, chooser, {requestId: request.id});
      }
      record.requestExpectations.set(request.id, {
        request: clonePlainData(request, "pendingRequest"),
        expectedUserId: chooser.userId,
        chooser
      });
      record.routedRequestIds.add(request.id);

      if ( chooser.userId === localUserId ) {
        const answered = await answerPendingRequestLocally({
          request,
          promptPorts,
          rollProviders,
          context: localRequestContext(record, request)
        });
        if ( !answered.ok ) return sendAuthorityError(record, answered, {requestId: request.id});
        const localEnvelope = createResolutionSocketEnvelope({
          messageType: MULTIPLAYER_MESSAGE_TYPES.REQUEST_RESPONSE,
          senderUserId: localUserId,
          recipientUserId: localUserId,
          resolutionId: record.resolutionId,
          requestId: request.id,
          payload: {response: answered.response}
        });
        return applyRequestResponse(record, localEnvelope);
      }

      const envelope = createResolutionSocketEnvelope({
        messageType: MULTIPLAYER_MESSAGE_TYPES.PENDING_REQUEST,
        senderUserId: localUserId,
        recipientUserId: chooser.userId,
        resolutionId: record.resolutionId,
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
          stateStatus: record.state.status
        }
      });
      const sent = await sendEnvelope(envelope);
      if ( !sent.ok ) return sendAuthorityError(record, sent, {requestId: request.id});
    }
    return {
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.REQUEST_ROUTED,
      state: record.state,
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
    const record = records.get(envelope.resolutionId);
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
    const validation = validateRequestResponse(record, envelope, response);
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

    const resumed = resumeStagedActionResolution({
      state: record.state,
      response,
      services: record.services
    });
    record.state = resumed.state;
    if ( !resumed.ok && !resumed.waiting ) return sendAuthorityError(record, resumed, {requestId: response.requestId});
    record.processedRequestIds.add(response.requestId);
    return advanceRecord(record);
  }

  function validateRequestResponse(record, envelope, response) {
    const requestId = stringOrNull(response.requestId ?? envelope.requestId);
    if ( !requestId ) return failure(MULTIPLAYER_AUTHORITY_CODES.REQUEST_MISMATCH, "REQUEST_RESPONSE is missing requestId.");
    if ( record.processedRequestIds.has(requestId) ) return {
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.DUPLICATE_REQUEST_RESPONSE,
      duplicate: true,
      reason: "Request response was already processed."
    };
    const pending = (record.state?.pendingRequests ?? []).find(request => request.id === requestId);
    if ( !pending ) return failure(MULTIPLAYER_AUTHORITY_CODES.REQUEST_NOT_PENDING, "Resolution request is not currently pending.");
    const expectation = record.requestExpectations.get(requestId);
    if ( !expectation ) return failure(MULTIPLAYER_AUTHORITY_CODES.REQUEST_NOT_PENDING, "No routed request expectation exists.");
    if ( expectation.expectedUserId !== envelope.senderUserId ) {
      return failure(MULTIPLAYER_AUTHORITY_CODES.WRONG_USER, "Request response came from a user who was not the expected chooser.", {
        expectedUserId: expectation.expectedUserId,
        senderUserId: envelope.senderUserId
      });
    }
    if ( response.resolutionId !== record.resolutionId ) return failure(MULTIPLAYER_AUTHORITY_CODES.REQUEST_MISMATCH, "Response resolutionId does not match the authoritative state.");
    if ( response.type !== pending.type ) return failure(MULTIPLAYER_AUTHORITY_CODES.REQUEST_MISMATCH, "Response request type does not match the pending request.");
    return {
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.OK,
      request: pending,
      expectation
    };
  }

  async function receiveResolutionCancel(envelope) {
    const record = records.get(envelope.resolutionId);
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
    record.state = cancelResolutionState(record.state ?? createResolutionState({id: record.resolutionId}), {
      code: MULTIPLAYER_AUTHORITY_CODES.CANCELLED,
      reason: envelope.payload?.reason ?? "Resolution cancelled by socket request.",
      data: {senderUserId: envelope.senderUserId}
    });
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

  function localRequestContext(record, request) {
    return {
      ...promptContext,
      ...rollContext,
      currentUserId: localUserId,
      users: userDirectory(),
      resolutionId: record.resolutionId,
      requestId: request.id
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

function targetControllerUserIdsForRequest(record, request) {
  const perRequest = record.requestContext.targetControllerUserIdsByRequestId?.[request.id];
  if ( perRequest ) return perRequest;
  const rollTargetRefs = [
    request.payload?.rollRequest?.target?.actorId,
    request.payload?.rollRequest?.target?.actorRef,
    request.payload?.rollRequest?.target?.uuid,
    request.payload?.rollRequest?.source?.actorId,
    request.payload?.rollRequest?.source?.actorRef,
    request.payload?.rollRequest?.source?.uuid
  ].filter(Boolean).map(String);
  for ( const [targetRef, userIds] of Object.entries(record.requestContext.targetControllerUserIdsByTargetRef ?? {}) ) {
    if ( rollTargetRefs.includes(targetRef) || rollTargetRefs.includes(targetRef.replace(/^actor:/, "")) ) return userIds;
  }
  return record.requestContext.targetControllerUserIds ?? [];
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
