# Gap roadmap: automating the D&D catalog

Maintainer direction (2026-10-14): focus on the gaps, thinking about **every book Wizards publishes on D&D Beyond**,
not only the ones converted so far.

**2014 and up (maintainer, 2026-10-14).** Older books count too, from 2014 onward:
- **2014 content under 2024 rules.** Older content plays under the 2024 rules, as Wizards intends. So the converter
  reads dnd5e's older item data, which is how 2014 modules store their content: before activities, with damage
  parts as formulas, uses per day and Recharge on the item. It also maps 2014-only mechanics, such as resistance to
  nonmagical attacks.
- **The 2014 rule set.** For tables that play by it, the places where the rulesets differ get a world setting:
  Exhaustion's six-level table, Grappled, Incapacitated, Invisible, surprise and the 2014 rest rules. The 2024 rules
  stay the default.

## How the gaps are measured

`node scripts/content/gap-census.mjs` counts what is not automated, by reason, in the converted content. That is
the SRD packs plus the local book packages: Player's Handbook, Dungeon Master's Guide, Monster Manual and
Tasha's. Each reason counts once per document. Rerun it after each gap closes to see the effect.

Census on 2026-10-14, documents per reason (top rows; the four books are summed):

| Reason | SRD | Books | Total |
| --- | --- | --- | --- |
| "utility" activity used, not automated | 752 | 690 | 1442 |
| passive or triggered ability | 150 | 598 | 748 |
| save activity with nothing converted on it | 276 | 372 | 648 |
| effect with its own changes (buff or debuff) | 255 | 345 | 600 |
| concentration effect not converted | 308 | 241 | 549 |
| long activation (minutes, hours) | 236 | 170 | 406 |
| Multiattack | 0 | 356 | 356 |
| monster spellcasting ("cast" activity) | 116 | 234 | 350 |
| Recharge | 94 | 219 | 313 |
| save DC from a formula | 123 | 164 | 287 |
| summon activity | 103 | 156 | 259 |
| condition immunities | 0 | 252 | 252 |
| per-activity uses (3/Day each) | 62 | 142 | 204 |
| target count growing with spell level | 66 | 88 | 154 |
| Grappled / Charmed / Frightened / Incapacitated / Invisible / Paralyzed | 168 | 328 | 496 |
| cube, cylinder, wall, circle areas | 98 | 139 | 237 |
| versatile damage | 34 | 61 | 95 |
| healing upcast, cantrip scaling, temporary Hit Points | 38 | 66 | 104 |

## The wider catalog

The other Wizards books on D&D Beyond reuse these same mechanics at volume. They also add a few of their own:
- **Monster books** (Volo's, Mordenkainen's, Monsters of the Multiverse, Fizban's, Bigby's): Multiattack,
  Recharge, innate spellcasting with uses per day, Legendary and Lair Actions, Legendary Resistance, and common
  traits such as Magic Resistance, Pack Tactics and Sunlight Sensitivity.
- **Player options** (Xanathar's, Tasha's, setting books, Forgotten Realms 2025, Forge of the Artificer):
  - dice that scale with level (Sneak Attack, Martial Arts, superiority and psionic dice);
  - feats, subclasses and backgrounds;
  - artificer infusions and replicated magic items;
  - dragonmarks and supernatural gifts.
- **Setting systems:**
  - Theros mythic actions and piety;
  - Ravenloft dark gifts and fear (Van Richten's, and The Horrors Within, 2026);
  - Spelljammer and Saltmarsh ships and vehicles;
  - Dragonlance mass combat;
  - DMG 2024 Bastions;
  - the Book of Many Things' deck;
  - Arcana Unleashed (2026; its mechanics are not yet known).
- **Magic items everywhere:** attunement, charges that recover at dawn, spells cast from items, potions and
  scrolls, and +N weapons and armor.

## Progress

- **G1 (2026-10-14).** Done:
  - dnd5e formulas translate into WildPath formulas: ability modifiers, proficiency, class levels, `max`/`min`,
    class scale values as tables of numbers or dice, and creature and character spell save DCs.
  - Cantrips get tables on character level, and the engine picks a table's row before rolling.
  - A higher slot can add healing dice (`scaleHealing`) and targets (`scaleTargets`).
  - The converter reads dnd5e's older item format (2014 modules).
  - Effect on automated Items:

    | Source | Before | After |
    | --- | --- | --- |
    | SRD | 209 | 221 |
    | PHB | 204 | 231 |
    | MM | 291 | 390 |
    | Tasha's | 53 | 61 |

    Tasha's creatures now also show their Multiattack and traits for later tracks.
  - Live: a 5th-level wizard's Fire Bolt rolled 2d10, and Cure Wounds from a 2nd-level slot rolled 2d8 + 2d8 + 3.

## Tracks, in order

Each track is ranked by how much content it unblocks across all books, and by how general its primitive is.

1. **G1, formulas and scaling.**
   - Translate dnd5e roll data (`@abilities.x.mod`, `@prof`, `@classes.x.levels`, `@scale.*`, `max`, `min`)
     into WildPath formulas.
   - Let tables of dice grow with level: cantrips, Sneak Attack, Martial Arts and other scale dice.
   - Healing that grows with the slot level, and target counts that grow with it.
2. **G2, conditions.**
   - The eight missing 2024 conditions: Charmed, Deafened, Frightened, Grappled, Incapacitated, Invisible,
     Paralyzed and Petrified. Three of them depend on their source: Charmed, Frightened and Grappled.
   - Condition immunities, and damage vulnerabilities.
3. **G3, effects with their own rules.**
   - Map dnd5e Active Effect changes (AC, attack and damage bonuses, saves, checks, Speed, resistances) to
     RuleElements.
   - Apply them as custom effects with their durations and concentration. This unblocks most buff and debuff
     spells and the saves that apply them.
4. **G4, the monster toolkit:**
   - Multiattack;
   - Recharge (rolled at the start of the creature's turn);
   - monster spellcasting with uses per day;
   - per-activity uses;
   - Legendary Resistance;
   - summons with their creatures;
   - Lair Actions.
5. **G5, a common-trait library.** RuleElements for passive traits that recur across books (Magic Resistance,
   Pack Tactics, Sunlight Sensitivity, Sneak Attack, Extra Attack, Evasion...), matched by name or identifier.
6. **G6, areas:** cube, cylinder and wall, with their placement.
7. **G7, weapons, armor and magic items:**
   - versatile damage and +N weapons;
   - 2024 Weapon Mastery;
   - armor and AC formulas (Unarmored Defense, natural armor, Mage Armor);
   - attunement and charges, spells cast from items, and potions and scrolls.
8. **G8, character progression** (needs maintainer decisions):
   - classes, subclasses, species, backgrounds and feats, with level-up from dnd5e advancements;
   - skills and tools with proficiency and expertise;
   - Hit Dice and short-rest healing;
   - Heroic Inspiration;
   - spell preparation.
9. **G9, setting and out-of-combat systems** (design for them, build later): vehicles, Bastions, mythic actions,
   dark gifts, mass combat, roll-table decks, hazards, poisons and diseases, crafting and travel.

Long activations (rituals, minutes) stay manual on purpose: they happen out of combat, and spending the slot is
the useful part.
