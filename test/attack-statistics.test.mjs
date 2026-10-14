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
const {resolveActorAttackStatistic, resolveActorDefense} = await import("../module/helpers/combat-statistics.mjs");

const modifier = (id, domains, value, extra={}) => ({id, label: id, domains, type: "untyped", value, enabled: true, ...extra});
const item = (id, type, modifiers) => ({id, uuid: `Actor.fighter.Item.${id}`, type, system: {active: true, modifiers}});

function fighter() {
  const proficiency = item("proficiency", "feature", [modifier("proficiency", ["attack"], 2)]);
  const archery = item("archery", "feature", [modifier("archery", ["attack.ranged"], 2)]);
  const keenEye = item("keen-eye", "feature", [modifier("keen-eye", ["attack"], 1, {predicate: {tagsAny: ["ranged"]}})]);
  const both = item("battle-focus", "feature", [modifier("battle-focus", ["attack", "attack.melee"], 1)]);
  const sword = item("sword", "action", [modifier("sword-plus-two", ["attack.weapon"], 2)]);
  const bow = item("bow", "action", []);
  const actor = Object.assign(Object.create(WildPathActor.prototype), {
    id: "fighter", uuid: "Actor.fighter", effects: [],
    items: [proficiency, archery, keenEye, both, sword, bow],
    system: {defenses: {ac: {value: 14}}}
  });
  actor.allApplicableEffects = () => [];
  return {actor, sword, bow};
}

test("every matching attack domain stacks, and each modifier applies only where its source and predicate allow", () => {
  const {actor, sword, bow} = fighter();
  const melee = resolveActorAttackStatistic(actor, {type: "melee", statistic: "weapon"}, {item: sword});
  // proficiency 2 (attack) + battle focus 1 (attack + attack.melee, counted once) + the sword's own +2.
  assert.equal(melee.totalModifier, 5);
  const ranged = resolveActorAttackStatistic(actor, {type: "ranged", statistic: "weapon"}, {item: bow});
  // proficiency 2 + archery 2 (attack.ranged) + keen eye 1 (predicate: ranged) + battle focus 1; never the sword's +2.
  assert.equal(ranged.totalModifier, 6);
  const applied = ranged.source.statistic.applied.map(entry => entry.id).sort();
  assert.deepEqual(applied, ["archery", "battle-focus", "keen-eye", "proficiency"]);
});

test("an Action's own modifiers count only for that Action, never Actor-wide", () => {
  const {actor, sword} = fighter();
  assert.equal(actor.getStatistic("attack.weapon").totalModifier, 0, "a sheet-level read excludes the sword's bonus");
  assert.equal(actor.getStatistic("attack.weapon", {item: sword}).totalModifier, 2);
});

test("defenses stack their domains too", () => {
  const {actor} = fighter();
  actor.items.push(item("shield", "gear", [modifier("shield", ["defense.ac"], 2)]),
    item("ring", "gear", [modifier("ring", ["ac"], 1)]));
  assert.equal(resolveActorDefense(actor, "ac").value, 17, "14 + defense.ac 2 + ac 1");
});

test("a RuleElement's own predicate sees the attack's tags and the creature's conditions", () => {
  const rule = (id, domains, value, predicate) => ({schemaVersion: 1, id, type: "Modifier", data: {domains, value}, predicate});
  const feat = {id: "feat", uuid: "Actor.barbarian.Item.feat", type: "feature", system: {active: true, modifiers: [], ruleElements: [
    rule("sharpshooter", ["attack"], 1, {tagsAny: ["ranged"]}),
    rule("rage", ["attack"], 2, {hasCondition: "raging"})
  ]}};
  const actor = Object.assign(Object.create(WildPathActor.prototype), {id: "barbarian", uuid: "Actor.barbarian", effects: [],
    items: [feat], statuses: new Set(), system: {}});
  actor.allApplicableEffects = () => [];
  const melee = () => resolveActorAttackStatistic(actor, {type: "melee", statistic: "weapon"}).totalModifier;
  assert.equal(melee(), 0, "not ranged, not raging");
  assert.equal(resolveActorAttackStatistic(actor, {type: "ranged", statistic: "weapon"}).totalModifier, 1, "the ranged tag reaches the rule");
  actor.statuses.add("raging");
  assert.equal(melee(), 2, "the raging condition reaches the rule");
});

