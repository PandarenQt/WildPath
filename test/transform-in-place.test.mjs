import {test} from "node:test";
import assert from "node:assert/strict";

// Only the globals needed to import the real Actor and ActiveEffect; a field records what it holds.
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
const {default: WildPathActor} = await import("../module/documents/actor.mjs");
const {default: WildPathActiveEffect} = await import("../module/documents/active-effect.mjs");
const {validateActionDefinition} = await import("../module/helpers/action-definitions.mjs");
const {applyActionTransformation, endLostConcentration, registerFoundryV14MultiplayerResolution} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
const {swapTokens} = await import("../module/adapters/foundry-v14-teleport.mjs");

const GROUP = "action:possess|Actor.ana";
const PLACE = {tokenUuid: "Scene.s.Token.ana", formTokenUuid: "Scene.s.Token.guard", formEffectGroup: GROUP, from: {x: 500, y: 500}};

/**
 * A square grid of 100-pixel, 5-foot fields (as test/teleport.test.mjs): Ana (Token at 500,500) and the Guard whose body
 * she rides (Token at 900,500), Trapped and so on its own plane, holding the soul effect Possess gave it and Bless from
 * another use. `log` records each Token move and effect deletion in order; an effect's deletion runs the real
 * `_preDeleteOperation` first, as V14's client backend does.
 */
function world({others=[], bodySize=1}={}) {
  const log = [];
  const scene = {id: "s", tokens: [], dimensions: {sceneRect: {contains: (x, y) => (x >= 0) && (y >= 0) && (x < 2000) && (y < 2000)}},
    grid: {getOffset: point => ({i: Math.floor(point.y / 100), j: Math.floor(point.x / 100)}),
      getTopLeftPoint: offset => ({x: offset.j * 100, y: offset.i * 100}),
      measurePath: ([a, b]) => ({distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 20})}};
  const token = (id, x, y, actor, size=1) => ({id, uuid: `Scene.s.Token.${id}`, x, y, width: size, height: size, parent: scene, actor,
    actorLink: id === "ana", actorId: id,
    getCenterPoint(data={}) { return {x: (data.x ?? this.x) + (50 * this.width), y: (data.y ?? this.y) + (50 * this.height)}; },
    getOccupiedGridSpaceOffsets(data={}) {
      const {i, j} = scene.grid.getOffset({x: (data.x ?? this.x) + 1, y: (data.y ?? this.y) + 1});
      return Array.from({length: this.width * this.height}, (_, index) => ({i: i + Math.floor(index / this.width), j: j + (index % this.width)}));
    },
    async update(data) { log.push(["move", id, data.x, data.y]); Object.assign(this, data); },
    async move([{width, height}]) { log.push(["size", id, width, height]); Object.assign(this, {width, height}); }});
  const given = (id, sourceRef, actionDefinitionId) => ({id, flags: {wildpath: {conditionEffect: {sourceRef, metadata: {actionDefinitionId}}}}});
  const guard = {uuid: "Scene.s.Token.guard.Actor.guard", name: "Guard", statuses: new Set(["trapped"]), prototypeToken: {width: bodySize, height: bodySize},
    items: [], effects: [given("soul", "Actor.ana", "action:possess"), given("bless", "Actor.cleric", "action:bless")], flags: {},
    async update(changes) { this.flags = {wildpath: {possessedBy: changes["flags.wildpath.possessedBy"]}}; },
    async deleteEmbeddedDocuments(type, ids) {
      log.push(["end", ...ids]);
      this.effects = this.effects.filter(effect => !ids.includes(effect.id));
    }};
  let made = 0;
  const ana = Object.assign(Object.create(WildPathActor.prototype), {id: "ana", uuid: "Actor.ana", name: "Ana", flags: {}, items: [],
    statuses: new Set(), system: {resources: {health: {value: 30, temp: 0}}},
    effects: Object.assign([], {get(id) { return this.find(effect => effect.id === id); }}),
    async createEmbeddedDocuments(type, data) {
      const docs = data.map(entry => ({id: `${type}-${made++}`, disabled: false, parent: ana, ...entry,
        async delete() {
          await WildPathActiveEffect._preDeleteOperation([this], {ids: [this.id]}, globalThis.game.user);
          log.push(["deleted", this.id]);
          ana.effects.splice(ana.effects.indexOf(this), 1);
        }}));
      if ( type === "ActiveEffect" ) this.effects.push(...docs);
      return docs;
    }});
  scene.tokens = [token("ana", 500, 500, ana), token("guard", 900, 500, guard, bodySize),
    ...others.map(([id, x, y]) => token(id, x, y, {uuid: `Actor.${id}`, statuses: new Set()}))];
  scene.tokens.get = id => scene.tokens.find(each => each.id === id);
  return {log, scene, ana, guard, tokens: Object.fromEntries(scene.tokens.map(each => [each.id, each]))};
}

