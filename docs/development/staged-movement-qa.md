# Staged movement live QA: Level-5 multiplayer sentinel

The six semantic staged-movement cases (`ordinary`, `decline`, `miss`, `hit`, `stop`, Large-hex
`decline`) are **live-confirmed 6/6 in Foundry V14.367** by the `wildpath.staged-movement` Quench
batch, which runs the proof assertions in `staged-movement-qa-proof.mjs` on a single active-GM
client. Quench owns that regression coverage. This runbook is the remaining **Level-5 sentinel**:
three paired GM/player cases in two real browser sessions proving real `ACTION_INTENT` transport,
active-GM authority, remote request routing where applicable, and `RESOLUTION_RESULT` delivery on
square and hex topology.

| Sentinel | Mode | Variant | GM file | Player file |
| --- | --- | --- | --- | --- |
| 1 — ordinary square/Medium | `ordinary` | `square` | `evidence/gm-movement-ordinary.json` | `evidence/player-movement-ordinary.json` |
| 2 — square/Medium reaction decline | `decline` | `square` | `evidence/gm-movement-decline.json` | `evidence/player-movement-decline.json` |
| 3 — Large-hex reaction decline | `decline` | `large-hex-decline` | `evidence/gm-large-hex-decline.json` | `evidence/player-large-hex-decline.json` |

`miss`, `hit`, and `stop` are **not** part of the canonical Level-5 set. Their mechanics are Quench-
confirmed; the helper still supports them for diagnosis, but its canonical export refuses to label
them as sentinel evidence. The console transcripts committed earlier under `evidence/*-movement-
{hit,miss,stop}.json` are historical, supplementary evidence, not closure evidence.

The native movement/reaction runbook ([movement-reaction-qa.md](movement-reaction-qa.md)) remains
the regression gate for dragging and checkpoint continuation; do not substitute it for this timing.

## Preconditions (both clients)

Two browser sessions: the **active GM** and **one active non-GM player** (the mover). With one GM
and one player the reactor controller defaults to the GM, so the reaction prompt is answered on the
GM client while the player submits movement. To have a second player control the reactor, pass that
user's ID as the second `setupGM` argument; mover and reactor controllers must differ.

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

## Export contract

Exports are produced only by the helper, never by copying console transcripts. Each is a plain
JSON object:

```text
schemaVersion 1 · evidenceType "staged-movement-level5" · role gm|player
case ordinary|decline|large-hex-decline · mode · variant
foundryVersion (game.version) · foundry {generation, build} · systemId · systemVersion
gitSha (exact, required) · capturedAt (ISO-8601, export time) · runId · resolutionId
evidenceFile (the canonical path above) · evidence (the bounded prove()/dumpPlayer() object)
```

The helper refuses to export when the case is not one of the three sentinels, when the GM proof has
not passed, when the resolution is not completed, when the player has not received a completed
terminal result for the same `resolutionId`, when the SHA is missing, or when anything non-JSON
would be serialized. A refusal means the case is not ready — do not work around it.

## Setup

GM:

```js
const mq = await import("/systems/wildpath/docs/development/staged-movement-qa.mjs");
const movementQA = await mq.setupGM("MOVER_PLAYER_ID");
// Optional second controller: mq.setupGM("MOVER_PLAYER_ID", "REACTOR_PLAYER_ID")
```

Player:

```js
const mq = await import("/systems/wildpath/docs/development/staged-movement-qa.mjs");
```

## Sentinel 1 — ordinary square/Medium

GM prepares, player submits, GM proves, both export:

```js
// GM
await movementQA.prepare("ordinary");
```

```js
// Player, after the prepared position and resources have replicated
await mq.submitPlayer();
```

```js
// GM, after the Token has moved
movementQA.prove();
copy(movementQA.exportEvidence({gitSha:"EXACT_SHA"}).json);   // → evidence/gm-movement-ordinary.json
```

```js
// Player
copy(mq.exportPlayerEvidence({gitSha:"EXACT_SHA"}).json);     // → evidence/player-movement-ordinary.json
```

Expected: no prompt anywhere; 3/3 transitions; movement 30 → 15; HP 30 unchanged; reaction 1
unchanged; parent `completed`; player `result.status === "completed"` for the same `resolutionId`.
No reaction source is configured for this mode, so the absence of a window is the expected result.

## Sentinel 2 — square/Medium reaction decline

```js
// GM
await movementQA.prepare("decline");
```

```js
// Player
await mq.submitPlayer();
```

The reaction dialog opens on the reactor controller (the GM by default) while the mover Token is
still rendered at origin. **Before answering**, GM captures the pending proof:

```js
// GM — with the dialog still open
movementQA.provePending();
```

It must show cursor `1`, transition index `1`, an `interrupt` `movement.transition-proposed` event,
one offered candidate in a `before-transition` window, `leavesReach: true` (`1 -> 2` fields, reach
`1`), and the logical footprint equal to the event's previous footprint and different from both the
proposed footprint and the rendered origin. Answering first invalidates the case. Then select
**Decline** on the reactor controller.

```js
// GM
movementQA.prove();
copy(movementQA.exportEvidence({gitSha:"EXACT_SHA"}).json);   // → evidence/gm-movement-decline.json
```

```js
// Player
copy(mq.exportPlayerEvidence({gitSha:"EXACT_SHA"}).json);     // → evidence/player-movement-decline.json
```

Expected: reaction offered at transition index 1; one declined candidate recorded in one closed
window; no child resolution; 3/3 transitions; movement 30 → 15; HP 30; reaction 1 (declining spends
nothing); one choice request routed to the reactor controller.

After exporting both files:

```js
// GM
await movementQA.cleanup();
```

## Sentinel 3 — Large-hex reaction decline

Activate the empty hex Scene on both clients, then:

```js
// GM
const hexMovementQA = await mq.setupGM("MOVER_PLAYER_ID", game.user.id, {variant:"large-hex-decline"});
await hexMovementQA.prepare("decline");
```

Setup creates a marked synthetic **Large** mover (`2 x 2`, `ELLIPSE_1`) and verifies exactly three
occupied hex fields at origin and every waypoint, with full-footprint distances `1, 1, 2, 3` from
the observer; occupancy diagnostics fail setup. This variant accepts only `decline`.

```js
// Player
await mq.submitPlayer();
```

```js
// GM — with the dialog still open
hexMovementQA.provePending();
```

Select **Decline** on the reactor controller, then:

```js
// GM
hexMovementQA.prove();
copy(hexMovementQA.exportEvidence({gitSha:"EXACT_SHA"}).json); // → evidence/gm-large-hex-decline.json
```

```js
// Player
copy(mq.exportPlayerEvidence({gitSha:"EXACT_SHA"}).json);       // → evidence/player-large-hex-decline.json
```

Expected: hex topology and Large three-field footprints at origin, logical, proposed, and final
placements; reaction offered at the leave-reach transition; declined; no child; 3/3 transitions;
movement 30 → 15; HP 30; reaction 1; the final Token position **commits** with the persisted
footprint equal to the final logical footprint; player receives the completed terminal result.
This sentinel matters because the Quench run of this case exposed the floating-point position-
verification defect repaired in `e30d752`.

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

The staged-movement milestone may be marked closed only after all six canonical files above exist,
each pair passes the pairing checks, and the files are committed. Until then it stays open and
confidentiality hardening remains sequenced after it.
