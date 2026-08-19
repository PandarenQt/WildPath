import {CREATURE_SIZE_ORDER, CREATURE_SIZES} from "./grid-footprints.mjs";

export const WEAPON_SIZE_CODES = Object.freeze({
  OK: "OK",
  OVERSIZED_DISADVANTAGE: "OVERSIZED_DISADVANTAGE",
  TOO_LARGE: "TOO_LARGE",
  NEUTRAL: "NEUTRAL"
});

export const WEAPON_SIZE_POLICY_IDS = Object.freeze({
  RULES_2014: "rules-2014",
  RULES_2024: "rules-2024",
  HOUSE: "house"
});

export const WEAPON_SIZE_REASON_CODES = Object.freeze({
  WEAPON_SIZE_MATCH: "WEAPON_SIZE_MATCH",
  WEAPON_SMALLER_THAN_WIELDER: "WEAPON_SMALLER_THAN_WIELDER",
  WEAPON_ONE_SIZE_LARGER: "WEAPON_ONE_SIZE_LARGER",
  WEAPON_TOO_LARGE: "WEAPON_TOO_LARGE",
  OVERSIZED_WEAPON_DISADVANTAGE: "OVERSIZED_WEAPON_DISADVANTAGE",
  WEAPON_SIZE_DAMAGE_SCALING: "WEAPON_SIZE_DAMAGE_SCALING",
  POLICY_2024_NEUTRAL: "POLICY_2024_NEUTRAL",
  HOUSE_RULE_OVERRIDE: "HOUSE_RULE_OVERRIDE"
});

export const WEAPON_SIZE_HANDLING = Object.freeze({
  NORMAL: "normal",
  DISADVANTAGE: "disadvantage",
  UNUSABLE: "unusable"
});

