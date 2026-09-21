# Multiplayer Confidentiality: Disclosure And Targeted Transport

This document describes how WildPath keeps private multiplayer resolution traffic away from
unrelated connected clients. It complements [multiplayer-authority.md](multiplayer-authority.md),
which owns authority and routing. Nothing here changes who may decide or commit.

## Three separate questions

```text
AUTHORITY    Who may decide or commit?          multiplayer-authority.mjs, the coordinators
ROUTING      Who should process a message?      recipientUserId / recipientUserIds / recipientPolicy
DISCLOSURE   Who is allowed to learn its contents?   multiplayer-disclosure.mjs, the transport adapters
```

The core invariant:

```text
recipientUserId is routing metadata. recipientUserId is NOT confidentiality.
Anything emitted through system.wildpath must be safe for every connected client to inspect.
```

## Threat model

Protected against: **ordinary connected clients inspecting broadcast traffic** (a player with the
browser console open, a listener on `game.socket`) and learning data not intended for them.

Not addressed, by design: malicious server administrators, a compromised Foundry server, browser
extensions with arbitrary page access, endpoint compromise, at-rest storage, or TLS configuration.
The server relays every targeted payload in clear and is trusted. This is **client-level
confidentiality** through **recipient-restricted transport**; it is not cryptographic confidentiality
and must not be described as such.

## Why the broadcast bus cannot carry private data

The `system.wildpath` namespace is a Foundry custom socket. The installed 14.367 server relay
(`dist/components/*`: `registerCustomSocket` → `handleCustomSocket`) does `socket.broadcast.emit`,
which delivers every emission to **every other** connected client and **never back to the sender**.
Receipt filtering by `recipientUserId` only decides which client processes an envelope; every client
already holds the bytes. Two consequences shape the design:

- private payloads need a different transport, not a stricter filter;
- an envelope addressed to the sender itself (a GM initiating its own action) is never echoed, so
  self-addressed envelopes must be delivered locally by the transport.

The relay also honours an undocumented `{recipients: [userIds]}` third emit argument that restricts
delivery to listed users and passes the attested sender id to the handler. WildPath does not rely on
it because it is not part of the documented API; it is recorded here as an observed alternative.

## Disclosure classifications

`module/helpers/multiplayer-disclosure.mjs` defines:

```text
BROADCAST_SAFE        every connected client may read it            → broadcast bus
PARTICIPANT_PRIVATE   only the addressed participant and the authority → targeted transport
GM_PRIVATE            only a GM may receive it                       → targeted transport, GM recipient
```

Every envelope carries a `disclosure` field. `createResolutionSocketEnvelope` classifies once, from
an explicit option or from the audited per-message-type policy:

| Message type | Classification | Why |
| --- | --- | --- |
| `ACTION_INTENT` | `BROADCAST_SAFE` | stable refs only; the action becomes visible on the table |
| `MOVEMENT_INTENT`, `MOVEMENT_COMMIT` | `BROADCAST_SAFE` | refs and coordinates core already replicates |
| `PENDING_REQUEST` | `PARTICIPANT_PRIVATE` | roll requests (DC, target identity), reaction candidates, prompt options |
| `REQUEST_RESPONSE` | `PARTICIPANT_PRIVATE` | roll results, reaction decisions, configuration choices |
| `RESOLUTION_ERROR`, `RESOLUTION_CANCEL` | `PARTICIPANT_PRIVATE` | failure reasons and diagnostics |
| `MOVEMENT_APPROVAL` | `PARTICIPANT_PRIVATE` | movement budget/spend and the armed `reactionBoundary` |
| `MOVEMENT_RESULT`, `MOVEMENT_CONTINUATION` | `PARTICIPANT_PRIVATE` | payment plans, resource values on failure, reaction window identity |
| `RESOLUTION_RESULT` | **explicit per projection** | see below |

`RESOLUTION_RESULT` has no default. The coordinator emits two projections and classifies each.
No message is `GM_PRIVATE` today; the classification exists, is refused by the broadcast adapters,
and is enforced by the routed transport (the recipient must be a GM in the user directory).

## Transport selection

```text
coordinator (envelope + classification)
  -> selectDisclosureTransport            module/helpers/multiplayer-disclosure.mjs
  -> disclosure-routed transport          module/adapters/disclosure-routed-transport.mjs
       local     single recipient == local user  (any classification)
       broadcast BROADCAST_SAFE                  → foundry-v14-resolution-socket-adapter.mjs
       targeted  PARTICIPANT_PRIVATE / GM_PRIVATE → foundry-v14-user-query-transport.mjs
```

Fail-closed rules, each with a structured code:

- unclassified envelope → `UNCLASSIFIED_DISCLOSURE` (routed transport, both adapters, the envelope
  validator rejects unknown strings as `INVALID_ENVELOPE`);
- private envelope offered to the broadcast adapter → `PRIVATE_PAYLOAD_REQUIRES_TARGETED_TRANSPORT`;
  the adapter also refuses to **dispatch** a private envelope it receives on the bus
  (`PRIVATE_PAYLOAD_ON_BROADCAST_TRANSPORT`);
- private envelope without exactly one recipient → `PRIVATE_PAYLOAD_REQUIRES_SINGLE_RECIPIENT`;
- `GM_PRIVATE` to a non-GM → `GM_PRIVATE_REQUIRES_GM_RECIPIENT`;
- no targeted port → `PRIVATE_PAYLOAD_REQUIRES_TARGETED_TRANSPORT`;
- targeted failures: `TARGETED_RECIPIENT_UNAVAILABLE`, `TARGETED_TRANSPORT_FORBIDDEN`,
  `TARGETED_TRANSPORT_TIMEOUT`, `TARGETED_TRANSPORT_REJECTED`;
