import {test} from "node:test";
import assert from "node:assert/strict";
import {
  DURATION_TICK_TIMING,
  DURATION_UNITS,
  TIMELINE_EVENT_TYPES,
  advanceTurn,
  collectDueScheduledEvents,
  createCombatTimeline,
  createDuration,
  createRestEvent,
  createScheduledEvent,
  endCombat,
  getActiveCombatant,
  startCombat,
  updateDurationsForEvents
} from "../module/helpers/combat-timeline.mjs";

function timeline() {
  return createCombatTimeline({
    id: "combat-a",
    combatants: [
      {id: "a", actorId: "actor-a", tokenId: "token-a"},
      {id: "b", actorId: "actor-b", tokenId: "token-b"}
    ]
  });
}

test("combat start emits combat, round, and turn start events without mutation", () => {
  const combat = timeline();
  const started = startCombat(combat);

  assert.equal(getActiveCombatant(combat).id, "a");
  assert.deepEqual(started.events.map(event => event.type), [
    TIMELINE_EVENT_TYPES.COMBAT_START,
    TIMELINE_EVENT_TYPES.ROUND_START,
    TIMELINE_EVENT_TYPES.TURN_START
  ]);
  assert.equal(started.events[2].combatantId, "a");
  assert.equal(combat.round, 1);
  assert.equal(combat.turn, 0);
});

test("advanceTurn emits turn end/start and wraps rounds deterministically", () => {
  const first = advanceTurn(timeline());
  const second = advanceTurn(first.timeline);

  assert.equal(first.timeline.round, 1);
  assert.equal(first.timeline.turn, 1);
  assert.deepEqual(first.events.map(event => event.type), [
    TIMELINE_EVENT_TYPES.TURN_END,
    TIMELINE_EVENT_TYPES.TURN_START
  ]);
  assert.equal(first.events[1].combatantId, "b");

  assert.equal(second.timeline.round, 2);
  assert.equal(second.timeline.turn, 0);
  assert.deepEqual(second.events.map(event => event.type), [
    TIMELINE_EVENT_TYPES.TURN_END,
    TIMELINE_EVENT_TYPES.ROUND_END,
    TIMELINE_EVENT_TYPES.ROUND_START,
    TIMELINE_EVENT_TYPES.TURN_START
  ]);
  assert.equal(second.events[3].combatantId, "a");
});

test("turn durations tick only on their owner turn timing", () => {
  const duration = createDuration({
    id: "bless",
    unit: DURATION_UNITS.TURNS,
    remaining: 1,
    tickOn: DURATION_TICK_TIMING.TURN_END,
    ownerId: "a"
  });
  const first = advanceTurn(timeline());
  const result = updateDurationsForEvents([duration], first.events);

  assert.equal(result.active.length, 0);
  assert.equal(result.expired[0].id, "bless");
  assert.equal(result.expired[0].expiredBy.type, TIMELINE_EVENT_TYPES.TURN_END);
  assert.equal(duration.remaining, 1);
});

test("round durations tick on round events", () => {
  const duration = createDuration({
    id: "fog",
    unit: DURATION_UNITS.ROUNDS,
    remaining: 1,
    tickOn: DURATION_TICK_TIMING.ROUND_END
  });
  const first = advanceTurn(timeline());
  const second = advanceTurn(first.timeline);
  const result = updateDurationsForEvents([duration], [...first.events, ...second.events]);

  assert.equal(result.active.length, 0);
  assert.equal(result.expired[0].expiredBy.type, TIMELINE_EVENT_TYPES.ROUND_END);
});

test("combat and rest durations expire on matching lifecycle events", () => {
  const combatDuration = createDuration({id: "rage", unit: DURATION_UNITS.COMBAT, remaining: 999});
  const shortRestDuration = createDuration({id: "until-short-rest", unit: DURATION_UNITS.SHORT_REST, remaining: 999});
  const longRestDuration = createDuration({id: "until-long-rest", unit: DURATION_UNITS.LONG_REST, remaining: 999});
  const combatEnd = endCombat(timeline()).events;
  const shortRest = createRestEvent({restType: DURATION_UNITS.SHORT_REST});
  const longRest = createRestEvent({restType: DURATION_UNITS.LONG_REST});

  assert.deepEqual(updateDurationsForEvents([combatDuration], combatEnd).expired.map(d => d.id), ["rage"]);
  assert.deepEqual(updateDurationsForEvents([shortRestDuration], [shortRest]).expired.map(d => d.id), ["until-short-rest"]);
  assert.deepEqual(updateDurationsForEvents([longRestDuration], [shortRest]).active.map(d => d.id), ["until-long-rest"]);
  assert.deepEqual(updateDurationsForEvents([longRestDuration], [longRest]).expired.map(d => d.id), ["until-long-rest"]);
});

test("scheduled one-shot and recurring events match timeline events without mutating the schedule", () => {
  const combat = timeline();
  const first = advanceTurn(combat);
  const turnStart = first.events.find(event => event.type === TIMELINE_EVENT_TYPES.TURN_START);
  const oneShot = createScheduledEvent({
    id: "once",
    trigger: {type: TIMELINE_EVENT_TYPES.TURN_START, combatantId: "b"},
    payload: {kind: "tick"}
  });
  const recurring = createScheduledEvent({
    id: "recurring",
    trigger: {type: TIMELINE_EVENT_TYPES.TURN_START},
    once: false
  });
  const schedule = [oneShot, recurring];
  const result = collectDueScheduledEvents(schedule, turnStart);

  assert.deepEqual(result.due.map(event => event.id), ["once", "recurring"]);
  assert.deepEqual(result.remaining.map(event => event.id), ["recurring"]);
  assert.deepEqual(schedule.map(event => event.id), ["once", "recurring"]);
});

test("scheduled rest events can target rest completion", () => {
  const scheduled = createScheduledEvent({
    id: "recover",
    trigger: {type: TIMELINE_EVENT_TYPES.REST_COMPLETE, restType: DURATION_UNITS.LONG_REST},
    payload: {resource: "health"}
  });
  const shortRest = collectDueScheduledEvents([scheduled], createRestEvent({restType: DURATION_UNITS.SHORT_REST}));
  const longRest = collectDueScheduledEvents([scheduled], createRestEvent({restType: DURATION_UNITS.LONG_REST}));

  assert.equal(shortRest.due.length, 0);
  assert.deepEqual(longRest.due.map(event => event.id), ["recover"]);
});
