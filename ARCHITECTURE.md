ARCHITECTURAL REQUIREMENT — DOMAIN BOUNDARIES AND ABSTRACTION LAYERS

WildPath must preserve strong separation of concerns.

Do not solve integration by letting every subsystem directly call or mutate every other subsystem.

Use explicit abstraction layers and public contracts between domains.

DEPENDENCY DIRECTION

Prefer this general dependency direction:

Presentation / Foundry UI
        ↓
Application / Orchestration
        ↓
Domain / Rules
        ↓
Ports / Contracts
        ↑
Infrastructure / Foundry Adapters

The pure rules/domain layer must not depend on:
- canvas
- DOM
- sheets
- chat messages
- Foundry globals
- sockets
- Foundry Documents
- ApplicationV2
- rendering state

Foundry-specific behavior belongs behind adapters.

DOMAIN OWNERSHIP

Treat major concepts as domains with clear responsibility.

Examples:

Action Domain
- ActionDefinition
- action availability
- activation/cost declaration
- Action execution contract

Resolution Domain
- ResolutionContext
- ResolutionState
- ResolutionResult
- resolution pipeline
- pause/resume
- child resolutions

See `docs/architecture/resolution-state.md` for the current serializable state and staged
pipeline contract.

Rules Domain
- Predicate
- ValueExpression
- Modifier
- RuleElement
- derived rule evaluation
- provenance/tracing

Roll Domain
- RollRequest
- RollProvider
- RollResult
- advantage/disadvantage
- physical/manual/digital input

Targeting Domain
- TargetSet
- target eligibility
- target refinement
- per-target overrides

Spatial Domain
- GridField
- GridVertex
- TokenGridFootprint
- tactical distance
- range
- reach
- Area footprints
- topology

Action Economy Domain
- spendable capabilities
- payment discovery
- payment selection
- refresh policies

Effects Domain
- conditions
- effect lifecycle
- durations
- suppression
- RuleElement ownership

Inventory Domain
- InventorySpace
- access
- containment
- transfers
- capacity
- weight policy

Weapon Domain
- weapon properties
- WeaponSizePolicy
- weapon-specific mechanics

Timeline Domain
- combat time
- turns
- rounds
- rests
- semantic timing events

Reaction / Trigger Domain
- trigger discovery
- reaction eligibility
- interruption
- resume

Progression Domain
- classes
- subclasses
- levels
- grants
- spell progression

Presentation Domain
- view models
- character sheets
- HUD
- Rules Inspector

These boundaries do not need to become separate packages immediately, but their responsibilities and public contracts must remain clear.

PUBLIC CONTRACTS

Each domain should expose a small deliberate public API.

Other domains should depend on that API, not on internal implementation details.

For example:

Attack resolution may ask:

TacticalDistanceService.measure(...)

It should NOT know:
- how hex coordinates are stored
- how Foundry measures pixels
- how boundary fields are generated

Inventory UI may ask:

InventoryService.getAccessibleSpaces(...)

It should NOT know:
- how access grants are internally evaluated
- where a shared InventorySpace is persisted
- how weight propagation is calculated

ActionResolver may ask:

PaymentResolver.discover(...)

It should NOT manipulate Action Economy resources directly.

ABSTRACTION AT INTEGRATION BOUNDARIES

Use ports/adapters around external or implementation-specific behavior.

Examples:

TacticalGridPort
    ↳ FoundryV14GridAdapter

InventoryRepository
    ↳ FoundryInventoryRepository

RollProvider
    ↳ FoundryDigitalRollProvider
    ↳ ManualRollProvider

DocumentMutationPort
    ↳ FoundryDocumentMutationAdapter

AuthorityPort
    ↳ FoundrySocketAuthorityAdapter

Clock / Timeline source
    ↳ FoundryCombatAdapter

The domain should depend on the abstraction.

The Foundry adapter implements it.

Do not allow Foundry APIs to leak upward into pure rules logic.

CROSS-DOMAIN COMMUNICATION

When one domain needs another:

1. Prefer a public query/command contract.
2. Prefer immutable structured inputs/results.
3. Use semantic domain events when asynchronous/triggered behavior is intended.
4. Avoid direct mutation of another domain's internal state.

Example:

BAD:

DamageResolver
→ directly removes concentration ActiveEffects
→ directly edits Actor resources
→ directly creates chat output

BETTER:

DamageResolver
→ DamageResult

Concentration subsystem
→ observes/resolves concentration requirement

ResolutionTransaction
→ commits required mutations

Presentation
→ renders the resulting trace/chat information

Likewise:

BAD:

Movement code
→ manually detects opportunity attacks
→ spends reactions
→ rolls attacks

BETTER:

Movement Domain
→ emits CreatureLeavesReach event

Trigger/Reaction Domain
→ discovers eligible reactions

Action/Resolution Domain
→ executes chosen reaction

