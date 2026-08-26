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

const PREDICATE_KEYS = new Set([
  "all",
  "any",
  "not",
  "tagsAny",
  "tagsAll",
  "notTagsAny",
  "hasCondition",
  "missingCondition",
  "equals",
  "oneOf"
]);

/* -------------------------------------------- */

/**
 * Evaluate a structured predicate against a plain context object.
 * @param {object|null} predicate
 * @param {object} context
 * @returns {{ok: boolean, code: string, reason?: string}}
 */
export function evaluatePredicate(predicate, context={}) {
  if ( !predicate ) return pass();
  if ( !isPredicateObject(predicate) ) return invalid("Predicate must be a structured object.");

  const unknownKeys = Object.keys(predicate).filter(key => !PREDICATE_KEYS.has(key));
  if ( unknownKeys.length ) return invalid(`Unknown predicate key(s): ${unknownKeys.join(", ")}`);

  if ( "all" in predicate ) {
    if ( !Array.isArray(predicate.all) ) return invalid("Predicate 'all' must be an array.");
    return evaluateAll(predicate.all, context);
  }
  if ( "any" in predicate ) {
    if ( !Array.isArray(predicate.any) ) return invalid("Predicate 'any' must be an array.");
    return evaluateAny(predicate.any, context);
  }
  if ( "not" in predicate ) {
    if ( !isPredicateObject(predicate.not) ) return invalid("Predicate 'not' must contain a structured predicate.");
    const result = evaluatePredicate(predicate.not, context);
    if ( result.code === PREDICATE_CODES.INVALID ) return result;
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
  for ( const key of ["tagsAny", "tagsAll", "notTagsAny"] ) {
    if ( key in predicate && !Array.isArray(predicate[key]) ) return invalid(`Predicate '${key}' must be an array.`);
  }
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
  if ( !("equals" in predicate) ) return pass();
  if ( !isPlainObject(predicate.equals) || !("path" in predicate.equals) ) {
    return invalid("Predicate 'equals' must include a path.");
  }
  const value = resolvePath(context, predicate.equals.path);
  return value === predicate.equals.value ? pass() : fail(`${predicate.equals.path} did not equal ${predicate.equals.value}`);
}

function evaluateOneOf(predicate, context) {
  if ( !("oneOf" in predicate) ) return pass();
  if ( !isPlainObject(predicate.oneOf) || !("path" in predicate.oneOf) || !Array.isArray(predicate.oneOf.values) ) {
    return invalid("Predicate 'oneOf' must include a path and values array.");
  }
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

function invalid(reason) {
  return {ok: false, code: PREDICATE_CODES.INVALID, reason};
}

function isPredicateObject(value) {
  return isPlainObject(value);
}

function isPlainObject(value) {
  return (typeof value === "object") && value !== null && !Array.isArray(value);
}
