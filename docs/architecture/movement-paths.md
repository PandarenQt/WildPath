# Topology-Aware Movement Paths

WildPath movement is ordered mechanical travel through the TacticalGrid, not endpoint distance.
This foundation is pure domain code and does not move Foundry Tokens.

## Scope

Implemented:

- `MovementPath` plain-data route contract.
- complete `TokenGridFootprint` reconstruction at every anchor.
- square and hex ordered adjacency validation.
- per-transition cost breakdown with a runtime policy seam.
- occupancy and transition legality policy seams.
- integration with the existing movement budget helpers.
- distinct route validity, route cost, and affordability results.
- Foundry Token movement vertical slice implemented through the V14 TokenDocument pre-movement
  lifecycle, `moveToken` observation, active-GM authority, and post-movement budget commit.
- Foundry Token footprint resize operations are distinguished from locomotion and validated as
  zero-spend footprint transitions.
- generic AutomationEvents for verified completed routes, with full-footprint transitions and
  a pure progress model that distinguishes actual prefixes from approved routes.
- production checkpoint/pause/stop observation, completed-prefix payment, and same-subpath
  continuation correlation; live interruption QA remains outstanding.

Deferred:

- movement-triggered reaction windows.
- opportunity reactions, auras, hazards, and Regions.
- terrain, squeezing, ally/enemy occupancy, and mode-specific collision rules beyond supplied
  policy functions.
- movement undo/refund, new-subpath continuation, and durable handoff/reload recovery.

## Canonical Path

`module/helpers/movement-paths.mjs` represents a route as serializable data:

```js
{
  type: "MovementPath",
  anchorConvention: "anchors-include-origin",
  topology: "square",
  size: "medium",
  origin: {x: 0, y: 0},
  anchors: [{x: 0, y: 0}, {x: 1, y: 0}, {x: 2, y: 0}],
  footprintDefinition: {size: "medium", topology: "square", offsets: [{x: 0, y: 0}]},
  movementKind: "voluntary",
  movementMode: "walk",
  metadata: {}
}
```

The anchor convention is explicit: `anchors` includes the origin. `[A, B, C]` means:

```text
A -> B -> C
```

with two transitions. `[A]` is a valid zero-cost route. Repeated consecutive anchors such as
`A -> A` are invalid.

The path stores anchors plus the footprint definition instead of storing every full footprint.
Callers can reconstruct the complete footprint for any anchor with `reconstructMovementFootprint()`
or receive all reconstructed footprints from `evaluateMovementPath()`.

## Full-Footprint Flow

Movement legality uses the complete moving creature footprint:

```text
anchor
-> footprintDefinition
-> TokenGridFootprint
-> occupancy policy
-> transition policy
-> next anchor
```

The anchor is only the compact coordinate needed to reconstruct the full footprint. A Large square
creature shifting one field still costs one anchor transition, but its full 2x2 footprint is checked
for blocked or occupied fields.

## Cost Flow

Movement cost is route-based:

```text
ordered transition
-> step-cost policy
-> transition breakdown
-> total route cost
-> existing movement budget
-> affordability
```

The evaluator does not use `fieldDistance(origin, destination)` or `footprintDistance(origin,
destination)` for cost. Those remain range/reach metrics. Detours therefore cost the actual ordered
route, not the direct endpoint metric.

Default costs:

- field measurement: one field per adjacent transition.
- distance measurement: one grid distance per adjacent transition.
- teleport: zero normal movement budget cost.

Callers may pass a `stepCostPolicy` to express terrain or mode costs. The policy is a runtime
dependency and is not stored in the path or result. Invalid policy costs such as negative, `NaN`, or
infinite values produce structured failures.

## Valid, Cost, Affordable

The result separates three questions:

- `valid`: can the ordered route mechanically be traversed?
- `cost`: how much the route costs under the current measurement mode.
- `affordable`: whether the supplied or derived movement budget can pay the cost.

A result can therefore say:

```text
valid = true
cost = 35 ft
affordable = false
budget = 30 ft
```

This allows preview and HUD layers to explain a valid but unaffordable route without recalculating
movement.

## Movement Kinds

`movementKind` stays separate from `movementMode`.

