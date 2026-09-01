import {
  AUTOMATION_CODES,
  collectReactionWindows
} from "../helpers/automation-events.mjs";
import {
  RESOLUTION_PIPELINE_CODES,
  RESOLUTION_REQUEST_TYPES,
  RESOLUTION_STATE_STATUS,
  cancelResolutionState,
  createChildResolutionState,
  completeResolutionStage,
  continueResolutionStage,
  createResolutionPipelineStage,
  createResolutionRequest,
  createResolutionState,
  failResolutionStage,
  updateResolutionState,
  validateResolutionStateSerializable,
  waitResolutionStage
} from "../helpers/resolution-state.mjs";

export const REACTION_WINDOW_SCHEMA_VERSION = 1;

export const REACTION_WINDOW_TIMINGS = Object.freeze({
  AFTER_ACTION_DECLARED: "after-action-declared",
  AFTER_OUTCOME: "after-outcome",
  BEFORE_DAMAGE: "before-damage",
  BEFORE_COMMIT: "before-commit"
});

export const REACTION_WINDOW_STATUS = Object.freeze({
  OPEN: "open",
  WAITING: "waiting",
  RESOLVING: "resolving",
  CLOSED: "closed",
  CANCELLED: "cancelled"
});

export const REACTION_CHOICE_DECISIONS = Object.freeze({
  USE: "use",
  DECLINE: "decline"
});

export const REACTION_PARENT_DIRECTIVES = Object.freeze({
  CONTINUE: "continue",
  CANCEL_PARENT: "cancel-parent",
  REEVALUATE: "reevaluate"
});

export const REACTION_RESOLVER_CODES = Object.freeze({
  OK: "OK",
  WAITING: "WAITING",
  NO_CANDIDATES: "NO_CANDIDATES",
  REQUEST_MISMATCH: "REQUEST_MISMATCH",
  CANDIDATE_NOT_FOUND: "CANDIDATE_NOT_FOUND",
  CANDIDATE_HANDLED: "CANDIDATE_HANDLED",
  CHILD_RESOLUTION_CREATED: "CHILD_RESOLUTION_CREATED",
  CHILD_RESOLUTION_ALREADY_COMPLETED: "CHILD_RESOLUTION_ALREADY_COMPLETED",
  CHILD_RESOLUTION_FAILED: "CHILD_RESOLUTION_FAILED",
  PARENT_CANCELLED: "PARENT_CANCELLED",
  NON_SERIALIZABLE_REACTION_STATE: "NON_SERIALIZABLE_REACTION_STATE"
});

/* -------------------------------------------- */

export function createReactionWindowStage({
  id,
  timing=REACTION_WINDOW_TIMINGS.AFTER_OUTCOME,
  event=null,
  eventSelector=null,
  discovery=null,
  createChildState=null,
  metadata={}
}={}) {
  return createResolutionPipelineStage({
    id,
    metadata: {
      timing,
      reactionWindow: true,
      ...(clonePlain(metadata) ?? {})
    },
    run(state, services={}) {
      const selectedEvent = typeof eventSelector === "function" ? eventSelector(state, services) : event;
      if ( !selectedEvent ) return continueResolutionStage({state});
      const options = reactionDiscoveryOptions({discovery, state, services, event: selectedEvent});
      const accepted = latestReactionChoiceResponse(state, {
        stageId: id,
        windowId: reactionWindowId({parent: state, timing, event: selectedEvent})
      });

      if ( accepted ) {
        const stageChildStateFactory = typeof createChildState === "function"
          ? (context) => createChildState({...context, services, event: selectedEvent, timing})
          : null;
        const resolved = resolveReactionChoiceResponse({
          state: updateResolutionState(state, {pendingRequests: [accepted.request]}),
          response: accepted.response,
          event: selectedEvent,
          timing,
          stageId: id,
          createChildState: stageChildStateFactory,
          ...options
        });
        if ( !resolved.ok && !resolved.childState && !resolved.waiting ) {
          return failResolutionStage({
            state: resolved.state ?? state,
            code: resolved.code,
            reason: resolved.reason,
            data: resolved
          });
        }
        if ( resolved.waiting ) return waitResolutionStage({
          state: resolved.state,
          request: resolved.request,
          reason: "Reaction window advanced to the next eligible reactor.",
          data: {
            reactionWindowId: resolved.window?.id ?? null
          }
        });
        if ( resolved.childState ) return completeResolutionStage({
          state: resolved.state,
          status: RESOLUTION_STATE_STATUS.PAUSED,
          code: REACTION_RESOLVER_CODES.CHILD_RESOLUTION_CREATED,
          data: {
            reactionWindowId: resolved.window.id,
            childResolutionId: resolved.childState.id
          }
        });
        return continueResolutionStage({
          state: resolved.state,
          data: {
            reactionWindowId: resolved.window?.id ?? null
          }
        });
      }

      const planned = planReactionWindow({
        parentState: state,
        event: selectedEvent,
        timing,
        stageId: id,
        ...options
      });
      if ( planned.waiting ) return waitResolutionStage({
        state: planned.state,
        request: planned.request,
        reason: "Reaction choice is required before this window can close.",
        data: {
          reactionWindowId: planned.window.id,
          candidateCount: planned.candidates.length
        }
      });
      return continueResolutionStage({
        state: planned.state,
        data: {
          reactionWindowId: planned.window?.id ?? null,
          candidateCount: planned.candidates?.length ?? 0
        }
      });
    }
  });
}

