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

test("Sneak Attack: a Finesse or ranged weapon, with Advantage or an ally beside the target, deals extra damage of its own type", async () => {
  const {actionCombatStatistics} = await import("../module/helpers/combat-statistics.mjs");
  const sneak = {schemaVersion: 1, id: "sneak-attack", type: "ExtraDamage", predicate: {all: [
    {tagsAny: ["finesse", "ranged"]},
    {any: [{equals: {path: "attack.rollMode", value: "advantage"}}, {all: [{equals: {path: "attack.allyNearTarget", value: true}},
      {not: {equals: {path: "attack.rollMode", value: "disadvantage"}}}]}]}]},
    data: {domains: ["damage.weapon"], expression: {type: "dice", number: 2, faces: 6}, once: "turn"}};
  const actor = Object.assign(Object.create(WildPathActor.prototype), {id: "rogue", uuid: "Actor.rogue", effects: [], statuses: new Set(),
    flags: {}, system: {}, items: [{id: "sneak", uuid: "Actor.rogue.Item.sneak", type: "feature", system: {active: true, modifiers: [],
      ruleElements: [sneak]}}]});
  actor.allApplicableEffects = () => [];
  const rapier = {attack: {type: "melee", statistic: "weapon", properties: ["finesse"]},
    damage: [{id: "blade", expression: {type: "dice", number: 1, faces: 8}, damageType: "piercing", provenance: "weapon-base"}]};
  const extra = (definition, attack) => actionCombatStatistics(actor, definition, {context: {attack}}).damage?.extraComponents ?? [];
  assert.deepEqual(extra(rapier, {rollMode: "advantage"}).map(entry => [entry.damageType, entry.expression.number]), [["piercing", 2]],
    "the weapon's own damage type");
  assert.equal(extra(rapier, {rollMode: "normal", allyNearTarget: true}).length, 1, "an ally beside the target");
  assert.equal(extra(rapier, {rollMode: "disadvantage", allyNearTarget: true}).length, 0, "but not with Disadvantage");
  assert.equal(extra(rapier, {rollMode: "normal"}).length, 0, "neither");
  const club = {...rapier, attack: {type: "melee", statistic: "weapon"}};
  assert.equal(extra(club, {rollMode: "advantage"}).length, 0, "not a Finesse weapon");
  const bow = {...rapier, attack: {type: "ranged", statistic: "weapon"}};
  assert.equal(extra(bow, {rollMode: "advantage"}).length, 1, "a ranged weapon");
});

test("2024 Armor Class: a typed AC wins; else worn armor, else the best unarmored way; a Shield adds", () => {
  const armorClass = (id, value, armor=false) => ({id, uuid: `Actor.hero.Item.${id}`, type: "gear", system: {active: true, modifiers: [],
    ruleElements: [{schemaVersion: 1, id, type: "ArmorClass", data: {value, ...(armor ? {armor: true} : {})}}]}});
  const agility = {type: "ability-modifier", ability: "agility"};
  const hero = (items, typed=null, type="character") => Object.assign(Object.create(WildPathActor.prototype), {id: "hero", uuid: "Actor.hero",
    type, effects: [], items, system: {defenses: {ac: {value: typed}}, abilities: {agility: {value: 16}, fortitude: {value: 14}}},
    allApplicableEffects: () => []});
  assert.equal(resolveActorDefense(hero([]), "ac").value, 13, "unarmored: 10 + Agility modifier 3");
  assert.equal(resolveActorDefense(hero([], null, "npc"), "ac").value, 13, "any creature without a typed AC");
  const chain = armorClass("chain-mail", 16, true);
  const breastplate = armorClass("breastplate", {type: "add", terms: [{type: "constant", value: 14}, {type: "min", terms: [agility,
    {type: "constant", value: 2}]}]}, true);
  const unarmoredDefense = armorClass("unarmored-defense", {type: "add", terms: [{type: "constant", value: 10}, agility,
    {type: "ability-modifier", ability: "fortitude"}]});
  assert.equal(resolveActorDefense(hero([breastplate]), "ac").value, 16, "medium armor: 14 + Agility up to 2");
  assert.equal(resolveActorDefense(hero([unarmoredDefense]), "ac").value, 15, "Unarmored Defense: 10 + 3 + 2");
  assert.equal(resolveActorDefense(hero([unarmoredDefense, chain]), "ac").value, 16, "wearing armor, Unarmored Defense does not count");
  assert.equal(resolveActorDefense(hero([{...chain, system: {...chain.system, active: false}}]), "ac").value, 13, "unequipped");
  const shield = item("shield", "gear", [modifier("shield", ["defense.ac"], 2)]);
  assert.equal(resolveActorDefense(hero([chain, shield]), "ac").value, 18, "a Shield adds to armor");
  assert.equal(resolveActorDefense(hero([chain], 1), "ac").value, 1, "a typed AC wins, even below the armor's");
  assert.equal(resolveActorDefense(hero([chain, shield], 15, "npc"), "ac").value, 17, "a stat block's AC, and bonuses still add");
});

