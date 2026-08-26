# ActionDefinition

`ActionDefinition` is Wild Path's canonical persisted mechanical representation of an Action.

```text
Item / Feature / Spell
-> ActionDefinition
-> action configuration / per-use inputs
-> ActionResolver / ResolutionPipeline
```

The definition describes what an action can do. It must not store what happened during one use.

## Ownership

The Action domain owns:

- stable action identity
- source/provenance
- semantic activation
- declared costs
- origin policy
- range, targeting, and area requirements
- attack/save/check declarations
- damage, healing, and effect application components
- duration metadata
- future configuration hooks
- action-scoped RuleElements
- resolution policies

Owning resolver domains still interpret their parts. `ActionDefinition` does not calculate attack
bonuses, place templates, roll saves, apply damage, heal Actors, create ActiveEffects, spend
resources, open reactions, or mutate Foundry documents.

## Persisted vs Runtime Data

Persisted definitions may contain:

- canonical distances such as `5 ft`, `30 ft`, `60/120 ft`, `touch`, `self`, or `sight`
- semantic target requirements and predicates
- area shape/size/placement semantics
- attack/save/check declarations
- damage and healing `ValueExpression` components
- effect references or typed condition application definitions
- semantic durations
- configuration placeholders
- RuleElements

Persisted definitions must not contain:

- selected current targets
- current roll results
- current save outcomes
- resolved grid footprints
- chosen upcast level for this use
- current reaction answers
- temporary resolver stage/state
- live Foundry Documents, Tokens, canvas coordinates, DOM state, or executable functions

Runtime adapters merge volatile data into the definition before planning. Examples include selected
targets, already-resolved physical target candidates, attack roll totals, save roll totals, damage
roll totals, target Actor system snapshots, selected payment option, and authority data.

## Schema

Action Items now persist `system.definition` with this composed shape:

```text
ActionDefinition
|- identity/source/origin
|- activation
|- costs
|- range?
|- targeting?
|- area?
|- attack?
|- save?
|- check?
|- damage[]
|- healing[]
|- effects[]
|- duration?
|- configuration[]
|- ruleElements[]
|- policies
|- metadata
```

The Foundry DataModel stores component arrays as plain objects and delegates semantic validation to
`module/helpers/action-definitions.mjs`. This keeps the Foundry schema stable while the pure domain
contract evolves.

`schemaVersion` is currently `1`. Future persisted changes should migrate deterministically based on
that field instead of inferring meaning from labels or opaque payloads.

## Component Model

Damage and healing are separate component arrays. Healing is not negative damage.

Damage components preserve:

- `expression`
- `damageType`
- provenance/category
- weapon-size scaling metadata
- predicates
- target/outcome policy metadata
- source and trace metadata

Healing components preserve:

- `expression`
- `healingType`
- predicates
- target policy
- scaling metadata
- source and trace metadata

Expressions use the shared `ValueExpression` contract. Predicates use the shared `Predicate`
contract. Rule contributions use the shared `RuleElement` contract. No duplicate expression,
predicate, or rule-element language belongs inside action persistence.

## Resolver Integration

`ActionResolver` now loads and validates an action definition at the start of planning.

```text
Action Item
-> actionDefinitionFromAction()
-> validateActionDefinition()
-> actionDefinitionToResolverInput()
-> TargetResolver / AttackResolver / SaveResolver / DamageResolver / HealingResolver / EffectResolver
-> ResourceResolver
```

If a persisted definition is invalid, resolution fails during validation with
`ACTION_DEFINITION_INVALID`; resource payment is not planned.

Definition-derived resolver input supplies mechanical defaults. Runtime input may still provide
current-use data. For example:

- definition supplies attack type/statistic/defense key
- runtime supplies attack roll total
- definition supplies save key/DC source
- runtime supplies per-target save rolls
- definition supplies damage/healing components
- runtime may overlay rolled component totals
- definition supplies target predicates/counts
- runtime supplies current target candidates or selected targets

## Relationships

Action Economy:

Actions declare cost requirements. `ResourceResolver` and the Action Economy domain discover and
commit payment options. ActionDefinition does not decide which Actor resource satisfies a cost.

Spatial:

Actions persist semantic range and area definitions. Spatial services convert those definitions to
runtime tactical distances and grid footprints. ActionDefinition never stores a current
`GridFootprint`.

Targeting:

Actions persist target requirements, predicates, and selection limits. `TargetResolver` consumes
runtime target sets/candidates and produces target contexts.

Effects and Conditions:

Actions persist effect application definitions. The current resolver supports condition effect
planning. Generic ActiveEffect creation remains a later EffectResolver slice.

RuleElements:

Action-scoped RuleElements are persisted as ordinary RuleElements. They describe contributions;
owning domains interpret them. They are not embedded action scripts.

Configuration:

`configuration[]` is reserved for future action configuration declarations such as casting level,
optional enhancements, action modes, or resource-dependent scaling. This milestone does not
implement the full configuration system.

Resolution State:

`ActionDefinition` feeds resolver requests and traces. Mutable state stays in `ActionContext`,
`ActionResult`, target contexts, roll results, mutation plans, and future `ResolutionState`.

## Migration And Compatibility

Existing Action Items that only have legacy `system.cost` data are adapted into a version-1
definition in memory. The migration is deterministic:

- identity comes from Item id/uuid
- source points at the Item
- costs come from the existing Action cost shortcut
- no attack/save/damage/healing/effect mechanics are invented
- metadata records `migration.from = "legacy-action-cost"`

This compatibility path preserves existing cost-only behavior and does not rewrite Item documents
yet. A future data migration can persist generated definitions once the broader content import path
is ready.

## Extension Guidelines

When adding a new action component:

- add the persisted component shape to `ActionDefinition`
- validate it in the pure helper
- keep values JSON-serializable
- use existing `Predicate`, `ValueExpression`, `Modifier`, and `RuleElement` contracts
- adapt the component into the owning resolver's public input shape
- keep live Foundry objects and UI state out of persistence
- add round-trip, validation, non-mutation, and resolver integration tests

Do not add feature-, spell-, class-, or monster-name branches to `ActionResolver` when a declarative
component can express the mechanic.

## Current Limits

The current integration still does not:

- roll dice
- prompt for targets
- place or render areas
- derive attack bonuses or save DCs from Actor statistics
- commit generic non-condition ActiveEffects
- implement action configuration choices
- open reaction windows

Those remain separate milestones. This foundation closes the persistence gap so future slices can
start from a canonical ActionDefinition instead of requiring callers to hand-assemble every
mechanical resolver payload.
