import {
  preferredTargetRef,
  resolveTargetLookupValue,
  targetLabel,
  targetLookupRefs
} from "../helpers/target-actor-refs.mjs";
import {
  adjustDamageResult,
  mergeDamageAdjustmentProfiles
} from "./damage-adjustment-resolver.mjs";
import {DAMAGE_RESOLVER_CODES} from "./damage-resolver.mjs";
import {createActorDamageMutationPlan} from "./durability-resolver.mjs";

export const DAMAGE_DURABILITY_RESOLUTION_CODES = Object.freeze({
  OK: "OK",
  NO_DAMAGE_RESOLUTION: "NO_DAMAGE_RESOLUTION",
  DAMAGE_RESOLUTION_FAILED: "DAMAGE_RESOLUTION_FAILED",
  DAMAGE_ADJUSTMENT_FAILED: "DAMAGE_ADJUSTMENT_FAILED",
  TARGET_ACTOR_SYSTEM_NOT_FOUND: "TARGET_ACTOR_SYSTEM_NOT_FOUND",
  DURABILITY_PLANNING_FAILED: "DURABILITY_PLANNING_FAILED"
});

export const DAMAGE_DURABILITY_MUTATION_TYPES = Object.freeze({
  DAMAGE: "durabilityDamage"
});

/* -------------------------------------------- */

export function planDamageDurabilityMutations({
  damageResolution=null,
  targetSystems={},
  adjustments=null,
  adjustmentProfiles={},
  resourceId="health",
  source=null,
  metadata={}
}={}) {
  if ( !damageResolution ) {
    return damageDurabilityFailure(DAMAGE_DURABILITY_RESOLUTION_CODES.NO_DAMAGE_RESOLUTION, {
      reason: "damage resolution is required",
      targetSystems,
      resourceId,
      source,
      metadata
    });
  }
  if ( damageResolution.ok === false ) {
    return damageDurabilityFailure(DAMAGE_DURABILITY_RESOLUTION_CODES.DAMAGE_RESOLUTION_FAILED, {
      reason: damageResolution.code,
      targetSystems,
      resourceId,
      source,
      metadata,
      damageResolution
    });
  }

  const mutationPlans = [];
  const failures = [];
  const skipped = [];
  for ( const damageResult of damageResolution.results ?? [] ) {
    if ( damageResult.code === DAMAGE_RESOLVER_CODES.TARGET_SKIPPED ) {
      skipped.push(clonePlain(damageResult));
      continue;
    }

    const target = damageResult.target ?? {};
    const adjusted = adjustDamageForTarget({
      damageResult,
      target,
      adjustments,
      adjustmentProfiles
    });
    if ( !adjusted.ok ) {
      failures.push({
        code: DAMAGE_DURABILITY_RESOLUTION_CODES.DAMAGE_ADJUSTMENT_FAILED,
        reason: adjusted.code,
        target: clonePlain(target),
        targetRefs: targetLookupRefs(target),
        failures: adjusted.failures
      });
      continue;
    }

    const actorSystem = resolveTargetActorSystem(targetSystems, target, damageResult);
    if ( !actorSystem ) {
      failures.push({
        code: DAMAGE_DURABILITY_RESOLUTION_CODES.TARGET_ACTOR_SYSTEM_NOT_FOUND,
        reason: `No target Actor system supplied for ${targetLabel(target)}.`,
        target: clonePlain(target),
        targetRefs: targetLookupRefs(target),
        damageResult: clonePlain(damageResult)
      });
      continue;
    }

    const mutationPlan = createActorDamageMutationPlan(actorSystem, {
      damageResult: adjusted.damageResult,
      resourceId,
      source,
      target,
      metadata: {
        originalDamageResult: clonePlain(damageResult),
        damageAdjustments: adjusted.applications,
        ...metadata
      }
    });
    if ( !mutationPlan.ok ) {
      failures.push({
        code: DAMAGE_DURABILITY_RESOLUTION_CODES.DURABILITY_PLANNING_FAILED,
        reason: mutationPlan.reason,
        target: clonePlain(target),
        targetRefs: targetLookupRefs(target),
        mutationPlan
      });
      continue;
    }

    mutationPlans.push({
      type: DAMAGE_DURABILITY_MUTATION_TYPES.DAMAGE,
      resolver: "DurabilityResolver",
      targetRef: preferredTargetRef(target),
      target: clonePlain(target),
      plan: mutationPlan
    });
  }

  return {
    ok: failures.length === 0,
    code: failures[0]?.code ?? DAMAGE_DURABILITY_RESOLUTION_CODES.OK,
    mutationPlans,
    failures,
    skipped,
    resourceId,
    metadata: clonePlain(metadata) ?? {}
  };
}

/* -------------------------------------------- */

function resolveTargetActorSystem(targetSystems, target, damageResult) {
  return resolveTargetLookupValue(targetSystems, target, damageResult, {
    selectValue: entry => entry?.system ?? entry?.actorSystem ?? entry ?? null
  });
}

function adjustDamageForTarget({damageResult, target, adjustments, adjustmentProfiles}) {
  const targetProfile = resolveTargetLookupValue(adjustmentProfiles, target, damageResult) ?? null;
  const profile = mergeDamageAdjustmentProfiles(adjustments, targetProfile);
  return adjustDamageResult(damageResult, profile);
}

function damageDurabilityFailure(code, {reason, targetSystems, resourceId, source, metadata, damageResolution=null}) {
  return {
    ok: false,
    code,
    mutationPlans: [],
    failures: [{
      code,
      reason,
      resourceId,
      source: source ? clonePlain(source) : null,
      metadata: clonePlain(metadata) ?? {}
    }],
    skipped: [],
    resourceId,
    damageResolution: damageResolution ? clonePlain(damageResolution) : null,
    metadata: {
      targetSystemCount: targetSystemCount(targetSystems),
      ...(clonePlain(metadata) ?? {})
    }
  };
}

function targetSystemCount(targetSystems) {
  if ( targetSystems instanceof Map || Array.isArray(targetSystems) ) return targetSystems.size ?? targetSystems.length;
  if ( targetSystems && typeof targetSystems === "object" ) return Object.keys(targetSystems).length;
  return typeof targetSystems === "function" ? null : 0;
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
