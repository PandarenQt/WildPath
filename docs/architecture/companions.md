# Companions, Summons and Sidekicks

Decided by the maintainer on 2026-10-14:

- Control of a companion or summon can be shared.
- A companion's Action may cost its controller an Action, a Bonus Action and/or movement.
- Sidekicks progress through ordinary, multiclass class records.

## Data

Every Actor has `system.companion`:

```js
{kind: "companion" | "summon" | "sidekick", controllers: ["Actor.abc", "Actor.def"]}
```

A creature with no controllers is no one's companion. The kind is a label for sheets and content; the rules
treat all three alike.

**Its controller's numbers (2026-10-31).** `actor.controllerProficiencyBonus` is its first controller's proficiency
bonus (null with none), which the `controller-proficiency-bonus` ValueExpression reads (0 with none): 2024 Primal Bond
adds it to a Beast Master's beast's checks and saves.

## Shared control

Every Player who owns one of the controllers owns the companion too. A large summoning can therefore be split
between Players: a summoner adds a friend's character as a controller, and that Player commands the summons as
well.

- **Setting it.** `actor.setCompanion({controllers, kind})` takes Actors or uuids. An empty list frees the
  creature.
- **Who applies it.** Only a GM may change ownership in Foundry. A GM applies the change directly. A Player
  who owns the companion asks the active GM through the V14 user query `wildpath.companionControl`; Foundry's
  server names the sender, and the GM accepts only an owner of the companion.
- **Ownership.** Each Player who owns a new controller becomes an owner of the companion. A Player who owned
  it only through a removed controller returns to the default. GMs, and owners the GM set by hand, are not
  touched (`companionOwnershipChanges`, `module/adapters/foundry-v14-companions.mts`).

## Controller costs

An ActionDefinition may carry `controllerCosts`, in the same shape as `costs`:

```js
{costs: {allOf: [{capability: "action", amount: 1}]},
 controllerCosts: {allOf: [{capability: "bonus-action", amount: 1}, {capability: "movement", amount: 10}]}}
```

- **Who pays.** When the companion uses the Action, one controller pays this too: the one the intent names
  (`controllerRef`), else the first listed controller the sender owns. A GM owns every controller.
- **Refusals.** A sender who owns none of the controllers is refused (`WRONG_USER`), and so is a sender who
  names a controller they do not own. A controller who cannot pay stops the Action before anything happens.
- **Committing.** The controller's payment is a second payment plan naming its payer (`payerRef`). It
  commits in the same transaction as the companion's own payment and the Action's effects.
- **Payment rules.** The ordinary payment rules apply to the controller's share. For example,
  `allowActionForSpentBonusAction` lets a controller whose Bonus Action is spent pay with its Action.
- **Free, but the controller's (2026-11-21, Q33).** `byController: true` makes an Action its controller's to take
  though it costs nothing (`controllerPaid`): it is on the controller's bar, not its own creature's, needs a controller
  the sender owns, and does not make its creature act on a turn of its own. Its `requires` reads that controller
  through `requiresContext`'s `controller`: `controller.actorSystem` and `controller.ownTurn` (the running turn is the
  controller's). 2024 Conjure Animals' pack has one, a free Move.

## Sidekicks

A sidekick is a creature with `kind: "sidekick"`. It levels up through class records (`system.classes`, see
[classes-and-spellcasting.md](classes-and-spellcasting.md)), multiclassing included. It is controlled like
any companion.

## Summoning (2026-10-14)

An ActionDefinition's `summon` brings creatures when the Action completes:

```js
{summon: {actorRef: "Actor.wolf", count: 2, rounds: 10, concentration: true}}   // or choiceId: a choice of creatures
```

- **Choosing the place (2024).** Using the Action, the caster's Player clicks once for each creature, on fields
  within the Action's range; a field out of range is refused. The intent carries at most 20 points. The authority
  checks each point again: a creature appears on its point, or on the nearest allowed place to it.
