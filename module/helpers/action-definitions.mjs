import {normalizeActivationCost} from "./action-economy.mjs";
import {computeActivationCost} from "./actions.mjs";
import {evaluatePredicate, PREDICATE_CODES} from "./predicates.mjs";
import {evaluateValueExpression} from "./value-expressions.mjs";
import {
  RULE_ELEMENT_CODES,
  serializeRuleElementDefinition,
  validateRuleElementDefinition
} from "./rule-elements.mjs";

export const ACTION_DEFINITION_SCHEMA_VERSION = 1;

export const ACTION_DEFINITION_CODES = Object.freeze({
  OK: "OK",
  INVALID_DEFINITION: "INVALID_DEFINITION",
  INVALID_SCHEMA_VERSION: "INVALID_SCHEMA_VERSION",
  MISSING_IDENTITY: "MISSING_IDENTITY",
  INVALID_COST: "INVALID_COST",
  INVALID_PREDICATE: "INVALID_PREDICATE",
  INVALID_VALUE_EXPRESSION: "INVALID_VALUE_EXPRESSION",
  INVALID_TARGETING: "INVALID_TARGETING",
  MISSING_AREA_DEFINITION: "MISSING_AREA_DEFINITION",
  INVALID_AREA: "INVALID_AREA",
  INVALID_ATTACK: "INVALID_ATTACK",
  INVALID_SAVE: "INVALID_SAVE",
  INVALID_DAMAGE: "INVALID_DAMAGE",
  INVALID_DAMAGE_TYPE: "INVALID_DAMAGE_TYPE",
  INVALID_HEALING: "INVALID_HEALING",
  MISSING_EFFECT_REFERENCE: "MISSING_EFFECT_REFERENCE",
  INVALID_EFFECT: "INVALID_EFFECT",
  INVALID_RULE_ELEMENT: "INVALID_RULE_ELEMENT",
  NON_SERIALIZABLE: "NON_SERIALIZABLE"
});

export const ACTION_ORIGIN_TYPES = Object.freeze({
  SELF: "self",
  ELIGIBLE_CONTROLLED: "eligible-controlled",
  SELF_AND_ELIGIBLE_CONTROLLED: "self-and-eligible-controlled",
  LINKED_SOURCE: "linked-source",
  CUSTOM: "custom"
});

export const ACTION_RANGE_TYPES = Object.freeze({
  SELF: "self",
  TOUCH: "touch",
  REACH: "reach",
  RANGED: "ranged",
  SIGHT: "sight",
  SPECIAL: "special"
});

export const ACTION_TARGETING_TYPES = Object.freeze({
  NONE: "none",
  SELF: "self",
  SINGLE: "single",
  MULTIPLE: "multiple",
  AREA: "area"
});

export const ACTION_AREA_SHAPES = Object.freeze({
  RADIAL: "radial",
  LINE: "line",
  CONE: "cone",
  WALL: "wall",
  AURA: "aura",
  EMANATION: "emanation",
  SPECIAL: "special"
});

const DAMAGE_TYPE_PATTERN = /^[a-z][a-z0-9-]*$/i;

/* -------------------------------------------- */

export function normalizeActionDefinition(rawDefinition={}, {
  item=null,
  source=null,
  legacyCost=null,
  legacyActivationCost=null
}={}) {
  const raw = isPlainObject(rawDefinition) ? rawDefinition : {};
  const itemSystem = item?.system ?? {};
  const itemSourceData = source ?? sourceFromItem(item);
  const legacyCostShape = legacyActivationCost
    ?? safeLegacyActivationCost(itemSystem)
    ?? computeActivationCost(legacyCost ?? itemSystem.cost);
  const definitionCost = raw.costs ?? raw.activationCost ?? raw.cost ?? legacyCostShape;

  return {
    schemaVersion: normalizeSchemaVersion(raw.schemaVersion) ?? ACTION_DEFINITION_SCHEMA_VERSION,
    id: stringOrNull(raw.id ?? raw.actionId ?? item?.id ?? item?.uuid),
    slug: stringOrNull(raw.slug ?? raw.key ?? itemSystem.slug ?? item?.slug),
    label: stringOrNull(raw.label ?? raw.name ?? item?.name),
    category: stringOrDefault(raw.category ?? raw.type, "action"),
    tags: normalizeStrings(raw.tags ?? itemSystem.tags),
    source: clonePlain(raw.source ?? itemSourceData),
    origin: normalizeOriginDefinition(raw.origin),
    activation: normalizeActivationDefinition(raw.activation),
    costs: normalizeCostDefinition(definitionCost),
    range: normalizeRangeDefinition(raw.range),
    targeting: normalizeTargetingDefinition(raw.targeting ?? raw.target),
    area: normalizeAreaDefinition(raw.area),
    attack: normalizePlainComponent(raw.attack),
    save: normalizePlainComponent(raw.save),
    check: normalizePlainComponent(raw.check),
    damage: normalizeArray(raw.damage ?? raw.damageDefinitions ?? raw.damageComponents).map(normalizeDamageDefinition),
    healing: normalizeArray(raw.healing ?? raw.healingDefinitions ?? raw.healingComponents).map(normalizeHealingDefinition),
    effects: normalizeArray(raw.effects ?? raw.effectApplications ?? raw.effectApplicationDefinitions).map(normalizeEffectApplicationDefinition),
    duration: normalizeDurationDefinition(raw.duration),
    configuration: normalizeArray(raw.configuration ?? raw.configurations).map(clonePlain),
    ruleElements: normalizeArray(raw.ruleElements).map(clonePlain),
    policies: clonePlain(raw.policies ?? raw.resolutionPolicies ?? {}) ?? {},
    metadata: clonePlain(raw.metadata ?? {}) ?? {}
  };
}

