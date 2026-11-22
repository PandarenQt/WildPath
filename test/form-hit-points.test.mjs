import {test} from "node:test";
import assert from "node:assert/strict";

// Only the globals needed to import the real Actor, ActiveEffect and vehicle model; a field records what it holds.
class Field { constructor(options) { this.options = options; } }
class Container { constructor(fields, options) { Object.assign(this, {fields, options}); } }
globalThis.Actor = class {};
globalThis.ActiveEffect = class { _onDelete() {} static async _preDeleteOperation() {} };
globalThis.foundry = {
  abstract: {TypeDataModel: class {static defineSchema() { return {}; } prepareBaseData() {} prepareDerivedData() {}}},
  data: {fields: {SchemaField: Container, ArrayField: Container, SetField: Container, NumberField: Field, StringField: Field,
    BooleanField: Field, HTMLField: Field, ObjectField: Field}, ActiveEffectTypeDataModel: class {}},
  utils: {isEmpty: value => Object.keys(value).length === 0, setProperty: (object, path, value) => {
    const keys = path.split(".");
    const last = keys.pop();
    keys.reduce((node, key) => (node[key] ??= {}), object)[last] = value;
  }}
};
Math.clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const {default: WildPathActor} = await import("../module/documents/actor.mjs");
const {default: WildPathActiveEffect} = await import("../module/documents/active-effect.mjs");
const {default: WildPathVehicle} = await import("../module/data/actor/vehicle.mjs");
const {validateActionDefinition} = await import("../module/helpers/action-definitions.mjs");
const {applyActionTransformation, registerFoundryV14MultiplayerResolution} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");

const HEALTH = ["system.resources.health.value", "system.resources.health.temp"];
/** A creature's Hit Points, stored and prepared alike, recording each update and its options. */
function withHealth(target, value, temp=0, max=value) {
  return Object.assign(target, {system: {resources: {health: {value, temp, max}}}, _source: {system: {resources: {health: {value, temp}}}},
    updates: [],
    async update(changes, options) {
      // The possession's mark on the body (flags.wildpath.possessedBy) is kept, not recorded as a Hit Point write.
      if ( "flags.wildpath.possessedBy" in changes ) return void (this.flags = {wildpath: {possessedBy: changes["flags.wildpath.possessedBy"]}});
      this.updates.push([HEALTH.map(path => changes[path]), options?.wildpath ?? null]);
      for ( const [path, key] of [[HEALTH[0], "value"], [HEALTH[1], "temp"]] ) {
        if ( path in changes ) this.system.resources.health[key] = this._source.system.resources.health[key] = changes[path];
      }
    }});
}
/**
 * Ana (30/30), the Guard whose body she takes (7 of 27, 3 Temporary) and a Bandit (11 of 11). An effect's deletion runs
 * the real `_preDeleteOperation` first, as V14's client backend does, and records its operation and Ana's Hit Points then.
 */
function scene() {
  const host = withHealth({name: "Guard", uuid: "Scene.s.Token.host.Actor.guard", prototypeToken: {width: 1, height: 1}, items: []}, 7, 3, 27);
  const bandit = withHealth({name: "Bandit", uuid: "Scene.s.Token.bandit.Actor.bandit", prototypeToken: {width: 1, height: 1}, items: []}, 11);
  const deletes = [];
  let made = 0;
  const caster = withHealth(Object.assign(Object.create(WildPathActor.prototype), {id: "ana", uuid: "Actor.ana", name: "Ana",
    effects: Object.assign([], {get(id) { return this.find(effect => effect.id === id); }}), items: [], flags: {}, statuses: new Set(),
    isToken: true, token: null,
    async createEmbeddedDocuments(type, data) {
      const docs = data.map(entry => ({id: `${type}-${made++}`, disabled: false, parent: caster, ...entry,
        async delete(options={}) {
          const operation = {...options, ids: [this.id]};
          await WildPathActiveEffect._preDeleteOperation([this], operation, globalThis.game.user);
          deletes.push({operation, health: [caster.system.resources.health.value, caster.system.resources.health.temp]});
          caster.effects.splice(caster.effects.indexOf(this), 1);
        }}));
      if ( type === "ActiveEffect" ) this.effects.push(...docs);
      return docs;
    }}), 30);
  return {host, bandit, caster, deletes};
}
/** This client's user; the forms it can find, and which of them it owns. */
function asUser(id, {forms=[], owned=forms}={}) {
  const notices = [];
  for ( const form of forms ) form.isOwner = owned.includes(form);
  Object.assign(globalThis, {game: {i18n: {format: (key, data) => `${key} ${data.name ?? data.form ?? ""}`.trim()},
    user: {id, isGM: id === "gm"}, users: {activeGM: {id: "gm"}}}, ui: {notifications: {warn: text => notices.push(text)}},
  fromUuid: async uuid => forms.find(form => form.uuid === uuid) ?? null});
  return notices;
}
/** Ana possessing the Guard, then taking 5 damage. */
async function possessing({forms, owned}={}) {
  const world = scene();
  asUser("gm", {forms: [world.host, world.bandit]});
  await world.caster.transform(world.host, {copies: [], hitPoints: "form"});
  await world.caster.update({[HEALTH[0]]: 2});
  asUser("gm", {forms: forms?.(world) ?? [world.host, world.bandit], owned: owned?.(world)});
  return world;
}

