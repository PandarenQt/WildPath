# Generic movement/reaction live QA (V14.367)

## STOP CONDITIONS

Stop the current case immediately if a block throws `STOP QA`, a prompt or socket error occurs,
the Token reaches C while the reaction dialog is open, the active GM changes, or a proof fails.
Keep the full `WP movement reaction QA` JSON, `wpMovementReactionQA.lastDump`, and console errors.
Do not continue to the next case or manually resume a failed case. Use the cleanup blocks at the
end after retaining diagnostics; only the initiating player stops an outstanding movement.

## CONTINUE CONDITIONS

Continue only when the current block completes without errors and its stated proof passes.
While a reaction dialog is open, both pause proofs must pass before selecting a response.
Start the next case only after both final GM and player proofs pass for the current case.
The final live gate requires **Decline, Accept, and Terminate** to pass on this repaired build.

Status: the reported Accept run reached child commit and failed after successful planning.
Production-shaped replay found a condition TargetCandidate identity mismatch at commit preflight,
then the installed V14.367 `Actor.toggleStatusEffect()` rejected the array-shaped status registry.
Both boundaries are repaired; failed/cancelled children now retain bounded diagnostics.
**This build has not passed live QA yet.** Finish or stop any previous QA movement, load the repaired
system, and refresh both clients so startup restores the Foundry status registry. Do not reuse console
helpers from the previous run. See [the reproduction record](nested-reaction-child-commit.md).

Use an isolated QA world with
no other active resolutions; setup temporarily replaces the reaction service provider and cleanup
restores it. Use a disposable player-owned
Token on a clear square or hex route with two available cells to its left, at least 10 ft movement
maximum, and one reaction.
All three fresh start blocks prefer decreasing world X, with deterministic hex tie-breaking.
For Large hex, use the same three-field Token configuration accepted in the movement milestone.
Select that exact Token on both clients. The generic fixture lets the moving Actor react to its
own first completed transition; this is a software fixture, not a gameplay rule.

Run the new GM setup and player setup once. Then follow each case's own complete blocks below
in order. No prior guide or old console snippet is needed. Use the real reaction dialog on the
player; **Decline is explicitly selected by default**. For Accept and Terminate, select
**QA reaction Action** before clicking Submit. Nothing here patches the production resolver,
movement pause, socket protocol, or Action commit implementation.

## 1. Active GM setup and generic TriggerDefinition fixture

