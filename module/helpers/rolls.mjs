export const ROLL_SCHEMA_VERSION = 1;

export const ROLL_TYPES = Object.freeze({
  ATTACK: "attack",
  SAVING_THROW: "saving-throw",
  ABILITY_CHECK: "ability-check",
  SKILL_CHECK: "skill-check",
  DAMAGE: "damage",
  HEALING: "healing",
  INITIATIVE: "initiative",
  CONCENTRATION: "concentration",
  DEATH_SAVE: "death-save",
  CUSTOM: "custom"
});

export const ROLL_MODES = Object.freeze({
  NORMAL: "normal",
  ADVANTAGE: "advantage",
  DISADVANTAGE: "disadvantage"
});

export const ROLL_VISIBILITY = Object.freeze({
  SYSTEM: "system",
  PUBLIC: "public",
  PRIVATE: "private",
  SELF: "self",
  GM_ONLY: "gm-only",
  BLIND: "blind"
});

export const ROLL_AUTHORITY = Object.freeze({
  SOURCE_CONTROLLER: "source-controller",
  TARGET_CONTROLLER: "target-controller",
  GM: "gm",
  AUTOMATIC: "automatic",
  SPECIFIC: "specific"
});

export const ROLL_INPUT_MODES = Object.freeze({
  NATURAL: "natural",
  TOTAL: "total",
  STRUCTURED: "structured"
});

export const ROLL_PROVENANCE_TYPES = Object.freeze({
  FOUNDRY_DIGITAL: "foundry-digital",
  MANUAL: "manual",
  PHYSICAL: "physical",
  FAKE: "fake",
  IMPORTED: "imported",
  UNKNOWN: "unknown"
});

export const ROLL_PROVIDER_OUTCOMES = Object.freeze({
  RESULT: "result",
  PENDING: "pending",
  FAILURE: "failure",
  CANCELLED: "cancelled"
});

export const ROLL_CODES = Object.freeze({
  OK: "OK",
  NO_PROVIDER_AVAILABLE: "NO_PROVIDER_AVAILABLE",
  MANUAL_INPUT_REQUIRED: "MANUAL_INPUT_REQUIRED",
  INVALID_MANUAL_RESULT: "INVALID_MANUAL_RESULT",
  REQUEST_MISMATCH: "REQUEST_MISMATCH",
  STALE_ROLL_RESULT: "STALE_ROLL_RESULT",
  PROVIDER_FAILURE: "PROVIDER_FAILURE",
  ROLL_CANCELLED: "ROLL_CANCELLED",
  UNSUPPORTED_ROLL_TYPE: "UNSUPPORTED_ROLL_TYPE",
  INVALID_ROLL_DEFINITION: "INVALID_ROLL_DEFINITION",
  INVALID_ROLL_RESULT: "INVALID_ROLL_RESULT",
  NON_SERIALIZABLE_ROLL_DATA: "NON_SERIALIZABLE_ROLL_DATA"
});

const D20_ROLL_TYPES = new Set([
  ROLL_TYPES.ATTACK,
  ROLL_TYPES.SAVING_THROW,
  ROLL_TYPES.ABILITY_CHECK,
  ROLL_TYPES.SKILL_CHECK,
  ROLL_TYPES.INITIATIVE,
  ROLL_TYPES.CONCENTRATION,
  ROLL_TYPES.DEATH_SAVE
]);

let nextRollRequestSequence = 1;

/* -------------------------------------------- */

export function createRollRequest(options={}) {
  const request = normalizeRollRequest(options);
  const validation = validateRollRequest(request);
  if ( !validation.ok ) {
    throw new TypeError(validation.reason ?? `Invalid RollRequest: ${validation.code}`);
  }
  return request;
}

/* -------------------------------------------- */

export function createD20RollRequest({
  type=ROLL_TYPES.ABILITY_CHECK,
  modifier=0,
  modifierTotal=null,
  rollMode=ROLL_MODES.NORMAL,
  formula=null,
  definition={},
  expected={},
  metadata={},
  ...options
}={}) {
  const totalModifier = finiteNumber(modifierTotal ?? modifier) ?? 0;
  const normalizedMode = normalizeRollMode(rollMode);
  return createRollRequest({
    ...options,
    type,
    formula,
    rollMode: normalizedMode,
    definition: {
      ...(clonePlainData(definition, "definition") ?? {}),
      dice: normalizeRollDiceTerms(definition.dice ?? [{id: "d20", number: 1, faces: 20, purpose: "d20"}]),
      modifierTotal: totalModifier
    },
    modifiers: normalizeRollModifiers(options.modifiers ?? [{id: "modifier", value: totalModifier}]),
    expected: {
      primaryDieFaces: 20,
      requireNatural: true,
      manualInputMode: ROLL_INPUT_MODES.NATURAL,
      validateTotalFromNatural: true,
      modifierTotal: totalModifier,
      ...(clonePlainData(expected, "expected") ?? {})
    },
    metadata: {
      ...(clonePlainData(metadata, "metadata") ?? {}),
      d20: true
    }
  });
}

/* -------------------------------------------- */

