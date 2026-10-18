import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {promptActionConfiguration, renderConfigurationPreview} from "../module/adapters/foundry-v14-prompt-adapter.mjs";

const definition = JSON.parse(readFileSync(new URL("../packs/_source/actions/scaling-bolt.json", import.meta.url), "utf8")).system.definition;
const actorSystem = {resources: {action: {value: 1, max: 1}},
  pools: [{id: "spell-slot.1", label: "1st-level slot", value: 1, max: 1}, {id: "spell-slot.2", label: "2nd-level slot", value: 1, max: 1}]};

test("an Action's choices are asked before use, and the answer is the authority's own {choices} shape", async () => {
  let shown = null;
  const DialogV2 = {input: async options => { shown = options; return {"choice:casting-resource": "payment-1-2"}; }};
  const choices = await promptActionConfiguration({definition, actorSystem, name: "Scaling Bolt", DialogV2});
  assert.deepEqual(choices, {"casting-resource": {paymentOptionId: "payment-1-2"}});
  assert.match(shown.content, /payment-1-1/u, "every payable slot is offered");
  assert.match(shown.content, /wildpath-configuration-preview/u, "the dialog has a live preview");

  const cancelled = await promptActionConfiguration({definition, actorSystem, DialogV2: {input: async () => null}});
  assert.equal(cancelled, null, "a cancelled dialog cancels the use");
  const plain = {...definition, configuration: []};
  assert.equal(await promptActionConfiguration({definition: plain, actorSystem, DialogV2}), undefined, "no choices, no dialog");
});

test("the preview shows what a choice makes: the slot it spends and the scaled dice", () => {
  const html = renderConfigurationPreview({definition, actorSystem, choices: {"casting-resource": {resourceId: "spell-slot.2"}}});
  assert.match(html, /2nd-level slot/u);
  assert.match(html, /3d6 fire/u);
  const first = renderConfigurationPreview({definition, actorSystem, choices: {"casting-resource": {resourceId: "spell-slot.1"}}});
  assert.match(first, /2d6 fire/u);
});

test("the preview shows the chosen damage type and a table's dice at the creature's own level (a Breath Weapon's 2d10 fire)", () => {
  const breath = {schemaVersion: 1, id: "action:breath", label: "Breath Weapon", costs: {allOf: [{capability: "action", amount: 1}]},
    targeting: {type: "area"}, area: {shape: "cone", size: {value: 15, unit: "ft"}}, save: {ability: "agility", dc: {value: 13}},
    damage: [{id: "damage-1", damageType: "acid", expression: {type: "table", key: {type: "character-level"},
      rows: {0: {type: "dice", number: 1, faces: 10}, 5: {type: "dice", number: 2, faces: 10}}}}],
    configuration: [{id: "damage-type-1", type: "damage-type", label: "Damage type", required: true, allowedDamageTypes: ["acid", "fire"],
      effects: [{type: "replaceDamageType", componentIds: ["damage-1"], damageTypeChoiceId: "damage-type-1"}]}]};
  const html = renderConfigurationPreview({definition: breath, actorSystem: {...actorSystem, details: {level: 6}},
    choices: {"damage-type-1": "fire"}});
  assert.match(html, /2d10 fire/u);
});
