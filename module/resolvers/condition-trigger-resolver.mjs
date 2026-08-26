import {
  AUTOMATION_EVENT_PHASES,
  AUTOMATION_EVENT_TYPES,
  collectTriggeredAutomations,
  createAutomationEvent
} from "../helpers/automation-events.mjs";
import {TIMELINE_EVENT_TYPES} from "../helpers/combat-timeline.mjs";
import {
  RULE_ELEMENT_TYPES,
  collectRuleElementContributions
} from "../helpers/rule-elements.mjs";
import {evaluateValueExpression} from "../helpers/value-expressions.mjs";
import {
  DURABILITY_CHANGE_TYPES,
  createActorDamageMutationPlan,
  createActorHealingMutationPlan
} from "./durability-resolver.mjs";

export const CONDITION_TRIGGER_CODES = Object.freeze({
  OK: "OK",
  INVALID_ACTOR_SYSTEM: "INVALID_ACTOR_SYSTEM",
  INVALID_PAYLOAD: "INVALID_TRIGGER_PAYLOAD",
  INVALID_VALUE: "INVALID_TRIGGER_VALUE",
  RULE_ELEMENT_FAILURE: "RULE_ELEMENT_FAILURE"
});

export const CONDITION_TRIGGER_PAYLOAD_TYPES = Object.freeze({
  DURABILITY_CHANGE: "durabilityChange"
});

const TIMELINE_TO_AUTOMATION_EVENT = Object.freeze({
  [TIMELINE_EVENT_TYPES.TURN_START]: AUTOMATION_EVENT_TYPES.TURN_STARTED,
  [TIMELINE_EVENT_TYPES.TURN_END]: AUTOMATION_EVENT_TYPES.TURN_ENDED,
  [TIMELINE_EVENT_TYPES.ROUND_START]: AUTOMATION_EVENT_TYPES.ROUND_STARTED,
  [TIMELINE_EVENT_TYPES.ROUND_END]: AUTOMATION_EVENT_TYPES.ROUND_ENDED,
  [TIMELINE_EVENT_TYPES.REST_COMPLETE]: AUTOMATION_EVENT_TYPES.REST_COMPLETED
});

/* -------------------------------------------- */

export function planConditionTriggerConsequences({
  actor=null,
  actorSystem=null,
  effects=null,
  events=[],
  context={},
  registry=undefined
}={}) {
  const system = clonePlain(actorSystem ?? actor?.system);
  if ( !system || typeof system !== "object" ) {
    return conditionTriggerFailure(CONDITION_TRIGGER_CODES.INVALID_ACTOR_SYSTEM, "Condition triggers require an Actor system snapshot.");
  }

  const actorRef = actorReference(actor);
  const automationEvents = normalizeConditionEvents(events, actor);
  const conditionEffects = normalizeConditionEffects(effects ?? actor?.effects ?? []);
  const snapshot = clonePlain(system);
  const dispatches = [];
  const mutationPlans = [];
  const skipped = [];
  const traces = [];
  const failures = [];

  for ( const effect of conditionEffects ) {
    const ruleElements = ruleElementsForConditionEffect(effect);
    if ( !ruleElements.length ) continue;

    const collected = collectRuleElementContributions({
      ruleElements,
      context: {
        actor,
        actorSystem: snapshot,
        effect,
        condition: {
          id: effect.system.type,
          level: effect.system.level
        },
        ...context
      },
      source: conditionEffectSource(effect),
      registry
    });
    traces.push(...collected.traces.map(trace => ({...trace, effect: conditionEffectSource(effect)})));
    if ( !collected.ok ) {
      failures.push(...collected.failures.map(failure => ({
        code: CONDITION_TRIGGER_CODES.RULE_ELEMENT_FAILURE,
        effect: conditionEffectSource(effect),
        failure
      })));
    }

    for ( const event of automationEvents ) {
      if ( !eventAppliesToActor(event, actor) ) continue;
      const triggered = collectTriggeredAutomations({
        triggers: collected.contributions.triggers,
        event,
        context: {
          actor,
          actorSystem: snapshot,
          effect,
          condition: {
            id: effect.system.type,
            level: effect.system.level
          },
          ...context
        }
      });
      skipped.push(...triggered.rejected.map(rejection => ({...rejection, effect: conditionEffectSource(effect)})));

      for ( const dispatch of triggered.matches ) {
        const planned = planConditionDispatchPayload(dispatch, {
          actor,
          actorSystem: snapshot,
          actorRef,
          effect,
          event,
          context
        });
        if ( planned.skipped ) {
          skipped.push(planned.skipped);
          continue;
        }
        dispatches.push({...dispatch, effect: conditionEffectSource(effect)});
        if ( !planned.ok ) {
          failures.push(planned);
          continue;
        }
        mutationPlans.push(planned.mutationPlan);
        applyUpdatesToActorSystemSnapshot(snapshot, planned.mutationPlan.updates);
      }
    }
  }

  return {
    ok: failures.length === 0,
    code: failures.length ? failures[0].code : CONDITION_TRIGGER_CODES.OK,
    events: automationEvents,
    dispatches,
    mutationPlans,
    skipped,
    traces,
    failures
  };
}

