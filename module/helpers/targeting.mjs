import {evaluatePredicate} from "./predicates.mjs";
import {evaluateValueExpressionNumber} from "./value-expressions.mjs";

export const TARGET_CODES = Object.freeze({
  OK: "OK",
  TARGET_NOT_FOUND: "TARGET_NOT_FOUND",
  TARGET_NOT_ELIGIBLE: "TARGET_NOT_ELIGIBLE",
  TARGET_PREDICATE_FAILED: "TARGET_PREDICATE_FAILED",
  OPERATION_NOT_ALLOWED: "OPERATION_NOT_ALLOWED",
  SELECTION_LIMIT_REACHED: "SELECTION_LIMIT_REACHED",
  SELECTION_MINIMUM_NOT_MET: "SELECTION_MINIMUM_NOT_MET"
});

export const TARGET_OPERATIONS = Object.freeze({
  INCLUDE: "include",
  EXCLUDE: "exclude",
  SELECT: "select",
  DESELECT: "deselect",
  MARK: "mark",
  OVERRIDE: "override"
});

export const TARGET_DEFAULT_SELECTION = Object.freeze({
  ALL: "all",
  NONE: "none",
  PREDICATE: "predicate"
});

export const TARGET_OVERRIDE_TYPES = Object.freeze({
  AUTOMATIC_SUCCESS: "automatic-success",
  AUTOMATIC_FAILURE: "automatic-failure",
  ADVANTAGE: "advantage",
  DISADVANTAGE: "disadvantage",
  IGNORE_DAMAGE: "ignore-damage",
  HALF_DAMAGE: "half-damage",
  ZERO_DAMAGE: "zero-damage",
  MODIFY_DAMAGE: "modify-damage",
  SKIP_CONSEQUENCE: "skip-consequence"
});

/* -------------------------------------------- */

/**
 * Normalize a physical target candidate. A candidate is not automatically a final target.
 * @param {object} data
 * @returns {object}
 */
export function createTargetCandidate(data) {
  const id = data.id ?? data.target?.id ?? data.target?.uuid;
  if ( !id ) throw new Error("TargetCandidate requires a stable id.");
  return {
    id: String(id),
    target: clonePlain(data.target ?? {id}),
    actor: data.actor ? clonePlain(data.actor) : null,
    occupiedFields: uniqueByKey(data.occupiedFields ?? []),
    intersectingFields: uniqueByKey(data.intersectingFields ?? []),
    disposition: data.disposition ?? "neutral",
    kind: data.kind ?? "creature",
    willing: !!data.willing,
    size: data.size ?? null,
    tags: [...(data.tags ?? [])],
    conditions: [...(data.conditions ?? [])],
    metadata: clonePlain(data.metadata ?? {}),
    eligibility: data.eligibility ?? {ok: true, code: TARGET_CODES.OK}
  };
}

/* -------------------------------------------- */

/**
 * Create an immutable-ish target set from candidates, de-duplicating large tokens by target id
 * while preserving all intersecting fields for debug and targeting trace output.
 * @param {object[]} candidates
 * @param {object} [options]
 * @returns {{candidates: object[], footprint: object|null, metadata: object}}
 */
export function createTargetSet(candidates=[], {footprint=null, metadata={}}={}) {
  const byId = new Map();
  for ( const raw of candidates ) {
    const candidate = createTargetCandidate(raw);
    const existing = byId.get(candidate.id);
    if ( !existing ) {
      byId.set(candidate.id, candidate);
      continue;
    }
    existing.occupiedFields = uniqueByKey([...existing.occupiedFields, ...candidate.occupiedFields]);
    existing.intersectingFields = uniqueByKey([...existing.intersectingFields, ...candidate.intersectingFields]);
  }
  return {
    candidates: [...byId.values()],
    footprint,
    metadata: clonePlain(metadata)
  };
}

/* -------------------------------------------- */

/**
 * Apply base target eligibility rules without changing physical candidate membership.
 * @param {object} targetSet
 * @param {object} [policy]
 * @param {object} [context]
 * @returns {object}
 */
export function resolveTargetEligibility(targetSet, policy={}, context={}) {
  return {
    ...targetSet,
    candidates: targetSet.candidates.map(candidate => ({
      ...cloneCandidate(candidate),
      eligibility: evaluateTargetEligibility(candidate, policy, context)
    }))
  };
}

/* -------------------------------------------- */

export function eligibleTargetSet(targetSet) {
  return {
    ...targetSet,
    candidates: targetSet.candidates.filter(candidate => candidate.eligibility?.ok)
      .map(cloneCandidate)
  };
}

/* -------------------------------------------- */

/**
 * Build structured state for future interactive targeting UI.
 * @param {object} options
 * @returns {object}
 */
