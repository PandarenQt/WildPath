# Roll Architecture

WildPath separates the rules meaning of a roll from the mechanism used to obtain its result.

```text
Rules / Resolution Stage
        ↓
RollRequest
        ↓
RollProvider selection
        ↓
provider implementation
        ↓
RollResult
        ↓
Resolution interprets the result
```

## Responsibility Split

- Rules determine **what** must be rolled and which modifiers/mode apply.
- `RollProvider` determines **how** the result is obtained.
- Resolution determines **what the result means**.
- Transaction/commit determines **what persistent state changes**.
- Presentation explains the request/result to users.

Attack, save, check, damage, healing, concentration, and other rules domains must not branch on
whether dice were digital, manual, or physical unless a future explicit rule requires it.

## Current Contracts

`module/helpers/rolls.mjs` owns the plain-data contracts and validation for:

- `RollRequest`
- semantic roll types
- roll modes
- visibility policy
- authority metadata
- manual input mode
- roll provenance
- `RollResult`
- natural die versus modified total
- dice/term preservation where available
- request/result correlation
- cancellation/failure codes
- plain-data serialization validation

D20 requests preserve the natural die separately from the total so natural 1/20 and later die-face
mechanics remain possible. Known modifiers belong in the request; physical/manual users should not
need to recalculate rules-owned modifiers.

## Provider Selection

`module/resolvers/roll-provider-resolver.mjs` owns application-level provider selection and execution.
It currently supports provider registration/selection and includes factories for:

- manual roll provider
- physical dice provider
- deterministic test provider

Provider selection may consider request metadata, policy, authority, and available providers. Rules
domains do not choose providers directly.

**Dice policy.** The world setting `wildpath.dicePolicy` (GM-controlled; `digital` or `physical`)
names the provider on the rolling client: the Foundry runtime registers the digital and physical
providers and passes `dicePolicyRollContext(game)`, whose `providerId` getter is read per roll. Under
`physical` the roller types the dice into the roll prompt (natural d20, or the total for damage and
healing).

**Several saves at once (2026-10-18).** When one client rolls two or more saves for an Action (the GM's
monsters in a Fireball), its client setting `wildpath.batchSaves` decides (`answerSaveBatchLocally`):
- `physical` (the default): one window under physical dice; otherwise each is rolled digitally as before.
- `always`: one window, whatever the dice.
- `never`: every save is rolled digitally, even under physical dice.

The window (`requestBatch` on the Foundry prompt port) has a row per creature: its name, a die input, and the
formula below it. A typed row is taken as rolled (with physical provenance under physical dice), and an empty
row is rolled digitally ("Roll the rest"). A row the rules reject is asked again on its own. A single save is
asked for alone. Heroic Inspiration's questions stay one per creature. Other users' saves are separate prompts,
each titled with its creature's name (`saver`, the only part of the target sent to its roller).

Live (two browsers, 14.369, physical dice):
- QA Caster's 3rd-level Fireball caught four GM creatures and two of Player1's characters.
- Player1 got their two saves while the GM's window listed QA Saver, QA Failer, QA Ally and the Bandit Captain.
- The GM typed 10 and 4 and pressed "Roll the rest". The one card showed six saves (typed 10 → 60 saved, typed
  4 → 9 failed, two rolled) and 28 fire, halved for each success.
- With `never`, the GM got no window, and the four monster saves were rolled.