/* -------------------------------------------- */

function planConditionDispatchPayload(dispatch, {actor, actorSystem, actorRef, effect, event, context}) {
  const payload = dispatch.payload ?? {};
  const payloadType = payload.type ?? payload.kind ?? null;
  if ( payloadType !== CONDITION_TRIGGER_PAYLOAD_TYPES.DURABILITY_CHANGE ) {
    return {
      skipped: {
        code: CONDITION_TRIGGER_CODES.INVALID_PAYLOAD,
        reason: `ConditionTriggerResolver does not own payload type: ${payloadType ?? "<missing>"}`,
        triggerId: dispatch.triggerId,
        eventId: dispatch.eventId,
        effect: conditionEffectSource(effect)
      }
    };
  }

  const changeType = payload.changeType ?? payload.change ?? DURABILITY_CHANGE_TYPES.DAMAGE;
  if ( !Object.values(DURABILITY_CHANGE_TYPES).includes(changeType) ) {
    return conditionTriggerFailure(CONDITION_TRIGGER_CODES.INVALID_PAYLOAD, `Unsupported durability change type: ${changeType}`, {
      dispatch,
      effect: conditionEffectSource(effect)
    });
  }

  const amountExpression = payload.amount ?? payload.value;
  if ( amountExpression == null ) {
    return conditionTriggerFailure(CONDITION_TRIGGER_CODES.INVALID_PAYLOAD, "Durability-change trigger payload requires an amount.", {
      dispatch,
      effect: conditionEffectSource(effect)
    });
  }

  const amount = evaluateValueExpression(amountExpression, {
    actor,
    actorSystem,
    effect,
    event,
    dispatch,
    payload,
    ...context
  });
  if ( !amount.ok ) {
    return conditionTriggerFailure(CONDITION_TRIGGER_CODES.INVALID_VALUE, amount.reason, {
      dispatch,
      effect: conditionEffectSource(effect),
      valueResult: amount
    });
  }
  if ( amount.value < 0 ) {
    return conditionTriggerFailure(CONDITION_TRIGGER_CODES.INVALID_VALUE, "Durability-change trigger amount must be non-negative.", {
      dispatch,
      effect: conditionEffectSource(effect)
    });
  }

  const resourceId = payload.resourceId ?? payload.resource ?? "health";
  const metadata = {
    conditionTrigger: {
      triggerId: dispatch.triggerId,
      dispatchId: dispatch.id,
      eventType: event.type,
      effect: conditionEffectSource(effect),
      payloadType
    },
    damageType: payload.damageType ?? null,
    tags: uniqueStrings(payload.tags ?? [])
  };
  const source = {
    type: "conditionTrigger",
    triggerId: dispatch.triggerId,
    effect: conditionEffectSource(effect),
    ruleElement: dispatch.metadata?.ruleElement ?? null
  };
  const options = {
    amount: amount.value,
    resourceId,
    source,
    target: actorRef,
    metadata
  };
  const mutationPlan = changeType === DURABILITY_CHANGE_TYPES.HEALING
    ? createActorHealingMutationPlan(actorSystem, options)
    : createActorDamageMutationPlan(actorSystem, options);
  if ( !mutationPlan.ok ) {
    return conditionTriggerFailure(mutationPlan.code, mutationPlan.reason, {
      dispatch,
      effect: conditionEffectSource(effect),
      mutationPlan
    });
  }

  return {
    ok: true,
    code: CONDITION_TRIGGER_CODES.OK,
    dispatch,
    effect: conditionEffectSource(effect),
    mutationPlan
  };
}

function ruleElementsForConditionEffect(effect) {
  const ruleElements = collectionContents(effect.system?.ruleElements ?? []);
  if ( ruleElements.length ) return ruleElements;
  return legacyDotRuleElements(effect);
}

function legacyDotRuleElements(effect) {
  return collectionContents(effect.system?.dot ?? []).map((tick, index) => ({
    schemaVersion: 1,
    id: `legacy-dot:${effect.id ?? effect.system?.type ?? "condition"}:${index}`,
    type: RULE_ELEMENT_TYPES.TRIGGER,
    label: `${effect.system?.type ?? "Condition"} legacy tick`,
    data: {
      event: AUTOMATION_EVENT_TYPES.TURN_STARTED,
      payload: {
        type: CONDITION_TRIGGER_PAYLOAD_TYPES.DURABILITY_CHANGE,
        changeType: tick.restoration ? DURABILITY_CHANGE_TYPES.HEALING : DURABILITY_CHANGE_TYPES.DAMAGE,
        resourceId: tick.resource ?? "health",
        amount: {type: "constant", value: Number(tick.amount ?? 0) || 0},
        tags: ["condition", "legacy-dot", effect.system?.type].filter(Boolean)
      }
    },
    metadata: {
      compatibility: {
        legacyDot: true,
        sourcePath: "system.dot"
      }
    }
  }));
}

