# WildPath — Combat Statistics Runtime Slice

## With Targeted PF2e / Crucible / Foundry V14 Reference Review

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
3. use mature reference systems selectively to identify proven design lessons;
4. use Crucible specifically as a benchmark for **how a mature Foundry-native V14 system interacts with Foundry core**;
5. verify any relevant Foundry APIs/hooks/lifecycle behavior against official Foundry V14 documentation;
6. implement the **smallest WildPath-native solution** if it is reasonably bounded;
7. prove at least one real production-entry melee Action can reach attack outcome and persistent damage using actual Actor data.

Do NOT begin Movement.

Do NOT build the full Character System.

Do NOT copy PF2e's Statistic architecture wholesale.

Do NOT copy or adapt Crucible implementation code.

Do NOT introduce architecture merely because a reference system has it.

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

# 2. Read WildPath Before Any Reference System

Read and obey:

* `AGENTS.md`
* `CLAUDE.md`
* `CODEX.md`
* `ARCHITECTURE.md`
* `CORE_AUTOMATION_FOUNDATION.md`
* `developmentStrat.md`

Read relevant architecture docs for:

* rules / RuleElements / Modifiers;
* ActionDefinition;
* staged Action resolution;
* RollProvider;
* targeting;
* TacticalGrid;
* persistence;
* multiplayer authority;
* Actor/data models;
* Foundry runtime integration.

Inspect relevant WildPath source before proposing new contracts.

The order matters:

```text
WildPath requirement
↓
WildPath existing primitives
↓
identify concrete missing invariant
↓
consult targeted prior art
↓
verify Foundry behavior where relevant
↓
return to WildPath
↓
design smallest native solution
```

Do NOT begin by studying PF2e or Crucible and then reshape WildPath around them.

---

# 3. Reference-System Policy

Reference systems are **prior art and implementation benchmarks**, not specifications.

WildPath remains authoritative.

There are three distinct reference roles:

```text
PF2e
→ primary rules-engine / character-system benchmark

Crucible
→ primary Foundry-native implementation benchmark

Official Foundry VTT V14 documentation
→ authoritative platform API / hook / lifecycle reference
```

Use them deliberately.

## PF2e should primarily answer:

> How has a mature rules-heavy Foundry system modeled this rules problem?

Examples:

* derived statistics;
* Modifier/Predicate interaction;
* actor preparation;
* provenance;
* saves;
* checks;
* effects;
* character progression.

## Crucible should primarily answer:

> How does a mature Foundry-native V14 system implement this kind of interaction with Foundry itself?

Examples:

* hooks;
* lifecycle timing;
* Actor/Item/Token/Scene Documents;
* Applications;
* canvas integration;
* Token behavior;
* movement;
* Regions;
* UI/application boundaries;
* Foundry data formats;
* Document mutation methods;
* digital-native action workflows.

## Official Foundry documentation should answer:

> What does Foundry V14 actually guarantee?

Reference systems may reveal which Foundry API exists and how a mature system uses it.

Official V14 documentation verifies the actual contract.

WildPath then makes its own implementation decision.

---

# 4. Core Reference Workflow

For a rules-heavy question:

```text
WildPath requirement
↓
inspect WildPath rules architecture
↓
identify missing invariant
↓
inspect PF2e prior art
↓
extract architectural principle
↓
discard PF2e-specific Pathfinder assumptions
↓
implement smallest WildPath-native solution
```

For a Foundry-facing question:

```text
WildPath requirement
↓
inspect WildPath application/domain boundary
↓
inspect Crucible for relevant Foundry usage
↓
record conceptual observations:
    hook/API
    Document/Application type
    lifecycle point
    data format
    Foundry-owned behavior
↓
verify against official Foundry V14 documentation
↓
decide what Foundry owns
↓
decide what WildPath owns
↓
implement independently
```

For a mixed problem:

```text
PF2e
→ rules semantics / derivation

Crucible
→ practical Foundry implementation

Foundry docs
→ authoritative platform contract

WildPath
→ final architecture
```

---

# 5. PF2e Reference

PF2e is the **primary external rules reference for this milestone**.

Preferred reference:

```text
foundryvtt/pf2e
branch: v14-dev
```

