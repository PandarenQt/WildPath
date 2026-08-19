import {test} from "node:test";
import assert from "node:assert/strict";
import {
  CONCENTRATION_CODES,
  CONCENTRATION_EVENT_TYPES,
  CONCENTRATION_OUTCOMES,
  resolveConcentrationDecisions
} from "../module/resolvers/concentration-resolver.mjs";

test("ConcentrationResolver converts failed save decisions into break events", () => {
  const result = resolveConcentrationDecisions({
    decisions: [{
      actorId: "caster",
      originRef: "item:spell",
      success: false,
      total: 8,
      dc: 10
    }]
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, CONCENTRATION_CODES.OK);
  assert.equal(result.breakEvents.length, 1);
  assert.equal(result.breakEvents[0].type, CONCENTRATION_EVENT_TYPES.BROKEN);
  assert.equal(result.breakEvents[0].actorRef, "actor:caster");
  assert.equal(result.breakEvents[0].originRef, "item:spell");
  assert.equal(result.breakEvents[0].metadata.total, 8);
  assert.equal(result.breakEvents[0].metadata.dc, 10);
});

test("ConcentrationResolver records successful saves without break events", () => {
  const result = resolveConcentrationDecisions({
    decisions: [{
      sourceRef: "actor:caster",
      outcome: "maintained"
    }]
  });

  assert.equal(result.ok, true);
  assert.equal(result.breakEvents.length, 0);
  assert.equal(result.maintained.length, 1);
  assert.equal(result.maintained[0].outcome, CONCENTRATION_OUTCOMES.MAINTAINED);
});

test("ConcentrationResolver accepts concentration save decision events", () => {
  const result = resolveConcentrationDecisions({
    events: [{
      type: CONCENTRATION_EVENT_TYPES.SAVE_RESOLVED,
      data: {
        sourceRef: "actor:caster",
        result: "failure"
      }
    }]
  });

  assert.equal(result.ok, true);
  assert.equal(result.breakEvents.length, 1);
  assert.equal(result.breakEvents[0].sourceRef, "actor:caster");
});

test("ConcentrationResolver ignores undecidable entries", () => {
  const result = resolveConcentrationDecisions({
    decisions: [{
      sourceRef: "actor:caster"
    }]
  });

  assert.equal(result.ok, true);
  assert.equal(result.breakEvents.length, 0);
  assert.equal(result.ignored.length, 1);
  assert.equal(result.ignored[0].outcome, CONCENTRATION_OUTCOMES.IGNORED);
});
