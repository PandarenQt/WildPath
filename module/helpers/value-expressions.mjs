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
      return evaluateConstant(expression.value);
    case "context":
      return evaluateContextPath(expression.path, context);
    case "ability-score":
    case "abilityScore":
      return evaluateAbilityScore(expression, context);
    case "ability-modifier":
    case "abilityModifier":
      return evaluateAbilityModifier(expression, context);
    case "proficiency-bonus":
    case "proficiencyBonus":
      return evaluateProficiencyBonus(context);
    case "character-level":
    case "characterLevel":
      return evaluateCharacterLevel(context);
    case "class-level":
    case "classLevel":
      return evaluateClassLevel(expression, context);
    case "spellcasting-modifier":
    case "spellcastingModifier":
      return evaluateSpellcastingModifier(expression, context);
    case "resource-current":
    case "resourceCurrent":
      return evaluateResource(expression, context, "current");
    case "resource-max":
    case "resourceMax":
      return evaluateResource(expression, context, "max");
    case "add":
      return evaluateTerms(expression.terms ?? [], context, values => values.reduce((sum, v) => sum + v, 0));
    case "subtract":
      return evaluateSubtraction(expression, context);
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
    case "dice":
      return evaluateDiceExpression(expression, context);
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

function evaluateConstant(value) {
  const number = finiteNumber(value);
  return number == null
    ? fail(VALUE_EXPRESSION_CODES.INVALID_EXPRESSION, `Constant ValueExpression must be numeric: ${value}`)
    : ok(number);
}

function evaluateSubtraction(expression, context) {
  if ( Array.isArray(expression.terms) ) {
    if ( !expression.terms.length ) return ok(0);
    const [first, ...rest] = expression.terms;
    const initial = evaluateValueExpression(first, context);
    if ( !initial.ok ) return initial;
    const values = [];
    for ( const term of rest ) {
      const result = evaluateValueExpression(term, context);
      if ( !result.ok ) return result;
      values.push(result.value);
    }
    return ok(values.reduce((difference, value) => difference - value, initial.value));
  }

  const left = evaluateValueExpression(expression.left ?? expression.value ?? 0, context);
  if ( !left.ok ) return left;
  const right = evaluateValueExpression(expression.right ?? expression.minus ?? 0, context);
  if ( !right.ok ) return right;
  return ok(left.value - right.value);
}

function evaluateDivision(expression, context) {
  const numerator = evaluateValueExpression(expression.numerator ?? expression.left, context);
  if ( !numerator.ok ) return numerator;
  const denominator = evaluateValueExpression(expression.denominator ?? expression.right, context);
  if ( !denominator.ok ) return denominator;
  if ( denominator.value === 0 ) return fail(VALUE_EXPRESSION_CODES.DIVIDE_BY_ZERO, "Cannot divide by zero.");
  const value = numerator.value / denominator.value;
  return ok(roundValue(value, expression.round));
}

function evaluateContextPath(path, context) {
  const value = resolvePath(context, path);
  if ( !Number.isFinite(value) ) {
    return fail(VALUE_EXPRESSION_CODES.UNKNOWN_CONTEXT_PATH, `No numeric context value at path: ${path}`);
  }
  return ok(value);
}

function evaluateAbilityScore(expression, context) {
  const ability = expression.ability ?? expression.key ?? expression.slug;
  const score = resolveAbilityScore(ability, context);
  return score == null
    ? fail(VALUE_EXPRESSION_CODES.UNKNOWN_CONTEXT_PATH, `No ability score found for ability: ${ability}`)
    : ok(score);
}

function evaluateAbilityModifier(expression, context) {
  const score = evaluateAbilityScore(expression, context);
  return score.ok ? ok(abilityModifier(score.value)) : score;
}

function evaluateProficiencyBonus(context) {
  const explicit = firstNumeric([
    context.proficiencyBonus,
    context.actor?.proficiencyBonus,
    context.actor?.system?.proficiencyBonus,
    context.actor?.system?.attributes?.proficiency,
    context.actor?.system?.attributes?.prof,
    context.actorSystem?.proficiencyBonus,
    context.actorSystem?.attributes?.proficiency,
    context.actorSystem?.attributes?.prof
  ]);
  if ( explicit != null ) return ok(explicit);

  const level = resolveCharacterLevel(context);
  return level == null
    ? fail(VALUE_EXPRESSION_CODES.UNKNOWN_CONTEXT_PATH, "No proficiency bonus or character level found.")
    : ok(2 + Math.floor((Math.max(level, 1) - 1) / 4));
}

function evaluateCharacterLevel(context) {
  const level = resolveCharacterLevel(context);
  return level == null
    ? fail(VALUE_EXPRESSION_CODES.UNKNOWN_CONTEXT_PATH, "No character level found.")
    : ok(level);
}

function evaluateClassLevel(expression, context) {
  const classKey = expression.class ?? expression.classId ?? expression.key ?? expression.slug ?? expression.name;
  const level = resolveClassLevel(classKey, context);
  return level == null
    ? fail(VALUE_EXPRESSION_CODES.UNKNOWN_CONTEXT_PATH, `No class level found for class: ${classKey}`)
    : ok(level);
}

function evaluateSpellcastingModifier(expression, context) {
  const explicit = firstNumeric([
    context.spellcastingModifier,
    context.actor?.spellcastingModifier,
    context.actor?.system?.spellcasting?.modifier,
    context.actorSystem?.spellcasting?.modifier
  ]);
  if ( explicit != null ) return ok(explicit);

  const ability = expression.ability
    ?? context.spellcastingAbility
    ?? context.actor?.system?.spellcasting?.ability
    ?? context.actorSystem?.spellcasting?.ability;
  return ability
    ? evaluateAbilityModifier({type: "ability-modifier", ability}, context)
    : fail(VALUE_EXPRESSION_CODES.UNKNOWN_CONTEXT_PATH, "No spellcasting modifier or spellcasting ability found.");
}

