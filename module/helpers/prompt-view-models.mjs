import {ACTION_CHOICE_TYPES} from "./action-configuration.mjs";
import {RESOLUTION_REQUEST_TYPES} from "./resolution-state.mjs";
import {ROLL_INPUT_MODES, rollFormulaForRequest} from "./rolls.mjs";

export const PROMPT_VIEW_SCHEMA_VERSION = 1;

export const PROMPT_VIEW_TYPES = Object.freeze({
  ACTION_CONFIGURATION: RESOLUTION_REQUEST_TYPES.ACTION_CONFIGURATION,
  TARGET_SELECTION: RESOLUTION_REQUEST_TYPES.TARGET_SELECTION,
  TARGET_REFINEMENT: RESOLUTION_REQUEST_TYPES.TARGET_REFINEMENT,
  ROLL: RESOLUTION_REQUEST_TYPES.ROLL,
  REACTION_CHOICE: RESOLUTION_REQUEST_TYPES.REACTION_CHOICE,
  CHOICE: RESOLUTION_REQUEST_TYPES.CHOICE
});

export const PROMPT_CONTROL_TYPES = Object.freeze({
  SELECT_ONE: "select-one",
  SELECT_MANY: "select-many",
  BOOLEAN: "boolean",
  NUMBER: "number",
  RESOURCE: "resource",
  DAMAGE_TYPE: "damage-type",
  ROLL_NATURAL: "roll-natural",
  ROLL_TOTAL: "roll-total",
  TARGET_LIST: "target-list",
  GENERIC: "generic"
});

/* -------------------------------------------- */

export function createPromptViewModel(request, {state=null, metadata={}}={}) {
  const normalized = clonePromptData(request, "request") ?? {};
  const payload = normalized.payload ?? {};
  const base = {
    schemaVersion: PROMPT_VIEW_SCHEMA_VERSION,
    id: `prompt-view:${normalized.resolutionId ?? "resolution"}:${normalized.id ?? "request"}`,
    resolutionId: normalized.resolutionId ?? state?.id ?? null,
    requestId: normalized.id ?? null,
    requestType: normalized.type ?? RESOLUTION_REQUEST_TYPES.CHOICE,
    expectedResponseType: normalized.expectedResponseType ?? null,
    title: promptTitle(normalized),
    required: requestRequired(normalized),
    chooser: clonePromptData(normalized.chooser ?? null, "chooser"),
    authority: clonePromptData(normalized.authority ?? null, "authority"),
    controls: [],
    payload: clonePromptData(payload, "payload") ?? {},
    metadata: {
      ...(clonePromptData(normalized.metadata ?? {}, "request.metadata") ?? {}),
      ...(clonePromptData(metadata, "metadata") ?? {})
    }
  };

  switch ( base.requestType ) {
    case RESOLUTION_REQUEST_TYPES.ACTION_CONFIGURATION:
      return {
        ...base,
        controls: actionConfigurationControls(payload.requests ?? payload.choices ?? []),
        traces: clonePromptData(payload.traces ?? [], "payload.traces") ?? [],
        preview: clonePromptData(payload.preview ?? null, "payload.preview")
      };
    case RESOLUTION_REQUEST_TYPES.ROLL:
      return {
        ...base,
        controls: [rollControl(payload.rollRequest ?? payload.inputRequest ?? payload)],
        rollRequest: clonePromptData(payload.rollRequest ?? null, "payload.rollRequest"),
        inputRequest: clonePromptData(payload.inputRequest ?? null, "payload.inputRequest")
      };
    case RESOLUTION_REQUEST_TYPES.TARGET_SELECTION:
    case RESOLUTION_REQUEST_TYPES.TARGET_REFINEMENT:
      return {
        ...base,
        controls: [targetListControl(payload, base.requestType)],
        targetSet: clonePromptData(payload.targetSet ?? null, "payload.targetSet"),
        targeting: clonePromptData(payload.targeting ?? null, "payload.targeting")
      };
    case RESOLUTION_REQUEST_TYPES.REACTION_CHOICE:
    case RESOLUTION_REQUEST_TYPES.CHOICE:
    default:
      return {
        ...base,
        controls: genericControls(payload)
      };
  }
}

/* -------------------------------------------- */

function actionConfigurationControls(requests) {
  return normalizeArray(requests).map(choice => ({
    id: String(choice.id ?? "choice"),
    choiceId: String(choice.id ?? "choice"),
    type: promptControlType(choice.type),
    choiceType: choice.type ?? ACTION_CHOICE_TYPES.OPTION,
    label: stringOrDefault(choice.label, labelFromId(choice.id ?? "choice")),
    description: stringOrNull(choice.description),
    required: choice.required === true,
    min: clonePromptData(choice.min ?? null, "choice.min"),
    max: clonePromptData(choice.max ?? null, "choice.max"),
    defaultValue: clonePromptData(choice.defaultValue ?? null, "choice.defaultValue"),
    options: choiceOptions(choice.options ?? []),
    payment: clonePromptData(choice.payment ?? null, "choice.payment"),
    source: clonePromptData(choice.source ?? null, "choice.source"),
    stateFingerprint: stringOrNull(choice.stateFingerprint),
    metadata: clonePromptData(choice.metadata ?? {}, "choice.metadata") ?? {}
  }));
}

