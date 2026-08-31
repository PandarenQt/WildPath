import {createFoundryDigitalRollProvider} from "../adapters/foundry-digital-roll-provider.mjs";
import {createFoundryV14DocumentPersistenceAdapter} from "../adapters/foundry-v14-persistence-adapter.mjs";
import {createFoundryV14PromptAdapter} from "../adapters/foundry-v14-prompt-adapter.mjs";
import {
  createFoundryV14ResolutionSocketAdapter,
  foundryUserDirectory
} from "../adapters/foundry-v14-resolution-socket-adapter.mjs";
import {
  MULTIPLAYER_AUTHORITY_CODES,
  clonePlainData
} from "../helpers/multiplayer-authority.mjs";
import {createMultiplayerActionCoordinator} from "./multiplayer-action-coordinator.mjs";

export function registerFoundryV14MultiplayerResolution({
  game=globalThis.game,
  systemId="wildpath",
  logger=globalThis.console
}={}) {
  if ( !game ) return {
    ok: false,
    code: MULTIPLAYER_AUTHORITY_CODES.TRANSPORT_UNAVAILABLE,
    reason: "Foundry game is not available."
  };
  if ( game.wildpath?.multiplayer?.coordinator ) return {
    ok: true,
    code: MULTIPLAYER_AUTHORITY_CODES.OK,
    runtime: game.wildpath.multiplayer,
    reused: true
  };

  const persistencePort = createFoundryV14DocumentPersistenceAdapter();
  const transport = createFoundryV14ResolutionSocketAdapter({game, systemId, logger});
  const coordinator = createMultiplayerActionCoordinator({
    userId: game.user?.id ?? game.userId ?? null,
    users: () => foundryUserDirectory(game),
    activeGMUserId: () => game.users?.activeGM?.id ?? null,
    transport,
    promptPorts: [createFoundryV14PromptAdapter()],
    rollProviders: [createFoundryDigitalRollProvider()],
    actionIntentResolver: ({intent}) => foundryActionIntentToStagedOptions({
      intent,
      game,
      persistencePort
    }),
    allowLocalWithoutGM: true,
    canCommitLocally: ({intent, userId}) => foundryCanCommitLocallyForIntent({
      intent,
      userId,
      game
    })
  });
  const registration = coordinator.register();
  const runtime = {
    transport,
    coordinator,
    registration,
    declareActionIntent: intent => coordinator.declareActionIntent(intent),
    executeActionIntent: intent => coordinator.declareActionIntent(intent)
  };
  game.wildpath = {
    ...(game.wildpath ?? {}),
    multiplayer: runtime,
    resolutionTransport: transport,
    executeActionIntent: runtime.executeActionIntent
  };
  return {
    ok: registration.ok !== false,
    code: registration.code ?? MULTIPLAYER_AUTHORITY_CODES.OK,
    reason: registration.reason ?? null,
    runtime,
    registration
  };
}

/* -------------------------------------------- */

export async function foundryActionIntentToStagedOptions({intent={}, game=globalThis.game, persistencePort=null}={}) {
  const actorRef = intent.actorRef ?? intent.actorUuid ?? intent.source?.actorRef ?? intent.source?.uuid ?? null;
  const actor = await resolveFoundryDocumentRef(actorRef, {game, kind: "actor"});
  if ( !actor ) return {
    ok: false,
    code: MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED,
    reason: "Action intent actorRef could not be resolved."
  };

  const action = await resolveFoundryAction(intent.actionRef ?? intent.actionUuid ?? intent.itemRef ?? intent.itemId, actor, {game});
  if ( !action ) return {
    ok: false,
    code: MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED,
    reason: "Action intent actionRef could not be resolved."
  };

  const targetActors = {};
  const targets = [];
  for ( const ref of normalizeArray(intent.targetRefs ?? intent.targets) ) {
    const targetRef = targetActorRefFromIntent(ref);
    const targetActor = await resolveFoundryDocumentRef(targetRef, {game, kind: "actor"});
    if ( !targetActor ) continue;
    const target = {
      id: targetActor.id ?? targetRef,
      actorId: targetActor.id ?? null,
      actorRef: targetActor.uuid ?? targetRef,
      uuid: targetActor.uuid ?? null
    };
    targets.push(target);
    for ( const key of uniqueStrings([targetActor.uuid, targetActor.id, `actor:${targetActor.id}`, targetRef]) ) {
      targetActors[key] = targetActor;
    }
  }

  const source = {
    actorId: actor.id ?? null,
    actorRef: actor.uuid ?? actorRef,
    uuid: actor.uuid ?? null,
    tokenId: intent.source?.tokenId ?? intent.tokenId ?? null,
    tokenRef: intent.source?.tokenRef ?? intent.tokenRef ?? null
  };

  return {
    ok: true,
    options: {
      actor,
      action,
      source,
      targets,
      targetActors,
      durability: true,
      configuration: clonePlainData(intent.configuration ?? null, "intent.configuration"),
      persistencePort
    },
    requestContext: {
      sourceControllerUserIds: ownerUserIdsForDocument(actor, {game}),
      targetControllerUserIdsByTargetRef: Object.fromEntries(targets.map(target => [
        target.actorRef ?? target.actorId,
        ownerUserIdsForDocument(targetActors[target.actorRef] ?? targetActors[target.actorId], {game})
      ]))
    }
  };
}

