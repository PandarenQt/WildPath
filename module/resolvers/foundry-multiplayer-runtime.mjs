import {WILDPATH} from "../config.mjs";
import {createFoundryDigitalRollProvider} from "../adapters/foundry-digital-roll-provider.mjs";
import {createFoundryV14DocumentPersistenceAdapter} from "../adapters/foundry-v14-persistence-adapter.mjs";
import {closeFoundryPrompt, createFoundryV14PromptAdapter} from "../adapters/foundry-v14-prompt-adapter.mjs";
import {foundryActorSystemSnapshot} from "../adapters/foundry-v14-actor-system-adapter.mjs";
import {
  createFoundryV14ResolutionSocketAdapter,
  foundryUserDirectory
} from "../adapters/foundry-v14-resolution-socket-adapter.mjs";
import {createFoundryV14TacticalGridAdapter} from "../adapters/foundry-v14-tactical-grid-adapter.mjs";
import {createFoundryV14UserQueryTransport} from "../adapters/foundry-v14-user-query-transport.mjs";
import {createDisclosureRoutedTransport} from "../adapters/disclosure-routed-transport.mjs";
import {createFoundryV14ChatCardAdapter} from "../adapters/foundry-v14-chat-card-adapter.mjs";
import {createFoundryReactionProvider} from "../adapters/foundry-v14-reaction-provider.mjs";
import {foundryActionReactionServices} from "../adapters/foundry-v14-reaction-services.mjs";
import {foundryAreaFootprint, foundryAreaTargetTokens} from "../adapters/foundry-v14-area-placement.mjs";
import {createFoundryPersistentAreas, turnKey} from "../adapters/foundry-v14-persistent-areas.mjs";
import {createFoundryAuras} from "../adapters/foundry-v14-auras.mjs";
import {AUTOMATION_QUERY, createFoundryAutomationDispatcher} from "../adapters/foundry-v14-automation-dispatcher.mjs";
import {COMPANION_QUERY, createFoundryCompanions} from "../adapters/foundry-v14-companions.mjs";
import {createFoundryDying} from "../adapters/foundry-v14-dying.mjs";
import {createFoundrySummons} from "../adapters/foundry-v14-summons.mjs";
import {
  buildFoundryMovementCompletion,
  buildFoundryMovementProgressObservation,
  FOUNDRY_MOVEMENT_CODES,
  resolveFoundryMovementDocuments
} from "../adapters/foundry-v14-movement-adapter.mjs";
import {
  MULTIPLAYER_AUTHORITY_CODES,
  clonePlainData
} from "../helpers/multiplayer-authority.mjs";
import {actionDefinitionActivationCost, actionDefinitionFromAction, actionDefinitionToResolverInput} from "../helpers/action-definitions.mjs";
import {tokenRef} from "../helpers/entity-refs.mjs";
import {footprintDistance} from "../helpers/grid-footprints.mjs";
import {combineRollModes, d20Chance} from "../helpers/rolls.mjs";
import {collectRuleElementContributions} from "../helpers/rule-elements.mjs";
import {commonAction, commonActionId} from "../helpers/common-actions.mjs";
import {
  actionCombatStatistics,
  resolveActorCheckStatistic,
  resolveActorSaveStatistic,
  resolveActorDefense
} from "../helpers/combat-statistics.mjs";
import {createMultiplayerActionCoordinator} from "./multiplayer-action-coordinator.mjs";
import {createPhysicalDiceProvider} from "./roll-provider-resolver.mjs";
import {createMultiplayerMovementAuthority} from "./multiplayer-movement-authority.mjs";
import {createFoundryV14ReactionPauseAdapter} from "../adapters/foundry-v14-reaction-pause-adapter.mjs";
import {foundryMovementIntentToStagedOptions} from "../adapters/foundry-v14-staged-movement-adapter.mjs";

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
  const localUserId = game.user?.id ?? game.userId ?? null;
  // Disclosure-routed transport: BROADCAST_SAFE envelopes use the system socket, private envelopes
  // use User#query, self-addressed envelopes are delivered locally. Unclassified data fails closed.
  const broadcast = createFoundryV14ResolutionSocketAdapter({game, systemId, logger});
  const targeted = createFoundryV14UserQueryTransport({game, systemId, logger});
  const transport = createDisclosureRoutedTransport({
    userId: localUserId,
    broadcast,
    targeted,
    users: () => foundryUserDirectory(game),
    logger
  });
  if ( typeof game.user?.hasPermission === "function" && game.user.hasPermission("QUERY_USER") === false ) {
    (logger ?? console).warn("Wild Path | This user lacks the QUERY_USER permission; private multiplayer replies "
      + "(prompt answers, roll results) cannot be sent from this client and will fail closed.");
  }
  const coordinator = createMultiplayerActionCoordinator({
    userId: game.user?.id ?? game.userId ?? null,
    users: () => foundryUserDirectory(game),
    activeGMUserId: () => game.users?.activeGM?.id ?? null,
    transport,
    promptPorts: [createFoundryV14PromptAdapter()],
    rollProviders: [createFoundryDigitalRollProvider(), createPhysicalDiceProvider()],
    rollContext: dicePolicyRollContext(game),
    actionIntentResolver: ({intent, envelope}) => intent.resolutionKind === "movement"
      ? foundryMovementIntentToStagedOptions({intent, resolutionId: envelope.resolutionId,
        senderUserId: envelope.senderUserId, game, persistencePort})
      : foundryActionIntentToStagedOptions({
      intent,
      senderUserId: envelope.senderUserId,
      game,
      persistencePort
    }),
    allowLocalWithoutGM: true,
    canCommitLocally: ({intent, userId}) => foundryCanCommitLocallyForIntent({
      intent,
      userId,
      game
    }),
    notify: event => notifyMultiplayerFailure(event, {logger}),
    publishResult: createFoundryV14ChatCardAdapter({game}),
    afterCompleted: async event => {
      await areas.create(event);
      await areas.afterResolution(event);
      await dying.afterResolution(event);
      await applyActionTransformation(event, {logger});
      await summons.afterResolution(event);
    },
    logger
  });
  const registration = coordinator.register();
  // Lasting areas: Regions created by completed area Actions, whose triggers resolve as authority Actions.
  const areas = createFoundryPersistentAreas({game, coordinator, logger, fromUuid: globalThis.fromUuid ?? null,
    resolveAction: options => foundryActionIntentToStagedOptions({...options, game, persistencePort})});
  // A Player who disconnects mid-resolution cannot answer; the authority routes their requests again (GM fallback).
  globalThis.Hooks?.on?.("userConnected", (user, connected) => {
    if ( !connected && (game.users?.activeGM?.id === game.user?.id) ) void coordinator.releaseRequestsOf(user.id);
  });
  globalThis.Hooks?.on?.("deleteActiveEffect", effect => areas.onEffectDeleted(effect));
  // Auras: statistics read for rolls and defenses ask which auras surround a creature.
  game.wildpath = {...(game.wildpath ?? {}), auras: createFoundryAuras()};
  // V14 tracks an unlinked Token's effects for expiry only once its delta materializes, so after a reload a buff on
  // such a creature would never expire. The active GM registers them for the viewed Scene and every combat's Scene.
  const trackTokenEffects = () => {
    if ( game.users?.activeGM?.id !== game.user?.id ) return;
    const registry = globalThis.foundry?.documents?.ActiveEffect?.registry;
    const scenes = new Set([game.scenes?.viewed, ...(game.combats?.contents ?? []).map(combat => combat.scene)].filter(Boolean));
    for ( const scene of scenes ) for ( const token of scene.tokens ) if ( !token.actorLink && token.actor ) registry?.addFromParent(token.actor);
  };
  globalThis.Hooks?.on?.("canvasReady", trackTokenEffects);
  globalThis.Hooks?.on?.("combatStart", trackTokenEffects);
  trackTokenEffects();
  // V14 marks an effect expired when its duration runs out; an Action's custom effect (a buff) is then removed.
  globalThis.Hooks?.on?.("updateActiveEffect", (effect, changes) => {
    if ( (changes?.duration?.expired === true) && effect.flags?.wildpath?.conditionEffect?.definition?.custom
      && (game.users?.activeGM?.id === game.user?.id) ) void effect.delete();
  });
  globalThis.Hooks?.on?.("deleteRegion", region => areas.onRegionDeleted(region));
  // Items' and effects' automatic triggers: turns and rests reach them from Combat and Actor#rest.
  const automation = createFoundryAutomationDispatcher({game, coordinator, logger, fromUuid: globalThis.fromUuid ?? null,
    resolveAction: options => foundryActionIntentToStagedOptions({...options, game, persistencePort})});
  if ( globalThis.CONFIG?.queries ) globalThis.CONFIG.queries[AUTOMATION_QUERY] = automation.handleQuery;
  // Dying and death (2024 death saves): after Actions, at turn start, and when Exhaustion reaches 6.
  const dying = createFoundryDying({game, coordinator, logger,
    resolveAction: options => foundryActionIntentToStagedOptions({...options, game, persistencePort})});
  globalThis.Hooks?.on?.("createActiveEffect", effect => void dying.onEffectChanged(effect));
  // 2024: a stable creature regains 1 health after 1d4 hours; world time moving on (or a rest, Actor#rest) counts.
  globalThis.Hooks?.on?.("updateWorldTime", worldTime => void dying.onWorldTime(worldTime)
    .catch(error => logger?.warn?.("Wild Path | Stable recovery failed", error)));
  game.wildpath = {...(game.wildpath ?? {}), dying};
  // 2024: an Incapacitated creature's concentration ends; everything it sustains ends with it (active GM).
  globalThis.Hooks?.on?.("createActiveEffect", effect => void endConcentrationOnIncapacitation(effect, game)
    .catch(error => logger?.warn?.("Wild Path | Ending concentration failed", error)));
  globalThis.Hooks?.on?.("updateActiveEffect", effect => void dying.onEffectChanged(effect));
  // Shared control of companions and summons: ownership follows their controllers (only a GM may change it).
  const companions = createFoundryCompanions({game, fromUuid: globalThis.fromUuid ?? (() => null)});
  if ( globalThis.CONFIG?.queries ) globalThis.CONFIG.queries[COMPANION_QUERY] = companions.handleQuery;
  // Summoned creatures: placed by the GM, controlled by their caster, gone with its concentration or rounds.
  const summons = createFoundrySummons({game, companions, logger, fromUuid: globalThis.fromUuid ?? (() => null)});
  globalThis.Hooks?.on?.("deleteActiveEffect", effect => void summons.onEffectDeleted(effect));
  // Whoever rolls, every client sees the Combatant update; the active GM dispatches it.
  globalThis.Hooks?.on?.("updateCombatant", (combatant, changed) => {
    if ( !Number.isFinite(changed?.initiative) ) return;
    void automation.dispatch("initiative.rolled", {actor: combatant.actor, token: combatant.token,
      data: {initiative: changed.initiative}}).catch(error => logger?.warn?.("Wild Path | initiative.rolled automation failed", error));
  });
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
    notify: event => notifyMultiplayerMovementFailure(event, {logger}),
    logger,
    actionCoordinator: coordinator,
    areas,
    reactionPauseAdapter: createFoundryV14ReactionPauseAdapter(),
    reactionServices: context => typeof game.wildpath?.reactionServices === "function"
      ? game.wildpath.reactionServices(context) : {},
    onAutomationEvent: event => globalThis.Hooks.callAll("wildpath.automationEvent", event)
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
    executeMovementIntent: intent => coordinator.declareActionIntent({...intent, resolutionKind: "movement"}),
    requestMovementApproval: intent => movement.requestMovementApproval(intent),
    observeMovementCompletion: (completion, options={}) => movement.observeMovementCompletion(completion, options),
    observeMovementProgress: (observation, options={}) => movement.observeMovementProgress(observation, options),
    commitMovementCompletion: completion => movement.commitMovementCompletion(completion)
  };
  game.wildpath = {
    ...(game.wildpath ?? {}),
    // Production reactions come from the world's Trigger RuleElements; a supplied provider still wins.
    reactionServices: game.wildpath?.reactionServices ?? createFoundryReactionProvider(),
    multiplayer: runtime,
    movement,
    areas,
    automation,
    companions,
    dying,
    summons,
    resolutionTransport: transport,
    executeActionIntent: runtime.executeActionIntent,
    executeMovementIntent: runtime.executeMovementIntent
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
 * Observe Foundry's post-update Token movement hook and route verified progress to the existing
 * WildPath movement authority. The hook's source snapshot survives later Token updates while the
 * authority queue runs. Documents are not stored in authority records or socket payloads.
 * @param {object} document
 * @param {object} movement
 * @param {object} operation
 * @param {object} user
 * @param {object} options
 * @returns {Promise<object>}
 */
export function onFoundryV14MoveToken(document, movement, operation={}, user=null, {
  game=globalThis.game,
  logger=globalThis.console
}={}) {
  // Only the authenticated active GM can publish the final position of a staged transaction.
  // The local pre-update bypass separately requires an in-flight registered document write.
  if ( operation.wildpathStagedMovement && user?.isGM && user.id === game?.users?.activeGM?.id ) {
    return Promise.resolve({ok: true, ignored: true, reason: "Position belongs to a staged movement transaction."});
  }
  // Hooks are synchronous. Establish the initiator's hold before any observation awaits.
  if ( (user?.id ?? movement?.user?.id) === (game?.user?.id ?? game?.userId) ) {
    movementRuntime(game)?.pauseReactionBoundary?.(document, movement.id);
  }
  return observeFoundryV14MoveToken(document, movement, operation, user, {game, logger})
    .catch(error => {
      const result = {
        ok: false,
        code: FOUNDRY_MOVEMENT_CODES.MOVEMENT_COMMIT_FAILED,
        reason: error?.message ?? String(error)
      };
      notifyMovementHookFailure(result, {logger});
      return result;
    });
}

async function observeFoundryV14MoveToken(document, movement, operation={}, user=null, {
  game=globalThis.game,
  logger=globalThis.console
}={}) {
  // Capture source data before yielding: another linked checkpoint can update the Token
  // while this observation waits for authority or persistence. Pending waypoints are plans.
  const currentMovement = document?.movement;
  if ( currentMovement?.id === movement?.id && currentMovement?.state === "stopped" ) {
    return observeFoundryMovementPrefix(document, currentMovement, user, "stopToken", "interrupted", {game, logger});
  }
  if ( movement?.passed?.waypoints?.length && movement?.pending?.waypoints?.length ) {
    return observeFoundryMovementPrefix(document, movement, user, "moveToken", "moving", {game, logger});
  }
  const completion = buildFoundryMovementCompletion({
    tokenDocument: document, movement, operation, user, game,
    foundryLifecycle: "moveToken", captureSource: true
  });
  const finished = await movementFinished(movement);
  if ( finished !== true ) {
    // A later stop has its own synchronous hook snapshot. Do not pair this operation
    // with document.movement or source values read after the whole-chain Promise settles.
    return {
      ok: false, code: FOUNDRY_MOVEMENT_CODES.MOVEMENT_OBSERVATION_AMBIGUOUS,
      ignored: true, reason: "Movement completion alone does not establish a completed prefix or interruption."
    };
  }

  const runtime = movementRuntime(game);
  if ( !runtime || typeof runtime.observeMovementCompletion !== "function" ) {
    const result = {
      ok: false,
      code: MULTIPLAYER_AUTHORITY_CODES.AUTHORITY_UNAVAILABLE,
      reason: "WildPath movement authority is not available for completion observation."
    };
    notifyMovementHookFailure(result, {logger});
    return result;
  }

  if ( !completion.ok ) {
    notifyMovementHookFailure(completion, {logger});
    return completion;
  }

  const observed = await runtime.observeMovementCompletion(completion.completion, {
    tokenDocument: document, sourcePosition: completion.sourcePosition
  });
  if ( observed?.ok === false ) notifyMovementHookFailure(observed, {logger});
  return observed;
}

/** Public V14 lifecycle snapshots prove the passed section even when stop clears pending. */
export function onFoundryV14PauseToken(document, options={}) {
  const movement = document?.movement;
  return observeFoundryMovementPrefix(document, movement, movement?.user,
    "pauseToken", "paused", options);
}

export function onFoundryV14StopToken(document, options={}) {
  const movement = document?.movement;
  return observeFoundryMovementPrefix(document, movement, movement?.user,
    "stopToken", "interrupted", options);
}

async function observeFoundryMovementPrefix(document, movement, user, lifecycle, status, {
  game=globalThis.game, logger=globalThis.console
}={}) {
  try {
    const built = buildFoundryMovementProgressObservation({tokenDocument: document, movement, user, game, lifecycle, status});
    if ( !built.ok ) { notifyMovementHookFailure(built, {logger}); return built; }
    const runtime = movementRuntime(game);
    if ( typeof runtime?.observeMovementProgress !== "function" ) return {
      ok: false, code: MULTIPLAYER_AUTHORITY_CODES.AUTHORITY_UNAVAILABLE,
      reason: "WildPath movement authority is not available for progress observation."
    };
    const result = await runtime.observeMovementProgress(built.completion, {
      tokenDocument: document, sourcePosition: built.sourcePosition
    });
    if ( result?.ok === false ) notifyMovementHookFailure(result, {logger});
    return result;
  } catch (error) {
    const result = {ok: false, code: FOUNDRY_MOVEMENT_CODES.MOVEMENT_COMMIT_FAILED,
      reason: error?.message ?? String(error)};
    notifyMovementHookFailure(result, {logger});
    return result;
  }
}

function movementRuntime(game=globalThis.game) {
  return game?.wildpath?.movement
    ?? game?.wildpath?.multiplayer?.movement
    ?? null;
}

async function movementFinished(movement) {
  if ( movement?.finished == null ) return false;
  try {
    return await Promise.resolve(movement.finished);
  } catch {
    return false;
  }
}

function notifyMovementHookFailure(result={}, {logger=globalThis.console}={}) {
  const reason = result.reason ?? result.code ?? "Movement budget commit failed.";
  if ( typeof globalThis.ui?.notifications?.warn === "function" ) {
    globalThis.ui.notifications.warn(`Wild Path | ${reason}`);
  } else {
    logger?.warn?.("Wild Path | Movement completion observation failed", result);
  }
}

/* -------------------------------------------- */

export const DICE_POLICY_PROVIDERS = Object.freeze({digital: "foundry-digital", physical: "physical-dice"});

/**
 * The GM's `wildpath.dicePolicy` picks the RollProvider on the rolling client. A getter, because the
 * coordinator spreads this context per roll: a changed policy applies to the next roll without a reload.
 * The physical provider asks for the dice through the roll prompt.
 */
export function dicePolicyRollContext(game=globalThis.game) {
  const setting = (namespace, key) => {
    try { return game?.settings?.get?.(namespace, key) ?? null; }
    catch { return null; } // unregistered (before init, or a test game)
  };
  return {
    get providerId() {
      return DICE_POLICY_PROVIDERS[setting("wildpath", "dicePolicy")] ?? null;
    },
    /** The roller's own message mode, for rolls whose request leaves visibility to the roller (saves). */
    get messageMode() {
      return setting("core", "messageMode");
    }
  };
}

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
      targetRefs: foundryUserTargetRefs(game),
      // The initiator's chat visibility (V14 `core.messageMode`; `core.rollMode` is a deprecated shim).
      messageMode: game?.settings?.get?.("core", "messageMode") ?? null
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
const ROLL_REJECTION_CODES = new Set(["INVALID_MANUAL_RESULT", "INVALID_ROLL_RESULT"]);

function notifyMultiplayerFailure(event={}, {logger=globalThis.console}={}) {
  if ( !event?.error ) return;
  // The GM answered a request this user had open: withdraw its prompt and say so, as news rather than a failure.
  if ( event.error.code === MULTIPLAYER_AUTHORITY_CODES.REQUEST_ANSWERED_BY_GM ) {
    closeFoundryPrompt({resolutionId: event.envelope?.resolutionId ?? null, requestId: event.envelope?.requestId ?? null});
    globalThis.ui?.notifications?.info?.(globalThis.game?.i18n?.localize?.("WILDPATH.NOTIFY.AnsweredByGM") ?? "");
    return;
  }
  const reason = event.error.reason ?? event.error.code ?? "";
  if ( typeof globalThis.ui?.notifications?.warn === "function" ) {
    const i18n = globalThis.game?.i18n;
    // An unaffordable cost (spent Actions, or a condition that leaves none) reads as plain words, not a code.
    const message = ROLL_REJECTION_CODES.has(event.error.code) ? i18n?.localize?.("WILDPATH.NOTIFY.RollRejected")
      : reason === "PAYMENT_UNAVAILABLE" ? i18n?.localize?.("WILDPATH.NOTIFY.PaymentUnavailable")
        : i18n?.format?.("WILDPATH.NOTIFY.ActionFailed", {reason});
    globalThis.ui.notifications.warn(message ?? `Wild Path | ${reason}`);
  } else {
    logger?.warn?.("Wild Path | Multiplayer action resolution failed", event.error);
  }
}

function notifyMultiplayerMovementFailure(event={}, {logger=globalThis.console}={}) {
  if ( event.type === "movementStoppedByArea" ) {
    globalThis.ui?.notifications?.info?.(globalThis.game?.i18n?.format?.("WILDPATH.NOTIFY.MovementStoppedByArea", {area: event.area})
      ?? `Wild Path | Stopped in ${event.area}`);
    return;
  }
  const error = event.error ?? event.result ?? null;
  if ( !error ) return;
  const reason = error.reason ?? error.code ?? "";
  if ( typeof globalThis.ui?.notifications?.warn === "function" ) {
    const message = globalThis.game?.i18n?.format?.("WILDPATH.NOTIFY.MovementFailed", {reason});
    globalThis.ui.notifications.warn(message ?? `Wild Path | ${reason}`);
  } else {
    logger?.warn?.("Wild Path | Multiplayer movement failed", error);
  }
}

/* -------------------------------------------- */

/**
 * `action` is for the authority's own Actions only (a lasting area's inline effect): it replaces the Item
 * lookup and is never reachable from a socket intent.
 */
/** The acting creature's own check: its bonus, and its advantage or disadvantage on the same domains. */
function actionCheckInput(actor, {ability=null, skill=null}={}) {
  const bonus = resolveActorCheckStatistic(actor, {ability, skill});
  const domains = ["check", ability ? `check.${ability}` : null, skill ? `check.${skill}` : null].filter(Boolean);
  return {...(bonus ? {modifier: bonus.totalModifier} : {}),
    rollMode: combineRollModes(actor.getRollModes?.(domains, {context: {check: {ability, skill}}}) ?? [])};
}

export async function foundryActionIntentToStagedOptions({intent={}, senderUserId=null, game=globalThis.game, persistencePort=null,
  action: authorityAction=null}={}) {
  const actorRef = intent.actorRef ?? intent.actorUuid ?? intent.source?.actorRef ?? intent.source?.uuid ?? null;
  const actor = await resolveFoundryDocumentRef(actorRef, {game, kind: "actor"});
  if ( !actor ) return {
    ok: false,
    code: MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED,
    reason: "Action intent actorRef could not be resolved."
  };
  // The envelope sender is server-attested; a player may only act through Actors they own.
  const sender = userById(game?.users, senderUserId);
  if ( !documentOwnedByUser(actor, sender) ) return {
    ok: false,
    code: MULTIPLAYER_AUTHORITY_CODES.WRONG_USER,
    reason: "The Action sender must own the acting Actor."
  };

  const action = authorityAction
    ?? await resolveFoundryAction(intent.actionRef ?? intent.actionUuid ?? intent.itemRef ?? intent.itemId, actor, {game});
  if ( !action ) return {
    ok: false,
    code: MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED,
    reason: "Action intent actionRef could not be resolved."
  };
  // Compare by uuid: synthetic Token Actors may resolve to different instances of the same Actor.
  if ( !authorityAction && (!action.actor?.uuid || action.actor.uuid !== actor.uuid) ) return {
    ok: false,
    code: MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED,
    reason: "The Action Item does not belong to the acting Actor."
  };

  let actorSystem;
  try { actorSystem = foundryActorSystemSnapshot(actor); }
  catch (error) {
    return {ok: false, code: MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED, reason: error.message};
  }
  const combatStatistics = actionCombatStatistics(actor, actionDefinitionFromAction(action, {actorSystem: actor?.system ?? null})
    .definition ?? null, {item: action, turn: game.combat?.started ? turnKey(game.combat) : null});
  const definitionResult = actionDefinitionFromAction(action, {actorSystem: actor?.system ?? null});
  const definition = definitionResult.ok ? definitionResult.definition : null;
  // 2024 Wild Shape and Polymorph: a transformed creature can't cast spells. Spells it already cast (their lasting
  // areas, which run as authority Actions) go on.
  if ( !authorityAction && actor.transformation && definition?.tags?.includes("spell") ) return {
    ok: false,
    code: MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED,
    reason: "A transformed creature can't cast spells."
  };
  const defenseKey = combatStatistics.defenseKey;
  const sourceTokenResolution = resolveFoundrySourceToken({actor, source: intent.source ?? {}, game});
  if ( !sourceTokenResolution.ok ) return {
    ok: false,
    code: sourceTokenResolution.code,
    reason: sourceTokenResolution.reason
  };
  const sourceToken = sourceTokenResolution.token;
  if ( sourceToken && !documentOwnedByUser(sourceToken, sender) ) return {
    ok: false,
    code: MULTIPLAYER_AUTHORITY_CODES.WRONG_USER,
    reason: "The Action sender must own the source Token."
  };
  // A companion's Action may also cost the controller commanding it; the sender must own that controller.
  const controller = await foundryActionController({action, actor, intent, sender, game});
  if ( !controller.ok ) return {ok: false, code: controller.code, reason: controller.reason};
  let controllerSystem = null;
  try { controllerSystem = controller.actor ? foundryActorSystemSnapshot(controller.actor) : null; }
  catch (error) {
    return {ok: false, code: MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED, reason: error.message};
  }
  const area = foundryActionArea({action, actor, intent, sourceToken});
  if ( !area.ok ) return {ok: false, code: MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED, reason: area.reason};
  const targetActors = {};
  const targetSystems = {};
  // Each target's own grants (GrantResistance / GrantImmunity) shape the damage it takes.
  const targetProfiles = {};
  const systemSnapshots = new Map([[actor, actorSystem]]);
  const targets = [];
  const targetEntries = [];
  const saveRollModes = {};
  const saveModifiers = {};
  const saveOutcomes = {};
  const ambiguousKeys = new Set();
  // The authority, not the client's selection, decides who a "self" or "no target" Action targets.
  const targetingType = definition?.targeting?.type;
  const declaredTargets = (targetingType === "self") ? [{actorRef: actor.uuid ?? null, actorId: actor.id ?? null,
    tokenId: sourceToken?.id ?? null, sceneId: sourceToken?.parent?.id ?? null}]
    : (targetingType === "none") ? [] : (area.targetRefs ?? normalizeArray(intent.targetRefs ?? intent.targets));
  for ( const ref of declaredTargets ) {
    const targetRef = targetActorRefFromIntent(ref);
    const targetActor = await resolveFoundryDocumentRef(targetRef, {game, kind: "actor"});
    if ( !targetActor ) continue;
    try {
      if ( !systemSnapshots.has(targetActor) ) systemSnapshots.set(targetActor, foundryActorSystemSnapshot(targetActor));
    } catch (error) {
      return {ok: false, code: MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED,
        reason: `Action intent target ${targetRef} could not be snapshotted: ${error.message}`};
    }
    const hint = {
      tokenId: stringOrNull(typeof ref === "object" ? ref.tokenId : null),
      sceneId: stringOrNull(typeof ref === "object" ? ref.sceneId : null)
    };
    const target = withActorDefense({
      id: targetActor.id ?? targetRef,
      actorId: targetActor.id ?? null,
      actorRef: targetActor.uuid ?? targetRef,
      uuid: targetActor.uuid ?? null,
      // Reaction triggers match "an attack on me" by Token (unlinked Tokens share a base Actor id).
      tokenId: targetTokenFor(targetActor, hint, game)?.id ?? hint.tokenId,
      name: publicTargetName(targetActor, hint, game)
    }, targetActor, defenseKey);
    // 2024: each target's own advantage or disadvantage on the save it makes (`save`, `save.<ability>`), by
    // Token (unlinked copies of one Actor share its id).
    if ( definition?.save ) {
      const ability = definition.save.ability ?? definition.save.saveKey ?? null;
      const key = target.tokenId ?? target.id;
      saveRollModes[key] = combineRollModes(targetActor.getRollModes?.(["save", `save.${ability}`],
        {context: {save: {ability}}}) ?? []);
      // Each target's own save bonus (Modifiers on save.<ability> and save), and an automatic failure.
      const bonus = resolveActorSaveStatistic(targetActor, ability);
      if ( bonus ) saveModifiers[key] = bonus.totalModifier;
      if ( (targetActor.getRollOutcomes?.(["save", `save.${ability}`], {context: {save: {ability}}}) ?? [])
        .some(entry => entry.outcome === "automatic-failure") ) saveOutcomes[key] = "automatic-failure";
    }
    targets.push(target);
    const keys = uniqueStrings([targetActor.uuid, targetActor.id, `actor:${targetActor.id}`, targetRef,
      ...targetControllerKeys(targetActor, hint, game)]);
    for ( const key of keys ) {
      if ( targetActors[key] && (targetActors[key] !== targetActor) ) ambiguousKeys.add(key);
      targetActors[key] = targetActor;
      targetSystems[key] = systemSnapshots.get(targetActor);
      const profile = targetActor.getDamageProfile?.() ?? null;
      if ( profile ) targetProfiles[key] = clonePlainData(profile, "target.damageProfile");
    }
    targetEntries.push({actor: targetActor, hint});
  }
  // 2024 Charmed: a charmed creature can't attack its charmer or target it with damage or harmful effects.
  const harmful = definition && (definition.attack || definition.save || definition.damage.length || definition.effects.length);
  if ( harmful && !authorityAction && targetEntries.some(({actor: target}) => conditionsFrom(actor, target, game).charmed) ) return {
    ok: false,
    code: MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED,
    reason: "A charmed creature can't harm its charmer."
  };
  // Unlinked Tokens of one base Actor share its id (and `actor:<id>`); such a key would resolve every one of
  // them to whichever was registered last. Drop it so lookups fall through to the Token-specific keys.
  for ( const key of ambiguousKeys ) {
    delete targetActors[key];
    delete targetSystems[key];
    delete targetProfiles[key];
  }

  const source = {
    actorId: actor.id ?? null,
    actorRef: actor.uuid ?? actorRef,
    uuid: actor.uuid ?? null,
    tokenId: sourceToken?.id ?? intent.source?.tokenId ?? intent.tokenId ?? null,
    tokenRef: sourceToken?.uuid ?? intent.source?.tokenRef ?? intent.tokenRef ?? null
  };

  const spatial = buildFoundryActionSpatialContext({sourceToken, targetEntries, game, defenseKey});
  const attackRollMode = definition?.attack ? foundryAttackRollMode({actor, action, definition, targetEntries, spatial, game, sourceToken}) : null;
  const attackOutcomes = definition?.attack ? foundryAttackOutcomes({definition, targets, targetEntries, spatial, game, sourceToken}) : null;
  const concentration = foundryConcentrationContext({targetEntries, game, scene: sourceToken?.parent ?? null});
  // Holders of effects a broken concentration ends are committed on too; a key another Actor already owns is
  // ambiguous (copies of one base Actor) and is dropped, so lookups fall through to the holder's uuid.
  for ( const holder of concentration?.holders ?? [] ) {
    for ( const key of uniqueStrings([holder.uuid, holder.token?.uuid, holder.id, `actor:${holder.id}`]) ) {
      if ( targetActors[key] && (targetActors[key] !== holder) ) delete targetActors[key];
      else targetActors[key] = holder;
    }
  }
  if ( controller.actor ) targetActors[controller.actor.uuid] = controller.actor;
  // Reactors on the Scene (Trigger RuleElements on Action events) and the acting creature they may answer.
  const scene = sourceToken?.parent ?? null;
  const reactions = scene ? foundryActionReactionServices({game, scene, token: sourceToken,
    supplied: game?.wildpath?.reactionServices?.({intent, scene, token: sourceToken, resolutionKind: "action"}) ?? {}}) : null;
  for ( const [key, document] of Object.entries(reactions?.actorDocuments ?? {}) ) {
    if ( targetActors[key] && (targetActors[key] !== document) ) delete targetActors[key];
    else targetActors[key] = document;
  }

  return {
    ok: true,
    options: {
      actor,
      actorSystem,
      action,
      source,
      targets,
      targetActors,
      targeting: spatial?.targetFootprints.length ? {candidates: spatial.targetFootprints} : null,
      context: {
        ...(spatial ? {spatial: spatial.context} : {}),
        ...(typeof intent.messageMode === "string" ? {messageMode: intent.messageMode} : {})
      },
      ...(combatStatistics.damage ? {damage: combatStatistics.damage} : {}),
      ...((combatStatistics.attack || attackRollMode) ? {attack: {...(combatStatistics.attack ?? {}),
        ...(attackRollMode ? {rollMode: attackRollMode} : {}),
        ...(attackOutcomes ? {outcomesByTarget: attackOutcomes} : {})}} : {}),
      ...(Object.keys(saveRollModes).length ? {save: {rollModesByTarget: saveRollModes, modifiersByTarget: saveModifiers,
        outcomesByTarget: saveOutcomes}} : {}),
      ...(definition?.check ? {check: actionCheckInput(actor, definition.check)} : {}),
      ...(definition?.summon && Array.isArray(intent.summon?.points) ? {summonPoints: intent.summon.points.slice(0, 20)
        .map(point => ({x: Number(point?.x), y: Number(point?.y)}))
        .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))} : {}),
      // Rules consume plain effective snapshots; commit retains the exact live (possibly synthetic) Actors.
      durability: {targetSystems, ...(Object.keys(targetProfiles).length ? {adjustmentProfiles: targetProfiles} : {})},
      configuration: clonePlainData(intent.configuration ?? null, "intent.configuration"),
      ...(concentration ? {concentration: concentration.input} : {}),
      ...(area.persistentArea ? {persistentArea: area.persistentArea} : {}),
      ...(controller.actor ? {controller: {actorRef: controller.actor.uuid, actorSystem: controllerSystem}} : {}),
      persistencePort
    },
    requestContext: {
      sourceControllerUserIds: ownerUserIdsForDocument(actor, {game}),
      targetControllerUserIdsByTargetRef: Object.fromEntries(targetEntries.flatMap(({actor: targetActor, hint}) => {
        const owners = ownerUserIdsForDocument(targetActor, {game});
        return targetControllerKeys(targetActor, hint, game).map(key => [key, owners]);
      }))
    },
    ...(reactions ? {services: {...reactions.services, targetActors}} : {})
  };
}

