# ActionDefinition

`ActionDefinition` is Wild Path's canonical persisted mechanical representation of an Action.

```text
Item / Feature / Spell
-> ActionDefinition
-> ActionConfiguration / per-use inputs
-> ResolvedActionPreview
-> ActionResolver / ResolutionPipeline
```

The definition describes what an action can do. It must not store what happened during one use.

## Ownership

The Action domain owns:

- stable action identity
- source/provenance
- semantic activation
- declared costs
- origin policy
- range, targeting, and area requirements
- attack/save/check declarations
- damage, healing, and effect application components
- duration metadata
- future configuration hooks
- action-scoped RuleElements
- resolution policies

Owning resolver domains still interpret their parts. `ActionDefinition` does not calculate attack
bonuses, place templates, roll saves, apply damage, heal Actors, create ActiveEffects, spend
resources, open reactions, or mutate Foundry documents.

## Persisted vs Runtime Data

Persisted definitions may contain:

- canonical distances such as `5 ft`, `30 ft`, `60/120 ft`, `touch`, `self`, or `sight`
- semantic target requirements and predicates
- area shape/size/placement semantics
- attack/save/check declarations
- damage and healing `ValueExpression` components
- effect references or typed condition application definitions
- semantic durations
- configuration placeholders
- RuleElements

Persisted definitions must not contain:

- selected current targets
- current roll results
- current save outcomes
- resolved grid footprints
- chosen upcast level for this use
- current reaction answers
- temporary resolver stage/state
- live Foundry Documents, Tokens, canvas coordinates, DOM state, or executable functions

Runtime adapters merge volatile data into the definition before planning. Examples include selected
targets, already-resolved physical target candidates, attack roll totals, save roll totals, damage
roll totals, target Actor system snapshots, selected payment option, and authority data.

## Schema

Action Items now persist `system.definition` with this composed shape:

```text
ActionDefinition
|- identity/source/origin
|- activation
|- costs
|- controllerCosts   (a companion's Action: what its commanding controller also pays, companions.md)
|- byController?     (its controller's to take though it costs nothing: a spectral pack's Move, companions.md)
|- range?
|- targeting?
|- area?
|- attack?
|- save?
|- check?          (the acting creature's own ability check, below)
|- damage[]
|- healing[]
|- effects[]
|- duration?
|- configuration[]
|- transform? / summon? / push? / fall? / opens? / moveArea? / teleport? / swap / stabilize   (applied when the Action completes; push, fall, opens, moveArea, swap: areas.md;
|                                       summon.match {attacks, saves} and summon.area: companions.md)
|- ruleElements[]
|- policies
|- metadata
```

The Foundry DataModel stores component arrays as plain objects and delegates semantic validation to
`module/helpers/action-definitions.mjs`. This keeps the Foundry schema stable while the pure domain
contract evolves.

## Custom effects (2026-10-14)

An effect entry is either a condition (`{type: "condition", conditionId}`) or a **custom effect**: a buff or
debuff with its own rules.

```js
{type: "effect", id: "blessed", name: "Blessed", slug?: "blessed", img?,
 ruleElements: [{type: "Modifier", data: {domains: ["attack"], value: 2}}],
 duration?: {value: 10, units: "rounds", expiry: "turnStart"}, saveOutcomePolicy?, concentration?}
```

