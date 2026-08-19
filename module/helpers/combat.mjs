import {
  DURATION_UNITS,
  TIMELINE_EVENT_TYPES
} from "./combat-timeline.mjs";

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
