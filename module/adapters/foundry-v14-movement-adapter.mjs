import {WILDPATH} from "../config.mjs";
import {
  createFoundryV14TacticalGridAdapter,
  FOUNDRY_TACTICAL_GRID_CODES
} from "./foundry-v14-tactical-grid-adapter.mjs";
import {
  ECONOMY_CAPABILITIES,
  ECONOMY_UNITS
} from "../helpers/action-economy.mjs";
import {
  MOVEMENT_KINDS,
  MOVEMENT_MEASUREMENT_MODES,
  createMovementCapability,
  deriveMovementBudget
} from "../helpers/movement.mjs";
import {
  createMovementPath,
  evaluateMovementPath
} from "../helpers/movement-paths.mjs";
import {
  CREATURE_SIZES,
  fieldKey
} from "../helpers/grid-footprints.mjs";
import {
  MULTIPLAYER_AUTHORITY_CODES,
  clonePlainData,
  isPlainSerializableData
} from "../helpers/multiplayer-authority.mjs";

export const FOUNDRY_MOVEMENT_CODES = Object.freeze({
  OK: "OK",
  INVALID_INTENT: "INVALID_INTENT",
  INVALID_COMPLETION: "INVALID_COMPLETION",
  MISSING_MOVEMENT_ID: "MISSING_MOVEMENT_ID",
  MOVEMENT_NOT_APPROVED: "MOVEMENT_NOT_APPROVED",
  MOVEMENT_ALREADY_COMMITTED: "MOVEMENT_ALREADY_COMMITTED",
  MOVEMENT_REJECTED: "MOVEMENT_REJECTED",
  MOVEMENT_UNAFFORDABLE: "MOVEMENT_UNAFFORDABLE",
  MOVEMENT_COMMIT_FAILED: "MOVEMENT_COMMIT_FAILED",
  SCENE_NOT_FOUND: "SCENE_NOT_FOUND",
  TOKEN_NOT_FOUND: "TOKEN_NOT_FOUND",
  ACTOR_NOT_FOUND: "ACTOR_NOT_FOUND",
  MOVEMENT_RESOURCE_NOT_FOUND: "MOVEMENT_RESOURCE_NOT_FOUND",
  COMPLETE_PATH_UNAVAILABLE: "COMPLETE_PATH_UNAVAILABLE",
  COMPLETE_PATH_FAILED: "COMPLETE_PATH_FAILED",
  ORIGIN_MISMATCH: "ORIGIN_MISMATCH",
  DESTINATION_MISMATCH: "DESTINATION_MISMATCH",
  COMPLETION_ROUTE_MISMATCH: "COMPLETION_ROUTE_MISMATCH",
  MOVEMENT_PREFIX_MISMATCH: "MOVEMENT_PREFIX_MISMATCH",
  MOVEMENT_CONTINUATION_MISMATCH: "MOVEMENT_CONTINUATION_MISMATCH",
  MOVEMENT_PROGRESS_UNVERIFIED: "MOVEMENT_PROGRESS_UNVERIFIED",
  MOVEMENT_PAYMENT_MISMATCH: "MOVEMENT_PAYMENT_MISMATCH",
  MOVEMENT_OBSERVATION_AMBIGUOUS: "MOVEMENT_OBSERVATION_AMBIGUOUS",
  MOVEMENT_EVENT_DELIVERY_FAILED: "MOVEMENT_EVENT_DELIVERY_FAILED",
  GRID_ADAPTER_FAILED: "GRID_ADAPTER_FAILED",
  UNSUPPORTED_TOKEN_OPERATION: "UNSUPPORTED_TOKEN_OPERATION",
  NON_SERIALIZABLE_MOVEMENT: MULTIPLAYER_AUTHORITY_CODES.NON_SERIALIZABLE_MESSAGE
});

export const FOUNDRY_TOKEN_OPERATION_TYPES = Object.freeze({
  TRANSLATION: "translation",
  RESIZE: "resize",
  TRANSLATION_RESIZE: "translation-resize"
});

/* -------------------------------------------- */

/**
 * Build the plain movement proposal sent from a Foundry TokenDocument lifecycle method.
 * Foundry documents and measured movement cost are intentionally excluded from the intent.
 * @param {object} options
 * @returns {{ok: boolean, code?: string, reason?: string, intent?: object}}
 */
export function buildFoundryMovementIntent({
  tokenDocument=null,
  movement=null,
  operation={},
  user=null,
  game=globalThis.game
}={}) {
  const token = resolveTokenDocument(tokenDocument);
  if ( !token ) return failure(FOUNDRY_MOVEMENT_CODES.TOKEN_NOT_FOUND, "A TokenDocument is required to build a MovementIntent.");

  const movementId = stringOrNull(movement?.id ?? movement?.movementId ?? operation?.movementId ?? operation?.id);
  if ( !movementId ) return failure(FOUNDRY_MOVEMENT_CODES.MISSING_MOVEMENT_ID, "Foundry movement operations require a stable movement id.");

  const sourceUserId = stringOrNull(
    user?.id
    ?? operation?.userId
    ?? operation?.user?.id
    ?? game?.user?.id
    ?? game?.userId
  );
  const scene = token.parent ?? game?.canvas?.scene ?? game?.scenes?.viewed ?? null;
  const actor = token.actor ?? null;
  const tokenState = tokenPositionState(token);
  const waypoints = foundryMovementWaypoints(movement);
  const origin = mergeTokenMovementState(tokenState, plainTokenMovementState(movement?.origin)) ?? tokenState;
  const destination = mergeTokenMovementState(origin, plainTokenMovementState(movement?.destination) ?? waypoints.at(-1)) ?? origin;
  const tokenOperation = classifyFoundryTokenOperation({
    movement,
    operation,
    origin,
    destination,
    waypoints
  });

  const intent = {
    type: "MovementIntent",
    schemaVersion: 1,
    intentId: `movement-intent:${movementId}:${sourceUserId ?? "unknown"}`,
    resolutionId: movementResolutionId(movementId),
    movementId,
    sceneRef: plainSceneRef(scene),
    tokenRef: plainTokenRef(token, scene),
    actorRef: plainActorRef(actor, token),
    sourceUserId,
    movementKind: movementKindFromFoundryOperation({movement, operation}),
    movementMode: movementModeFromFoundryOperation({movement, operation}),
    origin,
    destination,
    waypoints: clonePlain(waypoints),
    foundry: {
      method: stringOrNull(movement?.method ?? operation?.movement?.method ?? operation?.method),
      tokenOperationType: tokenOperation.type,
      tokenOperation,
      subpathId: stringOrNull(movement?.subpathId ?? operation?.subpathId),
      chain: movementChain(movement),
      split: movement?.split === true,
      constrained: movement?.constrained === true || operation?.constrained === true,
      waypointCount: waypoints.length,
      passedWaypoints: normalizeMovementWaypoints(movement?.passed?.waypoints ?? []),
      completePathRequired: true
    },
    metadata: {
      source: "foundry-v14-token-movement",
      foundryLifecycle: "_preUpdateMovement",
      wildpathAuthority: "active-gm"
    }
  };

  if ( !isPlainSerializableData(intent) ) {
    return failure(FOUNDRY_MOVEMENT_CODES.NON_SERIALIZABLE_MOVEMENT, "MovementIntent must be plain JSON-serializable data.");
  }
  return {ok: true, code: FOUNDRY_MOVEMENT_CODES.OK, intent};
}

/* -------------------------------------------- */

/**
 * Build the plain post-movement completion notice sent after Foundry reports movement finished.
 * @param {object} options
 * @returns {{ok: boolean, code?: string, reason?: string, completion?: object}}
 */
