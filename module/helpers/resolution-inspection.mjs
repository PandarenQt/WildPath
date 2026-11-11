import { damageTypeKey } from "./damage-type-label.mjs";
import { rollLabel } from "./multiplayer-authority.mjs";
import { countedRollTotal, rollFormulaForRequest } from "./rolls.mjs";
const formulaOf = rollFormulaForRequest;
const refsOf = (target) => [target?.id, target?.uuid, target?.actorRef, target?.actorId, target?.tokenId].filter(Boolean);
const DURABILITY = new Set(["durabilityDamage", "durabilityHealing", "durabilityAbsorption"]);
// The engine values with words in lang/en.json (WILDPATH.INSPECTOR.<group>.<value>); any other shows as it is.
const WORDS = {
    Mode: ["normal", "advantage", "disadvantage"],
    Method: ["digital", "natural", "total", "structured"],
    Outcome: ["hit", "criticalHit", "miss", "criticalMiss", "success", "criticalSuccess", "failure", "criticalFailure"]
};
const words = (group, value) => (value && WORDS[group].includes(value) ? `WILDPATH.INSPECTOR.${group}.${value}`
    : value ?? null);
// A roll the chat card names no way (rollLabel is null) by the pipeline's kind suffix: a die added to a d20 test (Bardic
// Inspiration), a number added (Flash of Genius), a miss made a hit (Peerless Aim), a d20 set (Stroke of Luck, Portent),
// Empowered Spell's reroll.
const KIND_SUFFIXES = [["-added-die", "AddedDie"], ["-added", "Added"], ["-forced-hit", "ForcedHit"], ["-set-natural", "SetNatural"],
    ["-empowered", "Empowered"]];
/** A roll's kind in words: the chat card's (`rollLabel`, typed damage with its type's key), else by its suffix, else as it is. */
function kindWords(request, kind) {
    const label = rollLabel(request);
    if (label?.damageType)
        return { kindLabel: "WILDPATH.CHAT.Roll.TypedDamage", kindType: damageTypeKey(label.damageType) };
    if (label)
        return { kindLabel: label.key };
    const suffix = KIND_SUFFIXES.find(([end]) => kind.endsWith(end));
    return { kindLabel: suffix ? `WILDPATH.INSPECTOR.Kind.${suffix[1]}` : kind };
}
export function inspectResolution(record) {
    const state = record.state ?? {};
    // A plan's target may be a target context (the target one level down) or a bare reference; the resolution's own
    // targets carry the names.
    const known = [...(state.targets ?? []), ...(state.input?.targets ?? [])];
    const nameOf = (target) => target?.name ?? target?.target?.name
        ?? known.find(entry => entry.name && refsOf(entry).some(ref => refsOf(target).includes(ref)))?.name
        ?? target?.tokenId ?? target?.actorRef ?? target?.uuid ?? "?";
    return {
        id: record.resolutionId ?? state.id ?? null,
        label: state.actionDefinition?.label ?? record.options?.action?.name ?? record.resolutionId ?? "",
        status: state.status ?? null,
        initiatorUserId: record.initiatorUserId ?? null,
        stages: [...(state.completedStageIds ?? [])],
        rolls: (state.rollResults ?? []).map(entry => {
            const kind = String(entry.rollRequest?.metadata?.rollKind ?? entry.semanticType ?? entry.type ?? "");
            const mode = entry.rollRequest?.rollMode ?? "normal";
            const method = entry.rollResult?.provenance?.method ?? null;
            return {
                kind, ...kindWords(entry.rollRequest, kind),
                formula: entry.rollRequest ? formulaOf(entry.rollRequest).formula ?? null : null,
                // An entry with no request (a d20 set, a number added) is no roll, so it has no mode.
                mode, modeLabel: entry.rollRequest ? words("Mode", mode) : null,
                natural: entry.rollResult?.natural ?? entry.rollResult?.die ?? null,
                // As it counted: at least its floor (Indomitable Might).
                total: countedRollTotal(entry.rollResult),
                method, methodLabel: words("Method", method)
            };
        }),
        attacks: (state.results?.attackResolution?.results ?? []).filter(result => result.outcome).map(result => ({
            target: nameOf(result.target), total: result.roll?.total ?? null, defense: result.defense?.value ?? null, outcome: result.outcome,
            outcomeLabel: words("Outcome", result.outcome)
        })),
        saves: (state.results?.saveResolution?.results ?? []).filter(result => result.outcome).map(result => ({
            // The total it was judged at (its floor counted), else its roll's.
            target: nameOf(result.target), total: result.total ?? result.roll?.total ?? null, dc: result.dc?.value ?? null, outcome: result.outcome,
            outcomeLabel: words("Outcome", result.outcome),
            automatic: result.automatic === true
        })),
        changes: (state.mutationPlans ?? []).filter(plan => DURABILITY.has(String(plan.type))).map(plan => ({
            target: nameOf(plan.target ?? plan.plan?.target), type: String(plan.type).replace("durability", "").toLowerCase(),
            amount: plan.plan?.amount ?? null, from: plan.plan?.from ?? null, to: plan.plan?.to ?? null
        })),
        // Conditions and custom effects the Action applies; a condition's name is a lang key the template localizes.
        effects: (state.mutationPlans ?? []).filter(plan => plan.type === "conditionEffect").map(plan => ({
            target: nameOf(plan.target), effect: plan.definition?.name ?? plan.conditionId ?? "?", action: plan.action ?? null
        })),
        payments: (state.mutationPlans ?? []).filter(plan => plan.type === "resourcePayment").flatMap(plan => (plan.plan?.payments ?? []).map(payment => ({ payer: plan.payerRef ? "controller" : "source",
            resource: payment.resourceId ?? "", from: payment.from ?? null, to: payment.to ?? null }))),
        errors: (state.errors ?? []).map(error => error.reason ?? error.code ?? "")
    };
}
