import {
  actorRef,
  normalizeEntityRef
} from "../helpers/entity-refs.mjs";
import {
  preferredTargetRef,
  resolveTargetLookupValue,
  targetLookupRefs
} from "../helpers/target-actor-refs.mjs";
import {rollResultToResolverRoll} from "../helpers/rolls.mjs";
import {resolveSaveAgainstDC} from "./save-resolver.mjs";

export const CONCENTRATION_EVENT_TYPES = Object.freeze({
  SAVE_RESOLVED: "concentration.saveResolved",
  BROKEN: "concentration.broken",
  MAINTAINED: "concentration.maintained"
});

export const CONCENTRATION_CODES = Object.freeze({
  OK: "OK",
  NO_DECISIONS: "NO_DECISIONS",
  NO_CHECKS_REQUIRED: "NO_CHECKS_REQUIRED",
  NO_CHECK_REQUESTS: "NO_CHECK_REQUESTS",
  NO_CHECK_RESULTS: "NO_CHECK_RESULTS",
  MISSING_CHECK_RESULT: "MISSING_CHECK_RESULT",
  INVALID_CHECK_RESULT: "INVALID_CHECK_RESULT"
});

export const CONCENTRATION_OUTCOMES = Object.freeze({
  BROKEN: "broken",
  MAINTAINED: "maintained",
  IGNORED: "ignored"
});

export const CONCENTRATION_CHECK_TYPES = Object.freeze({
  DAMAGE: "damage"
});

export const CONCENTRATION_CHECK_SKIP_REASONS = Object.freeze({
  TARGET_SKIPPED: "targetSkipped",
  NO_DAMAGE_TAKEN: "noDamageTaken",
  NOT_CONCENTRATING: "notConcentrating"
});

/* -------------------------------------------- */

export function resolveConcentrationDecisions({
  decisions=[],
  events=[],
  metadata={}
}={}) {
  const entries = [
    ...collectionContents(decisions).map(value => normalizeConcentrationDecision(value, "decision")),
    ...collectionContents(events)
      .filter(event => event?.type === CONCENTRATION_EVENT_TYPES.SAVE_RESOLVED)
      .map(value => normalizeConcentrationDecision(value, "event"))
  ].filter(Boolean);

  const breakEvents = [];
  const maintained = [];
  const ignored = [];

  for ( const entry of entries ) {
    if ( entry.outcome === CONCENTRATION_OUTCOMES.BROKEN && entry.refs.length ) {
      breakEvents.push(concentrationBreakEvent(entry, metadata));
    }
    else if ( entry.outcome === CONCENTRATION_OUTCOMES.MAINTAINED ) {
      maintained.push(entry);
    }
    else {
      ignored.push(entry);
    }
  }

  return {
    ok: true,
    code: entries.length ? CONCENTRATION_CODES.OK : CONCENTRATION_CODES.NO_DECISIONS,
    resolver: "ConcentrationResolver",
    breakEvents,
    maintained,
    ignored,
    failures: [],
    metadata: clonePlain(metadata) ?? {}
  };
}

/* -------------------------------------------- */

