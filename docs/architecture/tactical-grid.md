# Tactical Grid Spatial Foundation

This document records the planned tactical-grid milestone for Wild Path. It is a foundational
rules-engine feature, but it should not be implemented until the lower-level action, resolution,
token-reference, roll, attack/save, damage/healing, effect, predicate, modifier, and action-economy
foundations exist.

## Governing Rule

For gridded Wild Path combat:

```text
The grid is the geometry.
```

Rules define semantic shape and size. The active tactical grid defines topology, adjacency,
direction, field footprint, and occupied fields.

Do not implement gridded AoE as Euclidean shapes snapped onto a grid:

```text
circle/triangle/rectangle -> overlap fields
```

Instead:

```text
AreaDefinition
-> TacticalGrid topology
-> grid-specific footprint algorithm
-> GridFootprint
-> Set<GridField>
```

The resulting `Set<GridField>` is the mechanical truth.

## Planned Abstractions

The spatial foundation should establish reusable domain abstractions similar to:

- `TacticalGrid`
- `GridField`
- `GridVertex`
- `GridDirection`
- `GridDistance`
- `GridFootprint`
- `GridPlacement`
- `TokenGridFootprint`

`GridField` identity must be stable for Sets, Maps, equality, targeting, movement, and debugging.
Do not use floating-point pixel coordinates as the tactical field identity.

`GridVertex` represents an actual tactical grid intersection. Square and hex grids have different
incident-field counts, so vertex behavior belongs in grid topology strategies.

## Grid Strategies

Square, hex, and gridless behavior should sit behind a common abstraction:

- `SquareGridGeometry`
- `HexGridGeometry`
- `GridlessGeometry`

Hex is a first-class use case, not an approximation layered on square behavior. Grid-specific
logic belongs inside grid adapters, not scattered through resolvers.

Foundry VTT V14 public grid APIs should be preferred for offsets, snapping, adjacency, vertices,
token occupancy, scene distance, and token dimensions once implementation begins. Do not invent
plausible Foundry APIs.

## Token Footprints and Boundaries

Spatial mechanics use tactical token occupancy:

```text
Token -> TokenGridFootprint -> Set<GridField>
```

This must support single-field and multi-field tokens on square and hex grids. The border of a
source creature means the tactical boundary of its occupied footprint, not token art, token center,
pixel bounding boxes, or a Euclidean collision circle.

Boundary vertices are vertices incident to both occupied and unoccupied fields, or to the usable
scene boundary. Internal vertices inside a multi-field creature are not valid line/cone origins.

## Eligible Action Origins

The tactical grid system must not decide ownership, companion, summon, or control rules. It should
consume eligible source tokens from a separate origin-source resolver.

Conceptually:

```text
ActionDefinition
-> OriginSourcePolicy
-> EligibleSourceResolver
-> eligible source tokens
-> TokenGridFootprint
-> boundary vertices
```

Permission/control and rules eligibility are separate concepts. A user may control a token that an
action cannot legally use as an origin.

Possible origin policies include:

- self
- eligible controlled
- self and eligible controlled
- future custom policies

These policies should be extensible rather than hardcoded around companions, summons, pets, or
similar feature categories.

## Source-Border Placement

For ordinary gridded creature-originated Lines and Cones:

```text
The Area origin is a valid tactical boundary vertex of the selected eligible source Token.
```

The first placement click chooses both source token and source boundary vertex. The second click
chooses direction. Configured range comes from the action, not from the second click distance.

This avoids large creatures losing effective breath/ray reach because the effect starts at token
center. A 30 ft line from a huge creature begins at the selected boundary vertex and remains 30 ft
long.

## Lines

Line placement is a two-click interaction:

```text
eligible source boundary vertex
-> direction vertex
-> fixed tactical steps from configured range
-> grid-native line footprint
```

For fixed-length lines, the second click determines direction only. It does not shorten the line.

## Cones

Cone placement uses the same source-boundary first click and direction second click. The cone
footprint is a grid-native widening pattern whose exact profile should be isolated behind a cone
footprint policy.

Square and hex cone shapes may differ. That is correct.

## Radial Areas

Radial areas are grid-native field expansions:

```text
20 ft radius on 5 ft grid -> 4 tactical layers
```

On square grids this produces a square-like footprint. On hex grids it follows hex topology. Do
not approximate a real-world circle for mechanical targeting.

Radial placement policy differs by action: self-centered, target-centered, token-centered, chosen
scene origin, and other policies should be separate from shape logic.

## Placement Policies

Shape and placement policy are separate concepts. Planned policies include:

- source boundary plus direction
- source boundary plus endpoint
- free vertex plus direction
- free vertex plus endpoint
- token centered
- target centered
- self

This allows a dragon breath cone and a magical cone from a remote point to reuse cone footprint
logic with different placement policies.

## Targeting

Targeting uses field intersection:

```text
Area GridFootprint
intersect Token occupied fields
-> affected target
```

Do not rely on token center points.

## Gridless Scenes

Gridless scenes do not provide tactical fields or grid vertices. `GridlessGeometry` should return
clear structured limitations for source-border placement until continuous-token-boundary geometry
is explicitly implemented.

Do not fake grid vertices in gridless scenes.

## Preview Invariant

The most important UI/resolution invariant is:

```text
preview footprint = committed footprint = resolved footprint
```

Rendering follows mechanics. Mechanics must not approximate a decorative visual template.

## Future Reuse

This milestone should later be reused by:

- movement paths
- reach
- opportunity attacks
- reaction triggers such as "leaves reach"
- auras
- emanations
- persistent hazards
- static area targeting

Do not create a second grid representation for movement or reactions later.

## Deferred Scope

This milestone should not implement:

- complete MovementEngine
- opportunity attacks
- complete ReactionEngine
- persistent area turn triggers
- aura lifecycle
- emanation lifecycle
- spell catalog
- finished homebrew Area Builder
- animation system
