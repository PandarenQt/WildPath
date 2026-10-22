/**
 * Class and spellcasting progression for the 2024 rules, as pure data functions. The Actor model derives
 * its total level, original class and spell slots from these; another ruleset replaces this module rather
 * than branching inside callers (AGENTS §10).
 */
// A third caster (Eldritch Knight, Arcane Trickster) casts through its subclass: `effectiveSpellcasting`.
export const SPELLCASTING_PROGRESSIONS = Object.freeze({ NONE: "none", FULL: "full", HALF: "half", THIRD: "third", PACT: "pact" });
/** The pool that holds slots of one spell level; slot payments name it as their capability. */
export const spellSlotPoolId = (spellLevel) => `spell-slot.${spellLevel}`;
/** The pool of Pact Magic slots: it pays for any slot up to its level (action-economy), recovered on a Short Rest. */
export const PACT_SLOT_POOL = "spell-slot.pact";
/** The pool that holds a creature's Hit Dice of one size (`hit-die.d10`). */
export const hitDiePoolId = (faces) => `hit-die.d${faces}`;
/** What spent Hit Dice heal: each die's roll plus the Fortitude modifier, at least `minimum` (2024: 1; 2014: 0). */
export const hitDiceHealing = (results, modifier, { minimum = 1 } = {}) => results.reduce((sum, result) => sum + Math.max(minimum, result + modifier), 0);
/**
 * 2014: a Long Rest gives back spent Hit Dice up to half of all of them (at least one), the largest dice first (a
 * multiclass character's d10s before its d6s: what heals most later). `pools` are `{id: "hit-die.d10", value, max}`;
 * returns each one's new value by id.
 */
