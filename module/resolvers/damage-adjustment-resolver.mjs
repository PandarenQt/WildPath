export const DAMAGE_ADJUSTMENT_CODES = Object.freeze({
  OK: "OK",
  INVALID_DAMAGE_RESULT: "INVALID_DAMAGE_RESULT",
  INVALID_REDUCTION: "INVALID_REDUCTION",
  INVALID_ABSORPTION: "INVALID_ABSORPTION"
});

export const DAMAGE_ADJUSTMENT_KINDS = Object.freeze({
  IMMUNITY: "immunity",
  RESISTANCE: "resistance",
  VULNERABILITY: "vulnerability",
  ABSORPTION: "absorption",
  REDUCTION: "reduction",
  THRESHOLD: "threshold"
});

export const DAMAGE_REDUCTION_TYPES = Object.freeze({
  FLAT: "flat",
  SCALED: "scaled",
  ROLLED: "rolled"
});

export const DAMAGE_ABSORPTION_TYPES = DAMAGE_REDUCTION_TYPES;

/* -------------------------------------------- */

export function adjustDamageResult(damageResult, profile={}) {
  if ( !damageResult || typeof damageResult !== "object" || !Array.isArray(damageResult.components) ) {
    return {
      ok: false,
      code: DAMAGE_ADJUSTMENT_CODES.INVALID_DAMAGE_RESULT,
      damageResult: clonePlain(damageResult),
      failures: [{code: DAMAGE_ADJUSTMENT_CODES.INVALID_DAMAGE_RESULT, reason: "damage result with components is required"}],
      applications: []
    };
  }

  const normalizedProfile = normalizeDamageAdjustmentProfile(profile);
  const failures = [
    ...normalizedProfile.reductions
      .filter(reduction => !isValidReduction(reduction))
      .map(reduction => ({
        code: DAMAGE_ADJUSTMENT_CODES.INVALID_REDUCTION,
        reason: `damage reduction ${reduction.id ?? reduction.type} requires a finite non-negative amount or scale`,
        reduction
      })),
    ...normalizedProfile.absorptions
      .filter(absorption => !isValidAbsorption(absorption))
      .map(absorption => ({
        code: DAMAGE_ADJUSTMENT_CODES.INVALID_ABSORPTION,
        reason: `damage absorption ${absorption.id ?? absorption.type} requires a finite non-negative amount or scale`,
        absorption
      }))
  ];
  if ( failures.length ) {
    return {
      ok: false,
      code: failures[0].code,
      damageResult: clonePlain(damageResult),
      failures,
      applications: []
    };
  }

  const originalComponents = damageResult.components.map(component => normalizeDamageComponentForAdjustment(component));
  const typed = applyTypedAdjustments(originalComponents, normalizedProfile);
  const absorbed = applyAbsorptions(typed.components, normalizedProfile);
  const reduced = applyReductions(absorbed.components, normalizedProfile);
  const held = applyDamageThreshold(reduced.components, normalizedProfile);
  const adjustedComponents = held.components.map(component => ({
    ...component,
    metadata: {
      ...(component.metadata ?? {}),
      damageAdjustments: component.adjustments
    }
  })).map(({adjustments, ...component}) => component);
  const originalTotal = originalComponents.reduce((sum, component) => sum + component.amount, 0);
  const adjustedTotal = adjustedComponents.reduce((sum, component) => sum + component.amount, 0);
  const applications = [...typed.applications, ...absorbed.applications, ...reduced.applications, ...held.applications];

  return {
    ok: true,
    code: DAMAGE_ADJUSTMENT_CODES.OK,
    damageResult: {
      ...clonePlain(damageResult),
      components: adjustedComponents,
      total: adjustedTotal,
      byDamageType: groupByDamageType(adjustedComponents),
      originalTotal,
      adjustments: {
        profileId: normalizedProfile.id,
        originalTotal,
        adjustedTotal,
        absorptionResults: absorbed.absorptionResults,
        applications
      }
    },
    absorptionResults: absorbed.absorptionResults,
    applications,
    failures: []
  };
}

/* -------------------------------------------- */

