import {test} from "node:test";
import assert from "node:assert/strict";

// Only the globals needed to import the real Actor class; no Foundry schema emulation.
globalThis.Actor = class {};
globalThis.foundry = {
  data: {fields: {}, ActiveEffectTypeDataModel: class {}},
  utils: {isEmpty: value => Object.keys(value).length === 0}
};
Math.clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const {default: WildPathActor} = await import("../module/documents/actor.mjs");
const {evaluateRuleElement, actionTags} = await import("../module/helpers/rule-elements.mjs");
const {WILDPATH} = await import("../module/config.mjs");

const creature = ({effects=[], items=[], statuses=[], system={}, ...rest}={}) => {
  const actor = Object.assign(Object.create(WildPathActor.prototype), {id: "caster", uuid: "Actor.caster", name: "Ana",
    effects, items, statuses: new Set(statuses), flags: {}, system, ...rest});
  actor.allApplicableEffects = () => effects;
  return actor;
};
const effect = (name, ruleElements) => ({name, disabled: false, isSuppressed: false, system: {ruleElements}});
const forbid = actions => ({schemaVersion: 1, id: "forbid", type: "Forbid", data: {actions}});
const spell = (...components) => ({id: "action:spell", tags: ["spell", ...components.map(component => `component:${component}`)]});
const strike = {id: "action:strike", tags: [], attack: {type: "melee"}};
const dash = {id: "common:dash", tags: []};

test("a Forbid needs a valid actions predicate, and an Action's tags include attack when it makes an attack roll", () => {
  assert.equal(evaluateRuleElement(forbid({tagsAny: ["spell"]})).ok, true);
  assert.equal(evaluateRuleElement(forbid(null)).ok, false, "no predicate");
  assert.equal(evaluateRuleElement(forbid({castsSpells: true})).ok, false, "an unknown predicate key");
  assert.deepEqual(actionTags(strike), ["attack"]);
  assert.deepEqual(actionTags(spell("verbal")), ["spell", "component:verbal"]);
});

test("Spell Taxed: an effect's Forbid bars its creature's spells, named after the effect; its other Actions go on", () => {
  const taxed = creature({effects: [effect("Spell Taxed", [forbid({tagsAny: ["spell"]})])]});
  assert.equal(taxed.forbiddingRule(spell("verbal"))?.name, "Spell Taxed");
  assert.equal(taxed.forbiddingRule(strike), null);
  assert.equal(creature().forbiddingRule(spell("verbal")), null, "nothing forbids a creature without the effect");
  const disabled = creature({effects: [{...effect("Spell Taxed", [forbid({tagsAny: ["spell"]})]), disabled: true}]});
  assert.equal(disabled.forbiddingRule(spell("verbal")), null, "a disabled effect forbids nothing");
});

test("Silenced forbids spells with a Verbal component only", () => {
  const silenced = creature({effects: [effect("Silenced", WILDPATH.CONDITIONS.silenced.ruleElements)]});
  assert.equal(silenced.forbiddingRule(spell("verbal", "somatic"))?.name, "Silenced", "named after the effect, not its rule's id label");
  assert.equal(silenced.forbiddingRule(spell("somatic", "material")), null);
  assert.equal(silenced.forbiddingRule(strike), null);
});

test("states forbid by rule: Gaseous Form attacks and spells, a transformation spells, untrained armor spells", () => {
  const gaseous = creature({statuses: ["gaseous"]});
  assert.equal(gaseous.forbiddingRule(strike)?.reason, "WILDPATH.REFUSAL.Gaseous");
  assert.ok(gaseous.forbiddingRule(spell("somatic")));
  assert.equal(gaseous.forbiddingRule(dash), null, "it can still Dash");

  const shaped = creature({effects: [{...effect("Wild Shape", []), flags: {wildpath: {transformation: {formRef: "Actor.bear"}}}}]});
  assert.equal(shaped.forbiddingRule(spell("verbal"))?.reason, "WILDPATH.REFUSAL.Transformed");
  assert.equal(shaped.forbiddingRule(strike), null);

  const plate = {id: "plate", name: "Plate Armor", type: "gear", system: {active: true, armor: "heavy", ruleElements: []}};
  const shield = {id: "shield", name: "Shield", type: "gear", system: {active: true, armor: "shield", ruleElements: []}};
  const untrained = creature({items: [plate], system: {training: {armor: ["light"]}}});
  assert.deepEqual([untrained.forbiddingRule(spell("verbal"))?.reason, untrained.forbiddingRule(spell("verbal"))?.name],
    ["WILDPATH.REFUSAL.ArmorCasting", "Plate Armor"], "named after the armor");
  assert.equal(creature({items: [plate], system: {training: {armor: ["heavy"]}}}).forbiddingRule(spell("verbal")), null, "trained");
  assert.equal(creature({items: [shield], system: {training: {armor: ["light"]}}}).forbiddingRule(spell("verbal")), null,
    "an untrained Shield doesn't stop casting");
});