export function createDamageRollRequest({
  type=ROLL_TYPES.DAMAGE,
  components=[],
  formula=null,
  definition={},
  expected={},
  metadata={},
  ...options
}={}) {
  const componentDice = normalizeArray(components)
    .flatMap((component, index) => diceTermsFromDamageComponent(component, index));
  return createRollRequest({
    ...options,
    type,
    formula,
    definition: {
      ...(clonePlainData(definition, "definition") ?? {}),
      components: clonePlainData(components, "components") ?? [],
      dice: normalizeRollDiceTerms(definition.dice ?? componentDice),
      modifierTotal: finiteNumber(definition.modifierTotal ?? definition.bonus) ?? 0
    },
    expected: {
      manualInputMode: ROLL_INPUT_MODES.TOTAL,
      requireNatural: false,
      ...(clonePlainData(expected, "expected") ?? {})
    },
    metadata: clonePlainData(metadata, "metadata") ?? {}
  });
}

/* -------------------------------------------- */

export function createConcentrationRollRequest({
  checkRequest,
  resolutionId=null,
  modifier=0,
  ...options
}={}) {
  return createD20RollRequest({
    ...options,
    id: options.id ?? checkRequest?.id,
    resolutionId: resolutionId ?? options.resolutionId ?? null,
    type: ROLL_TYPES.CONCENTRATION,
    modifier,
    dc: {value: checkRequest?.dc, slug: checkRequest?.saveKey ?? "concentration", ability: checkRequest?.ability ?? null},
    source: checkRequest?.actorRef ?? checkRequest?.sourceRef ?? null,
    target: checkRequest?.target ?? checkRequest?.targetRef ?? null,
    authority: options.authority ?? {kind: ROLL_AUTHORITY.TARGET_CONTROLLER},
    metadata: {
      ...(clonePlainData(options.metadata ?? {}, "metadata") ?? {}),
      checkRequest: clonePlainData(checkRequest ?? null, "checkRequest"),
      checkRequestId: checkRequest?.id ?? null,
      saveKey: checkRequest?.saveKey ?? "concentration",
      ability: checkRequest?.ability ?? "con"
    }
  });
}

/* -------------------------------------------- */

export function validateRollRequest(request) {
  const serializableIssue = findNonPlainData(request, "rollRequest");
  if ( serializableIssue ) {
    return validationFailure(ROLL_CODES.NON_SERIALIZABLE_ROLL_DATA, serializableIssue.reason, serializableIssue.path);
  }

  const data = normalizeRollRequest(request, {skipSerializableClone: true});
  if ( data.schemaVersion !== ROLL_SCHEMA_VERSION ) {
    return validationFailure(ROLL_CODES.INVALID_ROLL_DEFINITION, "RollRequest schemaVersion must be 1.", "schemaVersion");
  }
  if ( !data.id ) return validationFailure(ROLL_CODES.INVALID_ROLL_DEFINITION, "RollRequest requires a stable id.", "id");
  if ( !data.type ) return validationFailure(ROLL_CODES.UNSUPPORTED_ROLL_TYPE, "RollRequest requires a semantic type.", "type");

  for ( const [index, die] of data.definition.dice.entries() ) {
    if ( die.number < 0 || die.faces <= 0 ) {
      return validationFailure(ROLL_CODES.INVALID_ROLL_DEFINITION, "RollRequest dice require non-negative count and positive faces.", `definition.dice.${index}`);
    }
  }

  const formula = rollFormulaForRequest(data);
  if ( !formula.ok && !data.definition.dice.length && !data.formula ) {
    return validationFailure(formula.code, formula.reason, "formula");
  }

  return {
    ok: true,
    code: ROLL_CODES.OK,
    reason: null,
    path: null,
    request: data
  };
}

/* -------------------------------------------- */

export function createRollResult(options={}) {
  const result = normalizeRollResult(options);
  const validation = validateRollResult(result, {request: options.request ?? null});
  if ( !validation.ok ) {
    throw new TypeError(validation.reason ?? `Invalid RollResult: ${validation.code}`);
  }
  return result;
}

/* -------------------------------------------- */

export function normalizeRollResponseValue(value, {request=null, provider=null, completedRequestIds=[]}={}) {
  const rollResult = normalizeRollResult({
    ...(isPlainObject(value) ? value : {total: value}),
    request,
    provider: provider ?? value?.provider ?? null
  });
  const validation = validateRollResult(rollResult, {request, completedRequestIds});
  if ( !validation.ok ) return {
    ok: false,
    code: validation.code,
    reason: validation.reason,
    validation,
    result: rollResult
  };
  return {
    ok: true,
    code: ROLL_CODES.OK,
    result: rollResult,
    validation
  };
}

/* -------------------------------------------- */

