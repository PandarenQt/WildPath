import {test} from "node:test";
import assert from "node:assert/strict";
import {WILDPATH} from "../module/config.mjs";
import {d20FormulaWith} from "../module/helpers/rolls.mjs";
import {rollModesFromRuleElements} from "../module/helpers/rule-elements.mjs";
import {endConcentrationOnIncapacitation, endEarlierConcentration, startsConcentration, sustainedEffects}
  from "../module/resolvers/foundry-multiplayer-runtime.mjs";

test("initiative rolls 2d20 with advantage or disadvantage and adds its Modifiers", () => {
  assert.equal(d20FormulaWith("1d20", {rollMode: "disadvantage", modifier: -4}), "2d20kl - 4");
  assert.equal(d20FormulaWith("1d20 + @abilities.agility.mod", {rollMode: "advantage"}), "2d20kh + @abilities.agility.mod");
  assert.equal(d20FormulaWith("1d20"), "1d20");
});

test("2024 Incapacitated: disadvantage on initiative, concentration ends, and Unconscious is also Prone", () => {
  for ( const id of ["stunned", "unconscious"] ) {
    assert.deepEqual(rollModesFromRuleElements([{ruleElements: WILDPATH.CONDITIONS[id].ruleElements}], {domains: ["initiative"]})
      .map(entry => entry.mode), ["disadvantage"], id);
    assert.equal(WILDPATH.CONDITIONS[id].endsConcentration, true, id);
  }
  assert.equal(WILDPATH.CONDITIONS.dead.endsConcentration, true);
  assert.deepEqual(WILDPATH.CONDITIONS.unconscious.implies, ["prone"]);
  assert.equal(WILDPATH.CONDITIONS.prone.endsConcentration, undefined, "Prone alone does not");
});

/** A creature holding `effects`; it records what it deletes. */
function holder(id, effects=[]) {
  return {id, uuid: `Actor.${id}`, effects, deleted: [],
    async deleteEmbeddedDocuments(type, ids) { this.deleted.push(...ids); }};
}
const sustained = (id, sourceRef) => ({id, uuid: `Effect.${id}`, flags: {wildpath: {conditionEffect: {concentration: {sourceRef}}}}});

test("a caster who becomes Incapacitated ends every effect it sustains, wherever it is, and nothing else", async () => {
  const caster = holder("caster", [sustained("marker", "token:caster-token")]);
  const ally = holder("ally", [sustained("blessed", "token:scene-a.caster-token"), sustained("hasted", "Actor.someone-else")]);
  const enemy = holder("enemy", [sustained("held", "Actor.caster")]);
  const scene = {id: "scene-a", tokens: [{id: "caster-token", uuid: "Scene.scene-a.Token.caster-token", actorLink: true,
    actorId: "caster", actor: caster, parent: null}]};
  scene.tokens[0].parent = scene;
  const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, actors: [caster, ally, enemy], scenes: [scene]};
  const ended = await endConcentrationOnIncapacitation({system: {type: "stunned"}, parent: caster}, game);
  assert.deepEqual(ended.sort(), ["Effect.blessed", "Effect.held", "Effect.marker"]);
  assert.deepEqual([caster.deleted, ally.deleted, enemy.deleted], [["marker"], ["blessed"], ["held"]]);
  assert.deepEqual(await endConcentrationOnIncapacitation({system: {type: "prone"}, parent: caster}, game), [],
    "a condition that does not incapacitate ends nothing");
});

test("a new concentration ends the caster's earlier one, as it stood when declared; a follow-up of the same spell does not", async () => {
  const mark = {effects: [{id: "mark", type: "effect", concentration: true}]};
  assert.equal(startsConcentration(mark), true, "a concentration effect");
  assert.equal(startsConcentration({area: {persistence: {concentration: true}}}), true, "a lasting concentration area");
  assert.equal(startsConcentration({summon: {actorRef: "x", concentration: true}}), true, "a concentration summon");
  assert.equal(startsConcentration({...mark, metadata: {followUp: true}}), false, "Move Mark continues the spell");
  assert.equal(startsConcentration({effects: [{id: "prone", type: "condition"}]}), false);

  const caster = holder("caster", [sustained("moonbeam-marker", "token:caster-token")]);
  // A spell's effect names its casting Item.
  const enemy = holder("enemy", [sustained("bane", "uuid:Actor.caster.Item.bane"), sustained("other", "Actor.someone-else")]);
  const scene = {id: "scene-a", tokens: [{id: "caster-token", uuid: "Scene.scene-a.Token.caster-token", actorLink: true,
    actorId: "caster", actor: caster, parent: null}]};
  scene.tokens[0].parent = scene;
  const game = {actors: [caster, enemy], scenes: [scene]};
  const snapshot = sustainedEffects(caster, game).map(({effect}) => effect.uuid);
  assert.deepEqual(snapshot.sort(), ["Effect.bane", "Effect.moonbeam-marker"]);
  const deleted = [];
  const documents = Object.fromEntries(snapshot.map(uuid => [uuid, {uuid, delete: async () => deleted.push(uuid)}]));
  const ended = await endEarlierConcentration({options: {endsConcentration: [...snapshot, "Effect.gone"]}},
    {fromUuid: async uuid => documents[uuid] ?? null});
  assert.deepEqual(ended.sort(), ["Effect.bane", "Effect.moonbeam-marker"], "what it sustained, not what this Action made");
  assert.deepEqual(deleted.sort(), ["Effect.bane", "Effect.moonbeam-marker"]);
});
