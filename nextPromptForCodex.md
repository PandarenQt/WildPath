# WildPath — Production Action Runtime Live Proof: Persisted Melee Hit/Miss

## Recommended model

GPT-6 Astra
Reasoning: Extra High

Reason:

This milestone crosses the real player-facing Foundry Item API, active-GM multiplayer authority, native target selection, TacticalGrid reconstruction, actual Foundry digital rolls, staged resolution, synthetic Actor handling, transaction-backed damage/payment, and authoritative result delivery.

The automated path is already strong. The purpose of this task is to produce the smallest reliable live gate and fix only defects actually exposed by that gate.

# STOP CONDITIONS

Stop implementation and report rather than improvising if:

* `main` is not clean or not synchronized with `origin/main`;
* `main` does not begin at:

`5c1f467a3c289845eeb3dbdadb5aa742b97e5653`

* the ordinary production path no longer runs through `WildPathItem#use()`;
* a proposed QA shortcut would bypass `item.use()`, `game.wildpath.executeActionIntent()`, the multiplayer coordinator, the real Foundry digital RollProvider, or the real Foundry persistence adapter;
* accomplishing the task appears to require redesigning ActionDefinition, ResolutionState, RollProvider, TacticalGrid, transaction semantics, or multiplayer authority;
* a live defect is discovered whose root cause is not yet demonstrated.

Do not hide a live failure by weakening assertions.

Do not force-push.

Do not merge to `main`.

# CONTINUE CONDITIONS

Continue only when:

* the existing production path has been traced;
* the QA fixture uses real persisted Foundry Documents;
* the Player initiates the Action through the real embedded `WildPathItem#use()`;
* Foundry-native target selection is used;
* the normal registered digital RollProvider answers the attack request;
* the active GM owns authoritative resolution and commit;
* the live gate provides sufficient diagnostics to identify a failed stage without ad-hoc follow-up console archaeology.

# 1. Branch

Create:

`milestone/action-runtime-live-proof`

from current `main`.

Do not work directly on `main`.

# 2. Read first

Read and obey:

* `AGENTS.md`
* `CODEX.md`
* `ARCHITECTURE.md`
* `developmentStrat.md`
* `CORE_AUTOMATION_FOUNDATION.md`

Then inspect at minimum:

* `module/documents/item.mjs`
* `module/data/item/action.mjs`
* `module/resolvers/foundry-multiplayer-runtime.mjs`
* `module/resolvers/multiplayer-action-coordinator.mjs`
* `module/resolvers/action-pipeline-resolver.mjs`
* `module/adapters/foundry-digital-roll-provider.mjs`
* `module/adapters/foundry-v14-persistence-adapter.mjs`
* `module/adapters/foundry-v14-tactical-grid-adapter.mjs`
* `test/foundry-action-runtime.test.mjs`

Trace the production call graph before changing anything.

Expected entry:

```text
player-owned embedded WildPath Action Item
→ WildPathItem#use()
→ buildFoundryActionUseIntent()
→ game.wildpath.executeActionIntent()
→ player coordinator
→ system.wildpath socket
→ active GM coordinator
→ foundryActionIntentToStagedOptions()
→ staged Action ResolutionState
→ remote digital RollRequest
→ Foundry Roll
→ authoritative attack outcome
→ damage/payment mutation plans
→ transaction
→ Foundry persistence adapter
→ result envelope back to initiating Player
```

Confirm this against source rather than assuming it.

# 3. Existing automated baseline

The current production-shaped tests already prove:

* `WildPathItem#use()` is wired to `executeActionIntent`, not the legacy synchronous resolver;
* client intent contains stable references and `game.user.targets`;
* GM reconstruction creates TacticalGrid source/target footprints;
* Actor combat statistics are snapshotted into plain staged inputs;
* player attack RollRequest routes through multiplayer coordination;
* hit applies damage and spends Action;
* miss applies no damage but still spends Action;
* result envelopes return from authority.

Do not duplicate these abstractions.

# 4. Scope: only the first ordinary live vertical slice

This milestone covers:

## Case A — Melee hit

A real Player uses a real embedded persisted Action Item against a real targeted adjacent Token.

Expected:

```text
Item.use() returns declaration success
→ attack roll request executes on intended Player
→ real Foundry Roll provenance is digital
→ GM resolves hit against authoritative target AC
→ fixed deterministic damage definition is applied
→ source Action resource is spent
→ target HP is reduced
→ ResolutionState completes
→ authoritative result reaches initiating Player
```

## Case B — Melee miss

Same production path, but arrange target AC / attack modifier so the actual rolled result cannot hit, or otherwise use a deterministic QA-safe method that still invokes the real Foundry `Roll`.

Expected:

```text
ordinary child/request routing succeeds
→ attack resolves miss
→ target HP unchanged
→ source Action resource spent
→ ResolutionState completes
→ result reaches initiating Player
```

Do not add ranged, saving throws, healing, AoE, physical dice, or effects to this milestone.

Those are later representative gates after the ordinary entry point itself is live-green.

# 5. Use a REAL persisted Action Item

The QA must not create a plain object and feed it directly to the coordinator.