/* -------------------------------------------- */

export function discoverReactionCandidates({
  event,
  timing=null,
  triggers=[],
  resourcesByActor={},
  actionDefinitionsById={},
  controllerUserIdsByActor={},
  context={},
  usedTriggerIds=[],
  handledCandidateIds=[],
  policies={},
  ordering={}
}={}) {
  const handled = new Set(uniqueStrings(handledCandidateIds));
  const discovery = collectReactionWindows({
    triggers,
    event,
    resourcesByActor,
    context,
    usedTriggerIds,
    policies
  });
  const candidates = [];
  const rejected = [...(discovery.rejected ?? [])];

  for ( const window of discovery.windows ?? [] ) {
    const actionDefinition = resolveActionDefinition(window, actionDefinitionsById);
    const candidate = createReactionCandidate({
      window,
      timing,
      actionDefinition,
      controllerUserIdsByActor
    });
    if ( handled.has(candidate.id) ) {
      rejected.push({
        ok: false,
        code: REACTION_RESOLVER_CODES.CANDIDATE_HANDLED,
        triggerId: candidate.triggerId,
        eventId: candidate.eventId,
        candidateId: candidate.id
      });
      continue;
    }
    candidates.push(candidate);
  }

  return {
    ok: true,
    code: REACTION_RESOLVER_CODES.OK,
    candidates: candidates.sort((a, b) => compareReactionCandidates(a, b, ordering)),
    rejected
  };
}

/* -------------------------------------------- */

export function planReactionWindow({
  parentState=null,
  state=null,
  event,
  timing=REACTION_WINDOW_TIMINGS.AFTER_OUTCOME,
  stageId=null,
  triggers=[],
  resourcesByActor={},
  actionDefinitionsById={},
  controllerUserIdsByActor={},
  context={},
  usedTriggerIds=[],
  handledCandidateIds=[],
  policies={},
  ordering={},
  windowId=null,
  metadata={}
}={}) {
  const parent = createResolutionState(parentState ?? state);
  const explicitWindowId = stringOrNull(windowId);
  const existingWindow = explicitWindowId ? findReactionWindow(parent, explicitWindowId) : null;
  const handled = uniqueStrings([
    ...handledCandidateIds,
    ...(existingWindow?.handledCandidateIds ?? [])
  ]);
  const discovery = discoverReactionCandidates({
    event,
    timing,
    triggers,
    resourcesByActor,
    actionDefinitionsById,
    controllerUserIdsByActor,
    context,
    usedTriggerIds: uniqueStrings([...usedTriggerIds, ...(parent.triggerIdentities ?? [])]),
    handledCandidateIds: handled,
    policies,
    ordering
  });
  const id = explicitWindowId ?? existingWindow?.id ?? reactionWindowId({parent, timing, event});
  const candidates = discovery.candidates.map(candidate => ({
    ...candidate,
    reactionWindowId: id
  }));
  const window = createReactionWindowState({
    ...(existingWindow ?? {}),
    id,
    parentResolutionId: parent.id,
    timing,
    status: candidates.length ? REACTION_WINDOW_STATUS.WAITING : REACTION_WINDOW_STATUS.CLOSED,
    event,
    candidates: mergeCandidates(existingWindow?.candidates ?? [], candidates),
    discoveredCandidateIds: uniqueStrings([
      ...(existingWindow?.discoveredCandidateIds ?? []),
      ...candidates.map(candidate => candidate.id)
    ]),
    offeredCandidateIds: existingWindow?.offeredCandidateIds ?? [],
    handledCandidateIds: handled,
    declinedCandidateIds: existingWindow?.declinedCandidateIds ?? [],
    resolvedCandidateIds: existingWindow?.resolvedCandidateIds ?? [],
    childResolutionIds: existingWindow?.childResolutionIds ?? [],
    trace: [
      ...(existingWindow?.trace ?? []),
      {
        code: candidates.length ? REACTION_RESOLVER_CODES.WAITING : REACTION_RESOLVER_CODES.NO_CANDIDATES,
        candidateCount: candidates.length
      }
    ],
    metadata: {
      ...(existingWindow?.metadata ?? {}),
      ...clonePlain(metadata)
    }
  });

  if ( !candidates.length ) {
    const nextState = putReactionWindow(parent, window);
    return {
      ok: true,
      code: REACTION_RESOLVER_CODES.NO_CANDIDATES,
      waiting: false,
      state: appendReactionTrace(nextState, {
        stageId,
        code: REACTION_RESOLVER_CODES.NO_CANDIDATES,
        reason: "No eligible reactions were discovered for this window.",
        data: {reactionWindowId: id}
      }),
      window,
      candidates: [],
      rejected: discovery.rejected
    };
  }

  const offeredCandidates = nextOfferGroup(candidates);
  const offeredCandidateIds = uniqueStrings([
    ...window.offeredCandidateIds,
    ...offeredCandidates.map(candidate => candidate.id)
  ]);
  const waitingWindow = createReactionWindowState({
    ...window,
    offeredCandidateIds,
    status: REACTION_WINDOW_STATUS.WAITING,
    trace: [
      ...window.trace,
      {
        code: REACTION_RESOLVER_CODES.WAITING,
        offeredCandidateIds: offeredCandidates.map(candidate => candidate.id)
      }
    ]
  });
  const request = createReactionChoiceRequest({
    parentState: parent,
    window: waitingWindow,
    stageId,
    candidates: offeredCandidates
  });
  const nextState = appendReactionTrace(updateResolutionState(putReactionWindow(parent, waitingWindow), {
    status: RESOLUTION_STATE_STATUS.AWAITING_CHOICE,
    currentStageId: stageId ?? parent.currentStageId,
    pendingRequests: [request]
  }), {
    stageId,
    code: REACTION_RESOLVER_CODES.WAITING,
    reason: "Reaction window is waiting for a controller choice.",
    requestIds: [request.id],
    data: {
      reactionWindowId: id,
      offeredCandidateIds
    }
  });

  return {
    ok: true,
    code: REACTION_RESOLVER_CODES.WAITING,
    waiting: true,
    state: nextState,
    window: waitingWindow,
    request,
    candidates,
    offeredCandidates,
    rejected: discovery.rejected
  };
}

