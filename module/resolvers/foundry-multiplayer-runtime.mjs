import {gmNotice} from "../helpers/gm-notice.mjs";
import {movementMessage, refusalMessage} from "../helpers/refusal-messages.mjs";
export {refusalMessage};
import {createFoundryEnchantments} from "../adapters/foundry-v14-enchantments.mjs";
import {consumePortents, portentOffer} from "../adapters/foundry-v14-portent.mjs";
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
import {areaFieldsCenter, createFoundryPersistentAreas, ownArea, turnKey} from "../adapters/foundry-v14-persistent-areas.mjs";
import {combatTurnKey, requiresContext} from "../helpers/combat.mjs";
import {createFoundryTeleports, teleportDestination} from "../adapters/foundry-v14-teleport.mjs";
import {alliedTokens, allyDistance, allyNearTarget, createFoundryAuras, effectGiver, helpedByAlly} from "../adapters/foundry-v14-auras.mjs";
import {sunlightContext} from "../adapters/foundry-v14-sunlight.mjs";
import {AUTOMATION_QUERY, createFoundryAutomationDispatcher} from "../adapters/foundry-v14-automation-dispatcher.mjs";
import {COMPANION_QUERY, createFoundryCompanions} from "../adapters/foundry-v14-companions.mjs";
import {createFoundryDying} from "../adapters/foundry-v14-dying.mjs";
import {createFoundrySummons} from "../adapters/foundry-v14-summons.mjs";
import {createFoundryForcedMovement} from "../adapters/foundry-v14-forced-movement.mjs";
import {createFoundryFalling} from "../adapters/foundry-v14-falling.mjs";
import {createFoundryTokenSize} from "../adapters/foundry-v14-token-size.mjs";
import {createFoundryTurnDamage} from "../adapters/foundry-v14-turn-damage.mjs";
import {attackSight} from "../adapters/foundry-v14-senses.mjs";
import {fearContext} from "../adapters/foundry-v14-fear.mjs";
import {COVER_BONUS, coverBetween, foundrySightCollision} from "../adapters/foundry-v14-cover.mjs";

/** On the Ethereal Plane (Etherealness, Blink). */
const ethereal = creature => Boolean(creature?.statuses?.has?.("ethereal"));

/**
 * The cover `targetToken` has against an Action of `sourceToken` (2024): from its corners, or from an area's point of
 * origin (a radial area's first point; a cone or line starts at the caster). "none" without walls to test (no canvas).
 */
export function actionCover({definition, sourceToken, targetToken, points=[]}) {
  if ( !sourceToken || !targetToken || (targetToken.id === sourceToken.id) ) return "none";
  // Its own cover condition (a swallowed creature's Total Cover), else none; the walls' if better. Cover the source gave it
  // is none against the source itself (the worm that swallowed it).
  const statuses = targetToken.actor?.statuses;
  const given = sourceToken.actor ? conditionsFrom(targetToken.actor, sourceToken.actor) : {};
  const own = ["coverTotal", "coverThreeQuarters", "coverHalf"].find(status => statuses?.has?.(status) && !given[status]);
  const held = own ? {coverTotal: "total", coverThreeQuarters: "threeQuarters", coverHalf: "half"}[own] : "none";
  const collides = foundrySightCollision(targetToken.parent);
  if ( !collides || (held === "total") ) return held;
  const origin = ((definition?.targeting?.type === "area") && (definition.area?.shape === "radial") && points[0]) ? points[0] : null;
  const walls = coverBetween({source: origin ? null : sourceToken, origin, target: targetToken, collides});
  const order = ["none", "half", "threeQuarters", "total"];
  return order.indexOf(walls) >= order.indexOf(held) ? walls : held;
}
import {createFoundryWeaponMastery} from "../adapters/foundry-v14-weapon-mastery.mjs";
import {lacksAmmunition, offerAmmunitionRecovery, spendAmmunition} from "../adapters/foundry-v14-ammunition.mjs";
import {consumeScrollOf} from "../helpers/spell-scrolls.mjs";
import {afterChaseAction} from "../applications/chases.mjs";
import {createFoundryContagions} from "../adapters/foundry-v14-contagions.mjs";
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
import {targetLookupRefs} from "../helpers/target-actor-refs.mjs";
import {footprintDistance} from "../helpers/grid-footprints.mjs";
import {ROLL_AUTHORITY, combineRollModes, d20Chance} from "../helpers/rolls.mjs";
import {evaluateValueExpression} from "../helpers/value-expressions.mjs";
import {conditionsFrom, creatureRefs, effectsFrom, revealedTo} from "../helpers/effect-sources.mjs";
import {CREATURE_SIZE_ORDER, customEffectId} from "../helpers/action-definitions.mjs";
import {isUnprepared} from "../helpers/spellcasting.mjs";

