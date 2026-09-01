# WildPath — Foundry V14 Authoritative Token Movement Vertical Slice

## Real Token Movement → MovementPath → Active-GM Authority → Budget Commit

Assume you have **no prior conversational context**.

The repository is authoritative.

WildPath now has a pure topology-aware MovementPath foundation, but it does not yet govern actual Foundry Token movement.

This milestone must connect **normal real Foundry Token movement** to the existing WildPath movement mechanics without creating a second movement engine, a second multiplayer architecture, or a parallel spatial model.

The target vertical flow is:

```text
Player moves Token in Foundry
↓
Foundry finalizes the proposed movement path
↓
WildPath Foundry adapter
↓
plain Movement intent
↓
active-GM authority
↓
authoritative Scene / Token reconstruction
↓
Foundry TacticalGrid adapter
↓
MovementPath
↓
route legality + route cost + affordability
↓
approve / reject
↓
Foundry performs approved Token movement
↓
authority records actual completed movement
↓
ordinary Movement budget committed exactly once
```

This is a **runtime integration milestone**.

Do not turn it into persistent Areas, opportunity attacks, terrain rules, auras, hazards, or a Movement Engine rewrite.

---

# 1. Expected Baseline

Expected HEAD:

```text
1ab0a41 Add topology-aware movement paths
```

Reported baseline after that milestone:

```text
509 / 509 tests passing
npm run typecheck passing
git diff --check passing
main aligned with origin/main
```

Verify everything yourself:

```bash
git status
git branch --show-current
git rev-parse HEAD
git log --oneline --decorate -15
git fetch

npm test
npm run typecheck
git diff --check
```

Do not modify unrelated local files.

---

# 2. Read Governance First

Read and obey:

* `AGENTS.md`
* `CLAUDE.md`
* `CODEX.md`
* `ARCHITECTURE.md`
* `CORE_AUTOMATION_FOUNDATION.md`
* `developmentStrat.md`
* `docs/development/reference-systems.md`

Then inspect the current source for:

* `movement.mjs`
* `movement-paths.mjs`
* TacticalGrid
* Foundry TacticalGrid adapter
* Actor/Token Document classes
* Action Economy
* multiplayer authority
* system socket transport
* persistence/transactions
* existing Foundry runtime setup
* tests exercising production Action entry

Do not rely on this prompt for contracts already defined in source.

---

# 3. Current Movement Authorities

Preserve these ownership boundaries.

## `movement.mjs`

Owns:

```text
movement capability
movement budget
measurement mode
movement affordability/spending
voluntary / forced / teleport budget semantics
```

## `movement-paths.mjs`

Owns:

```text
ordered MovementPath
anchors include origin
complete-footprint reconstruction
square/hex topology
route validity
per-step route cost
occupancy/transition policy seams
valid vs affordable distinction
```

## TacticalGrid

Owns:

```text
mechanical grid geometry
GridField
TokenGridFootprint
square/hex topology
```

## Foundry

Owns:

```text
Token interaction
waypoint UI
path planning
animation
Document movement workflow
Scene/Token persistence
core movement lifecycle
```

Do not duplicate any of these responsibilities.

---

# 4. Reference Roles

For this milestone:

```text
Crucible
→ PRIMARY practical Foundry-native implementation benchmark

Official Foundry V14 docs
→ AUTHORITATIVE API/lifecycle contract

local PF2e checkout
→ secondary rules/movement prior art only

WildPath
→ mechanical and architectural authority
```

This is specifically a milestone where Crucible should be studied deliberately.

---

# 5. Crucible Research Policy

Inspect current public Crucible source to answer concrete questions about:

* TokenDocument movement lifecycle;
* movement proposal/planning;
* drag movement;
* movement affordability checks;
* planned movement;
* post-movement accounting;
* use of `Token#planMovement`;
* use of `TokenDocument#startMovement`;
* movement IDs;
* Foundry movement operation data;
* how movement actions remain distinguishable from actual movement.

Do NOT copy Crucible code.

Do NOT rename/adapt Crucible functions.

Record conceptual findings only.

Relevant Crucible areas currently include concepts such as:

