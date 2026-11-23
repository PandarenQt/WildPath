/**
 * Plan 4.2: the world's Items whose compendium copy (`_stats.compendiumSource`) now differs (helpers/pack-refresh.mjs),
 * and refreshing them; and those whose compendium copy a rebuild removed, for the GM to remove. World Items, world
 * Actors' Items and an unlinked Token's own Items are walked.
 */

import {refreshChanges} from "../helpers/pack-refresh.mjs";
import {everyActor} from "../helpers/migrations.mjs";

type Data = Record<string, any>;
export interface StaleItem {item: Data; changes: {system: Data; flags: Data}}

/**
 * Every Item a refresh reaches, an Actor's with its Actor's compendium copy (a summon's `summonSource`, else its own
 * `_stats.compendiumSource`). An unlinked Token's synthetic Actor counts only the Items its ActorDelta manages (its
 * own or changed copies); the rest it inherits from its world Actor and is refreshed there.
 */
function worldItems(game: Data): {item: Data; actorSource?: unknown}[] {
  const owned = [...everyActor(game)].flatMap((actor: Data) => {
    const actorSource = actor.flags?.wildpath?.summonSource ?? actor._stats?.compendiumSource;
    return [...(actor.items ?? [])].filter((item: Data) => !actor.isToken || actor.token?.delta?.items?.manages?.(item.id))
      .map((item: Data) => ({item, actorSource}));
  });
  return [...[...(game.items ?? [])].map((item: Data) => ({item})), ...owned];
}

const isPackUuid = (uuid: unknown): uuid is string => (typeof uuid === "string") && uuid.startsWith("Compendium.");

/**
 * Each Item whose compendium copy differs in what a refresh takes, with those changes (`stale`), and each whose
 * compendium copy is gone from a pack still installed (`removed`: a rebuild dropped it, so it can never refresh).
 * An Item with no link of its own (a stat block's: Foundry links only the imported Actor) is matched to the Item of
 * the same converted source id (`flags.wildpath.source.id`) on its Actor's compendium copy, as `fillFeatureShapes` does.
 */
export async function staleItems(game: Data, fromUuid: (uuid: string) => Promise<Data | null>): Promise<{stale: StaleItem[]; removed: Data[]}> {
  // A missing entry loads null, a failed load (a server error) undefined: only a miss is ever reported as removed.
  const packed = new Map<string, Promise<Data | null | undefined>>();
  const load = (uuid: string) => {
    if ( !packed.has(uuid) ) packed.set(uuid, fromUuid(uuid).catch(() => undefined));
    return packed.get(uuid)!;
  };
  const stale: StaleItem[] = [];
  const removed: Data[] = [];
  for ( const {item, actorSource} of worldItems(game) ) {
    const uuid = item._stats?.compendiumSource;
    let source: Data | null | undefined = null;
    if ( isPackUuid(uuid) ) {
      source = await load(uuid);
      // A pack no longer installed (a book module turned off) refreshes and reports nothing.
      if ( (source === null) && game.packs?.get?.(uuid.split(".").slice(1, 3).join(".")) ) removed.push(item);
    }
    else if ( isPackUuid(actorSource) ) {
      // shortcut: a stat block's Item missing from its Actor's copy is not reported removed (it may have been dropped
      // on from elsewhere without a link), upgrade when such Items carry their own compendium link.
      const id = item.flags?.wildpath?.source?.id;
      if ( id ) source = [...((await load(actorSource))?.items ?? [])].find((entry: Data) => entry?.flags?.wildpath?.source?.id === id);
    }
    if ( !source ) continue;
    const changes = refreshChanges(item.toObject(), source.toObject());
    if ( changes ) stale.push({item, changes: changes as StaleItem["changes"]});
  }
  return {stale, removed};
}

/** `items` grouped by their parent (null for world Items); a synthetic Actor's Items under it, which writes its delta. */
function byParent<T>(items: readonly T[], item: (entry: T) => Data) {
  const groups = new Map<Data | null, T[]>();
  for ( const entry of items ) {
    const parent = item(entry).parent ?? null;
    if ( !groups.has(parent) ) groups.set(parent, []);
    groups.get(parent)!.push(entry);
  }
  return groups;
}

/**
 * Refresh `stale` Items, a batch per parent. An object is replaced whole (ForcedReplacement): V14 merges nested
 * objects, so a key the converter dropped would otherwise survive.
 */
export async function refreshItems(stale: readonly StaleItem[], {ForcedReplacement, Item}: {ForcedReplacement: {create(value: unknown): unknown};
  Item: {updateDocuments(updates: Data[]): Promise<unknown>}}) {
  const value = (entry: unknown) => ((entry && (typeof entry === "object") && !Array.isArray(entry)) ? ForcedReplacement.create(entry) : entry);
  for ( const [parent, entries] of byParent(stale, entry => entry.item) ) {
    const updates = entries.map(({item, changes}) => ({_id: item.id,
      ...Object.fromEntries(Object.entries(changes.system).map(([field, entry]) => [`system.${field}`, value(entry)])),
      ...Object.fromEntries(Object.entries(changes.flags).map(([key, entry]) => [`flags.wildpath.${key}`, value(entry)]))}));
    if ( parent ) await parent.updateEmbeddedDocuments("Item", updates);
    else await Item.updateDocuments(updates);
  }
  return stale.length;
}

/** Delete `items` (those whose compendium copy is gone), a batch per parent. */
export async function removeItems(items: readonly Data[], {Item}: {Item: {deleteDocuments(ids: string[]): Promise<unknown>}}) {
  for ( const [parent, entries] of byParent(items, entry => entry) ) {
    const ids = entries.map(item => item.id);
    if ( parent ) await parent.deleteEmbeddedDocuments("Item", ids);
    else await Item.deleteDocuments(ids);
  }
  return items.length;
}
