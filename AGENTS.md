# AGENTS.md

# Project: Automated Foundry VTT Game System

This repository implements a highly automated tabletop RPG game system for
Foundry Virtual Tabletop.

The system is inspired by D&D 5e mechanics and must support both the
2014 and 2024 rulesets where applicable, while also supporting project-specific
house rules.

This file is the canonical set of engineering instructions for AI coding agents.

---

# 1. Primary Goals

The system should provide deep automation without making the rules engine
dependent on the UI.

The intended gameplay flow is:

Action
→ target/area selection
→ validation
→ attack roll or saving throw
→ success/failure resolution
→ damage/healing
→ effects/conditions
→ post-resolution hooks

All automated actions should flow through this resolution architecture.

Do not implement special-case shortcuts that bypass the normal resolution
pipeline unless there is a documented architectural reason.

---

# 2. Foundry Version

Target Foundry Virtual Tabletop V14.

The exact compatibility range declared by the project's Foundry manifest is
the source of truth.

When using Foundry APIs:

1. Prefer APIs documented for the project's target V14 version.
2. Never assume an API from V10-V13 still exists.
3. Never invent a Foundry API because it appears plausible.
4. Verify unfamiliar APIs before using them.
5. Prefer public APIs over private/internal APIs.
6. If a private API is genuinely necessary, isolate it behind an adapter and
   document why.

When old project code conflicts with current V14 patterns, do not silently
rewrite it. Determine whether the old behaviour is intentional first.

---

# 3. Sources of Truth

Use sources in this order:

1. Existing project code and tests.
2. Architecture and design documents in this repository.
3. The Foundry VTT V14 API documentation.
4. Official Foundry VTT development documentation and migration guides.
5. Official Foundry-maintained systems such as `foundryvtt/dnd5e` as
   implementation references.
6. Other systems/modules only as secondary examples.

The official D&D5e system may be studied for Foundry implementation patterns,
but it is not automatically a dependency or architectural authority for this
project.

Do not copy behaviour merely because D&D5e implements it that way.

---

# 4. Architecture

Keep these concerns separated:

## Domain / Rules

Pure rules logic.

Examples:

- action economy
- attacks
- saving throws
- damage
- healing
- conditions
- resource consumption
- spellcasting
- character progression
- rule-version differences

Domain code should be testable without a running Foundry canvas whenever
practical.

Do not access `canvas`, DOM elements, sheets, chat UI, or global UI state
directly from domain rules.

## Resolution

Coordinates execution of game mechanics.

Examples:

- ActionResolver
- TargetResolver
- AttackResolver
- SaveResolver
- DamageResolver
- HealingResolver
- EffectResolver
- ResourceResolver
- ReactionResolver
- AreaResolver

Resolvers should operate on explicit context objects rather than hidden
global state.

## Foundry Integration

Responsible for:

- Actors
- Items
- ActiveEffects
- Tokens
- Scenes
- Regions
- Combat
- Hooks
- ChatMessages
- settings
- sockets
- persistence

Keep Foundry-specific behaviour at this boundary when practical.

## UI

Responsible only for interaction and presentation.

Examples:

- character sheets
- HUD
- action selection
- target prompts
- reaction prompts
- combat carousel
- configuration dialogs

UI components may invoke the rules engine.

Rules logic must not depend on UI components.

---

# 5. Foundry Data

Prefer Foundry System Data Models for system-defined Actor and Item data.

Do not mutate Foundry document source data directly.

Use supported Document operations and embedded-document operations for
persistent changes.

Remember that:

- Items can exist as world Items or embedded Actor Items.
- Actors may be normal world Actors or synthetic Token Actors.
- Tokens and Actors are not interchangeable.
- an Actor can have multiple Token representations.
- unlinked Tokens may have independent Actor data.

Never assume that an Actor obtained from a Token is necessarily a world Actor.

Preserve synthetic Actor behaviour when modifying Actor data.

Data migrations must be explicit, deterministic, and backwards-compatible
where practical.

Never silently discard unknown persisted data.

---

# 6. Foundry V14 UI

Prefer V14-native application architecture for new UI.

