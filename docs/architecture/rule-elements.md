# RuleElements

RuleElements are Wild Path's declarative rule-contribution layer.

```text
Predicate
+ ValueExpression
+ Modifier
+ RuleElement
-> owning domain interpreter
```

A RuleElement is serializable data carried by an Item, ActiveEffect, condition, feature, class,
species, feat, spell, transformation, temporary effect, or homebrew package. It describes a
mechanical contribution. It is not a mini-resolver and must not directly mutate Actors, Items,
ActiveEffects, Tokens, the canvas, chat, or UI state.

## Runtime

`module/helpers/rule-elements.mjs` contains the pure RuleElement registry and collector.

The default registry currently supports these contribution types:

- `Modifier`
- `GrantResource`
- `GrantActionEconomyResource`
- `GrantResistance`
- `GrantImmunity`
- `GrantMovement`
- `Trigger`

Handlers return contribution bundles only:

- `modifiers`
- `resources`
- `economyResources`
- `damageAdjustments`
- `movement`
- `triggers`

Owning domains consume those bundles. For example, `Modifier` RuleElements feed
`WildPathStatistic`; damage adjustment RuleElements produce a profile for
`DamageAdjustmentResolver`; trigger RuleElements produce existing automation trigger definitions.

## Authoring Shape

Persisted RuleElements use a stable common envelope:

```js
{
  schemaVersion: 1,
  id: "feature.dueling.attack",
  type: "Modifier",
  label: "Dueling",
  predicate: {tagsAny: ["weapon-attack"]},
  priority: 100,
  enabled: true,
  suppressed: false,
  data: {
    domains: ["attack.melee"],
    modifierType: "status",
    valueExpression: {type: "constant", value: 2}
  },
  metadata: {}
}
```

Common fields belong at the top level. Type-specific fields belong under `data`; this lets the
Foundry data schema preserve RuleElements without changing every time a new handler is added.

`type` is the canonical key. The pure normalizer also accepts `key` and a few lowercase aliases so
future importers can adapt external data before persistence.

`schemaVersion` is required in persisted data and currently defaults to `1`. Future migrations
should use this field to upgrade RuleElement definitions deterministically instead of inferring
version from an opaque payload.

## Evaluation

RuleElements use the shared Predicate and ValueExpression evaluators. They do not evaluate
JavaScript, parse arbitrary formula strings, or call Foundry APIs.

The lifecycle is:

```text
raw definition
-> serializability and schema validation
-> Predicate validation/evaluation
-> registry handler lookup
-> handler-owned payload validation
-> contribution bundle
-> trace
```

Evaluation is ordered by `priority`, then stable id. Each entry emits a trace with one of:

- `contributed`
- `disabled`
- `suppressed`
- `predicate-failed`
- `failed`

Invalid or unknown RuleElement types fail explicitly in the collector result. Disabled,
suppressed, or predicate-failed entries fail closed by contributing nothing while remaining visible
to rules-inspector tooling.

The registry is deliberately small and centralized. Registering the same normalized type twice
throws unless the caller explicitly passes a replacement option. Adding a new RuleElement type
should therefore be a localized Rules-domain change plus tests for its owning contribution shape.

## Validation And Serialization

`validateRuleElementDefinition()` rejects non-plain or non-JSON data, including functions,
symbols, bigint values, circular structures, and non-finite numbers. Invalid Predicate shapes are
reported as invalid RuleElements rather than silently skipped as ordinary predicate failures.

`serializeRuleElementDefinition()` returns a normalized plain definition suitable for:

```text
serialize
-> persist
-> reload
-> validate
-> evaluate
```

RuleElement evaluation clones authored data before dispatch and must not mutate the definition or
the evaluation context.

## Persistence

The base Item and ActiveEffect data models now persist:

- legacy `modifiers`
- new `ruleElements`

Legacy `modifiers` remain supported so existing data keeps working. New content should prefer
RuleElements unless it is intentionally writing the low-level modifier primitive directly.

## Current Integration

`WildPathActor#getStatistic(domain)` consumes `Modifier` RuleElements from active embedded Items
and applicable ActiveEffects alongside legacy modifier entries.

`ConditionTriggerResolver` consumes `Trigger` RuleElements from condition ActiveEffects and matches
them against semantic events such as `turn.started`. Its current payload support is intentionally
narrow: a condition trigger may plan a durability change through `DurabilityResolver`, but it does
not execute an action, open a reaction window, roll damage, create chat, or mutate a document.

`Bleeding` is the representative migrated condition:

```text
Bleeding condition config
-> persisted Trigger RuleElement
-> turn.started
-> ConditionTriggerResolver
-> DurabilityResolver mutation plan
-> WildPathActor Foundry update adapter
```

`system.dot` remains as a temporary compatibility payload for old condition effects. If a
condition effect has no `ruleElements`, `ConditionTriggerResolver` translates legacy dot ticks
into synthetic Trigger RuleElements. If persisted RuleElements exist, they are authoritative and
legacy dot data is ignored to avoid double application.

Other contribution types are available as pure collected data but are not globally wired into
Foundry document preparation yet. Future resolvers should request the relevant RuleElement bundle
and interpret it inside their own domain boundary instead of adding item-, spell-, class-, or
condition-name branches.

## Future Types

When adding a RuleElement type:

- define the persisted payload shape
- register one handler in the central registry
- validate the handler payload before contributing
- preserve source and RuleElement provenance in every contribution
- return plain contribution data only
- add pure tests for validation, predicate behavior, serialization, and non-mutation
- let the owning domain decide what the contribution means

## Boundaries

RuleElements must stay:

- declarative
- serializable
- inspectable
- testable without Foundry canvas/UI
- owned by domain interpreters

They must not become:

- script hooks
- embedded resolver implementations
- document mutation commands
- UI behavior definitions
- special-case feature branches

This keeps later content authoring broad without forcing every resolver to learn every possible
feature, item, condition, or spell name.
