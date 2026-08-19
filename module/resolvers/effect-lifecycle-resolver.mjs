import {
  DURATION_TICK_TIMING,
  DURATION_UNITS,
  TIMELINE_EVENT_TYPES,
  createDuration,
  updateDurationsForEvents
} from "../helpers/combat-timeline.mjs";
import {
  actorRef,
  entityRefId,
  normalizeEntityRef
} from "../helpers/entity-refs.mjs";
import {WILDPATH} from "../config.mjs";
import {planConditionEffect} from "./effect-resolver.mjs";

export const EFFECT_LIFECYCLE_CODES = Object.freeze({
  OK: "OK",
  CONDITION_PLAN_FAILED: "CONDITION_PLAN_FAILED"
});

export const EFFECT_LIFECYCLE_REASONS = Object.freeze({
  DURATION_EXPIRED: "durationExpired",
  CONCENTRATION_BROKEN: "concentrationBroken"
});

const CONCENTRATION_BREAK_EVENT_TYPES = new Set([
  "concentration.broken",
  "concentrationBroken",
  "concentration.lost"
]);

/* -------------------------------------------- */

export function planEffectLifecycle({
  actor=null,
  target=null,
  effects=null,
  events=[],
  concentrationBreaks=[],
  conditionDefinitions=WILDPATH.CONDITIONS,
  metadata={}
}={}) {
  const fallbackTarget = normalizeTargetRef(target ?? actorTarget(actor));
  const entries = normalizeConditionLifecycleEntries(effects ?? actor?.effects ?? [], fallbackTarget);
  const concentrationMatcher = createConcentrationBreakMatcher({concentrationBreaks, events});
  const conditionPlans = [];
  const mutationPlans = [];
  const expired = [];
  const concentrationBroken = [];
  const unchanged = [];
  const failures = [];

  for ( const entry of entries ) {
    const reasons = [];
    const durationExpiry = expiredDurationForEntry(entry, events);
    if ( durationExpiry ) {
      reasons.push(EFFECT_LIFECYCLE_REASONS.DURATION_EXPIRED);
      expired.push({
        effect: entry.effect,
        duration: durationExpiry.duration,
        expiredBy: durationExpiry.expiredBy
      });
    }

    const concentrationBreak = concentrationBreakForEntry(entry, concentrationMatcher);
    if ( concentrationBreak ) {
      reasons.push(EFFECT_LIFECYCLE_REASONS.CONCENTRATION_BROKEN);
      concentrationBroken.push({
        effect: entry.effect,
        concentration: entry.lifecycle.concentration,
        brokenBy: concentrationBreak
      });
    }

    if ( !reasons.length ) {
      unchanged.push(entry.effect);
      continue;
    }

    const plan = planConditionEffect({
      conditionId: entry.conditionId,
      levels: -Math.max(entry.level, 1),
      target: entry.target,
      existingConditions: [entry.effect],
      conditionDefinitions,
      duration: entry.lifecycle.duration,
      concentration: entry.lifecycle.concentration,
      source: entry.lifecycle.sourceRef,
      origin: entry.lifecycle.originRef,
      metadata: {
        ...(entry.lifecycle.metadata ?? {}),
        ...(clonePlain(metadata) ?? {}),
        lifecycle: {
          reasons,
          expiredBy: durationExpiry?.expiredBy ?? null,
          concentrationBreak: concentrationBreak ?? null
        }
      }
    });

    if ( !plan.ok ) {
      failures.push({
        code: plan.code,
        reason: plan.reason,
        effect: entry.effect,
        conditionPlan: plan
      });
      continue;
    }

    conditionPlans.push(plan);
    mutationPlans.push(plan.mutationPlan);
  }

  return {
    ok: failures.length === 0,
    code: failures[0]?.code ?? EFFECT_LIFECYCLE_CODES.OK,
    resolver: "EffectLifecycleResolver",
    conditionPlans,
    mutationPlans,
    expired,
    concentrationBroken,
    unchanged,
    failures,
    metadata: clonePlain(metadata) ?? {}
  };
}

/* -------------------------------------------- */

function normalizeConditionLifecycleEntries(effects, fallbackTarget) {
  return collectionContents(effects)
    .map(effect => normalizeConditionLifecycleEntry(effect, fallbackTarget))
    .filter(Boolean);
}

