# Interruptible staged movement

`game.wildpath.executeMovementIntent(intent)` submits an ordered route to the existing action
coordinator using `ACTION_INTENT` with `resolutionKind: "movement"`. The active GM reconstructs
the route from the exact Scene, Token, and Token Actor. It verifies the authenticated sender's
ownership; client-supplied resources, rules, outcomes, and mutations are not authoritative.

This entry point currently accepts voluntary translation with an active GM. Walking is the default
mode; a trusted provider can configure other mode names, cost policies, and payment capabilities.
Native drag/checkpoint movement retains its existing completed-event workflow. It does not silently
gain before-transition reactions from this milestone. No persistent schema or migration is added.

## State and lifecycle

`createMovementResolutionHost` hosts an ordinary serializable `ResolutionState`. Its stages are:

1. Intention, route, and initial validation.
2. For each transition: propose, existing reaction window, revalidation, logical traversal.
3. Payment planning, ready-to-commit, transaction, and finalization.

`input.movement` holds the canonical `MovementPath`, evaluation, source, and payment conversion.
`results.movement` holds `completedTransitionCount`, cumulative cost, and stop reason.
The evaluation's ordered footprints plus that cursor distinguish the last completed logical
placement, proposed next placement, and remaining route. Every placement is a full
`TokenGridFootprint`, including Large square/hex footprints. Cost uses existing path evaluation,
including distance/field measurement and supplied step, occupancy, and transition policies.

Logical traversal does not persist intermediate Token coordinates. A reaction to leaving reach
runs before the proposed transition, at the **last completed logical footprint**. The Foundry
adapter supplies this footprint to normal child targeting/range validation; it does not relocate
the Token for each reaction. Other systems still reading canvas coordinates will see the origin
until the final movement transaction. Integration with those consumers is a later milestone.

## Reaction composition

Each proposed transition emits an interrupt fact, `movement.transition-proposed`, with stable ID
`<resolutionId>:transition:<index>`. Its data includes `previous`, `proposed`, transition cost,
movement kind/mode, and observer-relative `relations` keyed by configured observer identity.
Relations contain full-footprint distances, configured reach in fields, entering/leaving booleans,
and provider context. The helper contains no hostility or opportunity-attack rule.

A configured reaction uses existing Trigger/Predicate vocabulary, for example:

```js
predicate: {all: [
  {equals: {path: "event.data.movementKind", value: "voluntary"}},
  {equals: {path: "event.data.relations.guard.leavesReach", value: true}},
  {equals: {path: "event.data.relations.guard.context.hostile", value: true}}
]}
```

The existing ReactionResolver discovers payable candidates, groups and orders choices, and records
handled candidate IDs within the transition's window. Declines and completed children cannot reopen
the same opportunity. Later transitions have distinct identities. Multiple reactors remain
representable; they resolve sequentially using current grouped-choice semantics.

Acceptance creates `metadata.activeChildResolution` with its own ID and lineage. The child uses
the ordinary Action pipeline: configuration, targeting, reach, Actor attack statistic, RollProvider,
attack outcome, damage/effects, reaction payment, and transactional commit. Parent movement never
deducts a child's reaction cost. Actor/Token/UUID maps preserve exact synthetic Actors; ambiguous
base Actor ID aliases are omitted. Configure such reactions with the Actor UUID and exact Token ID.

Requests use normal coordinator envelopes and expected-controller checks. Child controller maps
are resolved from the reactor's ownership, including explicit active-GM fallback. They do not
inherit the mover's controller. Existing stale/duplicate-response guards apply without another
movement socket protocol.
The coordinator reserves resolution IDs before asynchronous intent resolution, preventing a new
intent from replacing a pending or completed root and reusing its request identities.

## Trusted provider boundary

The Foundry adapter calls the existing `game.wildpath.reactionServices` provider with
`{intent, resolutionKind: "movement"}`. Its return value may include:

```js
{
  reactions: {triggers: [/* ordinary ReactionTriggers */]},
  movement: {
    observers: [{id: "guard", token: reactorToken, reachFields: 1, context: {hostile: true}}],
    allowedModes: ["walk"],
    // Optional existing MovementPath evaluation options and explicit payment conversion:
    evaluationOptions: {measurementMode: "fields"},
    payment: {capability: "movement", unit: "movement", scale: 5},
    validate: ({state, traversal, token}) => ({decision: "continue"})
  }
}
```

This is a GM-side integration seam, not data accepted from the socket. Runtime Documents and
callbacks remain outside ResolutionState. Observer IDs must be unique. Observers are explicit,
so discovery does not scan every Token on every traversal step. The proof adapter automatically
targets the mover for movement reaction children; other target policies can be added at this
boundary without changing reaction or attack orchestration.

## Revalidation and payment

Revalidation runs initially, after each child, before completing each proposed transition, and
before commit. `continue` permits traversal; `stop` retains the completed prefix and discards the
suffix; `invalid` rejects stale movement. A child `cancel-parent` directive likewise stops the
suffix, preserving completed logical traversal for payment. Existing failed-child policy and
diagnostic summaries are retained. Duplicate child completion is idempotent.

The Foundry adapter rejects changes to source ownership, document membership, Actor identity,
position, dimensions/footprint, or grid configuration. The provider can inspect current effects
and return a continuation decision. The deterministic stop proof uses marked effect metadata,
not an HP rule. Footprint changes currently invalidate the route; recomputation is deferred.

Only the completed logical prefix generates a ResourceResolver payment plan. If current resources
cannot afford the next step, traversal stops. If even the completed prefix becomes unaffordable,
the parent fails without moving the Token. Planning and commit do not spend the intended suffix.
Payment uses a configurable capability/unit/conversion, including custom Actor pools. Default
field measurement converts fields to the existing canonical movement resource using grid distance.

## Persistence and limits

The existing transaction executes a generic Document position operation followed by movement
payment. Both have rollback data. Payment failure restores position using the same persistence
port. A changed payment snapshot during the position write fails the transaction. Concurrent or
replayed execution of the same host shares one commit result. Final transport results include
movement outcome and document references without serializing runtime handles.

V14.367 treats coordinate updates as native movement. A narrowly scoped persistence adapter uses
the verified `displace` movement action to render the resolved position without another traversal
cost. WildPath's protected pre-update hooks skip native approval only for an in-flight registered
write matching the exact Token, operation ID, and destination. An arbitrary socket option does
not establish that registration. Post-movement observation skips tagged updates only from the
authenticated active GM. Other Foundry hooks still run. Persisted coordinates are verified;
partial application is restored before failure is reported. Failed restoration is explicit.
Destination and persisted-coordinate checks compare `x`, `y`, and `elevation` allowing only
IEEE-754 noise relative to magnitude, because Foundry cleans Token `x`/`y` as integers and hex
field-to-pixel conversion is inexact (a planned `260.00000000000006` persists as `260`). Any
material coordinate difference, and every other field, must still match exactly.

These are compensating client transactions, not database atomic transactions. A committed child
reaction is independent of a later parent failure and is not refunded with parent movement.
Authority handoff/reload recovery, durable host reconstruction, global serialization against
unrelated concurrent Actor updates, native ruler integration, animation, and Region semantics
for intermediate logical positions remain deferred. The six-case semantic gate is live-confirmed in
V14.367 through the `wildpath.staged-movement` Quench batch on a single active-GM client; paired
GM/player verification remains the Level-5 sentinel in [the QA runbook](../development/staged-movement-qa.md).
