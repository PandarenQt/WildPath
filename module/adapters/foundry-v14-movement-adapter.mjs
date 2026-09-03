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
import {fieldKey} from "../helpers/grid-footprints.mjs";
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
  GRID_ADAPTER_FAILED: "GRID_ADAPTER_FAILED",
  NON_SERIALIZABLE_MOVEMENT: MULTIPLAYER_AUTHORITY_CODES.NON_SERIALIZABLE_MESSAGE
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
  const waypoints = foundryMovementWaypoints(movement);
  const origin = plainMovementPoint(movement?.origin) ?? tokenPositionPoint(token);
  const destination = plainMovementPoint(movement?.destination) ?? waypoints.at(-1) ?? origin;

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
      subpathId: stringOrNull(movement?.subpathId ?? operation?.subpathId),
      chain: movement?.chain === true || operation?.chain === true,
      constrained: movement?.constrained === true || operation?.constrained === true,
      waypointCount: waypoints.length,
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
  foundryLifecycle="moveToken"
}={}) {
  const token = resolveTokenDocument(tokenDocument);
  if ( !token ) return failure(FOUNDRY_MOVEMENT_CODES.TOKEN_NOT_FOUND, "A TokenDocument is required to build a movement completion.");

  const movementId = stringOrNull(movement?.id ?? movement?.movementId ?? operation?.movementId ?? operation?.id);
  if ( !movementId ) return failure(FOUNDRY_MOVEMENT_CODES.MISSING_MOVEMENT_ID, "Foundry movement completions require a stable movement id.");

  const sourceUserId = stringOrNull(user?.id ?? operation?.userId ?? game?.user?.id ?? game?.userId);
  const scene = token.parent ?? game?.canvas?.scene ?? game?.scenes?.viewed ?? null;
  const actor = token.actor ?? null;
  const waypoints = foundryMovementWaypoints(movement);
  const destination = plainMovementPoint(movement?.destination) ?? tokenPositionPoint(token) ?? waypoints.at(-1) ?? null;

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
      subpathId: stringOrNull(movement?.subpathId ?? operation?.subpathId),
      chain: movement?.chain === true || operation?.chain === true,
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
  return {ok: true, code: FOUNDRY_MOVEMENT_CODES.OK, completion};
}

