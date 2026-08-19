# Areas and Grid-Native Footprints

Wild Path areas should resolve from structured area definitions into tactical grid footprints.
This document complements `docs/architecture/tactical-grid.md`.

## Area Definition vs Footprint

An `AreaDefinition` describes rule semantics:

- shape
- size/range
- placement policy
- target rules
- duration/persistence
- triggers, where applicable

A `GridFootprint` is the resolved set of tactical fields affected on a specific scene/grid.

The footprint is authoritative for targeting.

## Shapes

The initial area foundation should support:

- line
- cone
- radial area
- wall
- future emanation/aura/persistent hazard forms

Shapes should not own source eligibility or placement rules. A cone can originate from a creature
boundary, from a free vertex, or from another future policy without duplicating cone geometry.

The current pure helper is `module/helpers/tactical-areas.mjs`. It implements grid-native radial,
line, cone, and simple wall footprints using tactical fields rather than Euclidean overlap tests.
It is a domain helper; Foundry Scene/Grid adapters should feed it snapped fields and vertices later.

## Placement

Creature-originated lines and cones normally use:

```text
eligible source token boundary + direction
```

Radial areas may be self-centered, target-centered, token-centered, or placed at a chosen scene
origin according to the action definition.

Walls may use endpoint semantics rather than direction-only semantics.

For source-boundary lines and cones, the first click selects an eligible source Token boundary
vertex. The second click determines direction. Fixed-length effects use configured range for
length; the second click does not shorten them.

## Static Targeting

Static area targeting should use:

```text
GridFootprint fields
intersect TokenGridFootprint fields
-> affected targets
```

This preserves large-token behavior and avoids center-point targeting bugs.

The current pure bridge in `module/helpers/area-targeting.mjs` already consumes full
`TokenGridFootprint`-style occupied fields. Large, Huge, and Gargantuan targets must appear once in
the TargetSet when any occupied field overlaps an Area under the default any-overlap policy.

The `GridFootprint` produced for preview must be the same field set committed and later consumed by
targeting. Rendering should follow that field set rather than becoming a separate mechanical input.

## Placement To Targeting Bridge

`module/helpers/tactical-area-resolution.mjs` composes placed tactical areas with target
resolution. It accepts an already placed area, or performs source-boundary placement first, then
passes the exact resolved `GridFootprint` into `area-targeting.mjs`.

This bridge preserves:

- placement provenance
- selected source Token and Actor
- selected origin vertex
- preview/commit/resolution footprint identity
- physical target candidates
- eligibility and refinement output
- per-target contexts and overrides

Invalid source-boundary clicks reject before targeting runs.

## Persistent Areas

Persistent areas should store or deterministically reconstruct the same `GridFootprint` produced
by the tactical grid foundation. Do not introduce a separate persistent-area geometry model.

Lifecycle triggers such as enter, leave, start turn inside, and end turn inside belong to a later
AreaResolver/EventBus milestone.

## Auras and Emanations

Future auras and emanations should derive from token footprints and grid-native radial expansion.
They should not use independent Euclidean circle targeting.

## Gridless Limitation

Gridless scenes need a separate `GridlessGeometry` strategy. Until continuous geometry is designed,
area code should return structured limitations rather than faking tactical fields.

The pure helper currently returns `GRIDLESS_UNSUPPORTED` for gridded source-border operations on
gridless scenes.

## Implementation Gate

Implement this area foundation after:

- basic action definitions
- source Actor/Token references
- target resolution context
- attack/save/damage/effect foundations
- action economy resource foundation
- tactical grid geometry

Do not build polished area authoring UI before resolved footprints can execute mechanically.
