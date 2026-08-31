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
  resolveActorResourcePayment
} from "./resource-resolver.mjs";
import {prepareTargetMutationCommitOperations} from "./target-mutation-commit-resolver.mjs";
import {
  createActorUpdateTransactionOperation,
  executeResolutionTransaction
} from "./resolution-transaction-resolver.mjs";
import {resolveAttackTargets} from "./attack-resolver.mjs";
import {
  DAMAGE_RESOLVER_CODES,
  resolveDamageTargets
} from "./damage-resolver.mjs";
import {planDamageDurabilityMutations} from "./damage-durability-resolver.mjs";
import {planHealingDurabilityMutations} from "./healing-durability-resolver.mjs";
import {resolveHealingTargets} from "./healing-resolver.mjs";
import {resolveActionTargets} from "./target-resolver.mjs";
import {resolveWeaponDamageScaling} from "../helpers/weapon-sizing.mjs";
import {
  SAVE_RESOLVER_CODES,
  SAVE_OUTCOMES,
  resolveSaveTargets
} from "./save-resolver.mjs";
import {planConditionEffect} from "./effect-resolver.mjs";
import {
  actionDefinitionActivationCost,
  actionDefinitionFromAction,
  actionDefinitionToResolverInput
} from "../helpers/action-definitions.mjs";
import {targetLookupRefs} from "../helpers/target-actor-refs.mjs";
import {
  resolveActionConfiguration,
  validateResolvedActionConfiguration
} from "../helpers/action-configuration.mjs";

export const ACTION_RESOLVER_CODES = Object.freeze({
  OK: "OK",
  TARGETING_FAILED: "TARGETING_FAILED",
  ATTACK_FAILED: "ATTACK_FAILED",
  SAVE_FAILED: "SAVE_FAILED",
  DAMAGE_FAILED: "DAMAGE_FAILED",
  HEALING_FAILED: "HEALING_FAILED",
  EFFECTS_FAILED: "EFFECTS_FAILED",
  ACTION_DEFINITION_INVALID: "ACTION_DEFINITION_INVALID",
  ACTION_CONFIGURATION_INVALID: "ACTION_CONFIGURATION_INVALID",
  PAYMENT_UNAVAILABLE: "PAYMENT_UNAVAILABLE",
  RESOURCE_COMMIT_FAILED: "RESOURCE_COMMIT_FAILED",
  MUTATION_COMMIT_FAILED: "MUTATION_COMMIT_FAILED",
  MUTATION_COMMIT_UNSUPPORTED: "MUTATION_COMMIT_UNSUPPORTED"
});

/* -------------------------------------------- */

