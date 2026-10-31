---
name: Wild Path
description: Parchment-and-ink windows and an ink-dark, lantern-lit HUD for an automated 5e system in Foundry VTT.
colors:
  verdigris: "#2f6f68"
  verdigris-contrast: "#ffffff"
  lantern-gold: "#e0b44c"
  focus-brass: "#b5822a"
  parchment: "#f3ead7"
  parchment-light: "#faf5e9"
  vellum: "#fffdf6"
  ink: "#2a2219"
  faded-ink: "#6a5d4c"
  ink-rule: "rgba(88, 70, 46, 0.35)"
  ochre-warning: "#8a5f23"
  oxblood-danger: "#8a3434"
  moss-success: "#2f6b3a"
  hud-ink: "rgba(28, 23, 18, 0.92)"
  hud-parchment: "#f2e8d5"
  hud-faded: "rgba(242, 232, 213, 0.7)"
typography:
  headline:
    fontFamily: "Signika, sans-serif"
    fontSize: "1.45rem"
    fontWeight: 700
    letterSpacing: "0"
  title:
    fontFamily: "Signika, sans-serif"
    fontSize: "1rem"
    fontWeight: 800
    letterSpacing: "0"
  body:
    fontFamily: "Signika, sans-serif"
    fontWeight: 400
  row-name:
    fontFamily: "Signika, sans-serif"
    fontWeight: 700
  label:
    fontFamily: "Signika, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 800
  detail:
    fontFamily: "Signika, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
  hud:
    fontFamily: "Signika, sans-serif"
    fontSize: "0.85rem"
    fontWeight: 400
  hud-small:
    fontFamily: "Signika, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
  mono:
    fontFamily: "monospace"
    fontSize: "0.8rem"
rounded:
  badge: "3px"
  card: "4px"
  control: "6px"
  panel: "8px"
  pill: "999px"
spacing:
  xs: "0.25rem"
  sm: "0.35rem"
  md: "0.5rem"
  lg: "0.75rem"
components:
  button:
    backgroundColor: "{colors.parchment-light}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "1.9rem"
  input:
    backgroundColor: "{colors.vellum}"
    textColor: "{colors.ink}"
  sheet-tab:
    textColor: "{colors.ink}"
    typography: "{typography.row-name}"
    rounded: "{rounded.control}"
    height: "2rem"
  sheet-tab-hover:
    textColor: "{colors.verdigris}"
  sheet-nav:
    backgroundColor: "{colors.vellum}"
    rounded: "{rounded.panel}"
    padding: "0.25rem"
  summary-pill:
    backgroundColor: "{colors.parchment-light}"
    textColor: "{colors.faded-ink}"
    typography: "{typography.detail}"
    rounded: "{rounded.pill}"
    padding: "0 0.5rem"
    height: "1.35rem"
  sheet-section:
    rounded: "{rounded.panel}"
    padding: "0.75rem"
  sheet-row:
    backgroundColor: "{colors.parchment-light}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0.3rem 0.45rem"
    height: "2.6rem"
  chat-card:
    backgroundColor: "{colors.parchment-light}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "4px 6px"
  outcome-badge:
    typography: "{typography.row-name}"
    rounded: "{rounded.badge}"
    padding: "0 0.375rem"
  hud-bar:
    backgroundColor: "{colors.hud-ink}"
    textColor: "{colors.hud-parchment}"
    typography: "{typography.hud}"
    rounded: "{rounded.control}"
    padding: "6px 8px"
  hud-carousel:
    backgroundColor: "{colors.hud-ink}"
    textColor: "{colors.hud-parchment}"
    typography: "{typography.hud-small}"
    rounded: "{rounded.control}"
    padding: "4px 8px"
  carousel-turn:
    rounded: "{rounded.card}"
    width: "56px"
---

# Design System: Wild Path

## Overview

**Creative North Star: "The Annotated Ledger"**

