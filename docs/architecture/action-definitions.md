# ActionDefinition

`ActionDefinition` is Wild Path's canonical persisted mechanical representation of an Action.

```text
Item / Feature / Spell
-> ActionDefinition
-> ActionConfiguration / per-use inputs
-> ResolvedActionPreview
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
|- controllerCosts   (a companion's Action: what its commanding controller also pays, companions.md)
|- range?
|- targeting?
|- area?
|- attack?
|- save?
|- check?          (the acting creature's own ability check, below)
|- damage[]
|- healing[]
|- effects[]
|- duration?
|- configuration[]
|- transform? / summon? / push? / moveArea? / teleport? / stabilize   (applied when the Action completes; push, moveArea: areas.md)
|- ruleElements[]
|- policies
|- metadata
```

The Foundry DataModel stores component arrays as plain objects and delegates semantic validation to
`module/helpers/action-definitions.mjs`. This keeps the Foundry schema stable while the pure domain
contract evolves.

## Custom effects (2026-10-14)

An effect entry is either a condition (`{type: "condition", conditionId}`) or a **custom effect**: a buff or
debuff with its own rules.

```js
{type: "effect", id: "blessed", name: "Blessed", slug?: "blessed", img?,
 ruleElements: [{type: "Modifier", data: {domains: ["attack"], value: 2}}],
 duration?: {value: 10, units: "rounds", expiry: "turnStart"}, saveOutcomePolicy?, concentration?}
```

- **Committing it.** It goes through the same plan and commit as a condition, carrying its own definition. It
  becomes an ordinary effect (`type: "effect"`) with its rules and the status `slug`. Without a slug the status is
  `<definition id>:<effect id>`.
  - A predicate can test it: `{hasCondition: "raging"}` for 2024 Rage.
  - Applying the same effect again refreshes it instead of stacking.
  - Its definition is stored in `flags.wildpath.conditionEffect.definition`.
- **Duration.** It is V14's own `{value, units, expiry}` (units and expiry events from V14 `CONST`). It starts on
  the source's combatant, so "until the start of your next turn" is the caster's turn, even for a reaction.
  - When V14 marks it expired, the active GM deletes it.
  - The active GM also registers unlinked Tokens' effects for expiry after a reload. V14 itself misses them until
    a Token's delta materializes.
  - Concentration still ends it. WildPath's own turn-based expiry leaves it alone.
- **Ending when attacked (2026-10-15).** `endsWhen: "attacked"` ends it once an attack against its creature has
  resolved, hit or miss, so it counts for that one attack ("the next attack roll against it has Advantage": Help,
  Guiding Bolt). The authority deletes it after the Action completes (`endEffectsWhenAttacked`).
  `"attackedBySource"` ends it only when the creature that applied it attacks its creature (Vex), and `"attacks"`
  when its own creature makes an attack roll (Sap). An effect the same attack has just applied to a creature it hit
  stays (2026-10-15).
- **Validation.** A custom effect needs a name, rules the engine knows, a slug that isn't a built-in condition,
  and V14 duration units. **Effects by reference (`type: "ref"`) are refused**: they used to validate and then be
  dropped when the Action ran.
- **Targeting.** A `self` Action targets its own creature and a `none` Action targets nobody, whatever the
  Player has targeted. The authority sets both.

Live (two browsers, 14.369):
- Player1's cleric blessed an ally: a "Blessed" effect, +2 to its attacks. It lasted one round and was deleted
  on the cleric's next turn, including after a GM reload.
- Player1's barbarian used Rage (a `self` custom effect with slug `raging`). Its feature's
  `{hasCondition: "raging"}` Modifier on `damage.melee` made the axe roll "1d12 + 2".

## Restores (2026-10-14)

`restores: [{resourceId, amount}]` refills pools of the acting creature when the Action is paid for, each up to its
maximum. It joins the payment's mutation plan, with what each pool held before, so the transaction can roll it
back. Multiattack uses it: it costs the Action and restores its "Multiattack" pool to its number of attacks.

A payment never refills a pool it drew from. Extra Attack depends on this: an attack paid from its pool must not
refill it (rule-elements.md, "Extra Attack").

## Up to N targets (2026-10-14)

A required `count` means exactly that many targets, unless `targeting.refinementPolicy.minSelections` says
otherwise. dnd5e's "up to three creatures" (Bless) converts as `{type: "multiple", count: 3, refinementPolicy:
{minSelections: 1}}`: one target is enough, three at most.

## Common actions (2026-10-14, after Baldur's Gate 3)

Every creature has the 2024 actions anyone can take, with no Items (`module/helpers/common-actions.mts`):

| Action | What it does |
| --- | --- |
| Dash | Dashing until the end of the turn: + the creature's Speed to its movement |
| Disengage | Disengaged until the end of the turn |
| Dodge | Dodging until the start of its next turn: attacks against it have disadvantage, its Agility saves advantage |
| Help | An enemy within 5 ft is Distracted until the start of your next turn: the next attack against it has advantage |
| Hide | A DC 15 Agility (Stealth) check; on a success, Invisible |
| Grapple | The target makes a Might save, DC 8 + Might modifier + Proficiency Bonus; on a failure, Grappled |
| Shove: Prone | The same save; on a failure, Prone |
| Shove: Push | The same save; on a failure, pushed 5 feet away (forced movement, areas.md) |
| Unarmed Strike | A melee attack for 1 + Might modifier bludgeoning damage |
| Search | The Action, then a Wits check: Insight, Medicine, Perception or Survival (chosen); the GM judges the total |
| Study | The Action, then an Intellect check: Arcana, History, Investigation, Nature or Religion |
| Influence | The Action, then a check: Deception, Intimidation, Performance, Persuasion or Animal Handling |
| Utilize | The Action, spent on an object (a lever, a lock); the card says so (2026-10-19) |
| Escape | Only while Grappled or Restrained with an escape DC: the better of Athletics and Acrobatics against it; a success ends that condition (2026-10-19) |
| Opportunity Attack | A reaction: the creature's first melee attack Action (else its Unarmed Strike), for its Reaction |

- **Built by the authority.** An intent names one as `actionRef: "common:<id>"`. The authority builds the Action
  from the system's own definition, so a client can name a common action but never supply its rules. An unknown id
  is refused.
- **On the bar.** The action bar lists them last, in a Common group, with the same availability and odds as any
  Action.
- **Search, Study, Influence (2026-10-18).** The skill is chosen first, from a list showing each one's bonus. Once
  the authority has taken the Action, the check is rolled as a sheet roll (`Actor#rollTest`), so it can be rerolled
  with Heroic Inspiration. 2024 sets no DC: the GM judges. Live: Player1's Search spent the QA Fighter's Action and
  rolled Perception, 1d20 + 5. Its card comes just before the Action's own.

