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
  assert.deepEqual(actionTags(strike), ["attack", "id:action:strike"]);
  assert.deepEqual(actionTags(spell("verbal")), ["spell", "component:verbal", "id:action:spell"]);
  assert.deepEqual(actionTags({id: "common:dash", tags: [], costs: {allOf: [{capability: "action", amount: 1}]}}),
    ["id:common:dash", "cost:action"], "its id, and what it always costs");
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

  // Command's Flee: an Action or Bonus Action only to Dash or Disengage; what costs neither is free.
  const fleeing = creature({statuses: ["commanded-flee"]});
  const costing = (id, capability) => ({id, tags: [], costs: {allOf: capability ? [{capability, amount: 1}] : []}});
  assert.equal(fleeing.forbiddingRule(costing("action:strike", "action"))?.reason, "WILDPATH.REFUSAL.Flee");
  assert.equal(fleeing.forbiddingRule(costing("action:shove", "bonus-action"))?.reason, "WILDPATH.REFUSAL.Flee");
  assert.equal(fleeing.forbiddingRule(costing("common:dash", "action")), null);
  assert.equal(fleeing.forbiddingRule(costing("common:disengage", "bonus-action")), null);
  assert.equal(fleeing.forbiddingRule(costing("action:shield", "reaction")), null, "a Reaction is not its turn");

  const plate = {id: "plate", name: "Plate Armor", type: "gear", system: {active: true, armor: "heavy", ruleElements: []}};
  const shield = {id: "shield", name: "Shield", type: "gear", system: {active: true, armor: "shield", ruleElements: []}};
  const untrained = creature({items: [plate], system: {training: {armor: ["light"]}}});
  assert.deepEqual([untrained.forbiddingRule(spell("verbal"))?.reason, untrained.forbiddingRule(spell("verbal"))?.name],
    ["WILDPATH.REFUSAL.ArmorCasting", "Plate Armor"], "named after the armor");
  assert.equal(creature({items: [plate], system: {training: {armor: ["heavy"]}}}).forbiddingRule(spell("verbal")), null, "trained");
  assert.equal(creature({items: [shield], system: {training: {armor: ["light"]}}}).forbiddingRule(spell("verbal")), null,
    "an untrained Shield doesn't stop casting");
});

test("a Quickened spell this combat turn forbids spells of level 1+, not cantrips, until the next turn", () => {
  const previous = globalThis.game;
  globalThis.game = {combat: {started: true, id: "c", round: 1, turn: 0}};
  try {
    const leveled = {id: "action:fireball", tags: ["spell"], metadata: {spellLevel: 3}};
    const cantrip = {id: "action:fire-bolt", tags: ["spell"], metadata: {spellLevel: 0}};
    assert.deepEqual(actionTags(leveled), ["spell", "spell:leveled", "id:action:fireball"]);
    const quickened = creature({flags: {wildpath: {quickenedTurn: "c:1:0"}}});
    assert.equal(quickened.forbiddingRule(leveled)?.reason, "WILDPATH.REFUSAL.Quickened");
    assert.equal(quickened.forbiddingRule(cantrip), null);
    assert.equal(creature({flags: {wildpath: {quickenedTurn: "c:0:3"}}}).forbiddingRule(leveled), null, "an earlier turn's");
  } finally { globalThis.game = previous; }
});
