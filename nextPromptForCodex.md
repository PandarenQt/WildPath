# WildPath — Combat Statistics Runtime Slice

Assume you have **no prior conversational context**.

The repository is authoritative.

This milestone exists because WildPath has now reached an important vertical boundary:

> The actual Foundry Item/Actor Sheet Action-use path is wired into the modern staged multiplayer runtime, but a genuine melee attack cannot yet complete because the real Actor model does not appear to provide the combat statistics expected by the Action pipeline — most visibly target defense / Armor Class.

Your task is to:

1. audit the actual combat-stat requirements of the current runtime;
2. determine whether this is:

   * one missing scalar,
   * a small shared derived-statistic problem,
   * or a larger Character System dependency;
3. implement the **smallest correct solution** if it is reasonably bounded;
4. prove at least one real production-entry melee Action can reach attack outcome and persistent damage using actual Actor data.

Do NOT begin Movement.

Do NOT build the full Character System.

Do NOT copy PF2e's Statistic architecture wholesale.

Do NOT introduce architecture without concrete current consumers.

---

# 1. Expected Current Repository State

Expected HEAD:

```text
e9996eb Wire Foundry actions into staged runtime
```

Reported verification after that milestone:

```text
485 / 485 tests passing
npm run typecheck passing
git diff --check passing
```

Reported worktree:

```text
clean except an unrelated untracked nextPromptForCodex.md
```

Do not trust this blindly.

First run:

```bash
git status
git branch --show-current
git rev-parse HEAD
git log --oneline --decorate -15

npm test
npm run typecheck
git diff --check
```

Record the real baseline.

Do not touch unrelated prompt files.

---

# 2. Read Before Editing

Read and obey:

* `AGENTS.md`
* `CLAUDE.md`
* `CODEX.md`
* `ARCHITECTURE.md`
* `CORE_AUTOMATION_FOUNDATION.md`
* `developmentStrat.md`

Read relevant architecture docs for:

* rules / RuleElements / Modifiers
* ActionDefinition
* staged Action resolution
* RollProvider
* targeting
* TacticalGrid
* persistence
* multiplayer authority
* Actor/data models

Inspect relevant source before proposing new contracts.

---

# 3. Current Production Path to Preserve

The previous milestone reportedly established the real runtime path:

```text
Actor Sheet
↓
Item.use()
↓
buildFoundryActionUseIntent()
↓
game.wildpath.executeActionIntent()
↓
MultiplayerActionCoordinator
↓
foundryActionIntentToStagedOptions()
↓
FoundryV14TacticalGridAdapter
↓
staged Action pipeline
↓
Roll / Targeting / Reaction / Payment
↓
Transaction
↓
DocumentPersistencePort
```

Verify this remains true.

Do not revert normal Action use to:

```text
executeActionResolution()
```

That resolver should remain compatibility/legacy unless current code proves otherwise.

---

# 4. Known New Boundary

The previous implementation reported:

> WildPath's Actor data model has no canonical Armor Class / defense field. `AttackResolver` expects defense information on the target candidate, so a real melee attack would fail `MISSING_DEFENSE`.

Do not assume this report is complete.

Reproduce and trace the problem from source.

Determine exactly:

* where target defense is required;
* what key/value shape `AttackResolver` expects;
* where test fixtures currently obtain it;
* where production candidate construction should obtain it;
* whether an equivalent Actor-derived statistic already exists under another name.

---

# 5. Audit the Combat Statistics Actually Required Today

Before editing, inventory the current implementation state for:

```text
target defense / AC
attack modifier
saving throw modifier
save / action DC
HP / health
initiative
ability scores
ability modifiers
proficiency
skills / checks
spell attack
spell save DC
```

For each classify it as:

```text
persisted Actor data
derived Actor data
ActionDefinition data
RuleElement / Modifier contribution
resolver-calculated
test-fixture only
missing
```

Use source evidence.

Do not infer implementation from roadmap aspirations.

---

# 6. The Central Architecture Question

Determine:

> Is AC/defense genuinely an isolated missing field, or is it merely the first visible example of a repeated "derived statistic" requirement?

Use actual current consumers.

Do not answer based on preference.

---

# 7. Three Allowed Architecture Outcomes

After the audit, choose one.

## Outcome A — Simple Missing Combat Fields

Use this if current gameplay only requires a small number of canonical scalar Actor values and existing rules infrastructure can already modify/derive them adequately.

Possible conceptual form:

```text
system.defenses.ac
```

or whatever fits current Actor schema conventions.