export {conditionsFrom, revealedTo};
import {commonAction, commonActionId} from "../helpers/common-actions.mjs";
import {
  actionCombatStatistics,
  attackAbility,
  attackForcesCritical,
  attackRollModeSources,
  resolveActorCheckStatistic,
  resolveActorSaveStatistic,
  resolveActorDefense
} from "../helpers/combat-statistics.mjs";
import {createMultiplayerActionCoordinator} from "./multiplayer-action-coordinator.mjs";
import {createPhysicalDiceProvider} from "./roll-provider-resolver.mjs";
import {resolveActorResourcePayment} from "./resource-resolver.mjs";
import {knownMetamagic, METAMAGIC_POOL} from "../helpers/metamagic.mjs";
import {resolveActionConfiguration} from "../helpers/action-configuration.mjs";
import {zeroHpFor} from "../adapters/foundry-v14-zero-hp.mjs";
export {zeroHpFor};
import {evaluatePredicate} from "../helpers/predicates.mjs";
import {createMultiplayerMovementAuthority} from "./multiplayer-movement-authority.mjs";
import {createFoundryV14ReactionPauseAdapter} from "../adapters/foundry-v14-reaction-pause-adapter.mjs";
import {foundryMovementIntentToStagedOptions} from "../adapters/foundry-v14-staged-movement-adapter.mjs";
import {collectionContents} from "../helpers/collections.mjs";

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
      // First, so the area or summon this Action leaves is not among what it ends.
      await endEarlierConcentration(event);
      await areas.create(event);
      await areas.afterResolution(event);
      await dying.afterResolution(event);
      await applyActionTransformation(event, {logger});
      await summons.afterResolution(event);
      await enchantments.afterResolution(event);
      await spendAmmunition(event, {game});
      await afterChaseAction(event, {game});
      // A Spell Scroll read crumbles.
      if ( event.state?.actionDefinition?.scroll ) {
        if ( event.options?.action ) await consumeScrollOf(event.options.action);
      }
      await pushes.afterResolution(event);
      await areas.move(event);
      await teleports.afterResolution(event);
      await masteries.afterResolution(event);
      await endEffectsWhenAttacked(event, {fromUuid: globalThis.fromUuid ?? (() => null)});
      await endEffectsOnTargets(event, {fromUuid: globalThis.fromUuid ?? (() => null)});
      await endEffectsWhenSaved(event, {fromUuid: globalThis.fromUuid ?? (() => null)});
      await endEffectsWhenDamaged(event, {fromUuid: globalThis.fromUuid ?? (() => null)});
      // A ward that kept a creature up (Death Ward) ends.
      for ( const record of event.state?.results?.zeroHp ?? [] ) {
        if ( record.kept && record.effectUuid ) await (await globalThis.fromUuid?.(record.effectUuid))?.delete?.();
      }
      await endEffectsWhenChecked(event.options?.actor, event.state?.input?.check ?? null);
      await recordSlotSpell(event, {game});
      await recordCastLevel(event);
      await recordAttackTurn(event, {game});
      await recordQuickened(event, {game});
      // The foretelling rolls its d20s used (Portent).
      await consumePortents(event, {game, fromUuid: globalThis.fromUuid ?? (async () => null)});
      await markCasterConcentration(event, {game});
    },
    afterCancelled: event => afterCountered(event, {game}),
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
  // V14 marks an effect expired when its duration runs out; then an Action's custom effect (a buff), a concentration
  // marker, a condition lasting until its source's next turn (Stunning Strike, started on that Combatant), or a form
  // (Wild Shape's hours: its creature reverts) is removed.
  globalThis.Hooks?.on?.("updateActiveEffect", (effect, changes) => {
    const flags = effect.flags?.wildpath ?? {};
    if ( (changes?.duration?.expired === true) && (flags.conditionEffect?.definition?.custom || flags.concentrationMarker
      || flags.transformation
      || /^source/.test(String(flags.conditionEffect?.duration?.expiry ?? ""))) && (game.users?.activeGM?.id === game.user?.id) ) {
      void effect.delete();
    }
  });
  globalThis.Hooks?.on?.("deleteRegion", region => areas.onRegionDeleted(region));
  // The GM dragging a lasting area's Region moves the area itself (its fields follow its cells).
  globalThis.Hooks?.on?.("updateRegion", (region, changed, operation) => void areas.onRegionUpdated(region, changed, operation)
    .catch(error => gmNotice("WILDPATH.NOTICE.StepFailed", {step: game.i18n?.localize?.("WILDPATH.NOTICE.Step.AreaMove") ?? "AreaMove"}, error)));
  // Items' and effects' automatic triggers: turns and rests reach them from Combat and Actor#rest.
  const automation = createFoundryAutomationDispatcher({game, coordinator, logger, fromUuid: globalThis.fromUuid ?? null,
    resolveAction: options => foundryActionIntentToStagedOptions({...options, game, persistencePort})});
  if ( globalThis.CONFIG?.queries ) globalThis.CONFIG.queries[AUTOMATION_QUERY] = automation.handleQuery;
  // Dying and death (2024 death saves): after Actions, at turn start, and when Exhaustion reaches 6.
  const dying = createFoundryDying({game, coordinator, logger,
    resolveAction: options => foundryActionIntentToStagedOptions({...options, game, persistencePort})});
  globalThis.Hooks?.on?.("createActiveEffect", effect => void dying.onEffectChanged(effect));
  // A creature in the air that gets Prone, or loses its Speed, falls (2024).
  const falling = createFoundryFalling({game, coordinator, logger,
    resolveAction: options => foundryActionIntentToStagedOptions({...options, game, persistencePort})});
  globalThis.Hooks?.on?.("createActiveEffect", effect => void falling.onEffectCreated(effect)
    .catch(error => gmNotice("WILDPATH.NOTICE.StepFailed", {step: game.i18n?.localize?.("WILDPATH.NOTICE.Step.Fall") ?? "Fall"}, error)));
  // A change of size (Enlarge/Reduce): its creature's Tokens grow or shrink while it lasts.
  const tokenSize = createFoundryTokenSize({game});
  for ( const hook of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"] ) {
    globalThis.Hooks?.on?.(hook, effect => void tokenSize.onEffectChanged(effect)
      .catch(error => gmNotice("WILDPATH.NOTICE.StepFailed", {step: game.i18n?.localize?.("WILDPATH.NOTICE.Step.Size") ?? "Size"}, error)));
  }
  // Weapon Mastery that follows an attack (Topple, Graze), each as its own authority Action.
  const masteries = createFoundryWeaponMastery({game, coordinator, logger, fromUuid: globalThis.fromUuid ?? (() => null),
    resolveAction: options => foundryActionIntentToStagedOptions({...options, game, persistencePort})});
  // 2024: a stable creature regains 1 health after 1d4 hours; world time moving on (or a rest, Actor#rest) counts.
  globalThis.Hooks?.on?.("updateWorldTime", worldTime => void dying.onWorldTime(worldTime)
    .catch(error => gmNotice("WILDPATH.NOTICE.StepFailed", {step: game.i18n?.localize?.("WILDPATH.NOTICE.Step.StableRecovery") ?? "StableRecovery"}, error)));
  // Contagions (helpers/contagions.mjs): an infection's incubation, its symptoms as time passes, its fight after a rest.
  const contagions = createFoundryContagions({game, logger});
  const contagionStep = step => error => gmNotice("WILDPATH.NOTICE.StepFailed", {step: game.i18n?.localize?.("WILDPATH.NOTICE.Step.Contagion")
    ?? step}, error);
  globalThis.Hooks?.on?.("createActiveEffect", effect => void contagions.onEffectCreated(effect).catch(contagionStep("Contagion")));
  globalThis.Hooks?.on?.("deleteActiveEffect", effect => void contagions.onEffectDeleted(effect).catch(contagionStep("Contagion")));
  globalThis.Hooks?.on?.("updateWorldTime", () => void contagions.onWorldTime().catch(contagionStep("Contagion")));
  // A condition's damage at turn start (Bleeding), resolved like any other damage (reactions, rescue, dying).
  const turnDamage = createFoundryTurnDamage({game, coordinator, logger,
    resolveAction: options => foundryActionIntentToStagedOptions({...options, game, persistencePort})});
  game.wildpath = {...(game.wildpath ?? {}), dying, turnDamage, endEffectsWhenChecked, contagions};
  // 2024: an Incapacitated creature's concentration ends; everything it sustains ends with it (active GM).
  globalThis.Hooks?.on?.("createActiveEffect", effect => void endConcentrationOnIncapacitation(effect, game)
    .catch(error => gmNotice("WILDPATH.NOTICE.StepFailed", {step: game.i18n?.localize?.("WILDPATH.NOTICE.Step.EndConcentration") ?? "EndConcentration"}, error)));
  globalThis.Hooks?.on?.("updateActiveEffect", effect => void dying.onEffectChanged(effect));
  // Shared control of companions and summons: ownership follows their controllers (only a GM may change it).
  const companions = createFoundryCompanions({game, fromUuid: globalThis.fromUuid ?? (() => null)});
  if ( globalThis.CONFIG?.queries ) globalThis.CONFIG.queries[COMPANION_QUERY] = companions.handleQuery;
  // Summoned creatures: placed by the GM, controlled by their caster, gone with its concentration or rounds.
  const summons = createFoundrySummons({game, companions, logger, fromUuid: globalThis.fromUuid ?? (() => null)});
  globalThis.Hooks?.on?.("deleteActiveEffect", effect => void summons.onEffectDeleted(effect));
  // Its caster's death takes the summons that go with it (a Homunculus Servant).
  globalThis.Hooks?.on?.("createActiveEffect", effect => void summons.onCasterDead(effect)
    .catch(error => gmNotice("WILDPATH.NOTICE.StepFailed", {step: game.i18n?.localize?.("WILDPATH.NOTICE.Step.DismissSummons") ?? "DismissSummons"}, error)));
  // Pushes and pulls: the GM moves each creature an Action forces, as forced movement.
  const pushes = createFoundryForcedMovement({game, logger, fromUuid: globalThis.fromUuid ?? (() => null)});
  const teleports = createFoundryTeleports({game});
  // Item enchantments (infusions): the active GM puts an Action's effect on the Item it picked.
  const enchantments = createFoundryEnchantments({game, logger});
  // Whoever rolls, every client sees the Combatant update; the active GM dispatches it.
  globalThis.Hooks?.on?.("updateCombatant", (combatant, changed) => {
    if ( !Number.isFinite(changed?.initiative) ) return;
    // Its initiative rolled, Surprised has done its part (2024: Disadvantage on that roll); the active GM ends it.
    // (2014: it lasts through its first turn instead: documents/combat.mjs.)
    const surprised = combatant.actor?.statuses?.has?.("surprised") && (game.users?.activeGM?.id === game.user?.id)
      && (game.settings?.get?.("wildpath", "rulesVersion") !== "2014");
    if ( surprised ) void combatant.actor.toggleCondition?.("surprised", {levels: -1})
      .catch?.(error => gmNotice("WILDPATH.NOTICE.StepFailed", {step: game.i18n?.localize?.("WILDPATH.NOTICE.Step.Initiative") ?? "Initiative"}, error));
    void automation.dispatch("initiative.rolled", {actor: combatant.actor, token: combatant.token,
      data: {initiative: changed.initiative}}).catch(error => gmNotice("WILDPATH.NOTICE.StepFailed", {step: game.i18n?.localize?.("WILDPATH.NOTICE.Step.Initiative") ?? "Initiative"}, error));
  });
  // An encounter's end leaves its creatures' movement full again (it is not tracked outside one); the active GM writes.
  const refillMovement = actors => {
    if ( !game.user?.isGM || (game.users?.activeGM && (game.users.activeGM.id !== game.user.id)) ) return;
    for ( const actor of new Set(actors.filter(Boolean)) ) {
      if ( Number(actor.system?.resources?.movement?.spent) > 0 ) void actor.update({"system.resources.movement.spent": 0})
        .catch(error => gmNotice("WILDPATH.NOTICE.StepFailed", {step: game.i18n?.localize?.("WILDPATH.NOTICE.Step.RefillMovement") ?? "RefillMovement"}, error));
    }
  };
  globalThis.Hooks?.on?.("deleteCombat", combat => {
    refillMovement([...(combat.combatants ?? [])].map(combatant => combatant.actor));
    void offerAmmunitionRecovery(combat, {game}).catch(error => gmNotice("WILDPATH.NOTICE.StepFailed",
      {step: game.i18n?.localize?.("WILDPATH.NOTICE.Step.Ammunition") ?? "Ammunition"}, error));
  });
  globalThis.Hooks?.on?.("deleteCombatant", combatant => refillMovement([combatant.actor]));
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
  // A player is told in words; the GM sees the reason (refusal-messages.mjs).
  if ( typeof globalThis.ui?.notifications?.warn === "function" ) {
    globalThis.ui.notifications.warn(movementMessage(result));
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
    /** When several saves are rolled at once on this client: "physical", "always" or "never" (answerSaveBatchLocally). */
    get batchSaves() {
      return setting("wildpath", "batchSaves");
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

/** A refusal meant for its player, in its words (`refused`): the authority's own checks. */
function refused(key, data={}) {
  return {ok: false, code: MULTIPLAYER_AUTHORITY_CODES.ACTION_REFUSED, reason: globalThis.game?.i18n?.format?.(key, data) ?? key};
}

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
    globalThis.ui.notifications.warn(refusalMessage(event.error, globalThis.game) ?? `Wild Path | ${reason}`);
    logger?.debug?.("Wild Path | Action refused", event.error);
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
    globalThis.ui.notifications.warn(movementMessage(error, globalThis.game) ?? `Wild Path | ${reason}`);
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
function actionCheckInput(actor, {ability=null, skill=null, escapes=null}={}, sourceToken=null) {
  const bonus = resolveActorCheckStatistic(actor, {ability, skill});
  // A skill check uses its skill's ability unless it names another (`check.might` reaches an Athletics check).
  const used = ability ?? WILDPATH.SKILLS?.[skill]?.ability ?? null;
  const domains = ["check", used ? `check.${used}` : null, skill ? `check.${skill}` : null].filter(Boolean);
  return {...(bonus ? {modifier: bonus.totalModifier} : {}), ...(bonus?.dice?.length ? {dice: bonus.dice} : {}),
    ...(bonus?.naturalMinimum ? {naturalMinimum: bonus.naturalMinimum} : {}),
    // What it escapes (Powerful Build: Advantage to end Grappled).
    ...checkRollModes(actor.getRollModes?.(domains, {context: {check: {ability, skill, ...(escapes ? {escapes} : {})},
      ...sunlightContext(sourceToken), ...fearContext(sourceToken)}}) ?? [])};
}

/** A check's mode and the sources it combines (a reroll adds one more). */
function checkRollModes(sources) {
  return {rollMode: combineRollModes(sources), rollModeSources: sources};
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
  // A follow-up of a spell already cast is at the level it was cast at, from its caster's record (never the sender's).
  const fromCast = castLevelChoices(definition, action, actor);
  if ( fromCast ) intent = {...intent, configuration: {...(intent.configuration ?? {}),
    choices: {...(intent.configuration?.choices ?? {}), ...fromCast}}};
  // 2024 Wild Shape and Polymorph: a transformed creature can't cast spells. Spells it already cast (their lasting
  // areas, which run as authority Actions) go on.
  if ( !authorityAction && actor.transformation && definition?.tags?.includes("spell") ) return refused("WILDPATH.REFUSAL.Transformed");
  // 2024 Gaseous Form (and Wind Walk's cloud form): "the target can't attack or cast spells".
  if ( !authorityAction && actor.statuses?.has?.("gaseous") && (definition?.tags?.includes("spell") || definition?.attack) ) {
    return refused("WILDPATH.REFUSAL.Gaseous", {name: actor.name ?? ""});
  }
  // 2024: a spell of 1st level or higher is cast only while prepared.
  if ( !authorityAction && isUnprepared(action) ) return refused("WILDPATH.ITEM.NotPrepared", {name: action.name ?? ""});
  // 2024: a creature wearing armor it isn't trained with can't cast spells.
  const hindering = definition?.tags?.includes("spell") ? actor.getUntrainedArmor?.()?.find(item => item.system.armor !== "shield") : null;
  if ( !authorityAction && hindering ) return refused("WILDPATH.REFUSAL.ArmorCasting", {name: actor.name ?? "", armor: hindering.name ?? ""});
  // What the Action requires of its creature (`requires`: Steady Aim, not moved this turn).
  if ( !authorityAction && definition?.requires && !evaluatePredicate(definition.requires, {...requiresContext(actor, {game}), actorSystem,
    tags: definition.tags ?? []}).ok ) return refused("WILDPATH.ITEM.CannotUse", {name: action.name ?? ""});
  // 2024 Quickened Spell: "nor can you cast a level 1+ spell on the same turn after modifying a spell with this option".
  if ( !authorityAction && requiresContext(actor, {game}).quickenedThisTurn && (definition?.tags ?? []).includes("spell")
    && (Number(definition?.metadata?.spellLevel) >= 1) ) return refused("WILDPATH.REFUSAL.Quickened", {name: actor.name ?? ""});
  // 2024 Command, Flee: "spends its turn moving away from you by the fastest available means" (only Dash or Disengage).
  const usesTurn = (definition?.costs?.allOf ?? []).some(cost => ["action", "bonus-action"].includes(cost?.capability));
  if ( !authorityAction && actor.statuses?.has?.("commanded-flee") && usesTurn && !["common:dash", "common:disengage"].includes(definition?.id) ) return refused("WILDPATH.REFUSAL.Flee", {name: actor.name ?? ""});
  // A magic item's Action (a wand's spell) needs its item equipped and, when it needs attunement, attuned (2024).
  // An Action it replaced (inactive: an Invocation, a Maneuver) is not used.
  if ( !authorityAction && (action.system?.active === false) ) return refused("WILDPATH.LEVELUP.Replaced", {name: action.name ?? ""});
  const grantedBy = action.flags?.wildpath?.grantedBy ? actor.items?.get?.(action.flags.wildpath.grantedBy) : null;
  if ( !authorityAction && grantedBy && ((grantedBy.system?.active === false) || (grantedBy.system?.attunement === "required")) ) return refused(grantedBy.system?.attunement ? "WILDPATH.REFUSAL.EquipAttune" : "WILDPATH.REFUSAL.Equip", {name: grantedBy.name ?? ""});
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
  const areaMove = definition?.moveArea ? foundryAreaMove({definition, actor, intent, sourceToken}) : null;
  if ( areaMove && !areaMove.ok ) return refused(areaMove.key ?? "WILDPATH.REFUSAL.Generic", areaMove.data ?? {});
  // A teleport lands where its player clicked, checked again here: within its distance, on the Scene, on a free space.
  const landing = definition?.teleport ? teleportDestination({token: sourceToken ?? null, point: intent.teleport?.point ?? {x: NaN, y: NaN},
    distance: Number(definition.teleport.distance) || 0}) : null;
  if ( landing && !landing.ok ) return refused(`WILDPATH.TELEPORT.${landing.code}`);
  // A Wild Shape form beyond its druid's level is refused before anything is paid.
  if ( definition?.transform?.limits ) {
    const formRef = chosenFormRef(definition.transform, intent.configuration?.choices);
    const form = formRef ? await globalThis.fromUuid?.(formRef) : null;
    const refusal = form ? formBeyondLimits(definition.transform.limits, actor, form) : null;
    if ( refusal ) return {ok: false, code: MULTIPLAYER_AUTHORITY_CODES.ACTION_INTENT_REJECTED, reason: refusal};
  }
  const targetActors = {};
  const targetSystems = {};
  // Each target's own grants (GrantResistance / GrantImmunity) shape the damage it takes.
  const targetProfiles = {};
  const systemSnapshots = new Map([[actor, actorSystem]]);
  const targets = [];
  const targetEntries = [];
  const saveRollModes = {};
  const saveRollModeSources = {};
  // Each target's cover (shown on the card).
  const coverByTarget = [];
  const saveModifiers = {};
  const saveDice = {};
  // The save each target makes when it may choose (a Grapple's Might or Agility).
  const saveAbilityByTarget = {};
  const saveOutcomes = {};
  const evasionByTarget = {};
  const legendaryByTarget = {};
  const inspirationByTarget = {};
  const portentByTarget = {};
  // What keeps each target up at 0 Hit Points, and which are hostile to this creature (Dark One's Blessing).
  const zeroHpByTarget = {};
  const hostileKeys = [];
  // Player characters who may pay for a monster's reroll (Heroic Inspiration), found once when first asked.
  let inspirationPayers = null;
  const payers = () => (inspirationPayers ??= monsterRerollPayers(game, sourceToken?.parent ?? null));
  // Allies paying for a target's reroll (Countercharm), committed on like targets.
  const allyPayers = [];
  const spellDcBonus = (definition?.save && definition.tags?.includes("spell"))
    ? (Number(actor.getStatistic?.("dc.spell", {item: action, tags: definition.tags ?? []})?.totalModifier) || 0) : 0;
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
    // Its cover against this Action (walls and creatures between): +2 or +5 to its AC and Dexterity saves.
    const cover = definition ? actionCover({definition, sourceToken, targetToken: targetTokenFor(targetActor, hint, game),
      points: intent.area?.points ?? []}) : "none";
    // An automatic Action on several creatures (an aura, a death burst) leaves out one behind Total Cover or on the other
    // plane, rather than failing for all of them.
    if ( authorityAction && (targetActor !== actor) && ((cover === "total") || (ethereal(targetActor) !== ethereal(actor))) ) continue;
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
      const key = target.tokenId ?? target.id;
      const saverToken = targetTokenFor(targetActor, hint, game);
      // A choice of saves (2024 Grapple: Might or Agility): the one it is likelier to pass.
      const ability = bestSaveAbility({definition, targetActor, saverToken, cover, actor, actorSystem});
      if ( (definition.save.abilities?.length ?? 0) > 1 ) saveAbilityByTarget[key] = ability;
      const modes = (targetActor.getRollModes?.(["save", `save.${ability}`], saveContext(definition, ability, saverToken)) ?? [])
        .map(entry => entry?.mode ?? entry);
      saveRollModes[key] = combineRollModes(modes);
      // Its sources too, so a reroll with a mode of its own (Countercharm's Advantage) cancels source for source.
      if ( modes.length ) saveRollModeSources[key] = modes;
      // Each target's own save bonus (Modifiers on save.<ability> and save), and an automatic failure.
      const bonus = resolveActorSaveStatistic(targetActor, ability);
      const covered = (ability === "agility") ? COVER_BONUS[cover] : 0;
      if ( bonus || covered ) saveModifiers[key] = (bonus?.totalModifier ?? 0) + covered;
      if ( bonus?.dice?.length ) saveDice[key] = bonus.dice;
      const forced = targetActor.getRollOutcomes?.(["save", `save.${ability}`], saveContext(definition, ability, saverToken)) ?? [];
      if ( forced.some(entry => entry.outcome === "automatic-failure") ) saveOutcomes[key] = "automatic-failure";
      if ( forced.some(entry => entry.outcome === "evasion") ) evasionByTarget[key] = "evasion";
      const legendary = legendaryResistanceFor(targetActor, systemSnapshots.get(targetActor), game);
      if ( legendary ) legendaryByTarget[key] = legendary;
      const inspiration = withAllyTestOffers(withTestOffers(withAddedDice(withIndomitable(inspirationOffer(targetActor,
        systemSnapshots.get(targetActor), game, {chooser: ROLL_AUTHORITY.TARGET_CONTROLLER, payers}), targetActor,
        systemSnapshots.get(targetActor), game), targetActor, game, {chooser: ROLL_AUTHORITY.TARGET_CONTROLLER, target}), targetActor,
        systemSnapshots.get(targetActor), game, "save", {chooser: ROLL_AUTHORITY.TARGET_CONTROLLER}), saverToken, definition, game, "save",
        {chooser: ROLL_AUTHORITY.TARGET_CONTROLLER, register: payer => { allyPayers.push(payer); }});
      if ( inspiration ) inspirationByTarget[key] = inspiration;
      // Portent: a Diviner who sees it may replace its d20.
      const portent = portentOffer(saverToken, game);
      if ( portent ) portentByTarget[key] = portent;
    }
    if ( definition?.damage?.length ) {
      const key = target.tokenId ?? target.id;
      const zero = zeroHpFor(targetActor, systemSnapshots.get(targetActor));
      if ( zero ) zeroHpByTarget[key] = zero;
      if ( hostileTo(sourceToken, targetTokenFor(targetActor, hint, game)) ) hostileKeys.push(key);
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
    targetEntries.push({actor: targetActor, hint, cover});
    if ( cover !== "none" ) coverByTarget.push({target: {...target}, degree: cover});
  }
  // 2024 Total Cover: a creature behind it can't be targeted directly (an area's is left out of the area).
  if ( (definition?.targeting?.type !== "area") && targetEntries.some(entry => entry.cover === "total") ) return refused("WILDPATH.COVER.TotalRefused");
  // A weapon that fires ammunition its character has none of (2024).
  if ( !authorityAction && lacksAmmunition(actor, definition) ) return refused("WILDPATH.REFUSAL.NoAmmunition");
  // On the Ethereal Plane: an ethereal creature and one that is not can't target each other (an area leaves out those on
  // the other plane: foundryActionArea).
  if ( !authorityAction && (definition?.targeting?.type !== "area")
    && targetEntries.some(({actor: target}) => (target !== actor) && (ethereal(target) !== ethereal(actor))) ) return refused("WILDPATH.REFUSAL.Ethereal");
  // 2024 Charmed: a charmed creature can't attack its charmer or target it with damage or harmful effects.
  const harmful = definition && (definition.attack || definition.save || definition.damage.length || definition.effects.length);
  if ( harmful && !authorityAction && targetEntries.some(({actor: target}) => conditionsFrom(actor, target, game).charmed) ) return refused("WILDPATH.REFUSAL.Charmed");
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
    tokenRef: sourceToken?.uuid ?? intent.source?.tokenRef ?? intent.tokenRef ?? null,
    // Its side, as its targets' are labelled (Careful Spell ticks the creatures on it).
    ...(sourceToken ? {disposition: foundryDispositionLabel(sourceToken.disposition)} : {})
  };

  const spatial = buildFoundryActionSpatialContext({sourceToken, targetEntries, game, defenseKey});
  // 2024 Grapple and Shove: "The target must be no more than one size larger than you" (`targeting.maxSizeAboveSource`).
  const above = Number(definition?.targeting?.maxSizeAboveSource);
  const rank = size => CREATURE_SIZE_ORDER.indexOf(String(size ?? ""));
  const sourceRank = rank(spatial?.context?.sourceFootprint?.size);
  if ( Number.isFinite(above) && (sourceRank >= 0) && (spatial?.context?.targetFootprints ?? []).some(entry => rank(entry?.size) > sourceRank + above) ) return refused("WILDPATH.COMMON.TooLarge");
  const attackRollModeSourceList = definition?.attack ? foundryAttackRollModeSources({actor, action, definition, targetEntries, spatial, game, sourceToken}) : null;
  const attackRollMode = attackRollModeSourceList ? combineRollModes(attackRollModeSourceList) : null;
  const attackOutcomes = definition?.attack ? foundryAttackOutcomes({definition, targets, targetEntries, spatial, game, sourceToken}) : null;
  const attackBonuses = definition?.attack ? foundryAttackBonuses({targets, targetEntries, game, sourceToken}) : null;
  // Extra damage that depends on this attack (Sneak Attack: Advantage, or an ally beside the target) sees it. A target's
  // own (Hunter's Mark, Hex) counts on it alone; with several targets, each one's on that one (its refs).
  const statistics = definition?.attack ? actionCombatStatistics(actor, definition, {item: action,
    turn: game.combat?.started ? turnKey(game.combat) : null, context: {attack: {...attackContext(definition.attack.type ?? null, spatial,
      targetEntries[0], game, sourceToken, actor).attack, rollMode: attackRollMode}},
    target: targetEntries.length === 1 ? targetEntries[0].actor : null,
    targets: targetEntries.length > 1 ? targetEntries.map((entry, index) => ({actor: entry.actor, refs: targetLookupRefs(targets[index])})) : null})
    : combatStatistics;
  // Healing bonuses, which may read the level it is cast at (Disciple of Life: 2 + that level).
  const healingStatistic = definition?.healing?.length ? actionCombatStatistics(actor, definition, {item: action,
    context: {castLevel: intent.configuration?.choices ? (resolveActionConfiguration({definition, actorSystem,
      choices: intent.configuration.choices}).configuration?.castingLevel ?? null) : null}}).healing ?? null : null;
  const concentration = foundryConcentrationContext({targetEntries, game, scene: sourceToken?.parent ?? null, sourceToken});
  // Holders of effects a broken concentration ends are committed on too; a key another Actor already owns is
  // ambiguous (copies of one base Actor) and is dropped, so lookups fall through to the holder's uuid.
  for ( const holder of concentration?.holders ?? [] ) {
    for ( const key of uniqueStrings([holder.uuid, holder.token?.uuid, holder.id, `actor:${holder.id}`]) ) {
      if ( targetActors[key] && (targetActors[key] !== holder) ) delete targetActors[key];
      else targetActors[key] = holder;
    }
  }
  if ( controller.actor ) targetActors[controller.actor.uuid] = controller.actor;
  const ownOffer = (definition?.attack || definition?.check)
    ? withAddedDice(inspirationOffer(actor, actorSystem, game, {chooser: ROLL_AUTHORITY.SOURCE_CONTROLLER, payers}), actor, game,
      {chooser: ROLL_AUTHORITY.SOURCE_CONTROLLER, target: {id: actor.id, actorId: actor.id, actorRef: actor.uuid, uuid: actor.uuid,
        tokenId: sourceToken?.id ?? null}}) : null;
  // A fighter's Tactical Mind joins its own failed checks only.
  // An ally's on its check too (Flash of Genius), each paying creature committed on like a target.
  const ownTest = (definition?.attack || definition?.check) ? withAllyTestOffers(withTestOffers(ownOffer, actor, actorSystem, game,
    definition?.check ? "check" : "attack", {chooser: ROLL_AUTHORITY.SOURCE_CONTROLLER}), sourceToken, definition, game,
    definition?.check ? "check" : "attack", {chooser: ROLL_AUTHORITY.SOURCE_CONTROLLER, register: payer => { allyPayers.push(payer); }})
    : ownOffer;
  const ownInspiration = definition?.check ? withTacticalMind(ownTest, actor, actorSystem, game)
    : (definition?.tags?.includes("spell") ? withSeekingSpell(ownTest, actor, actorSystem, game) : ownTest);
  // Portent: a Diviner who sees the acting creature may replace its attack's or check's d20.
  const ownPortent = (definition?.attack || definition?.check) ? portentOffer(sourceToken, game) : null;
  // A character paying for a reroll is committed on like a target, its uuid its key: the acting creature for its own
  // roll, or a player character for a monster's.
  if ( ownInspiration?.own ) targetActors[actor.uuid] ??= actor;
  // Its own reward for dropping a creature (Dark One's Blessing) is committed on it, its uuid its key.
  const onReduce = definition?.damage?.length ? reducedToZeroFor(actor, actorSystem) : null;
  if ( onReduce ) targetActors[actor.uuid] ??= actor;
  for ( const payer of [...(inspirationPayers ?? []), ...allyPayers] ) targetActors[payer.uuid] ??= payer;
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
        ...(coverByTarget.length ? {cover: coverByTarget} : {}),
        ...(typeof intent.messageMode === "string" ? {messageMode: intent.messageMode} : {})
      },
      ...(statistics.damage ? {damage: statistics.damage} : {}),
      ...(healingStatistic ? {healing: healingStatistic} : {}),
      ...((statistics.attack || attackRollMode) ? {attack: {...(statistics.attack ?? {}),
        ...(attackRollMode ? {rollMode: attackRollMode, rollModeSources: attackRollModeSourceList} : {}),
        ...(ownInspiration ? {inspiration: ownInspiration} : {}),
        ...(ownPortent ? {portent: ownPortent} : {}),
        ...(attackOutcomes ? {outcomesByTarget: attackOutcomes} : {}),
        ...(attackBonuses ? {bonusByTarget: attackBonuses} : {})}} : {}),
      ...(Object.keys(saveRollModes).length ? {save: {rollModesByTarget: saveRollModes, modifiersByTarget: saveModifiers,
        ...(Object.keys(saveRollModeSources).length ? {rollModeSourcesByTarget: saveRollModeSources} : {}),
        // Its creature's bonus to its spells' save DC (Innate Sorcery's +1, a Robe of the Archmagi's +2: `dc.spell`).
        ...(spellDcBonus ? {dcBonus: spellDcBonus} : {}),
        ...(Object.keys(saveDice).length ? {diceByTarget: saveDice} : {}),
        ...(Object.keys(saveAbilityByTarget).length ? {abilityByTarget: saveAbilityByTarget} : {}),
        ...(Object.keys(legendaryByTarget).length ? {legendaryByTarget} : {}),
        ...(Object.keys(inspirationByTarget).length ? {inspirationByTarget} : {}),
        ...(Object.keys(portentByTarget).length ? {portentByTarget} : {}),
        ...(Object.keys(evasionByTarget).length ? {evasionByTarget} : {}),
        outcomesByTarget: saveOutcomes}} : {}),
      ...(definition?.check ? {check: {...actionCheckInput(actor, definition.check, sourceToken),
        ...(ownInspiration ? {inspiration: ownInspiration} : {}), ...(ownPortent ? {portent: ownPortent} : {})}} : {}),
      ...(definition?.summon && Array.isArray(intent.summon?.points) ? {summonPoints: intent.summon.points.slice(0, 20)
        .map(point => ({x: Number(point?.x), y: Number(point?.y)}))
        .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))} : {}),
      // Rules consume plain effective snapshots; commit retains the exact live (possibly synthetic) Actors.
      durability: {targetSystems, ...(Object.keys(targetProfiles).length ? {adjustmentProfiles: targetProfiles} : {}),
        ...(Object.keys(zeroHpByTarget).length ? {zeroHpByTarget} : {}),
        ...(onReduce ? {onReduce: {...onReduce, hostileKeys}} : {})},
      configuration: clonePlainData(intent.configuration ?? null, "intent.configuration"),
      ...(concentration ? {concentration: concentration.input} : {}),
      ...(area.persistentArea ? {persistentArea: area.persistentArea} : {}),
      ...(areaMove ? {areaMove: areaMove.move} : {}),
      ...(landing?.ok ? {teleport: {sceneId: sourceToken.parent.id, tokenId: sourceToken.id, ...landing.position}} : {}),
      // A new concentration ends the caster's earlier one once it completes: what it sustains now, by uuid.
      ...(startsConcentration(definition) ? {endsConcentration: sustainedEffects(actor, game).map(({effect}) => effect.uuid)} : {}),
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
    // Damage and healing are planned on fresh snapshots of these Actors (a resolution may wait on a prompt).
    services: {...(reactions?.services ?? {}), targetActors, snapshotActor: foundryActorSystemSnapshot,
      damageProfileOf: actor => clonePlainData(actor.getDamageProfile?.() ?? null, "target.damageProfile"),
      redirectCandidates: options => redirectCandidates(scene, game, targetActors, options)}
  };
}

