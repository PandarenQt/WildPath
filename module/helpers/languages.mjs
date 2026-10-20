/**
 * Language text (2024 languages; the maintainer's design, 2026-10-20): a passage tagged with a language reads as plain
 * text to a reader who understands it, and otherwise as the same text in that language's script: each Latin letter
 * becomes a letter of a real historic script (fonts/: the Noto fonts, SIL Open Font License), or the GM's own font for
 * that language. Spoken text (chat, a speech bubble) is understood through Telepathy, Tongues and bonds too; written
 * text (a journal) only by knowing the language or reading every language (Comprehend Languages).
 */
import { LANGUAGES } from "./level-up.mjs";
export const SCRIPTS = Object.freeze({
    // Elder Futhark.
    runic: { family: "WildPath Runic", letters: [0x16A8, 0x16D2, 0x16B2, 0x16DE, 0x16D6, 0x16A0, 0x16B7, 0x16BA, 0x16C1, 0x16C3, 0x16B4,
            0x16DA, 0x16D7, 0x16BE, 0x16DF, 0x16C8, 0x16B3, 0x16B1, 0x16CA, 0x16CF, 0x16A2, 0x16A1, 0x16B9, 0x16EA, 0x16E6, 0x16C9] },
    ogham: { family: "WildPath Ogham", letters: [0x1690, 0x1681, 0x1689, 0x1687, 0x1693, 0x1683, 0x168C, 0x1686, 0x1694, 0x168D, 0x1695,
            0x1682, 0x168B, 0x1685, 0x1691, 0x169A, 0x168A, 0x168F, 0x1684, 0x1688, 0x1692, 0x1696, 0x1697, 0x1698, 0x1699, 0x168E] },
    // Old Persian cuneiform: its first 26 signs in order.
    oldPersian: { family: "WildPath Old Persian", letters: Array.from({ length: 26 }, (_, index) => 0x103A0 + index) },
    oldHungarian: { family: "WildPath Old Hungarian", letters: [0x10CC0, 0x10CC2, 0x10CC4, 0x10CC7, 0x10CC9, 0x10CCC, 0x10CCD, 0x10CCF,
            0x10CD0, 0x10CD2, 0x10CD3, 0x10CD6, 0x10CD8, 0x10CD9, 0x10CDB, 0x10CE0, 0x10CD4, 0x10CE2, 0x10CE4, 0x10CE6, 0x10CEA, 0x10CEE,
            0x10CEC, 0x10CE9, 0x10CD1, 0x10CEF] },
    glagolitic: { family: "WildPath Glagolitic", letters: [0x2C30, 0x2C31, 0x2C4C, 0x2C34, 0x2C35, 0x2C47, 0x2C33, 0x2C48, 0x2C3A, 0x2C3B,
            0x2C3D, 0x2C3E, 0x2C3F, 0x2C40, 0x2C41, 0x2C42, 0x2C4B, 0x2C43, 0x2C44, 0x2C45, 0x2C46, 0x2C32, 0x2C49, 0x2C4D, 0x2C39, 0x2C38] },
    tifinagh: { family: "WildPath Tifinagh", letters: [0x2D30, 0x2D31, 0x2D5B, 0x2D37, 0x2D3B, 0x2D3C, 0x2D33, 0x2D40, 0x2D49, 0x2D4A,
            0x2D3D, 0x2D4D, 0x2D4E, 0x2D4F, 0x2D44, 0x2D52, 0x2D47, 0x2D54, 0x2D59, 0x2D5C, 0x2D53, 0x2D60, 0x2D61, 0x2D45, 0x2D62, 0x2D63] },
    oldItalic: { family: "WildPath Old Italic", letters: [0x10300, 0x10301, 0x10302, 0x10303, 0x10304, 0x1031A, 0x10319, 0x10307, 0x10309,
            0x1031D, 0x1030A, 0x1030B, 0x1030C, 0x1030D, 0x1030F, 0x10310, 0x10312, 0x10313, 0x10314, 0x10315, 0x10316, 0x10305, 0x1031E,
            0x10317, 0x10318, 0x10306] }
});
/** Each language's script: kin languages share one (the giant-kin runes, the elemental tongues' cuneiform). */
export const LANGUAGE_SCRIPT = Object.freeze({
    common: "glagolitic", sign: "glagolitic", halfling: "glagolitic", cant: "glagolitic",
    dwarvish: "runic", giant: "runic", gnomish: "runic", goblin: "runic", orc: "runic", aarakocra: "runic", gnoll: "runic",
    elvish: "tifinagh", sylvan: "tifinagh", undercommon: "tifinagh",
    druidic: "ogham", deep: "ogham",
    draconic: "oldPersian", primordial: "oldPersian", aquan: "oldPersian", auran: "oldPersian", ignan: "oldPersian", terran: "oldPersian",
    infernal: "oldHungarian", abyssal: "oldHungarian", gith: "oldHungarian",
    celestial: "oldItalic"
});
/** Every language a passage can be tagged with. */
export const TAGGABLE_LANGUAGES = Object.freeze(Object.keys(LANGUAGE_SCRIPT));
/** `text` in `script`: each letter (its accents dropped) becomes that script's letter; anything else stays. */
export function transliterate(text, script) {
    const letters = SCRIPTS[script]?.letters;
    if (!letters)
        return text;
    return [...String(text ?? "")].map(character => {
        const base = character.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
        const index = base.length === 1 ? base.charCodeAt(0) - 97 : -1;
        return (index >= 0) && (index < 26) ? String.fromCodePoint(letters[index]) : character;
    }).join("");
}
/** The languages a creature knows by key ("standard" and "rare" stand for all of them); a spoken-only grant only when spoken. */
function known(creature, spoken = true) {
    const keys = new Set();
    const groups = LANGUAGES;
    for (const name of creature?.languages ?? []) {
        const key = String(name).toLowerCase();
        if (key === "standard")
            groups.standard?.forEach(language => keys.add(language));
        else if (key === "rare")
            groups.rare?.forEach(language => keys.add(language));
        else
            keys.add(key);
    }
    for (const grant of creature?.grants ?? []) {
        if (!["any", "telepathy"].includes(grant.language) && !grant.bond && (spoken || !grant.spokenOnly))
            keys.add(String(grant.language).toLowerCase());
    }
    return keys;
}
/** Whether it knows at least one language (Telepathy and Tongues reach only such a creature). */
function speaksAny(creature) {
    return [...known(creature)].some(language => (language !== "telepathy") && (language !== "beasts"));
}
const has = (creature, test) => (creature?.grants ?? []).some(test);
const within = (grant, distance) => !(Number(grant.range) > 0) || ((distance !== null) && (distance <= Number(grant.range)));
/**
 * Whether `reader` understands a passage in `language` (2024). Written text: it knows the language, or reads every
 * language (Comprehend Languages). Spoken text, also: it understands every spoken language (Tongues, Comprehend
 * Languages); its speaker's Tongues makes it understood by any creature with a language; Telepathy carries it between
 * creatures within its range that know a language (the speaker's, or the reader's own); a Telepathic Bond carries it
 * between bonded creatures. `distance` in feet between them, null when unknown (Telepathy then needs no range).
 */
