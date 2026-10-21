/**
 * Bastion turns (2024 DMG, 2026-10-22), a GM tool among the Token controls. Every 7 days of the world's time is a
 * Bastion turn: each player character's special facilities carry out the orders they were issued (its sheet's
 * Bastion section), and the chat lists them, each with what its facility does for that order. A character whose
 * facilities all maintain rolls for a Bastion event (d100). Then each facility's order goes back to "maintain".
 * shortcut: what an order yields (crafted items, recruited defenders, trade gold) and the event itself are the GM's, from
 * the facility's text and the event table; upgrade with each facility's results as Actions.
 */

/** A character's special facilities and the orders issued them this turn; `quiet` when every one maintains. */
export function bastionTurn(actor) {
  const special = [...(actor?.items ?? [])].filter(item => (item.type === "facility") && (item.system?.kind === "special"));
  const orders = special.filter(item => (item.system?.current?.order ?? "maintain") !== "maintain")
    .map(item => ({facility: item, order: item.system.current.order}));
  return {special, orders, quiet: special.length > 0 && !orders.length};
}

async function runBastionTurn() {
  const game = globalThis.game;
  const characters = [...game.actors].filter(actor => (actor.type === "character") && actor.hasPlayerOwner);
  const lines = [];
  for ( const actor of characters ) {
    const {special, orders, quiet} = bastionTurn(actor);
    if ( !special.length ) continue;
    for ( const {facility, order} of orders ) lines.push(game.i18n.format("WILDPATH.BASTION.Order", {name: actor.name, facility: facility.name,
      order: game.i18n.localize(`WILDPATH.BASTION.Orders.${order}`)}));
    if ( quiet ) {
      const roll = await new Roll("1d100").evaluate();
      lines.push(game.i18n.format("WILDPATH.BASTION.Event", {name: actor.name, total: roll.total}));
    }
    for ( const {facility} of orders ) await facility.update({"system.current.order": "maintain"});
  }
  await game.time?.advance?.(7 * 86400);
  await ChatMessage.create({content: `<h3>${game.i18n.localize("WILDPATH.BASTION.Turn")}</h3>${lines.length
    ? `<ul>${lines.map(line => `<li>${line}</li>`).join("")}</ul>` : `<p>${game.i18n.localize("WILDPATH.BASTION.Nothing")}</p>`}`});
}

export function registerBastions() {
  globalThis.Hooks?.on?.("getSceneControlButtons", controls => {
    const tokens = controls?.tokens;
    if ( !tokens?.tools || !globalThis.game?.user?.isGM ) return;
    tokens.tools.bastionTurn = {name: "bastionTurn", title: "WILDPATH.BASTION.Turn", icon: "fa-solid fa-chess-rook", button: true,
      order: Object.keys(tokens.tools).length + 1, onChange: () => void runBastionTurn()};
  });
}
