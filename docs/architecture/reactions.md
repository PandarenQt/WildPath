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

- **Uncanny Dodge:** an attack on itself hits; it gains resistance to all damage (`GrantResistance` with no types) until
  that attack is over, which halves it. The Damage stage reads its targets' resistances as they are then
  (`services.damageProfileOf`), not as declared, so a reaction's resistance counts.
- **Hellish Rebuke, Storm's Thunder:** a third window, `action.reaction.after-damage`, opens once an Action's damage is
  planned. Its `damage.applied` event lists the creatures that take some (Temporary Hit Points included) and the creature
  dealing it, whom the reaction targets (`match: {targetTokenId: "{self}", notSourceTokenId: "{self}"}`). The reaction
  resolves before the Action's damage is committed; a slot spell asks its caster for the slot first.

Live (two browsers, 2026-10-19):
- The Bandit Captain's Scimitar hit QA Fighter for 5; Player1 used Uncanny Dodge and the Fighter lost 2.
- The Captain's Scimitar hit QA Caster; Player1 was offered Hellish Rebuke, chose its 3rd-level slot, and the Captain
  failed its save and took 4d10 = 15 fire. Then the Scimitar's 4 damage landed.

- **Its own hit (2014 Divine Smite, 2026-10-19):** a Trigger with `match: {sourceTokenId: "{self}"}` answers its own
  creature's Action, which is otherwise never offered to its own creature. It acts on the creature that Action hit
  (`event.targets[0]`), comes after the targets' own reactions (priority 200: a Parry may turn the hit into a miss
  first), and a critical hit doubles its dice too (`damage.critical` on its child state). A Trigger is now offered only
  when its Action's own costs can be paid (a Reaction for most; a Bonus Action for the 2024 Divine Smite; none for
  Paladin's Smite's), not always a Reaction.
- **Only without another slot spell (Paladin's Smite):** an own-hit Trigger with `onlyWithoutOtherSlotSpell: true` is
  offered only while its creature has cast no spell with a slot this combat turn other than one tagged `smite`
  (`recordSlotSpell` keeps the turn in `flags.wildpath.slotSpellTurn`; outside combat there is no turn, so nothing
  blocks it). Its creature's other `smite` reactions (the 2024 spell) are offered beside it, as options (2026-10-20,
  the maintainer's choice).

Live (two browsers, 2026-10-19, in combat): QA Caster with Paladin's Smite hit the Bandit Captain and was offered only
Paladin's Smite; Player1 spent its free cast for 2d8 = 13, no slot and no Bonus Action. It then cast Cure Wounds with a
3rd-level slot; its next hit offered the 2024 Divine Smite, which took the Bonus Action and the slot for 4d8 = 14.

Live (two browsers, 2026-10-19): Player1's QA Caster hit the Bandit Captain with a Dagger (15 against AC 15). The GM was
offered Parry first and declined; then Player1 was offered Divine Smite, chose a 3rd-level slot, and the Captain took
4d8 = 20 radiant and the Dagger's 2. The slot was spent; the Reaction was not.

- **Once a turn (Stunning Strike, 2026-10-19):** a Trigger with `once: "turn"` is not offered again in the same combat
  turn once used. The provider passes its record key and the turn on the trigger's `payload.once`; the reaction's child
  state carries it as `metadata.once`, and the child's payment writes `flags.wildpath.onceUsed.<key>` on its creature (as
  a once-a-turn ExtraDamage does). Outside combat it is never used up.
- **Stunning Strike:** dnd5e leaves it passive; the converter makes it an own-hit reaction (`OWN_HIT`): 1 Focus Point, a
  Constitution save, and on a failure Stunned with `duration: {value: 1, units: "rounds", expiry: "sourceTurnStart"}`.
  The effect's V14 duration is `turnStart` started on the monk's Combatant, and the GM removes it once V14 marks it
  expired, at the start of the monk's next turn. On a success, its Speed is halved (a `speed.multiplier` of 0.5) and the
  next attack roll against it has Advantage (an effect ending when it is attacked), both until then. shortcut: any melee
  hit counts (not only a Monk weapon or an Unarmed Strike).

Live (two browsers, 2026-10-19, in combat): QA Caster as a level-2 monk hit the Bandit Captain and used Stunning Strike
(1 Focus Point); the Captain failed (2) and was Stunned through its own turn, which ended at the start of QA Caster's
next turn. A second hit in the same turn was not offered it, and with no Focus Points left it was not offered at all.

- **A rider on the Action it answers (2026-10-19).** A reaction's definition may carry `rider`; once the reaction is
  paid for, its `parentDirective` is `{type: "augment", data: rider}`, and the parent's re-evaluation turns it into an
  input patch (`riderPatch`, at any window):
  - `forgoDice: {ruleId, dice}`: that many dice of the planned extra damage from that rule (`metadata.ruleId`:
    "sneak-attack") go unrolled; a component with none left rolls nothing. It is applied once, to the planned component;
    later planning keeps a component's planned dice.
  - `damage`: more components, planned the same way (a table of dice by level is its row), of the Action's damage type
    unless named.
  - `rollMode`: its attack roll's mode (given up Advantage); `tags`: on its later events; `push`: the creatures it hits
    are pushed (forced movement reads `input.riderPush`).
  - Attack-outcome events now carry `extra:<ruleId>` for its planned extra damage and the rider's tags; the declared
    event's data carries `attackRollMode` and `attackAbility`.
- **`whileStatus`** (Trigger data): offered only while its creature has that status (Brutal Strike: "reckless").
- **Reckless Attack** is a free Action; its effect (slug `reckless`) gives Advantage on `attack.might` rolls and on
  attacks against it, until its next turn. Live: QA Caster's Strength attacks had Advantage, its Agility ones did not,
  and the Bandit Captain's attacks against it had Advantage.