export const WEAPON_DAMAGE_SCALING_CATEGORIES = Object.freeze({
  NONE: "none",
  WEAPON_SIZE: "weapon-size"
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
  return getCreatureSizeRank(a) - getCreatureSizeRank(b);
}

/* -------------------------------------------- */

export function getCreatureSizeRank(size) {
  const index = CREATURE_SIZE_ORDER.indexOf(normalizeCreatureSize(size));
  if ( index < 0 ) throw new Error(`Unknown creature size: ${size}`);
  return index;
}

/* -------------------------------------------- */

export function getSizeDifference({weaponSize=CREATURE_SIZES.MEDIUM, wielderSize=CREATURE_SIZES.MEDIUM}={}) {
  return compareCreatureSizes(weaponSize, wielderSize);
}

/* -------------------------------------------- */

export function getOversizedWeaponDamageMultiplier(weaponSize=CREATURE_SIZES.MEDIUM, multipliers=OVERSIZED_WEAPON_DAMAGE_MULTIPLIERS) {
  return multipliers[normalizeCreatureSize(weaponSize)] ?? 1;
}

/* -------------------------------------------- */

export function createWeaponSizeContext({
  ruleset=WEAPON_SIZE_POLICY_IDS.RULES_2014,
  weapon={},
  wielder={},
  designedWeaponSize=null,
  effectiveWeaponSize=null,
  effectiveWielderSize=null,
  damageComponents=[],
  policyOptions={},
  metadata={}
}={}) {
  const designedSize = normalizeCreatureSize(
    designedWeaponSize
      ?? weapon.designedForSize
      ?? weapon.designedSize
      ?? weapon.size
      ?? CREATURE_SIZES.MEDIUM
  );
  return {
    ruleset,
    weapon: clonePlain(weapon) ?? {},
    wielder: clonePlain(wielder) ?? {},
    designedWeaponSize: designedSize,
    effectiveWeaponSize: normalizeCreatureSize(
      effectiveWeaponSize
        ?? weapon.effectiveSize
        ?? weapon.effectiveWeaponSize
        ?? designedSize
    ),
    effectiveWielderSize: normalizeCreatureSize(
      effectiveWielderSize
        ?? wielder.effectiveSize
        ?? wielder.effectiveCreatureSize
        ?? wielder.size
        ?? CREATURE_SIZES.MEDIUM
    ),
    damageComponents: damageComponents.map(clonePlain),
    policyOptions: clonePlain(policyOptions) ?? {},
    metadata: clonePlain(metadata) ?? {}
  };
}

/* -------------------------------------------- */

export function getWeaponSizePolicy(ruleset=WEAPON_SIZE_POLICY_IDS.RULES_2014, options={}) {
  const id = typeof ruleset === "object" ? ruleset.id : ruleset;
  if ( typeof ruleset === "object" && typeof ruleset.evaluateWieldability === "function" ) return ruleset;
  switch ( id ) {
    case WEAPON_SIZE_POLICY_IDS.RULES_2024:
      return createRules2024WeaponSizePolicy(options);
    case WEAPON_SIZE_POLICY_IDS.HOUSE:
      return createHouseRuleWeaponSizePolicy(options);
    case WEAPON_SIZE_POLICY_IDS.RULES_2014:
    default:
      return createRules2014WeaponSizePolicy(options);
  }
}

/* -------------------------------------------- */

export function evaluateWeaponWieldability(contextOrOptions={}, policyOptions={}) {
  const context = createWeaponSizeContext(contextOrOptions);
  const policy = getWeaponSizePolicy(context.ruleset, {...context.policyOptions, ...policyOptions});
  return policy.evaluateWieldability(context);
}

/* -------------------------------------------- */

export function resolveWeaponDamageScaling(contextOrOptions={}, policyOptions={}) {
  const context = createWeaponSizeContext(contextOrOptions);
  const policy = getWeaponSizePolicy(context.ruleset, {...context.policyOptions, ...policyOptions});
  return policy.resolveDamageScaling(context);
}

/* -------------------------------------------- */

export function createRules2014WeaponSizePolicy(options={}) {
  const policyOptions = {
    oneSizeLarger: WEAPON_SIZE_HANDLING.DISADVANTAGE,
    twoOrMoreLarger: WEAPON_SIZE_HANDLING.UNUSABLE,
    damageMultipliers: OVERSIZED_WEAPON_DAMAGE_MULTIPLIERS,
    ...clonePlain(options)
  };
  return createPolicy({
    id: WEAPON_SIZE_POLICY_IDS.RULES_2014,
    options: policyOptions,
    damageMultiplierForSize: size => getOversizedWeaponDamageMultiplier(size, policyOptions.damageMultipliers)
  });
}

/* -------------------------------------------- */

export function createRules2024WeaponSizePolicy(options={}) {
  const policyOptions = {
    damageMultipliers: {},
    ...clonePlain(options)
  };
  return {
    id: WEAPON_SIZE_POLICY_IDS.RULES_2024,
    evaluateWieldability(context) {
      const sizeDifference = compareCreatureSizes(context.effectiveWeaponSize, context.effectiveWielderSize);
      return createWieldabilityResult({
        policyId: WEAPON_SIZE_POLICY_IDS.RULES_2024,
        context,
        code: WEAPON_SIZE_CODES.NEUTRAL,
        usable: true,
        attackDisadvantage: false,
        sizeDifference,
        reasonCodes: [WEAPON_SIZE_REASON_CODES.POLICY_2024_NEUTRAL],
        appliedPolicies: [WEAPON_SIZE_POLICY_IDS.RULES_2024]
      });
    },
    resolveDamageScaling(context) {
      return createDamageScalingResult({
        policyId: WEAPON_SIZE_POLICY_IDS.RULES_2024,
        context,
        multiplier: 1,
        reasonCodes: [WEAPON_SIZE_REASON_CODES.POLICY_2024_NEUTRAL]
      });
    },
    options: policyOptions
  };
}

/* -------------------------------------------- */

export function createHouseRuleWeaponSizePolicy(options={}) {
  const policy = createRules2014WeaponSizePolicy({
    oneSizeLarger: options.oneSizeLarger ?? WEAPON_SIZE_HANDLING.DISADVANTAGE,
    twoOrMoreLarger: options.twoOrMoreLarger ?? WEAPON_SIZE_HANDLING.UNUSABLE,
    damageMultipliers: options.damageMultipliers ?? OVERSIZED_WEAPON_DAMAGE_MULTIPLIERS
  });
  return {
    ...policy,
    id: WEAPON_SIZE_POLICY_IDS.HOUSE,
    evaluateWieldability(context) {
      const result = policy.evaluateWieldability(context);
      return {
        ...result,
        policyId: WEAPON_SIZE_POLICY_IDS.HOUSE,
        appliedPolicies: [...new Set([...result.appliedPolicies, WEAPON_SIZE_POLICY_IDS.HOUSE])],
        reasonCodes: [...new Set([...result.reasonCodes, WEAPON_SIZE_REASON_CODES.HOUSE_RULE_OVERRIDE])]
      };
    },
    resolveDamageScaling(context) {
      const result = policy.resolveDamageScaling(context);
      return {
        ...result,
        policyId: WEAPON_SIZE_POLICY_IDS.HOUSE,
        appliedPolicies: [...new Set([...result.appliedPolicies, WEAPON_SIZE_POLICY_IDS.HOUSE])],
        reasonCodes: [...new Set([...result.reasonCodes, WEAPON_SIZE_REASON_CODES.HOUSE_RULE_OVERRIDE])]
      };
    }
  };
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
    wielderSize: normalizeCreatureSize(wielderSize),
    weaponSize: normalizeCreatureSize(weaponSize),
    attackDisadvantage: sizeUse.attackDisadvantage,
    damageDiceMultiplier: getOversizedWeaponDamageMultiplier(weaponSize, damageMultipliers),
    reachDistance: Math.max(resolvedReach, 0),
    reachSource: reachDistance != null ? "explicit" : (hasReachProperty ? "reach-property" : "base"),
    sizeDifference: sizeUse.sizeDifference,
    reason: sizeUse.reason
  };
}

