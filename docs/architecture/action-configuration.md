# Action Configuration And Authoritative Preview

`ActionConfiguration` is Wild Path's Application-layer bridge between persisted action mechanics
and one concrete use of an action.

```text
ActionDefinition
-> Configuration Discovery
-> ActionChoiceRequest[]
-> Choice Responses
-> ResolvedActionConfiguration
-> ResolvedActionPreview
-> ActionResolver / ResolutionPipeline
```

## The Three Shapes

`ActionDefinition` answers what the action can do. It is persisted content and must not contain
current-use choices such as a selected spell slot, selected damage type, current targets, rolls, or
resource commits.

`ResolvedActionConfiguration` answers how the user is choosing to use that action this time. It
contains selected payments, selected options, casting level when a resource choice supplies one,
selected damage types, applied sources, a compact trace, the base definition, and the effective
definition produced by applying those choices. It must not mutate the underlying ActionDefinition.

`ResolvedActionPreview` answers what the configured action is expected to cost and do before any
rolls or document mutations occur. It is prospective state, not an outcome. It can show dice
expressions, damage types, range, area, target count, save/check declarations, effects,
conditions, costs, resource consequences, selected options, and structured deltas from the base
definition.

## Choice Lifecycle

`module/helpers/action-configuration.mjs` currently owns the pure foundation:

```text
discoverActionConfigurationChoices()
-> resolveActionConfiguration()
-> createResolvedActionPreview()
-> validateResolvedActionConfiguration()
```

Discovery returns `ActionChoiceRequest` records with:

- stable choice id
- discriminated choice type
- label and optional description metadata
- source/provenance
- required/optional status
- legal options
- min/max constraints where relevant
- predicates
- dependency data
- conflict data
- a state fingerprint for UI/debug use

The initial choice types are:

- `select-one`
- `select-many`
- `boolean`
- `number`
- `resource`
- `damage-type`
- `option`

Choice responses are validated by the configuration layer, not trusted from UI state. Invalid
options, inactive dependent choices, unavailable resources, invalid damage types, conflicts,
missing required choices, and exceeded selection limits return structured failures.

## Domain-Contributed Choices

Configuration choices can come from:

- `ActionDefinition.configuration[]`
- feature/item/effect/rule contributions supplied by the caller
- future RuleElement contribution bundles
- homebrew builder output

The configuration service coordinates those records but does not know named mechanics. For
example, an elemental-conversion feature may contribute:

```text
boolean choice: enable conversion
damage-type choice: choose from cold/lightning
effect: replace selected damage components
effect: add 1 sorcery-point cost
```

The service applies the generic effects. The feature decides whether the option exists, which
damage types are legal, which damage components are affected, what the cost is, and what source
provenance should be preserved.

## Payment Integration

Resource choices call the existing Action Economy payment discovery. The configuration layer does
not duplicate action-economy eligibility, depletion, alternative payment, or resource restriction
logic.

The current flow is:

```text
configuration resource choice
-> resolvePaymentOptions()
-> selected payment plan
-> effective ActionDefinition cost
-> ResourceResolver revalidation
```

`ResourceResolver` can now validate an exact selected payment plan in addition to a generated
payment option id. This matters because game state can change between preview and commit. If the
preview selected a 5th-level slot and that slot is gone before resolution, validation fails before
payment is planned or committed.

No resource is spent during discovery, configuration, preview, or revalidation. Spending remains a
resolution transaction concern.

## Scaling

Scaling is declarative and applied to a cloned effective definition. The initial generic effect is
`scaleDamage`, which can increase selected damage components by a dice increment per selected
level above a base level.

Example:

```text
base component: 8d6 fire
base level: 3
selected level: 5
increment: +1d6 per level above base
effective component: 10d6 fire
```

The selected level can come from resource choice metadata such as a spell-slot or Pact-slot
payment option. The service does not hardcode spell names or spell-slot fields.

## Damage Type Substitution

Damage-type choices are never a universal arbitrary dropdown. They only appear when a rule source
contributes a legal damage-type request. The request must provide the legal replacement damage
types and a generic effect such as `replaceDamageType` that names the affected damage components.

The preview records before/after damage-type deltas and source provenance, such as a feature or
homebrew rule that supplied the substitution.

## Preview Semantics

Preview is safe to call repeatedly. It may inspect current actor resource state, choices, and
plain resolver context, but it must not:

- spend resources
- reserve resources
- roll attacks, saves, checks, damage, or healing
- create or update ActiveEffects
- mutate Actors, Items, Tokens, Scenes, Regions, Combat, or UI state
- move tokens
- treat prospective dice as rolled outcomes

Preview can show:

```text
Damage on hit: 10d6 lightning
Cost: 5th-level slot + 1 sorcery point
Changes: 8d6 -> 10d6, fire -> lightning
```

It must not claim:

```text
will deal 35 lightning damage
```

unless a later roll/physical-dice adapter has supplied actual resolved amounts to the resolution
pipeline.

## Preview And Resolution Identity

The hard invariant is:

```text
previewed configuration
= committed configuration
= resolution configuration
```

`ActionResolver` now accepts raw configuration responses or a `ResolvedActionConfiguration`. It
uses the effective definition produced by the configuration helper and passes the selected payment
plan to `ResourceResolver` for exact revalidation. If revalidation fails, resolution fails during
validation with `ACTION_CONFIGURATION_INVALID`; no payment event or mutation plan is produced.

