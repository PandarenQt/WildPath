# ResolutionState And Staged Pipeline

`module/helpers/resolution-state.mjs` is the pure, serializable state and stage-runner foundation
for addressable action resolution.

It is an application/orchestration contract. Domains still own their rules. A stage may call
`TargetResolver`, `AttackResolver`, `SaveResolver`, `DamageResolver`, `HealingResolver`,
`EffectResolver`, or `ResourceResolver`, but it should not reimplement those domain rules.

## State Contract

`ResolutionState` is plain JSON-serializable data with:

- a stable execution id
- lifecycle status
- parent/child provenance
- action definition and source/origin data
- resolved configuration
- targets, target sets, and target refinement
- roll requests and roll results
- domain outcomes/results
- pending typed requests
- mutation plans
- semantic events
- current stage id
- completed stage ids
- per-stage statuses
- trace entries
- validation, errors, warnings, input, and metadata

Runtime-only values such as Foundry documents, DOM nodes, Applications, closures, and stage
functions do not belong in `ResolutionState`. Stage descriptors are runtime objects; the state
stores only their stable ids and trace/results.

## Lifecycle

The current lifecycle statuses are:

- `created`
- `running`
- `awaiting-configuration`
- `awaiting-targets`
- `awaiting-roll`
- `awaiting-choice`
- `paused`
- `ready-to-commit`
- `committing`
- `completed`
- `failed`
- `cancelled`

Callers should inspect `status` and `pendingRequests`; they should not infer lifecycle from
missing fields.

## Stage Contract

A runtime stage has:

- `id`
- optional `canRun(state, services)`
- `run(state, services)`
- serializable metadata

`run` returns a `StageResult`:

- `continue`
- `wait`
- `fail`
- `complete`

The stage runner records a structured trace entry for every stage result. Completed stage ids are
preserved so a resumed resolution does not rerun earlier completed work.

## Pause And Resume

When a stage needs external input, it returns `wait` with one or more pending requests. Requests
carry:

- request id
- resolution id
- stage id
- request type
- expected response type
- validation details
- chooser/authority metadata
- payload
- metadata

`resumeResolutionPipeline()` rejects stale or mismatched responses unless all of these match:

- resolution id
- request id
- request type

Accepted responses are stored in `requestResponses` and `responses`, then the runner resumes from
the waiting stage.

Current request types include:

- `action-configuration`
- `target-selection`
- `target-refinement`
- `roll`
- `reaction-choice`
- `choice`

The pipeline exposes requests only. `docs/architecture/prompts.md` describes the
ChoiceCoordinator/PromptPort bridge for local Foundry prompts and deterministic test prompts.
`docs/architecture/multiplayer-authority.md` describes the application/socket layer that routes
those same pending requests to the expected active chooser without broadcasting full
`ResolutionState`.

## Child Resolutions

`createChildResolutionState()` creates a child state with:

- parent execution id
- relationship
- source event
- incremented depth
- ancestry
- trigger identity history

It enforces a configurable depth limit and rejects repeated trigger identities already present in
the ancestry. This is not a complete ReactionEngine; it is the guard rail needed before reactions,
triggered actions, and interrupt windows can safely resume parent resolutions.

## Mutation Boundary

Stages before commit must not perform irreversible Foundry document mutation. They may produce
mutation plans and semantic events.

The commit boundary remains `module/resolvers/resolution-transaction-resolver.mjs`, which performs
ordered commits and rollback. Staged action execution now reaches that boundary with the
already-planned `ActionResult`, then commits through `DocumentPersistencePort` instead of
replanning through the compatibility resolver.

## Current Action Wrapper

`module/resolvers/action-pipeline-resolver.mjs` is now the staged action orchestration path for
representative execution slices. `ActionResolver` remains the compatibility facade and shared
planning/helper module for direct callers.

It currently provides:

- `createActionResolutionState()`
- `createActionResolutionPipeline()`
- `planStagedActionResolution()`
- `resumeStagedActionResolution()`
- `executeStagedActionResolution()`

The current stage sequence is:

```text
action.configuration
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
```

Planning stops at `ready-to-commit`. Execution then marks `action.commit`, commits the staged
result through `commitPlannedActionResult()` and the transaction/persistence boundary, and records
`action.finalization` on success.

This wrapper can:

- pause for required Action Configuration and resume with responses
- revalidate supplied `ResolvedActionConfiguration`
- pause for target selection or target refinement
- pause for attack, save, or damage roll results
- preserve completed stage ids across resume
- resolve target, range, attack, save, damage, healing, effect, and payment stages through existing
  domain resolvers
- plan without mutating Actors
- commit through the existing transaction path and `DocumentPersistencePort`
- preserve rollback behavior when a later commit operation fails

## Current Limitations

The staged path intentionally covers representative persisted action slices rather than every future
mechanic. Direct `ActionResolver` callers can still use the compatibility planning/execution API,
and some presentation, document-lifecycle, and generic ActiveEffect responsibilities remain outside
the staged resolver.

The `ACTION_PIPELINE_STAGE_IDS.LEGACY_RESOLUTION` constant remains only as audit vocabulary for
older tests/docs. The default action pipeline no longer includes an `action.legacy-resolution`
stage.

The Roll abstraction is now implemented. `module/helpers/rolls.mjs` defines the serializable
RollRequest/RollResult contracts, `module/resolvers/roll-provider-resolver.mjs` provides provider
selection plus manual/physical/test providers, and
`module/adapters/foundry-digital-roll-provider.mjs` provides the Foundry digital adapter. Digital,
manual, and physical sources feed the same typed `roll` request/result path.

Manual/physical input can now route through the generic Foundry-facing prompt/choice adapter or the
multiplayer authority coordinator. The remaining integration gap is live Foundry runtime QA and
richer UI presentation over the same request payloads. ResolutionState must continue to store plain
request/result data rather than Foundry Roll objects, Applications, callbacks, or pending Promises.

Generic reaction-window execution is now provided by `module/resolvers/reaction-resolver.mjs`.
Reaction state remains plain data under `metadata.reactionWindows`, and chosen reactions create
child `ResolutionState` objects through the existing ancestry/depth guard. The default action
pipeline still needs production window insertion around specific timings such as action-declared,
after-outcome, and before-damage. See `docs/architecture/reactions.md`.