/* -------------------------------------------- */

export function validateActionDefinition(rawDefinition={}, options={}) {
  if ( !isPlainObject(rawDefinition) ) {
    return validationFailure(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "ActionDefinition must be a plain object.", "definition");
  }

  const serializableIssue = findNonSerializable(rawDefinition, "definition");
  if ( serializableIssue ) {
    return validationFailure(ACTION_DEFINITION_CODES.NON_SERIALIZABLE, serializableIssue.reason, serializableIssue.path);
  }

  const definition = normalizeActionDefinition(rawDefinition, options);
  const errors = [];

  if ( definition.schemaVersion !== ACTION_DEFINITION_SCHEMA_VERSION ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_SCHEMA_VERSION, "schemaVersion", "ActionDefinition schemaVersion must be 1."));
  }
  if ( !definition.id ) {
    errors.push(error(ACTION_DEFINITION_CODES.MISSING_IDENTITY, "id", "ActionDefinition requires stable identity."));
  }

  validateCosts(definition.costs, errors);
  validatePredicateCandidates(definition, errors);
  validateTargeting(definition, errors);
  validateArea(definition.area, errors);
  validateAttack(definition.attack, errors);
  validateSave(definition.save, errors);
  validateDamage(definition.damage, errors);
  validateHealing(definition.healing, errors);
  validateEffects(definition.effects, errors, options);
  validateRuleElements(definition.ruleElements, errors);

  return {
    ok: errors.length === 0,
    code: errors[0]?.code ?? ACTION_DEFINITION_CODES.OK,
    definition,
    errors
  };
}

/* -------------------------------------------- */

export function serializeActionDefinition(rawDefinition={}, options={}) {
  const validation = validateActionDefinition(rawDefinition, options);
  const definition = validation.definition ?? normalizeActionDefinition(rawDefinition, options);
  const serializedRuleElements = definition.ruleElements.map((ruleElement, index) => {
    const serialized = serializeRuleElementDefinition(ruleElement, {
      source: actionDefinitionRuleElementSource(definition),
      index
    });
    return serialized.definition;
  });

  return {
    ok: validation.ok,
    code: validation.code,
    definition: clonePlain({
      ...definition,
      ruleElements: serializedRuleElements
    }),
    errors: validation.errors ?? []
  };
}

/* -------------------------------------------- */

export function actionDefinitionFromItem(item, options={}) {
  const system = item?.system ?? {};
  const raw = system.definition ?? system.actionDefinition ?? item?.definition ?? item?.actionDefinition ?? null;
  const migrated = !hasAuthoredDefinition(raw);
  const source = sourceFromItem(item);
  const legacyActivationCost = options.legacyActivationCost
    ?? item?.activationCost
    ?? (typeof system.getActivationCost === "function" && typeof system.getActionDefinition !== "function"
      ? system.getActivationCost()
      : null);
  const legacyCost = system.cost ?? item?.cost;
  const baseDefinition = migrated ? {
    id: item?.id ?? item?.uuid ?? null,
    label: item?.name ?? null,
    source,
    metadata: {
      migration: {
        from: "legacy-action-cost",
        schemaVersion: ACTION_DEFINITION_SCHEMA_VERSION
      }
    }
  } : raw;

  const validation = validateActionDefinition(baseDefinition, {
    ...options,
    item,
    source,
    legacyCost,
    legacyActivationCost
  });

  return {
    ...validation,
    migrated
  };
}

/* -------------------------------------------- */

export function actionDefinitionFromAction(action, options={}) {
  if ( !action ) {
    return validationFailure(ACTION_DEFINITION_CODES.INVALID_DEFINITION, "Action is required.", "action");
  }
  if ( action.definition || action.actionDefinition || action.system?.definition || action.system?.actionDefinition ) {
    return actionDefinitionFromItem(action, options);
  }
  return actionDefinitionFromItem(action, options);
}

/* -------------------------------------------- */

export function actionDefinitionActivationCost(definition) {
  const cost = normalizeActivationCost(definition?.costs ?? {allOf: []});
  if ( cost.anyOf ) return {
    anyOf: cost.anyOf.map(branch => branch.map(costRequirementForPayment).filter(requirement => requirement.amount > 0))
  };
  return {
    allOf: (cost.allOf ?? []).map(costRequirementForPayment).filter(requirement => requirement.amount > 0)
  };
}

/* -------------------------------------------- */

export function actionDefinitionToResolverInput(definition, {
  actorSystem=null,
  source=null,
  targets=[],
  targeting=null,
  attack=null,
  save=null,
  damage=null,
  healing=null,
  effects=null,
  context={},
  policies={}
}={}) {
  const normalized = normalizeActionDefinition(definition);
  const evaluationContext = {
    actorSystem,
    source,
    targets,
    action: normalized,
    actionDefinition: normalized,
    ...(context ?? {})
  };
  const base = {
    context: {
      ...context,
      actionDefinition: normalized,
      areaDefinition: normalized.area,
      rangeDefinition: normalized.range,
      originDefinition: normalized.origin,
      durationDefinition: normalized.duration,
      configurationDefinitions: normalized.configuration
    },
    policies: {
      ...normalized.policies,
      ...policies
    },
    targeting: targetingFromDefinition(normalized, {source, targeting}),
    attack: resolverRequestFromAttackDefinition(normalized.attack, attack),
    save: resolverRequestFromSaveDefinition(normalized.save, save, evaluationContext),
    damage: resolverRequestFromDamageDefinition(normalized, damage, evaluationContext),
    healing: resolverRequestFromHealingDefinition(normalized, healing, evaluationContext),
    effects: resolverRequestFromEffectsDefinition(normalized, effects)
  };

  return {
    ...base,
    targets: targets.length ? targets.map(clonePlain) : []
  };
}

