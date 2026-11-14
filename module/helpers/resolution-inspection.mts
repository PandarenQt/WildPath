import {damageTypeKey, damageTypeLabel} from "./damage-type-label.mjs";
import {rollLabel} from "./multiplayer-authority.mjs";
import {countedRollTotal, rollFormulaForRequest} from "./rolls.mjs";
import {WILDPATH} from "../config.mjs";

/**
 * The Rules Inspector's view of one resolution (M6): GM-facing, read from the authority's own record, so it may
 * show defenses, DCs and every roll. It never leaves the GM's client.
 */

type Data = Record<string, unknown>;
interface Named {name?: string; tokenId?: string; actorRef?: string; uuid?: string; id?: string; actorId?: string; target?: Named}
interface Roll {total?: number; natural?: number; die?: number; totalMinimum?: number}
interface RollEntry {type?: string; semanticType?: string; rollRequest?: Data & {rollMode?: string; metadata?: Data};
  rollResult?: Roll & {provenance?: {method?: string}}; targetKey?: string}
interface AttackResult {target?: Named; roll?: Roll; defense?: {value?: number}; outcome?: string; ok?: boolean}
interface SaveResult {target?: Named; roll?: Roll | null; total?: number; dc?: {value?: number}; outcome?: string; automatic?: boolean}

interface Plan {type?: string; target?: Named; payerRef?: string; conditionId?: string; action?: string; definition?: {name?: string};
  plan?: {from?: number; to?: number; amount?: number; target?: Named; payments?: Array<{resourceId?: string; from?: number; to?: number}>}}
interface State {
  id?: string; status?: string; actionDefinition?: {label?: string} | null; source?: Named | null;
  completedStageIds?: string[]; rollResults?: RollEntry[]; mutationPlans?: Plan[];
  results?: {attackResolution?: {results?: AttackResult[]}; saveResolution?: {results?: SaveResult[]}};
  errors?: Array<{code?: string; reason?: string}>;
  targets?: Named[];
  input?: {targets?: Named[]; actorSystem?: {pools?: Pool[]}; controller?: Named & {actorSystem?: {pools?: Pool[]}}};
}
interface Pool {id?: string; label?: string}
interface ResolutionRecord {resolutionId?: string; initiatorUserId?: string; state?: State | null; options?: {action?: {name?: string}}}

const formulaOf = rollFormulaForRequest as unknown as (request: Data) => {formula?: string | null};
const refsOf = (target: Named | undefined) => [target?.id, target?.uuid, target?.actorRef, target?.actorId, target?.tokenId].filter(Boolean);
const DURABILITY = new Set(["durabilityDamage", "durabilityHealing", "durabilityAbsorption"]);
// The engine values with words in lang/en.json (WILDPATH.INSPECTOR.<group>.<value>); any other shows as it is.
const WORDS = {
  Mode: ["normal", "advantage", "disadvantage"],
  Method: ["digital", "natural", "total", "structured"],
  Outcome: ["hit", "criticalHit", "miss", "criticalMiss", "success", "criticalSuccess", "failure", "criticalFailure"],
  Change: ["damage", "healing", "absorption"],
  EffectAction: ["create", "update", "delete", "noop"]
};
const words = (group: keyof typeof WORDS, value: string | null | undefined) => (value && WORDS[group].includes(value) ? `WILDPATH.INSPECTOR.${group}.${value}`
  : value ?? null);
// A roll the chat card names no way (rollLabel is null) by the pipeline's kind suffix: a die added to a d20 test (Bardic
// Inspiration), a number added (Flash of Genius), a miss made a hit (Peerless Aim), a d20 set (Stroke of Luck, Portent),
// Empowered Spell's reroll, a critical hit made a normal one (Guardian Emblem).
const KIND_SUFFIXES: Array<[string, string]> = [["-added-die", "AddedDie"], ["-added", "Added"], ["-forced-hit", "ForcedHit"], ["-set-natural", "SetNatural"],
  ["-empowered", "Empowered"], ["-uncritical", "Uncritical"]];
