# Books and homebrew

## What comes with the system

The compendiums hold the SRD 5.2: spells, equipment and features; classes, species and backgrounds; creatures; and the tables of its magic items. The WildPath Actions compendium holds sample Actions and the contagions' Infect Actions. This guide is the WildPath Guide compendium.

## Content sources

Five world settings choose which sources' feats and subclasses the level-up dialog offers: 2014 core, 2024 core, supplements, Unearthed Arcana, and third-party or homebrew. All are on by default. They don't limit what you can browse in the compendiums.

## Your own books

A GM who owns a dnd5e book module (a Player's Handbook, a Monster Manual) can convert it for their own world:

```
node scripts/content/convert-dnd5e-module.mjs <module-id> --srd <extracted dnd5e packs>
```

This writes a local module, `wildpath-<module-id>`, into your Foundry data, with that book's items and creatures; it only reads the source module. To use it, return to setup, launch the world, and enable it under Manage Modules. It is for your own table only: never share or publish it.

A book you own on paper can be typed in as JSON documents under `<Foundry Data>/wildpath-sources/<book>/`, then built into a local module with `node scripts/content/build-local-module.mjs <book>`. It counts as a supplement, or as third-party when the book is marked so.

## The builder

An Action's sheet opens on its **Builder** tab, a set of tabletop questions: its cost, range, targets, area, attack, save or check, damage, healing and effects. Formulas like `2d6 + mod(wits)` work. The **Test** tab previews the result, and the **Advanced** tab holds the raw data.

Other items have a **Rules** tab of rows: bonuses, Advantage or Disadvantage, resistances, speeds, light and more. Input that isn't valid isn't saved.

## The Rules Inspector (GM)

Press **Shift+I**, or **Inspect** on a chat card, to see how the 25 most recent Actions resolved:

- each stage they ran;
- each roll, with its formula, Advantage or Disadvantage, natural result and total, and whether the dice were digital or physical;
- attacks against AC and saves against DC;
- health changes, payments, effects and errors.

It also shows whom an Action is waiting on, with **Answer for them**.
