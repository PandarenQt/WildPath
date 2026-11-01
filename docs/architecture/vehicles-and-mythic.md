# Vehicles and mythic phases (design, 2026-10-31)

Status: vehicles and mythic phases built (2026-11-01). Roadmap G9; the owner said "build now" on 2026-10-30
(plan 5.1) and answered Q6 (`docs/development/questions-for-owner.md`) with the recommendations on 2026-10-31.

## What content needs

**Vehicles.** SRD 5.2 has 8: Airship, Galley, Keelboat, Longship, Rowboat, Sailing Ship and Warship (dnd5e `vehicle`
Actors, `actors24`), plus the Apparatus of the Crab (two lever Actions). A ship's stat block is all numbers:
- travel Speed (mph), Crew, Passengers, Cargo (tons);
- AC, Hit Points, Damage Threshold, cost;
- Immunity to Poison and Psychic damage, and to nine conditions (Blinded to Unconscious).

It has no Actions and no turn. The Folding Boat's commands summon a Rowboat or Keelboat; those stay manual (gap census:
"summon: its creature is not converted"): the vehicles convert now, but the summon's creature table does not list them yet.

**Mythic phases.** Neither SRD 5.2 nor the owned books (PHB, DMG, MM 2024, Tasha's, Xanathar's) have a mythic
creature. Mythic traits are from Mythic Odysseys of Theros (2014). Build the seam and a test creature, not content.

## Vehicles: proposal

1. **Data (answered: a new Actor type).** A `vehicle` Actor type with `ac`, `hp` with `damageThreshold`, `travelSpeed`
   (mph) and a combat Speed, `capacity` (crew, passengers, cargo tons), damage and condition immunities, and
   `aboard` (`[{actorUuid, role: "crew" | "passenger"}]`). A new type is a persistent data format, so it needs the
   owner's approval. The alternative is an `npc` with a `vehicle` flag, which leaks creature rules (saves, conditions,
   death) onto ships.
   **Built 2026-11-01:** `module/data/actor/vehicle.mjs`. It keeps the shapes the rules already read, so attacks and damage
   need nothing new: `ac` is `defenses.ac`, `hp` is `resources.health` with `damageThreshold` (a `resourceField` option),
   the combat Speed is `resources.movement`; then `travelSpeed`, `capacity` `{crew, passengers, cargo}`, `immunities`
   `{damage, conditions}` and `aboard`. No abilities, skills, saves, classes or death saves; at 0 Hit Points it is destroyed
   (the dying rules' "dies"). Its own data gives rules (`ownRules`, read with its Items' in `grantOwners` and
   `getStatistic`): `GrantImmunity`/`ConditionImmunity` from its immunities, and `occupancy.share` (its deck: riders and it
   don't block one another's moves). `getDamageProfile` adds its `damageThreshold`. Its sheet
   (`applications/vehicle-sheet.mjs`) edits the numbers and immunities, lists who is aboard (an Actor dropped on it comes
   aboard as crew; the role can be changed, or the creature leaves) and its Actions.
2. **Damage Threshold, for vehicles and objects.** Damage from one source below the threshold is ignored; at or
   above it, the whole amount applies. It belongs in `damage-adjustment-resolver.mjs`, after Resistance and
   Vulnerability, as a profile field like `ignoresResistance`. Objects (Dispel Magic on objects, doors) can use it
   too.
   **Built 2026-10-31:** `damageThreshold` on a damage adjustment profile (the highest of merged profiles wins); a
   total below it from one damage result becomes 0, with a `threshold` application. A vehicle's Hit Points set it.
