import {test} from "node:test";
import assert from "node:assert/strict";
import {
  CONCENTRATION_CODES,
  CONCENTRATION_EVENT_TYPES,
  CONCENTRATION_OUTCOMES,
  planConcentrationChecks,
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

test("ConcentrationResolver plans concentration checks from damage taken", () => {
  const result = planConcentrationChecks({
    damageResults: [{
      ok: true,
      code: "OK",
      target: {id: "caster", actorId: "actor-caster"},
      total: 24,
      components: [{amount: 24, damageType: "slashing"}]
    }],
    concentrationStates: {
      "actor:actor-caster": {
        active: true,
        actorId: "actor-caster",
        originRef: "item:spell"
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, CONCENTRATION_CODES.OK);
  assert.equal(result.checkRequests.length, 1);
  assert.equal(result.checkRequests[0].dc, 12);
  assert.equal(result.checkRequests[0].damageTaken, 24);
  assert.equal(result.checkRequests[0].actorRef, "actor:actor-caster");
  assert.equal(result.checkRequests[0].originRef, "item:spell");
  assert.equal(result.checkRequests[0].saveKey, "concentration");
  assert.equal(result.checkRequests[0].ability, "con");
});

test("ConcentrationResolver applies minimum DC and skips non-concentrating targets", () => {
  const result = planConcentrationChecks({
    damageResults: [
      {
        ok: true,
        code: "OK",
        target: {id: "wizard", actorId: "actor-wizard"},
        total: 3,
        components: [{amount: 3}]
      },
      {
        ok: true,
        code: "OK",
        target: {id: "fighter", actorId: "actor-fighter"},
        total: 20,
        components: [{amount: 20}]
      }
    ],
    concentrationStates: {
      "actor:actor-wizard": true
    }
  });

  assert.equal(result.checkRequests.length, 1);
  assert.equal(result.checkRequests[0].dc, 10);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, "notConcentrating");
});

test("ConcentrationResolver supports custom DC policies", () => {
  const result = planConcentrationChecks({
    damageResults: [{
      ok: true,
      code: "OK",
      target: {id: "caster", actorId: "actor-caster"},
      total: 37,
      components: [{amount: 37}]
    }],
    concentrationStates: true,
    policy: {
      minimumDC: 12,
      damageDivisor: 3,
      rounding: "ceil",
      ability: "wis"
    }
  });

  assert.equal(result.checkRequests[0].dc, 13);
  assert.equal(result.checkRequests[0].ability, "wis");
});

test("ConcentrationResolver can read concentration state from target system snapshots", () => {
  const result = planConcentrationChecks({
    damageResults: [{
      ok: true,
      code: "OK",
      target: {id: "caster", actorId: "actor-caster"},
      total: 14,
      components: [{amount: 14}]
    }],
    targetSystems: {
      "actor:actor-caster": {
        status: {
          concentration: {
            active: true,
            originRef: "item:bless"
          }
        }
      }
    }
  });

  assert.equal(result.checkRequests.length, 1);
  assert.equal(result.checkRequests[0].dc, 10);
  assert.equal(result.checkRequests[0].originRef, "item:bless");
});
