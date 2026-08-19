# Effect Lifecycle Resolver

`module/resolvers/effect-lifecycle-resolver.mjs` is the pure bridge between committed condition
effect metadata and later removal plans.

## Current Flow

```text
committed condition ActiveEffect snapshots
+ timeline events
+ concentration break refs/events
-> duration expiry checks
-> concentration break checks
-> EffectResolver condition removal plans
-> target mutation transaction path
```

## What It Does Now

`planEffectLifecycle()`:

- reads condition metadata from `flags.wildpath.conditionEffect`
- normalizes plain ActiveEffect snapshots or Foundry-like effect documents
- maps duration metadata into the existing combat-timeline duration helper
- supports source/target turn-start and turn-end expiry, round expiry, combat/rest units, and
  already-expired durations
- matches concentration breaks by source/origin refs or actor refs
- respects `breakRemovesEffect: false`
- returns condition removal mutation plans instead of mutating Actors or ActiveEffects
- de-duplicates duration expiry and concentration break into one removal plan per effect

The returned `conditionEffect` mutation plans can be committed by
`TargetMutationCommitResolver`/`ResolutionTransaction` when a Foundry adapter supplies target
Actors and explicit authority.

## What It Does Not Do Yet

EffectLifecycleResolver does not:

- listen to Foundry combat hooks
- decide which client is authoritative
- roll concentration saves
- decide whether concentration was broken
- decrement and persist remaining duration counters
- create chat output or UI prompts
- apply generic non-condition ActiveEffects

Those remain integration and future resolver slices. This module only converts already-known
timeline/concentration events into explicit condition removal plans.
