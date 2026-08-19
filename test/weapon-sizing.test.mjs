import {test} from "node:test";
import assert from "node:assert/strict";
import {CREATURE_SIZES} from "../module/helpers/grid-footprints.mjs";
import {
  WEAPON_DAMAGE_SCALING_CATEGORIES,
  WEAPON_SIZE_CODES,
  WEAPON_SIZE_HANDLING,
  WEAPON_SIZE_POLICY_IDS,
  WEAPON_SIZE_REASON_CODES,
  compareCreatureSizes,
  createWeaponSizeContext,
  evaluateWeaponSizeUse,
  evaluateWeaponWieldability,
  getCreatureSizeRank,
  getOversizedWeaponDamageMultiplier,
  getSizeDifference,
  resolveWeaponDamageScaling,
  resolveWeaponSizeProfile
} from "../module/helpers/weapon-sizing.mjs";

test("creature size comparison covers the standard size ladder", () => {
  assert.deepEqual([
    CREATURE_SIZES.TINY,
    CREATURE_SIZES.SMALL,
    CREATURE_SIZES.MEDIUM,
    CREATURE_SIZES.LARGE,
    CREATURE_SIZES.HUGE,
    CREATURE_SIZES.GARGANTUAN
  ].map(getCreatureSizeRank), [0, 1, 2, 3, 4, 5]);
  assert.equal(compareCreatureSizes(CREATURE_SIZES.SMALL, CREATURE_SIZES.MEDIUM), -1);
  assert.equal(compareCreatureSizes(CREATURE_SIZES.MEDIUM, CREATURE_SIZES.MEDIUM), 0);
  assert.equal(compareCreatureSizes(CREATURE_SIZES.HUGE, CREATURE_SIZES.LARGE), 1);
  assert.equal(getSizeDifference({
    wielderSize: CREATURE_SIZES.MEDIUM,
    weaponSize: CREATURE_SIZES.LARGE
  }), 1);
});

test("oversized weapon damage multipliers account for every standard size category", () => {
  assert.equal(getOversizedWeaponDamageMultiplier(CREATURE_SIZES.TINY), 1);
  assert.equal(getOversizedWeaponDamageMultiplier(CREATURE_SIZES.SMALL), 1);
  assert.equal(getOversizedWeaponDamageMultiplier(CREATURE_SIZES.MEDIUM), 1);
  assert.equal(getOversizedWeaponDamageMultiplier(CREATURE_SIZES.LARGE), 2);
  assert.equal(getOversizedWeaponDamageMultiplier(CREATURE_SIZES.HUGE), 3);
  assert.equal(getOversizedWeaponDamageMultiplier(CREATURE_SIZES.GARGANTUAN), 4);
});

test("one-size oversized weapons impose disadvantage while two-size weapons can be too large", () => {
  const oneSizeLarge = evaluateWeaponSizeUse({
    wielderSize: CREATURE_SIZES.MEDIUM,
    weaponSize: CREATURE_SIZES.LARGE
  });
  const twoSizesLarge = evaluateWeaponSizeUse({
    wielderSize: CREATURE_SIZES.MEDIUM,
    weaponSize: CREATURE_SIZES.HUGE
  });

  assert.equal(oneSizeLarge.ok, true);
  assert.equal(oneSizeLarge.code, WEAPON_SIZE_CODES.OVERSIZED_DISADVANTAGE);
  assert.equal(oneSizeLarge.attackDisadvantage, true);
  assert.equal(twoSizesLarge.ok, false);
  assert.equal(twoSizesLarge.code, WEAPON_SIZE_CODES.TOO_LARGE);
});