```text
module/documents/token.mjs
module/canvas/movement.mjs
module/canvas/token-ruler.mjs
movement-related action usage
```

Use targeted searches.

---

# 6. Mandatory Foundry V14 Verification

Verify every Foundry API/lifecycle point used by the implementation against **current official V14 documentation**.

The current official V14 documentation should be treated as authoritative.

Important APIs/concepts to investigate include:

```text
TokenDocument#move
TokenDocument#movement
TokenDocument#getCompleteMovementPath
TokenDocument#measureMovementPath
TokenDocument#startMovement
TokenDocument#pauseMovement
TokenDocument#resumeMovement
TokenDocument#stopMovement

Token#planMovement

TokenDocument#_preUpdateMovement
TokenDocument#_onUpdateMovement

preMoveToken
moveToken
planToken
pauseToken
stopToken

TokenPreMovementOperation
TokenMovementOperation
TokenMovementWaypoint
TokenMeasuredMovementWaypoint
TokenMovementSectionData
```

Do not assume method signatures from this prompt.

Verify current V14 signatures.

---

# 7. Important Confirmed Foundry Lifecycle Constraint

Reconfirm this before designing the integration:

`preMoveToken` is a cancellable hook, but Foundry hooks are not awaited.

Therefore:

```text
preMoveToken
```

must NOT become an asynchronous:

```text
player
→ socket
→ GM
→ await approval
```

authority boundary.

Current V14 instead exposes:

```text
TokenDocument#_preUpdateMovement(...)
```

as an asynchronous Document lifecycle method.

Official docs describe it as running after the movement has been determined, with final waypoints, and allowing the movement to be rejected entirely.

If current docs still confirm this:

**prefer the TokenDocument lifecycle seam over trying to await inside `preMoveToken`.**

This is exactly the kind of Foundry implementation lesson Crucible is useful for benchmarking.

---

# 8. Do Not Blindly Copy Crucible's Rules

Crucible currently uses Foundry movement costs as part of its own movement/action logic.

WildPath must not therefore conclude:

```text
movement.passed.cost + movement.pending.cost
= WildPath mechanical cost
```

without analysis.

WildPath's mechanical cost authority is:

```text
Foundry path
↓
MovementPath
↓
evaluateMovementPath()
```

Foundry's measured:

```text
cost
distance
spaces
```

may be useful:

* for diagnostics;
* path interpretation;
* terrain integration;
* future UX comparison;

but must not silently replace WildPath route evaluation.

---

# 9. Core Foundry → WildPath Adapter

Implement the smallest Foundry-facing adapter that converts a finalized Foundry movement operation into a plain WildPath movement proposal.

Conceptually:

```text
TokenDocument
+
TokenPreMovementOperation
+
Scene
↓
Foundry movement adapter
↓
plain MovementIntent
```

No Foundry objects may cross the multiplayer boundary.

---

# 10. Movement Intent

Create the smallest plain serializable contract required for authority routing.

It will likely need some subset of:

```text
movementId
sceneRef
tokenRef
actorRef
sourceUserId
movementKind
movementMode
waypoint/path data
metadata
```

Do not force this exact structure.

It should contain stable references and plain movement proposal data.

It must NOT contain:

* TokenDocument;
* ActorDocument;
* Scene;
* Grid;
* functions;
* Promises;
* Foundry movement objects;
* Sets/Maps.

---

# 11. Authoritative Origin

Never trust a client-supplied origin as mechanical authority.

The active GM must reconstruct the current:

```text
Scene
Token
Actor
Token position
Token size
Movement capability
```

from authoritative Foundry state.

Client path data is a request.

---

# 12. Foundry Waypoints → Complete Ordered Route

A major concern is that user-provided waypoints may represent segment endpoints rather than every traversed grid field.

WildPath MovementPath requires ordered mechanical transitions.

Investigate and use the appropriate current Foundry V14 facility.

Current V14 exposes a concept equivalent to:

```text
TokenDocument#getCompleteMovementPath(waypoints)
```

which expands direct segments with intermediate movement steps.

Verify its current behavior.

Use it if it is the correct public API.

Do NOT independently rasterize pixel line segments if Foundry already supplies the complete movement path.

---

