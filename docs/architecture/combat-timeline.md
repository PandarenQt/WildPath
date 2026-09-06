# Combat Timeline, Durations, and Scheduler

Wild Path combat automation should treat time as a structured event stream rather than a set of
UI render callbacks.

The current pure foundation is `module/helpers/combat-timeline.mjs`.

## Timeline

The timeline tracks:

- combat id
- round
- turn index
- ordered combatants
- active combatant
- emitted lifecycle events

Supported lifecycle events include:

- combat start/end
- round start/end
- turn start/end
- rest start/complete

Foundry Combat integration adapts into this event shape through `module/helpers/combat.mjs` and
`module/documents/combat.mjs`. Turn-start recovery and condition triggers use Foundry V14's managed
post-update `Combat#_onStartTurn` workflow. The current adapters also cover combat end and Actor
rest completion; movement-region hooks remain a future slice.
The combat carousel should read the same timeline state rather than maintaining independent turn
state.

Turn-resource recovery belongs to Foundry's managed Combat turn lifecycle. `WildPathCombat` is
registered as `CONFIG.Combat.documentClass`; its `_onStartTurn(combatant, context)` override runs
after the Combat document update on one designated GM user, receives the actual incoming Combatant,
builds a semantic `turnStart` event from `context.round` and `context.turn`, and invokes
`combatant.actor.startTurn(...)`. A bare Actor method call, Actor sheet button, macro-style manual
reset, or non-GM client observation is not a valid turn recovery source. The recovery applies to
`combatant.actor`, preserving synthetic/unlinked Token Actors instead of resolving through
`game.actors`.

## Durations

Durations are plain data with:

- stable id
- unit
- remaining count
- tick timing
- owner/source/target references
- metadata

Supported units:

- turns
- rounds
- combat
- short rest
- long rest
- permanent

Turn durations can tick on their owner's turn start or turn end. Round durations tick on round
events. Combat and rest durations expire on the matching lifecycle event.

## Scheduler

The scheduler is a pure matcher over timeline events. A scheduled event declares a trigger and
payload, then `collectDueScheduledEvents()` returns:

- due scheduled events
- remaining schedule

One-shot and recurring scheduled events share the same structure.

## Mutation Boundary

The helper does not mutate Actors, Items, ActiveEffects, or Foundry Combat documents. Future
resolvers should use the emitted events to plan and commit mutations through the normal authority
and transaction layers.

`EffectLifecycleResolver` now consumes this event shape to plan condition removals when committed
duration metadata expires. `WildPathCombat#_onStartTurn()` supplies managed turn-start events for
the incoming Combatant, `wildpath.mjs` supplies combat-end events, and `WildPathActor#rest()`
supplies rest completion events for the resting Actor. These paths commit resulting
condition-removal plans through `EffectLifecycleCommitResolver`, `TargetMutationCommitResolver`,
and `ResolutionTransaction`.

`ConditionTriggerResolver` also consumes turn-start events for condition Trigger RuleElements. The
current representative implementation is Bleeding's turn-start durability damage. Legacy
`system.dot` data is translated into synthetic Trigger RuleElements only as a temporary
compatibility layer.

`combatStart` and `combatTurn` are Foundry initiating-client, pre-update hooks. They are not used
for authoritative turn-resource recovery. Any remaining authoritative turn-end, round-start, or
round-end mutation that needs those events should move to the corresponding managed Combat
lifecycle method before production reliance.

## Future Consumers

This foundation is intended for:

- combat carousel state
- turn-start resource refresh
- condition ticking through Trigger RuleElements
- duration expiry through EffectLifecycleResolver
- delayed effects
- persistent area triggers
- reaction windows
- rest automation
- audit/debug timelines
