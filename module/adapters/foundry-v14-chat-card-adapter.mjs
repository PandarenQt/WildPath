import { CHAT_OUTCOME_KEYS, chatVisibilityForMode, createResolutionCardViewModel } from "../helpers/chat-card-view-model.mjs";
import { damageTypeLabel } from "../helpers/damage-type-label.mjs";
export const RESOLUTION_CARD_TEMPLATE = "systems/wildpath/templates/chat/resolution-card.hbs";
/**
 * A roll's label in words ("Fire damage", "Less damage", "Attack"), or undefined (Foundry then shows none). The card's
 * roll flavour, and the physical-dice prompt's title.
 */
export function rollFlavor(label, i18n) {
    if (!label || !i18n)
        return undefined;
    if (!label.damageType)
        return i18n.localize(label.key);
    return i18n.format("WILDPATH.CHAT.Roll.TypedDamage", { type: damageTypeLabel(label.damageType, i18n) });
}
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
        const conditions = globalThis.CONFIG?.WILDPATH?.CONDITIONS ?? {};
        const shown = createResolutionCardViewModel(result, { conditionNames: Object.fromEntries(Object.entries(conditions)
                .flatMap(([id, condition]) => (condition?.name ? [[id, condition.name]] : []))) });
        // A condition its target is immune to was never given ("Immune" floats over it instead).
        const view = { ...shown, targets: shown.targets.map(target => {
                if (!target.uuid || !target.effects?.length)
                    return target;
                const document = globalThis.fromUuidSync?.(target.uuid);
                const immune = new Set((document?.actor ?? document)?.getConditionImmunities?.() ?? []);
                return { ...target, effects: target.effects.filter(effect => effect.removed || !effect.conditionId || !immune.has(effect.conditionId)) };
            }) };
        const rolls = view.rolls.map(data => foundry.Roll.fromData(data));
        const rollHtml = (await Promise.all(rolls.map((roll, index) => roll.render({ flavor: rollFlavor(view.rollLabels[index], foundry.game?.i18n) }))))
            .join("");
        const actionImg = typeof action.img === "string" ? action.img : null;
        // A roll entered by hand says what it is as a Foundry roll does ("Concentration save").
        const enteredRolls = view.enteredRolls.map(entry => ({ ...entry, flavor: rollFlavor(entry.label, foundry.game?.i18n) }));
        const content = await foundry.renderTemplate(RESOLUTION_CARD_TEMPLATE, { ...view, enteredRolls, actionImg, rollHtml });
        const gmUserIds = [...(foundry.game?.users ?? [])].flatMap(user => (user.isGM && user.id ? [user.id] : []));
        const visibility = chatVisibilityForMode(messageMode, { initiatorUserId, gmUserIds });
        // The Token it acted from speaks: given only the Actor, Foundry picks a linked one on this (the authority's) canvas.
        const tokenRef = result.source?.tokenRef;
        const token = tokenRef ? globalThis.fromUuidSync?.(tokenRef) ?? undefined : undefined;
        const message = await foundry.ChatMessage.create({
            ...(initiatorUserId ? { author: initiatorUserId } : {}),
            speaker: foundry.ChatMessage.getSpeaker({ actor, token }),
            content,
            rolls: rolls.map(roll => roll.toJSON()),
            whisper: [...visibility.whisper],
            blind: visibility.blind,
            // Each named target's Miss, Critical hit, Saved or Immune floats over its Tokens (floating-text.mts).
            flags: { wildpath: { resolutionId, floating: [...floatingOutcomes(view), ...immuneOutcomes(view, action, uuid => {
                            // A card names its targets by Token; the Token's Actor holds the immunities.
                            const document = globalThis.fromUuidSync?.(uuid);
                            return (document?.actor ?? document);
                        })] } }
        });
        return { ok: true, posted: true, message };
    };
}
const FLOATED = new Set([CHAT_OUTCOME_KEYS.miss, CHAT_OUTCOME_KEYS.critical, CHAT_OUTCOME_KEYS.saveSuccess,
    CHAT_OUTCOME_KEYS.legendaryResistance]);
/** The outcomes that float over targets: a named target's Miss, Critical hit or Saved (hidden targets have no uuid). */
export function floatingOutcomes(view) {
    return view.targets.flatMap(target => (target.uuid ? [target.attack, target.save] : [])
        .flatMap(outcome => (outcome && FLOATED.has(outcome.label) ? [{ uuid: target.uuid, label: outcome.label }] : [])));
}
/**
 * "Immune" over each named target the Action gives a condition it is immune to (`ConditionImmunity`): a condition that
 * reaches it, so not after a miss, and a "only on a failed save" one not after a success.
 */
export function immuneOutcomes(view, action, resolve) {
    const effects = ((action?.system?.definition?.effects) ?? [])
        .filter(effect => (effect.type === "condition") && effect.conditionId && ((effect.levels ?? 1) > 0));
    if (!effects.length)
        return [];
    return view.targets.flatMap(target => {
        if (!target.uuid || (target.attack?.label === CHAT_OUTCOME_KEYS.miss))
            return [];
        const saved = target.save?.label === CHAT_OUTCOME_KEYS.saveSuccess;
        const reaching = effects.filter(effect => !(saved && ((effect.saveOutcomePolicy ?? effect.application?.saveOutcomePolicy) === "failure")));
        const immunities = resolve(target.uuid)?.getConditionImmunities?.() ?? [];
        return reaching.some(effect => immunities.includes(effect.conditionId)) ? [{ uuid: target.uuid, label: CHAT_OUTCOME_KEYS.immune }] : [];
    });
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
