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
- `module/resolvers/resolution-transaction-resolver.mjs` now commits ordered Actor update
  operations with preflight rollback requirements and reverse-order rollback on later commit
  failure.
- `module/resolvers/action-resolver.mjs` now wraps the current Action item flow in
  `ActionContext` / `ActionResult`, optionally delegates target validation to `TargetResolver`,
  optionally delegates supplied attack data to `AttackResolver`, optionally delegates supplied
  save data to `SaveResolver`, optionally delegates supplied damage components to
  `DamageResolver`, applies WeaponSizePolicy to explicitly manufactured weapon-size damage data,
  applies save-outcome damage policies, optionally resolves healing components, attaches
  damage/healing durability plans, optionally plans condition effects with save-outcome, duration,
  spell-origin, and concentration metadata, can commit target durability and condition-effect plans
  with explicit authority through `ResolutionTransaction`, and delegates payment planning to
  `ResourceResolver`.
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
- `module/resolvers/damage-adjustment-resolver.mjs` now applies immunity, resistance,
  vulnerability, flat/scaled/already-rolled damage absorption, and flat/scaled/already-rolled
  damage reduction before durability planning.
- `module/resolvers/healing-resolver.mjs` now provides structured healing components and
  per-target healing totals.
- `module/resolvers/durability-resolver.mjs` now plans Actor health/custom-pool damage and healing
  update paths without mutating Actor data directly.
- `module/resolvers/damage-durability-resolver.mjs` now bridges successful per-target damage
  results into target Actor durability mutation plans when an adapter supplies target systems by
  opaque refs or transitional ids, including ordered post-damage absorption plans and optional
  concentration check requests from adjusted damage totals.
- `module/resolvers/healing-durability-resolver.mjs` does the same for per-target healing results.
- `module/resolvers/target-mutation-commit-resolver.mjs` commits target mutation plans only when
  supplied target Actors and explicit authority.
- `module/resolvers/effect-resolver.mjs` now plans condition effect create/update/delete/noop
  changes, carries duration/source/origin/concentration metadata, and provides an explicit
  commit-adapter boundary for Foundry ActiveEffect mutation.
- `module/resolvers/condition-effect-commit-resolver.mjs` commits and rolls back planned
  condition-effect mutations against supplied target Actors.
- `module/resolvers/effect-lifecycle-resolver.mjs` consumes committed condition metadata plus
  timeline/concentration break events and returns condition removal mutation plans.
- `module/resolvers/effect-lifecycle-commit-resolver.mjs` runs lifecycle planning for supplied
  Actors and commits resulting condition removals through the target mutation transaction path
  with explicit authority.
- `module/resolvers/concentration-resolver.mjs` normalizes already-resolved concentration save
  decisions or semantic decision events into maintained/broken/ignored results, turns failures
  into lifecycle break events for `EffectLifecycleCommitResolver`, and plans concentration check
  requests from adjusted damage plus supplied concentration state snapshots.
- `wildpath.mjs` now adapts `combatStart` and `combatTurn` into semantic timeline events on the
  active GM client, resets the incoming combatant's turn resources, and runs effect lifecycle
  commits for combatant Actors.
- `WildPathActor#toggleCondition` now enters `EffectResolver` before delegating Foundry document
  mutation to `WildPathConditionEffect.applyDelta`.
- `WildPathActor#getStatistic(domain)` plus `WildPathStatistic`/`WildPathModifier` are the
  calculation engine resolvers should build on for attack bonuses, save DCs, damage bonuses,
  resistance, and similar derived values.
- `WildPathConditionEffect.applyDelta` remains the Foundry-specific condition document mutation
  helper behind the resolver boundary.

## Planned Modules

Each resolver should live as a plain `.mjs` module under `module/resolvers/`. Keep core
rules/domain behavior testable under Node, pass opaque entity refs as strings, and isolate Foundry
document reads/writes to thin integration methods. Sheets, the Token HUD, and chat rendering should
call into `ActionResolver`; resolvers should not call UI code.

