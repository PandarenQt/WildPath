import {ACTION_CHOICE_TYPES} from "../helpers/action-configuration.mjs";
import {RESOLUTION_REQUEST_TYPES} from "../helpers/resolution-state.mjs";
import {
  PROMPT_CONTROL_TYPES,
  clonePromptData,
  createPromptViewModel
} from "../helpers/prompt-view-models.mjs";
import {
  CHOICE_COORDINATOR_CODES,
  PROMPT_PORT_OUTCOMES
} from "../resolvers/choice-coordinator.mjs";

export function createFoundryV14PromptAdapter({
  id="foundry-v14-prompt",
  label="Foundry V14 Prompt Adapter",
  DialogV2=null,
  dialogOptions={}
}={}) {
  return {
    id,
    type: "foundry-v14",
    label,
    canHandle(request, context={}) {
      return !!resolveDialogV2({DialogV2, context}) && canAnswerLocally(request, context);
    },
    async request(request, context={}) {
      const Dialog = resolveDialogV2({DialogV2, context});
      if ( !Dialog?.input ) return promptFailure({
        id,
        request,
        code: CHOICE_COORDINATOR_CODES.NO_PROMPT_PORT_AVAILABLE,
        reason: "Foundry DialogV2.input is not available."
      });
      if ( !canAnswerLocally(request, context) ) return promptFailure({
        id,
        request,
        status: PROMPT_PORT_OUTCOMES.UNHANDLED,
        code: CHOICE_COORDINATOR_CODES.REMOTE_AUTHORITY_REQUIRED,
        reason: "Prompt authority is not local to this Foundry client."
      });

      const viewModel = createPromptViewModel(request, context);
      const response = await Dialog.input({
        window: {
          title: viewModel.title
        },
        content: renderPromptContent(viewModel),
        ok: {
          label: "Submit"
        },
        rejectClose: false,
        modal: true,
        ...dialogOptions,
        ...(context.dialogOptions ?? {})
      });
      if ( response == null ) return {
        ok: false,
        status: PROMPT_PORT_OUTCOMES.CANCELLED,
        code: CHOICE_COORDINATOR_CODES.PROMPT_CANCELLED,
        reason: "Prompt was cancelled.",
        requestId: request.id,
        resolutionId: request.resolutionId,
        type: request.type,
        responseType: request.expectedResponseType,
        metadata: {adapterId: id}
      };
      return {
        ok: true,
        status: PROMPT_PORT_OUTCOMES.RESPONSE,
        code: CHOICE_COORDINATOR_CODES.OK,
        requestId: request.id,
        resolutionId: request.resolutionId,
        type: request.type,
        responseType: request.expectedResponseType,
        value: valueFromDialogResponse(viewModel, response),
        metadata: {
          adapterId: id
        }
      };
    }
  };
}

/* -------------------------------------------- */

function renderPromptContent(viewModel) {
  const controls = viewModel.controls.map(renderControl).join("");
  return `
    <section class="wildpath-prompt" data-resolution-id="${escapeHtml(viewModel.resolutionId)}" data-request-id="${escapeHtml(viewModel.requestId)}">
      ${controls}
    </section>
  `;
}

function renderControl(control) {
  switch ( control.type ) {
    case PROMPT_CONTROL_TYPES.BOOLEAN:
      return renderBooleanControl(control);
    case PROMPT_CONTROL_TYPES.NUMBER:
      return renderNumberControl(control);
    case PROMPT_CONTROL_TYPES.SELECT_MANY:
      return renderSelectManyControl(control);
    case PROMPT_CONTROL_TYPES.RESOURCE:
    case PROMPT_CONTROL_TYPES.DAMAGE_TYPE:
    case PROMPT_CONTROL_TYPES.SELECT_ONE:
      return renderSelectOneControl(control);
    case PROMPT_CONTROL_TYPES.ROLL_NATURAL:
    case PROMPT_CONTROL_TYPES.ROLL_TOTAL:
      return renderRollControl(control);
    case PROMPT_CONTROL_TYPES.TARGET_LIST:
      return renderTargetListControl(control);
    case PROMPT_CONTROL_TYPES.GENERIC:
    default:
      return renderGenericControl(control);
  }
}

function renderSelectOneControl(control) {
  const options = control.options.map(option => {
    const selected = valuesEqual(control.defaultValue, option.value) ? " selected" : "";
    return `<option value="${escapeHtml(option.id)}"${selected}>${escapeHtml(option.label)}</option>`;
  }).join("");
  return `
    <div class="form-group">
      <label for="wildpath-${escapeHtml(control.id)}">${escapeHtml(control.label)}</label>
      <select id="wildpath-${escapeHtml(control.id)}" name="choice:${escapeHtml(control.choiceId ?? control.id)}"${control.required ? " required" : ""}>
        ${options}
      </select>
    </div>
  `;
}

