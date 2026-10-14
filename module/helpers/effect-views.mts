/**
 * A creature's active conditions and the custom effects WildPath Actions gave it (Dodging, Blessed...), as icons with
 * what a tooltip explains (after Baldur's Gate 3): the condition's rules summary and the time left. Conditions come
 * first, in their configured order; custom effects follow.
 */

interface ConditionDefinition {id: string; name: string; img: string; stacking?: boolean; summary?: string}
interface EffectLike {
  id?: string | null; name?: string; img?: string | null; disabled?: boolean; isSuppressed?: boolean; isTemporary?: boolean;
  system?: {type?: string; level?: number}; duration?: {label?: string; remaining?: number};
  flags?: {wildpath?: {conditionEffect?: unknown}};
}

/** The time left on a temporary effect ("2 Rounds"), or null. */
const remainingOf = (effect: EffectLike) => (effect.isTemporary && Number.isFinite(effect.duration?.remaining)
  && effect.duration?.label ? effect.duration.label : null);

export function activeEffectViews(effects: Iterable<EffectLike> = [], conditions: readonly ConditionDefinition[] = []) {
  const active = [...effects].filter(effect => !effect.disabled && !effect.isSuppressed);
  const byCondition = new Map(active.filter(effect => effect.system?.type).map(effect => [String(effect.system!.type), effect]));
  const known = new Set(conditions.map(condition => condition.id));
  return [
    ...conditions.filter(condition => byCondition.has(condition.id)).map(condition => {
      const effect = byCondition.get(condition.id)!;
      return {id: condition.id, name: condition.name, img: condition.img, summary: condition.summary ?? null,
        level: condition.stacking ? (Number(effect.system?.level) || null) : null, remaining: remainingOf(effect)};
    }),
    ...active.filter(effect => effect.flags?.wildpath?.conditionEffect && effect.img && !known.has(String(effect.system?.type ?? "")))
      .map(effect => ({id: effect.id ?? "", name: effect.name ?? "", img: effect.img!, summary: null, level: null,
        remaining: remainingOf(effect)}))
  ];
}
