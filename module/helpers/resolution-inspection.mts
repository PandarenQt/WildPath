import {rollFormulaForRequest} from "./rolls.mjs";

/**
 * The Rules Inspector's view of one resolution (M6): GM-facing, read from the authority's own record, so it may
 * show defenses, DCs and every roll. It never leaves the GM's client.
 */

type Data = Record<string, unknown>;
interface Named {name?: string; tokenId?: string; actorRef?: string}
interface Roll {total?: number; natural?: number; die?: number}
interface RollEntry {type?: string; semanticType?: string; rollRequest?: Data & {rollMode?: string; metadata?: Data};
  rollResult?: Roll & {provenance?: {method?: string}}; targetKey?: string}
interface AttackResult {target?: Named; roll?: Roll; defense?: {value?: number}; outcome?: string; ok?: boolean}
interface SaveResult {target?: Named; roll?: Roll | null; dc?: {value?: number}; outcome?: string; automatic?: boolean}
interface Plan {type?: string; target?: Named; payerRef?: string;
  plan?: {from?: number; to?: number; amount?: number; target?: Named; payments?: Array<{resourceId?: string; from?: number; to?: number}>}}
interface State {
  id?: string; status?: string; actionDefinition?: {label?: string} | null; source?: Named | null;
  completedStageIds?: string[]; rollResults?: RollEntry[]; mutationPlans?: Plan[];
  results?: {attackResolution?: {results?: AttackResult[]}; saveResolution?: {results?: SaveResult[]}};
  errors?: Array<{code?: string; reason?: string}>;
}
interface ResolutionRecord {resolutionId?: string; initiatorUserId?: string; state?: State | null; options?: {action?: {name?: string}}}

const formulaOf = rollFormulaForRequest as unknown as (request: Data) => {formula?: string | null};
const nameOf = (target: Named | undefined) => target?.name ?? target?.tokenId ?? target?.actorRef ?? "?";
const DURABILITY = new Set(["durabilityDamage", "durabilityHealing", "durabilityAbsorption"]);

export function inspectResolution(record: ResolutionRecord) {
  const state = record.state ?? {};
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
    payments: (state.mutationPlans ?? []).filter(plan => plan.type === "resourcePayment").flatMap(plan =>
      (plan.plan?.payments ?? []).map(payment => ({payer: plan.payerRef ? "controller" : "source",
        resource: payment.resourceId ?? "", from: payment.from ?? null, to: payment.to ?? null}))),
    errors: (state.errors ?? []).map(error => error.reason ?? error.code ?? "")
  };
}
