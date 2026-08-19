import {
  actorRef,
  normalizeEntityRef
} from "../helpers/entity-refs.mjs";
import {
  preferredTargetRef,
  resolveTargetLookupValue,
  targetLookupRefs
} from "../helpers/target-actor-refs.mjs";

export const CONCENTRATION_EVENT_TYPES = Object.freeze({
  SAVE_RESOLVED: "concentration.saveResolved",
  BROKEN: "concentration.broken",
  MAINTAINED: "concentration.maintained"
});

export const CONCENTRATION_CODES = Object.freeze({
  OK: "OK",
  NO_DECISIONS: "NO_DECISIONS",
  NO_CHECKS_REQUIRED: "NO_CHECKS_REQUIRED"
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