function evaluateResource(expression, context, kind) {
  const resourceId = expression.resource ?? expression.resourceId ?? expression.id ?? expression.key;
  const resource = resolveResource(resourceId, context);
  if ( !resource ) return fail(VALUE_EXPRESSION_CODES.UNKNOWN_CONTEXT_PATH, `No resource found: ${resourceId}`);

  const value = kind === "current"
    ? firstNumeric([resource.current, resource.value])
    : firstNumeric([resource.max, resource.maximum]);
  return value == null
    ? fail(VALUE_EXPRESSION_CODES.UNKNOWN_CONTEXT_PATH, `No ${kind} value found for resource: ${resourceId}`)
    : ok(value);
}

function evaluateDiceExpression(expression, context) {
  const explicitTotal = firstNumeric([expression.total, expression.rolled, expression.roll]);
  if ( explicitTotal != null ) return ok(explicitTotal);

  const number = finiteNumber(expression.number ?? expression.count ?? 1);
  const faces = finiteNumber(expression.faces ?? expression.sides);
  if ( number == null || faces == null || number < 0 || faces <= 0 ) {
    return fail(VALUE_EXPRESSION_CODES.INVALID_EXPRESSION, "Dice ValueExpression requires non-negative dice count and positive faces.");
  }

  const bonus = evaluateValueExpression(expression.bonus ?? 0, context);
  if ( !bonus.ok ) return bonus;

  if ( expression.evaluation === "average" || expression.mode === "average" || context.diceMode === "average" || context.dicePolicy === "average" ) {
    return ok((number * (faces + 1)) / 2 + bonus.value);
  }

  return fail(
    VALUE_EXPRESSION_CODES.INVALID_EXPRESSION,
    "Dice ValueExpression requires a numeric total or average evaluation mode."
  );
}

function resolvePath(object, path) {
  return String(path ?? "").split(".").filter(Boolean)
    .reduce((value, key) => value?.[key], object);
}

function resolveAbilityScore(ability, context) {
  if ( !ability ) return null;
  const roots = actorRoots(context);
  for ( const root of roots ) {
    const abilityData = root?.abilities?.[ability];
    const value = typeof abilityData === "object" && abilityData !== null
      ? firstNumeric([abilityData.value, abilityData.score])
      : finiteNumber(abilityData);
    if ( value != null ) return value;
  }
  return null;
}

function resolveCharacterLevel(context) {
  const explicit = firstNumeric([
    context.characterLevel,
    context.level,
    context.actor?.level,
    context.actor?.system?.details?.level,
    context.actor?.system?.level,
    context.actorSystem?.details?.level,
    context.actorSystem?.level
  ]);
  if ( explicit != null ) return explicit;

  const classTotal = sumClassLevels(context.actor?.system?.classes ?? context.actorSystem?.classes ?? context.classLevels);
  return classTotal > 0 ? classTotal : null;
}

function resolveClassLevel(classKey, context) {
  const sources = [
    context.classLevels,
    context.actor?.system?.classes,
    context.actorSystem?.classes
  ];
  for ( const source of sources ) {
    const level = classLevelFromSource(source, classKey);
    if ( level != null ) return level;
  }
  return null;
}

function classLevelFromSource(source, classKey) {
  if ( !source ) return null;
  if ( Array.isArray(source) ) {
    const found = source.find(entry => !classKey || [entry.id, entry.slug, entry.key, entry.name].includes(classKey));
    return found ? firstNumeric([found.level, found.levels, found.value]) : null;
  }

  if ( classKey && source[classKey] != null ) {
    const entry = source[classKey];
    return typeof entry === "object" && entry !== null
      ? firstNumeric([entry.level, entry.levels, entry.value])
      : finiteNumber(entry);
  }

  return null;
}

function sumClassLevels(source) {
  if ( !source ) return 0;
  const entries = Array.isArray(source) ? source : Object.values(source);
  return entries.reduce((sum, entry) => {
    const value = typeof entry === "object" && entry !== null
      ? firstNumeric([entry.level, entry.levels, entry.value])
      : finiteNumber(entry);
    return sum + (value ?? 0);
  }, 0);
}

function resolveResource(resourceId, context) {
  if ( !resourceId ) return null;
  const resources = [
    context.resources,
    context.actor?.system?.resources,
    context.actorSystem?.resources
  ];
  for ( const source of resources ) {
    const resource = source?.[resourceId];
    if ( resource ) return resource;
  }

  const pools = [
    context.pools,
    context.actor?.system?.pools,
    context.actorSystem?.pools
  ];
  for ( const source of pools ) {
    const resource = Array.isArray(source)
      ? source.find(pool => pool.id === resourceId || pool.key === resourceId)
      : source?.[resourceId];
    if ( resource ) return resource;
  }
  return null;
}

function actorRoots(context) {
  return [
    context.actor,
    context.actor?.system,
    context.actorSystem,
    context.source?.actor,
    context.source?.actor?.system
  ].filter(Boolean);
}

function abilityModifier(score) {
  return Math.floor((score - 10) / 2);
}

function roundValue(value, mode) {
  switch ( mode ) {
    case "floor": return Math.floor(value);
    case "ceil": return Math.ceil(value);
    case "round": return Math.round(value);
    default: return value;
  }
}

function firstNumeric(values) {
  for ( const value of values ) {
    const number = finiteNumber(value);
    if ( number != null ) return number;
  }
  return null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ok(value) {
  return {ok: true, code: VALUE_EXPRESSION_CODES.OK, value};
}

function fail(code, reason) {
  return {ok: false, code, value: 0, reason};
}
