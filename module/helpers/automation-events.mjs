import {ECONOMY_CAPABILITIES, resolvePaymentOptions, selectDefaultPaymentOption} from "./action-economy.mjs";
import {
  ENTITY_REF_KINDS,
  normalizeEntityRef as normalizeEntityRefString,
  parseEntityRef
} from "./entity-refs.mjs";
import {evaluatePredicate} from "./predicates.mjs";

export const AUTOMATION_EVENT_PHASES = Object.freeze({
  BEFORE: "before",
  INTERRUPT: "interrupt",
  AFTER: "after",
  INFORMATION: "information"
});

export const AUTOMATION_EVENT_TYPES = Object.freeze({
  ACTION_DECLARED: "action.declared",
  ACTION_VALIDATED: "action.validated",
  TARGETS_SELECTED: "targets.selected",
  PAYMENT_REQUIRED: "payment.required",
  PAYMENT_COMMITTED: "payment.committed",
  ATTACK_ROLL: "attack.roll",
  ATTACK_HIT: "attack.hit",
  ATTACK_MISS: "attack.miss",
  SAVE_ROLL: "save.roll",
  SAVE_SUCCESS: "save.success",
  SAVE_FAILURE: "save.failure",
  DAMAGE_APPLIED: "damage.applied",
  HEALING_APPLIED: "healing.applied",
  EFFECT_APPLIED: "effect.applied",
  MOVEMENT_STARTED: "movement.started",
  MOVEMENT_COMPLETED: "movement.completed",
  AREA_ENTERED: "area.entered",
  AREA_EXITED: "area.exited",
  TURN_STARTED: "turn.started",
  TURN_ENDED: "turn.ended",
  ROUND_STARTED: "round.started",
  ROUND_ENDED: "round.ended",
  REST_COMPLETED: "rest.completed"
});

export const AUTOMATION_TRIGGER_KINDS = Object.freeze({
  AUTOMATION: "automation",
  REACTION: "reaction"
});

export const AUTOMATION_CODES = Object.freeze({
  OK: "OK",
  DISABLED: "DISABLED",
  ALREADY_USED: "ALREADY_USED",
  TYPE_MISMATCH: "TYPE_MISMATCH",
  PHASE_MISMATCH: "PHASE_MISMATCH",
  ACTOR_MISMATCH: "ACTOR_MISMATCH",
  SOURCE_MISMATCH: "SOURCE_MISMATCH",
  TARGET_MISMATCH: "TARGET_MISMATCH",
  TAG_MISMATCH: "TAG_MISMATCH",
  PREDICATE_FAILED: "PREDICATE_FAILED",
  REACTION_ACTOR_MISSING: "REACTION_ACTOR_MISSING",
  REACTION_UNAVAILABLE: "REACTION_UNAVAILABLE"
});

/* -------------------------------------------- */

export function createAutomationEvent({
  id=null,
  type,
  phase=AUTOMATION_EVENT_PHASES.AFTER,
  actorId=null,
  tokenId=null,
  source=null,
  targets=[],
  tags=[],
  data={},
  metadata={}
}={}) {
  if ( !type ) throw new Error("AutomationEvent requires a type.");
  const normalizedSource = source ? normalizeEntityRef(source) : normalizeEntityRef({actorId, tokenId});
  return {
    id: id == null ? null : String(id),
    type,
    phase,
    actorId: actorId ?? normalizedSource.actorId,
    tokenId: tokenId ?? normalizedSource.tokenId,
    source: normalizedSource,
    targets: targets.map(normalizeEntityRef),
    tags: uniqueStrings(tags),
    data: clonePlain(data) ?? {},
    metadata: clonePlain(metadata) ?? {}
  };
}

/* -------------------------------------------- */

export function createTriggerDefinition({
  id,
  kind=AUTOMATION_TRIGGER_KINDS.AUTOMATION,
  event=null,
  match={},
  predicate=null,
  priority=100,
  once=false,
  enabled=true,
  payload={},
  owner=null,
  reaction=null,
  metadata={}
}={}) {
  if ( !id ) throw new Error("TriggerDefinition requires a stable id.");
  return {
    id: String(id),
    kind,
    event: normalizeEventMatcher(event, match),
    predicate,
    priority: Number(priority ?? 100),
    once: !!once,
    enabled: enabled !== false,
    payload: clonePlain(payload) ?? {},
    owner: owner ? normalizeEntityRef(owner) : null,
    reaction: reaction ? normalizeReaction(reaction) : null,
    metadata: clonePlain(metadata) ?? {}
  };
}

/* -------------------------------------------- */

export function createReactionTrigger({
  id,
  event,
  match={},
  actorId=null,
  tokenId=null,
  actionId=null,
  cost=null,
  predicate=null,
  priority=100,
  once=false,
  enabled=true,
  payload={},
  metadata={}
}={}) {
  return createTriggerDefinition({
    id,
    kind: AUTOMATION_TRIGGER_KINDS.REACTION,
    event,
    match,
    predicate,
    priority,
    once,
    enabled,
    payload,
    owner: {actorId, tokenId},
    reaction: {actorId, tokenId, actionId, cost},
    metadata
  });
}

