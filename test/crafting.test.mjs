import {test} from "node:test";
import assert from "node:assert/strict";
import {coinsInCopper, craftingPlan, spendGold} from "../module/helpers/crafting.mjs";

test("2024 crafting: mundane by price, magic by rarity (half for consumables), a scroll by its spell's level", () => {
  assert.deepEqual(craftingPlan({price: 50}), {days: 5, cost: 25}, "a Longbow");
  assert.deepEqual(craftingPlan({price: 1}), {days: 1, cost: 0.5});
  assert.deepEqual(craftingPlan({price: 400, rarity: "uncommon"}), {days: 10, cost: 200});
  assert.deepEqual(craftingPlan({price: 50, rarity: "common", consumable: true}), {days: 3, cost: 25}, "a Potion of Healing");
  assert.deepEqual(craftingPlan({scrollLevel: 3}), {days: 5, cost: 150});
});

test("spending gold makes change from a character's coins, or refuses when it has too little", () => {
  assert.equal(coinsInCopper({gp: 3, sp: 5, cp: 2, pp: 1, ep: 2}), 1452);
  assert.deepEqual(spendGold({gp: 30}, 25), {pp: 0, gp: 5, sp: 0, cp: 0, ep: 0});
  assert.deepEqual(spendGold({pp: 1}, 0.5), {pp: 0, gp: 9, sp: 5, cp: 0, ep: 0});
  assert.equal(spendGold({gp: 1}, 2), null);
});

test("crafting from an item sheet gives back the coins when its item is refused, and posts no chat card", async t => {
  const saved = {foundry: globalThis.foundry, game: globalThis.game, ui: globalThis.ui, ChatMessage: globalThis.ChatMessage, error: console.error};
  t.after(() => { console.error = saved.error; delete saved.error; Object.assign(globalThis, saved); });
  globalThis.foundry = {applications: {api: {HandlebarsApplicationMixin: base => base, DialogV2: {input: async () => ({actor: "hero"})}},
    sheets: {ItemSheetV2: class {}}}, utils: {escapeHTML: text => text}};
  const {default: WildPathItemSheet} = await import("../module/applications/item-sheet.mjs");
  const craft = WildPathItemSheet.DEFAULT_OPTIONS.actions.craft;
  const item = {name: "Rope", system: {price: 20}, flags: {}, toObject: () => ({_id: "r", name: "Rope", system: {price: 20, quantity: 5}})};
  const world = (create, update) => {
    const actor = {id: "hero", name: "Hero", type: "character", hasPlayerOwner: true, system: {currency: {gp: 30}}, items: [],
      createEmbeddedDocuments: create ?? (async (type, data) => { actor.items.push(...data); return data; })};
    actor.update = update?.(actor) ?? (async data => { actor.system.currency = data["system.currency"]; });
    const cards = [];
    const errors = [];
    globalThis.game = {actors: Object.assign([actor], {get: id => (id === "hero" ? actor : undefined)}),
      i18n: {format: key => key, localize: key => key}};
    globalThis.ui = {notifications: {warn: () => {}, error: message => errors.push(message)}};
    globalThis.ChatMessage = {create: async ({content}) => { cards.push(content); }};
    console.error = () => {};
    return {actor, cards, errors};
  };
  const paid = world();
  await craft.call({item});
  assert.deepEqual([coinsInCopper(paid.actor.system.currency), paid.actor.items[0].system.quantity, paid.cards], [2000, 1, ["WILDPATH.CRAFT.Done"]]);
  // Foundry resolves a creation a _preCreate refuses with none made.
  const refused = world(async () => []);
  await craft.call({item});
  assert.deepEqual([refused.actor.system.currency, refused.cards, refused.errors], [{gp: 30}, [], ["WILDPATH.CRAFT.Failed"]]);
  // Neither the item nor the refund lands: the GM is told to check its coins.
  const stuck = world(async () => { throw new Error("no item"); },
    actor => async data => { if ( data["system.currency"].gp === 30 ) throw new Error("no refund"); actor.system.currency = data["system.currency"]; });
  await craft.call({item});
  assert.deepEqual([stuck.cards, stuck.errors], [[], ["WILDPATH.CRAFT.FailedUndo"]]);
});