function normalizeConditionLifecycleEntry(effect, fallbackTarget) {
  const source = plainEffect(effect);
  if ( !source || typeof source !== "object" ) return null;

  const flag = source.flags?.wildpath?.conditionEffect ?? effect?.flags?.wildpath?.conditionEffect ?? {};
  const conditionId = source.system?.type ?? flag.conditionId ?? source.conditionId ?? null;
  if ( !conditionId ) return null;
  if ( source.type && source.type !== "condition" && !flag.conditionId ) return null;

  const target = normalizeTargetRef(source.target ?? flag.metadata?.target ?? fallbackTarget);
  return {
    effect: {
      id: source.id ?? source._id ?? effect?.id ?? null,
      uuid: source.uuid ?? effect?.uuid ?? null,
      type: "condition",
      name: source.name ?? effect?.name ?? null,
      system: {
        ...(clonePlain(source.system) ?? {}),
        type: conditionId
      },
      flags: clonePlain(source.flags ?? effect?.flags ?? {}) ?? {}
    },
    conditionId,
    level: normalizeConditionLevel(source.system?.level ?? flag.level ?? 1),
    target,
    lifecycle: {
      duration: clonePlain(flag.duration ?? source.duration ?? null),
      concentration: clonePlain(flag.concentration ?? null),
      sourceRef: flag.sourceRef ?? normalizeRef(flag.source ?? source.source) ?? null,
      originRef: flag.originRef ?? source.origin ?? normalizeRef(flag.origin ?? source.origin) ?? null,
      metadata: clonePlain(flag.metadata ?? {}) ?? {}
    }
  };
}

function expiredDurationForEntry(entry, events) {
  const duration = normalizeLifecycleDuration(entry);
  if ( !duration ) return null;
  if ( duration.expired ) return {duration, expiredBy: null};
  if ( !events.length ) return null;

  const result = updateDurationsForEvents([duration], events);
  const expired = result.expired[0] ?? null;
  return expired ? {duration: expired, expiredBy: expired.expiredBy ?? null} : null;
}

function normalizeLifecycleDuration(entry) {
  const raw = entry.lifecycle.duration;
  if ( !raw || raw === false ) return null;
  const timing = normalizeDurationTiming(raw, entry);
  const remaining = durationRemaining(raw);
  const duration = createDuration({
    id: `condition:${entry.effect.id ?? entry.effect.uuid ?? entry.conditionId}`,
    unit: timing.unit,
    remaining,
    tickOn: timing.tickOn,
    ownerId: timing.ownerId,
    sourceId: refId(entry.lifecycle.sourceRef),
    targetId: refId(entry.target),
    metadata: {
      effectId: entry.effect.id,
      conditionId: entry.conditionId,
      sourceRef: entry.lifecycle.sourceRef,
      originRef: entry.lifecycle.originRef
    }
  });
  return raw.expired === true ? {...duration, remaining: 0, expired: true} : duration;
}

function normalizeDurationTiming(raw, entry) {
  const expires = String(raw.expires ?? raw.expiry ?? raw.ends ?? "").trim();
  const sourceId = refId(entry.lifecycle.sourceRef);
  const targetId = refId(entry.target);

  switch ( expires ) {
    case "sourceTurnStart":
      return {unit: DURATION_UNITS.TURNS, tickOn: DURATION_TICK_TIMING.TURN_START, ownerId: sourceId};
    case "sourceTurnEnd":
      return {unit: DURATION_UNITS.TURNS, tickOn: DURATION_TICK_TIMING.TURN_END, ownerId: sourceId};
    case "targetTurnStart":
      return {unit: DURATION_UNITS.TURNS, tickOn: DURATION_TICK_TIMING.TURN_START, ownerId: targetId};
    case "targetTurnEnd":
      return {unit: DURATION_UNITS.TURNS, tickOn: DURATION_TICK_TIMING.TURN_END, ownerId: targetId};
    case "roundStart":
      return {unit: DURATION_UNITS.ROUNDS, tickOn: DURATION_TICK_TIMING.ROUND_START, ownerId: null};
    case "roundEnd":
      return {unit: DURATION_UNITS.ROUNDS, tickOn: DURATION_TICK_TIMING.ROUND_END, ownerId: null};
    case "combatEnd":
      return {unit: DURATION_UNITS.COMBAT, tickOn: raw.tickOn ?? DURATION_TICK_TIMING.TURN_END, ownerId: null};
    default:
      return {
        unit: normalizeDurationUnit(raw),
        tickOn: normalizeDurationTick(raw),
        ownerId: raw.ownerId ?? targetId
      };
  }
}

function normalizeDurationUnit(raw) {
  const unit = String(raw.unit ?? (raw.rounds != null ? "rounds" : raw.turns != null ? "turns" : DURATION_UNITS.TURNS));
  switch ( unit ) {
    case "round":
    case "rounds":
      return DURATION_UNITS.ROUNDS;
    case "turn":
    case "turns":
      return DURATION_UNITS.TURNS;
    case "combat":
      return DURATION_UNITS.COMBAT;
    case "shortRest":
      return DURATION_UNITS.SHORT_REST;
    case "longRest":
      return DURATION_UNITS.LONG_REST;
    case "permanent":
      return DURATION_UNITS.PERMANENT;
    default:
      return unit;
  }
}

