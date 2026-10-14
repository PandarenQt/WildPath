/**
 * A short, plain summary of what an ActionDefinition does, for the item sheet's editor (the first slice of the
 * Homebrew Builder): each line names one part of the definition as the engine reads it.
 */
const requirementText = (requirement) => `${requirement.amount ?? 1} ${requirement.capability ?? requirement.resource ?? "?"}`;
function costText(costs) {
    if (costs?.anyOf?.length)
        return costs.anyOf.map(branch => branch.map(requirementText).join(" + ")).join(" or ");
    return costs?.allOf?.length ? costs.allOf.map(requirementText).join(" + ") : null;
}
function amountText(expression) {
    if (!expression)
        return "?";
    if (expression.type === "dice")
        return `${expression.number ?? 1}d${expression.faces ?? "?"}`;
    if (expression.type === "constant")
        return String(expression.value ?? 0);
    if (expression.terms?.length)
        return expression.terms.map(amountText).join(` ${expression.type ?? "?"} `);
    return expression.type ?? "?";
}
/** One line per part of the definition, as [label, text] pairs; an absent part has no line. */
export function summarizeActionDefinition(definition) {
    if (!definition)
        return [];
    const d = definition;
    const lines = [
        ["Cost", costText(d.costs) ?? "free"],
        ["Controller cost", costText(d.controllerCosts)],
        ["Targets", d.targeting?.type ? `${d.targeting.type}${d.targeting.count ? ` (${d.targeting.count})` : ""}` : null],
        ["Range", d.range?.type ? `${d.range.type} ${d.range.distance?.value ?? d.range.normal?.value ?? ""}${d.range.long?.value
                ? `/${d.range.long.value}` : ""} ft` : null],
        ["Area", d.area?.shape ? `${d.area.shape} ${d.area.size?.value ?? "?"} ft${d.area.persistence ? ", lasting" : ""}` : null],
        ["Attack", d.attack ? `${d.attack.type ?? "?"} vs ${d.attack.defenseKey ?? "ac"}${d.attack.properties?.length
                ? ` (${d.attack.properties.join(", ")})` : ""}` : null],
        ["Save", d.save ? `${d.save.ability ?? "?"} DC ${d.save.dc?.value ?? "?"}` : null],
        ["Check", d.check ? `${[d.check.ability, d.check.skill && `(${d.check.skill})`].filter(Boolean).join(" ")} DC ${d.check.dc?.value ?? "?"}`
                : null],
        ["Damage", d.damage?.length ? d.damage.map(entry => `${amountText(entry.expression)} ${entry.damageType ?? ""}`.trim()).join(", ") : null],
        ["Healing", d.healing?.length ? d.healing.map(entry => amountText(entry.expression)).join(", ") : null],
        ["Effects", d.effects?.length ? d.effects.map(entry => entry.name ?? entry.conditionId ?? entry.type ?? "?").join(", ") : null],
        ["Choices", d.configuration?.length ? String(d.configuration.length) : null],
        ["Transform", d.transform ? (d.transform.revert ? "revert" : d.transform.formRef ?? `choice ${d.transform.choiceId}`) : null],
        ["Summon", d.summon ? `${d.summon.actorRef ?? `choice ${d.summon.choiceId}`} ×${d.summon.count ?? 1}${d.summon.concentration
                ? ", concentration" : ""}` : null],
        ["Stabilize", d.stabilize ? "dying targets" : null]
    ];
    return lines.filter((line) => line[1] !== null);
}
