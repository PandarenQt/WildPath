import {test} from "node:test";
import assert from "node:assert/strict";
import {enchantEffectFor, enchantmentsPastLimit} from "../module/adapters/foundry-v14-enchantments.mjs";
import {attunedCount, hostedRules, itemEffectSuppressed, unattunedOnArrival} from "../module/helpers/effect-sources.mjs";
import {actionDefinitionFromItem} from "../module/helpers/action-definitions.mjs";

test("an enchantment's effect by level, and how many of its creator's oldest end past its limit", () => {
  const effects = [{name: "+1", level: {max: 9, class: "artificer"}, ruleElements: []}, {name: "+2", level: {min: 10, class: "artificer"}, ruleElements: []}];
  assert.equal(enchantEffectFor(effects, 2)?.name, "+1");
  assert.equal(enchantEffectFor(effects, 10)?.name, "+2");
  assert.equal(enchantEffectFor([{name: "any", ruleElements: []}], 1)?.name, "any", "no range: always");
  assert.equal(enchantmentsPastLimit([{at: 1}, {at: 2}], 2), 1, "a third with a limit of 2 ends the oldest");
  assert.equal(enchantmentsPastLimit([{at: 1}], 2), 0);
});

test("an Item's effect binds {{host}} to that Item; an Actor's effect keeps its rules", () => {
  const rules = [{type: "Modifier", predicate: {tagsAny: ["weapon:{{host}}"]}}];
  const onItem = {parent: {documentName: "Item", id: "sword"}, system: {ruleElements: rules}};
  assert.deepEqual(hostedRules(onItem)[0].predicate.tagsAny, ["weapon:sword"]);
  assert.equal(hostedRules(onItem), hostedRules(onItem), "bound once");
  assert.equal(hostedRules({parent: {documentName: "Actor", id: "a"}, system: {ruleElements: rules}}), rules);
});

test("an enchantment's Item choice: its creature's own gear of the kinds it suits", () => {
  const items = [
    {id: "sword", type: "gear", name: "Longsword", system: {}},
    {id: "plate", type: "gear", name: "Plate", system: {armor: "heavy"}},
    {id: "board", type: "gear", name: "Shield", system: {armor: "shield"}},
    {id: "rope", type: "gear", name: "Rope", system: {}},
    {id: "slash", type: "action", name: "Longsword", flags: {wildpath: {grantedBy: "sword"}}, system: {definition: {attack: {weapon: {base: "longsword"}}}}},
    {id: "dagger", type: "action", name: "Dagger", system: {definition: {attack: {weapon: {base: "dagger"}}}}}
  ];
  const choice = kinds => ({schemaVersion: 1, id: "action:infuse", label: "Infuse", costs: {allOf: []}, targeting: {type: "self"},
    configuration: [{id: "item", type: "select-one", label: "Item", required: true, options: [], optionsFrom: {type: "gear", kinds}}]});
  const options = kinds => actionDefinitionFromItem({type: "action", actor: {items}, system: {definition: choice(kinds)}})
    .definition.configuration[0].options.map(option => option.value);
  assert.deepEqual(options(["weapon"]), ["sword", "dagger"], "gear granting an attack, and a weapon that is its attack");
  assert.deepEqual(options(["armor", "shield"]), ["plate", "board"]);
  assert.deepEqual(options([]), ["sword", "dagger", "plate", "board", "rope"], "any Item");
});

test("a nonmagical weapon only (optionsFrom.magical: false): no magic item's, bound or for a while magic weapon (Q45, Q109)", () => {
  const attack = (id, base, data={}) => ({id, type: "action", name: base, system: {definition: {attack: {weapon: {base}}, ...data}}});
  const bound = key => ({flags: {wildpath: {enchantment: {key}}}});
  const items = [
    {id: "sword", type: "gear", name: "Longsword", system: {}, effects: [bound("test-blessing")]},
    {id: "plus", type: "gear", name: "Longsword", system: {}, effects: [bound("weapon-1")]},
    {id: "club", type: "gear", name: "Club", system: {}},
    {...attack("slash", "longsword"), flags: {wildpath: {grantedBy: "sword"}}},
    {...attack("plus-slash", "longsword"), flags: {wildpath: {grantedBy: "plus"}}},
    {...attack("bonk", "club"), flags: {wildpath: {grantedBy: "club"}}},
    attack("dagger", "dagger"),
    attack("flame", "longsword", {tags: ["magical"]})
  ];
  // Magic Weapon on the Dagger: an effect on its creature that makes it a magic weapon. A disabled one on the Club does
  // not count, nor an effect only naming the Club in its rules (2024 Shillelagh).
  const magicWeapon = (id, disabled=false) => ({disabled, flags: {wildpath: {conditionEffect: {definition: {magicWeapon: id}}}},
    system: {ruleElements: [{type: "Modifier", data: {domains: ["attack"]}, predicate: {tagsAny: [`weapon:${id}`]}}]}});
  const effects = [magicWeapon("dagger"), magicWeapon("club", true),
    {system: {ruleElements: [{type: "Modifier", predicate: {tagsAll: ["weapon:club", "might"]}}]}}];
  const options = (optionsFrom, enchant) => actionDefinitionFromItem({type: "action", actor: {items, effects}, system: {definition: {schemaVersion: 1,
    id: "action:bless", label: "Bless", costs: {allOf: []}, targeting: {type: "self"}, ...(enchant ? {enchant} : {}),
    configuration: [{id: "item", type: "select-one", label: "Item", required: true, options: [], optionsFrom}]}}})
    .definition.configuration[0].options.map(option => option.value);
  const enchant = {choiceId: "item", key: "test-blessing", effects: [{name: "Blessing", ruleElements: []}]};
  assert.deepEqual(options({type: "gear", kinds: ["weapon"]}, enchant), ["sword", "plus", "club", "dagger", "flame"], "without the key, any");
  assert.deepEqual(options({type: "gear", kinds: ["weapon"], magical: false}, enchant), ["sword", "club"],
    "its own binding may be picked again; another's, a magic item's and Magic Weapon's may not");
  assert.deepEqual(options({type: "weapons", magical: false}), ["club"], "Magic Weapon's own choice: any binding counts");
});

