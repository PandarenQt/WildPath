import { actionBarContext } from "../helpers/action-bar-context.mjs";
import { foundryActionOdds } from "../resolvers/foundry-multiplayer-runtime.mjs";
import { COMMON_ACTION_IDS, commonAction } from "../helpers/common-actions.mjs";
import { REACTION_POLICIES, reactionPolicyOf } from "../helpers/automation-events.mjs";
import { placeContext } from "../adapters/foundry-v14-senses.mjs";
import { eligibleTargetInRange } from "../adapters/foundry-v14-auras.mjs";
import { controllerPaid } from "../helpers/action-definitions.mjs";
const globals = globalThis;
const { ApplicationV2, HandlebarsApplicationMixin } = globals.foundry.applications.api;
/** The creatures controlling it (a summon's caster, a companion's): those who pay its `controllerCosts` (companions.md). */
const controllersOf = (creature) => creature?.system?.companion?.controllers ?? [];
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
        // Where its Token stands, for what its Actions require of it (Shadow Stealth: not in Bright Light; Hide: obscured or in cover).
        // The canvas gives a TokenDocument; BarToken types only the fields the bar itself reads.
        const token = this.#sourceToken(actor);
        const context = actionBarContext({ actor, localize: (key) => globals.game.i18n.localize(key),
            conditions: Object.values(globals.CONFIG.WILDPATH.CONDITIONS),
            odds: this.#odds(actor, common), common, place: placeContext(token),
            targetInRange: definition => eligibleTargetInRange(definition, token) });
        const paid = (creature, id) => controllerPaid(creature.items.get(id ?? "")?.system?.definition);
        // A controlled creature's Actions its controller pays for (`controllerCosts`) are on its controllers' bars only (Q99's default).
        if (controllersOf(actor).length) {
            for (const group of context.groups)
                group.actions = group.actions.filter(action => !paid(actor, action.id));
            context.groups = context.groups.filter(group => group.actions.length);
        }
        // The Actions of each vehicle it is aboard, in a group of their own: it uses them as crew, at its own cost. And those
        // the creatures it controls take at its cost (a summon's: an Arcane Eye's Move, a Flaming Sphere's Roll), a group each.
        const vehicles = this.#aboard(actor);
        this.#hosts = [...vehicles, ...this.#commanded(actor).filter(creature => !vehicles.includes(creature))];
        for (const host of this.#hosts) {
            const crew = actionBarContext({ actor: host, controller: actor, localize: (key) => globals.game.i18n.localize(key) });
            const actions = crew.groups.filter(group => group.id !== "common").flatMap(group => group.actions)
                .filter(action => vehicles.includes(host) || paid(host, action.id));
            if (actions.length)
                context.groups.push({ id: `${vehicles.includes(host) ? "vehicle" : "companion"}-${host.uuid}`, label: host.name ?? "",
                    actorUuid: host.uuid, actions });
        }
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
    /** The vehicles the shown creature is aboard and the creatures it controls, on the viewed Scene (their Actions' buttons name them). */
    #hosts = [];
    #aboard(actor) {
        const found = new Map();
        for (const token of globals.canvas?.tokens?.placeables ?? []) {
            const vehicle = token.actor;
            const aboard = (vehicle?.system?.aboard ?? []);
            if (vehicle?.isOwner && aboard.some(entry => entry.actorUuid === actor.uuid))
                found.set(vehicle.uuid, vehicle);
        }
        return [...found.values()];
    }
    /** The creatures the shown one controls (its summons, a companion) on the viewed Scene that the user owns. */
    #commanded(actor) {
        const found = new Map();
        for (const token of globals.canvas?.tokens?.placeables ?? []) {
            if (token.actor?.isOwner && controllersOf(token.actor).includes(actor.uuid))
                found.set(token.actor.uuid, token.actor);
        }
        return [...found.values()];
    }
    /** The common actions as this creature's Actions (Dash, Shove...). */
    #common(actor) {
        const localize = (key) => globals.game.i18n.localize(key);
        let bonusShove = false;
        try {
            bonusShove = globals.game.settings?.get("wildpath", "bonusActionShove") === true;
        }
        catch (_error) { }
        // Escape and Free are offered only while there is something to escape or free (Free: the user's first target).
        const target = [...(globals.game.user?.targets ?? [])][0]?.actor ?? null;
        return COMMON_ACTION_IDS.map(id => commonAction(actor, id, { localize, bonusShove, target })).filter(action => action !== null);
    }
    /** The shown creature's Token on the canvas: the controlled one, else its first. */
    #sourceToken(actor) {
        return globals.canvas?.tokens?.controlled?.find(token => token.actor === actor)?.document
            ?? actor.getActiveTokens?.()[0]?.document ?? null;
    }
    /** The odds of each attack and save Action against the user's targets, as far as this user may see them. */
    #odds(actor, common) {
        const { user } = globals.game;
        const targets = [...(user?.targets ?? [])].map(token => token.document);
        if (!targets.length)
            return {};
        const sourceToken = this.#sourceToken(actor);
        const odds = foundryActionOdds;
        return Object.fromEntries([...actor.items, ...common].filter(item => item.type === "action")
            .map(item => [item.id ?? "", odds({ actor, action: item, sourceToken, targetTokens: targets, user })]));
    }
    static async #onUse(event, target) {
        const id = target.closest("[data-item-id]")?.dataset.itemId;
        const actor = this.shownActor;
        if (!id || !actor)
            return;
        // A click or tap shows why an action is unaffordable: a touch screen never hovers to open the tooltip.
        if (target.getAttribute("aria-disabled") === "true")
            return globals.game.tooltip?.activate(target);
        // A common action is no Item: Item#use runs on the Action this creature has for it.
        const common = id.startsWith("common-") ? this.#common(actor).find(action => action.id === id) : null;
        // A vehicle's or a controlled creature's Action: it acts, this creature pays as its crew or controller.
        const hostUuid = target.closest("[data-actor-uuid]")?.dataset.actorUuid;
        const host = hostUuid ? this.#hosts.find(entry => entry.uuid === hostUuid) : null;
        if (host)
            await host.items.get(id)?.use({ controllerRef: actor.uuid });
        else if (common)
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
    // Only where a creature stands or how big it is moves range and cover; its other changes come through its Actor.
    const placement = ["x", "y", "elevation", "width", "height", "shape"];
    // Any Token on the viewed Scene, where the shown Token stands, changes what its Actions require of that place: its own
    // move or light (Shadow Stealth's light), another's light, and a foe's move, appearing, hiding or leaving (Hide's cover
    // from its foes, placeContext); so do walls and Regions (a lasting area, the GM's "Lightly obscured" tag) and a foe's death.
    // shortcut: another lit Token's move may read its drawn light source still on the old square (lightReaches); upgrade by
    // measuring a moving Token's light by its radius, as its own is.
    const onViewed = (token) => !!bar?.shownActor && (token?.parent === globals.canvas?.scene);
    const shaping = ["light", "hidden", ...placement];
    globals.Hooks.on("updateToken", (token, changes) => {
        if (onViewed(token) && shaping.some(key => key in (changes ?? {})))
            refreshActionBar();
    });
    for (const hook of ["createToken", "deleteToken"])
        globals.Hooks.on(hook, (token) => { if (onViewed(token))
            refreshActionBar(); });
    for (const hook of ["createWall", "updateWall", "deleteWall", "createRegion", "updateRegion", "deleteRegion"]) {
        globals.Hooks.on(hook, () => { if (bar?.shownActor)
            refreshActionBar(); });
    }
    const defeated = () => globals.CONFIG?.specialStatusEffects?.DEFEATED ?? "dead";
    const defeats = (document) => [...(document?.statuses ?? [])].includes(defeated());
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
        globals.Hooks.on(hook, (document, changes) => {
            // Who controls a creature changing (a new summon's controllers and ownership, set after its Token) moves its Actions.
            const handed = (hook === "updateActor") && ("companion" in (changes?.system ?? {}));
            if (handed || concerns(document) || (!!bar?.shownActor && defeats(document)))
                refreshActionBar();
        });
    }
    refreshActionBar();
}
