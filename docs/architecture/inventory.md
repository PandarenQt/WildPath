# Inventory Spaces, Access, Transfers, and Weight

Wild Path inventory is founded on `InventorySpace`: a logical place where items can exist.

The current implementation begins this foundation in `module/helpers/inventory.mjs`. It is pure
domain logic: no Foundry document is mutated directly.

## Inventory Spaces

An `InventorySpace` has:

- stable id
- label
- host reference
- access policy
- weight policy
- optional capacity
- optional parent item reference
- metadata

Spaces are not necessarily Actors. A space can represent personal inventory, a backpack, a shared
party chest, a vehicle cargo hold, a bag-style extradimensional space, or a custom homebrew space.

## Access vs Ownership

Owning or hosting a space is different from accessing it.

Examples:

- an Actor hosts their personal inventory
- a carried item grants access to a linked bag space
- a key item grants access to a remote vault
- two actors access one shared party space

Access grants preserve provenance so removal/transfer can revoke only the correct access.

## Containment vs Access

Containment and access are separate graphs.

An item can grant access to a remote space without containing that space. A physical container can
also contain a nested space. Cycle prevention applies to containment, not mere access.

## Access Grants

Access grants describe:

- target space
- grantee or grantee policy
- operations (`view`, `deposit`, `withdraw`, `manage`)
- active state
- predicate
- source/provenance

The current holder/carrier policy lets access follow an item when it is transferred.

## Shared and Private Spaces

Separate item instances can point to separate private spaces. Multiple items can also explicitly
link to the same shared space. Shared contents remain one authoritative storage space, not copies
per accessor.

## Weight Policies

Inventory weight separates:

```text
contents weight
who receives propagated weight
whether contents weight propagates at all
```

Supported policy modes:

- `track-and-propagate`
- `track-independently`
- `track-but-ignore-for-carrier`
- `ignore`

This supports ordinary carried storage, independent chests, bag-style spaces, and no-weight spaces
without hardcoding item names.

Multiple accessors do not multiply weight. Weight propagation is explicit policy, not a side effect
of access.

## Capacity

Capacity is independent of weight propagation. A space can track a 500 lb internal capacity while
contributing none of its contents to a carrier.

The current foundation supports maximum internal weight and maximum item count through safe
`ValueExpression` limits.

## Transfers

Transfers are planned before commit:

```text
planInventoryTransfer()
-> validate access, quantity, capacity, containment
-> commitInventoryTransfer()
```

Planning does not mutate state. Commit returns a new state. Partial stack transfers and stack
merging use `stackKey`, not display names.

## Cycle Prevention

The foundation rejects self-containment and recursive containment cycles, such as putting a bag into
its own contained space or into a descendant contained space.

## Foundry Boundary

Future Foundry integration should use an `InventoryRepository` adapter responsible for loading,
saving, listing contents, resolving references, and committing transfer transactions.

Domain code should not directly manipulate arbitrary Foundry storage documents.

The current pure boundary is `createInMemoryInventoryRepository()` in
`module/helpers/inventory-repository.mjs`. It is not the finished persistence implementation; it is
the method contract and test harness for future Foundry-backed adapters.

Repository responsibilities:

- load and save normalized inventory state
- list spaces and contents
- resolve space/item references
- query accessible spaces
- plan transfers without mutation
- commit transfer plans transactionally
- expose weight and debug snapshots

## Debug And Audit

`createInventoryDebugSnapshot()` preserves structured inspection data for developer tools and
future UI:

- spaces and contents
- access operations and provenance
- access grants
- containment edges
- internal weight per space
- actor weight trace when an actor context is supplied

## Carrying (2026-10-21)

The world setting **Carrying** (`encumbrance`, `helpers/carrying.mjs`) decides what a character's load does. Its
carried weight is every gear Item's quantity × weight, equipped or not (the sheet's "Carried").
- **Carrying capacity (2024, the default):** its Might score × 15 lb, times its size's factor by its prototype Token's
  width (Tiny ½, Large ×2, Huge ×4, Gargantuan ×8). Carrying more, its Speed is at most 5 feet (a `movement`
  ResourceCap of 5), as for dragging, lifting or pushing more than that.
