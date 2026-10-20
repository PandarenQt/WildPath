# Senses and cover

## Senses (2026-10-20)

A creature's senses are **Darkvision**, **Blindsight**, **Tremorsense** and **Truesight**, each with a range in feet.
They come from its grants: `GrantSense {sense, range}` RuleElements on its species, features, gear and effects. The
prepared data keeps the best range of each (`system.senses`, `helpers/senses.mts` `bestSenses`); nothing is stored.

**Token vision.** Senses drive the Token's vision (maintainer decision, 2026-10-20), as in dnd5e
(`adapters/foundry-v14-senses.mts`, called by `WildPathTokenDocument#_prepareDetectionModes`):

| Sense | Effect on the Token |
| --- | --- |
| Darkvision, Truesight | sight range is the better of the two, vision mode `darkvision` (none: range 0, `basic`) |
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
- shortcut: Devil's Sight is Darkvision 120 ft; seeing through magical Darkness is by hand.

Live (two browsers, 14.369):
- **Dwarf species:** QA Caster had Darkvision 120, and its Token sight 120 in `darkvision` mode.
- **Boon of Truesight:** it added `seeAll` 60; removing both restored range 0 and `basic`.
- **Invisible target:** QA Caster's Dagger at an Invisible Bandit Captain rolled 2d20kl; with Truesight 60 ft it rolled
  1d20.
