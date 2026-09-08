# One-run pause/resume validation with diagnostic capture

The maintainer confirmed this final live procedure passed on
`26e7161797059ff7ff5a7cf4419a3427adf9d1ce` (`Fix stale movement observation reconciliation`).
The accepted result uses the corrected normalized Token-ref observer on the active GM and initiating
player, with a Large hex Token, 5-ft grid, and distance measurement.

| Observed result | Paused after two transitions | Completed after resume |
| --- | --- | --- |
| Token Actor movement (starting at 30) | 20 | 15 |
| Progress status | paused | completed |
| Approved / completed / remaining transitions | 3 / 2 / 1 | 3 / 3 / 0 |
| Paid transitions / committed cost | 2 / 10 ft | 3 / 15 ft |
| Active-GM events / unique event IDs | 3 / 3 | 5 / 5 |
| Transition indices | 0, 1 | 0, 1, 2 |
| Operation count | 1 | 2 |
| Payment failure | null | null |

The paused history is exactly `movement.started`, transition 0, and transition 1. Resume appends
only transition 2 and `movement.completed`; the root/subpath and first three event IDs are preserved.
There is no `movement.interrupted`, duplicate event, or duplicate prefix payment. The initiating
player has zero authoritative movement events. Neither client displays the prefix-mismatch warning,
and the final checks pass, including the unchanged base world Actor for the unlinked Token.

This closes the final live-QA gate for movement semantics. The original uncaptured warning's exact
lifecycle remains unknown; the deterministic stale-observation defect and the normal live sequence
are documented separately. The earlier diagnostic run's zero GM event count came from the old
raw-UUID filter and is superseded by this corrected observer result.

The blocks below remain the repeatable movement acceptance procedure. The subsequent reaction
composition milestone passed its Foundry V14.367 live gate on `ddb26f6`; see
[movement/reaction live QA](movement-reaction-qa.md).

## Rerun preparation

Finish the previous test and reload both clients with the repaired build.
Select the same player-owned Large hex Token on each client, with open space to its right.
Use a 5-ft grid and distance measurement. The GM setup resets only this Token Actor's movement to 30.

## 1. Active GM: install recorder and prepare movement

