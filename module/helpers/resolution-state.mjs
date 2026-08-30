export const RESOLUTION_STATE_SCHEMA_VERSION = 1;

export const RESOLUTION_STATE_STATUS = Object.freeze({
  CREATED: "created",
  RUNNING: "running",
  AWAITING_CONFIGURATION: "awaiting-configuration",
  AWAITING_TARGETS: "awaiting-targets",
  AWAITING_ROLL: "awaiting-roll",
  AWAITING_CHOICE: "awaiting-choice",
  PAUSED: "paused",
  READY_TO_COMMIT: "ready-to-commit",
  COMMITTING: "committing",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
});

export const RESOLUTION_STAGE_STATUS = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  WAITING: "waiting",
  COMPLETED: "completed",
  SKIPPED: "skipped",
  FAILED: "failed",
  CANCELLED: "cancelled"
});

export const RESOLUTION_STAGE_RESULT = Object.freeze({
  CONTINUE: "continue",
  WAIT: "wait",
  FAIL: "fail",
  COMPLETE: "complete"
});

export const RESOLUTION_REQUEST_TYPES = Object.freeze({
  ACTION_CONFIGURATION: "action-configuration",
  TARGET_SELECTION: "target-selection",
  TARGET_REFINEMENT: "target-refinement",
  ROLL: "roll",
  REACTION_CHOICE: "reaction-choice",
  CHOICE: "choice"
});

export const RESOLUTION_PIPELINE_CODES = Object.freeze({
  OK: "OK",
  WAITING: "WAITING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  INVALID_STAGE: "INVALID_STAGE",
  INVALID_STAGE_RESULT: "INVALID_STAGE_RESULT",
  INVALID_RESOLUTION_STATE: "INVALID_RESOLUTION_STATE",
  NO_PENDING_REQUEST: "NO_PENDING_REQUEST",
  REQUEST_MISMATCH: "REQUEST_MISMATCH",
  DEPTH_LIMIT_EXCEEDED: "DEPTH_LIMIT_EXCEEDED",
  REPEATED_TRIGGER: "REPEATED_TRIGGER",
  NON_SERIALIZABLE_STATE: "NON_SERIALIZABLE_STATE"
});

const TERMINAL_STATUSES = new Set([
  RESOLUTION_STATE_STATUS.COMPLETED,
  RESOLUTION_STATE_STATUS.FAILED,
  RESOLUTION_STATE_STATUS.CANCELLED
]);

let nextResolutionSequence = 1;
let nextRequestSequence = 1;

/* -------------------------------------------- */

export function createResolutionState({
  schemaVersion=RESOLUTION_STATE_SCHEMA_VERSION,
  id=null,
  parentId=null,
  relationship=null,
  sourceEvent=null,
  depth=0,
  maxDepth=8,
  ancestry=[],
  triggerIdentities=[],
  actionDefinition=null,
  source=null,
  origin=null,
  actionContext=null,
  configuration=null,
  targets=[],
  targetSet=null,
  targetRefinement=null,
  rollRequests=[],
  rollResults=[],
  outcomes={},
  results={},
  pendingRequests=[],
  requestResponses={},
  responses=[],
  mutationPlans=[],
  events=[],
  currentStageId=null,
  completedStageIds=[],
  stageStatuses={},
  status=RESOLUTION_STATE_STATUS.CREATED,
  trace=[],
  validation=[],
  errors=[],
  warnings=[],
  input={},
  metadata={}
}={}) {
  const stateId = stringOrDefault(id, createResolutionId());
  const state = {
    schemaVersion,
    id: stateId,
    parentId: stringOrNull(parentId),
    relationship: stringOrNull(relationship),
    sourceEvent: cloneSerializable(sourceEvent, "sourceEvent"),
    depth: finiteNumber(depth) ?? 0,
    maxDepth: finiteNumber(maxDepth) ?? 8,
    ancestry: normalizeArray(ancestry).map((entry, index) => cloneSerializable(entry, `ancestry.${index}`)),
    triggerIdentities: uniqueStrings(triggerIdentities),
    actionDefinition: cloneSerializable(actionDefinition, "actionDefinition"),
    source: cloneSerializable(source, "source"),
    origin: cloneSerializable(origin, "origin"),
    actionContext: cloneSerializable(actionContext, "actionContext"),
    configuration: cloneSerializable(configuration, "configuration"),
    targets: normalizeArray(targets).map((target, index) => cloneSerializable(target, `targets.${index}`)),
    targetSet: cloneSerializable(targetSet, "targetSet"),
    targetRefinement: cloneSerializable(targetRefinement, "targetRefinement"),
    rollRequests: normalizeArray(rollRequests).map((request, index) => cloneSerializable(request, `rollRequests.${index}`)),
    rollResults: normalizeArray(rollResults).map((result, index) => cloneSerializable(result, `rollResults.${index}`)),
    outcomes: cloneSerializable(outcomes, "outcomes") ?? {},
    results: cloneSerializable(results, "results") ?? {},
    pendingRequests: normalizeArray(pendingRequests).map((request, index) => normalizeResolutionRequest(request, {
      resolutionId: stateId,
      path: `pendingRequests.${index}`
    })),
    requestResponses: cloneSerializable(requestResponses, "requestResponses") ?? {},
    responses: normalizeArray(responses).map((response, index) => cloneSerializable(response, `responses.${index}`)),
    mutationPlans: normalizeArray(mutationPlans).map((plan, index) => cloneSerializable(plan, `mutationPlans.${index}`)),
    events: normalizeArray(events).map((event, index) => cloneSerializable(event, `events.${index}`)),
    currentStageId: stringOrNull(currentStageId),
    completedStageIds: uniqueStrings(completedStageIds),
    stageStatuses: cloneSerializable(stageStatuses, "stageStatuses") ?? {},
    status,
    trace: normalizeArray(trace).map((entry, index) => cloneSerializable(entry, `trace.${index}`)),
    validation: normalizeArray(validation).map((entry, index) => cloneSerializable(entry, `validation.${index}`)),
    errors: normalizeArray(errors).map((entry, index) => cloneSerializable(entry, `errors.${index}`)),
    warnings: normalizeArray(warnings).map((entry, index) => cloneSerializable(entry, `warnings.${index}`)),
    input: cloneSerializable(input, "input") ?? {},
    metadata: cloneSerializable(metadata, "metadata") ?? {}
  };

  assertSerializable(state, "ResolutionState");
  return state;
}

