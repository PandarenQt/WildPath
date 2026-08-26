import {
  economyResourcesFromActorResources,
  normalizeActivationCost,
  resolvePaymentOptions,
  selectDefaultPaymentOption
} from "./action-economy.mjs";
import {
  actionDefinitionActivationCost,
  normalizeActionDefinition,
  validateActionDefinition
} from "./action-definitions.mjs";
import {evaluatePredicate} from "./predicates.mjs";
import {evaluateValueExpression} from "./value-expressions.mjs";

export const ACTION_CHOICE_TYPES = Object.freeze({
  SELECT_ONE: "select-one",
  SELECT_MANY: "select-many",
  BOOLEAN: "boolean",
  NUMBER: "number",
  RESOURCE: "resource",
  DAMAGE_TYPE: "damage-type",
  OPTION: "option"
});

export const ACTION_CONFIGURATION_CODES = Object.freeze({
  OK: "OK",
  ACTION_DEFINITION_INVALID: "ACTION_DEFINITION_INVALID",
  INVALID_CHOICE_REQUEST: "INVALID_CHOICE_REQUEST",
  INVALID_CHOICE: "INVALID_CHOICE",
  INVALID_DAMAGE_TYPE: "INVALID_DAMAGE_TYPE",
  MISSING_REQUIRED_CHOICE: "MISSING_REQUIRED_CHOICE",
  OPTION_NOT_AVAILABLE: "OPTION_NOT_AVAILABLE",
  RESOURCE_UNAVAILABLE: "RESOURCE_UNAVAILABLE",
  CONFLICTING_SELECTIONS: "CONFLICTING_SELECTIONS",
  EXCEEDED_CHOICE_LIMIT: "EXCEEDED_CHOICE_LIMIT",
  STALE_CONFIGURATION_STATE: "STALE_CONFIGURATION_STATE",
  INVALID_CONFIGURATION: "INVALID_CONFIGURATION"
});

const DAMAGE_TYPE_PATTERN = /^[a-z][a-z0-9-]*$/i;

/* -------------------------------------------- */

export function discoverActionConfigurationChoices({
  definition=null,
  actionDefinition=null,
  actorSystem=null,
  resources=null,
  choices={},
  responses=null,
  configurationContributions=[],
  context={},
  policies={}
}={}) {
  const validation = validateActionDefinition(definition ?? actionDefinition ?? {});
  if ( !validation.ok ) {
    return {
      ok: false,
      code: ACTION_CONFIGURATION_CODES.ACTION_DEFINITION_INVALID,
      requests: [],
      traces: [],
      errors: validation.errors ?? [],
      actionDefinition: validation.definition ?? null
    };
  }

  const normalizedDefinition = validation.definition ?? normalizeActionDefinition(definition ?? actionDefinition ?? {});
  const responseMap = normalizeChoiceResponses(responses ?? choices);
  const resourceState = normalizeResourceState({actorSystem, resources});
  const resourceById = new Map(resourceState.map(resource => [resource.id, resource]));
  const choiceDefinitions = collectChoiceDefinitions(normalizedDefinition, configurationContributions);
  const requests = [];
  const traces = [];

  for ( const choiceDefinition of choiceDefinitions ) {
    const active = evaluateChoiceActivation({
      choiceDefinition,
      actionDefinition: normalizedDefinition,
      actorSystem,
      resources: resourceState,
      responses: responseMap,
      context
    });
    if ( !active.active ) {
      traces.push({
        choiceId: choiceDefinition.id,
        status: active.status,
        code: active.code,
        reason: active.reason,
        source: clonePlain(choiceDefinition.source)
      });
      continue;
    }

    const request = createChoiceRequest({
      choiceDefinition,
      actionDefinition: normalizedDefinition,
      actorSystem,
      resources: resourceState,
      resourceById,
      responses: responseMap,
      context,
      policies
    });
    requests.push(request);
    traces.push({
      choiceId: choiceDefinition.id,
      status: "requested",
      code: ACTION_CONFIGURATION_CODES.OK,
      source: clonePlain(choiceDefinition.source),
      optionCount: request.options.length
    });
  }

  return {
    ok: true,
    code: ACTION_CONFIGURATION_CODES.OK,
    actionDefinition: normalizedDefinition,
    requests,
    traces,
    resources: resourceState,
    choices: Object.fromEntries(responseMap.entries())
  };
}

/* -------------------------------------------- */

export function resolveActionConfiguration({
  definition=null,
  actionDefinition=null,
  actorSystem=null,
  resources=null,
  choices={},
  responses=null,
  configurationContributions=[],
  context={},
  policies={}
}={}) {
  const discovery = discoverActionConfigurationChoices({
    definition,
    actionDefinition,
    actorSystem,
    resources,
    choices,
    responses,
    configurationContributions,
    context,
    policies
  });
  if ( !discovery.ok ) return {
    ok: false,
    code: discovery.code,
    requests: discovery.requests,
    configuration: null,
    preview: null,
    errors: discovery.errors ?? [],
    traces: discovery.traces ?? []
  };

  const responseMap = normalizeChoiceResponses(responses ?? choices);
  const activeRequestsById = new Map(discovery.requests.map(request => [request.id, request]));
  const selections = [];
  const errors = [];

  for ( const request of discovery.requests ) {
    if ( !responseMap.has(request.id) ) {
      if ( request.required ) {
        errors.push(choiceError(
          ACTION_CONFIGURATION_CODES.MISSING_REQUIRED_CHOICE,
          request.id,
          "Required action choice was not supplied."
        ));
      }
      continue;
    }

    const selection = resolveChoiceSelection(request, responseMap.get(request.id));
    if ( !selection.ok ) errors.push(...selection.errors);
    else selections.push(selection.selection);
  }

  for ( const choiceId of responseMap.keys() ) {
    if ( !activeRequestsById.has(choiceId) ) {
      errors.push(choiceError(
        ACTION_CONFIGURATION_CODES.OPTION_NOT_AVAILABLE,
        choiceId,
        "Choice response is not currently legal or its dependency is not active."
      ));
    }
  }

  errors.push(...validateChoiceConflicts(selections));
  if ( errors.length ) return configurationFailure({
    code: errors[0].code,
    discovery,
    errors
  });

  const applied = applySelectionsToDefinition({
    baseDefinition: discovery.actionDefinition,
    selections,
    context
  });
  if ( applied.errors.length ) return configurationFailure({
    code: applied.errors[0].code,
    discovery,
    errors: applied.errors
  });

  const effectiveValidation = validateActionDefinition(applied.definition);
  if ( !effectiveValidation.ok ) return configurationFailure({
    code: ACTION_CONFIGURATION_CODES.INVALID_CONFIGURATION,
    discovery,
    errors: effectiveValidation.errors
  });

  const payment = resolveConfiguredPayment({
    definition: effectiveValidation.definition,
    resources: discovery.resources,
    policies,
    selectedPlan: null
  });
  if ( !payment.ok ) return configurationFailure({
    code: payment.code,
    discovery,
    errors: [choiceError(payment.code, "payment", payment.reason ?? payment.code)]
  });

  const configuration = createResolvedConfiguration({
    baseDefinition: discovery.actionDefinition,
    effectiveDefinition: effectiveValidation.definition,
    discovery,
    selections,
    applied,
    payment
  });

  return {
    ok: true,
    code: ACTION_CONFIGURATION_CODES.OK,
    requests: discovery.requests,
    configuration,
    errors: [],
    traces: [...discovery.traces, ...applied.trace],
    resources: discovery.resources
  };
}

