/**
 * Chases (2024 DMG, 2026-10-22). The GM turns the running combat into a chase (a Token control; `flags.wildpath.chase`
 * on the Combat):
 * - Dashing: each creature freely Dashes 3 + its Fortitude modifier times in the chase; each Dash beyond takes a DC 10
 *   Fortitude check, and a failure gives it 1 Exhaustion level (its count: `flags.wildpath.chaseDashes`).
 * - Complications: at the end of each creature's turn a d20 is rolled; on 10 or lower the GM is told one befalls it.
 * - Ending the chase (or the combat) clears the counts.
 * shortcut: what a complication is, and escaping (hiding, outdistancing), are the GM's; upgrade with complication tables.
 */

const isActiveGM = game => game?.user?.isGM && (!game.users?.activeGM || (game.users.activeGM.id === game.user.id));
const inChase = combat => combat?.flags?.wildpath?.chase === true;

/** The Dashes a creature may take freely: 3 + its Fortitude modifier (at least 0). */
export const freeDashes = actor => Math.max(3 + Math.floor(((Number(actor?.system?.abilities?.fortitude?.value) || 10) - 10) / 2), 0);

/** After an Action in a chase: a Dash counts, and one past its free Dashes asks for its check. */
export async function afterChaseAction({options, state}, {game=globalThis.game}={}) {
  const actor = options?.actor;
  // The chase its creature is in, on whichever Scene.
  const chase = [...(game?.combats ?? []), game?.combat].find(combat => inChase(combat)
    && [...(combat.combatants ?? [])].some(combatant => combatant.actor?.uuid === actor?.uuid));
  if ( !actor || (state?.actionDefinition?.id !== "common:dash") || !chase || !isActiveGM(game) ) return null;
  const dashes = (Number(actor.flags?.wildpath?.chaseDashes) || 0) + 1;
  await actor.setFlag("wildpath", "chaseDashes", dashes);
  if ( dashes <= freeDashes(actor) ) return {dashes, free: true};
  const total = await actor.rollTest?.({ability: "fortitude"});
  const failed = !(Number(total) >= 10);
  if ( failed ) await actor.toggleCondition?.("exhaustion");
  return {dashes, free: false, failed};
}

/** At the end of a creature's turn in a chase: its complication roll, told to the GM. */
export async function chaseTurnEnded(combatant, {game=globalThis.game}={}) {
  if ( !inChase(combatant?.combat ?? game?.combat) || !isActiveGM(game) ) return null;
  const roll = await new Roll("1d20").evaluate();
  if ( roll.total <= 10 ) await ChatMessage.create({content: game.i18n.format("WILDPATH.CHASE.Complication", {name: combatant.name,
    total: roll.total}), whisper: ChatMessage.getWhisperRecipients("GM").map(user => user.id)});
  return roll.total;
}

/** The chase starts or stops on the running combat; stopping clears its creatures' Dash counts. */
async function toggleChase(game=globalThis.game) {
  const combat = game?.combat;
  if ( !combat ) return ui.notifications.warn(game.i18n.localize("WILDPATH.CHASE.NoCombat"));
  const chase = !inChase(combat);
  await combat.setFlag("wildpath", "chase", chase);
  if ( !chase ) await clearDashes(combat);
  await ChatMessage.create({content: game.i18n.localize(chase ? "WILDPATH.CHASE.Started" : "WILDPATH.CHASE.Ended")});
}

async function clearDashes(combat) {
  for ( const actor of new Set([...(combat?.combatants ?? [])].map(combatant => combatant.actor).filter(Boolean)) ) {
    if ( actor.flags?.wildpath?.chaseDashes ) await actor.unsetFlag("wildpath", "chaseDashes");
  }
}

export function registerChases() {
  globalThis.Hooks?.on?.("getSceneControlButtons", controls => {
    const tokens = controls?.tokens;
    if ( !tokens?.tools || !globalThis.game?.user?.isGM ) return;
    tokens.tools.chase = {name: "chase", title: "WILDPATH.CHASE.Title", icon: "fa-solid fa-person-running", button: true,
      order: Object.keys(tokens.tools).length + 1, onChange: () => void toggleChase()};
  });
  globalThis.Hooks?.on?.("deleteCombat", combat => { if ( inChase(combat) && isActiveGM(globalThis.game) ) void clearDashes(combat); });
}