Wild Path's windows read like a ledger kept on parchment: ink text, thin ruled borders, and rows of facts about a
character, each one written by the engine and open to inspection. The page is warm and quiet so the numbers carry
the weight. Verdigris is the annotator's second ink, marking what can be followed (a link, a tab, a total the engine
worked out). Over the battle itself sits a different material: an ink-dark HUD, lit by Lantern Gold, that floats on
the scene without hiding it.

The look is fixed. Every colour a Wild Path surface shows is set in `styles/wildpath.css` on the `--wp-*` custom
properties, so sheets, dialogs and chat cards look the same under Foundry's light and dark themes. Density is
moderate: compact rows and small labels, enough room that a player reads a number in the middle of a turn without
hunting for it.

Controls are moving toward **tactile and confident**: things you press, not text you might click. Today they are
flat with thin borders. Future work adds weight through fills, heavier borders and a visible pressed state, never
through shadows.

**Key Characteristics:**
- Parchment page, ink text, ruled borders: windows, dialogs and chat cards share one material.
- An ink-dark, translucent HUD (action bar, combat carousel) floats over the canvas, with Lantern Gold for the
  active thing.
- Flat surfaces separated by tone and borders, with no shadows.
- One interface face (Signika), with weight and size, not new fonts, setting the hierarchy.
- Every state shows in a form besides colour: dashed borders, strikethrough, opacity, or text.

## Colors

Warm, low-saturation parchment and ink, with one cool accent for the page and one warm light for the HUD.

### Primary
- **Verdigris** ({colors.verdigris}): links, content links, the hover border on every button, the hover and focus
  colour of sheet tabs, the actor's type pill, and the effective ability scores the engine works out. On a filled
  control, its text is {colors.verdigris-contrast}. A 14% tint of it is the sheet tab's hover fill.

### Secondary
- **Lantern Gold** ({colors.lantern-gold}): HUD only. Today it marks the active turn in the combat carousel (a
  border plus a 15% fill); it is the HUD's accent for anything new that must catch the eye there.
- **Focus Brass** ({colors.focus-brass}): the 2px focus outline, offset 1px, on every focusable element in a Wild
  Path window.

### Neutral
- **Parchment** ({colors.parchment}): the window background.
- **Parchment Light** ({colors.parchment-light}): raised surfaces on the page, such as buttons, rows, pills, ability
  and resource cells, and chat cards.
- **Vellum** ({colors.vellum}): the brightest layer, used for inputs, selects, the sticky sheet nav and the focused
  actor name.
- **Ink** ({colors.ink}): all body text.
- **Faded Ink** ({colors.faded-ink}): hints, notes, row details, section labels and maximum values.
- **Ink Rule** ({colors.ink-rule}): every border and divider on the page.
- **HUD Ink** ({colors.hud-ink}): the translucent ground of the action bar and carousel.
- **HUD Parchment** ({colors.hud-parchment}) and **HUD Faded** ({colors.hud-faded}): text and secondary text on the
  HUD.

### Status
- **Ochre** ({colors.ochre-warning}): warnings, such as an encumbered load, an active condition's border with a 12%
  fill, and builder warnings. A sheet warning is a 3px Ochre left rule on a 12% Ochre fill.
- **Oxblood** ({colors.oxblood-danger}): errors, invalid fields (a 2px outline), failed death saves, and going over a
  limit.
- **Moss** ({colors.moss-success}): marked successful death saves.

### Named Rules
**The Two Inks Rule.** The page has one accent. Verdigris marks what can be followed or what the engine derived; it
never decorates. Lantern Gold belongs to the HUD and does not appear on parchment.

**The Own Palette Rule.** A Wild Path surface sets its own background and text colour, so it stays readable whatever
Foundry theme surrounds it.

## Typography