export function planActionResolution({
  actorSystem,
  action,
  source=null,
  targets=[],
  targeting=null,
  attack=null,
  save=null,
  damage=null,
  healing=null,
  effects=null,
  durability=null,
  configuration=null,
  configurationContributions=[],
  context={},
  policies={},
  selectedPaymentOptionId=null,
  complete=true
}={}) {
  const definitionResult = action ? actionDefinitionFromAction(action, {actorSystem}) : null;
  let actionDefinition = definitionResult?.definition ?? null;
  const configurationResult = definitionResult?.ok && actionDefinition
    ? resolveConfigurationForAction({
        actionDefinition,
        actorSystem,
        configuration,
        configurationContributions,
        context,
        policies
      })
    : null;
  if ( configurationResult?.ok ) {
    actionDefinition = configurationResult.configuration.effectiveDefinition;
    context = {
      ...context,
      metadata: {
        ...(context.metadata ?? {}),
        resolvedActionConfiguration: summarizeResolvedConfiguration(configurationResult.configuration)
      }
    };
    if ( selectedPaymentOptionId == null ) selectedPaymentOptionId = configurationResult.configuration.selectedPaymentOptionId;
  }
  const definitionInput = definitionResult?.ok && actionDefinition
    ? actionDefinitionToResolverInput(actionDefinition, {
        actorSystem,
        source: source ?? context.source,
        targets,
        targeting,
        attack,
        save,
        damage,
        healing,
        effects,
        context,
        policies
      })
    : {targets, targeting, attack, save, damage, healing, effects, context, policies};
  targets = definitionInput.targets?.length ? definitionInput.targets : targets;
  targeting = definitionInput.targeting;
  attack = definitionInput.attack;
  save = definitionInput.save;
  damage = definitionInput.damage;
  healing = definitionInput.healing;
  effects = definitionInput.effects;
  context = definitionInput.context ?? context;
  policies = definitionInput.policies ?? policies;

  let actionContext = createActionContext({
    ...context,
    action: actionRef(action, actionDefinition, definitionResult),
    source: source ?? context.source,
    targets: targets.length ? targets : context.targets ?? [],
    policies: {...(context.policies ?? {}), ...policies}
  });
  let result = beginActionResult(actionContext);
  if ( result.status === ACTION_RESULT_STATUS.FAILED ) return result;
  if ( definitionResult && !definitionResult.ok ) {
    return failActionResult(result, {
      stage: ACTION_RESOLUTION_STAGES.VALIDATION,
      code: ACTION_RESOLVER_CODES.ACTION_DEFINITION_INVALID,
      reason: definitionResult.code,
      errors: definitionResult.errors,
      data: {
        actionDefinition: definitionResult.definition ?? null,
        validation: definitionResult
      }
    });
  }
  if ( configurationResult && !configurationResult.ok ) {
    return failActionResult(result, {
      stage: ACTION_RESOLUTION_STAGES.VALIDATION,
      code: ACTION_RESOLVER_CODES.ACTION_CONFIGURATION_INVALID,
      reason: configurationResult.code,
      errors: configurationResult.errors,
      data: {
        actionDefinition,
        configuration: configurationResult.configuration ?? null,
        validation: configurationResult
      }
    });
  }

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

  let saveResolution = null;
  if ( shouldResolveSave(save) ) {
    saveResolution = resolveSaveTargets({
      roll: save.roll,
      targetContexts: save.targetContexts ?? targetResolution?.targetContexts ?? [],
      targets: save.targets ?? (targetResolution ? [] : actionContext.targets),
      dc: save.dc ?? null,
      dcKey: save.dcKey ?? "save",
      saveKey: save.saveKey ?? save.ability ?? null,
      policy: {...(policies.save ?? {}), ...(save.policy ?? {})},
      context: {
        action: actionContext.action,
        source: actionContext.source,
        ...(save.context ?? {})
      }
    });
    if ( !saveResolution.ok ) {
      return failActionResult(result, {
        stage: ACTION_RESOLUTION_STAGES.ROLL,
        code: ACTION_RESOLVER_CODES.SAVE_FAILED,
        reason: saveResolution.code,
        data: {saveResolution}
      });
    }

    result = addResolutionStep(result, {
      stage: ACTION_RESOLUTION_STAGES.ROLL,
      events: saveEvents(actionContext, saveResolution),
      consequences: [{
        type: "saveResolved",
        saveResolution
      }],
      data: {saveResolution}
    });
  }

  if ( shouldResolveDamage(damage) ) {
    const damageResolution = resolveActionDamage({
      damage,
      targetResolution,
      attackResolution,
      saveResolution,
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

    const durabilityResolution = resolveDamageDurability({
      damage,
      durability,
      damageResolution,
      actionContext
    });
    if ( durabilityResolution && !durabilityResolution.ok ) {
      return failActionResult(result, {
        stage: ACTION_RESOLUTION_STAGES.CONSEQUENCE,
        code: ACTION_RESOLVER_CODES.DAMAGE_FAILED,
        reason: durabilityResolution.code,
        data: {damageResolution, durabilityResolution}
      });
    }

    result = addResolutionStep(result, {
      stage: ACTION_RESOLUTION_STAGES.CONSEQUENCE,
      consequences: [{
        type: "damageResolved",
        damageResolution,
        ...(durabilityResolution ? {durabilityResolution} : {})
      }],
      mutationPlans: durabilityResolution?.mutationPlans ?? [],
      data: {
        damageResolution,
        ...(durabilityResolution ? {durabilityResolution} : {})
      }
    });
  }

  if ( shouldResolveHealing(healing) ) {
    const healingResolution = resolveActionHealing({
      healing,
      targetResolution,
      actionContext
    });
    if ( !healingResolution.ok ) {
      return failActionResult(result, {
        stage: ACTION_RESOLUTION_STAGES.CONSEQUENCE,
        code: ACTION_RESOLVER_CODES.HEALING_FAILED,
        reason: healingResolution.code,
        data: {healingResolution}
      });
    }

    const durabilityResolution = resolveHealingDurability({
      healing,
      durability,
      healingResolution,
      actionContext
    });
    if ( durabilityResolution && !durabilityResolution.ok ) {
      return failActionResult(result, {
        stage: ACTION_RESOLUTION_STAGES.CONSEQUENCE,
        code: ACTION_RESOLVER_CODES.HEALING_FAILED,
        reason: durabilityResolution.code,
        data: {healingResolution, durabilityResolution}
      });
    }

    result = addResolutionStep(result, {
      stage: ACTION_RESOLUTION_STAGES.CONSEQUENCE,
      consequences: [{
        type: "healingResolved",
        healingResolution,
        ...(durabilityResolution ? {durabilityResolution} : {})
      }],
      mutationPlans: durabilityResolution?.mutationPlans ?? [],
      data: {
        healingResolution,
        ...(durabilityResolution ? {durabilityResolution} : {})
      }
    });
  }

  if ( shouldResolveEffects(effects) ) {
    const effectResolution = resolveActionEffects({
      effects,
      targetResolution,
      attackResolution,
      saveResolution,
      actionContext
    });
    if ( !effectResolution.ok ) {
      return failActionResult(result, {
        stage: ACTION_RESOLUTION_STAGES.EFFECTS,
        code: ACTION_RESOLVER_CODES.EFFECTS_FAILED,
        reason: effectResolution.code,
        data: {effectResolution}
      });
    }

    result = addResolutionStep(result, {
      stage: ACTION_RESOLUTION_STAGES.EFFECTS,
      consequences: [{
        type: "effectsResolved",
        effectResolution
      }],
      mutationPlans: effectResolution.mutationPlans,
      data: {effectResolution}
    });
  }

  const payment = resolveActorResourcePayment({
    actorSystem,
    cost: actionActivationCost(action, actionDefinition),
    action: actionContext.action,
    policies: actionContext.policies,
    selectedPaymentOptionId,
    selectedPaymentPlan: configurationResult?.configuration?.selectedPaymentPlan ?? null
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
  save=null,
  damage=null,
  healing=null,
  effects=null,
  durability=null,
  configuration=null,
  configurationContributions=[],
  targetActors=null,
  authority=null,
  context={},
  policies={},
  selectedPaymentOptionId=null,
  persistencePort=null
}={}) {
  const executionDurability = prepareExecutionDurabilityOptions(durability, targetActors);
  const result = planActionResolution({
    actorSystem: actor?.system,
    action,
    source: source ?? actorSource(actor),
    targets,
    targeting,
    attack,
    save,
    damage,
    healing,
    effects,
    durability: executionDurability,
    configuration,
    configurationContributions,
    context,
    policies,
    selectedPaymentOptionId,
    complete: false
  });
  if ( result.status === ACTION_RESULT_STATUS.FAILED || result.status === ACTION_RESULT_STATUS.CANCELLED ) {
    return result;
  }

  return commitPlannedActionResult({
    result,
    actor,
    targetActors,
    authority,
    persistencePort
  });
}

/* -------------------------------------------- */

export async function commitPlannedActionResult({result, actor, targetActors, authority, persistencePort=null}={}) {
  if ( result?.status === ACTION_RESULT_STATUS.FAILED || result?.status === ACTION_RESULT_STATUS.CANCELLED ) {
    return result;
  }

  const transactionCommit = await executeActionMutationTransaction({
    result,
    actor,
    targetActors,
    authority,
    persistencePort
  });
  if ( !transactionCommit.ok ) {
    return failActionResult(result, {
      stage: transactionCommit.stage,
      code: transactionCommit.code,
      reason: transactionCommit.reason,
      data: transactionCommit.data
    });
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
    data: {
      committed: true,
      transaction: transactionCommit.transaction
    }
  });
  return succeedActionResult(committed);
}

/* -------------------------------------------- */

export async function executeActionMutationTransaction({result, actor, targetActors, authority, persistencePort=null}={}) {
  const targetMutationPlans = result.mutationPlans.filter(plan => plan.type !== "resourcePayment");
  const paymentMutationPlans = result.mutationPlans.filter(plan => plan.type === "resourcePayment");
  const unsupportedMutationPlans = targetMutationPlans.filter(plan => !isSupportedTargetMutationPlan(plan));
  if ( unsupportedMutationPlans.length ) {
    return {
      ok: false,
      stage: ACTION_RESOLUTION_STAGES.CONSEQUENCE,
      code: ACTION_RESOLVER_CODES.MUTATION_COMMIT_UNSUPPORTED,
      reason: "executeActionResolution does not yet have a commit adapter for these target mutation plans",
      data: {mutationPlans: unsupportedMutationPlans}
    };
  }

  const targetOperations = prepareTargetMutationCommitOperations({
    mutationPlans: targetMutationPlans,
    targetActors,
    authority,
    persistencePort,
    metadata: {action: result.context?.action ?? null}
  });
  if ( !targetOperations.ok ) {
    return {
      ok: false,
      stage: ACTION_RESOLUTION_STAGES.CONSEQUENCE,
      code: ACTION_RESOLVER_CODES.MUTATION_COMMIT_FAILED,
      reason: targetOperations.code,
      data: {targetOperations}
    };
  }

  const sourceOperations = paymentMutationPlans.map((mutationPlan, index) => createActorUpdateTransactionOperation({
    id: `source:${index}:resourcePayment`,
    type: "resourcePayment",
    actorRef: actor?.uuid ?? (actor?.id ? `actor:${actor.id}` : null),
    actor,
    mutationPlan: mutationPlan.plan,
    persistencePort,
    metadata: {
      role: "sourcePayment",
      action: result.context?.action ?? null,
      mutationPlan
    }
  }));
  const transaction = await executeResolutionTransaction({
    operations: [...targetOperations.operations, ...sourceOperations],
    persistencePort,
    metadata: {action: result.context?.action ?? null}
  });
  if ( transaction.ok ) {
    return {
      ok: true,
      transaction
    };
  }

  const failedOperation = transaction.commitFailure?.operation ?? transaction.failures[0]?.operation ?? null;
  const sourcePaymentFailed = failedOperation?.type === "resourcePayment";
  return {
    ok: false,
    stage: sourcePaymentFailed ? ACTION_RESOLUTION_STAGES.RESOURCE_PAYMENT : ACTION_RESOLUTION_STAGES.CONSEQUENCE,
    code: sourcePaymentFailed ? ACTION_RESOLVER_CODES.RESOURCE_COMMIT_FAILED : ACTION_RESOLVER_CODES.MUTATION_COMMIT_FAILED,
    reason: transaction.code,
    data: {transaction}
  };
}

/* -------------------------------------------- */

export function actionRef(action, actionDefinition=null, definitionResult=null) {
  return {
    id: actionDefinition?.id ?? action?.id ?? action?.uuid ?? null,
    uuid: action?.uuid ?? null,
    type: action?.type ?? "action",
    name: actionDefinition?.label ?? action?.name ?? null,
    slug: actionDefinition?.slug ?? action?.slug ?? action?.system?.slug ?? null,
    tags: uniqueStrings([...(actionDefinition?.tags ?? []), ...(action?.system?.tags ?? action?.tags ?? [])]),
    cost: action?.system?.cost ?? action?.cost ?? null,
    activationCost: actionActivationCost(action, actionDefinition),
    metadata: {
      ...(action?.metadata ?? {}),
      ...(actionDefinition ? {
        actionDefinition: {
          id: actionDefinition.id,
          schemaVersion: actionDefinition.schemaVersion,
          migrated: definitionResult?.migrated === true
        }
      } : {})
    }
  };
}

export function actionActivationCost(action, actionDefinition=null) {
  if ( actionDefinition ) return actionDefinitionActivationCost(actionDefinition);
  return action?.system?.getActivationCost?.() ?? action?.activationCost ?? action?.cost ?? {allOf: []};
}

function resolveConfigurationForAction({
  actionDefinition,
  actorSystem,
  configuration,
  configurationContributions=[],
  context={},
  policies={}
}) {
  if ( !configuration && !configurationContributionCount(configurationContributions) ) return null;

  if ( configuration?.effectiveDefinition ) {
    const validation = validateResolvedActionConfiguration({
      configuration,
      actorSystem,
      context,
      policies
    });
    if ( !validation.ok ) return {
      ok: false,
      code: validation.code,
      errors: validation.errors,
      configuration,
      validation
    };
    return {
      ok: true,
      code: ACTION_RESOLVER_CODES.OK,
      configuration: {
        ...configuration,
        payment: {
          ...(configuration.payment ?? {}),
          discovery: validation.payment.discovery,
          selectedPaymentOptionId: validation.payment.selectedPaymentOptionId,
          selectedPaymentPlan: validation.payment.selectedPaymentPlan
        },
        selectedPaymentOptionId: validation.payment.selectedPaymentOptionId,
        selectedPaymentPlan: validation.payment.selectedPaymentPlan
      },
      validation
    };
  }

  const choices = configuration?.choices
    ?? configuration?.responses
    ?? configuration
    ?? {};
  const result = resolveActionConfiguration({
    definition: actionDefinition,
    actorSystem,
    choices,
    configurationContributions,
    context,
    policies
  });
  if ( !result.ok ) return {
    ok: false,
    code: result.code,
    errors: result.errors,
    configuration: result.configuration,
    validation: result
  };
  return result;
}

function configurationContributionCount(contributions) {
  if ( contributions == null ) return 0;
  if ( Array.isArray(contributions) ) return contributions.length;
  if ( contributions instanceof Set || contributions instanceof Map ) return contributions.size;
  return 1;
}

function summarizeResolvedConfiguration(configuration) {
  return {
    id: configuration.id,
    actionDefinitionId: configuration.actionDefinitionId,
    castingLevel: configuration.castingLevel ?? null,
    selectedPaymentOptionId: configuration.selectedPaymentOptionId ?? null,
    choices: (configuration.choices ?? []).map(choice => ({
      id: choice.id,
      type: choice.type,
      value: choice.value,
      optionId: choice.optionId ?? null,
      source: choice.source ?? null,
      metadata: choice.metadata ?? {}
    })),
    selectedDamageTypes: configuration.selectedDamageTypes ?? {}
  };
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => value != null).map(String))];
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

