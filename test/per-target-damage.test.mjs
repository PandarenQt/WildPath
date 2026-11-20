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

test("extra damage gated on the d20 (natural) counts only on the creature whose own hit showed it", () => {
  const components = [{id: "beam", amount: 5, damageType: "force"},
    {id: "extra:natural-20", amount: 15, damageType: "necrotic", metadata: {ruleId: "natural-20", natural: 20}}];
  const target = (id, instance) => ({target: {id, tokenId: id}, selected: true, ...(instance == null ? {} : {instance})});
  const hit = (id, die, instance) => ({target: {id, tokenId: id}, targetContext: target(id, instance), roll: {total: die + 5, die}});
  const totals = (hits, targetContexts) => resolveActionDamage({damage: {components, targetContexts},
    attackResolution: {hits}, actionContext: {action: {id: "blast"}, source: {id: "caster"}, targets: []}}).results.map(entry => entry.total);
  assert.deepEqual(totals([hit("a", 20), hit("b", 12)], [target("a"), target("b")]), [20, 5], "the 20 against A only");
  assert.deepEqual(totals([hit("a", 20, 0), hit("a", 7, 1)], [target("a", 0), target("a", 1)]), [20, 5],
    "each ray at one creature judged by its own roll");
  assert.deepEqual(resolveActionDamage({damage: {components, targetContexts: [target("a")]},
    actionContext: {action: {id: "burst"}, source: {id: "caster"}, targets: []}}).results.map(entry => entry.total), [5],
  "no attack (a save's damage): never");
});

test("a rule's natural reaches its extra damage component's metadata, for the attack's own and its target's rules", () => {
  const gated = {id: "natural-20", expression: {type: "constant", value: 15}, damageType: "necrotic", natural: 20};
  const {damage} = actionCombatStatistics({...caster, getExtraDamage: () => [gated]}, definition, {target: creature([{...mark, natural: 19}])});
  assert.deepEqual(damage.extraComponents.map(component => component.metadata), [{ruleId: "natural-20", natural: 20},
    {ruleId: "hunters-mark", natural: 19}]);
});

test("an extra damage component carries its item's or effect's name, which names a fixed amount of it on the card", () => {
  const smiting = {id: "smiting", expression: {type: "constant", value: 7}, damageType: "bludgeoning", natural: 20,
    source: {type: "ruleElement", parent: {type: "item", id: "mace", name: "Mace of Smiting"}}};
  const {damage} = actionCombatStatistics({...caster, getExtraDamage: () => [smiting]}, definition, {});
  assert.deepEqual(damage.extraComponents[0].metadata, {ruleId: "smiting", sourceName: "Mace of Smiting", natural: 20});
});
