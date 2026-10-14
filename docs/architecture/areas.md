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

## Using an Area Action in Foundry

An Action with `targeting: {type: "area"}` and an `area: {shape, size}` is placed on the canvas by
WildPath's own clicks, before its intent is declared (`module/applications/area-placement.mts`, called
from `Item.use()`):

- **Radial:** one click on a field. The field must be within the Action's `range` of the caster.
- **Cone and line:** one click on a corner of the caster's Token edge, then one click for the direction.

While the cursor moves, Foundry's grid highlight shows the fields the area would cover. A click that does
not advance the placement (off the Token's edge, out of range) only warns. Escape or right-click cancels,
and the Action is not used. Clicks go to the placement only, never to Foundry's Token selection.

The intent carries only the click points (`area.points`, at most two finite canvas points). The authority
recomputes the footprint from those points and the caster's own Token. It uses the same function as the
preview, `foundryAreaFootprint` (`module/adapters/foundry-v14-area-placement.mts`). Every Token whose
footprint touches a covered field is a target, the caster included. The client's targets are not
consulted. The pipeline then resolves those targets as usual. With several targets, each rolls its own
save.

Foundry 14.369 offset conventions matter here. Square offsets are `{i: row, j: column}`, and a square
vertex `(x, y)` is the top-left corner of offset `{i: x, j: y}`. A hex vertex is the one corner its
incident hexes share. Both are asked of the grid rather than assumed from a corner order (see
[foundry-tactical-grid-adapter.md](foundry-tactical-grid-adapter.md#field-and-vertex-identity)).

Live (two browsers, 14.369, 2026-10-14): Player1 placed each shape with real mouse clicks on a square
Scene and on a hex (odd-r) Scene. The layout was a caster, two goblins and a bystander.

- On both grids a 5-ft burst hit both goblins, and a 15-ft cone and a 30-ft line from the caster's edge
  hit only the goblin in their path.
- The preview showed exactly the fields that resolved: 9 squares or 7 hexes for the burst, 9 for the
  cone, and 6 for the line.
- An off-edge click only warned, and Escape cancelled without a card.
- The `wildpath.areas` Quench batch pins the same layout on Foundry's own grids.

Not yet: self-centered emanations, walls, `area.placement` policies other than these clicks, Regions
that stay on the canvas, and gridless Scenes (refused: "Areas need a square or hex grid").

## Persistent Areas

An area Action with `area.persistence` leaves a lasting area behind once it completes. The decisions
were made by the maintainer on 2026-10-14.

```js
area: {shape: "radial", size: {value: 10, unit: "ft"},
  persistence: {duration: {unit: "round", value: 10}, concentration: false, oncePerTurn: true,
    elevation: {bottom: 0, top: 0},
    triggers: [{on: ["area.entered", "turn.started"], action: { /* an ordinary ActionDefinition */ }}]}}
```

- **Storage.** A lasting area is a Foundry Region, V14's successor to templates. The rules live in
  `flags.wildpath.area` (schema 1): the covered fields, the caster, the vertical band, the triggers and
  the per-turn record. Foundry draws exactly those fields as a `grid` shape, visible to everyone.
  WildPath's fields, not Foundry's drawing, decide who is inside (`foundry-v14-persistent-areas.mts`).
- **Triggers.** Each trigger's `action` resolves through the authority, with the caster as source and
  the affected creature as its only target. Saves route to that creature's controller, and the result
  posts its own card. Triggers answer `area.entered`, `turn.started` or `turn.ended`.
- **Once per turn.** By default a creature is affected by one area at most once per combat turn, even if
  it both enters and starts its turn there. `oncePerTurn: false` turns this off. Outside combat there
  is no limit.
- **Entering.** Being moved into an area counts as entering, and so does an aura moving over a creature.
- **Elevation.** The `elevation` band is relative to the floor of the caster's Level. A missing bound is
  open, so a ground hazard is `{bottom: 0, top: 0}`. A creature is inside only if its height overlaps
  the band. Several areas can share a field, for example one on the ground and one in the air, and each
  one acts independently.
- **Duration.** It is counted in rounds.

Live (two browsers, 14.369, 2026-10-14): Player1 cast Burning Ground (2 fire on casting, then 4 fire on
`area.entered` or `turn.started`) on a goblin in combat. The goblin took 2, and a 9-field Region
appeared for both clients. When the goblin's turn started it took 4, and a "Flames" card posted.

Still to come: stopping a voluntary move on entry, auras that move with their caster, expiry by
duration and concentration, and falling through an area (vertical movement is not modelled yet).

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
