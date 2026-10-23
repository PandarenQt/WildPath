# Dying and Death

Decided by the maintainer on 2026-10-14: **dead is 0 health, Defeated, and three failed death saves.** The
dying rules follow D&D 2024, with Pathfinder 2e's conventions where 2024 leaves the choice to the table.
The rules are in `module/adapters/foundry-v14-dying.mts`: a pure core (`dyingAfterChange`,
`deathSaveResult`) and the Foundry glue, which runs on the active GM.

## The rules

- **Who makes death saves** is a per-creature setting, `system.dyingMode` (maintainer decision, 2026-10-14):
  - `auto` (the default): characters do, and so do companions and sidekicks a Player controls, which follow
    their character. Other NPCs die at 0.
  - `deathSaves` or `dies` sets it for that creature, for example an important NPC who makes death saves.
- **Dropping to 0.**
  - A creature that makes death saves falls **Unconscious**, and its death saves reset.
  - Any other creature dies at once. This is the usual 2024 table practice and also PF2e's default for most
    foes.
  - **Massive damage** kills either one: the damage left over after reaching 0 is at least the creature's
    maximum health.
- **Death saves.** At the start of each of its turns, a character at 0 health that is neither stable nor
  dead rolls a d20 against DC 10.
  - The save is an ordinary Action save, so the character's controller rolls it, and Modifiers on `save`
    (such as Exhaustion's −2) apply.
  - **10 or higher** is a success. Three successes make the character **stable**, and it rolls no more.
    Becoming stable resets its failures (2024).
  - **A natural 1** is two failures.
  - **A natural 20** brings it back with 1 health, conscious.
  - **Three failures** are death.
- **Hurt at 0.**
  - Damage at 0 health is one failed death save.
  - A **critical hit** is two. A hit on an Unconscious creature from within 5 ft is a critical hit, so a
    finishing blow counts double.
  - A stable creature that takes damage stops being stable, and its death saves start over from that failure.
- **Stabilizing (2024).** An Action with `stabilize: true` makes each dying target stable. Spare the Dying (15 feet)
  and a Healer's Kit (touch, a use) do it outright; the converter gives them `stabilize` (`STABILIZES`, 2026-10-23;
  before, Spare the Dying only left a marker). An ally's Help needs a DC 10 Wits (Medicine) `check` (action-definitions.md), and a failed check
  stabilizes no one.
  - Damage of at least the maximum health kills outright.
- **Healing at 0** wakes the creature, and its death saves reset.
- **Exhaustion 6** is death.
- **Regaining 1 health while stable (2024, 2026-10-14).** Becoming stable stores
  `flags.wildpath.stableSince {worldTime, hours}`; the hours are 1d4, rolled then. This happens on the third success
  or from a `stabilize` Action.
  - The creature regains 1 health, wakes, and its death saves reset once enough time has passed. World time moving
    on counts (the active GM's `updateWorldTime` hook). So do its rests: a short rest is 1 hour and a long rest 8
    (`restHours`, added to the flag). Tables that never advance world time still recover.
  - Damage while stable starts the death saves over and ends the wait. So do healing, waking and death.

- **Regeneration that puts off death (2026-10-14).** A creature whose Regeneration says it "dies only if it starts
  its turn with 0 Hit Points and doesn't regenerate" (`deferDeath`, rule-elements.md) falls Unconscious at 0 instead
  of dying. At the start of its turn, after its Regeneration has run, it dies if it is still at 0. Healing wakes it as
  it wakes anyone. Exhaustion 6 still kills it.

## Dead

`die(actor)` sets health to 0 and three failed death saves. It applies the **Dead** condition, which is
Foundry's Defeated status (`CONFIG.specialStatusEffects.DEFEATED`, shown as the Token's overlay). The dead
creature cannot act or move. Every Combatant of that creature is marked defeated. The dead are past the
dying rules: further damage or failures change nothing.

## Data and hooks

- `system.deathSaves: {successes, failures}`, 0–3 each, on every Actor.
- **After an Action** (the coordinator's `afterCompleted`): each damage or healing plan the Action
  committed, with its target found the way the commit found it. A critical hit on that target counts.
- **At turn start** (`WildPathCombat#_onStartTurn`): first a condition's damage that turn, then the death
  save.
- **Effect hooks** (`createActiveEffect`, `updateActiveEffect`): Exhaustion reaching level 6.

## Evidence

- **Node:** the 2024 rule table; the Foundry glue with fake documents (Unconscious, two failures from a
  critical, death and Defeated, and the dead past further rules); Exhaustion 6.
- **Quench:**
  - real dropping to 0, failures, and the Dead condition with no actions;
  - Exhaustion 6 killing through the live hook;
  - a turn-start death save on an unlinked Token.
- **Two browsers, 14.369:**
  - A GM goblin's club dropped Player1's hero to 0: Unconscious.
  - When the hero's turn started, the death save was routed to Player1 and rolled 12: a success, with a
    public card.
  - The goblin hit the downed hero again from 5 ft. It was a critical, so two failures.
  - Healing for 3 woke the hero and cleared its death saves.

## Incapacitated (2024)

Stunned, Unconscious and Dead are Incapacitated:
- **No actions.** A `ResourceCap` caps Actions, Bonus Actions and Reactions at 0.
- **Concentration ends.** The condition's `endsConcentration` makes the active GM end every effect the
  creature sustains, on any creature (`sustainedEffects`: matched by its Actor or Token ref, or an Item of it).
  Its lasting concentration areas end with their marker (`endConcentrationOnIncapacitation`).
- **Disadvantage on initiative.** A `RollMode` on `initiative`. Initiative is an Agility check, so
  `WildPathCombatant` rolls it with the creature's Agility modifier, and with its modes and Modifiers on
  `initiative`, `check` and `check.agility`.
  Poisoned's disadvantage and Exhaustion's −2 reach it too.

Unconscious also makes the creature **Prone** (the condition's `implies`), and the creature is still Prone
when it wakes.

Live (two browsers, 14.369): Player1 rolled initiative for their Stunned hero: `2d20kl`, 3 kept and 16
discarded. Quench checked the rest on real Documents:
- the initiative formula;
- a sustained effect on another creature ending when its caster was Stunned;
- Prone arriving with Unconscious and staying after waking.

Live (two browsers, 14.369, 2026-10-14): Player1's medic used a stabilize Action on a dying ally. With −20 on
Medicine, the card said "Check failed", the ally stayed dying and the Action was spent. With +20, the card said
"Check succeeded", and the ally's Token became stable (three successes, no failures).

## Not yet

- PF2e's dying values, wounded and doomed: WildPath uses 2024 death saves instead.