export function validateRollResult(result, {
  request=null,
  completedRequestIds=[]
}={}) {
  const serializableIssue = findNonPlainData(result, "rollResult");
  if ( serializableIssue ) {
    return validationFailure(ROLL_CODES.NON_SERIALIZABLE_ROLL_DATA, serializableIssue.reason, serializableIssue.path);
  }

  const data = normalizeRollResult(result, {skipSerializableClone: true});
  const requestData = request ? normalizeRollRequest(request) : null;
  if ( data.schemaVersion !== ROLL_SCHEMA_VERSION ) {
    return validationFailure(ROLL_CODES.INVALID_ROLL_RESULT, "RollResult schemaVersion must be 1.", "schemaVersion");
  }
  if ( !data.requestId ) return validationFailure(ROLL_CODES.REQUEST_MISMATCH, "RollResult requires a request id.", "requestId");
  if ( completedRequestIds.map(String).includes(data.requestId) ) {
    return validationFailure(ROLL_CODES.STALE_ROLL_RESULT, "RollResult request has already been completed.", "requestId");
  }
  if ( requestData ) {
    if ( data.requestId !== requestData.id ) {
      return validationFailure(ROLL_CODES.REQUEST_MISMATCH, "RollResult request id does not match the RollRequest.", "requestId");
    }
    if ( requestData.resolutionId && data.resolutionId !== requestData.resolutionId ) {
      return validationFailure(ROLL_CODES.REQUEST_MISMATCH, "RollResult resolution id does not match the RollRequest.", "resolutionId");
    }
    if ( data.type !== requestData.type ) {
      return validationFailure(ROLL_CODES.REQUEST_MISMATCH, "RollResult semantic type does not match the RollRequest.", "type");
    }
  }

  if ( data.total == null ) {
    return validationFailure(ROLL_CODES.INVALID_ROLL_RESULT, "RollResult total is required.", "total");
  }

  const expectedFaces = finiteNumber(requestData?.expected?.primaryDieFaces);
  const requiresNatural = requestData?.expected?.requireNatural === true
    || (expectedFaces === 20 && D20_ROLL_TYPES.has(data.type));
  if ( requiresNatural && data.natural == null ) {
    return validationFailure(ROLL_CODES.INVALID_MANUAL_RESULT, "RollResult requires an unmodified natural die result.", "natural");
  }
  if ( data.natural != null ) {
    const faces = expectedFaces ?? primaryDieFaces(data.dice) ?? 20;
    if ( !isIntegerInRange(data.natural, 1, faces) ) {
      return validationFailure(ROLL_CODES.INVALID_MANUAL_RESULT, `Natural die result must be between 1 and ${faces}.`, "natural");
    }
  }

  for ( const [dieIndex, die] of data.dice.entries() ) {
    for ( const [resultIndex, entry] of die.results.entries() ) {
      if ( entry.result != null && !isIntegerInRange(entry.result, 1, die.faces) ) {
        return validationFailure(ROLL_CODES.INVALID_ROLL_RESULT, `Die result must be between 1 and ${die.faces}.`, `dice.${dieIndex}.results.${resultIndex}.result`);
      }
    }
  }

  if ( requestData?.expected?.validateTotalFromNatural !== false
    && requestData?.expected?.manualInputMode === ROLL_INPUT_MODES.NATURAL
    && data.natural != null
    && requestData?.expected?.modifierTotal != null
  ) {
    const expectedTotal = data.natural + (finiteNumber(requestData.expected.modifierTotal) ?? 0);
    if ( data.total !== expectedTotal ) {
      return validationFailure(
        ROLL_CODES.INVALID_MANUAL_RESULT,
        "RollResult total does not match natural die plus the RollRequest modifier.",
        "total"
      );
    }
  }

  return {
    ok: true,
    code: ROLL_CODES.OK,
    reason: null,
    path: null,
    result: data
  };
}

/* -------------------------------------------- */

