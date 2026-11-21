import {test} from "node:test";
import assert from "node:assert/strict";

// Only the globals needed to import the real sheet and Actor classes; no Foundry application emulation.
const dropped = [];
class SheetBase { async _onDropItem(event, item) { dropped.push(item.type); return null; } }
globalThis.Actor = class {};
globalThis.foundry = {
  applications: {api: {HandlebarsApplicationMixin: Base => class extends Base {}, ApplicationV2: class {}, DialogV2: class {}},
    sheets: {ActorSheetV2: SheetBase, ItemSheetV2: class {}}},
  data: {fields: {}, ActiveEffectTypeDataModel: class {}},
  utils: {isEmpty: value => Object.keys(value).length === 0}
};
const warned = [];
globalThis.game = {i18n: {format: (key, data) => `${key}:${data.name}:${data.by}`}};
globalThis.ui = {notifications: {warn: message => void warned.push(message)}};
const {default: WildPathActor} = await import("../module/documents/actor.mjs");
const {default: WildPathActorSheet} = await import("../module/applications/actor-sheet.mjs");

/** A sheet on a creature whose one effect carries `rule`; what it is asked to look up or spend is recorded. */
function sheetOf(rule) {
  const asked = [];
  const effects = rule ? [{name: "Simulacrum", disabled: false, isSuppressed: false, system: {ruleElements: [rule]}}] : [];
  const actor = Object.assign(Object.create(WildPathActor.prototype), {id: "copy", uuid: "Actor.copy", name: "Ana", effects,
    statuses: new Set(), flags: {}, system: {}, items: Object.assign([], {get: id => void asked.push(`item:${id}`)}),
    spendHitDice: async () => void asked.push("hit dice"), rest: async kind => void asked.push(`rest:${kind}`)});
  actor.allApplicableEffects = () => effects;
  const sheet = Object.assign(Object.create(WildPathActorSheet.prototype), {actor});
  Object.defineProperty(sheet, "isEditable", {value: true});
  return {sheet, asked};
}
const forbid = actions => ({schemaVersion: 1, id: "copy-bars", type: "Forbid", data: {actions}});
const {actions} = WildPathActorSheet.DEFAULT_OPTIONS;

test("the sheet's level-up button and a class drop are refused by a level-up Forbid; a background drop is not", async () => {
  warned.length = dropped.length = 0;
  const {sheet, asked} = sheetOf(forbid({tagsAny: ["level-up"]}));
  await actions.levelUp.call(sheet, {}, {dataset: {itemId: "wizard"}});
  assert.deepEqual(asked, [], "the class is never looked up");
  assert.equal(await sheet._onDropItem({}, {type: "class", parent: null}), null);
  assert.deepEqual(dropped, [], "no class Item is created");
  assert.deepEqual(warned, ["WILDPATH.REFUSAL.Forbidden:Ana:Simulacrum", "WILDPATH.REFUSAL.Forbidden:Ana:Simulacrum"]);
  await sheet._onDropItem({}, {type: "background", parent: null});
  await sheet._onDropItem({}, {type: "class", parent: {uuid: "Actor.copy"}});
  assert.deepEqual(dropped, ["background", "class"], "a background's choices stay open, and a class already its own only moves");
  const free = sheetOf(null);
  await actions.levelUp.call(free.sheet, {}, {dataset: {itemId: "wizard"}});
  assert.deepEqual(free.asked, ["item:wizard"], "without the Forbid its class levels up");
});

test("the sheet's rest button refused by a Forbid spends no Hit Dice and does not rest", async () => {
  warned.length = 0;
  const {sheet, asked} = sheetOf(forbid({tagsAny: ["rest"]}));
  await actions.rest.call(sheet, {}, {dataset: {recovery: "shortRest"}});
  await actions.rest.call(sheet, {}, {dataset: {recovery: "longRest"}});
  assert.deepEqual(asked, []);
  assert.equal(warned.length, 2);
  const free = sheetOf(forbid({tagsAny: ["rest:shortRest"]}));
  await actions.rest.call(free.sheet, {}, {dataset: {recovery: "longRest"}});
  assert.deepEqual(free.asked, ["rest:longRest"], "a Short Rest's Forbid leaves a Long Rest");
});
