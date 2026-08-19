import {test} from "node:test";
import assert from "node:assert/strict";
import {getIncomingCombatant} from "../module/helpers/combat.mjs";

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