export function prepareExecutionDurabilityOptions(durability, targetActors) {
  if ( !durability || !targetActors ) return durability;
  const options = durability === true ? {} : {...durability};
  if ( options.targetSystems ) return durability;
  return {
    ...options,
    targetSystems: targetActorSystemsFromActors(targetActors)
  };
}

function targetActorSystemsFromActors(targetActors) {
  if ( typeof targetActors === "function" ) {
    return lookupContext => {
      const actor = targetActors(lookupContext);
      return actor?.system ?? actor?.actorSystem ?? actor ?? null;
    };
  }
  if ( targetActors instanceof Map ) {
    return new Map([...targetActors.entries()].map(([ref, actor]) => [ref, actor?.system ?? actor?.actorSystem ?? actor]));
  }
  if ( Array.isArray(targetActors) ) return targetActors;
  if ( targetActors && typeof targetActors === "object" ) {
    return Object.fromEntries(Object.entries(targetActors).map(([ref, actor]) => [ref, actor?.system ?? actor?.actorSystem ?? actor]));
  }
  return targetActors;
}

function isSupportedTargetMutationPlan(plan) {
  return ["durabilityDamage", "durabilityHealing", "durabilityAbsorption", "conditionEffect"].includes(plan.type);
}

export function shouldResolveTargets({targeting, actionContext}) {
  return !!targeting || !!actionContext.targetSet || !!actionContext.targets?.length;
}

