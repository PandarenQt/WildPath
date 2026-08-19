import {
  ACTION_RESOLUTION_STAGES,
  ACTION_RESULT_STATUS,
  addResolutionStep,
  beginActionResult,
  createActionContext,
  createActionLifecycleEvent,
  createActionResult,
  failActionResult,
  succeedActionResult,
  withActionTargets
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
import {resolveAttackTargets} from "./attack-resolver.mjs";
import {
  DAMAGE_RESOLVER_CODES,
  resolveDamageTargets
} from "./damage-resolver.mjs";
import {resolveActionTargets} from "./target-resolver.mjs";

export const ACTION_RESOLVER_CODES = Object.freeze({
  OK: "OK",
  TARGETING_FAILED: "TARGETING_FAILED",
  ATTACK_FAILED: "ATTACK_FAILED",
  DAMAGE_FAILED: "DAMAGE_FAILED",
  PAYMENT_UNAVAILABLE: "PAYMENT_UNAVAILABLE",
  RESOURCE_COMMIT_FAILED: "RESOURCE_COMMIT_FAILED"
});

/* -------------------------------------------- */

export function planActionResolution({
  actorSystem,
  action,
  source=null,
  targets=[],
  targeting=null,
  attack=null,
  damage=null,
  context={},
  policies={},
  selectedPaymentOptionId=null,
  complete=true
}={}) {
  let actionContext = createActionContext({
    ...context,
    action: actionRef(action),
    source: source ?? context.source,
    targets: targets.length ? targets : context.targets ?? [],
    policies: {...(context.policies ?? {}), ...policies}
  });
  let result = beginActionResult(actionContext);
  if ( result.status === ACTION_RESULT_STATUS.FAILED ) return result;

  let targetResolution = null;
  if ( shouldResolveTargets({targeting, actionContext}) ) {
    targetResolution = resolveActionTargets({
      source: actionContext.source,
      targetSet: targeting?.targetSet ?? actionContext.targetSet,
      candidates: targeting?.candidates ?? [],
      targets: (targeting?.targets?.length ? targeting.targets : actionContext.targets) ?? [],
      eligibilityPolicy: targeting?.eligibilityPolicy ?? {},
      refinementPolicy: targeting?.refinementPolicy ?? {},
      decisions: targeting?.decisions ?? [],
      context: {action: actionContext.action, ...(targeting?.context ?? {})},
      required: targeting?.required ?? false,
      metadata: targeting?.metadata ?? {}
    });
    if ( !targetResolution.ok ) {
      return failActionResult(result, {
        stage: ACTION_RESOLUTION_STAGES.TARGETING,
        code: ACTION_RESOLVER_CODES.TARGETING_FAILED,
        reason: targetResolution.code,
        data: {targetResolution}
      });
    }

    actionContext = withActionTargets(
      actionContext,
      finalTargetRefs(targetResolution),
      targetResolution.refinement
    );
    result = createActionResult({...result, context: actionContext});
    result = addResolutionStep(result, {
      stage: ACTION_RESOLUTION_STAGES.TARGETING,
      events: [createActionLifecycleEvent(actionContext, {
        type: AUTOMATION_EVENT_TYPES.TARGETS_SELECTED,
        phase: AUTOMATION_EVENT_PHASES.AFTER,
        data: {targetResolution}
      })],
      consequences: [{
        type: "targetsSelected",
        targetContexts: targetResolution.targetContexts
      }],
      data: {targetResolution}
    });
  }

  let attackResolution = null;
  if ( shouldResolveAttack(attack) ) {
    attackResolution = resolveAttackTargets({
      roll: attack.roll,
      targetContexts: attack.targetContexts ?? targetResolution?.targetContexts ?? [],
      targets: attack.targets ?? (targetResolution ? [] : actionContext.targets),
      defense: attack.defense ?? null,
      defenseKey: attack.defenseKey ?? "ac",
      policy: {...(policies.attack ?? {}), ...(attack.policy ?? {})},
      context: {
        action: actionContext.action,
        source: actionContext.source,
        ...(attack.context ?? {})
      }
    });
    if ( !attackResolution.ok ) {
      return failActionResult(result, {
        stage: ACTION_RESOLUTION_STAGES.ROLL,
        code: ACTION_RESOLVER_CODES.ATTACK_FAILED,
        reason: attackResolution.code,
        data: {attackResolution}
      });
    }

    result = addResolutionStep(result, {
      stage: ACTION_RESOLUTION_STAGES.ROLL,
      events: attackEvents(actionContext, attackResolution),
      consequences: [{
        type: "attackResolved",
        attackResolution
      }],
      data: {attackResolution}
    });
  }

  if ( shouldResolveDamage(damage) ) {
    const damageResolution = resolveActionDamage({
      damage,
      targetResolution,
      attackResolution,
      actionContext
    });
    if ( !damageResolution.ok ) {
      return failActionResult(result, {
        stage: ACTION_RESOLUTION_STAGES.CONSEQUENCE,
        code: ACTION_RESOLVER_CODES.DAMAGE_FAILED,
        reason: damageResolution.code,
        data: {damageResolution}
      });
    }

    result = addResolutionStep(result, {
      stage: ACTION_RESOLUTION_STAGES.CONSEQUENCE,
      consequences: [{
        type: "damageResolved",
        damageResolution
      }],
      data: {damageResolution}
    });
  }

  const payment = resolveActorResourcePayment({
    actorSystem,
    cost: actionActivationCost(action),
    action: actionContext.action,
    policies: actionContext.policies,
    selectedPaymentOptionId
  });
  if ( !payment.ok ) {
    return failActionResult(result, {
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
  const withPayment = addResolutionStep(result, {
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
  targeting=null,
  attack=null,
  damage=null,
  context={},
  policies={},
  selectedPaymentOptionId=null
}={}) {
  const result = planActionResolution({
    actorSystem: actor?.system,
    action,
    source: source ?? actorSource(actor),
    targets,
    targeting,
    attack,
    damage,
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

function shouldResolveTargets({targeting, actionContext}) {
  return !!targeting || !!actionContext.targetSet || !!actionContext.targets?.length;
}

function shouldResolveAttack(attack) {
  return !!attack;
}

function shouldResolveDamage(damage) {
  return !!damage;
}

function finalTargetRefs(targetResolution) {
  return (targetResolution.refinement?.finalTargets ?? []).map(candidate => candidate.target ?? candidate);
}

function attackEvents(actionContext, attackResolution) {
  const events = [createActionLifecycleEvent(actionContext, {
    type: AUTOMATION_EVENT_TYPES.ATTACK_ROLL,
    phase: AUTOMATION_EVENT_PHASES.AFTER,
    data: {attackResolution}
  })];
  if ( attackResolution.hits.length ) {
    events.push(createActionLifecycleEvent(actionContext, {
      type: AUTOMATION_EVENT_TYPES.ATTACK_HIT,
      phase: AUTOMATION_EVENT_PHASES.AFTER,
      data: {attackResults: attackResolution.hits}
    }));
  }
  if ( attackResolution.misses.length ) {
    events.push(createActionLifecycleEvent(actionContext, {
      type: AUTOMATION_EVENT_TYPES.ATTACK_MISS,
      phase: AUTOMATION_EVENT_PHASES.AFTER,
      data: {attackResults: attackResolution.misses}
    }));
  }
  return events;
}

function resolveActionDamage({damage, targetResolution, attackResolution, actionContext}) {
  if ( attackResolution && !attackResolution.hits.length ) {
    return emptyDamageResolutionFromMisses(attackResolution, {
      action: actionContext.action,
      source: actionContext.source,
      ...(damage.context ?? {})
    });
  }

  const targetContexts = damage.targetContexts
    ?? damageTargetContextsFromAttack(attackResolution)
    ?? targetResolution?.targetContexts
    ?? [];
  return resolveDamageTargets({
    components: damage.components ?? [],
    targetContexts,
    targets: damage.targets ?? (targetContexts.length ? [] : actionContext.targets),
    context: {
      action: actionContext.action,
      source: actionContext.source,
      ...(damage.context ?? {})
    }
  });
}

function damageTargetContextsFromAttack(attackResolution) {
  if ( !attackResolution ) return null;
  return attackResolution.hits.map(hit => hit.targetContext ?? {target: hit.target, selected: true});
}

function emptyDamageResolutionFromMisses(attackResolution, context) {
  return {
    ok: true,
    code: DAMAGE_RESOLVER_CODES.OK,
    results: [],
    totals: {},
    failures: [],
    skipped: attackResolution.misses.map(miss => ({
      ok: true,
      code: DAMAGE_RESOLVER_CODES.TARGET_SKIPPED,
      target: miss.target,
      targetContext: miss.targetContext ?? null,
      components: [],
      total: 0,
      byDamageType: {},
      reason: "attack did not hit"
    })),
    context
  };
}
