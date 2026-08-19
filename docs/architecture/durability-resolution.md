# Durability Resolution

`module/resolvers/durability-resolver.mjs` is the mutation-planning boundary for Actor durability
resources such as health.

## Current Flow

```text
Actor system resource snapshot
-> damage or healing amount
-> clamped resource update plan
-> optional Foundry Actor.update commit adapter
```

The resolver does not read canvas state, inspect selected targets, apply resistance/immunity, or
decide who has authority to update a document. Callers provide the target Actor system data and a
resolved amount.

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

## What It Does Not Do Yet

DurabilityResolver does not:

- apply resistance, immunity, vulnerability, or absorption
- choose target Actors from target refs
- coordinate multiple target updates
- open reaction windows
- create chat output
- decide GM/socket authority
- rollback partial multi-Actor commits

Those belong in later ActionResolver/transaction and Foundry adapter slices.
