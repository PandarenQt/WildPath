/**
 * Class and spellcasting progression for the 2024 rules, as pure data functions. The Actor model derives
 * its total level, original class and spell slots from these; another ruleset replaces this module rather
 * than branching inside callers (AGENTS §10).
 */

// A third caster (Eldritch Knight, Arcane Trickster) casts through its subclass: `effectiveSpellcasting`.
export const SPELLCASTING_PROGRESSIONS = Object.freeze({NONE: "none", FULL: "full", HALF: "half", THIRD: "third", PACT: "pact"});

/** The pool that holds slots of one spell level; slot payments name it as their capability. */
export const spellSlotPoolId = (spellLevel: number) => `spell-slot.${spellLevel}`;

/** The pool of Pact Magic slots: it pays for any slot up to its level (action-economy), recovered on a Short Rest. */
export const PACT_SLOT_POOL = "spell-slot.pact";

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

/**
 * 2014: a Long Rest gives back spent Hit Dice up to half of all of them (at least one), the largest dice first (a
 * multiclass character's d10s before its d6s: what heals most later). `pools` are `{id: "hit-die.d10", value, max}`;
 * returns each one's new value by id.
 */
export function longRestHitDice(pools: readonly {id: string; value?: number; max?: number}[]): Record<string, number> {
  const dice = pools.filter(pool => String(pool.id).startsWith("hit-die."));
  let budget = Math.max(1, Math.floor(dice.reduce((total, pool) => total + (Number(pool.max) || 0), 0) / 2));
  const size = (id: string) => Number(/(\d+)$/.exec(id)?.[1]) || 0;
  const values: Record<string, number> = {};
  for ( const pool of [...dice].sort((a, b) => size(b.id) - size(a.id)) ) {
    const regained = Math.min(budget, Math.max((Number(pool.max) || 0) - (Number(pool.value) || 0), 0));
    values[pool.id] = (Number(pool.value) || 0) + regained;
    budget -= regained;
  }
  return values;
}

// Slots per spell level (1st-9th) at each caster level 1-20: the 2024 multiclass spellcaster table.
const SLOTS_BY_CASTER_LEVEL: readonly (readonly number[])[] = [
  [], [2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1],
  [4, 3, 3, 3, 2], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1]
];

/**
 * 2024 caster level: every level in a full-caster class, plus half the levels in each half-caster class rounded up,
 * plus a third of the levels in each third-caster class rounded down. A single-class half caster therefore uses the same
 * table (Paladin 5 = caster 3). A third caster with no other casting class uses its own table, which is the multiclass
 * table at a third of its level rounded up, from level 3 (Eldritch Knight 7 = caster 3: four 1st- and two 2nd-level slots).
 */
export function casterLevel(classes: readonly ClassRecord[]): number {
  const casting = classes.filter(entry => !([undefined, SPELLCASTING_PROGRESSIONS.NONE, SPELLCASTING_PROGRESSIONS.PACT] as Array<string | undefined>)
    .includes(entry.spellcasting?.progression));
  return classes.reduce((total, entry) => {
    const level = Math.max(Number(entry.level) || 0, 0);
    const progression = entry.spellcasting?.progression;
    if (progression === SPELLCASTING_PROGRESSIONS.FULL) return total + level;
    if (progression === SPELLCASTING_PROGRESSIONS.HALF) return total + Math.ceil(level / 2);
    if (progression === SPELLCASTING_PROGRESSIONS.THIRD) {
      return total + ((casting.length === 1) ? ((level >= 3) ? Math.ceil(level / 3) : 0) : Math.floor(level / 3));
    }
    return total;
  }, 0);
}

interface CastingItem {type?: string; system?: {identifier?: string; classIdentifier?: string; levels?: number;
  spellcasting?: {progression?: string; ability?: string; prepared?: number[]}}}

/**
 * A class Item's spellcasting, or its subclass's when the class has none of its own (2024 Eldritch Knight and Arcane
 * Trickster: the Fighter and Rogue cast through them). `items` are its creature's Items.
 */