If a local read-only checkout exists outside WildPath, prefer it.

Possible layout:

```text
GitHub/
├── WildPath/
└── WildPath-references/
    └── pf2e-v14/
```

If it exists:

* inspect it read-only;
* do not modify it;
* do not commit into it;
* do not make WildPath depend on it.

If it does not exist and network access is available, you MAY create a shallow reference checkout outside WildPath.

Do NOT:

* add PF2e as a submodule;
* add it to WildPath package dependencies;
* copy compendium/game content;
* copy artwork;
* copy substantial unrelated source;
* make tests/build/runtime depend on PF2e.

Use PF2e specifically to inspect architectural patterns involving:

* derived statistics;
* modifier application;
* predicate-gated modifiers;
* selector/domain semantics;
* actor preparation;
* AC;
* saving throws;
* attack/check statistics;
* DCs;
* provenance/explanation;
* persisted inputs vs derived outputs.

---

# 6. Crucible Reference — Foundry Implementation Benchmark

Crucible has a **different but equally important role**.

Crucible is one of WildPath's primary benchmarks for understanding how a mature V14-native system uses Foundry itself.

For this combat-stat milestone, PF2e remains primary for the statistic/rules model.

However, Crucible should be actively consulted whenever the problem crosses into questions such as:

* where Actor-derived data is prepared;
* how Item/Actor actions enter application orchestration;
* which Foundry lifecycle hooks are used;
* which Foundry Document owns a piece of state;
* how Applications interact with Documents;
* how a runtime layer obtains Actor/Token/Scene context;
* which data should be read during preparation versus action execution;
* which Foundry APIs should be used rather than recreated;
* how a mature V14 system separates Foundry runtime concerns from rules concerns.

Crucible should answer:

> **How should WildPath talk to Foundry?**

It should generally NOT answer:

> **How should WildPath's combat-stat rules be modeled?**

---

# 7. Crucible Source Inspection Boundary

You MAY read Crucible source to understand:

* Foundry hook names;
* hook timing;
* Foundry public methods;
* Document types;
* Application classes;
* lifecycle points;
* canvas APIs;
* Token APIs;
* Region APIs;
* data shapes exposed by Foundry;
* how Foundry-native operations are initiated;
* which behavior Crucible delegates to Foundry core.

This is a **reference/research activity**.

Do NOT:

* copy Crucible snippets into WildPath;
* copy and rename Crucible functions;
* structurally adapt a Crucible implementation line-by-line;
* copy Crucible algorithms whose implementation belongs to Crucible;
* copy game data;
* copy rules content;
* copy artwork/assets;
* make Crucible a runtime dependency;
* make Crucible a test/build dependency;
* vendor Crucible into WildPath.

A good result of Crucible inspection is:

```text
Crucible appears to use Foundry hook X for lifecycle event Y.

The relevant object is Document type Z.

The public method appears to be A.

Foundry V14 documentation confirms this contract.

WildPath will independently use/reject that facility because ...
```

A bad result is:

```text
Crucible's function does this, so copy it and modify the names.
```

---

# 8. Official Foundry V14 Verification

Whenever Crucible materially influences a Foundry-facing decision:

verify the relevant facility against official Foundry V14 documentation where available.

Check:

* hook/API actually exists in V14;
* method signature;
* hook arguments;
* lifecycle semantics;
* asynchronous behavior;
* client versus authority behavior;
* Document ownership;
* persistence semantics;
* deprecation state;
* whether the API is public or private/internal.

Use this sequence:

```text
CRUCIBLE OBSERVATION
↓
FOUNDRY V14 VERIFICATION
↓
WILDPATH DECISION
```

Do not rely on Crucible alone as the platform specification.

Do not rely on stale V11/V12/V13 documentation when V14 documentation exists.

---

# 9. Required Reference Comparison Notes

Before implementing, perform a short targeted reference analysis.

Do not write an exhaustive research paper.

## PF2e

Identify:

* What concept represents an effective statistic?
* How are persisted/base inputs separated from derived totals?
* How are modifiers applied?
* How do predicates/context affect them?
* How is provenance retained?
* Which concepts are shared between:

  * AC;
  * saves;
  * checks;
  * attack rolls;
  * DCs?
