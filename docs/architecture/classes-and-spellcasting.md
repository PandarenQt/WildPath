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
  lists of names typed on the sheet. Nothing reads them yet; armor training and Weapon Mastery will.
- **Heroic Inspiration.** `system.heroicInspiration`, a checkbox for now.
- **Hit Dice.** A class record's `hitDie` (its faces) gives one Hit Die per level, held in a pool per size
  (`hit-die.d10`), created full and recovered on a long rest, like slot pools. A multiclass creature holds several.

Live (two browsers): a Fighter 3 had "Hit Dice (d10) 3/3". Player1 set its Stealth to Expertise on the sheet (+2 to
+6), typed its armor training, and ticked Heroic Inspiration.

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

Not yet:

- A form that keeps spellcasting (2024 Shapechange-style). Every transformation stops it for now.

Live (two browsers, 14.369): Player1 turned their Shifter into a Bear, which gave Might 18 and AC 13, and
used the copied Bite through the GM's authority. The goblin went from 20 to 15, the Action was spent and a
card posted. Reverting restored Might 8 and removed the Bite. In Quench, the creature's own +1 AC feat kept
counting on the form's AC, and its own Intellect stayed.
