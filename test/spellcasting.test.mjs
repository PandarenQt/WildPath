import {test} from "node:test";
import assert from "node:assert/strict";
import {casterLevel, deriveClassData, hitDiceHealing, pactMagic, spellSlots} from "../module/helpers/spellcasting.mjs";

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
  const actor = pools => ({system: {pools}});
  const spell = (arcanum, pools) => ({...disintegrate, flags: {wildpath: {arcanum}}, actor: actor(pools)});
  const options = item => actionDefinitionFromItem(item).definition.configuration.find(choice => choice.id === "spell-slot").cost.anyOf
    .map(branch => branch[0].capability);
  const arcanumPool = [{id: "mystic-arcanum.6", value: 1, max: 1}];
  assert.equal(options(spell(true, arcanumPool)).includes("mystic-arcanum.6"), true, "marked, with the arcanum");
  assert.equal(options(spell(false, arcanumPool)).includes("mystic-arcanum.6"), false, "not marked");
  assert.equal(options(spell(true, [])).includes("mystic-arcanum.6"), false, "no arcanum of that level");
  assert.deepEqual([preparesSpell(spell(true, arcanumPool)), preparesSpell(spell(false, arcanumPool))], [false, true]);
});