export function createRollResultFromManualInput({request, input, provider=null, provenance={}}={}) {
  const requestData = createRollRequest(request);
  const supplied = manualInputSource(input);
  if ( supplied.cancelled || supplied.status === ROLL_PROVIDER_OUTCOMES.CANCELLED ) {
    return {
      ok: false,
      status: ROLL_PROVIDER_OUTCOMES.CANCELLED,
      code: ROLL_CODES.ROLL_CANCELLED,
      reason: "Roll request was cancelled.",
      request: requestData
    };
  }

  const suppliedRequestId = stringOrNull(supplied.requestId ?? supplied.id);
  if ( suppliedRequestId && suppliedRequestId !== requestData.id ) {
    return providerFailure(ROLL_CODES.REQUEST_MISMATCH, "Manual roll result request id does not match.", {request: requestData});
  }
  const suppliedResolutionId = stringOrNull(supplied.resolutionId);
  if ( suppliedResolutionId && requestData.resolutionId && suppliedResolutionId !== requestData.resolutionId ) {
    return providerFailure(ROLL_CODES.REQUEST_MISMATCH, "Manual roll result resolution id does not match.", {request: requestData});
  }
  const suppliedType = stringOrNull(supplied.type ?? supplied.semanticType);
  if ( suppliedType && suppliedType !== requestData.type ) {
    return providerFailure(ROLL_CODES.REQUEST_MISMATCH, "Manual roll result semantic type does not match.", {request: requestData});
  }

  const natural = finiteNumber(supplied.natural ?? supplied.die ?? supplied.d20);
  const expectedMode = requestData.expected.manualInputMode ?? ROLL_INPUT_MODES.TOTAL;
  const suppliedTotal = finiteNumber(supplied.total ?? supplied.value ?? supplied.amount);
  const total = suppliedTotal
    ?? (expectedMode === ROLL_INPUT_MODES.NATURAL && natural != null
      ? natural + (finiteNumber(requestData.expected.modifierTotal) ?? rollModifierTotal(requestData))
      : null);
  const result = normalizeRollResult({
    request: requestData,
    requestId: requestData.id,
    resolutionId: requestData.resolutionId,
    type: requestData.type,
    total,
    natural,
    dice: supplied.dice ?? diceFromManualNatural({request: requestData, natural}),
    formula: supplied.formula ?? rollFormulaForRequest(requestData).formula ?? requestData.formula,
    terms: supplied.terms ?? null,
    provider,
    provenance: {
      type: provider?.type ?? provider?.providerType ?? ROLL_PROVENANCE_TYPES.MANUAL,
      providerId: provider?.id ?? null,
      method: expectedMode,
      authority: clonePlainData(requestData.authority, "authority"),
      ...(clonePlainData(provenance, "provenance") ?? {}),
      ...(clonePlainData(supplied.provenance ?? {}, "input.provenance") ?? {})
    },
    metadata: supplied.metadata ?? {},
    raw: supplied.raw ?? null
  });
  const validation = validateRollResult(result, {request: requestData});
  if ( !validation.ok ) {
    return {
      ok: false,
      status: ROLL_PROVIDER_OUTCOMES.FAILURE,
      code: validation.code === ROLL_CODES.REQUEST_MISMATCH ? validation.code : ROLL_CODES.INVALID_MANUAL_RESULT,
      reason: validation.reason,
      validation,
      request: requestData,
      result
    };
  }

  return {
    ok: true,
    status: ROLL_PROVIDER_OUTCOMES.RESULT,
    code: ROLL_CODES.OK,
    request: requestData,
    result
  };
}

/* -------------------------------------------- */

export function rollFormulaForRequest(request) {
  const data = normalizeRollRequest(request);
  if ( data.formula ) return {ok: true, code: ROLL_CODES.OK, formula: data.formula};

  const dice = data.definition.dice.map(die => formulaForDieTerm(die, data.rollMode)).filter(Boolean);
  const expressionFormula = formulaFromValueExpression(data.definition.expression);
  if ( expressionFormula ) dice.push(expressionFormula);

  const modifier = finiteNumber(data.definition.modifierTotal) ?? rollModifierTotal(data);
  const formula = joinFormulaTerms([
    ...dice,
    modifier === 0 ? null : String(modifier)
  ]);
  if ( !formula ) return {
    ok: false,
    code: ROLL_CODES.INVALID_ROLL_DEFINITION,
    formula: null,
    reason: "RollRequest requires a formula or structured dice definition."
  };
  return {
    ok: true,
    code: ROLL_CODES.OK,
    formula
  };
}

/* -------------------------------------------- */

export function rollResultToResolverRoll(result) {
  const data = normalizeRollResult(result);
  return {
    total: data.total,
    die: data.natural,
    natural: data.natural,
    d20: data.natural,
    formula: data.formula,
    mode: data.rollMode,
    modifiers: data.modifiers,
    dice: data.dice,
    metadata: {
      ...(clonePlainData(data.metadata, "metadata") ?? {}),
      rollRequestId: data.requestId,
      rollResult: data
    }
  };
}

/* -------------------------------------------- */

export function rollResultToDamageComponents({result, components=[]}={}) {
  const data = normalizeRollResult(result);
  if ( !components?.length ) return [];
  const componentCount = components.length;
  if ( componentCount === 1 ) {
    return components.map(component => ({
      ...(clonePlainData(component, "component") ?? {}),
      amount: data.total,
      rolled: data.total,
      dice: firstDieSummary(data.dice),
      metadata: {
        ...(clonePlainData(component.metadata ?? {}, "component.metadata") ?? {}),
        rollRequestId: data.requestId,
        rollResult: data
      }
    }));
  }
  return components.map(component => clonePlainData(component, "component"));
}

/* -------------------------------------------- */

export function cloneRollData(value, path="rollData") {
  return clonePlainData(value, path);
}

/* -------------------------------------------- */

