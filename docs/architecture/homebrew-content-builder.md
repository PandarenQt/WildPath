# Homebrew Content Builder Release Target

This document records the **finished-product** target for Wild Path's homebrew content builder.
It is not a near-term scaffold task. It should be treated as a release-readiness standard once the
automation engine, resolver pipeline, action economy, triggers, effects, areas, and movement
systems are mature enough to execute the content the builder creates.

## First slice: JSON editors (2026-10-14)

The item sheet edits an Action's `system.definition`, and any Item's `system.ruleElements`, as JSON
(`module/applications/item-sheet.mjs`). The effect sheet, Foundry's own with a Rule Elements tab added, edits an
effect's `system.ruleElements` the same way (`module/applications/effect-sheet.mts`):

- **Validation.** The engine's own validators check every edit before it is saved:
  `validateActionDefinition` for definitions and `validateRuleElementDefinition` for RuleElements.
  - A RuleElement must also have a type the engine has a handler for. The validator checks only its shape, and
    an unknown type would be skipped when the rules are read.
  - An invalid draft is not saved, and the stored data is unchanged. On the item sheet the draft stays with its
    errors listed above it. On the effect sheet, Save keeps the sheet open and shows the errors in a notification.
  - A valid definition replaces the stored one whole, so a key it leaves out returns to its initial value.
- **Summary.** A short summary of the stored definition sits above the editor. It covers costs, controller
  costs, targets, range, area, attack, save, damage, healing, effects, choices, transform and summon
  (`module/helpers/action-definition-summary.mts`).
- **New Actions.** A new Action made from the actor sheet starts from a valid definition costing one Action.

**Evidence (live, GM browser, 14.369).**
- Adding single targeting and 1d6 fire damage saved, and the summary updated to match.
- Broken JSON and an empty `id` each showed their error and left the stored definition unchanged.
- A Modifier RuleElement saved on a feature gave its owner +2 AC.
- On an effect's sheet, an unknown type and broken JSON each kept the sheet open with the error and saved
  nothing. A Modifier then saved and gave the owner +1 AC.
- Legacy modifier rows still save.
- Node covers the summary and the RuleElement list check.

The JSON editors now live on the item sheet's Advanced tab (second slice, below).

## Second slice: the Action Builder (2026-10-14)

An Action's item sheet opens on a **Builder** tab, with **Advanced** (the JSON editors, legacy cost fields and
modifier rows) and **Description** beside it. Other Items have Advanced and Description.

- **Sections**, each a tabletop question:
  - a template;
  - is it a spell;
  - cost rows;
  - range;
  - targets;
  - area: shape, size, width for a line, and lasting rounds with concentration;
  - the deciding roll: an attack (melee or ranged, weapon or spell, finesse, ability), a save (ability, DC, what a
    success does to the damage) or the user's check (ability, skill, DC);
  - damage rows (formula, type, weapon/spell/extra);
  - healing rows;
  - effect rows: a condition with levels, or a custom effect with a name and duration; "only on a failed save".
- **Formulas** use a small safe grammar, never eval (`module/helpers/formula.mts`):
  - numbers, `NdM`, `+ - * /` and parentheses;
  - `prof`, `level`, `level(class)`, `mod(ability)`, `spellmod`, `resource(id)`, `resourcemax(id)`, `floor()` and
    `ceil()`.
  - A DC refuses dice.
  - An expression outside the grammar, such as a table, shows "edit on the Advanced tab" and is kept.
- **Overlay writing** (`module/helpers/action-builder.mts`):
  - Only fields the user changed are written. A changed one is written over its stored object.
  - Rows are matched by a hidden id.
  - So whatever the builder does not show survives, and an unchanged form writes nothing.
  - Node proves this over every pack definition.
- **Defaults.** Every choice writes a valid default:
  - area targeting adds a 10 ft sphere;
  - a new save gets the spell save DC (`8 + prof + spellmod`), or 13 for a non-spell;
  - a new row copies the save rule of the rows before it.
  - A blank Action gets the id `action:<item id>`.