export function planConcentrationChecks({
  damageResults=[],
  damageResolution=null,
  durabilityResolution=null,
  concentrationStates=null,
  targetSystems={},
  policy={},
  metadata={}
}={}) {
  const normalizedPolicy = normalizeConcentrationCheckPolicy(policy);
  const results = concentrationDamageResults({damageResults, damageResolution, durabilityResolution});
  const checkRequests = [];
  const skipped = [];

  for ( const [index, damageResult] of results.entries() ) {
    const target = damageResult.target ?? {};
    if ( isSkippedDamageResult(damageResult) ) {
      skipped.push(skipConcentrationCheck({
        reason: CONCENTRATION_CHECK_SKIP_REASONS.TARGET_SKIPPED,
        target,
        damageResult
      }));
      continue;
    }

    const damageTaken = concentrationDamageAmount(damageResult, normalizedPolicy);
    if ( damageTaken < normalizedPolicy.minimumDamage ) {
      skipped.push(skipConcentrationCheck({
        reason: CONCENTRATION_CHECK_SKIP_REASONS.NO_DAMAGE_TAKEN,
        target,
        damageResult,
        damageTaken
      }));
      continue;
    }

    const state = resolveConcentrationStateForDamage({
      target,
      damageResult,
      concentrationStates,
      targetSystems
    });
    if ( !state?.concentrating ) {
      skipped.push(skipConcentrationCheck({
        reason: CONCENTRATION_CHECK_SKIP_REASONS.NOT_CONCENTRATING,
        target,
        damageResult,
        damageTaken
      }));
      continue;
    }

    checkRequests.push(createConcentrationCheckRequest({
      index,
      target,
      state,
      damageResult,
      damageTaken,
      policy: normalizedPolicy,
      metadata
    }));
  }

  return {
    ok: true,
    code: checkRequests.length ? CONCENTRATION_CODES.OK : CONCENTRATION_CODES.NO_CHECKS_REQUIRED,
    resolver: "ConcentrationResolver",
    checkRequests,
    skipped,
    failures: [],
    policy: normalizedPolicy,
    metadata: clonePlain(metadata) ?? {}
  };
}

/* -------------------------------------------- */

export function resolveConcentrationCheckResults({
  checkRequests=[],
  checkPlanning=null,
  concentrationChecks=null,
  results=[],
  rolls=[],
  policy={},
  metadata={}
}={}) {
  const requests = normalizeConcentrationCheckRequests({checkRequests, checkPlanning, concentrationChecks});
  const normalizedPolicy = normalizeConcentrationResultPolicy(policy);
  if ( !requests.length ) {
    return concentrationCheckResult({
      ok: true,
      code: CONCENTRATION_CODES.NO_CHECK_REQUESTS,
      policy: normalizedPolicy,
      metadata
    });
  }

  const decisionEvents = [];
  const missing = [];
  const failures = [];

  for ( const request of requests ) {
    const supplied = resolveSuppliedConcentrationCheckResult({request, rolls, results, requests});
    if ( !supplied ) {
      missing.push(missingConcentrationCheckResult(request));
      continue;
    }

    const resolved = resolveConcentrationCheckResult({request, supplied, policy: normalizedPolicy, metadata});
    if ( !resolved.ok ) {
      failures.push(resolved);
      continue;
    }

    decisionEvents.push(resolved.event);
  }

  const decisions = decisionEvents.map(event => event.data);
  const decisionSummary = resolveConcentrationDecisions({events: decisionEvents, metadata});
  const ok = failures.length === 0 && (missing.length === 0 || !normalizedPolicy.requireAllResults);
  return concentrationCheckResult({
    ok,
    code: concentrationCheckResultCode({decisionEvents, missing, failures}),
    decisionEvents,
    decisions,
    breakEvents: decisionSummary.breakEvents,
    maintained: decisionSummary.maintained,
    ignored: decisionSummary.ignored,
    missing,
    failures,
    policy: normalizedPolicy,
    metadata
  });
}

/* -------------------------------------------- */

function normalizeConcentrationCheckRequests({checkRequests, checkPlanning, concentrationChecks}) {
  const sources = [
    checkRequestContents(checkRequests),
    checkRequestContents(checkPlanning),
    checkRequestContents(concentrationChecks)
  ];
  return sources.find(source => source.length)?.map(request => clonePlain(request)) ?? [];
}

function checkRequestContents(value) {
  if ( isConcentrationCheckRequestLike(value) ) return [value];
  if ( value?.checkRequests ) return collectionContents(value.checkRequests).filter(isConcentrationCheckRequestLike);
  return collectionContents(value).filter(isConcentrationCheckRequestLike);
}

