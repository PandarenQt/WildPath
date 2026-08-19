# ActionResolver

`module/resolvers/action-resolver.mjs` is now the current action entry point, but it intentionally
implements only the existing cost-only behavior.

## Current Flow

```text
Action item
-> ActionContext
-> ActionResult
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

## What It Does Now

`planActionResolution()`:

- builds an `ActionContext`
- validates source/action basics
- resolves Action item activation cost through `ResourceResolver`
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

The next ActionResolver slice should integrate `TargetResolver`, attach final target contexts to
the `ActionResult`, and emit `targets.selected` before attack/save/damage resolution is introduced.