export function buildFoundryMovementCompletion({
  tokenDocument=null,
  movement=null,
  operation={},
  user=null,
  game=globalThis.game,
  foundryLifecycle="moveToken",
  captureSource=false
}={}) {
  const token = resolveTokenDocument(tokenDocument);
  if ( !token ) return failure(FOUNDRY_MOVEMENT_CODES.TOKEN_NOT_FOUND, "A TokenDocument is required to build a movement completion.");

  const movementId = stringOrNull(movement?.id ?? movement?.movementId ?? operation?.movementId ?? operation?.id);
  if ( !movementId ) return failure(FOUNDRY_MOVEMENT_CODES.MISSING_MOVEMENT_ID, "Foundry movement completions require a stable movement id.");

  const sourceUserId = stringOrNull(user?.id ?? operation?.userId ?? game?.user?.id ?? game?.userId);
  const scene = token.parent ?? game?.canvas?.scene ?? game?.scenes?.viewed ?? null;
  const actor = token.actor ?? null;
  const tokenState = tokenPositionState(token);
  const waypoints = foundryMovementWaypoints(movement, {allowDestinationFallback: false});
  const origin = mergeTokenMovementState(tokenState, plainTokenMovementState(movement?.origin)) ?? tokenState;
  const destination = mergeTokenMovementState(origin, plainTokenMovementState(movement?.destination) ?? tokenPositionState(token) ?? waypoints.at(-1)) ?? null;
  const tokenOperation = classifyFoundryTokenOperation({
    movement,
    operation,
    origin,
    destination,
    waypoints
  });

  const completion = {
    type: "MovementCompletion",
    schemaVersion: 1,
    completionId: `movement-completion:${movementId}:${sourceUserId ?? "unknown"}`,
    resolutionId: movementResolutionId(movementId),
    movementId,
    sceneRef: plainSceneRef(scene),
    tokenRef: plainTokenRef(token, scene),
    actorRef: plainActorRef(actor, token),
    sourceUserId,
    destination,
    waypoints: clonePlain(waypoints),
    foundry: {
      method: stringOrNull(movement?.method ?? operation?.movement?.method ?? operation?.method),
      tokenOperationType: tokenOperation.type,
      tokenOperation,
      subpathId: stringOrNull(movement?.subpathId ?? operation?.subpathId),
      chain: movementChain(movement),
      split: movement?.split === true,
      completed: true
    },
    metadata: {
      source: "foundry-v14-token-movement",
      foundryLifecycle,
      wildpathAuthority: "active-gm"
    }
  };

  if ( !isPlainSerializableData(completion) ) {
    return failure(FOUNDRY_MOVEMENT_CODES.NON_SERIALIZABLE_MOVEMENT, "MovementCompletion must be plain JSON-serializable data.");
  }
  const source = captureSource ? tokenSourceFootprintPosition(token) : null;
  if ( source && !source.ok ) return source;
  return {ok: true, code: FOUNDRY_MOVEMENT_CODES.OK, completion, sourcePosition: source?.position ?? null};
}

/* -------------------------------------------- */

/** Snapshot local lifecycle evidence before any await; pending waypoints never prove travel. */
export function buildFoundryMovementProgressObservation({tokenDocument, movement, user, game, lifecycle, status}) {
  if ( !["moving", "paused", "interrupted"].includes(status)
    || !Array.isArray(movement?.passed?.waypoints)
    || (lifecycle === "pauseToken" && movement.state !== "paused")
    || (lifecycle === "stopToken" && movement.state !== "stopped") ) {
    return failure(FOUNDRY_MOVEMENT_CODES.MOVEMENT_OBSERVATION_AMBIGUOUS,
      "Movement lifecycle lacks a correlated state and passed path.");
  }
  const built = buildFoundryMovementCompletion({tokenDocument, movement, user, game,
    foundryLifecycle: lifecycle, captureSource: true});
  if ( !built.ok ) return built;
  const passed = normalizeMovementWaypoints(movement.passed.waypoints);
  if ( passed.length !== movement.passed.waypoints.length || !plainTokenMovementState(movement.origin)
    || passed.some(waypoint => waypoint.movementId !== movement.id || waypoint.subpathId !== movement.subpathId) ) {
    return failure(FOUNDRY_MOVEMENT_CODES.MOVEMENT_OBSERVATION_AMBIGUOUS, "Passed movement waypoints are malformed.");
  }
  const completion = built.completion;
  completion.waypoints = passed.length ? passed : [plainTokenMovementState(movement.origin)];
  completion.foundry.completed = false;
  completion.foundry.progressStatus = status;
  completion.foundry.state = stringOrNull(movement.state);
  completion.foundry.constrained = movement.constrained === true;
  completion.foundry.passedWaypointCount = passed.length;
  return built;
}

export function sanitizeMovementIntent(intent={}) {
  const data = clonePlainData(intent, "movementIntent") ?? {};
  const movementId = stringOrNull(data.movementId);
  return {
    type: "MovementIntent",
    schemaVersion: finiteInteger(data.schemaVersion) ?? 1,
    intentId: stringOrNull(data.intentId) ?? (movementId ? `movement-intent:${movementId}` : null),
    resolutionId: stringOrNull(data.resolutionId) ?? movementResolutionId(movementId),
    movementId,
    sceneRef: normalizeEntityRef(data.sceneRef),
    tokenRef: normalizeEntityRef(data.tokenRef),
    actorRef: normalizeEntityRef(data.actorRef),
    sourceUserId: stringOrNull(data.sourceUserId ?? data.userId),
    movementKind: normalizeMovementKind(data.movementKind),
    movementMode: stringOrNull(data.movementMode) ?? "walk",
    origin: plainTokenMovementState(data.origin),
    destination: plainTokenMovementState(data.destination),
    waypoints: normalizeMovementWaypoints(data.waypoints),
    foundry: clonePlain(data.foundry ?? {}),
    metadata: clonePlain(data.metadata ?? {})
  };
}

export function sanitizeMovementCompletion(completion={}) {
  const data = clonePlainData(completion, "movementCompletion") ?? {};
  const movementId = stringOrNull(data.movementId);
  return {
    type: "MovementCompletion",
    schemaVersion: finiteInteger(data.schemaVersion) ?? 1,
    completionId: stringOrNull(data.completionId) ?? (movementId ? `movement-completion:${movementId}` : null),
    resolutionId: stringOrNull(data.resolutionId) ?? movementResolutionId(movementId),
    movementId,
    sceneRef: normalizeEntityRef(data.sceneRef),
    tokenRef: normalizeEntityRef(data.tokenRef),
    actorRef: normalizeEntityRef(data.actorRef),
    sourceUserId: stringOrNull(data.sourceUserId ?? data.userId),
    destination: plainTokenMovementState(data.destination),
    waypoints: normalizeMovementWaypoints(data.waypoints),
    foundry: clonePlain(data.foundry ?? {}),
    metadata: clonePlain(data.metadata ?? {})
  };
}

/* -------------------------------------------- */

export async function resolveFoundryMovementDocuments({intent={}, game=globalThis.game}={}) {
  const sanitized = sanitizeMovementIntent(intent);
  const scene = await resolveSceneRef(sanitized.sceneRef, {game});
  if ( !scene ) return failure(FOUNDRY_MOVEMENT_CODES.SCENE_NOT_FOUND, "MovementIntent sceneRef could not be resolved.");

  const token = resolveTokenRef(sanitized.tokenRef, {scene});
  if ( !token ) return failure(FOUNDRY_MOVEMENT_CODES.TOKEN_NOT_FOUND, "MovementIntent tokenRef could not be resolved on the authoritative Scene.");

  const actor = token.actor ?? null;
  const operationType = foundryTokenOperationTypeFromIntent(sanitized);
  if ( !actor && sanitized.movementKind === MOVEMENT_KINDS.VOLUNTARY && operationType === FOUNDRY_TOKEN_OPERATION_TYPES.TRANSLATION ) {
    return failure(FOUNDRY_MOVEMENT_CODES.ACTOR_NOT_FOUND, "Voluntary Token movement requires the moving Token Actor.");
  }

  return {
    ok: true,
    code: FOUNDRY_MOVEMENT_CODES.OK,
    intent: sanitized,
    scene,
    token,
    actor
  };
}

/* -------------------------------------------- */

export function foundryMovementIntentToMovementPath({
  intent={},
  tokenDocument=null,
  scene=null
}={}) {
  const token = resolveTokenDocument(tokenDocument);
  if ( !token ) return failure(FOUNDRY_MOVEMENT_CODES.TOKEN_NOT_FOUND, "A TokenDocument is required to translate movement.");

  const sanitized = sanitizeMovementIntent(intent);
  const adapter = createFoundryV14TacticalGridAdapter({scene: scene ?? token.parent});
  const sceneContext = adapter.getSceneContext();
  if ( !sceneContext.ok ) return gridFailure(sceneContext);

  const sourceState = authoritativeTokenSourceState(token);
  if ( !sourceState.ok ) return sourceState;

  const footprintResult = tokenFootprintAtMovementState({
    adapter,
    tokenDocument: token,
    state: sourceState.state
  });
  if ( !footprintResult.ok ) return footprintResult;

  const originCheck = validateIntentOrigin({
    intent: sanitized,
    adapter,
    tokenDocument: token,
    origin: footprintResult,
    sourceState: sourceState.state
  });
  if ( !originCheck.ok ) return originCheck;

  return translateFoundryMovementWaypoints({
    intent: sanitized, token, adapter, sceneContext, originState: sourceState.state, footprintResult
  });
}