/* -------------------------------------------- */

function targetingFromDefinition(definition, {source, targeting}) {
  const targetDefinition = definition.targeting;
  if ( !targetDefinition ) return targeting ?? null;

  const count = targetDefinition.count;
  const refinementPolicy = {
    ...(targetDefinition.refinementPolicy ?? {}),
    ...(count != null ? {
      minSelections: targetDefinition.required ? count : (targetDefinition.refinementPolicy?.minSelections ?? 0),
      maxSelections: count
    } : {})
  };
  const eligibilityPolicy = {
    ...(targetDefinition.eligibilityPolicy ?? {}),
    ...(targetDefinition.predicate ? {predicate: targetDefinition.predicate} : {})
  };
  const definitionTargets = targetDefinition.type === ACTION_TARGETING_TYPES.SELF && source
    ? [source]
    : [];

  return mergeResolverRequest({
    required: targetDefinition.required,
    eligibilityPolicy,
    refinementPolicy,
    targets: definitionTargets,
    metadata: {
      actionDefinitionId: definition.id,
      targetingType: targetDefinition.type,
      range: definition.range,
      area: definition.area
    }
  }, targeting);
}

function resolverRequestFromAttackDefinition(attackDefinition, runtimeAttack) {
  if ( !attackDefinition ) return runtimeAttack ?? null;
  return mergeResolverRequest({
    defenseKey: attackDefinition.defenseKey ?? "ac",
    policy: attackDefinition.policy ?? {},
    context: {attackDefinition}
  }, runtimeAttack);
}

function resolverRequestFromSaveDefinition(saveDefinition, runtimeSave, evaluationContext) {
  if ( !saveDefinition ) return runtimeSave ?? null;
  const dc = saveDefinition.dc
    ? resolveSaveDCDefinition(saveDefinition.dc, evaluationContext)
    : null;
  return mergeResolverRequest({
    saveKey: saveDefinition.saveKey ?? saveDefinition.ability ?? null,
    dc,
    dcKey: saveDefinition.dcKey ?? "save",
    policy: saveDefinition.policy ?? {},
    context: {saveDefinition}
  }, runtimeSave);
}

function resolverRequestFromDamageDefinition(definition, runtimeDamage, evaluationContext) {
  if ( !definition.damage.length ) return runtimeDamage ?? null;
  const runtimeComponents = normalizeArray(runtimeDamage?.components);
  const components = definition.damage.map((component, index) => damageComponentForResolver({
    component,
    index,
    runtimeComponents,
    evaluationContext
  }));
  return mergeResolverRequest({
    components,
    saveOutcomePolicy: firstDefined(definition.damage.map(component => component.outcomePolicy?.saveOutcomePolicy ?? component.saveOutcomePolicy)),
    weaponSize: firstDefined(definition.damage.map(component => component.weaponSize)),
    context: {damageDefinitions: definition.damage}
  }, runtimeDamage && !runtimeDamage.components ? runtimeDamage : {...(runtimeDamage ?? {}), components});
}

function resolverRequestFromHealingDefinition(definition, runtimeHealing, evaluationContext) {
  if ( !definition.healing.length ) return runtimeHealing ?? null;
  const runtimeComponents = normalizeArray(runtimeHealing?.components);
  const components = definition.healing.map((component, index) => healingComponentForResolver({
    component,
    index,
    runtimeComponents,
    evaluationContext
  }));
  return mergeResolverRequest({
    components,
    context: {healingDefinitions: definition.healing}
  }, runtimeHealing && !runtimeHealing.components ? runtimeHealing : {...(runtimeHealing ?? {}), components});
}

function resolverRequestFromEffectsDefinition(definition, runtimeEffects) {
  if ( !definition.effects.length ) return runtimeEffects ?? null;
  const conditions = definition.effects
    .filter(effect => effect.type === "condition")
    .map(effect => ({
      id: effect.id,
      conditionId: effect.conditionId ?? effect.ref,
      levels: effect.levels,
      saveOutcomePolicy: effect.application?.saveOutcomePolicy ?? effect.saveOutcomePolicy ?? null,
      duration: effect.duration ?? definition.duration,
      concentration: effect.concentration,
      source: effect.source ?? definition.source,
      origin: effect.origin ?? definition.source,
      metadata: {
        ...(effect.metadata ?? {}),
        actionDefinitionId: definition.id,
        effectDefinitionId: effect.id
      }
    }));
  return mergeResolverRequest({
    conditions,
    metadata: {actionDefinitionId: definition.id}
  }, runtimeEffects);
}

function damageComponentForResolver({component, index, runtimeComponents, evaluationContext}) {
  const overlay = componentRuntimeOverlay(component, index, runtimeComponents);
  const expression = overlay.expression ?? overlay.valueExpression ?? expressionFromAmountFields(overlay) ?? component.expression;
  const amount = finiteNumber(overlay.amount ?? overlay.total ?? overlay.value)
    ?? evaluateComponentExpression(expression, evaluationContext);
  return {
    id: component.id,
    amount,
    dice: overlay.dice ?? diceFromExpression(expression),
    damageType: component.damageType,
    provenance: component.provenance,
    scalingCategory: component.scalingCategory,
    weaponSizeScalable: component.weaponSizeScalable,
    source: component.source,
    tags: component.tags,
    metadata: {
      ...(component.metadata ?? {}),
      ...(overlay.metadata ?? {}),
      actionDefinitionComponent: {
        id: component.id,
        index
      }
    }
  };
}

