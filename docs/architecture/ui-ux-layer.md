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

## Boundary Rule

- UI renders view models.
- UI dispatches command strings and opaque entity refs.
- Resolvers decide legality and produce mutation plans.
- Foundry adapters resolve refs and commit supported document operations.

This means actor sheets, the action bar, chat buttons, the combat carousel, and future GM tools can
all initiate the same action pipeline without duplicating rules logic.