3. **Crew and Actions (answered: a creature aboard as crew).** A vehicle has no turn. Its Actions (the Apparatus of the Crab's levers, a
   later ballista) are used by a creature aboard as crew, costing that creature's Action. The Action's `requires`
   predicate reads its role (`aboard.crew`). Stations (2014 Saltmarsh, Spelljammer) come later, as a role with a
   name.
   **Built 2026-11-01:** the vehicle acts (its Token, its fixed attack bonus) and has no cost of its own; the crew member
   pays through `controllerCosts`, the companion seam. Every creature aboard may be the controller; `requiresContext`'s
   `aboard` holds the roles that controller has aboard the vehicle, so `requires: {equals: {path: "aboard.crew", value:
   true}}` lets only crew use it (a passenger-usable Action would read `aboard.passenger`). The authority picks the
   controller before checking `requires`: the one the intent names (`controllerRef`), else the first creature aboard the
   sender owns that meets it. A creature's action bar shows the Actions of each vehicle on the Scene it is aboard, in a
   group of their own, used with itself as the controller (greyed, with the reason, once it has spent what they cost
   it); the vehicle's sheet uses them too.
   shortcut: a Player needs ownership of the vehicle to use its Actions (the authority's acting-Actor rule); granting it
   from the crew list, as companions do, comes if that proves needed.
4. **Movement (answered: riding along).** The vehicle's owner moves its Token. Tokens standing on its footprint move
   with it, by the same offset, as a teleport-like forced move (no reactions, no costs). Travel at mph is the
   journey tool's (`applications/journey.mjs`), not the grid's.
   **Built 2026-11-01** in the carry adapter (`adapters/foundry-v14-carry.mts`): after a vehicle's voluntary move, the
   active GM moves every Token standing wholly on the spaces it set out from by its offset, in one jump, as forced
   movement. shortcut: nothing checks walls on the riders' jump.
5. **Converter.** dnd5e `vehicle` Actors with a CC-BY-4.0 2024 source become `vehicle` Actors: numbers from
   `system.attributes` (`ac.flat`, `hp.max`, `hp.dt`, `capacity`), immunities from `traits`, items as Actions.
   **Built 2026-11-01** (`convertVehicle`): the 8 SRD vehicles are in the creature pack. dnd5e keeps a ship's travel Speed,
   crew and passengers only in its stat block's lines, so they are read from there (without them, all it holds is crew).
   Its Items become crew Actions: no cost of their own, the crew member's Action, `requires` crew, and the stat block's
   flat attack bonus (`fixedBonus`); dnd5e's "special" activation counts as an Action.

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

**Built 2026-11-01.** `Phase` is a RuleElement type (`rule-elements.mjs`; it contributes nothing and validates `on`,
`restore`, and `flag`, which may only be `mythicPhase`, the flag the Forbid below reads). `zeroHpFor`
(`adapters/foundry-v14-zero-hp.mts`) reads it as a `set` rule with `restore` as its Hit Points, skipped while
`mythicPhase` is set (`once`, the default), and names the flag and the creature's uuid; a Phase on an effect leaves the
effect in place (only a Trigger's, Death Ward's, ends). The pipeline's zero-HP record carries them; after the Action
commits, the runtime calls `beginPhase`, which sets `flags.wildpath.mythicPhase` and posts the public line `WILDPATH.NOTIFY.PhaseBegan` ("{name} rises ({feature}): its mythic
actions are available."). Damage outside an Action (`foundry-v14-dying.mts`, `rescueAtZero`) does the same. `grantOwners`
adds the state Forbid `{tagsAny: ["mythic"]}` (`WILDPATH.REFUSAL.Mythic`) while `flags.wildpath.mythicPhase` is unset,
so the authority refuses and the bar greys an Action tagged `mythic` until then. Tests: `test/mythic.test.mjs`, on a
synthetic creature (no book content).
shortcut: nothing clears the flag (a rest, or the GM); add that with a creature that needs it.

## Order of work, once the open choices are settled

1. Damage Threshold (useful alone, for objects too) with tests.
2. The `vehicle` type, its sheet (numbers, aboard list) and the converter, behind the owner's approval. Done.
3. Crew Actions and riding along. Done.
4. The mythic `Phase` rule, the `mythic` Forbid, a test creature, and the card line. Done.
