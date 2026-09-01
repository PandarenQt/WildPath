import {test} from "node:test";
import assert from "node:assert/strict";
import {
  CREATURE_SIZES,
  GRID_TOPOLOGIES,
  fieldDistance,
  fieldKey
} from "../module/helpers/grid-footprints.mjs";
import {
  MOVEMENT_CODES,
  MOVEMENT_KINDS,
  MOVEMENT_MEASUREMENT_MODES,
  createMovementCapability,
  deriveMovementBudget
} from "../module/helpers/movement.mjs";
import {
  MOVEMENT_PATH_ANCHOR_CONVENTIONS,
  MOVEMENT_PATH_CODES,
  createMovementPath,
  evaluateMovementPath,
  reconstructMovementFootprint
} from "../module/helpers/movement-paths.mjs";

const SQUARE_GRID = {type: GRID_TOPOLOGIES.SQUARE, distance: 5};
const HEX_GRID = {type: GRID_TOPOLOGIES.HEX, distance: 5};

test("medium square movement path anchors include origin and measure ordered transitions", () => {
  const path = createMovementPath({
    anchors: [{x: 0, y: 0}, {x: 1, y: 0}, {x: 2, y: 0}]
  });
  const result = evaluateMovementPath(path, {
    measurementMode: MOVEMENT_MEASUREMENT_MODES.FIELDS,
    grid: SQUARE_GRID
  });

  assert.equal(path.anchorConvention, MOVEMENT_PATH_ANCHOR_CONVENTIONS.ANCHORS_INCLUDE_ORIGIN);
  assert.equal(result.ok, true);
  assert.equal(result.valid, true);
  assert.equal(result.trace.anchorCount, 3);
  assert.equal(result.transitions.length, 2);
  assert.equal(result.routeCost.amount, 2);
  assert.equal(result.cost.amount, 2);
  assert.deepEqual(result.path.origin, {x: 0, y: 0});
});

test("large square movement reconstructs complete footprints and charges one transition per anchor step", () => {
  const result = evaluateMovementPath(createMovementPath({
    size: CREATURE_SIZES.LARGE,
    anchors: [{x: 0, y: 0}, {x: 1, y: 0}]
  }), {
    measurementMode: MOVEMENT_MEASUREMENT_MODES.FIELDS,
    grid: SQUARE_GRID
  });

  assert.equal(result.ok, true);
  assert.equal(result.footprints[0].fields.length, 4);
  assert.equal(result.footprints[1].fields.length, 4);
  assert.deepEqual(new Set(result.footprints[1].fieldKeys), new Set([
    "square:1,0",
    "square:2,0",
    "square:1,1",
    "square:2,1"
  ]));
  assert.equal(result.routeCost.amount, 1);
});

test("large hex movement uses full footprint and hex adjacency", () => {
  const result = evaluateMovementPath(createMovementPath({
    topology: GRID_TOPOLOGIES.HEX,
    size: CREATURE_SIZES.LARGE,
    anchors: [{q: 0, r: 0}, {q: 1, r: 0}]
  }), {
    measurementMode: MOVEMENT_MEASUREMENT_MODES.FIELDS,
    grid: HEX_GRID
  });

  assert.equal(result.ok, true);
  assert.equal(result.footprints[0].fields.length, 3);
  assert.equal(result.footprints[1].fields.length, 3);
  assert.equal(result.transitions[0].adjacent, true);
  assert.equal(result.routeCost.amount, 1);
});

test("ordinary movement rejects non-adjacent anchor transitions", () => {
  const result = evaluateMovementPath(createMovementPath({
    anchors: [{x: 0, y: 0}, {x: 2, y: 0}]
  }), {
    measurementMode: MOVEMENT_MEASUREMENT_MODES.FIELDS,
    grid: SQUARE_GRID
  });

  assert.equal(result.ok, false);
  assert.equal(result.valid, false);
  assert.equal(result.failures[0].code, MOVEMENT_PATH_CODES.NON_ADJACENT_STEP);
});

