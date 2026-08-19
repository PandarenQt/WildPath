# Resolution Transaction

`module/resolvers/resolution-transaction-resolver.mjs` is the current ordered Actor update
transaction boundary for ActionResolver execution.

## Current Flow

```text
mutation plans
-> Actor update transaction operations
-> rollback preflight
-> ordered actor.update() commits
-> reverse-order rollback if a later commit fails
```

## What It Does Now

`createActorUpdateTransactionOperation()`:

- turns a mutation plan into a commit operation
- carries the live Actor only at the Foundry adapter boundary
- derives rollback updates from durability `path/from` data or resource-payment `payments`
- marks non-noop operations unsafe when rollback data is missing

`executeResolutionTransaction()`:

- refuses unsafe operations before any Actor update is attempted
- commits operations in order
- treats no-op updates as successful
- rolls back already-committed operations in reverse order when a later commit fails
- reports commit and rollback failures separately

`ActionResolver` currently uses this transaction for:

- target durability damage
- target durability absorption
- target durability healing
- source resource payment

Target durability commits still require explicit authority before they become transaction
operations.

## What It Does Not Do Yet

ResolutionTransaction does not:

- discover Actors from canvas or world state
- decide who has authority
- reserve resources before reaction windows
- retry socket handoffs
- mutate Items, ActiveEffects, Combat, Scenes, or Regions
- guarantee database-level atomicity across Foundry documents

It is a best-effort ordered rollback layer over explicit mutation plans. Future Foundry adapter and
socket slices should keep those limits visible rather than treating it as a database transaction.