export function effectiveSpellcasting(classItem: CastingItem, items: readonly CastingItem[] = []) {
  const own = classItem.system?.spellcasting;
  if ( own?.progression && (own.progression !== SPELLCASTING_PROGRESSIONS.NONE) ) return own;
  const subclass = items.find(entry => (entry.type === "subclass") && (entry.system?.classIdentifier === classItem.system?.identifier)
    && !!entry.system?.spellcasting?.progression && (entry.system.spellcasting.progression !== SPELLCASTING_PROGRESSIONS.NONE));
  return subclass?.system?.spellcasting ?? own ?? {progression: SPELLCASTING_PROGRESSIONS.NONE, ability: ""};
}

/** Slots for spell levels 1-9 at a caster level (nine entries, zero where none). */
export function spellSlots(level: number): number[] {
  const row = SLOTS_BY_CASTER_LEVEL[Math.min(Math.max(Math.floor(level) || 0, 0), 20)] ?? [];
  return Array.from({length: 9}, (_, index) => row[index] ?? 0);
}

/**
 * 2024 Pact Magic from the levels of pact classes (the Warlock): 1 slot, 2 from level 2, 3 from 11, 4 from 17, all of
 * one level, half the class level rounded up and at most 5. Separate from the multiclass slots (casterLevel).
 */
export function pactMagic(classes: readonly ClassRecord[]): {slots: number; level: number} {
  const level = classes.filter(entry => entry.spellcasting?.progression === SPELLCASTING_PROGRESSIONS.PACT)
    .reduce((total, entry) => total + Math.max(Number(entry.level) || 0, 0), 0);
  if ( !level ) return {slots: 0, level: 0};
  return {slots: (level >= 17) ? 4 : (level >= 11) ? 3 : (level >= 2) ? 2 : 1, level: Math.min(Math.ceil(level / 2), 5)};
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
    spellcasting: {casterLevel: levelForSlots, ability: caster?.spellcasting?.ability || null, slots: spellSlots(levelForSlots),
      pact: pactMagic(classes)},
    hitDice
  };
}

/**
 * A spell's own level: the lowest its slot choice names (`levelByResourceId`, which Foundry may store nested as
 * `{"spell-slot": {"6": 6}}`), or null for an Action with no slot choice (a cantrip).
 */
export function spellBaseLevel(definition: {configuration?: Array<{id?: string; levelByResourceId?: Record<string, unknown>}>} | null | undefined) {
  const choice = definition?.configuration?.find(entry => entry?.id === "spell-slot");
  const levels = Object.values(choice?.levelByResourceId ?? {})
    .flatMap(value => ((value && (typeof value === "object")) ? Object.values(value as Record<string, unknown>) : [value]))
    .map(Number).filter(Number.isFinite);
  return levels.length ? Math.min(...levels) : null;
}

/**
 * `flags.wildpath` keys the system writes or reads on an Item itself: a spell choice may not mark spells with one, or
 * marking a spell would change what it was granted by, its source, its training, its free casts, or make the spell a
 * feature (`damageTwice`, `ignoresResistance`, `slotRecall`, `choiceFor`: read from any active Item).
 */
export const RESERVED_SPELL_FLAGS: readonly string[] = Object.freeze(["grantedBy", "source", "training", "freeCast", "conversion", "replaced",
  "reactionPolicy", "buildCost", "spellChoice", "damageTwice", "ignoresResistance", "slotRecall", "choiceFor", "summonSource", "onceUsed",
  "grants", "grantedActions", "castingAbilities", "metamagic", "trainingPermanent", "prerequisites", "price", "rarity", "scrollLevel"]);

/**
 * A feature's spell choice (`flags.wildpath.spellChoice`): the spells its creature may mark, by the spell's own
 * `flags.wildpath.<flag>`. `levels`: the spell levels it may mark. `count` 1 (the default): one spell a level, its mark
 * `true`; higher: up to `count` spells, each marked with its number. `costs`: capabilities the spell must cost (an
 * Action). `resourceId`: the pool a marked spell spends to be cast at its own level (`{n}`: the mark's number, `{level}`:
 * the spell's level); without one it is cast free. 2024 Mystic Arcanum, Spell Mastery, Signature Spells.
 */
