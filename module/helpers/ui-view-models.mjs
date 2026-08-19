import {
  economyResourcesFromActorResources,
  normalizeActivationCost,
  resolvePaymentOptions,
  selectDefaultPaymentOption
} from "./action-economy.mjs";
import {computeActivationCost} from "./actions.mjs";
import {
  actorRef as createActorRef,
  createEntityRef,
  ENTITY_REF_KINDS,
  itemRef,
  normalizeEntityRef,
  tokenRef
} from "./entity-refs.mjs";
import {createCombatTimeline} from "./combat-timeline.mjs";

export const UI_COMMAND_TYPES = Object.freeze({
  USE_ACTION: "action.use",
  SELECT_ACTION: "action.select",
  START_ACTOR_TURN: "actor.startTurn",
  ADVANCE_COMBAT_TURN: "combat.advanceTurn",
  SUBMIT_CONCENTRATION_CHECK_RESULT: "concentrationCheck.submitResult",
  COMMIT_CONCENTRATION_CHECK_RESULTS: "concentrationCheck.commitResults"
});

export const ACTION_BAR_ENTRY_STATES = Object.freeze({
  READY: "ready",
  SELECTED: "selected",
  UNAVAILABLE: "unavailable"
});

export const CONCENTRATION_CHECK_PROMPT_STATES = Object.freeze({
  PENDING: "pending",
  RESOLVED: "resolved"
});

/* -------------------------------------------- */

export function createActionBarViewModel({
  actor=null,
  actorRef=null,
  actorSystem=null,
  actions=null,
  policies={},
  selectedActionRef=null,
  selectedActionId=null
}={}) {
  const sourceRef = normalizeEntityRef(actorRef)
    ?? normalizeEntityRef(actor, {kind: ENTITY_REF_KINDS.ACTOR});
  const system = actorSystem ?? actor?.system ?? {};
  const resources = economyResourcesFromActorResources(system);
  const resourceViews = resources.map(createEconomyResourceView);
  const selectedRef = selectedActionRef ? normalizeActionRef({ref: selectedActionRef}) : null;
  const actionInputs = (actions ?? collectionContents(actor?.items) ?? []).filter(isActionBarAction);
  const actionViews = actionInputs.map(action => createActionBarEntry({
    action,
    actorRef: sourceRef,
    resources,
    policies,
    selectedActionRef: selectedRef,
    selectedActionId
  }));

  return {
    actorRef: sourceRef,
    actorName: actor?.name ?? null,
    resources: resourceViews,
    actions: actionViews,
    groups: groupActionEntries(actionViews),
    summary: {
      actionCount: actionViews.length,
      readyCount: actionViews.filter(action => action.enabled).length,
      unavailableCount: actionViews.filter(action => !action.enabled).length,
      depletedResourceCount: resourceViews.filter(resource => resource.depleted).length
    }
  };
}

/* -------------------------------------------- */

export function createCombatCarouselViewModel({
  combat=null,
  timeline=null,
  combatants=null,
  round=null,
  turn=null,
  actorNames={},
  tokenNames={},
  resourcesByActorRef={},
  statusesByActorRef={},
  includeHidden=true
}={}) {
  const normalized = normalizeTimeline({combat, timeline, combatants, round, turn});
  const activeIndex = normalized.combatants.length ? normalized.turn : -1;
  const allTurns = normalized.combatants.map((combatant, index) => createCarouselTurn({
    combatId: normalized.id,
    combatant,
    index,
    turnCount: normalized.combatants.length,
    activeIndex,
    actorNames,
    tokenNames,
    resourcesByActorRef,
    statusesByActorRef
  }));
  const turns = includeHidden ? allTurns : allTurns.filter(entry => !entry.hidden);
  const active = allTurns[activeIndex] ?? null;

  return {
    combatRef: createEntityRef(ENTITY_REF_KINDS.COMBAT, normalized.id),
    round: normalized.round,
    turn: normalized.turn,
    activeRef: active?.ref ?? null,
    activeActorRef: active?.actorRef ?? null,
    activeTokenRef: active?.tokenRef ?? null,
    turns,
    previous: active ? allTurns[previousIndex(activeIndex, allTurns.length)] ?? null : null,
    next: active ? allTurns[nextIndex(activeIndex, allTurns.length)] ?? null : null,
    commands: {
      advanceTurn: normalized.combatants.length ? {
        type: UI_COMMAND_TYPES.ADVANCE_COMBAT_TURN,
        combatRef: createEntityRef(ENTITY_REF_KINDS.COMBAT, normalized.id)
      } : null,
      startActiveTurn: active?.actorRef ? {
        type: UI_COMMAND_TYPES.START_ACTOR_TURN,
        actorRef: active.actorRef,
        tokenRef: active.tokenRef
      } : null
    },
    summary: {
      combatantCount: allTurns.length,
      visibleCount: turns.length,
      hiddenCount: allTurns.filter(entry => entry.hidden).length,
      defeatedCount: allTurns.filter(entry => entry.defeated).length
    }
  };
}

