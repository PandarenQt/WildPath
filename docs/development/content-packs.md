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
- **Never approximated.** What WildPath cannot express is left out and listed in
  `flags.wildpath.conversion.notes` and in `docs/content/srd-conversion.md`. Examples:
  - cantrip damage growing with level, and more healing at higher levels;
  - versatile damage;
  - a cube area (the user picks the targets instead);
  - conditions WildPath lacks (Paralyzed, Grappled, Frightened...);
  - passive or triggered abilities, and Multiattack.
  - An Action that would roll for nothing is left out.
- **Proficiency.** WildPath adds no proficiency bonus to attack rolls or saves, so converted attacks roll lower
  than their stat blocks. This is noted on each creature, and it is the maintainer's open decision.
- **No descriptions** (AGENTS §22). Whether to copy the SRD's own CC-BY text is the maintainer's decision.
- **Representative first** (CODEX §28). The first conversion is one of each kind: Longsword, Fireball, Fire Bolt,
  Cure Wounds, Second Wind and the Bandit Captain. Volume comes after the open decisions.

Live (14.369, created from the pack sources because the packs load only after a world relaunch):
- A 5th-level wizard's Fireball, cast by Player1, asked for a slot and spent a 3rd-level one. It rolled 8d6
  (25): a failed save took 25 and a successful one 12.
- The Bandit Captain's Scimitar hit with Agility (finesse): 12 + 3 against AC 10, for 1d6 + 3 damage. That is
  without its +2 proficiency.
- Converting these found an engine bug, fixed with them. The authority's source snapshot evaluated `prof` from the
  stored `details.level` rather than the class levels, and had no `spellmod` at all, so a class caster's spell
  save DC failed. Both now derive from the class records (value-expressions.mjs).

This work includes material from the System Reference Document 5.2 ("SRD 5.2") by Wizards of the Coast LLC, available at
https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative Commons Attribution 4.0 International License,
available at https://creativecommons.org/licenses/by/4.0/legalcode.

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
