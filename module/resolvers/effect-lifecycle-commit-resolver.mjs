import {WILDPATH} from "../config.mjs";
import {
  actorRef,
  uuidRef
} from "../helpers/entity-refs.mjs";
import {planEffectLifecycle} from "./effect-lifecycle-resolver.mjs";
import {executeResolutionTransaction} from "./resolution-transaction-resolver.mjs";
import {prepareTargetMutationCommitOperations} from "./target-mutation-commit-resolver.mjs";

export const EFFECT_LIFECYCLE_COMMIT_CODES = Object.freeze({
  OK: "OK",
  NO_ACTORS: "NO_ACTORS",
  NO_MUTATION_PLANS: "NO_MUTATION_PLANS",
  PLAN_FAILED: "PLAN_FAILED",
  COMMIT_PREP_FAILED: "COMMIT_PREP_FAILED",
  TRANSACTION_FAILED: "TRANSACTION_FAILED"
});

/* -------------------------------------------- */

export async function executeEffectLifecycleCommit({
  actors=[],
  events=[],
  concentrationBreaks=[],
  targetActors=null,
  authority=null,
  conditionDefinitions=WILDPATH.CONDITIONS,
  metadata={}
}={}) {
  const actorList = uniqueActors(collectionContents(actors));
  if ( !actorList.length ) {
    return lifecycleCommitResult({
      ok: true,
      code: EFFECT_LIFECYCLE_COMMIT_CODES.NO_ACTORS,
      metadata,
      lifecycleResults: [],
      mutationPlans: []
    });
  }

  const lifecycleResults = [];
  const mutationPlans = [];
  const failures = [];
  for ( const actor of actorList ) {
    const result = planEffectLifecycle({
      actor,
      effects: actor.effects ?? [],
      events,
      concentrationBreaks,
      conditionDefinitions,
      metadata: {
        ...(clonePlain(metadata) ?? {}),
        targetActorRef: actorRef(actor.id) ?? actor.uuid ?? null
      }
    });
    lifecycleResults.push(result);
    if ( !result.ok ) failures.push(...result.failures);
    mutationPlans.push(...result.mutationPlans);
  }

  if ( failures.length ) {
    return lifecycleCommitResult({
      ok: false,
      code: EFFECT_LIFECYCLE_COMMIT_CODES.PLAN_FAILED,
      metadata,
      lifecycleResults,
      mutationPlans,
      failures
    });
  }

  if ( !mutationPlans.length ) {
    return lifecycleCommitResult({
      ok: true,
      code: EFFECT_LIFECYCLE_COMMIT_CODES.NO_MUTATION_PLANS,
      metadata,
      lifecycleResults,
      mutationPlans
    });
  }

  const targetOperations = prepareTargetMutationCommitOperations({
    mutationPlans,
    targetActors: targetActors ?? targetActorLookupFromActors(actorList),
    authority,
    metadata: {
      ...(clonePlain(metadata) ?? {}),
      resolver: "EffectLifecycleCommitResolver"
    }
  });
  if ( !targetOperations.ok ) {
    return lifecycleCommitResult({
      ok: false,
      code: EFFECT_LIFECYCLE_COMMIT_CODES.COMMIT_PREP_FAILED,
      metadata,
      lifecycleResults,
      mutationPlans,
      failures: targetOperations.failures,
      targetOperations
    });
  }

  const transaction = await executeResolutionTransaction({
    operations: targetOperations.operations,
    metadata: {
      ...(clonePlain(metadata) ?? {}),
      resolver: "EffectLifecycleCommitResolver"
    }
  });

  return lifecycleCommitResult({
    ok: transaction.ok,
    code: transaction.ok ? EFFECT_LIFECYCLE_COMMIT_CODES.OK : EFFECT_LIFECYCLE_COMMIT_CODES.TRANSACTION_FAILED,
    metadata,
    lifecycleResults,
    mutationPlans,
    failures: transaction.failures,
    targetOperations,
    transaction
  });
}

/* -------------------------------------------- */

export function targetActorLookupFromActors(actors=[]) {
  const lookup = {};
  for ( const actor of uniqueActors(collectionContents(actors)) ) {
    for ( const ref of actorLookupRefs(actor) ) lookup[ref] = actor;
  }
  return lookup;
}

/* -------------------------------------------- */

function lifecycleCommitResult({
  ok,
  code,
  metadata,
  lifecycleResults,
  mutationPlans,
  failures=[],
  targetOperations=null,
  transaction=null
}) {
  return {
    ok,
    code,
    resolver: "EffectLifecycleCommitResolver",
    lifecycleResults,
    mutationPlans,
    failures,
    targetOperations,
    transaction,
    metadata: clonePlain(metadata) ?? {}
  };
}

function actorLookupRefs(actor) {
  return uniqueStrings([
    actor.id ? actorRef(actor.id) : null,
    actor.id,
    actor.uuid ? uuidRef(actor.uuid) : null,
    actor.uuid
  ]);
}

function uniqueActors(actors) {
  const seen = new Set();
  const result = [];
  for ( const actor of actors ) {
    if ( !actor || typeof actor !== "object" ) continue;
    const key = actor.uuid ?? actor.id ?? result.length;
    if ( seen.has(key) ) continue;
    seen.add(key);
    result.push(actor);
  }
  return result;
}

function collectionContents(collection) {
  if ( collection == null ) return [];
  if ( Array.isArray(collection) ) return collection;
  if ( collection instanceof Set ) return [...collection.values()];
  if ( collection instanceof Map ) return [...collection.values()];
  if ( typeof collection.values === "function" ) return [...collection.values()];
  if ( typeof collection === "object" ) return Object.values(collection);
  return [];
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => value != null && value !== "").map(String))];
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
