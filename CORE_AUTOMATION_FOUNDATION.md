# Core Automation Foundation

WildPath is currently an early Foundry VTT V14 system scaffold. The codebase has data models,
resource pools, action cost spending, declarative modifiers, conditions, and basic sheets. It
does not yet have the full BG3-style action resolution pipeline.

This document records the intended architecture so future implementation work has a clear target.

## Current Baseline

- Actor and Item data models define abilities, resources, custom pools, actions, gear, features,
  modifiers, and conditions.
- `WildPathActor#useAction` spends an Action item's resources only. It does not resolve targets,
  attacks, saves, damage, healing, effects, reactions, or areas.
- `WildPathActor#getStatistic(domain)` and `WildPathStatistic` are the current calculation engine.
  New mechanics should build on that domain/modifier model rather than creating one-off math.
- Resource max calculation is idempotent: persisted `base`/`bonus` values combine with transient
  per-prepare `modifierBonus` values.

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

## Near-Term Order

1. Define `ActionContext` and `ActionResult` as plain data structures.
2. Extract existing action-cost spending into `ResourceResolver`.
3. Add `ActionResolver` around the existing cost-only behavior without changing gameplay yet.
4. Add `TargetResolver` and tests for target validation.
5. Add attack/save/damage/healing/effect slices one at a time.

Keep every slice small, testable, and compatible with synthetic Token Actors.
