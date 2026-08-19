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
-> explicit Foundry commit adapter
```

## What It Does Now

`planConditionEffect()`:

- validates condition ids against supplied condition definitions
- supports binary conditions such as Prone
- supports leveled conditions such as Exhaustion
- clamps leveled conditions to their configured maximum
- returns explicit `create`, `update`, `delete`, or `noop` plans
- consumes plain condition snapshots or Actor `effects` collections
- does not mutate ActiveEffect documents

`executeConditionEffect()`:

- runs the same planning step
- refuses mutating plans unless a commit adapter is supplied
- skips no-op commits
- returns structured commit failures instead of throwing resolver errors

`WildPathActor#toggleCondition()` now enters this resolver and supplies the Foundry-specific commit
adapter that delegates to `WildPathConditionEffect.applyDelta`.

## What It Does Not Do Yet

EffectResolver does not:

- apply generic ActiveEffects
- resolve effect durations
- create condition ticking schedules
- attach effects as ActionResolver consequences
- commit effects through `ResolutionTransaction`
- open reaction windows
- create chat output

Those should land as small effect slices. Conditions are first because they already have a stable
document implementation and give the rest of the system a concrete effect contract to build on.
