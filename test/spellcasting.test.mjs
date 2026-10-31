import {test} from "node:test";
import assert from "node:assert/strict";
import {casterLevel, deriveClassData, effectiveSpellcasting, hitDiceHealing, pactMagic, preparedSpellLimit, spellSlots} from "../module/helpers/spellcasting.mjs";

test("spent Hit Dice heal each roll plus Fortitude, at least 1 a die (2024) or 0 (2014)", () => {
  assert.equal(hitDiceHealing([7, 2], 2), 13);
  assert.equal(hitDiceHealing([1, 4], -3), 2, "1 + 1");
  assert.equal(hitDiceHealing([1, 4], -3, {minimum: 0}), 1, "0 + 1");
});
import {evaluateValueExpression} from "../module/helpers/value-expressions.mjs";

const wizard = level => ({id: "wizard", level, spellcasting: {progression: "full", ability: "int"}});
const paladin = level => ({id: "paladin", level, spellcasting: {progression: "half", ability: "cha"}});
const fighter = level => ({id: "fighter", level, original: true, spellcasting: {progression: "none", ability: ""}});

test("2024 caster level: full levels plus half of each half-caster class, rounded up per class", () => {
  assert.equal(casterLevel([wizard(3), paladin(3)]), 5);
  assert.equal(casterLevel([paladin(1)]), 1, "a level-1 half-caster already casts (2024)");
  assert.equal(casterLevel([paladin(3), {...paladin(3), id: "ranger"}]), 4, "rounded up per class, not on the sum");
  assert.equal(casterLevel([fighter(5)]), 0);
});

