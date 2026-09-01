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

Foundry adapters gather the roll total, natural die, source attack modifier, and target defense
values before this resolver runs, then pass plain values into it. The normal Foundry Action-use
runtime snapshots target defenses from canonical Actor data as:

```text
actor.system.defenses.<key>.value
+ actor.getStatistic("defense.<key>").totalModifier
```

When an ActionDefinition declares an attack statistic, the runtime also snapshots the source roll
modifier from `actor.getStatistic("attack.<statistic>").totalModifier`. These snapshots are
serializable resolution inputs, so AttackResolver remains independent of Foundry documents while the
runtime path no longer needs test-only defense injection.