function normalizeDurationTick(raw) {
  const tick = raw.tickOn ?? raw.expires ?? raw.expiry ?? null;
  switch ( tick ) {
    case "turnStart":
    case "sourceTurnStart":
    case "targetTurnStart":
      return DURATION_TICK_TIMING.TURN_START;
    case "roundStart":
      return DURATION_TICK_TIMING.ROUND_START;
    case "roundEnd":
      return DURATION_TICK_TIMING.ROUND_END;
    case "turnEnd":
    case "sourceTurnEnd":
    case "targetTurnEnd":
    default:
      return DURATION_TICK_TIMING.TURN_END;
  }
}

function durationRemaining(raw) {
  const value = raw.remaining ?? raw.value ?? raw.rounds ?? raw.turns ?? 1;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(Math.floor(number), 0) : 0;
}

function concentrationBreakForEntry(entry, matcher) {
  const concentration = entry.lifecycle.concentration;
  if ( !concentration?.required || concentration.breakRemovesEffect === false ) return null;
  return matcher.findMatch([
    concentration.sourceRef,
    concentration.originRef,
    entry.lifecycle.sourceRef,
    entry.lifecycle.originRef
  ]);
}

function createConcentrationBreakMatcher({concentrationBreaks, events}) {
  const breaks = [
    ...collectionContents(concentrationBreaks),
    ...events.filter(event => CONCENTRATION_BREAK_EVENT_TYPES.has(event?.type))
  ].map(normalizeConcentrationBreak).filter(Boolean);
  return {
    findMatch(values) {
      const refs = values.map(normalizeRef).filter(Boolean);
      const ids = refs.map(refId).filter(Boolean);
      return breaks.find(entry => {
        if ( refs.some(ref => entry.refs.has(ref)) ) return true;
        return ids.some(id => entry.ids.has(id));
      }) ?? null;
    }
  };
}

function normalizeConcentrationBreak(value) {
  const refs = [];
  if ( typeof value === "string" ) refs.push(value);
  else if ( value && typeof value === "object" ) {
    refs.push(
      value.ref,
      value.sourceRef,
      value.originRef,
      value.actorRef,
      value.itemRef,
      value.data?.ref,
      value.data?.sourceRef,
      value.data?.originRef,
      value.data?.actorRef,
      value.data?.itemRef,
      value.source?.ref,
      value.source?.actorId ? actorRef(value.source.actorId) : null,
      value.actorId ? actorRef(value.actorId) : null,
      value.data?.actorId ? actorRef(value.data.actorId) : null
    );
  }

  const normalizedRefs = refs.map(normalizeRef).filter(Boolean);
  return normalizedRefs.length ? {
    refs: new Set(normalizedRefs),
    ids: new Set(normalizedRefs.map(refId).filter(Boolean)),
    event: clonePlain(value) ?? value
  } : null;
}

function normalizeTargetRef(target) {
  if ( !target ) return null;
  const ref = normalizeRef(target);
  if ( ref ) return {ref, id: refId(ref), actorId: ref.startsWith("actor:") ? refId(ref) : target.actorId ?? null};
  if ( typeof target !== "object" ) return null;
  return {
    ref: normalizeRef(target.ref ?? target),
    id: target.id ?? target.actorId ?? target.tokenId ?? target.uuid ?? null,
    uuid: target.uuid ?? null,
    actorId: target.actorId ?? target.actor?.id ?? null,
    tokenId: target.tokenId ?? target.token?.id ?? null,
    name: target.name ?? target.actor?.name ?? target.token?.name ?? null
  };
}

function actorTarget(actor) {
  if ( !actor ) return null;
  return {
    actorId: actor.id ?? null,
    uuid: actor.uuid ?? null,
    name: actor.name ?? null,
    type: actor.type ?? "actor"
  };
}

function normalizeRef(value) {
  if ( !value ) return null;
  return normalizeEntityRef(value) ?? (typeof value === "string" ? value : null);
}

function refId(value) {
  if ( !value ) return null;
  if ( typeof value === "object" ) return value.actorId ?? value.id ?? entityRefId(value.ref) ?? null;
  return entityRefId(value) ?? value;
}

function plainEffect(effect) {
  return effect?.toObject ? effect.toObject() : effect;
}

function normalizeConditionLevel(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : 1;
}

function collectionContents(collection) {
  if ( collection == null ) return [];
  if ( Array.isArray(collection) ) return collection;
  if ( collection instanceof Map ) return [...collection.values()];
  if ( typeof collection.values === "function" ) return [...collection.values()];
  if ( typeof collection === "object" ) return Object.values(collection);
  return [];
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
