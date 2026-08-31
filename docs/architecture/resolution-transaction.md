# Resolution Transaction

`module/resolvers/resolution-transaction-resolver.mjs` is the current ordered transaction boundary
for action execution.

The staged `ResolutionState` pipeline treats this as the commit boundary. Stages before commit
produce plain mutation plans; they should not call `actor.update()` or ActiveEffect document
operations directly.

## Current Flow

```text
mutation plans
-> Actor update transaction operations
-> rollback preflight
-> DocumentPersistencePort commits
-> reverse-order rollback if a later commit fails
```

## What It Does Now

`createActorUpdateTransactionOperation()`:

- turns a mutation plan into a commit operation
- carries live Actors only in transient runtime operations, not in `ResolutionState`
- derives rollback updates from durability `path/from` data or resource-payment `payments`
- accepts custom commit/rollback callbacks for document operations such as condition effects
- accepts a `persistencePort` for typed document mutation
- marks non-noop operations unsafe when rollback data is missing

`executeResolutionTransaction()`:

- refuses unsafe operations before any Actor update is attempted
- commits operations in order
- treats no-op updates as successful
- rolls back already-committed updates or custom rollback operations in reverse order when a later
  commit fails
- reports commit and rollback failures separately

`ActionResolver` currently uses this transaction for:

- target durability damage
- target durability absorption
- target durability healing
- target condition effects
- source resource payment

`ActionPipelineResolver` now reaches the same boundary by committing the already-planned staged
`ActionResult` with `commitPlannedActionResult()`. It no longer replans through
`executeActionResolution()` during `action.commit`.

Target durability commits still require explicit authority before they become transaction
operations. Target condition-effect commits use the same authority gate.

## What It Does Not Do Yet

ResolutionTransaction does not:

- discover Actors from canvas or world state
- decide who has authority
- own `ResolutionState` lifecycle or pause/resume requests
- reserve resources before reaction windows
- retry socket handoffs
- mutate Items, Combat, Scenes, or Regions
- guarantee database-level atomicity across Foundry documents

It is a best-effort ordered rollback layer over explicit mutation plans. Future Foundry adapter and
socket slices should keep those limits visible rather than treating it as a database transaction.

See `docs/architecture/foundry-persistence-ports.md` for the Foundry V14 adapter and deterministic
test adapter boundary.
