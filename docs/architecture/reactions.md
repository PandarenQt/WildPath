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
- **Only in an encounter (2026-10-20, maintainer).** A mover that is not a combatant of a started combat
  (`movementTracked`) provokes nothing: no Opportunity Attack, and no Item reaction to movement. The token ruler's
  threat labels follow, since they ask the same provider.
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
- **Counterspell:** `action.declared` with `tagsAll: ["spell"]`, `notTagsAny: ["component:none"]` and
  `notSourceTokenId: "{self}"`: another creature's spell, never the reactor's own (without it, Counterspell answered
  itself), and not one with no Verbal, Somatic or Material component. A converted spell's components are tags
  (`component:verbal`, `somatic`, `material`, `costly-material`; `component:none` when it has none). A homebrew spell
  without them can still be countered. Its predicate is "a hostile creature it sees within 60 feet" (`toSource`, below). Its Action has `counters: true`: when its
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
  - **Before its first attack roll on its turn (2026-10-20).** Its `requires` is `not attackedThisTurn`.
    `recordAttackTurn` sets `flags.wildpath.attackTurn` to the combat turn after any attack roll. The authority and the
    action bar both read it through `requiresContext` (`helpers/combat.mjs`). Live: QA Caster's Reckless Attack greyed
    ("can't be used now") after its Dagger attack.

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
  the creature hit 10 ft (`rider.push`, as Forceful Blow's), offered and pushing only one Large or smaller. Live: QA Caster's Eldritch Blast hit the Bandit Captain for 1d10 + 3 (Agonizing Blast), and
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
- **More own-hit offers (2026-10-20):**
  - **Devious Strikes** (rogue 14): Daze, Knock Out and Obscure are Cunning Strike options (`extra:sneak-attack`, the
    `cunning-strike` once-key and uses) giving up 2, 6 and 3 Sneak Attack dice. Daze and Obscure last until the end of
    the target's next turn; only Knock Out (Unconscious, 1 minute) repeats its save.
    - **Daze (2026-10-20):** three `ResourceCap`s with the new predicate `atLeast` on what its creature has spent. Once
      it moves, takes an action or a Bonus Action, the other two are capped at 0. Turn recovery now also zeroes
      `spent`, so a refill doesn't depend on last turn's caps.
    - **Knock Out (2026-10-20):** its Unconscious has `metadata.endsWhen: "damaged"` and remembers the resolutions
      that applied it (`resolutionIds`). `endEffectsWhenDamaged` ends it when its creature takes damage, except from
      that hit.
    - Live: Dazed QA Ally moved 10 ft and had no Action or Bonus Action left; its next turn was full again. Knocked out,
      it stayed down through a miss and woke (still Prone) when the Bandit Captain's Scimitar hit it for 13.
  - **Eldritch Smite**: a weapon hit, once a turn; its required choice spends a Pact Magic slot and deals
    (1 + the slot's level)d8 Force; a second choice knocks the creature Prone or leaves it standing, and Prone lands
    only on one Huge or smaller (`maxSize`). It is offered only while a Pact Magic slot is left. shortcut: any weapon,
    not only its pact weapon.
  - **Hurl Through Hell** (Fiend Patron 14): any attack hit, once a turn, from its pool: a Charisma save; on a failure
    8d10 Psychic and Incapacitated until the end of the warlock's next turn. shortcuts: a Fiend's immunity to the
    damage and Regain Use are by hand.
  - **Giant Ancestry** (Goliath): Fire's Burn (+1d10 Fire), Frost's Chill (+1d6 Cold, Speed -10 until the start of the
    goliath's next turn) and Hill's Tumble (Prone, offered only against a creature Large or smaller) answer any attack
    hit, each paid from its pool.

  Live (two browsers, 14.369): as a Rogue 14, QA Caster's Dagger hits offered Daze; its Sneak Attack rolled 5d6 (7d6
  less 2) and a failed save left the Bandit Captain Dazed. As a Warlock 5, Eldritch Smite spent a pact slot for 4d8
  Force (8d8 on a critical hit) and knocked the Captain Prone; Fire's Burn added 1d10 Fire and spent a use.
- **What hitting a creature costs the attacker (2026-10-22):** a stat block's "a creature that hits it with a melee
  attack takes 4 (1d8) Acid damage" (a Black Pudding's Corrosive Form, an Azer's Heated Body) is an Action with no cost
  and a reaction Trigger on `attack.hit` against its own creature (`tagsAny: ["melee"]`), set to Always: whenever such
  an attack hits, its damage lands on the attacker, even when the hit itself does nothing (the pudding is immune to
  Slashing). shortcut: "while within 5 feet" is not measured, and touching it is the GM's. Live (14.369): each
  Longsword hit on a Black Pudding cost the attacking Token 4 Acid.
- **Retaliation, Stone's Endurance, Countercharm (2026-10-20):**
  - **Retaliation** (barbarian): `damage.applied` on itself from another creature. Its Trigger names a common Action
    (`commonAction: "opportunity"`), so the provider reacts with its creature's first melee attack or Unarmed Strike at
    the damage source, for its Reaction, offered under the Item's name ("Retaliation (Dagger)") and at the Item's Always,
    Ask or Never setting, only when the damager is within 5 ft (`atMost` on `event.data.relations.{self}.distance`).
  - **Stone's Endurance** (Goliath): "when you take damage", from anything. It answers `damage.applied` in its
    `before` phase on itself (the before-damage window below). Its rider `reduceDamage: {dice, bonus}` (1d12 + its
    Fortitude modifier) is rolled when it is paid (`riderRoll`, as Cutting Words' die), and that much comes off the
    damage its own creature takes (`durability.reductionsByTarget`, by its Token), no one else's.
  - **Countercharm** (bard): a test offer with a `range` (30 ft), the conditions it answers (`against`: Charmed,
    Frightened), its `pool` (its Reaction) and a `rollMode` (Advantage). When a creature fails a save against an effect
    giving one of them, it or an ally within range that has it may reroll that save (`withAllyTestOffers`): the saver's
    controller chooses, the reroll has Advantage, and the ally pays. That Advantage is one more source: it cancels one
    source of Disadvantage on the save, source for source (the runtime keeps each target's sources,
    `save.rollModeSourcesByTarget`). 2024 Countercharm has no sight clause.
  - **Indomitable**'s converted Action, which spent a use and did nothing, is gone: the feature keeps the pool the
    engine's reroll pays from (`OFFERED_BY_ENGINE`).

  Live (two browsers, 14.369): the Bandit Captain's Scimitar hit QA Caster for 9; Stone's Endurance took 5 off it. Its
  next hit offered "Retaliation (Dagger)", which attacked the Captain for QA Caster's Reaction. A Wits save against a
  charm failed on a 10; Player1 took "QA Ally's Countercharm", rerolled 2d20kh (20), and saved, with QA Ally's Reaction
  spent.
- **Offered only when it can be paid, and only where it applies (2026-10-20):**
  - **Required choices.** An offer is made only when its Action's costs and every required resource choice can be
    paid (`collectReactionWindows` → `unpaidRequiredChoice`). This covers Eldritch Smite's Pact Magic slot and the slot
    of Shield, Hellish Rebuke, Counterspell and both Divine Smites. The action bar greys such an Action the same way and
    says what ran out ("no 1st-level slot, Pact Magic slots, ...").
  - **Size and distance on events.** `attack.hit`/`attack.miss` and `damage.applied` events carry each target's size
    and distance from the source (`data.relations.<tokenId>: {size, distance}`) and the first target's size
    (`data.targetSize`), so a Trigger's `triggerPredicate` can read them.
  - **Hit offers by size.** Hill's Tumble, Cunning Strike's Trip and Repelling Blast are offered only against a
    creature Large or smaller.
  - **Effects by size.** An Action's effect may name a `maxSize`: a bigger creature is skipped (Eldritch Smite's Prone,
    Huge or smaller; Trip's, Large or smaller), as a push's `maxSize` is. (2026-10-20: the definition's `maxSize` now
    reaches the resolver; before, only a request built by hand carried it.)

  Live (two browsers, 14.369):
  - As a Warlock 5 with no pact slot left, QA Caster's Dagger hit offered Hill's Tumble alone; with one, Eldritch Smite
    too, asking for the slot and whether to knock the creature Prone.
  - Against an SRD Hill Giant (Huge), Hill's Tumble was not offered, and Eldritch Smite was.
  - The giant's Tree Club from 10 ft offered no Retaliation; from 5 ft it did, and the Dagger struck back.
  - With no slots, Hex was greyed with "no 1st-level slot, Pact Magic slots, ..."; one pact slot enabled it.
- **Before damage (2026-10-20).** Every damaging Action has a reaction window after its damage is rolled and before it
  is planned (`action.reaction.before-damage`, timing `before-damage`): a `damage.applied` event in its `before` phase,
  its targets the creatures it will damage (an attack, a save, an area, a fall, a condition's damage at turn start), with
  their sizes and distances. Hellish Rebuke and Retaliation keep answering the `interrupt` phase, after damage. A
  creature's own Action that damages itself (a fall, its Bleeding) offers its own reactions on itself.

  Live (two browsers, 14.369): the Bandit Captain with Stone's Endurance saved against Player1's Hellish Rebuke (10,
  halved) and took 4; fell 20 ft for 7 and took 1; and at the start of its turn absorbed all of its Bleeding.
- **Damage for another creature (2026-10-20).** These use the before-damage window.
  - **The event.** Its `damage.applied` event carries `hit` when an attack roll hit, and `damage:<type>` for each type it
    deals.
  - **Where the creature stands.** Reactions also see `toTarget`: each creature's relation to the first creature
    damaged, that creature itself included as `self`.
  - **Rider fields.**
    - `protects: "target"` keys a reduction to that creature instead of the reactor.
    - `redirectDamage: {to: "self" | "chosen", range}` moves the damage. With `chosen`, the reactor's controller picks
      from the creatures within `range` of it, other than the attacker and the target (`redirectChoice`; the runtime
      lists them with `redirectCandidates`).
    - The damage step then moves that result onto the creature taking it (`redirectedDamage`). Its resistances,
      snapshot and 0-HP rescue apply.
  - **Two results on one creature.** A creature taking two damage results plans each on the snapshot the first left.
  - **Deflect Attacks** (SRD): a hit with bludgeoning, piercing or slashing damage. 1d10 + its Dexterity modifier + its
    monk level comes off the damage it takes, where before it was a manual heal. **Deflect Energy:** any damage type.
    Its Redirect is a new attack and stays a manual Action.
  - **Interception** (PHB): a creature it sees hits another creature within 5 ft of it. 1d10 + its Proficiency Bonus
    comes off that creature's damage. shortcut: its "holding a Shield or a weapon" isn't checked.
  - **Cloud Rune** (Tasha's): it or a creature it sees within 30 ft is hit. The attack becomes another creature's within
    30 ft of it, with the same roll (`sameRoll`, 2026-10-21): against that creature's AC, so a roll below it misses and
    nobody takes the damage. The new creature makes a concentration check like a target (every concentrating creature
    on the Scene but the attacker is in the concentration input; only one that takes damage is checked). Protective
    Bond's damage is taken, not rolled against. shortcut: the attack's other effects stay with the first target.

  - **Protective Bond** (Tasha's): Emboldening Bond's "Bonded" effect carries a Trigger with its own Action
    (`data.action`). The provider offers it as an Item of its creature (`effectReactionItems`), only while the cleric
    who gave the effect has Protective Bond (`giverItem`).
    - **Offered to:** a bonded creature within 30 ft of another bonded creature that is about to take damage
      (`targetEffects.bonded`: the first damaged creature's effects by name).
    - **What it does:** it takes the damage (`redirectDamage: {to: "self"}`) and teleports to the nearest free space
      beside that creature (`teleportNextTo` → `riderTeleport`, `spaceBeside`).
    - shortcut: Expansive Bond's 60 ft and resistance aren't applied.

  - **Creature types (2026-10-21).** An NPC carries its creature type (`details.type`, `details.subtype`, converted from
    dnd5e; a custom one is its label), a character `humanoid`. A reaction's predicates see the first target's
    (`targetType`), as an attack's do (`attack.targetType`). Divine Smite's Undead or Fiend version is offered only on
    such a creature, the plain one only on any other: live, on a Zombie only the first, on a Bandit Captain only the
    second. World migration 4 gives an NPC converted earlier the type of its compendium creature.

  Live (two browsers, 14.369):
  - **Protective Bond.** QA Caster with Emboldening Bond and Protective Bond bonded QA Ally and QA Fighter, the
    Fighter 20 ft from the Ally. The Captain's hit on QA Ally (8) offered Protective Bond. QA Fighter teleported beside
    QA Ally and took the 8, and its Reaction was spent.
  - **Interception.** The Bandit Captain's Scimitar hit QA Ally for 7. Player1 declined Cloud Rune and took
    Interception for QA Fighter, whose Reaction was spent; QA Ally stayed at 10.
  - **Cloud Rune.** The next hit (8) offered Cloud Rune, then a choice of QA Saver, QA Wizard or QA Fighter. QA Wizard
    went from 10 to 2, and QA Ally took nothing.
- **Cutting Words (2026-10-19):** `attack.hit` with `notSourceTokenId: "{self}"`, so any creature's hit within 60 ft;
  the bard's reaction targets the attacker. Its rider `attackPenalty: {dice}` is its Bardic Inspiration die, a table by
  bard level. The child rolls it when it pays (`riderAttackPenalty`, reusing `addedDie`) and sends the total. The
  parent lowers its attack roll by that much and checks it again against its targets, as a Parry's AC is. It answers
  only a hostile creature it sees within 60 feet (`toSource`).
  - **On an ability check (2026-10-20):** a second Trigger on `check.succeeded`, a new event in a new window after an
    Action's check succeeds (`after-check-outcome`). The same `attackPenalty` lowers that check, which is judged again
    against its DC (`recheckAfterPenalty`).
  - **On a damage roll (2026-10-20):** "Cutting Words (Damage)", an Action the main one grants. It reacts to
    `damage.applied` before the damage is planned. Its rider `damagePenalty` takes its die off the rolled damage
    components in order, before any target's share (half on a save) is worked out.
  - A rider's die may also be a flat amount (`{type: "constant"}`), for homebrew.
  - Live (two browsers, 14.369): the Bandit Captain's Scimitar rolled 5 against QA Ally. Player1's QA Caster (bard 10)
    used Cutting Words (Damage), rolled a 1 on its d10, and QA Ally took 4. Live: the Bandit Captain's Scimitar (16)
  hit QA Caster as a level-10 bard; Player1 used Cutting Words, and the attack missed. A Reaction and a Bardic
  Inspiration were spent.

**Relation to the source (2026-10-20).** Each event's predicates see every reactor's relation to its source,
`toSource.<tokenId>` (`relationsToSource`, `adapters/foundry-v14-reaction-provider.mts`):
- `hostile`: opposed Token dispositions;
- `distance`: feet between their spaces;
- `sees`: it perceives the source (Blinded, Invisible, light: `attackSight`) and no wall gives the source Total Cover
  from it.

Each value is worked out only when a predicate reads it. An event without a source Token on the Scene has none, so
"a creature you can see" fails. The reaction services supply them as a function of the event (`reactions.context`),
which the pipeline resolves for each event, nested reactions included.

The maintainer's choice: Counterspell and Cutting Words answer only a hostile creature (no prompt on an ally's spell or
hit). Live (two browsers, 14.369): QA Wizard (hostile, 15 ft) was offered Counterspell on Player1's Fire Bolt. Through
the same discovery, it was not offered as an ally, at 75 ft, or behind a wall.

Shortcut: a Parry's "while holding a weapon" is the reactor's to judge (its Ask setting). Falling (Feather Fall) has no
window yet.

## Current Limits

Built since this list was first written (2026-10-21): reaction windows after an action is declared, after an attack's
and a check's outcome, and before and after damage, with staged movement's before-transition windows
([staged-movement.md](staged-movement.md)); production reaction content (Counterspell, Shield, Parry, Cutting Words,
Protective Bond); Opportunity Attacks for every creature (above); and each reaction's Ask/Always/Never setting on the
action bar.

Not yet implemented:

- a window for falling (Feather Fall)
- full simultaneous reaction ordering

Automated verification was 729/729 at repair commit
`ddb26f6591c95db9b5dc21a856d3bfa5f15f90e4`. The generic movement-event path also passed the full
real Foundry V14.367 multiplayer Decline/Accept/Terminate gate. See the
[accepted live result and regression runbook](../development/movement-reaction-qa.md). Broader
semantic timings remain driven by actual gameplay consumers.
