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
    be in the caster's sight, so it never straddles a wall. Walls are tested only when the GM is viewing the
    caster's Scene.
- **Compendium creatures** are imported into the world once, and later summons reuse them.
- **Control.** Each Token is a `summon` whose controller is the caster, so the caster's Player owns and
  commands it, through the same shared control as companions.
- **Ending.**
  - With `concentration`, the caster gets a concentration marker, and the summons go when it ends. That
    happens when concentration breaks, including when the caster becomes Incapacitated, or when the marker
    is removed.
  - With `rounds`, they leave at the start of the turn they arrived on, that many rounds later, as lasting
    areas do.
  - Summons leave the combat with their Tokens.
- **What it gains with the spell's level (2026-10-15).** `summon.bonuses: {hp, ac, attackDamage, saveDamage}` are
  ValueExpressions of `castLevel`, the slot it was cast with (else `summon.spellLevel`).
  - Each summoned Token's own Actor gains the Hit Points and the AC.
  - Its damage bonuses become a feature, "Summoned at level N": a Modifier for a number, or an ExtraDamage for dice.
    `attackDamage` is on its attacks (`melee`, `ranged`), `saveDamage` on its other damage.
  - Live (two browsers): Player1 cast the SRD Find Steed with a 2nd-level slot and chose the Celestial Steed. It
    arrived where Player1 clicked, owned by Player1, with 25 Hit Points (5 + 20) and AC 13 (11 + 2). Its Otherworldly
    Slam added +2 damage.
- **The level it was summoned at** is `flags.wildpath.summonLevel` on each summoned creature, which its own rules may
  read (a spirit's Multiattack: half of it). Live (GM): a 9th-level wizard's Summon Dragon at 5th level brought a
  Draconic Spirit with 50 Hit Points, AC 19 and a Multiattack of 2 attacks and its Breath Weapon.
- **Combat (2024).** If the caster is in the current combat, its summons join it. They share its Initiative and
  take their turns right after the caster's, at its Initiative less a thousandth for each one. A creature tied
  with the caster but sorted after it still goes before the summons.

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
