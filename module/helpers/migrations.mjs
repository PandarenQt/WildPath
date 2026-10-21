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
  const texts = documents.map(document => JSON.stringify(document ?? {}));
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
  if ( (source?.type !== "npc") || !Number.isFinite(challenge) ) return null;
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

/** The migrations, oldest first. A new one takes the next version. */
export const MIGRATIONS = Object.freeze([
  {version: 1, name: "WILDPATH.MIGRATION.Threat", run: migrateThreat},
  {version: 2, name: "WILDPATH.MIGRATION.StalePools", run: pruneStalePools},
  {version: 3, name: "WILDPATH.MIGRATION.Fortitude", run: recordFortitude},
  {version: 4, name: "WILDPATH.MIGRATION.CreatureTypes", run: recordCreatureTypes}
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