export function normalizeDamageAdjustmentProfile(profile={}) {
  return {
    id: profile.id ?? null,
    rounding: profile.rounding ?? "floor",
    immunities: normalizeTypedAdjustments(profile.immunities ?? profile.immune, {
      kind: DAMAGE_ADJUSTMENT_KINDS.IMMUNITY,
      multiplier: 0
    }),
    resistances: normalizeTypedAdjustments(profile.resistances ?? profile.resistant, {
      kind: DAMAGE_ADJUSTMENT_KINDS.RESISTANCE,
      multiplier: 0.5
    }),
    vulnerabilities: normalizeTypedAdjustments(profile.vulnerabilities ?? profile.vulnerable, {
      kind: DAMAGE_ADJUSTMENT_KINDS.VULNERABILITY,
      multiplier: 2
    }),
    absorptions: normalizeAbsorptions(profile.absorptions ?? profile.damageAbsorptions ?? profile.absorption),
    reductions: normalizeReductions(profile.reductions ?? profile.damageReductions ?? profile.reduction),
    // Damage types whose Resistance the damage ignores (its attacker's: Boon of Irresistible Offense).
    ignoresResistance: [...new Set((profile.ignoresResistance ?? []).map(String))],
    // A vehicle's or object's Damage Threshold (DMG 2024): less damage than this from one source is superficial.
    damageThreshold: Math.max(0, finiteNumber(profile.damageThreshold) ?? 0),
    metadata: clonePlain(profile.metadata ?? {}) ?? {}
  };
}

export function mergeDamageAdjustmentProfiles(...profiles) {
  const normalized = profiles.filter(Boolean).map(normalizeDamageAdjustmentProfile);
  if ( !normalized.length ) return normalizeDamageAdjustmentProfile();
  return {
    id: normalized.map(profile => profile.id).filter(Boolean).join("+") || null,
    rounding: normalized.at(-1)?.rounding ?? "floor",
    immunities: normalized.flatMap(profile => profile.immunities),
    resistances: normalized.flatMap(profile => profile.resistances),
    vulnerabilities: normalized.flatMap(profile => profile.vulnerabilities),
    absorptions: normalized.flatMap(profile => profile.absorptions),
    reductions: normalized.flatMap(profile => profile.reductions),
    ignoresResistance: [...new Set(normalized.flatMap(profile => profile.ignoresResistance))],
    damageThreshold: Math.max(...normalized.map(profile => profile.damageThreshold)),
    metadata: Object.assign({}, ...normalized.map(profile => profile.metadata ?? {}))
  };
}

/* -------------------------------------------- */

function applyTypedAdjustmentsToComponent(component, profile) {
  const applications = [];
  // Damage that ignores Immunity, or Resistance, to its type (Overchannel's backlash: `ignoreImmunity`, `ignoreResistance`).
  const immunities = component.ignoreImmunity ? [] : profile.immunities.filter(adjustment => matchesComponent(component, adjustment));
  if ( immunities.length ) {
    const adjusted = adjustedComponent(component, 0, [{
      kind: DAMAGE_ADJUSTMENT_KINDS.IMMUNITY,
      ids: immunities.map(adjustment => adjustment.id).filter(Boolean),
      damageType: component.damageType,
      originalAmount: component.amount,
      adjustedAmount: 0
    }]);
    applications.push(...adjusted.adjustments);
    return {component: adjusted, applications};
  }

  // Damage that ignores Resistance outright (`ignoreResistance`: Overchannel's backlash) skips every Resistance to it.
  // Its attacker's damage of a type it ignores Resistance to (Boon of Irresistible Offense) skips only the Resistance that
  // names that type; a halving of every type (Uncanny Dodge's) is not that Resistance and still applies.
  const ignored = adjustment => component.ignoreResistance || (profile.ignoresResistance.includes(component.damageType)
    && (adjustment.damageTypes ?? []).includes(component.damageType));
  const resistances = profile.resistances.filter(adjustment => matchesComponent(component, adjustment) && !ignored(adjustment));
  const vulnerabilities = profile.vulnerabilities.filter(adjustment => matchesComponent(component, adjustment));
  const multipliers = [...resistances, ...vulnerabilities];
  if ( !multipliers.length ) return {component, applications};

  // 2024: several Resistances (or Vulnerabilities) to the same damage count as one: a Tiefling's legacy and its species
  // trait halve it once, not to a quarter. The strongest of each applies.
  const multiplier = (resistances.length ? Math.min(...resistances.map(adjustment => adjustment.multiplier)) : 1)
    * (vulnerabilities.length ? Math.max(...vulnerabilities.map(adjustment => adjustment.multiplier)) : 1);
  const adjustedAmount = roundAmount(component.amount * multiplier, profile.rounding);
  const adjusted = adjustedComponent(component, adjustedAmount, [{
    kind: "multiplier",
    ids: multipliers.map(adjustment => adjustment.id).filter(Boolean),
    damageType: component.damageType,
    multiplier,
    originalAmount: component.amount,
    adjustedAmount
  }]);
  applications.push(...adjusted.adjustments);
  return {component: adjusted, applications};
}

