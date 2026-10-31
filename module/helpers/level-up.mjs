/**
 * Level-up and character creation (G8, the maintainer's approved design): what one level of a class (and its
 * subclass), or a species or background at creation, gives, as the steps the level-up dialog shows; and what each
 * choice changes on the creature. Pure data: the dialog (applications/level-up.mts) asks and applies.
 */
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
});
/**
 * The steps of reaching `level` (0: a species or background at creation): its entries, without those for the other
 * kind of class (an original class's `primary` entries, a multiclass's `secondary` ones).
 */
export function levelSteps(advancement, level, { original = true } = {}) {
    return advancement.filter(entry => (Number(entry.level) || 0) === level)
        .filter(entry => !entry.classRestriction || (entry.classRestriction === (original ? "primary" : "secondary")))
        .map(entry => ({ kind: entry.type, title: entry.title ?? null, entry }));
}
/** Items whose levels are their creature's character level, not a class's own. */
export const ORIGIN_TYPES = new Set(["species", "background"]);
/**
 * The steps applying `level` of `item` brings. A class level brings its own and its subclasses' steps at that level, and
 * its creature's species' and background's at the character level it reaches (a Tiefling's cantrip at 1st, its spells at
 * 3rd and 5th; a Dragonborn's flight at 5th). A species or background added to a creature that already has levels
 * (`otherLevels`) brings every level of it up to theirs. Each step names the Item it comes from (`source`) when that is
 * not `item`.
 */
export function stepsForLevel(item, level, { original = true, otherLevels = 0, subclasses = [], origins = [] } = {}) {
    const own = (source, at, options = {}) => levelSteps(source.system.advancement ?? [], at, options);
    if (ORIGIN_TYPES.has(item.type))
        return Array.from({ length: otherLevels + 1 }, (_, at) => own(item, at)).flat();
    if (item.type !== "class")
        return own(item, level, { original });
    return [...own(item, level, { original }),
        ...subclasses.flatMap(subclass => own(subclass, level).map(step => ({ ...step, source: subclass }))),
        ...origins.flatMap(origin => own(origin, otherLevels + level).map(step => ({ ...step, source: origin })))];
}
/** Where content comes from, each a world setting (`source<Gate>`) that offers it in the level-up dialog or not. */
export const SOURCE_GATES = Object.freeze(["core2014", "core2024", "supplement", "ua", "thirdParty"]);
const CORE_PACKAGES = new Set(["wildpath", "wildpath-dnd-players-handbook", "wildpath-dnd-dungeon-masters-guide", "wildpath-dnd-monster-manual"]);
/**
 * Which gate a compendium entry's source (`flags.wildpath.source`) falls under, from the package holding it: the SRD and
 * the core books by their rules (2014, 2024); another local book module (`wildpath-…`) a supplement; Unearthed Arcana
 * by its book's name; a third-party book (Humblewood: `source.thirdParty`), and anything WildPath did not convert, third-party.
 */
export function sourceGate(source, packageName) {
    if (!source?.system || source.thirdParty)
        return "thirdParty";
    if (/Unearthed Arcana|\bUA\b/i.test(String(source.book ?? "")))
        return "ua";
    if (CORE_PACKAGES.has(String(packageName ?? "")))
        return (source.rules === "2014") ? "core2014" : "core2024";
    return String(packageName ?? "").startsWith("wildpath-") ? "supplement" : "thirdParty";
}
/**
 * A choice's pool against what its creature already has (Items by their compendium source): the options it may still
 * pick, and the ones it has that it may replace (an active Item from the pool: a Fighting Style, an Invocation, a
 * Maneuver, an infusion it knows).
 */
export function choiceOptions(pool, items) {
    const owned = [...items].filter(item => (item.system?.active !== false) && pool.includes(String(item._stats?.compendiumSource ?? "")))
        .map(item => ({ id: item.id, name: item.name, source: String(item._stats.compendiumSource) }));
    const have = new Set(owned.map(item => item.source));
    return { options: pool.filter(uuid => !have.has(uuid)), owned: owned.map(({ id, name }) => ({ id, name })) };
}
/**
 * A spell choice's options (`pool.spellLists`, `pool.spellLevel`: Magic Initiate), one per spell: its Items taken together
 * (Produce Flame's Cast and Hurl Fire) from the first package that has it, their uuids the option's value, comma-joined;
 * by name. Not one whose Items its creature already has (`owned`: compendium sources).
 */
