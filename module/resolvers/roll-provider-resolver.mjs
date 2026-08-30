import {
  ROLL_CODES,
  ROLL_INPUT_MODES,
  ROLL_PROVIDER_OUTCOMES,
  ROLL_PROVENANCE_TYPES,
  createRollResultFromManualInput,
  normalizeRollResponseValue,
  rollFormulaForRequest,
  validateRollRequest,
  validateRollResult
} from "../helpers/rolls.mjs";

export const ROLL_PROVIDER_SELECTION_CODES = Object.freeze({
  OK: "OK",
  NO_PROVIDER_AVAILABLE: ROLL_CODES.NO_PROVIDER_AVAILABLE,
  UNSUPPORTED_ROLL_TYPE: ROLL_CODES.UNSUPPORTED_ROLL_TYPE,
  PROVIDER_FAILURE: ROLL_CODES.PROVIDER_FAILURE
});

/* -------------------------------------------- */

export function createRollProviderResolver({providers=[], policy={}}={}) {
  const registeredProviders = normalizeProviders(providers);
  return {
    providers: registeredProviders,
    policy: clonePlain(policy) ?? {},
    select(request, context={}) {
      return selectRollProvider({
        request,
        providers: registeredProviders,
        context: {...(clonePlain(policy) ?? {}), ...(clonePlain(context) ?? {})}
      });
    },
    execute(request, context={}) {
      return executeRollRequest({
        request,
        providers: registeredProviders,
        context: {...(clonePlain(policy) ?? {}), ...(clonePlain(context) ?? {})}
      });
    }
  };
}

/* -------------------------------------------- */

export function selectRollProvider({
  request,
  providers=[],
  context={}
}={}) {
  const validation = validateRollRequest(request);
  if ( !validation.ok ) return selectionFailure(validation.code, validation.reason, {validation});

  const desiredProviderId = providerIdFromPolicy(validation.request, context);
  const availableProviders = normalizeProviders(providers);
  if ( desiredProviderId ) {
    const provider = availableProviders.find(entry => entry.id === desiredProviderId);
    if ( !provider ) return selectionFailure(ROLL_CODES.NO_PROVIDER_AVAILABLE, `RollProvider not registered: ${desiredProviderId}`);
    const canHandle = providerCanHandle(provider, validation.request, context);
    if ( !canHandle.ok ) return selectionFailure(canHandle.code, canHandle.reason, {providerId: provider.id});
    if ( canHandle.value ) return {ok: true, code: ROLL_PROVIDER_SELECTION_CODES.OK, provider, request: validation.request};
    return selectionFailure(ROLL_CODES.UNSUPPORTED_ROLL_TYPE, `RollProvider cannot handle request: ${desiredProviderId}`, {providerId: provider.id});
  }

  for ( const provider of availableProviders ) {
    const canHandle = providerCanHandle(provider, validation.request, context);
    if ( canHandle.ok && canHandle.value ) return {
      ok: true,
      code: ROLL_PROVIDER_SELECTION_CODES.OK,
      provider,
      request: validation.request
    };
  }

  return selectionFailure(ROLL_CODES.NO_PROVIDER_AVAILABLE, "No RollProvider can handle the RollRequest.");
}

/* -------------------------------------------- */

export async function executeRollRequest({
  request,
  providers=[],
  context={},
  completedRequestIds=[]
}={}) {
  const selection = selectRollProvider({request, providers, context});
  if ( !selection.ok ) return {
    ok: false,
    status: ROLL_PROVIDER_OUTCOMES.FAILURE,
    code: selection.code,
    reason: selection.reason,
    request: selection.request ?? null,
    provider: null,
    validation: selection.validation ?? null
  };

  let outcome;
  try {
    outcome = await selection.provider.execute(selection.request, context);
  } catch (error) {
    return providerFailure(selection.provider, ROLL_CODES.PROVIDER_FAILURE, error?.message ?? String(error), {request: selection.request});
  }

  const normalized = normalizeProviderOutcome(outcome, selection.provider, selection.request, completedRequestIds);
  return normalized;
}

/* -------------------------------------------- */

