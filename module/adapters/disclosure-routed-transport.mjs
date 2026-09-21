import {
  MULTIPLAYER_AUTHORITY_CODES,
  clonePlainData,
  validateResolutionSocketEnvelope
} from "../helpers/multiplayer-authority.mjs";
import {
  DISCLOSURE_TRANSPORTS,
  selectDisclosureTransport
} from "../helpers/multiplayer-disclosure.mjs";

/**
 * A ResolutionTransportPort that applies the disclosure policy before any adapter sees an envelope.
 *
 *   coordinator (transport intent: envelope + classification)
 *     -> selectDisclosureTransport (policy)
 *     -> broadcast port | targeted port | local dispatch (adapters)
 *
 * The coordinators keep every authority, routing, and idempotency responsibility; this port only
 * decides which delivery mechanism an envelope may use and fails closed when none is allowed.
 * Envelopes addressed to the local user are dispatched locally because the Foundry custom-socket
 * relay never echoes a message to its sender.
 *
 * `localDelivery` is "detached" in production (parity with fire-and-forget socket emission) and
 * "await" in deterministic tests, where callers rely on the local handler finishing before `send`
 * resolves.
 */
export function createDisclosureRoutedTransport({
  id="disclosure-routed-transport",
  userId=null,
  broadcast=null,
  targeted=null,
  users=[],
  localDelivery="detached",
  logger=null
}={}) {
  const handlers = new Set();
  const observers = new Set();
  let registered = false;
  let registration = null;
  const localUserId = stringOrNull(userId ?? broadcast?.userId ?? broadcast?.currentUser?.()?.id ?? null);

  const api = {
    id,
    type: "disclosure-routed-transport",
    userId: localUserId,
    broadcast,
    targeted,
    register(nextHandler) {
      const handler = typeof nextHandler === "function" ? nextHandler : null;
      if ( !handler ) return {
        ok: false,
        code: MULTIPLAYER_AUTHORITY_CODES.INVALID_PAYLOAD,
        reason: "Disclosure-routed transport requires a message handler."
      };
      handlers.add(handler);
      if ( registered ) return {ok: true, code: MULTIPLAYER_AUTHORITY_CODES.OK, registered: false, handlerCount: handlers.size, ports: registration};
      const ports = {};
      ports.broadcast = typeof broadcast?.register === "function"
        ? broadcast.register((envelope, context={}) => dispatch(envelope, {...context, deliveredBy: DISCLOSURE_TRANSPORTS.BROADCAST}))
        : {ok: false, code: MULTIPLAYER_AUTHORITY_CODES.TRANSPORT_UNAVAILABLE, reason: "No broadcast transport port is available."};
      ports.targeted = typeof targeted?.register === "function"
        ? targeted.register((envelope, context={}) => dispatch(envelope, {...context, deliveredBy: DISCLOSURE_TRANSPORTS.TARGETED}))
        : {ok: false, code: MULTIPLAYER_AUTHORITY_CODES.TRANSPORT_UNAVAILABLE, reason: "No targeted transport port is available."};
      registered = ports.broadcast.ok !== false;
      registration = ports;
      if ( ports.targeted.ok === false ) logWarning(logger, "Wild Path | Targeted transport registration failed; private envelopes will fail closed", ports.targeted);
      return {
        ok: registered,
        code: registered ? MULTIPLAYER_AUTHORITY_CODES.OK : ports.broadcast.code,
        reason: registered ? null : ports.broadcast.reason,
        registered,
        handlerCount: handlers.size,
        ports
      };
    },
    async send(envelope) {
      const validation = validateResolutionSocketEnvelope(envelope);
      if ( !validation.ok ) return validation;
      const data = validation.envelope;
      const route = selectDisclosureTransport(data, {
        localUserId,
        users: directory(),
        targetedAvailable: typeof targeted?.send === "function"
      });
      if ( !route.ok ) {
        notifyObservers({direction: "refused", transport: null, envelope: data, code: route.code, reason: route.reason});
        return {...route, envelope: data};
      }
      notifyObservers({direction: "sending", transport: route.transport, envelope: data, recipientUserId: route.recipientUserId ?? null});
      let sent;
      try {
        if ( route.transport === DISCLOSURE_TRANSPORTS.LOCAL ) sent = await deliverLocally(data);
        else if ( route.transport === DISCLOSURE_TRANSPORTS.TARGETED ) sent = await targeted.send(data);
        else sent = await broadcast.send(data);
      } catch (error) {
        sent = {ok: false, code: MULTIPLAYER_AUTHORITY_CODES.TRANSPORT_SEND_FAILED, reason: error?.message ?? String(error)};
      }
      const result = {
        ...(sent ?? {ok: true, code: MULTIPLAYER_AUTHORITY_CODES.OK}),
        envelope: data,
        transport: route.transport,
        classification: route.classification,
        recipientUserId: route.recipientUserId ?? null
      };
      notifyObservers({direction: "outgoing", transport: route.transport, envelope: data,
        recipientUserId: route.recipientUserId ?? null, ok: result.ok !== false, code: result.code});
      return result;
    },
    /** Observe traffic for QA/evidence without touching sockets. Returns an unsubscribe function. */
    observe(listener) {
      if ( typeof listener !== "function" ) return () => {};
      observers.add(listener);
      return () => observers.delete(listener);
    },
    /** The broadcast namespace, for callers that identify the runtime transport by it. */
    get namespace() {
      return broadcast?.namespace ?? null;
    },
    currentUser() {
      return broadcast?.currentUser?.() ?? (localUserId ? {id: localUserId} : null);
    },
    users() {
      return directory();
    },
    get registered() {
      return registered;
    },
    get handlerCount() {
      return handlers.size;
    }
  };
  return api;

  async function dispatch(envelope, context={}) {
    notifyObservers({direction: "incoming", transport: context.deliveredBy ?? null, envelope,
      senderUserId: envelope?.senderUserId ?? null, attestedSenderUserId: context.attestedSenderUserId ?? null});
    const results = [];
    for ( const handler of handlers ) {
      results.push(await handler(envelope, {...context, transport: api}));
    }
    return results.length === 1 ? results[0] : {ok: true, code: MULTIPLAYER_AUTHORITY_CODES.OK, results};
  }

  async function deliverLocally(envelope) {
    const delivered = clonePlainData(envelope, "envelope");
    if ( localDelivery === "await" ) {
      const result = await dispatch(delivered, {deliveredBy: DISCLOSURE_TRANSPORTS.LOCAL, attestedSenderUserId: localUserId});
      return {ok: true, code: MULTIPLAYER_AUTHORITY_CODES.OK, local: true, result};
    }
    Promise.resolve()
      .then(() => dispatch(delivered, {deliveredBy: DISCLOSURE_TRANSPORTS.LOCAL, attestedSenderUserId: localUserId}))
      .catch(error => logWarning(logger, "Wild Path | Local envelope delivery failed", error));
    return {ok: true, code: MULTIPLAYER_AUTHORITY_CODES.OK, local: true};
  }

  function directory() {
    const resolved = typeof users === "function" ? users() : users;
    return Array.isArray(resolved) ? resolved : [];
  }

  function notifyObservers(event) {
    for ( const observer of observers ) {
      try { observer(event); }
      catch (error) { logWarning(logger, "Wild Path | Transport observer failed", error); }
    }
  }
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
