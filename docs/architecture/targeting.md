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

## Eligibility

Base eligibility is applied after physical inclusion. The current helper supports ordinary
restrictions through a shared structured predicate evaluator:

- target kind
- disposition
- willing targets
- tags
- conditions
- structured predicate equality/one-of logic

Future `TargetResolver` should adapt ActionDefinition target rules into this policy shape.

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

## Selection Requests

`createTargetSelectionRequest()` produces structured future UI state:

- physically in area
- selected
- selectable
- deselectable
- ineligible
- predicate rejection reason
- chooser
- required/allowed counts

Battlefield highlights should be derived from this state, not stored as UI-only color decisions.

## AoE Integration

When the tactical grid foundation exists, the adapter should be:

```text
GridFootprint
-> AreaCandidateResolver
-> TargetSet
-> TargetEligibilityResolver
-> TargetRefinementResolver
-> per-target resolution contexts
```

Refinement must not mutate the `GridFootprint`; preview and resolution footprints remain the same.
