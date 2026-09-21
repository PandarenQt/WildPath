import {
  MULTIPLAYER_AUTHORITY_CODES,
  clonePlainData,
  recipientMatchesEnvelope,
  validateResolutionSocketEnvelope
} from "../helpers/multiplayer-authority.mjs";
import {
  DISCLOSURE_CODES,
  DISCLOSURE_TRANSPORTS,
  assertBroadcastSafe,
  classifyEnvelopeDisclosure
} from "../helpers/multiplayer-disclosure.mjs";
import {createDisclosureRoutedTransport} from "./disclosure-routed-transport.mjs";

/**
 * Deterministic multi-client transport for Node tests, mirroring the production topology:
 *
 * - every endpoint is a disclosure-routed transport composed of a simulated broadcast bus port and a
 *   simulated targeted port, exactly like the Foundry runtime;
 * - the bus refuses anything not BROADCAST_SAFE, delivers to every other active endpoint whose
 *   routing matches, and never echoes to the sender (the Foundry custom-socket relay excludes it);
 * - the targeted port delivers to exactly one active endpoint, rejects a claimed senderUserId that
 *   differs from the sending endpoint (the server-attested identity), and refuses unclassified data;
 * - self-addressed envelopes are delivered locally by the routed transport, awaited for determinism.
 *
 * `hub.messages` records every accepted send in order, whatever transport carried it.
 * `hub.broadcastMessages` records only what crossed the bus, which is what "every connected client
 * can read" means in tests. `hub.targetedMessages`, `hub.localMessages` and `hub.refusals` complete
 * the picture.
 */
