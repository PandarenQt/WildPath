/**
 * Test offers on a sheet roll's or an initiative roll's card (Q35; Q101 defaults). A check or save rolled from the sheet
 * (`Actor#rollTest`) and an initiative roll (`WildPathCombat#rollInitiative`) commit nothing, so their card offers what
 * an Action's d20 is offered after the roll (the runtime's withAddedDice, withTestOffers and withAllyTestOffers: a
 * feature's `flags.wildpath.testOffer`, an effect's added die, an ally's ranged offer), a button each for whoever decides
 * it (the roller's owner, or an ally offer's bearer's), as Portent and Heroic Inspiration do.
 * - A sheet roll has no DC, so an option needing a failure asks "did it fail?" first; one with `anyResult` does not.
 *   Initiative cannot fail: it is offered only `anyResult` options (Q101 (b) default), as an Agility check
 *   (`check.initiative: true` in its context).
 * - A die is rolled by the dice policy on the clicking client; a die spent only if the roll then succeeds
 *   (`refundOnFail`) asks again once rolled and is not spent on "still fails" (Q101 (c) default).
 * - The active GM claims the card (claimCard, shared with Portent and Heroic Inspiration), finds the option again from
 *   what the creatures hold now, marks the card, pays (`serializeActorWrite`), posts the new total and sets the
 *   Combatant's initiative. A reroll is then rolled by the clicking client (`Actor#rollTest`, as Heroic Inspiration's).
 * - Not offered: a foe's option (Q101 (d) default; `succeededOnly`), an attack's hit (`forceHit`), and an option for a natural
 *   the card's d20 does not show. shortcut: an initiative roll gets no reroll or "succeed instead", and Combatant#
 *   rollInitiative (one Combatant, no card) gets nothing; upgrade when an initiative offer needs one.
 */
import { claimCard, isRecentRoll } from "../helpers/chat-card-view-model.mjs";
import { commitActorResourceMutationPlan } from "../resolvers/resource-resolver.mjs";
import { serializeActorWrite } from "../resolvers/target-mutation-commit-resolver.mjs";
import { foundryActorSystemSnapshot } from "../adapters/foundry-v14-actor-system-adapter.mjs";
import * as runtime from "../resolvers/foundry-multiplayer-runtime.mjs";
import { replacedTotal } from "../adapters/foundry-v14-portent.mjs";
import { combatantOf, combatOf } from "../adapters/foundry-v14-creature-tokens.mjs";
import { requestShownDice } from "../adapters/foundry-digital-roll-provider.mjs";
export const TEST_OFFER_QUERY = "wildpath.testOffer";
const globals = () => globalThis;
// Its option builders, typed loosely: their JavaScript defaults would otherwise narrow what they take.
const { checkContext, saveContext, withAddedDice, withAllyTestOffers, withTestOffers } = runtime;
/** Whether a card may still be offered: an unrerolled sheet roll or an initiative roll, recent, not changed yet. */
function offerable(message) {
    const flags = message.flags ?? {};
    return Boolean(((flags.wildpath?.rollTest && !flags.wildpath.rollTest.rerolled) || flags.core?.initiativeRoll)
        && !flags.wildpath?.testOfferUsed && !flags.wildpath?.portentUsed && isRecentRoll(message));
}
/** A card's roll (cardTest's shape), or null for any other card or a creature no longer there. */
export function cardTest(message, game) {
    const flags = message?.flags ?? {};
    const speaker = message?.speaker ?? {};
    const token = speaker.token ? game.scenes?.get(speaker.scene)?.tokens?.get(speaker.token) ?? null : null;
    const rolled = flags.wildpath?.rollTest;
    if (rolled?.actorUuid) {
        const actor = globals().fromUuidSync(rolled.actorUuid);
        if (!actor)
            return null;
        if (rolled.save)
            return { actor, token, test: "save", initiative: false,
                context: saveContext(null, rolled.save, token, { saver: actor, game }).context };
        return { actor, token, test: "check", initiative: false,
            context: { tags: [], check: checkContext(actor, { ability: rolled.ability ?? null, skill: rolled.skill ?? null }) } };
    }
    if (!flags.core?.initiativeRoll)
        return null;
    const actor = token?.actor ?? game.actors?.get(speaker.actor) ?? null;
    return actor ? { actor, token, test: "check", initiative: true,
        context: { tags: [], check: { ...checkContext(actor, { ability: "agility" }), initiative: true } } } : null;
}
/** What an option does to the card: a die, a number, a set d20, a save succeeding instead, or a reroll. */
function kindOf(option) {
    return option.succeed ? "succeed" : option.addDice ? "dice" : (option.addFlat != null) ? "flat"
        : (Number(option.setNatural) > 0) ? "natural" : "reroll";
}
/** The card's options, from what its creatures hold now (cardTest's notes say which are left out). */
export function cardOffers(message, card, game) {
    const { actor, token, test, context, initiative } = card;
    let system;
    try {
        system = foundryActorSystemSnapshot(actor);
    }
    catch {
        return [];
    }
    const own = withTestOffers(withAddedDice(null, actor, game, { test, context, target: { actorRef: actor.uuid } }), actor, system, game, test, { context });
    const offer = token ? withAllyTestOffers(own, token, {}, game, test, { context }) : own;
    // The help a sheet check already rolled in (Inspiring Help's Assist, Actor#rollTest) is not offered again.
    const folded = new Set((message.flags?.wildpath?.rollTest?.folded ?? []).map((id) => `add:${id}`));
    const natural = Number((message.rolls?.[0]?.dice ?? []).find((die) => Number(die.faces) === 20)?.total) || 0;
    return (offer?.options ?? []).filter(option => !option.succeededOnly && !option.forceHit
        && !folded.has(option.value) && (!(Number(option.natural) > 0) || (Number(option.natural) === natural))
        && (!initiative || (option.anyResult && !["succeed", "reroll"].includes(kindOf(option)))));
}
/** Who decides an option: an ally offer's bearer (it carries its `authority`), else the roller. */
function deciderOf(option, roller) {
    return option.authority ? globals().fromUuidSync(option.payerRef) : roller;
}
/** The card's total with `added`, at least its floor (Indomitable Might). */
function addedTotal(message, added) {
    const total = Number(message.rolls?.[0]?.total);
    if (!Number.isFinite(total))
        return null;
    return Math.max(total + added, Number(message.flags?.wildpath?.rollTest?.totalMinimum) || -Infinity);
}
async function applyToCard(data, user, game) {
    const message = game.messages?.get(String(data.messageId));
    return (message && await claimCard(message, () => applyClaimed(message, data, user, game))) || { ok: false };
}
/**
 * The active GM uses option `data.value` on the card for `user`, who must decide it: the card marked, the option paid
 * (unless `data.pay` is false for a `refundOnFail` option: it still fails), the new total posted and, on an initiative
 * card, set on its Combatant. A die's total (`data.rolled`) must be one its dice can show.
 */