* Which concerns belong to Actor preparation?
* Which belong to roll/action resolution?
* Are final totals persisted or derived?

Then state:

```text
Useful PF2e principle for WildPath:
...

Already solved differently by WildPath:
...

PF2e-specific behavior not applicable to WildPath:
...

Would be over-engineering for WildPath:
...
```

## Crucible

Inspect only concrete Foundry-facing questions relevant to this milestone.

At minimum determine whether Crucible provides useful evidence about:

```text
Actor preparation lifecycle
Item/Actor action entry
Document/application boundary
how Actor-derived values are made available to actions
```

Then report:

```text
CRUCIBLE OBSERVATION:
...

FOUNDRY V14 VERIFICATION:
...

WILDPATH DECISION:
...
```

If Crucible offers nothing useful for the specific combat-stat issue, state that and move on.

Do not force reference usage.

---

# 10. Current Production Path to Preserve

The previous milestone reportedly established:

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

When examining this path, Crucible may be used to benchmark whether WildPath is using appropriate Foundry lifecycle/API boundaries.

Do not change a working WildPath boundary merely because Crucible organizes code differently.

---

# 11. Known New Boundary

The previous implementation reported:

> WildPath's Actor data model has no canonical Armor Class / defense field. `AttackResolver` expects defense information on the target candidate, so a real melee attack would fail `MISSING_DEFENSE`.

Do not assume this report is complete.

Reproduce and trace the problem from source.

Determine exactly:

* where target defense is required;
* what shape/key `AttackResolver` expects;
* where test fixtures currently obtain it;
* where production candidate construction should obtain it;
* whether an Actor-derived equivalent already exists.

---

# 12. Audit Combat Statistics Required Today

Before editing, inventory current implementation for:

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

For each classify:

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

# 13. Compare WildPath Needs Against PF2e's Shared Statistic Invariant

After the WildPath inventory, compare actual missing requirements against PF2e.

The question is NOT:

> Does PF2e have a Statistic class?

The question is:

> Do multiple current WildPath mechanics require the same invariant that caused PF2e to introduce shared statistic machinery?

For example:

```text
base/input
+
ordered modifiers
+
predicate context
+
derived total
+
provenance
```

If WildPath currently needs only:

```text
target AC scalar
```

PF2e's richer solution may be inappropriate.

If WildPath currently needs:

```text
AC
attack modifier
saving throw modifier
save DC
initiative
```

with equivalent evaluation semantics, a small shared primitive may be justified.

Use evidence.

---

# 14. Central Architecture Question

Determine:

> Is AC/defense genuinely an isolated missing field, or is it merely the first visible example of a repeated derived-statistic requirement?

Use:

1. current WildPath production consumers;
2. current WildPath rules primitives;
3. targeted PF2e prior art.

Crucible should inform only the **Foundry lifecycle/data-access boundary**, not this rules-model decision.

---

# 15. Three Allowed Architecture Outcomes

## Outcome A — Simple Missing Combat Fields

Use if current gameplay needs only a small number of canonical scalar Actor inputs and existing rules infrastructure can already modify/derive them adequately.

Possible conceptual form:

```text
system.defenses.ac
```

or whatever fits current Actor schema conventions.

Do not force this exact path.

PF2e's richer Statistic machinery is NOT sufficient reason to choose Outcome B.

---

## Outcome B — Small Shared Derived-Statistic Primitive

Use only if multiple **current production consumers** require the same invariant.

For example:

```text
AC
attack modifier
saving throw
DC
initiative
```

may all require:

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

If so, introduce the **smallest shared primitive** needed today.

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

Do not blindly use this shape.

Treat PF2e as evidence of mature requirements, not as a blueprint.

Do NOT create:

```text
StatisticManager
StatisticService
StatisticRegistry
CharacterDerivationEngine
StatisticFactory hierarchy
```

unless concrete current requirements require them.

---

## Outcome C — Larger Character System Required

Choose only if solving runtime attacks correctly requires substantial:

* equipment calculation;
* class progression;
* proficiency progression;
* spellcasting progression;
* level architecture;
* broad character derivation.