/**
 * An Action that transforms its creature (Wild Shape): once it completes, the source takes the fixed form, or the
 * form its configuration choice picked (the authority already held that choice to the Action's own options), or
 * returns to itself.
 */
export async function applyActionTransformation({options, state}={}, {logger=globalThis.console, fromUuid=globalThis.fromUuid}={}) {
  const spec = state?.actionDefinition?.transform;
  const actor = options?.actor ?? null;
  if ( !spec || (typeof actor?.transform !== "function") ) return null;
  if ( spec.revert ) return actor.revertTransformation();
  // A resolved configuration lists its selections; each names its choice and the option chosen.
  const choices = state.configuration?.choices;
  const chosen = !spec.choiceId ? null : Array.isArray(choices) ? choices.find(entry => entry?.id === spec.choiceId)
    : choices?.[spec.choiceId];
  const formRef = spec.formRef ?? (typeof chosen === "string" ? chosen : chosen?.value ?? chosen?.optionId ?? null);
  const form = formRef ? await fromUuid?.(formRef) : null;
  if ( !form ) {
    logger?.warn?.("Wild Path | The form an Action named could not be found", formRef);
    return null;
  }
  return actor.transform(form, {...(spec.takes ? {takes: spec.takes} : {}), ...(spec.keepItemTypes ? {keepItemTypes: spec.keepItemTypes} : {})});
}