function healingComponentForResolver({component, index, runtimeComponents, evaluationContext}) {
  const overlay = componentRuntimeOverlay(component, index, runtimeComponents);
  const expression = overlay.expression ?? overlay.valueExpression ?? expressionFromAmountFields(overlay) ?? component.expression;
  const amount = finiteNumber(overlay.amount ?? overlay.total ?? overlay.value)
    ?? evaluateComponentExpression(expression, evaluationContext);
  return {
    id: component.id,
    amount,
    dice: overlay.dice ?? diceFromExpression(expression),
    healingType: component.healingType,
    source: component.source,
    tags: component.tags,
    metadata: {
      ...(component.metadata ?? {}),
      ...(overlay.metadata ?? {}),
      actionDefinitionComponent: {
        id: component.id,
        index
      }
    }
  };
}

function componentRuntimeOverlay(component, index, runtimeComponents) {
  return runtimeComponents.find(candidate => candidate?.id && candidate.id === component.id)
    ?? runtimeComponents[index]
    ?? {};
}

function evaluateComponentExpression(expression, context) {
  if ( expression == null ) return null;
  const result = evaluateValueExpression(expression, context);
  return result.ok ? result.value : null;
}

function resolveSaveDCDefinition(dcDefinition, context) {
  if ( typeof dcDefinition === "number" ) return {value: dcDefinition};
  const valueExpression = dcDefinition.valueExpression ?? dcDefinition.expression ?? null;
  const value = finiteNumber(dcDefinition.value ?? dcDefinition.dc)
    ?? evaluateComponentExpression(valueExpression, context);
  return {
    ...clonePlain(dcDefinition),
    value
  };
}

function mergeResolverRequest(definitionRequest, runtimeRequest) {
  if ( !runtimeRequest ) return definitionRequest;
  return {
    ...definitionRequest,
    ...clonePlain(runtimeRequest),
    policy: {
      ...(definitionRequest.policy ?? {}),
      ...(runtimeRequest.policy ?? {})
    },
    eligibilityPolicy: {
      ...(definitionRequest.eligibilityPolicy ?? {}),
      ...(runtimeRequest.eligibilityPolicy ?? {})
    },
    refinementPolicy: {
      ...(definitionRequest.refinementPolicy ?? {}),
      ...(runtimeRequest.refinementPolicy ?? {})
    },
    metadata: {
      ...(definitionRequest.metadata ?? {}),
      ...(runtimeRequest.metadata ?? {})
    },
    context: {
      ...(definitionRequest.context ?? {}),
      ...(runtimeRequest.context ?? {})
    }
  };
}

function costRequirementForPayment(requirement) {
  return {
    capability: requirement.capability ?? requirement.type,
    amount: requirement.amount,
    unit: requirement.unit ?? null
  };
}

function validateCosts(costs, errors) {
  for ( const {requirement, path} of costRequirementEntries(costs) ) {
    if ( !requirement.capability ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_COST, `${path}.capability`, "Cost requirement needs a capability or resource id."));
    }
    if ( !Number.isFinite(requirement.amount) || requirement.amount < 0 ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_COST, `${path}.amount`, "Cost amount must be a non-negative finite number."));
    }
    validatePredicate(requirement.predicate, `${path}.predicate`, errors);
  }
}

function validatePredicateCandidates(definition, errors) {
  const candidates = [
    {value: definition.targeting?.predicate, path: "targeting.predicate"},
    {value: definition.targeting?.eligibilityPolicy?.predicate, path: "targeting.eligibilityPolicy.predicate"},
    {value: definition.targeting?.refinementPolicy?.predicate, path: "targeting.refinementPolicy.predicate"},
    {value: definition.targeting?.refinementPolicy?.selectionPredicate, path: "targeting.refinementPolicy.selectionPredicate"},
    {value: definition.targeting?.refinementPolicy?.defaultPredicate, path: "targeting.refinementPolicy.defaultPredicate"},
    ...definition.damage.map((component, index) => ({value: component.predicate, path: `damage.${index}.predicate`})),
    ...definition.healing.map((component, index) => ({value: component.predicate, path: `healing.${index}.predicate`})),
    ...definition.effects.map((effect, index) => ({value: effect.predicate, path: `effects.${index}.predicate`}))
  ];
  for ( const candidate of candidates ) validatePredicate(candidate.value, candidate.path, errors);
}

function validatePredicate(predicate, path, errors) {
  if ( predicate == null ) return;
  const result = evaluatePredicate(predicate, {});
  if ( result.code === PREDICATE_CODES.INVALID ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_PREDICATE, path, result.reason));
  }
}

function validateTargeting(definition, errors) {
  const targeting = definition.targeting;
  if ( !targeting ) return;
  if ( targeting.type === ACTION_TARGETING_TYPES.AREA && !definition.area ) {
    errors.push(error(ACTION_DEFINITION_CODES.MISSING_AREA_DEFINITION, "area", "Area targeting requires an AreaDefinition."));
  }
  validateValueExpressionShape(targeting.count, "targeting.count", errors);
  validateValueExpressionShape(targeting.refinementPolicy?.minSelections, "targeting.refinementPolicy.minSelections", errors);
  validateValueExpressionShape(targeting.refinementPolicy?.maxSelections, "targeting.refinementPolicy.maxSelections", errors);
  validateValueExpressionShape(targeting.refinementPolicy?.minChoices, "targeting.refinementPolicy.minChoices", errors);
  validateValueExpressionShape(targeting.refinementPolicy?.maxChoices, "targeting.refinementPolicy.maxChoices", errors);
}