/** This client's user, the documents its uuids find, and the GM notices it sends. */
function asUser(id, {scene}) {
  const notices = [];
  globalThis.game = {i18n: {format: (key, data) => `${key} ${data.name ?? ""}`.trim(), localize: key => key},
    user: {id, isGM: id === "gm"}, users: {activeGM: {id: "gm"}}, scenes: [scene]};
  globalThis.fromUuidSync = uuid => scene.tokens.find(each => each.uuid === uuid) ?? null;
  globalThis.fromUuid = async uuid => globalThis.fromUuidSync(uuid) ?? scene.tokens.find(each => each.actor.uuid === uuid)?.actor ?? null;
  globalThis.ui = {notifications: {warn: text => notices.push(text)}};
  return notices;
}

/**
 * Ana possessing the Guard in place: her Action's swap trades the Tokens (unless `swapped` is false: a failed check), then
 * she walks the body to `to`.
 */
async function ridden({swapped=true, to={x: 1200, y: 500}, ...options}={}) {
  const setup = world(options);
  asUser("gm", setup);
  await setup.ana.transform(setup.guard, {copies: [], inPlace: PLACE});
  if ( swapped ) await swapTokens(setup.tokens.ana, setup.tokens.guard);
  await setup.tokens.ana.update(to);
  setup.log.length = 0;
  return setup;
}

test("inPlace is stored on the transformation; ending it on the GM trades the Tokens back, then ends only its group, before the deletion", async () => {
  const {log, ana, guard, tokens} = await ridden();
  assert.deepEqual(ana.effects[0].flags.wildpath.transformation.inPlace, PLACE);
  assert.deepEqual([tokens.ana.x, tokens.guard.x], [1200, 500], "the Guard's hidden Token holds the space Ana left");
  await ana.revertTransformation();
  assert.deepEqual(log, [["move", "ana", 500, 500], ["move", "guard", 1200, 500], ["end", "soul"], ["deleted", "ActiveEffect-0"]],
    "Ana back in her space, the body where she left it, its soul effect (and the Trapped it holds) ended, then the deletion");
  assert.deepEqual(guard.effects.map(effect => effect.id), ["bless"], "another use's effect stays");

  const plain = world();
  asUser("gm", plain);
  await plain.ana.transform(plain.guard, {copies: []});
  assert.equal(plain.ana.effects[0].flags.wildpath.transformation.inPlace, undefined);
  await plain.ana.revertTransformation();
  assert.deepEqual(plain.log, [["deleted", "ActiveEffect-0"]], "a transformation without it moves and ends nothing");
});

test("a swap back refused by a creature now in Ana's space is told to the GM; nothing moves and the group still ends", async () => {
  const {log, ana, tokens, scene} = await ridden({others: [["bandit", 1500, 500]]});
  await tokens.bandit.update({x: 500, y: 500});
  log.length = 0;
  const notices = asUser("gm", {scene});
  await ana.revertTransformation();
  assert.deepEqual(log, [["end", "soul"], ["deleted", "ActiveEffect-0"]]);
  assert.deepEqual([tokens.ana.x, tokens.guard.x], [1200, 500]);
  assert.deepEqual(notices, ["WILDPATH.NOTICE.FormPlaceTaken Ana"]);
});

test("another client's ending is put back by the active GM's hook, once; the GM's own deletion is not put back again", async () => {
  const handlers = [];
  const previousHooks = globalThis.Hooks;
  const game = {user: {id: "gm", isGM: true}, users: {activeGM: {id: "gm"}}, socket: {on() {}, emit() {}}, i18n: {localize: key => key}};
  globalThis.Hooks = {callAll() { return false; }, on(name, fn) { if ( name === "deleteActiveEffect" ) handlers.push(fn); }};
  try {
    assert.equal(registerFoundryV14MultiplayerResolution({game}).ok, true);
  } finally {
    globalThis.Hooks = previousHooks;
  }
  const fire = async (effect, userId) => { for ( const handler of handlers ) handler(effect, {}, userId); await new Promise(setImmediate); };

  const {log, ana, scene} = await ridden();
  const [effect] = ana.effects;
  asUser("player", {scene});
  await ana.revertTransformation();
  assert.deepEqual(log, [["deleted", "ActiveEffect-0"]], "a player's client moves no Token it may not");
  game.user.id = "player";
  await fire(effect, "player");
  assert.equal(log.length, 1, "only the active GM puts them back");
  game.user.id = "gm";
  asUser("gm", {scene});
  await fire(effect, "player");
  assert.deepEqual(log.slice(1), [["move", "ana", 500, 500], ["move", "guard", 1200, 500], ["end", "soul"]]);

  const own = await ridden();
  const [ownEffect] = own.ana.effects;
  await own.ana.revertTransformation();
  await fire(ownEffect, "gm");
  assert.deepEqual(own.log.filter(([kind]) => kind === "move").length, 2, "traded back once, not traded again by the hook");
});

