# ActionResolver

`module/resolvers/action-resolver.mjs` is now the compatibility facade and shared planning helper
source for action mechanics. It handles existing legacy cost behavior and can also load a persisted
`ActionDefinition` from an Action Item, validate it, and adapt its targeting, attack, save, damage,
healing, condition-effect, and payment declarations into the existing resolver flow. Runtime callers
still provide current-use data such as selected targets, target candidates, roll totals, rolled
component amounts, target Actor system snapshots, and authority.
It can also consume raw Action Configuration responses or a `ResolvedActionConfiguration`, use the
configuration helper's effective ActionDefinition, preserve a compact configuration summary in the
action context metadata, and revalidate the selected payment plan before payment planning.

`module/resolvers/action-pipeline-resolver.mjs` is the current staged orchestration path. It creates
a serializable `ResolutionState`, runs addressable stages for configuration, targeting, range,
attack/save/damage roll input, attack/save outcomes, damage, healing, effects, payment, and
ready-to-commit, and preserves pause/resume request correlation. Execution commits the already
planned staged `ActionResult` through `commitPlannedActionResult()` instead of replanning through
the public resolver.

It can resolve target validation and optional attack-outcome resolution when the required plain
runtime data is present. It can also resolve supplied saving throws, resolve structured damage and
healing components as consequences, apply WeaponSizePolicy to explicitly manufactured weapon
damage, and attach target durability mutation plans when supplied target Actor system snapshots.
Damage durability planning can include absorption plans that convert part of the incoming damage
into health, shields, or another Actor resource.
When damage supplies concentration state snapshots, adjusted damage can also produce concentration
check requests for a later prompt/result adapter.
When damage supplies a `saveOutcomePolicy`, the resolver can adjust per-target damage amounts from
the already-resolved save outcomes, such as half damage on a successful save.
When effects supply condition definitions, it can also plan condition consequences for selected,
hit, or save-matching targets while carrying duration, spell-origin, and concentration metadata.
During execution, condition effects commit through the same explicit-authority target mutation
transaction path as durability.

## Current Flow

```text
Action item
-> ActionDefinition validation / migration
-> optional ActionConfiguration validation / effective definition
-> ActionContext
-> ActionResult
-> optional TargetResolver target validation
-> optional AttackResolver attack outcome
-> optional SaveResolver save outcome
-> optional WeaponSizePolicy damage dice scaling
-> optional save-outcome damage policy
-> optional DamageResolver damage consequence
-> optional DamageAdjustmentResolver per-target adjustment
-> optional concentration check requests from adjusted damage
-> optional HealingResolver healing consequence
-> optional target durability damage/absorption/healing mutation plans
-> optional EffectResolver condition mutation plans
-> configured payment-plan revalidation
-> ResourceResolver payment plan
-> Actor resource mutation plan
-> optional explicit-authority ResolutionTransaction commit
-> DocumentPersistencePort
```

The staged pipeline currently runs:

```text
ResolutionState
-> action.configuration
-> action.targeting
-> action.range
-> action.attack-roll
-> action.attack-outcome
-> action.save-roll
-> action.save-outcome
-> action.damage-roll
-> action.damage
-> action.healing
-> action.effects
-> action.payment
-> action.ready-to-commit
-> action.commit
-> action.finalization
```

Planning stops at `ready-to-commit` and does not mutate Foundry documents. Execution enters
`action.commit`, commits the staged result through the transaction/persistence boundary, and records
rollback/transaction data in the state trace/results.

The resolver emits semantic automation events for:

- action declared
- targets selected, when target data or target requirements are supplied
- attack roll
- attack hit
- attack miss
- save roll
- save success
- save failure
- payment required
- payment committed

The payment committed event is emitted only by the execution adapter after the transaction returns
successfully.

## What It Does Now

`planActionResolution()`:

- loads and validates an ActionDefinition from the Action Item when present
- deterministically adapts legacy cost-only Actions into an in-memory ActionDefinition
- resolves raw Action Configuration choices or revalidates an existing `ResolvedActionConfiguration`
- replaces the base definition with the configured effective definition for downstream resolver
  requests
- fails during validation with `ACTION_CONFIGURATION_INVALID` when a selected option or payment is
  no longer legal
- derives default resolver requests from persisted targeting, attack, save, damage, healing, and
  condition effect definitions
