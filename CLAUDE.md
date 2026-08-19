# CLAUDE.md

@AGENTS.md

# Claude Code Instructions

`AGENTS.md` contains the canonical engineering rules for this repository.

Do not duplicate or reinterpret those rules here.

---

## Working Method

Before implementing a non-trivial change:

1. Read the relevant existing implementation.
2. Find its callers and related types.
3. Read its tests.
4. Read relevant architecture documents.
5. Identify the Foundry boundary and domain boundary.
6. Form a concise implementation plan.
7. Implement the smallest coherent solution.
8. Run relevant verification.

Do not begin by generating a replacement implementation before understanding
the existing one.

---

## Foundry API Verification

Foundry APIs are especially prone to version-confusion in generated code.

When using an unfamiliar Foundry API:

- verify that it exists for the project's target Foundry V14 version
- prefer official V14 API documentation
- inspect existing project usage
- inspect Foundry client typings/source available to the project when useful
- use official Foundry systems as implementation references where appropriate

Never combine APIs from different Foundry generations simply because the
result looks plausible.

Do not guess method names, hook names, configuration properties, or document
paths.

If an API cannot be verified, say so rather than fabricating it.

---

## Repository Exploration

Use search aggressively before editing.

For a changed symbol, determine:

- where it is defined
- where it is instantiated
- where it is called
- which tests cover it
- whether it is persisted
- whether it crosses a Foundry/client boundary

Do not assume a file is isolated from the rest of the system.

---

## Large Features

For significant features, implement vertically in small stages.

Example:

1. data/interface definition
2. pure rules behaviour
3. resolution integration
4. Foundry adapter
5. UI integration
6. tests
7. cleanup/documentation

Avoid producing hundreds of lines across many subsystems in one unverified
pass.

Keep the repository runnable between stages where practical.

---

## Debugging

When fixing a bug:

1. reproduce or identify the failing path
2. trace the state backwards to its source
3. identify the actual invariant being violated
4. fix the lowest correct layer
5. add a regression test
6. run related tests
7. check for other callers with the same assumption

Do not patch symptoms in the UI when the bug belongs to the rules engine.

Do not introduce arbitrary delays, retries, or null checks merely to hide race
conditions.

---

## Tests

Treat existing tests as evidence of intended behaviour, not obstacles.

Never:

- delete a legitimate test to make the suite green
- weaken assertions without justification
- replace meaningful assertions with snapshots merely for convenience
- mock the function being tested

Prefer testing pure rules logic without Foundry globals where possible.

At Foundry boundaries, mock or adapt only the minimum necessary behaviour.

---

## Autonomous Work

You may make routine implementation decisions without requesting permission
when they follow established project architecture.

Stop and surface the decision when a change would:

- introduce a new major architectural pattern
- change persistent data format
- require a migration
- add a dependency
- break an existing public interface
- alter core rules semantics
- significantly increase coupling to Foundry internals

When several reasonable implementations exist, prefer the one most consistent
with existing project patterns.

---

## Context Management

Keep the active context focused.

Do not load large unrelated directories merely because they exist.

For large tasks:

- locate relevant files first
- inspect interfaces before implementations
- inspect targeted sections of large files
- revisit source when assumptions become uncertain

After context compaction, re-check important architectural constraints rather
than relying on remembered implementation details.

---

## Implementation Style

Prefer code that another developer can understand without Claude present.

For complex code, be able to explain:

- what invariant it maintains
- why the abstraction exists
- why Foundry-specific handling is necessary
- what alternatives were rejected
- what tests demonstrate correctness

If the implementation cannot be explained clearly, simplify it.

---

## Final Check

Before reporting completion:

- inspect `git diff`
- check for accidental unrelated edits
- run relevant tests
- run type checking where configured
- run linting where configured
- run the build where appropriate
- search for leftover TODO/debug code
- verify new persisted fields have migration/default handling

Report verification accurately.

Never say "all tests pass" unless they were actually executed successfully.