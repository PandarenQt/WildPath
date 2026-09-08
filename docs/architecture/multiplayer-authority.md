# Multiplayer Authority And Socket Routing

WildPath multiplayer action execution is an application/infrastructure layer around the existing
staged action pipeline. It does not add socket-owned rules, socket-owned mutation plans, or a
second request hierarchy.

The same authority and transport primitives also carry Foundry Token movement approval and
post-movement accounting. Movement is not forced through `ActionResolution`; it uses a small
movement authority helper that shares the active-GM selection, envelope validation, plain-data
transport, duplicate caches, and the `system.wildpath` socket namespace.

## Runtime Flow

```text
client command
-> ACTION_INTENT with stable refs only
-> selected resolution authority
-> authoritative document/state reconstruction
-> staged ResolutionState pipeline
-> sanitized pending request routing
-> remote PromptPort or RollProvider response
-> authoritative response validation
-> staged resume
-> ready-to-commit
-> explicit authority transaction commit
-> DocumentPersistencePort
-> sanitized result notification
```

`module/resolvers/multiplayer-action-coordinator.mjs` owns the authoritative runtime registry for
in-flight resolutions. It supports concurrent resolutions by keying records by `resolutionId`; there
is no global `currentResolution`.

The coordinator drives existing public contracts:

- `planStagedActionResolution()`
- `resumeStagedActionResolution()`
- `executeStagedActionResolution()`
- `ChoiceCoordinator` / `PromptPort`
- `RollProvider`
- `DocumentPersistencePort`

## Authority Policy

Resolution authority is selected in `module/helpers/multiplayer-authority.mjs`:

- if the initiator is the active GM, that GM owns the resolution
- if a player initiates and an active GM exists, the active GM owns the resolution
- if no active GM exists, local authority is allowed only when the initiating client can prove local
  commit permission
- otherwise the action intent fails with `AUTHORITY_UNAVAILABLE`

In Foundry, the runtime uses `game.users.activeGM` when available. This matches Foundry's built-in
"exactly one active GM should take action" selection rather than sorting connected GMs independently.

Request authority is separate from resolution authority. A GM may own `ResolutionState` while a
player remains the chooser/roller for a pending request.

Supported chooser policies are:

- `source-controller`
- `target-controller`
- `gm`
- `specific`
- `automatic`
- `local`

Chooser resolution happens at the application/infrastructure boundary using active user ids. No live
Foundry `User` document is stored in `ResolutionState`.

If the expected chooser is inactive, the request is not sent to an unrelated player. GM fallback is
used only when the request policy allows it; otherwise the resolution is cancelled with
`REQUEST_AUTHORITY_UNAVAILABLE`.

## Socket Envelope

`module/adapters/foundry-v14-resolution-socket-adapter.mjs` isolates Foundry socket access. The
adapter listens on:

```text
system.wildpath
```

The manifest enables that namespace with `"socket": true`.

Every message is a plain-data envelope:

```text
protocolVersion
messageId
messageType
senderUserId
recipientUserId / recipientUserIds / recipientPolicy
resolutionId
requestId
payload
metadata
```

The current message set is intentionally small:

- `ACTION_INTENT`
- `MOVEMENT_INTENT`
- `MOVEMENT_APPROVAL`
- `MOVEMENT_COMMIT`
- `MOVEMENT_RESULT`
- `PENDING_REQUEST`
- `REQUEST_RESPONSE`
- `RESOLUTION_CANCEL`
- `RESOLUTION_RESULT`
- `RESOLUTION_ERROR`

The envelope validator rejects non-plain values such as `Map`, `Set`, `Date`, functions, class
instances, Foundry Documents, Roll instances, Applications, PIXI objects, and Promises.

Movement messages use the same envelope and therefore the same serialization rule. A
`MOVEMENT_INTENT` contains stable Scene/Token/Actor refs, source user id, Foundry movement id,
movement kind/mode, and plain waypoint coordinates only. It does not carry a `Scene`,
`TokenDocument`, `Actor`, `Grid`, Foundry movement operation object, function, Promise, or client
assertion of legality/cost/affordability.