/* -------------------------------------------- */

export function updateResolutionState(state, patch={}) {
  return createResolutionState({
    ...createResolutionState(state),
    ...patch
  });
}

/* -------------------------------------------- */

export function cancelResolutionState(state, {
  stageId=null,
  code=RESOLUTION_PIPELINE_CODES.CANCELLED,
  reason=null,
  data={}
}={}) {
  const current = createResolutionState(state);
  return updateResolutionState(current, {
    status: RESOLUTION_STATE_STATUS.CANCELLED,
    currentStageId: stageId ?? current.currentStageId,
    pendingRequests: [],
    stageStatuses: stageId
      ? {...current.stageStatuses, [stageId]: RESOLUTION_STAGE_STATUS.CANCELLED}
      : current.stageStatuses,
    warnings: [...current.warnings, {code, reason, data: cloneSerializable(data, "data")}],
    trace: [
      ...current.trace,
      createTraceEntry(current, {
        stageId,
        status: RESOLUTION_STAGE_STATUS.CANCELLED,
        result: RESOLUTION_STAGE_RESULT.FAIL,
        code,
        reason,
        data
      })
    ]
  });
}

/* -------------------------------------------- */

export function failResolutionState(state, {
  stageId=null,
  code=RESOLUTION_PIPELINE_CODES.FAILED,
  reason=null,
  errors=[],
  data={}
}={}) {
  const current = createResolutionState(state);
  const normalizedErrors = errors.length ? errors : [{code, reason, data}];
  return updateResolutionState(current, {
    status: RESOLUTION_STATE_STATUS.FAILED,
    currentStageId: stageId ?? current.currentStageId,
    pendingRequests: [],
    stageStatuses: stageId
      ? {...current.stageStatuses, [stageId]: RESOLUTION_STAGE_STATUS.FAILED}
      : current.stageStatuses,
    errors: [...current.errors, ...normalizedErrors.map((error, index) => cloneSerializable(error, `errors.${index}`))],
    trace: [
      ...current.trace,
      createTraceEntry(current, {
        stageId,
        status: RESOLUTION_STAGE_STATUS.FAILED,
        result: RESOLUTION_STAGE_RESULT.FAIL,
        code,
        reason,
        data
      })
    ]
  });
}

/* -------------------------------------------- */

export function createResolutionPipelineStage({
  id,
  canRun=null,
  run,
  metadata={}
}={}) {
  if ( !id ) throw new TypeError("Resolution pipeline stage requires a stable id.");
  if ( typeof run !== "function" ) throw new TypeError(`Resolution pipeline stage "${id}" requires a run function.`);
  if ( canRun != null && typeof canRun !== "function" ) {
    throw new TypeError(`Resolution pipeline stage "${id}" canRun must be a function when supplied.`);
  }

  return {
    id: String(id),
    canRun,
    run,
    metadata: cloneSerializable(metadata, "metadata") ?? {}
  };
}

