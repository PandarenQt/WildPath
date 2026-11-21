/**
 * Where a creature is, on any Scene. Not `Actor#getActiveTokens` (only the Scene the canvas shows) nor `game.combat`
 * (the combat the tracker shows): the active GM, who resolves automation, may be viewing another Scene.
 */
import {WILDPATH} from "../config.mjs";

interface PlacedToken {id?: string; parent?: {id?: string; active?: boolean} | null}
interface Creature<T> {isToken?: boolean; token?: T | null;
  getDependentTokens?(options: {linked?: boolean; concreteOnly?: boolean}): T[]}
interface PlacedCombatant {tokenId?: string | null; sceneId?: string | null}
interface FightingCombat<E extends PlacedCombatant = PlacedCombatant> {started?: boolean; combatants?: Iterable<E> | null}
interface CombatsGame<C> {combats?: Iterable<C> | null}

/** Every Token that is `actor` on any Scene: a synthetic Actor's own, else the world Actor's linked ones. */
export function creatureTokens<T extends PlacedToken>(actor: Creature<T> | null | undefined): T[] {
  if ( !actor ) return [];
  if ( actor.isToken ) return actor.token ? [actor.token] : [];
  return actor.getDependentTokens?.({linked: true, concreteOnly: true}) ?? [];
}

/** `token`'s Combatant (on its own Scene) in `combat`, or null. */
export function combatantOf<E extends PlacedCombatant>(token: PlacedToken | null | undefined,
  combat: FightingCombat<E> | null | undefined): E | null {
  if ( !token?.id ) return null;
  return [...(combat?.combatants ?? [])].find(entry => (entry.tokenId === token.id) && (entry.sceneId === token.parent?.id)) ?? null;
}

/** The combat holding `token`'s Combatant, a started one before one not begun yet (initiative comes first); or null. */
export function combatOf<C extends FightingCombat>(token: PlacedToken | null | undefined,
  game: CombatsGame<C> | null | undefined = (globalThis as {game?: CombatsGame<C>}).game): C | null {
  const holding = [...(game?.combats ?? [])].filter(combat => combatantOf(token, combat));
  return holding.find(combat => combat.started) ?? holding[0] ?? null;
}

/**
 * Whether `actor` is dead (Foundry's Defeated status, `CONFIG.specialStatusEffects.DEFEATED`): an object, no longer a
 * creature, so an area or an aura passes it by. An Action aimed at it alone still reaches it (Revivify).
 */
export function deadCreature(actor: {statuses?: Iterable<string> | null} | null | undefined): boolean {
  const defeated = (globalThis as {CONFIG?: {specialStatusEffects?: {DEFEATED?: string}}}).CONFIG?.specialStatusEffects?.DEFEATED ?? "dead";
  return new Set(actor?.statuses ?? []).has(defeated);
}

/**
 * The plane `actor` is on: the `plane` of the first of its statuses whose config (WILDPATH.CONDITIONS) names one (Ethereal's
 * "ethereal"), or null for the world everyone else is in. Two creatures reach each other only when their planes are equal:
 * neither targets the other, an area leaves out one on another plane, and it neither blocks, covers nor holds a space.
 * A status that `removes` its creature from the scene (Trapped) puts it on a plane of its own, so two held creatures
 * standing near each other don't reach each other either.
 */
export function planeOf(actor: {uuid?: string | null; statuses?: Iterable<string> | null} | null | undefined): string | null {
  const conditions = (WILDPATH as {CONDITIONS?: Record<string, {plane?: string; removes?: boolean} | undefined>}).CONDITIONS ?? {};
  const statuses = [...(actor?.statuses ?? [])];
  const removing = statuses.find(status => conditions[status]?.removes);
  if ( removing ) return `${conditions[removing]?.plane ?? removing}:${actor?.uuid ?? ""}`;
  for ( const status of statuses ) {
    const plane = conditions[status]?.plane;
    if ( plane ) return plane;
  }
  return null;
}

/** One Token of `actor`: the one fighting in a started combat, else one on the active Scene, else its first; or null. */
export function creatureToken<T extends PlacedToken>(actor: Creature<T> | null | undefined,
  game: CombatsGame<FightingCombat> | null | undefined = (globalThis as {game?: CombatsGame<FightingCombat>}).game): T | null {
  const tokens = creatureTokens(actor);
  return tokens.find(token => combatOf(token, game)?.started) ?? tokens.find(token => token.parent?.active) ?? tokens[0] ?? null;
}

/** When a lasting thing began (a summon, an area): its combat, round and turn, and the Combatant whose turn it was. */
export interface CombatStart {combatId: string; round: number; turn: number | null; combatantId?: string}
interface TurnCombat {id: string; round: number; turn: number | null; combatant?: {id?: string} | null; turns?: Array<{id?: string}> | null}

/** Where a lasting thing begins now in `combat`: its round, its turn and whose turn it is; null outside combat. */
export function combatStart(combat: TurnCombat | null | undefined): CombatStart | null {
  if ( !combat ) return null;
  const combatantId = combat.combatant?.id;
  return {combatId: combat.id, round: combat.round, turn: combat.turn, ...(combatantId ? {combatantId} : {})};
}

/**
 * Whether `rounds` rounds have passed since `start` at this turn of `combat`: from the start of the turn it began on,
 * that many rounds later. That turn is its Combatant's place now, since Combatants joining or leaving ahead of it move
 * it (a summon rolling its own Initiative, Q32); else the place recorded. In another combat, or outside one, none pass.
 */
export function roundsPassed(start: CombatStart | null | undefined, rounds: number, combat: TurnCombat | null | undefined) {
  if ( !combat || !start || (start.combatId !== combat.id) || !(rounds > 0) ) return false;
  const end = start.round + rounds;
  const placed = start.combatantId ? (combat.turns ?? []).findIndex(entry => entry.id === start.combatantId) : -1;
  return (combat.round > end) || ((combat.round === end) && ((combat.turn ?? 0) >= ((placed >= 0) ? placed : (start.turn ?? 0))));
}
