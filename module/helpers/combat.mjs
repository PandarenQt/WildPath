import {
  DURATION_UNITS,
  TIMELINE_EVENT_TYPES
} from "./combat-timeline.mjs";

export const TURN_RECOVERY_CODES = Object.freeze({
  OK: "OK",
  ALREADY_PROCESSED: "TURN_RECOVERY_ALREADY_PROCESSED",
  MISSING_COMBAT: "TURN_RECOVERY_MISSING_COMBAT",
  MISSING_COMBATANT: "TURN_RECOVERY_MISSING_COMBATANT",
  COMBATANT_NOT_IN_COMBAT: "TURN_RECOVERY_COMBATANT_NOT_IN_COMBAT",
  ACTOR_NOT_INCOMING_COMBATANT: "TURN_RECOVERY_ACTOR_NOT_INCOMING_COMBATANT",
  INVALID_LIFECYCLE: "TURN_RECOVERY_INVALID_LIFECYCLE",
  COMMIT_NOT_AUTHORIZED: "TURN_RECOVERY_COMMIT_NOT_AUTHORIZED"
});

const TURN_RECOVERY_HOOKS = new Set(["combatStart", "combatTurn"]);

/**
 * Resolve the Combatant whose turn is beginning from a combat turn-change update.
 *
 * The `combatTurn`/`combatStart` hooks fire *before* the update is applied to the Combat
 * document, so `combat.combatant` may still reference the outgoing combatant at the moment the
 * hook runs - resolve the incoming combatant directly from the update's `turn` index instead.
 * Pure function (only ever touches plain properties on the objects it is given) so it is
 * directly unit-testable without a running Foundry client.
 * @param {{turns?: object[], turn?: number, combatant?: object}} combat
 * @param {{turn?: number}} [updateData]
 * @returns {object|undefined}
 */
export function getIncomingCombatant(combat, updateData) {
  const turn = updateData?.turn ?? combat.turn;
  return combat.turns?.[turn] ?? combat.combatant;
}

/* -------------------------------------------- */

/**
 * Convert Foundry's pre-update combat hooks into semantic timeline events.
 *
 * Foundry calls `combatTurn` before the Combat document is updated, so callers pass the hook's
 * update data and this helper emits events for the outgoing turn and incoming turn using the
 * explicit next round/turn values from that update.
 * @param {object} combat
 * @param {object} [updateData]
 * @param {{hook?: string}} [options]
 * @returns {object[]}
 */
export function getCombatLifecycleEvents(combat, updateData={}, {hook="combatTurn"}={}) {
  if ( !combat ) return [];

  if ( hook === "combatStart" ) {
    const round = normalizePositiveInteger(updateData.round ?? combat.round, 1);
    const turn = normalizeNonNegativeInteger(updateData.turn ?? combat.turn, 0);
    const incoming = combat.turns?.[turn] ?? getIncomingCombatant(combat, updateData);
    return [
      createCombatLifecycleEvent(TIMELINE_EVENT_TYPES.COMBAT_START, combat, incoming, {round, turn}),
      createCombatLifecycleEvent(TIMELINE_EVENT_TYPES.ROUND_START, combat, incoming, {round, turn}),
      createCombatLifecycleEvent(TIMELINE_EVENT_TYPES.TURN_START, combat, incoming, {round, turn})
    ];
  }

  const outgoingRound = normalizePositiveInteger(combat.round, 1);
  const outgoingTurn = normalizeNonNegativeInteger(combat.turn, 0);
  const incomingTurn = normalizeNonNegativeInteger(updateData.turn ?? combat.turn, outgoingTurn);
  const inferredRoundWrap = updateData.round == null && incomingTurn < outgoingTurn;
  const incomingRound = normalizePositiveInteger(
    updateData.round ?? (inferredRoundWrap ? outgoingRound + 1 : combat.round),
    outgoingRound
  );
  const outgoing = combat.turns?.[outgoingTurn] ?? combat.combatant ?? null;
  const incoming = combat.turns?.[incomingTurn] ?? getIncomingCombatant(combat, updateData);
  const wrappedRound = incomingRound > outgoingRound
    || (incomingRound === outgoingRound && incomingTurn < outgoingTurn);

  const events = [
    createCombatLifecycleEvent(TIMELINE_EVENT_TYPES.TURN_END, combat, outgoing, {
      round: outgoingRound,
      turn: outgoingTurn
    })
  ];

  if ( wrappedRound ) {
    events.push(createCombatLifecycleEvent(TIMELINE_EVENT_TYPES.ROUND_END, combat, outgoing, {
      round: outgoingRound,
      turn: outgoingTurn
    }));
    events.push(createCombatLifecycleEvent(TIMELINE_EVENT_TYPES.ROUND_START, combat, incoming, {
      round: incomingRound,
      turn: incomingTurn
    }));
  }

  events.push(createCombatLifecycleEvent(TIMELINE_EVENT_TYPES.TURN_START, combat, incoming, {
    round: incomingRound,
    turn: incomingTurn
  }));
  return events;
}

