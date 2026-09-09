## STOP CONDITIONS

Stop this run on the first failed assertion, error envelope, failed/cancelled state, or timeout.
Save the retained dumps from both clients. Do not retry the Action, reset resources during resolution,
substitute a linked source, answer a roll manually, or weaken an assertion to obtain a pass.

Stop if the running system is not this milestone build, Foundry is not V14.367, either client lacks
the normal registered runtime, the intended Player/active GM changes, or an unexpected prompt opens.
No QA block may replace Item use, authority coordination, the registered digital RollProvider, or
the persistence adapter. An unresolved failure requires diagnosis before a repair or another run.

## CONTINUE CONDITIONS

Both clients have reloaded the same milestone build. Use an empty active square-grid test Scene
with 5 ft per field, a visible level, Token Vision disabled, no walls/Regions/Tokens, no running
combat, and optional modules disabled. One active non-GM Player is chosen by ID. The GM remains
the active GM, and both clients view this Scene throughout the run.

Continue from Hit to Miss only after **both** GM and Player proofs pass. Each case requires a
real persisted embedded `WildPathItem`, native Token targeting, a real Foundry digital d20, and
matching authoritative completion/result IDs. All document mutations during execution must come
from the ordinary staged transaction. Preparation is allowed only before declaring a case.

# Production Action runtime live QA: persisted melee Hit/Miss

**LIVE QA PENDING.** Starting code baseline: `61d6268b838e286728c829924506c6c931174621`.
Baseline automated verification: 729/729. Automated tests and console-block parsing do not establish
live acceptance. Record the actual tested milestone commit and both client dumps when the maintainer
runs this gate. Movement/reaction live acceptance does not close this ordinary Action gate.

This is limited to melee Hit and Miss. Ranged attacks, saves, healing, conditions, areas, physical/manual
dice, reactions, movement, configuration choices, HUD/chat presentation, and content expansion remain
outside this gate.

## Confirmed production path

`module/documents/item.mjs` implements the real `WildPathItem#use()`. It builds an intent with
`buildFoundryActionUseIntent()` from the embedded Item, its Actor, and `game.user.targets`, then
calls `game.wildpath.executeActionIntent()`. It returns declaration success, not completion.

`registerFoundryV14MultiplayerResolution()` registers the active-GM coordinator, the
`system.wildpath` socket adapter, `createFoundryDigitalRollProvider()`, and
`createFoundryV14DocumentPersistenceAdapter()`. The GM's `foundryActionIntentToStagedOptions()`
resolves the synthetic Actor and Item UUIDs, reconstructs target Tokens/Actors, invokes the
TacticalGrid adapter, and snapshots `resolveActorAttackStatistic()` and authoritative AC.

The staged pipeline requests an attack roll. The coordinator routes the canonical `roll` pending
request to the initiating Player, whose registered provider evaluates `foundry.dice.Roll`.
The GM validates the correlated response, resolves the attack, plans damage/payment, and calls
`commitPlannedActionResult()` through the transaction and Foundry persistence adapter. A
`RESOLUTION_RESULT` envelope reaches the Player's `coordinator.getResult(resolutionId)` and
`notifications`. The GM retains `getRecord(resolutionId)` with stages and request expectations.

## Fixture and observation design

The companion [action-runtime-live-qa.mjs](action-runtime-live-qa.mjs) is imported only by the console
setup blocks. It is not registered by system startup and does not replace any runtime methods.
It creates two fresh world Actors (`character`), two unlinked one-field Tokens, and one persisted
`action` Item embedded in the **source synthetic Token Actor**. Both base Actors, both Tokens, and
the Item carry `flags.wildpath.actionRuntimeLiveQA` with one run ID and a role. Synthetic ActorDelta
data belongs to those marked Tokens. No existing Actor is edited. The test Scene itself is not created
or deleted by the helper.

The chosen Player owns the source; the target grants that Player observer permission. Resource
preparation uses the actual resource schema (`base`, `value`); HP starts at 30 and Action at 1.
The active Item contributes a persisted `attack.weapon` modifier of +4. Its ActionDefinition requires
one target, costs one Action, has 5 ft reach, and deals a fixed 6 slashing damage.

`AttackResolver` defaults make natural 1 a miss and natural 20 a hit regardless of AC. For this
marked QA Item only, the existing persisted `attack.policy` disables `naturalCriticalHits` and
`naturalCriticalMisses`. AC 1 guarantees Hit and AC 100 guarantees Miss for every real d20 result
with +4. This does not alter dice, global rules, providers, or production policy defaults. Critical
rules are not part of this gate. The fixture policy is translated by
`actionDefinitionToResolverInput()` and consumed by the ordinary attack-outcome stage.

