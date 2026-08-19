# AttackResolver

`module/resolvers/attack-resolver.mjs` is the pure attack-vs-defense foundation for future
weapon, spell, and feature attacks.

## Current Flow

```text
attack roll total / natural die
-> target defense
-> attack policy
-> per-target attack outcome
```

The resolver accepts already-known numeric roll data. That numeric data can come from Foundry dice,
physical dice entry, imported roll results, or later roll-request UI. Once the number exists, attack
outcome logic is the same.

`ActionResolver` can now call this resolver as an optional step after target validation and before
resource payment planning.

## What It Does Now

`resolveAttackAgainstDefense()`:

- normalizes a plain attack roll and target defense
- resolves hit, miss, critical hit, or critical miss
- supports natural critical hit/miss policy
- supports hit-on-tie policy
- returns structured failure data for missing roll totals or defenses

`resolveAttackTargets()`:

- consumes selected `TargetResolver` target contexts or plain targets
- resolves each selected target against its own defense
- records excluded/unselected targets as skipped audit entries
- preserves partial failures when one target is missing a defense

## What It Does Not Do Yet

AttackResolver does not:

- roll dice
- read Actor statistics directly
- inspect selected canvas targets
- apply damage
- consume resources
- create chat messages
- mutate Actor, Token, or ActiveEffect documents

Foundry adapters should gather the roll total, natural die, and defense values from documents or UI,
then pass plain values into this resolver.

## Next Integration

Foundry adapters still need to use `WildPathActor#getStatistic(domain)` for attack bonuses and
target defenses, then pass the derived numbers into this resolver. Later DamageResolver work should
consume attack outcomes without moving hit/miss logic into damage code.