test("hitPoints \"form\": the body's Hit Points become its creature's, its own and the body's maximum stored, written as no healing", async () => {
  const {host, caster} = scene();
  asUser("gm", {forms: [host]});
  await caster.transform(host, {copies: [], hitPoints: "form"});
  assert.deepEqual(caster.effects[0].flags.wildpath.transformation.hitPoints, {own: {value: 30, temp: 0}, max: 27});
  assert.deepEqual(caster.updates, [[[7, 3], {notHealing: true}]], "Chill Touch on the caster does not keep the body's");
  const plain = scene();
  await plain.caster.transform(plain.host, {copies: []});
  assert.equal(plain.caster.effects[0].flags.wildpath.transformation.hitPoints, undefined, "a form without it keeps its own");
  assert.deepEqual(plain.caster.updates, []);
});

test("a revert gives the creature its own Hit Points before the deletion, and an owned body what is left, once", async () => {
  const {host, caster, deletes} = await possessing();
  assert.equal(await caster.revertTransformation(), true);
  assert.deepEqual(host.updates, [[[2, 3], {notHealing: true}]], "5 damage reached the body");
  assert.deepEqual(caster.updates.at(-1), [[30, 0], {notHealing: true}], "its own Hit Points back");
  assert.deepEqual(deletes.map(({operation, health}) => [operation.wildpath, health]), [[undefined, [30, 0]]],
    "restored before the deletion, nothing left for the GM");
  assert.equal(caster.effects.length, 0);
  assert.equal(await caster.releaseForm({flags: {wildpath: {transformation: {formRef: "Actor.bear"}}}}), null, "a Wild Shape has none");
});

test("on a player's client the creature is restored there, and the body it doesn't own is left to the active GM's hook", async () => {
  const {host, caster, deletes} = await possessing({owned: () => []});
  asUser("player", {forms: [host], owned: []});
  const [effect] = caster.effects;
  await caster.revertTransformation();
  assert.deepEqual([host.updates, caster.updates.at(-1), deletes[0].health], [[], [[30, 0], {notHealing: true}], [30, 0]]);
  assert.deepEqual(deletes[0].operation.wildpath, {formLeft: {[effect.id]: {value: 2, temp: 3}}});

  // The runtime's deleteActiveEffect hook: only the active GM writes, only what an operation left it.
  const handlers = [];
  const game = {user: {id: "gm", isGM: true}, users: {activeGM: {id: "gm"}}, socket: {on() {}, emit() {}}, i18n: {localize: key => key}};
  const previousHooks = globalThis.Hooks;
  globalThis.Hooks = {callAll() { return false; }, on(name, fn) { if ( name === "deleteActiveEffect" ) handlers.push(fn); }};
  try {
    assert.equal(registerFoundryV14MultiplayerResolution({game}).ok, true);
  } finally {
    globalThis.Hooks = previousHooks;
  }
  const fire = async options => { for ( const handler of handlers ) handler(effect, options, "player"); await new Promise(setImmediate); };
  await fire({});
  await fire({wildpath: {formLeft: {other: {value: 9, temp: 0}}}});
  game.user.id = "player";
  await fire(deletes[0].operation);
  assert.deepEqual(host.updates, [], "no release without its Hit Points left, nor on a player's client");
  game.user.id = "gm";
  await fire(deletes[0].operation);
  assert.deepEqual(host.updates, [[[2, 3], {notHealing: true}]]);
});

test("the active GM gives Hit Points back only to a body this possession holds: an effect a player wrote naming another gives it nothing", async () => {
  const {host, bandit, caster} = await possessing();
  assert.equal(host.flags.wildpath.possessedBy, `Actor.ana.ActiveEffect.${caster.effects[0].id}`, "the body names its possession");
  const handlers = [];
  const game = {user: {id: "gm", isGM: true}, users: {activeGM: {id: "gm"}}, socket: {on() {}, emit() {}}, i18n: {localize: key => key}};
  const previousHooks = globalThis.Hooks;
  globalThis.Hooks = {callAll() { return false; }, on(name, fn) { if ( name === "deleteActiveEffect" ) handlers.push(fn); }};
  try {
    assert.equal(registerFoundryV14MultiplayerResolution({game}).ok, true);
  } finally {
    globalThis.Hooks = previousHooks;
  }
  // A player's own effect naming the Bandit, never possessed, and one naming the Guard, which another effect possesses.
  for ( const [id, form] of [["forged", bandit], ["other", host]] ) {
    const effect = {id, parent: caster, flags: {wildpath: {transformation: {formRef: form.uuid}}}};
    for ( const handler of handlers ) handler(effect, {wildpath: {formLeft: {[id]: {value: 0, temp: 0}}}}, "player");
  }
  await new Promise(setImmediate);
  assert.deepEqual([host.updates, bandit.updates], [[], []]);
});