/* -------------------------------------------- */

export function validateResolvedActionConfiguration({
  configuration=null,
  actorSystem=null,
  resources=null,
  context={},
  policies={}
}={}) {
  if ( !configuration?.effectiveDefinition ) {
    return {
      ok: false,
      code: ACTION_CONFIGURATION_CODES.INVALID_CONFIGURATION,
      reason: "ResolvedActionConfiguration is required.",
      payment: null,
      errors: [choiceError(ACTION_CONFIGURATION_CODES.INVALID_CONFIGURATION, "configuration", "ResolvedActionConfiguration is required.")]
    };
  }

  const validation = validateActionDefinition(configuration.effectiveDefinition);
  if ( !validation.ok ) return {
    ok: false,
    code: ACTION_CONFIGURATION_CODES.ACTION_DEFINITION_INVALID,
    reason: validation.code,
    payment: null,
    errors: validation.errors ?? []
  };

  const resourceState = normalizeResourceState({actorSystem, resources});
  const selectedPlan = configuration.selectedPaymentPlan
    ?? configuration.payment?.selectedPaymentPlan
    ?? null;
  const payment = resolveConfiguredPayment({
    definition: validation.definition,
    resources: resourceState,
    policies,
    selectedPlan,
    context
  });
  if ( !payment.ok ) return {
    ok: false,
    code: payment.code,
    reason: payment.reason,
    payment,
    errors: [choiceError(payment.code, "payment", payment.reason ?? payment.code)]
  };

  return {
    ok: true,
    code: ACTION_CONFIGURATION_CODES.OK,
    payment,
    errors: []
  };
}

/* -------------------------------------------- */

export function createResolvedActionPreview({
  definition=null,
  actionDefinition=null,
  actorSystem=null,
  resources=null,
  choices={},
  responses=null,
  configurationContributions=[],
  context={},
  policies={}
}={}) {
  const resolved = resolveActionConfiguration({
    definition,
    actionDefinition,
    actorSystem,
    resources,
    choices,
    responses,
    configurationContributions,
    context,
    policies
  });
  if ( !resolved.ok ) return {
    ok: false,
    code: resolved.code,
    requests: resolved.requests ?? [],
    configuration: null,
    preview: null,
    errors: resolved.errors ?? [],
    traces: resolved.traces ?? []
  };

  return {
    ok: true,
    code: ACTION_CONFIGURATION_CODES.OK,
    requests: resolved.requests,
    configuration: resolved.configuration,
    preview: createPreviewFromConfiguration(resolved.configuration),
    errors: [],
    traces: resolved.traces
  };
}

/* -------------------------------------------- */

export function actionDefinitionFromResolvedConfiguration(configuration) {
  return clonePlain(configuration?.effectiveDefinition ?? null);
}

/* -------------------------------------------- */

function collectChoiceDefinitions(actionDefinition, configurationContributions) {
  return [
    ...(actionDefinition.configuration ?? []),
    ...normalizeArray(configurationContributions)
  ].map((choice, index) => normalizeChoiceDefinition(choice, index))
    .filter(choice => choice.id);
}

function normalizeChoiceDefinition(choice={}, index=0) {
  const type = normalizeChoiceType(choice.type ?? choice.kind ?? choice.control ?? ACTION_CHOICE_TYPES.OPTION);
  return {
    id: stringOrDefault(choice.id ?? choice.choiceId ?? choice.slug, `choice:${index}`),
    type,
    label: stringOrDefault(choice.label ?? choice.name, labelFromId(choice.id ?? choice.slug ?? `choice:${index}`)),
    description: stringOrNull(choice.description ?? choice.prompt),
    required: choice.required === true,
    options: normalizeChoiceOptions(choice.options ?? choice.choices),
    allowedDamageTypes: normalizeStrings(choice.allowedDamageTypes ?? choice.damageTypes),
    min: choice.min ?? choice.minimum ?? null,
    max: choice.max ?? choice.maximum ?? null,
    defaultValue: clonePlain(choice.defaultValue ?? choice.default ?? null),
    predicate: clonePlain(choice.predicate ?? null),
    dependsOn: normalizeDependencies(choice.dependsOn ?? choice.dependencies),
    conflictsWith: normalizeStrings(choice.conflictsWith ?? choice.incompatibleWith),
    effects: normalizeArray(choice.effects ?? choice.modifications ?? choice.apply).map(clonePlain),
    cost: clonePlain(choice.cost ?? choice.paymentCost ?? choice.activationCost ?? choice.payment?.cost ?? null),
    levelByResourceId: clonePlain(choice.levelByResourceId ?? choice.payment?.levelByResourceId ?? {}) ?? {},
    metadataByResourceId: clonePlain(choice.metadataByResourceId ?? choice.payment?.metadataByResourceId ?? {}) ?? {},
    source: clonePlain(choice.source ?? null),
    metadata: clonePlain(choice.metadata ?? {}) ?? {},
    raw: clonePlain(choice)
  };
}

function normalizeChoiceType(type) {
  const token = String(type ?? "").trim();
  switch ( token ) {
    case "SELECT_ONE":
    case "selectOne":
    case "select-one":
      return ACTION_CHOICE_TYPES.SELECT_ONE;
    case "SELECT_MANY":
    case "selectMany":
    case "select-many":
      return ACTION_CHOICE_TYPES.SELECT_MANY;
    case "BOOLEAN":
    case "bool":
    case "boolean":
      return ACTION_CHOICE_TYPES.BOOLEAN;
    case "NUMBER":
    case "number":
      return ACTION_CHOICE_TYPES.NUMBER;
    case "RESOURCE":
    case "resource":
    case "payment":
      return ACTION_CHOICE_TYPES.RESOURCE;
    case "DAMAGE_TYPE":
    case "damageType":
    case "damage-type":
      return ACTION_CHOICE_TYPES.DAMAGE_TYPE;
    case "OPTION":
    case "option":
    default:
      return ACTION_CHOICE_TYPES.OPTION;
  }
}