- `voluntary`: validates ordered adjacency and spends ordinary movement budget when affordable.
- `forced`: validates route topology and policy seams, but does not spend ordinary movement budget.
- `teleport`: permits non-adjacent destination anchors, does not spend ordinary movement budget, and
  still reconstructs/validates destination footprints.

`movementMode` remains an identity such as `walk`, `fly`, `swim`, `climb`, `burrow`, or `teleport`.
The generic path helper does not hardcode terrain or medium-specific rules for those modes.

Foundry Token operation semantics are separate from these domain movement kinds. A V14 Token update
can be a translation, a footprint resize, or a combined translation plus footprint transition. The
Foundry adapter records that infrastructure classification in MovementIntent metadata; it does not
add `resize` as a WildPath `movementKind`.

## Policy Seams

`evaluateMovementPath()` accepts pure runtime policies:

- `occupancyPolicy`: validates a reconstructed footprint at an anchor.
- `transitionPolicy`: validates a movement step from one footprint to the next.
- `stepCostPolicy`: returns the cost of a transition.

These policies can later express blocked fields, occupied fields, Tiny sharing, walls, squeezing,
terrain, or movement-mode restrictions. They are not persisted inside `MovementPath`, and the
returned result contains only plain data.

## Budget Integration

The existing movement budget helper remains authoritative:

```text
createMovementCapability()
-> deriveMovementBudget()
-> evaluateMovementPath()
-> measureMovementPath()
-> spendMovementBudget()
```

The path layer produces ordered route cost and delegates budget semantics to `movement.mjs`. It does
not introduce `movementUsed`, `remainingMovement`, `movementPoints`, or any duplicate mutable
movement state.

## Foundry Token Movement Vertical Slice

Normal Foundry Token movement now enters WildPath at
`WildPathTokenDocument#_preUpdateMovement()`. Foundry has already determined the final movement
waypoints at that lifecycle point, so WildPath treats the operation as approve/reject only.

The runtime flow is:

```text
TokenDocument#_preUpdateMovement
-> build plain MovementIntent
-> active-GM authority over the existing system.wildpath transport
-> authoritative Scene/Token/Actor reconstruction
-> TokenDocument#toObject(true) source state and full origin footprint validation
-> prepend the authoritative Token origin to the requested Foundry waypoints
-> TokenDocument#getCompleteMovementPath()
-> merge each Foundry waypoint with the translation origin dimensions
-> FoundryV14TacticalGridAdapter#tokenToFootprint(token, {position, size})
-> canonical TokenGridFootprint anchor
-> MovementPath anchors including origin
-> evaluateMovementPath()
-> approve or reject
-> Foundry applies the Token update
-> moveToken hook after the update workflow concludes
-> await TokenMovementOperation.finished === true
-> active-GM source footprint and observed route verification
-> reconcile started/transition/completed AutomationEvents
-> budget commit
```

`TokenDocument#getCompleteMovementPath()` expands the direct path between supplied waypoints; it
does not infer the Token's current position as an implicit first waypoint. The adapter therefore
supplies `[authoritative origin, ...requested waypoints]` to Foundry before conversion. Supplying only
`[destination]` would leave a multi-square segment unexpanded and correctly fail WildPath adjacency.
Explicit teleport operations skip this expansion: their supplied endpoints are discontinuous jumps,
and intermediate traversed fields must not be invented.

The MovementIntent may carry Foundry x/y waypoint data because that is the client proposal. That
data stops at `module/adapters/foundry-v14-movement-adapter.mjs`. The resulting `MovementPath`
contains only topology anchors, footprint definition, movement kind/mode, and plain metadata.
MovementIntent also preserves Token footprint state supplied by Foundry (`width`, `height`,
`depth`, and `shape`) on origins, destinations, and relevant waypoints. That state is used for
stale-state and completion verification; pixel coordinates still do not enter `MovementPath`.

These representations have distinct responsibilities:

| Representation | Responsibility |
| --- | --- |
| Foundry Token `x/y` | Infrastructure placement state |
| `TokenGridFootprint` | Tactical occupied-space state |
| `MovementPath` anchor | Canonical tactical route state |

Locomotion must never assume a multi-field Token is a point. Neither `pointToField(intent.origin)`
nor `pointToField(waypoint)` necessarily identifies its full-footprint anchor. One-field Tokens
previously hid this mismatch because the two fields coincided. Every Token now uses the same path:

```text
Foundry waypoint
-> complete Token spatial state
-> TokenGridFootprint
-> canonical anchor
-> MovementPath
```

`tokenFootprintAtMovementState()` is the shared adapter helper for translation origins, waypoints,
resize endpoints, and completion verification. Pure translation merges each waypoint with
the authoritative origin state, preserving `elevation`, `width`, `height`, `depth`, and `shape` when
omitted. An intermediate `{x, y}` waypoint cannot fall back to a Medium footprint. Explicit
dimension changes in completed translation waypoints are rejected as `UNSUPPORTED_TOKEN_OPERATION`;
mid-route resizing remains outside this contract. Size selection and occupied-space adaptation
reuse the existing provider and TacticalGrid adapter without orientation or size-specific movement
geometry.

Large square footprints remain four fields, Large hex footprints three, and Huge hex footprints
seven. Occupied field count affects spatial legality, never the locomotion cost multiplier. On a
5-ft grid, one adjacent anchor transition costs 5 ft (`30 -> 25`) and two cost 10 ft (`30 -> 20`).

Authority never trusts the client origin, route legality, affordability, or cost. The active GM
re-resolves the current Scene, Token, Token Actor, Token anchor/footprint, movement resource, and
grid scale before evaluating. It reconstructs the client origin and authoritative source origin as
full footprints, comparing topology, canonical anchor, canonical occupied-field sets, elevation,
width, height, depth, and shape. Missing client dimensions that are present in the source also fail
validation. Different pixel coordinates representing identical tactical state remain valid; stale
position or dimensions return `ORIGIN_MISMATCH` before route evaluation or spending. Rejections
carry plain client/authority states, anchors, field keys, and dimension mismatches through the
approval response for diagnostics. An unavailable source read fails explicitly instead of falling
back to prepared Token state.

Movement route adjacency is not the same primitive as footprint connectivity. Square footprint
connectivity and boundaries continue to use edge-adjacent fields, while square movement steps use
the existing distance-adjacent field set so a one-square diagonal is a valid 5 ft step under the
default distance model. Hex movement still uses the six neighboring hexes.

Budget is not spent during approval. `TokenDocument#_onUpdateMovement()` is Foundry's protected
movement update post-processing method and is too early for WildPath's authoritative final-position
budget check. Normal movement accounting therefore starts from Foundry's `moveToken` hook, which V14
documents as firing after conclusion of the update workflow on all connected clients. The hook
adapter snapshots the source position before yielding. A checkpoint with passed and pending
waypoints proves a partial observation immediately; final completion still requires
`TokenMovementOperation.finished === true`. Public `pauseToken` and `stopToken` hooks snapshot
`document.movement` and require the corresponding `paused` or `stopped` state.
A correlated stopped state already present at `moveToken` entry is captured there too. A later
false `finished` result cannot reconstruct a stop from a newer `document.movement`; the stop hook
owns that observation's synchronous snapshot.

Because `moveToken` fires on all clients, only the client that owns the approval record as the
selected authority commits. In normal active-GM play this is the active GM. The player observes the
same hook but ignores completion because the selected authority is remote. The active GM correlates
the observed completion to the approval record by movement id plus Scene/Token identity, uses the
hook's updated Token document as the local authoritative observation, reads the underlying source
state with `TokenDocument#toObject(true)`, evaluates the full Token footprint at that explicit source
position through `TokenDocument#getOccupiedGridSpaceOffsets(position)`, confirms that anchor matches
the verified prefix destination, and only then commits the newly completed
`economy.movement` spend through `ResourceResolver` and `DocumentPersistencePort`. Duplicate
observations for the same route are serialized and do not spend twice, including concurrent
increasing prefixes. The existing `MOVEMENT_COMMIT` socket path may retry locally verified unpaid
cost; it cannot establish progress or pay an approved but unobserved route. It retains sender
binding: client payload `sourceUserId` is treated as a claim and must
match the envelope sender and the approved movement initiator before any document resolution or
persistence work occurs.

Source-position reads are used for origin authority as well as completion verification. Live V14 QA
showed that during `moveToken`, prepared `document.x/y` and zero-argument occupied-space queries may still
describe the pre-move position, while `document.toObject(true)` contains the persisted destination.
Ordinary TacticalGrid calls continue to use prepared Token state unless a caller provides an
explicit position.

