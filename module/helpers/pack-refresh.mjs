/**
 * Refreshing a world's Items from the compendium they came from (`_stats.compendiumSource`), so a world picks up
 * converter fixes without hand-patching (plan 4.2). A refresh takes what the converter writes: an Item's rules and
 * Action, its description and costs, and its own `flags.wildpath` keys. Everything a table changes in play stays: its
 * name and image, active or equipped, prepared, quantity, identified, and any `flags.wildpath` key the pack lacks (an
 * Action's `grantedBy`).
 */

/** The `system` fields the converter writes. */
export const REFRESHED_SYSTEM_FIELDS = Object.freeze(["definition", "ruleElements", "modifiers", "description", "cost", "advancement"]);

/**
 * `flags.wildpath` keys play writes on an Item, never taken from the pack: its reaction setting, the training and
 * Arcanum chosen for it, what replaced it at level-up, what granted it, a facility's build cost.
 */
export const KEPT_FLAGS = Object.freeze(["reactionPolicy", "training", "arcanum", "replaced", "grantedBy", "buildCost"]);

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * What an Item (`source`, its plain data) would take from its compendium copy (`packSource`): `{system, flags}`, each
 * field or `flags.wildpath` key whose value differs, or null when nothing does or the two are of different types.
 */
export function refreshChanges(source, packSource) {
  if ( !source || !packSource || (source.type !== packSource.type) ) return null;
  const system = {};
  for ( const field of REFRESHED_SYSTEM_FIELDS ) {
    if ( !Object.hasOwn(packSource.system ?? {}, field) ) continue;
    if ( !same(source.system?.[field], packSource.system[field]) ) system[field] = clone(packSource.system[field]);
  }
  const flags = {};
  for ( const [key, value] of Object.entries(packSource.flags?.wildpath ?? {}) ) {
    if ( !KEPT_FLAGS.includes(key) && !same(source.flags?.wildpath?.[key], value) ) flags[key] = clone(value);
  }
  return (Object.keys(system).length || Object.keys(flags).length) ? {system, flags} : null;
}