async function applyClaimed(message, data, user, game) {
    const card = offerable(message) ? cardTest(message, game) : null;
    if (!card)
        return { ok: false };
    const find = () => cardOffers(message, card, game).find(option => option.value === data.value) ?? null;
    const option = find();
    if (!option || !deciderOf(option, card.actor)?.testUserPermission?.(user, "OWNER"))
        return { ok: false };
    const kind = kindOf(option);
    const { number = 1, faces = 0 } = option.addDice ?? {};
    const rolled = Math.trunc(Number(data.rolled));
    if ((kind === "dice") && !((rolled >= number) && (rolled <= number * faces)))
        return { ok: false };
    const added = (kind === "dice") ? rolled : (kind === "flat") ? Number(option.addFlat) : 0;
    const total = (kind === "natural") ? replacedTotal(message.rolls?.[0], Number(option.setNatural), Number(message.flags?.wildpath?.rollTest?.totalMinimum) || null) : ["dice", "flat"].includes(kind) ? addedTotal(message, added) : null;
    if (["dice", "flat", "natural"].includes(kind) && (total === null))
        return { ok: false };
    const pay = !option.refundOnFail || (data.pay !== false);
    const payer = option.payerRef ? globals().fromUuidSync(option.payerRef) : card.actor;
    const rollTest = message.flags?.wildpath?.rollTest;
    // The card is marked before anything is spent, and given back if the payment fails: written false, not put back to
    // unset as writeInOrder would (an undefined value is dropped from the update, so `testOfferUsed` would stay).
    const mark = (used) => message.update({ "flags.wildpath.testOfferUsed": used,
        ...(rollTest ? { "flags.wildpath.rollTest.rerolled": used } : {}) });
    await mark(true);
    if (pay && payer)
        try {
            await serializeActorWrite(payer, async () => {
                // Planned again from what its payer holds now: one write at a time per creature.
                const fresh = find();
                if (fresh?.plan) {
                    if (!(await commitActorResourceMutationPlan(payer, fresh.plan)))
                        throw new Error(`${payer.name}'s ${option.name} could not be paid.`);
                }
                else if (fresh?.payment?.existingEffectId)
                    await card.actor.effects?.get(fresh.payment.existingEffectId)?.delete();
                else if (!fresh)
                    throw new Error(`${option.name ?? option.label} can no longer be used on this roll.`);
            });
        }
        catch (error) {
            await mark(false);
            throw error;
        }
    if (card.initiative && (total !== null)) {
        // Its Combatant in its own combat, started or not, as Portent's.
        const combatant = combatantOf(card.token, combatOf(card.token, game));
        if (combatant)
            await combatant.update({ initiative: total });
    }
    if (kind !== "reroll") {
        const format = (key, values) => game.i18n.format(key, values);
        const name = option.name || option.label;
        const content = (kind === "succeed") ? format("WILDPATH.TESTOFFER.Succeeded", { name, roller: card.actor.name ?? "" })
            : (kind === "natural") ? format("WILDPATH.TESTOFFER.NaturalSet", { name, natural: Number(option.setNatural), total })
                : format(pay ? "WILDPATH.TESTOFFER.Added" : "WILDPATH.TESTOFFER.AddedKept", { name, value: added, total });
        await globals().ChatMessage.create({ speaker: message.speaker, content: `<p>${content}</p>`,
            flags: { wildpath: { testOfferFor: message.id, ...(rollTest ? { rollTest: { ...rollTest, rerolled: true } } : {}) } } });
    }
    return { ok: true, total };
}
/** A yes or no question; null when closed. */
function confirm(title, content) {
    return globals().foundry.applications.api.DialogV2.confirm({ classes: ["wildpath", "themed", "theme-light"], window: { title },
        content: `<p>${content}</p>`, rejectClose: false });
}
/**
 * The clicking client's part: "did it fail?" for an option needing a failure, its die rolled (and "does it succeed
 * now?" for `refundOnFail`), the active GM's claim, then a reroll's new roll. False when nothing was used.
 */