function normalizeChoiceOptions(options) {
  return normalizeArray(options).map((option, index) => {
    if ( typeof option === "string" || typeof option === "number" || typeof option === "boolean" ) {
      return {
        id: String(option),
        label: labelFromId(option),
        value: option,
        source: null,
        metadata: {}
      };
    }
    return {
      id: stringOrDefault(option.id ?? option.value ?? option.slug, `option:${index}`),
      label: stringOrDefault(option.label ?? option.name ?? option.value, labelFromId(option.id ?? option.slug ?? `option:${index}`)),
      value: clonePlain(option.value ?? option.id ?? option.slug),
      source: clonePlain(option.source ?? null),
      metadata: clonePlain(option.metadata ?? {}) ?? {}
    };
  });
}

function normalizeDependencies(dependencies) {
  return normalizeArray(dependencies).map(dependency => {
    if ( typeof dependency === "string" ) return {choiceId: dependency, equals: true};
    return {
      choiceId: stringOrNull(dependency.choiceId ?? dependency.id ?? dependency.choice),
      equals: clonePlain(dependency.equals ?? dependency.value ?? true),
      selected: dependency.selected ?? null
    };
  }).filter(dependency => dependency.choiceId);
}

function createChoiceRequest({
  choiceDefinition,
  actionDefinition,
  actorSystem,
  resources,
  resourceById,
  responses,
  context,
  policies
}) {
  const base = {
    id: choiceDefinition.id,
    type: choiceDefinition.type,
    label: choiceDefinition.label,
    description: choiceDefinition.description,
    required: choiceDefinition.required,
    source: clonePlain(choiceDefinition.source),
    predicate: clonePlain(choiceDefinition.predicate),
    dependsOn: clonePlain(choiceDefinition.dependsOn),
    conflictsWith: [...choiceDefinition.conflictsWith],
    min: clonePlain(choiceDefinition.min),
    max: clonePlain(choiceDefinition.max),
    options: [],
    defaultValue: clonePlain(choiceDefinition.defaultValue),
    metadata: clonePlain(choiceDefinition.metadata),
    choiceDefinition: clonePlain(choiceDefinition.raw)
  };

  if ( choiceDefinition.type === ACTION_CHOICE_TYPES.RESOURCE ) {
    const discovery = resolvePaymentOptions({
      cost: choiceDefinition.cost ?? actionDefinitionActivationCost(actionDefinition),
      resources,
      action: actionForPayment(actionDefinition),
      policies
    });
    const options = discovery.options.map(option => createPaymentChoiceOption(option, choiceDefinition, resourceById));
    return {
      ...base,
      options,
      payment: {
        status: discovery.status,
        code: discovery.code,
        defaultOptionId: options.find(option => option.paymentOptionId === selectDefaultPaymentOption(discovery.options)?.id)?.id ?? null,
        options: options.map(option => ({
          id: option.id,
          paymentOptionId: option.paymentOptionId,
          resourceIds: option.resources.map(resource => resource.resourceId),
          label: option.label,
          metadata: clonePlain(option.metadata)
        })),
        failures: clonePlain(discovery.failures ?? [])
      },
      stateFingerprint: fingerprint({
        type: choiceDefinition.type,
        options: options.map(option => ({
          id: option.id,
          resources: option.resources.map(resource => ({
            resourceId: resource.resourceId,
            amount: resource.amount,
            capability: resource.capability
          }))
        }))
      }),
      metadata: {
        ...base.metadata,
        paymentDiscovery: {
          status: discovery.status,
          code: discovery.code
        }
      }
    };
  }

  if ( choiceDefinition.type === ACTION_CHOICE_TYPES.BOOLEAN ) {
    return {
      ...base,
      options: [
        {id: "true", label: "Yes", value: true, source: null, metadata: {}},
        {id: "false", label: "No", value: false, source: null, metadata: {}}
      ],
      stateFingerprint: fingerprint({type: choiceDefinition.type, options: ["true", "false"]})
    };
  }

  if ( choiceDefinition.type === ACTION_CHOICE_TYPES.DAMAGE_TYPE ) {
    const options = choiceDefinition.allowedDamageTypes.map(damageType => ({
      id: damageType,
      label: labelFromId(damageType),
      value: damageType,
      source: clonePlain(choiceDefinition.source),
      metadata: {}
    }));
    return {
      ...base,
      options,
      stateFingerprint: fingerprint({type: choiceDefinition.type, options: options.map(option => option.id)})
    };
  }

  if ( choiceDefinition.type === ACTION_CHOICE_TYPES.NUMBER ) {
    return {
      ...base,
      stateFingerprint: fingerprint({
        type: choiceDefinition.type,
        min: choiceDefinition.min,
        max: choiceDefinition.max
      })
    };
  }

  return {
    ...base,
    options: choiceDefinition.options.map(clonePlain),
    stateFingerprint: fingerprint({
      type: choiceDefinition.type,
      options: choiceDefinition.options.map(option => option.id)
    })
  };
}

function createPaymentChoiceOption(option, choiceDefinition, resourceById) {
  const resources = (option.resources ?? []).map(payment => {
    const resource = resourceById.get(payment.resourceId);
    return {
      ...clonePlain(payment),
      label: resource?.metadata?.label ?? labelFromId(payment.resourceId),
      resourceMetadata: clonePlain(resource?.metadata ?? {})
    };
  });
  const firstResource = resources[0] ?? null;
  const selectedResourceId = firstResource?.resourceId ?? option.id;
  const inferred = inferResourceOptionMetadata({
    option,
    resources,
    choiceDefinition,
    selectedResourceId,
    resourceById
  });

  return {
    id: option.id,
    label: resources.length
      ? resources.map(resource => resource.label).join(" + ")
      : "No Resource",
    value: option.id,
    paymentOptionId: option.id,
    paymentPlan: clonePlain(option),
    resources,
    source: clonePlain(choiceDefinition.source),
    metadata: inferred
  };
}

