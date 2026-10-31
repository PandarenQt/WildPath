# Vehicles and mythic phases (design, 2026-10-31)

Status: design only, nothing built. Roadmap G9; the owner said "build now" on 2026-10-30 (plan 5.1). The choices
marked **open** are questions for the owner (`docs/development/questions-for-owner.md`, Q6).

## What content needs

**Vehicles.** SRD 5.2 has 8: Airship, Galley, Keelboat, Longship, Rowboat, Sailing Ship and Warship (dnd5e `vehicle`
Actors, `actors24`), plus the Apparatus of the Crab (two lever Actions). A ship's stat block is all numbers:
- travel Speed (mph), Crew, Passengers, Cargo (tons);
- AC, Hit Points, Damage Threshold, cost;
- Immunity to Poison and Psychic damage, and to nine conditions (Blinded to Unconscious).

It has no Actions and no turn. The Folding Boat's commands summon a Rowboat or Keelboat; those stay manual until
vehicles convert (gap census: "summon: its creature is not converted").

**Mythic phases.** Neither SRD 5.2 nor the owned books (PHB, DMG, MM 2024, Tasha's, Xanathar's) have a mythic
creature. Mythic traits are from Mythic Odysseys of Theros (2014). Build the seam and a test creature, not content.

## Vehicles: proposal

1. **Data (open: a new Actor type).** A `vehicle` Actor type with `ac`, `hp` with `damageThreshold`, `travelSpeed`
   (mph) and a combat Speed, `capacity` (crew, passengers, cargo tons), damage and condition immunities, and
   `aboard` (`[{actorUuid, role: "crew" | "passenger"}]`). A new type is a persistent data format, so it needs the
   owner's approval. The alternative is an `npc` with a `vehicle` flag, which leaks creature rules (saves, conditions,
   death) onto ships.
2. **Damage Threshold, for vehicles and objects.** Damage from one source below the threshold is ignored; at or
   above it, the whole amount applies. It belongs in `damage-adjustment-resolver.mjs`, after Resistance and
   Vulnerability, as a profile field like `ignoresResistance`. Objects (Dispel Magic on objects, doors) can use it
   too.
3. **Crew and Actions (open: who acts).** A vehicle has no turn. Its Actions (the Apparatus of the Crab's levers, a
   later ballista) are used by a creature aboard as crew, costing that creature's Action. The Action's `requires`
   predicate reads its role (`aboard.crew`). Stations (2014 Saltmarsh, Spelljammer) come later, as a role with a
   name.
4. **Movement (open: riding along).** The vehicle's owner moves its Token. Tokens standing on its footprint move
   with it, by the same offset, as a teleport-like forced move (no reactions, no costs). Travel at mph is the
   journey tool's (`applications/journey.mjs`), not the grid's.
5. **Converter.** dnd5e `vehicle` Actors with a CC-BY-4.0 2024 source become `vehicle` Actors: numbers from
   `system.attributes` (`ac.flat`, `hp.max`, `hp.dt`, `capacity`), immunities from `traits`, items as Actions.

## Mythic phases: proposal

The usual shape, to be checked against a stat block before building: when the creature is reduced to 0 Hit Points
it isn't killed. It regains Hit Points, and its mythic actions (more legendary action options) become available.

1. **Trigger.** The zero-HP hook Death Ward already uses (`results.zeroHp`, a record that keeps the creature up).
   A `Phase` rule on the creature: `{on: "zero-hp", restore: <expression>, once: true, flag: "mythicPhase"}`. It
   keeps the creature at 0 → `restore` Hit Points and sets `flags.wildpath.mythicPhase`.
2. **Mythic actions.** Actions tagged `mythic` cost its legendary actions like the others. Until the phase, a state
   rule owner in `grantOwners` forbids them (`Forbid {tagsAny: ["mythic"]}`), the same pattern as Quickened Spell.
   The bar greys them, with the reason.
3. **Chat.** The card says the phase began ("Ogre King rises: its mythic actions are available"), as a public line
   like Dispel Magic's.

## Order of work, once the open choices are settled

1. Damage Threshold (useful alone, for objects too) with tests.
2. The `vehicle` type, its sheet (numbers, aboard list) and the converter, behind the owner's approval.
3. Crew Actions and riding along.
4. The mythic `Phase` rule, the `mythic` Forbid, a test creature, and the card line.
