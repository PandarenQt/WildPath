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