/** A roll's kind in words: the chat card's (`rollLabel`, typed damage with its type's key), else by its suffix, else as it is. */
function kindWords(request: Data | undefined, kind: string) {
  const label = (rollLabel as (request: unknown) => {key: string; damageType?: string} | null)(request);
  if ( label?.damageType ) {
    // A type with no lang entry (homebrew) in words, as the chat card names it; the template localizes a key and keeps words.
    const key = damageTypeKey(label.damageType);
    const i18n = (globalThis as {game?: {i18n?: {has(key: string): boolean; localize(key: string): string}}}).game?.i18n;
    return {kindLabel: "WILDPATH.CHAT.Roll.TypedDamage", kindType: !i18n || i18n.has(key) ? key : damageTypeLabel(label.damageType, i18n)};
  }
  if ( label ) return {kindLabel: label.key};
  const suffix = KIND_SUFFIXES.find(([end]) => kind.endsWith(end));
  return {kindLabel: suffix ? `WILDPATH.INSPECTOR.Kind.${suffix[1]}` : kind};
}

export function inspectResolution(record: ResolutionRecord) {
  const state = record.state ?? {};
  // A plan's target may be a target context (the target one level down) or a bare reference; the resolution's own
  // targets carry the names.
  const known = [...(state.targets ?? []), ...(state.input?.targets ?? [])];
  const knownName = (target: Named | undefined) => target?.name ?? target?.target?.name
    ?? known.find(entry => entry.name && refsOf(entry).some(ref => refsOf(target).includes(ref)))?.name;
  const nameOf = (target: Named | undefined) => knownName(target) ?? target?.tokenId ?? target?.actorRef ?? target?.uuid ?? "?";
  // A resource in words: the economy's own label (CONFIG.WILDPATH, a lang key), else the user's or controller's pool name.
  const economy = (WILDPATH as {ECONOMY_RESOURCES?: Record<string, {label?: string}>}).ECONOMY_RESOURCES ?? {};
  const pools = [...(state.input?.actorSystem?.pools ?? []), ...(state.input?.controller?.actorSystem?.pools ?? [])];
  const resourceLabel = (id: string) => economy[id]?.label ?? pools.find(pool => pool.id === id)?.label ?? id;
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
    changes: (state.mutationPlans ?? []).filter(plan => DURABILITY.has(String(plan.type))).map(plan => {
      const type = String(plan.type).replace("durability", "").toLowerCase();
      return {target: nameOf(plan.target ?? plan.plan?.target), type, typeLabel: words("Change", type),
        amount: plan.plan?.amount ?? null, from: plan.plan?.from ?? null, to: plan.plan?.to ?? null};
    }),
    // Conditions and custom effects the Action applies; a condition's name is a lang key the template localizes.
    effects: (state.mutationPlans ?? []).filter(plan => plan.type === "conditionEffect").map(plan => ({
      target: nameOf(plan.target), effect: plan.definition?.name ?? plan.conditionId ?? "?", action: plan.action ?? null,
      actionLabel: words("EffectAction", plan.action)
    })),
    // Who paid, by name when it is a named creature of the resolution (a target's Legendary Resistance), else in words:
    // the acting creature (no `payerRef`, or its own: its own Heroic Inspiration), or another one (a controller, a
    // reaction die's holder).
    payments: (state.mutationPlans ?? []).filter(plan => plan.type === "resourcePayment").flatMap(plan => {
      const other = plan.payerRef && !refsOf(state.source ?? undefined).includes(plan.payerRef) ? plan.payerRef : null;
      const payerLabel = (other ? knownName({actorRef: other, uuid: other}) : knownName(state.source ?? undefined))
        ?? `WILDPATH.INSPECTOR.Payer.${other ? "Other" : "Source"}`;
      return (plan.plan?.payments ?? []).map(payment => ({payerLabel,
        resource: payment.resourceId ?? "", resourceLabel: resourceLabel(payment.resourceId ?? ""),
        from: payment.from ?? null, to: payment.to ?? null}));
    }),
    errors: (state.errors ?? []).map(error => error.reason ?? error.code ?? "")
  };
}
