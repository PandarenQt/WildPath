# Inventory Spaces, Access, Transfers, and Weight

Wild Path inventory is founded on `InventorySpace`: a logical place where items can exist.

The current implementation begins this foundation in `module/helpers/inventory.mjs`. It is pure
domain logic: no Foundry document is mutated directly.

## Inventory Spaces

An `InventorySpace` has:

- stable id
- label
- host reference
- access policy
- weight policy
- optional capacity
- optional parent item reference
- metadata

Spaces are not necessarily Actors. A space can represent personal inventory, a backpack, a shared
party chest, a vehicle cargo hold, a bag-style extradimensional space, or a custom homebrew space.

## Access vs Ownership

Owning or hosting a space is different from accessing it.

Examples:

- an Actor hosts their personal inventory
- a carried item grants access to a linked bag space
- a key item grants access to a remote vault
- two actors access one shared party space

Access grants preserve provenance so removal/transfer can revoke only the correct access.

## Containment vs Access

Containment and access are separate graphs.

An item can grant access to a remote space without containing that space. A physical container can
also contain a nested space. Cycle prevention applies to containment, not mere access.

## Access Grants

Access grants describe:

- target space
- grantee or grantee policy
- operations (`view`, `deposit`, `withdraw`, `manage`)
- active state
- predicate
- source/provenance

The current holder/carrier policy lets access follow an item when it is transferred.

## Shared and Private Spaces

Separate item instances can point to separate private spaces. Multiple items can also explicitly
link to the same shared space. Shared contents remain one authoritative storage space, not copies
per accessor.

## Weight Policies

Inventory weight separates:

```text
contents weight
who receives propagated weight
whether contents weight propagates at all
```

Supported policy modes:

- `track-and-propagate`
- `track-independently`
- `track-but-ignore-for-carrier`
- `ignore`

This supports ordinary carried storage, independent chests, bag-style spaces, and no-weight spaces
without hardcoding item names.

Multiple accessors do not multiply weight. Weight propagation is explicit policy, not a side effect
of access.

## Capacity

Capacity is independent of weight propagation. A space can track a 500 lb internal capacity while
contributing none of its contents to a carrier.

The current foundation supports maximum internal weight and maximum item count through safe
`ValueExpression` limits.

## Transfers

Transfers are planned before commit:

```text
planInventoryTransfer()
-> validate access, quantity, capacity, containment
-> commitInventoryTransfer()
```

Planning does not mutate state. Commit returns a new state. Partial stack transfers and stack
merging use `stackKey`, not display names.

## Cycle Prevention

The foundation rejects self-containment and recursive containment cycles, such as putting a bag into
its own contained space or into a descendant contained space.

## Foundry Boundary

Future Foundry integration should use an `InventoryRepository` adapter responsible for loading,
saving, listing contents, resolving references, and committing transfer transactions.

Domain code should not directly manipulate arbitrary Foundry storage documents.

The current pure boundary is `createInMemoryInventoryRepository()` in
`module/helpers/inventory-repository.mjs`. It is not the finished persistence implementation; it is
the method contract and test harness for future Foundry-backed adapters.

Repository responsibilities:

- load and save normalized inventory state
- list spaces and contents
- resolve space/item references
- query accessible spaces
- plan transfers without mutation
- commit transfer plans transactionally
- expose weight and debug snapshots

## Debug And Audit

`createInventoryDebugSnapshot()` preserves structured inspection data for developer tools and
future UI:

- spaces and contents
- access operations and provenance
- access grants
- containment edges
- internal weight per space
- actor weight trace when an actor context is supplied
