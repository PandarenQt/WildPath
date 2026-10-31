import { refreshItems, staleItems } from "../adapters/foundry-v14-pack-refresh.mjs";
const globals = globalThis;
const { ApplicationV2, HandlebarsApplicationMixin } = globals.foundry.applications.api;
/**
 * Plan 4.2: the GM's "Refresh items from compendiums" (a settings menu). It lists the world's Items whose compendium
 * copy changed (a converter fix) and what each would take, and refreshes them on the GM's word.
 */
export class WildPathRefreshItems extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "wildpath-refresh-items",
        classes: ["wildpath", "refresh-items", "themed", "theme-light"],
        window: { title: "WILDPATH.REFRESH.Title", resizable: true },
        position: { width: 520, height: 480 },
        actions: { refresh: WildPathRefreshItems.#onRefresh }
    };
    static PARTS = { body: { template: "systems/wildpath/templates/apps/refresh-items.hbs" } };
    #stale = [];
    async _prepareContext() {
        this.#stale = await staleItems(globals.game, uuid => globals.fromUuid(uuid));
        return { count: this.#stale.length, entries: this.#stale.map(({ item, changes }) => ({ name: item.name,
                owner: item.parent?.name ?? null, parts: [...Object.keys(changes.system), ...Object.keys(changes.flags).map(key => `flags.${key}`)].join(", ") })) };
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
}