```js
{
  if (game.users.activeGM?.id !== game.user.id) throw new Error("Run on the active GM.");
  if (canvas.tokens.controlled.length !== 1) throw new Error("Select exactly one QA Token.");
  if (globalThis.wpMovementReactionQA) throw new Error("Clean up the previous QA setup first.");
  const d = canvas.tokens.controlled[0].document;
  if (["pending", "paused"].includes(d.movement.state)) throw new Error("Finish the prior movement first.");
  if (d.actor.system.resources.movement.max < 10) throw new Error("The QA Actor needs at least 10 ft movement maximum.");
  const {createReactionTrigger} = await import("/systems/wildpath/module/helpers/automation-events.mjs");
  const {createBuiltinEconomyResource} = await import("/systems/wildpath/module/helpers/action-economy.mjs");
  const {normalizeEntityRef, sameEntityRef} = await import("/systems/wildpath/module/helpers/entity-refs.mjs");
  const {createActionReactionChildState} = await import("/systems/wildpath/module/resolvers/action-pipeline-resolver.mjs");
  const {updateResolutionState} = await import("/systems/wildpath/module/helpers/resolution-state.mjs");
  const {foundryActorSystemSnapshot} = await import("/systems/wildpath/module/adapters/foundry-v14-actor-system-adapter.mjs");
  const authority = game.wildpath.movement;
  const tokenRef = normalizeEntityRef({tokenId: d.id, sceneId: d.parent.id});
  const qa = globalThis.wpMovementReactionQA = {
    d, tokenRef, mode: "decline", events: [], waiters: [], observations: new Set(),
    marker: `movement-reaction-qa:${d.uuid}`, previousServices: game.wildpath.reactionServices,
    originalResources: {movement: d.actor.system.resources.movement.value, reaction: d.actor.system.resources.reaction.value},
    originals: {}, wrappers: {},
    baseWorldBefore: d.baseActor ? {resources: foundryActorSystemSnapshot(d.baseActor).resources,
      effects: [...d.baseActor.effects].map(effect => effect.toObject())} : null
  };
  qa.eventHook = Hooks.on("wildpath.automationEvent", event => {
    if (!event.type.startsWith("movement.") || !sameEntityRef(event.data.tokenRef, tokenRef)) return;
    qa.events.push(structuredClone(event));
    for (const waiter of [...qa.waiters]) if (waiter.types.includes(event.type)) {
      qa.waiters.splice(qa.waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  });
  qa.waitFor = types => {
    types = Array.isArray(types) ? types : [types];
    const event = qa.events.find(e => types.includes(e.type));
    return event ? Promise.resolve(event) : new Promise(resolve => qa.waiters.push({types, resolve}));
  };
  qa.require = (condition, message) => {
    if (condition) return;
    const failures = (qa.lastDump?.hosts ?? []).flatMap(host => (host.reactions ?? [])
      .filter(reaction => ["failed", "cancelled"].includes(reaction.childStatus)).map(reaction => reaction.childOutcome));
    console.error("WP nested child failure summaries", JSON.stringify(failures, null, 2));
    console.error("STOP QA:", message, qa.lastDump);
    throw new Error(`STOP QA: ${message}; full diagnostic JSON remains in wpMovementReactionQA.lastDump.`);
  };
  for (const name of ["observeMovementProgress", "observeMovementCompletion"]) {
    const original = qa.originals[name] = authority[name];
    const wrapper = qa.wrappers[name] = function(...args) {
      const pending = original.apply(this, args);
      qa.observations.add(pending);
      pending.then(() => qa.observations.delete(pending), () => qa.observations.delete(pending));
      return pending;
    };
    authority[name] = wrapper;
  }
  qa.effectIds = () => [...d.actor.effects].filter(effect =>
    effect.flags?.wildpath?.conditionEffect?.metadata?.source === qa.marker).map(effect => effect.id);
  qa.prepare = async mode => {
    if (["pending", "paused"].includes(d.movement.state)) throw new Error("Finish or stop the current movement first.");
    const ids = qa.effectIds();
    if (ids.length) await d.actor.deleteEmbeddedDocuments("ActiveEffect", ids);
    qa.mode = mode;
    qa.events.length = 0;
    await d.actor.update({"system.resources.movement.value": Math.min(30, d.actor.system.resources.movement.max),
      "system.resources.reaction.value": 1});
    qa.startBudget = d.actor.system.resources.movement.value;
    console.log({mode, token: d.uuid, movement: qa.startBudget, reaction: d.actor.system.resources.reaction.value});
  };
  const action = {schemaVersion: 1, id: "action:movement-reaction-qa", label: "QA reaction Action",
    costs: {allOf: [{capability: "reaction", amount: 1}]}, targeting: {type: "self", required: true},
    effects: [{id: "qa-effect", type: "condition", conditionId: "prone", metadata: {source: qa.marker}}]};
  qa.provider = ({intent} = {}) => {
    const actorDocuments = {[d.actor.id]: d.actor, [d.actor.uuid]: d.actor};
    const actorSystemSnapshot = foundryActorSystemSnapshot(d.actor);
    const actorSystems = {[d.actor.id]: actorSystemSnapshot, [d.actor.uuid]: actorSystemSnapshot};
    return {targetActors: actorDocuments, reactions: {
      triggers: [createReactionTrigger({id: qa.marker, event: "movement.transition", actorId: d.actor.id,
        tokenId: d.id, action, actionId: action.id, chooser: {kind: "specific", userId: intent?.sourceUserId},
        predicate: {all: [{equals: {path: "event.data.tokenRef", value: tokenRef}},
          {equals: {path: "event.data.transitionIndex", value: 0}}]}})],
      actorSystemsByActor: actorSystems,
      resourcesByActor: () => ({[d.actor.id]: [createBuiltinEconomyResource("economy.reaction", {
        current: d.actor.system.resources.reaction.value, maximum: d.actor.system.resources.reaction.max})]}),
      createChildState(context) {
        const child = createActionReactionChildState({...context,
          services: {reactions: {actorSystemsByActor: actorSystems}}});
        return qa.mode === "terminate" ? updateResolutionState(child,
          {results: {...child.results, parentDirective: {type: "cancel-parent"}}}) : child;
      }
    }};
  };
  game.wildpath.reactionServices = qa.provider;
  qa.dump = () => {
    const rootId = qa.events[0]?.data.movementId;
    const progress = rootId ? authority.getMovementProgress({movementId: rootId, sceneRef: d.parent.uuid, tokenRef: d.uuid}) : null;
    const hosts = [...game.wildpath.multiplayer.coordinator.records.values()]
      .filter(record => record.state?.sourceEvent?.data?.movementId === rootId)
      .map(record => ({id: record.resolutionId, status: record.state.status,
        actionDefinition: record.state.actionDefinition, sourceEvent: record.state.sourceEvent,
        reactions: record.state.results.reactions, pendingRequests: record.state.pendingRequests,
        childIds: [...record.knownResolutionIds].filter(id => id !== record.resolutionId)}));
    const output = {rootId, state: d.movement.state, source: d.toObject(true),
      movement: d.actor.system.resources.movement.value, reaction: d.actor.system.resources.reaction.value,
      progress, hosts, effectIds: qa.effectIds(), events: qa.events,
      uniqueEventIds: new Set(qa.events.map(e => e.id)).size,
      baseWorldBefore: qa.baseWorldBefore, baseWorldNow: d.baseActor ? {
        resources: foundryActorSystemSnapshot(d.baseActor).resources,
        effects: [...d.baseActor.effects].map(effect => effect.toObject())} : null};
    qa.lastDump = output;
    console.log("WP movement reaction QA", JSON.stringify(output, null, 2));
    return output;
  };
  await qa.prepare("decline");
}
```

