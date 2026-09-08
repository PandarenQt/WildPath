import {test} from "node:test";
import assert from "node:assert/strict";
import {foundryActorSystemSnapshot} from "../module/adapters/foundry-v14-actor-system-adapter.mjs";
import {isPlainSerializableData} from "../module/helpers/multiplayer-authority.mjs";
import {createResolutionState, validateResolutionStateSerializable} from "../module/helpers/resolution-state.mjs";
import {createActionReactionChildState, createActionResolutionState} from "../module/resolvers/action-pipeline-resolver.mjs";
import {FakeActorSystemDataModel, withFoundryActorSystem} from "./fixtures/foundry-actor-system.mjs";

test("Foundry Actor snapshot explicitly serializes a DataModel and detaches nested source data", () => {
  const sourceSystem = {resources: {reaction: {value: 1, max: 1}}, customData: {unknownKey: [1, 2]}};
  const actor = withFoundryActorSystem({uuid: "Actor.model", system: sourceSystem});
  let calls = 0;
  actor.toObject = source => { assert.equal(source, true); calls++; return {system: sourceSystem}; };
  assert.equal(isPlainSerializableData(actor.system), false);
  const snapshot = foundryActorSystemSnapshot(actor);
  const state = createActionResolutionState({actorSystem: snapshot});
  assert.equal(calls, 1);
  assert.equal(isPlainSerializableData(snapshot), true);
  assert.equal(validateResolutionStateSerializable(state).ok, true);
  assert.deepEqual(snapshot, sourceSystem);
  snapshot.resources.reaction.value = 0;
  snapshot.customData.unknownKey.push(3);
  assert.equal(sourceSystem.resources.reaction.value, 1);
  assert.deepEqual(sourceSystem.customData.unknownKey, [1, 2]);
  assert.equal(actor.system.resources.reaction.value, 1);
});

test("Foundry Actor snapshot rejects missing serialization, invalid source shapes, and nested runtime values", () => {
  const cycle = {}; cycle.self = cycle;
  const invalid = [null, [], undefined, 1, new FakeActorSystemDataModel({}),
    {nested: new FakeActorSystemDataModel({})}, {callback() {}}, {value: Infinity}, cycle];
  for ( const system of invalid ) {
    assert.throws(() => foundryActorSystemSnapshot({uuid: "Actor.invalid", toObject: () => ({system})}),
      /Cannot snapshot Foundry Actor Actor.invalid system:/);
  }
  assert.throws(() => foundryActorSystemSnapshot({system: {}}), /Actor.toObject\(true\) is required/);
  assert.throws(() => foundryActorSystemSnapshot({toObject: () => { throw new Error("source unavailable"); }}),
    /Cannot snapshot Foundry Actor .*source unavailable/);
});

test("Foundry Actor snapshot uses the actual synthetic Actor including delta data", () => {
  const baseActor = withFoundryActorSystem({uuid: "Actor.same", system: {resources: {reaction: {value: 0}}, delta: "base"}});
  const token = {baseActor, actor: withFoundryActorSystem({uuid: "Scene.a.Token.b.Actor.same",
    system: {resources: {reaction: {value: 1}}, delta: "synthetic"}})};
  const snapshot = foundryActorSystemSnapshot(token.actor);
  assert.equal(snapshot.resources.reaction.value, 1);
  assert.equal(snapshot.delta, "synthetic");
  assert.deepEqual(token.actor.sourceSnapshotCalls, [true]);
  assert.deepEqual(baseActor.sourceSnapshotCalls, []);
  snapshot.resources.reaction.value = 0;
  assert.equal(token.actor.system.resources.reaction.value, 1);
  assert.equal(baseActor.system.delta, "base");
});

test("pure reaction child callers use plain system maps without a Foundry adapter and reject DataModels", () => {
  const system = {resources: {reaction: {value: 1, max: 1}}};
  const options = {parentState: createResolutionState({id: "root"}),
    baseChildState: createResolutionState({id: "child", parentId: "root", relationship: "reaction"}),
    candidate: {reactor: {actorId: "actorA"}, actionDefinition: {schemaVersion: 1, id: "reaction", label: "Reaction"}}};
  const child = createActionReactionChildState({...options,
    services: {reactions: {actorSystemsByActor: {actorA: system}}}});
  assert.deepEqual(child.input.actorSystem, system);
  assert.equal(validateResolutionStateSerializable(child).ok, true);
  child.input.actorSystem.resources.reaction.value = 0;
  assert.equal(system.resources.reaction.value, 1);
  assert.throws(() => createActionReactionChildState({...options,
    services: {reactions: {actorSystemsByActor: {actorA: new FakeActorSystemDataModel(system)}}}}),
  /input.actorSystem must be plain JSON-serializable data/);
});
