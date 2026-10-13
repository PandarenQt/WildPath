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

The `system.wildpath` namespace is a Foundry custom socket. The installed 14.367 server relay (re-checked unchanged in 14.369)
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
| `RESOLUTION_ERROR` | `PARTICIPANT_PRIVATE` | failure code and reason; `data` keeps only the resolution status |
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

Verified against the installed 14.367 source and re-checked unchanged in 14.369, not assumed:

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
to every delivery. It drops an envelope whose claimed `senderUserId` disagrees, and it fails closed
when no attested sender arrives at all, because the authority's ownership and chooser checks trust
`senderUserId`.

Practical requirements this creates:

- players need the `QUERY_USER` permission to answer prompts and rolls; the runtime warns at `ready`
  when the local user lacks it, and the response then fails closed;
- the query handler is registered at `ready`; a query that reaches a client before that times out
  on the sender (15 s) with `TARGETED_TRANSPORT_TIMEOUT`.

## Data minimization: default-deny projections

Every network projection is an **allow-list**: adding a field to an intent, ResolutionState, request,
result or error never publishes it. A parameterized secret-sentinel suite
(`test/multiplayer-disclosure.test.mjs`) plants `SECRET_*` values in extensible locations of every
projection, plus an end-to-end run with sentinels in authoritative state, and asserts none reach the
bus, a chooser payload, or the participant result.

**Correction (2026-10-13).** The first version of this milestone stripped known keys from the chooser
payload's top level only. Roll requests still carried the `attack`, `save` (with its DC), `targets`
(with each target's defense) and `targeting` objects to the chooser, and the participant result was
the full sanitized result. Neither reached the broadcast bus, but both contradicted this section. The
allow-lists below replace that denylist; the live run below proves the corrected payloads.

**`ACTION_INTENT`** (`sanitizeActionIntentPayload`): only the refs, ids and movement facts the
authority's resolvers read (`actorRef`, `actionRef`, `targetRefs`, `source` refs, configuration,
movement origin/waypoints/kind/mode, …).

**Chooser payloads** (`sanitizePendingRequestForTransport`), per request type:

- `roll`: `{rollRequest}` projected by `projectRollRequestForChooser`: identity, dice definition,
  modifiers, expectations, roll mode, visibility, chooser/authority, stable source/target refs, and
  metadata limited to `rollKind`/`d20`/`providerId`. Never `dc`, `data`, target defenses, or a
  concentration check request (which carries its DC).
- `target-selection` / `target-refinement`: candidates projected to ids, names, refs and
  selectable/eligible flags, plus `targeting.required`, decisions, and the min/max selection limits.
- `reaction-choice`: `{candidates, options}`; the triggering event snapshot is not sent.
- `action-configuration`: `{requests}`.
- any other type: nothing.

Request `metadata` keeps only `title`, `required` and `promptPortId` plus the routing block.

**Error diagnostics** (`sanitizeResolutionErrorDataForTransport`): the envelope carries the code and
reason; `data` keeps only the resolution `status`. The full failure object stays in the sender's local
`errors` log.

**Result projections** (`projectResolutionResultForDisclosure`):

- `PARTICIPANT_PRIVATE`: the public projection plus the full `rollResult` of every roll that is not
  `gm-only` or `blind`. Target defenses, DCs, mutations, payment, preview, configuration and trace stay
  on the authority.
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
  cross-browser privacy and this batch does not claim to. **4/4 live** on Foundry 14.369
  (2026-10-13).
- **Hardening rerun** (2026-10-13, Foundry 14.369, build `f41b077`, two isolated Chrome profiles driven by the agent (GM and Player1)): Quench 50/50; the three Level-5 sentinels passed again; the Action
  Hit/Miss QA passed through the real `Item.use()` with each player `PENDING_REQUEST` payload reduced
  to `{rollRequest}` and no `"defense":`/`"defenses":`/`"dc":` anywhere in it; a player acting
  through an Actor they do not own was refused with `WRONG_USER` and nothing changed.
- **Level 5** (`docs/development/staged-movement-qa.md`, evidence schema 2): the three sentinels
  record which message types crossed the bus, the targeted envelopes with sender/recipient, and the
  captured envelopes with private payloads omitted. The reaction sentinels use the GM as mover and a
  player as reactor controller so the reaction prompt and answer really cross the targeted transport
  between two browsers. **All three pairs passed** on 2026-10-13 (Foundry 14.369, build `c1f0079`,
  two isolated Chrome profiles driven by the agent): no private message type crossed the bus, the
  reaction request and answer appear only as targeted envelopes, and the stored GM envelopes omit
  every private payload.

## Open questions and limits

- Rolls default to `visibility: "system"`; only explicit `public` rolls appear in the broadcast
  projection. Mapping the system default to a table's roll-mode setting is deferred to the
  chat-card milestone.
- Unrelated clients receive nothing about damage or healing amounts; a public chat card may later
  widen the allow-list deliberately, with tests.
- `sanitizeActionIntentPayload` strips known state keys but passes unknown client keys through; they
  are the initiator's own data and remain on the bus.
- Hidden-token movement, chat, fog, journals and permissions are outside this milestone.