test("weapon size profile keeps reach explicit instead of deriving reach from oversized damage", () => {
  const oversized = resolveWeaponSizeProfile({
    wielderSize: CREATURE_SIZES.MEDIUM,
    weaponSize: CREATURE_SIZES.LARGE,
    baseReach: 5
  });
  const reachWeapon = resolveWeaponSizeProfile({
    wielderSize: CREATURE_SIZES.LARGE,
    weaponSize: CREATURE_SIZES.LARGE,
    hasReachProperty: true,
    reachPropertyDistance: 10
  });
  const explicitReach = resolveWeaponSizeProfile({
    wielderSize: CREATURE_SIZES.HUGE,
    weaponSize: CREATURE_SIZES.HUGE,
    reachDistance: 15
  });

  assert.equal(oversized.damageDiceMultiplier, 2);
  assert.equal(oversized.reachDistance, 5);
  assert.equal(oversized.reachSource, "base");
  assert.equal(reachWeapon.reachDistance, 10);
  assert.equal(reachWeapon.reachSource, "reach-property");
  assert.equal(explicitReach.damageDiceMultiplier, 3);
  assert.equal(explicitReach.reachDistance, 15);
  assert.equal(explicitReach.reachSource, "explicit");
});

test("2014 WeaponSizePolicy reports same-size wieldability without oversized penalties", () => {
  const result = evaluateWeaponWieldability({
    ruleset: WEAPON_SIZE_POLICY_IDS.RULES_2014,
    effectiveWielderSize: CREATURE_SIZES.MEDIUM,
    effectiveWeaponSize: CREATURE_SIZES.MEDIUM
  });

  assert.equal(result.ok, true);
  assert.equal(result.usable, true);
  assert.equal(result.code, WEAPON_SIZE_CODES.OK);
  assert.equal(result.attackState.disadvantage, false);
  assert.equal(result.sizeDifference, 0);
  assert.deepEqual(result.reasonCodes, [WEAPON_SIZE_REASON_CODES.WEAPON_SIZE_MATCH]);
});

test("2014 WeaponSizePolicy handles one-size and two-size larger weapons", () => {
  const oneLarger = evaluateWeaponWieldability({
    ruleset: WEAPON_SIZE_POLICY_IDS.RULES_2014,
    effectiveWielderSize: CREATURE_SIZES.MEDIUM,
    effectiveWeaponSize: CREATURE_SIZES.LARGE
  });
  const twoLarger = evaluateWeaponWieldability({
    ruleset: WEAPON_SIZE_POLICY_IDS.RULES_2014,
    effectiveWielderSize: CREATURE_SIZES.MEDIUM,
    effectiveWeaponSize: CREATURE_SIZES.HUGE
  });
  const threeLarger = evaluateWeaponWieldability({
    ruleset: WEAPON_SIZE_POLICY_IDS.RULES_2014,
    effectiveWielderSize: CREATURE_SIZES.SMALL,
    effectiveWeaponSize: CREATURE_SIZES.GARGANTUAN
  });

  assert.equal(oneLarger.usable, true);
  assert.equal(oneLarger.code, WEAPON_SIZE_CODES.OVERSIZED_DISADVANTAGE);
  assert.equal(oneLarger.attackState.disadvantage, true);
  assert.equal(twoLarger.usable, false);
  assert.equal(twoLarger.code, WEAPON_SIZE_CODES.TOO_LARGE);
  assert.equal(threeLarger.usable, false);
  assert.equal(threeLarger.sizeDifference, 4);
});

test("House weapon-size policy can make two-size larger weapons usable with disadvantage", () => {
  const result = evaluateWeaponWieldability({
    ruleset: WEAPON_SIZE_POLICY_IDS.HOUSE,
    effectiveWielderSize: CREATURE_SIZES.MEDIUM,
    effectiveWeaponSize: CREATURE_SIZES.HUGE,
    policyOptions: {
      twoOrMoreLarger: WEAPON_SIZE_HANDLING.DISADVANTAGE
    }
  });

  assert.equal(result.usable, true);
  assert.equal(result.attackState.disadvantage, true);
  assert.equal(result.policyId, WEAPON_SIZE_POLICY_IDS.HOUSE);
  assert.equal(result.reasonCodes.includes(WEAPON_SIZE_REASON_CODES.HOUSE_RULE_OVERRIDE), true);
});