- **Placement.** The active GM places unlinked Tokens of the creature where the caster clicked, and any without a
  click on the nearest places around the caster's Token where it fits. The search is breadth-first over the grid's own adjacency, so square and hex
  grids work alike.
  - A place fits when every field of the summon's footprint is free, including of summons placed before it, so a
    Large summon needs all four of its fields.
  - It must be on the Scene (not in its padding) and within the Action's range of the caster.
  - Under the 2024 rules it must also be a space the caster can see. The summon's centre and every field must
    be in the caster's sight, so it never straddles a wall. Walls count on any Scene
    ([senses-and-cover.md](senses-and-cover.md#walls-on-any-scene)).
- **Compendium creatures** are imported into the world (`flags.wildpath.summonSource`) while a summon of them is
  out, and later summons reuse the import. When a summon's last Token goes (dismissed, or deleted by hand) the
  active GM deletes the import, and the next summon imports it again (2026-11-14); so does a cast that placed
  none. An import is kept while any Token on any Scene stands for it, while a summon is being placed, or when a GM
  has given it to a Player or to everyone by hand; a Token the GM placed of it by hand, or any other Action, never
  removes it, and one being deleted is never reused. A summon's Token names its creature
  (`flags.wildpath.summon.sourceUuid`), so one brought back by undo after its import went is given a new import.
  A GM's edits to an import are lost with it; a summon's own changes live on its unlinked Token.
  An import names its own id (`flags.wildpath.summonImport`, written at creation through `keepId`), and only an Actor
  whose flag equals its id counts as one. A GM's copy of an import (the sidebar's Duplicate, or
  `Actor.create(import.toObject())`) gets a new id, so it is never reused or deleted (2026-11-14). Imports made before
  that flag existed are left alone as well: they stay in the Actors directory and the next summon imports afresh.
- **Control.** Each Token is a `summon` whose controller is the caster, so the caster's Player owns and
  commands it, through the same shared control as companions.
- **Ending.**
  - With `concentration`, the caster gets a concentration marker, and the summons go when it ends. That
    happens when concentration breaks, including when the caster becomes Incapacitated, or when the marker
    is removed.
  - With `rounds`, they leave at the start of the turn they arrived on, that many rounds later, as lasting
    areas do.
  - Summons leave the combat with their Tokens.
  - A concentration summon's spell ends with its last creature (2026-11-21): `dismiss` deletes its caster's marker once
    none of the Tokens it names is on the Scene, whatever dismissed them (dispelled, a carried area's budget, rounds).
  - Dispel Magic (Q31, Q99 (f)): a lasting spell's summon (`rounds` or `concentration`, with `summon.spellLevel` or its
    Action's `metadata.spellLevel`, a cantrip's 0 included: Mage Hand, Dancing Lights) keeps
    the level it was cast at as `flags.wildpath.summon.castLevel`, so Dispel Magic targeting the creature judges it as a
    spell of that level (within the slot it ends, above it on its caster's check) and `dismissCast` dismisses its whole
    cast (the Tokens with its caster, Action and `at`: one dispelled wolf takes the other seven). An instantaneous
    spell's creature (Find Familiar, Animate Dead, Find Steed) and a feature's (no spell level) have none and stay. Choosing
    the area it carries ends it the same way (areas.md `end`). A spell lasting "until dispelled" has no rounds in
    the data, so Dispel Magic does not end its summon (Continual Flame's flame stays, by hand).
- **What it gains with the spell's level (2026-10-15).** `summon.bonuses: {hp, ac, attackDamage, saveDamage}` are
  ValueExpressions of `castLevel`, the slot it was cast with (else `summon.spellLevel`).
  - Each summoned Token's own Actor gains the Hit Points and the AC.
  - Its damage bonuses become a feature, "Summoned at level N": a Modifier for a number, or an ExtraDamage for dice.
    `attackDamage` is on its attacks (`melee`, `ranged`), `saveDamage` on its other damage.
  - `healing` (2026-11-01) is a Modifier on its healing (`healing` domain): a Find Steed steed's Healing Touch heals the
    spell's level more. dnd5e's `hd` (Hit Dice by level) is not added: they are spent only on a rest (noted).
  - Live (two browsers): Player1 cast the SRD Find Steed with a 2nd-level slot and chose the Celestial Steed. It
    arrived where Player1 clicked, owned by Player1, with 25 Hit Points (5 + 20) and AC 13 (11 + 2). Its Otherworldly
    Slam added +2 damage.
- **The level it was summoned at** is `flags.wildpath.summonLevel` on each summoned creature, which its own rules may
  read (a spirit's Multiattack: half of it). Live (GM): a 9th-level wizard's Summon Dragon at 5th level brought a
  Draconic Spirit with 50 Hit Points, AC 19 and a Multiattack of 2 attacks and its Breath Weapon.
- **Combat (2024).** If the caster is a Combatant, its summons join its combat (a started one first, else one not
  yet begun), whatever combat the GM's tracker shows, and their rounds count there.
  - **Whose turn (2026-11-20, Q32's scope, Q99 (a) and (b) defaults).** `summon.initiative` (`summonInitiative`):
    - `"own"`: the active GM rolls one Initiative for the cast through `Combat#rollInitiative` (the dice policy: a
      physical roll asks the GM), and every creature of that cast shares it. One that rolls above the current turn first
      acts next round. Closing the prompt leaves them unrolled.
    - `"summoner"`: a controlled mount (Find Steed: the converter reads "functions as a controlled mount") keeps its
      rider's turn, at the caster's Initiative less a thousandth for each one. A creature tied with the caster but sorted
      after it still goes before it.
    - `"none"`: no Combatant (Mage Hand, Arcane Eye, a sensor, an illusion, Flaming Sphere, Guardian of Faith).
    - Unset: `"own"` when its creature acts (an Action it pays for itself, or a Trigger on its own turn's start or end,
      a Faithful Hound's bite), else `"none"`. An Action its summoner pays (`controllerCosts`) is not its own.
  - **Rounds** count from the turn it arrived on by the Combatant whose turn it was (`createdAt.combatantId`,
    `roundsPassed`, shared with lasting areas), so a summon rolling above that turn, or any Combatant joining or leaving
    ahead of it, does not end it a turn early. One created before `combatantId` existed keeps its recorded index.

Live (two browsers, 14.369): Player1's summoner used Call Wolves. Two wolves appeared beside it, owned by
Player1 and controllable, each listing the summoner as its controller. Stunning the summoner broke its
concentration and both wolves left.

Live (GM browser, 14.369, 2026-10-14): in a combat, two wolves summoned for one round joined at 9.999 and 9.998
behind their summoner's 10. At the start of the summoner's next turn they left the Scene and the combat, and the
turn stayed on the summoner.

Live (GM browser, 14.369): three 2×2 wolves summoned in a corridor three fields wide, with a wall on each side,
all stayed inside it. None overlapped another or the caster.

Live (two browsers, 14.369): Player1 used a 30 ft summon of two wolves and clicked 15 ft away, then 50 ft away,
then 10 ft away. The 50 ft click was refused as out of range. The wolves appeared on the other two fields, owned
by Player1.

## Evidence

- **Two browsers, 14.369.** The GM made a wolf the summon of Player1's summoner, and Player1 then owned the
  wolf. Player1 used the wolf's Bite through the real `Item.use()`: the goblin took 6, the wolf spent its
  Action, and the summoner paid its Bonus Action and 10 ft (30 → 20). Player1 then shared control with a
  GM-owned keeper through the GM. A forged request to take control of a goblin Player1 does not own was
  refused.
- **Node.** Ownership changes, controller-cost validation, the end-to-end payment, and the refusals.
- **Quench.** Ownership follows the controllers on real Documents, and an Action Item stores its
  controller costs.

## Not yet

- No prompt asks which controller pays when a Player owns several. The first is used, and `controllerRef`
  chooses one through the API.
- Sheet controls for controllers and controller costs.
- A companion's movement paid from its controller's.

## Carried areas and matched saves (2026-11-14)

- **`summon.area`**: `{shape: "emanation", size, persistence: {affects?, oncePerTurn?, light?, budget?, triggers}}`, the
  lasting area each summoned creature carries (areas.md "Carried by a summon"). It is the caster's: its triggers use
  the caster's spell save DC and the slot the summon was cast with. It lasts as the summon does, so it takes no
  `concentration`, `duration` or `onObject` of its own (validated). The runtime hands the summoned Tokens to
  `areas.carry` once they are placed.
- **`summon.match.saves`**: as `match.attacks` does for attacks, every save DC and grapple escape DC of the
  creature's Actions and of its features' Trigger Actions becomes its summoner's spell save DC as it appears
  (`matchedSaves`): 8 + Proficiency Bonus + spellcasting modifier (the ability a granting feature gives the summoning
  spell, as its own DC reads it) + its summoner's `dc.spell` statistic for the summoning Action (Innate Sorcery, a Robe
  of the Archmagi), so its creature's saves and its spell's own (its carried area's) use one DC. It is frozen then,
  like `match.attacks`.
- **Converter.** A spell whose summon has one save (or damage) of the same activation beside it, and whose text says
  its creature does it "within N feet of the <it>" on a turn boundary or entering (Flaming Sphere, Guardian of Faith,
  Conjure Animals), converts that save into `summon.area` instead of a second cast (`carriedArea`): its reach, events
  ("moves to a space within" is entering), "enemy" or "you can force" (its caster's enemies, Q30), "a creature you can
  see" (only those its caster sees: its triggers' `targeting.eligible`, areas.md, Q30), "half as much" in
  that sentence or the next, its light, and "vanishes when it has dealt a total of N damage" as a budget. The spell's
  creature reads its own feature with the same sentence reader (its biography embeds the spell: `madeBy`), so Flames,
  Guarded Area and Pack Damage are the spell's area and Guarded Area's pool is its budget. dnd5e's `match.saves`
  converts for spells and class features (Arcane Hand, Summon Dragon, Investment of the Chain Master).
- **Summons act on their own turn (Q32, 2026-11-20).** A spell-made creature its caster commands "as a Bonus Action on
  your later turns" (Spiritual Weapon, Arcane Sword, Arcane Hand, Conjure Fey's spirit) acts on its own turn at its own
  Initiative with its own Bonus Action, its first turn included, and its caster keeps theirs. Conjure Fey's caster-side
  "Teleport and Attack" is not converted: it is the spirit's own Command (Q99 (i) default; the converter drops a spell's
  Bonus Action utility beside a summon whose text says so). Faithful Hound's bite is an automatic `turn.started`
  Trigger on the hound, on one enemy within 5 feet its controller picks, at its caster's DC (`match.saves`), at the
  start of the hound's own turn at its own Initiative (Q67).
- **Moves on the caster's turn (2026-11-21, Q33, Q99 (c), (d) and (e)'s first half defaults).** A creature moved only at its
  caster's word (an Action its controller takes whose effect has the `moved` Modifier: an Arcane Eye, a Flaming Sphere,
  the spectral pack) has Speed 0 of its own (the converter's `commandedMove`), so it moves only what that Move gives:
  30 feet of movement until its caster's turn ends. That turn is its caster's: a creature with no Combatant that a
  combatant controls starts what it gives itself on its controller's Combatant (`sourceCombatant`), so "until the end
  of the turn" ends as its caster's turn does. The sphere's Roll costs the caster's Bonus Action and rams
  (`occupancy.ram`, areas.md "A ram"); its old DC 5 save is gone. The pack's Move (`byController`, read from "when
  you move on your turn, you can also move the pack up to 30 feet") is enabled once its caster has moved on its own
  turn (`controller.ownTurn`, `controller.actorSystem.resources.movement.spent` at least 1) and once a turn (its own
  effect's status; "in one go" is not enforced: its 30 feet may be dragged in several steps that turn); its saves
  stay its carried area's (Q30). Conjure Animals' Advantage on Strength saves near the pack is by hand. Faithful Hound's "Move Hound" stays a caster-side Action by hand: its hound has no move of its own to
  host it (Q99 (i)'s second half).
- **Movement without a turn (Q99 (c), 2026-11-20).** A creature with no Combatant that a combatant of a started combat
  controls (`companion.controllers`: an Arcane Eye, a Flaming Sphere, the pack) is in that encounter: its movement is
  tracked (`movementTracked`) and comes back at the start of its controller's turn (`Combat#_onStartTurn`), so it moves
  its own Speed once a round, plus what a caster-paid Move grants. The converted Arcane Eye, Flaming Sphere and pack have
  Speed 0 (Q33, above), so they move only by their caster's Move.
- **On the controller's bar (2026-11-20, Q99 (h) default).** A controlled creature's Actions its controller pays
  (`controllerCosts`: an Arcane Eye's Move, a Flaming Sphere's Roll, a Steel Defender's commanded Rend) show on the bar of
  each creature in its `companion.controllers` (its caster, and a friend the caster shares it with), in a group named for
  it, used with that creature as the controller (greyed once it can't pay), as a vehicle's crew Actions are
  (vehicles-and-mythic.md). They are left off the controlled creature's own bar. Only creatures on the viewed Scene.

## Chosen by Challenge Rating, counted by formula (2026-10-19)

- **By Challenge Rating:** a dnd5e summon chosen by Challenge Rating (`mode: "cr"`) converts to the usual creature choice.
  Its options are every converted Beast of its profile's CR or lower: Find Familiar's CR 0 Beasts, and Pact of the
  Chain, Investment of the Chain Master and Wild Companion the same way. A Beast several profiles allow takes the
  lowest-CR profile's count, the most creatures, whatever order dnd5e lists them in (2014 Conjure Animals: a CR 1/4 Wolf
  comes eight at a time, Q30); each option is one kind of Beast (Q99's default). shortcut: Celestial, Fey and Fiend forms.
- **Counts:** `summon.counts: [{actorRef, count}]` gives each creature its own count. It is a list because a uuid's dots
  would be read as nested keys when stored.
  - A count is a whole number (Dancing Lights: 4 small lights or 1 medium) or a ValueExpression worked out when cast,
    at the cast level and with its caster's statistics. Animate Dead: 1 + 2 per slot level above 3rd. Animate Objects:
    its spellcasting modifier, divided for the larger objects.
  - A count below 1 summons nothing and warns the GM. Without `counts`, `count` is used.
- **Live (two browsers, 14.369):** Player1's QA Caster cast Find Familiar, chose an Owl from 26 CR 0 Beasts and
  clicked where it appeared. Dancing Lights with the small lights gave four.

## Risen from the killed (2026-11-07)

- `summon.fromKilled: {types: ["humanoid"]}`: each target of a listed creature type the Action killed rises as the
  summon, one each, in its corpse's space (the corpse no obstacle, its caster's range and sight not checked). Killed
  by it: the dying adapter's `afterResolution` returns the uuids of the creatures the Action's damage killed (its
  `die`), which the runtime hands to the summons adapter. One already dead, even one healed since, is never killed
  again, so a corpse does not rise twice; a dying creature finished off at 0 is killed and rises. None killed:
  nothing, and no notice. Nothing to click when used. Control, combat order and the world import are the usual summon's.
- The converter folds a summon activity with no activation into its document's damaging Action when its text says
  "<Type> killed by this ... rises" or "<Type> reduced to 0 Hit Points by this ... dies ... rises": Finger of Death and
  its casts (a Lich's), a Shadow Dragon's Shadow Breath.
- shortcut: it rises at once, not "at the start of your next turn" (Finger of Death); a character "reduced to 0 Hit Points dies" (Shadow Breath) is dying, so none rises from one (noted
  by hand). A Death Tyrant's Negative Energy Cone (any corpse in the cone) and a Wight's "24 hours later" stay by hand.

## An artificer's summons (2026-10-20)

Tasha's Steel Defender, Homunculus Servant and Eldritch Cannon, through the local book module.
- **The creature by level.** A class feature's creature options carry `level {min?, max?, class?}`
  (`summon.identifier`'s class: the Steel Defender from artificer level 3, the improved one from 15). `withSummonLevels`
  offers only those at its creature's level. A spell's profile levels are its slot's (Find Steed) and are left alone.
- **Bonuses from the summoner.** A class feature's bonuses read its summoner: the Steel Defender's Hit Points are its
  Intelligence modifier + 5 per artificer level (`summonBonusesAt(…, {actor: caster})`). A feature's summons get them
  without a spell level.
- **The summoner's attack bonus** (`match.attacks`, for spells and class features). Each attack gets a Modifier, on
  that Action only, making its bonus the summoner's spell attack modifier (`matchedAttacks`). 2024 spirits read it too ("Bonus equals your
  spell attack modifier"). A magic item's creature (the Dancing Sword) keeps its own.
- **Limits.**
  - `limit`: one Steel Defender, one Homunculus, the Cannons by their uses. The summoner's oldest from that Action are
    dismissed first.
  - `endsWithSummoner`: the Homunculus is dismissed when its summoner has the Dead condition.
- **Commanded.** The Steel Defender's and Homunculus's Actions that cost its Action also cost its summoner's Bonus
  Action (`controllerCosts`). Its reactions and its free Dodge stay its own. shortcut: an Eldritch Cannon's features
  are its description.
- **The converter** now takes an activity's own activation over an Item's leftover "none" (the Steel Defender's Rend
  became an attack).

Live (two browsers, 14.369): QA Caster as a level-5 artificer (Intelligence 18) summoned the converted Steel Defender.
It had 31 Hit Points, attacked at +7 (spell +4, Proficiency +3), and its Rend cost QA Caster's Bonus Action. A second
summon dismissed the first.
