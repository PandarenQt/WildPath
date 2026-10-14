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
modifier. These snapshots are serializable resolution inputs, so AttackResolver remains independent
of Foundry documents while the runtime path no longer needs test-only defense injection.

**Every matching domain stacks** (maintainer decision, 2026-10-13). A melee weapon attack reads
`actor.getStatistic(["attack.weapon", "attack.melee", "attack"], {item, tags})`, and a modifier counts
once if it targets any of those domains. Whether a modifier applies depends on where it comes from
and whether the attack is eligible:

- an **Action** Item's own modifiers apply only to that Action (a +2 sword's bonus is on the sword's
  attack, not on every attack);
- Features, Gear and effects apply Actor-wide (proficiency on `attack`, an archery feat on
  `attack.ranged`);
- a modifier's predicate sees the statistic's `item` and `tags`: the attack type plus the Action's
  tags. A feat can therefore restrict itself with `{tagsAny: ["ranged"]}`.

Defenses stack the same way (`defense.<key>` plus `<key>`).

**Ability modifiers (2024, maintainer decision 2026-10-14).** An attack adds an ability modifier on top of its
Modifiers (`attackAbility` and `resolveActorAttackStatistic`, `helpers/combat-statistics.mjs`). The ability is the
first of these that applies:
1. the attack's own `ability`, for example a thrown melee weapon naming Might;
2. for a spell attack (`statistic: "spell"`, or an Action tagged `spell`), the creature's spellcasting ability;
3. for a weapon with the `finesse` property (`attack.properties: ["finesse"]`), the better of Might and Agility;
4. otherwise Might in melee and Agility at range.

Weapon damage adds the same modifier once. The runtime passes it as `damage.modifierTotal` when the Action has
a `weapon-base` damage component and the attack is not a spell attack. It goes on the first weapon component, or
else the first component (rolls.md, "Damage and healing rolls").
- **Rolled damage.** It is the damage roll's flat modifier, so a critical hit doubles only the dice
  (`1d8 + 3` becomes `2d8 + 3`).
- **Fixed damage**, such as an Unarmed Strike's 1, adds it to the first weapon component, and the result is
  never below 0.

Live (GM browser, 14.369): a rogue with Agility 18 and Might 12 used a finesse dagger. It rolled `1d20 + 4` to hit
and `1d4 + 4` damage.