- **Cunning Strike (2026-10-19):** three own-hit reactions (Poison, Trip, Withdraw) matching `extra:sneak-attack` (the
  hit's planned Sneak Attack), each with `rider: {forgoDice: {ruleId: "sneak-attack", dice: 1}}`, once a turn between them
  (`onceKey: "cunning-strike"`). Poison and Trip are saves on the creature hit; Withdraw is a self effect (Disengaged, and
  half its Speed more this turn). Live: QA Caster as a level-5 rogue hit the Bandit Captain with a Dagger; it chose Trip,
  the Captain saved (15), and its damage rolled 1d4 and 2d6, not 3d6.

- **Brutal Strike (2026-10-19):** its feature brings three Actions. Brutal Strike answers its barbarian's own declared
  attack (`action.declared`, `whileStatus: "reckless"`, a predicate requiring `attackRollMode` "advantage" and
  `attackAbility` "might"), once a turn; its rider rolls the attack without Advantage, adds 1d10 (2d10 from level 17) of
  the weapon's type, and tags it `brutal-strike`. Forceful Blow (a rider push of 15 ft, and a Disengaged half-Speed self
  effect) and Hamstring Blow (-15 ft Speed on the target until the barbarian's next turn) answer that tagged hit, once a
  turn between them. Live: QA Caster as a level-9 barbarian used Reckless Attack, then Brutal Strike on a Longsword
  attack: it rolled 1d20 + 5 (no Advantage), hit, dealt 1d8 + 1d10, and Forceful Blow pushed the Bandit Captain 15 ft;
  QA Caster was Disengaged with 15 ft more movement.

- **Several options in one window (2026-10-19).** A once-a-turn Trigger's `uses` (a number, or a ValueExpression such as
  a table by class level; default 1) is how many options sharing its `onceKey` its creature may take in one reaction
  window. Once one resolves, the window offers that reactor's remaining siblings again (`siblingReoffer`), until `uses`
  are spent. Improved Cunning Strike: `uses` 2 from rogue level 11; Improved Brutal Strike: 2 blows from barbarian
  level 17. An own-hit reaction without damage (Trip) resolves on a critical hit too: only a reaction with its own
  damage rolls it as critical. Live: QA Caster as a level-11 rogue critically hit the Paralyzed Bandit Captain with a
  Dagger, chose Trip (it fell Prone), was offered the rest again, chose Withdraw, and Sneak Attack rolled 8d6, not 12d6.
- **Improved Brutal Strike (2026-10-19):** two more blows answering a Brutal Strike's hit, on the creature hit until the
  barbarian's next turn. Staggering Blow: Disadvantage on its next saving throw (`endsWhen: "saves"`, ended after an
  Action's save by `endEffectsWhenSaved`) and the `no-opportunity-attacks` status, under which the provider offers it
  no movement reaction or Opportunity Attack. Sundering Blow: a Modifier on `attacked` of +5 whose predicate excludes
  attacks tagged `from:sundered` (the barbarian's own), added to attacks against it through `foundryAttackBonuses`, and
  ended by the next other creature's attack (`endsWhen: "attackedByOther"`). shortcuts: a save outside an Action does not
  end Staggering Blow; Sundering Blows of two barbarians stack.

- **Repelling Blast (2026-10-20):** an own-hit offer marked `spell` drops the `notTagsAny: ["spell"]` of its match, so it
  answers a spell's hit. It answers any cantrip (`tagsAll: ["cantrip"]`, the cantrip house rule), and its rider pushes
  the creature hit 10 ft (`rider.push`, as Forceful Blow's). shortcut: "Large or smaller" is by hand. Live: QA Caster's Eldritch Blast hit the Bandit Captain for 1d10 + 3 (Agonizing Blast), and
  Repelling Blast pushed it 10 ft away.
- **Weapon hit extras (2026-10-20):** an attack's hit event also carries its statistic (`weapon` or `spell`). An own-hit
  offer can answer any weapon's hit (`tagsAll: ["weapon"]`), melee or ranged, once a turn by its `onceKey`:
  - Divine Strike: Radiant and Necrotic are an offer each;
  - Primal Strike: one offer with a damage type choice;
  - Lifedrinker: one offer with a damage type choice.

  Each deals its own damage to the creature hit, doubled on a critical hit. shortcuts: Lifedrinker answers any
  weapon, not only its pact weapon, and its Hit Die heal is by hand; an Unarmed Strike counts as a weapon. Live: QA
  Caster as a level-7 cleric hit the Bandit Captain with a Dagger (3). Both Divine Strikes were offered, and Radiant
  dealt 1d8 (7).
- **Cutting Words (2026-10-19):** `attack.hit` with `notSourceTokenId: "{self}"`, so any creature's hit within 60 ft;
  the bard's reaction targets the attacker. Its rider `attackPenalty: {dice}` is its Bardic Inspiration die, a table by
  bard level. The child rolls it when it pays (`riderAttackPenalty`, reusing `addedDie`) and sends the total. The
  parent lowers its attack roll by that much and checks it again against its targets, as a Parry's AC is. shortcut: its
  use on a damage roll or an ability check, "can see" and hostility are by hand. Live: the Bandit Captain's Scimitar (16)
  hit QA Caster as a level-10 bard; Player1 used Cutting Words, and the attack missed. A Reaction and a Bardic
  Inspiration were spent.

Shortcuts: a Parry's "while holding a weapon", and Counterspell's 60 feet, sight and hostility, are the reactor's to
judge (its Ask setting). Falling (Feather Fall) has no window yet; Retaliation's attack is by hand.

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
