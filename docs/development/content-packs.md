# Built-in Content Packs

WildPath ships its own compendium packs. The first is **WildPath Actions** (`wildpath.actions`, Items), in
Foundry's Compendium Packs sidebar tab.

## Workflow

- **Sources.** Each pack is a folder of JSON Document sources in `packs/_source/<pack>/`, one file per
  Document. Every source carries `_key: "!items!<_id>"` and a stable 16-character `_id`.
- **Build.** `npm run build:packs` compiles every source folder into the LevelDB pack Foundry reads at
  `packs/<pack>/`, using `@foundryvtt/foundryvtt-cli` 3.0.4, pinned exactly (approved by the maintainer on
  2026-10-14).
- **Versioning.** Only the sources are in git. Compiled packs are build output (`.gitignore`).
- **Manifest.** `system.json` declares each pack. Its label is a `lang/en.json` key, which Foundry
  localizes.
- **Close the world before rebuilding.** A running world holds a lock on every pack it loaded. A new pack
  appears only after the world is launched again.

## Checks

- **Node** (`test/content-packs.test.mjs`):
  - every source folder is declared in `system.json`;
  - every entry is a valid Action Item (the ActionDefinition validator, a unique `_id` and definition id,
    and the `_key` format);
  - the CLI compiles the sources and reads them back unchanged.
- **Quench** (`wildpath.documents`): the loaded pack's Actions import onto an Actor with valid definitions.
  The case skips until the world has been launched with the pack.

Live (14.369, after the maintainer relaunched the world):
- Both clients list the localized "WildPath Actions" with its nine entries.
- The Quench import case passed.
- Player1 imported Melee Strike from the pack and hit with it through `Item.use()`.

## SRD 5.2 packs (2026-10-14)

**SRD 5.2: Spells, Weapons and Features** (`srd-items`, Items) and **SRD 5.2: Creatures** (`srd-creatures`,
Actors) are converted from dnd5e 6.0.2's 2024 compendiums by `scripts/content/convert-dnd5e-srd.mjs`. The mapping
itself is `dnd5e-to-wildpath.mjs`.

- **Only SRD.** A document is converted only if its own `system.source` says `license: "CC-BY-4.0"` and `rules:
  "2024"`.
  - The "Free Rules" documents (Unlicensed) and those with no license are skipped.
  - Each converted document keeps its origin and license in `flags.wildpath.source`.
  - Premium books (PHB, DMG, MM) are never written to `packs/_source`.
- **Reading dnd5e's packs.** Copy them out of the dnd5e system folder, extract the copy with the Foundry CLI
  (`extractPack`), and point the script at the extracted folder. Opening a LevelDB pack writes to it.
- **The mapping.**
  - Abilities map one to one: str, dex, con, int, wis, cha become might, agility, fortitude, intellect, wits,
    presence.
  - Each activity becomes an Action Item: attack, save (with what a success does), damage, healing, and the
    conditions WildPath has.
  - A spell of level 1 or higher spends a slot of its level or higher, and its scaling dice grow per level above.
  - Item uses become a resource pool (`GrantResource`), with class scale values as tables on the class level.
  - A creature keeps its abilities, Hit Points, AC (natural, or worn armor and shield), Speeds and size.
    Resistances, immunities and Legendary Actions go on a Traits feature, and an ability-based save DC is fixed
    from its Challenge Rating.
- **Formulas and scaling (2026-10-14).** dnd5e roll data translates into WildPath formulas (`formulaExpression`):
  - ability modifiers, proficiency, class and character levels, `max`/`min`/`floor`/`ceil`, and spell save DCs;
  - class scale values as tables on the class level (Sneak Attack's dice, Martial Arts' die).
  - Cantrips are tables of dice on character level, which the engine resolves before rolling.
  - A higher slot adds damage and healing dice and targets (`scaleDamage`, `scaleHealing`, `scaleTargets`).
- **Older dnd5e data.** `upgradeLegacy` reads items stored before activities (dnd5e 3.x and earlier, as 2014
  modules are), so 2014 content converts like the rest. A save's damage is halved on a success there, as dnd5e's
  own migration assumes.
- **Three kinds of Item.** Each converted Item is one of these:
  - **Automated:** an Action that resolves fully.
  - **Manual:** something the creature uses that WildPath cannot automate, such as Multiattack, Parry, or a spell
    whose condition WildPath lacks. Using it spends its cost (an Action, a Reaction, a spell slot), and its
    description says the rest.
  - **Feature:** a passive ability, carrying its text.
- **Never approximated.** What is not automated is listed in `flags.wildpath.conversion.notes` and in
  `docs/content/srd-conversion.md`. Examples:
  - cantrip damage growing with level, and more healing at higher levels;
  - versatile damage;
  - a cube area (the user picks the targets instead);
  - conditions WildPath lacks (Paralyzed, Grappled, Frightened...);
  - Recharge (the pool is refilled by hand).
- **Proficiency.** Converted attacks are proficient (`attack.proficient`), and a creature's proficient saves carry
  over (`saveProficient`). So a stat block's to-hit matches: the Bandit Captain's Scimitar is +5.
