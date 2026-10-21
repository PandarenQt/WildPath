/**
 * 2024 Portent (Diviner): "Whenever you finish a Long Rest, roll two d20s and record the numbers rolled. You can replace
 * any D20 Test made by you or a creature that you can see with one of these foretelling rolls ... only once per turn."
 * By the maintainer's ruling (2026-10-20) it is used once the d20 is rolled, replacing it. Its dice are the Diviner's
 * `flags.wildpath.portent` (`{"1": 14, "2": 3}`: 0 is used); its turn the `portentTurn` flag. Its feature carries how
 * many it rolls (`flags.wildpath.portentDice`: three from level 14, Greater Portent).
 * - An Action's d20: the runtime offers each Diviner who may (portentOffer), the pipeline asks (portentReplace), and
 *   its die is spent once the Action completes (consumePortents).
 * - A sheet roll's or initiative's card: a Portent button for the Diviner's owner; the active GM applies it.
 */

import {evaluateValueExpression} from "../helpers/value-expressions.mjs";
import {combatTurnKey} from "../helpers/combat.mjs";
import {reactionPolicyOf} from "../helpers/automation-events.mjs";
import {relationsToSource} from "./foundry-v14-reaction-provider.mjs";

type Data = Record<string, any>;
export const PORTENT_QUERY = "wildpath.portent";

/** A foretelling roll not yet used. */
export interface PortentDie {slot: string; value: number}

/** Its foretelling rolls not yet used, by slot. */
export function portentDice(actor: Data | null | undefined): PortentDie[] {
  return Object.entries(actor?.flags?.wildpath?.portent ?? {}).map(([slot, value]) => ({slot, value: Math.trunc(Number(value))}))
    .filter(die => (die.value >= 1) && (die.value <= 20));
}

/** Its Portent feature: an active Item with `portentDice`, or null. */
export function portentFeature(actor: Data | null | undefined): Data | null {
  return [...(actor?.items ?? [])].find((item: Data) => (item.system?.active !== false) && item.flags?.wildpath?.portentDice) ?? null;
}

/** Whoever answers for a Diviner: its active players, else the active GM. */
export function portentAuthority(actor: Data, game: Data): {kind: "specific"; userIds: string[]} {
  const players = [...(game.users?.values?.() ?? [])].filter((user: Data) => user.active && !user.isGM && actor.testUserPermission?.(user, "OWNER"))
    .map((user: Data) => user.id);
  return {kind: "specific", userIds: [...players, game.users?.activeGM?.id].filter(Boolean)};
}

/**
 * The Diviners on its Scene who may replace a d20 that `rollerToken` (a TokenDocument) rolls now: with an unused die,
 * not used this turn, not set to Never (its feature's reaction policy), and the roller itself or seeing it
 * (relationsToSource: sight, light, walls). A GM-hidden roller is never offered to a player's Diviner.
 */
export function portentHolders(rollerToken: Data | null | undefined, game: Data): {actor: Data; token: Data; dice: PortentDie[]}[] {
  const scene = rollerToken?.parent;
  if ( !rollerToken || !scene?.tokens ) return [];
  const turn = combatTurnKey(game);
  const relations = relationsToSource(scene, {source: {tokenId: rollerToken.id}}) as Record<string, {sees: boolean}>;
  const holders = [];
  const seen = new Set<string>();
  for ( const token of scene.tokens as Iterable<Data> ) {
    const actor = token.actor;
    const feature = portentFeature(actor);
    const dice = portentDice(actor);
    if ( !feature || !dice.length || seen.has(actor.uuid) || ((reactionPolicyOf as (item: unknown) => string)(feature) === "never") ) continue;
    if ( (turn !== null) && (actor.flags?.wildpath?.portentTurn === turn) ) continue;
    if ( rollerToken.hidden && actor.hasPlayerOwner ) continue;
    if ( (token.id !== rollerToken.id) && !relations[token.id]?.sees ) continue;
    seen.add(actor.uuid);
    holders.push({actor, token, dice});
  }
  return holders;
}

