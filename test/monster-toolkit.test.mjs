import {test} from "node:test";
import assert from "node:assert/strict";
import {withResourceRestores} from "../module/resolvers/resource-resolver.mjs";
import {grantedResourcesFromRuleElements} from "../module/helpers/rule-elements.mjs";
import {validateActionDefinition, normalizeActionDefinition} from "../module/helpers/action-definitions.mjs";

test("an Action's restores refill the acting creature's pools up to their maximum, never one its payment drew from", () => {
  const actorSystem = {pools: [{id: "ki", value: 1, max: 4}, {id: "multiattack", value: 1, max: 3}]};
  const paid = {ok: true, updates: {"system.pools.0.value": 0}, payments: [{resourceId: "ki", path: "system.pools.0.value", from: 1, to: 0, amount: 1}]};
  const plan = withResourceRestores(actorSystem, paid, [{resourceId: "multiattack", amount: 9}, {resourceId: "ki", amount: 9},
    {resourceId: "missing", amount: 1}]);
  assert.deepEqual(plan.updates, {"system.pools.0.value": 0, "system.pools.1.value": 3},
    "capped at 3; Ki paid for it, so Ki is not refilled (an Extra Attack paid from its own pool)");
  assert.deepEqual(plan.restores.map(entry => entry.resourceId), ["multiattack"], "a pool the creature lacks is skipped");
  assert.deepEqual(plan.payments.map(entry => [entry.path, entry.from, entry.to]), [["system.pools.0.value", 1, 0],
    ["system.pools.1.value", 1, 3]], "every changed pool keeps what it held, for rollback");
  assert.equal(withResourceRestores(actorSystem, paid, []), paid);
});

test("an attack paid from an extra action given for listed Actions refills nothing: Haste's one attack only", () => {
  const actorSystem = {resources: {action: {value: 1, max: 1, spent: 0}}, pools: [{id: "extra-attack", value: 0, max: 1},
    {id: "haste-extra-action", value: 1, max: 1, pays: ["action"], actions: {tagsAny: ["attack"]}}]};
  const restores = [{resourceId: "extra-attack", amount: 1}];
  // The attack's costs as withExtraAttacks writes them: its pool, or the Action.
  const costs = {anyOf: [[{capability: "extra-attack", amount: 1}], [{capability: "action", amount: 1}]]};
  const hasted = {ok: true, updates: {"system.pools.1.value": 0},
    payments: [{resourceId: "haste-extra-action", path: "system.pools.1.value", from: 1, to: 0, amount: 1}]};
  assert.equal(withResourceRestores(actorSystem, hasted, restores, costs), hasted, "Extra Attack's pool stays empty");
  const acted = {ok: true, updates: {"system.resources.action.spent": 1},
    payments: [{resourceId: "economy.action", path: "system.resources.action.spent", from: 0, to: 1, amount: 1}]};
  assert.equal(withResourceRestores(actorSystem, acted, restores, costs).updates["system.pools.0.value"], 1, "the Attack action starts Extra Attack");
});

test("an Action paid from an extra action still gets the restores that are its effect, not a pool it could pay from", () => {
  // An extra Bonus Action for Flurry of Blows only: Flurry's strikes are what it does, so they still fill.
  const actorSystem = {resources: {"bonus-action": {value: 0, max: 1}}, pools: [{id: "flurry-of-blows", value: 0, max: 2},
    {id: "extra-bonus", value: 1, max: 1, pays: ["bonus-action"], actions: {tagsAny: ["id:flurry"]}}]};
  const paid = {ok: true, updates: {"system.pools.1.value": 0},
    payments: [{resourceId: "extra-bonus", path: "system.pools.1.value", from: 1, to: 0, amount: 1}]};
  const plan = withResourceRestores(actorSystem, paid, [{resourceId: "flurry-of-blows", amount: 2}],
    {allOf: [{capability: "bonus-action", amount: 1}]});
  assert.equal(plan.updates["system.pools.0.value"], 2);
});