```js
{
  if (game.user.id !== game.users.activeGM?.id) throw new Error("Run on the active GM.");
  if (canvas.tokens.controlled.length !== 1) throw new Error("Select exactly one QA Token.");
  const {normalizeEntityRef, sameEntityRef} = await import("/systems/wildpath/module/helpers/entity-refs.mjs");
  const d = canvas.tokens.controlled[0].document;
  if (["pending", "paused"].includes(d.movement.state)) throw new Error("Finish the previous movement first.");
  globalThis.wpPauseQA?.cleanup?.();
  globalThis.wpPauseTraceCleanup?.();
  const a = game.wildpath.movement;
  const qa = globalThis.wpPauseQA = {d, traces: [], events: []};
  qa.tokenRef = normalizeEntityRef({tokenId: d.id, sceneId: d.parent.id});
  qa.baseWorldBefore = d.baseActor?.system.resources.movement.value;
  await d.actor.update({"system.resources.movement.value": 30});
  qa.eventHook = Hooks.on("wildpath.automationEvent", e => {
    if (e.type.startsWith("movement.") && sameEntityRef(e.data.tokenRef, qa.tokenRef)) qa.events.push(structuredClone(e));
  });
  const point = p => p ? Object.fromEntries([
    "x", "y", "elevation", "width", "height", "depth", "shape", "level",
    "checkpoint", "intermediate", "movementId", "subpathId", "action", "userId"
  ].filter(k => p[k] !== undefined).map(k => [k, p[k]])) : null;
  const originals = {}, wrappers = {};
  for (const name of ["observeMovementProgress", "observeMovementCompletion"]) {
    originals[name] = a[name];
    wrappers[name] = a[name] = async function(completion, options = {}) {
      if (options.tokenDocument?.uuid !== d.uuid) return originals[name].call(this, completion, options);
      const m = d.movement;
      const trace = structuredClone({
        sequence: qa.traces.length, lifecycle: completion.metadata?.foundryLifecycle,
        operationId: completion.movementId, foundry: completion.foundry,
        observedPassed: completion.waypoints, sourcePosition: options.sourcePosition,
        sourceAtEntry: point(d.toObject(true)),
        currentDocumentMovement: {
          id: m.id, chain: [...m.chain], subpathId: m.subpathId, state: m.state,
          origin: point(m.origin), destination: point(m.destination),
          passed: m.passed.waypoints.map(point), pending: m.pending.waypoints.map(point)
        },
        authorityBeforeQueue: a.getMovementProgress(completion)
      });
      qa.traces.push(trace);
      try {
        const result = await originals[name].call(this, completion, options);
        trace.result = structuredClone(result);
        trace.authorityAfter = a.getMovementProgress(completion);
        return result;
      } catch (error) { trace.exception = error.message; throw error; }
      finally { console.log("WP pause trace", JSON.stringify(trace, null, 2)); }
    };
  }
  qa.dump = () => {
    const m = d.movement, rootId = m.chain[0] ?? m.id;
    const events = qa.events.filter(e => e.data.movementId === rootId);
    const output = {
      rootId, operationId: m.id, chain: [...m.chain], subpathId: m.subpathId,
      state: m.state, movement: d.actor.system.resources.movement.value,
      eventCount: events.length, uniqueEventIds: new Set(events.map(e => e.id)).size,
      eventIds: events.map(e => e.id), types: events.map(e => e.type),
      indices: events.filter(e => e.type === "movement.transition").map(e => e.data.transitionIndex), events,
      progress: a.getMovementProgress({movementId: rootId, sceneRef: d.parent.uuid, tokenRef: d.uuid}),
      baseWorldBefore: qa.baseWorldBefore, baseWorldNow: d.baseActor?.system.resources.movement.value,
      traces: qa.traces
    };
    console.log("WP pause capture", JSON.stringify(output, null, 2));
    return output;
  };
  qa.cleanup = () => {
    Hooks.off("wildpath.automationEvent", qa.eventHook);
    for (const name of Object.keys(originals)) if (a[name] === wrappers[name]) a[name] = originals[name];
  };
  console.log({gmRecorderInstalled: true, token: d.uuid, tokenRef: qa.tokenRef,
    movement: d.actor.system.resources.movement.value});
}
```

## 2. Initiating Player: install observer and start a keyed pause

```js
{
  if (game.user.isGM) throw new Error("Run on the initiating player.");
  if (canvas.tokens.controlled.length !== 1) throw new Error("Select exactly one QA Token.");
  const {normalizeEntityRef, sameEntityRef} = await import("/systems/wildpath/module/helpers/entity-refs.mjs");
  const d = canvas.tokens.controlled[0].document;
  if (["pending", "paused"].includes(d.movement.state)) throw new Error("Finish the previous movement first.");
  globalThis.wpPauseQA?.cleanup?.();
  const qa = globalThis.wpPauseQA = {
    d, id: foundry.utils.randomID(), key: `wildpath-qa-${foundry.utils.randomID()}`, events: []
  };
  qa.tokenRef = normalizeEntityRef({tokenId: d.id, sceneId: d.parent.id});
  qa.eventHook = Hooks.on("wildpath.automationEvent", e => {
    if (e.type.startsWith("movement.") && sameEntityRef(e.data.tokenRef, qa.tokenRef)) qa.events.push(structuredClone(e));
  });
  const grid = canvas.grid, origin = d.toObject(true), route = [];
  let offset = grid.getOffset(origin);
  const center = grid.getCenterPoint(offset);
  for (let step = 0; step < 3; step++) {
    offset = [...grid.getAdjacentOffsets(offset)].sort((a, b) => {
      const pa = grid.getCenterPoint(a), pb = grid.getCenterPoint(b);
      return pb.x - pa.x || Math.abs(pa.y - center.y) - Math.abs(pb.y - center.y);
    })[0];
    const next = grid.getCenterPoint(offset);
    route.push({x: Math.round(origin.x + next.x - center.x),
      y: Math.round(origin.y + next.y - center.y), checkpoint: step >= 1});
  }
  qa.moveHook = Hooks.on("moveToken", (doc, movement, operation, user) => {
    if (doc.uuid !== d.uuid || movement.id !== qa.id || user.id !== game.user.id) return;
    if (!movement.pending.waypoints.length) return;
    Hooks.off("moveToken", qa.moveHook);
    qa.pausePromise = d.pauseMovement(qa.key);
    if (qa.pausePromise === null) throw new Error("Keyed pause was refused.");
    console.log({paused: true, movementId: qa.id, pauseKey: qa.key, playerEventCount: qa.events.length});
  });
  qa.cleanup = () => {
    Hooks.off("moveToken", qa.moveHook);
    Hooks.off("wildpath.automationEvent", qa.eventHook);
  };
  qa.finished = d.move(route, {id: qa.id});
  console.log({started: true, movementId: qa.id, pauseKey: qa.key, route});
}
```

