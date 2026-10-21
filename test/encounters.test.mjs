import {test} from "node:test";
import assert from "node:assert/strict";
import {encounterDifficulty, levelForXp, xpForLevel, xpForThreat} from "../module/helpers/encounters.mjs";
import {combatAward, combatDifficulty} from "../module/applications/encounters.mjs";

test("2024 XP: by Challenge Rating, a party's budgets by level, and levels by XP", () => {
  assert.deepEqual([xpForThreat(0.25), xpForThreat(1), xpForThreat(5), xpForThreat(30)], [50, 200, 1800, 155000]);
  const four = encounterDifficulty({levels: [3, 3, 3, 3], threats: [1, 1, 0.5]});
  assert.deepEqual([four.xp, four.budgets, four.difficulty], [500, {low: 600, moderate: 900, high: 1600}, "low"]);
  assert.equal(encounterDifficulty({levels: [3, 3, 3, 3], threats: [3, 0.5, 0.5]}).difficulty, "moderate");
  assert.equal(encounterDifficulty({levels: [1], threats: [5]}).difficulty, "beyond");
  assert.deepEqual([levelForXp(0), levelForXp(299), levelForXp(300), levelForXp(355000), xpForLevel(5)], [1, 1, 2, 20, 6500]);
});

test("a combat's difficulty and award: its hostile creatures against its player characters, its defeated foes split", () => {
  const pc = (name, level) => ({actor: {name, type: "character", hasPlayerOwner: true, system: {details: {level}}}, token: {disposition: 1}});
  const foe = (threat, defeated) => ({actor: {type: "npc", system: {details: {threat}}, statuses: new Set()}, token: {disposition: -1}, defeated});
  const combat = {combatants: [pc("Ana", 3), pc("Bo", 3), foe(1, true), foe(2, false), foe(0.5, true)]};
  assert.equal(combatDifficulty(combat).xp, 750);
  assert.deepEqual([combatAward(combat).xp, combatAward(combat).each], [300, 150], "only the defeated count");
  assert.equal(combatDifficulty({combatants: [pc("Ana", 3)]}), null);
});