/* -------------------------------------------- */

export function continueResolutionStage({
  state=null,
  status=null,
  data={},
  trace=null,
  nextStageId=null
}={}) {
  return createStageResult({
    type: RESOLUTION_STAGE_RESULT.CONTINUE,
    state,
    status,
    data,
    trace,
    nextStageId
  });
}

export function waitResolutionStage({
  state=null,
  status=null,
  request=null,
  requests=[],
  reason=null,
  data={},
  trace=null
}={}) {
  return createStageResult({
    type: RESOLUTION_STAGE_RESULT.WAIT,
    state,
    status,
    requests: request ? [request, ...normalizeArray(requests)] : requests,
    reason,
    data,
    trace
  });
}

export function failResolutionStage({
  state=null,
  code=RESOLUTION_PIPELINE_CODES.FAILED,
  reason=null,
  errors=[],
  data={},
  trace=null
}={}) {
  return createStageResult({
    type: RESOLUTION_STAGE_RESULT.FAIL,
    state,
    code,
    reason,
    errors,
    data,
    trace
  });
}

export function completeResolutionStage({
  state=null,
  status=RESOLUTION_STATE_STATUS.COMPLETED,
  code=RESOLUTION_PIPELINE_CODES.COMPLETED,
  data={},
  trace=null
}={}) {
  return createStageResult({
    type: RESOLUTION_STAGE_RESULT.COMPLETE,
    state,
    status,
    code,
    data,
    trace
  });
}

/* -------------------------------------------- */

export function createResolutionRequest({
  id=null,
  resolutionId=null,
  stageId=null,
  type=RESOLUTION_REQUEST_TYPES.CHOICE,
  expectedResponseType=null,
  validation={},
  chooser=null,
  authority=null,
  payload={},
  metadata={}
}={}) {
  return normalizeResolutionRequest({
    id: id ?? createRequestId(type, stageId),
    resolutionId,
    stageId,
    type,
    expectedResponseType,
    validation,
    chooser,
    authority,
    payload,
    metadata
  });
}

/* -------------------------------------------- */

export function runResolutionPipeline({
  state,
  stages=[],
  services={}
}={}) {
  let current = createResolutionState(state);
  const validation = validateResolutionStateSerializable(current);
  if ( !validation.ok ) {
    return pipelineResult(failResolutionState(current, {
      code: RESOLUTION_PIPELINE_CODES.NON_SERIALIZABLE_STATE,
      reason: validation.reason,
      data: validation
    }));
  }
  if ( TERMINAL_STATUSES.has(current.status) ) return pipelineResult(current);

  const preparedStages = normalizeStages(stages);
  if ( !preparedStages.ok ) {
    return pipelineResult(failResolutionState(current, {
      code: preparedStages.code,
      reason: preparedStages.reason,
      data: preparedStages
    }));
  }

  current = updateResolutionState(current, {
    status: RESOLUTION_STATE_STATUS.RUNNING,
    pendingRequests: []
  });

  for ( let index = firstRunnableStageIndex(current, preparedStages.stages); index < preparedStages.stages.length; index++ ) {
    const stage = preparedStages.stages[index];
    if ( current.completedStageIds.includes(stage.id) ) continue;

    const canRun = evaluateStageCanRun(stage, current, services);
    if ( !canRun.ok ) {
      current = failResolutionState(current, {
        stageId: stage.id,
        code: RESOLUTION_PIPELINE_CODES.FAILED,
        reason: canRun.reason,
        data: {stageId: stage.id}
      });
      return pipelineResult(current);
    }
    if ( !canRun.value ) {
      current = markStageSkipped(current, stage, canRun.reason);
      continue;
    }

    current = updateResolutionState(current, {
      currentStageId: stage.id,
      stageStatuses: {
        ...current.stageStatuses,
        [stage.id]: RESOLUTION_STAGE_STATUS.RUNNING
      }
    });

    const result = runStage(stage, current, services);
    if ( !result.ok ) {
      current = failResolutionState(current, {
        stageId: stage.id,
        code: result.code,
        reason: result.reason,
        data: result
      });
      return pipelineResult(current);
    }

    current = applyStageResult(current, stage, result.result, preparedStages.stages, index);
    if ( result.result.type !== RESOLUTION_STAGE_RESULT.CONTINUE ) return pipelineResult(current);
    const nextIndex = nextStageIndexFromResult(result.result, preparedStages.stages, index);
    if ( nextIndex != null ) index = nextIndex - 1;
  }

  if ( !TERMINAL_STATUSES.has(current.status) ) {
    current = updateResolutionState(current, {
      status: RESOLUTION_STATE_STATUS.COMPLETED,
      currentStageId: current.currentStageId ?? preparedStages.stages.at(-1)?.id ?? null,
      pendingRequests: []
    });
  }

  return pipelineResult(current);
}

