import {test} from "node:test";
import assert from "node:assert/strict";
import {PREDICATE_CODES, evaluatePredicate} from "../module/helpers/predicates.mjs";

test("shared Predicate evaluator handles tags, equality, one-of, and negation", () => {
  const context = {
    tags: ["weapon-attack", "melee"],
    target: {disposition: "enemy"},
    actor: {type: "character"}
  };

  const result = evaluatePredicate({
    all: [
      {tagsAll: ["weapon-attack"]},
      {equals: {path: "target.disposition", value: "enemy"}},
      {oneOf: {path: "actor.type", values: ["character", "npc"]}},
      {not: {tagsAny: ["spell"]}}
    ]
  }, context);

  assert.equal(result.ok, true);
  assert.equal(result.code, PREDICATE_CODES.OK);
});

test("shared Predicate evaluator rejects arbitrary functions and unknown keys", () => {
  const functionResult = evaluatePredicate(() => true, {});
  const unknownResult = evaluatePredicate({script: "return true"}, {});

  assert.equal(functionResult.ok, false);
  assert.equal(functionResult.code, PREDICATE_CODES.INVALID);
  assert.equal(unknownResult.ok, false);
  assert.equal(unknownResult.code, PREDICATE_CODES.INVALID);
});

