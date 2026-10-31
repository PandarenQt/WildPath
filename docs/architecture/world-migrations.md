# World migrations

`module/helpers/migrations.mjs` updates data a world stored under earlier rules of the system.

## How it runs

- The world setting `wildpath.migrationVersion` (hidden, default 0) records the last migration done.
- At `ready`, the active GM's client runs every migration newer than that, oldest first, and records each one as it
  ends. The GM sees a notice at the start and at the end. No other client migrates.
- A migration that throws stops the run. The GM is told which one (`WILDPATH.MIGRATION.Failed`), the console has the
  error, and the run starts again from that migration at the next start.
- A migration goes through every world Actor, then each unlinked Token's own Actor on every Scene (after its base
  Actor, so a fix on the base is already seen). Compendia are not migrated: the system's packs are regenerated, and a
  world's own packs are left as they are.
- A new migration takes the next version in `MIGRATIONS`. One that finds nothing to change changes nothing, so a new
  world runs them all harmlessly.

## The migrations

| Version | What it does |
|---|---|
| 1 | An NPC converted before Challenge Rating kept fractions (`threat` stored as 0 for 1/4) gets its converted rating back from `flags.wildpath.source.challenge`. |
| 2 | Pools left by deleted Items are removed (see below). |
| 3 | A character built by level-up records the Fortitude modifier its Hit Points count for each level (`perLevelFortitude`), its stored Fortitude's, so a later change counts for every level. |
| 4 | An NPC with no creature type takes its compendium creature's: by its converted source's id, the compendium entry Foundry recorded, its own id, or a name only one compendium creature has. |
| 5 | Features that used to be engine code keyed on their identifier get their data shapes from their compendium copy (`featureShapeFix`, see below). |

## Feature shapes (migration 5)

Some features were once found by their identifier in engine code (Life Bond, Potent Cantrip, Elemental Adept, Mystic
Arcanum, Spell Mastery, Signature Spells); they are now data any feature can carry. A stored copy of one has only its
identifier, so migration 5 adds from its compendium copy, by shape and never by feature:

- the copy's rules whose id the Item lacks, when they are a `half-on-success` or `ignore-resistance` RollOutcome, a
  `shared-healing` Trigger, or a rule naming a recorded choice (`{training:<kind>}`); nothing it has is replaced;
- the copy's `flags.wildpath.spellChoice`, when the Item has none.

The copy is the Item's own `_stats.compendiumSource`, or else, on an Actor, the Item of the same converted source id
(`flags.wildpath.source.id`) on the Actor's compendium copy: a summon's `flags.wildpath.summonSource` (a summoned steed's
world Actor carries nothing else, and Refresh Items cannot reach its Items), or the Actor's own
`_stats.compendiumSource`. World Items, world Actors and unlinked Tokens' Actors are walked.

It cannot reach an Item with no compendium copy (homebrew, or a pack no longer installed); such a feature does nothing
until its rule or flag is added by hand.

**Re-runnable (owner's decision, 2026-10-31).** Migration 5 only adds, so it is marked `rerun`: besides its first run,
it runs again whenever the converted content changes. Each converter writes a hash of what it produced
(`scripts/content/content-stamp.mjs`): the SRD converter into `system.json` `flags.wildpath.contentStamp`, the book
converter into each book module's manifest. At `ready` the active GM compares the system's and the active `wildpath-`
books' stamps (`contentStampOf`) with the world setting `wildpath.contentStamp`; when they differ, each re-runnable
migration already done runs again, and the setting is updated only after all succeed. So a world started before its
books were reconverted (Elemental Adept is only in the locally converted PHB) gets their shapes at its next start, and
a later converter improvement reaches stored characters too. Refresh Items afterwards also copies the rules and
`spellChoice` for Items that carry a `_stats.compendiumSource` (a feat taken at level-up).

## Stale pools

A pool stays when the Item granting it is switched off or unequipped, so a wand keeps its charges. When nothing on the
creature names it any more, it is stale (`stalePoolIds`):

- it is not a system pool (spell slots, Pact Magic, Hit Dice, Mystic Arcanum, Heroic Inspiration);
- it has no base or bonus of its own;
- no Item or effect, on or off, mentions its id (a grant, a `pools.<id>.max` Modifier, a cost).

Deleting an Item or effect drops the stale pools in the same record sync (`WildPathActor#syncItemRecords({prune})`).
Migration 2 does the same once for pools left before that.

## Pool names

A system pool's name is worked out from its id when the creature is prepared, in the reader's language (`Level 1
spell slots`, `Hit Dice (d8)`). Its stored label is whatever language it was made in and is kept only as a fallback.
Any other pool shows its stored label, localized when it is a lang key. No migration is needed for names.
