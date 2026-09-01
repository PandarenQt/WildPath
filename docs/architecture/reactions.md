# Reactions And Interruptible Child Resolution

WildPath reactions are normal triggered Actions, not a second action engine.

Current implementation lives in `module/resolvers/reaction-resolver.mjs` and builds on:

- semantic automation events from `module/helpers/automation-events.mjs`
- Trigger RuleElement contributions
- Predicate evaluation inside trigger matching
- Action Economy payment discovery for Reaction/custom resources
- `reaction-choice` pending requests in `ResolutionState`
- `createChildResolutionState()` ancestry and loop protection
- normal staged child Actions for reaction execution and resource commit
- existing multiplayer pending-request routing

## Concepts

The resolver keeps three concepts separate:

- Semantic event: a factual occurrence such as `attack.hit` or `action.declared`.
- Reaction window: an addressable interrupt point opened by a parent resolution.
- Reaction action: an ordinary `ActionDefinition` made available by a matching Trigger.

Events are facts, not UI commands. The engine should not emit events such as
`PromptDefenderForReaction`; it should emit facts like an interrupt-phase attack hit and then let
Triggers and Predicates decide whether a reaction is eligible.

## Discovery

`discoverReactionCandidates()` wraps the existing trigger/reaction-window helper and returns ordered
`ReactionCandidate` data. A candidate preserves:

- reactor Actor/Token refs
- reaction Action ref and optional ActionDefinition snapshot
- trigger id and source/provenance
- triggering event snapshot
- chooser metadata
- available payment options and selected default payment

Discovery is non-mutating. Spent reaction resources are rejected by Action Economy; the
ReactionResolver does not maintain its own `reactedThisRound` flag.

Ordering is deterministic:

1. trigger priority
2. explicit initiative/combat actor order when supplied
3. stable reactor actor id
4. stable action ref/id
5. stable trigger id

This is intentionally simple until the combat/timeline layer provides richer ordering policy.

## Windows And Requests

`planReactionWindow()` stores a plain `ReactionWindowState` under
`ResolutionState.metadata.reactionWindows` and either:

- closes immediately when no candidates are eligible, or
- creates one `reaction-choice` pending request for the next reactor's candidate group.

Multiple options for the same reactor are presented in one request with a Decline option. Multiple
reactors are offered in deterministic order; declining the current group advances to the next group.

The request payload is presentation-safe. It includes candidate summaries, cost/payment metadata,
source/provenance, and the event snapshot, but not mutation plans, live documents, functions, or a
full parent `ResolutionState`.

## Stage Boundary

`createReactionWindowStage()` is a thin ResolutionState stage helper. It can be inserted at explicit
pipeline boundaries and will:

```text
semantic event
-> discovery
-> no candidates: continue
-> candidates: wait on reaction-choice
-> decline: continue/advance to next reactor
-> use: create child state and pause parent
```

The staged action pipeline now opts into two addressable reaction stages when the parent state or
runtime services expose reaction discovery options:

- `action.reaction.after-action-declared`, after configuration and before target/roll resolution
- `action.reaction.after-attack-outcome`, after attack outcome and before damage planning

These stages use the same generic window/request helper. Additional timings should be added as
semantic events prove they are needed, not as named-feature branches.

## Parent And Child

Selecting a reaction creates a child `ResolutionState` with:

- `relationship: "reaction"`
- parent resolution id
- triggering event/window metadata
- candidate/source provenance
- incremented depth
- inherited trigger identity history

The parent moves to `paused` with no pending prompt while the child is active. The child can be run
through the normal staged action pipeline, which means reaction costs, rolls, effects, and commits
use the same ActionDefinition, RollProvider, transaction, and persistence boundaries as any other
Action.

The selected child state is also copied as plain data into
`metadata.activeChildResolution` on the parent so the authority/runtime layer has a serializable
handle while the parent is paused. `completeReactionChildResolution()` clears that handle when the
window completes.

Parent and child transactions remain separate. This lets a reaction commit before the parent
re-evaluates downstream consequences that the reaction may have changed.

## Re-Evaluation And Cancellation

`completeReactionChildResolution()` resumes the parent after the child finishes. It accepts a runtime
re-evaluation callback so the owning domain can recalculate the relevant downstream result. For
example, AttackResolver can recalculate an attack outcome after a defensive child Action changes the
observed defense value. ReactionResolver coordinates the timing; it does not decide attack rules.

Child results may carry an explicit parent directive. The first supported directive is
`cancel-parent`, which cancels the parent with structured state instead of throwing an exception for
normal gameplay interruption.

If a child fails or is cancelled, the current default policy resumes the parent safely and records
the failure. Callers can request parent cancellation for stricter mechanics.

## Multiplayer

No reaction-specific socket engine was added. `multiplayer-action-coordinator.mjs` now accepts
injectable resolution runners while defaulting to the staged action runner. This lets reaction
windows reuse the existing `PENDING_REQUEST` / `REQUEST_RESPONSE` protocol, chooser validation,
wrong-user rejection, duplicate/stale handling, and active-GM authority policy.

The authoritative client owns the parent and child resolution state. Remote players only answer
plain pending requests.

When a parent `ResolutionState` is paused with `metadata.activeChildResolution`, the default
multiplayer coordinator advances that nested child through the same staged action pipeline before
resuming the parent. Child pending requests use the child `resolutionId` in the existing socket
envelope and still route through ordinary chooser policies. The parent initiator is not inherited as
the chooser for nested source-controller child requests; ownership is derived from the child state
source/controller maps, with normal GM fallback policy if no controller is available.

Terminal child completion is idempotent. Replayed completion or request-response messages do not
re-run child commits, re-apply child effects, or resume the parent a second time.

## Loop Protection

Reaction child creation uses `createChildResolutionState()`, so existing depth limits and repeated
trigger identity checks apply to reaction chains. Nested reactions are possible, but repeated
candidate/event/action identities are rejected structurally instead of recursing forever.

## Current Tests

`test/reaction-resolver.test.mjs` covers:

- Trigger/Predicate-based candidate discovery
- unavailable reactions through spent Action Economy resources
- serializable `reaction-choice` requests
- zero-candidate windows closing without prompts
- deterministic multi-reactor ordering and decline advancement
- reaction-window stage pause/resume behavior
- normal child staged Action execution and Reaction resource commit
- generic outcome re-evaluation that can turn a preliminary hit into a miss
- explicit interrupt/cancel parent directives
- repeated-trigger loop protection
- multiplayer chooser routing and wrong-user rejection through the existing coordinator

`test/reaction-pipeline-integration.test.mjs` covers the first staged integration proof:

- action-declared and after-attack-outcome reaction windows inside the normal action pipeline
- a defensive child Action that commits a condition effect and Reaction payment before the parent
  attack re-evaluates from hit to miss
- decline and still-hit paths that continue into parent damage/payment without duplicate mutation
- a disruptive child Action that can cancel the parent through an explicit parent directive
- default multiplayer child orchestration with the defender as chooser and the active GM as
  authority
- a nested child attack roll routed by child `resolutionId` through the existing physical
  RollProvider/request-response flow
- duplicate response handling after parent/child completion without duplicate mutation

## Current Limits

Not yet implemented:

- reaction windows beyond action-declared and after-attack-outcome timings
- production defensive/disruptive reaction content
- opportunity attacks
- Movement-driven leave-reach events
- full simultaneous reaction ordering
- live Foundry V14 reaction QA
- final HUD presentation

The next practical step is live Foundry QA for these timings, then broader semantic timing coverage
driven by actual gameplay events.
