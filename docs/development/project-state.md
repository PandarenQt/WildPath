# WildPath — Current Project State

Last verified: 2026-09-16.

- Branch: `milestone/action-runtime-live-proof`.
- Starting HEAD for Quench Q1: `85344524f75e2620c3bc1990e5c75cca7c463602`.
- Quench Q1 implementation commit: `75ef1fb738433367b549a2171d6665be894a24c4`.
- Staged-movement QA commit: `7c12977`.
- Movement implementation commit: `87ed1fae93271b81b14432bb4312be9cd53285c5`.
- Original milestone starting HEAD: `ea484fd8b503697ddf1c2b7b0f6984ea594378e2`.
- Local main HEAD: `61d6268b838e286728c829924506c6c931174621`.
- Portable full suite (`FOUNDRY_V14_APP_PATH` unset): **797 tests, 795 passed, 0 failed, 2 intentionally skipped**.
- Prior installed-source check: `foundry-nested-reaction-commit.test.mjs` **11 passed, 0 failed, 0 skipped**, including both optional tests against V14.367; not rerun for Q1.
- Typecheck, changed-module syntax checks, and diff whitespace checks passed. No generated runtime sources changed; the prior implementation build remains the last build verification.

These figures cover the Quench Q1 implementation commit above. Verify actual HEAD, branch, worktree, and subsequent
changes before relying on them. Starting HEAD includes the original Quench smoke module and atlas
updates; the unfinished registration/fixture drafts present at preflight were migrated into Q1.

## Product and invariants

Build a composable automated Foundry V14 rules platform. Preserve plain ResolutionState,
existing staged Action/Reaction orchestration, full square/hex TacticalGrid footprints, generic
resource payment, exact synthetic Actor identity, and authoritative transaction-backed persistence.
Callbacks and Foundry Documents remain outside serialized rules state. Code defaults must not
turn configured reaction content into a second combat engine.

## Current milestone

Quench Phase Q1 implements an optional real-Foundry integration layer in `module/tests/quench/`:
one `quenchReady` registration entry, shared marked fixtures with per-test cleanup, and three batches:
`wildpath.runtime-smoke` (3 cases), `wildpath.documents` (6), and `wildpath.resources` (8).
The prior smoke batch was live-proven by the maintainer in Foundry V14.367 with Quench v0.10.0.
**The 17 refactored/expanded Q1 cases are implemented but have not yet been live-run.**

Coverage includes actual Actor and Item models/lifecycles, source snapshots, built-in spending and
restore clamping, unaffordable and multi-resource spending, array-index custom-pool persistence,
and Item-backed resource maxima across repeated Foundry preparation. Six new portable tests guard
optional registration, GM-only mutation, fixture marking/scoping, and cleanup on failure. They do
not emulate a pass of the real-Foundry cases.

Quench's V14 deprecated-global warnings and its auto-run/UI ordering issue are external tool debt.
No vendor files, dependency manifests, client settings, or production semantics were changed.
The only startup integration is the single optional test registration import. See the
[testing strategy and exact live run procedure](foundry-testing-strategy.md).

Deferred Quench phases: Q2 effects/conditions/RuleElements; Q3 synthetic Actors/Combat/Rolls;
Q4 persistence rollback/Action entry; future migrations.

## Staged movement status

Interruptible movement and reaction composition is implemented and automated-tested. The explicit
`game.wildpath.executeMovementIntent` entry point proposes each tactical transition, opens normal
reaction windows, runs accepted attacks as normal nested Actions at the last logical footprint,
revalidates the remaining route, and commits completed-prefix payment plus final Token position.

The movement implementation added 30 cases covering square/hex/Large traversal, entering/leaving reach,
decline, hit/miss, effect-driven stopping, multiple reactors, controller routing, replay/stale
responses, custom resources, synthetic identity, commit authority, and failure/rollback behavior.

The QA follow-up adds four coordinator-backed regression cases to that file (34 total): accepted
miss/hit/stop child footprint assertions and a Large hex decline variant. Live proof now requires
an explicit pending-choice snapshot, validates pre-transition discovery and `leavesReach`, and
compares child `targetFootprints` to the last-completed full logical footprint while the rendered
Token remains at origin. Missing or incorrect evidence fails. The hex variant checks three-field
footprints throughout, recorded decline without a child, resume, movement payment, and final
persisted position/footprint. Movement architecture and runtime semantics are unchanged.

The two portable-suite skips are installation-dependent nested condition-commit checks, not staged
movement gaps. Their exact names, covered behavior, Node VM limitations, and enablement command
are recorded in the [optional-test audit](nested-reaction-child-commit.md#optional-test-audit-2026-09-16).

Important boundaries and file map:

- `module/resolvers/movement-pipeline-resolver.mts`: movement host and lifecycle.
- `module/helpers/movement-transition.mts`: observer-relative tactical facts.
- `module/resolvers/document-update-transaction.mts`: generic position transaction operation.
- `module/adapters/foundry-v14-staged-movement-adapter.mts`: authoritative route, rules, child Action inputs.
- `module/adapters/foundry-v14-staged-movement-commit.mts`: scoped V14 position persistence.
- Existing coordinator/runtime/token hooks and result transport provide the integration.
- [Architecture contract](../architecture/staged-movement.md) and [live QA](staged-movement-qa.md).

Generated `.mjs` runtime counterparts are committed alongside new `.mts` code.

## Prior foundations and evidence

The existing native checkpoint movement / generic reaction composition is documented as
live-verified on V14.367, including a Large hex Token and synthetic Actor resource/effect commits.
The ordinary Action runtime evidence is tracked in `evidence/gm-hit.json`, `gm-miss.json`,
`player-hit.json`, and `player-miss.json`. These artifacts and prior live claims were not replaced
or rerun during this milestone.

No new live evidence was produced. The staged intent's **before-transition** timing and final
position persistence still require the new GM/player gate. Native dragging continues to use its
existing **completed-event** workflow.

## Prerequisite repairs included

- Trusted intent resolution may provide a hosted state and commit implementation to the existing coordinator.
- Resolution IDs are reserved before asynchronous intent resolution, preventing replacement by another intent.
- Generic transaction preparation and result summaries retain Document references for position writes.
- Actor and Token UUID aliases retain distinct synthetic Actors that share base Actor IDs.
- A partial Foundry position update is restored before reporting failure; changed movement payment
  during the position write triggers existing transaction rollback.

## Deferred work and immediate next step

Run the three Quench Q1 batches as GM in the disposable V14.367 world, retain the report, and rerun
to verify cleanup. Expected live gate: 17 passing cases, with vendor warnings assessed separately.

Run all six cases in [staged-movement-qa.md](staged-movement-qa.md): square ordinary, decline, miss,
hit/continue, effect/stop, and Large hex decline. Export the pending-choice proof plus paired GM/player
evidence before advancing to native UI integration. These strengthened live cases have not been run.

Current limits are explicit: active GM and voluntary translation at the Foundry entry point;
no intermediate Token persistence/rendering; no durable host reconstruction after reload/handoff;
footprint/source changes invalidate rather than replace a route. Independent child commits are
not rolled back with a later parent failure. Transactions compensate completed operations and do
not provide database atomicity against arbitrary concurrent writes from other systems.

After live proof, connect native route submission to the proposed-transition host while preserving
checkpoint accounting. Later work can add Region/Area consumers, route replacement for changed
footprints, and representative reaction content through the established provider seams.
