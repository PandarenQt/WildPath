import {
  TARGET_DEFAULT_SELECTION
} from "../helpers/targeting.mjs";
import {targetLookupRefs} from "../helpers/target-actor-refs.mjs";
import {footprintDistance} from "../helpers/grid-footprints.mjs";
import {resolveActorDefense} from "../helpers/combat-statistics.mjs";
import {
  actionDefinitionActivationCost,
  actionDefinitionFromAction,
  actionDefinitionToResolverInput
} from "../helpers/action-definitions.mjs";
import {
  ACTION_CONFIGURATION_CODES,
  createResolvedActionPreview,
  discoverActionConfigurationChoices,
  resolveActionConfiguration,
  validateResolvedActionConfiguration
} from "../helpers/action-configuration.mjs";
import {
  RESOLUTION_PIPELINE_CODES,
  RESOLUTION_REQUEST_TYPES,
  RESOLUTION_STAGE_STATUS,
  RESOLUTION_STATE_STATUS,
  completeResolutionStage,
  continueResolutionStage,
  createResolutionPipelineStage,
  createResolutionRequest,
  createResolutionState,
  failResolutionStage,
  getResolutionResponse,
  resumeResolutionPipeline,
  runResolutionPipeline,
  updateResolutionState,
  waitResolutionStage
} from "../helpers/resolution-state.mjs";
import {
  ACTION_RESOLUTION_STAGES,
  ACTION_RESULT_STATUS,
  addResolutionStep,
  beginActionResult,
  createActionContext,
  createActionLifecycleEvent,
  createActionResult,
  failActionResult,
  withActionTargets
} from "../helpers/action-resolution.mjs";
import {
  AUTOMATION_EVENT_PHASES,
  AUTOMATION_EVENT_TYPES,
  createAutomationEvent
} from "../helpers/automation-events.mjs";
import {
  ROLL_AUTHORITY,
  ROLL_TYPES,
  createD20RollRequest,
  createDamageRollRequest,
  normalizeRollResponseValue,
  rollFormulaForRequest,
  rollResultToDamageComponents,
  rollResultToResolverRoll
} from "../helpers/rolls.mjs";
import {
  ACTION_RESOLVER_CODES,
  actionActivationCost,
  actionRef,
  attackEvents,
  commitPlannedActionResult,
  finalTargetRefs,
  resolveActionDamage,
  resolveActionEffects,
  resolveActionHealing,
  resolveDamageDurability,
  resolveHealingDurability,
  saveEvents,
  shouldResolveAttack,
  shouldResolveDamage,
  shouldResolveEffects,
  shouldResolveHealing,
  shouldResolveSave,
  shouldResolveTargets
} from "./action-resolver.mjs";
import {resolveActorResourcePayment, withResourceRestores} from "./resource-resolver.mjs";
import {resolveActionTargets} from "./target-resolver.mjs";
import {resolveAttackTargets} from "./attack-resolver.mjs";
import {resolveSaveAgainstDC, resolveSaveTargets} from "./save-resolver.mjs";
import {planConcentrationChecks, resolveConcentrationCheckResults} from "./concentration-resolver.mjs";
import {planEffectLifecycle} from "./effect-lifecycle-resolver.mjs";
import {
  REACTION_WINDOW_TIMINGS,
  completeReactionChildResolution,
  createReactionWindowStage
} from "./reaction-resolver.mjs";

export const ACTION_PIPELINE_STAGE_IDS = Object.freeze({
  CONFIGURATION: "action.configuration",
  TARGETING: "action.targeting",
  RANGE: "action.range",
  CHECK_ROLL: "action.check-roll",
  CHECK_OUTCOME: "action.check-outcome",
  ATTACK_ROLL: "action.attack-roll",
  ATTACK_OUTCOME: "action.attack-outcome",
  REACTION_AFTER_ACTION_DECLARED: "action.reaction.after-action-declared",
  REACTION_AFTER_ATTACK_OUTCOME: "action.reaction.after-attack-outcome",
  REACTION_AFTER_DAMAGE: "action.reaction.after-damage",
  SAVE_ROLL: "action.save-roll",
  SAVE_OUTCOME: "action.save-outcome",
  DAMAGE_ROLL: "action.damage-roll",
  HEALING_ROLL: "action.healing-roll",
  DAMAGE: "action.damage",
  HEALING: "action.healing",
  EFFECTS: "action.effects",
  CONCENTRATION: "action.concentration",
  PAYMENT: "action.payment",
  LEGACY_RESOLUTION: "action.legacy-resolution",
  READY_TO_COMMIT: "action.ready-to-commit",
  COMMIT: "action.commit",
  FINALIZATION: "action.finalization"
});

export const ACTION_PIPELINE_CODES = Object.freeze({
  OK: "OK",
  ACTION_DEFINITION_INVALID: "ACTION_DEFINITION_INVALID",
  ACTION_CONFIGURATION_INVALID: "ACTION_CONFIGURATION_INVALID",
  RANGE_UNAVAILABLE: "RANGE_UNAVAILABLE",
  TARGET_OUT_OF_RANGE: "TARGET_OUT_OF_RANGE",
  ACTION_PLANNING_FAILED: "ACTION_PLANNING_FAILED",
  ACTION_COMMIT_FAILED: "ACTION_COMMIT_FAILED"
});

/* -------------------------------------------- */

/** @param {object} options */
export function createActionResolutionState({
  id=null,
  actor=null,
  actorSystem=null,
  action=null,
  source=null,
  targets=[],
  targeting=null,
  attack=null,
  save=null,
  check=null,
  damage=null,
  healing=null,
  effects=null,
  durability=null,
  concentration=null,
  reactions=null,
  configuration=null,
  configurationContributions=[],
  context={},
  policies={},
  selectedPaymentOptionId=null,
  controller=null,
  parentId=null,
  relationship=null,
  sourceEvent=null,
  depth=0,
  maxDepth=8,
  ancestry=[],
  triggerIdentities=[],
  metadata={}
}={}) {
  const sourceActorSystem = actorSystem ?? actor?.system ?? null;
  const definitionResult = action ? actionDefinitionFromAction(action, {actorSystem: sourceActorSystem}) : null;
  const actionDefinition = definitionResult?.definition ?? null;
  const actionForState = actionFromDefinition(actionDefinition, action);
  const actionSource = source ?? actorSource(actor);

  return createResolutionState({
    id,
    parentId,
    relationship,
    sourceEvent,
    depth,
    maxDepth,
    ancestry,
    triggerIdentities,
    actionDefinition,
    source: actionSource,
    configuration,
    targets,
    input: {
      actorSystem: sourceActorSystem,
      action: actionForState,
      source: actionSource,
      targets,
      targeting,
      attack,
      save,
      check,
      damage,
      healing,
      effects,
      durability,
      concentration,
      reactions,
      configuration,
      configurationContributions,
      context,
      policies,
      selectedPaymentOptionId,
      controller
    },
    validation: definitionResult ? [{
      type: "action-definition",
      ok: definitionResult.ok,
      code: definitionResult.code,
      errors: definitionResult.errors ?? []
    }] : [],
    metadata
  });
}

/* -------------------------------------------- */

export function createActionResolutionPipeline({reactions=false}={}) {
  const stages = [createConfigurationStage()];
  if ( reactions ) stages.push(createActionDeclaredReactionStage());
  stages.push(
    createTargetingStage(),
    createRangeStage(),
    createCheckRollStage(),
    createCheckOutcomeStage(),
    createAttackRollStage(),
    createAttackOutcomeStage()
  );
  if ( reactions ) stages.push(createAttackOutcomeReactionStage());
  stages.push(
    createSaveRollStage(),
    createSaveOutcomeStage(),
    createDamageRollStage(),
    createDamageStage()
  );
  if ( reactions ) stages.push(createDamageReactionStage());
  stages.push(
    createHealingRollStage(),
    createHealingStage(),
    createEffectStage(),
    createConcentrationStage(),
    createPaymentStage(),
    createReadyToCommitStage()
  );
  return stages.map(stage => (TARGETED_STAGE_IDS.has(stage.id) ? skippedWithoutTargets(stage) : stage));
}

const TARGETED_STAGE_IDS = new Set([ACTION_PIPELINE_STAGE_IDS.ATTACK_ROLL, ACTION_PIPELINE_STAGE_IDS.ATTACK_OUTCOME,
  ACTION_PIPELINE_STAGE_IDS.SAVE_ROLL, ACTION_PIPELINE_STAGE_IDS.SAVE_OUTCOME, ACTION_PIPELINE_STAGE_IDS.DAMAGE_ROLL,
  ACTION_PIPELINE_STAGE_IDS.HEALING_ROLL,
  ACTION_PIPELINE_STAGE_IDS.DAMAGE, ACTION_PIPELINE_STAGE_IDS.HEALING, ACTION_PIPELINE_STAGE_IDS.EFFECTS]);

/**
 * An Action whose targets were optional and resolved to nobody (an area that caught no one) still happens:
 * its payment and lasting effects stand, but nothing is rolled against, saved, damaged or affected.
 */
function skippedWithoutTargets(stage) {
  return {...stage, run(state, ...rest) {
    const resolution = state.results?.targetResolution;
    const nobody = !!resolution && !normalizeArray(resolution.targetContexts ?? resolution.targets)
      .some(context => (context?.selected !== false) && !context?.excluded);
    return nobody ? continueResolutionStage({state, data: {skipped: "no-targets"}}) : stage.run(state, ...rest);
  }};
}

/* -------------------------------------------- */

export function planStagedActionResolution(options={}) {
  const state = options.state
    ? createResolutionState(options.state)
    : createActionResolutionState(options);
  const services = {
    ...(options.services ?? {}),
    targetActors: options.targetActors ?? options.services?.targetActors ?? null
  };
  return runResolutionPipeline({
    state,
    stages: createActionResolutionPipeline({reactions: hasReactionPipelineWork(state, services)}),
    services
  });
}

/* -------------------------------------------- */

export function resumeStagedActionResolution({
  state,
  response,
  services={}
}={}) {
  const current = createResolutionState(state);
  return resumeResolutionPipeline({
    state: current,
    response,
    stages: createActionResolutionPipeline({reactions: hasReactionPipelineWork(current, services)}),
    services
  });
}

/* -------------------------------------------- */

export async function executeStagedActionResolution(options={}) {
  if ( options.state?.status === RESOLUTION_STATE_STATUS.COMPLETED ) {
    return actionPipelineResult(createResolutionState(options.state), ACTION_PIPELINE_CODES.OK);
  }
  if ( options.state?.status === RESOLUTION_STATE_STATUS.PAUSED ) {
    return actionPipelineResult(createResolutionState(options.state), ACTION_PIPELINE_CODES.OK);
  }
  const planned = options.state?.status === RESOLUTION_STATE_STATUS.READY_TO_COMMIT
    ? actionPipelineResult(createResolutionState(options.state), ACTION_PIPELINE_CODES.OK)
    : planStagedActionResolution(options);
  if ( planned.waiting || !planned.ok || planned.state.status !== RESOLUTION_STATE_STATUS.READY_TO_COMMIT ) {
    return planned;
  }

  const committing = markActionPipelineStage(planned.state, {
    stageId: ACTION_PIPELINE_STAGE_IDS.COMMIT,
    status: RESOLUTION_STAGE_STATUS.RUNNING,
    lifecycleStatus: RESOLUTION_STATE_STATUS.COMMITTING,
    code: ACTION_PIPELINE_CODES.OK,
    reason: "Committing planned action mutations through ActionResolver transaction boundary."
  });
  const input = committing.input ?? {};
  const actionResult = await commitPlannedActionResult({
    result: committing.results?.actionResult,
    actor: options.actor,
    targetActors: options.targetActors,
    authority: options.authority,
    persistencePort: options.persistencePort ?? input.persistencePort ?? null
  });

  const committed = markActionPipelineStage(updateResolutionState(committing, {
    status: actionResult.ok ? RESOLUTION_STATE_STATUS.COMPLETED : RESOLUTION_STATE_STATUS.FAILED,
    actionContext: actionResult.context,
    mutationPlans: actionResult.mutationPlans,
    events: actionResult.events,
    results: {
      ...committing.results,
      actionResult
    },
    errors: actionResult.ok ? committing.errors : [...committing.errors, ...actionResult.errors]
  }), {
    stageId: ACTION_PIPELINE_STAGE_IDS.COMMIT,
    status: actionResult.ok ? RESOLUTION_STAGE_STATUS.COMPLETED : RESOLUTION_STAGE_STATUS.FAILED,
    lifecycleStatus: actionResult.ok ? RESOLUTION_STATE_STATUS.COMPLETED : RESOLUTION_STATE_STATUS.FAILED,
    code: actionResult.code,
    reason: actionResult.ok ? null : actionResult.errors[0]?.reason ?? actionResult.code,
    data: {
      actionResultStatus: actionResult.status,
      transaction: actionResult.steps?.at(-1)?.data?.transaction ?? null
    }
  });

  if ( !actionResult.ok ) return actionPipelineResult(committed, actionResult.code);

  const finalized = markActionPipelineStage(committed, {
    stageId: ACTION_PIPELINE_STAGE_IDS.FINALIZATION,
    status: RESOLUTION_STAGE_STATUS.COMPLETED,
    lifecycleStatus: RESOLUTION_STATE_STATUS.COMPLETED,
    code: ACTION_PIPELINE_CODES.OK,
    reason: "Action resolution completed."
  });
  return actionPipelineResult(finalized, ACTION_PIPELINE_CODES.OK);
}

/* -------------------------------------------- */

export function completeStagedReactionChildResolution({
  parentState,
  childState=null,
  childResult=null,
  services={},
  targetActors=null,
  directive=null,
  failurePolicy="continue",
  metadata={},
  reevaluate=null
}={}) {
  const parent = createResolutionState(parentState);
  const reactionServices = {
    ...services,
    targetActors: targetActors ?? services.targetActors ?? null
  };
  const reactionOptions = reactionOptionsForState(parent, reactionServices);
  const result = completeReactionChildResolution({
    parentState: parent,
    childState,
    childResult,
    directive,
    failurePolicy,
    metadata,
    reevaluate: reevaluate
      ?? reactionOptions.reevaluate
      ?? ((context) => reevaluateParentAfterReaction({...context, services: reactionServices}))
  });
  const state = result.state ? createResolutionState(result.state) : parent;
  return {
    ...result,
    state,
    status: state.status,
    waiting: state.status === RESOLUTION_STATE_STATUS.PAUSED || state.pendingRequests.length > 0,
    completed: state.status === RESOLUTION_STATE_STATUS.COMPLETED
  };
}

/* -------------------------------------------- */

function createActionDeclaredReactionStage() {
  return createActionPipelineReactionStage({
    id: ACTION_PIPELINE_STAGE_IDS.REACTION_AFTER_ACTION_DECLARED,
    timing: REACTION_WINDOW_TIMINGS.AFTER_ACTION_DECLARED,
    eventSelector: actionDeclaredReactionEvent
  });
}

function createAttackOutcomeReactionStage() {
  return createActionPipelineReactionStage({
    id: ACTION_PIPELINE_STAGE_IDS.REACTION_AFTER_ATTACK_OUTCOME,
    timing: REACTION_WINDOW_TIMINGS.AFTER_OUTCOME,
    eventSelector: attackOutcomeReactionEvent
  });
}

function createDamageReactionStage() {
  return createActionPipelineReactionStage({
    id: ACTION_PIPELINE_STAGE_IDS.REACTION_AFTER_DAMAGE,
    timing: REACTION_WINDOW_TIMINGS.AFTER_DAMAGE,
    eventSelector: damageTakenReactionEvent
  });
}

/**
 * `damage.applied`, once the Action's damage is planned: its targets are the creatures that take some (Temporary Hit
 * Points it takes count), its source the creature dealing it. Null when nobody takes any.
 */
