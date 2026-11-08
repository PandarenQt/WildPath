/**
 * Heroic Inspiration on a sheet roll's card (BG3, G8): an ability check, skill check or save rolled from the sheet
 * (`Actor#rollTest`) commits nothing, so its card may offer a reroll. A player's character spends its own point; for
 * a monster's roll the GM picks the player character whose point pays. The old card is marked used: by its author or a
 * GM, else by the active GM for the character's owner (a save the GM rolled for it). An Action's d20 is offered its
 * reroll by the pipeline instead, before anything is committed.
 */
import { WILDPATH } from "../config.mjs";
import { isRecentRoll } from "../helpers/chat-card-view-model.mjs";
import { writeInOrder } from "../helpers/crafting.mjs";
import { commitActorResourceMutationPlan, resolveActorResourcePayment } from "../resolvers/resource-resolver.mjs";
import { foundryActorSystemSnapshot } from "../adapters/foundry-v14-actor-system-adapter.mjs";
const globals = () => globalThis;
const INSPIRATION = WILDPATH.HEROIC_INSPIRATION;
const points = (actor) => actor.system.pools?.find(pool => pool.id === INSPIRATION.pool)?.value ?? 0;
export const INSPIRATION_QUERY = "wildpath.inspirationReroll";
/**
 * Who may pay for this roll's reroll here: the character itself (its owner), or, for a monster, the GM's pick of the
 * player characters on the viewed Scene (the table's).
 */
function payersFor(actor) {
    const { game, canvas } = globals();
    if (actor.hasPlayerOwner)
        return (actor.isOwner && (points(actor) > 0)) ? [actor] : [];
    if (!game.user?.isGM || (game.settings?.get("wildpath", "inspirationMonsterRerolls") === false))
        return [];
    const actors = [...(canvas?.scene?.tokens ?? [])].map(token => token.actor);
    return [...new Set(actors.filter((entry) => !!entry && (entry.type === "character") && !!entry.hasPlayerOwner
            && (points(entry) > 0)))];
}
/** The GM picks whose point pays for a monster's reroll; null when the dialog is closed. */
async function choosePayer(payers) {
    const { game: { i18n }, foundry: { applications: { api: { DialogV2 } }, utils } } = globals();
    const options = payers.map(payer => `<option value="${utils.escapeHTML(payer.uuid)}">${utils.escapeHTML(i18n.format("WILDPATH.INSPIRATION.Spend", { name: payer.name, value: points(payer), max: INSPIRATION.max }))}</option>`).join("");
    const answer = await DialogV2.input({ classes: ["wildpath", "themed", "theme-light"], window: { title: i18n.localize("WILDPATH.INSPIRATION.Title") },
        content: `<label>${i18n.localize("WILDPATH.INSPIRATION.ChoosePayer")} <select name="payer">${options}</select></label>`,
        ok: { label: i18n.localize("WILDPATH.INSPIRATION.Reroll") }, rejectClose: false });
    return payers.find(payer => payer.uuid === answer?.payer) ?? null;
}
/** One of `payer`'s points, by the payment rule the pipeline's offer pays with (inspirationOffer); null when it has none. */
function inspirationPayment(payer) {
    const payment = resolveActorResourcePayment({ actorSystem: foundryActorSystemSnapshot(payer),
        cost: { allOf: [{ capability: INSPIRATION.pool, amount: 1 }] } });
    return payment.ok ? payment.mutationPlan : null;
}
/** The card is claimed before the point is spent, and given back if the spend fails: no point paid for no reroll. */
async function claimAndSpend(message, payer, plan) {
    await writeInOrder([[message, { "flags.wildpath.rollTest.rerolled": true }], async () => {
            if (!(await commitActorResourceMutationPlan(payer, plan)))
                throw new Error(`${payer.name}'s Heroic Inspiration could not be spent.`);
        }]);
}
/**
 * The active GM claims a card its author did not let the clicker mark (a save the GM rolled for a player's character),
 * for a user who owns that character, and spends its point.
 */
async function claimForOwner({ messageId }, { user }) {
    const { game, fromUuidSync } = globals();
    const message = game.user?.isGM ? game.messages.get(String(messageId)) : undefined;
    const test = message?.flags?.wildpath?.rollTest;
    if (!message || !test?.actorUuid || test.rerolled || !isRecentRoll(message))
        return { ok: false };
    const payer = fromUuidSync(test.actorUuid);
    const plan = payer?.hasPlayerOwner && payer.testUserPermission(user, "OWNER") ? inspirationPayment(payer) : null;
    if (!payer || !plan)
        return { ok: false };
    await claimAndSpend(message, payer, plan);
    return { ok: true };
}
/** Mark the old card used, spend `payer`'s point, and roll the same test again. */
async function reroll(message, actor, test, payers) {
    const { game, ui } = globals();
    const payer = actor.hasPlayerOwner ? payers[0] ?? null : await choosePayer(payers);
    if (!payer)
        return false;
    const plan = inspirationPayment(payer);
    if (!plan) {
        ui.notifications.warn(game.i18n.format("WILDPATH.INSPIRATION.NoPoints", { name: payer.name }));
        return false;
    }
    // Only its author or a GM may mark a card used; the owner of a GM-rolled character's card asks the active GM.
    if (game.user && message.canUserModify(game.user, "update"))
        await claimAndSpend(message, payer, plan);
    else if (!(await game.users.activeGM?.query(INSPIRATION_QUERY, { messageId: message.id }, { timeout: 15000 })
        .catch(() => undefined))?.ok)
        return false;
    await actor.rollTest({ ability: test.ability ?? null, skill: test.skill ?? null, save: test.save ?? null, rerolled: true });
    return true;
}
export function registerInspirationRerolls() {
    globals().CONFIG.queries[INSPIRATION_QUERY] = claimForOwner;
    globals().Hooks.on("renderChatMessageHTML", (message, html) => {
        const test = message.flags?.wildpath?.rollTest;
        if (!test?.actorUuid || test.rerolled || !isRecentRoll(message))
            return;
        const actor = globals().fromUuidSync(test.actorUuid);
        const payers = actor ? payersFor(actor) : [];
        if (!actor || !payers.length)
            return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "wildpath-inspiration-reroll";
        button.textContent = globals().game.i18n.localize("WILDPATH.INSPIRATION.Reroll");
        button.addEventListener("click", async () => {
            button.disabled = true;
            if (!(await reroll(message, actor, test, payers)))
                button.disabled = false;
        });
        (html.querySelector(".message-content") ?? html).append(button);
    });
}
