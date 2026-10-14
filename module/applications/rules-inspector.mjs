import { inspectResolution } from "../helpers/resolution-inspection.mjs";
const globals = globalThis;
const { ApplicationV2, HandlebarsApplicationMixin } = globals.foundry.applications.api;
const RECENT = 25;
/**
 * The Rules Inspector (M6): the GM's view of why a resolution came out as it did, read from the authority's own
 * records on this client. Recent resolutions on the left, the chosen one's rolls, attacks, saves, health changes,
 * payments and errors on the right.
 */
export class WildPathRulesInspector extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "wildpath-rules-inspector",
        classes: ["wildpath", "rules-inspector"],
        window: { title: "WILDPATH.INSPECTOR.Title", resizable: true },
        position: { width: 760, height: 560 },
        actions: { select: WildPathRulesInspector.#onSelect }
    };
    static PARTS = { body: { template: "systems/wildpath/templates/apps/rules-inspector.hbs" } };
    selectedId = null;
    async _prepareContext() {
        const records = [...(globals.game.wildpath?.multiplayer?.coordinator?.records?.values() ?? [])].reverse().slice(0, RECENT);
        const entries = records.map(inspectResolution);
        const selected = entries.find(entry => entry.id === this.selectedId) ?? entries[0] ?? null;
        return { entries: entries.map(entry => ({ id: entry.id, label: entry.label, status: entry.status,
                active: entry.id === selected?.id })), selected };
    }
    static async #onSelect(event, target) {
        this.selectedId = target.closest("[data-resolution-id]")?.dataset.resolutionId ?? null;
        await this.render();
    }
}
let inspector = null;
/** Open the Inspector (GM only), on a resolution when one is named. */
export function openRulesInspector(resolutionId = null) {
    if (!globals.game.user?.isGM)
        return null;
    inspector ??= new WildPathRulesInspector();
    if (resolutionId)
        inspector.selectedId = resolutionId;
    void inspector.render({ force: true });
    return inspector;
}
/** A GM sees an Inspect link on each resolution card. */
export function registerRulesInspector() {
    globals.Hooks.on("renderChatMessageHTML", (message, html) => {
        const resolutionId = message.flags?.wildpath?.resolutionId;
        const card = html?.querySelector?.(".resolution-card");
        if (!globals.game.user?.isGM || !resolutionId || !card)
            return;
        const link = document.createElement("a");
        link.className = "wildpath-inspect";
        link.textContent = globals.game.i18n.localize("WILDPATH.INSPECTOR.Inspect");
        link.addEventListener("click", event => {
            event.preventDefault();
            openRulesInspector(resolutionId);
        });
        card.append(link);
    });
}
