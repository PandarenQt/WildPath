import {
  createTargetCandidate,
  createTargetSet,
  refineTargetSet,
  resolveTargetEligibility
} from "./targeting.mjs";

export const AREA_TARGETING_CODES = Object.freeze({
  OK: "OK",
  NO_FOOTPRINT: "NO_FOOTPRINT"
});

/* -------------------------------------------- */

/**
 * Convert a precomputed tactical GridFootprint plus token footprints into physical target
 * candidates. This does not calculate area geometry; it only adapts the geometry engine's field
 * membership into the generic target pipeline.
 * @param {object} options
 * @param {object} options.footprint
 * @param {object[]} [options.tokenFootprints]
 * @param {object} [options.metadata]
 * @returns {object}
 */
export function resolveAreaTargetCandidates({footprint, tokenFootprints=[], metadata={}}={}) {
  const footprintFields = normalizeFields(footprint?.fields ?? footprint?.fieldIds ?? []);
  if ( !footprintFields.length ) {
    return {
      ok: false,
      code: AREA_TARGETING_CODES.NO_FOOTPRINT,
      footprint: footprint ?? null,
      candidates: [],
      targetSet: createTargetSet([], {footprint: footprint ?? null, metadata})
    };
  }

  const footprintKeys = new Set(footprintFields.map(fieldKey));
  const candidates = [];

  for ( const tokenFootprint of tokenFootprints ) {
    const occupiedFields = normalizeFields(tokenFootprint.occupiedFields ?? tokenFootprint.fields ?? []);
    const intersectingFields = occupiedFields.filter(field => footprintKeys.has(fieldKey(field)));
    if ( !intersectingFields.length ) continue;
    candidates.push(createTargetCandidate({
      ...tokenFootprint,
      id: tokenFootprint.id ?? tokenFootprint.target?.id,
      target: tokenFootprint.target ?? {id: tokenFootprint.id},
      occupiedFields,
      intersectingFields
    }));
  }

  return {
    ok: true,
    code: AREA_TARGETING_CODES.OK,
    footprint,
    candidates,
    targetSet: createTargetSet(candidates, {footprint, metadata})
  };
}

/* -------------------------------------------- */

/**
 * Run the target pipeline from already-computed area footprint to final target contexts.
 * @param {object} options
 * @returns {object}
 */
export function resolveAreaTargetSet({
  footprint,
  tokenFootprints=[],
  eligibilityPolicy={},
  refinementPolicy={},
  decisions=[],
  context={},
  metadata={}
}={}) {
  const physical = resolveAreaTargetCandidates({footprint, tokenFootprints, metadata});
  const eligible = resolveTargetEligibility(physical.targetSet, eligibilityPolicy, context);
  const refinement = refineTargetSet({
    targetSet: eligible,
    policy: refinementPolicy,
    decisions,
    context
  });

  return {
    ok: physical.ok && refinement.ok,
    code: !physical.ok ? physical.code : refinement.code,
    footprint: physical.footprint,
    physical,
    eligible,
    refinement,
    targetContexts: refinement.targetContexts
  };
}

/* -------------------------------------------- */

function normalizeFields(fields) {
  return fields.map(field => typeof field === "string" ? {id: field} : {...field});
}

function fieldKey(value) {
  if ( typeof value === "string" ) return value;
  return value?.id ?? `${value?.q ?? value?.x ?? 0},${value?.r ?? value?.y ?? 0},${value?.s ?? ""}`;
}