Do not force this exact path.

If this is enough:

implement the smallest fields + adapter/resolver bridge needed.

---

## Outcome B — Small Shared Derived-Statistic Primitive

Use this only if multiple **current** mechanics require the same invariant.

For example, evidence may show that:

```text
AC
attack modifier
saving throw
DC
initiative
```

all require:

```text
base/current value
+
Predicate-gated Modifier contributions
+
deterministic evaluation
+
provenance
=
effective value
```

If so, introduce the **smallest shared primitive** needed by actual current consumers.

Possible conceptual shape:

```text
{
  key,
  base,
  total,
  contributions,
  provenance
}
```

but do not blindly use this shape.

Do NOT create:

```text
StatisticManager
StatisticService
StatisticRegistry
CharacterDerivationEngine
StatisticFactory hierarchy
```

unless a concrete current requirement makes one unavoidable.

---

## Outcome C — Larger Character System Required

Choose this only if solving the runtime attack correctly would require substantial work involving:

* equipment calculation,
* class progression,
* proficiency progression,
* spellcasting progression,
* level architecture,
* broad character derivation.

If C is genuinely required:

**STOP BEFORE IMPLEMENTATION.**

Return the evidence and propose the smallest future milestone.

Do not accidentally build the full Character System inside this task.

---

# 8. Evidence Requirement for a New Abstraction

For every new public combat-stat abstraction you consider adding, answer:

1. Which current production mechanics require it?
2. Why can't existing `Modifier`, `Predicate`, `ValueExpression`, RuleElement, Actor data, and ActionDefinition contracts represent this correctly?
3. Which invariant does the new abstraction own?
4. Why is it not merely useful "for later"?

If you cannot answer these concretely:

do not add it.

---

# 9. Target Defense Ownership

`AttackResolver` must remain Foundry-independent.

It should not read:

```text
ActorDocument
TokenDocument
game
canvas
```

Determine the correct boundary for target defense.

Expected general shape:

```text
Actor-derived combat data
↓
application/runtime conversion
↓
plain target candidate
↓
AttackResolver
```

or another existing plain-data boundary already present.

Reuse current architecture.

---

# 10. Do Not Duplicate Authority

There must not be:

```text
Actor AC
```

and separately:

```text
Target candidate defense calculated independently
```

with both claiming authority.

The candidate may contain a resolved snapshot for deterministic ResolutionState execution, but its source must be canonical and explainable.

Document this ownership.

---

# 11. Attack Modifier Audit

A successful runtime attack needs more than target AC if source Actor statistics determine the attack roll.

Trace the full attack RollRequest.

Determine:

* what formula/request is produced;
* whether the attack modifier is embedded in ActionDefinition;
* whether it is derived from Actor;
* whether RollProvider currently receives a final modifier;
* whether tests use precomputed roll totals and accidentally bypass source-stat derivation.

Do not declare melee runtime-ready if a real Actor can only attack correctly because tests inject a finished roll total.

---

# 12. Natural vs Total

Preserve the RollProvider architecture.

If Actor attack modifier is introduced:

```text
natural d20
+
resolved modifier
=
total
```

must still preserve:

* natural result
* final total
* provenance/context where supported.

Crit/fumble semantics must continue to use the natural die where appropriate.

Do not move combat-stat logic into RollProvider.

---

# 13. Saving Throw Audit

Trace one existing save-based Action.

Determine separately:

### Offensive side

Where does save DC come from?

### Defensive side

Where does target save modifier come from?

Classify each:

```text
implemented
fixture-only
missing
```

This audit matters because we do not want to patch AC now and discover the exact same missing primitive one milestone later.

---

# 14. Do Not Necessarily Implement Saves

The primary gameplay acceptance target for this milestone is **one real melee attack**.

If save statistics require only trivial reuse of the exact same new primitive, including them may be appropriate.

If they require additional unrelated rules work:

document them and defer.

Do not inflate this task just to make the inventory table green.

---

# 15. HP / Damage Persistence Audit

Verify that actual production Actor health can already support:

```text
attack hit
↓
damage
↓
MutationPlan
↓
Transaction
↓
DocumentPersistencePort
↓
target HP changes
```

without synthetic test-only target data.

If HP mapping is missing or mismatched:

fix it only if it is a small direct part of completing the required real melee vertical slice.

Report it explicitly.

---

# 16. Action Resource Payment

Likewise verify a real Action resource can:

```text
available
↓
planned
↓
committed exactly once
```

through actual Actor data.

