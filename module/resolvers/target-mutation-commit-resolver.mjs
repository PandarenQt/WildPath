import {resolveTargetLookupValue, targetLookupRefs} from "../helpers/target-actor-refs.mjs";
import {createActorUpdateTransactionOperation} from "./resolution-transaction-resolver.mjs";
import {commitActorDurabilityMutationPlan} from "./durability-resolver.mjs";

export const TARGET_MUTATION_COMMIT_CODES = Object.freeze({
  OK: "OK",
  NO_MUTATION_PLANS: "NO_MUTATION_PLANS",
  TARGET_ACTOR_NOT_FOUND: "TARGET_ACTOR_NOT_FOUND",
  COMMIT_NOT_AUTHORIZED: "COMMIT_NOT_AUTHORIZED",
  COMMIT_FAILED: "COMMIT_FAILED"
});

/* -------------------------------------------- */

export function prepareTargetMutationCommitOperations({
  mutationPlans=[],
  targetActors={},
  authority=null,
  commitPlan=defaultCommitPlan,
  metadata={}
}={}) {
  if ( !mutationPlans.length ) {
    return {
      ok: true,
      code: TARGET_MUTATION_COMMIT_CODES.NO_MUTATION_PLANS,
      operations: [],
      failures: [],
      metadata: clonePlain(metadata) ?? {}
    };
  }

  const operations = [];
  const failures = [];
  for ( const [index, mutationPlan] of mutationPlans.entries() ) {
    const target = mutationPlan.target ?? mutationPlan.plan?.target ?? {};
    const actor = resolveTargetActor(targetActors, target, mutationPlan);
    if ( !actor ) {
      failures.push({
        code: TARGET_MUTATION_COMMIT_CODES.TARGET_ACTOR_NOT_FOUND,
        reason: "No target Actor supplied for mutation plan.",
        mutationPlan: clonePlain(mutationPlan),
        targetRefs: targetLookupRefs(target)
      });
      break;
    }

    const authorization = evaluateCommitAuthority(authority, {mutationPlan, target, actor});
    if ( !authorization.ok ) {
      failures.push({
        code: TARGET_MUTATION_COMMIT_CODES.COMMIT_NOT_AUTHORIZED,
        reason: authorization.reason,
        mutationPlan: clonePlain(mutationPlan),
        targetRefs: targetLookupRefs(target),
        authority: authorization.authority
      });
      break;
    }

    operations.push(createActorUpdateTransactionOperation({
      id: `target:${index}:${mutationPlan.type}`,
      type: mutationPlan.type,
      actorRef: mutationPlan.targetRef ?? targetLookupRefs(target)[0] ?? null,
      actor,
      mutationPlan: mutationPlan.plan,
      metadata: {
        ...(clonePlain(metadata) ?? {}),
        role: "targetMutation",
        target: clonePlain(target),
        targetRefs: targetLookupRefs(target),
        mutationPlan: clonePlain(mutationPlan)
      },
      commit: () => commitPlan(actor, mutationPlan.plan, mutationPlan)
    }));
  }

  return {
    ok: failures.length === 0,
    code: failures[0]?.code ?? TARGET_MUTATION_COMMIT_CODES.OK,
    operations: failures.length ? [] : operations,
    failures,
    metadata: clonePlain(metadata) ?? {}
  };
}

/* -------------------------------------------- */

