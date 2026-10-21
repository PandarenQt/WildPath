import {test} from "node:test";
import assert from "node:assert/strict";
import {partyMembers, restParty} from "../module/applications/party-rest.mjs";

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
