/**
 * Ammunition (2024, 2026-10-21). A weapon with the Ammunition property names the kind it fires (`definition.ammunition`:
 * "arrow", "crossbowBolt", "slingBullet", "blowgunNeedle", "firearmBullet"); its character's gear of that kind (an
 * Item whose `flags.wildpath.source.subtype` is it) supplies it.
 * - An attack without any is refused (foundry-multiplayer-runtime.mjs); each attack spends one, on the authority.
 * - In combat, what it spends is counted on its creature (`flags.wildpath.ammunitionSpent`, by Item). When the combat
 *   ends, the GM is asked whether its creatures recover half of it (2024: "After a fight, you can spend 1 minute to
 *   recover half the ammunition, rounded down"). Only characters: a stat block's attacks need none.
 */

/** Its creature's gear of `kind` with some left, in its order. */
export function ammunitionOf(actor, kind) {
  return [...(actor?.items ?? [])].filter(item => (item.type === "gear") && (item.flags?.wildpath?.source?.subtype === kind)
    && ((Number(item.system?.quantity) || 0) > 0));
}

/** Whether an Action of `actor` needs ammunition it does not have. */
export function lacksAmmunition(actor, definition) {
  return Boolean(definition?.ammunition) && (actor?.type === "character") && !ammunitionOf(actor, definition.ammunition).length;
}

/** After an attack Action: one piece of its ammunition spent, and counted when in combat. */
export async function spendAmmunition({options, state}, {game}) {
  const kind = state?.actionDefinition?.ammunition;
  const actor = options?.actor;
  if ( !kind || (actor?.type !== "character") || !state?.actionDefinition?.attack ) return null;
  const [item] = ammunitionOf(actor, kind);
  if ( !item ) return null;
  await item.update({"system.quantity": (Number(item.system.quantity) || 0) - 1});
  if ( game?.combat?.started && [...(game.combat.combatants ?? [])].some(combatant => combatant.actor?.uuid === actor.uuid) ) {
    const spent = actor.flags?.wildpath?.ammunitionSpent ?? {};
    await actor.setFlag("wildpath", "ammunitionSpent", {...spent, [item.id]: (Number(spent[item.id]) || 0) + 1});
  }
  return item;
}

/** What each creature of `actors` spent this combat, and the half it may recover: `[{actor, item, spent, recover}]`. */
export function recoverable(actors=[]) {
  return [...new Set(actors.filter(Boolean))].flatMap(actor => Object.entries(actor.flags?.wildpath?.ammunitionSpent ?? {})
    .map(([itemId, spent]) => ({actor, item: actor.items?.get?.(itemId) ?? null, spent: Number(spent) || 0,
      recover: Math.floor((Number(spent) || 0) / 2)}))
    .filter(entry => entry.item));
}

/** When a combat ends, on the active GM: ask whether its creatures recover half the ammunition they spent. */
export async function offerAmmunitionRecovery(combat, {game}) {
  if ( !game?.user?.isGM || (game.users?.activeGM && (game.users.activeGM.id !== game.user.id)) ) return [];
  const actors = [...(combat?.combatants ?? [])].map(combatant => combatant.actor);
  const entries = recoverable(actors);
  if ( !entries.length ) return [];
  const lines = entries.map(({actor, item, spent, recover}) => `<li>${game.i18n.format("WILDPATH.AMMUNITION.Line",
    {name: actor.name, spent, item: item.name, recover})}</li>`).join("");
  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  const recover = await DialogV2?.confirm?.({window: {title: game.i18n.localize("WILDPATH.AMMUNITION.Title")},
    content: `<p>${game.i18n.localize("WILDPATH.AMMUNITION.Hint")}</p><ul>${lines}</ul>`});
  for ( const {actor, item, recover: count} of entries ) {
    if ( recover && count ) await item.update({"system.quantity": (Number(item.system.quantity) || 0) + count});
  }
  for ( const actor of new Set(entries.map(entry => entry.actor)) ) await actor.unsetFlag("wildpath", "ammunitionSpent");
  return recover ? entries : [];
}
