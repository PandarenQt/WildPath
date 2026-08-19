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
