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

**Baldur's Gate 3 (maintainer, 2026-10-14).** BG3's mechanics, UX and game flow count too. BG3 is 5e with a
computer doing the bookkeeping, which is WildPath's job too. See [Baldur's Gate 3](#baldurs-gate-3) below.

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

## Baldur's Gate 3

What BG3 does that WildPath should learn from, in three kinds. Only the third changes the rules.

### B1. Game flow and UX (no rules change)

Each is small, and each changes every turn at the table.

1. **Odds before you commit.** With a target chosen, hovering an attack or save Action on the bar shows:
   - the chance to hit, or the chance the target fails its save;
   - the expected damage;
   - each modifier and where it comes from.

   It is built on the Test tab's `previewAction` and the authority's roll modes, and the authority still
   resolves for real.

   The odds reveal a target's AC and save bonuses. Maintainer decision (2026-10-14): whether players see them
   is a house rule (a world setting), and by default only the GM does. An effect can reveal a creature's
   details to the creature that applied it. That gives martials a kind of utility casters do not get, such
   as sizing up a foe.
2. **Reactions: Always, Ask or Never**, per reaction, set from the action bar. Today every eligible reactor is
   prompted, with Decline. A stored choice answers for the creature, so fewer attacks wait on a prompt.
3. **Movement that warns.** While moving, the path shows:
   - the Speed left;
   - each enemy whose reach the path leaves, which is an Opportunity Attack;
   - lasting areas and difficult terrain on the way.

   The staged movement checkpoints already know all three.
4. **Area preview.** While an area is placed, the creatures it would hit are highlighted, allies included.
5. **Floating combat text** over Tokens: damage by type, healing, Miss, Immune, Resisted. Foundry's scrolling
   text does this. An ignored condition then shows "Immune"; today it shows nothing.
6. **Tooltips that explain.**
   - A condition's icon shows its rules and the rounds left.
   - A roll on a card opens its breakdown in place: the Rules Inspector's detail.
7. **Common actions for every creature**, with no authoring:
   - the 2024 actions: Dash, Disengage, Dodge, Help, Hide, Influence, Search, Study and Utilize;
   - Grapple and Shove, as Unarmed Strike options;
   - Jump.
8. **A tidier bar**, grouped as BG3 does: common actions, class and feature actions, spells by level, and items.
   When the slot level is the only choice, it is picked on the button rather than in a dialog.

### B2. Mechanics that 5e content needs anyway

1. **Forced movement and falling.**
   - Push and pull: Thunderwave, Repelling Blast, Shove, the Push mastery. In the SRD alone, 24 Items push.
   - Landing in a hazard, or off a ledge with 2024 falling damage: 1d6 per 10 ft, and Prone.

   BG3's best tactical moments are shoves off ledges and into fire.
2. **Elevation in combat:** Token elevation for reach, range and areas, plus flying and falling. Lasting areas
   already have elevation bounds.
3. **Weapon Mastery** (2024) is the tabletop form of BG3's weapon actions. Done in G8 (2026-10-15): masteries are
   chosen at level up, and Push, Slow, Sap, Vex, Topple and Graze apply automatically; Cleave and Nick are manual.
4. **Areas that react to damage.** A lasting area changes when it takes a damage type:
   - oil explodes into fire;
   - cold freezes water into ice;
   - lightning electrifies water;
   - fire melts ice, and turns water into steam.

   Lasting areas exist; the table of reactions is new.

### B3. BG3's own rules, as world settings (maintainer decides)

Each changes the rules, so each is a world setting. Maintainer decision (2026-10-14): offer all of them, off by
default:
- **High ground:** +2 to attack rolls from 2.5 m (8 ft) above the target, and −2 from as far below. Done
  (2026-10-15): the `highGround` world setting, off by default.
- **Bonus-action moves:** Shove and Jump as Bonus Actions, and Dip a weapon in fire for extra fire damage. Shove
  done (2026-10-15): the `bonusActionShove` world setting, off by default; Jump and Dip not yet.
- **Surfaces** with BG3's reactions, and its Wet condition: resistance to fire, vulnerability to cold and
  lightning, and immunity to Burning.
- **Help** gets a downed ally back up.
- **Shared initiative:** allies next to each other in the initiative order act together, in any order.
- **Karmic dice:** digital rolls nudged after a streak of failures or successes.
- **Weapon actions** (Lacerate, Topple, Cleave...), once per short rest with a weapon the creature is proficient
  with: optional content, beside Weapon Mastery.
- **Camp supplies** to take a long rest.

### Order

Maintainer decision (2026-10-14): B1 comes before G3, starting with:
1. reactions Always, Ask or Never;
2. odds;
3. floating combat text;
4. common actions.

Forced movement and elevation join G6, which becomes "space": areas, elevation and forced movement.

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

- **G2 (2026-10-14).** Done:
  - the eight missing 2024 conditions, with their icons in the Token HUD:
    - Incapacitated, Paralyzed (critical hits within 5 ft) and Petrified (resistance to all damage, immune to
      Poisoned);
    - Invisible, Deafened and Frightened;
    - Grappled: Speed 0, and disadvantage on attacks against anyone but the grappler;
    - Charmed: the authority refuses a harmful Action against the charmer.
  - Grappled and Charmed know their source: the Action, Actor or Token named by the condition's effect.
    `attack.fromTarget` lists the conditions the attacker has from its target, for any rule's predicate.
  - `ConditionImmunity` and `GrantVulnerability` RuleElements; the converter maps condition immunities and
    vulnerabilities to them. Both are also rule rows in the builder.
  - The 2014 rule set: the `rulesVersion` world setting (2024 by default) swaps in the 2014 Exhaustion table,
    Grappled, Incapacitated, Invisible, Stunned and Petrified.
  - Effect on automated Items:

    | Source | Before | After |
    | --- | --- | --- |
    | SRD | 221 | 250 |
    | PHB | 231 | 264 |
    | DMG | 80 | 82 |
    | MM | 390 | 425 |
    | Tasha's | 61 | 65 |

    Condition immunities left unconverted fell from 252 to 4 (only conditions WildPath lacks, such as
    diseased). The SRD's "concentration effect not converted" fell from 416 to 370, and its save activities
    with nothing converted from 272 to 199.
  - Live, two browsers: the Bandit Captain grappled the Player's caster, whose Fire Bolt then rolled 1d20 at
    the Captain and 2d20kl at another creature. Charmed by the Captain, the caster's Fire Bolt at it was
    refused, unspent; at another creature it went through. With `ConditionImmunity` to Grappled, a hit
    applied nothing.

- **G7, weapons, armor and magic items, first part (2026-10-15).** Done:
  - An `ArmorClass` rule: armor, Unarmored Defense and Mage Armor, and 10 + Agility unarmored. A typed AC on the
    sheet wins; blank means worked out (maintainer, 2026-10-15).
  - Equipment converts as gear: armor and shields with their AC, Strength and Stealth, and worn magic items'
    passive rules. The SRD pack gained 454 gear items.
  - Spells cast from magic items: 162 SRD Actions, with the item's charges and save DC.
  - Versatile weapons get a two-handed Action (25 in the SRD), and magic weapons their bonus.
  - Automated SRD Items rose from 326 to 522; the DMG's from 129 to 316.
  - A magic item brings its Actions when it is added from a compendium, and takes them when it is deleted.
  - Uses and charges regained in part on a rest: "1d6 + 1 at dawn", "one on a Short Rest" (174 SRD Items).
  - Attunement: an item that needs it gives nothing until attuned, three at most (125 SRD Items).
  - A magic item's Actions need it equipped and, if it needs attunement, attuned.
  - Weapon Mastery moves to G8, with how a character chooses its masteries (maintainer, 2026-10-15).
- **G6, space, first part (2026-10-15).** Done:
  - Cubes and squares are blocks of fields, cast at a point or against the caster's edge; circles are radial.
    "Area shape: cube" fell from 118 documents to 10 (sizes from formulas).
  - Areas with a `self` range (cones, Cubes, emanations from the caster) no longer refuse the creatures they cover.
  - Walls run from a point in range toward a second click for their length: "area shape: wall" fell from 47 to 0.
    What a wall does afterwards stays manual.
  - Forced movement: an Action's push or pull moves each creature it hits, or that fails its save, as forced
    movement that stops at walls and creatures and provokes no Opportunity Attack. 15 SRD Actions convert with it.
    The common Shove can now push as well as knock Prone.
  - Moving a Token with V14's Displace or Blink action is a teleport, no longer refused as a walk.
  - Elevation in combat (2026-10-15): distance is 3D, so range, reach, "within 5 feet" and auras count height. An
    area reaches by its shape (a Sphere both ways, a Cylinder its height up); creatures at another elevation are no
    longer left out of every area. Cylinders and walls convert with their height: the cylinder census row (83) is
    gone.
  - Falling: a creature in the air that gets Prone, or loses its Speed, falls unless it can hover (21 SRD creatures
    hover): 1d6 per 10 feet, and Prone. G6 is done.
- **G5, common traits, first part (2026-10-14).** Done:
  - Magic Resistance, Pack Tactics, Regeneration, Legendary Resistance and Flyby, matched by dnd5e identifier. By the
    trait survey these are 142, 52, 21, 82 and 25 stat-block features across the SRD and the four books.
  - Magic Resistance covers every spell and any Action tagged `magical` (maintainer, 2026-10-14). Regeneration stops
    only for the damage its own text names, and a Troll at 0 dies only if it starts its turn without regenerating.
  - Legendary Resistance asks the creature's controller after a failed save, or follows its Always or Never setting
    on the action bar.
  - Live (two browsers): Player1's Fireball and an SRD Unicorn (asked, then Always). The Unicorn's save against the
    spell rolled `2d20kh`. An SRD Wolf's Bite showed 94% with an ally beside the target and 75% without. An SRD Troll
    regained 10 at the start of its turn. Given the Monster Manual Troll's Regeneration, it fell Unconscious at 0 to
    Player1's Fireball and died at the start of its next turn; at 0 without Fire, it regenerated to 10 and woke. An SRD
    Owl flew out of the Bandit Captain's reach unchallenged; walking out offered the Opportunity Attack.
  - Then the class features: Evasion, Sneak Attack and Extra Attack (with Fighter's Two and Three Extra Attacks).
    Live: a Rogue 5 duelist's second Rapier attack of the turn was paid from Extra Attack's pool and added 3d6 Sneak
    Attack; a third was refused. A creature with Evasion took nothing of a Fireball it saved against, and half of
    one it failed.
  - Sunlight (2026-10-15, maintainer): Scenes and lights tagged "Sunlight". The Daylight spell places its own light,
    tagged as sunlight by default. Sunlight Sensitivity, Weakness and Hypersensitivity, and a Vampire's Regeneration,
    use it. A Vampire's running water is the GM's to track.
  - Not yet, by survey count: Amphibious, Water Breathing and Hold Breath (82, 27, 16: no breathing rules), Spider
    Climb (50: a listed climb Speed is converted, ceilings are not; 3 SRD creatures list none).
- **G4, the monster toolkit (2026-10-14).** Done:
  - Multiattack, monster spellcasting, per-activity uses and Recharge;
  - Action Items' own uses pools now exist. Fire Breath, Second Wind and every "X/Day" Action could not be paid for
    before.
  - Census, documents with the gap:

    | Gap | Before | After |
    | --- | --- | --- |
    | Multiattack | 421 | 80 (summoned spirits whose attack count follows the spell's level) |
    | monster spellcasting (cast activities) | 355 | 35 |
    | Recharge | 324 | 11 |
    | per-activity uses | 204 | 5 |

    Automated Items in the book packages: DMG 83 → 122 (items that cast spells), MM 433 → 472.
  - Live (GM): an Adult Black Dragon from the SRD pack used Multiattack (pool 3), then three Rends at the Bandit
    Captain, each paid from the pool; a fourth was refused. At the start of its turn, its leftover Multiattack uses
    emptied, and Acid Breath recharged on a 5, whispered to the GM.
  - Summons (2026-10-15): "summon activity not automated" fell from 267 documents to 47 (32 SRD Actions summon,
    from Arcane Eye to Summon Dragon). What the creature gains with the spell's level is applied.
  - A summoned spirit's Multiattack by spell level: "Multiattack not automated" fell from 80 documents to 10.
  - Lair Actions (2014): an Action activated "lair" costs a Lair Action, one a round from a pool its lair gives the
    creature (refilled at the start of its turn, not on initiative 20).
  - Multiattack's named attacks (2026-10-15): "shortcut: named attacks not enforced" fell from 515 documents to 11.
    Each named attack has its own count, and each alternative is an Action of its own. Live: an SRD Brown Bear's
    Multiattack filled Bite 1 and Claw 1; a second Bite was refused, and the Claw went through.
  - Its replacements ("it can replace one attack with a use of Spellcasting to cast Acid Arrow") and the Actions it
    uses ("and uses Constrict") are paid from it too: by-hand Multiattacks fell from 167 to 16. Live: an SRD Adult
    Black Dragon made two Rends, then Acid Arrow in place of the third; a fourth attack was refused.
    Legendary Resistance came with G5.
- **G3, effects with their own rules (2026-10-14).** Done:
  - dnd5e effect changes map to rules on custom effects, with their duration, concentration and save policy;
  - dice bonuses (Bless, Bane, Guidance) roll with the d20, for attacks, saves and checks, physical dice included;
  - "up to N creatures" targets one to N.
  - Effect on automated Items:

    | Source | Before | After |
    | --- | --- | --- |
    | SRD | 250 | 292 |
    | PHB | 264 | 319 |
    | DMG | 82 | 83 |
    | MM | 425 | 433 |
    | Tasha's | 65 | 83 |

    "Effect with its own changes" fell from 614 to 405 documents, and unconverted concentration from 587 to 510.
    What is left changes things WildPath does not model yet: AC formulas (Mage Armor), hovering, languages, item
    enchantments.
  - Live: Player1's caster cast the SRD's Bless on itself (Blessed, 1 minute, concentration). Its Fire Bolt then
    rolled "2d20kl + 1d4 + 4".
- **B1.4, area preview (2026-10-14).** Done: while placing an area, the creatures it would hit are outlined, allies
  in amber. Every B1 item now has a first version.
- **B1.6 and B1.8, tooltips and a tidier bar (2026-10-14).** Done:
  - condition and effect icons explain their rules and time left;
  - common actions show as icons, and buttons no longer overlap.
  - Spells grouped by level, magic items' Actions in Items, and a slot button per level (2026-10-15); a greyed
    button says why ("no 3rd-level slot left").
  - Not yet: a roll's breakdown in place on the card.
- **B1.3, movement that warns (2026-10-14).** Done:
  - the dragged Token's label shows the movement left and each Opportunity Attack the path would provoke;
  - verified in Node, Quench (91/91) and two browsers ([ui-ux-layer.md](../architecture/ui-ux-layer.md)).
  - Lasting areas on the path: "Enters Burning Ground" (2026-10-15). Difficult terrain is in Foundry's own cost.
- **B1.4a, common actions (2026-10-14).** Done:
  - Dash, Disengage, Dodge, Hide, Grapple, Shove and Unarmed Strike for every creature, built by the authority
    from their id; Shove: Push and Help (2026-10-15);
  - verified in Node, Quench (91/91) and two browsers
    ([action-definitions.md](../architecture/action-definitions.md#common-actions-2026-10-14-after-baldurs-gate-3)).
- **B1.4b, Opportunity Attacks for every creature (2026-10-14).** Done:
  - each creature's first melee attack, or its Unarmed Strike, when a hostile creature leaves its reach;
  - Disengage prevents it, and the creature's own Always, Ask or Never setting applies;
  - reaction attacks now get advantage, disadvantage and forced critical hits like any attack;
  - verified in Node, Quench (91/91) and two browsers ([reactions.md](../architecture/reactions.md)).
- **B1.5, floating combat text (2026-10-14).** Done:
  - damage, healing, Miss, Critical hit and Saved float over Tokens on every client that may see them;
  - verified in Node, Quench (91/91) and two browsers ([ui-ux-layer.md](../architecture/ui-ux-layer.md)).
  - "Immune" when a condition is ignored, and damage coloured and named by type ("−8 Fire") (2026-10-15).
- **B1.1, odds before acting (2026-10-14).** Done:
  - attack and save odds on the action bar;
  - the `playersSeeOdds` house rule, off by default;
  - `Reveal` effects, which show a creature's defenses to whoever applied them;
  - verified in Node, Quench (91/91) and two browsers ([ui-ux-layer.md](../architecture/ui-ux-layer.md)).
- **B1.2, reactions Always, Ask or Never (2026-10-14).** Done:
  - each reaction's toggle on the action bar is stored on its Item;
  - Always reactions answer their own offer, and Never reactions are not offered at all;
  - verified in Node, Quench (91/91) and two browsers ([reactions.md](../architecture/reactions.md)).

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
6. **G6, space:** cube, cylinder and wall areas with their placement; elevation in combat; forced movement and
   falling (see B2).
7. **G7, weapons, armor and magic items:**
   - versatile damage and +N weapons;
   - armor and AC formulas (Unarmored Defense, natural armor, Mage Armor);
   - attunement and charges, spells cast from items, and potions and scrolls.
8. **G8, character progression** (decided 2026-10-15: the maintainer approved the recommended design; skills,
   training, Heroic Inspiration, Hit Dice (spent on a short rest), class and origin Items, the level-up dialog,
   weapon proficiency and armor training, Weapon Mastery, ability score generation and prepared spells are done):
   - classes, subclasses, species, backgrounds and feats, with level-up from dnd5e advancements;
   - skills and tools with proficiency and expertise;
   - Hit Dice and short-rest healing;
   - Heroic Inspiration;
   - spell preparation;
   - 2024 Weapon Mastery, with how a character chooses its masteries (moved here, maintainer, 2026-10-15).
9. **G9, setting and out-of-combat systems** (design for them, build later): vehicles, Bastions, mythic actions,
   dark gifts, mass combat, roll-table decks, hazards, poisons and diseases, crafting and travel.

Long activations (rituals, minutes) stay manual on purpose: they happen out of combat, and spending the slot is
the useful part.
