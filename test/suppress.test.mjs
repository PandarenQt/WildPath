import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Only the globals needed to import the real Actor and ActiveEffect classes; no Foundry schema emulation.
globalThis.Actor = class {};
globalThis.ActiveEffect = class { get isSuppressed() { return false; } };
globalThis.foundry = {
  data: {fields: {}, ActiveEffectTypeDataModel: class {}},
  utils: {isEmpty: value => Object.keys(value).length === 0}
};
Math.clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const {default: WildPathActor, invalidateRules} = await import("../module/documents/actor.mjs");
const {default: WildPathActiveEffect} = await import("../module/documents/active-effect.mjs");
const {effectAddedDice, sourceSuppressed, sourceTags} = await import("../module/helpers/effect-sources.mjs");
const {zeroHpFor} = await import("../module/adapters/foundry-v14-zero-hp.mjs");
const {automationTriggers, repeatSaveGroups} = await import("../module/adapters/foundry-v14-automation-dispatcher.mjs");
const {slotRecallFor} = await import("../module/helpers/combat-statistics.mjs");
const {planStagedActionResolution} = await import("../module/resolvers/action-pipeline-resolver.mjs");

/** An Antimagic Field's rule: spells and magic items count for nothing. */
const FIELD = Object.freeze({schemaVersion: 1, id: "antimagic.suppress", type: "Suppress", data: {actions: {tagsAny: ["spell", "magical"]}}});
const modifier = (id, domains, value) => ({schemaVersion: 1, id, type: "Modifier", data: {domains, modifierType: "untyped", value}});

const effectDoc = (data={}) => Object.assign(Object.create(WildPathActiveEffect.prototype),
  {documentName: "ActiveEffect", id: data.name ?? "effect", disabled: false, type: "base", statuses: new Set(), flags: {}, system: {ruleElements: []}, ...data});
const tagged = (name, metadata, ruleElements=[]) => effectDoc({name, flags: {wildpath: {conditionEffect: {metadata}}}, system: {ruleElements}});
const antimagic = () => effectDoc({name: "Antimagic", flags: {wildpath: {conditionEffect: {metadata: {endsWhen: "leavesArea", tags: ["spell:antimagic-field"]}}}},
  system: {ruleElements: [FIELD]}});

/** A creature with these effects and Items, each effect's parent set (an Item's own effects too, as Foundry applies them). */
function creature({effects=[], items=[]}={}) {
  const actor = Object.assign(Object.create(WildPathActor.prototype), {id: "mage", uuid: "Actor.mage", name: "Mage",
    effects, items, statuses: new Set(), flags: {}, system: {}});
  for ( const effect of effects ) effect.parent = actor;
  for ( const item of items ) item.actor = actor;
  actor.allApplicableEffects = () => [...effects, ...items.flatMap(item => item.effects ?? [])];
  return actor;
}

const gear = (id, system={}, extra={}) => ({id, name: id, type: "gear", effects: [], flags: {},
  system: {active: true, attunement: "", rarity: "", armor: "", ruleElements: [], ...system}, ...extra});