Do not duplicate resource state in the new combat-stat system.

---

# 17. Existing Rule Engine Must Be Reused

Inspect current:

```text
Predicate
ValueExpression
Modifier
RuleElement
provenance / trace
```

Before creating combat-stat-specific modifier logic.

A feature such as:

```text
+2 defense
```

should ideally use the normal rules engine.

Do not create:

```text
ACModifier
AttackBonusModifier
SaveModifier
```

classes unless the existing generic Modifier model genuinely cannot express them.

---

# 18. Modifier Selectors / Domains

Inspect how modifiers currently identify what they affect.

Determine whether there is already selector vocabulary capable of describing concepts such as:

```text
defense.ac
attack.melee
save.dexterity
dc.spell
initiative
```

or equivalent.

If not, adding a **small selector vocabulary** may be enough.

Do not create a second Modifier system.

---

# 19. Conditional Defense

Use this as an architecture test:

> A feature grants +2 defense only against melee attacks.

Can the proposed minimum model express this through:

```text
Modifier
+
Predicate
+
attack context
```

without adding feature-name code?

If no:

identify the smallest missing contextual input.

Do not implement production Shield or any named feature.

---

# 20. Attack Bonus Homebrew Test

Use:

> A weapon or feature grants +1 to this attack.

Can existing contribution/provenance machinery represent it?

If not, explain whether that gap must be addressed now for real attacks or can remain a later content concern.

---

# 21. Saving Throw Homebrew Test

Use:

> Gain +2 to Dexterity saving throws while condition X is true.

Determine whether the proposed statistic model can eventually express this generically.

Do not implement the actual condition/content.

---

# 22. DC Homebrew Test

Use:

> Increase spell save DC by 1.

Same requirement:

no named-feature branch.

---

# 23. Explainability Requirement

WildPath's long-term quality target includes being able to explain something like:

```text
Defense: 18
Base: 10
Armor: +5
Dexterity: +2
Shield: +1
Condition: ...
```

or whatever the actual active ruleset produces.

This milestone does NOT build the Rules Inspector.

But avoid a design where all provenance disappears into:

```text
system.ac = 18
```

if the current architecture already has easy access to contribution data.

Balance this against over-engineering.

---

# 24. Persisted vs Derived Values

Deliberately decide whether a statistic is:

```text
persisted canonical input
```

or:

```text
derived effective output
```

Avoid persisting a derived total if that creates stale duplicated authority.

But do not force every simple value to be dynamically recomputed if the project has no need for it.

Explain the decision.

---

# 25. Ruleset Formulas Are NOT Statistic Responsibilities

If AC/defense eventually differs by ruleset:

```text
D&D 2014
D&D 2024
WildPath house rules
```

do not hardcode armor formulas into a generic statistic primitive.

Separate:

```text
what inputs/contributions exist
```

from:

```text
how a given ruleset generates those inputs
```

only to the extent currently necessary.

Do not implement a ruleset selection system here.

---

# 26. Ability Score Scope

If ability modifiers are required to compute the real attack:

inspect whether they already exist.

If missing, add only the smallest support required by evidence.

Do not redesign the entire ability/skills framework in this milestone.

That broader skill rework remains a later WildPath feature.

---

# 27. Proficiency Scope

Same rule.

If current ActionDefinitions already contain their complete attack modifier:

do not build proficiency derivation.

If real Actor attacks concretely require proficiency information:

determine the smallest appropriate representation.

Do not implement level progression.

---

# 28. Equipment Scope

Do not implement:

* armor equipping
* shields
* weapon proficiency
* equipment loadouts
* inventory-to-stat derivation

unless the current repository already contains a simple implemented mechanic that only needs connecting.

For this milestone, test fixtures may use canonical persisted/base combat values representing what future equipment systems will eventually derive.

That is acceptable if ownership is explicit.

---

# 29. Candidate Construction

Update the real runtime candidate-building path as needed.

A real target candidate should receive canonical plain-data defense information.

The candidate must remain serializable.

No Foundry Document enters ResolutionState.

---

# 30. Source Combat Context

Likewise, any source Actor statistics required by attack/save RollRequests should be resolved before entering the pure pipeline or through an existing plain application context.

No domain resolver reads the Actor Document directly.

---

# 31. Serialization

New combat-stat data inside:

```text
ActionIntent-derived options
ResolutionState
target candidates
RollRequest
results
```

must be plain serializable data.

No:

* Map
* Set
* Date
* classes
* Foundry Documents
* functions
* promises

