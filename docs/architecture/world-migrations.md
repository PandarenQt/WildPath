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
