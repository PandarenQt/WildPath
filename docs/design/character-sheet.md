# Character Sheet Design

Wild Path's character sheet is a character-management surface. It answers:

> What is true about this character?

The future gameplay HUD answers:

> What can this actor do right now?

The sheet may expose action availability and management controls, but it should not become the
primary BG3-style combat controller and must not implement rules itself.

## Reference Analysis

| Reference | Primary Strength | Primary Risk |
|---|---|---|
| PF2e official | Rules transparency and integration | Density / system-specific complexity |
| Tidy 5e Quadrone | UX, organization, readability | Still Item-centric / less rules-transparent |
| Official D&D5e | Foundry-native workflows, favorites, grouping, containers | More traditional system/document assumptions |

### PF2e Official

Wild Path adopts PF2e's principle that the sheet reflects a deep rules engine rather than
calculating rules in the UI. Derived statistics, effects, conditions, resources, and modifiers
should become inspectable through real engine traces.

Wild Path rejects PF2e-specific density and complexity where D&D-style gameplay does not need it.
The sheet should be mechanically complete without making every detail permanently visible.

### Tidy 5e Quadrone

Wild Path adopts Tidy's information architecture: clear navigation, readable grouping, compact
lists, and player-oriented terms such as Actions, Features, Spells, Inventory, Effects, and
Resources.

Wild Path rejects a purely Item-centric model. Actions, InventorySpaces, action-economy resources,
RuleElements, effects, and automation traces are domain concepts and should not collapse back into
one flat Item table.

### Official D&D5e

Wild Path adopts Foundry-native interaction patterns, document-aware workflows, favorites,
filtering, grouping, and the usefulness of container-style inventory presentation.

Wild Path rejects paper-sheet assumptions and the idea that Foundry's document shape should define
the domain UX. Inventory must use Wild Path's InventorySpace model rather than simple nested Items.

## Major Sections

The finished player sheet should organize work into coherent sections:

- Overview: identity, health, defenses, movement, abilities, core resources, conditions, key
  derived statistics.
- Actions: management and browsing for actions, bonus actions, reactions, movement abilities,
  legendary/lair/custom categories, and availability reasons.
- Features: class, subclass, species, background, feat, item, temporary, and custom feature groups.
- Spells: spellcasting sources, prepared/known/ritual/concentration grouping, slots, pact slots,
  and custom casting resources.
- Inventory: equipped, carried, containers, accessible spaces, shared spaces, and weight policy
  explanations from InventorySpace services.
- Effects: conditions, durations, suppression state, source, and summarized mechanical impact.
- Progression: level, classes, subclasses, advancement choices, companions, and ruleset-relevant
  growth.

Biography, Companions, and Debug can exist when they represent real workflows.

## Persistent Header

The header should remain focused:

- portrait
- name
- level/classes when available
- current/max/temporary HP
- AC
- movement
- initiative
- important conditions
- concentration state

Do not overload the header with every resource or every combat button.

## View Models

Use explicit presentation models before template rendering. The first foundation is
`module/helpers/character-sheet-view-models.mjs`.

Recommended long-term model split:

- `OverviewViewModel`
- `ActionsViewModel`
- `FeaturesViewModel`
- `SpellsViewModel`
- `InventoryViewModel`
- `EffectsViewModel`
- `ProgressionViewModel`

Templates should render these models and dispatch commands; they should not calculate game rules.

## Rules Inspector

Rules Inspector is a core Wild Path differentiator. Important derived values should provide a route
to inspect why they are true:

- AC
- attack bonus
- saving throw
- skill modifier
- spell DC
- movement
- resource maximum
- carrying weight
- range and reach

The explanation must come from the actual statistic/modifier/rule state used by the engine. The
sheet must not reconstruct alternate explanations in Handlebars or sheet-only code.

## InventorySpace Integration

Inventory UI must use InventorySpaces as the source of truth. It should distinguish:

- item location
- access
- equipped/carried/container/shared presentation groups
- whether weight contributes to the actor
- contents that are visible but not loaded until needed

Do not implement inventory as only a flat Item table or nested D&D5e-style containers.

## Action Economy Integration

Actions should group by actual action-economy meaning, including unknown and custom categories.
Availability and disabled reasons come from resolver/domain output. Favorites are presentation
metadata and must not alter an ActionDefinition.

The character sheet may show actions for management and quick inspection. The future HUD remains
the main combat command surface.

## Effects Presentation

Effects and conditions should show:

- name
- source
- duration
- active/suppressed state
- summarized mechanical impact
- route to inspect rules

Do not show raw ActiveEffect implementation details by default. Developer mode can expose
RuleElements, selectors, IDs, UUIDs, predicates, and resolved modifier traces.

## PC And NPC Differences

Reuse concepts, not necessarily the entire layout. PCs, monsters, companions, and sidekicks can
share statistic, resource, action, effect, and inventory components while composing them
differently.

NPC/monster sheets must support custom resources, reactions, legendary actions, lair actions,
creature size, tactical footprint inspection for GMs, and homebrew action categories without
monster-specific hardcoding.

## Item Sheet Consistency

Item sheets should share the same visual language and serve content management, mechanical
configuration, and description editing. Combat execution belongs to Actions/HUD/resolvers.

Weapon and armor sheets must keep Heavy, oversized weapon rules, designed-for size, effective size,
and damage scaling as distinct concepts.

## Responsiveness

The sheet should work at practical Foundry window sizes. Use:

- wrapping headers
- responsive grids
- tabs or section navigation
- compact rows with readable text
- progressive disclosure for advanced details

Do not make all text tiny to solve density.

## Permissions

Respect Foundry ownership and permissions. Editing, configuration, and GM-only controls should not
clutter normal player use. UI preferences such as last tab, filters, favorites, and collapsed
sections should be user/client presentation metadata rather than domain mechanics.

## Performance

Large characters may have many Items, Effects, spells, resources, and InventorySpaces. Build view
models once per render, avoid expensive template conditionals, and lazy-load remote/shared
InventorySpace contents where practical. Measure before doing elaborate optimization.

## Accessibility

Use semantic buttons, labels, keyboard-reachable navigation, visible focus, adequate contrast, and
text labels or accessible names for icon controls. Important states must not depend on color alone.

## Incremental Implementation Order

1. Sheet view-model foundation.
2. Persistent header.
3. Overview.
4. Rules Inspector.
5. Actions.
6. Features.
7. Effects.
8. InventorySpace UI.
9. Spells.
10. Progression.
11. Monster/NPC composition.
12. Polish and responsive pass.

## Early Usability Check

After Overview, Actions, and Rules Inspector exist, verify that a normal player can quickly find:

- HP
- AC
- speed
- saving throws
- skills
- resources
- conditions
- main actions

If not, fix information architecture before adding more content.
