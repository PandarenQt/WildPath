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

A choice a definition's `draw` fills with dice (`draw.formula`: Prismatic Spray's ray) is never discovered: it is not
asked, not a missing required choice, and its effects are not applied here; the pipeline's `action.draw` stage rolls it
for each target once targets are known (action-definitions.md, "Drawn choices"). A choice drawn from a RollTable
(`draw.table`) is still an ordinary choice, answered by `Item#use`'s draw.

`keepEffect` (`{effectIds, keep: {option value: [ids]}}`) keeps, of the parts it lists, those its chosen option names
(its own value when the keep map has no entry). Its ids may name damage components as well as effects (2026-11-13), so
one option can be "this damage" and another "this condition"; a part it does not list is untouched. Its ids also reach
the lasting areas configuration reaches (wave E S2; `configuredAreaPersistences`: the Action's own area, what an opened
section leaves, what its spent budget leaves and a summon's carried area): a trigger by its optional `id` (dropped whole
when listed and not kept), and the effect rows and damage components of those triggers' Actions. So a held zone keeps
the chosen one of its effects (Nature's Sanctuary's vines or trees), and an area with one trigger per option keeps only
the chosen trigger (a homebrew aura of fire or of cold, each with its own events). An id-less trigger is never dropped.
Every part bearing a listed id is kept or dropped together, so one row id repeated on a zone's entering and turn triggers
(as Grease and Web repeat `effect-1`) is one part. A rolled draw's keep (applied by the draw stage, not as a selection)
reaches only the Action's own effects and damage, so validation refuses one listing an id only a lasting area's part has.

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
level above a base level. `scaleHealing` does the same for healing components.

Shape: `{type, levelChoiceId, baseLevel, componentIds, dice?: {number, faces}, bonus?: number}`. `dice` are
added per level above the base; `bonus` (2026-11-08, optional, absent is 0) is a flat amount added per level,
alone (Heal: "increases by 10 for each spell slot level above 6", 70 becomes 90 at 8th) or beside dice. A
constant folds into the component's constant; anything else gains an added constant term. The Action Builder
shows a scale with `bonus` read-only (a gap). Like `replaceDamageType`, it reaches every place the Action's damage lives
(`configuredComponents`): its own, a lasting area's triggers, `gmPrompt`, `repeatDamage` and, since wave E B26, the damage
it adds to an Action it uses (`uses[].with.damage`).

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

The components scaled are the Action's own and those it deals later: each trigger of its lasting area, of a summon's
carried area, of what an opened section leaves (`sections.leaves`) and of what its spent budget leaves
(`budget.leaves.persistence`, wave E S2), a GM card entry's and a failed repeated save's. Dice of the same faces join
the component's dice; a count worked out when it runs (`number: {type: "context", path: "area.ticks"}`) keeps its
expression and gains the added dice as a term (`{type: "add", terms: [<count>, 1]}`), instead of being read as 1.

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

Dice, attack bonuses, save DCs from actor statistics and reaction windows are built on this
configuration (rolls.md, reactions.md), and so is the homebrew builder (the item sheet's Builder,
Rules and Test tabs; homebrew-content-builder.md). Still not built: the finished HUD and spell
sheet (the action bar and the actor sheet's spell preparation stand in), reserving resources before
commit (they are spent at commit, one Action per creature at a time), and target-aware resistance
warnings.

## Upcast Targets Are "Up To" (2026-10-19)

`scaleTargets` raises `targeting.count` and keeps `refinementPolicy.minSelections` at the base count: 2024's "you can
target one additional creature" is optional. Before, Command from a 3rd-level slot needed exactly three targets.

## Areas That Grow With The Slot (2026-10-22)

`{type: "scaleArea", levelChoiceId, baseLevel, perLevel}` adds `perLevel` feet to `area.size` for each level the choice
names above `baseLevel` (2024 Confusion: a 10-foot Sphere at 4th, 5 feet more per level). The caster's client places
the area from the configured definition, and the authority finds its targets from it too (`foundryActionArea`), so both
see the same size. The converter writes it for a dnd5e template size that is a formula of `@item.level`.
Live (14.369): an Emanation of 5 feet plus 10 per level reached the three adjacent creatures at level 1 and all six
within 45 feet at level 5.

## Spending A Chosen Amount (2026-10-19)

A configuration effect `{type: "spendAmount", resourceId, componentIds, collection?, per?, faces?}` on a `number` choice adds
that many of the pool to the Action's cost and makes each listed healing (or damage) component that amount (times
`per`). 2024 Lay on Hands: "restore a number of Hit Points equal to the points spent". Spending more than the pool
holds is refused at payment, before anything rolls. With `faces` (2026-10-24) each component is that many dice of those
faces instead: dnd5e's "(@scaling)d6" (2024 Staff of Striking: "1d6 Force damage per charge spent").
Spending 0 (2026-10-31) removes the listed components: Lay on Hands used only for Restoring Touch's conditions heals
nothing.