function isConcentrationCheckRequestLike(value) {
  return Boolean(value && typeof value === "object" && value.id && value.dc != null);
}

function normalizeConcentrationResultPolicy(policy={}) {
  const data = policy && typeof policy === "object" ? policy : {};
  const savePolicy = clonePlain(data.savePolicy ?? data.savingThrowPolicy ?? {}) ?? {};
  for ( const key of [
    "successOnTie",
    "naturalCriticalSuccesses",
    "naturalCriticalFailures",
    "criticalSuccessThreshold",
    "criticalFailureThreshold"
  ] ) {
    if ( data[key] != null && savePolicy[key] == null ) savePolicy[key] = data[key];
  }
  return {
    requireAllResults: data.requireAllResults ?? true,
    savePolicy,
    metadata: clonePlain(data.metadata ?? {}) ?? {}
  };
}

function resolveSuppliedConcentrationCheckResult({request, rolls, results, requests}) {
  for ( const collection of [results, rolls] ) {
    const match = findConcentrationCheckResult(collection, request, requests.length);
    if ( match ) return match;
  }
  return null;
}

function findConcentrationCheckResult(collection, request, requestCount) {
  const entries = keyedConcentrationResultEntries(collection);
  if ( !entries.length ) return null;

  const requestRefs = concentrationCheckLookupRefs(request);
  for ( const entry of entries ) {
    const resultRefs = concentrationCheckResultLookupRefs(entry.value, entry.key);
    if ( resultRefs.some(ref => requestRefs.includes(ref)) ) {
      return {
        value: entry.value,
        key: entry.key,
        matchedBy: resultRefs.find(ref => requestRefs.includes(ref)) ?? null
      };
    }
  }

  if ( requestCount === 1 && entries.length === 1 ) {
    return {
      value: entries[0].value,
      key: entries[0].key,
      matchedBy: "single-check"
    };
  }
  return null;
}

function keyedConcentrationResultEntries(collection) {
  if ( collection == null ) return [];
  if ( isConcentrationCheckResultLike(collection) || finiteNumber(collection) != null ) {
    return [{key: null, value: collection}];
  }
  if ( Array.isArray(collection) ) {
    return collection.map((value, index) => ({key: String(index), value}));
  }
  if ( collection instanceof Map ) {
    return [...collection.entries()].map(([key, value]) => ({key: String(key), value}));
  }
  if ( collection instanceof Set ) {
    return [...collection.values()].map((value, index) => ({key: String(index), value}));
  }
  if ( typeof collection === "object" ) {
    return Object.entries(collection).map(([key, value]) => ({key, value}));
  }
  return [];
}

function isConcentrationCheckResultLike(value) {
  if ( !value || typeof value !== "object" ) return false;
  return [
    "requestId",
    "checkId",
    "actorRef",
    "actorId",
    "sourceRef",
    "targetRef",
    "total",
    "value",
    "roll",
    "save",
    "success",
    "passed",
    "failed",
    "outcome",
    "result",
    "status"
  ].some(key => value[key] != null);
}

function concentrationCheckLookupRefs(request) {
  return uniqueStrings([
    request.id,
    request.ref,
    request.actorId,
    actorIdRef(request.actorId),
    normalizeRef(request.actorRef),
    normalizeRef(request.sourceRef),
    normalizeRef(request.originRef),
    normalizeRef(request.itemRef),
    normalizeRef(request.targetRef),
    normalizeRef(request.target?.ref),
    request.target?.id,
    request.target?.actorId,
    actorIdRef(request.target?.actorId),
    ...targetLookupRefs(request.target ?? {})
  ]);
}

