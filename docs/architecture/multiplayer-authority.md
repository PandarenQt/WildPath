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
-> active GM observes its post-update TokenDocument movement
-> movement.finished true
-> active GM commits approved economy.movement spend once
-> MOVEMENT_RESULT
```

No active GM follows the existing local-authority policy: local authority is only allowed when the
initiating client can prove local commit permission. Otherwise movement approval fails with the same
authority-unavailable behavior used by Actions.

The active GM stores approval records keyed by Foundry movement id plus Scene/Token identity. In
normal active-GM play, completion is observed by the active GM's own TokenDocument post-update
lifecycle instead of relying on the initiating player to report completion before the GM's local
Scene collection has settled. At commit time the GM re-resolves the current Token and confirms its
actual anchor is the approved route destination. The committed movement cache makes duplicate
completion delivery idempotent.

The `MOVEMENT_COMMIT` socket path remains available for explicit fallback/manual delivery. For
remote completion envelopes, the socket envelope sender is the authority fact. If a
`MovementCompletion.sourceUserId` claim is present and differs from `senderUserId`, the active GM
rejects the commit as `WRONG_USER` before resolving documents or persistence. The approved movement's
initiator is also checked independently against the sender. Concurrent observed or delivered
completions for the same movement key share an in-flight commit promise, so only the first successful
persistence transaction can spend movement. Failed persistence clears the in-flight guard without
marking the movement committed, allowing a later retry.

The authority commits movement spend through the existing `ResourceResolver` mapping:

```text
approved MovementPath cost
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

This is not yet a full authority server or failover system.

Not implemented here:

- socket transport retries
- mid-resolution authority failover
- full HUD request routing
- chat rendering
- movement interruption/pause accounting
- movement undo/refund accounting
- persistent area lifecycle networking
- cross-client secret visibility policy beyond sanitized result/request payloads

Generic reaction-choice routing and nested child advancement are covered by deterministic transport
tests, but live Foundry multiplayer reaction QA remains outstanding.

Live Foundry runtime QA remains required. The Node tests prove the coordinator, envelope,
deterministic transport, request routing, RollProvider/PromptPort usage, and authority commit
behavior.

## Foundry V14 References

- Foundry system manifests can enable a system socket namespace with `"socket": true`:
  https://foundryvtt.com/article/system-development/
- The V14 manifest type includes a `socket` field:
  https://foundryvtt.com/api/v14/interfaces/foundry.packages.types.SystemManifestData.html
- `game.socket`, `game.user`, `game.userId`, and `game.users` are on the V14 `Game` object:
  https://foundryvtt.com/api/v14/classes/foundry.Game.html
- `game.users.activeGM` identifies the active GM for "only one user should take action" workflows:
  https://foundryvtt.com/api/v14/classes/foundry.documents.collections.Users.html
