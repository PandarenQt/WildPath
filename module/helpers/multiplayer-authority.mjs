import {RESOLUTION_REQUEST_TYPES} from "./resolution-state.mjs";
import {ROLL_AUTHORITY} from "./rolls.mjs";

export const MULTIPLAYER_PROTOCOL_VERSION = 1;

export const MULTIPLAYER_MESSAGE_TYPES = Object.freeze({
  ACTION_INTENT: "ACTION_INTENT",
  MOVEMENT_INTENT: "MOVEMENT_INTENT",
  MOVEMENT_APPROVAL: "MOVEMENT_APPROVAL",
  MOVEMENT_COMMIT: "MOVEMENT_COMMIT",
  MOVEMENT_RESULT: "MOVEMENT_RESULT",
  PENDING_REQUEST: "PENDING_REQUEST",
  REQUEST_RESPONSE: "REQUEST_RESPONSE",
  RESOLUTION_CANCEL: "RESOLUTION_CANCEL",
  RESOLUTION_RESULT: "RESOLUTION_RESULT",
  RESOLUTION_ERROR: "RESOLUTION_ERROR"
});

export const MULTIPLAYER_AUTHORITY_CODES = Object.freeze({
  OK: "OK",
  WAITING: "WAITING",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  AUTHORITY_UNAVAILABLE: "AUTHORITY_UNAVAILABLE",
  REQUEST_AUTHORITY_UNAVAILABLE: "REQUEST_AUTHORITY_UNAVAILABLE",
  REQUEST_ROUTED: "REQUEST_ROUTED",
  WRONG_USER: "WRONG_USER",
  WRONG_AUTHORITY: "WRONG_AUTHORITY",
  REQUEST_MISMATCH: "REQUEST_MISMATCH",
  REQUEST_NOT_PENDING: "REQUEST_NOT_PENDING",
  RESOLUTION_NOT_FOUND: "RESOLUTION_NOT_FOUND",
  DUPLICATE_ACTION_INTENT: "DUPLICATE_ACTION_INTENT",
  DUPLICATE_REQUEST_RESPONSE: "DUPLICATE_REQUEST_RESPONSE",
  UNSUPPORTED_PROTOCOL: "UNSUPPORTED_PROTOCOL",
  UNKNOWN_MESSAGE_TYPE: "UNKNOWN_MESSAGE_TYPE",
  INVALID_ENVELOPE: "INVALID_ENVELOPE",
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  NON_SERIALIZABLE_MESSAGE: "NON_SERIALIZABLE_MESSAGE",
  TRANSPORT_UNAVAILABLE: "TRANSPORT_UNAVAILABLE",
  TRANSPORT_SEND_FAILED: "TRANSPORT_SEND_FAILED",
  ACTION_INTENT_REJECTED: "ACTION_INTENT_REJECTED",
  ACTION_INTENT_RESOLUTION_FAILED: "ACTION_INTENT_RESOLUTION_FAILED",
  PROMPT_FAILED: "PROMPT_FAILED",
  ROLL_FAILED: "ROLL_FAILED"
});

export const REQUEST_AUTHORITY_POLICIES = Object.freeze({
  SOURCE_CONTROLLER: ROLL_AUTHORITY.SOURCE_CONTROLLER,
  TARGET_CONTROLLER: ROLL_AUTHORITY.TARGET_CONTROLLER,
  GM: ROLL_AUTHORITY.GM,
  AUTOMATIC: ROLL_AUTHORITY.AUTOMATIC,
  SPECIFIC: ROLL_AUTHORITY.SPECIFIC,
  LOCAL: "local"
});

let nextMessageSequence = 1;

/* -------------------------------------------- */

export function createResolutionSocketEnvelope(options={}) {
  const envelope = normalizeResolutionSocketEnvelope({
    protocolVersion: options.protocolVersion ?? MULTIPLAYER_PROTOCOL_VERSION,
    messageId: options.messageId ?? createMessageId(options.messageType ?? options.type),
    messageType: options.messageType ?? options.type,
    senderUserId: options.senderUserId ?? options.senderId,
    recipientUserId: options.recipientUserId ?? options.recipientId ?? null,
    recipientUserIds: options.recipientUserIds ?? [],
    recipientPolicy: options.recipientPolicy ?? null,
    resolutionId: options.resolutionId ?? options.payload?.resolutionId ?? null,
    requestId: options.requestId ?? options.payload?.requestId ?? options.payload?.request?.id ?? null,
    payload: options.payload ?? {},
    metadata: options.metadata ?? {}
  });
  const validation = validateResolutionSocketEnvelope(envelope);
  if ( !validation.ok ) {
    throw new TypeError(validation.reason ?? `Invalid resolution socket envelope: ${validation.code}`);
  }
  return validation.envelope;
}