function applyTypedAdjustmentsToComponents(components, profile) {
  const adjustedComponents = [];
  const applications = [];
  for ( const component of components ) {
    const adjusted = applyTypedAdjustmentsToComponent(component, profile);
    adjustedComponents.push(adjusted.component);
    applications.push(...adjusted.applications);
  }
  return {components: adjustedComponents, applications};
}

function applyAbsorptions(components, profile) {
  let adjustedComponents = components.map(component => ({...component, adjustments: [...(component.adjustments ?? [])]}));
  const applications = [];
  const absorptionResults = [];
  for ( const absorption of profile.absorptions ) {
    const matchingTotal = adjustedComponents
      .filter(component => matchesComponent(component, absorption))
      .reduce((sum, component) => sum + component.amount, 0);
    const absorptionAmount = absorptionAmountFor(absorption, matchingTotal, profile.rounding);
    if ( absorptionAmount <= 0 || matchingTotal <= 0 ) {
      const result = {
        kind: DAMAGE_ADJUSTMENT_KINDS.ABSORPTION,
        id: absorption.id,
        absorptionType: absorption.type,
        resourceId: absorption.resourceId,
        requestedAmount: absorptionAmount,
        absorbedAmount: 0,
        remainingAmount: absorptionAmount,
        metadata: clonePlain(absorption.metadata) ?? {}
      };
      applications.push(result);
      absorptionResults.push(result);
      continue;
    }

    let remaining = absorptionAmount;
    let absorbedAmount = 0;
    adjustedComponents = adjustedComponents.map(component => {
      if ( remaining <= 0 || !matchesComponent(component, absorption) || component.amount <= 0 ) return component;
      const absorbed = Math.min(component.amount, remaining);
      remaining -= absorbed;
      absorbedAmount += absorbed;
      return adjustedComponent(component, component.amount - absorbed, [{
        kind: DAMAGE_ADJUSTMENT_KINDS.ABSORPTION,
        id: absorption.id,
        absorptionType: absorption.type,
        resourceId: absorption.resourceId,
        requestedAmount: absorptionAmount,
        absorbedAmount: absorbed,
        remainingAmount: remaining,
        metadata: clonePlain(absorption.metadata) ?? {}
      }]);
    });
    const result = {
      kind: DAMAGE_ADJUSTMENT_KINDS.ABSORPTION,
      id: absorption.id,
      absorptionType: absorption.type,
      resourceId: absorption.resourceId,
      requestedAmount: absorptionAmount,
      absorbedAmount,
      remainingAmount: remaining,
      metadata: clonePlain(absorption.metadata) ?? {}
    };
    applications.push(result);
    absorptionResults.push(result);
  }

  return {components: adjustedComponents, applications, absorptionResults};
}

function applyReductions(components, profile) {
  let adjustedComponents = components.map(component => ({...component, adjustments: [...(component.adjustments ?? [])]}));
  const applications = [];
  for ( const reduction of profile.reductions ) {
    const matchingTotal = adjustedComponents
      .filter(component => matchesComponent(component, reduction))
      .reduce((sum, component) => sum + component.amount, 0);
    const reductionAmount = reductionAmountFor(reduction, matchingTotal, profile.rounding);
    if ( reductionAmount <= 0 || matchingTotal <= 0 ) {
      applications.push({
        kind: DAMAGE_ADJUSTMENT_KINDS.REDUCTION,
        id: reduction.id,
        reductionType: reduction.type,
        requestedAmount: reductionAmount,
        appliedAmount: 0,
        remainingAmount: reductionAmount
      });
      continue;
    }

    let remaining = reductionAmount;
    let appliedAmount = 0;
    adjustedComponents = adjustedComponents.map(component => {
      if ( remaining <= 0 || !matchesComponent(component, reduction) || component.amount <= 0 ) return component;
      const applied = Math.min(component.amount, remaining);
      remaining -= applied;
      appliedAmount += applied;
      return adjustedComponent(component, component.amount - applied, [{
        kind: DAMAGE_ADJUSTMENT_KINDS.REDUCTION,
        id: reduction.id,
        reductionType: reduction.type,
        requestedAmount: reductionAmount,
        appliedAmount: applied,
        remainingAmount: remaining
      }]);
    });
    applications.push({
      kind: DAMAGE_ADJUSTMENT_KINDS.REDUCTION,
      id: reduction.id,
      reductionType: reduction.type,
      requestedAmount: reductionAmount,
      appliedAmount,
      remainingAmount: remaining
    });
  }

  return {components: adjustedComponents, applications};
}

