# EffectResolver

`module/resolvers/effect-resolver.mjs` is the condition-first effect planning boundary. It gives
conditions the same resolver shape as damage, healing, resources, and transactions before broader
ActiveEffect automation is added.

## Current Flow

```text
condition id + signed level delta
-> condition definition lookup
-> existing condition snapshot lookup
-> create/update/delete/noop mutation plan
-> duration/source/origin/concentration lifecycle metadata
-> explicit Foundry commit adapter or ActionResolver transaction operation
```

## What It Does Now

`planConditionEffect()`:

- validates condition ids against supplied condition definitions
- supports binary conditions such as Prone
- supports leveled conditions such as Exhaustion
- clamps leveled conditions to their configured maximum
- returns explicit `create`, `update`, `delete`, or `noop` plans
- carries plain duration metadata for fixed, turn-based, combat-based, or scheduled expiry
- carries source/origin refs so spell-based conditions can be traced without live document handles
- carries concentration metadata so a future concentration resolver can remove linked effects when
  concentration breaks
- consumes plain condition snapshots or Actor `effects` collections
- does not mutate ActiveEffect documents

`executeConditionEffect()`:

- runs the same planning step
- refuses mutating plans unless a commit adapter is supplied
- skips no-op commits
- returns structured commit failures instead of throwing resolver errors

`module/resolvers/condition-effect-commit-resolver.mjs`:

- commits condition creates, updates, deletes, and no-ops against supplied target Actors
- persists duration/source/origin/concentration metadata onto condition ActiveEffects
- applies signed level deltas against current target Actor state at commit time
- returns snapshots that `ResolutionTransaction` can use for rollback
- restores created, updated, and deleted condition effects when a later transaction operation fails

`WildPathActor#toggleCondition()` now enters this resolver and supplies the Foundry-specific commit
adapter that delegates to `WildPathConditionEffect.applyDelta`.

## What It Does Not Do Yet

EffectResolver does not:

- apply generic ActiveEffects
- resolve, tick, or expire durations
- create condition ticking schedules
- check or break concentration
- commit generic non-condition effects through `ResolutionTransaction`
- open reaction windows
- create chat output

Those should land as small effect slices. Conditions are first because they already have a stable
document implementation and give the rest of the system a concrete effect contract to build on.
Save-based applicability belongs in `ActionResolver` after `SaveResolver` outcomes exist; duration
and concentration lifecycle enforcement belongs in a future effect/concentration adapter rather
than in condition data preparation or sheet rendering.