/**
 * When a condition that ends concentration (Incapacitated: Stunned, Unconscious, Dead) reaches a creature, every
 * effect it sustains ends, its lasting concentration areas included (their marker's deletion removes the
 * Region). A sustained effect names its source by Actor or Token ref.
 */
export async function endConcentrationOnIncapacitation(effect, game=globalThis.game) {
  if ( !WILDPATH.CONDITIONS[effect?.system?.type]?.endsConcentration ) return [];
  if ( game?.users?.activeGM?.id !== game?.user?.id ) return [];
  const actor = effect.parent;
  if ( !actor?.uuid ) return [];
  const refs = creatureRefs(actor, game);
  const holders = new Set([...collectionContents(game.actors),
    ...collectionContents(game.scenes).flatMap(scene => collectionContents(scene.tokens).map(token => token.actor).filter(Boolean))]);
  const ended = [];
  for ( const holder of holders ) {
    const sustained = collectionContents(holder.effects).filter(entry =>
      refs.has(entry?.flags?.wildpath?.conditionEffect?.concentration?.sourceRef));
    if ( !sustained.length ) continue;
    await holder.deleteEmbeddedDocuments("ActiveEffect", sustained.map(entry => entry.id));
    ended.push(...sustained.map(entry => entry.uuid));
  }
  return ended;
}

