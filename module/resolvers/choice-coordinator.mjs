import {
  RESOLUTION_PIPELINE_CODES,
  RESOLUTION_REQUEST_TYPES,
  cancelResolutionState,
  createResolutionState,
  resumeResolutionPipeline
} from "../helpers/resolution-state.mjs";
import {
  ROLL_CODES,
  ROLL_PROVENANCE_TYPES,
  createRollResultFromManualInput,
  normalizeRollResponseValue
} from "../helpers/rolls.mjs";
import {clonePromptData, createPromptViewModel} from "../helpers/prompt-view-models.mjs";

export const PROMPT_PORT_OUTCOMES = Object.freeze({
  RESPONSE: "response",
  DECLINED: "declined",
  CANCELLED: "cancelled",
  FAILURE: "failure",
  UNHANDLED: "unhandled"
});

export const CHOICE_COORDINATOR_CODES = Object.freeze({
  OK: "OK",
  WAITING: RESOLUTION_PIPELINE_CODES.WAITING,
  NO_PENDING_REQUEST: RESOLUTION_PIPELINE_CODES.NO_PENDING_REQUEST,
  NO_PROMPT_PORT_AVAILABLE: "NO_PROMPT_PORT_AVAILABLE",
  PROMPT_PORT_FAILURE: "PROMPT_PORT_FAILURE",
  PROMPT_CANCELLED: "PROMPT_CANCELLED",
  REQUIRED_REQUEST_CANCELLED: "REQUIRED_REQUEST_CANCELLED",
  OPTIONAL_CHOICE_DECLINED: "OPTIONAL_CHOICE_DECLINED",
  REQUEST_MISMATCH: RESOLUTION_PIPELINE_CODES.REQUEST_MISMATCH,
  WRONG_RESPONSE_TYPE: "WRONG_RESPONSE_TYPE",
  STALE_REQUEST: "STALE_REQUEST",
  REMOTE_AUTHORITY_REQUIRED: "REMOTE_AUTHORITY_REQUIRED",
  NON_SERIALIZABLE_PROMPT_DATA: "NON_SERIALIZABLE_PROMPT_DATA",
  INVALID_PROMPT_RESULT: "INVALID_PROMPT_RESULT"
});

/* -------------------------------------------- */

export function createChoiceCoordinator({
  promptPorts=[],
  context={},
  resume=resumeResolutionPipeline,
  stages=[],
  services={},
  queuePrompts=true,
  cancelRequiredRequests=true
}={}) {
  const ports = normalizePromptPorts(promptPorts);
  const queues = new Map();
  return {
    promptPorts: ports,
    async coordinate(options={}) {
      const selected = selectPendingResolutionRequest({
        state: options.state,
        request: options.request,
        requestId: options.requestId
      });
      if ( !selected.ok ) return selected;

      const mergedContext = {
        ...context,
        ...(options.context ?? {})
      };
      const task = () => coordinateResolutionPrompt({
        ...options,
        state: selected.state,
        request: selected.request,
        promptPorts: options.promptPorts ?? ports,
        context: mergedContext,
        resume: options.resume ?? resume,
        stages: options.stages ?? stages,
        services: options.services ?? services,
        cancelRequiredRequests: options.cancelRequiredRequests ?? cancelRequiredRequests
      });

      if ( !queuePrompts || options.queuePrompts === false ) return task();
      return enqueuePrompt(queues, promptQueueKey(selected.request, mergedContext), task);
    },
    selectRequest(options={}) {
      return selectPendingResolutionRequest(options);
    },
    queueSize() {
      return queues.size;
    }
  };
}

/* -------------------------------------------- */

