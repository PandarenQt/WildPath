# Durability Resolution

`module/resolvers/durability-resolver.mjs` is the mutation-planning boundary for Actor durability
resources such as health.

## Current Flow

```text
Actor system resource snapshot
-> adjusted damage or resolved healing amount
-> optional post-damage absorption resource gain
-> optional concentration check requests from adjusted damage
-> clamped resource update plan
-> optional explicit-authority transaction operation
-> DocumentPersistencePort
```

The base durability resolver does not read canvas state, inspect selected targets, apply
resistance/immunity, or decide who has authority to update a document. Callers provide the target
Actor system data and a resolved amount.

Foundry callers obtain effective plain resource state through `foundryActorSystemSnapshot(actor)`:
detached `actor.toObject(true).system` source data plus explicitly validated prepared `value`/`max`
outputs for built-in resources and custom pools. Effective maximum includes authored base/bonus and
prepared modifier contributions. The exact synthetic Token Actor is used when supplied. Damage and
Healing do not read Foundry DataModels or compute preparation themselves; see
[the snapshot boundary](resolution-state.md#foundry-actor-system-snapshots).

`module/resolvers/damage-durability-resolver.mjs` is the pure bridge from resolved per-target
damage to target Actor durability mutation plans. It accepts target Actor systems and optional
damage adjustment profiles through opaque string refs such as `actor:abc123` or transitional raw
ids, then delegates each adjusted target amount to `DurabilityResolver`. Absorption plans are
planned after the remaining damage against a cloned Actor-system snapshot, so damage and absorption
against the same resource produce ordered updates without mutating caller data.
When supplied concentration states are present, it also asks `ConcentrationResolver` to plan
concentration check requests from the adjusted damage totals.

`module/resolvers/healing-durability-resolver.mjs` mirrors that bridge for resolved per-target
healing.

## What It Does Now

`createActorDamageMutationPlan()`:

- plans damage against `system.resources.health.value` by default
- clamps at zero
- is monotonic downward and never applies more than requested, even when current exceeds maximum
- records `appliedAmount` and `overflow`
- can consume a `DamageResolver` target result with a `total`

`createActorHealingMutationPlan()`:

- plans healing against `system.resources.health.value` by default
- clamps at resource maximum
- is monotonic upward and never applies more than requested
- treats current above maximum as no-op healing, with the entire amount recorded as overheal
- records `appliedAmount` and `overheal`

`createActorDurabilityMutationPlan()`:

- supports built-in Actor resources and custom pools
- returns a Foundry update path without mutating input data
- reports missing resources and invalid amounts explicitly

`commitActorDurabilityMutationPlan()`:

- is the thin commit helper that delegates Actor updates to `DocumentPersistencePort`
- treats no-op plans as successful without calling the persistence port

`planDamageDurabilityMutations()`:

- consumes a successful `DamageResolver` target resolution
- applies optional target damage adjustment profiles before mutation planning
- looks up each target Actor system by string ref/id
- returns one durability mutation plan per resolved damage target
- returns ordered absorption mutation plans when a damage adjustment converts incoming damage into
  healing, shields, or another Actor resource
- returns adjusted damage results for downstream audit and concentration planning
- can attach concentration check requests using final adjusted damage totals
- reports missing target Actor systems explicitly
- skips already-skipped damage targets without creating no-op document updates

`planHealingDurabilityMutations()`:

- consumes a successful `HealingResolver` target resolution
- looks up each target Actor system by string ref/id
- returns one healing mutation plan per resolved healing target
- records overheal through the underlying durability planner

`commitTargetMutationPlans()`:

- resolves target mutation plans back to supplied target Actors by ref/id
- requires explicit GM or caller-provided commit authority
- calls the persistence-backed durability commit helper for durability plans
- reports missing actors, authorization failures, and commit failures explicitly

`prepareTargetMutationCommitOperations()`:

- performs the same target Actor lookup and authority checks without mutating documents
- returns `ResolutionTransaction` operations for ActionResolver execution
- carries rollback updates from each durability mutation plan
- carries an optional `DocumentPersistencePort` into each transaction operation

## Direction And Amount Invariants

For finite non-negative resource values and requested amounts (subject to normal JavaScript number
precision), damage uses:

```text
to = max(current - amount, 0)
appliedAmount = current - to
overflow = max(amount - appliedAmount, 0)
```

Thus `to <= from`, `0 <= appliedAmount <= amount`, `overflow >= 0`, and
`appliedAmount + overflow = amount`. The upper resource maximum does not clamp damage. For example,
current 30, maximum 10, and amount 6 plans 30 -> 24, applied 6, overflow 0. A stale upper maximum
must never convert 6 requested damage into 20 applied damage. Damage beyond zero still overflows:
current 10 and amount 15 plans 10 -> 0, applied 10, overflow 5.

Healing uses:

```text
to = max(current, min(current + amount, max))
appliedAmount = to - current
overheal = max(amount - appliedAmount, 0)
```

Thus `to >= from`, `0 <= appliedAmount <= amount`, `overheal >= 0`, and
`appliedAmount + overheal = amount`. For valid current <= maximum, healing still clamps at the
effective maximum. For current > maximum, it preserves current with no update and records all
requested healing as overheal. It never lowers a resource to repair an inconsistent maximum.
These policies also apply to custom pools and absorption healing through the same planner.
Missing-resource and invalid-amount checks remain in place; this is not a replacement for Actor
preparation or a general resource-data migration.

## What It Does Not Do Yet

DurabilityResolver does not:

- discover concrete Foundry target Actors from canvas state
- open reaction windows
- create chat output

Those belong in later ActionResolver, reaction, UI, socket, and Foundry adapter slices.
