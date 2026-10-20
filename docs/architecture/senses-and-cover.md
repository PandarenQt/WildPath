# Senses and cover

## Senses (2026-10-20)

A creature's senses are **Darkvision**, **Blindsight**, **Tremorsense**, **Truesight** and **Devil's Sight**, each with a
range in feet.
They come from its grants: `GrantSense {sense, range}` RuleElements on its species, features, gear and effects. The
prepared data keeps the best range of each (`system.senses`, `helpers/senses.mts` `bestSenses`); nothing is stored.

The Homebrew Builder's rule rows have "A sense" (a sense and its range) for writing one by hand.

**Token vision.** Senses drive the Token's vision (maintainer decision, 2026-10-20), as in dnd5e
(`adapters/foundry-v14-senses.mts`, called by `WildPathTokenDocument#_prepareDetectionModes`):

| Sense | Effect on the Token |
| --- | --- |
| Darkvision, Truesight, Devil's Sight | sight range is the best of the three, vision mode `darkvision` (none: range 0, `basic`) |
| Truesight, Devil's Sight | the vision source has the highest priority, so magical Darkness neither blinds nor walls it off |
| Truesight | adds the `seeAll` detection mode within its range |
| Tremorsense | adds `feelTremor` |
| Blindsight | adds `blindsight`, a WildPath detection mode |

- **Blindsight's mode.** It is type OTHER, so Blinded and Invisible don't stop it. Walls block it; darkness doesn't.
- **What stays the GM's.** Whether a Token has sight at all is still set on the Token. Its range and mode are the
  senses'.
- **Updates.** When a creature's senses change, its Token is prepared again and its vision source redrawn
  (`_onRelatedUpdate`).
- **Blinded fix.** Foundry's vision now honours WildPath's Blinded condition: `CONFIG.specialStatusEffects.BLIND` is
  `blinded`; it used to read Foundry's own `blind` id and ignored WildPath's.

**The rules.** An attack's context carries `attack.seesTarget` and `attack.seenByTarget`, from `perceives`:
- A Blinded creature perceives only by Blindsight within range, or by Tremorsense a creature on the ground.
- An Invisible creature is perceived by Truesight, Blindsight or Tremorsense within range.
- Blinded's and Invisible's Advantage and Disadvantage apply only while the other creature does not perceive them.

**Conversion.**
- **Creatures:** `senses.ranges`.
- **Species:** `senses`, as rules on the species Item.
- **Effect changes:** `system.attributes.senses.<sense>` (Darkvision, Devil's Sight, Feral Senses, Witch Sight, True
  Seeing, Boon of Truesight, Stonecunning, Goggles of Night, a Robe of Eyes) become `GrantSense`.
- **By hand:** a creature's free-text special senses are noted.
- **Devil's Sight** (2026-10-20) is its own sense (`devilsSight`), converted from its effect's Darkvision 120.

**Seeing through Darkness** (`registerDarknessSight`, a Token subclass). Foundry blinds a vision source inside a
darkness source of equal or higher priority (`PointVisionSource`), and a polygon skips darkness edges below its own
priority. Tokens are priority 0, so Darkness blinds them; a Token with Devil's Sight or Truesight gets the highest
priority. Live (two browsers, 14.369): with a darkness light on the Bandit Captain, Player1's QA Caster with
Darkvision 60 could not see it (`testVisibility` false); with Devil's Sight 120 it could.

Live (two browsers, 14.369):
- **Dwarf species:** QA Caster had Darkvision 120, and its Token sight 120 in `darkvision` mode.
- **Boon of Truesight:** it added `seeAll` 60; removing both restored range 0 and `basic`.
- **Invisible target:** QA Caster's Dagger at an Invisible Bandit Captain rolled 2d20kl; with Truesight 60 ft it rolled
  1d20.

## Cover (2026-10-20)

Cover is worked out automatically for every Action (maintainer decision, 2026-10-20), on the authority
(`adapters/foundry-v14-cover.mts` `coverBetween`, the runtime's `actionCover`). It uses the DMG's grid method:
1. From each corner of the attacker's spaces (or from an area's point of origin: a radial area's first point; a cone,
   line or emanation starts at the caster), lines run to the corners of each space the target occupies. Corners are
   inset a pixel, so a line along a wall's end or a grid edge doesn't count.
2. The attacker takes the corner and target space that see best, and a wall blocking sight cuts some share of those
   lines (Foundry's `polygonBackends.sight.testCollision` on the target's Level):

   | Lines blocked | Cover |
   | --- | --- |
   | none | none |
   | up to half | Half: +2 to AC and Agility (Dexterity) saves |
   | more than half | Three-Quarters: +5 |
   | all | Total |

3. If no wall gives cover, a creature whose space a line crosses gives Half.

How each degree is applied:
- **Attacks:** cover lowers the attack roll against that target (as raising its AC would), in the authority's numbers and
  the odds alike.
- **Agility saves:** cover adds to the saver's bonus.
- **Total cover:** a creature behind it can't be targeted directly (the Action is refused, and nothing is paid). An
  area leaves it out.
- **Card:** each target's cover is shown on the card ("Half cover").
- The degrees never stack: one degree, the best the attacker can find.

Square and hex grids both work: the spaces and their corners are Foundry's (`getOccupiedGridSpaceOffsets`,
`grid.getVertices`).

Live (two browsers, 14.369):
- **Creature in the way:** with QA Ally between them, QA Caster's Fire Bolt at the Bandit Captain checked 15 (17 less
  2) against AC 15, and the card read "Half cover".
- **Wall:** with a sight wall across the whole line, the Fire Bolt was refused ("That creature is behind Total
  Cover").
