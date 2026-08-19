/**
 * Pure movement-budget helpers for Wild Path.
 *
 * Movement capability is canonical distance ("walk 30 ft", "fly 60 ft"). The current turn's
 * spendable movement budget is derived from that capability using a measurement policy, so a GM
 * can switch between distance-counting and field-counting without rewriting Actor speed data.
 */

export const MOVEMENT_MEASUREMENT_MODES = Object.freeze({
  DISTANCE: "distance",
  FIELDS: "fields"
});

export const MOVEMENT_KINDS = Object.freeze({
  VOLUNTARY: "voluntary",
  FORCED: "forced",
  TELEPORT: "teleport"
});

export const MOVEMENT_CODES = Object.freeze({
  AVAILABLE: "AVAILABLE",
  FIELDS_REQUIRE_GRID: "FIELDS_REQUIRE_GRID",
  MOVEMENT_BUDGET_EXCEEDED: "MOVEMENT_BUDGET_EXCEEDED",
  MOVEMENT_MODE_NOT_SUPPORTED: "MOVEMENT_MODE_NOT_SUPPORTED",
  NO_MOVEMENT_BUDGET_CONSUMPTION: "NO_MOVEMENT_BUDGET_CONSUMPTION"
});

/* -------------------------------------------- */

/**
 * Normalize a movement capability. The returned object is still canonical distance.
 * @param {object} capability
 * @returns {{mode: string, distance: number, unit: string}}
 */
export function createMovementCapability({mode="walk", distance=0, unit="ft"}={}) {
  return {
    mode,
    distance: Math.max(Number(distance) || 0, 0),
    unit
  };
}

/* -------------------------------------------- */

/**
 * Derive a spendable movement-budget resource from canonical movement capability.
 * @param {object} options
 * @param {object} options.capability
 * @param {"distance"|"fields"} options.measurementMode
 * @param {object} [options.grid]
 * @param {string} [options.id]
 * @param {object} [options.source]
 * @param {string[]} [options.movementModes]
 * @returns {{ok: boolean, code: string, budget?: object, reason?: string}}
 */
export function deriveMovementBudget({
  capability,
  measurementMode=MOVEMENT_MEASUREMENT_MODES.DISTANCE,
  grid=null,
  id="economy.movement",
  source=null,
  movementModes=null
}={}) {
  const normalized = createMovementCapability(capability);
  if ( measurementMode === MOVEMENT_MEASUREMENT_MODES.FIELDS ) {
    const gridCheck = validateFieldGrid(grid);
    if ( !gridCheck.ok ) return gridCheck;
    const fields = Math.floor(normalized.distance / grid.distance);
    return {
      ok: true,
      code: MOVEMENT_CODES.AVAILABLE,
      budget: createBudgetResource({
        id,
        amount: fields,
        displayUnit: "fields",
        measurementMode,
        capability: normalized,
        source,
        movementModes: movementModes ?? [normalized.mode],
        gridDistance: grid.distance
      })
    };
  }

  return {
    ok: true,
    code: MOVEMENT_CODES.AVAILABLE,
    budget: createBudgetResource({
      id,
      amount: normalized.distance,
      displayUnit: normalized.unit,
      measurementMode: MOVEMENT_MEASUREMENT_MODES.DISTANCE,
      capability: normalized,
      source,
      movementModes: movementModes ?? [normalized.mode]
    })
  };
}

/* -------------------------------------------- */

/**
 * Measure a movement path into a budget cost. The path can already contain field counts or
 * distances; later Foundry adapters can populate this from V14 grid/path measurement APIs.
 * @param {object} path
 * @param {object} context
 * @returns {{ok: boolean, code: string, amount: number, unit: string|null, consumesBudget: boolean, movementKind: string}}
 */
