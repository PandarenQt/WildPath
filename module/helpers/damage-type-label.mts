/**
 * A damage type in words, one rule for every place that names one (chat card, floating text, the configuration dialog,
 * Metamagic). Damage types are configurable (any slug), so a type with no entry in lang/en.json reads as its id.
 */

/** Its lang key: WILDPATH.DAMAGE.<Type>, the first letter capitalised as the keys are ("fire" is WILDPATH.DAMAGE.Fire). */
export function damageTypeKey(type: string) {
  return `WILDPATH.DAMAGE.${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}

/** Its words: its lang entry, else its id made readable ("eldritch-fire" is "Eldritch Fire"). */
export function damageTypeLabel(type: string, i18n: {has(key: string): boolean; localize(key: string): string}) {
  const key = damageTypeKey(type);
  return i18n.has(key) ? i18n.localize(key)
    : type.split(/[-_.]/u).filter(Boolean).map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ");
}
