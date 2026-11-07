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
  assert.deepEqual(actionTags(strike), ["attack", "attack:melee", "id:action:strike"], "its attack's type too");
  assert.deepEqual(actionTags({id: "action:blink", tags: [], teleport: {distance: 30}}), ["teleport", "id:action:blink"],
    "teleport when it teleports (Dimensional Shackles)");
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

test("Shapechange: a form that keeps spellcasting forbids no spell, and its creature's concentration ending ends the form", async () => {
  const {sustainedEffects, endConcentrationOnIncapacitation} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const previous = {game: globalThis.game, setProperty: globalThis.foundry.utils.setProperty};
  globalThis.game = {i18n: {format: (key, data) => `${key}:${data.form}`}, scenes: []};
  globalThis.foundry.utils.setProperty = (object, path, value) => { object[path] = value; };
  try {
    const druid = creature({system: {resources: {health: {temp: 0}}}, isToken: true, token: null, deleted: [],
      async createEmbeddedDocuments(type, data) {
        const made = data.map((entry, index) => ({id: `${type}-${index}`, uuid: `Actor.caster.${type}.${index}`, disabled: false, ...entry}));
        if ( type === "ActiveEffect" ) this.effects.push(...made);
        return made;
      },
      async update(changes) { this.system.resources.health.temp = changes["system.resources.health.temp"]; },
      async deleteEmbeddedDocuments(type, ids) { this.deleted.push(...ids); }});
    const bear = {uuid: "Actor.bear", name: "Bear", img: "bear.webp", items: []};
    await druid.transform(bear, {temporaryHealth: 34, untilTemporaryHealthLost: false, concentrationRef: "token:caster-token",
      keepsSpellcasting: true, duration: {value: 1, units: "hours"}});
    const [form] = druid.effects;
    assert.deepEqual([form.flags.wildpath.transformation.keepsSpellcasting, form.flags.wildpath.transformation.temporaryHealthVanishes,
      form.flags.wildpath.transformation.untilTemporaryHealthLost, form.duration], [true, 34, undefined, {value: 1, units: "hours"}]);
    assert.equal(druid.system.resources.health.temp, 34);
    assert.equal(druid.forbiddingRule(spell("verbal")), null, "it keeps its spellcasting");
    form.flags.wildpath.transformation.keepsSpellcasting = false;
    assert.equal(druid.forbiddingRule(spell("verbal"))?.reason, "WILDPATH.REFUSAL.Transformed", "a form without it can't cast");

    const scene = {id: "scene-a", tokens: [{id: "caster-token", uuid: "Scene.scene-a.Token.caster-token", actorLink: true,
      actorId: "caster", actor: druid, parent: null}]};
    scene.tokens[0].parent = scene;
    const world = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, actors: [druid], scenes: [scene]};
    assert.deepEqual(sustainedEffects(druid, world).map(({effect}) => effect.id), [form.id], "the form is what it concentrates on");
    await endConcentrationOnIncapacitation({system: {type: "stunned"}, parent: druid}, world);
    assert.deepEqual(druid.deleted, [form.id], "Incapacitated: its concentration and the form end");
  } finally {
    globalThis.game = previous.game;
    globalThis.foundry.utils.setProperty = previous.setProperty;
  }
});

test("Shapechange's end clears only the Temporary Hit Points its form gave, not a larger pool from another source", async () => {
  const previous = {game: globalThis.game, setProperty: globalThis.foundry.utils.setProperty};
  globalThis.game = {i18n: {format: (key, data) => `${key}:${data.form}`}, scenes: []};
  globalThis.foundry.utils.setProperty = (object, path, value) => { object[path] = value; };
  const shapechanged = async temp => {
    const caster = creature({system: {resources: {health: {temp}}}, isToken: true, token: null,
      async createEmbeddedDocuments(type, data) {
        const made = data.map((entry, index) => ({id: `${type}-${index}`, ...entry}));
        if ( type === "ActiveEffect" ) this.effects.push(...made);
        return made;
      },
      async update(changes) { this.system.resources.health.temp = changes["system.resources.health.temp"]; }});
    await caster.transform({uuid: "Actor.wolf", name: "Wolf", items: []}, {temporaryHealth: 34, keepsSpellcasting: true});
    return caster;
  };
  try {
    const kept = await shapechanged(60);
    assert.equal(kept.effects[0].flags.wildpath.transformation.temporaryHealthVanishes, undefined, "the form gave none");
    await kept.deleteTransformationCopies(kept.effects[0].id, kept.effects[0]);
    assert.equal(kept.system.resources.health.temp, 60, "a larger pool from before the form stays");

    const given = await shapechanged(0);
    given.system.resources.health.temp = 10;
    await given.deleteTransformationCopies(given.effects[0].id, given.effects[0]);
    assert.equal(given.system.resources.health.temp, 0, "what is left of the form's vanishes");

    const gained = await shapechanged(0);
    gained.system.resources.health.temp = 50;
    await gained.deleteTransformationCopies(gained.effects[0].id, gained.effects[0]);
    assert.equal(gained.system.resources.health.temp, 50, "a larger pool gained in the form (False Life) stays");
  } finally {
    globalThis.game = previous.game;
    globalThis.foundry.utils.setProperty = previous.setProperty;
  }
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

test("Unaffected: a feature's rule leaves its creature untouched by the spells it names or a school's, while the feature is on", () => {
  const unaffected = actions => ({schemaVersion: 1, id: "unaffected", type: "Unaffected", data: {actions}});
  assert.equal(evaluateRuleElement(unaffected({tagsAll: ["school:divination"]})).ok, true);
  assert.equal(evaluateRuleElement(unaffected(null)).ok, false, "no predicate");
  const feature = (actions, active=true) => ({id: "f", type: "feature", name: "Immunity", system: {active, ruleElements: [unaffected(actions)]}});
  const named = creature({items: [feature({tagsAny: ["spell:spell-a", "spell:spell-b"]})]});
  assert.equal(named.unaffectingRule({id: "action:a", tags: ["spell", "spell:spell-a"]})?.name, "Immunity");
  assert.equal(named.unaffectingRule({id: "action:c", tags: ["spell", "spell:spell-c"]}), null, "a spell it does not name");
  assert.equal(named.forbiddingRule({id: "action:a", tags: ["spell", "spell:spell-a"]}), null, "it bars nothing of its own");
  const school = feature({tagsAll: ["school:divination"]});
  assert.ok(creature({items: [school]}).unaffectingRule({id: "action:d", tags: ["spell", "school:divination"]}));
  assert.equal(creature({items: [school]}).unaffectingRule({id: "action:e", tags: ["spell", "school:evocation"]}), null);
  assert.equal(creature({items: [{...school, system: {...school.system, active: false}}]})
    .unaffectingRule({id: "action:d", tags: ["spell", "school:divination"]}), null, "suppressed: the feature toggled off");
});
