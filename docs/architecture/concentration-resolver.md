# Concentration Resolver

`module/resolvers/concentration-resolver.mjs` is the pure concentration planning and
decision-normalization layer. It does not roll dice and does not mutate Actors or ActiveEffects.

## Current Flow

```text
already-resolved concentration save decision
or concentration.saveResolved event
-> maintained / broken / ignored classification
-> concentration.broken lifecycle event on failure
-> EffectLifecycleCommitResolver
-> condition removal transaction path
```

```text
adjusted damage result
+ supplied concentration state
-> concentration check request
-> supplied digital/physical roll result
-> concentration.saveResolved decision event
-> maintained / broken / ignored classification
```

## What It Does Now

`planConcentrationChecks()`:

- accepts adjusted damage results from `DamageDurabilityResolver`
- uses final damage taken after resistance, reduction, and absorption
- requires supplied concentration state snapshots or target-system concentration state
- computes the default concentration DC as `max(10, floor(damageTaken / 2))`
- supports custom minimum DC, damage divisor, rounding, minimum damage, save key, and ability
- returns check request data without rolling or mutating documents

`resolveConcentrationDecisions()`:

- accepts plain decision objects or semantic `concentration.saveResolved` events
- treats failed decisions as `concentration.broken` lifecycle events
- records maintained decisions without producing mutation events
- ignores undecidable entries instead of guessing
- preserves source/origin/actor/item refs as opaque strings
- leaves all document mutation to `EffectLifecycleCommitResolver`

`resolveConcentrationCheckResults()`:

- accepts concentration check requests from `planConcentrationChecks()`
- matches supplied results by request id, actor ref/id, source ref, or target ref
- resolves numeric totals against the request DC through `SaveResolver`
- also accepts explicit GM-entered maintained/failed outcomes for physical dice workflows
- returns `concentration.saveResolved` events plus the derived break events
- reports missing or malformed results explicitly instead of assuming success or failure

This lets a later dice adapter, physical-dice prompt, or GM-entered result provide only the roll
total or explicit outcome. The concentration resolver still owns the save comparison and lifecycle
signal shape.

For the adapter-facing path that immediately commits resulting lifecycle removals, see
`docs/architecture/concentration-check-commit-resolver.md`.

## Live Action integration

The action pipeline's `action.concentration` stage (after effects, before payment) uses this resolver
on every damaging Action:

- `planConcentrationChecks()` runs over the stage's adjusted damage. The DC is `max(10, floor(damage/2))`
  and the save is WildPath's Fortitude.
- Each check is a save rolled by the damaged creature's controller, one request after another
  (`concentration:1`, …). The DC stays on the authority; the roller sees a plain save. The roll adds the
  creature's Fortitude save bonus: its Fortitude modifier plus Modifiers on `save.fortitude` and `save`. The
  runtime puts this in the concentration state as `saveBonus`.
- `resolveConcentrationCheckResults()` turns a failed check into `concentration.broken`.
- `planEffectLifecycle()` ends every dependent effect in the same transaction as the damage.

Concentration is derived, not stored: the Foundry runtime scans the Scene's Token Actors and the world's
Actors for effects whose `flags.wildpath.conditionEffect.concentration.sourceRef` names a targeted
creature (`token:<id>` or uuid). It passes the states and dependents, and registers the holders for the
commit. Live: a 100-damage hit (DC 50) broke a caster's concentration, and the Stun it sustained on a
third creature ended in the same commit (`wildpath.representative-actions`).

## One concentration at a time (2026-10-19)

2024: casting another spell that requires concentration ends the one you have.
- **What starts one** (`startsConcentration`): an Action with a concentration effect, a lasting concentration
  area, or a concentration summon.
  - A converted follow-up of the same spell (`metadata.followUp`, an activity spending no slot: Move Mark, Curse
    New Creature) continues its concentration instead.
- **When it ends the old one.**
  - When such an Action is declared, the authority notes what its creature sustains (`sustainedEffects`):
    - its spells' effects on any creature (their concentration `sourceRef` names the casting Item);
    - its areas' and summons' markers (they name its Token).
  - Once the Action completes, exactly those end (`endEarlierConcentration`, the first `afterCompleted` step), so
    what the new Action leaves stays. An Action that fails or is cancelled ends nothing.
  - Ending a marker removes its Region or dismisses its summons.
- **Incapacitated** uses the same scan. It now also finds spell effects, whose source is the casting Item; it
  used to match only the creature's own refs.
- Casting the same spell again is a new concentration: the old effect ends, as in 2024.
- shortcut: the Builder cannot set `metadata.followUp`, so a homebrew follow-up ends its own spell's concentration;
  add a Builder checkbox when homebrew follow-ups need it.

Live (two browsers, 14.369): QA Caster's Hunter's Mark was on the Bandit Captain. Casting Hex on QA Saver
("Hexed Wisdom") removed the mark from the Captain, and the Saver kept the Hex.

## What It Does Not Do Yet

ConcentrationResolver does not:

- discover live Foundry damage events
- discover concentration state from live Actor documents
- roll digital dice
- prompt for physical dice
- decide advantage/disadvantage or bonuses
- emit chat output

Those belong in future action/damage/concentration adapter slices. This module only plans required
checks from already-adjusted damage, resolves supplied check results, and turns known decisions into
stable lifecycle signals.