/* -------------------------------------------- */

export function resumeResolutionPipeline({
  state,
  response,
  stages=[],
  services={}
}={}) {
  const current = createResolutionState(state);
  const pending = current.pendingRequests ?? [];
  if ( !pending.length ) {
    return {
      ok: false,
      code: RESOLUTION_PIPELINE_CODES.NO_PENDING_REQUEST,
      state: current,
      reason: "Resolution has no pending request to resume."
    };
  }

  const normalizedResponse = normalizeResolutionResponse(response);
  const matchingRequest = pending.find(request => requestMatchesResponse(request, normalizedResponse));
  if ( !matchingRequest ) {
    return {
      ok: false,
      code: RESOLUTION_PIPELINE_CODES.REQUEST_MISMATCH,
      state: current,
      reason: "Resolution response did not match any pending request.",
      request: normalizedResponse
    };
  }

  const remainingRequests = pending.filter(request => request.id !== matchingRequest.id);
  const nextRequestResponses = {
    ...current.requestResponses,
    [matchingRequest.id]: {
      request: cloneSerializable(matchingRequest, "request"),
      response: cloneSerializable(normalizedResponse, "response")
    }
  };
  const nextState = updateResolutionState(current, {
    status: remainingRequests.length
      ? statusForRequests(remainingRequests)
      : RESOLUTION_STATE_STATUS.RUNNING,
    pendingRequests: remainingRequests,
    requestResponses: nextRequestResponses,
    responses: [
      ...current.responses,
      {
        requestId: matchingRequest.id,
        resolutionId: current.id,
        type: matchingRequest.type,
        value: cloneSerializable(normalizedResponse.value, "response.value"),
        metadata: cloneSerializable(normalizedResponse.metadata, "response.metadata") ?? {}
      }
    ],
    trace: [
      ...current.trace,
      createTraceEntry(current, {
        stageId: matchingRequest.stageId,
        status: remainingRequests.length ? RESOLUTION_STAGE_STATUS.WAITING : RESOLUTION_STAGE_STATUS.RUNNING,
        result: remainingRequests.length ? RESOLUTION_STAGE_RESULT.WAIT : RESOLUTION_STAGE_RESULT.CONTINUE,
        code: remainingRequests.length ? RESOLUTION_PIPELINE_CODES.WAITING : RESOLUTION_PIPELINE_CODES.OK,
        reason: "Resolution response accepted.",
        requestIds: [matchingRequest.id],
        data: {
          responseType: normalizedResponse.type
        }
      })
    ]
  });

  if ( remainingRequests.length ) return pipelineResult(nextState);
  return runResolutionPipeline({state: nextState, stages, services});
}

/* -------------------------------------------- */

export function getResolutionResponse(state, {
  requestId=null,
  type=null,
  stageId=null
}={}) {
  const current = createResolutionState(state);
  const entries = Object.values(current.requestResponses ?? {});
  return entries.find(entry => {
    const request = entry?.request ?? {};
    if ( requestId != null && request.id !== requestId ) return false;
    if ( type != null && request.type !== type ) return false;
    if ( stageId != null && request.stageId !== stageId ) return false;
    return true;
  }) ?? null;
}

/* -------------------------------------------- */

