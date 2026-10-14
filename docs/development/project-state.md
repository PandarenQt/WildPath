# WildPath — Current Project State

Last verified: 2026-10-13.

- Branch: `milestone/action-runtime-live-proof`.
- Starting HEAD for Quench Q1: `85344524f75e2620c3bc1990e5c75cca7c463602`.
- Quench Q1 implementation commit: `75ef1fb738433367b549a2171d6665be894a24c4`.
- Starting HEAD for the custom-pool persistence repair: `5e8ec1453be842c00b39fb04a1099cdb38f0cb98`.
- Starting HEAD for Quench Q2: `5e8ec1453be842c00b39fb04a1099cdb38f0cb98` (Q1 repair and live-status documentation already uncommitted).
- Staged-movement QA commit: `7c12977`.
- Movement implementation commit: `87ed1fae93271b81b14432bb4312be9cd53285c5`.
- Original milestone starting HEAD: `ea484fd8b503697ddf1c2b7b0f6984ea594378e2`.
- Local main HEAD: `61d6268b838e286728c829924506c6c931174621`.
- Portable full suite (`FOUNDRY_V14_APP_PATH` unset): **931 tests, 929 passed, 0 failed, 2 intentionally skipped**.
- M3 slice 5 delta from 921/919/0/2: **10 new tests** (lasting areas: validation, turn-start burn once per
  turn, an emanation following its caster, an empty area still happening, expiry, concentration; movement:
  a voluntary move stopping on entry, a forced move continuing, and an aura sweeping a creature).
- M3 slice 4 delta from 918/916/0/2: **3 new tests** (an area recomputed by the authority from its clicks,
  an out-of-range or unplaced area refused with at most two points travelling, and square corners on a
  Foundry-convention grid). Quench **65/65** (new `wildpath.areas` batch, 3 cases).
