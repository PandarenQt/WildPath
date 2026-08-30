import {test} from "node:test";
import assert from "node:assert/strict";
import {createFoundryDigitalRollProvider} from "../module/adapters/foundry-digital-roll-provider.mjs";
import {
  ROLL_CODES,
  ROLL_MODES,
  ROLL_PROVIDER_OUTCOMES,
  ROLL_PROVENANCE_TYPES,
  ROLL_TYPES,
  cloneRollData,
  createD20RollRequest,
  createDamageRollRequest,
  createRollResult,
  rollFormulaForRequest,
  rollResultToResolverRoll,
  validateRollRequest,
  validateRollResult
} from "../module/helpers/rolls.mjs";
import {
  createManualRollProvider,
  createPhysicalDiceProvider,
  createRollProviderResolver,
  createTestRollProvider,
  executeRollRequest
} from "../module/resolvers/roll-provider-resolver.mjs";
import {resolveAttackAgainstDefense} from "../module/resolvers/attack-resolver.mjs";
import {resolveSaveAgainstDC} from "../module/resolvers/save-resolver.mjs";

test("fake and physical attack RollResults feed equivalent AttackResolver logic", async () => {
  const request = createD20RollRequest({
    id: "roll:attack",
    resolutionId: "resolution:attack",
    type: ROLL_TYPES.ATTACK,
    modifier: 5,
    source: {ref: "actor:hero"},
    target: {ref: "actor:orc"}
  });
  const fake = await executeRollRequest({
    request,
    providers: [createTestRollProvider({natural: 12})]
  });
  const physical = await executeRollRequest({
    request,
    providers: [createPhysicalDiceProvider()],
    context: {
      physicalRolls: {
        [request.id]: {requestId: request.id, resolutionId: request.resolutionId, type: request.type, natural: 12}
      }
    }
  });

  const fakeAttack = resolveAttackAgainstDefense({
    roll: rollResultToResolverRoll(fake.result),
    defense: {value: 17}
  });
  const physicalAttack = resolveAttackAgainstDefense({
    roll: rollResultToResolverRoll(physical.result),
    defense: {value: 17}
  });

  assert.equal(fake.ok, true);
  assert.equal(physical.ok, true);
  assert.equal(fake.result.total, 17);
  assert.equal(physical.result.total, 17);
  assert.equal(fake.result.provenance.type, ROLL_PROVENANCE_TYPES.FAKE);
  assert.equal(physical.result.provenance.type, ROLL_PROVENANCE_TYPES.PHYSICAL);
  assert.deepEqual(
    {ok: fakeAttack.ok, outcome: fakeAttack.outcome, hit: fakeAttack.hit, margin: fakeAttack.margin},
    {ok: physicalAttack.ok, outcome: physicalAttack.outcome, hit: physicalAttack.hit, margin: physicalAttack.margin}
  );
});

test("saving throw RollRequest resolves through a provider before SaveResolver consumes it", async () => {
  const request = createD20RollRequest({
    id: "roll:save",
    resolutionId: "resolution:save",
    type: ROLL_TYPES.SAVING_THROW,
    modifier: 4,
    dc: {value: 15, ability: "dex"},
    metadata: {ability: "dex"}
  });
  const roll = await executeRollRequest({
    request,
    providers: [createTestRollProvider({natural: 11})]
  });
  const save = resolveSaveAgainstDC({
    roll: rollResultToResolverRoll(roll.result),
    dc: request.dc
  });

  assert.equal(roll.ok, true);
  assert.equal(roll.result.natural, 11);
  assert.equal(roll.result.total, 15);
  assert.equal(save.ok, true);
  assert.equal(save.success, true);
});

test("generic ability check requests are not attack/save specific", async () => {
  const request = createD20RollRequest({
    id: "roll:ability",
    resolutionId: "resolution:check",
    type: ROLL_TYPES.ABILITY_CHECK,
    modifier: 2,
    metadata: {ability: "str"}
  });
  const result = await createRollProviderResolver({
    providers: [createTestRollProvider({natural: 9})]
  }).execute(request);

  assert.equal(result.ok, true);
  assert.equal(result.result.type, ROLL_TYPES.ABILITY_CHECK);
  assert.equal(result.result.natural, 9);
  assert.equal(result.result.total, 11);
});

