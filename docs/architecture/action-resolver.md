# ActionResolver

`module/resolvers/action-resolver.mjs` is now the current action entry point. It handles the
existing cost behavior plus optional target validation and optional attack-outcome resolution when
callers provide the required plain data. It can also resolve supplied saving throws, resolve
structured damage and healing components as consequences, apply WeaponSizePolicy to explicitly
manufactured weapon damage, and attach target durability mutation plans when supplied target Actor
system snapshots. Damage durability planning can include absorption plans that convert part of the
incoming damage into health, shields, or another Actor resource.
When damage supplies a `saveOutcomePolicy`, the resolver can adjust per-target damage amounts from
the already-resolved save outcomes, such as half damage on a successful save.
When effects supply condition definitions, it can also plan condition consequences for selected,
hit, or save-matching targets while carrying duration, spell-origin, and concentration metadata.
During execution, condition effects commit through the same explicit-authority target mutation
transaction path as durability.

## Current Flow

```text
Action item
-> ActionContext
-> ActionResult
-> optional TargetResolver target validation
-> optional AttackResolver attack outcome
-> optional SaveResolver save outcome
-> optional WeaponSizePolicy damage dice scaling
-> optional save-outcome damage policy
-> optional DamageResolver damage consequence
-> optional DamageAdjustmentResolver per-target adjustment
-> optional HealingResolver healing consequence
-> optional target durability damage/absorption/healing mutation plans
-> optional EffectResolver condition mutation plans
-> ResourceResolver payment plan
-> Actor resource mutation plan
-> optional explicit-authority ResolutionTransaction commit
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

The payment committed event is emitted only by the execution adapter after the transaction returns
successfully.

## What It Does Now

`planActionResolution()`:

- builds an `ActionContext`
- validates source/action basics
- optionally resolves targets through `TargetResolver`
- optionally resolves supplied attack roll data through `AttackResolver`
- optionally resolves supplied save roll data through `SaveResolver`
- optionally applies WeaponSizePolicy to manufactured weapon damage components marked as scalable
- optionally applies save-outcome damage policies such as `success: "half"`
- optionally resolves supplied damage components through `DamageResolver`
- optionally applies target damage adjustments, reductions, and absorptions before durability
  planning
- optionally resolves supplied healing components through `HealingResolver`
- optionally records target durability mutation plans for damage and healing
- optionally plans condition effect consequences through `EffectResolver`
- filters save-gated condition effects from already-resolved save outcomes
- carries duration, spell-origin, source, and concentration metadata on condition mutation plans
- resolves Action item activation cost through `ResourceResolver`
- records a target-selection consequence when targets are resolved
- records an attack-resolution consequence when attack data is supplied
- records a damage-resolution consequence when damage data is supplied
- records a healing-resolution consequence when healing data is supplied
- records an effects-resolution consequence when condition effect data is supplied
- records a resource-payment consequence
- records target durability and resource-payment mutation plans
- returns an `ActionResult`

`executeActionResolution()`:

- runs the same planning flow
- can derive target Actor system snapshots from supplied target Actors
- prepares target durability transaction operations only with explicit authority
- prepares target condition-effect transaction operations only with explicit authority
- commits target durability, target condition effects, and source resource-payment operations through a single
  `ResolutionTransaction`
- rolls back already-committed target/source updates in reverse order when a later Actor update
  fails
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
- commit generic non-condition ActiveEffects
- tick durations or break concentration
- open reaction windows
- create chat output

Those are future ActionResolver slices. The optional attack, save, damage, healing, and condition
steps consume already-known numeric roll, defense/DC, damage, healing, and effect-definition data;
they do not own roll UI, Foundry statistic gathering, generic ActiveEffect document commits,
duration ticking, or concentration checks. Condition effects can commit when execution receives
target Actors and explicit authority; the commit adapter rolls back condition creates, updates, and
deletes if a later transaction operation fails. WeaponSizePolicy integration scales structural dice
and records provenance for explicitly manufactured weapon damage, but it does not roll those dice
or invent final damage amounts. This module exists so current action use already enters the same
pipeline shape that those slices will extend.

## Next Resolver Slice

The next resolver slice should either add concentration-check requirement/DC planning after damage
is applied or extend EffectResolver from conditions to generic ActiveEffect creation/removal.
Direct Actor durability mutation remains outside DamageResolver itself.
