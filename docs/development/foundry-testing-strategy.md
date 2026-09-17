# Foundry integration testing: Quench and staged movement

## Evidence and testing ladder

| Level | What it proves |
| --- | --- |
| 1. Pure Node | Rules, resolvers, contracts, serialization, transactions |
| 2. Deterministic adapter/contract | Production-shaped interfaces and fakes |
| 3. Quench in Foundry | Real Documents, TypeDataModels, embedded collections, preparation, and document persistence |
| 4. Live single-client QA | Actual user interaction, presentation, and persistence workflows |
| 5. Live multiplayer QA | GM/player sockets, remote prompts, authority, timing, and visual movement |

A lower-layer pass does not prove a higher layer. A higher-layer pass does not replace deterministic
coverage. The six-case staged movement **semantic regression gate is now Quench-driven**, using the
same assertions as the [staged movement live QA](staged-movement-qa.md). The maintainer ran the
batch in **Foundry V14.367**: the first run passed five cases and failed `Large-hex reaction decline`
at `movement.commit` with `COMMIT_FAILED — Foundry did not persist the planned movement position`,
because the staged-movement commit adapter compared the hex-derived planned `y = 260.00000000000006`
against Foundry's integer-cleaned persisted `260` with strict equality. After the production repair
in `e30d752` (positional comparison tolerating only IEEE-754 noise; see the architecture contract),
the maintainer reported **6/6 PASS**. The live-confirmed Quench total is therefore **46**
(Q1 17, Q2 17, Combat 6, staged movement 6). As with every batch this is maintainer-reported
evidence without an exported Quench report. Node results alone never established this Level-3 evidence.

Level-5 multiplayer QA becomes a thin sentinel. Rerun it when multiplayer, socket, authority, or
prompt transport behavior changes, rather than for every purely mechanical movement change.
Quench does **not** prove real GM/player browser socket delivery, active-GM failover, network timing,
remote prompt UX, or visual animation timing. Those still require real browser evidence; no new
Level-5 pass is claimed by this batch or its portable tests. The paired-client procedure remains
available in `staged-movement-qa.md` for that sentinel.

The maintainer live-ran the expanded Q1 batches with Quench **v0.10.0** in **Foundry V14.367**:

| Batch | Initial live result | After repair |
| --- | --- | --- |
| `wildpath.runtime-smoke` | 3/3 PASS | 3/3 PASS |
| `wildpath.documents` | 6/6 PASS | 6/6 PASS |
| `wildpath.resources` | 7/8 PASS | 8/8 PASS |
| Q1 total | **16/17 PASS** | **17/17 PASS** |

The only failure was `persists a custom pool spend at a nonzero array index without changing its
neighbor`. All other cases, including Item maximum modifiers across repeated preparation and Item
deletion, remain proven live evidence. **Fix implemented and live-confirmed:** on 2026-09-16 the
maintainer reported all tests pass after the repair. This is maintainer-reported live evidence;
no exported post-fix Quench report was supplied in this conversation. Quench's built-in example
suites also ran during the initial run; their failures are excluded from WildPath's totals.

**Q2 is live-confirmed.** Its 17 additional cases cover ActiveEffects (4), conditions (5), and
RuleElements (8). The maintainer subsequently ran the expanded suite against Foundry V14.367 and
reported the 17 new cases passing **17/17**. As with Q1, this is maintainer-reported live evidence;
no exported Quench report was supplied. At that point, all six batches together contained 34 cases,
and all **34 were live-confirmed**. The maintainer's Q2 summary described the expansion as eight
batches; the Q2 repository registered exactly three new batch keys, so only the three verified
batches and the 17-case total are recorded as Q2 evidence.

**The Combat slice is live-confirmed.** `wildpath.combat` adds 6 cases proving managed Combat
turn-start recovery and turn-start condition dispatch on an unlinked Token's synthetic Actor. The
maintainer ran it on Foundry V14.367 with Quench v0.10.0 and reported all six passing (Quench UI
green; six `(PASS) Test Complete` lines in the console log). As with Q1/Q2 this is maintainer-reported
evidence without an exported report. Current standing: **40 live-confirmed** (Q1 17 + Q2 17 + Combat 6).
The run also surfaced a core `CombatTracker` rendering error that is not a WildPath failure; see the
Combat run section.

Quench v0.10.0 is not V14-clean: its deprecated `Game`, `SearchFilter`, and `FilePicker` references
emit vendor compatibility warnings. It also has a reported auto-run/UI ordering problem if execution
starts before its Application is rendered. Keep those warnings separate from WildPath assertion
failures. WildPath neither patches Quench nor suppresses compatibility warnings.

## Registration and fixtures

