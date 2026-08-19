# Durability Resolution

`module/resolvers/durability-resolver.mjs` is the mutation-planning boundary for Actor durability
resources such as health.

## Current Flow

```text
Actor system resource snapshot
-> adjusted damage or resolved healing amount
-> clamped resource update plan
-> optional explicit-authority target Actor commit adapter
```

The base durability resolver does not read canvas state, inspect selected targets, apply
resistance/immunity, or decide who has authority to update a document. Callers provide the target
Actor system data and a resolved amount.

`module/resolvers/damage-durability-resolver.mjs` is the pure bridge from resolved per-target
damage to target Actor durability mutation plans. It accepts target Actor systems and optional
damage adjustment profiles through opaque string refs such as `actor:abc123` or transitional raw
ids, then delegates each adjusted target amount to `DurabilityResolver`.

`module/resolvers/healing-durability-resolver.mjs` mirrors that bridge for resolved per-target
healing.

## What It Does Now

`createActorDamageMutationPlan()`:

- plans damage against `system.resources.health.value` by default
- clamps at zero
- records `appliedAmount` and `overflow`
- can consume a `DamageResolver` target result with a `total`

`createActorHealingMutationPlan()`:

- plans healing against `system.resources.health.value` by default
- clamps at resource maximum
- records `appliedAmount` and `overheal`

`createActorDurabilityMutationPlan()`:

- supports built-in Actor resources and custom pools
- returns a Foundry update path without mutating input data
- reports missing resources and invalid amounts explicitly

`commitActorDurabilityMutationPlan()`:

- is the thin Foundry adapter that calls `actor.update()`
- treats no-op plans as successful without calling `update()`

`planDamageDurabilityMutations()`:

- consumes a successful `DamageResolver` target resolution
- applies optional target damage adjustment profiles before mutation planning
- looks up each target Actor system by string ref/id
- returns one durability mutation plan per resolved damage target
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
- calls the thin Actor update adapter for durability plans
- reports missing actors, authorization failures, and commit failures explicitly

## What It Does Not Do Yet

DurabilityResolver does not:

- apply absorption
- discover concrete Foundry target Actors from canvas state
- open reaction windows
- create chat output
- rollback partial multi-Actor commits

Those belong in later ActionResolver/transaction and Foundry adapter slices.
