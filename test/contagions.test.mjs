import {test} from "node:test";
import assert from "node:assert/strict";
import {CONTAGIONS, fightContagion} from "../module/helpers/contagions.mjs";

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
