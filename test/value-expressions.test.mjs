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

