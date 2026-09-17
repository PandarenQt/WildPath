# Staged movement / nested attack QA

This gate exercises the new explicit movement-intent entry point. Its six semantic cases are
live-confirmed in Foundry V14.367 through the `wildpath.staged-movement` Quench batch (single
active-GM client, same proof assertions); this paired GM/player procedure remains the Level-5
sentinel for socket delivery, remote prompts, and timing.
The existing native movement/reaction runbook remains the regression gate for dragging and
checkpoint continuation. Do not substitute its completed-event evidence for this new timing.

Use Foundry V14.367 with the rebuilt WildPath files, an active GM, and one active non-GM player.
For a second player to control the reactor, pass that user's ID as the optional second setup
argument. Mover and reactor controllers must differ. With one GM and one player, the reactor
controller defaults to the GM, so the reaction choice prompt and the child attack roll are routed to
the GM client while the player submits the movement.

The reused Action QA setup enforces its own preconditions on both clients and stops setup if they
fail: Foundry build exactly 14.367, the test Scene is the **active** Scene and is viewed on both
clients, Token Vision disabled, no started Combat, and **no active modules at all** (disable Quench
and every other module, then reload both clients). Both browser consoles must be open (DevTools
`copy()` is used for export).

For the first five cases, use the empty active square-grid test Scene required by
[Action runtime QA](action-runtime-live-qa.md): 5 ft per field, a viewed level, Token Vision off,
no Tokens, walls, or Regions. Leave several empty fields around the center. Both clients must view
that Scene. The helper reuses the marked synthetic-Actor fixture and cleanup from Action QA.
It adds a persisted reaction Item, a scoped reaction provider, and JSON diagnostics. It does not
replace the coordinator, prompts, roll provider, or attack resolution.
The sixth case uses a separate empty hex-grid Scene with the same prerequisites.

## Setup

On GM:

```js
const mq = await import("/systems/wildpath/docs/development/staged-movement-qa.mjs");
const movementQA = await mq.setupGM("MOVER_PLAYER_ID");
// Optional: mq.setupGM("MOVER_PLAYER_ID", "REACTOR_PLAYER_ID")
```

On the mover's player client:

```js
const mq = await import("/systems/wildpath/docs/development/staged-movement-qa.mjs");
```

## Cases

Run these sequentially, exporting GM and player JSON before preparing the next case:

| Mode | Reactor response | Expected result |
| --- | --- | --- |
| `ordinary` | No prompt | Three transitions, movement 30 → 15, reaction unchanged |
| `decline` | Decline | Same movement; no child or reaction spend |
| `miss` | Accept | Real digital attack misses; HP unchanged; one reaction spent; movement completes |
| `hit` | Accept | Real digital attack hits for 6; one reaction spent; movement completes |
| `stop` | Accept | Hit plus marked effect; only first transition commits; movement 30 → 25 |

The persisted QA Item disables natural automatic hit/miss policy and preparation sets AC to 100
or 1. Rolls still use the real digital provider and the Actor-derived +4 attack modifier. The stop
case's marked Prone effect is interpreted by this QA provider as a movement restriction; it does
not introduce that restriction into the movement engine's rules.

For each mode, GM prepares:

```js
await movementQA.prepare("ordinary"); // then decline, miss, hit, stop
```

After the player receives the prepared position/resources, the player submits once:

```js
await mq.submitPlayer();
```

The intended three-step route has one completed logical transition before it leaves the reactor's
configured reach. While a reaction is pending, the Token remains rendered at the route origin;
the attack's mechanical target is the last completed logical footprint. **Before answering any
reaction choice**, run on GM and retain the output:

```js
console.log(JSON.stringify(movementQA.provePending(), null, 2));
```

This must prove cursor `1`, proposed transition index `1`, an `interrupt`
`movement.transition-proposed` event, and one offered candidate in a `before-transition` window.
The observer must be within reach before the proposal and outside afterward (`1 -> 2` fields,
reach `1`, `leavesReach: true`). The event's previous footprint must equal the cursor's logical
footprint, which must differ from both the proposed footprint and the unchanged rendered origin.
The final proof requires this captured pending proof; answering first invalidates the case.
Then answer on the reactor's controller client. Do not drag either Token while the case is pending.

After completion, GM:

```js
console.log(JSON.stringify(movementQA.prove(), null, 2));
```

Player:

```js
console.log(JSON.stringify(mq.dumpPlayer(), null, 2));
```

Save each output separately with its role and mode. Export with `copy(JSON.stringify(...))` from
DevTools rather than reading the console log. Use these file names so the pairs cannot be confused
with the existing Action-runtime evidence (`evidence/gm-hit.json`, `gm-miss.json`):