# 13. Pixel Coordinates Must Stop at the Adapter

Foundry waypoints use canvas/token positions.

WildPath MovementPath uses mechanical grid anchors.

Required conceptual translation:

```text
Foundry waypoint
x/y/elevation/etc.
↓
Foundry TacticalGrid adapter
↓
GridField anchor
```

No pixel coordinates belong in MovementPath.

---

# 14. Origin Convention

WildPath's canonical convention is:

```text
anchors includes origin
```

Therefore if Foundry supplies:

```text
origin
waypoints = [B, C, D]
```

the adapter should produce:

```text
[A, B, C, D]
```

after proper mechanical conversion.

Do not duplicate the origin if Foundry's expanded path already contains it.

Test this explicitly.

---

# 15. Full Footprint Remains WildPath Authority

The adapter should resolve the moving Token through the existing TacticalGrid adapter.

MovementPath must reconstruct:

```text
Medium square
Large square
Large hex
etc.
```

using existing footprint definitions.

Do not use Token center-to-center movement legality.

Do not make Foundry's rectangular pixel bounds the mechanical footprint authority.

---

# 16. Source Token Ambiguity Is Not Relevant Here

Unlike Actor Action use, movement already originates from a specific TokenDocument.

Use that Token as the explicit source.

Do not search Actor active tokens and guess which Token moved.

---

# 17. Movement Kind

Support at minimum:

```text
voluntary
```

for normal Token movement.

Preserve existing:

```text
forced
teleport
```

semantics where there is already a clean way for WildPath-initiated movement to identify them.

Do NOT identify forced movement by copying Crucible-specific names such as:

```text
"push"
```

unless WildPath itself deliberately defines that mapping.

Prefer explicit WildPath movement metadata/policy.

---

# 18. Movement Mode

Movement kind and mode remain separate.

Examples:

```text
kind: voluntary
mode: walk
```

Potential later:

```text
kind: voluntary
mode: fly

kind: forced
mode: walk

kind: teleport
mode: teleport
```

Use existing Actor movement capability/mode data.

Do not implement complete flying/swimming/climbing rules here.

---

# 19. Production Entry Must Be Real Token Movement

This milestone must not create only:

```text
game.wildpath.testMovement(...)
```

and call that integration.

The normal Foundry Token movement lifecycle must actually reach WildPath.

Preferred shape, if confirmed appropriate:

```text
WildPathTokenDocument#_preUpdateMovement()
↓
MovementIntent
↓
authority
↓
approve/reject
```

Do not depend solely on a test-only manual adapter call.

---

# 20. Active-GM Authority

Reuse the **existing multiplayer authority infrastructure**.

Do NOT create:

```text
system.wildpathMovement
```

as a second socket namespace.

Do NOT duplicate:

* user directory logic;
* active GM selection;
* stale-response protection;
* wrong-user rejection;
* transport abstraction;
* request identity;
* result/error routing.

Extend/reuse the existing system transport.

---

# 21. Do Not Force Movement Into ActionResolution

Movement is not necessarily an ActionDefinition.

Do not fake movement as an Action merely to reuse `MultiplayerActionCoordinator`.

Reuse common authority/transport primitives, but preserve domain semantics.

If a tiny Movement-specific orchestration helper is needed, that is acceptable.

A giant:

```text
MovementCoordinator
MovementManager
MovementEngine
```

is not.

---

# 22. Authority Approval Flow

For a player-owned voluntary movement, target behavior:

```text
player Token reaches _preUpdateMovement
↓
final Foundry waypoints are available
↓
build plain MovementIntent
↓
send to active GM
↓
GM reconstructs Scene/Token/Actor
↓
convert to MovementPath
↓
evaluateMovementPath
↓
derive current movement budget
↓
approve / deny
↓
player lifecycle continues or returns false
```

The active GM decides legality and affordability.

The player does not send:

```text
valid=true
cost=20
affordable=true
```

as trusted authority.

---

# 23. No Active GM

Preserve the project's established no-active-GM behavior.

Inspect the current multiplayer policy.

Do not invent a new fallback specific to Movement.

If actions currently fall back to local authority under defined circumstances, Movement should follow the same policy unless there is a concrete reason not to.