Shortcuts:
- the Dash Speed is the creature's own, before Modifiers;
- Grapple and Shove use a Might save, where 2024 lets the target choose Might or Agility;
- Grapple and Shove work on a creature of any size; 2024 allows one size larger than you at most;
- Disengage stops the common Opportunity Attack, but not a movement reaction a creature's own content defines.
  Being pushed or teleported out of reach provokes none (2024).

With the `bonusActionShove` world setting (Baldur's Gate 3, off by default) both Shoves cost a Bonus Action; the bar
and the authority build them alike. Live: with it on, Player1's Shove: Push spent QA Caster's Bonus Action and left
its Action.

Help covers the 2024 attack assist; any creature's next attack uses it, not only an ally's, and helping a check is by
hand. Live (two browsers): Player1's Help on the Bandit Captain, then an Unarmed Strike while Prone, rolled `1d20 + 1`
(the advantage cancelled Prone's disadvantage) and Distracted ended.

Not yet: Magic (a spell or magic item's own Action already is one) and Ready (the GM's call).

**Escape (2026-10-19).** A Grappled or Restrained condition keeps its escape DC in
`flags.wildpath.conditionEffect.metadata.escapeDC`, from the effect row's `metadata`. A Grapple stores the grappler's
8 + Might modifier + Proficiency Bonus; converted monsters and items store their own (content-packs.md). The bar
offers Escape only while the creature has one: Grappled before Restrained, then the highest DC. The check uses its
better skill, and a success ends that condition with a removal row (`levels: -1`).
- Shortcut: two grapples of the same condition are one condition, so escaping either ends both.
- Live (two browsers, 2026-10-19): the GM's Bandit Captain grappled Player1's QA Fighter. Its Grappled carried
  `escapeDC: 12` (8 + 2 + 2). Player1's bar then showed Escape; it rolled Athletics, 1d20 + 6 = 14, which ended
  Grappled and spent the Action. Escape then left the bar.

Live (two browsers, 2026-10-19): Player1's QA Fighter used Utilize from the bar; its Action went from 1 to 0 and a
"Utilize" card was posted.

Live (two browsers):
- Player1's caster used Dash from the bar: Dashing, and movement from 25 to 55.
- It shoved the Bandit Captain, which made its Might save.
- It used Dodge: the Captain's attack on the Prone caster then rolled a single d20, the Captain's advantage and
  Dodge's disadvantage cancelling.

## Ability checks (2026-10-14)

`check` is the acting creature's own ability check against a DC, the 2024 pattern: stabilizing an ally (DC 10
Wits, Medicine), hiding (DC 15), escaping a grapple.

```js
{check: {ability: "wits", skill: "medicine", dc: {value: 10}}, stabilize: true,
 effects: [{id: "fumble", type: "condition", conditionId: "prone", checkOutcomePolicy: "failure"}]}
```

- **Validation.** It names an ability or a skill, and a DC: a number, `{value}` or a ValueExpression,
  evaluated like a save DC.
- **The roll.** The creature's controller rolls it, as for an attack, before any attack or save. The bonus is
  the ability's modifier plus every Modifier on `check.<skill>`, `check.<ability>` and `check` (rolls.md). The creature's advantage and disadvantage
  on those domains combine as for any roll. The roller is never shown the DC.
- **The outcome.** It uses a save's d20-against-DC rule. It picks what the Action does:
  - each damage, healing and effect entry's `checkOutcomePolicy` is `success` (the default), `failure` or `any`;
  - `stabilize` needs a success.
- **The card** says whether the check succeeded, never its DC or margin.

Not yet:
- a check by each target, or a contest;
- automatic failure of a check;
- check events for Triggers.

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

`configuration[]` now feeds the Action Configuration foundation for per-use choices such as
casting resource, optional enhancements, action modes, or resource-dependent scaling. The persisted
definition still describes only what the action can do. The resolved configuration describes what
was chosen this time and produces a cloned effective definition for preview and resolution.

See `docs/architecture/action-configuration.md`.

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
- build the finished Action Configuration HUD
- open reaction windows

Those remain separate milestones. This foundation closes the persistence gap so future slices can
start from a canonical ActionDefinition instead of requiring callers to hand-assemble every
mechanical resolver payload.