/** Portent's offer for an Action's d20 rolled by `rollerToken` (`attack.portent`, `check.portent`, a save's), or null. */
export function portentOffer(rollerToken: Data | null | undefined, game: Data) {
  const holders = portentHolders(rollerToken, game);
  if ( !holders.length ) return null;
  const format = (key: string, data: Data) => game.i18n?.format?.(key, data) ?? key;
  return {holders: holders.map(({actor, dice}) => ({holderRef: actor.uuid, authority: portentAuthority(actor, game),
    label: format("WILDPATH.PORTENT.Offer", {name: actor.name ?? "", roller: rollerToken?.name ?? ""}),
    dice: dice.map(die => ({...die, label: format("WILDPATH.PORTENT.Use", {value: die.value})}))}))};
}

/** Spend a Diviner's die (its slot becomes 0) for this turn. */
export async function spendPortent(actor: Data | null | undefined, slot: string, game: Data) {
  if ( !actor ) return;
  if ( !(Number(actor.flags?.wildpath?.portent?.[slot]) > 0) ) console.warn(`Wild Path | ${actor.name}'s foretelling roll ${slot} was already used`);
  const turn = combatTurnKey(game);
  await actor.update({[`flags.wildpath.portent.${slot}`]: 0, ...(turn ? {"flags.wildpath.portentTurn": turn} : {})});
}

/**
 * The dice an Action's rolls used (their records' `portent`), spent once it completes (the active GM).
 * shortcut: spent after the commit, not in it; a failure to save the flag leaves the die unspent. Upgrade with a flag
 * mutation plan in the Action's transaction.
 */
export async function consumePortents({state}: {state?: Data} = {}, {game, fromUuid}: {game: Data; fromUuid: (uuid: string) => Promise<Data | null>}) {
  for ( const result of state?.rollResults ?? [] ) {
    const portent = result?.portent;
    if ( portent?.holderRef ) await spendPortent(await fromUuid(String(portent.holderRef)), String(portent.slot), game);
  }
}

/** After a Long Rest: its foretelling rolls, rolled anew (any unused ones are lost), shown to its owner and the GM. */
export async function rollPortentDice(actor: Data, game: Data) {
  const feature = portentFeature(actor);
  if ( !feature ) return;
  const count = Math.trunc(Number(evaluateValueExpression(feature.flags.wildpath.portentDice, {actor, actorSystem: actor.system}).value) || 0);
  if ( count < 1 ) return;
  const {Roll, ChatMessage} = globalThis as unknown as Data;
  const roll = await new Roll(`${count}d20`).evaluate();
  const values: number[] = roll.dice[0]?.results?.map((result: Data) => result.result) ?? [];
  await roll.toMessage({speaker: ChatMessage.getSpeaker({actor}), flavor: game.i18n.format("WILDPATH.PORTENT.Rolled",
    {name: feature.name ?? "", values: values.join(", ")})}, {messageMode: "gm"});
  const slots = Object.fromEntries(Array.from({length: Math.max(count, 3)}, (_, index) => [String(index + 1), values[index] ?? 0]));
  await actor.update({"flags.wildpath.portent": slots, "flags.wildpath.portentTurn": null});
}

/** A card's d20 with a foretelling roll in its place: the new total (its kept d20 out, `value` in). */
export function replacedTotal(roll: Data | null | undefined, value: number): number | null {
  const die = (roll?.dice ?? []).find((term: Data) => Number(term.faces) === 20);
  if ( !die || !Number.isFinite(Number(roll?.total)) ) return null;
  return Number(roll!.total) - Number(die.total) + value;
}

/**
 * The active GM replaces a card's d20 (a sheet roll's, an initiative roll's) with `holderUuid`'s die `slot`: a new card
 * with the total, the old one marked, the initiative updated, the die spent. Refused unless `user` owns the Diviner and
 * may use it on that roller now.
 */