If C is genuinely required:

**STOP BEFORE IMPLEMENTATION.**

Return the evidence.

Do not build the Character System inside this milestone.

---

# 16. Evidence Requirement for New Abstractions

For every new public combat-stat abstraction considered, answer:

1. Which current production mechanics require it?
2. Why can't existing `Modifier`, `Predicate`, `ValueExpression`, RuleElement, Actor data, and ActionDefinition contracts solve it?
3. Which invariant does it own?
4. Why is it not merely useful "for later"?
5. Which PF2e lesson supports the invariant?
6. Which PF2e architecture is deliberately not being adopted?
7. Does Crucible reveal any relevant Foundry lifecycle requirement, or is that unrelated?
8. Which official Foundry behavior constrains the implementation, if any?

If these cannot be answered concretely:

do not add the abstraction.

---

# 17. Target Defense Ownership

`AttackResolver` must remain Foundry-independent.

It must not read:

```text
ActorDocument
TokenDocument
game
canvas
```

Determine the correct boundary.

Expected general shape:

```text
Actor canonical/derived combat data
↓
application/runtime preparation
↓
plain target candidate
↓
AttackResolver
```

PF2e may inform how derived values are prepared.

Crucible may inform which Foundry Actor/data-preparation lifecycle is appropriate.

Official Foundry V14 docs should verify any lifecycle/hook chosen.

Do not let a domain resolver depend directly on Foundry preparation hooks.

---

# 18. Do Not Duplicate Authority

There must not be:

```text
Actor AC
```

and separately:

```text
Target candidate defense calculated independently
```

with both claiming authority.

The candidate may contain a resolved snapshot for deterministic ResolutionState execution.

Its source must remain canonical and explainable.

---

# 19. Actor Preparation / Foundry Lifecycle Audit

Because this milestone now involves actual Actor-derived data, inspect the current Foundry-facing preparation lifecycle.

Determine:

* when WildPath Actor system data becomes available;
* whether derived data is prepared during document preparation;
* whether current WildPath code uses `prepareBaseData`, `prepareDerivedData`, or another V14 lifecycle;
* whether combat statistics should be derived there or later at action-resolution time;
* whether derived data is persisted or ephemeral.

Use Crucible as a practical benchmark for **which Foundry lifecycle hooks/methods are appropriate**.

Then verify against official Foundry V14 docs.

Do NOT copy Crucible preparation code.

Do NOT assume PF2e's Actor preparation lifecycle is automatically the correct WildPath solution.

---

# 20. Attack Modifier Audit

A successful runtime attack needs more than target AC if source Actor statistics determine the attack roll.

Trace the full attack RollRequest.

Determine:

* formula/request produced;
* whether attack modifier is embedded in ActionDefinition;
* whether it is Actor-derived;
* whether RollProvider receives a final modifier;
* whether tests inject precomputed roll totals.

Compare with PF2e's separation between:

```text
derived statistic preparation
```

and:

```text
roll execution
```

Preserve WildPath's RollProvider architecture.

Crucible may be consulted only for Foundry/application plumbing around Actor/action data.

Do not declare melee runtime-ready if tests bypass source-stat derivation with finished totals.

---

# 21. Natural vs Total

Preserve:

```text
natural d20
+
resolved modifier
=
total
```

where applicable.

Maintain:

* natural result;
* total;
* provenance/context where supported.

Crit/fumble behavior must continue to use the natural die when required.

Do not move combat-stat rules into RollProvider.

---

# 22. Saving Throw Audit

Trace one save-based Action.

Determine:

## Offensive side

Where does save DC come from?

## Defensive side

Where does target save modifier come from?

Classify:

```text
implemented
fixture-only
missing
```

Use PF2e to investigate whether:

```text
AC
save
DC
```

share a genuine evaluation invariant.

Do not generalize merely because PF2e generalizes them.

---

# 23. Do Not Necessarily Implement Saves

Primary acceptance target:

> **one real melee attack**

If save statistics are trivial reuse of the exact same justified primitive, including them may be appropriate.

If additional unrelated rules work is required:

document and defer.

---

# 24. HP / Damage Persistence Audit

Verify actual production Actor health supports:

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

