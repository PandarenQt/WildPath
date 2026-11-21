# Target Sets and Target Refinement

Wild Path targeting must keep geometry, eligibility, refinement, and per-target resolution separate.

```text
Area Geometry
-> Physical Candidates
-> Base Target Eligibility
-> Target Refinement
-> Final Resolution Targets
-> Per-Target Resolution Rules
```

The current implementation begins this foundation in `module/helpers/targeting.mjs`. It is a pure
domain helper and does not depend on Foundry or the tactical grid runtime.

## Physical Candidates

Area geometry answers only physical inclusion:

```text
Which tokens occupy fields intersecting this GridFootprint?
```

It does not decide ally/enemy status, protection choices, intentional exclusions, or target-specific
save/damage handling.

`TargetCandidate` preserves:

- stable target identity
- target and actor references
- occupied fields
- intersecting fields
- disposition/kind/tags/conditions
- eligibility result

A large token that intersects several fields remains one candidate target. Its field data is kept
for debugging and trace output.

## Target Sets

`TargetSet` is reusable beyond AoE:

- areas
- multi-target spells
- chain effects
- reactions
- healing
- buffs
- future mass actions

The helper de-duplicates candidates by stable target id and merges field intersections.

It also provides small result-based operations:

- `addTargetCandidate`
- `removeTargetCandidate`
- `targetSetContains`
- `filterTargetSet`
- `partitionTargetSet`
- `applyTargetPredicate`

These operations return new structures rather than mutating candidate membership in place.

## Eligibility

Base eligibility is applied after physical inclusion. The current helper supports ordinary
restrictions through a shared structured predicate evaluator:

- target kind
- disposition
- willing targets
- tags
- conditions
- structured predicate equality/one-of logic

`ActionResolver` now adapts persisted ActionDefinition target rules into this policy shape before
calling `TargetResolver`.

## Refinement

Refinement decisions are explicit operations:

- select
- deselect
- include
- exclude
- mark
- override

This distinction matters because a creature can remain inside an AoE footprint while receiving
special resolution handling. Protective mechanics should not always be modeled as target removal.

`refinementPolicy.requiresSelection: true` asks the source controller to refine whenever there is any candidate, every
one ticked by default ("each creature of your choice in" an area, 2026-11-21: [areas.md](areas.md)); with none it asks
nothing. A candidate marked `undisclosed` (the authority's: a GM-hidden creature in a player-owned creature's area) is
left out of the chooser's payload and keeps its default selection.

An ActionDefinition's `targeting` also carries defaulted flags the authority
(`foundry-multiplayer-runtime.mjs`) checks against the declared targets, separate from `eligibilityPolicy.willing`
above:

- `notHostile: true`: "a willing creature". A target hostile to the source (Token disposition, or a neutral creature
  turned hostile this combat: `tokensHostile`, reactions.md) is refused with
  `WILDPATH.COMMON.NotWilling`. The converter writes it on a buff whose text says "willing creature" (Haste, Fly, Water
  Breathing; not one that may take "an unwilling creature", nor one with an attack, save or damage), on drunk potions,
  Heightened Focus and Dimension Door. Its owner is not asked.
- `notSelf: true`: another creature only (Help); the source itself is refused with `WILDPATH.COMMON.NotSelf`.
- `selfIfNone: true`: with no creature chosen the source is the target, as `type: "self"` (a potion drunk unless
  given to another creature).
- `sourceCondition: "<condition id>"` (2026-11-14): each target must have that condition from the source
  (`conditionsFrom`: an effect the source's Actor, Token or one of its Items applied), else it is refused with
  `WILDPATH.COMMON.NotHeld`. The converter writes it on a Reel ("pulls each creature Grappled by it": `"grappled"`;
  "Restrained by its Web Strand": `"restrained"`). The Action Builder keeps it on edit but does not show it.
- `maxSize: "<size>"` (2026-11-20, Q41): no target larger than that creature size (`CREATURE_SIZE_ORDER`), judged as a
  push's `maxSize` is (`pushable` on the Token's size), else it is refused with `WILDPATH.COMMON.TargetTooLarge` (naming
  the size) before anything is rolled or spent. The converter writes it beside the push where the text says "you can try to move a Huge
  or smaller creature" (Telekinesis, and its cast copies and later Action); "if the target is Large or smaller" (Chain,
  a Merrow's Harpoon) keeps a larger creature a target that is only not moved (`push.maxSize`). The Action Builder keeps
  it on edit but does not show it.