test("a magic item that needs attunement gives its rules only while attuned (2024)", () => {
  const {actor} = fighter();
  const cloak = {id: "cloak", uuid: "Actor.fighter.Item.cloak", type: "gear", system: {active: true, attunement: "required", modifiers: [],
    ruleElements: [{schemaVersion: 1, id: "cloak", type: "Modifier", data: {domains: ["defense.ac"], value: 1}}]}};
  actor.items.push(cloak);
  assert.equal(resolveActorDefense(actor, "ac").value, 14, "equipped, not attuned");
  cloak.system.attunement = "attuned";
  assert.equal(resolveActorDefense(actor, "ac").value, 15);
});

test("skill checks (G8): the skill's own ability, and the proficiency bonus once for proficiency and twice for expertise", async () => {
  const {resolveActorCheckStatistic} = await import("../module/helpers/combat-statistics.mjs");
  const rogue = proficiency => Object.assign(Object.create(WildPathActor.prototype), {id: "rogue", uuid: "Actor.rogue", type: "character",
    effects: [], items: [], allApplicableEffects: () => [], system: {details: {level: 5}, abilities: {agility: {value: 16}, wits: {value: 12}},
      skills: {stealth: {proficiency}}}});
  assert.equal(resolveActorCheckStatistic(rogue(0), {skill: "stealth"}).totalModifier, 3, "Stealth uses Agility (+3)");
  assert.equal(resolveActorCheckStatistic(rogue(1), {skill: "stealth"}).totalModifier, 6, "+3 proficiency at level 5");
  assert.equal(resolveActorCheckStatistic(rogue(2), {skill: "stealth"}).totalModifier, 9, "expertise: twice");
  assert.equal(resolveActorCheckStatistic(rogue(2), {ability: "wits", skill: "stealth"}).totalModifier, 7, "a check that names another ability");
});

test("Hit Dice (G8): one per class level, by each class's die size", async () => {
  const {deriveClassData} = await import("../module/helpers/spellcasting.mjs");
  assert.deepEqual(deriveClassData([{id: "fighter", level: 3, hitDie: 10}, {id: "wizard", level: 2, hitDie: 6},
    {id: "paladin", level: 1, hitDie: 10}, {id: "old", level: 4}]).hitDice, {"hit-die.d10": 4, "hit-die.d6": 2});
});

