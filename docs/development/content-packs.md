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

**SRD 5.2: Spells, Equipment and Features** (`srd-items`, Items) and **SRD 5.2: Creatures** (`srd-creatures`,
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

Converted on 2026-10-14 (dnd5e 6.0.2 data), as of the monster toolkit (G4):

| Package | Items: automated / manual / features | Creatures |
| --- | --- | --- |
| Player's Handbook (2.1.0) | 320 / 431 / 409 | 127 |
| Dungeon Master's Guide (2.0.0) | 122 / 124 / 52 | 71 |
| Monster Manual (1.3.0) | 472 / 146 / 134 | 504 |
| Tasha's Cauldron of Everything (3.0.0, 2014 rules) | 83 / 158 / 190 | 124 |

Each package was read back with the Foundry CLI, and every art path resolves on disk. They have not been opened
in Foundry yet; that waits for the next world launch.

### Common monster traits (G5)

A feature is matched by its dnd5e identifier (or its name) and gets the rules of that trait:
- **Magic Resistance:** Advantage on saves against magical effects: every spell, and any Action tagged `magical`. A
  magic item's Actions (dnd5e's `mgc` property) are tagged `magical`.
- **Pack Tactics:** Advantage on attacks while one of the creature's allies, not Incapacitated, is within 5 ft of the
  target.
- **Regeneration:** its healing at the start of each of its turns, on the terms its own text sets: "at least 1 Hit
  Point", the damage types that stop it for a turn (Acid or Fire for a Troll, Fire or Radiant for a Revenant), and
  "dies only if it starts its turn with 0 Hit Points and doesn't regenerate". Its healing activity is the trait's,
  however dnd5e activates it ("special" or "turnStart"). A Vampire's does not work in sunlight; running water is
  the GM's to track (maintainer, 2026-10-15).
- **Flyby:** no Opportunity Attacks when it flies out of reach (`AvoidOpportunityAttacks` for `fly`).
- **Daylight and Darkness** (spells): lasting areas for their duration that shed sunlight (bright over its area,
  dim 60 ft beyond) or darkness. Each ends the other kind it overlaps: Daylight ends Darkness of level 3 or lower,
  Darkness ends spell light of level 2 or lower. "Cast on an object" makes the area follow the Token at its center.
