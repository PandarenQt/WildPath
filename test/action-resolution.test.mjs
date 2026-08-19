import {test} from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_RESOLUTION_STAGES,
  ACTION_RESULT_CODES,
  ACTION_RESULT_STATUS,
  addResolutionStep,
  beginActionResult,
  cancelActionResult,
  createActionContext,
  createActionLifecycleEvent,
  createActionResolutionTrace,
  failActionResult,
  succeedActionResult,
  validateActionContext,
  withActionEvents,
  withActionTargets
} from "../module/helpers/action-resolution.mjs";
import {
  AUTOMATION_EVENT_PHASES,
  AUTOMATION_EVENT_TYPES
} from "../module/helpers/automation-events.mjs";

function contextData() {
  return {
    id: "ctx-1",
    action: {
      id: "strike",
      name: "Strike",
      tags: ["weapon-attack"],
      system: {cost: {action: 1}}
    },
    source: {actorId: "actor-a", tokenId: "token-a"},
    targets: [{id: "target-1", actorId: "actor-b", tokenId: "token-b"}],
    resources: [{id: "economy.action", current: 1, maximum: 1}],
    policies: {allowActionForSpentBonusAction: true},
    metadata: {origin: "test"}
  };
}

test("action context normalizes references and clones mutable inputs", () => {
  const data = contextData();
  const context = createActionContext(data);

  data.action.name = "Changed";
  data.targets[0].actorId = "changed";
  data.resources[0].current = 0;

  assert.equal(context.id, "ctx-1");
  assert.equal(context.action.id, "strike");
  assert.equal(context.action.name, "Strike");
  assert.deepEqual(context.action.tags, ["weapon-attack"]);
  assert.equal(context.source.actorId, "actor-a");
  assert.equal(context.targets[0].actorId, "actor-b");
  assert.equal(context.resources[0].current, 1);
  assert.equal(context.policies.allowActionForSpentBonusAction, true);
});

test("context validation reports missing action and source explicitly", () => {
  const validation = validateActionContext(createActionContext({}));

  assert.equal(validation.ok, false);
  assert.deepEqual(validation.errors.map(error => error.code), [
    ACTION_RESULT_CODES.MISSING_ACTION,
    ACTION_RESULT_CODES.MISSING_SOURCE
  ]);
});

test("beginning an action emits a declaration event and validation step", () => {
  const result = beginActionResult(createActionContext(contextData()));

  assert.equal(result.status, ACTION_RESULT_STATUS.PENDING);
  assert.equal(result.events[0].type, AUTOMATION_EVENT_TYPES.ACTION_DECLARED);
  assert.equal(result.events[0].phase, AUTOMATION_EVENT_PHASES.BEFORE);
  assert.equal(result.steps[0].stage, ACTION_RESOLUTION_STAGES.VALIDATION);
  assert.equal(result.errors.length, 0);
});

test("failed validation creates a failed result with no implicit commit", () => {
  const result = beginActionResult(createActionContext({action: {id: "strike"}}));

  assert.equal(result.status, ACTION_RESULT_STATUS.FAILED);
  assert.equal(result.code, ACTION_RESULT_CODES.MISSING_SOURCE);
  assert.equal(result.ok, false);
  assert.equal(result.steps[0].stage, ACTION_RESOLUTION_STAGES.VALIDATION);
});

test("resolution steps append events, consequences, and mutation plans immutably", () => {
  const started = beginActionResult(createActionContext(contextData()));
  const event = createActionLifecycleEvent(started.context, {
    type: AUTOMATION_EVENT_TYPES.TARGETS_SELECTED,
    tags: ["single-target"],
    data: {targets: ["target-1"]}
  });
  const next = addResolutionStep(started, {
    stage: ACTION_RESOLUTION_STAGES.TARGETING,
    events: [event],
    consequences: [{type: "targeted", targetId: "target-1"}],
    mutationPlans: [{type: "resource", resourceId: "economy.action", amount: 1}]
  });

  assert.equal(started.events.length, 1);
  assert.equal(next.events.length, 2);
  assert.equal(next.events[1].type, AUTOMATION_EVENT_TYPES.TARGETS_SELECTED);
  assert.equal(next.consequences[0].targetId, "target-1");
  assert.equal(next.mutationPlans[0].resourceId, "economy.action");
});

test("failed and cancelled results cannot be accidentally marked succeeded", () => {
  const started = beginActionResult(createActionContext(contextData()));
  const failed = failActionResult(started, {
    stage: ACTION_RESOLUTION_STAGES.RESOURCE_PAYMENT,
    reason: "resource missing"
  });
  const cancelled = cancelActionResult(started, {
    stage: ACTION_RESOLUTION_STAGES.TARGETING,
    reason: "player cancelled target selection"
  });

  assert.equal(succeedActionResult(failed).status, ACTION_RESULT_STATUS.FAILED);
  assert.equal(succeedActionResult(cancelled).status, ACTION_RESULT_STATUS.CANCELLED);
});

test("successful results expose a compact audit trace", () => {
  const started = beginActionResult(createActionContext(contextData()));
  const success = succeedActionResult(started, {
    consequences: [{type: "spent", resourceId: "economy.action"}],
    mutationPlans: [{path: "system.resources.action.value", value: 0}]
  });
  const trace = createActionResolutionTrace(success);

  assert.equal(success.ok, true);
  assert.equal(trace.status, ACTION_RESULT_STATUS.SUCCEEDED);
  assert.equal(trace.actionId, "strike");
  assert.equal(trace.sourceActorId, "actor-a");
  assert.deepEqual(trace.targetIds, ["target-1"]);
  assert.equal(trace.consequenceCount, 1);
  assert.equal(trace.mutationPlanCount, 1);
  assert.deepEqual(trace.eventTypes, [AUTOMATION_EVENT_TYPES.ACTION_DECLARED]);
});

test("context helpers replace targets and append events without mutating the source context", () => {
  const context = createActionContext(contextData());
  const event = createActionLifecycleEvent(context, {type: AUTOMATION_EVENT_TYPES.ACTION_VALIDATED});
  const withEvent = withActionEvents(context, [event]);
  const withTargets = withActionTargets(context, [{id: "new-target", actorId: "actor-c"}]);

  assert.equal(context.events.length, 0);
  assert.equal(withEvent.events.length, 1);
  assert.equal(context.targets[0].id, "target-1");
  assert.equal(withTargets.targets[0].id, "new-target");
});