**Total bounds.** `validateRollResult` rejects a total the requested dice cannot produce
(`simpleFormulaBounds` over the authority's own request formula: `NdF` and integer terms only) for
total-mode requests and for d20 requests with a known modifier, whoever rolled it. The roll prompt
carries the same min/max. Foundry's `DialogV2.input` does not enforce them, so a rejected answer
makes the chooser's client notify the user and prompt again, up to three times.

## Foundry Digital Adapter

`module/adapters/foundry-digital-roll-provider.mjs` translates a WildPath `RollRequest` into the
Foundry V14 Roll implementation and normalizes the evaluated roll back into a WildPath `RollResult`.
Foundry Roll instances do not become the domain representation and must not be stored directly in
ResolutionState.

## Manual / Physical Dice

Manual and physical providers can return a structured input requirement when user input is missing.
The pending interaction must be surfaced through the canonical ResolutionState `roll` request and a
generic application/presentation adapter. Domain code must not call browser prompts or Foundry UI
directly.

The intended flow is:

```text
RollRequest
→ manual/physical provider
→ input required
→ ResolutionState pending `roll` request
→ ChoiceCoordinator / PromptPort
→ correlated manual response
→ RollResult validation
→ Resolution resumes
```

## Damage and healing rolls (2026-10-14)

Each damage or healing component without a fixed amount is its own roll request: `damage-roll`,
`damage-roll:1`, … and `healing-roll`, `healing-roll:1`, …
- **Why one per component.** Every damage type has its own total, so resistance lands on the right part, and a
  Player with physical dice types one total per type.
- **Flat parts.** A component's flat part rolls with it: "1d8 + 3", or "2d8 + mod(wits)" for Cure Wounds
  (`rolledBonus` in `action-definitions.mjs`).
- **The creature's damage modifier** (`damage.modifierTotal`) goes on one component, the first weapon component
  or else the first. If that component has a fixed amount, the modifier is added to the amount once instead.
- **Criticals.** A critical hit doubles each component's dice and none of the flat parts.
- **Misses.** When every attack misses, nothing rolls.

Before this, a second rolled component failed with `MISSING_AMOUNT`, a bonus written into a damage formula was
dropped, and dice healing (the pack's Mending Touch) failed the same way.

Live (two browsers, 14.369):
- Player1's fighter (Might 16) hit with a Flaming Longsword: "1d8 + 3" and "1d6" fire. Against a goblin that
  resists fire, a critical rolled "2d8 + 3" = 17 and "2d6" = 6, and the goblin lost 17 + 3.
- Mending Touch healed "1d8" = 4.

## Bonus dice on d20 rolls (2026-10-14)

A Modifier whose value is dice is rolled with the d20, not added as a number: Bless (+1d4), Bane (−1d4, written
`0 - 1d4` or `-1 * 1d4`), Guidance, Resistance.
- **The statistic.** `WildPathStatistic#dice` lists the applied dice Modifiers; they add nothing to
  `totalModifier`.
- **The snapshots.** The attack, save and check snapshots (combat-statistics.mjs) carry them as `dice`. The runtime
  passes them on: an attack's `attack.dice`, each target's save dice as `save.diceByTarget`, a check's
  `check.dice`, and a reaction's attack.
- **The roll request.** It adds them after the d20 as `purpose: "bonus"` terms, signed: "2d20kl + 1d4 + 4". Advantage
  applies to the d20 alone.
  - The total is no longer the natural d20 plus a known modifier, so only the formula's bounds check it.
  - A physical roller enters the d20, for critical hits, and the total of every die.
- **Odds.** They average over each bonus die's outcomes.

`simpleFormulaBounds` now also bounds keep-highest and keep-lowest dice (`2d20kh` keeps one d20), so an advantage
roll's total is checked too.

## ResolutionState Integration

Roll requests/results in a staged resolution are plain serializable data and correlate using stable
resolution/request identities. Stale, duplicated, mismatched, or invalid results must be rejected.
A waiting roll may pause resolution without rerunning already completed stages.

Do not store:

- Foundry Roll instances
- `Map` / `Date` / arbitrary class instances
- Applications / DOM nodes
- functions / callbacks / Promises

in the serializable roll or ResolutionState contracts.

## Advantage / Disadvantage and Modifiers

The provider executes the already-resolved roll mechanics. It does not decide whether the Actor has
advantage/disadvantage, proficiency, an ability modifier, or another rules contribution. Those are
resolved by the owning rules domains before the `RollRequest` is created.

**Ability modifiers (maintainer decision, 2026-10-14).** Saves, checks and initiative add the creature's ability
modifier automatically: floor((score − 10) / 2) of its prepared score, so a transformation's form score counts.
The authority adds it to the Modifiers it reads (`resolveActorSaveStatistic`, `resolveActorCheckStatistic`,
`actorAbilityModifier` in `helpers/combat-statistics.mjs`).
- **Saves** add the save's ability (a Fortitude save adds Fortitude), and so do concentration saves.
- **Checks** add the check's `ability`. A check that names only a skill adds no ability modifier, as no skill table
  exists yet.
- **Initiative** is an Agility check, so it adds Agility, and Modifiers on `check.agility` reach it.
- **Proficient saves** also add the proficiency bonus (attack-resolver.md, "Proficiency").
- **Death saves** name no ability, so they add only Modifiers on `save`.
- **Attacks** add their attack's ability, and weapon damage adds the same once (attack-resolver.md).

**Where advantage comes from (2024 rules, 2026-10-14):**

- **Sources.** `RollMode` RuleElements on a creature's features, gear and effects (see rule-elements.md).
- **Attack rolls.** The authority combines the attacker's own modes (`attack`, `attack.<type>`, the
  Action's own included) with the first target's modes on attacks against it (`attacked`,
  `attacked.<type>`).
- **Saving throws.** Each target uses its own modes for the save it makes (`save`, `save.<ability>`), keyed
  by Token.
- **Ability checks.** An Action's own check uses the acting creature's modes (`check`, `check.<ability>`,
  `check.<skill>`).
- **Combining.** Advantage and disadvantage cancel source for source (maintainer decision, 2026-10-14,
  in place of the 2024 rule that any one of each cancels). More sources of advantage than of disadvantage
  give advantage, more of disadvantage give disadvantage, and an equal count gives a normal roll
  (`combineRollModes`).
- **Rolling.** The `RollRequest` carries the result as `rollMode`, so a digital roll is `2d20kh`/`2d20kl`
  and the kept die is the natural result.
- **Physical dice.** The prompt tells a physical roller to roll two d20s and enter the higher or the lower.
- **Save bonuses.** Each target adds its own save bonus: its Modifiers on `save.<ability>` and `save`,
  the same way attacks read their domains (`resolveActorSaveStatistic`). Before this, live saves rolled a
  bare d20.
- **Critical hits (2024).** A critical hit rolls the attack's damage dice twice and adds flat modifiers
  once. This covers a natural 20 and a forced critical alike. A damage component written as a formula
  string is not doubled yet.

Live (two browsers, 14.369):
- Player1's Melee Strike on a Prone goblin standing next to them rolled `2d20kh` (2 discarded, 10 kept),
  hit AC 5, and dealt 2.
- Player1 struck an Unconscious goblin standing next to them. The roll was `2d20kh` (18 kept), the card read
  "Critical hit", and the damage was `2d8` = 8.
- A GM's Might-save Slam on Player1's Stunned hero requested no roll: an automatic failure for 4 damage.
  The Stunned hero's own strike was refused, because no Action was left to pay.
- A Blinded and Poisoned attacker struck a Blinded goblin: two disadvantages against one advantage. The
  roll was `2d20kl` (11 kept, 12 discarded). The strike was imported from the WildPath Actions
  compendium.

## Future Compatibility

Preserve enough structured result information for future mechanics such as:

- rerolling a die
- replacing a die
- adding/subtracting a die after seeing a result
- critical-hit policies
- Empowered-style damage rerolls
- Bardic-Inspiration-style post-roll additions

Do not implement these in the provider unless the owning mechanic requires them.

## Near-Term Integration

Manual/physical roll input routes through the generic ChoiceCoordinator/PromptPort bridge and
through the multiplayer authority coordinator when the expected roller is remote. Live on 14.369
(2026-10-13): under the physical policy a Player typed natural 12 (→ 16) and 1d8 = 4 through the real
prompts; a mistyped 9 was refused, the Player was re-asked, and the chat card showed the authority's
formulas with the validated totals. Typed dice keep the deferring provider's provenance (`physical`).

**Who decides a roll's visibility.** A request's own visibility wins (attack and damage take the
initiator's message mode). Where the rules leave it to the roller (`system`, as for saves), the roller's
client stamps its own `core.messageMode` into `rollResult.metadata.visibility`, and the authority
normalizes it to the allowed set. Live: a Player's public save appears on the card next to the GM's
damage roll.

**Failure feedback.** A failed or rejected Action is reported to the initiator as a private notification,
never a public card, because a failure reason can name things the table should not see.
