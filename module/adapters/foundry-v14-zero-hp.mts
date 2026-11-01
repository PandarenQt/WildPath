import {resolveActorResourcePayment} from "../resolvers/resource-resolver.mjs";
import {evaluateValueExpression} from "../helpers/value-expressions.mjs";
import {combineRollModes} from "../helpers/rolls.mjs";
import {resolveActorSaveStatistic} from "../helpers/combat-statistics.mjs";

type Data = Record<string, any>;

/**
 * What keeps a creature up when damage would drop it to 0 Hit Points: its feature's `health.zero` Trigger (Relentless
 * Endurance, Relentless Rage, Undead Fortitude), worked out for it now (hit points, the DC from its uses, its save bonus
 * and roll mode, and the use it pays). Null when it has none that applies.
 */
export function zeroHpFor(actor: Data | null | undefined, actorSystem: Data | null | undefined): Data | null {
  if ( !actor ) return null;
  // Its features' rules, and its effects' (2024 Death Ward: "the target instead drops to 1 Hit Point, and the spell
  // ends"): a Trigger from an effect names it (`effectUuid`), which ends once it is used; a Phase's effect stays.
  const owners = [...[...(actor.items ?? [])].filter((item: Data) => item?.system?.active !== false).map((item: Data) => ({item, effect: null})),
    ...[...(actor.effects ?? [])].filter((effect: Data) => !effect?.disabled).map((effect: Data) => ({item: effect, effect}))];
  for ( const {item, effect} of owners ) {
    for ( const rule of item?.system?.ruleElements ?? [] ) {
      const spec = ((rule?.type === "Trigger") && (rule.data?.event === "health.zero")) ? rule.data.zeroHp
        : ((rule?.type === "Phase") && (rule.data?.on === "zero-hp")) ? phaseSpec(actor, rule.data) : null;
      if ( !spec || (spec.whileStatus && !actor.statuses?.has?.(spec.whileStatus)) ) continue;
      const poolId = spec.pool ?? spec.dc?.usesPool ?? null;
      const payment = poolId ? resolveActorResourcePayment({actorSystem, cost: {allOf: [{capability: poolId, amount: 1}]}}) : null;
      if ( payment && !payment.ok ) continue;
      const pool = (actorSystem?.pools ?? []).find((entry: Data) => entry.id === poolId);
      const value = (expression: unknown) => ((expression && (typeof expression === "object")) ? Number(evaluateValueExpression(expression, {actor, actorSystem}).value)
        : Number(expression));
      const ability = spec.ability ?? null;
      const rollMode = ability ? combineRollModes(actor.getRollModes?.(["save", `save.${ability}`], {}) ?? []) : null;
      return {name: item.name ?? "", mode: (spec.mode === "save") ? "save" : "set", hitPoints: Math.max(Math.trunc(value(spec.hitPoints ?? 1) || 1), 1),
        ...((effect?.uuid && (rule.type === "Trigger")) ? {effectUuid: effect.uuid} : {}),
        ...(spec.flag ? {flag: spec.flag, actorUuid: actor.uuid ?? null} : {}),
        ...(ability ? {ability, saveBonus: resolveActorSaveStatistic(actor, ability)?.totalModifier ?? 0,
          ...((rollMode && (rollMode !== "normal")) ? {rollMode} : {})} : {}),
        ...((spec.dc?.base != null) ? {dc: Number(spec.dc.base)
          + ((Number(spec.dc.perUse) || 0) * Math.max((Number(pool?.max) || 0) - (Number(pool?.value) || 0), 0))} : {}),
        ...((spec.dc?.plusDamage != null) ? {dcPlusDamage: Number(spec.dc.plusDamage)} : {}),
        ...(spec.notOn?.length ? {notOn: [...spec.notOn]} : {}),
        ...(payment ? {payment: {plan: payment.mutationPlan, payerRef: actor.uuid}} : {})};
    }
  }
  return null;
}

/**
 * A `Phase` (a mythic creature's) as a zero-HP rule: it sets `restore` Hit Points and `mythicPhase`, the flag the `mythic`
 * Forbid reads (actor.mjs); `once`, only while that is unset.
 */
function phaseSpec(actor: Data, data: Data): Data | null {
  const flag = "mythicPhase";
  if ( (data.once !== false) && actor.flags?.wildpath?.[flag] ) return null;
  return {mode: "set", hitPoints: data.restore, flag};
}

/**
 * A Phase that kept its creature up begins: its flag is set (`mythicPhase`, which the `mythic` Forbid reads), and everyone is
 * told, as the card that dropped it is. The line names mythic actions, the only thing a phase unlocks yet.
 */
export async function beginPhase(actor: Data | null | undefined, rule: Data | null | undefined, {game = (globalThis as Data).game}: {game?: Data} = {}) {
  if ( !rule?.flag || (typeof actor?.setFlag !== "function") ) return;
  await actor.setFlag("wildpath", rule.flag, true);
  const text = game?.i18n?.format?.("WILDPATH.NOTIFY.PhaseBegan", {name: actor.name ?? "", feature: rule.name ?? ""}) ?? actor.name ?? "";
  const escape = (globalThis as Data).foundry?.utils?.escapeHTML ?? ((value: string) => value);
  await (globalThis as Data).ChatMessage?.create?.({speaker: {alias: actor.name ?? ""}, content: `<p>${escape(String(text))}</p>`});
}