/**
 * 2024 advantage and disadvantage on an attack roll: the attacker's own (`attack`, `attack.<type>`, the Action's
 * included) and the first target's on attacks against it (`attacked`, `attacked.<type>`), combined so any of
 * each cancel. Predicates see `attack.type` and `attack.adjacent` (the attacker within 5 ft).
 */
function foundryAttackRollMode({actor, action, definition, targetEntries, spatial, game, sourceToken}) {
  const type = definition.attack.type ?? null;
  const target = targetEntries[0] ?? null;
  const context = attackContext(type, spatial, target, game, sourceToken, actor);
  return combineRollModes([
    ...(actor.getRollModes?.(["attack", `attack.${type}`], {item: action, context}) ?? []),
    ...(target?.actor?.getRollModes?.(["attacked", `attacked.${type}`], {context}) ?? [])
  ]);
}

/** Outcomes forced on hits against each target (`critical-on-hit`), keyed by Token like the targets. */
function foundryAttackOutcomes({definition, targets, targetEntries, spatial, game, sourceToken}) {
  const type = definition.attack.type ?? null;
  const outcomes = {};
  targetEntries.forEach((entry, index) => {
    const forced = entry.actor?.getRollOutcomes?.(["attacked", `attacked.${type}`], {context: attackContext(type, spatial, entry, game, sourceToken)}) ?? [];
    if ( forced.some(outcome => outcome.outcome === "critical-on-hit") ) {
      outcomes[targets[index].tokenId ?? targets[index].id] = "critical-on-hit";
    }
  });
  return Object.keys(outcomes).length ? outcomes : null;
}