/* -------------------------------------------- */

export function resolveReactionChoiceResponse({
  parentState=null,
  state=null,
  response,
  event=null,
  timing=null,
  stageId=null,
  triggers=[],
  resourcesByActor={},
  actionDefinitionsById={},
  controllerUserIdsByActor={},
  context={},
  usedTriggerIds=[],
  policies={},
  ordering={},
  childResolutionId=null,
  createChildState=null,
  metadata={}
}={}) {
  const parent = createResolutionState(parentState ?? state);
  const normalized = normalizeReactionResponse(response);
  const request = parent.pendingRequests.find(candidate => {
    if ( candidate.type !== RESOLUTION_REQUEST_TYPES.REACTION_CHOICE ) return false;
    if ( normalized.resolutionId && candidate.resolutionId !== normalized.resolutionId ) return false;
    return candidate.id === normalized.requestId;
  });
  if ( !request ) return {
    ok: false,
    code: REACTION_RESOLVER_CODES.REQUEST_MISMATCH,
    reason: "Reaction response did not match a pending reaction-choice request.",
    state: parent
  };

  const window = findReactionWindow(parent, request.payload?.reactionWindowId);
  if ( !window ) return {
    ok: false,
    code: REACTION_RESOLVER_CODES.REQUEST_MISMATCH,
    reason: "Reaction response references an unknown reaction window.",
    state: parent
  };

  if ( normalized.decision === REACTION_CHOICE_DECISIONS.DECLINE ) {
    const declinedIds = request.validation?.candidateIds ?? request.payload?.candidates?.map(candidate => candidate.id) ?? [];
    const declinedWindow = createReactionWindowState({
      ...window,
      status: REACTION_WINDOW_STATUS.OPEN,
      handledCandidateIds: uniqueStrings([...window.handledCandidateIds, ...declinedIds]),
      declinedCandidateIds: uniqueStrings([...window.declinedCandidateIds, ...declinedIds]),
      trace: [
        ...window.trace,
        {
          code: REACTION_RESOLVER_CODES.OK,
          decision: REACTION_CHOICE_DECISIONS.DECLINE,
          declinedCandidateIds: uniqueStrings(declinedIds)
        }
      ]
    });
    const afterDecline = updateResolutionState(putReactionWindow(parent, declinedWindow), {
      status: RESOLUTION_STATE_STATUS.RUNNING,
      pendingRequests: []
    });
    return planReactionWindow({
      parentState: afterDecline,
      event: event ?? declinedWindow.event,
      timing: timing ?? declinedWindow.timing,
      stageId: stageId ?? request.stageId,
      triggers,
      resourcesByActor,
      actionDefinitionsById,
      controllerUserIdsByActor,
      context,
      usedTriggerIds,
      policies,
      ordering,
      windowId: declinedWindow.id,
      metadata
    });
  }

  const candidateId = normalized.candidateId;
  const candidate = candidateById(window, candidateId);
  if ( !candidate || !(request.validation?.candidateIds ?? []).includes(candidateId) ) return {
    ok: false,
    code: REACTION_RESOLVER_CODES.CANDIDATE_NOT_FOUND,
    reason: "Reaction response selected a candidate that was not offered by this request.",
    state: parent,
    candidateId
  };
  if ( window.handledCandidateIds.includes(candidateId) ) return {
    ok: false,
    code: REACTION_RESOLVER_CODES.CANDIDATE_HANDLED,
    reason: "Reaction candidate has already been handled for this window.",
    state: parent,
    candidate
  };

  const child = createReactionChildResolution({
    parentState: parent,
    candidate,
    childResolutionId,
    createChildState,
    metadata
  });
  if ( !child.ok ) return {
    ...child,
    state: parent
  };

  const resolvingWindow = createReactionWindowState({
    ...window,
    status: REACTION_WINDOW_STATUS.RESOLVING,
    chosenCandidateId: candidateId,
    handledCandidateIds: uniqueStrings([...window.handledCandidateIds, candidateId]),
    resolvedCandidateIds: uniqueStrings([...window.resolvedCandidateIds, candidateId]),
    childResolutionIds: uniqueStrings([...window.childResolutionIds, child.state.id]),
    trace: [
      ...window.trace,
      {
        code: REACTION_RESOLVER_CODES.CHILD_RESOLUTION_CREATED,
        decision: REACTION_CHOICE_DECISIONS.USE,
        candidateId,
        childResolutionId: child.state.id
      }
    ]
  });
  const parentWithWindow = putReactionWindow(parent, resolvingWindow);
  const nextState = appendReactionTrace(updateResolutionState(parentWithWindow, {
    status: RESOLUTION_STATE_STATUS.PAUSED,
    pendingRequests: [],
    metadata: {
      ...parentWithWindow.metadata,
      activeChildResolution: child.state
    },
    results: {
      ...parent.results,
      reactions: upsertReactionResult(parent.results?.reactions, {
        windowId: resolvingWindow.id,
        status: resolvingWindow.status,
        chosenCandidateId: candidateId,
        childResolutionId: child.state.id,
        candidate: requestSafeCandidate(candidate)
      })
    }
  }), {
    stageId: request.stageId,
    code: REACTION_RESOLVER_CODES.CHILD_RESOLUTION_CREATED,
    reason: "Reaction choice created a child resolution; parent remains paused.",
    data: {
      reactionWindowId: resolvingWindow.id,
      candidateId,
      childResolutionId: child.state.id
    }
  });

  return {
    ok: true,
    code: REACTION_RESOLVER_CODES.CHILD_RESOLUTION_CREATED,
    state: nextState,
    window: resolvingWindow,
    candidate,
    childState: child.state
  };
}