- **Committing it.** It goes through the same plan and commit as a condition, carrying its own definition. It
  becomes an ordinary effect (`type: "effect"`) with its rules and the status `slug`. Without a slug the status is
  `<definition id>:<effect id>`.
  - A predicate can test it: `{hasCondition: "raging"}` for 2024 Rage.
  - Applying the same effect again refreshes it instead of stacking.
  - Its definition is stored in `flags.wildpath.conditionEffect.definition`.
  - **Content keys (2026-11-21).** A key saying what the effect does that its readers find on that stored definition
    while it lasts sits at the top level of the effect entry and is on one list, `CUSTOM_EFFECT_CONTENT_KEYS`
    (action-definitions.mjs), which the condition definition copies as written: `amount` (a drain, below),
    `drawsAtTurnStart` (below), `magicWeapon` (action-configuration.md) and `storedCast` (below). Applied again with another value of one
    (Magic Weapon on another weapon), the effect is replaced like another choice, not refreshed with the old value.
    Before this list the condition definition dropped `drawsAtTurnStart` and `magicWeapon`, so neither a committed Magic
    Weapon nor a committed Confusion worked; only hand-made flags did. An effect committed before the fix lacks them
    until applied again, which replaces it. The top-level lifecycle keys `endsWhen` and `restsLeft` keep their own
    lines; a new lifecycle key (where its creature returns, who controls it) goes in the entry's `metadata` instead,
    beside `metadata.endsWhen: "leavesArea"`, and is not on this list.
  - **A stored cast (2026-11-21, wave D A11).** `storedCast: {action, level}` is a content key: the spell its creature
    holds while the effect lasts, to be cast later at that level. `action` is an Action Item id of the effect's giver
    (the Action's user, whose spells a `spells` choice lists, recorded as the effect's `sourceRef`), so the spell is
    cast as that creature, with its DC and bonuses; for Contingency, a self effect, giver and holder are one creature.
    `level` is a whole number from 0 (a cantrip) to 9. Either may be written as a choice's `{{token}}`, which
    `bindChoice` replaces (the Item id a `spells` choice picked, a slot choice's casting level as a number). Validation
    refuses any other shape. Contingency writes `{action: "{{contingent}}", level: "{{contingent-slot}}"}` on its self
    effect with `duration: {value: 10, units: "days"}`, `stack: "separate"` and `replacesEarlier: true`: each casting
    is a new copy with its own record and a fresh clock, and once it lands `endReplacedEffects` ends the caster's
    earlier copy as a real ending (its `effect.ended` Triggers run); a cast that gives no new copy ends nothing.
    Without `separate`, the commit resolver matches the earlier copy itself: another stored spell or level (a content
    key's other value) replaces it silently, deleted as not ended so its `effect.ended` Triggers never run, and the
    same spell at the same level refreshes it in place with the old clock. Other uses of the record by data alone: a
    spell-holding ring or rod kept as an effect its giver puts on the wearer (Ring of Spell Storing, cast with the
    giver's DC), a homebrew "held spell" boon given to an ally; the release below serves only those cast at their holder.
  - **The GM's release (2026-11-21, wave D A12).** An enabled effect with a bound record (`storedCastOf`, in the
    automation dispatcher: a `{{token}}` its casting never bound reads as none) shows a GM-only **Release** command on
    its row of the actor sheet, its title naming the stored spell and level. Deciding that the circumstance arose stays
    the GM's (Q18.8: no event list). The press runs `releaseStored(effect)` on the dispatcher, routed like `report`: on
    the active GM directly, from another GM's client through the user query `wildpath.releaseStored {effectUuid}`
    (multiplayer-authority.md). The active GM then:
    - runs the stored spell through `useActions` as its giver's Action Item (`actionItemOf` matches an Item id as well
      as a definition id), at the effect's creature (with no targets, its giver itself: Contingency's "only on you"),
      on behalf of the giver's first active player, else the GM; a spell no longer there, an area spell or a holder off
      the giver's scene is refused with `WILDPATH.NOTICE.ReleaseFailed` (useActions' per-use `notice`);
    - casts it free at the stored level: `castLevel` passes the definition through `atCastLevel` (spellcasting.mts),
      whose slot choice offers only the free option at that level (`metadata.freeCastLevel`), keeping
      `levelByResourceId` (the spell's own level) and its scaling `effects`; `costs` are emptied as for any used
      Action, so no slot, Action or Reaction is spent, even after the Reaction was used, and no turn's slot spell is
      recorded. As an authority Action it passes Forbid, prepared, requires and equip checks: it was cast already;
    - asks first Release or Not now (`confirm`: a required `release` option choice whose `decline` makes the Action do
      nothing, Q133 default), its Release option naming the spell and level (`WILDPATH.STORED.ReleaseAt`, "Release Cure
      Wounds at level 2"; a cantrip only by name, `WILDPATH.STORED.Release`), then the spell's own remaining choices
      (the free slot reads "Free, at level 2", `WILDPATH.PROMPT.FreeAtLevel`, for any free option whose cast level is 1
      or more, in the prompt and the action bar's slot tooltip); Not now posts no chat card;
    - runs it under its Item's `flags.wildpath.source`, so `recordCastLevel` records its level for its follow-ups
      (Flaming Sphere stored at 4th), as for any used Action; a declined Action (`configurationDeclined`, read from its
      configuration's trace) cast nothing and records nothing, so Not now leaves an active copy's level alone;
    - once it has completed and was not declined, deletes the effect, an ending (its `effect.ended` Triggers run). Not
      now, a failure, a cancel or a refused release keep it, to release again. A press while its release runs (an
      in-flight set by effect uuid, cleared in a `finally`) does nothing.
    - refuses an effect a `Suppress` rule of its creature silences (`sourceSuppressed`: a Contingency inside an
      Antimagic Field, its spell's tags stamped on it), whose sheet row shows no Release then: the release passes Forbid
      and Unaffected spares a creature's own Actions on itself, so nothing else would stop it. It waits, kept, until
      its creature leaves the field (the plan's "wasted and ended" would need Unaffected on its own Actions).
    Limits: the stored spell's own choices are asked at release, with hindsight (shortcut: upgrade by storing a
    configuration beside the Item id); a stored spell whose targeting is `self` given to another creature still lands
    on its giver; it is always aimed at its holder and refuses an area spell, so a stored spell whose user picks its
    targets when it is cast (a Ring of Spell Storing's wearer) is not served yet (shortcut: upgrade by leaving the
    targets to the user, as an ordinary use does); a material component leaving the caster is the GM's to end by hand.
    Other uses: a DM's boon holding a spell cast at its holder (a stored healing spell).
- **Duration.** It is V14's own `{value, units, expiry}` (units and expiry events from V14 `CONST`). It starts on
  the source's combatant, so "until the start of your next turn" is the caster's turn, even for a reaction.
  - When it runs out, V14's registry deletes it on the active GM (WildPath sets `CONFIG.ActiveEffect.expiryAction`
    to `"delete"`), as it does any effect whose duration ends; its deletion runs its `effect.ended` Triggers.
  - The active GM also registers unlinked Tokens' effects for expiry after a reload. V14 itself misses them until
    a Token's delta materializes.
  - Concentration still ends it. WildPath's own turn-based expiry leaves it alone.
- **A table each turn (2026-10-23).** `drawsAtTurnStart: <RollTable UUID>`: as its creature's turn starts, the
  automation dispatcher draws that table and posts the result as its creature's (2024 Confusion's "Behavior for the
  Turn"; the converter reads the table its spell embeds). Live (14.369), from a flag carrying the key, not a committed
  Confusion (whose effect lacked it until the content keys above): Confused QA Fighter's turn start posted "8: ... one
  melee attack against a random creature within reach". What the result says is the table's to follow.
- **Lasting some Long Rests (2026-10-23).** `restsLeft: N` ends it after its creature's Nth Long Rest; each one counts
  down `flags.wildpath.restsLeft` (`WildPathActor#rest`). The converter gives Raise Dead's four "Resurrection Sickness
  (Day N)" effects (−1 each to D20 Tests) N, so the −4 eases by 1 a rest. Live (14.369): two of them on QA Fighter read
  −2, then −1, then 0. (2026-11-13) The count now reaches an effect an Action applies: the custom effect's condition
  definition carries `restsLeft`, which it used to drop. A Long Rest ends such effects before it refills health, so a
  maximum one lowered (a drain, below) is full again and health refills to it.
- **More statuses (2026-11-21).** A custom effect's `statuses: [<status id>...]` (not built-in conditions) are on it
  beside its own status while it lasts, so a predicate's `hasCondition` sees them. Applied again with other statuses,
  as with other rules, it replaces the old copy. A choice adds them with `add-to-effect` (action-configuration.md):
  Rage of the Wilds' `rage-eagle` on Rage's `raging`.
- **One copy per giver (2026-11-21).** A custom effect with `replacesEarlier: true` replaces its giver's earlier copies.
  When an Action that gives it completes and gave a new copy to at least one creature, the runtime's afterCompleted
  (`endReplacedEffects`) ends every other enabled copy that the Action's user gave, on any creature in the world: its
  Actors and each Scene's Token Actors. A copy is the same status: the effect's `slug`, or else its Action's and effect's
  ids. So effects with one slug on several Actions are one thing to replace (the talisman). The new copy is known by its
  `metadata.resolutionIds` (`withResolutionIds` stamps them for this key). A copy refreshed in place on the same creature
  is therefore the new one. A use that gave none (its target saved) ends nothing, and another giver's copies are never
  touched: given to a creature holding another giver's copy, it is a second copy beside that one, not that one taken over
  (the commit refreshes in place only its own giver's). The giver is read from the effect (`givenEffects`). Blessing of the Trickster ("or they use this feature again", Q64) and the talisman's Give Talisman (Q34) use
  it. Other plausible uses: a single mark or curse moved to a new target, a bonded ward, one ally at a time. The 2024
  Oathbow's sworn enemy is not one: it refuses a new oath while the old enemy lives rather than replacing it.
- **Control while it lasts (2026-11-21, Q18.6).** `metadata.control: true` makes its creature its giver's companion
  until the effect ends (companions.md, "Control by an effect"): Pipes of the Sewers' Swayed.
- **Where its creature returns (2026-11-21, wave D, S1).** `metadata.returns: "source"` on a row giving a status that
  removes its creature from the scene (Trapped) brings it back, when the effect ends, beside the creature that gave it
  rather than where it was (rule-elements.md, "Trapped"). Like `control`, it is a lifecycle key, so it goes in the
  row's `metadata` on a condition or a custom effect.
- **An amount stamped as it lands (2026-11-13).** `amount: {damage: "all" | [<damage type>, ...]} | {formula: "3d6"}`,
  with an optional `cap: <ValueExpression>`. Its rules read the number as `{type: "context", path: "amount"}`. As the
  effects stage applies it to each creature, it works the number out and writes it into the applied effect's rules as a
  constant, keeping it as `amount.value` in the stored definition (`stampEffectAmount`). The result is ordinary rules
  that homebrew could also write by hand.
  - `damage`: the damage this Action dealt that creature, counting only the listed types. Its Temporary Hit Points
    count as damage taken, as `damage.applied` counts them (Q23).
  - `formula`: dice the Action's user rolls for that creature, through the draw part's RollRequest (`rollForTargets`).
    Physical dice work, the prompt names the creature, and the total is kept in `input.drawn` under
    `amount:<effect id>:<token>`, so a resumed stage never rolls it again. Only a creature the effect reaches is
    rolled for.
  - `cap`: at most this, read on that creature as it is now. Harm: `resource-max` of `health` less 1, so the maximum
    stays at 1 or more. A cap that can't be read fails the Action, rather than applying an uncapped amount.
  - An amount of 0 or less gives no effect, as `whenDamaged` skips a creature that took no damage. Without a way to
    work the number out (the plain action resolver) it fails with `AMOUNT_UNAVAILABLE` and never applies an unread
    rule.
  - With `stack: "separate"` each application is a new effect, and any of its rule ids already on the creature (an
    earlier copy, or another Action's drain using the same id) gets the next free `:N`, so all drains add up.
    A Hit Point drain is `{type: "Modifier", data: {domains: ["resources.health.max"], valueExpression: {type:
    "multiply", terms: [{type: "context", path: "amount"}, -1]}}}` with `restsLeft: 1`. An `AbilityScore` add reads the
    same number.
  - The converter writes it from a document's text: "Hit Point maximum decreases by an amount equal to the [Type]
    damage taken" (Wraith, Specter, Wight, Vampire, Vampire Spawn, Succubus, Clay Golem, Harm), "decreases by 14
    (4d6)" on a save, and a curse's "decreases by 10 (3d6) every 24 hours" (Mummy, Mummy Lord: a `time.elapsed`
    Trigger beside the curse whose self Action applies a rolled drain, with no `restsLeft`). Each drain applies on the
    outcome its sentence follows. A drain whose outcome or ending sits elsewhere in its text stays by hand with a note
    (a 2014 "must succeed on ... or", "Subsequent Failures", "until removed by greater restoration"). So do the Death
    Dog's and Otyugh's drains, which come from repeated saves the engine can't run yet.
    Its "and the vampire regains Hit Points equal to that amount" is a healing entry on its user by the same damage
    (`appliesTo: "source"`, `amount: {damage}`, the drain's outcome: "Healing for its user" under Component Model); a
    drain by dice keeps that by hand. The converter also reads a user's own share ("you regain Hit Points equal to half
    the amount of Necrotic damage dealt": Vampiric Touch, the Rod of Lordly Might's Drain Life) from its activity's
    own paragraph, and folds a passive heal activity into its rolled Action when the text says who gets it (a Will-o'-Wisp,
    Land's Aid, a Celestial Spirit's Radiant Mace).
  - shortcut: stored health above a lowered maximum stays stored. Derived data clamps it, and the next damage or
    healing writes from the clamped value, so only a drain the GM deletes by hand before then gives health back.
    Upgrade by storing the clamp with the effect.
- **On its user (2026-10-31).** `appliesTo: "source"` puts the effect on the creature using the Action, whatever it
  targets and whatever their rolls (`conditionEffectTargetsForRequest`). Resurrection's Taxing Cast gives its caster
  "Spell Taxed": `restsLeft: 1`, Disadvantage on D20 Tests, and a `Forbid` on spells (rule-elements.md). With no
  source it fails rather than pick someone.
- **Ending when attacked (2026-10-15).** `endsWhen: "attacked"` ends it once an attack against its creature has
  resolved, hit or miss, so it counts for that one attack ("the next attack roll against it has Advantage": Help,
  Guiding Bolt). The authority deletes it after the Action completes (`endEffectsWhenAttacked`).
  `"attackedBySource"` ends it only when the creature that applied it attacks its creature (Vex), `"attackedByOther"`
  when any other creature does (Sundering Blow), `"attacks"` when its own creature makes an attack roll (Sap), and
  `"saves"` once its creature makes a saving throw in an Action (Staggering Blow, 2026-10-19). An effect the same attack has just applied to a creature it hit
  stays (2026-10-15). `"hits"` (2026-10-21) ends it once its own creature's attack hits: an injury poison's coat, whose
  reaction (a Trigger carrying the poison's save) makes the creature hit take it. The converter makes a poison's "Use
  Poison" the Utilize action on a creature within 5 feet, or for an injury poison that coat on its user for 1 minute.
- **Saved against again (2026-11-12).** An effect row (a condition or a custom effect) may say `repeatSave:
  "turnEnd" | "turnStart"` and `repeatOnDamage: true`: its creature repeats the save that let it in, and a success ends
  it (rule-elements.md, Repeated saves). `repeatDamage: [<damage component>, ...]`, allowed only beside `repeatSave`,
  is what a failed repeat deals (Phantasmal Killer's Psychic damage again, Weird's 5d10). It is stored with the save
  (`metadata.repeatSave.damage`); a component that keeps its Action's id grows with the slot as the Action's own does.
- **Validation.** A custom effect needs a name, rules the engine knows, a slug that isn't a built-in condition,
  and V14 duration units. **Effects by reference (`type: "ref"`) are refused**: they used to validate and then be
  dropped when the Action ran.
- **Targeting.** A `self` Action targets its own creature and a `none` Action targets nobody, whatever the
  Player has targeted. The authority sets both.

Live (two browsers, 14.369):
- Player1's cleric blessed an ally: a "Blessed" effect, +2 to its attacks. It lasted one round and was deleted
  on the cleric's next turn, including after a GM reload.
- Player1's barbarian used Rage (a `self` custom effect with slug `raging`). Its feature's
  `{hasCondition: "raging"}` Modifier on `damage.melee` made the axe roll "1d12 + 2".

## Requires (2026-10-20)

`requires` is a predicate on its creature, seen as `{actorSystem, tags}`: what must hold for the Action to be used. The
authority refuses the intent otherwise ("can't be used now"), and the action bar greys it (`REQUIRES_NOT_MET`, reason
`WILDPATH.ACTIONBAR.Reason.Requires`). Steady Aim requires that it hasn't moved this turn:
`{equals: {path: "actorSystem.resources.movement.spent", value: 0}}`. shortcut: outside combat movement is never reset.
It also sees its creature's statuses (2026-11-01, `hasCondition`, `requiresContext`): Expeditious Retreat's Bonus Action
Dash requires `{hasCondition: "expeditious-retreat"}`, the marker its cast puts on its caster. Telekinesis (2026-11-14)
composes the same parts for "when you cast the spell and as a Magic action on your later turns": its cast puts the
marker on its caster whatever the save (`appliesTo: "source"`, `slug: "telekinesis"`, concentration), and "Telekinesis
(Again)" is its cast as an Action of its own (`metadata.followUp`: no slot, no new concentration) that requires
`{hasCondition: "telekinesis"}` and, for "on your later turns" (Q38, 2026-11-20), that the marker was not begun this
combat turn: `{not: {equals: {path: "startedThisTurn.telekinesis", value: true}}}`. `startedThisTurn` (`requiresContext`)
holds `{<status>: true}` for each effect on the creature whose V14 `start` names the running combat, round and turn
(the marker's `start` is its caster's turn, written by `customEffectDocumentData`), so an Action Surge on the cast's turn
does not give a second use. Outside combat no turn exists and it is `{}`: the Again Action is usable right after the
cast (Q104's default). A cast copy (a Ring of Telekinesis, a Cloud Giant's Spellcasting) brings its Again Action with it.

It also sees its Items' bindings (2026-11-21, `enchantments`): `{<key>: true}` for each item enchantment
(`flags.wildpath.enchantment.key`) on any of its Items that is not disabled and gives its benefits now (its Item
equipped, and attuned when it or the binding needs it: `itemEffectSuppressed`). `{equals: {path: "enchantments.<key>",
value: true}}` makes an Action usable only through a working binding of that key. The converter gives it to every other
Action of a magic weapon made from a base weapon (Luck Blade's Wish, Hammer of Thunderbolts' Hurl, Nine Lives
Stealer's Life Stealing), so they need the bound weapon equipped and attuned (Q43 (c)); a homebrew Action riding any
binding (a bonded weapon's special attack) can require it the same way. It also sees `form.distance` (2026-11-22, wave D
B18; `WildPathActor#formDistance`): the feet between the footprints of the Token a possession rides with and its body's
Token, both named by the transformation's `inPlace` record (`tokenUuid`, `formTokenUuid`: classes-and-spellcasting.md),
whichever of its Tokens shows the Action; null without that record, with either Token gone or on another Scene, or on a
gridless Scene, so an `atMost` fails then (shortcut: and an `atLeast` never fires). Magic Jar's Return from Host will require `{atMost: {path: "form.distance", value: 100}}`
("if the container is within 100 feet of you"); a homebrew puppet body's Actions can need their master near the same
way. Automatic Triggers see it too (rule-elements.md). A gear magic item's Actions need none: its own
gear gates them (`grantedBy`). shortcut: the reaction provider does not read `requires`; a hit rider an enchantment's
extra damage carries (Sword of Wounding's save) is gated by that damage instead (inventory.md).

It also sees where its user's Token stands (2026-11-14): `inBrightLight`, `inSunlight` and `environment.<tag>`, the
keys a creature's own roll predicates already read (`sunlightContext`, `environmentContext`). The SRD Shadow's Shadow
Stealth ("While in Dim Light or Darkness") requires `{not: {equals: {path: "inBrightLight", value: true}}}`. The
authority reads them from the intent's source Token, only when the Action has a `requires`; the action bar from the shown
creature's Token (`actionBarContext`'s `place`), refreshed when that Token moves, when any Token's `light` changes on
the viewed Scene (its own torch or another's, found live 2026-11-14; ambient lights and the Scene already refreshed it),
and when a lit Token there is hidden, shown, created or deleted. shortcut: another lit Token's move does not refresh it,
since that Token's drawn light source still sits on the old square when `updateToken` fires. Both read the square a Token was
moved to (its document's `_source`, `standingPoint` in `foundry-v14-sunlight.mts`), never its animation: V14 writes each
movement frame onto the document's own `x` and `y`, so they still hold the old square when `updateToken` fires (found live
2026-11-14, the bar one move behind). Its own light (a carried torch) is measured by its radius, since Foundry's drawn
source still follows the animation. With no Token they are absent, so "not in
Bright Light" passes. A Scene without Token vision counts as Bright Light, as for Light Sensitivity (owner question Q60).

Beside them (2026-11-21, Q59; `placeContext`, `adapters/foundry-v14-senses.mts`, which both read):
- `obscured`: how obscured the place is (`obscurityAt`), the strongest source winning. `"heavily"` in a Heavily Obscured
  lasting area (Fog Cloud) or in darkness, magical or not; `"lightly"` in a Lightly Obscured lasting area (Web, Insect
  Plague), in Dim Light (light but not Bright Light), or where the GM ticks "Lightly obscured" on a Region or the Scene
  (`environment.lightlyObscured`: fog, foliage), Bright Light or not; absent otherwise. A Scene without Token vision is
  all Bright Light, so only an area or the tag obscures it there (Q60). Nature's Mantle requires
  `{oneOf: {path: "obscured", values: ["lightly", "heavily"]}}` (a Heavily Obscured place counts too: Q118 (a) default).
  Other uses: an Action of any "while you are in an area that is lightly/heavily obscured" feature, a homebrew "in fog" Action.
- `coverFromFoes`: the least cover the Token has from any creature hostile to it on the Scene (`coverFromFoes`: from
  each foe the better of the cover condition it holds, `heldCover`, and `coverBetween`, as that foe's attack counts it;
  `tokensHostile`; a dead or GM-hidden foe left out), absent with no foe. 2024 Hide reads it. Other uses: a "while you
  have cover" Action, a sniper's "unseen" Action.
- `eligibleTargetInRange` (2026-11-21, Q18.6; `eligibleTargetInRange` in `adapters/foundry-v14-auras.mts`): whether
  another Token on the Scene stands within the Action's own range (`normal`, else `distance`; any distance without one)
  and passes its own `targeting.eligible` (targeting.md); a GM-hidden one is left out, and with no Token it is false. Read
  only when the predicate asks (a getter, per Action: the action bar passes `actionBarContext`'s `targetInRange`). Pipes
  of the Sewers' Sway Rats requires it, so it is offered only "when an eligible uncontrolled swarm is available" (the
  owner's Q18 application). Other uses: any "a creature you can see within N feet that ..." Action greyed out with none.
- shortcut: only an Action's `requires` (the authority and the action bar) reads `obscured` and `coverFromFoes`; a
  passive rule (a RollMode, a Trigger, an aura) does not see them. Upgrade by spreading `obscured` beside
  `sunlightContext` when a passive feature needs it (`coverFromFoes` traces cover from every foe, so keep it here).
- The common Hide (and every converted Action that is Hide alone) requires
  `{any: [{equals: {path: "obscured", value: "heavily"}}, {not: {oneOf: {path: "coverFromFoes", values: ["none", "half"]}}}]}`:
  Heavily Obscured, or Three-Quarters or Total Cover from every foe (Q118 (b) default). With no foe on the Scene, or no
  Token, it passes. The action bar reads a common action's `requires` as it reads an Item's, so Hide greys out where the
  authority would refuse it, and refreshes when a Token on the viewed Scene moves, appears, hides or leaves, a wall or
  Region changes, or a creature dies. A feature's "While" of obscurity replaces it (Nature's Mantle: see below).
  A feature that lets its creature Hide elsewhere (Naturally Stealthy: obscured only by a larger creature) is noted by
  hand, as no part relaxes the common Hide's `requires`. shortcut: "out of any enemy's line of sight" is read as cover only (a Blinded foe, or one in darkness without
  Darkvision, still counts); upgrade with `tokenSees` when a Hide needs it.

## Restores (2026-10-14)

`restores: [{resourceId, amount}]` refills pools of the acting creature when the Action is paid for, each up to its
maximum. It joins the payment's mutation plan, with what each pool held before, so the transaction can roll it
back. Multiattack uses it: it costs the Action and restores its "Multiattack" pool to its number of attacks.

A payment never refills a pool it drew from. Extra Attack depends on this: an attack paid from its pool must not
refill it (rule-elements.md, "Extra Attack").

Two optional fields (2026-10-19):
- `refuseWhenFull: true` refuses the Action (`RESOURCE_FULL`, at payment) while that pool is full. Dragon Wings'
  Restore Use is refused when its use is already there.
- `amountExpression` is a ValueExpression worked out for the payer, in place of `amount`. Sorcerous Restoration gives
  back half its sorcerer level. It may also read the event a reaction or automatic Trigger answers (`event`): the Staff of the Magi's Spell
  Absorption gains `event.data.castLevel` charges.

## Costs worked out from the event (2026-11-16)

A cost entry may carry `amountExpression` (a ValueExpression), read with `{event}` only: the event the Action answers
(`state.sourceEvent`: a reaction's, or an automatic Trigger's, whose dispatcher always passes it). `costsAtEvent(costs,
event)` (action-definitions.mjs) gives each such entry its amount (0 drops it: a cantrip cancelled by an Ioun Stone of
Absorption costs nothing, owner question Q82). With no event to read (used from the sheet) the cost is unpayable
(`EVENT_REQUIRED`), so the Action is refused before anything is rolled. The targeting stage's check, the payment stage,
the reaction window's offer (`collectReactionWindows`) and the automatic Trigger's pre-check (`affordable`) all read it
the same way, so a stone with 2 levels left is not offered against a level-3 spell. The action bar keeps showing the static
`amount`. Limit: the payment a configuration picks is matched by amounts, so an Action whose configuration chooses its
payment can't use one.

## Up to N targets (2026-10-14)

A required `count` means exactly that many targets, unless `targeting.refinementPolicy.minSelections` says
otherwise. dnd5e's "up to three creatures" (Bless) converts as `{type: "multiple", count: 3, refinementPolicy:
{minSelections: 1}}`: one target is enough, three at most.

## Repeatable targets (2026-11-07)

`targeting.repeatable: true` makes its `count` that many separate hits its user shares among its targets, one creature
taking several or each its own (Magic Missile's darts: "you can direct them to hit one creature or several"). The
resolver input's `refinementPolicy.instances` is that count. One creature targeted takes every hit and as many as the
count take one each without a question; two or more but fewer than the count are asked for their shares (a number per
creature in the target-refinement prompt, sent as each select decision's `count`), which must each be at least 1 and add
up to the count. Each target context carries its `instances`, and the damage resolver gives each instance its own damage
result, so every hit on one creature is its own damage for its Concentration, a save its damage repeats, and its death
saves. The damage dice are rolled once for the Action and every hit deals that roll, as every target of any Action does.
A reaction to the damage answers one hit: its reduction (Stone's Endurance) comes off a creature's first damage result and
its redirect (Protective Bond) moves only that one.
Magic Missile's more darts per level raise the count (`scaleTargets`), and so its instances; no die is added to a dart.

**With an attack (2026-11-12).** A repeatable Action with an attack (Scorching Ray's rays, Eldritch Blast's beams) makes
one attack per instance, each judged on its own and damaged on its own. The attack roll stage asks for every instance's
roll at once (`attack-roll` for the first, `attack-roll:<n>` for the others) into the transient `attack.rolls`, in
instance order (the selected target contexts in order, each repeated its share); `attack.roll` stays the first. Each
rolls with its own creature's roll-mode sources, which the runtime gives by Token for a repeatable attack
(`attack.rollModeSourcesByTarget`: `[{mode, once?}]`). A source an attack uses up (`once`: its effect's `endsWhen`) counts
on one roll only: the creature's own that ends when it attacks (Sap, `attacks`) on the Action's first roll, and one its
target has that ends when attacked (Guiding Bolt's Advantage, Help's, a Vex: `attacked...`) on the first roll at that
target. A reaction rider's roll mode (Brutal Strike) replaces them all. The outcome stage expands each context
into one context per instance (`instance`, its own `roll`) for the attack resolver, so each hit, miss and critical hit is
its own result. The first hit's damage is the Action's ordinary damage roll; each further hit rolls its own
(`damage-roll:hit-<n>`) with its own critical hit, kept in the transient `damage.byInstance` by instance, which the
damage resolver deals to that hit. Each further roll is the definition's damage unrolled: the creature's damage modifier
is on every roll (Agonizing Blast, once per beam) but the part of it a Modifier gives to one damage roll only
(`metadata.oneRoll`, the runtime's transient `damage.modifierOneRoll`: Empowered Evocation, Elemental Affinity), and a
once-a-turn extra (Sneak Attack) and a reaction rider's added damage are only on the first. An Action of one instance (Eldritch Blast below level 5) keeps the single-roll path. Everything keyed
by creature (forced outcomes, bonuses, the defense Shield raises) applies to each instance at that creature: Shield,
lasting to its caster's next turn, judges every ray again. An event about the attack, its damage or its push names each
creature once; its data and the push stay per hit, so Repelling Blast pushes once per beam that hits. Effects an attack
applies on a hit are applied once per creature. Nothing is persisted: `attack.rolls`, `damage.byInstance` and the expanded
contexts live in the resolution state. The chat card shows each creature's best outcome (a hit after a miss is a hit).
A redirect that keeps the attack's roll (Cloud Rune) moves its creature's first hit and compares that hit's roll.

A `count` may be a `table` ValueExpression (the cantrip-scaling shape): it is the creature's row before targeting, as a
cantrip's dice are (Eldritch Blast: `{type: "table", key: {type: "character-level"}, rows: {1: 1, 5: 2, 11: 3, 17: 4}}`).

The converter reads repeatable from "to hit one creature or several", "at one target within range or at several" or "at
the same target or at different ones". Its count is dnd5e's inline total in the description
(`[[@item.level + 1]]{Total Rays}`) when it has one: a count growing with the spell's level becomes a count and a
`scaleTargets` per level (Scorching Ray: 3, one more per slot level; a dragon casting its level 3 version gets 4 through
its fixed cast level), and one reading the character's level becomes a table on that level, a row where its value
changes (Eldritch Blast).

Shortcuts: Portent and Heroic Inspiration offer only the first instance's attack roll; Empowered Spell and a damage-die
reroll (Piercer) reroll only the first hit's damage; a reaction's attack penalty (Cutting Words) lowers the instance its
event showed first; Mirror Image's decoy is keyed by creature, so it turns every hit on that creature into a decoy;
Repelling Blast is taken once per Action, for every beam that hits; Undead Fortitude and the dying adapter read "any
critical hit on this creature", not the hit that dealt the damage; a creature's attack bonus an attack uses up (Sundering
Blow's +5) is on every ray at it; the chat card names one outcome per creature, not one per ray; targets are shared
before any roll; a count expression other than a
table (Abjure Foes' `max(1, Presence)`) still reaches refinement unevaluated; the share prompt does not check the total as
it is typed; the Action Builder cannot set `repeatable` and shows a table count read-only.

## Drawn choices (2026-11-13)

`draw` fills one of its configuration choices by chance instead of by its user. It has exactly one of:

- `{table, choiceId}`: a RollTable `Item#use` draws on the client before anything is asked; the result's document uuid
  or name names the option (a Bag of Tricks' creature, filled before its summon is placed).
- `{formula, choiceId, perTarget?, noRepeat?}`: dice the pipeline's `action.draw` stage rolls once targets are known
  (2024 Prismatic Spray's d8). With `perTarget` each selected, affected target gets its own roll; without it one roll is
  shared by all. With `noRepeat: "turn"` (2026-11-20, Q25: a Beholder's Eye Rays, "reroll if it has already used that
  ray during this turn") a total landing on an option its creature drew with this Action earlier in the combat turn is
  rolled again, another RollRequest (`draw:<token>:<n>`), and the first total stands when every option was drawn
  already. Only the first option skips them, not an `again` option's extra rolls.

A rolled choice is an ordinary `option` choice whose options carry `range: [low, high]` (a RollTable result's shape).
An option may carry `again: n`: n more rolls, any landing in its own range rolled again ("Roll twice, rerolling any 8").
Options reached by those extra rolls never roll again themselves. What an option does is the choice's own `keepEffect`
(`{effectIds, keep: {option: [ids]}}`), whose ids may name damage components as well as effects; each target keeps the
parts its options keep. Validation (`path: "draw"`) refuses a draw with both or neither of table and formula, one naming
no choice, a non-simple formula, an option without a whole range, an `again` below 1, an `again` option whose range
covers every result its formula can give, a `noRepeat` other than `"turn"` or on a table draw, a `noRepeat` draw's option whose range its formula cannot reach
(it would reroll forever once every other option was drawn), and a rolled choice (or option) with any effect but `keepEffect`, since a
rolled choice is never applied as a selection.

The configuration never asks a formula-drawn choice and never applies its `keepEffect`, so the effective definition
keeps every listed part. The draw stage asks one RollRequest per roll (`draw:<token>`, `draw:<token>:<n>`;
`draw:all` when shared; `rollKind: "draw"`, its user's to roll under the dice policy), keeps the totals in the
transient `input.drawn` so a resumed stage never rolls one again, and records `results.drawResolution`
(`{byTarget: {token: [option ids]}, rolls, parts: {part id: [target refs] | true}, repeats: {part id: [[target refs] |
true]}}`). Every later stage's input then carries each listed part only for the creatures that drew it (`metadata.targetRefs`, within any refs it already had, read
by the damage resolver and the effect loop), and drops a part nobody drew, so its dice are never rolled. A part a shared
roll kept (`true`) is everyone's, and an effect on the Action's own user (`appliesTo: "source"`) reaches it when any
creature drew it. A creature none of
whose damage parts are its own takes none (a skipped damage result).

A part's first roll is the one every creature it reached shares. Two results naming the same damage part on one
creature (an 8, then Red twice) are two rays (questions-for-owner Q21, Q95 default): the repeat is a copy of that
component (`<part id>:<n>`, from `repeats`, one entry per copy) rolled for that creature alone, or for everyone with a
shared roll, under the same save. It is carried as extra damage (`extraComponents`) so the input rebuilt after each roll
keeps it. Each drawn damage component names its ray (`metadata.damageInstance`: the one option that keeps it, a copy's
`<option>:<n>`; a part several options keep names none and joins its creature's first ray), and the damage resolver
gives each ray a creature took its own damage result, as it does a repeatable target's hits: its own concentration check,
death save and damage hooks. Any damage component may carry the key. A repeated condition is not copied: it does not stack. The converter makes this shape from a spell whose text says "For
each target, roll 1d8 to determine which ..." and embeds a table whose every result it reads (dnd5e's raw tables: the `rollTables` input).
Limits: the chat card names each creature's damage and conditions, not its ray.

A `noRepeat` draw reads what its creature drew this turn through the resolver service `drawnThisTurn(definition id)`
as it first rolls (after the Action passed the one-Action guard, which also refuses a creature's second Action until its
first's `afterCompleted` follow-ups are written, so an earlier use that just completed is counted), and
keeps it in the transient `input.drawExcluded` so a resumed stage reads the same. The runtime's `afterCompleted`
writes the record (`recordDrawnTurn`): `flags.wildpath.drawnTurn = {turn, drawn: [[definition id, option id], ...]}`,
every option in `drawResolution.byTarget`, appended within a combat turn (`combatTurnKey`) and replaced on a new one.
Only options a `noRepeat` draw drew count, not a ray the GM used on its own, and outside combat nothing is recorded
(questions-for-owner Q98 (a) and (b) defaults).

### An option that uses another Action (2026-11-14)

An option of a formula-drawn choice may carry `useAction: "<definition id>"`: another Action Item of the same creature
(a Beholder's Eye Rays: each ray is its own Action). Once the drawing Action has completed, whoever started it (a user, a
Trigger, a lasting area), the active GM runs that Action as part of the same use, paying nothing (`costs` emptied,
`controllerCosts` dropped), at the creatures that drew it: every completed target for a shared roll, each creature its
own option for a `perTarget` roll, two creatures that drew one option sharing one run. With no targets, or when the used
Action's own targeting is `self` or `none`, it acts on its creature. It runs on behalf of the user of the drawing Action,
who answers its choices; its saves go to each target's controller as usual. It is an authority Action keyed
`<resolution id>:use:<action id>`, so a repeated completion never runs it twice, and it reports nothing itself.

- Reader: `usedOptionActions(state)` (`foundry-multiplayer-runtime.mjs`) reads `results.drawResolution.byTarget` only; a
  per-creature key no completed target names stays that Token id, so it is looked for on the scene rather than dropped.
  `reportActionCompleted` (every completed Action, from the runtime's `afterCompleted`) hands its result to the
  dispatcher's `useActions`, then, for an Action a user used, runs the `action.cast` Triggers (a cast) and the `action.completed` Triggers.
- Validation (`configuration.<i>.options.<j>.useAction`): only an option of the draw's own choice may carry it, as a
  non-empty string that is not the definition's own id. A picked option is refused: it would make any limited Action free
  at its user's pick.
- An Action the creature lacks, targets no longer on the scene, or a used Action whose targeting is `area` (placed by its
  user) raise `WILDPATH.NOTICE.UsedActionFailed` for the GM, naming the Action or the option's label; the others still run.
  A drawn Action never falls back to its own creature when the creatures that drew it are gone.
- A Charmed creature's drawing Action at its charmer counts as harmful (it is refused), since the Action it uses runs as
  the authority's, past that check.
- The converter makes this shape from an activity named `Roll <dice>` beside activities named as numbered results
  (`<low>[-<high>]: <label>`) that tile every total of the dice. The roll's Action takes the document's name, its range and
  a single target; each result keeps its own Action and cost (the GM's by-hand fallback, questions-for-owner Q26) and, shot
  at a single target, loses its dnd5e template. A numbered result reads its repeated save only from its own paragraph. A
  result whose paragraph says more than its save and DC, damage (half on a success), a condition for a while and its
  repeated save is noted "draw: what else its result's text says is by hand" (`PLAIN_RESULT`): the Charm Ray's ending on
  damage, the Sleep Ray's waking and Construct or Undead immunity, the Telekinetic Ray's move and Gargantuan immunity, the
  Slowing Ray's action-or-Bonus-Action, the Enervation Ray's no healing, the Disintegration and Death Rays' dust. A
  Multiattack that only uses an Action ("uses Eye Rays three times") and a Legendary Action whose whole text is "The
  <creature> uses <Action>." refill a pool that Action may be paid from, never its results. A document saying "reroll if
  ... already used ... this turn" gives its draw `noRepeat: "turn"`.

Limits: a used Action's own drawn `useAction` options do not run (no nesting, so two Actions drawing each other never
loop: the Wand of Wonder's nested d10; shortcut in `useDrawnActions`); a used area Action is the GM's by hand. One attack at a
time (Q27, 2026-11-21): a user's drawing Action holds its creature until the Actions it used have resolved, follow-ups
included (the coordinator's `holdUntil` and `holdsActor`, multiplayer-authority.md), so the next Eye Rays is declared, and
its target picked, on the battlefield the last ray left; a Multiattack or Extra Attack swing already waits for the last
one's follow-ups (`followingUp`). The target is still picked before the ray is rolled (Q98 (c) default). A used Action
whose target is gone or Unaffected by the time it runs (something else acted meanwhile) still fails as any Action does. Also by hand: the 2014
Beholder's three distinct rays and its Lair Action ray (its rays are not Actions); the Wand of Wonder (its results are
points of origin and casts of other documents, not its own Actions).

## Common actions (2026-10-14, after Baldur's Gate 3)

Every creature has the 2024 actions anyone can take, with no Items (`module/helpers/common-actions.mts`):

| Action | What it does |
| --- | --- |
| Dash | Dashing until the end of the turn: its Speed once more after its Modifiers and factors, for each Dash this turn (`speed.dash` 1; 2026-10-21) |
| Disengage | Disengaged until the end of the turn |
| Dodge | Dodging until the start of its next turn: attacks against it have disadvantage, its Agility saves advantage |
| Help | An enemy within 5 ft is Distracted until the start of your next turn: an ally's next attack against it has advantage |
| Help (a check) | `assist`: an ally within 30 ft has advantage on its next check with one of the helper's skill proficiencies, until the start of the helper's next turn (2026-10-20) |
| Hide | Only while Heavily Obscured or behind Three-Quarters or Total Cover from every foe (`requires`, Q118 (b) default); a DC 15 Agility (Stealth) check; on a success, Invisible, keeping the check's total as the DC to find it (`metadata.foundDC`, Q18.2) |
| Grapple | The target makes a Might or Agility save (the one it is likelier to pass), DC 8 + Might modifier + Proficiency Bonus; on a failure, Grappled. Not on a creature more than one size larger |
| Shove: Prone | The same save; on a failure, Prone |
| Shove: Push | The same save; on a failure, pushed 5 feet away (forced movement, areas.md) |
| Unarmed Strike | A melee attack for 1 + Might modifier bludgeoning damage |
| Search | The Action, then a Wits check: Insight, Medicine, Perception or Survival (chosen); the GM judges the total. Perception (`test.finds`) also finds hidden creatures (not allies) whose found DC it meets (Q18.2) |
| Study | The Action, then an Intellect check: Arcana, History, Investigation, Nature or Religion |
| Influence | The Action, then a check: Deception, Intimidation, Performance, Persuasion or Animal Handling |
| Utilize | The Action, spent on an object (a lever, a lock); the card says so (2026-10-19) |
| Escape | Only while Grappled or Restrained with an escape DC: the better of Athletics and Acrobatics (or of its `escapeSkills`) against it; a success ends that condition (2026-10-19) |
| Free | While its user targets a creature within 5 ft whose Grappled or Restrained hold has `escapeByOthers`: that hold's check (its skills, the helper's better one) against its escape DC; a success ends it, and with `escapeEndsAll` the rest of that Action's effects on the held creature (2026-11-07) |
| Opportunity Attack | A reaction: the creature's first melee attack Action (else its Unarmed Strike), for its Reaction |

- **Built by the authority.** An intent names one as `actionRef: "common:<id>"`. The authority builds the Action
  from the system's own definition, so a client can name a common action but never supply its rules. An unknown id
  is refused.
- **On the bar.** The action bar lists them last, in a Common group, with the same availability and odds as any
  Action.
- **Search, Study, Influence (2026-10-18).** The skill is chosen first, from a list showing each one's bonus. Once
  the authority has taken the Action, the check is rolled as a sheet roll (`Actor#rollTest`), so it can be rerolled
  with Heroic Inspiration. 2024 sets no DC: the GM judges. Live: Player1's Search spent the QA Fighter's Action and
  rolled Perception, 1d20 + 5. Its card comes just before the Action's own.
- **Finding the hidden (2026-11-21, Q18.2; Q91 (a), (b) and (d) defaults).** Three parts, each usable alone:
  - `effects[].metadata.foundDC` on any condition row: the DC a search must meet to end that instance. A number, or
    `"check"`: the pipeline's effect stage writes the total its Action's check was judged at (`withFoundDCs`, beside
    `withEscapeDCs`). 2024 Hide's Invisible carries `"check"` ("make note of your check's total, which is the DC for a
    creature to find you"), so its converted copies (Cunning Action's Hide) do too. A spell's Invisible has none, so no
    search ends it.
  - `metadata.test.finds: [<skill>]` on a test Action: a check of one of those skills also finds. Search's is
    `["perception"]`. Its sheet roll (`rollTest` with `search`) marks its card `search` with each source's roll mode
    (`rollModes`) and its d20's floor (`naturalMinimum`), and `searchHidden` (`adapters/foundry-v14-search.mts`) names
    that card to the active GM (`wildpath.search` query). The GM reads the check from the card alone (its roll's total
    and kept d20, its flags' modes and floors: `searchCheckOf`), never from the query, and searches only from a recent
    card of a check rolled to search, spoken by a Token whose creature rolled it and the sender owns, once per card
    (`flags.wildpath.searched`). There, `findHidden` checks each creature but the searcher's allies (one disposition)
    whose space its Token sees (`tokenSees` with `space`: its Invisible aside; walls and light still count), leaving
    GM-hidden Tokens out, so a neutral creature finds and is found. It deletes every instance whose numeric `foundDC`
    the total meets, which ends the condition for everyone; an ally's Search finds no one. A public card names who was
    found, and no card is posted when no one is.
  - The `perceived` roll-mode domain: a hidden creature's own Advantage or Disadvantage on checks to perceive it (the
    Cloak of Elvenkind). It counts against that creature alone, beside the searcher's own sources (its card's
    `rollModes`). Where the combined mode differs from the roll's,
    fresh dice stand in: one d20 beside a normal roll's (the lower or the higher counts), one d20 alone in place of an
    Advantage or Disadvantage roll that should be normal, and two (`2d20kh`/`2d20kl`) for the opposite mode
    (`perceivedRoll`, `perceivedTotal`). The GM rolls them with the GM's dice and sees them alone, as the creature may
    stay hidden. A creature whose die is closed unrolled is not judged.
  - The Perception card offers nothing that changes its total (Heroic Inspiration, Portent, a test offer), as the
    search runs on its first total at once and would not run again. Not yet: searching again on a changed total. A 2014 Hide (Q91 (c): a contest against passive Perception) does not exist, as the common
    actions are 2024's. Other ways the 2024 condition ends (an attack roll, a spell with a Verbal component, a loud
    sound) are not automated by this. Other uses: a fixed `foundDC` on any condition (a homebrew camouflage),
    another Action whose test `finds` with another skill.

**2024 details (2026-10-20).**
- **Grapple, Shove, Push:** `save.abilities: ["might", "agility"]`. The runtime gives each target the save it is
  likelier to pass against the DC (`bestSaveAbility`: its bonus, cover, roll modes, automatic failures) as
  `save.abilityByTarget`. `targeting.maxSizeAboveSource: 1` refuses a target more than one size larger.
- **Dash:** a ×2 factor on every Speed, so Exhaustion, Slow and Haste count.
- **Help:** its Distracted gives Advantage only to an ally of the helper (`attack.helpedByAlly`), and ends with that
  ally's attack (`endsWhen: "attackedByAllyOfSource"`).
- **Assist:** its Advantage ends when the ally makes a check with that skill, from an Action or the sheet
  (`endsWhen: "checks"`, `endEffectsWhenChecked`).
- **Ending on a save against its source (2026-10-31).** `endsWhen: "savedBySource"` ends an effect once its creature
  saves against an Action of the creature that applied it (`endEffectsWhenSaved`), not one that Action just applied
  (Eldritch Strike's mark). shortcut: any such save, not only the one its rule changed.
- **Ending on leaving its area (2026-11-07).** A condition or custom effect a lasting area's trigger applies with
  `metadata.endsWhen: "leavesArea"` lasts only while its creature is in that area (2024 Web: "Restrained ... while in
  the webs"; Spirit Guardians' Half Speed, Zone of Truth's Cannot Lie, 2026-11-14). The trigger stamps the Region's id on it (`metadata.regionId`), and the area adapter deletes it when its
  creature leaves the area or the area ends (areas.md "Leaving"). Like `"damaged"`, it sits in `metadata`, so a
  built-in condition can carry it too. Applied any other way, it is never stamped and never ends this way. One with no
  outcome policy is on every creature in the area: the area gives it as it appears and on every entering, whatever once
  per turn has spent (areas.md "Leaving", 2026-11-14).
- **Ending when its giver dies (2026-11-21, wave D, S2).** `metadata.endsWhen: "sourceDies"`, one more value of the
  same key as `"damaged"` and `"leavesArea"` (so a row has one of them), ends the effect, on whoever holds it, once the
  creature that gave it dies (dying-and-death.md, "What ends with a death"). The dying adapter reads only this value.
- Live (two browsers, 14.369):
  - QA Caster's Grapple: the Bandit Captain saved with Agility (+7), not Might.
  - A Huge Hill Giant could not be grappled.
  - With Exhaustion 2, Dash took QA Caster's 20 ft to 40.
  - QA Fighter Helped against the Captain; QA Caster's Dagger rolled 2d20kh and the help ended.
  - QA Fighter assisted QA Caster's Athletics: a Stealth check rolled 1d20, then Athletics 2d20kh, which used it up.

Shortcuts:
- Disengage stops the common Opportunity Attack, but not a movement reaction a creature's own content defines.
  Being pushed or teleported out of reach provokes none (2024).

With the `bonusActionShove` world setting (Baldur's Gate 3, off by default) both Shoves cost a Bonus Action; the bar
and the authority build them alike. Live: with it on, Player1's Shove: Push spent QA Caster's Bonus Action and left
its Action.

Help covers the 2024 attack assist; Help (a check) the other half. Live (two browsers): Player1's Help on the Bandit Captain, then an Unarmed Strike while Prone, rolled `1d20 + 1`
(the advantage cancelled Prone's disadvantage) and Distracted ended.

Not yet: Magic (a spell or magic item's own Action already is one) and Ready (the GM's call).

**An Item's Action that takes common actions (2026-11-14).** A utility activity that takes common actions is those
actions' own rules at the activity's cost (`commonActivity`, `commonRules`): Dash's effect, Hide's check, Help's
Distracted. The converter finds them in this order:
- its identifier and activity name (`COMMON_BY_TEXT`: several at once, as Step of the Wind; `COMMON_CHOICES`: one Action
  each, as Nimble Escape), then an activity named Dash, Disengage, Dodge or Hide;
- else, for an activity with no effects of its own, its own text (`commonRead`): the activity's paragraph
  (`activityText`, "Use an Object. Take the Utilize action"), or a lone activity's whole text. A sentence there that
  takes "the Dash, Disengage, or Hide action" (one Action each), "the Disengage and Dash actions" (all at once) or "can
  Hide as a bonus action" is read when its lead-in is "As a Bonus Action", "On its turn (in combat)" or a "While" the
  converter knows, its subject is its user ("you", "it", "the spirit", a `[[lookup]]`), and the clause ends there. So
  "takes the Dash action and moves away", "the Utilize action to pour it" or a "When you activate your Rage" timing are
  never read.
- A known "While" (`COMMON_WHILE`) is its `requires`: "in Dim Light or Darkness" is not in Bright Light; "in an area
  that is lightly obscured" (Nature's Mantle) is `obscured` lightly or heavily (Q59, Q118 (a) default); "while your Rage
  is active" is that feature's effect (`hasCondition: "raging"`). An unknown one leaves the activity by hand. A tabled
  activity's paragraph gives its `requires` the same way (Rage of the Wilds' Eagle).
- An Action that is Hide alone carries Hide's own place requirement (`withCommonRequires`): the mantle's "While" of
  obscurity replaces it, relaxing Hide to Lightly Obscured (Q118 (b) default: only the mantle relaxes it); any other
  "While" is added to it (`all`), so Shadow Stealth's Dim Light (only Lightly Obscured) still needs darkness or cover. A
  Hide again as a Bonus Action (Expeditious Retreat's wording) keeps it beside its marker. An Action of several (a Weretiger's Prowl: a move, then Hide) does
  not carry it, so the move is never gated by it.
- Help is the attack half (`help`). In a 2014 text its check half is another Action at the same cost, "<name> (Assist)"
  (`HELP_CHECK`, 2014 Help by Q119 (a)'s default: another creature, not a foe, at any distance, has Advantage on its next
  ability check of any kind until the start of the helper's next turn), carrying `flags.wildpath.turnEndOffer: true`, so
  it is offered as its creature's turn ends while its cost is unspent (Q61; combat-timeline.md). A 2024 text's would be
  the common Assist, built per creature from its skills, so it is noted by hand, as is "or take the Magic action to use a
  magic item" when it costs no Bonus Action (Fast Hands' own is `magicItemChoice`, Q63). The notes start
  `common action:` (a real gap in the census).

**Escape (2026-10-19).** A Grappled or Restrained condition keeps its escape DC in
`flags.wildpath.conditionEffect.metadata.escapeDC`, from the effect row's `metadata`. A Grapple stores the grappler's
8 + Might modifier + Proficiency Bonus; converted monsters and items store their own (content-packs.md). The bar
offers Escape only while the creature has one. The check uses its better skill, and a success ends that hold alone with
a removal row (`levels: -1`) naming its effect (`metadata.effectId`), so another source's hold keeps it held (Q19 (a)).
Of one condition's holds (one per source, Q19) only the highest DC's is escaped (Q19 (a)). Held by a Grappled and a
Restrained, a required choice (`hold`) asks which, the higher DC preselected, the Grappled among equals (Q93 (a) default): each option keeps its own removal row (`keep-effect`) and sets its check
(`set-check`). Free does the same over the holds another creature may free it from.
- **A hold's own escape (2026-11-07).** Four more optional `metadata` fields, all additive:
  - `escapeSkills: ["athletics"]`: the only skills Escape may roll, its better one (Web, Entangle, Iron Bands:
    "a Strength (Athletics) check"). Without it, the better of Athletics and Acrobatics, as before.
  - `escapeDC: "save"`: the DC of the save that applied it ("against your spell save DC"). The pipeline's effect
    stage writes the number that save resolved to (`withEscapeDCs`). One never resolved is no escape.
  - `escapeEndsAll: true` ("On a success, the spell ends": Ensnaring Strike): a successful Escape also ends the
    creature's other effects from the same Action and source (`effectGroupKey`, as repeatSaveGroups). Escape names their ids in
    `check.endsEffects`, and the runtime deletes them once its check succeeds (`endEffectsWhenEscaped`).
  - `escapeByOthers: true` ("the target or a creature within 5 feet of it", "freeing itself or another creature":
    a Net, the Falling Net, Iron Bands, Ensnaring Strike): another creature may make that same check for it. The
    common **Free** is Escape's definition with a single target within 5 ft instead of itself (`commonAction(actor,
    "free", {target})`, the user's first target on the bar, the intent's first target on the authority). The helper
    rolls its better allowed skill against the hold's DC; the removal row and `check.endsEffects` act on the target,
    and `endEffectsWhenEscaped` deletes them from the Action's target (the creature itself for Escape). Without the
    field only the held creature may act (Web, Entangle, a Grapple). Shortcut: 5 ft, not a longer helper's reach.
    A creature Charmed by the held one may still free it: the runtime's Charmed refusal counts a row that only takes
    a condition off its target (`levels` below 0) as not harmful.
  - The Action Builder shows none of the four fields yet (a builder gap), and shows no escape DC field for `"save"`
    (a number field would submit it empty and drop it), so an edit keeps them.
- What a common action applies names its creature as its source (`definition.source`), as an Item's Action names its
  Actor. Before (fixed 2026-10-19), a Grapple's Grappled named `common:grapple`, so its creature had disadvantage
  even on attacks against its grappler. Live: Player1's QA Fighter, grappled by the Bandit Captain, rolled
  `1d20 + 6` against the Captain and `2d20kl + 6` against QA Ally.
- Live (two browsers, 2026-10-19): the GM's Bandit Captain grappled Player1's QA Fighter. Its Grappled carried
  `escapeDC: 12` (8 + 2 + 2). Player1's bar then showed Escape; it rolled Athletics, 1d20 + 6 = 14, which ended
  Grappled and spent the Action. Escape then left the bar.

Live (two browsers, 2026-10-19): Player1's QA Fighter used Utilize from the bar; its Action went from 1 to 0 and a
"Utilize" card was posted.

Live (two browsers):
- Player1's caster used Dash from the bar: Dashing, and movement from 25 to 55.
- It shoved the Bandit Captain, which made its Might save.
- It used Dodge: the Captain's attack on the Prone caster then rolled a single d20, the Captain's advantage and
  Dodge's disadvantage cancelling.

## Ability checks (2026-10-14)

`check` is the acting creature's own ability check against a DC, the 2024 pattern: stabilizing an ally (DC 10
Wits, Medicine), hiding (DC 15), escaping a grapple.

```js
{check: {ability: "wits", skill: "medicine", dc: {value: 10}}, stabilize: true,
 effects: [{id: "fumble", type: "condition", conditionId: "prone", checkOutcomePolicy: "failure"}]}
```

- **Validation.** It names an ability or a skill, and a DC: a number, `{value}` or a ValueExpression,
  evaluated like a save DC.
- **The roll.** The creature's controller rolls it, as for an attack, before any attack or save. The bonus is
  the ability's modifier plus every Modifier on `check.<skill>`, `check.<ability>` and `check` (rolls.md). The creature's advantage and disadvantage
  on those domains combine as for any roll. The roller is never shown the DC.
- **The outcome.** It uses a save's d20-against-DC rule. It picks what the Action does:
  - each damage, healing and effect entry's `checkOutcomePolicy` is `success` (the default), `failure` or `any`;
  - `stabilize` needs a success.
- **The card** says whether the check succeeded, never its DC or margin.

Not yet:
- a check by each target, or a contest;
- automatic failure of a check;
- check events for Triggers.

`schemaVersion` is currently `1`. Future persisted changes should migrate deterministically based on
that field instead of inferring meaning from labels or opaque payloads.

## Component Model

Damage and healing are separate component arrays. Healing is not negative damage.

Damage components preserve:

- `expression`
- `damageType`
- provenance/category
- weapon-size scaling metadata
- predicates
- target/outcome policy metadata
- source and trace metadata

Healing components preserve:

- `expression`
- `healingType`
- predicates
- target policy
- scaling metadata
- source and trace metadata
- **Healing for its user, or one creature its user picks (2026-11-16)**, three additive keys, absent on ordinary healing:
  - `appliesTo`: `"source"` (its own user: a Will-o'-Wisp's Consume Life, every vampire's Bite, Vampiric Touch),
    `{from: "target", range, includeSelf}` (one creature within `range` feet of the creature that earned it, never that
    one; itself too with `includeSelf`: a Celestial Spirit's Radiant Mace) or `{from: "area"}` (one creature the Action's
    area covered, whatever its save and whether or not its user chose it as a target: Land's Aid). The pick is its
    user's controller's, one taken unasked, never a hidden or dead creature. One entry per Action may pick
    (`healing-choice`).
  - `amount: {damage: "all" | [<damage type>, ...]}`: the damage this Action dealt the creatures that earned it, an
    effect's `amount` counting (Temporary Hit Points lost included, Q23; summed over every creature that earned it,
    Q79). Its `expression` reads it as `{type: "context", path: "amount"}` (`floor(amount / 2)`: Vampiric Touch); with
    no expression the amount is the healing. Only beside `appliesTo`, and `damage` its only key (no `cap`: a capped
    share caps in its expression); validation rejects either.
  - `saveOutcomePolicy`: `"failure"` or `"success"`, only beside `appliesTo`: who earns it is those whose save matches.
  Unlike an effect's `appliesTo: "source"` (which ignores outcomes), this healing is always earned by what the Action
  did: by a matching save, else on an attack by a hit, else by each target. Nothing earned, nothing is picked or rolled.
  Homebrew: "a leeching blade: on a hit you regain half the damage" is `{appliesTo: "source", amount: {damage: "all"},
  expression: floor(amount / 2)}`. Tested in an Action used by its creature and in its reaction (the Rod of Lordly Might's Drain Life); not yet in an
  automatic Trigger or a lasting area's tick (action-resolution.md "Healing for its user").

Expressions use the shared `ValueExpression` contract. Predicates use the shared `Predicate`
contract. Rule contributions use the shared `RuleElement` contract. No duplicate expression,
predicate, or rule-element language belongs inside action persistence.

## Resolver Integration

`ActionResolver` now loads and validates an action definition at the start of planning.

```text
Action Item
-> actionDefinitionFromAction()
-> validateActionDefinition()
-> actionDefinitionToResolverInput()
-> TargetResolver / AttackResolver / SaveResolver / DamageResolver / HealingResolver / EffectResolver
-> ResourceResolver
```

If a persisted definition is invalid, resolution fails during validation with
`ACTION_DEFINITION_INVALID`; resource payment is not planned.

Definition-derived resolver input supplies mechanical defaults. Runtime input may still provide
current-use data. For example:

- definition supplies attack type/statistic/defense key
- runtime supplies attack roll total
- definition supplies save key/DC source
- runtime supplies per-target save rolls
- definition supplies damage/healing components
- runtime may overlay rolled component totals
- definition supplies target predicates/counts
- runtime supplies current target candidates or selected targets

## Relationships

Action Economy:

Actions declare cost requirements. `ResourceResolver` and the Action Economy domain discover and
commit payment options. ActionDefinition does not decide which Actor resource satisfies a cost.

Spatial:

Actions persist semantic range and area definitions. Spatial services convert those definitions to
runtime tactical distances and grid footprints. ActionDefinition never stores a current
`GridFootprint`.

Targeting:

Actions persist target requirements, predicates, and selection limits. `TargetResolver` consumes
runtime target sets/candidates and produces target contexts.

Effects and Conditions:

Actions persist effect application definitions. The current resolver supports condition effect
planning. Generic ActiveEffect creation remains a later EffectResolver slice.

RuleElements:

Action-scoped RuleElements are persisted as ordinary RuleElements. They describe contributions;
owning domains interpret them. They are not embedded action scripts.

Configuration:

`configuration[]` now feeds the Action Configuration foundation for per-use choices such as
casting resource, optional enhancements, action modes, or resource-dependent scaling. The persisted
definition still describes only what the action can do. The resolved configuration describes what
was chosen this time and produces a cloned effective definition for preview and resolution.

See `docs/architecture/action-configuration.md`.

Resolution State:

`ActionDefinition` feeds resolver requests and traces. Mutable state stays in `ActionContext`,
`ActionResult`, target contexts, roll results, mutation plans, and future `ResolutionState`.

## Migration And Compatibility

Existing Action Items that only have legacy `system.cost` data are adapted into a version-1
definition in memory. The migration is deterministic:

- identity comes from Item id/uuid
- source points at the Item
- costs come from the existing Action cost shortcut
- no attack/save/damage/healing/effect mechanics are invented
- metadata records `migration.from = "legacy-action-cost"`

This compatibility path preserves existing cost-only behavior and does not rewrite Item documents
yet. A future data migration can persist generated definitions once the broader content import path
is ready.

## Extension Guidelines

When adding a new action component:

- add the persisted component shape to `ActionDefinition`
- validate it in the pure helper
- keep values JSON-serializable
- use existing `Predicate`, `ValueExpression`, `Modifier`, and `RuleElement` contracts
- adapt the component into the owning resolver's public input shape
- keep live Foundry objects and UI state out of persistence
- add round-trip, validation, non-mutation, and resolver integration tests

Do not add feature-, spell-, class-, or monster-name branches to `ActionResolver` when a declarative
component can express the mechanic.

## Current Limits

The current integration still does not:

- roll dice
- prompt for targets
- place or render areas
- derive attack bonuses or save DCs from Actor statistics
- commit generic non-condition ActiveEffects
- build the finished Action Configuration HUD
- open reaction windows

Those remain separate milestones. This foundation closes the persistence gap so future slices can
start from a canonical ActionDefinition instead of requiring callers to hand-assemble every
mechanical resolver payload.

## Ending Effects On Targets (2026-10-19)

`ends` (optional) names what an Action ends on its targets once it completes (`endEffectsOnTargets`, run by the GM):
- `{tags: ["curse"]}`: effects whose metadata carries one of the tags (Remove Curse). The converter tags as `curse` what
  dnd5e's `cursed` status became (Bestow Curse, a lycanthrope's bite) and Hex. Since wave D B11 every committed effect's
  `metadata.tags` also holds its Action's own tags (`withSourceTags`, a union with the effect row's: a spell's `spell`
  and `school:`, a potion's `magical`; not on an entry lowering a condition's level), which a `Suppress` rule reads
  (rule-elements.md); no SRD Action is tagged `curse`,
  so Remove Curse ends nothing new, and `{tags: ["magical"]}` ends magic items' effects.
- `{contagions: true}` (2026-11-01): magical contagions, effects whose metadata names one (`metadata.contagion`,
  helpers/contagions.mjs): an Elixir of Health.
- `{spells: "slot"}` or a level: spells up to that level (Dispel Magic, the level it is cast at). A spell's effects carry
  `metadata.spellLevel`, the slot it was cast with (else the spell's own level, from the definition's
  `metadata.spellLevel`).
- `{statuses: ["charmed", "frightened"]}` (2026-11-20, Q68): each effect giving one of those statuses, with every other
  effect on that creature from the same use (its effect group, `effectGroupKey`: the same Action's id and source), so
  Guarded Mind ends Hypnotic Pattern's Incapacitated beside its Charmed. Effects from another source are judged on their
  own; a status toggled by hand has no group and ends alone. Only the target's copies end: a caster concentrating on the
  same spell over others keeps it on them (Q123's default).
- `areas: true` (2026-10-31): a lasting spell area may be its target in place of a creature (2024 Dispel Magic's
  "magical effect"). Its targeting then requires no creature; the authority requires one target, a creature or an area.
- `concentration: true` (2026-11-21, wave D A4): its targets' concentration breaks, so everything each sustains ends,
  wherever it is (its spells' effects and its lasting areas', summons' and marker's: `endSustained`, as for
  Incapacitated). It runs as the last step after completion (`endBrokenConcentration`, after `markCasterConcentration`
  and `endLostConcentration`), so a caster that fails its own save loses the concentration this very Action started
  (Earthquake). Within a lasting area's caster-turn run, a completed trigger whose `ends.concentration` reaches the
  caster ends the area's later triggers, as a broken concentration check does (both read `brokenConcentrationTargets`).
- `on: "failure" | "success"` (2026-11-21, wave D A4): gates every part above that acts on creatures (`tags`,
  `contagions`, `spells`, `statuses`, `concentration`) to the targets whose save had that outcome (a save not rolled, or
  one the save skipped as Unaffected or excluded, is neither). It reads the outcome through `outcomeTargets(state, definition, on)` (helpers/forced-movement.mts), the same
  reader a push's `on` uses. Without `on`, or on an Action without a save, `ends` acts on every completed target, as
  before; an area or object chosen in place of a creature (`dispelArea`, `dispelObject`) is not gated. Validation
  refuses any other `on` and a `concentration` that is not a boolean.

  Earthquake's save, as data: `{"save": {...}, "effects": [prone], "ends": {"concentration": true, "on": "failure"}}`.

For a spell above the level it was cast at, its caster makes an ability check with its spellcasting ability against DC
10 + that spell's level (2026-10-21), rolled as a sheet check (its bonuses and the table's dice policy); the spell ends
on a success, and the GM is told which ended and which stayed.

**A lasting area as its target (2026-10-31).** With no creature targeted, `Item#use` lists the lasting spell areas
within the Action's range (`spellAreasWithin`: measured between the nearest spaces, as targets are) and its player
picks one. The intent carries `dispelArea: {regionId}`.
- The authority finds the Region again within range from the caster's own Token, and refuses a Region out of range,
  one with no known spell level, a creature and an area together, or neither.
- Once the Action completes, `endEffectsOnTargets` deletes the Region (`options.dispelArea`) if it was cast at the limit
  or lower. Above it, the same check decides.
- A lasting area records `castLevel` when it is placed: the slot it was cast with, else its light's level (Daylight,
  Darkness), else the definition's `metadata.spellLevel`. An area with none is not a spell, and can't be chosen.
- **An object (2026-10-31, rules as written: the owner's decision).** The same list offers the spells on objects within
  range: an enchanted Item's effect held by a creature whose Token is that near (`enchantedObjectsWithin`). The intent
  carries `dispelObject: {effectUuid}`; the authority finds it again in range, and it ends as a creature's spell does,
  by its level or the caster's check. An enchantment records `spellLevel` when a spell makes it (the slot it was cast
  with, else the spell's own); one that is no spell (an infusion) can't be chosen.

Live (two browsers, 2026-10-19): QA Caster cursed the Bandit Captain (Curse Attacks, tagged `curse`) and then cast Remove
Curse on it: the curse ended. It blessed QA Fighter and then cast Dispel Magic on it: Blessed ended.

## Its Caster Concentrates (2026-10-19)

`concentration: {duration?: {value, units}}` is for a concentration spell whose definition sustains nothing automated
(Fog Cloud, Detect Thoughts, Locate Object). When the Action completes, the GM puts a marker on its caster:
- It is named "Concentrating: <spell>" and lasts for `duration`, a native V14 duration; it is deleted when it expires.
- Its concentration source is the caster's Token, like a lasting area's marker (concentration-resolver.md). So a new
  concentration, a failed concentration check or Incapacitated ends it, and casting it ends the caster's earlier one.

The converter sets it on such a spell's slot-spending activity, with the spell's duration. A follow-up activity
(spending no slot) continues the first cast's concentration instead. What the spell does is still by hand.

Live (two browsers, 14.369): QA Caster's Bless was on QA Ally. Casting Fog Cloud removed it and gave QA Caster
"Concentrating: Fog Cloud" (1 hr). Casting Bless again removed the marker.

## The GM's Decision Card (2026-11-22, wave D A18)

`gmPrompt: [{for, action}]` lists follow-ups of an Action that the GM decides, each an inline ActionDefinition run at the
GM's press (Q18.4: "prompt the GM to adjudicate the remaining consequences"). It is a top-level array in the Action
schema (`fields.mjs`), absent unless written. Validation refuses any `for` but `"failed"` and `"picked"`, a `failed`
entry on an Action without a save, and an inline Action that is not itself valid.

- `for: "failed"`: one button per creature that failed the Action's save (`outcomeTargets(state, definition,
  "failure")`), acting on that creature alone. A creature whose Token is gone when the card is posted (a killed
  creature's leaving Token) gets none.
- `for: "picked"`: one button acting on the pressing GM's own Foundry targets at the press (`game.user.targets`, those
  on the card's Scene). A press with none warns (`WILDPATH.GMPROMPT.NoTargets`) and sends nothing.

The `foundry-v14-gm-prompts` adapter does the rest:
- Once the Action completes (the runtime's `afterCompleted`, after its deaths settle), the active GM posts one card
  whispered to the GMs (`messageMode: "gm"`), spoken by the Action's source Token, with no card when no entry is left.
  Its flags are `flags.wildpath.gmPrompt: {sourceActorRef, sourceTokenId, sceneId, entries: [{id, for, label, action,
  targets, used}]}`; each entry's `action` has its `costs` emptied, as the GM's press is no use of its source's. The
  entry's Action is copied from the effective definition, and `configuredComponents` reaches `gmPrompt[].action`, so the
  slot's added dice and a chosen damage type apply to it as to the cast. Without a source Token on a Scene the GM is told
  (`WILDPATH.NOTICE.GmPromptNoToken`).
- A button shows only to a GM and only on a card whose `author.isGM` is true: a player can neither create a message as
  another user nor update a GM's, so a GM-authored card's Actions are the system's own. A used entry's button is
  disabled, titled `WILDPATH.GMPROMPT.Used`. The active GM writes `used` one write at a time, each reading the entries
  the last left (Foundry replaces the whole array), so a run's release never overwrites another entry's claim.
- A press routes like `report` (plan S6): the active GM presses directly; another GM's client sends the user query
  `wildpath.gmPrompt {messageId, entryId, targetIds}` (multiplayer-authority.md). The active GM checks the
  server-attested sender is a GM (Assistant GMs included, Q92 (f) default) and the card's author, claims the entry
  (`used: true` written, inside the card's `claimCard`) and answers at once; then it runs the entry's Action as an
  authority Action (`runAuthorityAction`) with the card's source as its source and the entry's creatures (or the
  presser's targets) as its targets, so saves go to each creature's controller and cover is counted as usual. Unless it
  completes (its source or a target gone, a failure, a cancel) the entry is released (`used: false`) and its button
  works again; a reload, a double press or a press during its saves never runs it twice.

Uses by data alone: Earthquake's "Falls into the fissure" (`failed`, with a `fall`) and its structure damage and
collapse (`picked`, tagged `affects:objects`), the Thunderous Greatclub's collapsing structure, a DMG hazard such as a
collapsing roof whose creatures the GM targets, or a homebrew trap whose consequence the GM rules on. An entry's `fall`
with no `feet` gets the depth of the area that ran the Action (`options.parentArea.depth`, a fissure's) as the card is
posted, since the press runs with no area of its own.

**Openings (2026-11-22, wave D A19).** An Action's `opens` (areas.md, "Openings across an area") adds two more entry
kinds to the same card, run by the areas adapter (`openings: {roll, open}` given to `createFoundryGmPrompts`) instead
of an inline Action: `{id: "opens", for: "roll", opens, parentArea, actionId, name, tags}`, pressed at once by the
active GM (claimed as any entry; released when a die is closed unrolled), whose completed run appends
`{id: "opens-open", for: "open", label, regionIds, definition}`; its press brings the pending openings into effect.
Not built yet: the converter reads (Phase 3, EQ3).
