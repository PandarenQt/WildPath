# Foundry Persistence Ports

WildPath action resolution now treats Foundry document mutation as an infrastructure boundary.
Rules and staged resolution produce plain mutation plans; they do not call Foundry document update
methods directly.

## Flow

```text
domain resolver
-> mutation plan
-> transaction operation
-> ResolutionTransaction preflight
-> DocumentPersistencePort
-> Foundry V14 document adapter
-> Actor / ActiveEffect mutation
-> transaction summary
-> ResolutionResult
```

## Ports

`module/adapters/foundry-v14-persistence-adapter.mjs` implements the Foundry-backed
`DocumentPersistencePort` shape:

- `updateActor`
- `createEmbeddedDocuments`
- `updateDocument`
- `deleteDocument`
- `toggleStatusEffect`

These are typed operations, not arbitrary callbacks. The port is the only migrated action-path
layer that should call Foundry V14 document methods such as `update()` or
`createEmbeddedDocuments()`.

`module/adapters/test-persistence-adapter.mjs` provides the deterministic in-memory equivalent for
Node tests. It records operations, applies dot-path updates to plain Actor-shaped data, supports
ActiveEffect-shaped embedded documents, and can fail selected operations to prove rollback behavior.

## Transaction Ownership

`module/resolvers/resolution-transaction-resolver.mjs` still owns operation ordering, rollback
preflight, commit sequencing, and reverse rollback. It now delegates document writes to a supplied
persistence port. If no port is supplied, the default commit operation creates the Foundry V14
adapter for compatibility with existing Foundry runtime callers.

`module/resolvers/action-resolver.mjs` exposes `commitPlannedActionResult()`, allowing the staged
pipeline to commit an already-planned `ActionResult` without replanning through the legacy public
resolver.

## Remaining Direct Writes

The current direct-write audit still finds document writes in:

- `module/documents/actor.mjs`: Actor convenience/lifecycle methods such as resource spending,
  rest, and condition-trigger updates.
- `module/data/active-effect/condition.mjs`: older direct condition document helpers.

Those paths are not the migrated staged action-resolution path. They remain explicit legacy or
document-lifecycle work for later consolidation.

## Constraints

- `ResolutionState` and mutation plans remain serializable plain data.
- Live Foundry documents may appear in transient transaction operations and persistence adapters,
  but not in persisted resolution state.
- Resource payment, durability damage/healing, and condition effect plans must be calculated before
  commit.
- If a later operation fails, transaction rollback restores already-committed update operations
  where rollback data is available.
