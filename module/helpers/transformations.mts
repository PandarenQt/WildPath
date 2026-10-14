/**
 * A transformation: a creature takes some statistics from a form (another Actor's stat block) while keeping
 * the rest of itself. Maintainer decision (2026-10-14): the creature keeps its feats, the properties of the
 * items that still apply, and similar; the form supplies the listed statistics, its features and its Actions.
 */

/** Wild Shape's shape by default: the form's physical abilities, Armor Class and speed. */
export const DEFAULT_FORM_STATISTICS = Object.freeze([
  "abilities.might.value", "abilities.agility.value", "abilities.fortitude.value", "defenses.ac.value", "resources.movement.base"
]);

/** The creature's own Item types that keep contributing while it is transformed. */
export const DEFAULT_KEPT_ITEM_TYPES = Object.freeze(["feature", "gear"]);

export interface TransformationPolicy {
  readonly formRef: string;
  readonly takes?: readonly string[];
  readonly keepItemTypes?: readonly string[];
}

/**
 * The prepared values a form provides: each taken path's value from the form's own system data. A path the
 * form lacks is skipped, so the creature keeps that statistic.
 */
export function formOverrides(formSystem: unknown, takes: readonly string[] = DEFAULT_FORM_STATISTICS): Array<[string, unknown]> {
  return takes.flatMap(path => {
    const value = path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], formSystem);
    return value === undefined ? [] : [[path, value] as [string, unknown]];
  });
}

/** Whether one of the creature's own Items still contributes while it is transformed. */
export function itemContributesWhileTransformed(itemType: string | undefined, policy: TransformationPolicy) {
  return (policy.keepItemTypes ?? DEFAULT_KEPT_ITEM_TYPES).includes(String(itemType));
}
