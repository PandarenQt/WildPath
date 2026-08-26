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
- carries concentration metadata so ConcentrationResolver and EffectLifecycleResolver can remove
  linked effects when concentration breaks
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

`module/resolvers/effect-lifecycle-resolver.mjs`:

- reads committed condition lifecycle metadata
- plans condition removal when duration metadata expires
- plans condition removal when linked concentration metadata breaks
- returns mutation plans instead of mutating ActiveEffects

`module/resolvers/effect-lifecycle-commit-resolver.mjs`:

- runs lifecycle planning for supplied Actors
- commits resulting condition removals through `TargetMutationCommitResolver`
- requires explicit authority and uses `ResolutionTransaction`

`module/resolvers/concentration-resolver.mjs`:

- normalizes already-resolved concentration save decisions
- emits `concentration.broken` lifecycle events when the decision failed
- does not roll dice or compute DCs

`WildPathActor#toggleCondition()` now enters this resolver and supplies the Foundry-specific commit
adapter that delegates to `WildPathConditionEffect.applyDelta`.

ActiveEffect system data can also persist `ruleElements`. The EffectResolver does not interpret
those entries directly yet; owning domains collect and consume the relevant contribution bundles
when they are ready. Today, `Modifier` RuleElements on applicable ActiveEffects feed Actor
statistics through `WildPathActor#getStatistic(domain)`.

## What It Does Not Do Yet

EffectResolver does not:

- apply generic ActiveEffects
- decrement and persist remaining duration counters
- create condition ticking schedules
- roll concentration checks or decide when a check is required
- compute concentration DCs
- commit generic non-condition effects through `ResolutionTransaction`
- open reaction windows
- create chat output

Those should land as small effect slices. Conditions are first because they already have a stable
document implementation and give the rest of the system a concrete effect contract to build on.
Save-based applicability belongs in `ActionResolver` after `SaveResolver` outcomes exist. Duration
and concentration lifecycle enforcement belongs in effect lifecycle adapters rather than in
condition data preparation or sheet rendering; the current Foundry adapter covers combat start/turn
duration events, and the current ConcentrationResolver can feed failed already-known decisions into
that lifecycle path.