function inferResourceOptionMetadata({resources, choiceDefinition, selectedResourceId, resourceById}) {
  const metadata = {
    ...(choiceDefinition.metadataByResourceId?.[selectedResourceId] ?? {})
  };
  for ( const resource of resources ) {
    const level = finiteNumber(choiceDefinition.levelByResourceId?.[resource.resourceId])
      ?? finiteNumber(resource.resourceMetadata?.level)
      ?? finiteNumber(resource.resourceMetadata?.castingLevel)
      ?? finiteNumber(resourceById.get(resource.resourceId)?.metadata?.level)
      ?? finiteNumber(resourceById.get(resource.resourceId)?.metadata?.castingLevel);
    if ( level != null && metadata.castingLevel == null ) metadata.castingLevel = level;
    if ( resource.resourceMetadata?.slotType && metadata.slotType == null ) metadata.slotType = resource.resourceMetadata.slotType;
  }
  return metadata;
}

function evaluateChoiceActivation({
  choiceDefinition,
  actionDefinition,
  actorSystem,
  resources,
  responses,
  context
}) {
  for ( const dependency of choiceDefinition.dependsOn ) {
    const response = responses.get(dependency.choiceId);
    if ( dependency.selected != null ) {
      const selected = responseSelectionIsActive(response);
      if ( selected !== Boolean(dependency.selected) ) {
        return {
          active: false,
          status: "dependency-failed",
          code: ACTION_CONFIGURATION_CODES.OPTION_NOT_AVAILABLE,
          reason: `Dependency ${dependency.choiceId} was not satisfied.`
        };
      }
      continue;
    }

    if ( !valuesEqual(responseValueForDependency(response), dependency.equals) ) {
      return {
        active: false,
        status: "dependency-failed",
        code: ACTION_CONFIGURATION_CODES.OPTION_NOT_AVAILABLE,
        reason: `Dependency ${dependency.choiceId} was not satisfied.`
      };
    }
  }

  const predicate = choiceDefinition.predicate;
  if ( predicate ) {
    const result = evaluatePredicate(predicate, {
      ...context,
      action: actionDefinition,
      actionDefinition,
      actorSystem,
      resources,
      choices: Object.fromEntries(responses.entries()),
      choice: choiceDefinition
    });
    if ( !result.ok ) return {
      active: false,
      status: "predicate-failed",
      code: result.code,
      reason: result.reason
    };
  }

  return {active: true, status: "active", code: ACTION_CONFIGURATION_CODES.OK, reason: null};
}

function resolveChoiceSelection(request, rawResponse) {
  switch ( request.type ) {
    case ACTION_CHOICE_TYPES.BOOLEAN:
      return resolveBooleanSelection(request, rawResponse);
    case ACTION_CHOICE_TYPES.NUMBER:
      return resolveNumberSelection(request, rawResponse);
    case ACTION_CHOICE_TYPES.SELECT_MANY:
      return resolveManySelection(request, rawResponse);
    case ACTION_CHOICE_TYPES.RESOURCE:
      return resolveResourceSelection(request, rawResponse);
    case ACTION_CHOICE_TYPES.DAMAGE_TYPE:
      return resolveDamageTypeSelection(request, rawResponse);
    case ACTION_CHOICE_TYPES.SELECT_ONE:
    case ACTION_CHOICE_TYPES.OPTION:
    default:
      return resolveOneSelection(request, rawResponse);
  }
}

function resolveBooleanSelection(request, rawResponse) {
  const value = rawResponse?.value ?? rawResponse?.selected ?? rawResponse;
  if ( typeof value !== "boolean" ) {
    return invalidSelection(request.id, "Boolean choices require true or false.");
  }
  return okSelection(request, {
    value,
    label: value ? "Yes" : "No",
    active: value
  });
}

function resolveNumberSelection(request, rawResponse) {
  const value = finiteNumber(rawResponse?.value ?? rawResponse);
  if ( value == null ) return invalidSelection(request.id, "Number choices require a finite number.");

  const min = evaluateMaybeExpression(request.min, {choice: request});
  const max = evaluateMaybeExpression(request.max, {choice: request});
  if ( min != null && value < min ) return invalidSelection(request.id, `Choice value is below minimum ${min}.`);
  if ( max != null && value > max ) return invalidSelection(request.id, `Choice value is above maximum ${max}.`);

  return okSelection(request, {
    value,
    label: String(value),
    active: true
  });
}

function resolveOneSelection(request, rawResponse) {
  const optionId = String(rawResponse?.optionId ?? rawResponse?.id ?? rawResponse?.value ?? rawResponse);
  const option = request.options.find(candidate => candidate.id === optionId || String(candidate.value) === optionId);
  if ( !option ) return invalidSelection(request.id, `Option is not available: ${optionId}`);
  return okSelection(request, {
    value: clonePlain(option.value),
    optionId: option.id,
    label: option.label,
    option,
    active: true
  });
}

function resolveManySelection(request, rawResponse) {
  const rawValues = normalizeArray(rawResponse?.values ?? rawResponse?.value ?? rawResponse);
  const selectedOptions = [];
  for ( const rawValue of rawValues ) {
    const optionId = String(rawValue?.optionId ?? rawValue?.id ?? rawValue?.value ?? rawValue);
    const option = request.options.find(candidate => candidate.id === optionId || String(candidate.value) === optionId);
    if ( !option ) return invalidSelection(request.id, `Option is not available: ${optionId}`);
    selectedOptions.push(option);
  }

  const min = evaluateMaybeExpression(request.min, {choice: request}) ?? 0;
  const max = evaluateMaybeExpression(request.max, {choice: request}) ?? Infinity;
  if ( selectedOptions.length < min ) return invalidSelection(request.id, `Choice requires at least ${min} selections.`);
  if ( selectedOptions.length > max ) {
    return {
      ok: false,
      errors: [choiceError(
        ACTION_CONFIGURATION_CODES.EXCEEDED_CHOICE_LIMIT,
        request.id,
        `Choice allows at most ${max} selections.`
      )]
    };
  }

  return okSelection(request, {
    value: selectedOptions.map(option => clonePlain(option.value)),
    values: selectedOptions.map(option => clonePlain(option.value)),
    optionIds: selectedOptions.map(option => option.id),
    label: selectedOptions.map(option => option.label).join(", "),
    options: selectedOptions.map(clonePlain),
    active: selectedOptions.length > 0
  });
}