test("source tags: a rated gear is magical, worn armor is not; a granted Item takes its gear's; an effect its Action's, spell level or binding's", () => {
  const ring = gear("ring", {rarity: "rare"});
  const feature = {id: "evasion", type: "feature", system: {active: true}, flags: {wildpath: {grantedBy: "ring"}}};
  const actor = {items: [ring, feature]};
  const plate = JSON.parse(fs.readFileSync("packs/_source/srd-items/dwarven-plate-dmgDwarvenPlate0.json", "utf8"));
  assert.deepEqual(sourceTags(gear("cloak", {rarity: "uncommon"}), actor), ["magical"]);
  assert.deepEqual(sourceTags(gear("rope"), actor), [], "mundane gear has no rarity");
  assert.deepEqual(sourceTags(plate, actor), [], "worn magic armor keeps its rules (the shortcut)");
  // The shortcut is for armor with an ArmorClass and Shields, not gear the converter gave an armor kind (a helm).
  const helm = JSON.parse(fs.readFileSync("packs/_source/srd-items/helm-of-brilliance-dmgHelmOfBrillia.json", "utf8"));
  assert.deepEqual(sourceTags(helm, actor), ["magical"], "Helm of Brilliance is no armor");
  assert.deepEqual(sourceTags(gear("sentinel", {rarity: "uncommon", armor: "shield"}), actor), [], "a magic Shield keeps its rules");
  const reaction = {id: "reduce", type: "action", system: {definition: {tags: []}}, flags: {wildpath: {grantedBy: plate._id}}};
  assert.deepEqual(sourceTags(reaction, {items: [{...plate, id: plate._id}, reaction]}), ["magical"], "magic armor's granted reaction is not its AC");
  assert.deepEqual(sourceTags(feature, actor), ["magical"], "Ring of Evasion's feature takes its ring's tags");
  assert.deepEqual(sourceTags({type: "action", system: {definition: {tags: ["magical"]}}}, actor), ["magical"], "an Action its own tags");
  assert.deepEqual(sourceTags({type: "feature", system: {active: true}, flags: {}}, actor), [], "a class feature none");

  assert.deepEqual(sourceTags(tagged("Hold", {tags: ["spell", "school:enchantment"]})), ["spell", "school:enchantment"]);
  assert.deepEqual(sourceTags(tagged("Old", {spellLevel: 2})), ["spell"], "an effect committed before the stamp, by its spell level");
  assert.deepEqual(sourceTags(tagged("Cantrip", {spellLevel: 0})), ["spell"]);
  assert.deepEqual(sourceTags(tagged("Shove", {spellLevel: null})), []);
  const sword = gear("sword");
  assert.deepEqual(sourceTags(effectDoc({flags: {wildpath: {enchantment: {key: "weapon-1"}}}, parent: {...sword, documentName: "Item"}}), actor),
    ["magical"], "a Weapon +1 binding on a mundane sword");
  assert.deepEqual(sourceTags(effectDoc({flags: {wildpath: {enchantment: {key: "magic-weapon", spellLevel: 2}}}, parent: {...sword, documentName: "Item"}}),
    actor), ["spell"], "Magic Weapon's binding");
  assert.deepEqual(sourceTags(effectDoc({flags: {wildpath: {enchantment: {key: "whetstone", tags: ["class:artificer"]}}}, parent: {...sword, documentName: "Item"}}),
    actor), ["class:artificer"], "a binding's stored tags: a homebrew feature's enchant is no magic item");
  assert.deepEqual(sourceTags(effectDoc({parent: {...gear("cloak", {rarity: "uncommon"}), documentName: "Item"}}), actor), ["magical"],
    "an effect on a magic item takes its Item's tags");
  assert.deepEqual(sourceTags(effectDoc({flags: {wildpath: {concentrationMarker: true, conditionEffect: {concentration: {sourceRef: "token:t"}}}}})), [],
    "a concentration marker has none, so concentration goes on");
});

test("Suppress: a creature's spell effects, old spell effects and magic bindings are suppressed; mundane effects, its marker and the field itself are not", () => {
  const spell = tagged("Hold Person", {tags: ["spell", "school:enchantment"]});
  const old = tagged("Bless", {spellLevel: 1});
  const mundane = tagged("Grappled", {tags: ["id:common:grapple"]});
  const marker = effectDoc({name: "Concentrating", flags: {wildpath: {concentrationMarker: true}}});
  const sword = gear("sword");
  const binding = effectDoc({name: "Weapon +1", flags: {wildpath: {enchantment: {key: "weapon-1"}}}});
  sword.effects = [binding];
  sword.documentName = "Item";
  binding.parent = sword;
  const field = antimagic();
  const inside = creature({effects: [field, spell, old, mundane, marker], items: [sword]});
  assert.deepEqual([spell, old, binding, mundane, marker, field].map(effect => effect.isSuppressed), [true, true, true, false, false, false]);
  const outside = creature({effects: [spell, old, mundane, marker], items: [sword]});
  assert.deepEqual([spell, old, binding, mundane].map(effect => effect.isSuppressed), [false, false, false, false], "outside, nothing is");
  assert.ok(inside.suppressingRules().length && !outside.suppressingRules().length);
  // Two fields never silence each other: a document carrying a Suppress is exempt.
  const other = antimagic();
  creature({effects: [field, other]});
  assert.deepEqual([field.isSuppressed, other.isSuppressed], [false, false]);
});