- **Variant encumbrance (2014 PHB):** over 5 × Might it is Encumbered (−10 ft on every Speed); over 10 × Might Heavily
  Encumbered (−20 ft, and Disadvantage on Might, Agility and Fortitude attack rolls, saves and checks). Over its
  capacity, the 5-foot cap too.
- **Off:** the weight is shown, and nothing follows.

Its load (`system.carrying`) is worked out in data preparation after the ability scores; its rules join the
character's own as a "Carrying" source (`grantOwners`), so the Rules Inspector shows them. Only characters: a stat
block's Speed is its own. The sheet shows "Carried: 200 / 150 lb" and what the load does.

Live (14.369): a Might 10 character carried up to 150 lb; a 200 lb anvil made its Speed 5 ft, and 40 lb gave 30 back.

## Coins, prices and crafting (2026-10-22)

A character has coins (`system.currency`: pp, gp, ep, sp, cp; shown with its gear), and gear a price in gold and a
rarity (`system.price`, `system.rarity`; the converter's from dnd5e, also kept in the flags of an Action standing for an
item with no gear, as an SRD Longbow or a Potion of Healing does). `helpers/crafting.mjs` holds the 2024 rules:
- a mundane item takes raw materials worth half its price and a day's work for each 10 GP of it;
- a magic item its rarity's days and gold (Common 5 days, 50 GP; Uncommon 10, 200; Rare 50, 2,000; Very Rare 125,
  20,000; Legendary 250, 100,000), half of each for a consumable; a Spell Scroll its spell level's (1 day and 15 GP for
  a cantrip to 120 days and 50,000 GP at 9th);
- paying makes change from the largest coins down (its coins are then gp, sp, cp and pp, no ep).

The GM's "Craft for a character" button on an item's sheet asks which player character crafts it, spends the materials
from its coins (or says it can't pay), gives it the item, and says in the chat how many days it worked. shortcut: the
tool proficiency, formula and rare ingredients are the GM's to check; the days are not taken from anyone's calendar.
Live (14.369): a character with 30 GP crafted the SRD Longbow: 5 days, 25 GP; it had 5 GP and the Longbow after.

## Spell Scrolls (2026-10-21)

A GM makes a Spell Scroll from any spell's Action (its item sheet's "Make Spell Scroll"): gear named "Spell Scroll
(<spell>)" that carries its own Action (`flags.wildpath.grantedActions`, created on whoever holds it, as a compendium
gear's `grants` are). That Action (`helpers/spell-scrolls.mjs`):
- casts the spell at its own level with no slot, with the scroll's save DC and attack bonus (2024 DMG: DC 13 and +5 for
  cantrips to 2nd level, up to DC 19 and +11 at 9th; `attack.fixedBonus`, a new optional attack field, replaces its
  reader's bonus);
- can't be read by a creature that casts no spells; one whose highest spell level is below the spell's first rolls its
  spellcasting ability, DC 10 + the spell's level, and on a failure the spell fades (`Item#use`);
- once read, the scroll crumbles: one fewer, and gone with its Action at none.

