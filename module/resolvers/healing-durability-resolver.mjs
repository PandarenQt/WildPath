import {
  preferredTargetRef,
  resolveTargetLookupValue,
  targetLabel,
  targetLookupRefs
} from "../helpers/target-actor-refs.mjs";
import {createActorHealingMutationPlan} from "./durability-resolver.mjs";
import {HEALING_RESOLVER_CODES} from "./healing-resolver.mjs";

export const HEALING_DURABILITY_RESOLUTION_CODES = Object.freeze({
  OK: "OK",
  NO_HEALING_RESOLUTION: "NO_HEALING_RESOLUTION",
  HEALING_RESOLUTION_FAILED: "HEALING_RESOLUTION_FAILED",
  TARGET_ACTOR_SYSTEM_NOT_FOUND: "TARGET_ACTOR_SYSTEM_NOT_FOUND",
  DURABILITY_PLANNING_FAILED: "DURABILITY_PLANNING_FAILED"
});

export const HEALING_DURABILITY_MUTATION_TYPES = Object.freeze({
  HEALING: "durabilityHealing"
});

/* -------------------------------------------- */

export function planHealingDurabilityMutations({
  healingResolution=null,
  targetSystems={},
  resourceId="health",
  source=null,
  metadata={}
}={}) {
  if ( !healingResolution ) {
    return healingDurabilityFailure(HEALING_DURABILITY_RESOLUTION_CODES.NO_HEALING_RESOLUTION, {
      reason: "healing resolution is required",
      targetSystems,
      resourceId,
      source,
      metadata
    });
  }
  if ( healingResolution.ok === false ) {
    return healingDurabilityFailure(HEALING_DURABILITY_RESOLUTION_CODES.HEALING_RESOLUTION_FAILED, {
      reason: healingResolution.code,
      targetSystems,
      resourceId,
      source,
      metadata,
      healingResolution
    });
  }

  const mutationPlans = [];
  const failures = [];
  const skipped = [];
  for ( const healingResult of healingResolution.results ?? [] ) {
    if ( healingResult.code === HEALING_RESOLVER_CODES.TARGET_SKIPPED ) {
      skipped.push(clonePlain(healingResult));
      continue;
    }

    const target = healingResult.target ?? {};
    const actorSystem = resolveTargetActorSystem(targetSystems, target, healingResult);
    if ( !actorSystem ) {
      failures.push({
        code: HEALING_DURABILITY_RESOLUTION_CODES.TARGET_ACTOR_SYSTEM_NOT_FOUND,
        reason: `No target Actor system supplied for ${targetLabel(target)}.`,
        target: clonePlain(target),
        targetRefs: targetLookupRefs(target),
        healingResult: clonePlain(healingResult)
      });
      continue;
    }

    const mutationPlan = createActorHealingMutationPlan(actorSystem, {
      healingResult,
      resourceId,
      source,
      target,
      metadata
    });
    if ( !mutationPlan.ok ) {
      failures.push({
        code: HEALING_DURABILITY_RESOLUTION_CODES.DURABILITY_PLANNING_FAILED,
        reason: mutationPlan.reason,
        target: clonePlain(target),
        targetRefs: targetLookupRefs(target),
        mutationPlan
      });
      continue;
    }

    mutationPlans.push({
      type: HEALING_DURABILITY_MUTATION_TYPES.HEALING,
      resolver: "DurabilityResolver",
      targetRef: preferredTargetRef(target),
      target: clonePlain(target),
      plan: mutationPlan
    });
  }

  return {
    ok: failures.length === 0,
    code: failures[0]?.code ?? HEALING_DURABILITY_RESOLUTION_CODES.OK,
    mutationPlans,
    failures,
    skipped,
    resourceId,
    metadata: clonePlain(metadata) ?? {}
  };
}

/* -------------------------------------------- */

function resolveTargetActorSystem(targetSystems, target, healingResult) {
  return resolveTargetLookupValue(targetSystems, target, healingResult, {
    selectValue: entry => entry?.system ?? entry?.actorSystem ?? entry ?? null
  });
}

function healingDurabilityFailure(code, {reason, targetSystems, resourceId, source, metadata, healingResolution=null}) {
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
    healingResolution: healingResolution ? clonePlain(healingResolution) : null,
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