test("class records come from class and subclass Items (G8): levels, Hit Die, spellcasting, subclasses, the original class", async () => {
  const {classRecordsFromItems} = await import("../module/documents/actor.mjs");
  const item = (type, name, system) => ({type, name, system});
  const records = classRecordsFromItems([
    item("class", "Wizard", {identifier: "wizard", levels: 3, hitDie: 6, original: false, spellcasting: {progression: "full", ability: "intellect"}}),
    item("class", "Fighter", {identifier: "", levels: 2, hitDie: 10, original: true, spellcasting: {progression: "none", ability: ""}}),
    item("subclass", "Evoker", {identifier: "evoker", classIdentifier: "wizard"}),
    item("feature", "Second Wind", {})]);
  assert.deepEqual(records, [
    {id: "wizard", name: "Wizard", level: 3, hitDie: 6, original: false, subclasses: ["evoker"], spellcasting: {progression: "full", ability: "intellect"}},
    {id: "fighter", name: "Fighter", level: 2, hitDie: 10, original: true, subclasses: [], spellcasting: {progression: "none", ability: ""}}]);
  assert.equal(classRecordsFromItems([item("class", "Rogue", {levels: 1, hitDie: 8})])[0].original, true, "the first, when none is marked");
});

test("armor worn without training (2024): Disadvantage on Might and Agility tests, and a Shield gives no AC", async () => {
  const {untrainedArmor} = await import("../module/documents/actor.mjs");
  const gear = (id, armor, ruleElements) => ({id, uuid: `Actor.wizard.Item.${id}`, name: id, type: "gear",
    system: {active: true, armor, modifiers: [], ruleElements}});
  const shield = gear("shield", "shield", [{schemaVersion: 1, id: "shield", type: "Modifier", data: {domains: ["defense.ac"], value: 2}}]);
  const plate = gear("plate", "heavy", []);
  const wizard = (armor, items) => Object.assign(Object.create(WildPathActor.prototype), {id: "wizard", uuid: "Actor.wizard", effects: [],
    items, system: {defenses: {ac: {value: 12}}, training: {armor}}, allApplicableEffects: () => []});
  const modes = (actor, domains) => actor.getRollModes(domains).map(entry => entry.mode);

  const untrained = wizard(["light"], [shield, plate]);
  assert.deepEqual(untrainedArmor(untrained).map(item => item.id), ["shield", "plate"]);
  assert.equal(resolveActorDefense(untrained, "ac").value, 12, "the untrained Shield gives nothing");
  assert.deepEqual(modes(untrained, ["save", "save.agility"]), ["disadvantage"]);
  assert.deepEqual(modes(untrained, ["check", "check.might"]), ["disadvantage"]);
  assert.deepEqual(modes(untrained, ["attack", "attack.melee", "attack.might"]), ["disadvantage"]);
  assert.deepEqual(modes(untrained, ["save", "save.wits"]), [], "only Might and Agility");

  const trained = wizard(["light", "heavy", "shield"], [shield, plate]);
  assert.equal(resolveActorDefense(trained, "ac").value, 14);
  assert.deepEqual(modes(trained, ["save.agility"]), []);
  assert.deepEqual(untrainedArmor(wizard([], [shield, plate])), [], "no armor training at all: a stat block wears what it wears");
  assert.deepEqual(modes(wizard(["light"], [shield]), ["save.agility"]), [], "an untrained Shield alone only loses its AC");
});

test("Hunter's Mark: the target's mark adds its caster's extra damage on that caster's attacks only", async () => {
  const {actionCombatStatistics} = await import("../module/helpers/combat-statistics.mjs");
  const mark = {schemaVersion: 1, id: "hunters-mark-damage", type: "ExtraDamage",
    data: {domains: ["attacked"], expression: {type: "dice", number: 1, faces: 6}, damageType: "force"},
    predicate: {equals: {path: "attack.fromAttacker.hunters-mark", value: true}}};
  const creature = (id, rules=[]) => Object.assign(Object.create(WildPathActor.prototype), {id, uuid: `Actor.${id}`, effects: [],
    statuses: new Set(), flags: {}, system: {}, items: [{id: "marked", uuid: `Actor.${id}.Item.marked`, type: "feature",
      system: {active: true, modifiers: [], ruleElements: rules}}], allApplicableEffects: () => []});
  const ranger = creature("ranger");
  const wolf = creature("wolf", [mark]);
  const bow = {attack: {type: "ranged", statistic: "weapon"},
    damage: [{id: "arrow", expression: {type: "dice", number: 1, faces: 8}, damageType: "piercing", provenance: "weapon-base"}]};
  const extra = (target, fromAttacker) => actionCombatStatistics(ranger, bow, {target, context: {attack: {type: "ranged", fromAttacker}}})
    .damage?.extraComponents ?? [];
  assert.deepEqual(extra(wolf, {"hunters-mark": true}).map(entry => [entry.damageType, entry.expression.faces]), [["force", 6]],
    "the caster's own mark");
  assert.equal(extra(wolf, {}).length, 0, "someone else's attack: the mark is not theirs");
  assert.equal(extra(null, {"hunters-mark": true}).length, 0, "no single target named");
  const fireBolt = {damage: [{id: "fire", expression: {type: "dice", number: 1, faces: 10}, damageType: "fire"}],
    save: {ability: "agility"}};
  assert.equal(actionCombatStatistics(ranger, fireBolt, {target: wolf, context: {attack: {fromAttacker: {"hunters-mark": true}}}})
    .damage?.extraComponents?.length ?? 0, 0, "only an attack roll");
});