Setup obtains grid-adjacent positions with Foundry grid APIs and verifies adjacency using the
WildPath adapter plus `footprintDistance()`. The actual GM record must independently contain both
footprints and a successful 5 ft range check. No intent receives manually supplied target refs,
roll totals, or modifiers from QA.

Read-only `game.socket.on("system.wildpath", ...)` and Socket.IO `onAnyOutgoing()` observers correlate
the exact source/Item/player/authority tuple. Both directions matter: Foundry V14.367 custom socket
broadcast excludes the sender. These APIs were inspected in the installed V14.367 source:
`client/documents/actor.mjs` (`getTokenDocument`), `common/grid/square.mjs`, `dist/server/sockets.mjs`
(`handleCustomSocket`), and `node_modules/socket.io-client/build/esm/socket.js`.

Every 100 ms, the helper inspects existing records/results; it never advances a resolution itself.
An error or 20-second timeout freezes the run and retains `wpActionRuntimeQA.lastDump` automatically.
Each dump includes the resolution/authority IDs, status/stages, requests/routing, roll provenance,
attack statistic/outcome/defense, target refs/footprints/range, mutation plans, transaction/commit,
errors, a trace tail, before/after HP/resource/base-Actor snapshots, and observed envelopes. The
Player also retains the terminal result envelope accepted by its coordinator. Arrays/strings/depth
are bounded with explicit truncation markers; assertions inspect the full contracts.

Each client has its own JS memory. The documented clipboard handoff combines the GM record and the
Player's received result in one `lastCombinedDump`, checking run, case, resolution, and user IDs.
This copies diagnostics only; it does not send or replay gameplay messages.

## 0. Preconditions — GM and PLAYER

Serve this branch's built system as `/systems/wildpath`, including this document's `.mjs` companion.
Reload both clients. Prepare the test Scene described above using Foundry's normal Scene UI and
activate/view it on both clients. Keep both browser consoles open with Preserve Log enabled.
Run the blocks below in numbered order. Every block is a complete new paste; the named QA object
holds explicit session state established by setup. Do not edit an earlier block.

## 1. GM — create persisted fixture and start observation

Choose the initiating Player's ID from the prompt's active-player list.

```js
{
  const {setupGM} = await import("/systems/wildpath/docs/development/action-runtime-live-qa.mjs");
  const players = [...game.users].filter(u => u.active && !u.isGM);
  const playerId = prompt("Initiating Player ID:\n" + players.map(u => `${u.id}: ${u.name}`).join("\n"));
  if (!playerId) throw new Error("STOP: Player ID is required; nothing created.");
  await setupGM(playerId.trim());
}
```

The console lists the created identities and run ID. Save the run ID for recovery cleanup.
Do not move either Token after creation.

## 2. PLAYER — observe the real runtime

```js
{
  const {setupPlayer} = await import("/systems/wildpath/docs/development/action-runtime-live-qa.mjs");
  const qa = setupPlayer();
  console.log("Player QA ready", qa.fixture);
}
```

## 3. GM — prepare Hit

```js
{
  const qa = globalThis.wpActionRuntimeQA;
  if (qa?.role !== "gm") throw new Error("Run GM setup first.");
  try { console.log(await qa.prepare("hit")); }
  catch (error) { throw qa.fail(error); }
}
```

## 4. PLAYER — native target selection and proof

Use Foundry's target tool (or the configured native target shortcut) on **QA melee target**. Clear
all other targets. This must populate `game.user.targets`; selecting/controlling the source is not
target selection.

```js
{
  const qa = globalThis.wpActionRuntimeQA;
  if (qa?.role !== "player") throw new Error("Run Player setup first.");
  try {
    const targets = [...game.user.targets].map(t => t.document);
    if (targets.length !== 1 || targets[0].id !== qa.fixture.targetTokenId)
      throw new Error("Use native targeting to target only QA melee target.");
    console.log("Native target proof", {token: targets[0].uuid, actor: targets[0].actor.uuid});
  } catch (error) { throw qa.fail(error); }
}
```

## 5. PLAYER — call the REAL embedded Item for Hit

```js
{
  const qa = globalThis.wpActionRuntimeQA;
  if (qa?.role !== "player") throw new Error("Run Player setup first.");
  try {
    qa.begin("hit");
    const sourceActor = canvas.scene.tokens.get(qa.fixture.sourceTokenId).actor;
    const action = sourceActor.items.get(qa.fixture.actionId);
    const declared = await action.use();
    qa.declared = declared;
    if (declared !== true) throw new Error("Item.use() declaration failed.");
    console.log("Hit declared", {declared, resolutionId: qa.resolutionId});
  } catch (error) { throw qa.fail(error); }
}
```

A digital roll may finish immediately. No manual roll or generic choice prompt is expected.
Do not call use twice or mutate HP/resources while waiting.

