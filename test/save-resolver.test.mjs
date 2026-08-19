import {test} from "node:test";
import assert from "node:assert/strict";
import {
  SAVE_OUTCOMES,
  SAVE_RESOLVER_CODES,
  createSaveDC,
  createSaveRoll,
  resolveSaveAgainstDC,
  resolveSaveTargets
} from "../module/resolvers/save-resolver.mjs";

test("SaveResolver treats a tie as a success by default", () => {
  const result = resolveSaveAgainstDC({
    roll: createSaveRoll({total: 15, die: 10, ability: "dex"}),
    dc: createSaveDC({value: 15, ability: "dex"})
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, SAVE_RESOLVER_CODES.OK);
  assert.equal(result.outcome, SAVE_OUTCOMES.SUCCESS);
  assert.equal(result.success, true);
  assert.equal(result.margin, 0);
});

test("SaveResolver can require exceeding the DC", () => {
  const result = resolveSaveAgainstDC({
    roll: {total: 15, die: 10},
    dc: {value: 15},
    policy: {successOnTie: false}
  });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, SAVE_OUTCOMES.FAILURE);
  assert.equal(result.success, false);
});

test("natural save criticals are policy controlled", () => {
  const success = resolveSaveAgainstDC({
    roll: {total: 9, die: 20},
    dc: {value: 30},
    policy: {naturalCriticalSuccesses: true}
  });
  const failure = resolveSaveAgainstDC({
    roll: {total: 30, die: 1},
    dc: {value: 10},
    policy: {naturalCriticalFailures: true}
  });

  assert.equal(success.outcome, SAVE_OUTCOMES.CRITICAL_SUCCESS);
  assert.equal(success.success, true);
  assert.equal(success.critical, true);
  assert.equal(failure.outcome, SAVE_OUTCOMES.CRITICAL_FAILURE);
  assert.equal(failure.success, false);
  assert.equal(failure.critical, true);
});

test("SaveResolver reports malformed save inputs without throwing", () => {
  const missingRoll = resolveSaveAgainstDC({
    roll: {die: 14},
    dc: {value: 15}
  });
  const missingDC = resolveSaveAgainstDC({
    roll: {total: 16, die: 11},
    dc: {}
  });

  assert.equal(missingRoll.ok, false);
  assert.equal(missingRoll.code, SAVE_RESOLVER_CODES.MISSING_SAVE_TOTAL);
  assert.equal(missingDC.ok, false);
  assert.equal(missingDC.code, SAVE_RESOLVER_CODES.MISSING_DC);
});

test("SaveResolver resolves selected target contexts against per-target save rolls", () => {
  const result = resolveSaveTargets({
    dc: {value: 15, ability: "dex"},
    saveKey: "dex",
    targetContexts: [
      {
        target: {id: "rogue", actor: {id: "actor-rogue"}},
        saves: {dex: {total: 18, die: 13}},
        selected: true
      },
      {
        target: {id: "ogre", actor: {id: "actor-ogre"}},
        saves: {dex: {total: 9, die: 4}},
        selected: true
      }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, SAVE_RESOLVER_CODES.OK);
  assert.deepEqual(result.successes.map(save => save.target.id), ["rogue"]);
  assert.deepEqual(result.failures.map(save => save.target.id), ["ogre"]);
  assert.equal(result.invalid.length, 0);
});

test("SaveResolver records skipped target contexts without treating them as failures", () => {
  const result = resolveSaveTargets({
    dc: 15,
    targetContexts: [
      {
        target: {id: "selected"},
        save: {total: 18, die: 13},
        selected: true
      },
      {
        target: {id: "excluded"},
        save: {total: 18, die: 13},
        selected: false,
        excluded: true,
        resolutionState: "excluded"
      }
    ]
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.successes.map(save => save.target.id), ["selected"]);
  assert.deepEqual(result.skipped.map(skip => skip.target.id), ["excluded"]);
});

test("SaveResolver reports no saveable targets when all contexts are excluded", () => {
  const result = resolveSaveTargets({
    dc: 15,
    targetContexts: [
      {
        target: {id: "excluded"},
        save: {total: 18},
        selected: false,
        excluded: true
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, SAVE_RESOLVER_CODES.NO_SAVEABLE_TARGETS);
  assert.equal(result.skipped.length, 1);
});

test("SaveResolver preserves target failures while resolving other targets", () => {
  const result = resolveSaveTargets({
    dc: 15,
    targetContexts: [
      {target: {id: "rogue"}, save: {total: 18}, selected: true},
      {target: {id: "unknown"}, selected: true}
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, SAVE_RESOLVER_CODES.MISSING_SAVE_TOTAL);
  assert.deepEqual(result.successes.map(save => save.target.id), ["rogue"]);
  assert.deepEqual(result.invalid.map(failure => failure.target.id), ["unknown"]);
});