export async function coordinateResolutionPrompt({
  state,
  request=null,
  requestId=null,
  promptPorts=[],
  context={},
  resume=resumeResolutionPipeline,
  stages=[],
  services={},
  cancelRequiredRequests=true
}={}) {
  const selected = selectPendingResolutionRequest({state, request, requestId});
  if ( !selected.ok ) return selected;
  const current = selected.state;
  const pendingRequest = selected.request;

  if ( current.requestResponses?.[pendingRequest.id] ) {
    return coordinatorFailure({
      code: CHOICE_COORDINATOR_CODES.STALE_REQUEST,
      reason: "Pending request already has an accepted response.",
      state: current,
      request: pendingRequest
    });
  }

  const authority = evaluateLocalAuthority(pendingRequest, context);
  if ( !authority.ok ) {
    return coordinatorFailure({
      code: CHOICE_COORDINATOR_CODES.REMOTE_AUTHORITY_REQUIRED,
      status: PROMPT_PORT_OUTCOMES.UNHANDLED,
      reason: authority.reason,
      state: current,
      request: pendingRequest,
      data: {authority}
    });
  }

  const selection = selectPromptPort({
    request: pendingRequest,
    state: current,
    promptPorts,
    context
  });
  if ( !selection.ok ) return {
    ...selection,
    state: current,
    request: pendingRequest
  };

  const viewModel = createPromptViewModel(pendingRequest, {state: current});
  let promptResult;
  try {
    promptResult = await selection.port.request(pendingRequest, {
      ...context,
      state: current,
      viewModel,
      promptPort: selection.port
    });
  } catch (error) {
    return coordinatorFailure({
      code: CHOICE_COORDINATOR_CODES.PROMPT_PORT_FAILURE,
      reason: error?.message ?? String(error),
      state: current,
      request: pendingRequest,
      port: selection.port
    });
  }

  const normalized = normalizePromptPortResult(promptResult, {
    request: pendingRequest,
    port: selection.port
  });
  if ( !normalized.ok && normalized.status !== PROMPT_PORT_OUTCOMES.CANCELLED ) {
    return coordinatorFailure({
      code: normalized.code ?? CHOICE_COORDINATOR_CODES.PROMPT_PORT_FAILURE,
      status: normalized.status,
      reason: normalized.reason,
      state: current,
      request: pendingRequest,
      port: selection.port,
      data: {promptResult: normalized}
    });
  }

  const correlation = validatePromptCorrelation(pendingRequest, normalized);
  if ( !correlation.ok ) {
    return coordinatorFailure({
      code: correlation.code,
      reason: correlation.reason,
      state: current,
      request: pendingRequest,
      port: selection.port,
      data: {promptResult: normalized}
    });
  }

  if ( normalized.status === PROMPT_PORT_OUTCOMES.CANCELLED ) {
    if ( cancelRequiredRequests && requestRequired(pendingRequest) ) {
      const cancelled = cancelResolutionState(current, {
        stageId: pendingRequest.stageId,
        code: CHOICE_COORDINATOR_CODES.REQUIRED_REQUEST_CANCELLED,
        reason: normalized.reason ?? "Required prompt was cancelled.",
        data: {
          requestId: pendingRequest.id,
          requestType: pendingRequest.type,
          promptPortId: selection.port.id
        }
      });
      return {
        ok: false,
        status: PROMPT_PORT_OUTCOMES.CANCELLED,
        code: CHOICE_COORDINATOR_CODES.REQUIRED_REQUEST_CANCELLED,
        reason: normalized.reason ?? "Required prompt was cancelled.",
        state: cancelled,
        request: pendingRequest,
        port: promptPortReference(selection.port)
      };
    }
    return coordinatorFailure({
      code: CHOICE_COORDINATOR_CODES.PROMPT_CANCELLED,
      status: PROMPT_PORT_OUTCOMES.CANCELLED,
      reason: normalized.reason ?? "Prompt was cancelled.",
      state: current,
      request: pendingRequest,
      port: selection.port
    });
  }

  const preparedValue = preparePromptResponseValue({
    request: pendingRequest,
    value: normalized.status === PROMPT_PORT_OUTCOMES.DECLINED
      ? {declined: true}
      : normalized.value,
    promptResult: normalized,
    port: selection.port
  });
  if ( !preparedValue.ok ) {
    return coordinatorFailure({
      code: preparedValue.code,
      reason: preparedValue.reason,
      state: current,
      request: pendingRequest,
      port: selection.port,
      data: preparedValue
    });
  }

  const response = {
    resolutionId: normalized.resolutionId ?? pendingRequest.resolutionId ?? current.id,
    requestId: normalized.requestId ?? pendingRequest.id,
    type: normalized.type ?? pendingRequest.type,
    value: preparedValue.value,
    metadata: {
      ...(clonePromptData(normalized.metadata ?? {}, "prompt.metadata") ?? {}),
      prompt: {
        status: normalized.status,
        responseType: normalized.responseType ?? pendingRequest.expectedResponseType,
        promptPortId: selection.port.id
      }
    }
  };

  let resumed;
  try {
    resumed = await resume({
      state: current,
      response,
      stages,
      services
    });
  } catch (error) {
    return coordinatorFailure({
      code: CHOICE_COORDINATOR_CODES.PROMPT_PORT_FAILURE,
      reason: error?.message ?? String(error),
      state: current,
      request: pendingRequest,
      port: selection.port,
      data: {response}
    });
  }

  return {
    ...resumed,
    status: normalized.status,
    code: resumed.ok ? (normalized.status === PROMPT_PORT_OUTCOMES.DECLINED
      ? CHOICE_COORDINATOR_CODES.OPTIONAL_CHOICE_DECLINED
      : CHOICE_COORDINATOR_CODES.OK) : resumed.code,
    request: pendingRequest,
    response,
    port: promptPortReference(selection.port),
    promptResult: normalized
  };
}

