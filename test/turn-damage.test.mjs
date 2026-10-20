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
  const actor = {uuid: "Actor.pc", getActiveTokens: () => [{id: "token-a", parent: {id: "scene-a"}}]};
  assert.equal(await turnDamage.apply(actor, {amount: 4, damageType: "necrotic", token: elsewhere}), true);
  assert.deepEqual([intents[0].source, intents[0].targetRefs[0]], [{tokenId: "token-b", sceneId: "scene-b"},
    {actorRef: "Actor.pc", tokenId: "token-b", sceneId: "scene-b"}], "the combat's Token, though another Scene is viewed");
  assert.equal(await turnDamage.apply({uuid: "Actor.lone", getActiveTokens: () => []}, {amount: 4}), true);
  assert.deepEqual([intents[1].source, intents[1].targetRefs[0]], [{}, {actorRef: "Actor.lone"}],
    "no Token: it still resolves, on the creature (resistances, rescue, dying)");
  assert.equal(await turnDamage.apply(actor, {amount: 0}), false, "no damage, nothing to resolve");
  assert.equal(intents.length, 2);
});