/* -------------------------------------------- */

export function createReactionChildResolution({
  parentState,
  candidate,
  childResolutionId=null,
  createChildState=null,
  metadata={}
}={}) {
  const parent = createResolutionState(parentState);
  const child = createChildResolutionState(parent, {
    id: childResolutionId,
    relationship: "reaction",
    sourceEvent: candidate?.event ?? null,
    actionDefinition: candidate?.actionDefinition ?? candidate?.action ?? null,
    input: {
      reactionWindowId: candidate?.reactionWindowId ?? null,
      reactionCandidateId: candidate?.id ?? null,
      triggerId: candidate?.triggerId ?? null,
      reactor: candidate?.reactor ?? null,
      selectedPaymentOption: candidate?.selectedPaymentOption ?? null
    },
    metadata: {
      ...(clonePlain(metadata) ?? {}),
      reactionWindowId: candidate?.reactionWindowId ?? null,
      reactionCandidateId: candidate?.id ?? null,
      triggerId: candidate?.triggerId ?? null,
      reactor: candidate?.reactor ?? null
    },
    triggerIdentity: reactionTriggerIdentity(candidate)
  });
  if ( !child.ok ) return {
    ok: false,
    code: child.code,
    reason: child.reason,
    state: null,
    child
  };
  if ( typeof createChildState !== "function" ) return {
    ok: true,
    code: REACTION_RESOLVER_CODES.CHILD_RESOLUTION_CREATED,
    state: child.state
  };

  const created = createChildState({
    parentState: parent,
    candidate,
    baseChildState: child.state
  });
  const state = createResolutionState(created?.state ?? created);
  const validation = validateResolutionStateSerializable(state);
  if ( !validation.ok ) return {
    ok: false,
    code: REACTION_RESOLVER_CODES.NON_SERIALIZABLE_REACTION_STATE,
    reason: validation.reason,
    state: null,
    validation
  };
  return {
    ok: true,
    code: REACTION_RESOLVER_CODES.CHILD_RESOLUTION_CREATED,
    state
  };
}

/* -------------------------------------------- */

