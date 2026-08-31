# Abstraction Layers And Entity References

Wild Path should pass opaque string references through domain and resolver code. A rule module
should not need to know whether a target came from a world Actor, an unlinked Token Actor, a chat
button, the action bar, the combat carousel, or a future randomizer tool.

The current pure helper is `module/helpers/entity-refs.mjs`.
The shared TypeScript contract names for these refs live in `module/types/contracts.d.ts`.

## Reference Contract

Use strings for cross-layer identity:

- `actor:<actorId>` for a world Actor identity.
- `token:<tokenId>` for a Token identity when the Scene is not known.
- `token:<sceneId>.<tokenId>` for a Token identity scoped to a Scene.
- `item:<itemId>` for an Item identity.
- `effect:<effectId>` for an ActiveEffect identity.
- `uuid:<foundryUuid>` for a Foundry UUID when no narrower ref is appropriate.

These strings are opaque to rules code. Domain helpers may compare, copy, log, and validate them,
but should not resolve them to Foundry documents.

## Layer Rule

- UI and Foundry adapters may receive Actors, Tokens, Items, ActiveEffects, canvas selections, and
  DOM events.
- Adapter code normalizes those inputs to string refs before calling domain helpers or resolvers.
- Domain helpers and resolvers accept string refs plus plain rules data.
- Mutation planners return explicit plans; adapter code resolves refs and commits those plans with
  supported Foundry document operations.
- Rules code does not call `canvas`, query the DOM, render chat, update Actors, or infer authority
  from visible UI.

The narrow exception is migration code that keeps older `{actorId, tokenId}` shapes alive while
the resolver pipeline is being moved to string refs. New code should prefer `ref` and only carry
legacy IDs as compatibility metadata.

## Why This Matters

String refs preserve separation of concern:

- synthetic Token Actors can stay distinct from world Actors
- previews and randomizer output can be tested without a Foundry client
- action bar, combat carousel, sheets, and chat buttons can call the same resolver layer
- socket/GM authority handling can resolve and commit refs in one application/infrastructure place
- tests can assert stable identities without mocking Foundry documents

This is a guardrail, not a serialization format for user-facing content. If a feature needs more
than identity, pass additional plain data beside the ref rather than making every layer inspect the
document that the ref eventually points to.