## Action Intent

`ACTION_INTENT` is not trusted as a mechanical plan. The coordinator sanitizes the payload and strips
client-supplied state, mutation plans, roll results, resolved previews, payment plans, damage,
healing, and effects before handing it to the authoritative resolver.

The Foundry runtime resolver in `module/resolvers/foundry-multiplayer-runtime.mjs` reconstructs the
action from stable refs:

- Actor ref
- Action Item ref
- source/token refs
- target Actor refs

The authority then builds the real staged action options locally. Players never send mutation plans.

## Pending Requests

When a stage pauses, the authority sends only the pending request payload. It does not broadcast the
full `ResolutionState`, hidden mutation plans, or target/source document objects.

Remote request handling uses existing ports:

- Action configuration and target prompts route through `PromptPort`
- attack, save, damage, manual, and physical rolls route through `RollProvider` when a provider is
  available
- manual prompt fallback still uses the same `roll` pending-request shape
- reaction windows route as `reaction-choice` pending requests through the same
  `PENDING_REQUEST` / `REQUEST_RESPONSE` envelope; no reaction-specific socket protocol is used

Once a chooser responds, the authority validates:

- `resolutionId`
- `requestId`
- request type
- the request is still pending
- the sender is the expected chooser user id
- duplicate/stale responses have not already been processed
- the existing stage/domain response validation still accepts the value

Only then does the authority call `resumeStagedActionResolution()`.

## Nested Resolution

Nested reaction children are not separate socket records. The authoritative parent record stores the
active child as plain data at `ResolutionState.metadata.activeChildResolution` and tracks known
parent/child resolution ids for routing.

The coordinator always advances the deepest active `ResolutionState`:

```text
parent paused
-> active child created
-> child pending requests routed by child resolutionId
-> child ready-to-commit
-> child transaction commits on the same authority
-> completeStagedReactionChildResolution()
-> parent resumes
```

Remote users still only answer `PENDING_REQUEST` envelopes. They never own or commit the child
resolution. Replayed responses after a terminal parent/child flow are treated as idempotent
duplicates and do not attempt another staged resume.

## Commit

Persistent mutation still begins at the existing commit boundary:

```text
ready-to-commit
-> executeStagedActionResolution()
-> commitPlannedActionResult()
-> ResolutionTransaction
-> DocumentPersistencePort
```

The multiplayer coordinator supplies explicit commit authority for the selected authority user. Test
coverage verifies persistence calls happen only in the authority context and duplicate responses or
duplicate action intents do not apply damage/resources twice.

## Movement Authority

Foundry Token movement follows the same authority policy:

```text
player TokenDocument#_preUpdateMovement
-> MOVEMENT_INTENT
-> active GM
-> authoritative Scene/Token/Actor reconstruction
-> MovementPath evaluation
-> MOVEMENT_APPROVAL
-> Foundry continues or rejects movement
-> moveToken hook fires after the Token update workflow concludes
-> checkpoint / pause / stop observation, or movement.finished true
-> active GM verifies source footprint and observed ordered prefix
-> authoritative informational movement AutomationEvents
-> newly verified economy.movement cost minus already paid prefix cost
-> MOVEMENT_RESULT
```

No active GM follows the existing local-authority policy: local authority is only allowed when the
initiating client can prove local commit permission. Otherwise movement approval fails with the same
authority-unavailable behavior used by Actions.

The active GM stores root approval records keyed by Foundry movement id plus Scene/Token identity.
Linked operations are indexed privately to that root and retain their starting transition index.
Continuation requires an exact prior chain, the same subpath, and the same approved suffix and costs;
new splits, missing prior observations, or terminal roots are rejected. In normal active-GM play,
progress is observed from Foundry's `moveToken`, `pauseToken`, and `stopToken` hooks, not
`TokenDocument#_onUpdateMovement`. V14 documents `moveToken` as firing after conclusion of the Token
update workflow and on all connected clients after the update has been processed. Before yielding,
the adapter snapshots the hook's updated Token document as local authoritative evidence and reads its
underlying source values with `TokenDocument#toObject(true)`, evaluates the full Token footprint at
that explicit source position through the TacticalGrid adapter, and confirms the resulting anchor is
the verified route prefix destination. This is intentionally stronger than comparing
`TokenMovementOperation.destination` to the approval. The committed movement cache makes duplicate
completion delivery idempotent.

