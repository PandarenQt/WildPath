import assert from "node:assert/strict";
import test from "node:test";

import {refuseBrokenRules, refusePlayerMechanics} from "../module/helpers/rule-guard.mjs";

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

test("only a GM edits what a document does: its definition or RuleElements, nested or dotted; the rest is the player's", () => {
  const {messages, ui, game} = told();
  const player = {isGM: false};
  const refused = changes => refusePlayerMechanics({name: "Longsword"}, changes, player, {ui, game});
  assert.equal(refused({system: {definition: {label: "Vorpal"}}}), true);
  assert.equal(refused({"system.definition.damage": []}), true, "a dotted key");
  assert.equal(refused({system: {ruleElements: []}}), true);
  assert.equal(refused({"system.ruleElements": [ward]}), true);
  assert.match(messages[0], /WILDPATH\.RULES\.GmOnly.*Longsword/);
  assert.equal(refused({name: "My Sword", system: {description: "Shiny", active: true}}), false, "its name, text, being equipped");
  assert.equal(refused({"flags.wildpath.reactionPolicy": "always"}), false, "its reaction setting");
  assert.equal(refused({system: {definitionNotes: "x"}}), false, "a key that only starts the same");
  assert.equal(refusePlayerMechanics({name: "Longsword"}, {system: {definition: {}}}, {isGM: true}, {ui, game}), false, "the GM");
});
