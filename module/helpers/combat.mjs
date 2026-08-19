/**
 * Resolve the Combatant whose turn is beginning from a combat turn-change update.
 *
 * The `combatTurn`/`combatStart` hooks fire *before* the update is applied to the Combat
 * document, so `combat.combatant` may still reference the outgoing combatant at the moment the
 * hook runs - resolve the incoming combatant directly from the update's `turn` index instead.
 * Pure function (only ever touches plain properties on the objects it is given) so it is
 * directly unit-testable without a running Foundry client.
 * @param {{turns?: object[], turn?: number, combatant?: object}} combat
 * @param {{turn?: number}} [updateData]
 * @returns {object|undefined}
 */
export function getIncomingCombatant(combat, updateData) {
  const turn = updateData?.turn ?? combat.turn;
  return combat.turns?.[turn] ?? combat.combatant;
}
