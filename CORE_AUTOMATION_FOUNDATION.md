# Core Automation Foundation

WildPath now has a substantial pure/domain automation kernel for Foundry VTT V14. The core
architecture includes declarative rules, persisted ActionDefinitions, per-use Action Configuration,
authoritative previews, serializable staged ResolutionState, pause/resume requests, transaction-
backed commit planning, RollProvider abstraction, topology-aware tactical geometry, target
refinement, Action Economy, Effects, InventorySpace foundations, and WeaponSizePolicy.

The primary remaining risk is no longer whether these concepts can be modeled. It is proving that
they integrate cleanly with live Foundry VTT V14 Scenes, Tokens, Documents, Applications, and
complex player workflows without compromising the domain boundaries.

This document records the current automation foundation and near-term integration direction. The
finished game system name is **WildPath**.

## Current Baseline

- Actor and Item data models define abilities, resources, custom pools, actions, gear, features,
  modifiers, and conditions.
- `WildPathActor#useAction` currently follows the sheet-driven cost-only path. The resolver layer
  can already accept plain target, attack, save, and damage data from future Foundry adapters.
- `WildPathActor#getStatistic(domain)` and `WildPathStatistic` are the current calculation engine.
  New mechanics should build on that domain/modifier model rather than creating one-off math.
- `module/helpers/rule-elements.mjs` provides the first pure RuleElement registry/collector for
  serializable rule contributions, with schema-versioned validation, source/provenance traces, and
  JSON round-trip normalization. Items and ActiveEffects now persist `ruleElements`, and `Modifier`
  RuleElements feed `WildPathActor#getStatistic(domain)` alongside legacy modifiers.
- Resource max calculation is idempotent: persisted `base`/`bonus` values combine with transient
  per-prepare `modifierBonus` values.
- `module/helpers/action-economy.mjs` provides pure payment discovery/commit/refresh primitives
  for extensible action-economy resources, including the default Wild Path rule that an Action can
  pay for a Bonus Action activity after eligible Bonus Action resources are depleted.
- `module/helpers/movement.mjs` derives spendable movement budgets from canonical movement speed
  using distance or field measurement.
- Tactical grid and area topology are implemented as pure domain foundations: gridded AoE resolves
  to authoritative `GridFootprint` field sets rather than Euclidean templates pretending to be
  tactical geometry. `module/adapters/foundry-v14-tactical-grid-adapter.mjs` now provides the first
  Foundry V14 Scene/Grid/Token translation proof for square and hex scenes, with gridless and
  elevation limitations reported structurally.
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
- `module/helpers/combat-timeline.mjs` provides pure combat timeline events, duration ticking,
  rest expiry, and scheduled event matching.
- `module/helpers/automation-events.mjs` provides pure semantic events, trigger matching, one-shot
  dispatch planning, and reaction-window eligibility checks against action-economy resources.
- `module/helpers/action-resolution.mjs` provides pure `ActionContext` and `ActionResult`
  envelopes for validation steps, semantic events, consequences, mutation plans, and audit traces.
- `module/helpers/resolution-state.mjs` provides the serializable `ResolutionState` and
  addressable stage foundation for pause/resume, typed pending requests, response correlation,
  parent/child provenance, lifecycle statuses, and structured stage trace data.
- `module/helpers/action-definitions.mjs` provides the pure, schema-versioned ActionDefinition
  contract for persisted Action Item mechanics, including serialization, validation, legacy
  cost-only migration, and translation into resolver input.
- `module/helpers/action-configuration.mjs` provides the pure Action Configuration and
  authoritative preview foundation: choice discovery, response validation, generic configured
  damage scaling, damage-type substitution, added costs, exact payment revalidation, preview
  deltas, and provenance without mutating resources or ActionDefinitions.
- `module/helpers/entity-refs.mjs` provides the opaque string-reference contract (`actor:...`,
  `token:scene.token`, `uuid:...`) that future domain and resolver code should pass instead of
  live Foundry documents or cross-layer object handles.
- `module/resolvers/resource-resolver.mjs` maps generic action-economy payment plans to Actor
  resource update paths and is now the payment boundary used by `WildPathActor#useAction`.
