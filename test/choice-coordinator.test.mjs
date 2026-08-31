import {test} from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_CONFIGURATION_CODES,
  ACTION_CHOICE_TYPES,
  createResolvedActionPreview,
  discoverActionConfigurationChoices
} from "../module/helpers/action-configuration.mjs";
import {
  RESOLUTION_PIPELINE_CODES,
  RESOLUTION_REQUEST_TYPES,
  RESOLUTION_STAGE_RESULT,
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
  waitResolutionStage,
  validateResolutionStateSerializable
} from "../module/helpers/resolution-state.mjs";
import {PROMPT_CONTROL_TYPES, createPromptViewModel} from "../module/helpers/prompt-view-models.mjs";
import {ROLL_CODES, ROLL_TYPES} from "../module/helpers/rolls.mjs";
import {createFoundryV14PromptAdapter} from "../module/adapters/foundry-v14-prompt-adapter.mjs";
import {createTestPromptAdapter} from "../module/adapters/test-prompt-adapter.mjs";
import {
  CHOICE_COORDINATOR_CODES,
  PROMPT_PORT_OUTCOMES,
  coordinateResolutionPrompt,
  createChoiceCoordinator
} from "../module/resolvers/choice-coordinator.mjs";
import {
  createActionResolutionState,
  planStagedActionResolution,
  resumeStagedActionResolution
} from "../module/resolvers/action-pipeline-resolver.mjs";

function actorSystem(overrides={}) {
  return {
    resources: {
      action: {value: 1, max: 1},
      bonus: {value: 1, max: 1},
      reaction: {value: 1, max: 1},
      movement: {value: 30, max: 30},
      ...(overrides.resources ?? {})
    },
    pools: overrides.pools ?? [
      {id: "spell-slot.3", label: "3rd-level Spell Slot", value: 1, max: 1},
      {id: "spell-slot.4", label: "4th-level Spell Slot", value: 1, max: 1},
      {id: "spell-slot.5", label: "5th-level Spell Slot", value: 1, max: 1},
      {id: "sorcery-point", label: "Sorcery Point", value: 2, max: 2}
    ]
  };
}

function definitionAction(definition) {
  return {
    id: definition.id,
    type: "action",
    name: definition.label,
    system: {definition}
  };
}

function configurableDefinition() {
  return {
    schemaVersion: 1,
    id: "action:focused-stance",
    label: "Focused Stance",
    costs: {allOf: []},
    configuration: [{
      id: "stance",
      type: ACTION_CHOICE_TYPES.BOOLEAN,
      label: "Stance",
      required: true
    }]
  };
}

function scalableSpellDefinition() {
  return {
    schemaVersion: 1,
    id: "action:elemental-burst",
    label: "Elemental Burst",
    tags: ["spell"],
    costs: {allOf: []},
    damage: [{
      id: "burst",
      expression: {type: "dice", number: 8, faces: 6},
      damageType: "fire",
      provenance: "spell-base"
    }],
    configuration: [{
      id: "casting-resource",
      type: ACTION_CHOICE_TYPES.RESOURCE,
      label: "Cast At",
      required: true,
      cost: {
        anyOf: [
          [{capability: "spell-slot.3", amount: 1}],
          [{capability: "spell-slot.4", amount: 1}],
          [{capability: "spell-slot.5", amount: 1}]
        ]
      },
      levelByResourceId: {
        "spell-slot.3": 3,
        "spell-slot.4": 4,
        "spell-slot.5": 5
      },
      effects: [{
        type: "scaleDamage",
        componentIds: ["burst"],
        levelChoiceId: "casting-resource",
        baseLevel: 3,
        dice: {number: 1, faces: 6}
      }]
    }]
  };
}