/* -------------------------------------------- */

export function validateResolutionSocketEnvelope(value) {
  let envelope;
  try {
    envelope = normalizeResolutionSocketEnvelope(value);
  } catch (error) {
    return failure(
      MULTIPLAYER_AUTHORITY_CODES.NON_SERIALIZABLE_MESSAGE,
      error?.message ?? String(error)
    );
  }

  if ( envelope.protocolVersion !== MULTIPLAYER_PROTOCOL_VERSION ) {
    return failure(
      MULTIPLAYER_AUTHORITY_CODES.UNSUPPORTED_PROTOCOL,
      `Unsupported multiplayer protocol version: ${envelope.protocolVersion}.`,
      {envelope}
    );
  }
  if ( !Object.values(MULTIPLAYER_MESSAGE_TYPES).includes(envelope.messageType) ) {
    return failure(
      MULTIPLAYER_AUTHORITY_CODES.UNKNOWN_MESSAGE_TYPE,
      `Unknown multiplayer message type: ${envelope.messageType}.`,
      {envelope}
    );
  }
  if ( !envelope.messageId ) return failure(MULTIPLAYER_AUTHORITY_CODES.INVALID_ENVELOPE, "Socket envelope requires messageId.", {envelope});
  if ( !envelope.senderUserId ) return failure(MULTIPLAYER_AUTHORITY_CODES.INVALID_ENVELOPE, "Socket envelope requires senderUserId.", {envelope});
  if ( !envelope.resolutionId ) return failure(MULTIPLAYER_AUTHORITY_CODES.INVALID_ENVELOPE, "Socket envelope requires resolutionId.", {envelope});
  if ( [MULTIPLAYER_MESSAGE_TYPES.PENDING_REQUEST, MULTIPLAYER_MESSAGE_TYPES.REQUEST_RESPONSE].includes(envelope.messageType)
    && !envelope.requestId ) {
    return failure(MULTIPLAYER_AUTHORITY_CODES.INVALID_ENVELOPE, "Request messages require requestId.", {envelope});
  }
  return {
    ok: true,
    code: MULTIPLAYER_AUTHORITY_CODES.OK,
    reason: null,
    envelope
  };
}

/* -------------------------------------------- */

export function normalizeResolutionSocketEnvelope(raw={}) {
  const source = clonePlainData(raw, "envelope") ?? {};
  return {
    protocolVersion: finiteInteger(source.protocolVersion) ?? MULTIPLAYER_PROTOCOL_VERSION,
    messageId: stringOrNull(source.messageId ?? source.id),
    messageType: stringOrNull(source.messageType ?? source.type),
    senderUserId: stringOrNull(source.senderUserId ?? source.senderId),
    recipientUserId: stringOrNull(source.recipientUserId ?? source.recipientId),
    recipientUserIds: uniqueStrings(source.recipientUserIds ?? source.recipients),
    recipientPolicy: stringOrNull(source.recipientPolicy ?? source.recipientAuthority ?? source.recipient),
    resolutionId: stringOrNull(source.resolutionId),
    requestId: stringOrNull(source.requestId),
    payload: clonePlainData(source.payload ?? {}, "envelope.payload") ?? {},
    metadata: clonePlainData(source.metadata ?? {}, "envelope.metadata") ?? {}
  };
}

/* -------------------------------------------- */

export function recipientMatchesEnvelope(envelope, userId) {
  const current = stringOrNull(userId);
  if ( !current ) return false;
  const data = normalizeResolutionSocketEnvelope(envelope);
  if ( data.recipientUserId ) return refsMatch(data.recipientUserId, current);
  if ( data.recipientUserIds.length ) return data.recipientUserIds.some(ref => refsMatch(ref, current));
  if ( ["all", "broadcast"].includes(data.recipientPolicy) ) return true;
  return true;
}

/* -------------------------------------------- */

