# ActionResolver

`module/resolvers/action-resolver.mjs` is now the current action entry point. It handles the
existing cost behavior plus optional target validation and optional attack-outcome resolution when
callers provide the required plain data.

## Current Flow

```text
Action item
-> ActionContext
-> ActionResult
-> optional TargetResolver target validation
-> optional AttackResolver attack outcome
-> ResourceResolver payment plan
-> Actor resource mutation plan
-> optional Actor update commit
```

The resolver emits semantic automation events for:

- action declared
- targets selected, when target data or target requirements are supplied
- attack roll
- attack hit
- attack miss
- payment required
- payment committed

The payment committed event is emitted only by the execution adapter after the Actor update step
returns successfully.

## What It Does Now

`planActionResolution()`:

- builds an `ActionContext`
- validates source/action basics
- optionally resolves targets through `TargetResolver`
- optionally resolves supplied attack roll data through `AttackResolver`
- resolves Action item activation cost through `ResourceResolver`
- records a target-selection consequence when targets are resolved
- records an attack-resolution consequence when attack data is supplied
- records a resource-payment consequence
- records a resource-payment mutation plan
- returns an `ActionResult`

`executeActionResolution()`:

- runs the same planning flow
- commits resource mutation plans through `actor.update()`
- returns the resulting `ActionResult`

`WildPathActor#useAction()` now uses `executeActionResolution()` while preserving its current
boolean return behavior.

## What It Does Not Do Yet

The current resolver does not:

- prompt for targets
- validate ranges
- derive attack bonuses or target defenses from Actor documents
- resolve saves
- roll dice
- apply damage or healing
- apply ActiveEffects
- open reaction windows
- create chat output

Those are future ActionResolver slices. The optional attack step consumes already-known numeric roll
and defense data; it does not own roll UI or Foundry statistic gathering. This module exists so
current action use already enters the same pipeline shape that those slices will extend.

## Next Resolver Slice

The next resolver slice should either add a basic SaveResolver or begin wiring DamageResolver into
ActionResolver after attack outcomes. The full WeaponSizePolicy expansion can now build on damage
components explicitly marked as weapon-size-scalable.
