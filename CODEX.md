This file contains Codex-specific working instructions for the WildPath Foundry VTT V14 game system.

AGENTS.md is the canonical engineering contract for this repository.

Codex must read and obey, in order:

AGENTS.md

this CODEX.md

relevant architecture/design documents for the task

task-specific instructions supplied by the user

If this file conflicts with AGENTS.md, AGENTS.md wins.

Task-specific prompts may refine scope and priorities, but must not silently violate the architectural invariants in AGENTS.md.

1. Primary Development Goal

WildPath is not being built as a collection of individually scripted D&D mechanics.

The primary goal is to create a general-purpose, extensible rules and automation platform where later game content can be expressed mostly through data and reusable rule primitives.

Prefer new content to be representable through combinations of:

ActionDefinition

ResolutionContext / ResolutionState

ResolutionResult

Predicate

ValueExpression

Modifier

RuleElement

Resources / Action Economy

Effects / Conditions

Targeting rules

Spatial rules

semantic Events / Triggers

before adding feature-specific engine code.

The development metric is not:

How many D&D features have been hardcoded?

It is:

How many D&D and homebrew features can be expressed without adding new engine code?

2. Current Strategic Priority

Until the core architecture is sufficiently consolidated, prioritize foundational/core functionality over content breadth and UI polish.

Current high-priority areas are:

unified Predicate infrastructure

expanded safe/serializable ValueExpression

generic Modifier definitions with selectors, predicates, provenance, and traces

real RuleElement registry and execution model

migration of condition/effect mechanics away from feature-specific executable generators

canonical persisted ActionDefinition

addressable/staged Resolution Pipeline

staged TypeScript migration of core contracts

strong domain boundaries and ports/adapters

Foundry V14 integration of already-tested pure-domain systems

Do not prioritize large spell, monster, class, or item catalogs until these foundations are strong enough to express them cleanly.

3. Separation of Concerns Is a Hard Requirement

WildPath must preserve strong domain boundaries.

Do not solve integration by allowing every subsystem to call and mutate every other subsystem directly.

Use explicit abstraction layers, public contracts, structured inputs/results, and ports/adapters where appropriate.

Preferred dependency direction:

Presentation / Foundry UI
        ↓
Application / Orchestration
        ↓
Domain / Rules
        ↓
Ports / Contracts
        ↑
Infrastructure / Foundry Adapters

The Domain layer must never depend upward on UI or infrastructure.

4. Layer Responsibilities

Presentation

Examples:

Actor sheets

Item sheets

BG3-style HUD

Homebrew Builder

Rules Inspector UI

prompts / dialogs

Presentation should:

render domain/application state

send commands/choices

display structured validation and trace information

Presentation should not calculate game rules.

Application / Orchestration

Examples:

Action execution

Resolution Pipeline

reaction coordination

transaction coordination

pause/resume workflows

request/response coordination

Application code may coordinate multiple domains, but it must not absorb their internal rule logic.

An orchestrator may call:

TargetResolver

AttackResolver

SaveResolver

DamageResolver

PaymentResolver

but should not reimplement those domains.

Domain / Rules

Examples:

Rules primitives

Actions

Rolls

Targeting

Spatial

Damage / Healing

Effects

Action Economy

Inventory

Weapons

Timeline

Movement

Reactions

Progression

Spellcasting

Domain code owns mechanical invariants and should be as Foundry-independent as practical.

Infrastructure

Examples:

Foundry V14 Documents

Canvas / Scene grid

Foundry Roll objects

Combat Documents

sockets

persistence

chat output adapters

Foundry is infrastructure, not WildPath's rules model.

Translate at boundaries.

5. Major Domain Ownership

Each domain owns its invariants.

Rules Domain

Owns:

Predicate

ValueExpression

Modifier

RuleElement

rule provenance

rule evaluation traces

Do not create subsystem-specific predicate languages unless there is a proven semantic requirement.

Action Domain

Owns:

ActionDefinition

action identity

activation declarations

costs

action availability contracts

An Action should eventually be persistable and executable through:

Item / Action content
        ↓
ActionDefinition
        ↓
Resolution Pipeline

Avoid callers manually assembling most mechanics outside the persisted Action definition.

Resolution Domain

