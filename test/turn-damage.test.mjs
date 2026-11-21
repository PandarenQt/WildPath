import {test} from "node:test";
import assert from "node:assert/strict";
import {createFoundryTurnDamage} from "../module/adapters/foundry-v14-turn-damage.mjs";

/** A turn damage whose authority records each intent it is asked to resolve. */
function recorder() {
  const intents = [];
  const resolveAction = async ({intent}) => { intents.push(intent); return {ok: true}; };
  const coordinator = {resolveAuthorityAction: async ({onComplete}) => { onComplete({state: {status: "completed"}}); return {ok: true}; }};
  return {intents, turnDamage: createFoundryTurnDamage({game: {user: {id: "gm"}}, coordinator, resolveAction, logger: {warn() {}}})};
}

test("condition damage resolves on the combat's Token, or on the creature alone when it has none on a Scene", async () => {
  const {intents, turnDamage} = recorder();
  const elsewhere = {id: "token-b", parent: {id: "scene-b"}};
  const actor = {uuid: "Actor.pc", getActiveTokens: () => [], getDependentTokens: () => [{id: "token-a", parent: {id: "scene-a"}}]};
  assert.equal(await turnDamage.apply(actor, {amount: 4, damageType: "necrotic", token: elsewhere}), true);
  assert.deepEqual([intents[0].source, intents[0].targetRefs[0]], [{tokenId: "token-b", sceneId: "scene-b"},
    {actorRef: "Actor.pc", tokenId: "token-b", sceneId: "scene-b"}], "the combat's Token, though another Scene is viewed");
  assert.equal(await turnDamage.apply({uuid: "Actor.lone", getDependentTokens: () => []}, {amount: 4}), true);
  assert.deepEqual([intents[1].source, intents[1].targetRefs[0]], [{}, {actorRef: "Actor.lone"}],
    "no Token: it still resolves, on the creature (resistances, rescue, dying)");
  assert.equal(await turnDamage.apply(actor, {amount: 0}), false, "no damage, nothing to resolve");
  await turnDamage.apply(actor, {amount: 4});
  assert.deepEqual(intents[2].source, {tokenId: "token-a", sceneId: "scene-a"}, "its own Token, on a Scene the GM is not viewing");
  assert.equal(intents.length, 3);
});

test("two sources' Burning due at its turn start are one 2d4 damage; another condition's is its own (Q19 (c), Q93 (b))", async () => {
  globalThis.Actor ??= class {};
  globalThis.foundry ??= {data: {fields: {}, ActiveEffectTypeDataModel: class {}}, utils: {isEmpty: value => Object.keys(value).length === 0}};
  Math.clamp ??= (value, min, max) => Math.min(Math.max(value, min), max);
  const {default: WildPathActor} = await import("../module/documents/actor.mjs");
  const {WILDPATH} = await import("../module/config.mjs");
  const instance = (id, conditionId, sourceRef) => ({id, type: "condition", name: conditionId, statuses: new Set([conditionId]),
    system: {type: conditionId, level: null, ruleElements: structuredClone(WILDPATH.CONDITIONS[conditionId].ruleElements)},
    flags: {wildpath: {conditionEffect: {conditionId, sourceRef}}}});
  const effects = [instance("fire-bolt", "burning", "uuid:Actor.mage"), instance("breath", "burning", "uuid:Actor.dragon"),
    {...instance("bleed", "bleeding", "uuid:Actor.wolf"), system: {type: "bleeding", level: 1, ruleElements: structuredClone(WILDPATH.CONDITIONS.bleeding.ruleElements)}}];
  const actor = Object.assign(Object.create(WildPathActor.prototype), {id: "pc", uuid: "Actor.pc", name: "Pc", effects, items: [],
    flags: {}, system: {resources: {health: {value: 30, max: 30}, temporary: {value: 0}}}, update: async () => {}});
  const applied = [];
  const previous = globalThis.game;
  globalThis.game = {wildpath: {turnDamage: {apply: async (_actor, options) => { applied.push(options); return true; }}}};
  try {
    await actor.applyConditionTriggers({events: [{type: "turn.started", actorId: "pc", data: {actorId: "pc"}}]});
  } finally {
    globalThis.game = previous;
  }
  const burning = applied.filter(entry => entry.damageType === "fire");
  assert.equal(burning.length, 1, "one damage instance: one concentration check, Resistance on the total");
  assert.deepEqual(burning[0].expression, {type: "add", terms: [{type: "dice", number: 1, faces: 4}, {type: "dice", number: 1, faces: 4}]},
    "each instance's own 1d4: 2d4");
  assert.equal(applied.length, 2, "the Bleeding beside it is its own damage");
});
