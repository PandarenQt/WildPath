# ActionResolver

`module/resolvers/action-resolver.mjs` is now the current action entry point, but it intentionally
implements only the existing cost-only behavior.

## Current Flow

```text
Action item
-> ActionContext
-> ActionResult
-> optional TargetResolver target validation
-> ResourceResolver payment plan
-> Actor resource mutation plan
-> optional Actor update commit
```

The resolver emits semantic automation events for:

- action declared
- payment required
- payment committed

The payment committed event is emitted only by the execution adapter after the Actor update step
returns successfully.
The targets selected event is emitted only when target data or target requirements are supplied.

## What It Does Now

`planActionResolution()`:

- builds an `ActionContext`
- validates source/action basics
- optionally resolves targets through `TargetResolver`
- resolves Action item activation cost through `ResourceResolver`
- records a target-selection consequence when targets are resolved
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
- resolve attacks or saves
- roll dice
- apply damage or healing
- apply ActiveEffects
- open reaction windows
- create chat output

Those are future resolver slices. This module exists so current action use already enters the same
pipeline shape that those slices will extend.

## Next Resolver Slice

The next resolver slices should add attack/save/damage/healing/effect resolution one at a time,
using the target contexts already attached by the optional TargetResolver step.
