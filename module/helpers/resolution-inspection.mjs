import { rollFormulaForRequest } from "./rolls.mjs";
const formulaOf = rollFormulaForRequest;
const refsOf = (target) => [target?.id, target?.uuid, target?.actorRef, target?.actorId, target?.tokenId].filter(Boolean);
const DURABILITY = new Set(["durabilityDamage", "durabilityHealing", "durabilityAbsorption"]);
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
        rolls: (state.rollResults ?? []).map(entry => ({
            kind: String(entry.rollRequest?.metadata?.rollKind ?? entry.semanticType ?? entry.type ?? ""),
            formula: entry.rollRequest ? formulaOf(entry.rollRequest).formula ?? null : null,
            mode: entry.rollRequest?.rollMode ?? "normal",
            natural: entry.rollResult?.natural ?? entry.rollResult?.die ?? null,
            total: entry.rollResult?.total ?? null,
            method: entry.rollResult?.provenance?.method ?? null
        })),
        attacks: (state.results?.attackResolution?.results ?? []).filter(result => result.outcome).map(result => ({
            target: nameOf(result.target), total: result.roll?.total ?? null, defense: result.defense?.value ?? null, outcome: result.outcome
        })),
        saves: (state.results?.saveResolution?.results ?? []).filter(result => result.outcome).map(result => ({
            target: nameOf(result.target), total: result.roll?.total ?? null, dc: result.dc?.value ?? null, outcome: result.outcome,
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