/* -------------------------------------------- */

/**
 * Convert a Combat deletion/end hook into a semantic combat-end lifecycle event.
 * @param {object} combat
 * @returns {object[]}
 */
export function getCombatEndLifecycleEvents(combat) {
  if ( !combat ) return [];
  const round = normalizePositiveInteger(combat.round, 1);
  const turn = normalizeNonNegativeInteger(combat.turn, 0);
  const combatant = combat.turns?.[turn] ?? combat.combatant ?? null;
  return [
    createCombatLifecycleEvent(TIMELINE_EVENT_TYPES.COMBAT_END, combat, combatant, {round, turn})
  ];
}

/* -------------------------------------------- */

/**
 * Convert a rest action into semantic rest lifecycle events for duration expiry.
 * @param {object} [options]
 * @param {object|null} [options.actor]
 * @param {object[]} [options.actors]
 * @param {"shortRest"|"longRest"} [options.restType]
 * @param {string} [options.type]
 * @returns {object[]}
 */
export function getRestLifecycleEvents({
  actor=null,
  actors=[],
  restType=DURATION_UNITS.SHORT_REST,
  type=TIMELINE_EVENT_TYPES.REST_COMPLETE
}={}) {
  if ( ![DURATION_UNITS.SHORT_REST, DURATION_UNITS.LONG_REST].includes(restType) ) return [];
  const actorIds = uniqueStrings([actor, ...actors].map(entry => entry?.id ?? entry?.actorId ?? entry));
  return [{
    type,
    restType,
    actorIds,
    round: null,
    turn: null,
    combatId: null,
    combatantId: null,
    actorId: actorIds[0] ?? null,
    tokenId: null
  }];
}

/* -------------------------------------------- */

/**
 * Validate that turn-resource recovery is being requested by a real combat lifecycle transition.
 * This deliberately requires Combat, incoming Combatant, turn-start event, and active-GM commit
 * authority rather than accepting an arbitrary caller's "fromCombat" claim.
 * @param {object} options
 * @returns {object}
 */
export function validateTurnRecoveryContext({
  actor=null,
  combat=null,
  combatant=null,
  events=[],
  authority=null,
  hook=null
}={}) {
  if ( !combat ) return turnRecoveryFailure(TURN_RECOVERY_CODES.MISSING_COMBAT, "Turn recovery requires a Combat document context.");
  if ( !combatant ) return turnRecoveryFailure(TURN_RECOVERY_CODES.MISSING_COMBATANT, "Turn recovery requires the incoming Combatant.");
  if ( !combatContainsCombatant(combat, combatant) ) {
    return turnRecoveryFailure(TURN_RECOVERY_CODES.COMBATANT_NOT_IN_COMBAT, "Incoming Combatant is not represented in the Combat context.");
  }
  if ( !actorMatchesCombatant(actor, combatant) ) {
    return turnRecoveryFailure(TURN_RECOVERY_CODES.ACTOR_NOT_INCOMING_COMBATANT, "Actor does not match the incoming Combatant.");
  }
  if ( !TURN_RECOVERY_HOOKS.has(hook) ) {
    return turnRecoveryFailure(TURN_RECOVERY_CODES.INVALID_LIFECYCLE, "Turn recovery must originate from combatStart or combatTurn.");
  }
  const turnStart = findTurnStartEventForActor({actor, combat, combatant, events});
  if ( !turnStart ) {
    return turnRecoveryFailure(TURN_RECOVERY_CODES.INVALID_LIFECYCLE, "Turn recovery requires a matching turnStart lifecycle event.");
  }
  if ( !authority?.isGM || !authority.canCommit ) {
    return turnRecoveryFailure(TURN_RECOVERY_CODES.COMMIT_NOT_AUTHORIZED, "Turn recovery requires active-GM commit authority.");
  }
  if ( authority.activeGMId && authority.userId && authority.activeGMId !== authority.userId ) {
    return turnRecoveryFailure(TURN_RECOVERY_CODES.COMMIT_NOT_AUTHORIZED, "Only the active GM may commit turn recovery.");
  }

  return {
    ok: true,
    code: TURN_RECOVERY_CODES.OK,
    transitionKey: turnRecoveryTransitionKey({actor, combat, combatant, event: turnStart}),
    event: turnStart
  };
}