- **Mistakes.** Text the builder can't read is marked on its field (`aria-invalid`, with the reason). The typed
  draft stays, and nothing is saved. A definition the validator refuses is not saved either.
- **Issues.** An issues list sits under the summary: validator errors by section, and warnings (outcomes but no
  targets, a roll with nothing on it, targets with no range).
- **Read-only parts.** Choices, transform, summon, controller costs, stabilizing, rule elements and alternative
  costs are named as "edited on the Advanced tab".
- **Templates.** Melee attack, ranged attack, spell attack, saving throw, area saving throw, healing and custom.
  Applying one over an Action that already does something asks first.

**Evidence (live, two browsers, 14.369).**
- The GM built Flame Burst on a blank Action with the Builder's fields alone: spell, one Action, ranged 150 ft, a
  20 ft sphere, an Agility save at DC 13, 8d6 fire, half on a success. It was valid with no issues.
- Player1 cast it at two NPCs. The one who failed took 39 fire, and the one who saved took 19.
- Player1, as an observer of an NPC's Action, saw every Builder field disabled and no buttons.
- Quench covers a builder edit that keeps hidden data, a bad formula kept as a marked draft, a template on a blank
  Action, and no raw keys on the sheet.

**Not yet (later phases):** trigger, summon, transform and choice editors.

## Third slice: rule rows (2026-10-14)

RuleElements are rows a non-programmer fills in (`module/helpers/rule-builder.mts`). They appear in three places:
- every Item's **Rules** tab, which is where a feature or piece of gear opens;
- an Action's custom effect, under its effect row ("while it lasts");
- the effect sheet's Rule Elements tab, with the JSON under "Advanced".

**Row kinds:**
- a bonus or penalty (`Modifier`), whose amount is a formula without dice;
- advantage or disadvantage (`RollMode`);
- resistance and immunity (`GrantResistance`, `GrantImmunity`), listing damage types;
- a Speed (`GrantMovement`);
- a resource pool (`GrantResource`), with a name, an id, a maximum formula and when it recovers;
- extra damage on a hit (`ExtraDamage`), optionally once per turn;
- an aura (`Aura`), with a radius, who it affects, and its own rows. An aura's rows can't be another aura.

**What a row applies to** is chosen in plain words, each one an engine statistic domain:
- attack rolls: all, melee, ranged, weapon or spell;
- saving throws, all or per ability, and ability checks, all or per ability;
- initiative;
- Armor Class, the Hit Point maximum and Speed;
- damage: all, melee, ranged, weapon or spell;
- attack rolls against you (advantage or disadvantage only).

**Other parts:**
- **While.** Every row can apply only while its owner has a condition (`predicate: {hasCondition}`). Another
  predicate shows as "set on the Advanced tab" and is kept.
- **Overlay writing.** Only a changed field is written, into the rule's `data`; a copy of it at the rule's root,
  which would win, is removed. Rows match stored rules by position.
  - A rule no row can show (`Trigger`, `ResourceCap`, `RollOutcome`) stays read-only.
  - So do domains outside the list and amounts outside the formula grammar.
  - Node proves an unchanged form gives back every condition's rules.
- **Issues.** A list shows each rule's problem: its shape, an unknown type, or what its handler refuses when tried
  without its predicate (a Modifier without domains).

**Evidence (live, 14.369).**
- An aura feature made on the Rules tab gave its bearer and an adjacent ally +1 AC, and an enemy six squares
  away nothing.
- A Shield Action was built in the Action Builder, with a reaction cost, self targeting and a custom effect (+5 AC,
  1 round, ends at turn start). Using it raised the caster's AC by 5.