test("a weapon's attack names its weapon and ability among its tags, so a rule can reach that weapon alone", async () => {
  const {actionCombatStatistics} = await import("../module/helpers/combat-statistics.mjs");
  const seen = [];
  const actor = {system: {abilities: {might: {value: 16}, agility: {value: 12}}, proficiencyBonus: 2},
    getStatistic: (domains, {tags=[]}={}) => { seen.push(tags); return {totalModifier: 0}; }};
  const definition = {attack: {type: "melee", statistic: "weapon", weapon: {base: "longsword"}},
    damage: [{id: "d", expression: {type: "dice", number: 1, faces: 8}, damageType: "slashing", provenance: "weapon-base"}]};
  actionCombatStatistics(actor, definition, {item: {id: "sword-attack", flags: {wildpath: {grantedBy: "sword"}}}});
  assert.ok(seen.every(tags => tags.includes("weapon:sword")), JSON.stringify(seen));
  assert.ok(seen[0].includes("might"), "the attack roll's tags carry its ability");
});

test("Colossus Slayer and Frenzy (SRD): extra weapon damage when the target is missing Hit Points, or while raging and Reckless", async () => {
  const fs = await import("node:fs");
  const {actionCombatStatistics} = await import("../module/helpers/combat-statistics.mjs");
  const rules = file => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${file}.json`, "utf8")).system.ruleElements;
  const actorWith = (file, statuses=[]) => {
    const actor = Object.assign(Object.create(WildPathActor.prototype), {id: "hero", uuid: "Actor.hero", effects: [], statuses: new Set(statuses),
      flags: {}, system: {classes: [{id: "barbarian", level: 9}]}, items: [{id: "f", uuid: "Actor.hero.Item.f", type: "feature",
        system: {active: true, modifiers: [], ruleElements: rules(file)}}]});
    actor.allApplicableEffects = () => [];
    return actor;
  };
  const axe = {attack: {type: "melee", statistic: "weapon", ability: "might"},
    damage: [{id: "blade", expression: {type: "dice", number: 1, faces: 12}, damageType: "slashing", provenance: "weapon-base"}]};
  const extra = (actor, attack) => actionCombatStatistics(actor, axe, {context: {attack}}).damage?.extraComponents ?? [];
  const slayer = actorWith("hunter-s-prey-phbrgrHuntersPre");
  assert.deepEqual(extra(slayer, {targetDamaged: true}).map(entry => [entry.damageType, entry.expression.faces]), [["slashing", 8]]);
  assert.equal(extra(slayer, {targetDamaged: false}).length, 0, "an unhurt target");
  assert.equal(extra(actorWith("frenzy-phbbrbFrenzy0000", ["raging", "reckless"]), {}).length, 1);
  assert.equal(extra(actorWith("frenzy-phbbrbFrenzy0000", ["raging"]), {}).length, 0, "not Reckless");
});

test("spell riders (SRD): Potent Spellcasting on a cantrip, Empowered Evocation, Elemental Affinity's type, Disciple of Life's 2 + level", async () => {
  const fs = await import("node:fs");
  const {actionCombatStatistics} = await import("../module/helpers/combat-statistics.mjs");
  const pack = prefix => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${fs.readdirSync("packs/_source/srd-items")
    .find(file => file.startsWith(prefix))}`, "utf8"));
  const caster = rules => {
    const actor = Object.assign(Object.create(WildPathActor.prototype), {id: "caster", uuid: "Actor.caster", effects: [], statuses: new Set(),
      flags: {}, system: {abilities: {wits: {value: 16}, intellect: {value: 18}, presence: {value: 14}}},
      items: [{id: "f", uuid: "Actor.caster.Item.f", type: "feature", system: {active: true, modifiers: [], ruleElements: rules}}]});
    actor.allApplicableEffects = () => [];
    return actor;
  };
  const fireBolt = pack("fire-bolt-").system.definition;
  const fireball = pack("fireball-").system.definition;
  assert.deepEqual(fireBolt.tags, ["spell", "cantrip", "school:evocation", "damage:fire"]);
  const potent = caster(pack("blessed-strikes-potent-spellcasting").system.ruleElements);
  assert.equal(actionCombatStatistics(potent, fireBolt).damage?.modifierTotal, 3, "Wisdom 16 on a cantrip");
  assert.equal(actionCombatStatistics(potent, fireball).damage, null, "not on Fireball");
  assert.equal(actionCombatStatistics(caster(pack("empowered-evocation").system.ruleElements), fireball).damage?.modifierTotal, 4);
  const fire = pack("elemental-affinity-choose").system.definition.effects.find(effect => effect.id === "fire").ruleElements;
  assert.equal(actionCombatStatistics(caster(fire), fireball).damage?.modifierTotal, 2, "Charisma 14 on fire");
  assert.equal(actionCombatStatistics(caster(fire), pack("lightning-bolt-").system.definition).damage, null);
  const life = caster(pack("disciple-of-life").system.ruleElements);
  const cure = pack("cure-wounds-").system.definition;
  assert.deepEqual(actionCombatStatistics(life, cure, {context: {castLevel: 2}}).healing, {modifierTotal: 4}, "2 + level 2");
  assert.equal(actionCombatStatistics(life, cure, {context: {castLevel: null}}).healing, undefined, "no slot: nothing");
});

