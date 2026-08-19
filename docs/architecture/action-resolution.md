# Action Resolution Envelope

Wild Path's resolver pipeline needs a common plain-data envelope before it can safely coordinate
targeting, resources, rolls, reactions, effects, and Foundry document mutation.

The current pure foundation is `module/helpers/action-resolution.mjs`.

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

## Current Boundary

This helper does not:

- spend resources
- roll dice
- apply damage or healing
- create ActiveEffects
- write Foundry documents
- prompt users
- send socket messages

Those responsibilities belong to future resolvers and Foundry adapters. The context/result helper
only provides the common data shape they should compose.

`module/resolvers/action-resolver.mjs` now uses this envelope for the current cost-only action flow.
It is the first resolver consumer, not the final action pipeline.

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
- homebrew test/preview mode
- action bar availability explanations
- debug/audit traces
