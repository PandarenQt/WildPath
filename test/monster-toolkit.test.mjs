import {test} from "node:test";
import assert from "node:assert/strict";
import {withResourceRestores} from "../module/resolvers/resource-resolver.mjs";
import {grantedResourcesFromRuleElements} from "../module/helpers/rule-elements.mjs";
import {validateActionDefinition, normalizeActionDefinition} from "../module/helpers/action-definitions.mjs";

test("an Action's restores refill the acting creature's pools up to their maximum, after its own payment", () => {
  const actorSystem = {pools: [{id: "ki", value: 1, max: 4}, {id: "multiattack", value: 0, max: 3}]};
  const paid = {ok: true, updates: {"system.pools.0.value": 0}, payments: [{resourceId: "ki", path: "system.pools.0.value", from: 1, to: 0, amount: 1}]};
  const plan = withResourceRestores(actorSystem, paid, [{resourceId: "multiattack", amount: 3}, {resourceId: "ki", amount: 9},
    {resourceId: "missing", amount: 1}]);
  assert.deepEqual(plan.updates, {"system.pools.0.value": 4, "system.pools.1.value": 3}, "capped at 4; Ki counts from what the payment left");
  assert.deepEqual(plan.restores.map(entry => entry.resourceId), ["multiattack", "ki"], "a pool the creature lacks is skipped");
  assert.deepEqual(plan.payments.map(entry => [entry.path, entry.from, entry.to]), [["system.pools.0.value", 1, 4],
    ["system.pools.1.value", 0, 3]], "every changed pool keeps what it held, for rollback");
  assert.equal(withResourceRestores(actorSystem, paid, []), paid);
});

test("a granted pool can start empty, empty at the start of each turn, and Recharge on a d6", () => {
  const granted = grantedResourcesFromRuleElements([{ruleElements: [
    {type: "GrantResource", data: {resourceId: "multiattack", maximum: 3, current: 0, emptiesAtTurnStart: true}},
    {type: "GrantResource", data: {resourceId: "fire-breath", maximum: 1, recharge: 5}},
    {type: "GrantResource", data: {resourceId: "odd", maximum: 1, recharge: 9}}]}]);
  const [multi, breath, odd] = ["multiattack", "fire-breath", "odd"].map(id => granted.find(entry => entry.id === id));
  assert.equal(odd.recharge, undefined, "Recharge is a d6 face from 2 to 6");
  assert.deepEqual([multi.current, multi.emptiesAtTurnStart, multi.recharge], [0, true, undefined]);
  assert.deepEqual([breath.current, breath.recharge], [1, 5]);

  const definition = {schemaVersion: 1, id: "action:multiattack", label: "Multiattack", costs: {allOf: [{capability: "action", amount: 1}]},
    targeting: {type: "none"}, restores: [{resourceId: "multiattack", amount: 3}]};
  assert.equal(validateActionDefinition(definition).ok, true);
  assert.deepEqual(normalizeActionDefinition(definition).restores, [{resourceId: "multiattack", amount: 3}]);
  assert.equal(validateActionDefinition({...definition, restores: [{resourceId: "", amount: 0}]}).ok, false);
});