function choiceOptions(options) {
  return normalizeArray(options).map((option, index) => ({
    id: String(option?.id ?? option?.value ?? `option:${index}`),
    label: stringOrDefault(option?.label ?? option?.name ?? option?.value, labelFromId(option?.id ?? `option:${index}`)),
    value: clonePromptData(option?.value ?? option?.id ?? null, "option.value"),
    source: clonePromptData(option?.source ?? null, "option.source"),
    paymentOptionId: option?.paymentOptionId ?? null,
    resources: clonePromptData(option?.resources ?? [], "option.resources") ?? [],
    paymentPlan: clonePromptData(option?.paymentPlan ?? null, "option.paymentPlan"),
    metadata: clonePromptData(option?.metadata ?? {}, "option.metadata") ?? {}
  }));
}

function rollControl(rollRequest) {
  const request = clonePromptData(rollRequest ?? {}, "rollRequest") ?? {};
  const expected = request.expected ?? {};
  const inputMode = expected.manualInputMode ?? expected.inputMode ?? ROLL_INPUT_MODES.TOTAL;
  const faces = finiteNumber(expected.primaryDieFaces ?? expected.faces);
  const formula = formulaForRollRequest(request);
  const natural = inputMode === ROLL_INPUT_MODES.NATURAL || expected.requireNatural === true;
  return {
    id: "roll",
    type: natural ? PROMPT_CONTROL_TYPES.ROLL_NATURAL : PROMPT_CONTROL_TYPES.ROLL_TOTAL,
    label: natural ? "Natural Roll" : "Roll Total",
    description: null,
    required: true,
    inputMode,
    min: natural && faces ? 1 : null,
    max: natural && faces ? faces : null,
    expectedFaces: faces ?? null,
    requireNatural: expected.requireNatural === true,
    formula,
    modifierTotal: finiteNumber(expected.modifierTotal ?? request.definition?.modifierTotal),
    rollMode: request.rollMode ?? null,
    dc: clonePromptData(request.dc ?? null, "rollRequest.dc"),
    options: [],
    metadata: {
      ...(clonePromptData(request.metadata ?? {}, "rollRequest.metadata") ?? {}),
      rollRequestId: request.id ?? null,
      semanticType: request.type ?? null
    }
  };
}

function targetListControl(payload, requestType) {
  const candidates = targetCandidatesFromPayload(payload);
  const selected = new Set(normalizeArray(payload.targeting?.decisions)
    .filter(decision => ["select", "include"].includes(decision?.operation))
    .map(decision => String(decision.targetId)));
  return {
    id: "targets",
    type: PROMPT_CONTROL_TYPES.TARGET_LIST,
    label: requestType === RESOLUTION_REQUEST_TYPES.TARGET_REFINEMENT ? "Target Refinement" : "Targets",
    description: null,
    required: payload.validation?.required === true || payload.targeting?.required === true,
    min: payload.targeting?.refinementPolicy?.minSelections ?? payload.targeting?.refinementPolicy?.minChoices ?? null,
    max: payload.targeting?.refinementPolicy?.maxSelections ?? payload.targeting?.refinementPolicy?.maxChoices ?? null,
    options: candidates.map((candidate, index) => ({
      id: String(candidate.id ?? candidate.targetId ?? candidate.target?.id ?? `target:${index}`),
      label: stringOrDefault(candidate.label ?? candidate.name ?? candidate.target?.name ?? candidate.id, `Target ${index + 1}`),
      value: clonePromptData(candidate.target ?? candidate, "target.value"),
      selected: candidate.selected === true || selected.has(String(candidate.id ?? candidate.targetId ?? "")),
      selectable: candidate.selectable !== false && candidate.eligible !== false && candidate.eligibility?.ok !== false,
      eligible: candidate.eligible !== false && candidate.eligibility?.ok !== false,
      metadata: clonePromptData(candidate.metadata ?? {}, "target.metadata") ?? {}
    })),
    metadata: clonePromptData(payload.metadata ?? {}, "target.metadata") ?? {}
  };
}

