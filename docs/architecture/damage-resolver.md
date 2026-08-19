# DamageResolver

`module/resolvers/damage-resolver.mjs` is the pure structured-damage foundation for future action
damage, healing separation, resistance/immunity handling, and WeaponSizePolicy integration.

## Current Flow

```text
damage components
-> component validation
-> damage-type totals
-> scalable/unscaled component partition
-> optional per-target damage results
```

The resolver accepts already-known numeric component amounts. It does not roll dice. Dice are
preserved as structural metadata so later systems can inspect, scale, or double dice before rolls
are finalized.

`ActionResolver` can now call this resolver as an optional consequence step after attack outcomes
and before resource payment planning. When an attack misses, supplied damage is skipped rather than
turning the action into a failed resolution.

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
- records excluded/unselected targets as skipped audit entries
- does not mutate target contexts or damage components

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
- apply resistance, immunity, or vulnerability
- apply target damage overrides
- implement critical hits
- implement weapon-size scaling
- create chat output

Those remain separate slices. Critical handling should operate on already-scaled dice, and
WeaponSizePolicy should scale only components marked with `weapon-size` metadata.

## Next Integration

The next damage slice can apply WeaponSizePolicy to manufactured weapon damage components before
damage resolution. Foundry adapters still need to gather damage rolls and Actor durability fields
before any document mutation is possible.
