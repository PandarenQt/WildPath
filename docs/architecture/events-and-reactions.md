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
approval from verified and paid prefixes. Production checkpoint, pause, and stop observations use
the operation's passed section plus a source-footprint snapshot. Started is emitted once; transitions
are emitted only when their ordered prefix is newly verified. Pause remains nonterminal and adds no
terminal event. Stop emits interrupted once; a stopped record cannot resume. A correlated continuation
retains the root movement ID and transition indices. Final completion requires the entire approved
route and `finished === true`. Ordinary completed-movement `metadata.observation` remains:

```js
{source: "foundry-v14", lifecycle: "moveToken", timing: "completion-reconciled", finished: true}
```

Partial facts use `timing: "prefix-reconciled"`, their `moveToken`/`pauseToken`/`stopToken` lifecycle,
and `finished: false`; they also retain plain operation ID, ordered chain, subpath, split, and state
provenance. Linked completion retains those identifiers with completion timing. A stop before any
step emits an interrupted event with zero completed transitions, never an invented teleport jump.

These informational events support future generic trigger predicates such as cumulative travel or
occupancy changes. They do not interrupt a step themselves. Movement-triggered reaction windows
now use the explicit host described below. Observer-relative reach predicates and Area/Region
consumers remain deferred.

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

### Generic completed-event host

`module/resolvers/triggered-event-host.mts` composes a canonical AutomationEvent with an ordinary
ResolutionState and `createReactionWindowStage`. The host has no ActionDefinition, targeting,
resource payment, or transaction stage. `coordinator.resolveTriggeredEvent()` is an authority-local
application port, not a socket intent. It reuses chooser routing, response validation, child
traversal, RollProvider requests, and Action transaction commit. Children use the exported
`createActionReactionChildState` factory; nested Action reactions retain the existing Action
pipeline. Future turn, rest, or area events can use the same host without movement semantics.

The host re-enters the same ReactionResolver window after each child. ReactionResolver retains
handled candidates and consumed request IDs and applies its existing ordering. Movement stays
held until the entire window closes or a parent-cancel directive terminates it. Event IDs prevent
rehosting; accepted trigger IDs retain one-shot behavior across the same movement root.

The Foundry application extension point is `game.wildpath.reactionServices(context)`, returning
the existing `{reactions, targetActors}` services shape. It is runtime-only: document maps and
callbacks never enter ResolutionState or sockets. `reactions.triggers` must enumerate the full
registered TriggerDefinitions when called without an event during preparation/approval; event
filtering belongs in TriggerDefinition matchers and Predicate. It can be an array or a function
returning that array. `resourcesByActor` can read current resources through a function;
`actorSystemsByActor` supplies plain reactor system snapshots, or a lookup function returning a
current plain snapshot. Foundry providers obtain these with `foundryActorSystemSnapshot(actor)`
from `module/adapters/foundry-v14-actor-system-adapter.mts`, which serializes the actual Actor's
source data, validates it, and detaches it. Pass `token.actor` for synthetic Actors; never replace
it with the base world Actor. Keep live documents in `targetActors` or
`reactions.actorDocumentsByActor`, separately from the plain system map. The staged domain does
not serialize Foundry documents or DataModels; its plain-data validator continues to reject them.
See [ResolutionState](resolution-state.md#foundry-actor-system-snapshots). The default provider is empty.
No authored gameplay feature or new configuration UI is supplied by this milestone.

An approved operation snapshots its trigger definitions. Predicates, resource availability, and
child state are evaluated against the canonical verified event. Registration changes are adopted
at the next operation approval; they cannot retroactively subscribe to transitions in flight.
Planning does not run predicates or spend resources. Forced/teleport policy uses normal tags and
structured data predicates.

Reaction timing is **after verified A -> B, before B -> C**. The GM calls the host after successful
prefix payment. Failed payment keeps the hold; a successful verified-debt retry opens the event
once. The public `wildpath.automationEvent` hook stays synchronous and informational, with copy
delivery and observer-failure isolation. Listeners neither own the hold nor supply reaction
results. Final-transition windows have no suffix to hold or resume and retain completion semantics.

This composition has automated coverage. Live V14 QA is still required:
[complete GM/player procedure](../development/movement-reaction-qa.md).

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
