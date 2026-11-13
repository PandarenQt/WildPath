/**
 * "Water" and "Running water" checkboxes (`flags.wildpath.environment.water`, `.runningWater`) on the Region and Scene
 * config sheets: the tags of a Region's space (a river) or of the whole Scene (underwater), which rule predicates read
 * as `environment.<tag>`. See foundry-v14-environment.mts.
 */

import {checkboxGroup} from "./sunlight-config.mjs";

interface TaggedDocument {flags?: {wildpath?: {environment?: Record<string, unknown> | null}}}
interface ConfigApp {document?: TaggedDocument}

const SHEETS = [{hook: "renderRegionConfig", tab: "appearance"}, {hook: "renderSceneConfig", tab: "environment"}] as const;
const TAGS = [
  {tag: "water", label: "WILDPATH.ENVIRONMENT.Water", hint: "WILDPATH.ENVIRONMENT.WaterHint"},
  {tag: "runningWater", label: "WILDPATH.ENVIRONMENT.RunningWater", hint: "WILDPATH.ENVIRONMENT.RunningWaterHint"}
] as const;

/** Add the checkboxes to its tab, once per render; the sheet's own form submits them with the rest. */
function addEnvironmentFields(app: ConfigApp, element: HTMLElement, tab: string) {
  const panel = element.querySelector(`.tab[data-tab="${tab}"]`);
  if ( !panel || panel.querySelector('[name^="flags.wildpath.environment."]') ) return;
  const tags = app.document?.flags?.wildpath?.environment ?? {};
  for ( const {tag, label, hint} of TAGS ) {
    panel.append(checkboxGroup(`flags.wildpath.environment.${tag}`, tags[tag] === true, label, hint));
  }
  // Running water is water too (environmentContext holds to it whatever is saved); the boxes only show it.
  const water = panel.querySelector<HTMLInputElement>('[name="flags.wildpath.environment.water"]');
  const running = panel.querySelector<HTMLInputElement>('[name="flags.wildpath.environment.runningWater"]');
  running?.addEventListener("change", () => {
    if ( running.checked && water ) water.checked = true;
  });
  water?.addEventListener("change", () => {
    if ( !water.checked && running ) running.checked = false;
  });
}

export function registerEnvironmentConfig() {
  const hooks = (globalThis as {Hooks?: {on(hook: string, fn: (app: ConfigApp, element: HTMLElement) => void): number}}).Hooks;
  for ( const {hook, tab} of SHEETS ) hooks?.on(hook, (app, element) => addEnvironmentFields(app, element, tab));
}
