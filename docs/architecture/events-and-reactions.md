# Automation Events, Triggers, and Reactions

Wild Path automation should expose important rules moments as semantic events, not as direct UI,
canvas, or chat callbacks.

The current pure foundation is `module/helpers/automation-events.mjs`.

## Event Shape

An automation event is plain data with:

- stable optional `id`
- semantic `type`
- `phase`
- source Actor/Token reference
- target Actor/Token references
- tags
- structured data payload
- metadata

The helper includes common action, targeting, attack, save, damage, healing, effect, movement,
area, turn, round, and rest event type constants. Foundry hooks and resolver internals can also
adapt other event type strings into the same shape when needed.

## Trigger Shape

A trigger definition declares:

- stable `id`
- kind (`automation` or `reaction`)
- event matcher
- optional structured predicate
- priority
- one-shot behavior
- payload
- owner/reaction references

Matching is deterministic. It checks event type, phase, source, target, and tags, then evaluates
the shared structured predicate helper. It returns dispatch plans; it does not execute effects.

## Reaction Windows

Reaction triggers are normal triggers with a reaction payload and a payment requirement. The helper
uses the existing action-economy primitives to determine whether a reaction resource can pay the
window cost.

`collectReactionWindows()` returns:

- eligible reaction windows
- default payment options
- rejected windows with structured codes

It does not spend resources, prompt users, create chat cards, or mutate Foundry documents. Future
`ReactionResolver` and `ResolutionTransaction` code should own those steps.

## Resolver Boundary

Resolvers should emit automation events as part of normal resolution:

```text
ActionResolver
-> semantic AutomationEvent
-> trigger/reaction planning
-> transaction-controlled consequences
```

UI may display prompts for eligible reaction windows, but the rules for eligibility and payment
must remain in the resolver/domain layer.

## Future Consumers

This foundation is intended for:

- reactions such as "when hit" or "when a creature leaves reach"
- condition and feature triggers
- persistent area enter/leave/start-turn/end-turn hooks
- once-per-turn and once-per-round features
- action bar availability explanations
- combat carousel turn-start automation
- homebrew trigger builder output

The helper is not a socket protocol or multiplayer authority layer. It only plans what should be
offered or dispatched; Foundry adapters still need GM/client authority guards before committing
state.