Create or reuse a real embedded Foundry Item:

```text
type: "action"
```

whose `system.definition` is a valid persisted ActionDefinition.

It should be attached to the player-owned source Actor so the actual runtime object is a `WildPathItem`.

The Action should be equivalent to the existing automated runtime melee fixture:

* costs one Action;
* single required target;
* melee attack;
* AC defense;
* 5 ft reach;
* simple fixed slashing damage.

Use the current actual DataModel schema rather than copying test fake shapes blindly.

The QA fixture may temporarily create a marked embedded Action Item and remove it during cleanup.

Mark all QA-created Documents with explicit WildPath QA flags/metadata so cleanup never deletes unrelated game content.

# 6. Real target selection

The Player must select the target through ordinary Foundry Token targeting so:

```js
game.user.targets
```

contains the real target Token.

Do not inject `targetRefs` manually into the Action intent.

The live proof must therefore exercise:

```text
Foundry Token target
→ buildFoundryActionUseIntent()
→ stable target refs
→ authoritative target reconstruction
```

# 7. Real source Token

Use a player-owned Token on the active Scene.

Prefer an unlinked/synthetic source Token Actor because synthetic Actor isolation is a critical WildPath invariant.

The GM proof must distinguish:

```text
source synthetic Token Actor
```

from:

```text
base world Actor
```

and prove the Action resource spend affects only the intended synthetic Actor.

If a synthetic source makes the ordinary production path impossible due to a real defect, stop and diagnose that defect rather than silently switching to a linked Actor.

# 8. Target Actor

Use a disposable target Token with:

* known HP;
* known AC;
* no relevant damage resistance/immunity;
* no unrelated effects that change the test result.

The setup must record:

```text
target HP before
target AC
source Action resource before
base world Actor source snapshot
```

# 9. Real digital roll

Do not install `createTestRollProvider`.

Do not monkey-patch the coordinator's roll provider.

Use the production-registered:

`createFoundryDigitalRollProvider()`

through the normal runtime.

The live diagnostic must prove the returned RollResult provenance includes the Foundry digital provider / digital method rather than merely observing that a number appeared.

If it is impossible to force a known hit or miss while preserving the real Roll, control the fixture mathematically instead:

For Hit:

* choose sufficiently low AC / high modifier that every possible d20 result hits, subject to current WildPath critical/fumble semantics.

For Miss:

* choose sufficiently high AC / low modifier that every possible d20 result misses.

Do not replace real dice with fixed fake results merely to get deterministic QA.

If natural-1/natural-20 automatic semantics affect this guarantee, inspect the actual AttackResolver and choose the safest legitimate fixture.

# 10. Attack statistic

The QA source must expose the actual statistic required by the ActionDefinition, e.g.:

`attack.weapon`

Do not inject `modifierTotal` directly into the Action intent.

The active GM should derive it from the Actor through:

`resolveActorAttackStatistic()`

as production currently does.

The QA final output must expose:

```text
attack statistic/domain
attack modifier used
roll natural/total where available
target defense value used
hit/miss outcome
```

# 11. TacticalGrid proof

Place source and target adjacent.

The authoritative GM diagnostic must prove:

* a source Token was resolved;
* a target Token was resolved from the Player's target selection;
* source footprint exists;
* target footprint exists;
* range/reach validation passed using WildPath tactical geometry.

If testing with the current Large-hex QA Token is convenient, that is allowed, but this milestone does not need to re-prove all Large-hex movement behavior.

Prefer the simplest reliable melee geometry.

Do not calculate melee adjacency from raw pixels in QA.

# 12. Actual persistence proof

For Hit:

verify after completion:

```text
target HP after
= target HP before - expected damage
```

and:

```text
source action resource after
= source action resource before - 1
```

For Miss:

verify:

```text
target HP after
= target HP before
```

and:

```text
source action resource after
= source action resource before - 1
```

Use the actual Foundry persistence adapter and actual Actor updates.

Do not mutate HP or Action resource manually between declaration and final proof.

# 13. Synthetic Actor isolation

If source is unlinked:

verify the source Token Actor receives the Action-resource mutation while the base world Actor remains byte/JSON-equivalent for the relevant resource/effect state.

Also ensure target mutations land on the exact intended Actor represented by the targeted Token.

Do not assume Token Actor and world Actor are interchangeable.

# 14. Result delivery proof

`WildPathItem#use()` currently proves declaration, not by itself final resolution completion.

The QA must therefore inspect the existing coordinator/result APIs to prove that the Player ultimately receives the authoritative terminal result for the resolution created by their Item use.

Do this without modifying production result semantics merely for QA.

The Player proof should establish:

```text
resolutionId
expected authority user
terminal result received
terminal status = completed
```

The GM proof should establish the matching authoritative record completed.

The IDs must correlate.

# 15. Diagnostic quality

Before live QA, improve the QA/runbook observability enough that a failure shows, in one retained dump:

* resolutionId;
* authority user;
* root status/current stage;
* completed stages;
* pending requests;
* request routing / expected user;
* roll requests/results;
* attack result;
* target refs;
* source/target footprints summary;
* mutation plans;
* transaction/commit result;
* errors;
* trace tail;
* source resource before/after;
* target HP before/after;
* Player result envelope.