/**
 * DMG 2024 Damage Threshold: "immunity to all damage unless it takes an amount of damage from a single attack or effect
 * equal to or greater than its damage threshold, in which case it takes damage as normal". The single source is this
 * damage result, after its other adjustments.
 */
function applyDamageThreshold(components, profile) {
  const threshold = profile.damageThreshold;
  const total = components.reduce((sum, component) => sum + component.amount, 0);
  if ( !(threshold > 0) || !(total > 0) || (total >= threshold) ) return {components, applications: []};
  return {components: components.map(component => adjustedComponent(component, 0, [{kind: DAMAGE_ADJUSTMENT_KINDS.THRESHOLD,
    threshold, before: component.amount}])),
    applications: [{kind: DAMAGE_ADJUSTMENT_KINDS.THRESHOLD, threshold, prevented: total}]};
}

function applyTypedAdjustments(components, profile) {
  return applyTypedAdjustmentsToComponents(components, profile);
}

function adjustedComponent(component, amount, adjustments) {
  return {
    ...component,
    amount,
    adjustments: [...(component.adjustments ?? []), ...adjustments]
  };
}

function reductionAmountFor(reduction, matchingTotal, rounding) {
  switch ( reduction.type ) {
    case DAMAGE_REDUCTION_TYPES.SCALED:
      return roundAmount(matchingTotal * reduction.scale, reduction.rounding ?? rounding);
    case DAMAGE_REDUCTION_TYPES.ROLLED:
    case DAMAGE_REDUCTION_TYPES.FLAT:
    default:
      return reduction.amount;
  }
}

function absorptionAmountFor(absorption, matchingTotal, rounding) {
  switch ( absorption.type ) {
    case DAMAGE_ABSORPTION_TYPES.SCALED:
      return roundAmount(matchingTotal * absorption.scale, absorption.rounding ?? rounding);
    case DAMAGE_ABSORPTION_TYPES.ROLLED:
    case DAMAGE_ABSORPTION_TYPES.FLAT:
    default:
      return absorption.amount;
  }
}

function isValidReduction(reduction) {
  if ( reduction.type === DAMAGE_REDUCTION_TYPES.SCALED ) return finiteNumber(reduction.scale) != null && reduction.scale >= 0;
  return finiteNumber(reduction.amount) != null && reduction.amount >= 0;
}

function isValidAbsorption(absorption) {
  if ( absorption.type === DAMAGE_ABSORPTION_TYPES.SCALED ) return finiteNumber(absorption.scale) != null && absorption.scale >= 0;
  return finiteNumber(absorption.amount) != null && absorption.amount >= 0;
}

function matchesComponent(component, adjustment) {
  const damageTypes = adjustment.damageTypes ?? [];
  const tags = adjustment.tags ?? [];
  if ( !damageTypes.length && !tags.length ) return true;
  return damageTypes.includes(component.damageType) || tags.some(tag => (component.tags ?? []).includes(tag));
}

function normalizeTypedAdjustments(value, defaults) {
  return normalizeAdjustmentEntries(value).map((entry, index) => {
    const data = typeof entry === "string" ? {damageTypes: [entry]} : entry;
    return {
      id: data.id ?? `${defaults.kind}:${index}`,
      kind: defaults.kind,
      damageTypes: uniqueStrings(data.damageTypes ?? data.types ?? data.type ?? data.damageType),
      tags: uniqueStrings(data.tags ?? []),
      multiplier: finiteNumber(data.multiplier ?? data.amountMultiplier) ?? defaults.multiplier,
      metadata: clonePlain(data.metadata ?? {}) ?? {}
    };
  });
}

function normalizeReductions(value) {
  return normalizeAdjustmentEntries(value).map((entry, index) => {
    if ( typeof entry === "number" ) {
      return {
        id: `reduction:${index}`,
        type: DAMAGE_REDUCTION_TYPES.FLAT,
        amount: entry,
        scale: null,
        damageTypes: [],
        tags: [],
        metadata: {}
      };
    }

    const type = normalizeReductionType(entry.type, entry);
    return {
      id: entry.id ?? `reduction:${index}`,
      type,
      amount: finiteNumber(entry.amount ?? entry.value ?? entry.flat ?? entry.rolled ?? entry.roll),
      scale: finiteNumber(entry.scale ?? entry.multiplier ?? entry.percent ?? entry.percentage),
      formula: entry.formula ?? entry.dice?.formula ?? null,
      damageTypes: uniqueStrings(entry.damageTypes ?? entry.types ?? entry.damageType),
      tags: uniqueStrings(entry.tags ?? []),
      rounding: entry.rounding ?? null,
      metadata: clonePlain(entry.metadata ?? {}) ?? {}
    };
  });
}