function damageTypeDefinition() {
  return {
    ...scalableSpellDefinition(),
    configuration: [{
      id: "conversion-type",
      type: ACTION_CHOICE_TYPES.DAMAGE_TYPE,
      label: "Replacement Damage Type",
      required: true,
      allowedDamageTypes: ["cold", "lightning"],
      effects: [{
        type: "replaceDamageType",
        componentIds: ["burst"],
        damageTypeChoiceId: "conversion-type"
      }]
    }]
  };
}

function multiChoiceDefinition() {
  return {
    schemaVersion: 1,
    id: "action:careful-mode",
    label: "Careful Mode",
    costs: {allOf: []},
    configuration: [
      {
        id: "modes",
        type: ACTION_CHOICE_TYPES.SELECT_MANY,
        label: "Modes",
        required: true,
        min: 1,
        max: 2,
        options: ["careful", "quick", "silent"]
      },
      {
        id: "intensity",
        type: ACTION_CHOICE_TYPES.NUMBER,
        label: "Intensity",
        required: true,
        min: 1,
        max: 3
      }
    ]
  };
}

function attackDefinition() {
  return {
    schemaVersion: 1,
    id: "action:aimed-strike",
    label: "Aimed Strike",
    costs: {allOf: []},
    attack: {
      type: "melee",
      statistic: "weapon",
      defenseKey: "ac",
      modifierTotal: 5
    }
  };
}

function target(id, data={}) {
  return {
    id,
    actorId: `actor-${id}`,
    tokenId: `token-${id}`,
    disposition: "enemy",
    ...data
  };
}

function actionPipelineResume({state, response, services}) {
  return resumeStagedActionResolution({state, response, services});
}

function configurationState({id="resolution:configuration", definition, system=actorSystem(), contributions=[]}={}) {
  return createResolutionState({
    id,
    actionDefinition: definition,
    input: {
      actorSystem: system,
      configurationContributions: contributions,
      context: {},
      policies: {}
    }
  });
}

function configurationStages() {
  return [
    createResolutionPipelineStage({
      id: "configuration",
      run(state) {
        const accepted = getResolutionResponse(state, {
          requestId: "request:configuration",
          type: RESOLUTION_REQUEST_TYPES.ACTION_CONFIGURATION
        });
        const input = state.input ?? {};
        if ( accepted ) {
          const preview = createResolvedActionPreview({
            definition: state.actionDefinition,
            actorSystem: input.actorSystem,
            choices: accepted.response.value?.choices ?? accepted.response.value,
            configurationContributions: input.configurationContributions ?? [],
            context: input.context ?? {},
            policies: input.policies ?? {}
          });
          if ( !preview.ok ) return failResolutionStage({
            state,
            code: preview.code,
            reason: preview.errors?.[0]?.reason ?? preview.code,
            errors: preview.errors,
            data: {preview}
          });
          return continueResolutionStage({
            state: updateResolutionState(state, {
              actionDefinition: preview.configuration.effectiveDefinition,
              configuration: preview.configuration,
              results: {
                ...state.results,
                preview: preview.preview
              }
            })
          });
        }

        const discovery = discoverActionConfigurationChoices({
          definition: state.actionDefinition,
          actorSystem: input.actorSystem,
          configurationContributions: input.configurationContributions ?? [],
          context: input.context ?? {},
          policies: input.policies ?? {}
        });
        if ( !discovery.ok ) return failResolutionStage({
          state,
          code: discovery.code,
          errors: discovery.errors,
          data: {discovery}
        });
        return waitResolutionStage({
          state,
          request: createResolutionRequest({
            id: "request:configuration",
            resolutionId: state.id,
            stageId: "configuration",
            type: RESOLUTION_REQUEST_TYPES.ACTION_CONFIGURATION,
            expectedResponseType: "action-configuration",
            validation: {
              required: true,
              missingRequiredChoiceIds: discovery.requests.filter(request => request.required).map(request => request.id)
            },
            payload: {
              actionDefinitionId: state.actionDefinition.id,
              requests: discovery.requests,
              traces: discovery.traces
            }
          })
        });
      }
    }),
    createResolutionPipelineStage({
      id: "done",
      run(state) {
        return completeResolutionStage({state});
      }
    })
  ];
}