test("a plain deletion (a concentration ending), or a player's new transform, restores the creature before the next form is taken", async () => {
  const gm = await possessing();
  await gm.caster.effects[0].delete();
  await gm.caster.transform(gm.bandit, {copies: [], hitPoints: "form"});
  assert.deepEqual(gm.caster.effects[0].flags.wildpath.transformation.hitPoints.own, {value: 30, temp: 0}, "not the Guard's 2");
  assert.deepEqual(gm.host.updates, [[[2, 3], {notHealing: true}]]);

  const player = await possessing({owned: () => []});
  asUser("player", {forms: [player.host, player.bandit], owned: []});
  await player.caster.transform(player.bandit, {copies: [], hitPoints: "form"});
  assert.deepEqual(player.caster.effects[0].flags.wildpath.transformation.hitPoints.own, {value: 30, temp: 0});
  assert.deepEqual(player.caster.updates.slice(-2), [[[30, 0], {notHealing: true}], [[11, 0], {notHealing: true}]]);
  assert.deepEqual(player.deletes[0].operation.wildpath.formLeft, {[player.deletes[0].operation.ids[0]]: {value: 2, temp: 3}});
});

test("a body that is gone restores only its creature, and the GM is told", async () => {
  const {host, caster, deletes} = await possessing({forms: () => []});
  const [effect] = caster.effects;
  const notices = asUser("gm", {forms: []});
  await caster.revertTransformation();
  assert.deepEqual([host.updates, caster.updates.at(-1)], [[], [[30, 0], {notHealing: true}]]);
  await caster.giveFormBack(effect, deletes[0].operation.wildpath.formLeft[effect.id]);
  assert.deepEqual(notices, ["WILDPATH.NOTICE.FormGone Ana"]);
});

test("its creature's Hit Point maximum is the stored one, with the form unresolvable (a reload); without it, its own", () => {
  const prepared = transformation => {
    const actor = Object.assign(Object.create(WildPathActor.prototype), {id: "ana", uuid: "Actor.ana", name: "Ana", type: "vehicle",
      items: [], statuses: new Set(), flags: {}, effects: transformation ? [{id: "form", disabled: false, flags: {wildpath: {transformation}},
        system: {ruleElements: []}}] : []});
    actor.allApplicableEffects = () => actor.effects;
    const system = Object.assign(new WildPathVehicle(), {parent: actor, biography: "", defenses: {ac: {base: 15}}, pools: [],
      resources: {health: {base: 30, bonus: 0, max: 30, value: 7, temp: 0}, movement: {base: 30, bonus: 0, max: 0, value: 0, spent: 0}},
      immunities: {damage: [], conditions: []}, aboard: []});
    actor.system = system;
    system.prepareBaseData();
    system.prepareDerivedData();
    return [system.resources.health.max, system.resources.health.value];
  };
  globalThis.fromUuidSync = () => null;
  try {
    assert.deepEqual(prepared({formRef: "Scene.s.Token.host.Actor.guard", hitPoints: {own: {value: 30, temp: 0}, max: 27}}), [27, 7]);
    assert.deepEqual(prepared({formRef: "Scene.s.Token.host.Actor.guard", hitPoints: {own: {value: 30, temp: 0}, max: 5}}), [5, 5],
      "its Hit Points are clamped to it");
    assert.deepEqual(prepared({formRef: "Actor.bear"}), [30, 7], "a form without it");
    assert.deepEqual(prepared(null), [30, 7]);
  } finally {
    delete globalThis.fromUuidSync;
  }
});

const POSSESS = {schemaVersion: 1, id: "action:possess", label: "Possess", costs: {allOf: []}, targeting: {type: "single"},
  save: {ability: "presence", dc: {value: 15}}, transform: {formFrom: "target", copies: [], hitPoints: "form"}};

test("hitPoints is \"form\" on a target's body without temporaryHealth, and reaches the transform", async () => {
  const valid = transform => validateActionDefinition({...POSSESS, transform: {...POSSESS.transform, ...transform}}).ok;
  assert.equal(valid({}), true);
  assert.equal(valid({hitPoints: "own"}), false);
  assert.equal(valid({hitPoints: true}), false);
  assert.equal(valid({temporaryHealth: "form"}), false, "the body's Hit Points are not also Temporary ones");
  assert.equal(valid({formFrom: undefined, formRef: "Actor.bear"}), false, "a stat block many share is given nothing back");
  assert.equal(valid({hitPoints: undefined}), true);
  const calls = [];
  const caster = {id: "caster", parent: {tokens: new Map([["host", {actor: {name: "Guard"}}]])}};
  await applyActionTransformation({options: {actor: {async transform(form, policy) { calls.push(policy); }}},
    state: {actionDefinition: POSSESS, source: {tokenRef: "Scene.s.Token.caster", tokenId: "caster"},
      results: {saveResolution: {results: [{ok: true, success: false, target: {tokenId: "host"}}]}}}},
  {fromUuid: async uuid => (uuid === "Scene.s.Token.caster" ? caster : null)});
  assert.deepEqual(calls, [{copies: [], hitPoints: "form"}]);
});