Pure Token footprint resize follows the same Foundry lifecycle, but it does not become a
MovementPath. The adapter classifies a zero-cost V14 footprint change, such as a `config`
`displace` operation from 1x1 to 2x2, as a Foundry `resize` operation. The active GM verifies that
the authoritative Token source state still matches the proposed origin state, resolves the proposed
destination through the TacticalGrid adapter and the existing creature footprint provider, approves
with `consumesBudget: false`, and verifies the completed source state before marking the operation
committed. No `economy.movement` resource mutation is planned for pure resize, including when the
Actor has little or no movement remaining.

Combined translation plus footprint transition is represented distinctly as
`translation-resize`, but is not yet mechanically resolved. The current slice rejects that operation
with a structured unsupported-operation code rather than treating the resize as free movement or
charging the footprint change as travel.

Foundry's measured movement cost/distance/spaces are not used as WildPath mechanical cost in this
slice. They remain useful future diagnostics or terrain/cost inputs, but WildPath cost currently
comes from `evaluateMovementPath()` over the complete ordered anchors.

## Serialization And Boundaries

`MovementPath` and its evaluation result are JSON-round-trippable. They contain no Foundry
Documents, Tokens, Scenes, canvas coordinates, UI handles, sockets, or policy functions.

The Foundry movement adapter translates:

```text
Foundry Token movement proposal
-> complete Token spatial states
-> TacticalGrid TokenGridFootprints
-> canonical GridField anchors
-> MovementPath
-> authoritative WildPath validation/cost
-> active-GM approval
-> Foundry Token movement
-> active-GM movement-budget commit
```

The pure domain remains the mechanical authority for ordered path semantics.

## Movement Progress And Semantic Facts

`module/helpers/movement-events.mts` implements `MovementProgress`, `createMovementProgress()`,
`advanceMovementProgress()`, `completedMovementPrefix()`, `movementPaymentDelta()`, and
`diffMovementFootprints()` as pure TypeScript. Its tracked `.mjs`
output is emitted by `npm run build` for Foundry and Node; see [TypeScript migration](typescript-migration.md).
It uses `createAutomationEvent()` and the existing event/trigger contracts, with no separate event bus.

An approved evaluation creates pending progress and emits nothing. Progress stores the approved
path, ordered transitions and full footprints, completed transition count, actual footprint,
cumulative cost, source references, authority, and a status of `pending`, `moving`, `paused`,
`interrupted`, or `completed`. An observation explicitly identifies its completed prefix and must
supply that prefix's actual footprint. Only newly observed transitions generate facts. Stale or
duplicate prefixes do not replay events. Completion requires the entire approved route.

For approval `A -> B -> C -> D`, interruption after two steps yields only `A -> B` and `B -> C`
transition facts, then `movement.interrupted` with actual destination C, approved destination D,
completed cost, and suffix `C -> D`. It emits neither a C-to-D transition nor completion. Paused
progress may continue; interrupted/completed records are terminal. `resumable` is descriptive
interruption data for a future authorized continuation, not permission to rewrite a terminal record.
The pure model calculates the payment delta; the authority commits it through ResourceResolver.
It does not invoke Foundry pause/resume methods. A constrained stop at the last approved waypoint
may have an empty remaining suffix; without successful completion evidence it is still interrupted.

Each transition carries full before/after `TokenGridFootprint` endpoints and deterministic
`leftFields`, `enteredFields`, and `retainedFields`. Deltas use sorted unique topology-aware field
keys. Large square movement can leave two fields and enter two while costing one 5-ft transition;
Large hex movement retains its three-field footprint. Occupancy changes never multiply cost.

In production the GM reconstructs the observed operation's route using the same footprint-aware
adapter, compares its ordered anchors against approval, and verifies the saved destination's full
footprint. The approval retains `foundryOriginState` outside the domain path so completion uses the
same authoritative placement/dimensions even when the accepted client origin had different pixels
representing the same footprint. A matching destination alone cannot establish transition facts;
completion does not fall back to `movement.destination` when observed route waypoints are missing.
Route disagreement
returns `COMPLETION_ROUTE_MISMATCH`; no semantic batch or ordinary payment is generated by that
observation. Facts describe verified locomotion independently of payment success, so a later
payment retry does not emit them again. See [events and reactions](events-and-reactions.md) for
payloads and the public observer hook.