test("2014 WeaponSizePolicy scales only explicitly weapon-size-scalable damage dice", () => {
  const result = resolveWeaponDamageScaling({
    ruleset: WEAPON_SIZE_POLICY_IDS.RULES_2014,
    effectiveWielderSize: CREATURE_SIZES.HUGE,
    effectiveWeaponSize: CREATURE_SIZES.HUGE,
    damageComponents: [
      component("base", 1, 8, "slashing", WEAPON_DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE),
      component("fire", 1, 6, "fire")
    ]
  });

  assert.equal(result.multiplier, 3);
  assert.deepEqual(diceOf(result.scaledComponents, "base"), {number: 3, faces: 8});
  assert.deepEqual(diceOf(result.scaledComponents, "fire"), {number: 1, faces: 6});
  assert.deepEqual(result.baseComponents.map(component => component.id), ["base"]);
  assert.deepEqual(result.unscaledComponents.map(component => component.id), ["fire"]);
});

test("weapon-size scaling handles Large, Huge, Gargantuan, and multiple base dice", () => {
  const large = resolveWeaponDamageScaling({
    ruleset: WEAPON_SIZE_POLICY_IDS.RULES_2014,
    effectiveWeaponSize: CREATURE_SIZES.LARGE,
    damageComponents: [component("greatsword", 2, 6, "slashing", WEAPON_DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE)]
  });
  const huge = resolveWeaponDamageScaling({
    ruleset: WEAPON_SIZE_POLICY_IDS.RULES_2014,
    effectiveWeaponSize: CREATURE_SIZES.HUGE,
    damageComponents: [component("greatsword", 2, 6, "slashing", WEAPON_DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE)]
  });
  const gargantuan = resolveWeaponDamageScaling({
    ruleset: WEAPON_SIZE_POLICY_IDS.RULES_2014,
    effectiveWeaponSize: CREATURE_SIZES.GARGANTUAN,
    damageComponents: [component("greatsword", 2, 6, "slashing", WEAPON_DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE)]
  });

  assert.deepEqual(diceOf(large.scaledComponents, "greatsword"), {number: 4, faces: 6});
  assert.deepEqual(diceOf(huge.scaledComponents, "greatsword"), {number: 6, faces: 6});
  assert.deepEqual(diceOf(gargantuan.scaledComponents, "greatsword"), {number: 8, faces: 6});
});

test("additional components scale only when their metadata opts in", () => {
  const result = resolveWeaponDamageScaling({
    ruleset: WEAPON_SIZE_POLICY_IDS.RULES_2014,
    effectiveWeaponSize: CREATURE_SIZES.LARGE,
    damageComponents: [
      component("slashing", 1, 8, "slashing", WEAPON_DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE),
      component("fire", 1, 6, "fire", WEAPON_DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE)
    ]
  });

  assert.deepEqual(diceOf(result.scaledComponents, "slashing"), {number: 2, faces: 8});
  assert.deepEqual(diceOf(result.scaledComponents, "fire"), {number: 2, faces: 6});
});

test("natural weapons and unchanged carried weapons do not scale automatically", () => {
  const natural = resolveWeaponDamageScaling({
    ruleset: WEAPON_SIZE_POLICY_IDS.RULES_2014,
    effectiveWielderSize: CREATURE_SIZES.HUGE,
    effectiveWeaponSize: CREATURE_SIZES.HUGE,
    weapon: {kind: "natural"},
    damageComponents: [component("bite", 2, 10, "piercing")]
  });
  const enlargedActorOnly = resolveWeaponDamageScaling({
    ruleset: WEAPON_SIZE_POLICY_IDS.RULES_2014,
    effectiveWielderSize: CREATURE_SIZES.LARGE,
    effectiveWeaponSize: CREATURE_SIZES.MEDIUM,
    damageComponents: [component("longsword", 1, 8, "slashing", WEAPON_DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE)]
  });
  const actorAndWeaponEnlarged = resolveWeaponDamageScaling({
    ruleset: WEAPON_SIZE_POLICY_IDS.RULES_2014,
    effectiveWielderSize: CREATURE_SIZES.LARGE,
    effectiveWeaponSize: CREATURE_SIZES.LARGE,
    damageComponents: [component("longsword", 1, 8, "slashing", WEAPON_DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE)]
  });

  assert.deepEqual(diceOf(natural.scaledComponents, "bite"), {number: 2, faces: 10});
  assert.deepEqual(diceOf(enlargedActorOnly.scaledComponents, "longsword"), {number: 1, faces: 8});
  assert.deepEqual(diceOf(actorAndWeaponEnlarged.scaledComponents, "longsword"), {number: 2, faces: 8});
});

