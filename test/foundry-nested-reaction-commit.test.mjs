import {test} from "node:test";
import assert from "node:assert/strict";
import {createFoundryV14DocumentPersistenceAdapter} from "../module/adapters/foundry-v14-persistence-adapter.mjs";
import {foundryActorSystemSnapshot} from "../module/adapters/foundry-v14-actor-system-adapter.mjs";
import {createTestResolutionTransportHub} from "../module/adapters/test-resolution-transport.mjs";
import {createBuiltinEconomyResource} from "../module/helpers/action-economy.mjs";
import {createAutomationEvent, createReactionTrigger} from "../module/helpers/automation-events.mjs";
import {createResolutionSocketEnvelope, isPlainSerializableData} from "../module/helpers/multiplayer-authority.mjs";
import {cancelResolutionState, validateResolutionStateSerializable} from "../module/helpers/resolution-state.mjs";
import {summarizeNestedChildOutcome} from "../module/helpers/nested-child-outcome.mjs";
import {createMultiplayerActionCoordinator} from "../module/resolvers/multiplayer-action-coordinator.mjs";
import {createActionReactionChildState, executeStagedActionResolution, planStagedActionResolution} from "../module/resolvers/action-pipeline-resolver.mjs";
import {commitConditionEffectMutationPlan, rollbackConditionEffectMutationPlan} from "../module/resolvers/condition-effect-commit-resolver.mjs";
import {foundryDocumentFixture, installedStatusRegistry, startupStatusEffects} from "./fixtures/foundry-document-persistence.mjs";

const actionDefinition = {schemaVersion: 1, id: "action:qa-reaction", label: "QA reaction Action",
  costs: {allOf: [{capability: "reaction", amount: 1}]}, targeting: {type: "self", required: true},
  effects: [{id: "qa-effect", type: "condition", conditionId: "prone", metadata: {source: "nested-commit-qa"}}]};
const action = {id: actionDefinition.id, type: "action", system: {definition: actionDefinition}};
const persistence = createFoundryV14DocumentPersistenceAdapter({documentResolver() {
  throw new Error("Runtime documents must be supplied; never re-resolve the world Actor");
}});
const gm = {id: "gm", active: true, isGM: true, isActiveGM: true};
const player = {id: "player", active: true, isGM: false};

async function fixture(options={}) {
  return foundryDocumentFixture({statusEffects: await startupStatusEffects(), ...options});
}

function source(actor) { return {actorId: actor.id, actorRef: actor.uuid, tokenId: actor.token.id}; }
function targetActors(actor) { return {[actor.id]: actor, [actor.uuid]: actor}; }
function plan(actor, definition=actionDefinition) {
  return planStagedActionResolution({actorSystem: foundryActorSystemSnapshot(actor),
    action: {...action, system: {definition}}, source: source(actor)});
}
function transaction(state) {
  return state.results.actionResult.steps.map(step => step.data?.transaction).filter(Boolean).at(-1);
}