export function spellChoiceOptions(entries, pool, owned) {
    const { spellLists = [], spellLevel = 0 } = pool ?? {};
    const spells = new Map();
    for (const entry of entries) {
        const metadata = entry.system?.definition?.metadata;
        const id = entry.flags?.wildpath?.source?.id;
        if (!id || (Number(metadata?.spellLevel) !== spellLevel) || !metadata?.spellLists?.some(list => spellLists.includes(list)))
            continue;
        // One package's copy: the first's (the SRD's Fire Bolt, not the PHB's as well).
        const known = spells.get(id);
        if (known && (known[0].uuid.split(".Item.")[0] !== entry.uuid.split(".Item.")[0]))
            continue;
        spells.set(id, [...(known ?? []), entry]);
    }
    return [...spells.values()].filter(items => !items.some(item => owned.has(item.uuid)))
        .map(items => ({ value: items.map(item => item.uuid).join(","), label: items[0].name.replace(/ \([^)]*\)$/u, "") }))
        .sort((a, b) => a.label.localeCompare(b.label));
}
/**
 * A choice's options as one per source document (a Rune Knight's Cloud Rune: its Invoke and Inscribe Items together), in
 * pool order: each group's uuids comma-joined. `sourceOf` names an option's source (its package and source id).
 */
export function groupedOptions(uuids, sourceOf) {
    const groups = new Map();
    for (const uuid of uuids) {
        const key = sourceOf(uuid) ?? uuid;
        groups.set(key, [...(groups.get(key) ?? []), uuid]);
    }
    return [...groups.values()].map(group => group.join(","));
}
/**
 * The prerequisites a creature doesn't meet, by key (none: it may take it). `level` is its character level for a feat,
 * the class's for a class option (an Invocation: `level` in `facts`). Something it already has is left out unless
 * repeatable (`identifier`). Text it can't check (`text`) is not unmet.
 */
export function unmetPrerequisites(prerequisites, facts, { identifier = null } = {}) {
    const unmet = [];
    const p = prerequisites ?? {};
    if (p.level && (facts.level < p.level))
        unmet.push("level");
    if (p.items?.some(key => !facts.identifiers.has(key)))
        unmet.push("items");
    if (p.abilities?.length && !p.abilities.some(({ ability, min }) => (facts.abilities[ability] ?? 0) >= min))
        unmet.push("abilities");
    if (p.training?.armor && !(facts.training.armor ?? []).includes(p.training.armor))
        unmet.push("training");
    if (p.training?.weapons && !(facts.training.weapons ?? []).some(key => key === p.training.weapons || key.startsWith(`${p.training.weapons}`)))
        unmet.push("training");
    if (p.spellcasting && !facts.spellcasting)
        unmet.push("spellcasting");
    if (p.classLevel && ((facts.classLevels[p.classLevel.class] ?? 0) < p.classLevel.min))
        unmet.push("classLevel");
    if (identifier && !p.repeatable && facts.identifiers.has(identifier))
        unmet.push("repeatable");
    return unmet;
}
/** 2024 hit points for a class level: the Hit Die's maximum at a character's first level, else its average rounded up, plus the Fortitude modifier; at least 1. */
export function hitPointsForLevel({ hitDie, first, fortitude }) {
    return Math.max(1, (first ? hitDie : Math.floor(hitDie / 2) + 1) + fortitude);
}
/**
 * The keys a choice offers: `skills:*` (or `expertise:*`) is every skill, `masteries:martial:*` every martial weapon,
 * `masteries:*` every weapon, the rest as they are.
 */
export function poolOptions(pool, { skills }) {
    return [...new Set(pool.flatMap(key => {
            if (key === "skills:*")
                return skills.map(skill => `skills:${skill}`);
            if (key === "expertise:*")
                return skills.map(skill => `expertise:${skill}`);
            // Languages: every one, the standard ones, or the rare ones.
            const pick = { "languages:*": [...LANGUAGES.standard, ...LANGUAGES.rare], "languages:standard:*": LANGUAGES.standard,
                "languages:rare:*": LANGUAGES.rare }[key];
            if (pick)
                return pick.map(language => `languages:${language}`);
            if (key === "masteries:*")
                return [...(WEAPONS.simple ?? []), ...(WEAPONS.martial ?? [])].map(weapon => `masteries:${weapon}`);
            const match = /^(masteries|weapons):(simple|martial):\*$/.exec(key);
            if (match)
                return (WEAPONS[match[2]] ?? []).map(weapon => `${match[1]}:${weapon}`);
            return [key];
        }))];
}
/**
 * What trait keys change on a creature (`system` its data): a skill proficient (expertise kept), a save proficient,
 * a training list with the name added. Returns update paths.
 */
export function traitUpdates(keys, system) {
    const updates = {};
    const training = (system.training ?? {});
    const lists = {};
    for (const key of keys) {
        const [kind, ...rest] = key.split(":");
        const value = rest.join(":");
        if (!kind || !value || value.endsWith("*"))
            continue;
        if ((kind === "skills") || (kind === "expertise")) {
            const current = Number(system.skills?.[value]?.proficiency) || 0;
            updates[`system.skills.${value}.proficiency`] = Math.max(current, (kind === "expertise") ? 2 : 1);
        }
        else if (kind === "saves")
            updates[`system.abilities.${value}.saveProficient`] = true;
        else if (["armor", "weapons", "tools", "masteries", "languages"].includes(kind))
            (lists[kind] ??= new Set(training[kind] ?? [])).add(value);
    }
    for (const [kind, names] of Object.entries(lists))
        updates[`system.training.${kind}`] = [...names];
    return updates;
}
/**
 * Trait keys merged into a creature's prepared data in place (G8): what its Items give it (`flags.wildpath.training`)
 * over its own. A skill proficient (`expertise:` its Expertise), a save proficient, a training list with the name
 * added. Nothing is written: losing the Item loses what it gave.
 */
