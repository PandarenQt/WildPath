import {test} from "node:test";
import assert from "node:assert/strict";
import {
  CONCENTRATION_CODES,
  CONCENTRATION_EVENT_TYPES,
  CONCENTRATION_OUTCOMES,
  planConcentrationChecks,
  resolveConcentrationCheckResults,
  resolveConcentrationDecisions
} from "../module/resolvers/concentration-resolver.mjs";
import {createConcentrationRollRequest} from "../module/helpers/rolls.mjs";
import {
  createTestRollProvider,
  executeRollRequest
} from "../module/resolvers/roll-provider-resolver.mjs";

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

test("ConcentrationResolver resolves check rolls into maintained save events", () => {
  const planning = planConcentrationChecks({
    damageResults: [{
      ok: true,
      code: "OK",
      target: {id: "caster", actorId: "actor-caster"},
      total: 28
    }],
    concentrationStates: {
      "actor:actor-caster": {
        active: true,
        actorId: "actor-caster",
        originRef: "item:haste"
      }
    }
  });
  const request = planning.checkRequests[0];
  const result = resolveConcentrationCheckResults({
    checkPlanning: planning,
    rolls: {
      [request.id]: {total: 16, die: 11, mode: "digital"}
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, CONCENTRATION_CODES.OK);
  assert.equal(result.decisionEvents.length, 1);
  assert.equal(result.decisionEvents[0].type, CONCENTRATION_EVENT_TYPES.SAVE_RESOLVED);
  assert.equal(result.decisions[0].success, true);
  assert.equal(result.decisions[0].outcome, CONCENTRATION_OUTCOMES.MAINTAINED);
  assert.equal(result.decisions[0].dc, 14);
  assert.equal(result.breakEvents.length, 0);
  assert.equal(result.maintained.length, 1);
});

test("ConcentrationResolver accepts normalized RollResults from the shared RollProvider path", async () => {
  const planning = planConcentrationChecks({
    damageResults: [{
      ok: true,
      code: "OK",
      target: {id: "caster", actorId: "actor-caster"},
      total: 28
    }],
    concentrationStates: {
      "actor:actor-caster": {
        active: true,
        actorId: "actor-caster",
        originRef: "item:haste"
      }
    }
  });
  const checkRequest = planning.checkRequests[0];
  const rollRequest = createConcentrationRollRequest({
    checkRequest,
    resolutionId: "resolution:concentration-roll",
    modifier: 5
  });
  const provided = await executeRollRequest({
    request: rollRequest,
    providers: [createTestRollProvider({natural: 9})]
  });
  const result = resolveConcentrationCheckResults({
    checkPlanning: planning,
    rolls: {
      [checkRequest.id]: provided.result
    }
  });

  assert.equal(provided.ok, true);
  assert.equal(provided.result.requestId, checkRequest.id);
  assert.equal(provided.result.total, 14);
  assert.equal(result.ok, true);
  assert.equal(result.decisions[0].success, true);
  assert.equal(result.decisions[0].roll.metadata.rollResult.requestId, checkRequest.id);
  assert.equal(result.breakEvents.length, 0);
});

test("ConcentrationResolver resolves failed check rolls into break events", () => {
  const planning = planConcentrationChecks({
    damageResults: [{
      ok: true,
      code: "OK",
      target: {id: "caster", actorId: "actor-caster"},
      total: 30
    }],
    concentrationStates: true
  });
  const result = resolveConcentrationCheckResults({
    checkRequests: planning.checkRequests,
    rolls: {
      "actor:actor-caster": {total: 9, die: 4, mode: "physical-entry"}
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.decisions[0].success, false);
  assert.equal(result.decisions[0].outcome, CONCENTRATION_OUTCOMES.BROKEN);
  assert.equal(result.breakEvents.length, 1);
  assert.equal(result.breakEvents[0].type, CONCENTRATION_EVENT_TYPES.BROKEN);
  assert.equal(result.breakEvents[0].actorRef, "actor:actor-caster");
  assert.equal(result.breakEvents[0].metadata.dc, 15);
});

test("ConcentrationResolver accepts explicit GM-entered concentration outcomes", () => {
  const planning = planConcentrationChecks({
    damageResults: [{
      ok: true,
      code: "OK",
      target: {id: "caster", actorId: "actor-caster"},
      total: 12
    }],
    concentrationStates: {
      "actor:actor-caster": {
        active: true,
        actorId: "actor-caster",
        sourceRef: "actor:actor-caster",
        originRef: "item:fly"
      }
    }
  });
  const result = resolveConcentrationCheckResults({
    checkPlanning: planning,
    results: {
      "actor:actor-caster": {
        outcome: "failed",
        mode: "gm-physical-dice"
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.decisions[0].total, null);
  assert.equal(result.decisions[0].dc, 10);
  assert.equal(result.decisions[0].success, false);
  assert.equal(result.breakEvents.length, 1);
  assert.equal(result.breakEvents[0].originRef, "item:fly");
});

test("ConcentrationResolver reports missing check results explicitly", () => {
  const planning = planConcentrationChecks({
    damageResults: [{
      ok: true,
      code: "OK",
      target: {id: "caster", actorId: "actor-caster"},
      total: 18
    }],
    concentrationStates: true
  });
  const result = resolveConcentrationCheckResults({
    checkPlanning: planning,
    rolls: []
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CONCENTRATION_CODES.NO_CHECK_RESULTS);
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].code, CONCENTRATION_CODES.MISSING_CHECK_RESULT);
  assert.equal(result.decisionEvents.length, 0);
});

test("ConcentrationResolver reports malformed matched check results explicitly", () => {
  const planning = planConcentrationChecks({
    damageResults: [{
      ok: true,
      code: "OK",
      target: {id: "caster", actorId: "actor-caster"},
      total: 18
    }],
    concentrationStates: true
  });
  const result = resolveConcentrationCheckResults({
    checkPlanning: planning,
    rolls: {
      "actor:actor-caster": {mode: "digital"}
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CONCENTRATION_CODES.INVALID_CHECK_RESULT);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].code, CONCENTRATION_CODES.INVALID_CHECK_RESULT);
  assert.equal(result.failures[0].saveCode, "MISSING_SAVE_TOTAL");
});
