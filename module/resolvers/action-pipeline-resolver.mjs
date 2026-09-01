import {
  TARGET_DEFAULT_SELECTION
} from "../helpers/targeting.mjs";
import {targetLookupRefs} from "../helpers/target-actor-refs.mjs";
import {footprintDistance} from "../helpers/grid-footprints.mjs";
import {resolveActorDefense} from "../helpers/combat-statistics.mjs";
import {
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
import {resolveActorResourcePayment} from "./resource-resolver.mjs";
import {resolveActionTargets} from "./target-resolver.mjs";
import {resolveAttackTargets} from "./attack-resolver.mjs";
import {resolveSaveTargets} from "./save-resolver.mjs";
import {
  REACTION_WINDOW_TIMINGS,
  completeReactionChildResolution,
  createReactionWindowStage
} from "./reaction-resolver.mjs";

export const ACTION_PIPELINE_STAGE_IDS = Object.freeze({
  CONFIGURATION: "action.configuration",
  TARGETING: "action.targeting",
  RANGE: "action.range",
  ATTACK_ROLL: "action.attack-roll",
  ATTACK_OUTCOME: "action.attack-outcome",
  REACTION_AFTER_ACTION_DECLARED: "action.reaction.after-action-declared",
  REACTION_AFTER_ATTACK_OUTCOME: "action.reaction.after-attack-outcome",
  SAVE_ROLL: "action.save-roll",
  SAVE_OUTCOME: "action.save-outcome",
  DAMAGE_ROLL: "action.damage-roll",
  DAMAGE: "action.damage",
  HEALING: "action.healing",
  EFFECTS: "action.effects",
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
  damage=null,
  healing=null,
  effects=null,
  durability=null,
  reactions=null,
  configuration=null,
  configurationContributions=[],
  context={},
  policies={},
  selectedPaymentOptionId=null,
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
      damage,
      healing,
      effects,
      durability,
      reactions,
      configuration,
      configurationContributions,
      context,
      policies,
      selectedPaymentOptionId
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
    createAttackRollStage(),
    createAttackOutcomeStage()
  );
  if ( reactions ) stages.push(createAttackOutcomeReactionStage());
  stages.push(
    createSaveRollStage(),
    createSaveOutcomeStage(),
    createDamageRollStage(),
    createDamageStage(),
    createHealingStage(),
    createEffectStage(),
    createPaymentStage(),
    createReadyToCommitStage()
  );
  return stages;
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
      const suppliedConfiguration = state.configuration?.effectiveDefinition
        ? state.configuration
        : configurationFromInput(input.configuration ?? accepted?.response?.value);

      if ( suppliedConfiguration?.effectiveDefinition ) {
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

      const choices = choiceResponsesFrom(suppliedConfiguration);
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
      const accepted = getResolutionResponse(state, {
        requestId: requestIdFor(state, "targets"),
        type: RESOLUTION_REQUEST_TYPES.TARGET_SELECTION
      }) ?? getResolutionResponse(state, {
        requestId: requestIdFor(state, "target-refinement"),
        type: RESOLUTION_REQUEST_TYPES.TARGET_REFINEMENT
      });
      if ( accepted ) {
        const value = targetResponseValue(accepted.response.value);
        const nextTargeting = mergeTargetingInput(input.targeting, value);
        input = {
          ...input,
          targets: value.targets ?? input.targets ?? [],
          targeting: nextTargeting
        };
        state = updateResolutionState(state, {
          targets: input.targets ?? [],
          targetSet: value.targetSet ?? state.targetSet,
          targetRefinement: value.targetRefinement ?? state.targetRefinement,
          input
        });
      }

      const targeting = input.targeting;
      if ( !accepted && needsTargetInput({targeting, targets: input.targets ?? []}) ) {
        const refinement = needsTargetRefinement(targeting);
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
              targeting,
              targets: input.targets ?? [],
              candidates: targeting?.candidates ?? [],
              targetSet: targeting?.targetSet ?? null
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
      if ( !range || !targetContexts.length ) return continueResolutionStage({
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
          reason: failures[0].code,
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

      const attackResolution = resolveAttackTargets({
        roll: attack.roll,
        targetContexts: attack.targetContexts ?? state.results?.targetResolution?.targetContexts ?? [],
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
        data: {attackResolution}
      });

      return continueResolutionStage({
        state: stateWithActionResult(state, {
          input,
          actionResult,
          results: {attackResolution}
        }),
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

function createSaveOutcomeStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.SAVE_OUTCOME,
    run(state) {
      const input = preparedResolverInput(state);
      if ( !shouldResolveSave(input.save) ) return continueResolutionStage({
        state: updateResolutionState(state, {input})
      });
      const planning = ensureActionPlanningResult(state, input);
      if ( planning.failed ) return planning.failed;
      const {actionContext} = planning;
      let {actionResult} = planning;

      const saveResolution = resolveSaveTargets({
        roll: input.save.roll,
        targetContexts: input.save.targetContexts ?? state.results?.targetResolution?.targetContexts ?? [],
        targets: input.save.targets ?? (state.results?.targetResolution ? [] : actionContext.targets),
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
        data: {saveResolution}
      });

      return continueResolutionStage({
        state: stateWithActionResult(state, {
          input,
          actionResult,
          results: {saveResolution}
        }),
        data: {
          successCount: saveResolution.successes.length,
          failureCount: saveResolution.failures.length
        }
      });
    }
  });
}

function createDamageRollStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.DAMAGE_ROLL,
    run(state) {
      const input = preparedResolverInput(state);
      if ( !shouldResolveDamage(input.damage) || damageComponentsHaveAmounts(input.damage?.components) || attackResolvedAsOnlyMisses(state) ) {
        return continueResolutionStage({
          state: updateResolutionState(state, {input})
        });
      }

      const requestId = requestIdFor(state, "damage-roll");
      const accepted = getResolutionResponse(state, {
        requestId,
        type: RESOLUTION_REQUEST_TYPES.ROLL
      });
      if ( accepted ) {
        const rollRequest = rollRequestFromAcceptedResponse(accepted, () => damageRollRequestForState(state, input));
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

        const damage = {
          ...(input.damage ?? {}),
          components: rollResultToDamageComponents({
            result: normalized.result,
            components: input.damage?.components ?? []
          })
        };
        return continueResolutionStage({
          state: updateResolutionState(state, {
            input: {...input, damage},
            rollRequests: appendRollRequest(state.rollRequests, rollRequest),
            rollResults: [
              ...state.rollResults,
              {
                requestId: accepted.request.id,
                type: "damage-roll",
                semanticType: normalized.result.type,
                rollRequest,
                rollResult: normalized.result,
                roll: {total: normalized.result.total}
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

      const rollRequest = damageRollRequestForState(state, input);
      return waitResolutionStage({
        state: updateResolutionState(state, {
          rollRequests: appendRollRequest(state.rollRequests, rollRequest)
        }),
        request: createResolutionRequest({
          id: rollRequest.id,
          resolutionId: state.id,
          stageId: ACTION_PIPELINE_STAGE_IDS.DAMAGE_ROLL,
          type: RESOLUTION_REQUEST_TYPES.ROLL,
          expectedResponseType: "roll-result",
          chooser: rollRequest.chooser,
          authority: rollRequest.authority,
          validation: {
            rollRequestId: rollRequest.id,
            semanticType: rollRequest.type,
            formula: rollFormulaForRequest(rollRequest).formula ?? null
          },
          payload: {
            actionDefinitionId: state.actionDefinition?.id ?? null,
            rollKind: "damage",
            rollRequest,
            damage: input.damage,
            targets: input.targets ?? []
          }
        }),
        reason: "Damage roll result is required before action resolution can continue."
      });
    }
  });
}

function createDamageStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.DAMAGE,
    run(state, services={}) {
      const input = {
        ...preparedResolverInput(state),
        durability: preparePlanningDurabilityOptions(state.input?.durability, services.targetActors)
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
        mutationPlans: durabilityResolution?.mutationPlans ?? [],
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
        durability: preparePlanningDurabilityOptions(state.input?.durability, services.targetActors)
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
        effects: input.effects,
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
        }],
        data: {
          paymentPlan: payment.paymentPlan,
          discovery: payment.discovery
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

function damageRollRequestForState(state, input) {
  const damage = input.damage ?? {};
  return createDamageRollRequest({
    id: requestIdFor(state, "damage-roll"),
    resolutionId: state.id,
    type: ROLL_TYPES.DAMAGE,
    components: damage.components ?? [],
    formula: damage.formula ?? damage.rollFormula ?? null,
    source: state.source ?? input.source ?? null,
    target: firstRollTarget(input),
    chooser: damage.chooser ?? ROLL_AUTHORITY.SOURCE_CONTROLLER,
    authority: damage.authority ?? {kind: ROLL_AUTHORITY.SOURCE_CONTROLLER},
    metadata: {
      actionDefinitionId: state.actionDefinition?.id ?? null,
      rollKind: "damage"
    }
  });
}

/* -------------------------------------------- */

function preparePlanningDurabilityOptions(durability, targetActors) {
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
    tags: uniqueStrings([...(state.actionContext?.action?.tags ?? []), outcome]),
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

function createActionReactionChildState({parentState, candidate, baseChildState, services={}}) {
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
    targetContexts: attack.targetContexts ?? state.results?.targetResolution?.targetContexts ?? [],
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

function preparedResolverInput(state) {
  const input = state.input ?? {};
  const definition = state.configuration?.effectiveDefinition ?? state.actionDefinition;
  if ( !definition ) return clonePlain(input) ?? {};
  const prepared = actionDefinitionToResolverInput(definition, {
    actorSystem: input.actorSystem,
    source: input.source,
    targets: input.targets ?? [],
    targeting: input.targeting,
    attack: input.attack,
    save: input.save,
    damage: input.damage,
    healing: input.healing,
    effects: input.effects,
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
  if ( !configuration || configuration.effectiveDefinition ) return {};
  return configuration.choices ?? configuration.responses ?? configuration;
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

function mergeTargetingInput(current, value) {
  const merged = {
    ...(current ?? {}),
    ...(value.targeting ?? {})
  };
  if ( value.targets ) merged.targets = value.targets;
  if ( value.candidates ) merged.candidates = value.candidates;
  if ( value.targetSet ) merged.targetSet = value.targetSet;
  if ( value.decisions ) merged.decisions = value.decisions;
  return Object.keys(merged).length ? merged : null;
}

function targetResponseValue(value) {
  if ( Array.isArray(value) ) return {targets: value};
  return {
    targets: value?.targets ?? null,
    candidates: value?.candidates ?? null,
    targetSet: value?.targetSet ?? null,
    decisions: value?.decisions ?? value?.targeting?.decisions ?? null,
    targetRefinement: value?.targetRefinement ?? value?.refinement ?? null,
    targeting: value?.targeting ?? null
  };
}

function hasRollTotal(roll) {
  if ( roll == null ) return false;
  if ( typeof roll === "number" ) return Number.isFinite(roll);
  return Number.isFinite(Number(roll.total));
}

function rollRequestFromAcceptedResponse(accepted, fallbackFactory) {
  return accepted?.request?.payload?.rollRequest ?? fallbackFactory();
}

function attackRollRequestForState(state, input) {
  const attack = input.attack ?? {};
  const modifier = rollModifierInfo(attack, ["attackBonus", "modifierTotal", "totalModifier", "modifier", "bonus"]);
  return createD20RollRequest({
    id: requestIdFor(state, "attack-roll"),
    resolutionId: state.id,
    type: ROLL_TYPES.ATTACK,
    modifier: modifier.value,
    formula: attack.formula ?? attack.rollFormula ?? null,
    rollMode: attack.rollMode ?? attack.advantageState ?? attack.roll?.mode,
    source: state.source ?? input.source ?? null,
    target: firstRollTarget(input),
    chooser: attack.chooser ?? ROLL_AUTHORITY.SOURCE_CONTROLLER,
    authority: attack.authority ?? {kind: ROLL_AUTHORITY.SOURCE_CONTROLLER},
    modifiers: attack.modifiers ?? (modifier.known ? [{id: "attack-modifier", value: modifier.value}] : []),
    expected: {
      validateTotalFromNatural: modifier.known,
      modifierTotal: modifier.known ? modifier.value : null
    },
    metadata: {
      actionDefinitionId: state.actionDefinition?.id ?? null,
      rollKind: "attack",
      defenseKey: attack.defenseKey ?? "ac",
      statistic: attack.statistic ?? null,
      attackType: attack.type ?? null
    }
  });
}

function saveRollRequestForState(state, input) {
  const save = input.save ?? {};
  const modifier = rollModifierInfo(save, ["saveBonus", "modifierTotal", "totalModifier", "modifier", "bonus"]);
  return createD20RollRequest({
    id: requestIdFor(state, "save-roll"),
    resolutionId: state.id,
    type: ROLL_TYPES.SAVING_THROW,
    modifier: modifier.value,
    formula: save.formula ?? save.rollFormula ?? null,
    rollMode: save.rollMode ?? save.advantageState ?? save.roll?.mode,
    dc: save.dc ?? null,
    source: firstRollTarget(input) ?? state.source ?? input.source ?? null,
    target: state.source ?? input.source ?? null,
    chooser: save.chooser ?? ROLL_AUTHORITY.TARGET_CONTROLLER,
    authority: save.authority ?? {kind: ROLL_AUTHORITY.TARGET_CONTROLLER},
    modifiers: save.modifiers ?? (modifier.known ? [{id: "save-modifier", value: modifier.value}] : []),
    expected: {
      validateTotalFromNatural: modifier.known,
      modifierTotal: modifier.known ? modifier.value : null
    },
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