- builds an `ActionContext`
- validates source/action basics
- optionally resolves targets through `TargetResolver`
- optionally resolves supplied attack roll data through `AttackResolver`
- optionally resolves supplied save roll data through `SaveResolver`
- optionally applies WeaponSizePolicy to manufactured weapon damage components marked as scalable
- optionally applies save-outcome damage policies such as `success: "half"`
- optionally resolves supplied damage components through `DamageResolver`
- optionally applies target damage adjustments, reductions, and absorptions before durability
  planning
- optionally plans concentration check requests from final adjusted damage totals
- optionally resolves supplied healing components through `HealingResolver`
- optionally records target durability mutation plans for damage and healing
- optionally plans condition effect consequences through `EffectResolver`
- filters save-gated condition effects from already-resolved save outcomes
- carries duration, spell-origin, source, and concentration metadata on condition mutation plans
- resolves Action item activation cost through `ResourceResolver`
- passes the selected configuration payment plan to `ResourceResolver` for exact revalidation
- records a target-selection consequence when targets are resolved
- records an attack-resolution consequence when attack data is supplied
- records a damage-resolution consequence when damage data is supplied
- records a healing-resolution consequence when healing data is supplied
- records an effects-resolution consequence when condition effect data is supplied
- records a resource-payment consequence
- records target durability and resource-payment mutation plans
- returns an `ActionResult`

`executeActionResolution()`:

- runs the same planning flow
- can derive target Actor system snapshots from supplied target Actors
- prepares target durability transaction operations only with explicit authority
- prepares target condition-effect transaction operations only with explicit authority
- commits target durability, target condition effects, and source resource-payment operations
  through a single `ResolutionTransaction`
- rolls back already-committed target/source updates in reverse order when a later Actor update
  fails
- returns the resulting `ActionResult`

`commitPlannedActionResult()`:

- accepts an already-planned `ActionResult`
- commits supported target mutation and resource-payment plans without replanning
- records the payment-committed event and final complete step
- is shared by direct `executeActionResolution()` callers and the staged pipeline

`planStagedActionResolution()` / `resumeStagedActionResolution()`:

- create or resume a serializable `ResolutionState`
- pause for required Action Configuration choices
- pause for target selection or target refinement
- pause for attack/save/damage roll input using typed roll requests
- reject stale responses whose resolution id, request id, or request type does not match
- preserve completed stage ids so resumed work does not rerun earlier stages
- resolve representative target, range, attack, save, damage, healing, effect, and payment stages
  through existing domain resolvers
- stop at `ready-to-commit` with mutation plans and semantic events but no Actor updates

`executeStagedActionResolution()`:

- plans through the staged facade
- commits the staged result through `commitPlannedActionResult()` and `ResolutionTransaction`
- records `action.commit` and `action.finalization` trace entries
- preserves rollback behavior when later transaction operations fail

`WildPathActor#useAction()` now uses `executeActionResolution()` while preserving its current
boolean return behavior.

Invalid persisted definitions fail during validation with `ACTION_DEFINITION_INVALID`; payment is
not planned.

## What It Does Not Do Yet

The current resolver does not:

- render target/configuration/roll prompts
- derive attack bonuses or target defenses from Actor documents
- derive save bonuses or save DCs from Actor documents
- automatically drive every RollRequest through a `RollProvider`
- render the Action Configuration HUD or collect choices from players
- prompt for concentration checks or apply concentration save results
- commit generic non-condition ActiveEffects
- tick durations or break concentration
- open reaction windows
- create chat output

Those are future ActionResolver slices. The optional attack, save, damage, healing, and condition
steps consume already-known numeric roll, defense/DC, damage, healing, and effect-definition data;
they do not own roll UI, Foundry statistic gathering, generic ActiveEffect document commits,
duration ticking, or concentration prompts/results. Condition effects can commit when execution
receives target Actors and explicit authority; the commit adapter rolls back condition creates,
updates, and deletes if a later transaction operation fails. WeaponSizePolicy integration scales
structural dice and records provenance for explicitly manufactured weapon damage, but it does not
roll those dice or invent final damage amounts. This module exists so current action use already
enters the same pipeline shape that those slices will extend.

The staged facade can expose prompt requests and consume RollProvider results, but UI and socket
adapters are still future work. Area save resolution can consume per-target save data today; a
future multiplayer authority slice should route separate target-controller save requests.

## Next Resolver Slice

The next resolver slice should focus on multiplayer authority/socket routing for staged
ResolutionState ownership, prompt routing, RollProvider execution, and authoritative commits.
Direct Actor durability mutation remains outside DamageResolver itself.
