import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync, readdirSync} from "node:fs";
import {formatFormula, parseFormula} from "../module/helpers/formula.mjs";

const parse = (text, options) => {
  const result = parseFormula(text, options);
  assert.equal(result.ok, true, `${text}: ${JSON.stringify(result)}`);
  return result.expression;
};
const dice = (number, faces) => ({type: "dice", number, faces});
const constant = value => ({type: "constant", value});

test("formulas parse into the engine's ValueExpressions", () => {
  assert.deepEqual(parse("8"), constant(8));
  assert.deepEqual(parse("d6"), dice(1, 6));
  assert.deepEqual(parse("2d6 + 3"), {type: "add", terms: [dice(2, 6), constant(3)]});
  assert.deepEqual(parse("1d8 + mod(might) + 1"), {type: "add", terms: [dice(1, 8), {type: "ability-modifier", ability: "might"}, constant(1)]});
  assert.deepEqual(parse("2 * prof"), {type: "multiply", terms: [constant(2), {type: "proficiency-bonus"}]});
  assert.deepEqual(parse("8 + prof + spellmod"), {type: "add", terms: [constant(8), {type: "proficiency-bonus"}, {type: "spellcasting-modifier"}]});
  assert.deepEqual(parse("level / 2"), {type: "divide", numerator: {type: "character-level"}, denominator: constant(2), round: "floor"});
  assert.deepEqual(parse("ceil(level(wizard) / 2)"), {type: "divide", numerator: {type: "class-level", class: "wizard"},
    denominator: constant(2), round: "ceil"});
  assert.deepEqual(parse("10 - 1d4"), {type: "subtract", terms: [constant(10), dice(1, 4)]});
  assert.deepEqual(parse("(1 + 2) * 3"), {type: "multiply", terms: [{type: "add", terms: [constant(1), constant(2)]}, constant(3)]});
  assert.deepEqual(parse("resourcemax(ki)"), {type: "resource-max", resource: "ki"});
  assert.deepEqual(parse("-1"), constant(-1));
});

test("formatting gives back text that parses to the same expression", () => {
  for ( const text of ["8", "1d6", "2d6 + 3", "1d8 + mod(might) + 1", "2 * prof", "level / 2", "ceil(level(wizard) / 2)",
    "10 - 1d4", "(1 + 2) * 3", "8 + prof + spellmod", "resource(ki) - 1", "floor(prof * 3)", "2 * (level + 1)"] ) {
    const expression = parse(text);
    const formatted = formatFormula(expression);
    assert.ok(formatted, `${text} formats`);
    assert.deepEqual(parse(formatted), expression, `${text} -> ${formatted}`);
  }
  assert.equal(formatFormula({type: "table", key: {type: "character-level"}, rows: {1: 2}}), null, "a table stays JSON");
  assert.equal(formatFormula({type: "context", path: "effect.system.level"}), null);
  assert.equal(formatFormula({type: "dice", number: 1, faces: 8, bonus: 2}), "1d8 + 2");
});

test("every pack damage and healing expression formats and parses back unchanged", () => {
  const folder = new URL("../packs/_source/actions/", import.meta.url);
  for ( const file of readdirSync(folder).filter(name => name.endsWith(".json")) ) {
    const definition = JSON.parse(readFileSync(new URL(file, folder), "utf8")).system.definition;
    for ( const component of [...(definition.damage ?? []), ...(definition.healing ?? [])] ) {
      const text = formatFormula(component.expression);
      assert.ok(text, `${file}: ${JSON.stringify(component.expression)}`);
      assert.deepEqual(parse(text), component.expression, `${file}: ${text}`);
    }
  }
});

test("bad formulas name what is wrong and where", () => {
  const error = (text, options) => {
    const result = parseFormula(text, options);
    assert.equal(result.ok, false, text);
    return result.key;
  };
  assert.equal(error("   "), "Empty");
  assert.equal(error("(1 + 2"), "Unbalanced");
  assert.equal(error("1 + 2)"), "Unbalanced");
  assert.equal(error("1 + bananas"), "UnknownWord");
  assert.equal(error("mod(luck)", {abilities: ["might", "agility"]}), "UnknownAbility");
  assert.equal(error("2d6 + 3", {dice: false}), "DiceNotAllowed", "a DC cannot roll dice");
  assert.equal(error("1 + + 2"), "Unexpected");
  assert.equal(error("2 $ 3"), "Unexpected");
});

test("min, max and caller-supplied variables", () => {
  assert.deepEqual(parse("max(1, mod(wits))"), {type: "max", terms: [constant(1), {type: "ability-modifier", ability: "wits"}]});
  assert.deepEqual(parse("min(level, 5) + 1"), {type: "add", terms: [{type: "min", terms: [{type: "character-level"}, constant(5)]}, constant(1)]});
  const table = {type: "table", key: {type: "class-level", class: "rogue"}, rows: {1: dice(1, 6), 3: dice(2, 6)}};
  assert.deepEqual(parse("sneak + 2", {variables: {sneak: table}}), {type: "add", terms: [table, constant(2)]});
  for ( const text of ["max(1, mod(wits))", "min(level, 5) + 1"] ) assert.deepEqual(parse(formatFormula(parse(text))), parse(text));
  assert.equal(parseFormula("max(1,").ok, false);
});