---

# 24. Player Ownership / Permissions

Respect Foundry's own Token ownership checks.

WildPath authority should decide **rules legality**, not replace Foundry permission enforcement.

Do not allow movement of a Token Foundry itself says the user cannot move.

---

# 25. Reject Invalid Movement Before Commit

If authoritative evaluation returns:

```text
valid = false
```

or:

```text
affordable = false
```

the originating Foundry movement must not occur.

Return/prevent the movement through the correct Document lifecycle.

Provide a useful notification/error surface.

Do not silently snap to some cheaper path in this milestone.

---

# 26. Do Not Mutate Final Foundry Waypoints in Pre-Movement

Current V14 documentation indicates that by `_preUpdateMovement`, the waypoints are final and movement can only be accepted or rejected.

Respect that contract.

Do not mutate them through unsupported internals.

---

# 27. Movement Budget Must Not Be Spent Merely for Proposal

This invariant is mandatory:

```text
movement proposed
≠
movement completed
```

Do not spend ordinary Movement budget just because authority approved a proposal if the subsequent Foundry movement can still be prevented or fail.

---

# 28. Post-Movement Commit

After actual successful Foundry movement, commit the appropriate ordinary Movement spend **exactly once** through the active authority.

Use Foundry post-movement data and movement ID to correlate:

```text
approved movement
↔ actual movement
```

Investigate current:

```text
TokenDocument#_onUpdateMovement
moveToken
TokenMovementOperation
movement.id
passed
pending
finished
```

and choose the smallest correct lifecycle seam.

---

# 29. Commit Timing Must Be Explicit

Determine from current Foundry V14 behavior whether:

```text
_onUpdateMovement
moveToken
movement.finished
```

represents the right point to commit actual Movement spending.

Do not guess.

Document the decision.

The critical invariants are:

```text
rejected move
→ no spend

successful move
→ spend exactly once
```

---

# 30. Do Not Trust Client Cost at Commit

When committing movement budget, the active GM should correlate the actual movement with the authority-approved movement and/or reconstruct the actual route.

Do not accept:

```text
client says cost = 20
```

as authoritative.

---

# 31. Movement ID / Idempotency

Use Foundry movement identity where appropriate.

The same movement completion observed more than once must not spend twice.

Mandatory regression:

```text
same movementId completion delivered twice
→ one budget spend
```

---

# 32. Wrong Movement / Stale Approval

An approval for:

```text
movementId X
Token A
Scene S
```

must not authorize:

```text
movementId Y
Token B
different path
different Scene
```

Bind approvals to appropriate stable identity.

Reject stale or mismatched data.

---

# 33. Changed Authoritative State

Between client planning and GM evaluation:

* Token may have moved;
* Movement budget may have changed;
* Scene may have changed;
* Token size may have changed.

The GM reconstruction is authoritative.

If the proposal no longer starts at the Token's actual origin:

reject it.

Do not silently reinterpret it.

---

# 34. MovementPath Evaluation

The authoritative side must call the real existing:

```text
createMovementPath()
evaluateMovementPath()
```

or the canonical equivalent from `movement-paths.mjs`.

Do not reconstruct Movement legality in the Foundry adapter.

---

# 35. Budget Integration

Use the current movement capability/budget system.

Do not create:

```text
token.flags.wildpath.movementUsed
actor.system.movementUsed
remainingMovement
```

as new duplicate authority.

MovementPath evaluates cost.

`movement.mjs` owns budget/spend semantics.

---

# 36. Forced Movement

If cleanly supportable in this slice:

```text
forced movement
→ validate topology
→ no ordinary Movement spend
```

Do not require active Movement budget.

If production forced movement currently has no real entry path, preserve the contract and defer the Foundry-producing feature.

Do not invent a named push feature.

---

# 37. Teleport

Likewise:

```text
teleport
→ non-adjacent route semantics allowed
→ destination footprint validation
→ no ordinary Movement spend
```

Do not make ordinary drag become teleport merely because Foundry gave a non-adjacent segment.

---

# 38. Foundry Terrain / Cost

Do NOT implement terrain rules yet.

Foundry exposes terrain and movement-cost machinery.