function renderSelectManyControl(control) {
  const options = control.options.map(option => `
    <label class="checkbox">
      <input type="checkbox" name="choice:${escapeHtml(control.choiceId ?? control.id)}" value="${escapeHtml(option.id)}">
      <span>${escapeHtml(option.label)}</span>
    </label>
  `).join("");
  return `
    <fieldset class="form-group">
      <legend>${escapeHtml(control.label)}</legend>
      ${options}
    </fieldset>
  `;
}

function renderBooleanControl(control) {
  return `
    <div class="form-group">
      <label for="wildpath-${escapeHtml(control.id)}">${escapeHtml(control.label)}</label>
      <select id="wildpath-${escapeHtml(control.id)}" name="choice:${escapeHtml(control.choiceId ?? control.id)}"${control.required ? " required" : ""}>
        <option value="true"${control.defaultValue === true ? " selected" : ""}>Yes</option>
        <option value="false"${control.defaultValue === false ? " selected" : ""}>No</option>
      </select>
    </div>
  `;
}

function renderNumberControl(control) {
  const min = control.min == null ? "" : ` min="${escapeHtml(control.min)}"`;
  const max = control.max == null ? "" : ` max="${escapeHtml(control.max)}"`;
  const value = control.defaultValue == null ? "" : ` value="${escapeHtml(control.defaultValue)}"`;
  return `
    <div class="form-group">
      <label for="wildpath-${escapeHtml(control.id)}">${escapeHtml(control.label)}</label>
      <input id="wildpath-${escapeHtml(control.id)}" name="choice:${escapeHtml(control.choiceId ?? control.id)}" type="number"${min}${max}${value}${control.required ? " required" : ""}>
    </div>
  `;
}

function renderRollControl(control) {
  const name = control.type === PROMPT_CONTROL_TYPES.ROLL_NATURAL ? "natural" : "total";
  const min = control.min == null ? "" : ` min="${escapeHtml(control.min)}"`;
  const max = control.max == null ? "" : ` max="${escapeHtml(control.max)}"`;
  return `
    <div class="form-group">
      <label for="wildpath-roll">${escapeHtml(control.label)}</label>
      <input id="wildpath-roll" name="${name}" type="number" step="1"${min}${max} required autofocus>
    </div>
  `;
}

function renderTargetListControl(control) {
  const options = control.options.map(option => `
    <label class="checkbox">
      <input type="checkbox" name="targetIds" value="${escapeHtml(option.id)}"${option.selected ? " checked" : ""}${option.selectable ? "" : " disabled"}>
      <span>${escapeHtml(option.label)}</span>
    </label>
  `).join("");
  return `
    <fieldset class="form-group">
      <legend>${escapeHtml(control.label)}</legend>
      ${options}
    </fieldset>
  `;
}

function renderGenericControl(control) {
  return `
    <div class="form-group">
      <label for="wildpath-value">${escapeHtml(control.label)}</label>
      <input id="wildpath-value" name="value" type="text"${control.required ? " required" : ""}>
    </div>
  `;
}

/* -------------------------------------------- */

function valueFromDialogResponse(viewModel, response) {
  if ( viewModel.requestType === RESOLUTION_REQUEST_TYPES.ACTION_CONFIGURATION ) {
    return {choices: actionConfigurationChoicesFromForm(viewModel, response)};
  }
  if ( viewModel.requestType === RESOLUTION_REQUEST_TYPES.ROLL ) {
    return rollValueFromForm(viewModel, response);
  }
  if ( viewModel.requestType === RESOLUTION_REQUEST_TYPES.TARGET_SELECTION ) {
    return targetSelectionValueFromForm(viewModel, response);
  }
  if ( viewModel.requestType === RESOLUTION_REQUEST_TYPES.TARGET_REFINEMENT ) {
    return targetRefinementValueFromForm(viewModel, response);
  }
  return genericValueFromForm(viewModel, response);
}

function actionConfigurationChoicesFromForm(viewModel, response) {
  const choices = {};
  for ( const control of viewModel.controls ) {
    const name = `choice:${control.choiceId ?? control.id}`;
    switch ( control.choiceType ) {
      case ACTION_CHOICE_TYPES.BOOLEAN:
        choices[control.choiceId] = formValue(response, name) === "true";
        break;
      case ACTION_CHOICE_TYPES.NUMBER:
        choices[control.choiceId] = Number(formValue(response, name));
        break;
      case ACTION_CHOICE_TYPES.SELECT_MANY:
        choices[control.choiceId] = {values: formValues(response, name)};
        break;
      case ACTION_CHOICE_TYPES.RESOURCE:
        choices[control.choiceId] = {paymentOptionId: formValue(response, name)};
        break;
      case ACTION_CHOICE_TYPES.DAMAGE_TYPE:
        choices[control.choiceId] = {damageType: formValue(response, name)};
        break;
      case ACTION_CHOICE_TYPES.SELECT_ONE:
      case ACTION_CHOICE_TYPES.OPTION:
      default:
        choices[control.choiceId] = {optionId: formValue(response, name)};
        break;
    }
  }
  return choices;
}

