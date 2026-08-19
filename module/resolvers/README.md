# Resolvers

This folder contains the first resolver implementations and documents the next modules the
automation foundation needs, per `AGENTS.md` sections 4 and 8 and the architecture notes in
`CORE_AUTOMATION_FOUNDATION.md`.

## Current State

- `WildPathActor#canUseAction` / `#useAction` currently validate and spend an Action item's
  resource cost through `ActionResolver` and `ResourceResolver`. Sheet-driven action use remains
  cost-only until a Foundry adapter supplies target, attack, and damage data.
- `module/helpers/action-economy.mjs` now provides generic payment discovery, payment commit, and
  refresh primitives that `ResourceResolver` should wrap at the Foundry boundary.
- `module/helpers/automation-events.mjs` now provides semantic event normalization, trigger
  matching, one-shot dispatch planning, and reaction-window eligibility checks. `ReactionResolver`
  should wrap those plans with prompting, authority, and commit behavior.
- `module/helpers/action-resolution.mjs` now provides the plain `ActionContext` and `ActionResult`
  envelopes that resolver modules should share for steps, events, consequences, mutation plans,
  errors, and audit traces.
- `module/helpers/entity-refs.mjs` now provides opaque string references for cross-layer identity.
  New resolver code should pass `ref` strings and treat `{actorId, tokenId}` fields as transitional
  compatibility data.
- `module/resolvers/resource-resolver.mjs` now wraps action-economy payment discovery and maps
  selected payment plans to Actor update paths. `ActionResolver` uses it for the current cost-only
  behavior.
- `module/resolvers/action-resolver.mjs` now wraps the current Action item flow in
  `ActionContext` / `ActionResult`, optionally delegates target validation to `TargetResolver`,
  optionally delegates supplied attack data to `AttackResolver`, optionally delegates supplied
  save data to `SaveResolver`, optionally delegates supplied damage components to
  `DamageResolver`, applies WeaponSizePolicy to explicitly manufactured weapon-size damage data,
  applies save-outcome damage policies, and delegates payment to `ResourceResolver`.
- `module/resolvers/target-resolver.mjs` now wraps target-set eligibility, refinement decisions,
  required-target failures, self-targeting, and selection request state.
- `module/resolvers/attack-resolver.mjs` now resolves already-known attack totals against target
  defenses as pure per-target outcomes. `ActionResolver` can call it when an action plan includes
  attack roll data.
- `module/resolvers/save-resolver.mjs` now resolves already-known save totals against DCs as pure
  per-target outcomes. `ActionResolver` can call it when an action plan includes save data.
- `module/resolvers/damage-resolver.mjs` now provides structured damage components, damage-type
  totals, target damage result shells, and weapon-size-scaling metadata/provenance. `ActionResolver`
  can call it when an action plan includes damage data.
- `module/resolvers/durability-resolver.mjs` now plans Actor health/custom-pool damage and healing
  update paths without mutating Actor data directly.
- `WildPathActor#getStatistic(domain)` plus `WildPathStatistic`/`WildPathModifier` are the
  calculation engine resolvers should build on for attack bonuses, save DCs, damage bonuses,
  resistance, and similar derived values.
- `WildPathConditionEffect.applyDelta` is the only current apply/remove condition entry point.
  `EffectResolver` should become the general front door for conditions and other ActiveEffects.

## Planned Modules

Each resolver should live as a plain `.mjs` module under `module/resolvers/`. Keep core
rules/domain behavior testable under Node, pass opaque entity refs as strings, and isolate Foundry
document reads/writes to thin integration methods. Sheets, the Token HUD, and chat rendering should
call into `ActionResolver`; resolvers should not call UI code.

| Module | File | Responsibility |
|---|---|---|
| `ActionResolver` | `module/resolvers/action-resolver.mjs` | Current target-aware, attack-capable, save-capable, weapon-size-aware, save-damage-policy-aware, and damage-component-capable entry point for supplied plain data; should grow into roll requests, Actor mutation planning, effects, and post-resolution hooks. |
| `TargetResolver` | `module/resolvers/target-resolver.mjs` | Resolves and validates self, explicit, and precomputed target sets for ActionResolver and future UI adapters. |
| `AttackResolver` | `module/resolvers/attack-resolver.mjs` | Current pure attack-vs-defense outcome resolver for known roll totals and target defenses. |
| `SaveResolver` | `module/resolvers/save-resolver.mjs` | Current pure save-vs-DC outcome resolver for known save totals and DCs. |
| `DamageResolver` | `module/resolvers/damage-resolver.mjs` | Current structured damage-component foundation, optionally called by ActionResolver; should grow into resistance, immunity, vulnerability, critical, and Actor mutation planning. |
| `HealingResolver` | `module/resolvers/healing-resolver.mjs` | Resolve healing/resource restoration as structured results before mutation. |
| `DurabilityResolver` | `module/resolvers/durability-resolver.mjs` | Current Actor durability mutation planner for already-resolved damage/healing amounts. |
| `EffectResolver` | `module/resolvers/effect-resolver.mjs` | Apply/remove ActiveEffects and conditions as resolved consequences of actions. |
| `ResourceResolver` | `module/resolvers/resource-resolver.mjs` | Generalizes action cost validation and payment mutation planning; refund-on-cancel waits for transaction support. |
| `ReactionResolver` | `module/resolvers/reaction-resolver.mjs` | Offer eligible reactions at defined interrupt points, then resume the parent resolution. |
| `AreaResolver` | `module/resolvers/area-resolver.mjs` | Resolve instantaneous and persistent areas plus enter/leave/start-turn/end-turn triggers. |

## Sequencing Note

Land these in small vertical stages: data/interface, pure rules behavior, resolution integration,
Foundry adapter, then UI. `ActionResolver`, `TargetResolver`, `AttackResolver`, `SaveResolver`, and
the structured DamageResolver integration are now in place for the first
cost/target/attack/save/damage-component shape. WeaponSizePolicy is wired into ActionResolver for
explicitly manufactured weapon-size damage data, and save-outcome policies can adjust per-target
damage before DamageResolver totals it; see `docs/architecture/weapon-size.md`.
DurabilityResolver can plan target Actor updates once a Foundry adapter supplies the concrete Actor
for each resolved target.
