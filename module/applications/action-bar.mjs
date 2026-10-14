import { actionBarContext } from "../helpers/action-bar-context.mjs";
import { foundryActionOdds } from "../resolvers/foundry-multiplayer-runtime.mjs";
import { REACTION_POLICIES, reactionPolicyOf } from "../helpers/automation-events.mjs";
const globals = globalThis;
const { ApplicationV2, HandlebarsApplicationMixin } = globals.foundry.applications.api;
/**
 * The in-play action bar (M6): the controlled Token's creature, or the user's character when no Token is
 * controlled. Clicking an Action uses it through the real `Item.use()`, so the authority decides everything.
 */
export class WildPathActionBar extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "wildpath-action-bar",
        classes: ["wildpath", "action-bar"],
        tag: "aside",
        window: { frame: false, positioned: false },
        actions: { use: WildPathActionBar.#onUse, reactionPolicy: WildPathActionBar.#onReactionPolicy }
    };
    static PARTS = { bar: { template: "systems/wildpath/templates/hud/action-bar.hbs" } };
    /** The creature shown, when a test or caller sets it; otherwise it follows the controlled Token. */
    actor = null;
    /** The creature the bar shows now. */
    get shownActor() {
        return this.actor ?? globals.canvas?.tokens?.controlled?.[0]?.actor ?? globals.game.user?.character ?? null;
    }
    async _prepareContext() {
        const actor = this.shownActor;
        if (!actor)
            return { shown: false };
        const context = actionBarContext({ actor, conditions: Object.values(globals.CONFIG.WILDPATH.CONDITIONS), odds: this.#odds(actor) });
        // Each target's odds, one line each, in the button's tooltip.
        const { i18n } = globals.game;
        for (const action of context.groups.flatMap(group => group.actions)) {
            if (!action.odds)
                continue;
            Object.assign(action.odds, { tooltip: action.odds.lines.map(line => i18n.format(line.key, { ...line.data,
                    name: globals.foundry.utils.escapeHTML(String(line.data.name ?? "")), mode: line.mode ? i18n.localize(line.mode) : "",
                    ability: line.ability ? i18n.localize(line.ability) : "" })).join("<br>") });
        }
        return { shown: true, ...context };
    }
    /** The odds of each attack and save Action against the user's targets, as far as this user may see them. */
    #odds(actor) {
        const { user } = globals.game;
        const targets = [...(user?.targets ?? [])].map(token => token.document);
        if (!targets.length)
            return {};
        const sourceToken = globals.canvas?.tokens?.controlled?.find(token => token.actor === actor)?.document
            ?? actor.getActiveTokens?.()[0]?.document ?? null;
        const odds = foundryActionOdds;
        return Object.fromEntries([...actor.items].filter(item => item.type === "action")
            .map(item => [item.id ?? "", odds({ actor, action: item, sourceToken, targetTokens: targets, user })]));
    }
    static async #onUse(event, target) {
        const id = target.closest("[data-item-id]")?.dataset.itemId;
        if (id)
            await this.shownActor?.items.get(id)?.use();
    }
    /** Cycle a reaction between Ask, Always and Never (Baldur's Gate 3's reaction settings). */
    static async #onReactionPolicy(event, target) {
        const item = this.shownActor?.items.get(target.dataset.itemId ?? "");
        if (!item)
            return;
        const policies = REACTION_POLICIES;
        await item.setFlag("wildpath", "reactionPolicy", policies[(policies.indexOf(reactionPolicyOf(item)) + 1) % policies.length]);
    }
}
let bar = null;
let pending = null;
/** Show the bar for the creature in focus, hide it when there is none; changes to that creature re-render it. */
export function refreshActionBar() {
    if (pending)
        clearTimeout(pending);
    pending = setTimeout(() => {
        pending = null;
        bar ??= new WildPathActionBar();
        if (bar.shownActor?.isOwner)
            void bar.render({ force: true });
        else if (bar.rendered)
            void bar.close();
    }, 50);
}
/** Register the hooks that keep the bar on the creature in focus (called once the game is ready). */
export function registerActionBar() {
    const concerns = (document) => {
        const shown = bar?.shownActor;
        const owner = document;
        // A target's own changes (an effect revealing its defenses) change the odds shown.
        const targets = [...(globals.game.user?.targets ?? [])].map(token => token.actor?.uuid);
        return !!shown && [shown.uuid, ...targets].some(uuid => uuid && ((owner?.uuid === uuid) || (owner?.parent?.uuid === uuid)));
    };
    globals.Hooks.on("controlToken", () => refreshActionBar());
    // The odds change with the user's targets, and with where the creatures stand.
    globals.Hooks.on("targetToken", (user) => { if (user === globals.game.user)
        refreshActionBar(); });
    globals.Hooks.on("updateToken", () => { if ([...(globals.game.user?.targets ?? [])].length)
        refreshActionBar(); });
    // The house rule's first change creates its Setting; later ones update it.
    for (const hook of ["createSetting", "updateSetting"])
        globals.Hooks.on(hook, (setting) => {
            if (setting.key === "wildpath.playersSeeOdds")
                refreshActionBar();
        });
    for (const hook of ["updateActor", "createItem", "updateItem", "deleteItem", "createActiveEffect", "updateActiveEffect",
        "deleteActiveEffect"]) {
        globals.Hooks.on(hook, (document) => { if (concerns(document))
            refreshActionBar(); });
    }
    refreshActionBar();
}