## 2. Initiating player setup

```js
{
  if (game.user.isGM) throw new Error("Run on the initiating player.");
  if (canvas.tokens.controlled.length !== 1) throw new Error("Select exactly one QA Token.");
  if (globalThis.wpMovementReactionQA) throw new Error("Clean up the previous QA setup first.");
  const d = canvas.tokens.controlled[0].document;
  if (!d.isOwner) throw new Error("The player must own the selected Token.");
  const {normalizeEntityRef, sameEntityRef} = await import("/systems/wildpath/module/helpers/entity-refs.mjs");
  const tokenRef = normalizeEntityRef({tokenId: d.id, sceneId: d.parent.id});
  const qa = globalThis.wpMovementReactionQA = {d, tokenRef, events: [], id: null, finished: null, route: null};
  qa.eventHook = Hooks.on("wildpath.automationEvent", event => {
    if (event.type.startsWith("movement.") && sameEntityRef(event.data.tokenRef, tokenRef)) qa.events.push(structuredClone(event));
  });
  qa.require = (condition, message) => {
    if (condition) return;
    qa.lastDump = {rootMovementId: qa.id, state: d.movement.state, source: d.toObject(true),
      route: qa.route, events: qa.events};
    console.error("STOP QA:", message, qa.lastDump);
    throw new Error(`STOP QA: ${message}; diagnostics remain in wpMovementReactionQA.lastDump.`);
  };
  console.log({playerReady: true, token: d.uuid, playerEventCount: qa.events.length});
}
```

## 3. Decline

Active GM: prepare this case.

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.prepare || game.users.activeGM?.id !== game.user.id) throw new Error("Install the GM setup first.");
  await qa.prepare("decline");
}
```

Initiating player: start this case from the current Token position.

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.require || game.user.isGM) throw new Error("Install the player setup first.");
  const d = qa.d;
  if (["pending", "paused"].includes(d.movement.state)) throw new Error("Finish the prior movement first.");
  const grid = canvas.grid, origin = d.toObject(true), route = [];
  let offset = grid.getOffset(origin);
  const center = grid.getCenterPoint(offset);
  for (let step = 0; step < 2; step++) {
    const current = grid.getCenterPoint(offset);
    offset = [...grid.getAdjacentOffsets(offset)]
      .filter(candidate => grid.getCenterPoint(candidate).x < current.x)
      .sort((a, b) => {
        const pa = grid.getCenterPoint(a), pb = grid.getCenterPoint(b);
        return pa.x - pb.x || Math.abs(pa.y - center.y) - Math.abs(pb.y - center.y)
          || pa.y - pb.y || a.i - b.i || a.j - b.j;
      })[0];
    qa.require(offset, "No adjacent leftward cell; stop and choose a clear QA route.");
    const next = grid.getCenterPoint(offset);
    route.push({x: Math.round(origin.x + next.x - center.x), y: Math.round(origin.y + next.y - center.y)});
  }
  qa.id = foundry.utils.randomID();
  qa.route = route;
  qa.finished = d.move(route, {id: qa.id});
  qa.finished.catch(error => console.error("STOP QA: movement failed", error));
  console.log({started: true, rootMovementId: qa.id, route, playerEventCount: qa.events.length});
}
```

