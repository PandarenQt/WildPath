# Staged movement live QA: Level-5 multiplayer sentinel

The six semantic staged-movement cases (`ordinary`, `decline`, `miss`, `hit`, `stop`, Large-hex
`decline`) are **live-confirmed 6/6 in Foundry V14.367** by the `wildpath.staged-movement` Quench
batch, which runs the proof assertions in `staged-movement-qa-proof.mjs` on a single active-GM
client. Quench owns that regression coverage. This runbook is the remaining **Level-5 sentinel**:
three paired GM/player cases in two real browser sessions proving real intent transport, active-GM
authority, **targeted (recipient-restricted) delivery of private requests, answers and results**,
and `RESOLUTION_RESULT` delivery on square and hex topology.

| Sentinel | Mode | Variant | Mover | Reactor controller | GM file | Player file |
| --- | --- | --- | --- | --- | --- | --- |
| 1 — ordinary square/Medium | `ordinary` | `square` | player | (none offered) | `evidence/gm-movement-ordinary.json` | `evidence/player-movement-ordinary.json` |
| 2 — square/Medium reaction decline | `decline` | `square` | **GM** | **player** | `evidence/gm-movement-decline.json` | `evidence/player-movement-decline.json` |
| 3 — Large-hex reaction decline | `decline` | `large-hex-decline` | **GM** | **player** | `evidence/gm-large-hex-decline.json` | `evidence/player-large-hex-decline.json` |

Why the roles differ: with one GM and one player, a reaction prompt only crosses the network when
the reactor is controlled by the *other* client. Sentinel 1 proves the player-initiated path (the
`ACTION_INTENT` crosses the bus, the participant result comes back on the targeted transport).
Sentinels 2 and 3 have the GM move and the player answer, so the reaction-choice `PENDING_REQUEST`
and the `REQUEST_RESPONSE` really travel between two browsers on `User#query`, and the evidence can
show that neither ever appeared on `system.wildpath`. The evidence builder refuses any other role
assignment for these cases.

`miss`, `hit`, and `stop` are **not** part of the canonical Level-5 set. Their mechanics are Quench-
confirmed; the helper still supports them for diagnosis, but its canonical export refuses to label
them as sentinel evidence. The console transcripts committed earlier under `evidence/*-movement-
{hit,miss,stop}.json` are historical, supplementary evidence, not closure evidence.

The native movement/reaction runbook ([movement-reaction-qa.md](movement-reaction-qa.md)) remains
the regression gate for dragging and checkpoint continuation; do not substitute it for this timing.

## Preconditions (both clients)

