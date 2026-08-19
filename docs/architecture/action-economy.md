# Action Economy and Movement Foundation

Wild Path models action economy as an extensible collection of spendable capabilities, not as a
closed set of booleans or hardcoded Actor fields.

## Core Model

An economy resource has:

- stable `id`
- `category`
- `current` and `maximum`
- `unit` (`uses`, `points`, or `movement`)
- `paymentCapabilities`
- optional `predicate`
- `refreshPolicies`
- optional `source`
- optional `metadata`

The built-in definitions cover Action, Bonus Action, Reaction, Movement, Legendary Action points,
and Lair Action use. Custom resources can use the same shape without changing the resolver.

## Payment Flow

Actions declare what they require as activation costs:

```text
ActivationCost
-> resolvePaymentOptions()
-> selectDefaultPaymentOption() or user choice
-> commitPaymentPlan()
```

Payment discovery does not mutate resources. Only `commitPaymentPlan()` returns a new state with
the selected resources consumed. This prepares the system for a future `ResolutionTransaction`.

## Normal, Alternative, and Restricted Payments

Normal payment is direct capability matching: a resource with `paymentCapabilities: ["action"]`
can pay an Action requirement.

Alternative payment is policy driven. The current foundation supports the Wild Path house rule
where a Bonus Action activity can be paid by an Action after all eligible Bonus Action resources
for that activity are depleted. This policy is enabled by default for Wild Path and can be disabled
with `allowActionForSpentBonusAction: false` for rules variants. A Bonus Action resource remains
preferred while any eligible one is available, and the fallback does not hide predicate failures or
the complete absence of a usable Bonus Action resource.

Restricted payment is predicate driven. A Haste-style extra Action can advertise `action` payment
capability and also provide a predicate such as `tagsAny: ["weapon-attack"]`. The payment resolver
does not check feature names.

## Refresh

Refresh policies are semantic identifiers, not Foundry hook names:

- `turnStart`
- `roundStart`
- `combatStart`
- `shortRest`
- `longRest`
- `manual`
- `none`

The current Foundry turn hook can call these policies through a later `ResourceResolver`; the pure
helper already supports refresh by semantic event.

## Movement Capability vs Movement Budget

Movement capability is canonical Actor data expressed as distance:

```text
walk = 30 ft
fly = 60 ft
```

The turn budget is derived from capability through the movement measurement policy:

```text
canonical speed -> movement policy -> derived budget -> movement cost -> remaining budget
```

Distance mode counts distance directly. Field mode divides canonical distance by the Scene grid
distance and produces a field budget. Field mode returns `FIELDS_REQUIRE_GRID` for gridless Scenes
instead of pretending fields have meaning there.

Additional movement is represented as an additional sourced budget, not by rewriting base speed.
Speed modifiers and additional spendable movement therefore remain distinct concepts.

## Movement Cost

Movement cost accepts a path-like object instead of only start/end coordinates. Foundry adapters can
later populate this from V14 grid/path measurement. Forced movement and teleportation are explicit
movement kinds that do not consume normal movement budget by default.

## Existing Data Compatibility

No schema migration is introduced by this foundation. `economyResourcesFromActorResources()`
adapts the current Actor `system.resources` and `system.pools` shape into generic economy
resources, so future resolvers can use the new payment model before persisted Actor data changes.

## Resource Resolver

`module/resolvers/resource-resolver.mjs` now wraps these primitives for Actor action payments. It
discovers payment options, selects a plan, maps economy resources back to Actor update paths, and
commits through a small `actor.update()` adapter.

Current `WildPathActor#useAction()` uses `ActionResolver`, which delegates resource planning and
Actor update paths to this resolver while still only spending costs. It does not perform targeting,
rolls, damage, healing, effects, or reaction prompts yet.

## Deferred Work

- `ActionResolver` should select payment timing inside the full action pipeline.
- `ResolutionTransaction` should own rollback/commit ordering.
- `ReactionEngine` should decide when reaction windows exist.
- `MovementEngine` should integrate Foundry V14 path, terrain, area, and token movement APIs.
