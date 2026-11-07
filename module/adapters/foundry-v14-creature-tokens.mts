/**
 * Where a creature is, on any Scene. Not `Actor#getActiveTokens` (only the Scene the canvas shows) nor `game.combat`
 * (the combat the tracker shows): the active GM, who resolves automation, may be viewing another Scene.
 */

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

/** One Token of `actor`: the one fighting in a started combat, else one on the active Scene, else its first; or null. */
export function creatureToken<T extends PlacedToken>(actor: Creature<T> | null | undefined,
  game: CombatsGame<FightingCombat> | null | undefined = (globalThis as {game?: CombatsGame<FightingCombat>}).game): T | null {
  const tokens = creatureTokens(actor);
  return tokens.find(token => combatOf(token, game)?.started) ?? tokens.find(token => token.parent?.active) ?? tokens[0] ?? null;
}