Policy/evaluator functions remain runtime dependencies, not stored state.

---

# 32. Production Entry Test Must Start at the Real Boundary

This is mandatory.

Do not only add another:

```text
planStagedActionResolution(options)
```

test with synthetic options.

At least one acceptance test must start from the newly wired production Action use / intent-building layer.

It should exercise as much of this flow as practical:

```text
realistic Actor data
↓
realistic Item ActionDefinition
↓
buildFoundryActionUseIntent
↓
production Foundry intent conversion
↓
TacticalGrid context
↓
staged pipeline
↓
attack roll
↓
canonical target defense
↓
hit
↓
damage
↓
persistence
↓
Action payment
↓
COMPLETED
```

The test may use deterministic adapters/providers.

It must NOT manually inject target defense into the already-built staged options.

That would defeat the purpose.

---

# 33. Canonical Defense Test

Mandatory if Outcome A or B is implemented.

Use a target Actor with canonical combat-stat data.

Assert the production runtime conversion produces the expected plain candidate defense.

No test-only candidate override.

---

# 34. Defense Modifier Test

If the implementation supports Modifier-derived defense in this milestone:

add a representative generic test.

For example:

```text
base defense X
+
generic Modifier +2
=
effective defense X+2
```

Provenance should be preserved where the existing rules framework supports it.

Do not create named content.

---

# 35. Hit / Miss Proof

Production-path test should prove at least:

```text
attack total > defense
→ hit
```

and preferably one:

```text
attack total < defense
→ miss
```

using Actor-derived defense.

Do not directly set final outcome.

---

# 36. Damage Persistence Proof

For a hit:

assert the target's persisted health changes through the normal PersistencePort.

No direct Actor mutation in the new combat-stat layer.

---

# 37. Action Payment Proof

Assert the source Actor's Action resource is spent exactly once on successful commit.

If attack misses but the Action was validly executed:

use existing payment semantics.

Do not invent a refund policy.

---

# 38. Multiplayer Production Proof

Prefer using the existing production coordinator test fixture.

Representative:

```text
Player A uses Action
↓
GM authority
↓
Player A supplies RollResult if chooser policy says so
↓
GM evaluates target defense
↓
GM commits damage/payment
```

Do not create another networking path.

---

# 39. No-GM / Permission Fallback

Do not modify it unless this combat-stat integration exposes a real issue.

Existing multiplayer policy remains authoritative.

---

# 40. Live Foundry QA Gate

After this milestone, WildPath should ideally be capable of its first genuine live combat smoke test.

If a Foundry V14 runtime is available:

perform:

1. Create source Actor.
2. Give source a simple melee Action.
3. Create target Actor with canonical defense/HP.
4. Place both Tokens adjacent.
5. Target target Token.
6. Use Action from real Actor sheet.
7. Complete roll.
8. Verify:

   * attack outcome;
   * HP;
   * Action resource;
   * multiplayer authority if two clients available.

Record exact Foundry build.

If runtime is unavailable:

state clearly:

```text
Live Foundry QA not performed.
```

Do not fabricate it.

---

# 41. Do NOT Fix Condition Direct-Mutation Debt

Previous audit found a separate P1 issue:

```text
WildPathConditionEffect.applyDelta()
```

still uses direct Foundry mutation on the production condition-toggle path.

Do not fix that here unless directly required for this melee acceptance slice.

Keep it in known debt.

---

# 42. Do NOT Add ResolutionState Combination Validators

Previous audit identified missing defense-in-depth validation for impossible ResolutionState combinations.

Do not include that unrelated hardening in this task.

Keep scope focused.

---

# 43. Do NOT Refactor Multiplayer Coordinator

Its size has been flagged as a smell.

No speculative split during this milestone.

---

# 44. Do NOT Implement Movement

Movement remains the next major domain milestone after real combat-stat readiness.

Do not touch the queued Movement prompt.

---

# 45. Do NOT Implement Full Character Progression

Explicitly excluded:

* levels
* classes
* subclasses
* multiclassing
* XP
* proficiency progression tables
* spell preparation
* full equipment derivation
* skills redesign
* rest system

---

# 46. Test the Actual Repeated Need Before Generalizing

A generic Statistic primitive is justified only if you can point at at least **two current production consumers** requiring the same evaluation invariant.

Examples:

```text
defense + saving throw
```

or:

```text
defense + attack modifier
```

If only defense requires it today:

prefer the smaller solution unless there is a concrete architectural contradiction.

---

# 47. Avoid One-Field Patchwork Too

