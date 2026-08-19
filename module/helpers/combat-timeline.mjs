export const TIMELINE_EVENT_TYPES = Object.freeze({
  COMBAT_START: "combatStart",
  COMBAT_END: "combatEnd",
  ROUND_START: "roundStart",
  ROUND_END: "roundEnd",
  TURN_START: "turnStart",
  TURN_END: "turnEnd",
  REST_START: "restStart",
  REST_COMPLETE: "restComplete"
});

export const DURATION_UNITS = Object.freeze({
  TURNS: "turns",
  ROUNDS: "rounds",
  COMBAT: "combat",
  SHORT_REST: "shortRest",
  LONG_REST: "longRest",
  PERMANENT: "permanent"
});

export const DURATION_TICK_TIMING = Object.freeze({
  TURN_START: "turnStart",
  TURN_END: "turnEnd",
  ROUND_START: "roundStart",
  ROUND_END: "roundEnd"
});

export const TIMELINE_CODES = Object.freeze({
  OK: "OK",
  NO_COMBATANTS: "NO_COMBATANTS",
  INVALID_TURN: "INVALID_TURN"
});

/* -------------------------------------------- */

export function createCombatTimeline({id="combat", round=1, turn=0, combatants=[]}={}) {
  const normalized = combatants.map((combatant, index) => ({
    id: String(combatant.id ?? combatant.tokenId ?? index),
    actorId: combatant.actorId ?? combatant.actor?.id ?? null,
    tokenId: combatant.tokenId ?? combatant.token?.id ?? null,
    initiative: combatant.initiative ?? null,
    defeated: !!combatant.defeated,
    hidden: !!combatant.hidden,
    metadata: clonePlain(combatant.metadata ?? {})
  }));
  return {
    id,
    round: Math.max(Math.floor(Number(round) || 1), 1),
    turn: clampTurn(turn, normalized.length),
    combatants: normalized,
    eventIndex: 0
  };
}

/* -------------------------------------------- */

export function getActiveCombatant(timeline) {
  return timeline.combatants[timeline.turn] ?? null;
}

/* -------------------------------------------- */

export function startCombat(timeline) {
  const active = getActiveCombatant(timeline);
  return {
    timeline: cloneTimeline(timeline),
    events: [
      createTimelineEvent(TIMELINE_EVENT_TYPES.COMBAT_START, timeline, active),
      createTimelineEvent(TIMELINE_EVENT_TYPES.ROUND_START, timeline, active),
      createTimelineEvent(TIMELINE_EVENT_TYPES.TURN_START, timeline, active)
    ]
  };
}

/* -------------------------------------------- */

export function endCombat(timeline) {
  return {
    timeline: cloneTimeline(timeline),
    events: [createTimelineEvent(TIMELINE_EVENT_TYPES.COMBAT_END, timeline, getActiveCombatant(timeline))]
  };
}

/* -------------------------------------------- */

export function advanceTurn(timeline) {
  if ( !timeline.combatants.length ) {
    return {ok: false, code: TIMELINE_CODES.NO_COMBATANTS, timeline: cloneTimeline(timeline), events: []};
  }
  const current = getActiveCombatant(timeline);
  const nextTurn = (timeline.turn + 1) % timeline.combatants.length;
  const wrapsRound = nextTurn === 0;
  const next = {
    ...cloneTimeline(timeline),
    round: wrapsRound ? timeline.round + 1 : timeline.round,
    turn: nextTurn,
    eventIndex: timeline.eventIndex + 1
  };
  const nextCombatant = getActiveCombatant(next);
  const events = [createTimelineEvent(TIMELINE_EVENT_TYPES.TURN_END, timeline, current)];
  if ( wrapsRound ) {
    events.push(createTimelineEvent(TIMELINE_EVENT_TYPES.ROUND_END, timeline, current));
    events.push(createTimelineEvent(TIMELINE_EVENT_TYPES.ROUND_START, next, nextCombatant));
  }
  events.push(createTimelineEvent(TIMELINE_EVENT_TYPES.TURN_START, next, nextCombatant));
  return {ok: true, code: TIMELINE_CODES.OK, timeline: next, events};
}

/* -------------------------------------------- */

export function createDuration({
  id,
  unit=DURATION_UNITS.TURNS,
  remaining=1,
  tickOn=DURATION_TICK_TIMING.TURN_END,
  ownerId=null,
  sourceId=null,
  targetId=null,
  startsOn=null,
  metadata={}
}={}) {
  if ( !id ) throw new Error("Duration requires a stable id.");
  return {
    id: String(id),
    unit,
    remaining: Math.max(Math.floor(Number(remaining) || 0), 0),
    tickOn,
    ownerId,
    sourceId,
    targetId,
    startsOn: startsOn ? clonePlain(startsOn) : null,
    expired: unit !== DURATION_UNITS.PERMANENT && remaining <= 0,
    metadata: clonePlain(metadata)
  };
}

