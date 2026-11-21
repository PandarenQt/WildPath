import {test} from "node:test";
import assert from "node:assert/strict";
import {companionOwnershipChanges} from "../module/adapters/foundry-v14-companions.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";

const users = [{id: "gm", isGM: true}, {id: "ana"}, {id: "bo"}, {id: "cy"}];
// Ana owns the summoner, Bo the fighter, Cy nothing.
const owners = {"Actor.summoner": ["ana"], "Actor.fighter": ["bo"]};
const owns = (userId, ref) => (owners[ref] ?? []).includes(userId);

test("every Player who owns a controller controls the companion; GMs and others are left alone", () => {
  assert.deepEqual(companionOwnershipChanges({controllers: ["Actor.summoner"], users, owns}), {ana: 3});
  assert.deepEqual(companionOwnershipChanges({ownership: {ana: 3}, previous: ["Actor.summoner"],
    controllers: ["Actor.summoner", "Actor.fighter"], users, owns}), {bo: 3}, "sharing control adds the fighter's Player");
});

test("a Player who controlled a companion only through a removed controller returns to the default", () => {
  assert.deepEqual(companionOwnershipChanges({ownership: {ana: 3, bo: 3}, previous: ["Actor.summoner", "Actor.fighter"],
    controllers: ["Actor.fighter"], users, owns}), {ana: -1});
  assert.deepEqual(companionOwnershipChanges({ownership: {cy: 3}, previous: ["Actor.summoner"], controllers: [], users, owns}),
    {}, "an owner the GM set by hand is not touched");
});

test("controller costs are validated like the Action's own costs", () => {
  const definition = controllerCosts => ({schemaVersion: 1, id: "action:bite", label: "Bite", costs: {allOf: []}, controllerCosts});
  assert.equal(validateActionDefinition(definition({allOf: [{capability: "bonus-action", amount: 1},
    {capability: "movement", amount: 10}]})).ok, true);
  assert.deepEqual(validateActionDefinition(definition({allOf: [{capability: "bonus-action", amount: -1}]})).errors
    .map(error => error.path), ["controllerCosts.allOf.0.amount"]);
});

test("an effect giving control makes its creature its giver's companion while it lasts (metadata.control: Sway Rats' Swayed, Q18.6)", async t => {
  const {createFoundryCompanions} = await import("../module/adapters/foundry-v14-companions.mjs");
  const piper = {uuid: "Actor.piper", documentName: "Actor", testUserPermission: user => user?.id === "ana"};
  const previous = globalThis.fromUuidSync;
  globalThis.fromUuidSync = ref => ((ref === piper.uuid) ? piper : null);
  t.after(() => { if ( previous === undefined ) delete globalThis.fromUuidSync; else globalThis.fromUuidSync = previous; });
  const writes = [];
  const swarm = {uuid: "Scene.s.Token.rats.Actor.rats", ownership: {}, effects: [], system: {companion: {kind: "companion", controllers: []}},
    async update(data) {
      writes.push(data);
      this.system.companion = data["system.companion"];
      for ( const [key, level] of Object.entries(data) ) if ( key.startsWith("ownership.") ) this.ownership[key.slice(10)] = level;
    }};
  const effect = (id, metadata={control: true}, sourceRef=piper.uuid) => ({id, parent: swarm, disabled: false,
    flags: {wildpath: {conditionEffect: {sourceRef, metadata}}},
    async update(data) { if ( "flags.wildpath.controlRef" in data ) this.flags.wildpath.controlRef = data["flags.wildpath.controlRef"]; }});
  const game = {user: {id: "gm", isGM: true}, users: Object.assign([...users], {activeGM: {id: "gm"}})};
  const companions = createFoundryCompanions({game, fromUuid: ref => ((ref === piper.uuid) ? piper : null)});

  await companions.onEffectCreated(effect("plain", {}));
  assert.equal(writes.length, 0, "an effect giving no control");
  const swayed = effect("swayed");
  swarm.effects.push(swayed);
  await companions.onEffectCreated(swayed);
  assert.deepEqual(swarm.system.companion.controllers, ["Actor.piper"], "its giver controls it");
  assert.equal(swarm.ownership.ana, 3, "and the piper's Player owns it");
  const again = effect("again");
  swarm.effects.push(again);
  await companions.onEffectCreated(again);
  assert.equal(writes.length, 1, "a second such effect from the same giver changes nothing");
  swarm.effects.splice(swarm.effects.indexOf(swayed), 1);
  await companions.onEffectDeleted(swayed);
  assert.equal(writes.length, 1, "the control lasts while one is left");
  swarm.effects.splice(swarm.effects.indexOf(again), 1);
  await companions.onEffectDeleted(again);
  assert.deepEqual(swarm.system.companion.controllers, [], "the last one gone, it is no one's");
  assert.equal(swarm.ownership.ana, -1, "and its Player's ownership returns to the default");

  // Only the active GM writes.
  const player = createFoundryCompanions({game: {...game, user: {id: "ana"}}, fromUuid: () => piper});
  await player.onEffectCreated(effect("swayed"));
  assert.equal(writes.length, 2);

  // A controller it had before the effect (its summoner) keeps it when the effect ends.
  swarm.system.companion = {kind: "summon", controllers: ["Actor.piper"]};
  const command = effect("command");
  swarm.effects.push(command);
  await companions.onEffectCreated(command);
  swarm.effects.splice(swarm.effects.indexOf(command), 1);
  await companions.onEffectDeleted(command);
  assert.deepEqual([writes.length, swarm.system.companion.controllers], [2, ["Actor.piper"]], "the effect gave nothing, so took nothing");

  // Its giver no longer found as the effect ends (a slain piper's Token deleted): the control it gave still goes.
  swarm.system.companion = {kind: "companion", controllers: []};
  const lost = effect("lost");
  swarm.effects.push(lost);
  await companions.onEffectCreated(lost);
  assert.deepEqual(swarm.system.companion.controllers, ["Actor.piper"]);
  lost.flags.wildpath.conditionEffect.sourceRef = "Scene.s.Token.gone";
  swarm.effects.splice(swarm.effects.indexOf(lost), 1);
  await companions.onEffectDeleted(lost);
  assert.deepEqual(swarm.system.companion.controllers, [], "no one's again, so another piper may sway it");
});
