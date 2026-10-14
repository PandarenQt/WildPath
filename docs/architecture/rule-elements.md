# RuleElements

RuleElements are Wild Path's declarative rule-contribution layer.

```text
Predicate
+ ValueExpression
+ Modifier
+ RuleElement
-> owning domain interpreter
```

A RuleElement is serializable data carried by an Item, ActiveEffect, condition, feature, class,
species, feat, spell, transformation, temporary effect, or homebrew package. It describes a
mechanical contribution. It is not a mini-resolver and must not directly mutate Actors, Items,
ActiveEffects, Tokens, the canvas, chat, or UI state.

## Runtime

`module/helpers/rule-elements.mjs` contains the pure RuleElement registry and collector.

The default registry currently supports these contribution types:

- `Modifier`
- `GrantResource`
- `GrantResistance`
- `GrantImmunity`
- `GrantMovement`
- `RollMode`, `ResourceCap`, `RollOutcome`
- `ExtraDamage`, `Aura`
- `Trigger`

Handlers return contribution bundles only:

- `modifiers`
- `resources`
- `damageAdjustments`
- `movement`
- `rollModes`, `resourceCaps`, `rollOutcomes`
- `extraDamage`, `auras`
- `triggers`

`GrantActionEconomyResource` was removed on 2026-10-14: nothing read it. Extra Actions are counters whose maximum
effects raise (action-economy.md).

Owning domains consume those bundles. For example, `Modifier` RuleElements feed
`WildPathStatistic`; damage adjustment RuleElements produce a profile for
`DamageAdjustmentResolver`; trigger RuleElements produce existing automation trigger definitions.

## Authoring Shape

Persisted RuleElements use a stable common envelope:

```js
{
  schemaVersion: 1,
  id: "feature.dueling.attack",
  type: "Modifier",
  label: "Dueling",
  predicate: {tagsAny: ["weapon-attack"]},
  priority: 100,
  enabled: true,
  suppressed: false,
  data: {
    domains: ["attack.melee"],
    modifierType: "status",
    valueExpression: {type: "constant", value: 2}
  },
  metadata: {}
}
```

Common fields belong at the top level. Type-specific fields belong under `data`; this lets the
Foundry data schema preserve RuleElements without changing every time a new handler is added.

`type` is the canonical key. The pure normalizer also accepts `key` and a few lowercase aliases so
future importers can adapt external data before persistence.

`schemaVersion` is required in persisted data and currently defaults to `1`. Future migrations
should use this field to upgrade RuleElement definitions deterministically instead of inferring
version from an opaque payload.

## Evaluation

RuleElements use the shared Predicate and ValueExpression evaluators. They do not evaluate
JavaScript, parse arbitrary formula strings, or call Foundry APIs.

The lifecycle is:

```text
raw definition
-> serializability and schema validation
-> Predicate validation/evaluation
-> registry handler lookup
-> handler-owned payload validation
-> contribution bundle
-> trace
```

Evaluation is ordered by `priority`, then stable id. Each entry emits a trace with one of:

- `contributed`
- `disabled`
- `suppressed`
- `predicate-failed`
- `failed`

**What a predicate sees (2026-10-14).** When a creature's statistic, roll mode or roll outcome is read, a
RuleElement's own predicate sees the roll's `tags` and the creature's current `conditions`, its statuses:
- `{tagsAny: ["ranged"]}` applies only to ranged attacks, using the attack type and the Action's tags;
- `{hasCondition: "raging"}` applies only while the creature has that condition.

Before this, these predicates never matched. Data preparation (resource maxima, Speeds) does not pass them yet.

Invalid or unknown RuleElement types fail explicitly in the collector result. Disabled,
suppressed, or predicate-failed entries fail closed by contributing nothing while remaining visible
to rules-inspector tooling.

The registry is deliberately small and centralized. Registering the same normalized type twice
throws unless the caller explicitly passes a replacement option. Adding a new RuleElement type
should therefore be a localized Rules-domain change plus tests for its owning contribution shape.

## Validation And Serialization