/* -------------------------------------------- */

export function selectPendingResolutionRequest({state, request=null, requestId=null}={}) {
  let current;
  try {
    current = createResolutionState(state);
  } catch (error) {
    return coordinatorFailure({
      code: CHOICE_COORDINATOR_CODES.NON_SERIALIZABLE_PROMPT_DATA,
      reason: error?.message ?? String(error),
      state: null,
      request: null
    });
  }
  const pending = current.pendingRequests ?? [];
  if ( !pending.length ) return coordinatorFailure({
    code: CHOICE_COORDINATOR_CODES.NO_PENDING_REQUEST,
    reason: "Resolution has no pending request to coordinate.",
    state: current,
    request: null
  });
  const requestedId = requestId ?? request?.id ?? null;
  const selected = requestedId
    ? pending.find(candidate => candidate.id === requestedId)
    : pending[0];
  if ( !selected ) return coordinatorFailure({
    code: CHOICE_COORDINATOR_CODES.NO_PENDING_REQUEST,
    reason: `Pending request not found: ${requestedId}`,
    state: current,
    request: request ?? null
  });
  return {
    ok: true,
    code: CHOICE_COORDINATOR_CODES.OK,
    state: current,
    request: selected
  };
}

export function selectPromptPort({request, state=null, promptPorts=[], context={}}={}) {
  const ports = normalizePromptPorts(promptPorts);
  const desiredId = stringOrNull(context.promptPortId ?? request?.metadata?.promptPortId ?? request?.payload?.promptPortId);
  if ( desiredId ) {
    const desired = ports.find(port => port.id === desiredId);
    if ( !desired ) return coordinatorFailure({
      code: CHOICE_COORDINATOR_CODES.NO_PROMPT_PORT_AVAILABLE,
      reason: `PromptPort not registered: ${desiredId}`,
      state,
      request
    });
    return {ok: true, code: CHOICE_COORDINATOR_CODES.OK, port: desired};
  }

  for ( const port of ports ) {
    if ( promptPortCanHandle(port, request, {state, ...context}) ) {
      return {ok: true, code: CHOICE_COORDINATOR_CODES.OK, port};
    }
  }
  return coordinatorFailure({
    code: CHOICE_COORDINATOR_CODES.NO_PROMPT_PORT_AVAILABLE,
    reason: "No PromptPort can handle the pending request.",
    state,
    request
  });
}

