# UI And UX Layer

Wild Path UI should be a command surface over the resolver layer. It should display state, gather
player or GM intent, and dispatch explicit command data. It should not decide rules legality or
mutate Foundry documents directly.

The current pure foundation is `module/helpers/ui-view-models.mjs`.

## Action Bar

The action bar view model turns an active actor, action list, and actor resource state into:

- action button state
- resource counters
- grouped action refs
- structured disabled reasons
- payment-option previews
- command payloads such as `action.use`

Availability is computed with the same action-economy payment discovery used by the resolver
layer. For example, the Wild Path rule that lets a spent Bonus Action be paid with an Action is
visible as an alternative payment option, not as a UI-only exception.

**In play (M6, 2026-10-14).** `WildPathActionBar` (`module/applications/action-bar.mts`) renders this view
model through `actionBarContext` (`helpers/action-bar-context.mts`).
- **Placement:** a frameless bar above the hotbar.
- **Creature shown:** the controlled Token's creature, else the user's assigned character. It shows only for
  an owner, and hides when there is none.
- **Contents:**
  - the Action, Bonus Action, Reaction and movement counters, then pools;
  - the creature's Actions grouped by their cost; an unaffordable one is greyed, with the payment code
    shown on hover;
  - its active conditions, with stack levels.
- **Use:** a click calls the real `Item.use()`, so the authority decides everything.
- **Updates:** it re-renders when that creature, its Items or its effects change.

