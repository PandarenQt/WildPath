/**
 * Minimal safe ValueExpression evaluator shared by early Wild Path foundations.
 *
 * This intentionally supports structured expressions only. It does not evaluate JavaScript
 * strings, which keeps future homebrew formulas and selection/capacity limits safe to inspect,
 * serialize, validate, and migrate.
 */

export const VALUE_EXPRESSION_CODES = Object.freeze({
  OK: "OK",
  INVALID_EXPRESSION: "INVALID_EXPRESSION",
  UNKNOWN_CONTEXT_PATH: "UNKNOWN_CONTEXT_PATH",
  DIVIDE_BY_ZERO: "DIVIDE_BY_ZERO"
});

/* -------------------------------------------- */

/**
 * Evaluate a structured value expression.
 * @param {number|object} expression
 * @param {object} [context]
 * @returns {{ok: boolean, code: string, value: number, reason?: string}}
 */
export function evaluateValueExpression(expression, context={}) {
  if ( typeof expression === "number" ) return ok(expression);
  if ( expression == null ) return ok(0);

  switch ( expression.type ) {
    case "constant":
      return ok(Number(expression.value) || 0);
    case "context":
      return evaluateContextPath(expression.path, context);
    case "add":
      return evaluateTerms(expression.terms ?? [], context, values => values.reduce((sum, v) => sum + v, 0));
    case "multiply":
      return evaluateTerms(expression.terms ?? [], context, values => values.reduce((product, v) => product * v, 1));
    case "divide":
      return evaluateDivision(expression, context);
    case "min":
      return evaluateTerms(expression.terms ?? [], context, values => Math.min(...values));
    case "max":
      return evaluateTerms(expression.terms ?? [], context, values => Math.max(...values));
    case "floor": {
      const result = evaluateValueExpression(expression.value, context);
      return result.ok ? ok(Math.floor(result.value)) : result;
    }
    case "ceil": {
      const result = evaluateValueExpression(expression.value, context);
      return result.ok ? ok(Math.ceil(result.value)) : result;
    }
    default:
      return fail(VALUE_EXPRESSION_CODES.INVALID_EXPRESSION, `Unknown ValueExpression type: ${expression.type}`);
  }
}

/* -------------------------------------------- */

export function evaluateValueExpressionNumber(expression, context={}, fallback=0) {
  const result = evaluateValueExpression(expression, context);
  return result.ok ? result.value : fallback;
}

/* -------------------------------------------- */

function evaluateTerms(terms, context, reducer) {
  const values = [];
  for ( const term of terms ) {
    const result = evaluateValueExpression(term, context);
    if ( !result.ok ) return result;
    values.push(result.value);
  }
  return ok(values.length ? reducer(values) : 0);
}

function evaluateDivision(expression, context) {
  const numerator = evaluateValueExpression(expression.numerator ?? expression.left, context);
  if ( !numerator.ok ) return numerator;
  const denominator = evaluateValueExpression(expression.denominator ?? expression.right, context);
  if ( !denominator.ok ) return denominator;
  if ( denominator.value === 0 ) return fail(VALUE_EXPRESSION_CODES.DIVIDE_BY_ZERO, "Cannot divide by zero.");
  const value = numerator.value / denominator.value;
  return ok(expression.round === "floor" ? Math.floor(value) : value);
}

function evaluateContextPath(path, context) {
  const value = resolvePath(context, path);
  if ( typeof value !== "number" ) {
    return fail(VALUE_EXPRESSION_CODES.UNKNOWN_CONTEXT_PATH, `No numeric context value at path: ${path}`);
  }
  return ok(value);
}

function resolvePath(object, path) {
  return String(path ?? "").split(".").filter(Boolean)
    .reduce((value, key) => value?.[key], object);
}

function ok(value) {
  return {ok: true, code: VALUE_EXPRESSION_CODES.OK, value};
}

function fail(code, reason) {
  return {ok: false, code, value: 0, reason};
}