Keep diagnostics bounded.

Do not dump entire giant Token movement histories like the previous movement QA unless directly relevant.

Prefer concise summaries.

If generic coordinator failure provenance is already sufficient, reuse it rather than adding another parallel diagnostic model.

# 16. QA document

Create:

`docs/development/action-runtime-live-qa.md`

At the very top place:

## STOP CONDITIONS

then:

## CONTINUE CONDITIONS

before any setup instructions or code.

Every console step must be a **complete fresh pasteable block**.

Do not tell the maintainer to edit an earlier block.

Do not say “reuse the previous snippet with X changed.”

Clearly label each block:

```text
GM
PLAYER
```

and exact execution order.

# 17. QA structure

Preferred flow:

```text
0. Preconditions / reload both clients
1. GM setup
2. Player setup
3. Hit fixture prepare
4. Player target proof
5. Player calls REAL embeddedAction.use()
6. GM authoritative completion proof
7. Player result-delivery proof
8. Hit final persistence proof
9. Miss fixture prepare
10. Player target proof
11. Player calls same REAL embeddedAction.use()
12. GM authoritative completion proof
13. Player result-delivery proof
14. Miss final persistence proof
15. Cleanup
```

Adapt this if actual runtime behavior requires a better order.

# 18. The critical invocation

The live Action must actually be initiated by something equivalent to:

```js
const action = sourceActor.items.get(qaActionId);
const declared = await action.use();
```

Do not instead call:

```js
game.wildpath.executeActionIntent(...)
```

directly from the QA start block.

The point of the milestone is to test the full player-facing Item entry.

If `item.use()` does not expose the resolution ID needed for QA, observe/correlate it through the existing coordinator/runtime state. Do not change `item.use()` return semantics merely for the test unless a genuine product requirement justifies such a change.

# 19. Automated tests

Do not weaken the existing production-entry tests.

Add tests only where the live-QA harness exposes an untested production seam.

At minimum, consider automated coverage for any helper added to:

* identify the resolution spawned by `Item#use()`;
* summarize terminal Action diagnostics;
* construct/validate the persisted QA ActionDefinition;
* ensure QA does not bypass the production Item entry.

If no production changes are required, it is acceptable for this task to primarily add the live QA runbook plus bounded helper tests.

# 20. No premature broadening

Explicitly out of scope:

* ranged attacks;
* save-based actions;
* damage types beyond the simple fixture;
* healing;
* conditions;
* areas;
* cones/lines/radii;
* physical dice;
* manual dice;
* reactions;
* opportunity attacks;
* persistent Areas;
* HUD;
* chat cards;
* finished result presentation;
* Action Configuration choices;
* upcasting;
* weapon size policies;
* terrain;
* movement.

Do not broaden scope merely because these systems exist.

# 21. Architecture invariant

The QA should prove this exact relationship:

```text
Player UI/Item intent
        ↓
Application multiplayer coordination
        ↓
Pure staged rules
        ↓
Mutation plans
        ↓
transaction
        ↓
Foundry persistence
```

Do not move rules into the QA or Foundry UI layer.

# 22. Implement only demonstrated fixes

Before live QA, make no speculative runtime refactor.

If static/automated inspection exposes an obvious blocker, fix it only with a direct reproduction and regression.

Otherwise produce the QA gate first.

After the maintainer runs it:

* if both Hit and Miss pass, close the first ordinary Action live milestone;
* if either fails, stop at that failure and use the retained diagnostics to make the next repair task.

# 23. Verification

Run:

```bash
npm test
npm run build
npm run typecheck
git diff --check
git diff --cached --check
```

Baseline is currently:

`729/729`

No regression is acceptable.

Ensure generated `.mts` / `.mjs` pairs remain synchronized where applicable.

Validate every JavaScript console block in the QA document parses.

# 24. Git

Branch:

`milestone/action-runtime-live-proof`

Commit only coherent completed work.

Suggested commit if QA/runbook only:

`Add production Action runtime live QA`

If a demonstrated production defect must also be repaired, use a commit message describing the actual repair instead.

Push normally to:

`origin/milestone/action-runtime-live-proof`

No force push.

Do not merge `main`.

# 25. Completion report

Report:

## Production trace

Show the confirmed real call path from `WildPathItem#use()` to authoritative commit/result.

## QA fixture

State exactly what real Documents are created/used and which are temporary.

## Digital roll proof

Explain how the QA proves the production Foundry RollProvider is used.

## Diagnostics

Describe what will be retained automatically if live QA fails.

## Runtime changes

State either:

`none`

or list each demonstrated defect and minimal repair.

## Tests

Report total count and new regressions.

## Verification

Report:

* test count;
* build;
* typecheck;
* diff checks;
* generated sync;
* console-block parsing.

## Git

Report:

* branch;
* commit;
* push;
* worktree;
* remote sync.

## Live status

End explicitly with:

`LIVE QA PENDING`

Do not claim this milestone live-green until the maintainer runs both the Hit and Miss cases in real Foundry.
