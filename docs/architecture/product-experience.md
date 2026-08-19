# Product Experience Direction

The finished game system name is **Wild Path**. Internal package identifiers can remain
`wildpath`, but user-facing surfaces should use the spaced name.

## Action Bar

The action bar should become the primary player command surface. It should display available
actions, bonus actions, reactions, movement budgets, class/feature actions, consumables, and
contextual abilities. Disabled states should be driven by structured resolver availability reasons,
not UI-only checks.

## Combat Carousel

The combat carousel should show turn order, current/next actors, resource refresh context, reaction
availability, and important statuses. It should call into the same turn/resource services as the
automation layer rather than maintaining its own combat state.

## Point-Budget Randomizer Loop

Wild Path should eventually support reusable point-budget randomizer loops for:

- encounters
- summons
- treasure
- character and NPC creation
- magic item generation
- other GM-facing procedural tools

The common pattern should be:

```text
Budget
-> weighted candidate pool
-> constraints/predicates
-> draft result
-> validation
-> reroll/adjust loop
-> commit generated content
```

This should be implemented as a generic generator foundation, not as separate one-off randomizers.
Generated content should remain inspectable, explainable, and editable before it is committed.

## Homebrew Content Builder

The finished product should include a polished, Foundry-native homebrew Content Builder for GMs who
understand tabletop mechanics but do not program. It should use reusable builder components for
actions, effects, modifiers, triggers, resources, areas, formulas, scaling, and validation.

The builder is a release-target feature, not a current scaffold requirement. It must save real
Wild Path structured mechanics that the automation engine can execute. See
`docs/architecture/homebrew-content-builder.md`.