Leave the reaction dialog open. No checkpoint or pause is manually installed by the start block.

Active GM: prove the first transition is paid and the reaction is pending.

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.require || game.users.activeGM?.id !== game.user.id) throw new Error("Install the GM setup first.");
  await qa.waitFor(["movement.transition", "movement.interrupted"]);
  await Promise.all([...qa.observations]);
  const result = qa.dump();
  qa.require(result.progress && Array.isArray(result.hosts), "Expected movement progress and reaction host diagnostics.");
  qa.require(result.progress.completedTransitionCount === 1 && result.progress.remainingTransitionCount === 1,
    "Expected exactly one completed transition and one unexecuted transition.");
  qa.require(result.movement === qa.startBudget - 5 && result.reaction === 1, "Expected only the first transition paid.");
  qa.require(result.events.map(e => e.type).join() === "movement.started,movement.transition" && result.uniqueEventIds === 2,
    "Expected only started and transition 0 while the dialog is open.");
  const first = result.hosts.find(host => host.sourceEvent?.data?.transitionIndex === 0);
  qa.require(first && Array.isArray(first.pendingRequests), "Expected a host for transition 0 with pending requests.");
  qa.require(first.actionDefinition === null && first.pendingRequests[0]?.type === "reaction-choice",
    "Expected an informational event host awaiting a reaction-choice request.");
  const transition = first.sourceEvent.data;
  if (canvas.grid.isHexagonal && transition.from?.footprint?.effectiveSize === "large") {
    qa.require(transition.from?.footprint?.fields?.length === 3 && transition.to?.footprint?.fields?.length === 3,
      "Large hex must retain three occupied fields at both endpoints.");
    qa.require(transition.leftFields?.length === 2 && transition.enteredFields?.length === 2
      && transition.retainedFields?.length === 1 && transition.stepCost?.amount === 5,
      "Large hex transition must have two left, two entered, one retained, and cost 5.");
  }
  console.log("PASS: GM paid-prefix and pending-reaction proof.");
}
```

Initiating player: prove the Token is held at B.

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.require || game.user.isGM) throw new Error("Install the player setup first.");
  qa.require(qa.route?.length === 2, "Expected the current two-transition QA route.");
  const position = qa.d.toObject(true);
  qa.require(qa.d.movement.state === "paused", "Expected movement paused while the dialog is open.");
  qa.require(position.x === qa.route[0].x && position.y === qa.route[0].y, "Expected the Token at B, before C.");
  qa.require(qa.events.length === 0, "The initiating player must not emit authoritative movement events.");
  console.log("PASS: player paused at B", {position, remainingDestination: qa.route[1], playerEventCount: qa.events.length});
}
```

Leave **Decline** selected and click **Submit**. Only do this after both pause proofs pass.

Initiating player: prove the final position and completion result.

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.require || game.user.isGM) throw new Error("Install the player setup first.");
  qa.require(qa.finished && qa.route?.length === 2, "Expected the current QA movement and route.");
  const finished = await qa.finished;
  const position = qa.d.toObject(true);
  qa.require(finished === true && qa.d.movement.state === "completed", "Expected completed movement after the reaction choice.");
  qa.require(position.x === qa.route[1].x && position.y === qa.route[1].y, "Expected final position at C.");
  qa.require(qa.events.length === 0, "The initiating player must not emit authoritative movement events.");
  console.log("PASS: Decline player proof", {finished, state: qa.d.movement.state, position, playerEventCount: qa.events.length});
}
```

Active GM: prove the semantic history, payment, and child result. This waits for either terminal event,
so an incorrect completion in the Terminate case produces a clear failure.

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.require || game.users.activeGM?.id !== game.user.id) throw new Error("Install the GM setup first.");
  await qa.waitFor(["movement.completed", "movement.interrupted"]);
  await Promise.all([...qa.observations]);
  const result = qa.dump();
  qa.require(result.progress && Array.isArray(result.hosts), "Expected progress and host diagnostics.");
  qa.require(result.events.map(e => e.type).join() === "movement.started,movement.transition,movement.transition,movement.completed", "Unexpected Decline semantic history.");
  qa.require(result.uniqueEventIds === 4 && result.progress.completedTransitionCount === 2
    && result.progress.remainingTransitionCount === 0 && result.progress.status === "completed",
    "Expected one root with unique events and the correct completed prefix.");
  qa.require(result.movement === qa.startBudget - 10, "Movement payment must match only completed transitions.");
  qa.require(result.hosts.length > 0 && result.hosts.every(host => host.status === "completed" && host.childIds.length === 0),
    "Decline must complete without creating a child Action.");
  qa.require(result.reaction === 1 && result.effectIds.length === 0, "Decline must leave the reaction and effects untouched.");
  if (!qa.d.actorLink) qa.require(JSON.stringify(result.baseWorldNow) === JSON.stringify(result.baseWorldBefore),
    "Synthetic Token Actor payment must not change the base world Actor.");
  console.log("PASS: Decline GM proof; retain the complete JSON above.");
}
```