without synthetic data.

If Foundry Actor/Document lifecycle matters here:

use Crucible to identify appropriate Foundry APIs/patterns and official docs to verify them.

Do not replace the established persistence boundary with direct document writes merely because another system does so.

WildPath persistence architecture remains authoritative.

---

# 25. Action Resource Payment

Verify real Action resource data supports:

```text
available
↓
planned
↓
committed exactly once
```

Do not duplicate resource state in combat statistics.

---

# 26. Existing Rule Engine Must Be Reused

Inspect:

```text
Predicate
ValueExpression
Modifier
RuleElement
provenance / trace
```

before creating combat-stat-specific modifier logic.

Compare PF2e's modifier/predicate patterns to WildPath's existing primitives.

A feature such as:

```text
+2 defense
```

should ideally use the normal WildPath rules engine.

Do not create:

```text
ACModifier
AttackBonusModifier
SaveModifier
```

classes unless generic Modifier semantics genuinely cannot express the requirement.

---

# 27. Modifier Selectors / Domains

Determine whether WildPath already has selectors/domains capable of expressing concepts such as:

```text
defense.ac
attack.melee
save.dexterity
dc.spell
initiative
```

or equivalent.

Inspect PF2e's mature domain/selector/predicate concepts only to understand the invariant.

If WildPath already solves it differently:

reuse WildPath.

If not, a small selector/domain vocabulary may be sufficient.

Do not create a second Modifier system.

---

# 28. Conditional Defense Architecture Test

Thought experiment:

> A feature grants +2 defense only against melee attacks.

Can the proposed model express this through:

```text
Modifier
+
Predicate
+
attack context
```

without named-feature code?

PF2e may inform contextual predicate design.

Do not import PF2e's entire roll-option architecture unless WildPath actually needs it.

---

# 29. Attack Bonus Homebrew Test

Thought experiment:

> A weapon or feature grants +1 to this attack.

Can existing contribution/provenance machinery represent it?

If WildPath already supports the invariant differently from PF2e:

keep the WildPath approach.

---

# 30. Saving Throw Homebrew Test

Thought experiment:

> Gain +2 to Dexterity saving throws while condition X is true.

Determine whether the proposed model could express it generically.

Do not implement the content.

---

# 31. DC Homebrew Test

Thought experiment:

> Increase spell save DC by 1.

Same requirement:

no named-feature branch.

---

# 32. Explainability Requirement

WildPath should eventually explain:

```text
Defense: 18

Base: 10
Armor: +5
Dexterity: +2
Shield: +1
Condition: ...
```

or whatever the active ruleset produces.

Inspect how PF2e retains sufficient data for explanation.

Then evaluate what WildPath's existing provenance already provides.

Do not create a second provenance system.

Do not reduce everything to:

```text
system.ac = 18
```

if contribution information can be preserved cheaply.

But do not recreate PF2e's complete Statistic object merely for hypothetical future UI.

---

# 33. Persisted vs Derived Values

Decide deliberately whether a statistic is:

```text
persisted canonical input
```

or:

```text
derived effective output
```

PF2e can provide mature prior art here.

Crucible may provide practical Foundry guidance on where ephemeral derived Actor data is stored/exposed during V14 preparation.

Official Foundry V14 documentation verifies the lifecycle.

Avoid stale duplicated authority.

---

# 34. Ruleset Formulas Are Not Statistic Responsibilities

If defense eventually differs across:

```text
D&D 2014
D&D 2024
WildPath house rules
```

do not bake those formulas into a generic statistic contract.

PF2e formulas are Pathfinder rules and are not applicable WildPath specifications.

Separate:

```text
statistic evaluation invariant
```

from:

```text
ruleset-specific sources/formulas
```

only where currently necessary.

Do not implement ruleset selection here.

---

# 35. Ability Score Scope

If ability modifiers are required:

inspect whether they already exist.

If missing, add only what current gameplay requires.

PF2e may inform general contribution patterns.

Do not import Pathfinder ability/proficiency assumptions.

Do not redesign WildPath skills.

---

# 36. Proficiency Scope

If ActionDefinitions already contain the complete attack modifier:

do not build proficiency derivation.