/**
 * The creatures on `scene` a reaction may move damage to (Cloud Rune, Protective Bond): the Tokens named (`tokenIds`), or
 * those within `range` feet of the Token `around` other than it and `exclude`. Each is a damage target with what planning
 * needs (its snapshot, resistances and 0-HP rescue, under the keys it is committed by), and is committed on like a target.
 */
export function redirectCandidates(scene, game, targetActors, {tokenIds=null, around=null, range=5, exclude=[]}={}) {
  const tokens = scene?.tokens ? [...(scene.tokens.values?.() ?? scene.tokens)] : [];
  const from = around ? tokens.find(token => token.id === around) ?? null : null;
  const grid = from ? createFoundryV14TacticalGridAdapter({scene}) : null;
  const footprintOf = token => { const result = grid.tokenToFootprint(token); return result.ok ? result.footprint : null; };
  const origin = from ? footprintOf(from) : null;
  // Any creature, friend or foe, by the distance between their spaces.
  const within = token => { const to = origin ? footprintOf(token) : null;
    return !!to && (footprintDistance(origin, to) * (Number(scene.grid?.distance) || 5) <= Number(range)); };
  return tokens.filter(token => token.actor && (tokenIds ? tokenIds.includes(token.id) : (from && (token.id !== around)
    && !exclude.includes(token.id) && within(token))))
    .flatMap(token => {
      const actor = token.actor;
      let actorSystem;
      try { actorSystem = foundryActorSystemSnapshot(actor); } catch { return []; }
      const keys = targetControllerKeys(actor, {tokenId: token.id, sceneId: scene.id}, game);
      for ( const key of keys ) targetActors[key] ??= actor;
      return [{target: {id: actor.id ?? null, actorId: actor.id ?? null, actorRef: actor.uuid ?? null, uuid: actor.uuid ?? null,
        tokenId: token.id, name: token.name ?? actor.name ?? ""}, keys, actorSystem,
      // Its AC, for an attack that becomes its (Cloud Rune: "using the same roll").
      ac: resolveActorDefense(actor, "ac")?.value ?? null,
      profile: clonePlainData(actor.getDamageProfile?.() ?? null, "redirect.damageProfile"), zeroHp: zeroHpFor(actor, actorSystem)}];
    });
}

