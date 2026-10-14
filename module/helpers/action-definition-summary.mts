/**
 * A short, plain summary of what an ActionDefinition does, for the item sheet's editor (the first slice of the
 * Homebrew Builder): each line names one part of the definition as the engine reads it.
 */

type Data = Record<string, unknown>;
interface Requirement {capability?: string; resource?: string; amount?: number}
interface DiceLike {type?: string; number?: number; faces?: number; value?: number; terms?: DiceLike[]}

const requirementText = (requirement: Requirement) => `${requirement.amount ?? 1} ${requirement.capability ?? requirement.resource ?? "?"}`;

function costText(costs: {allOf?: Requirement[]; anyOf?: Requirement[][]} | undefined | null) {
  if ( costs?.anyOf?.length ) return costs.anyOf.map(branch => branch.map(requirementText).join(" + ")).join(" or ");
  return costs?.allOf?.length ? costs.allOf.map(requirementText).join(" + ") : null;
}

function amountText(expression: DiceLike | undefined | null): string {
  if ( !expression ) return "?";
  if ( expression.type === "dice" ) return `${expression.number ?? 1}d${expression.faces ?? "?"}`;
  if ( expression.type === "constant" ) return String(expression.value ?? 0);
  if ( expression.terms?.length ) return expression.terms.map(amountText).join(` ${expression.type ?? "?"} `);
  return expression.type ?? "?";
}

/** One line per part of the definition, as [label, text] pairs; an absent part has no line. */
export function summarizeActionDefinition(definition: Data | null | undefined): Array<[string, string]> {
  if ( !definition ) return [];
  const d = definition as {costs?: Parameters<typeof costText>[0]; controllerCosts?: Parameters<typeof costText>[0];
    targeting?: {type?: string; count?: number}; range?: {type?: string; distance?: {value?: number}; normal?: {value?: number};
      long?: {value?: number}}; area?: {shape?: string; size?: {value?: number}; persistence?: unknown};
    attack?: {type?: string; defenseKey?: string; properties?: string[]}; save?: {ability?: string; dc?: {value?: number}};
    check?: {ability?: string; skill?: string; dc?: {value?: number}};
    damage?: Array<{expression?: DiceLike; damageType?: string}>; healing?: Array<{expression?: DiceLike}>;
    effects?: Array<{type?: string; conditionId?: string; name?: string}>; transform?: {formRef?: string; choiceId?: string; revert?: boolean};
    summon?: {actorRef?: string; choiceId?: string; count?: number; concentration?: boolean}; configuration?: unknown[];
    stabilize?: boolean};
  const lines: Array<[string, string | null]> = [
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
  return lines.filter((line): line is [string, string] => line[1] !== null);
}