/* -------------------------------------------- */

export async function foundryCanCommitLocallyForIntent({intent={}, userId=null, game=globalThis.game}={}) {
  if ( game?.user?.isGM === true ) return true;
  const actor = await resolveFoundryDocumentRef(intent.actorRef ?? intent.actorUuid ?? intent.source?.actorRef ?? null, {game, kind: "actor"});
  if ( !actor || !userId ) return false;
  const user = userById(game?.users, userId);
  if ( !documentOwnedByUser(actor, user) ) return false;
  for ( const ref of normalizeArray(intent.targetRefs ?? intent.targets) ) {
    const targetActor = await resolveFoundryDocumentRef(targetActorRefFromIntent(ref), {game, kind: "actor"});
    if ( targetActor && !documentOwnedByUser(targetActor, user) ) return false;
  }
  return true;
}

async function resolveFoundryAction(ref, actor, {game=globalThis.game}={}) {
  const value = ref && await resolveFoundryDocumentRef(ref, {game, kind: "item"});
  if ( value ) return value;
  const id = stringOrNull(ref)?.replace(/^Item[.]/, "") ?? null;
  if ( !id ) return null;
  return actor?.items?.get?.(id)
    ?? collectionContents(actor?.items).find(item => item?.id === id || item?.uuid === ref)
    ?? null;
}

async function resolveFoundryDocumentRef(ref, {game=globalThis.game, kind="document"}={}) {
  const value = stringOrNull(ref);
  if ( !value ) return null;
  if ( typeof globalThis.fromUuid === "function" && /^[A-Z][A-Za-z]+[.]/.test(value) ) {
    const document = await globalThis.fromUuid(value);
    if ( document ) return document;
  }
  const id = value.replace(/^Actor[.]/, "").replace(/^Item[.]/, "").replace(/^actor:/, "").replace(/^item:/, "");
  if ( kind === "actor" ) return game?.actors?.get?.(id)
    ?? collectionContents(game?.actors).find(actor => actor?.id === id || actor?.uuid === value)
    ?? null;
  if ( kind === "item" ) return game?.items?.get?.(id)
    ?? collectionContents(game?.items).find(item => item?.id === id || item?.uuid === value)
    ?? null;
  return null;
}

function ownerUserIdsForDocument(document, {game=globalThis.game}={}) {
  return collectionContents(game?.users)
    .filter(user => user && user.isGM !== true && documentOwnedByUser(document, user))
    .map(user => user.id)
    .filter(Boolean);
}

function documentOwnedByUser(document, user) {
  if ( !document || !user ) return false;
  if ( user.isGM === true ) return true;
  if ( typeof document.testUserPermission === "function" ) {
    return document.testUserPermission(user, "OWNER") === true;
  }
  return document.isOwner === true;
}

function userById(users, userId) {
  const id = stringOrNull(userId);
  return collectionContents(users).find(user => String(user?.id) === id) ?? null;
}

function targetActorRefFromIntent(value) {
  if ( typeof value === "string" ) return value;
  return value?.actorRef ?? value?.uuid ?? value?.actorUuid ?? value?.actorId ?? value?.id ?? null;
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