async function nested(f, {failurePolicy="continue", cancelChild=false}={}) {
  const {actor} = f;
  const hub = createTestResolutionTransportHub({users: [gm, player]});
  const coordinator = createMultiplayerActionCoordinator({userId: gm.id, users: () => hub.userDirectory(),
    activeGMUserId: gm.id, transport: hub.createEndpoint({userId: gm.id})});
  coordinator.register();
  const playerTransport = hub.createEndpoint({userId: player.id});
  const event = createAutomationEvent({id: "qa-transition", type: "movement.transition", source: source(actor),
    data: {transitionIndex: 0}});
  const services = {targetActors: targetActors(actor), reactions: {failurePolicy,
    triggers: [createReactionTrigger({id: "qa-trigger", event: event.type, actorId: actor.id,
      tokenId: actor.token.id, action: actionDefinition, actionId: actionDefinition.id,
      chooser: {kind: "specific", userId: player.id}})],
    actorSystemsByActor: {[actor.id]: foundryActorSystemSnapshot(actor)},
    resourcesByActor: {[actor.id]: [createBuiltinEconomyResource("economy.reaction", {current: 1, maximum: 1})]}}};
  if ( cancelChild ) services.reactions.createChildState = context => cancelResolutionState(
    createActionReactionChildState({...context, services: {reactions: {actorSystemsByActor: services.reactions.actorSystemsByActor}}}),
    {stageId: "action.configuration", code: "QA_CANCELLED", reason: "Child cancelled by GM"});
  await coordinator.resolveTriggeredEvent({event, services, options: {persistencePort: persistence}});
  const request = hub.messages.find(message => message.messageType === "PENDING_REQUEST").payload.request;
  assert.equal(f.calls.length, 0, "Discovery and planning must not persist anything");
  await playerTransport.send(createResolutionSocketEnvelope({messageType: "REQUEST_RESPONSE",
    senderUserId: player.id, recipientUserId: gm.id, resolutionId: request.resolutionId, requestId: request.id,
    payload: {response: {resolutionId: request.resolutionId, requestId: request.id, type: "reaction-choice",
      value: {decision: "use", candidateId: request.payload.options[0].id}}}}));
  const record = coordinator.records.get(request.resolutionId);
  assert.equal(record.state.actionDefinition, null, "The root is a TriggeredEventHost");
  assert.equal(record.knownResolutionIds.size, 2, "A real nested Action was registered");
  assert.equal(record.state.metadata.activeChildResolution, undefined);
  assert.equal(validateResolutionStateSerializable(record.state).ok, true);
  assert.equal(hub.messages.every(isPlainSerializableData), true);
  return {record, hub};
}

test("production-shaped reaction payment commits the full resource schema on token.actor", async () => {
  const f = await fixture();
  const planned = plan(f.actor, {...actionDefinition, effects: []});
  assert.equal(planned.state.status, "ready-to-commit");
  const result = await executeStagedActionResolution({state: planned.state, actor: f.token.actor,
    targetActors: targetActors(f.actor), authority: true, persistencePort: persistence});
  assert.equal(result.ok, true, JSON.stringify(result.state.errors));
  assert.notEqual(f.token.actor, f.token.baseActor);
  assert.deepEqual(f.actor.system.resources.reaction, {base: 1, bonus: 0, max: 1, value: 0, recovery: "turn"});
  assert.equal(f.world.system.resources.reaction.value, 1);
  assert.deepEqual(f.calls.map(call => call.method), ["Actor.update"]);
  assert.equal(f.calls[0].actor, f.token.actor);
});

test("production-shaped condition creation persists metadata and the target operation succeeds", async () => {
  const f = await fixture();
  const planned = plan(f.actor, {...actionDefinition, costs: {}});
  assert.equal(planned.state.status, "ready-to-commit");
  const result = await executeStagedActionResolution({state: planned.state, actor: f.actor,
    targetActors: targetActors(f.actor), authority: true, persistencePort: persistence});
  assert.equal(result.ok, true, JSON.stringify(summarizeNestedChildOutcome(result.state)));
  assert.equal([...f.actor.effects][0].flags.wildpath.conditionEffect.metadata.source, "nested-commit-qa");
  assert.equal(transaction(result.state).committed[0].type, "conditionEffect");
  assert.equal(f.actor.system.resources.reaction.value, 1);
});

test("production-shaped combined nested child commits condition then payment with synthetic isolation", async () => {
  const f = await fixture();
  const {record} = await nested(f);
  assert.equal(record.state.results.reactions[0].childStatus, "completed",
    JSON.stringify(record.state.results.reactions[0].childOutcome));
  assert.equal(f.actor.system.resources.reaction.value, 0);
  assert.equal(f.actor.effects.size, 1);
  assert.equal([...f.actor.effects][0].flags.wildpath.conditionEffect.metadata.source, "nested-commit-qa");
  assert.equal(f.world.system.resources.reaction.value, 1);
  assert.equal(f.world.effects.size, 0);
  assert.deepEqual(f.calls.map(call => call.method), ["Actor.toggleStatusEffect", "Actor.createEmbeddedDocuments",
    "ActiveEffect.update", "Actor.update"]);
  assert.equal(f.calls.every(call => call.actor === f.token.actor), true);
});