export function createChildResolutionState(parentState, {
  id=null,
  relationship="child",
  sourceEvent=null,
  actionDefinition=null,
  actionContext=null,
  input={},
  metadata={},
  triggerIdentity=null,
  maxDepth=null
}={}) {
  const parent = createResolutionState(parentState);
  const nextDepth = parent.depth + 1;
  const allowedDepth = finiteNumber(maxDepth) ?? parent.maxDepth;
  const identity = stringOrNull(triggerIdentity ?? triggerIdentityFrom(sourceEvent, actionDefinition));
  if ( nextDepth > allowedDepth ) {
    return {
      ok: false,
      code: RESOLUTION_PIPELINE_CODES.DEPTH_LIMIT_EXCEEDED,
      reason: "Child resolution depth limit exceeded.",
      state: null
    };
  }
  if ( identity && parent.triggerIdentities.includes(identity) ) {
    return {
      ok: false,
      code: RESOLUTION_PIPELINE_CODES.REPEATED_TRIGGER,
      reason: "Child resolution would repeat an existing trigger identity.",
      state: null
    };
  }

  const state = createResolutionState({
    id,
    parentId: parent.id,
    relationship,
    sourceEvent,
    depth: nextDepth,
    maxDepth: allowedDepth,
    ancestry: [
      ...parent.ancestry,
      {
        id: parent.id,
        parentId: parent.parentId,
        relationship: parent.relationship,
        sourceEvent: parent.sourceEvent,
        depth: parent.depth
      }
    ],
    triggerIdentities: identity
      ? [...parent.triggerIdentities, identity]
      : parent.triggerIdentities,
    actionDefinition,
    actionContext,
    input,
    metadata: {
      ...cloneSerializable(metadata, "metadata"),
      parentResolutionId: parent.id
    }
  });

  return {
    ok: true,
    code: RESOLUTION_PIPELINE_CODES.OK,
    state
  };
}

/* -------------------------------------------- */

export function validateResolutionStateSerializable(state) {
  const failure = firstNonSerializable(state, "state", new WeakSet());
  if ( failure ) {
    return {
      ok: false,
      code: RESOLUTION_PIPELINE_CODES.NON_SERIALIZABLE_STATE,
      path: failure.path,
      reason: failure.reason
    };
  }
  return {
    ok: true,
    code: RESOLUTION_PIPELINE_CODES.OK,
    path: null,
    reason: null
  };
}

/* -------------------------------------------- */

function applyStageResult(current, stage, result, stages, index) {
  const base = result.state ? createResolutionState(result.state) : current;
  const trace = [
    ...base.trace,
    createTraceEntry(base, {
      stageId: stage.id,
      status: stageStatusForResult(result),
      result: result.type,
      code: result.code ?? RESOLUTION_PIPELINE_CODES.OK,
      reason: result.reason ?? null,
      requestIds: normalizeArray(result.requests).map(request => request.id).filter(Boolean),
      data: result.data ?? {}
    }),
    ...normalizeArray(result.trace).map((entry, traceIndex) => ({
      ...cloneSerializable(entry, `trace.${traceIndex}`),
      stageId: entry.stageId ?? stage.id
    }))
  ];

  if ( result.type === RESOLUTION_STAGE_RESULT.WAIT ) {
    const requests = normalizeArray(result.requests).map((request, requestIndex) => normalizeResolutionRequest(request, {
      resolutionId: base.id,
      stageId: stage.id,
      path: `requests.${requestIndex}`
    }));
    return updateResolutionState(base, {
      status: result.status ?? statusForRequests(requests),
      currentStageId: stage.id,
      pendingRequests: requests,
      stageStatuses: {
        ...base.stageStatuses,
        [stage.id]: RESOLUTION_STAGE_STATUS.WAITING
      },
      trace
    });
  }

  if ( result.type === RESOLUTION_STAGE_RESULT.FAIL ) {
    const normalizedErrors = normalizeArray(result.errors).length
      ? normalizeArray(result.errors)
      : [{code: result.code ?? RESOLUTION_PIPELINE_CODES.FAILED, reason: result.reason, data: result.data ?? {}}];
    return updateResolutionState(base, {
      status: RESOLUTION_STATE_STATUS.FAILED,
      currentStageId: stage.id,
      pendingRequests: [],
      stageStatuses: {
        ...base.stageStatuses,
        [stage.id]: RESOLUTION_STAGE_STATUS.FAILED
      },
      errors: [...base.errors, ...normalizedErrors.map((error, errorIndex) => cloneSerializable(error, `errors.${errorIndex}`))],
      trace
    });
  }

  if ( result.type === RESOLUTION_STAGE_RESULT.COMPLETE ) {
    return updateResolutionState(base, {
      status: result.status ?? RESOLUTION_STATE_STATUS.COMPLETED,
      currentStageId: stage.id,
      pendingRequests: [],
      completedStageIds: appendUnique(base.completedStageIds, stage.id),
      stageStatuses: {
        ...base.stageStatuses,
        [stage.id]: RESOLUTION_STAGE_STATUS.COMPLETED
      },
      trace
    });
  }

  return updateResolutionState(base, {
    status: result.status ?? RESOLUTION_STATE_STATUS.RUNNING,
    currentStageId: stages[index + 1]?.id ?? stage.id,
    pendingRequests: [],
    completedStageIds: appendUnique(base.completedStageIds, stage.id),
    stageStatuses: {
      ...base.stageStatuses,
      [stage.id]: RESOLUTION_STAGE_STATUS.COMPLETED
    },
    trace
  });
}