/* -------------------------------------------- */

export function isWeaponSizeScalableComponent(component) {
  return component?.weaponSizeScalable === true
    || component?.scalingCategory === WEAPON_DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE
    || (component?.scalingCategories ?? []).includes(WEAPON_DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE);
}

/* -------------------------------------------- */

export function normalizeCreatureSize(size) {
  return String(size ?? CREATURE_SIZES.MEDIUM).toLowerCase();
}

function createPolicy({id, options, damageMultiplierForSize}) {
  return {
    id,
    evaluateWieldability(context) {
      const sizeDifference = compareCreatureSizes(context.effectiveWeaponSize, context.effectiveWielderSize);
      const handling = handlingForDifference(sizeDifference, options);
      return createWieldabilityResult({
        policyId: id,
        context,
        code: codeForHandling(handling),
        usable: handling !== WEAPON_SIZE_HANDLING.UNUSABLE,
        attackDisadvantage: handling === WEAPON_SIZE_HANDLING.DISADVANTAGE,
        sizeDifference,
        reasonCodes: reasonCodesForDifference(sizeDifference, handling),
        appliedPolicies: [id]
      });
    },
    resolveDamageScaling(context) {
      const multiplier = damageMultiplierForSize(context.effectiveWeaponSize);
      return createDamageScalingResult({
        policyId: id,
        context,
        multiplier,
        reasonCodes: [multiplier === 1
          ? WEAPON_SIZE_REASON_CODES.WEAPON_SIZE_MATCH
          : WEAPON_SIZE_REASON_CODES.WEAPON_SIZE_DAMAGE_SCALING]
      });
    },
    options: clonePlain(options) ?? {}
  };
}

