import {test} from "node:test";
import assert from "node:assert/strict";
import {consumeScrollOf, highestSpellLevel, scrollDefinition, scrollItemData, spellLevelOf} from "../module/helpers/spell-scrolls.mjs";
import {resolveActorAttackStatistic} from "../module/helpers/combat-statistics.mjs";

const fireball = {schemaVersion: 1, id: "action:fireball", tags: ["spell"], costs: {allOf: [{capability: "action", amount: 1}]},
  save: {ability: "agility", dc: {valueExpression: {type: "spellcasting-dc"}}}, metadata: {spellLevel: 3},
  configuration: [{id: "spell-slot", type: "resource", levelByResourceId: {"spell-slot.3": 3, "spell-slot.4": 4}}]};

test("a Spell Scroll casts its spell at its own level, with no slot, and the scroll's DC and attack bonus", () => {
  const scroll = scrollDefinition(fireball);
  assert.deepEqual([scroll.id, scroll.scroll, scroll.configuration, scroll.save.dc, scroll.metadata.spellLevel, scroll.tags],
    ["action:fireball:scroll", true, [], {value: 15}, 3, ["spell", "scroll"]]);
  const bolt = scrollDefinition({id: "action:bolt", tags: ["spell"], attack: {type: "ranged", statistic: "spell"}, configuration: []});
  assert.deepEqual([spellLevelOf(bolt), bolt.attack.fixedBonus], [0, 5], "a cantrip: +5");
  assert.equal(spellLevelOf({configuration: fireball.configuration}), 3, "the lowest its slot names");
  const data = scrollItemData({name: "Fireball", img: "x.webp", system: {definition: fireball, description: "<p>Boom</p>"}});
  assert.deepEqual([data.name, data.type, data.flags.wildpath.grantedActions[0].name], ["Spell Scroll (Fireball)", "gear", "Fireball (Scroll)"]);
});

test("its reader's highest spell level, its attack bonus fixed, and reading it uses up one", async () => {
  assert.equal(highestSpellLevel({system: {spellcasting: {slots: [4, 3, 2, 0, 0, 0, 0, 0, 0], pact: {slots: 0, level: 0}}}}), 3);
  assert.equal(highestSpellLevel({system: {spellcasting: {slots: [], pact: {slots: 2, level: 5}}}}), 5);
  assert.equal(highestSpellLevel({system: {}}), 0);
  const statistic = resolveActorAttackStatistic({id: "a", system: {}}, {type: "ranged", statistic: "spell", fixedBonus: 7}, {tags: ["spell"]});
  assert.equal(statistic.totalModifier, 7);
  const events = [];
  const scroll = {system: {quantity: 2}, update: async changes => events.push(changes), delete: async () => events.push("gone")};
  const action = {flags: {wildpath: {grantedBy: "s"}}, actor: {items: {get: () => scroll}}};
  await consumeScrollOf(action);
  scroll.system.quantity = 1;
  await consumeScrollOf(action);
  assert.deepEqual(events, [{"system.quantity": 1}, "gone"]);
});

test("a scroll is read only by a creature with its spell on one of its classes' spell lists (2024)", async () => {
  const {onSpellList} = await import("../module/helpers/spell-scrolls.mjs");
  const {spellListsOf} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  const lists = spellListsOf([{name: "Spells", pages: [
    {type: "spells", system: {identifier: "wizard", spells: ["Compendium.dnd5e.spells24.Item.phbsplFireball00"]}},
    {type: "spells", system: {identifier: "sorcerer", spells: ["Compendium.dnd5e.spells24.Item.phbsplFireball00"]}},
    {type: "text", system: {}}]}]);
  assert.deepEqual(lists, {phbsplFireball00: ["wizard", "sorcerer"]});
  const fireball = {metadata: {spellLevel: 3, spellLists: lists.phbsplFireball00}};
  const caster = classes => ({items: classes.map(identifier => ({type: "class", system: {identifier}}))});
  assert.equal(onSpellList(caster(["wizard"]), fireball), true);
  assert.equal(onSpellList(caster(["cleric"]), fireball), false);
  assert.equal(onSpellList(caster(["cleric", "sorcerer"]), fireball), true, "a multiclass character with the list");
  assert.equal(onSpellList(caster(["cleric"]), {metadata: {spellLevel: 3}}), true, "a spell on no list");
});