function concentrationCheckResultLookupRefs(result, key) {
  const data = result && typeof result === "object" ? result : {};
  const resultData = data.data && typeof data.data === "object" ? data.data : {};
  return uniqueStrings([
    key,
    data.requestId,
    data.checkId,
    data.id,
    data.ref,
    data.actorId,
    resultData.requestId,
    resultData.checkId,
    resultData.id,
    resultData.ref,
    resultData.actorId,
    actorIdRef(data.actorId ?? resultData.actorId),
    normalizeRef(data.actorRef ?? resultData.actorRef),
    normalizeRef(data.sourceRef ?? resultData.sourceRef),
    normalizeRef(data.originRef ?? resultData.originRef),
    normalizeRef(data.itemRef ?? resultData.itemRef),
    normalizeRef(data.targetRef ?? resultData.targetRef),
    normalizeRef(data.target?.ref ?? resultData.target?.ref),
    data.target?.id ?? resultData.target?.id,
    data.target?.actorId ?? resultData.target?.actorId,
    actorIdRef(data.target?.actorId ?? resultData.target?.actorId)
  ]);
}

function resolveConcentrationCheckResult({request, supplied, policy, metadata}) {
  const input = normalizeConcentrationCheckResultInput(supplied.value);
  const explicitOutcome = normalizeOutcome(input.source ?? {}, input.data ?? {});
  const dc = finiteNumber(input.dc ?? request.dc);
  const explicitDecision = explicitOutcome !== CONCENTRATION_OUTCOMES.IGNORED;

  if ( explicitDecision ) {
    return createResolvedConcentrationCheck({
      request,
      supplied,
      input,
      outcome: explicitOutcome,
      success: explicitOutcome === CONCENTRATION_OUTCOMES.MAINTAINED,
      dc,
      saveResult: null,
      policy,
      metadata
    });
  }

  const saveResult = resolveSaveAgainstDC({
    roll: input.roll,
    dc: {
      value: dc,
      slug: request.saveKey ?? "concentration",
      ability: request.ability ?? null,
      source: {requestId: request.id}
    },
    target: request.target ?? {id: request.targetRef, actorId: request.actorId},
    policy: policy.savePolicy,
    context: {
      requestId: request.id,
      checkType: request.type,
      matchedBy: supplied.matchedBy,
      resolver: "ConcentrationResolver"
    }
  });

  if ( !saveResult.ok ) {
    return {
      ok: false,
      code: CONCENTRATION_CODES.INVALID_CHECK_RESULT,
      saveCode: saveResult.code,
      reason: saveResult.reason,
      request: clonePlain(request),
      result: clonePlain(supplied.value),
      saveResult,
      matchedBy: supplied.matchedBy
    };
  }

  return createResolvedConcentrationCheck({
    request,
    supplied,
    input,
    outcome: saveResult.success ? CONCENTRATION_OUTCOMES.MAINTAINED : CONCENTRATION_OUTCOMES.BROKEN,
    success: saveResult.success,
    dc: saveResult.dc.value,
    saveResult,
    policy,
    metadata
  });
}

function normalizeConcentrationCheckResultInput(value) {
  const source = finiteNumber(value) != null ? {total: finiteNumber(value)} : (value ?? {});
  const data = source.data && typeof source.data === "object" ? source.data : {};
  const result = source.result && typeof source.result === "object" ? source.result : {};
  const rollResult = rollResultLike(source.rollResult)
    ?? rollResultLike(source)
    ?? rollResultLike(source.roll)
    ?? rollResultLike(source.save)
    ?? rollResultLike(data.rollResult)
    ?? rollResultLike(result.rollResult)
    ?? null;
  const rollSource = rollResult
    ? rollResultToResolverRoll(rollResult)
    : source.roll ?? source.save ?? data.roll ?? data.save ?? result.roll ?? result.save ?? source;
  const metadata = {
    ...(clonePlain(source.metadata ?? {}) ?? {}),
    ...(clonePlain(data.metadata ?? {}) ?? {}),
    ...(rollResult ? {rollResult: clonePlain(rollResult)} : {})
  };

  return {
    source: clonePlain(source) ?? {},
    data: clonePlain(data) ?? {},
    dc: finiteNumber(source.dc ?? source.difficulty ?? source.targetDC ?? data.dc ?? data.difficulty ?? result.dc),
    roll: {
      total: finiteNumber(rollSource?.total ?? rollSource?.value ?? rollSource?.amount),
      die: finiteNumber(rollSource?.die ?? rollSource?.natural ?? rollSource?.d20),
      ability: rollSource?.ability ?? rollSource?.slug ?? rollSource?.key ?? null,
      formula: rollSource?.formula ?? null,
      mode: rollSource?.mode ?? null,
      statistic: rollSource?.statistic ? clonePlain(rollSource.statistic) : null,
      modifiers: Array.isArray(rollSource?.modifiers) ? rollSource.modifiers.map(clonePlain) : [],
      metadata
    }
  };
}