/**
 * What an Action with `ends` ends on its targets once it completes (Remove Curse: effects tagged "curse"; Dispel Magic:
 * spells up to the level it was cast at). For a spell above that level its caster makes an ability check with its
 * spellcasting ability, DC 10 + that spell's level (2024 Dispel Magic), rolled as a sheet check (its bonuses, the
 * table's dice policy), and the spell ends on a success; the GM is told which ended and which stayed. Returns the ids it
 * deleted, by target.
 * shortcut: a lasting area or an object is not a target; upgrade when areas can be targeted.
 */
export async function endEffectsOnTargets({options, state}={}, {fromUuid=globalThis.fromUuid, game=globalThis.game}={}) {
  const ends = state?.actionDefinition?.ends;
  if ( !ends ) return {};
  const tags = new Set(ends.tags ?? []);
  const limit = ends.spells === "slot" ? Number(state.configuration?.castingLevel ?? state.actionDefinition?.metadata?.spellLevel)
    : Number(ends.spells);
  const source = await fromUuid?.(String(state.source?.tokenRef ?? ""));
  const scene = source?.parent ?? null;
  const ended = {};
  const beyond = [];
  const targets = state.targets?.length ? state.targets
    : (state.results?.targetResolution?.targetContexts ?? []).map(context => context?.target?.target ?? context?.target);
  for ( const target of targets ) {
    const actor = scene?.tokens?.get?.(String(target?.tokenId ?? ""))?.actor;
    if ( !actor?.effects ) continue;
    const ids = [];
    for ( const effect of actor.effects ) {
      const metadata = effect.flags?.wildpath?.conditionEffect?.metadata ?? {};
      const level = Number(metadata.spellLevel);
      if ( (metadata.tags ?? []).some(tag => tags.has(tag)) ) ids.push(effect.id);
      else if ( Number.isFinite(limit) && Number.isFinite(level) ) {
        if ( level <= limit ) ids.push(effect.id);
        else beyond.push({actor, effect, level});
      }
    }
    // Above the level it was cast at: its caster's check for each, DC 10 + that spell's level.
    const caster = options?.actor ?? null;
    const ability = caster?.system?.spellcasting?.ability || null;
    for ( const entry of beyond.filter(entry => entry.actor === actor) ) {
      const total = (ability && (typeof caster?.rollTest === "function")) ? await caster.rollTest({ability}) : null;
      entry.total = total;
      entry.ended = Number.isFinite(Number(total)) && (Number(total) >= (10 + entry.level));
      if ( entry.ended ) ids.push(entry.effect.id);
    }
    if ( ids.length ) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
    ended[actor.uuid] = ids;
  }
  const line = entry => game?.i18n?.format?.(entry.ended ? "WILDPATH.NOTIFY.DispelEnded" : "WILDPATH.NOTIFY.DispelStayed",
    {name: entry.effect.name ?? "", level: entry.level, dc: 10 + entry.level, total: entry.total ?? "-"}) ?? entry.effect.name;
  if ( beyond.length ) await globalThis.ChatMessage?.create?.({content: beyond.map(entry => `<p>${line(entry)}</p>`).join(""),
    whisper: game?.users?.filter?.(user => user.isGM)?.map?.(user => user.id) ?? []});
  return ended;
}

/** The Action, Bonus Action or Reaction each economy capability spends (a counted resource stores what was spent). */
const WASTED_RESOURCES = Object.freeze({"action": "action", "bonus-action": "bonus", "reaction": "reaction"});

/**
 * An Action a reaction countered (2024 Counterspell): "the action, Bonus Action, or Reaction used to cast it is
 * wasted", but a spell slot is not expended. Its creature spends those, and a public line says what stopped it.
 * Returns the resources spent, or null for any other cancellation.
 */
export async function afterCountered({options, state}={}, {game=globalThis.game}={}) {
  const countered = [...(state?.warnings ?? [])].reverse().find(warning => warning?.code === "COUNTERED");
  const actor = options?.actor ?? null;
  if ( !countered || !actor?.update ) return null;
  const updates = {};
  for ( const cost of state.actionDefinition?.costs?.allOf ?? [] ) {
    const key = WASTED_RESOURCES[cost?.capability];
    const resource = key ? actor.system?.resources?.[key] : null;
    if ( !resource || !Number.isFinite(Number(resource.spent)) ) continue;
    updates[`system.resources.${key}.spent`] = Math.min(Number(resource.max) || 0, Number(resource.spent) + (Number(cost.amount) || 1));
  }
  if ( Object.keys(updates).length ) await actor.update(updates);
  const name = options?.action?.name ?? state.actionDefinition?.label ?? "";
  await globalThis.ChatMessage?.create?.({speaker: {alias: actor.name},
    content: `<p>${game?.i18n?.format?.("WILDPATH.NOTIFY.Countered", {action: name, reason: countered.reason ?? ""})
      ?? `${name}: ${countered.reason ?? ""}`}</p>`});
  return updates;
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
  const formRef = chosenFormRef(spec, state.configuration?.choices);
  const form = formRef ? await fromUuid?.(formRef) : null;
  if ( !form ) {
    gmNotice("WILDPATH.NOTICE.FormMissing", {}, formRef);
    return null;
  }
  const policy = {...(spec.takes ? {takes: spec.takes} : {}), ...(spec.keepItemTypes ? {keepItemTypes: spec.keepItemTypes} : {})};
  if ( !spec.targets ) {
    // 2014 Wild Shape: the form's Hit Points as Temporary Hit Points, reverting once they are gone (its limits were
    // checked when it was used).
    // It lasts a share of its class's level (Wild Shape: half the druid level, in hours, rounded down).
    const levels = Number(actor.system?.classes?.find?.(entry => entry.id === spec.duration?.class)?.level) || 0;
    const value = spec.duration ? Math.floor(levels * (Number(spec.duration.perLevel) || 0)) : 0;
    return actor.transform(form, {...policy, ...((spec.temporaryHealth === "form")
      ? {temporaryHealth: Number(form.system?.resources?.health?.max) || 0, untilTemporaryHealthLost: true} : {}),
    ...(value > 0 ? {duration: {value, units: spec.duration.units ?? "hours"}} : {})});
  }
  // Polymorph: each creature that failed its save takes the form, unless the form's Challenge Rating is above its own
  // (or its level). It gains the form's Hit Points as Temporary Hit Points, and reverts when they are gone or when its
  // caster's concentration ends.
  const source = await fromUuid?.(String(state.source?.tokenRef ?? ""));
  const scene = source?.parent ?? null;
  const rank = creature => Number(creature?.system?.details?.level ?? creature?.system?.details?.threat) || 0;
  const transformed = [];
  for ( const entry of state.results?.saveResolution?.results ?? [] ) {
    const target = (entry.ok && (entry.success === false)) ? scene?.tokens?.get?.(String(entry.target?.tokenId ?? ""))?.actor : null;
    if ( !target?.transform ) continue;
    if ( rank(form) > Math.max(rank(target), 0) ) {
      gmNotice("WILDPATH.NOTICE.FormTooStrong", {form: form.name ?? "", name: target.name ?? ""});
      globalThis.ui?.notifications?.warn?.(globalThis.game?.i18n?.format?.("WILDPATH.TRANSFORMATION.TooMighty",
        {form: form.name, target: target.name}) ?? `${form.name} is beyond ${target.name}.`);
      continue;
    }
    transformed.push(await target.transform(form, {...policy,
      temporaryHealth: (spec.temporaryHealth === "form") ? (Number(form.system?.resources?.health?.max) || 0) : 0,
      untilTemporaryHealthLost: spec.temporaryHealth === "form",
      concentrationRef: (spec.concentration && source?.id) ? `token:${source.id}` : null}));
  }
  return transformed;
}

