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

## Evaluation

RuleElements use the shared Predicate and ValueExpression evaluators. They do not evaluate
JavaScript, parse arbitrary formula strings, or call Foundry APIs.

Evaluation is ordered by `priority`, then stable id. Each entry emits a trace with one of:

- `contributed`
- `disabled`
- `suppressed`
- `predicate-failed`
- `failed`

Invalid or unknown RuleElement types fail explicitly in the collector result. Disabled,
suppressed, or predicate-failed entries fail closed by contributing nothing while remaining visible
to rules-inspector tooling.

## Persistence

The base Item and ActiveEffect data models now persist:

- legacy `modifiers`
- new `ruleElements`

Legacy `modifiers` remain supported so existing data keeps working. New content should prefer
RuleElements unless it is intentionally writing the low-level modifier primitive directly.

## Current Integration

`WildPathActor#getStatistic(domain)` consumes `Modifier` RuleElements from active embedded Items
and applicable ActiveEffects alongside legacy modifier entries.

Other contribution types are available as pure collected data but are not globally wired into
Foundry document preparation yet. Future resolvers should request the relevant RuleElement bundle
and interpret it inside their own domain boundary instead of adding item-, spell-, class-, or
condition-name branches.

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
