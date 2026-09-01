/**
 * Pure topology-aware MovementPath helpers for Wild Path.
 *
 * A MovementPath is ordered route data. Its anchors include the origin, so a path with
 * [A, B, C] has two transitions. Budget derivation and spending remain owned by
 * movement.mjs; this module turns ordered topology steps into the path-like costs that
 * those helpers already understand.
 */

import {
  MOVEMENT_CODES,
  MOVEMENT_KINDS,
  MOVEMENT_MEASUREMENT_MODES,
  deriveMovementBudget,
  measureMovementPath,
  spendMovementBudget
} from "./movement.mjs";
import {
  CREATURE_SIZE_ORDER,
  CREATURE_SIZES,
  DND5E_CREATURE_FOOTPRINT_PROVIDER,
  GRID_TOPOLOGIES,
  adjacentFields,
  createTokenFootprintDefinition,
  createTokenGridFootprint,
  fieldKey,
  normalizeGridField
} from "./grid-footprints.mjs";

export const MOVEMENT_PATH_ANCHOR_CONVENTIONS = Object.freeze({
  ANCHORS_INCLUDE_ORIGIN: "anchors-include-origin"
});

export const MOVEMENT_PATH_CODES = Object.freeze({
  OK: "OK",
  MISSING_ANCHORS: "MISSING_ANCHORS",
  UNKNOWN_TOPOLOGY: "UNKNOWN_TOPOLOGY",
  UNKNOWN_SIZE: "UNKNOWN_SIZE",
  INVALID_FOOTPRINT: "INVALID_FOOTPRINT",
  REPEATED_ANCHOR: "REPEATED_ANCHOR",
  NON_ADJACENT_STEP: "NON_ADJACENT_STEP",
  OCCUPANCY_BLOCKED: "OCCUPANCY_BLOCKED",
  TRANSITION_BLOCKED: "TRANSITION_BLOCKED",
  INVALID_STEP_COST: "INVALID_STEP_COST",
  DISTANCE_REQUIRES_GRID_DISTANCE: "DISTANCE_REQUIRES_GRID_DISTANCE",
  FIELDS_REQUIRE_GRID: MOVEMENT_CODES.FIELDS_REQUIRE_GRID
});

/* -------------------------------------------- */

/**
 * Create canonical, serializable MovementPath data.
 *
 * @param {object} options
 * @param {Array<object>} [options.anchors] Ordered anchors, including the origin.
 * @param {object} [options.origin] Origin fallback when anchors are omitted.
 * @param {"square"|"hex"} [options.topology]
 * @param {string} [options.size]
 * @param {object} [options.footprintDefinition]
 * @param {object} [options.provider]
 * @returns {object}
 */
export function createMovementPath({
  id=null,
  anchors=null,
  origin=null,
  topology=GRID_TOPOLOGIES.SQUARE,
  size=CREATURE_SIZES.MEDIUM,
  footprintDefinition=null,
  provider=DND5E_CREATURE_FOOTPRINT_PROVIDER,
  movementKind=MOVEMENT_KINDS.VOLUNTARY,
  movementMode="walk",
  metadata={}
}={}) {
  const normalizedTopology = normalizeMovementTopology(topology);
  const normalizedSize = normalizeMovementSize(footprintDefinition?.size ?? size);
  const sourceAnchors = Array.isArray(anchors) && anchors.length ? anchors : (origin ? [origin] : []);
  const normalizedAnchors = sourceAnchors.map(anchor => normalizeGridField(anchor, normalizedTopology));
  const definition = resolveFootprintDefinition({
    definition: footprintDefinition,
    provider,
    size: normalizedSize,
    topology: normalizedTopology
  });

  return {
    type: "MovementPath",
    id,
    anchorConvention: MOVEMENT_PATH_ANCHOR_CONVENTIONS.ANCHORS_INCLUDE_ORIGIN,
    topology: normalizedTopology,
    size: definition.size,
    origin: normalizedAnchors[0] ? clonePlain(normalizedAnchors[0]) : null,
    anchors: normalizedAnchors.map(clonePlain),
    footprintDefinition: clonePlain(definition),
    movementKind: normalizeMovementKind(movementKind),
    movementMode,
    metadata: clonePlain(metadata)
  };
}