test("an enchantment of several options applies the one chosen (Shield, +1, +2, or +3)", async () => {
  const {createFoundryEnchantments} = await import("../module/adapters/foundry-v14-enchantments.mjs");
  const created = [];
  const shield = {id: "shield", effects: [], createEmbeddedDocuments: async (type, data) => { created.push(...data); return data; }};
  const actor = {uuid: "Actor.a", system: {details: {level: 1}}, items: {get: id => (id === "shield" ? shield : null)}};
  const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, actors: [], scenes: []};
  const bonus = value => ({name: `Shield +${value}`, ruleElements: [{type: "Modifier", data: {domains: ["defense.ac"], value}}]});
  const state = {actionDefinition: {id: "action:shield", enchant: {choiceId: "item", optionChoiceId: "enchantment", key: "shield",
    effects: [bonus(1), bonus(2), bonus(3)]}}, configuration: {choices: [{id: "item", value: "shield"}, {id: "enchantment", value: "1"}]}};
  await createFoundryEnchantments({game}).afterResolution({options: {actor}, state});
  assert.deepEqual(created.map(effect => [effect.name, effect.system.ruleElements[0].data.value]), [["Shield +2", 2]]);
});

test("a spell's enchantment keeps the level it was cast at, so Dispel Magic can end it; one that is no spell keeps none", async () => {
  const {createFoundryEnchantments} = await import("../module/adapters/foundry-v14-enchantments.mjs");
  const enchant = async (tags, configuration) => {
    const created = [];
    const sword = {id: "sword", effects: [], createEmbeddedDocuments: async (type, data) => { created.push(...data); return data; }};
    const actor = {uuid: "Actor.a", system: {details: {level: 5}}, items: {get: id => (id === "sword" ? sword : null)}};
    const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, actors: [], scenes: []};
    const state = {actionDefinition: {id: "action:magic-weapon", tags, metadata: {spellLevel: 2}, enchant: {choiceId: "item", key: "magic-weapon",
      effects: [{name: "Magic Weapon", ruleElements: []}]}}, configuration: {choices: [{id: "item", value: "sword"}], ...configuration}};
    await createFoundryEnchantments({game}).afterResolution({options: {actor}, state});
    return created[0].flags.wildpath.enchantment.spellLevel;
  };
  assert.equal(await enchant(["spell"], {castingLevel: 4}), 4, "the slot it was cast with");
  assert.equal(await enchant(["spell"], {}), 2, "else the spell's own level");
  assert.equal(await enchant([], {}), undefined, "an infusion is no spell");
});

test("an enchantment that needs attunement is made unattuned, and gives nothing until attuned (Q43)", async () => {
  const {createFoundryEnchantments} = await import("../module/adapters/foundry-v14-enchantments.mjs");
  const bind = async attunement => {
    const created = [];
    const sword = {id: "sword", effects: [], createEmbeddedDocuments: async (type, data) => { created.push(...data); return data; }};
    const actor = {uuid: "Actor.a", system: {details: {level: 5}}, items: {get: id => (id === "sword" ? sword : null)}};
    const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, actors: [], scenes: []};
    const state = {actionDefinition: {id: "action:luck-blade", enchant: {choiceId: "item", key: "luck-blade", ...attunement,
      effects: [{name: "Luck Blade", ruleElements: []}]}}, configuration: {choices: [{id: "item", value: "sword"}]}};
    await createFoundryEnchantments({game}).afterResolution({options: {actor}, state});
    return created[0].flags.wildpath.enchantment;
  };
  assert.equal((await bind({attunement: true})).attunement, "required");
  assert.equal("attunement" in (await bind({})), false, "Weapon +1 needs none");
  // Its Item equipped, with no attunement of its own (a base Longsword): only the binding's attunement decides.
  const binding = (attunement, host={active: true}) => ({parent: {documentName: "Item", system: host},
    flags: {wildpath: {enchantment: {key: "luck-blade", ...(attunement ? {attunement} : {})}}}});
  assert.deepEqual([binding("required"), binding("attuned"), binding(null)].map(itemEffectSuppressed), [true, false, false]);
  assert.equal(itemEffectSuppressed(binding("attuned", {active: false})), true, "unequipped");
  assert.equal(itemEffectSuppressed(binding(null, {active: true, attunement: "required"})), true, "gear needing its own attunement");
});

