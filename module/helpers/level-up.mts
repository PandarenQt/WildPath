/**
 * Level-up and character creation (G8, the maintainer's approved design): what one level of a class (and its
 * subclass), or a species or background at creation, gives, as the steps the level-up dialog shows; and what each
 * choice changes on the creature. Pure data: the dialog (applications/level-up.mts) asks and applies.
 */

type Data = Record<string, unknown>;

export interface AdvancementEntry {
  level?: number; type: string; title?: string | null; classRestriction?: string;
  items?: string[]; optional?: boolean; count?: number;
  grants?: string[]; choices?: Array<{count: number; pool: string[]}>;
  points?: number; cap?: number; abilities?: string[]; fixed?: Record<string, number>; feat?: boolean;
  sizes?: string[];
}

export interface LevelStep {kind: string; title: string | null; entry: AdvancementEntry; source?: unknown}

/** The 2024 weapons by category, for a Weapon Mastery choice ("masteries:martial:*"). */
export const WEAPONS = Object.freeze({
  simple: ["club", "dagger", "greatclub", "handaxe", "javelin", "light-hammer", "mace", "quarterstaff", "sickle", "spear", "dart",
    "light-crossbow", "shortbow", "sling"],
  martial: ["battleaxe", "flail", "glaive", "greataxe", "greatsword", "halberd", "lance", "longsword", "maul", "morningstar", "pike",
    "rapier", "scimitar", "shortsword", "trident", "warhammer", "war-pick", "whip", "blowgun", "hand-crossbow", "heavy-crossbow",
    "longbow", "musket", "pistol"]
} as Record<string, readonly string[]>);

/**
 * The steps of reaching `level` (0: a species or background at creation): its entries, without those for the other
 * kind of class (an original class's `primary` entries, a multiclass's `secondary` ones).
 */
export function levelSteps(advancement: readonly AdvancementEntry[], level: number, {original=true}: {original?: boolean}={}): LevelStep[] {
  return advancement.filter(entry => (Number(entry.level) || 0) === level)
    .filter(entry => !entry.classRestriction || (entry.classRestriction === (original ? "primary" : "secondary")))
    .map(entry => ({kind: entry.type, title: entry.title ?? null, entry}));
}

/** 2024 hit points for a class level: the Hit Die's maximum at a character's first level, else its average rounded up, plus the Fortitude modifier; at least 1. */
export function hitPointsForLevel({hitDie, first, fortitude}: {hitDie: number; first: boolean; fortitude: number}) {
  return Math.max(1, (first ? hitDie : Math.floor(hitDie / 2) + 1) + fortitude);
}

/**
 * The keys a choice offers: `skills:*` (or `expertise:*`) is every skill, `masteries:martial:*` every martial weapon,
 * `masteries:*` every weapon, the rest as they are.
 */
export function poolOptions(pool: readonly string[], {skills}: {skills: readonly string[]}): string[] {
  return [...new Set(pool.flatMap(key => {
    if ( key === "skills:*" ) return skills.map(skill => `skills:${skill}`);
    if ( key === "expertise:*" ) return skills.map(skill => `expertise:${skill}`);
    if ( key === "masteries:*" ) return [...(WEAPONS.simple ?? []), ...(WEAPONS.martial ?? [])].map(weapon => `masteries:${weapon}`);
    const match = /^(masteries|weapons):(simple|martial):\*$/.exec(key);
    if ( match ) return (WEAPONS[match[2]!] ?? []).map(weapon => `${match[1]}:${weapon}`);
    return [key];
  }))];
}

/**
 * What trait keys change on a creature (`system` its data): a skill proficient (expertise kept), a save proficient,
 * a training list with the name added. Returns update paths.
 */
