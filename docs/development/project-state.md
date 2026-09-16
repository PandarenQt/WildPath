# WildPath — Current Project State

Last verified: 2026-09-16.

- Branch: `milestone/action-runtime-live-proof`.
- Starting HEAD for Quench Q1: `85344524f75e2620c3bc1990e5c75cca7c463602`.
- Quench Q1 implementation commit: `75ef1fb738433367b549a2171d6665be894a24c4`.
- Starting HEAD for the custom-pool persistence repair: `5e8ec1453be842c00b39fb04a1099cdb38f0cb98`.
- Starting HEAD for Quench Q2: `5e8ec1453be842c00b39fb04a1099cdb38f0cb98` (Q1 repair and live-status documentation already uncommitted).
- Staged-movement QA commit: `7c12977`.
- Movement implementation commit: `87ed1fae93271b81b14432bb4312be9cd53285c5`.
- Original milestone starting HEAD: `ea484fd8b503697ddf1c2b7b0f6984ea594378e2`.
- Local main HEAD: `61d6268b838e286728c829924506c6c931174621`.
- Portable full suite (`FOUNDRY_V14_APP_PATH` unset): **811 tests, 809 passed, 0 failed, 2 intentionally skipped**.
- Combat-slice delta from 808/806/0/2: **3 new portable tests** (Scene/Token/Combat fixture ownership, cleanup ordering across collections, read-only orphan listing); batch inventory check extended to seven batches.
- Q2 delta from 807/805/0/2: **1 new portable test** for scoped ActiveEffect fixtures; registration and GM-guard checks extended.
- Repair delta from 797/795/0/2: **10 new tests** (9 Actor resource persistence cases and 1 assertion-failure cleanup case); existing turn-recovery coverage strengthened.
- Prior installed-source check: `foundry-nested-reaction-commit.test.mjs` **11 passed, 0 failed, 0 skipped**, including both optional tests against V14.367; not rerun for Q1.
- Typecheck, changed-module syntax checks, and diff whitespace checks passed. No generated runtime sources changed; the prior implementation build remains the last build verification.

These figures cover the Combat-slice worktree on top of the committed Q2 implementation and the
live-confirmed Q1 custom-pool repair. Q2 and the repair were committed together as `0586485`; the
local scratch file `docs/development/nextPromptForCodex.md` was untracked and ignored in `33bb766`;
the Combat slice was implemented after `04ae4d1`. Verify actual HEAD, branch, worktree, and
subsequent changes before relying on them.

## Product and invariants

Build a composable automated Foundry V14 rules platform. Preserve plain ResolutionState,
existing staged Action/Reaction orchestration, full square/hex TacticalGrid footprints, generic
resource payment, exact synthetic Actor identity, and authoritative transaction-backed persistence.
Callbacks and Foundry Documents remain outside serialized rules state. Code defaults must not
turn configured reaction content into a second combat engine.

## Current milestone

**The Quench Combat slice is live-confirmed.** `wildpath.combat` — **WILDPATH: Real
Foundry Combat** — adds **6 cases** in `module/tests/quench/combat.mjs` proving, in real Foundry, the
chain real Scene → unlinked Token → synthetic Actor/ActorDelta → real Combat → Combatant →
`Combat#nextTurn` → `WildPathCombat#_onStartTurn` → `actor.startTurn()` → resource persistence →
turn-start Bleeding Trigger dispatch, plus the existing recovery-guard rejections. Fixtures now own
and clean Scenes, Tokens, Combats, and Combatants (Combats → Scenes → Actors), and expose a read-only
orphan listing. **Production semantics changed for the Combat slice: NO.** The maintainer ran the
batch on V14.367 and reported all six passing (Quench UI green, six PASS lines; maintainer-reported,
no exported report). Standing: **40 cases live-confirmed** (Q1 17, Q2 17, Combat 6). The run exposed
a core `CombatTracker._onRender` TypeError whenever a non-viewed Combat updates; it has no WildPath
frames, does not affect document state, and is recorded as a core defect, not a WildPath failure.
Exact case names, the completion-signal design, run instructions, and console interpretation are in
the [testing strategy](foundry-testing-strategy.md).

**Quench Q2 is live-confirmed.** Three batches in `module/tests/quench/` cover
`wildpath.effects` (4), `wildpath.conditions` (5), and `wildpath.rule-elements` (8): **17 Q2 cases**.
The optional `quenchReady` entry now registers seven batches (40 total cases), without changing
Q1's 17 or Q2's 17 cases. The maintainer ran the expanded suite against Foundry V14.367 and reported the 17 new
cases passing **17/17**; combined with Q1, **all 34 WildPath Quench cases are live-confirmed**. This is
maintainer-reported evidence without an exported Quench report, the same evidentiary standing as Q1.