WildPath also has a `stepCostPolicy`.

For this milestone:

* understand the available V14 terrain/cost data;
* preserve a clear future seam;
* do not blindly make Foundry cost authoritative;
* do not duplicate Foundry terrain pathfinding.

If existing Foundry data can cleanly feed the existing WildPath `stepCostPolicy`, document the future mapping.

Implementation may defer it.

---

# 39. Walls / Core Path Constraints

Foundry should continue to own its normal canvas/path constraints.

Do not rebuild wall collision in WildPath.

Conceptually:

```text
Foundry
→ determines actual proposed/complete path through canvas constraints

WildPath
→ determines whether that mechanical route is legal/affordable under WildPath rules
```

If Foundry already constrained a path, WildPath validates the resulting path.

---

# 40. Ordinary Drag Is the Required First Slice

Prioritize:

```text
normal voluntary Token drag
```

over building a custom movement UI.

The user should not need a special developer command to exercise the integration.

---

# 41. Planned Movement

Also investigate Foundry's current:

```text
Token#planMovement()
TokenDocument#startMovement()
planToken
```

Crucible uses planned movement for Actions involving movement.

Do not necessarily implement full WildPath planned-action movement now.

But design the adapter so the same path translator can later consume planned movement without a parallel representation.

Document the seam.

---

# 42. Do Not Build HUD Yet

No BG3-style Movement HUD in this milestone.

A warning/notification for:

```text
movement invalid
movement unaffordable
```

is enough.

---

# 43. No Movement Reactions Yet

Do NOT implement:

* opportunity attacks;
* Sentinel;
* movement-triggered reactions;
* leave-reach events.

Those require ordered execution/interruption and are a later slice.

---

# 44. No Persistent Areas Yet

Do NOT implement:

* auras;
* emanations;
* persistent hazards;
* Region-triggered damage.

However, do not interfere with Foundry's normal Region movement lifecycle.

Foundry V14 already exposes movement-related Region events.

Preserve compatibility.

---

# 45. No Pause/Resume Rules Yet

Foundry V14 supports paused movement.

Do not build WildPath reaction interruption yet.

But do not design movement bookkeeping such that paused/partial movement is impossible to support later.

Keep movement identity and actual path information.

---

# 46. Undo / Movement History

Investigate Foundry's movement history/revert APIs enough to understand the consequence for WildPath budget accounting.

Do NOT implement full undo/refund unless it is trivial and necessary for correctness of this slice.

If undo currently causes budget drift, explicitly document it as the next required follow-up before production use.

Do not hide the limitation.

---

# 47. Synthetic Token Actors

TokenDocument may expose a synthetic Actor.

Use the actual moving Token's:

```text
token.actor
```

where appropriate.

Do not assume every Token maps to a linked world Actor.

Movement budget/accounting must work for:

```text
linked Token Actor
synthetic Token Actor
```

to the extent current persistence infrastructure supports them.

If persistence lacks synthetic-Actor support, report it rather than silently updating the wrong Actor.

---

# 48. Production-Entry Test Requirement

Mandatory.

At least one test must begin at the actual production movement lifecycle boundary.

Not merely:

```text
evaluateMovementPath(...)
```

and not merely:

```text
foundryMovementToMovementPath(...)
```

The regression should fail if real Token movement stops reaching the WildPath authority path.

---

# 49. Required Test — Medium Square Voluntary Move

Simulate realistic Foundry movement:

```text
Token at A
waypoints to B → C
```

Expected:

```text
_preUpdateMovement
→ MovementIntent
→ GM authority
→ MovementPath [A,B,C]
→ valid
→ affordable
→ movement allowed
→ completion
→ budget spent once
```

---

# 50. Required Test — Unaffordable Move

Example:

```text
budget = 30 ft
proposed route = 35 ft
```

Expected:

```text
movement prevented
Token destination unchanged
budget unchanged
```

---

# 51. Required Test — Invalid Topology

A finalized proposal producing an invalid WildPath route:

```text
ordinary A → C non-adjacent transition
```

must be rejected unless Foundry's complete-path expansion correctly supplies the intermediate field.

This test should also verify that the adapter is using the complete route rather than endpoint distance.

---

