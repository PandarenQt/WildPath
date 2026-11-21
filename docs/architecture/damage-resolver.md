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
- gives a context several `instances` one result each (Magic Missile's darts), and a context with an `instance` (a
  repeatable attack's hit) the components rolled for that hit: `ActionResolver` picks `damage.byInstance[instance]`
  when it has one, else the Action's own roll
- records excluded/unselected targets as skipped audit entries
- does not mutate target contexts or damage components

`adjustDamageResult()`:

- applies immunity first, per component
- applies damage reduction next (flat, scaled, and already-rolled amounts), since 2024 applies
  Resistance and Vulnerability "after all other modifiers" (Q94 (a) default; Heavy Armor Master,
  Deflect Attacks, Stone's Endurance)
- then applies Resistance, rounds down, then applies Vulnerability, over the total of each damage type
  within the damage result, which is one hit (Q20): two 3 Fire parts with Resistance deal 3, and
  5 Fire with both deals 4. The strongest Resistance and the strongest Vulnerability count. Parts
  of one type are totalled when they get the same strongest multipliers (an `ignoreResistance` part,
  or one a tag-matched Resistance halves while the others stay whole, is apart); an adjustment with
  `wholeHit: true` (Uncanny Dodge's halving) is over the hit's total across types when only such
  adjustments match a part (Q94 (b) default), while one of every type without it (Petrified's) is
  per type. The
  total is split back over the parts in proportion (largest remainder first), and each part keeps a
  `multiplier` entry with its own original and adjusted amount for the card's breakdown. A rider's
  damage joins its attack's components, so it is in the same hit; each Magic Missile dart, and each
  repeated ray (`damageInstance`), is its own damage result
- applies damage absorption to what is left, like Temporary Hit Points
- supports flat, scaled, and already-rolled absorption amounts
- records which resource receives absorbed damage
- applies a Damage Threshold last
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