export function completeReactionChildResolution({
  parentState,
  childState=null,
  childResult=null,
  windowId=null,
  directive=null,
  reevaluate=null,
  failurePolicy="continue",
  metadata={}
}={}) {
  const parent = createResolutionState(parentState);
  const child = childState ? createResolutionState(childState) : null;
  const resolvedWindowId = windowId
    ?? child?.metadata?.reactionWindowId
    ?? childResult?.reactionWindowId
    ?? null;
  const window = findReactionWindow(parent, resolvedWindowId);
  if ( !window ) return {
    ok: false,
    code: REACTION_RESOLVER_CODES.REQUEST_MISMATCH,
    reason: "Completed reaction child does not match an open parent reaction window.",
    state: parent
  };

  const childResolutionId = stringOrNull(child?.id ?? childResult?.resolutionId);
  if (
    childResolutionId
    && window.childResolutionIds.length
    && !window.childResolutionIds.includes(childResolutionId)
  ) return {
    ok: false,
    code: REACTION_RESOLVER_CODES.REQUEST_MISMATCH,
    reason: "Completed reaction child does not belong to the parent reaction window.",
    state: parent,
    window
  };

  const activeChildResolutionId = stringOrNull(parent.metadata?.activeChildResolution?.id);
  if (
    [REACTION_WINDOW_STATUS.CLOSED, REACTION_WINDOW_STATUS.CANCELLED].includes(window.status)
    && (!activeChildResolutionId || activeChildResolutionId === childResolutionId)
  ) return {
    ok: ![RESOLUTION_STATE_STATUS.FAILED, RESOLUTION_STATE_STATUS.CANCELLED].includes(parent.status),
    code: REACTION_RESOLVER_CODES.CHILD_RESOLUTION_ALREADY_COMPLETED,
    reason: "Reaction child completion was already applied to the parent resolution.",
    duplicate: true,
    state: parent,
    window
  };

  const childStatus = child?.status ?? childResult?.status ?? null;
  const childFailed = [RESOLUTION_STATE_STATUS.FAILED, RESOLUTION_STATE_STATUS.CANCELLED].includes(childStatus)
    || childResult?.ok === false;
  if ( childFailed && failurePolicy === "cancel-parent" ) {
    const failedWindow = createReactionWindowState({
      ...window,
      status: REACTION_WINDOW_STATUS.CANCELLED,
      trace: [
        ...window.trace,
        {
          code: REACTION_RESOLVER_CODES.CHILD_RESOLUTION_FAILED,
          childResolutionId,
          childStatus,
          directive: {type: REACTION_PARENT_DIRECTIVES.CANCEL_PARENT},
          failurePolicy
        }
      ],
      metadata: {
        ...window.metadata,
        ...(clonePlain(metadata) ?? {})
      }
    });
    const cancelled = cancelResolutionState(clearActiveReactionChild(putReactionWindow(parent, failedWindow)), {
      stageId: parent.currentStageId,
      code: REACTION_RESOLVER_CODES.CHILD_RESOLUTION_FAILED,
      reason: childResult?.reason ?? "Reaction child resolution failed.",
      data: {
        reactionWindowId: window.id,
        childResolutionId
      }
    });
    return {
      ok: false,
      code: REACTION_RESOLVER_CODES.CHILD_RESOLUTION_FAILED,
      state: cancelled,
      window: failedWindow
    };
  }

  const normalizedDirective = normalizeParentDirective(directive ?? child?.results?.parentDirective ?? childResult?.directive);
  const closedWindow = createReactionWindowState({
    ...window,
    status: normalizedDirective.type === REACTION_PARENT_DIRECTIVES.CANCEL_PARENT
      ? REACTION_WINDOW_STATUS.CANCELLED
      : REACTION_WINDOW_STATUS.CLOSED,
    trace: [
      ...window.trace,
      {
        code: childFailed ? REACTION_RESOLVER_CODES.CHILD_RESOLUTION_FAILED : REACTION_RESOLVER_CODES.OK,
        childResolutionId,
        childStatus,
        directive: normalizedDirective
      }
    ],
    metadata: {
      ...window.metadata,
      ...(clonePlain(metadata) ?? {})
    }
  });

  let nextState = updateResolutionState(clearActiveReactionChild(putReactionWindow(parent, closedWindow)), {
    status: RESOLUTION_STATE_STATUS.RUNNING,
    pendingRequests: [],
    results: {
      ...parent.results,
      reactions: upsertReactionResult(parent.results?.reactions, {
        windowId: closedWindow.id,
        status: closedWindow.status,
        chosenCandidateId: closedWindow.chosenCandidateId,
        childResolutionId,
        childStatus,
        directive: normalizedDirective,
        childFailed
      })
    }
  });

  const reevaluation = applyReevaluation({reevaluate, parentState: nextState, childState: child, window: closedWindow});
  if ( reevaluation.ok && reevaluation.evaluation ) {
    nextState = updateResolutionState(nextState, {
      input: {
        ...nextState.input,
        ...(reevaluation.evaluation.inputPatch ?? {})
      },
      results: {
        ...nextState.results,
        ...(reevaluation.evaluation.results ?? {}),
        reactions: upsertReactionResult(nextState.results?.reactions, {
          windowId: closedWindow.id,
          reevaluation: reevaluation.evaluation
        })
      }
    });
  }

  if ( normalizedDirective.type === REACTION_PARENT_DIRECTIVES.CANCEL_PARENT ) {
    const cancelled = cancelResolutionState(nextState, {
      stageId: nextState.currentStageId,
      code: normalizedDirective.code ?? REACTION_RESOLVER_CODES.PARENT_CANCELLED,
      reason: normalizedDirective.reason ?? "Parent resolution cancelled by reaction directive.",
      data: {
        reactionWindowId: closedWindow.id,
        childResolutionId,
        directive: normalizedDirective
      }
    });
    return {
      ok: false,
      code: normalizedDirective.code ?? REACTION_RESOLVER_CODES.PARENT_CANCELLED,
      state: cancelled,
      window: closedWindow,
      directive: normalizedDirective,
      reevaluation: reevaluation.evaluation ?? null
    };
  }

  nextState = appendReactionTrace(nextState, {
    stageId: nextState.currentStageId,
    code: childFailed ? REACTION_RESOLVER_CODES.CHILD_RESOLUTION_FAILED : REACTION_RESOLVER_CODES.OK,
    reason: childFailed
      ? "Reaction child failed or cancelled; parent resumed under failure policy."
      : "Reaction child completed; parent may resume from the reaction window.",
    data: {
      reactionWindowId: closedWindow.id,
      childResolutionId,
      childStatus,
      directive: normalizedDirective,
      reevaluation: reevaluation.evaluation ?? null
    }
  });

  return {
    ok: !childFailed,
    code: childFailed ? REACTION_RESOLVER_CODES.CHILD_RESOLUTION_FAILED : REACTION_RESOLVER_CODES.OK,
    state: nextState,
    window: closedWindow,
    directive: normalizedDirective,
    reevaluation: reevaluation.evaluation ?? null
  };
}

/* -------------------------------------------- */

