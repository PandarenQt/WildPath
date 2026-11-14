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

An ActionDefinition's `targeting` also carries four defaulted flags the authority
(`foundry-multiplayer-runtime.mjs`) checks against the declared targets, separate from `eligibilityPolicy.willing`
above:

- `notHostile: true`: "a willing creature". A target hostile to the source (Token disposition) is refused with
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
