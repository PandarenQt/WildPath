1. Read AGENTS.md and relevant architecture docs.

2. Inspect the current implementation before modifying anything.

3. Preserve existing working abstractions unless the task specifically requires changing them.

4. State which existing systems this feature should reuse.

5. Explicitly list what is NOT part of the task.

6. Implement the smallest complete architectural milestone.

7. Add pure tests first where practical.

8. Add Foundry integration tests/manual verification where required.

9. Run the entire test suite and typecheck.

10. Audit for:
   - duplicate rule engines
   - subsystem-specific predicates
   - arbitrary JS/eval
   - direct document mutation
   - UI-contained game rules
   - duplicated spatial mathematics
   - named-feature special cases

11. Update architecture docs.

12. Finish with:
   - files changed
   - architecture decisions
   - tests added
   - unresolved limitations
   - recommended next milestone

# WildPath — Foundation-First Architecture & Development Strategy

You are working on **WildPath**, a custom Foundry VTT V14 game system inspired by D&D 5e/5.5e but designed around stronger automation, extensibility, abstraction, and tactical-grid rules.

Before modifying anything:

1. Read and obey `AGENTS.md`.
2. Read and obey `CODEX.md`.
3. Read and obey '`ARCHITECTURE.md`.
4. Read the architecture documents relevant to the task.
5. Inspect the current implementation before making architectural changes.
6. Preserve working abstractions unless there is a concrete reason to replace them.

This development phase is primarily about **foundational architecture**, not content quantity.

The priorities are:

- strong separation of concerns
- explicit abstraction layers
- carefully controlled mutability
- immutable/pure domain logic where practical
- composable systems
- declarative rules
- predictable data ownership
- transaction-safe mutation
- reusable configuration and preview systems
- a future HUD that consumes rules rather than implementing them
- minimizing special-case feature code

---

# 1. Core Architectural Principle

WildPath should increasingly become a collection of **independent domains coordinated through explicit contracts**.

Prefer:

```text
Presentation
     ↓
Application / Orchestration
     ↓
Domain
     ↓
Ports
     ↑
Infrastructure / Foundry Adapters