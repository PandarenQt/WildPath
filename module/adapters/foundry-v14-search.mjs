/**
 * Finding the hidden (2024 Search, Q18.2): a check of a skill its Action `finds` (`metadata.test.finds`: Search's Wisdom
 * (Perception)) ends every condition instance with a numeric `metadata.foundDC` its total meets (Hide's Invisible keeps its
 * Stealth total: common-actions.mts and the pipeline's withFoundDCs) on each creature but the searcher's allies whose
 * space its Token sees (tokenSees `space`), a GM-hidden Token aside: Q91 (a) and (b) defaults, being found ending it for
 * everyone. A hidden creature's `perceived` roll modes (the Cloak of Elvenkind's Disadvantage) count against it alone,
 * beside the searcher's own: its d20 is the searcher's with fresh dice where the modes differ (perceivedRoll,
 * perceivedTotal; Q91 (d) default). The active GM ends them (findHidden), reading the check from the card the Action's
 * roll posted (searchCheckOf), once per card; another client names the card to it (SEARCH_QUERY).
 * Other uses: a fixed `foundDC` on any condition (a homebrew camouflage), another Action whose test `finds`.
 */
import { combineRollModes } from "../helpers/rolls.mjs";
import { claimCard, isRecentRoll } from "../helpers/chat-card-view-model.mjs";
import { requestShownDice } from "./foundry-digital-roll-provider.mjs";
import { tokenSees } from "./foundry-v14-senses.mjs";
export const SEARCH_QUERY = "wildpath.search";
const MODES = ["normal", "advantage", "disadvantage"];
const gameOf = () => globalThis.game;
/** The DC a search must meet to end it; none unless a number (an unresolved "check" is never found). */
const foundDC = (effect) => {
    const dc = effect.flags?.wildpath?.conditionEffect?.metadata?.foundDC;
    return (typeof dc === "number") && Number.isFinite(dc) ? dc : null;
};
/**
 * The fresh dice a creature whose own modes make `net` needs beside a check rolled with `rolled`: none when they match;
 * one d20 beside a normal roll's (the lower or the higher of the two counts) or in place of a roll that kept one side's
 * die when `net` is normal; two in its place for the opposite mode, as it kept the other die of its two.
 */
export function perceivedRoll(rolled, net) {
    if (net === rolled)
        return null;
    if ((rolled === "normal") || (net === "normal"))
        return "1d20";
    return (net === "advantage") ? "2d20kh" : "2d20kl";
}
/** The check's total against that creature, with what perceivedRoll's dice came to (`fresh`; null when none were needed). */
export function perceivedTotal(check, net, fresh) {
    const floor = Number(check.naturalMinimum) || 0;
    const counted = (die) => Math.max(die, floor);
    const minimum = Number(check.totalMinimum) || -Infinity;
    // shortcut: a typed total with no natural d20 keeps that total; upgrade if a physical roller can skip the die.
    if ((fresh == null) || (check.natural == null))
        return Math.max(check.total, minimum);
    const d20 = (check.rollMode !== "normal") ? fresh : (net === "advantage") ? Math.max(check.natural, fresh) : Math.min(check.natural, fresh);
    return Math.max(check.total - counted(check.natural) + counted(d20), minimum);
}
/** A creature's fresh dice, rolled by the GM's dice and shown to the GM alone (it may stay hidden). */
async function rollFresh(formula, name) {
    const game = gameOf();
    const flavor = game.i18n.format("WILDPATH.SEARCH.Against", { name });
    const shown = await requestShownDice(formula, { title: flavor });
    if (!shown)
        return null;
    await shown.roll.toMessage({ flavor }, { messageMode: "gm" });
    return Number(shown.result.total);
}
/**
 * On the authority: what `check` by `token`'s creature finds, each creature found losing the instances whose `foundDC` its
 * total meets. A creature whose fresh dice are closed unrolled is not judged. Returns the Tokens found.
 */