- A throw's landing creatures (`push.thrown`, 2026-11-21, Q42; [areas.md](areas.md#forced-movement-2026-10-15)): the
  authority adds the creatures on the ground where its one target lands to its targets, after that target, each making
  its own save. Its user did not choose them, so they get no cover (Q106 (d) default) and none of the limits above
  (`maxSize`, `sourceCondition`, `notHostile`, `eligible`, `notSelf`) nor the other-plane refusal (one on another
  plane, `planeOf`, on another Level or dead is not on the landing at all), and its count is all
  of them (the authority's `refinementPolicy`), with nothing to refine.
- `eligible: <predicate>` (2026-11-20, Q75, Q74): each target must pass this predicate (helpers/predicates.mjs) over
  what the Scene says of it: `seesSource` (it sees the Action's source), `seesLitSource` (the same, the source counted
  in its own light: one that lights itself as it acts) and `seenBySource` (the source sees it), all `tokenSees`
  (senses-and-cover.md: Blinded, Invisible, light, Heavily Obscured, a wall blocking sight), worked out only when read;
  `conditions` (its statuses: `missingCondition: "deafened"` for "that can hear it", Q126 default); and
  `actor.system.details` (`type`, `subtype`); and `size` (its Token's creature size, as `maxSize` judges it; 2026-11-21,
  Q47, first read by a redirect's `eligible`, reactions.md); and (2026-11-21, Q18.6) `actor.name`, its stat block's name,
  and `actor.system.companion.controllers`, who controls it. Pipes of the Sewers' "a Swarm of Rats that isn't under
  another creature's control" is `{equals: {path: "actor.name", value: "Swarm of Rats"}}` with `{atMost: {path:
  "actor.system.companion.controllers.length", value: 0}}`. shortcut: a name is matched as written, so a renamed Actor
  is no longer that stat block. A single or several targets failing it are refused with
  `WILDPATH.COMMON.NotEligible` before anything is rolled or spent (Q127 default); an area (`foundryActionArea`) leaves
  such a creature out instead, and so do a lasting area's trigger (areas.md) and an automatic Trigger's aura or pick (the
  automation dispatcher, before `runAuthorityAction`, which rebuilds the targeting without it). All read it through
  `ineligibleTarget` (`adapters/foundry-v14-senses.mts`); the pipeline's `eligibilityPolicy.predicate` is judged on
  candidates that carry none of these facts. The converter writes it, by wording only:
  - 2014 "If the target can see the mummy" (Dreadful Glare): `{equals: {path: "seesSource", value: true}}`, and with
    "The mummy targets one creature it can see" both directions (`all`).
  - A 2024 stat block's "Saving Throw: DC 11, one creature the mummy can see within 60 feet" (Dreadful Glare, a Giant
    Spider's Web, a dragon's Banish): `seenBySource`; not "a point the dragon can see", which names no target.
  - The Robe of Scintillating Colors' "each creature in the Bright Light that can see you": `seesLitSource` on its
    area, as its own light is not on the Scene yet when its targets are judged.
  - A 2014 "Each creature within 10 feet of it that can hear it and that isn't a demon must" (a Vrock's Stunning
    Screech): its self emanation with each qualifier read (content-packs.md).
  - A 2024 carried area's "a creature you can see" (Conjure Animals): `seenBySource` on its triggers' Actions.
  Not yet read: a spell's "a creature you can see within range" (Q127's default asks for every such text; the reader is
  its own item), and a turn aura's "that can hear it" (Whispering Aura), which its Trigger's Action could carry but the
  converter does not write yet.
  The Action Builder keeps it on edit but does not show it.

A definition's `targeting.count` may be a `table` ValueExpression (Eldritch Blast's beams by character level): the
ActionDefinition adapter turns it into the creature's row before refinement, so `maxSelections` and a repeatable
Action's `instances` are numbers.

## Selection Policies

Selection policies describe:

- default selection (`all`, `none`, or predicate-selected)
- allowed operations
- chooser
- min/max selections
- min/max choices
- selection predicate
- reason for the request

Limits use safe `ValueExpression` evaluation, so "choose up to proficiency bonus" does not require
JavaScript.

## Overrides

Per-target overrides are carried into `targetContexts`:

- automatic success
- automatic failure
- advantage/disadvantage
- ignore/halve/zero/modify damage
- skip consequence
- future custom override types

The helper does not implement save/damage semantics. It preserves structured override data for the
future resolution layer.

## Debug And Audit

`createTargetRefinementTrace()` converts a refinement result into structured inspection data:

- physical candidate count
- selected/excluded/final target counts
- target status (`selected`, `excluded`, `overridden`, `ineligible`, `unselected`)
- eligibility details
- field intersections
- overrides and marks
- validation failures

This is meant for developer tools, automation traces, chat summaries, undo/replay records, and
future GM inspection.

## Selection Requests

`createTargetSelectionRequest()` produces structured future UI state:

- physically in area
- selected
- excluded
- protected/overridden
- selectable
- deselectable
- excludable
- overridable
- cannot change
- ineligible
- predicate rejection reason
- chooser
- required/allowed counts
- validation when preview decisions are supplied

Battlefield highlights should be derived from this state, not stored as UI-only color decisions.

## AoE Integration

When the tactical grid foundation exists, the adapter flow is:

```text
GridFootprint
-> AreaCandidateResolver
-> TargetSet
-> TargetEligibilityResolver
-> TargetRefinementResolver
-> per-target resolution contexts
```

Refinement must not mutate the `GridFootprint`; preview and resolution footprints remain the same.

`module/helpers/area-targeting.mjs` implements the current pure bridge from an already-computed
`GridFootprint` and token footprints into physical `TargetCandidate` objects. It intentionally does
not calculate area geometry. Static bursts, lines, cones, emanations, and source-border placement
belong to the tactical grid/area layer; this bridge only asks which token footprints intersect the
field set that layer produced.