The result context stores a compact `resolvedActionConfiguration` metadata summary so audit tools
can explain which choices drove the resolution without requiring UI code to reconstruct it.

## Deltas And Provenance

Preview deltas are generated from structured before/after state:

- `damage-expression`
- `damage-type`
- `cost-added`

Configuration changes add provenance to affected components and cost requirements. This data is
intended for the future Rules Inspector, chat summaries, debugging tools, and homebrew validation.

Do not write feature-specific explanatory prose such as "Transmuted Spell changed fire to
lightning" inside the resolver. A renderer can turn the structured delta and source into friendly
text later.

## Target Refinement Separation

Action Configuration answers:

```text
How am I using this action this time?
```

Target refinement answers:

```text
Which physical/eligible targets are selected, excluded, protected, or overridden?
```

They may share a future HUD panel and the current PromptPort bridge, but they remain separate
domains. Damage type substitution, casting level, and optional enhancement costs belong to
configuration. Sculpt-style target exceptions, per-target save overrides, and
exclusion/protection choices belong to targeting/refinement.

## HUD And Builder Consumption

The current generic prompt adapter and the future HUD should render `ActionChoiceRequest[]` and
`ResolvedActionPreview` directly:

```text
CAST AT
[3rd] [4th] [5th]

OPTIONAL MODIFIERS
[Elemental Conversion]

DAMAGE TYPE
[Cold] [Lightning]

RESULT
10d6 Lightning

COST
5th-level slot
1 Sorcery Point

CHANGES
8d6 -> 10d6
Fire -> Lightning
```

The HUD must not calculate upcast damage, replacement damage types, or resource legality itself.

The homebrew builder should compile friendly authoring choices into the same configuration
definitions and generic effects used by first-party content. There should not be a separate
homebrew configuration engine.

## Current Limits

This foundation does not build the finished HUD, spell sheet, or homebrew builder. It also does
not roll dice, derive attack bonuses, derive save DCs from full actor statistics, reserve
resources, open reaction windows, or implement target-aware resistance warnings. Those remain
separate slices over the same resolved configuration and resolver contracts.

## Upcast Targets Are "Up To" (2026-10-19)

`scaleTargets` raises `targeting.count` and keeps `refinementPolicy.minSelections` at the base count: 2024's "you can
target one additional creature" is optional. Before, Command from a 3rd-level slot needed exactly three targets.

## Spending A Chosen Amount (2026-10-19)

A configuration effect `{type: "spendAmount", resourceId, componentIds, collection?, per?}` on a `number` choice adds
that many of the pool to the Action's cost and makes each listed healing (or damage) component that amount (times
`per`). 2024 Lay on Hands: "restore a number of Hit Points equal to the points spent". Spending more than the pool
holds is refused at payment, before anything rolls.

## An option's own effects, and restoring a pool (2026-10-19)

- **An option's `effects`.** An option of a `select-one` choice may carry its own effects, applied after its choice's
  when it is chosen (Font of Magic: each slot level adds its cost in Sorcery Points and restores that slot).
- **`{type: "restore", resourceId, amount?}`** adds a pool of the acting creature to the Action's `restores`, refilled
  at payment up to its maximum. Its amount is by default the level its choice selected (`levelChoiceId`: a spent slot's
  level in Sorcery Points). It is refused when the creature lacks the pool or the pool is full.

- **Metamagic's effects (2026-10-19):**
  - `{type: "replace-cost", from, to}` pays one activation cost as another (Quickened Spell: `action` as `bonus-action`).
    The action bar keeps an Action usable when such an option of its own could be paid.
  - `{type: "set-range", range}` sets its range (Distant Spell).
  - `{type: "scale-duration", factor}` multiplies its effects' and concentration's durations (Extended Spell).
  - `replace-damage-type` takes a fixed `damageType` too (Transmuted Spell).

## One of its own weapons, and binding a choice (2026-10-19)

- **`optionsFrom: {type: "weapons", melee?, bases?}`** on a `select-one` choice lists its creature's own weapons whenever
  the Action is read (`withOwnWeapons` in `actionDefinitionFromItem`). That is the attack Actions with `attack.weapon`,
  one per weapon, keyed by the gear that grants the attack (else the attack itself). `melee` and `bases` narrow it
  (Shillelagh: a club or quarterstaff). The client's prompt and the authority read the same options, so an id that is
  not one of its weapons is refused.
- **`bindChoice`** (a choice's effect) writes the choice's value into the Action's effects wherever `{{<choice id>}}`
  stands: the weapon's id into a rule's predicate (`weapon:{{weapon}}`), or a slot choice's casting level where the token
  stands alone, as a number (`{type: "constant", value: "{{spell-slot}}"}`).

Weapon enchantments use both (content-packs.md): Magic Weapon, Sacred Weapon, Pact of the Blade and Shillelagh. A
weapon's attack carries `weapon:<id>` and its ability among its tags (rule-elements.md).

Live (two browsers, 14.369): Player1's QA Caster cast Magic Weapon at 3rd level on its Longsword. The Longsword's attack
went from +3 to +5 and its damage gained +2; the Dagger stayed at +3.