function normalizeRollRequest(raw={}, {skipSerializableClone=false}={}) {
  const source = skipSerializableClone ? raw : (clonePlainData(raw, "rollRequest") ?? {});
  const definition = normalizeRollDefinition(source.definition ?? source.rollDefinition ?? source.expression ?? {});
  const expected = normalizeRollExpected(source.expected ?? source.validation ?? {}, source.type);
  const id = stringOrDefault(source.id ?? source.requestId, createGeneratedRollRequestId(source.resolutionId, source.type));
  return {
    schemaVersion: finiteInteger(source.schemaVersion) ?? ROLL_SCHEMA_VERSION,
    id,
    resolutionId: stringOrNull(source.resolutionId),
    type: normalizeRollType(source.type ?? source.semanticType ?? ROLL_TYPES.CUSTOM),
    formula: stringOrNull(source.formula ?? source.rollFormula ?? definition.formula),
    data: skipSerializableClone ? (source.data ?? {}) : (clonePlainData(source.data ?? {}, "rollRequest.data") ?? {}),
    definition,
    modifiers: normalizeRollModifiers(source.modifiers ?? []),
    rollMode: normalizeRollMode(source.rollMode ?? source.mode ?? source.advantageState),
    dc: normalizeRollDC(source.dc ?? source.difficulty),
    visibility: normalizeRollVisibility(source.visibility ?? source.visibilityPolicy ?? source.rollVisibility),
    chooser: skipSerializableClone ? (source.chooser ?? null) : clonePlainData(source.chooser ?? null, "rollRequest.chooser"),
    authority: skipSerializableClone ? (source.authority ?? null) : clonePlainData(source.authority ?? null, "rollRequest.authority"),
    source: skipSerializableClone ? (source.source ?? null) : clonePlainData(source.source ?? null, "rollRequest.source"),
    target: skipSerializableClone ? (source.target ?? null) : clonePlainData(source.target ?? null, "rollRequest.target"),
    provenance: normalizeRollProvenance(source.provenance ?? {}),
    expected,
    metadata: skipSerializableClone ? (source.metadata ?? {}) : (clonePlainData(source.metadata ?? {}, "rollRequest.metadata") ?? {})
  };
}

function normalizeRollDefinition(definition) {
  const data = typeof definition === "string"
    ? {formula: definition}
    : isPlainObject(definition)
      ? definition
      : {};
  const expression = data.expression ?? (data.type === "dice" ? data : null);
  const dice = data.dice ?? diceTermsFromValueExpression(expression);
  return {
    formula: stringOrNull(data.formula),
    expression: clonePlainData(expression, "definition.expression"),
    dice: normalizeRollDiceTerms(dice),
    terms: normalizeArray(data.terms).map((term, index) => clonePlainData(term, `definition.terms.${index}`)),
    modifierTotal: finiteNumber(data.modifierTotal ?? data.modifier ?? data.bonus) ?? null,
    components: clonePlainData(data.components ?? [], "definition.components") ?? [],
    metadata: clonePlainData(data.metadata ?? {}, "definition.metadata") ?? {}
  };
}

function normalizeRollExpected(expected, type=null) {
  const data = isPlainObject(expected) ? expected : {};
  const rollType = normalizeRollType(type ?? ROLL_TYPES.CUSTOM);
  const d20 = D20_ROLL_TYPES.has(rollType);
  return {
    primaryDieFaces: finiteInteger(data.primaryDieFaces ?? data.faces ?? (d20 ? 20 : null)),
    requireNatural: data.requireNatural ?? d20,
    manualInputMode: stringOrDefault(data.manualInputMode ?? data.inputMode, d20 ? ROLL_INPUT_MODES.NATURAL : ROLL_INPUT_MODES.TOTAL),
    validateTotalFromNatural: data.validateTotalFromNatural ?? d20,
    modifierTotal: finiteNumber(data.modifierTotal ?? data.modifier) ?? null,
    staleAfterStageId: stringOrNull(data.staleAfterStageId),
    metadata: clonePlainData(data.metadata ?? {}, "expected.metadata") ?? {}
  };
}

function normalizeRollResult(raw={}, {skipSerializableClone=false}={}) {
  const request = raw.request ? normalizeRollRequest(raw.request) : null;
  const source = skipSerializableClone ? raw : (clonePlainData(raw, "rollResult") ?? {});
  const resultData = isPlainObject(source.result) ? source.result : {};
  const provider = normalizeRollProviderReference(source.provider ?? request?.provenance ?? {});
  const dice = normalizeRollResultDice(source.dice ?? resultData.dice ?? []);
  const natural = finiteNumber(source.natural ?? source.die ?? source.d20 ?? resultData.natural ?? resultData.die)
    ?? naturalFromDice(dice, request?.expected?.primaryDieFaces);
  const total = finiteNumber(source.total ?? source.value ?? source.amount ?? resultData.total)
    ?? (request?.expected?.manualInputMode === ROLL_INPUT_MODES.NATURAL && natural != null
      ? natural + (finiteNumber(request.expected.modifierTotal) ?? rollModifierTotal(request))
      : null);

  return {
    schemaVersion: finiteInteger(source.schemaVersion) ?? ROLL_SCHEMA_VERSION,
    requestId: stringOrNull(source.requestId ?? source.id) ?? request?.id ?? null,
    resolutionId: stringOrNull(source.resolutionId) ?? request?.resolutionId ?? null,
    type: normalizeRollType(source.type ?? source.semanticType ?? request?.type ?? ROLL_TYPES.CUSTOM),
    total,
    natural,
    dice,
    formula: stringOrNull(source.formula ?? resultData.formula) ?? rollFormulaForRequestOrNull(request),
    terms: clonePlainData(source.terms ?? resultData.terms ?? [], "rollResult.terms") ?? [],
    modifiers: normalizeRollModifiers(source.modifiers ?? request?.modifiers ?? []),
    rollMode: normalizeRollMode(source.rollMode ?? source.mode ?? request?.rollMode),
    provider,
    provenance: normalizeRollProvenance({
      type: provider.type,
      providerId: provider.id,
      ...(source.provenance ?? resultData.provenance ?? {})
    }),
    validation: normalizeValidation(source.validation),
    raw: clonePlainData(source.raw ?? source.rawProviderData ?? null, "rollResult.raw"),
    metadata: clonePlainData(source.metadata ?? {}, "rollResult.metadata") ?? {}
  };
}