/* -------------------------------------------- */

export function evaluateTrigger(trigger, event, context={}, usedTriggerIds=[]) {
  if ( !trigger.enabled ) return rejected(trigger, event, AUTOMATION_CODES.DISABLED);
  if ( trigger.once && new Set(usedTriggerIds).has(trigger.id) ) {
    return rejected(trigger, event, AUTOMATION_CODES.ALREADY_USED);
  }

  const match = matchAutomationEvent(trigger.event, event);
  if ( !match.ok ) return rejected(trigger, event, match.code, match.reason);

  const predicate = evaluatePredicate(trigger.predicate, {event, trigger, ...context});
  if ( !predicate.ok ) {
    return rejected(trigger, event, AUTOMATION_CODES.PREDICATE_FAILED, predicate.reason);
  }

  return {
    ok: true,
    code: AUTOMATION_CODES.OK,
    dispatch: createDispatchPlan(trigger, event)
  };
}

/* -------------------------------------------- */

export function collectTriggeredAutomations({triggers=[], event, context={}, usedTriggerIds=[]}={}) {
  const matches = [];
  const rejected = [];
  for ( const trigger of triggers ) {
    const evaluation = evaluateTrigger(trigger, event, context, usedTriggerIds);
    if ( evaluation.ok ) matches.push(evaluation.dispatch);
    else rejected.push(evaluation);
  }

  return {
    matches: matches.sort(compareDispatchPlans),
    rejected
  };
}

/* -------------------------------------------- */

export function dispatchAutomationEvents({events=[], triggers=[], context={}, usedTriggerIds=[]}={}) {
  const used = new Set(usedTriggerIds);
  const dispatches = [];
  const rejected = [];

  for ( const event of events ) {
    const result = collectTriggeredAutomations({
      triggers,
      event,
      context,
      usedTriggerIds: [...used]
    });
    dispatches.push(...result.matches);
    rejected.push(...result.rejected);
    for ( const dispatch of result.matches ) {
      if ( dispatch.once ) used.add(dispatch.triggerId);
    }
  }

  return {
    dispatches: dispatches.sort(compareDispatchPlans),
    rejected,
    usedTriggerIds: [...used].sort()
  };
}

/* -------------------------------------------- */

export function collectReactionWindows({
  triggers=[],
  event,
  resourcesByActor={},
  context={},
  usedTriggerIds=[],
  policies={}
}={}) {
  const reactionTriggers = triggers.filter(trigger => trigger.kind === AUTOMATION_TRIGGER_KINDS.REACTION);
  const result = collectTriggeredAutomations({triggers: reactionTriggers, event, context, usedTriggerIds});
  const windows = [];
  const rejected = [...result.rejected];

  for ( const dispatch of result.matches ) {
    const actorId = dispatch.reaction?.actorId ?? dispatch.owner?.actorId ?? null;
    if ( !actorId ) {
      rejected.push({...dispatch, ok: false, code: AUTOMATION_CODES.REACTION_ACTOR_MISSING});
      continue;
    }

    const resources = resourcesByActor[actorId] ?? [];
    const payment = resolvePaymentOptions({
      cost: dispatch.reaction?.cost ?? defaultReactionCost(),
      resources,
      action: dispatch.reaction?.action ?? {},
      policies
    });
    if ( payment.status !== "available" ) {
      rejected.push({
        ...dispatch,
        ok: false,
        code: AUTOMATION_CODES.REACTION_UNAVAILABLE,
        payment
      });
      continue;
    }

    windows.push({
      id: `reaction-window:${dispatch.triggerId}:${dispatch.eventId ?? "event"}`,
      triggerId: dispatch.triggerId,
      eventId: dispatch.eventId,
      actorId,
      tokenId: dispatch.reaction?.tokenId ?? dispatch.owner?.tokenId ?? null,
      actionId: dispatch.reaction?.actionId ?? null,
      priority: dispatch.priority,
      payload: clonePlain(dispatch.payload) ?? {},
      paymentOptions: payment.options.map(option => clonePlain(option)),
      selectedPaymentOption: clonePlain(selectDefaultPaymentOption(payment.options)),
      event: clonePlain(event)
    });
  }

  return {
    windows: windows.sort(compareReactionWindows),
    rejected
  };
}

/* -------------------------------------------- */

