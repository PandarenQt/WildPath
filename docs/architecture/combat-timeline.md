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

Foundry combat hooks now begin adapting into this event shape through
`module/helpers/combat.mjs#getCombatLifecycleEvents()`. The current adapter covers
`combatStart` and `combatTurn`; combat end, rest, and movement-region hooks remain future slices.
The combat carousel should read the same timeline state rather than maintaining independent turn
state.

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
duration metadata expires. `wildpath.mjs` supplies combat start/turn events on the active GM client
and commits resulting condition-removal plans through `EffectLifecycleCommitResolver`,
`TargetMutationCommitResolver`, and `ResolutionTransaction`.

## Future Consumers

This foundation is intended for:

- combat carousel state
- turn-start resource refresh
- condition ticking
- duration expiry through EffectLifecycleResolver
- delayed effects
- persistent area triggers
- reaction windows
- rest automation
- audit/debug timelines