function normalizeRollDiceTerms(dice) {
  return normalizeArray(dice).map((die, index) => {
    const data = typeof die === "number" ? {faces: die, number: 1} : (die ?? {});
    return {
      id: stringOrDefault(data.id ?? data.key, `die:${index}`),
      number: Math.max(finiteInteger(data.number ?? data.count ?? 1) ?? 1, 0),
      faces: Math.max(finiteInteger(data.faces ?? data.sides) ?? 0, 0),
      modifiers: normalizeStrings(data.modifiers ?? []),
      purpose: stringOrNull(data.purpose ?? data.type),
      source: clonePlainData(data.source ?? null, `dice.${index}.source`),
      metadata: clonePlainData(data.metadata ?? {}, `dice.${index}.metadata`) ?? {}
    };
  });
}

function normalizeRollResultDice(dice) {
  return normalizeArray(dice).map((die, index) => {
    const data = die ?? {};
    const faces = Math.max(finiteInteger(data.faces ?? data.sides) ?? 0, 0);
    return {
      id: stringOrDefault(data.id ?? data.key, `die:${index}`),
      number: Math.max(finiteInteger(data.number ?? data.count ?? data.results?.length ?? 0) ?? 0, 0),
      faces,
      modifiers: normalizeStrings(data.modifiers ?? []),
      purpose: stringOrNull(data.purpose ?? data.type),
      results: normalizeArray(data.results ?? data.values).map((entry, resultIndex) => normalizeDieResult(entry, resultIndex)),
      source: clonePlainData(data.source ?? null, `resultDice.${index}.source`),
      metadata: clonePlainData(data.metadata ?? {}, `resultDice.${index}.metadata`) ?? {}
    };
  });
}

function normalizeDieResult(entry, index) {
  const data = typeof entry === "number" ? {result: entry} : (entry ?? {});
  const active = data.active ?? data.kept ?? data.counted ?? data.discarded !== true;
  return {
    index: finiteInteger(data.index) ?? index,
    result: finiteInteger(data.result ?? data.value ?? data.roll),
    active: active !== false,
    discarded: data.discarded === true || active === false,
    rerolled: data.rerolled === true,
    exploded: data.exploded === true,
    critical: data.critical === true,
    fumble: data.fumble === true,
    metadata: clonePlainData(data.metadata ?? {}, `dieResult.${index}.metadata`) ?? {}
  };
}

function normalizeRollModifiers(modifiers) {
  return normalizeArray(modifiers)
    .filter(modifier => modifier != null)
    .map((modifier, index) => {
      if ( typeof modifier === "number" ) {
        return {id: `modifier:${index}`, value: modifier, label: null, source: null, metadata: {}};
      }
      return {
        id: stringOrDefault(modifier.id ?? modifier.slug ?? modifier.key, `modifier:${index}`),
        value: finiteNumber(modifier.value ?? modifier.amount ?? modifier.modifier) ?? 0,
        label: stringOrNull(modifier.label ?? modifier.name),
        source: clonePlainData(modifier.source ?? null, `modifier.${index}.source`),
        metadata: clonePlainData(modifier.metadata ?? {}, `modifier.${index}.metadata`) ?? {}
      };
    });
}

function normalizeRollProvenance(provenance) {
  const data = isPlainObject(provenance) ? provenance : {};
  return {
    type: stringOrDefault(data.type ?? data.method ?? data.providerType, ROLL_PROVENANCE_TYPES.UNKNOWN),
    providerId: stringOrNull(data.providerId ?? data.provider),
    method: stringOrNull(data.method),
    userRef: stringOrNull(data.userRef),
    authority: clonePlainData(data.authority ?? null, "provenance.authority"),
    source: clonePlainData(data.source ?? null, "provenance.source"),
    metadata: clonePlainData(data.metadata ?? {}, "provenance.metadata") ?? {}
  };
}

function normalizeRollProviderReference(provider) {
  const data = isPlainObject(provider) ? provider : {};
  return {
    id: stringOrDefault(data.id ?? data.providerId, null),
    type: stringOrDefault(data.type ?? data.providerType, ROLL_PROVENANCE_TYPES.UNKNOWN),
    label: stringOrNull(data.label ?? data.name)
  };
}

function normalizeValidation(validation) {
  if ( validation == null ) return {ok: true, code: ROLL_CODES.OK, reason: null};
  return {
    ok: validation.ok !== false,
    code: stringOrDefault(validation.code, validation.ok === false ? ROLL_CODES.INVALID_ROLL_RESULT : ROLL_CODES.OK),
    reason: stringOrNull(validation.reason)
  };
}

