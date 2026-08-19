import {
  ACTION_RESOLUTION_STAGES,
  ACTION_RESULT_STATUS,
  addResolutionStep,
  beginActionResult,
  createActionContext,
  createActionLifecycleEvent,
  failActionResult,
  succeedActionResult
} from "../helpers/action-resolution.mjs";
import {
  AUTOMATION_EVENT_PHASES,
  AUTOMATION_EVENT_TYPES
} from "../helpers/automation-events.mjs";
import {
  RESOURCE_RESOLUTION_CODES,
  commitActorResourceMutationPlan,
  resolveActorResourcePayment
} from "./resource-resolver.mjs";

export const ACTION_RESOLVER_CODES = Object.freeze({
  OK: "OK",
  PAYMENT_UNAVAILABLE: "PAYMENT_UNAVAILABLE",
  RESOURCE_COMMIT_FAILED: "RESOURCE_COMMIT_FAILED"
});

/* -------------------------------------------- */

export function planActionResolution({
  actorSystem,
  action,
  source=null,
  targets=[],
  context={},
  policies={},
  selectedPaymentOptionId=null,
  complete=true
}={}) {
  const actionContext = createActionContext({
    ...context,
    action: actionRef(action),
    source: source ?? context.source,
    targets: targets.length ? targets : context.targets ?? [],
    policies: {...(context.policies ?? {}), ...policies}
  });
  const started = beginActionResult(actionContext);
  if ( started.status === ACTION_RESULT_STATUS.FAILED ) return started;

  const payment = resolveActorResourcePayment({
    actorSystem,
    cost: actionActivationCost(action),
    action: actionContext.action,
    policies: actionContext.policies,
    selectedPaymentOptionId
  });
  if ( !payment.ok ) {
    return failActionResult(started, {
      stage: ACTION_RESOLUTION_STAGES.RESOURCE_PAYMENT,
      code: ACTION_RESOLVER_CODES.PAYMENT_UNAVAILABLE,
      reason: payment.code,
      data: {payment}
    });
  }

  const paymentRequiredEvent = createActionLifecycleEvent(actionContext, {
    type: AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED,
    phase: AUTOMATION_EVENT_PHASES.BEFORE,
    data: {
      paymentPlan: payment.paymentPlan,
      mutationPlan: payment.mutationPlan
    }
  });
  const withPayment = addResolutionStep(started, {
    stage: ACTION_RESOLUTION_STAGES.RESOURCE_PAYMENT,
    events: [paymentRequiredEvent],
    consequences: [{
      type: "resourcePayment",
      paymentPlan: payment.paymentPlan,
      resourcesAfter: payment.resourcesAfter
    }],
    mutationPlans: [{
      type: "resourcePayment",
      resolver: "ResourceResolver",
      plan: payment.mutationPlan
    }],
    data: {
      paymentPlan: payment.paymentPlan,
      discovery: payment.discovery
    }
  });

  return complete ? succeedActionResult(withPayment) : withPayment;
}

/* -------------------------------------------- */

export async function executeActionResolution({
  actor,
  action,
  source=null,
  targets=[],
  context={},
  policies={},
  selectedPaymentOptionId=null
}={}) {
  const result = planActionResolution({
    actorSystem: actor?.system,
    action,
    source: source ?? actorSource(actor),
    targets,
    context,
    policies,
    selectedPaymentOptionId,
    complete: false
  });
  if ( result.status === ACTION_RESULT_STATUS.FAILED || result.status === ACTION_RESULT_STATUS.CANCELLED ) {
    return result;
  }

  for ( const mutationPlan of result.mutationPlans.filter(plan => plan.type === "resourcePayment") ) {
    const committed = await commitActorResourceMutationPlan(actor, mutationPlan.plan);
    if ( !committed ) {
      return failActionResult(result, {
        stage: ACTION_RESOLUTION_STAGES.RESOURCE_PAYMENT,
        code: ACTION_RESOLVER_CODES.RESOURCE_COMMIT_FAILED,
        reason: RESOURCE_RESOLUTION_CODES.COMMIT_FAILED,
        data: {mutationPlan}
      });
    }
  }

  const committed = addResolutionStep(result, {
    stage: ACTION_RESOLUTION_STAGES.RESOURCE_PAYMENT,
    status: ACTION_RESULT_STATUS.SUCCEEDED,
    code: ACTION_RESOLVER_CODES.OK,
    events: [createActionLifecycleEvent(result.context, {
      type: AUTOMATION_EVENT_TYPES.PAYMENT_COMMITTED,
      phase: AUTOMATION_EVENT_PHASES.AFTER,
      data: {
        mutationPlans: result.mutationPlans.filter(plan => plan.type === "resourcePayment")
      }
    })],
    data: {committed: true}
  });
  return succeedActionResult(committed);
}

/* -------------------------------------------- */

function actionRef(action) {
  return {
    id: action?.id ?? action?.uuid ?? null,
    uuid: action?.uuid ?? null,
    type: action?.type ?? "action",
    name: action?.name ?? null,
    tags: action?.system?.tags ?? action?.tags ?? [],
    cost: action?.system?.cost ?? action?.cost ?? null,
    activationCost: actionActivationCost(action),
    metadata: action?.metadata ?? {}
  };
}

function actionActivationCost(action) {
  return action?.system?.getActivationCost?.() ?? action?.activationCost ?? action?.cost ?? {allOf: []};
}

function actorSource(actor) {
  if ( !actor ) return null;
  return {
    id: actor.id ?? actor.uuid ?? null,
    uuid: actor.uuid ?? null,
    actorId: actor.id ?? null,
    name: actor.name ?? null,
    type: actor.type ?? "actor"
  };
}