## 4. Accept

Active GM: prepare this case.

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.prepare || game.users.activeGM?.id !== game.user.id) throw new Error("Install the GM setup first.");
  await qa.prepare("accept");
}
```

Initiating player: start this case from the current Token position.

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.require || game.user.isGM) throw new Error("Install the player setup first.");
  const d = qa.d;
  if (["pending", "paused"].includes(d.movement.state)) throw new Error("Finish the prior movement first.");
  const grid = canvas.grid, origin = d.toObject(true), route = [];
  let offset = grid.getOffset(origin);
  const center = grid.getCenterPoint(offset);
  for (let step = 0; step < 2; step++) {
    const current = grid.getCenterPoint(offset);
    offset = [...grid.getAdjacentOffsets(offset)]
      .filter(candidate => grid.getCenterPoint(candidate).x < current.x)
      .sort((a, b) => {
        const pa = grid.getCenterPoint(a), pb = grid.getCenterPoint(b);
        return pa.x - pb.x || Math.abs(pa.y - center.y) - Math.abs(pb.y - center.y)
          || pa.y - pb.y || a.i - b.i || a.j - b.j;
      })[0];
    qa.require(offset, "No adjacent leftward cell; stop and choose a clear QA route.");
    const next = grid.getCenterPoint(offset);
    route.push({x: Math.round(origin.x + next.x - center.x), y: Math.round(origin.y + next.y - center.y)});
  }
  qa.id = foundry.utils.randomID();
  qa.route = route;
  qa.finished = d.move(route, {id: qa.id});
  qa.finished.catch(error => console.error("STOP QA: movement failed", error));
  console.log({started: true, rootMovementId: qa.id, route, playerEventCount: qa.events.length});
}
```

Leave the reaction dialog open. No checkpoint or pause is manually installed by the start block.

Active GM: prove the first transition is paid and the reaction is pending.

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.require || game.users.activeGM?.id !== game.user.id) throw new Error("Install the GM setup first.");
  await qa.waitFor(["movement.transition", "movement.interrupted"]);
  await Promise.all([...qa.observations]);
  const result = qa.dump();
  qa.require(result.progress && Array.isArray(result.hosts), "Expected movement progress and reaction host diagnostics.");
  qa.require(result.progress.completedTransitionCount === 1 && result.progress.remainingTransitionCount === 1,
    "Expected exactly one completed transition and one unexecuted transition.");
  qa.require(result.movement === qa.startBudget - 5 && result.reaction === 1, "Expected only the first transition paid.");
  qa.require(result.events.map(e => e.type).join() === "movement.started,movement.transition" && result.uniqueEventIds === 2,
    "Expected only started and transition 0 while the dialog is open.");
  const first = result.hosts.find(host => host.sourceEvent?.data?.transitionIndex === 0);
  qa.require(first && Array.isArray(first.pendingRequests), "Expected a host for transition 0 with pending requests.");
  qa.require(first.actionDefinition === null && first.pendingRequests[0]?.type === "reaction-choice",
    "Expected an informational event host awaiting a reaction-choice request.");
  const transition = first.sourceEvent.data;
  if (canvas.grid.isHexagonal && transition.from?.footprint?.effectiveSize === "large") {
    qa.require(transition.from?.footprint?.fields?.length === 3 && transition.to?.footprint?.fields?.length === 3,
      "Large hex must retain three occupied fields at both endpoints.");
    qa.require(transition.leftFields?.length === 2 && transition.enteredFields?.length === 2
      && transition.retainedFields?.length === 1 && transition.stepCost?.amount === 5,
      "Large hex transition must have two left, two entered, one retained, and cost 5.");
  }
  console.log("PASS: GM paid-prefix and pending-reaction proof.");
}
```

Initiating player: prove the Token is held at B.

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.require || game.user.isGM) throw new Error("Install the player setup first.");
  qa.require(qa.route?.length === 2, "Expected the current two-transition QA route.");
  const position = qa.d.toObject(true);
  qa.require(qa.d.movement.state === "paused", "Expected movement paused while the dialog is open.");
  qa.require(position.x === qa.route[0].x && position.y === qa.route[0].y, "Expected the Token at B, before C.");
  qa.require(qa.events.length === 0, "The initiating player must not emit authoritative movement events.");
  console.log("PASS: player paused at B", {position, remainingDestination: qa.route[1], playerEventCount: qa.events.length});
}
```