export function mergeTraining(system, keys) {
    const skills = (system.skills ?? {});
    const abilities = (system.abilities ?? {});
    const training = (system.training ??= {});
    for (const key of keys) {
        const [kind, ...rest] = String(key).split(":");
        const value = rest.join(":");
        if (!kind || !value || value.endsWith("*"))
            continue;
        const skill = skills[value];
        if (((kind === "skills") || (kind === "expertise")) && skill) {
            skill.proficiency = Math.max(Number(skill.proficiency) || 0, (kind === "expertise") ? 2 : 1);
        }
        else if ((kind === "saves") && abilities[value])
            abilities[value].saveProficient = true;
        else if (["armor", "weapons", "tools", "masteries", "languages"].includes(kind))
            training[kind] = [...new Set([...(training[kind] ?? []), value])];
    }
}
/** A recorded trait's damage and condition keys (dnd5e's `dr:`, `di:`, `dv:`, `ci:`) as the rule elements they mean. */
const TRAIT_RULES = Object.freeze({ dr: "GrantResistance", di: "GrantImmunity", dv: "GrantVulnerability",
    ci: "ConditionImmunity" });
/**
 * The rules an Item's recorded training gives (`flags.wildpath.training`): a Dwarf's Resistance to Poison, a Dragonborn's
 * chosen Resistance, Draconic Sorcery's. Its skills and proficiencies are `mergeTraining`'s; these are its creature's
 * damage and condition grants, which it holds like any other rule.
 */
export function trainingRuleElements(keys = []) {
    return keys.flatMap((key) => {
        const [kind, value] = String(key).split(":");
        // Elemental Adept's Energy Mastery (`adept:<type>`): its spells' dice of that type count a 1 as a 2 (its Resistance
        // ignored is combat-statistics' ignoredResistances).
        if ((kind === "adept") && value && !value.endsWith("*"))
            return [{ schemaVersion: 1, id: `training-adept-${value}`,
                    type: "DamageDieMinimum", data: { domains: ["damage.spell"], minimum: 2, damageTypes: [value] } }];
        const type = TRAIT_RULES[kind ?? ""];
        if (!type || !value || value.endsWith("*"))
            return [];
        return [{ schemaVersion: 1, id: `training-${kind}-${value}`, type,
                data: type === "ConditionImmunity" ? { conditions: [value] } : { damageTypes: [value] } }];
    });
}
/** An ability increase (2024): each chosen ability raised by its points, never above `cap` points each or 20. */
export function improvementUpdates(increases, system, { cap = 2, points = 2 } = {}) {
    const updates = {};
    let spent = 0;
    for (const [ability, amount] of Object.entries(increases)) {
        const add = Math.min(Math.max(Math.floor(Number(amount) || 0), 0), cap, points - spent);
        if (!add)
            continue;
        spent += add;
        const score = Number(system.abilities?.[ability]?.value) || 10;
        updates[`system.abilities.${ability}.value`] = Math.min(score + add, 20);
    }
    return updates;
}
/** Multiclassing (2024): the classes whose primary abilities are below 13 (all of them, or one when `all` is false). */
export function multiclassShortfalls(classes, scores) {
    return classes.filter(({ primaryAbility }) => {
        const abilities = primaryAbility?.abilities ?? [];
        const met = (ability) => (scores[ability] ?? 10) >= 13;
        return abilities.length > 0 && !(primaryAbility?.all === false ? abilities.some(met) : abilities.every(met));
    }).map(entry => entry.name);
}
/** 2024 ability score generation: the standard array, and point buy's costs (27 points, scores 8 to 15). */
export const STANDARD_ARRAY = Object.freeze([15, 14, 13, 12, 10, 8]);
export const POINT_BUY = Object.freeze({ budget: 27, costs: Object.freeze({ 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 }) });
/** The points `scores` cost to buy, or null when one is outside 8 to 15. */
export function pointBuySpent(scores) {
    let spent = 0;
    for (const score of scores) {
        const cost = POINT_BUY.costs[score];
        if (cost === undefined)
            return null;
        spent += cost;
    }
    return spent;
}
/** Whether `scores` use each value of `pool` exactly once (a standard array, or rolled scores). */
export function usesPool(scores, pool) {
    const sorted = (list) => [...list].sort((a, b) => a - b).join(",");
    return (scores.length === pool.length) && (sorted(scores) === sorted(pool));
}
