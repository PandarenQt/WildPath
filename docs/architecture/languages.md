# Language text

A passage in a language reads as plain text to a reader who understands it. Anyone else sees the same text in that
language's script, each Latin letter becoming a letter of a real historic script. This was the maintainer's design,
2026-10-20: the same text, not scrambled; tagged text, with Common as the default; no language picker.

## Writing it

- **A tag.** `[elvish]Well met[/elvish]` marks a passage in chat, journals, Item descriptions and speech bubbles. The
  tags are the language keys (`LANGUAGE_SCRIPT`). The editor's Language menu (`getProseMirrorMenuDropDowns`) wraps the
  selection in one; in chat, type them.
- **Common by default.** In-character chat with no tag is Common, and so is a speech bubble with no tag. Emotes, OOC
  messages, rolls and cards are not.

## Who reads it

Each client renders a passage for its own reader (`applications/languages.mts`; the enricher's `onRender`, which
Foundry calls when the passage enters the page):
- **A GM** reads it plainly, marked with a dotted underline; the language shows in its tooltip.
- **Whoever wrote or says it** (the message's author, the owner of the speaking Token) reads it plainly.
- **Anyone else** reads it as their character and the creatures whose Tokens they control
  (`helpers/languages.mts` `understands`):
  - **Written text** (a journal): a creature knows the language (`training.languages`, its rules' `GrantLanguage`;
    `standard` and `rare` stand for all of them), or reads every language (`GrantLanguage any`: Comprehend Languages).
  - **Spoken text** (chat, a bubble) is also understood:
    - by a reader who understands every spoken language (`any`, `spokenOnly`: Tongues, Comprehend Languages);
    - from a speaker whose Tongues makes it understood by any creature with a language (`understood`);
    - through Telepathy, between creatures within its range that know a language (the speaker's or the reader's;
      measured between their Tokens with `grid.measurePath`);
    - through a Telepathic Bond, between bonded creatures.

## Scripts and fonts

| Script | Languages |
| --- | --- |
| Glagolitic | Common, Sign, Halfling, Thieves' Cant |
| Runic (Elder Futhark) | Dwarvish, Giant, Gnomish, Goblin, Orc, Aarakocra, Gnoll |
| Tifinagh | Elvish, Sylvan, Undercommon |
| Ogham | Druidic, Deep Speech |
| Old Persian cuneiform | Draconic, Primordial and its four dialects |
| Old Hungarian | Infernal, Abyssal, Gith |
| Old Italic | Celestial |

- **The fonts.** `fonts/` holds the Noto Sans fonts for these scripts: the @fontsource 5.2 builds, their script
  subsets, under the SIL Open Font License (`fonts/OFL.txt`). `styles/wildpath.css` declares them (`WildPath Runic`,
  …), and an element's `data-script` picks one.
- **A GM's own font.** The world setting "Fonts for languages" (`languageFonts`: `dwarvish=Dethek; elvish=Tengwar
  Annatar`) shows a language in a font the GM added under Foundry's Additional Fonts. The text stays Latin, in that
  font. Those fonts stay in the world; they are not part of the system.

## Live (two browsers, 14.369)

- **Chat.** The Bandit Captain said `[goblin]Run, you fools[/goblin]`, `[elvish]Well met[/elvish]` and "Hand over the
  gold." Player1 (QA Caster: Common, Elvish) read the Goblin in runes and the rest plainly; the GM read all three,
  underlined. Without Common, the untagged message showed in Glagolitic.
- **Understanding.** With Comprehend Languages (`GrantLanguage any`) the Goblin read plainly. With the Captain's
  Telepathy 30 ft, it read plainly beside it and in runes 35 ft away.
- **Journal.** A page's `[dwarvish]` text read in runes. With `dwarvish=Signika` set, it read in Latin, in Signika.
- **Bubbles.** A speech bubble's Orc words showed in runes, and the rest of it plainly.

Messages already on screen change only when they are rendered again (a reload, a new message).