function damageTakenReactionEvent(state) {
  const taken = plan => (Number(plan?.amount) || 0) + Math.max((Number(plan?.temporary?.from) || 0) - (Number(plan?.temporary?.to) || 0), 0);
  const damaged = (state.mutationPlans ?? []).filter(entry => (entry?.type === "durabilityDamage") && (entry.plan?.ok !== false)
    && (taken(entry.plan) > 0)).map(entry => entry.target).filter(Boolean);
  if ( !damaged.length ) return null;
  const input = preparedResolverInput(state);
  return createAutomationEvent({
    id: `event:${state.id}:damage-taken`,
    type: AUTOMATION_EVENT_TYPES.DAMAGE_APPLIED,
    phase: AUTOMATION_EVENT_PHASES.INTERRUPT,
    source: state.actionContext?.source ?? input.source ?? state.source ?? null,
    targets: damaged,
    tags: uniqueStrings([...(state.actionContext?.action?.tags ?? [])]),
    data: {
      action: state.actionContext?.action ?? actionRef(input.action, state.actionDefinition),
      timing: REACTION_WINDOW_TIMINGS.AFTER_DAMAGE
    }
  });
}

function createActionPipelineReactionStage({id, timing, eventSelector}) {
  return createReactionWindowStage({
    id,
    timing,
    eventSelector,
    discovery: ({state, services, event}) => actionReactionDiscoveryOptions({state, services, event, timing}),
    createChildState: ({parentState, candidate, baseChildState, services}) => createActionReactionChildState({
      parentState,
      candidate,
      baseChildState,
      services
    })
  });
}

/* -------------------------------------------- */

function createConfigurationStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.CONFIGURATION,
    run(state) {
      const input = state.input ?? {};
      const invalidDefinition = invalidActionDefinitionValidation(state);
      if ( invalidDefinition ) {
        return failActionPlanningStage({
          state,
          input,
          stage: ACTION_RESOLUTION_STAGES.VALIDATION,
          code: ACTION_PIPELINE_CODES.ACTION_DEFINITION_INVALID,
          reason: invalidDefinition.code,
          errors: invalidDefinition.errors ?? [],
          data: {validation: invalidDefinition}
        });
      }

      const definition = state.configuration?.effectiveDefinition ?? state.actionDefinition;
      if ( !definition ) return continueResolutionStage({state});
      if ( !hasConfigurationWork(definition, input.configurationContributions) ) {
        return continueResolutionStage({state});
      }

      const accepted = getResolutionResponse(state, {
        requestId: requestIdFor(state, "configuration"),
        type: RESOLUTION_REQUEST_TYPES.ACTION_CONFIGURATION
      });
      // A configuration from the intent or the chooser's answer is untrusted: only its choices are read and the
      // authority derives the effective definition. Only the authority's own resumed state skips that.
      const suppliedConfiguration = state.configuration?.effectiveDefinition ? state.configuration : null;

      if ( suppliedConfiguration ) {
        const validation = validateResolvedActionConfiguration({
          configuration: suppliedConfiguration,
          actorSystem: input.actorSystem,
          context: input.context ?? {},
          policies: input.policies ?? {}
        });
        if ( !validation.ok ) return failResolutionStage({
          state,
          code: ACTION_CONFIGURATION_CODES.STALE_CONFIGURATION_STATE,
          reason: validation.code,
          errors: validation.errors,
          data: {validation}
        });
        const configuration = configurationWithValidatedPayment(suppliedConfiguration, validation);
        return continueResolutionStage({
          state: updateResolutionState(state, {
            actionDefinition: configuration.effectiveDefinition,
            configuration,
            input: {
              ...input,
              configuration,
              selectedPaymentOptionId: input.selectedPaymentOptionId ?? configuration.selectedPaymentOptionId
            }
          }),
          data: {
            configurationId: configuration.id,
            validation
          }
        });
      }

      const choices = choiceResponsesFrom(configurationFromInput(input.configuration ?? accepted?.response?.value));
      const discovery = discoverActionConfigurationChoices({
        definition,
        actorSystem: input.actorSystem,
        choices,
        configurationContributions: input.configurationContributions ?? [],
        context: input.context ?? {},
        policies: input.policies ?? {}
      });
      if ( !discovery.ok ) return failResolutionStage({
        state,
        code: ACTION_PIPELINE_CODES.ACTION_DEFINITION_INVALID,
        reason: discovery.code,
        errors: discovery.errors ?? [],
        data: {discovery}
      });

      const missingRequired = discovery.requests.filter(request => request.required && !hasChoiceResponse(choices, request.id));
      if ( missingRequired.length ) {
        return waitResolutionStage({
          state,
          request: createResolutionRequest({
            id: requestIdFor(state, "configuration"),
            resolutionId: state.id,
            stageId: ACTION_PIPELINE_STAGE_IDS.CONFIGURATION,
            type: RESOLUTION_REQUEST_TYPES.ACTION_CONFIGURATION,
            expectedResponseType: "action-configuration",
            payload: {
              actionDefinitionId: definition.id ?? null,
              requests: discovery.requests,
              traces: discovery.traces
            },
            validation: {
              missingRequiredChoiceIds: missingRequired.map(request => request.id)
            }
          }),
          reason: "Action configuration choices are required before resolution can continue.",
          data: {
            requestCount: discovery.requests.length,
            missingRequiredChoiceIds: missingRequired.map(request => request.id)
          }
        });
      }

      const resolved = resolveActionConfiguration({
        definition,
        actorSystem: input.actorSystem,
        choices,
        configurationContributions: input.configurationContributions ?? [],
        context: input.context ?? {},
        policies: input.policies ?? {}
      });
      if ( !resolved.ok ) return failResolutionStage({
        state,
        code: ACTION_PIPELINE_CODES.ACTION_CONFIGURATION_INVALID,
        reason: resolved.code,
        errors: resolved.errors ?? [],
        data: {resolved}
      });

      const preview = createResolvedActionPreview({
        definition,
        actorSystem: input.actorSystem,
        choices,
        configurationContributions: input.configurationContributions ?? [],
        context: input.context ?? {},
        policies: input.policies ?? {}
      });
      return continueResolutionStage({
        state: updateResolutionState(state, {
          actionDefinition: resolved.configuration.effectiveDefinition,
          configuration: resolved.configuration,
          input: {
            ...input,
            configuration: resolved.configuration,
            selectedPaymentOptionId: input.selectedPaymentOptionId ?? resolved.configuration.selectedPaymentOptionId
          },
          results: {
            ...state.results,
            ...(preview.ok ? {preview: preview.preview, previewResult: preview} : {})
          }
        }),
        data: {
          configurationId: resolved.configuration.id,
          requestCount: discovery.requests.length,
          preview: preview.ok ? preview.preview : null
        },
        trace: resolved.traces.map(trace => ({
          id: `trace:${state.id}:configuration:${trace.choiceId ?? "choice"}`,
          stageId: ACTION_PIPELINE_STAGE_IDS.CONFIGURATION,
          status: RESOLUTION_STAGE_STATUS.COMPLETED,
          result: "continue",
          code: trace.code ?? ACTION_PIPELINE_CODES.OK,
          reason: trace.reason ?? null,
          requestIds: [],
          data: trace
        }))
      });
    }
  });
}

function createTargetingStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.TARGETING,
    run(state) {
      let input = preparedResolverInput(state);
      // An Action its creature cannot pay for (its Action spent, or capped at 0: Incapacitated, Command's Halt) is refused
      // before anything is rolled; the payment stage still pays it at the end.
      const affordable = resolveActorResourcePayment({
        actorSystem: input.actorSystem,
        cost: actionActivationCost(input.action, state.actionDefinition),
        action: state.actionContext?.action ?? null,
        policies: input.policies ?? {},
        selectedPaymentOptionId: input.selectedPaymentOptionId ?? null,
        selectedPaymentPlan: state.configuration?.selectedPaymentPlan ?? input.configuration?.selectedPaymentPlan ?? null
      });
      if ( !affordable.ok && input.actorSystem ) return failResolutionStage({state, code: ACTION_RESOLVER_CODES.PAYMENT_UNAVAILABLE,
        reason: ACTION_RESOLVER_CODES.PAYMENT_UNAVAILABLE, data: {payment: affordable}});
      const accepted = getResolutionResponse(state, {
        requestId: requestIdFor(state, "targets"),
        type: RESOLUTION_REQUEST_TYPES.TARGET_SELECTION
      }) ?? getResolutionResponse(state, {
        requestId: requestIdFor(state, "target-refinement"),
        type: RESOLUTION_REQUEST_TYPES.TARGET_REFINEMENT
      });
      if ( accepted ) {
        // The chooser contributes refinement decisions only. Candidates, targets, and policy remain the
        // authority's own, so refineTargetSet rejects unknown ids, ineligible targets, and bad counts.
        const value = accepted.response.value;
        const decisions = normalizeArray(value?.decisions ?? value?.targeting?.decisions)
          .map(decision => ({operation: decision?.operation ?? null, targetId: decision?.targetId ?? null}));
        input = {...input, targeting: {...(input.targeting ?? {}), decisions}};
        state = updateResolutionState(state, {input});
      }

      const targeting = input.targeting;
      if ( !accepted && needsTargetInput({targeting, targets: input.targets ?? []}) ) {
        const refinement = needsTargetRefinement(targeting);
        const offered = refinement ? targetingWithDefaultSelection(state, input, targeting) : targeting;
        return waitResolutionStage({
          state,
          request: createResolutionRequest({
            id: requestIdFor(state, refinement ? "target-refinement" : "targets"),
            resolutionId: state.id,
            stageId: ACTION_PIPELINE_STAGE_IDS.TARGETING,
            type: refinement ? RESOLUTION_REQUEST_TYPES.TARGET_REFINEMENT : RESOLUTION_REQUEST_TYPES.TARGET_SELECTION,
            expectedResponseType: refinement ? "target-refinement" : "target-selection",
            payload: {
              actionDefinitionId: state.actionDefinition?.id ?? null,
              targeting: offered,
              targets: input.targets ?? [],
              candidates: offered?.candidates ?? [],
              targetSet: offered?.targetSet ?? null
            },
            validation: {
              required: targeting?.required === true,
              refinement
            }
          }),
          reason: refinement
            ? "Target refinement is required before action resolution can continue."
            : "Target selection is required before action resolution can continue."
        });
      }

      const planning = ensureActionPlanningResult(state, input);
      if ( planning.failed ) return planning.failed;
      let {actionContext, actionResult} = planning;
      if ( !shouldResolveTargets({targeting, actionContext}) ) {
        return continueResolutionStage({
          state: stateWithActionResult(state, {
            input,
            actionResult
          })
        });
      }

      const targetResolution = resolveActionTargets({
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
        return failActionPlanningStage({
          state,
          input,
          actionResult,
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
      actionResult = createActionResult({...actionResult, context: actionContext});
      actionResult = addResolutionStep(actionResult, {
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

      return continueResolutionStage({
        state: stateWithActionResult(state, {
          input: {
            ...input,
            targets: finalTargetRefs(targetResolution),
            targeting
          },
          actionResult,
          results: {targetResolution},
          targets: finalTargetRefs(targetResolution),
          targetSet: targetResolution.refinement,
          targetRefinement: targetResolution.refinement
        }),
        data: {
          targetCount: targetResolution.refinement?.finalTargets?.length ?? 0
        }
      });
    }
  });
}

function createRangeStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.RANGE,
    run(state) {
      const input = preparedResolverInput(state);
      const range = rangeDefinitionFromInput(input);
      const targetContexts = state.results?.targetResolution?.targetContexts ?? [];
      // An area's own placement is what its range limits (its point, its cube); whoever it covers is a target, however
      // far ("self" cones and cubes reach beyond the caster).
      const area = (state.actionDefinition?.targeting?.type ?? input.targeting?.type) === "area";
      if ( !range || !targetContexts.length || area ) return continueResolutionStage({
        state: updateResolutionState(state, {input})
      });

      const sourceFootprint = sourceFootprintFromInput(input);
      const gridDistance = gridDistanceFromInput(input);
      if ( !sourceFootprint || !gridDistance ) {
        return failActionPlanningStage({
          state,
          input,
          stage: ACTION_RESOLUTION_STAGES.TARGETING,
          code: ACTION_PIPELINE_CODES.RANGE_UNAVAILABLE,
          reason: "Range validation requires source footprint and grid distance.",
          data: {range, spatial: spatialSummary(input)}
        });
      }

      const checks = [];
      const failures = [];
      for ( const targetContext of targetContexts.filter(context => context.selected !== false && !context.excluded) ) {
        const targetFootprint = targetFootprintForContext(input, targetContext);
        if ( !targetFootprint ) {
          failures.push({
            code: ACTION_PIPELINE_CODES.RANGE_UNAVAILABLE,
            reason: "Range validation requires target footprint.",
            target: targetContext.target ?? targetContext
          });
          continue;
        }
        const fields = footprintDistance(sourceFootprint, targetFootprint);
        const distance = fields * gridDistance;
        const band = rangeBandForDistance(range, distance);
        const check = {
          ok: band.ok,
          code: band.code,
          target: clonePlain(targetContext.target ?? targetContext),
          targetRefs: targetLookupRefs(targetContext.target ?? targetContext),
          fields,
          distance,
          gridDistance,
          band: band.band,
          range
        };
        checks.push(check);
        if ( !check.ok ) failures.push(check);
      }

      if ( failures.length ) {
        return failActionPlanningStage({
          state,
          input,
          stage: ACTION_RESOLUTION_STAGES.TARGETING,
          code: ACTION_PIPELINE_CODES.TARGET_OUT_OF_RANGE,
          // What the user is told: who is out of range, and how far (3D, with elevation).
          reason: Number.isFinite(failures[0].distance)
            ? `${failures[0].target?.name ?? "A target"} is out of range (${failures[0].distance} ft away).`
            : failures[0].code,
          data: {
            range,
            checks,
            failures
          }
        });
      }

      return continueResolutionStage({
        state: updateResolutionState(state, {
          input,
          results: {
            ...state.results,
            rangeResolution: {
              ok: true,
              code: ACTION_PIPELINE_CODES.OK,
              range,
              checks
            }
          }
        }),
        data: {
          checkCount: checks.length,
          range
        }
      });
    }
  });
}

/** The acting creature's own ability check, rolled by its controller like an attack (2024: no contest). */
function createCheckRollStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.CHECK_ROLL,
    run(state) {
      const input = preparedResolverInput(state);
      const requestId = requestIdFor(state, "check-roll");
      const accepted = getResolutionResponse(state, {requestId, type: RESOLUTION_REQUEST_TYPES.ROLL});
      if ( accepted ) {
        const rollRequest = rollRequestFromAcceptedResponse(accepted, () => checkRollRequestForState(state, input));
        const normalized = normalizeRollResponseValue(accepted.response.value, {request: rollRequest,
          completedRequestIds: completedRollRequestIds(state)});
        if ( !normalized.ok ) return failResolutionStage({state, code: normalized.code, reason: normalized.reason,
          errors: [{code: normalized.code, reason: normalized.reason, requestId, validation: normalized.validation}],
          data: {requestId, rollRequest, validation: normalized.validation}});
        const check = {...input.check, roll: rollResultToResolverRoll(normalized.result)};
        return continueResolutionStage({
          state: updateResolutionState(state, {
            input: {...input, check},
            rollRequests: appendRollRequest(state.rollRequests, rollRequest),
            rollResults: [...state.rollResults, {requestId: accepted.request.id, type: "check-roll",
              semanticType: normalized.result.type, rollRequest, rollResult: normalized.result, roll: check.roll}]
          }),
          data: {requestId: accepted.request.id, rollRequestId: rollRequest.id, semanticType: normalized.result.type}
        });
      }
      if ( !input.check || hasRollTotal(input.check.roll) ) return continueResolutionStage({state: updateResolutionState(state, {input})});
      const rollRequest = checkRollRequestForState(state, input);
      return waitResolutionStage({
        state: updateResolutionState(state, {rollRequests: appendRollRequest(state.rollRequests, rollRequest)}),
        request: createResolutionRequest({
          id: rollRequest.id,
          resolutionId: state.id,
          stageId: ACTION_PIPELINE_STAGE_IDS.CHECK_ROLL,
          type: RESOLUTION_REQUEST_TYPES.ROLL,
          expectedResponseType: "roll-result",
          chooser: rollRequest.chooser,
          authority: rollRequest.authority,
          validation: {rollRequestId: rollRequest.id, semanticType: rollRequest.type,
            requireNatural: rollRequest.expected.requireNatural, formula: rollFormulaForRequest(rollRequest).formula ?? null},
          payload: {actionDefinitionId: state.actionDefinition?.id ?? null, rollKind: "check", rollRequest}
        }),
        reason: "Check roll result is required before action resolution can continue."
      });
    }
  });
}

