import {
  MULTIPLAYER_AUTHORITY_CODES,
  clonePlainData,
  validateResolutionSocketEnvelope
} from "../helpers/multiplayer-authority.mjs";
import {
  DISCLOSURE_CODES,
  classifyEnvelopeDisclosure
} from "../helpers/multiplayer-disclosure.mjs";

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Targeted (recipient-restricted) transport over Foundry V14 `User#query` / `CONFIG.queries`.
 *
 * Verified against the installed 14.367 source: `User#query` requires the query name to be registered
 * in `CONFIG.queries`, requires the sender to hold the `QUERY_USER` permission (default role PLAYER),
 * refuses inactive recipients, and emits `userQuery` to the server. The server re-checks the sender
 * permission, then emits only to the recipient user's own sockets with an acknowledgement callback,
 * honouring `timeout` and rejecting if the sender disconnects. The recipient's `Users.#handleUserQuery`
 * invokes the handler with `{timeout, user}` where `user` is the server-attested querying User, so the
 * recipient can verify `senderUserId` against an identity the sender cannot forge.
 *
 * The acknowledgement is a delivery receipt: the handler validates the envelope and dispatches it to
 * the registered handlers without awaiting them, so a prompt that stays open for minutes never holds
 * a query acknowledgement (which the server would time out). This is client-level confidentiality:
 * the server relays the payload and is trusted; the guarantee is that no unrelated connected client
 * receives it.
 */
export function createFoundryV14UserQueryTransport({
  id="foundry-v14-user-query",
  game=null,
  systemId="wildpath",
  queryName=null,
  queries=null,
  timeoutMs=DEFAULT_TIMEOUT_MS,
  logger=null
}={}) {
  const name = queryName ?? `${systemId}.resolutionEnvelope`;
  const handlers = new Set();
  let registered = false;

  const adapter = {
    id,
    type: "foundry-v14-user-query",
    queryName: name,
    register(nextHandler) {
      const handler = typeof nextHandler === "function" ? nextHandler : null;
      if ( !handler ) return {
        ok: false,
        code: MULTIPLAYER_AUTHORITY_CODES.INVALID_PAYLOAD,
        reason: "User query transport requires a message handler.",
        queryName: name
      };
      if ( registered ) {
        handlers.add(handler);
        return {ok: true, code: MULTIPLAYER_AUTHORITY_CODES.OK, registered: false, handlerCount: handlers.size, queryName: name};
      }
      const registry = resolveQueries(queries);
      if ( !registry || typeof registry !== "object" ) return {
        ok: false,
        code: DISCLOSURE_CODES.TARGETED_TRANSPORT_UNAVAILABLE,
        reason: "CONFIG.queries is not available; targeted transport cannot be registered.",
        queryName: name
      };
      const existing = registry[name];
      if ( existing && existing.wildpathTransportId !== id ) return {
        ok: false,
        code: DISCLOSURE_CODES.TARGETED_TRANSPORT_UNAVAILABLE,
        reason: `CONFIG.queries["${name}"] is already registered by another handler.`,
        queryName: name
      };
      const queryHandler = (queryData, context={}) => receiveQuery(queryData, context);
      queryHandler.wildpathTransportId = id;
      registry[name] = queryHandler;
      handlers.add(handler);
      registered = true;
      return {ok: true, code: MULTIPLAYER_AUTHORITY_CODES.OK, registered: true, handlerCount: handlers.size, queryName: name};
    },
    async send(envelope) {
      const validation = validateResolutionSocketEnvelope(envelope);
      if ( !validation.ok ) return validation;
      const data = validation.envelope;
      const classified = classifyEnvelopeDisclosure(data);
      if ( !classified.ok ) return {...classified, envelope: data};
      if ( !data.recipientUserId || data.recipientUserIds.length || ["all", "broadcast"].includes(data.recipientPolicy) ) return {
        ok: false,
        code: DISCLOSURE_CODES.PRIVATE_PAYLOAD_REQUIRES_SINGLE_RECIPIENT,
        reason: "Targeted transport requires exactly one recipientUserId.",
        envelope: data
      };
      const foundryGame = resolveGame(game);
      const localUserId = currentUserId(foundryGame);
      const user = foundryGame?.users?.get?.(data.recipientUserId) ?? null;
      if ( !foundryGame || !localUserId ) return {
        ok: false,
        code: MULTIPLAYER_AUTHORITY_CODES.TRANSPORT_UNAVAILABLE,
        reason: "Foundry game is not available.",
        envelope: data
      };
      if ( !user ) return {
        ok: false,
        code: DISCLOSURE_CODES.TARGETED_RECIPIENT_UNAVAILABLE,
        reason: `Recipient user ${data.recipientUserId} does not exist.`,
        envelope: data
      };
      if ( data.recipientUserId === localUserId ) {
        // Mirror DialogV2.query: a query to oneself never touches the socket.
        const local = await receiveQuery(clonePlainData(data, "envelope"), {user: foundryGame.user ?? {id: localUserId}, local: true});
        return {ok: true, code: MULTIPLAYER_AUTHORITY_CODES.OK, envelope: data, receipt: local, local: true};
      }
      if ( user.active !== true ) return {
        ok: false,
        code: DISCLOSURE_CODES.TARGETED_RECIPIENT_UNAVAILABLE,
        reason: `Recipient user ${data.recipientUserId} is not active.`,
        envelope: data
      };
      if ( typeof user.query !== "function" ) return {
        ok: false,
        code: DISCLOSURE_CODES.TARGETED_TRANSPORT_UNAVAILABLE,
        reason: "User#query is not available on this Foundry build.",
        envelope: data
      };
      try {
        const receipt = await user.query(name, clonePlainData(data, "envelope"), {timeout: timeoutMs});
        return {ok: true, code: MULTIPLAYER_AUTHORITY_CODES.OK, envelope: data, receipt};
      } catch (error) {
        return {...classifyQueryError(error), envelope: data};
      }
    },
    currentUser() {
      const foundryGame = resolveGame(game);
      const user = foundryGame?.user ?? null;
      return user ? {id: user.id ?? null, active: user.active === true, isGM: user.isGM === true} : null;
    },
    get registered() {
      return registered;
    },
    get handlerCount() {
      return handlers.size;
    }
  };
  return adapter;

  /**
   * CONFIG.queries handler. `context.user` is the querying User as attested by the server. Throwing
   * here rejects the query on the sender side with the thrown message, which carries the code.
   */
  async function receiveQuery(queryData, context={}) {
    const validation = validateResolutionSocketEnvelope(queryData);
    if ( !validation.ok ) throw new Error(`${validation.code}: ${validation.reason ?? "invalid envelope"}`);
    const envelope = validation.envelope;
    const classified = classifyEnvelopeDisclosure(envelope);
    if ( !classified.ok ) throw new Error(`${classified.code}: ${classified.reason}`);
    const attestedSenderUserId = stringOrNull(context.user?.id ?? context.user);
    if ( !attestedSenderUserId || envelope.senderUserId !== attestedSenderUserId ) {
      throw new Error(`${DISCLOSURE_CODES.DISCLOSURE_SENDER_MISMATCH}: envelope senderUserId does not match the querying user.`);
    }
    const localUserId = currentUserId(resolveGame(game));
    if ( !localUserId || envelope.recipientUserId !== localUserId ) {
      throw new Error(`${DISCLOSURE_CODES.DISCLOSURE_RECIPIENT_MISMATCH}: envelope is not addressed to this user.`);
    }
    if ( !handlers.size ) throw new Error(`${MULTIPLAYER_AUTHORITY_CODES.TRANSPORT_UNAVAILABLE}: no envelope handler is registered.`);
    const dispatch = Promise.all([...handlers].map(handler => Promise.resolve()
      .then(() => handler(envelope, {transport: adapter, attestedSenderUserId, local: context.local === true}))
      .catch(error => logWarning(logger, "Wild Path | Targeted envelope handler failed", error))));
    if ( context.local === true ) await dispatch;
    return {
      ok: true,
      code: MULTIPLAYER_AUTHORITY_CODES.OK,
      messageId: envelope.messageId,
      messageType: envelope.messageType,
      receivedByUserId: localUserId
    };
  }
}