- identity: `DISCLOSURE_SENDER_MISMATCH`, `DISCLOSURE_RECIPIENT_MISMATCH`.

Nothing is downgraded to broadcast and nothing continues after a warning. The application keeps
calling `game.wildpath.executeActionIntent` / `executeMovementIntent`; it never sees which transport
carried a message.

## The targeted mechanism: `User#query`

Verified against the installed 14.367 source, not assumed:

- `User#query(name, data, {timeout})` (`client/documents/user.mjs`) requires the name to be registered
  in `CONFIG.queries` (system names are prefixed: WildPath uses `wildpath.resolutionEnvelope`),
  requires the **sender** to hold `QUERY_USER` (granted to the PLAYER role by default,
  `common/constants.mjs`), refuses inactive recipients, and emits `userQuery` to the server.
- The server (`dist/components/activity.mjs`) re-checks the sender permission, resolves the recipient,
  and emits **only to that user's sockets** with an acknowledgement, honouring `timeout` and rejecting
  if the sender disconnects.
- The recipient's `Users.#handleUserQuery` calls the handler with `{timeout, user}` where `user` is the
  **server-attested querying User**. The handler rejects an envelope whose `senderUserId` disagrees
  with it, or that is not addressed to the local user.
- The acknowledgement is a delivery receipt only. The handler validates and then dispatches to the
  coordinators **without awaiting them**, so a reaction dialog that stays open for minutes never
  holds a query acknowledgement the server would time out.
- Payloads are JSON; the same plain-data envelope validator applies to both transports.

The broadcast adapter additionally verifies the attested sender that the custom-socket relay appends
to every delivery and drops envelopes whose claimed `senderUserId` disagrees.

Practical requirements this creates:

- players need the `QUERY_USER` permission to answer prompts and rolls; the runtime warns at `ready`
  when the local user lacks it, and the response then fails closed;
- the query handler is registered at `ready`; a query that reaches a client before that times out
  on the sender (15 s) with `TARGETED_TRANSPORT_TIMEOUT`.

## Data minimization

**Chooser payloads** (`sanitizePendingRequestForTransport`): the payload top level drops
`state`, `resolutionState`, `mutationPlans`, `transaction`, `rollResults`, `results`,
`targetSystems`, `actorSystem`, `actorSystems`, `dc`, `defense`, `defenses`. Roll requests are
projected by `projectRollRequestForChooser`: the roller keeps the request identity, dice
definition, modifiers, expectations, roll mode, visibility and stable source/target refs, and never
receives `dc`, `data`, or target defenses. (The RollRequest normalizer already reduced targets to
identity; the projection makes that a contract rather than a coincidence.)

**Error diagnostics** (`sanitizeResolutionErrorDataForTransport`): only scalar values cross the
transport; the full failure object stays in the sender's local `errors` log.

**Result projections** (`projectResolutionResultForDisclosure`):

- `PARTICIPANT_PRIVATE`: the full sanitized result, tagged; sent targeted to the initiator and kept
  locally by the authority.
- `BROADCAST_SAFE`: an allow-list — ids, status, `authorityUserId`/`initiatorUserId`, action and
  source/target refs, per-target attack `hit/critical/outcome`, per-target save
  `success/critical/outcome`, the movement outcome, and roll `natural/total` only for rolls whose
  request `visibility` is `public`. It carries no defenses, DCs, margins, damage/healing amounts,
  effects, payment, committed mutations, preview, configuration, or trace.

A client that already holds the participant projection never lets the later public projection
overwrite it.

## What remains intentionally broadcast

`ACTION_INTENT`, `MOVEMENT_INTENT`, `MOVEMENT_COMMIT` (refs and coordinates) and the public
`RESOLUTION_RESULT` projection. Everything else is targeted or local.

## Evidence

- **Node** (`test/multiplayer-disclosure.test.mjs`, plus disclosure assertions in
  `test/staged-movement.test.mjs` and `test/foundry-nested-reaction-commit.test.mjs`): the fifteen
  contract requirements, the `recipientUserId !== confidentiality` regression, adapter identity
  checks, `User#query` failure mapping, local self-delivery, projections and minimization. The test
  hub mirrors production: a bus that excludes the sender and refuses private data, a targeted port
  that delivers to exactly one endpoint with attested identity, local self-delivery.
- **Quench** (`wildpath.multiplayer-disclosure`, 4 cases): wiring and `CONFIG.queries` registration,
  the real socket adapter's refusal with no `system.wildpath` emission, a real `User#query` relay
  through the server with receipt, and the handler's identity checks. One GM client cannot prove
  cross-browser privacy and this batch does not claim to.
- **Level 5** (`docs/development/staged-movement-qa.md`, evidence schema 2): the three sentinels
  record which message types crossed the bus, the targeted envelopes with sender/recipient, and the
  captured envelopes with private payloads omitted. The reaction sentinels use the GM as mover and a
  player as reactor controller so the reaction prompt and answer really cross the targeted transport
  between two browsers.

## Open questions and limits

- Rolls default to `visibility: "system"`; only explicit `public` rolls appear in the broadcast
  projection. Mapping the system default to a table's roll-mode setting is deferred to the
  chat-card milestone.
- Unrelated clients receive nothing about damage or healing amounts; a public chat card may later
  widen the allow-list deliberately, with tests.
- `sanitizeActionIntentPayload` strips known state keys but passes unknown client keys through; they
  are the initiator's own data and remain on the bus.
- Hidden-token movement, chat, fog, journals and permissions are outside this milestone.