/**
 * A concentration spell that sustains nothing automated (`concentration`, Fog Cloud): a marker on its caster names the
 * caster's Token as its concentration source, for the spell's duration, so a new concentration, a failed
 * concentration check or Incapacitated ends it like any concentration.
 */
export async function markCasterConcentration({options, state}={}, {game=globalThis.game}={}) {
  const concentration = state?.actionDefinition?.concentration;
  const actor = options?.actor ?? null;
  const tokenId = state?.source?.tokenId ?? null;
  if ( !concentration || !tokenId || (typeof actor?.createEmbeddedDocuments !== "function") ) return null;
  const label = state.actionDefinition.label ?? "";
  const name = game?.i18n?.format?.("WILDPATH.AREA.Concentrating", {area: label}) ?? label;
  const duration = concentration.duration ? {value: concentration.duration.value, units: concentration.duration.units} : null;
  // Extended Spell: Advantage on the Concentration saves it calls for.
  const system = concentration.advantage ? {ruleElements: [{schemaVersion: 1, id: "extended-concentration", type: "RollMode",
    data: {domains: ["concentration"], mode: "advantage"}}]} : {};
  const [effect] = await actor.createEmbeddedDocuments("ActiveEffect", [{name, type: "effect", system,
    ...(duration ? {duration} : {}),
    flags: {wildpath: {concentrationMarker: true, conditionEffect: {concentration: {sourceRef: `token:${tokenId}`}}}}}]) ?? [];
  return effect ?? null;
}

/**
 * A spell cast with a slot this combat turn, other than a Divine Smite (tagged `smite`): its creature's
 * `flags.wildpath.slotSpellTurn` becomes that turn, which Paladin's Smite's 2014 smite reads (reaction provider).
 * Outside combat nothing is recorded.
 */
export async function recordSlotSpell({options, state}={}, {game=globalThis.game}={}) {
  const tags = state?.actionDefinition?.tags ?? [];
  const actor = options?.actor ?? null;
  const turn = game?.combat?.started ? turnKey(game.combat) : null;
  if ( !turn || (typeof actor?.setFlag !== "function") || !tags.includes("spell") || tags.includes("smite") ) return;
  const paid = state.results?.paymentResolution?.paymentPlan?.resources ?? [];
  if ( !paid.some(entry => String(entry?.resourceId ?? "").includes("spell-slot.")) ) return;
  if ( actor.flags?.wildpath?.slotSpellTurn !== turn ) await actor.setFlag("wildpath", "slotSpellTurn", turn);
}

/** The spell an Action is part of: its converted source (a spell's Actions, its follow-ups included, share it). */
const spellKey = action => action?.flags?.wildpath?.source?.id ?? null;

/**
 * A spell cast with a slot: the level, kept on its caster under the spell (`flags.wildpath.castLevels`), for its
 * follow-ups (castLevelChoices).
 */
export async function recordCastLevel({options, state}={}) {
  const actor = options?.actor ?? null;
  const key = spellKey(options?.action);
  const level = Number(state?.configuration?.castingLevel);
  if ( !key || !Number.isFinite(level) || !(state?.actionDefinition?.tags ?? []).includes("spell") || (typeof actor?.setFlag !== "function") ) return;
  if ( actor.flags?.wildpath?.castLevels?.[key] !== level ) await actor.setFlag("wildpath", `castLevels.${key}`, level);
}

/**
 * A follow-up's `fromCast` choices (Flame Blade's attack, Move Mark): the level its spell was last cast at by this
 * creature, else the lowest it offers (its spell's own level). Null when it has none.
 */
export function castLevelChoices(definition, action, actor) {
  const choices = (definition?.configuration ?? []).filter(choice => choice?.fromCast);
  if ( !choices.length ) return null;
  const recorded = Number(actor?.flags?.wildpath?.castLevels?.[spellKey(action)]);
  return Object.fromEntries(choices.map(choice => {
    const levels = (choice.options ?? []).map(option => Number(option.value)).filter(Number.isFinite);
    return [choice.id, levels.includes(recorded) ? recorded : Math.min(...levels)];
  }));
}

/**
 * A spell cast with Quickened Spell this combat turn: its creature's `flags.wildpath.quickenedTurn` becomes that turn,
 * and it can't cast another spell of level 1+ this turn (the authority refuses it; the action bar greys it).
 */
export async function recordQuickened({options, state}={}, {game=globalThis.game}={}) {
  const actor = options?.actor ?? null;
  const turn = combatTurnKey(game);
  const choices = state?.configuration?.choices;
  const metamagic = Array.isArray(choices) ? choices.find(choice => choice?.id === "metamagic")?.value : choices?.metamagic;
  if ( !turn || (metamagic !== "quickened") || (typeof actor?.setFlag !== "function") ) return;
  if ( actor.flags?.wildpath?.quickenedTurn !== turn ) await actor.setFlag("wildpath", "quickenedTurn", turn);
}

/**
 * An attack roll made this combat turn: its creature's `flags.wildpath.attackTurn` becomes that turn, which Reckless
 * Attack's `requires` reads ("your first attack roll on your turn": requiresContext). Outside combat nothing is recorded.
 */
export async function recordAttackTurn({options, state}={}, {game=globalThis.game}={}) {
  const actor = options?.actor ?? null;
  const turn = combatTurnKey(game);
  if ( !turn || (typeof actor?.setFlag !== "function") || !state?.results?.attackResolution?.ok ) return;
  if ( actor.flags?.wildpath?.attackTurn !== turn ) await actor.setFlag("wildpath", "attackTurn", turn);
}

/**
 * The form a transform names: fixed, or its configuration choice's option (a resolved configuration lists selections,
 * each naming its choice; a used one maps choice ids to the option).
 */
function chosenFormRef(spec, choices) {
  const chosen = !spec.choiceId ? null : Array.isArray(choices) ? choices.find(entry => entry?.id === spec.choiceId)
    : choices?.[spec.choiceId];
  return spec.formRef ?? (typeof chosen === "string" ? chosen : chosen?.value ?? chosen?.optionId ?? null);
}

/**
 * Why a form is beyond its creature's limits, or null (2014 Wild Shape: CR 1/4 and no Fly or Swim Speed until druid
 * level 4, CR 1/2 and no Fly Speed until 8, then CR 1). `limits`: `{class, rows: {level: {cr, fly, swim}}}`; the row for
 * its class level. A row without `swim` allows swimming.
 */
export function formBeyondLimits(limits, actor, form) {
  if ( !limits?.rows ) return null;
  const level = (actor?.system?.classes ?? []).filter(entry => (entry?.id ?? entry?.identifier) === limits.class)
    .reduce((sum, entry) => sum + (Number(entry.level ?? entry.levels) || 0), 0);
  const row = Object.entries(limits.rows).filter(([at]) => Number(at) <= level).sort((a, b) => Number(b[0]) - Number(a[0]))[0]?.[1];
  const name = form?.name ?? "";
  if ( !row ) return `${name}: no form yet at ${limits.class} level ${level}.`;
  const challenge = Number(form?.flags?.wildpath?.source?.challenge ?? form?.system?.details?.threat ?? 0);
  if ( challenge > Number(row.cr) ) return `${name} (CR ${challenge}) is beyond CR ${row.cr} at ${limits.class} level ${level}.`;
  const moves = mode => [...(form?.items ?? [])].some(item => (item.system?.ruleElements ?? [])
    .some(rule => (rule.type === "GrantMovement") && (rule.data?.mode === mode)));
  if ( !row.fly && moves("fly") ) return `${name} has a Fly Speed, not allowed at ${limits.class} level ${level}.`;
  if ( (row.swim === false) && moves("swim") ) return `${name} has a Swim Speed, not allowed at ${limits.class} level ${level}.`;
  return null;
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
  const sustained = sustainedEffects(actor, game);
  for ( const holder of new Set(sustained.map(entry => entry.holder)) ) {
    await holder.deleteEmbeddedDocuments("ActiveEffect", sustained.filter(entry => entry.holder === holder).map(entry => entry.effect.id));
  }
  return sustained.map(entry => entry.effect.uuid);
}

/**
 * Every effect `actor` sustains by concentration, on any creature, with that creature (`{holder, effect}`): its
 * spells' effects and its lasting areas' and summons' markers (whose ending removes the Region or the summons).
 */
export function sustainedEffects(actor, game=globalThis.game) {
  if ( !actor?.uuid ) return [];
  const refs = creatureRefs(actor, game);
  const holders = new Set([...collectionContents(game?.actors),
    ...collectionContents(game?.scenes).flatMap(scene => collectionContents(scene.tokens).map(token => token.actor).filter(Boolean))]);
  // A spell's effect names its casting Item (`uuid:Actor.<id>.Item.<id>`); a marker names the caster's Token.
  const sustains = effect => {
    const ref = String(effect?.flags?.wildpath?.conditionEffect?.concentration?.sourceRef ?? "").replace(/^uuid:/, "");
    return Boolean(ref) && (refs.has(ref) || [...refs].some(owner => ref.startsWith(`${owner}.`)));
  };
  return [...holders].flatMap(holder => collectionContents(holder.effects).filter(sustains).map(effect => ({holder, effect})));
}

/**
 * Whether completing an Action starts a new concentration (2024: casting another concentration spell ends the
 * one you have): an effect, lasting area or summon it sustains. A converted follow-up of the same spell (Move Mark,
 * `metadata.followUp`) continues its concentration instead.
 */
export function startsConcentration(definition) {
  if ( !definition || definition.metadata?.followUp ) return false;
  return (definition.effects ?? []).some(effect => effect?.concentration) || Boolean(definition.area?.persistence?.concentration)
    || Boolean(definition.summon?.concentration) || Boolean(definition.transform?.concentration) || Boolean(definition.concentration);
}

/** The caster's earlier concentration, as it stood when this Action was declared (`endsConcentration`), ends now. */
export async function endEarlierConcentration({options}={}, {fromUuid=globalThis.fromUuid}={}) {
  const ended = [];
  for ( const uuid of options?.endsConcentration ?? [] ) {
    const effect = await fromUuid?.(uuid);
    if ( !effect ) continue;
    await effect.delete();
    ended.push(uuid);
  }
  return ended;
}

/**
 * 2024 advantage and disadvantage on an attack roll: the attacker's own (`attack`, `attack.<type>`, the Action's
 * included) and the first target's on attacks against it (`attacked`, `attacked.<type>`), combined so any of
 * each cancel. Predicates see `attack.type` and `attack.adjacent` (the attacker within 5 ft).
 */
/** Each source of an attack's Advantage or Disadvantage against its first target (a reroll adds one more). */
function foundryAttackRollModeSources({actor, action, definition, targetEntries, spatial, game, sourceToken}) {
  const type = definition.attack.type ?? null;
  const target = targetEntries[0] ?? null;
  // Its rules see the Action's tags (Innate Sorcery: Advantage on spell attacks).
  return attackRollModeSources(actor, target?.actor, {type, item: action, ability: attackAbility(actor, definition.attack),
    context: {...attackContext(type, spatial, target, game, sourceToken, actor), tags: definition.tags ?? []}});
}

/**
 * High ground (Baldur's Gate 3, the `highGround` world setting, off by default): +2 to an attack roll from 8 feet or more
 * above its target, -2 from 8 feet or more below. Measured between the Tokens' elevations.
 */
export function highGroundBonus(attackerElevation, targetElevation) {
  const difference = (Number(attackerElevation) || 0) - (Number(targetElevation) || 0);
  return difference >= 8 ? 2 : (difference <= -8 ? -2 : 0);
}