function validateArea(area, errors) {
  if ( !area ) return;
  if ( !area.shape ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_AREA, "area.shape", "AreaDefinition requires a semantic shape."));
  }
  if ( area.size ) validateDistanceDefinition(area.size, "area.size", errors);
}

function validateAttack(attack, errors) {
  if ( !attack ) return;
  if ( !attack.type ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_ATTACK, "attack.type", "AttackDefinition requires an attack type."));
  }
  if ( !attack.statistic && !attack.ability && !attack.statisticSource ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_ATTACK, "attack.statistic", "AttackDefinition requires a statistic or ability source."));
  }
}

function validateSave(save, errors) {
  if ( !save ) return;
  if ( !save.ability && !save.saveKey ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_SAVE, "save.ability", "SaveDefinition requires a save ability/key."));
  }
  if ( !save.dc ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_SAVE, "save.dc", "SaveDefinition requires a DC source."));
  }
  validateValueExpressionShape(save.dc?.valueExpression ?? save.dc?.expression, "save.dc.valueExpression", errors);
}

function validateDamage(components, errors) {
  components.forEach((component, index) => {
    const path = `damage.${index}`;
    if ( !isValidDamageType(component.damageType) ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_DAMAGE_TYPE, `${path}.damageType`, "Damage type must be a stable slug."));
    }
    if ( component.expression == null ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_DAMAGE, `${path}.expression`, "Damage component requires a ValueExpression."));
    }
    validateValueExpressionShape(component.expression, `${path}.expression`, errors);
  });
}

function validateHealing(components, errors) {
  components.forEach((component, index) => {
    const path = `healing.${index}`;
    if ( !component.healingType ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_HEALING, `${path}.healingType`, "Healing component requires a healing type."));
    }
    if ( component.expression == null ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_HEALING, `${path}.expression`, "Healing component requires a ValueExpression."));
    }
    validateValueExpressionShape(component.expression, `${path}.expression`, errors);
  });
}

function validateEffects(effects, errors, {conditionDefinitions=null, effectDefinitions=null}={}) {
  effects.forEach((effect, index) => {
    const path = `effects.${index}`;
    if ( effect.type === "condition" ) {
      if ( !effect.conditionId ) {
        errors.push(error(ACTION_DEFINITION_CODES.MISSING_EFFECT_REFERENCE, `${path}.conditionId`, "Condition effect requires a condition id."));
      } else if ( conditionDefinitions && !hasDefinitionKey(conditionDefinitions, effect.conditionId) ) {
        errors.push(error(ACTION_DEFINITION_CODES.MISSING_EFFECT_REFERENCE, `${path}.conditionId`, `Unknown condition effect: ${effect.conditionId}`));
      }
      return;
    }
    const ref = effect.ref ?? effect.effectRef ?? effect.effectId;
    if ( !ref ) {
      errors.push(error(ACTION_DEFINITION_CODES.MISSING_EFFECT_REFERENCE, `${path}.ref`, "Effect application requires an EffectRef or typed effect payload."));
    } else if ( effectDefinitions && !hasDefinitionKey(effectDefinitions, ref) ) {
      errors.push(error(ACTION_DEFINITION_CODES.MISSING_EFFECT_REFERENCE, `${path}.ref`, `Unknown effect reference: ${ref}`));
    }
  });
}

function validateRuleElements(ruleElements, errors) {
  ruleElements.forEach((ruleElement, index) => {
    const validation = validateRuleElementDefinition(ruleElement, {
      source: null,
      index
    });
    if ( !validation.ok ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_RULE_ELEMENT, `ruleElements.${index}`, validation.reason ?? validation.code));
    } else if ( validation.code !== RULE_ELEMENT_CODES.OK ) {
      errors.push(error(ACTION_DEFINITION_CODES.INVALID_RULE_ELEMENT, `ruleElements.${index}`, validation.reason ?? validation.code));
    }
  });
}

function validateValueExpressionShape(expression, path, errors) {
  if ( expression == null ) return;
  const result = validateExpressionShape(expression);
  if ( !result.ok ) errors.push(error(ACTION_DEFINITION_CODES.INVALID_VALUE_EXPRESSION, path, result.reason));
}

