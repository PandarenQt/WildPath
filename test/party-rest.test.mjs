import {test} from "node:test";
import assert from "node:assert/strict";
import {partyMembers, registerPartyRest, restParty} from "../module/applications/party-rest.mjs";

test("a party rest rests each player character, then moves the world's time on by its hours", async () => {
  const rested = [];
  const actor = (name, type, owned) => ({name, type, hasPlayerOwner: owned, rest: async kind => rested.push(`${name}:${kind}`)});
  const party = partyMembers([actor("Ana", "character", true), actor("Goblin", "npc", false), actor("Hireling", "character", false)]);
  assert.deepEqual(party.map(entry => entry.name), ["Ana"]);
  const advanced = [];
  await restParty("longRest", {actors: party, time: {advance: async seconds => advanced.push(seconds)}});
  assert.deepEqual([rested, advanced], [["Ana:longRest"], [8 * 3600]]);
  assert.deepEqual(await restParty("nap", {actors: party, time: {advance: async () => advanced.push(0)}}), [], "no such rest");
});

test("a party rest names only the creatures that rested: not one a Forbid barred (rest returned false)", async () => {
  const actor = (name, barred) => ({name, type: "character", hasPlayerOwner: true, rest: async () => !barred});
  const advanced = [];
  const rested = await restParty("longRest", {actors: [actor("Ana", false), actor("Copy", true), actor("Bo", false)],
    time: {advance: async seconds => advanced.push(seconds)}});
  assert.deepEqual(rested.map(entry => entry.name), ["Ana", "Bo"]);
  assert.deepEqual(advanced, [8 * 3600], "the world's time still moves on");
});

test("the GM's party rest posts no chat line when a Forbid barred every party member", async () => {
  const saved = {Hooks: globalThis.Hooks, game: globalThis.game, foundry: globalThis.foundry, ChatMessage: globalThis.ChatMessage};
  const posted = [];
  const controls = {tokens: {tools: {}}};
  const member = barred => ({name: "Ana", type: "character", hasPlayerOwner: true, rest: async () => !barred});
  try {
    globalThis.Hooks = {on: (hook, fn) => fn(controls)};
    globalThis.foundry = {applications: {api: {DialogV2: {wait: async () => "longRest"}}}};
    globalThis.ChatMessage = {create: async message => posted.push(message.content)};
    for ( const barred of [true, false] ) {
      globalThis.game = {user: {isGM: true}, actors: [member(barred)], time: {advance: async () => {}},
        i18n: {localize: key => key, format: (key, data) => `${data.rest}: ${data.names}.`}};
      registerPartyRest();
      controls.tokens.tools.partyRest.onChange();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally {
    Object.assign(globalThis, saved);
  }
  assert.deepEqual(posted, ["WILDPATH.REST.Long: Ana."], "only the rest that named someone");
});