function normalizeRollType(value) {
  return stringOrDefault(value, ROLL_TYPES.CUSTOM);
}

function normalizeRollMode(value) {
  const token = String(value ?? "").trim().toLowerCase().replace(/[_\s]/g, "-");
  switch ( token ) {
    case "adv":
    case "advantage":
      return ROLL_MODES.ADVANTAGE;
    case "dis":
    case "disadvantage":
      return ROLL_MODES.DISADVANTAGE;
    default:
      return ROLL_MODES.NORMAL;
  }
}

function normalizeRollVisibility(value) {
  const token = String(value ?? "").trim().toLowerCase().replace(/[_\s]/g, "-");
  switch ( token ) {
    case "public":
    case "publicroll":
      return ROLL_VISIBILITY.PUBLIC;
    case "private":
    case "privateroll":
      return ROLL_VISIBILITY.PRIVATE;
    case "self":
    case "selfroll":
      return ROLL_VISIBILITY.SELF;
    case "gm":
    case "gm-only":
    case "gmroll":
      return ROLL_VISIBILITY.GM_ONLY;
    case "blind":
    case "blindroll":
      return ROLL_VISIBILITY.BLIND;
    default:
      return ROLL_VISIBILITY.SYSTEM;
  }
}

function normalizeRollDC(dc) {
  if ( dc == null ) return null;
  if ( typeof dc === "number" || typeof dc === "string" ) {
    const value = finiteNumber(dc);
    return value == null ? null : {value, slug: "dc", source: null, metadata: {}};
  }
  return {
    value: finiteNumber(dc.value ?? dc.dc ?? dc.total),
    slug: stringOrDefault(dc.slug ?? dc.key, "dc"),
    ability: stringOrNull(dc.ability),
    source: clonePlainData(dc.source ?? null, "dc.source"),
    metadata: clonePlainData(dc.metadata ?? {}, "dc.metadata") ?? {}
  };
}

function diceTermsFromDamageComponent(component, index) {
  if ( !component || typeof component !== "object" ) return [];
  const dice = component.dice ? [component.dice] : diceTermsFromValueExpression(component.expression ?? component.valueExpression);
  return dice.map((die, dieIndex) => ({
    ...die,
    id: die.id ?? `${component.id ?? `component:${index}`}:die:${dieIndex}`,
    purpose: component.damageType ?? "damage",
    source: {
      componentId: component.id ?? null,
      damageType: component.damageType ?? component.type ?? null
    }
  }));
}

function diceTermsFromValueExpression(expression) {
  if ( !expression || typeof expression !== "object" ) return [];
  if ( expression.type === "dice" ) return [{
    number: finiteInteger(expression.number ?? expression.count ?? 1) ?? 1,
    faces: finiteInteger(expression.faces ?? expression.sides) ?? 0,
    purpose: expression.purpose ?? "expression",
    metadata: clonePlainData(expression.metadata ?? {}, "expression.metadata") ?? {}
  }];
  if ( Array.isArray(expression.terms) ) return expression.terms.flatMap(diceTermsFromValueExpression);
  return [
    expression.left,
    expression.right,
    expression.value,
    expression.bonus,
    expression.minus,
    expression.numerator,
    expression.denominator
  ].flatMap(diceTermsFromValueExpression);
}

function formulaFromValueExpression(expression) {
  if ( expression == null ) return null;
  if ( typeof expression === "number" ) return String(expression);
  if ( !isPlainObject(expression) ) return null;
  switch ( expression.type ) {
    case "constant":
      return finiteNumber(expression.value) == null ? null : String(finiteNumber(expression.value));
    case "dice": {
      const number = finiteInteger(expression.number ?? expression.count ?? 1) ?? 1;
      const faces = finiteInteger(expression.faces ?? expression.sides);
      if ( faces == null || faces <= 0 ) return null;
      const dice = `${number}d${faces}`;
      return joinFormulaTerms([dice, formulaFromValueExpression(expression.bonus)]);
    }
    case "add":
      return joinFormulaTerms(normalizeArray(expression.terms).map(formulaFromValueExpression));
    case "subtract": {
      if ( Array.isArray(expression.terms) && expression.terms.length ) {
        const [first, ...rest] = expression.terms.map(formulaFromValueExpression);
        return [first, ...rest.map(term => term ? `-${term}` : null)].filter(Boolean).join(" ");
      }
      const left = formulaFromValueExpression(expression.left ?? expression.value);
      const right = formulaFromValueExpression(expression.right ?? expression.minus);
      return [left, right ? `-${right}` : null].filter(Boolean).join(" ");
    }
    default:
      return null;
  }
}

function formulaForDieTerm(die, rollMode) {
  if ( die.faces <= 0 || die.number <= 0 ) return null;
  const isD20 = die.faces === 20 && die.number === 1;
  if ( isD20 && rollMode === ROLL_MODES.ADVANTAGE ) return "2d20kh";
  if ( isD20 && rollMode === ROLL_MODES.DISADVANTAGE ) return "2d20kl";
  return `${die.number}d${die.faces}${die.modifiers.join("")}`;
}