function genericControls(payload) {
  const choices = payload.requests ?? payload.choices;
  if ( choices ) return actionConfigurationControls(choices);
  if ( payload.options ) return [{
    id: String(payload.id ?? "choice"),
    choiceId: String(payload.id ?? "choice"),
    type: promptControlType(payload.type ?? payload.choiceType ?? ACTION_CHOICE_TYPES.OPTION),
    choiceType: payload.type ?? payload.choiceType ?? ACTION_CHOICE_TYPES.OPTION,
    label: stringOrDefault(payload.label, labelFromId(payload.id ?? "choice")),
    description: stringOrNull(payload.description),
    required: payload.required === true,
    min: clonePromptData(payload.min ?? null, "payload.min"),
    max: clonePromptData(payload.max ?? null, "payload.max"),
    defaultValue: clonePromptData(payload.defaultValue ?? null, "payload.defaultValue"),
    options: choiceOptions(payload.options),
    metadata: clonePromptData(payload.metadata ?? {}, "payload.metadata") ?? {}
  }];
  return [{
    id: "value",
    type: PROMPT_CONTROL_TYPES.GENERIC,
    label: stringOrDefault(payload.label, "Choice"),
    description: stringOrNull(payload.description),
    required: payload.required === true,
    options: [],
    metadata: clonePromptData(payload.metadata ?? {}, "payload.metadata") ?? {}
  }];
}

function promptControlType(type) {
  switch ( type ) {
    case ACTION_CHOICE_TYPES.SELECT_ONE:
      return PROMPT_CONTROL_TYPES.SELECT_ONE;
    case ACTION_CHOICE_TYPES.SELECT_MANY:
      return PROMPT_CONTROL_TYPES.SELECT_MANY;
    case ACTION_CHOICE_TYPES.BOOLEAN:
      return PROMPT_CONTROL_TYPES.BOOLEAN;
    case ACTION_CHOICE_TYPES.NUMBER:
      return PROMPT_CONTROL_TYPES.NUMBER;
    case ACTION_CHOICE_TYPES.RESOURCE:
      return PROMPT_CONTROL_TYPES.RESOURCE;
    case ACTION_CHOICE_TYPES.DAMAGE_TYPE:
      return PROMPT_CONTROL_TYPES.DAMAGE_TYPE;
    case ACTION_CHOICE_TYPES.OPTION:
    default:
      return PROMPT_CONTROL_TYPES.SELECT_ONE;
  }
}

function targetCandidatesFromPayload(payload) {
  return normalizeArray(
    payload.selectionRequest?.candidates
      ?? payload.targetSelectionRequest?.candidates
      ?? payload.targetSet?.candidates
      ?? payload.candidates
      ?? payload.targets
      ?? []
  );
}

function formulaForRollRequest(request) {
  try {
    const result = rollFormulaForRequest(request);
    return result.ok ? result.formula : request.formula ?? null;
  } catch {
    return request.formula ?? null;
  }
}

function promptTitle(request) {
  const payload = request.payload ?? {};
  return stringOrDefault(
    request.metadata?.title
      ?? payload.title
      ?? payload.label
      ?? payload.actionLabel
      ?? request.expectedResponseType
      ?? request.type,
    "WildPath Prompt"
  );
}

function requestRequired(request) {
  if ( request.validation?.required === false ) return false;
  if ( request.validation?.required === true ) return true;
  if ( normalizeArray(request.validation?.missingRequiredChoiceIds).length ) return true;
  if ( request.type === RESOLUTION_REQUEST_TYPES.ROLL ) return true;
  if ( request.type === RESOLUTION_REQUEST_TYPES.ACTION_CONFIGURATION ) return true;
  return request.metadata?.required === true;
}

export function clonePromptData(value, path="promptData") {
  if ( value == null ) return value;
  const failure = firstNonSerializable(value, path, new WeakSet());
  if ( failure ) throw new TypeError(failure.reason);
  return JSON.parse(JSON.stringify(value));
}

function firstNonSerializable(value, path, seen) {
  if ( value == null ) return null;
  const type = typeof value;
  if ( type === "string" || type === "boolean" ) return null;
  if ( type === "number" ) return Number.isFinite(value)
    ? null
    : {path, reason: `${path} must contain only finite numbers.`};
  if ( type === "function" || type === "symbol" || type === "bigint" || type === "undefined" ) {
    return {path, reason: `${path} must be plain serializable data, not ${type}.`};
  }
  if ( seen.has(value) ) return {path, reason: `${path} must not contain circular references.`};
  seen.add(value);
  if ( Array.isArray(value) ) {
    for ( const [index, entry] of value.entries() ) {
      const failure = firstNonSerializable(entry, `${path}.${index}`, seen);
      if ( failure ) return failure;
    }
    seen.delete(value);
    return null;
  }
  if ( !isPlainObject(value) ) {
    seen.delete(value);
    return {path, reason: `${path} must be plain serializable data.`};
  }
  for ( const [key, entry] of Object.entries(value) ) {
    const failure = firstNonSerializable(entry, `${path}.${key}`, seen);
    if ( failure ) return failure;
  }
  seen.delete(value);
  return null;
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

function stringOrDefault(value, fallback) {
  return stringOrNull(value) ?? fallback;
}

function finiteNumber(value) {
  if ( value == null || value === "" ) return null;
  if ( typeof value === "object" || typeof value === "function" || typeof value === "boolean" ) return null;
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

function isPlainObject(value) {
  return typeof value === "object"
    && value !== null
    && Object.getPrototypeOf(value) === Object.prototype;
}