export function validatePromptCorrelation(request, result) {
  if ( result.requestId !== request.id ) return {
    ok: false,
    code: CHOICE_COORDINATOR_CODES.REQUEST_MISMATCH,
    reason: "Prompt response request id does not match the pending request."
  };
  if ( request.resolutionId && result.resolutionId && result.resolutionId !== request.resolutionId ) {
    return {
      ok: false,
      code: CHOICE_COORDINATOR_CODES.REQUEST_MISMATCH,
      reason: "Prompt response resolution id does not match the pending request."
    };
  }
  if ( result.type !== request.type ) return {
    ok: false,
    code: CHOICE_COORDINATOR_CODES.REQUEST_MISMATCH,
    reason: "Prompt response request type does not match the pending request."
  };
  if ( request.expectedResponseType && result.responseType && request.expectedResponseType !== result.responseType ) {
    return {
      ok: false,
      code: CHOICE_COORDINATOR_CODES.WRONG_RESPONSE_TYPE,
      reason: "Prompt response type does not match the expected response type."
    };
  }
  return {ok: true, code: CHOICE_COORDINATOR_CODES.OK, reason: null};
}

/* -------------------------------------------- */

function normalizePromptPortResult(result, {request, port}) {
  if ( result == null ) return {
    ok: false,
    status: PROMPT_PORT_OUTCOMES.FAILURE,
    code: CHOICE_COORDINATOR_CODES.INVALID_PROMPT_RESULT,
    reason: "PromptPort returned no result.",
    requestId: request.id,
    resolutionId: request.resolutionId,
    type: request.type,
    responseType: request.expectedResponseType,
    value: null,
    metadata: {}
  };
  const typed = isPromptPortResultLike(result);
  const source = typed ? result : {ok: true, status: PROMPT_PORT_OUTCOMES.RESPONSE, value: result};
  const status = normalizePromptStatus(source.status ?? (source.ok === false ? PROMPT_PORT_OUTCOMES.FAILURE : PROMPT_PORT_OUTCOMES.RESPONSE));
  return {
    ok: source.ok !== false && ![PROMPT_PORT_OUTCOMES.FAILURE, PROMPT_PORT_OUTCOMES.UNHANDLED].includes(status),
    status,
    code: source.code ?? codeForPromptStatus(status),
    reason: stringOrNull(source.reason),
    requestId: stringOrNull(source.requestId ?? source.id) ?? request.id,
    resolutionId: stringOrNull(source.resolutionId) ?? request.resolutionId,
    type: stringOrNull(source.type ?? source.requestType) ?? request.type,
    responseType: stringOrNull(source.responseType ?? source.expectedResponseType) ?? request.expectedResponseType,
    value: source.value ?? source.result ?? source.response ?? null,
    metadata: clonePromptData(source.metadata ?? {}, "promptResult.metadata") ?? {},
    port: promptPortReference(port)
  };
}

function preparePromptResponseValue({request, value, promptResult, port}) {
  try {
    if ( request.type !== RESOLUTION_REQUEST_TYPES.ROLL ) {
      return {
        ok: true,
        code: CHOICE_COORDINATOR_CODES.OK,
        value: clonePromptData(value, "response.value")
      };
    }
    return prepareRollResponseValue({request, value, promptResult, port});
  } catch (error) {
    return {
      ok: false,
      code: CHOICE_COORDINATOR_CODES.NON_SERIALIZABLE_PROMPT_DATA,
      reason: error?.message ?? String(error)
    };
  }
}