`validateRuleElementDefinition()` rejects non-plain or non-JSON data, including functions,
symbols, bigint values, circular structures, and non-finite numbers. Invalid Predicate shapes are
reported as invalid RuleElements rather than silently skipped as ordinary predicate failures.

`serializeRuleElementDefinition()` returns a normalized plain definition suitable for:

```text
serialize
-> persist
-> reload
-> validate
-> evaluate
```

RuleElement evaluation clones authored data before dispatch and must not mutate the definition or
the evaluation context.

## Persistence

The base Item and ActiveEffect data models now persist:

- legacy `modifiers`
- new `ruleElements`

Legacy `modifiers` remain supported so existing data keeps working. New content should prefer
RuleElements unless it is intentionally writing the low-level modifier primitive directly.

Generic WildPath ActiveEffects use the `effect` subtype; `base` is Foundry V14's reserved fallback
ActiveEffect type and must not be declared by the system manifest. Development worlds which already
stored explicit ActiveEffects as `type: "base"` need those records migrated to `effect` or
`condition` before startup validation.

WildPath ActiveEffect data models extend `foundry.data.ActiveEffectTypeDataModel` by preserving the
inherited schema first, including Foundry's native `system.changes`, then adding WildPath
`modifiers` and `ruleElements`.

## Current Integration

`WildPathActor#getStatistic(domain)` consumes `Modifier` RuleElements from active embedded Items
and applicable ActiveEffects alongside legacy modifier entries.

`ConditionTriggerResolver` consumes `Trigger` RuleElements from condition ActiveEffects and matches
them against semantic events such as `turn.started`. Its current payload support is intentionally
narrow: a condition trigger may plan a durability change through `DurabilityResolver`, but it does
not execute an action, open a reaction window, roll damage, create chat, or mutate a document.

`Bleeding` is the representative migrated condition:

```text
Bleeding condition config
-> persisted Trigger RuleElement
-> turn.started
-> ConditionTriggerResolver
-> DurabilityResolver mutation plan
-> WildPathActor Foundry update adapter
```

`system.dot` remains as a temporary compatibility payload for old condition effects. If a
condition effect has no `ruleElements`, `ConditionTriggerResolver` translates legacy dot ticks
into synthetic Trigger RuleElements. If persisted RuleElements exist, they are authoritative and
legacy dot data is ignored to avoid double application.

**Reaction triggers.** The Foundry reaction provider
(`module/adapters/foundry-v14-reaction-provider.mts`, installed as `game.wildpath.reactionServices`)
turns `Trigger` RuleElements of `kind: "reaction"` on active Items into reaction triggers for any event:
movement steps, staged and native (`event: "movement.transition-proposed"`, phase `interrupt`), and
ordinary Actions (`action.declared`, `attack.hit`, `attack.miss`):

- The reaction's Action is the Item itself (an Action Item) or the Action named by `data.reaction.actionId`.
- Each such Token also becomes a movement observer: reach in fields comes from that Action's reach range,
  hostility from opposed Token dispositions.
- Put the event predicate in `data.triggerPredicate`; `predicate` (or `data.predicate`) is the RuleElement's
  own activation predicate and is evaluated without the event.
- `{self}` in a predicate `path`, or as a whole `match` value, is bound to this reactor's Token id.

An opportunity attack is authored as:

```js
{type: "Trigger", data: {kind: "reaction", event: "movement.transition-proposed", match: {phase: "interrupt"},
  triggerPredicate: {all: [
    {equals: {path: "event.data.movementKind", value: "voluntary"}},
    {equals: {path: "event.data.relations.{self}.leavesReach", value: true}},
    {equals: {path: "event.data.relations.{self}.context.hostile", value: true}}]}}}
```

2024 Shield ("when you're hit, +5 AC until the start of your next turn, including against that attack") is an
Action with this Trigger, a Reaction cost, `self` targeting, and a custom effect (action-definitions.md):

```js
{targeting: {type: "self"}, costs: {allOf: [{capability: "reaction", amount: 1}]},
 effects: [{type: "effect", name: "Shield", ruleElements: [{type: "Modifier", data: {domains: ["defense.ac"], value: 5}}],
   duration: {value: 1, units: "turns", expiry: "turnStart"}}]}
// ruleElements: [{type: "Trigger", data: {kind: "reaction", event: "attack.hit", match: {phase: "interrupt", targetTokenId: "{self}"}}}]
```