- Quench covers adding a row and editing its amount on the Rules tab (the owner's AC follows), and editing and
  saving an effect's rows.

## Fourth slice: Test tab, spell slots and more templates (2026-10-14)

**Test tab** (`module/helpers/action-preview.mts`). An Action's sheet has a Test tab that dry-runs the Action
through the engine's own staged pipeline. It uses one sample target, with an AC, Hit Points and a save bonus the
user sets.
- **Dice.** Every d20 shows a number the user picks, and other dice show their average.
- **Choices.** A required choice, such as a spell slot, takes its first option.
- **Who uses it.** It runs as the Action's owner would use it now, with the owner's statistics, and its costs are
  checked against what the owner has left. An unowned Action runs as a sample creature: proficiency +2,
  spellcasting +3, every ability score 10, level 1.
- **Stops before commit.** Nothing is changed or spent.
- **Results.** It shows the Rules Inspector's view: rolls, attacks, saves, health changes, effects, payments and
  errors. The two share `templates/apps/resolution-detail.hbs`, and the inspector now also lists effects.
- Shortcut: there is no Scene, so range, area shape and placement are not previewed; an area is treated as
  catching the target.

**Spell slots.** A spell's Builder asks whether it uses a spell slot:
- "level N or higher" writes a resource choice for slots N through 9;
- "each slot level above adds XdY" writes `scaleDamage` on the first damage row;
- the engine already asks the caster which slot to spend;
- the choice is read back whether Foundry stores its level map flat or nested.

**Templates.** Buff, debuff (save or suffer), aura around the user, reaction (Shield) and Legendary Action join
the others.

**Evidence.**
- Node runs every pack Action through the preview: a hit and a miss, half damage on a success, full damage and
  Poisoned on a failure, a slot spell, and a builder-made area save.
- Node also runs a builder-made slot spell through the engine's own configuration preview: a 3rd-level base cast
  at 5th deals 4d6.
- Quench: the Test tab previews a natural 20 as a critical hit and changes nothing on the Actor.
- Live: Flame Burst's Test tab used QA Caster's own state. A failed save took 28 of 30 Hit Points, and the Action
  would fail because the caster had already spent their Action that turn. The Rules Inspector names the target of
  an effect it applied.

## Converted content in the Builder (2026-10-18)

- **No data loss on edit.** The sheet saves on every change, and a select whose stored value it lacks posts its first
  option. Two such losses are fixed:
  - Area shapes now include Cube and Wall, and keep any other stored shape. Renaming a converted Web no longer turns
    it into a Sphere.
  - A check's ability has a blank "the skill's own" option, so renaming a skill-only check (Chain, Manacles) no
    longer writes an ability into it.
- **The round trip.** An unchanged form gives back every converted SRD Action exactly (`test/action-builder.test.mjs`).
  Live: renaming the SRD Web and Chain check kept their definitions.
- **A rule only Advanced can edit survives (2026-10-18).** Such a rule's row showed no inputs, so any save of the
  sheet dropped it (renaming the SRD Extra Attack lost its `ExtraAttack` rule). Fixed: the row posts its kind, and
  rows match stored rules by their posted index, so a rule the form says nothing about is kept. Rules are removed
  only with the row's remove button. Live: after renaming Extra Attack, both of its rules were still there.

## The homebrew census (2026-10-18)

Every converted effect should be one a GM could build again in the item sheet's Builder and rule rows, without the
Advanced JSON. Two reporters name what they cannot show or edit:
- `builderGaps(definition)` (action-builder.mts), as dotted parts: `costs.anyOf`, `attack.weapon`,
  `effects.ruleElements.ArmorClass`.
- `ruleGaps(ruleElements)` (rule-builder.mts): a rule type with no row (`Trigger`), or a part of one (`RollMode.domains`).
- The data model's defaults (an empty `slug`, `category: "action"`) are not gaps.

The item sheet's "Also set, edited on the Advanced tab" line lists `builderGaps`, in plain words where the language
file has them (`WILDPATH.BUILDER.Gap.*`).

`node scripts/content/homebrew-census.mjs` counts both over the SRD packs and the local book packages. It reads copies
of the books' LevelDB packs and prints only counts. Run it whenever content is converted, and close the largest gaps
until it reaches zero.

Closed first, by count:
- **Magical** (a Basics checkbox; tag `magical`).
- **A weapon's kind, base weapon and mastery**, on an attack.
- **Concentration** on an effect row.
- **Resource rows:**
  - "Starts at" (Extra Attack's empty pool);
  - "Empties at the start of each turn" (Multiattack's);
  - Recharge 2-6 to 6;
  - "Regains on a short/long rest" formulas (a wand's 1d6 + 1).
- **"While" on a rule row** also offers: against magic, with melee or ranged attacks, an ally within 5 feet of the
  target (Pack Tactics), and in sunlight.

| Fully editable | First run | After these fields |
| --- | --- | --- |
| SRD Actions | 1,254 / 2,529 | 1,693 / 2,529 |
| SRD rule lists | 793 / 1,373 | 1,283 / 1,373 |
| Book Actions (four packages) | 3,055 / 5,689 | 3,996 / 5,689 |

The largest gaps left, all sources:
- monster Multiattack's plumbing: `costs.anyOf` (1,128) and `restores` (596);
- `summon` (323);
- resource maximums that are formulas it cannot show (106);
- area height (94), Hover (90), choosing among targets (80), lasting-area triggers (72), push (62).

Live (two browsers, 14.369), on world copies of SRD Items:
- Battleaxe's Builder showed martial / battleaxe / Topple and no "Advanced" line. Choosing Vex changed only
  `attack.weapon.mastery`.
- Bane's effect lost and regained its concentration, ending with an identical definition.
- Extra Attack's pool row showed "Starts at 0" and "Empties at the start of each turn".

## Product Goal

Wild Path should let an ordinary GM create deeply automated homebrew without programming, JSON
editing, selector syntax, Foundry hook knowledge, or internal engine concepts.

The builder must translate familiar tabletop language into Wild Path's structured mechanics:

```text
Applies to: Melee weapon attacks
Effect: +2 Attack
```

not:

```text
RuleElement selector + predicate JSON
```

Developer/debug views may expose internals, but ordinary homebrew must not require them.

## Supported Content

The finished builder should support:

- monsters and NPCs
- spells
- weapons, armor, general items, and consumables
- features, passive abilities, active abilities, and reactions
- conditions
- resources and action-economy grants
- companion abilities
- monster abilities
- Legendary Actions and Lair Actions
- auras and persistent areas
- summons
- custom actions

These categories should share generic mechanics. A monster attack, weapon attack, spell attack,
and feature attack should compile to the same underlying action/attack definition model.

## Unified Builder

The product should have one coherent Content Builder system with reusable sections, not many
unrelated editors.

Common reusable builder components should include:

- action activation and costs
- targeting, range, and area
- attacks, saves, and ability checks
- damage and healing
- conditions and effects
- resources and resource costs
- durations
- triggers and reactions
- movement
- scaling and formulas
- choices
- summoning
- modifiers

Progressive disclosure matters: basic content should start with common fields, and only reveal
advanced configuration when relevant.

## Action Builder

The Action Builder is the central authoring surface. It should offer templates such as:

- Melee Attack
- Ranged Attack
- Spell Attack
- Saving Throw Ability
- Area Saving Throw
- Healing Ability
- Buff
- Debuff
- Reaction
- Aura
- Movement Ability
- Summon
- Legendary Action
- Lair Action
- Passive Ability
- Custom

Templates create sensible starting structures, but the resulting action remains fully editable.

## Effect, Modifier, Trigger, and Condition Builders

The Effect Builder should present familiar choices like Deal Damage, Heal, Apply Condition, Grant
Resistance, Grant Movement, Grant Resource, Create Area, Summon Creature, Grant Action, or Modify
Action Economy.

The Modifier Builder should let users say things like:

```text
Modify: Attack Roll
Amount: +2
Applies To: Ranged weapon attacks
```

The Trigger Builder should read like a tabletop rule:

```text
When: You hit with a melee attack
Then: Deal 1d6 Fire damage
```

Conditions should reuse triggers, modifiers, durations, effects, and resources rather than getting
condition-specific runtime code.

## Action Economy Integration

The builder must expose the generic action-economy foundation in user-friendly terms:

- Action
- Bonus Action
- Reaction
- Movement
- Legendary Action points
- Lair Actions
- extra unrestricted Actions
- restricted extra Actions
- additional Reactions
- custom action resources
- additional movement resources

Homebrew authors should be able to configure these without writing predicates manually. Internally,
the builder can compile restrictions into predicates and payment capabilities.

## Movement Homebrew

Users author canonical movement distances:

```text
Grant Movement: 15 ft
Mode: Flying
```

Runtime display and spending may be distance or fields depending on world settings and scene grid.
The builder must not make the author permanently choose a feet-vs-fields storage format.

## Formula and Scaling Builders

Common formulas must be visual and safe, not arbitrary JavaScript.

Supported formula pieces should include:

- fixed number
- dice
- ability modifier
- proficiency bonus
- character level
- class level
- spell level
- slot level
- resource value
- add, multiply, divide, and round down

Scaling should have dedicated UI for common cases such as spell-slot scaling, character-level
scaling, and resource maximum scaling.

Action configuration choices should compile to the same `ActionDefinition.configuration[]` and
domain-contributed choice records consumed by `module/helpers/action-configuration.mjs`. Upcasting,
alternate resource selection, optional enhancement costs, and legal damage-type substitutions must
therefore preview and resolve through the shared Action Configuration foundation rather than a
builder-only execution path.

## Validation and Rules Summary

Every major builder should provide:

- live human-readable rules summary generated from structured mechanics
- friendly validation messages tied to the relevant section and field
- no reliance on prose descriptions as the source of automation

Example validation:

```text
This action deals damage but currently has no target.
```

not:

```text
Invalid ActionDefinition
```

## Test and Preview

The finished builder needs a Test/Preview feature that uses the real resolution engine in dry-run
or transaction-planning mode.

Users should be able to choose source actors, target actors, and optional roll results, then see a
synthetic resolution summary without permanent mutation.

## Round-Trip Editing

Builder-created content must satisfy:

```text
Builder -> structured definition -> save -> reopen -> Builder
```

without losing meaning. The domain schema remains the source of truth; UI state must not become the
canonical mechanics model.

## Duplicate, Compendium, Import, and Export

The finished product should support:

- duplicate / copy / save as new
- reference existing vs create independent copy
- Foundry Compendium workflows
- homebrew packs
- schema-versioned import/export
- dependency detection
- include-dependencies workflows
- safe IDs
- no exported executable JavaScript for ordinary content

## Accessibility and UX Standard

User-facing text should use tabletop terminology:

```text
When can this happen?
Who can this target?
What happens on a successful save?
```

instead of:

```text
Trigger Predicate
Target Entity Filter
Success Resolution
```

## Release Acceptance Examples

A non-programmer should be able to create these without documentation:

- Flaming Longsword: melee attack, 1d8 Slashing plus 1d6 Fire
- Flame Burst: Action, 60 ft, 15 ft sphere, DEX save, 4d6 Fire, half on success
- Passive feature: while raging, +2 melee damage
- Triggered feature: when you hit with a melee attack, deal +1d6 Fire once per turn
- Reaction: when hit, spend Reaction, gain +5 AC for that attack
- Aura: allies within 10 ft gain +1 AC
- Custom resource: Spirit Points, maximum 2 x proficiency bonus, recover on long rest
- Monster: actions, reactions, and Legendary Action points

## Deferred Until Engine Maturity

Do not build a polished builder that creates fake or non-executable mechanics. If the engine lacks
a primitive needed by the builder, implement the reusable engine primitive first, test it, then
surface it through the builder.

This feature depends on the mature versions of:

- ActionResolver
- ResourceResolver
- ResolutionTransaction
- EventBus / trigger system
- ReactionEngine
- AreaResolver
- MovementPath and movement event/commit integration
- formula/value-expression system
- import/export and migration infrastructure