test("2024 WeaponSizePolicy is independent from 2014 oversized scaling", () => {
  const rules2014 = resolveWeaponDamageScaling({
    ruleset: WEAPON_SIZE_POLICY_IDS.RULES_2014,
    effectiveWeaponSize: CREATURE_SIZES.HUGE,
    damageComponents: [component("base", 1, 8, "slashing", WEAPON_DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE)]
  });
  const rules2024 = resolveWeaponDamageScaling({
    ruleset: WEAPON_SIZE_POLICY_IDS.RULES_2024,
    effectiveWeaponSize: CREATURE_SIZES.HUGE,
    damageComponents: [component("base", 1, 8, "slashing", WEAPON_DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE)]
  });
  const wieldability2024 = evaluateWeaponWieldability({
    ruleset: WEAPON_SIZE_POLICY_IDS.RULES_2024,
    effectiveWielderSize: CREATURE_SIZES.MEDIUM,
    effectiveWeaponSize: CREATURE_SIZES.HUGE
  });

  assert.deepEqual(diceOf(rules2014.scaledComponents, "base"), {number: 3, faces: 8});
  assert.deepEqual(diceOf(rules2024.scaledComponents, "base"), {number: 1, faces: 8});
  assert.equal(wieldability2024.code, WEAPON_SIZE_CODES.NEUTRAL);
});

test("WeaponSizePolicy keeps Heavy and Reach independent from weapon size", () => {
  const oversizedNotHeavy = evaluateWeaponWieldability({
    ruleset: WEAPON_SIZE_POLICY_IDS.RULES_2014,
    weapon: {properties: []},
    effectiveWielderSize: CREATURE_SIZES.MEDIUM,
    effectiveWeaponSize: CREATURE_SIZES.LARGE
  });
  const heavyNotOversized = evaluateWeaponWieldability({
    ruleset: WEAPON_SIZE_POLICY_IDS.RULES_2014,
    weapon: {properties: ["heavy"]},
    effectiveWielderSize: CREATURE_SIZES.MEDIUM,
    effectiveWeaponSize: CREATURE_SIZES.MEDIUM
  });
  const reach = resolveWeaponSizeProfile({
    wielderSize: CREATURE_SIZES.HUGE,
    weaponSize: CREATURE_SIZES.HUGE,
    baseReach: 5
  });

  assert.equal(oversizedNotHeavy.attackState.disadvantage, true);
  assert.equal(heavyNotOversized.attackState.disadvantage, false);
  assert.equal(reach.reachDistance, 5);
});

test("WeaponSizePolicy context and damage scaling do not mutate inputs", () => {
  const weapon = {designedForSize: CREATURE_SIZES.MEDIUM, nested: {value: 1}};
  const damage = [component("base", 1, 8, "slashing", WEAPON_DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE)];
  const context = createWeaponSizeContext({
    weapon,
    effectiveWeaponSize: CREATURE_SIZES.LARGE,
    damageComponents: damage
  });
  const result = resolveWeaponDamageScaling(context);

  result.scaledComponents[0].dice.number = 99;
  context.weapon.nested.value = 99;

  assert.equal(weapon.nested.value, 1);
  assert.equal(damage[0].dice.number, 1);
});

function component(id, number, faces, damageType, scalingCategory=WEAPON_DAMAGE_SCALING_CATEGORIES.NONE) {
  return {
    id,
    dice: {number, faces},
    damageType,
    scalingCategory,
    scalingCategories: scalingCategory === WEAPON_DAMAGE_SCALING_CATEGORIES.NONE ? [] : [scalingCategory],
    weaponSizeScalable: scalingCategory === WEAPON_DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE
  };
}

function diceOf(components, id) {
  const dice = components.find(component => component.id === id)?.dice;
  return {number: dice.number, faces: dice.faces};
}