`wildpath.mjs` imports only `module/tests/quench/index.mjs` for this layer. That file owns the single
`quenchReady` subscription and registers exactly eight batches (46 cases, all live-confirmed). Batch
modules do not add registration hooks.
No Quench globals, dependency, client setting writes, fixture creation, or test
execution are required at normal startup. If Quench is absent, its hook simply never fires.
The old smoke file and unfinished top-level test index/fixtures have been migrated into this directory.
Registration follows [Quench's batch/context API](https://github.com/Ethaks/FVTT-Quench#register-a-test-batch).

Each mutation test gets a fresh `foundry.utils.randomID()` run ID in `beforeEach`. Created Actors,
Scenes, Tokens, Combats, Combatants, and embedded Items/helper-created ActiveEffects carry
`flags.wildpath.quenchFixture: true` and `flags.wildpath.quenchRunId`. Condition tests call the production Actor APIs directly on marked
fixture Actors; their generated children are owned by that marked parent without an extra flag
update that could hide a creation/preparation failure.
`afterEach` uses the real `deleteDocuments` of each owned collection for documents with **both** that
exact marker and run ID, in the order Combats → Scenes → Actors, because Combats reference Scene
Tokens and Scenes own Tokens plus their ActorDeltas. Embedded Items, ActiveEffects, Tokens, and
Combatants are removed with their fixture parent. A test that explicitly deletes its fixture is
safe to clean again. Cleanup does not depend on creation returning successfully: marked Documents
are found even if a later creation callback throws. Rejected cleanup is reported as a failure with
the run ID, rather than hidden.

Helpers in `module/tests/quench/fixtures.mjs`:

- `createQuenchActor({runId, name, type, system})`
- `createEmbeddedQuenchItem(actor, {name, type, system})`, requiring a marked parent
- `createEmbeddedQuenchEffect(actor, {name, type, system, disabled, duration, start})`, requiring a marked parent and run ID
- `createQuenchScene({runId, name, grid})`, a disposable 1000×1000 Scene, never active or in navigation; omitted grid fields keep the original 100-pixel, 5-ft square defaults, and supplied native grid fields pass through
- `createUnlinkedQuenchToken(scene, actor, {name, x, y, width, height, shape, elevation, level})`, requiring a marked Scene and marked base Actor; fails if no synthetic Actor results. Defaults remain x/y 100, width/height 1; omitted shape/elevation/level retain Foundry defaults
- `createQuenchCombat(scene, tokens)`, requiring a marked Scene; creates one marked Combatant per Token
- `findQuenchFixtures({runId?})`, a read-only listing of marked Combats/Scenes/Actors for orphan diagnostics
- `cleanupQuenchFixtures({runId})`, requiring a nonempty run ID; returns the deleted ids per collection
- `useQuenchFixtures(context)`, installing GM/ready guards and per-test cleanup

Q1/Q2 mutation suites use 30-second timeouts and the Combat/staged-movement suites 60 seconds; all skip cleanly for non-GMs, including teardown. Their helper
APIs independently reject non-GM calls. The two read-only smoke cases may run as a player. Names
are diagnostic only; a matching name never authorizes deletion. Run one QA client at a time and do
not edit fixtures while tests are executing. A browser reload or an outstanding operation after a
timeout can outlive teardown; inspect marked leftovers before rerunning.

## Q1 batches and exact cases (17/17 live-confirmed)

`wildpath.runtime-smoke` — **WILDPATH: Foundry V14 Runtime Smoke** (3):

1. `runs inside Foundry V14 with WildPath active`
2. `registers the real WildPath Document classes and Actor/Item DataModels`
3. `creates, updates, prepares, and deletes a WildPath Actor`

Registration checks compare actual imported classes, including character/NPC and feature/action/gear
models. The persistence case retains the original health/movement defaults, updates health to 7,
checks source and prepared state after collection lookup, then verifies deletion.

`wildpath.documents` — **WILDPATH: Real Foundry Documents** (6):

1. `persists a character Actor with its real DataModel and schema defaults`
2. `persists a npc Actor with its real DataModel and schema defaults`
3. `creates, updates, and deletes an embedded feature Item`
4. `creates, updates, and deletes an embedded action Item`
5. `creates, updates, and deletes an embedded gear Item`
6. `exports detached plain Actor and embedded Item source data`

Actor cases check the actual TypeDataModel, default health/reaction and level/threat, then persist
type-specific detail updates. Item cases check the real parent, collection, model, persisted update,
and deletion. The source case checks ordinary objects, JSON serialization, and detached copies.
These are Document lifecycles; they do not execute Actions.

`wildpath.resources` — **WILDPATH: Real Foundry Resources** (8):

1. `looks up built-in resources and checks affordability without mutation`
2. `persists movement spending from 30 to 25`
3. `rejects an insufficient reaction spend without changing source or prepared value`
4. `restores health with a negative spend and clamps to its prepared maximum`
5. `persists an affordable action and bonus spend together`
6. `rejects an unaffordable multi-resource request without partial spending`
7. `persists a custom pool spend at a nonzero array index without changing its neighbor`
8. `applies an Item maximum modifier once across repeated preparation and removes it on deletion`

The custom-pool case persists two valid schema entries and spends the second from 6 to 4, checking
that the first is untouched. The modifier case uses the existing Item `modifiers` schema with
`domains: ["resources.health.max"]`: base 10 + manual bonus 2 gives 12; the Item adds 4, producing
16; two harmless persisted Actor updates and repeated public `prepareData()` calls must retain 16;
deleting the Item must restore 12. Calling preparation directly is confined to a disposable world
Actor without Tokens or ActiveEffects. Current health and manual bonus must not inflate, and
derived modifier contributions must not leak into source data.

Persisted source and prepared state are deliberately checked separately. `max` is derived from
base, manual bonus, and Item modifiers; `toObject(true).system.resources.*.max` is not assumed to
equal the effective maximum. This is the existing DataModel contract.
An awaited Document update plus collection/source inspection exercises Foundry's update workflow;
it does not claim a server restart/database-reload proof.

## Q2 batches and exact cases (17/17 live-confirmed)

New files: `module/tests/quench/effects.mjs`, `conditions.mjs`, and `rule-elements.mjs`. They export
registration functions consumed by the existing optional `index.mjs`. The only fixture extension is
`createEmbeddedQuenchEffect`, also exposed as `fixtures.createEffect`; parent deletion already owns
embedded cleanup. Q1 cases and the existing teardown strategy are retained.

`wildpath.effects` — **WILDPATH: Real Foundry ActiveEffects** (4):

| Exact test name | Integration boundary |
| --- | --- |
| `creates, updates, and deletes a generic WildPath ActiveEffect` | Real `effect` subtype, WildPath document class and TypeDataModel, Actor parent/collection/source, persisted updates and deletion. |
| `disabling and re-enabling an ActiveEffect removes and restores its modifier` | Real `disabled` updates remove/restore an authored modifier in both `getStatistic()` and prepared health maximum. |
| `an expired ActiveEffect is suppressed without contributing to Actor preparation` | Native persisted expiration suppresses an enabled effect; clearing expiration restores its contribution. |
| `deleting a modifier ActiveEffect restores the prepared resource baseline` | Effect deletion clears its contribution and embedded source without polluting persisted Actor resource data. |

Suppression uses the installed V14.367 contract: `common/documents/active-effect.mjs` defines
`duration.expired`, and `client/documents/active-effect.mjs` exposes it through `isSuppressed` when
the system supplies no override. Duration preparation clears expiry for indefinite/future effects,
so the fixture uses an explicitly expired one-second duration starting 60 seconds in the past.
The test never advances world time or calls Combat; expiration scheduling is not under test.

`wildpath.conditions` — **WILDPATH: Real Foundry Conditions** (5):

| Exact test name | Integration boundary |
| --- | --- |
| `applies and removes prone through the production Actor condition API` | `toggleCondition` persists a real condition model/status; negative levels remove its effect and prepared Actor status. |
| `status conversion persists Bleeding RuleElements and their registry contribution` | `toggleStatusEffect` → WildPath `_fromStatusEffect` → serialized definition → real persisted effect → registry trigger; removal clears the contribution. |
| `exhaustion stacks, clamps, decreases, and removes persisted levels` | Existing stacking API persists levels 1 → 3 → 6 → 5 → removed, maintaining one effect and the localized level name. |
| `reapplying non-stacking prone neither duplicates nor assigns a level` | Repeated positive deltas are idempotent; level stays null and repeated removal remains a no-op. |
| `condition removal clears authored modifiers and stale prepared resources` | A modifier authored on a real Prone effect contributes before removal; removal restores resource/statistic baseline and leaves no orphan. |

No condition IDs or configured mechanics are invented. Prone has no built-in numeric modifier;
the removal test authors one through its existing inherited modifier schema without modifying
`CONFIG.WILDPATH.CONDITIONS`. Bleeding is the only current condition definition with RuleElements,
and its rule is a `turn.started` Trigger, not a passive Modifier. Q2 verifies the exact serialized
definition, registered trigger identity/event/mechanical payload, unchanged health during preparation,
and contribution removal. Dispatching periodic damage through Combat turn callbacks remains outside
Q2; no claim is made about that deferred event execution from this batch.

`wildpath.rule-elements` — **WILDPATH: Real Foundry RuleElements** (8):

| Exact test name | Integration boundary |
| --- | --- |
| `Item Modifier RuleElements prepare once and follow activation and deletion` | Persisted Item definition/provenance, real preparation, `system.active` false/true, deletion and restored baseline. |
| `ActiveEffect Modifier RuleElements follow disable, re-enable, and deletion` | Same calculation engine through an ActiveEffect source, real disabled-state writes and deletion. |
| `repeated preparation preserves Item and ActiveEffect RuleElement source without accumulation` | Two distinct sources remain exactly +5 across repeated persisted Actor updates and public preparation; definitions/resources retain clean source. |
| `exact RuleElement domains contribute only to the matching Actor statistic` | Item and effect health rules combine to +5 while the unrelated resource domain stays unchanged. |
| `the all wildcard RuleElement contributes to each requested resource domain` | Existing `all` semantics reach health and movement maxima; deletion restores both. No movement execution is invoked. |
| `a persisted RuleElement predicate follows real Actor level updates` | Existing `equals` predicate uses `actorSystem.details.level`; real updates flip false → true → false. |
| `persisted RuleElement priority selects the winner of equal typed bonuses` | Persisted priorities break an equal `status` bonus tie by lower numeric priority; a real whole-array update changes the applied source. |
| `persisted RuleElement enabled and suppressed flags control contribution` | Definition-level flags persist and gate the contribution while its owning ActiveEffect remains enabled. |

Source assertions compare complete small RuleElement definitions: schemaVersion, id/type/key/label,
payload, predicate, priority, source, metadata, enabled/suppressed flags. JSON round-trip and nested
source-copy mutation checks protect detached data. Runtime provenance is observed through the
statistic while persisted `source: null` stays unchanged. Preparation never writes derived maxima,
modifierBonus, or generated contribution objects into persisted Actor or RuleElement data.

Q2 changes no production semantics. Predicate, wildcard, suppression, and priority are exercised
using existing APIs; no new rules are introduced. The earlier Q1 custom-pool runtime repair remains
in the worktree unchanged. Q3/Q4 systems, migrations, and Quench vendor code are untouched.

## Combat slice: batch and exact cases (6/6 live-confirmed)

New file: `module/tests/quench/combat.mjs`, registered through the existing optional `index.mjs` as the
seventh batch. It proves the managed turn-start chain in real Foundry on an **unlinked Token**:

```text
real Scene -> unlinked Token -> synthetic Actor / ActorDelta -> real Combat -> Combatant
-> Combat#startCombat / Combat#nextTurn -> WildPathCombat#_onStartTurn -> actor.startTurn()
-> resource persistence -> turn-start condition Trigger dispatch
```

Fixture chain per case: a marked base Actor, a marked disposable Scene (never activated, not in
navigation, no background so core skips thumbnails), one unlinked Token on it, and a marked Combat
bound to that Scene with one Combatant. Each case first calls `startCombat()` — itself a real
transition into round 1, turn 0 that already invokes `_onStartTurn` once — then sets its degraded
pre-state on the synthetic Actor, then calls `nextTurn()`. With one Combatant, `nextTurn()` wraps to
round 2, turn 0 and drives exactly one `_onStartTurn` for the fixture Combatant, so the asserted
recovery is the `nextTurn`-driven one. `actor.startTurn()` is called directly only in the guard case.

Completion is awaited deterministically, not polled: on the active GM, installed
`Combat#_manageTurnEvents` awaits the whole turn-event workflow — including
`WildPathCombat#_onStartTurn` and everything it awaits — before calling `combatTurnChange`. The test
registers that hook before advancing and treats it as the transition's completion signal.

`wildpath.combat` — **WILDPATH: Real Foundry Combat** (6):

| Exact test name | Integration boundary |
| --- | --- |
| `builds an unlinked Token whose synthetic Actor persists through ActorDelta independently of its base Actor` | Fixture verification: `actorLink === false`, `isToken`, distinct instance and UUID from the base Actor, shared id, `Combatant#actor` is the synthetic Actor; a synthetic update lands in `token.delta` source and not in the base Actor. |
| `Combat#nextTurn restores built-in turn resources on the synthetic Actor through WildPathCombat#_onStartTurn` | action/bonus/reaction/movement from 0/0/0/5 to 1/1/1/30 in synthetic source, prepared state, and ActorDelta source; base Actor's own degraded action/movement stay untouched. |
| `Combat#nextTurn restores a custom turn pool through the synthetic Actor's ActorDelta without disturbing its neighbor` | Whole-array pool write through ActorDelta: length, order, and the `recovery: "none"` neighbor unchanged; only the `turn` pool value restores; no `modifierBonus` in source; base Actor keeps `pools: []`. |
| `Combat#nextTurn leaves non-turn resources and pools unchanged` | health (`recovery: "none"`) and a `shortRest` pool are untouched while reaction restores in the same transition. |
| `Combat#nextTurn dispatches the persisted Bleeding turn-start Trigger exactly once on the synthetic Actor` | Reads the configured constant Bleeding amount, applies Bleeding after round 1 starts, and requires health to drop by exactly that amount once (not zero, not twice) in synthetic, prepared, and ActorDelta state; base Actor untouched; the effect survives; recovery happened in the same turn start. |
| `Actor#startTurn rejects a stale turn context and a non-incoming Actor without mutating resources` | Existing guards: mismatched turn context → `INVALID_LIFECYCLE`; base world Actor for a synthetic Combatant → `ACTOR_NOT_INCOMING_COMBATANT`; synthetic source, ActorDelta source, and base Actor all unchanged. |

What this slice is designed to prove, in one GM client: the GM execution path of the managed
callback runs, the hardcoded managed authority object is accepted, the recovery and condition
consequence commit through the ActorDelta, and the repaired `startTurn()` whole-array write is
correct on the harder synthetic-Actor boundary. What it cannot prove and does not claim: that
exactly one of several connected GMs executes, GM failover, that remote clients never duplicate the
callback, or anything about sockets, prompts, or movement. Those remain multiplayer concerns.

The slice changes no production semantics. `rest()` is not covered here; it shares the repaired
array write but has no turn transition to drive it and would need its own trigger.

## Custom-pool persistence repair (Q1 history)

Verified against the installed **V14.367** source at
`C:\Program Files\Foundry Virtual Tabletop\resources\app` (version confirmed in `package.json`):

- `common/data/fields.mjs`: `SchemaField._cleanType` expands dotted keys (line 1073);
  `ArrayField._cast` converts numeric-key objects into arrays (2369). `_cleanElement` forces
  `partial: false` (2421), `_updateDiff` validates complete replacement leaves (2492), and
  `_updateCommit` replaces array contents (2528). An indexed `system.pools.1.value` payload therefore
  supplies incomplete replacement entries, not a partial patch retaining the existing neighbors.
- `common/abstract/data.mjs`: `DataModel.updateSource` cleans, validates, and commits the update
  (669); `toObject(true)` returns a deep clone of `_source` (820), excluding prepared contributions.

The failure is a runtime persistence defect; the two-entry Quench fixture and its source/prepared
assertions remain valid. The maintainer supplied the result summary, not the assertion stack or pool
dump, so exact source/prepared values after the original failed update are not claimed here. The
same Quench case now appends compact before/after source and prepared pools, target index, expected
value, and actual target/neighbor data on failure, preserving all existing assertions.

`WildPathActor.spendResource`, `spendResources`, `startTurn`, and `rest` now send `"system.pools"`
as one complete array cloned through `this.toObject(true)`. Only requested `value` fields change;
source order, neighbors, manual bonuses, and stored maxima survive. Calculations still use prepared
values/maxima. Prepared `modifierBonus` and derived maxima are never copied back into source.
Multiple custom costs share one source array, and mixed built-in/custom costs remain one Actor
update after affordability validation. Turn/rest changes only repair the identical array write;
their existing recovery selection, Combat validation, and lifecycle callbacks are unchanged.

Previous Node coverage exercised resource arithmetic/plans and permissive dotted-path setters that
could mutate JavaScript array indices without Foundry cleaning or validation. Nine new cases in
`test/actor-resource-persistence.test.mjs` call the real Actor methods and reject indexed array
updates: single nonzero-index spending; mixed built-in/two-custom spending; single and multi-cost
rejection; restoration/forced clamping; rejected persistence; unchanged built-in paths; short and
long rest recovery. The existing turn-recovery test now checks clean source replacement and its
adapter rejects indexed array paths too. Six of the nine new cases failed before the runtime fix;
all nine now pass. This is deterministic boundary coverage, not a live Quench rerun.

## Run Q1 in the disposable V14.367 QA world

1. Use the disposable WildPath QA world with these files installed; reload after replacing the
   original smoke script. Do not run against campaign content.
2. Enable Quench v0.10.0. Disable unrelated modules for a clear baseline.
3. In Quench's client settings, use `quench.exampleTests = false`, `quench.autoRun = false`, and
   `quench.autoShowQuenchWindow = true`. These are manual recommendations; WildPath does not set them.
   Reload after changing `quench.exampleTests` so previously registered example batches disappear.
4. Log in as GM and wait for Foundry to be ready.
5. Open Quench and let its window finish rendering before starting tests.
6. To repeat the resource regression check, select only `wildpath.resources` and run its eight cases.
   For full Q1, also select `wildpath.runtime-smoke` and `wildpath.documents`. Retain the report and
   check cleanup. Q2 has its separate selection below.
7. Expected resources: **8 passing, 0 failing, 0 pending**; full Q1: **17 passing, 0 failing, 0 pending**.
   The maintainer confirmed the post-fix pass above. A non-GM can run the two
   read-only smoke cases and skip the 15 mutation cases without creating or deleting Documents.
8. Retain Quench's report, WildPath commit/worktree revision, Foundry/Quench versions, and any failing
   case with its assertion and stack. Inspect vendor warnings separately. Verify no new marked
   fixture Actors remain before recording a live pass.

## Run Q2 in the disposable V14.367 QA world

Install the current worktree and reload Foundry. Enable Quench v0.10.0, log in as GM, wait for
Foundry ready, and open/render the Quench window before starting tests. Keep the same manual client
settings: `quench.exampleTests = false`, `quench.autoRun = false`, and
`quench.autoShowQuenchWindow = true`; reload after changing the example setting.

Select only `wildpath.effects`, `wildpath.conditions`, and `wildpath.rule-elements`, or run:

```js
await quench.runBatches([
  "wildpath.effects",
  "wildpath.conditions",
  "wildpath.rule-elements"
]);
```

Expected: **all 17 Q2 WildPath cases passing** (4 effects + 5 conditions + 8 RuleElements),
0 failing, 0 pending as GM. The maintainer has observed this result once on V14.367 (maintainer-reported,
no exported report); rerun it after any change to the covered production classes. Non-GMs skip all 17 Q2
cases without document writes. Retain the report/revision, inspect failures by their boundary messages,
and repeat the batches to check cleanup and preparation stability. Vendor warnings/example failures
are separate from WildPath assertions. Do not start Q3/Q4 as part of this run.

## Run the Combat slice in the disposable V14.367 QA world

Same world, Quench version, GM login, ready state, rendered Quench window, and manual client settings
as Q1/Q2. The batch requires the running GM to be Foundry's active GM: core's `_manageTurnEvents`
only triggers the start-turn workflow when `game.user.isActiveGM`, so run it with a single GM client
connected. Select only `wildpath.combat`, or run:

```js
await quench.runBatches([
  "wildpath.combat"
]);
```

Expected: **6 passing, 0 failing, 0 pending** as GM. The maintainer has observed this result once on
V14.367 (maintainer-reported, no exported report); rerun it after any change to `WildPathCombat`,
`WildPathActor` recovery, the condition trigger planner, or the fixture helper. Non-GMs skip all six
cases without document writes. Each case creates and deletes its own Scene,
Token, Combat, and base Actor; the combat tracker may briefly show a fixture encounter only if the
fixture Scene were viewed, which the fixture never does.

**Expected console output that is not a WildPath failure.** Two kinds appeared in the maintainer's run:

1. Quench v0.10.0's deprecated `Game` and `SearchFilter` global warnings (known vendor debt).
2. On every `startCombat()` / `nextTurn()` update, an uncaught promise rejection from **core**:
   `TypeError: Cannot use 'in' operator to search for 'turn' in undefined` at
   `CombatTracker._onRender`. Installed 14.367 source
   (`client/applications/sidebar/tabs/combat-tracker.mjs:185-188`) does
   `data = renderData.find(d => d._id === this.viewed?.id)` and then `"turn" in data`; when the
   updated Combat is not the tracker's viewed encounter, `find` returns `undefined` and the `in`
   test throws. The fixture Combat is deliberately never viewed (its Scene is not the current
   scene), so every transition trips this. The stack contains no WildPath frames — the update
   completes, `_manageTurnEvents` runs, and only the tracker's scroll-into-view step is skipped —
   which is why all six assertions held. It is a core defect reproducible by any system that
   updates a non-viewed Combat. WildPath does not patch core, and the fixture is not changed to
   make the encounter viewed, because that would mutate the GM's tracker state to hide a core bug.
   Worth reporting upstream.

Failures that **would** indicate WildPath defects, by case:

- fixture case: `Combatant#actor` not the synthetic Actor, or a synthetic update reaching the base
  Actor — the synthetic-Actor identity invariant is broken at the Foundry boundary.
- built-in recovery: values still degraded after `combatTurnChange` — `_onStartTurn` did not run,
  `validateTurnRecoveryContext` rejected a real context, or the delta write did not persist.
- custom pool: neighbor changed, order/length changed, or `modifierBonus` in ActorDelta source — the
  ArrayField-through-ActorDelta write is wrong (same defect class as the Q1 repair).
- non-turn: health or the `shortRest` pool restored — recovery selection is too broad.
- Bleeding: health unchanged (trigger not dispatched from the Combat callback), or reduced twice
  (duplicate dispatch between `startTurn` and the lifecycle commit) — the failure message includes
  every persisted synthetic update observed during the transition.
- guard: any resource mutation after a rejection, or a different rejection code.

A `combatTurnChange did not fire` timeout means the transition never completed on this client;
check that the client is the active GM before suspecting WildPath.

After the run, the orphan diagnostic must report empty arrays for all three collections:

```js
const {findQuenchFixtures} = await import("/systems/wildpath/module/tests/quench/fixtures.mjs");
console.table(Object.entries(findQuenchFixtures()).flatMap(([kind, rows]) => rows.map(row => ({kind, ...row}))));
```

To remove one abandoned run, use `cleanupQuenchFixtures({runId})` as above; it deletes owned Combats,
then Scenes (with their Tokens and ActorDeltas), then Actors, and refuses to run without a run ID.

## Staged movement: six cases (6/6 live-confirmed)

`module/tests/quench/staged-movement.mjs` registers the eighth batch, **`wildpath.staged-movement`**
with display name **WILDPATH: Staged Movement**, through the existing single `quenchReady` hook.
It adds exactly these cases:

| Exact test name | Expected outcome |
| --- | --- |
| `ordinary square/Medium movement` | 3/3 transitions; movement 30 → 15; HP 30; reaction 1; no offered candidates or child. |
| `square/Medium reaction decline` | Pending proof before decline; one offered/recorded declined candidate; no child; 3/3; movement 15; HP 30; reaction 1. |
| `square/Medium reaction miss` | Pending proof before use; one real digital attack misses AC 100; HP 30; reaction 0; resumes to 3/3; movement 15. |
| `square/Medium reaction hit` | Pending proof before use; one real digital attack hits AC 1 for fixed 6 damage; HP 24; reaction 0; resumes to 3/3; movement 15. |
| `square/Medium reaction stop` | Child hits and commits fixed 6 damage plus the existing QA Prone effect; parent stops before transition 1 traverses and successfully commits 1/3 transitions at waypoint 1; movement 25; HP 24; reaction 0. |
| `Large-hex reaction decline` | Decline semantics; 3/3; movement 15; HP 30; reaction 1; no child; origin and all three waypoints remain Large three-field hex footprints; persisted final footprint equals logical final footprint. |

Each case creates its own marked base Actors, disposable Scene, two unlinked Tokens with real
synthetic Actors/ActorDeltas, and a real Action Item on the synthetic reactor. It uses the production
Foundry movement-intent adapter, tactical-grid adapter, staged movement host, reaction/action
pipeline, persistence adapter, and `foundry-digital` Roll provider. The shared `qaActionData` fixture
uses a real d20 with +4, fixed 6 damage, and Item-local policy disabling natural critical hits/misses;
AC 100/1 therefore makes the expected result deterministic without replacing dice or RollResults.
The child proof requires both `provider.id === "foundry-digital"` and
`provenance.type === "foundry-digital"`, plus real serialized Foundry Roll terms.

The suite imports `captureMovementQA`, `verifyPendingMovementQA`, `verifyMovementQA`, and
`footprintSnapshot` directly from `docs/development/staged-movement-qa-proof.mjs`. It does not
duplicate or relax their definition of success. The scripted PromptPort is awaited by the real
coordinator at the pending reaction choice: capture the state, run the pending verifier, then
return decline/use. A failed proof releases no response. No DOM clicking, dialog operation, polling,
or manual intervention is needed during a successful batch run. Unexpected additional prompts fail.

A fresh production coordinator per case uses application-local envelope delivery and no socket
subscription. Its normal result broadcast is consumed locally; remote requests fail explicitly.
All fixture Actor ownership is confined to the GM. The installed runtime coordinator and prompt
ports are not replaced. Only `game.wildpath.reactionServices` is temporarily scoped to the exact
fixture resolution ID and Token UUID, delegates unrelated requests, and is restored in `finally`
after the awaited execution, including failures. Local GM rolls do not require a socket
`REQUEST_RESPONSE`. This transport boundary is precisely why the batch cannot establish Level 5.

A read-only wrapper around the normal child execution captures the child with its RollResult and
logical target footprint before calling the unchanged production commit. It then records the
completed child transaction and persisted resources/effects while the Token remains at origin and
movement remains 30. The final proof checks that the parent retained the completed child status,
paid only its completed prefix, and left the successful child mutations intact. Additional checks
read synthetic Actor source and ActorDelta source and require the base Actors to remain unchanged.
The stop fixture uses the same `stagedMovementRun` metadata and Prone condition/effect path as the
live helper; its continuation validator stops only after that real effect exists.

Both route layouts are proven with the installed tactical adapter: footprint-distance progression
`1,1,2,3`, adjacent anchors, and full occupancy at origin plus three waypoints. The hex Scene uses
`HEXODDR`, size 100, distance 5 ft, with Actor size `large` and Token width/height 2,
`CONST.TOKEN_SHAPES.ELLIPSE_1`. `largeHexLayout` supplies the existing axial layout; every footprint
must resolve with no occupancy diagnostics. Expected occupied-field arrays are not fabricated.

**No viewed Scene is required.** Installed V14.367 `TokenDocument#getCompleteMovementPath` and
`getOccupiedGridSpaceOffsets` read the parent Scene grid; occupancy receives the Token's own Level.
The fixture calls public `Scene#initializeEdges()` on its empty disposable Scene to provide Level
boundary geometry. It never activates/views that Scene, replaces canvas state, or reads selected
Tokens. These APIs were checked against installed 14.367 source and the official
[TokenDocument API](https://foundryvtt.com/api/classes/foundry.documents.TokenDocument.html) and
[Scene API](https://foundryvtt.com/api/classes/foundry.documents.Scene.html#initializeEdges).
The maintainer's first live run confirmed this Scene/Token setup on V14.367 for all six cases; the single
failure was in position verification, not fixture geometry.

Run in the disposable V14.367 QA world as the active GM after Foundry is ready and the Quench
v0.10.0 window has rendered. Retain the existing manual Quench client settings above; WildPath
does not change them. Select only `wildpath.staged-movement`, or run:

```js
await quench.runBatches(["wildpath.staged-movement"]);
```

Expected: **6 passing, 0 failing, 0 pending** as the active GM; non-GMs skip all six without writes.
Repeat the batch to check isolation, save the Quench report with the worktree revision and
Foundry/Quench versions, and run the orphan diagnostic below. No fixture Documents should remain
after success or assertion failure. Cleanup uses the existing exact-marker/exact-run-ID teardown;
Scene-owned Tokens, ActorDeltas, Items, effects, and Levels disappear with the Scene. A browser
reload or genuinely stalled Foundry document operation can interrupt teardown; wait for outstanding
operations before removing a specifically identified abandoned run. Level-3 evidence for all six
cases is accepted on the maintainer's reported 6/6 after `e30d752`. Rerun the batch after any change
to the movement host, the staged-movement adapters, reaction orchestration, or the tactical-grid
adapter. Whether the movement milestone is marked closed is a Level-5 decision recorded in
[project-state.md](project-state.md).

## Fixture cleanliness (all Quench batches)

After a successful or failed run, every array in this GM console check must be empty:

```js
const {findQuenchFixtures} = await import("/systems/wildpath/module/tests/quench/fixtures.mjs");
findQuenchFixtures(); // {combats: [], scenes: [], actors: []}
```

The existing `afterEach` cleanup remains unchanged: Mocha invokes it after assertion failures and it
removes only the exact marked run. A portable test explicitly exercises that teardown after a
mid-test assertion failure while retaining another run's fixture. Actual leftovers in the maintainer's
world have not been inspected here; the console check is a manual verification step.

For interrupted cleanup, inspect leftovers in the GM console after outstanding operations finish:

```js
console.table(game.actors.filter(a => a.getFlag("wildpath", "quenchFixture") === true)
  .map(a => ({id:a.id, name:a.name, runId:a.getFlag("wildpath", "quenchRunId")})));
```

Then remove only the intended completed/abandoned run:

```js
const {cleanupQuenchFixtures} = await import("/systems/wildpath/module/tests/quench/fixtures.mjs");
await cleanupQuenchFixtures({runId:"EXACT_RUN_ID_FROM_TABLE"});
```

Never remove the marker requirement or supply a name-based fallback. Legacy unmarked smoke Actors
are outside this helper's cleanup scope.

## Portable validation and deferred phases

Run `npm.cmd test`, `npm.cmd run typecheck`, `node --check` for the changed modules, and
`git diff --check`. The thirteen tests in `test/quench-infrastructure.test.mjs` cover registration with
Quench absent, eight-batch inventory and exact movement names/counts, unchanged fixture defaults,
custom Scene grids and Token footprint fields, scoped fixture creation/deletion, ActiveEffect and
Scene/Token/Combat parent guards, cleanup ordering across collections, the read-only orphan listing,
GM guards, and cleanup failures. Eight tests in `test/quench-staged-movement.test.mjs` cover pending
proof ordering/failure, deterministic response selection, unexpected/duplicate prompt rejection,
exact runtime-service scope and restoration, and local coordinator intent/result delivery and
remote-delivery rejection. They do not mirror the integration assertions in Node, and their
controlled API collaborators do **not** stand in for execution of the 17 Q1, 17 Q2, 6 Combat, or
6 staged-movement real-Foundry cases. Validation for this staged-movement addition: **821 Node tests,
819 passed, 0 failed, 2 intentionally skipped** (installation-dependent nested condition-commit
checks); typecheck and diff whitespace checks passed. This adds **10 portable tests** (two fixture
cases and eight orchestration cases), retaining the previous 811 tests. The position-verification
repair (`e30d752`) adds four deterministic cases to `test/staged-movement.test.mjs` — floating-point-
equivalent acceptance including the authorized in-flight destination, material-difference rejection
with restoration, the comparison boundary itself, and canonicalized restoration — for
**825 tests, 823 passed, 0 failed, 2 skipped**. The prior baseline and
historical live evidence are recorded in [project-state.md](project-state.md).

- Q3: the synthetic-Actor/Combat portion is live-confirmed as `wildpath.combat`;
  real digital attack rolls are live-confirmed inside `wildpath.staged-movement` (miss/hit/stop children).
  Broader Rolls, `rest()`, expiry scheduling, skipped turns, round events, and multiple Combatants remain deferred.
- Q4: broader persistence rollback/Action entry; nested movement reaction Action commits are
  live-confirmed inside the staged-movement batch.
- Future: migrations.

The Q1 production repair is limited to correcting custom-pool array persistence in the four Actor
methods above. Q2 and the Combat slice change test modules, portable infrastructure coverage, and
documentation only.
No Quench dependency is added to `system.json`, and no Quench source is vendored.
