# Resource Resolution

Wild Path resource payment now has a resolver boundary between pure action-economy discovery and
Foundry Actor mutation.

The current implementation is `module/resolvers/resource-resolver.mjs`.

## Payment Flow

Resource resolution is split into three steps:

```text
actor resource snapshot
-> payment option discovery
-> selected payment plan
-> Actor update mutation plan
-> Foundry commit adapter
```

Discovery uses `module/helpers/action-economy.mjs`, so Action, Bonus Action, Reaction, Movement,
custom pools, alternative payments, and restricted resources share one payment model.
The Wild Path default policy allows a Bonus Action activity to spend an Action only after every
eligible Bonus Action resource for that activity has been depleted for the current turn.

## Mutation Plans

The resolver maps selected economy resource ids back to the current Actor data shape:

- `economy.action` -> `system.resources.action.value`
- `economy.bonus-action` -> `system.resources.bonus.value`
- `economy.reaction` -> `system.resources.reaction.value`
- `economy.movement` -> `system.resources.movement.value`
- custom pool ids -> `system.pools.{index}.value`

Planning does not mutate the Actor system object. It returns update paths plus before/after payment
trace data. `commitActorResourceMutationPlan()` is the thin adapter that calls `actor.update()`.

## Current Integration

`WildPathActor#resolveActionPayment()` plans an Action item's payment.

`WildPathActor#getActionPaymentOptions()` exposes discovery results for future UI.

`WildPathActor#canUseAction()` goes through the resolver. `WildPathActor#useAction()` now goes
through `ActionResolver`, which in turn delegates payment planning and Actor update paths to this
resolver while preserving the current cost-only behavior.

## Deferred Work

Future `ActionResolver` should call `ResourceResolver` through `ActionContext` / `ActionResult`
and place payment mutation inside a full `ResolutionTransaction`. That transaction should decide:

- when to reserve resources
- when reactions may interrupt
- when to commit or refund
- which client has authority to apply Actor updates
- how to report failures to chat/UI without hiding resolver errors
