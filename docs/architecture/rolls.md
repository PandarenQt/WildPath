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

**Where advantage comes from (2024 rules, 2026-10-14):**

- **Sources.** `RollMode` RuleElements on a creature's features, gear and effects (see rule-elements.md).
- **Attack rolls.** The authority combines the attacker's own modes (`attack`, `attack.<type>`, the
  Action's own included) with the first target's modes on attacks against it (`attacked`,
  `attacked.<type>`).
- **Saving throws.** Each target uses its own modes for the save it makes (`save`, `save.<ability>`), keyed
  by Token.
- **Combining.** `combineRollModes` applies the 2024 rule: any advantage and any disadvantage cancel,
  however many of each.
- **Rolling.** The `RollRequest` carries the result as `rollMode`, so a digital roll is `2d20kh`/`2d20kl`
  and the kept die is the natural result.
- **Physical dice.** The prompt tells a physical roller to roll two d20s and enter the higher or the lower.

Live (two browsers, 14.369): Player1's Melee Strike on a Prone goblin standing next to them rolled
`2d20kh` (2 discarded, 10 kept), hit AC 5, and dealt 2.

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
