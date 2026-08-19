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
-> later dice/physical-roll adapter
-> concentration.saveResolved decision event
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

This lets a later dice adapter, physical-dice prompt, or GM-entered result feed the same lifecycle
path after the numeric save outcome is known.

## What It Does Not Do Yet

ConcentrationResolver does not:

- discover live Foundry damage events
- discover concentration state from live Actor documents
- roll digital dice
- prompt for physical dice
- decide advantage/disadvantage or bonuses
- emit chat output

Those belong in future action/damage/concentration adapter slices. This module only plans required
checks from already-adjusted damage and turns known decisions into stable lifecycle signals.
