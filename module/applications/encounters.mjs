import {encounterDifficulty, levelForXp, xpForThreat} from "../helpers/encounters.mjs";

/**
 * Encounters in play (2026-10-22, helpers/encounters.mjs), for the GM:
 * - the combat tracker names the running combat's difficulty: its hostile creatures' XP against its player characters'
 *   budgets (2024 Low, Moderate, High);
 * - when a combat ends, with the `advancement` setting at XP, the GM is asked to award the XP of the hostile creatures
 *   it defeated, split among its player characters, and told who may level up.
 */

const localize = key => globalThis.game?.i18n?.localize?.(key) ?? key;
const hostile = combatant => (Number(combatant.token?.disposition) < 0) && (combatant.actor?.type === "npc");
const party = combat => [...(combat?.combatants ?? [])].map(combatant => combatant.actor)
  .filter(actor => (actor?.type === "character") && actor.hasPlayerOwner);

/** A combat's difficulty for its party: `{xp, budgets, difficulty}`, or null without both sides. */
export function combatDifficulty(combat) {
  const foes = [...(combat?.combatants ?? [])].filter(hostile);
  const members = party(combat);
  if ( !foes.length || !members.length ) return null;
  return encounterDifficulty({levels: members.map(actor => actor.system?.details?.level ?? 1),
    threats: foes.map(combatant => combatant.actor.system?.details?.threat ?? 0)});
}

/** The XP a combat's defeated foes give, and each party member's share. */
export function combatAward(combat) {
  const members = party(combat);
  const xp = [...(combat?.combatants ?? [])].filter(combatant => hostile(combatant)
    && (combatant.defeated || combatant.actor?.statuses?.has?.("dead")))
    .reduce((total, combatant) => total + xpForThreat(combatant.actor.system?.details?.threat), 0);
  return {xp, members, each: members.length ? Math.floor(xp / members.length) : 0};
}

async function offerAward(combat) {
  const game = globalThis.game;
  if ( !game?.user?.isGM || (game.users?.activeGM && (game.users.activeGM.id !== game.user.id)) ) return;
  if ( game.settings.get("wildpath", "advancement") !== "xp" ) return;
  const {xp, members, each} = combatAward(combat);
  if ( !xp || !each ) return;
  const award = await globalThis.foundry?.applications?.api?.DialogV2?.confirm?.({window: {title: localize("WILDPATH.ENCOUNTER.Award")},
    content: `<p>${game.i18n.format("WILDPATH.ENCOUNTER.AwardHint", {xp, each, names: members.map(actor => actor.name).join(", ")})}</p>`});
  if ( !award ) return;
  const ready = [];
  for ( const actor of members ) {
    const total = (Number(actor.system?.details?.xp) || 0) + each;
    await actor.update({"system.details.xp": total});
    if ( levelForXp(total) > (Number(actor.system?.details?.level) || 1) ) ready.push(actor.name);
  }
  await globalThis.ChatMessage?.create?.({content: game.i18n.format("WILDPATH.ENCOUNTER.Awarded", {each, names: members.map(actor => actor.name)
    .join(", ")}) + (ready.length ? ` ${game.i18n.format("WILDPATH.ENCOUNTER.LevelUp", {names: ready.join(", ")})}` : "")});
}

/** Its difficulty atop the combat tracker, for the GM. */
function showDifficulty(app, element) {
  const game = globalThis.game;
  const root = element instanceof HTMLElement ? element : element?.[0];
  if ( !game?.user?.isGM || !root ) return;
  root.querySelector(".wildpath-encounter")?.remove();
  const difficulty = combatDifficulty(app.viewed ?? game.combat);
  if ( !difficulty ) return;
  const line = globalThis.document.createElement("div");
  line.className = "wildpath-encounter";
  line.textContent = game.i18n.format("WILDPATH.ENCOUNTER.Difficulty", {difficulty: localize(`WILDPATH.ENCOUNTER.${difficulty.difficulty}`),
    xp: difficulty.xp, low: difficulty.budgets.low, moderate: difficulty.budgets.moderate, high: difficulty.budgets.high});
  (root.querySelector(".combat-tracker-header, header") ?? root).append(line);
}

export function registerEncounters() {
  globalThis.Hooks?.on?.("renderCombatTracker", showDifficulty);
  globalThis.Hooks?.on?.("deleteCombat", combat => void offerAward(combat));
}
