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

test("Mirror Image: its reaction rolls a d6 per duplicate left, its effect's level; a decoyed hit takes a level off", async () => {
  const fs = await import("node:fs");
  const {spendDecoys} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const {actionDefinitionToResolverInput} = await import("../module/helpers/action-definitions.mjs");
  const spell = JSON.parse(fs.readFileSync(`packs/_source/srd-items/${fs.readdirSync("packs/_source/srd-items")
    .find(file => file.startsWith("mirror-image-"))}`, "utf8"));
  const [effect] = spell.system.definition.effects;
  assert.deepEqual([effect.name, effect.levels, spell.flags.wildpath.conversion.notes], ["Mirror Image", 3, []], "one effect: three duplicates");
  // The custom effect starts at three levels.
  const [condition] = actionDefinitionToResolverInput(spell.system.definition).effects.conditions;
  assert.deepEqual([condition.levels, Object.values(condition.conditionDefinitions)[0].stacking], [3, true]);

  const imaged = level => ({effects: [{id: "images", name: "Mirror Image", disabled: false, flags: {wildpath: {conditionEffect: {}}},
    system: {level, ruleElements: effect.ruleElements}}]});
  const [item] = effectReactionItems(imaged(2));
  assert.deepEqual(item.system.definition.rider.missChance, {dice: {type: "dice", number: 2, faces: 6}, keep: "highest", atLeast: 3},
    "two duplicates left: 2d6, the highest");
  assert.equal(item.flags.wildpath.reactionPolicy, "always", "no choice: rolled at once");

  const changes = [];
  const bearer = level => {
    const [images] = imaged(level).effects;
    images.update = async data => changes.push(["update", data]);
    images.delete = async () => changes.push(["delete"]);
    return {effects: [images]};
  };
  const scene = actors => ({tokens: {get: id => (actors[id] ? {actor: actors[id]} : null)}});
  const state = {source: {tokenRef: "Scene.s.Token.orc"}, results: {attackResolution: {results: [{target: {tokenId: "wizard"}, decoy: true},
    {target: {tokenId: "fighter"}, hit: true}]}}};
  await spendDecoys({state}, {fromUuid: async () => ({parent: scene({wizard: bearer(3)})})});
  await spendDecoys({state}, {fromUuid: async () => ({parent: scene({wizard: bearer(1)})})});
  assert.deepEqual(changes, [["update", {"system.level": 2}], ["delete"]], "three to two; the last one ends the spell");
  // A decoy another reaction made (Illusory Self's certain miss) spends no duplicate; Mirror Image's own (its id) does.
  const decoyBy = from => ({...state, results: {attackResolution: {results: [{target: {tokenId: "wizard"}, decoy: true, decoyFrom: from}]}}});
  changes.length = 0;
  await spendDecoys({state: decoyBy("action:illusory-self")}, {fromUuid: async () => ({parent: scene({wizard: bearer(3)})})});
  assert.deepEqual(changes, [], "Illusory Self's decoy leaves the duplicates");
  await spendDecoys({state: decoyBy(effect.ruleElements[0].data.action.id)}, {fromUuid: async () => ({parent: scene({wizard: bearer(3)})})});
  assert.deepEqual(changes, [["update", {"system.level": 2}]]);
});