function createReactionCandidate({window, timing, actionDefinition, controllerUserIdsByActor}) {
  const actionRef = stringOrNull(window.actionRef ?? actionDefinition?.id ?? window.actionId);
  const actionId = stringOrNull(window.actionId ?? actionDefinition?.id ?? actionRef);
  const actorId = stringOrNull(window.actorId);
  const controllerUserIds = uniqueStrings(lookupByActor(controllerUserIdsByActor, actorId));
  return {
    schemaVersion: REACTION_WINDOW_SCHEMA_VERSION,
    id: reactionCandidateId({window, actionRef, actionId}),
    reactionWindowId: window.id,
    timing: timing ?? null,
    triggerId: window.triggerId,
    eventId: window.eventId ?? window.event?.id ?? null,
    reactor: {
      actorId,
      tokenId: stringOrNull(window.tokenId),
      ref: actorId ? `actor:${actorId}` : null
    },
    actionId,
    actionRef,
    action: clonePlain(window.action ?? actionDefinition ?? {id: actionId, ref: actionRef}) ?? null,
    actionDefinition: clonePlain(actionDefinition ?? window.action ?? null),
    chooser: chooserForReaction(window, controllerUserIds),
    controllerUserIds,
    availability: {
      ok: true,
      code: AUTOMATION_CODES.OK,
      paymentOptions: clonePlain(window.paymentOptions ?? []) ?? [],
      selectedPaymentOption: clonePlain(window.selectedPaymentOption ?? null)
    },
    paymentOptions: clonePlain(window.paymentOptions ?? []) ?? [],
    selectedPaymentOption: clonePlain(window.selectedPaymentOption ?? null),
    trigger: {
      id: window.triggerId,
      source: clonePlain(window.metadata?.source ?? window.metadata ?? null)
    },
    event: clonePlain(window.event ?? null),
    payload: clonePlain(window.payload ?? {}) ?? {},
    provenance: {
      triggerId: window.triggerId,
      eventId: window.eventId ?? window.event?.id ?? null,
      source: clonePlain(window.metadata?.source ?? window.metadata ?? null),
      owner: clonePlain(window.owner ?? null)
    },
    priority: Number(window.priority ?? 100)
  };
}

function createReactionWindowState({
  id,
  parentResolutionId,
  timing,
  status=REACTION_WINDOW_STATUS.OPEN,
  event=null,
  candidates=[],
  discoveredCandidateIds=[],
  offeredCandidateIds=[],
  handledCandidateIds=[],
  declinedCandidateIds=[],
  resolvedCandidateIds=[],
  childResolutionIds=[],
  chosenCandidateId=null,
  trace=[],
  metadata={}
}={}) {
  return clonePlain({
    schemaVersion: REACTION_WINDOW_SCHEMA_VERSION,
    id,
    parentResolutionId,
    timing,
    status,
    event,
    candidates,
    discoveredCandidateIds: uniqueStrings(discoveredCandidateIds),
    offeredCandidateIds: uniqueStrings(offeredCandidateIds),
    handledCandidateIds: uniqueStrings(handledCandidateIds),
    declinedCandidateIds: uniqueStrings(declinedCandidateIds),
    resolvedCandidateIds: uniqueStrings(resolvedCandidateIds),
    childResolutionIds: uniqueStrings(childResolutionIds),
    chosenCandidateId: stringOrNull(chosenCandidateId),
    trace,
    metadata
  });
}

function createReactionChoiceRequest({parentState, window, stageId=null, candidates=[]}) {
  const chooser = candidates[0]?.chooser ?? null;
  const offerSequence = Math.max(1, window.trace.filter(entry => {
    return Array.isArray(entry?.offeredCandidateIds) && entry.offeredCandidateIds.length > 0;
  }).length);
  return createResolutionRequest({
    id: `request:${parentState.id}:reaction:${window.id}:offer:${offerSequence}`,
    resolutionId: parentState.id,
    stageId: stageId ?? parentState.currentStageId,
    type: RESOLUTION_REQUEST_TYPES.REACTION_CHOICE,
    expectedResponseType: "reaction-choice",
    chooser,
    authority: chooser,
    validation: {
      required: false,
      reactionWindowId: window.id,
      offerSequence,
      candidateIds: candidates.map(candidate => candidate.id)
    },
    payload: {
      reactionWindowId: window.id,
      offerSequence,
      timing: window.timing,
      event: publicEventSnapshot(window.event),
      candidates: candidates.map(requestSafeCandidate),
      options: [
        ...candidates.map(candidate => ({
          id: candidate.id,
          label: candidate.action?.label ?? candidate.action?.name ?? candidate.actionId ?? candidate.id,
          value: {
            decision: REACTION_CHOICE_DECISIONS.USE,
            candidateId: candidate.id
          },
          resources: candidate.selectedPaymentOption?.resources ?? [],
          paymentPlan: candidate.selectedPaymentOption ?? null,
          source: candidate.provenance?.source ?? null,
          metadata: {
            triggerId: candidate.triggerId,
            reactor: candidate.reactor
          }
        })),
        {
          id: "decline",
          label: "Decline",
          value: {
            decision: REACTION_CHOICE_DECISIONS.DECLINE
          },
          metadata: {
            reactionWindowId: window.id
          }
        }
      ]
    },
    metadata: {
      required: false,
      title: "Reaction Available",
      reactionWindowId: window.id,
      offerSequence
    }
  });
}

