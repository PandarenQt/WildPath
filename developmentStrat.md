# WildPath — Integration-Proof Development Strategy

WildPath is a custom Foundry VTT V14 game system inspired by D&D 5e/5.5e and designed around deep
automation, extensibility, declarative rules, topology-aware tactical combat, and strong domain
boundaries.

The project has moved beyond its initial foundation-building phase. Predicate, ValueExpression,
Modifier, RuleElement, persisted ActionDefinition, Action Configuration, authoritative preview,
ResolutionState, staged/pauseable resolution, RollProvider, targeting/refinement, tactical spatial
primitives, Action Economy, transactions, InventorySpace, and WeaponSizePolicy should now be
treated as established foundations.

The current strategy is **integration proof**:

> Prove the existing abstractions through real Foundry V14 gameplay before inventing additional
> foundational systems.

Current status: the staged action, persistence-port, vertical-slice, and multiplayer
authority/socket proofs exist in Node integration tests. Live Foundry V14 runtime QA is still
required before those paths are considered manually verified in-engine.

---

# 1. Required Working Method

Before modifying anything:

1. Read and obey `AGENTS.md`.
2. Read and obey `CODEX.md`.
3. Read and obey `ARCHITECTURE.md`.
4. Read the architecture documents relevant to the task.
5. Inspect the current implementation and its tests before designing changes.
6. Verify roadmap/status claims against source and tests; code may have overtaken older documents.
7. Preserve working abstractions unless a concrete requirement demonstrates a deficiency.
8. State which existing systems the task should reuse.
9. Explicitly list what is not part of the task.
10. Implement the smallest complete vertical milestone.
11. Add pure tests first where practical.
12. Add adapter/integration tests and manual Foundry verification where the task crosses Foundry.
13. Run the full test suite and typecheck.
14. Perform an architecture audit.
15. Update current-state architecture/status documentation when the milestone changes it.
16. Finish with files changed, architecture decisions, tests, limitations, and recommended next step.

---

# 2. Governing Architecture

Prefer:

```text
Presentation / Foundry UI
        ↓
Application / Orchestration
        ↓
Domain / Rules
        ↓
Ports / Contracts
        ↑
Infrastructure / Foundry Adapters
```

Domain rules must remain testable without canvas/DOM/Foundry Documents whenever practical.
Foundry provides infrastructure and presentation; it is not the rules model.

---

# 3. Current Core Execution Model

The established action lifecycle is:

```text
ActionDefinition
      ↓
Availability
      ↓
Action Configuration
      ↓
ResolvedActionConfiguration
      ↓
ResolvedActionPreview
      ↓
ResolutionState
      ↓
Staged Resolution Pipeline
      ↓
Targeting / RollRequests / Domain Outcomes
      ↓
Mutation Plans
      ↓
Transaction
      ↓
Commit
      ↓
ResolutionResult / Semantic Events
```

Hard invariants:

```text
PREVIEWED CONFIGURATION = RESOLUTION CONFIGURATION = COMMITTED CONFIGURATION
PREVIEW FOOTPRINT = COMMITTED FOOTPRINT = RESOLUTION FOOTPRINT
```

Revalidation may reject a stale configuration/target/payment, but no second independent rules
calculation should exist for preview versus execution.

---

# 4. Abstraction Budget

The project is no longer rewarded for inventing additional generic layers speculatively.

Before creating a new major abstraction, demonstrate at least one of:

- an existing contract cannot represent a real Foundry integration requirement,
- a representative mechanic cannot be composed from existing primitives,
- a correctness/invariant problem requires a new ownership boundary,
- serialization or multiplayer authority cannot be made safe through existing contracts,
- meaningful duplicated logic cannot be eliminated through an existing public API.

Otherwise, reuse existing primitives.

---

# 5. Missing-Primitive Test

When a mechanic or integration becomes awkward, ask whether it can be composed from:

- ActionDefinition
- RuleElements
- Predicate
- ValueExpression
- Modifier
- Action Configuration
- ResolvedActionPreview
- Targeting / Target Refinement
- RollRequest / RollProvider / RollResult
- Spatial / TokenGridFootprint / GridFootprint
- Action Economy / payment discovery
- ResolutionState / child resolution
- semantic events / triggers
- transaction/mutation plans

If **yes**, use them.

If **no**, identify the smallest reusable missing primitive.

Never solve the problem by hardcoding the named spell, feature, class, or monster.

---

# 6. Integration Loop

For each meaningful milestone:

```text
existing contract
↓
small real capability
↓
pure tests
↓
adapter tests
↓
Foundry integration
↓
manual play verification
↓
architecture audit
```

When Foundry integration exposes friction, first decide whether the friction belongs to:

- the domain contract,
- application orchestration,
- a missing port,
- the Foundry adapter,
- presentation,
- multiplayer authority.

Fix the lowest correct layer.

---

# 7. Current Development Order

## Stage A — Generic Prompt / Choice Adapter

Reuse the canonical ResolutionState pending-request envelope and existing ActionChoiceRequest and
Roll contracts. Build application coordination and Foundry presentation adapters without creating
parallel request hierarchies.

## Stage B — Foundry V14 TacticalGrid Adapter