Owns:

ResolutionContext

ResolutionState

ResolutionResult

parent/child resolutions

staged resolution

pause/resume-compatible state

The Resolution Pipeline is an orchestrator, not a god object.

Roll Domain

Owns:

RollRequest

RollProvider

RollResult

digital/manual/physical roll abstraction

advantage/disadvantage accumulation

roll modifications

Manual and digital rolls must feed the same downstream pipeline.

Targeting Domain

Owns:

candidate targets

eligibility

TargetSet

selection/refinement

include/exclude

per-target resolution overrides

Area geometry determines physical candidates.

Targeting determines which candidates participate and how.

Do not mutate Area footprints to represent target exceptions.

Spatial Domain

Owns:

GridField

GridVertex

TokenGridFootprint

grid topology

boundaries

tactical field distance

range

reach

Area footprints

Line / Cone / radial topology

For gridded combat:

The grid is the geometry.

Never use Token center-to-center distance as the authoritative tactical range between creatures.

Use full occupied tactical footprints.

Creature size is mechanical, not cosmetic.

The standard built-in size categories include:

Tiny

Small

Medium

Large

Huge

Gargantuan

Topology-specific footprint mappings must remain ruleset/provider-driven.

Examples already required by WildPath include:

Large square: 2×2 / 4 fields

Huge square: 3×3 / 9 fields

Large hex: 3 hexes

Huge hex: 7 hexes

Tiny must support shared-field occupancy semantics.

Do not derive hex footprints from square width/height assumptions.

Action Economy Domain

Owns:

spendable action capabilities

Action

Bonus Action

Reaction

Movement resources

Legendary Actions

Lair Actions

additional/custom Actions/Reactions

payment eligibility

payment discovery

payment selection

payment commit

refresh policies

Do not reduce Action Economy to a closed enum of three booleans.

Effects Domain

Owns:

conditions

effect lifecycle

durations

suppression

stacking policy

expiry

effect-provided RuleElements

Prefer:

Condition / Effect
→ RuleElements
→ semantic Event
→ normal Resolution pipeline

over condition-specific executable code such as dedicated DoT tick functions.

Inventory Domain

Owns:

InventorySpace

access

containment

shared spaces

item-granted access

transfers

capacity

weight policy

weight propagation

cycle prevention

Keep these separate:

ownership
access
containment
weight responsibility

An Actor may access a space without owning it or carrying its contents.

Weapon Domain

Owns:

weapon properties

designed/effective weapon size

WeaponSizePolicy

oversized-weapon consequences

Keep separate:

Creature Size
Weapon Size
Heavy
Reach
Wieldability

Weapon size must not implicitly add tactical reach.

Tactical range/reach belong to the Spatial Domain.

Timeline Domain

Owns semantic time/events such as:

combat start/end

round start/end

turn start/end

rests

Do not hardcode resource recovery or condition ticking directly into Actor.startTurn() when it can be expressed through semantic timeline/event handling.

Reaction / Trigger Domain

Owns:

trigger discovery

eligibility

reaction windows

chooser/authority

interruption

resume

Movement should emit semantic events such as CreatureLeavesReach; Reaction logic should decide whether an Opportunity Attack is available.

Movement code must not directly perform Opportunity Attacks.

6. Public Contracts Over Internal Access

Each major domain should expose a small deliberate public API.

Consumers depend on the contract, not internals.

Example:

Attack resolution
→ TacticalDistanceService.measure(...)

Attack resolution should not know:

how axial hex coordinates are stored

how boundary vertices are generated

how Foundry pixels map to fields

Likewise:

Inventory UI
→ InventoryService.getAccessibleSpaces(...)

The UI should not know:

how access grants are evaluated

how shared storage is persisted

how weight propagation is calculated

7. Ports and Adapters

Use abstractions around infrastructure where they protect real boundaries.

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

CombatTimelinePort
    ↳ FoundryCombatAdapter

Do not create interfaces merely to increase abstraction count.

An abstraction should protect at least one of:

domain boundary

infrastructure dependency

ruleset variation

alternate implementation

testability

serialization boundary

Avoid layers that only forward arguments with no architectural value.

8. Cross-Domain Communication

When one domain needs another:

use the other domain's public query/command contract

