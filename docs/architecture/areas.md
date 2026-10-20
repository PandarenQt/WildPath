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

**Cube (2026-10-15, G6).** A Cube (or a square) is a block of fields on a square grid, its side its size
(`createCubeFootprint`). It takes one click:
- Cast at a point, it is centered on the clicked field, and in range when any of its fields is.
- "Originating from you" (a `self` range: Thunderwave), it is the block touching the caster's Token, not covering
  it, whose center is nearest the click (`cubeCornersAgainst`).

A Cube needs a square grid; elsewhere its placement is refused.

**Wall (2026-10-15, G6).** A wall on a square grid takes two clicks. It starts on the first field, which must be in
range, and runs toward the second for its whole length (`createWallFootprint`), a field a step at any angle. A panel
wall (Wall of Stone, ten 10-ft panels) is its panels end to end. Shortcut: in one straight line.

Live (GM, 14.369): a 9th-level wizard's SRD Wall of Fire, started at QA Saver and run east, covered 12 fields. QA Saver
saved (9 of 19 fire) and QA Failer failed (19). What the wall does afterwards (entering it, ending a turn near it)
stays manual.

**Range and areas.** An area Action's range limits its placement (its point, its Cube), not the creatures it covers.
The pipeline's range check skips area Actions. Before this, every area with a `self` range (a cone, a Cube, an
emanation from its caster) refused the creatures it reached.

Live (two browsers, 14.369): Player1's SRD Thunderwave, clicked east of QA Caster, covered the 3x3 block against its
east side. It caught QA Ally (failed) and the Bandit Captain (saved, half of 10).

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
- **Enemies only (2026-10-18).** `persistence.affects: "enemies"` makes the triggers skip the caster and every
  creature of its disposition (Spirit Guardians).
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

### Moving a lasting area (2026-10-18)

- **By its Action.** An Action with `moveArea: {of, distance}` moves its creature's lasting area left by the Action
  `of` (its definition id), as Moonbeam's Magic action does.
  - The player places the new spot with the area's own shape and size. The authority refuses one more than `distance`
    feet from the old center, an attached area (it moves with its creature), or no area at all.
  - After the Action, the Region's grid cells and `flags.wildpath.area.fields` become the new footprint.
- **By the GM.** Dragging or redrawing a lasting area's Region (its grid shape changes) rebuilds its fields from the
  new cells, on the active GM's client.
- **Either way:** each creature newly inside is entered ("when the Cylinder moves into its space"), once per turn.
  The triggers go with the area unchanged, so an upcast Moonbeam keeps its 3d10.

Live (two browsers, 14.369): QA Caster's 3rd-level Moonbeam, moved by "Moonbeam (Move)" onto QA Wizard and QA
Fighter: each saved against 3d10 (the Fighter failed and took 14). A GM update of the Region's cells moved it onto
three more creatures, and each saved against 3d10.

## Teleport (2026-10-19)

`teleport: {distance}` moves the Action's own creature up to `distance` feet to a space it chooses (Misty Step's 30,
Dimension Door's 500).
- **Choosing.** The player clicks where the Token lands (`placeFoundryTeleport`); the highlight is its footprint
  there, red when the space is refused.
- **Checked twice.** The client and the authority run the same `teleportDestination`. A destination is refused when:
  - it is farther than `distance`, center to center;
  - it is off the Scene;
  - another Token is on it.
- **Moving.** Once the Action completes, the active GM moves the Token with V14's Blink (`movementKind: "teleport"`):
  no movement spent, no path walked, no Opportunity Attack.
- **Converted:** dnd5e teleport activities with a distance in feet. SRD: Misty Step, Dimension Door, Tree Stride, the
  Cape of the Mountebank, and the Archmage's, Mage's, Cloud Giant's, Lich's and Spirit Naga's casts. Teleport, Plane
  Shift and Word of Recall have no distance and stay by hand.
- shortcut: Dimension Door's willing passenger is moved by hand; Tree Stride's trees are not checked.
- The Builder edits it ("Does it teleport its user?").

Live (two browsers, 14.369): Player1's QA Caster, beside the Bandit Captain with no movement left, cast the SRD Misty
Step. A click 35 feet away was refused ("That space is too far"); one 25 feet away moved the Token there. The Bonus
Action and a 2nd-level slot were spent, movement was untouched, and the Captain was offered no Opportunity Attack.

## Forced Movement (2026-10-15)

An Action with `push: {distance, toward?, maxSize?, on?}` moves creatures when it completes
(`module/adapters/foundry-v14-forced-movement.mts`). Thunderwave is `{distance: 10}`, and the Merrow's Harpoon is
`{distance: 15, toward: true, maxSize: "large"}`.

- **Who moves.** The creatures that fail its save, or with `on: "success"` those that succeed (the Bulette's Deadly
  Leap). An Action with no save moves the creatures its attack hits.
  - `maxSize` skips bigger creatures. The size is read from the Token: 1 field is Medium or smaller, 2 Large, 3 Huge.
  - A Legendary Resistance that turns a failure into a success stops the push.