/** Success or failure of the Action's check against its DC, by the same d20-vs-DC rule as a save. */
function createCheckOutcomeStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.CHECK_OUTCOME,
    run(state) {
      const input = preparedResolverInput(state);
      if ( !input.check || state.results?.checkResolution ) return continueResolutionStage({state: updateResolutionState(state, {input})});
      const resolveCheck = roll => resolveSaveAgainstDC({roll, dc: input.check.dc, policy: input.check.policy ?? {}});
      let checkResolution = resolveCheck(input.check.roll);
      if ( !checkResolution.ok ) return failResolutionStage({state, code: checkResolution.code, reason: checkResolution.reason,
        data: {checkResolution}});
      // Heroic Inspiration may reroll it (the creature's own failure, or a monster's check by the GM's choice).
      const reroll = inspirationReroll(state, input, {offer: input.check.inspiration, failed: !checkResolution.success, key: "check",
        roll: input.check.roll,
        stageId: ACTION_PIPELINE_STAGE_IDS.CHECK_OUTCOME, rollKind: "check",
        makeRollRequest: suffix => checkRollRequestForState(state, input, {suffix})});
      if ( reroll.wait || reroll.fail ) return reroll.wait ?? reroll.fail;
      if ( !reroll.roll ) return continueResolutionStage({
        state: updateResolutionState(state, {input, results: {...state.results, checkResolution}}),
        data: {success: checkResolution.success}
      });
      const rerolled = {...input, check: {...input.check, roll: reroll.roll}};
      checkResolution = resolveCheck(reroll.roll);
      // The point is paid in the Action's own transaction, like its costs.
      const planning = ensureActionPlanningResult(state, rerolled);
      if ( planning.failed ) return planning.failed;
      const actionResult = addResolutionStep(planning.actionResult, {stage: ACTION_RESOLUTION_STAGES.ROLL, events: [], consequences: [],
        mutationPlans: [reroll.payment].filter(Boolean), data: {checkResolution}});
      return continueResolutionStage({
        state: withRerolls(stateWithActionResult(state, {input: rerolled, actionResult, results: {checkResolution}}), [reroll]),
        data: {success: checkResolution.success}
      });
    }
  });
}

function createAttackRollStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.ATTACK_ROLL,
    run(state) {
      const input = preparedResolverInput(state);
      const requestId = requestIdFor(state, "attack-roll");
      const accepted = getResolutionResponse(state, {
        requestId,
        type: RESOLUTION_REQUEST_TYPES.ROLL
      });
      if ( accepted ) {
        const rollRequest = rollRequestFromAcceptedResponse(accepted, () => attackRollRequestForState(state, input));
        const normalized = normalizeRollResponseValue(accepted.response.value, {
          request: rollRequest,
          completedRequestIds: completedRollRequestIds(state)
        });
        if ( !normalized.ok ) return failResolutionStage({
          state,
          code: normalized.code,
          reason: normalized.reason,
          errors: [{
            code: normalized.code,
            reason: normalized.reason,
            requestId,
            validation: normalized.validation
          }],
          data: {
            requestId,
            rollRequest,
            validation: normalized.validation
          }
        });
        const resolverRoll = rollResultToResolverRoll(normalized.result);
        const attack = {
          ...(input.attack ?? {}),
          roll: resolverRoll
        };
        return continueResolutionStage({
          state: updateResolutionState(state, {
            input: {...input, attack},
            rollRequests: appendRollRequest(state.rollRequests, rollRequest),
            rollResults: [
              ...state.rollResults,
              {
                requestId: accepted.request.id,
                type: "attack-roll",
                semanticType: normalized.result.type,
                rollRequest,
                rollResult: normalized.result,
                roll: attack.roll
              }
            ]
          }),
          data: {
            requestId: accepted.request.id,
            rollRequestId: rollRequest.id,
            semanticType: normalized.result.type
          }
        });
      }

      if ( !input.attack || hasRollTotal(input.attack.roll) ) {
        return continueResolutionStage({
          state: updateResolutionState(state, {input})
        });
      }

      const rollRequest = attackRollRequestForState(state, input);
      return waitResolutionStage({
        state: updateResolutionState(state, {
          rollRequests: appendRollRequest(state.rollRequests, rollRequest)
        }),
        request: createResolutionRequest({
          id: rollRequest.id,
          resolutionId: state.id,
          stageId: ACTION_PIPELINE_STAGE_IDS.ATTACK_ROLL,
          type: RESOLUTION_REQUEST_TYPES.ROLL,
          expectedResponseType: "roll-result",
          chooser: rollRequest.chooser,
          authority: rollRequest.authority,
          validation: {
            rollRequestId: rollRequest.id,
            semanticType: rollRequest.type,
            requireNatural: rollRequest.expected.requireNatural,
            formula: rollFormulaForRequest(rollRequest).formula ?? null
          },
          payload: {
            actionDefinitionId: state.actionDefinition?.id ?? null,
            rollKind: "attack",
            rollRequest,
            attack: input.attack,
            targets: input.targets ?? [],
            targeting: input.targeting ?? null
          }
        }),
        reason: "Attack roll result is required before action resolution can continue."
      });
    }
  });
}

function createAttackOutcomeStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.ATTACK_OUTCOME,
    run(state, services={}) {
      let input = preparedResolverInput(state);
      if ( !shouldResolveAttack(input.attack) ) return continueResolutionStage({
        state: updateResolutionState(state, {input})
      });
      const planning = ensureActionPlanningResult(state, input);
      if ( planning.failed ) return planning.failed;
      const {actionContext} = planning;
      let {actionResult} = planning;
      const attack = attackInputWithCurrentDefenses(input.attack, {
        targetActors: services.targetActors ?? null,
        targetContexts: state.results?.targetResolution?.targetContexts ?? [],
        targets: state.results?.targetResolution ? [] : actionContext.targets
      });
      input = {...input, attack};

      const resolveAttack = roll => resolveAttackTargets({
        roll,
        targetContexts: withAttackBonuses(withOutcomeOverrides(attack.targetContexts ?? state.results?.targetResolution?.targetContexts ?? [],
          attack.outcomesByTarget), attack.bonusByTarget),
        targets: attack.targets ?? (state.results?.targetResolution ? [] : actionContext.targets),
        defense: attack.defense ?? null,
        defenseKey: attack.defenseKey ?? "ac",
        policy: {...(input.policies?.attack ?? {}), ...(attack.policy ?? {})},
        context: {
          action: actionContext.action,
          source: actionContext.source,
          ...(attack.context ?? {})
        }
      });
      let attackResolution = resolveAttack(attack.roll);
      // Heroic Inspiration may reroll it (a miss of a player's character, or a monster's attack by the GM's choice).
      const reroll = attackResolution.ok ? inspirationReroll(state, input, {offer: attack.inspiration, roll: attack.roll,
        failed: !attackResolution.hits.length, key: "attack", stageId: ACTION_PIPELINE_STAGE_IDS.ATTACK_OUTCOME, rollKind: "attack",
        makeRollRequest: suffix => attackRollRequestForState(state, input, {suffix})}) : {};
      if ( reroll.wait || reroll.fail ) return reroll.wait ?? reroll.fail;
      if ( reroll.roll ) {
        input = {...input, attack: {...attack, roll: reroll.roll}};
        attackResolution = resolveAttack(reroll.roll);
      }
      if ( !attackResolution.ok ) {
        return failActionPlanningStage({
          state,
          input,
          actionResult,
          stage: ACTION_RESOLUTION_STAGES.ROLL,
          code: ACTION_RESOLVER_CODES.ATTACK_FAILED,
          reason: attackResolution.code,
          data: {attackResolution}
        });
      }

      actionResult = addResolutionStep(actionResult, {
        stage: ACTION_RESOLUTION_STAGES.ROLL,
        events: attackEvents(actionContext, attackResolution),
        consequences: [{
          type: "attackResolved",
          attackResolution
        }],
        mutationPlans: reroll.payment ? [reroll.payment] : [],
        data: {attackResolution}
      });

      return continueResolutionStage({
        state: withRerolls(stateWithActionResult(state, {
          input,
          actionResult,
          results: {attackResolution}
        }), reroll.roll ? [reroll] : []),
        data: {
          hitCount: attackResolution.hits.length,
          missCount: attackResolution.misses.length
        }
      });
    }
  });
}

function createSaveRollStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.SAVE_ROLL,
    run(state) {
      const input = preparedResolverInput(state);
      const saveTargets = input.save ? selectedSaveTargets(state, input) : [];
      // A target that fails automatically rolls nothing; the others roll their own saves.
      const rolling = saveTargets.filter(target => !input.save?.outcomesByTarget?.[rollModeTargetKey(target)]);
      if ( rolling.length < saveTargets.length ) {
        return rolling.length ? requestPerTargetSaves(state, input, rolling)
          : continueResolutionStage({state: updateResolutionState(state, {input})});
      }
      if ( (saveTargets.length > 1) && !hasSaveRollInput(input.save, input) ) {
        return requestPerTargetSaves(state, input, saveTargets);
      }
      const requestId = requestIdFor(state, "save-roll");
      const accepted = getResolutionResponse(state, {
        requestId,
        type: RESOLUTION_REQUEST_TYPES.ROLL
      });
      if ( accepted ) {
        const rollRequest = rollRequestFromAcceptedResponse(accepted, () => saveRollRequestForState(state, input));
        const normalized = normalizeRollResponseValue(accepted.response.value, {
          request: rollRequest,
          completedRequestIds: completedRollRequestIds(state)
        });
        if ( !normalized.ok ) return failResolutionStage({
          state,
          code: normalized.code,
          reason: normalized.reason,
          errors: [{
            code: normalized.code,
            reason: normalized.reason,
            requestId,
            validation: normalized.validation
          }],
          data: {
            requestId,
            rollRequest,
            validation: normalized.validation
          }
        });
        const resolverRoll = rollResultToResolverRoll(normalized.result);
        const save = {
          ...(input.save ?? {}),
          roll: resolverRoll
        };
        return continueResolutionStage({
          state: updateResolutionState(state, {
            input: {...input, save},
            rollRequests: appendRollRequest(state.rollRequests, rollRequest),
            rollResults: [
              ...state.rollResults,
              {
                requestId: accepted.request.id,
                type: "save-roll",
                semanticType: normalized.result.type,
                rollRequest,
                rollResult: normalized.result,
                roll: save.roll
              }
            ]
          }),
          data: {
            requestId: accepted.request.id,
            rollRequestId: rollRequest.id,
            semanticType: normalized.result.type
          }
        });
      }

      if ( !input.save || hasSaveRollInput(input.save, input) ) {
        return continueResolutionStage({
          state: updateResolutionState(state, {input})
        });
      }

      const rollRequest = saveRollRequestForState(state, input);
      return waitResolutionStage({
        state: updateResolutionState(state, {
          rollRequests: appendRollRequest(state.rollRequests, rollRequest)
        }),
        request: createResolutionRequest({
          id: rollRequest.id,
          resolutionId: state.id,
          stageId: ACTION_PIPELINE_STAGE_IDS.SAVE_ROLL,
          type: RESOLUTION_REQUEST_TYPES.ROLL,
          expectedResponseType: "roll-result",
          chooser: rollRequest.chooser,
          authority: rollRequest.authority,
          validation: {
            rollRequestId: rollRequest.id,
            semanticType: rollRequest.type,
            requireNatural: rollRequest.expected.requireNatural,
            formula: rollFormulaForRequest(rollRequest).formula ?? null
          },
          payload: {
            actionDefinitionId: state.actionDefinition?.id ?? null,
            rollKind: "save",
            rollRequest,
            save: input.save,
            targets: input.targets ?? [],
            targeting: input.targeting ?? null
          }
        }),
        reason: "Saving throw result is required before action resolution can continue."
      });
    }
  });
}

/**
 * Each selected target rolls its own save, routed to its own controller, one request after another. The
 * first keeps the single-target id (`save-roll`); each roll is recorded under the target's id and handed to
 * that target's context by the outcome stage.
 */
function requestPerTargetSaves(state, input, targets) {
  let current = state;
  let save = {...input.save, rollsByTarget: {...(input.save.rollsByTarget ?? {})}};
  // Every missing save is asked for at once: players roll side by side, and the GM gets the monsters' together.
  const waiting = [];
  for ( const [index, target] of targets.entries() ) {
    const key = saveTargetKey(target);
    if ( save.rollsByTarget[key] ) continue;
    const suffix = index === 0 ? "save-roll" : `save-roll:${index + 1}`;
    const requestId = requestIdFor(current, suffix);
    const accepted = getResolutionResponse(current, {requestId, type: RESOLUTION_REQUEST_TYPES.ROLL});
    const rollRequest = accepted
      ? rollRequestFromAcceptedResponse(accepted, () => saveRollRequestForState(current, input, {target, suffix}))
      : saveRollRequestForState(current, input, {target, suffix});
    if ( !accepted ) {
      current = updateResolutionState(current, {rollRequests: appendRollRequest(current.rollRequests, rollRequest)});
      waiting.push(createResolutionRequest({
        id: rollRequest.id,
        resolutionId: current.id,
        stageId: ACTION_PIPELINE_STAGE_IDS.SAVE_ROLL,
        type: RESOLUTION_REQUEST_TYPES.ROLL,
        expectedResponseType: "roll-result",
        chooser: rollRequest.chooser,
        authority: rollRequest.authority,
        validation: {
          rollRequestId: rollRequest.id,
          semanticType: rollRequest.type,
          requireNatural: rollRequest.expected.requireNatural,
          formula: rollFormulaForRequest(rollRequest).formula ?? null
        },
        payload: {
          actionDefinitionId: current.actionDefinition?.id ?? null,
          rollKind: "save",
          rollRequest,
          save: input.save,
          targets: [target],
          targeting: input.targeting ?? null
        }
      }));
      continue;
    }
    const normalized = normalizeRollResponseValue(accepted.response.value, {
      request: rollRequest,
      completedRequestIds: completedRollRequestIds(current)
    });
    if ( !normalized.ok ) return failResolutionStage({
      state: current,
      code: normalized.code,
      reason: normalized.reason,
      errors: [{code: normalized.code, reason: normalized.reason, requestId, validation: normalized.validation}],
      data: {requestId, rollRequest, validation: normalized.validation}
    });
    const roll = rollResultToResolverRoll(normalized.result);
    save = {...save, rollsByTarget: {...save.rollsByTarget, [key]: roll}};
    current = updateResolutionState(current, {
      input: {...input, save},
      rollRequests: appendRollRequest(current.rollRequests, rollRequest),
      rollResults: [...current.rollResults, {requestId: accepted.request.id, type: "save-roll",
        semanticType: normalized.result.type, rollRequest, rollResult: normalized.result, roll, targetKey: key}]
    });
  }
  if ( waiting.length ) return waitResolutionStage({
    state: updateResolutionState(current, {input: {...input, save}}),
    requests: waiting,
    reason: "Saving throw results are required before action resolution can continue."
  });
  return continueResolutionStage({state: current, data: {saveRollCount: targets.length}});
}

function selectedSaveTargets(state, input) {
  const contexts = state.results?.targetResolution?.targetContexts;
  if ( contexts?.length ) return contexts.filter(context => (context.selected !== false) && !context.excluded)
    .map(context => context.target ?? context);
  return normalizeArray(input.targets);
}

/** The Token a target (a ref, a candidate, or a candidate's target) stands for: how the runtime keys per-target data. */
function rollModeTargetKey(target) {
  return String(target?.tokenId ?? target?.target?.tokenId ?? target?.metadata?.foundry?.tokenId ?? target?.id ?? "");
}

/** Target contexts with the outcome the runtime forced on them (keyed by Token) added as an override. */
function withOutcomeOverrides(entries, outcomesByTarget) {
  if ( !outcomesByTarget ) return entries;
  return normalizeArray(entries).map(entry => {
    const outcome = outcomesByTarget[rollModeTargetKey(entry?.target ?? entry)];
    return outcome ? {...entry, overrides: [...(entry?.overrides ?? []), {type: outcome}]} : entry;
  });
}