for ( const failurePolicy of ["continue", "cancel-parent"] ) test(`failed nested source payment retains rollback provenance under ${failurePolicy}`, async () => {
  const f = await fixture({failPayment: true});
  const {record} = await nested(f, {failurePolicy});
  const reaction = record.state.results.reactions[0];
  assert.equal(reaction.childStatus, "failed");
  const outcome = reaction.childOutcome;
  assert.equal(outcome.failedStageId, "action.commit");
  assert.equal(outcome.code, "RESOURCE_COMMIT_FAILED");
  assert.equal(outcome.reason, "Synthetic reaction payment rejected");
  assert.equal(outcome.transaction.code, "COMMIT_FAILED");
  assert.equal(outcome.transaction.commitFailure.operation.id, "source:0:resourcePayment");
  assert.equal(outcome.transaction.commitFailure.operation.type, "resourcePayment");
  assert.equal(outcome.transaction.commitFailure.operation.actorRef, f.actor.uuid);
  assert.equal(outcome.transaction.commitFailure.operation.metadata.role, "sourcePayment");
  assert.equal(outcome.transaction.rolledBack, true);
  assert.equal(outcome.transaction.committed[0].type, "conditionEffect");
  assert.equal(outcome.transaction.rollbacks[0].status, "rolledBack");
  assert.equal(record.state.status, failurePolicy === "continue" ? "completed" : "cancelled");
  assert.equal(f.actor.effects.size, 0);
  assert.equal(f.actor.system.resources.reaction.value, 1);
  assert.equal(f.world.effects.size, 0);
  assert.equal(f.world.system.resources.reaction.value, 1);
  assert.equal(f.calls.at(-1).method, "ActiveEffect.delete");
});

test("nested child preserves both the original payment failure and a failed rollback", async () => {
  const f = await fixture({failPayment: true, failRollback: true});
  const {record} = await nested(f);
  const tx = record.state.results.reactions[0].childOutcome.transaction;
  assert.equal(tx.code, "ROLLBACK_FAILED");
  assert.equal(tx.commitFailure.reason, "Synthetic reaction payment rejected");
  assert.equal(tx.rolledBack, false);
  assert.equal(tx.failures[1].code, "ROLLBACK_FAILED");
  assert.equal(tx.failures[1].operation.type, "conditionEffect");
  assert.equal(tx.rollbacks[0].status, "rollbackFailed");
  assert.equal(f.actor.system.resources.reaction.value, 1);
  assert.equal(f.actor.effects.size, 1, "Failed rollback must remain visible, never reported as successful");
});

test("condition persistence fallback uses embedded create and document delete returns", async () => {
  const f = await fixture();
  f.actor.toggleStatusEffect = undefined;
  const mutation = plan(f.actor).state.mutationPlans.find(plan => plan.type === "conditionEffect");
  const commit = await commitConditionEffectMutationPlan(f.actor, mutation, {persistencePort: persistence});
  assert.equal(commit.ok, true);
  assert.equal(f.actor.effects.size, 1);
  assert.equal(await rollbackConditionEffectMutationPlan(f.actor, mutation, null, commit, {persistencePort: persistence}), true);
  assert.equal(f.actor.effects.size, 0);
  assert.deepEqual(f.calls.map(call => call.method), ["Actor.createEmbeddedDocuments", "ActiveEffect.delete"]);
});

