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
- Foundry Token movement vertical slice implemented through the V14 TokenDocument movement
  lifecycle, active-GM authority, and post-movement budget commit.

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
-> prepend the authoritative Token origin to the requested Foundry waypoints
-> TokenDocument#getCompleteMovementPath()
-> FoundryV14TacticalGridAdapter point-to-field conversion
-> MovementPath anchors including origin
-> evaluateMovementPath()
-> approve or reject
```

`TokenDocument#getCompleteMovementPath()` expands the direct path between supplied waypoints; it
does not infer the Token's current position as an implicit first waypoint. The adapter therefore
supplies `[authoritative origin, ...requested waypoints]` to Foundry before conversion. Supplying only
`[destination]` would leave a multi-square segment unexpanded and correctly fail WildPath adjacency.

The MovementIntent may carry Foundry x/y waypoint data because that is the client proposal. That
data stops at `module/adapters/foundry-v14-movement-adapter.mjs`. The resulting `MovementPath`
contains only topology anchors, footprint definition, movement kind/mode, and plain metadata.

Authority never trusts the client origin, route legality, affordability, or cost. The active GM
re-resolves the current Scene, Token, Token Actor, Token anchor/footprint, movement resource, and
grid scale before evaluating. If the client-observed origin no longer matches the authoritative
Token anchor, the proposal is rejected.

Movement route adjacency is not the same primitive as footprint connectivity. Square footprint
connectivity and boundaries continue to use edge-adjacent fields, while square movement steps use
the existing distance-adjacent field set so a one-square diagonal is a valid 5 ft step under the
default distance model. Hex movement still uses the six neighboring hexes.

Budget is not spent during approval. `WildPathTokenDocument#_onUpdateMovement()` runs on connected
clients after the Foundry Token update lifecycle, and the active GM commits normal movement from its
own post-update observation after Foundry's `movement.finished` promise resolves true. That avoids
racing a player-sent completion message against the GM client's local Scene/Token update. The active
GM correlates the observed completion to the approval record by movement id plus Scene/Token
identity, confirms the authoritative Token's actual final anchor matches the approved route
destination, and only then commits the approved `economy.movement` spend through `ResourceResolver`
and `DocumentPersistencePort`. Duplicate completions for the same movement id are idempotent and do
not spend twice, including concurrent completion delivery. The existing `MOVEMENT_COMMIT` socket
path remains for explicit fallback/manual delivery and retains sender binding: client payload
`sourceUserId` is treated as a claim and must match the envelope sender and the approved movement
initiator before any document resolution or persistence work occurs.

Foundry's measured movement cost/distance/spaces are not used as WildPath mechanical cost in this
slice. They remain useful future diagnostics or terrain/cost inputs, but WildPath cost currently
comes from `evaluateMovementPath()` over the complete ordered anchors.

## Serialization And Boundaries

`MovementPath` and its evaluation result are JSON-round-trippable. They contain no Foundry
Documents, Tokens, Scenes, canvas coordinates, UI handles, sockets, or policy functions.

The Foundry movement adapter translates:

```text
Foundry Token movement proposal
-> GridField anchors
-> MovementPath
-> authoritative WildPath validation/cost
-> active-GM approval
-> Foundry Token movement
-> active-GM movement-budget commit
```

The pure domain remains the mechanical authority for ordered path semantics.
