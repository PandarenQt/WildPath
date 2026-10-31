/**
 * Plan 4.2: the world's Items whose compendium copy (`_stats.compendiumSource`) now differs (helpers/pack-refresh.mjs),
 * and refreshing them. World Items and world Actors' Items are walked.
 * shortcut: an unlinked Token's own Items are not refreshed; upgrade by walking each Scene's unlinked Tokens.
 */
import { refreshChanges } from "../helpers/pack-refresh.mjs";
/** Each Item whose compendium copy differs in what a refresh takes, with those changes. */
export async function staleItems(game, fromUuid) {
    const packed = new Map();
    const items = [...(game.items ?? []), ...[...(game.actors ?? [])].flatMap((actor) => [...(actor.items ?? [])])];
    const stale = [];
    for (const item of items) {
        const uuid = item._stats?.compendiumSource;
        if ((typeof uuid !== "string") || !uuid.startsWith("Compendium."))
            continue;
        // A pack no longer installed (a book module turned off) refreshes nothing.
        if (!packed.has(uuid))
            packed.set(uuid, await fromUuid(uuid).catch(() => null));
        const source = packed.get(uuid);
        const changes = source ? refreshChanges(item.toObject(), source.toObject()) : null;
        if (changes)
            stale.push({ item, changes: changes });
    }
    return stale;
}
/**
 * Refresh `stale` Items, a batch per parent. An object is replaced whole (ForcedReplacement): V14 merges nested
 * objects, so a key the converter dropped would otherwise survive.
 */
export async function refreshItems(stale, { ForcedReplacement, Item }) {
    const value = (entry) => ((entry && (typeof entry === "object") && !Array.isArray(entry)) ? ForcedReplacement.create(entry) : entry);
    const byParent = new Map();
    for (const { item, changes } of stale) {
        const parent = item.parent ?? null;
        if (!byParent.has(parent))
            byParent.set(parent, []);
        byParent.get(parent).push({ _id: item.id,
            ...Object.fromEntries(Object.entries(changes.system).map(([field, entry]) => [`system.${field}`, value(entry)])),
            ...Object.fromEntries(Object.entries(changes.flags).map(([key, entry]) => [`flags.wildpath.${key}`, value(entry)])) });
    }
    for (const [parent, updates] of byParent) {
        if (parent)
            await parent.updateEmbeddedDocuments("Item", updates);
        else
            await Item.updateDocuments(updates);
    }
    return stale.length;
}