function resolveResourceSelection(request, rawResponse) {
  const requested = String(rawResponse?.paymentOptionId
    ?? rawResponse?.optionId
    ?? rawResponse?.id
    ?? rawResponse?.value
    ?? rawResponse?.resourceId
    ?? rawResponse);
  const option = request.options.find(candidate => {
    if ( candidate.id === requested || candidate.paymentOptionId === requested ) return true;
    return candidate.resources.some(resource => resource.resourceId === requested);
  });
  if ( !option ) return {
    ok: false,
    errors: [choiceError(
      ACTION_CONFIGURATION_CODES.RESOURCE_UNAVAILABLE,
      request.id,
      `Resource payment option is not available: ${requested}`
    )]
  };

  return okSelection(request, {
    value: option.id,
    optionId: option.id,
    paymentOptionId: option.paymentOptionId,
    paymentPlan: clonePlain(option.paymentPlan),
    resources: option.resources.map(clonePlain),
    label: option.label,
    option: clonePlain(option),
    metadata: clonePlain(option.metadata ?? {}),
    active: true
  });
}

function resolveDamageTypeSelection(request, rawResponse) {
  const damageType = String(rawResponse?.damageType ?? rawResponse?.value ?? rawResponse).trim();
  if ( !isValidDamageType(damageType) ) {
    return {
      ok: false,
      errors: [choiceError(
        ACTION_CONFIGURATION_CODES.INVALID_DAMAGE_TYPE,
        request.id,
        `Invalid damage type: ${damageType}`
      )]
    };
  }
  const option = request.options.find(candidate => candidate.id === damageType || candidate.value === damageType);
  if ( !option ) return invalidSelection(request.id, `Damage type is not available: ${damageType}`);
  return okSelection(request, {
    value: damageType,
    damageType,
    optionId: option.id,
    label: option.label,
    option,
    active: true
  });
}

function okSelection(request, data) {
  return {
    ok: true,
    selection: {
      id: request.id,
      type: request.type,
      source: clonePlain(request.source),
      requestFingerprint: request.stateFingerprint ?? null,
      conflictsWith: [...(request.conflictsWith ?? [])],
      choiceDefinition: clonePlain(request.choiceDefinition),
      metadata: {
        ...(request.metadata ?? {}),
        ...(data.metadata ?? {})
      },
      ...data
    }
  };
}

function invalidSelection(choiceId, reason) {
  return {
    ok: false,
    errors: [choiceError(ACTION_CONFIGURATION_CODES.INVALID_CHOICE, choiceId, reason)]
  };
}

function validateChoiceConflicts(selections) {
  const activeIds = new Set(selections.filter(selection => selection.active).map(selection => selection.id));
  const errors = [];
  for ( const selection of selections.filter(selection => selection.active) ) {
    const conflict = (selection.conflictsWith ?? []).find(choiceId => activeIds.has(choiceId));
    if ( conflict ) {
      errors.push(choiceError(
        ACTION_CONFIGURATION_CODES.CONFLICTING_SELECTIONS,
        selection.id,
        `Choice conflicts with ${conflict}.`
      ));
    }
  }
  return errors;
}

function applySelectionsToDefinition({baseDefinition, selections, context}) {
  const definition = clonePlain(baseDefinition);
  const selectionsById = new Map(selections.map(selection => [selection.id, selection]));
  const trace = [];
  const errors = [];

  for ( const selection of selections ) {
    if ( !selection.active ) continue;
    if ( selection.type === ACTION_CHOICE_TYPES.RESOURCE ) {
      appendCostRequirements(definition, requirementsFromPaymentPlan(selection.paymentPlan), {
        source: selection.source,
        choiceId: selection.id
      });
      trace.push(appliedTrace(selection, "selected-resource-payment", {
        resources: selection.paymentPlan?.resources ?? []
      }));
    }

    for ( const effect of normalizeArray(selection.choiceDefinition?.effects) ) {
      const result = applyConfigurationEffect({
        definition,
        effect,
        selection,
        selectionsById,
        context
      });
      if ( result.ok ) trace.push(...result.trace);
      else errors.push(...result.errors);
    }
  }

  return {definition, trace, errors};
}

function applyConfigurationEffect({definition, effect, selection, selectionsById, context}) {
  switch ( normalizeEffectType(effect.type ?? effect.kind) ) {
    case "add-cost":
      return applyAddCostEffect({definition, effect, selection});
    case "scale-damage":
      return applyScaleDamageEffect({definition, effect, selection, selectionsById, context});
    case "replace-damage-type":
      return applyReplaceDamageTypeEffect({definition, effect, selection, selectionsById});
    default:
      return {ok: true, trace: [appliedTrace(selection, "ignored-unknown-effect", {effectType: effect.type ?? effect.kind ?? null})], errors: []};
  }
}

function normalizeEffectType(type) {
  switch ( String(type ?? "").trim() ) {
    case "addCost":
    case "add-cost":
    case "cost":
      return "add-cost";
    case "scaleDamage":
    case "scale-damage":
      return "scale-damage";
    case "replaceDamageType":
    case "setDamageType":
    case "replace-damage-type":
    case "set-damage-type":
      return "replace-damage-type";
    default:
      return String(type ?? "");
  }
}

function applyAddCostEffect({definition, effect, selection}) {
  const requirements = activationCostRequirements(effect.cost ?? effect.paymentCost ?? effect.activationCost);
  appendCostRequirements(definition, requirements, {
    source: selection.source,
    choiceId: selection.id
  });
  return {
    ok: true,
    trace: [appliedTrace(selection, "added-cost", {requirements})],
    errors: []
  };
}

function applyScaleDamageEffect({definition, effect, selection, selectionsById}) {
  const levelChoiceId = effect.levelChoiceId ?? effect.choiceId ?? effect.fromChoice ?? selection.id;
  const selectedLevel = finiteNumber(effect.selectedLevel ?? effect.level)
    ?? finiteNumber(selectionsById.get(levelChoiceId)?.metadata?.castingLevel)
    ?? finiteNumber(selectionsById.get(levelChoiceId)?.value);
  if ( selectedLevel == null ) return {
    ok: false,
    trace: [],
    errors: [choiceError(
      ACTION_CONFIGURATION_CODES.INVALID_CONFIGURATION,
      selection.id,
      "Damage scaling requires a selected numeric level."
    )]
  };

  const baseLevel = finiteNumber(effect.baseLevel ?? effect.minimumLevel ?? effect.fromLevel) ?? 0;
  const levels = Math.max(selectedLevel - baseLevel, 0);
  const dice = effect.dice ?? effect.perLevel?.dice ?? effect.increment?.dice ?? {};
  const diceNumber = finiteNumber(dice.number ?? dice.count ?? effect.number ?? effect.count) ?? 0;
  const diceFaces = finiteNumber(dice.faces ?? dice.sides ?? effect.faces ?? effect.sides);
  const addedDice = {
    type: "dice",
    number: Math.max(levels * diceNumber, 0),
    faces: diceFaces
  };
  if ( levels <= 0 || addedDice.number <= 0 || !addedDice.faces ) {
    return {
      ok: true,
      trace: [appliedTrace(selection, "damage-scaling-noop", {selectedLevel, baseLevel})],
      errors: []
    };
  }

  const matches = matchingDamageComponents(definition.damage, effect);
  const trace = [];
  for ( const component of matches ) {
    const before = clonePlain(component.expression);
    component.expression = addDiceToExpression(component.expression, addedDice);
    component.metadata = {
      ...(component.metadata ?? {}),
      configurationChanges: [
        ...normalizeArray(component.metadata?.configurationChanges),
        {
          type: "scale-damage",
          choiceId: selection.id,
          source: clonePlain(selection.source),
          before,
          after: clonePlain(component.expression),
          selectedLevel,
          baseLevel,
          addedDice
        }
      ]
    };
    trace.push(appliedTrace(selection, "scaled-damage", {
      componentId: component.id,
      before,
      after: component.expression,
      selectedLevel,
      baseLevel
    }));
  }

  return {ok: true, trace, errors: []};
}