function rollResultLike(value) {
  if ( !value || typeof value !== "object" ) return null;
  return value.requestId && value.total != null && value.provenance
    ? value
    : null;
}

function createResolvedConcentrationCheck({request, supplied, input, outcome, success, dc, saveResult, policy, metadata}) {
  const total = finiteNumber(input.roll.total);
  const margin = total != null && dc != null ? total - dc : null;
  const event = concentrationSaveResolvedEvent({
    request,
    supplied,
    input,
    outcome,
    success,
    total,
    dc,
    margin,
    saveResult,
    policy,
    metadata
  });
  return {
    ok: true,
    code: CONCENTRATION_CODES.OK,
    outcome,
    success,
    total,
    dc,
    margin,
    event,
    request: clonePlain(request),
    result: clonePlain(supplied.value),
    saveResult: clonePlain(saveResult)
  };
}

function concentrationSaveResolvedEvent({
  request,
  supplied,
  input,
  outcome,
  success,
  total,
  dc,
  margin,
  saveResult,
  policy,
  metadata
}) {
  const sourceRef = normalizeRef(request.sourceRef) ?? normalizeRef(request.actorRef) ?? actorIdRef(request.actorId);
  const actorRefValue = normalizeRef(request.actorRef) ?? actorIdRef(request.actorId);
  const originRef = normalizeRef(request.originRef);
  const itemRef = normalizeRef(request.itemRef);
  const targetRef = normalizeRef(request.targetRef);
  const data = {
    requestId: request.id,
    checkType: request.type,
    ref: sourceRef ?? actorRefValue,
    sourceRef,
    actorRef: actorRefValue,
    actorId: request.actorId ?? null,
    originRef,
    itemRef,
    targetRef,
    success,
    outcome,
    total,
    dc,
    margin,
    damageTaken: request.damageTaken ?? null,
    roll: clonePlain(input.roll),
    result: clonePlain(input.source),
    saveResult: clonePlain(saveResult),
    checkRequest: clonePlain(request)
  };

  return {
    type: CONCENTRATION_EVENT_TYPES.SAVE_RESOLVED,
    ref: data.ref,
    sourceRef,
    actorRef: actorRefValue,
    actorId: data.actorId,
    originRef,
    itemRef,
    targetRef,
    data,
    metadata: {
      ...(clonePlain(metadata) ?? {}),
      ...(clonePlain(policy.metadata) ?? {}),
      ...(clonePlain(request.metadata) ?? {}),
      ...(clonePlain(input.roll.metadata) ?? {}),
      requestId: request.id,
      matchedBy: supplied.matchedBy,
      saveOutcome: saveResult?.outcome ?? null
    }
  };
}

function missingConcentrationCheckResult(request) {
  return {
    code: CONCENTRATION_CODES.MISSING_CHECK_RESULT,
    reason: "concentration check result is required",
    request: clonePlain(request),
    refs: concentrationCheckLookupRefs(request)
  };
}

