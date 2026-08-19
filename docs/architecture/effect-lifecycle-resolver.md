# Effect Lifecycle Resolver

`module/resolvers/effect-lifecycle-resolver.mjs` is the pure bridge between committed condition
effect metadata and later removal plans.

`module/resolvers/effect-lifecycle-commit-resolver.mjs` is the Foundry-facing commit bridge that
accepts supplied Actors, lifecycle events, and explicit authority, then commits any resulting
condition removal plans through `TargetMutationCommitResolver` and `ResolutionTransaction`.

`module/resolvers/concentration-resolver.mjs` can feed this lifecycle path by turning
already-resolved failed concentration save decisions into `concentration.broken` events.

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

`executeEffectLifecycleCommit()`:

- runs `planEffectLifecycle()` for supplied target Actors
- normalizes supplied concentration save decisions before lifecycle planning
- builds a target Actor lookup from opaque `actor:` and `uuid:` refs
- refuses mutation commits without explicit GM/authority data
- batches committed condition removals through the existing transaction path

`wildpath.mjs` currently adapts `combatStart` and `combatTurn` into semantic lifecycle events,
guards execution to the active GM, resets the incoming combatant's turn resources, and asks
`EffectLifecycleCommitResolver` to remove expired condition effects.

## What It Does Not Do Yet

EffectLifecycleResolver does not:

- roll concentration saves
- decide whether a concentration check is required
- compute concentration DCs
- decrement and persist remaining duration counters
- create chat output or UI prompts
- apply generic non-condition ActiveEffects

Those remain future resolver slices. The pure planner only converts already-known
timeline/concentration events into explicit condition removal plans; the current Foundry hook
adapter supplies combat start/turn events, and ConcentrationResolver supplies break events after a
concentration decision is already known.