function createWieldabilityResult({
  policyId,
  context,
  code,
  usable,
  attackDisadvantage,
  sizeDifference,
  reasonCodes,
  appliedPolicies
}) {
  return {
    ok: usable,
    usable,
    code,
    policyId,
    ruleset: context.ruleset,
    designedWeaponSize: context.designedWeaponSize,
    effectiveWeaponSize: context.effectiveWeaponSize,
    effectiveWielderSize: context.effectiveWielderSize,
    sizeDifference,
    attackState: {disadvantage: attackDisadvantage},
    reasonCodes,
    appliedPolicies,
    trace: {
      weapon: clonePlain(context.weapon),
      wielder: clonePlain(context.wielder),
      designedWeaponSize: context.designedWeaponSize,
      effectiveWeaponSize: context.effectiveWeaponSize,
      effectiveWielderSize: context.effectiveWielderSize,
      sizeDifference,
      result: usable ? "usable" : "unusable"
    }
  };
}

function createDamageScalingResult({policyId, context, multiplier, reasonCodes}) {
  const components = context.damageComponents.map(clonePlain);
  const scaledComponents = components.map(component => {
    return isWeaponSizeScalableComponent(component) ? scaleComponentDice(component, multiplier) : clonePlain(component);
  });
  return {
    ok: true,
    code: WEAPON_SIZE_CODES.OK,
    policyId,
    ruleset: context.ruleset,
    designedWeaponSize: context.designedWeaponSize,
    effectiveWeaponSize: context.effectiveWeaponSize,
    effectiveWielderSize: context.effectiveWielderSize,
    multiplier,
    baseComponents: components.filter(isWeaponSizeScalableComponent),
    unscaledComponents: components.filter(component => !isWeaponSizeScalableComponent(component)),
    scaledComponents,
    sourcePolicy: policyId,
    reasonCodes,
    appliedPolicies: [policyId],
    trace: {
      designedWeaponSize: context.designedWeaponSize,
      effectiveWeaponSize: context.effectiveWeaponSize,
      effectiveWielderSize: context.effectiveWielderSize,
      multiplier,
      scaledComponentIds: scaledComponents.filter(isWeaponSizeScalableComponent).map(component => component.id).filter(Boolean)
    }
  };
}

function scaleComponentDice(component, multiplier) {
  const scaled = clonePlain(component);
  if ( multiplier === 1 ) return scaled;
  if ( !scaled.dice ) return scaled;
  scaled.dice = {
    ...scaled.dice,
    number: Math.max(Math.floor((Number(scaled.dice.number ?? scaled.dice.count) || 0) * multiplier), 0),
    formula: null,
    metadata: clonePlain(scaled.dice.metadata ?? {}) ?? {}
  };
  scaled.metadata = {
    ...(scaled.metadata ?? {}),
    weaponSizeScaling: {
      multiplier,
      originalDice: clonePlain(component.dice)
    }
  };
  return scaled;
}

function handlingForDifference(sizeDifference, options) {
  if ( sizeDifference >= 2 ) return options.twoOrMoreLarger;
  if ( sizeDifference === 1 ) return options.oneSizeLarger;
  return WEAPON_SIZE_HANDLING.NORMAL;
}

function codeForHandling(handling) {
  if ( handling === WEAPON_SIZE_HANDLING.UNUSABLE ) return WEAPON_SIZE_CODES.TOO_LARGE;
  if ( handling === WEAPON_SIZE_HANDLING.DISADVANTAGE ) return WEAPON_SIZE_CODES.OVERSIZED_DISADVANTAGE;
  return WEAPON_SIZE_CODES.OK;
}

function reasonCodesForDifference(sizeDifference, handling) {
  if ( handling === WEAPON_SIZE_HANDLING.UNUSABLE ) return [WEAPON_SIZE_REASON_CODES.WEAPON_TOO_LARGE];
  if ( handling === WEAPON_SIZE_HANDLING.DISADVANTAGE ) {
    return [
      WEAPON_SIZE_REASON_CODES.WEAPON_ONE_SIZE_LARGER,
      WEAPON_SIZE_REASON_CODES.OVERSIZED_WEAPON_DISADVANTAGE
    ];
  }
  if ( sizeDifference < 0 ) return [WEAPON_SIZE_REASON_CODES.WEAPON_SMALLER_THAN_WIELDER];
  return [WEAPON_SIZE_REASON_CODES.WEAPON_SIZE_MATCH];
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
