import {CREATURE_SIZE_ORDER, CREATURE_SIZES} from "./grid-footprints.mjs";

export const WEAPON_SIZE_CODES = Object.freeze({
  OK: "OK",
  OVERSIZED_DISADVANTAGE: "OVERSIZED_DISADVANTAGE",
  TOO_LARGE: "TOO_LARGE"
});

export const OVERSIZED_WEAPON_DAMAGE_MULTIPLIERS = Object.freeze({
  [CREATURE_SIZES.TINY]: 1,
  [CREATURE_SIZES.SMALL]: 1,
  [CREATURE_SIZES.MEDIUM]: 1,
  [CREATURE_SIZES.LARGE]: 2,
  [CREATURE_SIZES.HUGE]: 3,
  [CREATURE_SIZES.GARGANTUAN]: 4
});

/* -------------------------------------------- */

export function compareCreatureSizes(a, b) {
  return sizeIndex(a) - sizeIndex(b);
}

/* -------------------------------------------- */

export function getOversizedWeaponDamageMultiplier(weaponSize=CREATURE_SIZES.MEDIUM, multipliers=OVERSIZED_WEAPON_DAMAGE_MULTIPLIERS) {
  return multipliers[normalizeSize(weaponSize)] ?? 1;
}

/* -------------------------------------------- */

export function evaluateWeaponSizeUse({
  wielderSize=CREATURE_SIZES.MEDIUM,
  weaponSize=CREATURE_SIZES.MEDIUM,
  tooLargeThreshold=2,
  allowTooLarge=false
}={}) {
  const sizeDifference = compareCreatureSizes(weaponSize, wielderSize);
  if ( sizeDifference >= tooLargeThreshold && !allowTooLarge ) {
    return {
      ok: false,
      code: WEAPON_SIZE_CODES.TOO_LARGE,
      sizeDifference,
      attackDisadvantage: true,
      reason: "weapon is sized for a creature two or more categories larger"
    };
  }
  if ( sizeDifference > 0 ) {
    return {
      ok: true,
      code: WEAPON_SIZE_CODES.OVERSIZED_DISADVANTAGE,
      sizeDifference,
      attackDisadvantage: true,
      reason: "weapon is sized for a larger attacker"
    };
  }
  return {
    ok: true,
    code: WEAPON_SIZE_CODES.OK,
    sizeDifference,
    attackDisadvantage: false,
    reason: null
  };
}

/* -------------------------------------------- */

/**
 * Resolve the spatial and damage-facing profile for a weapon-sized attack. Oversized weapon rules
 * affect usability and damage dice multipliers here; reach remains explicit action/weapon data.
 * @param {object} options
 * @returns {object}
 */
export function resolveWeaponSizeProfile({
  wielderSize=CREATURE_SIZES.MEDIUM,
  weaponSize=CREATURE_SIZES.MEDIUM,
  baseReach=5,
  reachDistance=null,
  hasReachProperty=false,
  reachPropertyDistance=10,
  extraReach=0,
  damageMultipliers=OVERSIZED_WEAPON_DAMAGE_MULTIPLIERS,
  tooLargeThreshold=2,
  allowTooLarge=false
}={}) {
  const sizeUse = evaluateWeaponSizeUse({wielderSize, weaponSize, tooLargeThreshold, allowTooLarge});
  const resolvedReach = Number(reachDistance ?? (hasReachProperty ? reachPropertyDistance : baseReach)) + (Number(extraReach) || 0);

  return {
    ok: sizeUse.ok,
    code: sizeUse.code,
    wielderSize: normalizeSize(wielderSize),
    weaponSize: normalizeSize(weaponSize),
    attackDisadvantage: sizeUse.attackDisadvantage,
    damageDiceMultiplier: getOversizedWeaponDamageMultiplier(weaponSize, damageMultipliers),
    reachDistance: Math.max(resolvedReach, 0),
    reachSource: reachDistance != null ? "explicit" : (hasReachProperty ? "reach-property" : "base"),
    sizeDifference: sizeUse.sizeDifference,
    reason: sizeUse.reason
  };
}

/* -------------------------------------------- */

function sizeIndex(size) {
  const index = CREATURE_SIZE_ORDER.indexOf(normalizeSize(size));
  if ( index < 0 ) throw new Error(`Unknown creature size: ${size}`);
  return index;
}

function normalizeSize(size) {
  return String(size ?? CREATURE_SIZES.MEDIUM).toLowerCase();
}