function normalizeConditionEffects(effects) {
  return collectionContents(effects)
    .map(normalizeConditionEffect)
    .filter(Boolean);
}

function normalizeConditionEffect(effect) {
  if ( !effect || typeof effect !== "object" ) return null;
  if ( effect.disabled === true ) return null;
  const conditionId = effect.system?.type ?? effect.conditionId ?? effect.typeId ?? null;
  if ( effect.type && effect.type !== "condition" && !conditionId ) return null;
  if ( !conditionId ) return null;
  return {
    id: effect.id ?? effect.effectId ?? null,
    uuid: effect.uuid ?? null,
    type: "condition",
    name: effect.name ?? null,
    disabled: false,
    system: {
      type: String(conditionId),
      level: effect.system?.level ?? effect.level ?? null,
      ruleElements: collectionContents(effect.system?.ruleElements ?? []).map(clonePlain),
      dot: collectionContents(effect.system?.dot ?? []).map(clonePlain)
    }
  };
}

function normalizeConditionEvents(events, actor) {
  const supplied = collectionContents(events);
  const sourceEvents = supplied.length ? supplied : [defaultTurnStartedEvent(actor)];
  return sourceEvents.map(event => normalizeConditionEvent(event, actor)).filter(Boolean);
}

function normalizeConditionEvent(event, actor) {
  if ( !event || typeof event !== "object" ) return null;
  const type = TIMELINE_TO_AUTOMATION_EVENT[event.type] ?? event.type;
  if ( !type ) return null;
  return createAutomationEvent({
    id: event.id ?? event.eventId ?? null,
    type,
    phase: event.phase ?? AUTOMATION_EVENT_PHASES.INFORMATION,
    actorId: event.actorId ?? event.source?.actorId ?? null,
    tokenId: event.tokenId ?? event.source?.tokenId ?? null,
    source: event.source ?? {
      actorId: event.actorId ?? event.source?.actorId ?? null,
      tokenId: event.tokenId ?? event.source?.tokenId ?? null
    },
    targets: event.targets ?? [],
    tags: event.tags ?? [],
    data: {
      ...(clonePlain(event.data ?? {}) ?? {}),
      timeline: clonePlain(event)
    },
    metadata: {
      ...(clonePlain(event.metadata ?? {}) ?? {}),
      timelineType: event.type
    }
  });
}

function defaultTurnStartedEvent(actor) {
  return {
    type: TIMELINE_EVENT_TYPES.TURN_START,
    actorId: actor?.id ?? actor?.actorId ?? null,
    tokenId: actor?.token?.id ?? null
  };
}

function eventAppliesToActor(event, actor) {
  const actorId = actor?.id ?? actor?.actorId ?? null;
  if ( !actorId || !event.actorId ) return true;
  return event.actorId === actorId;
}

function actorReference(actor) {
  return {
    ref: actor?.uuid ? `uuid:${actor.uuid}` : actor?.id ? `actor:${actor.id}` : null,
    id: actor?.id ?? actor?.actorId ?? null,
    uuid: actor?.uuid ?? null,
    name: actor?.name ?? null,
    type: "actor"
  };
}

function conditionEffectSource(effect) {
  return {
    type: "effect",
    uuid: effect.uuid ?? null,
    id: effect.id ?? null,
    name: effect.name ?? null,
    conditionId: effect.system?.type ?? null
  };
}

function applyUpdatesToActorSystemSnapshot(actorSystem, updates={}) {
  for ( const [path, value] of Object.entries(updates) ) {
    setPath(actorSystem, path.replace(/^system\./, ""), value);
  }
}

function setPath(object, path, value) {
  const keys = String(path).split(".").filter(Boolean);
  const final = keys.pop();
  if ( !final ) return;
  const target = keys.reduce((entry, key) => entry?.[key], object);
  if ( target && typeof target === "object" ) target[final] = value;
}

function conditionTriggerFailure(code, reason, data={}) {
  return {
    ok: false,
    code,
    reason,
    ...data
  };
}

function collectionContents(collection) {
  if ( collection == null ) return [];
  if ( Array.isArray(collection) ) return collection;
  if ( collection instanceof Map ) return [...collection.values()];
  if ( typeof collection.values === "function" ) return [...collection.values()];
  if ( typeof collection === "object" ) return Object.values(collection);
  return [];
}

function uniqueStrings(values) {
  const array = Array.isArray(values) ? values : values == null ? [] : [values];
  return [...new Set(array.filter(value => value != null && value !== "").map(String))];
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
