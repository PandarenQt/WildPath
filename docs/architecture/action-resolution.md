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

`module/resolvers/reaction-resolver.mjs` consumes semantic events from that staged flow and can open
generic `reaction-choice` windows that create child `ResolutionState` objects. The staged action
pipeline now has opt-in action-declared and after-attack-outcome windows; broader timing coverage
should be added only when concrete semantic events need it.

## Damage to its own source (2026-11-01)

An Action's `sourceDamage` (damage components, as `damage`'s) is damage it deals its own source: Overchannel's backlash,
and later a cursed item or a homebrew blood magic. A configuration choice may add it (`add-source-damage`,
action-configuration.md).

- **Rolled after its damage**, in the damage roll stage once the Action's own damage (and an Empowered reroll) is done,
  each component its own roll request (`source-damage-roll`). Never doubled by a critical hit, maximized or rerolled;
  rolled even when every attack missed. A component with no dice left (Overchannel's free first use) is not rolled.
- **Planned with its damage**: the damage stage adds a result on the source beside its targets' (`withSourceDamage`), so
  one durability plan covers both (a caster inside its own Fireball takes each from one snapshot), the commit is the
  same transaction, and the concentration stage checks the source's Concentration as any damaged creature's. A
  component of 0 is left out.
- **It threatens the concentration the Action starts** (`startingConcentration`): the damage comes once the spell is cast,
  so a source starting a concentration with it checks to keep that one, concentrating before or not. A failed check
  drops the Action's planned concentration effects and sets `concentrationResolution.startedLost`; the runtime then ends
  what the source sustains once the Action completes (its lasting area's, summons' or marker's effects:
  `endLostConcentration`).
- **`ignoreResistance` / `ignoreImmunity`** on a damage component (any, not only these) skip every Resistance
  to it (a Resistance to all damage too), or any Immunity to it (damage-adjustment-resolver.mjs). Vulnerability still applies.
- **The runtime** registers the acting creature like a target (its snapshot, damage profile, commit key and
  concentration state, given even when it concentrates on nothing yet if the Action starts a concentration) when the
  Action has `sourceDamage` or a choice that adds some. `sourceDamage` is a persisted Action schema field
  (`actionDefinitionField`).
- shortcut: an area that caught nobody skips its damage stages, so no backlash either; upgrade if a feature needs it.

## Healing for its user, or one creature its user picks (2026-11-16)

A healing entry with `appliesTo` (action-definitions.md "Component Model") is healing the Action gives its own user or
one creature its user picks, earned by what it did. It is the healing sibling of `sourceDamage`.

- **Kept apart from its targets' healing**: the resolver input splits it into `ownHealing` (input only, never persisted),
  so every target-healing path (`healing`, Life Bond, Blessed Healer, a runtime healing bonus) never sees it, and an Action
  whose only healing is its user's has no target healing at all.
- **Who earns it** (`ownHealingEarned`): an effect's target selection (`conditionEffectTargetsForRequest`) with the
  entry's `saveOutcomePolicy`: the creatures whose save matches, else on an attack those it hit, else each target.
- **The pick and the dice, in the healing roll stage**: an earned `{from}` entry is picked first (`redirectChoice`,
  request `healing-choice`, the `WILDPATH.TARGET_CHOICE` prompt): `"target"` around the first creature that earned it
  (never that creature, Q78), `"area"` around its user, at any distance, among the creatures that earned it (Q77). The
  `around` search leaves hidden and dead creatures out. Then each earned entry with dice and someone to heal is rolled,
  once however many earned it (Q79), request `own-healing-roll`, kind `ownHealing` (physical dice too).
- **The amount, in the healing stage** (after damage): a `{damage}` amount is the planned `durabilityDamage` of the
  creatures that earned it (`damageDealt`, shared with an effect's amount), put through its expression. None at 0.
- **Planned on its own**: a healing result on its creature (the card's row) and a separate `durabilityHealing` plan,
  after any damage plan of this Action on the same creature; the commit rebases each plan on the creature as it is then,
  so a creature damaged and then picked (Land's Aid) is healed from what the damage left. Life Bond reads the user's
  share too (a spell's: Vampiric Touch's caster's steed); Blessed Healer counts only other creatures.
- **The runtime** commits on its user (`healsSource`: its uuid in `targetActors`) and scans its user's own bonded steeds;
  a picked creature is registered by `redirectCandidates`.
- shortcut: "a creature it can see" is not checked for the pick (hidden Tokens are no candidates); upgrade with a sight part.
- shortcut: Disciple of Life-style healing bonuses (the runtime's healing statistic) reach only target healing.

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
