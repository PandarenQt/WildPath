/**
 * A short, plain summary of what an ActionDefinition does, for the item sheet's Builder: each line names one part of
 * the definition as the engine reads it.
 */
import {formatFormula} from "./formula.mjs";

type Data = Record<string, unknown>;
interface Requirement {capability?: string; resource?: string; amount?: number}
interface DiceLike {type?: string; number?: number; faces?: number; value?: number; terms?: DiceLike[]}

const requirementText = (requirement: Requirement) => `${requirement.amount ?? 1} ${requirement.capability ?? requirement.resource ?? "?"}`;

function costText(costs: {allOf?: Requirement[]; anyOf?: Requirement[][]} | undefined | null) {
  if ( costs?.anyOf?.length ) return costs.anyOf.map(branch => branch.map(requirementText).join(" + ")).join(" or ");
  return costs?.allOf?.length ? costs.allOf.map(requirementText).join(" + ") : null;
}

/** The builder's formula text; an expression only Advanced can show is named by its type. */
function amountText(expression: DiceLike | undefined | null): string {
  return formatFormula(expression) ?? expression?.type ?? "?";
}

/** One line per part of the definition, as [label, text] pairs; an absent part has no line. `localize` reads the lang keys. */
export function summarizeActionDefinition(definition: Data | null | undefined,
  localize: (key: string) => string = key => key): Array<[string, string]> {
  if ( !definition ) return [];
  const d = definition as {costs?: Parameters<typeof costText>[0]; controllerCosts?: Parameters<typeof costText>[0];
    targeting?: {type?: string; count?: number}; range?: {type?: string; distance?: {value?: number}; normal?: {value?: number};
      long?: {value?: number}}; area?: {shape?: string; size?: {value?: number}; persistence?: unknown};
    attack?: {type?: string; defenseKey?: string; properties?: string[]; proficient?: boolean}; save?: {ability?: string; dc?: {value?: number}};
    check?: {ability?: string; skill?: string; dc?: {value?: number}};
    damage?: Array<{expression?: DiceLike; damageType?: string}>; healing?: Array<{expression?: DiceLike}>;
    effects?: Array<{type?: string; conditionId?: string; name?: string}>; transform?: {formRef?: string; choiceId?: string; revert?: boolean};
    summon?: {actorRef?: string; choiceId?: string; count?: number; concentration?: boolean}; configuration?: unknown[];
    stabilize?: boolean};
  const lines: Array<[string, string | null]> = [
    ["WILDPATH.BUILDER.Section.costs", costText(d.costs) ?? localize("WILDPATH.BUILDER.Costs.Free")],
    ["WILDPATH.BUILDER.Summary.ControllerCost", costText(d.controllerCosts)],
    ["WILDPATH.BUILDER.Section.targets", d.targeting?.type
      ? `${d.targeting.type}${d.targeting.count ? ` (${d.targeting.count})` : ""}` : null],
    ["WILDPATH.BUILDER.Section.range", d.range?.type ? `${d.range.type} ${d.range.distance?.value ?? d.range.normal?.value ?? ""}${
      d.range.long?.value ? `/${d.range.long.value}` : ""} ft` : null],
    ["WILDPATH.BUILDER.Section.area", d.area?.shape
      ? `${d.area.shape} ${d.area.size?.value ?? "?"} ft${d.area.persistence ? ", lasting" : ""}` : null],
    ["WILDPATH.BUILDER.Summary.Attack", d.attack ? `${d.attack.type ?? "?"} vs ${d.attack.defenseKey ?? "ac"}${d.attack.properties?.length
      ? ` (${d.attack.properties.join(", ")})` : ""}${d.attack.proficient ? ", proficient" : ""}` : null],
    ["WILDPATH.BUILDER.Summary.Save", d.save ? `${d.save.ability ?? "?"} DC ${d.save.dc?.value ?? "?"}` : null],
    ["WILDPATH.BUILDER.Summary.Check", d.check
      ? `${[d.check.ability, d.check.skill && `(${d.check.skill})`].filter(Boolean).join(" ")} DC ${d.check.dc?.value ?? "?"}` : null],
    ["WILDPATH.BUILDER.Section.damage", d.damage?.length
      ? d.damage.map(entry => `${amountText(entry.expression)} ${entry.damageType ?? ""}`.trim()).join(", ") : null],
    ["WILDPATH.BUILDER.Section.healing", d.healing?.length ? d.healing.map(entry => amountText(entry.expression)).join(", ") : null],
    ["WILDPATH.BUILDER.Section.effects", d.effects?.length
      ? d.effects.map(entry => entry.name ?? entry.conditionId ?? entry.type ?? "?").join(", ") : null],
    ["WILDPATH.BUILDER.Summary.Choices", d.configuration?.length ? String(d.configuration.length) : null],
    ["WILDPATH.BUILDER.Summary.Transform", d.transform
      ? (d.transform.revert ? "revert" : d.transform.formRef ?? `choice ${d.transform.choiceId}`) : null],
    ["WILDPATH.BUILDER.Summary.Summon", d.summon ? `${d.summon.actorRef ?? `choice ${d.summon.choiceId}`} ×${d.summon.count ?? 1}${
      d.summon.concentration ? ", concentration" : ""}` : null],
    ["WILDPATH.BUILDER.Summary.Stabilize", d.stabilize ? "dying targets" : null]
  ];
  return lines.filter((line): line is [string, string] => line[1] !== null).map(([label, text]) => [localize(label), text]);
}