# 52. Required Test — Foundry Intermediate Path Expansion

Give Foundry-style segment waypoints that do not enumerate every mechanical step.

Verify production conversion uses the appropriate Foundry complete-path facility and produces:

```text
[A,B,C,D,...]
```

rather than:

```text
[A,D]
```

when intermediate grid transitions exist.

---

# 53. Required Test — Large Square

A Large Token movement must reconstruct and validate its complete 2×2 footprint.

Do not regress to anchor-only legality.

---

# 54. Required Test — Hex

At least one real Foundry-adapter hex route.

No square-only translation assumptions.

---

# 55. Required Test — Duplicate Completion

Deliver the same successful movement completion twice.

Expected:

```text
Movement budget spent once
```

---

# 56. Required Test — Rejected Move No Spend

Authority rejects the proposal.

Then even if some completion callback/hook fixture is incorrectly emitted:

do not spend without a valid approval record.

---

# 57. Required Test — Wrong User / Wrong Token / Stale ID

Exercise existing security conventions.

A different user must not be able to reuse another movement's approval/result.

---

# 58. Required Multiplayer Production Test

At minimum:

```text
player
→ real production movement boundary
→ active GM
→ authoritative Token/Scene reconstruction
→ MovementPath evaluation
→ approval
→ successful movement accounting
```

Do not manually bypass the socket/transport seam inside this regression.

---

# 59. No New Socket Namespace

Audit after implementation:

```text
system.wildpath
```

should remain the canonical system socket.

Do not add a movement-specific socket channel.

---

# 60. Foundry Objects Must Not Cross Socket

Mandatory serialization assertion.

Movement intent/result envelopes must survive JSON round-trip.

No:

* TokenDocument;
* Scene;
* Actor;
* Grid;
* TokenMovementOperation object;
* Promise;
* function.

---

# 61. Architecture Reuse Audit

Before committing, verify that you have NOT created:

```text
MovementEngine
MovementManager
MovementService
MovementRegistry
second TacticalGrid
second Action Economy
second socket transport
second authority system
```

A thin Foundry adapter/runtime helper is fine.

---

# 62. Crucible Comparison Report

In the completion report include only conceptual comparison:

```text
CRUCIBLE OBSERVATION
...

FOUNDRY V14 VERIFICATION
...

WILDPATH DECISION
...
```

Examples worth investigating:

* async TokenDocument movement pre-processing;
* post-move accounting;
* planned movement;
* Foundry movement IDs;
* Foundry's own path/cost data.

Do not paste Crucible code.

---

# 63. Foundry API Report

List every Foundry V14 API/lifecycle point the implementation actually relies on.

For each classify:

```text
public
protected/subclass lifecycle
hook
data interface
```

If a protected override is used, explain why that is the appropriate system integration point and why a public hook is insufficient.

---

# 64. Manual Live QA

If a live Foundry V14 environment is available, perform:

## GM-only

1. Create Actor with movement budget.
2. Place Token.
3. Drag Token within budget.
4. Confirm Token moves.
5. Confirm budget changes once.
6. Try route beyond budget.
7. Confirm movement is rejected.

## Player + GM

1. Player owns Token.
2. Player drags Token.
3. Active GM authoritatively validates.
4. Movement succeeds.
5. Both clients agree.
6. Budget changes once.

## Large Token

Move a Large Token and verify topology behavior.

## Hex

Perform one hex movement.

Record exact Foundry V14 build.

If unavailable:

```text
Live Foundry Movement QA not performed.
```

Do not fabricate it.

---

# 65. Existing Melee Live-QA Debt

The combat production path still lacks reported manual live Foundry QA.

Do not fix combat code here.

In the completion report preserve this known gate:

```text
Melee runtime:
automated production-entry proof exists
manual Foundry QA still required unless performed separately
```

---

# 66. Documentation

Update relevant architecture docs with:

* Foundry movement lifecycle entry;
* Foundry waypoint → MovementPath conversion;
* authority boundary;
* movement approval identity;
* post-movement accounting;
* Foundry vs WildPath cost authority;
* current forced/teleport support;
* known interruption/undo limitations;
* planned movement future seam.

Do not mark:

