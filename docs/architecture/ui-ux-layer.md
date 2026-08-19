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

Future action bar rendering should consume this view model rather than reading Actor resources and
Item costs ad hoc in DOM event handlers.

## Combat Carousel

The combat carousel view model turns combat timeline data into:

- combat and combatant refs
- active, previous, and next turn entries
- actor/token refs
- initiative, defeated, and hidden state
- per-combatant resource/status summaries
- command payloads such as `combat.advanceTurn` and `actor.startTurn`

The carousel must share the same timeline and resource services as automation. It should not keep a
separate authoritative turn order or refresh model.

## Boundary Rule

- UI renders view models.
- UI dispatches command strings and opaque entity refs.
- Resolvers decide legality and produce mutation plans.
- Foundry adapters resolve refs and commit supported document operations.

This means actor sheets, the action bar, chat buttons, the combat carousel, and future GM tools can
all initiate the same action pipeline without duplicating rules logic.