test("Suppress: a magic item's rules drop out of statistics and grants, a mundane Shield's and worn magic armor's stay, and an Item carrying one keeps its own", () => {
  const cloak = gear("cloak", {rarity: "uncommon", ruleElements: [modifier("cloak-ac", ["defense.ac"], 1), modifier("cloak-save", ["save"], 1)]});
  const shield = gear("shield", {armor: "shield", ruleElements: [modifier("shield-ac", ["defense.ac"], 2)]});
  const plate = JSON.parse(fs.readFileSync("packs/_source/srd-items/dwarven-plate-dmgDwarvenPlate0.json", "utf8"));
  Object.assign(plate, {id: plate._id, effects: []});
  plate.system.active = true;
  const items = () => [cloak, shield, plate];
  const ac = actor => actor.getStatistic("defense.ac").totalModifier;
  const plateAC = actor => actor.getArmorClasses().find(entry => entry.label === "Dwarven Plate")?.value;
  const outside = creature({items: items()});
  assert.deepEqual([ac(outside), outside.getStatistic("save").totalModifier, plateAC(outside)], [3, 1, 20]);
  const inside = creature({effects: [antimagic()], items: items()});
  assert.deepEqual([ac(inside), inside.getStatistic("save").totalModifier, plateAC(inside)], [2, 0, 20],
    "the Cloak's +1 AC and save go; the Shield's AC and Dwarven Plate's stay");

  // A homebrew Null Ring turns off its wearer's other magic items, not itself.
  const nullRing = gear("null-ring", {rarity: "rare", ruleElements: [{...FIELD, data: {actions: {tagsAny: ["magical"]}}}, modifier("null-save", ["save"], 2)]});
  const wearing = creature({items: [cloak, nullRing]});
  assert.equal(wearing.getStatistic("save").totalModifier, 2, "the Cloak's +1 goes; the ring's own +2 stays");

  // Its charges are kept state: a suppressed Item's pool is still granted (else it shows 0 and a rest refills it to 0).
  const charges = {schemaVersion: 1, id: "wand-charges", type: "GrantResource", data: {resourceId: "wand", label: "Wand", maximum: 7, recovery: "longRest"}};
  const wand = gear("wand", {rarity: "uncommon", ruleElements: [charges, modifier("wand-save", ["save"], 1)]});
  const field = creature({effects: [antimagic()], items: [wand]});
  assert.deepEqual([field.getGrantedResources().map(grant => [grant.id, grant.recovery]), field.getStatistic("save").totalModifier],
    [[["wand", "longRest"]], 0], "its pool stays, its other rules go");
});

test("Suppress: a magic weapon Action's own Modifiers and rules drop while it still attacks", () => {
  const rule = {schemaVersion: 1, id: "thrower-mode", type: "RollMode", data: {domains: ["attack"], mode: "advantage"}};
  const thrower = {id: "thrower", name: "Dwarven Thrower", type: "action", flags: {}, effects: [],
    system: {active: true, definition: {tags: ["magical"]}, ruleElements: [modifier("magic-attack", ["attack"], 3), rule]}};
  const outside = creature({items: [thrower]});
  assert.deepEqual([outside.getStatistic("attack", {item: thrower}).totalModifier, outside.getRollModes(["attack"], {item: thrower}).length], [3, 1]);
  const inside = creature({effects: [antimagic()], items: [thrower]});
  assert.deepEqual([inside.getStatistic("attack", {item: thrower}).totalModifier, inside.getRollModes(["attack"], {item: thrower}).length], [0, 0]);
  // Its own extra damage too (Mace of Smiting's).
  thrower.system.ruleElements.push({schemaVersion: 1, id: "smite", type: "ExtraDamage", data: {domains: ["damage"], expression: {type: "dice", count: 2, faces: 6}, damageType: "bludgeoning"}});
  assert.equal(creature({items: [thrower]}).getExtraDamage(["damage"], {item: thrower}).length, 1);
  assert.equal(creature({effects: [antimagic()], items: [thrower]}).getExtraDamage(["damage"], {item: thrower}).length, 0);
  assert.equal(inside.forbiddingRule({id: "action:thrower", tags: ["magical"], attack: {type: "ranged", statistic: "weapon"}}), null,
    "a Suppress forbids nothing: barring Actions is a Forbid's");
});

