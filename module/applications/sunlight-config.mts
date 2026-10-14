/**
 * A "Sunlight" checkbox (`flags.wildpath.sunlight`) on the Scene, Ambient Light and Token config sheets: a sunlit
 * Scene (daytime outdoors), or a light that is sunlight (a Daylight spell, a sunbeam). See foundry-v14-sunlight.mts.
 */

interface SunlitDocument {flags?: {wildpath?: {sunlight?: boolean}}}
interface ConfigApp {document?: SunlitDocument; token?: SunlitDocument}
interface Sheet {hook: string; tab: string; hint: string}

const LIGHT_HINT = "WILDPATH.SUNLIGHT.LightHint";
const SHEETS: readonly Sheet[] = [
  {hook: "renderSceneConfig", tab: "environment", hint: "WILDPATH.SUNLIGHT.SceneHint"},
  {hook: "renderAmbientLightConfig", tab: "basic", hint: LIGHT_HINT},
  {hook: "renderTokenConfig", tab: "light", hint: LIGHT_HINT},
  {hook: "renderPrototypeTokenConfig", tab: "light", hint: LIGHT_HINT}
];

const localize = (key: string) => (globalThis as {game?: {i18n?: {localize(key: string): string}}}).game?.i18n?.localize(key) ?? key;

/** Add the checkbox to its tab, once per render; the sheet's own form submits it with the rest. */
function addSunlightField(app: ConfigApp, element: HTMLElement, {tab, hint}: Sheet) {
  const panel = element.querySelector(`.tab[data-tab="${tab}"]`);
  if ( !panel || panel.querySelector('[name="flags.wildpath.sunlight"]') ) return;
  // A prototype Token's sheet edits `app.token`.
  const checked = (app.document ?? app.token)?.flags?.wildpath?.sunlight === true;
  const group = globalThis.document.createElement("div");
  group.className = "form-group";
  group.innerHTML = `<label>${localize("WILDPATH.SUNLIGHT.Label")}</label>
    <div class="form-fields"><input type="checkbox" name="flags.wildpath.sunlight"${checked ? " checked" : ""}></div>
    <p class="hint">${localize(hint)}</p>`;
  panel.append(group);
}

export function registerSunlightConfig() {
  const hooks = (globalThis as {Hooks?: {on(hook: string, fn: (app: ConfigApp, element: HTMLElement) => void): number}}).Hooks;
  for ( const sheet of SHEETS ) hooks?.on(sheet.hook, (app, element) => addSunlightField(app, element, sheet));
}