export interface SpellChoice {id: string; name: string; flag: string; levels: number[]; count: number; costs: string[]; resourceId: string | null}

interface ChoosingFeature {id?: string; name?: string; system?: {active?: boolean}; flags?: {wildpath?: {spellChoice?: unknown}}}

/** A feature's spell choice read: the choice, the problem that makes it unreadable, or null without one. */
function readSpellChoice(feature: ChoosingFeature | null | undefined): SpellChoice | string | null {
  const raw = feature?.flags?.wildpath?.spellChoice as Record<string, unknown> | null | undefined;
  if ( !raw ) return null;
  const fail = (reason: string) => `WildPath | ${feature?.name ?? "A feature"}: flags.wildpath.spellChoice ${reason}`;
  const flag = (typeof raw.flag === "string") ? raw.flag : "";
  if ( !/^[A-Za-z][\w-]*$/u.test(flag) ) return fail("needs a flag name (letters, digits, - or _).");
  if ( RESERVED_SPELL_FLAGS.includes(flag) ) return fail(`may not mark "${flag}": the system uses it.`);
  const levels = Array.isArray(raw.levels) ? raw.levels.map(Number).filter(level => Number.isInteger(level) && (level >= 1) && (level <= 9)) : [];
  if ( !levels.length ) return fail("needs levels from 1 to 9.");
  const count = (raw.count === undefined) ? 1 : Number(raw.count);
  if ( !Number.isInteger(count) || (count < 1) ) return fail("count must be a whole number of 1 or more.");
  return {id: feature?.id ?? "", name: feature?.name ?? "", flag, levels, count,
    costs: Array.isArray(raw.costs) ? raw.costs.map(String) : [], resourceId: (typeof raw.resourceId === "string") ? raw.resourceId : null};
}

/** A feature's spell choice, or null without one. A malformed one, or one marking a reserved flag, fails explicitly. */
export function spellChoiceOf(feature: ChoosingFeature | null | undefined): SpellChoice | null {
  const choice = readSpellChoice(feature);
  if ( typeof choice === "string" ) throw new Error(choice);
  return choice;
}

/** What makes a feature's spell choice unreadable, in words; null when it has none or it reads. */
export function spellChoiceProblem(feature: ChoosingFeature | null | undefined): string | null {
  const choice = readSpellChoice(feature);
  return (typeof choice === "string") ? choice : null;
}

/**
 * The spell choices of a creature's active features. A malformed one is skipped, not thrown: these are read while its
 * sheet renders and its spells are used, so one bad feature would block both. Its sheet names it (`spellChoiceProblem`)
 * and an edit storing one is refused.
 */
export function spellChoices(actor: {items?: Iterable<ChoosingFeature>} | null | undefined): SpellChoice[] {
  return [...(actor?.items ?? [])].filter(item => item?.system?.active !== false).map(readSpellChoice)
    .filter((choice): choice is SpellChoice => (choice !== null) && (typeof choice !== "string"));
}

type SpellDefinition = {configuration?: Array<{id?: string; levelByResourceId?: Record<string, unknown>}>; costs?: {allOf?: Array<{capability?: string}>}};
interface MarkableSpell {id?: string; flags?: {wildpath?: Record<string, unknown>}; system?: {definition?: SpellDefinition}}

/** A spell's mark for a choice: `true` (count 1) or its number, 1 to count; null when unmarked. */
export function spellChoiceMark(choice: SpellChoice, spell: MarkableSpell | null | undefined): true | number | null {
  const value = spell?.flags?.wildpath?.[choice.flag];
  if ( choice.count === 1 ) return (value === true) ? true : null;
  return ((typeof value === "number") && Number.isInteger(value) && (value >= 1) && (value <= choice.count)) ? value : null;
}

