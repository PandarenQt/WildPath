# Classes and Spellcasting

Decided by the maintainer on 2026-10-14: class records with full multiclass support, and 2024
spellcasting rules with full and half casters only. Subclasses are planned to start at level 2.

## Class records

Every Actor stores one record per class in `system.classes`. Multiclassing is the normal case.

```js
{id: "paladin", name: "Paladin", level: 3, original: false,
 subclasses: ["oath-a"],                                  // a class may hold several subclasses
 spellcasting: {progression: "half", ability: "presence"}} // progression: none | full | half | third | pact
```

Derived on preparation (`helpers/spellcasting.mts`, `WildPathBaseActor#deriveClasses`):

- **Total level.** The sum of class levels. With class records present, a character's `details.level` is
  derived from them; without any, it stays the stored value.
- **`originalClass`.** The record marked `original` (the level-1 class), else the first.
- **`spellcasting`.** `{casterLevel, ability, slots}`. The ability is the original class's when it casts,
  else the first casting class's. A `spellcasting-modifier` ValueExpression may name a class
  (`{type: "spellcasting-modifier", class: "paladin"}`) to use that class's own ability.

## Character foundation (G8, 2026-10-15)

The maintainer approved the G8 design on 2026-10-15 (gap-roadmap.md, "G8"). The first step adds what a character
is made of, beside its class records:
- **Skills.** `system.skills.<skill>.proficiency`: 0 none, 1 proficient, 2 expertise. The 18 skills and the
  ability each uses are `CONFIG.WILDPATH.SKILLS` (ids are the check domains': `stealth`, `sleight-of-hand`). A
  skill check adds the proficiency bonus once or twice, and uses the skill's own ability unless the check names
  another (`resolveActorCheckStatistic`).
- **Training.** `system.training`: `armor`, `weapons`, `tools`, `masteries` (the weapons whose mastery it uses) and
  `languages` (below),
  lists of names typed on the sheet. Weapon training decides weapon proficiency (`attackProficient`): a weapon
  attack (`attack.weapon`) adds the proficiency bonus only when the training names its category or the weapon
  itself; a creature with no weapon training (a stat block) keeps the attack's own `proficient`. Armor training
  (2024) is checked against a gear Item's `armor` kind (light, medium, heavy, shield): armor worn without it gives
  Disadvantage on attack rolls, saves and checks with Might or Agility (`attack.<ability>` joins an attack's roll-mode
  domains, and a skill check its skill's ability) and blocks casting spells; a Shield worn without it gives no AC.
  A creature with no armor training at all keeps what it wears. Live (GM browser): the QA Fighter in Chain Mail and a
  Shield went from AC 19 to 17 with only light armor training, had Disadvantage on Agility saves and Athletics, rolled
  its Longsword with `2d20kl` (a plain `1d20` once trained again), and its Fire Bolt was refused "while wearing Chain
  Mail without training in it".
- **Heroic Inspiration, as Baldur's Gate 3 keeps it (maintainer, 2026-10-18).** A player character keeps up to 4
  points in its `heroic-inspiration` pool. The sheet and action bar show it, and the GM awards points by editing it.
  It replaced a checkbox, which `WildPathCharacter.migrateData` turns into 1 point; NPCs have none. Human
  Resourceful gives +1 on each Long Rest (a regain-only `GrantResource`). A point rerolls a d20:
  - **A player's character, its own failure:** a missed attack, a failed save or a failed check. Its controller is
    asked, and it pays.
  - **A monster's roll, any outcome:** the GM is asked, and spends the point of a player character with a Token on
    the roll's Scene (the table's). The world setting `inspirationMonsterRerolls` (on by default) turns this off.
  - **How it runs:** in an Action the reroll comes right after the roll, before anything is committed
    (`inspirationReroll` in the pipeline's attack, check and save outcome stages). The question is a choice
    request, and the new d20 has its own roll request. The point is paid in the Action's own transaction, so a
    cancelled Action spends nothing. A rerolled failed save can still use Legendary Resistance. The card shows both
    d20s; the second is the one used.
  - **Sheet rolls:** a check or save rolled from the sheet commits nothing, so its chat card has a "Reroll (Heroic
    Inspiration)" button instead (`applications/inspiration-reroll.mts`). For a monster's roll, the GM picks the
    paying character from those on the viewed Scene. Only the active GM claims a card (the `wildpath.inspirationReroll`
    query, carrying the GM's pick as `payerUuid`; with no GM connected, the card's author on its own client): it
    refuses a card already rerolled or being claimed by any spender (`claimCard`, shared with Portent), marks it, then
    spends the point from what the payer holds then (`serializeActorWrite`). So a player and the GM clicking at once
    reroll once and spend one point (live, 2026-11-13, both rerolled and 2 points went to 1). The query has no timeout:
    a late answer may follow a point already spent, and only that answer lets the clicking client roll.
  - **Live (two browsers, 2026-10-18):**
    - The QA characters' pools appeared at 0/4.
    - Player1's QA Fighter missed the Bandit Captain. Player1 was asked in their own browser and rerolled; the card
      shows both d20s, and the points went 2 → 1.
    - The Captain hit the QA Fighter (24). The GM spent QA Wizard's point, and the reroll (13) missed.
    - A Might save of 7, rolled from Player1's sheet, was rerolled from its card to 15. The old card's button went
      away.
    - Resourceful gave +1 on each long rest, stopping at 4.
    - In a Moonbeam, each monster save asked the GM first.
    - Fixed on the way: the acting creature's own point could not be paid (the commit did not know it), and a
      GM-only question was refused on the GM's own client.
- **Hit Dice.** A class record's `hitDie` (its faces) gives one Hit Die per level, held in a pool per size
  (`hit-die.d10`), created full and recovered on a long rest, like slot pools. A multiclass creature holds several.
  The sheet's Short Rest first asks how many of each to spend (`Actor#spendHitDice`): each heals its roll plus the
  Fortitude modifier, at least 1 (0 under the 2014 rules), rolled in chat; closing the dialog cancels the rest. Live
  (two browsers): the GM spent 2d10 (10, 8) for 22 at Fortitude +2, and Player1 1d10 for 7 on their own character.

**Class, subclass, species and background Items (G8, 2026-10-15).** Four new Item types (`progression.mjs`), each with
an `identifier` and `advancement`, its by-level entries for the level-up dialog. A class also has its `levels`,
`hitDie`, `original` and `spellcasting`; a subclass its `classIdentifier`; a species its `size`. A creature's class
records are rebuilt from its class and subclass Items whenever one is added, changed or removed
(`syncClassRecords`, `classRecordsFromItems`), so levels, slots and Hit Dice follow them. A creature with no such
Items keeps the records it was given. Their sheet shows their fields and what each level gives.
Live (GM browser, after relaunching the world, which is how Foundry learns new Item types and packs): the SRD Fighter
added at level 3 gave level 3 and Hit Dice d10 3/3; level 4 raised both; adding the Champion listed it as its
subclass; deleting the Fighter cleared the records.

**Prepared spells (G8, 2026-10-15).** A spell of 1st level or higher (one that spends a slot) is cast only while
prepared (`system.prepared`, true by default; `preparesSpell`, `isUnprepared` in `helpers/spellcasting.mts`). A spell a
feature or item gave (a subclass's, a wand's) is always prepared, and cantrips need none. The sheet has a Prepared
toggle on each, and counts them against the classes' limit (each class's 2024 table at its level, from dnd5e's
`max-prepared` scale, `spellcasting.prepared`); more than the limit warns, in red, and does not block. An unprepared
spell is not on the action bar (Baldur's Gate 3), and is refused before its slot or area is asked, and by the
authority. Live (Player1's browser): a Wizard 1 with five 1st-level spells showed "Prepared 5 / 4" in red;
unpreparing Sleep made it 4 / 4, took Sleep off the bar and disabled its Use; preparing it again warned. Unprepared,
Sleep was refused at once, and Magic Missile sent straight to the authority was refused with no slot spent.

**Ability scores at creation (G8, 2026-10-15).** A character below level 2 without a background has an "Ability
Scores" button (`applications/ability-scores.mts`): the standard array (15, 14, 13, 12, 10, 8, each placed once), point
buy (27 points, each score 8 to 15, costs from 2024), or six rolls of 4d6 keeping the highest three, rolled in chat
and each placed once. Confirm waits for a legal set. Typing scores on the sheet still works. The background's +2/+1
(or +1/+1/+1) comes after, when it is dropped. Live (Player1's browser): point buy refused 29 points and a 16 and
took 27; the rolls 14, 15, 10, 6, 10, 16 were placed; the array was valid as dealt, refused a duplicate, and took a
swap; the Acolyte then added Intellect +2 and Wits +1, and the button went away.

**Weapon Mastery (G8, 2026-10-15).** A weapon attack by a creature whose `training.masteries` lists that weapon uses
its mastery (`helpers/weapon-mastery.mts`), applied automatically:
- **Push:** a hit Large or smaller creature is pushed 10 feet away (forced movement).
- **Slow:** a hit creature's Speed is 10 feet lower until the start of your next turn; more hits do not stack.
- **Sap:** a hit creature has Disadvantage on its next attack roll before the start of your next turn.
- **Vex:** your next attack roll against a creature you hit has Advantage, before the end of your next turn; it is
  yours alone (`attack.fromAttacker`), and spent by that attack, hit or miss.
- **Topple:** a hit creature makes a Fortitude save (DC 8 + the attack's ability modifier + Proficiency Bonus) or
  has the Prone condition, as its own Action after the attack (`foundry-v14-weapon-mastery.mts`).
- **Graze:** a missed creature takes damage equal to the attack's ability modifier, of the weapon's type, as its
  own Action.
- **Cleave and Nick** are extra attacks: the player makes them.
- The attack's chat card now comes before its follow-ups' cards (a Topple, a Graze, a fall, a death save).

Live (two browsers): the QA Fighter (Might 16, level 6) Sapped the Bandit Captain with a Longsword, and the
Captain's Scimitar then rolled `2d20kl` and Sapped ended. A Rapier hit Vexed it; the Fighter's next attack rolled
`2d20kh` and spent it, while the QA Caster's Fire Bolt neither had the Advantage nor spent it. A Greatsword miss
grazed it for 3, a Maul hit toppled it (DC 14, 13 failed), a Club hit slowed it from 30 to 20 feet (twice: still 20),
and a Warhammer pushed it 10 feet. Player1's Rapier, clicked on the action bar, Vexed it from their own browser.

**Level up (G8, 2026-10-15).** A BG3-style dialog (`applications/level-up.mts`, rules in `helpers/level-up.mts`) asks
only what one level asks, and adds what it grants:
- **When.** Dropping a class, species or background on a character's sheet opens it (a class at its first level); a
  "Level up <class>" button per class (below level 20) opens the next level. Closing it changes nothing.
- **What it shows.** That level's entries from the class and its subclass, or the species' or background's: features
  granted (listed), choices of features, skills, training and Weapon Mastery (checkboxes; what the creature already
  has is not offered; Expertise in a skill not yet proficient waits until this dialog grants or picks the skill), an Ability Score Improvement (points to spend, or a feat from the compendiums' origin and
  general feats, Epic Boons from level 19), the subclass (from every Item compendium, by class identifier) and a
  species' size. Confirm stays disabled until every count and every point is met.
- **A species' or background's later levels (2026-10-31).** Their levels are the character level, not a class's
  (`stepsForLevel`, `ORIGIN_TYPES`): a class level that makes the character Nth level also asks and grants the
  species' and background's Nth-level steps (an Abyssal Tiefling's Poison Spray at 1st, Ray of Sickness at 3rd, Hold
  Person at 5th; a Dragonborn's flight at 5th). A species added to a character that already has levels brings every
  level of it up to theirs. What those steps grant is the species' (`grantedBy`), so it goes when the species goes.
  Until then only their level-0 steps ran. Live (14.369): a new character took Tiefling, Abyssal, then Fighter 1, and
  received Poison Spray from the species. Characters made before this keep what they had; drop the species again
  to add what it missed.
- **What it does.** The class's `levels` goes up; hit points rise by the Hit Die's maximum at a character's first
  level, else its average rounded up, plus the Fortitude modifier (the `rollHitPoints` world setting rolls the die
  instead, with the roll in chat); one more Hit Die is available. Skills, saves and training are recorded on the class,
  subclass, species or background that gave them (see "Training from its sources" below), ability
  scores raised (20 at most), the features created from their compendium as given by the class (so they go when it
  goes), and a chosen subclass is added with its own features for that level.
- **Multiclassing** (a class beside another) uses the class's multiclass proficiencies and the average hit points,
  and warns, without blocking, when either class's primary abilities are below 13.
- **Hit points follow Fortitude (2026-10-21).** The health base records the Fortitude modifier it counts for each level
  (`resources.health.perLevelFortitude`); the maximum counts the current one instead, times the character's level. So a
  later increase (an ability score step, a feat, an Amulet of Health while worn) raises every level's hit points, and a
  decrease lowers them. A level gained after a change first brings the base to the new modifier. Characters built
  before this record their stored Fortitude's (world migration 3); hit points typed by hand count nothing.
  Live: a Fighter at Fortitude 14 had 12, then 20; Fortitude 16 made it 22; level 3 made it 31; an Amulet of Health
  (Fortitude 19) made it 34, and taking it off 31.
- Shortcuts: removing a class does not take back its hit points or ability increases; a subclass dropped directly gets no dialog; spells a feature chooses
  (Magic Initiate, a spellbook) are not asked.

Live (two browsers, SRD 5.2): the Fighter dropped on a new character gave 12 hit points (d10 + 2), Might and
Fortitude saves, the two chosen skills, armor and weapon training, three chosen masteries, Fighting Style (Defense
chosen), Second Wind with its pool, and Weapon Mastery. Levels 2 to 4 from the button gave +8 each, Hit Dice 4/4,
Action Surge, the Champion with Improved Critical and Remarkable Athlete without a second dialog, Might and Fortitude
+1, and a fourth mastery (Longsword, already taken, not offered). The Human (Medium; Stealth; Alert) and the Acolyte
(Wits +2, Presence +1; Insight, Religion, calligrapher's tools; Magic Initiate) followed. A Wizard beside it warned
"short for Wizard", gave +6 and a d6 Hit Die and two 1st-level slots, and took its features with it when deleted.
Player1 leveled to 5 from their own browser (Extra Attack, Hit Dice 5/5); with `rollHitPoints` on, level 6 rolled
6 + 2 in chat and took Grappler instead of an increase.

Live (two browsers): a Fighter 3 had "Hit Dice (d10) 3/3". Player1 set its Stealth to Expertise on the sheet (+2 to
+6) and typed its armor training.

## Replacing a choice at level-up (2026-10-20)

Some classes let a later level swap an earlier pick: a Fighter's Fighting Style, a Warlock's Invocations, Tasha's
infusions (any artificer level from 3rd). The converter keeps those levels (`count: 0, replacement: true`), where it
used to drop every level without a new pick.
- **The dialog.** A choice step lists only options its creature doesn't have (`choiceOptions`). It also offers to
  replace one it has, an active Item from that pool by compendium source. Replacing one allows one more pick, and an
  option checked in one step is greyed in the others.
- **Applying it.** The replaced Item stays, set inactive, with `flags.wildpath.replaced {atLevel, by}`. Its rules,
  training and granted Actions stop; the authority refuses an inactive Action, and an inactive Metamagic option is no
  longer known. Switching it back on restores it.

Live (14.369): QA Fighter (Champion) at level 7 replaced Defense with Archery and took Great Weapon Fighting as its
Additional Fighting Style; Archery was greyed in that second step. Defense was then inactive, with AC 18 instead
of 19. Turning it back on gave 19.

## Prerequisites (2026-10-20)

Feats, Invocations, Maneuvers, Metamagic options and infusions carry `flags.wildpath.prerequisites`, from dnd5e's
`prerequisites` and its `requirements` text (`prerequisitesOf`).

| Field | Example |
| --- | --- |
| `level` | A feat's character level, or a class option's class level. |
| `items` | Identifiers: "fighting-style", "pact-of-the-blade". |
| `abilities` | Any of them at their minimum: "Strength or Dexterity 13+". |
| `training` | "Heavy Armor Training", a martial weapon. |
| `spellcasting` | "Spellcasting or Pact Magic". |
| `classLevel` | "Warlock 5". |
| `repeatable` | It may be taken again. |
| `text` | Anything else. It isn't checked; the option shows it beside its name. |

The level-up dialog offers a feat, or a choice's option, only when its creature meets them (`unmetPrerequisites`), and
not one it already has unless repeatable. It knows what the creature has by identifier, or by name as a slug for Items
converted before identifiers were kept.

Live (14.369): with its own Grappler switched off, QA Fighter's level 8 offered Grappler at Strength 16 and Dexterity
13; at 10 and 10 it didn't. With Grappler on, it isn't offered again.

## Feats that give another class's options (2026-10-20)

A feature may carry `advancement` (`WildPathFeature`, additive), choices at level 0 that the level-up dialog asks once
the feat is added. A choice may name a pool by kind (`pool: {subtype}`): any option whose source subtype matches,
gated by sources and prerequisites, and at class level 0. Tasha's feats, through the converter's `FEAT_ADVANCEMENT`:
- **Eldritch Adept:** one Invocation, among those with no Warlock-level prerequisite.
- **Fighting Initiate:** one Fighting Style.
- **Metamagic Adept:** two Metamagic options, and `GrantResource` +2 Sorcery Points. Grants on one pool add up, so a
  sorcerer's points grow by 2.
- **Magic Initiate (2024, 2026-10-31):** two cantrips and one level 1 spell (`pool: {spellLists, spellLevel}`: any spell
  of that level on the Cleric, Druid or Wizard list, as dnd5e offers them; one option per spell, its Items together, by
  `metadata.spellLists`). The spells it gives are always prepared (`grantedBy`) and cast with the best of Intelligence,
  Wisdom and Charisma (`flags.wildpath.castingAbilities` on the feat; `withGrantedCastingAbility` pins the spell attack
  and every unnamed spellcasting modifier). Its level 1 spell is cast once per Long Rest from `free-cast.magic-initiate`
  (`freeCast.granted`), each copy of the feat its own (`free-cast.magic-initiate.{item}`: a GrantResource id may name its
  Item). shortcut: the same-list rule is not enforced.
- **Resilient and Elemental Adept (2024, 2026-10-31):** a trait choice at level 0. Resilient's is a saving throw
  proficiency (`saves:<ability>`). Elemental Adept's is its Energy Mastery type, recorded as `adept:<type>`, a plain
  recorded choice its own rules read (`{training:adept}`, rule-elements.md "Recorded choices in rules"): its spells' dice
  of that type count a 1 as a 2 (`DamageDieMinimum`) and ignore Resistance to it (an `ignore-resistance` RollOutcome).
  shortcut: every feat's +1 to an ability is by hand.
- shortcut: Artificer Initiate's cantrip, spell and tool are taken by hand.

Live (14.369): the converted Eldritch Adept on QA Caster offered Armor of Shadows, Eldritch Mind and the Pacts. None
needing Warlock levels was offered. Armor of Shadows was added.

## Spellcasting progression (2024)

- **Caster level.** Every level in a full-caster class, plus half the levels in each half-caster class,
  rounded up per class. A level-1 Paladin is caster level 1, and Wizard 3 + Paladin 3 is caster level 5. The Artificer
  is a half caster (it rounds up).
- **Third casters (2026-10-21).** The Eldritch Knight and Arcane Trickster cast through their subclass: the subclass
  Item carries `spellcasting` (`third`, Intellect, its prepared table), and a class with none of its own takes its
  subclass's (`effectiveSpellcasting`), in its class record and its prepared limit. A third of its levels count,
  rounded down, beside another casting class; alone it uses its own table, a third rounded up from 3rd level. Live: a
  Fighter 7 with the Eldritch Knight had caster level 3, four 1st- and two 2nd-level slots.
- **Slots.** Spell slots per spell level come from the 2024 multiclass spellcaster table at that caster
  level. They are held in the existing `spell-slot.<n>` pools, which Actions already pay with.
- **Pool maxima.** A slot pool's maximum adds the table's count to its own base, bonus and modifiers.
- **New pools.** When an Actor is created with class records, or its classes change, any slot pool a
  newly reached spell level needs is created full, with long-rest recovery.
- **One writer (2026-10-20).** An Actor stores what its Items and effects make of it itself, once per batch of changes
  (`WildPathActor#syncItemRecords`, from its descendant-document hooks): its class records when a class or subclass
  changed (with their pools), then the pools its grants newly need, sized at the new level and full. Syncs run one after
  another, so adding a class and a pool-granting feature in one call keeps every pool, and a level-up reads the pools
  only once they are stored (`recordsSettled`). The Actor's own pool writes (rests, Hit Dice, turn start, Recharge, the
  Lair Action refill, `spendResource(s)`) go through `WildPathActor#updatePools`, which joins the same queue and reads the
  stored pools only when its turn comes: it lands after every sync already started on the same client and before any
  started meanwhile, so a pool a just-created effect grants survives a rest or turn start begun on that client before its
  sync landed. The queue is per client and per Actor object: a turn start on the GM's client does not wait for a sync a
  player's client is still writing, nor a Token Actor's for its base Actor's. Live: Player1 added a Warlock 5 and Fire's Burn in one call; QA Caster
  had Pact Magic slots 2/2, Hit Dice (d8) 5/5 and Fire's Burn 3/3. A Wizard levelled from 1 to 2 had Hit Dice 2/2.
- **Pact Magic (2026-10-20).** A class with the `pact` progression (the Warlock) has its own slots, apart from the
  caster level: one `spell-slot.pact` pool (1 slot, 2 from level 2, 3 from 11, 4 from 17) recovered on a Short Rest,
  all of one level, half its class levels rounded up and at most 5 (`pactMagic`). The pool pays for a slot of any level
  up to its own (`paymentCapabilities` `spell-slot.1` to `spell-slot.<level>`), so every spell's slot choice offers it
  once, and the spell is cast at the pool's level (its `castingLevel`), upcast like any slot.
  - **Magical Cunning** restores `spell-slot.pact` by half its maximum rounded up, all of it at Warlock level 20
    (Eldritch Master); it is refused while none is spent. shortcut: its 1-minute rite is not timed.
  - **Spell choices (`flags.wildpath.spellChoice`, 2026-10-31).** A feature that lets its creature mark spells carries
    `{flag, levels, count?, costs?, resourceId?}` (spellcasting.mts `spellChoiceOf`). A spell is marked by its own
    `flags.wildpath.<flag>`: `true` with `count` 1 (the default; one spell a level), or its number 1 to `count`. It fits
    when its level is in `levels` and it costs every capability in `costs`. A marked spell that fits gains a branch on its
    slot choice at its own level (`withSpellChoices`, as the authority builds its definition): paid from `resourceId`
    (`{n}` the mark's number, `{level}` the spell's level) while its creature has that pool, or, without a `resourceId`,
    free (`metadata.freeCastLevel`). While its feature is active a marked spell is never counted as prepared
    (`preparesSpell`); without the feature the mark does nothing. The sheet shows a toggle named after the feature on
    each spell that fits (a pool-backed one only while that pool has a maximum above 0); count 1 unmarks the other spell
    of that level, a higher count takes the lowest free number or warns that all are taken (`spellChoiceToggle`).
    `flag` may not be one the system writes or reads on Items (`RESERVED_SPELL_FLAGS`: `grantedBy`, `source`,
    `training`, `freeCast`, `conversion`, `replaced`, `reactionPolicy`, `buildCost`, `spellChoice`, and the flags read
    from any active Item, such as `damageTwice`, `ignoresResistance`, `slotRecall`, `choiceFor`, so a marked spell never
    becomes that feature). Such a choice, or one with no levels or a bad count, fails explicitly at the boundary: an edit
    storing it is refused with its problem in words (`refuseBrokenSpellChoice`, Item `_preUpdate`), and on a stored or
    imported Item it is skipped where spells are read (`spellChoices`) and its feature is named on the actor sheet's
    broken-rules line (`spellChoiceProblem`), so the sheet still opens to fix it. The spells' marks are play data (pack-refresh KEPT_FLAGS keeps `arcanum`,
    `mastered`, `signature`; a homebrew flag is not refreshed onto a spell, which no pack copy carries anyway).
    - **Mystic Arcanum** gives a pool per spell level 6 to 9 (Warlock levels 11, 13, 15 and 17), recovered on a Long
      Rest: `{flag: "arcanum", levels: [6, 7, 8, 9], resourceId: "mystic-arcanum.{level}"}`. Live (before the shape was
      data): a Warlock 11 marked Disintegrate (then Eyebite, which unmarked it, then Disintegrate again) and cast it from
      the arcanum (1/1 to 0/1); Eyebite stayed unavailable, its pact slots being level 5.
    - **Spell Mastery (wizard 18)**: `{flag: "mastered", levels: [1, 2], costs: ["action"]}`, free at the spell's level.
    - **Signature Spells (wizard 20)**: `{flag: "signature", levels: [3], count: 2, resourceId: "signature-spell.{n}"}`,
      each from its own pool (1, Short or Long Rest; GrantResource rules on the feature).
  - **A feature's free cast (2026-10-31).** A feature with `flags.wildpath.freeCast: {spells, resourceId}` and that pool
    (a GrantResource on it) gives the named spells' slot choice one more branch, paid from the pool at the spell's own
    level (`withFreeCasts`). Faithful Steed: Find Steed once per Long Rest (`free-cast.faithful-steed`); its paladin class
    grants the spell, so it is always prepared.
    `fromFeatures: [<identifier>]` names the spells the features with those identifiers gave instead (the spell's
    `grantedBy` Item's identifier).
  - **A choice at each Long Rest that gives Items (2026-11-01, Q9).** An Action's `grantItems: {choiceId, class?,
    options: {<value>: {<level>: [uuid, ...]}}}` (action-definitions; runtime `grantChosenItems`, once it completes):
    the creature gets the rows of the option its `choiceId` choice picked up to its `class` level (every row without
    one), as compendium copies granted by the feature whose Trigger the Action is (or the Action Item), so they go with
    it and its spells are always prepared. What the other options gave before goes; what the chosen one gives already
    stays. 2024 Circle of the Land Spells: a `rest.completed` Trigger on `longRest` asks the land (Arid, Polar,
    Temperate, Tropical Land); the converter reads each land's table from the feature's description (its linked spells,
    by druid level), and the drivers map them to the Items they became (`mapGrantItems`). A druid 5 choosing Polar has
    Fog Cloud, Hold Person, Ray of Frost and Sleet Storm; Arid at the next Long Rest swaps them for Blur, Burning Hands,
    Fire Bolt and Fireball. 2024 Natural Recovery: `freeCast: {fromFeatures: ["circle-of-the-land-spells"]}` with
    `free-cast.natural-recovery` (1, Long Rest), so one level 1+ Circle Spell casts once without a slot, at its own
    level; another spell does not. The feature keeps the land chosen (`flags.wildpath.grantChoice.<choiceId>`), so the
    level-up dialog adds a new druid level's row at once (`grantItemsFor`), and asks the land when the feature first comes
    (a druid made at level 3 or higher, or one just taking the Circle); dnd5e's GM notes on both features go
    (`AUTOMATED_NOTES`).
- **The pool chosen pays.** A resource choice's option is paid from the pool it named (`resourceId` on the requirement),
  not from another pool with the same capability: Pact Magic slots chosen are not swapped for a level-1 slot.

The ruleset lives in one module (`helpers/spellcasting.mts`), so another ruleset replaces that module
rather than branching inside callers (AGENTS §10).

Live (Quench, 14.369): a Wizard 3 / Paladin 3 is level 6 with the Wizard as its original class. It is
caster level 5, with slot pools of 4, 3 and 2 created full. Adding Paladin levels and a Cleric level
raised it to caster level 7 and added the level-4 slot pool.

Live (two browsers, 14.369): QA Caster as a Warlock 5 had "Pact Magic slots" 2/2 (Short Rest). Player1's Hex offered a
level-1 slot, a level-2 slot and Pact Magic slots once; the pact slot paid (2 to 1). Magical Cunning brought it back to
2/2 and spent its use; with both spent, a Short Rest refilled them and left the level-1 slot and Magical Cunning spent.
A Wizard 3 beside it was caster level 3 with its own slots, the pact slots unchanged.

## Transformations

Approved by the maintainer on 2026-10-14. The creature keeps its feats, the properties of the items that
still apply, and similar.

`WildPathActor#transform(form, {takes, keepItemTypes})` takes a form, which is another Actor's stat
block:

- **Statistics from the form.** The form provides the statistics listed in `takes`. The default is Wild
  Shape's: the physical abilities (Might, Agility, Fortitude), Armor Class and speed. Each is read from
  the form's own data in preparation, so modifiers still apply on top.
- **What the creature keeps.** Its own Items of the kept types (features and gear by default) keep
  contributing: its feats and the properties of its gear. A policy can narrow this, for example
  `keepItemTypes: ["feature"]` when gear melds into the form.
- **What the form adds.** Copies of the form's features and Actions are added while transformed, so its
  attacks are usable through the normal Action runtime.
- **The effect.** It is an ordinary effect, "Transformed: <form>", whose `flags.wildpath.transformation`
  holds the policy.
- **Ending it.** `revertTransformation()` removes the effect and the copies. Deleting the effect directly
  removes the copies too.
- **What does not change.** Health is not replaced. 2024 Wild Shape and Polymorph grant temporary hit
  points instead, which is a separate effect.

- **Token size.** The creature's Tokens on every Scene take the form's size (its prototype Token's width and
  height), and reverting restores each one's own. A resize is a V14 `displace` movement, which the movement
  authority approves as a pure resize without cost.
- **From an Action** (2026-10-14). An ActionDefinition's `transform` names exactly one of:
  - `formRef`, a fixed form;
  - `choiceId`, a configuration choice whose options are the forms. Wild Shape is a `select-one` choice of
    form uuids, and the authority holds the answer to those options.
  - `revert: true`.

  When the Action completes, the GM applies it to the Action's creature (`applyActionTransformation`).

```js
{transform: {choiceId: "form"}, costs: {allOf: [{capability: "bonus-action", amount: 1}]},
 configuration: [{id: "form", type: "select-one", label: "Form", required: true,
   options: [{id: "Actor.bear", label: "Bear"}, {id: "Actor.wolf", label: "Wolf"}]}]}
```

Live (two browsers, 14.369): Player1's druid used Wild Shape and picked Bear in the configuration dialog. The
druid took Might 19, its Token became 2×2 and the Bonus Action was spent. A Revert Action restored Might 8 and
the 1×1 Token.

- **No spellcasting (2024 Wild Shape and Polymorph).** While transformed, the creature can't use an Action
  tagged `spell`, and the authority refuses it. Spells it cast before go on: their lasting areas run as
  authority Actions, which are not refused. Live (GM browser, 14.369): a transformed druid's spell was
  refused with "A transformed creature can't cast spells.", and its other Action and the same spell after
  reverting went through.

- **Within its level's limits (2026-10-19, Wild Shape's transformation by the 2014 rules, the maintainer's choice).** `limits: {class, rows:
  {level: {cr, fly, swim}}}` caps the form by that class's level: the row at or below it gives the highest Challenge
  Rating and whether a Fly or Swim Speed (a `GrantMovement` rule on the form) is allowed; a row without `swim` allows it.
  A form beyond them is refused when the Action is used, before anything is paid (`formBeyondLimits`). With
  `temporaryHealth: "form"` the creature gains the form's Hit Points as Temporary Hit Points and reverts once they are
  gone; damage beyond them reaches its own Hit Points, which is the 2014 carry-over. Reverting clears what is left.
  Live (two browsers, 14.369): Player1's level-2 druid was refused a Constrictor Snake ("has a Swim Speed, not allowed at
  druid level 2") with nothing spent; a Wolf (then an Action; Wild Shape is a Bonus Action again since) took a use, gave 11 Temporary Hit Points and
  Might 14 while its Intellect 16 stayed, a Short Rest refilled both uses, and Wild Shape (Revert) restored Might 10.
- **Its hours and its own Hit Points (2026-10-21).** `duration: {class, perLevel, units}` gives the form a duration,
  a share of that class's level rounded down (Wild Shape: half the druid level, in hours); V14 expires it and the
  creature reverts. Healing in a `temporaryHealth: "form"` form heals the form (its Temporary Hit Points) up to the
  form's Hit Points (`formHealth` on the transformation, in the creature's snapshot), not the druid's own. Live: a
  Wolf form lasted 2 hours with 11 Hit Points, and its expiry reverted it, its copies and its Hit Points gone. The
  maintainer's rules choice stays: every eligible Beast is offered; that the druid has seen it is the player's to keep.

- **On its targets (2026-10-19, 2024 Polymorph).** A `transform` with `targets: true` transforms each creature that
  failed the Action's save, not its user. The form must not have a Challenge Rating above the creature's own (or its
  level); otherwise the GM is told and nothing changes. With `temporaryHealth: "form"` the creature gains the form's
  Hit Points as Temporary Hit Points, and the transformation ends once they are gone (any left vanish when it ends).
  With `concentration: true` the transformation effect names its caster's Token, so it ends with that concentration
  (`sustainedEffects`), and casting it starts concentration. Polymorph takes all six abilities, AC and Speed, and keeps
  none of the creature's own Items.
  Live (two browsers): Player1's QA Caster used the Wand of Polymorph on the Bandit Captain and chose Brown Bear (CR 1)
  from 92 SRD Beasts. On a failed save the Captain became 2×2 with Might 17, Wits 13, AC 11, 22 Temporary Hit Points
  and the Bear's Multiattack, Bite and Claw. Its Temporary Hit Points reaching 0 reverted it; so did the caster's
  next concentration spell (Bless), which also cleared the Temporary Hit Points left. The wand's charge went 7 to 6.

- **Its user's own form, keeping its spellcasting (2026-11-07, 2024 Shapechange).** `keepsSpellcasting: true` is kept on the
  transformation and lifts the "transformed can't cast spells" refusal. A feature the creature keeps in its form can lift
  that refusal for some spells instead (an `Allow` rule, rule-elements.md: 2024 Beast Spells, but for costly Material
  components). `limits: {challenge: "self"}` refuses, before
  anything is paid, a form whose Challenge Rating is above its user's level (else its Challenge Rating). On its user
  (no `targets`), `concentration: true` names the user's Token, so the form ends with that concentration, and
  `duration: {value, units}` without a `class` is a fixed duration (Shapechange's hour). With `temporaryHealth: "form"`
  and `untilTemporaryHealthLost: false` the form's Hit Points come as Temporary Hit Points that vanish when it ends
  (`temporaryHealthVanishes` on the transformation, the amount given; a larger pool, kept or gained in the form, is
  another source's and stays) but whose loss does not end it. The converter's `SELF_TRANSFORM`
  table offers every converted creature but a Construct or an Undead (a stat block without a creature type of its own,
  an Arcane Eye, is no form). A stat block's copy reads its limit: "Beast or Humanoid form only" keeps those types,
  "no Temporary Hit Points" and "no Concentration" drop them (the metallic dragons, the Couatl, the Deva). By hand:
  shape-shifting into another form with a Magic action is a recast (a slot for a caster with slots); having seen the
  creature and whether equipment falls or melds are the player's to keep, as with Wild Shape. Nothing checked in live
  Foundry yet.

Not yet:

- True Polymorph (an object, a creature into an object, permanence) and what a creature may do in its form (speech).

Live (two browsers, 14.369): Player1 turned their Shifter into a Bear, which gave Might 18 and AC 13, and
used the copied Bite through the GM's authority. The goblin went from 20 to 15, the Action was spent and a
card posted. Reverting restored Might 8 and removed the Bite. In Quench, the creature's own +1 AC feat kept
counting on the form's AC, and its own Intellect stayed.

## Trading one pool for another (2026-10-19)

The converter reads dnd5e's consumption targets generically (`consumptionDefinition`):
- **What it spends** is a cost on the pool each target names: the item's own, or another feature's by its name. Dragon
  Wings' Restore Use costs 3 Sorcery Points, not 3 of its own uses.
- **What it gives back** becomes `restores`, refused while full. A formula is worked out for the creature
  (`amountExpression`).
- **A spell slot it spends** is a slot choice from that level up. A target scaled with it gives back the slot's level
  (Regain Sorcery Points).
- **A spell slot it gives back by level** is a choice of level, each option costing what its scaled targets say at that
  level. Font of Magic's 2/3/5/6/7 comes from dnd5e's own formula, which replaces the hand-written table.

An activity that trades one pool for another, all of it converted, is an Action even though dnd5e leaves it passive.
This covers:
- Font of Inspiration's Recharge with Spell Slot;
- Wild Resurgence, both ways;
- Recharge with Rage;
- Restore Use for Dragon Wings and Holy Nimbus;
- Regain Use for Hurl Through Hell and Clairvoyant Combatant, spending a Pact Magic slot;
- Sorcery Incarnate;
- Sorcerous Restoration;
- Pearl of Power;
- Font of Magic.

A Pact Magic slot target (`attribute` `spells.pact.value`) is the `spell-slot.pact` pool: spent as a cost, or given back
as a restore (a Rod of the Pact Keeper's Regain Spell Slot). Its text's "without expending a spell slot" (Pact of the
Chain) still spends nothing, and Magical Cunning's half of its slots back stays its own restore. Rolled give-backs (Bag of Beans), amounts chosen when used (Ioun Stone of Reserve) and a spell's own
bookkeeping uses stay notes. Arcane Recovery and Natural Recovery stay manual. Live (two browsers, 14.369): QA Caster
with Wild Resurgence and 0 of 2 Wild Shape used Regain Wild Shape twice, each spending a level-1 slot. The third use, with
Wild Shape full, was refused (`RESOURCE_FULL`).

## Recharges when Initiative is rolled (2026-10-19)

An activity used "when you roll Initiative" that gives a pool back converts to an automatic `Trigger` on its feature
(`initiativeTrigger`): kind `automation`, event `initiative.rolled`, with an inline Action of its costs and restores.
Its predicate requires a pool it gives back below its maximum (`poolBelowMax`) and its own uses not spent
(`not: {poolEmpty}`). It covers:
- **Persistent Rage:** all Rage, once per Long Rest;
- **Uncanny Metabolism:** all Focus Points and a heal of Martial Arts die + monk level, once per Long Rest;
- **Archdruid:** one Wild Shape use.

Persistent Rage's "@scale.barbarian.rage" names the class's `rages` table (`SCALE_ALIASES`).

**"You can" (2026-10-20).** Its Action has a required choice `use`: "Use it" or "Not now" (the configuration effect
`decline`: no restores, healing, damage, effects or costs). The dispatcher reads its Item's reaction setting:
- Never: not used.
- Always: used without asking (`configuration: {choices: {use: "use"}}`).
- Ask (the default): the authority asks its controller.

Live (two browsers, 14.369): QA Caster with Persistent Rage and 0 Rage rolled initiative. Player1 was asked; "Not now"
spent nothing, and "Use it" spent Persistent Rage's use.

Live (two browsers, 14.369): QA Caster as a level-15 barbarian with 0 of 5 Rage rolled initiative, and Rage went to 5
while Persistent Rage's use was spent. In a second combat, with Rage at 0 again, nothing happened.

## Monk: Martial Arts, Flurry of Blows, Open Hand Technique (2026-10-20)

- **Martial Arts** brings three Unarmed Strikes (`flags.wildpath.grants`; the class grants the feature alone). Each is
  the common Unarmed Strike with the `finesse` property (the better of Might and Agility) and the Martial Arts die (a
  table by monk level). They differ in cost:
  - "Unarmed Strike": the Action, payable from Extra Attack;
  - "Bonus Unarmed Strike": a Bonus Action;
  - "Flurry of Blows Strike": one use of the `flurry-of-blows` pool, tagged `flurry`.
- **Flurry of Blows** costs a Bonus Action and 1 Focus Point, and restores that pool: 2 strikes, 3 from monk level 10.
  The pool starts empty and empties at the start of each turn.
- **Open Hand Technique:** a hit of a strike tagged `flurry` offers Addle, Push or Topple (`OWN_HIT`), one per hit:
  - Addle: the `no-opportunity-attacks` status;
  - Push: a Strength save, or pushed 15 ft;
  - Topple: a Dexterity save, or Prone.
- **Converter:** the Barbarian's and Monk's unlicensed Unarmed Strike grants are dropped without a note; every creature
  has the common Unarmed Strike.
- **Heightened Focus (monk 10).** Flurry's third strike and Patient Defense's Temporary Hit Points are rows of Monk's
  Focus's Actions. Its carrying Step of the Wind is an Action of its own, "Heightened Focus (Step of the Wind)" (a Bonus
  Action and a Focus Point): the monk is Disengaged and Dashing (`appliesTo: "source"`), and one creature within 5 ft,
  Large or smaller, is Carried until the end of the monk's turn. The active GM walks a Carried creature along its
  carrier's moves ([movement paths](movement-paths.md#carrying-a-creature-2026-10-31)).
- **shortcuts:** monk weapons keep their own die and ability. Step of the Wind's doubled jump distance is by hand, as
  is Push's Size limit.
- **Live (two browsers, 14.369):** QA Caster as monk 5 used Flurry of Blows (Bonus Action, Focus 5 to 4, 2 strikes).
  A Flurry strike hit the Bandit Captain for 1d8. Open Hand offered Addle, Push and Topple, and Player1 chose Topple;
  the Captain saved.

## Extra weapon damage (2026-10-20)

- **Colossus Slayer (Hunter's Prey):** an `ExtraDamage` of 1d8 on `damage.weapon`, once a turn, while
  `attack.targetDamaged` (a new attack fact: the target is missing Hit Points). shortcut: Horde Breaker is by hand.
- **Frenzy:** an `ExtraDamage` of its Rage Damage in d6s on `damage.weapon`, once a turn, for a Might attack while
  `raging` and `reckless`. Rage's effect is now the `raging` status.
- Divine Strike, Primal Strike and Lifedrinker are own-hit offers (reactions.md).

## Spell damage and healing riders (2026-10-20)

A converted spell's tags say what it is:
- `cantrip` at level 0;
- `school:<name>` (dnd5e's `evo` becomes `school:evocation`);
- `damage:<type>` for each damage type it deals.

Its creature's rules read these tags:
- **Potent Spellcasting** (cleric, druid): Wisdom on `damage.spell` for `cantrip`. shortcut: any cantrip, not only its
  class's.
- **Improved Blessed Strikes** (cleric 14) with Potent Spellcasting: after a cantrip's damage, Temporary Hit Points of
  twice its Wisdom modifier to itself or a creature within 60 ft, picked as it is used (reactions.md, "A reaction's
  target chosen as it is used").
- **Empowered Evocation:** Intelligence on `damage.spell` for `school:evocation`, on one damage roll of the spell
  (`metadata.oneRoll`: the first hit's of Scorching Ray's rays, action-definitions.md "Repeatable targets").
- **Elemental Affinity:** an Action, used once, chooses Acid, Cold, Fire, Lightning or Poison. That type is a lasting
  effect: Resistance to it, and Charisma on `damage.spell` for `damage:<type>`, on one damage roll (`metadata.oneRoll`).
  shortcut: the choice is not tied to the
  Draconic ancestry.
- **Disciple of Life:** 2 + the slot's level on `healing.spell`, only when a slot was spent (rule-elements.md, "Healing
  and context"). shortcut: Blessed Healer's self-heal is by hand.
- **Overchannel (2026-11-01):** a choice on its wizard's spells of level 1+ that deal damage (`choiceFor.spell`), cast
  with a slot of level 1 to 5: the spell deals its maximum damage, and a use of its `overchannel` pool (20, back on a
  Long Rest) is spent. The first use since a Long Rest is free; each later one deals the wizard Necrotic damage that
  ignores Resistance and Immunity: 2d12 a slot level on the second use, 3d12 on the third, and so on
  (action-configuration.md, "Overchannel's effects"; action-resolution.md, "Damage to its own source").

Live (two browsers, 14.369): QA Caster with Wisdom 16, Potent Spellcasting and Disciple of Life. Player1's level-2 Cure
Wounds rolled "2d8 + 2d8 + 7": its Intelligence +3, plus 2 + 2. Sacred Flame on the Bandit Captain rolled "2d8 + 3".
With Empowered Evocation, Fire Bolt rolled "2d10 + 3" (Intelligence 16). After Elemental Affinity (Fire), with Presence
14, QA Caster had fire Resistance and Fire Bolt rolled "2d10 + 5".

## Training from its sources (2026-10-20)

A creature loses a skill, save, training or Weapon Mastery when it loses what gave it (the maintainer's rule). Each
source Item lists what it gives in `flags.wildpath.training`, as trait keys (`skills:x`, `expertise:x`, `saves:x`,
`armor:x`, `weapons:x`, `tools:x`, `masteries:x`):
- **Level-up** writes a step's grants and picks on the Item the step comes from (the class, its subclass, the species or
  the background), not on the creature.
- **Features and gear** carry them from conversion: dnd5e passive effects that add armor or weapon proficiency or a
  language (Divine Order: Protector `["weapons:martial", "armor:heavy"]`; Bracers of Archery `["weapons:longbow",
  "weapons:shortbow"]`; Helm of Telepathy `["languages:Telepathy (30 feet)"]`). Gear's count while it is equipped and,
  when it needs attunement, attuned. An effect a summon applies is the summoned creature's, not its holder's (the Onyx
  Dog's mastiff).
- **Derived.** The creature's prepared data (`data/actor/base.mjs`, before the scores are read) starts from its own
  values and merges every active Item's keys (`mergeTraining`): a skill proficient (Expertise for `expertise:`), a save
  proficient, a name added to a training list. Nothing is written, so deleting the Item takes it away.
- **Kept.** A source that expressly leaves its training with the creature lists it in `flags.wildpath.trainingPermanent`
  instead; it is written into the creature's own values when the Item is added. No SRD source uses it.
- **Sheet.** Skills, saves and training lists edit the creature's own values; what its Items give shows beside them
  ("from its features"), so saving the sheet never copies it in.
- No migration: what earlier level-ups wrote stays the creature's own.
- shortcut: the extra cantrip (Thaumaturge, Magician) is by hand.

Live (two browsers, 14.369): Player1 added Divine Order: Protector to QA Caster: heavy armor and martial weapons while
it was there, none once deleted, its own training untouched. The Acolyte background gave Insight, Religion and
calligrapher's tools (shown "from its features"; its own skills stayed untrained) and took them away when deleted. A
level-1 Rogue offered Expertise only once Stealth and Perception were picked in the same dialog; both became Expertise
(proficiency 2) on the Rogue, and deleting it removed them.

## Languages (2026-10-20)

A creature's languages are its `training.languages` (an optional list): dnd5e's keys (`common`, `elvish`, `deep`),
free text ("understands Common but can't speak"), and `telepathy`. `WILDPATH.LANGUAGES` lists the 2024 standard and
rare languages (dnd5e's "exotic" is WildPath's "rare"; Primordial's four dialects are their own).
- **Trait keys.** `languages:<key>` gives one; a choice pool `languages:standard:*`, `languages:rare:*` or
  `languages:*` offers the standard ones, the rare ones, or all. A step's grants are not offered again in its choices
  (the Acolyte's Common).
- **Sources.** Level-up writes them on the background, species or class that gives them, like other training; gear
  gives its own (above). A creature's stat block languages are its own.
- **Sheet.** A "Languages" training list, by their names (2026-10-20): a typed name is stored as its key ("Elvish" →
  `elvish`), free text as typed. What its rules give shows beside it ("Telepathy 30 ft.").
- **`GrantLanguage` (2026-10-20).** A RuleElement `{language, range?, spokenOnly?, understood?, bond?}`:
  - `language`: a language's key, `any` (Comprehend Languages, Tongues), `beasts` (Speak with Animals) or
    `telepathy`.
  - `range`: Telepathy's, in feet.
  - `spokenOnly`: only what is spoken. `understood`: what it says is understood by anyone with a language (Tongues).
    `bond`: only among creatures sharing the bond (Telepathic Bond).
  - It is read by `getGrantedLanguages`, and the rule builder has "A language".
  - Live: QA Caster with Elvish and Dwarvish, and a feature with Telepathy 30, showed "Elvish, Dwarvish" and "Telepathy
    30 ft."; typing "Elvish, Deep Speech, understands Common" stored `elvish`, `deep` and the text.
- **Conversion.** dnd5e's `languages:standard:elvish` is `languages:elvish`; creatures' `traits.languages` (value,
  custom text split at semicolons); gear's `system.traits.languages.*` adds.
  - **Telepathy (2026-10-20)** is a `GrantLanguage telepathy` rule with its range: a creature's (its communication
    range, or "telepathy 120 ft." text) and the Helm of Telepathy's (30 ft). "Telepathy 1 mile (works only with you)"
    stays text.
  - **Language spells (2026-10-20)**, by their effect's name (`LANGUAGE_EFFECTS`): Comprehend Languages `any`;
    Tongues `any`, spoken, understood by others; Speak with Animals `beasts`, spoken; Telepathic Bond `telepathy`,
    bonded. A spell or feature effect that adds a plain language gives it (Alter Self's Aquan).
  - 43 pack files.

Live (two browsers, 14.369): Player1 added the Acolyte to QA Caster: the dialog granted Common and offered the other
nine standard languages; Draconic and Elvish were recorded on the background, not the creature, and left with it. A
Helm of Telepathy gave "Telepathy (30 feet)" only once attuned. The Aboleth reads Deep Speech and Telepathy 120 ft.;
the Adult Red Dragon Common and Draconic.

## Small rules (2026-10-20)

- **Alert:** `flags.dnd5e.initiativeAlert` is a Modifier on `initiative` of the Proficiency Bonus. shortcut: swapping
  Initiative with an ally is by hand.
- **Innate Sorcery:** its effect's +1 (`system.bonuses.spell.dc`) is a Modifier on `dc.spell`: the runtime adds its
  creature's `dc.spell` to the save DC of each spell it uses (`save.dcBonus`). Its Advantage on spell attack rolls is a
  RollMode added by hand (`tagsAny: ["spell"]`); an attack's roll mode now sees the Action's tags. shortcuts: any spell,
  not only Sorcerer spells; the odds on the action bar leave out the DC bonus. A Robe of the Archmagi's +2 uses the same.
- **Disciplined Survivor:** proficiency in every save, as training keys on the feature (`saves:*`, derived while it is
  there), and a reroll of a failed save for 1 Focus Point (test offers above).
- **Luck (halfling):** a free reroll of a natural 1 (test offers above).
- **Powerful Build:** Advantage on a check to end Grappled: the escape action's check names what it escapes
  (`check.escapes`), which a predicate reads. It also counts as one size larger for carrying (2026-10-22): a
  `carrying.size` Modifier doubles the size factor per step (helpers/carrying.mjs). Live: Might 16, 240 lb became 480.
- **Enlarge/Reduce (2026-10-23):** dnd5e's `system.traits.size` change is a `size` Modifier (+1, -1). A creature's size
  is its Token's squares, so the active GM resizes its Tokens while the Modifiers' total is not 0, keeping their own size
  in `flags.wildpath.ownSize`, and gives it back when they end (adapters/foundry-v14-token-size.mts). The resize is an
  unmeasured `displace` waypoint, which the movement authority approves as a resize. Its species' size counts: a Small
  creature enlarged is Medium, still 1 square. Live: QA Fighter grew to 2×2 and was 1×1 again when Enlarged ended;
  Reduced left it 1 square (Small). Reduced's 1d4 less weapon damage stays a note.

Live (two browsers, 14.369): QA Caster with Alert went from +0 to +2 Initiative, and with Disciplined Survivor had all
six saves proficient. Using Innate Sorcery, its Fire Bolt rolled 2d20kh, and as a Sorcerer 5 its Hold Person had DC 12
(8 + 3 + 0, plus 1). With Powerful Build, an Acrobatics check escaping Grappled had Advantage; escaping Restrained, or an
ordinary one, did not.

## Tireless (2026-10-20)

Tireless' "Decrease Exhaustion" is a `rest.completed` Trigger on its Item (`restTrigger`): a Short Rest
(`event.data.restType: "shortRest"`) takes one Exhaustion level off. Live (two browsers, 14.369): QA Caster with
Tireless and 2 Exhaustion took a Short Rest from Player1's client and had 1. This was the first live run of
`rest.completed`.

## Cantrip invocations, and the cantrip house rule (2026-10-20)

**House rule (the maintainer's):** a feature that changes a chosen cantrip applies to all of its creature's cantrips.
It matches the `cantrip` tag, never one spell.
- **Agonizing Blast:** its Charisma modifier on `damage.spell` for `cantrip`.
- **Repelling Blast:** an offer on any cantrip's attack hit that pushes the creature 10 ft (reactions.md).

Eldritch Spear (range) stays by hand. Live (two browsers, 14.369): QA Caster's Fire Bolt with Agonizing Blast rolled
"2d10 + 3" (Presence 16), and Repelling Blast was offered on its hit.

## Dropping to 0 Hit Points (2026-10-20)

Relentless Endurance, Relentless Rage, Undead Fortitude (zombies) and Dark One's Blessing (rule-elements.md, "Dropping
to 0 Hit Points").

Live (two browsers, 14.369):
- **Relentless Endurance:** QA Caster at 3 HP took a 7 from the Bandit Captain's Scimitar and stayed at 1 HP, its use
  spent. The next hit dropped it.
- **Relentless Rage:** with physical dice, QA Caster as a raging level-11 barbarian took 11 force at 10 HP. Player1 was
  prompted "Die result (1d20)", entered 14 against DC 10, and QA Caster stayed up with a Relentless Rage use spent.
- **Undead Fortitude:** a Zombie at 3 HP took 11 force with digital dice. Saves of 8, 6 and 4 dropped it; a 16 against
  DC 16 kept it at 1 HP ("Undead Fortitude: stays up").
- **Dark One's Blessing:** QA Caster as a level-5 warlock dropped the hostile Captain with Fire Bolt and gained 5
  Temporary Hit Points.
- **Damage over time (2026-10-20):** QA Caster at 1 HP with Relentless Endurance and Bleeding started its round. It
  stayed at 1 HP, and the use was spent. With no use left, the next tick dropped it Unconscious.

## Dice on a failed d20 test (2026-10-20)

A feature flagged `flags.wildpath.testOffer: {pool, faces, tests, refundOnFail?}` adds its die to its creature's own
offer on a failed test of a listed kind (`check`, `attack`, `save`), paid with a use of `pool` (`withTestOffers`), or
`amount` uses (2014 Seeking Spell's 2 Sorcery Points; 2026-11-07):
- **Peerless Skill:** its Bardic Inspiration die (a table by bard level) on a check or attack roll, kept if the roll
  still fails;
- **Dark One's Own Luck:** a d10 on a check or save, from its own uses.

- **Stroke of Luck (2026-10-20):** `testOffer.setNatural: 20` on a check, save or attack. The failed roll becomes a
  natural 20, so an attack's is a critical hit; its use is spent (1 per Short Rest). shortcut: the card still shows the
  d20 as rolled. Live: QA Caster's Dagger missed with a 3; Stroke of Luck made it a critical hit (2d4), and the use was
  spent.

- **Rerolls (2026-10-20):** `testOffer.reroll` offers a plain reroll of the d20. Disciplined Survivor's is a save, for 1
  Focus Point (its activity's pool). Halfling Luck's names no pool (free) and `natural: 1`: it is offered only when the
  d20 shows a 1 (`inspirationReroll` filters by natural). A reroll may carry its own `rollMode` and `bonus`
  (rolls.md). shortcut: like every test offer, only when the roll failed.
- **While a status (2026-10-31):** `testOffer.whileStatus` offers it only while its creature has that status. Fanatical
  Focus: `{tests: ["save"], reroll: true, pool: "fanatical-focus", whileStatus: "raging", bonus: <Rage Damage table>}`.
  Its pool of 1 is refilled by a free reaction to its creature's own Rage Action (a FEATURE_ACTIONS row whose definition
  `restores` it), so it is once per Rage. shortcut: a Rage begun without the Rage Action refills nothing.

- **Flash of Genius (Tasha's, 2026-10-20):** a ranged test offer with no `against`: any failed check or save, its own
  or an ally's within 30 ft (`withAllyTestOffers`, now on checks too). `addAbility: "intellect"` adds its modifier
  (`addFlat` in `inspirationReroll`), paid with a use and its Reaction (`reaction`). shortcut: "a creature you can see"
  is any ally in range. `add` (2026-11-01) adds a number or a value expression instead: a Sphinx of Wonder's Burst of
  Ingenuity (`add: 2`, 30 ft, a use and its Reaction).
- **Boon of Fate (2026-10-31):** a ranged test offer adding dice (`faces`, `number`: 2d4) to a failed D20 Test of its
  bearer or an ally within 60 feet, paid with its use, which a Short Rest or rolling Initiative restores (an automation
  Trigger on `initiative.rolled`). shortcut: offers come on a failure only, so its penalty on another creature's
  success is by hand (noted).

## Portent (2026-10-20)

2024 Diviner: after a Long Rest it rolls two d20s (three from level 14, Greater Portent). It may replace a D20 Test by
itself or a creature it can see with one of them, once per turn. By the maintainer's ruling (2026-10-20) it replaces
the d20 after the roll, like Stroke of Luck.

How it works (`adapters/foundry-v14-portent.mts`):
- **The feature.** The converted feature carries `flags.wildpath.portentDice`, a table by wizard level (local PHB
  conversion; the SRD has no Diviner).
- **The dice.** `Actor#rest` rolls them on a Long Rest, in a message to its owner and the GM. They are kept as
  `flags.wildpath.portent` (`{"1": 14, "2": 3}`, where 0 means used), and the sheet header shows the unused ones. The
  turn of the last use is `portentTurn`.
- **Who may use one.** `portentHolders`: every Diviner on the Scene that
  - has an unused die;
  - hasn't used one this turn;
  - isn't set to Never (its feature's reaction policy);
  - is the roller, or sees it (`relationsToSource`: sight, light, walls).

  A GM-hidden roller isn't offered to a player's Diviner. The Diviner's active players answer, otherwise the GM.
- **An Action's d20.** The runtime offers `attack.portent`, `check.portent` and `save.portentByTarget`.
  - After the roll, `portentReplace` (pipeline) asks each holder before Heroic Inspiration. A die used sets the natural
    (`setNatural`), so a 20 is a critical hit. A Diviner uses at most one die per resolution, even across several saves.
  - The die is a payment by the Diviner (`portentPayment`): its slot becomes 0 and its turn is marked in the Action's
    own transaction, so a failed commit leaves it unspent.
- **A sheet roll's or initiative's card.** A Diviner's owner gets a Portent button. The active GM checks the request
  (the user owns the Diviner, which may use it now), one claim of the card at a time with a Heroic Inspiration reroll
  (`claimCard`). It then posts the new total, marks the old card, sets the combatant's initiative, and spends the die.

An attack's added die is kept when the attack still misses (`refundOnFail`), as a check's is. shortcut: offered only on
a failed roll. Live (two browsers, 14.369): QA Caster as a level-10 bard with Peerless Skill missed with Dagger attacks
four times even after the d10, and Bardic Inspiration stayed at 4; an 8 plus a d10 of 7 hit (AC 15), and it went to 3.

## Smaller features (2026-10-20)

- **Steady Aim** (Bonus Action): Advantage on its next attack roll this turn (`endsWhen: "attacks"`), and Speed 0 until
  the turn ends (`SELF_EFFECTS`). Only while it hasn't moved this turn (`requires`, action-definitions.md).
- **Superior Defense:** a free Action, 3 Focus Points, Resistance to every type but Force for 1 minute
  (`USED_AT_TURN_START`). shortcut: its "start of your turn" is by hand.
- **Survivor (Heroic Rally):** a `turn.started` Trigger healing 5 + its Constitution modifier while Bloodied and above
  0 Hit Points (the `bloodied` predicate, rule-elements.md).
- **Converter fixes:**
  - Nature's Ward's dnd5e "poison" condition immunity is Poisoned. shortcut: its land's Resistance is by hand.
  - A climb or swim Speed of `@attributes.movement.speed` equals its walking Speed (Second-Story Work, Alter Self's
    Aquatic Adaptation).
  - `(@abilities.wis.mod)d8` is dice as many as that modifier (Sear Undead).
- **Live (two browsers, 14.369):** QA Caster at 4 of 10 HP with Survivor started its turn at 9 HP. Steady Aim set its
  Speed to 0, its Dagger attack rolled 2d20kh, and the Advantage effect ended after that attack.

## Font of Magic (2026-10-19)

2024 Font of Magic converts to two Actions from its `font-of-magic` pool (Sorcery Points). The sorcerer class grants both.
- **Regain Spell Slot** (a Bonus Action): a slot level from 1 to 5. Each option costs its points (2, 3, 5, 6, 7) and
  restores one slot of that level (action-configuration.md: an option's effects, `restore`). It is converted generically
  since 2026-10-19 (above).
- **Regain Sorcery Points** (no action): spends a slot of any level and restores that many points.
- **Refusal:** either is refused when what it restores is full or missing. A slot level a sorcerer has no slots of is
  refused, which matches the table's minimum Sorcerer level for a single-class sorcerer.
- **shortcuts:** a created slot stays within the slot maximum and does not vanish on a Long Rest; multiclass slot levels
  follow the slot pools.
- **Live (two browsers, 14.369):** QA Caster, as wizard 5 and sorcerer 2, had 2 points. Player1 created a level-1 slot
  (points 2 to 0, slot 0 to 1), then spent it for 1 point.

## Metamagic (2026-10-19)

A Metamagic option converts to a feature flagged `flags.wildpath.metamagic` (`quickened`, `twinned`, ...). A creature
with Sorcery Points and known options gets a "Metamagic" choice on each spell Action when it is read (`withMetamagic`,
module/helpers/metamagic.mts). Its first option is None. The others are those that apply and that it has the points for:

| Option | Offered when | Effect |
|---|---|---|
| Quickened (2) | it costs an Action, and no spell slot was spent this turn | its Action is paid as a Bonus Action |
| Twinned (1) | its slot adds targets | one more target |
| Transmuted (1) | it deals acid, cold, fire, lightning, poison or thunder | one option per other type |
| Distant (1) | ranged or touch | range x2; touch becomes 30 ft |
| Extended (1) | its effects or concentration last 1 minute or more | durations x2, 24 hours at most; Advantage on its Concentration saves |
| Subtle (1) | always | its Verbal, Somatic and Material component tags go (a costly material stays); none left is `component:none`, which Counterspell can't answer |
| Heightened (2) | it forces a save | when the save is rolled, its caster picks one target (asked when there are several), which saves with Disadvantage: one more roll-mode source |
| Careful (1) | it forces a save | its caster ticks up to max(1, Presence modifier) creatures, its allies ticked already; they succeed without rolling (`automatic-success`) and take no damage where a success halves it (evasion) |

- **Seeking Spell** is a reroll on a missed spell attack, beside Heroic Inspiration (`withSeekingSpell`), for 1 point.
- **Empowered Spell (2026-10-20)** is a choice of its own on a spell that rolls damage dice, beside the one option
  (2024: "even if you've already used a different Metamagic option"). For 1 point (`empower-damage`:
  `metadata.empowered`), once its damage is rolled, up to max(1, Presence modifier) of its dice below their average,
  lowest first, are rolled again and the new rolls are used (`empoweredReroll`, one roll per die size). Its old Action
  is gone. Live: QA Caster's Empowered Fire Bolt rolled 1 and 7; the 1 became a 3 (1d10), the Bandit Captain took 10,
  and 1 point was spent.
- **Payments that share a pool:** two payments of one payer from the same pool, both planned before the Action, are
  committed one after the other (`chainPayments`). Seeking's point comes after Quickened's two, not over them.
- **Quickened afterwards (2026-10-20):** a Quickened cast records `flags.wildpath.quickenedTurn`. A spell of level 1+
  is then refused by the authority and greyed on the action bar for the rest of that turn (`requiresContext`).
- **Extended's Advantage:** its effective definition has `concentration.advantage`; the caster's concentration marker
  then carries a RollMode on `concentration`.
- **Heightened and Careful (2026-10-20).** The configuration effect `set-save` marks the spell's save
  (`save.heightened`, `save.careful: <count>`), and the save roll stage asks its caster (`metamagicSaves`). A CHOICE
  prompt now carries its `type`, `max` and ticked defaults to the chooser. The Action's source carries its disposition,
  so its allies can be told apart.
- **Live (2026-10-20), Heightened and Careful:** a two-target save spell (8 fire, half on a success) from sorcerer 5 QA
  Caster at QA Ally and the Bandit Captain.
  - Careful: QA Ally came ticked; it saved without rolling and took nothing, and the Captain failed and took 8.
  - Heightened: the Captain was picked and saved with 2d20kl + 7.
- **Live (2026-10-20):** as a sorcerer 5, QA Caster's Quickened Fire Bolt spent its Bonus Action and 2 points. Magic
  Missile was then greyed and refused ("no other spell of level 1 or higher").
- **Live (two browsers, 14.369):** QA Caster, as wizard 5 and sorcerer 3 with 3 points, spent its Action. The action bar
  kept Fire Bolt usable. Player1 cast a Quickened Fire Bolt, which spent the Bonus Action and 2 points. It missed with a
  10, Seeking Spell rerolled it to 25, and it hit for 2d10. Points went from 3 to 0.

## Tactical Mind (2026-10-19)

2024 Tactical Mind (fighter level 2): when the fighter fails an ability check made through an Action (`definition.check`),
its own offer adds "Tactical Mind: add 1d10" (beside Heroic Inspiration and Bardic Inspiration). Since 2026-10-31 it is a
plain test offer (`flags.wildpath.testOffer`: `{tests: ["check"], faces: 10, pool: "second-wind", refundOnFail: true}`),
like Indomitable's reroll (`bonus`: its fighter level as a class-level expression); no engine code names the fighter.
- **Paying:** it is paid from its Second Wind pool, and the use is kept when the check still fails (`refundOnFail`: the
  check stage leaves the payment out).
- **shortcut:** a check rolled from the sheet gets no offer.
- **Live (two browsers, 14.369, physical dice):** QA Caster as a level-2 fighter failed Hide (DC 15) with a 5. A 1d10 of 9
  still failed, and Second Wind stayed at 2. A 1d10 of 10 succeeded, and Second Wind went to 1.
