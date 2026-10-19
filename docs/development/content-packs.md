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

### Classes and origins (G8, 2026-10-15)

dnd5e classes, subclasses, species (races) and backgrounds become WildPath class, subclass, species and background
Items (`convertProgression`), in **SRD 5.2: Classes and Origins** (`srd-classes`: 12 classes, 12 subclasses, 14
species, 4 backgrounds) and each book package's own `classes` pack.
- **Fields.** A class's identifier, Hit Die, primary abilities (for the multiclassing warning), prepared spells by
  level (its `max-prepared` scale) and spellcasting (an
  Artificer rounds up like a half caster; third casters and pact magic are not converted); a subclass's class; a
  species' size.
- **Feats** keep their dnd5e category in `flags.wildpath.source.feat` (`origin`, `general`, `fightingStyle`,
  `epicBoon`), so an Ability Score Improvement can offer the feats it allows.
- **What each level gives** (`advancement`, level 0 for a species or background at creation):
  - `grant`: the features it gives, as the converted Items' uuids (a magic item's gear, which brings its Actions);
  - `choice`: a choice of `count` features from `items`;
  - `trait`: skills, saves, armor, weapons, tools and Weapon Mastery to grant or choose (`skills:athletics`,
    `saves:might`, `armor:heavy`, `weapons:martial`, `masteries:martial:*`), some only for the original class
    (`classRestriction: "primary"`) or when multiclassing (`"secondary"`);
  - `improvement`: ability increases (`points`, `cap`, the `abilities` allowed), or a feat for a class's;
  - `subclass`, and a species' `size`.
- Hit points (from the Hit Die) and scale values (the features' own tables) need no entry. Languages are not
  tracked.

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
- **House text** (`houseText`): where WildPath's rule differs from the book, the text says what WildPath does. The
  Defense Fighting Style's +1 AC needs no armor (maintainer, 2026-10-15: too weak to need it), so its armor clause
  and dnd5e's note about turning the effect off are dropped.
- **AC calculations** in effects become `ArmorClass` rules: Mage Armor, Draconic Resilience, and the Barbarian's,
  Monk's and College of Dance's Unarmored Defense.
- **Hover (G6).** A creature's fly Speed keeps dnd5e's hover (`GrantMovement` `hover: true`), so it does not fall
  when knocked Prone (21 SRD creatures).
- **Area heights (G6).** A Cylinder keeps its height (`area.height`), as a wall does; a circle lies on the ground
  (height 0). See areas.md, "Elevation".
- **Spells cast from items** are the spell's Action, named after the item ("Wand of Fireballs: Fireball"). They
  spend the item's charges, and use its own save DC when it has one (DC 15), else the user's spell save DC.
  162 SRD Actions.
- **An item's Actions come with it.** Its gear lists them (`flags.wildpath.grants`, ids in its own pack). Adding
  it to a creature from the compendium adds them too, marked `flags.wildpath.grantedBy`, and deleting it deletes
  them (`WildPathItem`).
- **Armor kind (G8).** Armor and Shields keep their kind in the gear's `armor` field (light, medium, heavy, shield),
  which armor training reads; magic armor "of any kind" has none.
- **Checks (2026-10-18).** An item's check activity (Thieves' Tools, escaping Manacles or a Chain, a Grappling Hook)
  becomes its user's own check (`definition.check`, `checkOf`): its ability, or the first skill it names, and its DC.
  The card shows success or failure. A spell's check stays by hand, because Maze's is its target's escape.
  - shortcut: a tool's proficiency bonus is not added yet.
  - The census row fell from 179 to 10; automated SRD Items went from 522 to 607, and the Player's Handbook's from
    400 to 475.
- **Saves and attacks with nothing else converted (2026-10-18)** still roll: Command, Counterspell, Zone of Truth, a
  Net. The card shows who saved or was hit, and the description says what follows. They used to be left as a cost
  with no roll. The note "rolled (save); what it does is by hand" puts them in the census row "rolled, consequences by
  hand" (374 saves, 45 attacks). Automated SRD Items went from 607 to 690, and the Player's Handbook's from 475 to
  549.
