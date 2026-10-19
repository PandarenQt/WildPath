import { actionBarContext } from "../helpers/action-bar-context.mjs";
import { foundryActionOdds } from "../resolvers/foundry-multiplayer-runtime.mjs";
import { COMMON_ACTION_IDS, commonAction } from "../helpers/common-actions.mjs";
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
        actions: { use: WildPathActionBar.#onUse, useSlot: WildPathActionBar.#onUseSlot, reactionPolicy: WildPathActionBar.#onReactionPolicy }
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
        const common = this.#common(actor);
        const context = actionBarContext({ actor, conditions: Object.values(globals.CONFIG.WILDPATH.CONDITIONS),
            odds: this.#odds(actor, common), common });
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
    /** The common actions as this creature's Actions (Dash, Shove...). */
    #common(actor) {
        const localize = (key) => globals.game.i18n.localize(key);
        let bonusShove = false;
        try {
            bonusShove = globals.game.settings?.get("wildpath", "bonusActionShove") === true;
        }
        catch (_error) { }
        // Escape is offered only while the creature has something to escape.
        return COMMON_ACTION_IDS.map(id => commonAction(actor, id, { localize, bonusShove })).filter(action => action !== null);
    }
    /** The odds of each attack and save Action against the user's targets, as far as this user may see them. */
    #odds(actor, common) {
        const { user } = globals.game;
        const targets = [...(user?.targets ?? [])].map(token => token.document);
        if (!targets.length)
            return {};
        const sourceToken = globals.canvas?.tokens?.controlled?.find(token => token.actor === actor)?.document
            ?? actor.getActiveTokens?.()[0]?.document ?? null;
        const odds = foundryActionOdds;
        return Object.fromEntries([...actor.items, ...common].filter(item => item.type === "action")
            .map(item => [item.id ?? "", odds({ actor, action: item, sourceToken, targetTokens: targets, user })]));
    }
    static async #onUse(event, target) {
        const id = target.closest("[data-item-id]")?.dataset.itemId;
        const actor = this.shownActor;
        if (!id || !actor)
            return;
        // A common action is no Item: Item#use runs on the Action this creature has for it.
        const common = id.startsWith("common-") ? this.#common(actor).find(action => action.id === id) : null;
        if (common)
            await globals.CONFIG.Item.documentClass.prototype.use.call(common);
        else
            await actor.items.get(id)?.use();
    }
    /** Cast a spell with the slot its button names: no dialog, the authority checks the slot like any choice. */
    static async #onUseSlot(event, target) {
        const { itemId, choiceId, optionId } = target.dataset;
        if (!itemId || !choiceId || !optionId)
            return;
        await this.shownActor?.items.get(itemId)?.use({ configuration: { choices: { [choiceId]: { paymentOptionId: optionId } } } });
    }
    /** Cycle a reaction between Ask, Always and Never (Baldur's Gate 3's reaction settings). */
    static async #onReactionPolicy(event, target) {
        const actor = this.shownActor;
        const id = target.dataset.itemId ?? "";
        const policies = REACTION_POLICIES;
        const next = (current) => policies[(policies.indexOf(reactionPolicyOf(current)) + 1) % policies.length];
        // A common reaction (the Opportunity Attack) keeps its setting on the creature.
        const common = id.startsWith("common-") && actor ? this.#common(actor).find(action => action.id === id) : null;
        const creature = actor;
        if (common)
            return void await creature.setFlag("wildpath", `commonPolicies.${id.slice("common-".length)}`, next(common));
        // Legendary Resistance's setting is the creature's own too.
        if (actor && (id === "legendary-resistance"))
            return void await creature.setFlag("wildpath", `commonPolicies.${id}`, next({ flags: { wildpath: { reactionPolicy: creature.flags?.wildpath?.commonPolicies?.[id] } } }));
        const item = actor?.items.get(id);
        if (item)
            await item.setFlag("wildpath", "reactionPolicy", next(item));
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
    // Sunlight (Sunlight Sensitivity) changes with the Scene's and the lights' tags.
    for (const hook of ["updateScene", "createAmbientLight", "updateAmbientLight", "deleteAmbientLight"])
        globals.Hooks.on(hook, () => refreshActionBar());
    for (const hook of ["updateActor", "createItem", "updateItem", "deleteItem", "createActiveEffect", "updateActiveEffect",
        "deleteActiveEffect"]) {
        globals.Hooks.on(hook, (document) => { if (concerns(document))
            refreshActionBar(); });
    }
    refreshActionBar();
}
