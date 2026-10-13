import { chatVisibilityForMode, createResolutionCardViewModel } from "../helpers/chat-card-view-model.mjs";
export const RESOLUTION_CARD_TEMPLATE = "systems/wildpath/templates/chat/resolution-card.hbs";
/**
 * Posts one chat card per completed Action, from the authority's client. The content comes only from
 * the public result projection; `author` is the initiator (a GM may author for another user), and the
 * initiator's message mode decides the whisper recipients. Public Foundry rolls are rendered into the
 * card and attached as `rolls`, so dice animation modules see them.
 */
export function createFoundryV14ChatCardAdapter({ ChatMessage = null, Roll = null, renderTemplate = null, game = null } = {}) {
    return async function publishResult({ resolutionId, initiatorUserId, messageMode, actor, action, result }) {
        if (!action || result?.status !== "completed")
            return { ok: true, posted: false };
        const foundry = foundryGlobals({ ChatMessage, Roll, renderTemplate, game });
        const view = createResolutionCardViewModel(result);
        const rolls = view.rolls.map(data => foundry.Roll.fromData(data));
        const rollHtml = (await Promise.all(rolls.map(roll => roll.render()))).join("");
        const content = await foundry.renderTemplate(RESOLUTION_CARD_TEMPLATE, { ...view, rollHtml });
        const gmUserIds = [...(foundry.game?.users ?? [])].flatMap(user => (user.isGM && user.id ? [user.id] : []));
        const visibility = chatVisibilityForMode(messageMode, { initiatorUserId, gmUserIds });
        const message = await foundry.ChatMessage.create({
            ...(initiatorUserId ? { author: initiatorUserId } : {}),
            speaker: foundry.ChatMessage.getSpeaker({ actor }),
            content,
            rolls: rolls.map(roll => roll.toJSON()),
            whisper: [...visibility.whisper],
            blind: visibility.blind,
            flags: { wildpath: { resolutionId } }
        });
        return { ok: true, posted: true, message };
    };
}
// Foundry globals are untyped here; this is the only place they are read.
function foundryGlobals({ ChatMessage, Roll, renderTemplate, game }) {
    const globals = globalThis;
    const chat = ChatMessage ?? globals.ChatMessage;
    const roll = Roll ?? globals.Roll;
    const render = renderTemplate ?? globals.foundry?.applications?.handlebars?.renderTemplate;
    if (!chat || !roll || !render)
        throw new Error("Foundry ChatMessage, Roll and renderTemplate are required to post a chat card.");
    return { ChatMessage: chat, Roll: roll, renderTemplate: render, game: game ?? globals.game ?? null };
}
