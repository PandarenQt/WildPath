# Foundry V14 Movement Interruption QA

The completed semantic observer on `f47ef23034be2291d4ee25820041fb99891257da` is already live-proven.
This procedure verifies the new checkpoint, pause, stop, continuation, and incremental accounting
integration. Automated fixtures and official V14.367 source inspection do not substitute for these
live checks. No new interruption live result is claimed yet.

Use a test Scene with open space, a 5-ft square or hex grid, distance measurement, and a player-owned
Token. Start with Large hex, then repeat on Large square and Medium square/hex. Keep the active GM
and initiating player connected. Reload both clients to load the same build. The methods below are
public V14 APIs; the test listener asks Foundry to pause/stop after a checkpoint has actually moved.
It does not add a reaction or simulate progress by manually firing hooks.

## 1. Observe on both clients

Paste this on the GM and player, once each:

```js
globalThis.wpMovementEvents = [];
globalThis.wpMovementEventHook = Hooks.on("wildpath.automationEvent", event => {
  if (!event.type.startsWith("movement.")) return;
  wpMovementEvents.push(structuredClone(event));
  console.log(event.type, event.data, event.metadata);
});
```

On the GM, select the test Token and reset only its movement budget before each run:

```js
await canvas.tokens.controlled[0].document.actor.update({"system.resources.movement.value": 30});
wpMovementEvents.length = 0;
```

For an unlinked Token, this updates its synthetic Actor. Record the corresponding world Actor's
movement value separately and confirm it remains unchanged after the test.

## 2. Stop after two of three transitions

On the **initiating player**, select that Token and paste this block. It builds three adjacent
placement steps using the Scene grid, with the first checkpoint after the second step. Inspect the
open space to the right before running. Use `mode: "stop"` for this run.

```js
{
  const d = canvas.tokens.controlled[0].document;
  const grid = canvas.grid;
  const origin = d.toObject(true);
  let offset = grid.getOffset(origin);
  const center = grid.getCenterPoint(offset);
  const route = [];
  for (let step = 0; step < 3; step++) {
    offset = [...grid.getAdjacentOffsets(offset)].sort((a, b) => {
      const pa = grid.getCenterPoint(a), pb = grid.getCenterPoint(b);
      return pb.x - pa.x || Math.abs(pa.y - center.y) - Math.abs(pb.y - center.y);
    })[0];
    const next = grid.getCenterPoint(offset);
    route.push({x: Math.round(origin.x + next.x - center.x),
      y: Math.round(origin.y + next.y - center.y), checkpoint: step >= 1});
  }
  globalThis.wpMovementQA = {d, route, id: foundry.utils.randomID(), mode: "stop", resume: null};
  wpMovementQA.hook = Hooks.on("moveToken", (doc, movement, operation, user) => {
    if (doc.uuid !== d.uuid || movement.id !== wpMovementQA.id || user.id !== game.user.id) return;
    if (!movement.pending.waypoints.length) return;
    Hooks.off("moveToken", wpMovementQA.hook);
    if (wpMovementQA.mode === "stop") console.log("stop accepted", doc.stopMovement());
    else wpMovementQA.resume = doc.pauseMovement();
  });
  console.log("QA root", wpMovementQA.id, d.uuid, route);
  wpMovementQA.finished = d.move(route, {id: wpMovementQA.id});
  wpMovementQA.finished.then(result => console.log("whole movement completed", result));
}
```

Expected: the Token stops at the second waypoint, movement becomes **20**, `stop accepted` is true,
and `whole movement completed` is false. On the GM there is one started event, transitions 0 and 1,
and one interrupted event. There is no transition 2 or completed event. The player has no
authoritative movement events. Large hex transition footprints each contain three fields, with
two left/two entered/one retained and step cost 5. Large square footprints contain four fields.

On the GM select the same Token and inspect the plain accounting snapshot:

```js
{
  const d = canvas.tokens.controlled[0].document;
  const root = d.movement.chain[0] ?? d.movement.id;
  console.log(game.wildpath.movement.getMovementProgress({
    movementId: root, sceneRef: d.parent.uuid, tokenRef: d.uuid
  }));
  console.table(wpMovementEvents.map(e => ({id: e.id, type: e.type,
    index: e.data.transitionIndex, cost: e.data.cumulativeCost ?? e.data.completedCost})));
}
```

Expected snapshot: `status: "interrupted"`, approved 3, completed/paid 2, remaining 1,
`cumulativeMovementCost: 10`, `committedMovementCost: 10`, `paymentFailure: null`, and the actual
full footprint at the second waypoint. Repeat `wpMovementQA.d.stopMovement()` on the player:
the event count and movement budget must remain unchanged.

## 3. Pause and continue

Reset movement to 30 on the GM, clear both event arrays, and rerun the player block with
`mode: "pause"`. Do not await `wpMovementQA.finished` while paused.

At pause: movement is **20**, completed/paid prefix is 2, remaining is 1, status is `paused`, and
only started plus transitions 0/1 exist. There is no interrupted/completed event. The player's
`wpMovementQA.resume` must be a function. Resume on that same initiating player:

```js
await wpMovementQA.resume();
await wpMovementQA.finished;
```

Expected: movement becomes **15**, the original root snapshot becomes `completed` with completed/paid
3, remaining 0, committed cost 15, and two operation IDs. The continuation's `d.movement.chain`
contains the first ID and retains the same `subpathId`. Exactly one new transition (index 2) and one
completed event are added. Existing started/transition IDs are unchanged and never repeated.

## 4. Pause then stop, multiplayer, and later movement

Repeat the pause run, then call `wpMovementQA.d.stopMovement()` instead of the resume callback.
Expected: movement stays **20**, one interrupted event is added, and the suffix is never traversed.
A stopped movement cannot continue. Initiate a fresh ordinary one-step move from the current position:
it should receive a new root and spend 5, leaving **15**, without modifying the stopped record.

Repeat stop and pause/continue as a player with the active GM observing. Verify one GM event sequence
and no player sequence. Repeat on an unlinked Token and confirm only its synthetic Actor pays.
Also repeat ordinary full movement and pure Token resize: full movement still completes once;
resize spends zero and emits no locomotion events. Forced/teleport semantics have automated
regressions; this procedure deliberately does not introduce a new UI or console-only movement-kind
protocol for them.

## 5. Cleanup and report

On the player, stop any still-paused test movement before removing the listener:

```js
wpMovementQA.d.stopMovement();
Hooks.off("moveToken", wpMovementQA.hook);
delete globalThis.wpMovementQA;
```

On both clients:

```js
Hooks.off("wildpath.automationEvent", wpMovementEventHook);
delete globalThis.wpMovementEventHook;
delete globalThis.wpMovementEvents;
```

Record Foundry build, topology/size, linked/unlinked Actor, stop and pause/continue budgets, event
types/IDs, and the plain progress snapshot. Any missing chain/state/source evidence should produce
a structured failure rather than guessed progress. Reload/handoff recovery and durable accounting
are not implemented; do not use those operations as a way to resume a test route.