export function createTargetSelectionRequest({targetSet, policy={}, context={}}) {
  const selected = defaultSelectedIds(targetSet.candidates, policy, context);
  const allowed = new Set(policy.allowedOperations ?? [TARGET_OPERATIONS.SELECT, TARGET_OPERATIONS.DESELECT]);
  return {
    candidates: targetSet.candidates.map(candidate => {
      const eligible = !!candidate.eligibility?.ok;
      const predicate = evaluateSelectionPredicate(candidate, policy, context);
      const currentlySelected = selected.has(candidate.id);
      return {
        targetId: candidate.id,
        eligible,
        physicallyInArea: true,
        selected: currentlySelected,
        selectable: eligible && predicate.ok && allowed.has(TARGET_OPERATIONS.SELECT) && !currentlySelected,
        deselectable: eligible && predicate.ok && allowed.has(TARGET_OPERATIONS.DESELECT) && currentlySelected,
        protected: false,
        ineligibleReason: eligible ? null : candidate.eligibility?.reason ?? candidate.eligibility?.code,
        predicateReason: predicate.ok ? null : predicate.reason
      };
    }),
    currentlySelected: [...selected],
    requiredMin: evaluateLimit(policy.minSelections ?? policy.minChoices ?? 0, context),
    allowedMax: evaluateLimit(policy.maxSelections ?? policy.maxChoices ?? targetSet.candidates.length, context),
    chooser: policy.chooser ?? "source-controller",
    reason: policy.reason ?? null
  };
}

/* -------------------------------------------- */

/**
 * Apply target refinement decisions to an eligible target set.
 * @param {object} options
 * @returns {object}
 */
export function refineTargetSet({targetSet, policy={}, decisions=[], context={}}) {
  const selected = defaultSelectedIds(targetSet.candidates, policy, context);
  const excluded = new Set();
  const overrides = new Map();
  const marks = new Map();
  const validation = [];
  const allowedOperations = new Set(policy.allowedOperations ?? [
    TARGET_OPERATIONS.SELECT,
    TARGET_OPERATIONS.DESELECT,
    TARGET_OPERATIONS.EXCLUDE,
    TARGET_OPERATIONS.INCLUDE,
    TARGET_OPERATIONS.OVERRIDE,
    TARGET_OPERATIONS.MARK
  ]);

  for ( const decision of decisions ) {
    const target = targetSet.candidates.find(candidate => candidate.id === decision.targetId);
    if ( !target ) {
      validation.push(error(TARGET_CODES.TARGET_NOT_FOUND, decision));
      continue;
    }
    if ( !target.eligibility?.ok ) {
      validation.push(error(TARGET_CODES.TARGET_NOT_ELIGIBLE, decision, target.eligibility.reason));
      continue;
    }
    if ( !allowedOperations.has(decision.operation) ) {
      validation.push(error(TARGET_CODES.OPERATION_NOT_ALLOWED, decision));
      continue;
    }
    const predicate = evaluateSelectionPredicate(target, policy, context);
    if ( !predicate.ok ) {
      validation.push(error(TARGET_CODES.TARGET_PREDICATE_FAILED, decision, predicate.reason));
      continue;
    }
    applyDecision({decision, selected, excluded, overrides, marks});
  }

  validateSelectionLimits({selected, decisions, policy, context, validation});

  const finalTargets = targetSet.candidates.filter(candidate => selected.has(candidate.id) && !excluded.has(candidate.id))
    .map(cloneCandidate);
  const excludedTargets = targetSet.candidates.filter(candidate => excluded.has(candidate.id)).map(cloneCandidate);

  return {
    ok: validation.length === 0,
    code: validation.length ? validation[0].code : TARGET_CODES.OK,
    footprint: targetSet.footprint,
    physicalCandidates: targetSet.candidates.map(cloneCandidate),
    selected: [...selected],
    excluded: [...excluded],
    finalTargets,
    excludedTargets,
    overrides: Object.fromEntries([...overrides.entries()].map(([id, values]) => [id, values.map(clonePlain)])),
    marks: Object.fromEntries(marks),
    decisions: decisions.map(clonePlain),
    validation,
    targetContexts: buildTargetContexts(targetSet.candidates, selected, excluded, overrides)
  };
}

/* -------------------------------------------- */

export function attachTargetOverride(decision, override, source=null) {
  return {
    operation: TARGET_OPERATIONS.OVERRIDE,
    targetId: decision.targetId ?? decision,
    override: {...override, source: source ? clonePlain(source) : override.source ?? null}
  };
}

/* -------------------------------------------- */

function evaluateTargetEligibility(candidate, policy, context) {
  if ( policy.kinds?.length && !policy.kinds.includes(candidate.kind) ) {
    return {ok: false, code: TARGET_CODES.TARGET_NOT_ELIGIBLE, reason: `kind ${candidate.kind} is not eligible`};
  }
  if ( policy.dispositions?.length && !policy.dispositions.includes(candidate.disposition) ) {
    return {ok: false, code: TARGET_CODES.TARGET_NOT_ELIGIBLE, reason: `disposition ${candidate.disposition} is not eligible`};
  }
  if ( policy.willing === true && !candidate.willing ) {
    return {ok: false, code: TARGET_CODES.TARGET_NOT_ELIGIBLE, reason: "target is not willing"};
  }
  const predicate = evaluatePredicate(policy.predicate, targetPredicateContext(candidate, context));
  if ( !predicate.ok ) return {ok: false, code: TARGET_CODES.TARGET_PREDICATE_FAILED, reason: predicate.reason};
  return {ok: true, code: TARGET_CODES.OK};
}

