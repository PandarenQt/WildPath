import {test} from "node:test";
import assert from "node:assert/strict";
import {
  HEALING_RESOLVER_CODES,
  resolveHealingTargets
} from "../module/resolvers/healing-resolver.mjs";

test("HealingResolver totals healing components for selected targets", () => {
  const result = resolveHealingTargets({
    components: [
      {id: "roll", rolled: 5, bonus: 2, healingType: "vitality"},
      {id: "aura", amount: 3, healingType: "temporary"}
    ],
    targets: [{id: "ally", actorId: "actor-ally"}]
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.totals, {ally: 10});
  assert.deepEqual(result.results[0].byHealingType, {vitality: 7, temporary: 3});
});

test("HealingResolver reports malformed components and skipped targets", () => {
  const invalid = resolveHealingTargets({
    components: [{id: "missing"}],
    targets: [{id: "ally", actorId: "actor-ally"}]
  });
  const skipped = resolveHealingTargets({
    components: [{id: "touch", amount: 4}],
    targetContexts: [{target: {id: "ally", actorId: "actor-ally"}, selected: false}]
  });

  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, HEALING_RESOLVER_CODES.MISSING_AMOUNT);
  assert.equal(skipped.ok, false);
  assert.equal(skipped.code, HEALING_RESOLVER_CODES.NO_HEALABLE_TARGETS);
  assert.equal(skipped.skipped[0].code, HEALING_RESOLVER_CODES.TARGET_SKIPPED);
});
