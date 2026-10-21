import {ACTION_CHOICE_TYPES, createResolvedActionPreview, discoverActionConfigurationChoices} from "../helpers/action-configuration.mjs";
import {RESOLUTION_REQUEST_TYPES} from "../helpers/resolution-state.mjs";
import {formatFormula} from "../helpers/formula.mjs";
import {selectTableRows} from "../helpers/value-expressions.mjs";
import {reactionChoiceValueFromForm} from "./foundry-v14-reaction-choice-adapter.mjs";
import {
  PROMPT_CONTROL_TYPES,
  clonePromptData,
  createPromptViewModel
} from "../helpers/prompt-view-models.mjs";
import {
  CHOICE_COORDINATOR_CODES,
  PROMPT_PORT_OUTCOMES
} from "../resolvers/choice-coordinator.mjs";

/** Prompts open on this client, by resolution and request, so one the GM took over can be withdrawn. */
const openPrompts = new Map();
const promptKey = (resolutionId, requestId) => `${resolutionId ?? ""}|${requestId ?? ""}`;

/** Close this client's open prompt for a request (the GM answered it instead); its answer is then a cancel. */
export function closeFoundryPrompt({resolutionId=null, requestId=null}={}) {
  const dialog = openPrompts.get(promptKey(resolutionId, requestId));
  if ( !dialog ) return false;
  void dialog.close?.();
  return true;
}

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
      const shown = localizeViewModel(viewModel);
      const key = promptKey(request.resolutionId, request.id);
      const response = await Dialog.input({
        render: (_event, dialog) => openPrompts.set(key, dialog),
        window: {
          title: shown.title
        },
        content: renderPromptContent(shown),
        ok: {
          label: localize("WILDPATH.PROMPT.Confirm")
        },
        rejectClose: false,
        modal: true,
        ...dialogOptions,
        ...(context.dialogOptions ?? {})
      }).finally(() => openPrompts.delete(key));
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
    },
    /**
     * Several saves this client rolls for one Action (the GM's monsters), in one window: a row per creature with its
     * formula. Each row's value is what was typed, or null when left empty (rolled for them). Null when closed.
     */
    async requestBatch(requests, context={}) {
      const Dialog = resolveDialogV2({DialogV2, context});
      if ( !Dialog?.input ) return null;
      const rows = requests.map(request => {
        const viewModel = createPromptViewModel(request, context);
        return {request, viewModel, control: localizeViewModel(viewModel).controls[0] ?? {}};
      });
      const response = await Dialog.input({
        window: {title: localize("WILDPATH.PROMPT.Batch.Title")},
        content: renderBatchContent(rows),
        ok: {label: localize("WILDPATH.PROMPT.Batch.RollRest")},
        rejectClose: false,
        modal: true,
        ...dialogOptions,
        ...(context.dialogOptions ?? {})
      });
      if ( response == null ) return null;
      return rows.map(({viewModel}, index) => {
        const typed = Object.fromEntries(["natural", "total"].map(name => [name, formValue(response, `${name}-${index}`)])
          .filter(([, value]) => (value != null) && (value !== "")));
        return Object.keys(typed).length ? rollValueFromForm(viewModel, typed) : null;
      });
    }
  };
}

/** The batch window: a hint, then one row per save, its creature and formula, with the die (and total) to type. */
function renderBatchContent(rows) {
  const bounds = (min, max) => `${min == null ? "" : ` min="${escapeHtml(min)}"`}${max == null ? "" : ` max="${escapeHtml(max)}"`}`;
  const row = ({request, control}, index) => {
    const target = request.payload?.targets?.[0] ?? {};
    const who = target.name ?? target.target?.name ?? localize("WILDPATH.PROMPT.TargetNumber", {number: index + 1});
    const name = control.type === PROMPT_CONTROL_TYPES.ROLL_NATURAL ? "natural" : "total";
    const total = control.total ? `<input name="total-${index}" type="number" step="1"${bounds(control.total.min, control.total.max)}
      aria-label="${escapeHtml(control.total.label)}" placeholder="${escapeHtml(control.total.label)}">` : "";
    return `
      <div class="form-group">
        <label for="wildpath-batch-${index}">${escapeHtml(who)}</label>
        <div class="form-fields">
          <input id="wildpath-batch-${index}" name="${name}-${index}" type="number" step="1"${bounds(control.min, control.max)}>${total}
        </div>
        <p class="hint">${escapeHtml(control.label)}</p>
      </div>`;
  };
  return `
    <section class="wildpath-prompt wildpath-batch-saves">
      <p class="hint">${escapeHtml(localize("WILDPATH.PROMPT.Batch.Hint"))}</p>
      ${rows.map(row).join("")}
    </section>
  `;
}