test("spell slots follow the 2024 table, nine levels long", () => {
  assert.deepEqual(spellSlots(1), [2, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(spellSlots(5), [4, 3, 2, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(spellSlots(20), [4, 3, 3, 3, 3, 2, 2, 1, 1]);
  assert.deepEqual(spellSlots(0), Array(9).fill(0));
});

test("class records give the total level, the original class and the Actor's spellcasting ability", () => {
  const derived = deriveClassData([fighter(2), wizard(3)]);
  assert.equal(derived.level, 5);
  assert.equal(derived.original.id, "fighter");
  assert.equal(derived.spellcasting.ability, "int", "the original class does not cast, so the first caster's ability");
  assert.equal(derived.spellcasting.casterLevel, 3);
  assert.equal(deriveClassData([]).original, null);
});

test("a spellcasting modifier can name its class, so each class of a multiclass caster uses its own ability", () => {
  const actorSystem = {abilities: {int: {value: 16}, cha: {value: 12}}, classes: [wizard(3), paladin(3)],
    spellcasting: {ability: "int"}};
  assert.equal(evaluateValueExpression({type: "spellcasting-modifier", class: "paladin"}, {actorSystem}).value, 1);
  assert.equal(evaluateValueExpression({type: "spellcasting-modifier"}, {actorSystem}).value, 3);
});

test("prepared spells (2024): leveled spells a feature did not give, and the classes' limit", async () => {
  const {isUnprepared, preparedSpellLimit, preparesSpell} = await import("../module/helpers/spellcasting.mjs");
  const spell = (configuration, extra={}) => ({type: "action", system: {prepared: true, definition: {tags: ["spell"], configuration}}, ...extra});
  const fireball = spell([{id: "spell-slot"}]);
  assert.equal(preparesSpell(fireball), true);
  assert.equal(preparesSpell(spell([])), false, "a cantrip is always ready");
  assert.equal(preparesSpell(spell([{id: "spell-slot"}], {flags: {wildpath: {grantedBy: "subclass"}}})), false, "a subclass's spell is always prepared");
  assert.equal(preparesSpell({type: "action", system: {definition: {tags: [], configuration: [{id: "spell-slot"}]}}}), false);
  assert.equal(isUnprepared({...fireball, system: {...fireball.system, prepared: false}}), true);
  assert.equal(isUnprepared(fireball), false);
  const wizard = {system: {levels: 3, spellcasting: {prepared: [4, 5, 6, 7]}}};
  const paladin = {system: {levels: 2, spellcasting: {prepared: [2, 3]}}};
  assert.equal(preparedSpellLimit([wizard, paladin]), 9);
  assert.equal(preparedSpellLimit([{system: {levels: 5, spellcasting: {prepared: []}}}]), null, "a Fighter prepares none");
});

const warlock = level => ({id: "warlock", level, spellcasting: {progression: "pact", ability: "presence"}});

test("Pact Magic (2024): its slots and their level follow the Warlock levels, apart from multiclass slots", () => {
  assert.deepEqual([1, 2, 3, 11, 17, 20].map(level => pactMagic([warlock(level)])),
    [{slots: 1, level: 1}, {slots: 2, level: 1}, {slots: 2, level: 2}, {slots: 3, level: 5}, {slots: 4, level: 5}, {slots: 4, level: 5}]);
  assert.deepEqual(pactMagic([wizard(5)]), {slots: 0, level: 0});
  const derived = deriveClassData([warlock(5), wizard(3)]);
  assert.equal(derived.spellcasting.casterLevel, 3, "the Warlock's levels add no multiclass slots");
  assert.deepEqual(derived.spellcasting.pact, {slots: 2, level: 3});
});

test("Mystic Arcanum: only the spell marked as its level's arcanum may spend that arcanum, and it isn't prepared", async () => {
  const fs = await import("node:fs");
  const {actionDefinitionFromItem} = await import("../module/helpers/action-definitions.mjs");
  const {preparesSpell, spellBaseLevel} = await import("../module/helpers/spellcasting.mjs");
  const disintegrate = JSON.parse(fs.readFileSync("packs/_source/srd-items/disintegrate-phbsplDisintegra.json", "utf8"));
  assert.equal(spellBaseLevel(disintegrate.system.definition), 6);
  assert.equal(spellBaseLevel({configuration: [{id: "spell-slot", levelByResourceId: {"spell-slot": {6: 6, 7: 7}}}]}), 6, "Foundry's nested keys");
  // Its warlock's Mystic Arcanum feature marks it (`spellChoice`: flag `arcanum`, the pool `mystic-arcanum.{level}`).
  const feature = JSON.parse(fs.readFileSync("packs/_source/srd-items/mystic-arcanum-phbwlkMysticArca.json", "utf8"));
  const actor = (pools, items=[feature]) => ({items, system: {pools}});
  const spell = (arcanum, pools, items) => ({...disintegrate, flags: {wildpath: {arcanum}}, actor: actor(pools, items)});
  const options = item => actionDefinitionFromItem(item).definition.configuration.find(choice => choice.id === "spell-slot").cost.anyOf
    .map(branch => branch[0].capability);
  const arcanumPool = [{id: "mystic-arcanum.6", value: 1, max: 1}];
  assert.equal(options(spell(true, arcanumPool)).includes("mystic-arcanum.6"), true, "marked, with the arcanum");
  assert.equal(options(spell(false, arcanumPool)).includes("mystic-arcanum.6"), false, "not marked");
  assert.equal(options(spell(true, [])).includes("mystic-arcanum.6"), false, "no arcanum of that level");
  assert.equal(options(spell(true, arcanumPool, [])).includes("mystic-arcanum.6"), false, "no Mystic Arcanum feature");
  assert.deepEqual([preparesSpell(spell(true, arcanumPool)), preparesSpell(spell(false, arcanumPool))], [false, true]);
});

test("Spell Mastery casts a marked level 1 or 2 Action spell free at its level; Signature Spells casts a marked level 3 one from its pool", async () => {
  const fs = await import("node:fs");
  const {actionDefinitionFromItem} = await import("../module/helpers/action-definitions.mjs");
  const {discoverActionConfigurationChoices, resolveActionConfiguration} = await import("../module/helpers/action-configuration.mjs");
  const {preparesSpell} = await import("../module/helpers/spellcasting.mjs");
  const read = prefix => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${fs.readdirSync("packs/_source/srd-items")
    .find(file => file.startsWith(prefix))}`, "utf8"));
  const [mastery, signatures] = [read("spell-mastery-phbwzd"), read("signature-spells-phbwzd")];
  const [missile, misty, fireball] = [read("magic-missile-phb"), read("misty-step-phb"), read("fireball-phb")];
  const pools = [{id: "spell-slot.1", value: 0, max: 4}, {id: "signature-spell.1", value: 1, max: 1}];
  const owner = (features=[mastery, signatures]) => ({items: features, system: {pools}});
  const slot = (spell, flags, actor=owner()) => actionDefinitionFromItem({...spell, flags: {wildpath: flags}, actor}).definition
    .configuration.find(choice => choice.id === "spell-slot");
  const free = choice => choice.cost.anyOf.some(branch => !branch.length);
  assert.deepEqual([free(slot(missile, {mastered: true})), free(slot(missile, {})), free(slot(missile, {mastered: true}, owner([]))),
    free(slot(misty, {mastered: true}))], [true, false, false, false], "marked, with the feature, cast with an Action (not Misty Step's Bonus Action)");
  // With no slot left, the free cast is at the spell's own level.
  const definition = actionDefinitionFromItem({...missile, flags: {wildpath: {mastered: true}}, actor: owner()}).definition;
  const actorSystem = {resources: {action: {value: 1, max: 1}}, pools};
  const [option] = discoverActionConfigurationChoices({definition, actorSystem}).requests.find(request => request.id === "spell-slot").options;
  const resolved = resolveActionConfiguration({definition, actorSystem, choices: {"spell-slot": {paymentOptionId: option.paymentOptionId}}});
  assert.equal(resolved.ok, true, JSON.stringify(resolved.errors));
  assert.deepEqual([resolved.configuration.castingLevel, option.resources.length], [1, 0], "level 1, no slot");
  const signature = slot(fireball, {signature: 1});
  assert.deepEqual([signature.cost.anyOf.some(branch => branch[0]?.capability === "signature-spell.1"), signature.levelByResourceId["signature-spell.1"]],
    [true, 3]);
  assert.equal(slot(fireball, {signature: 2}).cost.anyOf.some(branch => branch[0]?.capability === "signature-spell.2"), false, "no such pool");
  assert.equal(slot(fireball, {signature: 1}, owner([mastery])).cost.anyOf.some(branch => branch[0]?.capability === "signature-spell.1"), false,
    "no Signature Spells feature");
  // Always prepared while its feature marks it (the mark counts only while that feature is there).
  const prepares = (spell, flags, actor=owner()) => preparesSpell({...spell, flags: {wildpath: flags}, actor});
  assert.deepEqual([prepares(missile, {mastered: true}), prepares(fireball, {signature: 1}), prepares(missile, {}),
    prepares(missile, {mastered: true}, owner([]))], [false, false, true, true], "always prepared");
  assert.deepEqual([signatures.system.ruleElements.map(rule => [rule.data.resourceId, rule.data.recovery]), signatures.flags.wildpath.conversion.notes,
    mastery.flags.wildpath.conversion.notes], [[["signature-spell.1", "shortRest"], ["signature-spell.2", "shortRest"]], [], []]);
});

test("a spell choice is data (flags.wildpath.spellChoice): a homebrew feature's marks, its pools by {n}, the sheet's toggle", async () => {
  const fs = await import("node:fs");
  const {actionDefinitionFromItem} = await import("../module/helpers/action-definitions.mjs");
  const {spellChoiceOf, spellChoiceToggle, preparesSpell} = await import("../module/helpers/spellcasting.mjs");
  const read = prefix => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${fs.readdirSync("packs/_source/srd-items")
    .find(file => file.startsWith(prefix))}`, "utf8"));
  const [misty, fireball] = [read("misty-step-phb"), read("fireball-phb")];
  // Homebrew "Arcane Reserve": three level 2 spells, each from its own pool.
  const reserve = {id: "reserve", name: "Arcane Reserve", type: "feature", system: {active: true},
    flags: {wildpath: {spellChoice: {flag: "reserve", levels: [2], count: 3, resourceId: "reserve.{n}"}}}};
  const pools = [1, 2, 3].map(n => ({id: `reserve.${n}`, value: 1, max: 1}));
  const actor = {items: [reserve], system: {pools}};
  const branches = (spell, mark) => actionDefinitionFromItem({...spell, flags: {wildpath: {reserve: mark}}, actor}).definition.configuration
    .find(choice => choice.id === "spell-slot");
  const marked = branches(misty, 2);
  assert.deepEqual([marked.cost.anyOf.some(branch => branch[0]?.capability === "reserve.2"), marked.levelByResourceId["reserve.2"]], [true, 2]);
  assert.equal(JSON.stringify(branches(misty, 4).cost).includes("reserve."), false, "4 is no mark of a count of 3");
  assert.equal(JSON.stringify(branches(fireball, 2).cost).includes("reserve."), false, "a level 3 spell does not fit");
  assert.equal(preparesSpell({...misty, flags: {wildpath: {reserve: 1}}, actor}), false, "marked: always prepared");
  // The sheet's toggle: the lowest free number; every number taken is full; a marked spell is unmarked.
  const choice = spellChoiceOf(reserve);
  const spell = (id, mark) => ({id, flags: {wildpath: {reserve: mark}}, system: {definition: misty.system.definition}});
  const [a, b, c, d] = [spell("a", 1), spell("b", 3), spell("c", null), spell("d", null)];
  assert.deepEqual(spellChoiceToggle(choice, c, [a, b, c, d]), {updates: [{_id: "c", "flags.wildpath.reserve": 2}]});
  c.flags.wildpath.reserve = 2;
  assert.deepEqual(spellChoiceToggle(choice, d, [a, b, c, d]), {full: true});
  assert.deepEqual(spellChoiceToggle(choice, a, [a, b, c, d]), {updates: [{_id: "a", "flags.wildpath.reserve": null}]});
  // Count 1 (Spell Mastery's shape): marking one clears the other of its level.
  const one = {...choice, count: 1, flag: "mastered"};
  const [e, f] = [{id: "e", flags: {wildpath: {mastered: true}}, system: {definition: misty.system.definition}},
    {id: "f", flags: {wildpath: {}}, system: {definition: misty.system.definition}}];
  assert.deepEqual(spellChoiceToggle(one, f, [e, f]), {updates: [{_id: "f", "flags.wildpath.mastered": true}, {_id: "e", "flags.wildpath.mastered": null}]});
  // A flag the system itself uses, or a malformed choice, fails explicitly.
  const bad = spellChoice => () => spellChoiceOf({name: "Bad", flags: {wildpath: {spellChoice}}});
  assert.throws(bad({flag: "grantedBy", levels: [1]}), /grantedBy/u);
  assert.throws(bad({flag: "mark", levels: []}), /levels/u);
  assert.throws(bad({flag: "mark", levels: [1], count: 0}), /count/u);
  // A flag the engine reads on any active Item would make the marked spell that feature (a spell rolling damage twice).
  for ( const flag of ["damageTwice", "ignoresResistance", "slotRecall", "choiceFor", "summonSource"] ) assert.throws(bad({flag, levels: [1]}), /system uses it/u);
});

test("a malformed spell choice is skipped where spells are read, named by its problem, and refused when written", async () => {
  const {spellChoiceProblem, spellChoices, preparesSpell} = await import("../module/helpers/spellcasting.mjs");
  const {refuseBrokenSpellChoice} = await import("../module/helpers/rule-guard.mjs");
  const typo = {id: "typo", name: "Homebrew Reserve", system: {active: true}, flags: {wildpath: {spellChoice: {flag: "reserve", level: [2]}}}};
  const good = {id: "good", name: "Arcanum", system: {active: true}, flags: {wildpath: {spellChoice: {flag: "arcanum", levels: [6]}}}};
  const spell = {type: "action", flags: {wildpath: {}}, system: {definition: {tags: ["spell"], configuration: [{id: "spell-slot"}]}},
    actor: {items: [typo, good]}};
  assert.deepEqual(spellChoices(spell.actor).map(choice => choice.id), ["good"], "the readable one still counts");
  assert.equal(preparesSpell(spell), true, "its creature's spells are still read");
  assert.match(spellChoiceProblem(typo), /Homebrew Reserve.*levels/u);
  assert.equal(spellChoiceProblem(good), null);
  const messages = [];
  const ui = {notifications: {warn: text => messages.push(text)}};
  const game = {i18n: {format: (key, data) => `${key} ${JSON.stringify(data)}`}};
  assert.equal(refuseBrokenSpellChoice(good, {levels: []}, {ui, game}), true, "a partial edit leaving no levels");
  assert.match(messages[0], /WILDPATH\.RULES\.Refused.*Arcanum/u);
  assert.equal(refuseBrokenSpellChoice(good, {flag: "damageTwice"}, {ui, game}), true, "a reserved flag");
  assert.equal(refuseBrokenSpellChoice(typo, {levels: [2]}, {ui, game}), false, "an edit fixing it");
  assert.equal(refuseBrokenSpellChoice(good, null, {ui, game}), false, "clearing it");
  assert.equal(refuseBrokenSpellChoice(good, undefined, {ui, game}), false, "not part of the edit");
  assert.equal(messages.length, 2);
});

test("Faithful Steed: Find Steed may spend its once-per-Long-Rest pool instead of a slot, at level 2; another spell may not", async () => {
  const fs = await import("node:fs");
  const {actionDefinitionFromItem} = await import("../module/helpers/action-definitions.mjs");
  const read = prefix => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${fs.readdirSync("packs/_source/srd-items")
    .find(file => file.startsWith(prefix))}`, "utf8"));
  const faithful = read("faithful-steed-phbpdn");
  const [rule] = faithful.system.ruleElements;
  assert.deepEqual([rule.data.resourceId, rule.data.maximum, rule.data.recovery, faithful.flags.wildpath.freeCast, faithful.flags.wildpath.conversion.notes],
    ["free-cast.faithful-steed", 1, "longRest", {spells: ["find-steed"], resourceId: "free-cast.faithful-steed"}, []]);
  const paladin = (pools=[{id: "free-cast.faithful-steed", value: 1, max: 1}]) => ({items: [faithful], system: {pools}});
  const slot = (spell, actor) => actionDefinitionFromItem({...spell, actor}).definition.configuration.find(choice => choice.id === "spell-slot");
  const steed = slot(read("find-steed-summon-steed-phb"), paladin());
  assert.deepEqual([steed.cost.anyOf.some(branch => branch[0]?.capability === "free-cast.faithful-steed"), steed.levelByResourceId["free-cast.faithful-steed"]],
    [true, 2]);
  const has = choice => choice.cost.anyOf.some(branch => branch[0]?.capability === "free-cast.faithful-steed");
  assert.equal(has(slot(read("find-steed-summon-steed-phb"), paladin([]))), false, "no pool");
  assert.equal(has(slot(read("aid-phb"), paladin())), false, "another spell");
  // The PHB's Favored Enemy (a bare feature there): Hunter's Mark from a pool of 2 to 6 by ranger level.
  const {convertItem} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  const [enemy] = convertItem({_id: "phbrgrFavoredEne", name: "Favored Enemy", type: "feat", system: {identifier: "favored-enemy",
    source: {book: "SRD 5.2", license: "CC-BY-4.0", rules: "2024"}, type: {value: "class", subtype: ""}, description: {value: "<p>Free casts.</p>"},
    activities: {}}}).items;
  assert.deepEqual([enemy.flags.wildpath.freeCast, enemy.system.ruleElements[0].data.maximum.rows[17]],
    [{spells: ["hunters-mark"], resourceId: "free-cast.favored-enemy"}, 6]);
});

test("Magic Initiate: the level 1 spell it gave casts free from its pool; its spells use the best of Intelligence, Wisdom and Charisma", async () => {
  const fs = await import("node:fs");
  const {actionDefinitionFromItem} = await import("../module/helpers/action-definitions.mjs");
  const read = prefix => JSON.parse(fs.readFileSync(`packs/_source/srd-items/${fs.readdirSync("packs/_source/srd-items")
    .find(file => file.startsWith(prefix))}`, "utf8"));
  const feat = {...read("magic-initiate-phbft"), id: "initiate"};
  assert.deepEqual([feat.system.advancement.map(entry => [entry.count, entry.pool.spellLevel]), feat.flags.wildpath.conversion.notes], [[[2, 0], [1, 1]], []]);
  const {grantedResourcesFromRuleElements} = await import("../module/helpers/rule-elements.mjs");
  assert.deepEqual(grantedResourcesFromRuleElements([{ruleElements: feat.system.ruleElements, source: {type: "item", id: "initiate"}}])
    .map(grant => grant.id), ["free-cast.magic-initiate.initiate"], "each copy's pool by its Item's id");
  // Each copy its own pool, by the feat Item's id; a second copy's spell spends the second's.
  const second = {...feat, id: "initiate2"};
  const fighter = {items: [feat, second], system: {pools: [{id: "free-cast.magic-initiate.initiate", value: 1, max: 1},
    {id: "free-cast.magic-initiate.initiate2", value: 1, max: 1}],
    abilities: {intellect: {value: 10}, wits: {value: 16}, presence: {value: 12}}}};
  const given = (spell, grantedBy="initiate") => actionDefinitionFromItem({...spell, flags: {...spell.flags, wildpath: {...spell.flags.wildpath, grantedBy}},
    actor: fighter}).definition;
  const bless = given(read("bless-phb")).configuration.find(choice => choice.id === "spell-slot");
  assert.equal(bless.levelByResourceId["free-cast.magic-initiate.initiate"], 1, "free, at level 1");
  assert.deepEqual(Object.keys(given(read("bless-phb"), "initiate2").configuration.find(choice => choice.id === "spell-slot").levelByResourceId)
    .filter(key => key.startsWith("free-cast")), ["free-cast.magic-initiate.initiate2"], "the second copy's spell, the second's pool");
  assert.equal(given(read("bless-phb"), null).configuration.find(choice => choice.id === "spell-slot").levelByResourceId["free-cast.magic-initiate.initiate"],
    undefined, "not one it gave");
  const flame = given(read("sacred-flame-phb"));
  assert.deepEqual(flame.save.dc.valueExpression.terms.at(-1), {type: "spellcasting-modifier", ability: "wits"}, "Wisdom, its best");
  const bolt = given(read("fire-bolt-phb"));
  assert.equal(bolt.attack.ability, "wits");
  assert.equal(given(read("fire-bolt-phb"), null).attack.ability, undefined, "a class's own spell keeps its class's ability");
});

test("third casters: their own table alone (a third of the level, rounded up, from 3rd), a third rounded down beside others", () => {
  const knight = level => ({id: "fighter", level, spellcasting: {progression: "third"}});
  // 2024 Eldritch Knight: 3rd level two 1st-level slots, 7th four and two, 19th 4/3/3/1.
  assert.deepEqual([2, 3, 4, 7, 10, 13, 19].map(level => casterLevel([knight(level)])), [0, 1, 2, 3, 4, 5, 7]);
  assert.deepEqual(spellSlots(casterLevel([knight(7)])).slice(0, 2), [4, 2]);
  assert.deepEqual(spellSlots(casterLevel([knight(19)])).slice(0, 4), [4, 3, 3, 1]);
  // Multiclassed with a wizard: a third of the Fighter levels, rounded down.
  assert.equal(casterLevel([knight(8), {id: "wizard", level: 2, spellcasting: {progression: "full"}}]), 4);
  assert.equal(casterLevel([knight(3), {id: "warlock", level: 2, spellcasting: {progression: "pact"}}]), 1, "Pact Magic is apart");
});

test("a class with no spellcasting of its own casts through its subclass, and prepares by its table", () => {
  const fighter = {type: "class", system: {identifier: "fighter", levels: 7, spellcasting: {progression: "none", ability: ""}}};
  const knight = {type: "subclass", system: {classIdentifier: "fighter", spellcasting: {progression: "third", ability: "intellect",
    prepared: [0, 0, 3, 4, 4, 4, 5]}}};
  const champion = {type: "subclass", system: {classIdentifier: "fighter", spellcasting: {progression: "none"}}};
  assert.equal(effectiveSpellcasting(fighter, [fighter, knight]).progression, "third");
  assert.equal(effectiveSpellcasting(fighter, [fighter, knight]).ability, "intellect");
  assert.equal(effectiveSpellcasting(fighter, [fighter, champion]).progression, "none");
  assert.equal(preparedSpellLimit([fighter], [fighter, knight]), 5);
  assert.equal(preparedSpellLimit([fighter], [fighter, champion]), null);
});

test("2014 Long Rest: spent Hit Dice back up to half of all of them, at least one, the largest dice first", async () => {
  const {longRestHitDice} = await import("../module/helpers/spellcasting.mjs");
  assert.deepEqual(longRestHitDice([{id: "hit-die.d10", value: 0, max: 3}, {id: "hit-die.d6", value: 1, max: 4}, {id: "ki", value: 0, max: 2}]),
    {"hit-die.d10": 3, "hit-die.d6": 1}, "half of 7 is 3, all to the d10s");
  assert.deepEqual(longRestHitDice([{id: "hit-die.d10", value: 2, max: 3}, {id: "hit-die.d6", value: 0, max: 4}]),
    {"hit-die.d10": 3, "hit-die.d6": 2}, "one d10 is spent, the rest go to the d6s");
  assert.deepEqual(longRestHitDice([{id: "hit-die.d8", value: 0, max: 1}]), {"hit-die.d8": 1}, "at least one");
});
