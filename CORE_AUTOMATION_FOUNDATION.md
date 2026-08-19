# Core Automation Foundation

Wild Path is currently an early Foundry VTT V14 system scaffold. The codebase has data models,
resource pools, action cost spending, declarative modifiers, conditions, and basic sheets. It
does not yet have the full BG3-style action resolution pipeline.

This document records the intended architecture so future implementation work has a clear target.
The finished game system name is **Wild Path**.

## Current Baseline

- Actor and Item data models define abilities, resources, custom pools, actions, gear, features,
  modifiers, and conditions.
- `WildPathActor#useAction` spends an Action item's resources only. It does not resolve targets,
  attacks, saves, damage, healing, effects, reactions, or areas.
- `WildPathActor#getStatistic(domain)` and `WildPathStatistic` are the current calculation engine.
  New mechanics should build on that domain/modifier model rather than creating one-off math.
- Resource max calculation is idempotent: persisted `base`/`bonus` values combine with transient
  per-prepare `modifierBonus` values.
- `module/helpers/action-economy.mjs` provides pure payment discovery/commit/refresh primitives
  for extensible action-economy resources.
- `module/helpers/movement.mjs` derives spendable movement budgets from canonical movement speed
  using distance or field measurement.
- Tactical grid and area topology are documented as a future gated milestone: gridded AoE should
  resolve to authoritative `GridFootprint` field sets, not Euclidean templates snapped to a grid.
- `module/helpers/grid-footprints.mjs` provides topology-aware creature size footprints, full
  footprint distance/reach, boundary vertices, and debug data for TokenGridFootprints.
- `module/helpers/tactical-areas.mjs` provides pure radial, line, cone, wall, and source-boundary
  placement helpers with preview/commit/resolution footprint identity.
- `module/helpers/tactical-area-resolution.mjs` composes placed tactical areas with target
  resolution while preserving placement provenance and the exact resolved field set.
- `module/helpers/targeting.mjs` provides pure target candidates, target sets, eligibility,
  refinement decisions, selection requests, and per-target override carriers.
- `module/helpers/inventory.mjs` provides pure inventory spaces, access grants, weight policies,
  transfer planning/commit, capacity checks, and containment-cycle prevention.

## Resolution Pipeline

Automated gameplay should flow through a common context:

```text
ActionDefinition
+ ActionContext
+ Source
+ Targets
+ Area
+ Resources
+ RollMode
+ RuleVersion

-> validation
-> targeting
-> roll requests
-> resolution
-> consequences
-> hooks/events
```

The UI should initiate that pipeline, not own the rules. Sheets, HUD controls, and chat buttons
should call resolution APIs; the rules and resolver layers should not depend on DOM, canvas, or
chat state.

## Resolver Modules

The first resolver implementations should live under `module/resolvers/`:

- `ActionResolver`: top-level orchestrator for validate, target, cost, roll, consequence, effect,
  and post-resolution hooks.
- `TargetResolver`: validates self, single-target, multi-target, and area target sets.
- `AttackResolver`: resolves attack rolls against target defenses.
- `SaveResolver`: resolves saving throws against DCs.
- `DamageResolver`: computes structured damage results before Actor mutation.
- `HealingResolver`: computes structured healing/restoration results before Actor mutation.
- `EffectResolver`: applies and removes ActiveEffects and conditions.
- `ResourceResolver`: centralizes spending, refunds, and resource validation.
- `ReactionResolver`: supports interrupt windows and reaction prompts.
- `AreaResolver`: handles instantaneous and persistent areas plus movement/turn triggers.

See `module/resolvers/README.md` for the concrete file-path map.

## Tactical Grid And Areas

For gridded Wild Path combat, the grid is the geometry. Rules define semantic shape and size; the
active tactical grid defines adjacency, direction, source-border placement, and affected fields.
Ordinary creature-originated Lines and Cones should originate from an eligible source Token's
tactical boundary vertex rather than token center.

This milestone is gated behind the core resolver/rules foundations and should land before
movement-path automation, opportunity attacks, auras, emanations, persistent hazards, and large
spell/content implementation. See `docs/architecture/tactical-grid.md` and
`docs/architecture/areas.md`.

## Targeting And Inventory

Targeting separates physical inclusion, base eligibility, target refinement, and per-target
resolution state. Inventory separates space ownership, access grants, containment, transfer
planning, and weight propagation. These foundations intentionally avoid UI assumptions and Foundry
document mutation. See `docs/architecture/targeting.md` and `docs/architecture/inventory.md`.

## Product Experience Goals

- Action bar: a tactical command surface driven by resolver availability results.
- Combat carousel: turn order and combat-resource state driven by the same combat/economy services
  as automation.
- Point-budget randomizer loop: reusable budgeted generators for encounters, summons, treasure,
  character/NPC creation, magic item generation, and similar GM tools.
- Homebrew Content Builder: a release-target, non-programmer authoring experience that compiles
  familiar tabletop configuration into executable Wild Path mechanics.

See `docs/architecture/product-experience.md` for the product-facing direction, and
`docs/architecture/action-economy.md` for the current economy/movement foundation. See
`docs/architecture/homebrew-content-builder.md` for the finished-product builder standard.

## Near-Term Order

1. Define `ActionContext` and `ActionResult` as plain data structures.
2. Extract existing action-cost spending into `ResourceResolver`.
3. Add `ActionResolver` around the existing cost-only behavior without changing gameplay yet.
4. Add `TargetResolver` and tests for target validation.
5. Add attack/save/damage/healing/effect slices one at a time.

Keep every slice small, testable, and compatible with synthetic Token Actors.