- `module/resolvers/resolution-transaction-resolver.mjs` provides ordered mutation commit
  operations with preflight rollback requirements, custom rollback callbacks for document
  operations, and reverse-order rollback when a later commit fails. Migrated action commits now
  execute through `DocumentPersistencePort`.
- `module/resolvers/action-resolver.mjs` wraps the current Action flow in
  `ActionContext`/`ActionResult`, loads and validates persisted ActionDefinitions, adapts legacy
  cost-only Actions in memory, derives default TargetResolver/AttackResolver/SaveResolver/
  DamageResolver/HealingResolver/EffectResolver requests from the definition, preserves runtime
  overlays for current targets and rolls, emits semantic target/payment events, applies
  manufactured weapon-size damage scaling and save-outcome damage policies, and delegates payment
  to ResourceResolver. It can also plan condition effect consequences for selected, hit, or
  save-matching targets while carrying duration, spell-origin, and concentration metadata, then
  commit those plans through the explicit-authority target mutation transaction path.
- `module/resolvers/action-pipeline-resolver.mjs` is the first staged ResolutionState action path.
  It pauses for required Action Configuration, target selection/refinement, and roll input; resumes
  only with matching resolution/request/type responses; resolves targeting, range, attack/save
  outcomes, damage, healing, effects, and payment in explicit stages; plans to ready-to-commit
  without mutation; and commits the already-planned `ActionResult` through the transaction-backed
  persistence port boundary.
- `module/helpers/multiplayer-authority.mjs`,
  `module/resolvers/multiplayer-action-coordinator.mjs`,
  `module/adapters/foundry-v14-resolution-socket-adapter.mjs`, and
  `module/adapters/test-resolution-transport.mjs` provide the first multiplayer authority/socket
  proof. The active GM owns authoritative ResolutionState by default; pending requests route to the
  expected source/target controller, GM, or specific active user; remote prompts and rolls resume
  through existing ChoiceCoordinator/PromptPort/RollProvider contracts; duplicate and stale
  responses are rejected; and only the authority context reaches the transaction/persistence commit
  path.
- `module/resolvers/target-resolver.mjs` wraps target-set eligibility, refinement decisions,
  required-target failures, self-targeting, and selection request state for future ActionResolver
  integration.
- `module/resolvers/attack-resolver.mjs` resolves already-known attack totals against target
  defenses as pure structured outcomes. `ActionResolver` can call it when an action plan includes
  attack data.
- `module/resolvers/save-resolver.mjs` resolves already-known save totals against DCs as pure
  structured outcomes. `ActionResolver` can call it when an action plan includes save data.
- `module/resolvers/damage-resolver.mjs` provides structured damage components, damage-type
  totals, target damage result shells, and weapon-size-scaling metadata/provenance. `ActionResolver`
  can call it when an action plan includes damage data.
- `module/resolvers/durability-resolver.mjs` plans Actor health/custom-pool damage and healing
  mutation updates without mutating Actor data directly.
- `module/resolvers/damage-adjustment-resolver.mjs` applies per-target immunity, resistance,
  vulnerability, damage reduction, and absorption that can convert incoming damage into healing,
  shields, or other resources before durability mutation planning.
- `module/resolvers/damage-durability-resolver.mjs` can now expose adjusted damage results and
  optional concentration check requests after target damage adjustment and before mutation commit.
- `module/resolvers/effect-resolver.mjs` plans condition effect changes as explicit
  create/update/delete/noop mutation plans with duration/source/origin/concentration lifecycle
  metadata and is now the resolver boundary used by `WildPathActor#toggleCondition`.
- `module/resolvers/condition-effect-commit-resolver.mjs` commits planned condition-effect
  mutations to supplied target Actors and restores created, updated, or deleted condition snapshots
  when the surrounding transaction rolls back.
- `module/resolvers/effect-lifecycle-resolver.mjs` consumes committed condition metadata,
  timeline events, and concentration break refs/events, then plans condition removals without
  mutating ActiveEffect documents directly.
- `module/resolvers/effect-lifecycle-commit-resolver.mjs` runs lifecycle planning for supplied
  Actors and commits resulting condition removals through the explicit-authority target mutation
  transaction path.
