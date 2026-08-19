# WeaponSizePolicy

Wild Path models weapon size as a rules policy, not as a special case inside attacks, damage,
Actors, monster code, transformations, or individual weapon definitions.

> Weapon size, creature size, Heavy, and Reach are independent rule concepts. They may interact
> through rules policies, but none should be inferred from another.

## Concepts

Creature size is the Actor or Token creature scale used by tactical footprint and range systems.
Weapon designed size is the creature size the weapon is physically built for. Effective weapon size
is the weapon's current size after future resizing effects, transformations, or explicit content
overrides. Effective wielder size is the wielder's current creature size after future size changes.

These values are related but not interchangeable.

```text
Huge creature + Medium weapon != Huge creature + Huge weapon
```

A weapon does not gain reach merely because it is physically larger. Reach comes from weapon
properties, attack definitions, Actor features, RuleElements, or tactical range policy.

## Current Code

`module/helpers/weapon-sizing.mjs` now provides:

- authoritative standard size rank comparison
- `WeaponSizePolicy` provider objects
- 2014 oversized weapon behavior
- independent neutral 2024 behavior
- configurable house-rule behavior
- structured wieldability results
- structured damage-scaling results
- explicit weapon-size-scalable component detection

The current policy layer is pure JavaScript and does not read Foundry settings, Actors, Items,
canvas state, sheets, chat, or DOM.

## Wieldability

Wieldability answers whether a creature can physically use a weapon of the weapon's effective size.
It does not answer proficiency, Strength requirements, Heavy-property requirements, inventory
capacity, or whether the item can be carried.

The result is structured:

```text
usable
sizeDifference
attackState.disadvantage
reasonCodes
appliedPolicies
trace
```

Under the 2014 policy, the default behavior is:

- same size or smaller weapon: usable
- one size larger weapon: usable with attack disadvantage
- two or more sizes larger weapon: unusable

The house-rule policy can change those thresholds without changing AttackResolver.

## Damage Scaling

Damage scaling operates on structured damage components, not on labels or final rolled totals.
Only components explicitly marked as `weapon-size` scalable are scaled.

```text
1d8 slashing, scalingCategory: weapon-size
1d6 fire, scalingCategory: none
```

For a Large 2014 weapon, the result is:

```text
2d8 slashing
1d6 fire
```

If the fire component explicitly opts into `weapon-size`, it can scale too. The policy follows
component metadata rather than damage type assumptions.

The 2014 policy uses the DMG-style monster weapon convention:

- Tiny/Small/Medium: x1 base weapon dice
- Large: x2 base weapon dice
- Huge: x3 base weapon dice
- Gargantuan: x4 base weapon dice

The 2024 policy is intentionally neutral until a verified general 2024 oversized-weapon rule exists.
It does not silently reuse the 2014 multipliers.

## Natural Weapons And Monsters

Natural weapons such as bite, claw, tail, slam, or gore do not automatically use manufactured weapon
size scaling. Monster attacks may use explicit damage, or they may opt into WeaponSizePolicy through
their action/weapon definition. The policy should not infer scaling from creature size alone.

## Transformations

Future transformations and size-changing effects should provide explicit effective sizes:

```text
effectiveWielderSize
effectiveWeaponSize
```

If an Actor grows but the weapon remains Medium, Medium weapon damage remains Medium-sized. If both
Actor and weapon become Large, the active policy can scale Large weapon damage.

## Heavy And Reach

Heavy is a weapon-property policy. Reach is a tactical range policy. WeaponSizePolicy does not
implement either.

This preserves both 2014 Heavy behavior, where Small/Tiny creatures may have disadvantage with
Heavy weapons, and 2024 Heavy behavior, where ability-score requirements matter instead. Those
rules belong in a future WeaponPropertyPolicy, not in WeaponSizePolicy.

## Homebrew Extension

The future Homebrew Content Builder should expose friendly fields such as:

```text
Designed For: Medium
Effective Size: Use ruleset default
Size Scaling: Use WeaponSizePolicy
```

Advanced content should also support explicit damage, no scaling, or custom multipliers.

## Not Yet Implemented

The policy foundation is not yet wired into ActionResolver or DamageResolver execution. It does not
read system settings, perform migrations, implement transformations, implement Enlarge/Reduce, alter
item weight, apply Heavy rules, alter reach, or provide homebrew UI.