function prepareRollResponseValue({request, value, promptResult, port}) {
  const rollRequest = request.payload?.rollRequest ?? value?.request ?? value?.rollRequest ?? null;
  if ( !rollRequest ) return {
    ok: true,
    code: CHOICE_COORDINATOR_CODES.OK,
    value: clonePromptData(value, "response.value")
  };

  const raw = clonePromptData(value?.rollResult ?? value?.result ?? value, "rollPrompt.value");
  if ( raw && typeof raw === "object" && raw.requestId && raw.total != null && raw.provider ) {
    const normalized = normalizeRollResponseValue(raw, {request: rollRequest});
    if ( !normalized.ok ) return {
      ok: false,
      code: normalized.code,
      reason: normalized.reason,
      validation: normalized.validation
    };
    return {
      ok: true,
      code: CHOICE_COORDINATOR_CODES.OK,
      value: normalized.result
    };
  }

  const input = typeof raw === "object" && raw !== null
    ? {
      ...raw,
      requestId: raw.requestId ?? rollRequest.id,
      resolutionId: raw.resolutionId ?? rollRequest.resolutionId,
      type: raw.type ?? rollRequest.type
    }
    : {
      value: raw,
      requestId: rollRequest.id,
      resolutionId: rollRequest.resolutionId,
      type: rollRequest.type
    };
  const provenanceType = normalizeProvenanceType(
    input.provenanceType
      ?? input.mode
      ?? promptResult.metadata?.provenanceType
      ?? promptResult.metadata?.rollProvenanceType
      ?? port.type
  );
  const provider = {
    id: port.id,
    type: provenanceType,
    label: port.label ?? port.id
  };
  const created = createRollResultFromManualInput({
    request: rollRequest,
    input,
    provider,
    provenance: {
      type: provenanceType,
      providerId: port.id,
      method: input.inputMode ?? input.mode ?? null,
      source: "prompt-port"
    }
  });
  if ( !created.ok ) return {
    ok: false,
    code: created.code ?? ROLL_CODES.INVALID_MANUAL_RESULT,
    reason: created.reason,
    validation: created.validation ?? null
  };
  return {
    ok: true,
    code: CHOICE_COORDINATOR_CODES.OK,
    value: created.result
  };
}

function evaluateLocalAuthority(request, context) {
  const authority = normalizeAuthority(request.authority ?? request.chooser ?? request.payload?.rollRequest?.authority ?? request.payload?.rollRequest?.chooser);
  const kind = authority.kind;
  if ( !kind ) return {ok: true, kind: null, reason: null};
  const remoteKinds = uniqueStrings(context.remoteAuthorityKinds ?? []);
  if ( remoteKinds.includes(kind) ) return {
    ok: false,
    kind,
    reason: `Prompt requires remote authority: ${kind}`
  };
  if ( kind === "automatic" || kind === "local" ) return {ok: true, kind, reason: null};
  if ( kind === "gm" ) {
    const isGM = context.isGM === true || context.currentUser?.isGM === true;
    return isGM
      ? {ok: true, kind, reason: null}
      : {ok: false, kind, reason: "Prompt requires GM authority."};
  }
  if ( kind === "specific" ) {
    const currentRefs = uniqueStrings([
      context.currentUserId,
      context.currentUserRef,
      context.currentUser?.id,
      context.currentUser?.uuid
    ]);
    const expectedRefs = uniqueStrings([
      authority.userId,
      authority.userRef,
      authority.id,
      ...(authority.userIds ?? []),
      ...(authority.userRefs ?? [])
    ]);
    if ( expectedRefs.length && !expectedRefs.some(ref => currentRefs.includes(ref)) ) {
      return {ok: false, kind, reason: "Prompt requires a different specific user."};
    }
    return {ok: true, kind, reason: null};
  }
  const localKinds = uniqueStrings(context.localAuthorityKinds ?? context.authorityKinds ?? []);
  if ( localKinds.length ) return localKinds.includes(kind)
    ? {ok: true, kind, reason: null}
    : {ok: false, kind, reason: `Prompt authority is not local: ${kind}`};
  if ( context.enforceLocalAuthority === true ) return {
    ok: false,
    kind,
    reason: `Prompt authority could not be proven local: ${kind}`
  };
  return {ok: true, kind, reason: null};
}

function normalizeAuthority(authority) {
  if ( typeof authority === "string" ) return {kind: authority};
  if ( authority && typeof authority === "object" ) return {
    ...authority,
    kind: authority.kind ?? authority.type ?? authority.role ?? null
  };
  return {kind: null};
}

function normalizePromptPorts(promptPorts) {
  return normalizeArray(promptPorts).filter(port => {
    return port
      && typeof port.id === "string"
      && typeof port.request === "function";
  });
}