export function sanitizeActionIntentPayload(payload={}) {
  const intent = clonePlainData(payload.intent ?? payload, "actionIntent") ?? {};
  const sanitized = {...intent};
  delete sanitized.state;
  delete sanitized.resolutionState;
  delete sanitized.mutationPlans;
  delete sanitized.transaction;
  delete sanitized.rollResults;
  delete sanitized.results;
  delete sanitized.resolvedPreview;
  delete sanitized.paymentPlan;
  delete sanitized.damage;
  delete sanitized.healing;
  delete sanitized.effects;
  return sanitized;
}

/* -------------------------------------------- */

export function sanitizePendingRequestForTransport(request, {expectedChooserUserId=null, authority=null}={}) {
  const data = clonePlainData(request, "pendingRequest") ?? {};
  return {
    id: stringOrNull(data.id),
    resolutionId: stringOrNull(data.resolutionId),
    stageId: stringOrNull(data.stageId),
    type: stringOrNull(data.type),
    expectedResponseType: stringOrNull(data.expectedResponseType),
    chooser: clonePlainData(data.chooser ?? null, "pendingRequest.chooser"),
    authority: clonePlainData(data.authority ?? null, "pendingRequest.authority"),
    validation: clonePlainData(data.validation ?? {}, "pendingRequest.validation") ?? {},
    payload: clonePlainData(data.payload ?? {}, "pendingRequest.payload") ?? {},
    metadata: {
      ...(clonePlainData(data.metadata ?? {}, "pendingRequest.metadata") ?? {}),
      multiplayer: {
        expectedChooserUserId: stringOrNull(expectedChooserUserId),
        authority: clonePlainData(authority ?? null, "pendingRequest.metadata.multiplayer.authority")
      }
    }
  };
}

/* -------------------------------------------- */

export function sanitizeResolutionResultForTransport({state=null, result=null, authorityUserId=null, initiatorUserId=null}={}) {
  const current = clonePlainData(state ?? result?.state ?? {}, "resolutionResult.state") ?? {};
  const actionResult = current.results?.actionResult ?? null;
  const transaction = actionResult?.steps?.at?.(-1)?.data?.transaction
    ?? actionResult?.steps?.[actionResult.steps.length - 1]?.data?.transaction
    ?? null;
  return clonePlainData({
    resolutionId: current.id ?? result?.resolutionId ?? null,
    status: current.status ?? result?.status ?? null,
    code: result?.code ?? null,
    ok: result?.ok !== false,
    authorityUserId: stringOrNull(authorityUserId),
    initiatorUserId: stringOrNull(initiatorUserId),
    action: actionResult?.context?.action ?? actionRefFromState(current),
    source: current.source ?? actionResult?.context?.source ?? null,
    targets: current.targets ?? actionResult?.context?.targets ?? [],
    configuration: current.configuration ? {
      id: current.configuration.id ?? null,
      choices: current.configuration.choices ?? current.configuration.responses ?? null,
      selectedPaymentOptionId: current.configuration.selectedPaymentOptionId ?? null
    } : null,
    preview: current.results?.preview ?? null,
    rolls: (current.rollResults ?? []).map(entry => ({
      requestId: entry.requestId ?? entry.rollRequest?.id ?? null,
      type: entry.type ?? entry.semanticType ?? null,
      rollResult: entry.rollResult ?? null
    })),
    outcomes: {
      attack: current.results?.attackResolution ?? null,
      save: current.results?.saveResolution ?? null,
      damage: current.results?.damageResolution ?? null,
      healing: current.results?.healingResolution ?? null,
      effects: current.results?.effectResolution ?? null,
      payment: current.results?.paymentResolution?.paymentPlan ?? null
    },
    committedMutations: sanitizeCommittedMutations(transaction),
    trace: (current.trace ?? []).map(entry => ({
      stageId: entry.stageId ?? null,
      status: entry.status ?? null,
      result: entry.result ?? null,
      code: entry.code ?? null,
      requestIds: entry.requestIds ?? []
    }))
  }, "resolutionResult");
}

/* -------------------------------------------- */