- `module/resolvers/condition-trigger-resolver.mjs` is the first condition RuleElement consumer:
  it matches condition-provided Trigger RuleElements against semantic turn events and plans
  durability changes through `DurabilityResolver`. Bleeding now uses this path. Legacy `system.dot`
  condition ticks are translated into synthetic Trigger RuleElements only when no persisted
  RuleElements exist.
- `module/resolvers/concentration-resolver.mjs` plans concentration check requests from adjusted
  damage, resolves supplied digital/physical check results through `SaveResolver`, accepts
  already-resolved concentration save decisions or semantic decision events, classifies
  maintained/broken/ignored results, and turns failures into lifecycle break events without
  rolling dice or mutating documents.
- `module/resolvers/concentration-check-commit-resolver.mjs` bridges supplied concentration check
  results into `EffectLifecycleCommitResolver`, preserving explicit authority and the
  transaction-backed lifecycle mutation path.
- `wildpath.mjs` adapts `combatStart`, `combatTurn`, and combat deletion/end into semantic
  timeline events on the active GM client, resets the incoming combatant's turn resources, and
  commits due condition lifecycle removals for combatant Actors.
- `WildPathActor#rest()` now restores rest-based resources and emits rest completion lifecycle
  events for duration expiry through the same explicit-authority commit path.
- `module/helpers/weapon-sizing.mjs` provides the WeaponSizePolicy foundation: size comparison,
  2014/2024/house policy providers, structured wieldability results, and structured
  weapon-size damage scaling for explicitly marked damage components.
- `module/helpers/ui-view-models.mjs` provides the first pure UI/UX state layer for action-bar
  availability, combat-carousel turn state, and concentration check prompts, with command payloads
  and opaque refs instead of DOM, canvas, or Foundry document coupling.
- `tsconfig.json` and `module/types/contracts.d.ts` provide the first non-disruptive TypeScript
  migration scaffold for shared refs, ActionDefinition, resolver results, mutation plans, action
  context, and UI view models. JavaScript remains the runtime implementation until individual
  modules are converted.

## Resolution Pipeline

Automated gameplay should flow through the established staged architecture:

```text
ActionDefinition
+ current rule state

-> availability
-> Action Configuration
-> ResolvedActionConfiguration
-> ResolvedActionPreview
-> ResolutionState
-> staged Resolution Pipeline
-> targeting / RollRequest / outcomes
-> mutation plans
-> transaction commit
-> persistence port
-> Foundry V14 adapter
-> ResolutionResult / semantic events
```

Preview/discovery is non-mutating. The configuration shown in preview must be the configuration
consumed by the later ResolutionState unless revalidation invalidates it.

The UI should initiate that pipeline, not own the rules. Sheets, HUD controls, and chat buttons
should call resolution APIs; the rules and resolver layers should not depend on DOM, canvas, or
chat state.

## Resolver Modules

The first resolver implementations live under `module/resolvers/`:

- `ActionPipelineResolver`: staged architecture-proof action path for configuration, targeting,
  range, roll requests, attack/save outcomes, damage, healing, effects, payment, ready-to-commit,
  commit, and finalization.
- `ActionResolver`: compatibility facade and shared planning helper source for direct callers.
- `TargetResolver`: validates self, single-target, multi-target, and area target sets.
- `AttackResolver`: resolves attack rolls against target defenses.
- `SaveResolver`: resolves saving throws against DCs.
- `DamageResolver`: computes structured damage results before Actor mutation.
- `HealingResolver`: computes structured healing/restoration results before Actor mutation.
- `EffectResolver`: currently plans condition changes; should grow into applying/removing
  ActiveEffects as resolved consequences.
- `ResourceResolver`: centralizes spending, refunds, and resource validation.
- `ReactionResolver`: supports interrupt windows and reaction prompts.
- `AreaResolver`: handles instantaneous and persistent areas plus movement/turn triggers.
- `ResolutionTransaction`: orders mutation operations and delegates document writes to
  `DocumentPersistencePort`.

The first integration-proof suite now shows representative persisted melee, ranged, area-save,
healing, condition-effect, and configured/scaling actions flowing through the staged pipeline,
RollProvider results, TacticalGrid adapter output, mutation plans, transaction, and persistence
ports. Live Foundry runtime QA remains outstanding.