/**
 * What RuleElement predicates see about an attack on one target: its type, whether it is within 5 ft, and the
 * conditions the attacker has from that target (`fromTarget.grappled`).
 */
function attackContext(type, spatial, entry, game, sourceToken, attacker=null) {
  const token = entry ? resolveFoundryTargetToken({actor: entry.actor, hint: entry.hint, game,
    preferredSceneId: sourceToken?.parent?.id ?? null}) : null;
  const source = spatial?.context?.sourceFootprint ?? null;
  const footprint = source && token?.parent
    ? createFoundryV14TacticalGridAdapter({scene: token.parent}).tokenToFootprint(token) : null;
  const fields = footprint?.ok && footprint.footprint ? footprintDistance(source, footprint.footprint) : null;
  return {attack: {type, ...(Number.isFinite(fields) ? {adjacent: fields * spatial.context.gridDistance <= 5} : {}),
    fromTarget: conditionsFrom(attacker, entry?.actor, game)}};
}

/** Every ref a creature's effects may name it by: its Actor and each of its Tokens. */
function creatureRefs(actor, game) {
  const tokens = collectionContents(game?.scenes).flatMap(scene => collectionContents(scene.tokens))
    .filter(token => (token.actor?.uuid === actor.uuid) || (token.actorLink && (token.actorId === actor.id)));
  return new Set([actor.uuid, `actor:${actor.id}`, ...tokens.flatMap(token => [token.uuid, `token:${token.id}`,
    `token:${token.parent?.id}.${token.id}`])]);
}

