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
  - shortcut: riders (Radiant Weapon's reaction), the new name and attunement are by hand.

Live (two browsers, 14.369):
- QA Caster used the converted Enhanced Weapon on its Dagger: attack +2 → +3, damage +0 → +1. Its Longsword was
  unchanged.
- A copy given to QA Fighter kept the +1.
- With no Artificer levels (a limit of 1), infusing the Longsword ended both Dagger infusions.
- An effect on the unequipped Shield gave nothing (AC 10); equipped, AC was 13 (Shield +2, effect +1).
