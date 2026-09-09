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

test("Foundry Actor snapshot overlays effective health outputs on detached source data", () => {
  const source = {resources: {health: {base: 30, bonus: 0, max: 10, value: 30, recovery: "none",
    homebrew: {tags: ["source"]}}}, customData: {unknown: [1]}};
  const actor = withFoundryActorSystem({uuid: "Actor.effective", system: source});
  actor.toObject = sourceOnly => { assert.equal(sourceOnly, true); return {system: source}; };
  actor.system.resources.health.max = 30;
  actor.system.resources.health.homebrew.tags = ["prepared"];
  actor.system.runtimeHandle = actor;
  const snapshot = foundryActorSystemSnapshot(actor);
  assert.deepEqual(snapshot, {...source, resources: {health: {...source.resources.health, max: 30}}});
  assert.equal(Object.getPrototypeOf(snapshot), Object.prototype);
  assert.equal(isPlainSerializableData(snapshot), true);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
  assert.equal(validateResolutionStateSerializable(createActionResolutionState({actorSystem: snapshot})).ok, true);
  source.resources.health.base = 5;
  source.resources.health.value = 5;
  source.resources.health.homebrew.tags.push("changed");
  source.customData.unknown.push(2);
  actor.system.resources.health.max = 4;
  actor.system.resources.health.value = 4;
  assert.deepEqual(snapshot.resources.health, {base: 30, bonus: 0, max: 30, value: 30, recovery: "none",
    homebrew: {tags: ["source"]}});
  assert.deepEqual(snapshot.customData, {unknown: [1]});
  assert.equal(snapshot.runtimeHandle, undefined);
});

test("Foundry Actor snapshot includes modifier-derived maximum and prepared clamped value only", () => {
  const source = {resources: {health: {base: 30, bonus: 2, max: 10, value: 40}}};
  const actor = withFoundryActorSystem({uuid: "Actor.modifiers", system: source});
  actor.toObject = () => ({system: source});
  Object.assign(actor.system.resources.health, {modifierBonus: 3, max: 35, value: 35, runtime: actor});
  const state = createActionResolutionState({actorSystem: foundryActorSystemSnapshot(actor)});
  assert.deepEqual(state.input.actorSystem.resources.health, {base: 30, bonus: 2, max: 35, value: 35});
  assert.equal(validateResolutionStateSerializable(state).ok, true);
  assert.deepEqual(source.resources.health, {base: 30, bonus: 2, max: 10, value: 40});
});

test("Foundry Actor snapshot matches prepared custom pools by ID while preserving source order and fields", () => {
  const source = {pools: [
    {id: "ward", label: "Ward", base: 8, bonus: 2, value: 12, max: 0, recovery: "shortRest", homebrew: {rank: 1}},
    {id: "focus", label: "Focus", base: 3, bonus: 0, value: 2, max: 0, recovery: "longRest"}
  ]};
  const actor = withFoundryActorSystem({uuid: "Actor.pools", system: source});
  actor.toObject = () => ({system: source});
  Object.assign(actor.system.pools[0], {value: 10, max: 10, modifierBonus: 0, runtime: actor});
  Object.assign(actor.system.pools[1], {value: 2, max: 5, modifierBonus: 2});
  actor.system.pools.reverse();
  const snapshot = foundryActorSystemSnapshot(actor);
  assert.deepEqual(snapshot.pools, [{...source.pools[0], value: 10, max: 10}, {...source.pools[1], max: 5}]);
  assert.equal(isPlainSerializableData(snapshot), true);
  source.pools[0].homebrew.rank = 9;
  actor.system.pools[1].value = 0;
  assert.equal(snapshot.pools[0].homebrew.rank, 1);
  assert.equal(snapshot.pools[0].value, 10);
});

test("Foundry Actor snapshot rejects invalid prepared resource outputs without coercion or source fallback", () => {
  for ( const location of ["builtin", "pool"] ) {
    for ( const key of ["value", "max"] ) {
      for ( const invalid of [undefined, null, -1, NaN, Infinity, "30", {}, () => 30, new FakeActorSystemDataModel({})] ) {
        const source = {resources: {health: {value: 30, max: 10}}, pools: [{id: "ward", value: 3, max: 10}]};
        const actor = withFoundryActorSystem({uuid: "Actor.invalid-effective", system: source});
        actor.toObject = () => ({system: source});
        const resource = location === "builtin" ? actor.system.resources.health : actor.system.pools[0];
        resource[key] = invalid;
        assert.throws(() => foundryActorSystemSnapshot(actor),
          /Cannot snapshot Foundry Actor Actor.invalid-effective system: Prepared (resources.health|pools.ward)\.(value|max) must be a finite non-negative number/);
      }
    }
  }
});

test("Foundry Actor snapshot rejects missing or ambiguous prepared pools before planning", () => {
  const source = {pools: [{id: "ward", value: 3, max: 10}]};
  const actor = withFoundryActorSystem({uuid: "Actor.pool-identity", system: source});
  actor.toObject = () => ({system: source});
  actor.system.pools.push({...actor.system.pools[0]});
  assert.throws(() => foundryActorSystemSnapshot(actor), /pool IDs must be non-empty, unique strings/);
  actor.system.pools = [];
  assert.throws(() => foundryActorSystemSnapshot(actor), /prepared pools.ward must be an object/);
});

test("Foundry Actor snapshot uses the actual synthetic Actor including delta data", () => {
  const baseActor = withFoundryActorSystem({uuid: "Actor.same", system: {resources: {reaction: {value: 0}}, delta: "base"}});
  const token = {baseActor, actor: withFoundryActorSystem({uuid: "Scene.a.Token.b.Actor.same",
    system: {resources: {reaction: {value: 1}}, delta: "synthetic"}})};
  const syntheticSource = {resources: {reaction: {value: 1}, health: {base: 30, bonus: 0, value: 30, max: 10}}, delta: "synthetic"};
  token.actor.toObject = source => { token.actor.sourceSnapshotCalls.push(source); return {system: syntheticSource}; };
  token.actor.system.resources.health = {base: 30, bonus: 0, value: 30, max: 35};
  baseActor.system.resources.health = {base: 99, value: 99, max: 99};
  const snapshot = foundryActorSystemSnapshot(token.actor);
  assert.equal(snapshot.resources.reaction.value, 1);
  assert.equal(snapshot.delta, "synthetic");
  assert.deepEqual(snapshot.resources.health, {base: 30, bonus: 0, value: 30, max: 35});
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
