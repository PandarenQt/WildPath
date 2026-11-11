/**
 * Chat card data for a completed resolution. The input is the BROADCAST_SAFE result projection
 * (`projectResolutionResultForDisclosure`), because every ChatMessage reaches every connected
 * client whether or not it is whispered. This view model is an allow-list over that projection.
 */
export const CHAT_OUTCOME_KEYS = Object.freeze({
    hit: "WILDPATH.CHAT.Outcome.Hit",
    critical: "WILDPATH.CHAT.Outcome.Critical",
    miss: "WILDPATH.CHAT.Outcome.Miss",
    decoy: "WILDPATH.CHAT.Outcome.Decoy",
    saveSuccess: "WILDPATH.CHAT.Outcome.SaveSuccess",
    saveFailure: "WILDPATH.CHAT.Outcome.SaveFailure",
    legendaryResistance: "WILDPATH.CHAT.Outcome.LegendaryResistance",
    staysUp: "WILDPATH.CHAT.Outcome.StaysUp",
    concentrationKept: "WILDPATH.CHAT.Outcome.ConcentrationKept",
    concentrationLost: "WILDPATH.CHAT.Outcome.ConcentrationLost",
    half: "WILDPATH.COVER.half",
    threeQuarters: "WILDPATH.COVER.threeQuarters",
    immune: "WILDPATH.CHAT.Outcome.Immune",
    unaffected: "WILDPATH.CHAT.Outcome.Unaffected",
    checkSuccess: "WILDPATH.CHAT.Outcome.CheckSuccess",
    checkFailure: "WILDPATH.CHAT.Outcome.CheckFailure"
});
export function createResolutionCardViewModel(result, { conditionNames = {} } = {}) {
    const attack = result.outcomes?.attack?.results ?? [];
    const save = result.outcomes?.save?.results ?? [];
    return {
        resolutionId: result.resolutionId ?? null,
        actionName: textOrNull(result.action?.name ?? result.action?.label),
        check: !result.outcomes?.check ? null : result.outcomes.check.success
            ? { label: CHAT_OUTCOME_KEYS.checkSuccess, tone: "success" } : { label: CHAT_OUTCOME_KEYS.checkFailure, tone: "failure" },
        // A target the Action did nothing to is no longer among its targets, but is still named.
        targets: [...(result.targets ?? []), ...(result.outcomes?.unaffected ?? [])
                .filter(spared => !(result.targets ?? []).some(target => sameTarget(spared, target)))].map(target => {
            const attackEntry = attack.find(entry => sameTarget(entry.target, target));
            const saveEntry = save.find(entry => sameTarget(entry.target, target));
            const kept = (result.outcomes?.zeroHp ?? []).find(entry => sameTarget(entry.target, target));
            const checks = (result.outcomes?.concentration ?? []).filter(entry => sameTarget(entry.target, target));
            const covered = (result.outcomes?.cover ?? []).find(entry => sameTarget(entry.target, target));
            const coverKey = covered?.degree ? CHAT_OUTCOME_KEYS[covered.degree] : null;
            const effects = (result.outcomes?.effects ?? []).filter(entry => sameTarget(entry.target, target)).flatMap(entry => {
                const label = textOrNull(entry.name) ?? (entry.conditionId ? (conditionNames[entry.conditionId] ?? entry.conditionId) : null);
                return label ? [{ label, conditionId: textOrNull(entry.conditionId), removed: entry.removed === true }] : [];
            });
            const name = textOrNull(target.name);
            return {
                name,
                uuid: name ? textOrNull(target.uuid ?? target.actorRef) : null,
                attack: attackEntry ? attackOutcome(attackEntry) : null,
                save: saveEntry ? saveOutcome(saveEntry) : null,
                ...(kept ? { staysUp: { label: CHAT_OUTCOME_KEYS.staysUp, name: textOrNull(kept.name) ?? "" } } : {}),
                ...(checks.length ? { concentration: checks.every(entry => entry.kept === true)
                        ? { label: CHAT_OUTCOME_KEYS.concentrationKept, tone: "success" } : { label: CHAT_OUTCOME_KEYS.concentrationLost, tone: "failure" } } : {}),
                ...(coverKey ? { cover: { label: coverKey } } : {}),
                ...((result.outcomes?.unaffected ?? []).some(spared => sameTarget(spared, target))
                    ? { unaffected: { label: CHAT_OUTCOME_KEYS.unaffected } } : {}),
                ...(effects.length ? { effects } : {})
            };
        }),
        rolls: (result.rolls ?? []).flatMap(roll => (roll.foundryRoll ? [roll.foundryRoll] : [])),
        rollLabels: (result.rolls ?? []).flatMap(roll => (roll.foundryRoll ? [roll.label ?? null] : [])),
        enteredRolls: (result.rolls ?? []).flatMap(roll => (!roll.foundryRoll && Number.isFinite(roll.total)
            ? [{ formula: textOrNull(roll.formula), total: roll.total, label: roll.label ?? null }] : []))
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
function attackOutcome(entry) {
    if (entry.decoy)
        return { label: CHAT_OUTCOME_KEYS.decoy, tone: "failure" };
    if (!entry.hit)
        return { label: CHAT_OUTCOME_KEYS.miss, tone: "failure" };
    return { label: entry.critical ? CHAT_OUTCOME_KEYS.critical : CHAT_OUTCOME_KEYS.hit, tone: "success" };
}
function saveOutcome(entry) {
    if (entry.success && entry.succeededInstead)
        return { label: CHAT_OUTCOME_KEYS.legendaryResistance, tone: "success" };
    return entry.success
        ? { label: CHAT_OUTCOME_KEYS.saveSuccess, tone: "success" }
        : { label: CHAT_OUTCOME_KEYS.saveFailure, tone: "failure" };
}
function sameTarget(left, right) {
    if (!left)
        return false;
    // Its Token first: a Token's synthetic Actor and the Token itself are refs to the same creature.
    if (left.tokenId && right.tokenId)
        return left.tokenId === right.tokenId;
    if (left.actorRef && right.actorRef)
        return left.actorRef === right.actorRef;
    return !!left.id && left.id === right.id;
}
function textOrNull(value) {
    return typeof value === "string" && value.trim() ? value : null;
}
/** A roll stays open to a reroll (Portent, Heroic Inspiration) for ten minutes: older cards in the log get no buttons. */
export const RECENT_ROLL_MS = 10 * 60 * 1000;
export function isRecentRoll(message, now = Date.now()) {
    return (now - (Number(message?.timestamp) || 0)) < RECENT_ROLL_MS;
}