## 6. GM — Hit authoritative completion and persistence proof

```js
{
  const qa = globalThis.wpActionRuntimeQA;
  if (qa?.role !== "gm" || qa.mode !== "hit") throw new Error("Prepare and declare Hit first.");
  try { await qa.prove(); }
  catch (error) { throw qa.fail(error); }
}
```

Requires completed status, intended Player roll routing, `foundry-digital` provider and `digital`
method with serialized Foundry Roll terms, AC 1, Hit, source Action 1 → 0, target HP 30 → 24,
successful real persistence/transaction, and unchanged source **and target** base world Actors.
The GM's `hitDump` is retained independently before the next preparation.

## 7. PLAYER — Hit terminal-result delivery and persistence proof

```js
{
  const qa = globalThis.wpActionRuntimeQA;
  if (qa?.role !== "player" || qa.mode !== "hit") throw new Error("Declare Hit first.");
  try { await qa.prove(); }
  catch (error) { throw qa.fail(error); }
}
```

Requires the initiating Player's coordinator to have received the active GM's successful completed
result for the same resolution, with digital provenance, the Hit outcome, and replicated persistence.

## 8. GM then PLAYER — retain one combined Hit dump

**GM**, copy its retained evidence to the clipboard (DevTools `copy`):

```js
{
  const qa = globalThis.wpActionRuntimeQA;
  if (qa?.role !== "gm" || !qa.passed.hit) throw new Error("GM Hit proof has not passed.");
  copy(JSON.stringify(qa.hitDump));
}
```

**PLAYER**, paste the clipboard into the prompt:

```js
{
  const qa = globalThis.wpActionRuntimeQA;
  if (qa?.role !== "player" || !qa.passed.hit) throw new Error("Player Hit proof has not passed.");
  try {
    const combined = qa.attachGM(prompt("Paste the GM Hit dump JSON:"));
    if (!combined.gm.proofPassed || combined.gm.mode !== "hit") throw new Error("GM Hit proof is missing.");
    qa.hitCombinedDump = combined;
    console.log("PASS: complete Hit gate; preserve wpActionRuntimeQA.hitCombinedDump.");
  } catch (error) { throw qa.fail(error); }
}
```

## 9. GM — prepare Miss after both Hit proofs pass

```js
{
  const qa = globalThis.wpActionRuntimeQA;
  if (qa?.role !== "gm") throw new Error("Run GM setup first.");
  try { console.log(await qa.prepare("miss")); }
  catch (error) { throw qa.fail(error); }
}
```

This resets only the marked synthetic source Action and target HP before the new declaration, and
sets the target's AC to 100. It keeps the same persisted Item and attack modifier/policy.

## 10. PLAYER — native target proof for Miss

Use Foundry's normal target tool again if needed. Target only **QA melee target**.

```js
{
  const qa = globalThis.wpActionRuntimeQA;
  if (qa?.role !== "player" || !qa.hitCombinedDump) throw new Error("Complete both Hit proofs first.");
  try {
    const targets = [...game.user.targets].map(t => t.document);
    if (targets.length !== 1 || targets[0].id !== qa.fixture.targetTokenId)
      throw new Error("Use native targeting to target only QA melee target.");
    console.log("Native target proof", {token: targets[0].uuid, actor: targets[0].actor.uuid});
  } catch (error) { throw qa.fail(error); }
}
```

## 11. PLAYER — call the SAME real embedded Item for Miss

```js
{
  const qa = globalThis.wpActionRuntimeQA;
  if (qa?.role !== "player") throw new Error("Run Player setup first.");
  try {
    qa.begin("miss");
    const sourceActor = canvas.scene.tokens.get(qa.fixture.sourceTokenId).actor;
    const action = sourceActor.items.get(qa.fixture.actionId);
    const declared = await action.use();
    qa.declared = declared;
    if (declared !== true) throw new Error("Item.use() declaration failed.");
    console.log("Miss declared", {declared, resolutionId: qa.resolutionId});
  } catch (error) { throw qa.fail(error); }
}
```

## 12. GM — Miss authoritative completion and persistence proof

```js
{
  const qa = globalThis.wpActionRuntimeQA;
  if (qa?.role !== "gm" || qa.mode !== "miss") throw new Error("Prepare and declare Miss first.");
  try { await qa.prove(); }
  catch (error) { throw qa.fail(error); }
}
```

Requires a new resolution ID, one real digital roll routed to the Player, AC 100, Miss, Action
1 → 0, HP 30 → 30, completed transaction/state, and unchanged base world Actors.

## 13. PLAYER — Miss terminal-result delivery and persistence proof

```js
{
  const qa = globalThis.wpActionRuntimeQA;
  if (qa?.role !== "player" || qa.mode !== "miss") throw new Error("Declare Miss first.");
  try { await qa.prove(); }
  catch (error) { throw qa.fail(error); }
}
```

