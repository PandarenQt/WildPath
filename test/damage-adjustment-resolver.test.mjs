import {test} from "node:test";
import assert from "node:assert/strict";
import {
  DAMAGE_ADJUSTMENT_CODES,
  adjustDamageResult,
  mergeDamageAdjustmentProfiles
} from "../module/resolvers/damage-adjustment-resolver.mjs";
import {damageProfileFromRuleElements} from "../module/helpers/rule-elements.mjs";
import {WILDPATH} from "../module/config.mjs";

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

test("damage adjustments apply immunity, then reductions, then resistance and vulnerability (Q94 (a) default)", () => {
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
  // Slashing 10 - 2 (armor) - 3 (parry, its first matching part) = 5, halved to 2; cold 9 - 4 (half of 9) = 5, doubled.
  assert.equal(result.damageResult.total, 12);
  assert.deepEqual(result.damageResult.byDamageType, {slashing: 2, fire: 0, cold: 10});
  assert.equal(result.applications.some(application => application.kind === "immunity"), true);
  assert.equal(result.applications.find(application => application.id === "ward").appliedAmount, 4);
  assert.equal(result.applications.find(application => application.id === "parry").appliedAmount, 3, "not spent on the immune fire");
  assert.equal(original.components[0].amount, 10);
});

test("Resistance is applied and rounded down before Vulnerability (Q20): 11 Fire with both deals 10, 5 deals 4", () => {
  const fire = amount => ({ok: true, components: [{id: "radiant-fire", amount, damageType: "fire"}], total: amount});
  const both = {resistances: ["fire"], vulnerabilities: ["fire"]};
  assert.equal(adjustDamageResult(fire(11), both).damageResult.total, 10);
  assert.equal(adjustDamageResult(fire(5), both).damageResult.total, 4);
  assert.equal(adjustDamageResult(fire(5), {vulnerabilities: ["fire"]}).damageResult.total, 10);
});

test("Resistance is applied over each damage type's total within one hit, each part keeping its share (Q20)", () => {
  const hit = (...parts) => ({ok: true, components: parts.map(([id, amount, damageType, extra]) => ({id, amount, damageType, ...extra})),
    total: parts.reduce((sum, [, amount]) => sum + amount, 0)});
  const amounts = result => result.damageResult.components.map(component => [component.id, component.amount]);

  // A Flame Tongue's Fire beside a rider's Fire: half of 6, not 1 + 1.
  const flame = adjustDamageResult(hit(["blade", 3, "fire"], ["smite", 3, "fire"]), {resistances: ["fire"]});
  assert.equal(flame.damageResult.total, 3);
  assert.deepEqual(amounts(flame), [["blade", 2], ["smite", 1]], "the leftover point goes to the first part");
  assert.deepEqual(flame.damageResult.components.map(component => component.metadata.damageAdjustments[0]),
    [{kind: "multiplier", ids: ["resistance:0"], damageType: "fire", multiplier: 0.5, originalAmount: 3, adjustedAmount: 2},
      {kind: "multiplier", ids: ["resistance:0"], damageType: "fire", multiplier: 0.5, originalAmount: 3, adjustedAmount: 1}]);
  assert.deepEqual(amounts(adjustDamageResult(hit(["blade", 7, "fire"], ["smite", 2, "fire"]), {resistances: ["fire"]})),
    [["blade", 3], ["smite", 1]], "4 split in proportion to 7 and 2 (3.11 and 0.89), the larger remainder rounding up");

  // Another type is its own total, and one Resistance naming both types still totals each apart.
  assert.deepEqual(amounts(adjustDamageResult(hit(["flame", 3, "fire"], ["frost", 3, "cold"]), {resistances: ["fire"]})),
    [["flame", 1], ["frost", 3]]);
  assert.deepEqual(amounts(adjustDamageResult(hit(["slash", 3, "slashing"], ["pierce", 3, "piercing"]),
    {resistances: [{id: "physical", damageTypes: ["slashing", "piercing"]}]})), [["slash", 1], ["pierce", 1]]);

  // A part that ignores Resistance stays whole and apart; the other is halved alone.
  assert.deepEqual(amounts(adjustDamageResult(hit(["backlash", 3, "fire", {ignoreResistance: true}], ["flame", 3, "fire"]),
    {resistances: ["fire"]})), [["backlash", 3], ["flame", 1]]);
  // A tag-matched Resistance totals only the parts carrying it.
  assert.deepEqual(amounts(adjustDamageResult(hit(["bolt", 3, "fire", {tags: ["spell"]}], ["bolt2", 3, "fire", {tags: ["spell"]}],
    ["blade", 3, "fire"]), {resistances: [{tags: ["spell"]}]})), [["bolt", 2], ["bolt2", 1], ["blade", 3]]);
});

