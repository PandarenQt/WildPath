/**
 * Where a creature is, on any Scene. Not `Actor#getActiveTokens` (only the Scene the canvas shows) nor `game.combat`
 * (the combat the tracker shows): the active GM, who resolves automation, may be viewing another Scene.
 */
import { WILDPATH } from "../config.mjs";
/** Every Token that is `actor` on any Scene: a synthetic Actor's own, else the world Actor's linked ones. */
export function creatureTokens(actor) {
    if (!actor)
        return [];
    if (actor.isToken)
        return actor.token ? [actor.token] : [];
    return actor.getDependentTokens?.({ linked: true, concreteOnly: true }) ?? [];
}
/** `token`'s Combatant (on its own Scene) in `combat`, or null. */
export function combatantOf(token, combat) {
    if (!token?.id)
        return null;
    return [...(combat?.combatants ?? [])].find(entry => (entry.tokenId === token.id) && (entry.sceneId === token.parent?.id)) ?? null;
}
/** The combat holding `token`'s Combatant, a started one before one not begun yet (initiative comes first); or null. */
export function combatOf(token, game = globalThis.game) {
    const holding = [...(game?.combats ?? [])].filter(combat => combatantOf(token, combat));
    return holding.find(combat => combat.started) ?? holding[0] ?? null;
}
/**
 * Whether `actor` is dead (Foundry's Defeated status, `CONFIG.specialStatusEffects.DEFEATED`): an object, no longer a
 * creature, so an area or an aura passes it by. An Action aimed at it alone still reaches it (Revivify).
 */
export function deadCreature(actor) {
    const defeated = globalThis.CONFIG?.specialStatusEffects?.DEFEATED ?? "dead";
    return new Set(actor?.statuses ?? []).has(defeated);
}
/**
 * The plane `actor` is on: the `plane` of the first of its statuses whose config (WILDPATH.CONDITIONS) names one (Ethereal's
 * "ethereal"), or null for the world everyone else is in. Two creatures reach each other only when their planes are equal:
 * neither targets the other, an area leaves out one on another plane, and it neither blocks, covers nor holds a space.
 */
export function planeOf(actor) {
    const conditions = WILDPATH.CONDITIONS ?? {};
    for (const status of actor?.statuses ?? []) {
        const plane = conditions[status]?.plane;
        if (plane)
            return plane;
    }
    return null;
}
/** One Token of `actor`: the one fighting in a started combat, else one on the active Scene, else its first; or null. */
export function creatureToken(actor, game = globalThis.game) {
    const tokens = creatureTokens(actor);
    return tokens.find(token => combatOf(token, game)?.started) ?? tokens.find(token => token.parent?.active) ?? tokens[0] ?? null;
}
/** Where a lasting thing begins now in `combat`: its round, its turn and whose turn it is; null outside combat. */
export function combatStart(combat) {
    if (!combat)
        return null;
    const combatantId = combat.combatant?.id;
    return { combatId: combat.id, round: combat.round, turn: combat.turn, ...(combatantId ? { combatantId } : {}) };
}
/**
 * Whether `rounds` rounds have passed since `start` at this turn of `combat`: from the start of the turn it began on,
 * that many rounds later. That turn is its Combatant's place now, since Combatants joining or leaving ahead of it move
 * it (a summon rolling its own Initiative, Q32); else the place recorded. In another combat, or outside one, none pass.
 */
export function roundsPassed(start, rounds, combat) {
    if (!combat || !start || (start.combatId !== combat.id) || !(rounds > 0))
        return false;
    const end = start.round + rounds;
    const placed = start.combatantId ? (combat.turns ?? []).findIndex(entry => entry.id === start.combatantId) : -1;
    return (combat.round > end) || ((combat.round === end) && ((combat.turn ?? 0) >= ((placed >= 0) ? placed : (start.turn ?? 0))));
}
