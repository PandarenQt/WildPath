/**
 * Chat card data for a completed resolution. The input is the BROADCAST_SAFE result projection
 * (`projectResolutionResultForDisclosure`), because every ChatMessage reaches every connected
 * client whether or not it is whispered. This view model is an allow-list over that projection.
 */
export const CHAT_OUTCOME_KEYS = Object.freeze({
    hit: "WILDPATH.CHAT.Outcome.Hit",
    critical: "WILDPATH.CHAT.Outcome.Critical",
    miss: "WILDPATH.CHAT.Outcome.Miss",
    saveSuccess: "WILDPATH.CHAT.Outcome.SaveSuccess",
    saveFailure: "WILDPATH.CHAT.Outcome.SaveFailure"
});
export function createResolutionCardViewModel(result) {
    const attack = result.outcomes?.attack?.results ?? [];
    const save = result.outcomes?.save?.results ?? [];
    return {
        resolutionId: result.resolutionId ?? null,
        actionName: textOrNull(result.action?.name ?? result.action?.label),
        targets: (result.targets ?? []).map(target => {
            const attackEntry = attack.find(entry => sameTarget(entry.target, target));
            const saveEntry = save.find(entry => sameTarget(entry.target, target));
            return {
                name: textOrNull(target.name),
                attack: attackEntry ? attackOutcomeKey(attackEntry) : null,
                save: saveEntry ? (saveEntry.success ? CHAT_OUTCOME_KEYS.saveSuccess : CHAT_OUTCOME_KEYS.saveFailure) : null
            };
        }),
        // shortcut: rolls without Foundry Roll JSON (manual/physical) are not shown; add a total row with the dice policy work.
        rolls: (result.rolls ?? []).flatMap(roll => (roll.foundryRoll ? [roll.foundryRoll] : []))
    };
}
/**
 * Whisper recipients for a message mode (`CONFIG.ChatMessage.modes`). The authority creates the
 * card, so `self` must name the initiator: `ChatMessage.applyMode` would whisper to the GM.
 * Unknown modes fall back to public, as Foundry does for an unrecognized mode.
 */
export function chatVisibilityForMode(mode, { initiatorUserId = null, gmUserIds = [] } = {}) {
    switch (mode) {
        case "gm": return { whisper: [...gmUserIds], blind: false };
        case "blind": return { whisper: [...gmUserIds], blind: true };
        case "self": return { whisper: initiatorUserId ? [initiatorUserId] : [...gmUserIds], blind: false };
        default: return { whisper: [], blind: false };
    }
}
function attackOutcomeKey(entry) {
    if (!entry.hit)
        return CHAT_OUTCOME_KEYS.miss;
    return entry.critical ? CHAT_OUTCOME_KEYS.critical : CHAT_OUTCOME_KEYS.hit;
}
function sameTarget(left, right) {
    if (!left)
        return false;
    if (left.actorRef && right.actorRef)
        return left.actorRef === right.actorRef;
    return !!left.id && left.id === right.id;
}
function textOrNull(value) {
    return typeof value === "string" && value.trim() ? value : null;
}