function rollValueFromForm(viewModel, response) {
  const control = viewModel.controls[0] ?? {};
  const natural = formValue(response, "natural");
  const total = formValue(response, "total");
  return {
    requestId: viewModel.rollRequest?.id ?? viewModel.requestId,
    resolutionId: viewModel.rollRequest?.resolutionId ?? viewModel.resolutionId,
    type: viewModel.rollRequest?.type ?? null,
    inputMode: control.inputMode ?? null,
    ...(natural != null ? {natural: Number(natural)} : {}),
    ...(total != null ? {total: Number(total)} : {})
  };
}

function targetSelectionValueFromForm(viewModel, response) {
  const control = viewModel.controls[0] ?? {};
  const selected = new Set(formValues(response, "targetIds").map(String));
  const targets = control.options
    .filter(option => selected.has(option.id))
    .map(option => clonePromptData(option.value, "target.value"));
  return {
    targetIds: [...selected],
    targets
  };
}

function targetRefinementValueFromForm(viewModel, response) {
  const control = viewModel.controls[0] ?? {};
  const selected = new Set(formValues(response, "targetIds").map(String));
  const decisions = control.options.flatMap(option => {
    const wasSelected = option.selected === true;
    const isSelected = selected.has(option.id);
    if ( wasSelected === isSelected ) return [];
    return [{
      operation: isSelected ? "select" : "deselect",
      targetId: option.id
    }];
  });
  return {
    decisions,
    targeting: {decisions}
  };
}

function genericValueFromForm(viewModel, response) {
  const control = viewModel.controls[0] ?? {};
  if ( control.choiceId ) return {
    choices: {
      [control.choiceId]: formValue(response, `choice:${control.choiceId}`)
    }
  };
  return formValue(response, "value");
}

function formValue(response, name) {
  if ( response == null ) return null;
  if ( typeof response.get === "function" ) return response.get(name);
  if ( Object.hasOwn(response, name) ) return response[name];
  return null;
}

function formValues(response, name) {
  if ( response == null ) return [];
  if ( typeof response.getAll === "function" ) return response.getAll(name);
  const value = Object.hasOwn(response, name) ? response[name] : null;
  if ( value == null ) return [];
  return Array.isArray(value) ? value : [value];
}

function resolveDialogV2({DialogV2, context}) {
  return DialogV2
    ?? context.DialogV2
    ?? context.foundry?.applications?.api?.DialogV2
    ?? globalThis.foundry?.applications?.api?.DialogV2
    ?? null;
}

function canAnswerLocally(request, context) {
  const currentUser = context.currentUser ?? globalThis.game?.user ?? null;
  const isGM = context.isGM ?? currentUser?.isGM ?? false;
  const authority = request.authority ?? request.chooser ?? request.payload?.rollRequest?.authority ?? request.payload?.rollRequest?.chooser;
  const kind = typeof authority === "string" ? authority : authority?.kind ?? authority?.type ?? null;
  if ( !kind || kind === "automatic" || kind === "local" ) return true;
  if ( uniqueStrings(context.remoteAuthorityKinds ?? []).includes(kind) ) return false;
  if ( kind === "gm" ) return isGM === true;
  if ( kind === "specific" ) {
    const currentRefs = uniqueStrings([context.currentUserId, context.currentUserRef, currentUser?.id, currentUser?.uuid]);
    const expectedRefs = uniqueStrings([
      authority.userId,
      authority.userRef,
      authority.id,
      ...(authority.userIds ?? []),
      ...(authority.userRefs ?? [])
    ]);
    return !expectedRefs.length || expectedRefs.some(ref => currentRefs.includes(ref));
  }
  const localKinds = uniqueStrings(context.localAuthorityKinds ?? context.authorityKinds ?? []);
  if ( context.enforceLocalAuthority === true && !localKinds.length ) return false;
  return !localKinds.length || localKinds.includes(kind);
}

function promptFailure({id, request, status=PROMPT_PORT_OUTCOMES.FAILURE, code, reason}) {
  return {
    ok: false,
    status,
    code,
    reason,
    requestId: request.id,
    resolutionId: request.resolutionId,
    type: request.type,
    responseType: request.expectedResponseType,
    metadata: {adapterId: id}
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function valuesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [values]).filter(value => value != null && value !== "").map(String))];
}
