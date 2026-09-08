import type {PromptViewModel} from "../types/contracts.js";
import {clonePromptData, PROMPT_CONTROL_TYPES} from "../helpers/prompt-view-models.mjs";

/** Form input selects an offered identity; only the request supplies its semantic value. */
export function reactionChoiceValueFromForm(viewModel: PromptViewModel, response: unknown): unknown {
  const control = viewModel.controls[0];
  if ( viewModel.controls.length !== 1 || control?.type !== PROMPT_CONTROL_TYPES.SELECT_ONE ) {
    throw new Error("Reaction prompt requires one select-one control with offered reaction options.");
  }
  const name = `choice:${control.choiceId ?? control.id}`;
  let selected: unknown;
  if ( typeof response === "object" && response !== null ) {
    if ( "get" in response && typeof response.get === "function" ) selected = response.get(name);
    else if ( Object.hasOwn(response, name) ) selected = Reflect.get(response, name);
  }
  const options = control.options.filter(option => typeof selected === "string" && option.id === selected);
  const option = options[0];
  if ( options.length !== 1 || option?.value == null ) {
    throw new Error("Select an offered reaction option before submitting the prompt.");
  }
  return clonePromptData(option.value, "reaction.option.value");
}
