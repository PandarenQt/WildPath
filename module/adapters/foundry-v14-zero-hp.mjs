import { resolveActorResourcePayment } from "../resolvers/resource-resolver.mjs";
import { evaluateValueExpression } from "../helpers/value-expressions.mjs";
import { combineRollModes } from "../helpers/rolls.mjs";
import { resolveActorSaveStatistic } from "../helpers/combat-statistics.mjs";
/**
 * What keeps a creature up when damage would drop it to 0 Hit Points: its feature's `health.zero` Trigger (Relentless
 * Endurance, Relentless Rage, Undead Fortitude), worked out for it now (hit points, the DC from its uses, its save bonus
 * and roll mode, and the use it pays). Null when it has none that applies.
 */
export function zeroHpFor(actor, actorSystem) {
    if (!actor)
        return null;
    // Its features' rules, and its effects' (2024 Death Ward: "the target instead drops to 1 Hit Point, and the spell
    // ends"): one from an effect names it (`effectUuid`), which ends once it is used.
    const owners = [...[...(actor.items ?? [])].filter((item) => item?.system?.active !== false).map((item) => ({ item, effect: null })),
        ...[...(actor.effects ?? [])].filter((effect) => !effect?.disabled).map((effect) => ({ item: effect, effect }))];
    for (const { item, effect } of owners) {
        for (const rule of item?.system?.ruleElements ?? []) {
            const spec = ((rule?.type === "Trigger") && (rule.data?.event === "health.zero")) ? rule.data.zeroHp : null;
            if (!spec || (spec.whileStatus && !actor.statuses?.has?.(spec.whileStatus)))
                continue;
            const poolId = spec.pool ?? spec.dc?.usesPool ?? null;
            const payment = poolId ? resolveActorResourcePayment({ actorSystem, cost: { allOf: [{ capability: poolId, amount: 1 }] } }) : null;
            if (payment && !payment.ok)
                continue;
            const pool = (actorSystem?.pools ?? []).find((entry) => entry.id === poolId);
            const value = (expression) => ((expression && (typeof expression === "object")) ? Number(evaluateValueExpression(expression, { actor, actorSystem }).value)
                : Number(expression));
            const ability = spec.ability ?? null;
            const rollMode = ability ? combineRollModes(actor.getRollModes?.(["save", `save.${ability}`], {}) ?? []) : null;
            return { name: item.name ?? "", mode: (spec.mode === "save") ? "save" : "set", hitPoints: Math.max(Math.trunc(value(spec.hitPoints ?? 1) || 1), 1),
                ...(effect?.uuid ? { effectUuid: effect.uuid } : {}),
                ...(ability ? { ability, saveBonus: resolveActorSaveStatistic(actor, ability)?.totalModifier ?? 0,
                    ...((rollMode && (rollMode !== "normal")) ? { rollMode } : {}) } : {}),
                ...((spec.dc?.base != null) ? { dc: Number(spec.dc.base)
                        + ((Number(spec.dc.perUse) || 0) * Math.max((Number(pool?.max) || 0) - (Number(pool?.value) || 0), 0)) } : {}),
                ...((spec.dc?.plusDamage != null) ? { dcPlusDamage: Number(spec.dc.plusDamage) } : {}),
                ...(spec.notOn?.length ? { notOn: [...spec.notOn] } : {}),
                ...(payment ? { payment: { plan: payment.mutationPlan, payerRef: actor.uuid } } : {}) };
        }
    }
    return null;
}
