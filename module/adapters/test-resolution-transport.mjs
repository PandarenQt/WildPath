import {
  MULTIPLAYER_AUTHORITY_CODES,
  clonePlainData,
  recipientMatchesEnvelope,
  validateResolutionSocketEnvelope
} from "../helpers/multiplayer-authority.mjs";

export function createTestResolutionTransportHub({users=[]}={}) {
  const endpoints = new Map();
  const messages = [];
  const directory = new Map(normalizeArray(users).map(user => [String(user.id ?? user.userId), {...user}]));

  return {
    type: "test-resolution-transport-hub",
    messages,
    endpoints,
    users: directory,

    createEndpoint({userId, active=null}={}) {
      const id = String(userId ?? `user:${endpoints.size + 1}`);
      const nextActive = active == null ? directory.get(id)?.active ?? true : active === true;
      if ( directory.has(id) ) directory.set(id, {...directory.get(id), active: nextActive});
      else directory.set(id, {id, active: nextActive});

      const handlers = new Set();
      const endpoint = {
        id: `test-resolution-transport:${id}`,
        type: "test-resolution-transport",
        userId: id,
        sent: [],
        received: [],
        get active() {
          return directory.get(id)?.active !== false;
        },
        setActive(nextActive) {
          directory.set(id, {...(directory.get(id) ?? {id}), active: nextActive === true});
        },
        register(nextHandler) {
          const handler = typeof nextHandler === "function" ? nextHandler : null;
          if ( !handler ) return {ok: false, code: MULTIPLAYER_AUTHORITY_CODES.INVALID_PAYLOAD};
          handlers.add(handler);
          return {
            ok: true,
            code: MULTIPLAYER_AUTHORITY_CODES.OK,
            registered: handlers.size === 1,
            handlerCount: handlers.size
          };
        },
        async send(envelope) {
          const validation = validateResolutionSocketEnvelope(envelope);
          if ( !validation.ok ) return validation;
          const data = clonePlainData(validation.envelope, "envelope");
          endpoint.sent.push(data);
          messages.push(data);
          const delivered = [];
          for ( const candidate of endpoints.values() ) {
            if ( candidate.active !== true ) continue;
            if ( !recipientMatchesEnvelope(data, candidate.userId) ) continue;
            candidate.received.push(clonePlainData(data, "receivedEnvelope"));
            delivered.push(candidate.userId);
            if ( typeof candidate.handle === "function" ) {
              await candidate.handle(clonePlainData(data, "deliveredEnvelope"));
            }
          }
          return {
            ok: true,
            code: MULTIPLAYER_AUTHORITY_CODES.OK,
            delivered,
            envelope: data
          };
        },
        async handle(envelope) {
          if ( !handlers.size ) return {
            ok: false,
            code: MULTIPLAYER_AUTHORITY_CODES.TRANSPORT_UNAVAILABLE,
            reason: "No test transport handler is registered."
          };
          const results = [];
          for ( const handler of handlers ) {
            results.push(await handler(envelope, {transport: endpoint}));
          }
          return results.length === 1 ? results[0] : {
            ok: true,
            code: MULTIPLAYER_AUTHORITY_CODES.OK,
            results
          };
        }
      };

      endpoints.set(id, endpoint);
      return endpoint;
    },

    setActive(userId, active) {
      const id = String(userId);
      directory.set(id, {...(directory.get(id) ?? {id}), active: active === true});
      const endpoint = endpoints.get(id);
      if ( endpoint ) endpoint.setActive(active === true);
    },

    userDirectory() {
      return [...directory.values()].map(user => ({...user}));
    }
  };
}

function normalizeArray(value) {
  if ( value == null ) return [];
  return Array.isArray(value) ? value : [value];
}