| Mode | GM file | Player file |
| --- | --- | --- |
| `ordinary` | `evidence/gm-movement-ordinary.json` | `evidence/player-movement-ordinary.json` |
| `decline` | `evidence/gm-movement-decline.json` | `evidence/player-movement-decline.json` |
| `miss` | `evidence/gm-movement-miss.json` | `evidence/player-movement-miss.json` |
| `hit` | `evidence/gm-movement-hit.json` | `evidence/player-movement-hit.json` |
| `stop` | `evidence/gm-movement-stop.json` | `evidence/player-movement-stop.json` |

The dumps do not record the Foundry build or the tested commit. Record `game.release.build` and the
exact `git rev-parse HEAD` of the served build once per run alongside the files (for example in the
commit message that adds them). Pair GM and player files by `runId` and `resolutionId`.
Verify the player received the GM's completed result and sees the same final HP, reaction,
movement, and position. GM proof checks routing, request count, actual digital-roll provenance,
resource changes, continuation, and final position. For `miss`, `hit`, and `stop`, the proof also
requires captured reaction children and compares each child's entire `targetFootprints` field set,
topology, and anchor against the last-completed logical footprint. It rejects the rendered origin,
the proposed next footprint, wrong target identity, or missing evidence. Field order is immaterial.
A read-only `preUpdateActor` hook captures children at their normal commit, including fast
GM-controlled digital rolls. Observation errors fail the QA proof without affecting document updates.
The timer retains additional history. `footprintProof` exports the pending snapshot, child snapshots,
full route footprints, and final persisted footprint; transport envelopes preserve choice/roll identity
and sender. Comparisons run before diagnostic bounding.

If proof fails, export `movementQA.dump()` and `mq.dumpPlayer()` before changing the fixture.
Do not repeatedly submit a case or prepare the next case to hide a failure. A new case requires
the preceding proof to pass. If startup fails before the staged helper is returned, the inherited
Action QA setup marker retains the exact run ID for its existing cleanup procedure.

## Large hex decline variant

After exporting and cleaning up the five square cases, activate an empty **hex-grid** Scene
on both clients: 5 ft per field, viewed level, Token Vision off, no Tokens, walls, or Regions,
and several clear fields around the center. Use the same controller IDs. On GM:

```js
const hexMovementQA = await mq.setupGM("MOVER_PLAYER_ID", game.user.id, {variant:"large-hex-decline"});
// Substitute REACTOR_PLAYER_ID for game.user.id if another player controls the reactor.
await hexMovementQA.prepare("decline");
```

Setup creates a marked synthetic Large mover with a native `2 x 2`, `ELLIPSE_1` hex shape.
The tactical adapter must confirm **exactly three occupied hex fields** at each placement;
occupancy diagnostics fail setup. A fixed axial route and a one-field observer yield full-footprint
distances `1, 1, 2, 3` at origin and the three successive placements. No runtime pathfinding or
movement semantics change is involved. This variant accepts only `decline`.

On the mover's player client, submit the prepared route:

```js
await mq.submitPlayer();
```

With the reactor's choice dialog still open, GM:

```js
console.log(JSON.stringify(hexMovementQA.provePending(), null, 2));
```

This checks hex topology and the full three-field Large footprint at origin, last-completed
placement, and proposed placement, together with the pre-transition discovery and `leavesReach`
checks above. Select **Decline** on the reactor controller. After completion, export:

```js
// GM
console.log(JSON.stringify(hexMovementQA.prove(), null, 2));
```

```js
// Mover's player client
console.log(JSON.stringify(mq.dumpPlayer(), null, 2));
```

Require one declined candidate in the same closed window, one choice request, no child or roll,
all three transitions completed, movement `30 -> 15`, reaction still `1`, HP still `30`, and
the Token at the third prepared waypoint. Its persisted full footprint must match the final
logical footprint. Save as `evidence/gm-large-hex-decline.json` and `evidence/player-large-hex-decline.json`, retaining
`variant`, `runId`, and `resolutionId`, and check the player's terminal result and values as above.
If proof fails, retain `hexMovementQA.dump()` and the player dump before cleanup.

This sixth case is live-confirmed through the Quench batch; its paired-client run has not been captured. Node tests exercise these exact
assertions through the coordinator, including malformed evidence; they do not count as live proof.

## Cleanup

After exporting evidence and completing any pending resolution, GM:

```js
await movementQA.cleanup();
// For the hex fixture instead: await hexMovementQA.cleanup();
```

This detaches diagnostics, restores the prior reaction provider, and deletes only fixture
Documents marked by that run. A pending resolution blocks cleanup so it cannot later commit
against deleted Documents. Failed runs should retain their dumps before cleanup/reload.