/* -------------------------------------------- */

export function createConcentrationCheckPromptViewModel({
  checkRequests=[],
  checkPlanning=null,
  concentrationChecks=null,
  rolls=[],
  results=[],
  actorNames={},
  itemNames={},
  defaultMode="digital",
  allowPhysical=true,
  metadata={}
}={}) {
  const requests = normalizeCheckRequests({checkRequests, checkPlanning, concentrationChecks});
  const checks = requests.map(request => createConcentrationCheckPromptEntry({
    request,
    rolls,
    results,
    actorNames,
    itemNames,
    defaultMode,
    allowPhysical
  }));
  const pending = checks.filter(check => check.state === CONCENTRATION_CHECK_PROMPT_STATES.PENDING);
  const resolved = checks.filter(check => check.state === CONCENTRATION_CHECK_PROMPT_STATES.RESOLVED);

  return {
    checks,
    pending,
    resolved,
    commitCommand: checks.length && !pending.length ? {
      type: UI_COMMAND_TYPES.COMMIT_CONCENTRATION_CHECK_RESULTS,
      requestIds: checks.map(check => check.id),
      actorRefs: uniqueStrings(checks.map(check => check.actorRef)),
      sourceRefs: uniqueStrings(checks.map(check => check.sourceRef))
    } : null,
    summary: {
      checkCount: checks.length,
      pendingCount: pending.length,
      resolvedCount: resolved.length,
      highestDC: checks.reduce((highest, check) => Math.max(highest, check.dc ?? 0), 0)
    },
    metadata: clonePlain(metadata) ?? {}
  };
}

/* -------------------------------------------- */

export function createEconomyResourceView(resource) {
  const maximum = Math.max(Number(resource.maximum ?? resource.max ?? 0) || 0, 0);
  const current = clamp(Number(resource.current ?? resource.value ?? 0) || 0, 0, maximum);
  return {
    id: String(resource.id),
    category: resource.category ?? resource.id,
    label: resource.metadata?.label ?? labelFromId(resource.category ?? resource.id),
    current,
    maximum,
    unit: resource.unit ?? "uses",
    depleted: current <= 0 && maximum > 0,
    full: maximum > 0 && current >= maximum,
    ratio: maximum > 0 ? current / maximum : 0,
    paymentCapabilities: uniqueStrings(resource.paymentCapabilities ?? []),
    refreshEvents: uniqueStrings((resource.refreshPolicies ?? []).map(policy => policy.event ?? policy)),
    source: resource.source ? clonePlain(resource.source) : null
  };
}

/* -------------------------------------------- */