### Verified V14 Lifecycle And Production Interruption

Events are **retrospective** facts about a verified prefix. Checkpoint or pause observation emits
`movement.started` once and only newly completed `movement.transition` events. Pause is nonterminal
and emits no interrupted/completed event. Stop emits `movement.interrupted` once with the actual
destination, cost, and remaining suffix. A linked final completion emits only the remaining
transitions and `movement.completed`. Approval emits nothing. These informational events do not
open pre-step reaction windows or control Foundry movement.

Official V14 API references and the selected boundaries:

| API | Use / limitation |
| --- | --- |
| [TokenDocument](https://foundryvtt.com/api/v14/classes/foundry.documents.TokenDocument.html) | `_preUpdateMovement` approves/rejects the final route; `getCompleteMovementPath` expands explicit waypoints; `toObject(true)` and explicit occupied-space queries verify source footprints. |
| [moveToken](https://foundryvtt.com/api/v14/functions/hookEvents.moveToken.html) | Post-update observation on all clients; only selected authority reconciles facts. |
| [TokenMovementOperation](https://foundryvtt.com/api/v14/interfaces/foundry.documents.types.TokenMovementOperation.html) | `finished` confirms whole-chain completion. False/rejection/missing confirmation alone is ambiguous and proves no prefix. `chain` is an ordered array of prior IDs; `subpathId` and `split` identify continuation boundaries. |
| [TokenMovementSectionData](https://foundryvtt.com/api/v14/interfaces/foundry.documents.types.TokenMovementSectionData.html) | Ordered `passed` waypoints prove the current operation segment after update. `pending` waypoints remain plans. Foundry measured cost never replaces approved WildPath cost. |
| [pauseToken](https://foundryvtt.com/api/v14/functions/hookEvents.pauseToken.html), [stopToken](https://foundryvtt.com/api/v14/functions/hookEvents.stopToken.html), [TokenMovementData](https://foundryvtt.com/api/v14/interfaces/foundry.documents.types.TokenMovementData.html) | The document-only hooks obtain ID, chain, subpath, state, user, origin, and passed section from `document.movement`, then snapshot the source footprint synchronously. |
| [recordToken](https://foundryvtt.com/api/v14/functions/hookEvents.recordToken.html), [TokenMovementHistoryData](https://foundryvtt.com/api/v14/interfaces/foundry.documents.types.TokenMovementHistoryData.html) | History may be recorded or cleared; this notification alone is not proof of an individual completed tactical step. |

The official versioned API pages identify V14.365. Read-only inspection of the installed official
V14.367 `client/documents/token.mjs` resolved lifecycle ordering: each checkpoint commits its passed
section; pause retains pending; stop clears pending but retains the operation identity and passed
section; continuation submits a new update with a new ID and the prior ordered chain. This source
observation is not live WildPath QA. No private pause/stop/continuation implementation is invoked
or copied into WildPath. The public seams above remain the integration boundary.

The authority retains one root approval and a private operation-to-root index scoped by Scene and
Token. Each continuation must name the entire observed prior chain, retain the root subpath, and
have `split === false`. Its authoritative origin, full footprints, remaining route, Actor UUID,
movement kind/mode, and step costs must agree with the original suffix. The original measurement
mode remains fixed. Missing links, unobserved prior operations, changed subpaths, or a split fail
closed. Stopped/completed records cannot resume; a new independent move needs a new approval.

Each operation stores its starting transition index. The translated passed segment is matched at
that exact index, so loops such as `A -> B -> A -> B` retain all three transitions. Passed waypoint
movement/subpath IDs must agree with the operation. After validating identity and ordered route,
strictly older prefixes are ignored before comparing the observed source to that prefix's footprint:
a delayed historical callback may capture newer source data. No facts, payment, or debt retry occurs.
Same-count and advancing observations still require the actual full source footprint to equal
the approved footprint at that count; matching a final anchor or an unfiltered history entry is insufficient.
History recording/clearing is not observed: unrelated recorded or unrecorded history cannot prove
the current prefix. Malformed evidence returns a typed diagnostic without facts or payment.
Prefix mismatch diagnostics include lifecycle, operation/root IDs, chain/subpath, observed and
authoritative counts, observed anchors, and observed/expected/authoritative footprints as plain data.

Partial payment uses this invariant in the approved measurement mode:

```text
verified cumulative prefix budget cost - already committed prefix cost = new payment
```

The existing adapter converts that delta to the Actor resource amount (fields multiply by grid
distance). Forced movement/teleport have zero budget cost. A per-root serial queue coordinates
observations, continuation approval, and retries; increasing prefixes wait their turn rather than
being dropped as duplicates. Lower verified prefixes are ignored, with no refund or replay.
Progress and facts advance before observer delivery. Only successful persistence advances paid
cost/count. Failure retains the verified prefix and an explicit unpaid debt; a later observation or
sender-bound socket retry pays only that debt, without re-emitting facts. Observer exceptions do not
prevent payment. These records are session-local; authority handoff/reload does not reconstruct them.

`game.wildpath.movement.getMovementProgress({movementId, sceneRef, tokenRef})` returns a separate
plain snapshot: root movement ID, operation IDs, approved/completed/remaining transition counts,
actual destination/full footprint, status, cumulative movement cost, committed movement cost,
paid transition count, measurement mode, and payment failure. Scene/Token UUID strings may be used
as refs. Mutating this snapshot cannot change accounting. No new mutable record map is exposed.

Forced movement generates the same events with `movementKind: "forced"`, evaluated travel cost,
and zero ordinary budget cost. Teleport emits supplied jumps with `discontinuous: true` and endpoint
field deltas only. Pure resize retains `TokenFootprintTransition`, produces no movement progress or
locomotion events, and spends nothing. Combined translation/resize remains unsupported.

## Regression Coverage And Live QA

`test/foundry-token-movement-runtime.test.mjs` exercises the production Token lifecycle, serialized
player-to-active-GM intent, real movement/TacticalGrid adapters, source completion, and payment. The
hex contract fixture deliberately separates placement fields from occupied-space anchors and uses
odd-row offset/cube conversion. All six directions are covered from both row parities. It models
the documented occupied-space API contract, not Foundry's renderer or drag implementation.

Coverage includes Medium square/hex, Large square/hex, Huge hex, dimensionless intermediate
waypoints, stale origins/dimensions, source/prepared disagreement, duplicate completion, and
resize followed by movement on a synthetic Token Actor. Pure resize remains zero-cost and mixed
translation/resize remains unsupported.

The maintainer confirmed prerequisite Foundry V14 QA passed for Large hex one-step movement
(`30 -> 25`), Large hex two-step movement (`30 -> 20`), and Large square one-step movement
(`30 -> 25`) on baseline `17858525f060c097763bc782e95ecced08c88afc` before this milestone began.
The maintainer also confirmed the completed semantic observer on baseline `f47ef23034be2291d4ee25820041fb99891257da`:
Large hex two-step `30 -> 20`, started/transition 0/transition 1/completed, three-field footprints,
two left/two entered/one retained, unique IDs for new movement, and one player-to-GM event batch.
The maintainer also confirmed terminal interruption on `48b72f9ceacf9b1666bbd471c99a1fd3c53ae99c`:
Large hex stop after two of three transitions, movement `30 -> 20`, exactly started/transitions 0/1/
interrupted on the GM, no player events, and idempotent repeated stop. Pause/continuation accounting
also reached the correct `20 -> 15` and five-event history, but the player received a prefix warning
before resume. The diagnostic run on `a4c645e` subsequently captured matching moveToken/pauseToken
prefix-2 source footprints and a successful continuation to prefix 3 with no warning on either
client. Its event filter incorrectly compared normalized refs with raw UUIDs; its zero event count
was not valid evidence. The original failing observation was not captured.
Node regressions cover stopped prefixes, pause/linked
continuation, concurrent increasing observations, repeated anchors, field-mode conversion, invalid
evidence, payment/observer failure, synthetic Actors, and lost authority. Historical-prefix regressions
deterministically reproduced the exact warning before this repair, including delayed root delivery
after Large hex continuation. Same/new-prefix corruption, historical identity/route checks, unpaid
debt isolation, and normalized QA event filtering are covered. These regressions establish the
stale-validation defect; they do not identify the original uncaptured live callback. Final live QA
of the repair remains required before reaction composition.
Follow [the exact checkpoint console procedure](../development/movement-interruption-qa.md).