export function normalizeAuthorityUsers(users, {activeGMUserId=null}={}) {
  const collectionActiveGMId = stringOrNull(users?.activeGM?.id ?? users?.activeGM?.userId);
  const entries = collectionContents(users)
    .map(normalizeAuthorityUser)
    .filter(user => user.id);
  const designatedGMId = stringOrNull(activeGMUserId)
    ?? collectionActiveGMId
    ?? entries.find(user => user.active && user.isGM && user.isActiveGM)?.id
    ?? entries.filter(user => user.active && user.isGM)
      .sort((a, b) => a.id.localeCompare(b.id))[0]?.id
    ?? null;
  return entries
    .map(user => ({
      ...user,
      isActiveGM: user.id === designatedGMId
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function activeGMUserIdFrom(users, explicit=null) {
  return normalizeAuthorityUsers(users, {activeGMUserId: explicit})
    .find(user => user.active && user.isGM && user.isActiveGM)?.id ?? null;
}

/* -------------------------------------------- */

export function selectResolutionAuthority({
  initiatorUserId=null,
  localUserId=null,
  users=[],
  activeGMUserId=null,
  allowLocalWithoutGM=false,
  canCommitLocally=false
}={}) {
  const initiator = stringOrNull(initiatorUserId);
  const local = stringOrNull(localUserId) ?? initiator;
  const directory = normalizeAuthorityUsers(users, {activeGMUserId});
  const activeGMId = activeGMUserIdFrom(directory, activeGMUserId);
  if ( activeGMId ) {
    return authoritySuccess({
      userId: activeGMId,
      mode: initiator === activeGMId ? "initiating-gm" : "active-gm",
      activeGMUserId: activeGMId
    });
  }
  if ( allowLocalWithoutGM && initiator && local && refsMatch(initiator, local) && canCommitLocally === true ) {
    return authoritySuccess({
      userId: initiator,
      mode: "local-no-active-gm",
      activeGMUserId: null
    });
  }
  return failure(
    MULTIPLAYER_AUTHORITY_CODES.AUTHORITY_UNAVAILABLE,
    "No active GM is available and local authority is not permitted.",
    {initiatorUserId: initiator, activeGMUserId: activeGMId}
  );
}

/* -------------------------------------------- */

export function resolveRequestChooser({
  request=null,
  users=[],
  initiatorUserId=null,
  authorityUserId=null,
  activeGMUserId=null,
  sourceControllerUserIds=[],
  targetControllerUserIds=[],
  allowGMFallback=true
}={}) {
  const directory = normalizeAuthorityUsers(users, {activeGMUserId});
  const activeGMId = activeGMUserIdFrom(directory, activeGMUserId);
  const policy = normalizeRequestAuthority(requestAuthorityFor(request));
  const kind = policy.kind ?? defaultRequestAuthorityKind(request);
  if ( kind === REQUEST_AUTHORITY_POLICIES.AUTOMATIC || kind === REQUEST_AUTHORITY_POLICIES.LOCAL ) {
    const authority = activeUserById(directory, authorityUserId) ?? activeUserById(directory, activeGMId);
    if ( authority ) return requestChooserSuccess(authority.id, {kind, policy});
    return failure(MULTIPLAYER_AUTHORITY_CODES.REQUEST_AUTHORITY_UNAVAILABLE, "Automatic request authority is unavailable.", {kind, policy});
  }
  if ( kind === REQUEST_AUTHORITY_POLICIES.GM ) {
    const gm = activeUserById(directory, activeGMId) ?? firstActiveGM(directory);
    if ( gm ) return requestChooserSuccess(gm.id, {kind, policy});
    return failure(MULTIPLAYER_AUTHORITY_CODES.REQUEST_AUTHORITY_UNAVAILABLE, "GM request authority is unavailable.", {kind, policy});
  }
  if ( kind === REQUEST_AUTHORITY_POLICIES.SPECIFIC ) {
    const candidates = uniqueStrings([
      policy.userId,
      policy.userRef,
      policy.id,
      ...(policy.userIds ?? []),
      ...(policy.userRefs ?? [])
    ]);
    const user = selectActiveUser(directory, candidates);
    if ( user ) return requestChooserSuccess(user.id, {kind, policy});
    return failure(MULTIPLAYER_AUTHORITY_CODES.REQUEST_AUTHORITY_UNAVAILABLE, "Specific request authority is unavailable.", {kind, policy});
  }
  if ( kind === REQUEST_AUTHORITY_POLICIES.TARGET_CONTROLLER ) {
    return resolveControllerChooser({
      kind,
      policy,
      directory,
      controllerUserIds: targetControllerUserIds,
      activeGMId,
      allowGMFallback,
      unavailableReason: "Target controller is unavailable."
    });
  }
  return resolveControllerChooser({
    kind: REQUEST_AUTHORITY_POLICIES.SOURCE_CONTROLLER,
    policy,
    directory,
    controllerUserIds: uniqueStrings([...normalizeArray(sourceControllerUserIds), initiatorUserId]),
    activeGMId,
    allowGMFallback,
    unavailableReason: "Source controller is unavailable."
  });
}

/* -------------------------------------------- */

export function commitAuthorityForUser({userId=null, users=[], activeGMUserId=null, canCommit=false}={}) {
  const id = stringOrNull(userId);
  const directory = normalizeAuthorityUsers(users, {activeGMUserId});
  const user = activeUserById(directory, id);
  const activeGMId = activeGMUserIdFrom(directory, activeGMUserId);
  const activeGMCommit = !!activeGMId && id === activeGMId && user?.isGM === true;
  const localCommit = canCommit === true && !!id;
  return {
    isGM: user?.isGM === true,
    canCommit: activeGMCommit || localCommit,
    userId: id,
    activeUserId: activeGMId ?? (localCommit ? id : null),
    activeGMId
  };
}

/* -------------------------------------------- */

export function createBoundedIdCache({limit=200}={}) {
  const entries = new Map();
  const max = Math.max(finiteInteger(limit) ?? 200, 1);
  return {
    has(id) {
      return entries.has(String(id));
    },
    add(id, value=true) {
      const key = String(id);
      if ( entries.has(key) ) entries.delete(key);
      entries.set(key, value);
      while ( entries.size > max ) entries.delete(entries.keys().next().value);
      return value;
    },
    get(id) {
      return entries.get(String(id));
    },
    get size() {
      return entries.size;
    }
  };
}

/* -------------------------------------------- */

export function clonePlainData(value, path="value") {
  const issue = firstNonPlainData(value, path, new WeakSet());
  if ( issue ) throw new TypeError(issue.reason);
  return clonePlainDataUnchecked(value);
}

export function isPlainSerializableData(value) {
  return firstNonPlainData(value, "value", new WeakSet()) == null;
}

/* -------------------------------------------- */

function requestAuthorityFor(request) {
  return request?.authority
    ?? request?.chooser
    ?? request?.payload?.rollRequest?.authority
    ?? request?.payload?.rollRequest?.chooser
    ?? null;
}

function defaultRequestAuthorityKind(request) {
  if ( request?.type === RESOLUTION_REQUEST_TYPES.ROLL && request?.payload?.rollKind === "save" ) {
    return REQUEST_AUTHORITY_POLICIES.TARGET_CONTROLLER;
  }
  return REQUEST_AUTHORITY_POLICIES.SOURCE_CONTROLLER;
}

function normalizeRequestAuthority(value) {
  if ( typeof value === "string" ) return {kind: value};
  const data = value && typeof value === "object" ? value : {};
  return {
    ...clonePlainData(data, "authority"),
    kind: stringOrNull(data.kind ?? data.type ?? data.role)
  };
}

function resolveControllerChooser({
  kind,
  policy,
  directory,
  controllerUserIds,
  activeGMId,
  allowGMFallback,
  unavailableReason
}) {
  const user = selectActiveUser(directory, controllerUserIds);
  if ( user ) return requestChooserSuccess(user.id, {kind, policy});
  if ( allowGMFallback !== false ) {
    const gm = activeUserById(directory, activeGMId) ?? firstActiveGM(directory);
    if ( gm ) return requestChooserSuccess(gm.id, {kind, policy, fallback: "gm"});
  }
  return failure(MULTIPLAYER_AUTHORITY_CODES.REQUEST_AUTHORITY_UNAVAILABLE, unavailableReason, {kind, policy});
}

function normalizeAuthorityUser(user, index=0) {
  const id = stringOrNull(user?.id ?? user?.userId ?? user?.uuid ?? user?._id);
  return {
    id,
    userRef: stringOrNull(user?.uuid ?? user?.userRef ?? (id ? `User.${id}` : null)),
    active: user?.active !== false && user?.online !== false && user?.connected !== false,
    isGM: user?.isGM === true || user?.gm === true || user?.role === "gm",
    isActiveGM: user?.isActiveGM === true,
    label: stringOrNull(user?.name ?? user?.label) ?? id ?? `User ${index + 1}`,
    permissions: clonePlainData(user?.permissions ?? {}, "user.permissions") ?? {}
  };
}

function requestChooserSuccess(userId, data={}) {
  return {
    ok: true,
    code: MULTIPLAYER_AUTHORITY_CODES.OK,
    reason: null,
    userId,
    ...clonePlainData(data, "requestChooser")
  };
}

function authoritySuccess(data={}) {
  return {
    ok: true,
    code: MULTIPLAYER_AUTHORITY_CODES.OK,
    reason: null,
    ...clonePlainData(data, "authority")
  };
}

function actionRefFromState(state) {
  return {
    id: state.actionDefinition?.id ?? null,
    name: state.actionDefinition?.label ?? null,
    type: state.actionDefinition?.category ?? "action",
    source: state.actionDefinition?.source ?? null
  };
}

function sanitizeCommittedMutations(transaction) {
  const committed = transaction?.committed ?? transaction?.operations ?? [];
  return normalizeArray(committed).map(operation => ({
    id: operation?.id ?? null,
    type: operation?.type ?? null,
    actorRef: operation?.actorRef ?? operation?.metadata?.actorRef ?? null,
    role: operation?.metadata?.role ?? null
  }));
}

function firstActiveGM(users) {
  return users.filter(user => user.active && user.isGM)
    .sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
}

function activeUserById(users, id) {
  const ref = stringOrNull(id);
  if ( !ref ) return null;
  return users.find(user => user.active && userMatchesRef(user, ref)) ?? null;
}

function selectActiveUser(users, refs) {
  const candidates = uniqueStrings(refs);
  return users.find(user => user.active && candidates.some(ref => userMatchesRef(user, ref))) ?? null;
}

function userMatchesRef(user, ref) {
  return refsMatch(user.id, ref) || refsMatch(user.userRef, ref);
}

function refsMatch(left, right) {
  const a = normalizeRef(left);
  const b = normalizeRef(right);
  return !!a && !!b && a === b;
}

function normalizeRef(value) {
  return stringOrNull(value)?.replace(/^User[.]/, "") ?? null;
}

function failure(code, reason, data={}) {
  return {
    ok: false,
    code,
    reason,
    ...clonePlainData(data, "failure")
  };
}

function createMessageId(type=null) {
  const token = String(type ?? "message").toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "message";
  return `resolution-message:${token}:${Date.now()}:${nextMessageSequence++}`;
}

function clonePlainDataUnchecked(value) {
  if ( value == null || typeof value !== "object" ) return value;
  if ( Array.isArray(value) ) return value.map(clonePlainDataUnchecked);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clonePlainDataUnchecked(entry)]));
}

function firstNonPlainData(value, path, seen) {
  if ( value == null ) return null;
  const type = typeof value;
  if ( type === "string" || type === "boolean" ) return null;
  if ( type === "number" ) return Number.isFinite(value)
    ? null
    : {path, reason: `${path} must contain only finite numbers.`};
  if ( type === "function" || type === "symbol" || type === "bigint" || type === "undefined" ) {
    return {path, reason: `${path} must be plain serializable data, not ${type}.`};
  }
  if ( seen.has(value) ) return {path, reason: `${path} must not contain circular references.`};
  seen.add(value);
  if ( Array.isArray(value) ) {
    for ( const [index, entry] of value.entries() ) {
      const issue = firstNonPlainData(entry, `${path}.${index}`, seen);
      if ( issue ) return issue;
    }
    seen.delete(value);
    return null;
  }
  if ( Object.getPrototypeOf(value) !== Object.prototype ) {
    seen.delete(value);
    return {path, reason: `${path} must be plain serializable data.`};
  }
  for ( const [key, entry] of Object.entries(value) ) {
    const issue = firstNonPlainData(entry, `${path}.${key}`, seen);
    if ( issue ) return issue;
  }
  seen.delete(value);
  return null;
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

function stringOrNull(value) {
  if ( value == null ) return null;
  const string = String(value).trim();
  return string ? string : null;
}

function finiteInteger(value) {
  if ( value == null || value === "" ) return null;
  if ( typeof value === "object" || typeof value === "function" || typeof value === "boolean" ) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : null;
}