/** Reconstruct an observed completed route; source/destination authority is verified by the caller. */
export function foundryMovementCompletionToMovementPath({completion, approval, originState, tokenDocument, scene}) {
  const token = resolveTokenDocument(tokenDocument);
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  const sceneContext = adapter.getSceneContext();
  if ( !sceneContext.ok ) return gridFailure(sceneContext);
  const footprintResult = tokenFootprintAtMovementState({adapter, tokenDocument: token, state: originState});
  if ( !footprintResult.ok ) return footprintResult;
  if ( !completion.waypoints?.length ) return failure(
    FOUNDRY_MOVEMENT_CODES.COMPLETION_ROUTE_MISMATCH,
    "Observed movement must include route waypoints before semantic transitions can be confirmed."
  );
  const intent = sanitizeMovementIntent({
    ...completion,
    origin: originState,
    movementKind: approval.path.movementKind,
    movementMode: approval.path.movementMode
  });
  return translateFoundryMovementWaypoints({intent, token, adapter, sceneContext, originState, footprintResult});
}

function translateFoundryMovementWaypoints({intent: sanitized, token, adapter, sceneContext, originState, footprintResult}) {
  const complete = getCompleteFoundryMovementWaypoints({
    intent: sanitized,
    tokenDocument: token,
    origin: originState
  });
  if ( !complete.ok ) return complete;

  const converted = complete.waypoints.map((waypoint, index) => {
    // Foundry waypoints are Token placements, not tactical anchors. Pure translation
    // retains the source dimensions even when intermediate waypoints contain only x/y.
    const state = mergeTokenMovementState(originState, waypoint);
    if ( !sameFootprintDimensions(state, originState) ) return {
      ...failure(FOUNDRY_MOVEMENT_CODES.UNSUPPORTED_TOKEN_OPERATION,
        "Combined Token translation and footprint resize is not yet supported by WildPath movement authority."),
      index
    };
    const result = tokenFootprintAtMovementState({adapter, tokenDocument: token, state});
    if ( !result.ok ) return {
      ok: false,
      index,
      code: result.code,
      reason: result.reason,
      waypoint
    };
    return {ok: true, index, anchor: result.anchor};
  });
  const failed = converted.find(entry => !entry.ok);
  if ( failed ) return failure(
    failed.code ?? FOUNDRY_MOVEMENT_CODES.GRID_ADAPTER_FAILED,
    failed.reason ?? "A Foundry movement waypoint could not be converted to a WildPath TokenGridFootprint.",
    {waypointIndex: failed.index}
  );

  const anchors = dedupeAnchors(
    [footprintResult.anchor, ...converted.map(entry => entry.anchor)],
    footprintResult.topology
  );
  const movementPath = createMovementPath({
    id: sanitized.movementId,
    anchors,
    topology: footprintResult.topology,
    size: footprintResult.footprint.size,
    footprintDefinition: footprintResult.footprint.definition,
    movementKind: sanitized.movementKind,
    movementMode: sanitized.movementMode,
    metadata: {
      source: "foundry-v14-token-movement",
      movementId: sanitized.movementId,
      sceneRef: sanitized.sceneRef?.ref ?? sanitized.sceneRef?.id ?? null,
      tokenRef: sanitized.tokenRef?.ref ?? sanitized.tokenRef?.id ?? null,
      foundryCompleteWaypointCount: complete.waypoints.length,
      foundryRawWaypointCount: sanitized.waypoints.length
    }
  });

  return {
    ok: true,
    code: FOUNDRY_MOVEMENT_CODES.OK,
    intent: sanitized,
    sceneContext: sceneContext.context,
    tokenFootprint: footprintResult.footprint,
    originState: clonePlain(originState),
    anchors: clonePlain(anchors),
    path: movementPath,
    completeWaypointCount: complete.waypoints.length
  };
}

/* -------------------------------------------- */

export async function authorizeFoundryMovementIntent({
  intent={},
  game=globalThis.game,
  measurementMode=null,
  stepCostPolicy=null,
  occupancyPolicy=null,
  transitionPolicy=null
}={}) {
  const documents = await resolveFoundryMovementDocuments({intent, game});
  if ( !documents.ok ) return movementApproval(false, {
    code: documents.code,
    reason: documents.reason,
    intent: sanitizeMovementIntent(intent)
  });

  const operationType = foundryTokenOperationTypeFromIntent(documents.intent);
  if ( operationType === FOUNDRY_TOKEN_OPERATION_TYPES.RESIZE ) {
    return authorizeFoundryTokenResizeIntent({
      documents
    });
  }
  if ( operationType === FOUNDRY_TOKEN_OPERATION_TYPES.TRANSLATION_RESIZE ) {
    return movementApproval(false, {
      code: FOUNDRY_MOVEMENT_CODES.UNSUPPORTED_TOKEN_OPERATION,
      reason: "Combined Token translation and footprint resize is not yet supported by WildPath movement authority.",
      intent: documents.intent,
      foundryOperation: documents.intent.foundry?.tokenOperation ?? {type: operationType}
    });
  }

  const translated = foundryMovementIntentToMovementPath({
    intent: documents.intent,
    tokenDocument: documents.token,
    scene: documents.scene
  });
  if ( !translated.ok ) return movementApproval(false, {
    code: translated.code,
    reason: translated.reason,
    diagnostics: translated.diagnostics,
    intent: documents.intent
  });

  const resolvedMode = resolveMovementMeasurementMode({game, measurementMode});
  const budgetResult = movementBudgetForActor({
    actor: documents.actor,
    movementMode: documents.intent.movementMode,
    movementKind: documents.intent.movementKind,
    measurementMode: resolvedMode,
    grid: translated.sceneContext.grid
  });
  if ( !budgetResult.ok && documents.intent.movementKind === MOVEMENT_KINDS.VOLUNTARY ) {
    return movementApproval(false, {
      code: budgetResult.code,
      reason: budgetResult.reason,
      intent: documents.intent,
      path: translated.path
    });
  }

  const evaluation = evaluateMovementPath(translated.path, {
    measurementMode: resolvedMode,
    grid: translated.sceneContext.grid,
    distanceUnit: translated.sceneContext.grid?.units || "ft",
    budget: budgetResult.budget ?? null,
    occupancyPolicy,
    transitionPolicy,
    stepCostPolicy,
    context: {
      source: "foundry-v14-token-movement",
      movementId: documents.intent.movementId,
      sceneRef: documents.intent.sceneRef,
      tokenRef: documents.intent.tokenRef,
      actorRef: documents.intent.actorRef
    }
  });

  const affordable = documents.intent.movementKind === MOVEMENT_KINDS.VOLUNTARY
    ? evaluation.affordable === true
    : evaluation.affordable !== false;
  const approved = evaluation.valid === true && evaluation.cost?.ok === true && affordable;
  const code = approved
    ? FOUNDRY_MOVEMENT_CODES.OK
    : movementRejectionCode(evaluation);
  const reason = approved ? null : movementRejectionReason(evaluation);
  const signature = movementPathSignature({
    intent: documents.intent,
    path: evaluation.path ?? translated.path
  });

  return movementApproval(approved, {
    code,
    reason,
    intent: documents.intent,
    path: translated.path,
    evaluation,
    signature,
    foundryOriginState: translated.originState,
    payment: movementPaymentFromEvaluation(evaluation)
  });
}

function authorizeFoundryTokenResizeIntent({documents={}}={}) {
  const intent = documents.intent ?? sanitizeMovementIntent();
  const adapter = createFoundryV14TacticalGridAdapter({scene: documents.scene});
  const sceneContext = adapter.getSceneContext();
  if ( !sceneContext.ok ) return movementApproval(false, {
    code: FOUNDRY_MOVEMENT_CODES.GRID_ADAPTER_FAILED,
    reason: sceneContext.reason,
    intent
  });

  const sourceState = authoritativeTokenSourceState(documents.token);
  if ( !sourceState.ok ) return movementApproval(false, {
    code: sourceState.code,
    reason: sourceState.reason,
    intent
  });

  const origin = tokenFootprintAtMovementState({
    adapter,
    tokenDocument: documents.token,
    state: sourceState.state,
    fallbackSize: creatureSizeForMovementState(intent.origin, documents.token)
  });
  if ( !origin.ok ) return movementApproval(false, {
    code: origin.code,
    reason: origin.reason,
    intent
  });

  const originCheck = validateIntentOrigin({
    intent,
    sourceState: sourceState.state,
    origin,
    adapter,
    tokenDocument: documents.token
  });
  if ( !originCheck.ok ) return movementApproval(false, {
    code: originCheck.code,
    reason: originCheck.reason,
    diagnostics: originCheck.diagnostics,
    intent,
    foundryOperation: intent.foundry?.tokenOperation ?? {type: FOUNDRY_TOKEN_OPERATION_TYPES.RESIZE}
  });

  const destination = tokenFootprintAtMovementState({
    adapter,
    tokenDocument: documents.token,
    state: intent.destination,
    fallbackSize: creatureSizeForMovementState(intent.destination, documents.token)
  });
  if ( !destination.ok ) return movementApproval(false, {
    code: destination.code,
    reason: destination.reason,
    intent
  });

  const transition = {
    type: "TokenFootprintTransition",
    operationType: FOUNDRY_TOKEN_OPERATION_TYPES.RESIZE,
    origin: resizeEndpoint({
      state: sourceState.state,
      footprintResult: origin
    }),
    destination: resizeEndpoint({
      state: intent.destination,
      footprintResult: destination
    }),
    consumesBudget: false,
    amount: 0
  };
  const evaluation = createResizeEvaluation({
    intent,
    transition,
    sceneContext: sceneContext.context
  });

  return movementApproval(true, {
    code: FOUNDRY_MOVEMENT_CODES.OK,
    intent,
    evaluation,
    signature: movementFootprintTransitionSignature({intent, transition}),
    payment: movementPaymentFromEvaluation(evaluation),
    footprintTransition: transition,
    foundryOperation: intent.foundry?.tokenOperation ?? {type: FOUNDRY_TOKEN_OPERATION_TYPES.RESIZE}
  });
}