/* -------------------------------------------- */

/**
 * Ask the user for an Action's choices before it is used (a spell slot, a damage type), with a live preview of what
 * the choices make: what it spends, its damage dice and its save. The same controls as the authority's own
 * configuration prompt, so the answer is the same `{choices}`; the authority still checks everything.
 * @returns {Promise<object|null|undefined>} the choices, null when cancelled, undefined when the Action asks nothing.
 */
export async function promptActionConfiguration({definition, actorSystem, name=null, DialogV2=null}={}) {
  const discovery = discoverActionConfigurationChoices({definition, actorSystem});
  if ( !discovery.ok || !discovery.requests?.length ) return undefined;
  const Dialog = resolveDialogV2({DialogV2, context: {}});
  if ( !Dialog?.input ) return undefined;
  const viewModel = createPromptViewModel({id: "configuration", resolutionId: "use", type: RESOLUTION_REQUEST_TYPES.ACTION_CONFIGURATION,
    payload: {requests: discovery.requests}});
  const shown = localizeViewModel(viewModel);
  const FormData = globalThis.foundry?.applications?.ux?.FormDataExtended;
  const refresh = form => {
    const box = form?.querySelector(".wildpath-configuration-preview");
    if ( !box || !FormData ) return;
    const choices = actionConfigurationChoicesFromForm(viewModel, new FormData(form).object);
    box.innerHTML = renderConfigurationPreview({definition, actorSystem, choices});
  };
  const response = await Dialog.input({
    window: {title: localize("WILDPATH.PROMPT.Configure.Title", {name: name ?? definition.label ?? ""})},
    content: `${renderPromptContent(shown)}<section class="wildpath-configuration-preview" aria-live="polite"></section>`,
    ok: {label: localize("WILDPATH.PROMPT.Confirm")},
    render: (_event, dialog) => {
      const form = dialog.element?.querySelector("form") ?? dialog.form ?? null;
      form?.addEventListener("change", () => refresh(form));
      refresh(form);
    },
    rejectClose: false,
    modal: true
  });
  return response == null ? null : actionConfigurationChoicesFromForm(viewModel, response);
}