export async function findHidden(token, check, { roll = rollFresh } = {}) {
    const scene = token.parent;
    const found = [];
    for (const other of [...(scene?.tokens ?? [])]) {
        const actor = other.actor;
        // Being found ends it for everyone (Q91 (b)), so an ally (one disposition, as alliedTokens) finds no one; a neutral may.
        const allied = ((token.disposition ?? 0) * (other.disposition ?? 0) > 0) && (token.disposition === other.disposition);
        if (!actor || (other.id === token.id) || other.hidden || allied)
            continue;
        const hiding = [...(actor.effects ?? [])].filter(effect => !effect.disabled && (foundDC(effect) !== null));
        if (!hiding.length || !tokenSees(scene, token, other, { space: true }))
            continue;
        const net = combineRollModes([...check.rollModes, ...(actor.getRollModes?.(["perceived"]) ?? [])]);
        const formula = perceivedRoll(check.rollMode, net);
        const fresh = formula ? await roll(formula, other.name ?? "") : null;
        if (formula && (fresh == null))
            continue;
        const total = perceivedTotal(check, net, fresh);
        const ended = hiding.filter(effect => foundDC(effect) <= total).map(effect => effect.id);
        if (!ended.length)
            continue;
        await actor.deleteEmbeddedDocuments?.("ActiveEffect", ended);
        found.push(other);
    }
    return found;
}
/**
 * The check an Action's card holds (the query's trust boundary): its roll's total and kept d20, and the sources' modes and
 * floors its rollTest flags name; null unless the card was rolled to search (`search`) and holds a roll.
 */
export function searchCheckOf(card) {
    const test = card?.flags?.wildpath?.rollTest;
    const roll = card?.rolls?.[0];
    if (!test?.search || (typeof roll?.total !== "number") || !Number.isFinite(roll.total))
        return null;
    const natural = Number(roll.dice?.find(term => Number(term.faces) === 20)?.results?.find(result => result.active)?.result);
    const rollModes = (Array.isArray(test.rollModes) ? test.rollModes : []).map(String).filter(mode => MODES.includes(mode));
    const floor = (value) => ((Number(value) > 1) ? Number(value) : null);
    return { total: roll.total, natural: (Number.isInteger(natural) && (natural >= 1) && (natural <= 20)) ? natural : null,
        rollMode: combineRollModes(rollModes), rollModes, naturalMinimum: floor(test.naturalMinimum), totalMinimum: floor(test.totalMinimum) };
}
/**
 * Who searches with `card` and with what check, when `user` may: a recent, unsearched card of a check rolled to search,
 * spoken by a Token whose creature rolled it and `user` owns. Null otherwise.
 */
function cardSearch(card, user) {
    const check = searchCheckOf(card);
    const speaker = card?.speaker ?? {};
    const token = (check && speaker.scene && speaker.token) ? gameOf().scenes?.get(speaker.scene)?.tokens?.get(speaker.token) ?? null : null;
    if (!card || !check || !token?.actor || (token.actor.uuid !== card.flags?.wildpath?.rollTest?.actorUuid) || card.flags?.wildpath?.searched
        || !isRecentRoll(card) || !token.actor.testUserPermission?.(user, "OWNER"))
        return null;
    return { token, check };
}
/**
 * The active GM's search from `card` for `user`: once per card (marked `searched` first), then a public card naming who
 * was found (none when no one was: the hidden stay unnamed). Null when refused.
 */
export async function searchCard(card, user, { roll = rollFresh } = {}) {
    if (!card || !cardSearch(card, user))
        return null;
    return claimCard(card, async () => {
        const search = cardSearch(card, user);
        if (!search)
            return null;
        await card.update?.({ "flags.wildpath.searched": true });
        const { token, check } = search;
        const found = await findHidden(token, check, { roll });
        if (!found.length)
            return found;
        const { ChatMessage, foundry } = globalThis;
        const text = gameOf().i18n.format("WILDPATH.SEARCH.Found", { name: token.name ?? "", found: found.map(other => other.name ?? "").join(", ") });
        await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ token }), content: `<p>${foundry.utils.escapeHTML(text)}</p>` });
        return found;
    });
}
/**
 * From the searcher's client once its check's card is posted (documents/item.mjs): the active GM searches from it, here or
 * asked. The GM answers at once, as its fresh dice may wait on a prompt longer than a query lives.
 */
export async function searchHidden(messageId) {
    const game = gameOf();
    if (game.users?.activeGM?.id === game.user?.id)
        return void await searchCard(game.messages?.get(messageId), game.user);
    await game.users?.activeGM?.query?.(SEARCH_QUERY, { messageId }, { timeout: 15000 })?.catch(() => null);
}
/** The GM's query handler: a search from a card its server-attested sender may search with. Called at `init`. */
export function registerSearch() {
    const { CONFIG } = globalThis;
    CONFIG.queries[SEARCH_QUERY] = (data = {}, { user } = {}) => {
        const game = gameOf();
        const card = game.user?.isGM ? game.messages?.get(String(data.messageId)) : null;
        if (!cardSearch(card, user))
            return { ok: false };
        void searchCard(card, user).catch(error => console.warn("Wild Path | The search failed", error));
        return { ok: true };
    };
}