test("nested cancelled child keeps its reason when folded into an informational host", async () => {
  const f = await fixture();
  const {record} = await nested(f, {cancelChild: true});
  const outcome = record.state.results.reactions[0].childOutcome;
  assert.equal(outcome.childStatus, "cancelled");
  assert.equal(outcome.code, "QA_CANCELLED");
  assert.equal(outcome.reason, "Child cancelled by GM");
  assert.equal(outcome.failedStageId, "action.configuration");
  assert.equal(f.calls.length, 0);
});

test("commit preflight failure retains TargetCandidate identity and original failure details", async () => {
  const f = await fixture();
  const planned = plan(f.actor);
  const target = planned.state.mutationPlans.find(plan => plan.type === "conditionEffect").target;
  assert.equal(target.id, f.token.id);
  assert.equal(target.target.actorId, f.actor.id);
  const result = await executeStagedActionResolution({state: planned.state, actor: f.actor,
    targetActors: {}, authority: true, persistencePort: persistence});
  const summary = summarizeNestedChildOutcome(result.state);
  assert.equal(summary.targetOperations.code, "TARGET_ACTOR_NOT_FOUND");
  assert.equal(summary.targetOperations.failures[0].mutationPlan.type, "conditionEffect");
  assert.ok(summary.targetOperations.failures[0].targetRefs.includes(f.actor.id));
  assert.equal(summary.reason, "No target Actor supplied for mutation plan.");
  assert.equal(summary.transaction, null, "Preflight failure never entered the transaction");
  assert.equal(f.calls.length, 0);
});

const installedApp = process.env.FOUNDRY_V14_APP_PATH;
test("installed V14 Actor method rejects the legacy array registry with exact nested target provenance",
  {skip: !installedApp}, async () => {
    const registry = await startupStatusEffects();
    const f = await fixture({installedApp, statusEffects: Object.values(registry)});
    assert.equal(plan(f.actor).state.status, "ready-to-commit");
    const {record} = await nested(f);
    const outcome = record.state.results.reactions[0].childOutcome;
    assert.equal(outcome.failedStageId, "action.commit");
    assert.equal(outcome.transaction.commitFailure.operation.id, "target:0:conditionEffect");
    assert.equal(outcome.transaction.commitFailure.operation.metadata.role, "targetMutation");
    assert.equal(outcome.reason, 'Invalid status ID "prone" provided to Actor#toggleStatusEffect');
    assert.equal(outcome.transaction.code, "COMMIT_FAILED");
    assert.equal(outcome.transaction.committed.length, 0);
    assert.equal(f.actor.system.resources.reaction.value, 1);
    assert.equal(f.actor.effects.size, 0);
    assert.deepEqual(f.calls.map(call => call.method), ["Actor.toggleStatusEffect"]);
  });

test("installed V14 Actor method completes the nested child using repaired startup registration",
  {skip: !installedApp}, async () => {
    const registry = installedStatusRegistry(installedApp);
    registry.stale = {id: "stale"};
    // A minimal compatibility shim needed only by the installed proxy's deletion method.
    Object.defineProperty(registry, "findSplice", {value(predicate) {
      const index = this.findIndex(predicate);
      if ( index >= 0 ) return this.splice(index, 1)[0];
    }, configurable: true});
    const statuses = await startupStatusEffects(undefined, registry);
    assert.equal(statuses, registry);
    assert.equal(statuses.stale, undefined);
    assert.ok(statuses.prone);
    assert.ok(Object.values(statuses).some(status => status.id === "prone"));
    const f = await fixture({installedApp, statusEffects: statuses});
    const {record} = await nested(f);
    assert.equal(record.state.results.reactions[0].childStatus, "completed",
      JSON.stringify(record.state.results.reactions[0].childOutcome));
    assert.equal(f.actor.system.resources.reaction.value, 0);
    assert.equal(f.actor.effects.size, 1);
    assert.equal(f.world.system.resources.reaction.value, 1);
    assert.equal(f.world.effects.size, 0);
  });
