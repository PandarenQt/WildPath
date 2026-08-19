import {
  AUTOMATION_EVENT_PHASES,
  AUTOMATION_EVENT_TYPES,
  createAutomationEvent
} from "./automation-events.mjs";

export const ACTION_RESOLUTION_STAGES = Object.freeze({
  DECLARATION: "declaration",
  VALIDATION: "validation",
  TARGETING: "targeting",
  RESOURCE_PAYMENT: "resourcePayment",
  ROLL: "roll",
  OUTCOME: "outcome",
  CONSEQUENCE: "consequence",
  EFFECTS: "effects",
  COMPLETE: "complete"
});

export const ACTION_RESULT_STATUS = Object.freeze({
  PENDING: "pending",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELLED: "cancelled"
});

export const ACTION_RESULT_CODES = Object.freeze({
  OK: "OK",
  MISSING_ACTION: "MISSING_ACTION",
  MISSING_SOURCE: "MISSING_SOURCE",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED"
});

/* -------------------------------------------- */

export function createActionContext({
  id=null,
  action=null,
  source=null,
  actorId=null,
  tokenId=null,
  targets=[],
  targetSet=null,
  area=null,
  resources=[],
  rollMode="publicroll",
  rulesVersion=null,
  policies={},
  events=[],
  metadata={}
}={}) {
  const normalizedSource = normalizeEntityRef(source ?? {actorId, tokenId});
  return {
    id: id == null ? null : String(id),
    action: action ? normalizeActionRef(action) : null,
    source: normalizedSource,
    actorId: actorId ?? normalizedSource.actorId,
    tokenId: tokenId ?? normalizedSource.tokenId,
    targets: targets.map(normalizeEntityRef),
    targetSet: clonePlain(targetSet),
    area: clonePlain(area),
    resources: resources.map(clonePlain),
    rollMode,
    rulesVersion,
    policies: clonePlain(policies) ?? {},
    events: events.map(clonePlain),
    metadata: clonePlain(metadata) ?? {}
  };
}

/* -------------------------------------------- */

export function validateActionContext(context) {
  const errors = [];
  if ( !context?.action?.id && !context?.action?.uuid ) {
    errors.push({code: ACTION_RESULT_CODES.MISSING_ACTION, reason: "action is required"});
  }
  if ( !context?.source?.actorId && !context?.actorId ) {
    errors.push({code: ACTION_RESULT_CODES.MISSING_SOURCE, reason: "source actor is required"});
  }

  return {
    ok: errors.length === 0,
    code: errors[0]?.code ?? ACTION_RESULT_CODES.OK,
    errors
  };
}

/* -------------------------------------------- */

export function createActionResult({
  context,
  status=ACTION_RESULT_STATUS.PENDING,
  code=ACTION_RESULT_CODES.OK,
  steps=[],
  events=[],
  consequences=[],
  mutationPlans=[],
  errors=[],
  warnings=[],
  metadata={}
}={}) {
  return {
    ok: status === ACTION_RESULT_STATUS.SUCCEEDED,
    status,
    code,
    context: context ? createActionContext(context) : null,
    steps: steps.map(clonePlain),
    events: events.map(clonePlain),
    consequences: consequences.map(clonePlain),
    mutationPlans: mutationPlans.map(clonePlain),
    errors: errors.map(clonePlain),
    warnings: warnings.map(clonePlain),
    metadata: clonePlain(metadata) ?? {}
  };
}

/* -------------------------------------------- */

export function beginActionResult(context, {validate=true}={}) {
  const result = createActionResult({
    context,
    events: [createActionLifecycleEvent(context, {
      type: AUTOMATION_EVENT_TYPES.ACTION_DECLARED,
      phase: AUTOMATION_EVENT_PHASES.BEFORE
    })]
  });
  if ( !validate ) return result;

  const validation = validateActionContext(result.context);
  if ( validation.ok ) {
    return addResolutionStep(result, {
      stage: ACTION_RESOLUTION_STAGES.VALIDATION,
      status: ACTION_RESULT_STATUS.SUCCEEDED,
      code: ACTION_RESULT_CODES.OK
    });
  }
  return failActionResult(result, {
    stage: ACTION_RESOLUTION_STAGES.VALIDATION,
    code: validation.code,
    errors: validation.errors
  });
}

/* -------------------------------------------- */

export function addResolutionStep(result, {
  stage,
  status=ACTION_RESULT_STATUS.SUCCEEDED,
  code=ACTION_RESULT_CODES.OK,
  data={},
  events=[],
  consequences=[],
  mutationPlans=[],
  errors=[],
  warnings=[]
}={}) {
  const step = {
    stage: stage ?? null,
    status,
    code,
    data: clonePlain(data) ?? {}
  };
  const nextErrors = [...result.errors.map(clonePlain), ...errors.map(clonePlain)];
  const nextStatus = status === ACTION_RESULT_STATUS.FAILED ? ACTION_RESULT_STATUS.FAILED : result.status;
  const nextCode = status === ACTION_RESULT_STATUS.FAILED ? code : result.code;
  return createActionResult({
    ...result,
    status: nextStatus,
    code: nextCode,
    steps: [...result.steps, step],
    events: [...result.events, ...events],
    consequences: [...result.consequences, ...consequences],
    mutationPlans: [...result.mutationPlans, ...mutationPlans],
    errors: nextErrors,
    warnings: [...result.warnings.map(clonePlain), ...warnings.map(clonePlain)]
  });
}