The `MOVEMENT_COMMIT` socket path remains available for retrying locally verified unpaid cost. For
remote completion envelopes, the socket envelope sender is the authority fact. If a
`MovementCompletion.sourceUserId` claim is present and differs from `senderUserId`, the active GM
rejects the commit as `WRONG_USER` before resolving documents or persistence. The approved movement's
initiator is also checked independently against the sender. A per-root serial queue covers local
observations, continuation approval, and payment retries. Increasing observations each reconcile
against the latest verified/paid state; duplicate or lower prefixes never charge twice. Payment
failure preserves actual progress/events, leaves paid cost/count unchanged, and records the failure.
Retries pay `verified cumulative prefix budget cost - committed prefix cost` through ResourceResolver.

Only local authoritative movement lifecycle evidence can generate movement facts. The GM reconstructs
the ordered passed segment through the footprint-aware adapter and matches it at its approved index,
including the full source footprint. A repeated anchor does not reset that index. Pending waypoints
and unfiltered recorded/unrecorded history are never used as proof. Pending approval emits nothing. Reconciliation
stores the completed progress and stable-ID events before notifying observers, so duplicate or
concurrent callbacks cannot replay steps. Payment failure leaves those verified facts intact; a
successful retry only retries payment.

Socket completion without local progress fails as `MOVEMENT_PROGRESS_UNVERIFIED`; route and endpoint
claims cannot authorize payment or semantic events. It may retry a debt already verified locally,
even after the Token has moved elsewhere, using the approved Token Actor association. The informational
`wildpath.automationEvent` hook runs on the authority only; canonical events are not broadcast
or generated by the player. Reaction choices reuse the Action request protocol described below. See
[event contracts and observer failure semantics](events-and-reactions.md#movement-automationevents).
The existing permitted no-GM local authority policy remains in force. Approval/progress/event records
and duplicate guards remain in memory, with no durable replay or GM-handoff recovery protocol.
Before reconciliation and payment, authority selection is checked again. If the GM is unavailable
or authority has changed, the old approval owner fails closed instead of authoring facts or paying
that local observation; transfer/recovery of the approval is not implemented. A new authority without
the root record rejects with `MOVEMENT_NOT_APPROVED`. No durable or distributed exactly-once claim
is made. A copy-only `getMovementProgress()` diagnostic reports verified and paid prefixes without
exposing another mutable map; see [movement paths](movement-paths.md#verified-v14-lifecycle-and-production-interruption).

The Foundry movement adapter also distinguishes Token operation semantics from WildPath movement
kinds. Ordinary translation still becomes a MovementPath and can spend `economy.movement`. A pure
Token footprint resize, such as a zero-cost V14 `config`/`displace` operation from 1x1 to 2x2,
preserves `width`, `height`, `depth`, and `shape` in the plain intent, validates the authoritative
origin footprint state on the active GM, approves with no movement payment, and verifies the
completed source state before marking it committed. Combined translation plus resize is represented
separately and currently rejected with a structured unsupported-operation result.

The authority commits movement spend through the existing `ResourceResolver` mapping:

```text
newly verified, unpaid MovementPath prefix cost
-> movement payment plan for economy.movement
-> createActorResourceMutationPlan()
-> commitActorResourceMutationPlan()
-> DocumentPersistencePort
```

Forced movement and teleport approvals can validate route topology/destination footprint without
ordinary movement spend when they are explicitly identified by WildPath movement metadata. Ordinary
drag movement remains voluntary walk movement by default.

## Tests

`test/multiplayer-authority.test.mjs` provides deterministic multi-client coverage with
`module/adapters/test-resolution-transport.mjs`:

- player-declared persisted attack routed to active GM authority
- remote attack RollProvider response from the source controller
- configured action choice routed to the player with preview/resource parity
- physical d20 result routed through the same `RollProvider` response path
- duplicate `REQUEST_RESPONSE` and duplicate `ACTION_INTENT` idempotency
- wrong-user, wrong-request, and stale response rejection
- disconnected chooser GM fallback and no-fallback failure
- no-active-GM local authority only with proven commit permission
- multiple active GM candidates selecting exactly the designated active GM
- non-plain socket payload rejection

`test/reaction-pipeline-integration.test.mjs` also proves production nested reaction orchestration:
the default coordinator handles a defender reaction choice, commits the child reaction Action on the
GM authority, resumes the parent, routes a nested child attack roll by child `resolutionId`, and
ignores replayed responses without duplicate effects, damage, or resource spending.

## Current Limits

### Movement-hosted reactions

Movement preparation and final approval share the existing MOVEMENT_INTENT/MOVEMENT_APPROVAL
exchange. `metadata.reactionPreparation` asks only for the authoritative checkpoint capability;
it does not create an approval record or approve geometry. Final operation approval supplies the
plain correlated boundary after authoritative MovementPath validation. The initiator establishes
the local keyed pause synchronously; it performs no authoritative trigger discovery.

After GM-local verification and prefix payment, `resolveTriggeredEvent()` hosts the exact canonical
event. This local application port cannot be invoked through an ACTION_INTENT containing a supplied
event or ResolutionState. Reaction-choice prompts, nested children, rolls, and commits use the same
multiplayer Action coordinator as ordinary Actions. Concurrent repeated choice responses are claimed
before awaiting resumption to prevent two children. The event host reuses existing ancestry/depth
checks; the movement record additionally retains handled event and one-shot trigger identities.

`MOVEMENT_CONTINUATION` carries `{boundary, directive}` where directive is `continue` or
`cancel-parent`. The boundary contains root movement, Foundry operation, transition, event, window,
and pause-key identities. The envelope resolution ID must match its operation, and the sender must
be both the recorded approval authority and current active GM. The initiator adapter rejects
mismatched identities, buffers early directives until the keyed hold exists, and ignores replay.
Only this adapter calls Foundry resume/stop primitives. Suffix revalidation and cancellation run
inside the existing per-root authority queue. No movement or child Action costs are refunded.

The existing no-GM policy still supports ordinary movement. The new triggered-event hosting port
currently requires an active GM; a configured reaction without one fails closed. Reload, disconnect,
GM handoff, or transport failure can leave a hold requiring the initiator to stop movement. There is
no automatic timeout release, durable recovery, or claim of distributed exactly-once processing.
See [synchronization details](movement-paths.md#generic-movementreaction-synchronization) and
[live QA](../development/movement-reaction-qa.md). The movement/reaction composition passed its real
Foundry V14.367 multiplayer gate on `ddb26f6591c95db9b5dc21a856d3bfa5f15f90e4`.

This is not yet a full authority server or failover system.

Not implemented here:

- socket transport retries
- mid-resolution authority failover
- full HUD request routing
- chat rendering
- movement undo/refund accounting
- persistent area lifecycle networking
- cross-client secret visibility policy beyond sanitized result/request payloads

Generic reaction-choice routing and nested child advancement are covered by deterministic transport
tests. The live movement/reaction gate additionally proved active-GM authority, a real player prompt,
synthetic Token Actor persistence, nested ActiveEffect/resource commits, `cancel-parent`, and
resume/termination delivery. Other multiplayer consumers and failover scenarios require their own
runtime verification.

## Foundry V14 References

- Foundry system manifests can enable a system socket namespace with `"socket": true`:
  https://foundryvtt.com/article/system-development/
- The V14 manifest type includes a `socket` field:
  https://foundryvtt.com/api/v14/interfaces/foundry.packages.types.SystemManifestData.html
- `game.socket`, `game.user`, `game.userId`, and `game.users` are on the V14 `Game` object:
  https://foundryvtt.com/api/v14/classes/foundry.Game.html
- `game.users.activeGM` identifies the active GM for "only one user should take action" workflows:
  https://foundryvtt.com/api/v14/classes/foundry.documents.collections.Users.html
