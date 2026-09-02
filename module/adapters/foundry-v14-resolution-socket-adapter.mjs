import {
  MULTIPLAYER_AUTHORITY_CODES,
  clonePlainData,
  normalizeAuthorityUsers,
  recipientMatchesEnvelope,
  validateResolutionSocketEnvelope
} from "../helpers/multiplayer-authority.mjs";

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
      socket.on(socketNamespace, async envelope => {
        const validation = validateResolutionSocketEnvelope(envelope);
        if ( !validation.ok ) {
          logWarning(logger, "Wild Path | Rejected invalid resolution socket envelope", validation);
          return;
        }
        const currentUserId = foundryGame?.user?.id ?? foundryGame?.userId ?? null;
        if ( !recipientMatchesEnvelope(validation.envelope, currentUserId) ) return;
        for ( const handler of handlers ) {
          try {
            await handler(validation.envelope, {transport: adapter});
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
