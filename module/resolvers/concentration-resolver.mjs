import {
  actorRef,
  normalizeEntityRef
} from "../helpers/entity-refs.mjs";

export const CONCENTRATION_EVENT_TYPES = Object.freeze({
  SAVE_RESOLVED: "concentration.saveResolved",
  BROKEN: "concentration.broken",
  MAINTAINED: "concentration.maintained"
});

export const CONCENTRATION_CODES = Object.freeze({
  OK: "OK",
  NO_DECISIONS: "NO_DECISIONS"
});

export const CONCENTRATION_OUTCOMES = Object.freeze({
  BROKEN: "broken",
  MAINTAINED: "maintained",
  IGNORED: "ignored"
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
