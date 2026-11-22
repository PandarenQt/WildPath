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
saved (9 of 19 fire) and QA Failer failed (19). Afterwards it is a lasting area (lastingArea): entering it or ending a
turn in it deals 5d8 Fire with no save (2026-10-23; its unnamed dnd5e damage activity, which before repeated the Dexterity
save). shortcut: only the wall itself, not the 10 feet beside its burning side.

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

**Creatures of its user's choice** (`targeting: {type: "area", refinementPolicy: {requiresSelection: true}}`,
2026-11-21, Q105 (b)): "each creature of your choice in" the area is the general target refinement
([targeting.md](targeting.md#refinement)) over the creatures the authority found in it. The targeting stage asks the
Action's source controller (a `target-refinement` request, on every path that runs the Action: a click, a Trigger, a
drawn option's `useAction`) with every creature ticked, and its user unticks those it spares; `refineTargetSet` takes
only decisions about the authority's own candidates, so a forged id is refused. An area that caught no one asks no
one. A GM-hidden creature in the area of a player-owned creature's Action is not offered (`undisclosed` on its
candidate, which the chooser's payload leaves out) and so stays chosen. With `targeting.count` its user keeps at most
that many ("up to six creatures of your choice in": Slow). An `appliesTo: {from: "area"}` healing entry with no save
outcome or `share` may go to any creature the area covered, chosen or not, and comes even when none was chosen (Land's
Aid, Q77): only the healing stages run with no chosen target; attacks, saves, damage and effects do not. The converter
writes it on "each creature of your choice in a/an/the/that ..." and "... within N feet of" (Land's Aid, Sleep, Weird,
Intimidating Presence, Wave of Terror, Pipes of Haunting), with the count on "up to <n> creatures of your choice in";
a plain "each creature" stays every creature (Q74). Other uses: any homebrew blast or blessing that spares or picks
creatures in its area. Shortcut: a lasting area's later triggers (entering, a turn in it) affect every creature (or
`persistence.affects`), not asked again.

A dead creature (Foundry's Defeated status, `deadCreature` in `foundry-v14-creature-tokens.mts`) is an
object, not a creature, so no area takes it (live 9, 2026-11-20): not an instant area or its preview
(`foundryAreaTargetTokens`), a lasting area's trigger (`apply`), an Emanation's turn Trigger
(`tokensAround`), nor a turn Trigger's swallowed or condition-held creatures (`around.swallowed`,
`around.condition`). The same check keeps it from a reaction's pick (`redirectCandidates`) and out of the
way (occupancy). An Action aimed at it alone still reaches it (Revivify is single-target). Shortcut: no
area Action targets the dead, so there is no data key for one that would.

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
  posts its own card. Triggers answer `area.entered`, `area.exited`, `area.moved`, `area.rammed`, `turn.started` or
  `turn.ended`.
- **A ram (2026-11-21, Q33).** A carried area's `area.rammed` acts on each creature whose space its carrier ends a
  voluntary move in, and did not start it in, while the carrier has `occupancy.ram` (movement-paths.md "Creatures' spaces"): Flaming Sphere
  rolled into a creature makes that creature save against its spell, at its caster's DC and slot dice. The active GM
  runs it once, on `movement.completed` (`rammed`), and spends the carrier's movement, so it moves no more that turn.
  The rammed creature shares the sphere's space afterwards and still saves as its own turn ends beside it (Q99 (d)
  default). The converter reads "If you move the sphere into a creature's space, that creature makes the save"
  (and 2014's "ram the sphere into a creature") into the carried area's `area.rammed` trigger and the Roll's ram.
- **Enemies only (2026-10-18).** `persistence.affects: "enemies"` makes the triggers skip the caster and every
  creature of its disposition (Spirit Guardians).
- **Eligible creatures (2026-11-20, Q30).** A trigger's Action may carry `targeting.eligible` (targeting.md), judged
  with the area's caster as its source (`ineligibleTarget`): a creature it leaves out is skipped by that trigger, on every
  event, and spends none of its once per turn. The converter writes `seenBySource` on a carried area's triggers whose
  sentence says "a creature you can see" (2024 Conjure Animals, beside `affects: "enemies"` for "you can force": its
  enemies are asked directly, none spared).
- **Once per turn.** By default a creature is affected by one area at most once per combat turn, even if
  it both enters and starts its turn there. `oncePerTurn: false` turns this off. Outside combat there
  is no limit. The record is one per area and creature, shared by all its triggers.
  - A turn boundary counts in the turn it belongs to (2026-11-14). Foundry runs `_onEndTurn` after the Combat has
    advanced, so `turn.ended` takes the ended turn from Foundry's turn `context` ({round, turn}), which
    `WildPathCombat` passes to `onTurn`. A creature that enters Spirit Guardians or Moonbeam on its own turn is not
    hit again as that turn ends, and one moved back in on the next creature's turn is. Every record is keyed on the
    creature's own combat (`combatOf`), for a move as for a turn, not the one the GM's tracker shows.
  - Converted areas (2026-11-14). One repeat on entering and a turn boundary shares the area's record only when its
    text says "only once per turn" (Spirit Guardians, Moonbeam, Cloudkill, Wall of Thorns). Otherwise the converter makes
    them two triggers with `oncePerTurn: false`, the entering one `once: "turn"` when it says "the first time ... on a
    turn": a creature that enters Wall of Fire on its turn and ends it there takes the damage twice (Wall of Fire, Control
    Water's whirlpool, Web, Sleet Storm, Zone of Truth), and an entering with no such words comes every time (Grease).
  - A trigger of its own (2026-11-14). A trigger with `once: "turn"` keeps its own record (`applied.<tokenId>-<index>`,
    its index in `triggers`). It comes at most once a combat turn across its own events, whatever `oncePerTurn` says,
    and neither spends nor is spent by the area's shared record (Q28). Absent, a trigger shares the area's record.
    Outside combat it comes once while its creature stays in the area (the record `stay`, freed as it leaves), so a
    trigger answering entering and leaving gives one save for a crossing, and each new entering gives another
    (2026-11-22, wave D A16 review).
    ```js
    persistence: {oncePerTurn: false, triggers: [
      {on: ["area.entered", "turn.started"], once: "turn", action: {/* … */}}, // once a turn, entering or starting there
      {on: ["turn.ended"], action: {/* … */}}]}                                 // its turn end, every turn
    ```
  - Once in the area's life (2026-11-21). A trigger with `once: "area"` comes once while the area lasts, on whichever
    creatures its first run reaches, in or out of combat (`applied.area-<index>`).
  - Several turn boundaries (2026-11-13). A converted area whose two or more triggers answer only `turn.started` and
    `turn.ended` (Hunger of Hadar: Cold as a turn starts, an Acid save as it ends) gets `oncePerTurn: false`. Each
    boundary comes once a turn anyway, and sharing the record would let the start of a turn cancel its end. The
    converter's `areaRepeats` reads each passive save or damage from the sentence naming its save ability or damage
    type. Each repeat has its own damage ids, so a higher slot reaches only the repeat it scales. "The Cold or Acid
    damage (your choice) increases" becomes an option choice (`upcast-damage`), one option per damage type, the first
    preselected. A repeat that answers entering ("enters the area for the first time on a turn") gets `once: "turn"`,
    so it neither repeats nor cancels another boundary's repeat.
- **Its caster's turn (2026-11-21, wave D).** A trigger with `turnOf: "source"` answers `turn.started` and
  `turn.ended` of the area's caster (its `sourceTokenId`), not of the creatures in it, whose own turns it ignores; its
  other events are unchanged. Earthquake's save "at the end of each of your turns" is one, and a homebrew pulse ward
  ("at the end of each of your turns, every enemy in the zone takes 1d6 Radiant") another.
  ```js
  {on: ["turn.ended"], turnOf: "source", action: {/* … */}}                                   // every creature in it
  {on: ["turn.ended"], turnOf: "source", once: "area", action: {targeting: {type: "self"} /* … */}} // the area's own act, once
  ```
  - `onTurn` runs the areas the combatant stands in first, then each area it is the caster of (`runSourceTriggers`),
    trigger by trigger in their order. An area an earlier trigger ended answers no more, nor any later area of
    that caster's it ended: one deleted, or a concentration area once a trigger's Action broke its caster's
    concentration (read from that Action's own result, as its follow-ups delete the Region only after it returns).
  - A self-targeted trigger (`targeting: {type: "self"}`) acts once, on its caster, wherever it stands; it keeps its own
    once-a-turn record (`<caster token id>-<index>`). Any other is one Action for every creature the area covers (its band
    and filters as for any trigger, one damage roll), with no cover (Q37). One whose effects end on leaving
    (`leavesArea`) is one Action per creature, as its effects are stamped per creature.
  - The creatures it covers share the area's once-per-turn record as for any trigger, keyed on its caster's turn.
  - With no combat turn to wait for (outside combat, or a caster that is no Combatant), a `once: "area"` caster-turn
    trigger runs as the area is created; a repeating one waits for combat, as other turn triggers do.
  - One filter, `dueRuns`, decides every trigger's runs, `apply`'s and these: a spent budget, Unaffected, `eligible`,
    the dead, `affects` (a self-targeted caster-turn trigger excepted) and the once records, which it writes in one
    update before anything resolves.
- **Entering.** Being moved into an area counts as entering, and so does an aura moving over a creature.
- **A move into an area stops there.** If an area affects a creature during its own (voluntary) move, the
  move stops after the step that entered, and the rest of the move stays unspent (WildPath pays only the
  steps taken). The player is told why. This stops a player who forgot the hazard from being dragged
  through it. Forced movement is affected but not cut short. Entering an area that has already affected
  the creature this turn does not stop it.
  - A Scene with an entry hazard checkpoints every step of a drag.
  - Each step's approval records the areas that step enters (fields and band). The step ends at the last
    waypoint Foundry passed: it puts an intermediate one where a Token crosses a Region with behaviours
    (Difficult Terrain), so the first one can still be outside the area (live, 2026-11-14, DMG Webs).
  - The after-step pause holds the Token while the area acts.
  - The stop is an ordinary interruption (`reason: "entered-area"`).
- **Leaving.** A step out of an area answers `area.exited`, and so does a creature an aura stops
  covering because its caster moved on. Leaving never holds or stops the mover: the creature is already
  on its way out. It applies before any area the same step enters. Once per turn is shared with the
  area's other triggers (those without a record of their own), so a creature the area already affected this turn is not affected again on
  leaving.
  - What a trigger gives only while in the area (`metadata.endsWhen: "leavesArea"`: 2024 Web's Restrained,
    2026-11-07) carries the Region's id (`metadata.regionId`), stamped as the trigger applies it. Leaving the
    area deletes those effects first, whatever once per turn says. So does the area moving off the creature (an
    Action's move or the GM dragging its Region), and the area ending, for every creature on its Scene. An area with
    such an effect notices exits even with no `area.exited` trigger. A condition is one instance per source (Q19), so
    the webs' Restrained is stamped beside a Net's and leaving the webs ends only theirs. A custom effect (Spirit
    Guardians' Half Speed, 2026-11-14) is still one effect (Q93 (d)): it is not stamped when its creature already has
    it from elsewhere, matched by its status, its custom id, never by its missing condition type, so another spell's
    custom effect on the creature does not stop the stamp.
  - Overlapping areas holding one custom effect (wave D A13): two Antimagic Fields, two Spirit Guardians' Half Speed.
    An area entered while its creature holds that custom effect stamped by another area refreshes it with that area's
    stamp (given unstamped, it would overwrite the stamp and never be released); it still acts, so entering it stops a
    mover as entering any area does (Q139 (b) default). Leaving the area that stamped it, the
    area moving off it or ending hands it over instead of deleting it when another area covers the creature and has an
    entering trigger whose `heldOnly` part gives that custom effect and acts on the creature (`affects`, Unaffected and
    `eligible` as for its own runs; never a removed Token or a dead creature, which enter or are passed by no area):
    one update renames `metadata.regionId`, so nothing goes off and on again. A step's
    exit is judged where the step ended: the movement authority keeps that position beside the step's `areaExits`
    (`areaExitPosition`, in memory) and passes it to `apply` for `area.exited`, as exits may resolve after the Token
    has moved on; every other release judges where the Token stands. Conditions are untouched: each area stamps its
    own instance (Q19). Limits: a save-gated custom effect is never handed over (the other area's save decides it), so
    leaving the first area ends it even inside the second; a step that leaves one area and enters another holding the
    same effect hands it over, then the entering gives it again (refreshed, with a card), as entering any field does.
  - One with no outcome policy (no `saveOutcomePolicy` or `checkOutcomePolicy`: Spirit Guardians' Half Speed, whatever
    the save) is on every creature in the area (`heldOnly`, 2026-11-14). An entering trigger gives it again on each
    entering, even when once per turn has already spent that trigger's save and damage (stepping out and back in on one
    turn), and the area gives it, alone, to each creature it covers as it is created (and as a summon's carried area
    appears), so a creature caught by the cast is stamped too. The converter then leaves it off the cast's own effects.
    A save-gated one (Web's Restrained) waits for its trigger as before.
- **Moving in it (2026-11-14).** A step answers `area.moved` for each area it moves the creature in, with the feet it
  moved there (`moved`): one grid distance for each space of the step that ends in the area. A step in from outside
  counts only its part inside, a step out counts nothing, and a teleport moves in none. Distance is what movement
  measures (any step to an adjacent space is one grid distance, diagonals too); Difficult Terrain's doubled cost is not
  distance. A trigger with `per: N` deals its damage once for every N feet of the step, rounded down, in one
  resolution and one roll (2d4 three times is 6d4, through the ordinary RollRequest, so physical dice too): Spike
  Growth's `{on: ["area.moved"], per: 5, action}`. Without `per` it acts once per step. Moving in an area never holds
  or stops the mover, comes after leaving and before entering on the same step, and neither checks nor spends once
  per turn: every step hurts. Any movement counts, forced included ("when a creature moves into or within the area";
  the text names no kind).
  - A Scene with such an area checkpoints every step (`hasCrossingAreas`), so a drag is one space a step and each
    space resolves on its own, with its own card: a 15-foot walk through Spike Growth posts three 2d4 cards, not one
    6d4 card (live, 2026-11-14; the total is the same). This is kept on purpose: each space is its own resolution, so
    a later rule can stop a creature dropped to 0 Hit Points partway (not done yet: moving in an area never holds the
    mover).
  - The one-roll merge applies only to a step of several spaces that Foundry does not split into checkpoints. Such a
    step is cut along a straight line into equal parts, and each part that ends in the area counts (shortcut).
  - Converter: "moves into or within the area ... for every N feet it travels" (`DISTANCE_WORDING`) becomes that
    trigger, and the cast itself only makes the area, so a creature already in it takes nothing as it appears (live,
    2026-11-14: SRD Spike Growth had no trigger and its 2d4 at the cast). Other "for every 5 feet traveled" wording
    (Etherealness' shunting out of an object) stays by hand.
- **Removed from the scene (wave D, plan S1's crossing guard).** A Token carrying `flags.wildpath.removed` (the
  marker the removed adapter keeps on a Token it hid for a `removes` status, until its release has placed it) enters
  and moves in nothing: `entered`, `moved` and the entering half of `swept` (a creature it carries the aura over, or
  any creature while its aura's caster is marked) leave it out. So a released prisoner reappearing in an area, or a
  GM dragging a hidden one, calls for no save. Leaving is still processed (`exited`, the exiting half of `swept`), so
  an effect held only while in an area (`leavesArea`: Spirit Guardians' half Speed) is released when it reappears
  elsewhere. Areas appearing or moved onto a creature (`create`, `relocate`), an area rammed into its space (`rammed`)
  and turn triggers do not read the marker: separation there is left to the removing status's plane, its creature's own
  (`planeOf`: `<plane>:<its uuid>`), which an authority Action's target loop leaves out (targeting.md). The marker is
  any truthy value; the removed adapter writes `{hidden}` and clears it with null after the release's Blink.
- **Auras.** An `emanation` surrounds its caster with no placement clicks, and its Region is attached to
  the caster's Token, so Foundry carries the drawn cells along. Who is inside is recomputed around the
  caster's current footprint. When the caster's step carries the aura over a creature, the aura has
  entered that creature. The caster's own move is never held by its own aura.
  - Its own Token inside (wave D A13, Q138 (a) default). `persistence.includesAnchor: true` (a boolean, default false;
    validated only on an emanation or an area cast on an object) puts the Token an attached area surrounds, its caster
    or object, inside it wherever it stands (`areaCovers`), copied into the Region flag. So the area gives its held
    effects to its caster as it appears, the caster's turn triggers in it apply to it, and it never enters, leaves or
    moves in the area it carries (`crossed`, `moved`, `swept`). Antimagic Field's caster: it cannot cast through the
    field but keeps concentrating. Other uses: 2024 Aura of Life's "you and your allies", a homebrew lantern whose calm
    covers its bearer.
    ```js
    area: {shape: "emanation", size: {value: 10, unit: "ft"}, persistence: {includesAnchor: true, triggers: [/* … */]}}
    ```
- **Empty areas.** An area that catches nobody still happens: it is paid and leaves its lasting area.
  `targeting.required` now defaults to false for `area`, and the target-dependent stages pass through
  when nobody was targeted.
- **Elevation.** The `elevation` band is relative to the floor of the caster's Level. A missing bound is
  open, so a ground hazard is `{bottom: 0, top: 0}`. A creature is inside only if its height overlaps
  the band. Several areas can share a field, for example one on the ground and one in the air, and each
  one acts independently.
- **Duration.** It is counted in rounds. An area runs out N rounds after the turn it was created on, and
  is deleted at that turn's start, before anyone in it is affected. Rounds pass only in its own combat: the one
  holding its caster's Combatant (a started one first), whatever combat the GM's tracker shows; a caster that is
  no Combatant takes the tracker's. That turn is the Combatant whose turn it was (`createdAt.combatantId`, 2026-11-20),
  wherever it now stands in the order, so a Combatant joining ahead of it (a summon rolling its own Initiative) does not
  end the area a turn early; an area made before that field keeps its recorded index.
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

### Carried by a summon, and a damage budget (2026-11-14)

- **Carried by a summon.** `summon.area` (companions.md "Carried areas and matched saves") makes each summoned Token
  carry a lasting area of its caster's: `create` with an `anchor` attaches it to that Token (`anchorTokenId`, the
  Region's attachment), as the onObject branch does. Its triggers resolve with the caster as source, so its spell
  save DC and its slot's dice (the configured definition) are the caster's. The area never covers the Token itself,
  sweeps when the Token moves (`swept`), and sheds its light as the Token's own light. Its `castLevel` is its spell's
  (`carry` passes only the slot to `create`, else `metadata.spellLevel`), so Dispel Magic lists it and 2024 Darkness of
  that level over its light ends it; either way the spell ends (`end`, below; Q31, Q99 (f)). Foundry 14.369
  deletes a Token's attached Regions with it (`TokenDocument._onDeleteOperation`, from the designated user), so the
  area ends when the summon goes (read in the source, not yet checked live). Its triggers' once per turn is read as a
  placed area's is (the converter's `repeatTriggers`): one shared record only when its text says "only once per
  turn" (Conjure Animals), otherwise one trigger per event, entering "for the first time on a turn" once a turn on its
  own record (Guardian of Faith).
- **Drawn as worked out.** The carried Region's grid shape is `areaFields` around the Token at creation, never the
  Token's own space, so what is drawn is what is resolved.
- **No cover (Q37, 2026-11-16).** A lasting area's own trigger, placed, carried or attached, gives no cover: the areas
  adapter passes `noCover: true` through `runAuthorityAction` (beside the intent, given only by the authority's own
  callers) to `actionCover`, so no wall or creature between adds to a save or leaves a creature out, the creature carrying
  it and a caster far behind a wall alike (before, a placed area measured from its caster and skipped a creature its
  caster saw only through a wall). A creature's own Total Cover status (swallowed) still leaves it out (Q103 default).
  See [senses-and-cover.md](senses-and-cover.md#cover-2026-10-20).
- **Budget.** `persistence.budget: {damage: N}` ends an area once its triggers have dealt N damage in all
  (`flags.wildpath.area.dealt`, counted as `damage.applied` counts it: Temporary Hit Points and overkill included,
  Q29; only completed runs count, a failed or cancelled one changed no Hit Points). An area's spends run one after
  another, so two creatures resolved at once never read its `dealt` before the other's update is back. The strike that reaches N deals its full damage; then the area ends (`end`). `apply` reads the live Region first, so a creature a sweep
  listed after the end is spared. Guardian of Faith's 60; a homebrew ward or a spent trap reuse it.
- **Ending its spell (`end`, Q31, 2026-11-21).** The areas adapter's `end(region)` is how an area's spell ends, used by a
  spent budget, Dispel Magic choosing the area (`endEffectsOnTargets`' `endArea`) and an opposite `dispels` light: a summon
  carrying it is dismissed with its whole cast (`dismissSummon`, the summons adapter's `dismissCast`; its Region goes with
  its Token, and its caster's concentration marker with its last creature, companions.md), any other area's Region is
  deleted. Carried means summoned by the area's own Action (the summon's `actionId` is the area's `actionDefinitionId`):
  Darkness cast on an object Token, even a summoned one (a Spiritual Weapon, a Folding Boat), ends alone. An opposite
  light overlaps a carried area where its Token's light reaches (its dim radius: Flaming Sphere's 40 feet), not only
  its own ring; a placed area's light past its fields (Daylight's dim 60 feet) is not counted (shortcut).
- **Not dispellable (2026-11-21, wave D S7).** `persistence.dispellable: false` (a boolean; default true, as before)
  makes `create` keep `flags.wildpath.area.castLevel` null whatever its slot or `spellLevel`. Every path that ends a
  spell area needs a cast level, so Dispel Magic never lists it (`spellAreasWithin`) and no `dispels` light ends it
  (`dispelOpposed` reads null as above every level); `endEffectsOnTargets` also reads a null level as none, not as
  level 0, should a `dispelArea` ever name one (the authority builds it only from `spellAreasWithin`). It is read only
  at creation, so it is not copied into the flag. On a summon's carried area (`summon.area.persistence`) it keeps only
  the area from Dispel Magic: aimed at the summoned Token, Dispel Magic still dismisses it, and its area with it.
  Uses: Antimagic Field, Earthquake's fissures, Wall of Force once lasting, a homebrew ward.
- **Ending with its caster (2026-11-21, wave D S2).** `persistence.endsWhen: "sourceDies"` (the only value; absent, the
  area outlives its caster, as before) is copied into `flags.wildpath.area.persistence.endsWhen`. The areas adapter's
  `endWithSource(actor)` ends, through `end`, every Region on every Scene whose flag has that key and whose
  `sourceActorRef` is that creature's uuid (a Token's synthetic Actor and the world Actor are different creatures, as
  the flag records them); another creature's areas and its own areas without the key stay. It runs on the active GM
  only. The death settle step (`settleDeaths`, plan S2, dying-and-death.md) calls it for each creature that died, before
  deleting the effects it gave whose `metadata.endsWhen` is `"sourceDies"`, so nobody is saved against again. Uses: the Mirror of Life Trapping's capture area, a totem or ward that ends with its object, a
  homebrew hag's curse ending with the hag. On a carried area (`summon.area.persistence`), `end` dismisses its summon too,
  with its whole cast; `end` then leaves alone an attached area whose Token is already gone (another wolf of that cast),
  since V14 deletes a deleted Token's attached Regions itself without awaiting, and deleting it again would throw.
- **Walls from an area (2026-11-21, wave D S3).** `persistence.blocks: ["move", "sight", "light", "sound"]` (a non-empty
  list of those Wall senses) raises Wall documents on the area's outline that stop exactly those senses: Wall of Ice
  `["move", "sight"]`, Wall of Force `["move"]`, a homebrew portcullis. It is copied into
  `flags.wildpath.area.persistence.blocks`. Validation refuses it on an `emanation`, beside `onObject` and on a summon's
  carried area (`summon.area.persistence`): walls stay where they are raised and do not follow a Token.
  - On creation (active GM, `create`, after the Region): each creature on the caster's Level and plane (`planeOf`:
    an Ethereal creature, or a Trapped one's hidden Token, is left where it is) over the fields
    (`areaCovers` without the band: a V14 Wall has no elevation bounds, only `levels`, so it stands the Level's whole
    height and a flier above the band is walled in too) first steps out to the nearest free space beside its own space
    whose footprint lies outside the fields and that no existing wall cuts off (a Blink passes walls) (`stepOut`, the
    forced-movement adapter: `spaceBeside` with that `accept`, then a Blink as `movementKind: "forced"`);
    with none it stays and the GM is told (`WILDPATH.NOTICE.AreaNoRoom`). Then the walls go up, after the moves, so no
    wall stands in a creature's way out.
  - The walls (`foundry-v14-walls.mts`): `cellPolygons` gives each field's cell corners (V14 `grid.getVertices`, in
    perimeter order on square and hex grids), `outlineEdges` keeps the cell edges no two fields share (bastion-map's
    rule) as whole-pixel `c`, and `areaWallData` writes one two-way document per edge (`dir` `EDGE_DIRECTIONS.BOTH`),
    each listed sense NORMAL and every other one NONE (`EDGE_SENSE_TYPES`, `WALL_MOVEMENT_TYPES` for `move`), since a
    WallDocument starts every sense at NORMAL; `levels: [the caster's Level]` when it has one, and
    `flags.wildpath.areaRegion: <Region id>`. One `createEmbeddedDocuments("Wall")` call. Foundry's movement and vision,
    and WildPath's cover, pushes, summon placement and sunlight, read them as any wall.
  - `onRegionDeleted` deletes the Wall documents whose `areaRegion` is that Region's (concentration, duration, Dispel
    Magic, the GM); a hand-drawn wall or another area's stays.
  - It stays where it was made: an Action's `moveArea` is refused before anything is spent
    (`WILDPATH.REFUSAL.AreaFixed`), and a GM drag of its Region is drawn back on its own fields (the update carries
    `{wildpath: {areaMove: true}}`) with `WILDPATH.NOTICE.AreaFixed`. The GM ends it and casts it again to move it.
  - `segmentOutside(c, polygons)` is the other half of the module, for an area that opens the walls under it
    (`walls: "open"`, below): the pieces of a wall outside convex cells (Cyrus-Beck, whole pixels), `[c]` itself when
    no cell cuts it (its crossing test), none when they cover it. A wall only touching a cell, or along its edge, is
    not cut.
  - shortcut: `stepOut` searches one ring around the creature's space, so a creature deeper than one field inside an
    area stays put (the GM is told); upgrade to a wider search if play needs it. The caster's choice of side ("you
    choose which side") is the nearest free space (Q142's default), upgrading to an aimed `push.choose`. `blocks` always
    pushes its creatures out (every planned wall's fields are the solid wall); an area that walls creatures in (a
    Forcecage-style cage) needs the push split into its own part, with A17's `push.out`.
  - **Sections (2026-11-22, wave D A14).** `persistence.sections: {size, ac, hp, ruleElements?}` makes a blocking wall
    into object sections: Wall of Ice's `{size: 10, ac: 12, hp: 30, ruleElements: [GrantImmunity cold, poison and
    psychic; GrantVulnerability fire]}`, Wall of Stone's panels, a homebrew palisade or breakable door. `size` is feet
    per section (a positive number), `ac` and `hp` positive whole numbers, `ruleElements` any rule elements.
    Validation accepts it only on `shape: "wall"` whose `blocks` lists `move`. It is copied into
    `flags.wildpath.area.persistence.sections`.
    - On creation, after the creatures step out (`raiseSections`): the fields, put in order along the wall's longer
      axis (a footprint's are sorted by string key), split into sections of `ceil(size / grid distance)` fields, the
      last perhaps shorter and at the high-coordinate end, as the wall's start is not kept (`wallSections`,
      `helpers/tactical-areas.mjs`). One world Actor stands for them (`objectActorData`: an `npc` of threat 0, its
      AC typed, its Hit Points as `health.base` and `value`, a neutral unlinked prototype Token, and one feature whose
      rules are the object rule, `OBJECT_RULE`, then `ruleElements`); its id is the flag's `sectionActorId`. Each
      section is an unlinked Token of it, so it keeps its own Hit Points: over its fields when they fill a rectangle
      (a straight 10-foot section on a 5-foot grid is 2x1 or 1x2), else 1x1 on its first field
      (`sectionTokenPlacement`); on the caster's Level, named `WILDPATH.AREA.Section`, flagged
      `flags.wildpath.section: {regionId, index}` and `flags.wildpath.leavesAtDeath: true`, so at 0 Hit Points it
      dies as any npc and the death settle step removes it (dying-and-death.md).
    - Its walls are each section's own outline instead of the area's (`sectionWallData`), two documents per edge:
      `move` two-way, and every other listed sense one-way facing out (`dir` the side away from the section's cell),
      so a line from outside passes the near edge and stops at the far one. The Token is seen and attacked without
      cover from its walls, nothing behind it is seen, and nothing enters it. Each wall is flagged
      `{areaRegion, section: <index>}`, a shared edge getting one pair per section, so each section can open alone.
    - The object rule (rule-elements.md, Unaffected; Q141's default) passes a section by for every Action but an attack
      and one tagged `affects:objects`: an area, an aura, a lasting area's trigger or a single-target save spell
      leaves it out, a Fire Bolt hits it. A later blocking area does not push a section out (no Token its rules leave
      untouched by the area's Action is pushed), so it stays by its own walls.
    - `onRegionDeleted` deletes, after its walls, the section Tokens still standing and then their Actor.
    - shortcut: the object rule always comes first on a section's Actor; a definition cannot drop it (the GM can, on
      the Actor). Upgrade with Q141's answer if a section ever must be affected by areas.
  - **Opening a section (2026-11-22, wave D A15).** A section's Token deleted opens that section: the areas adapter's
    `onTokenDeleted`, on the runtime's `deleteToken` hook (active GM only), deletes the walls flagged
    `{areaRegion: <its section's regionId>, section: <its index>}`; its neighbours' walls and every other wall stay.
    It is one path for a section at 0 Hit Points (the death settle step removes its `leavesAtDeath` Token) and for a
    GM deleting the Token by hand, and it reads only the Token's `flags.wildpath.section`, so any sectioned area opens
    this way (a homebrew palisade or Bastion gate broken down, a breakable door). A Token the Region's end removes
    finds its walls already gone, and a section another Token still carries (a GM's pasted copy) stays closed. shortcut: undoing a section Token's deletion brings the Token back but not its walls;
    raise them again from the flag if a GM ever needs that.
  - **What an opened section leaves (2026-11-22, wave D A16).** `persistence.sections.leaves` is a lasting area's
    persistence (triggers, `oncePerTurn`, `difficultTerrain`, `obscures`, `light`, `affects`) that each opened section
    leaves in its space: Wall of Ice's Frigid Air
    (`{triggers: [{on: ["area.entered", "area.exited"], once: "turn", action: <a Constitution save against 5d6 Cold>}]}`),
    and as plain data Wall of Stone's rubble (`{difficultTerrain: {}}`), a homebrew wall's embers or lightly obscuring
    shards (`{obscures: "lightly"}`). Validation checks it as any persistence on a wall, and refuses its own
    `duration`, `concentration`, `elevation`, `endsWhen`, `dispellable`, `budget`, `blocks`, `walls`, `sections` and
    `onObject`: it lasts as long as the wall and stands where it stood.
    - `onTokenDeleted`, once a section opens, makes the child (`leaveBehind`, active GM): a Region built by
      `persistentAreaRegionData` over that section's fields (`wallSections` again, as at creation), of the wall's
      caster, with the definition `{id: "<wall's id>:leaves", label: <its first trigger's Action's label>, area: {shape:
      "wall", persistence: leaves}}`, the wall's band, Levels and cast level, and `flags.wildpath.area.parentRegionId`,
      made as `create` makes any area (`createRegion`: its `light` shed, an opposite light it `dispels` ended, what it
      holds given to the creatures it appears around, its once-only caster-turn triggers outside combat). `leaves` is copied from the configured definition with the rest of
      `sections`, and `configuredComponents` reaches `area.persistence.sections.leaves.triggers`, so the slot's dice
      reach it (Frigid Air's +1d6 a level above 6th) and a chosen damage type does.
    - It is an ordinary lasting area. Its triggers give no cover (Q37). With `on: ["area.entered", "area.exited"]` and
      `once: "turn"`, crossing it on one turn is one save (outside combat, one a crossing), and a creature that stops in
      it and leaves on a later turn saves on each (Q144's default: two). Each opened section leaves its own sheet, as
      the owner's Frigid Air answer reads ("a sheet of frigid air in its space", Q18), so a crossing of two neighbouring
      opened sections on one turn is a save in each.
    - It never ends alone: its parent's `onRegionDeleted` deletes every Region naming it (concentration, duration, the
      GM), and `end` on the child (Dispel Magic choosing the sheet, a light dispelling it) ends the parent instead. A GM
      deleting the child's Region by hand removes only that sheet. A Token the parent's end removes finds no parent
      Region and leaves nothing.
    - shortcut: with the caster's Token gone from the Scene nothing is left (`WILDPATH.NOTICE.AreaLeavesNoCaster`), as
      an area resolves with its caster's Token; and a creature already standing in the opened space is not asked to save
      as the child appears (only what it holds whatever the save reaches it, as for any area appearing).
  - Not verified in live
    Foundry: walls created on a Scene the canvas does not show, whether a GM can drag a Token through them, and a 2x1
    section Token's sampling behind one-way walls.
- **Opening the walls under an area (2026-11-21, wave D S3).** `persistence.walls: "open"` (the only value) hides the
  existing walls the area's cells cut while it lasts, leaving them standing outside it: Earthquake's fissures, a
  Passwall, a homebrew breach charge. It is copied into `flags.wildpath.area.persistence.walls`. Validation refuses it
  beside `blocks` (an area opens walls or raises its own), on an `emanation`, beside `onObject` and on a summon's
  carried area: only a placed area's walls are re-cut when it moves.
  - The persistent-areas adapter's `syncOpenedWalls(region)` (active GM) runs on `create`, after `relocate` (its
    Action's `moveArea` or a GM drag; an opening area moves, unlike a blocking one) and in `onRegionDeleted`. An
    original wall is one with neither `flags.wildpath.areaRegion` (an area raised it) nor `flags.wildpath.pieceOf`, so
    a fissure across a Wall of Ice never opens the ice. Each original on the area's Level (the Region's `levels` against
    the Wall's; an empty set is every Level, as `wallsBlock` reads it) that its cells cut (`segmentOutside` on
    `cellPolygons`), and each it opened before, is written again in one batch:
    - while any live opening area cuts it, every sense NONE (`wallSenses([])`, the same CONST values `areaWallData`
      writes), `flags.wildpath.openedBy: [Region ids]` and `flags.wildpath.senses: {move, sight, light, sound}` (its
      own, kept from the first opening); its pieces (`flags.wildpath.pieceOf: <its id>`) are deleted and made again as
      copies of it (Level, direction, threshold) with its own senses, `c` from `segmentOutside` against the cells of
      every area opening it on that Level: a wall on several Levels (or on every Level) gets its pieces Level by Level,
      each listing its Levels, and a whole copy on any Level no area opens it;
    - once none does, its own senses come back and `openedBy` and `senses` are written null.
    The pieces are derived data, so areas made, moved and ended in any order give the same walls; the original is
    hidden, never deleted or moved. Runs are queued per Scene, since Regions ended in one batch fire their delete
    hooks unawaited.
  - shortcut: a door is opened whole (no door pieces), and an original the GM deletes while opened leaves its pieces;
    upgrade if a door half across an area or a deleted original matters. Not built yet: pending areas that open no
    walls until confirmed (Earthquake's `opens`, A19). Not verified in live Foundry: Wall updates and pieces made on a
    Scene the canvas does not show, and whether the pieces' edges refresh at once.

### Moving a lasting area (2026-10-18)

- **By its Action.** An Action with `moveArea: {of, distance}` moves its creature's lasting area left by the Action
  `of` (its definition id), as Moonbeam's Magic action does.
  - The player places the new spot with the area's own shape and size. The authority refuses one more than `distance`
    feet from the old center, an attached area (it moves with its creature), a blocking area (`persistence.blocks`), or
    no area at all.
  - After the Action, the Region's grid cells and `flags.wildpath.area.fields` become the new footprint.
- **By the GM.** Dragging or redrawing a lasting area's Region (its grid shape changes) rebuilds its fields from the
  new cells, on the active GM's client; a blocking area's is drawn back instead (Walls from an area, above).
- **Either way:** each creature newly inside is entered ("when the Cylinder moves into its space"), once per turn.
  The triggers go with the area unchanged, so an upcast Moonbeam keeps its 3d10.

Live (two browsers, 14.369): QA Caster's 3rd-level Moonbeam, moved by "Moonbeam (Move)" onto QA Wizard and QA
Fighter: each saved against 3d10 (the Fighter failed and took 14). A GM update of the Region's cells moved it onto
three more creatures, and each saved against 3d10.

## Traps (2026-10-21)

A 2024 trap's tiers ("Trigger (1-4)" to "Trigger (17-20)", by the characters' levels) each convert to an Action
(`trapDefinition` in the converter) the GM uses to set it:
- a lasting 5-foot square (`area.persistence` with no duration), placed anywhere (`range: {type: "special"}`) from the
  Token of the creature holding the trap;
- setting it does nothing else; its one trigger, `area.entered`, springs the trap's save or attack, damage and effects
  on each creature that enters it.

shortcut: finding it (Wisdom (Perception)), disarming it, and a trap that springs only once are by hand: the GM deletes
its Region. Upgrade with hazard Regions that hold their DCs (Phase 7).

Hazards (2026-11-13) take the same shape. A hazard is a 2024 DMG document whose activities all lack an activation, with
one sentence saying what befalls a creature that "enters ... for the first time on a turn" and naming its save ability
or damage type (Brown Mold, Poisonous Gas, Inferno, Webs). `trapDefinition` takes the hazard's own `on`, area and
Difficult Terrain (`hazardOf`):
- `on` is `area.entered`, plus `turn.started` when the sentence says "or starts its turn there".
- The area is its placing utility's template (Brown Mold's 10-Foot Square, which folds in), else a "10-foot Cube" its
  text names (Webs), else 5 feet. It is widened by a "within 5 feet of" the sentence reaches, on both sides of a Cube
  (Brown Mold: 20 feet) and once on a radius.
- On a Hazard Actor, whose item is named "Description/Effects", the Action and its area take the Actor's name.
- Each of its passive saves or damage is a tier (Poisonous Gas's "Level 5-10 Save").

The GM reshapes the Region to the hazard's extent; its fields follow (`onRegionUpdated`). What else its text says (growth,
its AC and HP, Disadvantage while in it) is noted by hand. These Actions are free and GM-set like a trap's: only the
ownership of the Item or the Hazard Actor holding them keeps them from players.

Live (14.369): a Collapsing Roof (1-4) set on the GM's client made one Region; a creature walking into it took 10 (2d10).

## Teleport (2026-10-19)

`teleport: {distance}` moves the Action's own creature up to `distance` feet to a space it chooses (Misty Step's 30,
Dimension Door's 500).
- **Choosing.** The player clicks where the Token lands (`placeFoundryTeleport`); the highlight is its footprint
  there, red when the space is refused.
- **Checked twice.** The client and the authority run the same `teleportDestination`. A destination is refused when:
  - it is farther than `distance`, center to center;
  - it is off the Scene;
  - another Token is on it, unless that Token's creature is on another plane than the teleporting one's (`planeOf`,
    rule-elements.md "Planes"; 2026-11-21).
- **Moving.** Once the Action completes, the active GM moves the Token with V14's Blink (`movementKind: "teleport"`):
  no movement spent, no path walked, no Opportunity Attack.
- **Converted:** dnd5e teleport activities with a distance in feet. SRD: Misty Step, Dimension Door, Tree Stride, the
  Cape of the Mountebank, and the Archmage's, Mage's, Cloud Giant's, Lich's and Spirit Naga's casts. Teleport, Plane
  Shift and Word of Recall have no distance and stay by hand. A spell with no teleport activity whose text says "You
  teleport ... to a location / any other spot / an unoccupied space ... within range", with a range in feet, gets one
  first (`missingTeleport`): the Player's Handbook module's Dimension Door, whose older data holds only its damage.
- **Bringing creatures along.** With `teleport: {distance, withTargets: true}` the Action's targets go too, each
  Blinked to the free space beside the landing nearest it (`spaceBeside`). The converter gives Dimension Door and a
  Fey Steed's or Otherworldly Steed's Fey Step one optional, non-hostile target other than itself within 5 feet; with
  none chosen the creature goes alone. Distant Spell is not offered on a teleport, since its 5-foot range is the reach
  to that creature.
- shortcut: a target with no free space beside the landing stays where it is; WildPath has no mount model, so a
  steed's rider is whichever willing creature its controller targets; Tree Stride's trees are not checked.
- The Builder edits it ("Does it teleport its user?").

### Swapping places (2026-11-21, Q49)

Two creatures trade places as one shared part, `swapTokens` in the teleport adapter: each is Blinked (no movement
spent, no Opportunity Attack) to the other's top-left, after the Action resolves (Q113 (a) default). The landing is
each Token's own x/y, not snapped through the grid again (on a hex grid a hex's top-left corner lies in its neighbour).
- **Who swaps.** `swap: true` on an Action (an additive BooleanField): its creature and its one target, so it needs
  `targeting: {type: "single"}` with one target (Bait and Switch, Benign Transposition's swap, a homebrew "trade
  places"). Its outcome gates it as a push's (`pushedTargets`): a failed check, a made save or a miss keeps both put.
  `rider.swap: true` on a reaction: its creature and the creature its `redirectDamage` picked (Redirect Attack), or,
  when it picked itself (`to: "self"`, a bodyguard), the creature it protects; `state.input.riderSwap` maps each
  reactor's Token to its partner's, so two redirects in one Action both swap. Validation refuses a swap without one
  target and a rider's swap without a redirect.
- **Refused** (`swapLandings`, Q113 (a) default) when a landing is off the Scene, would overlap a third creature, or the
  two would overlap each other (creatures of different sizes): an Action with `swap` is refused by the authority
  before anything is spent (`WILDPATH.TELEPORT.*`); a reaction's swap (or an Action's whose spaces filled meanwhile)
  moves neither.
- **Written as data** for Bait and Switch: `swap: true`, `targeting: {type: "single", count: 1, notHostile: true,
  eligible: {missingCondition: "incapacitated"}}`, a 5-foot range and a `movement` cost of 5.
- **Converted:** a chosen redirect whose text says "swap places" gets `rider.swap` (the Goblin Boss, both books). No
  converter path writes an Action's `swap` yet: no SRD document has it to read, so the premium Bait and Switch needs
  its own converter read, built against its document, when the books are next converted.
- shortcut: the two Tokens move one after the other, so region and movement hooks see two teleports, with a moment
  where they overlap; upgrade with one batched Token update if a region trigger misreads it.
- Not yet converted: the premium Bait and Switch (its AC bonus "you or the other creature" by hand) and Trickster's
  Transposition, whose partner is Invoke Duplicity's illusion, not yet a summoned Token (Q113 (b)).

Live (two browsers, 14.369): Player1's QA Caster, beside the Bandit Captain with no movement left, cast the SRD Misty
Step. A click 35 feet away was refused ("That space is too far"); one 25 feet away moved the Token there. The Bonus
Action and a 2nd-level slot were spent, movement was untouched, and the Captain was offered no Opportunity Attack.

## Forced Movement (2026-10-15)

An Action with `push: {distance, toward?, maxSize?, on?, choose?, inRange?, thrown?, seen?}` moves creatures when it completes
(`module/adapters/foundry-v14-forced-movement.mts`). Thunderwave is `{distance: 10}`, and the Merrow's Harpoon is
`{distance: 15, toward: true, maxSize: "large"}`.

- **Who moves.** The creatures that fail its save, or with `on: "success"` those that succeed (the Bulette's Deadly
  Leap), read by `outcomeTargets` as `ends.on` is (action-definitions.md). An Action with no save moves the creatures its attack hits. One with neither (2026-11-14) moves its targets:
  a Roper's Reel pulls the creatures it targets, each refused unless Grappled by it (`targeting.sourceCondition`,
  [targeting.md](targeting.md)). The converter writes a push with no roll only with that hold, so it never moves a foe
  unasked; a push built by hand with no roll moves whoever it targets, as its data says.
  - `maxSize` skips bigger creatures. The size is the Token's TokenGridFootprint size, as the before-push reaction
    window reads it: a Token of 2 or more fields gives its size (2 Large, 3 Huge), and a 1x1 Token its actor's size.
  - A Legendary Resistance that turns a failure into a success stops the push.
- **Where.** The active GM moves each creature a field at a time along the line from the source's center through
  the creature's: away from it, or toward it for a pull. On a square grid each step is one field on the longer axis,
  so a diagonal push crosses diagonals.
  - The creature stops before a wall, another creature's field, or the Scene's edge.
  - When several are pushed, the farthest moves first; when pulled, the nearest.
- **As forced movement.** The Token update carries `movementKind: "forced"`. It spends no Speed and provokes no
  Opportunity Attack (2024). A lasting area the creature is pushed into still sees it enter.
- **Shortened by a reaction.** A `push.applied` `before` window lets each creature pushed shorten its own push
  (Dwarven Plate: `input.pushReduction`, feet by Token id; [reactions.md](reactions.md)).
- **Aimed by its user (2026-11-14).** `push.choose` makes the user pick where its one target lands (validated: single
  targeting, `choose` is `"space"` or `"line"`, `inRange` a boolean):
  - `"space"`: any free field within `distance` feet of the creature (centre to centre, as a teleport's landing);
    with `inRange: true` also within the Action's range of its source ("within the spell's range": Telekinesis is
    `{distance: 30, choose: "space", inRange: true, maxSize: "huge"}`).
  - `"line"`: a field on the straight line through the source, toward or away, at most `distance` feet ("5 feet
    toward or away from you": the Telekinetic feat, a Hook); toward ends before the source's own space, never past it.
  - One check, `pushLanding` (forced-movement adapter), serves the client's click (`placeFoundryPush`, red when
    refused: `WILDPATH.PUSH.*`, and `WILDPATH.TELEPORT.Occupied`/`OffScene`) and the authority, which re-checks the
    sanitized `intent.push.point` and passes `options.pushTo` (the Token and its landing's top-left).
  - The creature then walks there as any push does, a field at a time toward the landing, stopped by walls, creatures
    and the Scene's edge, and stops on the landing (`forcedDestination`'s opt-in `until`; every other push is
    unchanged). A reaction's `pushReduction` still shortens it. Only the aimed creature moves, and only when it
    failed (or was hit); without a landing nobody moves.
  - `pushLanding` walks that same way first (`forcedDestination` with `forcedStepBlocker`), so a landing a creature or
    wall on the straight way would stop it short of is refused (`WILDPATH.PUSH.Blocked`) instead of accepted and then
    not reached (the suspected cause of a live 2026-11-14 report where one held creature did not move; the Tokens'
    positions were not checked). A
    reaction's `pushReduction`, or a Token that moves in between, can still stop it short.
  - The landing is picked before the roll, as for a teleport or an area (owner question Q39).
  - Its one target may be its user itself, on a self-targeted Action (2026-11-21, Q56: Gathered Swarm's "you are
    moved 5 feet horizontally to an unoccupied space of your choice", `{distance: 5, choose: "space"}`): it walks there
    as forced movement (no Opportunity Attack). Every other push still never moves its source.
  - A reaction's aimed push takes the landing its chooser clicks as they accept the offer (`input.pushTo`, checked
    again on the active GM: [reactions.md](reactions.md#parent-and-child)); Gathered Swarm's save is
    `{distance: 15, choose: "space"}` on the creature hit.
- **Thrown (2026-11-21, Q42).** `push.thrown: true` (with `choose: "space"`) flies the creature to its landing: a
  Kraken's Fling is `{distance: 60, choose: "space", thrown: true, seen: true}` beside `targeting.sourceCondition:
  "grappled"` and `targeting.maxSize: "large"`.
  - `pushLanding` measures `distance` from its source's space (footprint distance, as an Action's range:
    `foundryPointInRange`), not from the creature, and nothing on the way refuses it; off the Scene, out of range or on
    its source is refused. `push.on` is refused beside it (it moves whatever its roll). `seen: true` also needs no sight-blocking
    wall between the source's centre and the landing's (`WILDPATH.PUSH.NotSeen`). shortcut: walls only, not darkness,
    invisibility or each field the creature covers; upgrade with `tokenSees`.
  - A landing with living creatures on the ground of its Level and plane (`occupants`; one in the air above, on another
    Level, dead or on the other plane is not there, Q106 (d) default) puts the thrown creature in the nearest free space
    beside it (`spaceBeside`, Q106 (a) default) that the throw also reaches (within `distance`, seen with `seen`, no wall
    from the landing), refused when none is; those creatures become its targets too ([targeting.md](targeting.md)).
  - It moves whatever its roll (`pushedTargets`: its one target), as forced movement in one Blink waypoint (no walk,
    no Opportunity Attack) onto its Level's floor ("not in the air"), so only an area at its landing sees it arrive
    (Q106 (c) default). No before-push window opens for it (Dwarven Plate works along the ground).
  - shortcut: the thrower's Grappled and the Restrained "until the grapple ends" stay on the thrown creature (Q106 (b)'s
    default, a grapple ending once its creature is beyond its grappler's reach, is not built: by hand).
- **Stepping out of fields (2026-11-21, wave D S4).** `stepOut(token, fields, movementKind)` moves a creature to the
  nearest free space beside its space whose footprint lies outside an area's fields and that no wall cuts off from it,
  as a Blink of that kind, or leaves
  it and tells the GM (`WILDPATH.NOTICE.AreaNoRoom`). A blocking area uses it at creation (Walls from an area, above).
- Shortcuts:
  - "up to N feet" always pushes the whole distance, unless its user aims it (`choose`);
  - (walls stop it on any Scene since 2026-10-21: [senses-and-cover.md](senses-and-cover.md#walls-on-any-scene));
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
- **Aimed up or down (2026-10-21).** A cone or line aimed at a creature above or below its caster tilts toward it:
  its band rises (or falls) by the slope from the caster's height to that creature's, times each creature's distance
  across (`aimedTilt`). Aimed where no creature stands, it stays level. Quench: a line aimed at a goblin 30 feet up
  reaches it; aimed level along the same row it passes beneath.
- Shortcuts: Opportunity Attacks measure flat; lasting areas keep their own elevation band (open by default).
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

## Environment Regions (2026-11-13)

A Region (or a whole Scene) tagged `flags.wildpath.environment` (`water`, `runningWater`, any homebrew key) tells rules
what place a creature in it stands in: a river, a lake, an underwater Scene. The GM paints it and ticks its boxes on the
Region sheet. `environmentContext` tests only tagged Regions, by the Token's center and elevation, and rules read the
tags as `environment.<tag>` (rule-elements.md, "Water and other environment tags"). A lasting area's own Region is not
tagged and is never tested.

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
