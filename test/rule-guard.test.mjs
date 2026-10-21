import assert from "node:assert/strict";
import test from "node:test";

import {refuseBrokenRules} from "../module/helpers/rule-guard.mjs";

const ward = {schemaVersion: 1, id: "ward", type: "Modifier", data: {domains: ["defense.ac"], value: 1}};
const broken = {schemaVersion: 1, id: "nope", type: "Nope"};
const documentWith = ruleElements => ({name: "Cloak", toObject: () => ({system: {ruleElements}})});
const told = () => {
  const messages = [];
  return {messages, ui: {notifications: {warn: text => messages.push(text)}}, game: {i18n: {format: (key, data) => `${key} ${JSON.stringify(data)}`}}};
};

test("an edit adding a broken rule is refused, with the problem in words", () => {
  const {messages, ui, game} = told();
  assert.equal(refuseBrokenRules(documentWith([ward]), [ward, broken], {ui, game}), true);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /WILDPATH\.RULES\.Refused/);
  assert.match(messages[0], /Cloak/);
});

test("an edit that adds no problem passes, even on a list already broken", () => {
  const {messages, ui, game} = told();
  assert.equal(refuseBrokenRules(documentWith([ward]), undefined, {ui, game}), false, "the rules are not part of the edit");
  assert.equal(refuseBrokenRules(documentWith([ward]), [ward], {ui, game}), false);
  assert.equal(refuseBrokenRules(documentWith([broken]), [broken, ward], {ui, game}), false, "its old problem is not new");
  assert.equal(refuseBrokenRules(documentWith([broken]), [], {ui, game}), false, "removing the broken rule");
  assert.deepEqual(messages, []);
});