- **Descriptions** are the SRD's own text, copied as placeholders (maintainer decision; AGENTS §22 forbids only
  generated prose). dnd5e's enrichers are resolved against the document's own data:
  - links become their labels;
  - a stat block's `[[/attack]]` and `[[/damage]]` become "Melee Attack Roll: +5, reach 5 ft. Hit: 6 (1d6 + 3)
    Slashing damage";
  - saves, checks and lookups such as `@save.dc.value` become plain text.
- **Volume (2026-10-14).** All of the SRD's spells, weapons and features, and its creatures, from 1,110 documents:
  918 Items (209 automated, 464 manual, 245 features) and 375 creatures. Every Action validates.
  - Armor is not converted yet; worn armor counts toward a creature's AC.
  - Characters, vehicles and the "Free Rules" documents are skipped.

Live (14.369). First, the representative slice was created straight from the pack sources:
- A 5th-level wizard's Fireball, cast by Player1, asked for a slot and spent a 3rd-level one. It rolled 8d6
  (25): a failed save took 25 and a successful one 12.
- The Bandit Captain's Scimitar hit with Agility (finesse): 12 + 3 against AC 10, for 1d6 + 3 damage. That is
  without its +2 proficiency.
- After the relaunch, the full packs were filled through Foundry's own API, and all 1,293 documents passed its data
  validation. The Bandit Captain, imported from the pack, hit with its Scimitar at 15 + 5. It kept its Might,
  Agility and Wits save proficiencies, and its manual Multiattack spent its Action and showed its text.
- Converting these found an engine bug, fixed with them. The authority's source snapshot evaluated `prof` from the
  stored `details.level` rather than the class levels, and had no `spellmod` at all, so a class caster's spell
  save DC failed. Both now derive from the class records (value-expressions.mjs).

This work includes material from the System Reference Document 5.2 ("SRD 5.2") by Wizards of the Coast LLC, available at
https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative Commons Attribution 4.0 International License,
available at https://creativecommons.org/licenses/by/4.0/legalcode.

## Your own books as local packages (2026-10-14)

The maintainer's own legitimately sourced books (the dnd5e premium modules) are converted into **local Foundry
module packages**. `scripts/content/convert-dnd5e-module.mjs <module-id> --srd <extracted SRD>` writes
`<Foundry Data>/modules/wildpath-<module-id>` with an Items pack and a Creatures pack.

- **Never in the repository.** The script refuses a target inside it, and the packages must never be committed or
  shared. Each package's manifest says "for personal use only". The script is committed; its output is not.
- **Read-only on the source.** The source module's packs are copied to a temporary folder and extracted there.
- **Same mapping as the SRD.** The only differences:
  - every document of the book is converted, whatever its license field says;
  - the book's art is kept (`modules/<module-id>/...`, served by Foundry from the installed module, with
    wildcard token art kept random);
  - the SRD's classes and journal provide scale values and link names (`--srd`).
- **No dependency on the source module.** It declares dnd5e as its system, so it cannot be enabled in a WildPath
  world. Its art is served anyway.
- **Checked before writing.** Every Action must validate and every id must be unique within its pack, or nothing
  is written. The notes of what is not automated go to the package's `conversion-notes.json`.
- **Enabling them.** Foundry lists a new module only after it scans packages again: return to setup, launch the
  world, and enable the packages under Manage Modules.

Converted on 2026-10-14 (dnd5e 6.0.2 data), as of the conditions track (G2):

| Package | Items: automated / manual / features | Creatures |
| --- | --- | --- |
| Player's Handbook (2.1.0) | 264 / 487 / 409 | 127 |
| Dungeon Master's Guide (2.0.0) | 82 / 164 / 52 | 71 |
| Monster Manual (1.3.0) | 425 / 193 / 134 | 504 |
| Tasha's Cauldron of Everything (3.0.0, 2014 rules) | 65 / 176 / 190 | 124 |

Each package was read back with the Foundry CLI, and every art path resolves on disk. They have not been opened
in Foundry yet; that waits for the next world launch.

## WildPath Actions

Mechanical data only, with no descriptions (AGENTS §22). Item names are functional labels, for the
maintainer to review.

| Action | Mechanic it represents |
| --- | --- |
| Melee Strike | melee weapon attack, 1d8 slashing |
| Ranged Shot | ranged attack with normal and long range (80/320 ft), 1d6 piercing |
| Quick Jab | a Bonus Action attack, 1d4 bludgeoning |
| Trip | a hit applies Prone |
| Venom Burst | Fortitude save DC 13: 2d6 poison, half on a success, Poisoned on a failure |
| Mending Touch | healing, 1d8 |
| Scaling Bolt | 2d6 fire, cast with a level 1 or 2 slot, +1d6 per level above 1 |
| Burning Ground | 10-ft lasting area: 2 fire on casting, then 4 fire on entering or starting a turn there |
| Guardian Aura | 5-ft concentration aura: 3 radiant to creatures it enters or that start a turn in it |

Each mechanic was first proven live in the representative gate (M1–M3).