export function traitUpdates(keys: readonly string[], system: Data): Data {
  const updates: Data = {};
  const training = (system.training ?? {}) as Record<string, string[] | undefined>;
  const lists: Record<string, Set<string>> = {};
  for ( const key of keys ) {
    const [kind, ...rest] = key.split(":");
    const value = rest.join(":");
    if ( !kind || !value || value.endsWith("*") ) continue;
    if ( (kind === "skills") || (kind === "expertise") ) {
      const current = Number(((system.skills as Data | undefined)?.[value] as {proficiency?: number} | undefined)?.proficiency) || 0;
      updates[`system.skills.${value}.proficiency`] = Math.max(current, (kind === "expertise") ? 2 : 1);
    } else if ( kind === "saves" ) updates[`system.abilities.${value}.saveProficient`] = true;
    else if ( ["armor", "weapons", "tools", "masteries"].includes(kind) ) (lists[kind] ??= new Set(training[kind] ?? [])).add(value);
  }
  for ( const [kind, names] of Object.entries(lists) ) updates[`system.training.${kind}`] = [...names];
  return updates;
}

/**
 * Trait keys merged into a creature's prepared data in place (G8): what its Items give it (`flags.wildpath.training`)
 * over its own. A skill proficient (`expertise:` its Expertise), a save proficient, a training list with the name
 * added. Nothing is written: losing the Item loses what it gave.
 */
export function mergeTraining(system: Data, keys: readonly string[]): void {
  const skills = (system.skills ?? {}) as Record<string, {proficiency?: number} | undefined>;
  const abilities = (system.abilities ?? {}) as Record<string, {saveProficient?: boolean} | undefined>;
  const training = (system.training ??= {}) as Record<string, string[] | undefined>;
  for ( const key of keys ) {
    const [kind, ...rest] = String(key).split(":");
    const value = rest.join(":");
    if ( !kind || !value || value.endsWith("*") ) continue;
    const skill = skills[value];
    if ( ((kind === "skills") || (kind === "expertise")) && skill ) {
      skill.proficiency = Math.max(Number(skill.proficiency) || 0, (kind === "expertise") ? 2 : 1);
    } else if ( (kind === "saves") && abilities[value] ) abilities[value]!.saveProficient = true;
    else if ( ["armor", "weapons", "tools", "masteries"].includes(kind) ) training[kind] = [...new Set([...(training[kind] ?? []), value])];
  }
}

/** An ability increase (2024): each chosen ability raised by its points, never above `cap` points each or 20. */
export function improvementUpdates(increases: Record<string, number>, system: Data, {cap=2, points=2}: {cap?: number; points?: number}={}) {
  const updates: Data = {};
  let spent = 0;
  for ( const [ability, amount] of Object.entries(increases) ) {
    const add = Math.min(Math.max(Math.floor(Number(amount) || 0), 0), cap, points - spent);
    if ( !add ) continue;
    spent += add;
    const score = Number(((system.abilities as Data | undefined)?.[ability] as {value?: number} | undefined)?.value) || 10;
    updates[`system.abilities.${ability}.value`] = Math.min(score + add, 20);
  }
  return updates;
}

/** Multiclassing (2024): the classes whose primary abilities are below 13 (all of them, or one when `all` is false). */
export function multiclassShortfalls(classes: ReadonlyArray<{name: string; primaryAbility?: {abilities?: string[]; all?: boolean}}>,
  scores: Record<string, number>): string[] {
  return classes.filter(({primaryAbility}) => {
    const abilities = primaryAbility?.abilities ?? [];
    const met = (ability: string) => (scores[ability] ?? 10) >= 13;
    return abilities.length > 0 && !(primaryAbility?.all === false ? abilities.some(met) : abilities.every(met));
  }).map(entry => entry.name);
}

/** 2024 ability score generation: the standard array, and point buy's costs (27 points, scores 8 to 15). */
export const STANDARD_ARRAY = Object.freeze([15, 14, 13, 12, 10, 8]);
export const POINT_BUY = Object.freeze({budget: 27, costs: Object.freeze({8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9}) as Record<number, number>});

/** The points `scores` cost to buy, or null when one is outside 8 to 15. */
export function pointBuySpent(scores: readonly number[]): number | null {
  let spent = 0;
  for ( const score of scores ) {
    const cost = POINT_BUY.costs[score];
    if ( cost === undefined ) return null;
    spent += cost;
  }
  return spent;
}

/** Whether `scores` use each value of `pool` exactly once (a standard array, or rolled scores). */
export function usesPool(scores: readonly number[], pool: readonly number[]) {
  const sorted = (list: readonly number[]) => [...list].sort((a, b) => a - b).join(",");
  return (scores.length === pool.length) && (sorted(scores) === sorted(pool));
}