Adapt real Scenes/Tokens to GridField, GridVertex, TokenGridFootprint, and GridFootprint. Verify
square and hex topology, large creatures, range/reach, radial areas, lines, cones, and source-border
origins.

Status: the first adapter proof exists in `module/adapters/foundry-v14-tactical-grid-adapter.mjs`
with Node contract tests against Foundry-shaped Scene/Grid/Token fakes. Live Foundry runtime QA is
still required before treating this as fully in-engine verified.

## Stage C — Foundry Mutation / Persistence Ports

Move remaining raw Actor/Item/ActiveEffect mutation behind infrastructure ports while preserving
transaction/rollback behavior and synthetic Token Actor correctness.

Status: the staged action-resolution path now commits durability, resource payment, and condition
effect mutation plans through `DocumentPersistencePort`. The Foundry V14 adapter owns document
`update`, embedded ActiveEffect creation, document update/delete, and status toggles; the test
adapter records operations and proves rollback. Actor document convenience methods and older
condition data helpers still contain direct writes and remain a later legacy/lifecycle cleanup.

## Stage D — First Genuine Foundry Vertical Slice

Prove:

```text
persisted Action
→ configuration
→ preview
→ real target/area
→ roll/manual input
→ staged resolution
→ mutation plan
→ commit
→ structured result/chat feedback
```

Use representative mechanics, not broad content.

Status: representative persisted melee, ranged, save-based area, healing, condition-effect, and
configured/scaling actions now execute through staged resolution, RollProvider results, TacticalGrid
adapter footprints, mutation plans, transaction, and persistence ports in Node integration tests.
Live Foundry V14 runtime QA is still required.

## Stage E — Legacy Resolution Extraction

Replace `action.legacy-resolution` one responsibility at a time with dedicated stages calling the
existing domain resolvers. Preserve behavior and parity tests.

Status: `action.legacy-resolution` is no longer part of the default action pipeline. The legacy
`ActionResolver` remains as a direct-call compatibility facade and shared planning helper source.
Remaining extraction work is direct callers and older document/lifecycle paths, not the normal
staged vertical-slice execution path.

## Stage F — Multiplayer Authority / Sockets

Define authoritative ResolutionState ownership, chooser/roller routing, request/response correlation,
stale/duplicate rejection, and socket adapters.

Status: implemented as the first gameplay-focused socket/authority proof. `ACTION_INTENT` routes to
the active GM by default, pending requests are sent only to the expected active chooser or allowed GM
fallback, remote PromptPort/RollProvider responses resume the authoritative state, stale/duplicate
responses are rejected, no full ResolutionState is broadcast, and commits remain behind the
transaction/persistence boundary. See `docs/architecture/multiplayer-authority.md`.

## Stage G — ReactionEngine

Build reactions over semantic events, existing pending requests, child resolutions, and pause/resume.
No named-feature reaction code.

Status: generic foundation implemented. ReactionResolver now discovers eligible triggered Actions,
opens `reaction-choice` pending requests, creates child ResolutionState provenance, pauses/resumes
parents, supports generic reevaluation/cancel directives, and reuses the multiplayer request router.

Remaining Stage G work: insert reaction-window stages into the default action pipeline around
specific production timings and perform live Foundry reaction QA.

## Stage H — Movement

Build topology-aware complete-footprint movement, movement modes/costs, forced/voluntary/teleport
semantics, and movement events.

## Stage I — Persistent Spatial Mechanics

Compose Movement + Spatial + Events + Reactions into opportunity attacks, persistent Areas, hazards,
auras, and emanations.

## Stage J — Representative Content / Character Systems

Use difficult content to expose genuine missing primitives, then expand progression, spellcasting,
classes, subclasses, transformations, companions, and grants.

## Stage K — Product Surfaces

Build Homebrew Builder, finished Character Sheet, Rules Inspector, BG3-style HUD, combat carousel,
content packs, migrations, packaging, and release QA over the proven kernel.

---

# 8. Mutation Discipline

Prefer:

```text
discover
→ evaluate
→ validate
→ configure
→ preview
→ plan
→ commit
```

Discovery, configuration, preview, prompt rendering, target candidate discovery, and roll-provider
selection must not irreversibly mutate game state.

Persistent mutation occurs through the transaction/infrastructure boundary.

---

# 9. Integration-Specific Audit

After each milestone check for:

- Foundry APIs leaking into pure domain logic
- UI calculating game rules
- duplicate request/choice models
- new parallel Predicate/ValueExpression/Modifier engines
- direct raw Document mutation outside intended adapters/commit boundaries
- duplicate spatial calculations between Foundry and WildPath
- preview/execution divergence
- named-feature special cases
- global current-prompt/current-resolution state
- uncorrelated/stale multiplayer responses
- non-serializable objects crossing ResolutionState/socket/persistence boundaries
- stages reimplementing owning-domain rules
- ActionResolver or another coordinator becoming a new god object

Make the smallest coherent correction. Do not over-abstract to satisfy the audit.

---

# 10. Progress Metric

Do not primarily measure:

- number of spells
- number of classes
- number of monsters
- number of UI panels

Measure:

> How many distinct real gameplay mechanics can be implemented and played in Foundry without
> modifying the engine or violating its domain boundaries?

That is the primary measure of architectural maturity from this point forward.
