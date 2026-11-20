# Senses and cover

## Senses (2026-10-20)

A creature's senses are **Darkvision**, **Blindsight**, **Tremorsense**, **Truesight**, **Devil's Sight** and **See
Invisibility** (the spell: it perceives the Invisible, and nothing else; 2026-10-21), each with a range in feet.
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
| See Invisibility | adds Foundry's `seeInvisibility` detection mode within its range |
| Blindsight | adds `blindsight`, a WildPath detection mode |

- **Blindsight's mode.** It is type OTHER, so Blinded and Invisible don't stop it. Walls block it; darkness doesn't.
- **What stays the GM's.** Whether a Token has sight at all is still set on the Token. Its range and mode are the
  senses'.
- **Updates.** When a creature's senses change, its Token is prepared again and its vision source redrawn
  (`_onRelatedUpdate`).
- **Blinded fix.** Foundry's vision now honours WildPath's Blinded condition: `CONFIG.specialStatusEffects.BLIND` is
  `blinded`; it used to read Foundry's own `blind` id and ignored WildPath's.

**The rules.** An attack's context carries `attack.seesTarget` and `attack.seenByTarget` (`attackSight`,
`adapters/foundry-v14-senses.mts`), from `perceives` and the light each stands in:
- A Blinded creature perceives only by Blindsight within range, or by Tremorsense a creature on the ground.
- An Invisible creature is perceived by Truesight, Blindsight or Tremorsense within range.
- Blinded's and Invisible's Advantage and Disadvantage apply only while the other creature does not perceive them.

**Light (2026-10-20).** `lightAt(token)` (`adapters/foundry-v14-sunlight.mts`) is `light`, `dark` or
`magicalDarkness`:
- **Viewed Scene:** Foundry's own darkness and light sources decide (`testInsideDarkness`, `testInsideLight`, with
  walls, elevation and global illumination). Any darkness source counts as magical Darkness.
- **Elsewhere:** a negative light's radius is magical Darkness; global illumination or a light's radius is light; the
  rest is dark.
- A Scene without Token vision is all light.

`obscured` (`helpers/senses.mts`) applies the 2024 rules:
- Darkness hides a creature from one without Darkvision, Devil's Sight or Truesight reaching it.
- Magical Darkness hides it from one without Devil's Sight or Truesight, and a creature inside magical Darkness sees
  nothing beyond it without them.
- A Heavily Obscured lasting area (2026-10-31) hides a creature in it from every sight, Truesight included, and one in it
  sees nothing out ("Blinded while trying to see something in it"). `attackSight` reads it as `heavilyObscured` when the
  Token stands in an area whose `flags.wildpath.area.persistence.obscures` is `heavily` (`heavilyObscuredAt`,
  `adapters/foundry-v14-persistent-areas.mts`), before its light.
- Blindsight, and Tremorsense on a creature on the ground, ignore light and fog.

**Heavily Obscured areas (conversion).** A spell whose text says its area "is ... Heavily Obscured" gets
`obscures: "heavily"` on its lasting area: Cloudkill, Incendiary Cloud and Sleet Storm beside their repeats (not Storm of
Vengeance, whose area is obscured only from turn 5: areas have no stages); Fog Cloud and Stinking Cloud's cloud as an area of their own, Fog Cloud 20 feet wider per slot level above 1 (Stinking Cloud's
save at the start of a turn stays by hand, noted).
An item's or creature's utility area whose text says so too (2026-10-31): an Eversmoking Bottle's 60-foot Emanation,
its size a step its user picks (dnd5e's `@scaling`: up to 120 feet), and an Octopus's Ink Cloud; with no duration of its
own, the one its text names ("for 1 minute", "after 10 minutes"). The rest of their text (the bottle closing, the
octopus swimming off) is by hand, noted.
shortcut: what is behind fog (both creatures outside it, the fog between) stays seen, as with magical Darkness; Foundry's
own vision is not blocked by the area, and Lightly Obscured (Web, Insect Plague) changes nothing, since sight-based
Perception checks aren't automated. A strong wind dispersing it is by hand.

Every creature has two unseen rules (`UNSEEN`, `documents/actor.mjs`): Disadvantage attacking a target that only light
hides (`attack.targetHidden`), Advantage attacking one that only light keeps from seeing it (`attack.attackerHidden`).
Blinded and Invisible keep their own, so an Invisible creature in Darkness is one source, not two.

Live (two browsers, 14.369), Dagger from QA Caster in torchlight at the Bandit Captain:
- **Captain in a darkness light, 15 ft radius, covering both:** with Darkvision it rolled 1d20 (neither sees the
  other, so they cancel); with Devil's Sight 2d20kh (only the Captain is blind).
- **Darkness only on the Captain:** the same, because a creature inside magical Darkness can't see out.
- Darkness gave no Total Cover.

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
   lines (the target's Scene's walls, on its Level: see "Walls on any Scene" below):

   | Lines blocked | Cover |
   | --- | --- |
   | none | none |
   | up to half | Half: +2 to AC and Agility (Dexterity) saves |
   | more than half | Three-Quarters: +5 |
   | all | Total |

3. If no wall gives cover, a creature whose space a line crosses gives Half: never the attacker, the target, or the
   Token an origin belongs to (`origin.tokenId`, when an origin names one).
4. Cover its attacker's rules ignore (2026-10-31): `cover.ignored` Modifiers, read with the Action's tags, of 1 make Half
   Cover none, of 2 Three-Quarters Cover too; its tags include the attack's type and statistic. The Wand of the War
   Mage's enchantment gives 1 on spell attacks; Sharpshooter 2 on ranged weapon attacks; Spell Sniper 2 on spell attacks.
   An Action Item's own `cover.ignored` Modifier counts for that Action alone (2026-11-20; the statistic is read with
   its Item, as a +1 sword's attack bonus is): Sacred Flame's 2, so its target gains nothing from Half or Three-Quarters
   Cover on that save, in the save bonus, the odds and the card's cover chip alike. Total Cover still applies (it can't
   be targeted). The converter writes it for a save whose text says "no benefit from Half Cover or Three-Quarters Cover
   for this save" (or 2014's "from cover for this saving throw"); the Oathbow's, against its sworn enemy only, stays by
   hand. A copy already on a creature takes the rule from its compendium copy (migration 5's feature shapes, revision
   4). Shortcut: an attack moved with its roll (Cloud Rune) judges the new creature's cover with the attack's tags
   only, not its Item's own rules.

