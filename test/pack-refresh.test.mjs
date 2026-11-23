import {test} from "node:test";
import assert from "node:assert/strict";
import {refreshChanges} from "../module/helpers/pack-refresh.mjs";
import {refreshItems, removeItems, staleItems} from "../module/adapters/foundry-v14-pack-refresh.mjs";

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
  const {stale, removed} = await staleItems({items: [worldItem], actors: [actor]}, fromUuid);
  assert.deepEqual(removed, []);
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

const fromPack = (id, system, parent=null, uuid="Compendium.wildpath.srd-items.Item.f") => ({id, name: id, parent, _stats: {compendiumSource: uuid},
  toObject: () => ({type: "action", system, flags: {wildpath: {source: {id: "f"}}}})});
const oldSystem = {definition: {id: "fireball", damage: [{faces: 4}]}};
const loadPacked = async uuid => (uuid.endsWith(".f") ? {toObject: () => ({...packed, flags: {wildpath: {source: {id: "f"}}}})} : null);

test("an unlinked Token's own Items are refreshed through its synthetic Actor; inherited ones and linked Tokens through the world Actor", async () => {
  const updates = [];
  const synthetic = {name: "Goblin", isToken: true, updateEmbeddedDocuments: async (type, data) => updates.push(["synthetic", type, data])};
  const changed = fromPack("changed", oldSystem, synthetic);
  const inherited = fromPack("inherited", oldSystem, synthetic);
  synthetic.items = [changed, inherited];
  const unlinked = {actorLink: false, actor: synthetic, delta: {items: {manages: id => id === "changed"}}};
  synthetic.token = unlinked;
  const worldActor = {name: "Ana", items: [fromPack("own", oldSystem)]};
  const linked = {actorLink: true, actor: worldActor, delta: {items: {manages: () => true}}};
  const gone = {actorLink: false, actor: null};
  const {stale} = await staleItems({actors: [worldActor], scenes: [{tokens: [unlinked, linked, gone]}]}, loadPacked);
  assert.deepEqual(stale.map(entry => entry.item.id), ["own", "changed"],
    "the delta's own copy is walked; an inherited copy is the world Actor's to refresh, a linked Token's Actor walked once");
  await refreshItems(stale.slice(1), {ForcedReplacement: {create: value => value}, Item: {updateDocuments: async () => assert.fail("not a world Item")}});
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].slice(0, 2), ["synthetic", "Item"], "written through the synthetic Actor, which Foundry routes to its ActorDelta");
  assert.equal(updates[0][2][0]._id, "changed");
});

test("an Item whose compendium copy is gone from an installed pack is reported and can be removed; an uninstalled pack's is not", async () => {
  const deletes = [];
  const actor = {name: "Ana", deleteEmbeddedDocuments: async (type, ids) => deletes.push(["actor", type, ids])};
  const removedOwned = fromPack("owned", oldSystem, actor, "Compendium.wildpath.srd-spells.Item.trueStrikeAttack");
  actor.items = [removedOwned, fromPack("offBook", oldSystem, actor, "Compendium.premium-book.spells.Item.x")];
  const removedWorld = fromPack("world", oldSystem, null, "Compendium.wildpath.srd-spells.Item.gone");
  const packs = new Map([["wildpath.srd-spells", {}], ["wildpath.srd-items", {}]]);
  const {stale, removed} = await staleItems({packs, items: [removedWorld, fromPack("current", packed.system)], actors: [actor]}, loadPacked);
  assert.deepEqual(stale, []);
  assert.deepEqual(removed.map(item => item.id), ["world", "owned"], "a turned-off book's Item is neither stale nor removed");
  assert.equal(await removeItems(removed, {Item: {deleteDocuments: async ids => deletes.push(["world", ids])}}), 2);
  assert.deepEqual(deletes, [["world", ["world"]], ["actor", "Item", ["owned"]]], "a batch per parent");
});

test("a stat block's Items, which carry no link of their own, refresh from the Item of their source id on their Actor's compendium copy", async () => {
  const updates = [];
  const statItem = (id, sourceId, parent) => ({id, name: id, parent, _stats: {compendiumSource: null}, flags: {wildpath: {source: {id: sourceId}}},
    toObject: () => ({type: "action", system: oldSystem, flags: {wildpath: {source: {id: sourceId}}}})});
  const actorUuid = "Compendium.wildpath.srd-creatures.Actor.bandit";
  const bandit = {name: "Bandit", _stats: {compendiumSource: actorUuid},
    updateEmbeddedDocuments: async (type, data) => updates.push(["bandit", data.map(update => update._id)])};
  bandit.items = [statItem("scimitar", "s1", bandit), statItem("added", "elsewhere", bandit)];
  const synthetic = {name: "Bandit", isToken: true, _stats: {compendiumSource: actorUuid},
    updateEmbeddedDocuments: async (type, data) => updates.push(["token", data.map(update => update._id)])};
  synthetic.items = [statItem("scimitar", "s1", synthetic), statItem("inherited", "s1", synthetic)];
  synthetic.token = {actorLink: false, actor: synthetic, delta: {items: {manages: id => id === "scimitar"}}};
  const packActor = {items: [{flags: {wildpath: {source: {id: "s1"}}}, toObject: () => ({...packed, flags: {wildpath: {source: {id: "s1"}}}})}]};
  const loads = [];
  const fromUuid = async uuid => (loads.push(uuid), uuid === actorUuid ? packActor : null);
  const {stale, removed} = await staleItems({packs: new Map([["wildpath.srd-creatures", {}]]), actors: [bandit],
    scenes: [{tokens: [synthetic.token]}]}, fromUuid);
  assert.deepEqual(stale.map(entry => [entry.item.parent.name, entry.item.id]), [["Bandit", "scimitar"], ["Bandit", "scimitar"]],
    "the world Actor's and the unlinked Token's own copy; an inherited copy is the world Actor's");
  assert.equal(stale[1].item.parent, synthetic);
  assert.deepEqual(removed, [], "an Item missing from the Actor's copy may have come from elsewhere, so it is not offered for removal");
  assert.deepEqual(loads, [actorUuid], "the Actor's copy is loaded once");
  await refreshItems(stale, {ForcedReplacement: {create: value => value}, Item: {updateDocuments: async () => assert.fail("not a world Item")}});
  assert.deepEqual(updates, [["bandit", ["scimitar"]], ["token", ["scimitar"]]]);
});

test("a compendium entry that fails to load is neither stale nor reported as removed", async () => {
  const {stale, removed} = await staleItems({packs: new Map([["wildpath.srd-items", {}]]), items: [fromPack("w", oldSystem)]},
    async () => { throw new Error("socket closed"); });
  assert.deepEqual([stale, removed], [[], []]);
});
