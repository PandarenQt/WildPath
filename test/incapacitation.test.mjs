import {test} from "node:test";
import assert from "node:assert/strict";
import {WILDPATH} from "../module/config.mjs";
import {d20FormulaWith} from "../module/helpers/rolls.mjs";
import {rollModesFromRuleElements} from "../module/helpers/rule-elements.mjs";
import {endConcentrationOnIncapacitation} from "../module/resolvers/foundry-multiplayer-runtime.mjs";

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