function applyReplaceDamageTypeEffect({definition, effect, selection, selectionsById}) {
  const choiceId = effect.damageTypeChoiceId ?? effect.choiceId ?? effect.fromChoice ?? selection.id;
  const damageType = selectionsById.get(choiceId)?.damageType
    ?? selectionsById.get(choiceId)?.value;
  if ( !isValidDamageType(damageType) ) return {
    ok: false,
    trace: [],
    errors: [choiceError(
      ACTION_CONFIGURATION_CODES.INVALID_DAMAGE_TYPE,
      selection.id,
      `Invalid damage type: ${damageType}`
    )]
  };

  const matches = matchingDamageComponents(definition.damage, effect);
  const trace = [];
  for ( const component of matches ) {
    const before = component.damageType;
    component.damageType = damageType;
    component.metadata = {
      ...(component.metadata ?? {}),
      configurationChanges: [
        ...normalizeArray(component.metadata?.configurationChanges),
        {
          type: "replace-damage-type",
          choiceId: selection.id,
          source: clonePlain(selection.source),
          before,
          after: damageType
        }
      ]
    };
    trace.push(appliedTrace(selection, "replaced-damage-type", {
      componentId: component.id,
      before,
      after: damageType
    }));
  }

  return {ok: true, trace, errors: []};
}

function matchingDamageComponents(components, effect) {
  const ids = normalizeStrings(effect.componentIds ?? effect.components ?? effect.componentId ?? effect.selector?.componentIds);
  const tags = normalizeStrings(effect.tags ?? effect.selector?.tags);
  if ( !ids.length && !tags.length ) return components;
  return components.filter(component => {
    if ( ids.length && ids.includes(component.id) ) return true;
    return tags.length && tags.some(tag => (component.tags ?? []).includes(tag));
  });
}

function addDiceToExpression(expression, addedDice) {
  const addition = {
    type: "dice",
    number: addedDice.number,
    faces: addedDice.faces
  };
  if ( !expression ) return addition;
  if ( expression.type === "dice" ) {
    const faces = finiteNumber(expression.faces ?? expression.sides);
    if ( faces === addedDice.faces ) {
      return {
        ...clonePlain(expression),
        number: (finiteNumber(expression.number ?? expression.count) ?? 1) + addedDice.number,
        faces
      };
    }
  }
  return {
    type: "add",
    terms: [clonePlain(expression), addition]
  };
}

function requirementsFromPaymentPlan(paymentPlan) {
  return (paymentPlan?.resources ?? []).map(payment => ({
    type: "resource",
    capability: payment.capability ?? payment.resourceId,
    amount: payment.amount,
    unit: payment.unit ?? null,
    source: clonePlain(payment.source ?? null),
    metadata: {
      resourceId: payment.resourceId,
      mode: payment.mode,
      alternativeFor: payment.alternativeFor ?? null,
      policy: payment.policy ?? null
    }
  }));
}

function appendCostRequirements(definition, requirements, metadata={}) {
  const prepared = requirements.map(requirement => ({
    ...clonePlain(requirement),
    metadata: {
      ...(requirement.metadata ?? {}),
      ...(metadata.choiceId ? {configurationChoiceId: metadata.choiceId} : {}),
      ...(metadata.source ? {configurationSource: clonePlain(metadata.source)} : {})
    }
  })).filter(requirement => requirement.capability && requirement.amount > 0);
  if ( !prepared.length ) return;

  if ( definition.costs?.anyOf ) {
    definition.costs = {
      anyOf: definition.costs.anyOf.map(branch => [...branch.map(clonePlain), ...prepared.map(clonePlain)])
    };
    return;
  }

  definition.costs = {
    allOf: [
      ...(definition.costs?.allOf ?? []).map(clonePlain),
      ...prepared.map(clonePlain)
    ]
  };
}

function activationCostRequirements(cost) {
  const normalized = normalizeActivationCost(cost ?? {allOf: []});
  if ( normalized.anyOf ) return normalized.anyOf[0] ?? [];
  return normalized.allOf ?? [];
}

function resolveConfiguredPayment({definition, resources, policies, selectedPlan=null}) {
  const discovery = resolvePaymentOptions({
    cost: actionDefinitionActivationCost(definition),
    resources,
    action: actionForPayment(definition),
    policies
  });
  if ( discovery.status !== "available" ) return {
    ok: false,
    code: ACTION_CONFIGURATION_CODES.RESOURCE_UNAVAILABLE,
    reason: discovery.code,
    discovery,
    selectedPaymentPlan: null
  };

  const selectedPaymentPlan = selectedPlan
    ? findMatchingPaymentOption(discovery.options, selectedPlan)
    : selectDefaultPaymentOption(discovery.options);
  if ( !selectedPaymentPlan ) return {
    ok: false,
    code: ACTION_CONFIGURATION_CODES.STALE_CONFIGURATION_STATE,
    reason: "Previously selected payment option is no longer available.",
    discovery,
    selectedPaymentPlan: null
  };

  return {
    ok: true,
    code: ACTION_CONFIGURATION_CODES.OK,
    discovery,
    selectedPaymentOptionId: selectedPaymentPlan.id,
    selectedPaymentPlan
  };
}

