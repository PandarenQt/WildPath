/**
 * Where a creature is, on any Scene. Not `Actor#getActiveTokens` (only the Scene the canvas shows) nor `game.combat`
 * (the combat the tracker shows): the active GM, who resolves automation, may be viewing another Scene.
 */
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
/** One Token of `actor`: the one fighting in a started combat, else one on the active Scene, else its first; or null. */
export function creatureToken(actor, game = globalThis.game) {
    const tokens = creatureTokens(actor);
    return tokens.find(token => combatOf(token, game)?.started) ?? tokens.find(token => token.parent?.active) ?? tokens[0] ?? null;
}