- **Where.** The active GM moves each creature a field at a time along the line from the source's center through
  the creature's: away from it, or toward it for a pull. On a square grid each step is one field on the longer axis,
  so a diagonal push crosses diagonals.
  - The creature stops before a wall, another creature's field, or the Scene's edge.
  - When several are pushed, the farthest moves first; when pulled, the nearest.
- **As forced movement.** The Token update carries `movementKind: "forced"`. It spends no Speed and provokes no
  Opportunity Attack (2024). A lasting area the creature is pushed into still sees it enter.
- Shortcuts:
  - "up to N feet" always pushes the whole distance;
  - walls are tested through the Token's placeable, so only when the GM is viewing that Scene;
  - "Small or smaller" cannot be told from Medium by Token size;
  - a creature inside its source's own space (an Air Elemental's Whirlwind) has no direction and stays.

Live (two browsers, 14.369): Player1 cast the SRD Thunderwave (a Cube against QA Caster's east side) over QA Failer,
QA Ally and the Bandit Captain. QA Failer failed and went 10 feet diagonally away. The Bandit Captain failed and
stopped after 5 feet at a wall. QA Ally saved and stayed. Neither push offered QA Caster an Opportunity Attack.
Player1's "Shove: Push" on QA Failer moved it 5 feet on a failed save; on a success it stayed.

## Elevation (2026-10-15)

On a grid, distance is 3D (2024): a creature fills grid-sized cubes, from its Token's elevation up its `depth` (in
grid units). Each Token footprint carries them (`levels: {bottom, top}`, `footprintLevels`), and `footprintDistance`
is the larger of the fields across and the cubes between. A creature flying 10 feet up beside you is 10 feet away.
- **What counts it.** Range, reach, "within 5 feet" (Prone, Pack Tactics, Sneak Attack's ally), and auras. A
  footprint without levels (a movement path's) measures flat, as before.
- **Areas** (`areaHeights`, foundry-v14-area-placement.mts) reach a band of heights, and cover the creatures in it:
  - a Sphere its radius above and below its point; a Cylinder its `area.height` up from it; a circle (height 0)
    the creatures on it; a Cube its side up from its base;
  - from the caster, level with it: a cone half its length above and below, a line the caster's own height, an
    emanation its size around the caster, a Cube "originating from you" up from the caster's feet;
  - a point is as high as the creature standing on it, else the ground. Aiming a Fireball at a flying creature's
    field centers it on that creature.
  - Creatures at other elevations are no longer left out of every area (`strictElevation: false`).
- Shortcuts: cones and lines are aimed level; Opportunity Attacks measure flat; lasting areas keep their own
  elevation band (open by default).
- **High ground (Baldur's Gate 3, 2026-10-15).** With the `highGround` world setting on (off by default), an attack
  from 8 feet or more above its target gets +2, and from 8 feet or more below −2 (`highGroundBonus`). The runtime
  sends it per target (`attack.bonusByTarget`, by Token); the attack stage makes it an `attack-bonus` override, added
  to that target's total only, never to the natural die. The bar's odds include it. Shortcut: reaction attacks
  (Opportunity Attacks) do not get it, and the card shows the roll without it.
  Live (GM browser): Fire Bolt's odds against the Bandit Captain were +4 level, +6 from 10 feet above and +2 from 20
  feet below.

**Falling (2024).** A creature above the floor of its Level that gets Prone, Grappled, Restrained, Paralyzed,
Petrified, Stunned or Unconscious falls, unless it can hover (`GrantMovement` `hover: true`; converted from dnd5e's
hover). The active GM drops its Token to the floor as forced movement and resolves "Falling" as an authority Action:
1d6 Bludgeoning per full 10 feet (20d6 at most), and Prone unless it took no damage (`foundry-v14-falling.mts`; the effect's
`whenDamaged`, read in the effect stage from the Action's planned damage). Live (2026-10-20): QA Ally, Grappled 30 ft up,
fell; with Bludgeoning immunity it took nothing and stayed standing, without it took 9 and landed Prone.
- Shortcuts: a Levitate-like effect that holds a creature up is not known, so it falls too; there is no ledge or pit to fall from, only elevation above the floor.

Live (GM browser, 14.369): QA Failer 30 feet up, knocked Prone, dropped to the floor with a "Falling" card of 3d6 (7).
The SRD Air Elemental (fly 90, hover) knocked Prone 30 feet up stayed there unharmed.

Live (two browsers, 14.369): the Bandit Captain 10 feet up beside QA Caster was out of Player1's Unarmed Strike reach
("out of range (15 ft away)" at 15 feet up), and in reach at 5 feet up. Player1's Fireball at the ground hit QA Saver
and not QA Failer flying 30 feet up; aimed at QA Failer's field, it covered only QA Failer.

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