test("cantrip invocations (SRD, house rule): Agonizing Blast adds Charisma to every cantrip; Repelling Blast answers a cantrip's hit", async () => {
  const fs = await import("node:fs");
  const {actionCombatStatistics} = await import("../module/helpers/combat-statistics.mjs");
  const pack = prefix => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${fs.readdirSync("packs/_source/srd-items")
    .find(file => file.startsWith(prefix))}`, "utf8"));
  const actor = Object.assign(Object.create(WildPathActor.prototype), {id: "warlock", uuid: "Actor.warlock", effects: [], statuses: new Set(),
    flags: {}, system: {abilities: {presence: {value: 16}}}, items: [{id: "f", uuid: "Actor.warlock.Item.f", type: "feature",
      system: {active: true, modifiers: [], ruleElements: pack("agonizing-blast-").system.ruleElements}}]});
  actor.allApplicableEffects = () => [];
  assert.equal(actionCombatStatistics(actor, pack("eldritch-blast-").system.definition).damage?.modifierTotal, 3);
  assert.equal(actionCombatStatistics(actor, pack("fire-bolt-").system.definition).damage?.modifierTotal, 3, "every cantrip (house rule)");
  assert.equal(actionCombatStatistics(actor, pack("fireball-").system.definition).damage, null, "not a leveled spell");
  const repelling = pack("repelling-blast-").system;
  const match = repelling.ruleElements.find(rule => rule.type === "Trigger").data.match;
  assert.deepEqual([match.tagsAll, match.notTagsAny, repelling.definition.rider], [["cantrip"], undefined, {push: {distance: 10}}]);
});
