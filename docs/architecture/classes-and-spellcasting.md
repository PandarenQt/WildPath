# Classes and Spellcasting

Decided by the maintainer on 2026-10-14: class records with full multiclass support, and 2024
spellcasting rules with full and half casters only. Subclasses are planned to start at level 2.

## Class records

Every Actor stores one record per class in `system.classes`. Multiclassing is the normal case.

```js
{id: "paladin", name: "Paladin", level: 3, original: false,
 subclasses: ["oath-a"],                                  // a class may hold several subclasses
 spellcasting: {progression: "half", ability: "cha"}}     // progression: none | full | half
```

Derived on preparation (`helpers/spellcasting.mts`, `WildPathBaseActor#deriveClasses`):

- **Total level.** The sum of class levels. With class records present, a character's `details.level` is
  derived from them; without any, it stays the stored value.
- **`originalClass`.** The record marked `original` (the level-1 class), else the first.
- **`spellcasting`.** `{casterLevel, ability, slots}`. The ability is the original class's when it casts,
  else the first casting class's. A `spellcasting-modifier` ValueExpression may name a class
  (`{type: "spellcasting-modifier", class: "paladin"}`) to use that class's own ability.

## Spellcasting progression (2024)

- **Caster level.** Every level in a full-caster class, plus half the levels in each half-caster class,
  rounded up per class. A level-1 Paladin is caster level 1, and Wizard 3 + Paladin 3 is caster level 5.
- **Slots.** Spell slots per spell level come from the 2024 multiclass spellcaster table at that caster
  level. They are held in the existing `spell-slot.<n>` pools, which Actions already pay with.
- **Pool maxima.** A slot pool's maximum adds the table's count to its own base, bonus and modifiers.
- **New pools.** When an Actor is created with class records, or its classes change, any slot pool a
  newly reached spell level needs is created full, with long-rest recovery.
- **Pact-style slots.** These stay separate pools with short-rest recovery. There are no third casters.

The ruleset lives in one module (`helpers/spellcasting.mts`), so another ruleset replaces that module
rather than branching inside callers (AGENTS §10).

Live (Quench, 14.369): a Wizard 3 / Paladin 3 is level 6 with the Wizard as its original class. It is
caster level 5, with slot pools of 4, 3 and 2 created full. Adding Paladin levels and a Cleric level
raised it to caster level 7 and added the level-4 slot pool.
