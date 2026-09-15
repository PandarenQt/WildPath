# Foundry V14 Reference-System Integration Contract Atlas

Comparative research reference for WildPath. Companion to [reference-systems.md](reference-systems.md),
which holds the *policy* for using reference systems; this document holds the *findings*.

Last compiled: 2026-09-16.

## Sources actually read

All sources were read locally at the versions below. Nothing here is from recollection; anything
that could not be confirmed from source is marked UNCONFIRMED.

| System | Version / ref | Location | License |
| --- | --- | --- | --- |
| Foundry core | V14 stable, build 367 | `resources/app/{client,common}` | proprietary (read-only reference) |
| PF2e | `v14-dev` @ `7afb550babd9c429ed21b46a2c6a9c0ffef10339` | `WildPath-references/pf2e-v14` (TS source) | Apache-2.0 |
| Crucible | 0.10.2, compat `14.366` / verified `14` / max `14` | Foundry `systems/crucible` (160 unbundled `.mjs`) | use-only (see below) |
| dnd5e | 5.3.2, verified `14` | Foundry `systems/dnd5e` (readable bundle + source map) | MIT (code) |

## Licensing boundary

**Crucible is use-only, not source-available.** Its LICENSE grants permission solely to install and
use the system within Foundry, and states that no permission is granted to modify, publish,
distribute, sell, "or otherwise use the software or its data in any other way." Copyright 2025
Foundry Gaming LLC. It is explicitly temporary, tied to the playtest period. There is no attribution
carve-out that would make reuse permissible, and the clause names *data* as well as code.
Everything recorded here about Crucible is prose description of mechanism plus interface names only.
No implementation was reproduced, and none may be copied into WildPath.

**PF2e is Apache-2.0.** Obligations attach only to copied *expression*. Re-implementing an
architectural idea from scratch carries none. If any non-trivial block is ever lifted it needs an
Apache-2.0 header, attribution, and a "modified from" note. PF2e *content* (`packs/`, icons) is under
separate Paizo/OGL-ORC terms and is out of bounds entirely.

**dnd5e is MIT** for code; retain the copyright notice if copying substantial portions. SRD content
is separately licensed.

---

## 1. Executive findings

The convergences matter more than any single system's design. Three independently built systems
arrived at the same three answers:

1. **Clone for the workflow; never mutate the real document until commit.** PF2e
   `getContextualClone` and two-sided `RollContext#resolve`; dnd5e `item.clone({}, {keepId:true})`
   plus `updateSource`; Crucible clones the action at use time. All three compute against throwaways
   and write once.
2. **Persist deltas, not absolute targets, for reversal.** PF2e `AppliedDamageFlag.updates[{path,
   value}]`; dnd5e `ActorDeltasField` (`{keyPath, delta}` plus `created[]` plus full `deleted[]`
   snapshots); Crucible reconciles intended against realized deltas and persists the realized ones.
   Absolutes break under interleaving; deltas survive.
3. **The ChatMessage is the durable record and the re-entry point.** Visible, permission-scoped,
   survives reload, and carries enough state to act later. All three use it as the resume token.

**Sharpest single finding: dnd5e 5.3.2 contains zero socket code.** `grep -c "socket"` returns 0,
despite `system.json` declaring `"socket": true`. The Foundry-maintained reference implements a
complete ruleset — damage, concentration breaking, enchantment, summoning, group rests — using only
`game.users.activeGM` elections, ownership-gated client action, and a `request`-subtype ChatMessage
as a document-mediated RPC.

**WildPath is the mirror image: it has zero ChatMessage code.** Verified — `ChatMessage` appears in
no file under `module/`, and the only persisted flag anywhere is `flags.wildpath.conditionEffect`.
WildPath built a socket protocol where dnd5e built documents, and built no durable artifact where
all three others built one.

