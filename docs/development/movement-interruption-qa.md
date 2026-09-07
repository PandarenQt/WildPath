# Foundry V14 Movement Interruption QA

Completed movement and terminal interruption are live-proven on Large hex Tokens. Stop after two
of three transitions produced movement `30 -> 20`, three-field footprints, exactly four GM events
(started, transitions 0/1, interrupted), no player events, and no duplicate payment/event on repeated
stop. Preserve those accepted results.

The reported pause defect occurs **before resume on the initiating player**: GM state is correctly
paused at 2/3, movement 20, and three events, but the player receives
`Observed source footprint differs from the completed prefix.` Resume then succeeds with movement
15 and exactly five GM events. The later diagnostic run on `a4c645e` did not reproduce the warning:
root `HdXYUBySCsLtscQu` advanced from pending to moving prefix 2, then paused at the same source
footprint; continuation `Ay7wACO07hmGcWsf` completed prefix 3 and movement 15. Its zero event count
was an observer-filter error: normalized Token refs cannot be compared to raw Foundry UUIDs.

The repair addresses a deterministic historical-observation defect: validation compared an older
prefix to a newer source footprint before classifying it as stale. Identity and ordered route are
still validated first; only a strictly lower count bypasses that spatial comparison. Same/new-prefix
footprint checks and structured mismatch diagnostics remain strict. This does not prove which
observation caused the original warning.

The maintainer confirmed final live QA passed on `26e7161797059ff7ff5a7cf4419a3427adf9d1ce` with
the corrected event filter: paused movement 20, three unique GM events and prefix 2/3; resumed
movement 15, five unique GM events and completed prefix 3/3; one root/subpath with stable prefix
event IDs; zero player events; no warning on either client; and all final assertions passed.
See the [exact accepted live result](movement-pause-diagnostic-qa.md). Movement semantics is live-green;
reaction composition remains a separate, unimplemented milestone.

## Verified public API: V14.365 docs and installed V14.367

