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
- `GrantActionEconomyResource`
- `GrantResistance`
- `GrantImmunity`
- `GrantMovement`
- `Trigger`

Handlers return contribution bundles only:

- `modifiers`
- `resources`
- `economyResources`
- `damageAdjustments`
- `movement`
- `triggers`

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

**Damage grants.** `GrantResistance` and `GrantImmunity` on a creature's active features, gear and
enabled effects form its damage profile (`WildPathActor#getDamageProfile`, through the pure
`damageProfileFromRuleElements`). The Action runtime passes each target's profile into damage
resolution as `durability.adjustmentProfiles`, and so do reaction children. An Action Item's own
RuleElements never count: they describe that Action.

Other contribution types (`GrantResource`, `GrantActionEconomyResource`, `GrantMovement`) are available
as pure collected data but are not yet wired into Foundry document preparation or resolution. Future resolvers should request the relevant RuleElement bundle
and interpret it inside their own domain boundary instead of adding item-, spell-, class-, or
condition-name branches.

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
