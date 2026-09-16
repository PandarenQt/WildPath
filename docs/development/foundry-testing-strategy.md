# Foundry integration testing: Quench Q1

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

The maintainer has demonstrated Quench **v0.10.0** executing the original WildPath smoke batch in
**Foundry V14.367**: active system, Actor/character model registration, real Actor creation/update/
deletion, and prepared resource defaults. This establishes Quench as a viable semi-automated
real-Foundry integration layer. That prior result does **not** establish a pass for the refactored
Q1 batches below: **implemented, not yet live-run**.

Quench v0.10.0 is not V14-clean: its deprecated `Game`, `SearchFilter`, and `FilePicker` references
emit vendor compatibility warnings. It also has a reported auto-run/UI ordering problem if execution
starts before its Application is rendered. Keep those warnings separate from WildPath assertion
failures. WildPath neither patches Quench nor suppresses compatibility warnings.

## Registration and fixtures

`wildpath.mjs` imports only `module/tests/quench/index.mjs` for this layer. That file owns the single
`quenchReady` subscription and registers exactly three batches. Batch modules never subscribe to
hooks themselves. No Quench globals, dependency, client setting writes, fixture creation, or test
execution are required at normal startup. If Quench is absent, its hook simply never fires.
The old smoke file and unfinished top-level test index/fixtures have been migrated into this directory.
Registration follows [Quench's batch/context API](https://github.com/Ethaks/FVTT-Quench#register-a-test-batch).

Each mutation test gets a fresh `foundry.utils.randomID()` run ID in `beforeEach`. Created Actors
and embedded Items carry `flags.wildpath.quenchFixture: true` and `flags.wildpath.quenchRunId`.
`afterEach` uses real `Actor.deleteDocuments` for Actors with **both** that exact marker and run ID;
embedded Items are removed with their fixture parent. A test that explicitly deletes its fixture is
safe to clean again. Cleanup does not depend on creation returning successfully: marked Documents
are found even if a later creation callback throws. Rejected cleanup is reported as a failure with
the run ID, rather than hidden.

Helpers in `module/tests/quench/fixtures.mjs`:

- `createQuenchActor({runId, name, type, system})`
- `createEmbeddedQuenchItem(actor, {name, type, system})`, requiring a marked parent
- `cleanupQuenchFixtures({runId})`, requiring a nonempty run ID
- `useQuenchFixtures(context)`, installing GM/ready guards and per-test cleanup

Mutation suites use 30-second timeouts and skip cleanly for non-GMs, including teardown. Their helper
APIs independently reject non-GM calls. The two read-only smoke cases may run as a player. Names
are diagnostic only; a matching name never authorizes deletion. Run one QA client at a time and do
not edit fixtures while tests are executing. A browser reload or an outstanding operation after a
timeout can outlive teardown; inspect marked leftovers before rerunning.

## Implemented batches and exact cases

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
equal the effective maximum. This matches the existing DataModel contract, not a runtime repair.
An awaited Document update plus collection/source inspection exercises Foundry's update workflow;
it does not claim a server restart/database-reload proof.

## Run Q1 in the disposable V14.367 QA world

1. Use the disposable WildPath QA world with these files installed; reload after replacing the
   original smoke script. Do not run against campaign content.
2. Enable Quench v0.10.0. Disable unrelated modules for a clear baseline.
3. In Quench's client settings, use `quench.exampleTests = false`, `quench.autoRun = false`, and
   `quench.autoShowQuenchWindow = true`. These are manual recommendations; WildPath does not set them.
4. Log in as GM and wait for Foundry to be ready.
5. Open Quench and let its window finish rendering before starting tests.
6. Select only `wildpath.runtime-smoke`, `wildpath.documents`, and `wildpath.resources`. They are
   intentionally not preselected. Run all three, then rerun to check fixture cleanup and repeatability.
7. Expected GM result: **17 passing, 0 failing, 0 pending**. A non-GM should instead run the two
   read-only smoke cases and skip the 15 mutation cases without creating or deleting Documents.
8. Retain Quench's report, WildPath commit/worktree revision, Foundry/Quench versions, and any failing
   case with its assertion and stack. Inspect vendor warnings separately. Verify no new marked
   fixture Actors remain before recording a live pass.

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
`git diff --check`. The six tests in `test/quench-infrastructure.test.mjs` cover registration with
Quench absent, scoped fixture creation/deletion, GM guards, and cleanup failures. Their controlled
API collaborators do **not** stand in for execution of the 17 real-Foundry cases. Current portable
counts and live status are recorded in [project-state.md](project-state.md).

- Q2: effects, conditions, RuleElements.
- Q3: synthetic Actors, Combat, Rolls.
- Q4: persistence rollback, Action entry.
- Future: migrations.

Q1 leaves movement, reactions, multiplayer envelopes, authority, confidentiality, and persistence
semantics unchanged. It adds no Quench dependency to `system.json` and vendors no Quench source.
