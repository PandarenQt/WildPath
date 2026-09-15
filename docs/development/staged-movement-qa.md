# Staged movement / nested attack QA

This gate exercises the new explicit movement-intent entry point. It has not yet been run live.
The existing native movement/reaction runbook remains the regression gate for dragging and
checkpoint continuation. Do not substitute its completed-event evidence for this new timing.

Use Foundry V14.367 with the rebuilt WildPath files, an active GM, and one active non-GM player.
For a second player to control the reactor, pass that user's ID as the optional second setup
argument. Mover and reactor controllers must differ.

Use the empty active square-grid test Scene required by
[Action runtime QA](action-runtime-live-qa.md): 5 ft per field, a viewed level, Token Vision off,
no Tokens, walls, or Regions. Leave several empty fields around the center. Both clients must view
that Scene. The helper reuses the marked synthetic-Actor fixture and cleanup from Action QA.
It adds a persisted reaction Item, a scoped reaction provider, and JSON diagnostics. It does not
replace the coordinator, prompts, roll provider, or attack resolution.

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
the attack's mechanical target is the last completed logical footprint. Answer on the reactor's
controller client. Do not drag either Token while the case is pending.

After completion, GM:

```js
console.log(JSON.stringify(movementQA.prove(), null, 2));
```

Player:

```js
console.log(JSON.stringify(mq.dumpPlayer(), null, 2));
```

Save each output separately with its role and mode. Pair them by `runId` and `resolutionId`.
Verify the player received the GM's completed result and sees the same final HP, reaction,
movement, and position. GM proof checks routing, request count, actual digital-roll provenance,
resource changes, continuation, and final position. Retained history includes child identity and
logical target footprints; transport envelopes preserve choice/roll identity and sender.

If proof fails, export `movementQA.dump()` and `mq.dumpPlayer()` before changing the fixture.
Do not repeatedly submit a case or prepare the next case to hide a failure. A new case requires
the preceding proof to pass. If startup fails before the staged helper is returned, the inherited
Action QA setup marker retains the exact run ID for its existing cleanup procedure.

## Cleanup

After exporting evidence and completing any pending resolution, GM:

```js
await movementQA.cleanup();
```

This detaches diagnostics, restores the prior reaction provider, and deletes only fixture
Documents marked by that run. A pending resolution blocks cleanup so it cannot later commit
against deleted Documents. Failed runs should retain their dumps before cleanup/reload.
