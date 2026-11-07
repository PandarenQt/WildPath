import {test} from "node:test";
import assert from "node:assert/strict";

// Only the globals needed to import and run the real Actor class's update guard; no Foundry schema emulation.
const path = key => key.split(".");
globalThis.Actor = class { async _preUpdate() { return undefined; } };
globalThis.foundry = {
  data: {fields: {}, ActiveEffectTypeDataModel: class {}},
  utils: {
    isEmpty: value => Object.keys(value).length === 0,
    getProperty: (object, key) => path(key).reduce((node, part) => node?.[part], object),
    setProperty: (object, key, value) => {
      const parts = path(key);
      const last = parts.pop();
      parts.reduce((node, part) => (node[part] ??= {}), object)[last] = value;
      return true;
    }
  }
};
const told = [];
globalThis.ui = {notifications: {info: message => told.push(message)}};
globalThis.game = {i18n: {format: key => key}};
Math.clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const {default: WildPathActor} = await import("../module/documents/actor.mjs");

const creature = caps => Object.assign(Object.create(WildPathActor.prototype), {name: "Swarm of Rats",
  system: {resources: {health: {value: 10, max: 24, temp: 0}}, resourceCaps: caps}});

test("a creature that can't regain Hit Points or gain Temporary Hit Points (a swarm) keeps them where they are", async () => {
  const swarm = creature({healing: 0, temporaryHealth: 0});
  const changes = {system: {resources: {health: {value: 18, temp: 5}}}};
  await swarm._preUpdate(changes, {}, {});
  assert.deepEqual(changes.system.resources.health, {value: 10, temp: 0});
  assert.deepEqual(told.splice(0), ["WILDPATH.NOTIFY.NoHealing", "WILDPATH.NOTIFY.NoTemporaryHealth"]);
  const hurt = {system: {resources: {health: {value: 4}}}};
  await swarm._preUpdate(hurt, {}, {});
  assert.equal(hurt.system.resources.health.value, 4, "damage still lands");

  // Chill Touch caps healing only: Temporary Hit Points are still gained.
  const chilled = creature({healing: 0});
  const shielded = {system: {resources: {health: {temp: 5}}}};
  await chilled._preUpdate(shielded, {}, {});
  assert.equal(shielded.system.resources.health.temp, 5);
});

/** A creature whose update runs the real guard, then writes what it kept. */
function updatable(caps, health) {
  const actor = creature(caps);
  actor.system.resources.health = {...health};
  actor.update = async function(updates, operation) {
    const changes = {};
    for ( const [key, value] of Object.entries(updates) ) foundry.utils.setProperty(changes, key, value);
    await this._preUpdate(changes, operation, {});
    for ( const key of Object.keys(updates) ) foundry.utils.setProperty(this, key, foundry.utils.getProperty(changes, key));
    return this;
  };
  return actor;
}

/** Its damage committed through the real target commit, then rolled back by a later write that fails. */
async function damageRolledBack(actor, amount) {
  const {prepareTargetMutationCommitOperations} = await import("../module/resolvers/target-mutation-commit-resolver.mjs");
  const {executeResolutionTransaction} = await import("../module/resolvers/resolution-transaction-resolver.mjs");
  const {createActorDamageMutationPlan} = await import("../module/resolvers/durability-resolver.mjs");
  const prepared = prepareTargetMutationCommitOperations({authority: true, targetActors: {"actor:victim": actor},
    snapshotActor: target => structuredClone(target.system),
    mutationPlans: [{type: "durabilityDamage", targetRef: "actor:victim", target: {id: "victim", actorId: "victim"},
      plan: createActorDamageMutationPlan(structuredClone(actor.system), {amount})}]});
  const failing = {id: "source:0:resourcePayment", type: "resourcePayment", commit: async () => false};
  return executeResolutionTransaction({operations: [...prepared.operations, failing]});
}

test("a rolled-back damage commit restores Hit Points a creature can't regain: an undo is not healing", async () => {
  const chilled = updatable({healing: 0}, {value: 10, max: 24, temp: 0});
  const result = await damageRolledBack(chilled, 6);
  assert.equal(result.rolledBack, true);
  assert.equal(chilled.system.resources.health.value, 10);
  // A swarm's Temporary Hit Points lost to the damage come back too.
  const swarm = updatable({healing: 0, temporaryHealth: 0}, {value: 10, max: 24, temp: 3});
  await damageRolledBack(swarm, 5);
  assert.deepEqual(swarm.system.resources.health, {value: 10, max: 24, temp: 3});
  assert.deepEqual(told.splice(0), [], "no refusal is announced");
  // Healing outside a rollback is still refused.
  const healed = {system: {resources: {health: {value: 20}}}};
  await chilled._preUpdate(healed, {}, {});
  assert.equal(healed.system.resources.health.value, 10);
  told.splice(0);
});