## 14. GM then PLAYER — retain one combined Miss dump

**GM**:

```js
{
  const qa = globalThis.wpActionRuntimeQA;
  if (qa?.role !== "gm" || !qa.passed.miss) throw new Error("GM Miss proof has not passed.");
  copy(JSON.stringify(qa.missDump));
}
```

**PLAYER**:

```js
{
  const qa = globalThis.wpActionRuntimeQA;
  if (qa?.role !== "player" || !qa.passed.miss) throw new Error("Player Miss proof has not passed.");
  try {
    const combined = qa.attachGM(prompt("Paste the GM Miss dump JSON:"));
    if (!combined.gm.proofPassed || combined.gm.mode !== "miss") throw new Error("GM Miss proof is missing.");
    if (combined.gm.resolutionId === qa.hitCombinedDump?.gm.resolutionId) throw new Error("Cases reused a resolution ID.");
    qa.missCombinedDump = combined;
    copy(JSON.stringify({hit: qa.hitCombinedDump, miss: qa.missCombinedDump}));
    console.log("PASS: both live cases. Save clipboard evidence and record the tested Git SHA before cleanup.");
  } catch (error) { throw qa.fail(error); }
}
```

## On any failure — GM and PLAYER retained diagnostics

Stop at the failing case. Run on **each client** to export its already-retained dump; do not invoke
the Action again. If a setup failed before observation started, the GM has cleanup IDs in
`wpActionRuntimeQASetup` and the console's setup error. No HP/resource reset is part of failure capture.

```js
{
  const qa = globalThis.wpActionRuntimeQA;
  const dump = qa?.lastDump ?? globalThis.wpActionRuntimeQASetup;
  if (!dump) throw new Error("No QA session evidence exists on this client; save the setup console error.");
  console.log(JSON.stringify(dump, null, 2));
  copy(JSON.stringify(dump));
}
```

When both dumps have the same non-null resolution ID, **PLAYER** can combine the GM's exported
failure dump with its local evidence in one object:

```js
{
  const qa = globalThis.wpActionRuntimeQA;
  if (qa?.role !== "player") throw new Error("Run on the initiating Player.");
  qa.attachGM(prompt("Paste the GM failure dump JSON:"));
  copy(JSON.stringify(qa.lastCombinedDump));
}
```

Before a resolution ID exists, preserve the two setup/declaration dumps separately. Missing identity
is diagnostic evidence, not permission to guess a matching result. No API/runtime changes are
authorized merely because this gate fails; demonstrate the root cause before repairing it.

## 15. Cleanup — PLAYER, then GM

Save both case dumps first. For a failed, timed-out, or nonterminal Action, export diagnostics and
reload **both** clients before cleanup so a pending response cannot resume against deleted fixtures.
Cleanup may then use the exact saved run ID. Do not manually resume the failed resolution.

**PLAYER** — detach only QA listeners and retain the evidence:

```js
{
  const qa = globalThis.wpActionRuntimeQA;
  if (qa && qa.role !== "player") throw new Error("Run on the Player.");
  if (qa) {
    qa.detach();
    globalThis.wpActionRuntimeQAArchive = {hit: qa.hitCombinedDump ?? qa.hitDump,
      miss: qa.missCombinedDump ?? qa.missDump, last: qa.lastCombinedDump ?? qa.lastDump};
    delete globalThis.wpActionRuntimeQA;
  }
}
```

**GM** — delete only Documents carrying the exact QA run marker, including partial setup:

```js
{
  const {cleanupGM, QA_FLAG} = await import("/systems/wildpath/docs/development/action-runtime-live-qa.mjs");
  const runs = [...new Set([...game.actors].map(a => a.getFlag("wildpath", QA_FLAG)?.runId).filter(Boolean))];
  const runId = globalThis.wpActionRuntimeQA?.fixture.runId ?? globalThis.wpActionRuntimeQASetup?.runId
    ?? prompt("Exact saved QA run ID to remove (marked runs: " + runs.join(", ") + "):");
  await cleanupGM(runId);
}
```

Cleanup removes the marked Tokens and their synthetic Actor/Item data, then the marked base Actors;
it removes only its own socket observers. It does not clear coordinator records or mutate unrelated
Documents. The maintainer may delete the empty test Scene through normal Foundry UI later.

## Acceptance record

Until the maintainer has run and supplied both Hit and Miss evidence, status remains
**LIVE QA PENDING**. Record Foundry build, tested milestone SHA, GM/Player IDs, both resolution IDs,
provider/method/source, natural/total/modifier/AC/outcome, HP/resource deltas, base-Actor isolation,
and the combined dumps. Do not infer acceptance from Node tests, a successful declaration, or only
one completed case.
