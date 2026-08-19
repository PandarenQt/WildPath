import {WILDPATH} from "../config.mjs";
import {resolveConcentrationCheckResults} from "./concentration-resolver.mjs";
import {executeEffectLifecycleCommit} from "./effect-lifecycle-commit-resolver.mjs";

export const CONCENTRATION_CHECK_COMMIT_CODES = Object.freeze({
  OK: "OK",
  NO_DECISION_EVENTS: "NO_DECISION_EVENTS",
  CHECK_RESOLUTION_FAILED: "CHECK_RESOLUTION_FAILED",
  LIFECYCLE_COMMIT_FAILED: "LIFECYCLE_COMMIT_FAILED"
});

/* -------------------------------------------- */

export async function executeConcentrationCheckCommit({
  actors=[],
  checkRequests=[],
  checkPlanning=null,
  concentrationChecks=null,
  rolls=[],
  results=[],
  authority=null,
  targetActors=null,
  conditionDefinitions=WILDPATH.CONDITIONS,
  policy={},
  metadata={}
}={}) {
  const checkResolution = resolveConcentrationCheckResults({
    checkRequests,
    checkPlanning,
    concentrationChecks,
    rolls,
    results,
    policy,
    metadata
  });

  if ( !checkResolution.ok ) {
    return concentrationCheckCommitResult({
      ok: false,
      code: CONCENTRATION_CHECK_COMMIT_CODES.CHECK_RESOLUTION_FAILED,
      checkResolution,
      failures: checkResolution.failures,
      metadata
    });
  }

  if ( !checkResolution.decisionEvents.length ) {
    return concentrationCheckCommitResult({
      ok: true,
      code: CONCENTRATION_CHECK_COMMIT_CODES.NO_DECISION_EVENTS,
      checkResolution,
      metadata
    });
  }

  const lifecycleCommit = await executeEffectLifecycleCommit({
    actors,
    events: checkResolution.decisionEvents,
    targetActors,
    authority,
    conditionDefinitions,
    metadata: {
      ...(clonePlain(metadata) ?? {}),
      resolver: "ConcentrationCheckCommitResolver"
    }
  });

  return concentrationCheckCommitResult({
    ok: lifecycleCommit.ok,
    code: lifecycleCommit.ok
      ? CONCENTRATION_CHECK_COMMIT_CODES.OK
      : CONCENTRATION_CHECK_COMMIT_CODES.LIFECYCLE_COMMIT_FAILED,
    checkResolution,
    lifecycleCommit,
    failures: lifecycleCommit.ok ? [] : lifecycleCommit.failures,
    metadata
  });
}

/* -------------------------------------------- */

function concentrationCheckCommitResult({
  ok,
  code,
  checkResolution=null,
  lifecycleCommit=null,
  failures=[],
  metadata={}
}) {
  return {
    ok,
    code,
    resolver: "ConcentrationCheckCommitResolver",
    checkResolution,
    lifecycleCommit,
    decisionEvents: checkResolution?.decisionEvents ?? [],
    breakEvents: checkResolution?.breakEvents ?? [],
    mutationPlans: lifecycleCommit?.mutationPlans ?? [],
    failures,
    metadata: clonePlain(metadata) ?? {}
  };
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
