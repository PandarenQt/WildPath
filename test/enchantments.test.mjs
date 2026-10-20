import {test} from "node:test";
import assert from "node:assert/strict";
import {enchantEffectFor, enchantmentsPastLimit} from "../module/adapters/foundry-v14-enchantments.mjs";
import {hostedRules} from "../module/helpers/effect-sources.mjs";
import {actionDefinitionFromItem} from "../module/helpers/action-definitions.mjs";

test("an enchantment's effect by level, and how many of its creator's oldest end past its limit", () => {
  const effects = [{name: "+1", level: {max: 9, class: "artificer"}, ruleElements: []}, {name: "+2", level: {min: 10, class: "artificer"}, ruleElements: []}];
  assert.equal(enchantEffectFor(effects, 2)?.name, "+1");
  assert.equal(enchantEffectFor(effects, 10)?.name, "+2");
  assert.equal(enchantEffectFor([{name: "any", ruleElements: []}], 1)?.name, "any", "no range: always");
  assert.equal(enchantmentsPastLimit([{at: 1}, {at: 2}], 2), 1, "a third with a limit of 2 ends the oldest");
  assert.equal(enchantmentsPastLimit([{at: 1}], 2), 0);
});

test("an Item's effect binds {{host}} to that Item; an Actor's effect keeps its rules", () => {
  const rules = [{type: "Modifier", predicate: {tagsAny: ["weapon:{{host}}"]}}];
  const onItem = {parent: {documentName: "Item", id: "sword"}, system: {ruleElements: rules}};
  assert.deepEqual(hostedRules(onItem)[0].predicate.tagsAny, ["weapon:sword"]);
  assert.equal(hostedRules(onItem), hostedRules(onItem), "bound once");
  assert.equal(hostedRules({parent: {documentName: "Actor", id: "a"}, system: {ruleElements: rules}}), rules);
});

test("an enchantment's Item choice: its creature's own gear of the kinds it suits", () => {
  const items = [
    {id: "sword", type: "gear", name: "Longsword", system: {}},
    {id: "plate", type: "gear", name: "Plate", system: {armor: "heavy"}},
    {id: "board", type: "gear", name: "Shield", system: {armor: "shield"}},
    {id: "rope", type: "gear", name: "Rope", system: {}},
    {id: "slash", type: "action", name: "Longsword", flags: {wildpath: {grantedBy: "sword"}}, system: {definition: {attack: {weapon: {base: "longsword"}}}}},
    {id: "dagger", type: "action", name: "Dagger", system: {definition: {attack: {weapon: {base: "dagger"}}}}}
  ];
  const choice = kinds => ({schemaVersion: 1, id: "action:infuse", label: "Infuse", costs: {allOf: []}, targeting: {type: "self"},
    configuration: [{id: "item", type: "select-one", label: "Item", required: true, options: [], optionsFrom: {type: "gear", kinds}}]});
  const options = kinds => actionDefinitionFromItem({type: "action", actor: {items}, system: {definition: choice(kinds)}})
    .definition.configuration[0].options.map(option => option.value);
  assert.deepEqual(options(["weapon"]), ["sword", "dagger"], "gear granting an attack, and a weapon that is its attack");
  assert.deepEqual(options(["armor", "shield"]), ["plate", "board"]);
  assert.deepEqual(options([]), ["sword", "dagger", "plate", "board", "rope"], "any Item");
});