prefer immutable structured input/result objects

use semantic events for triggered/asynchronous behavior

do not mutate the other domain's internal state directly

Prefer:

calculate
→ validate
→ plan
→ choose if needed
→ commit transaction
→ structured result

rather than hidden cross-system mutation.

This is particularly important for:

multiplayer authority

rollback

reactions

previews

Rules Inspector

homebrew validation

debugging

9. No God Objects or God Services

Do not solve coordination by creating a giant:

WildPathManager

RulesManager

AutomationManager

GameService

A façade/orchestrator may exist, but it must delegate to focused domains.

If a class/module accumulates unrelated domain behavior, refactor it before extending it further.

Pay particular attention to ActionResolver growth.

The desired direction is an addressable pipeline where focused stages delegate to focused resolvers.

10. Resolution Pipeline Direction

Refactor/extend resolution toward a staged model.

Conceptually:

Validation
→ Origin
→ Targeting
→ Payment Planning
→ Attack / Check / Save
→ Damage / Healing
→ Effects
→ Commit
→ Finalization

Exact stages may differ.

Each stage should operate on structured shared state.

The architecture must support future:

run
→ pause
→ request choice/reaction
→ update resolution state
→ resume

Do not implement Reactions by burying callback logic inside a giant resolver function.

11. Declarative Rules, Not Arbitrary Code

Persisted/homebrew rule definitions should be serializable and safe.

Prefer:

Predicate

ValueExpression

Modifier

RuleElement

structured Action components

Do not use:

eval

arbitrary JS expressions

persisted executable functions

feature-name checks

Avoid code such as:

if (feature.name === "Sculpt Spell") { ... }

Build the reusable mechanism instead.

12. Foundry V14 Integration Rules

Before using a Foundry API whose exact V14 behavior matters:

verify it against the current V14 API/docs/source available to the task

do not invent methods

do not use legacy APIs merely because they are familiar from older Foundry versions

Prefer current V14 architecture such as the repository's established use of:

System Data Models

ApplicationV2

ActorSheetV2

HandlebarsApplicationMixin

proper Document operations

Handle synthetic Token Actors correctly.

Do not mutate raw document source objects when proper Document update/create/delete operations are required.

13. TypeScript Strategy

WildPath's core contracts should increasingly be TypeScript-first.

Do not attempt a risky repo-wide rewrite.

Prioritize new/heavily modified contracts such as:

Predicate

ValueExpression

Modifier

RuleElement

ActionDefinition

ResolutionContext

ResolutionState

ResolutionResult

resolver-stage contracts

TargetSet

spatial contracts

Inventory contracts

Add and maintain a real typecheck command.

Migrate touched .mjs code incrementally where practical.

Strict typing is especially valuable for discriminated unions and structured resolution states.

14. Testing Strategy

Testing is part of implementation, not cleanup.

Preferred testing layers:

Pure Domain Tests
        ↓
Contract Tests
        ↓
Foundry Adapter Tests
        ↓
End-to-End / Manual Foundry Tests

Core rules should be testable without Foundry wherever practical.

Do not reduce tests to make refactoring easier.

Always run the existing relevant tests and the full suite when practical.

When TypeScript is involved, also run typecheck.

15. Test the Invariant Owner

Tests should live close to the domain that owns the invariant.

Examples:

Spatial tests own:

footprint topology

distance

reach expansion

Area field generation

Inventory tests own:

access

weight propagation

transfer validity

containment cycles

Action Economy tests own:

payment discovery

payment eligibility

spending

refresh

Consumers should not duplicate those algorithms in their own tests/implementation.

16. Hex Grid Is First-Class

WildPath expects significant hex-grid use.

Do not implement square-grid behavior first and treat hex as a cosmetic conversion.

For spatial work, test hex topology explicitly, including:

creature footprints

rotational symmetry

boundaries

range

reach

radial Areas

Lines

Cones

large Tokens

Use the full TokenGridFootprint for every creature-related spatial calculation.

17. Tactical Range Invariant

On gridded Scenes:

Never calculate ordinary creature-to-creature tactical range from Token centers.

Use the minimum tactical field distance between their complete occupied footprints.

For point/Area targeting:

measure from the relevant source footprint border to the target field/vertex.

