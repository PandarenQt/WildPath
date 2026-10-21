import {test} from "node:test";
import assert from "node:assert/strict";
import {ammunitionOf, lacksAmmunition, recoverable, spendAmmunition} from "../module/adapters/foundry-v14-ammunition.mjs";

const arrows = (id, quantity) => {
  const item = {id, type: "gear", name: "Arrows", flags: {wildpath: {source: {subtype: "arrow"}}}, system: {quantity},
    update: async changes => { item.system.quantity = changes["system.quantity"]; }};
  return item;
};
const archer = items => {
  const actor = {uuid: "Actor.archer", type: "character", flags: {}, items: Object.assign(items, {get: id => items.find(item => item.id === id)}),
    setFlag: async (scope, key, value) => { actor.flags.wildpath = {...(actor.flags.wildpath ?? {}), [key]: value}; },
    unsetFlag: async (scope, key) => { delete actor.flags.wildpath[key]; }};
  return actor;
};

test("a weapon's attack needs its ammunition, spends one, and in combat counts it for half back after", async () => {
  const quiver = arrows("quiver", 2);
  const actor = archer([arrows("empty", 0), quiver]);
  const bow = {ammunition: "arrow", attack: {type: "ranged"}};
  assert.deepEqual(ammunitionOf(actor, "arrow").map(item => item.id), ["quiver"]);
  assert.equal(lacksAmmunition(actor, bow), false);
  assert.equal(lacksAmmunition(archer([]), bow), true, "none left: refused");
  assert.equal(lacksAmmunition({...archer([]), type: "npc"}, bow), false, "a stat block needs none");
  const game = {combat: {started: true, combatants: [{actor}]}};
  for ( let i = 0; i < 2; i++ ) await spendAmmunition({options: {actor}, state: {actionDefinition: bow}}, {game});
  assert.deepEqual([quiver.system.quantity, actor.flags.wildpath.ammunitionSpent], [0, {quiver: 2}]);
  assert.deepEqual(recoverable([actor]).map(entry => [entry.item.id, entry.spent, entry.recover]), [["quiver", 2, 1]]);
});