function createActionBarEntry({
  action,
  actorRef,
  resources,
  policies,
  selectedActionRef=null,
  selectedActionId=null
}) {
  const ref = normalizeActionRef(action);
  const activationCost = actionActivationCost(action);
  const cost = summarizeActivationCost(activationCost);
  const actionData = {
    id: action?.id ?? action?.uuid ?? ref,
    ref,
    type: action?.type ?? "action",
    name: action?.name ?? null,
    tags: uniqueStrings(action?.tags ?? action?.system?.tags ?? [])
  };
  const discovery = resolvePaymentOptions({cost: activationCost, resources, action: actionData, policies});
  const defaultPayment = selectDefaultPaymentOption(discovery.options);
  const selected = Boolean((selectedActionRef && selectedActionRef === ref)
    || (selectedActionId != null && String(selectedActionId) === String(actionData.id)));
  const enabled = discovery.status === "available";

  return {
    id: actionData.id == null ? null : String(actionData.id),
    ref,
    label: action?.name ?? action?.label ?? ref ?? "Action",
    img: action?.img ?? action?.icon ?? null,
    type: actionData.type,
    group: primaryCostCapability(cost) ?? actionData.type,
    tags: actionData.tags,
    enabled,
    selected,
    state: !enabled
      ? ACTION_BAR_ENTRY_STATES.UNAVAILABLE
      : selected ? ACTION_BAR_ENTRY_STATES.SELECTED : ACTION_BAR_ENTRY_STATES.READY,
    disabledCode: enabled ? null : discovery.code,
    cost,
    payment: {
      status: discovery.status,
      code: discovery.code,
      defaultOptionId: defaultPayment?.id ?? null,
      options: discovery.options.map(summarizePaymentOption),
      failures: discovery.failures.map(summarizePaymentFailure)
    },
    command: enabled ? {
      type: UI_COMMAND_TYPES.USE_ACTION,
      actorRef,
      actionRef: ref,
      actionId: actionData.id == null ? null : String(actionData.id),
      selectedPaymentOptionId: defaultPayment?.id ?? null
    } : null,
    previewCommand: {
      type: UI_COMMAND_TYPES.SELECT_ACTION,
      actorRef,
      actionRef: ref,
      actionId: actionData.id == null ? null : String(actionData.id)
    },
    metadata: clonePlain(action?.metadata ?? {})
  };
}

function normalizeActionRef(action) {
  if ( typeof action === "string" ) return normalizeEntityRef(action);
  return normalizeEntityRef(action?.ref)
    ?? (action?.uuid ? normalizeEntityRef({uuid: action.uuid}) : null)
    ?? (action?.id ? itemRef(action.id) : null);
}

function actionActivationCost(action) {
  if ( typeof action?.system?.getActivationCost === "function" ) {
    return clonePlain(action.system.getActivationCost());
  }
  if ( isActivationCost(action?.activationCost) ) return clonePlain(action.activationCost);
  if ( isActivationCost(action?.system?.activationCost) ) return clonePlain(action.system.activationCost);
  if ( isActivationCost(action?.cost) ) return clonePlain(action.cost);
  return computeActivationCost(action?.system?.cost ?? action?.cost ?? {});
}

function summarizeActivationCost(cost) {
  const normalized = normalizeActivationCost(cost);
  const branches = normalized.anyOf ?? [normalized.allOf ?? []];
  return {
    branches: branches.map(branch => branch.map(requirement => ({
      capability: requirement.capability,
      amount: requirement.amount,
      unit: requirement.unit ?? null
    }))),
    isFree: branches.every(branch => branch.length === 0)
  };
}

function summarizePaymentOption(option) {
  return {
    id: option.id,
    resources: (option.resources ?? []).map(payment => ({
      resourceId: payment.resourceId,
      capability: payment.capability,
      amount: payment.amount,
      mode: payment.mode,
      alternativeFor: payment.alternativeFor ?? null,
      policy: payment.policy ?? null
    })),
    trace: clonePlain(option.trace ?? [])
  };
}

function summarizePaymentFailure(failure) {
  return {
    resourceId: failure.resourceId ?? failure.resource?.id ?? null,
    capability: failure.capability ?? failure.requirement?.capability ?? null,
    code: failure.code ?? null,
    reason: failure.reason ?? null
  };
}

function groupActionEntries(actions) {
  const groups = new Map();
  for ( const action of actions ) {
    const group = action.group ?? "other";
    const entry = groups.get(group) ?? {id: group, label: labelFromId(group), actions: []};
    entry.actions.push(action.ref);
    groups.set(group, entry);
  }
  return [...groups.values()];
}

function primaryCostCapability(cost) {
  return cost.branches.find(branch => branch.length)?.[0]?.capability ?? "free";
}

function isActivationCost(cost) {
  return Array.isArray(cost) || !!cost?.allOf || !!cost?.anyOf || !!cost?.requirements;
}