function highGroundOn(game) {
  try { return game?.settings?.get("wildpath", "highGround") === true; } catch (_error) { return false; }
}

/** Each target's high-ground bonus, keyed by Token like the targets; null when the setting is off or none applies. */
function foundryAttackBonuses({targets, targetEntries, game, sourceToken}) {
  if ( !sourceToken ) return null;
  const high = highGroundOn(game);
  const bonuses = {};
  targetEntries.forEach((entry, index) => {
    const token = high ? resolveFoundryTargetToken({actor: entry.actor, hint: entry.hint, game, preferredSceneId: sourceToken.parent?.id ?? null}) : null;
    // Its own Modifiers on attacks against it (Sundering Blow's +5), seeing which of its effects this attacker gave it
    // (`from:<status>`: not the barbarian's own attacks).
    const from = sourceToken.actor ? Object.keys(conditionsFrom(entry.actor, sourceToken.actor, game)).map(id => `from:${id}`) : [];
    const own = Number(entry.actor?.getStatistic?.("attacked", {tags: from})?.totalModifier) || 0;
    // Its cover raises its AC: the attack roll is that much lower against it.
    const bonus = (token ? highGroundBonus(sourceToken.elevation, token.elevation) : 0) + own - (COVER_BONUS[entry.cover ?? "none"] ?? 0);
    if ( bonus ) bonuses[targets[index].tokenId ?? targets[index].id] = bonus;
  });
  return Object.keys(bonuses).length ? bonuses : null;
}

/** Outcomes forced on hits against each target (`critical-on-hit`), keyed by Token like the targets. */
function foundryAttackOutcomes({definition, targets, targetEntries, spatial, game, sourceToken}) {
  const type = definition.attack.type ?? null;
  const outcomes = {};
  targetEntries.forEach((entry, index) => {
    if ( attackForcesCritical(entry.actor, {type, context: attackContext(type, spatial, entry, game, sourceToken)}) ) {
      outcomes[targets[index].tokenId ?? targets[index].id] = "critical-on-hit";
    }
  });
  return Object.keys(outcomes).length ? outcomes : null;
}

/**
 * What RuleElement predicates see about an attack on one target: its type, whether it is within 5 ft, the
 * conditions the attacker has from that target (`fromTarget.grappled`) and the target from the attacker
 * (`fromAttacker`, a Vex), whether one of the attacker's allies
 * stands within 5 ft of it (`allyNearTarget`, Pack Tactics), and whether the attacker stands in sunlight (`inSunlight`).
 */
/** Whether a creature is missing Hit Points (Colossus Slayer). */
function targetDamaged(actor) {
  const health = actor?.system?.resources?.health;
  return Number.isFinite(Number(health?.value)) && (Number(health.value) < Number(health.max));
}

function attackContext(type, spatial, entry, game, sourceToken, attacker=null) {
  const token = entry ? resolveFoundryTargetToken({actor: entry.actor, hint: entry.hint, game,
    preferredSceneId: sourceToken?.parent?.id ?? null}) : null;
  const source = spatial?.context?.sourceFootprint ?? null;
  const footprint = source && token?.parent
    ? createFoundryV14TacticalGridAdapter({scene: token.parent}).tokenToFootprint(token) : null;
  const fields = footprint?.ok && footprint.footprint ? footprintDistance(source, footprint.footprint) : null;
  const distance = Number.isFinite(fields) ? fields * spatial.context.gridDistance : null;
  const sight = (attacker && entry?.actor) ? attackSight({attacker, target: entry.actor, attackerToken: sourceToken, targetToken: token,
    distance}) : {};
  return {attack: {type, ...(Number.isFinite(fields) ? {adjacent: fields * spatial.context.gridDistance <= 5} : {}), ...sight,
    fromTarget: conditionsFrom(attacker, entry?.actor, game), fromAttacker: conditionsFrom(entry?.actor, attacker, game),
    allyNearTarget: allyNearTarget(sourceToken, token), targetDamaged: targetDamaged(entry?.actor),
    // An ally of the attacker Helped against this target (2024 Help: its Distracted).
    helpedByAlly: helpedByAlly(sourceToken, entry?.actor),
    // What it is (2024: a Mace of Disruption's Fiend or Undead).
    targetType: entry?.actor?.system?.details?.type || null,
    // ... and what attacks it (Protection from Evil and Good).
    attackerType: attacker?.system?.details?.type || null},
    ...sunlightContext(sourceToken), ...fearContext(sourceToken)};
}

/**
 * A creature's Legendary Resistance for one save: one use of its `legendary-resistance` pool, paid by it, and its
 * policy (`flags.wildpath.commonPolicies["legendary-resistance"]`: always, ask (the default) or never). Null when it
 * has no use left.
 */
function legendaryResistanceFor(actor, actorSystem, game) {
  const policy = actor.flags?.wildpath?.commonPolicies?.["legendary-resistance"] ?? "ask";
  if ( policy === "never" ) return null;
  const payment = resolveActorResourcePayment({actorSystem, cost: {allOf: [{capability: "legendary-resistance", amount: 1}]}});
  if ( !payment.ok ) return null;
  const pool = (actorSystem?.pools ?? []).find(entry => entry.id === "legendary-resistance") ?? {};
  const label = game?.i18n?.format?.("WILDPATH.LEGENDARY.Prompt", {name: actor.name ?? "", value: pool.value ?? 0, max: pool.max ?? 0}) ?? null;
  return {policy, payerRef: actor.uuid, plan: payment.mutationPlan, ...(label ? {label} : {})};
}

/**
 * Heroic Inspiration for a d20 that `roller` rolls (BG3, G8):
 * - a player's character may spend its own point after a failure (`own`); its controller (`chooser`) is asked;
 * - for a monster's roll, the GM may spend any player character's point, while the `inspirationMonsterRerolls` world
 *   setting is on.
 * Each option carries its payer's payment plan. Null when nobody can pay.
 */
export function inspirationOffer(roller, rollerSystem, game, {chooser, payers=() => []}={}) {
  const {pool, max} = WILDPATH.HEROIC_INSPIRATION;
  const format = (key, data) => game?.i18n?.format?.(key, data) ?? key;
  const option = (payer, system) => {
    const payment = resolveActorResourcePayment({actorSystem: system, cost: {allOf: [{capability: pool, amount: 1}]}});
    if ( !payment.ok ) return null;
    const value = (system?.pools ?? []).find(entry => entry.id === pool)?.value ?? 0;
    return {value: `spend:${payer.uuid}`, payerRef: payer.uuid, plan: payment.mutationPlan,
      label: format("WILDPATH.INSPIRATION.Spend", {name: payer.name ?? "", value, max})};
  };
  if ( roller?.hasPlayerOwner ) {
    const own = option(roller, rollerSystem);
    return own ? {own: true, chooser, label: format("WILDPATH.INSPIRATION.Own", {name: roller.name ?? ""}), options: [own]} : null;
  }
  const options = payers().flatMap(payer => {
    try { return [option(payer, foundryActorSystemSnapshot(payer))].filter(Boolean); }
    catch { return []; }
  });
  return options.length ? {own: false, chooser: ROLL_AUTHORITY.GM, label: format("WILDPATH.INSPIRATION.Monster", {name: roller?.name ?? ""}),
    options} : null;
}

/**
 * Dice its effects let a creature add to a failed d20 test (2024 Bardic Inspiration: "roll the Bardic Inspiration die
 * and add the number rolled"): an option each, added to its own offer (or an offer alone). The die is worked out from
 * the creature that gave it (a bard's level), and using it ends the effect (`payment`: a condition removal plan).
 */
export function withAddedDice(offer, roller, game, {chooser, target}={}) {
  if ( offer && !offer.own ) return offer;
  const format = (key, data) => game?.i18n?.format?.(key, data) ?? key;
  const options = [];
  for ( const effect of roller?.effects ?? [] ) {
    const flag = effect?.flags?.wildpath?.conditionEffect;
    const die = flag?.metadata?.addDie;
    if ( effect.disabled || !die || !flag.conditionId ) continue;
    const giver = globalThis.fromUuidSync?.(String(flag.sourceRef ?? "").replace(/^uuid:/, ""));
    const giverActor = giver?.documentName === "Actor" ? giver : giver?.actor ?? giver?.parent ?? null;
    const faces = evaluateValueExpression(die.faces, {actor: giverActor ?? roller, actorSystem: (giverActor ?? roller)?.system});
    if ( !faces.ok || !(faces.value > 0) ) continue;
    options.push({value: `add:${effect.id}`, addDice: {number: 1, faces: faces.value},
      label: format("WILDPATH.INSPIRATION.AddDie", {name: effect.name, faces: faces.value}),
      payment: {type: "conditionEffect", conditionId: flag.conditionId, levels: -1, action: "delete", stacking: false,
        existingEffectId: effect.id, target: clonePlainData(target, "target"), definition: {id: flag.conditionId, custom: true},
        metadata: {}}});
  }
  if ( !options.length ) return offer;
  return offer ? {...offer, options: [...offer.options, ...options]}
    : {own: true, chooser, label: format("WILDPATH.INSPIRATION.OwnTest", {name: roller?.name ?? ""}), options};
}

/**
 * 2024 Indomitable: "If you fail a saving throw, you can reroll it with a bonus equal to your Fighter level", once per use
 * of its pool. Added to the creature's own reroll offer (beside Heroic Inspiration), or its offer alone.
 */
export function withIndomitable(offer, roller, rollerSystem, game) {
  const pool = (rollerSystem?.pools ?? []).find(entry => entry.id === "indomitable");
  if ( !(Number(pool?.value) > 0) || (offer && !offer.own) ) return offer;
  const payment = resolveActorResourcePayment({actorSystem: rollerSystem, cost: {allOf: [{capability: "indomitable", amount: 1}]}});
  if ( !payment.ok ) return offer;
  const level = (rollerSystem?.classes ?? []).filter(entry => (entry?.id ?? entry?.identifier) === "fighter")
    .reduce((sum, entry) => sum + (Number(entry.level ?? entry.levels) || 0), 0);
  const format = (key, data) => game?.i18n?.format?.(key, data) ?? key;
  const option = {value: `indomitable:${roller.uuid}`, payerRef: roller.uuid, plan: payment.mutationPlan, bonus: level,
    label: format("WILDPATH.INSPIRATION.Indomitable", {bonus: level, value: pool.value})};
  return offer ? {...offer, options: [...offer.options, option]}
    : {own: true, chooser: ROLL_AUTHORITY.TARGET_CONTROLLER, label: format("WILDPATH.INSPIRATION.OwnSave", {name: roller?.name ?? ""}),
      options: [option]};
}

/**
 * 2024 Tactical Mind (fighter level 2): when it fails an ability check, it may expend a use of Second Wind to roll 1d10
 * and add it; if the check still fails, the use is not expended (`refundOnFail`).
 */
export function withTacticalMind(offer, roller, rollerSystem, game) {
  const pool = (rollerSystem?.pools ?? []).find(entry => entry.id === "second-wind");
  const level = (rollerSystem?.classes ?? []).filter(entry => (entry?.id ?? entry?.identifier) === "fighter")
    .reduce((sum, entry) => sum + (Number(entry.level ?? entry.levels) || 0), 0);
  if ( (level < 2) || !(Number(pool?.value) > 0) || (offer && !offer.own) ) return offer;
  const payment = resolveActorResourcePayment({actorSystem: rollerSystem, cost: {allOf: [{capability: "second-wind", amount: 1}]}});
  if ( !payment.ok ) return offer;
  const format = (key, data) => game?.i18n?.format?.(key, data) ?? key;
  const option = {value: `tactical-mind:${roller.uuid}`, addDice: {number: 1, faces: 10}, payerRef: roller.uuid, plan: payment.mutationPlan,
    refundOnFail: true, label: format("WILDPATH.INSPIRATION.TacticalMind", {value: pool.value})};
  return offer ? {...offer, options: [...offer.options, option]}
    : {own: true, chooser: ROLL_AUTHORITY.SOURCE_CONTROLLER, label: format("WILDPATH.INSPIRATION.OwnTest", {name: roller?.name ?? ""}),
      options: [option]};
}