The inspected V14.367 implementation agrees with the public
[pause/resume signatures](https://foundryvtt.com/api/v14/classes/foundry.documents.TokenDocument.html#pauseMovement):

- `pauseMovement()` returns an asynchronous resume **callback**, or `null` if it cannot pause.
- `pauseMovement(key)` returns a **Promise<boolean>**, or `null`; it is not a callback. Register a
  key only once per operation.
- `resumeMovement(movementId, key)` returns `undefined` (`void`). Read success from the saved
  keyed pause Promise, which resolves `true` when the continuation succeeds.
- Only the movement initiator may pause/stop; an owner may resume using the correct ID and key.
  Resume requires all registered pause handles to be released.
- `pauseToken` fires synchronously when current movement becomes paused, including the GM's mirrored
  pause update. `moveToken` receives an operation's passed/pending sections during post-update
  processing. Continuation uses a new operation ID and the prior chain.
- `TokenDocument.move()` returns the whole-route Promise: pending while paused, `true` after full
  completion, `false` when stopped. For pause-then-stop, await this whole-route Promise; do not await
  the unreleased keyed pause Promise. V14.367 does not directly settle that keyed Promise on stop.

The callback overload exists but is not used below. No private API, polling, or artificial delay is
used. The helpers are temporary console diagnostics and are removed by cleanup.

## 1. Observer and helper setup — GM and Player

Use a test Scene with open space to the right, a 5-ft square/hex grid, and WildPath distance
measurement. Select exactly one player-owned Token on **both** clients, preferably the same unlinked
Large hex QA Token. Reload both clients with the repaired build before installing these helpers.
Run this complete setup block on each client. Later blocks call these helpers without changing an
earlier paste.

```js
{
  if (canvas.tokens.controlled.length !== 1) throw new Error("Select exactly one QA Token.");
  const {normalizeEntityRef, sameEntityRef} = await import("/systems/wildpath/module/helpers/entity-refs.mjs");
  globalThis.wpMovementQA?.cleanup?.();
  if (globalThis.wpMovementEventHook != null) {
    Hooks.off("wildpath.automationEvent", globalThis.wpMovementEventHook);
    delete globalThis.wpMovementEventHook;
  }
  const qa = globalThis.wpMovementQA = {
    d: canvas.tokens.controlled[0].document, events: [], hook: null, run: null
  };
  qa.tokenRef = normalizeEntityRef({tokenId: qa.d.id, sceneId: qa.d.parent.id});
  qa.observer = Hooks.on("wildpath.automationEvent", event => {
    if (event.type.startsWith("movement.") && sameEntityRef(event.data.tokenRef, qa.tokenRef)) {
      qa.events.push(structuredClone(event));
      console.log(event.type, event.data, event.metadata);
    }
  });
  qa.inspect = () => {
    const movement = qa.d.movement, rootId = movement.chain[0] ?? movement.id;
    const events = qa.events.filter(event => event.data.movementId === rootId);
    const progress = game.wildpath.movement.getMovementProgress({
      movementId: rootId, sceneRef: qa.d.parent.uuid, tokenRef: qa.d.uuid
    });
    const result = {
      client: game.user.name, rootId, operationId: movement.id,
      chain: [...movement.chain], subpathId: movement.subpathId,
      movement: qa.d.actor.system.resources.movement.value, state: movement.state,
      eventCount: events.length, uniqueEventIds: new Set(events.map(e => e.id)).size,
      types: events.map(e => e.type), eventIds: events.map(e => e.id),
      transitions: events.filter(e => e.type === "movement.transition").map(e => ({
        index: e.data.transitionIndex, cost: e.data.stepCost.amount,
        fromFields: e.data.from.footprint.fields.length, toFields: e.data.to.footprint.fields.length,
        left: e.data.leftFields.length, entered: e.data.enteredFields.length,
        retained: e.data.retainedFields.length
      })), progress, baseWorldMovement: qa.d.baseActor?.system.resources.movement.value
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  };
  qa.reset = async () => {
    if (game.user.id !== game.users.activeGM?.id) throw new Error("Reset on the active GM.");
    if (["paused", "pending"].includes(qa.d.movement.state)) throw new Error("Finish/stop the previous run first.");
    await qa.d.actor.update({"system.resources.movement.value": 30});
    qa.events.length = 0;
    console.log({movement: qa.d.actor.system.resources.movement.value,
      baseWorldMovement: qa.d.baseActor?.system.resources.movement.value});
  };
  qa.start = mode => {
    if (!["pause", "stop"].includes(mode)) throw new Error("Unsupported QA phase.");
    if (["paused", "pending"].includes(qa.d.movement.state)) throw new Error("Finish/stop the previous run first.");
    if (qa.hook != null) Hooks.off("moveToken", qa.hook);
    qa.events.length = 0;
    const grid = canvas.grid, origin = qa.d.toObject(true);
    let offset = grid.getOffset(origin);
    const center = grid.getCenterPoint(offset), route = [];
    for (let step = 0; step < 3; step++) {
      offset = [...grid.getAdjacentOffsets(offset)].sort((a, b) => {
        const pa = grid.getCenterPoint(a), pb = grid.getCenterPoint(b);
        return pb.x - pa.x || Math.abs(pa.y - center.y) - Math.abs(pb.y - center.y);
      })[0];
      const next = grid.getCenterPoint(offset);
      route.push({x: Math.round(origin.x + next.x - center.x),
        y: Math.round(origin.y + next.y - center.y), checkpoint: step >= 1});
    }
    const run = qa.run = {id: foundry.utils.randomID(), route,
      pauseKey: `wildpath-qa-${foundry.utils.randomID()}`, pausePromise: null, pausedId: null};
    qa.hook = Hooks.on("moveToken", (doc, movement, operation, user) => {
      if (doc.uuid !== qa.d.uuid || movement.id !== run.id || user.id !== game.user.id) return;
      if (!movement.pending.waypoints.length) return;
      Hooks.off("moveToken", qa.hook);
      qa.hook = null;
      if (mode === "stop") console.log({stopAccepted: doc.stopMovement()});
      else {
        run.pausedId = movement.id;
        run.pausePromise = doc.pauseMovement(run.pauseKey);
        if (run.pausePromise === null) throw new Error("Foundry refused the keyed pause.");
        console.log({pausedId: run.pausedId, pauseKey: run.pauseKey,
          returnedPromise: typeof run.pausePromise.then === "function"});
      }
    });
    run.finished = qa.d.move(route, {id: run.id});
    run.finished.then(completed => console.log({wholeMovementCompleted: completed}));
    console.log({started: true, mode, movementId: run.id, pauseKey: run.pauseKey, route});
  };
  qa.cleanup = () => {
    if (qa.hook != null) Hooks.off("moveToken", qa.hook);
    Hooks.off("wildpath.automationEvent", qa.observer);
  };
  console.log({observerInstalled: true, token: qa.d.uuid, client: game.user.name});
}
```

## 2. Terminal stop — preserve the live-green result

On the **GM**, prepare movement 30 and record the base world Actor value:

```js
await wpMovementQA.reset();
```

On the **Player**, start the stop test:

```js
wpMovementQA.start("stop");
```

Expected Player output: `stopAccepted: true`, then `wholeMovementCompleted: false`.
On the **GM**, inspect the stopped route:

```js
{
  const stopped = wpMovementQA.inspect();
  console.assert(stopped.movement === 20 && stopped.eventCount === 4);
  console.assert(stopped.progress.status === "interrupted");
  console.assert(stopped.progress.completedTransitionCount === 2 && stopped.progress.remainingTransitionCount === 1);
  console.assert(stopped.progress.committedMovementCost === 10 && stopped.progress.paidTransitionCount === 2);
}
```

Expected events: started, transition 0, transition 1, interrupted. On the **Player**, repeat stop:

```js
console.log({repeatedStopAccepted: wpMovementQA.d.stopMovement()});
console.assert(wpMovementQA.inspect().eventCount === 0);
```

Repeat the GM inspection block: budget and event counts must remain unchanged.

## 3. Keyed pause after two of three transitions

On the **GM**, prepare a new run:

```js
await wpMovementQA.reset();
```

On the **Player**, start the pause phase:

```js
wpMovementQA.start("pause");
```

Expected Player output: `returnedPromise: true`; movement stays paused and the whole-route Promise
remains pending. There must be no mismatch warning on either client.
On the **GM**, inspect before anyone resumes:

```js
{
  const paused = wpMovementQA.inspect();
  console.assert(paused.movement === 20 && paused.eventCount === 3);
  console.assert(paused.progress.status === "paused");
  console.assert(paused.progress.completedTransitionCount === 2 && paused.progress.remainingTransitionCount === 1);
  console.assert(paused.progress.committedMovementCost === 10 && paused.progress.paymentFailure === null);
  console.assert(!paused.types.includes("movement.interrupted") && !paused.types.includes("movement.completed"));
  wpMovementQA.pausedEventIds = paused.eventIds;
}
```

On the **Player**, inspect the same boundary:

```js
console.assert(wpMovementQA.inspect().eventCount === 0);
console.log({pausedId: wpMovementQA.run.pausedId, pauseKey: wpMovementQA.run.pauseKey,
  pauseIsPromise: typeof wpMovementQA.run.pausePromise?.then === "function"});
```

## 4. Resume — initiating Player only

```js
{
  const qa = wpMovementQA, run = qa.run;
  if (!run?.pausePromise || qa.d.movement.id !== run.pausedId || qa.d.movement.state !== "paused") {
    throw new Error("No matching keyed pause is ready to resume.");
  }
  const returned = qa.d.resumeMovement(run.pausedId, run.pauseKey);
  console.log({resumeReturned: returned}); // undefined, not a Promise or callback
  const resumed = await run.pausePromise;
  const completed = await run.finished;
  console.log({resumed, completed, playerEventCount: qa.inspect().eventCount});
}
```

Expected: `resumed: true`, `completed: true`, `playerEventCount: 0`. No warning.

## 5. Final inspection — active GM

```js
{
  const final = wpMovementQA.inspect();
  console.assert(final.movement === 15 && final.eventCount === 5 && final.uniqueEventIds === 5);
  console.assert(final.progress.status === "completed" && final.progress.completedTransitionCount === 3);
  console.assert(final.progress.committedMovementCost === 15 && final.progress.paidTransitionCount === 3);
  console.assert(final.progress.remainingTransitionCount === 0 && final.progress.paymentFailure === null);
  console.assert(JSON.stringify(final.types) === JSON.stringify([
    "movement.started", "movement.transition", "movement.transition", "movement.transition", "movement.completed"
  ]));
  console.assert(JSON.stringify(final.eventIds.slice(0, 3)) === JSON.stringify(wpMovementQA.pausedEventIds));
}
```

The root ID stays unchanged; the continuation has a new operation ID and the root in `chain`.
Indices are 0/1/2 with no replay. Payment is `10 - 0 = 10`, then `15 - 10 = 5`; duplicates owe zero.
For an unlinked Token the base world Actor value stays unchanged. Large hex transitions have
three-field footprints, two left/two entered/one retained, and cost 5.

## 6. Pause then stop

On the **GM**:

```js
await wpMovementQA.reset();
```

On the **Player**, start a fresh keyed pause:

```js
wpMovementQA.start("pause");
```

Once the GM confirms paused movement 20 with three events, run this entire **Player** block:

```js
{
  const qa = wpMovementQA;
  if (qa.d.movement.state !== "paused") throw new Error("Wait for the keyed pause boundary.");
  console.log({stopAccepted: qa.d.stopMovement()});
  console.log({wholeMovementCompleted: await qa.run.finished});
  console.assert(qa.inspect().eventCount === 0);
}
```

On the **GM**:

```js
{
  const interrupted = wpMovementQA.inspect();
  console.assert(interrupted.movement === 20 && interrupted.eventCount === 4);
  console.assert(interrupted.progress.status === "interrupted");
  console.assert(interrupted.progress.committedMovementCost === 10);
  console.assert(interrupted.types.at(-1) === "movement.interrupted");
  console.assert(!interrupted.types.includes("movement.completed"));
}
```

## 7. Cleanup — each client

```js
{
  const qa = globalThis.wpMovementQA;
  if (qa && ["paused", "pending"].includes(qa.d.movement.state) && qa.d.movement.user.id === game.user.id) {
    qa.d.stopMovement();
  }
  qa?.cleanup();
  globalThis.wpPauseTraceCleanup?.();
  delete globalThis.wpMovementQA;
}
```

Record Foundry build, topology/size, linked/unlinked Actor, both clients' warnings, and the GM
paused/final snapshots. Repeat with Large square and Medium square/hex when extending regression QA.
The final Large hex pause/continuation acceptance run is recorded above.

## One-run final validation and optional diagnostics

Use the [complete one-run GM and Player capture blocks](movement-pause-diagnostic-qa.md) for the
final warning-free pause/resume validation. They use canonical `token:<sceneId>.<tokenId>` refs,
retain optional diagnostic context if the warning recurs, and assert the three/five-event root
history. Do not treat the old diagnostic listener's zero count as evidence that events were absent.