function createStageResult({
  type,
  state=null,
  status=null,
  code=RESOLUTION_PIPELINE_CODES.OK,
  reason=null,
  requests=[],
  errors=[],
  data={},
  trace=null,
  nextStageId=null
}={}) {
  return {
    type,
    state,
    status,
    code,
    reason,
    requests: normalizeArray(requests).map((request, index) => cloneSerializable(request, `requests.${index}`)),
    errors: normalizeArray(errors).map((error, index) => cloneSerializable(error, `errors.${index}`)),
    data: cloneSerializable(data, "data") ?? {},
    trace: trace == null ? [] : normalizeArray(trace).map((entry, index) => cloneSerializable(entry, `trace.${index}`)),
    nextStageId: stringOrNull(nextStageId)
  };
}

function normalizeStages(stages) {
  const seen = new Set();
  const prepared = [];
  for ( const stage of normalizeArray(stages) ) {
    if ( !stage?.id || typeof stage.run !== "function" ) return {
      ok: false,
      code: RESOLUTION_PIPELINE_CODES.INVALID_STAGE,
      reason: "Each resolution stage must have an id and run function.",
      stages: []
    };
    if ( seen.has(stage.id) ) return {
      ok: false,
      code: RESOLUTION_PIPELINE_CODES.INVALID_STAGE,
      reason: `Duplicate resolution stage id "${stage.id}".`,
      stages: []
    };
    seen.add(stage.id);
    prepared.push(stage);
  }
  return {
    ok: true,
    code: RESOLUTION_PIPELINE_CODES.OK,
    stages: prepared
  };
}

function runStage(stage, state, services) {
  let rawResult;
  try {
    rawResult = stage.run(createResolutionState(state), services);
  } catch (error) {
    return {
      ok: false,
      code: RESOLUTION_PIPELINE_CODES.FAILED,
      reason: error?.message ?? String(error)
    };
  }

  const result = normalizeStageResult(rawResult);
  if ( !result.ok ) return result;
  const validation = result.result.state
    ? validateResolutionStateSerializable(result.result.state)
    : {ok: true};
  if ( !validation.ok ) return {
    ok: false,
    code: RESOLUTION_PIPELINE_CODES.NON_SERIALIZABLE_STATE,
    reason: validation.reason
  };

  return {
    ok: true,
    code: RESOLUTION_PIPELINE_CODES.OK,
    result: result.result
  };
}

function normalizeStageResult(result) {
  if ( result?.type && Object.values(RESOLUTION_STAGE_RESULT).includes(result.type) ) {
    return {
      ok: true,
      result: {
        ...result,
        requests: normalizeArray(result.requests),
        errors: normalizeArray(result.errors),
        data: cloneSerializable(result.data ?? {}, "data") ?? {}
      }
    };
  }
  if ( result?.schemaVersion === RESOLUTION_STATE_SCHEMA_VERSION ) {
    return {
      ok: true,
      result: continueResolutionStage({state: result})
    };
  }
  if ( result?.ok === false ) {
    return {
      ok: true,
      result: failResolutionStage({
        code: result.code ?? RESOLUTION_PIPELINE_CODES.FAILED,
        reason: result.reason ?? null,
        errors: result.errors ?? [],
        data: result
      })
    };
  }
  return {
    ok: false,
    code: RESOLUTION_PIPELINE_CODES.INVALID_STAGE_RESULT,
    reason: "Resolution stage returned an invalid result."
  };
}

function evaluateStageCanRun(stage, state, services) {
  if ( typeof stage.canRun !== "function" ) return {ok: true, value: true};
  try {
    const value = stage.canRun(createResolutionState(state), services);
    if ( typeof value === "object" && value ) {
      return {
        ok: value.ok !== false,
        value: value.ok !== false && value.run !== false && value.value !== false,
        reason: value.reason ?? null
      };
    }
    return {ok: true, value: Boolean(value)};
  } catch (error) {
    return {
      ok: false,
      value: false,
      reason: error?.message ?? String(error)
    };
  }
}

function markStageSkipped(state, stage, reason=null) {
  const current = createResolutionState(state);
  return updateResolutionState(current, {
    currentStageId: stage.id,
    completedStageIds: appendUnique(current.completedStageIds, stage.id),
    stageStatuses: {
      ...current.stageStatuses,
      [stage.id]: RESOLUTION_STAGE_STATUS.SKIPPED
    },
    trace: [
      ...current.trace,
      createTraceEntry(current, {
        stageId: stage.id,
        status: RESOLUTION_STAGE_STATUS.SKIPPED,
        result: RESOLUTION_STAGE_RESULT.CONTINUE,
        code: RESOLUTION_PIPELINE_CODES.OK,
        reason
      })
    ]
  });
}

