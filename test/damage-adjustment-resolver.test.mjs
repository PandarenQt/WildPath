import {test} from "node:test";
import assert from "node:assert/strict";
import {
  DAMAGE_ADJUSTMENT_CODES,
  adjustDamageResult
} from "../module/resolvers/damage-adjustment-resolver.mjs";

function damageResult() {
  return {
    ok: true,
    code: "OK",
    target: {id: "target-a", actorId: "actor-a"},
    components: [
      {id: "slash", amount: 10, damageType: "slashing", tags: ["weapon"]},
      {id: "flame", amount: 8, damageType: "fire"},
      {id: "frost", amount: 9, damageType: "cold"}
    ],
    total: 27,
    byDamageType: {slashing: 10, fire: 8, cold: 9}
  };
}

test("damage adjustments apply immunity, resistance, and vulnerability before reductions", () => {
  const original = damageResult();
  const result = adjustDamageResult(original, {
    immunities: ["fire"],
    resistances: ["slashing"],
    vulnerabilities: ["cold"],
    reductions: [
      {id: "armor", type: "flat", amount: 2, damageTypes: ["slashing"]},
      {id: "ward", type: "scaled", scale: 0.5, damageTypes: ["cold"]},
      {id: "parry", type: "rolled", amount: 3}
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.damageResult.originalTotal, 27);
  assert.equal(result.damageResult.total, 9);
  assert.deepEqual(result.damageResult.byDamageType, {slashing: 0, fire: 0, cold: 9});
  assert.equal(result.applications.some(application => application.kind === "immunity"), true);
  assert.equal(result.applications.find(application => application.id === "ward").appliedAmount, 9);
  assert.equal(original.components[0].amount, 10);
});

test("damage resistance and vulnerability can cancel each other by multiplying", () => {
  const result = adjustDamageResult({
    ok: true,
    components: [{id: "radiant-fire", amount: 11, damageType: "fire"}],
    total: 11
  }, {
    resistances: ["fire"],
    vulnerabilities: ["fire"]
  });

  assert.equal(result.ok, true);
  assert.equal(result.damageResult.total, 11);
});

test("rolled damage reduction requires an already resolved amount", () => {
  const result = adjustDamageResult(damageResult(), {
    reductions: [{id: "parry", type: "rolled", formula: "1d8 + 2"}]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, DAMAGE_ADJUSTMENT_CODES.INVALID_REDUCTION);
});