/**
 * The conditions `holder` has from `source`, as `{grappled: true}`: those whose effect names `source` (by Actor or
 * Token ref) or one of its Items (an Action it used) as where the effect came from.
 */
export function conditionsFrom(holder, source, game=globalThis.game) {
  const from = {};
  for ( const effect of effectsFrom(holder, source, game) ) for ( const id of effect.statuses ?? [] ) from[id] = true;
  return from;
}

/** The enabled effects on `holder` that came from `source`: its Actor, one of its Tokens, or one of its Items. */
function effectsFrom(holder, source, game) {
  if ( !holder?.effects || !source?.uuid ) return [];
  const refs = creatureRefs(source, game);
  return collectionContents(holder.effects).filter(effect => {
    const flag = effect?.flags?.wildpath?.conditionEffect ?? {};
    const ref = String(flag.sourceRef ?? flag.originRef ?? effect?.origin ?? "").replace(/^uuid:/, "");
    return ref && !effect.disabled && (refs.has(ref) || [...refs].some(owner => ref.startsWith(`${owner}.`)));
  });
}

/** Whether `target` reveals `detail` (`defenses`) to `viewer`: a `Reveal` rule on an effect `viewer` applied to it. */
export function revealedTo(target, viewer, detail="defenses", game=globalThis.game) {
  return effectsFrom(target, viewer, game).some(effect => collectRuleElementContributions({ruleElements: effect.system?.ruleElements ?? [],
    context: {actor: target, actorSystem: target.system}}).contributions.reveals.includes(detail));
}

