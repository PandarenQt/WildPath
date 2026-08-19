import {
  TARGET_CODES,
  createTargetCandidate,
  createTargetSelectionRequest,
  createTargetSet,
  refineTargetSet,
  resolveTargetEligibility
} from "../helpers/targeting.mjs";

export const TARGET_RESOLVER_CODES = Object.freeze({
  OK: "OK",
  NO_TARGETS: "NO_TARGETS",
  NO_VALID_TARGETS: "NO_VALID_TARGETS",
  TARGETING_FAILED: "TARGETING_FAILED"
});

/* -------------------------------------------- */

export function resolveActionTargets({
  source=null,
  targetSet=null,
  candidates=[],
  targets=[],
  eligibilityPolicy={},
  refinementPolicy={},
  decisions=[],
  context={},
  required=false,
  metadata={}
}={}) {
  const physical = normalizeTargetSet({targetSet, candidates, targets, metadata});
  if ( required && !physical.candidates.length ) {
    return emptyFailure(TARGET_RESOLVER_CODES.NO_TARGETS, physical, "at least one target is required");
  }

  const resolverContext = {
    ...context,
    source: source ? normalizeEntityRef(source) : null
  };
  const eligible = resolveTargetEligibility(physical, eligibilityPolicy, resolverContext);
  const refinement = refineTargetSet({
    targetSet: eligible,
    policy: refinementPolicy,
    decisions,
    context: resolverContext
  });
  if ( !refinement.ok ) {
    return {
      ok: false,
      code: TARGET_RESOLVER_CODES.TARGETING_FAILED,
      targetCode: refinement.code,
      physical,
      eligible,
      refinement,
      targetContexts: refinement.targetContexts,
      selectionRequest: createTargetSelectionRequest({
        targetSet: eligible,
        policy: refinementPolicy,
        decisions,
        context: resolverContext
      })
    };
  }
  if ( required && !refinement.finalTargets.length ) {
    return {
      ok: false,
      code: TARGET_RESOLVER_CODES.NO_VALID_TARGETS,
      targetCode: TARGET_CODES.SELECTION_MINIMUM_NOT_MET,
      physical,
      eligible,
      refinement,
      targetContexts: refinement.targetContexts,
      selectionRequest: createTargetSelectionRequest({
        targetSet: eligible,
        policy: refinementPolicy,
        decisions,
        context: resolverContext
      })
    };
  }

  return {
    ok: true,
    code: TARGET_RESOLVER_CODES.OK,
    targetCode: refinement.code,
    physical,
    eligible,
    refinement,
    targetContexts: refinement.targetContexts,
    selectionRequest: createTargetSelectionRequest({
      targetSet: eligible,
      policy: refinementPolicy,
      decisions,
      context: resolverContext
    })
  };
}

/* -------------------------------------------- */

export function createSelfTargetSet(source, {metadata={}}={}) {
  const target = normalizeEntityRef(source);
  return createTargetSet([createTargetCandidate({
    id: target.id ?? target.tokenId ?? target.actorId,
    target,
    actor: target.actorId ? {id: target.actorId, name: target.name ?? null} : null,
    kind: target.type ?? "creature",
    disposition: target.disposition ?? "self",
    tags: target.tags ?? []
  })], {metadata});
}

/* -------------------------------------------- */

function normalizeTargetSet({targetSet, candidates, targets, metadata}) {
  if ( targetSet ) {
    return createTargetSet(targetSet.candidates ?? [], {
      footprint: targetSet.footprint ?? null,
      metadata: {...(targetSet.metadata ?? {}), ...metadata}
    });
  }
  if ( candidates.length ) return createTargetSet(candidates, {metadata});
  if ( targets.length ) return createTargetSet(targets.map(targetToCandidate), {metadata});
  return createTargetSet([], {metadata});
}

function targetToCandidate(target) {
  const normalized = normalizeEntityRef(target);
  return createTargetCandidate({
    id: normalized.id ?? normalized.tokenId ?? normalized.actorId,
    target: normalized,
    actor: normalized.actorId ? {id: normalized.actorId, name: normalized.name ?? null} : null,
    kind: normalized.type ?? "creature",
    disposition: normalized.disposition ?? "neutral",
    tags: normalized.tags ?? []
  });
}

function emptyFailure(code, physical, reason) {
  const empty = refineTargetSet({targetSet: physical});
  return {
    ok: false,
    code,
    targetCode: null,
    reason,
    physical,
    eligible: physical,
    refinement: empty,
    targetContexts: [],
    selectionRequest: createTargetSelectionRequest({targetSet: physical})
  };
}

function normalizeEntityRef(entity={}) {
  return {
    id: entity.id ?? entity.tokenId ?? entity.actorId ?? entity.uuid ?? null,
    uuid: entity.uuid ?? null,
    actorId: entity.actorId ?? entity.actor?.id ?? null,
    tokenId: entity.tokenId ?? entity.token?.id ?? null,
    name: entity.name ?? entity.actor?.name ?? entity.token?.name ?? null,
    type: entity.type ?? null,
    disposition: entity.disposition ?? null,
    tags: [...new Set((entity.tags ?? []).filter(value => value != null).map(String))]
  };
}
