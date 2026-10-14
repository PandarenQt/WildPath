import {test} from "node:test";
import assert from "node:assert/strict";
import {
  VALUE_EXPRESSION_CODES,
  evaluateValueExpression,
  evaluateValueExpressionNumber
} from "../module/helpers/value-expressions.mjs";

const context = {
  actorSystem: {
    abilities: {
      might: {value: 18},
      wits: {value: 9}
    },
    details: {level: 9},
    classes: {
      fighter: {level: 5}
    },
    resources: {
      health: {value: 12, max: 20}
    },
    pools: [
      {id: "focus", value: 1, max: 3}
    ],
    spellcasting: {ability: "might"}
  }
};

test("ValueExpression evaluates actor-derived values without JavaScript formulas", () => {
  assert.equal(evaluateValueExpression({type: "ability-score", ability: "might"}, context).value, 18);
  assert.equal(evaluateValueExpression({type: "ability-modifier", ability: "might"}, context).value, 4);
  assert.equal(evaluateValueExpression({type: "proficiency-bonus"}, context).value, 4);
  assert.equal(evaluateValueExpression({type: "character-level"}, context).value, 9);
  assert.equal(evaluateValueExpression({type: "class-level", class: "fighter"}, context).value, 5);
  assert.equal(evaluateValueExpression({type: "spellcasting-modifier"}, context).value, 4);
});

test("ValueExpression resolves resource current and max values for built-in and custom pools", () => {
  assert.equal(evaluateValueExpression({type: "resource-current", resource: "health"}, context).value, 12);
  assert.equal(evaluateValueExpression({type: "resource-max", resource: "health"}, context).value, 20);
  assert.equal(evaluateValueExpression({type: "resource-current", resource: "focus"}, context).value, 1);
  assert.equal(evaluateValueExpression({type: "resource-max", resource: "focus"}, context).value, 3);
});

test("ValueExpression supports safe arithmetic composition", () => {
  const expression = {
    type: "floor",
    value: {
      type: "divide",
      numerator: {
        type: "subtract",
        terms: [
          {type: "resource-max", resource: "health"},
          {type: "resource-current", resource: "health"}
        ]
      },
      denominator: {type: "constant", value: 3}
    }
  };

  assert.equal(evaluateValueExpression(expression, context).value, 2);
});

test("ValueExpression can represent dice safely with explicit total or average mode", () => {
  assert.equal(evaluateValueExpression({type: "dice", number: 2, faces: 6, total: 7}, context).value, 7);
  assert.equal(evaluateValueExpression({
    type: "dice",
    number: 2,
    faces: 6,
    bonus: {type: "ability-modifier", ability: "might"},
    evaluation: "average"
  }, context).value, 11);

  const unresolved = evaluateValueExpression({type: "dice", number: 1, faces: 8}, context);
  assert.equal(unresolved.ok, false);
  assert.equal(unresolved.code, VALUE_EXPRESSION_CODES.INVALID_EXPRESSION);
});

test("ValueExpression numeric wrapper returns fallback for unresolved expressions", () => {
  const value = evaluateValueExpressionNumber({type: "resource-current", resource: "missing"}, context, 99);
  assert.equal(value, 99);
});


test("a table ValueExpression steps by its key, e.g. a class level, with a default below its first row", () => {
  const sneak = {type: "table", key: {type: "class-level", class: "rogue"}, rows: {1: 1, 3: 2, 5: 3}};
  const at = level => evaluateValueExpression(sneak, {classLevels: [{slug: "rogue", level}]});
  assert.deepEqual([1, 2, 3, 4, 5, 20].map(level => at(level).value), [1, 1, 2, 2, 3, 3]);
  assert.equal(evaluateValueExpression({...sneak, key: 0}).ok, false, "no row at or below the key and no default");
  assert.equal(evaluateValueExpression({...sneak, key: 0, default: 0}).value, 0);
  assert.equal(evaluateValueExpression({type: "table", key: 2, rows: {1: {type: "add", terms: [1, 1]}}}).value, 2,
    "rows may themselves be expressions");
});

test("ActionDefinition validation accepts a table ValueExpression and rejects one without numeric rows or a key", async () => {
  const {validateActionDefinition} = await import("../module/helpers/action-definitions.mjs");
  const strike = expression => ({schemaVersion: 1, id: "action:t", label: "T", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1},
    damage: [{id: "d", expression, damageType: "fire"}]});
  assert.equal(validateActionDefinition(strike({type: "table", key: {type: "character-level"}, rows: {1: 2, 5: 4}})).ok, true);
  assert.equal(validateActionDefinition(strike({type: "table", key: 3, rows: {one: 2}})).ok, false);
  assert.equal(validateActionDefinition(strike({type: "table", rows: {1: 2}})).ok, false);
});

test("a class-based caster's source snapshot: level from its classes, spellcasting from its spellcasting class", () => {
  // The authority reads source data: `details.level` is the stored default, and `spellcasting` is not prepared.
  const snapshot = {actorSystem: {abilities: {intellect: {value: 16}}, details: {level: 1},
    classes: [{id: "wizard", name: "Wizard", level: 5, original: true, spellcasting: {progression: "full", ability: "intellect"}}]}};
  assert.equal(evaluateValueExpression({type: "character-level"}, snapshot).value, 5);
  assert.equal(evaluateValueExpression({type: "proficiency-bonus"}, snapshot).value, 3);
  assert.equal(evaluateValueExpression({type: "spellcasting-modifier"}, snapshot).value, 3);
  const dc = {type: "add", terms: [{type: "constant", value: 8}, {type: "proficiency-bonus"}, {type: "spellcasting-modifier"}]};
  assert.equal(evaluateValueExpression(dc, snapshot).value, 14, "a 5th-level wizard with Intellect 16 has spell save DC 14");
});

test("a creature without a character level takes its proficiency bonus from its threat; an effective bonus wins", () => {
  assert.equal(evaluateValueExpression({type: "proficiency-bonus"}, {actorSystem: {details: {threat: 9}}}).value, 4);
  assert.equal(evaluateValueExpression({type: "proficiency-bonus"}, {actorSystem: {details: {threat: 9}, proficiencyBonus: 6}}).value, 6);
});
