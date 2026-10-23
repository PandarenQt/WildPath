import {test} from "node:test";
import assert from "node:assert/strict";
import {createFoundryAutomationDispatcher} from "../module/adapters/foundry-v14-automation-dispatcher.mjs";

test("a Confused creature draws its behavior table as its turn starts, and only then", async () => {
  const posted = [];
  const table = {draw: async () => ({results: [{name: "8"}], roll: {total: 8}}), toMessage: async results => posted.push(results)};
  const automation = createFoundryAutomationDispatcher({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}}, coordinator: {},
    resolveAction: () => null, fromUuid: uuid => (uuid === "Compendium.wildpath.srd-tables.RollTable.confusion" ? table : null)});
  const confused = {id: "c", disabled: false, flags: {wildpath: {conditionEffect: {definition: {
    drawsAtTurnStart: "Compendium.wildpath.srd-tables.RollTable.confusion"}}}}};
  const actor = {id: "a", uuid: "Actor.a", items: [], effects: [confused], statuses: new Set()};
  await automation.dispatch("turn.started", {actor});
  assert.deepEqual(posted, [[{name: "8"}]]);
  await automation.dispatch("turn.ended", {actor});
  confused.disabled = true;
  await automation.dispatch("turn.started", {actor});
  assert.equal(posted.length, 1, "not as its turn ends, nor from a disabled effect");
});

test("a suffocating creature holds its breath, then gains Exhaustion each turn, and loses it when it breathes again", async () => {
  const {suffocate, breatheAgain} = await import("../module/adapters/foundry-v14-automation-dispatcher.mjs");
  let exhaustion = 0;
  const effect = {statuses: new Set(["suffocating"]), flags: {wildpath: {}}, async setFlag(scope, key, value) { this.flags.wildpath[key] = value; }};
  const actor = {effects: [effect], system: {abilities: {fortitude: {value: 8}}},
    async toggleCondition(type, {levels}) { exhaustion += levels; }};
  effect.parent = actor;
  assert.equal(await suffocate(actor), false);
  assert.equal(effect.flags.wildpath.breathLeft, 2, "Constitution 8: 30 seconds at least, 3 turns");
  effect.flags.wildpath.breathLeft = 0;
  assert.deepEqual([await suffocate(actor), await suffocate(actor), exhaustion], [true, true, 2]);
  await breatheAgain(effect);
  assert.equal(exhaustion, 0);
});
