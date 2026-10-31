import {gmNotice} from "./gm-notice.mjs";

/**
 * World migrations: each runs once, in order, on the active GM's client at `ready`, and the world setting
 * `wildpath.migrationVersion` records the last one done. A failed one stops the run (the GM is told), and runs again at
 * the next start. Each migration takes `game` and changes what it finds; one finding nothing changes nothing.
 */

/** Pools the system keeps itself (spell slots, Hit Dice, Mystic Arcanum, Heroic Inspiration): never stale. */
const SYSTEM_POOL = /^(?:spell-slot\.|hit-die\.|mystic-arcanum\.)|^heroic-inspiration$/;

/**
 * The ids of `pools` (stored source) nothing names any more: not a system pool, no base or bonus of its own, and no
 * Item or effect in `documents` (stored sources, on or off) grants, modifies or spends it. An Item granting it was
 * deleted; while that Item is only off (an unequipped wand) it still names it, and the pool keeps its value.
 * @param {Array<{id: string, base?: number, bonus?: number}>} pools
 * @param {object[]} documents
 * @returns {string[]}
 */
export function stalePoolIds(pools=[], documents=[]) {
  // A grant's `{item}` is its Item's id (Magic Initiate's per-copy pool), so its pool is that document's.
  const texts = documents.map(document => JSON.stringify(document ?? {}).replaceAll("{item}", String(document?._id ?? document?.id ?? "")));
  return pools.filter(pool => !SYSTEM_POOL.test(pool.id) && !pool.base && !pool.bonus
    && !texts.some(text => text.includes(`"${pool.id}"`) || text.includes(`pools.${pool.id}.`))).map(pool => pool.id);
}

/**
 * An NPC's Challenge Rating as converted (`flags.wildpath.source.challenge`), when its stored `threat` lost the fraction
 * (converted before Challenge Rating kept fractions: 1/4 stored as 0); else null.
 * @param {{type?: string, system?: {details?: {threat?: number}}, flags?: object}} source
 * @returns {number|null}
 */
export function threatFix(source) {
  const challenge = Number(source?.flags?.wildpath?.source?.challenge);
  // A lost fraction was stored as 0; any other threat is a rating the GM set, kept as it is.
  if ( (source?.type !== "npc") || !Number.isFinite(challenge) || !(challenge < 1) || (Number(source.system?.details?.threat ?? 0) !== 0) ) return null;
  return source.system?.details?.threat === challenge ? null : challenge;
}

/**
 * The Fortitude modifier a character's Hit Point base counts for each level (`perLevelFortitude`), for one built by
 * level-up before the base recorded it (it has class records): its stored Fortitude's, as it most likely was. Else null.
 * @param {{type?: string, system?: {classes?: unknown[], abilities?: {fortitude?: {value?: number}},
 *   resources?: {health?: {perLevelFortitude?: number|null}}}}} source
 * @returns {number|null}
 */
export function fortitudeFix(source) {
  const system = source?.system;
  if ( (source?.type !== "character") || !system?.classes?.length || Number.isInteger(system.resources?.health?.perLevelFortitude) ) return null;
  return Math.floor(((Number(system.abilities?.fortitude?.value) || 10) - 10) / 2);
}

/**
 * The creature type an NPC converted before creatures carried one takes from the compendium creature it came from: by
 * its converted source's id, the compendium entry Foundry recorded, its own id, or else its name when exactly one
 * compendium creature has it (`types` holds them by id and by `name:<name>`, a shared name as null). Null when it has one.
 * @param {{type?: string, _id?: string, name?: string, system?: {details?: {type?: string}}, flags?: object,
 *   _stats?: {compendiumSource?: string|null}}} source
 * @param {Map<string, {type?: string, subtype?: string}|null>} types
 */
export function creatureTypeFix(source, types) {
  if ( (source?.type !== "npc") || source.system?.details?.type ) return null;
  const ids = [source.flags?.wildpath?.source?.id, String(source._stats?.compendiumSource ?? "").split(".").pop(), source._id];
  const found = ids.map(id => (id ? types.get(id) : null)).find(Boolean) ?? types.get(`name:${source.name}`);
  return found?.type ? {"system.details.type": found.type, "system.details.subtype": found.subtype ?? ""} : null;
}