For creature-originated Lines and Cones:

the first placement anchor is a valid boundary vertex of the actual eligible source Token's footprint.

The configured Action determines range/length.

The active grid topology determines affected fields.

18. Target Refinement Invariant

Keep these separate:

Area geometry
→ physical candidates
→ eligibility
→ target refinement
→ final/per-target resolution

A target may remain physically inside an Area while receiving a per-target override.

Do not mutate the Area footprint for Sculpt-Spell-style exceptions.

19. Inventory Invariant

An InventorySpace is a logical place where Items exist.

Access to it is a separate capability.

Containment is a separate relationship.

Weight propagation is an explicit policy.

Do not infer all four concepts from Actor ownership.

20. Weapon Size Invariant

Weapon size policy should answer questions such as:

effective weapon size

effective wielder size

size compatibility

oversized wielding consequences

applicable base-weapon dice scaling

It should not calculate:

tactical range

reach geometry

Heavy-property behavior unless explicitly composed through another policy

Do not automatically scale a weapon simply because the wielder changes size unless the weapon itself is also resized or a rule explicitly modifies damage.

21. Character Sheet / UI Direction

Do not prioritize final visual polish until domain APIs are stable.

When implementing the finished sheet, use these references conceptually:

Tidy 5e Quadrone — usability, hierarchy, navigation

PF2e official — rules transparency and system integration

official D&D5e — Foundry-native workflows, favorites, grouping

WildPath should add:

Rules Inspector

InventorySpaces

extensible Action Economy

separate BG3-style gameplay HUD

The sheet should answer:

What is true about my character?

The HUD should answer:

What can I do right now?

Do not make UI templates calculate domain rules.

22. Homebrew Direction

The finished Homebrew Builder must compile friendly user choices into the same domain definitions used by first-party content.

Do not create a separate homebrew execution engine.

Common content should be creatable through structured builders for:

Actions

Effects

Modifiers

Triggers

Resources

Areas

inventory grants

weapon properties

Keep advanced internal concepts hidden behind friendly UI wording where practical.

23. Codex Workflow for Every Non-Trivial Task

Before changing code:

read AGENTS.md

read this CODEX.md

read relevant architecture docs

inspect the current implementation

inspect relevant tests

identify the owning domain

identify public contracts the task should reuse

identify explicit scope boundaries

Do not start by inventing a parallel implementation.

24. Implementation Workflow

For a substantial task:

identify the smallest coherent architectural milestone

preserve working abstractions unless change is necessary

implement pure domain behavior first where practical

add/update tests

add application/orchestration integration

add Foundry adapters only at the boundary

run relevant tests

run full tests when practical

run typecheck when available

perform an architecture audit

update architecture docs

Avoid unrelated refactors during feature work.

25. Architecture Audit After Each Major Milestone

Before considering a major task complete, audit for:

domain boundary violations

Foundry APIs leaking into pure domain code

UI calculating game rules

one domain directly mutating another domain's internals

duplicate rule/predicate/expression engines

duplicated spatial mathematics

subsystem-specific special cases that should be generic

god objects/services

unnecessary internal API exposure

missing ports/adapters

circular dependencies

persisted executable JS/functions

direct raw Document mutation

functionality that cannot be unit-tested without Foundry for no good reason

Fix architectural regressions before building large amounts of content on them.

26. Do Not Over-Abstract

Separation of concerns does not mean maximizing the number of classes/interfaces.

Do not create abstractions that only forward arguments.

A good abstraction should make at least one of these clearer:

ownership

invariant

dependency direction

testability

alternate implementation

Foundry isolation

ruleset isolation

serialization

Prefer simple, explicit boundaries over ceremony.

27. Development Strategy

Use this general development sequence unless a task-specific instruction supersedes it.

Stage A — Core Consolidation

unified Predicate

ValueExpression

Modifier

RuleElement

condition/effect migration

persisted ActionDefinition

staged Resolution Pipeline

TypeScript core contracts

Stage B — Architecture Proof Through Representative Content

Use a small difficult test set, not a giant catalog.

Representative mechanics may include:

ordinary melee attack

ranged attack with normal/long range

Reach weapon

oversized monster weapon

auto-hit multi-target effect