test("ordered detours cost the walked route rather than endpoint distance", () => {
  const anchors = [
    {x: 0, y: 0},
    {x: 1, y: 0},
    {x: 1, y: 1},
    {x: 2, y: 1},
    {x: 2, y: 0}
  ];
  const result = evaluateMovementPath(createMovementPath({anchors}), {
    measurementMode: MOVEMENT_MEASUREMENT_MODES.FIELDS,
    grid: SQUARE_GRID
  });

  assert.equal(result.ok, true);
  assert.equal(fieldDistance(anchors[0], anchors.at(-1), GRID_TOPOLOGIES.SQUARE), 2);
  assert.equal(result.routeCost.amount, 4);
  assert.equal(result.routeCost.amount > fieldDistance(anchors[0], anchors.at(-1), GRID_TOPOLOGIES.SQUARE), true);
});

test("step cost policy can alter per-transition route cost without changing path data", () => {
  const path = createMovementPath({
    anchors: [{x: 0, y: 0}, {x: 1, y: 0}, {x: 2, y: 0}]
  });
  const result = evaluateMovementPath(path, {
    measurementMode: MOVEMENT_MEASUREMENT_MODES.FIELDS,
    grid: SQUARE_GRID,
    stepCostPolicy: ({transitionIndex, defaultAmount}) => ({
      amount: transitionIndex === 1 ? defaultAmount + 1 : defaultAmount,
      reason: transitionIndex === 1 ? "test-difficult-field" : null,
      metadata: {transitionIndex}
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.routeCost.amount, 3);
  assert.equal(result.transitions[1].cost.reason, "test-difficult-field");
  assert.equal(path.anchors.length, 3);
  assert.equal("stepCostPolicy" in result.path, false);
});

test("occupancy policy validates complete footprints at every anchor", () => {
  const blocked = new Set(["square:2,0"]);
  const result = evaluateMovementPath(createMovementPath({
    size: CREATURE_SIZES.LARGE,
    anchors: [{x: 0, y: 0}, {x: 1, y: 0}]
  }), {
    measurementMode: MOVEMENT_MEASUREMENT_MODES.FIELDS,
    grid: SQUARE_GRID,
    occupancyPolicy: ({footprint}) => ({
      ok: !footprint.fieldKeys.some(key => blocked.has(key)),
      reason: "blocked-field"
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.valid, false);
  assert.equal(result.failures[0].code, MOVEMENT_PATH_CODES.OCCUPANCY_BLOCKED);
  assert.equal(result.failures[0].stepIndex, 1);
});

test("valid paths can be unaffordable without becoming geometrically invalid", () => {
  const anchors = Array.from({length: 8}, (_, x) => ({x, y: 0}));
  const budget = deriveMovementBudget({
    capability: createMovementCapability({distance: 30}),
    measurementMode: MOVEMENT_MEASUREMENT_MODES.DISTANCE
  }).budget;
  const result = evaluateMovementPath(createMovementPath({anchors}), {
    measurementMode: MOVEMENT_MEASUREMENT_MODES.DISTANCE,
    grid: SQUARE_GRID,
    budget
  });

  assert.equal(result.valid, true);
  assert.equal(result.ok, true);
  assert.equal(result.routeCost.amount, 35);
  assert.equal(result.cost.amount, 35);
  assert.equal(result.affordable, false);
  assert.equal(result.spend.code, MOVEMENT_CODES.MOVEMENT_BUDGET_EXCEEDED);
  assert.equal(budget.current, 30);
});

test("partial movement budget spends through the existing movement budget helper", () => {
  const derived = deriveMovementBudget({
    capability: createMovementCapability({distance: 30}),
    measurementMode: MOVEMENT_MEASUREMENT_MODES.DISTANCE
  }).budget;
  const budget = {...derived, current: 20};
  const result = evaluateMovementPath(createMovementPath({
    anchors: [{x: 0, y: 0}, {x: 1, y: 0}, {x: 2, y: 0}]
  }), {
    measurementMode: MOVEMENT_MEASUREMENT_MODES.DISTANCE,
    grid: SQUARE_GRID,
    budget
  });

  assert.equal(result.ok, true);
  assert.equal(result.affordable, true);
  assert.equal(result.cost.amount, 10);
  assert.equal(result.spend.budget.current, 10);
  assert.equal(budget.current, 20);
});

test("forced movement uses route mechanics but does not spend normal movement budget", () => {
  const budget = deriveMovementBudget({
    capability: createMovementCapability({distance: 30}),
    measurementMode: MOVEMENT_MEASUREMENT_MODES.DISTANCE
  }).budget;
  const result = evaluateMovementPath(createMovementPath({
    movementKind: MOVEMENT_KINDS.FORCED,
    anchors: [{x: 0, y: 0}, {x: 1, y: 0}, {x: 2, y: 0}]
  }), {
    measurementMode: MOVEMENT_MEASUREMENT_MODES.DISTANCE,
    grid: SQUARE_GRID,
    budget
  });

  assert.equal(result.ok, true);
  assert.equal(result.routeCost.amount, 10);
  assert.equal(result.cost.amount, 0);
  assert.equal(result.cost.consumesBudget, false);
  assert.equal(result.spend.budget.current, 30);
  assert.equal(result.spend.code, MOVEMENT_CODES.NO_MOVEMENT_BUDGET_CONSUMPTION);
});

test("teleport permits non-adjacent destination while preserving destination legality checks", () => {
  const path = createMovementPath({
    movementKind: MOVEMENT_KINDS.TELEPORT,
    anchors: [{x: 0, y: 0}, {x: 8, y: 0}]
  });
  const budget = deriveMovementBudget({
    capability: createMovementCapability({distance: 30}),
    measurementMode: MOVEMENT_MEASUREMENT_MODES.DISTANCE
  }).budget;
  const allowed = evaluateMovementPath(path, {
    measurementMode: MOVEMENT_MEASUREMENT_MODES.DISTANCE,
    grid: SQUARE_GRID,
    budget
  });
  const blocked = evaluateMovementPath(path, {
    measurementMode: MOVEMENT_MEASUREMENT_MODES.DISTANCE,
    grid: SQUARE_GRID,
    budget,
    occupancyPolicy: ({stepIndex}) => stepIndex !== 1
  });

  assert.equal(allowed.ok, true);
  assert.equal(allowed.transitions[0].adjacent, false);
  assert.equal(allowed.cost.amount, 0);
  assert.equal(allowed.cost.consumesBudget, false);
  assert.equal(allowed.spend.budget.current, 30);
  assert.equal(allowed.footprints[1].fieldKeys.includes("square:8,0"), true);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.failures[0].code, MOVEMENT_PATH_CODES.OCCUPANCY_BLOCKED);
});

test("MovementPath and evaluation result are plain JSON-serializable data", () => {
  const path = createMovementPath({
    id: "move-test",
    size: CREATURE_SIZES.LARGE,
    anchors: [{x: 0, y: 0}, {x: 1, y: 0}],
    metadata: {source: {type: "test"}}
  });
  const result = evaluateMovementPath(path, {
    measurementMode: MOVEMENT_MEASUREMENT_MODES.FIELDS,
    grid: SQUARE_GRID
  });

  assert.deepEqual(JSON.parse(JSON.stringify(path)), path);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("field-mode movement reports structured failure on gridless scenes", () => {
  const result = evaluateMovementPath(createMovementPath({
    anchors: [{x: 0, y: 0}, {x: 1, y: 0}]
  }), {
    measurementMode: MOVEMENT_MEASUREMENT_MODES.FIELDS,
    grid: {type: "gridless", distance: 0}
  });

  assert.equal(result.valid, true);
  assert.equal(result.ok, false);
  assert.equal(result.code, MOVEMENT_PATH_CODES.FIELDS_REQUIRE_GRID);
  assert.equal(result.cost.code, MOVEMENT_CODES.FIELDS_REQUIRE_GRID);
});

test("distance-mode movement requires grid distance or a custom step-cost policy", () => {
  const path = createMovementPath({
    anchors: [{x: 0, y: 0}, {x: 1, y: 0}]
  });
  const missingGridDistance = evaluateMovementPath(path, {
    measurementMode: MOVEMENT_MEASUREMENT_MODES.DISTANCE
  });
  const policySupplied = evaluateMovementPath(path, {
    measurementMode: MOVEMENT_MEASUREMENT_MODES.DISTANCE,
    stepCostPolicy: () => ({amount: 7, reason: "custom-distance"})
  });

  assert.equal(missingGridDistance.valid, true);
  assert.equal(missingGridDistance.ok, false);
  assert.equal(missingGridDistance.cost.code, MOVEMENT_PATH_CODES.DISTANCE_REQUIRES_GRID_DISTANCE);
  assert.equal(policySupplied.ok, true);
  assert.equal(policySupplied.cost.amount, 7);
  assert.equal(policySupplied.transitions[0].cost.reason, "custom-distance");
});

test("origin-only paths are valid zero-transition routes", () => {
  const result = evaluateMovementPath(createMovementPath({origin: {x: 3, y: 4}}), {
    measurementMode: MOVEMENT_MEASUREMENT_MODES.FIELDS,
    grid: SQUARE_GRID
  });

  assert.equal(result.ok, true);
  assert.equal(result.valid, true);
  assert.equal(result.transitions.length, 0);
  assert.equal(result.routeCost.amount, 0);
  assert.deepEqual(result.path.origin, {x: 3, y: 4});
});

test("empty paths and repeated anchors fail explicitly", () => {
  const empty = evaluateMovementPath(createMovementPath({anchors: []}), {
    measurementMode: MOVEMENT_MEASUREMENT_MODES.FIELDS,
    grid: SQUARE_GRID
  });
  const repeated = evaluateMovementPath(createMovementPath({
    anchors: [{x: 0, y: 0}, {x: 0, y: 0}]
  }), {
    measurementMode: MOVEMENT_MEASUREMENT_MODES.FIELDS,
    grid: SQUARE_GRID
  });

  assert.equal(empty.ok, false);
  assert.equal(empty.failures[0].code, MOVEMENT_PATH_CODES.MISSING_ANCHORS);
  assert.equal(repeated.ok, false);
  assert.equal(repeated.failures[0].code, MOVEMENT_PATH_CODES.REPEATED_ANCHOR);
});

test("invalid custom step cost fails without mutating the MovementPath", () => {
  const path = createMovementPath({
    anchors: [{x: 0, y: 0}, {x: 1, y: 0}]
  });
  const before = JSON.stringify(path);
  const result = evaluateMovementPath(path, {
    measurementMode: MOVEMENT_MEASUREMENT_MODES.FIELDS,
    grid: SQUARE_GRID,
    stepCostPolicy: () => -1
  });

  assert.equal(result.ok, false);
  assert.equal(result.valid, false);
  assert.equal(result.failures[0].code, MOVEMENT_PATH_CODES.INVALID_STEP_COST);
  assert.equal(JSON.stringify(path), before);
});

test("reconstructMovementFootprint returns a full footprint for a specific anchor", () => {
  const path = createMovementPath({
    size: CREATURE_SIZES.LARGE,
    anchors: [{x: 0, y: 0}, {x: 2, y: 0}]
  });
  const footprint = reconstructMovementFootprint(path, 1);

  assert.deepEqual(new Set(footprint.fieldKeys), new Set([
    fieldKey({x: 2, y: 0}, GRID_TOPOLOGIES.SQUARE),
    fieldKey({x: 3, y: 0}, GRID_TOPOLOGIES.SQUARE),
    fieldKey({x: 2, y: 1}, GRID_TOPOLOGIES.SQUARE),
    fieldKey({x: 3, y: 1}, GRID_TOPOLOGIES.SQUARE)
  ]));
});