**Where WildPath is genuinely ahead.** Transaction-backed commit with compensating rollback
(Crucible's apply path has no try/catch at all and can leave partial state); strict
plain-serializable resolution state (Crucible holds live Actor/Roll references until serialization,
and its event stream has no schema validation or migration path — a live type divergence was found);
explicit nested child resolutions; and socket-level duplicate/stale/wrong-user rejection.

**Where WildPath has no precedent to borrow from, and that is the point.** Staged movement with
before-transition reaction windows exists in none of the three. PF2e never overrides
`_preUpdateMovement`/`_onUpdateMovement` and has no movement-reaction concept at all, despite
Reactive Strike being a real PF2 rule. dnd5e never touches those seams either — its movement
automation is cost and pathfinding, not consequence. Only Crucible engages them, and it gates whole
drags rather than interrupting mid-path. WildPath is not reinventing a solved problem here; it is in
genuinely unexplored territory, which raises the value of its live-QA gate rather than lowering it.

Nothing in this research argues for changing WildPath's core architecture. Three findings argue for
*additions*: a durable result artifact, a mid-beat extension hook, and an explicit decision on
skipped turns.

---

## 2. Foundry V14 integration contract atlas

Condensed from V14.367 source.

### The three foundational facts

**(a) Hooks are never awaited.** `Hooks.#call` is `return entry.fn(...args)` —
`client/helpers/hooks.mjs:162`. Consequences, all load-bearing: an `async` handler can never cancel
anything (`Promise<false>` is truthy and `!== false`); a throwing handler does not cancel (caught,
routed to `Hooks.onError`); `Hooks.call` stops iterating on the first `false`, so cross-package veto
ordering is inherently fragile. Core documents this at `client/hooks.mjs:39-44`.

**(b) `_pre*` short-circuits its own hook.** `documentAllowed &&= (noHook || Hooks.call(...))` —
`client/data/client-backend.mjs:104,239,405` and `token.mjs:1990`. If `_preCreate`/`_preUpdate`/
`_preUpdateMovement` returns `false`, the matching `pre*` hook never fires at all.

**(c) `activeGM` is deterministic, local, and nullable.** Highest role wins, ties broken by lowest
`_id` — `client/documents/collections/users.mjs:70-96`. Every client computes the same answer with no
negotiation. It returns `null` when no GM is connected, so all GM-gated logic silently no-ops, and it
flips on every connect/disconnect (`userConnected`), so it must never be cached.

### Client-execution map

| Seam | Runs on | Awaited | Cancels |
| --- | --- | --- | --- |
| `_preCreate` / `_preUpdate` / `_preDelete` | requesting client only | yes | that one document |
| `_pre*Operation` (static) | requesting client only | yes | the whole batch |
| `_onCreate` / `_onUpdate` / `_onDelete` | all connected clients | no (sync, fire-and-forget) | — |
| `_on*Operation` (static) | all clients | yes | — |
| `_pre*DescendantDocuments` | all clients | no | cannot cancel |
| `create*` / `update*` / `delete*` hooks | all clients | no | — |
| `Combat#_onStartTurn` / `_onEndTurn` / `_onStartRound` / `_onEndRound` | active GM only | yes | — |
| Region behavior events | all clients, no GM gate | yes | — |

Mutation contracts differ per seam. `_preCreate` must use `this.updateSource()`; mutating `data` is
not the contract. `_preUpdate` expects in-place mutation of `changed`. `combatTurn`/`combatRound`/
`combatStart` are `callAll` so returning `false` does nothing, but their `updateData` is passed by
reference into the following `update()`, so mutating is the supported influence mechanism — the exact
inverse of the `pre*` document hooks.

### V14 token movement

Ordering: `_preUpdate` → `await _preUpdateMovement` → `Hooks.call("preMoveToken")` → persistence →
`_onUpdate`/`#onUpdateMovement` (all clients) → `await _onUpdateOperation` → `_onUpdateMovement` →
`moveToken` → region enter/exit dispatch.

- **`_preUpdateMovement` can reject but not rewrite.** Verbatim at `token.mjs:2670`: "The waypoints of
  movement are final and cannot be changed. The movement can only be rejected entirely." Everything
  except `autoRotate` and `showRuler` is `Object.defineProperty`-frozen before it runs.
- **`preMoveToken` returning `false` does not cancel the update.** It deletes `MOVEMENT_FIELDS` from
  `changed` and stops movement. Non-movement fields in the same update still persist.
- **`moveToken` is not "movement finished."** It fires once per checkpoint; `planToken` fires instead
  when `passed.waypoints.length === 0`. Authoritative completion is `await token.move(...) === true`
  or `movement.finished`, and `state` distinguishes `"completed"` from `"stopped"`.
- **`planMovement` does not exist on `TokenDocument`** in 14.367 — "planned" is a *state*.
  `Token#planMovement` (the placeable) does exist. WildPath's `reference-systems.md` wording is
  correct as written.
- **`displace`, verbatim** (`config.mjs:2439-2452`): `teleport:true, measure:false, walls:null,
  visualize:false, canSelect:false, costMultiplier:0`. Unmeasured, unwalled, not user-selectable.
  Core force-selects it for undo/paste/teleport. This exactly validates WildPath's version-pinned
  comment in `foundry-v14-staged-movement-commit.mts`.

### Other core facts with WildPath consequences

- **`User#query` / `CONFIG.queries`** (`client/documents/user.mjs:289-344`) is core's built-in
  socketlib equivalent: name-registered, permission-checked (`QUERY_USER`), timeout-capable, and it
  propagates remote rejections as local throws. `User.queryMany` returns `allSettled`.
  `DialogV2.query(user, type, config)` builds cross-client dialogs on top of it.
- **`foundry.documents.modifyBatch(operations)`** — multi-document, multi-parent batch write. The
  right primitive for "apply damage to 5 tokens across 2 scenes."
- **`MeasuredTemplateDocument` is deprecated**, merged into `RegionDocument`, removal targeted v16.
  Its CRUD delegates to Regions flagged `flags.core.MeasuredTemplate`. The `tokenPreMove`/`tokenMove`
  region events are deprecated without replacement and no longer fire.
- **`ActiveEffect.registry.refresh(event, context)`** recalculates durations on all clients but gates
  the expiry write on `activeGM`. Default `CONFIG.ActiveEffect.expiryAction` is `"update"` (sets
  `duration.expired`), not delete.
- **Core provides no undo.** The only reversal primitive anywhere is
  `TokenDocument#revertRecordedMovement`.
- **Skipped turns still fire turn events**, with `context.skipped === true`.
- **Socket channel naming** is manifest-gated and server-relayed, and the relay **broadcasts to all
  connected clients**. See §17 for the confirmed contract and its consequences.

---

## 3. PF2e architecture lessons

Its defining structural decision: **move batch-expanding, interaction-capable, order-sensitive work
out of `_pre*` callbacks and into the static `createDocuments`/`updateDocuments`/`deleteDocuments`
overrides.** Rule-element `preCreate` runs in `Item.createDocuments`
(`item/base/document.ts:744-796`) because it must grow the pending batch (`GrantItem` pushes new
sources into the same operation), await a user prompt (`ChoiceSet` opens a dialog), evaluate against
a scratch clone, and run sibling CRUD first. `_preCreate` can do none of those. The same reasoning
drives `preUpdateActor` and delete-cascade expansion.

**Custom hooks: seven total, all `callAll`, none cancellable.** Where a module needs influence, PF2e
passes a mutable options object instead of honoring `false`. It never once uses `Hooks.call` in its
own namespace. This eliminates the "who cancelled it and what state are we in" problem outright.

**Synthetics are deferred producers with domain-keyed consumers.** About 25 named buckets on the
prepared actor, reset in `_initialize`; nearly every bucket holds `DeferredValue<T> = (options?) => T
| null` rather than a value, so a "+1 vs. undead" modifier can exist before the target is known.
Producers (rule elements) and consumers (`Statistic`/`Check`) are decoupled purely by domain strings.

**Provenance is first-class.** Every prepared-state write appends `{source, level, value, mode}` to
`actor.system.autoChanges[path]`, cleared each prep — the answer to "why is my Str 18." Modifiers
record `kind` before adjustments are applied, and serialized modifier output is written into the chat
message flag, so provenance survives into the persisted record and makes rerolls possible.

**Turn-boundary idempotency.** PF2e relies on core's single-designated-GM turn events, then adds
`roundOfLastTurn` / `roundOfLastTurnEnd` combatant flags compared against `context.round`, so
rewinds, re-entry and GM reconnects do not double-fire. It also fans out from the combatant to all
represented actors (troop segments plus familiar) rather than assuming one combatant equals one
actor.

**Resilience discipline worth copying.** Per-rule `try/catch` during preparation, with the comment
"Ensure that a failing rule element does not block actor initialization"; soft `failValidation` that
flips `ignored = true` and records a `DataModelValidationFailure`; warnings auto-suppressed on clones.

**Rule elements are `foundry.abstract.DataModel` subclasses** — free schema validation, `migrateData`,
localization prefixes and structured validation failures, for zero extra machinery.

**Not a staged pipeline.** Single pass per gesture; the chat message flag is the only resume token.
Its `ContextFlagOmission` union explicitly strips live objects before serialization, which
independently validates WildPath's plain-data rule.

---

## 4. Crucible architecture lessons

Concepts and interface shapes only, per the licensing boundary above.

**An Action is a DataModel, not a Document**, and the schema/context split is the spine: the schema
holds the authored action, the construction context holds this particular use. Its `metadata` is a
sanctioned plain-data channel from the use phase to the confirm phase.

**Three phases: prepare, use, confirm.** At the end of use the action is persisted but not applied —
only the ChatMessage and usage bookkeeping are written. Application happens at confirm, after the
action is reconstituted from the message. The class comment instructs extension authors directly:
record events, do not mutate actor state, or changes will be lost or double-applied.

**The event stream.** A flat chronological array of events, each targeting exactly one actor (the
acting actor is just another target), carrying roll, resource deltas, effect entries, item snapshots
and a `negated` flag. Insert position is explicit, so a hook can place an event at a precise causal
point.

**The mechanism that makes it exact, and the single best idea here.** Before persisting, the stream is
resolved against ephemeral clones of each affected actor, in chronological order, honoring pool
overflow, clamps and statuses produced by earlier events; the realized change is then written back
over the intended one. The enabler is that the mutation primitives are dual-mode — one function
serves both the dry run and the real write — so simulation cannot drift from commit.

**Negation of a span, retained rather than deleted.** Interrupted or prevented outcomes stay in the
record, flagged, skipped by both resolution and application, explicitly retained for auditability.
This maps directly onto "a reaction interrupted this action partway through."

**Reversal is a parameter of the same method that applies**, not a separate path. It works because
four kinds of pre-state are captured at use time: realized deltas, effect snapshots, item snapshots
(shaped as update objects, scoped by a declarative per-subtype field allowlist), and movement
identity. Derived consequences are co-located on their causing event so a move and the status it
produces apply and reverse together. Native undo on a token is wired through to reverse the
game-mechanical action, not just the position.

**Hooks: two unrelated systems.** Only four Foundry-global `crucible.*` hooks exist, none around
actions. Action extension goes through a declarative registry of roughly 15 action hooks and 35 actor
hooks, each defined with metadata declaring whether it is async and whether a throwing handler aborts
— so cancellability is data, uniformly enforced by one dispatcher. The system's own 231 shipped
content entries use the identical mechanism offered to modules; there is no privileged path.

**Movement.** Crucible gates with `_preUpdateMovement` (async, `false` cancels) on a precise
conjunction, and accounts in `_onUpdateMovement` gated on `user.isSelf`, so only the initiating client
accounts. Cost is never charged during the drag — it always becomes a Move action through the normal
pipeline. Position is written once, at confirm, by deferring to core's planned-movement API. Three
independent idempotency guards, including a consume-on-use movement-id set.

**Honest weaknesses.** No schema validation or migration for events; the stream is overloaded (plan,
log, card source and reversal record at once); the apply path has no try/catch and no rollback, so a
mid-batch failure leaves partial state; and the socket layer carries exactly one cosmetic message,
with the acting client computing the whole outcome and the GM acting as an approval, not a
recomputation, step.

---

## 5. dnd5e architecture lessons

**Activities are PseudoDocuments:** DataModels in a `MappingField` given document ergonomics (`id`,
`uuid` of the form `${item.uuid}.Activity.${id}`, `sheet`, `update`, `delete`) by mixins, with a
type-dispatching `ObjectField` (`recursive = true`) and a `Collection` carrying a type index. A module
adds a type with three lines in `init`.

**The hook triad is the most transferable thing in the ecosystem:** `pre<X>` (veto before compute),
then `<X>` (veto after compute, before write, receiving the computed update description), then
`post<X>` (advisory, after write). The middle beat is the one most systems omit, and it is what makes
the API genuinely extensible: `dnd5e.activityConsumption` hands listeners exactly what is about to be
written and lets them veto or edit it. Cancelling hooks receive live config objects and are expected
to mutate them. Hook name families (`dnd5e.preRoll${name}`, carried in the config as `hookNames`) let
a listener target `d20Test` broadly or `SavingThrow` narrowly.

**`_prepareUsageUpdates` returns a pure description of intended changes with no I/O**
(`{activity, actor, create, delete, item, rolls}`) and `#applyUsageUpdates` commits it. That is a
mutation plan by another name, and `ActorDeltasField.getDeltas(actor, updates)` computes the inverse
record before any write, storing it on the message as `system.deltas`. `Activity#refund` inverts it.
This is the closest ecosystem analogue to `ResolutionTransaction`.

**`MessageRegistry`** — `Map<originMessageId, Map<rollType, Set<messageId>>>`, fed by
`flags.dnd5e.originatingMessage`, which `BasicRoll.buildPost` sets automatically from the triggering
DOM element. This is how "the damage button finds the last attack roll and its crit state" works with
no workflow object at all. Ammunition data is snapshotted onto the attack message before the ammo is
deleted, so the later damage roll can still resolve it.

**`AdvantageModeField`** is a `NumberField` subclass that implements `_applyChangeAdd`/`Upgrade`/
`Downgrade`/`Override` itself, tracking counts and suppression and resolving to
`sign(adv) - sign(disadv)`. Stacking semantics live in the field type, not in the consumer. This is
the single best transferable idea for a `Modifier`/`RuleElement` system.

**Multiplayer without sockets.** Four mechanisms: `activeGM` as an idempotent election inside ordinary
`_on*` handlers; pre-flight refusal when no GM is online (`_preDelete` returns `false` with a
localized warning rather than queueing); the `request` ChatMessage subtype, a document-mediated RPC
with a `CONFIG.DND5E.requests[handler]` dispatch table, per-row visibility derived from ownership,
active-GM-only result reconciliation, and durability across reload; and permission checks with
informative failure instead of delegation.

**Its gaps are gaps, not designs:** no effect expiry (left to core and the GM), no area resolver, no
auras. Placing a template targets and affects nothing.

---

## 6. Cross-system comparison matrix

| Capability | Foundry V14 contract | PF2e | Crucible | dnd5e | WildPath today | Lesson |
| --- | --- | --- | --- | --- | --- | --- |
| Init | `init`/`setup`/`ready`; CONFIG mutation | staged, pre-`init` load for subclassing | barrel modules to one frozen `SYSTEM` | namespace merged onto `game.system` | `wildpath.mjs` on `ready` | merge onto `game.system`; expose one API object |
| Actor prep | `prepareBaseData` then `prepareDerivedData`; no writes, idempotent | RE phases, synthetics, `autoChanges` | model-driven | mixin templates | `getStatistic` + RuleElements | PF2e phase/priority table |
| Item use | none | 3 parallel representations | `CrucibleAction.use()` | `Item#use` to `Activity#use` | `Item#use` to intent to coordinator | WildPath staged; others single-pass |
| Action lifecycle | none | single pass | prepare/use/confirm, plan-apply split | single pass plus hook triad | staged resumable pipeline | WildPath ahead |
| Action extension hooks | — | 7, none cancellable, mutable opts | registry with declared async/throws | rich triad, `Hooks.call` cancellable | none for actions | see §15 |
| Targeting | `game.user.targets`, `targetToken` | core targets at roll time | actor-keyed target map | core targets; areas target nothing | own pipeline plus refinement | WildPath ahead |
| Movement | `_preUpdateMovement` reject-only; `moveToken` per checkpoint | no override; cost/ruler only | gate plus `isSelf` accounting | no override; cost/blocking only | 2 authorities plus staged host | no precedent for WildPath's design |
| Reactions | none | none | none (span negation only) | none | `ReactionResolver` plus nested children | WildPath ahead, unproven |
| Rolls | `Roll`, one-shot `evaluate` | Check/DamageRoll stack | dice module | `(config, dialog, message)` triad | `RollProvider` plus digital adapter | dnd5e's 3-part shape |
| Damage | — | clone computes, real doc written | realized deltas on events | delta record plus refund | durability resolvers with `appliedAmount` | WildPath already reconciles |
| Effects/conditions | AE registry, phased `applyActiveEffects` | AEs disabled, items instead | model-driven | AE plus enchantment subtype | condition/effect resolvers | WildPath ahead of dnd5e on expiry |
| Combat turns | `_onStartTurn` active-GM only, awaited | plus persisted round markers | model hooks | uses-recovery only | stateless context validation | see §9 |
| Sockets | `game.socket`; `User#query` preferred | `system.pf2e` plus `CONFIG.queries` | 1 cosmetic message | zero | full request/response protocol | see §10 |
| Chat | ChatMessage, flags, subtypes | flags as resume token | flags as event stream | typed subtypes plus registry | zero usage | see §15/§16 |
| Undo | none | damage only (deltas) | full, first-class | resource refund only | data exists, unpersisted | see §15 |
| Areas/Regions | templates deprecated to Regions | fully migrated to Regions | — | 2 behaviors; templates still | grid-native, no template dep | see §10 |
| Inventory | — | `containerId` back-ref, bulk | — | `container` FK, `MAX_DEPTH=5` | `InventorySpace` (unwired) | see §11 |
| Homebrew | CONFIG tables | RE registry plus manifest flags | hook registry | manifest flags plus type registries | RuleElement registry | all converge |

---

## 7. Movement comparison

**Only Crucible engages the V14 movement seams at all.** PF2e and dnd5e both deliberately stay out.
PF2e configures `CONFIG.Token.movement.actions`, a `TerrainData` subclass and a custom ruler, but
never overrides `_preUpdateMovement`/`_onUpdateMovement`. dnd5e does blocking and pathfinding through
the public `findMovementPath`, `constrainMovementPath`, `getCompleteMovementPath` and
`getOccupiedGridSpaceOffsets`, and never intercepts committed movement.

The inference is worth stating: PF2e has a real opportunity-attack rule and still did not build
movement reactions on this seam. The V14 contract is all-or-nothing rejection with frozen waypoints
and no mid-path interrupt — too coarse. That is precisely the gap WildPath's staged host fills by
planning the route itself and interrupting between transitions.

**Ownership split by trigger origin, not by capability.** This is what both WildPath and Crucible
independently discovered. Crucible: native drag gated in `_preUpdateMovement`, accounted in
`_onUpdateMovement` under `user.isSelf`, with planned action movement going through core's plan/start
API and position written once at confirm. WildPath: native/checkpoint authority for all
Foundry-initiated drags, staged host for explicit intents, separated by the unforgeable
`isStagedMovementWrite` tag.

For the eventual native-drag integration, three concrete points carry over:

1. `_preUpdateMovement` is the only awaited authority gate, and it can only reject — a route that must
   be reshaped has to be rejected and re-issued.
2. Crucible's consume-on-use movement-id set is the shape for "this movement's cost was already paid,
   do not re-account it."
3. Accounting must be gated to exactly one client: `user.isSelf` for initiator-accounting, or
   `activeGM` for authority-accounting. WildPath already chose the latter, which is why its
   `moveToken` plus `finished === true` approach is coherent even though Crucible's differs.

---

## 8. Actions / reactions / rolls comparison

**Plan/apply is universal; only the boundary differs.** dnd5e: `_prepareUsageUpdates` (pure) then
`#applyUsageUpdates` (commit). Crucible: event stream resolved against clones, then applied at
confirm. WildPath: mutation plans then `ResolutionTransaction`. WildPath's is the only one with
ordered commit *and* compensating rollback.

**Reactions have no ecosystem precedent.** Crucible's nearest analogue is span negation plus
post-confirm chaining; PF2e and dnd5e have nothing. WildPath's nested child resolutions with a
resumable parent are ahead of all three.

**Rolls.** dnd5e's `(config, dialog, message)` triad with `buildConfigure`, `buildEvaluate`,
`buildPost` is the most mature shape, and the auto-propagated `originatingMessage` flag is what lets
later rolls find earlier ones without a workflow object. Both PF2e and dnd5e thread core's
`allowInteractive` for manual/physical dice rather than implementing their own; WildPath's
`RollProvider` abstraction is a superset and is fine, but the manual provider it defines is not
registered in production.

**Three distinct hook-cancellation philosophies** — the key design choice WildPath now faces:

| | PF2e | dnd5e | Crucible |
| --- | --- | --- | --- |
| Mechanism | `callAll` only, mutable options | `Hooks.call`, `false` cancels | registry, metadata-declared |
| Cancellable? | never | yes, at 3 beats | per-hook, declared as data |
| Trade-off | no partial-cancel states | powerful mid-beat veto | uniform enforcement, not global |

Core's own semantics push toward PF2e's answer: async handlers cannot cancel, throwing does not
cancel, and the first `false` stops iteration. Cancellation via hooks is fragile by construction.

---

## 9. Effects / combat lifecycle comparison

`Combat#_onStartTurn` is the correct home for turn-boundary work — core runs it on the active GM only
and awaits it. All three systems that do turn work use it. WildPath already does, correctly.

Each handles re-entry differently, and WildPath's approach has an undecided edge:

- **PF2e (stateful):** persisted `roundOfLastTurn` markers compared to `context.round` — can process a
  turn reached via a skip, and refuses to double-process on rewind.
- **dnd5e:** no markers; relies on core's election alone, and drops core's `context` argument entirely.
- **WildPath (stateless):** `validateTurnRecoveryContext` requires the combatant to *be* the current
  turn and the context round/turn to match committed combat state
  (`module/helpers/combat.mjs:174-208`). This correctly prevents double-fire, but it also means
  skipped turns receive no processing at all: no resource recovery, no effect duration tick. Core
  supplies `context.skipped` precisely so systems can decide this; WildPath never reads it. **Not a
  defect — an undecided design question.**

**Effect expiry.** Core provides `ActiveEffect.registry.refresh(event, context)` with all-client
recalculation and activeGM-gated writes. PF2e uses a sorted `EffectTracker` with three expiry paths
(world time, turn boundaries, encounter end). dnd5e implements no expiry at all. WildPath's
`executeEffectLifecycleCommit` puts it ahead of dnd5e here.

**For WildPath's uncalled `applyConditionTriggers`, PF2e supplies the complete recipe:** rely on core's
GM-only turn event (WildPath already does), persist or validate a per-combatant round marker (WildPath
validates statelessly instead), fan out from the combatant to all represented actors rather than
assuming one, and surface the no-GM case to users rather than silently skipping — dnd5e's pre-flight
refusal with a localized warning is the blessed pattern for that.

---

## 10. Areas / Regions comparison

**Templates are on a two-generation clock.** `MeasuredTemplateDocument` logs a v14-to-v16 deprecation
on construction and its CRUD delegates to `RegionDocument`. PF2e has fully migrated — a repo-wide grep
for MeasuredTemplate returns zero hits; effect areas are placed as Regions carrying back-references,
and `RegionBehavior` data models feed the roll-option system rather than applying effects. dnd5e still
uses `MeasuredTemplate` for spell areas and has only two region behaviors.

**WildPath is already clear of this.** Verified: zero references to `MeasuredTemplate`,
`canvas.templates` or `scene.templates` anywhere in `module/` or `docs/`, and `areas.md` specifies a
deliberately grid-native engine using tactical fields rather than Euclidean overlap tests. The unbuilt
`AreaResolver` inherits no deprecation debt.

The actionable guidance is narrow: when persistent areas (auras, hazards) eventually need a Foundry
vehicle, target `RegionDocument`, and note the trap that region behaviors fire on every client with no
GM gate. Core's own behaviors self-gate with either `event.user.isSelf` or `game.user.isActiveGM`; an
ungated behavior multiplies its writes by the client count. Also note `tokenPreMove`/`tokenMove`
region events are deprecated without replacement and no longer fire, so region-based movement
interception is not available — reinforcing §7.

---

## 11. Inventory / persistence comparison

Both PF2e and dnd5e model containment as a foreign key on the child (`system.containerId` /
`system.container`) with the parent's contents derived, never persisted, plus explicit cycle detection
and a depth bound (dnd5e `MAX_DEPTH = 5`). WildPath's `InventorySpace` already has containment-cycle
detection and weight policies, so its domain model is sound; it simply has no consumer.

Transferable persistence patterns: `Item5e.createWithContents` flattens a nested tree into one flat
create array with fresh ids (one operation, not N); `{render: false}` on intermediate writes with only
the final write rendering; ejecting contents in the static `deleteDocuments` before delegating; and
dnd5e's data-model-declares-its-own-UI-section pattern. Avoid dnd5e's sync-or-Promise union return
types, which force every caller to guess.

---

## 12. Public / private API risk register

**Calibration baseline: dnd5e uses no underscore API for persistence, permissions or multiplayer.** Its
entire private-API list is UI and canvas concerns. That is the bar.

| API | Used by | Purpose | Public alternative? | WildPath uses? | Risk |
| --- | --- | --- | --- | --- | --- |
| `Combat#_onStartTurn` / `_onEndTurn` | PF2e, dnd5e, WildPath | only seam with single-GM plus serial-await | none | yes | Low — universal, documented; silently no-ops with no GM |
| `_preUpdateMovement` | Crucible, WildPath | only awaited movement authority gate | `preMoveToken` (not awaited, cannot gate) | yes | Low-Med — new V14 API, correct choice |
| `_preUpdate` | PF2e, dnd5e, WildPath | pre-persist mutation of `changed` | none | yes | Low |
| `ActiveEffect._fromStatusEffect` | WildPath | status-to-effect construction | none | yes | Low |
| `operation.wildpathStagedMovement` custom flag | WildPath only | distinguish authoritative staged write from new proposal | none found | yes | **Medium** — invented private convention on a persistence path; the one place WildPath exceeds dnd5e's calibration bar. Mitigated by being unforgeable and directly tested. |
| in-place `CONFIG.statusEffects` mutation | WildPath | V14.367 requires registry/proxy identity | reassignment breaks the proxy | yes | Medium — core confirms `CONFIG.statusEffects` is a Proxy over an array keeping id-keys in sync, so preserving identity is correct |
| `CONFIG.Token.movement.actions.displace` | WildPath | render an already-resolved tactical result | none | yes | **Low — now validated.** Core confirms `measure:false, walls:null, teleport:true`, and core itself force-selects it for undo/paste/teleport. Constraint: never use it for movement that should be wall-constrained or measured. |
| `ClientDatabaseBackend#_getDocuments` plus raw `SocketInterface.dispatch` | PF2e | migrate every document on read | none | no | High (PF2e's highest) |
| `TokenObject#_onUpdate` with `{broadcast:false}` | PF2e | re-render from non-persisted diff | none | no | High |
| `TokenRuler#_getGridHighlightStyle` abused as iteration callback | PF2e | action-economy glyphs | none | no | High |

Two risk-management patterns worth adopting from PF2e: every protected override calls `super` and
honors its result (WildPath's `_onStartTurn` already does), and monkey-patches delegate to the
captured original for anything not system-namespaced.

---

## 13. Patterns worth adopting

Only patterns that solve a problem WildPath actually has and fit its existing architecture.

**A. Intent-to-realized reconciliation as a planning invariant.** A mutation plan that stores intended
values diverges from reality if clamping happens at commit, and an inverted plan is then wrong by
exactly the clamped amount. References: Crucible (dry run against clones with a dual-mode primitive),
dnd5e (`getDeltas` computed before writes). WildPath equivalent: already partly present — durability
plans record `amount` against `appliedAmount` plus `overflow`/`overheal`. Resource payment does not:
it records `from`/`to`/`amount` but nothing asserts `from - to === amount`, and `to` is the clamped
result. Adding that assertion closes the `clamp(current - amount, 0, max)` bug class structurally
rather than at one call site.

**B. A durable, permission-scoped result artifact.** WildPath has no record of a completed resolution
that survives the session. All three references use one. dnd5e's typed `ChatMessageDataModel` (data
model owns template, render context and a `metadata.actions` dispatch table) is the V14-canonical
form. `ResolutionState.events`, `trace`, and `ResolutionTransactionResult.committed[].rollbackUpdates`
already contain everything such a record needs.

**C. Post-commit reversal via reconstitution.** WildPath captures `rollbackUpdates` and
`rollbackAvailable` per operation, but they die with the in-memory transaction; no other client, later,
can invert a committed resolution. Additive fix: persist the record (B), add a reconstitution entry
point, invert. Store deltas and created-ids, not absolutes, and snapshot pre-state for deletes and
updates shaped as update objects so restore and apply are the same operation.

**D. The pre/mid/post hook triad, with the mid beat carrying the update description.** dnd5e's
`activityConsumption` — "here is exactly what I am about to write; veto or edit it" — is the beat that
makes an API extensible, and it maps almost exactly onto WildPath's `DocumentPersistencePort` commit
boundary.

**E. Stacking semantics in the field type.** dnd5e's `AdvantageModeField` implements the effect-change
modes itself, so "any number of sources still only grants advantage once" lives in the schema rather
than in every consumer. Directly applicable to `Modifier`/`ValueExpression`.

**F. Mode-implies-default-priority.** PF2e's `multiply 10 < add 20 < downgrade 30 < upgrade 40 <
override 50` plus an explicit phase enum removes most modifier-ordering bugs without asking authors to
reason about numbers.

**G. Rule elements as `DataModel` subclasses** — free validation, `migrateData`, localization,
structured failures. Plus per-rule `try/catch` during preparation so one bad definition cannot brick
an actor.

**H. `CONFIG.queries` / `User#query` where a reply is needed.** Permission-checked, timeout-capable,
propagates remote rejections. PF2e uses it for trade and kept raw sockets only for fire-and-forget.
WildPath currently uses raw sockets for everything.

**I. Pre-flight refusal when no GM is online**, with a localized warning (dnd5e), rather than silently
no-opping — the correct treatment of core's `activeGM === null`.

**J. Manifest-flag-driven module extension** (dnd5e's `flags.<system>.*` scanning) — declarative
extension requiring no code from the module at all.

---

## 14. Patterns to avoid

1. **Chat-card-as-workflow-engine** (PF2e): everything after the roll is a button handled by whichever
   client clicks it, with parameters smuggled through `element.dataset`. WildPath's staged pipeline
   exists precisely to replace this; adopting 13B must not regress into it. The message should be a
   record and re-entry point, not the state machine.
2. **Cancellable hooks as the primary extension mechanism.** Core makes this fragile: async handlers
   cannot cancel, throwing does not cancel, the first `false` stops iteration, and a `false` from
   `_pre*` suppresses the hook entirely.
3. **Duplicated `…V2` hook twins** (dnd5e, nine pairs) and inconsistent argument shapes for the same
   hook name. Version the payload, not the name; one signature per hook.
4. **Two dialog-cancellation conventions in one codebase** (dnd5e: one rejects, one resolves empty).
5. **Dialogs that mutate the caller's config in place** (PF2e and dnd5e both). A system with
   serializable `ResolutionState` must return new state.
6. **An unvalidated, unversioned event stream** (Crucible). If WildPath persists events, they need
   schema and migration like everything else.
7. **Apply-without-rollback** (Crucible). WildPath already has the stronger primitive; do not trade it
   away for a simpler event replay.
8. **Modelling one concept twice** (dnd5e's exhaustion as both a number and an effect, synced by four
   handlers).
9. **UI preference state written to game documents** with a DB round-trip after every roll.
10. **Replacing rather than merging CONFIG registries** — hostile to anything registered earlier.
11. **Sync-or-Promise union return types** (dnd5e containers).
12. **Reaching for private APIs for cosmetic features** (PF2e's ruler: three protected seams plus two
    `MutationObserver`s for glyph display).
13. **Sub-1.0 float schema versions** as migration keys.

---

## 15. WildPath hook / API opportunities

WildPath already has more of this than it appears to. Verified: `AUTOMATION_EVENT_TYPES` enumerates
`action.declared`, `action.validated`, `targets.selected`, `payment.required`, `payment.committed`,
`attack.roll`/`hit`/`miss`, `save.roll`/`success`/`failure`, `damage.applied`, `healing.applied`,
`effect.applied`, `movement.*`, `area.entered`/`exited`, `turn.*`, `round.*`, `rest.completed` — with
four phases (`before`, `interrupt`, `after`, `information`). `ResolutionState` already carries an
ordered `events[]`, a coded per-stage `trace[]`, `mutationPlans[]` and `ancestry[]`. A public hook
already exists: `Hooks.on("wildpath.automationEvent", ...)`, dispatched via `callAll`, synchronous,
informational, non-cancellable, copy-delivered with observer-failure isolation.

**That design is validated by core.** Because hooks are never awaited and cannot cancel, an
informational `callAll` hook is the correct shape — matching PF2e's conclusion exactly.

**The gap is coverage, not capability.** The hook is bridged only from the movement authority; the
Action pipeline does not emit through it. The vocabulary exists, the transport exists and the data
exists — they are simply not connected for actions.

| Wanted lifecycle stage | Already expressible? |
| --- | --- |
| action declared / targets resolved / before and after roll / outcome / before and after damage | yes — existing event types |
| configuration complete | no — no event type; `ResolvedActionConfiguration` exists |
| reaction window opened/closed | no — window state lives in `metadata.reactionWindows` |
| before / after commit | partial — `payment.committed` exists; no transaction-commit event |
| cancelled / failed | no — `ResolutionState.status` carries it; no terminal event |

Recommended conceptual shape, not to implement yet:

- **Stable public tier:** the existing `wildpath.automationEvent` informational hook, extended to fire
  from the Action pipeline. Keep it `callAll` and non-cancellable.
- **A single mid-beat extension point** at the `DocumentPersistencePort` commit boundary — the dnd5e
  `activityConsumption` analogue — receiving the realized mutation plan. This is the one place a
  cancellable or mutable contract earns its complexity, and it is a service seam (like the existing
  `reactionServices`), not a Foundry hook, so it escapes core's async-cancellation trap entirely.
- **Declared metadata per extension point** (Crucible's idea): whether it is async, and whether a
  throwing handler aborts — enforced by one dispatcher rather than per-call-site convention.
- **Do not expose:** stage internals, `ResolutionState` mutation, or anything that would let a listener
  author authoritative mechanics; that would undo WildPath's trust model.

One structural warning from Crucible worth heeding: its event stream is simultaneously the plan, the
audit log, the card source and the reversal record. Economical, but all four concerns now change
together. WildPath currently keeps them separate (`AutomationEvent`, `mutationPlans`, `trace`,
transaction). Adding a persisted record should not collapse them.

---

## 16. Concrete implications for WildPath's existing roadmap

Not a new roadmap — only where this research makes already-planned work faster, safer or unnecessary.

**Makes planned work safer**

1. The `ResourceResolver` clamp repair gets a better fix. Rather than only changing the formula, add
   the `from - to === amount` planning invariant (13A). The durability resolver already does the
   equivalent; the asymmetry between the two resolvers is the real defect.
2. The staged-movement live QA gains confidence. Core source independently confirms every
   version-pinned assumption in `foundry-v14-staged-movement-commit.mts`: `displace` really is
   unmeasured and unwalled, `moveToken` really does fire per checkpoint (so gating on
   `finished === true` is required, and WildPath does it), and `_preUpdateMovement` really is
   reject-only. No correction needed.
3. `AreaResolver` inherits no deprecation debt. When persistent areas need a Foundry vehicle, target
   `RegionDocument`, and remember region behaviors fire on every client with no GM gate.
4. `applyConditionTriggers` has a proven recipe (§9): correct GM-only home already in place; add
   per-combatant fan-out; decide the `context.skipped` question; surface the no-GM case rather than
   silently skipping.

**Makes planned work faster**

5. Native-drag integration has exactly one viable authority seam (`_preUpdateMovement`, reject-only)
   and a proven idempotency shape (consume-on-use movement-id set). §7 removes the exploratory phase.
6. A chat/result surface, currently listed as a later product milestone, is higher-leverage than it
   looks. It is simultaneously the durable record, the undo affordance, the permission-scoping
   mechanism and the cross-client re-entry point.

**May make planned work unnecessary**

7. Re-examine each socket use against the dnd5e bar. dnd5e delivers a complete ruleset with zero
   sockets. WildPath's protocol is genuinely stronger — duplicate/stale/wrong-user rejection has no
   ecosystem equal — and its staged resumable pipeline may well require it, but the question worth
   asking per use case is whether `activeGM`-gated lifecycle handlers plus a request document would
   suffice. Where a reply is needed, `CONFIG.queries`/`User#query` is permission-checked and
   timeout-capable, and WildPath uses none of it.
8. The deferred "durable host reconstruction after reload/handoff" is partly solved by 13B/13C: a
   persisted result record is the same artifact reconstruction would need.

**Documentation correction (verified, not assumed).** [reference-systems.md](reference-systems.md)
records under lessons adopted from Crucible: "For post-movement accounting, use Foundry's post-update
`moveToken` hook rather than `TokenDocument#_onUpdateMovement`." Crucible does the opposite —
`_preUpdateMovement` as the gate, `_onUpdateMovement` for accounting under `user.isSelf`. WildPath's
own choice remains defensible, because it uses active-GM authority rather than initiator-accounting,
so `moveToken` plus `finished === true` plus an activeGM filter is a coherent different answer. But the
attribution is wrong, and it was written from online study before a local checkout existed. That doc
also states "No local Crucible checkout was present," which is now outdated.

---

## 17. Socket channel naming — resolved

**Status: confirmed from official Foundry documentation.** The convention is real, documented, and
manifest-gated. It is absent from the readable client tree because the **server** implements the
relay, and a package only gets the namespace if its manifest asks for it.

### The contract

`SystemManifestData.socket?: boolean` (V14 API) — *"Whether to require a package-specific socket
namespace for this package."*

The system-development article states it in full, verbatim:

> "A system may request for a specialized socket namespace to be provided. If set to `true`, a socket
> event will be handled by the server with the name `system.${id}`, in this example case
> `system.mysystem` which transacts a arbitrary data object by broadcasting that data to all connected
> clients."

The module equivalent is `module.{id}`, with the same semantics.

So the resolution of the earlier UNCONFIRMED note is: the note was correct that no prefix regex or
`onAny` relay exists in `client/`, `common/` or readable `dist/` — and that is expected. The namespace
is granted server-side, per package, gated on the manifest `socket` flag.

WildPath is correctly wired: `system.json:53` declares `"socket": true`, and
`foundry-v14-resolution-socket-adapter.mjs:16` derives its channel as
``namespace ?? `system.${systemId}` `` = `system.wildpath`.

### The consequence that matters: it is a broadcast bus

The documented behavior is **broadcasting that data to all connected clients** — not point-to-point
delivery. Every envelope any client emits on `system.wildpath` is physically delivered to every other
connected client.

WildPath already treats it correctly as a broadcast bus and filters on receipt:
`foundry-v14-resolution-socket-adapter.mjs:60` calls `recipientMatchesEnvelope(envelope, currentUserId)`
and returns early when the envelope is not addressed to this client;
`multiplayer-authority.mjs:149-151` implements the match (`recipientUserId`, then `recipientUserIds`,
then a `"all"`/`"broadcast"` policy).

The implication to keep in mind: **`recipientUserId` is addressing, not confidentiality.** Every client
receives every envelope and merely chooses to ignore the ones not addressed to it. Any client running
a listener or debugger can read all envelope contents.

This is not a flaw in WildPath's authority model, which is sound — senders are validated, wrong-user
and stale/duplicate responses are rejected, and commits are GM-owned. It is a *confidentiality*
property of the transport, and the open question it raises is narrow: does anything travel in an
envelope that a player should not be able to read (a hidden DC, a blind roll result, GM-only
resolution metadata)? `sanitizeResolutionResultForTransport` suggests this was considered; it is worth
confirming deliberately rather than by assumption.

Where confidentiality or a genuine reply channel is needed, `User#query` / `CONFIG.queries` targets a
single user through the server, is permission-checked (`QUERY_USER`), supports timeouts, and
propagates remote rejections as local throws — see §13H. Core also notes that custom socket payloads
carry **zero** authority, so every trust decision must be made by the receiving client, which WildPath
already does.

### Sources

- [Introduction to System Development](https://foundryvtt.com/article/system-development/) — the
  verbatim `system.${id}` and broadcast description
- [SystemManifestData (V14 API)](https://foundryvtt.com/api/v14/interfaces/foundry.packages.types.SystemManifestData.html)
  — the `socket?: boolean` field
- [Game (V14 API)](https://foundryvtt.com/api/v14/classes/foundry.Game.html) — `Game#socket` is
  documented only as "A reference to the open Socket.io connection"; it carries no naming convention,
  which is why the convention is not discoverable from the API page alone
- [Sockets — Foundry VTT Community Wiki](https://foundryvtt.wiki/en/development/api/sockets) —
  community overview (page is JS-rendered and could not be fetched directly; listed for completeness)

---

## 18. Foundry documentation index

An index of the Foundry documentation that is actually relevant to WildPath, grouped by subsystem,
with staleness and trust notes. WildPath targets **14.367** (`system.json` `verified`), so this
section is written for that build specifically.

### 18A. Which source to trust — read this before using the rest

The single most important thing learned while assembling this index:

> **The published API reference silently omits deprecated symbols. The local installed source is the
> only complete inventory of what actually exists at 14.367.**

This was verified independently three times. In each case the website's TypeDoc index reports the
symbol as absent, and the shipped 14.367 source contains a working, warning-emitting shim:

| Symbol | Website API index | Local `14.367` source |
| --- | --- | --- |
| `MeasuredTemplate` / `MeasuredTemplateDocument` | absent; page 404s | present — `client/canvas/placeables/template.mjs:16`, `client/documents/measured-template.mjs:138`, both `{since: 14, until: 16}` |
| `CONFIG.MeasuredTemplate` | absent | present — `client/config.mjs:2218` |
| `CONST.DICE_ROLL_MODES` | absent | present — `common/constants.mjs:2377`, a `defineProperty` proxy warning toward `CONFIG.ChatMessage.modes` |

The practical rule:

- **"Does it still exist / will my code still run?"** → local source. Authoritative for 14.367.
- **"What is the intended replacement, and what is the contract?"** → website API reference. It is
  curated and describes the supported path.
- **"When was it introduced or removed, and why?"** → release notes (§18E).

Release-note prose is written for announcements, not migration. "Measured Templates are gone!" in the
14.352 notes describes the *authoring workflow* being absorbed into Scene Regions; the classes remain
as shims until v16. Both statements are true, and only the source distinguishes them.

Corollary worth stating plainly: because the website omits deprecations, a clean search there is
**not** evidence a symbol was removed. Removal must be confirmed against the source.

### 18B. Local, version-exact sources (preferred)

Installed at `C:/Program Files/Foundry Virtual Tabletop/resources/app/`. These are the exact bytes
WildPath runs against, and all carry full JSDoc.

| Path | What it holds |
| --- | --- |
| `client/hooks.mjs` | **The hook contract reference.** 103 `@event` entries across 40 `@category` groups, as documented empty function stubs. Richer than the website: the `preMoveToken` entry (lines 708-721) spells out that waypoints are final and that the only writable properties are `autoRotate` and `showRuler`. |
| `client/documents/_types.mjs` | Every movement typedef — `TokenMovementWaypoint` (incl. `checkpoint`, line 303), `TokenMovementOptions` (incl. `planned`, line 537), `TokenMovementData`, `TokenMovementOperation`, the `passed`/`pending` split. |
| `client/documents/token.mjs` | `TokenDocument` movement implementation: `move`, `startMovement`, `pauseMovement`, `resumeMovement`, `stopMovement`, `getOccupiedGridSpaceOffsets` (line 1419, returns `GridOffset3D[]`, empty on gridless). |
| `common/constants.mjs` | All `CONST` values with deprecation proxies intact — `REGION_EVENTS` (line 2009), `ACTIVE_EFFECT_CHANGE_PHASES` (line 101), `DICE_ROLL_MODES` (line 2377). |
| `common/data/data.mjs` + `client/data/shapes.mjs` | The `*ShapeData` family; client file adds `ClientShapeDataMixin` geometry. |
| `client/config.mjs` | Every `CONFIG` namespace, including `CONFIG.queries` (line 2964) and `CONFIG.Token.movement`. |
| `client/documents/collections/users.mjs` | `Users#activeGM` (line 70) = `getDesignatedUser(u => u.active && u.isGM)`. |

### 18C. API reference, grouped by WildPath subsystem

Base: `https://foundryvtt.com/api/v14/`. Patterns: classes → `classes/<ns>.<Name>.html`, interfaces →
`interfaces/…`, type aliases → `types/…`, variables → `variables/…`, hooks →
`functions/hookEvents.<name>.html`. The root [`index.html`](https://foundryvtt.com/api/v14/index.html)
carries the public-vs-private API policy — public members get deprecation periods, `_`-prefixed ones
can break without notice, which matters because WildPath depends on `_preUpdateMovement`.

**Movement** (the subsystem WildPath leans on hardest) —
[`TokenDocument`](https://foundryvtt.com/api/v14/classes/foundry.documents.TokenDocument.html) carries
an in-page "Movement API" index that is the best single map of the V14 rewrite.
[`Token`](https://foundryvtt.com/api/v14/classes/foundry.canvas.placeables.Token.html) holds the
canvas-side primitives (`findMovementPath`, `constrainMovementPath`, `planMovement`,
`recalculatePlannedMovementPath`). Types live in `foundry.documents.types` (document side:
`TokenMovementData`, `TokenMovementOperation`, `TokenMovementWaypoint`, `TokenMovementOptions`) and
`foundry.types` (canvas side: `TokenMovementActionConfig`, `TokenConstrainMovementPathOptions`,
`TokenPlannedMovement`). Note the split — guessing the wrong namespace 404s.

**Grid / footprint** — [`BaseGrid`](https://foundryvtt.com/api/v14/classes/foundry.grid.BaseGrid.html)
plus `SquareGrid` / `HexagonalGrid` / `GridlessGrid`. `getCircle`, `getCone`, `getRing`, `getEllipse`
and `getRectangle` are grid-native area primitives already on the grid object — directly relevant to
the unbuilt `AreaResolver`, which should build on them rather than reimplement them. All coordinate
types are 2D/3D-suffixed at V14 (`GridOffset2D`/`GridOffset3D`); there is no unsuffixed `GridOffset`.
`GridOffsetField` / `GridOffsetsField` exist for persisting footprints.

**Areas** — with templates on a v16 clock (§10), the replacement vocabulary is the `foundry.data`
shape family: `BaseShapeData`, `CircleShapeData`, `ConeShapeData`, `EmanationShapeData`,
`RingShapeData`, `TokenShapeData`, and **`GridShapeData`** (an arbitrary set of grid offsets — the
closest match to WildPath's grid-native design). Core names these itself: `template.mjs:329` says
*"MeasuredTemplate.getCircleShape is deprecated. Use CircleShapeData instead."* They are DataModels,
so they satisfy the plain-serializable constraint the old placeable documents never could.

**Documents / persistence** —
[`Document`](https://foundryvtt.com/api/v14/classes/foundry.abstract.Document.html) for the lifecycle
contract. The **static** batch forms `_preUpdateOperation` / `_onUpdateOperation` take
`(documents, operation, user)` and see the whole batch — the right seam for a compensating-rollback
persistence port, in contrast to the per-instance `_preUpdate`. Operation payloads live in
`foundry.abstract.types`, **not** `foundry.documents.types`.

**Data models** — `DataModel`, `TypeDataModel` (the documented base for system subtypes),
`foundry.data.fields.*`. Two notes: `DocumentUUIDField` is the serialization-safe way to reference
actors/tokens from resumable state; and `MappingField` **is not core Foundry** — it is a dnd5e class.
The core equivalent is `TypedObjectField`.

**Multiplayer** — [`User`](https://foundryvtt.com/api/v14/classes/foundry.documents.User.html)
(`query`, static `queryMany`), [`CONFIG.queries`](https://foundryvtt.com/api/v14/variables/CONFIG.queries.html),
`Users#activeGM` / `#getDesignatedUser`, and `CONST.DOCUMENT_OWNERSHIP_LEVELS`. `CONFIG.queries`'
prefix rule is stated in the local source verbatim: *"System and modules must prefix the names of the
queries they register… Non-prefixed query names are reserved by core."*

**Applications** — `ApplicationV2`, `DocumentSheetV2`, `ActorSheetV2` / `ItemSheetV2` (the documented
extension points for systems), `DialogV2`. Gotchas: `DocumentSheetConfig` is in
`foundry.applications.apps`, not `.settings`; `RollResolver` is in `foundry.applications.dice`, not
`foundry.dice`; the Handlebars `PARTS` shape is at the root-level `foundry.HandlebarsTemplatePart`.

**Combat** — [`Combat`](https://foundryvtt.com/api/v14/classes/foundry.documents.Combat.html). The
page states that `_onStartTurn` and siblings *"are only executed for one designated GM user. If no GM
users are present this method will not be called"* — which both validates WildPath's
`foundryManagedCombatAuthority()` and names its failure mode: turn-start recovery silently no-ops in a
GM-less session.

### 18D. Developer articles — useful, but check the staleness flags

At `https://foundryvtt.com/article/<slug>/`. These are written for the current generation broadly, not
pinned to V14, and several have drifted badly.

| Article | Status for V14 |
| --- | --- |
| [`system-development`](https://foundryvtt.com/article/system-development/) | Current enough. Source of the `system.<id>` socket convention (§17). |
| [`scene-regions`](https://foundryvtt.com/article/scene-regions/) | **Roughly a full generation out of date**, yet still the most useful conceptual introduction to Regions — the subsystem the unbuilt area resolver will target. Read for concepts, verify every API name. |
| [`measurement`](https://foundryvtt.com/article/measurement/) | **Actively wrong for V14** on templates. Do not use for area work. |
| [`active-effects`](https://foundryvtt.com/article/active-effects/) | Wrong data shapes — predates `system.changes`, `mode`→`type`, and the phase system. |
| [`chat`](https://foundryvtt.com/article/chat/) | Documents the legacy `rollMode` visibility model, now deprecated to v16. Useful as a description of what **not** to adopt for WildPath's unbuilt chat surface. |
| [`migration`](https://foundryvtt.com/article/migration/) | Covers V10/V11/V12 only. |

**Verified not to exist** (404, not merely hard to find): ApplicationV2, sockets, hooks, token
movement, manifest, settings/keybinding registration, and a developer-facing Regions article. Time
spent hunting for these is wasted — the API reference and local source are the substitutes.

### 18E. Release notes are the de-facto migration guide

**There is no official V13→V14 migration article.** The per-release notes at
`https://foundryvtt.com/releases/14.NNN` are the only narrative record of breaking changes.

Deprecations cluster almost entirely in **14.349, 14.352, 14.353, 14.355, 14.356, 14.357**. Releases
14.358 onward introduced essentially none. A system targeting 14.367 therefore faces a stable surface,
with all the risk concentrated in that earlier window.

Timeline: 14.349 Prototype 1 (2025-09-26) → 14.352 Prototype 2 (2025-11-20) → 14.353 (2026-01-16) →
**14.359 first Full Stable (2026-04-01)** → **14.367 current (2026-08-18)**.

The most useful single artifact for an upgrade is GitHub issue
[#13436](https://github.com/foundryvtt/foundryvtt/issues/13436) — an itemised list of every V12-era
deprecation enacted in 14.349. Note it is a *removal* list, so its entries are already gone.

### 18F. Hook events

Website: [`modules/hookEvents.html`](https://foundryvtt.com/api/v14/modules/hookEvents.html), one page
per hook at `functions/hookEvents.<name>.html`. Local equivalent: `client/hooks.mjs`, which is more
detailed and version-exact.

Three contract facts that constrain WildPath's design, quoted from the module page:

1. *"**Hooks are never awaited**, which means that an async function will always return a Promise,
   which is not a boolean."* — **you cannot cancel a `pre*` hook from an async handler.** Asynchronous
   interruption must go through `pauseMovement(key)` / `resumeMovement(key)`, never hook cancellation.
   This is the core constraint that justifies WildPath's staged host.
2. Confirmed cancellable (returns `boolean | void` with a stated effect): `preCreateDocument`,
   `preUpdateDocument`, `preDeleteDocument`, `preMoveToken`, `chatBubbleHTML`. Everything else in the
   categories WildPath touches is documented `void`. Several hooks (`modifyTokenAttribute`,
   `dropCanvasData`, `chatMessage`, `hotbarDrop`) have a historical `return false` idiom that the V14
   docs do **not** document — verify empirically rather than relying on it.
3. Document lifecycle hooks are documented **generically** (`preUpdateDocument`, not `preUpdateActor`).
   The per-type names still fire; there is simply no page to cite. Likewise `controlToken` is
   documented as `controlObject`.

Movement hook set (V14): `preMoveToken` (reject-only), `moveToken`, `planToken`, `pauseToken`,
`stopToken`, `recordToken`. Combat: `combatStart`, `combatRound`, `combatTurn` are initiating-client,
pre-database, and **mutable in place**; `combatTurnChange` is all-clients, post-database. There is no
`combatTurnStart` hook — turn-start work belongs in `Combat#_onStartTurn`, which is where WildPath
already puts it.

### 18G. V14 change checklist, with WildPath's verified status

Every row below was checked against `module/` in this branch.

| V14 change | Release | WildPath status |
| --- | --- | --- |
| `ActiveEffect#changes` → `system.changes` | 14.353 | **Clear** — never touches AE change arrays |
| `EffectChangeData#mode` (number) → `#type` (string) | 14.352 | **Clear** |
| `Actor#applyActiveEffects()` → `applyActiveEffects(phase)` | 14.352 | **Clear** — zero references. Silent break if ever overridden; see note below |
| `-=` / `==` update keys → `DataFieldOperator` | 14.349 | **Clear** |
| `game.i18n.format()` merged into `localize()` | 14.353 | **Clear** |
| `ignoreWalls`/`ignoreCost`/`history` → `constrainOptions` | 14.357 | **Already migrated** — `foundry-v14-movement-adapter.mjs:1330-1350` reads `constrainOptions.ignoreCost` |
| `CONFIG.Token.movement.actions` replaces legacy config | 14.352 | **Clear** — appears only in comments; never registered |
| `CONFIG.statusEffects` array → object | 14.352 | **Correct for V14** — `foundry-v14-status-effects-adapter.mjs` mutates by ID and preserves registry identity, with the reason recorded in a comment |
| Legacy `template.json` deprecated | 14.352 | **Not applicable** — WildPath has no `template.json`; it declares `documentTypes` in `system.json:28` |
| `rollMode` → `messageMode` (shims to **v16**) | 14.355 | **Clear today; single-function migration later** — see below |
| `MeasuredTemplate` → Regions (shims to **v16**) | 14.352 | **Clear** — zero references (§10) |
| Region `TOKEN_PRE_MOVE` / `TOKEN_MOVE` (removal **v15**) | 13.333 | **Clear** — not used; neither event fires any more |

Two forward-looking notes, neither a defect today:

**Active Effect phases.** `applyActiveEffects(phase)` is a *silent* signature change — no warning
fires, behavior just differs. Core calls it twice: `"initial"` during `prepareEmbeddedDocuments`
(`actor.mjs:473`) and `"final"` at the end of `prepareData` (`actor.mjs:436`), and
`ACTIVE_EFFECT_CHANGE_PHASES` is frozen as `["initial", "final"]` (`common/constants.mjs:101`).
Each phase is its own priority group — an earlier-phase change always applies before a later-phase
one regardless of priority. This is dormant for WildPath now, but it becomes directly relevant when
the effects resolver is production-wired, because WildPath's RuleElement/Modifier ordering is the
analogue of this mechanism, and systems may register additional phases.

**Roll-mode vocabulary.** WildPath uses the identifier `rollMode` for two distinct concepts:
advantage state (`ROLL_MODES` = `{NORMAL, ADVANTAGE, DISADVANTAGE}`, `rolls.mjs:16-20`) and chat
visibility (`createActionContext`'s `rollMode="publicroll"`, `action-resolution.mjs:51`). These sit on
different shapes, so there is no correctness problem — and WildPath already funnels both Foundry's
vocabulary (`publicroll`, `gmroll`, `blindroll`, `selfroll`) and its own into a single normalizer,
`normalizeRollVisibility` (`rolls.mjs:721-743`), producing `ROLL_VISIBILITY`. The payoff is concrete:
when Foundry's vocabulary loses its shims at v16, the migration is **one function**. This is the
translation-boundary pattern of §13 working as intended. The only cost is readability — the shared
`rollMode` name invites confusion between the two concepts.

### 18H. Corrections to claims that look authoritative but are wrong

Recorded because each was encountered in research and would have caused real error:

- **"`MeasuredTemplate` was removed in V14 with no shim."** False for the runtime. Shims exist until
  v16 (§18A). The claim comes from searching the website index, which omits deprecations.
- **"`MappingField` is the core way to model keyed maps."** It is a **dnd5e** class, absent from core.
  Use `TypedObjectField`.
- **"`moveToken` is a `TokenDocument` method."** It is a **hook**. The method is `TokenDocument#move()`.
- **"`TOKEN_MOVE` was replaced by `TOKEN_MOVE_WITHIN`."** Core's own deprecation text says *"deprecated
  without replacement"* for both `TOKEN_PRE_MOVE` and `TOKEN_MOVE` (`common/constants.mjs:2177-2188`),
  removal at v15. `TOKEN_MOVE_IN`/`_OUT`/`_WITHIN` are live but semantically different events, not a
  drop-in substitute — which is precisely why core declines to call them a replacement.
- **"`Roll#evaluate`'s `async` option was removed in V14."** That concluded in **V12** (12.317).
  Already history for any V14 target.
- **"There is a V13→V14 migration guide."** There is not (§18E).