/* -------------------------------------------- */

export function movementPathSignature({intent={}, path={}}={}) {
  const sanitized = sanitizeMovementIntent(intent);
  const anchors = path?.anchors ?? [];
  return stableStringify({
    movementId: sanitized.movementId,
    sceneRef: sanitized.sceneRef?.ref ?? sanitized.sceneRef?.id ?? null,
    tokenRef: sanitized.tokenRef?.ref ?? sanitized.tokenRef?.id ?? null,
    actorRef: sanitized.actorRef?.ref ?? sanitized.actorRef?.id ?? null,
    sourceUserId: sanitized.sourceUserId,
    movementKind: sanitized.movementKind,
    movementMode: sanitized.movementMode,
    anchors
  });
}

export function movementFootprintTransitionSignature({intent={}, transition=null}={}) {
  const sanitized = sanitizeMovementIntent(intent);
  return stableStringify({
    movementId: sanitized.movementId,
    sceneRef: sanitized.sceneRef?.ref ?? sanitized.sceneRef?.id ?? null,
    tokenRef: sanitized.tokenRef?.ref ?? sanitized.tokenRef?.id ?? null,
    actorRef: sanitized.actorRef?.ref ?? sanitized.actorRef?.id ?? null,
    sourceUserId: sanitized.sourceUserId,
    foundryOperationType: transition?.operationType ?? foundryTokenOperationTypeFromIntent(sanitized),
    origin: transition?.origin ? {
      state: transition.origin.state,
      anchor: transition.origin.anchor,
      size: transition.origin.footprint?.size ?? null,
      fieldKeys: transition.origin.footprint?.fieldKeys ?? []
    } : null,
    destination: transition?.destination ? {
      state: transition.destination.state,
      anchor: transition.destination.anchor,
      size: transition.destination.footprint?.size ?? null,
      fieldKeys: transition.destination.footprint?.fieldKeys ?? []
    } : null
  });
}

export function movementKey(value={}) {
  const movementId = stringOrNull(value.movementId);
  const sceneRef = normalizeEntityRef(value.sceneRef);
  const tokenRef = normalizeEntityRef(value.tokenRef);
  return [
    sceneRef?.ref ?? sceneRef?.id ?? "scene:unknown",
    tokenRef?.ref ?? tokenRef?.id ?? "token:unknown",
    movementId ?? "movement:unknown"
  ].join("|");
}

export function movementResolutionId(movementId) {
  const id = stringOrNull(movementId);
  return id ? `movement:${id}` : null;
}

export function movementPaymentFromEvaluation(evaluation={}) {
  const cost = evaluation.cost ?? {};
  const amount = Math.max(Number(cost.amount ?? 0) || 0, 0);
  if ( cost.consumesBudget === false || amount <= 0 ) {
    return {
      consumesBudget: false,
      amount: 0,
      actorResourceAmount: 0,
      unit: null,
      measurementMode: evaluation.trace?.measurementMode ?? null
    };
  }

  const measurementMode = evaluation.trace?.measurementMode
    ?? evaluation.routeCost?.measurementMode
    ?? evaluation.budget?.metadata?.measurementMode
    ?? MOVEMENT_MEASUREMENT_MODES.DISTANCE;
  const gridDistance = Number(evaluation.grid?.distance ?? evaluation.budget?.metadata?.gridDistance ?? 0) || 0;
  const actorResourceAmount = measurementMode === MOVEMENT_MEASUREMENT_MODES.FIELDS
    ? amount * gridDistance
    : amount;

  return {
    consumesBudget: true,
    amount,
    actorResourceAmount,
    unit: cost.unit ?? null,
    actorResourceUnit: evaluation.budget?.metadata?.distanceUnit ?? "ft",
    measurementMode,
    gridDistance: gridDistance || null,
    resourceId: "economy.movement",
    capability: ECONOMY_CAPABILITIES.MOVEMENT,
    economyUnit: ECONOMY_UNITS.MOVEMENT
  };
}

/* -------------------------------------------- */

export async function resolveMovementCompletionDocuments({completion={}, game=globalThis.game, tokenDocument=null}={}) {
  const sanitized = sanitizeMovementCompletion(completion);
  const observedToken = resolveTokenDocument(tokenDocument);
  if ( observedToken ) return resolveObservedMovementCompletionDocuments({
    completion: sanitized,
    tokenDocument: observedToken,
    game
  });

  const scene = await resolveSceneRef(sanitized.sceneRef, {game});
  if ( !scene ) return failure(FOUNDRY_MOVEMENT_CODES.SCENE_NOT_FOUND, "MovementCompletion sceneRef could not be resolved.");
  const token = resolveTokenRef(sanitized.tokenRef, {scene});
  if ( !token ) return failure(FOUNDRY_MOVEMENT_CODES.TOKEN_NOT_FOUND, "MovementCompletion tokenRef could not be resolved on the authoritative Scene.");
  const actor = token.actor ?? null;
  const operationType = foundryTokenOperationTypeFromIntent(sanitized);
  if ( !actor && operationType !== FOUNDRY_TOKEN_OPERATION_TYPES.RESIZE ) {
    return failure(FOUNDRY_MOVEMENT_CODES.ACTOR_NOT_FOUND, "MovementCompletion Token Actor could not be resolved.");
  }
  const sourcePosition = tokenSourceFootprintPosition(token);
  if ( !sourcePosition.ok ) return sourcePosition;
  return {
    ok: true,
    code: FOUNDRY_MOVEMENT_CODES.OK,
    completion: sanitized,
    scene,
    token,
    actor,
    sourcePosition: sourcePosition.position
  };
}

async function resolveObservedMovementCompletionDocuments({completion={}, tokenDocument=null, game=globalThis.game}={}) {
  const token = resolveTokenDocument(tokenDocument);
  if ( !token ) return failure(FOUNDRY_MOVEMENT_CODES.TOKEN_NOT_FOUND, "Observed moveToken document could not be resolved.");

  const scene = token.parent ?? await resolveSceneRef(completion.sceneRef, {game});
  if ( !scene ) return failure(FOUNDRY_MOVEMENT_CODES.SCENE_NOT_FOUND, "Observed moveToken Scene could not be resolved.");
  if ( !entityRefMatchesDocument(completion.sceneRef, scene, expandSceneRef) ) {
    return failure(FOUNDRY_MOVEMENT_CODES.SCENE_NOT_FOUND, "Observed moveToken Scene does not match the approved movement Scene.");
  }
  if ( !entityRefMatchesDocument(completion.tokenRef, token, expandTokenRef) ) {
    return failure(FOUNDRY_MOVEMENT_CODES.TOKEN_NOT_FOUND, "Observed moveToken document does not match the approved movement Token.");
  }

  const actor = token.actor ?? null;
  const operationType = foundryTokenOperationTypeFromIntent(completion);
  if ( !actor && operationType !== FOUNDRY_TOKEN_OPERATION_TYPES.RESIZE ) {
    return failure(FOUNDRY_MOVEMENT_CODES.ACTOR_NOT_FOUND, "Observed moveToken Actor could not be resolved.");
  }
  const sourcePosition = tokenSourceFootprintPosition(token);
  if ( !sourcePosition.ok ) return sourcePosition;
  return {
    ok: true,
    code: FOUNDRY_MOVEMENT_CODES.OK,
    completion,
    scene,
    token,
    actor,
    sourcePosition: sourcePosition.position
  };
}