function choiceStages({requestId="request:choice", required=false, resultKey="choice", stageId="choice"}={}) {
  return [
    createResolutionPipelineStage({
      id: stageId,
      run(state) {
        const accepted = getResolutionResponse(state, {requestId, type: RESOLUTION_REQUEST_TYPES.CHOICE});
        if ( accepted ) return continueResolutionStage({
          state: updateResolutionState(state, {
            results: {
              ...state.results,
              [resultKey]: accepted.response.value
            }
          })
        });
        return waitResolutionStage({
          state,
          request: createResolutionRequest({
            id: requestId,
            resolutionId: state.id,
            stageId,
            type: RESOLUTION_REQUEST_TYPES.CHOICE,
            expectedResponseType: "choice-response",
            validation: {required},
            payload: {
              id: resultKey,
              label: resultKey,
              required
            }
          })
        });
      }
    }),
    createResolutionPipelineStage({
      id: `${stageId}:done`,
      run(state) {
        return completeResolutionStage({state});
      }
    })
  ];
}

test("ChoiceCoordinator routes existing ActionChoiceRequest payloads through PromptPort and staged resume", async () => {
  const waiting = planStagedActionResolution({
    id: "resolution:choice-config",
    actorSystem: actorSystem(),
    action: definitionAction(configurableDefinition()),
    source: {actorId: "actor-source"}
  });
  const coordinator = createChoiceCoordinator({
    promptPorts: [createTestPromptAdapter({
      responses: {
        [waiting.state.pendingRequests[0].id]: {choices: {stance: true}}
      }
    })],
    resume: actionPipelineResume
  });
  const result = await coordinator.coordinate({state: waiting.state});

  assert.equal(waiting.state.status, RESOLUTION_STATE_STATUS.AWAITING_CONFIGURATION);
  assert.equal(waiting.state.pendingRequests[0].type, RESOLUTION_REQUEST_TYPES.ACTION_CONFIGURATION);
  assert.equal(result.ok, true);
  assert.equal(result.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT);
  assert.deepEqual(result.state.configuration.optionSelections.map(choice => choice.id), ["stance"]);
});

test("resource/upcast selection updates configuration through existing preview machinery", async () => {
  const stages = configurationStages();
  const waiting = runResolutionPipeline({
    state: configurationState({
      id: "resolution:upcast",
      definition: scalableSpellDefinition()
    }),
    stages
  });
  const viewModel = createPromptViewModel(waiting.state.pendingRequests[0]);
  const coordinator = createChoiceCoordinator({
    promptPorts: [createTestPromptAdapter({
      responses: {
        "request:configuration": {choices: {"casting-resource": {resourceId: "spell-slot.5"}}}
      }
    })],
    stages
  });
  const result = await coordinator.coordinate({state: waiting.state});

  assert.equal(viewModel.controls[0].type, PROMPT_CONTROL_TYPES.RESOURCE);
  assert.equal(result.ok, true);
  assert.equal(result.state.configuration.castingLevel, 5);
  assert.equal(result.state.results.preview.damage.components[0].formula, "10d6");
  assert.equal(result.state.results.preview.costs.payment.selectedPaymentPlan.resources[0].resourceId, "spell-slot.5");
});

test("damage-type prompts expose only supplied legal values and update authoritative preview", async () => {
  const stages = configurationStages();
  const waiting = runResolutionPipeline({
    state: configurationState({
      id: "resolution:damage-type",
      definition: damageTypeDefinition()
    }),
    stages
  });
  const viewModel = createPromptViewModel(waiting.state.pendingRequests[0]);
  const coordinator = createChoiceCoordinator({
    promptPorts: [createTestPromptAdapter({
      responses: {
        "request:configuration": {choices: {"conversion-type": "lightning"}}
      }
    })],
    stages
  });
  const result = await coordinator.coordinate({state: waiting.state});

  assert.deepEqual(viewModel.controls[0].options.map(option => option.id), ["cold", "lightning"]);
  assert.equal(viewModel.controls[0].options.some(option => option.id === "fire"), false);
  assert.equal(result.ok, true);
  assert.equal(result.state.results.preview.damage.components[0].damageType, "lightning");
  assert.deepEqual(result.state.results.preview.deltas.map(delta => delta.type), ["damage-type"]);
});