- **Speed multipliers (2026-10-18).** dnd5e 2024 scales Speed with `movement.multiplier`:
  - Haste ×2, and Slow and Spirit Guardians ×0.5, change the walking Speed, as `movement.walk` multiply already did.
  - ×0 (Power Word Stun, Haste's Lethargy) caps movement at 0, which stops every Speed.
  - shortcut: other multipliers leave fly and swim Speeds alone.
- **Damage bonuses in dice (2026-10-18)** become `ExtraDamage` on each hit of that kind of attack: Divine Favor's
  1d4 Radiant, Enlarge's 1d4 (the weapon's own type). Penalties in dice (Reduce's −1d4) and Rage's level-scaled bonus
  are left to the GM.
- **Areas that keep acting (2026-10-18)** become lasting areas (`lastingArea`), by their 2024 wording: "a creature
  also makes this save when it enters the area or ends (starts) its turn there".
  - Covers Moonbeam, Web, Cloudkill, Wall of Fire, Insect Plague, Incendiary Cloud and Spirit Guardians, and the items
    that cast them: 26 SRD Actions.
  - The area lasts the spell's duration and ends with its concentration. Its trigger repeats the save, damage and
    effects on the creature, at most once per turn.
  - Spirit Guardians ("you can designate creatures to be unaffected") spares its caster's side.
  - A higher slot's dice reach the repeat too, for the area's whole life: the slot's scaling applies to the triggers'
    damage (same ids), and the Region stores the configured definition (2026-10-18).
  - Live (2026-10-18): QA Caster's Moonbeam at 3rd level hit the Bandit Captain for 10 and left a lasting Moonbeam
    for 10 rounds, with the caster concentrating. At the end of the Captain's turn it saved again and took 8 (2d10), the
    base level's dice, which was the bug. Fixed: the stored repeat is 3d10, and the turn's end rolled 3d10 = 21.
  - An area its caster can move ("you can take a Magic action on later turns to move the Cylinder up to 60 feet") gets
    a second Action, "Moonbeam (Move)", costing that action, with `moveArea: {of, distance}` (`moveAreaDefinition`).
    Only Moonbeam has that wording in the SRD.
  - Something with no duration of its own (a flask of Oil) is not a lasting area.
- **Effects by hand (2026-10-18).** Three spell effects dnd5e leaves empty get their 2024 rules from a small table
  (`EFFECTS_BY_HAND`):
  - Faerie Fire: attacks against it have Advantage;
  - Blur: attacks against you have Disadvantage;
  - Vicious Mockery: Disadvantage on its next attack roll.
  The rest need rules the engine lacks: healing blocked, ongoing damage, no spellcasting.
- **Marks (2026-10-19).** Hunter's Mark (and the Ranger's Favored Enemy casting it) and Hex mark their target with
  an effect of their own slug, whose `ExtraDamage` adds 1d6 (Force, Necrotic) to its caster's attack hits
  (rule-elements.md, "On its target: a mark").
  - Their "Bonus Mark/Hex Damage" activities are that rule, not Actions.
  - Hex asks which ability: its six "Hexed" effects become an "Ability" choice that keeps the chosen one
    (a `keepEffect` configuration effect).
  - Live: Player1's QA Caster chose "Hexed Dexterity", and QA Saver got only that effect.
- **Scale values of species, subclasses and features (2026-10-19).** dnd5e scale values now follow the level their
  owner uses: a class's own, a subclass's class (Land's Aid by Druid level), a feature naming its class (Divine Spark by
  Cleric level), or the character's (Dragonborn's Breath Weapon, 1d10 to 4d10). "(@scale…)d8" is dice whose count is
  the scale. Before, all three were left by hand.
- **A choice of damage types (2026-10-19).** A damage part of several types asks which when used ("Damage type": a
  Breath Weapon's acid, cold, fire, lightning or poison; Chromatic Orb; Spirit Guardians' radiant or necrotic). The
  choice reaches a lasting area's repeat too. Before, the first type was always used. 17 SRD documents changed.
  - The use dialog's preview shows the chosen type and a table's dice at the creature's own level ("2d10 fire").
  - Live: Player1's QA Fighter (level 6) used the SRD Breath Weapon (Cone) and chose Fire. The preview read "2d10
    fire"; the Bandit Captain failed its save and took 6 fire.