test("a restore refused while its pool is full, and one worked out for its creature (Sorcerous Restoration)", () => {
  const actorSystem = {classes: [{id: "sorcerer", level: 7}], pools: [{id: "font-of-magic", value: 1, max: 7}, {id: "dragon-wings", value: 1, max: 1}]};
  const paid = {ok: true, updates: {}, payments: []};
  assert.equal(withResourceRestores(actorSystem, paid, [{resourceId: "dragon-wings", amount: 1, refuseWhenFull: true}]).ok, false);
  const plan = withResourceRestores(actorSystem, paid, [{resourceId: "font-of-magic", amount: 1, refuseWhenFull: true,
    amountExpression: {type: "divide", numerator: {type: "class-level", class: "sorcerer"}, denominator: {type: "constant", value: 2}, round: "floor"}}]);
  assert.deepEqual(plan.updates, {"system.pools.0.value": 4}, "1 + floor(7 / 2)");
  const normalized = normalizeActionDefinition({schemaVersion: 1, id: "a", restores: [{resourceId: "x", amount: 1, refuseWhenFull: true,
    amountExpression: {type: "constant", value: 2}}]});
  assert.deepEqual(normalized.restores, [{resourceId: "x", amount: 1, amountExpression: {type: "constant", value: 2}, refuseWhenFull: true}]);
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

test("2024 Extra Attack: a weapon attack paid with the Action fills the pool its next attack is paid from", async () => {
  const {actionDefinitionFromItem, actionDefinitionActivationCost} = await import("../module/helpers/action-definitions.mjs");
  const {resolveActorResourcePayment} = await import("../module/resolvers/resource-resolver.mjs");
  const strike = {schemaVersion: 1, id: "action:longsword", label: "Longsword", costs: {allOf: [{capability: "action", amount: 1}]},
    targeting: {type: "single", required: true, count: 1}, attack: {type: "melee", statistic: "weapon", defenseKey: "ac"},
    damage: [{id: "blade", expression: {type: "dice", number: 1, faces: 8}, damageType: "slashing", provenance: "weapon-base"}]};
  const fighter = pool => ({getExtraAttacks: () => ["extra-attack"], system: {pools: [pool]}});
  const item = (definition, actor) => ({id: "sword", type: "action", name: "Longsword", actor, system: {definition}});
  const pool = {id: "extra-attack", label: "Extra Attack", value: 0, max: 1};
  const definition = actionDefinitionFromItem(item(strike, fighter(pool))).definition;
  assert.deepEqual(actionDefinitionFromItem(item(strike, null)).definition.restores, undefined, "without Extra Attack, nothing changes");
  assert.equal(strike.costs.anyOf, undefined, "the stored definition is untouched");
  assert.deepEqual(definition.restores, [{resourceId: "extra-attack", amount: 1}]);
  const spell = {...strike, id: "action:fire-bolt", attack: {...strike.attack, statistic: "spell"}};
  assert.equal(actionDefinitionFromItem(item(spell, fighter(pool))).definition.restores, undefined, "only weapon attacks");

  // First attack: the pool is empty, so the Action pays, and the pool fills.
  const resources = (action, extra) => ({resources: {action: {value: action, max: 1}}, pools: [{...pool, value: extra}]});
  const pay = system => resolveActorResourcePayment({actorSystem: system, cost: actionDefinitionActivationCost(definition)});
  const first = pay(resources(1, 0));
  assert.deepEqual(first.paymentPlan.resources.map(entry => entry.capability), ["action"]);
  const second = pay(resources(0, 1));
  assert.equal(second.ok, true, "the second attack is paid from the pool");
  assert.equal(withResourceRestores(resources(0, 1), second.mutationPlan, definition.restores).updates["system.pools.0.value"], 0,
    "and does not refill it");
  assert.equal(pay(resources(0, 0)).ok, false, "a third attack is refused");
});

test("a restore of movement gives back what was spent: a dragon's Pounce moves it up to half its Speed", () => {
  const actorSystem = {resources: {movement: {max: 40, spent: 30, value: 10}}, pools: [{id: "move-attack-rend", value: 0, max: 1}]};
  const half = {type: "floor", value: {type: "multiply", terms: [{type: "resource-max", id: "movement"}, {type: "constant", value: 0.5}]}};
  const plan = withResourceRestores(actorSystem, {ok: true, updates: {}, payments: []},
    [{resourceId: "movement", amount: 1, amountExpression: half}, {resourceId: "move-attack-rend", amount: 1}]);
  assert.equal(plan.updates["system.resources.movement.spent"], 10, "20 of its 30 spent feet back");
  assert.equal(plan.updates["system.pools.0.value"], 1, "and one Rend to make");
  const fresh = withResourceRestores({resources: {movement: {max: 40, spent: 0}}}, {ok: true, updates: {}, payments: []},
    [{resourceId: "movement", amount: 1, amountExpression: half}]);
  assert.equal(fresh.updates["system.resources.movement.spent"], 0, "never below none spent");
});

test("converted Pounce: half its Speed back, and one Rend paid from its own pool", async () => {
  const fs = await import("node:fs");
  const file = fs.readdirSync("packs/_source/srd-creatures").find(name => name.startsWith("adult-black-dragon"));
  const dragon = JSON.parse(fs.readFileSync(`packs/_source/srd-creatures/${file}`, "utf8"));
  const pounce = dragon.items.find(item => item.name === "Pounce");
  const rend = dragon.items.find(item => item.name === "Rend");
  assert.deepEqual(pounce.system.definition.restores.map(entry => entry.resourceId), ["movement", "move-attack-rend"]);
  assert.deepEqual(pounce.system.definition.costs.allOf.map(cost => cost.capability), ["legendary-action"]);
  assert.deepEqual(rend.system.definition.costs.anyOf[0], [{capability: "move-attack-rend", amount: 1}]);
  assert.equal(validateActionDefinition(pounce.system.definition).ok, true);
  assert.deepEqual(pounce.flags.wildpath.conversion.notes, []);
});

test("converted Lash and Tail Swipe: one attack from the pool, no movement; a teleport or a move with more text is left", async () => {
  const fs = await import("node:fs");
  const creature = prefix => JSON.parse(fs.readFileSync(`packs/_source/srd-creatures/${fs.readdirSync("packs/_source/srd-creatures")
    .find(name => name.startsWith(prefix))}`, "utf8"));
  const aboleth = creature("aboleth-");
  const lash = aboleth.items.find(item => item.name === "Lash");
  assert.deepEqual(lash.system.definition.restores, [{resourceId: "move-attack-tentacle", amount: 1}]);
  assert.deepEqual(aboleth.items.find(item => item.name === "Tentacle (attack)").system.definition.costs.anyOf[0],
    [{capability: "move-attack-tentacle", amount: 1}]);
  assert.equal(validateActionDefinition(lash.system.definition).ok, true);
  assert.deepEqual(lash.flags.wildpath.conversion.notes, []);
  const swipe = creature("adult-blue-dragon-").items.find(item => item.name === "Tail Swipe");
  assert.deepEqual(swipe.system.definition.restores, [{resourceId: "move-attack-rend", amount: 1}]);
  // "can teleport up to 30 feet ..., and it makes one Claw attack": that teleport, and the attack from the pool.
  const prowl = creature("sphinx-of-lore-").items.find(item => item.name === "Arcane Prowl").system.definition;
  assert.deepEqual([prowl.teleport, prowl.restores, prowl.targeting], [{distance: 30}, [{resourceId: "move-attack-claw", amount: 1}], {type: "self"}]);
  assert.deepEqual(prowl.costs, {allOf: [{capability: "legendary-action", amount: 1}]}, "still a Legendary Action");
  assert.equal(validateActionDefinition(prowl).ok, true);
});

test("converted Onslaught and Charging Horn: 'one Claw or Tail attack' pays either; 'without provoking' is Disengaged too", async () => {
  const fs = await import("node:fs");
  const creature = prefix => JSON.parse(fs.readFileSync(`packs/_source/srd-creatures/${fs.readdirSync("packs/_source/srd-creatures")
    .find(name => name.startsWith(prefix))}`, "utf8"));
  const tarrasque = creature("tarrasque-");
  const onslaught = tarrasque.items.find(item => item.name === "Onslaught");
  assert.deepEqual(onslaught.system.definition.restores.map(entry => entry.resourceId), ["movement", "move-attack-claw"]);
  for ( const name of ["Claw", "Tail"] ) {
    assert.deepEqual(tarrasque.items.find(item => item.name === name).system.definition.costs.anyOf[0], [{capability: "move-attack-claw", amount: 1}], name);
  }
  assert.deepEqual(onslaught.flags.wildpath.conversion.notes, []);
  const horn = creature("unicorn-").items.find(item => item.name === "Charging Horn").system.definition;
  assert.deepEqual(horn.effects.map(effect => effect.slug), ["disengaged"]);
  assert.deepEqual(horn.costs, {allOf: [{capability: "legendary-action", amount: 1}]});
  assert.equal(validateActionDefinition(horn).ok, true);
});
