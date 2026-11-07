import {test} from "node:test";
import assert from "node:assert/strict";
import {combatantOf, combatOf, creatureToken, creatureTokens} from "../module/adapters/foundry-v14-creature-tokens.mjs";

test("a creature's Tokens are found on every Scene, not only the one the canvas shows", () => {
  const own = {id: "own", parent: {id: "s"}};
  assert.deepEqual(creatureTokens({isToken: true, token: own}), [own], "a synthetic Actor: its own Token");
  const asked = [];
  const linked = {getActiveTokens: () => [], getDependentTokens: options => { asked.push(options); return [own]; }};
  assert.deepEqual(creatureTokens(linked), [own]);
  assert.deepEqual(asked, [{linked: true, concreteOnly: true}], "its linked Tokens that are on their Scenes");
  assert.deepEqual([creatureTokens(null), creatureTokens({isToken: true, token: null})], [[], []]);
});

test("a Token's combat holds its Combatant on its own Scene, a started one first, not the one the tracker shows", () => {
  const token = {id: "t", parent: {id: "dungeon"}};
  const mine = {tokenId: "t", sceneId: "dungeon"};
  const fight = {id: "fight", started: true, combatants: [mine]};
  const shown = {id: "shown", started: true, combatants: [{tokenId: "t", sceneId: "overworld"}]};
  const waiting = {id: "waiting", started: false, combatants: [mine]};
  assert.equal(combatOf(token, {combat: shown, combats: [shown, waiting, fight]}), fight);
  assert.equal(combatOf(token, {combats: [shown, waiting]}), waiting, "one not begun yet: initiative comes first");
  assert.equal(combatOf(token, {combats: [shown]}), null, "a same-id Token elsewhere");
  assert.equal(combatOf(null, {combats: [fight]}), null);
  assert.equal(combatantOf(token, fight), mine);
  assert.equal(combatantOf(token, shown), null);
});

test("a creature's one Token: the fighting one, else on the active Scene, else its first", () => {
  const camp = {id: "camp", parent: {id: "overworld"}};
  const party = {id: "party", parent: {id: "town", active: true}};
  const hero = {id: "hero", parent: {id: "dungeon"}};
  const actor = {getDependentTokens: () => [camp, party, hero]};
  const fight = {started: true, combatants: [{tokenId: "hero", sceneId: "dungeon"}]};
  assert.equal(creatureToken(actor, {combats: [fight]}), hero);
  assert.equal(creatureToken(actor, {combats: [{...fight, started: false}]}), party, "a combat not begun is no fight yet");
  assert.equal(creatureToken(actor, {combats: []}), party);
  assert.equal(creatureToken({getDependentTokens: () => [camp, hero]}, {}), camp);
  assert.equal(creatureToken({getDependentTokens: () => []}, {}), null);
});
