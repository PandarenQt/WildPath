import {test} from "node:test";
import assert from "node:assert/strict";
import {createTokenGridFootprint, fieldKey} from "../module/helpers/grid-footprints.mjs";
import {createMovementPath, evaluateMovementPath} from "../module/helpers/movement-paths.mjs";
import {advanceMovementProgress, createMovementProgress, diffMovementFootprints} from "../module/helpers/movement-events.mjs";
import {AUTOMATION_EVENT_TYPES, collectTriggeredAutomations, createTriggerDefinition} from "../module/helpers/automation-events.mjs";
import {isPlainSerializableData} from "../module/helpers/multiplayer-authority.mjs";

function progressFixture({topology="square", size="medium", steps=1, kind="voluntary", anchors=null, movementId="move-a", tokenRef="token:scene.token"}={}) {
  const path = createMovementPath({
    anchors: anchors ?? Array.from({length: steps + 1}, (_, i) => topology === "hex" ? {q: i, r: 0} : {x: i, y: 0}),
    topology, size, movementKind: kind, movementMode: "walk"
  });
  const evaluation = evaluateMovementPath(path, {measurementMode: "distance", grid: {distance: 5, units: "ft"}});
  return createMovementProgress({
    movementId,
    source: {actorRef: "uuid:Scene.scene.Token.token.Actor.actor", actorId: "actor", tokenRef, tokenId: "token", sceneRef: "scene:scene"},
    authority: {userId: "gm-a", mode: "active-gm"},
    evaluation
  });
}

function observe(progress, count, status="moving", extra={}) {
  return advanceMovementProgress(progress, {
    completedTransitionCount: count,
    actualFootprint: progress.approvedFootprints[count],
    status,
    provenance: {source: "test-observation"},
    ...extra
  });
}