export async function useCardOffer(message, card, option, game) {
    const title = option.name || game.i18n.localize("WILDPATH.INSPIRATION.OfferTitle");
    if (!option.anyResult && ((await confirm(title, game.i18n.localize("WILDPATH.TESTOFFER.DidFail"))) !== true))
        return false;
    let rolled = null;
    let pay = true;
    if (option.addDice) {
        const shown = await requestShownDice(`${Number(option.addDice.number) || 1}d${Number(option.addDice.faces)}`, { title: option.label, game });
        if (!shown)
            return false;
        rolled = Number(shown.result.total);
        if (option.refundOnFail) {
            const answer = await confirm(title, game.i18n.format("WILDPATH.TESTOFFER.NowSucceeds", { value: rolled,
                total: addedTotal(message, rolled) ?? rolled }));
            if (answer === null)
                return false;
            pay = answer;
        }
    }
    const data = { messageId: message.id, value: option.value, rolled, pay };
    const { activeGM } = game.users;
    // No timeout: a late answer may follow a payment already made, and only it lets this client reroll (as Heroic Inspiration's).
    const result = (activeGM?.id === game.user.id) ? await applyToCard(data, game.user, game)
        : await activeGM?.query(TEST_OFFER_QUERY, data, {}).catch(() => ({ ok: false }));
    if (!result?.ok)
        return false;
    if (kindOf(option) === "reroll") {
        const rollTest = message.flags?.wildpath?.rollTest ?? {};
        await card.actor.rollTest({ ability: rollTest.ability ?? null, skill: rollTest.skill ?? null, save: rollTest.save ?? null, rerolled: true,
            rerolledWith: option.name || option.label, bonus: Number(option.bonus) || 0, rollMode: option.rollMode ?? null, token: card.token });
    }
    return true;
}
/** The buttons on sheet-roll and initiative cards, and the GM's query applying one. Called at `init`. */
export function registerTestOfferCards() {
    const { CONFIG, Hooks } = globals();
    CONFIG.queries[TEST_OFFER_QUERY] = (data, { user }) => {
        const game = globals().game;
        return game.user.isGM ? applyToCard(data, user, game) : { ok: false };
    };
    Hooks.on("renderChatMessageHTML", (message, html) => {
        const game = globals().game;
        const card = offerable(message) ? cardTest(message, game) : null;
        if (!card)
            return;
        for (const option of cardOffers(message, card, game)) {
            // Its decider's own (a GM's: those no player owns), as Portent's.
            const decider = deciderOf(option, card.actor);
            if (!decider || !(game.user.isGM ? !decider.hasPlayerOwner : decider.isOwner))
                continue;
            const button = document.createElement("button");
            button.type = "button";
            button.className = "wildpath-test-offer";
            button.textContent = option.label;
            button.addEventListener("click", async () => {
                button.disabled = true;
                if (!(await useCardOffer(message, card, option, game)))
                    button.disabled = false;
            });
            (html.querySelector(".message-content") ?? html).append(button);
        }
    });
}