export function createTestResolutionTransportHub({users=[]}={}) {
  const endpoints = new Map();
  const messages = [];
  const broadcastMessages = [];
  const targetedMessages = [];
  const localMessages = [];
  const refusals = [];
  const directory = new Map(normalizeArray(users).map(user => [String(user.id ?? user.userId), {...user}]));

  const hub = {
    type: "test-resolution-transport-hub",
    messages,
    broadcastMessages,
    targetedMessages,
    localMessages,
    refusals,
    endpoints,
    users: directory,

    createEndpoint({userId, active=null}={}) {
      const id = String(userId ?? `user:${endpoints.size + 1}`);
      const nextActive = active == null ? directory.get(id)?.active ?? true : active === true;
      if ( directory.has(id) ) directory.set(id, {...directory.get(id), active: nextActive});
      else directory.set(id, {id, active: nextActive});

      const busHandlers = new Set();
      const targetedHandlers = new Set();

      const bus = {
        id: `test-broadcast-bus:${id}`,
        type: "test-broadcast-bus",
        userId: id,
        register(handler) {
          if ( typeof handler !== "function" ) return {ok: false, code: MULTIPLAYER_AUTHORITY_CODES.INVALID_PAYLOAD};
          busHandlers.add(handler);
          return {ok: true, code: MULTIPLAYER_AUTHORITY_CODES.OK, registered: busHandlers.size === 1, handlerCount: busHandlers.size};
        },
        async send(envelope) {
          const validation = validateResolutionSocketEnvelope(envelope);
          if ( !validation.ok ) return validation;
          const data = clonePlainData(validation.envelope, "envelope");
          const safe = assertBroadcastSafe(data);
          if ( !safe.ok ) {
            refusals.push({transport: DISCLOSURE_TRANSPORTS.BROADCAST, code: safe.code, reason: safe.reason, envelope: data});
            return {...safe, envelope: data};
          }
          broadcastMessages.push(data);
          const delivered = [];
          for ( const candidate of endpoints.values() ) {
            if ( candidate.userId === id ) continue;
            if ( candidate.active !== true ) continue;
            if ( !recipientMatchesEnvelope(data, candidate.userId) ) continue;
            delivered.push(candidate.userId);
            await candidate.receiveFromBus(clonePlainData(data, "deliveredEnvelope"), {attestedSenderUserId: id});
          }
          return {ok: true, code: MULTIPLAYER_AUTHORITY_CODES.OK, delivered, envelope: data};
        }
      };

      const targeted = {
        id: `test-targeted-transport:${id}`,
        type: "test-targeted-transport",
        userId: id,
        register(handler) {
          if ( typeof handler !== "function" ) return {ok: false, code: MULTIPLAYER_AUTHORITY_CODES.INVALID_PAYLOAD};
          targetedHandlers.add(handler);
          return {ok: true, code: MULTIPLAYER_AUTHORITY_CODES.OK, registered: targetedHandlers.size === 1, handlerCount: targetedHandlers.size};
        },
        async send(envelope) {
          const validation = validateResolutionSocketEnvelope(envelope);
          if ( !validation.ok ) return validation;
          const data = clonePlainData(validation.envelope, "envelope");
          const classified = classifyEnvelopeDisclosure(data);
          if ( !classified.ok ) return refuse(DISCLOSURE_TRANSPORTS.TARGETED, classified, data);
          if ( !data.recipientUserId || data.recipientUserIds.length || ["all", "broadcast"].includes(data.recipientPolicy) ) {
            return refuse(DISCLOSURE_TRANSPORTS.TARGETED, {code: DISCLOSURE_CODES.PRIVATE_PAYLOAD_REQUIRES_SINGLE_RECIPIENT,
              reason: "Targeted transport requires exactly one recipientUserId."}, data);
          }
          if ( data.senderUserId !== id ) {
            return refuse(DISCLOSURE_TRANSPORTS.TARGETED, {code: DISCLOSURE_CODES.DISCLOSURE_SENDER_MISMATCH,
              reason: `Envelope claims senderUserId ${data.senderUserId} but was sent by ${id}.`}, data);
          }
          const recipient = endpoints.get(data.recipientUserId);
          if ( !recipient || recipient.active !== true ) {
            return refuse(DISCLOSURE_TRANSPORTS.TARGETED, {code: DISCLOSURE_CODES.TARGETED_RECIPIENT_UNAVAILABLE,
              reason: `Recipient ${data.recipientUserId} is not an active endpoint.`}, data);
          }
          targetedMessages.push({envelope: data, senderUserId: id, recipientUserId: data.recipientUserId});
          const receipt = await recipient.receiveTargeted(clonePlainData(data, "deliveredEnvelope"), {attestedSenderUserId: id});
          return {ok: true, code: MULTIPLAYER_AUTHORITY_CODES.OK, delivered: [data.recipientUserId], receipt, envelope: data};
        }
      };

      const endpoint = createDisclosureRoutedTransport({
        id: `test-resolution-transport:${id}`,
        userId: id,
        broadcast: bus,
        targeted,
        users: () => hub.userDirectory(),
        localDelivery: "await"
      });
      const sent = [];
      const received = [];
      Object.defineProperties(endpoint, {
        sent: {value: sent, enumerable: true},
        received: {value: received, enumerable: true},
        active: {get: () => directory.get(id)?.active !== false, enumerable: true}
      });
      endpoint.setActive = nextActive => {
        directory.set(id, {...(directory.get(id) ?? {id}), active: nextActive === true});
      };
      endpoint.receiveFromBus = async (envelope, context={}) => {
        const safe = assertBroadcastSafe(envelope);
        if ( !safe.ok ) {
          refusals.push({transport: DISCLOSURE_TRANSPORTS.BROADCAST, code: DISCLOSURE_CODES.PRIVATE_PAYLOAD_ON_BROADCAST_TRANSPORT,
            reason: safe.reason, envelope});
          return {ok: false, code: DISCLOSURE_CODES.PRIVATE_PAYLOAD_ON_BROADCAST_TRANSPORT, reason: safe.reason};
        }
        return dispatch(busHandlers, envelope, {...context, transport: bus});
      };
      endpoint.receiveTargeted = async (envelope, context={}) => {
        if ( envelope.recipientUserId !== id ) {
          return {ok: false, code: DISCLOSURE_CODES.DISCLOSURE_RECIPIENT_MISMATCH, reason: "Envelope is not addressed to this endpoint."};
        }
        return dispatch(targetedHandlers, envelope, {...context, transport: targeted});
      };
      endpoint.observe(event => {
        if ( event.direction === "sending" ) {
          sent.push(event.envelope);
          messages.push(event.envelope);
          if ( event.transport === DISCLOSURE_TRANSPORTS.LOCAL ) localMessages.push(event.envelope);
        } else if ( event.direction === "incoming" ) {
          received.push(event.envelope);
        } else if ( event.direction === "refused" ) {
          refusals.push({transport: null, code: event.code, reason: event.reason, envelope: event.envelope});
        }
      });

      endpoints.set(id, endpoint);
      return endpoint;
    },

    setActive(userId, active) {
      const id = String(userId);
      directory.set(id, {...(directory.get(id) ?? {id}), active: active === true});
    },

    userDirectory() {
      return [...directory.values()].map(user => ({...user}));
    }
  };
  return hub;

  function refuse(transport, failure, envelope) {
    refusals.push({transport, code: failure.code, reason: failure.reason, envelope});
    return {ok: false, code: failure.code, reason: failure.reason, envelope};
  }
}

async function dispatch(handlers, envelope, context) {
  if ( !handlers.size ) return {
    ok: false,
    code: MULTIPLAYER_AUTHORITY_CODES.TRANSPORT_UNAVAILABLE,
    reason: "No test transport handler is registered."
  };
  const results = [];
  for ( const handler of handlers ) {
    results.push(await handler(envelope, context));
  }
  return results.length === 1 ? results[0] : {ok: true, code: MULTIPLAYER_AUTHORITY_CODES.OK, results};
}

function normalizeArray(value) {
  if ( value == null ) return [];
  return Array.isArray(value) ? value : [value];
}
