/**
 * Transport-level disclosure contract for WildPath multiplayer envelopes.
 *
 * AUTHORITY answers "who may decide or commit", ROUTING answers "who should process a message", and
 * DISCLOSURE answers "who is allowed to learn its contents". This module owns only the third question.
 * It knows nothing about Foundry Users, sockets, CONFIG.queries, or dialogs: it classifies plain
 * envelopes and selects a transport class ("broadcast", "targeted", or "local"), and the adapters
 * enforce that selection. Every envelope emitted on the `system.wildpath` broadcast bus must be
 * BROADCAST_SAFE; anything else fails closed here or in the adapters with a structured code.
 */

export const DISCLOSURE_CLASSIFICATIONS = Object.freeze({
  BROADCAST_SAFE: "BROADCAST_SAFE",
  PARTICIPANT_PRIVATE: "PARTICIPANT_PRIVATE",
  GM_PRIVATE: "GM_PRIVATE"
} as const);
export type DisclosureClassification = typeof DISCLOSURE_CLASSIFICATIONS[keyof typeof DISCLOSURE_CLASSIFICATIONS];

export const DISCLOSURE_TRANSPORTS = Object.freeze({
  BROADCAST: "broadcast",
  TARGETED: "targeted",
  LOCAL: "local"
} as const);
export type DisclosureTransport = typeof DISCLOSURE_TRANSPORTS[keyof typeof DISCLOSURE_TRANSPORTS];

export const DISCLOSURE_CODES = Object.freeze({
  OK: "OK",
  UNCLASSIFIED_DISCLOSURE: "UNCLASSIFIED_DISCLOSURE",
  UNKNOWN_DISCLOSURE: "UNKNOWN_DISCLOSURE",
  PRIVATE_PAYLOAD_REQUIRES_TARGETED_TRANSPORT: "PRIVATE_PAYLOAD_REQUIRES_TARGETED_TRANSPORT",
  PRIVATE_PAYLOAD_REQUIRES_SINGLE_RECIPIENT: "PRIVATE_PAYLOAD_REQUIRES_SINGLE_RECIPIENT",
  PRIVATE_PAYLOAD_ON_BROADCAST_TRANSPORT: "PRIVATE_PAYLOAD_ON_BROADCAST_TRANSPORT",
  GM_PRIVATE_REQUIRES_GM_RECIPIENT: "GM_PRIVATE_REQUIRES_GM_RECIPIENT",
  TARGETED_TRANSPORT_UNAVAILABLE: "TARGETED_TRANSPORT_UNAVAILABLE",
  TARGETED_RECIPIENT_UNAVAILABLE: "TARGETED_RECIPIENT_UNAVAILABLE",
  TARGETED_TRANSPORT_FORBIDDEN: "TARGETED_TRANSPORT_FORBIDDEN",
  TARGETED_TRANSPORT_TIMEOUT: "TARGETED_TRANSPORT_TIMEOUT",
  TARGETED_TRANSPORT_REJECTED: "TARGETED_TRANSPORT_REJECTED",
  DISCLOSURE_SENDER_MISMATCH: "DISCLOSURE_SENDER_MISMATCH",
  DISCLOSURE_RECIPIENT_MISMATCH: "DISCLOSURE_RECIPIENT_MISMATCH"
} as const);
export type DisclosureCode = typeof DISCLOSURE_CODES[keyof typeof DISCLOSURE_CODES];

/**
 * The audited policy for every current message type. RESOLUTION_RESULT is intentionally absent: the
 * coordinator emits two explicit projections of a result (a PARTICIPANT_PRIVATE one for the initiator
 * and a BROADCAST_SAFE one for everyone) and must classify each of them itself.
 */
export const DEFAULT_DISCLOSURE_BY_MESSAGE_TYPE: Readonly<Record<string, DisclosureClassification>> = Object.freeze({
  ACTION_INTENT: DISCLOSURE_CLASSIFICATIONS.BROADCAST_SAFE,
  MOVEMENT_INTENT: DISCLOSURE_CLASSIFICATIONS.BROADCAST_SAFE,
  MOVEMENT_COMMIT: DISCLOSURE_CLASSIFICATIONS.BROADCAST_SAFE,
  PENDING_REQUEST: DISCLOSURE_CLASSIFICATIONS.PARTICIPANT_PRIVATE,
  REQUEST_RESPONSE: DISCLOSURE_CLASSIFICATIONS.PARTICIPANT_PRIVATE,
  RESOLUTION_ERROR: DISCLOSURE_CLASSIFICATIONS.PARTICIPANT_PRIVATE,
  MOVEMENT_APPROVAL: DISCLOSURE_CLASSIFICATIONS.PARTICIPANT_PRIVATE,
  MOVEMENT_RESULT: DISCLOSURE_CLASSIFICATIONS.PARTICIPANT_PRIVATE,
  MOVEMENT_CONTINUATION: DISCLOSURE_CLASSIFICATIONS.PARTICIPANT_PRIVATE
});