Conversely, do not create:

```text
system.ac
system.attackBonus
system.dexSave
system.spellDc
```

as unrelated ad hoc fields if the audit demonstrates they all immediately require identical Modifier/Predicate/provenance behavior.

Use evidence to choose the middle ground.

---

# 48. Expected Implementation Size

This should remain a focused milestone.

If your proposed change begins requiring many unrelated systems or hundreds of lines of architecture before tests:

stop and reassess Outcome C.

Do not smuggle Character System development into a combat unblocker.

---

# 49. Documentation

Update only the relevant docs.

Record:

* canonical combat-stat ownership;
* what is persisted vs derived;
* how target defense reaches AttackResolver;
* how source attack modifiers reach RollRequest, if applicable;
* how Modifier/Predicate contributions interact;
* which statistics remain deferred.

Do not mark full Character Statistics complete if only a narrow runtime slice exists.

---

# 50. Roadmap Status

If this succeeds, roadmap language should say something equivalent to:

> Real production-entry melee Action is now supported using canonical Actor combat statistics.

It should NOT claim:

> Character system complete.

Then Movement may resume.

---

# 51. Verification

Run:

```bash
npm test
npm run typecheck
git diff --check
```

Starting suite is expected around:

```text
485 tests
```

Final suite should increase.

Do not weaken existing tests.

---

# 52. Commit

If Outcome A or B is implemented successfully and all verification passes:

create a coherent commit.

Suggested conceptual commit messages:

```text
Add runtime combat statistics
```

or:

```text
Resolve actor combat statistics
```

Choose according to actual implementation.

If Outcome C is chosen:

do NOT create an implementation commit merely to have activity.

Return the audit result.

---

# 53. Required Completion Report

Return the following.

## Repository Baseline

* initial HEAD
* branch
* worktree
* starting tests
* typecheck

## Audit Result

Choose:

```text
A — isolated/simple combat fields
B — small shared derived-statistic primitive
C — larger Character System dependency
```

Explain with exact source evidence.

## Combat Statistic Inventory

Table covering:

* defense/AC
* attack modifier
* saves
* DC
* HP
* initiative
* abilities
* proficiency

## Root Cause

Explain why a real attack previously produced or would produce `MISSING_DEFENSE`.

## Architecture Decision

Explain:

* canonical persisted inputs
* derived outputs
* Modifier/Predicate reuse
* provenance
* ruleset responsibility

## Implementation

List files/contracts changed.

For every new exported concept:

> Which concrete current mechanic required it?

## Target Defense Flow

Show:

```text
Actor data
→ resolved/plain combat statistic
→ target candidate
→ AttackResolver
```

## Attack Modifier Flow

Show the real current source.

If no new work was required, explain why.

## Save/DC Readiness

State what is genuinely supported versus deferred.

## Production Melee Vertical Slice

Report whether this full flow now succeeds:

```text
sheet/item use
→ ActionIntent
→ GM authority
→ TacticalGrid
→ RollRequest
→ canonical defense
→ hit/miss
→ damage
→ HP persistence
→ Action payment
→ completion
```

## Tests

Report new tests for:

* production defense mapping;
* hit/miss;
* damage persistence;
* Action payment;
* multiplayer if applicable;
* Modifier-derived stat if applicable.

Then report:

* final test total;
* typecheck;
* diff check.

## Architecture Audit

Confirm:

* no Foundry leakage into domain;
* no duplicate stat authority;
* no named-feature branches;
* no new unnecessary managers/registries;
* serializable state.

## Live QA

* performed/not performed;
* exact Foundry build if performed.

## Known Limits

Be precise.

Include remaining P1 items such as condition persistence only if still relevant.

## Git

* commit SHA/message;
* branch;
* worktree.

## Next Recommendation

Answer:

> Is WildPath now ready to return to the topology-aware Movement milestone?

Do not start Movement automatically.

---

# 54. Definition of Success

The milestone succeeds if:

> A normal melee Action initiated through the real Foundry Action-use runtime can derive all combat statistics it actually needs from canonical Actor/system data, evaluate attack against target defense through the existing pure resolvers, persist resulting damage and resource payment through existing transaction/persistence boundaries, and complete without test-only combat-stat injection.

And this must be achieved without prematurely building the full Character System.

---

# Final Governing Principle

This milestone is where WildPath starts transitioning from:

```text
excellent combat engine tested with synthetic character data
```

to:

```text
combat engine that actually understands a real WildPath character
```

Build the smallest bridge required by current gameplay.

No more.
