import {test} from "node:test";
import assert from "node:assert/strict";
import {effectReactionItems} from "../module/adapters/foundry-v14-reaction-provider.mjs";

test("an effect's reaction saves at the DC of the creature that gave it, and one set to Always needs no prompt (Sanctuary)", () => {
  const caster = {uuid: "Actor.caster", system: {spellcasting: {modifier: 3}, attributes: {proficiency: 2}, details: {level: 1}}};
  const action = {schemaVersion: 1, id: "action:sanctuary-ward", label: "Sanctuary", costs: {allOf: []}, counters: true,
    save: {ability: "wits", dc: {fromSource: true, valueExpression: {type: "add", terms: [{type: "constant", value: 8},
      {type: "spellcasting-modifier"}]}}}};
  const warded = {effects: [{id: "ward", name: "Warded", disabled: false, flags: {wildpath: {conditionEffect: {sourceRef: "Actor.caster"}}},
    system: {ruleElements: [{type: "Trigger", id: "sanctuary", data: {kind: "reaction", event: "action.declared", policy: "always", action}}]}}]};
  const [item] = effectReactionItems(warded, {fromUuidSync: uuid => (uuid === "Actor.caster" ? caster : null)});
  assert.deepEqual(item.system.definition.save.dc, {value: 11}, "8 + its caster's spellcasting modifier");
  assert.equal(item.flags.wildpath.reactionPolicy, "always");
  assert.equal(item.system.ruleElements[0].data.policy, undefined, "the policy is the item's, not the trigger's");
  assert.deepEqual(effectReactionItems(warded, {fromUuidSync: () => null}), [], "no caster to read: no ward");
});
