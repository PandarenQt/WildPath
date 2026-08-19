# Resolvers

This folder contains the first resolver implementations and documents the next modules the
automation foundation needs, per `AGENTS.md` sections 4 and 8 and the architecture notes in
`CORE_AUTOMATION_FOUNDATION.md`.

## Current State

- `WildPathActor#canUseAction` / `#useAction` currently validate and spend an Action item's
  resource cost through `ActionResolver` and `ResourceResolver`. Sheet-driven action use remains
  cost-only until a Foundry adapter supplies target and attack data.
- `module/helpers/action-economy.mjs` now provides generic payment discovery, payment commit, and
  refresh primitives that `ResourceResolver` should wrap at the Foundry boundary.
- `module/helpers/automation-events.mjs` now provides semantic event normalization, trigger
  matching, one-shot dispatch planning, and reaction-window eligibility checks. `ReactionResolver`
  should wrap those plans with prompting, authority, and commit behavior.
- `module/helpers/action-resolution.mjs` now provides the plain `ActionContext` and `ActionResult`
  envelopes that resolver modules should share for steps, events, consequences, mutation plans,
  errors, and audit traces.
- `module/resolvers/resource-resolver.mjs` now wraps action-economy payment discovery and maps
  selected payment plans to Actor update paths. `ActionResolver` uses it for the current cost-only
  behavior.
- `module/resolvers/action-resolver.mjs` now wraps the current Action item flow in
  `ActionContext` / `ActionResult`, optionally delegates target validation to `TargetResolver`,
  optionally delegates supplied attack data to `AttackResolver`, and delegates payment to
  `ResourceResolver`.
- `module/resolvers/target-resolver.mjs` now wraps target-set eligibility, refinement decisions,
  required-target failures, self-targeting, and selection request state.
- `module/resolvers/attack-resolver.mjs` now resolves already-known attack totals against target
  defenses as pure per-target outcomes. `ActionResolver` can call it when an action plan includes
  attack roll data.
- `module/resolvers/damage-resolver.mjs` now provides structured damage components, damage-type
  totals, target damage result shells, and weapon-size-scaling metadata/provenance.
- `WildPathActor#getStatistic(domain)` plus `WildPathStatistic`/`WildPathModifier` are the
  calculation engine resolvers should build on for attack bonuses, save DCs, damage bonuses,
  resistance, and similar derived values.
- `WildPathConditionEffect.applyDelta` is the only current apply/remove condition entry point.
  `EffectResolver` should become the general front door for conditions and other ActiveEffects.

## Planned Modules

Each resolver should live as a plain `.mjs` module under `module/resolvers/`. Keep core
rules/domain behavior testable under Node, with Foundry document reads/writes isolated to thin
integration methods. Sheets, the Token HUD, and chat rendering should call into `ActionResolver`;
resolvers should not call UI code.

| Module | File | Responsibility |
|---|---|---|
| `ActionResolver` | `module/resolvers/action-resolver.mjs` | Current target-aware and attack-capable entry point for supplied plain data; should grow into roll requests, consequences, effects, and post-resolution hooks. |
| `TargetResolver` | `module/resolvers/target-resolver.mjs` | Resolves and validates self, explicit, and precomputed target sets for ActionResolver and future UI adapters. |
| `AttackResolver` | `module/resolvers/attack-resolver.mjs` | Current pure attack-vs-defense outcome resolver for known roll totals and target defenses. |
| `SaveResolver` | `module/resolvers/save-resolver.mjs` | Resolve saving throws against DCs derived through the same statistic engine. |
| `DamageResolver` | `module/resolvers/damage-resolver.mjs` | Current structured damage-component foundation; should grow into resistance, immunity, vulnerability, critical, and Actor mutation planning. |
| `HealingResolver` | `module/resolvers/healing-resolver.mjs` | Resolve healing/resource restoration as structured results before mutation. |
| `EffectResolver` | `module/resolvers/effect-resolver.mjs` | Apply/remove ActiveEffects and conditions as resolved consequences of actions. |
| `ResourceResolver` | `module/resolvers/resource-resolver.mjs` | Generalizes action cost validation and payment mutation planning; refund-on-cancel waits for transaction support. |
| `ReactionResolver` | `module/resolvers/reaction-resolver.mjs` | Offer eligible reactions at defined interrupt points, then resume the parent resolution. |
| `AreaResolver` | `module/resolvers/area-resolver.mjs` | Resolve instantaneous and persistent areas plus enter/leave/start-turn/end-turn triggers. |

## Sequencing Note

Land these in small vertical stages: data/interface, pure rules behavior, resolution integration,
Foundry adapter, then UI. `ActionResolver`, `TargetResolver`, `AttackResolver`, and the structured
DamageResolver foundation are now in place for the first cost/target/attack/damage-component shape.
The WeaponSizePolicy foundation builds on DamageResolver's provenance and weapon-size-scaling
metadata; see `docs/architecture/weapon-size.md`.
