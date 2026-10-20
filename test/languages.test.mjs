import {test} from "node:test";
import assert from "node:assert/strict";
import {LANGUAGE_SCRIPT, SCRIPTS, TAGGABLE_LANGUAGES, parseLanguageFonts, transliterate, understands} from "../module/helpers/languages.mjs";
import {LANGUAGES} from "../module/helpers/level-up.mjs";

test("every standard and rare language has a script, and each script has 26 distinct letters", () => {
  assert.deepEqual([...LANGUAGES.standard, ...LANGUAGES.rare].filter(language => !LANGUAGE_SCRIPT[language]), []);
  for ( const [name, script] of Object.entries(SCRIPTS) ) {
    assert.equal(new Set(script.letters).size, 26, name);
  }
  assert.ok(TAGGABLE_LANGUAGES.includes("elvish") && !TAGGABLE_LANGUAGES.includes("telepathy"));
});

test("text in a script: each letter, accents dropped, becomes the script's; the rest stays", () => {
  const dwarvish = transliterate("Hëllo, friend!", "runic");
  assert.equal([...dwarvish].length, "Hello, friend!".length, "one glyph a letter");
  assert.ok(dwarvish.endsWith(`${String.fromCodePoint(SCRIPTS.runic.letters[3])}!`), "punctuation stays");
  assert.equal(transliterate("ab", "runic"), String.fromCodePoint(0x16A8, 0x16D2));
  assert.equal(transliterate("ab", "unknown"), "ab");
  assert.equal(transliterate("Hello", "runic"), transliterate("hello", "runic"), "case doesn't matter");
});

test("who understands a passage: its language, any language, Tongues, Telepathy in range, a bond", () => {
  const creature = (languages=[], grants=[]) => ({languages, grants});
  const elf = creature(["common", "elvish"]);
  const dwarf = creature(["common", "dwarvish"]);
  assert.equal(understands({reader: elf, language: "elvish"}), true);
  assert.equal(understands({reader: dwarf, language: "elvish"}), false);
  assert.equal(understands({reader: creature(["standard"]), language: "elvish"}), true, "every standard language");
  // Comprehend Languages reads any language; Tongues (spoken only) hears any.
  assert.equal(understands({reader: creature(["common"], [{language: "any"}]), language: "infernal"}), true);
  assert.equal(understands({reader: creature(["common"], [{language: "any", spokenOnly: true}]), language: "infernal"}), false, "written");
  assert.equal(understands({reader: creature(["common"], [{language: "any", spokenOnly: true}]), language: "infernal", spoken: true}), true);
  // Its speaker's Tongues: understood by any creature with a language.
  const tongues = creature(["abyssal"], [{language: "any", spokenOnly: true, understood: true}]);
  assert.equal(understands({reader: dwarf, language: "abyssal", spoken: true, speaker: tongues}), true);
  assert.equal(understands({reader: creature([]), language: "abyssal", spoken: true, speaker: tongues}), false, "no language at all");
  // Telepathy: within its range only.
  const aboleth = creature(["deep"], [{language: "telepathy", range: 120}]);
  assert.equal(understands({reader: dwarf, language: "deep", spoken: true, speaker: aboleth, distance: 100}), true);
  assert.equal(understands({reader: dwarf, language: "deep", spoken: true, speaker: aboleth, distance: 150}), false);
  assert.equal(understands({reader: dwarf, language: "deep", speaker: aboleth, distance: 10}), false, "written text is not telepathic");
  // A Telepathic Bond: bonded creatures understand each other at any distance.
  const bonded = grants => creature(["common"], grants);
  assert.equal(understands({reader: bonded([{language: "telepathy", bond: true}]), language: "giant", spoken: true,
    speaker: creature(["giant"], [{language: "telepathy", bond: true}])}), true);
  assert.equal(understands({reader: null, language: "common"}), false);
});

test("the GM's fonts by language", () => {
  assert.deepEqual(parseLanguageFonts("dwarvish=Dethek; Elvish = Tengwar Annatar\nbroken"), {dwarvish: "Dethek", elvish: "Tengwar Annatar"});
  assert.deepEqual(parseLanguageFonts(null), {});
});