/** Its reward for reducing a creature to 0 Hit Points (Dark One's Blessing: Temporary Hit Points), or null. */
function reducedToZeroFor(actor, actorSystem) {
  for ( const item of actor?.items ?? [] ) {
    if ( item?.system?.active === false ) continue;
    const rule = (item?.system?.ruleElements ?? []).find(entry => (entry?.type === "Trigger") && (entry.data?.event === "health.reduced"));
    if ( !rule ) continue;
    const amount = Math.trunc(Number(evaluateValueExpression(rule.data.temporaryHitPoints, {actor, actorSystem}).value) || 0);
    if ( amount > 0 ) return {name: item.name ?? "", temporaryHitPoints: amount, hostileOnly: rule.data.hostileOnly === true,
      sourceRef: actor.uuid};
  }
  return null;
}

/** Whether two Tokens stand on opposite sides (one friendly, the other hostile or secret). */
function hostileTo(sourceToken, targetToken) {
  const source = Number(sourceToken?.document?.disposition ?? sourceToken?.disposition);
  const target = Number(targetToken?.document?.disposition ?? targetToken?.disposition);
  return Number.isFinite(source) && Number.isFinite(target) && ((source * target) < 0);
}

/**
 * Its features' own dice for a failed d20 test (`flags.wildpath.testOffer: {pool, faces, tests, refundOnFail?}`): 2024
 * Peerless Skill's Bardic Inspiration die on a check or attack roll, kept if it still fails; Dark One's Own Luck's d10 on
 * a check or save. Each is paid with a use of `pool`. Added to its own offer, or an offer alone.
 */
export function withTestOffers(offer, roller, rollerSystem, game, test, {chooser}={}) {
  if ( offer && !offer.own ) return offer;
  const format = (key, data) => game?.i18n?.format?.(key, data) ?? key;
  const options = [];
  for ( const item of roller?.items ?? [] ) {
    const spec = item?.flags?.wildpath?.testOffer;
    // One with a range is offered to its allies too (withAllyTestOffers).
    if ( !spec?.tests?.includes(test) || spec.range || (item.system?.active === false) ) continue;
    // A free one (Halfling Luck) names no pool.
    const payment = spec.pool ? resolveActorResourcePayment({actorSystem: rollerSystem, cost: {allOf: [{capability: spec.pool, amount: 1}]}})
      : {ok: true, mutationPlan: null};
    if ( !payment.ok ) continue;
    // A plain reroll (Disciplined Survivor; Halfling Luck, only on a natural 1: `natural`).
    if ( spec.reroll ) {
      options.push({value: `test-offer:${item.id}`, payerRef: roller.uuid, ...(payment.mutationPlan ? {plan: payment.mutationPlan} : {}),
        ...(Number(spec.natural) > 0 ? {natural: Number(spec.natural)} : {}),
        // Its own Advantage or bonus on the new roll (a homebrew "reroll with Advantage").
        ...(spec.rollMode ? {rollMode: spec.rollMode} : {}), ...(Number(spec.bonus) ? {bonus: Number(spec.bonus)} : {}),
        label: format("WILDPATH.INSPIRATION.RerollWith", {name: item.name ?? ""})});
      continue;
    }
    // Stroke of Luck: the roll becomes a 20 (`setNatural`), with no die of its own.
    if ( Number(spec.setNatural) > 0 ) {
      options.push({value: `test-offer:${item.id}`, setNatural: Number(spec.setNatural), payerRef: roller.uuid, plan: payment.mutationPlan,
        label: format("WILDPATH.INSPIRATION.SetNatural", {name: item.name ?? "", natural: Number(spec.setNatural)})});
      continue;
    }
    const faces = evaluateValueExpression(spec.faces, {actor: roller, actorSystem: rollerSystem});
    if ( !faces.ok || !(faces.value > 0) ) continue;
    options.push({value: `test-offer:${item.id}`, addDice: {number: 1, faces: faces.value}, payerRef: roller.uuid, plan: payment.mutationPlan,
      ...(spec.refundOnFail ? {refundOnFail: true} : {}), label: format("WILDPATH.INSPIRATION.AddDie", {name: item.name ?? "", faces: faces.value})});
  }
  if ( !options.length ) return offer;
  return offer ? {...offer, options: [...offer.options, ...options]}
    : {own: true, chooser, label: format("WILDPATH.INSPIRATION.OwnTest", {name: roller?.name ?? ""}), options};
}

/**
 * 2024 Countercharm: when a creature fails a save against an effect giving one of a feature's conditions (`against`:
 * Charmed, Frightened), it or an ally within the feature's `range` that has it may reroll the save for it with that
 * feature's `rollMode` (Advantage), paying its `pool` (its Reaction). Each paying creature is registered (`register`) so
 * its payment is committed on it. The saver's controller decides (2024 Countercharm has no sight clause).
 */
export function withAllyTestOffers(offer, saverToken, definition, game, test, {chooser, register=() => {}}={}) {
  if ( (offer && !offer.own) || !saverToken?.parent ) return offer;
  const conditions = new Set((definition?.effects ?? []).map(effect => effect?.conditionId).filter(Boolean));
  const format = (key, data) => game?.i18n?.format?.(key, data) ?? key;
  const options = [];
  for ( const token of saverToken.parent.tokens ?? [] ) {
    const bearer = token.actor;
    for ( const item of bearer?.items ?? [] ) {
      const spec = item?.flags?.wildpath?.testOffer;
      if ( !spec?.range || !spec.tests?.includes(test) || (item.system?.active === false) ) continue;
      // One for its allies only (Bountiful Luck: "an ally you can see"), not its own rolls; never an enemy's offer.
      if ( spec.others && (token.id === saverToken.id) ) continue;
      if ( (token.id !== saverToken.id) && hostileTo(token, saverToken) ) continue;
      // Countercharm answers only saves against its conditions; Flash of Genius any check or save.
      if ( spec.against && !spec.against.some(condition => conditions.has(condition)) ) continue;
      const distance = allyDistance(saverToken, token);
      if ( (distance === null) || (distance > Number(spec.range)) ) continue;
      let system;
      try { system = foundryActorSystemSnapshot(bearer); } catch { continue; }
      // Its pool, and its Reaction too when it names one beside it (`reaction`: Flash of Genius).
      const payment = resolveActorResourcePayment({actorSystem: system, cost: {allOf: [{capability: spec.pool, amount: 1},
        ...((spec.reaction && (spec.pool !== "reaction")) ? [{capability: "reaction", amount: 1}] : [])]}});
      if ( !payment.ok ) continue;
      register(bearer);
      // Flash of Genius adds its bearer's modifier (`addAbility`) to the roll; Countercharm rerolls it.
      const added = spec.addAbility ? Math.trunc(Number(evaluateValueExpression({type: "ability-modifier", ability: spec.addAbility},
        {actor: bearer, actorSystem: system}).value) || 0) : 0;
      options.push({value: `ally-offer:${bearer.uuid}:${item.id}`, payerRef: bearer.uuid, plan: payment.mutationPlan,
        ...(spec.rollMode ? {rollMode: spec.rollMode} : {}), ...(spec.addAbility ? {addFlat: added} : {}),
        // Only when the d20 shows this number (Bountiful Luck's 1).
        ...(Number(spec.natural) > 0 ? {natural: Number(spec.natural)} : {}),
        label: format(spec.addAbility ? "WILDPATH.INSPIRATION.AllyAdd" : "WILDPATH.INSPIRATION.AllyReroll", {name: bearer.name ?? "",
          feature: item.name ?? "", value: added})});
    }
  }
  if ( !options.length ) return offer;
  return offer ? {...offer, options: [...offer.options, ...options]}
    : {own: true, chooser, label: format("WILDPATH.INSPIRATION.OwnSave", {name: saverToken.actor?.name ?? ""}), options};
}

/**
 * 2024 Seeking Spell: "If you make an attack roll for a spell and miss, you can spend 1 Sorcery Point to reroll the
 * d20", for a sorcerer who knows it, beside its other rerolls of a missed spell attack.
 */
export function withSeekingSpell(offer, roller, rollerSystem, game) {
  const pool = (rollerSystem?.pools ?? []).find(entry => entry.id === METAMAGIC_POOL);
  if ( !knownMetamagic(roller).has("seeking") || !(Number(pool?.value) > 0) || (offer && !offer.own) ) return offer;
  const payment = resolveActorResourcePayment({actorSystem: rollerSystem, cost: {allOf: [{capability: METAMAGIC_POOL, amount: 1}]}});
  if ( !payment.ok ) return offer;
  const format = (key, data) => game?.i18n?.format?.(key, data) ?? key;
  const option = {value: `seeking:${roller.uuid}`, payerRef: roller.uuid, plan: payment.mutationPlan,
    label: format("WILDPATH.INSPIRATION.SeekingSpell", {value: pool.value})};
  return offer ? {...offer, options: [...offer.options, option]}
    : {own: true, chooser: ROLL_AUTHORITY.SOURCE_CONTROLLER, label: format("WILDPATH.INSPIRATION.OwnTest", {name: roller?.name ?? ""}),
      options: [option]};
}

/**
 * The player characters who may pay for a monster's reroll: those with a Token on the roll's Scene (the table's), each
 * once. None while the GM has turned monster rerolls off.
 */
export function monsterRerollPayers(game, scene) {
  let allowed = true;
  try { allowed = game?.settings?.get?.("wildpath", "inspirationMonsterRerolls") !== false; }
  catch { allowed = true; } // unregistered (a test game)
  if ( !allowed || !scene?.tokens ) return [];
  const tokens = typeof scene.tokens.values === "function" ? [...scene.tokens.values()] : [...scene.tokens];
  return [...new Set(tokens.map(token => token.actor).filter(actor => (actor?.type === "character") && actor.hasPlayerOwner))];
}

/**
 * The save a target makes when its Action lets it choose (`save.abilities`, 2024 Grapple and Shove: "a Strength or
 * Dexterity saving throw (it chooses)"): the one it is likelier to pass against the Action's DC, from its own bonus,
 * cover, Advantage or Disadvantage and automatic failures. Else the Action's one save.
 */
export function bestSaveAbility({definition, targetActor, saverToken, cover="none", actor=null, actorSystem=null}) {
  const save = definition.save ?? {};
  const choices = save.abilities?.length ? save.abilities : [save.ability ?? save.saveKey ?? null];
  if ( choices.length < 2 ) return choices[0];
  const dc = Number(save.dc?.value ?? evaluateValueExpression(save.dc?.valueExpression, {actor, actorSystem}).value) || 10;
  const chance = ability => {
    const context = saveContext(definition, ability, saverToken);
    if ( (targetActor.getRollOutcomes?.(["save", `save.${ability}`], context) ?? []).some(entry => entry.outcome === "automatic-failure") ) return 0;
    const modes = (targetActor.getRollModes?.(["save", `save.${ability}`], context) ?? []).map(entry => entry?.mode ?? entry);
    const bonus = resolveActorSaveStatistic(targetActor, ability);
    const modifier = (bonus?.totalModifier ?? 0) + ((ability === "agility") ? (COVER_BONUS[cover] ?? 0) : 0);
    return d20Chance({modifier, target: dc, rollMode: combineRollModes(modes), dice: bonus?.dice ?? []});
  };
  return choices.reduce((best, ability) => (chance(ability) > chance(best) ? ability : best));
}

/**
 * What a save's RuleElement predicates see: its ability, and the Action's tags. Every spell is `magical` too, so
 * Magic Resistance (`{tagsAny: ["magical"]}`) covers spells and Actions tagged `magical` (a magic item's).
 */