Two browser sessions: the **active GM** and **one active non-GM player**. The player must hold the
`QUERY_USER` permission (Foundry's default for the Player role); without it the player cannot send
targeted answers and the runtime logs a warning at `ready`.

The reused Action QA setup stops if any of these fail: Foundry build exactly **14.367**; the test
Scene is the **active** Scene, viewed on both clients; Token Vision off; no started Combat;
**no active modules at all** (disable Quench and every other module, then reload both clients);
the normal registered WildPath runtime. Keep both DevTools consoles open (`copy()` is used for
export). Use an empty test Scene with 5 ft per field, a viewed level, and no Tokens, walls, or
Regions, with several clear fields around the center. Sentinels 1–2 use a **square** Scene;
sentinel 3 uses a separate empty **hex** Scene activated on both clients after the square cleanup.

Before starting, record the exact served commit: `git rev-parse HEAD` in the repository that is
serving `/systems/wildpath`. Every export requires it; if the branch moves between sentinels, pass
the new SHA.

## Export contract (schema 2)

Exports are produced only by the helper, never by copying console transcripts. Each is a plain
JSON object:

```text
schemaVersion 2 · evidenceType "staged-movement-level5" · role gm|player
case ordinary|decline|large-hex-decline · mode · variant
foundryVersion (game.version) · foundry {generation, build} · systemId · systemVersion
gitSha (exact, required) · capturedAt (ISO-8601, export time) · runId · resolutionId
evidenceFile (the canonical path above) · evidence (the bounded dump, see below)
```

`evidence` carries the movement proof as before plus the confidentiality evidence:

- `authorityUserId` (GM export) and `result.authorityUserId` (player export);
- `transport.broadcastMessageTypes`: every message type that crossed `system.wildpath` for this
  resolution; the builder refuses any private type (`PENDING_REQUEST`, `REQUEST_RESPONSE`,
  `RESOLUTION_ERROR`, movement approval/result/continuation) and requires `RESOLUTION_RESULT`;
- `transport.targeted` / `transport.local`: direction, type, sender, recipient, classification and
  ids of every envelope that travelled by `User#query` or was delivered locally, never their payload;
- `envelopes` (GM export): captured envelopes with private payloads replaced by
  `{omitted: true, keys: [...]}`.

Per case the builder additionally requires: sentinel 1 — the participant `RESOLUTION_RESULT`
projection sent to (GM) / received by (player) the mover on the targeted transport, and the player's
stored result classified `PARTICIPANT_PRIVATE`; sentinels 2–3 — the reaction-choice
`PENDING_REQUEST` sent to (GM) / received by (player) the reactor controller and the
`REQUEST_RESPONSE` back, both targeted, with the GM's own `ACTION_INTENT` delivered locally.

The helper refuses to export when the case is not one of the three sentinels, when the GM proof has
not passed, when the resolution is not completed, when the player has not received a completed
terminal result for the same `resolutionId`, when the SHA is missing, when any private message type
crossed the bus, when the required targeted envelopes are absent, or when anything non-JSON would be
serialized. A refusal means the case is not ready — do not work around it.

## Setup

Both clients import the helper first; importing attaches the transport observer that the evidence
needs, so do this **before** any intent is submitted:

```js
const mq = await import("/systems/wildpath/docs/development/staged-movement-qa.mjs");
```

GM, sentinel 1 (player mover):

```js
const movementQA = await mq.setupGM("MOVER_PLAYER_ID");
```

GM, sentinels 2–3 (GM mover, player reactor controller):

```js
const movementQA = await mq.setupGM(game.user.id, "REACTOR_PLAYER_ID");
```

## Sentinel 1 — ordinary square/Medium

GM prepares, player submits, GM proves, both export:

```js
// GM
await movementQA.prepare("ordinary");
```

```js
// Player, after the prepared position and resources have replicated
await mq.submitMover();
```

```js
// GM, after the Token has moved
movementQA.prove();
copy(movementQA.exportEvidence({gitSha:"EXACT_SHA"}).json);   // → evidence/gm-movement-ordinary.json
```

```js
// Player — required
copy(mq.exportPlayerEvidence({gitSha:"EXACT_SHA"}).json);     // → evidence/player-movement-ordinary.json
```

Expected: no prompt anywhere; 3/3 transitions; movement 30 → 15; HP 30 unchanged; reaction 1
unchanged; parent `completed`; player `result.status === "completed"` with
`result.disclosure === "PARTICIPANT_PRIVATE"` for the same `resolutionId`; the bus carried only
`ACTION_INTENT` and the public `RESOLUTION_RESULT` projection. No reaction source is configured for
this mode, so the absence of a window is the expected result.

After exporting both files:

```js
// GM
await movementQA.cleanup();
```

## Sentinel 2 — square/Medium reaction decline

Re-run the GM setup with the GM as mover (`mq.setupGM(game.user.id, "REACTOR_PLAYER_ID")`), then:

```js
// GM
await movementQA.prepare("decline");
await mq.submitMover();
```

The reaction dialog opens on the **player** client while the mover Token is still rendered at
origin. **Before answering**, GM captures the pending proof:

```js
// GM — with the player's dialog still open
movementQA.provePending();
```

It must show cursor `1`, transition index `1`, an `interrupt` `movement.transition-proposed` event,
one offered candidate in a `before-transition` window, `leavesReach: true` (`1 -> 2` fields, reach
`1`), and the logical footprint equal to the event's previous footprint and different from both the
proposed footprint and the rendered origin. Answering first invalidates the case. Then the player
selects **Decline**.

```js
// GM
movementQA.prove();
copy(movementQA.exportEvidence({gitSha:"EXACT_SHA"}).json);   // → evidence/gm-movement-decline.json
```

```js
// Player — required
copy(mq.exportPlayerEvidence({gitSha:"EXACT_SHA"}).json);     // → evidence/player-movement-decline.json
```

Expected: reaction offered at transition index 1; one declined candidate recorded in one closed
window; no child resolution; 3/3 transitions; movement 30 → 15; HP 30; reaction 1 (declining spends
nothing); one choice request routed to the player; the GM's `ACTION_INTENT` delivered locally; the
`PENDING_REQUEST` and `REQUEST_RESPONSE` recorded only under `transport.targeted`; the bus carried
only the public `RESOLUTION_RESULT` projection; the player's stored result classified
`BROADCAST_SAFE` (the player is the chooser, not the initiator).

After exporting both files:

```js
// GM
await movementQA.cleanup();
```

## Sentinel 3 — Large-hex reaction decline

Activate the empty hex Scene on both clients, then:

```js
// GM
const hexMovementQA = await mq.setupGM(game.user.id, "REACTOR_PLAYER_ID", {variant:"large-hex-decline"});
await hexMovementQA.prepare("decline");
await mq.submitMover();
```

Setup creates a marked synthetic **Large** mover (`2 x 2`, `ELLIPSE_1`) **at creation time** — a
later resize would itself be a V14 movement operation subject to WildPath approval — and verifies
exactly three occupied hex fields at origin and every waypoint, with full-footprint distances
`1, 1, 2, 3` from the observer; occupancy diagnostics fail setup. This variant accepts only `decline`.

```js
// GM — with the player's dialog still open
hexMovementQA.provePending();
```

The player selects **Decline**, then:

```js
// GM
hexMovementQA.prove();
copy(hexMovementQA.exportEvidence({gitSha:"EXACT_SHA"}).json); // → evidence/gm-large-hex-decline.json
```

```js
// Player — required
copy(mq.exportPlayerEvidence({gitSha:"EXACT_SHA"}).json);       // → evidence/player-large-hex-decline.json
```

Expected: hex topology and Large three-field footprints at origin, logical, proposed, and final
placements; reaction offered at the leave-reach transition; declined by the player over the targeted
transport; no child; 3/3 transitions; movement 30 → 15; HP 30; reaction 1; the final Token position
**commits** with the persisted footprint equal to the final logical footprint; the same transport
evidence as sentinel 2. This sentinel matters because the Quench run of this case exposed the
floating-point position-verification defect repaired in `e30d752`.

```js
// GM
await hexMovementQA.cleanup();
```

## Pairing and failure

Pair each GM and player file by `runId` and `resolutionId`; both must carry the same `gitSha` and a
`foundryVersion` of `14.367`. If a proof fails, retain `movementQA.dump()` (GM) and `mq.dumpPlayer()`
(player) as diagnostics — they are not canonical evidence — and do not resubmit or prepare the next
case to hide the failure. A pending resolution blocks cleanup so it cannot later commit against
deleted Documents; for a stuck case, export diagnostics, reload both clients, then clean up with the
run ID (`cleanupGM` from the Action QA helper).

## Closure

The staged movement milestone was closed on 2026-09-20 on schema-1 evidence. The **confidentiality
hardening milestone** reopens this sentinel: it stays **OPEN** until all six canonical files exist as
schema-2 exports from a build containing the disclosure transport, each pair passes the pairing
checks, and the files are committed. Rerun this sentinel whenever socket transport, authority,
request routing, prompt ownership, multiplayer orchestration, or disclosure behavior changes;
mechanical movement changes are covered by Node and the Quench six-case batch.