function concentrationCheckResult({
  ok,
  code,
  decisionEvents=[],
  decisions=[],
  breakEvents=[],
  maintained=[],
  ignored=[],
  missing=[],
  failures=[],
  policy={},
  metadata={}
}) {
  return {
    ok,
    code,
    resolver: "ConcentrationResolver",
    decisionEvents,
    decisions,
    breakEvents,
    maintained,
    ignored,
    missing,
    failures,
    policy,
    metadata: clonePlain(metadata) ?? {}
  };
}

function concentrationCheckResultCode({decisionEvents, missing, failures}) {
  if ( failures.length ) return CONCENTRATION_CODES.INVALID_CHECK_RESULT;
  if ( missing.length && !decisionEvents.length ) return CONCENTRATION_CODES.NO_CHECK_RESULTS;
  if ( missing.length ) return CONCENTRATION_CODES.MISSING_CHECK_RESULT;
  return CONCENTRATION_CODES.OK;
}

/* -------------------------------------------- */

function normalizeConcentrationDecision(value, source) {
  if ( !value || typeof value !== "object" ) return null;
  const data = value.data && typeof value.data === "object" ? value.data : {};
  const outcome = normalizeOutcome(value, data);
  const refs = normalizeDecisionRefs(value, data);
  return {
    source,
    outcome,
    refs,
    ref: refs[0] ?? null,
    sourceRef: normalizeRef(value.sourceRef ?? data.sourceRef ?? value.source?.ref ?? value.source),
    originRef: normalizeRef(value.originRef ?? data.originRef ?? value.origin?.ref ?? value.origin),
    actorRef: normalizeRef(value.actorRef ?? data.actorRef) ?? actorIdRef(value.actorId ?? data.actorId ?? value.source?.actorId),
    itemRef: normalizeRef(value.itemRef ?? data.itemRef),
    actorId: value.actorId ?? data.actorId ?? value.source?.actorId ?? null,
    total: finiteNumber(value.total ?? data.total),
    dc: finiteNumber(value.dc ?? data.dc),
    roll: clonePlain(value.roll ?? data.roll ?? null),
    decision: clonePlain(value) ?? {}
  };
}

function concentrationDamageResults({damageResults, damageResolution, durabilityResolution}) {
  if ( collectionContents(damageResults).length ) return collectionContents(damageResults);
  const durabilityResults = collectionContents(durabilityResolution?.adjustedDamageResults);
  if ( durabilityResults.length ) return durabilityResults;
  return collectionContents(damageResolution?.results);
}

function isSkippedDamageResult(damageResult) {
  return damageResult?.code === "TARGET_SKIPPED" || damageResult?.targetContext?.selected === false;
}

function concentrationDamageAmount(damageResult, policy) {
  const value = damageResult?.[policy.damageAmountPath]
    ?? damageResult?.total
    ?? damageResult?.amount
    ?? 0;
  const number = finiteNumber(value) ?? 0;
  return Math.max(number, 0);
}

function resolveConcentrationStateForDamage({target, damageResult, concentrationStates, targetSystems}) {
  const explicit = resolveSuppliedConcentrationState(concentrationStates, target, damageResult);
  if ( explicit ) return normalizeConcentrationState(explicit, target);

  const system = resolveTargetLookupValue(targetSystems, target, damageResult, {
    selectValue: entry => entry?.system ?? entry?.actorSystem ?? entry ?? null
  });
  return normalizeConcentrationState(
    system?.concentration
      ?? system?.status?.concentration
      ?? system?.attributes?.concentration
      ?? target?.concentration
      ?? null,
    target
  );
}

function resolveSuppliedConcentrationState(concentrationStates, target, damageResult) {
  if ( concentrationStates === true ) return true;
  if ( typeof concentrationStates === "function" ) {
    return concentrationStates({
      target: clonePlain(target),
      damageResult: clonePlain(damageResult),
      refs: targetLookupRefs(target)
    }) ?? null;
  }
  return resolveTargetLookupValue(concentrationStates, target, damageResult);
}

