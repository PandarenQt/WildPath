# Foundry integration testing: Quench Q1 and Q2

## Evidence and testing ladder

| Level | What it proves |
| --- | --- |
| 1. Pure Node | Rules, resolvers, contracts, serialization, transactions |
| 2. Deterministic adapter/contract | Production-shaped interfaces and fakes |
| 3. Quench in Foundry | Real Documents, TypeDataModels, embedded collections, preparation, and document persistence |
| 4. Live single-client QA | Actual user interaction, presentation, and persistence workflows |
| 5. Live multiplayer QA | GM/player sockets, remote prompts, authority, timing, and visual movement |

A lower-layer pass does not prove a higher layer. A higher-layer pass does not replace deterministic
coverage. The [six-case staged movement gate](staged-movement-qa.md) remains a separate requirement.

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

**Q2 is implemented; live-run pending.** Its 17 additional cases cover ActiveEffects (4), conditions
(5), and RuleElements (8). The Q1 live result does not establish a Q2 pass. All six batches together
contain 34 cases; only Q1's 17 are currently live-confirmed.

Quench v0.10.0 is not V14-clean: its deprecated `Game`, `SearchFilter`, and `FilePicker` references
emit vendor compatibility warnings. It also has a reported auto-run/UI ordering problem if execution
starts before its Application is rendered. Keep those warnings separate from WildPath assertion
failures. WildPath neither patches Quench nor suppresses compatibility warnings.

## Registration and fixtures

`wildpath.mjs` imports only `module/tests/quench/index.mjs` for this layer. That file owns the single
`quenchReady` subscription and registers exactly six batches. Batch modules never subscribe to
hooks themselves. No Quench globals, dependency, client setting writes, fixture creation, or test
execution are required at normal startup. If Quench is absent, its hook simply never fires.
The old smoke file and unfinished top-level test index/fixtures have been migrated into this directory.
Registration follows [Quench's batch/context API](https://github.com/Ethaks/FVTT-Quench#register-a-test-batch).

Each mutation test gets a fresh `foundry.utils.randomID()` run ID in `beforeEach`. Created Actors
and embedded Items/helper-created ActiveEffects carry `flags.wildpath.quenchFixture: true` and
`flags.wildpath.quenchRunId`. Condition tests call the production Actor APIs directly on marked
fixture Actors; their generated children are owned by that marked parent without an extra flag
update that could hide a creation/preparation failure.
`afterEach` uses real `Actor.deleteDocuments` for Actors with **both** that exact marker and run ID;
embedded Items and ActiveEffects are removed with their fixture parent. A test that explicitly deletes its fixture is
safe to clean again. Cleanup does not depend on creation returning successfully: marked Documents
are found even if a later creation callback throws. Rejected cleanup is reported as a failure with
the run ID, rather than hidden.

Helpers in `module/tests/quench/fixtures.mjs`:

- `createQuenchActor({runId, name, type, system})`
- `createEmbeddedQuenchItem(actor, {name, type, system})`, requiring a marked parent
- `createEmbeddedQuenchEffect(actor, {name, type, system, disabled, duration, start})`, requiring a marked parent and run ID
- `cleanupQuenchFixtures({runId})`, requiring a nonempty run ID
- `useQuenchFixtures(context)`, installing GM/ready guards and per-test cleanup

Mutation suites use 30-second timeouts and skip cleanly for non-GMs, including teardown. Their helper
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

## Q2 batches and exact cases (implemented; live-run pending)

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

Expected: **all 17 implemented Q2 WildPath cases passing** (4 effects + 5 conditions + 8 RuleElements),
0 failing, 0 pending as GM. This is a target, **not an observed live result**. Non-GMs skip all 17 Q2
cases without document writes. Retain the report/revision, inspect failures by their boundary messages,
and repeat the batches to check cleanup and preparation stability. Vendor warnings/example failures
are separate from WildPath assertions. Do not start Q3/Q4 as part of this run.

## Fixture cleanliness (Q1 and Q2)

After a successful or failed run, this GM console check must return `[]`:

```js
game.actors.filter(a => a.getFlag("wildpath", "quenchFixture") === true)
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
`git diff --check`. The eight tests in `test/quench-infrastructure.test.mjs` cover registration with
Quench absent, six-batch inventory, scoped fixture creation/deletion, ActiveEffect parent/run guards,
GM guards, and cleanup failures. Q2 adds one fixture-boundary test and extends registration/GM checks;
it does not mirror the integration assertions in Node. Their controlled API collaborators do **not**
stand in for execution of the 17 Q1 and 17 Q2 real-Foundry cases. Current portable
counts and live status are recorded in [project-state.md](project-state.md).

- Q3: synthetic Actors, Combat, Rolls.
- Q4: persistence rollback, Action entry.
- Future: migrations.

The Q1 production repair is limited to correcting custom-pool array persistence in the four Actor
methods above. Q2 changes test modules, portable infrastructure coverage, and documentation only.
No Quench dependency is added to `system.json`, and no Quench source is vendored.
