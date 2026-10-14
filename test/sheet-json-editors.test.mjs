import {test} from "node:test";
import assert from "node:assert/strict";

test("the sheets' RuleElement editors accept known types only, in a list", async t => {
  const previous = globalThis.foundry;
  globalThis.foundry = {applications: {api: {HandlebarsApplicationMixin: base => base}, sheets: {ItemSheetV2: class {}}}};
  t.after(() => { globalThis.foundry = previous; });
  const {ruleElementListErrors} = await import("../module/applications/item-sheet.mjs");
  assert.deepEqual(ruleElementListErrors([{schemaVersion: 1, id: "ward", type: "Modifier", data: {domains: ["defense.ac"], value: 1}}]), []);
  assert.deepEqual(ruleElementListErrors([{type: "Nope"}]), ["0: Unknown RuleElement type: Nope"]);
  assert.equal(ruleElementListErrors([{id: "no-type"}]).length, 1);
  assert.deepEqual(ruleElementListErrors({type: "Modifier"}), ["RuleElements must be a list."]);
});
