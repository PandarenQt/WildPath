import {test} from "node:test";
import assert from "node:assert/strict";
import {
  getCombatEndLifecycleEvents,
  getCombatLifecycleEvents,
  getIncomingCombatant,
  getRestLifecycleEvents
} from "../module/helpers/combat.mjs";
import {
  DURATION_UNITS,
  TIMELINE_EVENT_TYPES
} from "../module/helpers/combat-timeline.mjs";

test("getIncomingCombatant resolves from updateData.turn, not the stale combat.combatant", () => {
  // Regression test for the V14 hook-ordering bug: combatTurn/combatStart fire before the
  // Combat document's own `turn`/`combatant` have been updated, so combat.combatant would still
  // point at the outgoing combatant if used directly.
  const combat = {
    turn: 0,
    turns: [{id: "outgoing"}, {id: "incoming"}],
    combatant: {id: "outgoing"}
  };
  const result = getIncomingCombatant(combat, {turn: 1});
  assert.equal(result.id, "incoming");
});

test("getIncomingCombatant falls back to combat.turn when updateData.turn is absent", () => {
  const combat = {turn: 1, turns: [{id: "a"}, {id: "b"}], combatant: {id: "a"}};
  const result = getIncomingCombatant(combat, {});
  assert.equal(result.id, "b");
});

test("getIncomingCombatant falls back to combat.combatant when turns is unavailable", () => {
  const combat = {turn: 0, combatant: {id: "only"}};
  const result = getIncomingCombatant(combat, {turn: 5});
  assert.equal(result.id, "only");
});

test("getCombatLifecycleEvents emits outgoing and incoming turn events", () => {
  const combat = {
    id: "combat-a",
    round: 2,
    turn: 0,
    turns: [
      {id: "combatant-a", actorId: "actor-a", tokenId: "token-a"},
      {id: "combatant-b", actorId: "actor-b", tokenId: "token-b"}
    ],
    combatant: {id: "combatant-a", actorId: "actor-a"}
  };
  const events = getCombatLifecycleEvents(combat, {turn: 1, round: 2});

  assert.deepEqual(events.map(event => event.type), [
    TIMELINE_EVENT_TYPES.TURN_END,
    TIMELINE_EVENT_TYPES.TURN_START
  ]);
  assert.equal(events[0].actorId, "actor-a");
  assert.equal(events[1].actorId, "actor-b");
  assert.equal(events[1].round, 2);
  assert.equal(events[1].turn, 1);
});

test("getCombatLifecycleEvents emits round boundary events when turns wrap", () => {
  const combat = {
    id: "combat-a",
    round: 2,
    turn: 1,
    turns: [
      {id: "combatant-a", actorId: "actor-a"},
      {id: "combatant-b", actorId: "actor-b"}
    ]
  };
  const events = getCombatLifecycleEvents(combat, {turn: 0});

  assert.deepEqual(events.map(event => event.type), [
    TIMELINE_EVENT_TYPES.TURN_END,
    TIMELINE_EVENT_TYPES.ROUND_END,
    TIMELINE_EVENT_TYPES.ROUND_START,
    TIMELINE_EVENT_TYPES.TURN_START
  ]);
  assert.equal(events[2].round, 3);
  assert.equal(events[3].actorId, "actor-a");
});

test("getCombatLifecycleEvents emits combat start timeline events", () => {
  const combat = {
    id: "combat-a",
    round: 1,
    turn: 0,
    turns: [{id: "combatant-a", actorId: "actor-a"}]
  };
  const events = getCombatLifecycleEvents(combat, {turn: 0, round: 1}, {hook: "combatStart"});

  assert.deepEqual(events.map(event => event.type), [
    TIMELINE_EVENT_TYPES.COMBAT_START,
    TIMELINE_EVENT_TYPES.ROUND_START,
    TIMELINE_EVENT_TYPES.TURN_START
  ]);
  assert.equal(events[0].combatId, "combat-a");
  assert.equal(events[2].actorId, "actor-a");
});

test("getCombatEndLifecycleEvents emits active combat end context", () => {
  const combat = {
    id: "combat-a",
    round: 3,
    turn: 1,
    turns: [
      {id: "combatant-a", actorId: "actor-a"},
      {id: "combatant-b", actorId: "actor-b", tokenId: "token-b"}
    ]
  };
  const events = getCombatEndLifecycleEvents(combat);

  assert.deepEqual(events.map(event => event.type), [TIMELINE_EVENT_TYPES.COMBAT_END]);
  assert.equal(events[0].combatId, "combat-a");
  assert.equal(events[0].round, 3);
  assert.equal(events[0].turn, 1);
  assert.equal(events[0].combatantId, "combatant-b");
  assert.equal(events[0].actorId, "actor-b");
  assert.equal(events[0].tokenId, "token-b");
});

test("getRestLifecycleEvents emits rest completion actor context", () => {
  const events = getRestLifecycleEvents({
    actor: {id: "actor-a"},
    actors: [{id: "actor-b"}, "actor-c"],
    restType: DURATION_UNITS.LONG_REST
  });

  assert.deepEqual(events.map(event => event.type), [TIMELINE_EVENT_TYPES.REST_COMPLETE]);
  assert.equal(events[0].restType, DURATION_UNITS.LONG_REST);
  assert.deepEqual(events[0].actorIds, ["actor-a", "actor-b", "actor-c"]);
  assert.equal(events[0].actorId, "actor-a");
});

test("getRestLifecycleEvents ignores unsupported recovery types", () => {
  assert.deepEqual(getRestLifecycleEvents({restType: "turn"}), []);
});