test("a wholeHit halving (Uncanny Dodge) is over the hit's total (Q94 (b) default); Petrified's Resistance to all damage is per type", () => {
  const hit = {ok: true, components: [{id: "slash", amount: 3, damageType: "slashing"}, {id: "flame", amount: 3, damageType: "fire"}],
    total: 6};
  // The converter's Uncanny Dodge rule, read through the creature's grants as the runtime does.
  const dodge = damageProfileFromRuleElements([{ruleElements: [{schemaVersion: 1, id: "halved", type: "GrantResistance",
    data: {damageTypes: [], wholeHit: true}}]}]);
  const dodged = adjustDamageResult(hit, dodge);
  assert.equal(dodged.damageResult.total, 3, "half of 6, not 1 + 1");
  assert.deepEqual(dodged.damageResult.byDamageType, {slashing: 2, fire: 1});
  const petrified = damageProfileFromRuleElements([{ruleElements: WILDPATH.CONDITIONS.petrified.ruleElements}]);
  assert.deepEqual(adjustDamageResult(hit, petrified).damageResult.byDamageType, {slashing: 1, fire: 1}, "each type halved (Q20)");
  // With a typed Resistance beside it, the halving is that part's Resistance too, so each type is its own total.
  assert.equal(adjustDamageResult(hit, mergeDamageAdjustmentProfiles(dodge, {resistances: ["fire"]})).damageResult.total, 2);
});

test("a second Resistance that changes nothing does not split a type's total (Q20; several Resistances count as one)", () => {
  const hit = {ok: true, components: [{id: "bolt", amount: 3, damageType: "fire", tags: ["magical"]}, {id: "flame", amount: 3, damageType: "fire"}],
    total: 6};
  assert.equal(adjustDamageResult(hit, {resistances: ["fire"]}).damageResult.total, 3);
  const both = adjustDamageResult(hit, {resistances: ["fire", {id: "m", tags: ["magical"]}]});
  assert.equal(both.damageResult.total, 3, "both parts are halved once, so they are one total");
  assert.deepEqual(both.damageResult.components.map(component => component.metadata.damageAdjustments[0].ids), [["resistance:0", "m"],
    ["resistance:0"]], "each part names the Resistances that matched it");
  assert.equal(adjustDamageResult(hit, {vulnerabilities: ["fire", {id: "m", tags: ["magical"]}]}).damageResult.total, 12);
});

test("rolled damage reduction requires an already resolved amount", () => {
  const result = adjustDamageResult(damageResult(), {
    reductions: [{id: "parry", type: "rolled", formula: "1d8 + 2"}]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, DAMAGE_ADJUSTMENT_CODES.INVALID_REDUCTION);
});

test("damage absorption converts what is left after ordinary reductions", () => {
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
  // The armor's 2 comes off the fire first (12 to 10), and half of the 10 is absorbed.
  assert.equal(result.damageResult.total, 9);
  assert.deepEqual(result.damageResult.byDamageType, {fire: 5, slashing: 4});
  assert.deepEqual(result.absorptionResults, [{
    kind: "absorption",
    id: "fire-heart",
    absorptionType: "scaled",
    resourceId: "health",
    requestedAmount: 5,
    absorbedAmount: 5,
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

test("damage that ignores Resistance outright (Overchannel's backlash) skips a Resistance to all damage too", () => {
  const backlash = ignoreResistance => ({ok: true, code: "OK", total: 20, byDamageType: {necrotic: 20},
    components: [{id: "backlash", amount: 20, damageType: "necrotic", ...(ignoreResistance ? {ignoreResistance} : {})}]});
  const petrified = mergeDamageAdjustmentProfiles({resistances: [{id: "petrified", damageTypes: []}]});
  assert.equal(adjustDamageResult(backlash(true), petrified).damageResult.total, 20, "not halved");
  assert.equal(adjustDamageResult(backlash(false), petrified).damageResult.total, 10, "other damage still is");
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
