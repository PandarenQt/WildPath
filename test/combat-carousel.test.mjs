import {test} from "node:test";
import assert from "node:assert/strict";
import {combatCarouselContext} from "../module/helpers/combat-carousel-context.mjs";

const conditions = [{id: "prone", name: "Prone", img: "prone.svg"}, {id: "exhaustion", name: "Exhaustion", img: "ex.svg", stacking: true}];
const creature = (isOwner, value, effects=[]) => ({isOwner, effects, system: {resources: {health: {value, max: 20}}}});
const combat = () => {
  const turns = [
    {id: "hero", name: "Hero", img: "hero.png", initiative: 18, isOwner: true,
      actor: creature(true, 15, [{system: {type: "exhaustion", level: 2}}])},
    {id: "goblin-1", name: "Goblin", initiative: 12, actor: creature(false, 7, [{system: {type: "prone"}}])},
    {id: "goblin-2", name: "Goblin", initiative: 9, actor: creature(false, 20)},
    {id: "ambusher", name: "Ambusher", initiative: 5, hidden: true, actor: creature(false, 20)}
  ];
  return {id: "c", round: 2, turn: 1, turns, combatant: turns[1]};
};

test("a player sees the turn order and public conditions, health only for their own creature, and no hidden combatant", () => {
  const view = combatCarouselContext({combat: combat(), isGM: false, conditions});
  assert.equal(view.round, 2);
  assert.deepEqual(view.turns.map(turn => turn.id), ["hero", "goblin-1", "goblin-2"]);
  assert.deepEqual(view.turns.map(turn => turn.active), [false, true, false]);
  assert.deepEqual(view.turns[0].health, {value: 15, max: 20, percent: 75});
  assert.equal(view.turns[1].health, null, "an enemy's health stays hidden");
  assert.deepEqual(view.turns[0].conditions.map(entry => [entry.id, entry.level]), [["exhaustion", 2]]);
  assert.deepEqual(view.turns[1].conditions.map(entry => entry.id), ["prone"]);
  assert.equal(view.canAdvance, false, "it is the goblin's turn, not the player's");
});

test("the GM sees every combatant with its health, the two Goblins apart, and may end any turn", () => {
  const view = combatCarouselContext({combat: combat(), isGM: true, conditions});
  assert.deepEqual(view.turns.map(turn => turn.id), ["hero", "goblin-1", "goblin-2", "ambusher"]);
  assert.equal(view.turns[3].hidden, true);
  assert.deepEqual(view.turns.slice(1, 3).map(turn => turn.health.value), [7, 20]);
  assert.equal(view.canAdvance, true);
});