If real Actor attacks concretely require proficiency:

determine the smallest representation.

Do not implement progression tables.

---

# 37. Equipment Scope

Do not implement:

* armor equipping;
* shields;
* weapon proficiency;
* equipment loadouts;
* inventory-to-stat derivation;

unless an existing implemented mechanic merely needs connecting.

Canonical persisted/base combat inputs are acceptable placeholders for future equipment derivation if ownership is explicit.

---

# 38. Candidate Construction

Update real runtime candidate construction as needed.

A target candidate should receive canonical plain-data defense information.

No Foundry Document may enter ResolutionState.

Crucible may be consulted to understand appropriate Foundry document-access patterns.

Official V14 docs verify them.

WildPath owns the final candidate contract.

---

# 39. Source Combat Context

Any source Actor statistics required by attack/save RollRequests must enter through a plain application/domain boundary.

No pure resolver reads Foundry Actor Documents directly.

---

# 40. Serialization

New combat-stat data inside:

```text
ActionIntent-derived options
ResolutionState
target candidates
RollRequest
results
```

must remain plain serializable data.

No:

* Map;
* Set;
* Date;
* classes;
* Foundry Documents;
* functions;
* promises.

---

# 41. Production Entry Test Must Start at the Real Boundary

Mandatory.

Do not add only:

```text
planStagedActionResolution(options)
```

tests.

At least one acceptance test must begin from the actual newly wired production layer:

```text
realistic Actor data
↓
realistic Item ActionDefinition
↓
buildFoundryActionUseIntent
↓
production Foundry intent conversion
↓
TacticalGrid
↓
staged pipeline
↓
attack roll
↓
canonical defense
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

Deterministic adapters/providers are fine.

Do NOT inject target defense after staged options are built.

---

# 42. Canonical Defense Test

Mandatory for Outcome A or B.

Use a target Actor with canonical combat-stat data.

Assert production conversion yields the expected candidate defense.

No test-only override.

---

# 43. Defense Modifier Test

If Modifier-derived defense lands now:

```text
base defense X
+
generic Modifier +2
=
effective defense X+2
```

Test it generically.

Preserve provenance where current rules infrastructure supports it.

---

# 44. Hit / Miss Proof

Production-path test should prove:

```text
attack total > defense
→ hit
```

and preferably:

```text
attack total < defense
→ miss
```

using Actor-derived defense.

---

# 45. Damage Persistence Proof

For a hit:

assert target health changes through the normal PersistencePort.

No direct Actor mutation in combat-stat code.

---

# 46. Action Payment Proof

Assert source Action resource is spent exactly once.

Do not invent refund semantics.

---

# 47. Multiplayer Production Proof

Prefer the existing production coordinator fixture:

```text
Player A uses Action
↓
GM authority
↓
Player A supplies RollResult if appropriate
↓
GM evaluates canonical defense
↓
GM commits damage/payment
```

No new networking path.

---

# 48. Reference Systems Must Not Leak Into Tests

Do not write tests asserting:

```text
WildPath behaves like PF2e
```

or:

```text
WildPath behaves like Crucible
```

Tests assert WildPath invariants.

References inform reasoning only.

---

# 49. No Runtime Dependency on References

WildPath must:

* build without PF2e/Crucible;
* test without them;
* run without them;
* package without them;
* operate without network access.

Reference repositories are never imports or dependencies.

---

# 50. Foundry Core Before Custom Infrastructure

Whenever this milestone exposes a Foundry-facing requirement, ask:

> Does Foundry V14 already provide the correct lifecycle/API?

Use Crucible to discover mature use of Foundry facilities.

Use official V14 docs to verify them.

Do not create WildPath infrastructure duplicating a core Foundry facility unless WildPath rules require semantics that Foundry does not provide.

---

# 51. Record Reference Lessons in Documentation

When prior art materially influences the result, document:

```text
REFERENCE OBSERVATION
...

FOUNDRY VERIFICATION
...