**Body Font:** Signika (Foundry's `--font-primary`, with sans-serif fallback)
**Mono Font:** the system monospace, for the JSON editor and formula fields only
**Script Fonts:** Noto Runic, Ogham, Old Persian, Old Hungarian, Glagolitic, Tifinagh and Old Italic (OFL, `fonts/`),
used only to render text in a language the reader doesn't know.

**Character:** a single humanist sans used throughout. Hierarchy comes from weight (400 to 800) and a few small
uppercase labels, not from a second family.

### Hierarchy
- **Headline** (700, 1.45rem): the actor's name in the sheet header.
- **Title** (800, 1rem): sheet section headings and chat card titles.
- **Body** (400, Foundry's base window size): running text and field values. Wild Path doesn't set this size.
- **Row Name** (700, body size): the name in a sheet row, sheet tabs, and outcome badges.
- **Label** (800, 0.78rem, uppercase, Faded Ink): sub-headings inside a section.
- **Detail** (400, 0.75rem, Faded Ink): the second line of a row and the summary pills.
- **HUD** (0.85rem on the action bar, 0.75rem on the carousel): smaller than the page, because the HUD floats over
  the scene.

### Named Rules
**The Weight Not Face Rule.** Add hierarchy with weight, size and case. A new font family is reserved for language
script.

## Layout

Windows are Foundry ApplicationV2 sheets: a vertical stack with a 0.75rem gap and 0.75rem padding.

- **Spacing rhythm:** 0.25rem, 0.35rem, 0.5rem and 0.75rem. Tight groups (pills, rows, cells) use 0.35–0.4rem, and
  sections use 0.75rem.
- **Actor sheet:** a 72px portrait beside the name and summary pills. Below it is a sticky five-tab nav, then
  bordered sections. The overview and inventory are two columns with a minimum of 240px each. Ability and resource
  cells use an auto-fit grid (140px and 160px minimums).
- **Rows:** a three-part grid of icon, name and detail, then a command. Long names truncate with an ellipsis rather
  than wrapping.
- **Narrow windows (680px or less):** a 56px portrait, the nav on two columns, and one column for overview and
  inventory.
- **HUD:** the action bar is fixed and centred 96px from the bottom, above the hotbar, at most 70vw wide. The
  carousel is fixed at top centre, at most 60vw wide, and scrolls sideways when turns overflow.
- **Rules Inspector:** a 220px list beside the detail pane. The Bastion Map is a 15rem facility list beside a
  square grid.

## Elevation & Depth

Wild Path is flat. There are no shadows anywhere. Depth comes from tonal layering: Parchment for the page, Parchment
Light for raised surfaces, and Vellum for inputs and the sticky nav. Ink Rule borders separate the layers.
Sections sit on a 38% white wash over the page. The HUD is set apart by material rather than height: translucent
dark ink over the canvas.

### Named Rules
**The No-Shadow Rule.** Never use `box-shadow` for depth. Lift something with a lighter tone, a border, or (for
pressed controls) a heavier border or fill.

## Shapes

Corners are gently rounded, and their radius follows the size of the element:
- **Badges** ({rounded.badge}): outcome badges and odds chips.
- **Cards** ({rounded.card}): chat cards, row icons and carousel turns.
- **Controls** ({rounded.control}): buttons, rows, cells and HUD panels.
- **Panels** ({rounded.panel}): sheet sections and the nav.
- **Pills** ({rounded.pill}): summary chips. Condition stack counts are small rounded tabs on the icon's corner.

Borders are 1px Ink Rule throughout. A dashed border means "not available" or "empty". Death-save pips are
circles.

## Components

### Buttons
Moving from quiet to tactile.
- **Shape:** gently rounded ({rounded.control}), at least 1.9rem tall on the sheet.
- **Default:** a Parchment Light fill, Ink text, and a 1px Ink Rule border.
- **Hover:** the border turns Verdigris (enabled buttons only).
- **Focus:** a 2px Focus Brass outline, offset 1px.
- **Disabled:** 55% opacity and a not-allowed cursor.
- **Text buttons:** a name that opens its Item, or a skill name, is a real button styled as bold text that
  underlines on hover or focus, so it stays keyboard-reachable.
- **Direction:** new button work should feel pressable, with a firmer fill or border and a visible pressed state,
  within the No-Shadow Rule.

### Inputs / Fields
- **Style:** a Vellum fill, Ink text, and a 1px Ink Rule border.
- **Focus:** a 2px Focus Brass outline. The inline actor name is borderless until focused, then gains a Verdigris
  border and a Vellum fill.
- **Error:** a 2px Oxblood outline (`aria-invalid`), with the message in Oxblood below the field.

### Navigation (sheet tabs)
- A sticky Vellum bar with 8px corners and five equal tabs in bold text.
- Hover and focus give a 14% Verdigris fill and Verdigris text.

### Pills
- Summary chips under the actor name: full pill radius, Parchment Light, Detail type in Faded Ink. The actor's type
  pill is bold Verdigris.

### Sheet Rows and Sections
- **Section:** an 8px-cornered bordered panel on a light wash, with a Title heading over a ruled line.
- **Row:** a Parchment Light row 2.6rem tall, with an icon, a name over a detail line, and a command button.
- **Unavailable action:** a dashed border, 72% opacity and a Faded Ink name. The engine's reason is in its tooltip.
- **Empty list:** a dashed-border row with the empty message in Faded Ink.

### Conditions
- 2.25rem icon tiles. An inactive condition sits at 42% opacity. An active one is fully opaque with an Ochre border
  and fill. A stack count sits in a small dark tab on the corner.

### Chat Resolution Card
- A Parchment Light card with 4px corners: a 32px icon and the title, then one line per target.
- **Outcome badges:** bold text with a 3px radius, tinted from Foundry's success and error level colours (an 18% fill
  and a solid border), so the text stays Ink.
- Clicking a target underlines its name. Below sits an underlined Verdigris "inspect" link that opens the Rules
  Inspector.

### Action Bar (signature)
- A translucent HUD Ink panel, 6px corners, above the hotbar. It shows the creature, its condition icons, and the
  action-economy counters, then action groups labelled in HUD Faded text.
- Common actions are icons only, named in their tooltips. A spent resource shows at 50% opacity with a
  strikethrough. An unaffordable action is at 45% opacity, and its tooltip gives the engine's reason.
- Spell slot buttons sit beside a spell, and odds chips are small dark badges.

### Combat Carousel (signature)
- A translucent HUD Ink strip at top centre. Each turn is a 56px tile with a portrait, a truncated name, a 4px health
  bar and condition icons.
- **Active turn:** a 2px Lantern Gold border with a 15% gold fill. A defeated creature is at 40% opacity. A
  concealed creature is at 60% and italic.

## Do's and Don'ts

### Do:
- **Do** take every colour from the `--wp-*` properties in `styles/wildpath.css`, and add a new property there when a
  new role appears.
- **Do** keep Verdigris for links, hover, focus-adjacent states and engine-derived values. Keep Lantern Gold on the
  HUD.
- **Do** show every state in a second form besides colour: a dashed border (unavailable or empty), strikethrough
  (spent), opacity (disabled or defeated), italic (concealed), or text (a tooltip reason).
- **Do** use the 2px Focus Brass outline for keyboard focus on every interactive element.
- **Do** truncate long names with an ellipsis in rows and carousel tiles rather than letting them wrap.
- **Do** make new controls feel pressable with fill, border weight and a pressed state.

### Don't:
- **Don't** use `box-shadow` for depth or emphasis anywhere. Use tone, borders and fills.
- **Don't** show a state with colour alone, whether it's a hue change on a badge, a row or an icon.
- **Don't** put Lantern Gold on parchment, or Verdigris on the dark HUD as its main accent.
