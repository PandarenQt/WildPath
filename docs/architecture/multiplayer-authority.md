# Multiplayer Authority And Socket Routing

WildPath multiplayer action execution is an application/infrastructure layer around the existing
staged action pipeline. It does not add socket-owned rules, socket-owned mutation plans, or a
second request hierarchy.

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
- `PENDING_REQUEST`
- `REQUEST_RESPONSE`
- `RESOLUTION_CANCEL`
- `RESOLUTION_RESULT`
- `RESOLUTION_ERROR`

The envelope validator rejects non-plain values such as `Map`, `Set`, `Date`, functions, class
instances, Foundry Documents, Roll instances, Applications, PIXI objects, and Promises.

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

Once a chooser responds, the authority validates:

- `resolutionId`
- `requestId`
- request type
- the request is still pending
- the sender is the expected chooser user id
- duplicate/stale responses have not already been processed
- the existing stage/domain response validation still accepts the value

Only then does the authority call `resumeStagedActionResolution()`.

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

## Current Limits

This is not yet a full authority server or failover system.

Not implemented here:

- socket transport retries
- mid-resolution authority failover
- full HUD request routing
- chat rendering
- movement/reaction networking
- persistent area lifecycle networking
- cross-client secret visibility policy beyond sanitized result/request payloads

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
