# DamageResolver

`module/resolvers/damage-resolver.mjs` is the pure structured-damage foundation for action damage.
`module/resolvers/damage-adjustment-resolver.mjs` applies per-target immunity, resistance,
vulnerability, damage absorption, and damage reduction after damage is resolved and before
durability mutation plans and concentration check requests are created.

## Current Flow

```text
damage components
-> component validation
-> damage-type totals
-> scalable/unscaled component partition
-> optional per-target damage results
-> optional per-target damage adjustment
-> optional concentration check planning from adjusted damage
```

The resolver accepts already-known numeric component amounts. It does not roll dice. Dice are
preserved as structural metadata so later systems can inspect, scale, or double dice before rolls
are finalized.

`ActionResolver` can now call this resolver as an optional consequence step after attack outcomes
and before resource payment planning. When an attack misses, supplied damage is skipped rather than
turning the action into a failed resolution.
If damage data includes a manufactured weapon-size context, `ActionResolver` applies
WeaponSizePolicy before calling this resolver, so scaled structural dice and scaling provenance are
present on the damage components that this resolver totals.

## What It Does Now

`resolveDamageComponents()`:

- normalizes plain damage components
- requires resolved numeric damage amounts
- groups totals by damage type
- preserves component provenance
- partitions weapon-size-scalable components from unscaled components
- reports invalid or missing component amounts without throwing

`resolveDamageTargets()`:

- consumes selected target contexts or plain targets
- resolves the same component set for each selected target
- can accept target-specific prepared components for upstream policies such as save-for-half damage
- records excluded/unselected targets as skipped audit entries
- does not mutate target contexts or damage components

`adjustDamageResult()`:

- applies immunity first
- applies resistance and vulnerability as multipliers, with floor rounding by default
- applies damage absorption after typed multipliers and before ordinary reductions
- supports flat, scaled, and already-rolled absorption amounts
- records which resource receives absorbed damage
- applies damage reduction after absorption
- supports flat, scaled, and already-rolled reduction amounts
- keeps original and adjusted totals for audit

`DamageDurabilityResolver` can pass these adjusted totals to `ConcentrationResolver`, so
concentration DCs use the final damage taken after immunity, resistance, vulnerability,
absorption, and reduction.

## Component Provenance

Damage components should describe why they exist rather than relying on label parsing.

Examples:

```text
provenance: weapon-base
scalingCategory: weapon-size
```

```text
provenance: additional
scalingCategory: none
```

This is the contract WeaponSizePolicy needs later: a Huge manufactured weapon can scale base weapon
dice without also scaling poison, smite, sneak attack, or unrelated fire damage unless those
components explicitly opt in.

## What It Does Not Do Yet

DamageResolver does not:

- roll damage dice
- apply Actor HP or resource mutations
- apply target damage overrides
- implement critical hits
- roll or prompt concentration saves
- create chat output

Those remain separate slices. Damage adjustment is handled by `DamageAdjustmentResolver` rather
than `DamageResolver` so the base damage total remains inspectable. Critical handling should
operate on already-scaled dice, and WeaponSizePolicy scales only components marked with
`weapon-size` metadata.

## Next Integration

Foundry adapters still need to gather damage rolls, Actor durability fields, and concentration
state before document mutation or prompts. `ActionResolver` can now attach durability plans for
adjusted damage, including absorption-to-resource plans, and can expose concentration check
requests when supplied concentration state snapshots are present.
