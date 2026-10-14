# UI And UX Layer

Wild Path UI should be a command surface over the resolver layer. It should display state, gather
player or GM intent, and dispatch explicit command data. It should not decide rules legality or
mutate Foundry documents directly.

The current pure foundation is `module/helpers/ui-view-models.mjs`.

## Action Bar

The action bar view model turns an active actor, action list, and actor resource state into:

- action button state
- resource counters
- grouped action refs
- structured disabled reasons
- payment-option previews
- command payloads such as `action.use`

Availability is computed with the same action-economy payment discovery used by the resolver
layer. For example, the Wild Path rule that lets a spent Bonus Action be paid with an Action is
visible as an alternative payment option, not as a UI-only exception.

**In play (M6, 2026-10-14).** `WildPathActionBar` (`module/applications/action-bar.mts`) renders this view
model through `actionBarContext` (`helpers/action-bar-context.mts`).
- **Placement:** a frameless bar above the hotbar.
- **Creature shown:** the controlled Token's creature, else the user's assigned character. It shows only for
  an owner, and hides when there is none.
- **Contents:**
  - the Action, Bonus Action, Reaction and movement counters, then pools;
  - the creature's Actions grouped by their cost; an unaffordable one is greyed, with the payment code
    shown on hover;
  - its active conditions, with stack levels.
- **Use:** a click calls the real `Item.use()`, so the authority decides everything.
- **Updates:** it re-renders when that creature, its Items or its effects change.

Live (two browsers, 14.369): Player1 controlled their hero, whose bar showed Exhaustion 2 and movement
20/20. Melee Strike, imported from the WildPath Actions pack, rolled `1d20 − 4` from the bar. The Action
counter went to 0/1 and the strike button greyed out.

## Action Configuration And Preview

The future gameplay HUD should render `ActionChoiceRequest[]` from
`module/helpers/action-configuration.mjs`, collect explicit choice responses, then render
`ResolvedActionPreview`.

The HUD may display choices such as casting resource, optional modifiers, selected damage type,
resulting damage expression, costs, and structured deltas. It must not calculate upcast damage,
damage-type substitution, or payment legality itself. Those come from Action Configuration and
Action Economy so the previewed configuration is the same configuration later consumed by
`ActionResolver`.

## Combat Carousel

The combat carousel view model turns combat timeline data into:

- combat and combatant refs
- active, previous, and next turn entries
- actor/token refs
- initiative, defeated, and hidden state
- per-combatant resource/status summaries
- command payloads such as `combat.advanceTurn`

The carousel must share the same timeline and resource services as automation. It should not keep a
separate authoritative turn order or refresh model, and it should not expose a manual Actor start
turn command. Advancing real Combat is the player-facing way to reach turn recovery.

**In play (M6, 2026-10-14).** `WildPathCombatCarousel` (`module/applications/combat-carousel.mts`) renders
the shared view model through `combatCarouselContext` (`helpers/combat-carousel-context.mts`).
- **Placement:** a frameless strip at the top centre, shown while the viewed combat has started.
- **Contents:** the round, then each turn in Foundry's order: portrait, name, active turn, and defeated
  combatants dimmed. Each portrait also shows the creature's active conditions, as its Token already does.
- **Disclosure:**
  - A health bar shows only to the GM and to owners of the creature.
  - A hidden combatant shows to the GM alone. During its turn, players see no active portrait.
  - Health and conditions come from each combatant's own Token creature, so unlinked Tokens of one Actor
    stay apart.
- **Commands:**
  - A portrait pans to its Token, if the user can see it, and selects it for an owner.
  - **End Turn** shows to the GM and to the owner of the creature whose turn it is. It calls Foundry's
    `Combat#nextTurn`, so turn order and WildPath's turn automation stay Foundry's.

Live (two browsers, 14.369):
- The GM saw all three combatants, including a hidden ambusher.
- Player1 saw two, with health only on their own hero, and no End Turn button during the goblin's turn.
- On the hero's turn, Player1 ended it from the carousel.
- A portrait click panned to the goblin.
- The carousel closed when the combat was deleted.

## Concentration Check Prompts

The concentration check prompt view model turns pending concentration check requests into:

- actor/source/target refs
- actor and origin labels for display
- DC, ability, save key, and damage-taken summaries
- pending/resolved row state
- digital and physical-entry command payloads such as `concentrationCheck.submitResult`
- a commit command once every required result has been supplied

Prompt rendering should collect a roll total or explicit physical-dice outcome, then dispatch that
data to `ConcentrationCheckCommitResolver`. It should not compare saves against DCs or remove
effects directly.

## Character Sheet (M6, 2026-10-14)

The actor sheet renders `createActorSheetViewModel` (`helpers/character-sheet-view-models.mjs`) and
leaves the rules to the documents:
- **Header:** AC, level (characters) or threat (NPCs), and every Speed besides walking.
- **Rests:** Short and Long Rest buttons call `Actor#rest`.
- **Editing:** abilities, current values, and each resource's and pool's base (which sets its maximum).
  Pool fields are folded into the whole stored array, because V14 drops ArrayField element paths.
- **Conditions:** a click toggles one; on a stacking condition (Exhaustion, Envenomed) a click adds a
  level, a right-click removes one, and the level shows on the icon.
- **Death saves:** pips appear while the creature is at 0 health or has any marked. The "At 0 health"
  setting edits `system.dyingMode`.
- **Items and effects:** create, open (click the name) and delete (with Foundry's confirmation).
  Effects can also be enabled or disabled.

The sheet templates' wrappers are `<div>`s. Both sheets are ApplicationV2 sheets whose root element is the
form; the templates used to open their own nested `<form>`, so their inputs never reached the sheet's
form, and no field edit saved. Live on 14.369 the actor and item sheets now save every field.

## Rules Inspector (M6, 2026-10-14)

The GM's view of why a resolution came out as it did: `WildPathRulesInspector`
(`module/applications/rules-inspector.mts`) over `inspectResolution` (`helpers/resolution-inspection.mts`).
- **Source:** the authority's own records on the GM's client, the 25 most recent. Nothing is sent over the
  network, so the Inspector may show defenses, DCs and every roll (GM-facing, per the disclosure model).
- **Shown for each resolution:**
  - the stages it ran;
  - each roll: its kind, formula, mode (advantage or disadvantage), natural and total, and digital or
    physical;
  - attacks against their defense, and saves against their DC, automatic failures included;
  - health changes from and to;
  - every payment, the source's and a companion controller's;
  - errors.
- **Opening it:** an **Inspect** link that only GMs see on each resolution card, or `game.wildpath.inspect()`.

Live (two browsers, 14.369):
- The GM inspected Player1's Melee Strike by a Restrained hero: `2d20kl` at disadvantage, then the 1d8
  damage.
- The GM's Venom Burst showed the Fortitude save, 3 against DC 13, a failure, and the 2d6 damage.
- Player1's cards carried no Inspect link.

**Waiting resolutions.** Shift+I opens the Inspector for the GM, including for a resolution with no card yet.
A running resolution that waits on another user lists who it waits on, with **Answer for them**
(multiplayer-authority.md).

## Boundary Rule

- UI renders view models.
- UI dispatches command strings and opaque entity refs.
- Resolvers decide legality and produce mutation plans.
- Foundry adapters resolve refs and commit supported document operations.

This means actor sheets, the action bar, chat buttons, the combat carousel, and future GM tools can
all initiate the same action pipeline without duplicating rules logic.
