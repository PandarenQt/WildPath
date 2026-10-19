# Classes and Spellcasting

Decided by the maintainer on 2026-10-14: class records with full multiclass support, and 2024
spellcasting rules with full and half casters only. Subclasses are planned to start at level 2.

## Class records

Every Actor stores one record per class in `system.classes`. Multiclassing is the normal case.

```js
{id: "paladin", name: "Paladin", level: 3, original: false,
 subclasses: ["oath-a"],                                  // a class may hold several subclasses
 spellcasting: {progression: "half", ability: "presence"}} // progression: none | full | half
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
- **Training.** `system.training`: `armor`, `weapons`, `tools` and `masteries` (the weapons whose mastery it uses),
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
    paying character from those on the viewed Scene.
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
  has is not offered), an Ability Score Improvement (points to spend, or a feat from the compendiums' origin and
  general feats, Epic Boons from level 19), the subclass (from every Item compendium, by class identifier) and a
  species' size. Confirm stays disabled until every count and every point is met.
- **What it does.** The class's `levels` goes up; hit points rise by the Hit Die's maximum at a character's first
  level, else its average rounded up, plus the Fortitude modifier (the `rollHitPoints` world setting rolls the die
  instead, with the roll in chat); one more Hit Die is available. Skills, saves and training are added, ability
  scores raised (20 at most), the features created from their compendium as given by the class (so they go when it
  goes), and a chosen subclass is added with its own features for that level.
- **Multiclassing** (a class beside another) uses the class's multiclass proficiencies and the average hit points,
  and warns, without blocking, when either class's primary abilities are below 13.
- Shortcuts: a later Fortitude increase does not raise earlier levels' hit points; removing a class does not take
  back its hit points or ability increases; a subclass dropped directly gets no dialog; spells a feature chooses
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

## Spellcasting progression (2024)

- **Caster level.** Every level in a full-caster class, plus half the levels in each half-caster class,
  rounded up per class. A level-1 Paladin is caster level 1, and Wizard 3 + Paladin 3 is caster level 5.
- **Slots.** Spell slots per spell level come from the 2024 multiclass spellcaster table at that caster
  level. They are held in the existing `spell-slot.<n>` pools, which Actions already pay with.
- **Pool maxima.** A slot pool's maximum adds the table's count to its own base, bonus and modifiers.
- **New pools.** When an Actor is created with class records, or its classes change, any slot pool a
  newly reached spell level needs is created full, with long-rest recovery.
- **Pact-style slots.** These stay separate pools with short-rest recovery. There are no third casters.

The ruleset lives in one module (`helpers/spellcasting.mts`), so another ruleset replaces that module
rather than branching inside callers (AGENTS §10).

Live (Quench, 14.369): a Wizard 3 / Paladin 3 is level 6 with the Wizard as its original class. It is
caster level 5, with slot pools of 4, 3 and 2 created full. Adding Paladin levels and a Cleric level
raised it to caster level 7 and added the level-4 slot pool.

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

Not yet:

- A form that keeps spellcasting (2024 Shapechange-style). Every transformation stops it for now.
- True Polymorph (an object, a creature into an object, permanence) and what a creature may do in its form (speech).

Live (two browsers, 14.369): Player1 turned their Shifter into a Bear, which gave Might 18 and AC 13, and
used the copied Bite through the GM's authority. The goblin went from 20 to 15, the Action was spent and a
card posted. Reverting restored Might 8 and removed the Bite. In Quench, the creature's own +1 AC feat kept
counting on the form's AC, and its own Intellect stayed.

## Font of Magic (2026-10-19)

2024 Font of Magic converts to two Actions from its `font-of-magic` pool (Sorcery Points). The sorcerer class grants both.
- **Regain Spell Slot** (a Bonus Action): a slot level from 1 to 5. Each option costs its points (2, 3, 5, 6, 7) and
  restores one slot of that level (action-configuration.md: an option's effects, `restore`).
- **Regain Sorcery Points** (no action): spends a slot of any level and restores that many points.
- **Refusal:** either is refused when what it restores is full or missing. A slot level a sorcerer has no slots of is
  refused, which matches the table's minimum Sorcerer level for a single-class sorcerer.
- **shortcuts:** a created slot stays within the slot maximum and does not vanish on a Long Rest; multiclass slot levels
  follow the slot pools.
- **Live (two browsers, 14.369):** QA Caster, as wizard 5 and sorcerer 2, had 2 points. Player1 created a level-1 slot
  (points 2 to 0, slot 0 to 1), then spent it for 1 point.

## Tactical Mind (2026-10-19)

2024 Tactical Mind (fighter level 2): when the fighter fails an ability check made through an Action (`definition.check`),
its own offer adds "Tactical Mind: add 1d10" (`withTacticalMind`, beside Heroic Inspiration and Bardic Inspiration).
- **Paying:** it is paid from its Second Wind pool, and the use is kept when the check still fails (`refundOnFail`: the
  check stage leaves the payment out).
- **shortcut:** a check rolled from the sheet gets no offer.
- **Live (two browsers, 14.369, physical dice):** QA Caster as a level-2 fighter failed Hide (DC 15) with a 5. A 1d10 of 9
  still failed, and Second Wind stayed at 2. A 1d10 of 10 succeeded, and Second Wind went to 1.