/** Message types whose contents are never allowed on the broadcast bus. Used by evidence checks. */
export const PRIVATE_MESSAGE_TYPES: readonly string[] = Object.freeze(Object.entries(DEFAULT_DISCLOSURE_BY_MESSAGE_TYPE)
  .filter(([, classification]) => isPrivateDisclosure(classification))
  .map(([messageType]) => messageType));

/** The envelope fields this module reads. Envelopes are plain data; every field may be absent. */
export interface DisclosureEnvelope {
  readonly disclosure?: unknown;
  readonly messageType?: unknown;
  readonly type?: unknown;
  readonly messageId?: unknown;
  readonly id?: unknown;
  readonly recipientUserId?: unknown;
  readonly recipientUserIds?: unknown;
  readonly recipientPolicy?: unknown;
}

export interface DisclosureFailure {
  readonly ok: false;
  readonly code: DisclosureCode;
  readonly reason: string;
  readonly classification?: DisclosureClassification;
  readonly recipientUserId?: string;
}

export interface DisclosureClassified {
  readonly ok: true;
  readonly code: typeof DISCLOSURE_CODES.OK;
  readonly reason: null;
  readonly classification: DisclosureClassification;
}

export interface DisclosureTransportSelection {
  readonly ok: true;
  readonly code: typeof DISCLOSURE_CODES.OK;
  readonly reason: null;
  readonly transport: DisclosureTransport;
  readonly classification: DisclosureClassification;
  readonly recipientUserId: string | null;
}

interface DirectoryUser {
  readonly id?: unknown;
  readonly userId?: unknown;
  readonly isGM?: unknown;
}

/* -------------------------------------------- */

export function normalizeDisclosure(value: unknown): DisclosureClassification | null {
  if ( value == null ) return null;
  const token = String(value).trim().toUpperCase().replace(/[\s-]+/g, "_");
  return isClassification(token) ? token : null;
}

export function isPrivateDisclosure(classification: unknown): boolean {
  const normalized = normalizeDisclosure(classification);
  return normalized === DISCLOSURE_CLASSIFICATIONS.PARTICIPANT_PRIVATE
    || normalized === DISCLOSURE_CLASSIFICATIONS.GM_PRIVATE;
}

export function defaultDisclosureForMessageType(messageType: unknown): DisclosureClassification | null {
  const key = messageType == null ? null : String(messageType).trim();
  return key && Object.hasOwn(DEFAULT_DISCLOSURE_BY_MESSAGE_TYPE, key) ? DEFAULT_DISCLOSURE_BY_MESSAGE_TYPE[key] ?? null : null;
}

/**
 * Read the explicit classification carried by an envelope. Missing classifications fail closed as
 * UNCLASSIFIED_DISCLOSURE; unrecognised strings fail as UNKNOWN_DISCLOSURE. Nothing is inferred from
 * the message type here: inference happens once, when the envelope is created.
 */
export function classifyEnvelopeDisclosure(envelope: DisclosureEnvelope | null | undefined): DisclosureClassified | DisclosureFailure {
  const raw = envelope?.disclosure ?? null;
  if ( raw == null || raw === "" ) return failure(DISCLOSURE_CODES.UNCLASSIFIED_DISCLOSURE,
    `Envelope ${describe(envelope)} carries no disclosure classification.`);
  const classification = normalizeDisclosure(raw);
  if ( !classification ) return failure(DISCLOSURE_CODES.UNKNOWN_DISCLOSURE,
    `Envelope ${describe(envelope)} carries an unknown disclosure classification: ${String(raw)}.`);
  return {ok: true, code: DISCLOSURE_CODES.OK, reason: null, classification};
}

/** Broadcast adapters call this before emitting and before dispatching anything received. */
export function assertBroadcastSafe(envelope: DisclosureEnvelope | null | undefined): DisclosureClassified | DisclosureFailure {
  const classified = classifyEnvelopeDisclosure(envelope);
  if ( !classified.ok ) return classified;
  if ( classified.classification !== DISCLOSURE_CLASSIFICATIONS.BROADCAST_SAFE ) {
    return failure(DISCLOSURE_CODES.PRIVATE_PAYLOAD_REQUIRES_TARGETED_TRANSPORT,
      `Envelope ${describe(envelope)} is ${classified.classification} and may not use the broadcast transport; `
      + "recipientUserId is routing metadata, not confidentiality.", {classification: classified.classification});
  }
  return classified;
}

