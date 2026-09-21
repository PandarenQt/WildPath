import {
  MULTIPLAYER_AUTHORITY_CODES,
  clonePlainData,
  normalizeAuthorityUsers,
  recipientMatchesEnvelope,
  validateResolutionSocketEnvelope
} from "../helpers/multiplayer-authority.mjs";
import {
  DISCLOSURE_CODES,
  assertBroadcastSafe
} from "../helpers/multiplayer-disclosure.mjs";

/**
 * Broadcast adapter over the `system.wildpath` custom socket. Foundry relays every emission to every
 * other connected client (never back to the sender), so this adapter refuses to emit, and refuses to
 * dispatch, anything that is not classified BROADCAST_SAFE. `recipientUserId` is routing only.
 * The server appends the attested sender user id as the handler's second argument; envelopes whose
 * claimed senderUserId disagrees with it are dropped.
 */

export function createFoundryV14ResolutionSocketAdapter({
  id="foundry-v14-resolution-socket",
  game=null,
  systemId="wildpath",
  namespace=null,
  logger=null
}={}) {
  const socketNamespace = namespace ?? `system.${systemId}`;
  let registered = false;
  const handlers = new Set();

  const adapter = {
    id,
    type: "foundry-v14-resolution-socket",
    namespace: socketNamespace,
    register(nextHandler) {
      const foundryGame = resolveGame(game);
      const socket = foundryGame?.socket ?? null;
      const handler = typeof nextHandler === "function" ? nextHandler : null;
      if ( !handler ) return {
        ok: false,
        code: MULTIPLAYER_AUTHORITY_CODES.INVALID_PAYLOAD,
        reason: "Resolution socket adapter requires a message handler.",
        namespace: socketNamespace
      };

      if ( registered ) {
        handlers.add(handler);
        return {
          ok: true,
          code: MULTIPLAYER_AUTHORITY_CODES.OK,
          registered: false,
          handlerCount: handlers.size,
          namespace: socketNamespace
        };
      }
      if ( !socket || typeof socket.on !== "function" ) return {
        ok: false,
        code: MULTIPLAYER_AUTHORITY_CODES.TRANSPORT_UNAVAILABLE,
        reason: "Foundry game.socket is not available.",
        namespace: socketNamespace
      };

      handlers.add(handler);
      socket.on(socketNamespace, async (envelope, attestedSenderUserId=null) => {
        const validation = validateResolutionSocketEnvelope(envelope);
        if ( !validation.ok ) {
          logWarning(logger, "Wild Path | Rejected invalid resolution socket envelope", validation);
          return;
        }
        const safe = assertBroadcastSafe(validation.envelope);
        if ( !safe.ok ) {
          logWarning(logger, "Wild Path | Refused a non-broadcast-safe envelope received on the broadcast bus", {
            code: DISCLOSURE_CODES.PRIVATE_PAYLOAD_ON_BROADCAST_TRANSPORT,
            classification: safe.classification ?? null,
            messageType: validation.envelope.messageType,
            messageId: validation.envelope.messageId
          });
          return;
        }
        const attested = attestedSenderUserId == null ? null : String(attestedSenderUserId);
        if ( attested && validation.envelope.senderUserId !== attested ) {
          logWarning(logger, "Wild Path | Dropped a socket envelope whose senderUserId does not match the attested sender", {
            code: DISCLOSURE_CODES.DISCLOSURE_SENDER_MISMATCH,
            messageType: validation.envelope.messageType,
            messageId: validation.envelope.messageId
          });
          return;
        }
        const currentUserId = foundryGame?.user?.id ?? foundryGame?.userId ?? null;
        if ( !recipientMatchesEnvelope(validation.envelope, currentUserId) ) return;
        for ( const handler of handlers ) {
          try {
            await handler(validation.envelope, {transport: adapter, attestedSenderUserId: attested});
          } catch (error) {
            logWarning(logger, "Wild Path | Resolution socket handler failed", error);
          }
        }
      });
      registered = true;
      return {
        ok: true,
        code: MULTIPLAYER_AUTHORITY_CODES.OK,
        registered: true,
        handlerCount: handlers.size,
        namespace: socketNamespace
      };
    },
    async send(envelope) {
      const validation = validateResolutionSocketEnvelope(envelope);
      if ( !validation.ok ) return validation;
      // Fail closed: private or unclassified payloads never reach socket.emit, whatever their routing.
      const safe = assertBroadcastSafe(validation.envelope);
      if ( !safe.ok ) return {...safe, envelope: validation.envelope, namespace: socketNamespace};
      const foundryGame = resolveGame(game);
      const socket = foundryGame?.socket ?? null;
      if ( !socket || typeof socket.emit !== "function" ) return {
        ok: false,
        code: MULTIPLAYER_AUTHORITY_CODES.TRANSPORT_UNAVAILABLE,
        reason: "Foundry game.socket is not available.",
        envelope: validation.envelope
      };
      socket.emit(socketNamespace, clonePlainData(validation.envelope, "envelope"));
      return {
        ok: true,
        code: MULTIPLAYER_AUTHORITY_CODES.OK,
        envelope: validation.envelope,
        namespace: socketNamespace
      };
    },
    currentUser() {
      return foundryUserRef(resolveGame(game)?.user);
    },
    users() {
      const foundryGame = resolveGame(game);
      return foundryUserDirectory(foundryGame);
    },
    get registered() {
      return registered;
    },
    get handlerCount() {
      return handlers.size;
    }
  };
  return adapter;
}

/* -------------------------------------------- */

export function foundryUserDirectory(foundryGame=globalThis.game) {
  const users = foundryGame?.users ?? [];
  return normalizeAuthorityUsers(users, {
    activeGMUserId: users?.activeGM?.id ?? null
  });
}

export function foundryUserRef(user) {
  if ( !user ) return null;
  return {
    id: user.id ?? null,
    userRef: user.uuid ?? (user.id ? `User.${user.id}` : null),
    active: user.active === true,
    isGM: user.isGM === true,
    isActiveGM: user.isActiveGM === true,
    label: user.name ?? user.id ?? null
  };
}

function resolveGame(game) {
  return game ?? globalThis.game ?? null;
}

function logWarning(logger, ...args) {
  const target = logger ?? globalThis.console;
  if ( typeof target?.warn === "function" ) target.warn(...args);
}