function firstRunnableStageIndex(state, stages) {
  if ( state.currentStageId && !state.completedStageIds.includes(state.currentStageId) ) {
    const index = stages.findIndex(stage => stage.id === state.currentStageId);
    if ( index >= 0 ) return index;
  }
  const firstIncomplete = stages.findIndex(stage => !state.completedStageIds.includes(stage.id));
  return firstIncomplete < 0 ? stages.length : firstIncomplete;
}

function nextStageIndexFromResult(result, stages, currentIndex) {
  if ( !result.nextStageId ) return null;
  const index = stages.findIndex(stage => stage.id === result.nextStageId);
  if ( index <= currentIndex ) return null;
  return index;
}

function stageStatusForResult(result) {
  switch ( result.type ) {
    case RESOLUTION_STAGE_RESULT.WAIT:
      return RESOLUTION_STAGE_STATUS.WAITING;
    case RESOLUTION_STAGE_RESULT.FAIL:
      return RESOLUTION_STAGE_STATUS.FAILED;
    case RESOLUTION_STAGE_RESULT.COMPLETE:
    case RESOLUTION_STAGE_RESULT.CONTINUE:
    default:
      return RESOLUTION_STAGE_STATUS.COMPLETED;
  }
}

function pipelineResult(state) {
  const current = createResolutionState(state);
  const waiting = current.pendingRequests.length > 0;
  const failed = current.status === RESOLUTION_STATE_STATUS.FAILED;
  const cancelled = current.status === RESOLUTION_STATE_STATUS.CANCELLED;
  const completed = current.status === RESOLUTION_STATE_STATUS.COMPLETED;
  return {
    ok: !failed && !cancelled,
    code: failed
      ? current.errors[0]?.code ?? RESOLUTION_PIPELINE_CODES.FAILED
      : cancelled
        ? RESOLUTION_PIPELINE_CODES.CANCELLED
        : waiting
          ? RESOLUTION_PIPELINE_CODES.WAITING
          : completed
            ? RESOLUTION_PIPELINE_CODES.COMPLETED
            : RESOLUTION_PIPELINE_CODES.OK,
    status: current.status,
    waiting,
    completed,
    state: current
  };
}

function normalizeResolutionRequest(request, {resolutionId=null, stageId=null, path="request"}={}) {
  const normalized = cloneSerializable(request, path) ?? {};
  return {
    id: stringOrDefault(normalized.id, createRequestId(normalized.type, stageId ?? normalized.stageId)),
    resolutionId: stringOrDefault(normalized.resolutionId ?? resolutionId, null),
    stageId: stringOrNull(normalized.stageId ?? stageId),
    type: stringOrDefault(normalized.type, RESOLUTION_REQUEST_TYPES.CHOICE),
    expectedResponseType: stringOrNull(normalized.expectedResponseType),
    validation: cloneSerializable(normalized.validation ?? {}, `${path}.validation`) ?? {},
    chooser: cloneSerializable(normalized.chooser ?? null, `${path}.chooser`),
    authority: cloneSerializable(normalized.authority ?? null, `${path}.authority`),
    payload: cloneSerializable(normalized.payload ?? {}, `${path}.payload`) ?? {},
    metadata: cloneSerializable(normalized.metadata ?? {}, `${path}.metadata`) ?? {}
  };
}

function normalizeResolutionResponse(response) {
  const normalized = cloneSerializable(response, "response") ?? {};
  return {
    resolutionId: stringOrNull(normalized.resolutionId),
    requestId: stringOrNull(normalized.requestId ?? normalized.id),
    type: stringOrNull(normalized.type ?? normalized.requestType),
    value: cloneSerializable(normalized.value ?? normalized.result ?? normalized.response ?? null, "response.value"),
    metadata: cloneSerializable(normalized.metadata ?? {}, "response.metadata") ?? {}
  };
}

function requestMatchesResponse(request, response) {
  if ( request.resolutionId && request.resolutionId !== response.resolutionId ) return false;
  if ( request.id !== response.requestId ) return false;
  return request.type === response.type;
}

