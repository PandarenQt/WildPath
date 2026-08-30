import {test} from "node:test";
import assert from "node:assert/strict";
import {
  RESOLUTION_PIPELINE_CODES,
  RESOLUTION_REQUEST_TYPES,
  RESOLUTION_STAGE_RESULT,
  RESOLUTION_STATE_STATUS,
  cancelResolutionState,
  completeResolutionStage,
  continueResolutionStage,
  createChildResolutionState,
  createResolutionPipelineStage,
  createResolutionRequest,
  createResolutionState,
  getResolutionResponse,
  resumeResolutionPipeline,
  runResolutionPipeline,
  updateResolutionState,
  validateResolutionStateSerializable,
  waitResolutionStage
} from "../module/helpers/resolution-state.mjs";

function baseState() {
  return createResolutionState({
    id: "resolution:alpha",
    actionDefinition: {
      id: "action:strike",
      label: "Strike",
      damage: []
    },
    actionContext: {
      id: "context:alpha",
      source: {actorId: "actor-a"},
      targets: []
    },
    source: {actorId: "actor-a"},
    input: {
      actorSystem: {
        resources: {
          action: {value: 1, max: 1}
        }
      }
    }
  });
}

test("ResolutionState is explicit, serializable, and does not contain runtime stage functions", () => {
  const state = createResolutionState({
    ...baseState(),
    configuration: {
      id: "configuration:strike",
      effectiveDefinition: {id: "action:strike"}
    },
    targets: [{id: "orc", actorId: "actor-orc"}],
    metadata: {source: "unit-test"}
  });
  const serialized = JSON.parse(JSON.stringify(state));
  const validation = validateResolutionStateSerializable(state);

  assert.equal(state.status, RESOLUTION_STATE_STATUS.CREATED);
  assert.equal(validation.ok, true);
  assert.equal(serialized.id, "resolution:alpha");
  assert.equal(serialized.configuration.id, "configuration:strike");
  assert.equal(Object.values(serialized).some(value => typeof value === "function"), false);
});

test("ResolutionPipeline runs identifiable stages in order and records trace", () => {
  const order = [];
  const stages = [
    createResolutionPipelineStage({
      id: "availability",
      run(state) {
        order.push("availability");
        return continueResolutionStage({
          state: updateResolutionState(state, {
            results: {
              ...state.results,
              availability: {ok: true}
            }
          }),
          data: {available: true}
        });
      }
    }),
    createResolutionPipelineStage({
      id: "finalization",
      run(state) {
        order.push("finalization");
        return completeResolutionStage({
          state,
          data: {done: true}
        });
      }
    })
  ];

  const result = runResolutionPipeline({state: baseState(), stages});

  assert.equal(result.ok, true);
  assert.equal(result.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.deepEqual(order, ["availability", "finalization"]);
  assert.deepEqual(result.state.completedStageIds, ["availability", "finalization"]);
  assert.deepEqual(result.state.trace.map(entry => entry.stageId), ["availability", "finalization"]);
  assert.equal(result.state.trace[0].result, RESOLUTION_STAGE_RESULT.CONTINUE);
});

test("ResolutionPipeline waits for typed requests and resumes with correlated responses", () => {
  const stages = [
    createResolutionPipelineStage({
      id: "attack-roll",
      run(state) {
        const accepted = getResolutionResponse(state, {
          requestId: "request:attack-roll",
          type: RESOLUTION_REQUEST_TYPES.ROLL
        });
        if ( !accepted ) return waitResolutionStage({
          request: createResolutionRequest({
            id: "request:attack-roll",
            resolutionId: state.id,
            stageId: "attack-roll",
            type: RESOLUTION_REQUEST_TYPES.ROLL,
            expectedResponseType: "attack-roll",
            payload: {
              formula: "d20 + 5",
              rollMode: "manual-or-digital"
            }
          })
        });

        return continueResolutionStage({
          state: updateResolutionState(state, {
            rollResults: [
              ...state.rollResults,
              {
                requestId: accepted.request.id,
                total: accepted.response.value.total,
                die: accepted.response.value.die
              }
            ]
          })
        });
      }
    })
  ];

  const waiting = runResolutionPipeline({state: baseState(), stages});
  const resumed = resumeResolutionPipeline({
    state: waiting.state,
    stages,
    response: {
      resolutionId: "resolution:alpha",
      requestId: "request:attack-roll",
      type: RESOLUTION_REQUEST_TYPES.ROLL,
      value: {total: 18, die: 13}
    }
  });

  assert.equal(waiting.code, RESOLUTION_PIPELINE_CODES.WAITING);
  assert.equal(waiting.state.status, RESOLUTION_STATE_STATUS.AWAITING_ROLL);
  assert.equal(waiting.state.pendingRequests[0].expectedResponseType, "attack-roll");
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state.status, RESOLUTION_STATE_STATUS.COMPLETED);
  assert.deepEqual(resumed.state.rollResults, [{requestId: "request:attack-roll", total: 18, die: 13}]);
});