```text
Movement complete
```

if reactions/interruption/terrain/Areas are still absent.

Preferred status:

```text
Foundry Token movement vertical slice implemented
```

if genuinely proven.

---

# 67. Verification

Run:

```bash
npm test
npm run typecheck
git diff --check
```

Expected starting suite:

```text
509 tests
```

Final suite should increase.

Also search for:

* direct Token `update({x,y})` introduced by this milestone;
* new socket namespaces;
* client-trusted movement cost;
* Foundry objects in envelopes;
* duplicate movement budget state.

---

# 68. Commit and Push

If successful:

commit coherently.

Suggested message:

```text
Integrate Foundry token movement
```

or another precise equivalent.

Then:

```bash
git push origin main
```

Do not leave the milestone only locally.

---

# 69. Required Completion Report

Return:

## Repository Baseline

* starting SHA;
* branch;
* origin status;
* starting tests/typecheck/diff-check.

## Foundry V14 Research

Report relevant current API findings.

## Crucible Review

Use:

```text
CRUCIBLE OBSERVATION
FOUNDRY V14 VERIFICATION
WILDPATH DECISION
```

## Architecture Decision

Explain the smallest runtime seam chosen.

## Production Entry

Show the real player-facing flow.

## Movement Intent

Show its plain-data shape.

## Waypoint Conversion

Show:

```text
Foundry path
→ complete Foundry route
→ TacticalGrid anchors
→ MovementPath
```

## Authority

Show:

```text
player request
→ active GM reconstruction
→ evaluation
→ approve/reject
```

## Budget Commit

Explain precisely:

```text
when
who
how
idempotency
failure behavior
```

## Foundry Lifecycle

List actual methods/hooks used and why.

## Square / Hex / Large Footprint

Report regression coverage.

## Forced / Teleport

State genuinely implemented behavior versus deferred production entry.

## Planned Movement

State how future `planMovement` integration can reuse this seam.

## Tests

* starting count;
* new tests;
* final count;
* typecheck;
* diff-check.

## Architecture Audit

Confirm:

* no parallel Movement engine;
* no duplicate budget;
* no second socket;
* no client-trusted cost;
* no Foundry leakage into pure domain;
* no copied Crucible implementation;
* no direct coordinate update bypass.

## Live QA

State performed/not performed and Foundry build.

## Known Limits

Especially:

* pause/interruption;
* Regions;
* opportunity reactions;
* terrain;
* undo/refund;
* synthetic Actor persistence if incomplete.

## Git

* commit SHA/message;
* pushed status;
* final worktree.

## Next Recommendation

Answer:

> Is Movement now ready for the first movement-event / interruption / reaction composition slice, or is there still a Foundry runtime seam that must be closed first?

Do not start the next milestone automatically.

---

# Definition of Success

This milestone succeeds if:

> A real Foundry V14 Token movement initiated through the normal production lifecycle is translated into a plain WildPath MovementPath, validated authoritatively by the active GM against authoritative Scene/Token/Actor state and existing Movement budget, rejected before movement when illegal or unaffordable, and accounted for exactly once after successful movement.

And it must accomplish that while preserving:

```text
Foundry
→ interaction / movement lifecycle / animation

TacticalGrid
→ mechanical geometry

MovementPath
→ route legality and cost

movement.mjs
→ budget authority

multiplayer authority
→ rules authority

WildPath persistence
→ resource commit
```

No duplicate engine.

No second socket.

No endpoint-distance shortcuts.

No copied Crucible code.

---

# Final Governing Principle

Do not merely make WildPath aware that a Token moved.

Make the real Foundry movement workflow pass through WildPath's existing mechanical authority:

```text
FOUNDY PROPOSAL
↓
PLAIN INTENT
↓
ACTIVE GM
↓
TACTICAL TOPOLOGY
↓
MOVEMENTPATH
↓
BUDGET
↓
APPROVE
↓
FOUNDY MOVEMENT
↓
ACCOUNT EXACTLY ONCE
```

Use Crucible to understand how mature Foundry-native software talks to Foundry.

Use official V14 documentation to verify the contract.

Use WildPath to decide the rules.

Build the smallest vertical slice that makes real movement playable.