/** Whether a choice may mark a spell of this definition: its level is one of the choice's, and it has every one of its costs. */
export function fitsSpellChoice(choice: SpellChoice, definition: SpellDefinition | null | undefined) {
  const level = spellBaseLevel(definition);
  return (level !== null) && choice.levels.includes(level)
    && choice.costs.every(capability => (definition?.costs?.allOf ?? []).some(cost => cost?.capability === capability));
}

/** The pool a marked spell spends (`resourceId` with `{n}` and `{level}` filled in), or null when it is cast free. */
export function spellChoicePool(choice: SpellChoice, mark: true | number, level: number) {
  return choice.resourceId ? choice.resourceId.replaceAll("{n}", String((mark === true) ? 1 : mark)).replaceAll("{level}", String(level)) : null;
}

/**
 * The Item updates marking or unmarking a spell for a choice, among its creature's `spells`: unmarking clears it; with
 * count 1, marking it clears the other spell of its level; with a higher count it takes the lowest free number, or
 * `{full: true}` when every number is taken.
 */
export function spellChoiceToggle(choice: SpellChoice, spell: MarkableSpell, spells: readonly MarkableSpell[]):
  {updates: Array<Record<string, unknown>>} | {full: true} {
  const key = `flags.wildpath.${choice.flag}`;
  if ( spellChoiceMark(choice, spell) !== null ) return {updates: [{_id: spell.id, [key]: null}]};
  const others = spells.filter(entry => (entry !== spell) && (spellChoiceMark(choice, entry) !== null));
  if ( choice.count === 1 ) {
    const level = spellBaseLevel(spell.system?.definition);
    return {updates: [{_id: spell.id, [key]: true}, ...others.filter(entry => spellBaseLevel(entry.system?.definition) === level)
      .map(entry => ({_id: entry.id, [key]: null}))]};
  }
  const taken = new Set(others.map(entry => spellChoiceMark(choice, entry)));
  const free = Array.from({length: choice.count}, (_, index) => index + 1).find(number => !taken.has(number));
  return free ? {updates: [{_id: spell.id, [key]: free}]} : {full: true};
}

interface PreparingItem {
  type?: string; flags?: {wildpath?: Record<string, unknown>};
  system?: {prepared?: boolean; definition?: {tags?: string[]; configuration?: Array<{id?: string}>}};
  actor?: {items?: Iterable<ChoosingFeature>} | null;
}

/**
 * Whether a creature prepares this Action (2024): a spell of 1st level or higher (one that spends a spell slot). A
 * spell a feature or item gave it (a subclass's, a wand's) is always prepared, and so is one a feature of its creature
 * has marked (`spellChoice`: a Mystic Arcanum spell is cast from its arcanum or a slot; Spell Mastery's and Signature
 * Spells' are always prepared).
 */
export function preparesSpell(item: PreparingItem | null | undefined) {
  const definition = item?.system?.definition;
  return (item?.type === "action") && !item.flags?.wildpath?.grantedBy
    && !!definition?.tags?.includes("spell") && !!definition.configuration?.some(choice => choice?.id === "spell-slot")
    && !spellChoices(item.actor).some(choice => spellChoiceMark(choice, item) !== null);
}

/** A spell its creature has not prepared, so it can't cast it. */
export const isUnprepared = (item: PreparingItem | null | undefined) => preparesSpell(item) && (item?.system?.prepared === false);

/**
 * How many spells a creature's classes let it prepare: each class's table at its level (or its casting subclass's, among
 * `items`), summed; null with none.
 */
export function preparedSpellLimit(classes: readonly CastingItem[], items: readonly CastingItem[] = []) {
  const limits = classes.map(entry => effectiveSpellcasting(entry, items).prepared?.[(Number(entry.system?.levels) || 1) - 1])
    .filter((value): value is number => Number.isFinite(value));
  return limits.length ? limits.reduce((sum, value) => sum + value, 0) : null;
}