### Walls on any Scene

`adapters/foundry-v14-walls.mts` (2026-10-21) tests a line against a Scene's walls whether or not the canvas shows it.
On the rendered Scene Foundry's polygon backends decide (`testCollision`). On any other Scene, the Scene's wall
documents do, as Foundry reads them: a wall stops the senses it blocks (`move`, `sight`, `light`); an open door stops
nothing; a one-way wall stops a line only from one side; Limited walls stop sight and light only two at once. Cover,
fear's line of sight, reactions' "can see", forced movement, summon placement and sunlight all use it. Live: on a
Scene with every kind of wall, 600 random lines gave the same answer as Foundry's own test. Shortcut: off the rendered
Scene a Proximity or Distance wall blocks at any distance.

How each degree is applied:
- **Attacks:** cover raises that target's AC against the attack (2024), in the authority's numbers and the odds alike:
  the runtime sends it per target (`attack.defenseBonusByTarget`, by Token) and the attack stage makes it a
  `defense-bonus` override, added to that target's defense only. The roll's total stays the one the card shows, so the
  GM's Heroic Inspiration question reads "23 hit AC 17", not "21 hit AC 15" (live 9, 2026-11-20; before, cover was
  taken off the roll).
- **Agility saves:** cover adds to the saver's bonus.
- **Total cover:** a creature behind it can't be targeted directly (the Action is refused, and nothing is paid). An
  area leaves it out.
- **A lasting area's or aura's own trigger (Q37, 2026-11-16):** no cover at all. A placed, carried or attached area's
  trigger (entering it, moving or a turn in it) and an Emanation trigger on a turn event (a Fear Aura on another's turn
  start, a creature's own aura as its turn ends) pass `noCover` beside the intent (`runAuthorityAction`, never from a
  client), and `actionCover` returns none: no wall or creature between gives a bonus or leaves a creature out. Only a
  creature's own Total Cover status (a swallowed creature's `coverTotal`) still keeps it out (Q103 default). A death
  burst (`creature.died`), the swallowed and the held keep cover from their creature, as instant areas do (Q103 default),
  and so does a turn trigger that picks one creature around it (`targetChoice: {from: "around"}`, the Faithful Hound's bite).
- **Card:** a target's cover is shown on the card ("Half cover") only where it changed a roll: an attack against it, or
  its Agility save (2026-11-16; before, a Wisdom save or damage alone showed it too). The runtime records it in the
  resolution's `context.cover` only then.
- The degrees never stack: one degree, the best the attacker can find.

Square and hex grids both work: the spaces and their corners are Foundry's (`getOccupiedGridSpaceOffsets`,
`grid.getVertices`).

Live (two browsers, 14.369):
- **Creature in the way:** with QA Ally between them, QA Caster's Fire Bolt at the Bandit Captain checked 15 (17 less
  2) against AC 15, and the card read "Half cover".
- **Wall:** with a sight wall across the whole line, the Fire Bolt was refused ("That creature is behind Total
  Cover").