test("a binding brought by gear that needs attunement counts only while that gear is attuned on its creature (Q43, Armor of Resistance)", async () => {
  const {createFoundryEnchantments} = await import("../module/adapters/foundry-v14-enchantments.mjs");
  const bind = async gearAttunement => {
    const created = [];
    const gear = {id: "resistance", system: {attunement: gearAttunement}};
    const plate = {id: "plate", effects: [], createEmbeddedDocuments: async (type, data) => { created.push(...data); return data; }};
    const actor = {uuid: "Actor.a", system: {details: {level: 5}}, items: {get: id => ({plate, resistance: gear})[id] ?? null}};
    const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, actors: [], scenes: []};
    const state = {actionDefinition: {id: "action:resistance", enchant: {choiceId: "item", key: "armor-of-resistance",
      effects: [{name: "Fire", ruleElements: []}]}}, configuration: {choices: [{id: "item", value: "plate"}]}};
    await createFoundryEnchantments({game}).afterResolution({options: {actor, action: {flags: {wildpath: {grantedBy: "resistance"}}}}, state});
    return created[0].flags.wildpath.enchantment;
  };
  assert.equal((await bind("attuned")).attunedWith, "resistance");
  assert.equal("attunedWith" in (await bind("")), false, "Armor +1's gear needs none");
  const onPlate = (gear) => ({parent: {documentName: "Item", system: {active: true}, actor: {items: {get: id => ((id === "resistance") ? gear : null)}}},
    flags: {wildpath: {enchantment: {key: "armor-of-resistance", attunedWith: "resistance"}}}});
  assert.equal(itemEffectSuppressed(onPlate({system: {attunement: "attuned"}})), false);
  assert.equal(itemEffectSuppressed(onPlate({system: {attunement: "required"}})), true, "the gear unattuned");
  assert.equal(itemEffectSuppressed(onPlate(null)), true, "the Plate handed to a creature without the gear");
});

test("attunement belongs to a creature: attuned Items and bindings count toward its limit and need attuning again when handed over (Q107)", () => {
  const effect = (id, attunement) => ({id, flags: {wildpath: {enchantment: {key: "luck-blade", attunement}}}});
  const sword = {system: {active: true}, effects: [effect("luck", "attuned"), effect("other", "required")]};
  const ring = {system: {attunement: "attuned"}, effects: []};
  const cloak = {system: {attunement: "required"}, effects: []};
  assert.equal(attunedCount([sword, ring, cloak]), 2);
  assert.deepEqual(unattunedOnArrival(sword), {system: null, effects: [{_id: "luck", "flags.wildpath.enchantment.attunement": "required"}]});
  assert.deepEqual(unattunedOnArrival(ring), {system: {"system.attunement": "required"}, effects: []});
  assert.deepEqual(unattunedOnArrival(cloak), {system: null, effects: []}, "nothing attuned: nothing changes");
});

test("a template's tier is its granting gear's rarity; a blank or unmatched rarity leaves the holder's pick (Q44, Q108)", () => {
  const tiers = {schemaVersion: 1, id: "action:wand", label: "Wand of the War Mage", costs: {allOf: []}, targeting: {type: "self"},
    configuration: [{id: "item", type: "select-one", label: "Item", required: true, options: [], optionsFrom: {type: "gear", kinds: []}},
      {id: "enchantment", type: "option", label: "Wand", required: true, options: ["uncommon", "rare", "veryRare"]
        .map((rarity, index) => ({id: String(index), label: `+${index + 1}`, value: String(index), rarity}))}],
    enchant: {choiceId: "item", optionChoiceId: "enchantment", key: "wand", effects: [1, 2, 3].map(value => ({name: `+${value}`, ruleElements: []}))}};
  const offered = (rarity, grantedBy="wand") => {
    const wand = {id: "wand", type: "gear", name: "Wand", system: {rarity}};
    const items = [wand];
    const action = {id: "template", type: "action", actor: {items}, flags: {wildpath: {grantedBy}}, system: {definition: tiers}};
    items.push(action);
    return actionDefinitionFromItem(action).definition.configuration.find(choice => choice.id === "enchantment").options.map(option => option.value);
  };
  assert.deepEqual(offered("rare"), ["1"], "the GM's Rare: +2 only, its index kept");
  assert.deepEqual(offered(""), ["0", "1", "2"], "no rarity set: the holder picks");
  assert.deepEqual(offered("legendary"), ["0", "1", "2"], "no tier of that rarity");
  assert.deepEqual(offered("rare", null), ["0", "1", "2"], "no gear brought it (Weapon +1, +2 or +3)");
});