Q2 covers real ActiveEffect lifecycle/disabled state/native expiration suppression, condition
apply/remove and status conversion, Exhaustion stacking, Prone idempotence, Item/ActiveEffect
Modifier RuleElements, clean source integrity, exact/wildcard domains, level predicates, priority,
definition flags, and repeated preparation/deletion. Bleeding's configured Trigger is verified
through status conversion, persisted payload, and registry collection/removal; Combat turn dispatch
is outside this milestone. The condition-removal modifier is authored on the disposable Prone
effect without changing the built-in condition definition.

Fixture additions are limited to `createEmbeddedQuenchEffect` / `fixtures.createEffect`, requiring
GM, ready state, a marked parent, and a valid run ID. Existing Actor teardown owns all embedded Item
and ActiveEffect cleanup, including condition effects created directly through production APIs.
**Production semantics changed for Q2: NO.** The preceding Q1 runtime repair is preserved. Exact
case names, boundaries, and live-run instructions are in the [testing strategy](foundry-testing-strategy.md).

### Q1 live evidence and preceding repair

Quench Phase Q1 implements an optional real-Foundry integration layer in `module/tests/quench/`:
one `quenchReady` registration entry, shared marked fixtures with per-test cleanup, and three batches:
`wildpath.runtime-smoke` (3 cases), `wildpath.documents` (6), and `wildpath.resources` (8).
The maintainer live-ran Q1 in Foundry V14.367 with Quench v0.10.0: smoke **3/3**, Documents **6/6**,
resources **7/8**; **16/17 initially passed**. The only failing case was the nonzero-index custom-pool
spend. The other sixteen cases, including Item-backed maxima across repeated preparation and Item
deletion, remain valid live evidence. On 2026-09-16 the maintainer confirmed all tests pass after the
repair: resources **8/8**, Q1 **17/17 PASS**. **Fix implemented and live-confirmed.** This records the
maintainer's rerun confirmation; no exported post-fix Quench report was supplied in this conversation.

Coverage includes actual Actor and Item models/lifecycles, source snapshots, built-in spending and
restore clamping, unaffordable and multi-resource spending, custom-pool persistence,
and Item-backed resource maxima across repeated Foundry preparation. Eight portable infrastructure tests now guard
optional registration, GM-only mutation, fixture marking/scoping, and cleanup on failure. They do
not emulate a pass of the real-Foundry cases.

Installed V14.367 source confirms ArrayFields are fully replaced: `system.pools.1.value` is not a
safe partial pool patch. The repair changes `spendResource`, `spendResources`, `startTurn`, and
`rest` to replace clean `toObject(true).system.pools` source arrays, changing only intended values.
Prepared modifiers/maxima remain transient; affordability, clamping, recovery, lifecycle behavior,
and built-in paths are unchanged. Mixed built-in/custom costs still use one Actor update. Production
impact is limited to this persistence correction. Nine new portable cases and strengthened turn
coverage reject the indexed update shape that permissive Node setters previously accepted.

Quench's V14 deprecated-global warnings, auto-run/UI ordering issue, and example-suite failures are
external tool debt; example results are excluded from WildPath's Q1 totals. Use `quench.exampleTests = false`,
`quench.autoRun = false`, `quench.autoShowQuenchWindow = true`; reload after changing example tests.
The existing scoped `afterEach` cleanup is unchanged and now explicitly tested after assertion
failure. Manually verify `game.actors.filter(a => a.getFlag("wildpath", "quenchFixture") === true)`
returns `[]`; the live world's leftovers were not inspected here. No vendor files, dependency
manifests, or client settings were changed. The only startup integration remains the single optional
test registration import. See the
[testing strategy and exact live run procedure](foundry-testing-strategy.md).

Deferred Quench phases: the Rolls portion of Q3 (its synthetic-Actor/Combat portion is live-confirmed
as `wildpath.combat`); Q4 persistence rollback/Action entry; future migrations.

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

No new staged-movement live evidence was produced. The staged intent's **before-transition** timing and final
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

Q1, Q2, and the Combat slice are live-confirmed: **40 Quench cases**. No further Quench slice has been
chosen or started; Rolls and Q4 remain deferred. Two facts carry forward: `rest()` is now the one
repaired whole-array pool write still proven only in Node, and core 14.367 throws in
`CombatTracker._onRender` for updates to a non-viewed Combat (a core defect the Combat batch reliably
reproduces; not a WildPath failure). Whether the fixture orphan check returned empty arrays for
Combats, Scenes, and Actors after the live run was not reported; confirm it before the next run.

Separately deferred: all six cases in [staged-movement-qa.md](staged-movement-qa.md): square ordinary, decline, miss,
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