function promptPortCanHandle(port, request, context) {
  if ( typeof port.canHandle !== "function" ) return true;
  try {
    const result = port.canHandle(request, context);
    return typeof result === "object" ? result.ok !== false && result.value !== false : result !== false;
  } catch {
    return false;
  }
}

function requestRequired(request) {
  if ( request.validation?.required === false ) return false;
  if ( request.validation?.required === true ) return true;
  if ( normalizeArray(request.validation?.missingRequiredChoiceIds).length ) return true;
  if ( request.type === RESOLUTION_REQUEST_TYPES.ROLL ) return true;
  if ( request.type === RESOLUTION_REQUEST_TYPES.ACTION_CONFIGURATION ) return true;
  return request.metadata?.required === true;
}

function promptQueueKey(request, context) {
  const authority = normalizeAuthority(request.authority ?? request.chooser);
  const user = context.currentUserId ?? context.currentUser?.id ?? null;
  if ( user ) return `user:${user}`;
  if ( authority.kind ) return `authority:${authority.kind}`;
  return "local";
}

function enqueuePrompt(queues, key, task) {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => null).then(task);
  queues.set(key, next.finally(() => {
    if ( queues.get(key) === next ) queues.delete(key);
  }));
  return next;
}

function coordinatorFailure({
  code,
  status=PROMPT_PORT_OUTCOMES.FAILURE,
  reason=null,
  state=null,
  request=null,
  port=null,
  data={}
}={}) {
  return {
    ok: false,
    status,
    code,
    reason,
    state,
    request,
    port: port ? promptPortReference(port) : null,
    data
  };
}

function promptPortReference(port) {
  return port ? {
    id: port.id,
    type: port.type ?? null,
    label: port.label ?? port.id
  } : null;
}

function isPromptPortResultLike(value) {
  return value
    && typeof value === "object"
    && (
      value.ok != null
      || value.status != null
      || value.requestId != null
      || value.resolutionId != null
      || value.responseType != null
      || Object.hasOwn(value, "value")
      || Object.hasOwn(value, "result")
      || Object.hasOwn(value, "response")
    );
}

function normalizePromptStatus(status) {
  const token = String(status ?? PROMPT_PORT_OUTCOMES.RESPONSE).trim();
  return Object.values(PROMPT_PORT_OUTCOMES).includes(token)
    ? token
    : PROMPT_PORT_OUTCOMES.RESPONSE;
}

function codeForPromptStatus(status) {
  switch ( status ) {
    case PROMPT_PORT_OUTCOMES.DECLINED:
      return CHOICE_COORDINATOR_CODES.OPTIONAL_CHOICE_DECLINED;
    case PROMPT_PORT_OUTCOMES.CANCELLED:
      return CHOICE_COORDINATOR_CODES.PROMPT_CANCELLED;
    case PROMPT_PORT_OUTCOMES.FAILURE:
      return CHOICE_COORDINATOR_CODES.PROMPT_PORT_FAILURE;
    case PROMPT_PORT_OUTCOMES.UNHANDLED:
      return CHOICE_COORDINATOR_CODES.REMOTE_AUTHORITY_REQUIRED;
    case PROMPT_PORT_OUTCOMES.RESPONSE:
    default:
      return CHOICE_COORDINATOR_CODES.OK;
  }
}

function normalizeProvenanceType(value) {
  const token = String(value ?? "").trim();
  if ( Object.values(ROLL_PROVENANCE_TYPES).includes(token) ) return token;
  if ( token === "manual-roll" ) return ROLL_PROVENANCE_TYPES.MANUAL;
  if ( token === "physical-dice" ) return ROLL_PROVENANCE_TYPES.PHYSICAL;
  return ROLL_PROVENANCE_TYPES.MANUAL;
}

function normalizeArray(value) {
  if ( value == null ) return [];
  return Array.isArray(value) ? value : [value];
}

function uniqueStrings(values) {
  return [...new Set(normalizeArray(values).filter(value => value != null && value !== "").map(String))];
}

function stringOrNull(value) {
  if ( value == null ) return null;
  const string = String(value).trim();
  return string ? string : null;
}