/* -------------------------------------------- */

/**
 * Reconstruct the full TokenGridFootprint occupied at one path anchor.
 * @param {object} pathLike
 * @param {number} anchorIndex
 * @returns {object}
 */
export function reconstructMovementFootprint(pathLike, anchorIndex=0) {
  const path = createMovementPath(pathLike);
  if ( !path.anchors[anchorIndex] ) throw new Error(`MovementPath anchor index out of range: ${anchorIndex}`);
  return createTokenGridFootprint({
    anchor: path.anchors[anchorIndex],
    size: path.size,
    topology: path.topology,
    definition: path.footprintDefinition
  });
}

/* -------------------------------------------- */

/**
 * Reconstruct the full TokenGridFootprint occupied at every path anchor.
 * @param {object} pathLike
 * @returns {Array<object>}
 */
export function reconstructMovementFootprints(pathLike) {
  const path = createMovementPath(pathLike);
  return path.anchors.map((_, index) => reconstructMovementFootprint(path, index));
}

/* -------------------------------------------- */

/**
 * Evaluate an ordered MovementPath for route legality, route cost, and affordability.
 *
 * Runtime rule policies are functions passed to the evaluator. They are not stored in the
 * MovementPath or returned result, so both remain plain serializable data.
 *
 * @param {object} pathLike
 * @param {object} options
 * @returns {object}
 */
export function evaluateMovementPath(pathLike={}, {
  measurementMode=MOVEMENT_MEASUREMENT_MODES.DISTANCE,
  grid=null,
  gridDistance=null,
  distanceUnit="ft",
  budget=null,
  capability=null,
  movementKind=null,
  movementMode=null,
  occupancyPolicy=null,
  transitionPolicy=null,
  stepCostPolicy=null,
  context={}
}={}) {
  let path;
  try {
    path = createMovementPath(pathLike);
  } catch (error) {
    const code = classifyPathCreationError(error);
    return createEvaluationResult({
      path: null,
      measurementMode,
      movementKind: movementKind ?? pathLike?.movementKind ?? MOVEMENT_KINDS.VOLUNTARY,
      movementMode: movementMode ?? pathLike?.movementMode ?? "walk",
      failures: [createFailure({code, reason: error.message})],
      cost: createInvalidCost({code, movementKind: movementKind ?? pathLike?.movementKind}),
      grid: normalizeEvaluationGrid(grid, pathLike?.topology ?? GRID_TOPOLOGIES.SQUARE, gridDistance)
    });
  }

  const resolvedKind = normalizeMovementKind(movementKind ?? path.movementKind);
  const resolvedMode = movementMode ?? path.movementMode;
  const resolvedGrid = normalizeEvaluationGrid(grid, path.topology, gridDistance);
  const unit = measurementMode === MOVEMENT_MEASUREMENT_MODES.FIELDS ? "fields" : distanceUnit;
  const failures = [];

  if ( !path.anchors.length ) {
    failures.push(createFailure({
      code: MOVEMENT_PATH_CODES.MISSING_ANCHORS,
      reason: "MovementPath anchors must include at least the origin."
    }));
  }

  const footprints = failures.length ? [] : reconstructFootprintsSafely(path, failures);
  applyOccupancyPolicy({
    path,
    footprints,
    occupancyPolicy,
    movementKind: resolvedKind,
    movementMode: resolvedMode,
    context,
    failures
  });

  const transitions = createTransitions({
    path,
    footprints,
    measurementMode,
    distanceUnit: unit,
    grid: resolvedGrid,
    movementKind: resolvedKind,
    movementMode: resolvedMode,
    transitionPolicy,
    stepCostPolicy,
    context,
    failures
  });

  const routeCost = createRouteCost(transitions, measurementMode, unit);
  const cost = createMovementCost({
    transitions,
    routeCost,
    measurementMode,
    movementKind: resolvedKind,
    grid: resolvedGrid,
    distanceUnit: unit,
    failures
  });

  const budgetResult = resolveBudget({
    budget,
    capability,
    cost,
    movementMode: resolvedMode,
    measurementMode,
    grid: resolvedGrid
  });
  if ( budgetResult.failure ) failures.push(budgetResult.failure);

  return createEvaluationResult({
    path,
    measurementMode,
    movementKind: resolvedKind,
    movementMode: resolvedMode,
    footprints,
    transitions,
    routeCost,
    cost,
    grid: resolvedGrid,
    budgetResult,
    failures
  });
}