Select **QA reaction Action** and click **Submit**. Only do this after both pause proofs pass.

Initiating player: prove the final position and completion result.

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.require || game.user.isGM) throw new Error("Install the player setup first.");
  qa.require(qa.finished && qa.route?.length === 2, "Expected the current QA movement and route.");
  const finished = await qa.finished;
  const position = qa.d.toObject(true);
  qa.require(finished === true && qa.d.movement.state === "completed", "Expected completed movement after the reaction choice.");
  qa.require(position.x === qa.route[1].x && position.y === qa.route[1].y, "Expected final position at C.");
  qa.require(qa.events.length === 0, "The initiating player must not emit authoritative movement events.");
  console.log("PASS: Accept player proof", {finished, state: qa.d.movement.state, position, playerEventCount: qa.events.length});
}
```

Active GM: prove the semantic history, payment, and child result. This waits for either terminal event,
so an incorrect completion in the Terminate case produces a clear failure.

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.require || game.users.activeGM?.id !== game.user.id) throw new Error("Install the GM setup first.");
  await qa.waitFor(["movement.completed", "movement.interrupted"]);
  await Promise.all([...qa.observations]);
  const result = qa.dump();
  qa.require(result.progress && Array.isArray(result.hosts), "Expected progress and host diagnostics.");
  qa.require(result.events.map(e => e.type).join() === "movement.started,movement.transition,movement.transition,movement.completed", "Unexpected Accept semantic history.");
  qa.require(result.uniqueEventIds === 4 && result.progress.completedTransitionCount === 2
    && result.progress.remainingTransitionCount === 0 && result.progress.status === "completed",
    "Expected one root with unique events and the correct completed prefix.");
  qa.require(result.movement === qa.startBudget - 10, "Movement payment must match only completed transitions.");
  const first = result.hosts.find(host => host.sourceEvent?.data?.transitionIndex === 0);
  qa.require(first && Array.isArray(first.childIds) && first.childIds.length === 1,
    "Expected exactly one child Action for the selected QA reaction Action.");
  qa.require(Array.isArray(first.reactions) && first.reactions.length === 1,
    "Expected one reaction result before inspecting child completion.");
  qa.require(first.reactions[0]?.childStatus === "completed", "Expected the ordinary child Action to complete.");
  qa.require(result.reaction === 0 && result.effectIds.length === 1, "Expected one committed reaction cost and marked effect.");
  qa.require(first.status === "completed", "Expected the event host to complete before movement resumes.");
  if (!qa.d.actorLink) qa.require(JSON.stringify(result.baseWorldNow) === JSON.stringify(result.baseWorldBefore),
    "Synthetic Token Actor payment must not change the base world Actor.");
  console.log("PASS: Accept GM proof; retain the complete JSON above.");
}
```

## 5. Terminate