test("damage adds the weapon's ability modifier and the creature's damage bonuses, each where it applies", async () => {
  const {actionCombatStatistics} = await import("../module/helpers/combat-statistics.mjs");
  const rule = (id, domains, value, predicate=null) => ({schemaVersion: 1, id, type: "Modifier", data: {domains, value}, predicate});
  const feat = {id: "rage", uuid: "Actor.barbarian.Item.rage", type: "feature", system: {active: true, modifiers: [], ruleElements: [
    rule("rage-damage", ["damage.melee"], 2, {hasCondition: "raging"}),
    rule("spell-power", ["damage.spell"], 1)
  ]}};
  const actor = Object.assign(Object.create(WildPathActor.prototype), {id: "barbarian", uuid: "Actor.barbarian", effects: [],
    items: [feat], statuses: new Set(), system: {abilities: {might: {value: 16}}}});
  actor.allApplicableEffects = () => [];
  const weapon = (type, provenance="weapon-base") => ({attack: {type, statistic: "weapon"},
    damage: [{id: "hit", expression: {type: "dice", number: 1, faces: 8}, provenance}]});
  assert.deepEqual(actionCombatStatistics(actor, weapon("melee")).damage, {modifierTotal: 3}, "Might only");
  actor.statuses.add("raging");
  assert.deepEqual(actionCombatStatistics(actor, weapon("melee")).damage, {modifierTotal: 5}, "Might and Rage");
  assert.equal(actionCombatStatistics(actor, weapon("ranged")).damage, null,
    "Rage is melee only, and a ranged weapon uses Agility (+0 here)");
  const firebolt = {tags: ["spell"], attack: {type: "ranged", statistic: "spell"},
    damage: [{id: "fire", expression: {type: "dice", number: 1, faces: 10}, provenance: "spell-base"}]};
  assert.deepEqual(actionCombatStatistics(actor, firebolt).damage, {modifierTotal: 1}, "a spell bonus, but no ability modifier");
  assert.equal(actionCombatStatistics(actor, {attack: {type: "melee", statistic: "weapon"}}).damage, null, "no damage, no modifier");
});

test("extra damage rules join a matching attack's damage, and a once-per-turn rule drops out once used this turn", async () => {
  const {actionCombatStatistics} = await import("../module/helpers/combat-statistics.mjs");
  const {validateRuleElementDefinition, evaluateRuleElement} = await import("../module/helpers/rule-elements.mjs");
  const sneak = {schemaVersion: 1, id: "sneak", type: "ExtraDamage",
    data: {domains: ["damage.melee"], expression: {type: "dice", number: 1, faces: 6}, damageType: "fire", once: "turn"}};
  assert.equal(validateRuleElementDefinition(sneak).ok, true);
  assert.equal(evaluateRuleElement({...sneak, data: {...sneak.data, domains: []}}).ok, false, "domains are required");
  assert.equal(evaluateRuleElement({...sneak, data: {...sneak.data, once: "round"}}).ok, false, "once is per turn only");
  const feature = {id: "flame-strike", uuid: "Actor.rogue.Item.flame-strike", type: "feature",
    system: {active: true, modifiers: [], ruleElements: [sneak]}};
  const actor = Object.assign(Object.create(WildPathActor.prototype), {id: "rogue", uuid: "Actor.rogue", effects: [],
    items: [feature], statuses: new Set(), flags: {}, system: {}});
  actor.allApplicableEffects = () => [];
  const melee = {attack: {type: "melee", statistic: "weapon"}, damage: [{id: "blade", expression: {type: "dice", number: 1, faces: 4},
    provenance: "weapon-base"}]};
  const extra = actionCombatStatistics(actor, melee, {turn: "c:1:0"}).damage.extraComponents;
  assert.deepEqual(extra.map(entry => [entry.damageType, entry.expression.faces, entry.once?.turn]), [["fire", 6, "c:1:0"]]);
  assert.equal(actionCombatStatistics(actor, {...melee, attack: {type: "ranged", statistic: "weapon"}}, {turn: "c:1:0"}).damage, null,
    "a ranged attack is not a melee hit");
  actor.flags = {wildpath: {onceUsed: {[extra[0].once.key]: "c:1:0"}}};
  assert.equal(actionCombatStatistics(actor, melee, {turn: "c:1:0"}).damage, null, "used this turn");
  assert.equal(actionCombatStatistics(actor, melee, {turn: "c:1:1"}).damage.extraComponents.length, 1, "the next turn it is back");
  assert.equal(actionCombatStatistics(actor, melee, {turn: null}).damage.extraComponents[0].once, undefined, "no limit outside combat");
});