export function shouldResolveAttack(attack) {
  return !!attack;
}

export function shouldResolveSave(save) {
  return !!save;
}

export function shouldResolveDamage(damage) {
  return !!damage;
}

export function shouldResolveHealing(healing) {
  return !!healing;
}

export function shouldResolveEffects(effects) {
  if ( Array.isArray(effects) ) return effects.length > 0;
  if ( !effects ) return false;
  return !!effects.condition || !!effects.conditions?.length;
}

export function finalTargetRefs(targetResolution) {
  return (targetResolution.refinement?.finalTargets ?? []).map(candidate => candidate.target ?? candidate);
}

export function attackEvents(actionContext, attackResolution) {
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

export function saveEvents(actionContext, saveResolution) {
  const events = [];
  for ( const result of saveResolution.results.filter(result => result.code !== SAVE_RESOLVER_CODES.TARGET_SKIPPED) ) {
    events.push(createActionLifecycleEvent(actionContext, {
      type: AUTOMATION_EVENT_TYPES.SAVE_ROLL,
      phase: AUTOMATION_EVENT_PHASES.AFTER,
      targets: [result.target],
      data: {saveResult: result}
    }));
    if ( !result.ok ) continue;
    events.push(createActionLifecycleEvent(actionContext, {
      type: result.success ? AUTOMATION_EVENT_TYPES.SAVE_SUCCESS : AUTOMATION_EVENT_TYPES.SAVE_FAILURE,
      phase: AUTOMATION_EVENT_PHASES.AFTER,
      targets: [result.target],
      tags: [result.outcome],
      data: {saveResult: result}
    }));
  }
  return events;
}

export function resolveActionDamage({damage, targetResolution, attackResolution, saveResolution, actionContext}) {
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
  const preparedDamage = prepareActionDamageComponents({damage, actionContext});
  const result = resolveDamageTargets({
    components: preparedDamage.components,
    targetContexts,
    targets: damage.targets ?? (targetContexts.length ? [] : actionContext.targets),
    context: {
      action: actionContext.action,
      source: actionContext.source,
      weaponDamageScaling: preparedDamage.weaponDamageScaling,
      ...(damage.context ?? {})
    },
    componentsForTarget: componentsForTargetFromSaveOutcomePolicy({
      damage,
      saveResolution
    })
  });
  return preparedDamage.weaponDamageScaling ? {
    ...result,
    weaponDamageScaling: preparedDamage.weaponDamageScaling
  } : result;
}

export function resolveDamageDurability({damage, durability, damageResolution, actionContext}) {
  const options = normalizeDamageDurabilityOptions(durability ?? damage?.durability);
  if ( !options ) return null;
  return planDamageDurabilityMutations({
    damageResolution,
    targetSystems: options.targetSystems ?? {},
    adjustments: options.adjustments ?? options.damageAdjustments ?? null,
    adjustmentProfiles: options.adjustmentProfiles ?? options.targetAdjustments ?? {},
    concentration: options.concentration ?? damage?.concentration ?? null,
    resourceId: options.resourceId ?? "health",
    source: actionContext.source,
    metadata: {
      action: actionContext.action,
      ...(options.metadata ?? {})
    }
  });
}

export function resolveActionHealing({healing, targetResolution, actionContext}) {
  const targetContexts = healing.targetContexts
    ?? targetResolution?.targetContexts
    ?? [];
  return resolveHealingTargets({
    components: healing.components ?? [],
    targetContexts,
    targets: healing.targets ?? (targetContexts.length ? [] : actionContext.targets),
    context: {
      action: actionContext.action,
      source: actionContext.source,
      ...(healing.context ?? {})
    }
  });
}

export function resolveHealingDurability({healing, durability, healingResolution, actionContext}) {
  const options = normalizeDamageDurabilityOptions(durability?.healing ?? healing?.durability ?? durability);
  if ( !options ) return null;
  return planHealingDurabilityMutations({
    healingResolution,
    targetSystems: options.targetSystems ?? {},
    resourceId: options.resourceId ?? "health",
    source: actionContext.source,
    metadata: {
      action: actionContext.action,
      ...(options.metadata ?? {})
    }
  });
}

export function resolveActionEffects({effects, targetResolution, attackResolution, saveResolution, actionContext}) {
  const requests = normalizeActionConditionEffectRequests({effects, actionContext});
  const conditionPlans = [];
  const mutationPlans = [];
  const skipped = [];
  const failures = [];

  for ( const request of requests ) {
    const targetSelection = conditionEffectTargetsForRequest({
      request,
      targetResolution,
      attackResolution,
      saveResolution,
      actionContext
    });
    if ( !targetSelection.ok ) {
      failures.push({
        code: targetSelection.code,
        reason: targetSelection.reason,
        request
      });
      continue;
    }
    skipped.push(...targetSelection.skipped);

    for ( const entry of targetSelection.entries ) {
      const metadata = {
        ...(request.metadata ?? {}),
        target: entry.target,
        ...(entry.saveResult ? {
          saveOutcome: entry.saveResult.outcome,
          saveSuccess: entry.saveResult.success
        } : {})
      };
      const conditionPlan = planConditionEffect({
        conditionId: request.conditionId,
        type: request.type,
        levels: request.levels,
        target: entry.target,
        existingConditions: existingConditionsForEffectTarget(request, entry),
        conditionDefinitions: request.conditionDefinitions,
        duration: request.duration,
        concentration: request.concentration,
        source: request.source,
        origin: request.origin,
        metadata
      });

      if ( !conditionPlan.ok ) {
        failures.push({
          code: conditionPlan.code,
          reason: conditionPlan.reason,
          request,
          target: entry.target,
          conditionPlan
        });
        continue;
      }

      conditionPlans.push(conditionPlan);
      mutationPlans.push(conditionPlan.mutationPlan);
    }
  }

  if ( failures.length ) {
    return {
      ok: false,
      code: failures[0].code,
      resolver: "ActionResolver",
      effectType: "condition",
      conditionPlans,
      mutationPlans,
      skipped,
      failures,
      context: {
        action: actionContext.action,
        source: actionContext.source
      }
    };
  }

  return {
    ok: true,
    code: ACTION_RESOLVER_CODES.OK,
    resolver: "ActionResolver",
    effectType: "condition",
    conditionPlans,
    mutationPlans,
    skipped,
    failures: [],
    context: {
      action: actionContext.action,
      source: actionContext.source
    }
  };
}

function normalizeActionConditionEffectRequests({effects, actionContext}) {
  const root = Array.isArray(effects) ? {} : effects ?? {};
  const entries = Array.isArray(effects)
    ? effects
    : [
        ...(Array.isArray(root.conditions) ? root.conditions : []),
        ...(root.condition ? [root.condition] : [])
      ];

  return entries
    .filter(entry => entry && typeof entry === "object")
    .map((entry, index) => ({
      ...entry,
      conditionId: entry.conditionId ?? entry.id ?? entry.slug ?? entry.type ?? null,
      levels: entry.levels ?? entry.delta ?? entry.levelDelta ?? 1,
      conditionDefinitions: entry.conditionDefinitions ?? root.conditionDefinitions ?? root.definitions,
      existingConditions: entry.existingConditions ?? root.existingConditions ?? null,
      existingConditionsByTarget: entry.existingConditionsByTarget ?? root.existingConditionsByTarget ?? null,
      duration: entry.duration ?? root.duration ?? null,
      concentration: entry.concentration ?? root.concentration ?? null,
      source: entry.source ?? root.source ?? actionContext.source,
      origin: entry.origin ?? entry.spell ?? root.origin ?? root.spell ?? actionContext.action,
      saveOutcomePolicy: entry.saveOutcomePolicy ?? entry.savePolicy ?? root.saveOutcomePolicy ?? root.savePolicy ?? null,
      metadata: {
        ...(root.metadata ?? {}),
        ...(entry.metadata ?? {}),
        effectIndex: index
      }
    }));
}

function conditionEffectTargetsForRequest({request, targetResolution, attackResolution, saveResolution, actionContext}) {
  const savePolicy = normalizeConditionSaveOutcomePolicy(request.saveOutcomePolicy);
  if ( savePolicy && !saveResolution ) {
    return {
      ok: false,
      code: "MISSING_SAVE_RESOLUTION",
      reason: "A save-gated condition effect requires a save resolution.",
      entries: [],
      skipped: []
    };
  }

  if ( savePolicy ) {
    const entries = [];
    const skipped = [];
    for ( const saveResult of saveResolution.results.filter(result => result.code !== SAVE_RESOLVER_CODES.TARGET_SKIPPED) ) {
      if ( saveResult.ok && conditionSavePolicyMatches(saveResult, savePolicy) ) {
        entries.push({
          target: saveResult.target,
          targetContext: saveResult.targetContext,
          saveResult
        });
      } else {
        skipped.push({
          reason: saveResult.ok ? "save outcome policy did not match" : saveResult.reason,
          target: saveResult.target,
          saveResult
        });
      }
    }
    return {ok: true, code: ACTION_RESOLVER_CODES.OK, entries, skipped};
  }

  if ( request.targetContexts?.length ) {
    return {
      ok: true,
      code: ACTION_RESOLVER_CODES.OK,
      entries: request.targetContexts.map(targetContext => ({
        target: targetContext.target ?? targetContext,
        targetContext,
        saveResult: null
      })),
      skipped: []
    };
  }

  if ( request.targets?.length ) {
    return {
      ok: true,
      code: ACTION_RESOLVER_CODES.OK,
      entries: request.targets.map(target => ({
        target,
        targetContext: {target, selected: true},
        saveResult: null
      })),
      skipped: []
    };
  }

  if ( attackResolution ) {
    return {
      ok: true,
      code: ACTION_RESOLVER_CODES.OK,
      entries: attackResolution.hits.map(hit => ({
        target: hit.target,
        targetContext: hit.targetContext ?? {target: hit.target, selected: true},
        saveResult: null
      })),
      skipped: attackResolution.misses.map(miss => ({
        reason: "attack did not hit",
        target: miss.target,
        attackResult: miss
      }))
    };
  }

  const targetContexts = targetResolution?.targetContexts ?? [];
  if ( targetContexts.length ) {
    return {
      ok: true,
      code: ACTION_RESOLVER_CODES.OK,
      entries: targetContexts
        .filter(targetContext => targetContext.selected !== false && !targetContext.excluded)
        .map(targetContext => ({
          target: targetContext.target ?? targetContext,
          targetContext,
          saveResult: null
        })),
      skipped: targetContexts
        .filter(targetContext => targetContext.selected === false || targetContext.excluded)
        .map(targetContext => ({
          reason: "target was not selected",
          target: targetContext.target ?? targetContext
        }))
    };
  }

  return {
    ok: true,
    code: ACTION_RESOLVER_CODES.OK,
    entries: (actionContext.targets ?? []).map(target => ({
      target,
      targetContext: {target, selected: true},
      saveResult: null
    })),
    skipped: []
  };
}

function normalizeConditionSaveOutcomePolicy(policy) {
  if ( !policy ) return null;
  const tokens = Array.isArray(policy)
    ? policy
    : typeof policy === "object"
      ? policy.applyOn ?? policy.outcomes ?? policy.outcome ?? []
      : [policy];
  const normalized = new Set([].concat(tokens).map(normalizeConditionSaveOutcomeToken).filter(Boolean));
  if ( normalized.has("any") ) return {any: true, outcomes: new Set(), successStates: new Set()};
  return {
    any: false,
    outcomes: new Set([...normalized].filter(token => token.startsWith("outcome:")).map(token => token.slice(8))),
    successStates: new Set([...normalized].filter(token => token.startsWith("success:")).map(token => token.slice(8) === "true"))
  };
}

function normalizeConditionSaveOutcomeToken(value) {
  const token = String(value ?? "").trim().toLowerCase().replace(/[-_\s]/g, "");
  switch ( token ) {
    case "any":
    case "all":
      return "any";
    case "success":
    case "succeeded":
    case "passed":
    case "pass":
      return "success:true";
    case "failure":
    case "failed":
    case "fail":
      return "success:false";
    case "criticalsuccess":
      return `outcome:${SAVE_OUTCOMES.CRITICAL_SUCCESS}`;
    case "criticalfailure":
      return `outcome:${SAVE_OUTCOMES.CRITICAL_FAILURE}`;
    default:
      return Object.values(SAVE_OUTCOMES).includes(value) ? `outcome:${value}` : null;
  }
}

function conditionSavePolicyMatches(saveResult, policy) {
  if ( policy.any ) return true;
  if ( policy.outcomes.has(saveResult.outcome) ) return true;
  return policy.successStates.has(saveResult.success);
}

function existingConditionsForEffectTarget(request, entry) {
  const byTarget = request.existingConditionsByTarget;
  const target = entry.target ?? {};
  const keys = [
    target.ref,
    target.id,
    target.actorId,
    target.tokenId,
    target.uuid
  ].filter(Boolean);

  if ( byTarget instanceof Map ) {
    for ( const key of keys ) {
      if ( byTarget.has(key) ) return byTarget.get(key);
    }
  } else if ( byTarget && typeof byTarget === "object" ) {
    for ( const key of keys ) {
      if ( byTarget[key] ) return byTarget[key];
    }
  }

  if ( typeof request.existingConditions === "function" ) {
    return request.existingConditions({
      target,
      targetContext: entry.targetContext,
      saveResult: entry.saveResult
    });
  }
  return request.existingConditions;
}

function normalizeDamageDurabilityOptions(options) {
  if ( options === true ) return {};
  if ( !options ) return null;
  return options;
}

function componentsForTargetFromSaveOutcomePolicy({damage, saveResolution}) {
  const policy = damage.saveOutcomePolicy ?? damage.savePolicy ?? null;
  if ( !policy || !saveResolution ) return null;
  const saveResults = saveResolution.results
    .filter(result => result.ok)
    .map(result => ({
      result,
      refs: targetLookupRefs(result.target)
    }));

  return (targetContext, components) => {
    const refs = targetLookupRefs(targetContext.target ?? targetContext);
    const saveResult = saveResults.find(entry => refs.some(ref => entry.refs.includes(ref)))?.result ?? null;
    if ( !saveResult ) return components;
    return applySaveOutcomeDamagePolicy(components, saveResult, policy);
  };
}

function applySaveOutcomeDamagePolicy(components, saveResult, policy) {
  const normalized = normalizeSaveOutcomeDamagePolicy(policy);
  const outcomePolicy = normalized.outcomes[saveResult.outcome]
    ?? normalized.outcomes[saveResult.success ? "success" : "failure"]
    ?? {multiplier: 1};
  if ( outcomePolicy.multiplier === 1 ) return components;

  return components.map(component => {
    const amount = component.amount == null
      ? component.amount
      : roundDamageAmount(component.amount * outcomePolicy.multiplier, normalized.rounding);
    return {
      ...component,
      amount,
      metadata: {
        ...(component.metadata ?? {}),
        saveOutcomeDamagePolicy: {
          outcome: saveResult.outcome,
          success: saveResult.success,
          multiplier: outcomePolicy.multiplier,
          originalAmount: component.amount,
          adjustedAmount: amount,
          rounding: normalized.rounding
        }
      }
    };
  });
}

function normalizeSaveOutcomeDamagePolicy(policy) {
  if ( typeof policy === "string" || typeof policy === "number" ) {
    return {
      rounding: "floor",
      outcomes: {
        success: normalizeDamageOutcomePolicy(policy),
        failure: normalizeDamageOutcomePolicy("full")
      }
    };
  }

  return {
    rounding: policy.rounding ?? "floor",
    outcomes: {
      success: normalizeDamageOutcomePolicy(policy.success ?? policy.onSuccess ?? "full"),
      failure: normalizeDamageOutcomePolicy(policy.failure ?? policy.onFailure ?? "full"),
      criticalSuccess: normalizeDamageOutcomePolicy(policy.criticalSuccess ?? policy.onCriticalSuccess ?? policy.success ?? policy.onSuccess ?? "full"),
      criticalFailure: normalizeDamageOutcomePolicy(policy.criticalFailure ?? policy.onCriticalFailure ?? policy.failure ?? policy.onFailure ?? "full")
    }
  };
}

function normalizeDamageOutcomePolicy(value) {
  if ( typeof value === "number" ) return {multiplier: Math.max(value, 0)};
  if ( typeof value === "object" && value ) return {
    multiplier: Math.max(Number(value.multiplier ?? value.amountMultiplier ?? 1) || 0, 0)
  };
  switch ( value ) {
    case "none": return {multiplier: 0};
    case "half": return {multiplier: 0.5};
    case "double": return {multiplier: 2};
    case "full":
    default: return {multiplier: 1};
  }
}

function roundDamageAmount(value, rounding) {
  switch ( rounding ) {
    case "ceil": return Math.ceil(value);
    case "round": return Math.round(value);
    case "none": return value;
    case "floor":
    default: return Math.floor(value);
  }
}

function damageTargetContextsFromAttack(attackResolution) {
  if ( !attackResolution ) return null;
  return attackResolution.hits.map(hit => hit.targetContext ?? {target: hit.target, selected: true});
}

function prepareActionDamageComponents({damage, actionContext}) {
  if ( !shouldApplyWeaponSizeScaling(damage, actionContext) ) {
    return {
      components: damage.components ?? [],
      weaponDamageScaling: null
    };
  }

  const weaponSizeContext = damage.weaponSize ?? damage.weaponSizeContext ?? {};
  const weaponDamageScaling = resolveWeaponDamageScaling({
    ...weaponSizeContext,
    weapon: {
      ...(weaponSizeContext.weapon ?? {}),
      ...(damage.weapon ?? {})
    },
    damageComponents: damage.components ?? [],
    metadata: {
      action: actionContext.action,
      ...(weaponSizeContext.metadata ?? {})
    }
  }, weaponSizeContext.policyOptions ?? {});

  return {
    components: weaponDamageScaling.scaledComponents,
    weaponDamageScaling
  };
}

function shouldApplyWeaponSizeScaling(damage, actionContext) {
  const weaponSizeContext = damage?.weaponSize ?? damage?.weaponSizeContext ?? null;
  if ( !weaponSizeContext ) return false;
  if ( weaponSizeContext.manufactured === true || weaponSizeContext.weapon?.manufactured === true ) return true;
  if ( weaponSizeContext.manufactured === false || weaponSizeContext.weapon?.manufactured === false ) return false;

  const weapon = {
    ...(actionContext.action?.weapon ?? {}),
    ...(damage.weapon ?? {}),
    ...(weaponSizeContext.weapon ?? {})
  };
  const kind = String(weapon.kind ?? weapon.category ?? "").toLowerCase();
  return kind === "manufactured" || kind === "manufactured-weapon";
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