export function currentTokenAnchor({tokenDocument=null, scene=null, position=null}={}) {
  const token = resolveTokenDocument(tokenDocument);
  if ( !token ) return failure(FOUNDRY_MOVEMENT_CODES.TOKEN_NOT_FOUND, "A TokenDocument is required to resolve its current anchor.");
  const adapter = createFoundryV14TacticalGridAdapter({scene: scene ?? token.parent});
  const footprint = tokenFootprintAtMovementState({
    adapter,
    tokenDocument: token,
    state: position ?? tokenPositionState(token)
  });
  if ( !footprint.ok ) return footprint;
  return {
    ok: true,
    code: FOUNDRY_MOVEMENT_CODES.OK,
    anchor: footprint.anchor,
    topology: footprint.topology,
    footprint: footprint.footprint
  };
}

export function tokenSourceFootprintPosition(tokenDocument=null) {
  const token = resolveTokenDocument(tokenDocument);
  if ( !token ) return failure(FOUNDRY_MOVEMENT_CODES.TOKEN_NOT_FOUND, "A TokenDocument is required to read completed movement source position.");
  if ( typeof token.toObject !== "function" ) {
    return failure(
      FOUNDRY_MOVEMENT_CODES.INVALID_COMPLETION,
      "Completed movement verification requires TokenDocument#toObject(true) source data."
    );
  }

  let source;
  try {
    source = token.toObject(true);
  } catch (error) {
    return failure(
      FOUNDRY_MOVEMENT_CODES.INVALID_COMPLETION,
      error?.message ?? "TokenDocument#toObject(true) failed while reading completed movement source position."
    );
  }

  const position = plainTokenFootprintPosition(source);
  if ( !position ) return failure(
    FOUNDRY_MOVEMENT_CODES.INVALID_COMPLETION,
    "TokenDocument#toObject(true) did not provide finite source x and y values for completed movement verification."
  );
  return {
    ok: true,
    code: FOUNDRY_MOVEMENT_CODES.OK,
    position
  };
}

export function expectedMovementDestinationAnchor(approval={}) {
  const transitionAnchor = approval?.footprintTransition?.destination?.anchor;
  if ( transitionAnchor ) return transitionAnchor;
  const path = approval.path ?? approval.evaluation?.path ?? null;
  return path?.anchors?.length ? path.anchors[path.anchors.length - 1] : null;
}

export function expectedMovementDestinationState(approval={}) {
  return plainTokenMovementState(approval?.footprintTransition?.destination?.state);
}

export function createMovementPaymentPlan({movementId=null, payment=null}={}) {
  if ( !payment?.consumesBudget || !(Number(payment.actorResourceAmount) > 0) ) {
    return {
      id: `movement-payment:${movementId ?? "unknown"}`,
      resources: []
    };
  }
  return {
    id: `movement-payment:${movementId ?? "unknown"}`,
    resources: [{
      resourceId: payment.resourceId ?? "economy.movement",
      amount: Number(payment.actorResourceAmount),
      capability: payment.capability ?? ECONOMY_CAPABILITIES.MOVEMENT,
      unit: payment.economyUnit ?? ECONOMY_UNITS.MOVEMENT,
      mode: "direct",
      source: {
        type: "movement",
        movementId,
        measurementMode: payment.measurementMode ?? null,
        routeAmount: payment.amount ?? 0,
        routeUnit: payment.unit ?? null
      }
    }]
  };
}

/* -------------------------------------------- */

function authoritativeTokenSourceState(tokenDocument=null) {
  // Approval and completion must agree on persisted state even while prepared values lag.
  const source = tokenSourceFootprintPosition(tokenDocument);
  if ( !source.ok ) return source;
  return {
    ok: true,
    code: FOUNDRY_MOVEMENT_CODES.OK,
    state: source.position
  };
}

function tokenFootprintAtMovementState({adapter=null, tokenDocument=null, state=null, fallbackSize=null}={}) {
  const normalizedState = plainTokenMovementState(state);
  if ( !normalizedState ) return failure(
    FOUNDRY_MOVEMENT_CODES.INVALID_INTENT,
    "Token footprint state requires finite x and y values."
  );
  const footprint = adapter?.tokenToFootprint?.(tokenDocument, {
    position: normalizedState,
    size: creatureSizeForMovementState(normalizedState, tokenDocument, fallbackSize)
  });
  if ( !footprint?.ok || !footprint.footprint ) return gridFailure(footprint);
  return {
    ok: true,
    code: FOUNDRY_MOVEMENT_CODES.OK,
    state: normalizedState,
    anchor: footprint.anchor,
    topology: footprint.topology,
    footprint: footprint.footprint,
    representedFields: footprint.representedFields ?? [],
    diagnostics: footprint.diagnostics ?? []
  };
}

function validateIntentOrigin({intent={}, sourceState=null, origin=null, adapter=null, tokenDocument=null}={}) {
  if ( !intent.origin ) return failure(
    FOUNDRY_MOVEMENT_CODES.ORIGIN_MISMATCH,
    "MovementIntent must include the client-observed origin so authority can detect stale proposals."
  );

  const proposed = tokenFootprintAtMovementState({
    adapter,
    tokenDocument,
    state: intent.origin,
    fallbackSize: creatureSizeForMovementState(sourceState, tokenDocument)
  });
  if ( !proposed.ok ) return failure(
    FOUNDRY_MOVEMENT_CODES.ORIGIN_MISMATCH,
    proposed.reason ?? "MovementIntent origin could not be converted to a TokenGridFootprint.",
    {adapterCode: proposed.code}
  );

  const clientOriginFields = [...new Set(proposed.footprint.fieldKeys)].sort();
  const authoritativeOriginFields = [...new Set(origin.footprint.fieldKeys)].sort();
  const dimensionCheck = compareMovementStateDimensions(intent.origin, sourceState);
  const sameFootprint = proposed.topology === origin.topology
    && fieldKey(proposed.anchor, proposed.topology) === fieldKey(origin.anchor, origin.topology)
    && JSON.stringify(clientOriginFields) === JSON.stringify(authoritativeOriginFields);
  if ( !sameFootprint || !dimensionCheck.matches ) return failure(
    FOUNDRY_MOVEMENT_CODES.ORIGIN_MISMATCH,
    "MovementIntent origin footprint state does not match the authoritative Token source state.",
    {
      diagnostics: {
        mismatches: dimensionCheck.mismatches,
        clientOriginState: proposed.state,
        clientOriginTopology: proposed.topology,
        clientOriginAnchor: proposed.anchor,
        clientOriginFields,
        authoritativeOriginState: origin.state,
        authoritativeOriginTopology: origin.topology,
        authoritativeOriginAnchor: origin.anchor,
        authoritativeOriginFields
      }
    }
  );

  return {ok: true, code: FOUNDRY_MOVEMENT_CODES.OK};
}

function resizeEndpoint({state=null, footprintResult=null}={}) {
  return clonePlain({
    state: plainTokenMovementState(state),
    anchor: footprintResult?.anchor ?? null,
    topology: footprintResult?.topology ?? null,
    footprint: footprintResult?.footprint ?? null,
    representedFields: footprintResult?.representedFields ?? [],
    diagnostics: footprintResult?.diagnostics ?? []
  });
}

function createResizeEvaluation({intent={}, transition=null, sceneContext=null}={}) {
  return clonePlain({
    ok: true,
    code: FOUNDRY_MOVEMENT_CODES.OK,
    valid: true,
    path: null,
    footprints: [
      transition?.origin?.footprint,
      transition?.destination?.footprint
    ].filter(Boolean),
    transitions: [{
      type: "footprint-resize",
      operationType: FOUNDRY_TOKEN_OPERATION_TYPES.RESIZE,
      origin: transition?.origin?.anchor ?? null,
      destination: transition?.destination?.anchor ?? null,
      adjacent: null,
      cost: {
        amount: 0,
        unit: null,
        consumesBudget: false
      }
    }],
    routeCost: {
      ok: true,
      amount: 0,
      unit: null,
      consumesBudget: false
    },
    cost: {
      ok: true,
      code: "NO_MOVEMENT_BUDGET_CONSUMPTION",
      amount: 0,
      unit: null,
      consumesBudget: false,
      movementKind: intent.movementKind
    },
    budget: null,
    spend: {
      ok: true,
      code: "NO_MOVEMENT_BUDGET_CONSUMPTION",
      budget: null
    },
    affordable: true,
    failures: [],
    trace: {
      movementKind: intent.movementKind,
      movementMode: intent.movementMode,
      measurementMode: null,
      foundryOperationType: FOUNDRY_TOKEN_OPERATION_TYPES.RESIZE
    },
    grid: sceneContext?.grid ?? null
  });
}

function compareMovementStateDimensions(left, right) {
  const leftState = plainTokenMovementState(left);
  const rightState = plainTokenMovementState(right);
  const mismatches = [];
  for ( const key of ["elevation", "width", "height", "depth", "shape"] ) {
    if ( (leftState?.[key] ?? null) !== (rightState?.[key] ?? null) ) {
      mismatches.push({
        field: key,
        expected: leftState?.[key] ?? null,
        actual: rightState?.[key] ?? null
      });
    }
  }
  return {
    matches: mismatches.length === 0,
    mismatches
  };
}

