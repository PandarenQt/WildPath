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
- Summoning creatures from an Action.
- Sheet controls for controllers and controller costs.
- A companion's movement paid from its controller's.