export function understands({ reader, language, spoken = false, speaker = null, distance = null }) {
    if (!reader)
        return false;
    if (known(reader, spoken).has(String(language).toLowerCase()))
        return true;
    if (has(reader, grant => (grant.language === "any") && (spoken || !grant.spokenOnly)))
        return true;
    if (!spoken || !speaker)
        return false;
    if (has(speaker, grant => (grant.language === "any") && !!grant.understood) && speaksAny(reader))
        return true;
    const telepathy = (creature, other) => has(creature, grant => (grant.language === "telepathy")
        && !grant.bond && within(grant, distance)) && speaksAny(other);
    if (telepathy(speaker, reader) || telepathy(reader, speaker))
        return true;
    return has(speaker, grant => !!grant.bond) && has(reader, grant => !!grant.bond);
}
/** The GM's fonts by language ("dwarvish=Dethek; elvish=Tengwar Annatar"): `{dwarvish: "Dethek", ...}`. */
export function parseLanguageFonts(text) {
    return Object.fromEntries(String(text ?? "").split(/[;\n]/).map(entry => entry.split("=").map(part => part.trim()))
        .filter(([key, family]) => key && family).map(([key, family]) => [key.toLowerCase(), family]));
}
/** A creature as a language speaker: its training's languages and its grants. */
export function speakerOf(actor) {
    if (!actor)
        return null;
    const system = actor.system;
    const grants = actor.getGrantedLanguages?.() ?? [];
    return { languages: [...(system?.training?.languages ?? [])], grants };
}
