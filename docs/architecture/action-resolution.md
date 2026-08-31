# Action Resolution Envelope

Wild Path's resolver pipeline needs a common plain-data envelope before it can safely coordinate
targeting, resources, rolls, reactions, effects, and Foundry document mutation.

The current pure foundation is `module/helpers/action-resolution.mjs`.
The staged pause/resume foundation is `module/helpers/resolution-state.mjs`; see
`docs/architecture/resolution-state.md`.

Persisted Action Item mechanics now enter this envelope through
`module/helpers/action-definitions.mjs`; see `docs/architecture/action-definitions.md` for the
ActionDefinition ownership, schema, migration, and resolver-adapter contract.
Per-use choices enter through `module/helpers/action-configuration.mjs`; see
`docs/architecture/action-configuration.md` for Action Configuration and authoritative preview.

## ActionContext

`ActionContext` normalizes:

- action reference
- source Actor/Token reference
- targets and target sets
- area data
- resource state
- roll mode
- rules version
- policies
- emitted events
- metadata

It deliberately stores references and structured data, not live Foundry documents. New resolver
work should prefer the opaque string refs from `module/helpers/entity-refs.mjs`, with legacy
`actorId`/`tokenId` fields carried only as compatibility metadata while the pipeline migrates.
Foundry adapters can build this context from Actors, Items, Tokens, selected targets, and Scene
state.

## ActionResult

`ActionResult` records:

- status and code
- validation and resolution steps
- semantic automation events
- planned consequences
- planned mutation operations
- errors and warnings
- metadata

The helper supports beginning, failing, cancelling, succeeding, and tracing a result. It is
immutable by convention: each operation returns a new result object and leaves the previous one
unchanged.

## Events, Consequences, and Mutation Plans

These are intentionally separate:

- Events describe rules moments for trigger/reaction planning.
- Consequences describe resolved game outcomes.
- Mutation plans describe what a future transaction would commit.

A resolver can therefore do dry-run previews, reaction prompts, and rollback-safe validation before
changing Actor, Item, ActiveEffect, Combat, or Scene state.

`module/resolvers/resolution-transaction-resolver.mjs` is the current ordered transaction boundary.
It commits prepared operations in order, requires rollback updates before any non-noop write, and
rolls already-committed operations back in reverse order if a later commit fails. Foundry document
writes occur through the `DocumentPersistencePort`; see
`docs/architecture/foundry-persistence-ports.md`.

`module/resolvers/effect-resolver.mjs` is the current condition-first effect planner. It can produce
condition mutation plans without writing ActiveEffect documents.

## Current Boundary

This helper does not:

- spend resources
- roll dice
- apply damage or healing
- create ActiveEffects
- write Foundry documents
- prompt users
- send socket messages

Those responsibilities belong to resolvers, transaction/persistence ports, PromptPort/RollProvider,
and the multiplayer socket adapter. The context/result helper only provides the common data shape
they should compose.

`module/resolvers/action-resolver.mjs` remains the compatibility facade for direct callers. It can
still plan persisted ActionDefinition-derived targeting, attack, save, damage, healing, condition
effects, and resource payment, then commit via `commitPlannedActionResult()`.

`module/resolvers/action-pipeline-resolver.mjs` is now the normal architecture-proof execution path.
It can pause for required configuration, target selection/refinement, attack/save/damage roll input,
then resume with correlated responses and continue through explicit stages:

```text
configuration
-> targeting
-> range
-> attack roll
-> attack outcome
-> save roll
-> save outcome
-> damage roll
-> damage
-> healing
-> effects
-> payment
-> ready-to-commit
-> commit
-> finalization
```

Representative vertical slices now commit their staged `ActionResult` directly rather than
delegating planning to `action.legacy-resolution`.

## Future Consumers

This foundation is intended for:

- `ActionResolver`
- `ResourceResolver`
- `TargetResolver`
- `AttackResolver`
- `SaveResolver`
- `DamageResolver`
- `HealingResolver`
- `EffectResolver`
- `ReactionResolver`
- `ResolutionTransaction`
- homebrew test/preview mode
- action bar availability explanations
- debug/audit traces
