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
  - **A natural 1** is two failures.
  - **A natural 20** brings it back with 1 health, conscious.
  - **Three failures** are death.
- **Hurt at 0.**
  - Damage at 0 health is one failed death save.
  - A **critical hit** is two. A hit on an Unconscious creature from within 5 ft is a critical hit, so a
    finishing blow counts double.
  - Damage of at least the maximum health kills outright.
- **Healing at 0** wakes the creature, and its death saves reset.
- **Exhaustion 6** is death.

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

## Not yet

- Concentration ending when a creature becomes Incapacitated.
- Disadvantage on initiative while Incapacitated.
- Unconscious also making the creature Prone.
- Stabilizing by an ally's check.
- Regaining 1 health after being stable for a while.
- PF2e's dying values, wounded and doomed: WildPath uses 2024 death saves instead.