/**
 * The odds of `action` against each of `targetTokens`, from the authority's own numbers: for an attack, the chance
 * to hit (its modifier against the target's defense, with every advantage and disadvantage, adjacency included);
 * for a save, the chance the target fails it (its save bonus against the DC, its own roll mode, automatic failure).
 * `user` sees the odds against a target when they are the GM, when the table's house rule shows odds to players
 * (`playersSeeOdds`), or when the target reveals its defenses to `actor`. An area or a self Action has none.
 */
export function foundryActionOdds({actor, action, sourceToken=null, targetTokens=[], user=null, game=globalThis.game}) {
  const definitionResult = actionDefinitionFromAction(action, {actorSystem: actor?.system ?? null});
  const definition = definitionResult.ok ? definitionResult.definition : null;
  if ( !definition || !(definition.attack || definition.save) || ["area", "self", "none"].includes(definition.targeting?.type) ) return [];
  let playersSeeOdds = false;
  try { playersSeeOdds = game?.settings?.get("wildpath", "playersSeeOdds") === true; } catch (_error) {}
  const entries = targetTokens.filter(token => token?.actor && (user?.isGM || playersSeeOdds || revealedTo(token.actor, actor, "defenses", game)))
    .map(token => ({token, actor: token.actor, hint: {tokenId: token.id, sceneId: token.parent?.id ?? null}}));
  if ( definition.attack ) {
    const statistics = actionCombatStatistics(actor, definition, {item: action, turn: game?.combat?.started ? turnKey(game.combat) : null});
    const modifier = statistics.attack?.modifierTotal ?? 0;
    const defenseKey = statistics.defenseKey ?? definition.attack.defenseKey ?? "ac";
    const spatial = buildFoundryActionSpatialContext({sourceToken, targetEntries: entries, game, defenseKey});
    return entries.flatMap(entry => {
      const defense = resolveActorDefense(entry.actor, defenseKey)?.value;
      if ( !Number.isFinite(defense) ) return [];
      const rollMode = foundryAttackRollMode({actor, action, definition, targetEntries: [entry], spatial, game, sourceToken});
      return [{tokenId: entry.token.id, name: entry.token.name, kind: "attack", modifier, defense, rollMode,
        chance: d20Chance({modifier, target: defense, rollMode, natural: true})}];
    });
  }
  const dc = actionDefinitionToResolverInput(definition, {actorSystem: foundryActorSystemSnapshot(actor)}).save?.dc?.value;
  const ability = definition.save.ability ?? definition.save.saveKey ?? null;
  if ( !Number.isFinite(dc) ) return [];
  return entries.map(({token, actor: target}) => {
    const context = {context: {save: {ability}}};
    const rollMode = combineRollModes(target.getRollModes?.(["save", `save.${ability}`], context) ?? []);
    const modifier = resolveActorSaveStatistic(target, ability)?.totalModifier ?? 0;
    const automatic = (target.getRollOutcomes?.(["save", `save.${ability}`], context) ?? [])
      .some(outcome => outcome.outcome === "automatic-failure");
    return {tokenId: token.id, name: token.name, kind: "save", ability, dc, modifier, rollMode, automatic,
      chance: automatic ? 1 : 1 - d20Chance({modifier, target: dc, rollMode})};
  });
}