function normalizeConcentrationState(state, target) {
  if ( state === true ) {
    const actorId = target.actorId ?? target.id ?? null;
    return {
      concentrating: true,
      actorId,
      actorRef: actorIdRef(actorId),
      sourceRef: actorIdRef(actorId),
      originRef: null,
      itemRef: null,
      ability: null,
      saveKey: null,
      metadata: {}
    };
  }
  if ( !state || typeof state !== "object" ) return null;

  const concentration = state.concentration && typeof state.concentration === "object"
    ? state.concentration
    : {};
  const active = state.concentrating ?? state.active ?? state.required
    ?? concentration.concentrating ?? concentration.active ?? concentration.required;
  if ( active === false ) return null;

  const actorId = state.actorId ?? concentration.actorId ?? target.actorId ?? target.id ?? null;
  const actorReference = normalizeRef(state.actorRef ?? concentration.actorRef) ?? actorIdRef(actorId);
  const sourceReference = normalizeRef(
    state.sourceRef
      ?? concentration.sourceRef
      ?? state.source
      ?? concentration.source
      ?? actorReference
  );
  return {
    concentrating: active === true || !!(actorReference || sourceReference || state.originRef || concentration.originRef),
    actorId,
    actorRef: actorReference,
    sourceRef: sourceReference,
    originRef: normalizeRef(state.originRef ?? concentration.originRef ?? state.origin ?? concentration.origin),
    itemRef: normalizeRef(state.itemRef ?? concentration.itemRef ?? state.item ?? concentration.item),
    ability: state.ability ?? concentration.ability ?? null,
    saveKey: state.saveKey ?? concentration.saveKey ?? null,
    metadata: clonePlain(state.metadata ?? concentration.metadata ?? {}) ?? {}
  };
}

function createConcentrationCheckRequest({index, target, state, damageResult, damageTaken, policy, metadata}) {
  const targetRef = preferredTargetRef(target);
  const dc = concentrationDCForDamage(damageTaken, policy);
  return {
    id: `concentration-check:${targetRef ?? index}:${index}`,
    type: CONCENTRATION_CHECK_TYPES.DAMAGE,
    actorId: state.actorId ?? target.actorId ?? null,
    actorRef: state.actorRef ?? actorIdRef(state.actorId ?? target.actorId),
    sourceRef: state.sourceRef ?? state.actorRef ?? actorIdRef(state.actorId ?? target.actorId),
    originRef: state.originRef ?? null,
    itemRef: state.itemRef ?? null,
    target: clonePlain(target),
    targetRef,
    damageTaken,
    dc,
    saveKey: state.saveKey ?? policy.saveKey,
    ability: state.ability ?? policy.ability,
    damageResult: clonePlain(damageResult),
    metadata: {
      ...(clonePlain(metadata) ?? {}),
      ...(clonePlain(state.metadata) ?? {}),
      dcPolicy: clonePlain(policy)
    }
  };
}

function concentrationDCForDamage(damageTaken, policy) {
  const damageDC = roundConcentrationDC(damageTaken / policy.damageDivisor, policy.rounding);
  return Math.max(policy.minimumDC, damageDC);
}

function normalizeConcentrationCheckPolicy(policy={}) {
  const data = policy && typeof policy === "object" ? policy : {};
  return {
    minimumDC: Math.max(Math.floor(finiteNumber(data.minimumDC ?? data.baseDC) ?? 10), 0),
    damageDivisor: Math.max(finiteNumber(data.damageDivisor ?? data.halfDamageDivisor) ?? 2, 1),
    rounding: data.rounding ?? "floor",
    minimumDamage: Math.max(finiteNumber(data.minimumDamage) ?? 1, 0),
    damageAmountPath: data.damageAmountPath ?? "total",
    saveKey: data.saveKey ?? "concentration",
    ability: data.ability ?? "con",
    metadata: clonePlain(data.metadata ?? {}) ?? {}
  };
}