function validateExpressionShape(expression) {
  if ( typeof expression === "number" ) {
    return Number.isFinite(expression)
      ? {ok: true}
      : {ok: false, reason: "ValueExpression number must be finite."};
  }
  if ( !isPlainObject(expression) ) return {ok: false, reason: "ValueExpression must be a number or structured object."};

  switch ( expression.type ) {
    case "constant":
      return Number.isFinite(Number(expression.value))
        ? {ok: true}
        : {ok: false, reason: "Constant ValueExpression must be numeric."};
    case "context":
      return stringOrNull(expression.path)
        ? {ok: true}
        : {ok: false, reason: "Context ValueExpression requires a path."};
    case "ability-score":
    case "abilityScore":
    case "ability-modifier":
    case "abilityModifier":
      return stringOrNull(expression.ability ?? expression.key ?? expression.slug)
        ? {ok: true}
        : {ok: false, reason: "Ability ValueExpression requires an ability key."};
    case "proficiency-bonus":
    case "proficiencyBonus":
    case "character-level":
    case "characterLevel":
    case "spellcasting-modifier":
    case "spellcastingModifier":
      return {ok: true};
    case "class-level":
    case "classLevel":
      return {ok: true};
    case "resource-current":
    case "resourceCurrent":
    case "resource-max":
    case "resourceMax":
      return stringOrNull(expression.resource ?? expression.resourceId ?? expression.id ?? expression.key)
        ? {ok: true}
        : {ok: false, reason: "Resource ValueExpression requires a resource id."};
    case "add":
    case "multiply":
    case "min":
    case "max":
      return validateExpressionTerms(expression.terms ?? []);
    case "subtract":
      return Array.isArray(expression.terms)
        ? validateExpressionTerms(expression.terms)
        : validateExpressionTerms([expression.left ?? expression.value ?? 0, expression.right ?? expression.minus ?? 0]);
    case "divide":
      return validateExpressionTerms([expression.numerator ?? expression.left, expression.denominator ?? expression.right]);
    case "floor":
    case "ceil":
      return validateExpressionShape(expression.value);
    case "dice":
      return validateDiceExpressionShape(expression);
    default:
      return {ok: false, reason: `Unknown ValueExpression type: ${expression.type}`};
  }
}

function validateExpressionTerms(terms) {
  if ( !Array.isArray(terms) ) return {ok: false, reason: "ValueExpression terms must be an array."};
  for ( const term of terms ) {
    const result = validateExpressionShape(term);
    if ( !result.ok ) return result;
  }
  return {ok: true};
}

function validateDiceExpressionShape(expression) {
  const number = finiteNumber(expression.number ?? expression.count ?? 1);
  const faces = finiteNumber(expression.faces ?? expression.sides);
  if ( number == null || faces == null || number < 0 || faces <= 0 ) {
    return {ok: false, reason: "Dice ValueExpression requires non-negative dice count and positive faces."};
  }
  return validateExpressionShape(expression.bonus ?? 0);
}

function normalizeOriginDefinition(origin) {
  if ( !origin ) return {type: ACTION_ORIGIN_TYPES.SELF};
  if ( typeof origin === "string" ) return {type: origin};
  return {
    type: stringOrDefault(origin.type ?? origin.policy, ACTION_ORIGIN_TYPES.SELF),
    ref: stringOrNull(origin.ref ?? origin.sourceRef),
    predicate: clonePlain(origin.predicate ?? null),
    metadata: clonePlain(origin.metadata ?? {}) ?? {}
  };
}

function normalizeActivationDefinition(activation) {
  if ( !activation ) return null;
  if ( typeof activation === "string" ) return {type: activation};
  return clonePlain({
    type: stringOrNull(activation.type ?? activation.capability),
    timing: stringOrNull(activation.timing),
    trigger: clonePlain(activation.trigger ?? null),
    metadata: clonePlain(activation.metadata ?? {}) ?? {}
  });
}

function normalizeCostDefinition(costs) {
  if ( Array.isArray(costs) ) return {allOf: costs.map(normalizeCostRequirement)};
  if ( !costs || !isPlainObject(costs) ) return {allOf: []};
  if ( Array.isArray(costs.anyOf) ) {
    return {
      anyOf: costs.anyOf.map(branch => normalizeCostBranch(branch))
    };
  }
  const requirements = costs.allOf ?? costs.requirements ?? (hasCostRequirementShape(costs) ? [costs] : []);
  return {
    allOf: normalizeArray(requirements).map(normalizeCostRequirement)
  };
}

function normalizeCostBranch(branch) {
  if ( Array.isArray(branch) ) return branch.map(normalizeCostRequirement);
  if ( isPlainObject(branch) && Array.isArray(branch.allOf) ) return branch.allOf.map(normalizeCostRequirement);
  return hasCostRequirementShape(branch) ? [normalizeCostRequirement(branch)] : [];
}

function normalizeCostRequirement(requirement={}) {
  const capability = requirement.capability
    ?? requirement.resourceId
    ?? requirement.resource
    ?? requirement.pool
    ?? requirement.type;
  return {
    type: stringOrDefault(requirement.kind ?? requirement.costType ?? (requirement.resourceId || requirement.resource ? "resource" : "actionEconomy"), "actionEconomy"),
    capability: stringOrNull(capability),
    amount: finiteNumber(requirement.amount ?? 1),
    unit: stringOrNull(requirement.unit),
    predicate: clonePlain(requirement.predicate ?? null),
    source: clonePlain(requirement.source ?? null),
    metadata: clonePlain(requirement.metadata ?? {}) ?? {}
  };
}

function normalizeRangeDefinition(range) {
  if ( !range ) return null;
  if ( typeof range === "string" ) return {type: range};
  return clonePlain({
    type: stringOrDefault(range.type ?? range.mode, ACTION_RANGE_TYPES.SPECIAL),
    distance: normalizeDistanceDefinition(range.distance ?? range.value),
    normal: normalizeDistanceDefinition(range.normal ?? range.normalRange),
    long: normalizeDistanceDefinition(range.long ?? range.longRange),
    unit: stringOrNull(range.unit),
    metadata: clonePlain(range.metadata ?? {}) ?? {}
  });
}

