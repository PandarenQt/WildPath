import { refreshItems, removeItems, staleItems } from "../adapters/foundry-v14-pack-refresh.mjs";
const globals = globalThis;
const { ApplicationV2, HandlebarsApplicationMixin } = globals.foundry.applications.api;
/**
 * Plan 4.2: the GM's "Refresh items from compendiums" (a settings menu). It lists the world's Items whose compendium
 * copy changed (a converter fix) and what each would take, and refreshes them on the GM's word; and those whose
 * compendium copy a rebuild removed, which it deletes on the GM's confirmed word.
 */
export class WildPathRefreshItems extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "wildpath-refresh-items",
        classes: ["wildpath", "refresh-items", "themed", "theme-light"],
        window: { title: "WILDPATH.REFRESH.Title", resizable: true },
        position: { width: 520, height: 480 },
        actions: { refresh: WildPathRefreshItems.#onRefresh, remove: WildPathRefreshItems.#onRemove }
    };
    static PARTS = { body: { template: "systems/wildpath/templates/apps/refresh-items.hbs" } };
    #stale = [];
    #removed = [];
    async _prepareContext() {
        ({ stale: this.#stale, removed: this.#removed } = await staleItems(globals.game, uuid => globals.fromUuid(uuid)));
        return { count: this.#stale.length, entries: this.#stale.map(({ item, changes }) => ({ name: item.name,
                owner: item.parent?.name ?? null, parts: [...Object.keys(changes.system), ...Object.keys(changes.flags).map(key => `flags.${key}`)].join(", ") })),
            removedCount: this.#removed.length, removed: this.#removed.map(item => ({ name: item.name, owner: item.parent?.name ?? null })) };
    }
    static async #onRefresh() {
        const { game, ui } = globals;
        if (!game.user?.isGM)
            return;
        const count = await refreshItems(this.#stale, { ForcedReplacement: globals.foundry.data.operators.ForcedReplacement,
            Item: globals.Item.implementation });
        ui.notifications?.info(game.i18n.format("WILDPATH.REFRESH.Done", { count }));
        await this.render();
    }
    static async #onRemove() {
        const { game, ui } = globals;
        if (!game.user?.isGM || !this.#removed.length)
            return;
        const sure = await globals.foundry.applications.api.DialogV2.confirm({ classes: ["wildpath", "themed", "theme-light"],
            window: { title: "WILDPATH.REFRESH.Title" }, rejectClose: false,
            content: `<p>${game.i18n.format("WILDPATH.REFRESH.RemoveConfirm", { count: this.#removed.length })}</p>` });
        if (!sure)
            return;
        const count = await removeItems(this.#removed, { Item: globals.Item.implementation });
        ui.notifications?.info(game.i18n.format("WILDPATH.REFRESH.RemoveDone", { count }));
        await this.render();
    }
}