function createResolvedConfiguration({baseDefinition, effectiveDefinition, discovery, selections, applied, payment}) {
  const selectedPayments = selections
    .filter(selection => selection.type === ACTION_CHOICE_TYPES.RESOURCE)
    .map(selection => clonePlain(selection.paymentPlan));
  const castingLevel = firstDefined(selections.map(selection => finiteNumber(selection.metadata?.castingLevel)));
  const selectedDamageTypes = Object.fromEntries(selections
    .filter(selection => selection.type === ACTION_CHOICE_TYPES.DAMAGE_TYPE)
    .map(selection => [selection.id, selection.damageType]));

  return {
    id: `configuration:${effectiveDefinition.id}`,
    actionDefinitionId: effectiveDefinition.id,
    schemaVersion: 1,
    baseDefinition: clonePlain(baseDefinition),
    effectiveDefinition: clonePlain(effectiveDefinition),
    choices: selections.map(summarizeSelection),
    selectedPayments,
    selectedPaymentPlan: clonePlain(payment.selectedPaymentPlan),
    selectedPaymentOptionId: payment.selectedPaymentOptionId ?? null,
    castingLevel: castingLevel ?? null,
    optionSelections: selections
      .filter(selection => ![ACTION_CHOICE_TYPES.RESOURCE, ACTION_CHOICE_TYPES.DAMAGE_TYPE].includes(selection.type))
      .map(summarizeSelection),
    selectedDamageTypes,
    effectiveActionModes: selections
      .filter(selection => selection.metadata?.actionMode)
      .map(selection => selection.metadata.actionMode),
    appliedConfigurationSources: selections
      .filter(selection => selection.active)
      .map(selection => ({
        choiceId: selection.id,
        source: clonePlain(selection.source),
        label: selection.label ?? null
      })),
    payment: {
      discovery: clonePlain(payment.discovery),
      selectedPaymentOptionId: payment.selectedPaymentOptionId ?? null,
      selectedPaymentPlan: clonePlain(payment.selectedPaymentPlan)
    },
    trace: [...discovery.traces, ...applied.trace],
    metadata: {}
  };
}

function summarizeSelection(selection) {
  return {
    id: selection.id,
    type: selection.type,
    value: clonePlain(selection.value),
    values: clonePlain(selection.values ?? null),
    optionId: selection.optionId ?? null,
    label: selection.label ?? null,
    source: clonePlain(selection.source),
    metadata: clonePlain(selection.metadata ?? {})
  };
}

function createPreviewFromConfiguration(configuration) {
  const base = configuration.baseDefinition;
  const effective = configuration.effectiveDefinition;
  const deltas = createConfigurationDeltas(base, effective);

  return {
    actionDefinitionId: effective.id,
    configurationId: configuration.id,
    selectedOptions: configuration.choices,
    costs: {
      base: summarizeCost(base.costs),
      effective: summarizeCost(effective.costs),
      payment: summarizePayment(configuration.payment)
    },
    actionEconomyPayments: configuration.selectedPaymentPlan?.resources?.map(clonePlain) ?? [],
    damage: {
      components: effective.damage.map(component => previewDamageComponent(component, findById(base.damage, component.id))),
      changed: deltas.some(delta => delta.type.startsWith("damage-"))
    },
    damageExpressions: effective.damage.map(component => ({
      componentId: component.id,
      expression: clonePlain(component.expression),
      formula: formatValueExpression(component.expression),
      before: formatValueExpression(findById(base.damage, component.id)?.expression)
    })),
    damageTypes: effective.damage.map(component => ({
      componentId: component.id,
      damageType: component.damageType,
      before: findById(base.damage, component.id)?.damageType ?? null
    })),
    healing: {
      components: effective.healing.map(component => ({
        id: component.id,
        healingType: component.healingType,
        expression: clonePlain(component.expression),
        formula: formatValueExpression(component.expression)
      }))
    },
    range: clonePlain(effective.range),
    reach: effective.range?.type === "reach" ? clonePlain(effective.range.distance ?? effective.range) : null,
    area: clonePlain(effective.area),
    targetCount: clonePlain(effective.targeting?.count ?? null),
    save: clonePlain(effective.save),
    check: clonePlain(effective.check),
    duration: clonePlain(effective.duration),
    effects: clonePlain(effective.effects),
    conditions: effective.effects.filter(effect => effect.type === "condition").map(clonePlain),
    resourceConsequences: configuration.selectedPaymentPlan?.resources?.map(payment => ({
      type: "resource-spend",
      resourceId: payment.resourceId,
      capability: payment.capability,
      amount: payment.amount,
      mode: payment.mode,
      policy: payment.policy ?? null
    })) ?? [],
    deltas,
    trace: clonePlain(configuration.trace),
    metadata: clonePlain(configuration.metadata ?? {})
  };
}

function previewDamageComponent(component, before=null) {
  return {
    id: component.id,
    damageType: component.damageType,
    expression: clonePlain(component.expression),
    formula: formatValueExpression(component.expression),
    provenance: component.provenance,
    before: before ? {
      damageType: before.damageType,
      expression: clonePlain(before.expression),
      formula: formatValueExpression(before.expression)
    } : null,
    source: clonePlain(component.source),
    metadata: clonePlain(component.metadata ?? {})
  };
}

function createConfigurationDeltas(base, effective) {
  const deltas = [];
  for ( const component of effective.damage ) {
    const before = findById(base.damage, component.id);
    if ( !before ) continue;
    if ( !valuesEqual(before.expression, component.expression) ) {
      deltas.push({
        type: "damage-expression",
        componentId: component.id,
        before: {
          expression: clonePlain(before.expression),
          formula: formatValueExpression(before.expression)
        },
        after: {
          expression: clonePlain(component.expression),
          formula: formatValueExpression(component.expression)
        },
        source: lastConfigurationChangeSource(component, "scale-damage")
      });
    }
    if ( before.damageType !== component.damageType ) {
      deltas.push({
        type: "damage-type",
        componentId: component.id,
        before: before.damageType,
        after: component.damageType,
        source: lastConfigurationChangeSource(component, "replace-damage-type")
      });
    }
  }

  const baseCosts = costRequirementSummaries(base.costs);
  const effectiveCosts = costRequirementSummaries(effective.costs);
  for ( const cost of effectiveCosts ) {
    if ( !baseCosts.some(baseCost => valuesEqual(baseCost, cost)) ) {
      deltas.push({
        type: "cost-added",
        before: null,
        after: clonePlain(cost),
        source: cost.metadata?.configurationSource ?? null
      });
    }
  }

  return deltas;
}

function lastConfigurationChangeSource(component, type) {
  const changes = normalizeArray(component.metadata?.configurationChanges)
    .filter(change => change.type === type);
  return clonePlain(changes.at(-1)?.source ?? null);
}