function normalizeTargetingDefinition(targeting) {
  if ( !targeting ) return null;
  if ( typeof targeting === "string" ) return {type: targeting, required: targeting !== ACTION_TARGETING_TYPES.NONE};
  const type = stringOrDefault(targeting.type ?? targeting.mode, ACTION_TARGETING_TYPES.SINGLE);
  return {
    type,
    required: targeting.required ?? type !== ACTION_TARGETING_TYPES.NONE,
    count: targeting.count ?? targeting.targetCount ?? targeting.maxTargets ?? null,
    targetPolicy: stringOrNull(targeting.targetPolicy ?? targeting.target),
    predicate: clonePlain(targeting.predicate ?? null),
    eligibilityPolicy: clonePlain(targeting.eligibilityPolicy ?? targeting.eligibility ?? {}) ?? {},
    refinementPolicy: clonePlain(targeting.refinementPolicy ?? targeting.refinement ?? {}) ?? {},
    metadata: clonePlain(targeting.metadata ?? {}) ?? {}
  };
}

function normalizeAreaDefinition(area) {
  if ( !area ) return null;
  if ( typeof area === "string" ) return {shape: area};
  return clonePlain({
    shape: stringOrNull(area.shape ?? area.type),
    size: normalizeDistanceDefinition(area.size ?? area.radius ?? area.length),
    width: normalizeDistanceDefinition(area.width),
    placement: clonePlain(area.placement ?? area.placementPolicy ?? null),
    persistence: clonePlain(area.persistence ?? null),
    targetPolicy: clonePlain(area.targetPolicy ?? null),
    metadata: clonePlain(area.metadata ?? {}) ?? {}
  });
}

function normalizeDamageDefinition(component={}, index=0) {
  const expression = component.expression
    ?? component.valueExpression
    ?? expressionFromAmountFields(component)
    ?? (component.dice ? {type: "dice", ...clonePlain(component.dice)} : null);
  return {
    id: stringOrDefault(component.id ?? component.slug, `damage:${index}`),
    expression: clonePlain(expression),
    damageType: stringOrDefault(component.damageType ?? component.type, "untyped"),
    provenance: stringOrDefault(component.provenance ?? component.category, "unknown"),
    scalingCategory: stringOrDefault(component.scalingCategory, component.weaponSizeScalable ? "weapon-size" : "none"),
    weaponSizeScalable: component.weaponSizeScalable ?? component.scalingCategory === "weapon-size",
    outcomePolicy: clonePlain(component.outcomePolicy ?? {}) ?? {},
    saveOutcomePolicy: clonePlain(component.saveOutcomePolicy ?? null),
    weaponSize: clonePlain(component.weaponSize ?? component.weaponSizeContext ?? null),
    predicate: clonePlain(component.predicate ?? null),
    targetPolicy: stringOrDefault(component.targetPolicy ?? component.target, "selected"),
    scaling: clonePlain(component.scaling ?? {}) ?? {},
    source: clonePlain(component.source ?? null),
    tags: normalizeStrings(component.tags),
    metadata: clonePlain(component.metadata ?? {}) ?? {}
  };
}

function normalizeHealingDefinition(component={}, index=0) {
  const expression = component.expression
    ?? component.valueExpression
    ?? expressionFromAmountFields(component)
    ?? (component.dice ? {type: "dice", ...clonePlain(component.dice)} : null);
  return {
    id: stringOrDefault(component.id ?? component.slug, `healing:${index}`),
    expression: clonePlain(expression),
    healingType: stringOrDefault(component.healingType ?? component.type, "healing"),
    targetPolicy: stringOrDefault(component.targetPolicy ?? component.target, "selected"),
    predicate: clonePlain(component.predicate ?? null),
    scaling: clonePlain(component.scaling ?? {}) ?? {},
    source: clonePlain(component.source ?? null),
    tags: normalizeStrings(component.tags),
    metadata: clonePlain(component.metadata ?? {}) ?? {}
  };
}

function normalizeEffectApplicationDefinition(effect={}, index=0) {
  const type = stringOrDefault(effect.type ?? effect.effectType, effect.conditionId ? "condition" : "ref");
  return {
    id: stringOrDefault(effect.id ?? effect.slug, `effect:${index}`),
    type,
    ref: stringOrNull(effect.ref ?? effect.effectRef ?? effect.effectId),
    conditionId: stringOrNull(effect.conditionId ?? (type === "condition" ? effect.ref : null)),
    levels: finiteNumber(effect.levels ?? effect.delta ?? effect.levelDelta ?? 1) ?? 1,
    application: clonePlain(effect.application ?? {}) ?? {},
    duration: normalizeDurationDefinition(effect.duration),
    concentration: clonePlain(effect.concentration ?? null),
    saveOutcomePolicy: clonePlain(effect.saveOutcomePolicy ?? effect.savePolicy ?? null),
    predicate: clonePlain(effect.predicate ?? null),
    source: clonePlain(effect.source ?? null),
    origin: clonePlain(effect.origin ?? null),
    metadata: clonePlain(effect.metadata ?? {}) ?? {}
  };
}

function normalizeDurationDefinition(duration) {
  if ( !duration ) return null;
  if ( typeof duration === "string" ) return {type: duration};
  if ( typeof duration === "number" ) return {type: "rounds", value: duration};
  return clonePlain(duration);
}

function normalizePlainComponent(value) {
  if ( !value ) return null;
  return clonePlain(value);
}

function normalizeDistanceDefinition(value) {
  if ( value == null ) return null;
  if ( typeof value === "number" ) return {value, unit: "ft"};
  if ( typeof value === "string" ) return {type: value};
  return clonePlain(value);
}

function validateDistanceDefinition(distance, path, errors) {
  if ( !distance ) return;
  const hasValue = distance.value != null;
  if ( hasValue && (!Number.isFinite(Number(distance.value)) || Number(distance.value) < 0) ) {
    errors.push(error(ACTION_DEFINITION_CODES.INVALID_AREA, `${path}.value`, "Distance values must be non-negative finite numbers."));
  }
}