/** Target contexts with the runtime's bonus against each of them (keyed by Token: high ground) added as an override. */
function withAttackBonuses(entries, bonusByTarget) {
  if ( !bonusByTarget ) return entries;
  return normalizeArray(entries).map(entry => {
    const value = Number(bonusByTarget[rollModeTargetKey(entry?.target ?? entry)]) || 0;
    return value ? {...entry, overrides: [...(entry?.overrides ?? []), {type: "attack-bonus", value}]} : entry;
  });
}

/**
 * Legendary Resistance: the failing targets that may succeed instead (`save.legendaryByTarget`, by Token, from the
 * runtime) and do: at once when their policy is `always`, else when their controller chooses to. Waits for the first
 * unanswered choice; each is asked once, of the target's own controller.
 */
function legendaryResistanceChoices(state, input, saveResolution) {
  const byTarget = input.save.legendaryByTarget ?? {};
  const chosen = [];
  for ( const failure of saveResolution.failures ) {
    const key = rollModeTargetKey(failure.target);
    const entry = byTarget[key];
    if ( !entry?.plan ) continue;
    if ( entry.policy === "always" ) {
      chosen.push(key);
      continue;
    }
    const requestId = requestIdFor(state, `legendary-resistance:${key}`);
    const accepted = getResolutionResponse(state, {requestId, type: RESOLUTION_REQUEST_TYPES.CHOICE});
    if ( !accepted ) return {chosen, wait: waitResolutionStage({
      state: updateResolutionState(state, {input}),
      request: createResolutionRequest({
        id: requestId,
        resolutionId: state.id,
        stageId: ACTION_PIPELINE_STAGE_IDS.SAVE_OUTCOME,
        type: RESOLUTION_REQUEST_TYPES.CHOICE,
        expectedResponseType: "choice",
        chooser: ROLL_AUTHORITY.TARGET_CONTROLLER,
        authority: {kind: ROLL_AUTHORITY.TARGET_CONTROLLER},
        payload: {id: "legendary-resistance", label: entry.label ?? "WILDPATH.LEGENDARY.Title",
          options: [{value: "use", label: "WILDPATH.LEGENDARY.Use"}, {value: "decline", label: "WILDPATH.LEGENDARY.Decline"}],
          defaultValue: "use", targets: [failure.targetContext?.target ?? failure.target]},
        metadata: {title: "WILDPATH.LEGENDARY.Title"}
      }),
      reason: "A creature that failed its save may choose to succeed instead."
    })};
    const value = accepted.response?.value;
    if ( (value?.choices?.["legendary-resistance"] ?? value) === "use" ) chosen.push(key);
  }
  return {chosen};
}

/**
 * Heroic Inspiration (BG3, G8) once a d20 has resolved. `offer` comes from the runtime:
 * - a player character's own point (`own`), offered only when the roll `failed`;
 * - a monster's roll, rerolled with any player character's point, the GM choosing (`gm`).
 * It asks a choice, then waits for the new roll (a fresh request id, `<kind>-roll:reroll:<key>`). It returns
 * `{roll, rollRequest, rollResult, payment}` (the payment is the payer's `resourcePayment`), `{wait}` meanwhile,
 * `{fail}` for a bad roll, and `{}` when the roll is kept or nothing is offered.
 */
/**
 * A die added to a failed d20 test (2024 Bardic Inspiration: "roll the Bardic Inspiration die and add the number
 * rolled"): its roller rolls it, and the test's total grows by it. Paid by the option's `payment` (ending the effect
 * that gave the die). Returns what inspirationReroll returns.
 */
function addedDie(state, input, {option, key, stageId, rollKind, makeRollRequest, targets, original}) {
  const base = makeRollRequest(`${rollKind}-roll:added:${key}`);
  const faces = Number(option.addDice.faces) || 6;
  const number = Number(option.addDice.number) || 1;
  const rollRequest = createDamageRollRequest({id: base.id, resolutionId: state.id, type: ROLL_TYPES.CUSTOM, formula: `${number}d${faces}`,
    definition: {dice: [{number, faces}]}, source: base.source, target: base.target, chooser: base.chooser, authority: base.authority,
    metadata: {...(base.metadata ?? {}), rollKind: `${rollKind}-added-die`}});
  const accepted = getResolutionResponse(state, {requestId: rollRequest.id, type: RESOLUTION_REQUEST_TYPES.ROLL});
  if ( !accepted ) return {wait: waitResolutionStage({
    state: updateResolutionState(state, {input, rollRequests: appendRollRequest(state.rollRequests, rollRequest)}),
    request: createResolutionRequest({id: rollRequest.id, resolutionId: state.id, stageId, type: RESOLUTION_REQUEST_TYPES.ROLL,
      expectedResponseType: "roll-result", chooser: rollRequest.chooser, authority: rollRequest.authority,
      validation: {rollRequestId: rollRequest.id, semanticType: rollRequest.type, requireNatural: false, formula: rollRequest.formula},
      payload: {actionDefinitionId: state.actionDefinition?.id ?? null, rollKind: `${rollKind}-added-die`, rollRequest, targets}}),
    reason: "The added die is required before action resolution can continue."
  })};
  const request = rollRequestFromAcceptedResponse(accepted, () => rollRequest);
  const normalized = normalizeRollResponseValue(accepted.response.value, {request, completedRequestIds: completedRollRequestIds(state)});
  if ( !normalized.ok ) return {fail: failResolutionStage({state, code: normalized.code, reason: normalized.reason,
    errors: [{code: normalized.code, reason: normalized.reason, requestId: rollRequest.id}], data: {requestId: rollRequest.id}})};
  const added = Number(normalized.result.total) || 0;
  const roll = {...(original ?? {}), total: (Number(original?.total) || 0) + added,
    modifiers: [...(original?.modifiers ?? []), {id: "added-die", value: added, label: option.label ?? null}]};
  return {roll, rollRequest: request,
    rollResult: {requestId: accepted.request.id, type: `${rollKind}-added-die`, semanticType: normalized.result.type, rollRequest: request,
      rollResult: normalized.result, roll, reroll: true, targetKey: key},
    payment: option.payment ?? null};
}

function inspirationReroll(state, input, {offer, failed, key, stageId, rollKind, makeRollRequest, targets=[], roll: original=null}) {
  if ( !offer?.options?.length || (offer.own && !failed) ) return {};
  const choiceId = requestIdFor(state, `heroic-inspiration:${key}`);
  const chosen = getResolutionResponse(state, {requestId: choiceId, type: RESOLUTION_REQUEST_TYPES.CHOICE});
  if ( !chosen ) return {wait: waitResolutionStage({
    state: updateResolutionState(state, {input}),
    request: createResolutionRequest({
      id: choiceId,
      resolutionId: state.id,
      stageId,
      type: RESOLUTION_REQUEST_TYPES.CHOICE,
      expectedResponseType: "choice",
      chooser: offer.chooser,
      authority: {kind: offer.chooser},
      payload: {id: "heroic-inspiration", label: offer.label ?? "WILDPATH.INSPIRATION.Title",
        options: [...offer.options.map(option => ({value: option.value, label: option.label})),
          {value: "keep", label: "WILDPATH.INSPIRATION.Keep"}],
        defaultValue: "keep", targets},
      metadata: {title: "WILDPATH.INSPIRATION.Title"}
    }),
    reason: "A d20 may be rerolled with Heroic Inspiration."
  })};
  const value = chosen.response?.value;
  const option = offer.options.find(entry => entry.value === (value?.choices?.["heroic-inspiration"] ?? value));
  if ( !option ) return {};
  // Bardic Inspiration adds a die to the roll instead of rolling it again.
  if ( option.addDice ) return addedDie(state, input, {option, key, stageId, rollKind, makeRollRequest, targets, original});
  // A reroll may add a bonus (Indomitable: its fighter level).
  const rollRequest = makeRollRequest(`${rollKind}-roll:reroll:${key}`, Number(option.bonus) || 0);
  const accepted = getResolutionResponse(state, {requestId: rollRequest.id, type: RESOLUTION_REQUEST_TYPES.ROLL});
  if ( !accepted ) return {wait: waitResolutionStage({
    state: updateResolutionState(state, {input, rollRequests: appendRollRequest(state.rollRequests, rollRequest)}),
    request: createResolutionRequest({
      id: rollRequest.id,
      resolutionId: state.id,
      stageId,
      type: RESOLUTION_REQUEST_TYPES.ROLL,
      expectedResponseType: "roll-result",
      chooser: rollRequest.chooser,
      authority: rollRequest.authority,
      validation: {rollRequestId: rollRequest.id, semanticType: rollRequest.type, requireNatural: rollRequest.expected.requireNatural,
        formula: rollFormulaForRequest(rollRequest).formula ?? null},
      payload: {actionDefinitionId: state.actionDefinition?.id ?? null, rollKind, rollRequest, targets}
    }),
    reason: "The rerolled d20 is required before action resolution can continue."
  })};
  const request = rollRequestFromAcceptedResponse(accepted, () => rollRequest);
  const normalized = normalizeRollResponseValue(accepted.response.value, {request, completedRequestIds: completedRollRequestIds(state)});
  if ( !normalized.ok ) return {fail: failResolutionStage({state, code: normalized.code, reason: normalized.reason,
    errors: [{code: normalized.code, reason: normalized.reason, requestId: rollRequest.id, validation: normalized.validation}],
    data: {requestId: rollRequest.id, rollRequest: request, validation: normalized.validation}})};
  const roll = rollResultToResolverRoll(normalized.result);
  return {roll, rollRequest: request,
    rollResult: {requestId: accepted.request.id, type: `${rollKind}-roll`, semanticType: normalized.result.type, rollRequest: request,
      rollResult: normalized.result, roll, reroll: true, targetKey: key},
    payment: {type: "resourcePayment", resolver: "ResourceResolver", plan: option.plan, payerRef: option.payerRef}};
}

/** A resolved stage's state with its Heroic Inspiration rerolls' rolls recorded (only once the stage continues). */
function withRerolls(state, rerolls) {
  if ( !rerolls.length ) return state;
  return updateResolutionState(state, {
    rollRequests: rerolls.reduce((requests, reroll) => appendRollRequest(requests, reroll.rollRequest), state.rollRequests),
    rollResults: [...state.rollResults, ...rerolls.map(reroll => reroll.rollResult)]
  });
}

/** Whose roll a save is: by Token first, since unlinked Tokens of one Actor (a pack of goblins) share its id. */
function saveTargetKey(target) {
  return String(target?.tokenId ?? target?.target?.tokenId ?? target?.id ?? target?.actorRef ?? target?.uuid ?? "");
}

/** Hand each target the save it rolled itself (per-target fan-out); others keep the shared roll. */
function withTargetSaveRolls(entries, rollsByTarget) {
  if ( !rollsByTarget ) return entries;
  return normalizeArray(entries).map(entry => {
    const roll = rollsByTarget[saveTargetKey(entry?.target ?? entry)];
    return roll ? {...entry, roll} : entry;
  });
}

function createSaveOutcomeStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.SAVE_OUTCOME,
    run(state) {
      let input = preparedResolverInput(state);
      if ( !shouldResolveSave(input.save) ) return continueResolutionStage({
        state: updateResolutionState(state, {input})
      });
      const planning = ensureActionPlanningResult(state, input);
      if ( planning.failed ) return planning.failed;
      const {actionContext} = planning;
      let {actionResult} = planning;

      // Evasion (`save.evasionByTarget`) rides along as an override the damage step reads.
      const contextsFor = rollsByTarget => withOutcomeOverrides(withOutcomeOverrides(withTargetSaveRolls(input.save.targetContexts
        ?? state.results?.targetResolution?.targetContexts ?? [], rollsByTarget), input.save.outcomesByTarget),
        input.save.evasionByTarget);
      let targetContexts = contextsFor(input.save.rollsByTarget);
      const resolveSaves = contexts => resolveSaveTargets({
        roll: input.save.roll,
        targetContexts: contexts,
        targets: withTargetSaveRolls(input.save.targets ?? (state.results?.targetResolution ? [] : actionContext.targets),
          input.save.rollsByTarget),
        dc: input.save.dc ?? null,
        dcKey: input.save.dcKey ?? "save",
        saveKey: input.save.saveKey ?? input.save.ability ?? null,
        policy: {...(input.policies?.save ?? {}), ...(input.save.policy ?? {})},
        context: {
          action: actionContext.action,
          source: actionContext.source,
          ...(input.save.context ?? {})
        }
      });
      let saveResolution = resolveSaves(targetContexts);
      // Heroic Inspiration: a player character's failed save, or a monster's save by the GM's choice, may be rerolled
      // (before Legendary Resistance, which a rerolled failure can still use).
      const rerolls = [];
      for ( const result of saveResolution.ok ? [...saveResolution.failures, ...saveResolution.successes] : [] ) {
        const target = result.targetContext?.target ?? result.target;
        const key = rollModeTargetKey(result.target);
        const reroll = inspirationReroll(state, input, {offer: input.save.inspirationByTarget?.[key], failed: !result.success, key,
          roll: result.roll ?? input.save.rollsByTarget?.[saveTargetKey(target)] ?? null,
          stageId: ACTION_PIPELINE_STAGE_IDS.SAVE_OUTCOME, rollKind: "save", targets: [target],
          makeRollRequest: (suffix, bonus=0) => saveRollRequestForState(state, input, {target, suffix, bonus})});
        if ( reroll.wait || reroll.fail ) return reroll.wait ?? reroll.fail;
        if ( reroll.roll ) rerolls.push({...reroll, rollKey: saveTargetKey(target)});
      }
      if ( rerolls.length ) {
        input = {...input, save: {...input.save, rollsByTarget: {...(input.save.rollsByTarget ?? {}),
          ...Object.fromEntries(rerolls.map(reroll => [reroll.rollKey, reroll.roll]))}}};
        targetContexts = contextsFor(input.save.rollsByTarget);
        saveResolution = resolveSaves(targetContexts);
      }
      // Legendary Resistance: a target that fails may succeed instead, spending a use of its own pool.
      const legendary = saveResolution.ok ? legendaryResistanceChoices(state, input, saveResolution) : {chosen: []};
      if ( legendary.wait ) return legendary.wait;
      if ( legendary.chosen.length ) {
        saveResolution = resolveSaves(withOutcomeOverrides(targetContexts,
          Object.fromEntries(legendary.chosen.map(key => [key, "succeed-instead"]))));
      }
      if ( !saveResolution.ok ) {
        return failActionPlanningStage({
          state,
          input,
          actionResult,
          stage: ACTION_RESOLUTION_STAGES.ROLL,
          code: ACTION_RESOLVER_CODES.SAVE_FAILED,
          reason: saveResolution.code,
          data: {saveResolution}
        });
      }

      actionResult = addResolutionStep(actionResult, {
        stage: ACTION_RESOLUTION_STAGES.ROLL,
        events: saveEvents(actionContext, saveResolution),
        consequences: [{
          type: "saveResolved",
          saveResolution
        }],
        // Each use is paid by the creature that succeeded instead, in the Action's transaction; so is each reroll's point.
        mutationPlans: [...legendary.chosen.map(key => ({type: "resourcePayment", resolver: "ResourceResolver",
          plan: input.save.legendaryByTarget[key].plan, payerRef: input.save.legendaryByTarget[key].payerRef})),
          ...rerolls.map(reroll => reroll.payment).filter(Boolean)],
        data: {saveResolution}
      });

      // Counterspell: a failed save cancels the Action whose declaration it reacted to.
      const countered = (state.actionDefinition?.counters === true) && (saveResolution.failures.length > 0);
      return continueResolutionStage({
        state: withRerolls(stateWithActionResult(state, {
          input,
          actionResult,
          results: {saveResolution, ...(countered ? {parentDirective: {type: "cancel-parent", code: "COUNTERED",
            reason: `${state.actionDefinition.label ?? "A reaction"} stopped it.`}} : {})}
        }), rerolls),
        data: {
          successCount: saveResolution.successes.length,
          failureCount: saveResolution.failures.length
        }
      });
    }
  });
}

function createDamageRollStage() {
  return createComponentRollStage({id: ACTION_PIPELINE_STAGE_IDS.DAMAGE_ROLL, kind: "damage", rollType: ROLL_TYPES.DAMAGE,
    request: "damage-roll"});
}