function joinFormulaTerms(terms) {
  const parts = terms.filter(term => term != null && term !== "").map(String);
  if ( !parts.length ) return null;
  return parts.reduce((formula, term, index) => {
    if ( index === 0 ) return term;
    return Number(term) < 0 ? `${formula} - ${Math.abs(Number(term))}` : `${formula} + ${term}`;
  }, "");
}

function manualInputSource(input) {
  const source = input?.rollResult ?? input?.result ?? input?.value ?? input;
  if ( finiteNumber(source) != null ) return {natural: finiteNumber(source)};
  return clonePlainData(source ?? {}, "manualInput") ?? {};
}

function diceFromManualNatural({request, natural}) {
  if ( natural == null ) return [];
  const faces = finiteInteger(request.expected.primaryDieFaces) ?? 20;
  return [{
    id: "manual-natural",
    number: 1,
    faces,
    purpose: request.type,
    results: [{index: 0, result: natural, active: true, discarded: false, rerolled: false, exploded: false, critical: false, fumble: false, metadata: {}}],
    modifiers: [],
    source: null,
    metadata: {}
  }];
}

function rollModifierTotal(request) {
  const definitionTotal = finiteNumber(request?.definition?.modifierTotal);
  if ( definitionTotal != null ) return definitionTotal;
  return normalizeRollModifiers(request?.modifiers ?? [])
    .reduce((sum, modifier) => sum + modifier.value, 0);
}

function naturalFromDice(dice, faces=null) {
  const desiredFaces = finiteInteger(faces);
  const candidates = dice
    .filter(die => desiredFaces == null || die.faces === desiredFaces)
    .flatMap(die => die.results.map(result => ({...result, faces: die.faces})))
    .filter(result => result.active !== false && result.result != null);
  return candidates[0]?.result ?? null;
}

function primaryDieFaces(dice) {
  return dice.find(die => die.faces > 0)?.faces ?? null;
}

function firstDieSummary(dice) {
  const die = dice[0];
  if ( !die ) return null;
  return {
    number: die.number,
    faces: die.faces,
    results: die.results.map(result => result.result).filter(value => value != null),
    formula: `${die.number}d${die.faces}`,
    metadata: {
      rollDice: die
    }
  };
}

function rollFormulaForRequestOrNull(request) {
  if ( !request ) return null;
  const formula = rollFormulaForRequest(request);
  return formula.ok ? formula.formula : null;
}

function providerFailure(code, reason, data={}) {
  return {
    ok: false,
    status: ROLL_PROVIDER_OUTCOMES.FAILURE,
    code,
    reason,
    ...clonePlainData(data, "failure")
  };
}

function validationFailure(code, reason, path=null) {
  return {ok: false, code, reason, path};
}

function createGeneratedRollRequestId(resolutionId, type) {
  const prefix = resolutionId ? `roll:${resolutionId}` : "roll";
  return `${prefix}:${stringOrDefault(type, ROLL_TYPES.CUSTOM)}:${nextRollRequestSequence++}`;
}

function clonePlainData(value, path) {
  const issue = findNonPlainData(value, path);
  if ( issue ) throw new TypeError(issue.reason);
  return clonePlainDataUnchecked(value);
}

function clonePlainDataUnchecked(value) {
  if ( value == null || typeof value !== "object" ) return value;
  if ( Array.isArray(value) ) return value.map(clonePlainDataUnchecked);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clonePlainDataUnchecked(entry)]));
}

function findNonPlainData(value, path="value", seen=new WeakSet()) {
  if ( value == null ) return null;
  const type = typeof value;
  if ( type === "string" || type === "boolean" ) return null;
  if ( type === "number" ) return Number.isFinite(value)
    ? null
    : {path, reason: `${path} must be finite plain data.`};
  if ( type === "function" || type === "symbol" || type === "bigint" || type === "undefined" ) {
    return {path, reason: `${path} must be plain serializable data, not ${type}.`};
  }
  if ( seen.has(value) ) return {path, reason: `${path} must not contain circular references.`};
  seen.add(value);
  if ( Array.isArray(value) ) {
    for ( const [index, entry] of value.entries() ) {
      const issue = findNonPlainData(entry, `${path}.${index}`, seen);
      if ( issue ) return issue;
    }
    seen.delete(value);
    return null;
  }
  if ( !isPlainObject(value) ) {
    seen.delete(value);
    return {path, reason: `${path} must be plain serializable data.`};
  }
  for ( const [key, entry] of Object.entries(value) ) {
    const issue = findNonPlainData(entry, `${path}.${key}`, seen);
    if ( issue ) return issue;
  }
  seen.delete(value);
  return null;
}

function isPlainObject(value) {
  return typeof value === "object"
    && value !== null
    && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeArray(value) {
  if ( value == null ) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeStrings(values) {
  return [...new Set(normalizeArray(values).filter(value => value != null && value !== "").map(String))];
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
  if ( typeof value === "object" || typeof value === "function" || typeof value === "boolean" ) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteInteger(value) {
  const number = finiteNumber(value);
  return number == null ? null : Math.floor(number);
}

function isIntegerInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}