/**
 * Select the transport class for an envelope.
 *
 * - An envelope whose single recipient is the local user is delivered locally, whatever its
 *   classification: the Foundry custom-socket relay never echoes to the sender.
 * - BROADCAST_SAFE envelopes use the broadcast bus.
 * - PARTICIPANT_PRIVATE and GM_PRIVATE envelopes require exactly one recipient and a targeted port.
 *   GM_PRIVATE additionally requires that recipient to be a GM according to the supplied directory.
 */
export function selectDisclosureTransport(envelope: DisclosureEnvelope | null | undefined, {
  localUserId=null,
  users=[],
  targetedAvailable=false
}: {
  localUserId?: unknown;
  users?: readonly DirectoryUser[] | (() => readonly DirectoryUser[]);
  targetedAvailable?: boolean;
}={}): DisclosureTransportSelection | DisclosureFailure {
  const classified = classifyEnvelopeDisclosure(envelope);
  if ( !classified.ok ) return classified;
  const classification = classified.classification;
  const recipientUserId = stringOrNull(envelope?.recipientUserId);
  const recipientUserIds = normalizeArray(envelope?.recipientUserIds).map(stringOrNull).filter(Boolean);
  const policy = stringOrNull(envelope?.recipientPolicy);
  const local = stringOrNull(localUserId);
  const single = recipientUserId && !recipientUserIds.length && !["all", "broadcast"].includes(policy ?? "")
    ? recipientUserId : null;

  if ( single && local && single === local ) {
    return {ok: true, code: DISCLOSURE_CODES.OK, reason: null, transport: DISCLOSURE_TRANSPORTS.LOCAL, classification,
      recipientUserId: single};
  }
  if ( classification === DISCLOSURE_CLASSIFICATIONS.BROADCAST_SAFE ) {
    return {ok: true, code: DISCLOSURE_CODES.OK, reason: null, transport: DISCLOSURE_TRANSPORTS.BROADCAST, classification,
      recipientUserId: single};
  }
  if ( !single ) return failure(DISCLOSURE_CODES.PRIVATE_PAYLOAD_REQUIRES_SINGLE_RECIPIENT,
    `${classification} envelope ${describe(envelope)} must name exactly one recipientUserId.`, {classification});
  if ( classification === DISCLOSURE_CLASSIFICATIONS.GM_PRIVATE ) {
    const directory = typeof users === "function" ? users() : users;
    const recipient = normalizeArray(directory).find(user => stringOrNull(user?.id ?? user?.userId) === single);
    if ( recipient?.isGM !== true ) return failure(DISCLOSURE_CODES.GM_PRIVATE_REQUIRES_GM_RECIPIENT,
      `GM_PRIVATE envelope ${describe(envelope)} is addressed to ${single}, who is not a known GM.`,
      {classification, recipientUserId: single});
  }
  if ( !targetedAvailable ) return failure(DISCLOSURE_CODES.PRIVATE_PAYLOAD_REQUIRES_TARGETED_TRANSPORT,
    `${classification} envelope ${describe(envelope)} requires a targeted transport and none is available.`,
    {classification, recipientUserId: single});
  return {ok: true, code: DISCLOSURE_CODES.OK, reason: null, transport: DISCLOSURE_TRANSPORTS.TARGETED, classification,
    recipientUserId: single};
}

/* -------------------------------------------- */

function isClassification(value: string): value is DisclosureClassification {
  return (Object.values(DISCLOSURE_CLASSIFICATIONS) as readonly string[]).includes(value);
}

function failure(code: DisclosureCode, reason: string,
  data: {classification?: DisclosureClassification; recipientUserId?: string}={}): DisclosureFailure {
  return {ok: false, code, reason, ...data};
}

function describe(envelope: DisclosureEnvelope | null | undefined): string {
  const type = envelope?.messageType ?? envelope?.type ?? "<unknown type>";
  const id = envelope?.messageId ?? envelope?.id ?? "<no id>";
  return `${String(type)} [${String(id)}]`;
}

function normalizeArray<T>(value: T | readonly T[] | null | undefined): readonly T[] {
  if ( value == null ) return [];
  return Array.isArray(value) ? value : [value as T];
}

function stringOrNull(value: unknown): string | null {
  if ( value == null ) return null;
  const string = String(value).trim();
  return string ? string : null;
}