## An option's own effects, and restoring a pool (2026-10-19)

- **An option's `effects`.** An option of a `select-one` choice may carry its own effects, applied after its choice's
  when it is chosen (Font of Magic: each slot level adds its cost in Sorcery Points and restores that slot).
- **A `select-many` choice** applies the effects of each option it picked (2026-10-31).
- **A `select-many` budget** (2026-10-31): `budget` (a ValueExpression read with its creature) caps the sum of the picked
  options' values; one it can't work out allows nothing. Arcane Recovery and Natural Recovery pick slots (value: their
  level) up to half the class level, rounded up, after a Short Rest (a `rest.completed` Trigger with a use/decline
  option, once per Long Rest).
- **`{type: "add-effects", effects}`** appends effects to what the Action does (Restoring Touch: each condition picked is
  one more removal, `levels: -1`, beside its `add-cost` of 5 Lay on Hands points).
- **A choice from another feature** (2026-10-31): an active feature's `flags.wildpath.choiceFor: {identifier, choice}`
  adds `choice` to its creature's Actions whose `flags.wildpath.source.identifier` is `identifier`, whenever the Action
  is read (`withContributedChoices`, action-definitions.mjs). 2024 Restoring Touch is a choice of six conditions on Lay
  on Hands, not a Bonus Action of its own. A hit offer's Action reads it too: Physician's Touch (2026-11-14) is a choice
  of Poisoned, until the end of the monk's next turn, on Hand of Harm's own offer. In place of `identifier`, `spell: {lists?, minLevel?, damage?}` (2026-11-01)
  names spells: on one of those class spell lists (`metadata.spellLists`), of at least that level (a cantrip is 0), and
  dealing damage when `damage` (2024 Overchannel's wizard spells). shortcut: a spell on the list counts whichever class
  prepared it.
  - (2026-11-21) `actions: <predicate>` in place of either names the Actions it fits by a predicate over their
    `actionTags` (rule-elements.md: `magical`, `cost:action`, `attack:weapon`, `check`...) and the type of the Item
    that brought them (`grantedBy.type`, from `flags.wildpath.grantedBy`: `gear` for a magic item's Actions). The flag
    may sit on one of the feature's own Actions instead of a feature Item, and the choice is still added once. 2024 Fast
    Hands (Q63): its Use an Object Action reads "or take the Magic action to use a magic item" into `{all: [{tagsAll:
    ["magical", "cost:action"], notTagsAny: ["spell", "attack:weapon", "check"]}, {equals: {path: "grantedBy.type",
    value: "gear"}}]}`, a `select-one` defaulting to "no" whose other option is `replace-cost` from `action` to
    `bonus-action`. So a magic item's Action-cost use may cost the Bonus Action instead, with its charges, attunement and
    equip checks unchanged. Spells cast from an item (Q121's default), a magic weapon's attack, an escape check (Portable
    Hole's) and a species' or feature's own magical Action (Breath Weapon) are left out, as is an Action no gear Item
    brought. Other plausible uses: a feature cheapening one
    kind of Action (its potions, its ranged spells), or adding a rider to every Action of a tag. The predicate also reads
    (wave D A10) `spellLevel` (its slot choice's lowest level, else `metadata.spellLevel`, else 0) and `targeting` (its
    `targeting` as written, a bare type string read as `{type}`), as a `spells` choice's `actions` does (below).
  - (2026-11-21) The converter's `CHOICES_FOR` row may name `keepsActions: [<activity name>...]`: the feature's
    activities kept as its own Actions, each carrying the choice; its other activities are the choice's (Rage of the
    Wilds keeps Eagle).
- **`{type: "add-to-effect", effect, ruleElements?, statuses?}`** (2026-11-21) adds rules, and statuses, to one of the
  Action's own custom effects, found by its `slug` or `id`; an Action without it is refused. They last exactly as long as
  that effect and end with it however it ends. 2024 Rage of the Wilds (Q62): a required choice on Rage (Bear, the
  default, Eagle or Wolf) adds to Rage's own `raging` effect Bear's Resistance to all but Force, Necrotic, Psychic and
  Radiant; Eagle's `rage-eagle` status, which its own Bonus Action requires, beside Disengage and Dash as the Rage starts
  (`add-effects`); or Wolf's aura (rule-elements.md). The option carries over for that Rage's whole 10 minutes (Q120
  (b)'s default; WildPath's Rage is not extended turn by turn). Rage used again is a new activation, which the book's
  "whenever you activate your Rage" and Q62's answer ("choose ... when Rage begins") ask again: another option replaces
  the old Rage, the same one refreshes it. Other plausible uses: Totem Warrior's spirits, a form or stance option on a lasting buff.
- **Overchannel's effects (2026-11-01):**
  - `{type: "maximize-damage"}` sets `metadata.maximized`: the damage roll stage rolls none of its damage; each component
    is its dice at their highest, plus its modifier (a critical hit's doubled dice too).
  - `{type: "add-source-damage", damage}` appends damage components to the Action's `sourceDamage`, the damage it deals
    its own source (action-resolution.md, "Damage to its own source").
  - `scale-damage` with `collection: "sourceDamage"` scales those instead of `damage`, and its `dice.number` may be a
    ValueExpression read with its creature (Overchannel's d12s a level: none on the first use, else one more than the
    uses before it, `resource-max` less `resource-current` of its `overchannel` pool).
  - `{type: "require-level", levelChoiceId, min?, max?}` refuses the configuration unless its level choice picked a
    level in that range (Overchannel: a slot of level 1 to 5).
- **`{type: "restore", resourceId, amount?}`** adds a pool of the acting creature to the Action's `restores`, refilled
  at payment up to its maximum. Its amount is by default the level its choice selected (`levelChoiceId`: a spent slot's
  level in Sorcery Points). It is refused when the creature lacks the pool or the pool is full.

- **Metamagic's effects (2026-10-19):**
  - `{type: "replace-cost", from, to}` pays one activation cost as another (Quickened Spell: `action` as `bonus-action`).
    The action bar keeps an Action usable when such an option of its own could be paid.
  - `{type: "set-range", range}` sets its range (Distant Spell).
  - `{type: "scale-duration", factor}` multiplies its effects' and concentration's durations (Extended Spell).
  - `replace-damage-type` takes a fixed `damageType` too (Transmuted Spell).
- **`{type: "set-check", check}` (2026-11-21)** sets the Action's check to the one its choice decides: Escape and Free
  holding it by a Grappled and a Restrained set the chosen hold's skill, DC and `escapes`, beside `keep-effect` keeping
  its removal row. Any Action whose check depends on a choice can use it.
- **`{type: "decline", value?}` (2026-11-21)**: with its choice's `value` (by default `"decline"`) selected, the Action
  does nothing and costs nothing ("you can": a use choice's "Not now"). Once every choice has applied, its definition is
  cut down to the keys it keeps (`DECLINED_KEEPS`: `schemaVersion`, `id`, `slug`, `label`, `category`, `tags`, `source`,
  `origin`, `targeting`, `targetChoice`, `range`, `area` without its `persistence`, `configuration`, `metadata`) with
  `costs: {allOf: []}`, so every part that acts is gone: an attack, save, check, damage, healing, effects, restores, a
  transform, summon, push, teleport, lasting area or `ends`, a part another choice added and any key added later. Its
  area's shape stays, so area targeting stays valid and is placed as before. The pipeline does not take back the
  attack, save or check the runtime prepared from the Action as written (`preparedResolverInput`), nor does the
  runtime's afterCompleted act on an option it prepared for a part the configured definition no longer has
  (`configuredOptions`: no earlier concentration ended, no lasting area left or moved, no teleport). Before this, only
  restores, healing, damage, effects and costs were emptied, so a declined Trigger still rolled its save or
  transformed. A declined Action posts no chat card (the coordinator skips `publishResult`, a reaction's child too:
  `configurationDeclined`, read from its configuration's trace). shortcut: a declined Action with a pick (`targetChoice`) still asks it, since the targets prepared for it
  need narrowing; upgrade by skipping the pick of an Action that does nothing. Limit: a declined Action still opens the
  action-declared reaction window with the tags it keeps (a spell-tagged one could be answered), as before.

## One of its own weapons, and binding a choice (2026-10-19)

- **`optionsFrom: {type: "weapons", melee?, bases?}`** on a `select-one` choice lists its creature's own weapons whenever
  the Action is read (`withOwnWeapons` in `actionDefinitionFromItem`). That is the attack Actions with `attack.weapon`,
  one per weapon, keyed by the gear that grants the attack (else the attack itself). `melee` and `bases` narrow it
  (Shillelagh: a club or quarterstaff). The client's prompt and the authority read the same options, so an id that is
  not one of its weapons is refused.
- **`each: "attack"`** and **`proficient: true`** (wave E B26) on a `weapons` choice: `each` lists each attack Action by
  its own Item id and name instead of one option per weapon (a Dagger's "Dagger" and "Dagger (Thrown)"), so the bound
  value is an Action another Action can use (`uses: [{action: "{{weapon}}"}]`, action-definitions.md "An Action that uses
  another"); `proficient` keeps only the attacks `attackProficient` allows its creature (True Strike: "a weapon you're
  proficient with"; a homebrew maneuver with martial weapons only, beside `bases`). With `magical: false` an attack listed
  by its own id is still judged by its weapon (the gear granting it).
- **`magical: false`** (2026-11-20, Q45 and Q109's default), on a `weapons` or a `gear` choice: "a nonmagical weapon"
  only. A weapon is magical while an attack it grants is tagged `magical` (a magic item's, from dnd5e's `mgc`), while its
  Item carries an enchantment (`flags.wildpath.enchantment`) with another key than the Action's own `enchant.key` (another
  template's binding, an infusion), or while an enabled effect on its creature makes it a magic weapon (the effect's
  `magicWeapon: "{{weapon}}"`, bound to the chosen weapon's id: Magic Weapon). An effect that only names the weapon in its
  rules (`weapon:<id>`: 2024 Shillelagh, Sacred Weapon, Pact of the Blade) does not make it magical. So magic for a while
  counts, and an enchantment may pick again the Item it already binds. The converter writes `magical: false` where the
  document's text says "nonmagical weapon" (Magic Weapon, Blessing of Weapon Enhancement), not from dnd5e's
  `restrictions.allowMagical` (false on nearly every template, Q109), and an enchantment's `magicWeapon` where it says
  the weapon "becomes a magic weapon" ("becomes magical", "counts as magical"). shortcut: `magicWeapon` does not tag the
  weapon's attacks `magical` (Magic Resistance still treats them as nonmagical); upgrade with a rule that adds tags.
- **`bindChoice`** (a choice's effect) writes the choice's value into the Action's effects wherever `{{<choice id>}}`
  stands: the weapon's id into a rule's predicate (`weapon:{{weapon}}`), or a slot choice's casting level where the token
  stands alone, as a number (`{type: "constant", value: "{{spell-slot}}"}`). It reaches `effects` deep (a granted
  Action's definition inside an effect too) and, since wave E S2, the whole `area.persistence` (each trigger's Action with
  its `targeting.eligible`, what it leaves, and every other key, such as the area bars lane A adds), a summon's
  carried area (`summon.area.persistence`) and, since wave E B26, the Actions it uses (`uses`: the chosen attack's id
  into `action: "{{weapon}}"`, and anything its `with` names). A token standing alone as a list member takes a `select-many`'s picks as members
  (`["{{creature-types}}", "dragon"]` becomes `["fiend", "undead", "dragon"]`: a ward against the chosen creature
  types; a homebrew aura harming only the chosen types), so the stored list stays a list of strings. A token inside a
  longer string takes the value's text.
- **`optionsFrom: {type: "spells", slotChoice?, actions?}`** (wave D A10) on a `select-one` choice lists its creature's
  own spells whenever the Action is read (`withOwnSpells`), by Item id, so a forged id is refused as the weapons choice
  refuses one. A spell is listed when it is an active Action Item tagged `spell`, not unprepared (`isUnprepared`), not
  the Action itself, a cast rather than a follow-up (`isFollowUp`: `metadata.followUp` or a `fromCast` choice, the test
  `action.completed`'s `cast` uses too), with a `spell-slot` choice or a cantrip (`metadata.spellLevel` 0), not brought by
  a gear Item (a scroll's or a staff's cast, as Q121's default leaves out for Fast Hands); and when
  `actions`, a predicate over `actionFacts` (`tags`, `grantedBy.type`, `spellLevel`, `targeting`), holds for it. It reads
  each spell's stored definition, never another Action as read, so two such choices cannot read each other. With
  `slotChoice` (the id of a resource choice of the same Action), each option carries `{type: "require-level",
  levelChoiceId: slotChoice, min: <its level>}`, or `min: 0, max: 0` for a cantrip, so the slot paid for it is its level
  or higher (an upcast) and a cantrip takes the choice's free option (`[]` with `metadata.freeCastLevel: 0`). Both
  resource choices append their costs, summed per pool. Put the Action's own `spell-slot` choice first: the casting level
  is the first selection that has one. Contingency's shape, as the converter reads it from its wording ("Choose a
  spell of level 5 or lower that you can cast, that has a casting time of an action, and that can target you. ...
  expending spell slots for both": `storedSpellDefinition`, wave D CO1; a qualifier it does not know leaves the spell
  by hand):

  ```json
  {"id": "stored-spell", "type": "select-one", "required": true, "options": [], "effects": [{"type": "bindChoice"}],
   "optionsFrom": {"type": "spells", "slotChoice": "stored-slot", "actions": {"all": [
     {"atMost": {"path": "spellLevel", "value": 5}}, {"tagsAll": ["cost:action"]},
     {"any": [{"equals": {"path": "targeting.type", "value": "self"}},
       {"all": [{"oneOf": {"path": "targeting.type", "values": ["single", "multiple"]}},
         {"not": {"equals": {"path": "targeting.notSelf", "value": true}}}]}]}]}}}
  ```

  beside `{"id": "stored-slot", "type": "resource", "cost": {"anyOf": [[], [spell-slot.1], ... [spell-slot.9]]},
  "levelByResourceId": {...}, "metadata": {"freeCastLevel": 0}, "effects": [{"type": "bindChoice"}]}`, both bound into its
  self effect's `storedCast` (action-definitions.md). Other plausible uses: Glyph of Warding's spell glyph
  (`atMost` on `spellLevel`), Ring of Spell Storing's casting into the ring, a homebrew item that empowers one of its
  wielder's spells of 3rd level or lower. Shortcut: the converter marks a follow-up only where dnd5e's activity spends no slot,
  so a cantrip's later activity that costs an Action (Produce Flame's Hurl Fire) and a leveled spell's that dnd5e writes
  as spending one (Dimension Door's damage, Detect Thoughts' Probe Deeper, Meld into Stone's damage) are listed as casts;
  Q92(f)'s one-Action limit is held for the rest until the converter marks them.

Weapon enchantments use both (content-packs.md): Magic Weapon, Sacred Weapon, Pact of the Blade and Shillelagh. A
weapon's attack carries `weapon:<id>` and its ability among its tags (rule-elements.md).

Live (two browsers, 14.369): Player1's QA Caster cast Magic Weapon at 3rd level on its Longsword. The Longsword's attack
went from +3 to +5 and its damage gained +2; the Dagger stayed at +3.