export function measureMovementPath(path={}, context={}) {
  const movementKind = context.movementKind ?? MOVEMENT_KINDS.VOLUNTARY;
  if ( movementKind === MOVEMENT_KINDS.FORCED || movementKind === MOVEMENT_KINDS.TELEPORT ) {
    return {
      ok: true,
      code: MOVEMENT_CODES.NO_MOVEMENT_BUDGET_CONSUMPTION,
      amount: 0,
      unit: null,
      consumesBudget: false,
      movementKind
    };
  }

  const measurementMode = context.measurementMode ?? MOVEMENT_MEASUREMENT_MODES.DISTANCE;
  if ( measurementMode === MOVEMENT_MEASUREMENT_MODES.FIELDS ) {
    const gridCheck = validateFieldGrid(context.grid);
    if ( !gridCheck.ok ) return {...gridCheck, amount: 0, unit: "fields", consumesBudget: true, movementKind};
    return {
      ok: true,
      code: MOVEMENT_CODES.AVAILABLE,
      amount: sumPathFields(path, context.grid.distance),
      unit: "fields",
      consumesBudget: true,
      movementKind
    };
  }

  return {
    ok: true,
    code: MOVEMENT_CODES.AVAILABLE,
    amount: sumPathDistance(path),
    unit: context.distanceUnit ?? "ft",
    consumesBudget: true,
    movementKind
  };
}

/* -------------------------------------------- */

/**
 * Spend a measured movement cost from a movement-budget resource without mutating the input.
 * @param {object} budget
 * @param {object} cost
 * @param {object} [context]
 * @returns {{ok: boolean, code: string, budget: object}}
 */
export function spendMovementBudget(budget, cost, context={}) {
  const movementMode = context.movementMode ?? budget.metadata?.capability?.mode;
  if ( cost.consumesBudget === false ) {
    return {ok: true, code: MOVEMENT_CODES.NO_MOVEMENT_BUDGET_CONSUMPTION, budget: cloneBudget(budget)};
  }
  if ( !isMovementModeEligible(budget, movementMode) ) {
    return {ok: false, code: MOVEMENT_CODES.MOVEMENT_MODE_NOT_SUPPORTED, budget: cloneBudget(budget)};
  }
  if ( budget.current < cost.amount ) {
    return {ok: false, code: MOVEMENT_CODES.MOVEMENT_BUDGET_EXCEEDED, budget: cloneBudget(budget)};
  }
  return {
    ok: true,
    code: MOVEMENT_CODES.AVAILABLE,
    budget: {...cloneBudget(budget), current: budget.current - cost.amount}
  };
}

/* -------------------------------------------- */

export function isMovementModeEligible(budget, movementMode) {
  const movementModes = budget.metadata?.movementModes ?? [];
  return !movementModes.length || movementModes.includes(movementMode);
}

/* -------------------------------------------- */

function createBudgetResource({
  id,
  amount,
  displayUnit,
  measurementMode,
  capability,
  source,
  movementModes,
  gridDistance=null
}) {
  return {
    id,
    category: "movement",
    current: amount,
    maximum: amount,
    unit: "movement",
    paymentCapabilities: ["movement"],
    refreshPolicies: [{event: "turnStart"}],
    source: source ? clonePlain(source) : null,
    priority: 10,
    metadata: {
      measurementMode,
      displayUnit,
      canonicalDistance: capability.distance,
      distanceUnit: capability.unit,
      capability: clonePlain(capability),
      movementModes: [...movementModes],
      gridDistance
    }
  };
}

function validateFieldGrid(grid) {
  if ( !grid || grid.type === "gridless" || !(Number(grid.distance) > 0) ) {
    return {
      ok: false,
      code: MOVEMENT_CODES.FIELDS_REQUIRE_GRID,
      reason: "Field-based movement requires a gridded Scene with a positive grid distance."
    };
  }
  return {ok: true, code: MOVEMENT_CODES.AVAILABLE};
}

function sumPathDistance(path) {
  if ( Number(path.distance) > 0 ) return Number(path.distance);
  return (path.segments ?? []).reduce((sum, segment) => sum + (Number(segment.distance) || 0), 0);
}

function sumPathFields(path, gridDistance) {
  if ( Number(path.fields) > 0 ) return Number(path.fields);
  return (path.segments ?? []).reduce((sum, segment) => {
    if ( Number(segment.fields) > 0 ) return sum + Number(segment.fields);
    return sum + Math.floor((Number(segment.distance) || 0) / gridDistance);
  }, 0);
}

function cloneBudget(budget) {
  return {...budget, metadata: clonePlain(budget.metadata ?? {})};
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}