/* -------------------------------------------- */

function reconstructFootprintsSafely(path, failures) {
  try {
    return path.anchors.map(anchor => createTokenGridFootprint({
      anchor,
      size: path.size,
      topology: path.topology,
      definition: path.footprintDefinition
    }));
  } catch (error) {
    failures.push(createFailure({
      code: MOVEMENT_PATH_CODES.INVALID_FOOTPRINT,
      reason: error.message
    }));
    return [];
  }
}

function applyOccupancyPolicy({
  path,
  footprints,
  occupancyPolicy,
  movementKind,
  movementMode,
  context,
  failures
}) {
  if ( typeof occupancyPolicy !== "function" ) return;

  for ( const [stepIndex, footprint] of footprints.entries() ) {
    const policy = normalizePolicyResult(occupancyPolicy({
      path,
      anchor: path.anchors[stepIndex],
      footprint,
      stepIndex,
      movementKind,
      movementMode,
      context
    }), MOVEMENT_PATH_CODES.OCCUPANCY_BLOCKED);
    if ( policy.ok ) continue;
    failures.push(createFailure({
      code: policy.code,
      reason: policy.reason ?? "MovementPath occupancy policy blocked a footprint.",
      stepIndex,
      anchor: path.anchors[stepIndex],
      footprintIndex: stepIndex,
      metadata: policy.metadata
    }));
  }
}

function createTransitions({
  path,
  footprints,
  measurementMode,
  distanceUnit,
  grid,
  movementKind,
  movementMode,
  transitionPolicy,
  stepCostPolicy,
  context,
  failures
}) {
  const transitions = [];
  if ( path.anchors.length < 2 ) return transitions;

  for ( let index = 0; index < path.anchors.length - 1; index++ ) {
    const from = path.anchors[index];
    const to = path.anchors[index + 1];
    const repeated = fieldKey(from, path.topology) === fieldKey(to, path.topology);
    const adjacent = !repeated && areAdjacent(from, to, path.topology);
    const failuresBefore = failures.length;

    if ( repeated ) {
      failures.push(createFailure({
        code: MOVEMENT_PATH_CODES.REPEATED_ANCHOR,
        reason: "MovementPath transitions must not repeat the same anchor.",
        transitionIndex: index,
        from,
        to
      }));
    }

    if ( !repeated && !adjacent && movementKind !== MOVEMENT_KINDS.TELEPORT ) {
      failures.push(createFailure({
        code: MOVEMENT_PATH_CODES.NON_ADJACENT_STEP,
        reason: "Ordinary movement transitions must move between adjacent anchors.",
        transitionIndex: index,
        from,
        to
      }));
    }

    if ( typeof transitionPolicy === "function" ) {
      const policy = normalizePolicyResult(transitionPolicy({
        path,
        from,
        to,
        fromFootprint: footprints[index],
        toFootprint: footprints[index + 1],
        transitionIndex: index,
        movementKind,
        movementMode,
        context
      }), MOVEMENT_PATH_CODES.TRANSITION_BLOCKED);
      if ( !policy.ok ) {
        failures.push(createFailure({
          code: policy.code,
          reason: policy.reason ?? "MovementPath transition policy blocked a step.",
          transitionIndex: index,
          from,
          to,
          metadata: policy.metadata
        }));
      }
    }

    const cost = resolveStepCost({
      path,
      from,
      to,
      fromFootprint: footprints[index],
      toFootprint: footprints[index + 1],
      transitionIndex: index,
      measurementMode,
      distanceUnit,
      grid,
      movementKind,
      movementMode,
      stepCostPolicy,
      context
    });
    if ( !cost.ok ) {
      failures.push(createFailure({
        code: cost.code,
        reason: cost.reason,
        transitionIndex: index,
        from,
        to
      }));
    }

    transitions.push({
      index,
      from: clonePlain(from),
      to: clonePlain(to),
      fromFootprintIndex: index,
      toFootprintIndex: index + 1,
      adjacent,
      allowed: failures.length === failuresBefore && cost.ok,
      movementKind,
      movementMode,
      cost: {
        amount: cost.ok ? cost.amount : 0,
        unit: movementCostUnit(measurementMode, distanceUnit),
        measurementMode,
        source: cost.source,
        reason: cost.reason ?? null,
        metadata: clonePlain(cost.metadata ?? {})
      }
    });
  }

  return transitions;
}

