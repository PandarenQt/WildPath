# Prompt And Choice Adapter Architecture

WildPath prompt coordination is the application/presentation bridge for external input that an
already-running `ResolutionState` is waiting on.

```text
ResolutionState.pendingRequests
-> ChoiceCoordinator
-> PromptPort
-> FoundryV14PromptAdapter or TestPromptAdapter
-> correlated plain-data response
-> existing resume/domain validation
```

This layer does not create a new pending-request system. The canonical envelope remains
`RESOLUTION_REQUEST_TYPES`, `createResolutionRequest()`, and `ResolutionState.pendingRequests` in
`module/helpers/resolution-state.mjs`.

## Ownership

`ChoiceCoordinator` lives in application orchestration. It may:

- choose a pending request from `ResolutionState`
- check local authority metadata
- choose a prompt/input port
- queue local prompts by request/resolution identity
- normalize prompt-port outcomes
- validate request id, resolution id, request type, and expected response type
- submit the response through the existing resume function

It must not calculate option legality, target eligibility, roll modifiers, spell-slot scaling,
damage-type substitutions, resource payment legality, or action availability.

## PromptPort

`PromptPort` is a small presentation/input port. A port collects local input and returns only plain
serializable data. It must not mutate Actors, Items, Active Effects, resources, targets, or UI-owned
state that becomes part of `ResolutionState`.

Current implementations:

- `module/adapters/foundry-v14-prompt-adapter.mjs`
- `module/adapters/test-prompt-adapter.mjs`

The deterministic test adapter makes staged prompt flows testable without Foundry.

## Foundry V14 Adapter Boundary

The Foundry adapter is infrastructure. It translates an existing request view model into Foundry UI
and translates the submitted form back into the existing response payload shape.

The verified V14 API used for this first slice is `foundry.applications.api.DialogV2.input()`.
`DialogV2` is ApplicationV2-based in Foundry V14, so new prompt UI stays on the current application
stack. The adapter also accepts an injected `DialogV2` implementation for tests.

Foundry Applications, DOM nodes, event listeners, callbacks, Promises, and Foundry Documents must
not enter `ResolutionState`.

## Reused Request Contracts

Action configuration prompts reuse `ActionChoiceRequest[]` discovered by
`discoverActionConfigurationChoices()`. Select-one, select-many, boolean, number, resource,
damage-type, and option requests are rendered from those records. The UI returns values in shapes
the configuration layer already validates, for example `{choices: {"mode": {optionId: "careful"}}}`
or `{choices: {"targets": {values: ["a", "b"]}}}` for select-many choices.

Manual and physical dice use the canonical `roll` pending request and the Roll domain's
`RollRequest`. The prompt adapter may collect a natural d20 result, but
`createRollResultFromManualInput()` validates it and constructs the normalized `RollResult`.

Target selection and target refinement may be rendered as a list prompt when appropriate, but
targeting legality remains in the Targeting domain. Full canvas/battlefield interaction belongs to
the TacticalGrid/Target adapter milestone.

## Correlation And Staleness

Prompt responses must correlate with:

- resolution id
- request id
- request type
- expected response type

The coordinator rejects mismatched, duplicate, already-accepted, stale, or wrong-type responses
before they are stored. After storage, the owning domain still revalidates meaning. A payment option
selected while a prompt was open can become invalid before resume, and the configuration/resource
layers must catch that before mutation planning.

## Cancellation

Prompt outcomes distinguish:

- a normal response
- an optional choice declined
- a required request cancelled
- prompt failure
- unhandled or remote authority required

Cancelling a required request cancels the resolution before commit-like stages. Declining an optional
choice is a structured response and can allow the resolution to continue when the owning stage
accepts that semantics.

## Authority

`ChoiceCoordinator` still only collects local input. Remote ownership is handled one layer above it
by `module/resolvers/multiplayer-action-coordinator.mjs`.

The multiplayer coordinator routes the same pending request to the expected active chooser, then the
receiving client uses its local PromptPort or RollProvider to answer. The authority validates
resolution id, request id, request type, expected chooser user id, current pending status, and
duplicate/stale state before resuming. See `docs/architecture/multiplayer-authority.md`.

## Sequential And Concurrent Prompts

One resolution may produce several prompts in sequence. The adapter renders whichever existing
request is currently pending, then the coordinator resumes and lets the pipeline discover the next
request.

Multiple resolutions may have pending requests at the same time. The coordinator does not use a
global `currentPrompt`; it uses resolution/request identity and a small application-level queue for
local prompt ordering.

## Serialization And Mutation

Requests and responses crossing this boundary must be plain serializable data. Non-plain values such
as `Map`, `Date`, class instances, DOM nodes, functions, callbacks, Foundry Documents, Applications,
and Promises are rejected or isolated at the adapter boundary.

Prompt interaction, preview refresh, and response collection must not perform persistent mutation.
Resource spending, damage application, condition/effect changes, and action economy changes remain
behind the transaction/commit boundary.

## Current And Future Consumers

The socket authority router now consumes the same request payloads. The future HUD and Foundry
battlefield target adapter should also consume them directly. They may render them differently, but
must not change their rule semantics or create parallel pending-request contracts.
