# Concentration Check Commit Resolver

`module/resolvers/concentration-check-commit-resolver.mjs` is the adapter-facing bridge between
concentration check result entry and lifecycle mutation.

## Current Flow

```text
concentration check requests
+ supplied digital roll totals or physical-dice outcomes
+ supplied target Actors/effects
+ explicit authority
-> ConcentrationResolver.resolveConcentrationCheckResults()
-> concentration.saveResolved events
-> EffectLifecycleCommitResolver
-> transaction-backed condition removal plans
```

## What It Does Now

`executeConcentrationCheckCommit()`:

- resolves supplied concentration check results through `ConcentrationResolver`
- stops before mutation if required results are missing or malformed
- passes only resolved `concentration.saveResolved` events to `EffectLifecycleCommitResolver`
- preserves the lifecycle commit resolver as the only document mutation path
- reports authority failures from the lifecycle commit instead of bypassing them

The module is intentionally prompt-agnostic. A future Foundry UI adapter can collect a digital roll,
a physical dice total, or a GM-entered maintained/failed outcome, then call this bridge with the
check request and explicit authority context.

## What It Does Not Do Yet

ConcentrationCheckCommitResolver does not:

- discover pending concentration checks from live damage chat messages
- render prompt dialogs or chat cards
- roll dice
- discover all linked effect targets from live world documents
- decide advantage, disadvantage, or save modifiers

Those remain Foundry/UI adapter concerns. This resolver only converts supplied result data into the
existing lifecycle commit path.