function createRouteCost(transitions, measurementMode, unit) {
  return {
    amount: transitions.reduce((sum, transition) => sum + transition.cost.amount, 0),
    unit,
    measurementMode,
    transitionCount: transitions.length
  };
}

function createMovementCost({transitions, measurementMode, movementKind, grid, distanceUnit, failures}) {
  const costFailures = failures.filter(failure => [
    MOVEMENT_PATH_CODES.INVALID_STEP_COST,
    MOVEMENT_PATH_CODES.DISTANCE_REQUIRES_GRID_DISTANCE
  ].includes(failure.code));
  if ( costFailures.length ) {
    return createInvalidCost({
      code: costFailures[0].code,
      movementKind,
      unit: movementCostUnit(measurementMode, distanceUnit)
    });
  }

  const pathCost = measurementMode === MOVEMENT_MEASUREMENT_MODES.FIELDS
    ? {segments: transitions.map(transition => ({fields: transition.cost.amount}))}
    : {segments: transitions.map(transition => ({distance: transition.cost.amount}))};
  const cost = measureMovementPath(pathCost, {
    movementKind,
    measurementMode,
    grid,
    distanceUnit
  });
  if ( !cost.ok && cost.code === MOVEMENT_CODES.FIELDS_REQUIRE_GRID ) {
    failures.push(createFailure({
      code: MOVEMENT_PATH_CODES.FIELDS_REQUIRE_GRID,
      reason: cost.reason
    }));
  }
  return clonePlain(cost);
}

function resolveBudget({budget, capability, cost, movementMode, measurementMode, grid}) {
  if ( !cost.ok ) {
    return {
      budget: budget ? clonePlain(budget) : null,
      budgetDerivation: null,
      spend: null,
      affordable: null
    };
  }

  let resolvedBudget = budget ? clonePlain(budget) : null;
  let budgetDerivation = null;
  if ( !resolvedBudget && capability ) {
    budgetDerivation = deriveMovementBudget({capability, measurementMode, grid});
    if ( !budgetDerivation.ok ) {
      return {
        budget: null,
        budgetDerivation: clonePlain(budgetDerivation),
        spend: null,
        affordable: false,
        failure: createFailure({
          code: budgetDerivation.code,
          reason: budgetDerivation.reason
        })
      };
    }
    resolvedBudget = budgetDerivation.budget;
  }

  if ( !resolvedBudget ) {
    return {
      budget: null,
      budgetDerivation: budgetDerivation ? clonePlain(budgetDerivation) : null,
      spend: null,
      affordable: null
    };
  }

  const spend = spendMovementBudget(resolvedBudget, cost, {movementMode});
  return {
    budget: clonePlain(resolvedBudget),
    budgetDerivation: budgetDerivation ? clonePlain(budgetDerivation) : null,
    spend: clonePlain(spend),
    affordable: spend.ok
  };
}