/* -------------------------------------------- */

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
    origin: plainMovementPoint(data.origin),
    destination: plainMovementPoint(data.destination),
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
    destination: plainMovementPoint(data.destination),
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
  if ( !actor && sanitized.movementKind === MOVEMENT_KINDS.VOLUNTARY ) {
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

  const footprintResult = adapter.tokenToFootprint(token);
  if ( !footprintResult.ok || !footprintResult.footprint ) return gridFailure(footprintResult);

  const originCheck = validateIntentOrigin({
    intent: sanitized,
    adapter,
    tokenAnchor: footprintResult.anchor,
    topology: footprintResult.topology
  });
  if ( !originCheck.ok ) return originCheck;

  const complete = getCompleteFoundryMovementWaypoints({
    intent: sanitized,
    tokenDocument: token
  });
  if ( !complete.ok ) return complete;

  const converted = complete.waypoints.map((waypoint, index) => {
    const result = adapter.pointToField(waypoint);
    if ( !result.ok ) return {
      ok: false,
      index,
      code: result.code,
      reason: result.reason,
      waypoint
    };
    return {ok: true, index, field: result.field};
  });
  const failed = converted.find(entry => !entry.ok);
  if ( failed ) return failure(
    FOUNDRY_MOVEMENT_CODES.GRID_ADAPTER_FAILED,
    failed.reason ?? "A Foundry movement waypoint could not be converted to a WildPath GridField.",
    {code: failed.code, waypointIndex: failed.index}
  );

  const anchors = dedupeAnchors(
    [footprintResult.anchor, ...converted.map(entry => entry.field)],
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

  const translated = foundryMovementIntentToMovementPath({
    intent: documents.intent,
    tokenDocument: documents.token,
    scene: documents.scene
  });
  if ( !translated.ok ) return movementApproval(false, {
    code: translated.code,
    reason: translated.reason,
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
    payment: movementPaymentFromEvaluation(evaluation)
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
  if ( !actor ) return failure(FOUNDRY_MOVEMENT_CODES.ACTOR_NOT_FOUND, "MovementCompletion Token Actor could not be resolved.");
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
  if ( !actor ) return failure(FOUNDRY_MOVEMENT_CODES.ACTOR_NOT_FOUND, "Observed moveToken Actor could not be resolved.");
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
  const footprint = adapter.tokenToFootprint(token, {position});
  if ( !footprint.ok || !footprint.footprint ) return gridFailure(footprint);
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
  const path = approval.path ?? approval.evaluation?.path ?? null;
  return path?.anchors?.length ? path.anchors[path.anchors.length - 1] : null;
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

function getCompleteFoundryMovementWaypoints({intent={}, tokenDocument=null}={}) {
  const token = resolveTokenDocument(tokenDocument);
  if ( typeof token?.getCompleteMovementPath !== "function" ) {
    return failure(
      FOUNDRY_MOVEMENT_CODES.COMPLETE_PATH_UNAVAILABLE,
      "TokenDocument#getCompleteMovementPath is required for Foundry movement translation."
    );
  }

  const requested = normalizeMovementWaypoints(
    intent.waypoints?.length ? intent.waypoints : (intent.destination ? [intent.destination] : [])
  );
  const origin = tokenPositionPoint(token) ?? intent.origin;
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

function validateIntentOrigin({intent={}, adapter=null, tokenAnchor=null, topology=null}={}) {
  if ( !intent.origin ) return failure(
    FOUNDRY_MOVEMENT_CODES.ORIGIN_MISMATCH,
    "MovementIntent must include the client-observed origin so authority can detect stale proposals."
  );
  const originField = adapter.pointToField(intent.origin);
  if ( !originField.ok ) return failure(
    FOUNDRY_MOVEMENT_CODES.ORIGIN_MISMATCH,
    originField.reason ?? "MovementIntent origin could not be converted to a GridField.",
    {code: originField.code}
  );
  if ( fieldKey(originField.field, topology) !== fieldKey(tokenAnchor, topology) ) return failure(
    FOUNDRY_MOVEMENT_CODES.ORIGIN_MISMATCH,
    "MovementIntent origin does not match the authoritative Token origin.",
    {
      intentOrigin: originField.field,
      authoritativeOrigin: tokenAnchor
    }
  );
  return {ok: true, code: FOUNDRY_MOVEMENT_CODES.OK};
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

function foundryMovementWaypoints(movement) {
  const waypoints = [
    ...sectionWaypoints(movement?.passed),
    ...sectionWaypoints(movement?.pending)
  ];
  if ( !waypoints.length ) waypoints.push(...normalizeArray(movement?.waypoints ?? movement?.path));
  if ( !waypoints.length && movement?.destination ) waypoints.push(movement.destination);
  return normalizeMovementWaypoints(waypoints);
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
  const point = plainMovementPoint(value);
  if ( !point ) return null;
  const action = stringOrNull(value?.action);
  return {
    ...point,
    index,
    ...(action ? {action} : {})
  };
}

function plainMovementPoint(value) {
  if ( !value || typeof value !== "object" ) return null;
  const x = finiteNumber(value.x ?? value.position?.x);
  const y = finiteNumber(value.y ?? value.position?.y);
  if ( x == null || y == null ) return null;
  const elevation = finiteNumber(value.elevation ?? value.z ?? value.position?.elevation);
  return {
    x,
    y,
    ...(elevation != null ? {elevation} : {})
  };
}

function plainTokenFootprintPosition(value) {
  if ( !value || typeof value !== "object" ) return null;
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  if ( x == null || y == null ) return null;
  const elevation = finiteNumber(value.elevation ?? value.z);
  const width = finiteNumber(value.width);
  const height = finiteNumber(value.height);
  const depth = finiteNumber(value.depth);
  return {
    x,
    y,
    ...(elevation != null ? {elevation} : {}),
    ...(width != null ? {width} : {}),
    ...(height != null ? {height} : {}),
    ...(depth != null ? {depth} : {})
  };
}

function tokenPositionPoint(token) {
  const x = finiteNumber(token?.x ?? token?._source?.x ?? token?.object?.x);
  const y = finiteNumber(token?.y ?? token?._source?.y ?? token?.object?.y);
  if ( x == null || y == null ) return null;
  const elevation = finiteNumber(token?.elevation ?? token?._source?.elevation ?? token?.object?.elevation);
  return {
    x,
    y,
    ...(elevation != null ? {elevation} : {})
  };
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
  const normalizedOrigin = plainMovementPoint(origin);
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
  payment=null
}={}) {
  const sanitizedIntent = intent ? sanitizeMovementIntent(intent) : null;
  const payload = {
    ok: true,
    approved: approved === true,
    code,
    reason,
    movementId: sanitizedIntent?.movementId ?? null,
    resolutionId: sanitizedIntent?.resolutionId ?? null,
    sceneRef: sanitizedIntent?.sceneRef ?? null,
    tokenRef: sanitizedIntent?.tokenRef ?? null,
    actorRef: sanitizedIntent?.actorRef ?? null,
    sourceUserId: sanitizedIntent?.sourceUserId ?? null,
    intentSignature: signature ?? (path ? movementPathSignature({intent: sanitizedIntent, path}) : null),
    path: path ? clonePlain(path) : null,
    evaluation: evaluation ? summarizeMovementEvaluation(evaluation) : null,
    payment: payment ? clonePlain(payment) : null
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