test("the active GM puts back only a body this possession holds, and only its creature's own Tokens: flags a player wrote move and end nothing", async () => {
  // A player's own effect naming the Guard, never possessed: its Token where it stands, its soul effect's group.
  const plain = world({others: [["bandit", 1500, 500]]});
  asUser("gm", plain);
  const forged = {id: "forged", parent: plain.ana, flags: {wildpath: {transformation: {formRef: plain.guard.uuid,
    tokenSizes: [{uuid: plain.tokens.bandit.uuid, width: 3, height: 3}],
    inPlace: {tokenUuid: plain.tokens.bandit.uuid, formTokenUuid: plain.tokens.guard.uuid, formEffectGroup: GROUP, from: {x: 900, y: 500}}}}}};
  await plain.ana.releasePlace(forged);
  assert.deepEqual(plain.log, [], "no Token moved or resized, no effect of the Guard ended");

  // A real possession whose inPlace and tokenSizes were edited to name the Bandit: the body comes back, the Bandit is left alone.
  const {log, ana, tokens} = await ridden({others: [["bandit", 1500, 500]]});
  const place = ana.effects[0].flags.wildpath.transformation;
  place.inPlace = {...place.inPlace, tokenUuid: tokens.bandit.uuid};
  place.tokenSizes = [{uuid: tokens.bandit.uuid, width: 3, height: 3}];
  await ana.releasePlace(ana.effects[0]);
  assert.deepEqual(log, [["end", "soul"]], "only the group ends; the Bandit neither swaps nor resizes");
});

test("a forward swap that never ran is not traded back; the group still ends", async () => {
  const {log, ana, tokens, scene} = await ridden({swapped: false});
  const notices = asUser("gm", {scene});
  await ana.revertTransformation();
  assert.deepEqual(log, [["end", "soul"], ["deleted", "ActiveEffect-0"]]);
  assert.deepEqual([tokens.ana.x, tokens.guard.x], [1200, 900], "each stays where it is");
  assert.deepEqual(notices, []);
});

test("ending it from the sheet gives the creature its own size back before the swap, so a Large body's footprint does not refuse it", async () => {
  const {log, ana, tokens} = await ridden({bodySize: 2, others: [["bandit", 600, 600]]});
  assert.deepEqual([tokens.ana.width, tokens.guard.x], [2, 500], "Ana took the Large body's size and its place");
  await ana.effects[0].delete();
  assert.deepEqual(log, [["size", "ana", 1, 1], ["move", "ana", 500, 500], ["move", "guard", 1200, 500], ["end", "soul"],
    ["deleted", "ActiveEffect-0"]], "Medium again, she fits beside the bandit in the space she left");
});

test("ending it while the creature stands on the hidden body's own square is no refusal", async () => {
  const {log, ana, scene} = await ridden({to: {x: 500, y: 500}});
  const notices = asUser("gm", {scene});
  await ana.revertTransformation();
  assert.deepEqual(log, [["move", "ana", 500, 500], ["move", "guard", 500, 500], ["end", "soul"], ["deleted", "ActiveEffect-0"]],
    "the body, on its own plane until its group ends, holds no space against her");
  assert.deepEqual(notices, []);
});

test("concentration ending skips an effect an earlier holder's ending already ended, and goes on to the next holder", async () => {
  const sustained = id => ({id, uuid: `Effect.${id}`, flags: {wildpath: {conditionEffect: {concentration: {sourceRef: "Actor.ana"}}}}});
  const holder = (uuid, effects, cascade=null) => ({uuid, effects, deleted: [],
    async deleteEmbeddedDocuments(type, ids) {
      // As V14's client backend: an id no longer held throws.
      if ( ids.some(id => !this.effects.some(effect => effect.id === id)) ) throw new Error(`${uuid} has no ${ids}`);
      this.deleted.push(...ids);
      this.effects = this.effects.filter(effect => !ids.includes(effect.id));
      if ( cascade ) await cascade();
    }});
  const guard = holder("Scene.s.Token.guard.Actor.guard", [sustained("g")]);
  const wolf = holder("Scene.s.Token.wolf.Actor.wolf", [sustained("w")]);
  const ana = Object.assign(holder("Actor.ana", [sustained("t")], () => guard.deleteEmbeddedDocuments("ActiveEffect", ["g"])),
    {id: "ana", prototypeToken: {actorLink: true}});
  const game = {actors: [ana], scenes: [{id: "s", tokens: [{id: "guard", actor: guard}, {id: "wolf", actor: wolf}]}],
    user: {id: "gm"}, users: {activeGM: {id: "gm"}}};
  const ended = await endLostConcentration({options: {actor: ana}, state: {results: {concentrationResolution: {startedLost: true}}}}, {game});
  assert.deepEqual(ended, ["Effect.t", "Effect.g", "Effect.w"]);
  assert.deepEqual([ana.deleted, guard.deleted, wolf.deleted], [["t"], ["g"], ["w"]], "the wolf's effect still ends");
});

