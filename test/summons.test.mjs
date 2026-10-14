import {test} from "node:test";
import assert from "node:assert/strict";
import {summonExpired, summonPlacements} from "../module/adapters/foundry-v14-summons.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";

// A square grid's eight neighbours.
const square = ({i, j}) => [-1, 0, 1].flatMap(di => [-1, 0, 1].map(dj => ({i: i + di, j: j + dj})))
  .filter(offset => (offset.i !== i) || (offset.j !== j));

test("summons go on the nearest free fields around the caster, skipping occupied ones", () => {
  const placed = summonPlacements({start: {i: 5, j: 5}, count: 3, occupied: new Set(["4,4", "4,5", "5,5"]), adjacent: square});
  assert.equal(placed.length, 3);
  for ( const offset of placed ) {
    assert.ok(Math.max(Math.abs(offset.i - 5), Math.abs(offset.j - 5)) === 1, "next to the caster");
    assert.ok(!["4,4", "4,5", "5,5"].includes(`${offset.i},${offset.j}`), "never on a creature");
  }
  const ring = new Set(square({i: 5, j: 5}).map(offset => `${offset.i},${offset.j}`));
  const crowded = summonPlacements({start: {i: 5, j: 5}, count: 2, occupied: new Set([...ring, "5,5"]), adjacent: square});
  assert.ok(crowded.every(offset => Math.max(Math.abs(offset.i - 5), Math.abs(offset.j - 5)) === 2), "the next ring when it is full");
});

test("a summon with rounds leaves at the turn it arrived on, that many rounds later, in its own combat only", () => {
  const flag = {rounds: 2, createdAt: {combatId: "c", round: 1, turn: 3}};
  assert.equal(summonExpired(flag, {id: "c", round: 3, turn: 2}), false);
  assert.equal(summonExpired(flag, {id: "c", round: 3, turn: 3}), true);
  assert.equal(summonExpired(flag, {id: "other", round: 9, turn: 0}), false);
  assert.equal(summonExpired({rounds: null, createdAt: flag.createdAt}, {id: "c", round: 9, turn: 0}), false, "no rounds: it stays");
});

test("a summon names exactly one creature source and a count from 1 to 20", () => {
  const definition = summon => ({schemaVersion: 1, id: "action:s", label: "S", costs: {allOf: []}, summon});
  assert.equal(validateActionDefinition(definition({actorRef: "Actor.wolf", count: 3, rounds: 10, concentration: true})).ok, true);
  assert.equal(validateActionDefinition(definition({choiceId: "beast"})).ok, true);
  assert.equal(validateActionDefinition(definition({actorRef: "Actor.wolf", choiceId: "beast"})).ok, false);
  assert.equal(validateActionDefinition(definition({actorRef: "Actor.wolf", count: 0})).ok, false);
});
