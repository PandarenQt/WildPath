import {test} from "node:test";
import assert from "node:assert/strict";
import {refreshChanges} from "../module/helpers/pack-refresh.mjs";
import {refreshItems, staleItems} from "../module/adapters/foundry-v14-pack-refresh.mjs";

const packed = {type: "action", name: "Fireball", system: {definition: {id: "fireball", damage: [{faces: 6}]}, ruleElements: [],
  description: "<p>new</p>", active: true}, flags: {wildpath: {source: {id: "f"}, reactionPolicy: "never"}}};

test("a refresh takes what the converter writes and keeps what play changed", () => {
  const world = {type: "action", name: "My Fireball", system: {definition: {id: "fireball", damage: [{faces: 4}], stale: true},
    ruleElements: [], description: "<p>old</p>", active: false, prepared: false}, flags: {wildpath: {source: {id: "f"}, reactionPolicy: "always",
    grantedBy: "x"}}};
  assert.deepEqual(refreshChanges(world, packed), {system: {definition: packed.system.definition, description: "<p>new</p>"}, flags: {}},
    "its name, active, prepared, reaction setting and grantedBy stay");
  assert.equal(refreshChanges({...world, system: packed.system, flags: packed.flags}, packed), null, "nothing differs");
  assert.equal(refreshChanges({...world, type: "gear"}, packed), null, "a different type is never refreshed");
  assert.deepEqual(refreshChanges({...world, system: packed.system, flags: {}}, packed).flags, {source: {id: "f"}}, "a converter flag");
});

test("the world's stale Items are found through their compendium source and refreshed, a batch per parent", async () => {
  const doc = (id, system, parent=null) => ({id, name: id, parent, _stats: {compendiumSource: "Compendium.wildpath.srd-items.Item.f"},
    toObject: () => ({type: "action", system, flags: {wildpath: {source: {id: "f"}}}})});
  const updates = [];
  const actor = {name: "Ana", updateEmbeddedDocuments: async (type, data) => updates.push(["actor", type, data])};
  const worldItem = doc("w", {definition: {id: "fireball", damage: [{faces: 4}]}});
  const owned = doc("o", packed.system, actor);
  actor.items = [owned, {id: "plain", _stats: {}}];
  let loads = 0;
  const fromUuid = async uuid => (loads++, uuid.endsWith(".f") ? {toObject: () => ({...packed, flags: {wildpath: {source: {id: "f"}}}})} : null);
  const stale = await staleItems({items: [worldItem], actors: [actor]}, fromUuid);
  assert.deepEqual(stale.map(entry => entry.item.id), ["w"], "the owned copy already matches; an Item with no source is skipped");
  assert.equal(loads, 1, "each compendium copy is loaded once");
  const replaced = [];
  const count = await refreshItems([...stale, {item: owned, changes: {system: {description: "x"}, flags: {}}}], {
    ForcedReplacement: {create: value => (replaced.push(value), {replaced: value})},
    Item: {updateDocuments: async data => updates.push(["world", data])}});
  assert.equal(count, 2);
  assert.deepEqual(updates, [["world", [{_id: "w", "system.definition": {replaced: packed.system.definition}, "system.ruleElements": [],
    "system.description": "<p>new</p>"}]],
    ["actor", "Item", [{_id: "o", "system.description": "x"}]]], "an object replaced whole; a string as it is");
});
