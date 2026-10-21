/**
 * Level-up and character creation (G8, the maintainer's approved design): what one level of a class (and its
 * subclass), or a species or background at creation, gives, as the steps the level-up dialog shows; and what each
 * choice changes on the creature. Pure data: the dialog (applications/level-up.mts) asks and applies.
 */

type Data = Record<string, unknown>;

export interface AdvancementEntry {
  level?: number; type: string; title?: string | null; classRestriction?: string;
  items?: string[]; optional?: boolean; count?: number; replacement?: boolean;
  /** A choice of any option of a kind, by its source subtype (Eldritch Adept's Invocation), in place of `items`. */
  pool?: {subtype: string};
  grants?: string[]; choices?: Array<{count: number; pool: string[]}>;
  points?: number; cap?: number; abilities?: string[]; fixed?: Record<string, number>; feat?: boolean;
  sizes?: string[];
}

export interface LevelStep {kind: string; title: string | null; entry: AdvancementEntry; source?: unknown}

/** The 2024 weapons by category, for a Weapon Mastery choice ("masteries:martial:*"). */
/**
 * The 2024 languages (dnd5e's keys): the standard ones a character may pick at creation, and the rare ones (Primordial
 * with its four dialects). A creature's languages are its `training.languages`; "standard" stands for every standard
 * language, "rare" for every rare one, "telepathy" for its Telepathy.
 */
export const LANGUAGES = Object.freeze({
  standard: Object.freeze(["common", "sign", "draconic", "dwarvish", "elvish", "giant", "gnomish", "goblin", "halfling", "orc"]),
  rare: Object.freeze(["abyssal", "celestial", "deep", "druidic", "infernal", "primordial", "aquan", "auran", "ignan", "terran",
    "sylvan", "cant", "undercommon", "aarakocra", "gith", "gnoll"])
});

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

/** Where content comes from, each a world setting (`source<Gate>`) that offers it in the level-up dialog or not. */
export const SOURCE_GATES = Object.freeze(["core2014", "core2024", "supplement", "ua", "thirdParty"] as const);
export type SourceGate = typeof SOURCE_GATES[number];
const CORE_PACKAGES = new Set(["wildpath", "wildpath-dnd-players-handbook", "wildpath-dnd-dungeon-masters-guide", "wildpath-dnd-monster-manual"]);

/**
 * Which gate a compendium entry's source (`flags.wildpath.source`) falls under, from the package holding it: the SRD and
 * the core books by their rules (2014, 2024); another local book module (`wildpath-…`) a supplement; Unearthed Arcana
 * by its book's name; a third-party book (Humblewood: `source.thirdParty`), and anything WildPath did not convert, third-party.
 */
export function sourceGate(source: {system?: string; book?: string; rules?: string; thirdParty?: boolean} | null | undefined,
  packageName: string | null | undefined): SourceGate {
  if ( !source?.system || source.thirdParty ) return "thirdParty";
  if ( /Unearthed Arcana|\bUA\b/i.test(String(source.book ?? "")) ) return "ua";
  if ( CORE_PACKAGES.has(String(packageName ?? "")) ) return (source.rules === "2014") ? "core2014" : "core2024";
  return String(packageName ?? "").startsWith("wildpath-") ? "supplement" : "thirdParty";
}

/**
 * A choice's pool against what its creature already has (Items by their compendium source): the options it may still
 * pick, and the ones it has that it may replace (an active Item from the pool: a Fighting Style, an Invocation, a
 * Maneuver, an infusion it knows).
 */
export function choiceOptions(pool: readonly string[], items: Iterable<{id: string; name: string; system?: {active?: boolean};
  _stats?: {compendiumSource?: string | null}}>): {options: string[]; owned: Array<{id: string; name: string}>} {
  const owned = [...items].filter(item => (item.system?.active !== false) && pool.includes(String(item._stats?.compendiumSource ?? "")))
    .map(item => ({id: item.id, name: item.name, source: String(item._stats!.compendiumSource)}));
  const have = new Set(owned.map(item => item.source));
  return {options: pool.filter(uuid => !have.has(uuid)), owned: owned.map(({id, name}) => ({id, name}))};
}

/** What a feat or class option may ask (`flags.wildpath.prerequisites`, scripts/content: prerequisitesOf). */
export interface Prerequisites {level?: number; items?: string[]; abilities?: Array<{ability: string; min: number}>;
  training?: {armor?: string; weapons?: string}; spellcasting?: boolean; classLevel?: {class: string; min: number}; repeatable?: boolean;
  text?: string}
/** What a creature brings to them: its levels, abilities, training, spellcasting and what it has (by identifier). */
export interface PrerequisiteFacts {level: number; classLevels: Record<string, number>; abilities: Record<string, number>;
  training: {armor?: string[]; weapons?: string[]}; spellcasting: boolean; identifiers: ReadonlySet<string>}

/**
 * The prerequisites a creature doesn't meet, by key (none: it may take it). `level` is its character level for a feat,
 * the class's for a class option (an Invocation: `level` in `facts`). Something it already has is left out unless
 * repeatable (`identifier`). Text it can't check (`text`) is not unmet.
 */
export function unmetPrerequisites(prerequisites: Prerequisites | null | undefined, facts: PrerequisiteFacts, {identifier=null}:
  {identifier?: string | null} = {}): string[] {
  const unmet: string[] = [];
  const p = prerequisites ?? {};
  if ( p.level && (facts.level < p.level) ) unmet.push("level");
  if ( p.items?.some(key => !facts.identifiers.has(key)) ) unmet.push("items");
  if ( p.abilities?.length && !p.abilities.some(({ability, min}) => (facts.abilities[ability] ?? 0) >= min) ) unmet.push("abilities");
  if ( p.training?.armor && !(facts.training.armor ?? []).includes(p.training.armor) ) unmet.push("training");
  if ( p.training?.weapons && !(facts.training.weapons ?? []).some(key => key === p.training!.weapons || key.startsWith(`${p.training!.weapons}`)) ) unmet.push("training");
  if ( p.spellcasting && !facts.spellcasting ) unmet.push("spellcasting");
  if ( p.classLevel && ((facts.classLevels[p.classLevel.class] ?? 0) < p.classLevel.min) ) unmet.push("classLevel");
  if ( identifier && !p.repeatable && facts.identifiers.has(identifier) ) unmet.push("repeatable");
  return unmet;
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
    // Languages: every one, the standard ones, or the rare ones.
    const pick = ({"languages:*": [...LANGUAGES.standard, ...LANGUAGES.rare], "languages:standard:*": LANGUAGES.standard,
      "languages:rare:*": LANGUAGES.rare} as Record<string, readonly string[]>)[key];
    if ( pick ) return pick.map(language => `languages:${language}`);
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
    else if ( ["armor", "weapons", "tools", "masteries", "languages"].includes(kind) ) (lists[kind] ??= new Set(training[kind] ?? [])).add(value);
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
    else if ( ["armor", "weapons", "tools", "masteries", "languages"].includes(kind) ) training[kind] = [...new Set([...(training[kind] ?? []), value])];
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