/* -------------------------------------------- */

function normalizeCheckRequests({checkRequests, checkPlanning, concentrationChecks}) {
  const sources = [
    checkRequestContents(checkRequests),
    checkRequestContents(checkPlanning),
    checkRequestContents(concentrationChecks)
  ];
  return sources.find(source => source.length)?.map(clonePlain) ?? [];
}

function checkRequestContents(value) {
  if ( isConcentrationCheckRequest(value) ) return [value];
  if ( value?.checkRequests ) return collectionContents(value.checkRequests)?.filter(isConcentrationCheckRequest) ?? [];
  return collectionContents(value)?.filter(isConcentrationCheckRequest) ?? [];
}

function isConcentrationCheckRequest(value) {
  return Boolean(value && typeof value === "object" && value.id && value.dc != null);
}

function createConcentrationCheckPromptEntry({
  request,
  rolls,
  results,
  actorNames,
  itemNames,
  defaultMode,
  allowPhysical
}) {
  const actorRef = normalizeEntityRef(request.actorRef) ?? (request.actorId ? createActorRef(request.actorId) : null);
  const sourceRef = normalizeEntityRef(request.sourceRef) ?? actorRef;
  const originRef = normalizeEntityRef(request.originRef);
  const itemReference = normalizeEntityRef(request.itemRef);
  const targetRef = normalizeEntityRef(request.targetRef);
  const supplied = findConcentrationPromptResult({request, rolls, results});
  const result = supplied ? summarizeConcentrationPromptResult(supplied.value, supplied.matchedBy) : null;
  const state = result
    ? CONCENTRATION_CHECK_PROMPT_STATES.RESOLVED
    : CONCENTRATION_CHECK_PROMPT_STATES.PENDING;

  return {
    id: String(request.id),
    type: request.type ?? "damage",
    actorId: request.actorId ?? null,
    actorRef,
    sourceRef,
    originRef,
    itemRef: itemReference,
    targetRef,
    actorLabel: lookupByRefOrId(actorNames, actorRef, request.actorId)
      ?? request.target?.name
      ?? request.actorId
      ?? actorRef
      ?? "Actor",
    originLabel: lookupByRefOrId(itemNames, originRef, entityIdFromRef(originRef))
      ?? lookupByRefOrId(itemNames, itemReference, entityIdFromRef(itemReference))
      ?? originRef
      ?? itemReference
      ?? null,
    dc: finiteNumber(request.dc),
    ability: request.ability ?? "con",
    saveKey: request.saveKey ?? "concentration",
    damageTaken: finiteNumber(request.damageTaken),
    state,
    result,
    command: {
      type: UI_COMMAND_TYPES.SUBMIT_CONCENTRATION_CHECK_RESULT,
      requestId: String(request.id),
      actorRef,
      sourceRef,
      targetRef,
      dc: finiteNumber(request.dc),
      ability: request.ability ?? "con",
      mode: defaultMode
    },
    physicalCommand: allowPhysical ? {
      type: UI_COMMAND_TYPES.SUBMIT_CONCENTRATION_CHECK_RESULT,
      requestId: String(request.id),
      actorRef,
      sourceRef,
      targetRef,
      dc: finiteNumber(request.dc),
      ability: request.ability ?? "con",
      mode: "physical"
    } : null,
    metadata: clonePlain(request.metadata ?? {})
  };
}

function findConcentrationPromptResult({request, rolls, results}) {
  for ( const collection of [results, rolls] ) {
    const entries = keyedPromptResultEntries(collection);
    const requestRefs = concentrationPromptLookupRefs(request);
    for ( const entry of entries ) {
      const resultRefs = concentrationPromptResultRefs(entry.value, entry.key);
      if ( resultRefs.some(ref => requestRefs.includes(ref)) ) {
        return {
          value: entry.value,
          matchedBy: resultRefs.find(ref => requestRefs.includes(ref)) ?? null
        };
      }
    }
    if ( requestRefs.length && entries.length === 1 && isPromptResultValue(entries[0].value) ) {
      return {value: entries[0].value, matchedBy: "single-check"};
    }
  }
  return null;
}

