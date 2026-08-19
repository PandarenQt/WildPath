# Concentration Resolver

`module/resolvers/concentration-resolver.mjs` is the pure decision-normalization layer for
concentration. It does not roll dice and does not mutate Actors or ActiveEffects.

## Current Flow

```text
already-resolved concentration save decision
or concentration.saveResolved event
-> maintained / broken / ignored classification
-> concentration.broken lifecycle event on failure
-> EffectLifecycleCommitResolver
-> condition removal transaction path
```

## What It Does Now

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

- decide when a concentration check is required
- compute the concentration DC from damage or rules variants
- roll digital dice
- prompt for physical dice
- decide advantage/disadvantage or bonuses
- emit chat output

Those belong in future action/damage/concentration adapter slices. This module only turns a known
decision into a stable lifecycle signal.
