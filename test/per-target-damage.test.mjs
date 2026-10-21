import assert from "node:assert/strict";
import test from "node:test";

import {actionCombatStatistics} from "../module/helpers/combat-statistics.mjs";
import {resolveActionDamage} from "../module/resolvers/action-resolver.mjs";

const definition = {tags: ["spell"], attack: {type: "ranged", statistic: "spell", defenseKey: "ac"},
  damage: [{id: "beam", expression: {type: "dice", number: 1, faces: 10}, damageType: "force"}]};
const caster = {system: {abilities: {}, attributes: {prof: 2}}, getStatistic: () => ({totalModifier: 0}), getExtraDamage: () => [],
  getRollOutcomes: () => [], flags: {}};
const creature = marks => ({getExtraDamage: () => marks});
const mark = {id: "hunters-mark", expression: {type: "dice", number: 1, faces: 6}, damageType: "force"};

test("on an attack with several targets, each creature's own extra damage is meant for it alone", () => {
  const marked = creature([mark]);
  const plain = creature([]);
  const {damage} = actionCombatStatistics(caster, definition, {targets: [{actor: marked, refs: ["token:a"]}, {actor: plain, refs: ["token:b"]},
    {actor: marked, refs: ["token:a"]}]});
  assert.equal(damage.extraComponents.length, 1, "one for the marked creature, however many beams it takes");
  assert.deepEqual(damage.extraComponents[0].metadata, {ruleId: "hunters-mark", targetRefs: ["token:a"]});
  assert.deepEqual(actionCombatStatistics(caster, definition, {target: marked}).damage.extraComponents[0].metadata, {ruleId: "hunters-mark"},
    "one target: as before");
});

test("the damage resolver keeps a component meant for one creature on that creature only", () => {
  const components = [{id: "beam", amount: 5, damageType: "force"},
    {id: "extra:hunters-mark:0", amount: 4, damageType: "force", metadata: {targetRefs: ["a"]}}];
  const target = id => ({target: {id, tokenId: id}, selected: true});
  const result = resolveActionDamage({damage: {components, targetContexts: [target("a"), target("b"), target("a")]},
    actionContext: {action: {id: "blast"}, source: {id: "caster"}, targets: []}});
  assert.deepEqual(result.results.map(entry => entry.total), [9, 5, 9], "both beams at the marked creature take the mark");
});