export function createManualRollProvider({
  id="manual-roll",
  label="Manual Roll Provider",
  type=ROLL_PROVENANCE_TYPES.MANUAL,
  inputKey="manualResults"
}={}) {
  return {
    id,
    type,
    label,
    canHandle(request) {
      return validateRollRequest(request).ok;
    },
    async execute(request, context={}) {
      const input = findSuppliedRollInput(context[inputKey] ?? context.manualResults ?? context.suppliedRolls, request);
      if ( !input ) {
        return {
          ok: false,
          status: ROLL_PROVIDER_OUTCOMES.PENDING,
          code: ROLL_CODES.MANUAL_INPUT_REQUIRED,
          reason: "Manual roll input is required.",
          request,
          provider: providerReference(this),
          inputRequest: {
            requestId: request.id,
            resolutionId: request.resolutionId,
            type: request.type,
            inputMode: request.expected?.manualInputMode ?? ROLL_INPUT_MODES.TOTAL,
            requireNatural: request.expected?.requireNatural === true,
            expectedFaces: request.expected?.primaryDieFaces ?? null,
            formula: rollFormulaForRequest(request).formula ?? request.formula,
            metadata: clonePlain(request.metadata ?? {}) ?? {}
          }
        };
      }
      return createRollResultFromManualInput({
        request,
        input,
        provider: providerReference(this),
        provenance: {
          type,
          providerId: id,
          source: "manual-input"
        }
      });
    }
  };
}

/* -------------------------------------------- */

export function createPhysicalDiceProvider({
  id="physical-dice",
  label="Physical Dice Provider",
  inputKey="physicalRolls"
}={}) {
  return createManualRollProvider({
    id,
    label,
    type: ROLL_PROVENANCE_TYPES.PHYSICAL,
    inputKey
  });
}

/* -------------------------------------------- */

export function createTestRollProvider({
  id="test-roll",
  label="Test Roll Provider",
  type=ROLL_PROVENANCE_TYPES.FAKE,
  result=null,
  total=null,
  natural=null,
  dice=null,
  queue=[],
  byRequestId={}
}={}) {
  const queued = [...queue];
  const keyed = clonePlain(byRequestId) ?? {};
  return {
    id,
    type,
    label,
    canHandle(request) {
      return validateRollRequest(request).ok;
    },
    async execute(request) {
      const supplied = keyed[request.id]
        ?? (queued.length ? queued.shift() : null)
        ?? result
        ?? {total, natural, dice};
      return createRollResultFromManualInput({
        request,
        input: {
          ...(clonePlain(supplied) ?? {}),
          requestId: request.id,
          resolutionId: request.resolutionId,
          type: request.type
        },
        provider: providerReference(this),
        provenance: {
          type,
          providerId: id,
          source: "test-provider"
        }
      });
    }
  };
}

/* -------------------------------------------- */

function normalizeProviderOutcome(outcome, provider, request, completedRequestIds) {
  const providerRef = providerReference(provider);
  if ( outcome?.status === ROLL_PROVIDER_OUTCOMES.PENDING ) return {
    ...clonePlain(outcome),
    ok: false,
    status: ROLL_PROVIDER_OUTCOMES.PENDING,
    code: outcome.code ?? ROLL_CODES.MANUAL_INPUT_REQUIRED,
    provider: providerRef,
    request: clonePlain(request)
  };
  if ( outcome?.status === ROLL_PROVIDER_OUTCOMES.CANCELLED || outcome?.code === ROLL_CODES.ROLL_CANCELLED ) {
    return {
      ...clonePlain(outcome),
      ok: false,
      status: ROLL_PROVIDER_OUTCOMES.CANCELLED,
      code: ROLL_CODES.ROLL_CANCELLED,
      provider: providerRef,
      request: clonePlain(request)
    };
  }
  if ( outcome?.ok === false && !outcome?.result ) {
    return {
      ...clonePlain(outcome),
      ok: false,
      status: outcome.status ?? ROLL_PROVIDER_OUTCOMES.FAILURE,
      provider: providerRef,
      request: clonePlain(request)
    };
  }

  const rawResult = outcome?.result ?? outcome;
  const normalized = normalizeRollResponseValue(rawResult, {
    request,
    provider: providerRef,
    completedRequestIds
  });
  if ( !normalized.ok ) return providerFailure(provider, normalized.code, normalized.reason, {
    request,
    result: rawResult,
    validation: normalized.validation
  });
  const validation = validateRollResult(normalized.result, {request, completedRequestIds});
  if ( !validation.ok ) return providerFailure(provider, validation.code, validation.reason, {request, validation});

  return {
    ok: true,
    status: ROLL_PROVIDER_OUTCOMES.RESULT,
    code: ROLL_CODES.OK,
    provider: providerRef,
    request: clonePlain(request),
    result: normalized.result,
    validation
  };
}

