import {test} from "node:test";
import assert from "node:assert/strict";
import {
  ATTACK_OUTCOMES,
  ATTACK_RESOLVER_CODES,
  createAttackDefense,
  createAttackRoll,
  resolveAttackAgainstDefense,
  resolveAttackTargets
} from "../module/resolvers/attack-resolver.mjs";

test("AttackResolver treats a tie as a hit by default", () => {
  const result = resolveAttackAgainstDefense({
    roll: createAttackRoll({total: 15, die: 10}),
    defense: createAttackDefense({value: 15, slug: "ac"})
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, ATTACK_RESOLVER_CODES.OK);
  assert.equal(result.outcome, ATTACK_OUTCOMES.HIT);
  assert.equal(result.hit, true);
  assert.equal(result.margin, 0);
});

test("AttackResolver can require exceeding the defense", () => {
  const result = resolveAttackAgainstDefense({
    roll: {total: 15, die: 10},
    defense: {value: 15},
    policy: {hitOnTie: false}
  });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, ATTACK_OUTCOMES.MISS);
  assert.equal(result.hit, false);
});

test("natural critical hit can hit even below defense", () => {
  const result = resolveAttackAgainstDefense({
    roll: {total: 12, die: 20},
    defense: {value: 30}
  });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, ATTACK_OUTCOMES.CRITICAL_HIT);
  assert.equal(result.hit, true);
  assert.equal(result.critical, true);
  assert.equal(result.margin, -18);
});

test("natural critical miss can miss even above defense", () => {
  const result = resolveAttackAgainstDefense({
    roll: {total: 40, die: 1},
    defense: {value: 10}
  });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, ATTACK_OUTCOMES.CRITICAL_MISS);
  assert.equal(result.hit, false);
  assert.equal(result.critical, true);
  assert.equal(result.margin, 30);
});

test("AttackResolver reports malformed attack inputs without throwing", () => {
  const missingRoll = resolveAttackAgainstDefense({
    roll: {die: 14},
    defense: {value: 15}
  });
  const missingDefense = resolveAttackAgainstDefense({
    roll: {total: 16, die: 11},
    defense: {}
  });

  assert.equal(missingRoll.ok, false);
  assert.equal(missingRoll.code, ATTACK_RESOLVER_CODES.MISSING_ATTACK_TOTAL);
  assert.equal(missingDefense.ok, false);
  assert.equal(missingDefense.code, ATTACK_RESOLVER_CODES.MISSING_DEFENSE);
});

test("AttackResolver resolves selected target contexts against per-target defenses", () => {
  const result = resolveAttackTargets({
    roll: {total: 17, die: 12},
    targetContexts: [
      {
        target: {id: "orc", actor: {id: "actor-orc"}, defenses: {ac: {value: 14}}},
        selected: true
      },
      {
        target: {id: "knight", actor: {id: "actor-knight"}, defenses: {ac: {value: 19}}},
        selected: true
      }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, ATTACK_RESOLVER_CODES.OK);
  assert.deepEqual(result.hits.map(hit => hit.target.id), ["orc"]);
  assert.deepEqual(result.misses.map(miss => miss.target.id), ["knight"]);
  assert.equal(result.failures.length, 0);
});

test("AttackResolver records skipped target contexts without treating them as failures", () => {
  const result = resolveAttackTargets({
    roll: {total: 18, die: 13},
    targetContexts: [
      {
        target: {id: "selected", defense: {value: 15}},
        selected: true
      },
      {
        target: {id: "excluded", defense: {value: 15}},
        selected: false,
        excluded: true,
        resolutionState: "excluded"
      }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.hits.map(hit => hit.target.id), ["selected"]);
  assert.deepEqual(result.skipped.map(skip => skip.target.id), ["excluded"]);
});

test("AttackResolver reports no attackable targets when all contexts are excluded", () => {
  const result = resolveAttackTargets({
    roll: {total: 18, die: 13},
    targetContexts: [
      {
        target: {id: "excluded", defense: {value: 15}},
        selected: false,
        excluded: true
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, ATTACK_RESOLVER_CODES.NO_ATTACKABLE_TARGETS);
  assert.equal(result.skipped.length, 1);
});

test("AttackResolver preserves target failures while resolving other targets", () => {
  const result = resolveAttackTargets({
    roll: {total: 18, die: 13},
    targetContexts: [
      {target: {id: "armored", defense: {value: 20}}, selected: true},
      {target: {id: "unknown"}, selected: true}
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, ATTACK_RESOLVER_CODES.MISSING_DEFENSE);
  assert.deepEqual(result.misses.map(miss => miss.target.id), ["armored"]);
  assert.deepEqual(result.failures.map(failure => failure.target.id), ["unknown"]);
});