function createHealingRollStage() {
  return createComponentRollStage({id: ACTION_PIPELINE_STAGE_IDS.HEALING_ROLL, kind: "healing", rollType: ROLL_TYPES.HEALING,
    request: "healing-roll"});
}

/**
 * Rolls each damage or healing component that has no amount yet, one request per component, so each damage type is
 * its own roll (a physical total can be typed per type, and resistance lands on the right part). A component's flat
 * part ("1d8 + 3") rolls with it. Damage also: a critical hit doubles each component's dice, the creature's damage
 * modifier (`damage.modifierTotal`: ability modifier and bonuses) is added once, to the first weapon component or
 * else the first component, and nothing rolls when every attack missed.
 */
function createComponentRollStage({id, kind, rollType, request}) {
  return createResolutionPipelineStage({
    id,
    run(state) {
      const input = preparedResolverInput(state);
      const resolves = kind === "damage" ? shouldResolveDamage(input.damage) : shouldResolveHealing(input.healing);
      if ( !resolves || ((kind === "damage") && attackResolvedAsOnlyMisses(state)) ) {
        return continueResolutionStage({state: updateResolutionState(state, {input})});
      }
      let values = kind === "damage" ? withFixedModifier(input.damage) : input[kind];
      let current = state;
      for ( ;; ) {
        const components = values?.components ?? [];
        const index = components.findIndex(component => component?.amount == null);
        if ( index < 0 ) return continueResolutionStage({state: updateResolutionState(current, {input: {...input, [kind]: values}})});
        const requestId = requestIdFor(current, index ? `${request}:${index}` : request);
        const build = () => componentRollRequestForState(current, input, {kind, rollType, requestId, index, values});
        const accepted = getResolutionResponse(current, {requestId, type: RESOLUTION_REQUEST_TYPES.ROLL});
        if ( !accepted ) {
          const rollRequest = build();
          return waitResolutionStage({
            state: updateResolutionState(current, {input: {...input, [kind]: values},
              rollRequests: appendRollRequest(current.rollRequests, rollRequest)}),
            request: createResolutionRequest({
              id: rollRequest.id,
              resolutionId: current.id,
              stageId: id,
              type: RESOLUTION_REQUEST_TYPES.ROLL,
              expectedResponseType: "roll-result",
              chooser: rollRequest.chooser,
              authority: rollRequest.authority,
              validation: {rollRequestId: rollRequest.id, semanticType: rollRequest.type,
                formula: rollFormulaForRequest(rollRequest).formula ?? null},
              payload: {actionDefinitionId: current.actionDefinition?.id ?? null, rollKind: kind, rollRequest,
                [kind]: values, targets: input.targets ?? []}
            }),
            reason: `A ${kind} roll result is required before action resolution can continue.`
          });
        }
        const rollRequest = rollRequestFromAcceptedResponse(accepted, build);
        const normalized = normalizeRollResponseValue(accepted.response.value, {request: rollRequest,
          completedRequestIds: completedRollRequestIds(current)});
        if ( !normalized.ok ) return failResolutionStage({state: current, code: normalized.code, reason: normalized.reason,
          errors: [{code: normalized.code, reason: normalized.reason, requestId, validation: normalized.validation}],
          data: {requestId, rollRequest, validation: normalized.validation}});
        const [rolled] = rollResultToDamageComponents({result: normalized.result, components: [components[index]]});
        // The damage modifier rolled with this component's dice; it must not be added again to its amount.
        const modifierRolled = (kind === "damage") && (index === modifierComponentIndex(values));
        values = {...values, components: components.map((component, i) => (i === index ? rolled : component)),
          ...(modifierRolled ? {modifierApplied: true} : {})};
        current = updateResolutionState(current, {
          rollRequests: appendRollRequest(current.rollRequests, rollRequest),
          rollResults: [...current.rollResults, {requestId: accepted.request.id, type: `${kind}-roll`,
            semanticType: normalized.result.type, rollRequest, rollResult: normalized.result, roll: {total: normalized.result.total}}]
        });
      }
    }
  });
}

function createDamageStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.DAMAGE,
    run(state, services={}) {
      const input = {
        ...preparedResolverInput(state),
        durability: preparePlanningDurabilityOptions(state.input?.durability, services.targetActors, services.snapshotActor,
          services.damageProfileOf)
      };
      if ( !shouldResolveDamage(input.damage) ) return continueResolutionStage({
        state: updateResolutionState(state, {input})
      });
      const planning = ensureActionPlanningResult(state, input);
      if ( planning.failed ) return planning.failed;
      const {actionContext} = planning;
      let {actionResult} = planning;

      const damageResolution = resolveActionDamage({
        damage: input.damage,
        targetResolution: state.results?.targetResolution ?? null,
        attackResolution: state.results?.attackResolution ?? null,
        saveResolution: state.results?.saveResolution ?? null,
        actionContext
      });
      if ( !damageResolution.ok ) {
        return failActionPlanningStage({
          state,
          input,
          actionResult,
          stage: ACTION_RESOLUTION_STAGES.CONSEQUENCE,
          code: ACTION_RESOLVER_CODES.DAMAGE_FAILED,
          reason: damageResolution.code,
          data: {damageResolution}
        });
      }

      const durabilityResolution = resolveDamageDurability({
        damage: input.damage,
        durability: input.durability,
        damageResolution,
        actionContext
      });
      if ( durabilityResolution && !durabilityResolution.ok ) {
        return failActionPlanningStage({
          state,
          input,
          actionResult,
          stage: ACTION_RESOLUTION_STAGES.CONSEQUENCE,
          code: ACTION_RESOLVER_CODES.DAMAGE_FAILED,
          reason: durabilityResolution.code,
          data: {damageResolution, durabilityResolution}
        });
      }

      actionResult = addResolutionStep(actionResult, {
        stage: ACTION_RESOLUTION_STAGES.CONSEQUENCE,
        consequences: [{
          type: "damageResolved",
          damageResolution,
          ...(durabilityResolution ? {durabilityResolution} : {})
        }],
        mutationPlans: [...(durabilityResolution?.mutationPlans ?? []), ...onceUsePlans(input.damage, damageResolution)],
        data: {
          damageResolution,
          ...(durabilityResolution ? {durabilityResolution} : {})
        }
      });

      return continueResolutionStage({
        state: stateWithActionResult(state, {
          input,
          actionResult,
          results: {damageResolution, ...(durabilityResolution ? {damageDurabilityResolution: durabilityResolution} : {})}
        }),
        data: {
          resultCount: damageResolution.results.length,
          mutationPlanCount: durabilityResolution?.mutationPlans?.length ?? 0
        }
      });
    }
  });
}

function createHealingStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.HEALING,
    run(state, services={}) {
      const input = {
        ...preparedResolverInput(state),
        durability: preparePlanningDurabilityOptions(state.input?.durability, services.targetActors, services.snapshotActor,
          services.damageProfileOf)
      };
      if ( !shouldResolveHealing(input.healing) ) return continueResolutionStage({
        state: updateResolutionState(state, {input})
      });
      const planning = ensureActionPlanningResult(state, input);
      if ( planning.failed ) return planning.failed;
      const {actionContext} = planning;
      let {actionResult} = planning;

      const healingResolution = resolveActionHealing({
        healing: input.healing,
        targetResolution: state.results?.targetResolution ?? null,
        actionContext
      });
      if ( !healingResolution.ok ) {
        return failActionPlanningStage({
          state,
          input,
          actionResult,
          stage: ACTION_RESOLUTION_STAGES.CONSEQUENCE,
          code: ACTION_RESOLVER_CODES.HEALING_FAILED,
          reason: healingResolution.code,
          data: {healingResolution}
        });
      }

      const durabilityResolution = resolveHealingDurability({
        healing: input.healing,
        durability: input.durability,
        healingResolution,
        actionContext
      });
      if ( durabilityResolution && !durabilityResolution.ok ) {
        return failActionPlanningStage({
          state,
          input,
          actionResult,
          stage: ACTION_RESOLUTION_STAGES.CONSEQUENCE,
          code: ACTION_RESOLVER_CODES.HEALING_FAILED,
          reason: durabilityResolution.code,
          data: {healingResolution, durabilityResolution}
        });
      }

      actionResult = addResolutionStep(actionResult, {
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

      return continueResolutionStage({
        state: stateWithActionResult(state, {
          input,
          actionResult,
          results: {healingResolution, ...(durabilityResolution ? {healingDurabilityResolution: durabilityResolution} : {})}
        }),
        data: {
          resultCount: healingResolution.results.length,
          mutationPlanCount: durabilityResolution?.mutationPlans?.length ?? 0
        }
      });
    }
  });
}

/**
 * Effects whose save is repeated (Hold Person) carry the save they repeat: its ability and the DC it resolved to, so the
 * creature rolls the same save at the end of each of its turns (foundry-v14-automation-dispatcher.mts).
 */
function withRepeatSaves(effects, save, saveResolution) {
  const ability = save?.ability ?? save?.saveKey ?? null;
  const dc = finiteNumber(save?.dc?.value ?? saveResolution?.results?.[0]?.dc?.value);
  if ( !effects?.conditions?.some(entry => entry?.metadata?.repeatSave) || !ability || (dc == null) ) return effects;
  return {...effects, conditions: effects.conditions.map(entry => (entry?.metadata?.repeatSave
    ? {...entry, metadata: {...entry.metadata, repeatSave: {...entry.metadata.repeatSave, ability, dc}}} : entry))};
}

/**
 * A spell's effects carry the level it was cast at (`metadata.spellLevel`), for what ends spells by level (Dispel
 * Magic): its slot's, else the spell's own.
 */
function withSpellLevel(effects, state) {
  const definition = state.actionDefinition ?? {};
  if ( !effects?.conditions?.length || !(definition.tags ?? []).includes("spell") ) return effects;
  const level = finiteNumber(state.configuration?.castingLevel ?? state.configuration?.metadata?.castingLevel ?? definition.metadata?.spellLevel);
  if ( level == null ) return effects;
  return {...effects, conditions: effects.conditions.map(entry => ({...entry, metadata: {...(entry?.metadata ?? {}), spellLevel: level}}))};
}

function createEffectStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.EFFECTS,
    run(state) {
      const input = preparedResolverInput(state);
      if ( !shouldResolveEffects(input.effects) ) return continueResolutionStage({
        state: updateResolutionState(state, {input})
      });
      const planning = ensureActionPlanningResult(state, input);
      if ( planning.failed ) return planning.failed;
      const {actionContext} = planning;
      let {actionResult} = planning;

      const effectResolution = resolveActionEffects({
        effects: withSpellLevel(withRepeatSaves(input.effects, input.save, state.results?.saveResolution ?? null), state),
        targetResolution: state.results?.targetResolution ?? null,
        attackResolution: state.results?.attackResolution ?? null,
        saveResolution: state.results?.saveResolution ?? null,
        actionContext
      });
      if ( !effectResolution.ok ) {
        return failActionPlanningStage({
          state,
          input,
          actionResult,
          stage: ACTION_RESOLUTION_STAGES.EFFECTS,
          code: ACTION_RESOLVER_CODES.EFFECTS_FAILED,
          reason: effectResolution.code,
          data: {effectResolution}
        });
      }

      actionResult = addResolutionStep(actionResult, {
        stage: ACTION_RESOLUTION_STAGES.EFFECTS,
        consequences: [{
          type: "effectsResolved",
          effectResolution
        }],
        mutationPlans: effectResolution.mutationPlans,
        data: {effectResolution}
      });

      return continueResolutionStage({
        state: stateWithActionResult(state, {
          input,
          actionResult,
          results: {effectResolution}
        }),
        data: {
          mutationPlanCount: effectResolution.mutationPlans.length
        }
      });
    }
  });
}

/**
 * A damaged creature that is concentrating checks to keep it (DC from the damage taken; ConcentrationResolver).
 * Each check is a save rolled by that creature's controller, one after another; a failed check ends every
 * effect that depends on that concentration in the same transaction as the damage. `input.concentration`
 * comes from the runtime: `{states, dependents: [{target, effects}], policy}`.
 */
function createConcentrationStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.CONCENTRATION,
    run(state) {
      const input = preparedResolverInput(state);
      const concentration = input.concentration;
      if ( !concentration?.states || !state.results?.damageResolution ) return continueResolutionStage({state});
      const planningChecks = planConcentrationChecks({
        damageResolution: state.results.damageResolution,
        durabilityResolution: state.results.damageDurabilityResolution ?? null,
        concentrationStates: concentration.states,
        policy: concentration.policy ?? {}
      });
      if ( !planningChecks.checkRequests.length ) return continueResolutionStage({state});

      let current = state;
      const rolled = {...(concentration.rolled ?? {})};
      for ( const [index, check] of planningChecks.checkRequests.entries() ) {
        if ( rolled[check.id] ) continue;
        const requestId = requestIdFor(current, `concentration:${index + 1}`);
        const accepted = getResolutionResponse(current, {requestId, type: RESOLUTION_REQUEST_TYPES.ROLL});
        const rollRequest = accepted?.request?.payload?.rollRequest ?? concentrationRollRequest(current, check, requestId);
        if ( !accepted ) return waitResolutionStage({
          state: updateResolutionState(current, {
            input: {...input, concentration: {...concentration, rolled}},
            rollRequests: appendRollRequest(current.rollRequests, rollRequest)
          }),
          request: createResolutionRequest({
            id: rollRequest.id,
            resolutionId: current.id,
            stageId: ACTION_PIPELINE_STAGE_IDS.CONCENTRATION,
            type: RESOLUTION_REQUEST_TYPES.ROLL,
            expectedResponseType: "roll-result",
            chooser: rollRequest.chooser,
            authority: rollRequest.authority,
            validation: {rollRequestId: rollRequest.id, semanticType: rollRequest.type,
              requireNatural: rollRequest.expected.requireNatural, formula: rollFormulaForRequest(rollRequest).formula ?? null},
            payload: {actionDefinitionId: current.actionDefinition?.id ?? null, rollKind: "concentration", rollRequest,
              targets: [check.target]}
          }),
          reason: "A concentration check is required before action resolution can continue."
        });
        const normalized = normalizeRollResponseValue(accepted.response.value, {
          request: rollRequest,
          completedRequestIds: completedRollRequestIds(current)
        });
        if ( !normalized.ok ) return failResolutionStage({
          state: current,
          code: normalized.code,
          reason: normalized.reason,
          errors: [{code: normalized.code, reason: normalized.reason, requestId, validation: normalized.validation}],
          data: {requestId, rollRequest, validation: normalized.validation}
        });
        rolled[check.id] = {total: normalized.result.total, natural: normalized.result.natural};
        current = updateResolutionState(current, {
          rollRequests: appendRollRequest(current.rollRequests, rollRequest),
          rollResults: [...current.rollResults, {requestId: accepted.request.id, type: "concentration-roll",
            semanticType: normalized.result.type, rollRequest, rollResult: normalized.result,
            roll: rollResultToResolverRoll(normalized.result), targetKey: check.targetRef}]
        });
      }

      const checks = resolveConcentrationCheckResults({
        checkRequests: planningChecks.checkRequests,
        results: planningChecks.checkRequests.map(check => ({requestId: check.id, ...rolled[check.id]}))
      });
      const lifecycle = normalizeArray(concentration.dependents).map(dependent => planEffectLifecycle({
        target: dependent.target,
        effects: dependent.effects,
        events: checks.breakEvents
      }));
      const mutationPlans = lifecycle.flatMap(entry => entry.mutationPlans ?? []);
      const planning = ensureActionPlanningResult(current, input);
      if ( planning.failed ) return planning.failed;
      const actionResult = addResolutionStep(planning.actionResult, {
        stage: ACTION_RESOLUTION_STAGES.EFFECTS,
        consequences: [{type: "concentrationResolved", checks}],
        mutationPlans,
        data: {concentration: checks}
      });
      return continueResolutionStage({
        state: stateWithActionResult(current, {
          input: {...input, concentration: {...concentration, rolled}},
          actionResult,
          results: {concentrationResolution: {checks, endedEffects: mutationPlans.length}}
        }),
        data: {checkCount: planningChecks.checkRequests.length, endedEffects: mutationPlans.length}
      });
    }
  });
}