function latestReactionChoiceResponse(state, {stageId=null, windowId=null}={}) {
  const current = createResolutionState(state);
  return Object.values(current.requestResponses ?? {}).reverse().find(entry => {
    const request = entry?.request ?? {};
    if ( request.type !== RESOLUTION_REQUEST_TYPES.REACTION_CHOICE ) return false;
    if ( stageId != null && request.stageId !== stageId ) return false;
    const requestWindowId = request.validation?.reactionWindowId
      ?? request.payload?.reactionWindowId
      ?? null;
    if ( windowId != null && requestWindowId !== windowId ) return false;
    return true;
  }) ?? null;
}

function requestSafeCandidate(candidate) {
  return {
    id: candidate.id,
    timing: candidate.timing,
    triggerId: candidate.triggerId,
    eventId: candidate.eventId,
    reactor: clonePlain(candidate.reactor),
    actionId: candidate.actionId,
    actionRef: candidate.actionRef,
    action: candidate.action ? {
      id: candidate.action.id ?? candidate.actionId ?? null,
      label: candidate.action.label ?? candidate.action.name ?? null,
      slug: candidate.action.slug ?? null,
      category: candidate.action.category ?? candidate.action.type ?? null,
      source: clonePlain(candidate.action.source ?? null)
    } : null,
    chooser: clonePlain(candidate.chooser ?? null),
    payment: {
      selectedPaymentOption: clonePlain(candidate.selectedPaymentOption ?? null),
      options: clonePlain(candidate.paymentOptions ?? []) ?? []
    },
    provenance: clonePlain(candidate.provenance ?? null),
    priority: candidate.priority
  };
}

function putReactionWindow(state, window) {
  const current = createResolutionState(state);
  const windows = reactionWindows(current).filter(entry => entry.id !== window.id);
  return updateResolutionState(current, {
    metadata: {
      ...current.metadata,
      reactionWindows: [...windows, createReactionWindowState(window)]
    }
  });
}

function findReactionWindow(state, id=null) {
  const windows = reactionWindows(state);
  const ref = stringOrNull(id);
  if ( ref ) return windows.find(window => window.id === ref) ?? null;
  return windows.at(-1) ?? null;
}

function reactionWindows(state) {
  return (state.metadata?.reactionWindows ?? []).map(window => createReactionWindowState(window));
}

function clearActiveReactionChild(state) {
  const current = createResolutionState(state);
  const {activeChildResolution: _activeChildResolution, ...metadata} = current.metadata ?? {};
  return updateResolutionState(current, {metadata});
}

function upsertReactionResult(current, entry) {
  const entries = Array.isArray(current) ? current : [];
  return [
    ...entries.filter(candidate => candidate?.windowId !== entry.windowId),
    clonePlain(entry)
  ];
}

function nextOfferGroup(candidates) {
  const [first] = candidates;
  if ( !first ) return [];
  return candidates.filter(candidate => candidate.reactor.actorId === first.reactor.actorId);
}

function mergeCandidates(existing, next) {
  const byId = new Map();
  for ( const candidate of [...existing, ...next] ) byId.set(candidate.id, clonePlain(candidate));
  return [...byId.values()];
}

function candidateById(window, id) {
  const ref = stringOrNull(id);
  if ( !ref ) return null;
  return (window.candidates ?? []).find(candidate => candidate.id === ref) ?? null;
}

function normalizeReactionResponse(response) {
  const value = response?.value ?? response?.result ?? response?.response ?? response ?? {};
  const decision = normalizeDecision(value.decision ?? value.action ?? value.type ?? (value.declined ? REACTION_CHOICE_DECISIONS.DECLINE : null));
  return {
    resolutionId: stringOrNull(response?.resolutionId ?? value.resolutionId),
    requestId: stringOrNull(response?.requestId ?? response?.id ?? value.requestId),
    type: stringOrNull(response?.type ?? response?.requestType) ?? RESOLUTION_REQUEST_TYPES.REACTION_CHOICE,
    decision: decision ?? (value.candidateId ? REACTION_CHOICE_DECISIONS.USE : REACTION_CHOICE_DECISIONS.DECLINE),
    candidateId: stringOrNull(value.candidateId ?? value.id),
    value: clonePlain(value)
  };
}

function normalizeDecision(value) {
  const decision = String(value ?? "").trim();
  if ( ["skip", "decline", "declined", "none", "cancel"].includes(decision) ) return REACTION_CHOICE_DECISIONS.DECLINE;
  if ( ["use", "accept", "selected", "react"].includes(decision) ) return REACTION_CHOICE_DECISIONS.USE;
  return null;
}

function chooserForReaction(window, controllerUserIds) {
  const explicit = window.reaction?.chooser ?? window.reaction?.authority ?? null;
  if ( explicit ) return clonePlain(explicit);
  if ( controllerUserIds.length === 1 ) return {
    kind: "specific",
    userId: controllerUserIds[0]
  };
  if ( controllerUserIds.length > 1 ) return {
    kind: "specific",
    userIds: controllerUserIds
  };
  return {kind: "target-controller"};
}

