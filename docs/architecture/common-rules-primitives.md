# Common Rules Primitives

Wild Path content should increasingly be authored as data that the resolution engine can inspect,
trace, serialize, and migrate. The current common rules vocabulary is:

```text
Predicate
+ ValueExpression
+ Modifier
-> RuleElement
-> ActionDefinition
-> ResolutionPipeline
```

This document covers the shared primitive vocabulary. Persisted ActionDefinition and the
addressable ResolutionPipeline should build on these contracts rather than introducing separate
predicate, formula, modifier, or rule-contribution shapes.

## Predicate

`module/helpers/predicates.mjs` is the canonical Predicate evaluator.

Predicates are plain structured objects. They are not functions and do not execute JavaScript. The
supported operations are:

- `all`
- `any`
- `not`
- `tagsAny`
- `tagsAll`
- `notTagsAny`
- `hasCondition`
- `missingCondition`
- `equals`
- `oneOf`

Subsystems such as targeting, automation events, inventory access, tactical areas, and Action
Economy must call this evaluator instead of carrying local predicate implementations. Invalid
predicate shapes fail closed with `INVALID_PREDICATE`; they should not silently pass.

## ValueExpression

`module/helpers/value-expressions.mjs` is the canonical safe numeric expression evaluator.

ValueExpressions are serializable rules data. They can represent:

- fixed constants
- context numeric paths
- ability scores and ability modifiers
- proficiency bonus
- character level
- class level
- spellcasting modifier
- resource current and max values
- addition, subtraction, multiplication, division, min, max, floor, and ceil
- dice expressions when a numeric total is supplied or an explicit average policy is requested

The evaluator does not parse or execute formula strings. Dice expressions without a supplied total
or explicit average mode remain representable data, but they do not evaluate to a number.

## Modifier

`module/helpers/modifiers.mjs` defines the shared modifier runtime shape.

A modifier can contain:

- stable `id`/`slug`
- selector/domain data
- modifier `type`
- `ValueExpression` value
- optional `Predicate`
- priority/order
- source/provenance
- metadata
- enabled and suppressed state

`WildPathStatistic` evaluates modifier predicates and values in a statistic context, applies
duplicate and stacking rules, and emits a structured trace for Rules Inspector-style tooling.
Sheets should display derived statistics from these traces; they should not recalculate rules.

The current Foundry data schema preserves the older numeric `value` field as a compatibility
shortcut and adds serializable `valueExpression`, `predicate`, `priority`, `metadata`, and
suppression fields for new content.

## RuleElement

`module/helpers/rule-elements.mjs` defines the shared RuleElement registry and collector.

RuleElements are declarative contribution records carried by Items, ActiveEffects, features,
conditions, classes, species, feats, spells, transformations, temporary effects, and homebrew
content. They are not mini-resolvers. A RuleElement should describe what it contributes, then let
the owning domain interpret that contribution.

The initial contribution types are:

- `Modifier`
- `GrantResource`
- `GrantActionEconomyResource`
- `GrantResistance`
- `GrantImmunity`
- `GrantMovement`
- `Trigger`

Items and ActiveEffects now persist `ruleElements` arrays next to legacy `modifiers`. New content
should prefer RuleElements so later mechanics can compose through `Predicate`, `ValueExpression`,
and `Modifier` instead of adding resolver-specific item or condition branches.

See `docs/architecture/rule-elements.md` for the full RuleElement boundary, authoring shape, and
current integration notes.

## Boundaries

These helpers are pure domain utilities. Foundry documents may gather Items, ActiveEffects, Actors,
or Tokens and adapt them into plain contexts, but the primitive evaluators themselves must not
query canvas, sheets, chat, or global UI state.

RuleElements consume these primitives directly. For example, a `Modifier` RuleElement produces
`ModifierDefinition` data whose `predicate` and `valueExpression` use these exact shapes.
