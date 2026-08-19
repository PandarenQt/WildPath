# ActionResolver

`module/resolvers/action-resolver.mjs` is now the current action entry point. It handles the
existing cost behavior plus optional target validation and optional attack-outcome resolution when
callers provide the required plain data. It can also resolve supplied saving throws, resolve
structured damage components as a non-mutating consequence, and apply WeaponSizePolicy to explicitly
manufactured weapon damage before that consequence resolves.

## Current Flow

```text
Action item
-> ActionContext
-> ActionResult
-> optional TargetResolver target validation
-> optional AttackResolver attack outcome
-> optional SaveResolver save outcome
-> optional WeaponSizePolicy damage dice scaling
-> optional DamageResolver damage consequence
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
- save roll
- save success
- save failure
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
- optionally resolves supplied save roll data through `SaveResolver`
- optionally applies WeaponSizePolicy to manufactured weapon damage components marked as scalable
- optionally resolves supplied damage components through `DamageResolver`
- resolves Action item activation cost through `ResourceResolver`
- records a target-selection consequence when targets are resolved
- records an attack-resolution consequence when attack data is supplied
- records a damage-resolution consequence when damage data is supplied
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
- derive save bonuses or save DCs from Actor documents
- roll dice
- apply Actor HP/resource damage or healing
- apply ActiveEffects
- open reaction windows
- create chat output

Those are future ActionResolver slices. The optional attack, save, and damage steps consume
already-known numeric roll, defense/DC, and damage-component data; they do not own roll UI, Foundry
statistic gathering, or Actor durability mutation. WeaponSizePolicy integration scales structural
dice and records provenance for explicitly manufactured weapon damage, but it does not roll those
dice or invent final damage amounts. This module exists so current action use already enters the
same pipeline shape that those slices will extend.

## Next Resolver Slice

The next resolver slice should connect save outcomes to damage consequence policies or add Actor
damage/healing mutation planning. Direct Actor durability mutation should remain outside
DamageResolver itself.
