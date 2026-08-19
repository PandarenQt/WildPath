import {test} from "node:test";
import assert from "node:assert/strict";
import {
  MOVEMENT_CODES,
  MOVEMENT_KINDS,
  MOVEMENT_MEASUREMENT_MODES,
  createMovementCapability,
  deriveMovementBudget,
  isMovementModeEligible,
  measureMovementPath,
  spendMovementBudget
} from "../module/helpers/movement.mjs";

test("distance movement derives a distance budget and spends measured distance", () => {
  const capability = createMovementCapability({mode: "walk", distance: 30, unit: "ft"});
  const derived = deriveMovementBudget({capability, measurementMode: MOVEMENT_MEASUREMENT_MODES.DISTANCE});
  const cost = measureMovementPath({distance: 10}, {measurementMode: MOVEMENT_MEASUREMENT_MODES.DISTANCE});
  const spent = spendMovementBudget(derived.budget, cost, {movementMode: "walk"});

  assert.equal(derived.budget.maximum, 30);
  assert.equal(cost.amount, 10);
  assert.equal(spent.budget.current, 20);
});

test("field movement derives fields from canonical distance and scene grid distance", () => {
  const capability = createMovementCapability({mode: "walk", distance: 30, unit: "ft"});
  const derived = deriveMovementBudget({
    capability,
    measurementMode: MOVEMENT_MEASUREMENT_MODES.FIELDS,
    grid: {type: "square", distance: 5}
  });
  const cost = measureMovementPath({fields: 2}, {
    measurementMode: MOVEMENT_MEASUREMENT_MODES.FIELDS,
    grid: {type: "square", distance: 5}
  });
  const spent = spendMovementBudget(derived.budget, cost, {movementMode: "walk"});

  assert.equal(derived.budget.maximum, 6);
  assert.equal(derived.budget.metadata.canonicalDistance, 30);
  assert.equal(spent.budget.current, 4);
});

test("field movement returns a structured failure on gridless scenes", () => {
  const result = deriveMovementBudget({
    capability: createMovementCapability({distance: 30}),
    measurementMode: MOVEMENT_MEASUREMENT_MODES.FIELDS,
    grid: {type: "gridless", distance: 0}
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, MOVEMENT_CODES.FIELDS_REQUIRE_GRID);
});

test("changing measurement mode does not mutate canonical movement speed", () => {
  const capability = createMovementCapability({mode: "walk", distance: 30, unit: "ft"});
  const distance = deriveMovementBudget({capability, measurementMode: MOVEMENT_MEASUREMENT_MODES.DISTANCE});
  const fields = deriveMovementBudget({
    capability,
    measurementMode: MOVEMENT_MEASUREMENT_MODES.FIELDS,
    grid: {type: "hex", distance: 5}
  });

  assert.equal(capability.distance, 30);
  assert.equal(distance.budget.maximum, 30);
  assert.equal(fields.budget.maximum, 6);
});

test("additional movement is represented as a separate sourced budget", () => {
  const base = deriveMovementBudget({
    capability: createMovementCapability({mode: "walk", distance: 30}),
    id: "economy.movement",
    source: {type: "base", slug: "movement"}
  }).budget;
  const extra = deriveMovementBudget({
    capability: createMovementCapability({mode: "walk", distance: 15}),
    id: "feature.extra-movement",
    source: {type: "feature", slug: "dash"}
  }).budget;

  assert.equal(base.maximum, 30);
  assert.equal(extra.maximum, 15);
  assert.deepEqual(extra.source, {type: "feature", slug: "dash"});
});

test("movement mode restrictions allow flying movement and reject walking movement", () => {
  const flyingOnly = deriveMovementBudget({
    capability: createMovementCapability({mode: "fly", distance: 20}),
    id: "feature.fly-only",
    movementModes: ["fly"]
  }).budget;

  assert.equal(isMovementModeEligible(flyingOnly, "fly"), true);
  assert.equal(isMovementModeEligible(flyingOnly, "walk"), false);
  const spent = spendMovementBudget(flyingOnly, {amount: 5, consumesBudget: true}, {movementMode: "walk"});
  assert.equal(spent.ok, false);
  assert.equal(spent.code, MOVEMENT_CODES.MOVEMENT_MODE_NOT_SUPPORTED);
});

test("forced movement and teleportation do not consume normal movement budget", () => {
  const budget = deriveMovementBudget({capability: createMovementCapability({distance: 30})}).budget;
  const forced = measureMovementPath({distance: 10}, {movementKind: MOVEMENT_KINDS.FORCED});
  const teleport = measureMovementPath({distance: 30}, {movementKind: MOVEMENT_KINDS.TELEPORT});

  assert.equal(spendMovementBudget(budget, forced).budget.current, 30);
  assert.equal(spendMovementBudget(budget, teleport).budget.current, 30);
  assert.equal(forced.code, MOVEMENT_CODES.NO_MOVEMENT_BUDGET_CONSUMPTION);
});

test("movement spending reports budget exceeded without mutating the input budget", () => {
  const budget = deriveMovementBudget({capability: createMovementCapability({distance: 30})}).budget;
  const result = spendMovementBudget(budget, {amount: 35, consumesBudget: true}, {movementMode: "walk"});

  assert.equal(result.ok, false);
  assert.equal(result.code, MOVEMENT_CODES.MOVEMENT_BUDGET_EXCEEDED);
  assert.equal(budget.current, 30);
});