async function applyToCard({messageId, holderUuid, slot}: Data, user: Data, game: Data, fromUuid: (uuid: string) => Promise<Data | null>) {
  const message = game.messages?.get(String(messageId));
  const holder = await fromUuid(String(holderUuid));
  const rollerToken = rollerTokenOf(message, game);
  const allowed = portentHolders(rollerToken, game).find(entry => entry.actor.uuid === holder?.uuid);
  const die = allowed?.dice.find(entry => entry.slot === String(slot));
  if ( !message || !holder || !die || !holder.testUserPermission?.(user, "OWNER") || message.flags?.wildpath?.portentUsed ) return {ok: false};
  const total = replacedTotal(message.rolls?.[0], die.value);
  if ( total === null ) return {ok: false};
  await spendPortent(holder, die.slot, game);
  await message.update({"flags.wildpath.portentUsed": true, ...(message.flags?.wildpath?.rollTest ? {"flags.wildpath.rollTest.rerolled": true} : {})});
  if ( message.flags?.core?.initiativeRoll ) {
    const combatant = game.combat?.combatants?.find((entry: Data) => entry.tokenId === rollerToken?.id);
    if ( combatant ) await combatant.update({initiative: total});
  }
  const {ChatMessage} = globalThis as unknown as Data;
  await ChatMessage.create({speaker: message.speaker, content: `<p>${game.i18n.format("WILDPATH.PORTENT.Replaced",
    {name: holder.name ?? "", value: die.value, total})}</p>`,
  flags: {wildpath: {portentFor: message.id, ...(message.flags?.wildpath?.rollTest
    ? {rollTest: {...message.flags.wildpath.rollTest, rerolled: true}} : {})}}});
  return {ok: true, total};
}

/** The Token that rolled a card (its speaker's), or null. */
function rollerTokenOf(message: Data | null | undefined, game: Data): Data | null {
  const speaker = message?.speaker ?? {};
  return speaker.token ? game.scenes?.get(speaker.scene)?.tokens?.get(speaker.token) ?? null : null;
}

/** The Portent button on sheet-roll and initiative cards, and the GM's query applying it. Called at `init`. */
export function registerPortent() {
  const {CONFIG, Hooks} = globalThis as unknown as Data;
  const fromUuid = (uuid: string) => (globalThis as unknown as Data).fromUuid(uuid) as Promise<Data | null>;
  CONFIG.queries[PORTENT_QUERY] = (data: Data, {user}: {user: Data}) => {
    const game = (globalThis as unknown as Data).game;
    return game.user.isGM ? applyToCard(data, user, game, fromUuid) : {ok: false};
  };
  Hooks.on("renderChatMessageHTML", (message: Data, html: HTMLElement) => {
    const game = (globalThis as unknown as Data).game;
    const flags = message.flags ?? {};
    if ( !((flags.wildpath?.rollTest && !flags.wildpath.rollTest.rerolled) || flags.core?.initiativeRoll) || flags.wildpath?.portentUsed ) return;
    // This user's own Diviners (a GM's: those no player owns).
    const mine = portentHolders(rollerTokenOf(message, game), game).filter(({actor}) => (game.user.isGM ? !actor.hasPlayerOwner : actor.isOwner));
    for ( const {actor, dice} of mine ) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wildpath-portent";
      button.textContent = game.i18n.format("WILDPATH.PORTENT.Button", {name: actor.name ?? ""});
      button.addEventListener("click", async () => {
        const slot = await chooseDie(dice);
        if ( !slot ) return;
        button.disabled = true;
        const data = {messageId: message.id, holderUuid: actor.uuid, slot};
        const result = game.user.isGM ? await applyToCard(data, game.user, game, fromUuid)
          : await game.users.activeGM?.query(PORTENT_QUERY, data, {timeout: 15000}).catch(() => ({ok: false}));
        if ( !result?.ok ) button.disabled = false;
      });
      (html.querySelector(".message-content") ?? html).append(button);
    }
  });
}

/** Which foretelling roll to use: its slot, or null when closed. */
async function chooseDie(dice: PortentDie[]): Promise<string | null> {
  const {foundry, game} = globalThis as unknown as Data;
  const options = dice.map(die => `<option value="${die.slot}">${die.value}</option>`).join("");
  const answer = await foundry.applications.api.DialogV2.input({classes: ["wildpath", "themed", "theme-light"], window: {title: game.i18n.localize("WILDPATH.PORTENT.Title")},
    content: `<label>${game.i18n.localize("WILDPATH.PORTENT.Choose")} <select name="slot">${options}</select></label>`,
    ok: {label: game.i18n.localize("WILDPATH.PORTENT.Replace")}, rejectClose: false});
  return answer?.slot ? String(answer.slot) : null;
}