function concentrationRollRequest(state, check, requestId) {
  // The DC stays on the authority (the chooser projection never sends it); the roller sees a plain save.
  const bonus = Number.isFinite(check.saveBonus) ? check.saveBonus : null;
  return createD20RollRequest({
    id: requestId,
    resolutionId: state.id,
    type: ROLL_TYPES.SAVING_THROW,
    modifier: bonus ?? 0,
    modifiers: bonus == null ? [] : [{id: "save-modifier", value: bonus}],
    ...(check.rollMode ? {rollMode: check.rollMode} : {}),
    source: check.target,
    target: state.source ?? null,
    chooser: ROLL_AUTHORITY.TARGET_CONTROLLER,
    authority: {kind: ROLL_AUTHORITY.TARGET_CONTROLLER},
    expected: {validateTotalFromNatural: bonus != null, modifierTotal: bonus},
    metadata: {actionDefinitionId: state.actionDefinition?.id ?? null, rollKind: "concentration", ability: check.ability}
  });
}

function createPaymentStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.PAYMENT,
    run(state) {
      const input = preparedResolverInput(state);
      const planning = ensureActionPlanningResult(state, input);
      if ( planning.failed ) return planning.failed;
      const {actionContext} = planning;
      let {actionResult} = planning;

      const payment = resolveActorResourcePayment({
        actorSystem: input.actorSystem,
        cost: actionActivationCost(input.action, state.actionDefinition),
        action: actionContext.action,
        policies: actionContext.policies,
        selectedPaymentOptionId: input.selectedPaymentOptionId ?? null,
        selectedPaymentPlan: state.configuration?.selectedPaymentPlan ?? input.configuration?.selectedPaymentPlan ?? null
      });
      if ( !payment.ok ) {
        return failActionPlanningStage({
          state,
          input,
          actionResult,
          stage: ACTION_RESOLUTION_STAGES.RESOURCE_PAYMENT,
          code: ACTION_RESOLVER_CODES.PAYMENT_UNAVAILABLE,
          reason: payment.code,
          data: {payment}
        });
      }

      // A companion's Action may also cost the controller commanding it; that payment commits with the rest.
      const controllerCost = actionDefinitionActivationCost({costs: state.actionDefinition?.controllerCosts});
      let controllerPayment = null;
      if ( controllerCost.allOf?.length || controllerCost.anyOf?.length ) {
        controllerPayment = input.controller?.actorSystem ? resolveActorResourcePayment({
          actorSystem: input.controller.actorSystem,
          cost: controllerCost,
          action: actionContext.action,
          policies: actionContext.policies
        }) : {ok: false, code: "CONTROLLER_REQUIRED"};
        if ( !controllerPayment.ok ) {
          return failActionPlanningStage({
            state,
            input,
            actionResult,
            stage: ACTION_RESOLUTION_STAGES.RESOURCE_PAYMENT,
            code: ACTION_RESOLVER_CODES.PAYMENT_UNAVAILABLE,
            reason: controllerPayment.code,
            data: {payment: controllerPayment, payer: "controller"}
          });
        }
      }

      // The pools the Action refills (Multiattack) join its payment.
      payment.mutationPlan = withResourceRestores(input.actorSystem, payment.mutationPlan, state.actionDefinition?.restores ?? []);

      const paymentRequiredEvent = createActionLifecycleEvent(actionContext, {
        type: AUTOMATION_EVENT_TYPES.PAYMENT_REQUIRED,
        phase: AUTOMATION_EVENT_PHASES.BEFORE,
        data: {
          paymentPlan: payment.paymentPlan,
          mutationPlan: payment.mutationPlan
        }
      });
      actionResult = addResolutionStep(actionResult, {
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
        }, ...(controllerPayment ? [{
          type: "resourcePayment",
          resolver: "ResourceResolver",
          plan: controllerPayment.mutationPlan,
          payerRef: input.controller.actorRef
        }] : [])],
        data: {
          paymentPlan: payment.paymentPlan,
          discovery: payment.discovery,
          ...(controllerPayment ? {controllerPaymentPlan: controllerPayment.paymentPlan} : {})
        }
      });

      return continueResolutionStage({
        state: stateWithActionResult(state, {
          input,
          actionResult,
          results: {paymentResolution: payment}
        }),
        data: {
          paymentPlan: payment.paymentPlan,
          mutationPlanCount: actionResult.mutationPlans.length
        }
      });
    }
  });
}

function createReadyToCommitStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.READY_TO_COMMIT,
    run(state) {
      return completeResolutionStage({
        state,
        status: RESOLUTION_STATE_STATUS.READY_TO_COMMIT,
        code: ACTION_PIPELINE_CODES.OK,
        data: {
          mutationPlanCount: state.mutationPlans.length,
          eventCount: state.events.length
        }
      });
    }
  });
}

/* -------------------------------------------- */

function ensureActionPlanningResult(state, input=preparedResolverInput(state)) {
  const existing = state.results?.actionResult;
  if ( existing?.context ) return {
    actionContext: existing.context,
    actionResult: existing
  };

  const definitionValidation = state.validation?.find(entry => entry?.type === "action-definition") ?? null;
  const actionContext = createActionContext({
    ...(input.context ?? {}),
    action: actionRef(input.action, state.actionDefinition, definitionValidation),
    source: input.source ?? state.source,
    targets: (input.targets?.length ? input.targets : input.context?.targets ?? []),
    policies: {...(input.context?.policies ?? {}), ...(input.policies ?? {})}
  });
  const actionResult = beginActionResult(actionContext);
  if ( actionResult.status === ACTION_RESULT_STATUS.FAILED ) {
    return {
      failed: failResolutionStage({
        state: stateWithActionResult(state, {input, actionResult}),
        code: actionResult.code,
        reason: actionResult.errors[0]?.reason ?? actionResult.code,
        errors: actionResult.errors,
        data: {actionResult}
      })
    };
  }
  return {actionContext, actionResult};
}

function stateWithActionResult(state, {
  input=state.input,
  actionResult,
  results={},
  targets=null,
  targetSet=null,
  targetRefinement=null
}={}) {
  return updateResolutionState(state, {
    input,
    actionContext: actionResult.context,
    targets: targets ?? state.targets,
    targetSet: targetSet ?? state.targetSet,
    targetRefinement: targetRefinement ?? state.targetRefinement,
    mutationPlans: actionResult.mutationPlans,
    events: actionResult.events,
    results: {
      ...state.results,
      ...results,
      actionResult
    }
  });
}

function failActionPlanningStage({
  state,
  input=state.input,
  actionResult=null,
  stage=null,
  code=ACTION_PIPELINE_CODES.ACTION_PLANNING_FAILED,
  reason=null,
  errors=[],
  data={}
}={}) {
  let result = actionResult;
  if ( !result ) {
    const planning = ensureActionPlanningResult(state, input);
    if ( planning.failed ) return planning.failed;
    result = planning.actionResult;
  }

  const failedResult = failActionResult(result, {
    stage,
    code,
    reason,
    errors,
    data
  });
  return failResolutionStage({
    state: stateWithActionResult(state, {input, actionResult: failedResult}),
    code,
    reason,
    errors: failedResult.errors,
    data: {
      ...data,
      actionResult: failedResult
    }
  });
}

function invalidActionDefinitionValidation(state) {
  const validation = state.validation?.find(entry => entry?.type === "action-definition") ?? null;
  return validation && validation.ok === false ? validation : null;
}

function rangeDefinitionFromInput(input) {
  return input.context?.rangeDefinition
    ?? input.range
    ?? input.targeting?.range
    ?? input.attack?.range
    ?? input.action?.system?.definition?.range
    ?? null;
}

function sourceFootprintFromInput(input) {
  const spatial = spatialInput(input);
  return spatial?.sourceFootprint
    ?? spatial?.source?.footprint
    ?? input.source?.footprint
    ?? input.source?.tokenFootprint
    ?? null;
}

function targetFootprintForContext(input, targetContext) {
  const target = targetContext?.target ?? targetContext;
  const refs = targetLookupRefs(target);
  for ( const entry of targetFootprintEntries(input) ) {
    const footprint = entry?.footprint ?? (entry?.type === "TokenGridFootprint" || entry?.fields ? entry : null);
    if ( !footprint ) continue;
    const entryRefs = targetLookupRefs(entry?.target ?? entry);
    if ( refs.some(ref => entryRefs.includes(ref)) || entry?.id === targetContext?.id || entry?.id === target?.id ) {
      return footprint;
    }
  }
  const occupiedFields = targetContext?.occupiedFields ?? target?.occupiedFields ?? null;
  const sourceFootprint = sourceFootprintFromInput(input);
  if ( occupiedFields?.length && sourceFootprint?.topology ) {
    return {
      type: "GridFootprint",
      topology: sourceFootprint.topology,
      fields: occupiedFields
    };
  }
  return null;
}

function targetFootprintEntries(input) {
  const spatial = spatialInput(input);
  return [
    ...normalizeArray(spatial?.targetFootprints),
    ...normalizeArray(spatial?.tokenFootprints),
    ...normalizeArray(spatial?.targets),
    ...normalizeArray(input.targeting?.candidates),
    ...normalizeArray(input.targeting?.targetSet?.candidates),
    ...normalizeArray(input.targets)
  ];
}

function spatialInput(input) {
  return input.spatial
    ?? input.context?.spatial
    ?? input.context?.tactical
    ?? null;
}

function spatialSummary(input) {
  const spatial = spatialInput(input);
  return {
    hasSourceFootprint: !!sourceFootprintFromInput(input),
    targetFootprintCount: targetFootprintEntries(input).filter(entry => entry?.footprint || entry?.fields).length,
    gridDistance: gridDistanceFromInput(input),
    metadata: clonePlain(spatial?.metadata ?? {})
  };
}

function gridDistanceFromInput(input) {
  const spatial = spatialInput(input);
  return finiteNumber(spatial?.gridDistance)
    ?? finiteNumber(spatial?.sceneContext?.grid?.distance)
    ?? finiteNumber(input.context?.sceneContext?.grid?.distance)
    ?? finiteNumber(input.context?.rangeDefinition?.distance?.gridDistance)
    ?? null;
}

function rangeBandForDistance(range, distance) {
  const type = range?.type ?? "special";
  if ( type === "self" ) {
    return distance <= 0
      ? {ok: true, code: ACTION_PIPELINE_CODES.OK, band: "self"}
      : {ok: false, code: ACTION_PIPELINE_CODES.TARGET_OUT_OF_RANGE, band: null};
  }

  if ( type === "touch" || type === "reach" ) {
    const maxDistance = distanceValue(range.distance ?? range.normal) ?? 5;
    return distance <= maxDistance
      ? {ok: true, code: ACTION_PIPELINE_CODES.OK, band: type}
      : {ok: false, code: ACTION_PIPELINE_CODES.TARGET_OUT_OF_RANGE, band: null};
  }

  if ( type === "ranged" ) {
    const normal = distanceValue(range.normal ?? range.distance);
    const long = distanceValue(range.long) ?? normal;
    if ( normal != null && distance <= normal ) return {ok: true, code: ACTION_PIPELINE_CODES.OK, band: "normal"};
    if ( long != null && distance <= long ) return {ok: true, code: ACTION_PIPELINE_CODES.OK, band: "long"};
    return {ok: false, code: ACTION_PIPELINE_CODES.TARGET_OUT_OF_RANGE, band: null};
  }

  const maxDistance = distanceValue(range.distance ?? range.normal ?? range.long);
  if ( maxDistance == null ) return {ok: true, code: ACTION_PIPELINE_CODES.OK, band: type};
  return distance <= maxDistance
    ? {ok: true, code: ACTION_PIPELINE_CODES.OK, band: type}
    : {ok: false, code: ACTION_PIPELINE_CODES.TARGET_OUT_OF_RANGE, band: null};
}

function distanceValue(distance) {
  if ( distance == null ) return null;
  if ( typeof distance === "number" ) return finiteNumber(distance);
  return finiteNumber(distance.value ?? distance.amount ?? distance.distance);
}

function damageComponentsHaveAmounts(components=[]) {
  const entries = normalizeArray(components);
  return !entries.length || entries.every(component => component?.amount != null);
}

function attackResolvedAsOnlyMisses(state) {
  const attackResolution = state.results?.attackResolution;
  return !!attackResolution && !attackResolution.hits?.length && !!attackResolution.misses?.length;
}

function componentRollRequestForState(state, input, {kind, rollType, requestId, index, values}) {
  const component = values.components[index];
  // 2024: a critical hit rolls the attack's damage dice twice (flat modifiers once).
  // A reaction's damage added to its creature's own critical hit (2014 Divine Smite) is marked `damage.critical`.
  const critical = (kind === "damage") && ((state.results?.attackResolution?.hits ?? []).some(hit => hit.outcome === "criticalHit")
    || (input.damage?.critical === true));
  const rolled = !critical ? component : {...component,
    ...(component.dice ? {dice: {...component.dice, number: (Number(component.dice.number) || 1) * 2}} : {}),
    ...(component.expression ? {expression: withDoubledDice(component.expression)} : {})};
  const modifier = (Number(component.bonus) || 0)
    + (((kind === "damage") && (index === modifierComponentIndex(values)) && Number.isFinite(values.modifierTotal)
      && !values.modifierApplied) ? values.modifierTotal : 0);
  return createDamageRollRequest({
    id: requestId,
    resolutionId: state.id,
    type: rollType,
    components: [rolled],
    formula: (values.components.length === 1) ? (values.formula ?? values.rollFormula ?? null) : null,
    definition: {modifierTotal: modifier},
    visibility: values.visibility ?? input.context?.messageMode,
    source: state.source ?? input.source ?? null,
    target: firstRollTarget(input),
    chooser: values.chooser ?? ROLL_AUTHORITY.SOURCE_CONTROLLER,
    authority: values.authority ?? {kind: ROLL_AUTHORITY.SOURCE_CONTROLLER},
    metadata: {actionDefinitionId: state.actionDefinition?.id ?? null, rollKind: kind, componentId: component.id ?? null}
  });
}

/**
 * Damage dealt with a once-per-turn extra (Sneak Attack-like) records its use on the source for this turn, in the
 * same transaction. A miss deals none, so it records nothing.
 */
function onceUsePlans(damage, damageResolution) {
  if ( !(damageResolution?.results ?? []).some(result => (Number(result.total) || 0) > 0) ) return [];
  return (damage?.extraComponents ?? []).filter(component => component.once?.key && component.once?.turn).map(component => {
    const path = `flags.wildpath.onceUsed.${component.once.key}`;
    return {type: "sourceUpdate", resolver: "ActionPipeline", updates: {[path]: component.once.turn}, rollbackUpdates: {[path]: null}};
  });
}

/** The component the creature's damage modifier goes on: the first weapon component, else the first one. */
function modifierComponentIndex(damage) {
  return Math.max((damage?.components ?? []).findIndex(component => component?.provenance === "weapon-base"), 0);
}

/** Fixed damage (no dice, e.g. an Unarmed Strike's 1) adds the damage modifier to that component's amount, once. */
function withFixedModifier(damage) {
  const bonus = damage?.modifierTotal;
  const index = modifierComponentIndex(damage);
  const component = damage?.components?.[index];
  if ( !Number.isFinite(bonus) || !bonus || (component?.amount == null) || damage.modifierApplied ) return damage;
  const components = damage.components.map((entry, i) => (i === index ? {...entry, amount: Math.max((Number(entry.amount) || 0) + bonus, 0)} : entry));
  return {...damage, components, modifierApplied: true};
}

/** A ValueExpression with every dice term's count doubled, wherever it is nested. */
function withDoubledDice(expression) {
  if ( !expression || (typeof expression !== "object") ) return expression;
  if ( Array.isArray(expression) ) return expression.map(withDoubledDice);
  const doubled = Object.fromEntries(Object.entries(expression).map(([key, value]) => [key, withDoubledDice(value)]));
  return expression.type === "dice" ? {...doubled, number: (Number(expression.number) || 1) * 2} : doubled;
}

/* -------------------------------------------- */

