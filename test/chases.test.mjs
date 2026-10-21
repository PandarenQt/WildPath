import {test} from "node:test";
import assert from "node:assert/strict";
import {afterChaseAction, freeDashes} from "../module/applications/chases.mjs";

test("in a chase, Dashes past 3 + Fortitude modifier take a DC 10 check or give Exhaustion", async () => {
  assert.deepEqual([freeDashes({system: {abilities: {fortitude: {value: 14}}}}), freeDashes({system: {abilities: {fortitude: {value: 2}}}})], [5, 0]);
  const toggled = [];
  const rolls = [12, 4];
  const actor = {uuid: "Actor.runner", flags: {wildpath: {}}, system: {abilities: {fortitude: {value: 10}}},
    setFlag: async (scope, key, value) => { actor.flags.wildpath[key] = value; }, rollTest: async () => rolls.shift(),
    toggleCondition: async id => toggled.push(id)};
  const game = {user: {isGM: true, id: "gm"}, users: {activeGM: {id: "gm"}}, combat: {flags: {wildpath: {chase: true}}, combatants: [{actor: {uuid: "Actor.runner"}}]}};
  const dash = () => afterChaseAction({options: {actor}, state: {actionDefinition: {id: "common:dash"}}}, {game});
  const results = [];
  for ( let i = 0; i < 5; i++ ) results.push(await dash());
  assert.deepEqual(results.map(result => [result.dashes, result.free, result.failed]),
    [[1, true, undefined], [2, true, undefined], [3, true, undefined], [4, false, false], [5, false, true]]);
  assert.deepEqual(toggled, ["exhaustion"]);
  assert.equal(await afterChaseAction({options: {actor}, state: {actionDefinition: {id: "common:dash"}}},
    {game: {...game, combat: {flags: {}}}}), null, "not in a chase");
});