/** What the chosen configuration makes, in a few plain lines. */
export function renderConfigurationPreview({definition, actorSystem, choices}) {
  const result = createResolvedActionPreview({definition, actorSystem, choices});
  if ( !result.ok ) return `<p class="notes">${escapeHtml(localize("WILDPATH.PROMPT.Configure.Invalid"))}</p>`;
  const preview = result.preview ?? {};
  const pools = new Map((actorSystem?.pools ?? []).map(pool => [pool.id, pool.label ?? pool.id]));
  // The configured types (a Breath Weapon's chosen fire), and each formula at the creature's own levels ("2d10", not a table).
  const typeOf = new Map((preview.damageTypes ?? []).map(entry => [entry.componentId, entry.damageType ?? ""]));
  const shown = entry => formatFormula(selectTableRows(entry.expression, {actorSystem})) ?? entry.formula;
  const lines = [];
  // A built-in resource ("economy.action") reads as its own label ("Action"); a pool as its name.
  const labelOf = id => pools.get(id) ?? localize(globalThis.CONFIG?.WILDPATH?.RESOURCES?.[String(id).replace(/^economy\./, "")
    .replace("bonus-action", "bonus")]?.label ?? id);
  const spends = (preview.costs?.payment?.selectedPaymentPlan?.resources ?? [])
    .map(resource => `${labelOf(resource.resourceId)}${resource.amount > 1 ? ` ×${resource.amount}` : ""}`);
  if ( spends.length ) lines.push([localize("WILDPATH.PROMPT.Configure.Spends"), spends.join(", ")]);
  const damage = (preview.damageExpressions ?? []).map(entry => `${shown(entry)} ${typeOf.get(entry.componentId) ?? ""}`.trim());
  if ( damage.length ) lines.push([localize("WILDPATH.PROMPT.Configure.Damage"), damage.join(" + ")]);
  const healing = (preview.healing?.components ?? []).map(entry => (entry.expression ? shown(entry) : entry.formula)).filter(Boolean);
  if ( healing.length ) lines.push([localize("WILDPATH.PROMPT.Configure.Healing"), healing.join(" + ")]);
  const dc = definition.save?.dc?.value;
  if ( definition.save ) {
    const ability = localize(globalThis.CONFIG?.WILDPATH?.ABILITIES?.[definition.save.ability]?.label ?? definition.save.ability ?? "");
    lines.push([localize("WILDPATH.PROMPT.Configure.Save"), (dc != null) ? localize("WILDPATH.PROMPT.Configure.SaveDC", {ability, dc}) : ability]);
  }
  return `<dl>${lines.map(([label, text]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(text)}</dd>`).join("")}</dl>`;
}

/* -------------------------------------------- */

/**
 * View models carry `WILDPATH.*` keys (plus `labelData`) for the system's own copy; author-written labels
 * pass through `localize` unchanged. Parsing still reads ids from the unlocalized view model.
 */
function localizeViewModel(viewModel) {
  const text = entry => ({...entry, label: localize(entry.label, entry.labelData)});
  return {
    ...viewModel,
    title: localize(viewModel.title, viewModel.titleData),
    controls: viewModel.controls.map(control => ({...text(control), options: (control.options ?? []).map(text)}))
  };
}

function localize(key, data=null) {
  const i18n = globalThis.game?.i18n;
  if ( typeof key !== "string" || !i18n ) return key;
  return data ? i18n.format(key, data) : i18n.localize(key);
}

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
  // Its defaults ticked (Careful Spell's allies).
  const ticked = new Set((Array.isArray(control.defaultValue) ? control.defaultValue : []).map(String));
  const options = control.options.map(option => `
    <label class="checkbox">
      <input type="checkbox" name="choice:${escapeHtml(control.choiceId ?? control.id)}" value="${escapeHtml(option.id)}"${ticked.has(String(option.id)) ? " checked" : ""}>
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
        <option value="true"${control.defaultValue === true ? " selected" : ""}>${escapeHtml(localize("WILDPATH.PROMPT.Yes"))}</option>
        <option value="false"${control.defaultValue === false ? " selected" : ""}>${escapeHtml(localize("WILDPATH.PROMPT.No"))}</option>
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
  // With bonus dice (Bless), the total of every die as well.
  const total = control.total ? `
    <div class="form-group">
      <label for="wildpath-roll-total">${escapeHtml(control.total.label)}</label>
      <input id="wildpath-roll-total" name="total" type="number" step="1"${control.total.min == null ? "" : ` min="${escapeHtml(control.total.min)}"`}${control.total.max == null ? "" : ` max="${escapeHtml(control.total.max)}"`} required>
    </div>` : "";
  return `
    <div class="form-group">
      <label for="wildpath-roll">${escapeHtml(control.label)}</label>
      <input id="wildpath-roll" name="${name}" type="number" step="1"${min}${max} required autofocus>
    </div>${total}
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
  if ( viewModel.requestType === RESOLUTION_REQUEST_TYPES.REACTION_CHOICE ) {
    return reactionChoiceValueFromForm(viewModel, response);
  }
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
  // Several picks (Careful Spell's creatures): every ticked one.
  if ( control.choiceId && (control.type === PROMPT_CONTROL_TYPES.SELECT_MANY) ) return {
    choices: {[control.choiceId]: formValues(response, `choice:${control.choiceId}`)}
  };
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
