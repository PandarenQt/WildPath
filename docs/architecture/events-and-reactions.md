# Automation Events, Triggers, and Reactions

Wild Path automation should expose important rules moments as semantic events, not as direct UI,
canvas, or chat callbacks.

The current pure foundation is `module/helpers/automation-events.mjs`.

## Event Shape

An automation event is plain data with:

- stable optional `id`
- semantic `type`
- `phase`
- source Actor/Token reference
- target Actor/Token references
- tags
- structured data payload
- metadata

The helper includes common action, targeting, attack, save, damage, healing, effect, movement,
area, turn, round, and rest event type constants. Foundry hooks and resolver internals can also
adapt other event type strings into the same shape when needed.

## Trigger Shape

A trigger definition declares:

- stable `id`
- kind (`automation` or `reaction`)
- event matcher
- optional structured predicate
- priority
- one-shot behavior
- payload
- owner/reaction references

Matching is deterministic. It checks event type, phase, source, target, and tags, then evaluates
the shared structured predicate helper. It returns dispatch plans; it does not execute effects.

RuleElements can contribute these trigger definitions. `ConditionTriggerResolver` currently consumes
condition-provided Trigger RuleElements for a narrow durability-change payload on semantic
turn-start events. That resolver plans mutations through the durability domain; trigger
registration itself still does not execute actions or mutate documents.

## Movement AutomationEvents

`module/helpers/movement-events.mts` creates the following events through `createAutomationEvent()`.
All use `phase: "information"`. They describe observed movement and cannot modify or cancel it.

Common `data` includes `movementId`, `movementKind`, `movementMode`, `sceneRef`, `actorRef`,
`tokenRef`, `measurementMode`, and `consumesBudget`. References are plain opaque entity refs;
Actor UUID refs preserve synthetic Token Actor identity. `source` identifies the moving Token with
Actor/Token IDs. Tags include `movement`, kind, and mode. `metadata.authority` identifies the
authoring user and authority mode; `metadata.observation` records the lifecycle source and timing.
Endpoints below have `{anchor, footprint}` with a complete `TokenGridFootprint`.

| Type | Event-specific `data` |
| --- | --- |
| `movement.started` | `origin`, `approvedDestination`, `approvedTransitionCount` |
| `movement.transition` | zero-based `transitionIndex`, `from`, `to`, `leftFields`, `enteredFields`, `retainedFields`, `stepCost`, `cumulativeCost`, `budgetCost`, `discontinuous` |
| `movement.completed` | `origin`, `actualDestination`, `completedTransitionCount`, `actualTotalCost`, `budgetCost` |
| `movement.interrupted` | `approvedDestination`, `actualDestination`, `completedTransitionCount`, `remainingTransitionCount`, `completedAnchors`, `remainingAnchors`, `completedCost`, `interruption: {reason, source, resumable}` |

`stepCost` retains the evaluator's amount, unit, and measurement mode. Cumulative/total costs are
numeric amounts in that measurement mode; `budgetCost` is the cumulative ordinary-budget amount,
zero for forced movement and teleport. A cost is not evidence of a successful resource transaction.
Field deltas describe occupancy, independently of cost. Teleports mark discontinuity and do not
invent fields between supplied endpoints. Resize emits no locomotion events.

IDs are deterministic: `movement:<encoded-scene-ref>:<encoded-token-ref>:<encoded-movement-id>:<suffix>`.
The suffix is `started`, `transition:<index>`, `completed`, or `interrupted`. Identical observations
produce identical IDs. The progress record suppresses repeated emission of already observed steps;
IDs also allow downstream consumers to deduplicate their own work.

The [movement progress model](movement-paths.md#movement-progress-and-semantic-facts) separates
approval from the completed prefix and supports pure interruption/pause tests. Production currently
emits started/transition/completed together after `moveToken`, `finished === true`, source-footprint
verification, and observed-route reconciliation. `metadata.observation` is:

```js
{source: "foundry-v14", lifecycle: "moveToken", timing: "completion-reconciled", finished: true}
```

These delayed informational events support future generic trigger predicates such as cumulative
travel or occupancy changes. They are not a pre-step interruption seam. Production interruption,
movement-triggered reaction windows, observer-relative reach predicates, and Area/Region consumers
are not implemented in this milestone.

### Foundry Observer Extension Point

The existing movement authority accepts a synchronous `onAutomationEvent(event)` observer. The
Foundry runtime bridges it to:

```js
Hooks.on("wildpath.automationEvent", event => {
  // Observe canonical AutomationEvent data; keep consequences in their normal resolvers.
});
```

This generic informational hook is dispatched with V14
[`Hooks.callAll`](https://foundryvtt.com/api/v14/classes/foundry.helpers.Hooks.html#callAll).
Listener return values cannot cancel locomotion, events, or payment. The authority stores plain
event snapshots and advanced progress before notification; it passes a separate copy to the
observer. Synchronous observer failures are recorded as `MOVEMENT_EVENT_DELIVERY_FAILED` with
event/movement IDs, without replaying events or preventing payment. Hook listeners must handle
their own asynchronous failures; delivery is not awaited and is not a durable retry queue.

Only the active GM authors events during active-GM play. The established permitted local fallback
may author them when no GM is active. Events are not broadcast through a new socket protocol.
The approval record's `semanticEvents` and `eventDeliveryErrors` are available for diagnostics.
Records and duplicate guards are session-local; this is not a durable exactly-once guarantee across
reloads or authority handoff. See [multiplayer authority](multiplayer-authority.md#movement-authority).

## Reaction Windows

Reaction triggers are normal triggers with a reaction payload and a payment requirement. The helper
uses the existing action-economy primitives to determine whether a reaction resource can pay the
window cost.

`collectReactionWindows()` returns:

- eligible reaction windows
- default payment options
- rejected windows with structured codes

It does not spend resources, prompt users, create chat cards, or mutate Foundry documents.
`module/resolvers/reaction-resolver.mjs` now wraps those windows into ordered candidates,
`reaction-choice` requests, and child-resolution provenance. The child Action and the existing
transaction boundary still own actual resource spending, effects, and document mutation.

## Resolver Boundary

Resolvers should emit automation events as part of normal resolution:

```text
ActionResolver
-> semantic AutomationEvent
-> trigger/reaction planning
-> transaction-controlled consequences
```

UI may display prompts for eligible reaction windows, but the rules for eligibility and payment
must remain in the resolver/domain layer.

The staged `ResolutionState` pipeline is the resume point for reaction windows.
`createReactionWindowStage()` can be inserted around meaningful semantic events, such as after
action declaration, after hit determination, and before damage commit. The default action pipeline
still needs those production timing insertions; the generic wait/choice/child-resolution contract
is now implemented and covered by Node tests.

## Future Consumers

This foundation is intended for:

- reactions such as "when hit" or "when a creature leaves reach"
- condition and feature triggers
- persistent area enter/leave/start-turn/end-turn hooks
- once-per-turn and once-per-round features
- action bar availability explanations
- combat carousel turn-start automation
- homebrew trigger builder output

The helper is not a socket protocol or multiplayer authority layer. It only plans what should be
offered or dispatched. Multiplayer routing reuses `docs/architecture/multiplayer-authority.md`;
Foundry adapters still need live runtime QA before reactions are considered manually verified.
