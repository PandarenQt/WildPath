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

test("a total floor (Indomitable Might) counts when judged, after anything that changed the roll", () => {
  const judged = total => resolveSaveAgainstDC({roll: {total, die: 3, totalMinimum: 20}, dc: {value: 19}});
  assert.deepEqual([judged(8).success, judged(8).total, judged(8).roll.total], [true, 20, 8], "3 + 5 counts as 20; the roll stays 8");
  // Portent turned the 3 into a 1 (8 - 3 + 1): still at least 20; into an 18: 23, not 20 + 15.
  assert.equal(judged(6).success, true);
  assert.equal(judged(23).total, 23);
  // Cutting Words' 4 off a floored check: the floor still holds.
  assert.equal(judged(8 - 4).total, 20);
  // Each target's result hands back the roll as rolled, so what changes it later (Bardic Inspiration's 3 on a DC 22
  // save: 8 + 3 = 11, counted as 20) never builds on the floor.
  const [target] = resolveSaveTargets({roll: {total: 8, die: 3, totalMinimum: 20}, targets: [{id: "barbarian"}],
    dc: {value: 22}}).results;
  assert.deepEqual([target.success, target.roll.total], [false, 8]);
  assert.equal(resolveSaveAgainstDC({roll: {...target.roll, total: target.roll.total + 3}, dc: {value: 22}}).success, false, "11 counts as 20, not 23");
  assert.equal(resolveSaveAgainstDC({roll: {total: 8, die: 3}, dc: {value: 19}}).success, false, "no floor");
});