function expressionFromAmountFields(component) {
  const amount = finiteNumber(component.amount ?? component.total ?? component.value);
  return amount == null ? null : {type: "constant", value: amount};
}

function diceFromExpression(expression) {
  if ( expression?.type !== "dice" ) return null;
  return {
    number: Math.max(Math.floor(finiteNumber(expression.number ?? expression.count) ?? 0), 0),
    faces: Math.max(Math.floor(finiteNumber(expression.faces ?? expression.sides) ?? 0), 0),
    formula: expression.formula ?? null,
    metadata: clonePlain(expression.metadata ?? {}) ?? {}
  };
}

function validateRuleElementSource(definition) {
  return {
    type: "actionDefinition",
    id: definition.id,
    name: definition.label ?? null
  };
}

function actionDefinitionRuleElementSource(definition) {
  return validateRuleElementSource(definition);
}

function validationFailure(code, reason, path, definition=null) {
  return {
    ok: false,
    code,
    definition,
    errors: [error(code, path, reason)]
  };
}

function error(code, path, reason) {
  return {code, path, reason};
}

function costRequirementEntries(costs) {
  if ( costs?.anyOf ) {
    return costs.anyOf.flatMap((branch, branchIndex) => {
      return branch.map((requirement, requirementIndex) => ({
        requirement,
        path: `costs.anyOf.${branchIndex}.${requirementIndex}`
      }));
    });
  }
  return (costs?.allOf ?? []).map((requirement, index) => ({
    requirement,
    path: `costs.allOf.${index}`
  }));
}

function isValidDamageType(value) {
  return typeof value === "string" && DAMAGE_TYPE_PATTERN.test(value);
}

function hasCostRequirementShape(value) {
  return isPlainObject(value) && (
    "capability" in value
    || "resourceId" in value
    || "resource" in value
    || "pool" in value
    || "amount" in value
  );
}

function hasDefinitionKey(definitions, key) {
  if ( !definitions || !key ) return false;
  if ( definitions instanceof Map ) return definitions.has(key);
  if ( Array.isArray(definitions) ) return definitions.some(definition => (definition.id ?? definition.ref) === key);
  return Object.hasOwn(definitions, key);
}

function hasAuthoredDefinition(value) {
  if ( !isPlainObject(value) ) return false;
  return Object.entries(value).some(([key, entry]) => {
    if ( ["schemaVersion", "metadata"].includes(key) ) return false;
    return hasMeaningfulValue(entry);
  });
}

function hasMeaningfulValue(value) {
  if ( value == null ) return false;
  if ( typeof value === "string" ) return value.trim() !== "";
  if ( typeof value === "number" || typeof value === "boolean" ) return true;
  if ( Array.isArray(value) ) return value.length > 0;
  if ( value instanceof Set ) return value.size > 0;
  if ( isPlainObject(value) ) return Object.values(value).some(hasMeaningfulValue);
  return false;
}

function sourceFromItem(item) {
  if ( !item ) return null;
  return {
    type: "item",
    ref: item.uuid ? `uuid:${item.uuid}` : (item.id ? `item:${item.id}` : null),
    uuid: item.uuid ?? null,
    id: item.id ?? null,
    itemType: item.type ?? null,
    name: item.name ?? null
  };
}

function safeLegacyActivationCost(system) {
  if ( typeof system?.getActivationCost !== "function" ) return null;
  if ( typeof system?.getActionDefinition === "function" ) return null;
  return system.getActivationCost();
}

function normalizeSchemaVersion(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeArray(value) {
  if ( value == null ) return [];
  if ( Array.isArray(value) ) return value;
  if ( value instanceof Set ) return [...value];
  if ( typeof value[Symbol.iterator] === "function" && typeof value !== "string" ) return [...value];
  return [value];
}

function normalizeStrings(value) {
  return [...new Set(normalizeArray(value).filter(entry => entry != null && entry !== "").map(String))];
}

function stringOrNull(value) {
  if ( value == null ) return null;
  const string = String(value).trim();
  return string ? string : null;
}

function stringOrDefault(value, fallback) {
  return stringOrNull(value) ?? fallback;
}

function finiteNumber(value) {
  if ( value == null || value === "" ) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstDefined(values) {
  return values.find(value => value != null);
}

function findNonSerializable(value, path="value", seen=new Set()) {
  const type = typeof value;
  if ( type === "function" || type === "symbol" || type === "bigint" ) {
    return {path, reason: `${path} contains non-serializable ${type}.`};
  }
  if ( type === "number" && !Number.isFinite(value) ) {
    return {path, reason: `${path} contains a non-finite number.`};
  }
  if ( value == null || type !== "object" ) return null;
  if ( seen.has(value) ) return {path, reason: `${path} contains a circular reference.`};
  seen.add(value);
  if ( Array.isArray(value) ) {
    for ( let index = 0; index < value.length; index++ ) {
      const issue = findNonSerializable(value[index], `${path}.${index}`, seen);
      if ( issue ) return issue;
    }
    seen.delete(value);
    return null;
  }
  if ( !isPlainObject(value) ) {
    return {path, reason: `${path} must contain plain JSON data.`};
  }
  for ( const [key, entry] of Object.entries(value) ) {
    const issue = findNonSerializable(entry, `${path}.${key}`, seen);
    if ( issue ) return issue;
  }
  seen.delete(value);
  return null;
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return (typeof value === "object") && value !== null && !Array.isArray(value);
}