export function matchAutomationEvent(match, event) {
  if ( match.type && match.type !== event.type ) return fail(AUTOMATION_CODES.TYPE_MISMATCH);
  if ( match.phase && match.phase !== event.phase ) return fail(AUTOMATION_CODES.PHASE_MISMATCH);
  if ( match.actorId && match.actorId !== primaryActorId(event) ) return fail(AUTOMATION_CODES.ACTOR_MISMATCH);
  if ( match.sourceActorId && match.sourceActorId !== event.source?.actorId ) {
    return fail(AUTOMATION_CODES.SOURCE_MISMATCH);
  }
  if ( match.sourceTokenId && match.sourceTokenId !== event.source?.tokenId ) {
    return fail(AUTOMATION_CODES.SOURCE_MISMATCH);
  }
  if ( match.targetActorId && !targetActorIds(event).has(match.targetActorId) ) {
    return fail(AUTOMATION_CODES.TARGET_MISMATCH);
  }
  if ( match.targetActorIdsAny?.length && !match.targetActorIdsAny.some(id => targetActorIds(event).has(id)) ) {
    return fail(AUTOMATION_CODES.TARGET_MISMATCH);
  }
  if ( match.targetActorIdsAll?.length && !match.targetActorIdsAll.every(id => targetActorIds(event).has(id)) ) {
    return fail(AUTOMATION_CODES.TARGET_MISMATCH);
  }

  const tags = new Set(event.tags ?? []);
  if ( match.tagsAny?.length && !match.tagsAny.some(tag => tags.has(tag)) ) {
    return fail(AUTOMATION_CODES.TAG_MISMATCH);
  }
  if ( match.tagsAll?.length && !match.tagsAll.every(tag => tags.has(tag)) ) {
    return fail(AUTOMATION_CODES.TAG_MISMATCH);
  }
  if ( match.notTagsAny?.length && match.notTagsAny.some(tag => tags.has(tag)) ) {
    return fail(AUTOMATION_CODES.TAG_MISMATCH);
  }

  return {ok: true, code: AUTOMATION_CODES.OK};
}

/* -------------------------------------------- */

function createDispatchPlan(trigger, event) {
  return {
    id: `dispatch:${trigger.id}:${event.id ?? event.type}`,
    triggerId: trigger.id,
    eventId: event.id,
    eventType: event.type,
    eventPhase: event.phase,
    kind: trigger.kind,
    priority: trigger.priority,
    once: trigger.once,
    owner: trigger.owner ? clonePlain(trigger.owner) : null,
    reaction: trigger.reaction ? clonePlain(trigger.reaction) : null,
    payload: clonePlain(trigger.payload) ?? {},
    metadata: clonePlain(trigger.metadata) ?? {}
  };
}

function normalizeEventMatcher(event, match) {
  const matcher = typeof event === "string" ? {type: event} : clonePlain(event) ?? {};
  return {...matcher, ...clonePlain(match)};
}

function normalizeReaction(reaction) {
  return {
    actorId: reaction.actorId ?? null,
    tokenId: reaction.tokenId ?? null,
    actionId: reaction.actionId ?? null,
    cost: reaction.cost ? clonePlain(reaction.cost) : defaultReactionCost(),
    action: clonePlain(reaction.action ?? {}) ?? {}
  };
}

function defaultReactionCost() {
  return {allOf: [{capability: ECONOMY_CAPABILITIES.REACTION, amount: 1}]};
}

function normalizeEntityRef(entity={}) {
  const data = entity && typeof entity === "object" ? entity : {};
  const ref = normalizeEntityRefString(entity);
  const parsed = parseEntityRef(ref);
  const actorId = data.actorId ?? data.actor?.id ?? (parsed.kind === ENTITY_REF_KINDS.ACTOR ? parsed.id : null);
  const tokenId = data.tokenId ?? data.token?.id ?? (parsed.kind === ENTITY_REF_KINDS.TOKEN ? parsed.id : null);

  return {
    ref,
    id: data.id ?? tokenId ?? actorId ?? parsed.id ?? null,
    actorId,
    tokenId,
    type: data.type ?? null,
    disposition: data.disposition ?? null,
    tags: uniqueStrings(data.tags ?? [])
  };
}

function primaryActorId(event) {
  return event.actorId ?? event.source?.actorId ?? null;
}

function targetActorIds(event) {
  return new Set((event.targets ?? []).map(target => target.actorId).filter(Boolean));
}

function compareDispatchPlans(a, b) {
  const priority = (a.priority ?? 100) - (b.priority ?? 100);
  if ( priority ) return priority;
  return String(a.triggerId).localeCompare(String(b.triggerId));
}

function compareReactionWindows(a, b) {
  const priority = (a.priority ?? 100) - (b.priority ?? 100);
  if ( priority ) return priority;
  return String(a.triggerId).localeCompare(String(b.triggerId));
}

function rejected(trigger, event, code, reason=null) {
  return {
    ok: false,
    code,
    reason,
    triggerId: trigger.id,
    eventId: event?.id ?? null,
    eventType: event?.type ?? null
  };
}

function fail(code, reason=null) {
  return {ok: false, code, reason};
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => value != null).map(String))];
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