function statusForRequests(requests) {
  const types = new Set(normalizeArray(requests).map(request => request.type));
  if ( types.has(RESOLUTION_REQUEST_TYPES.ACTION_CONFIGURATION) ) return RESOLUTION_STATE_STATUS.AWAITING_CONFIGURATION;
  if ( types.has(RESOLUTION_REQUEST_TYPES.TARGET_SELECTION) || types.has(RESOLUTION_REQUEST_TYPES.TARGET_REFINEMENT) ) {
    return RESOLUTION_STATE_STATUS.AWAITING_TARGETS;
  }
  if ( types.has(RESOLUTION_REQUEST_TYPES.ROLL) ) return RESOLUTION_STATE_STATUS.AWAITING_ROLL;
  if ( types.has(RESOLUTION_REQUEST_TYPES.REACTION_CHOICE) || types.has(RESOLUTION_REQUEST_TYPES.CHOICE) ) {
    return RESOLUTION_STATE_STATUS.AWAITING_CHOICE;
  }
  return RESOLUTION_STATE_STATUS.PAUSED;
}

function createTraceEntry(state, {
  stageId=null,
  status=RESOLUTION_STAGE_STATUS.COMPLETED,
  result=RESOLUTION_STAGE_RESULT.CONTINUE,
  code=RESOLUTION_PIPELINE_CODES.OK,
  reason=null,
  requestIds=[],
  data={}
}={}) {
  return {
    id: `trace:${state.id}:${state.trace.length + 1}`,
    stageId: stringOrNull(stageId),
    status,
    result,
    code,
    reason,
    requestIds: uniqueStrings(requestIds),
    data: cloneSerializable(data, "trace.data") ?? {}
  };
}

function triggerIdentityFrom(sourceEvent, actionDefinition) {
  const eventId = sourceEvent?.id ?? sourceEvent?.type ?? null;
  const actionId = actionDefinition?.id ?? actionDefinition?.slug ?? null;
  return eventId || actionId ? `${eventId ?? "event"}:${actionId ?? "action"}` : null;
}

function createResolutionId() {
  return `resolution:${nextResolutionSequence++}`;
}

function createRequestId(type, stageId) {
  return `${stringOrDefault(type, RESOLUTION_REQUEST_TYPES.CHOICE)}:${stringOrDefault(stageId, "stage")}:${nextRequestSequence++}`;
}

function assertSerializable(value, path) {
  const failure = firstNonSerializable(value, path, new WeakSet());
  if ( failure ) throw new TypeError(failure.reason);
}

function cloneSerializable(value, path) {
  if ( value == null ) return value;
  assertSerializable(value, path);
  return JSON.parse(JSON.stringify(value));
}

function firstNonSerializable(value, path, seen) {
  if ( value == null ) return null;
  const type = typeof value;
  if ( type === "string" || type === "number" || type === "boolean" ) {
    return Number.isFinite(value) || type !== "number"
      ? null
      : {path, reason: `${path} must be finite JSON-serializable data.`};
  }
  if ( type === "function" || type === "symbol" || type === "bigint" || type === "undefined" ) {
    return {path, reason: `${path} must be JSON-serializable data, not ${type}.`};
  }
  if ( seen.has(value) ) return {path, reason: `${path} must not contain circular references.`};
  seen.add(value);

  if ( Array.isArray(value) ) {
    for ( const [index, entry] of value.entries() ) {
      const failure = firstNonSerializable(entry, `${path}.${index}`, seen);
      if ( failure ) return failure;
    }
    seen.delete(value);
    return null;
  }

  if ( !isPlainObject(value) ) {
    seen.delete(value);
    return {path, reason: `${path} must be plain JSON-serializable data.`};
  }

  for ( const [key, entry] of Object.entries(value) ) {
    const failure = firstNonSerializable(entry, `${path}.${key}`, seen);
    if ( failure ) return failure;
  }
  seen.delete(value);
  return null;
}

function normalizeArray(value) {
  if ( value == null ) return [];
  if ( Array.isArray(value) ) return value;
  if ( value instanceof Set ) return [...value];
  return [value];
}

function uniqueStrings(values) {
  return [...new Set(normalizeArray(values).filter(value => value != null && value !== "").map(String))];
}

function appendUnique(values, value) {
  return uniqueStrings([...values, value]);
}

function stringOrNull(value) {
  if ( value == null ) return null;
  const string = String(value).trim();
  return string ? string : null;
}

function stringOrDefault(value, fallback) {
  return stringOrNull(value) ?? fallback;
}

function finiteNumber(value) {
  if ( value == null || value === "" ) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isPlainObject(value) {
  return typeof value === "object"
    && value !== null
    && Object.getPrototypeOf(value) === Object.prototype;
}
