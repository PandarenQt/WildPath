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
  posts its own card. Triggers answer `area.entered`, `area.exited`, `turn.started` or `turn.ended`.
- **Once per turn.** By default a creature is affected by one area at most once per combat turn, even if
  it both enters and starts its turn there. `oncePerTurn: false` turns this off. Outside combat there
  is no limit.
- **Entering.** Being moved into an area counts as entering, and so does an aura moving over a creature.
- **A move into an area stops there.** If an area affects a creature during its own (voluntary) move, the
  move stops after the step that entered, and the rest of the move stays unspent (WildPath pays only the
  steps taken). The player is told why. This stops a player who forgot the hazard from being dragged
  through it. Forced movement is affected but not cut short. Entering an area that has already affected
  the creature this turn does not stop it.
  - A Scene with an entry hazard checkpoints every step of a drag.
  - Each step's approval records the areas that step enters (fields and band).
  - The after-step pause holds the Token while the area acts.
  - The stop is an ordinary interruption (`reason: "entered-area"`).
- **Leaving.** A step out of an area answers `area.exited`, and so does a creature an aura stops
  covering because its caster moved on. Leaving never holds or stops the mover: the creature is already
  on its way out. It applies before any area the same step enters. Once per turn is shared with the
  area's other triggers, so a creature the area already affected this turn is not affected again on
  leaving.
- **Auras.** An `emanation` surrounds its caster with no placement clicks, and its Region is attached to
  the caster's Token, so Foundry carries the drawn cells along. Who is inside is recomputed around the
  caster's current footprint. When the caster's step carries the aura over a creature, the aura has
  entered that creature. The caster's own move is never held by its own aura.
- **Empty areas.** An area that catches nobody still happens: it is paid and leaves its lasting area.
  `targeting.required` now defaults to false for `area`, and the target-dependent stages pass through
  when nobody was targeted.
- **Elevation.** The `elevation` band is relative to the floor of the caster's Level. A missing bound is
  open, so a ground hazard is `{bottom: 0, top: 0}`. A creature is inside only if its height overlaps
  the band. Several areas can share a field, for example one on the ground and one in the air, and each
  one acts independently.
- **Duration.** It is counted in rounds. An area runs out N rounds after the turn it was created on, and
  is deleted at that turn's start, before anyone in it is affected. Rounds pass only in its own combat.
- **Concentration.** A `concentration: true` area puts a "Concentrating: …" marker on its caster. The
  marker names the caster as its concentration source, so the existing concentration checks see the
  caster concentrating. A broken check ends every concentration area that caster sustains. The Region and
  its marker end together: removing either one removes the other (active GM).

Live (two browsers, 14.369, 2026-10-14): Player1 cast Burning Ground (2 fire on casting, then 4 fire on
`area.entered` or `turn.started`) on a goblin in combat.

- The goblin took 2, and a 9-field Region appeared for both clients.
- When the goblin's turn started it took 4, and a "Flames" card posted.
- Player1 then moved the caster on a four-step route through the fire. Flames hit on the second step
  (30→26), and the Token stopped there. Only those two steps were paid (30→20 ft), and the player saw "You
  stopped on entering Burning Ground. Your remaining movement is kept."
- Stepping out and back in on the same turn did nothing more.
- Shortened to 1 round, Burning Ground vanished at the start of round 2, before the caster standing in it
  was affected.
- A goblin's 50-damage blow broke the caster's concentration on Holy Ground: the check rolled 2 against
  DC 25. The Region and the caster's marker were removed, and the unrelated aura stayed.
- The caster backed off and cast a 5-ft Guardian Aura where nobody stood. It still completed, leaving the
  8 cells around the caster. The caster then stepped next to the goblin. Foundry moved the aura's cells
  with the caster, and the aura entering the goblin hit it for 3 ("Radiance"). The caster's move was not
  held.

Live (two browsers, 14.369): Player1's creature stood in a one-field Clinging Mire (3 acid on
`area.exited`) and made a two-field native move out. The mire hit on the first step (10→7, with a card),
and the move went on to its end (30→20 ft) without stopping.

Not yet: the staged (programmatic) movement path, falling through an area (vertical movement is not
modelled), and hidden areas such as traps.

**Light (2026-10-15).** `persistence.light: {bright, dim, sunlight, darkness, dispels, spellLevel}` (radii in the
Scene's units):
- **Placement:** the area sheds light from its center as an ambient light, `flags.wildpath.areaRegion` naming its
  Region. The Region keeps the light's id (`flags.wildpath.area.lightId`), and deleting the Region deletes the light.
- **Darkness:** `darkness: true` makes it a darkness source (`negative`).
- **Attached areas:** an attached area (an emanation, or one cast on an object) uses its Token's own light instead,
  so the light moves with the Token. The Token's own light is kept in `flags.wildpath.area.lightToken` and restored
  when the area ends.
- **Cast on an object:** `persistence.onObject: <choice id>` names a yes/no configuration choice. When it is chosen,
  the area surrounds the Token at its center and follows it (`anchorTokenId`, and the Region's attachment).
- **Dispelling:** `dispels: N` ends each overlapping area of the opposite kind, light against darkness, cast at level N
  or lower. The cast level is `flags.wildpath.area.castLevel`, from the spell slot chosen, else `spellLevel`.
- **Converted spells:**
  - The 2024 Daylight is a 60-ft radial area for 600 rounds: `{bright: 60, dim: 120, sunlight: true, dispels: 3}`
    (rule-elements.md, "Sunlight").
  - Darkness is a 15-ft radial area for 100 rounds, with concentration: `{bright: 15, darkness: true, dispels: 2}`.
  - Both have the "Cast on an object" choice.

Live (two browsers, 14.369):
- Player1 cast Darkness (2nd level), then Daylight "on an object" at a Lantern Token inside it.
- The Darkness, its darkness light and its concentration marker were gone. The Daylight Region was attached to the
  Lantern, and the Lantern carried 60/120 sunlight.
- When the GM moved the Lantern, the Region moved with it. Deleting the Daylight gave the Lantern its own light back.

Live (two browsers, 14.369): Player1 cast the SRD Daylight beside a Kobold Warrior, and its Region and sunlight light
appeared at the chosen point. The Kobold's Dagger showed 56% with Disadvantage. When the Region was deleted, the light
went with it, and the Dagger was back to 75%.

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