function foundryTokenOperationTypeFromIntent(intent={}) {
  return normalizeFoundryTokenOperationType(
    intent?.foundry?.tokenOperationType
    ?? intent?.foundry?.tokenOperation?.type
    ?? intent?.tokenOperationType
  );
}

function normalizeFoundryTokenOperationType(type) {
  const value = stringOrNull(type) ?? FOUNDRY_TOKEN_OPERATION_TYPES.TRANSLATION;
  return Object.values(FOUNDRY_TOKEN_OPERATION_TYPES).includes(value)
    ? value
    : FOUNDRY_TOKEN_OPERATION_TYPES.TRANSLATION;
}

function creatureSizeForMovementState(state=null, tokenDocument=null, fallbackSize=null) {
  return creatureSizeFromTokenDimensions(state)
    ?? normalizeCreatureSize(fallbackSize)
    ?? defaultTokenCreatureSize(tokenDocument)
    ?? CREATURE_SIZES.MEDIUM;
}

function defaultTokenCreatureSize(tokenDocument=null) {
  return normalizeCreatureSize(tokenDocument?.wildpathSize)
    ?? normalizeCreatureSize(tokenDocument?.actor?.system?.traits?.size)
    ?? normalizeCreatureSize(tokenDocument?.actor?.system?.details?.size)
    ?? normalizeCreatureSize(tokenDocument?.actor?.system?.size)
    ?? null;
}

function creatureSizeFromTokenDimensions(state=null) {
  const width = finiteNumber(state?.width);
  const height = finiteNumber(state?.height);
  const maximum = Math.max(width ?? 0, height ?? 0);
  if ( maximum >= 4 ) return CREATURE_SIZES.GARGANTUAN;
  if ( maximum >= 3 ) return CREATURE_SIZES.HUGE;
  if ( maximum >= 2 ) return CREATURE_SIZES.LARGE;
  return null;
}

function normalizeCreatureSize(size) {
  const value = stringOrNull(size)?.toLowerCase();
  return Object.values(CREATURE_SIZES).includes(value) ? value : null;
}

/* -------------------------------------------- */

export function getCompleteFoundryMovementWaypoints({intent={}, tokenDocument=null, origin=null}={}) {
  const token = resolveTokenDocument(tokenDocument);
  // Teleport waypoints are discontinuous endpoints. Foundry's direct-path expansion would
  // invent intermediate fields which were never traversed.
  if ( intent.movementKind === MOVEMENT_KINDS.TELEPORT ) return {
    ok: true,
    code: FOUNDRY_MOVEMENT_CODES.OK,
    waypoints: prependPointIfDifferent(origin, intent.waypoints?.length ? intent.waypoints : [intent.destination].filter(Boolean))
  };
  if ( typeof token?.getCompleteMovementPath !== "function" ) {
    return failure(
      FOUNDRY_MOVEMENT_CODES.COMPLETE_PATH_UNAVAILABLE,
      "TokenDocument#getCompleteMovementPath is required for Foundry movement translation."
    );
  }

  const requested = normalizeMovementWaypoints(
    intent.waypoints?.length ? intent.waypoints : (intent.destination ? [intent.destination] : [])
  );
  if ( !requested.length ) return {
    ok: true,
    code: FOUNDRY_MOVEMENT_CODES.OK,
    waypoints: origin ? [origin] : []
  };
  const completeInput = origin ? prependPointIfDifferent(origin, requested) : requested;

  let complete;
  try {
    complete = token.getCompleteMovementPath(completeInput.map(waypoint => clonePlain(waypoint)));
  } catch (error) {
    return failure(
      FOUNDRY_MOVEMENT_CODES.COMPLETE_PATH_FAILED,
      error?.message ?? String(error)
    );
  }

  const completedWaypoints = normalizeMovementWaypoints(complete);
  if ( !completedWaypoints.length ) return failure(
    FOUNDRY_MOVEMENT_CODES.COMPLETE_PATH_FAILED,
    "TokenDocument#getCompleteMovementPath returned no route for a non-empty movement proposal."
  );
  return {
    ok: true,
    code: FOUNDRY_MOVEMENT_CODES.OK,
    waypoints: origin ? prependPointIfDifferent(origin, completedWaypoints) : completedWaypoints
  };
}

function movementBudgetForActor({actor=null, movementMode="walk", movementKind=MOVEMENT_KINDS.VOLUNTARY, measurementMode, grid=null}={}) {
  if ( movementKind !== MOVEMENT_KINDS.VOLUNTARY && !actor?.system?.resources?.movement ) {
    return {
      ok: true,
      code: FOUNDRY_MOVEMENT_CODES.OK,
      budget: null
    };
  }
  const resource = actor?.system?.resources?.movement ?? null;
  if ( !resource ) return failure(FOUNDRY_MOVEMENT_CODES.MOVEMENT_RESOURCE_NOT_FOUND, "Actor has no movement resource.");

  const maximum = Math.max(Number(resource.max ?? resource.value ?? 0) || 0, 0);
  const current = Math.max(Number(resource.value ?? maximum) || 0, 0);
  const capability = createMovementCapability({
    mode: movementMode,
    distance: maximum,
    unit: grid?.units || "ft"
  });
  const derivation = deriveMovementBudget({
    capability,
    measurementMode,
    grid,
    source: {
      type: "actor",
      actorRef: actor.uuid ?? actor.id ?? null,
      resourceId: "movement"
    },
    movementModes: [movementMode]
  });
  if ( !derivation.ok ) return derivation;

  const budget = clonePlain(derivation.budget);
  if ( measurementMode === MOVEMENT_MEASUREMENT_MODES.FIELDS ) {
    const fields = Math.floor(current / Number(grid?.distance ?? 1));
    budget.current = Math.min(fields, budget.maximum);
    budget.metadata.actorResourceCurrent = current;
    budget.metadata.actorResourceMax = maximum;
    budget.metadata.actorResourceUnit = grid?.units || "ft";
  } else {
    budget.current = Math.min(current, budget.maximum);
    budget.metadata.actorResourceCurrent = current;
    budget.metadata.actorResourceMax = maximum;
    budget.metadata.actorResourceUnit = grid?.units || "ft";
  }

  return {
    ok: true,
    code: FOUNDRY_MOVEMENT_CODES.OK,
    budget
  };
}

function foundryMovementWaypoints(movement, {allowDestinationFallback=true}={}) {
  const waypoints = [
    ...sectionWaypoints(movement?.passed),
    ...sectionWaypoints(movement?.pending)
  ];
  if ( !waypoints.length ) waypoints.push(...normalizeArray(movement?.waypoints ?? movement?.path));
  // An endpoint can describe a proposal, but cannot substitute for an observed completed route.
  if ( allowDestinationFallback && !waypoints.length && movement?.destination ) waypoints.push(movement.destination);
  return normalizeMovementWaypoints(waypoints);
}

function movementChain(movement) {
  const chain = movement?.chain === undefined ? [] : movement.chain;
  return Array.isArray(chain) && chain.every(id => typeof id === "string" && id.length > 0)
    ? [...chain] : null;
}

function sectionWaypoints(section) {
  if ( !section ) return [];
  if ( Array.isArray(section.waypoints) ) return section.waypoints;
  if ( Array.isArray(section.path) ) return section.path;
  return [];
}

function normalizeMovementWaypoints(value) {
  return normalizeArray(value)
    .map((waypoint, index) => plainMovementWaypoint(waypoint, index))
    .filter(Boolean);
}

function plainMovementWaypoint(value, index=0) {
  const state = plainTokenMovementState(value);
  if ( !state ) return null;
  const action = stringOrNull(value?.action);
  const cost = finiteNumber(value?.cost);
  return {
    ...state,
    index,
    ...(action ? {action} : {}),
    ...(typeof value?.explicit === "boolean" ? {explicit: value.explicit} : {}),
    ...(typeof value?.intermediate === "boolean" ? {intermediate: value.intermediate} : {}),
    ...(typeof value?.snapped === "boolean" ? {snapped: value.snapped} : {}),
    ...(typeof value?.checkpoint === "boolean" ? {checkpoint: value.checkpoint} : {}),
    ...(Object.hasOwn(value, "movementId") ? {movementId: stringOrNull(value.movementId)} : {}),
    ...(value?.subpathId ? {subpathId: String(value.subpathId)} : {}),
    ...(value?.userId ? {userId: String(value.userId)} : {}),
    ...(typeof value?.teleport === "boolean" ? {teleport: value.teleport} : {}),
    ...(cost != null ? {cost} : {})
  };
}