/* -------------------------------------------- */

export function updateDurationsForEvents(durations=[], events=[]) {
  let active = durations.map(duration => ({...duration, metadata: clonePlain(duration.metadata ?? {})}));
  const expired = [];
  for ( const event of events ) {
    const next = [];
    for ( const duration of active ) {
      const updated = tickDurationForEvent(duration, event);
      if ( updated.expired ) expired.push({...updated, expiredBy: clonePlain(event)});
      else next.push(updated);
    }
    active = next;
  }
  return {active, expired};
}

/* -------------------------------------------- */

export function tickDurationForEvent(duration, event) {
  if ( duration.expired || duration.unit === DURATION_UNITS.PERMANENT ) return clonePlain(duration);
  if ( duration.unit === DURATION_UNITS.COMBAT ) {
    return event.type === TIMELINE_EVENT_TYPES.COMBAT_END ? expire(duration) : clonePlain(duration);
  }
  if ( duration.unit === DURATION_UNITS.SHORT_REST ) {
    return isRestCompletion(event, DURATION_UNITS.SHORT_REST) || isRestCompletion(event, DURATION_UNITS.LONG_REST)
      ? expire(duration)
      : clonePlain(duration);
  }
  if ( duration.unit === DURATION_UNITS.LONG_REST ) {
    return isRestCompletion(event, DURATION_UNITS.LONG_REST) ? expire(duration) : clonePlain(duration);
  }
  if ( !durationTicksOnEvent(duration, event) ) return clonePlain(duration);
  const remaining = Math.max(duration.remaining - 1, 0);
  return remaining <= 0 ? expire({...duration, remaining}) : {...clonePlain(duration), remaining};
}

/* -------------------------------------------- */

export function createScheduledEvent({id, trigger, payload={}, once=true, metadata={}}={}) {
  if ( !id ) throw new Error("ScheduledEvent requires a stable id.");
  return {
    id: String(id),
    trigger: clonePlain(trigger ?? {}),
    payload: clonePlain(payload),
    once: once !== false,
    metadata: clonePlain(metadata)
  };
}

/* -------------------------------------------- */

export function collectDueScheduledEvents(schedule=[], event) {
  const due = [];
  const remaining = [];
  for ( const scheduled of schedule ) {
    if ( scheduleMatchesEvent(scheduled, event) ) {
      due.push({...clonePlain(scheduled), dueEvent: clonePlain(event)});
      if ( !scheduled.once ) remaining.push(clonePlain(scheduled));
    }
    else remaining.push(clonePlain(scheduled));
  }
  return {due, remaining};
}

/* -------------------------------------------- */

export function createRestEvent({type=TIMELINE_EVENT_TYPES.REST_COMPLETE, restType=DURATION_UNITS.SHORT_REST, actorIds=[]}={}) {
  return {
    type,
    restType,
    actorIds: [...actorIds],
    round: null,
    turn: null,
    combatantId: null
  };
}

/* -------------------------------------------- */

function createTimelineEvent(type, timeline, combatant=null) {
  return {
    type,
    combatId: timeline.id,
    round: timeline.round,
    turn: timeline.turn,
    combatantId: combatant?.id ?? null,
    actorId: combatant?.actorId ?? null,
    tokenId: combatant?.tokenId ?? null,
    eventIndex: timeline.eventIndex
  };
}

function durationTicksOnEvent(duration, event) {
  if ( duration.tickOn !== event.type ) return false;
  if ( duration.unit === DURATION_UNITS.TURNS ) {
    return !duration.ownerId || duration.ownerId === event.combatantId || duration.ownerId === event.actorId;
  }
  if ( duration.unit === DURATION_UNITS.ROUNDS ) return true;
  return false;
}

function scheduleMatchesEvent(scheduled, event) {
  const trigger = scheduled.trigger ?? {};
  if ( trigger.type && trigger.type !== event.type ) return false;
  if ( trigger.round != null && trigger.round !== event.round ) return false;
  if ( trigger.turn != null && trigger.turn !== event.turn ) return false;
  if ( trigger.combatantId && trigger.combatantId !== event.combatantId ) return false;
  if ( trigger.actorId && trigger.actorId !== event.actorId ) return false;
  if ( trigger.restType && trigger.restType !== event.restType ) return false;
  return true;
}

function isRestCompletion(event, restType) {
  return event.type === TIMELINE_EVENT_TYPES.REST_COMPLETE && event.restType === restType;
}

function expire(duration) {
  return {...clonePlain(duration), remaining: 0, expired: true};
}

function cloneTimeline(timeline) {
  return createCombatTimeline(timeline);
}

function clampTurn(turn, count) {
  if ( count <= 0 ) return 0;
  return Math.min(Math.max(Math.floor(Number(turn) || 0), 0), count - 1);
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}