function keyedPromptResultEntries(collection) {
  if ( collection == null ) return [];
  if ( isPromptResultValue(collection) || finiteNumber(collection) != null ) {
    return [{key: null, value: collection}];
  }
  if ( Array.isArray(collection) ) return collection.map((value, index) => ({key: String(index), value}));
  if ( collection instanceof Map ) return [...collection.entries()].map(([key, value]) => ({key: String(key), value}));
  if ( collection instanceof Set ) return [...collection.values()].map((value, index) => ({key: String(index), value}));
  if ( typeof collection === "object" ) return Object.entries(collection).map(([key, value]) => ({key, value}));
  return [];
}

function isPromptResultValue(value) {
  if ( finiteNumber(value) != null ) return true;
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

function concentrationPromptLookupRefs(request) {
  return uniqueStrings([
    request.id,
    request.actorId,
    request.actorRef,
    request.sourceRef,
    request.targetRef,
    request.target?.id,
    request.target?.actorId,
    request.actorId ? createActorRef(request.actorId) : null,
    request.target?.actorId ? createActorRef(request.target.actorId) : null
  ]);
}

function concentrationPromptResultRefs(result, key) {
  const data = result && typeof result === "object" ? result : {};
  return uniqueStrings([
    key,
    data.requestId,
    data.checkId,
    data.id,
    data.ref,
    data.actorId,
    data.actorRef,
    data.sourceRef,
    data.targetRef,
    data.target?.id,
    data.target?.actorId,
    data.actorId ? createActorRef(data.actorId) : null,
    data.target?.actorId ? createActorRef(data.target.actorId) : null
  ]);
}

function summarizeConcentrationPromptResult(value, matchedBy) {
  const source = finiteNumber(value) != null ? {total: finiteNumber(value)} : value ?? {};
  const roll = source.roll ?? source.save ?? source;
  return {
    total: finiteNumber(roll?.total ?? roll?.value ?? roll?.amount),
    outcome: normalizePromptOutcome(source),
    mode: roll?.mode ?? source.mode ?? null,
    matchedBy,
    metadata: clonePlain(source.metadata ?? {})
  };
}

function normalizePromptOutcome(value) {
  if ( value.success === true || value.passed === true || value.maintained === true ) return "maintained";
  if ( value.success === false || value.passed === false || value.failed === true ) return "broken";
  const label = String(value.outcome ?? value.result ?? value.status ?? "")
    .trim()
    .toLowerCase();
  if ( ["kept", "maintained", "success", "succeeded", "passed"].includes(label) ) return "maintained";
  if ( ["broken", "lost", "fail", "failed", "failure"].includes(label) ) return "broken";
  return null;
}

function entityIdFromRef(ref) {
  if ( !ref || typeof ref !== "string" ) return null;
  const separator = ref.indexOf(":");
  return separator >= 0 ? ref.slice(separator + 1) : ref;
}

/* -------------------------------------------- */

function normalizeTimeline({combat, timeline, combatants, round, turn}) {
  if ( timeline ) return createCombatTimeline({
    ...timeline,
    combatants: prepareCombatants(timeline.combatants ?? [], timeline)
  });
  const sourceCombatants = combatants ?? combat?.turns ?? collectionContents(combat?.combatants) ?? [];
  return createCombatTimeline({
    id: combat?.id ?? "combat",
    round: round ?? combat?.round ?? 1,
    turn: turn ?? combat?.turn ?? 0,
    combatants: prepareCombatants(sourceCombatants, combat)
  });
}

function prepareCombatants(combatants, combat=null) {
  return combatants.map(combatant => ({
    id: combatant.id ?? combatant.combatantId ?? combatant.tokenId,
    actorId: combatant.actorId ?? combatant.actor?.id ?? null,
    tokenId: combatant.tokenId ?? combatant.token?.id ?? null,
    initiative: combatant.initiative ?? null,
    defeated: !!combatant.defeated,
    hidden: !!combatant.hidden,
    metadata: {
      label: combatant.metadata?.label
        ?? combatant.name
        ?? combatant.actor?.name
        ?? combatant.token?.name
        ?? null,
      sceneId: combatant.metadata?.sceneId
        ?? combatant.sceneId
        ?? combat?.scene?.id
        ?? combatant.token?.scene?.id
        ?? combatant.token?.parent?.id
        ?? null,
      ...(combatant.metadata ?? {})
    }
  }));
}

function collectionContents(collection) {
  if ( !collection ) return null;
  if ( Array.isArray(collection) ) return collection;
  if ( Array.isArray(collection.contents) ) return collection.contents;
  if ( typeof collection.values === "function" ) return [...collection.values()];
  return null;
}

function isActionBarAction(action) {
  if ( typeof action === "string" ) return true;
  return action?.type === "action"
    || !!action?.activationCost
    || !!action?.cost
    || !!action?.system?.activationCost
    || !!action?.system?.cost
    || typeof action?.system?.getActivationCost === "function";
}

function createCarouselTurn({
  combatId,
  combatant,
  index,
  turnCount,
  activeIndex,
  actorNames,
  tokenNames,
  resourcesByActorRef,
  statusesByActorRef
}) {
  const actorRef = combatant.actorId ? createActorRef(combatant.actorId) : null;
  const tokenReference = combatant.tokenId
    ? tokenRef(combatant.tokenId, {sceneId: combatant.metadata?.sceneId ?? null})
    : null;
  const ref = createEntityRef(ENTITY_REF_KINDS.COMBATANT, combatant.id, {scope: combatId});
  const resources = resourceViewsForActor(resourcesByActorRef, actorRef, combatant.actorId);
  const statuses = valuesForActor(statusesByActorRef, actorRef, combatant.actorId);

  return {
    id: combatant.id,
    ref,
    actorRef,
    tokenRef: tokenReference,
    label: combatant.metadata?.label
      ?? combatant.metadata?.name
      ?? lookupByRefOrId(actorNames, actorRef, combatant.actorId)
      ?? lookupByRefOrId(tokenNames, tokenReference, combatant.tokenId)
      ?? combatant.id,
    index,
    initiative: combatant.initiative,
    active: index === activeIndex,
    previous: index === previousIndex(activeIndex, turnCount),
    next: index === nextIndex(activeIndex, turnCount),
    distanceFromActive: activeIndex < 0 ? null : relativeTurnDistance(index, activeIndex, turnCount),
    defeated: combatant.defeated,
    hidden: combatant.hidden,
    resources,
    statuses,
    command: actorRef ? {
      type: UI_COMMAND_TYPES.START_ACTOR_TURN,
      actorRef,
      tokenRef: tokenReference
    } : null,
    metadata: clonePlain(combatant.metadata ?? {})
  };
}

function resourceViewsForActor(resourcesByActorRef, actorRef, actorId) {
  const resources = valuesForActor(resourcesByActorRef, actorRef, actorId);
  return resources.map(resource => resource?.id ? createEconomyResourceView(resource) : clonePlain(resource));
}

function valuesForActor(valuesByActorRef, actorRef, actorId) {
  const values = lookupByRefOrId(valuesByActorRef, actorRef, actorId) ?? [];
  return Array.isArray(values) ? values.map(clonePlain) : [];
}

function lookupByRefOrId(values, ref, id) {
  if ( ref && values?.[ref] != null ) return values[ref];
  if ( id && values?.[id] != null ) return values[id];
  return null;
}

function previousIndex(index, count) {
  if ( count <= 0 ) return -1;
  return (index - 1 + count) % count;
}

function nextIndex(index, count) {
  if ( count <= 0 ) return -1;
  return (index + 1) % count;
}

function relativeTurnDistance(index, activeIndex, count) {
  if ( count <= 0 ) return null;
  const forward = (index - activeIndex + count) % count;
  const backward = forward - count;
  return Math.abs(forward) <= Math.abs(backward) ? forward : backward;
}

/* -------------------------------------------- */

function labelFromId(id) {
  return String(id ?? "unknown")
    .split(/[.\-_]/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function finiteNumber(value) {
  if ( value == null || value === "" ) return null;
  if ( typeof value === "object" || typeof value === "function" || typeof value === "boolean" ) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => value != null).map(String))];
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