DATA OWNERSHIP

Each domain should own its own invariants.

Examples:

Inventory Domain owns:
- containment-cycle prevention
- transfer validity
- weight propagation

Spatial Domain owns:
- tactical distance
- footprint expansion
- grid topology

Action Economy owns:
- resource eligibility
- payment policies
- spending validity

WeaponSizePolicy owns:
- size compatibility
- oversized weapon consequences

Do not duplicate these rules in consumers.

A consumer asks the owning domain.

DOMAIN RESULTS, NOT SIDE EFFECTS

Prefer:

calculate
→ structured result
→ plan
→ transaction commit

over:

method call
→ hidden mutation across several systems

Pure domain functions should be used wherever practical.

This is particularly important for:
- previews
- multiplayer
- rollback
- reactions
- testing
- Rules Inspector
- homebrew validation

ANTI-CORRUPTION LAYER FOR FOUNDRY

Foundry VTT is infrastructure, not WildPath's rules model.

Do not let concepts such as:
- TokenDocument
- ActorDocument
- canvas coordinates
- ActiveEffect internals
- Foundry Roll objects

become the universal data types used by every domain.

Translate at the boundary into WildPath concepts such as:

ActorReference
TokenReference
GridField
RollRequest
EffectDefinition
InventorySpaceReference

Then translate back when committing to Foundry.

NO GOD SERVICES

Do not solve abstraction by creating:

WildPathManager
RulesManager
AutomationManager
GameService

that owns everything.

A large façade may coordinate domains, but it must delegate to focused subsystems.

If a class/module begins owning unrelated responsibilities, split it.

RESOLUTION PIPELINE AS ORCHESTRATION

The Resolution pipeline is an Application-layer orchestrator.

It may coordinate:

Targeting
Rolls
Saves
Damage
Effects
Action Economy
Transactions

but it must not absorb their implementation logic.

For example:

ResolutionPipeline
    ↓
TargetingStage
    ↓ calls TargetResolver

AttackStage
    ↓ calls AttackResolver

DamageStage
    ↓ calls DamageResolver

PaymentStage
    ↓ calls PaymentResolver

Each resolver retains ownership of its domain behavior.

ABSTRACTION SHOULD NOT MEAN PREMATURE GENERALIZATION

Do not create interfaces merely for the sake of interfaces.

Create an abstraction when it:
- protects a domain boundary
- allows Foundry infrastructure to be replaced/mock-tested
- isolates ruleset differences
- prevents duplicate implementations
- supports multiple implementations
- makes a subsystem independently testable

Avoid layers that only forward arguments with no architectural purpose.

TEST DOMAIN BOUNDARIES

Each major domain should have tests that do not require Foundry where practical.

Then add separate adapter/integration tests.

Preferred pattern:

Pure Domain Tests
        ↓
Contract Tests
        ↓
Foundry Adapter Tests
        ↓
End-to-End Foundry Tests

A failure in Foundry integration should not require debugging tactical geometry, inventory rules, and UI at the same time.

ARCHITECTURAL SUCCESS CRITERION

A subsystem is well separated when it can answer:

1. What data does this domain own?
2. What invariants does it enforce?
3. What is its public API?
4. What does it depend upon?
5. Which domains depend upon it?
6. Can its core behavior be tested without Foundry?
7. Can its implementation change without rewriting its consumers?

If those answers are unclear, improve the boundary before adding more features.

## architecture to aim for
┌─────────────────────────────────────────────┐
│              PRESENTATION                   │
│                                             │
│ Character Sheet   HUD   Homebrew Builder    │
└───────────────────┬─────────────────────────┘
                    │ view models / commands
                    ▼
┌─────────────────────────────────────────────┐
│          APPLICATION / ORCHESTRATION        │
│                                             │
│ Resolution Pipeline                         │
│ Action Execution                            │
│ Transactions                                │
│ Reaction Coordination                       │
└───────────────┬─────────────────────────────┘
                │ public domain contracts
                ▼
┌─────────────────────────────────────────────┐
│                 DOMAINS                     │
│                                             │
│ Rules        Actions       Rolls            │
│ Targeting    Spatial       Damage           │
│ Effects      Economy       Inventory        │
│ Weapons      Timeline      Progression      │
│ Reactions    Movement      Spellcasting     │
└───────────────┬─────────────────────────────┘
                │ ports
                ▼
┌─────────────────────────────────────────────┐
│              INFRASTRUCTURE                 │
│                                             │
│ Foundry V14 Documents                       │
│ Canvas/Grid                                 │
│ Foundry Rolls                               │
│ Combat                                      │
│ Sockets                                     │
│ Persistence                                 │
└─────────────────────────────────────────────┘

but most important dependency rule:
Presentation ───────┐
                    ▼
Application ───→ Domain
                    ▲
Infrastructure ─────┘
       implements ports