function resolveActionDefinition(window, actionDefinitionsById) {
  const ids = uniqueStrings([
    window.actionId,
    window.actionRef,
    window.action?.id,
    window.action?.slug
  ]);
  if ( typeof actionDefinitionsById === "function" ) {
    for ( const id of ids ) {
      const result = actionDefinitionsById(id, window);
      if ( result ) return result;
    }
    return null;
  }
  if ( actionDefinitionsById instanceof Map ) {
    for ( const id of ids ) {
      if ( actionDefinitionsById.has(id) ) return actionDefinitionsById.get(id);
    }
    return null;
  }
  for ( const id of ids ) {
    if ( actionDefinitionsById?.[id] ) return actionDefinitionsById[id];
  }
  return window.action ?? null;
}

function compareReactionCandidates(a, b, ordering) {
  const priority = (a.priority ?? 100) - (b.priority ?? 100);
  if ( priority ) return priority;
  const initiative = initiativeIndex(a.reactor.actorId, ordering) - initiativeIndex(b.reactor.actorId, ordering);
  if ( initiative ) return initiative;
  const actor = String(a.reactor.actorId ?? "").localeCompare(String(b.reactor.actorId ?? ""));
  if ( actor ) return actor;
  const action = String(a.actionRef ?? a.actionId ?? "").localeCompare(String(b.actionRef ?? b.actionId ?? ""));
  if ( action ) return action;
  return String(a.triggerId ?? "").localeCompare(String(b.triggerId ?? ""));
}

function initiativeIndex(actorId, ordering) {
  const order = ordering?.initiativeActorIds ?? ordering?.actorIds ?? [];
  const index = order.map(String).indexOf(String(actorId));
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function publicEventSnapshot(event) {
  if ( !event ) return null;
  return {
    id: event.id ?? null,
    type: event.type ?? null,
    phase: event.phase ?? null,
    source: clonePlain(event.source ?? null),
    targets: clonePlain(event.targets ?? []) ?? [],
    tags: clonePlain(event.tags ?? []) ?? [],
    data: clonePlain(event.data ?? {}) ?? {}
  };
}

function normalizeParentDirective(value) {
  if ( typeof value === "string" ) return {
    type: value,
    code: null,
    reason: null,
    data: {}
  };
  const data = value && typeof value === "object" ? clonePlain(value) : {};
  return {
    type: data.type ?? data.directive ?? REACTION_PARENT_DIRECTIVES.CONTINUE,
    code: data.code ?? null,
    reason: data.reason ?? null,
    data: data.data ?? {}
  };
}

function applyReevaluation({reevaluate, parentState, childState, window}) {
  if ( typeof reevaluate !== "function" ) return {ok: true, evaluation: null};
  const result = reevaluate({
    parentState: createResolutionState(parentState),
    childState: childState ? createResolutionState(childState) : null,
    window: createReactionWindowState(window)
  });
  if ( result == null ) return {ok: true, evaluation: null};
  return {
    ok: result.ok !== false,
    evaluation: clonePlain(result)
  };
}

function reactionDiscoveryOptions({discovery, state, services, event}) {
  const source = typeof discovery === "function"
    ? discovery({state: createResolutionState(state), services, event})
    : discovery ?? services.reactions ?? {};
  return {...(source ?? {})};
}

function reactionWindowId({parent, timing, event}) {
  return `reaction-window:${parent.id}:${timing}:${event?.id ?? event?.type ?? "event"}`;
}

function reactionCandidateId({window, actionRef, actionId}) {
  return `reaction-candidate:${window.triggerId}:${window.actorId}:${actionRef ?? actionId ?? "action"}:${window.eventId ?? window.event?.id ?? "event"}`;
}

function reactionTriggerIdentity(candidate) {
  return [
    candidate?.triggerId,
    candidate?.eventId ?? candidate?.event?.id ?? candidate?.event?.type,
    candidate?.reactor?.actorId,
    candidate?.actionRef ?? candidate?.actionId
  ].filter(Boolean).join(":") || null;
}

function appendReactionTrace(state, {stageId=null, code=REACTION_RESOLVER_CODES.OK, reason=null, requestIds=[], data={}}={}) {
  const current = createResolutionState(state);
  return updateResolutionState(current, {
    trace: [
      ...current.trace,
      {
        id: `trace:${current.id}:reaction:${current.trace.length + 1}`,
        stageId: stageId ?? current.currentStageId,
        status: current.status,
        result: code === REACTION_RESOLVER_CODES.WAITING ? "wait" : "continue",
        code,
        reason,
        requestIds: uniqueStrings(requestIds),
        data: clonePlain(data) ?? {}
      }
    ]
  });
}

function lookupByActor(mapLike, actorId) {
  if ( !actorId ) return [];
  if ( typeof mapLike === "function" ) return mapLike(actorId) ?? [];
  if ( mapLike instanceof Map ) return mapLike.get(actorId) ?? mapLike.get(`actor:${actorId}`) ?? [];
  return mapLike?.[actorId] ?? mapLike?.[`actor:${actorId}`] ?? [];
}

function uniqueStrings(values) {
  return [...new Set(normalizeArray(values).filter(value => value != null && value !== "").map(String))];
}

function normalizeArray(value) {
  if ( value == null ) return [];
  return Array.isArray(value) ? value : [value];
}

function stringOrNull(value) {
  if ( value == null ) return null;
  const string = String(value).trim();
  return string ? string : null;
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
