import {test} from "node:test";
import assert from "node:assert/strict";
import {casterLevel, deriveClassData, hitDiceHealing, spellSlots} from "../module/helpers/spellcasting.mjs";

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
