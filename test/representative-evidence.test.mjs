import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

import {REPRESENTATIVE_CASES} from "../docs/development/representative-live-qa.mjs";

const read = name => JSON.parse(readFileSync(new URL(`../evidence/representative-${name}.json`, import.meta.url), "utf8"));

test("every two-browser representative case has passing, correlated GM and Player evidence", () => {
  for ( const caseId of Object.keys(REPRESENTATIVE_CASES) ) {
    const gm = read(`${caseId}-gm`);
    const player = read(`${caseId}-player`);
    assert.equal(gm.caseId, caseId);
    assert.deepEqual(gm.proof, {passed: true, failures: []}, caseId);
    assert.match(gm.gitSha, /^[0-9a-f]{40}$/u, `${caseId} names the served commit`);
    assert.equal(gm.runtime.build, 369);
    assert.equal(gm.status, "completed");
    assert.equal(player.resolutionId, gm.resolutionId, `${caseId} GM and Player describe one resolution`);
    assert.equal(player.runId, gm.runId);
    assert.equal(player.gitSha, gm.gitSha);
    assert.equal(player.result?.status, "completed", `${caseId} reached the Player`);
    assert.equal(player.card?.visible, true, `${caseId} card is visible to the Player`);
    assert.notEqual(gm.users.playerId, gm.users.gmId);
  }
});

test("the routing each case exists to prove reached the Player", () => {
  const routedTo = (caseId, type) => read(`${caseId}-gm`).routing
    .filter(entry => (entry.rollType ?? entry.type) === type).map(entry => entry.expectedUserId);
  const player = caseId => read(`${caseId}-gm`).users.playerId;
  assert.deepEqual(routedTo("melee-dice", "attack"), [player("melee-dice")]);
  assert.deepEqual(routedTo("melee-dice", "damage"), [player("melee-dice")]);
  assert.deepEqual(routedTo("save-routed", "saving-throw"), [player("save-routed")], "a GM's save routes to the target's Player");
  assert.deepEqual(routedTo("configuration", "action-configuration"), [player("configuration")]);
});
