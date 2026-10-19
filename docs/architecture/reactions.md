# Reactions And Interruptible Child Resolution

WildPath reactions are normal triggered Actions, not a second action engine.

Current implementation lives in `module/resolvers/reaction-resolver.mjs` and builds on:

- semantic automation events from `module/helpers/automation-events.mjs`
- Trigger RuleElement contributions
- Predicate evaluation inside trigger matching
- Action Economy payment discovery for Reaction/custom resources
- `reaction-choice` pending requests in `ResolutionState`
- `createChildResolutionState()` ancestry and loop protection
- normal staged child Actions for reaction execution and resource commit
- existing multiplayer pending-request routing

## Concepts

The resolver keeps three concepts separate:

- Semantic event: a factual occurrence such as `attack.hit` or `action.declared`.
- Reaction window: an addressable interrupt point opened by a parent resolution.
- Reaction action: an ordinary `ActionDefinition` made available by a matching Trigger.

Events are facts, not UI commands. The engine should not emit events such as
`PromptDefenderForReaction`; it should emit facts like an interrupt-phase attack hit and then let
Triggers and Predicates decide whether a reaction is eligible.

## Discovery

`discoverReactionCandidates()` wraps the existing trigger/reaction-window helper and returns ordered
`ReactionCandidate` data. A candidate preserves:

- reactor Actor/Token refs
- reaction Action ref and optional ActionDefinition snapshot
- trigger id and source/provenance
- triggering event snapshot
- chooser metadata
- available payment options and selected default payment

Discovery is non-mutating. Spent reaction resources are rejected by Action Economy; the
ReactionResolver does not maintain its own `reactedThisRound` flag.

Ordering is deterministic:

1. trigger priority
2. explicit initiative/combat actor order when supplied
3. stable reactor actor id
4. stable action ref/id
5. stable trigger id

This is intentionally simple until the combat/timeline layer provides richer ordering policy.

## Windows And Requests

`planReactionWindow()` stores a plain `ReactionWindowState` under
`ResolutionState.metadata.reactionWindows` and either:

- closes immediately when no candidates are eligible, or
- creates one `reaction-choice` pending request for the next reactor's candidate group.

Multiple options for the same reactor are presented in one request with a Decline option. Multiple
reactors are offered in deterministic order; declining the current group advances to the next group.