function plainTokenMovementState(value) {
  if ( !value || typeof value !== "object" ) return null;
  const x = finiteNumber(value.x ?? value.position?.x);
  const y = finiteNumber(value.y ?? value.position?.y);
  if ( x == null || y == null ) return null;
  const elevation = finiteNumber(value.elevation ?? value.z ?? value.position?.elevation);
  const width = finiteNumber(value.width ?? value.position?.width);
  const height = finiteNumber(value.height ?? value.position?.height);
  const depth = finiteNumber(value.depth ?? value.position?.depth);
  const shape = finiteNumber(value.shape ?? value.position?.shape);
  return {
    x,
    y,
    ...(elevation != null ? {elevation} : {}),
    ...(width != null ? {width} : {}),
    ...(height != null ? {height} : {}),
    ...(depth != null ? {depth} : {}),
    ...(shape != null ? {shape} : {})
  };
}

function plainTokenFootprintPosition(value) {
  return plainTokenMovementState(value);
}

function tokenPositionState(token) {
  const x = finiteNumber(token?.x ?? token?._source?.x ?? token?.object?.x);
  const y = finiteNumber(token?.y ?? token?._source?.y ?? token?.object?.y);
  if ( x == null || y == null ) return null;
  const elevation = finiteNumber(token?.elevation ?? token?._source?.elevation ?? token?.object?.elevation);
  const width = finiteNumber(token?.width ?? token?._source?.width ?? token?.object?.width);
  const height = finiteNumber(token?.height ?? token?._source?.height ?? token?.object?.height);
  const depth = finiteNumber(token?.depth ?? token?._source?.depth ?? token?.object?.depth);
  const shape = finiteNumber(token?.shape ?? token?._source?.shape ?? token?.object?.shape);
  return {
    x,
    y,
    ...(elevation != null ? {elevation} : {}),
    ...(width != null ? {width} : {}),
    ...(height != null ? {height} : {}),
    ...(depth != null ? {depth} : {}),
    ...(shape != null ? {shape} : {})
  };
}

function mergeTokenMovementState(base=null, override=null) {
  const normalizedBase = plainTokenMovementState(base);
  const normalizedOverride = plainTokenMovementState(override);
  if ( !normalizedBase ) return normalizedOverride;
  if ( !normalizedOverride ) return normalizedBase;
  return clonePlain({
    ...normalizedBase,
    ...normalizedOverride
  });
}

/** @param {{movement?: object|null, operation?: object, origin?: object|null, destination?: object|null, waypoints?: readonly object[]|null}} [options] */
export function classifyFoundryTokenOperation({
  movement=null,
  operation={},
  origin=null,
  destination=null,
  waypoints=null
}={}) {
  const normalizedOrigin = plainTokenMovementState(origin ?? movement?.origin);
  const normalizedDestination = plainTokenMovementState(destination ?? movement?.destination);
  const normalizedWaypoints = Array.isArray(waypoints) ? waypoints : foundryMovementWaypoints(movement);
  const metrics = foundryMovementMetrics(movement);
  const actions = normalizedWaypoints
    .map(waypoint => stringOrNull(waypoint?.action))
    .filter(Boolean);
  const hasFootprintChange = movementFootprintChanges({
    origin: normalizedOrigin,
    destination: normalizedDestination,
    waypoints: normalizedWaypoints
  });
  const hasPositiveMetrics = metrics.cost > 0 || metrics.distance > 0 || metrics.spaces > 0;
  const hasMovementAction = actions.some(action => action !== "displace");
  const hasPositionChange = movementPositionChanges({
    origin: normalizedOrigin,
    destination: normalizedDestination,
    waypoints: normalizedWaypoints
  });
  const ignoreCost = movement?.constrainOptions?.ignoreCost === true
    || operation?.constrainOptions?.ignoreCost === true
    || operation?.movement?.constrainOptions?.ignoreCost === true;
  const displaceOnly = actions.length > 0 && actions.every(action => action === "displace");
  const pureResizeEvidence = hasFootprintChange
    && !hasPositiveMetrics
    && !hasMovementAction
    && (ignoreCost || displaceOnly);

  let type = FOUNDRY_TOKEN_OPERATION_TYPES.TRANSLATION;
  if ( hasFootprintChange && pureResizeEvidence ) type = FOUNDRY_TOKEN_OPERATION_TYPES.RESIZE;
  else if ( hasFootprintChange ) type = FOUNDRY_TOKEN_OPERATION_TYPES.TRANSLATION_RESIZE;

  return clonePlain({
    type,
    hasFootprintChange,
    hasTranslation: type === FOUNDRY_TOKEN_OPERATION_TYPES.TRANSLATION
      || type === FOUNDRY_TOKEN_OPERATION_TYPES.TRANSLATION_RESIZE,
    hasPositionChange,
    metrics,
    ignoreCost,
    waypointActions: actions,
    method: stringOrNull(movement?.method ?? operation?.movement?.method ?? operation?.method)
  });
}

function foundryMovementMetrics(movement=null) {
  return {
    cost: sectionMetricTotal(movement, "cost"),
    distance: sectionMetricTotal(movement, "distance"),
    spaces: sectionMetricTotal(movement, "spaces")
  };
}

function sectionMetricTotal(movement=null, key) {
  return [
    movement?.[key],
    movement?.passed?.[key],
    movement?.pending?.[key]
  ].reduce((total, value) => total + Math.max(finiteNumber(value) ?? 0, 0), 0);
}

function movementFootprintChanges({origin=null, destination=null, waypoints=[]}={}) {
  const baseline = plainTokenMovementState(origin);
  if ( !baseline ) return false;
  return [destination, ...waypoints]
    .map(plainTokenMovementState)
    .filter(Boolean)
    .some(state => !sameFootprintDimensions(baseline, state));
}

function movementPositionChanges({origin=null, destination=null, waypoints=[]}={}) {
  const baseline = plainTokenMovementState(origin);
  if ( !baseline ) return false;
  return [destination, ...waypoints]
    .map(plainTokenMovementState)
    .filter(Boolean)
    .some(state => !samePoint(state, baseline));
}

function sameFootprintDimensions(left=null, right=null) {
  const leftState = plainTokenMovementState(left);
  const rightState = plainTokenMovementState(right);
  for ( const key of ["width", "height", "depth", "shape"] ) {
    if ( leftState?.[key] == null || rightState?.[key] == null ) continue;
    if ( Number(leftState?.[key]) !== Number(rightState?.[key]) ) return false;
  }
  return true;
}

function plainSceneRef(scene) {
  const id = stringOrNull(scene?.id ?? scene?._id);
  return normalizeEntityRef({
    id,
    uuid: stringOrNull(scene?.uuid),
    ref: stringOrNull(scene?.uuid) ?? (id ? `Scene.${id}` : null),
    documentName: "Scene"
  });
}

function plainTokenRef(token, scene=null) {
  const id = stringOrNull(token?.id ?? token?._id);
  const sceneId = stringOrNull(scene?.id ?? scene?._id ?? token?.parent?.id ?? token?.parent?._id);
  return normalizeEntityRef({
    id,
    uuid: stringOrNull(token?.uuid),
    ref: stringOrNull(token?.uuid) ?? (sceneId && id ? `Scene.${sceneId}.Token.${id}` : id),
    sceneId,
    documentName: "Token"
  });
}

function plainActorRef(actor, token=null) {
  const id = stringOrNull(actor?.id ?? actor?._id ?? token?.actorId);
  return normalizeEntityRef({
    id,
    uuid: stringOrNull(actor?.uuid),
    ref: stringOrNull(actor?.uuid) ?? (id ? `Actor.${id}` : null),
    documentName: "Actor",
    synthetic: actor?.isToken === true || actor?.parent === token
  });
}

function normalizeEntityRef(value) {
  if ( value == null ) return null;
  if ( typeof value === "string" ) {
    const id = value.replace(/^(Scene|Token|Actor)[.]/, "").split(".").at(-1);
    return {
      id: stringOrNull(id),
      ref: value,
      uuid: value.includes(".") ? value : null
    };
  }
  const id = stringOrNull(value.id ?? value._id);
  const uuid = stringOrNull(value.uuid);
  const ref = stringOrNull(value.ref ?? value.documentRef ?? value.tokenRef ?? value.actorRef ?? value.sceneRef ?? uuid ?? id);
  return clonePlain({
    ...value,
    id,
    uuid,
    ref
  });
}

async function resolveSceneRef(ref, {game=globalThis.game}={}) {
  const data = normalizeEntityRef(ref);
  if ( !data ) return null;
  const candidates = uniqueStrings([data.id, data.ref, data.uuid].flatMap(expandSceneRef));
  for ( const candidate of candidates ) {
    const scene = game?.scenes?.get?.(candidate)
      ?? collectionContents(game?.scenes).find(entry => entry?.id === candidate || entry?.uuid === candidate);
    if ( scene ) return scene;
  }
  const uuid = stringOrNull(data.uuid ?? data.ref);
  if ( uuid && typeof globalThis.fromUuid === "function" && /^Scene[.]/.test(uuid) ) {
    return await globalThis.fromUuid(uuid);
  }
  return null;
}