The attack is scored again after the reaction, against the raised AC; a natural 20 still hits. Live (two
browsers, 14.369, physical dice): a goblin's 13 hit Player1's wizard (AC 12). Player1 chose Shield, the card
showed a miss, the wizard kept the Shield effect, and its reaction was spent.

A counterattack ("when a creature hits you, strike back") is authored as:

```js
{type: "Trigger", data: {kind: "reaction", event: "attack.hit",
  match: {phase: "interrupt", targetTokenId: "{self}"}}}
```

Live (two browsers, 14.369): Player1's Strike hit a GM-controlled guard. The GM was offered the guard's
Counterattack before the Strike's damage was committed. The counterattack hit Player1's attacker for 3,
the guard spent its reaction, and the Strike's 6 damage still landed. The player saw two public cards,
the guard's Counterattack, then the Strike.

Live (Quench, 14.369): a hostile guard with this Trigger on its melee Action attacked a friendly mover
leaving its reach (6 damage, reaction spent, movement finished), with no injected services. Live in two
browsers: the same guard attacked a player's native move before its first step
([movement-paths.md](movement-paths.md#before-step-reactions-in-native-drags)).

**Automatic triggers.** A `Trigger` of kind `automation` (the default) on a creature's active Item or
enabled non-condition effect runs without asking anyone. The general automation dispatcher
(`module/adapters/foundry-v14-automation-dispatcher.mts`, `game.wildpath.automation`) runs it when its event
happens to that creature:

- `turn.started` and `turn.ended` come from `WildPathCombat`.
- `initiative.rolled` comes from any client's roll, through the Combatant update the GM sees
  (`event.data.initiative`).
- `rest.completed` comes from `Actor#rest` (`event.data.restType`, `shortRest` or `longRest`).

The Action is the trigger's inline `data.action`, the Item itself when it is an Action, or the Action Item
named by `data.actionId`. It resolves as an authority Action with the creature as source and only target,
exactly like a lasting area's effect, and it shares that code (`runAuthorityAction`). Put the event
predicate in `data.predicate` or `data.triggerPredicate`. Condition effects keep their own path (below), so
nothing fires twice.

```js
{type: "Trigger", data: {event: "rest.completed",
  predicate: {equals: {path: "event.data.restType", value: "longRest"}},
  action: {schemaVersion: 1, id: "action:renewal", label: "Renewal", costs: {allOf: []}, healing: [/* ... */]}}}
```

Only the active GM dispatches. A rest happens on the resting client, so a Player's client reports it to
the GM with the V14 user query `wildpath.automationEvent`. Foundry's server names the sender. The GM accepts
only `rest.completed`, only for an Actor that sender owns, and takes only the rest type from the data. A
rest on the GM's own client runs before `rest()` returns.

Not yet: `once` is ignored (triggers fire every time), and a trigger cannot target anyone but its owner.

Live (14.369): Quench ran a turn-start trigger once per turn, an initiative trigger when the Combatant
rolled, and a long-rest trigger that ignored a short rest. In two browsers, Player1's long rest made the GM
run its creature's trigger (10 → 7, with a card). The GM refused Player1's forged report for an Actor
Player1 does not own, and a report of a GM-only event.

**Advantage and disadvantage.** A `RollMode` RuleElement gives advantage or disadvantage on d20 rolls in
its domains:

- **Own rolls:** `attack`, `attack.melee`, `attack.ranged`, `save`, `save.<ability>` and `check`.
- **Attacks against the creature:** `attacked`, `attacked.melee` and `attacked.ranged`.

Its predicate sees `attack.type` and `attack.adjacent` (the attacker within 5 ft), so "advantage within
5 ft, disadvantage beyond" is two RollModes. The 2024 conditions are authored this way in
`WILDPATH.CONDITIONS` (rolls.md, "Advantage / Disadvantage and Modifiers").

**Resource caps.** A `ResourceCap` RuleElement puts a ceiling on resource maxima:
- `{resources: ["action", "bonus", "reaction"], maximum: 0}` is Incapacitated: no actions of any kind, so
  nothing can be paid and no reaction offered.
- `{resources: ["movement"], maximum: 0}` is Speed 0, and it caps every granted Speed too.

**Forced outcomes.** A `RollOutcome` RuleElement forces a roll's outcome:
- `automatic-failure` on the creature's saves in its domains (`save.might`). No roll is requested, and the
  target context carries the `automatic-failure` override.
- `critical-on-hit` on attacks against it (`attacked`): a hit becomes a critical hit. Its predicate sees
  `attack.adjacent`, measured per target.

**Leveled Modifiers.** A Modifier on an effect is bound to that effect's level (`effect.system.level`,
through the modifier's `bindings`). Exhaustion's 2024 penalties scale this way: −2 per level on d20 tests
(`attack`, `save`, `check`), and −5 ft per level on walking Speed and every other Speed (`speed`).

**Damage over time.** `damageOverTimeCondition({id, damageType, amount, stacking})` in `module/config.mjs`
builds a condition whose `Trigger` deals `amount` damage of `damageType` at the start of each of its
creature's turns. A stacking condition deals that amount once per stack (`effect.system.level`), and each
application adds a stack.
- **Envenomed** is poison and stacks. It is Poisoned's former damage, kept by the maintainer on 2026-10-14.
- **Bleeding** is bleeding damage and does not stack.

Another damage type is one more entry. Poisoned is now the 2024 condition only: disadvantage on attack
rolls and ability checks, and no damage.

```js
{type: "RollMode", predicate: {equals: {path: "attack.adjacent", value: true}},
  data: {domains: ["attacked"], mode: "advantage"}}
```

**Damage grants.** `GrantResistance` and `GrantImmunity` on a creature's active features, gear and
enabled effects form its damage profile (`WildPathActor#getDamageProfile`, through the pure
`damageProfileFromRuleElements`). The Action runtime passes each target's profile into damage
resolution as `durability.adjustmentProfiles`, and so do reaction children. An Action Item's own
RuleElements never count: they describe that Action.

**Resource grants.** `GrantResource` gives a creature a pool to spend and recover, such as Ki equal to a
class level. The grant backs a stored pool of the same id in `system.pools`, so payments, rests and the
sheet treat it like any other pool:

- **Maximum.** Each preparation adds the grant's maximum (a ValueExpression, so it can scale by level) to
  the pool's own base, bonus and modifiers.
- **Creation.** When a granting Item or effect arrives, the user who added it stores the pool, full, with
  the grant's recovery cadence. An Actor created with granting Items, such as an import, has the pool at
  once.
- **Removal.** The pool stays when its grant goes. With nothing granting it, its maximum falls back to its
  own base (0), and adding the grant back restores it.

```js
{type: "GrantResource", data: {resourceId: "ki", label: "Ki", recovery: "shortRest",
  maximum: {type: "class-level", class: "monk"}}}
```

Live (14.369): in Quench, a granted pool was spent and recovered on a short rest, dropped to 0 when its
Item was deactivated, and was present at once on an imported Actor. Player1 adding a Ki feature to their
own creature stored Ki 3/3 from their own client.

**Movement grants.** `GrantMovement` gives a Speed for a mode (`{mode: "fly", distance: 60}`), prepared into
`system.speeds`; movement in that mode uses it (movement-paths.md, "Movement modes (2024)").

**Custom resources and Legendary Actions (2024).** Both are `GrantResource` pools:
- Spirit Points, maximum 2 × proficiency bonus, recovered on a long rest:
  `{type: "GrantResource", data: {resourceId: "spirit-points", label: "Spirit Points", maximum: {type: "multiply",
  terms: [2, {type: "proficiency-bonus"}]}, recovery: "longRest"}}`.
- A monster's Legendary Actions: `{resourceId: "legendary-action", maximum: 3, recovery: "turn"}`, which refills at
  the start of the monster's own turn. Its legendary Actions cost `{capability: "legendary-action", amount: 1}`; a
  pool pays for its own id. Nothing yet enforces "only right after another creature's turn"; the GM decides.
- A long rest also restores what a short rest does.

Future resolvers should request the relevant RuleElement bundle
and interpret it inside their own domain boundary instead of adding item-, spell-, class-, or
condition-name branches.

## ExtraDamage (2026-10-14)

`{type: "ExtraDamage", data: {domains, expression, damageType, once?: "turn"}}` adds a damage component to an
Action's own damage in the damage domains (`damage`, `damage.melee`, `damage.weapon`, ...). Its predicates see
the attack type, the Action's tags, the attack's ability and the creature's conditions.

"When you hit with a melee attack, +1d6 fire, once per turn" is
`{domains: ["damage.melee"], expression: {type: "dice", number: 1, faces: 6}, damageType: "fire", once: "turn"}`.

- **Same Action, same card.** It is one more component of the Action's damage, so it is its own roll, a critical
  doubles it, and resistance applies to its own damage type. A separate follow-up Action would count as a second
  damage instance (a second Concentration save, more death-save failures), which 2024 does not do.
- **Once per turn.** A hit that dealt damage records the turn in `flags.wildpath.onceUsed.<owner>-<rule>`, on the
  attacker and in the same transaction (a `sourceUpdate` plan). A miss uses nothing. Each turn counts, not only the
  attacker's own, so it can apply again on another creature's turn (an opportunity attack). Outside combat there
  is no limit.
- `actor.getExtraDamage(domains, {item, tags})` collects these rules, including the acting Action's own.
  `actionCombatStatistics` adds them for the runtime and for reaction Actions.

Live (two browsers, 14.369): Player1's rogue's dagger with a once-per-turn "+1d6 fire" feature rolled "1d4" and
"1d6" on its first hit, only "1d4" on its second hit that turn, and "2d4" and "2d6" on a critical in its next
turn.

## Aura (2026-10-14)

`{type: "Aura", data: {radius, affects: "allies" | "enemies" | "all", ruleElements: [...]}}` grants its nested
rules to the creatures within `radius` feet of its bearer.
- **Who it covers.** Allies are the same Token disposition and enemies the opposite. `allies` and `all` include
  the bearer (2024 "you and friendly creatures"); `enemies` does not.
- **Example.** "You and allies within 10 ft gain +1 AC" is `{radius: 10, affects: "allies", ruleElements:
  [{type: "Modifier", data: {domains: ["defense.ac"], value: 1}}]}`.
- **When it is read.** Who is inside is worked out whenever a statistic is read for a roll or a defense:
  `game.wildpath.auras.ownersFor(actor)` (`module/adapters/foundry-v14-auras.mts`) checks the Tokens on the Scene
  with the lasting-area coverage test. That covers attacks, AC (including a re-scored attack), saves, checks and
  damage. Nothing is written to the affected creatures, so the bonus is never stale and never shows on a Player's
  sheet.
- **Limits.**
  - Data preparation leaves auras out, so an aura does not change Speed or health maxima.
  - Only Modifier-type rules reach statistics; roll modes from auras are not read yet.
  - Validation requires a radius, a known `affects`, and nested rules the engine knows.

Live (GM browser, 14.369, physical dice): a paladin's +1 AC aura gave an ally 10 ft away AC 15 (14 + 1). A goblin's
14 missed it there, and hit once the ally stood 20 ft away.

## Future Types

When adding a RuleElement type:

- define the persisted payload shape
- register one handler in the central registry
- validate the handler payload before contributing
- preserve source and RuleElement provenance in every contribution
- return plain contribution data only
- add pure tests for validation, predicate behavior, serialization, and non-mutation
- let the owning domain decide what the contribution means

## Boundaries

RuleElements must stay:

- declarative
- serializable
- inspectable
- testable without Foundry canvas/UI
- owned by domain interpreters

They must not become:

- script hooks
- embedded resolver implementations
- document mutation commands
- UI behavior definitions
- special-case feature branches

This keeps later content authoring broad without forcing every resolver to learn every possible
feature, item, condition, or spell name.
