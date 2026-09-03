# Reference Systems Policy

WildPath may inspect mature systems for architectural evidence, but the repository's own
contracts remain authoritative. Reference code is not a dependency, a template, or a source of
copied implementation.

## Current Runtime Slice

The combat-statistics runtime slice chose a small WildPath-native bridge rather than a new
statistics architecture:

```text
Actor system data
+ WildPathActor#getStatistic(domain)
-> serializable combat-stat snapshot
-> staged Action pipeline
-> pure AttackResolver
```

Implemented boundary:

- `system.defenses.ac.value` is the canonical persisted Actor baseline for Armor Class.
- `module/helpers/combat-statistics.mjs` combines persisted bases with
  `getStatistic("defense.<key>")` and `getStatistic("attack.<statistic>")` modifiers.
- `foundryActionIntentToStagedOptions()` snapshots those values into plain staged inputs.
- `AttackResolver` remains pure and does not read Actor documents.

This resolves the production-entry melee gap without starting the full Character System.

## Movement Path Slice

The topology-aware MovementPath slice stayed WildPath-native:

```text
ordered GridField anchors
+ TokenGridFootprint reconstruction
+ runtime cost/legality policies
-> existing movement budget helpers
```

Targeted PF2e movement files inspected:

- `src/module/canvas/token/ruler.ts`
- `src/module/canvas/token/movement/terrain-data.ts`
- movement speed references under `src/module/actor/creature/` and
  `src/module/system/statistic/speed.ts`

Lessons adopted:

- Movement type/speed identity should remain separate from path measurement.
- Movement cost can be adjusted per segment, with teleport able to contribute zero ordinary cost.
- Canvas/ruler presentation can explain movement cost, but it should not become WildPath's pure
  route authority.

Lessons deliberately not adopted:

- Pathfinder action-cost math, terrain rules, roll-option machinery, or movement-mode rules.
- Foundry canvas globals or Token movement APIs inside the pure MovementPath contract.
- Any copied implementation.

Crucible was later consulted online as the primary Foundry-facing movement benchmark for the
runtime Token movement slice. Its movement code was used only to identify Foundry lifecycle seams
and movement-operation invariants, not as source code to copy.

## PF2e Reference

Local reference inspected:

```text
C:/Users/cheat/Documents/GitHub/WildPath-references/pf2e-v14
branch: v14-dev
commit: 7afb550babd9c429ed21b46a2c6a9c0ffef10339
```

Targeted files:

- `src/module/system/statistic/base.ts`
- `src/module/system/statistic/statistic.ts`
- `src/module/system/statistic/armor-class.ts`
- `src/module/actor/base.ts`
- `src/module/actor/modifiers.ts`

Lessons adopted:

- Mature attack/defense values are derived from persisted Actor inputs plus collected modifiers.
- Modifier domains/selectors need provenance and trace data for future inspection.
- The resolver should consume a prepared value, not inspect document state while resolving.

Lessons deliberately not adopted:

- PF2e's full roll-option, synthetics, Statistic, Check, and DC architecture.
- Pathfinder-specific AC, proficiency, item, armor, and shield rules.
- Any PF2e runtime dependency or test dependency.

WildPath already has `WildPathStatistic`, `WildPathModifier`, RuleElements, Predicates, and
ValueExpressions. The slice therefore added only the missing Actor defense baseline and a small
snapshot helper.

## Crucible Reference

No local Crucible checkout was present under the local reference directories. Crucible was
consulted online only as a Foundry V14 integration benchmark:

- `crucible.mjs` registers `CONFIG.Actor.documentClass` and `CONFIG.Actor.dataModels` during
  Foundry initialization.
- Its actor sheets expose prepared Actor system data through ApplicationV2/DocumentSheetV2-style
  sheet contexts.
- It treats Foundry document/data-model configuration as infrastructure, not as a rules resolver.

Lessons adopted:

- Keep Foundry registration and document access at infrastructure/runtime boundaries.
- Let Actor system data expose persisted inputs; do rule interpretation in WildPath services.
- For Token movement approval, prefer the async TokenDocument lifecycle seam over non-awaited hooks
  when movement must wait on authority. For post-movement accounting, use Foundry's post-update
  `moveToken` hook rather than `TokenDocument#_onUpdateMovement`.
- Distinguish actual movement from action/planned movement with movement identity and explicit
  metadata rather than guessing from route shape.
- Commit post-movement accounting only after Foundry reports the movement completed, and make
  duplicate completion handling idempotent.

Lessons deliberately not adopted:

- No Crucible source was copied, vendored, or structurally adapted.
- Crucible-specific rules, UI layout, sheet state, and document model organization are not
  WildPath requirements.
- Crucible's action-point movement math, forced-movement labels, and Foundry measured movement cost
  are not WildPath mechanical authority.

## Foundry V14 Verification

Official Foundry V14 documentation confirms the platform assumptions used here:

- `TypeDataModel#defineSchema()` is the correct place to define system Actor data fields.
- `prepareBaseData()` and `prepareDerivedData()` are data-preparation hooks for derived in-memory
  values.
- Data preparation should assign in memory and should not call document mutation APIs such as
  `update()` or `setFlag()`.
- V14 data fields are persisted by default unless explicitly marked otherwise.
- `DataModel#toObject(source=true)` returns a plain object drawn from the underlying source values
  when `source` is true, rather than transformed/prepared values.
- `TokenDocument#_preUpdateMovement()` is an awaited protected lifecycle seam after movement has
  been determined; final waypoints can be rejected but not rewritten there.
- `preMoveToken` is cancellable but is a hook, not an async authority boundary.
- `TokenDocument#getCompleteMovementPath()` expands intermediate steps between supplied waypoints;
  the Token's current origin must be supplied explicitly when it should participate in expansion.
- `TokenDocument#getOccupiedGridSpaceOffsets(data?)` accepts an optional position plus Token
  dimensions. Zero-argument calls use the prepared/current Token state; explicit data evaluates the
  requested position.
- `TokenDocument#_onUpdateMovement()` is protected movement update post-processing and is not the
  authoritative settled completion seam for WildPath budget accounting.
- `moveToken` fires after conclusion of the Token update workflow and on all connected clients after
  the update has been processed. Normal movement budget accounting starts there.
- `TokenMovementOperation.finished` resolves true when the entire movement completed and false when
  it did not. WildPath requires both `moveToken` observation and `finished === true` before spending
  ordinary movement budget.
- `Token#planMovement()` and `TokenDocument#startMovement()` are the future planned-movement seam.

Primary sources:

- https://foundryvtt.com/api/v14/modules/foundry.data.html
- https://foundryvtt.com/api/v14/classes/foundry.abstract.DataModel.html
- https://foundryvtt.com/article/system-data-models/
- https://foundryvtt.com/api/classes/foundry.documents.TokenDocument.html
- https://foundryvtt.com/api/v14/functions/hookEvents.preMoveToken.html
- https://foundryvtt.com/api/v14/interfaces/foundry.documents.types.TokenPreMovementOperation.html
- https://foundryvtt.com/api/v14/interfaces/foundry.documents.types.TokenMovementOperation.html
- https://foundryvtt.com/api/v14/classes/foundry.canvas.placeables.Token.html
- https://github.com/foundryvtt/crucible/blob/master/crucible.mjs
- https://github.com/foundryvtt/crucible/blob/master/module/documents/token.mjs

## Ongoing Rule

Use references to answer specific questions:

```text
What invariant does a mature system preserve?
Which Foundry lifecycle/API boundary is appropriate?
Which complexity is unnecessary for WildPath right now?
```

Do not use references to justify premature architecture, named-feature workflows, copied code, or
runtime dependencies.
