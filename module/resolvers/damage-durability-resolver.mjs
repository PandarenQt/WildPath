import {
  actorRef,
  normalizeEntityRef,
  tokenRef,
  uuidRef
} from "../helpers/entity-refs.mjs";
import {DAMAGE_RESOLVER_CODES} from "./damage-resolver.mjs";
import {createActorDamageMutationPlan} from "./durability-resolver.mjs";

export const DAMAGE_DURABILITY_RESOLUTION_CODES = Object.freeze({
  OK: "OK",
  NO_DAMAGE_RESOLUTION: "NO_DAMAGE_RESOLUTION",
  DAMAGE_RESOLUTION_FAILED: "DAMAGE_RESOLUTION_FAILED",
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
      damageResult,
      resourceId,
      source,
      target,
      metadata
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
  if ( typeof targetSystems === "function" ) {
    return targetSystems({target: clonePlain(target), damageResult: clonePlain(damageResult)}) ?? null;
  }

  const refs = targetLookupRefs(target);
  if ( targetSystems instanceof Map ) {
    return refs.map(ref => targetSystems.get(ref)).find(Boolean) ?? null;
  }

  if ( Array.isArray(targetSystems) ) {
    return resolveTargetActorSystemFromArray(targetSystems, refs);
  }

  if ( targetSystems && typeof targetSystems === "object" ) {
    return refs.map(ref => targetSystems[ref]).find(Boolean) ?? null;
  }

  return null;
}

function resolveTargetActorSystemFromArray(entries, refs) {
  for ( const entry of entries ) {
    const entryRefs = targetLookupRefs(entry);
    if ( refs.some(ref => entryRefs.includes(ref)) ) return entry.system ?? entry.actorSystem ?? entry;
  }
  return null;
}

function targetLookupRefs(target={}) {
  return uniqueStrings([
    normalizeEntityRef(target),
    target.ref,
    target.uuid ? uuidRef(target.uuid) : null,
    target.uuid,
    target.actorId ? actorRef(target.actorId) : null,
    target.actorId,
    target.tokenId ? tokenRef(target.tokenId, {sceneId: target.sceneId}) : null,
    target.tokenId,
    target.id
  ]);
}

function preferredTargetRef(target={}) {
  return normalizeEntityRef(target) ?? target.ref ?? target.actorId ?? target.tokenId ?? target.uuid ?? target.id ?? null;
}

function targetLabel(target={}) {
  return preferredTargetRef(target) ?? target.name ?? "target";
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

function uniqueStrings(values) {
  return [...new Set(values.filter(value => value != null && value !== "").map(String))];
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