export async function commitTargetMutationPlans({
  mutationPlans=[],
  targetActors={},
  authority=null,
  commitPlan=defaultCommitPlan,
  metadata={}
}={}) {
  if ( !mutationPlans.length ) {
    return {
      ok: true,
      code: TARGET_MUTATION_COMMIT_CODES.NO_MUTATION_PLANS,
      committed: [],
      failures: [],
      metadata: clonePlain(metadata) ?? {}
    };
  }

  const committed = [];
  const failures = [];
  for ( const mutationPlan of mutationPlans ) {
    const target = mutationPlan.target ?? mutationPlan.plan?.target ?? {};
    const actor = resolveTargetActor(targetActors, target, mutationPlan);
    if ( !actor ) {
      failures.push({
        code: TARGET_MUTATION_COMMIT_CODES.TARGET_ACTOR_NOT_FOUND,
        reason: "No target Actor supplied for mutation plan.",
        mutationPlan: clonePlain(mutationPlan),
        targetRefs: targetLookupRefs(target)
      });
      break;
    }

    const authorization = evaluateCommitAuthority(authority, {mutationPlan, target, actor});
    if ( !authorization.ok ) {
      failures.push({
        code: TARGET_MUTATION_COMMIT_CODES.COMMIT_NOT_AUTHORIZED,
        reason: authorization.reason,
        mutationPlan: clonePlain(mutationPlan),
        targetRefs: targetLookupRefs(target),
        authority: authorization.authority
      });
      break;
    }

    try {
      const ok = await commitPlan(actor, mutationPlan.plan, mutationPlan);
      if ( !ok ) {
        failures.push({
          code: TARGET_MUTATION_COMMIT_CODES.COMMIT_FAILED,
          reason: "Target Actor commit adapter returned false.",
          mutationPlan: clonePlain(mutationPlan),
          targetRefs: targetLookupRefs(target)
        });
        break;
      }
      committed.push({
        type: mutationPlan.type,
        targetRef: mutationPlan.targetRef ?? null,
        target: clonePlain(target),
        updates: clonePlain(mutationPlan.plan?.updates ?? {}) ?? {}
      });
    } catch (error) {
      failures.push({
        code: TARGET_MUTATION_COMMIT_CODES.COMMIT_FAILED,
        reason: error?.message ?? String(error),
        mutationPlan: clonePlain(mutationPlan),
        targetRefs: targetLookupRefs(target)
      });
      break;
    }
  }

  return {
    ok: failures.length === 0,
    code: failures[0]?.code ?? TARGET_MUTATION_COMMIT_CODES.OK,
    committed,
    failures,
    metadata: clonePlain(metadata) ?? {}
  };
}

/* -------------------------------------------- */

function resolveTargetActor(targetActors, target, mutationPlan) {
  return resolveTargetLookupValue(targetActors, target, mutationPlan, {
    selectValue: entry => entry?.actor ?? entry ?? null
  });
}

function evaluateCommitAuthority(authority, context) {
  if ( typeof authority === "function" ) return normalizeAuthorityResult(authority({
    mutationPlan: clonePlain(context.mutationPlan),
    target: clonePlain(context.target),
    actor: context.actor
  }));

  if ( authority === true ) return {ok: true, reason: null, authority: {canCommit: true}};
  if ( !authority || typeof authority !== "object" ) {
    return {
      ok: false,
      reason: "Target mutation commits require explicit authority.",
      authority: null
    };
  }

  const snapshot = {
    userId: authority.userId ?? null,
    activeUserId: authority.activeUserId ?? null,
    activeGMId: authority.activeGMId ?? null,
    isGM: authority.isGM === true,
    canCommit: authority.canCommit === true
  };
  if ( snapshot.activeUserId && snapshot.userId !== snapshot.activeUserId ) {
    return {
      ok: false,
      reason: "Only the active authoritative user may commit target mutations.",
      authority: snapshot
    };
  }
  if ( snapshot.activeGMId && snapshot.userId !== snapshot.activeGMId ) {
    return {
      ok: false,
      reason: "Only the active GM may commit target mutations.",
      authority: snapshot
    };
  }
  if ( snapshot.canCommit || snapshot.isGM ) return {ok: true, reason: null, authority: snapshot};

  return {
    ok: false,
    reason: "Target mutation commits require GM or explicit commit authority.",
    authority: snapshot
  };
}

function normalizeAuthorityResult(result) {
  if ( result === true ) return {ok: true, reason: null, authority: {canCommit: true}};
  if ( result && typeof result === "object" ) {
    return {
      ok: result.ok !== false && result.canCommit !== false,
      reason: result.reason ?? null,
      authority: clonePlain(result.authority ?? result) ?? {}
    };
  }
  return {
    ok: false,
    reason: "Target mutation commit authority rejected the plan.",
    authority: null
  };
}

async function defaultCommitPlan(actor, mutationPlan) {
  return commitActorDurabilityMutationPlan(actor, mutationPlan);
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