**Area preview (2026-10-14, after Baldur's Gate 3).** While an area is placed, besides its fields, each creature it
would hit is outlined on its own spaces, exactly as the authority will find them (`foundryAreaTargetTokens`):
- allies, with the caster's own disposition, in amber;
- the others in red;
- hidden creatures only for the GM.

Live: Player1's Fireball over the Bandit Captain outlined the caster in amber and the Captain in red. A dead ally
was not outlined, since the authority does not target it either. Escape cancelled with nothing spent.

**Tooltips that explain, and a tidier bar (2026-10-14, after Baldur's Gate 3).**
- **Condition icons.** On the action bar and the combat carousel, hovering a condition shows:
  - its name and a short rules summary (each condition's `summary` key, with 2014 wording for the 2014
    conditions that differ);
  - the time left, for a temporary effect.

  The custom effects WildPath Actions apply (Dodging, Blessed, Raging) show too, after the conditions
  (`activeEffectViews`, `module/helpers/effect-views.mts`).
- **The bar.**
  - Buttons keep their size and wrap within their group, rather than overlapping.
  - The common actions show as icons, named in their tooltip.
  - Every button's tooltip names it, with its odds below when there are any.

Live: Player1's bar showed Prone's summary on hover, and the common actions as a row of icons.

**Movement that warns (2026-10-14, after Baldur's Gate 3).** `WildPathTokenRuler` (`module/applications/token-ruler.mts`,
`CONFIG.Token.rulerClass`) adds two things to a dragged Token's destination label:
- **Movement left.** The creature's remaining movement less the path's cost, shown as "Not enough movement" in red
  when it would run out. The authority still decides.
- **Opportunity Attacks.** Each hostile creature, still with its Reaction, whose reach the path leaves. The
  reactors are the production reaction provider's observers, and the reach relations are the authority's
  (`movementTransitionRelations`), sampled at each grid step (`observersLeftBehind`). Hidden creatures show only
  to the GM.

The label template is WildPath's own (`templates/hud/waypoint-label.hbs`), laid out like Foundry's.

Live (two browsers): Player1 dragged the Prone caster four squares from the Bandit Captain. The label read
"20 ft · 5 ft left · Opportunity Attack: Bandit Captain". A step that stayed in reach read "5 ft · 20 ft left",
with no warning. Releasing on the start square moved nothing.

**Floating combat text (2026-10-14, after Baldur's Gate 3).** What happens to a creature rises over its visible
Tokens on every client (`module/applications/floating-text.mts`), with Foundry's scrolling text:
- **Health:**
  - Damage shows as "−8" in red, healing as "+3" in green.
  - The client making the change records it in the update's options in `WildPathActor#_preUpdate`, and every
    client floats it in `_onUpdate`. That covers unlinked Tokens, whose update reaches each client through
    their delta, and a GM's edit on the sheet.
- **Outcomes:**
  - A named target's Miss, Critical hit or Saved floats on each client that can see the card. The card carries
    them as `flags.wildpath.floating`.
  - A blind card floats only for the GM.
  - Foundry already floats a condition's name when it is added or removed.

Live (two browsers): Player1's client floated "−8" over QA Caster when the Bandit Captain hit. It floated "−13"
over the Captain, an unlinked Token, when Fire Bolt hit, and "Miss" when Fire Bolt missed.

**Odds before acting (2026-10-14, after Baldur's Gate 3).** With targets chosen, each attack and save Action on
the bar shows the odds as a badge, and one line per target in its tooltip:
- an attack: the chance to hit, as "+4 vs AC 15, disadvantage";
- a save: the chance the target fails it, as "DC 13, +2", or that it fails automatically.

`foundryActionOdds` (foundry-multiplayer-runtime.mjs) computes them from the authority's own numbers:
- the attack modifier;
- the target's defense;
- every advantage and disadvantage, adjacency included;
- the save DC and the target's save bonus, roll mode and automatic failures.

Area and self Actions show none. Who sees them:
- **The GM** always.
- **Players**, when the `playersSeeOdds` house rule is on (maintainer decision: off by default).
- **A player's creature** against a target bearing an effect that creature applied with a `Reveal` rule, such as
  a martial's "size up". The builder's rule rows offer it as "Reveals its AC and saves to whoever applied it".

The bar refreshes when the user's targets change, when a creature moves, when a target's effects change, and when
the house rule changes.

Live (two browsers):
- The GM saw Fire Bolt at 25% against the Bandit Captain (+4 vs AC 15, disadvantage from Prone) and a Wits save
  at 50% (DC 13, +2). Player1 saw nothing.
- Player1 used a test "Size Up" on the Captain. Player1 then saw the same odds against the Captain, but none
  against QA Saver.
- With the house rule on, Player1's bar showed odds against QA Saver at once: 56% to hit and 60% to fail.

**Reaction settings (2026-10-14, after Baldur's Gate 3).** Each reaction on the bar has a small toggle that
cycles Ask, Always and Never ([reactions.md](reactions.md)). Live (two browsers): Player1 clicked QA Caster's
reaction to Always. The Bandit Captain's hit then triggered it with no prompt, and its card posted before the
damage. Set to Never, it was not offered. Set back to Ask, Player1 was prompted and chose it.

Live (two browsers, 14.369): Player1 controlled their hero, whose bar showed Exhaustion 2 and movement
20/20. Melee Strike, imported from the WildPath Actions pack, rolled `1d20 − 4` from the bar. The Action
counter went to 0/1 and the strike button greyed out.

## Action Configuration And Preview

The future gameplay HUD should render `ActionChoiceRequest[]` from
`module/helpers/action-configuration.mjs`, collect explicit choice responses, then render
`ResolvedActionPreview`.

The HUD may display choices such as casting resource, optional modifiers, selected damage type,
resulting damage expression, costs, and structured deltas. It must not calculate upcast damage,
damage-type substitution, or payment legality itself. Those come from Action Configuration and
Action Economy so the previewed configuration is the same configuration later consumed by
`ActionResolver`.

**Done (2026-10-14).** `Item.use({configuration})` asks an Action's choices before it is used, unless
`configuration` (`{choices}`) is given. This covers the action bar, the sheet and macros alike.
- The dialog (`promptActionConfiguration`, foundry-v14-prompt-adapter.mjs) shows the authority's own configuration
  controls. Only payable options are offered.
- Under them is a live preview from `createResolvedActionPreview`, refreshed on every change: what the choice
  spends, the damage dice it makes, and the save.
- Confirming sends `{choices}` with the intent, and the authority checks them again. Cancelling cancels the use.
- An Action with no active choices opens no dialog.
- Live (Player1, action bar): a slot spell offered the 1st- and 2nd-level slots. The preview went from 2d6 fire to
  3d6 fire, and confirming spent the 2nd-level slot and rolled 3d6.

## Combat Carousel

The combat carousel view model turns combat timeline data into:

- combat and combatant refs
- active, previous, and next turn entries
- actor/token refs
- initiative, defeated, and hidden state
- per-combatant resource/status summaries
- command payloads such as `combat.advanceTurn`

The carousel must share the same timeline and resource services as automation. It should not keep a
separate authoritative turn order or refresh model, and it should not expose a manual Actor start
turn command. Advancing real Combat is the player-facing way to reach turn recovery.

**In play (M6, 2026-10-14).** `WildPathCombatCarousel` (`module/applications/combat-carousel.mts`) renders
the shared view model through `combatCarouselContext` (`helpers/combat-carousel-context.mts`).
- **Placement:** a frameless strip at the top centre, shown while the viewed combat has started.
- **Contents:** the round, then each turn in Foundry's order: portrait, name, active turn, and defeated
  combatants dimmed. Each portrait also shows the creature's active conditions, as its Token already does.
- **Disclosure:**
  - A health bar shows only to the GM and to owners of the creature.
  - A hidden combatant shows to the GM alone. During its turn, players see no active portrait.
  - Health and conditions come from each combatant's own Token creature, so unlinked Tokens of one Actor
    stay apart.
- **Commands:**
  - A portrait pans to its Token, if the user can see it, and selects it for an owner.
  - **End Turn** shows to the GM and to the owner of the creature whose turn it is. It calls Foundry's
    `Combat#nextTurn`, so turn order and WildPath's turn automation stay Foundry's.

Live (two browsers, 14.369):
- The GM saw all three combatants, including a hidden ambusher.
- Player1 saw two, with health only on their own hero, and no End Turn button during the goblin's turn.
- On the hero's turn, Player1 ended it from the carousel.
- A portrait click panned to the goblin.
- The carousel closed when the combat was deleted.

## Concentration Check Prompts

The concentration check prompt view model turns pending concentration check requests into:

- actor/source/target refs
- actor and origin labels for display
- DC, ability, save key, and damage-taken summaries
- pending/resolved row state
- digital and physical-entry command payloads such as `concentrationCheck.submitResult`
- a commit command once every required result has been supplied

Prompt rendering should collect a roll total or explicit physical-dice outcome, then dispatch that
data to `ConcentrationCheckCommitResolver`. It should not compare saves against DCs or remove
effects directly.

## Character Sheet (M6, 2026-10-14)

The actor sheet renders `createActorSheetViewModel` (`helpers/character-sheet-view-models.mjs`) and
leaves the rules to the documents:
- **Header:** AC, level (characters) or threat (NPCs), and every Speed besides walking. The AC is the
  effective one attacks roll against (`resolveActorDefense`: gear, effects and auras). The overview's Armor Class
  field edits its stored base.
- **Rests:** Short and Long Rest buttons call `Actor#rest`.
- **Editing:** abilities, current values, and each resource's and pool's base (which sets its maximum).
  Pool fields are folded into the whole stored array, because V14 drops ArrayField element paths.
- **Conditions:** a click toggles one; on a stacking condition (Exhaustion, Envenomed) a click adds a
  level, a right-click removes one, and the level shows on the icon.
- **Death saves:** pips appear while the creature is at 0 health or has any marked. The "At 0 health"
  setting edits `system.dyingMode`.
- **Items and effects:** create, open (click the name) and delete (with Foundry's confirmation).
  Effects can also be enabled or disabled.
- **Gear (2026-10-14):** each gear row has an equip toggle, which is `system.active` and turns the gear's rules on
  or off. It also shows its weight and has an editable quantity, saved on the Item. The Gear heading shows the
  carried weight, which is quantity times weight for everything carried, equipped or not. A gear item's own sheet
  edits quantity, weight and slot.

The sheet templates' wrappers are `<div>`s. Both sheets are ApplicationV2 sheets whose root element is the
form; the templates used to open their own nested `<form>`, so their inputs never reached the sheet's
form, and no field edit saved. Live on 14.369 the actor and item sheets now save every field.

## Rules Inspector (M6, 2026-10-14)

The GM's view of why a resolution came out as it did: `WildPathRulesInspector`
(`module/applications/rules-inspector.mts`) over `inspectResolution` (`helpers/resolution-inspection.mts`).
- **Source:** the authority's own records on the GM's client, the 25 most recent. Nothing is sent over the
  network, so the Inspector may show defenses, DCs and every roll (GM-facing, per the disclosure model).
- **Shown for each resolution:**
  - the stages it ran;
  - each roll: its kind, formula, mode (advantage or disadvantage), natural and total, and digital or
    physical;
  - attacks against their defense, and saves against their DC, automatic failures included;
  - health changes from and to;
  - every payment, the source's and a companion controller's;
  - errors.
- **Opening it:** an **Inspect** link that only GMs see on each resolution card, or `game.wildpath.inspect()`.

Live (two browsers, 14.369):
- The GM inspected Player1's Melee Strike by a Restrained hero: `2d20kl` at disadvantage, then the 1d8
  damage.
- The GM's Venom Burst showed the Fortitude save, 3 against DC 13, a failure, and the 2d6 damage.
- Player1's cards carried no Inspect link.

**Waiting resolutions.** Shift+I opens the Inspector for the GM, including for a resolution with no card yet.
A running resolution that waits on another user lists who it waits on, with **Answer for them**
(multiplayer-authority.md).

## Boundary Rule

- UI renders view models.
- UI dispatches command strings and opaque entity refs.
- Resolvers decide legality and produce mutation plans.
- Foundry adapters resolve refs and commit supported document operations.

This means actor sheets, the action bar, chat buttons, the combat carousel, and future GM tools can
all initiate the same action pipeline without duplicating rules logic.
