import {test} from "node:test";
import assert from "node:assert/strict";
import {CREATURE_SIZES} from "../module/helpers/grid-footprints.mjs";
import {
  WEAPON_SIZE_CODES,
  compareCreatureSizes,
  evaluateWeaponSizeUse,
  getOversizedWeaponDamageMultiplier,
  resolveWeaponSizeProfile
} from "../module/helpers/weapon-sizing.mjs";

test("creature size comparison covers the standard size ladder", () => {
  assert.equal(compareCreatureSizes(CREATURE_SIZES.SMALL, CREATURE_SIZES.MEDIUM), -1);
  assert.equal(compareCreatureSizes(CREATURE_SIZES.MEDIUM, CREATURE_SIZES.MEDIUM), 0);
  assert.equal(compareCreatureSizes(CREATURE_SIZES.HUGE, CREATURE_SIZES.LARGE), 1);
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