test("Suppress: its creature's rules are found by one pre-scan per rules tick, and a creature without one scans once and gets none", () => {
  const spell = tagged("Hold Person", {tags: ["spell"]});
  const actor = creature({effects: [spell]});
  let scans = 0;
  const effects = actor.allApplicableEffects;
  actor.allApplicableEffects = () => { scans++; return effects(); };
  invalidateRules();
  assert.deepEqual([spell.isSuppressed, spell.isSuppressed, sourceSuppressed(spell), actor.suppressingRules()], [false, false, false, []]);
  assert.equal(scans, 1);
  invalidateRules();
  actor.effects.push(antimagic());
  assert.equal(spell.isSuppressed, true, "read again once rules may have changed");
  assert.equal(scans, 2);
});

test("Suppress: Death Ward does not save a creature inside, a Bless die is not added, and a suppressed effect's or item's Trigger does not fire", () => {
  const suppressions = [{id: "antimagic.suppress", actions: {tagsAny: ["spell", "magical"]}}];
  const ward = tagged("Death Ward", {tags: ["spell"]}, [{type: "Trigger", data: {kind: "zero-hp", event: "health.zero", zeroHp: {mode: "set", hitPoints: 1}}}]);
  ward.uuid = "Actor.x.ActiveEffect.ward";
  const endurance = {id: "endurance", name: "Relentless Endurance", type: "feature", system: {active: true, ruleElements: [{type: "Trigger",
    data: {event: "health.zero", zeroHp: {mode: "set", hitPoints: 1}}}]}};
  assert.equal(zeroHpFor({items: [], effects: [ward]}, {pools: []})?.name, "Death Ward");
  assert.equal(zeroHpFor({items: [], effects: [ward], suppressingRules: () => suppressions}, {pools: []}), null, "inside the field");
  assert.equal(zeroHpFor({items: [endurance], effects: [ward], suppressingRules: () => suppressions}, {pools: []})?.name, "Relentless Endurance",
    "a species feature still works");

  const bless = tagged("Bless", {tags: ["spell"], addDie: {faces: 4}});
  bless.flags.wildpath.conditionEffect.conditionId = "bless";
  assert.deepEqual(effectAddedDice(bless, {items: []}), {number: 1, faces: 4});
  assert.equal(effectAddedDice(bless, {items: [], suppressingRules: () => suppressions}), null);

  const trigger = {schemaVersion: 1, id: "heal", type: "Trigger", data: {event: "turn.started", action: {schemaVersion: 1, id: "action:heal", label: "Heal"}}};
  const aura = tagged("Aura of Vitality", {tags: ["spell"]}, [trigger]);
  const amulet = gear("amulet", {rarity: "rare", ruleElements: [{...trigger, id: "amulet"}]});
  const event = {type: "turn.started"};
  const owner = suppressingRules => ({id: "mage", items: [amulet], effects: [aura], system: {}, ...(suppressingRules ? {suppressingRules} : {})});
  assert.equal(automationTriggers(owner(null), event).length, 2);
  assert.equal(automationTriggers(owner(() => suppressions), event).length, 0, "neither the spell's effect nor the magic item's");

  // Hold Person's end-of-turn save is not rolled while the spell is suppressed.
  const held = tagged("Hold Person", {tags: ["spell"], repeatSave: {timing: "turnEnd", ability: "presence", dc: 13}});
  held.parent = {suppressingRules: () => []};
  assert.equal(repeatSaveGroups([held], "turn.ended").length, 1);
  held.parent = {suppressingRules: () => suppressions};
  assert.equal(repeatSaveGroups([held], "turn.ended").length, 0);
});

