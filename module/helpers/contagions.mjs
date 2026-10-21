/**
 * Magical contagions (2024 DMG, SRD 5.2; 2026-10-22). A contagion is an effect on its creature naming one of these
 * (`metadata.contagion`), given by an infecting Action's failed save. Its state lives on that effect
 * (`flags.wildpath.contagion`): when its symptoms start (`onsetAt`, world time), whether they have, the Exhaustion it
 * gave, and its successes. adapters/foundry-v14-contagions.mjs runs it.
 * - `incubation`: days until its symptoms start (rolled when it is caught); none starts them at once.
 * - `onset`: what its symptoms are: Exhaustion levels, a condition.
 * - `fight`: its save after each Long Rest (`successes`: that many end it; `failure`/`success`: Exhaustion it adds or
 *   takes away, and at no Exhaustion it ends).
 * - `holdsExhaustion`: a Long Rest does not lower its creature's Exhaustion; `noRestHealing`: nor restore its Hit Points.
 * shortcut: Cackle Fever's laughter when hurt, the Hit Point Dice Sewer Plague halves, Sight Rot's ointment, spreading
 * them, and Sewer Plague's save at dawn rather than after a Long Rest are by hand; upgrade with damage triggers on effects
 * and a dawn event.
 */
export const CONTAGIONS = Object.freeze({
  "cackle-fever": {name: "Cackle Fever", incubation: {number: 1, faces: 4}, onset: {exhaustion: 1},
    fight: {ability: "fortitude", dc: 13, successes: 3}, holdsExhaustion: true},
  "sewer-plague": {name: "Sewer Plague", incubation: {number: 1, faces: 4}, onset: {exhaustion: 1},
    fight: {ability: "fortitude", dc: 11, success: -1, failure: 1}, holdsExhaustion: true, noRestHealing: true},
  // "have the Blinded condition until the contagion ends"; a Heal or Lesser Restoration ending it ends the contagion.
  "sight-rot": {name: "Sight Rot", incubation: null, onset: {condition: "blinded"}, fight: null}
});

/**
 * One save fighting a contagion (`state`: its flag): the Exhaustion it changes (`exhaustion`), its new state, and
 * whether it ends. `exhaustionLevel` is its creature's after that change, for one that ends at none.
 */
export function fightContagion(id, state={}, success=false, {exhaustionLevel=0}={}) {
  const fight = CONTAGIONS[id]?.fight;
  if ( !fight ) return {exhaustion: 0, state, ended: false};
  if ( fight.successes ) {
    const successes = (Number(state.successes) || 0) + (success ? 1 : 0);
    return {exhaustion: 0, state: {...state, successes}, ended: successes >= fight.successes};
  }
  const exhaustion = success ? (fight.success ?? 0) : (fight.failure ?? 0);
  return {exhaustion, state, ended: success && ((exhaustionLevel + exhaustion) <= 0)};
}