WILDPATH DECISION
...
```

For PF2e-only rules observations, Foundry verification may be `N/A`.

Do not paste external source code.

Do not scatter comments such as:

```text
// PF2e does this...
// Crucible does this...
```

through production source.

Prefer architecture documentation.

---

# 52. No-GM / Permission Fallback

Do not modify unless this milestone exposes a concrete defect.

---

# 53. Live Foundry QA Gate

After this milestone, WildPath should ideally support its first genuine live combat smoke test.

If a real Foundry V14 environment exists:

1. Create source Actor.
2. Give it a simple melee Action.
3. Create target Actor with canonical defense/HP.
4. Place Tokens adjacent.
5. Target target Token.
6. Use Action from Actor sheet.
7. Complete roll.
8. Verify:

   * attack outcome;
   * HP;
   * Action resource;
   * multiplayer authority if possible.

Record exact Foundry V14 build.

If unavailable:

```text
Live Foundry V14 QA not performed.
```

Do not fabricate.

---

# 54. Do Not Fix Condition Direct-Mutation Debt

Previous audit identified:

```text
WildPathConditionEffect.applyDelta()
```

as a separate direct-mutation path.

Do not fix here unless directly required.

---

# 55. Do Not Add ResolutionState Combination Validators

Separate hardening issue.

Keep scope focused.

---

# 56. Do Not Refactor Multiplayer Coordinator

Its size is a monitored smell, not justification for unrelated refactoring.

---

# 57. Do Not Implement Movement

Movement remains the next major domain milestone after real combat-stat readiness.

Do not touch the queued Movement prompt.

---

# 58. Do Not Implement Full Character Progression

Explicitly excluded:

* levels;
* classes;
* subclasses;
* multiclassing;
* XP;
* proficiency progression tables;
* spell preparation;
* full equipment derivation;
* skills redesign;
* rest system.

---

# 59. Test Repeated Need Before Generalizing

A generic Statistic primitive is justified only if at least **two current production consumers** need the same evaluation invariant.

Examples:

```text
defense + saving throw
```

or:

```text
defense + attack modifier
```

PF2e's existence does not count as a consumer.

---

# 60. Avoid One-Field Patchwork

Conversely, do not create unrelated:

```text
system.ac
system.attackBonus
system.dexSave
system.spellDc
```

if current evidence demonstrates they immediately need identical Modifier/Predicate/provenance semantics.

Use evidence to find the middle ground.

---

# 61. Expected Implementation Size

This remains a focused milestone.

If solving it requires broad unrelated systems or hundreds of lines of speculative architecture before meaningful tests:

reassess Outcome C.

---

# 62. Documentation

Update only relevant docs.

Record:

* canonical combat-stat ownership;
* persisted vs derived values;
* how defense reaches AttackResolver;
* source attack-modifier flow;
* Modifier/Predicate integration;
* deferred statistics;
* relevant PF2e lessons;
* relevant Crucible observations;
* official Foundry V14 verification where applicable;
* WildPath decisions;
* reference approaches deliberately rejected.

Do not claim the Character System is complete.

---

# 63. Reference Systems Policy Document

If no equivalent policy exists, add:

```text
docs/development/reference-systems.md
```

It should establish the following durable project policy:

```text
PF2e
→ primary benchmark for:
  declarative rules
  statistics
  modifiers/predicates
  actor derivation
  progression
  effects
  hardening

Crucible
→ primary benchmark for:
  Foundry V14 integration
  hooks
  lifecycle
  Documents
  Applications
  canvas
  movement
  Regions
  action UX
  digital-native workflows

Official Foundry V14 docs
→ authoritative platform contract