/**
 * Whether a rule is one of the shapes a feature used to have as engine code keyed on its identifier (2026-10-31): a
 * `half-on-success` or `ignore-resistance` RollOutcome, a `shared-healing` Trigger, or a rule naming a recorded choice
 * (`{training:<kind>}`). Named by shape, never by feature.
 */
const generalizedShape = rule => ((rule?.type === "RollOutcome") && ["half-on-success", "ignore-resistance"].includes(rule.data?.outcome))
  || ((rule?.type === "Trigger") && (rule.data?.kind === "shared-healing"))
  || JSON.stringify(rule?.data ?? null).includes("{training:");

/**
 * What an Item (stored source) takes from its compendium copy (`packSource`) of those shapes: the pack's rules of them
 * whose id it lacks, appended, and the pack's `flags.wildpath.spellChoice` when it has none. Additive only: nothing it
 * has is replaced. Null when it needs nothing.
 * @param {object} source
 * @param {object|null} packSource
 * @returns {object|null}
 */
export function featureShapeFix(source, packSource) {
  if ( !source || !packSource || (source.type !== packSource.type) ) return null;
  const rules = source.system?.ruleElements ?? [];
  const ids = new Set(rules.map(rule => rule?.id));
  const missing = (packSource.system?.ruleElements ?? []).filter(rule => generalizedShape(rule) && !ids.has(rule?.id));
  const choice = source.flags?.wildpath?.spellChoice ? null : (packSource.flags?.wildpath?.spellChoice ?? null);
  if ( !missing.length && !choice ) return null;
  return {...(missing.length ? {"system.ruleElements": structuredClone([...rules, ...missing])} : {}),
    ...(choice ? {"flags.wildpath.spellChoice": structuredClone(choice)} : {})};
}

/** Every world Actor, then the unlinked Tokens' own Actors on every Scene (after their base, so they see its fix). */
function* everyActor(game) {
  yield* game.actors ?? [];
  for ( const scene of game.scenes ?? [] ) {
    for ( const token of scene.tokens ?? [] ) if ( !token.actorLink && token.actor ) yield token.actor;
  }
}

async function migrateThreat(game) {
  for ( const actor of everyActor(game) ) {
    const threat = threatFix(actor.toObject(true));
    if ( threat !== null ) await actor.update({"system.details.threat": threat});
  }
}

async function recordFortitude(game) {
  for ( const actor of everyActor(game) ) {
    const fortitude = fortitudeFix(actor.toObject(true));
    if ( fortitude !== null ) await actor.update({"system.resources.health.perLevelFortitude": fortitude});
  }
}

async function recordCreatureTypes(game) {
  const types = new Map();
  for ( const pack of game.packs ?? [] ) {
    if ( pack.documentName !== "Actor" ) continue;
    for ( const entry of await pack.getIndex({fields: ["system.details.type", "system.details.subtype"]}) ) {
      if ( !entry.system?.details?.type ) continue;
      types.set(entry._id, entry.system.details);
      const name = `name:${entry.name}`;
      types.set(name, types.has(name) && (types.get(name)?.type !== entry.system.details.type) ? null : entry.system.details);
    }
  }
  for ( const actor of everyActor(game) ) {
    const fix = creatureTypeFix(actor.toObject(true), types);
    if ( fix ) await actor.update(fix);
  }
}

async function pruneStalePools(game) {
  for ( const actor of everyActor(game) ) await pruneActorPools(actor);
}

/** Remove `actor`'s stale pools (see `stalePoolIds`); used by the migration and when an Item or effect is deleted. */
export async function pruneActorPools(actor) {
  const pools = actor.toObject(true).system?.pools ?? [];
  const stale = new Set(stalePoolIds(pools, [...(actor.items ?? []), ...(actor.effects ?? [])].map(document => document.toObject(true))));
  if ( stale.size ) await actor.update({"system.pools": pools.filter(pool => !stale.has(pool.id))});
}