See `module/resolvers/README.md` for the concrete file-path map.

## Tactical Grid And Areas

For gridded Wild Path combat, the grid is the geometry. Rules define semantic shape and size; the
active tactical grid defines adjacency, direction, source-border placement, and affected fields.
Ordinary creature-originated Lines and Cones should originate from an eligible source Token's
tactical boundary vertex rather than token center.

This milestone is gated behind the core resolver/rules foundations and should land before
movement-path automation, opportunity attacks, auras, emanations, persistent hazards, and large
spell/content implementation. The first Foundry adapter proof has landed; see
`docs/architecture/tactical-grid.md`, `docs/architecture/areas.md`, and
`docs/architecture/foundry-tactical-grid-adapter.md`.

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
See `docs/design/character-sheet.md` for the finished character-sheet architecture and reference
analysis.
See `docs/architecture/combat-timeline.md` for the combat timeline, durations, and scheduler
foundation. See `docs/architecture/events-and-reactions.md` for the automation event and reaction
trigger foundation. See `docs/architecture/action-resolution.md` for the common action-context
and action-result envelope. See `docs/architecture/resolution-state.md` for the staged
ResolutionState pipeline, lifecycle, pending requests, child resolutions, and commit boundary. See
`docs/architecture/action-definitions.md` for the persisted
ActionDefinition contract. See `docs/architecture/action-configuration.md` for the per-use
configuration and authoritative preview foundation. See
`docs/architecture/resource-resolution.md` for the current resource payment resolver boundary. See
`docs/architecture/resolution-transaction.md` for the current ordered Actor update transaction
boundary. See `docs/architecture/foundry-persistence-ports.md` for the Foundry V14 document
persistence adapter boundary. See `docs/architecture/action-resolver.md` for
the current ActionResolver compatibility entry point. See
`docs/architecture/target-resolver.md` for the current target validation bridge. See
`docs/architecture/attack-resolver.md` for the current pure attack-outcome resolver. See
`docs/architecture/save-resolver.md` for the current pure save-outcome resolver. See
`docs/architecture/damage-resolver.md` for the current structured damage-component foundation. See
`docs/architecture/durability-resolution.md` for the current Actor durability mutation planner. See
`docs/architecture/effect-resolver.md` for the current condition-first EffectResolver boundary. See
`docs/architecture/effect-lifecycle-resolver.md` for duration/concentration condition removal
planning. See `docs/architecture/concentration-resolver.md` for the current concentration check
planning, result resolution, and decision normalization boundary. See
`docs/architecture/concentration-check-commit-resolver.md` for the adapter-facing concentration
result commit bridge. See `docs/architecture/weapon-size.md` for the WeaponSizePolicy foundation
and its separation from Heavy, Reach, creature size, and damage execution. See
`docs/architecture/abstraction-layers.md` for the string-reference boundary that keeps rules,
resolvers, Foundry adapters, and UI separated. See `docs/architecture/ui-ux-layer.md` for the
current action-bar, combat-carousel, and concentration-prompt view-model foundation. See
`docs/architecture/rule-elements.md` for the current declarative rule-contribution layer. See
`docs/architecture/rolls.md` for RollRequest, RollProvider, RollResult, provider selection, manual/
physical semantics, and ResolutionState integration. See
`docs/architecture/multiplayer-authority.md` for active-GM ownership, socket envelopes, request
routing, duplicate/stale rejection, and the current Foundry socket adapter. See
`docs/architecture/typescript-migration.md` for the staged TypeScript adoption plan.

## Near-Term Order

1. Perform live Foundry V14 runtime QA for staged persisted actions, tactical-grid adaptation,
   PromptPort/RollProvider choices, active-GM socket routing, and DocumentPersistencePort commits.
2. Build the ReactionEngine over semantic events, child ResolutionState, existing pending requests,
   and the multiplayer authority router. Avoid named-feature reaction code.
3. Build topology-aware Movement using complete TokenGridFootprints and semantic movement events.
4. Compose persistent Areas, auras, and emanations from Spatial + Movement + Events + Reactions.
5. Add representative content and character-system slices only after those execution boundaries are
   proven in live runtime.

Keep every slice small, testable, and compatible with synthetic Token Actors.
