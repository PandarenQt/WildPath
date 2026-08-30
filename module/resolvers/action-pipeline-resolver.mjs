import {
  TARGET_DEFAULT_SELECTION
} from "../helpers/targeting.mjs";
import {
  actionDefinitionFromAction,
  actionDefinitionToResolverInput
} from "../helpers/action-definitions.mjs";
import {
  ACTION_CONFIGURATION_CODES,
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
  ACTION_RESOLVER_CODES,
  executeActionResolution,
  planActionResolution
} from "./action-resolver.mjs";

export const ACTION_PIPELINE_STAGE_IDS = Object.freeze({
  CONFIGURATION: "action.configuration",
  TARGETING: "action.targeting",
  ATTACK_ROLL: "action.attack-roll",
  SAVE_ROLL: "action.save-roll",
  LEGACY_RESOLUTION: "action.legacy-resolution",
  READY_TO_COMMIT: "action.ready-to-commit",
  COMMIT: "action.commit",
  FINALIZATION: "action.finalization"
});

export const ACTION_PIPELINE_CODES = Object.freeze({
  OK: "OK",
  ACTION_DEFINITION_INVALID: "ACTION_DEFINITION_INVALID",
  ACTION_CONFIGURATION_INVALID: "ACTION_CONFIGURATION_INVALID",
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

export function createActionResolutionPipeline() {
  return [
    createConfigurationStage(),
    createTargetingStage(),
    createAttackRollStage(),
    createSaveRollStage(),
    createLegacyResolutionStage(),
    createReadyToCommitStage()
  ];
}

/* -------------------------------------------- */

export function planStagedActionResolution(options={}) {
  const state = options.state
    ? createResolutionState(options.state)
    : createActionResolutionState(options);
  return runResolutionPipeline({
    state,
    stages: createActionResolutionPipeline(),
    services: {
      ...(options.services ?? {}),
      targetActors: options.targetActors ?? options.services?.targetActors ?? null
    }
  });
}

/* -------------------------------------------- */

export function resumeStagedActionResolution({
  state,
  response,
  services={}
}={}) {
  return resumeResolutionPipeline({
    state,
    response,
    stages: createActionResolutionPipeline(),
    services
  });
}

/* -------------------------------------------- */

export async function executeStagedActionResolution(options={}) {
  const planned = planStagedActionResolution(options);
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
  const actionResult = await executeActionResolution({
    actor: options.actor,
    action: options.action ?? input.action,
    source: input.source,
    targets: input.targets ?? [],
    targeting: input.targeting,
    attack: input.attack,
    save: input.save,
    damage: input.damage,
    healing: input.healing,
    effects: input.effects,
    durability: input.durability,
    configuration: committing.configuration ?? input.configuration,
    configurationContributions: input.configurationContributions ?? [],
    targetActors: options.targetActors,
    authority: options.authority,
    context: input.context ?? {},
    policies: input.policies ?? {},
    selectedPaymentOptionId: input.selectedPaymentOptionId ?? null
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

function createConfigurationStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.CONFIGURATION,
    run(state) {
      const input = state.input ?? {};
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

      return continueResolutionStage({
        state: updateResolutionState(state, {
          actionDefinition: resolved.configuration.effectiveDefinition,
          configuration: resolved.configuration,
          input: {
            ...input,
            configuration: resolved.configuration,
            selectedPaymentOptionId: input.selectedPaymentOptionId ?? resolved.configuration.selectedPaymentOptionId
          }
        }),
        data: {
          configurationId: resolved.configuration.id,
          requestCount: discovery.requests.length
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
      const input = state.input ?? {};
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
        return continueResolutionStage({
          state: updateResolutionState(state, {
            targets: value.targets ?? input.targets ?? [],
            targetSet: value.targetSet ?? state.targetSet,
            targetRefinement: value.targetRefinement ?? state.targetRefinement,
            input: {
              ...input,
              targets: value.targets ?? input.targets ?? [],
              targeting: nextTargeting
            }
          }),
          data: {
            responseType: accepted.request.type,
            targetCount: (value.targets ?? input.targets ?? []).length,
            decisionCount: (nextTargeting?.decisions ?? []).length
          }
        });
      }

      const prepared = preparedResolverInput(state);
      const targeting = prepared.targeting;
      if ( !needsTargetInput({targeting, targets: prepared.targets ?? []}) ) {
        return continueResolutionStage({
          state: updateResolutionState(state, {
            input: prepared
          })
        });
      }

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
            targets: prepared.targets ?? [],
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
  });
}

function createAttackRollStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.ATTACK_ROLL,
    run(state) {
      const input = preparedResolverInput(state);
      const accepted = getResolutionResponse(state, {
        requestId: requestIdFor(state, "attack-roll"),
        type: RESOLUTION_REQUEST_TYPES.ROLL
      });
      if ( accepted ) {
        const attack = {
          ...(input.attack ?? {}),
          roll: rollValue(accepted.response.value)
        };
        return continueResolutionStage({
          state: updateResolutionState(state, {
            input: {...input, attack},
            rollResults: [
              ...state.rollResults,
              {
                requestId: accepted.request.id,
                type: "attack-roll",
                roll: attack.roll
              }
            ]
          }),
          data: {requestId: accepted.request.id}
        });
      }

      if ( !input.attack || hasRollTotal(input.attack.roll) ) {
        return continueResolutionStage({
          state: updateResolutionState(state, {input})
        });
      }

      return waitResolutionStage({
        state,
        request: createResolutionRequest({
          id: requestIdFor(state, "attack-roll"),
          resolutionId: state.id,
          stageId: ACTION_PIPELINE_STAGE_IDS.ATTACK_ROLL,
          type: RESOLUTION_REQUEST_TYPES.ROLL,
          expectedResponseType: "attack-roll",
          payload: {
            actionDefinitionId: state.actionDefinition?.id ?? null,
            rollKind: "attack",
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

function createSaveRollStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.SAVE_ROLL,
    run(state) {
      const input = preparedResolverInput(state);
      const accepted = getResolutionResponse(state, {
        requestId: requestIdFor(state, "save-roll"),
        type: RESOLUTION_REQUEST_TYPES.ROLL
      });
      if ( accepted ) {
        const save = {
          ...(input.save ?? {}),
          roll: rollValue(accepted.response.value)
        };
        return continueResolutionStage({
          state: updateResolutionState(state, {
            input: {...input, save},
            rollResults: [
              ...state.rollResults,
              {
                requestId: accepted.request.id,
                type: "save-roll",
                roll: save.roll
              }
            ]
          }),
          data: {requestId: accepted.request.id}
        });
      }

      if ( !input.save || hasSaveRollInput(input.save, input) ) {
        return continueResolutionStage({
          state: updateResolutionState(state, {input})
        });
      }

      return waitResolutionStage({
        state,
        request: createResolutionRequest({
          id: requestIdFor(state, "save-roll"),
          resolutionId: state.id,
          stageId: ACTION_PIPELINE_STAGE_IDS.SAVE_ROLL,
          type: RESOLUTION_REQUEST_TYPES.ROLL,
          expectedResponseType: "save-roll",
          payload: {
            actionDefinitionId: state.actionDefinition?.id ?? null,
            rollKind: "save",
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

function createLegacyResolutionStage() {
  return createResolutionPipelineStage({
    id: ACTION_PIPELINE_STAGE_IDS.LEGACY_RESOLUTION,
    run(state, services={}) {
      const input = state.input ?? {};
      const durability = preparePlanningDurabilityOptions(input.durability, services.targetActors);
      const actionResult = planActionResolution({
        actorSystem: input.actorSystem,
        action: input.action,
        source: input.source,
        targets: input.targets ?? [],
        targeting: input.targeting,
        attack: input.attack,
        save: input.save,
        damage: input.damage,
        healing: input.healing,
        effects: input.effects,
        durability,
        configuration: state.configuration ?? input.configuration,
        configurationContributions: input.configurationContributions ?? [],
        context: input.context ?? {},
        policies: input.policies ?? {},
        selectedPaymentOptionId: input.selectedPaymentOptionId ?? null,
        complete: false
      });
      const nextState = updateResolutionState(state, {
        actionContext: actionResult.context,
        mutationPlans: actionResult.mutationPlans,
        events: actionResult.events,
        results: {
          ...state.results,
          actionResult
        }
      });

      if ( !actionResult.ok && actionResult.status === "failed" ) {
        return failResolutionStage({
          state: nextState,
          code: actionResult.code ?? ACTION_RESOLVER_CODES.OK,
          reason: actionResult.errors[0]?.reason ?? actionResult.code,
          errors: actionResult.errors,
          data: {actionResult}
        });
      }

      return continueResolutionStage({
        state: nextState,
        data: {
          actionResultStatus: actionResult.status,
          mutationPlanCount: actionResult.mutationPlans.length,
          eventCount: actionResult.events.length
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

function rollValue(value) {
  return value?.roll ?? value?.result ?? value;
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