- **Evasion:** an Agility save that halves takes none on a success and half on a failure, unless Incapacitated.
- **Sneak Attack:** once per turn, its dice (by Rogue level, or a stat block's own) of the weapon's damage type, on a
  hit with a Finesse or ranged weapon, with Advantage or with an ally beside the target and no Disadvantage. Its
  damage activity is the trait's.
- **Extra Attack** (and Fighter's Two and Three Extra Attacks): one more weapon attack each time the creature pays
  for one with the Action. Natural weapons and Unarmed Strikes count.
- **Sunlight Sensitivity, Sunlight Weakness, Sunlight Hypersensitivity:** Disadvantage in sunlight on the rolls the
  text names: attack rolls and ability checks (2014: Perception checks), or all D20 Tests. Hypersensitivity also deals its
  damage when the creature starts its turn in sunlight. A Vampire's Regeneration does not work in sunlight.
- **Legendary Resistance:** a pool of the creature's uses ("3/Day", from its stat block). A failed save may succeed
  instead, spending one; its controller is asked unless its setting says Always or Never.

Converted on 2026-10-14, the SRD has Legendary Resistance on 32 creatures, Magic Resistance on 34, Pack Tactics on 18,
Flyby on 6 and Regeneration on 4. The book packages convert the same way.

### The monster toolkit (G4)

- **Multiattack** (named attacks, 2026-10-15).
  - Its text names its attacks: "makes three Rend attacks", "one Bite attack and two Claw attacks", 2014's "three
    attacks: one with its bite and two with its claws".
  - Multiattack costs the Action and fills a pool per named attack, "Multiattack (Bite)" 1 and "Multiattack (Claw)"
    2. The pools start empty and empty at the start of each turn.
  - Each named attack costs a use of its own pool, or the Action. An attack it does not name costs the Action.
  - "Two attacks, using Scimitar or Shortbow in any combination" is one pool those two attacks share.
  - Each alternative ("two Greatclub attacks, or it makes two Javelin attacks") is a Multiattack Action of its own:
    "Multiattack (2 Greatclub)" and "Multiattack (2 Javelin)".
  - "...and uses Constrict" (or "either A or B", "uses Antennae twice") gives that Action a use of its own for the turn.
  - "It can replace one attack with a use of (A) Sleep Breath or (B) Spellcasting to cast Scorching Ray" gives those
    Actions another way to pay: the replacement plus one of the attacks it may replace, besides their own costs (a
    spell's uses). "Replace the Claw attack" allows only the Claw's; "replace any attack" allows as many as it makes.
  - When its text names no attacks, any of its attacks may be each of them, from one pool. What it names but the
    creature has no Action for ("and uses Frightful Presence") is used by hand.
- **Spellcasting.**
  - A cast activity becomes its spell's Action, converted with the creature's save DC and casting ability.
  - It costs the activity's activation and its own uses ("2/Day each"), or an item's charges, never a slot.
  - dnd5e's cached copies of those spells are left out.
- **Uses.**
  - Each activity with uses has a pool of its own.
  - "Day" and "dawn" recover on a long rest.
  - Recharge is rolled at the start of the creature's turn.
- **Item references** by name (`[[/item Rend]]`) keep their name in descriptions.
- **Summons** (2026-10-15). A summon activity summons its creature from the converted creature packs. Several
  creatures become a choice. It lasts the spell's duration in rounds, or while the caster concentrates.
  - What its creature gains with the spell's level comes too: Hit Points, AC, and attack and save damage
    (companions.md).
  - Left by hand:
    - a creature chosen by Challenge Rating (Find Familiar);
    - a count from a formula;
    - a creature not converted;
    - healing and Hit Dice by level, or formulas of anything but the level;
  - A summoned spirit's Multiattack, "a number of attacks equal to half this spell's level", is a pool of half the
    level it was summoned at (`flags.wildpath.summonLevel`, set on each summoned creature).
- **Pushes and pulls** (2026-10-15). An Action with an attack or a save whose text pushes "N feet (straight) away
  from" its source, or pulls "N feet toward itself" (or you), gets `push` (areas.md, "Forced Movement").
  - "If the target is a Large or smaller creature" becomes its `maxSize`. A push in "Success:" text is on a success.
  - Text with two distances, or a pull toward something else (Control Water's whirlpool), is left to the GM.
  - 15 SRD Actions push or pull, from Thunderwave to the Balor's Flame Whip.

### Equipment and magic items (G7, 2026-10-15)

dnd5e equipment, consumables, tools, loot and containers become WildPath gear (`type: "gear"`), carried but not
equipped. Equipping it (`system.active`) turns its rules on.
- **Armor** gets an `ArmorClass` rule (rule-elements.md): its AC plus its magic bonus, with the whole Agility
  modifier for light armor, up to 2 for medium, none for heavy. A Shield is a `defense.ac` Modifier.
  - Heavy armor's Strength requirement is a Speed Modifier: -10 feet below that Might score.
  - Armor that gives Disadvantage on Stealth has a `RollMode` on `check.stealth`.
  - Magic armor naming only its base (Dwarven Plate) gets that armor's kind. Armor of any kind ("Armor, +1, +2, or
    +3", Mithral Armor) is left to the GM.
- **Worn magic items** carry their passive effects' rules (a Cloak of Protection's +1 AC and saves). Disabled
  effects, which dnd5e uses for variants, are left out. Features get their passive effects' rules the same way
  (Unarmored Defense, the Defense fighting style).
- **AC calculations** in effects become `ArmorClass` rules: Mage Armor, Draconic Resilience, and the Barbarian's,
  Monk's and College of Dance's Unarmored Defense.
- **Area heights (G6).** A Cylinder keeps its height (`area.height`), as a wall does; a circle lies on the ground
  (height 0). See areas.md, "Elevation".
- **Spells cast from items** are the spell's Action, named after the item ("Wand of Fireballs: Fireball"). They
  spend the item's charges, and use its own save DC when it has one (DC 15), else the user's spell save DC.
  162 SRD Actions.
- **An item's Actions come with it.** Its gear lists them (`flags.wildpath.grants`, ids in its own pack). Adding
  it to a creature from the compendium adds them too, marked `flags.wildpath.grantedBy`, and deleting it deletes
  them (`WildPathItem`).
- **Weapons.** A Versatile weapon also has a two-handed Action rolling its larger die ("Longsword (Two-Handed)",
  1d10; a Spear's d6 becomes a d8). A magic weapon's bonus is a Modifier on its own attack and damage rolls, and an
  attack's own bonus one on its attack roll.
- A potion or scroll is only its Actions; using one spends its single use.
- **Attunement (2024).** A magic item that needs it (`system.attunement: "required"`, 125 SRD Items) gives its
  rules only once attuned from the sheet, and while equipped. A creature can be attuned to three at most. Its Actions
  (a wand's Fireball) are unavailable on the bar, and refused by the authority, until it is equipped and attuned.
- **Charges and uses regained in part** (`regain`, rule-elements.md): a wand's "1d6 + 1 charges at dawn" on a long
  rest, a feature's "one use on a Short Rest". Dawn, dusk and "per day" are a long rest. 174 SRD Items.
- Left by hand:
  - only an item added from a compendium brings its Actions;
  - armor training (proficiency) is not checked.

Live (two browsers, 14.369): Player1 equipped Chain Mail and a Shield (AC 13 to 18), cast Mage Armor, hit the
Bandit Captain with Longsword (Two-Handed) for 1d10, and cast the Wand of Fireballs' Fireball: one charge spent, QA
Saver saved and QA Failer failed. Dropping the Wand of Fireballs on QA Caster's sheet added its Fireball with 7
charges; deleting the wand from the sheet removed it. A character with the wand at 1 charge kept 1 after a short
rest; a long rest rolled 1d6 + 1 (4 + 1) and it had 6, with "Wand of Fireballs regains 5" whispered to the GM.
A character's equipped Cloak of Protection gave nothing until Player1 attuned it (AC 10 to 11). With the Ring of
Protection and Bracers of Defense also attuned (AC 14), attuning a fourth item was refused. With the Wand of
Fireballs carried but not equipped, its Fireball was greyed out on Player1's bar, and using it anyway was refused
("Wand of Fireballs must be equipped and attuned to use this."), with no card and no charge spent.

### Effects with their own changes (G3)

An activity's effect that changes the creature becomes a custom effect (`effectRules`, dnd5e-to-wildpath.mjs). It
keeps its name and icon, its dnd5e duration, the spell's concentration, and "only on a failed save". Its changes map
to rules:

| dnd5e change | Rule |
| --- | --- |
| `bonuses.mwak/rwak/msak/rsak.attack` | Modifier on `attack` (all four alike), else `attack.weapon`/`attack.spell` for melee or ranged |
| `bonuses.mwak/rwak/msak/rsak.damage` (a number) | Modifier on `damage.weapon`/`damage.spell` |
| `bonuses.abilities.save/check`, `abilities.<a>.bonuses.save/check`, `skills.<s>.bonuses.check` | Modifier on `save`, `check`, `save.<a>`, `check.<a>`, `check.<skill>` |
| `abilities.<a>.save/check.roll.mode`, `skills.<s>.roll.mode` | RollMode: advantage or disadvantage |
| `attributes.ac.bonus`, `attributes.init.bonus`, `attributes.hp.tempmax` | Modifier on `defense.ac`, `initiative`, `resources.health.max` |
| `traits.dr/di/dv/ci.value` | GrantResistance, GrantImmunity, GrantVulnerability, ConditionImmunity |
| `attributes.movement.walk`: add, multiply, override or downgrade | Modifier (Haste doubles), or a ResourceCap |
| `attributes.movement.fly/swim/climb/burrow` | GrantMovement |

A dice value ("1d4", "-1d4") becomes a dice Modifier rolled with the d20 ([rolls.md](../architecture/rolls.md)).
Every other change is noted, never approximated.

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