Only a character with the spell on one of its classes' spell lists reads it (2026-10-22, `onSpellList`): each converted
spell carries `metadata.spellLists`, the class (and subclass) lists dnd5e's spell list pages put it on (SRD, and a
book's own pages); a spell on no list (homebrew) any spellcaster reads. A creature that is not a character is not
checked (a stat block's spellcasting has no class).

Live (14.369): a non-caster couldn't read a Guiding Bolt scroll; a 1st-level Wizard read it (1d20 + 5) and it crumbled;
a Hold Person scroll's DC 12 check failed (8), and the scroll was gone.

## Identification (2026-10-21)

Gear may be unidentified (`system.identified: false`, a new optional field, true by default), with what it looks like
(`system.unidentified.name`, `.description`; the converter keeps dnd5e's). Its players then see only that: the gear's
name and description, and the names of the Actions it brings (`WildPathItem#prepareDerivedData`, on their clients only;
nothing stored changes). Without an unidentified name it is "Unidentified item". The GM sees everything, and decides
when it is identified (the item sheet's Identified box): Identify, a Short Rest's study, or using it. Live (two browsers,
14.369): Player1 saw "Plain Wand" for a GM's unidentified Wand of Secrets and its Action, and its real names once the GM
identified it.

## Ammunition (2026-10-21)

A weapon with the Ammunition property names what it fires (`definition.ammunition`: "arrow", "crossbowBolt",
"slingBullet", "blowgunNeedle", "firearmBullet"; the converter reads dnd5e's `system.ammunition.type`). Its character's
gear of that kind (`flags.wildpath.source.subtype`) supplies it (`adapters/foundry-v14-ammunition.mjs`):
- An attack with none left is refused ("Out of ammunition for that weapon.").
- Each attack spends one on the authority, after it resolves. In combat it is counted on its creature
  (`flags.wildpath.ammunitionSpent`, by Item).
- When the combat ends, the active GM is asked whether its creatures recover half of what they spent (2024: a minute's
  search, rounded down); the count is cleared either way.
- Only characters: a stat block's attacks need none.

Live (14.369): a character's Longbow shot spent its one arrow, and the next shot was refused.

## Item enchantments (2026-10-20)

An Action with `enchant` puts an effect on one of its creature's Items: an Artificer's infusions, from Tasha's, through
the local book module.
- **Choosing the Item.** Its configuration has a `gear` choice (`optionsFrom: {type: "gear", kinds}`). It lists the
  creature's weapons (gear granting an attack, or a weapon that is its own attack Action, as an SRD Dagger is), armor,
  Shields, or any of these.
- **The effect.** The active GM creates it on that Item once the Action completes
  (`adapters/foundry-v14-enchantments.mts`).
  - It is `transfer: true`, so whoever holds the Item has its rules. A copy given to another creature keeps them.
  - It counts only while the Item does: equipped, and attuned when it needs it (`WildPathActiveEffect#isSuppressed`).
  - `{{host}}` in its rules becomes that Item's id when they are read (`hostedRules`). A weapon's bonus is therefore
    `weapon:{{host}}`, that weapon's attacks alone.
- **Level and limit.**
  - Its creature's class level picks the effect: Enhanced Weapon is +1, and +2 from artificer level 10.
  - `flags.wildpath.enchantment {key, creatorRef, at}` names its creator. A new one with the same key replaces the
    Item's.
  - Past `limit` (Infuse Item's infused-items table), the creator's oldest end, wherever their Items now are.
- **On the sheet.** An inventory row lists the Item's enchantments, each with an End control. An enchanted Item dropped
  from another creature its user owns is moved, not copied.
- **Converter** (`itemEnchantDefinition`):
  - A dnd5e enchant activity's `system.magicalBonus` becomes an attack and damage Modifier on `weapon:{{host}}`, and
    `system.armor.magicalBonus` becomes AC.
  - "+2 when you reach 10th level" sets the level ranges.
  - The Item whose uses it spends (Infuse Item) is its limit and key.
  - Any Item's enchant activity converts so (2026-10-21), not only infusions: a magic item template (Armor of
    Resistance, Shield +1, +2 or +3) is the Action that makes an Item of its kind that magic item. Its several options
    with no level between them are a choice (`enchant.optionChoiceId`, the chosen effect's index), and each brings
    the effects its option names (`riders.effect`: Armor of Resistance's Acid Resistance). A magic bonus may be added
    or raised to (`upgrade`).
  - shortcut: other riders (Radiant Weapon's reaction), changes to the Item itself (Mithral Armor's Strength and Stealth),
    the new name and attunement are by hand.

Live (two browsers, 14.369):
- QA Caster used the converted Enhanced Weapon on its Dagger: attack +2 → +3, damage +0 → +1. Its Longsword was
  unchanged.
- A copy given to QA Fighter kept the +1.
- With no Artificer levels (a limit of 1), infusing the Longsword ended both Dagger infusions.
- An effect on the unequipped Shield gave nothing (AC 10); equipped, AC was 13 (Shield +2, effect +1).
- 2026-10-21: a character with an equipped Shield used the SRD "Shield, +1, +2, or +3" and chose +2: the Shield got
  "Shield +2", and AC went 12 → 14.