Use ApplicationV2 / DocumentSheetV2 / HandlebarsApplicationMixin or other
current V14 APIs where appropriate.

Do not introduce legacy Application patterns into new code merely because
older examples use them.

Keep DOM queries local to UI code.

Do not use DOM state as authoritative game state.

---

# 7. Areas, Movement, and Spatial Effects

The system must support:

- instantaneous areas
- persistent areas
- emanations
- auras
- movement-triggered effects
- entering an area
- leaving an area
- starting a turn in an area
- ending a turn in an area

Prefer Foundry V14 Scene/Region/movement facilities where they provide the
required behaviour.

Do not implement a separate geometry engine until the capabilities of Foundry's
native Region and Token movement APIs have been evaluated.

Spatial mechanics must remain separate from the visual representation of an
area.

Deleting or hiding a visual template must not accidentally corrupt unrelated
rules state.

---

# 8. Action Resolution

Actions should execute through a common context.

Conceptually:

ActionDefinition
+ ActionContext
+ Source
+ Targets
+ Area
+ Resources
+ RollMode
+ RuleVersion

→ validation
→ targeting
→ roll requests
→ resolution
→ consequences
→ hooks/events

An individual spell, weapon, feature, or condition should normally configure
the pipeline rather than implement its own independent execution system.

Prefer composition over large type-specific `if/else` chains.

---

# 9. Rolls

The system must support both:

- digital dice
- physical dice

Do not assume every roll is generated by Foundry.

Physical and digital rolls should feed into the same resolution pipeline once
a numeric/result representation exists.

A mechanic must not behave differently merely because the dice were physical.

Dice policy must be configurable according to project settings and GM control.

Do not place rules logic directly inside a dice UI.

---

# 10. Ruleset Compatibility

Support both 2014-style and 2024-style 5e rules where required.

Do not scatter checks such as:

    if (rulesVersion === "2024")

throughout unrelated code.

Prefer:

- strategies
- rule providers
- configuration
- rule elements
- data-driven definitions

Ruleset-specific behaviour should be isolated so another rules implementation
can replace it without rewriting the entire action engine.

Never assume one ruleset is globally active if an Actor, feature, class, or
imported entity may require different behaviour.

---

# 11. Project Rules and Required Flexibility

The architecture must be capable of supporting:

- multiple subclasses for a class
- identification of the level-1/original class
- configurable spellcasting ability from class-provided choices
- full, half, third, and pact-style spellcasting progression
- mutable/configurable damage types
- features which grant additional Actions or Bonus Actions
- spending an Action for a Bonus-Action-type activity where project rules allow
- multiple transformation types
- companions and sidekicks
- Beast Master / Drakewarden-style companions
- CR-based or Warrior-style sidekick progression
- short-rest and long-rest hooks
- initiative hooks
- success and failure hooks
- start-of-turn and end-of-turn hooks
- movement hooks
- entering/leaving area hooks

Do not hardcode assumptions that make these features impossible merely because
standard 5e does not require them.

---

# 12. Event Architecture

Important game events should be observable without tightly coupling systems.

Examples:

- beforeAction
- afterAction
- beforeRoll
- afterRoll
- hit
- miss
- saveSuccess
- saveFailure
- damageApplied
- healingApplied
- effectApplied
- turnStarted
- turnEnded
- restStarted
- restCompleted
- movementStarted
- movementCompleted
- areaEntered
- areaExited

Do not create hooks simply because they might someday be useful.

Add an event when an actual subsystem needs a stable extension point.

Clearly distinguish:

- events that can modify/cancel behaviour
- informational events emitted after resolution

---

# 13. Authority and Multiplayer

Foundry is multiplayer software.

Do not design automation assuming only one connected client.

For persistent changes determine which client is authoritative.

Avoid duplicate execution caused by the same hook firing on multiple clients.

Respect Foundry document ownership and permissions.

GM-only actions must be explicitly identified.

Socket-based behaviour must be deterministic and guard against duplicate
processing.

Never trust UI visibility as a permission mechanism.

---

# 14. TypeScript

Use TypeScript for new system code.

Prefer:

- strict typing
- explicit domain interfaces
- discriminated unions
- readonly data where mutation is unnecessary
- small focused functions
- dependency injection at Foundry boundaries

Avoid:

- `any`
- unsafe type assertions
- giant manager classes
- arbitrary global variables
- deeply nested conditional logic

If Foundry typings force an `any` or assertion, isolate it and explain why.

Do not silence TypeScript errors without understanding the cause.

---

# 15. Error Handling

Fail explicitly when game state is invalid.

Do not silently:

- ignore malformed actions
- discard failed effects
- substitute undefined Actors
- select arbitrary Tokens
- consume resources when resolution failed

User-facing errors should be understandable.

Developer errors should contain enough context to diagnose the problem.

Avoid catch-all exception handlers that hide failures.

---

# 16. Testing

Rules logic should have unit tests.

Important resolution pipelines should have integration tests where practical.

Every bug fix should add a regression test when feasible.

Tests should include:

- success cases
- failure cases
- boundary conditions
- invalid state
- ruleset differences where relevant

Do not weaken or delete a legitimate test simply to make a task pass.

When a test fails:

1. determine why
2. determine whether the implementation or test is wrong
3. fix the correct layer

Do not automatically change test expectations to match new output.

---

# 17. Verification

Before considering implementation complete:

1. inspect the diff
2. run the relevant tests
3. run the project's TypeScript/type-check command if one exists
4. run the project's lint command if one exists
5. run the project's build command if appropriate

Discover commands from `package.json` and repository documentation.

Do not invent commands that are not configured by the project.

If full verification cannot be performed, explicitly state what was not run.

---

# 18. Change Scope

Before editing:

1. inspect the relevant implementation
2. inspect its callers
3. inspect its tests
4. understand the data flow

For multi-file or architectural changes, form a short implementation plan first.

Make the smallest coherent change that solves the problem.

Do not refactor unrelated code while implementing a feature.

Do not rename public APIs casually.

Do not make unrelated formatting changes.

Never revert user changes merely because they are outside the current task.

Never use destructive Git operations such as `git reset --hard` unless the user
explicitly requests them.

---

# 19. Dependencies

Prefer existing project dependencies and Foundry-native capabilities.

Before adding a dependency, determine:

- whether the project already solves the problem
- whether Foundry provides the capability
- whether the dependency is maintained
- whether the added complexity is justified

Do not add a library for trivial functionality.

Never change dependency versions merely to resolve an unrelated task.

---

# 20. Performance

Assume Scenes may contain many Tokens and persistent effects.

Avoid expensive work on every render or canvas frame.

Avoid repeatedly scanning every Actor, Item, Token, or Region when an indexed or
event-driven solution is possible.

Cache derived data only when invalidation rules are clear.

Correctness is more important than premature optimization.

---

# 21. Documentation

Document:

- architectural decisions
- non-obvious Foundry workarounds
- public extension points
- persistent data formats
- migration requirements

Comments should primarily explain WHY something exists.

Do not write comments that merely translate the code into English.

If implementation changes an architectural contract, update the corresponding
documentation.

---

# 22. AI / Foundry Package Policy

AI-generated software code is permitted by Foundry's package policy, but code
intended for submission must remain understandable and maintainable by the
human author.

Prefer clear, explainable implementations over clever implementations.

If this project is intended for publication through Foundry's package ecosystem,
do not generate prepared user-facing:

- lore
- rules prose
- item descriptions
- journal content
- UI copy
- artwork
- audio

where doing so would conflict with the current Foundry AI Content Policy.

Software code, tests, debugging assistance, refactoring, and technical package
documentation are permitted categories.

---

# 23. Completion Report

After making a significant change, report:

- what changed
- important design decisions
- files changed
- tests/checks run
- anything that remains unresolved

Do not claim a test, build, or manual Foundry verification passed unless it was
actually performed.

---

# 24. Core Principle

Prefer:

correct
→ explicit
→ testable
→ composable
→ maintainable
→ automated

over:

clever
→ implicit
→ tightly coupled
→ special-cased

When uncertain, preserve architectural flexibility and ask the codebase for
evidence before making assumptions.