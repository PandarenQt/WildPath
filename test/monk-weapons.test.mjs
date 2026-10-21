import assert from "node:assert/strict";
import test from "node:test";

import {actionCombatStatistics} from "../module/helpers/combat-statistics.mjs";
import {actionDefinitionToResolverInput} from "../module/helpers/action-definitions.mjs";

const shortsword = {id: "shortsword", tags: [], attack: {type: "melee", statistic: "weapon", defenseKey: "ac", properties: ["finesse", "light"],
  weapon: {category: "martial", base: "shortsword"}},
  damage: [{id: "blade", expression: {type: "dice", number: 1, faces: 6}, damageType: "piercing", provenance: "weapon-base"}]};
const martialArts = faces => ({id: "martial-arts-die", expression: {type: "dice", number: 1, faces}, replacesBase: true});
const monk = (entries, seen=[]) => ({system: {abilities: {might: {value: 10}, agility: {value: 16}}, attributes: {prof: 2}},
  getStatistic: () => ({totalModifier: 0}), getRollOutcomes: () => [], flags: {},
  getExtraDamage: (_domains, {tags}) => { seen.push(tags); return entries; }});

test("a die rolled in place of the weapon's own when larger: a Monk's Martial Arts die", () => {
  const seen = [];
  const {damage} = actionCombatStatistics(monk([martialArts(8)], seen), shortsword);
  assert.deepEqual(damage.baseExpression, {type: "dice", number: 1, faces: 8}, "1d8 over the shortsword's 1d6");
  assert.equal(damage.extraComponents, undefined, "it is not extra damage");
  assert.ok(seen[0].includes("category:martial") && seen[0].includes("light"), "a rule sees the weapon's kind and properties");
  assert.equal(actionCombatStatistics(monk([martialArts(4)]), shortsword).damage?.baseExpression, undefined, "a smaller die is not used");
  const input = actionDefinitionToResolverInput(shortsword, {damage});
  assert.deepEqual([input.damage.components[0].dice.number, input.damage.components[0].dice.faces], [1, 8], "the Action rolls the Martial Arts die");
});
