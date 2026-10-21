/**
 * Party rest (2026-10-21): a GM tool among the Token controls that rests every player character at once, a Short Rest
 * (1 hour) or a Long Rest (8 hours), and moves the world's time on by that much, so what lasts hours runs out. Each
 * creature rests by its own rules (`Actor#rest`: 2024, a Long Rest at 0 Hit Points gives no benefit); its player spends
 * its Hit Dice from its sheet. An interrupted rest is the GM's call: resting again, or not at all.
 */

const HOURS = Object.freeze({shortRest: 1, longRest: 8});
const localize = key => globalThis.game?.i18n?.localize?.(key) ?? key;

/** The characters a player owns: those that rest with the party. */
export function partyMembers(actors=[]) {
  return [...actors].filter(actor => (actor?.type === "character") && actor.hasPlayerOwner);
}

/** Rest each of `actors` (`shortRest` or `longRest`), then move the world's time on; returns who rested. */
export async function restParty(kind, {actors=partyMembers(globalThis.game?.actors ?? []), time=globalThis.game?.time}={}) {
  if ( !HOURS[kind] ) return [];
  for ( const actor of actors ) await actor.rest(kind);
  await time?.advance?.(HOURS[kind] * 3600);
  return actors;
}

/** Ask the GM which rest, then take it, and say so in the chat. */
async function askAndRest() {
  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  const kind = await DialogV2?.wait?.({window: {title: localize("WILDPATH.REST.Party")}, content: `<p>${localize("WILDPATH.REST.PartyHint")}</p>`,
    buttons: [{action: "shortRest", label: localize("WILDPATH.REST.Short")}, {action: "longRest", label: localize("WILDPATH.REST.Long")},
      {action: "cancel", label: localize("Cancel")}]});
  if ( !HOURS[kind] ) return;
  const rested = await restParty(kind);
  await globalThis.ChatMessage?.create?.({content: globalThis.game.i18n.format("WILDPATH.REST.PartyRested",
    {rest: localize(kind === "longRest" ? "WILDPATH.REST.Long" : "WILDPATH.REST.Short"), names: rested.map(actor => actor.name).join(", ")})});
}

export function registerPartyRest() {
  globalThis.Hooks?.on?.("getSceneControlButtons", controls => {
    const tokens = controls?.tokens;
    if ( !tokens?.tools || !globalThis.game?.user?.isGM ) return;
    tokens.tools.partyRest = {name: "partyRest", title: "WILDPATH.REST.Party", icon: "fa-solid fa-campground", button: true,
      order: Object.keys(tokens.tools).length + 1, onChange: () => void askAndRest()};
  });
}
