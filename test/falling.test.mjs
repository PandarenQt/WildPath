import {test} from "node:test";
import assert from "node:assert/strict";
import {createFoundryFalling, fallDamageDice} from "../module/adapters/foundry-v14-falling.mjs";

test("a fall hurts 1d6 per full 10 feet, 20d6 at most", () => {
  assert.deepEqual([0, 9, 10, 35, 500].map(fallDamageDice), [0, 0, 1, 3, 20]);
});

test("a creature in the air that gets Prone, or loses its Speed, falls unless it can hover", async () => {
  const resolved = [];
  const coordinator = {resolveAuthorityAction: async ({resolved: options, onComplete}) => {
    resolved.push(options.action.system.definition);
    onComplete({state: {status: "completed"}});
    return {ok: true, state: {status: "completed"}};
  }};
  const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, i18n: {localize: () => "Falling"}};
  const falling = createFoundryFalling({game, coordinator, resolveAction: async options => ({ok: true, action: options.action})});
  const token = (elevation, level=null) => ({id: "bat", elevation, level, updates: [], parent: {id: "scene",
    levels: {get: id => (id === "upper" ? {elevation: {bottom: 20}} : undefined)}}, async update(data, operation) { this.updates.push({data, operation}); }});
  const actor = (bat, movement=[]) => ({uuid: "Actor.bat", isToken: true, token: bat, getGrantedMovement: () => movement});

  const flying = token(35);
  await falling.onEffectCreated({parent: actor(flying), statuses: new Set(["prone"])});
  assert.deepEqual(flying.updates, [{data: {elevation: 0}, operation: {wildpath: {movementKind: "forced"}}}], "to the floor, as forced movement");
  assert.deepEqual(resolved[0].damage, [{id: "fall", expression: {type: "dice", number: 3, faces: 6}, damageType: "bludgeoning"}]);
  assert.equal(resolved[0].effects[0].conditionId, "prone");

  const hovering = token(35);
  await falling.onEffectCreated({parent: actor(hovering, [{hover: true}]), statuses: new Set(["prone"])});
  assert.deepEqual(hovering.updates, [], "a creature that can hover stays up");
  const grounded = token(0);
  await falling.onEffectCreated({parent: actor(grounded), statuses: new Set(["stunned"])});
  assert.deepEqual(grounded.updates, [], "on the floor already");
  const upstairs = token(25, "upper");
  await falling.onEffectCreated({parent: actor(upstairs), statuses: new Set(["restrained"])});
  assert.deepEqual(upstairs.updates[0].data, {elevation: 20}, "to its own Level's floor");
  assert.equal(resolved.length, 1, "5 feet: no damage");
  const blessed = token(30);
  await falling.onEffectCreated({parent: actor(blessed), statuses: new Set(["blessed"])});
  assert.deepEqual(blessed.updates, [], "other effects do nothing");
});

test("a fly Speed that can hover says so (GrantMovement hover)", async () => {
  const {grantedMovementFromRuleElements} = await import("../module/helpers/rule-elements.mjs");
  const owners = [{ruleElements: [{schemaVersion: 1, id: "fly", type: "GrantMovement", data: {mode: "fly", distance: 90, hover: true}},
    {schemaVersion: 1, id: "swim", type: "GrantMovement", data: {mode: "swim", distance: 30}}]}];
  assert.deepEqual(grantedMovementFromRuleElements(owners).map(movement => [movement.mode, movement.hover ?? false]),
    [["fly", true], ["swim", false]]);
});