function roundConcentrationDC(value, rounding) {
  switch ( rounding ) {
    case "ceil": return Math.ceil(value);
    case "round": return Math.round(value);
    case "none": return value;
    case "floor":
    default: return Math.floor(value);
  }
}

function skipConcentrationCheck({reason, target, damageResult, damageTaken=null}) {
  return {
    reason,
    target: clonePlain(target),
    targetRefs: targetLookupRefs(target),
    damageTaken,
    damageResult: clonePlain(damageResult)
  };
}

function concentrationBreakEvent(entry, metadata) {
  return {
    type: CONCENTRATION_EVENT_TYPES.BROKEN,
    ref: entry.ref,
    sourceRef: entry.sourceRef ?? entry.actorRef ?? entry.ref,
    originRef: entry.originRef,
    actorRef: entry.actorRef,
    itemRef: entry.itemRef,
    actorId: entry.actorId,
    data: {
      ref: entry.ref,
      sourceRef: entry.sourceRef ?? entry.actorRef ?? entry.ref,
      originRef: entry.originRef,
      actorRef: entry.actorRef,
      itemRef: entry.itemRef,
      actorId: entry.actorId,
      refs: [...entry.refs],
      decision: entry.decision
    },
    metadata: {
      ...(clonePlain(metadata) ?? {}),
      outcome: entry.outcome,
      total: entry.total,
      dc: entry.dc
    }
  };
}

function normalizeOutcome(value, data) {
  if ( value.broken === true || data.broken === true ) return CONCENTRATION_OUTCOMES.BROKEN;
  if ( value.failed === true || data.failed === true ) return CONCENTRATION_OUTCOMES.BROKEN;
  if ( value.success === false || data.success === false ) return CONCENTRATION_OUTCOMES.BROKEN;
  if ( value.passed === false || data.passed === false ) return CONCENTRATION_OUTCOMES.BROKEN;

  if ( value.maintained === true || data.maintained === true ) return CONCENTRATION_OUTCOMES.MAINTAINED;
  if ( value.success === true || data.success === true ) return CONCENTRATION_OUTCOMES.MAINTAINED;
  if ( value.passed === true || data.passed === true ) return CONCENTRATION_OUTCOMES.MAINTAINED;

  const label = String(value.outcome ?? value.result ?? value.status ?? data.outcome ?? data.result ?? data.status ?? "")
    .trim()
    .toLowerCase();
  if ( ["broken", "lost", "fail", "failed", "failure"].includes(label) ) return CONCENTRATION_OUTCOMES.BROKEN;
  if ( ["kept", "maintained", "success", "succeeded", "passed"].includes(label) ) {
    return CONCENTRATION_OUTCOMES.MAINTAINED;
  }
  return CONCENTRATION_OUTCOMES.IGNORED;
}

function normalizeDecisionRefs(value, data) {
  return uniqueStrings([
    normalizeRef(value.ref ?? data.ref),
    normalizeRef(value.sourceRef ?? data.sourceRef),
    normalizeRef(value.originRef ?? data.originRef),
    normalizeRef(value.actorRef ?? data.actorRef),
    normalizeRef(value.itemRef ?? data.itemRef),
    normalizeRef(value.source?.ref ?? value.source),
    normalizeRef(value.origin?.ref ?? value.origin),
    actorIdRef(value.actorId ?? data.actorId ?? value.source?.actorId)
  ]);
}

function actorIdRef(id) {
  return id ? actorRef(id) : null;
}

function normalizeRef(value) {
  if ( !value ) return null;
  return normalizeEntityRef(value) ?? (typeof value === "string" ? value : null);
}

function finiteNumber(value) {
  if ( value == null || value === "" ) return null;
  if ( typeof value === "object" || typeof value === "function" || typeof value === "boolean" ) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
