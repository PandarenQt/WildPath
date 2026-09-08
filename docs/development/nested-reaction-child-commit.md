# Nested reaction child commit reproduction (V14.367)

This document records the automated boundary reproduction that preceded the successful multiplayer
live gate. The complete Foundry V14.367 gate subsequently passed on repair commit
`ddb26f6591c95db9b5dc21a856d3bfa5f15f90e4`.
The historical failed child state was discarded, so its original exception cannot be recovered.
The baseline is `1ed4425d7dbcf84521f583ee169aaabe91f29d36` on `milestone/movement-reactions`.

## Demonstrated failures, in execution order

The guide's self-targeting reaction includes an Actor ID and a Token ID, and its document map is
keyed by the synthetic Actor's ID and UUID. Replaying that exact shape reaches `ready-to-commit`.

1. **Target operation preparation fails first.** The condition mutation holds a `TargetCandidate`:
   its outer `id` is the Token ID, while `target.actorId` is the Actor ID. Commit lookup previously
   consumed the outer candidate as a document reference. The supplied Actor could not be found:
   `MUTATION_COMMIT_FAILED` / `targetOperations.code: TARGET_ACTOR_NOT_FOUND`. No transaction
   operation had executed, so there is no `transaction.commitFailure` at this point.
2. **After fixing that binding, the condition operation fails.** Startup previously assigned
   `Object.values(WILDPATH.CONDITIONS).map(...)` to `CONFIG.statusEffects`. Installed Foundry
   V14.367 reads `CONFIG.statusEffects[statusId]` in both `Actor.toggleStatusEffect()` and
   `ActiveEffect.fromStatusEffect()`. The plain array has no `prone` key. Executing the installed
   Actor method through the ordinary nested commit returns:

   ```text
   child ready-to-commit
   -> target:0:conditionEffect (role targetMutation) failed
   -> Invalid status ID "prone" provided to Actor#toggleStatusEffect
   -> source:0:resourcePayment never executed
   -> transaction COMMIT_FAILED, committed [], rollbacks []
   ```

Both defects reproduce with an empty Actor effects collection. Neither depends on an existing
Prone effect or a boolean return from a successful status toggle.

## Repairs

- `mutationTargetIdentity()` unwraps the candidate's existing target reference at the target
  commit boundary. Planning, target selection, and mutation payloads are unchanged. The supplied
  runtime synthetic Actor remains the document used by the transaction.
- `registerFoundryV14ConditionStatuses()` registers WildPath's existing condition set by ID,
  preserving Foundry's registry instance. The previous replacement of the default status set is
  intentional and remains in effect. The installed registry is a compatibility Proxy that supports
  enumeration as well as ID lookup; replacing it with a plain array destroys that lookup.

The existing condition persistence adapter now receives an ActiveEffect on creation and updates
its lifecycle metadata. Source payment uses `Actor.update()` with
`system.resources.reaction.value: 0`. No second commit engine, return-value workaround, rollback
relaxation, or change to parent failure policy is needed.

## Retained diagnostics

`results.reactions[].childOutcome` is captured inside generic reaction child completion before
`metadata.activeChildResolution` is cleared. It is present for failed and cancelled children,
including under `continue` and `cancel-parent` policies. Repeated completion remains idempotent.

Example subset for a forced source-payment failure:

```json
{
  "childStatus": "failed",
  "failedStageId": "action.commit",
  "code": "RESOURCE_COMMIT_FAILED",
  "reason": "Synthetic reaction payment rejected",
  "transaction": {
    "code": "COMMIT_FAILED",
    "commitFailure": {
      "code": "COMMIT_FAILED",
      "reason": "Synthetic reaction payment rejected",
      "operation": {
        "id": "source:0:resourcePayment",
        "type": "resourcePayment",
        "actorRef": "Scene.qa-scene.Token.qa-token.Actor.qa-actor",
        "status": "failed",
        "metadata": {"role": "sourcePayment"}
      }
    },
    "rolledBack": true
  }
}
```

The full summary also retains the child ID, projected errors, trace tail, action-result status/code,
target preparation failures when present, committed operation summaries, rollback summaries, and
transaction failures. Rollback failures retain their existing `ROLLBACK_FAILED` codes in `failures`.
Each list is limited to eight entries and each string to 1,024 characters. Arbitrary nested payloads,
trace data, document objects, functions, Error instances, and the full child state are excluded.

## Reproduction and regression coverage

`test/foundry-nested-reaction-commit.test.mjs` uses the production document persistence adapter with
Actor/ActiveEffect-shaped methods and document return values. The source and target are an unlinked
Token's synthetic Actor, distinct from a world Actor with the same ID. Resources include the actual
`base`, `bonus`, `max`, `value`, and `recovery` fields. The tests cover condition-only and payment-only
commits, the combined child, rollback after payment failure, rollback failure reporting, cancellation,
preflight diagnostics, and unchanged world Actor resources/effects.

The combined cases run through `resolveTriggeredEvent()` -> `TriggeredEventHost` -> `ReactionResolver`
-> child `ResolutionState` -> multiplayer coordinator -> staged execution -> normal transaction.
Transport messages and retained parent states are checked for plain serializability.

To also execute the installed V14 Actor method and registry Proxy without redistributing Foundry
source, set the installation's application directory before running the suite:

```powershell
$env:FOUNDRY_V14_APP_PATH = 'C:\Program Files\Foundry Virtual Tabletop\resources\app'
npm.cmd test
```

Those two tests are explicitly skipped when the environment variable is absent. They execute the
installed method with controlled document persistence collaborators; they do not boot a Foundry
world, database, canvas, or two connected browser clients. The installation inspected for this repair
declares generation 14, build 367. Runtime sources: `client/documents/actor.mjs` (status toggle),
`client/documents/active-effect.mjs` (status construction), and `client/config.mjs` (status registry).
The public [Actor API](https://foundryvtt.com/api/v14/classes/foundry.documents.Actor.html#togglestatuseffect)
also documents status-toggle return values.

The QA route tests execute all three fresh guide route generators with square and both hex
orientations. They verify decreasing X, deterministic tie-breaking, adjacency, and Large-hex
three-field footprints with two left, two entered, and one retained.

The complete [GM/Player Decline, Accept, and Terminate blocks](movement-reaction-qa.md) passed after
both clients refreshed onto the repair commit. They remain the repeatable regression runbook.

## Verification on the repair

- `npm test`: 729/729 passed, including the two installed-runtime tests (no skips), up from 714.
- `npm run build` and `npm run typecheck`: passed; no lint script is configured.
- All three new `.mts`/`.mjs` pairs match a fresh build.
- All 22 GM/Player console blocks parse; leftward route/footprint regressions pass.
- Working and staged diff whitespace checks passed.

On this Windows host the commands use `npm.cmd` because PowerShell blocks the unsigned `npm.ps1`
shim. That runs the same configured npm scripts without changing execution policy.

## Live verification after the repair

Real Foundry V14.367 multiplayer verification: **PASS** on
`ddb26f6591c95db9b5dc21a856d3bfa5f15f90e4`.

Decline and Accept resumed from the verified first-transition prefix and completed two transitions.
Terminate committed its ordinary nested Action and then stopped at B through `cancel-parent`, leaving
one transition unexecuted. The live run covered active-GM authority, the real player prompt, a
player-owned synthetic Large-hex Token Actor, real pause/resume/stop behavior, real ActiveEffect and
reaction-resource persistence, and completed-prefix accounting. The base world Actor remained
unchanged in every case.
