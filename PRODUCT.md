# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The maintainer's own group: one GM and their players. Wild Path is a private system for that table, with no
public package release planned. The GM runs Foundry VTT and owns the rules choices; players control their own
characters. Both need the game to keep moving, without anyone stopping to look up a rule or apply one by hand.

## Product Purpose

Wild Path is a Foundry VTT V14 game system for fifth-edition D&D built around a smart rules engine. A player clicks
an Action and the engine resolves it: targets and areas, attack rolls or saves, damage and healing, conditions,
resource costs, and the reactions it triggers. Success means a full session runs with every rule automated and
nothing left to do by hand.

## Positioning

One rules engine runs everything, instead of an item-by-item automation layer bolted onto a paper-sheet system:

- **2024 rules, the whole catalog.** The engine aims to automate every Wizards book on D&D Beyond from 2014 on,
  with 2014 content played under 2024 rules and a world setting for the 2014 rules where they differ.
- **Baldur's Gate 3 turn flow and UX.** The action bar, area previews, the combat carousel and explanatory
  tooltips follow BG3. BG3's rule groups (high ground, surfaces, bonus-action moves) are opt-in world settings,
  off by default.
- **House rules are first-class.** The table's rules, such as paying a Bonus Action with an Action or the cantrip
  rule, are configured rules in the engine, not exceptions.
- **Every number can be traced.** The Rules Inspector and resolution details show where a result came from.
- **A homebrew builder for GMs who don't code.** It saves real structured mechanics that the engine runs.

## Operating Context

- Sessions are a mix of online play with remote players, in person with each player on their own device, and in
  person with one shared screen. Settings change from session to session.
- Physical dice are common. Players roll real dice and enter the result, and the GM sets dice policy. A physical
  roll and a digital roll must produce the same result in the engine.
- Foundry is multiplayer: the GM client and player clients see the same scene with different permissions, and
  hidden information stays GM-only.
- Main surfaces: the action bar above the hotbar, the combat carousel, chat resolution cards, reaction prompts,
  the character sheet, the item builder, the Rules Inspector, and GM tools (rests, journeys, chases, Bastions,
  crafting, traps).
- The player and GM guide lives in `docs/guide/` and ships as the WildPath Guide compendium.

## Capabilities and Constraints

- Target: Foundry VTT V14 only (`system.json` compatibility 14). UI uses ApplicationV2 and Handlebars templates
  (`templates/`) with one stylesheet (`styles/wildpath.css`).
- The UI is a command surface over the resolvers. It shows state and sends choices; it never decides whether a
  rule applies or changes documents itself. A disabled control shows the engine's reason.
- Terminology: user-facing name is **Wild Path** (spaced); package id `wildpath`. Player-facing terms are
  Actions, Bonus Actions, Reactions, Features, Spells, Inventory, Effects and Resources.
- The character sheet answers "what is true about this character"; the action bar answers "what can I do right
  now". The sheet is not the combat controller.
- All user-visible strings live in `lang/en.json`. Agents may write short, plain functional UI copy; lore, rules
  prose, item descriptions and journal content are not generated.
- Languages render in script for characters who can't read them, using committed Noto OFL fonts in `fonts/`.

## Brand Commitments

- The name is Wild Path. Baldur's Gate 3 is the binding reference for game flow and UX; PF2e (rules
  transparency), Tidy 5e (organization) and the official dnd5e system (Foundry-native workflows) are the named
  references in `docs/design/character-sheet.md`.

## Evidence on Hand

- SRD 5.2 content in `packs/` (CC-BY-4.0, attributed in `README.md` and per document in `flags.wildpath.source`).
- Premium books (PHB, DMG, MM and others) are converted into the local world only and are never committed or
  shown in shipped material.
- Live-play evidence and QA captures in `evidence/` and `docs/development/project-state.md`.
- There are no users outside the maintainer's table, no testimonials and no public release. Do not invent them.

## Product Principles

1. **The engine decides; the UI shows.** Every rule lives in the engine, and the interface shows the engine's
   result and its reasons.
2. **Nothing by hand.** A rule the table has to apply by hand is a gap to automate, not an accepted state.
3. **Keep the turn moving.** Follow BG3's flow: the next useful choice is visible, and nobody waits on a lookup.
4. **Explain on demand.** Details stay one hover or click away, and every number can be traced.
5. **The table's rules are rules.** House rules and rule-version differences are settings in the engine, never
   special cases in the UI.