/**
 * The controller that pays a companion's controller costs: the one the intent names, else the first listed
 * controller the sender owns (a GM owns every one). An Action without controller costs needs none.
 */
async function foundryActionController({action, actor, intent, sender, game}) {
  const result = actionDefinitionFromAction(action, {actorSystem: actor?.system ?? null});
  const cost = result.ok ? actionDefinitionActivationCost({costs: result.definition?.controllerCosts}) : {allOf: []};
  if ( !(cost.allOf?.length || cost.anyOf?.length) ) return {ok: true, actor: null};
  const controllers = actor.system?.companion?.controllers ?? [];
  const named = typeof intent.controllerRef === "string" ? [intent.controllerRef] : controllers;
  for ( const ref of named.filter(entry => controllers.includes(entry)) ) {
    const candidate = await resolveFoundryDocumentRef(ref, {game, kind: "actor"});
    if ( candidate && documentOwnedByUser(candidate, sender) ) return {ok: true, actor: candidate};
  }
  return {ok: false, code: MULTIPLAYER_AUTHORITY_CODES.WRONG_USER,
    reason: "This Action costs the companion's controller, and the sender controls none of its controllers."};
}

/**
 * An area Action's targets are every creature its covered fields touch, recomputed here from the placement
 * clicks (`intent.area.points`) and the caster's own Token; the client's targets are not consulted.
 * Returns `{ok: true}` without `targetRefs` for an Action that does not target an area.
 */
function foundryActionArea({action, actor, intent, sourceToken}) {
  const result = actionDefinitionFromAction(action, {actorSystem: actor?.system ?? null});
  const definition = result.ok ? result.definition : null;
  if ( definition?.targeting?.type !== "area" ) return {ok: true};
  if ( !sourceToken?.parent ) return {ok: false, reason: "An area Action needs its caster's Token on a Scene."};
  const placed = foundryAreaFootprint({definition, sourceToken, points: intent.area?.points ?? []});
  if ( !placed.ok ) return placed;
  const targetRefs = foundryAreaTargetTokens({sourceToken, footprint: placed.footprint})
    .map(token => ({actorRef: token.actor?.uuid ?? null, tokenId: token.id, sceneId: token.parent?.id ?? null}))
    .filter(ref => ref.actorRef);
  // A lasting area becomes a Region once the Action completes (see createFoundryPersistentAreas).
  const persistentArea = definition.area?.persistence ? {footprint: clonePlainData(placed.footprint, "area.footprint"),
    definition: clonePlainData(definition, "area.definition"), sourceTokenId: sourceToken.id, sceneId: sourceToken.parent.id} : null;
  return {ok: true, footprint: placed.footprint, targetRefs, persistentArea};
}

/**
 * Concentration is derived, not stored: a creature concentrates while some effect names it as its
 * concentration source (`flags.wildpath.conditionEffect.concentration.sourceRef`, a `token:<id>` or uuid
 * ref). Scans the Scene's Token Actors and the world's Actors for those effects and returns, for the
 * targeted creatures that sustain any, the pipeline's `concentration` input plus the holders to commit on.
 */
function foundryConcentrationContext({targetEntries=[], game=globalThis.game, scene=null}={}) {
  const holders = [...new Set([
    ...collectionContents(scene?.tokens).map(token => token?.actor).filter(Boolean),
    ...collectionContents(game?.actors)
  ])];
  const sustained = new Map();
  for ( const holder of holders ) for ( const effect of collectionContents(holder.effects) ) {
    const sourceRef = effect?.flags?.wildpath?.conditionEffect?.concentration?.sourceRef;
    if ( !sourceRef || effect.disabled ) continue;
    if ( !sustained.has(sourceRef) ) sustained.set(sourceRef, []);
    sustained.get(sourceRef).push({holder, effect});
  }
  if ( !sustained.size ) return null;

  const states = {};
  const dependents = [];
  const usedHolders = new Set();
  for ( const {actor, hint} of targetEntries ) {
    const token = targetTokenFor(actor, hint, game);
    const refs = uniqueStrings([token?.id ? `token:${token.id}` : null, ...targetControllerKeys(actor, hint, game)]);
    const sourceRef = refs.find(ref => sustained.has(ref));
    if ( !sourceRef ) continue;
    // Its concentration save adds its Fortitude save bonus (ability modifier and Modifiers).
    const state = {concentrating: true, actorId: actor.id ?? null, actorRef: actor.uuid ?? null, sourceRef,
      saveBonus: resolveActorSaveStatistic(actor, "fortitude")?.totalModifier ?? null};
    for ( const key of refs ) states[key] = state;
    for ( const {holder, effect} of sustained.get(sourceRef) ) {
      usedHolders.add(holder);
      dependents.push({
        target: {id: holder.token?.uuid ?? holder.uuid, actorId: holder.id, actorRef: holder.uuid, uuid: holder.uuid},
        effects: [clonePlainData(effect.toObject?.() ?? effect, "concentration.effect")]
      });
    }
  }
  if ( !dependents.length ) return null;
  // WildPath's concentration save is Fortitude; the DC policy is ConcentrationResolver's default.
  return {input: {states, dependents, policy: {ability: "fortitude", saveKey: "concentration"}}, holders: [...usedHolders]};
}

/**
 * The Token's name is the one players see; a synthetic Actor carries the base Actor's name, which a
 * renamed Token may deliberately conceal. Hidden Tokens get no name, since results are public.
 */
function publicTargetName(actor, hint, game) {
  const token = targetTokenFor(actor, hint, game);
  return token && token.hidden !== true ? stringOrNull(token.name) : null;
}

/**
 * Spatial targets (and the saves they roll) are identified by their Token, so controllers are keyed by every
 * Token-specific alias, never by the base Actor id that unlinked Tokens of one Actor share.
 */
function targetControllerKeys(actor, hint, game) {
  const token = targetTokenFor(actor, hint, game);
  const sceneId = token?.parent?.id ?? hint.sceneId;
  return uniqueStrings([actor?.uuid, token?.uuid, token?.id ? tokenRef(token.id, {sceneId}) : null]);
}

function targetTokenFor(actor, hint, game) {
  return actor?.token ?? game?.scenes?.get?.(hint.sceneId)?.tokens?.get?.(hint.tokenId) ?? null;
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
  // A common action (Dash, Shove...) is built here from its id, never taken from the client.
  const common = commonActionId(ref);
  if ( common ) return commonAction(actor, common, {localize: key => game?.i18n?.localize?.(key) ?? key});
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
  // Items resolve through their Actor (resolveFoundryAction); a world Item has no acting Actor.
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