function preparePlanningDurabilityOptions(durability, targetActors, snapshotActor=null, damageProfileOf=null) {
  if ( !durability || !targetActors ) return durability;
  const options = durability === true ? {} : {...durability};
  // Its targets as they are now, not as declared (`snapshotActor`, the runtime's): while it waited on a prompt or a
  // reaction, another Action may have hurt or healed them, and planning on the old health would undo that. Their
  // resistances too (`damageProfileOf`): Uncanny Dodge's, taken as a reaction to this very attack.
  if ( options.targetSystems && (typeof snapshotActor === "function") && targetActors && (typeof targetActors === "object")
    && !(targetActors instanceof Map) && !Array.isArray(targetActors) ) {
    const fresh = new Map();
    const profiles = {...(options.adjustmentProfiles ?? {})};
    const targetSystems = Object.fromEntries(Object.entries(options.targetSystems).map(([key, system]) => {
      const actor = targetActors[key];
      if ( !actor ) return [key, system];
      if ( !fresh.has(actor) ) fresh.set(actor, snapshotActor(actor) ?? system);
      const profile = (typeof damageProfileOf === "function") ? damageProfileOf(actor) : null;
      if ( profile ) profiles[key] = profile;
      return [key, fresh.get(actor)];
    }));
    return {...options, targetSystems, ...(Object.keys(profiles).length ? {adjustmentProfiles: profiles} : {})};
  }
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

/* -------------------------------------------- */

function hasReactionPipelineWork(state, services={}) {
  const current = createResolutionState(state);
  if ( current.metadata?.reactionWindows?.length ) return true;
  if ( current.metadata?.activeChildResolution ) return true;
  if ( current.pendingRequests?.some(request => request.type === RESOLUTION_REQUEST_TYPES.REACTION_CHOICE) ) return true;
  if ( Object.values(current.requestResponses ?? {}).some(entry => entry?.request?.type === RESOLUTION_REQUEST_TYPES.REACTION_CHOICE) ) return true;
  return hasReactionDiscoveryOptions(reactionOptionsForState(current, services));
}

function hasReactionDiscoveryOptions(options) {
  return normalizeArray(options?.triggers).length > 0
    || typeof options?.discover === "function"
    || typeof options?.triggers === "function";
}

function reactionOptionsForState(state, services={}) {
  const current = createResolutionState(state);
  return {
    ...(current.input?.reactions ?? {}),
    ...(current.input?.context?.reactions ?? {}),
    ...(services.reactions ?? {})
  };
}

function actionReactionDiscoveryOptions({state, services, event, timing}) {
  const options = reactionOptionsForState(state, services);
  if ( typeof options.discover === "function" ) {
    return options.discover({state: createResolutionState(state), services, event, timing}) ?? {};
  }
  if ( !hasReactionDiscoveryOptions(options) ) return null;
  const input = preparedResolverInput(state);
  const action = actionRef(input.action, state.actionDefinition, state.validation?.find(entry => entry?.type === "action-definition") ?? null);
  return {
    triggers: resolveMaybeFunction(options.triggers, {state, services, event, timing}) ?? [],
    resourcesByActor: resolveMaybeFunction(options.resourcesByActor, {state, services, event, timing}) ?? {},
    actionDefinitionsById: options.actionDefinitionsById ?? {},
    controllerUserIdsByActor: resolveMaybeFunction(options.controllerUserIdsByActor, {state, services, event, timing}) ?? {},
    context: {
      ...(input.context ?? {}),
      ...(options.context ?? {}),
      event,
      timing,
      parentAction: action,
      parentSource: input.source ?? state.source ?? null,
      parentTargets: input.targets ?? state.targets ?? []
    },
    usedTriggerIds: uniqueStrings([...(options.usedTriggerIds ?? []), ...(state.triggerIdentities ?? [])]),
    handledCandidateIds: options.handledCandidateIds ?? [],
    policies: {
      ...(input.policies?.reactions ?? {}),
      ...(options.policies ?? {})
    },
    ordering: {
      ...(options.ordering ?? {}),
      initiativeActorIds: options.ordering?.initiativeActorIds
        ?? input.context?.initiativeActorIds
        ?? input.context?.combatActorOrder
        ?? null
    },
    metadata: {
      ...(options.metadata ?? {}),
      timing
    }
  };
}

function actionDeclaredReactionEvent(state) {
  const input = preparedResolverInput(state);
  const definitionValidation = state.validation?.find(entry => entry?.type === "action-definition") ?? null;
  const action = actionRef(input.action, state.actionDefinition, definitionValidation);
  if ( !action.id && !state.actionDefinition?.id ) return null;
  return createAutomationEvent({
    id: `event:${state.id}:action-declared`,
    type: AUTOMATION_EVENT_TYPES.ACTION_DECLARED,
    phase: AUTOMATION_EVENT_PHASES.INTERRUPT,
    source: input.source ?? state.source ?? null,
    targets: input.targets ?? state.targets ?? [],
    tags: action.tags ?? [],
    data: {
      action,
      actionDefinitionId: state.actionDefinition?.id ?? null,
      timing: REACTION_WINDOW_TIMINGS.AFTER_ACTION_DECLARED
    }
  });
}

function attackOutcomeReactionEvent(state) {
  const input = preparedResolverInput(state);
  if ( !shouldResolveAttack(input.attack) ) return null;
  const attackResolution = state.results?.attackResolution ?? null;
  if ( !attackResolution?.ok ) return null;
  const hits = attackResolution.hits ?? [];
  const misses = attackResolution.misses ?? [];
  const attackResults = hits.length ? hits : misses;
  if ( !attackResults.length ) return null;
  const outcome = hits.length ? "hit" : "miss";
  const first = attackResults[0];
  return createAutomationEvent({
    id: `event:${state.id}:attack-outcome:${outcome}`,
    type: hits.length ? AUTOMATION_EVENT_TYPES.ATTACK_HIT : AUTOMATION_EVENT_TYPES.ATTACK_MISS,
    phase: AUTOMATION_EVENT_PHASES.INTERRUPT,
    source: state.actionContext?.source ?? input.source ?? state.source ?? null,
    targets: attackResults.map(result => result.target).filter(Boolean),
    // Its kind ("melee", "ranged") too, so a reaction can answer one kind (a Parry, a melee attack).
    tags: uniqueStrings([...(state.actionContext?.action?.tags ?? []), outcome,
      state.actionDefinition?.attack?.type ?? input.attack?.type].filter(Boolean)),
    data: {
      action: state.actionContext?.action ?? actionRef(input.action, state.actionDefinition),
      attackResolution,
      attackResults,
      outcome,
      attackTotal: first?.roll?.total ?? null,
      defense: first?.defense ?? null,
      defenseValue: first?.defense?.value ?? null,
      timing: REACTION_WINDOW_TIMINGS.AFTER_OUTCOME
    }
  });
}

/** @param {object} options */
export function createActionReactionChildState({parentState, candidate, baseChildState, services={}}) {
  const reactionOptions = reactionOptionsForState(parentState, services);
  const custom = reactionOptions.createChildState;
  if ( typeof custom === "function" ) return custom({parentState, candidate, baseChildState});
  const actionDefinition = candidate.actionDefinition ?? candidate.action ?? null;
  if ( !actionDefinition ) return baseChildState;
  const actorSystem = actorSystemForReactionCandidate(candidate, reactionOptions.actorSystemsByActor);
  return createActionResolutionState({
    id: baseChildState.id,
    parentId: baseChildState.parentId,
    relationship: baseChildState.relationship,
    sourceEvent: baseChildState.sourceEvent,
    depth: baseChildState.depth,
    maxDepth: baseChildState.maxDepth,
    ancestry: baseChildState.ancestry,
    triggerIdentities: baseChildState.triggerIdentities,
    actorSystem,
    action: actionFromDefinition(actionDefinition, candidate.action),
    source: candidate.reactor,
    selectedPaymentOptionId: candidate.selectedPaymentOption?.id ?? null,
    metadata: baseChildState.metadata
  });
}

function actorSystemForReactionCandidate(candidate, actorSystemsByActor) {
  const actorId = candidate?.reactor?.actorId ?? null;
  const actorSystem = lookupActorMap(actorSystemsByActor, {actorId}) ?? null;
  return actorSystem?.system ?? actorSystem?.actorSystem ?? actorSystem ?? null;
}

function reevaluateParentAfterReaction({parentState, childState, window, services={}}) {
  const state = createResolutionState(parentState);
  if ( window?.timing !== REACTION_WINDOW_TIMINGS.AFTER_OUTCOME && window?.timing !== REACTION_WINDOW_TIMINGS.BEFORE_DAMAGE ) {
    return null;
  }
  if ( !state.results?.attackResolution ) return null;
  const input = preparedResolverInput(state);
  if ( !shouldResolveAttack(input.attack) ) return null;

  const attack = attackInputWithCurrentDefenses(input.attack, {
    targetActors: services.targetActors ?? reactionOptionsForState(state, services).targetActors ?? null
  });
  const actionContext = state.results?.actionResult?.context ?? state.actionContext ?? createActionContext({
    ...(input.context ?? {}),
    action: actionRef(input.action, state.actionDefinition),
    source: input.source ?? state.source,
    targets: input.targets ?? state.targets ?? [],
    policies: {...(input.context?.policies ?? {}), ...(input.policies ?? {})}
  });
  const before = state.results.attackResolution;
  const after = resolveAttackTargets({
    roll: attack.roll,
    // The same per-target overrides as the first resolution (critical-on-hit, high ground).
    targetContexts: withAttackBonuses(withOutcomeOverrides(attack.targetContexts ?? state.results?.targetResolution?.targetContexts ?? [],
      attack.outcomesByTarget), attack.bonusByTarget),
    targets: attack.targets ?? (state.results?.targetResolution ? [] : actionContext.targets),
    defense: attack.defense ?? null,
    defenseKey: attack.defenseKey ?? "ac",
    policy: {...(input.policies?.attack ?? {}), ...(attack.policy ?? {})},
    context: {
      action: actionContext.action,
      source: actionContext.source,
      ...(attack.context ?? {})
    }
  });
  if ( !after.ok ) return {
    ok: false,
    type: "attack-outcome",
    code: after.code,
    before,
    after
  };

  const actionResult = state.results?.actionResult
    ? addResolutionStep(state.results.actionResult, {
        stage: ACTION_RESOLUTION_STAGES.ROLL,
        events: attackEvents(actionContext, after),
        consequences: [{
          type: "attackReevaluated",
          before,
          after,
          reactionWindowId: window.id,
          childResolutionId: childState?.id ?? null
        }],
        data: {
          reactionWindowId: window.id,
          childResolutionId: childState?.id ?? null,
          before,
          after
        }
      })
    : null;
  return {
    ok: true,
    type: "attack-outcome",
    reactionWindowId: window.id,
    childResolutionId: childState?.id ?? null,
    before: summarizeAttackOutcome(before),
    after: summarizeAttackOutcome(after),
    inputPatch: {attack},
    results: {
      attackResolution: after,
      ...(actionResult ? {actionResult} : {})
    }
  };
}

function attackInputWithCurrentDefenses(attack, {targetActors=null, targetContexts: fallbackTargetContexts=[], targets: fallbackTargets=[]}={}) {
  const defenseKey = attack?.defenseKey ?? "ac";
  const hasTargetContexts = attack?.targetContexts != null || normalizeArray(fallbackTargetContexts).length > 0;
  const hasTargets = attack?.targets != null || normalizeArray(fallbackTargets).length > 0;
  const targetContexts = normalizeArray(attack?.targetContexts ?? fallbackTargetContexts).map(context => {
    const actor = actorForTarget(targetActors, context?.target ?? context);
    const defense = resolveActorDefense(actor, defenseKey);
    if ( !defense ) return context;
    return {
      ...clonePlain(context),
      defenses: {
        ...(context?.defenses ?? {}),
        [defenseKey]: defense
      }
    };
  });
  const targets = normalizeArray(attack?.targets ?? fallbackTargets).map(target => {
    const actor = actorForTarget(targetActors, target);
    const defense = resolveActorDefense(actor, defenseKey);
    if ( !defense ) return target;
    return {
      ...clonePlain(target),
      defenses: {
        ...(target?.defenses ?? {}),
        [defenseKey]: defense
      }
    };
  });
  return {
    ...(attack ?? {}),
    ...(hasTargetContexts ? {targetContexts} : {}),
    ...(hasTargets ? {targets} : {})
  };
}

function actorForTarget(targetActors, target) {
  return lookupActorMap(targetActors, targetLookupRefObject(target));
}

function lookupActorMap(mapLike, target) {
  if ( !mapLike || !target ) return null;
  const refs = targetLookupRefs(targetLookupRefObject(target));
  const keys = uniqueStrings([
    ...refs,
    target.actorId,
    target.id,
    target.uuid,
    target.actorId ? `actor:${target.actorId}` : null,
    target.actorId ? `Actor.${target.actorId}` : null
  ]);
  if ( typeof mapLike === "function" ) {
    for ( const key of keys ) {
      const found = mapLike({actorId: target.actorId ?? null, ref: key, refs, target});
      if ( found ) return found;
    }
    return null;
  }
  if ( mapLike instanceof Map ) {
    for ( const key of keys ) {
      if ( mapLike.has(key) ) return mapLike.get(key);
    }
    return null;
  }
  if ( Array.isArray(mapLike) ) {
    return mapLike.find(actor => {
      const actorKeys = uniqueStrings([
        actor?.id,
        actor?.uuid,
        actor?.actorId,
        actor?.id ? `actor:${actor.id}` : null,
        actor?.id ? `Actor.${actor.id}` : null
      ]);
      return keys.some(key => actorKeys.includes(key));
    }) ?? null;
  }
  for ( const key of keys ) {
    if ( mapLike?.[key] ) return mapLike[key];
  }
  return null;
}

function targetLookupRefObject(target) {
  const value = target?.target ?? target ?? {};
  return {
    ...value,
    actorId: value.actorId ?? value.actor?.id ?? null,
    uuid: value.uuid ?? value.actor?.uuid ?? null,
    id: value.id ?? value.actor?.id ?? null
  };
}

function summarizeAttackOutcome(resolution) {
  return {
    hitCount: resolution?.hits?.length ?? 0,
    missCount: resolution?.misses?.length ?? 0,
    outcomes: normalizeArray(resolution?.results).map(result => ({
      target: result?.target ?? null,
      outcome: result?.outcome ?? null,
      hit: result?.hit ?? false,
      defense: result?.defense ?? null,
      roll: result?.roll ?? null
    }))
  };
}

function resolveMaybeFunction(value, context) {
  return typeof value === "function" ? value(context) : value;
}

function uniqueStrings(values) {
  return [...new Set(normalizeArray(values).filter(value => value != null && value !== "").map(String))];
}

/* -------------------------------------------- */

/**
 * Once the Action's check is resolved, its damage, healing and effects are those for the outcome: an entry's
 * `checkOutcomePolicy` is "success" (the default), "failure" or "any".
 */
function withCheckOutcome(definition, checkResolution) {
  if ( !definition || !checkResolution ) return definition;
  const outcome = checkResolution.success ? "success" : "failure";
  const applies = entry => [outcome, "any"].includes(entry?.checkOutcomePolicy ?? "success");
  return {...definition, damage: (definition.damage ?? []).filter(applies), healing: (definition.healing ?? []).filter(applies),
    effects: (definition.effects ?? []).filter(applies), stabilize: definition.stabilize === true && checkResolution.success === true};
}

function preparedResolverInput(state) {
  const input = state.input ?? {};
  const effective = state.configuration?.effectiveDefinition ?? state.actionDefinition;
  const definition = withCheckOutcome(effective, state.results?.checkResolution);
  if ( !definition ) return clonePlain(input) ?? {};
  // A kind the check removed entirely must not come back from the input earlier stages carried over.
  const removed = kind => !!effective?.[kind]?.length && !definition[kind]?.length;
  const prepared = actionDefinitionToResolverInput(definition, {
    actorSystem: input.actorSystem,
    source: input.source,
    targets: input.targets ?? [],
    targeting: input.targeting,
    attack: input.attack,
    save: input.save,
    check: input.check,
    damage: removed("damage") ? null : input.damage,
    healing: removed("healing") ? null : input.healing,
    effects: removed("effects") ? null : input.effects,
    context: input.context ?? {},
    policies: input.policies ?? {}
  });

  return {
    ...input,
    ...prepared,
    actorSystem: input.actorSystem,
    action: input.action,
    source: input.source,
    durability: input.durability,
    configuration: input.configuration,
    configurationContributions: input.configurationContributions ?? [],
    selectedPaymentOptionId: input.selectedPaymentOptionId ?? null
  };
}

function hasConfigurationWork(definition, configurationContributions) {
  return !!definition?.configuration?.length || configurationContributionCount(configurationContributions) > 0;
}

function configurationContributionCount(contributions) {
  if ( contributions == null ) return 0;
  if ( Array.isArray(contributions) ) return contributions.length;
  if ( contributions instanceof Set || contributions instanceof Map ) return contributions.size;
  return 1;
}

function configurationFromInput(value) {
  if ( value?.configuration ) return value.configuration;
  if ( value?.choices || value?.responses ) return value;
  return value ?? null;
}

function configurationWithValidatedPayment(configuration, validation) {
  return {
    ...clonePlain(configuration),
    payment: {
      ...(configuration.payment ?? {}),
      discovery: validation.payment.discovery,
      selectedPaymentOptionId: validation.payment.selectedPaymentOptionId,
      selectedPaymentPlan: validation.payment.selectedPaymentPlan
    },
    selectedPaymentOptionId: validation.payment.selectedPaymentOptionId,
    selectedPaymentPlan: validation.payment.selectedPaymentPlan
  };
}

function choiceResponsesFrom(configuration) {
  if ( !configuration ) return {};
  return configuration.choices ?? configuration.responses ?? (configuration.effectiveDefinition ? {} : configuration);
}

function hasChoiceResponse(responses, choiceId) {
  if ( responses instanceof Map ) return responses.has(choiceId);
  if ( Array.isArray(responses) ) return responses.some(response => (response?.choiceId ?? response?.id) === choiceId);
  return Object.hasOwn(responses ?? {}, choiceId);
}

function needsTargetInput({targeting, targets}) {
  if ( !targeting?.required && !needsTargetRefinement(targeting) ) return false;
  if ( needsTargetRefinement(targeting) ) return true;
  return !hasTargetInputs({targeting, targets});
}

/**
 * A refinement prompt shows the authority's default selection (all eligible, by default), so the chooser's
 * changes become real select/deselect decisions. Without it, ticking one of three counted as all three.
 */
function targetingWithDefaultSelection(state, input, targeting) {
  const preview = resolveActionTargets({
    source: state.source ?? input.source ?? null,
    targetSet: targeting.targetSet ?? null,
    candidates: targeting.candidates ?? [],
    targets: targeting.targets ?? [],
    eligibilityPolicy: targeting.eligibilityPolicy ?? {},
    refinementPolicy: targeting.refinementPolicy ?? {},
    context: {...(targeting.context ?? {})},
    metadata: targeting.metadata ?? {}
  });
  const selected = new Set((preview.selectionRequest?.currentlySelected ?? []).map(String));
  const mark = candidate => ({...candidate, selected: selected.has(String(candidate.id ?? candidate.targetId))});
  return {
    ...targeting,
    ...(targeting.candidates ? {candidates: targeting.candidates.map(mark)} : {}),
    ...(targeting.targetSet ? {targetSet: {...targeting.targetSet, candidates: (targeting.targetSet.candidates ?? []).map(mark)}} : {})
  };
}

function needsTargetRefinement(targeting) {
  if ( !targeting ) return false;
  const policy = targeting.refinementPolicy ?? {};
  if ( policy.requiresSelection === true ) return !(targeting.decisions ?? []).length;
  const candidates = targeting.candidates ?? targeting.targetSet?.candidates ?? [];
  if ( !candidates.length || (targeting.decisions ?? []).length ) return false;
  const min = positiveLimit(policy.minSelections ?? policy.minChoices);
  if ( (policy.defaultSelection ?? TARGET_DEFAULT_SELECTION.ALL) === TARGET_DEFAULT_SELECTION.NONE && min ) return true;
  const max = finiteNumber(policy.maxSelections ?? policy.maxChoices);
  return max != null && candidates.length > max;
}

function hasTargetInputs({targeting, targets}) {
  return !!targets?.length
    || !!targeting?.targets?.length
    || !!targeting?.candidates?.length
    || !!targeting?.targetSet?.candidates?.length
    || !!targeting?.targetSet;
}

function hasRollTotal(roll) {
  if ( roll == null ) return false;
  if ( typeof roll === "number" ) return Number.isFinite(roll);
  return Number.isFinite(Number(roll.total));
}

function rollRequestFromAcceptedResponse(accepted, fallbackFactory) {
  return accepted?.request?.payload?.rollRequest ?? fallbackFactory();
}

/**
 * A d20 request's dice with its bonus dice (Bless +1d4). With bonus dice, the total is no longer the natural d20
 * plus the modifier, so only the formula's bounds check it.
 */
function bonusDiceRequest(dice, modifier) {
  const bonus = (Array.isArray(dice) ? dice : []).filter(die => (Number(die?.number) > 0) && (Number(die?.faces) > 0));
  if ( !bonus.length ) return {};
  return {definition: {dice: [{id: "d20", number: 1, faces: 20, purpose: "d20"}, ...bonus.map((die, index) => ({
    id: `bonus:${die.id ?? index}`, number: die.number, faces: die.faces, purpose: "bonus", ...(die.sign < 0 ? {sign: -1} : {})}))]},
  expected: {validateTotalFromNatural: modifier.known, modifierTotal: null}};
}

function attackRollRequestForState(state, input, {suffix="attack-roll"}={}) {
  const attack = input.attack ?? {};
  const modifier = rollModifierInfo(attack, ["attackBonus", "modifierTotal", "totalModifier", "modifier", "bonus"]);
  const bonus = bonusDiceRequest(attack.dice, modifier);
  return createD20RollRequest({
    id: requestIdFor(state, suffix),
    resolutionId: state.id,
    type: ROLL_TYPES.ATTACK,
    modifier: modifier.value,
    formula: attack.formula ?? attack.rollFormula ?? null,
    rollMode: attack.rollMode ?? attack.advantageState ?? attack.roll?.mode,
    visibility: attack.visibility ?? input.context?.messageMode,
    source: state.source ?? input.source ?? null,
    target: firstRollTarget(input),
    chooser: attack.chooser ?? ROLL_AUTHORITY.SOURCE_CONTROLLER,
    authority: attack.authority ?? {kind: ROLL_AUTHORITY.SOURCE_CONTROLLER},
    modifiers: attack.modifiers ?? (modifier.known ? [{id: "attack-modifier", value: modifier.value}] : []),
    expected: {
      validateTotalFromNatural: modifier.known,
      modifierTotal: modifier.known ? modifier.value : null
    },
    ...bonus,
    metadata: {
      actionDefinitionId: state.actionDefinition?.id ?? null,
      rollKind: "attack",
      defenseKey: attack.defenseKey ?? "ac",
      statistic: attack.statistic ?? null,
      attackType: attack.type ?? null
    }
  });
}

function checkRollRequestForState(state, input, {suffix="check-roll"}={}) {
  const check = input.check ?? {};
  const modifier = rollModifierInfo(check, ["checkBonus", "modifierTotal", "totalModifier", "modifier", "bonus"]);
  return createD20RollRequest({
    id: requestIdFor(state, suffix),
    resolutionId: state.id,
    type: check.skill ? ROLL_TYPES.SKILL_CHECK : ROLL_TYPES.ABILITY_CHECK,
    modifier: modifier.value,
    rollMode: check.rollMode,
    visibility: check.visibility ?? input.context?.messageMode,
    dc: check.dc ?? null,
    source: state.source ?? input.source ?? null,
    chooser: check.chooser ?? ROLL_AUTHORITY.SOURCE_CONTROLLER,
    authority: check.authority ?? {kind: ROLL_AUTHORITY.SOURCE_CONTROLLER},
    modifiers: modifier.known ? [{id: "check-modifier", value: modifier.value}] : [],
    expected: {validateTotalFromNatural: modifier.known, modifierTotal: modifier.known ? modifier.value : null},
    ...bonusDiceRequest(check.dice, modifier),
    metadata: {actionDefinitionId: state.actionDefinition?.id ?? null, rollKind: "check", ability: check.ability ?? null,
      skill: check.skill ?? null}
  });
}

function saveRollRequestForState(state, input, {target=null, suffix="save-roll", bonus=0}={}) {
  const save = input.save ?? {};
  // Each target adds its own save bonus, which the runtime keys by Token.
  const targetBonus = save.modifiersByTarget?.[rollModeTargetKey(target ?? firstRollTarget(input))];
  const known = Number.isFinite(targetBonus) ? {known: true, value: targetBonus}
    : rollModifierInfo(save, ["saveBonus", "modifierTotal", "totalModifier", "modifier", "bonus"]);
  const modifier = bonus ? {known: known.known, value: (Number(known.value) || 0) + bonus} : known;
  return createD20RollRequest({
    id: requestIdFor(state, suffix),
    resolutionId: state.id,
    type: ROLL_TYPES.SAVING_THROW,
    modifier: modifier.value,
    formula: save.formula ?? save.rollFormula ?? null,
    // Each target rolls with its own advantage or disadvantage, which the runtime keys by Token.
    rollMode: save.rollModesByTarget?.[rollModeTargetKey(target ?? firstRollTarget(input))]
      ?? save.rollMode ?? save.advantageState ?? save.roll?.mode,
    // Saves keep `system` visibility: the roller's own message mode decides (see withRollerVisibility).
    dc: save.dc ?? null,
    source: target ?? firstRollTarget(input) ?? state.source ?? input.source ?? null,
    target: state.source ?? input.source ?? null,
    chooser: save.chooser ?? ROLL_AUTHORITY.TARGET_CONTROLLER,
    authority: save.authority ?? {kind: ROLL_AUTHORITY.TARGET_CONTROLLER},
    modifiers: save.modifiers ?? (modifier.known ? [{id: "save-modifier", value: modifier.value}] : []),
    expected: {
      validateTotalFromNatural: modifier.known,
      modifierTotal: modifier.known ? modifier.value : null
    },
    // Each target's own bonus dice (Bless), keyed by Token like its bonus.
    ...bonusDiceRequest(save.diceByTarget?.[rollModeTargetKey(target ?? firstRollTarget(input))] ?? save.dice, modifier),
    metadata: {
      actionDefinitionId: state.actionDefinition?.id ?? null,
      rollKind: "save",
      saveKey: save.saveKey ?? save.ability ?? null,
      ability: save.ability ?? null,
      dcKey: save.dcKey ?? "save"
    }
  });
}

function rollModifierInfo(data, keys) {
  for ( const key of keys ) {
    const value = finiteNumber(data?.[key]);
    if ( value != null ) return {known: true, value};
  }
  const statisticValue = finiteNumber(data?.statistic?.modifier ?? data?.statistic?.totalModifier ?? data?.statistic?.bonus);
  if ( statisticValue != null ) return {known: true, value: statisticValue};
  return {known: false, value: 0};
}

function firstRollTarget(input) {
  return input.targets?.[0]
    ?? input.targeting?.targets?.[0]
    ?? input.targeting?.candidates?.[0]?.target
    ?? input.targeting?.targetSet?.candidates?.[0]?.target
    ?? null;
}

function appendRollRequest(requests, rollRequest) {
  const normalized = normalizeArray(requests);
  if ( normalized.some(request => request?.id === rollRequest.id) ) {
    return normalized.map(request => request?.id === rollRequest.id ? rollRequest : request);
  }
  return [...normalized, rollRequest];
}

function completedRollRequestIds(state) {
  return normalizeArray(state.rollResults)
    .map(result => result?.rollResult?.requestId ?? result?.rollRequest?.id ?? result?.requestId)
    .filter(value => value != null)
    .map(String);
}

function hasSaveRollInput(save, input) {
  if ( hasRollTotal(save.roll) ) return true;
  const saveKey = save.saveKey ?? save.ability ?? null;
  return hasTargetSaveData(save.targetContexts, saveKey)
    || hasTargetSaveData(save.targets, saveKey)
    || hasTargetSaveData(input.targets, saveKey)
    || hasTargetSaveData(input.targeting?.targets, saveKey)
    || hasTargetSaveData(input.targeting?.candidates, saveKey)
    || hasTargetSaveData(input.targeting?.targetSet?.candidates, saveKey);
}

function hasTargetSaveData(entries, saveKey) {
  return normalizeArray(entries).some(entry => {
    const target = entry?.target ?? entry;
    return hasRollTotal(entry?.roll)
      || hasRollTotal(entry?.save)
      || (saveKey && hasRollTotal(entry?.saves?.[saveKey]))
      || hasRollTotal(target?.roll)
      || hasRollTotal(target?.save)
      || (saveKey && hasRollTotal(target?.saves?.[saveKey]))
      || hasRollTotal(target?.target?.save)
      || (saveKey && hasRollTotal(target?.target?.saves?.[saveKey]))
      || hasRollTotal(target?.actor?.save)
      || (saveKey && hasRollTotal(target?.actor?.saves?.[saveKey]));
  });
}

function actionFromDefinition(definition, action) {
  if ( definition ) return {
    id: definition.id ?? action?.id ?? action?.uuid ?? null,
    type: definition.category ?? action?.type ?? "action",
    name: definition.label ?? action?.name ?? null,
    slug: definition.slug ?? action?.slug ?? action?.system?.slug ?? null,
    system: {
      definition: clonePlain(definition),
      tags: [...(definition.tags ?? [])],
      slug: definition.slug ?? null
    },
    metadata: {
      ...(definition.metadata ?? {}),
      actionDefinitionId: definition.id ?? null
    }
  };
  return {
    id: action?.id ?? action?.uuid ?? null,
    type: action?.type ?? "action",
    name: action?.name ?? null,
    slug: action?.slug ?? action?.system?.slug ?? null,
    system: {
      definition: clonePlain(action?.definition ?? action?.actionDefinition ?? action?.system?.definition ?? action?.system?.actionDefinition ?? null),
      tags: clonePlain(action?.tags ?? action?.system?.tags ?? []) ?? []
    },
    metadata: clonePlain(action?.metadata ?? {}) ?? {}
  };
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

function markActionPipelineStage(state, {
  stageId,
  status,
  lifecycleStatus,
  code=ACTION_PIPELINE_CODES.OK,
  reason=null,
  data={}
}) {
  return updateResolutionState(state, {
    status: lifecycleStatus,
    currentStageId: stageId,
    completedStageIds: status === RESOLUTION_STAGE_STATUS.COMPLETED
      ? appendUnique(state.completedStageIds, stageId)
      : state.completedStageIds,
    stageStatuses: {
      ...state.stageStatuses,
      [stageId]: status
    },
    trace: [
      ...state.trace,
      {
        id: `trace:${state.id}:${state.trace.length + 1}`,
        stageId,
        status,
        result: status === RESOLUTION_STAGE_STATUS.FAILED ? "fail" : "continue",
        code,
        reason,
        requestIds: [],
        data: clonePlain(data) ?? {}
      }
    ]
  });
}

function actionPipelineResult(state, code=null) {
  const waiting = state.pendingRequests.length > 0;
  const failed = state.status === RESOLUTION_STATE_STATUS.FAILED;
  const cancelled = state.status === RESOLUTION_STATE_STATUS.CANCELLED;
  const completed = state.status === RESOLUTION_STATE_STATUS.COMPLETED;
  return {
    ok: !failed && !cancelled,
    code: code ?? (waiting
      ? RESOLUTION_PIPELINE_CODES.WAITING
      : completed
        ? RESOLUTION_PIPELINE_CODES.COMPLETED
        : failed
          ? RESOLUTION_PIPELINE_CODES.FAILED
          : ACTION_PIPELINE_CODES.OK),
    status: state.status,
    waiting,
    completed,
    state
  };
}

function requestIdFor(state, suffix) {
  return `request:${state.id}:${suffix}`;
}

function positiveLimit(value) {
  if ( value == null ) return false;
  const number = finiteNumber(value);
  return number == null ? true : number > 0;
}

function finiteNumber(value) {
  if ( value == null || value === "" ) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeArray(value) {
  if ( value == null ) return [];
  if ( Array.isArray(value) ) return value;
  if ( value instanceof Set ) return [...value];
  return [value];
}

function appendUnique(values, value) {
  return [...new Set([...values, value].filter(entry => entry != null).map(String))];
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
