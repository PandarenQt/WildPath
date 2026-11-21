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

## Condition instances per source (Q19, 2026-11-21)

A non-stacking condition (Grappled, Restrained, Burning) is one ActiveEffect per source: the Action that gave it and
its source creature (`conditionSourceKey({actionDefinitionId, sourceRef})`, effectGroupKey's pair; an effect no Action
gave, the GM's toggle, is its own, `conditionEffectSourceKey`). Each instance keeps its own duration, concentration,
escape DC and region; the creature has the condition (`actor.statuses`) while any remains.

- Applying finds its own source's instance (the same Action and source again refreshes it, Q93 (e)) and otherwise
  makes a new one beside the others, the GM's included (Q19 (d)). A plan with neither an Action id nor a source
  matches any instance (applied where the condition already is, it changes nothing).
- A new instance beside another is created directly from that instance's status data (name, image, `system` with its
  rules: Burning's Trigger), since V14's `Actor#toggleStatusEffect` answers `true` and creates nothing while one exists.
- A removal naming its instance (`metadata.effectId`: an Escape's hold, a lifecycle end) ends that one, and nothing
  once it is gone. A removal naming none (a cure, standing up, the sheet's toggle-off through
  `WildPathConditionEffect.applyDelta`) ends every instance: the plan carries `allInstances: true`, the commit reports
  the others as `alsoRemoved` snapshots and rollback restores each by its own id (Q19 (b)).
- Custom effects and stacking conditions (Exhaustion) stay one effect, matched as before (Q93 (d)).
- Several instances' Triggers due together (two Burnings at a turn start) are one damage: `actor.applyConditionTriggers`
  joins the same condition's damage of one type on one event into one turnDamage Action, each instance adding its own
  dice (`{type: "add", terms}`: 2d4), so one concentration check and Resistance on the total (Q19 (c), Q93 (b)).
- Grappled's "other than the grappler" reads `attack.fromTarget.grappled` per instance, so attacking any of its
  grapplers avoids the Disadvantage (Q93 (c)).

`WildPathActor#toggleCondition()` now enters this resolver and supplies the Foundry-specific commit
adapter that delegates to `WildPathConditionEffect.applyDelta`.

ActiveEffect system data can also persist `ruleElements`. The EffectResolver does not interpret
those entries directly yet; owning domains collect and consume the relevant contribution bundles
when they are ready. Today, `Modifier` RuleElements on applicable ActiveEffects feed Actor
statistics through `WildPathActor#getStatistic(domain)`.

`module/resolvers/condition-trigger-resolver.mjs` is the first owning-domain consumer for condition
RuleElements. It collects condition `Trigger` RuleElements, matches semantic events such as
`turn.started`, and plans durability changes through `DurabilityResolver`. `Bleeding` now uses this
path. Legacy `system.dot` ticks are translated into synthetic Trigger RuleElements only when a
condition effect has no persisted `ruleElements`; the direct `Actor.applyConditionTicks()` loop is
no longer the authoritative execution path.

## What It Does Not Do Yet

EffectResolver does not:

- apply generic ActiveEffects
- decrement and persist remaining duration counters
- create broad condition ticking schedules beyond the current Trigger RuleElement durability slice
- roll concentration checks or decide when a check is required
- compute concentration DCs
- commit generic non-condition effects through `ResolutionTransaction`
- open reaction windows
- create chat output

Those should land as small effect slices. Conditions are first because they already have a stable
document implementation and give the rest of the system a concrete effect contract to build on.
Save-based applicability belongs in `ActionResolver` after `SaveResolver` outcomes exist. Duration
and concentration lifecycle enforcement belongs in effect lifecycle adapters rather than in
condition data preparation or sheet rendering; the current Foundry adapter covers managed
turn-start duration events, and the current ConcentrationResolver can feed failed already-known
decisions into that lifecycle path. Managed turn-end and round duration events remain follow-up
Combat lifecycle work.