Active GM: prepare this case.

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.prepare || game.users.activeGM?.id !== game.user.id) throw new Error("Install the GM setup first.");
  await qa.prepare("terminate");
}
```

Initiating player: start this case from the current Token position.

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.require || game.user.isGM) throw new Error("Install the player setup first.");
  const d = qa.d;
  if (["pending", "paused"].includes(d.movement.state)) throw new Error("Finish the prior movement first.");
  const grid = canvas.grid, origin = d.toObject(true), route = [];
  let offset = grid.getOffset(origin);
  const center = grid.getCenterPoint(offset);
  for (let step = 0; step < 2; step++) {
    const current = grid.getCenterPoint(offset);
    offset = [...grid.getAdjacentOffsets(offset)]
      .filter(candidate => grid.getCenterPoint(candidate).x < current.x)
      .sort((a, b) => {
        const pa = grid.getCenterPoint(a), pb = grid.getCenterPoint(b);
        return pa.x - pb.x || Math.abs(pa.y - center.y) - Math.abs(pb.y - center.y)
          || pa.y - pb.y || a.i - b.i || a.j - b.j;
      })[0];
    qa.require(offset, "No adjacent leftward cell; stop and choose a clear QA route.");
    const next = grid.getCenterPoint(offset);
    route.push({x: Math.round(origin.x + next.x - center.x), y: Math.round(origin.y + next.y - center.y)});
  }
  qa.id = foundry.utils.randomID();
  qa.route = route;
  qa.finished = d.move(route, {id: qa.id});
  qa.finished.catch(error => console.error("STOP QA: movement failed", error));
  console.log({started: true, rootMovementId: qa.id, route, playerEventCount: qa.events.length});
}
```

Leave the reaction dialog open. No checkpoint or pause is manually installed by the start block.

Active GM: prove the first transition is paid and the reaction is pending.

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.require || game.users.activeGM?.id !== game.user.id) throw new Error("Install the GM setup first.");
  await qa.waitFor(["movement.transition", "movement.interrupted"]);
  await Promise.all([...qa.observations]);
  const result = qa.dump();
  qa.require(result.progress && Array.isArray(result.hosts), "Expected movement progress and reaction host diagnostics.");
  qa.require(result.progress.completedTransitionCount === 1 && result.progress.remainingTransitionCount === 1,
    "Expected exactly one completed transition and one unexecuted transition.");
  qa.require(result.movement === qa.startBudget - 5 && result.reaction === 1, "Expected only the first transition paid.");
  qa.require(result.events.map(e => e.type).join() === "movement.started,movement.transition" && result.uniqueEventIds === 2,
    "Expected only started and transition 0 while the dialog is open.");
  const first = result.hosts.find(host => host.sourceEvent?.data?.transitionIndex === 0);
  qa.require(first && Array.isArray(first.pendingRequests), "Expected a host for transition 0 with pending requests.");
  qa.require(first.actionDefinition === null && first.pendingRequests[0]?.type === "reaction-choice",
    "Expected an informational event host awaiting a reaction-choice request.");
  const transition = first.sourceEvent.data;
  if (canvas.grid.isHexagonal && transition.from?.footprint?.effectiveSize === "large") {
    qa.require(transition.from?.footprint?.fields?.length === 3 && transition.to?.footprint?.fields?.length === 3,
      "Large hex must retain three occupied fields at both endpoints.");
    qa.require(transition.leftFields?.length === 2 && transition.enteredFields?.length === 2
      && transition.retainedFields?.length === 1 && transition.stepCost?.amount === 5,
      "Large hex transition must have two left, two entered, one retained, and cost 5.");
  }
  console.log("PASS: GM paid-prefix and pending-reaction proof.");
}
```

Initiating player: prove the Token is held at B.

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.require || game.user.isGM) throw new Error("Install the player setup first.");
  qa.require(qa.route?.length === 2, "Expected the current two-transition QA route.");
  const position = qa.d.toObject(true);
  qa.require(qa.d.movement.state === "paused", "Expected movement paused while the dialog is open.");
  qa.require(position.x === qa.route[0].x && position.y === qa.route[0].y, "Expected the Token at B, before C.");
  qa.require(qa.events.length === 0, "The initiating player must not emit authoritative movement events.");
  console.log("PASS: player paused at B", {position, remainingDestination: qa.route[1], playerEventCount: qa.events.length});
}
```

Select **QA reaction Action** and click **Submit**. Only do this after both pause proofs pass.