function normalizeAbsorptions(value) {
  return normalizeAdjustmentEntries(value).map((entry, index) => {
    if ( typeof entry === "number" ) {
      return {
        id: `absorption:${index}`,
        type: DAMAGE_ABSORPTION_TYPES.FLAT,
        amount: entry,
        scale: null,
        resourceId: "health",
        damageTypes: [],
        tags: [],
        metadata: {}
      };
    }

    const type = normalizeAbsorptionType(entry.type, entry);
    return {
      id: entry.id ?? `absorption:${index}`,
      type,
      amount: finiteNumber(entry.amount ?? entry.value ?? entry.flat ?? entry.rolled ?? entry.roll),
      scale: finiteNumber(entry.scale ?? entry.multiplier ?? entry.percent ?? entry.percentage),
      formula: entry.formula ?? entry.dice?.formula ?? null,
      resourceId: String(entry.resourceId ?? entry.resource ?? entry.targetResourceId ?? "health"),
      damageTypes: uniqueStrings(entry.damageTypes ?? entry.types ?? entry.damageType),
      tags: uniqueStrings(entry.tags ?? []),
      rounding: entry.rounding ?? null,
      metadata: clonePlain(entry.metadata ?? {}) ?? {}
    };
  });
}

function normalizeReductionType(type, entry) {
  const normalized = String(type ?? "").toLowerCase();
  if ( Object.values(DAMAGE_REDUCTION_TYPES).includes(normalized) ) return normalized;
  if ( entry.scale != null || entry.percent != null || entry.percentage != null ) return DAMAGE_REDUCTION_TYPES.SCALED;
  if ( entry.rolled != null || entry.roll != null || entry.formula != null || entry.dice ) return DAMAGE_REDUCTION_TYPES.ROLLED;
  return DAMAGE_REDUCTION_TYPES.FLAT;
}

function normalizeAbsorptionType(type, entry) {
  const normalized = String(type ?? "").toLowerCase();
  if ( Object.values(DAMAGE_ABSORPTION_TYPES).includes(normalized) ) return normalized;
  if ( entry.scale != null || entry.percent != null || entry.percentage != null ) return DAMAGE_ABSORPTION_TYPES.SCALED;
  if ( entry.rolled != null || entry.roll != null || entry.formula != null || entry.dice ) return DAMAGE_ABSORPTION_TYPES.ROLLED;
  return DAMAGE_ABSORPTION_TYPES.FLAT;
}

function normalizeAdjustmentEntries(value) {
  if ( value == null || value === false ) return [];
  if ( Array.isArray(value) ) return value.flatMap(normalizeAdjustmentEntries);
  if ( typeof value === "string" || typeof value === "number" ) return [value];
  if ( typeof value !== "object" ) return [];
  if ( isSingleAdjustmentObject(value) ) return [value];
  return Object.entries(value)
    .filter(([, entry]) => entry !== false && entry != null)
    .map(([damageType, entry]) => typeof entry === "object"
      ? {damageTypes: [damageType], ...entry}
      : {damageTypes: [damageType]});
}

function isSingleAdjustmentObject(value) {
  return ["id", "damageType", "damageTypes", "types", "tags", "amount", "value", "flat", "scale", "rolled", "roll", "formula", "dice", "multiplier", "type", "resourceId", "resource", "targetResourceId"]
    .some(key => Object.hasOwn(value, key));
}

function normalizeDamageComponentForAdjustment(component={}) {
  return {
    ...clonePlain(component),
    amount: Math.max(finiteNumber(component.amount ?? component.total ?? component.value) ?? 0, 0),
    damageType: String(component.damageType ?? component.type ?? "untyped"),
    tags: uniqueStrings(component.tags ?? []),
    metadata: clonePlain(component.metadata ?? {}) ?? {},
    adjustments: []
  };
}

function groupByDamageType(components) {
  const groups = {};
  for ( const component of components ) {
    groups[component.damageType] = (groups[component.damageType] ?? 0) + component.amount;
  }
  return groups;
}

function roundAmount(value, rounding) {
  switch ( rounding ) {
    case "ceil": return Math.ceil(value);
    case "round": return Math.round(value);
    case "none": return value;
    case "floor":
    default: return Math.floor(value);
  }
}

function uniqueStrings(values) {
  const array = Array.isArray(values) ? values : values == null ? [] : [values];
  return [...new Set(array.filter(value => value != null && value !== "").map(String))];
}

function finiteNumber(value) {
  if ( value == null || value === "" ) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