test("ResolutionPipeline rejects stale or mismatched responses without clearing the pending request", () => {
  const stages = [
    createResolutionPipelineStage({
      id: "attack-roll",
      run(state) {
        return waitResolutionStage({
          request: createResolutionRequest({
            id: "request:attack-roll",
            resolutionId: state.id,
            stageId: "attack-roll",
            type: RESOLUTION_REQUEST_TYPES.ROLL
          })
        });
      }
    })
  ];
  const waiting = runResolutionPipeline({state: baseState(), stages});
  const rejected = resumeResolutionPipeline({
    state: waiting.state,
    stages,
    response: {
      resolutionId: "resolution:other",
      requestId: "request:attack-roll",
      type: RESOLUTION_REQUEST_TYPES.ROLL,
      value: {total: 20}
    }
  });

  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, RESOLUTION_PIPELINE_CODES.REQUEST_MISMATCH);
  assert.equal(rejected.state.status, RESOLUTION_STATE_STATUS.AWAITING_ROLL);
  assert.equal(rejected.state.pendingRequests.length, 1);
});

test("ResolutionPipeline does not rerun completed stages when a waiting stage resumes", () => {
  let availabilityRuns = 0;
  const stages = [
    createResolutionPipelineStage({
      id: "availability",
      run(state) {
        availabilityRuns += 1;
        return continueResolutionStage({state});
      }
    }),
    createResolutionPipelineStage({
      id: "choice",
      run(state) {
        const response = getResolutionResponse(state, {
          requestId: "request:choice",
          type: RESOLUTION_REQUEST_TYPES.CHOICE
        });
        if ( !response ) return waitResolutionStage({
          request: createResolutionRequest({
            id: "request:choice",
            resolutionId: state.id,
            stageId: "choice",
            type: RESOLUTION_REQUEST_TYPES.CHOICE
          })
        });
        return continueResolutionStage({state});
      }
    })
  ];
  const waiting = runResolutionPipeline({state: baseState(), stages});
  const resumed = resumeResolutionPipeline({
    state: waiting.state,
    stages,
    response: {
      resolutionId: "resolution:alpha",
      requestId: "request:choice",
      type: RESOLUTION_REQUEST_TYPES.CHOICE,
      value: true
    }
  });

  assert.equal(resumed.ok, true);
  assert.equal(availabilityRuns, 1);
  assert.deepEqual(resumed.state.completedStageIds, ["availability", "choice"]);
});

test("Cancellation before commit keeps irreversible stages from running", () => {
  let commitRuns = 0;
  const stages = [
    createResolutionPipelineStage({
      id: "targeting",
      run(state) {
        return waitResolutionStage({
          request: createResolutionRequest({
            id: "request:target",
            resolutionId: state.id,
            stageId: "targeting",
            type: RESOLUTION_REQUEST_TYPES.TARGET_SELECTION
          })
        });
      }
    }),
    createResolutionPipelineStage({
      id: "commit",
      run(state) {
        commitRuns += 1;
        return completeResolutionStage({state});
      }
    })
  ];
  const waiting = runResolutionPipeline({state: baseState(), stages});
  const cancelled = cancelResolutionState(waiting.state, {
    stageId: "targeting",
    reason: "user cancelled target selection"
  });
  const rerun = runResolutionPipeline({state: cancelled, stages});

  assert.equal(rerun.state.status, RESOLUTION_STATE_STATUS.CANCELLED);
  assert.equal(commitRuns, 0);
});

test("Child ResolutionState retains parent provenance and ancestry", () => {
  const parent = createResolutionState({
    ...baseState(),
    triggerIdentities: ["trigger:declared"]
  });
  const child = createChildResolutionState(parent, {
    id: "resolution:reaction",
    relationship: "reaction",
    sourceEvent: {id: "event:hit", type: "AttackHit"},
    triggerIdentity: "trigger:shield",
    actionDefinition: {id: "action:reaction-defense"},
    input: {window: "after-hit"}
  });

  assert.equal(child.ok, true);
  assert.equal(child.state.parentId, "resolution:alpha");
  assert.equal(child.state.relationship, "reaction");
  assert.equal(child.state.depth, 1);
  assert.equal(child.state.ancestry[0].id, "resolution:alpha");
  assert.deepEqual(child.state.triggerIdentities, ["trigger:declared", "trigger:shield"]);
  assert.equal(child.state.metadata.parentResolutionId, "resolution:alpha");
});

test("Child ResolutionState enforces depth limits and repeated trigger protection", () => {
  const maxed = createResolutionState({
    ...baseState(),
    depth: 2,
    maxDepth: 2
  });
  const depthResult = createChildResolutionState(maxed, {
    id: "resolution:too-deep",
    triggerIdentity: "trigger:new"
  });
  const repeated = createChildResolutionState(createResolutionState({
    ...baseState(),
    triggerIdentities: ["trigger:loop"]
  }), {
    id: "resolution:loop",
    triggerIdentity: "trigger:loop"
  });

  assert.equal(depthResult.ok, false);
  assert.equal(depthResult.code, RESOLUTION_PIPELINE_CODES.DEPTH_LIMIT_EXCEEDED);
  assert.equal(repeated.ok, false);
  assert.equal(repeated.code, RESOLUTION_PIPELINE_CODES.REPEATED_TRIGGER);
});

test("ResolutionState rejects non-serializable runtime data", () => {
  const state = baseState();
  const validation = validateResolutionStateSerializable({
    ...state,
    metadata: {
      callback() {}
    }
  });

  assert.equal(validation.ok, false);
  assert.equal(validation.path, "state.metadata.callback");
  assert.throws(() => createResolutionState({
    ...state,
    metadata: {
      callback() {}
    }
  }), /JSON-serializable/);
});