/* -------------------------------------------- */

function classifyQueryError(error) {
  const message = error?.message ?? String(error);
  const known = Object.values(DISCLOSURE_CODES).find(code => message.startsWith(`${code}:`));
  if ( known ) return {ok: false, code: known, reason: message};
  if ( /permission/i.test(message) ) return {ok: false, code: DISCLOSURE_CODES.TARGETED_TRANSPORT_FORBIDDEN, reason: message};
  if ( /timed? ?out|timeout/i.test(message) ) return {ok: false, code: DISCLOSURE_CODES.TARGETED_TRANSPORT_TIMEOUT, reason: message};
  if ( /not registered|not active|does not exist|disconnected/i.test(message) ) {
    return {ok: false, code: DISCLOSURE_CODES.TARGETED_RECIPIENT_UNAVAILABLE, reason: message};
  }
  return {ok: false, code: DISCLOSURE_CODES.TARGETED_TRANSPORT_REJECTED, reason: message};
}

function resolveQueries(queries) {
  if ( queries && typeof queries === "object" ) return queries;
  const config = globalThis.CONFIG;
  if ( !config || typeof config !== "object" ) return null;
  config.queries ??= {};
  return config.queries;
}

function resolveGame(game) {
  return game ?? globalThis.game ?? null;
}

function currentUserId(foundryGame) {
  return stringOrNull(foundryGame?.user?.id ?? foundryGame?.userId ?? null);
}

function logWarning(logger, ...args) {
  const target = logger ?? globalThis.console;
  if ( typeof target?.warn === "function" ) target.warn(...args);
}

function stringOrNull(value) {
  if ( value == null ) return null;
  const string = String(value).trim();
  return string ? string : null;
}