function evaluateSelectionPredicate(candidate, policy, context) {
  return evaluatePredicate(policy.selectionPredicate ?? policy.predicate, targetPredicateContext(candidate, context));
}

function targetPredicateContext(candidate, context) {
  return {
    ...context,
    target: candidate,
    tags: candidate.tags,
    conditions: candidate.conditions,
    disposition: candidate.disposition,
    kind: candidate.kind,
    willing: candidate.willing,
    size: candidate.size
  };
}

function defaultSelectedIds(candidates, policy, context) {
  const defaultSelection = policy.defaultSelection ?? TARGET_DEFAULT_SELECTION.ALL;
  if ( defaultSelection === TARGET_DEFAULT_SELECTION.NONE ) return new Set();
  if ( defaultSelection === TARGET_DEFAULT_SELECTION.PREDICATE ) {
    return new Set(candidates.filter(candidate => candidate.eligibility?.ok)
      .filter(candidate => evaluatePredicate(policy.defaultPredicate, targetPredicateContext(candidate, context)).ok)
      .map(candidate => candidate.id));
  }
  return new Set(candidates.filter(candidate => candidate.eligibility?.ok).map(candidate => candidate.id));
}

function applyDecision({decision, selected, excluded, overrides, marks}) {
  switch ( decision.operation ) {
    case TARGET_OPERATIONS.SELECT:
    case TARGET_OPERATIONS.INCLUDE:
      selected.add(decision.targetId);
      excluded.delete(decision.targetId);
      break;
    case TARGET_OPERATIONS.DESELECT:
      selected.delete(decision.targetId);
      break;
    case TARGET_OPERATIONS.EXCLUDE:
      selected.delete(decision.targetId);
      excluded.add(decision.targetId);
      break;
    case TARGET_OPERATIONS.OVERRIDE:
      if ( !overrides.has(decision.targetId) ) overrides.set(decision.targetId, []);
      overrides.get(decision.targetId).push(clonePlain(decision.override ?? {type: "generic"}));
      selected.add(decision.targetId);
      break;
    case TARGET_OPERATIONS.MARK:
      marks.set(decision.targetId, decision.mark ?? true);
      break;
  }
}

function validateSelectionLimits({selected, decisions, policy, context, validation}) {
  const choiceCount = new Set(decisions.map(decision => decision.targetId)).size;
  const maxChoices = policy.maxChoices == null ? Infinity : evaluateLimit(policy.maxChoices, context);
  const minChoices = policy.minChoices == null ? 0 : evaluateLimit(policy.minChoices, context);
  const maxSelections = policy.maxSelections == null ? Infinity : evaluateLimit(policy.maxSelections, context);
  const minSelections = policy.minSelections == null ? 0 : evaluateLimit(policy.minSelections, context);

  if ( choiceCount > maxChoices || selected.size > maxSelections ) {
    validation.push({code: TARGET_CODES.SELECTION_LIMIT_REACHED, reason: "too many target choices"});
  }
  if ( choiceCount < minChoices || selected.size < minSelections ) {
    validation.push({code: TARGET_CODES.SELECTION_MINIMUM_NOT_MET, reason: "not enough target choices"});
  }
}

function buildTargetContexts(candidates, selected, excluded, overrides) {
  return candidates.filter(candidate => selected.has(candidate.id) || excluded.has(candidate.id))
    .map(candidate => ({
      target: cloneCandidate(candidate),
      selected: selected.has(candidate.id),
      excluded: excluded.has(candidate.id),
      resolutionState: excluded.has(candidate.id) ? "excluded" : "normal",
      overrides: (overrides.get(candidate.id) ?? []).map(clonePlain),
      results: []
    }));
}

function evaluateLimit(expression, context) {
  return Math.max(Math.floor(evaluateValueExpressionNumber(expression, context, 0)), 0);
}

function error(code, decision, reason=null) {
  return {code, targetId: decision.targetId, operation: decision.operation, reason};
}

function cloneCandidate(candidate) {
  return createTargetCandidate(candidate);
}

function uniqueByKey(values) {
  const map = new Map();
  for ( const value of values ) map.set(fieldKey(value), clonePlain(value));
  return [...map.values()];
}

function fieldKey(value) {
  if ( typeof value === "string" ) return value;
  return value?.id ?? `${value?.q ?? value?.x ?? 0},${value?.r ?? value?.y ?? 0},${value?.s ?? ""}`;
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}