test("damage RollResult preserves individual dice and total", async () => {
  const request = createDamageRollRequest({
    id: "roll:damage",
    resolutionId: "resolution:damage",
    formula: "3d8 + 4",
    components: [{
      id: "fire",
      expression: {type: "dice", number: 3, faces: 8, bonus: 4},
      damageType: "fire"
    }]
  });
  const result = await executeRollRequest({
    request,
    providers: [createTestRollProvider({
      result: {
        total: 17,
        dice: [{
          id: "fire-dice",
          number: 3,
          faces: 8,
          results: [4, 5, 4]
        }]
      }
    })]
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.total, 17);
  assert.equal(result.result.formula, "3d8 + 4");
  assert.deepEqual(result.result.dice[0].results.map(entry => entry.result), [4, 5, 4]);
});

test("advantage and disadvantage are request semantics, not provider-owned rules", () => {
  const advantage = createD20RollRequest({
    id: "roll:advantage",
    resolutionId: "resolution:advantage",
    type: ROLL_TYPES.ATTACK,
    modifier: 6,
    rollMode: ROLL_MODES.ADVANTAGE
  });
  const disadvantage = createD20RollRequest({
    id: "roll:disadvantage",
    resolutionId: "resolution:disadvantage",
    type: ROLL_TYPES.ATTACK,
    modifier: 6,
    rollMode: ROLL_MODES.DISADVANTAGE
  });

  assert.equal(rollFormulaForRequest(advantage).formula, "2d20kh + 6");
  assert.equal(rollFormulaForRequest(disadvantage).formula, "2d20kl + 6");
});

test("natural 20 and natural 1 remain distinct from modified totals", () => {
  const natural20 = createRollResult({
    request: createD20RollRequest({
      id: "roll:natural-20",
      resolutionId: "resolution:natural-20",
      type: ROLL_TYPES.ATTACK,
      modifier: -3
    }),
    natural: 20
  });
  const natural1 = createRollResult({
    request: createD20RollRequest({
      id: "roll:natural-1",
      resolutionId: "resolution:natural-1",
      type: ROLL_TYPES.ATTACK,
      modifier: 12
    }),
    natural: 1
  });

  assert.equal(natural20.natural, 20);
  assert.equal(natural20.total, 17);
  assert.equal(natural1.natural, 1);
  assert.equal(natural1.total, 13);
});

test("manual d20 input validation rejects illegal natural results", async () => {
  const request = createD20RollRequest({
    id: "roll:manual-invalid",
    resolutionId: "resolution:manual-invalid",
    type: ROLL_TYPES.ATTACK,
    modifier: 4
  });
  const result = await executeRollRequest({
    request,
    providers: [createPhysicalDiceProvider()],
    context: {
      physicalRolls: {
        [request.id]: {requestId: request.id, natural: 21}
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, ROLL_CODES.INVALID_MANUAL_RESULT);
});

test("manual roll results must correlate with the pending request", async () => {
  const request = createD20RollRequest({
    id: "roll:correlation",
    resolutionId: "resolution:correlation",
    type: ROLL_TYPES.ATTACK,
    modifier: 4
  });
  const result = await executeRollRequest({
    request,
    providers: [createManualRollProvider()],
    context: {
      manualResults: {
        [request.id]: {requestId: "roll:other", natural: 12}
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, ROLL_CODES.REQUEST_MISMATCH);
});

test("completed roll requests reject duplicate results as stale", async () => {
  const request = createD20RollRequest({
    id: "roll:stale",
    resolutionId: "resolution:stale",
    type: ROLL_TYPES.ATTACK,
    modifier: 1
  });
  const result = await executeRollRequest({
    request,
    providers: [createTestRollProvider({natural: 10})],
    completedRequestIds: [request.id]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, ROLL_CODES.STALE_ROLL_RESULT);
});

test("manual provider reports pending input and clean cancellation without mutating request", async () => {
  const request = createD20RollRequest({
    id: "roll:cancel",
    resolutionId: "resolution:cancel",
    type: ROLL_TYPES.ATTACK,
    modifier: 2
  });
  const before = cloneRollData(request);
  const pending = await executeRollRequest({
    request,
    providers: [createManualRollProvider()]
  });
  const cancelled = await executeRollRequest({
    request,
    providers: [createManualRollProvider()],
    context: {
      manualResults: {
        [request.id]: {requestId: request.id, cancelled: true}
      }
    }
  });

  assert.equal(pending.status, ROLL_PROVIDER_OUTCOMES.PENDING);
  assert.equal(pending.code, ROLL_CODES.MANUAL_INPUT_REQUIRED);
  assert.equal(cancelled.status, ROLL_PROVIDER_OUTCOMES.CANCELLED);
  assert.equal(cancelled.code, ROLL_CODES.ROLL_CANCELLED);
  assert.deepEqual(request, before);
});

test("RollRequest and RollResult reject non-plain persisted data", () => {
  const invalidRequest = validateRollRequest({
    id: "roll:bad-request",
    resolutionId: "resolution:bad",
    type: ROLL_TYPES.ATTACK,
    metadata: {created: new Date("2026-08-30T00:00:00.000Z")}
  });
  const invalidResult = validateRollResult({
    schemaVersion: 1,
    requestId: "roll:bad-result",
    resolutionId: "resolution:bad",
    type: ROLL_TYPES.DAMAGE,
    total: 4,
    raw: {map: new Map([["a", 1]])}
  });

  assert.equal(invalidRequest.ok, false);
  assert.equal(invalidRequest.code, ROLL_CODES.NON_SERIALIZABLE_ROLL_DATA);
  assert.equal(invalidResult.ok, false);
  assert.equal(invalidResult.code, ROLL_CODES.NON_SERIALIZABLE_ROLL_DATA);
});

test("RollRequest and RollResult round-trip through explicit plain-data cloning", () => {
  const request = createD20RollRequest({
    id: "roll:plain",
    resolutionId: "resolution:plain",
    type: ROLL_TYPES.ATTACK,
    modifier: 3,
    metadata: {source: "test"}
  });
  const result = createRollResult({request, natural: 14});
  const clonedRequest = cloneRollData(request);
  const clonedResult = cloneRollData(result);

  assert.deepEqual(clonedRequest, request);
  assert.deepEqual(clonedResult, result);
  assert.equal(validateRollRequest(clonedRequest).ok, true);
  assert.equal(validateRollResult(clonedResult, {request}).ok, true);
});

test("provider execution does not mutate the RollRequest", async () => {
  const request = createD20RollRequest({
    id: "roll:immutable",
    resolutionId: "resolution:immutable",
    type: ROLL_TYPES.ATTACK,
    modifier: 7,
    metadata: {nested: {value: 1}}
  });
  const before = cloneRollData(request);

  await executeRollRequest({
    request,
    providers: [createTestRollProvider({natural: 10})]
  });

  assert.deepEqual(request, before);
});

test("FoundryDigitalRollProvider isolates Foundry Roll objects behind a normalized result", async () => {
  const calls = [];
  class FakeRoll {
    constructor(formula, data, options) {
      this.formula = formula;
      this.data = data;
      this.options = options;
      this.total = null;
      this.dice = [];
      calls.push({formula, data, options});
    }

    async evaluate(options) {
      calls.push({evaluate: options});
      this.total = 15;
      this.dice = [{
        number: 1,
        faces: 20,
        modifiers: [],
        options: {id: "d20"},
        results: [{result: 11, active: true}]
      }];
      return this;
    }

    toJSON() {
      return {
        formula: this.formula,
        total: this.total,
        terms: [{class: "Die", number: 1, faces: 20}]
      };
    }
  }
  const request = createD20RollRequest({
    id: "roll:foundry",
    resolutionId: "resolution:foundry",
    type: ROLL_TYPES.SAVING_THROW,
    modifier: 4
  });
  const provider = createFoundryDigitalRollProvider({RollClass: FakeRoll});
  const result = await executeRollRequest({request, providers: [provider]});

  assert.equal(result.ok, true);
  assert.equal(result.result.total, 15);
  assert.equal(result.result.natural, 11);
  assert.equal(result.result.provider.type, ROLL_PROVENANCE_TYPES.FOUNDRY_DIGITAL);
  assert.equal(result.result.raw.foundryRoll.total, 15);
  assert.equal(calls[0].formula, "1d20 + 4");
  assert.equal(calls[1].evaluate.allowInteractive, false);
  assert.equal(result.result.raw.foundryRoll instanceof FakeRoll, false);
});
