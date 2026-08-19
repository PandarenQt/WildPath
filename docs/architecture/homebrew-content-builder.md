# Homebrew Content Builder Release Target

This document records the **finished-product** target for Wild Path's homebrew content builder.
It is not a near-term scaffold task. It should be treated as a release-readiness standard once the
automation engine, resolver pipeline, action economy, triggers, effects, areas, and movement
systems are mature enough to execute the content the builder creates.

## Product Goal

Wild Path should let an ordinary GM create deeply automated homebrew without programming, JSON
editing, selector syntax, Foundry hook knowledge, or internal engine concepts.

The builder must translate familiar tabletop language into Wild Path's structured mechanics:

```text
Applies to: Melee weapon attacks
Effect: +2 Attack
```

not:

```text
RuleElement selector + predicate JSON
```

Developer/debug views may expose internals, but ordinary homebrew must not require them.

## Supported Content

The finished builder should support:

- monsters and NPCs
- spells
- weapons, armor, general items, and consumables
- features, passive abilities, active abilities, and reactions
- conditions
- resources and action-economy grants
- companion abilities
- monster abilities
- Legendary Actions and Lair Actions
- auras and persistent areas
- summons
- custom actions

These categories should share generic mechanics. A monster attack, weapon attack, spell attack,
and feature attack should compile to the same underlying action/attack definition model.

## Unified Builder

The product should have one coherent Content Builder system with reusable sections, not many
unrelated editors.

Common reusable builder components should include:

- action activation and costs
- targeting, range, and area
- attacks, saves, and ability checks
- damage and healing
- conditions and effects
- resources and resource costs
- durations
- triggers and reactions
- movement
- scaling and formulas
- choices
- summoning
- modifiers

Progressive disclosure matters: basic content should start with common fields, and only reveal
advanced configuration when relevant.

## Action Builder

The Action Builder is the central authoring surface. It should offer templates such as:

- Melee Attack
- Ranged Attack
- Spell Attack
- Saving Throw Ability
- Area Saving Throw
- Healing Ability
- Buff
- Debuff
- Reaction
- Aura
- Movement Ability
- Summon
- Legendary Action
- Lair Action
- Passive Ability
- Custom

Templates create sensible starting structures, but the resulting action remains fully editable.

## Effect, Modifier, Trigger, and Condition Builders

The Effect Builder should present familiar choices like Deal Damage, Heal, Apply Condition, Grant
Resistance, Grant Movement, Grant Resource, Create Area, Summon Creature, Grant Action, or Modify
Action Economy.

The Modifier Builder should let users say things like:

```text
Modify: Attack Roll
Amount: +2
Applies To: Ranged weapon attacks
```

The Trigger Builder should read like a tabletop rule:

```text
When: You hit with a melee attack
Then: Deal 1d6 Fire damage
```

Conditions should reuse triggers, modifiers, durations, effects, and resources rather than getting
condition-specific runtime code.

## Action Economy Integration

The builder must expose the generic action-economy foundation in user-friendly terms:

- Action
- Bonus Action
- Reaction
- Movement
- Legendary Action points
- Lair Actions
- extra unrestricted Actions
- restricted extra Actions
- additional Reactions
- custom action resources
- additional movement resources

Homebrew authors should be able to configure these without writing predicates manually. Internally,
the builder can compile restrictions into predicates and payment capabilities.

## Movement Homebrew

Users author canonical movement distances:

```text
Grant Movement: 15 ft
Mode: Flying
```

Runtime display and spending may be distance or fields depending on world settings and scene grid.
The builder must not make the author permanently choose a feet-vs-fields storage format.

## Formula and Scaling Builders

Common formulas must be visual and safe, not arbitrary JavaScript.

Supported formula pieces should include:

- fixed number
- dice
- ability modifier
- proficiency bonus
- character level
- class level
- spell level
- slot level
- resource value
- add, multiply, divide, and round down

Scaling should have dedicated UI for common cases such as spell-slot scaling, character-level
scaling, and resource maximum scaling.

## Validation and Rules Summary

Every major builder should provide:

- live human-readable rules summary generated from structured mechanics
- friendly validation messages tied to the relevant section and field
- no reliance on prose descriptions as the source of automation

Example validation:

```text
This action deals damage but currently has no target.
```

not:

```text
Invalid ActionDefinition
```

## Test and Preview

The finished builder needs a Test/Preview feature that uses the real resolution engine in dry-run
or transaction-planning mode.

Users should be able to choose source actors, target actors, and optional roll results, then see a
synthetic resolution summary without permanent mutation.

## Round-Trip Editing

Builder-created content must satisfy:

```text
Builder -> structured definition -> save -> reopen -> Builder
```

without losing meaning. The domain schema remains the source of truth; UI state must not become the
canonical mechanics model.

## Duplicate, Compendium, Import, and Export

The finished product should support:

- duplicate / copy / save as new
- reference existing vs create independent copy
- Foundry Compendium workflows
- homebrew packs
- schema-versioned import/export
- dependency detection
- include-dependencies workflows
- safe IDs
- no exported executable JavaScript for ordinary content

## Accessibility and UX Standard

User-facing text should use tabletop terminology:

```text
When can this happen?
Who can this target?
What happens on a successful save?
```

instead of:

```text
Trigger Predicate
Target Entity Filter
Success Resolution
```

## Release Acceptance Examples

A non-programmer should be able to create these without documentation:

- Flaming Longsword: melee attack, 1d8 Slashing plus 1d6 Fire
- Flame Burst: Action, 60 ft, 15 ft sphere, DEX save, 4d6 Fire, half on success
- Passive feature: while raging, +2 melee damage
- Triggered feature: when you hit with a melee attack, deal +1d6 Fire once per turn
- Reaction: when hit, spend Reaction, gain +5 AC for that attack
- Aura: allies within 10 ft gain +1 AC
- Custom resource: Spirit Points, maximum 2 x proficiency bonus, recover on long rest
- Monster: actions, reactions, and Legendary Action points

## Deferred Until Engine Maturity

Do not build a polished builder that creates fake or non-executable mechanics. If the engine lacks
a primitive needed by the builder, implement the reusable engine primitive first, test it, then
surface it through the builder.

This feature depends on the mature versions of:

- ActionResolver
- ResourceResolver
- ResolutionTransaction
- EventBus / trigger system
- ReactionEngine
- AreaResolver
- MovementEngine
- formula/value-expression system
- import/export and migration infrastructure
