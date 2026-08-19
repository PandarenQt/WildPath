# TypeScript Migration

Wild Path should use TypeScript for new system code, but the migration should be staged. The goal is
stronger contracts at rules/resolver/UI boundaries, not a noisy rewrite of working Foundry
integration code.

## Why TypeScript

TypeScript is valuable for Wild Path because the system is becoming a layered automation engine:

- opaque entity refs should stay strings across domain boundaries
- resolver inputs and outputs need stable shapes
- mutation plans must be explicit and safe to commit
- action-economy resources can grow beyond built-in Action / Bonus Action / Reaction assumptions
- UI view models should not drift away from resolver/domain results
- Rules Inspector traces need trustworthy provenance data

Discriminated unions are especially useful for resolver results:

```ts
{ ok: true, code: "OK", ...data }
{ ok: false, code: "INSUFFICIENT_RESOURCE", reason: "..." }
```

That shape makes failure handling explicit and prevents accidental mutation after a failed
resolution.

## Tradeoffs

Pros:

- safer refactors as the system grows
- stronger separation between domain, resolver, Foundry adapter, and UI layers
- better editor autocomplete for action, effect, resource, and view-model shapes
- clearer extension contracts for homebrew systems
- fewer hidden shape mismatches between tests, sheets, resolvers, and future HUD code

Cons:

- introduces build/typecheck tooling
- Foundry typings can be incomplete or awkward around runtime APIs
- broad conversion would create churn before some domain models are stable
- over-typing early exploratory code can slow iteration
- compiled output must remain compatible with Foundry's expected JavaScript module loading

## Migration Rule

Do not convert the whole repo at once.

Use TypeScript first where contracts are most valuable and Foundry runtime coupling is lowest:

1. shared domain types
2. pure helper/resolver modules
3. view models
4. adapter boundary types
5. Foundry document and ApplicationV2 classes only after the surrounding contracts are stable

## Initial Tooling

The first scaffold is intentionally non-disruptive:

- `tsconfig.json` exists for editor/tooling configuration
- `module/types/contracts.d.ts` defines shared contract types
- no package dependency or required `npm run typecheck` is added yet

The next tooling step should add a pinned `typescript` dev dependency and a `typecheck` script once
the team is ready to run TypeScript in CI or local verification.

## Recommended First Type Targets

Use new `.ts` modules for fresh pure code in this order:

1. entity reference contracts and helper implementation
2. action context/result contracts
3. resource payment/resolver results
4. damage/healing/effect resolver results
5. action-bar/combat-carousel/character-sheet view models
6. Rules Inspector trace structures
7. Foundry adapter interfaces for resolving refs and committing mutation plans

Existing `.mjs` files should be converted only when they are already being changed for meaningful
work.

## Foundry Boundary

Keep Foundry-specific APIs isolated:

- adapters may accept Actors, Items, Tokens, ActiveEffects, Combat, canvas state, and UI events
- adapters normalize those values into typed string refs and plain data
- domain/resolver code consumes the typed refs and plain data
- commit adapters resolve refs back to Foundry documents and perform supported document operations

When Foundry typings require `unknown`, assertions, or local shims, isolate them in adapter files
and explain why.

## Definition Of Done For Migration Slices

Each TypeScript migration slice should:

- preserve runtime behavior
- avoid unrelated formatting churn
- add or update tests for any behavior changes
- keep generated/compiled output decisions explicit
- update this document if the migration strategy changes

Full TypeScript adoption is successful when type contracts make the automation pipeline harder to
misuse without making Foundry integration harder to maintain.