/* -------------------------------------------- */

export function failActionResult(result, {
  stage=null,
  code=ACTION_RESULT_CODES.FAILED,
  reason=null,
  errors=[],
  data={}
}={}) {
  const normalizedErrors = errors.length ? errors : [{code, reason}];
  return createActionResult({
    ...result,
    status: ACTION_RESULT_STATUS.FAILED,
    code,
    steps: [
      ...result.steps,
      {
        stage,
        status: ACTION_RESULT_STATUS.FAILED,
        code,
        data: clonePlain(data) ?? {}
      }
    ],
    errors: [...result.errors.map(clonePlain), ...normalizedErrors.map(clonePlain)]
  });
}

/* -------------------------------------------- */

export function cancelActionResult(result, {
  stage=null,
  code=ACTION_RESULT_CODES.CANCELLED,
  reason=null,
  data={}
}={}) {
  return createActionResult({
    ...result,
    status: ACTION_RESULT_STATUS.CANCELLED,
    code,
    steps: [
      ...result.steps,
      {
        stage,
        status: ACTION_RESULT_STATUS.CANCELLED,
        code,
        data: clonePlain(data) ?? {}
      }
    ],
    warnings: [...result.warnings.map(clonePlain), {code, reason}]
  });
}

/* -------------------------------------------- */

export function succeedActionResult(result, {
  code=ACTION_RESULT_CODES.OK,
  data={},
  events=[],
  consequences=[],
  mutationPlans=[]
}={}) {
  if ( result.status === ACTION_RESULT_STATUS.FAILED || result.status === ACTION_RESULT_STATUS.CANCELLED ) {
    return createActionResult(result);
  }
  return createActionResult({
    ...result,
    status: ACTION_RESULT_STATUS.SUCCEEDED,
    code,
    steps: [
      ...result.steps,
      {
        stage: ACTION_RESOLUTION_STAGES.COMPLETE,
        status: ACTION_RESULT_STATUS.SUCCEEDED,
        code,
        data: clonePlain(data) ?? {}
      }
    ],
    events: [...result.events, ...events],
    consequences: [...result.consequences, ...consequences],
    mutationPlans: [...result.mutationPlans, ...mutationPlans]
  });
}

/* -------------------------------------------- */

export function withActionEvents(context, events=[]) {
  return createActionContext({
    ...context,
    events: [...(context.events ?? []), ...events]
  });
}

/* -------------------------------------------- */

export function withActionTargets(context, targets=[], targetSet=null) {
  return createActionContext({
    ...context,
    targets,
    targetSet: targetSet ?? context.targetSet
  });
}

/* -------------------------------------------- */

export function createActionLifecycleEvent(context, {
  id=null,
  type=AUTOMATION_EVENT_TYPES.ACTION_DECLARED,
  phase=AUTOMATION_EVENT_PHASES.AFTER,
  tags=[],
  data={},
  metadata={}
}={}) {
  return createAutomationEvent({
    id,
    type,
    phase,
    source: context?.source,
    targets: context?.targets ?? [],
    tags: uniqueStrings([...(context?.action?.tags ?? []), ...tags]),
    data: {
      action: clonePlain(context?.action),
      ...clonePlain(data)
    },
    metadata
  });
}

/* -------------------------------------------- */

export function createActionResolutionTrace(result) {
  return {
    ok: result.ok,
    status: result.status,
    code: result.code,
    actionId: result.context?.action?.id ?? null,
    sourceActorId: result.context?.source?.actorId ?? null,
    targetIds: result.context?.targets?.map(target => target.id).filter(Boolean) ?? [],
    stages: result.steps.map(step => ({
      stage: step.stage,
      status: step.status,
      code: step.code
    })),
    eventTypes: result.events.map(event => event.type),
    consequenceCount: result.consequences.length,
    mutationPlanCount: result.mutationPlans.length,
    errors: result.errors.map(clonePlain),
    warnings: result.warnings.map(clonePlain)
  };
}

/* -------------------------------------------- */

function normalizeActionRef(action={}) {
  return {
    id: action.id ?? action.uuid ?? null,
    uuid: action.uuid ?? null,
    type: action.type ?? action.itemType ?? "action",
    name: action.name ?? null,
    slug: action.slug ?? action.system?.slug ?? null,
    tags: uniqueStrings(action.tags ?? action.system?.tags ?? []),
    cost: clonePlain(action.cost ?? action.system?.cost ?? null),
    activationCost: clonePlain(action.activationCost ?? null),
    metadata: clonePlain(action.metadata ?? {})
  };
}

function normalizeEntityRef(entity={}) {
  return {
    id: entity.id ?? entity.tokenId ?? entity.actorId ?? entity.uuid ?? null,
    uuid: entity.uuid ?? null,
    actorId: entity.actorId ?? entity.actor?.id ?? null,
    tokenId: entity.tokenId ?? entity.token?.id ?? null,
    name: entity.name ?? entity.actor?.name ?? entity.token?.name ?? null,
    type: entity.type ?? null,
    disposition: entity.disposition ?? null,
    tags: uniqueStrings(entity.tags ?? [])
  };
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => value != null).map(String))];
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