test("Suppress: a feature's rule flag granted by a magic item is suppressed with it (Boon of Spell Recall's slotRecall as a ring's)", () => {
  const ring = gear("ring", {rarity: "rare"});
  const recall = {id: "recall", type: "feature", system: {active: true}, flags: {wildpath: {grantedBy: "ring", slotRecall: {dice: "1d4", maxLevel: 4}}}};
  const suppressions = [{id: "antimagic.suppress", actions: {tagsAny: ["magical"]}}];
  assert.deepEqual(slotRecallFor({items: [ring, recall]}), {dice: "1d4", maxLevel: 4});
  assert.equal(slotRecallFor({items: [ring, recall], suppressingRules: () => suppressions}), null);
});

test("withSourceTags: a committed effect carries its Action's tags beside its own, so a Suppress finds it and a curse is still a curse", () => {
  const definition = {schemaVersion: 1, id: "action:hex", label: "Bestow", tags: ["spell", "school:necromancy"], costs: {allOf: []},
    metadata: {spellLevel: 3}, targeting: {type: "single", required: true, count: 1},
    effects: [{id: "curse", type: "condition", conditionId: "prone", metadata: {tags: ["curse"]}}, {id: "mark", type: "effect", name: "Marked", slug: "marked"}]};
  const plan = tags => planStagedActionResolution({id: `resolution:tags-${tags.length}`, actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
    action: {id: "hex", type: "action", name: "Bestow", system: {definition: {...definition, tags}}}, source: {actorId: "caster"},
    targets: [{id: "orc", actorId: "actor-orc", tokenId: "token-orc", disposition: "enemy"}]}).state.mutationPlans
    .filter(entry => entry.type === "conditionEffect").map(entry => entry.metadata.tags);
  assert.deepEqual(plan(definition.tags), [["curse", "spell", "school:necromancy"], ["spell", "school:necromancy"]]);
  assert.deepEqual(plan([]), [["curse"], undefined], "an Action without tags stamps nothing");

  // Greater Restoration lowering Exhaustion stamps neither tags nor its level: the levels left are not the spell's.
  const restore = {schemaVersion: 1, id: "action:restore", label: "Restore", tags: ["spell"], costs: {allOf: []}, metadata: {spellLevel: 5},
    targeting: {type: "single", required: true, count: 1},
    effects: [{id: "less", type: "condition", conditionId: "exhaustion", levels: -1}, {id: "mark", type: "effect", name: "Marked", slug: "marked"}]};
  const metadata = planStagedActionResolution({id: "resolution:restore", actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
    action: {id: "restore", type: "action", name: "Restore", system: {definition: restore}}, source: {actorId: "caster"},
    targets: [{id: "orc", actorId: "actor-orc", tokenId: "token-orc", disposition: "enemy"}]}).state.mutationPlans
    .filter(entry => entry.type === "conditionEffect").map(entry => [entry.conditionId, entry.metadata ?? {}]);
  assert.deepEqual(metadata.map(([id, data]) => [id, data.tags, data.spellLevel]), [["exhaustion", undefined, undefined], ["marked", ["spell"], 5]]);
});

test("an enchantment binding stores its Action's and its granting gear's tags, so a feature's enchant is no magic item", async () => {
  const {createFoundryEnchantments} = await import("../module/adapters/foundry-v14-enchantments.mjs");
  const bind = async (tags, action) => {
    const created = [];
    const sword = {id: "sword", effects: [], createEmbeddedDocuments: async (type, data) => { created.push(...data); return data; }};
    const items = [sword, gear("wand", {rarity: "rare"})];
    items.get = id => items.find(item => item.id === id) ?? null;
    const actor = {uuid: "Actor.a", system: {details: {level: 5}}, items};
    const state = {actionDefinition: {id: "action:edge", tags, enchant: {choiceId: "item", key: "edge", effects: [{name: "Edge", ruleElements: []}]}},
      configuration: {choices: [{id: "item", value: "sword"}]}};
    await createFoundryEnchantments({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, actors: [], scenes: []}})
      .afterResolution({options: {actor, action}, state});
    return created[0].flags.wildpath.enchantment.tags;
  };
  assert.deepEqual(await bind(["class:artificer"], {type: "action", flags: {}}), ["class:artificer"]);
  assert.deepEqual(await bind([], {type: "action", flags: {wildpath: {grantedBy: "wand"}}}), ["magical"], "an untagged Action a magic item grants");
});
