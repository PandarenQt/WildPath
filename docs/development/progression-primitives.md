# M5 missing-primitive test: progression and character systems

Run on 2026-10-14 against `3c330fb`, before any M5 code. Each AGENTS §11 requirement is asked: can it
be composed from existing contracts (ActionDefinition, RuleElements, Predicate, ValueExpression,
Configuration, Targeting, RollProvider, Spatial, ResolutionState, Transaction)? Where it cannot, the
smallest reusable missing piece is named. Nothing here hardcodes a named class, spell or feature.

## The headline finding

Only two RuleElement types reach live play: `Modifier` (through `WildPathActor#getStatistic`) and
`Trigger` (through the condition-trigger and reaction providers). The grant types compute correct
contributions, but nothing applies them:

- `GrantResource`: pool maxima, which can come from a ValueExpression.
- `GrantActionEconomyResource`: extra Actions, Bonus Actions and Reactions.
- `GrantResistance` and `GrantImmunity`.
- `GrantMovement`.

The evidence is `rule-elements.md` ("not globally wired into Foundry document preparation yet") and
the code. Payment discovery reads only the Actor's stored resources and pools
(`economyResourcesFromActorResources`). The damage resolver accepts resistance profiles
(`damage-durability-resolver.mjs`), but the runtime never builds one. Several §11 items are therefore
"primitive exists, not wired", not "primitive missing".

## Requirement by requirement

| §11 requirement | Verdict | Evidence / gap |
| --- | --- | --- |
| Features that grant additional Actions or Bonus Actions | **Primitive exists, not wired** | `GrantActionEconomyResource` (rule-elements.mjs). Payment discovery never collects it. |
| Spending an Action for a Bonus-Action activity | **Composable** | `maybeFindAlternativeCandidates`, policy `allowActionForSpentBonusAction` (action-economy.mjs). |
| Mutable/configurable damage types | **Composable** | Configuration choice type `damageType` (action-configuration.mjs). |
| Short-rest and long-rest hooks | **Partly** | Pools recover by cadence and rests emit lifecycle events (`WildPathActor#rest`). An Item's `Trigger` on `rest.completed` is not dispatched; only condition effects listen. |
| Start-of-turn / end-of-turn hooks | **Composable** | `turn.started` / `turn.ended` reach condition triggers and lasting areas (Combat hooks). |
| Success and failure hooks | **Composable** | `attack.hit` / `attack.miss` windows; `save.success` / `save.failure` events (action-resolver.mjs). |
| Movement hooks | **Composable** | `movement.*` events and before- and after-step reaction windows. |
| Entering / leaving area hooks | **Half** | `area.entered` works (M3). `area.exited` is a constant that nothing emits. |
| Initiative hooks | **Missing (small)** | No initiative event; `Combat` has no initiative override. |
| Multiple subclasses; the level-1/original class | **Missing (data)** | The character has only `details.level`. The `class-level` ValueExpression already reads `system.classes`, which no data model defines. |
| Configurable spellcasting ability from class choices | **Missing (data)** | The `spellcasting-modifier` ValueExpression reads `system.spellcasting.ability`, which no data model defines. Choosing it is a Configuration choice once the field exists. |
| Full, half, third and pact progression | **Missing (two pieces)** | Slots are pools (proven in M1, `spell-slot.N`). Missing: per-class progression, and a lookup from level to a value (ValueExpression has arithmetic but no table). The pact cadence is a pool recovery cadence, which exists. |
| Multiple transformation types | **Missing** | No representation of "this creature now uses another statistic block". |
| Companions, sidekicks, Beast Master / Drakewarden | **Missing** | No link between a companion Actor and its controller. No cross-Actor payment (a companion acting on its controller's Bonus Action). |
| CR-based or Warrior-style sidekick progression | **Missing** | Same link, plus a progression source other than class levels. |

## The smallest missing pieces, in build order

1. **Wire the grant RuleElements.** No new primitive, and no rules decision: each type already defines
   what it means.
   - `GrantResource` sets pool maxima.
   - `GrantResistance` / `GrantImmunity` build the target's damage profile: **done 2026-10-14** (Node and
     Quench).
   - `GrantMovement` feeds movement modes and budgets.
   - Extra Actions: **decided and done 2026-10-14**. Actions, Bonus Actions and Reactions are counters:
     the spent count is stored, the available count is the maximum effects modify, and what remains is
     available − spent (action-economy.md). An effect that grants an extra Action raises the maximum;
     `GrantActionEconomyResource` is not needed for this.

   This unlocks extra Actions, resistances and slot pools as authored data.
2. **A general automation dispatcher, then the missing events.** Today an event such as
   `turn.started`, `rest.completed` or `area.entered` reaches only condition triggers, reactions and
   lasting areas.
   - Missing: running an Item's or effect's non-optional `Trigger` (for example "when you roll
     initiative, gain temporary hit points") as an authority Action, the way lasting areas already do
     (`resolveAuthorityAction`).
   - The lasting-area engine generalizes into this dispatcher. The legacy condition damage ticks, which
     write to Actors directly, can move onto it (Stage E).
   - Then `area.exited` (mirroring `area.entered`) and `initiative.rolled` (from Combat) become useful.
     Emitting them without the dispatcher would reach nothing.
3. **Class records: approved and done 2026-10-14** (`classes-and-spellcasting.md`), with full multiclass
   support. They live on every Actor, so sidekicks can use them. Originally proposed: Proposed shape:
   `system.classes: [{id, slug, level, original, subclasses: [...], spellcasting: {ability, progression}}]`.
   - The total level is derived from these records, replacing `details.level`. That needs a migration.
   - The `class-level` and `spellcasting-modifier` ValueExpressions already read this shape.
4. **A table ValueExpression: done 2026-10-14** (`{type: "table", key, rows, default}`, see
   common-rules-primitives.md). It turns a class level, or a combined caster level, into a slot count,
   extra dice or any other level-scaled value.
5. **Spellcasting progression: decided and done 2026-10-14.** 2024 rules, with full and half casters
   only (half levels rounded up per class), and slots from the 2024 table into the `spell-slot.<n>` pools.
   Originally proposed:
   - Full casters count 1, half 1/2 and third 1/3 toward a combined caster level. The rounding differs
     between 2014 and 2024 rules, so it belongs in a rule provider, not inline (AGENTS §10).
   - Pact slots stay a separate pool with a short-rest cadence.
6. **Transformations (design decision).** Smallest form: a `transformation` effect type that carries a
   statistic source (an Actor or a statistic block) and a merge policy. The policy says, for example,
   "physical abilities, health pool and Actions from the form; mental abilities and proficiencies from
   the creature".
   - `getStatistic` and the resource snapshot read through the active transformation.
   - Wild Shape, Polymorph and a homebrew form differ only by policy.
7. **Companions and sidekicks (design decision).**
   - `system.companion: {controllerRef, kind}` links a companion to its controller.
   - A cross-Actor payment option lets the companion's Action cost its controller's Bonus Action.
   - Sidekick progression uses the same class records (item 3), with a non-class progression source.

## What I need from you

- **Item 3:** approval of the class-record data shape and its migration (persistent data format).
- **Item 5:** which rounding applies to multiclass caster levels, or confirmation that it is a
  per-ruleset rule provider choice.
- **Items 6 and 7:** whether the proposed smallest forms match how you want transformations and
  companions to feel at the table, before I build them.

Items 1, 2 and 4 need none of this, and they come first. For item 1, the backing-pool proposal is my
default unless you prefer another place to store a granted resource's spending.
