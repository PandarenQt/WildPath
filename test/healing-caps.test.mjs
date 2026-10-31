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
