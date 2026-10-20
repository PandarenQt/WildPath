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


test("pool predicates: empty, and below its maximum, by id; a pool the creature lacks is neither", () => {
  const actor = {system: {pools: [{id: "rage", value: 1, max: 3}, {id: "persistent-rage", value: 0, max: 1}]}};
  assert.equal(evaluatePredicate({poolBelowMax: "rage"}, {actor}).ok, true);
  assert.equal(evaluatePredicate({poolEmpty: "persistent-rage"}, {actor}).ok, true);
  assert.equal(evaluatePredicate({poolEmpty: "rage"}, {actor}).ok, false);
  assert.equal(evaluatePredicate({poolBelowMax: "missing"}, {actor}).ok, false);
  assert.equal(evaluatePredicate({poolBelowMax: "rage"}, {actorSystem: {pools: [{id: "rage", value: 3, max: 3}]}}).ok, false);
});

test("bloodied: half its Hit Points or fewer", () => {
  const actor = value => ({system: {resources: {health: {value, max: 40}}}});
  assert.equal(evaluatePredicate({bloodied: true}, {actor: actor(20)}).ok, true);
  assert.equal(evaluatePredicate({bloodied: true}, {actor: actor(21)}).ok, false);
  assert.equal(evaluatePredicate({bloodied: false}, {actor: actor(40)}).ok, true);
});