export function longRestHitDice(pools) {
    const dice = pools.filter(pool => String(pool.id).startsWith("hit-die."));
    let budget = Math.max(1, Math.floor(dice.reduce((total, pool) => total + (Number(pool.max) || 0), 0) / 2));
    const size = (id) => Number(/(\d+)$/.exec(id)?.[1]) || 0;
    const values = {};
    for (const pool of [...dice].sort((a, b) => size(b.id) - size(a.id))) {
        const regained = Math.min(budget, Math.max((Number(pool.max) || 0) - (Number(pool.value) || 0), 0));
        values[pool.id] = (Number(pool.value) || 0) + regained;
        budget -= regained;
    }
    return values;
}
// Slots per spell level (1st-9th) at each caster level 1-20: the 2024 multiclass spellcaster table.
const SLOTS_BY_CASTER_LEVEL = [
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
export function casterLevel(classes) {
    const casting = classes.filter(entry => ![undefined, SPELLCASTING_PROGRESSIONS.NONE, SPELLCASTING_PROGRESSIONS.PACT]
        .includes(entry.spellcasting?.progression));
    return classes.reduce((total, entry) => {
        const level = Math.max(Number(entry.level) || 0, 0);
        const progression = entry.spellcasting?.progression;
        if (progression === SPELLCASTING_PROGRESSIONS.FULL)
            return total + level;
        if (progression === SPELLCASTING_PROGRESSIONS.HALF)
            return total + Math.ceil(level / 2);
        if (progression === SPELLCASTING_PROGRESSIONS.THIRD) {
            return total + ((casting.length === 1) ? ((level >= 3) ? Math.ceil(level / 3) : 0) : Math.floor(level / 3));
        }
        return total;
    }, 0);
}
/**
 * A class Item's spellcasting, or its subclass's when the class has none of its own (2024 Eldritch Knight and Arcane
 * Trickster: the Fighter and Rogue cast through them). `items` are its creature's Items.
 */
export function effectiveSpellcasting(classItem, items = []) {
    const own = classItem.system?.spellcasting;
    if (own?.progression && (own.progression !== SPELLCASTING_PROGRESSIONS.NONE))
        return own;
    const subclass = items.find(entry => (entry.type === "subclass") && (entry.system?.classIdentifier === classItem.system?.identifier)
        && !!entry.system?.spellcasting?.progression && (entry.system.spellcasting.progression !== SPELLCASTING_PROGRESSIONS.NONE));
    return subclass?.system?.spellcasting ?? own ?? { progression: SPELLCASTING_PROGRESSIONS.NONE, ability: "" };
}
/** Slots for spell levels 1-9 at a caster level (nine entries, zero where none). */
export function spellSlots(level) {
    const row = SLOTS_BY_CASTER_LEVEL[Math.min(Math.max(Math.floor(level) || 0, 0), 20)] ?? [];
    return Array.from({ length: 9 }, (_, index) => row[index] ?? 0);
}
/**
 * 2024 Pact Magic from the levels of pact classes (the Warlock): 1 slot, 2 from level 2, 3 from 11, 4 from 17, all of
 * one level, half the class level rounded up and at most 5. Separate from the multiclass slots (casterLevel).
 */
export function pactMagic(classes) {
    const level = classes.filter(entry => entry.spellcasting?.progression === SPELLCASTING_PROGRESSIONS.PACT)
        .reduce((total, entry) => total + Math.max(Number(entry.level) || 0, 0), 0);
    if (!level)
        return { slots: 0, level: 0 };
    return { slots: (level >= 17) ? 4 : (level >= 11) ? 3 : (level >= 2) ? 2 : 1, level: Math.min(Math.ceil(level / 2), 5) };
}
/**
 * What an Actor's class records mean: the total level, the original (level-1) class, and spellcasting.
 * The original class is the one marked `original`, else the first. The Actor's spellcasting ability is
 * the original class's when it casts, else the first casting class's; each class keeps its own.
 */
export function deriveClassData(classes) {
    const level = classes.reduce((total, entry) => total + Math.max(Number(entry.level) || 0, 0), 0);
    const original = classes.find(entry => entry.original) ?? classes[0] ?? null;
    const casts = (entry) => !!entry?.spellcasting?.progression
        && (entry.spellcasting.progression !== SPELLCASTING_PROGRESSIONS.NONE);
    const caster = casts(original) ? original : classes.find(casts) ?? null;
    const levelForSlots = casterLevel(classes);
    // One Hit Die per class level, of that class's size; a multiclass creature holds several sizes.
    const hitDice = {};
    for (const entry of classes) {
        if (!Number(entry.hitDie))
            continue;
        const id = hitDiePoolId(Number(entry.hitDie));
        hitDice[id] = (hitDice[id] ?? 0) + Math.max(Number(entry.level) || 0, 0);
    }
    return {
        level,
        original,
        spellcasting: { casterLevel: levelForSlots, ability: caster?.spellcasting?.ability || null, slots: spellSlots(levelForSlots),
            pact: pactMagic(classes) },
        hitDice
    };
}
/**
 * A spell's own level: the lowest its slot choice names (`levelByResourceId`, which Foundry may store nested as
 * `{"spell-slot": {"6": 6}}`), or null for an Action with no slot choice (a cantrip).
 */
export function spellBaseLevel(definition) {
    const choice = definition?.configuration?.find(entry => entry?.id === "spell-slot");
    const levels = Object.values(choice?.levelByResourceId ?? {})
        .flatMap(value => ((value && (typeof value === "object")) ? Object.values(value) : [value]))
        .map(Number).filter(Number.isFinite);
    return levels.length ? Math.min(...levels) : null;
}
/** The pool of Mystic Arcanum uses of one spell level (`mystic-arcanum.6`). */
export const mysticArcanumPoolId = (level) => `mystic-arcanum.${level}`;
/**
 * Whether a creature prepares this Action (2024): a spell of 1st level or higher (one that spends a spell slot). A
 * spell a feature or item gave it (a subclass's, a wand's) is always prepared.
 */
export function preparesSpell(item) {
    const definition = item?.system?.definition;
    // A Mystic Arcanum spell is cast from its arcanum (or a slot), never prepared.
    return (item?.type === "action") && !item.flags?.wildpath?.grantedBy && !item.flags?.wildpath?.arcanum
        && !!definition?.tags?.includes("spell") && !!definition.configuration?.some(choice => choice?.id === "spell-slot");
}
/** A spell its creature has not prepared, so it can't cast it. */
export const isUnprepared = (item) => preparesSpell(item) && (item?.system?.prepared === false);
/**
 * How many spells a creature's classes let it prepare: each class's table at its level (or its casting subclass's, among
 * `items`), summed; null with none.
 */
export function preparedSpellLimit(classes, items = []) {
    const limits = classes.map(entry => effectiveSpellcasting(entry, items).prepared?.[(Number(entry.system?.levels) || 1) - 1])
        .filter((value) => Number.isFinite(value));
    return limits.length ? limits.reduce((sum, value) => sum + value, 0) : null;
}
