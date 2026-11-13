import {test} from "node:test";
import assert from "node:assert/strict";
import {CONTAGIONS, fightContagion} from "../module/helpers/contagions.mjs";
import {createFoundryContagions} from "../module/adapters/foundry-v14-contagions.mjs";

test("fighting a contagion: Cackle Fever ends after three successes; Sewer Plague moves Exhaustion and ends at none", () => {
  let state = {successes: 0};
  for ( const success of [true, false, true] ) state = fightContagion("cackle-fever", state, success).state;
  assert.deepEqual(fightContagion("cackle-fever", state, true), {exhaustion: 0, state: {successes: 3}, ended: true});
  assert.deepEqual(fightContagion("sewer-plague", {}, false, {exhaustionLevel: 1}), {exhaustion: 1, state: {}, ended: false});
  assert.deepEqual(fightContagion("sewer-plague", {}, true, {exhaustionLevel: 2}), {exhaustion: -1, state: {}, ended: false});
  assert.equal(fightContagion("sewer-plague", {}, true, {exhaustionLevel: 1}).ended, true, "at no Exhaustion it ends");
  assert.equal(fightContagion("sight-rot", {}, true).ended, false, "magic ends it, not a save");
  assert.deepEqual([CONTAGIONS["sight-rot"].incubation, CONTAGIONS["sight-rot"].onset], [null, {condition: "blinded"}]);
});

test("Sight Rot: magic ending its Blinded ends it; a Blinded whose own time ran out does not, and its creature stays Blinded", async () => {
  const contagions = createFoundryContagions({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}}});
  const make = (others=[]) => {
    const actor = {effects: [...others], toggled: [], async toggleCondition(type) { this.toggled.push(type); }};
    const rot = {id: "rot", parent: actor, deleted: false, flags: {wildpath: {contagion: {id: "sight-rot", started: true}}},
      async delete() { this.deleted = true; }};
    actor.effects.push(rot);
    const blinded = remaining => ({id: "blind", parent: actor, system: {type: "blinded"}, duration: {remaining}});
    return {actor, rot, blinded};
  };
  for ( const remaining of [5, Infinity, undefined] ) {
    const {rot, blinded} = make();
    await contagions.onEffectDeleted(blinded(remaining));
    assert.equal(rot.deleted, true, `cured with ${remaining} left (Lesser Restoration)`);
  }
  const expired = make();
  await contagions.onEffectDeleted(expired.blinded(0));
  assert.deepEqual([expired.rot.deleted, expired.actor.toggled], [false, ["blinded"]], "a spell's Blinded ran out: still Sight Rot, Blinded again");
  const stillBlind = make([{id: "other", system: {type: "blinded"}}]);
  await contagions.onEffectDeleted(stillBlind.blinded(0));
  assert.deepEqual([stillBlind.rot.deleted, stillBlind.actor.toggled], [false, []], "another Blinded remains: none added");
});