Area save/half-damage spell

Sculpt-style per-target override

reaction defense

persistent modifier buff

persistent Area

teleport

Action Surge-like extra capability

conditional extra damage

If one requires engine code, first determine whether it exposes a missing reusable primitive.

Stage C — Foundry Tactical Adapter

Connect pure spatial models to real Foundry V14 Scenes/Tokens.

Hex is first-class.

Stage D — Roll Abstraction

Implement digital/manual providers through one RollRequest → RollResult contract.

Stage E — Reactions / Interruptible Resolution

Implement reaction windows only after the pipeline can pause/resume cleanly.

Stage F — Movement

Implement paths, movement modes, full-footprint movement, costs, voluntary/forced/teleport movement, and semantic movement events.

Stage G — Opportunity Attacks / Persistent Areas / Auras

Compose existing Spatial + Movement + Event + Reaction systems.

Stage H — Character Systems

Implement spellcasting progression, classes, multi-subclasses, transformations, companions, grants, and related progression primarily through existing primitives.

Stage I — Homebrew Builder

Build UI over the same domain schemas used by first-party content.

Stage J — Finished Character Sheet

Build ergonomic, rules-transparent management UI.

Stage K — BG3-Style Gameplay HUD

Build the combat controller over the same Action availability/resolution APIs.

28. Representative Content Before Content Volume

Do not implement dozens of examples of the same mechanic until the generic primitive is proven.

Prefer proving:

one radial Area save
one Cone
one Line
one target-refinement exception
one reaction
one persistent effect
one shared inventory
one transformation

then reuse the architecture.

Content volume comes later.

29. Preserve Provenance and Explainability

WildPath should be able to explain why mechanics resolved the way they did.

Preserve provenance for:

modifiers

target overrides

resource grants

inventory access

weapon-size effects

conditions

RuleElements

roll state

Structured trace data should feed the future Rules Inspector and debugging tools.

Do not reconstruct explanations separately from the actual rules calculation.

30. Multiplayer / Authority Readiness

Do not trust presentation/UI state as authoritative for mechanical commits.

Keep discovery/preview separate from commit.

Prefer transaction-friendly architecture for:

resource spending

Item transfers

effect application/removal

target choices

reactions

shared inventories

Do not require the full socket/authority layer to exist before pure-domain work, but avoid APIs that make authority impossible later.

31. Migrations

Schema changes must be deliberate.

When persisted data changes:

inspect existing data assumptions

define deterministic migration behavior

preserve existing mechanics where practical

version schemas appropriately

add migration tests

Do not silently reinterpret existing content in ways that substantially change it.

32. Git and Repository Safety

Do not perform destructive git actions unless explicitly requested.

Do not:

reset unrelated user work

force-push

rewrite unrelated history

discard changes outside the task

Make the smallest coherent change necessary.

Do not refactor unrelated systems just because they could be cleaner.

33. Definition of a Good WildPath Change

A good change:

has one clear owning domain

uses existing contracts instead of duplicating functionality

keeps Foundry at the infrastructure boundary

keeps UI free of game-rule calculations

is testable in isolation where practical

preserves provenance

returns structured results rather than hidden side effects

supports future multiplayer/rollback needs

does not introduce named-feature special cases unless unavoidable

reduces the amount of new engine code needed for future content

34. Completion Report

After a substantial task, report concisely:

what was implemented

which domains/contracts were changed

architecture decisions made

tests added/updated

test/typecheck results

migrations, if any

remaining limitations

architecture risks discovered

recommended next milestone

Do not claim a feature is Foundry-ready if only its pure-domain implementation exists.

Distinguish clearly between:

domain implemented

adapter implemented

UI implemented

fully integrated

35. Final Governing Principles

For architecture:

Features are composed across domains; they do not erase the boundaries between domains.

For rules:

Prefer declarative reusable primitives over named-feature code.

For spatial combat:

The grid is the geometry.

For creatures:

A creature is represented spatially by its full topology-aware TokenGridFootprint, not a center point.

For resolution:

Calculate, validate, plan, choose, commit, and return structured results.

For Foundry integration:

Foundry V14 is infrastructure behind adapters, not the WildPath domain model.

For development:

Strengthen the reusable core before increasing content volume.