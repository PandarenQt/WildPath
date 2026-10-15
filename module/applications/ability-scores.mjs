/**
 * Ability scores at character creation (G8, 2024): the standard array, point buy (27 points, 8 to 15), or six rolls of
 * 4d6 keeping the highest three, assigned to the six abilities. Typing scores on the sheet stays possible. A
 * background's increases come after, when it is added (applications/level-up.mts).
 */
import { POINT_BUY, STANDARD_ARRAY, pointBuySpent, usesPool } from "../helpers/level-up.mjs";
const globals = () => globalThis;
const localize = (key) => globals().game.i18n.localize(key);
const format = (key, data) => globals().game.i18n.format(key, data);
/** The dialog's form: a method, and per ability a value from the pool (array, rolls) or a bought score. */
function content(abilities) {
    const { ABILITIES } = globals().CONFIG.WILDPATH;
    const rows = abilities.map(ability => `<label class="ability-score-row">${localize(ABILITIES[ability]?.label ?? ability)}
    <select name="pick.${ability}" data-pool></select>
    <input type="number" name="buy.${ability}" value="8" min="8" max="15" step="1" data-buy hidden></label>`).join("");
    return `<div class="wildpath ability-scores">
    <label>${localize("WILDPATH.ABILITYSCORES.Method")} <select name="method">
      <option value="array">${localize("WILDPATH.ABILITYSCORES.Array")}</option>
      <option value="pointBuy">${localize("WILDPATH.ABILITYSCORES.PointBuy")}</option>
      <option value="roll">${localize("WILDPATH.ABILITYSCORES.Roll")}</option></select></label>
    <p class="hint" data-hint></p>
    <button type="button" data-roll hidden>${localize("WILDPATH.ABILITYSCORES.RollButton")}</button>
    <div class="ability-score-grid">${rows}</div></div>`;
}
/** Show the chosen method's controls, keep the pool's options, and enable OK only for a complete, legal set. */
function watch(form, abilities, actor) {
    let rolled = [];
    const ok = form.querySelector('button[data-action="ok"]');
    const method = form.querySelector('select[name="method"]');
    const hint = form.querySelector("[data-hint]");
    const rollButton = form.querySelector("[data-roll]");
    const picks = abilities.map(ability => form.querySelector(`select[name="pick.${ability}"]`));
    const buys = abilities.map(ability => form.querySelector(`input[name="buy.${ability}"]`));
    const pool = () => (method.value === "roll" ? rolled : [...STANDARD_ARRAY]);
    const fill = () => {
        const values = pool();
        picks.forEach((select, index) => {
            select.innerHTML = `<option value=""></option>${values.map(value => `<option value="${value}">${value}</option>`).join("")}`;
            // The array goes on in order, so a confirm at once gives 15 to the first ability; rolls wait to be placed.
            select.value = method.value === "array" ? String(values[index] ?? "") : "";
        });
    };
    const check = () => {
        const buying = method.value === "pointBuy";
        for (const select of picks)
            select.hidden = buying;
        for (const input of buys)
            input.hidden = !buying;
        rollButton.hidden = method.value !== "roll";
        let valid;
        if (buying) {
            const spent = pointBuySpent(buys.map(input => Number(input.value)));
            hint.textContent = spent === null ? localize("WILDPATH.ABILITYSCORES.OutOfRange")
                : format("WILDPATH.ABILITYSCORES.Points", { spent, budget: POINT_BUY.budget });
            valid = (spent !== null) && (spent <= POINT_BUY.budget);
        }
        else {
            hint.textContent = method.value === "roll" ? (rolled.length ? format("WILDPATH.ABILITYSCORES.Rolled", { values: rolled.join(", ") })
                : localize("WILDPATH.ABILITYSCORES.RollFirst")) : localize("WILDPATH.ABILITYSCORES.ArrayHint");
            valid = pool().length === abilities.length && usesPool(picks.map(select => Number(select.value)), pool());
        }
        if (ok)
            ok.disabled = !valid;
    };
    method.addEventListener("change", () => { fill(); check(); });
    form.addEventListener("input", check);
    form.addEventListener("change", check);
    rollButton.addEventListener("click", async () => {
        const { Roll, ChatMessage } = globals();
        rolled = [];
        for (const _ability of abilities) {
            const roll = await new Roll("4d6kh3").evaluate();
            rolled.push(roll.total);
            await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: format("WILDPATH.ABILITYSCORES.RollFlavor", { name: actor.name }) });
        }
        rollButton.disabled = true;
        fill();
        check();
    });
    fill();
    check();
}
/** Ask for a creature's six ability scores and set them; false when the dialog is closed. */
export async function chooseAbilityScores(actor) {
    const abilities = Object.keys(globals().CONFIG.WILDPATH.ABILITIES);
    const form = await globals().foundry.applications.api.DialogV2.wait({
        window: { title: format("WILDPATH.ABILITYSCORES.Title", { name: actor.name }) },
        content: content(abilities),
        buttons: [{ action: "ok", label: localize("WILDPATH.ABILITYSCORES.Confirm"), default: true,
                callback: (_event, button) => (button.form ? new FormData(button.form) : null) }],
        render: (_event, dialog) => {
            const element = dialog.element.querySelector("form");
            if (element)
                watch(element, abilities, actor);
        },
        rejectClose: false
    });
    if (!(form instanceof FormData))
        return false;
    const prefix = form.get("method") === "pointBuy" ? "buy" : "pick";
    await actor.update(Object.fromEntries(abilities.map(ability => [`system.abilities.${ability}.value`, Number(form.get(`${prefix}.${ability}`))])));
    return true;
}