function normalizeProviders(providers) {
  return normalizeArray(providers).filter(provider => {
    return provider
      && typeof provider.id === "string"
      && typeof provider.canHandle === "function"
      && typeof provider.execute === "function";
  });
}

function providerCanHandle(provider, request, context) {
  try {
    return {
      ok: true,
      code: ROLL_PROVIDER_SELECTION_CODES.OK,
      value: provider.canHandle(request, context) === true
    };
  } catch (error) {
    return {
      ok: false,
      code: ROLL_CODES.PROVIDER_FAILURE,
      value: false,
      reason: error?.message ?? String(error)
    };
  }
}

function providerIdFromPolicy(request, context) {
  return stringOrNull(
    context.providerId
    ?? context.preferredProviderId
    ?? context.policy?.providerId
    ?? context.policy?.preferredProviderId
    ?? request.authority?.providerId
    ?? request.metadata?.providerId
  );
}

function findSuppliedRollInput(collection, request) {
  const entries = keyedEntries(collection);
  if ( !entries.length ) return null;
  const requestRefs = [
    request.id,
    request.resolutionId ? `${request.resolutionId}:${request.id}` : null
  ].filter(Boolean);
  for ( const entry of entries ) {
    const value = entry.value ?? {};
    const refs = [
      entry.key,
      value.requestId,
      value.id,
      value.rollRequestId,
      value.resolutionId && (value.requestId ?? value.id) ? `${value.resolutionId}:${value.requestId ?? value.id}` : null
    ].filter(Boolean).map(String);
    if ( refs.some(ref => requestRefs.includes(ref)) ) return value;
  }
  if ( entries.length === 1 ) return entries[0].value;
  return null;
}

function keyedEntries(collection) {
  if ( collection == null ) return [];
  if ( typeof collection === "number" || typeof collection === "string" ) {
    return [{key: null, value: collection}];
  }
  if ( Array.isArray(collection) ) return collection.map((value, index) => ({key: String(index), value}));
  if ( collection instanceof Map ) return [...collection.entries()].map(([key, value]) => ({key: String(key), value}));
  if ( collection instanceof Set ) return [...collection.values()].map((value, index) => ({key: String(index), value}));
  if ( typeof collection === "object" ) return Object.entries(collection).map(([key, value]) => ({key, value}));
  return [];
}

function providerReference(provider) {
  return {
    id: provider.id,
    type: provider.type ?? provider.providerType ?? ROLL_PROVENANCE_TYPES.UNKNOWN,
    label: provider.label ?? provider.name ?? null
  };
}

function providerFailure(provider, code, reason, data={}) {
  return {
    ok: false,
    status: code === ROLL_CODES.ROLL_CANCELLED ? ROLL_PROVIDER_OUTCOMES.CANCELLED : ROLL_PROVIDER_OUTCOMES.FAILURE,
    code,
    reason,
    provider: provider ? providerReference(provider) : null,
    ...clonePlain(data)
  };
}

function selectionFailure(code, reason, data={}) {
  return {
    ok: false,
    code,
    reason,
    ...clonePlain(data)
  };
}

function normalizeArray(value) {
  if ( value == null ) return [];
  return Array.isArray(value) ? value : [value];
}

function stringOrNull(value) {
  if ( value == null ) return null;
  const string = String(value).trim();
  return string ? string : null;
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