function createEvaluationResult({
  path,
  measurementMode,
  movementKind,
  movementMode,
  footprints=[],
  transitions=[],
  routeCost=null,
  cost=null,
  grid=null,
  budgetResult={},
  failures=[]
}) {
  const routeFailures = failures.filter(failure => ![
    MOVEMENT_CODES.MOVEMENT_BUDGET_EXCEEDED,
    MOVEMENT_CODES.MOVEMENT_MODE_NOT_SUPPORTED,
    MOVEMENT_PATH_CODES.DISTANCE_REQUIRES_GRID_DISTANCE,
    MOVEMENT_PATH_CODES.FIELDS_REQUIRE_GRID
  ].includes(failure.code));
  const valid = path !== null && routeFailures.length === 0;
  const resolvedCost = cost ?? createInvalidCost({
    code: failures[0]?.code ?? MOVEMENT_PATH_CODES.MISSING_ANCHORS,
    movementKind
  });

  return {
    ok: valid && resolvedCost.ok,
    code: failures[0]?.code ?? MOVEMENT_PATH_CODES.OK,
    valid,
    path: path ? clonePlain(path) : null,
    anchorConvention: MOVEMENT_PATH_ANCHOR_CONVENTIONS.ANCHORS_INCLUDE_ORIGIN,
    footprints: clonePlain(footprints),
    transitions: clonePlain(transitions),
    routeCost: clonePlain(routeCost ?? createRouteCost(transitions, measurementMode, movementCostUnit(measurementMode))),
    cost: clonePlain(resolvedCost),
    budget: clonePlain(budgetResult.budget ?? null),
    budgetDerivation: clonePlain(budgetResult.budgetDerivation ?? null),
    spend: clonePlain(budgetResult.spend ?? null),
    affordable: budgetResult.affordable ?? null,
    failures: clonePlain(failures),
    trace: {
      anchorConvention: MOVEMENT_PATH_ANCHOR_CONVENTIONS.ANCHORS_INCLUDE_ORIGIN,
      anchorCount: path?.anchors?.length ?? 0,
      transitionCount: transitions.length,
      movementKind: normalizeMovementKind(movementKind),
      movementMode,
      measurementMode,
      grid: clonePlain(grid)
    }
  };
}

function resolveStepCost({
  path,
  from,
  to,
  fromFootprint,
  toFootprint,
  transitionIndex,
  measurementMode,
  distanceUnit,
  grid,
  movementKind,
  movementMode,
  stepCostPolicy,
  context
}) {
  const defaultCost = defaultStepCost({movementKind, measurementMode, grid, distanceUnit});
  const defaultAmount = defaultCost.amount;
  if ( typeof stepCostPolicy !== "function" ) {
    return defaultCost;
  }

  const policyCost = stepCostPolicy({
    path,
    from,
    to,
    fromFootprint,
    toFootprint,
    transitionIndex,
    defaultAmount,
    measurementMode,
    movementKind,
    movementMode,
    context
  });
  if ( (policyCost === undefined || policyCost === null) && !defaultCost.ok ) return defaultCost;
  return normalizeStepCost(policyCost, defaultAmount, measurementMode);
}

function normalizeStepCost(value, defaultAmount, measurementMode) {
  if ( value === undefined || value === null ) {
    return {
      ok: true,
      amount: defaultAmount,
      source: "default",
      metadata: {}
    };
  }

  const amount = typeof value === "number"
    ? value
    : value.amount ?? value.cost ?? (measurementMode === MOVEMENT_MEASUREMENT_MODES.FIELDS ? value.fields : value.distance);
  const numeric = Number(amount);
  if ( !Number.isFinite(numeric) || numeric < 0 ) {
    return {
      ok: false,
      code: MOVEMENT_PATH_CODES.INVALID_STEP_COST,
      reason: "MovementPath step cost policy must return a non-negative finite amount.",
      source: "policy",
      amount: 0
    };
  }

  return {
    ok: true,
    amount: numeric,
    source: typeof value === "number" ? "policy" : (value.source ?? "policy"),
    reason: typeof value === "object" ? (value.reason ?? null) : null,
    metadata: typeof value === "object" ? clonePlain(value.metadata ?? {}) : {}
  };
}

