/**
 * Small shared predicate evaluator for pure Wild Path domain helpers.
 *
 * This is intentionally a structured predicate shape, not a scripting language. It is enough for
 * early target and inventory foundations while keeping future Predicate/RuleElement work aligned
 * around one representation.
 */

export const PREDICATE_CODES = Object.freeze({
  OK: "OK",
  FAILED: "PREDICATE_FAILED",
  INVALID: "INVALID_PREDICATE"
});

/* -------------------------------------------- */

/**
 * Evaluate a structured predicate against a plain context object.
 * @param {object|null} predicate
 * @param {object} context
 * @returns {{ok: boolean, code: string, reason?: string}}
 */
export function evaluatePredicate(predicate, context={}) {
  if ( !predicate ) return pass();
  if ( Array.isArray(predicate.all) ) return evaluateAll(predicate.all, context);
  if ( Array.isArray(predicate.any) ) return evaluateAny(predicate.any, context);
  if ( predicate.not ) {
    const result = evaluatePredicate(predicate.not, context);
    return result.ok ? fail("negated predicate matched") : pass();
  }

  const tests = [
    evaluateTags(predicate, context),
    evaluateConditions(predicate, context),
    evaluateEquals(predicate, context),
    evaluateOneOf(predicate, context)
  ];
  return tests.find(result => !result.ok) ?? pass();
}

/* -------------------------------------------- */

function evaluateAll(predicates, context) {
  for ( const predicate of predicates ) {
    const result = evaluatePredicate(predicate, context);
    if ( !result.ok ) return result;
  }
  return pass();
}

function evaluateAny(predicates, context) {
  const failures = [];
  for ( const predicate of predicates ) {
    const result = evaluatePredicate(predicate, context);
    if ( result.ok ) return pass();
    failures.push(result.reason);
  }
  return fail(`none matched: ${failures.filter(Boolean).join("; ")}`);
}

function evaluateTags(predicate, context) {
  const tags = new Set(context.tags ?? context.target?.tags ?? context.action?.tags ?? []);
  if ( predicate.tagsAny?.length && !predicate.tagsAny.some(tag => tags.has(tag)) ) {
    return fail(`requires one of tags: ${predicate.tagsAny.join(", ")}`);
  }
  if ( predicate.tagsAll?.length && !predicate.tagsAll.every(tag => tags.has(tag)) ) {
    return fail(`requires all tags: ${predicate.tagsAll.join(", ")}`);
  }
  if ( predicate.notTagsAny?.length && predicate.notTagsAny.some(tag => tags.has(tag)) ) {
    return fail(`forbids one of tags: ${predicate.notTagsAny.join(", ")}`);
  }
  return pass();
}

function evaluateConditions(predicate, context) {
  const conditions = new Set(context.conditions ?? context.target?.conditions ?? []);
  if ( predicate.hasCondition && !conditions.has(predicate.hasCondition) ) {
    return fail(`requires condition: ${predicate.hasCondition}`);
  }
  if ( predicate.missingCondition && conditions.has(predicate.missingCondition) ) {
    return fail(`forbids condition: ${predicate.missingCondition}`);
  }
  return pass();
}

function evaluateEquals(predicate, context) {
  if ( !predicate.equals ) return pass();
  const value = resolvePath(context, predicate.equals.path);
  return value === predicate.equals.value ? pass() : fail(`${predicate.equals.path} did not equal ${predicate.equals.value}`);
}

function evaluateOneOf(predicate, context) {
  if ( !predicate.oneOf ) return pass();
  const value = resolvePath(context, predicate.oneOf.path);
  return predicate.oneOf.values?.includes(value) ? pass() : fail(`${predicate.oneOf.path} was not in allowed values`);
}

function resolvePath(object, path) {
  return String(path ?? "").split(".").filter(Boolean)
    .reduce((value, key) => value?.[key], object);
}

function pass() {
  return {ok: true, code: PREDICATE_CODES.OK};
}

function fail(reason) {
  return {ok: false, code: PREDICATE_CODES.FAILED, reason};
}