/**
 * Fill the generalized feature shapes in (`featureShapeFix`) from each Item's compendium copy: its own
 * `_stats.compendiumSource`, or else, on an Actor, the Item of the same converted source id on the Actor's compendium
 * copy (a summon's `flags.wildpath.summonSource`, which is all a summoned steed carries; or the Actor's own
 * `_stats.compendiumSource`). An Item with no copy found (homebrew, a pack no longer installed) is left as it is.
 * @param {object} game
 * @param {(uuid: string) => Promise<object|null>} [fromUuid]
 */
export async function fillFeatureShapes(game, fromUuid=globalThis.fromUuid) {
  const copies = new Map();
  const copy = uuid => {
    if ( (typeof uuid !== "string") || !uuid.startsWith("Compendium.") ) return null;
    // A pack no longer installed (a book module turned off) gives nothing.
    if ( !copies.has(uuid) ) copies.set(uuid, Promise.resolve().then(() => fromUuid(uuid)).then(document => document?.toObject?.(true) ?? null,
      () => null));
    return copies.get(uuid);
  };
  for ( const item of game.items ?? [] ) {
    const fix = featureShapeFix(item.toObject(true), await copy(item._stats?.compendiumSource));
    if ( fix ) await item.update(fix);
  }
  for ( const actor of everyActor(game) ) {
    const packActor = await copy(actor.flags?.wildpath?.summonSource ?? actor._stats?.compendiumSource);
    const updates = [];
    for ( const item of actor.items ?? [] ) {
      const source = item.toObject(true);
      const id = source.flags?.wildpath?.source?.id;
      const packItem = (await copy(source._stats?.compendiumSource))
        ?? (id ? (packActor?.items ?? []).find(entry => entry?.flags?.wildpath?.source?.id === id) : null) ?? null;
      const fix = featureShapeFix(source, packItem);
      if ( fix ) updates.push({_id: item.id, ...fix});
    }
    if ( updates.length ) await actor.updateEmbeddedDocuments("Item", updates);
  }
}

/** The migrations, oldest first. A new one takes the next version. */
export const MIGRATIONS = Object.freeze([
  {version: 1, name: "WILDPATH.MIGRATION.Threat", run: migrateThreat},
  {version: 2, name: "WILDPATH.MIGRATION.StalePools", run: pruneStalePools},
  {version: 3, name: "WILDPATH.MIGRATION.Fortitude", run: recordFortitude},
  {version: 4, name: "WILDPATH.MIGRATION.CreatureTypes", run: recordCreatureTypes},
  {version: 5, name: "WILDPATH.MIGRATION.FeatureShapes", run: game => fillFeatureShapes(game)}
]);

/**
 * Run the migrations this world has not had, on the active GM's client only.
 * @param {{game?: any, ui?: any, migrations?: ReadonlyArray<{version: number, name: string, run(game: any): Promise<void>}>}} [options]
 * @returns {Promise<number>} the version the world is at afterwards
 */
export async function runMigrations({game=globalThis.game, ui=globalThis.ui, migrations=MIGRATIONS}={}) {
  const done = Number(game.settings.get("wildpath", "migrationVersion")) || 0;
  if ( !game.user?.isGM || (game.users?.activeGM && (game.users.activeGM !== game.user)) ) return done;
  const pending = [...migrations].sort((a, b) => a.version - b.version).filter(migration => migration.version > done);
  if ( !pending.length ) return done;
  ui?.notifications?.info?.(game.i18n.localize("WILDPATH.MIGRATION.Start"));
  let version = done;
  for ( const migration of pending ) {
    try {
      await migration.run(game);
    } catch ( error ) {
      gmNotice("WILDPATH.MIGRATION.Failed", {name: game.i18n.localize(migration.name)}, error, {game, ui});
      return version;
    }
    version = migration.version;
    await game.settings.set("wildpath", "migrationVersion", version);
  }
  ui?.notifications?.info?.(game.i18n.localize("WILDPATH.MIGRATION.Done"));
  return version;
}