## 3. Active GM: capture before resume

Once paused, paste this before resuming. Expected: movement 20, three unique events, paused progress
2/3, and no warning on either client. If a warning recurs, retain the entire `WP pause capture` JSON.

```js
{
  const qa = globalThis.wpPauseQA, paused = qa.dump();
  console.assert(paused.movement === 20 && paused.eventCount === 3 && paused.uniqueEventIds === 3);
  console.assert(paused.progress.status === "paused" && paused.progress.completedTransitionCount === 2);
  console.assert(paused.progress.remainingTransitionCount === 1 && paused.progress.paidTransitionCount === 2);
  console.assert(paused.progress.committedMovementCost === 10 && paused.progress.paymentFailure === null);
  console.assert(JSON.stringify(paused.types) === JSON.stringify([
    "movement.started", "movement.transition", "movement.transition"
  ]));
  console.assert(JSON.stringify(paused.indices) === "[0,1]");
  qa.paused = paused;
}
```

A failed trace's `result.observation` records the lifecycle, operation/root relationship, derived
anchors, observed and authoritative counts at reconciliation, and observed/expected/authoritative
footprints. `authorityBeforeQueue` is earlier diagnostic context; `currentDocumentMovement` is
separate from the observed operation and must not be treated as its identity.

## 4. Initiating Player: resume after saving the paused capture

```js
{
  const qa = globalThis.wpPauseQA;
  if (!qa?.pausePromise || qa.d.movement.id !== qa.id || qa.d.movement.state !== "paused") {
    throw new Error("No matching keyed pause is ready.");
  }
  qa.d.resumeMovement(qa.id, qa.key);
  console.log({resumed: await qa.pausePromise, completed: await qa.finished,
    playerEventCount: qa.events.length});
}
```

Expected Player output: `resumed: true`, `completed: true`, `playerEventCount: 0`.
On the GM, run the complete final capture block:

```js
{
  const qa = globalThis.wpPauseQA, final = qa.dump();
  console.assert(final.movement === 15 && final.eventCount === 5 && final.uniqueEventIds === 5);
  console.assert(final.rootId === qa.paused.rootId && final.subpathId === qa.paused.subpathId);
  console.assert(final.progress.status === "completed" && final.progress.completedTransitionCount === 3);
  console.assert(final.progress.remainingTransitionCount === 0 && final.progress.paidTransitionCount === 3);
  console.assert(final.progress.committedMovementCost === 15 && final.progress.paymentFailure === null);
  console.assert(final.progress.operationIds.length === 2);
  console.assert(JSON.stringify(final.types) === JSON.stringify([
    "movement.started", "movement.transition", "movement.transition", "movement.transition", "movement.completed"
  ]));
  console.assert(JSON.stringify(final.indices) === "[0,1,2]");
  console.assert(JSON.stringify(final.eventIds.slice(0, 3)) === JSON.stringify(qa.paused.eventIds));
  if (!qa.d.actorLink) console.assert(final.baseWorldBefore === final.baseWorldNow);
}
```

Expected final accounting: movement 15, five unique events (started, transitions 0/1/2, completed),
one root, committed movement cost 15. The unlinked Token's base world Actor stays unchanged.

## 5. Cleanup on each client after completion

```js
globalThis.wpPauseQA?.cleanup?.();
```

The plain captures remain in `wpPauseQA` for copying until reload; only temporary wrappers/listeners
are removed. If abandoning the test while paused, stop it on the initiating Player before cleanup:

```js
{
  const qa = globalThis.wpPauseQA;
  qa.d.stopMovement();
  console.log({completed: await qa.finished});
  qa.cleanup();
}
```