Initiating player: prove the final position and completion result.

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.require || game.user.isGM) throw new Error("Install the player setup first.");
  qa.require(qa.finished && qa.route?.length === 2, "Expected the current QA movement and route.");
  const finished = await qa.finished;
  const position = qa.d.toObject(true);
  qa.require(finished === false && qa.d.movement.state === "stopped", "Expected terminal stop after the reaction.");
  qa.require(position.x === qa.route[0].x && position.y === qa.route[0].y, "Expected final position at B with C unexecuted.");
  qa.require(qa.events.length === 0, "The initiating player must not emit authoritative movement events.");
  console.log("PASS: Terminate player proof", {finished, state: qa.d.movement.state, position, playerEventCount: qa.events.length});
}
```

Active GM: prove the semantic history, payment, and child result. This waits for either terminal event,
so an incorrect completion in the Terminate case produces a clear failure.

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.require || game.users.activeGM?.id !== game.user.id) throw new Error("Install the GM setup first.");
  await qa.waitFor(["movement.completed", "movement.interrupted"]);
  await Promise.all([...qa.observations]);
  const result = qa.dump();
  qa.require(result.progress && Array.isArray(result.hosts), "Expected progress and host diagnostics.");
  qa.require(result.events.map(e => e.type).join() === "movement.started,movement.transition,movement.interrupted", "Unexpected Terminate semantic history.");
  qa.require(result.uniqueEventIds === 3 && result.progress.completedTransitionCount === 1
    && result.progress.remainingTransitionCount === 1 && result.progress.status === "interrupted",
    "Expected one root with unique events and the correct completed prefix.");
  qa.require(result.movement === qa.startBudget - 5, "Movement payment must match only completed transitions.");
  const first = result.hosts.find(host => host.sourceEvent?.data?.transitionIndex === 0);
  qa.require(first && Array.isArray(first.childIds) && first.childIds.length === 1,
    "Expected exactly one child Action for the selected QA reaction Action.");
  qa.require(Array.isArray(first.reactions) && first.reactions.length === 1,
    "Expected one reaction result before inspecting child completion.");
  qa.require(first.reactions[0]?.childStatus === "completed", "Expected the ordinary child Action to complete.");
  qa.require(result.reaction === 0 && result.effectIds.length === 1, "Expected one committed reaction cost and marked effect.");
  if (!qa.d.actorLink) qa.require(JSON.stringify(result.baseWorldNow) === JSON.stringify(result.baseWorldBefore),
    "Synthetic Token Actor payment must not change the base world Actor.");
  console.log("PASS: Terminate GM proof; retain the complete JSON above.");
}
```

The termination fixture configures the existing child `parentDirective: cancel-parent`.
It does not patch child completion or restore the Token to an earlier position.

For Large hex, retain transition 0 showing three occupied fields at each endpoint, two left,
two entered, one retained, and cost 5. All three cases must pass before declaring the live gate green.

## 6. Cleanup

If a failed case leaves a hold, the initiating player can call the supported terminal stop first:

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa || game.user.isGM) throw new Error("Run on the initiating player.");
  if (["pending", "paused"].includes(qa.d.movement.state)) qa.d.stopMovement();
  if (qa.finished) await qa.finished;
  Hooks.off("wildpath.automationEvent", qa.eventHook);
  delete globalThis.wpMovementReactionQA;
  console.log("Player QA observers removed.");
}
```

GM cleanup restores fixture resources and removes only marked QA effects. It does not undo
Token movement, erase movement history, or touch unrelated effects:

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.prepare || game.users.activeGM?.id !== game.user.id) throw new Error("Run on the active GM.");
  if (["pending", "paused"].includes(qa.d.movement.state)) throw new Error("Have the initiating player stop movement first.");
  await Promise.all([...qa.observations]);
  Hooks.off("wildpath.automationEvent", qa.eventHook);
  for (const name of Object.keys(qa.originals)) {
    if (game.wildpath.movement[name] === qa.wrappers[name]) game.wildpath.movement[name] = qa.originals[name];
  }
  if (game.wildpath.reactionServices === qa.provider) {
    if (qa.previousServices === undefined) delete game.wildpath.reactionServices;
    else game.wildpath.reactionServices = qa.previousServices;
  }
  const ids = qa.effectIds();
  if (ids.length) await qa.d.actor.deleteEmbeddedDocuments("ActiveEffect", ids);
  await qa.d.actor.update({"system.resources.movement.value": qa.originalResources.movement,
    "system.resources.reaction.value": qa.originalResources.reaction});
  delete globalThis.wpMovementReactionQA;
  console.log("GM fixture, observers, and marked effects removed; fixture resources restored.");
}
```