function normalizePolicyResult(result, defaultCode) {
  if ( result === undefined || result === null || result === true ) return {ok: true, code: MOVEMENT_PATH_CODES.OK};
  if ( result === false ) return {ok: false, code: defaultCode};
  if ( typeof result === "object" ) {
    const ok = result.ok ?? result.allowed ?? result.valid ?? true;
    return {
      ok: Boolean(ok),
      code: result.code ?? (ok ? MOVEMENT_PATH_CODES.OK : defaultCode),
      reason: result.reason ?? null,
      metadata: clonePlain(result.metadata ?? {})
    };
  }
  return Boolean(result) ? {ok: true, code: MOVEMENT_PATH_CODES.OK} : {ok: false, code: defaultCode};
}

function resolveFootprintDefinition({definition, provider, size, topology}) {
  if ( definition ) return createTokenFootprintDefinition({
    ...definition,
    size: definition.size ?? size,
    topology: definition.topology ?? topology
  });
  return provider.getDefinition({size, topology});
}

function areAdjacent(from, to, topology) {
  const destination = fieldKey(to, topology);
  return adjacentFields(from, topology).some(field => fieldKey(field, topology) === destination);
}

function defaultStepCost({movementKind, measurementMode, grid}) {
  if ( movementKind === MOVEMENT_KINDS.TELEPORT ) {
    return {ok: true, amount: 0, source: "default", metadata: {}};
  }
  if ( measurementMode === MOVEMENT_MEASUREMENT_MODES.FIELDS ) {
    return {ok: true, amount: 1, source: "default", metadata: {}};
  }
  if ( Number(grid?.distance) > 0 ) {
    return {ok: true, amount: Number(grid.distance), source: "default", metadata: {}};
  }
  return {
    ok: false,
    code: MOVEMENT_PATH_CODES.DISTANCE_REQUIRES_GRID_DISTANCE,
    reason: "Distance-mode MovementPath evaluation requires grid distance or a step-cost policy.",
    source: "default",
    amount: 0
  };
}

function normalizeEvaluationGrid(grid, topology, gridDistance) {
  if ( grid ) {
    return {
      ...clonePlain(grid),
      type: grid.type ?? topology,
      distance: grid.distance ?? gridDistance ?? null
    };
  }
  return {
    type: topology,
    distance: Number(gridDistance) > 0 ? Number(gridDistance) : null
  };
}

function movementCostUnit(measurementMode, distanceUnit="ft") {
  return measurementMode === MOVEMENT_MEASUREMENT_MODES.FIELDS ? "fields" : distanceUnit;
}

function normalizeMovementTopology(topology) {
  const normalized = String(topology ?? GRID_TOPOLOGIES.SQUARE).toLowerCase();
  if ( !Object.values(GRID_TOPOLOGIES).includes(normalized) ) {
    throw new Error(`Unknown movement path topology: ${topology}`);
  }
  return normalized;
}

function normalizeMovementSize(size) {
  const normalized = String(size ?? CREATURE_SIZES.MEDIUM).toLowerCase();
  if ( !CREATURE_SIZE_ORDER.includes(normalized) ) throw new Error(`Unknown movement path size: ${size}`);
  return normalized;
}

function normalizeMovementKind(movementKind) {
  const normalized = String(movementKind ?? MOVEMENT_KINDS.VOLUNTARY).toLowerCase();
  return Object.values(MOVEMENT_KINDS).includes(normalized) ? normalized : MOVEMENT_KINDS.VOLUNTARY;
}

function classifyPathCreationError(error) {
  if ( error.message?.includes("topology") || error.message?.includes("grid") ) return MOVEMENT_PATH_CODES.UNKNOWN_TOPOLOGY;
  if ( error.message?.includes("size") ) return MOVEMENT_PATH_CODES.UNKNOWN_SIZE;
  return MOVEMENT_PATH_CODES.INVALID_FOOTPRINT;
}

function createInvalidCost({code, movementKind, unit=null}) {
  return {
    ok: false,
    code,
    amount: 0,
    unit,
    consumesBudget: normalizeMovementKind(movementKind) === MOVEMENT_KINDS.VOLUNTARY,
    movementKind: normalizeMovementKind(movementKind)
  };
}

function createFailure({code, reason=null, ...details}) {
  return {
    code,
    reason,
    ...clonePlain(details)
  };
}

function clonePlain(value) {
  if ( value === undefined ) return undefined;
  return JSON.parse(JSON.stringify(value));
}
