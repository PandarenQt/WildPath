import {createFoundryDigitalRollProvider} from "../adapters/foundry-digital-roll-provider.mjs";
import {createFoundryV14DocumentPersistenceAdapter} from "../adapters/foundry-v14-persistence-adapter.mjs";
import {createFoundryV14PromptAdapter} from "../adapters/foundry-v14-prompt-adapter.mjs";
import {
  createFoundryV14ResolutionSocketAdapter,
  foundryUserDirectory
} from "../adapters/foundry-v14-resolution-socket-adapter.mjs";
import {createFoundryV14TacticalGridAdapter} from "../adapters/foundry-v14-tactical-grid-adapter.mjs";
import {resolveFoundryMovementDocuments} from "../adapters/foundry-v14-movement-adapter.mjs";
import {
  MULTIPLAYER_AUTHORITY_CODES,
  clonePlainData
} from "../helpers/multiplayer-authority.mjs";
import {actionDefinitionFromAction} from "../helpers/action-definitions.mjs";
import {
  resolveActorAttackStatistic,
  resolveActorDefense
} from "../helpers/combat-statistics.mjs";
import {createMultiplayerActionCoordinator} from "./multiplayer-action-coordinator.mjs";
import {createMultiplayerMovementAuthority} from "./multiplayer-movement-authority.mjs";

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
  if ( game.wildpath?.multiplayer?.coordinator && game.wildpath?.movement ) return {
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
    }),
    notify: event => notifyMultiplayerFailure(event, {logger})
  });
  const registration = coordinator.register();
  const movement = createMultiplayerMovementAuthority({
    userId: game.user?.id ?? game.userId ?? null,
    users: () => foundryUserDirectory(game),
    activeGMUserId: () => game.users?.activeGM?.id ?? null,
    transport,
    game,
    persistencePort,
    allowLocalWithoutGM: true,
    canCommitLocally: ({intent, completion, userId}) => foundryCanCommitLocallyForMovement({
      intent,
      completion,
      userId,
      game
    }),
    notify: event => notifyMultiplayerMovementFailure(event, {logger})
  });
  const movementRegistration = movement.register();
  const runtime = {
    transport,
    coordinator,
    movement,
    registration,
    movementRegistration,
    declareActionIntent: intent => coordinator.declareActionIntent(intent),
    executeActionIntent: intent => coordinator.declareActionIntent(intent),
    requestMovementApproval: intent => movement.requestMovementApproval(intent),
    observeMovementCompletion: completion => movement.observeMovementCompletion(completion),
    commitMovementCompletion: completion => movement.commitMovementCompletion(completion)
  };
  game.wildpath = {
    ...(game.wildpath ?? {}),
    multiplayer: runtime,
    movement,
    resolutionTransport: transport,
    executeActionIntent: runtime.executeActionIntent
  };
  return {
    ok: registration.ok !== false && movementRegistration.ok !== false,
    code: registration.ok === false
      ? registration.code
      : (movementRegistration.code ?? registration.code ?? MULTIPLAYER_AUTHORITY_CODES.OK),
    reason: registration.reason ?? movementRegistration.reason ?? null,
    runtime,
    registration,
    movementRegistration
  };
}

/* -------------------------------------------- */

/**
 * Build the non-authoritative Action intent a Foundry client sends when a player uses an
 * Action Item. Only stable references and the client's own Foundry-native target selection
 * (`game.user.targets`) are included; the authoritative client reconstructs everything else.
 * @param {object} options
 * @param {Actor} options.actor
 * @param {Item} options.action
 * @param {Game} [options.game]
 * @returns {{ok: boolean, code?: string, reason?: string, intent?: object}}
 */
export function buildFoundryActionUseIntent({actor=null, action=null, game=globalThis.game}={}) {
  if ( !actor || !action ) return {
    ok: false,
    code: MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED,
    reason: "An Actor and an Action Item are required to build an Action intent."
  };
  const sourceToken = actor.token ?? null;
  return {
    ok: true,
    intent: {
      actorRef: actor.uuid ?? (actor.id ? `Actor.${actor.id}` : null),
      actionRef: action.uuid ?? (action.id ? `Item.${action.id}` : null),
      source: {
        tokenId: sourceToken?.id ?? null,
        tokenRef: sourceToken?.uuid ?? null,
        sceneId: sourceToken?.parent?.id ?? null
      },
      targetRefs: foundryUserTargetRefs(game)
    }
  };
}

function foundryUserTargetRefs(game=globalThis.game) {
  const targets = game?.user?.targets;
  if ( !targets || typeof targets.values !== "function" ) return [];
  const refs = [];
  for ( const placeable of targets.values() ) {
    const tokenDocument = placeable?.document ?? placeable;
    const targetActor = tokenDocument?.actor ?? null;
    if ( !targetActor ) continue;
    refs.push({
      actorRef: targetActor.uuid ?? null,
      actorId: targetActor.id ?? null,
      tokenId: tokenDocument.id ?? null,
      sceneId: tokenDocument.parent?.id ?? null
    });
  }
  return refs;
}

