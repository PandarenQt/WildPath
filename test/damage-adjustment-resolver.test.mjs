import {test} from "node:test";
import assert from "node:assert/strict";
import {
  DAMAGE_ADJUSTMENT_CODES,
  adjustDamageResult,
  mergeDamageAdjustmentProfiles
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

test("damage absorption converts incoming damage before ordinary reductions", () => {
  const result = adjustDamageResult({
    ok: true,
    components: [
      {id: "flame", amount: 12, damageType: "fire"},
      {id: "slash", amount: 4, damageType: "slashing"}
    ],
    total: 16
  }, {
    absorptions: [{id: "fire-heart", damageTypes: ["fire"], scale: 0.5, resourceId: "health"}],
    reductions: [{id: "armor", amount: 2}]
  });

  assert.equal(result.ok, true);
  assert.equal(result.damageResult.total, 8);
  assert.deepEqual(result.damageResult.byDamageType, {fire: 4, slashing: 4});
  assert.deepEqual(result.absorptionResults, [{
    kind: "absorption",
    id: "fire-heart",
    absorptionType: "scaled",
    resourceId: "health",
    requestedAmount: 6,
    absorbedAmount: 6,
    remainingAmount: 0,
    metadata: {}
  }]);
});

test("rolled damage absorption requires an already resolved amount", () => {
  const result = adjustDamageResult(damageResult(), {
    absorptions: [{id: "warding-plate", type: "rolled", formula: "1d6", resourceId: "ward"}]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, DAMAGE_ADJUSTMENT_CODES.INVALID_ABSORPTION);
});

test("damage whose attacker ignores Resistance to its type is not halved by it; Immunity still holds", async () => {
  const {mergeDamageAdjustmentProfiles} = await import("../module/resolvers/damage-adjustment-resolver.mjs");
  const profile = mergeDamageAdjustmentProfiles({ignoresResistance: ["slashing", "fire"]}, {resistances: ["slashing", "cold"], immunities: ["fire"]});
  const result = adjustDamageResult(damageResult(), profile);
  assert.deepEqual(result.damageResult.byDamageType, {slashing: 10, fire: 0, cold: 4},
    "slashing ignores its Resistance; fire is still Immune; cold is still halved");
  const {ignoredResistances} = await import("../module/helpers/combat-statistics.mjs");
  assert.deepEqual(ignoredResistances({items: [{system: {active: true}, flags: {wildpath: {ignoresResistance: ["bludgeoning", "piercing"]}}},
    {system: {active: false}, flags: {wildpath: {ignoresResistance: ["fire"]}}}]}), ["bludgeoning", "piercing"], "active features only");
});

test("several Resistances to one damage type count as one; a halving of every type is not one an attacker can ignore", async () => {
  const {mergeDamageAdjustmentProfiles} = await import("../module/resolvers/damage-adjustment-resolver.mjs");
  const tiefling = mergeDamageAdjustmentProfiles({resistances: [{id: "legacy", damageTypes: ["slashing"]}]},
    {resistances: [{id: "species", damageTypes: ["slashing"]}]});
  assert.equal(adjustDamageResult(damageResult(), tiefling).damageResult.byDamageType.slashing, 5, "halved once, not to a quarter");
  const dodging = mergeDamageAdjustmentProfiles({ignoresResistance: ["slashing"]}, {resistances: [{id: "uncanny-dodge", damageTypes: []}]});
  assert.equal(adjustDamageResult(damageResult(), dodging).damageResult.byDamageType.slashing, 5,
    "Uncanny Dodge still halves a Boon of Irresistible Offense's slashing");
});

test("a Damage Threshold (a ship's 15) ignores a smaller total from one source, after its other adjustments", () => {
  const hit = amount => ({ok: true, code: "OK", components: [{id: "ram", amount, damageType: "bludgeoning"}], total: amount,
    byDamageType: {bludgeoning: amount}});
  const ship = {damageThreshold: 15, immunities: ["poison"]};
  const below = adjustDamageResult(hit(14), ship);
  assert.equal(below.damageResult.total, 0, "superficial");
  assert.deepEqual(below.applications.at(-1), {kind: "threshold", threshold: 15, prevented: 14});
  assert.equal(adjustDamageResult(hit(15), ship).damageResult.total, 15, "at the threshold it takes it all");
  assert.equal(adjustDamageResult(hit(20), {...ship, resistances: ["bludgeoning"]}).damageResult.total, 0, "halved to 10 first");
  assert.equal(adjustDamageResult(damageResult(), ship).damageResult.total, 27, "several types add up as one source");
  assert.equal(mergeDamageAdjustmentProfiles({damageThreshold: 10}, {damageThreshold: 15}, {}).damageThreshold, 15);
});

test("a Resistance by tag halves only damage carrying it: Spell Resistance against a spell's fire, not a sword's", async () => {
  const spellDamage = {ok: true, code: "OK", target: {id: "t", actorId: "a"}, components: [{id: "bolt", amount: 10, damageType: "fire", tags: ["spell"]},
    {id: "sword", amount: 6, damageType: "slashing", tags: ["weapon"]}], total: 16, byDamageType: {fire: 10, slashing: 6}};
  const result = adjustDamageResult(spellDamage, {resistances: [{tags: ["spell"]}]});
  assert.deepEqual(result.damageResult.components.map(component => [component.id, component.amount]), [["bolt", 5], ["sword", 6]]);
});