test("Medium square completion yields canonical started, transition, and completed facts", () => {
  const progress = progressFixture();
  assert.equal(progress.status, "pending");
  assert.equal(progress.completedTransitionCount, 0);
  const before = structuredClone(progress);
  const result = observe(progress, 1, "completed");
  assert.deepEqual(progress, before);
  assert.deepEqual(result.events.map(event => event.type), ["movement.started", "movement.transition", "movement.completed"]);
  const [started, transition, completed] = result.events;
  assert.equal(started.data.completedTransitionCount, undefined);
  assert.deepEqual(started.data.origin.anchor, {x: 0, y: 0});
  assert.deepEqual(transition.data.from.anchor, {x: 0, y: 0});
  assert.deepEqual(transition.data.to.anchor, {x: 1, y: 0});
  assert.equal(transition.data.stepCost.amount, 5);
  assert.equal(completed.data.actualTotalCost, 5);
  assert.equal(completed.data.actorRef, "uuid:Scene.scene.Token.token.Actor.actor");
  assert.equal(completed.source.ref, "token:scene.token");
  assert.equal(result.events.every(event => event.phase === "information" && isPlainSerializableData(event)), true);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

for ( const [topology, retained, left, entered] of [
  ["square", ["square:1,0", "square:1,1"], ["square:0,0", "square:0,1"], ["square:2,0", "square:2,1"]],
  ["hex", ["hex:1,0"], ["hex:0,0", "hex:0,1"], ["hex:1,1", "hex:2,0"]]
] ) {
  test(`Large ${topology} field deltas use full footprints without multiplying step cost`, () => {
    const progress = progressFixture({topology, size: "large"});
    const transition = observe(progress, 1, "completed").events[1];
    const keys = fields => fields.map(field => fieldKey(field, topology));
    assert.deepEqual(keys(transition.data.retainedFields), retained);
    assert.deepEqual(keys(transition.data.leftFields), left);
    assert.deepEqual(keys(transition.data.enteredFields), entered);
    assert.equal(transition.data.from.footprint.fields.length, topology === "hex" ? 3 : 4);
    assert.equal(transition.data.to.footprint.fields.length, topology === "hex" ? 3 : 4);
    assert.equal(transition.data.cumulativeCost, 5);
    const before = progress.approvedFootprints[0];
    const after = progress.approvedFootprints[1];
    assert.deepEqual(diffMovementFootprints({...before, fields: [...before.fields].reverse().concat(before.fields)}, after),
      diffMovementFootprints(before, after));
  });
}

test("ordered observations, duplicates, and batched completion produce the same stable event identities", () => {
  const progress = progressFixture({steps: 2});
  const first = observe(progress, 1);
  assert.equal(first.events.length, 2);
  assert.deepEqual(observe(first.progress, 1).events, []);
  const second = observe(first.progress, 2, "completed");
  const complete = observe(progress, 2, "completed");
  const emitted = [...first.events, ...second.events];
  assert.deepEqual(emitted.map(event => event.id), complete.events.map(event => event.id));
  assert.deepEqual(emitted.filter(event => event.type === "movement.transition").map(event => event.data.transitionIndex), [0, 1]);
  assert.deepEqual(emitted.filter(event => event.type === "movement.transition").map(event => event.data.cumulativeCost), [5, 10]);
  assert.deepEqual(observe(second.progress, 2, "completed").events, []);
  assert.deepEqual(observe(second.progress, 1).events, []);
  const another = observe(progressFixture({steps: 2, tokenRef: "token:scene.other"}), 2, "completed");
  assert.notEqual(another.events[0].id, complete.events[0].id);
});

test("interruption reports only the completed prefix and never fabricates the suffix", () => {
  const progress = progressFixture({steps: 3});
  const result = observe(progress, 2, "interrupted", {interruption: {reason: "Blocked", source: "rule:test", resumable: true}});
  assert.deepEqual(result.events.map(event => event.type), ["movement.started", "movement.transition", "movement.transition", "movement.interrupted"]);
  const event = result.events.at(-1);
  assert.deepEqual(event.data.actualDestination.anchor, {x: 2, y: 0});
  assert.deepEqual(event.data.approvedDestination.anchor, {x: 3, y: 0});
  assert.equal(event.data.completedTransitionCount, 2);
  assert.equal(event.data.remainingTransitionCount, 1);
  assert.equal(event.data.completedCost, 10);
  assert.deepEqual(event.data.completedAnchors, [{x: 0, y: 0}, {x: 1, y: 0}, {x: 2, y: 0}]);
  assert.deepEqual(event.data.remainingAnchors, [{x: 2, y: 0}, {x: 3, y: 0}]);
  assert.equal(result.events.some(entry => entry.type === "movement.completed"), false);
  assert.equal(observe(result.progress, 2, "interrupted", {interruption: {reason: "Blocked", source: "rule:test", resumable: true}}).duplicate, true);
  assert.throws(() => observe(result.progress, 3, "completed"), /Terminal/);
});

test("pause and resumed progress do not restart movement or replay completed transitions", () => {
  const progress = progressFixture({steps: 3});
  const paused = observe(progress, 1, "paused");
  const moving = observe(paused.progress, 1, "moving");
  assert.deepEqual(moving.events, []);
  const completed = observe(moving.progress, 3, "completed");
  assert.deepEqual(completed.events.filter(event => event.type === "movement.transition").map(event => event.data.transitionIndex), [1, 2]);
});

test("forced movement retains travel cost and provenance but has no ordinary budget cost", () => {
  const result = observe(progressFixture({kind: "forced"}), 1, "completed");
  assert.equal(result.events.length, 3);
  for ( const event of result.events ) {
    assert.equal(event.data.movementKind, "forced");
    assert.equal(event.data.consumesBudget, false);
  }
  assert.equal(result.events[1].data.budgetCost, 0);
  assert.equal(result.events[1].data.stepCost.amount, 5);
});

test("teleport is one discontinuous endpoint transition with no invented intermediate fields", () => {
  const progress = progressFixture({kind: "teleport", anchors: [{x: 0, y: 0}, {x: 8, y: 0}]});
  const result = observe(progress, 1, "completed");
  const transition = result.events[1];
  assert.equal(result.events.length, 3);
  assert.equal(transition.data.discontinuous, true);
  assert.equal(transition.data.stepCost.amount, 0);
  assert.deepEqual(transition.data.leftFields, [{x: 0, y: 0}]);
  assert.deepEqual(transition.data.enteredFields, [{x: 8, y: 0}]);
});

test("zero-transition updates emit no locomotion events", () => {
  assert.deepEqual(observe(progressFixture({steps: 0}), 0, "completed").events, []);
});

test("invalid or mismatched progress cannot produce completion facts", () => {
  const progress = progressFixture({steps: 2});
  assert.throws(() => observe(progress, 1, "completed"), /incomplete prefix/);
  assert.throws(() => observe(progress, -1), /out of range/);
  assert.throws(() => observe(progress, 0.5), /out of range/);
  assert.throws(() => observe(progress, 3), /out of range/);
  assert.throws(() => observe(progress, 1, "moving", {actualFootprint: progress.approvedFootprints[2]}), /does not match/);
  assert.throws(() => observe(progress, 1, "interrupted"), /interruption reason/);
  assert.throws(() => observe(progress, 1, "moving", {provenance: {document: new Map()}}), /plain serializable/);
  assert.throws(() => diffMovementFootprints(progress.approvedFootprints[0], createTokenGridFootprint({topology: "hex", size: "medium", anchor: {q: 0, r: 0}})), /matching topologies/);
  assert.throws(() => diffMovementFootprints({...progress.approvedFootprints[0], fields: [{x: NaN, y: 0}]}, progress.approvedFootprints[1]), /integer/);
});

test("existing Trigger and Predicate helpers can match movement data without opening reactions", () => {
  const event = observe(progressFixture({steps: 2}), 2, "completed").events[2];
  const trigger = createTriggerDefinition({
    id: "after-ten-feet", event: AUTOMATION_EVENT_TYPES.MOVEMENT_TRANSITION,
    predicate: {equals: {path: "event.data.cumulativeCost", value: 10}}
  });
  const result = collectTriggeredAutomations({triggers: [trigger], event});
  assert.deepEqual(result.matches.map(match => match.triggerId), ["after-ten-feet"]);
  assert.equal(event.phase, "information");
});

test("an observed start at origin emits no predicted transitions and a pre-step interruption has zero cost", () => {
  const progress = progressFixture({steps: 2});
  const started = observe(progress, 0, "moving");
  assert.deepEqual(started.events.map(event => event.type), ["movement.started"]);
  assert.deepEqual(observe(started.progress, 0, "moving").events, []);
  const interrupted = observe(started.progress, 0, "interrupted", {
    interruption: {reason: "Cancelled before first step", source: null, resumable: false}
  });
  assert.deepEqual(interrupted.events.map(event => event.type), ["movement.interrupted"]);
  assert.equal(interrupted.events[0].data.completedCost, 0);
  assert.deepEqual(interrupted.events[0].data.remainingAnchors, progress.approvedPath.anchors);
});

test("progress rejects invalid evaluated routes before recording approval state", () => {
  const path = createMovementPath({anchors: [{x: 0, y: 0}, {x: 1, y: 0}], topology: "square", size: "medium"});
  const evaluation = evaluateMovementPath(path, {measurementMode: "distance", grid: {distance: 5, units: "ft"}});
  const {source, authority} = progressFixture();
  const create = evaluation => createMovementProgress({movementId: "invalid-test", source, authority, evaluation});
  assert.throws(() => create({...evaluation, valid: false}), /valid evaluated route/);
  assert.throws(() => create({...evaluation, footprints: evaluation.footprints.slice(1)}), /counts must agree/);
  assert.throws(() => create({...evaluation, footprints: [...evaluation.footprints].reverse()}), /approved anchor/);
  assert.throws(() => create({...evaluation, transitions: [{...evaluation.transitions[0], allowed: false}]}), /allowed transitions/);
  assert.throws(() => create({...evaluation, transitions: [{...evaluation.transitions[0], cost: {amount: -1}}]}), /nonnegative costs/);
});
