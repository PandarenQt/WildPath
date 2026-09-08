# Generic movement/reaction live QA (V14.367)

Status: automated tests pass; **live QA has not been performed**. Use an isolated QA world with
no other active resolutions; setup temporarily replaces the reaction service provider and cleanup
restores it. Use a disposable player-owned
Token on a clear square or hex route, with at least 10 ft movement maximum and one reaction.
For Large hex, use the same three-field Token configuration accepted in the movement milestone.
Select that exact Token on both clients. The generic fixture lets the moving Actor react to its
own first completed transition; this is a software fixture, not a gameplay rule.

Run the GM setup and player setup once. Then run the decline case, accept case, and termination
case in order. Use the real reaction dialog on the player. Each console block is complete;
no editing of an earlier snippet is needed. Nothing here patches the production resolver,
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
  const authority = game.wildpath.movement;
  const tokenRef = normalizeEntityRef({tokenId: d.id, sceneId: d.parent.id});
  const qa = globalThis.wpMovementReactionQA = {
    d, tokenRef, mode: "decline", events: [], waiters: [], observations: new Set(),
    marker: `movement-reaction-qa:${d.uuid}`, previousServices: game.wildpath.reactionServices,
    originalResources: {movement: d.actor.system.resources.movement.value, reaction: d.actor.system.resources.reaction.value},
    originals: {}, wrappers: {},
    baseWorldBefore: d.baseActor?.system.resources.movement.value
  };
  qa.eventHook = Hooks.on("wildpath.automationEvent", event => {
    if (!event.type.startsWith("movement.") || !sameEntityRef(event.data.tokenRef, tokenRef)) return;
    qa.events.push(structuredClone(event));
    for (const waiter of [...qa.waiters]) if (waiter.type === event.type) {
      qa.waiters.splice(qa.waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  });
  qa.waitFor = type => {
    const event = qa.events.find(e => e.type === type);
    return event ? Promise.resolve(event) : new Promise(resolve => qa.waiters.push({type, resolve}));
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
    const actorMap = {[d.actor.id]: d.actor, [d.actor.uuid]: d.actor};
    return {targetActors: actorMap, reactions: {
      triggers: [createReactionTrigger({id: qa.marker, event: "movement.transition", actorId: d.actor.id,
        tokenId: d.id, action, actionId: action.id, chooser: {kind: "specific", userId: intent?.sourceUserId},
        predicate: {all: [{equals: {path: "event.data.tokenRef", value: tokenRef}},
          {equals: {path: "event.data.transitionIndex", value: 0}}]}})],
      actorSystemsByActor: actorMap,
      resourcesByActor: () => ({[d.actor.id]: [createBuiltinEconomyResource("economy.reaction", {
        current: d.actor.system.resources.reaction.value, maximum: d.actor.system.resources.reaction.max})]}),
      createChildState(context) {
        const child = createActionReactionChildState({...context,
          services: {reactions: {actorSystemsByActor: actorMap}}});
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
      baseWorldBefore: qa.baseWorldBefore, baseWorldNow: d.baseActor?.system.resources.movement.value};
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
  console.log({playerReady: true, token: d.uuid, playerEventCount: qa.events.length});
}
```

## 3. Initiating player: start movement (use this complete block for each case)

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa || game.user.isGM) throw new Error("Install the player setup first.");
  const d = qa.d;
  if (["pending", "paused"].includes(d.movement.state)) throw new Error("Finish the prior movement first.");
  const grid = canvas.grid, origin = d.toObject(true), route = [];
  let offset = grid.getOffset(origin);
  const center = grid.getCenterPoint(offset);
  for (let step = 0; step < 2; step++) {
    offset = [...grid.getAdjacentOffsets(offset)].sort((a, b) => {
      const pa = grid.getCenterPoint(a), pb = grid.getCenterPoint(b);
      return pb.x - pa.x || Math.abs(pa.y - center.y) - Math.abs(pb.y - center.y);
    })[0];
    const next = grid.getCenterPoint(offset);
    route.push({x: Math.round(origin.x + next.x - center.x), y: Math.round(origin.y + next.y - center.y)});
  }
  qa.id = foundry.utils.randomID();
  qa.route = route;
  qa.finished = d.move(route, {id: qa.id});
  console.log({started: true, rootMovementId: qa.id, route, playerEventCount: qa.events.length});
}
```

No checkpoint or pause is manually installed by this block. Production preparation and the
production moveToken handler must establish the hold. Leave the player reaction dialog open.

## 4. Active GM: prove pause after transition 0

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.dump || game.users.activeGM?.id !== game.user.id) throw new Error("Install the GM setup first.");
  await qa.waitFor("movement.transition");
  await Promise.all([...qa.observations]);
  const result = qa.dump();
  console.assert(result.progress.completedTransitionCount === 1 && result.progress.remainingTransitionCount === 1);
  console.assert(result.movement === qa.startBudget - 5 && result.reaction === 1);
  console.assert(result.events.length === 2 && result.uniqueEventIds === 2);
  console.assert(result.hosts[0].actionDefinition === null && result.hosts[0].pendingRequests[0].type === "reaction-choice");
}
```

Player position proof, while the reaction dialog is still open:

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.route || game.user.isGM) throw new Error("Start the player QA movement first.");
  const position = qa.d.toObject(true);
  console.assert(qa.d.movement.state === "paused");
  console.assert(position.x === qa.route[0].x && position.y === qa.route[0].y);
  console.assert(qa.events.length === 0);
  console.log({pausedAtB: position, remainingDestination: qa.route[1], playerEventCount: qa.events.length});
}
```

## 5. Decline proof

On the player, choose **Decline** in the existing reaction dialog and click **Submit**. Then:

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.finished || game.user.isGM) throw new Error("Run on the initiating player after Decline.");
  const finished = await qa.finished;
  const position = qa.d.toObject(true);
  console.assert(finished === true);
  console.assert(position.x === qa.route[1].x && position.y === qa.route[1].y);
  console.assert(qa.events.length === 0);
  console.log({declineResumed: finished, source: position, playerEventCount: qa.events.length});
}
```

GM final semantic history:

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.dump || game.users.activeGM?.id !== game.user.id) throw new Error("Run on the active GM.");
  await qa.waitFor("movement.completed");
  await Promise.all([...qa.observations]);
  const result = qa.dump();
  console.assert(result.events.map(e => e.type).join() === "movement.started,movement.transition,movement.transition,movement.completed");
  console.assert(result.uniqueEventIds === 4 && result.progress.completedTransitionCount === 2);
  console.assert(result.movement === qa.startBudget - 10 && result.reaction === 1 && result.effectIds.length === 0);
  console.assert(result.hosts.every(host => host.status === "completed" && host.childIds.length === 0));
}
```