- M3 slice 3 delta from 915/913/0/2: **3 new tests** (a counterattack offered after a hit, used and
  declined, and a bystander's `{self}` that does not match an attack on someone else). Quench **62/62**.
- M3 slice 2 delta from 913/911/0/2: **2 new tests** (a before-step reaction resolves inside the step's
  approval, then lets the step play or stops the movement). Quench **62/62** live on 14.369.
- M2 delta from 893/891/0/2: **6 new tests** (dice policy context and provider choice, re-prompt on a
  rejected answer, total bounds, prompt bounds, entered rolls on the card).
- Representative-gate delta from 889/887/0/2: **4 new tests** (save routed to the target's Player,
  distinct `anyOf` payment ids, two evidence-validation tests).
- M1 fixes delta from 886/884/0/2: **3 new tests** (configuration answer reads choices only, dotted
  resource keys in Foundry's persisted shape, ArrayField element-path folding).
- Visible-results delta from 879/877/0/2: **7 new tests** (Roll JSON guard, publish port, Token names,
  and four in `test/chat-card.test.mjs`).
- Authority-hardening delta from 863/861/0/2: **16 new tests** (including payment overflow, Action ownership,
  decisions-only refinement, the parameterized secret-sentinel suite, error allow-list, bounded
  coordinator/movement records, `pushBounded`).
- Review-fix delta from 864/862/0/2: **-1 test** (the User#query self-send path was unreachable behind the routed transport and was removed with its test).
- Confidentiality-hardening delta from 834/832/0/2: **30 new tests** (23 in `test/multiplayer-disclosure.test.mjs`,
  5 schema-2 evidence tests, 1 reaction-choice disclosure test in `test/staged-movement.test.mjs`, 1 nested-child
  disclosure test in `test/foundry-nested-reaction-commit.test.mjs`); batch inventory check extended to nine batches.
- Level-5 evidence-export delta from 825/823/0/2: **9 new tests** in `test/staged-movement-evidence.test.mjs` (commit `a009d3f`).
- Staged-movement position-verification repair delta from 821/819/0/2: **4 new tests** in `test/staged-movement.test.mjs` (commit `e30d752`; generated `.mjs` rebuilt).
- Quench staged-movement batch delta from 811/809/0/2: **10 new portable tests** (two fixture, eight orchestration; commit `b22e287`).
- Combat-slice delta from 808/806/0/2: **3 new portable tests** (Scene/Token/Combat fixture ownership, cleanup ordering across collections, read-only orphan listing); batch inventory check extended to seven batches.
- Q2 delta from 807/805/0/2: **1 new portable test** for scoped ActiveEffect fixtures; registration and GM-guard checks extended.
- Repair delta from 797/795/0/2: **10 new tests** (9 Actor resource persistence cases and 1 assertion-failure cleanup case); existing turn-recovery coverage strengthened.
- Prior installed-source check: `foundry-nested-reaction-commit.test.mjs` **11 passed, 0 failed, 0 skipped**, including both optional tests against V14.367; not rerun for Q1.
- Typecheck, changed-module syntax checks, and diff whitespace checks passed. No generated runtime sources changed; the prior implementation build remains the last build verification.

These figures cover the Combat-slice worktree on top of the committed Q2 implementation and the
live-confirmed Q1 custom-pool repair. Q2 and the repair were committed together as `0586485`; the
local scratch file `docs/development/nextPromptForCodex.md` was untracked and ignored in `33bb766`;
the Combat slice was implemented after `04ae4d1`. Verify actual HEAD, branch, worktree, and
subsequent changes before relying on them.

## Product and invariants

Build a composable automated Foundry V14 rules platform. Preserve plain ResolutionState,
existing staged Action/Reaction orchestration, full square/hex TacticalGrid footprints, generic
resource payment, exact synthetic Actor identity, and authoritative transaction-backed persistence.
Callbacks and Foundry Documents remain outside serialized rules state. Code defaults must not
turn configured reaction content into a second combat engine.

## Current milestone

**M1 — Stage D close: visible results and the representative gate (CLOSED 2026-10-13).** Every
completed Action posts one chat card from the public projection (`4d96df0` plus the `gm-only`
participant repair). Live smoke run on 14.369 through the real `Item.use()`: Hit in `public` mode
posted one card authored by Player1 with the `1d20 + 4` roll attached and rendered; Miss in `gm` mode
posted one card whispered to the GM with no rolls, visible to its author; both proofs passed on both
clients. That run found that the participant result dropped the player's own `gm-only` attack roll
(the player's proof failed); the participant now keeps `gm-only` rolls whose request names the source
controller as roller. The card layout (Action icon and name header, one row per target with an outcome
badge, hidden Tokens unnamed) takes its structure from Crucible's action card; no Crucible markup or
CSS is used (its licence grants no reuse). The outcome strings are WildPath's own (AGENTS §22 amended
2026-10-13: functional UI copy is written by the agent, kept in `lang/en.json`, reviewed by the
maintainer; `test/ui-copy.test.mjs` fails if code uses a `WILDPATH.*` key without copy). Quench: the new
`wildpath.action-results` batch (public, gm, blind) and the full ten-batch suite ran **53/53** live on
14.369, orphan check empty.

The representative set now runs live on one GM client (`wildpath.representative-actions`, 7/7; full
suite **60/60**). Its first runs exposed, and these changes fix: (1) Foundry expands dotted keys in
Document data, so `levelByResourceId: {"spell-slot.2": 2}` persisted as `{"spell-slot": {"2": 2}}` and
scaling failed; configuration lookups now read both shapes. (2) V14 silently drops ArrayField element
paths, so every staged pool payment (`system.pools.<i>.value`) committed "successfully" without
changing the pool; the Foundry persistence adapter now folds element paths into one whole-array write
from detached source. Separately, a client could put `configuration.effectiveDefinition` in an intent
or configuration answer and the authority used it; it now reads choices only.

**Decided 2026-10-13 (maintainer): every matching attack domain stacks.** Eligibility comes from
the modifier's source and predicate: an Action Item's own modifiers count only for that Action (a +2
sword), Features/Gear/effects are Actor-wide (proficiency, an archery feat on `attack.ranged`), and
predicates see the attack's tags. Defenses stack `defense.<key>` and `<key>`. See `attack-resolver.md`.

The two-browser gate (`representative-live-qa.md`) passed 5/5 on 14.369 with committed evidence:
Player-routed attack and damage rolls, a trip, a GM's save routed to the target's Player, healing, and a
configuration prompt answered by the Player in the real dialog. It found and fixed two more defects:
the save fell back to the GM because target controllers were keyed only by the synthetic Actor uuid
(`efe50de`), and `anyOf` payment alternatives all had the id `payment-1`, so the Player could not choose
Slot 2 (`765259f`).

Limits carried forward: no third client.

**M2 — request and roll gaps (CLOSED 2026-10-14).** Everything below is live-verified on 14.369, in two
browsers unless marked Quench.

- **Dice policy:** `wildpath.dicePolicy` chooses digital or physical dice (GM-controlled). Physical dice go
  through the roll prompt and keep `physical` provenance.
- **Roll bounds:** every roll whose formula is complete is bounded; before this, any damage total was
  accepted, including 999 or a negative number. A rejected typed answer is notified and asked again;
  a typo used to strand the Action at `awaiting-roll`.
- **Chat card:** entered rolls appear on the card with the authority's formula and the validated total.
- **Target refinement:** the prompt starts from the authority's default selection (`c9742c8`). Its live
  case found that unlinked Tokens of one base Actor shared target-Actor keys, so the kept goblin's hit
  landed on the dropped one (`d96dbcb`).
- **Per-target saves:** each creature's controller rolls its own save (`702e8d8`).
- **Per-roller message mode:** saves follow the roller's message mode (a Player's public save is on the
  card).
- **Concentration:** a new `action.concentration` stage checks each damaged, concentrating creature (a save
  by its controller, DC from the damage), and a failure ends the effects it sustains in the same
  transaction. Concentration is derived from effects' `concentration.sourceRef`, so there is no schema
  change (Quench).
- **Failure feedback:** a failed Action is reported by private notification, never a public card.
- **UI copy:** prompts, buttons, notifications and the dice setting have WildPath copy ("Enter your roll",
  "Die result (1d20 + 4)", "Confirm").

**M3 — Stage I: persistent spatial mechanics.** Slice 1 done: a production reaction
provider (`createFoundryReactionProvider`, installed as `game.wildpath.reactionServices`) derives
staged-movement reactors from the world. It reads `Trigger` RuleElements of kind `reaction` on active
Items, takes reach from the reaction Action's range and hostility from Token dispositions, and binds `{self}`
in predicate paths. Live in Quench: a hostile guard's authored opportunity attack hit a friendly mover
leaving reach, with no injected services. Slice 2 done: native drags resolve before-step reactions inside
each step's checkpoint approval. The step is held, the reaction resolves, then the step plays with
Foundry's ruler and animation. This was verified live in two browsers: accept (player move), decline,
and accept on the GM's own move ([movement-paths.md](../architecture/movement-paths.md#before-step-reactions-in-native-drags)).
A refused movement now shows one notification instead of two. Slice 3 done: ordinary Actions get
production reactions. Triggers on `action.declared`, `attack.hit` and `attack.miss` come from the world.
`match: {targetTokenId: "{self}"}` reads "an attack on me" per Token, and a reaction Action targets the
triggering creature (or itself). A completed reaction posts its own public card. Verified live: a
player's Strike was answered by a GM guard's Counterattack, with two cards
([rule-elements.md](../architecture/rule-elements.md#current-integration)). A reaction that cancels the
triggering Action (Counterspell-like) still needs an ActionDefinition field for the parent directive. That
is a data-format decision. Slice 4 done: area targeting. A player places a radial area with one click,
or a cone or line from a corner of their Token's edge plus a direction. The highlight shows exactly the
fields that resolve, and the authority recomputes the area and its targets from the clicks. Verified live
on square and hex grids for all three shapes
([areas.md](../architecture/areas.md#using-an-area-action-in-foundry)). This also fixed vertex mapping on
real Foundry grids. Slice 5 done: lasting areas, auras and hazards, per the maintainer's decisions of
2026-10-14 ([areas.md](../architecture/areas.md#persistent-areas)).
- A lasting area is a Foundry Region holding WildPath's rules in `flags.wildpath.area`.
- Its triggers (on entering, at turn start, at turn end) resolve as authority Actions, at most once per
  turn by default. Elevation bands let several areas share a field.
- A voluntary move stops on entering an area that affects the mover, and the rest of the move stays
  unspent.
- Auras move with their caster and enter the creatures they sweep over.
- Areas run out after their rounds, or when concentration breaks.
- All of it was verified live in two browsers.

**M3 — CLOSED on 2026-10-14.**

**M6 — product surfaces (started 2026-10-14).** The character sheet is complete for what exists
([ui-ux-layer.md](../architecture/ui-ux-layer.md#character-sheet-m6-2026-10-14)). It found and fixed a
nested `<form>` that had kept every actor and item sheet field edit from saving. The in-play action bar
shows the creature in focus and uses its Actions through `Item.use()`. The GM's Rules Inspector explains each
resolution from the authority's records. Transformations can be started from an Action (Wild Shape), with
Tokens taking the form's size, and Actions can summon creatures their caster controls. The Homebrew Builder's
first slice is on the item sheet. It edits an Action's definition and any Item's RuleElements as JSON, and the
engine's validators check each edit before it is saved
([homebrew-content-builder.md](../architecture/homebrew-content-builder.md#first-slice-json-editors-2026-10-14)).
Effects got the same RuleElements editor. Later the same day:
- Summons join their caster's combat right after it.
- A transformed creature can't cast spells.
- Actions can make the acting creature's own ability check, which decides what they do
  ([action-definitions.md](../architecture/action-definitions.md#ability-checks-2026-10-14)).
- An ally can stabilize a dying creature.
- Saves, checks and initiative add the ability modifier automatically (maintainer decision), and concentration
  saves add the Fortitude save bonus ([rolls.md](../architecture/rolls.md)).
- The sheets' remaining English moved to `lang/en.json`.
- An in-play combat carousel shows the running combat's turns
  ([ui-ux-layer.md](../architecture/ui-ux-layer.md#combat-carousel)).
- Attacks add their ability modifier (finesse is an attack property), and weapon damage adds it once
  ([attack-resolver.md](../architecture/attack-resolver.md)).
- The unused legacy `useAction` path and eight dead exports were removed.
- The GM can answer for a Player who leaves a request waiting, from the Rules Inspector (Shift+I)
  ([multiplayer-authority.md](../architecture/multiplayer-authority.md)).

**Homebrew Builder, Phase A: engine fixes and primitives (2026-10-14, done).** The builder's release examples
needed engine work first (plan: builder in the sheets, engine first). Each item is live-verified in two browsers on
14.369:
- A whole-definition save replaces nested objects.
- Damage and healing roll per component, so the Flaming Longsword works and dice healing works; formula bonuses
  are kept.
- RuleElement predicates see the roll's tags and the creature's conditions.
- Damage bonuses (`damage.*` Modifiers; Rage +2), and reaction attacks get their damage modifier.
- Custom effects (an Action's buffs and debuffs, V14-native durations, refreshed rather than stacked). `ref`
  effects are refused, and `self` and `none` targeting are enforced.
- Shield as a real reaction effect.
- `ExtraDamage` with once-per-turn.
- `Aura`.
- Long rests restore short-rest resources, and the unused `GrantActionEconomyResource` was removed.

**Homebrew Builder, Phase B: the Action Builder (2026-10-14, done).** An Action's item sheet opens on a Builder tab
of plain fields and formulas, with the JSON editors on an Advanced tab. It writes only what the user changed
([homebrew-content-builder.md](../architecture/homebrew-content-builder.md#second-slice-the-action-builder-2026-10-14)).
Live: Flame Burst was built with the Builder alone, and a Player cast it at two creatures (half on a success).


**Homebrew Builder, Phase C: rule rows (2026-10-14).** RuleElements are rows on every Item's Rules tab, in an
Action's custom effects, and on the effect sheet. The rows cover bonuses, advantage, resistance, immunity, Speeds,
resource pools, extra damage once per turn, and auras with their own rows, each optionally "while" a condition
([homebrew-content-builder.md](../architecture/homebrew-content-builder.md#third-slice-rule-rows-2026-10-14)).
Live: an aura feature and a Shield reaction were built through the UI alone and worked.
Then the Test tab dry-runs an Action through the real pipeline against a sample target and commits nothing; spells
can use a spell slot with upcast dice; and buff, debuff, aura, reaction and Legendary Action templates were added
([homebrew-content-builder.md](../architecture/homebrew-content-builder.md#fourth-slice-test-tab-spell-slots-and-more-templates-2026-10-14)).
Phase C is done; Phase D (duplicate, export and import, trigger and monster builders) is next in the plan, after
the smaller product gaps (Phase E).

**Phase E, smaller product gaps (2026-10-14, in progress).**
- **Equipment.** Gear rows can be equipped and unequipped, with quantity, weight and a carried total. The header
  shows the effective AC, and the base AC is editable
  ([ui-ux-layer.md](../architecture/ui-ux-layer.md#character-sheet-m6-2026-10-14)).
  Live, a Player equipping a +2 shield took the header from AC 10 to 12, and unequipping it brought it back.
  Encumbrance, attunement and InventorySpaces are deferred.
- **Choices before use.** `Item.use()` asks an Action's choices first (a spell slot, a damage type), with a live
  preview of what they spend and roll, then sends them with the intent
  ([ui-ux-layer.md](../architecture/ui-ux-layer.md#action-configuration-and-preview)).
  Live: a Player picked a 2nd-level slot from the action bar and the spell rolled 3d6.
- **Rests (2024, world time).**
  - A long rest restores all health and removes a level of Exhaustion, but gives no benefit to a creature at 0
    health; its hours still pass.
  - A stable creature regains 1 health after 1d4 hours, counting world time and rests (1 or 8 hours)
    ([dying-and-death.md](../architecture/dying-and-death.md#the-rules)).
  - Live: Spare the Dying stabilized the caster, and an hour of world time later they woke with 1 health. A Player's
    long rest at 0 health gave no benefit, but its 8 hours woke the stable caster. The next long rest restored full
    health and took Exhaustion from 2 to 1.
  Phase E is done.

**Phase F, content: SRD 5.2 converter, representative slice (2026-10-14).** A converter maps dnd5e 6.0.2's 2024 SRD
(CC-BY-4.0 documents only) to WildPath. The first slice is one of each kind: Longsword, Fireball, Fire Bolt, Cure
Wounds, Second Wind and the Bandit Captain, in the new packs `srd-items` and `srd-creatures`
([content-packs.md](content-packs.md#srd-52-packs-2026-10-14)).
- What WildPath cannot express is listed per document, never approximated.
- Live: the converted Fireball and Scimitar resolved correctly.
- It also fixed an engine bug: a class caster's spell save DC (`8 + prof + spellmod`) failed on the authority.
- **Decided and done (2026-10-14):**
  - Proficiency applies only to a proficient attack or save, and is easy to change: the Builder checkbox, the
    sheet's save checkboxes, and Modifiers on `proficiency`.
  - The SRD's own descriptions are copied as placeholders.
  - The whole SRD is converted: 918 Items (209 automated, 464 manual, 245 features) and 375 creatures. Live, the
    Bandit Captain's stat block matched in play.
  - The maintainer's own books are local module packages (`convert-dnd5e-module.mjs`), never committed: Player's
    Handbook, Dungeon Master's Guide, Monster Manual and Tasha's
    ([content-packs.md](content-packs.md#your-own-books-as-local-packages-2026-10-14)).

**M4 — content pack (in progress, 2026-10-14).**
- **The pack.** `@foundryvtt/foundryvtt-cli` 3.0.4 was approved and added. The built-in **WildPath Actions**
  pack (nine Actions, one per proven mechanic) is built from JSON sources by `npm run build:packs`
  ([content-packs.md](content-packs.md)).
- **Advantage and disadvantage (2024).** `RollMode` RuleElements and the 2024 cancel rule cover attack
  rolls (the attacker's own and the target's "attacks against me") and each target's save. The
  conditions now carry their 2024 advantage and disadvantage:
  - Prone, including within 5 ft and beyond;
  - Blinded, Restrained (and its Agility saves), Poisoned, Stunned and Unconscious.

  Advantage and disadvantage cancel source for source (maintainer decision). Poisoned's old damage each
  turn is now Envenomed, a stacking poison condition built from a reusable damage-over-time structure.

  The 2024 conditions also have, verified in Node, Quench and two browsers:
  - incapacitation: Stunned and Unconscious have no actions, bonus actions or reactions;
  - Speed 0 on Restrained and Unconscious, including granted Speeds;
  - automatic failure of Might and Agility saves (Stunned, Unconscious), with no roll requested;
  - critical hits on an Unconscious creature from within 5 ft;
  - Exhaustion's −2 per level on d20 tests and −5 ft per level on every Speed.

  Alongside them: per-target save bonuses, and critical damage that rolls the dice twice.

  Dying and death follow 2024, with PF2e conventions where 2024 leaves room
  ([dying-and-death.md](../architecture/dying-and-death.md)). Dead is 0 health, Defeated and three failed
  death saves. That covers death saves at turn start, failures from damage at 0, massive damage, waking by
  healing, NPCs dying at 0, and Exhaustion 6.

  Who makes death saves is a per-creature setting: by default, characters and the companions and sidekicks
  Players control. Incapacitated ends concentration and gives disadvantage on initiative, rolled by
  `WildPathCombatant`. Unconscious brings Prone. The 2024 condition set is complete except for stabilizing by
  an ally and regaining health while stable.

  The pack loads live after the relaunch.

**M5 — progression (in progress, 2026-10-14).** The missing-primitive test is
[progression-primitives.md](progression-primitives.md). Done, each verified in Quench and most in two
browsers:

- Damage grants (`GrantResistance`, `GrantImmunity`).
- A table ValueExpression.
- Action, Bonus Action and Reaction counters: spent is stored, and effects raise or lower the available
  count.
- Class records with multiclassing, and 2024 full- and half-caster slots
  ([classes-and-spellcasting.md](../architecture/classes-and-spellcasting.md)).
- Transformations that keep the creature's feats and gear.
- The general automation dispatcher for Items' and effects' automatic triggers (turns, initiative, rests).
- `GrantResource` pools, created full when the grant arrives.
- `area.exited`, for steps out of an area and for creatures an aura leaves behind.
- Companions, summons and sidekicks: shared control, and controller costs on their Actions
  ([companions.md](../architecture/companions.md)).
- Movement modes under 2024 rules, with Speeds from `GrantMovement`; movement became a spent counter.

Open:

- Nothing that needs a decision. Next candidates: moving the legacy condition ticks onto the automation
  dispatcher, `once` triggers, transformation follow-ups (Token size, starting one from an Action),
  summoning from an Action, and sheet controls.

**Authority and disclosure hardening (M0) — CLOSED on 2026-10-13.** A review found that the
authority trusted more than it could verify: any player could act through an Actor or Item they did
not own; a target answer replaced the candidates and selection policy; the chooser's roll request
still carried `attack`/`save`/`targets`/`targeting` (defenses and DCs) because the minimization was
a top-level denylist; the participant result was a full clone; `RESOLUTION_CANCEL` accepted any
sender; the broadcast adapter accepted an envelope with no attested sender; coordinator and movement
records grew without bound; and resource payment clamped to the maximum, so an over-maximum pool lost
more than the cost.

**Production code changed: YES.** `multiplayer-authority.mjs` (allow-list projections for intents,
chooser payloads, participant/public results and error data; bounded caches with `onEvict`;
`pushBounded`), `foundry-multiplayer-runtime.mjs` (sender must own Actor and source Token; Item must
belong to the Actor; no world-Item fallback), `action-pipeline-resolver.mjs` (target answers add
decisions only), `foundry-v14-resolution-socket-adapter.mjs` (fails closed without an attested
sender), `resource-resolver.mjs` (pays exactly the cost), both coordinators (bounded retention;
`RESOLUTION_CANCEL` removed), and the three disclosure modules converted to `.mts`. See
[multiplayer-authority.md](../architecture/multiplayer-authority.md) and
[multiplayer-confidentiality.md](../architecture/multiplayer-confidentiality.md).

Evidence on build `f41b077`, Foundry 14.369, agent-driven in two browsers: Node **879/877/0/2**,
typecheck PASS; Quench **50/50**, orphan check empty; Level-5 ordinary, decline and Large-hex decline
passed (schema-2 exports overwritten under `evidence/`); the Action Hit/Miss gate passed through the
real `Item.use()` with each player `PENDING_REQUEST` reduced to `{rollRequest}` and no
defense/DC keys; a non-owner probe failed with `WRONG_USER` and changed nothing. See the
[Action acceptance record](action-runtime-live-qa.md#acceptance-record).

Known and deferred: the refinement prompt's default selection makes count-limited refinement fail; unfinished abandoned
requests are not timed out; `resolveActorAttackStatistic` may stop at the first empty domain (verify
in M1).

### Previous: multiplayer confidentiality

**Multiplayer confidentiality hardening — CLOSED on 2026-10-13** (Node green, Quench 50/50 live,
Level-5 schema-2 sentinel 3/3 pairs). The `system.wildpath` custom socket is a broadcast bus:
the server relays every emission to every other client and never back to the sender, and
`recipientUserId` only decided who processed an envelope. The audit found private data on that bus:
pending requests (save DCs, reaction candidates, prompt options), answers (roll results, reaction
decisions), error diagnostics carrying the pending request, movement approvals with the mover's
budget and the armed `reactionBoundary`, movement results with resource plans, and the unprojected
`RESOLUTION_RESULT` with target defenses, DCs, the initiator's payment and post-damage HP through
committed mutations. It also found that a GM's self-addressed `ACTION_INTENT` was never processed
in real Foundry (no echo), which the new local delivery corrects.

**Production code changed: YES.** New `module/helpers/multiplayer-disclosure.mjs` (classifications,
audited per-type policy, fail-closed codes, transport selection), `module/adapters/disclosure-routed-transport.mjs`
(policy → broadcast | targeted | local), `module/adapters/foundry-v14-user-query-transport.mjs`
(`User#query` over `CONFIG.queries["wildpath.resolutionEnvelope"]`, attested-sender and recipient
checks, receipt acknowledgement, timeout and permission failure mapping). Changed:
`multiplayer-authority.mjs` (envelope `disclosure` field, chooser payload minimization, two explicit
result projections, scalar-only error data), `foundry-v14-resolution-socket-adapter.mjs` (refuses to
emit or dispatch non-`BROADCAST_SAFE` envelopes; verifies the attested sender), both coordinators
(classification comes from the audited per-type policy table, explicit only on the two result
projections; the result is sent targeted to the initiator and broadcast as a public projection), the Foundry runtime wiring, and the test hub (mirrors the
production topology). Authority, routing, idempotency, staged resolution, transactions, reactions
and movement semantics are unchanged. See
[multiplayer-confidentiality.md](../architecture/multiplayer-confidentiality.md).

Evidence: Node **863/861/0/2**, typecheck PASS, `git diff --check` PASS. Foundry moved from 14.367 to
**14.369** (maintainer update); the 369 source of `User#query`, the query handler, `QUERY_USER`, the
server query relay and the custom-socket relay was re-checked unchanged, and the QA build pin is now
the single `QA_FOUNDRY_BUILD` constant. Quench: **50/50 live** on 14.369 across nine batches,
including `wildpath.multiplayer-disclosure` 4/4; fixture orphan check empty for Combats, Scenes and
Actors. Level 5 (on 2026-10-13, Foundry **14.369**, served build `c1f0079`, run by the agent in two isolated Chrome profiles (GM and Player1) through the real Foundry server; the maintainer accepted automated two-browser runs as closure evidence): ordinary, square decline and Large-hex decline all passed with schema-2
exports committed under `evidence/`. In the reaction sentinels the GM moved and Player1 controlled
the reactor: the reaction-choice `PENDING_REQUEST` and the `REQUEST_RESPONSE` crossed between the two
browsers only on `User#query`, the bus carried only the public `RESOLUTION_RESULT` projection, and the
GM's own `ACTION_INTENT` was delivered locally. The live run found one QA-helper defect (a local
`observe` shadowed the new transport observer in `setupGM`), fixed in `c1f0079` before any evidence
was captured. Programmatic `quench.runBatches` needs the Quench results window rendered first; without
it Quench's reporter throws and the run stalls before any test (a Quench harness limit, not a
WildPath failure). The next milestone has not been chosen.

**The Quench staged-movement batch is live-confirmed; the six-case semantic movement gate is green
in real Foundry.** `wildpath.staged-movement` — **WILDPATH: Staged Movement** — runs the six cases of
[staged-movement-qa.md](staged-movement-qa.md) with the same proof assertions on a single active-GM
client. The maintainer's first V14.367 run passed five and failed `Large-hex reaction decline` at
`movement.commit` (`COMMIT_FAILED`): the commit adapter compared the hex-derived planned
`y = 260.00000000000006` against Foundry's integer-cleaned `260` with strict equality. Commit `e30d752`
repairs `module/adapters/foundry-v14-staged-movement-commit.mts` (rebuilt `.mjs`) so `x`/`y`/`elevation`
tolerate only IEEE-754 noise at all four verification and authorization sites; the maintainer then
reported **6/6 PASS**. **Production code changed: YES**, confined to that comparison boundary;
movement, reaction, tactical-grid, transaction, and authority semantics are unchanged. Standing:
**46 Quench cases live-confirmed** (Q1 17, Q2 17, Combat 6, staged movement 6) across eight batches; a
ninth batch (`wildpath.multiplayer-disclosure`, 4 cases) brought the suite to **50/50 live** on 14.369
on 2026-10-13.
This is Level-3 evidence: it proves the staged architecture in real Foundry on one client, not
GM/player socket delivery, remote prompts, or multiplayer timing.

**The Quench Combat slice is live-confirmed.** `wildpath.combat` — **WILDPATH: Real
Foundry Combat** — adds **6 cases** in `module/tests/quench/combat.mjs` proving, in real Foundry, the
chain real Scene → unlinked Token → synthetic Actor/ActorDelta → real Combat → Combatant →
`Combat#nextTurn` → `WildPathCombat#_onStartTurn` → `actor.startTurn()` → resource persistence →
turn-start Bleeding Trigger dispatch, plus the existing recovery-guard rejections. Fixtures now own
and clean Scenes, Tokens, Combats, and Combatants (Combats → Scenes → Actors), and expose a read-only
orphan listing. **Production semantics changed for the Combat slice: NO.** The maintainer ran the
batch on V14.367 and reported all six passing (Quench UI green, six PASS lines; maintainer-reported,
no exported report), which brought the standing at that time to **40 cases live-confirmed** (Q1 17,
Q2 17, Combat 6); the staged-movement batch has since raised it to 46. The run exposed
a core `CombatTracker._onRender` TypeError whenever a non-viewed Combat updates; it has no WildPath
frames, does not affect document state, and is recorded as a core defect, not a WildPath failure.
Exact case names, the completion-signal design, run instructions, and console interpretation are in
the [testing strategy](foundry-testing-strategy.md).

**Quench Q2 is live-confirmed.** Three batches in `module/tests/quench/` cover
`wildpath.effects` (4), `wildpath.conditions` (5), and `wildpath.rule-elements` (8): **17 Q2 cases**.
The optional `quenchReady` entry now registers nine batches (50 total cases, 46 live-confirmed), without changing
Q1's 17 or Q2's 17 cases. The maintainer ran the expanded suite against Foundry V14.367 and reported the 17 new
cases passing **17/17**; combined with Q1, **all 34 WildPath Quench cases are live-confirmed**. This is
maintainer-reported evidence without an exported Quench report, the same evidentiary standing as Q1.

Q2 covers real ActiveEffect lifecycle/disabled state/native expiration suppression, condition
apply/remove and status conversion, Exhaustion stacking, Prone idempotence, Item/ActiveEffect
Modifier RuleElements, clean source integrity, exact/wildcard domains, level predicates, priority,
definition flags, and repeated preparation/deletion. Bleeding's configured Trigger is verified
through status conversion, persisted payload, and registry collection/removal; Combat turn dispatch
is outside this milestone. The condition-removal modifier is authored on the disposable Prone
effect without changing the built-in condition definition.

Fixture additions are limited to `createEmbeddedQuenchEffect` / `fixtures.createEffect`, requiring
GM, ready state, a marked parent, and a valid run ID. Existing Actor teardown owns all embedded Item
and ActiveEffect cleanup, including condition effects created directly through production APIs.
**Production semantics changed for Q2: NO.** The preceding Q1 runtime repair is preserved. Exact
case names, boundaries, and live-run instructions are in the [testing strategy](foundry-testing-strategy.md).

### Q1 live evidence and preceding repair

Quench Phase Q1 implements an optional real-Foundry integration layer in `module/tests/quench/`:
one `quenchReady` registration entry, shared marked fixtures with per-test cleanup, and three batches:
`wildpath.runtime-smoke` (3 cases), `wildpath.documents` (6), and `wildpath.resources` (8).
The maintainer live-ran Q1 in Foundry V14.367 with Quench v0.10.0: smoke **3/3**, Documents **6/6**,
resources **7/8**; **16/17 initially passed**. The only failing case was the nonzero-index custom-pool
spend. The other sixteen cases, including Item-backed maxima across repeated preparation and Item
deletion, remain valid live evidence. On 2026-09-16 the maintainer confirmed all tests pass after the
repair: resources **8/8**, Q1 **17/17 PASS**. **Fix implemented and live-confirmed.** This records the
maintainer's rerun confirmation; no exported post-fix Quench report was supplied in this conversation.

Coverage includes actual Actor and Item models/lifecycles, source snapshots, built-in spending and
restore clamping, unaffordable and multi-resource spending, custom-pool persistence,
and Item-backed resource maxima across repeated Foundry preparation. Eight portable infrastructure tests now guard
optional registration, GM-only mutation, fixture marking/scoping, and cleanup on failure. They do
not emulate a pass of the real-Foundry cases.

Installed V14.367 source confirms ArrayFields are fully replaced: `system.pools.1.value` is not a
safe partial pool patch. The repair changes `spendResource`, `spendResources`, `startTurn`, and
`rest` to replace clean `toObject(true).system.pools` source arrays, changing only intended values.
Prepared modifiers/maxima remain transient; affordability, clamping, recovery, lifecycle behavior,
and built-in paths are unchanged. Mixed built-in/custom costs still use one Actor update. Production
impact is limited to this persistence correction. Nine new portable cases and strengthened turn
coverage reject the indexed update shape that permissive Node setters previously accepted.

Quench's V14 deprecated-global warnings, auto-run/UI ordering issue, and example-suite failures are
external tool debt; example results are excluded from WildPath's Q1 totals. Use `quench.exampleTests = false`,
`quench.autoRun = false`, `quench.autoShowQuenchWindow = true`; reload after changing example tests.
The existing scoped `afterEach` cleanup is unchanged and now explicitly tested after assertion
failure. Manually verify `game.actors.filter(a => a.getFlag("wildpath", "quenchFixture") === true)`
returns `[]`; the live world's leftovers were not inspected here. No vendor files, dependency
manifests, or client settings were changed. The only startup integration remains the single optional
test registration import. See the
[testing strategy and exact live run procedure](foundry-testing-strategy.md).

Deferred Quench phases: broader Rolls (real digital attack rolls are live-confirmed inside
`wildpath.staged-movement`; the Combat portion as `wildpath.combat`); broader Q4 persistence
rollback/Action entry (nested movement reaction commits are live-confirmed); future migrations.

## Staged movement status

Interruptible movement and reaction composition is implemented and automated-tested. The explicit
`game.wildpath.executeMovementIntent` entry point proposes each tactical transition, opens normal
reaction windows, runs accepted attacks as normal nested Actions at the last logical footprint,
revalidates the remaining route, and commits completed-prefix payment plus final Token position.

The movement implementation added 30 cases covering square/hex/Large traversal, entering/leaving reach,
decline, hit/miss, effect-driven stopping, multiple reactors, controller routing, replay/stale
responses, custom resources, synthetic identity, commit authority, and failure/rollback behavior.

The QA follow-up adds four coordinator-backed regression cases to that file (34 total): accepted
miss/hit/stop child footprint assertions and a Large hex decline variant. Live proof now requires
an explicit pending-choice snapshot, validates pre-transition discovery and `leavesReach`, and
compares child `targetFootprints` to the last-completed full logical footprint while the rendered
Token remains at origin. Missing or incorrect evidence fails. The hex variant checks three-field
footprints throughout, recorded decline without a child, resume, movement payment, and final
persisted position/footprint. Movement architecture and runtime semantics are unchanged.

The two portable-suite skips are installation-dependent nested condition-commit checks, not staged
movement gaps. Their exact names, covered behavior, Node VM limitations, and enablement command
are recorded in the [optional-test audit](nested-reaction-child-commit.md#optional-test-audit-2026-09-16).

Important boundaries and file map:

- `module/resolvers/movement-pipeline-resolver.mts`: movement host and lifecycle.
- `module/helpers/movement-transition.mts`: observer-relative tactical facts.
- `module/resolvers/document-update-transaction.mts`: generic position transaction operation.
- `module/adapters/foundry-v14-staged-movement-adapter.mts`: authoritative route, rules, child Action inputs.
- `module/adapters/foundry-v14-staged-movement-commit.mts`: scoped V14 position persistence.
- Existing coordinator/runtime/token hooks and result transport provide the integration.
- [Architecture contract](../architecture/staged-movement.md) and [live QA](staged-movement-qa.md).

Generated `.mjs` runtime counterparts are committed alongside new `.mts` code.

## Prior foundations and evidence

The existing native checkpoint movement / generic reaction composition is documented as
live-verified on V14.367, including a Large hex Token and synthetic Actor resource/effect commits.
The ordinary Action runtime evidence is tracked in `evidence/gm-hit.json`, `gm-miss.json`,
`player-hit.json`, and `player-miss.json`. These artifacts and prior live claims were not replaced
or rerun during this milestone.

Staged-movement live evidence exists at two levels.

```text
Level 3 (Quench):
  wildpath.staged-movement  6/6 live-confirmed, Foundry V14.367, after e30d752
  total Quench              46/46

Level 5 (two real browsers, staged-movement-qa.md; canonical exports committed 2026-09-20):
  ordinary square/Medium           GM + player JSON PASS   evidence/{gm,player}-movement-ordinary.json   build a009d3f
  square/Medium reaction decline   GM + player JSON PASS   evidence/{gm,player}-movement-decline.json    build d669a17
  Large-hex reaction decline       GM + player JSON PASS   evidence/{gm,player}-large-hex-decline.json   build d669a17

staged movement milestone CLOSED (schema-1 evidence)

Level 5, schema 2 (two isolated Chrome profiles driven by the agent; Foundry 14.369; build c1f0079; 2026-10-13):
  ordinary square/Medium           GM + player JSON PASS   evidence/{gm,player}-movement-ordinary.json
  square/Medium reaction decline   GM + player JSON PASS   evidence/{gm,player}-movement-decline.json
  Large-hex reaction decline       GM + player JSON PASS   evidence/{gm,player}-large-hex-decline.json
Quench 50/50 live on 14.369

confidentiality hardening milestone CLOSED
```

The schema-2 files replaced the schema-1 files at the same canonical paths; git history keeps the
schema-1 pairs described below.

Each pair shares its `runId`, `resolutionId`, `gitSha`, and `foundryVersion` 14.367; every GM export
carries a passed final proof on a completed resolution, and every player export carries the
completed terminal result for the same resolution. The ordinary pair was captured on build
`a009d3f`; decline and Large-hex on `d669a17`, which differs only in development QA tooling (the
Large hex mover is now created at its final size instead of resized, because a V14 resize is a
movement operation that WildPath's own approval rejected) — no runtime code changed between them.
The Large-hex pair committed its final position at a fractional hex coordinate (`y: 2165`), the
case that failed before `e30d752`. The reaction sentinels each record one before-transition window
at transition index 1 with the offered candidate declined and no child resolution, with the pending
proof captured before the answer.

`miss`, `hit`, and `stop` are deliberately not repeated manually; Quench owns their mechanics. The
canonical exports were produced only by `movementQA.exportEvidence({gitSha})` (GM, after `prove()`)
and `mq.exportPlayerEvidence({gitSha})` (player, after the completed terminal result), which wrap
the existing bounded dumps with schema/type, role, case, variant, Foundry version/generation/build,
system id/version, the exact served Git SHA, an ISO capture timestamp, run and resolution IDs, and
the canonical file name, and refuse non-sentinel cases, pre-proof state, missing terminal results,
missing SHAs, and any non-JSON value. The files committed in `302424f`
(`evidence/*-movement-{hit,miss,stop}.json`, and `gm-movement-ordinary.json`, which is a player
`prepared` snapshot under a GM name) are DevTools console transcripts, not exports; they remain
historical, supplementary evidence and are not closure evidence; the mislabeled snapshot formerly
at `gm-movement-ordinary.json` has been replaced by the canonical GM export. Native dragging
continues to use its existing **completed-event** workflow.

## Prerequisite repairs included

- Trusted intent resolution may provide a hosted state and commit implementation to the existing coordinator.
- Resolution IDs are reserved before asynchronous intent resolution, preventing replacement by another intent.
- Generic transaction preparation and result summaries retain Document references for position writes.
- Actor and Token UUID aliases retain distinct synthetic Actors that share base Actor IDs.
- A partial Foundry position update is restored before reporting failure; changed movement payment
  during the position write triggers existing transaction rollback.

## Deferred work and immediate next step

Q1, Q2, Combat, and staged movement are live-confirmed: **46 Quench cases**. No further Quench slice
has been chosen or started; broader Rolls and Q4 remain deferred. Two facts carry forward: `rest()` is now the one
repaired whole-array pool write still proven only in Node, and core 14.367 throws in
`CombatTracker._onRender` for updates to a non-viewed Combat (a core defect the Combat batch reliably
reproduces; not a WildPath failure). Whether the fixture orphan check returned empty arrays for
Combats, Scenes, and Actors after the live run was not reported; confirm it before the next run.

**The staged movement milestone is closed** on the maintainer's two-browser run of 2026-09-20: the
three paired Level-5 sentinel exports above exist, validate, and are committed (`f2c5223`, `a85fe80`).
**Confidentiality hardening** reopened that sentinel because it changed socket transport, request
routing, prompt delivery and disclosure; the schema-2 rerun of 2026-10-13 passed and closed it (see
above). Purely mechanical movement changes remain covered by Node plus the Quench six-case batch.

Current limits are explicit: active GM and voluntary translation at the Foundry entry point;
no intermediate Token persistence/rendering; no durable host reconstruction after reload/handoff;
footprint/source changes invalidate rather than replace a route. Independent child commits are
not rolled back with a later parent failure. Transactions compensate completed operations and do
not provide database atomicity against arbitrary concurrent writes from other systems.

Movement: connect native route submission to the proposed-transition host while preserving
checkpoint accounting. Later work can add Region/Area consumers, route replacement for changed
footprints, and representative reaction content through the established provider seams.