/* -------------------------------------------- */

function createCombatLifecycleEvent(type, combat, combatant, {round, turn}) {
  return {
    type,
    combatId: combat.id ?? combat._id ?? null,
    round,
    turn,
    combatantId: combatant?.id ?? combatant?._id ?? null,
    actorId: combatant?.actorId ?? combatant?.actor?.id ?? null,
    tokenId: combatant?.tokenId ?? combatant?.token?.id ?? null
  };
}

function combatContainsCombatant(combat, combatant) {
  return combatantCandidates(combat).some(candidate => combatantsMatch(candidate, combatant));
}

function combatantCandidates(combat) {
  return [
    ...collectionContents(combat?.turns),
    ...collectionContents(combat?.combatants),
    combat?.combatant
  ].filter(Boolean);
}

function combatantsMatch(left, right) {
  if ( left === right ) return true;
  const leftRefs = combatantRefs(left);
  const rightRefs = combatantRefs(right);
  return leftRefs.some(ref => rightRefs.includes(ref));
}

function combatantRefs(combatant) {
  return uniqueStrings([
    combatant?.id,
    combatant?._id,
    combatant?.uuid,
    combatant?.tokenId ? `token:${combatant.tokenId}` : null,
    combatant?.token?.id ? `token:${combatant.token.id}` : null
  ]);
}

function actorMatchesCombatant(actor, combatant) {
  if ( !actor || !combatant ) return false;
  if ( combatant.actor ) {
    if ( combatant.actor === actor ) return true;
    const combatantActorUuid = combatant.actor.uuid ?? null;
    return Boolean(combatantActorUuid && actor.uuid && combatantActorUuid === actor.uuid);
  }
  const actorId = actor.id ?? actor._id ?? null;
  return Boolean(actorId && combatant.actorId && actorId === combatant.actorId);
}

function findTurnStartEventForActor({actor, combat, combatant, events=[]}) {
  return collectionContents(events).find(event => {
    if ( event?.type !== TIMELINE_EVENT_TYPES.TURN_START ) return false;
    if ( event.combatId && combat?.id && event.combatId !== combat.id ) return false;
    if ( event.combatantId && combatant?.id && event.combatantId !== combatant.id ) return false;
    if ( event.tokenId && combatant?.tokenId && event.tokenId !== combatant.tokenId ) return false;
    const actorId = actor?.id ?? actor?._id ?? null;
    if ( event.actorId && actorId && event.actorId !== actorId ) return false;
    return true;
  }) ?? null;
}

function turnRecoveryTransitionKey({actor, combat, combatant, event}) {
  return [
    "turn-recovery",
    combat?.id ?? combat?._id ?? "combat:unknown",
    event?.round ?? "round:unknown",
    event?.turn ?? "turn:unknown",
    event?.combatantId ?? combatant?.id ?? combatant?._id ?? "combatant:unknown",
    event?.actorId ?? actor?.id ?? actor?._id ?? "actor:unknown",
    event?.tokenId ?? combatant?.tokenId ?? combatant?.token?.id ?? "token:unknown"
  ].map(String).join("|");
}

function turnRecoveryFailure(code, reason) {
  return {ok: false, code, reason};
}

function collectionContents(collection) {
  if ( collection == null ) return [];
  if ( Array.isArray(collection) ) return collection;
  if ( Array.isArray(collection.contents) ) return collection.contents;
  if ( collection instanceof Map ) return [...collection.values()];
  if ( typeof collection.values === "function" ) return [...collection.values()];
  if ( typeof collection === "object" ) return Object.values(collection);
  return [];
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => value != null && value !== "").map(String))];
}
