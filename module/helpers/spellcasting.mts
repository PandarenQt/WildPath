/**
 * Class and spellcasting progression for the 2024 rules, as pure data functions. The Actor model derives
 * its total level, original class and spell slots from these; another ruleset replaces this module rather
 * than branching inside callers (AGENTS §10).
 */

export const SPELLCASTING_PROGRESSIONS = Object.freeze({NONE: "none", FULL: "full", HALF: "half"});

/** The pool that holds slots of one spell level; slot payments name it as their capability. */
export const spellSlotPoolId = (spellLevel: number) => `spell-slot.${spellLevel}`;

export interface ClassRecord {
  readonly id: string;
  readonly name?: string;
  readonly level: number;
  readonly original?: boolean;
  readonly subclasses?: readonly string[];
  readonly spellcasting?: {readonly progression?: string; readonly ability?: string};
  readonly hitDie?: number | null;
}

/** The pool that holds a creature's Hit Dice of one size (`hit-die.d10`). */
export const hitDiePoolId = (faces: number) => `hit-die.d${faces}`;

/** What spent Hit Dice heal: each die's roll plus the Fortitude modifier, at least `minimum` (2024: 1; 2014: 0). */
export const hitDiceHealing = (results: readonly number[], modifier: number, {minimum=1}: {minimum?: number}={}) =>
  results.reduce((sum, result) => sum + Math.max(minimum, result + modifier), 0);

// Slots per spell level (1st-9th) at each caster level 1-20: the 2024 multiclass spellcaster table.
const SLOTS_BY_CASTER_LEVEL: readonly (readonly number[])[] = [
  [], [2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1],
  [4, 3, 3, 3, 2], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1]
];

/**
 * 2024 caster level: every level in a full-caster class, plus half the levels in each half-caster class,
 * rounded up per class. A single-class half-caster therefore uses the same table (Paladin 5 = caster 3).
 */
export function casterLevel(classes: readonly ClassRecord[]): number {
  return classes.reduce((total, entry) => {
    const level = Math.max(Number(entry.level) || 0, 0);
    const progression = entry.spellcasting?.progression;
    if (progression === SPELLCASTING_PROGRESSIONS.FULL) return total + level;
    if (progression === SPELLCASTING_PROGRESSIONS.HALF) return total + Math.ceil(level / 2);
    return total;
  }, 0);
}

/** Slots for spell levels 1-9 at a caster level (nine entries, zero where none). */
export function spellSlots(level: number): number[] {
  const row = SLOTS_BY_CASTER_LEVEL[Math.min(Math.max(Math.floor(level) || 0, 0), 20)] ?? [];
  return Array.from({length: 9}, (_, index) => row[index] ?? 0);
}

/**
 * What an Actor's class records mean: the total level, the original (level-1) class, and spellcasting.
 * The original class is the one marked `original`, else the first. The Actor's spellcasting ability is
 * the original class's when it casts, else the first casting class's; each class keeps its own.
 */
export function deriveClassData(classes: readonly ClassRecord[]) {
  const level = classes.reduce((total, entry) => total + Math.max(Number(entry.level) || 0, 0), 0);
  const original = classes.find(entry => entry.original) ?? classes[0] ?? null;
  const casts = (entry: ClassRecord | null) => !!entry?.spellcasting?.progression
    && (entry.spellcasting.progression !== SPELLCASTING_PROGRESSIONS.NONE);
  const caster = casts(original) ? original : classes.find(casts) ?? null;
  const levelForSlots = casterLevel(classes);
  // One Hit Die per class level, of that class's size; a multiclass creature holds several sizes.
  const hitDice: Record<string, number> = {};
  for ( const entry of classes ) {
    if ( !Number(entry.hitDie) ) continue;
    const id = hitDiePoolId(Number(entry.hitDie));
    hitDice[id] = (hitDice[id] ?? 0) + Math.max(Number(entry.level) || 0, 0);
  }
  return {
    level,
    original,
    spellcasting: {casterLevel: levelForSlots, ability: caster?.spellcasting?.ability || null, slots: spellSlots(levelForSlots)},
    hitDice
  };
}

interface PreparingItem {
  type?: string; flags?: {wildpath?: {grantedBy?: string | null}};
  system?: {prepared?: boolean; definition?: {tags?: string[]; configuration?: Array<{id?: string}>}};
}

/**
 * Whether a creature prepares this Action (2024): a spell of 1st level or higher (one that spends a spell slot). A
 * spell a feature or item gave it (a subclass's, a wand's) is always prepared.
 */
export function preparesSpell(item: PreparingItem | null | undefined) {
  const definition = item?.system?.definition;
  return (item?.type === "action") && !item.flags?.wildpath?.grantedBy && !!definition?.tags?.includes("spell")
    && !!definition.configuration?.some(choice => choice?.id === "spell-slot");
}

/** A spell its creature has not prepared, so it can't cast it. */
export const isUnprepared = (item: PreparingItem | null | undefined) => preparesSpell(item) && (item?.system?.prepared === false);

/** How many spells a creature's classes let it prepare: each class's table at its level, summed; null with none. */
export function preparedSpellLimit(classes: ReadonlyArray<{system?: {levels?: number; spellcasting?: {prepared?: number[]}}}>) {
  const limits = classes.map(entry => entry.system?.spellcasting?.prepared?.[(Number(entry.system?.levels) || 1) - 1])
    .filter((value): value is number => Number.isFinite(value));
  return limits.length ? limits.reduce((sum, value) => sum + value, 0) : null;
}