/**
 * Report a multiplayer resolution failure to the local user through Foundry's notification UI.
 * This is intentionally minimal - a full chat-card/result surface is a later product milestone.
 */
function notifyMultiplayerFailure(event={}, {logger=globalThis.console}={}) {
  if ( !event?.error ) return;
  const reason = event.error.reason ?? event.error.code ?? "Action resolution failed.";
  if ( typeof globalThis.ui?.notifications?.warn === "function" ) {
    globalThis.ui.notifications.warn(`Wild Path | ${reason}`);
  } else {
    logger?.warn?.("Wild Path | Multiplayer action resolution failed", event.error);
  }
}

function notifyMultiplayerMovementFailure(event={}, {logger=globalThis.console}={}) {
  const error = event.error ?? event.result ?? null;
  if ( !error ) return;
  const reason = error.reason ?? error.code ?? "Movement validation failed.";
  if ( typeof globalThis.ui?.notifications?.warn === "function" ) {
    globalThis.ui.notifications.warn(`Wild Path | ${reason}`);
  } else {
    logger?.warn?.("Wild Path | Multiplayer movement failed", error);
  }
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

  const combatStatistics = combatStatisticsForAction({actor, action});
  const defenseKey = combatStatistics.defenseKey;
  const targetActors = {};
  const targets = [];
  const targetEntries = [];
  for ( const ref of normalizeArray(intent.targetRefs ?? intent.targets) ) {
    const targetRef = targetActorRefFromIntent(ref);
    const targetActor = await resolveFoundryDocumentRef(targetRef, {game, kind: "actor"});
    if ( !targetActor ) continue;
    const target = withActorDefense({
      id: targetActor.id ?? targetRef,
      actorId: targetActor.id ?? null,
      actorRef: targetActor.uuid ?? targetRef,
      uuid: targetActor.uuid ?? null
    }, targetActor, defenseKey);
    targets.push(target);
    for ( const key of uniqueStrings([targetActor.uuid, targetActor.id, `actor:${targetActor.id}`, targetRef]) ) {
      targetActors[key] = targetActor;
    }
    targetEntries.push({
      actor: targetActor,
      hint: {
        tokenId: stringOrNull(typeof ref === "object" ? ref.tokenId : null),
        sceneId: stringOrNull(typeof ref === "object" ? ref.sceneId : null)
      }
    });
  }

  const sourceTokenResolution = resolveFoundrySourceToken({actor, source: intent.source ?? {}, game});
  if ( !sourceTokenResolution.ok ) return {
    ok: false,
    code: sourceTokenResolution.code,
    reason: sourceTokenResolution.reason
  };
  const sourceToken = sourceTokenResolution.token;

  const source = {
    actorId: actor.id ?? null,
    actorRef: actor.uuid ?? actorRef,
    uuid: actor.uuid ?? null,
    tokenId: sourceToken?.id ?? intent.source?.tokenId ?? intent.tokenId ?? null,
    tokenRef: sourceToken?.uuid ?? intent.source?.tokenRef ?? intent.tokenRef ?? null
  };

  const spatial = buildFoundryActionSpatialContext({sourceToken, targetEntries, game, defenseKey});

  return {
    ok: true,
    options: {
      actor,
      action,
      source,
      targets,
      targetActors,
      targeting: spatial?.targetFootprints.length ? {candidates: spatial.targetFootprints} : null,
      context: spatial ? {spatial: spatial.context} : {},
      ...(combatStatistics.attack ? {attack: combatStatistics.attack} : {}),
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

/**
 * Build WildPath TacticalGrid spatial context (source/target footprints) from real Foundry
 * Scene/Token data via the canonical Foundry V14 TacticalGrid adapter. Returns `null` when no
 * source Token/Scene can be resolved - non-spatial Actions must still be able to execute.
 */
function buildFoundryActionSpatialContext({sourceToken=null, targetEntries=[], game=globalThis.game, defenseKey=null}={}) {
  if ( !sourceToken?.parent ) return null;
  const adapter = createFoundryV14TacticalGridAdapter({scene: sourceToken.parent});
  const sceneContext = adapter.getSceneContext();
  if ( !sceneContext.ok ) return null;
  const sourceFootprintResult = adapter.tokenToFootprint(sourceToken);
  if ( !sourceFootprintResult.ok || !sourceFootprintResult.footprint ) return null;

  const targetFootprints = [];
  for ( const entry of targetEntries ) {
    const targetToken = resolveFoundryTargetToken({
      actor: entry.actor,
      hint: entry.hint,
      game,
      preferredSceneId: sourceToken.parent.id
    });
    if ( !targetToken || (targetToken.parent?.id ?? null) !== sourceToken.parent.id ) continue;
    const targetFootprintResult = adapter.tokenToTargetFootprint(targetToken, {
      disposition: foundryDispositionLabel(targetToken.disposition)
    });
    if ( targetFootprintResult.tokenFootprint ) {
      targetFootprints.push(withActorDefense(targetFootprintResult.tokenFootprint, entry.actor, defenseKey));
    }
  }

  return {
    targetFootprints,
    context: {
      sceneContext: sceneContext.context,
      gridDistance: sceneContext.context.grid.distance,
      sourceFootprint: sourceFootprintResult.footprint,
      targetFootprints
    }
  };
}

function combatStatisticsForAction({actor=null, action=null}={}) {
  const result = actionDefinitionFromAction(action, {actorSystem: actor?.system ?? null});
  const attackDefinition = result.ok ? result.definition?.attack ?? null : null;
  if ( !attackDefinition ) return {defenseKey: null, attack: null};
  const defenseKey = attackDefinition.defenseKey ?? "ac";
  const statistic = resolveActorAttackStatistic(actor, attackDefinition);
  return {
    defenseKey,
    attack: statistic ? {
      statistic,
      modifierTotal: statistic.totalModifier,
      modifiers: [{
        id: `statistic:${statistic.domain}`,
        value: statistic.totalModifier,
        source: statistic.source
      }]
    } : null
  };
}

function withActorDefense(value, actor, defenseKey) {
  if ( !value || !defenseKey ) return value;
  const defense = resolveActorDefense(actor, defenseKey);
  if ( !defense ) return value;
  const defenses = {
    ...(value.defenses ?? {}),
    [defenseKey]: defense
  };
  return {
    ...value,
    defense,
    defenses,
    target: value.target ? {
      ...value.target,
      defense,
      defenses: {
        ...(value.target.defenses ?? {}),
        [defenseKey]: defense
      }
    } : value.target,
    actor: value.actor ? {
      ...value.actor,
      defense,
      defenses: {
        ...(value.actor.defenses ?? {}),
        [defenseKey]: defense
      }
    } : value.actor
  };
}

function resolveFoundrySourceToken({actor, source={}, game=globalThis.game}={}) {
  if ( !actor ) return {ok: true, token: null};
  const hinted = resolveHintedFoundryToken({actor, hint: source, game});
  if ( hinted ) return {ok: true, token: hinted};
  if ( actor.token ) return {ok: true, token: actor.token};
  const active = activeFoundryTokensForActor(actor);
  if ( !active.length ) return {ok: true, token: null};
  if ( active.length === 1 ) return {ok: true, token: active[0]};
  return {
    ok: false,
    code: MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED,
    reason: "Actor has more than one canvas Token; a specific source Token reference is required."
  };
}

function resolveFoundryTargetToken({actor, hint={}, game=globalThis.game, preferredSceneId=null}={}) {
  if ( !actor ) return null;
  const hinted = resolveHintedFoundryToken({actor, hint, game});
  if ( hinted ) return hinted;
  if ( actor.token ) return actor.token;
  const active = activeFoundryTokensForActor(actor);
  if ( !active.length ) return null;
  if ( preferredSceneId ) {
    const sameScene = active.find(token => (token.parent?.id ?? null) === preferredSceneId);
    if ( sameScene ) return sameScene;
  }
  return active[0];
}

function resolveHintedFoundryToken({actor, hint={}, game=globalThis.game}={}) {
  const tokenId = stringOrNull(hint.tokenId);
  if ( !tokenId ) return null;
  const sceneId = stringOrNull(hint.sceneId);
  const scene = sceneId
    ? (game?.scenes?.get?.(sceneId) ?? collectionContents(game?.scenes).find(candidate => candidate?.id === sceneId))
    : (actor?.token?.parent ?? game?.scenes?.viewed ?? game?.canvas?.scene ?? null);
  const token = scene?.tokens?.get?.(tokenId) ?? collectionContents(scene?.tokens).find(candidate => candidate?.id === tokenId);
  return (token && tokenBelongsToActor(token, actor)) ? token : null;
}

function tokenBelongsToActor(token, actor) {
  if ( !token || !actor ) return false;
  const tokenActorId = token.actor?.id ?? token.actorId ?? null;
  return (tokenActorId != null) && (tokenActorId === actor.id);
}

function activeFoundryTokensForActor(actor) {
  if ( typeof actor.getActiveTokens !== "function" ) return [];
  try {
    const tokens = actor.getActiveTokens(false, true);
    return Array.isArray(tokens) ? tokens.filter(Boolean) : collectionContents(tokens);
  } catch {
    return [];
  }
}

function foundryDispositionLabel(disposition) {
  const dispositions = globalThis.CONST?.TOKEN_DISPOSITIONS ?? {};
  if ( disposition === dispositions.HOSTILE ) return "enemy";
  if ( disposition === dispositions.FRIENDLY ) return "friendly";
  if ( disposition === dispositions.NEUTRAL ) return "neutral";
  return "unknown";
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

export async function foundryCanCommitLocallyForMovement({intent=null, completion=null, userId=null, game=globalThis.game}={}) {
  if ( game?.user?.isGM === true ) return true;
  const movement = intent ?? completion ?? {};
  const resolved = await resolveFoundryMovementDocuments({intent: movement, game});
  if ( !resolved.ok ) return false;
  const user = userById(game?.users, userId);
  return documentOwnedByUser(resolved.token, user) || documentOwnedByUser(resolved.actor, user);
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