- **Ending conditions (2026-10-19).** An effect row with negative `levels` ends its condition on each target instead
  of applying it (an Exhaustion row of −1 removes one level). Planning cannot see the target's effects, so the plan
  is a "noop" there; the commit deletes or reduces the condition on the live creature, and does nothing when it lacks
  it. A small table (`REMOVALS`) gives the 2024 rules dnd5e leaves to the text:
  - Lesser Restoration: one of Blinded, Deafened, Paralyzed or Poisoned (a choice);
  - Greater Restoration: one level of Exhaustion, Charmed or Petrified (a choice; curses and reductions by hand);
  - Heal: Blinded, Deafened and Poisoned; Power Word Heal: Charmed, Frightened, Paralyzed, Poisoned and Stunned;
  - Protection from Poison and Lay on Hands' Remove Poison: Poisoned.
  SRD automated Items rose from 719 to 724, with the items and creatures that cast them. The Builder's condition rows
  have "Ends it instead". Live (two browsers, 2026-10-19): Player1's QA Caster cast the SRD Lesser Restoration on
  the Poisoned and Blinded QA Fighter and chose Poisoned. Poisoned ended, Blinded stayed, and the Action and a
  2nd-level slot were spent. From 10 ft away it was refused: the spell is a touch spell.
- **Saves with nothing else converted (2026-10-19).** The conditions their 2024 text gives on a failure ("On a failed
  save, a creature has the Prone condition", "Failure: The target has the Charmed condition", "must succeed on a Dexterity
  saving throw or have the Restrained condition") apply on a failure: Grease, Sleet Storm, Earthquake (Prone),
  Dominate Mind (Charmed). One that lasts (a duration, or concentration) without them marks the creatures that fail:
  Zone of Truth, Confusion, Bestow Curse. SRD saves left wholly by hand fell from 137 to 35 documents, and
  concentration effects not converted from 175 to 122.
- **Polymorph (2026-10-19).** A failed save transforms the creature into a Beast its caster chooses from the converted
  Beasts (classes-and-spellcasting.md); its text's rules on what it may do in its form are by hand. A magic item that
  casts a spell keeps the spell's choices except the slot (a Beast, a damage type, one of its effects), and a wand whose
  cast dnd5e gives no charge spends the one its text names ("expend 1 of its charges to cast"): Wands of Polymorph and Web.
- **Effects as markers (2026-10-19).** A dnd5e effect with no status and nothing WildPath maps (Alter Self's Aquatic
  Adaptation, Acid Arrow's lingering acid, a dragon's Detect Magic) is no longer dropped. It is a custom effect with
  no rules: its name, icon, duration, save policy and concentration. Its creature shows it, it expires on time, and it
  ends with its caster's concentration; what it does stays by hand (note: "marks its creature only"). SRD "concentration
  effect not converted" fell from 247 to 175 documents, and 210 SRD effects are markers. SRD automated Items rose from
  730 to 802, markers included. Live: Player1's QA Caster cast the SRD Alter Self (Aquatic Adaptation), 1 hour, and
  casting Bless ended it.
- **Temporary Hit Points (2026-10-19).** A heal activity of dnd5e's `temphp` type is healing of type
  `temporary` (durability-resolution.md): False Life, Heroism, Fiendish Vigor, Tireless, Adrenaline Rush, a
  Potion of Heroism, and the creatures casting them. SRD automated Items rose from 725 to 730. The Builder's healing
  rows have "Temporary Hit Points".
- **Escape DCs (2026-10-19).** A Grappled or Restrained effect row gets `metadata: {escapeDC}`, so the common Escape
  action can be taken against it. The DC comes from the Item's "Escape Check" activity: a number, dnd5e's
  `@skills.ath.passive` (the creature's passive Athletics: 10 + its modifier and proficiency), or an ability's
  8 + proficiency + modifier. Without that activity, "escape DC 13" in its text is used. In the SRD: 38 creatures
  and the Rope of Entanglement. The DCs are dnd5e's data, not checked against the printed stat blocks.
- **Common actions taken by a feature (2026-10-19).** A utility activity named Dash, Disengage, Dodge or Hide (the
  Rogue's Cunning Action, Conjure Woodland Beings' Disengage) is WildPath's own common action at the activity's cost,
  and an effect named Disengaged, Dashing or Dodging with nothing of its own (the Monk's Patient Defense and Step of
  the Wind) is that action's effect. SRD automated Items rose from 713 to 719. A small table (`COMMON_BY_TEXT`) adds
  the activities whose 2024 text names the actions: with a Focus Point, Patient Defense is Disengage and Dodge
  (dnd5e gave only its unmapped Dodging) and Step of the Wind is Disengage and Dash; a Shadow's Shadow Stealth is
  Hide (725 automated).
  - Live (two browsers): Player1's QA Fighter used Cunning Action (Dash): Bonus Action spent, Dashing, movement 30 to
    60. Monk's Focus (Step of the Wind) gave Disengaged and Dashing for the Bonus Action and a Focus Point. Patient
    Defense (Focus Point) gave Dodging, paid with the Action once the Bonus Action was spent (the WildPath house
    rule, action-economy.md).
  - A Clay Golem's Hasten is Dash and Disengage. One that takes one action of several is an Action each
    (`COMMON_CHOICES`): Nimble Escape (goblins, Panther, Tiger, Saber-Toothed Tiger) is "Nimble Escape (Disengage)"
    and "Nimble Escape (Hide)"; a Vampire Familiar's Deathless Agility is Dash or Disengage. Live: an SRD Goblin
    Warrior used both as Bonus Actions, Hide at 1d20 + 6.
  - Not yet: Step of the Wind without a Focus Point (Dash as a Bonus Action), which dnd5e has no activity for.
- **Creature skills (2026-10-19).** A creature's dnd5e skills convert to `skills.<skill>.proficiency`: 1 proficient,
  2 expertise (dnd5e's half proficiency is none). Before, every converted creature rolled its skills on its ability
  alone: a Goblin Warrior's Stealth was +2, not +6. All 375 SRD creatures changed.
- **Creature initiative (2026-10-19).** dnd5e's initiative bonus (`@prof`, `@prof * 2` in 2024 stat blocks) is an
  `initiative` Modifier on the creature's Traits, kept as a formula on its proficiency. 104 SRD creatures. Live: an
  SRD Adult Red Dragon's initiative rolled `1d20 + 12` (Agility +0, twice its proficiency of 6).
- **Hovering (2026-10-19).** dnd5e's `movement.hover` goes on the fly Speed the same effect grants: Fly, Gaseous
  Form, Wind Walk, a Potion of Flying, the Air Ring, and the creatures casting them (16 SRD documents). A hovering
  flyer knocked Prone does not fall. Live: Player1's QA Caster cast the SRD Fly on itself: "Flight", a fly Speed of 60
  with hover.
- **Ability scores (2026-10-19).** dnd5e changes to `abilities.<x>.value` (`add`, `upgrade`, `downgrade`, `override`)
  become `AbilityScore` rules. An `add` with a `downgrade` (an Ioun Stone's "+2, to at most 20") or a raised `max` (a
  Tome's 30) is one capped add.
  - SRD Items automated rose from 696 to 708: the Belts and Potions of Giant Strength, Headband of Intellect, Amulet
    of Health, Gauntlets of Ogre Power, Ioun Stones and Tomes.
  - A rolled change (a Shadow's "−1d4 Strength") is a choice of its −1 to −4 effects (below).
- **One of several effects (2026-10-19).** dnd5e lists an activity's effects as options its user applies. When an
  activity names more than one, the converted Action asks which ("Effect"). Each option keeps every condition its
  dnd5e effect brings (Divine Word's "Blinded, Deafened, Stunned").
  - 38 SRD Actions ask: Blindness/Deafness, Enlarge/Reduce, Bestow Curse, Contagion, Enhance Ability, Protection from
    Energy, Guidance, Power Word Stun (by the target's hit points), Unarmed Strike's Grapple or Prone, a Shadow's drain.
    Before, all of them applied at once.
  - A staged effect (a Gorgon's Restrained, then Petrified) is chosen at its first stage.
  - shortcut: a Darkmantle's Crush and a Mummy Lord's Whirlwind of Sand pair an effect on themselves with one on
    their target; the choice offers both, and the creature's own still lands on the target. Upgrade with
    self-targeted effects.
  - Live: Player1's QA Caster cast Blindness/Deafness at QA Failer, chose Deafness, and only Deafened was applied.
- **A follow-up spends no slot (2026-10-19).** An activity dnd5e marks as spending no spell slot
  (`consumption.spellSlot: false`) has no slot choice. Before, 26 SRD follow-ups spent a slot each time:
  - Hunter's Mark's Move Mark and Hex's Curse New Creature;
  - Flame Blade's attack, Heat Metal's reheat, Dragon's Breath's exhale, Sunbeam's new beam, and more.
  - shortcut: such a follow-up rolls its base level's dice.
- **Weapon kind (G8).** A weapon's attack carries `attack.weapon`: its base weapon (`longsword`, `light-crossbow`),
  `simple` or `martial`, and its 2024 mastery (`sap`), which weapon training and Weapon Mastery read. 93 SRD weapon
  Actions have one.
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