function summarizeCost(cost) {
  const normalized = normalizeActivationCost(cost ?? {allOf: []});
  const branches = normalized.anyOf ?? [normalized.allOf ?? []];
  return {
    branches: branches.map(branch => branch.map(requirement => ({
      capability: requirement.capability,
      amount: requirement.amount,
      unit: requirement.unit ?? null
    }))),
    isFree: branches.every(branch => branch.length === 0)
  };
}

function summarizePayment(payment) {
  return {
    status: payment.discovery.status,
    code: payment.discovery.code,
    selectedPaymentOptionId: payment.selectedPaymentOptionId,
    selectedPaymentPlan: clonePlain(payment.selectedPaymentPlan),
    options: payment.discovery.options.map(option => ({
      id: option.id,
      resources: option.resources.map(resource => ({
        resourceId: resource.resourceId,
        capability: resource.capability,
        amount: resource.amount,
        mode: resource.mode,
        policy: resource.policy ?? null
      }))
    })),
    failures: clonePlain(payment.discovery.failures ?? [])
  };
}

function costRequirementSummaries(cost) {
  const normalized = normalizeActivationCost(cost ?? {allOf: []});
  const branches = normalized.anyOf ?? [normalized.allOf ?? []];
  return branches.flatMap(branch => branch.map(requirement => clonePlain(requirement)));
}

function findMatchingPaymentOption(options, selectedPlan) {
  return options.find(option => paymentPlansMatch(option, selectedPlan)) ?? null;
}

function paymentPlansMatch(left, right) {
  return valuesEqual(
    paymentResourcesSignature(left?.resources ?? []),
    paymentResourcesSignature(right?.resources ?? [])
  );
}

function paymentResourcesSignature(resources) {
  return resources.map(resource => ({
    resourceId: resource.resourceId,
    capability: resource.capability,
    amount: resource.amount,
    unit: resource.unit ?? null,
    mode: resource.mode ?? null,
    alternativeFor: resource.alternativeFor ?? null,
    policy: resource.policy ?? null
  })).sort((a, b) => `${a.resourceId}:${a.capability}`.localeCompare(`${b.resourceId}:${b.capability}`));
}

function actionForPayment(definition) {
  return {
    id: definition.id,
    slug: definition.slug,
    type: definition.category,
    name: definition.label,
    tags: [...(definition.tags ?? [])],
    metadata: {
      actionDefinitionId: definition.id,
      ...(definition.metadata ?? {})
    }
  };
}

function configurationFailure({code, discovery, errors}) {
  return {
    ok: false,
    code,
    requests: discovery.requests,
    configuration: null,
    preview: null,
    errors,
    traces: discovery.traces ?? [],
    resources: discovery.resources ?? []
  };
}

function appliedTrace(selection, status, data={}) {
  return {
    choiceId: selection.id,
    status,
    source: clonePlain(selection.source),
    data: clonePlain(data)
  };
}

function choiceError(code, choiceId, reason) {
  return {code, choiceId, reason};
}

function normalizeResourceState({actorSystem, resources}) {
  return (resources ? normalizeArray(resources) : economyResourcesFromActorResources(actorSystem ?? {}))
    .map(resource => clonePlain(resource));
}

function normalizeChoiceResponses(responses) {
  const map = new Map();
  if ( responses instanceof Map ) {
    for ( const [id, value] of responses.entries() ) map.set(String(id), clonePlain(value));
    return map;
  }
  if ( Array.isArray(responses) ) {
    for ( const response of responses ) {
      const id = response?.choiceId ?? response?.id;
      if ( id != null ) map.set(String(id), clonePlain(response));
    }
    return map;
  }
  if ( responses && typeof responses === "object" ) {
    for ( const [id, value] of Object.entries(responses) ) map.set(String(id), clonePlain(value));
  }
  return map;
}

function responseValueForDependency(response) {
  if ( response == null ) return undefined;
  if ( isPlainObject(response) ) {
    if ( response.value !== undefined ) return response.value;
    if ( response.selected !== undefined ) return response.selected;
    if ( response.optionId !== undefined ) return response.optionId;
    if ( response.id !== undefined ) return response.id;
  }
  return response;
}

function responseSelectionIsActive(response) {
  const value = responseValueForDependency(response);
  if ( Array.isArray(value) ) return value.length > 0;
  return Boolean(value);
}

function evaluateMaybeExpression(value, context) {
  if ( value == null ) return null;
  if ( typeof value === "number" ) return Number.isFinite(value) ? value : null;
  if ( typeof value === "object" ) {
    const result = evaluateValueExpressionSafe(value, context);
    return result.ok ? result.value : null;
  }
  const number = finiteNumber(value);
  return number == null ? null : number;
}

function evaluateValueExpressionSafe(expression, context) {
  return evaluateValueExpression(expression, context);
}

function findById(entries, id) {
  return (entries ?? []).find(entry => entry.id === id) ?? null;
}

function isValidDamageType(value) {
  return typeof value === "string" && DAMAGE_TYPE_PATTERN.test(value);
}

function formatValueExpression(expression) {
  if ( expression == null ) return null;
  if ( typeof expression === "number" ) return String(expression);
  switch ( expression.type ) {
    case "constant":
      return String(expression.value);
    case "dice": {
      const number = finiteNumber(expression.number ?? expression.count ?? 1) ?? 1;
      const faces = finiteNumber(expression.faces ?? expression.sides) ?? 0;
      const bonus = expression.bonus ? formatValueExpression(expression.bonus) : null;
      return bonus && bonus !== "0" ? `${number}d${faces}+${bonus}` : `${number}d${faces}`;
    }
    case "add":
      return normalizeArray(expression.terms).map(formatValueExpression).filter(Boolean).join(" + ");
    case "subtract":
      return normalizeArray(expression.terms).map(formatValueExpression).filter(Boolean).join(" - ");
    case "multiply":
      return normalizeArray(expression.terms).map(formatValueExpression).filter(Boolean).join(" * ");
    case "context":
      return `@${expression.path}`;
    default:
      return expression.type ?? "expression";
  }
}

function fingerprint(value) {
  return JSON.stringify(stablePlain(value));
}

function stablePlain(value) {
  if ( Array.isArray(value) ) return value.map(stablePlain);
  if ( !isPlainObject(value) ) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stablePlain(value[key])]));
}

function valuesEqual(a, b) {
  return JSON.stringify(stablePlain(a)) === JSON.stringify(stablePlain(b));
}

function firstDefined(values) {
  return values.find(value => value != null);
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

function labelFromId(id) {
  return String(id ?? "unknown")
    .split(/[.\-_]/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return (typeof value === "object") && value !== null && !Array.isArray(value);
}
