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

**Encounters and experience (2026-10-22).** `helpers/encounters.mjs` holds the 2024 tables: XP by Challenge Rating,
each character's XP budget by level (Low, Moderate, High; no multiplier for numbers) and the XP each level needs.
`applications/encounters.mjs`, for the GM:
- The combat tracker names the viewed combat's difficulty: its hostile creatures' XP (Token disposition hostile, NPCs)
  against its player characters' budgets, e.g. "Encounter: Moderate (750 XP; Low 600, Moderate 900, High 1600)".
- With the **Level Advancement** setting at experience points (the default; else milestones), a combat's end asks the
  GM to award the XP of the hostile creatures it defeated, split evenly among its player characters
  (`system.details.xp`, a new optional field), and the chat names who may now level up. A character's sheet shows its
  XP and the next level's.
Live (14.369): an ogre-sized foe (CR 2, 450 XP) against one 1st-level character was "Beyond High"; defeating it and
ending the combat awarded 450 XP, and the chat said the character may level up.

**Bastions (2026-10-22).** A Bastion's facilities (2024 DMG) are Items of a new type, `facility`, kept by their
character (as dnd5e keeps them, not a Bastion Actor): basic or special, the character level it needs, its size,
hirelings and the order it takes (`data/item/facility.mjs`). The book converter turns the DMG's 35 into them
(`convertFacility`; local only). A character's sheet lists its facilities in a Bastion section, where each special one is
issued its order for the turn (or Maintain). The GM's "Bastion Turn" tool among the Token controls
(`applications/bastions.mjs`) moves the world 7 days on, lists in the chat each facility carrying out its order, rolls a
Bastion event (d100) for a character whose facilities all maintained, and sets every order back to Maintain. shortcut:
what an order yields (crafted items, defenders, gold) and the event are the GM's, from the facility's text and the event
table. Live (14.369): a character's Arcane Study, ordered to Craft from its sheet, carried it out in a Bastion turn 7 days
long, and its order went back to Maintain.

**Chases (2026-10-22).** The GM's "Chase" tool among the Token controls turns the running combat into a chase
(`flags.wildpath.chase`, `applications/chases.mjs`; again, it ends it). In a chase each creature Dashes 3 + its
Fortitude modifier times freely; each Dash beyond takes a DC 10 Fortitude check, and a failure gives it 1 Exhaustion
level (counted on the creature, cleared when the chase or combat ends). At the end of each creature's turn a d20 is
rolled, and on 10 or lower the GM is told a complication befalls it. shortcut: what a complication is, and escaping, are
the GM's. Live (14.369): a character's fourth Dash in a chase called for its check, which failed: Exhaustion.

**Journeys (2026-10-22).** The GM's "Journey" tool among the Token controls (`applications/journey.mjs`) moves the
party some hours at a pace (2024 DMG): Fast 4, Normal 3, Slow 2 miles an hour. Each player character gets the pace's
effect for those hours (Fast: Disadvantage on Perception and Survival checks; Slow: Advantage), every hour past 8 is a
forced march (a Fortitude save, DC 10 + 1 per hour past 8, or 1 Exhaustion level), the world's time moves on, and the
chat says how far they went. shortcut: navigation, foraging and terrain are the GM's. Live (14.369): 9 hours at a Fast
pace went 36 miles; the forced march's failed save gave Exhaustion, and Perception checks had Disadvantage.

**Party rest (2026-10-21).** The GM's "Party Rest" tool among the Token controls (`applications/party-rest.mjs`) rests
every player character at once, a Short Rest (1 hour) or a Long Rest (8 hours), each by `WildPathActor#rest()`, then
moves the world's time on by those hours, so what lasts hours runs out. Each player spends Hit Dice from its sheet; an
interrupted rest is the GM's call. Live (14.369): a Long Rest took a player's character from 3 to 10 health and the world
8 hours on.

`ConditionTriggerResolver` also consumes turn-start events for condition Trigger RuleElements. The
current representative implementation is Bleeding's turn-start durability damage. Since 2026-10-20 that damage is
resolved by the authority as a damage-only Action on the creature (`game.wildpath.turnDamage`,
`adapters/foundry-v14-turn-damage.mts`), as a fall is. Its reactions before damage (Stone's Endurance), its resistances,
what keeps it up at 0 (Relentless Endurance) and the dying rules come from the Action pipeline, and its card reads
"Condition damage". It resolves on the creature's Token in that combat, even on a Scene no one is viewing. A creature
with no Token on a Scene still resolves it, on itself: resistances, rescue and dying, but no reactions, which need a
position. Only without the runtime is it committed directly. Live: Bleeding
at 1 Hit Point with Relentless Endurance left the Bandit Captain at 1 ("stays up"); the next round it died and was
marked defeated. A creature with no Token and fire Resistance took 4 of 8 fire, then 8 cold to 0 (2026-10-20).
Legacy
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