function saveContext(definition, ability, token=null) {
  const tags = definition?.tags ?? [];
  return {context: {save: {ability}, tags: tags.includes("spell") && !tags.includes("magical") ? [...tags, "magical"] : tags,
    ...sunlightContext(token), ...fearContext(token)}};
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
      const rollMode = combineRollModes(foundryAttackRollModeSources({actor, action, definition, targetEntries: [entry], spatial, game, sourceToken}));
      const cover = COVER_BONUS[actionCover({definition, sourceToken, targetToken: entry.token})] ?? 0;
      const total = modifier - cover + ((sourceToken && highGroundOn(game)) ? highGroundBonus(sourceToken.elevation, entry.token.elevation) : 0);
      return [{tokenId: entry.token.id, name: entry.token.name, kind: "attack", modifier: total, defense, rollMode,
        chance: d20Chance({modifier: total, target: defense, rollMode, natural: true, dice: statistics.attack?.dice})}];
    });
  }
  const dc = actionDefinitionToResolverInput(definition, {actorSystem: foundryActorSystemSnapshot(actor)}).save?.dc?.value;
  const ability = definition.save.ability ?? definition.save.saveKey ?? null;
  if ( !Number.isFinite(dc) ) return [];
  return entries.map(({token, actor: target}) => {
    const context = saveContext(definition, ability, token);
    const rollMode = combineRollModes(target.getRollModes?.(["save", `save.${ability}`], context) ?? []);
    const statistic = resolveActorSaveStatistic(target, ability);
    const modifier = (statistic?.totalModifier ?? 0) + ((ability === "agility")
      ? (COVER_BONUS[actionCover({definition, sourceToken, targetToken: token})] ?? 0) : 0);
    const automatic = (target.getRollOutcomes?.(["save", `save.${ability}`], context) ?? [])
      .some(outcome => outcome.outcome === "automatic-failure");
    return {tokenId: token.id, name: token.name, kind: "save", ability, dc, modifier, rollMode, automatic,
      chance: automatic ? 1 : 1 - d20Chance({modifier, target: dc, rollMode, dice: statistic?.dice})};
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
 * After an attack Action, the effects that end on an attack, now that the attack has had them (`endsWhen`): each
 * attacked creature's `attacked` effects (Help's Distracted) and those from the attacker (`attackedBySource`, a Vex),
 * and the attacker's own `attacks` effects (a Sap), and its `hits` effects on a hit. An effect this Action has just applied to a
 * creature it hit stays.
 */
/** Effects that end once their creature makes a saving throw (`endsWhen: "saves"`: Staggering Blow), after an Action's save. */
export async function endEffectsWhenSaved({state}, {fromUuid}) {
  const saved = (state?.results?.saveResolution?.results ?? []).filter(result => result?.ok !== false)
    .map(result => String(result?.target?.tokenId ?? "")).filter(Boolean);
  if ( !saved.length ) return [];
  const sourceToken = await fromUuid(String(state?.source?.tokenRef ?? ""));
  const scene = sourceToken?.parent ?? null;
  const ended = [];
  for ( const tokenId of new Set(saved) ) {
    const actor = scene?.tokens?.get(tokenId)?.actor;
    const effects = [...(actor?.effects ?? [])].filter(effect => effect.flags?.wildpath?.conditionEffect?.definition?.endsWhen === "saves");
    if ( !effects.length ) continue;
    await actor.deleteEmbeddedDocuments("ActiveEffect", effects.map(effect => effect.id));
    ended.push(...effects.map(effect => effect.id));
  }
  return ended;
}

/**
 * Effects that end once their creature makes the ability check they help (Assist: `endsWhen: "checks"`, its Advantage
 * on `check.<skill>`): after an Action's check, or one rolled from the sheet (documents/actor.mjs).
 */
export async function endEffectsWhenChecked(actor, check) {
  if ( !actor?.effects || !check ) return [];
  const domains = new Set(["check", check.ability ? `check.${check.ability}` : null, check.skill ? `check.${check.skill}` : null].filter(Boolean));
  const used = [...actor.effects].filter(effect => (effect.flags?.wildpath?.conditionEffect?.definition?.endsWhen === "checks")
    && (effect.system?.ruleElements ?? []).some(rule => (rule.data?.domains ?? []).some(domain => domains.has(domain))));
  if ( used.length ) await actor.deleteEmbeddedDocuments("ActiveEffect", used.map(effect => effect.id));
  return used.map(effect => effect.id);
}

/**
 * Effects that end when their creature takes damage (Knock Out's Unconscious, `metadata.endsWhen: "damaged"`): any damage
 * this Action dealt it ends them, except the damage of the resolution that applied them (its hit), named in their
 * `metadata.resolutionIds`.
 */
export async function endEffectsWhenDamaged({state}, {fromUuid}) {
  const taken = plan => (Number(plan?.amount) || 0) + Math.max((Number(plan?.temporary?.from) || 0) - (Number(plan?.temporary?.to) || 0), 0);
  const damaged = (state?.mutationPlans ?? []).filter(entry => (entry?.type === "durabilityDamage") && (entry.plan?.ok !== false)
    && (taken(entry.plan) > 0)).map(entry => entry.target).filter(Boolean);
  const ended = [];
  for ( const target of damaged ) {
    const document = await fromUuid(String(target.uuid ?? target.actorRef ?? ""));
    const actor = document?.actor ?? document;
    const effects = [...(actor?.effects ?? [])].filter(effect => {
      const metadata = effect.flags?.wildpath?.conditionEffect?.metadata ?? {};
      return (metadata.endsWhen === "damaged") && !(metadata.resolutionIds ?? []).includes(state.id);
    });
    if ( !effects.length ) continue;
    await actor.deleteEmbeddedDocuments("ActiveEffect", effects.map(effect => effect.id));
    ended.push(...effects.map(effect => effect.id));
  }
  return ended;
}

export async function endEffectsWhenAttacked({state}, {fromUuid}) {
  const attacked = new Map();
  for ( const result of state?.results?.attackResolution?.results ?? [] ) {
    const tokenId = result?.target?.tokenId;
    if ( (result?.ok !== false) && tokenId ) attacked.set(tokenId, attacked.get(tokenId) || (result.hit === true));
  }
  if ( !attacked.size ) return [];
  const sourceToken = await fromUuid(String(state?.source?.tokenRef ?? ""));
  const scene = sourceToken?.parent ?? null;
  const attacker = sourceToken?.actor ?? null;
  const definition = state?.actionDefinition ?? {};
  const applied = new Set((definition.effects ?? []).filter(effect => effect?.type === "effect").map(effect => customEffectId(definition.id, effect)));
  const endsWhen = effect => effect.flags?.wildpath?.conditionEffect?.definition?.endsWhen;
  const ended = [];
  const end = async (actor, effects) => {
    if ( !effects.length ) return;
    await actor.deleteEmbeddedDocuments("ActiveEffect", effects.map(effect => effect.id));
    ended.push(...effects.map(effect => effect.id));
  };
  for ( const [tokenId, hit] of attacked ) {
    const actor = scene?.tokens?.get(tokenId)?.actor;
    if ( !actor ) continue;
    const fromAttacker = new Set(attacker ? effectsFrom(actor, attacker).map(effect => effect.id) : []);
    await end(actor, [...actor.effects].filter(effect => !(hit && [...(effect.statuses ?? [])].some(status => applied.has(status)))
      && ((endsWhen(effect) === "attacked") || ((endsWhen(effect) === "attackedBySource") && fromAttacker.has(effect.id))
        || ((endsWhen(effect) === "attackedByOther") && !fromAttacker.has(effect.id))
        // Help's: only its helper's ally's attack uses it up.
        || ((endsWhen(effect) === "attackedByAllyOfSource") && alliedTokens(sourceToken, effectGiver(effect, actor, scene))))));
  }
  // ... and its `hits` ones once it hit (an injury poison's coat, delivered).
  const hitAny = [...attacked.values()].some(Boolean);
  if ( attacker ) await end(attacker, [...attacker.effects].filter(effect => (endsWhen(effect) === "attacks") || (hitAny && (endsWhen(effect) === "hits"))));
  return ended;
}

/**
 * Where an Action that moves its creature's lasting area (`moveArea`, Moonbeam's Magic action) takes it: the area that
 * creature left with the Action `of`, laid out at the clicked point with its own shape and size, no farther than
 * `distance` feet from where it is. `{ok, move: {sceneId, regionId, fields}}`.
 */
function foundryAreaMove({definition, actor, intent, sourceToken}) {
  const scene = sourceToken?.parent ?? null;
  const found = scene ? ownArea(scene, {of: definition.moveArea.of, actorRef: actor.uuid}) : null;
  if ( !found ) return {ok: false, key: "WILDPATH.REFUSAL.NoArea", reason: "There is no area of yours to move."};
  if ( found.flag.attached ) return {ok: false, key: "WILDPATH.REFUSAL.AreaAttached", reason: "That area moves with its creature."};
  const placed = foundryAreaFootprint({definition: {area: {shape: found.flag.shape, size: {value: found.flag.size, unit: "ft"}},
    targeting: {type: "area"}}, sourceToken, points: intent.area?.points ?? []});
  if ( !placed.ok ) return {ok: false, reason: placed.reason};
  const from = areaFieldsCenter(found.flag.fields, scene);
  const to = areaFieldsCenter(placed.footprint.fields, scene);
  const feet = (from && to) ? scene.grid?.measurePath?.([from, to])?.distance ?? null : null;
  if ( (feet === null) || (feet > Number(definition.moveArea.distance)) ) {
    return {ok: false, key: "WILDPATH.REFUSAL.AreaTooFar", data: {distance: definition.moveArea.distance},
      reason: `The area moves at most ${definition.moveArea.distance} feet.`};
  }
  return {ok: true, move: {sceneId: scene.id, regionId: found.region.id, fields: placed.footprint.fields}};
}

/**
 * An area Action's targets are every creature its covered fields touch, recomputed here from the placement
 * clicks (`intent.area.points`) and the caster's own Token; the client's targets are not consulted.
 * Returns `{ok: true}` without `targetRefs` for an Action that does not target an area.
 */
function foundryActionArea({action, actor, intent, sourceToken}) {
  const result = actionDefinitionFromAction(action, {actorSystem: actor?.system ?? null});
  const own = result.ok ? result.definition : null;
  if ( own?.targeting?.type !== "area" ) return {ok: true};
  if ( !sourceToken?.parent ) return {ok: false, reason: "An area Action needs its caster's Token on a Scene."};
  // Its size as chosen (Confusion's radius grows with the slot), as its caster placed it.
  const chosen = intent.configuration?.choices ? resolveActionConfiguration({definition: own, actorSystem: foundryActorSystemSnapshot(actor),
    choices: intent.configuration.choices}) : null;
  const definition = chosen?.ok ? (chosen.configuration?.effectiveDefinition ?? own) : own;
  const placed = foundryAreaFootprint({definition, sourceToken, points: intent.area?.points ?? []});
  if ( !placed.ok ) return placed;
  // A creature behind Total Cover from its point of origin is not in it, nor one on the other plane (the Ethereal).
  const targetRefs = foundryAreaTargetTokens({sourceToken, footprint: placed.footprint, definition})
    .filter(token => actionCover({definition, sourceToken, targetToken: token, points: intent.area?.points ?? []}) !== "total")
    .filter(token => (token.id === sourceToken.id) || (ethereal(token.actor) === ethereal(sourceToken.actor)))
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
function foundryConcentrationContext({targetEntries=[], game=globalThis.game, scene=null, sourceToken=null}={}) {
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
  // The targets, then every other concentrating creature on the Scene: a reaction may move the damage to one (Cloud Rune,
  // Protective Bond), and it makes its check like a target. Only a creature that takes damage is checked.
  const targeted = new Set(targetEntries.map(entry => entry.actor));
  const others = collectionContents(scene?.tokens).filter(token => token?.actor && !targeted.has(token.actor)
    && (token.id !== sourceToken?.id) && sustained.has(`token:${token.id}`)).map(token => ({actor: token.actor, hint: {tokenId: token.id, sceneId: scene.id}}));
  for ( const {actor, hint} of [...targetEntries, ...others] ) {
    const token = targetTokenFor(actor, hint, game);
    const refs = uniqueStrings([token?.id ? `token:${token.id}` : null, ...targetControllerKeys(actor, hint, game)]);
    const sourceRef = refs.find(ref => sustained.has(ref));
    if ( !sourceRef ) continue;
    // Its concentration save adds its Fortitude save bonus (ability modifier and Modifiers).
    // Its Advantage or Disadvantage on it too: on Fortitude saves, and on Concentration (War Caster, Eldritch Mind).
    const state = {concentrating: true, actorId: actor.id ?? null, actorRef: actor.uuid ?? null, sourceRef,
      saveBonus: resolveActorSaveStatistic(actor, "fortitude")?.totalModifier ?? null,
      rollMode: combineRollModes(actor.getRollModes?.(["save", "save.fortitude", "concentration"]) ?? [])};
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
  let bonusShove = false;
  try { bonusShove = game?.settings?.get("wildpath", "bonusActionShove") === true; } catch (_error) {}
  if ( common ) return commonAction(actor, common, {localize: key => game?.i18n?.localize?.(key) ?? key, bonusShove});
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