**Opportunity Attacks for every creature (2026-10-14, after Baldur's Gate 3).** The production reaction provider
gives each creature on the Scene a common Opportunity Attack, unless an Item of its own reacts to movement (even
one switched off or set to Never):
- **The attack.** Its first melee attack Action, else its Unarmed Strike, costs its Reaction. The weapon's
  definition id is kept, so the weapon's own modifiers count.
- **When it triggers.** A hostile creature leaves its reach (`relations.{self}.leavesReach` and `hostile`).
- **Disengage.** A mover with the `disengaged` status provokes none.
- **The setting.** Its Always, Ask or Never setting is the creature's own:
  `flags.wildpath.commonPolicies.opportunity`, set from the Common group on the action bar.

A reaction's attack now rolls with the same advantage, disadvantage and forced critical hits as any attack:
`attackRollMode` and `attackForcesCritical` (combat-statistics.mjs) serve the Action runtime and reaction children
alike. Predicates see `attack.adjacent` from the two footprints.

Live (two browsers): the GM set the Bandit Captain's Opportunity Attack to Always. When Player1's Prone caster left
its reach, the Captain struck with its Scimitar, rolling 2d20kh + 5, with no prompt. Moving towards it provoked
nothing. After Disengage, leaving provoked nothing.

**Always, Ask or Never (2026-10-14, after Baldur's Gate 3).** Each reaction's Action Item may store
`flags.wildpath.reactionPolicy`:
- `ask`, the default: the reactor's controller is prompted, as above;
- `always`: when its reactor's group is offered, the first such reaction is used at once. The stage answers
  its own request, so no one is prompted. This also applies after an earlier reactor declines;
- `never`: the production reaction provider leaves it out, so its creature does not even watch movement for it.

Players switch it from the action bar. The authority reads it from the Item when it gathers reactions.

The request payload is presentation-safe. It includes candidate summaries, cost/payment metadata,
source/provenance, and the event snapshot, but not mutation plans, live documents, functions, or a
full parent `ResolutionState`.

## Stage Boundary

`createReactionWindowStage()` is a thin ResolutionState stage helper. It can be inserted at explicit
pipeline boundaries and will:

```text
semantic event
-> discovery
-> no candidates: continue
-> candidates: wait on reaction-choice
-> decline: continue/advance to next reactor
-> use: create child state and pause parent
```

The staged action pipeline now opts into two addressable reaction stages when the parent state or
runtime services expose reaction discovery options:

- `action.reaction.after-action-declared`, after configuration and before target/roll resolution
- `action.reaction.after-attack-outcome`, after attack outcome and before damage planning

These stages use the same generic window/request helper. Additional timings should be added as
semantic events prove they are needed, not as named-feature branches.

## Parent And Child

Selecting a reaction creates a child `ResolutionState` with:

- `relationship: "reaction"`
- parent resolution id
- triggering event/window metadata
- candidate/source provenance
- incremented depth
- inherited trigger identity history

The parent moves to `paused` with no pending prompt while the child is active. The child can be run
through the normal staged action pipeline, which means reaction costs, rolls, effects, and commits
use the same ActionDefinition, RollProvider, transaction, and persistence boundaries as any other
Action.

The selected child state is also copied as plain data into
`metadata.activeChildResolution` on the parent so the authority/runtime layer has a serializable
handle while the parent is paused. `completeReactionChildResolution()` clears that handle when the
window completes.

Parent and child transactions remain separate. This lets a reaction commit before the parent
re-evaluates downstream consequences that the reaction may have changed.

## Re-Evaluation And Cancellation

`completeReactionChildResolution()` resumes the parent after the child finishes. It accepts a runtime
re-evaluation callback so the owning domain can recalculate the relevant downstream result. For
example, AttackResolver can recalculate an attack outcome after a defensive child Action changes the
observed defense value. ReactionResolver coordinates the timing; it does not decide attack rules.

Child results may carry an explicit parent directive. The first supported directive is
`cancel-parent`, which cancels the parent with structured state instead of throwing an exception for
normal gameplay interruption.

If a child fails or is cancelled, the current default policy resumes the parent safely and records
the failure. Callers can request parent cancellation for stricter mechanics.

## Multiplayer

No reaction-specific socket engine was added. `multiplayer-action-coordinator.mjs` now accepts
injectable resolution runners while defaulting to the staged action runner. This lets reaction
windows reuse the existing `PENDING_REQUEST` / `REQUEST_RESPONSE` protocol, chooser validation,
wrong-user rejection, duplicate/stale handling, and active-GM authority policy.

The authoritative client owns the parent and child resolution state. Remote players only answer
plain pending requests.

When a parent `ResolutionState` is paused with `metadata.activeChildResolution`, the default
multiplayer coordinator advances that nested child through the same staged action pipeline before
resuming the parent. Child pending requests use the child `resolutionId` in the existing socket
envelope and still route through ordinary chooser policies. The parent initiator is not inherited as
the chooser for nested source-controller child requests; ownership is derived from the child state
source/controller maps, with normal GM fallback policy if no controller is available.

Terminal child completion is idempotent. Replayed completion or request-response messages do not
re-run child commits, re-apply child effects, or resume the parent a second time.

Failed/cancelled child completion retains a bounded plain `results.reactions[].childOutcome`
before clearing the active child. It contains the child ID/status, failed stage, error and trace
projections, action-result code, target-preparation failures, and transaction/rollback operation
provenance. Lists are bounded to eight entries and strings to 1,024 characters; document objects
and arbitrary payloads are never retained. The summary applies to all reaction Action children and
does not alter either parent failure policy. See the [commit reproduction record](../development/nested-reaction-child-commit.md).

## Loop Protection

Reaction child creation uses `createChildResolutionState()`, so existing depth limits and repeated
trigger identity checks apply to reaction chains. Nested reactions are possible, but repeated
candidate/event/action identities are rejected structurally instead of recursing forever.

## Current Tests

`test/reaction-resolver.test.mjs` covers:

- Trigger/Predicate-based candidate discovery
- unavailable reactions through spent Action Economy resources
- serializable `reaction-choice` requests
- zero-candidate windows closing without prompts
- deterministic multi-reactor ordering and decline advancement
- reaction-window stage pause/resume behavior
- normal child staged Action execution and Reaction resource commit
- generic outcome re-evaluation that can turn a preliminary hit into a miss
- explicit interrupt/cancel parent directives
- repeated-trigger loop protection
- multiplayer chooser routing and wrong-user rejection through the existing coordinator

`test/reaction-pipeline-integration.test.mjs` covers the first staged integration proof:

- action-declared and after-attack-outcome reaction windows inside the normal action pipeline
- a defensive child Action that commits a condition effect and Reaction payment before the parent
  attack re-evaluates from hit to miss
- decline and still-hit paths that continue into parent damage/payment without duplicate mutation
- a disruptive child Action that can cancel the parent through an explicit parent directive
- default multiplayer child orchestration with the defender as chooser and the active GM as
  authority
- a nested child attack roll routed by child `resolutionId` through the existing physical
  RollProvider/request-response flow
- duplicate response handling after parent/child completion without duplicate mutation

## Reactions From Content (2026-10-19)

Converted reactions carry a reaction `Trigger` on their own Action, so the engine offers them (`REACTIONS` in the
converter, by dnd5e identifier):
- **Shield, Parry:** `attack.hit` with `match: {targetTokenId: "{self}"}`, an attack on the reactor that hits. Parry also
  needs `tagsAny: ["melee"]`: an attack's hit and miss events now carry the attack's type (`melee`, `ranged`) among their
  tags. Parry's bonus (dnd5e keeps it in the activity's roll) is an effect on itself, `+N` to `defense.ac`, that ends once
  that attack is over (`endsWhen: "attacked"`). The attack is then checked again with the new AC.
- **Counterspell:** `action.declared` with `tagsAny: ["spell"]` and `notSourceTokenId: "{self}"`: another creature's
  spell, never the reactor's own (without it, Counterspell answered itself). Its Action has `counters: true`: when its
  target (the caster) fails the save, the child sets `results.parentDirective` to `cancel-parent` (code `COUNTERED`), and
  the spell is cancelled before anything of it resolves. The coordinator's new `afterCancelled` hook then spends the
  caster's Action, Bonus Action or Reaction (2024: wasted), never its slot, and posts "Fire Bolt fails. Counterspell
  stopped it." A creature's Spellcasting that casts these (a Mage's Protective Magic) keeps the spell's Trigger.

Live (two browsers, 2026-10-19):
- Player1's QA Fighter hit the Bandit Captain (22). The GM was offered Parry and used it: the attack was checked again
  against AC 17 (15 + 2), still hit, and the Captain's Reaction was spent.
- Player1's QA Caster cast Fire Bolt with an SRD Mage 20 feet away. The GM was offered Counterspell; the Caster failed
  its save (6), Fire Bolt did nothing, its Action was spent, and both clients read "Fire Bolt fails. Counterspell stopped
  it." The Mage's Reaction and a Protective Magic use were spent.

Shortcuts: a Parry's "while holding a weapon", and Counterspell's 60 feet, sight and hostility, are the reactor's to
judge (its Ask setting). Reactions to damage taken (Hellish Rebuke) and to falling (Feather Fall) have no window yet.

## Current Limits

Not yet implemented:

- Action reaction windows beyond action-declared and after-attack-outcome timings (staged movement
  adds before-transition windows with `leavesReach`/`entersReach` relations; see
  [staged-movement.md](staged-movement.md))
- production defensive/disruptive reaction content
- opportunity attacks as production content
- full simultaneous reaction ordering
- final HUD presentation

Automated verification was 729/729 at repair commit
`ddb26f6591c95db9b5dc21a856d3bfa5f15f90e4`. The generic movement-event path also passed the full
real Foundry V14.367 multiplayer Decline/Accept/Terminate gate. See the
[accepted live result and regression runbook](../development/movement-reaction-qa.md). Broader
semantic timings remain driven by actual gameplay consumers.