test("select-many and number prompts preserve constraints and let ActionConfiguration validate them", async () => {
  const stages = configurationStages();
  const waiting = runResolutionPipeline({
    state: configurationState({
      id: "resolution:multi",
      definition: multiChoiceDefinition()
    }),
    stages
  });
  const viewModel = createPromptViewModel(waiting.state.pendingRequests[0]);
  const coordinator = createChoiceCoordinator({
    promptPorts: [createTestPromptAdapter({
      responses: {
        "request:configuration": {choices: {modes: {values: ["careful", "quick"]}, intensity: 3}}
      }
    })],
    stages
  });
  const result = await coordinator.coordinate({state: waiting.state});

  assert.deepEqual(viewModel.controls.map(control => control.type), [
    PROMPT_CONTROL_TYPES.SELECT_MANY,
    PROMPT_CONTROL_TYPES.NUMBER
  ]);
  assert.equal(viewModel.controls[0].max, 2);
  assert.equal(viewModel.controls[1].min, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.configuration.choices.find(choice => choice.id === "modes").values, ["careful", "quick"]);
  assert.equal(result.state.configuration.choices.find(choice => choice.id === "intensity").value, 3);
});

test("optional choice decline resumes distinctly from required cancellation", async () => {
  const stages = choiceStages({required: false});
  const waiting = runResolutionPipeline({state: createResolutionState({id: "resolution:optional"}), stages});
  const result = await coordinateResolutionPrompt({
    state: waiting.state,
    stages,
    promptPorts: [createTestPromptAdapter({
      responses: {
        "request:choice": {status: PROMPT_PORT_OUTCOMES.DECLINED, reason: "No enhancement."}
      }
    })]
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, CHOICE_COORDINATOR_CODES.OPTIONAL_CHOICE_DECLINED);
  assert.equal(result.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.deepEqual(result.state.results.choice, {declined: true});
});

test("required prompt cancellation cancels before commit-like stages run", async () => {
  let commitRuns = 0;
  const stages = [
    ...choiceStages({required: true}).slice(0, 1),
    createResolutionPipelineStage({
      id: "commit",
      run(state) {
        commitRuns += 1;
        return completeResolutionStage({state});
      }
    })
  ];
  const waiting = runResolutionPipeline({state: createResolutionState({id: "resolution:cancel"}), stages});
  const result = await coordinateResolutionPrompt({
    state: waiting.state,
    stages,
    promptPorts: [createTestPromptAdapter({
      responses: {
        "request:choice": {status: PROMPT_PORT_OUTCOMES.CANCELLED, reason: "Closed."}
      }
    })]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CHOICE_COORDINATOR_CODES.REQUIRED_REQUEST_CANCELLED);
  assert.equal(result.state.status, RESOLUTION_STATE_STATUS.CANCELLED);
  assert.equal(commitRuns, 0);
});

test("manual d20 prompt input becomes a RollResult and resumes the action pipeline", async () => {
  const waiting = planStagedActionResolution({
    id: "resolution:manual-roll",
    actorSystem: actorSystem(),
    action: definitionAction(attackDefinition()),
    source: {actorId: "actor-source"},
    attack: {modifierTotal: 5},
    targeting: {
      required: true,
      candidates: [{
        id: "orc",
        target: target("orc", {defenses: {ac: {value: 12}}}),
        actor: {id: "actor-orc", name: "Orc"},
        disposition: "enemy",
        kind: "creature"
      }]
    }
  });
  const rollRequest = waiting.state.pendingRequests[0].payload.rollRequest;
  const coordinator = createChoiceCoordinator({
    promptPorts: [createTestPromptAdapter({
      responses: {
        [rollRequest.id]: {natural: 12, provenanceType: "physical"}
      }
    })],
    resume: actionPipelineResume
  });
  const result = await coordinator.coordinate({state: waiting.state});

  assert.equal(waiting.state.status, RESOLUTION_STATE_STATUS.AWAITING_ROLL);
  assert.equal(result.ok, true);
  assert.equal(result.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT);
  assert.equal(result.response.value.requestId, rollRequest.id);
  assert.equal(result.response.value.natural, 12);
  assert.equal(result.response.value.total, 17);
  assert.equal(result.response.value.provenance.type, "physical");
  assert.equal(result.state.rollResults[0].rollResult.natural, 12);
  assert.equal(result.state.results.actionResult.consequences.some(entry => entry.type === "attackResolved"), true);
});

test("invalid manual roll prompt values are rejected by Roll validation before resume", async () => {
  const waiting = planStagedActionResolution({
    id: "resolution:invalid-roll",
    actorSystem: actorSystem(),
    action: definitionAction(attackDefinition()),
    source: {actorId: "actor-source"},
    targeting: {
      required: true,
      candidates: [{
        id: "orc",
        target: target("orc", {defenses: {ac: {value: 12}}}),
        actor: {id: "actor-orc", name: "Orc"},
        disposition: "enemy",
        kind: "creature"
      }]
    }
  });
  const result = await coordinateResolutionPrompt({
    state: waiting.state,
    resume: actionPipelineResume,
    promptPorts: [createTestPromptAdapter({
      responses: {
        [waiting.state.pendingRequests[0].id]: {natural: 30}
      }
    })]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, ROLL_CODES.INVALID_MANUAL_RESULT);
  assert.equal(result.state.status, RESOLUTION_STATE_STATUS.AWAITING_ROLL);
  assert.equal(result.state.requestResponses[waiting.state.pendingRequests[0].id], undefined);
});

test("wrong request id is rejected before staged resume", async () => {
  const stages = choiceStages({required: true});
  const waiting = runResolutionPipeline({state: createResolutionState({id: "resolution:wrong-request"}), stages});
  const result = await coordinateResolutionPrompt({
    state: waiting.state,
    stages,
    promptPorts: [createTestPromptAdapter({
      responses: {
        "request:choice": {
          status: PROMPT_PORT_OUTCOMES.RESPONSE,
          requestId: "request:other",
          value: true
        }
      }
    })]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CHOICE_COORDINATOR_CODES.REQUEST_MISMATCH);
  assert.equal(result.state.pendingRequests.length, 1);
});

test("wrong resolution id is rejected before staged resume", async () => {
  const stages = choiceStages({required: true});
  const waiting = runResolutionPipeline({state: createResolutionState({id: "resolution:wrong-resolution"}), stages});
  const result = await coordinateResolutionPrompt({
    state: waiting.state,
    stages,
    promptPorts: [createTestPromptAdapter({
      responses: {
        "request:choice": {
          status: PROMPT_PORT_OUTCOMES.RESPONSE,
          resolutionId: "resolution:other",
          value: true
        }
      }
    })]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CHOICE_COORDINATOR_CODES.REQUEST_MISMATCH);
  assert.equal(result.state.pendingRequests.length, 1);
});

test("wrong expected response type is rejected explicitly", async () => {
  const stages = choiceStages({required: true});
  const waiting = runResolutionPipeline({state: createResolutionState({id: "resolution:wrong-type"}), stages});
  const result = await coordinateResolutionPrompt({
    state: waiting.state,
    stages,
    promptPorts: [createTestPromptAdapter({
      responses: {
        "request:choice": {
          status: PROMPT_PORT_OUTCOMES.RESPONSE,
          responseType: "not-choice-response",
          value: true
        }
      }
    })]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CHOICE_COORDINATOR_CODES.WRONG_RESPONSE_TYPE);
  assert.equal(result.state.pendingRequests.length, 1);
});

test("duplicate already-accepted responses are rejected as stale", async () => {
  const request = createResolutionRequest({
    id: "request:choice",
    resolutionId: "resolution:duplicate",
    stageId: "choice",
    type: RESOLUTION_REQUEST_TYPES.CHOICE,
    expectedResponseType: "choice-response",
    validation: {required: true}
  });
  const state = createResolutionState({
    id: "resolution:duplicate",
    pendingRequests: [request],
    requestResponses: {
      [request.id]: {
        request,
        response: {
          requestId: request.id,
          resolutionId: "resolution:duplicate",
          type: RESOLUTION_REQUEST_TYPES.CHOICE,
          value: true,
          metadata: {}
        }
      }
    }
  });
  const result = await coordinateResolutionPrompt({
    state,
    promptPorts: [createTestPromptAdapter({responses: {"request:choice": false}})]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CHOICE_COORDINATOR_CODES.STALE_REQUEST);
});

test("stale configuration payment responses are revalidated by existing configuration machinery", async () => {
  const stages = configurationStages();
  const waiting = runResolutionPipeline({
    state: configurationState({
      id: "resolution:stale-payment",
      definition: scalableSpellDefinition()
    }),
    stages
  });
  const staleSystem = actorSystem({
    pools: [
      {id: "spell-slot.3", label: "3rd-level Spell Slot", value: 1, max: 1},
      {id: "spell-slot.4", label: "4th-level Spell Slot", value: 1, max: 1},
      {id: "spell-slot.5", label: "5th-level Spell Slot", value: 0, max: 1}
    ]
  });
  const staleState = updateResolutionState(waiting.state, {
    input: {
      ...waiting.state.input,
      actorSystem: staleSystem
    }
  });
  const result = await coordinateResolutionPrompt({
    state: staleState,
    stages,
    promptPorts: [createTestPromptAdapter({
      responses: {
        "request:configuration": {choices: {"casting-resource": {resourceId: "spell-slot.5"}}}
      }
    })]
  });

  assert.equal(result.ok, false);
  assert.equal(result.state.status, RESOLUTION_STATE_STATUS.FAILED);
  assert.equal(result.resume?.code ?? result.code, ACTION_CONFIGURATION_CODES.RESOURCE_UNAVAILABLE);
  assert.equal(result.state.mutationPlans.length, 0);
});

test("several sequential requests in one resolution are coordinated safely", async () => {
  const stages = [
    ...choiceStages({requestId: "request:first", required: true, resultKey: "first", stageId: "first"}).slice(0, 1),
    ...choiceStages({requestId: "request:second", required: true, resultKey: "second", stageId: "second"}).slice(0, 1),
    createResolutionPipelineStage({
      id: "done",
      run(state) {
        return completeResolutionStage({state});
      }
    })
  ];
  const waiting = runResolutionPipeline({state: createResolutionState({id: "resolution:sequential"}), stages});
  const coordinator = createChoiceCoordinator({
    promptPorts: [createTestPromptAdapter({
      responses: {
        "request:first": "alpha",
        "request:second": "beta"
      }
    })],
    stages
  });
  const first = await coordinator.coordinate({state: waiting.state});
  const second = await coordinator.coordinate({state: first.state});

  assert.equal(first.state.status, RESOLUTION_STATE_STATUS.AWAITING_CHOICE);
  assert.equal(first.state.pendingRequests[0].id, "request:second");
  assert.equal(second.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.equal(second.state.results.first, "alpha");
  assert.equal(second.state.results.second, "beta");
});

test("concurrent resolution request identities do not collide", async () => {
  const stages = choiceStages({requestId: "request:same", required: true});
  const firstWaiting = runResolutionPipeline({state: createResolutionState({id: "resolution:first"}), stages});
  const secondWaiting = runResolutionPipeline({state: createResolutionState({id: "resolution:second"}), stages});
  const coordinator = createChoiceCoordinator({
    queuePrompts: false,
    promptPorts: [createTestPromptAdapter({
      responses: {
        "resolution:first:request:same": "first-value",
        "resolution:second:request:same": "second-value"
      }
    })],
    stages
  });
  const [first, second] = await Promise.all([
    coordinator.coordinate({state: firstWaiting.state}),
    coordinator.coordinate({state: secondWaiting.state})
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.state.id, "resolution:first");
  assert.equal(second.state.id, "resolution:second");
  assert.equal(first.state.results.choice, "first-value");
  assert.equal(second.state.results.choice, "second-value");
});

test("PromptPort failures produce structured outcomes without clearing pending requests", async () => {
  const stages = choiceStages({required: true});
  const waiting = runResolutionPipeline({state: createResolutionState({id: "resolution:failure"}), stages});
  const result = await coordinateResolutionPrompt({
    state: waiting.state,
    stages,
    promptPorts: [createTestPromptAdapter({
      responses: {
        "request:choice": {
          ok: false,
          status: PROMPT_PORT_OUTCOMES.FAILURE,
          code: "TEST_PROMPT_FAILURE",
          reason: "Prompt failed."
        }
      }
    })]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "TEST_PROMPT_FAILURE");
  assert.equal(result.state.status, RESOLUTION_STATE_STATUS.AWAITING_CHOICE);
  assert.equal(result.state.pendingRequests.length, 1);
});

test("prompt interaction does not mutate actor resources or produce mutation plans", async () => {
  const system = actorSystem();
  const before = structuredClone(system);
  const stages = configurationStages();
  const waiting = runResolutionPipeline({
    state: configurationState({
      id: "resolution:no-mutation",
      definition: scalableSpellDefinition(),
      system
    }),
    stages
  });
  const result = await coordinateResolutionPrompt({
    state: waiting.state,
    stages,
    promptPorts: [createTestPromptAdapter({
      responses: {
        "request:configuration": {choices: {"casting-resource": {resourceId: "spell-slot.4"}}}
      }
    })]
  });

  assert.equal(result.ok, true);
  assert.deepEqual(system, before);
  assert.deepEqual(result.state.mutationPlans, []);
});

test("non-serializable prompt response values are rejected before ResolutionState storage", async () => {
  const stages = choiceStages({required: true});
  const waiting = runResolutionPipeline({state: createResolutionState({id: "resolution:bad-data"}), stages});
  class ApplicationLike {}
  const badPort = {
    id: "bad-port",
    request: async request => ({
      ok: true,
      status: PROMPT_PORT_OUTCOMES.RESPONSE,
      code: CHOICE_COORDINATOR_CODES.OK,
      requestId: request.id,
      resolutionId: request.resolutionId,
      type: request.type,
      responseType: request.expectedResponseType,
      value: {application: new ApplicationLike()}
    })
  };
  const result = await coordinateResolutionPrompt({
    state: waiting.state,
    stages,
    promptPorts: [badPort]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CHOICE_COORDINATOR_CODES.NON_SERIALIZABLE_PROMPT_DATA);
  assert.equal(result.state.pendingRequests.length, 1);
  assert.equal(validateResolutionStateSerializable(result.state).ok, true);
});

test("remote-authority requests are not shown on the wrong local client", async () => {
  const request = createResolutionRequest({
    id: "request:gm",
    resolutionId: "resolution:remote",
    stageId: "choice",
    type: RESOLUTION_REQUEST_TYPES.CHOICE,
    expectedResponseType: "choice-response",
    authority: {kind: "gm"},
    validation: {required: true}
  });
  const state = createResolutionState({
    id: "resolution:remote",
    pendingRequests: [request]
  });
  const result = await coordinateResolutionPrompt({
    state,
    context: {isGM: false},
    promptPorts: [createTestPromptAdapter({responses: {"request:gm": true}})]
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, PROMPT_PORT_OUTCOMES.UNHANDLED);
  assert.equal(result.code, CHOICE_COORDINATOR_CODES.REMOTE_AUTHORITY_REQUIRED);
  assert.equal(result.state.pendingRequests.length, 1);
});

test("FoundryV14PromptAdapter uses DialogV2.input and returns plain action-configuration data", async () => {
  const stages = configurationStages();
  const waiting = runResolutionPipeline({
    state: configurationState({
      id: "resolution:foundry-adapter",
      definition: multiChoiceDefinition()
    }),
    stages
  });
  const calls = [];
  const DialogV2 = {
    async input(config) {
      calls.push(config);
      return {
        "choice:modes": ["careful", "silent"],
        "choice:intensity": "2"
      };
    }
  };
  const adapter = createFoundryV14PromptAdapter({DialogV2});
  const result = await adapter.request(waiting.state.pendingRequests[0], {currentUserId: "user-a"});

  assert.equal(calls.length, 1);
  assert.match(calls[0].content, /wildpath-prompt/);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    choices: {
      modes: {values: ["careful", "silent"]},
      intensity: 2
    }
  });
  assert.equal(validateResolutionStateSerializable(createResolutionState({
    id: "resolution:foundry-form",
    responses: [{
      requestId: waiting.state.pendingRequests[0].id,
      resolutionId: waiting.state.id,
      type: RESOLUTION_REQUEST_TYPES.ACTION_CONFIGURATION,
      value: result.value,
      metadata: {}
    }]
  })).ok, true);
});

test("FoundryV14PromptAdapter returns unhandled for non-local authority metadata", async () => {
  const request = createResolutionRequest({
    id: "request:remote-source",
    resolutionId: "resolution:remote-source",
    stageId: "choice",
    type: RESOLUTION_REQUEST_TYPES.CHOICE,
    expectedResponseType: "choice-response",
    authority: {kind: "source-controller"},
    validation: {required: true}
  });
  let opened = false;
  const DialogV2 = {
    async input() {
      opened = true;
      return {value: "bad"};
    }
  };
  const adapter = createFoundryV14PromptAdapter({DialogV2});
  const result = await adapter.request(request, {
    remoteAuthorityKinds: ["source-controller"]
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, PROMPT_PORT_OUTCOMES.UNHANDLED);
  assert.equal(result.code, CHOICE_COORDINATOR_CODES.REMOTE_AUTHORITY_REQUIRED);
  assert.equal(opened, false);
});

test("generic target selection can be rendered as a list prompt without targeting rules in the adapter", async () => {
  const request = createResolutionRequest({
    id: "request:targets",
    resolutionId: "resolution:targets",
    stageId: "targeting",
    type: RESOLUTION_REQUEST_TYPES.TARGET_SELECTION,
    expectedResponseType: "target-selection",
    validation: {required: true},
    payload: {
      candidates: [
        {id: "orc", target: target("orc"), eligible: true},
        {id: "goblin", target: target("goblin"), eligible: true}
      ]
    }
  });
  const viewModel = createPromptViewModel(request);
  const DialogV2 = {
    async input() {
      return {targetIds: ["orc"]};
    }
  };
  const adapter = createFoundryV14PromptAdapter({DialogV2});
  const result = await adapter.request(request, {});

  assert.equal(viewModel.controls[0].type, PROMPT_CONTROL_TYPES.TARGET_LIST);
  assert.deepEqual(viewModel.controls[0].options.map(option => option.id), ["orc", "goblin"]);
  assert.deepEqual(result.value.targetIds, ["orc"]);
  assert.deepEqual(result.value.targets, [target("orc")]);
});