| Module | File | Responsibility |
|---|---|---|
| `ActionResolver` | `module/resolvers/action-resolver.mjs` | Current target-aware, attack-capable, save-capable, weapon-size-aware, save-damage-policy-aware, damage/healing-capable, condition-effect-planning entry point for supplied plain data; should grow into roll requests, effect commits, and post-resolution hooks. |
| `TargetResolver` | `module/resolvers/target-resolver.mjs` | Resolves and validates self, explicit, and precomputed target sets for ActionResolver and future UI adapters. |
| `AttackResolver` | `module/resolvers/attack-resolver.mjs` | Current pure attack-vs-defense outcome resolver for known roll totals and target defenses. |
| `SaveResolver` | `module/resolvers/save-resolver.mjs` | Current pure save-vs-DC outcome resolver for known save totals and DCs. |
| `DamageResolver` | `module/resolvers/damage-resolver.mjs` | Current structured damage-component foundation, optionally called by ActionResolver; critical handling remains future work. |
| `DamageAdjustmentResolver` | `module/resolvers/damage-adjustment-resolver.mjs` | Applies per-target immunity, resistance, vulnerability, absorption, and damage reduction before durability mutation planning. |
| `HealingResolver` | `module/resolvers/healing-resolver.mjs` | Resolves healing/resource restoration as structured target results before mutation. |
| `DurabilityResolver` | `module/resolvers/durability-resolver.mjs` | Current Actor durability mutation planner for already-resolved damage/healing amounts. |
| `TargetMutationCommitResolver` | `module/resolvers/target-mutation-commit-resolver.mjs` | Commits target mutation plans to supplied Actors with explicit authority. |
| `ResolutionTransaction` | `module/resolvers/resolution-transaction-resolver.mjs` | Commits ordered Actor update/custom operations and rolls back committed updates/effects if a later operation fails. |
| `EffectResolver` | `module/resolvers/effect-resolver.mjs` | Current condition create/update/delete/noop planner with lifecycle metadata and commit-adapter boundary; general ActiveEffect planning remains future work. |
| `ConditionEffectCommitResolver` | `module/resolvers/condition-effect-commit-resolver.mjs` | Commits planned condition effects to supplied target Actors and restores snapshots on rollback. |
| `EffectLifecycleResolver` | `module/resolvers/effect-lifecycle-resolver.mjs` | Plans condition removal when committed duration/concentration metadata expires or breaks. |
| `EffectLifecycleCommitResolver` | `module/resolvers/effect-lifecycle-commit-resolver.mjs` | Commits lifecycle condition removals for supplied Actors with explicit authority and transaction rollback. |
| `ConcentrationResolver` | `module/resolvers/concentration-resolver.mjs` | Plans concentration check requests from adjusted damage, resolves supplied digital/physical check results through SaveResolver, normalizes known concentration save decisions, and emits lifecycle break events for failed decisions. |
| `ConcentrationCheckCommitResolver` | `module/resolvers/concentration-check-commit-resolver.mjs` | Bridges supplied concentration check results into EffectLifecycleCommitResolver with explicit authority and no prompt/UI dependency. |
| `ResourceResolver` | `module/resolvers/resource-resolver.mjs` | Generalizes action cost validation and payment mutation planning; refund-on-cancel waits for cancellation/reaction slices. |
| `ReactionResolver` | `module/resolvers/reaction-resolver.mjs` | Offer eligible reactions at defined interrupt points, then resume the parent resolution. |
| `AreaResolver` | `module/resolvers/area-resolver.mjs` | Resolve instantaneous and persistent areas plus enter/leave/start-turn/end-turn triggers. |

## Sequencing Note

Land these in small vertical stages: data/interface, pure rules behavior, resolution integration,
Foundry adapter, then UI. `ActionResolver`, `TargetResolver`, `AttackResolver`, `SaveResolver`, and
the structured DamageResolver integration are now in place for the first
cost/target/attack/save/damage-component shape. WeaponSizePolicy is wired into ActionResolver for
explicitly manufactured weapon-size damage data, and save-outcome policies can adjust per-target
damage before DamageResolver totals it; see `docs/architecture/weapon-size.md`.
ActionResolver can now attach and execute durability mutation plans for adjusted damage and
resolved healing when a Foundry adapter supplies target Actor system snapshots, target Actors, and
explicit authority. It can also plan condition effect consequences for selected, hit, or
save-matching targets while carrying duration, spell-origin, and concentration metadata, then
execute those plans through the same target mutation authority and transaction path. Target
durability, target condition effects, and source payment commits now run through
ResolutionTransaction. EffectLifecycleResolver can now turn committed duration/concentration
metadata into condition removal plans, and EffectLifecycleCommitResolver can commit those plans
from Foundry combat start/turn hook events on the active GM client. ConcentrationResolver can now
feed failed concentration save decisions into that same lifecycle path, plan concentration check
requests from adjusted damage, and resolve supplied check totals/outcomes into the same event shape.
ConcentrationCheckCommitResolver now bridges those supplied check results into the lifecycle commit
path with explicit authority. The next resolver slice should either add a Foundry/UI prompt adapter
for concentration check result entry or extend EffectResolver from condition-only planning toward
generic ActiveEffect planning.
