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

Lessons deliberately not adopted:

- No Crucible source was copied, vendored, or structurally adapted.
- Crucible-specific rules, UI layout, sheet state, and document model organization are not
  WildPath requirements.

## Foundry V14 Verification

Official Foundry V14 documentation confirms the platform assumptions used here:

- `TypeDataModel#defineSchema()` is the correct place to define system Actor data fields.
- `prepareBaseData()` and `prepareDerivedData()` are data-preparation hooks for derived in-memory
  values.
- Data preparation should assign in memory and should not call document mutation APIs such as
  `update()` or `setFlag()`.
- V14 data fields are persisted by default unless explicitly marked otherwise.

Primary sources:

- https://foundryvtt.com/api/v14/modules/foundry.data.html
- https://foundryvtt.com/api/v14/classes/foundry.abstract.DataModel.html
- https://foundryvtt.com/article/system-data-models/
- https://github.com/foundryvtt/crucible/blob/master/crucible.mjs

## Ongoing Rule

Use references to answer specific questions:

```text
What invariant does a mature system preserve?
Which Foundry lifecycle/API boundary is appropriate?
Which complexity is unnecessary for WildPath right now?
```

Do not use references to justify premature architecture, named-feature workflows, copied code, or
runtime dependencies.