const POSSESS = {schemaVersion: 1, id: "action:possess", label: "Possess", costs: {allOf: []}, targeting: {type: "single"},
  save: {ability: "presence", dc: {value: 15}}, swap: true, transform: {formFrom: "target", copies: [], hitPoints: "form", inPlace: true}};

test("inPlace is true, on a formFrom target Action that swaps; it records the Tokens and the group its use gave the body", async () => {
  const valid = (transform, extra={}) => validateActionDefinition({...POSSESS, ...extra, transform: {...POSSESS.transform, ...transform}}).ok;
  assert.equal(valid({}), true);
  assert.equal(valid({inPlace: false}), false);
  assert.equal(valid({inPlace: "yes"}), false);
  assert.equal(valid({}, {swap: undefined}), false, "nothing traded them, so nothing trades them back");
  assert.equal(valid({formFrom: undefined, formRef: "Actor.bear", hitPoints: undefined}), false);
  assert.equal(valid({inPlace: undefined}), true);

  const {scene, ana, tokens} = world();
  // The Guard also holds an effect the same Action gave it from someone else's use.
  tokens.guard.actor.effects.unshift({id: "other", flags: {wildpath: {conditionEffect: {sourceRef: "Actor.zed", metadata: {actionDefinitionId: "action:possess"}}}}});
  asUser("gm", {scene});
  const calls = [];
  const state = {actionDefinition: POSSESS, source: {tokenRef: "Scene.s.Token.ana", tokenId: "ana"},
    results: {saveResolution: {results: [{ok: true, success: false, target: {tokenId: "guard"}}]}}};
  const user = {...ana, uuid: ana.uuid, id: ana.id, async transform(form, policy) { calls.push([form.name, policy]); }};
  await applyActionTransformation({options: {actor: user}, state}, {fromUuid: globalThis.fromUuid});
  assert.deepEqual(calls, [["Guard", {copies: [], hitPoints: "form", inPlace: PLACE}]]);
  calls.length = 0;
  await applyActionTransformation({options: {actor: user}, state: {...state, actionDefinition: {...POSSESS, transform: {...POSSESS.transform,
    inPlace: undefined}}}}, {fromUuid: globalThis.fromUuid});
  assert.deepEqual(calls, [["Guard", {copies: [], hitPoints: "form"}]], "without it, nothing is recorded");
});

test("form.distance: how far the Token riding a body stands from the body's Token, which an Action's requires reads (wave D B18)", async () => {
  const {requiresContext} = await import("../module/helpers/combat.mjs");
  const {evaluatePredicate} = await import("../module/helpers/predicates.mjs");
  const {ana, scene, tokens} = await ridden();
  Object.assign(scene.grid, {type: 1, size: 100, distance: 5});
  // Return from Host: "if the container is within 100 feet of you".
  const returns = (actor) => evaluatePredicate({atMost: {path: "form.distance", value: 100}}, requiresContext(actor)).ok;
  assert.equal(ana.formDistance, 35, "Ana walked the body to 1200; the Guard's hidden Token holds her space at 500");
  assert.deepEqual(requiresContext(ana).form, {distance: 35});
  assert.equal(returns(ana), true);
  await tokens.ana.update({x: 4000, y: 500});
  assert.equal(ana.formDistance, 175);
  assert.equal(returns(ana), false, "past 100 feet");
  tokens.guard.parent = {id: "elsewhere"};
  assert.equal(ana.formDistance, null, "a body on another Scene");
  tokens.guard.parent = scene;
  scene.grid.type = 0;
  assert.equal(ana.formDistance, null, "a gridless Scene has no footprints to measure between");
  assert.equal(returns(ana), false);
  scene.grid.type = 1;
  await ana.revertTransformation();
  assert.equal(ana.formDistance, null, "no transformation");

  const plain = world();
  asUser("gm", plain);
  await plain.ana.transform(plain.guard, {copies: []});
  assert.deepEqual(requiresContext(plain.ana).form, {distance: null}, "a transformation that does not stand in its body's place");
  assert.equal(returns(plain.ana), false);
});