## 6. Accept case setup and normal child Action proof

GM:

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.prepare || game.users.activeGM?.id !== game.user.id) throw new Error("Run on the active GM.");
  await qa.prepare("accept");
}
```

Run the complete player start block from section 3, and the pause proof blocks from section 4.
On the player choose **QA reaction Action** and click **Submit**. The ordinary child Action
commits one reaction resource and the marked test effect, then movement resumes. GM proof:

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.dump || game.users.activeGM?.id !== game.user.id) throw new Error("Run on the active GM.");
  await qa.waitFor("movement.completed");
  await Promise.all([...qa.observations]);
  const result = qa.dump();
  const first = result.hosts.find(host => host.sourceEvent.data.transitionIndex === 0);
  console.assert(first.status === "completed" && first.childIds.length === 1);
  console.assert(first.reactions[0].childStatus === "completed");
  console.assert(result.effectIds.length === 1 && result.reaction === 0);
  console.assert(result.movement === qa.startBudget - 10 && result.uniqueEventIds === 4);
  console.assert(result.events.filter(e => e.type === "movement.started").length === 1);
  console.assert(result.events.filter(e => e.type === "movement.completed").length === 1);
}
```

Player resume and authority proof:

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.finished || game.user.isGM) throw new Error("Run on the initiating player after accepting.");
  const finished = await qa.finished;
  const position = qa.d.toObject(true);
  console.assert(finished === true && position.x === qa.route[1].x && position.y === qa.route[1].y);
  console.assert(qa.events.length === 0);
  console.log({acceptedReactionResumed: finished, source: position, playerEventCount: qa.events.length});
}
```

## 7. Termination case and paid-prefix proof

GM:

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.prepare || game.users.activeGM?.id !== game.user.id) throw new Error("Run on the active GM.");
  await qa.prepare("terminate");
}
```

Run section 3's player start block and section 4's pause proof blocks. Accept **QA reaction Action**
on the player. This fixture configures the generic child `parentDirective: cancel-parent`;
it does not patch child completion or move the Token back. GM proof:

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.dump || game.users.activeGM?.id !== game.user.id) throw new Error("Run on the active GM.");
  await qa.waitFor("movement.interrupted");
  await Promise.all([...qa.observations]);
  const result = qa.dump();
  console.assert(result.events.map(e => e.type).join() === "movement.started,movement.transition,movement.interrupted");
  console.assert(result.uniqueEventIds === 3 && result.progress.remainingTransitionCount === 1);
  console.assert(result.movement === qa.startBudget - 5 && result.reaction === 0 && result.effectIds.length === 1);
  console.assert(result.hosts[0].reactions[0].childStatus === "completed");
  console.assert(result.progress.status === "interrupted");
}
```

Player terminal position and authority proof:

```js
{
  const qa = globalThis.wpMovementReactionQA;
  if (!qa?.finished || game.user.isGM) throw new Error("Run on the initiating player after accepting termination.");
  const finished = await qa.finished;
  const position = qa.d.toObject(true);
  console.assert(finished === false && qa.d.movement.state === "stopped");
  console.assert(position.x === qa.route[0].x && position.y === qa.route[0].y);
  console.assert(qa.events.length === 0);
  console.log({terminated: !finished, paidPrefixPosition: position, unexecutedDestination: qa.route[1], playerEventCount: qa.events.length});
}
```

Retain the complete GM JSON for each case and any warnings/errors. On an unlinked Token, verify
the base world Actor value remains at `baseWorldBefore`. For Large hex, transition 0 must show
three fields at each endpoint, two left, two entered, one retained, and cost 5.

## 8. Cleanup

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