function resolveTokenRef(ref, {scene=null}={}) {
  const data = normalizeEntityRef(ref);
  if ( !data || !scene ) return null;
  const candidates = uniqueStrings([data.id, data.ref, data.uuid].flatMap(expandTokenRef));
  for ( const candidate of candidates ) {
    const token = scene.tokens?.get?.(candidate)
      ?? collectionContents(scene.tokens).find(entry => entry?.id === candidate || entry?.uuid === candidate);
    if ( token ) return resolveTokenDocument(token);
  }
  return null;
}

function entityRefMatchesDocument(ref, document, expandRef) {
  const data = normalizeEntityRef(ref);
  if ( !data || !document ) return false;
  const expected = uniqueStrings([data.id, data.ref, data.uuid].flatMap(expandRef));
  const actual = uniqueStrings([document.id, document._id, document.uuid].flatMap(expandRef));
  return expected.some(value => actual.includes(value));
}

function expandSceneRef(value) {
  const ref = stringOrNull(value);
  if ( !ref ) return [];
  return [ref, ref.replace(/^Scene[.]/, "")];
}

function expandTokenRef(value) {
  const ref = stringOrNull(value);
  if ( !ref ) return [];
  return [ref, ref.replace(/^Token[.]/, ""), ref.split(".").at(-1)];
}

function resolveTokenDocument(token) {
  return token?.document ?? token ?? null;
}

function movementKindFromFoundryOperation({movement=null, operation={}}={}) {
  return normalizeMovementKind(
    operation?.wildpath?.movementKind
    ?? movement?.wildpath?.movementKind
    ?? movement?.metadata?.wildpath?.movementKind
    ?? operation?.movementKind
    ?? movement?.movementKind
  );
}

function movementModeFromFoundryOperation({movement=null, operation={}}={}) {
  return stringOrNull(
    operation?.wildpath?.movementMode
    ?? movement?.wildpath?.movementMode
    ?? movement?.metadata?.wildpath?.movementMode
    ?? operation?.movementMode
    ?? movement?.movementMode
  ) ?? "walk";
}

function normalizeMovementKind(kind) {
  const normalized = String(kind ?? MOVEMENT_KINDS.VOLUNTARY).toLowerCase();
  return Object.values(MOVEMENT_KINDS).includes(normalized) ? normalized : MOVEMENT_KINDS.VOLUNTARY;
}

function resolveMovementMeasurementMode({game=globalThis.game, measurementMode=null}={}) {
  const configured = measurementMode
    ?? game?.settings?.get?.("wildpath", "movementMeasurementMode")
    ?? WILDPATH.DEFAULT_MOVEMENT_MEASUREMENT_MODE;
  return Object.values(MOVEMENT_MEASUREMENT_MODES).includes(configured)
    ? configured
    : MOVEMENT_MEASUREMENT_MODES.DISTANCE;
}

function prependPointIfDifferent(origin, waypoints) {
  const normalizedOrigin = plainTokenMovementState(origin);
  const normalizedWaypoints = normalizeMovementWaypoints(waypoints);
  if ( !normalizedOrigin ) return normalizedWaypoints;
  const first = normalizedWaypoints[0] ?? null;
  if ( first && samePoint(first, normalizedOrigin) ) return normalizedWaypoints;
  return [normalizedOrigin, ...normalizedWaypoints];
}

function dedupeAnchors(anchors, topology) {
  const values = [];
  for ( const anchor of anchors ) {
    if ( !anchor ) continue;
    const last = values.at(-1);
    if ( last && fieldKey(last, topology) === fieldKey(anchor, topology) ) continue;
    values.push(clonePlain(anchor));
  }
  return values;
}

function samePoint(left, right) {
  return Number(left?.x) === Number(right?.x)
    && Number(left?.y) === Number(right?.y)
    && Number(left?.elevation ?? 0) === Number(right?.elevation ?? 0);
}

function movementApproval(approved, {
  code=FOUNDRY_MOVEMENT_CODES.OK,
  reason=null,
  intent=null,
  path=null,
  evaluation=null,
  signature=null,
  payment=null,
  footprintTransition=null,
  foundryOperation=null,
  diagnostics=null,
  foundryOriginState=null
}={}) {
  const sanitizedIntent = intent ? sanitizeMovementIntent(intent) : null;
  const payload = {
    ok: true,
    approved: approved === true,
    code,
    reason,
    ...(diagnostics ? {diagnostics: clonePlain(diagnostics)} : {}),
    movementId: sanitizedIntent?.movementId ?? null,
    resolutionId: sanitizedIntent?.resolutionId ?? null,
    sceneRef: sanitizedIntent?.sceneRef ?? null,
    tokenRef: sanitizedIntent?.tokenRef ?? null,
    actorRef: sanitizedIntent?.actorRef ?? null,
    sourceUserId: sanitizedIntent?.sourceUserId ?? null,
    intentSignature: signature ?? (path ? movementPathSignature({intent: sanitizedIntent, path}) : null),
    path: path ? clonePlain(path) : null,
    footprintTransition: footprintTransition ? clonePlain(footprintTransition) : null,
    evaluation: evaluation ? summarizeMovementEvaluation(evaluation) : null,
    payment: payment ? clonePlain(payment) : null,
    foundryOperation: foundryOperation ? clonePlain(foundryOperation) : null,
    foundryOriginState: foundryOriginState ? clonePlain(foundryOriginState) : null
  };
  return clonePlain(payload);
}

function summarizeMovementEvaluation(evaluation) {
  return clonePlain({
    ok: evaluation.ok,
    code: evaluation.code,
    valid: evaluation.valid,
    path: evaluation.path,
    footprints: evaluation.footprints,
    transitions: evaluation.transitions,
    routeCost: evaluation.routeCost,
    cost: evaluation.cost,
    budget: evaluation.budget,
    spend: evaluation.spend,
    affordable: evaluation.affordable,
    failures: evaluation.failures,
    trace: evaluation.trace,
    grid: evaluation.grid
  });
}

function movementRejectionCode(evaluation) {
  if ( evaluation.affordable === false ) return FOUNDRY_MOVEMENT_CODES.MOVEMENT_UNAFFORDABLE;
  return evaluation.failures?.[0]?.code ?? evaluation.cost?.code ?? FOUNDRY_MOVEMENT_CODES.MOVEMENT_REJECTED;
}

function movementRejectionReason(evaluation) {
  if ( evaluation.affordable === false ) return evaluation.spend?.reason ?? "Movement exceeds the available movement budget.";
  return evaluation.failures?.[0]?.reason ?? evaluation.cost?.reason ?? "Movement is not legal for the current WildPath route.";
}

function gridFailure(result) {
  return failure(
    result?.code === FOUNDRY_TACTICAL_GRID_CODES.GRIDLESS_UNSUPPORTED
      ? result.code
      : FOUNDRY_MOVEMENT_CODES.GRID_ADAPTER_FAILED,
    result?.reason ?? "Foundry TacticalGrid adapter could not translate movement.",
    {adapterCode: result?.code ?? null}
  );
}

function failure(code, reason=null, data={}) {
  return {
    ok: false,
    code,
    reason,
    ...clonePlain(data)
  };
}

function collectionContents(collection) {
  if ( collection == null ) return [];
  if ( Array.isArray(collection) ) return collection;
  if ( collection instanceof Map ) return [...collection.values()];
  if ( typeof collection.values === "function" ) return [...collection.values()];
  if ( typeof collection === "object" ) return Object.values(collection);
  return [];
}

function normalizeArray(value) {
  if ( value == null ) return [];
  return Array.isArray(value) ? value : [value];
}

function uniqueStrings(values) {
  return [...new Set(normalizeArray(values).filter(value => value != null && value !== "").map(String))];
}

function finiteNumber(value) {
  if ( value == null || value === "" ) return null;
  if ( typeof value === "object" || typeof value === "function" || typeof value === "boolean" ) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteInteger(value) {
  const number = finiteNumber(value);
  return number == null ? null : Math.floor(number);
}

function stringOrNull(value) {
  if ( value == null ) return null;
  const string = String(value).trim();
  return string ? string : null;
}

function stableStringify(value) {
  return JSON.stringify(sortPlain(value));
}

function sortPlain(value) {
  if ( value == null || typeof value !== "object" ) return value;
  if ( Array.isArray(value) ) return value.map(sortPlain);
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, sortPlain(value[key])])
  );
}

function clonePlain(value) {
  if ( value === undefined ) return undefined;
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