Rules:
1. WildPath is authoritative.
2. References are prior art, not specifications.
3. Read Crucible to understand Foundry usage, but do not copy its implementation.
4. Verify Crucible-discovered APIs/hooks against official V14 docs.
5. Use PF2e to understand mature rules invariants, not to clone architecture.
6. Prefer existing WildPath primitives.
7. Adopt only the smallest missing invariant.
8. Reference repositories are not dependencies.
9. Foundry core should be reused where it already provides infrastructure.
10. WildPath remains mechanical rules authority where its semantics differ.
```

Do not spend substantial time polishing this file.

---

# 64. Roadmap Status

If successful, roadmap wording should say roughly:

> Real production-entry melee Action is supported using canonical Actor combat statistics.

Do NOT claim:

> Character system complete.

Then Movement may resume.

---

# 65. Verification

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

# 66. Commit

If Outcome A or B succeeds:

create a coherent commit.

Possible messages:

```text
Add runtime combat statistics
```

or:

```text
Resolve actor combat statistics
```

Choose based on actual work.

If Outcome C:

do not create a meaningless implementation commit.

Return the audit result.

---

# 67. Required Completion Report

## Repository Baseline

* initial HEAD;
* branch;
* worktree;
* starting tests;
* typecheck.

## Reference Review

### PF2e

Report briefly:

* relevant files/concepts inspected;
* shared statistic invariant identified;
* useful principles;
* already-solved WildPath equivalents;
* PF2e architecture deliberately not adopted.

### Crucible

Report only concrete Foundry-facing investigation:

```text
CRUCIBLE OBSERVATION
...

FOUNDRY V14 VERIFICATION
...

WILDPATH DECISION
...
```

Do not reproduce Crucible source.

## Audit Result

Choose:

```text
A — isolated/simple combat fields
B — small shared derived-statistic primitive
C — larger Character System dependency
```

Explain with WildPath source evidence.

Reference systems support the conclusion; they do not determine it.

## Combat Statistic Inventory

Cover:

* defense/AC;
* attack modifier;
* saves;
* DC;
* HP;
* initiative;
* abilities;
* proficiency.

## Root Cause

Explain `MISSING_DEFENSE`.

## Architecture Decision

Explain:

* canonical persisted inputs;
* derived outputs;
* Modifier/Predicate reuse;
* provenance;
* ruleset responsibility;
* PF2e lessons adapted/rejected;
* Crucible/Foundry lifecycle lessons adapted/rejected.

## Implementation

List files/contracts changed.

For every new exported concept answer:

> Which concrete current mechanic required it?

## Target Defense Flow

```text
Actor data
→ resolved/plain combat statistic
→ target candidate
→ AttackResolver
```

## Attack Modifier Flow

Show the actual source of the modifier.

If no new work was needed, explain.

## Save/DC Readiness

State actual support vs deferred work.

## Production Melee Vertical Slice

Report whether this succeeds:

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

Report:

* production defense mapping;
* hit/miss;
* damage persistence;
* Action payment;
* multiplayer if applicable;
* Modifier-derived statistic if applicable.

Then:

* final test total;
* typecheck;
* diff-check.

## Architecture Audit

Confirm:

* no Foundry leakage into domain;
* no duplicate stat authority;
* no named-feature branches;
* no unnecessary manager/registry;
* serializable state;
* no runtime dependency on references;
* no copied Crucible implementation;
* Foundry APIs verified where reference research affected implementation.

## Live QA

* performed/not performed;
* exact Foundry build if performed.

## Known Limits

Be precise.

## Git

* commit SHA/message;
* branch;
* worktree.

## Next Recommendation

Answer:

> Is WildPath now ready to return to the topology-aware Movement milestone?

Do not start Movement automatically.

---

# 68. Definition of Success

This milestone succeeds if:

> A normal melee Action initiated through the real Foundry Action-use runtime can derive all combat statistics it actually needs from canonical Actor/system data, evaluate attack against target defense through existing pure resolvers, persist resulting damage and resource payment through existing transaction/persistence boundaries, and complete without test-only combat-stat injection.

The reference-system work succeeds if:

> PF2e helps identify mature rules invariants, Crucible helps identify mature Foundry-native integration practices, official Foundry V14 documentation verifies the platform behavior, and WildPath implements the smallest independent architecture suited to its own goals.

---

# Final Governing Principle

WildPath is transitioning from:

```text
excellent combat engine tested with synthetic character data
```

to:

```text
combat engine that actually understands a real WildPath character
```

Use:

```text
PF2e
→ to avoid rediscovering mature rules-engine lessons

Crucible
→ to avoid rediscovering mature Foundry-integration lessons

Official Foundry V14 documentation
→ to verify what the platform actually supports

WildPath
→ to decide the architecture and implement it independently
```

Reference systems should make WildPath **simpler, more correct, and more native to Foundry**.

They should not make it derivative.

Build only the smallest WildPath-native bridge required by current gameplay.

No more.
