/**
 * "Water", "Running water" and "Lightly obscured" checkboxes (`flags.wildpath.environment.water`, `.runningWater`,
 * `.lightlyObscured`) on the Region and Scene config sheets: the tags of a Region's space (a river, fog) or of the whole
 * Scene (underwater), which rule predicates read as `environment.<tag>`. See foundry-v14-environment.mts.
 */
import { checkboxGroup } from "./sunlight-config.mjs";
const SHEETS = [{ hook: "renderRegionConfig", tab: "appearance" }, { hook: "renderSceneConfig", tab: "environment" }];
const TAGS = [
    { tag: "water", label: "WILDPATH.ENVIRONMENT.Water", hint: "WILDPATH.ENVIRONMENT.WaterHint" },
    { tag: "runningWater", label: "WILDPATH.ENVIRONMENT.RunningWater", hint: "WILDPATH.ENVIRONMENT.RunningWaterHint" },
    // Fog or foliage the GM paints: Lightly Obscured (obscurityAt, foundry-v14-senses.mts), even in Bright Light.
    { tag: "lightlyObscured", label: "WILDPATH.ENVIRONMENT.LightlyObscured", hint: "WILDPATH.ENVIRONMENT.LightlyObscuredHint" }
];
/** Add the checkboxes to its tab, once per render; the sheet's own form submits them with the rest. */
function addEnvironmentFields(app, element, tab) {
    const panel = element.querySelector(`.tab[data-tab="${tab}"]`);
    if (!panel || panel.querySelector('[name^="flags.wildpath.environment."]'))
        return;
    const tags = app.document?.flags?.wildpath?.environment ?? {};
    for (const { tag, label, hint } of TAGS) {
        panel.append(checkboxGroup(`flags.wildpath.environment.${tag}`, tags[tag] === true, label, hint));
    }
    // Running water is water too (environmentContext holds to it whatever is saved); the boxes only show it.
    const water = panel.querySelector('[name="flags.wildpath.environment.water"]');
    const running = panel.querySelector('[name="flags.wildpath.environment.runningWater"]');
    running?.addEventListener("change", () => {
        if (running.checked && water)
            water.checked = true;
    });
    water?.addEventListener("change", () => {
        if (!water.checked && running)
            running.checked = false;
    });
}
export function registerEnvironmentConfig() {
    const hooks = globalThis.Hooks;
    for (const { hook, tab } of SHEETS)
        hooks?.on(hook, (app, element) => addEnvironmentFields(app, element, tab));
}
