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

Deferred:

- movement-event/interruption composition.
- movement interruption, events, opportunity reactions, auras, hazards, and Regions.
- terrain, squeezing, ally/enemy occupancy, and mode-specific collision rules beyond supplied
  policy functions.
- movement undo/refund and pause/resume accounting.

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
-> active-GM completion observation and budget commit
```

`TokenDocument#getCompleteMovementPath()` expands the direct path between supplied waypoints; it
does not infer the Token's current position as an implicit first waypoint. The adapter therefore
supplies `[authoritative origin, ...requested waypoints]` to Foundry before conversion. Supplying only
`[destination]` would leave a multi-square segment unexpanded and correctly fail WildPath adjacency.

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
adapter waits for `TokenMovementOperation.finished` to resolve true before building the plain
`MovementCompletion`.

Because `moveToken` fires on all clients, only the client that owns the approval record as the
selected authority commits. In normal active-GM play this is the active GM. The player observes the
same hook but ignores completion because the selected authority is remote. The active GM correlates
the observed completion to the approval record by movement id plus Scene/Token identity, uses the
hook's updated Token document as the local authoritative observation, reads the underlying source
state with `TokenDocument#toObject(true)`, evaluates the full Token footprint at that explicit source
position through `TokenDocument#getOccupiedGridSpaceOffsets(position)`, confirms that anchor matches
the approved route destination, and only then commits the approved
`economy.movement` spend through `ResourceResolver` and `DocumentPersistencePort`. Duplicate
observations for the same movement id are idempotent and do not spend twice, including concurrent
completion delivery. The existing `MOVEMENT_COMMIT` socket path remains for explicit fallback/manual
delivery and retains sender binding: client payload `sourceUserId` is treated as a claim and must
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

These Node regressions do not establish live production closure. Manual Foundry V14 QA must still
verify Large hex one-step movement (`30 -> 25`), Large hex two-step movement (`30 -> 20`), and Large
square one-step movement (`30 -> 25`).
