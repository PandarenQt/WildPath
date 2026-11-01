# Shared Bastions (plan 5.2)

Status: **built** (2026-11-01), all stages and questions 8 and 9; the owner took all ten recommendations (questions-for-owner.md, Q12, 2026-10-31). Two optional fields go beyond the data model below: `system.current.shutDown` on a facility Item (question 8) and `system.bastion.shared.cover` on the character (question 9), both defaulted, no migration. Still to do: the live check in two browsers (Tests, below). Files, lines and fields were checked against `7af0f9ef`. The rules reading was checked against the local DMG pack, which is not committed; this document states them in its own words and quotes nothing from the book.

## How the rules frame it

In the 2024 DMG, combining Bastions puts several Bastions in one building. Each Bastion still keeps all of these as its own:
- its special facility slots, which come from its own character's level;
- how its facilities work;
- who issues its orders;
- its hirelings;
- its defender roster;
- its Bastion event roll. A character whose facilities all maintain still rolls one event, even when the Bastions are combined.

Only two things are shared:
- **The floor plan.**
- **An optional defender rule.** When an event costs one member defenders, another member may choose to take some or all of those losses instead.

The "pool 0 to many squares" idea extends WildPath's own map size (`mapSize(level)` in `module/helpers/bastions.mjs:25`). The DMG does not set a map size.

So a shared Bastion is **one map holding several solo Bastions**. Facilities, orders, the turn, payments and events stay exactly as they work today, for each character.

## Today's code (verified)

| Piece | Where |
|---|---|
| `system.bastion = {name, defenders, map: {cells: [{x, y, facilityId}]}}` | `module/data/actor/character.mjs:17-23` |
| Facilities are embedded `facility` Items. Each holds its order in `system.current.order`, plus `system.trade`, `system.defenders` and `system.size`. | `module/data/item/facility.mjs` |
| Orders are issued on the sheet (`select[data-item-order]` → `item.update`) | `module/applications/actor-sheet.mjs:228-234` |
| `bastionTurn`, `carryOut`, `bastionEvent`, `runBastionTurn`, `admitFacility`, `payFacility`, `enlargeFacility`. Every cost is paid from the facility's own actor. | `module/applications/bastions.mjs` |
| `runBastionTurn` is guarded by a module-level `let running` (line 122). Fixed in `81b189a5`: only the active GM runs a turn. | `bastions.mjs:121-147` |
| An order is reset to Maintain right after it is carried out (line 137). Fixed in `81b189a5`: an order given mid-turn is kept. | `bastions.mjs:137` |
| The map constructor silently drops cells outside the current grid (lines 29-32), and the next save discards them | `module/applications/bastion-map.mjs` |
| `mapProblems(cells, {size, facilities})` counts squares per bare `facilityId` | `module/helpers/bastions.mjs:45` |
| Sheet Bastion context (`bastionInfo`) | `actor-sheet.mjs:116-121`, `templates/actor/actor-sheet.hbs:316-322` |
| GM-relayed query pattern, used only if approval is chosen | `module/adapters/foundry-v14-companions.mts:68-85` |
| How the project gates work to the active GM: `game.users?.activeGM?.id === game.user.id` | `module/adapters/foundry-v14-automation-dispatcher.mts:191` |

## Data model

The only addition is one field on the **character Actor**, inside the existing `bastion` SchemaField in `module/data/actor/character.mjs`:

```js
shared: new SchemaField({
  id: new StringField({required: true, blank: true, initial: ""}),      // "" = solo; else the group's randomID()
  squares: new NumberField({required: true, integer: true, min: 0, nullable: true, initial: null}), // null = all its ground
  cover: new BooleanField({required: true, initial: false}) // takes other members' defender losses (question 9)
})
```

- **`id`.** Characters that carry the same non-blank `id` form one shared Bastion. No group document exists: a group lasts while any character carries its id, so it cannot be orphaned, and a deleted actor simply drops out.
- **`squares`.** The ground this member adds. When read, it is clamped to `[0, mapSize(level)²]`, so a member who loses levels cannot pool more than it has. `null` means all of its ground.
- **Unchanged:**
  - `bastion.name`;
  - `bastion.defenders`, kept per member as the DMG requires;
  - `bastion.map.cells` `{x, y, facilityId}`. `facilityId` still points at the member's own Item. While the member belongs to a group, its x and y are in shared-grid coordinates.
  - Every facility Item field.

New pure helpers go in `module/helpers/bastions.mjs` and touch no Foundry globals:
- **`pooledSquares(level, squares)`** returns `min(squares ?? mapSize(level)², mapSize(level)²)`.
- **`sharedGrid(members)`** returns `{capacity: Σ pooledSquares, size: ceil(sqrt(capacity))}`.
- **`bastionGroups(characters)`** returns a `Map` from `shared.id || actor.id` to its members. A solo character is a group of one.
- **`mapProblems(cells, {size, facilities, most})`**:
  - The new `most` is optional. When the number of painted cells exceeds `most`, it reports `WILDPATH.BASTION.MapFull`.
  - If `most` is undefined, it behaves exactly as today.
  - On the shared map, callers key cells and facilities as `${actorId}.${facilityId}`. Two members' facilities then never collide, and overlaps across members are still caught.

## Ownership and permissions

- **Writes.** A player writes only Actors they own. No document's ownership changes, and no socket or query is needed.
  - **Join, leave and pooled squares.** The owner updates the character's own `shared`.
  - **Map.** A user may paint and clear only cells of facilities on Actors where `actor.isOwner`. A player who owns two members edits both, and the GM edits all.
  - **Facilities and orders.** They stay on Items owned by their character, which is how the DMG's per-Bastion orders are kept.
- **Removing a member.** Only the GM can, by clearing that character's `shared.id`. Foundry's ownership enforces this, not hidden UI.
- **Reading.** The shared map and the member list read other members from `game.actors`.
  - The Join list offers only groups that contain a character the user can see at `LIMITED` or above.
  - **Live check needed:** confirm that V14 gives a player client the data of member Actors the player cannot open. If it does not, the members need LIMITED on each other. The fallback is a GM query on the `foundry-v14-companions` pattern.
- **Bastion turn.** It stays a GM-only scene control. It now also runs only on the active GM (see below).

## Orders and Bastion turns

Rules stay per member. `bastionTurn(actor)`, `carryOut(actor, facility, order)`, `bastionEvent(actor)` and `admitFacility` do **not** change:
- Recruit counts the member's own housing.
- An Armory's stocking cost uses the member's own defenders and a Smithy the member owns.
- An Attack uses the member's own Armory and defenders.
- Each member whose special facilities all maintain draws its own event.

Changes to `runBastionTurn`:
1. **Active GM only.** Return unless `game.users?.activeGM?.id === game.user.id`. Fix the line 121 comment. Today two GM clients can each run a turn; this is an existing bug.
2. **Keep an order issued mid-turn.** Reset to Maintain only if the order is still the one that was carried out: `if (facility.system.current.order === order) await facility.update({"system.current.order": "maintain"})`. An order the player re-issues during the turn then survives to the next turn.
3. **Chat grouping.** Build `bastionGroups` once at the start of the turn. List each shared group's lines under one heading naming its members. Membership changes made during the turn take effect next turn. A solo Bastion's lines look as they do now.

## Payments

Nothing changes, and there is no shared purse. Building, enlarging, crafting, trade stock and Armory stock are each paid from the coins of the character whose facility it is. Slots and the two free basic facilities stay per character.

## Joining and leaving

- **Founding a group.** The owner sets `shared.id = foundry.utils.randomID()`.
- **Joining.** The owner picks a visible group, and its `shared.id` is set to that group's id.
  - Its cells are **kept**. Any that fall outside the shared grid or overlap another member show as problems until the member re-lays them. Nothing is deleted.
  - Its slots, orders, defenders and coins do not change.
  - `squares` stays `null`, which means it pools all of its ground.
- **Leaving.** The owner (or the GM, to remove a member) sets `shared.id = ""`.
  - The leaver keeps everything, because everything was always stored on its own character.
  - Its cells stay in `map.cells`. On its solo map, any cells outside its own grid show as `MapOutside` (see the constructor change below).
- **Remaining members.** The group loses the leaver's facilities and pooled ground. If what is painted no longer fits the smaller area, the map shows `MapFull`/`MapOutside` and refuses saves until it is fixed. Nothing is moved or deleted automatically.
- **Last member.** When one member is left, it is a group of one. It needs no special case and can leave to go solo.
- **Chat.** Joining or leaving posts a short chat line, so an open join is visible to the table.
- **Constructor change** (`bastion-map.mjs:29-32`). Stop dropping out-of-grid cells. Keep them and report them through `mapProblems`. Today the drop is intentional (the comment explains it), but join, leave and level loss would make it silent data loss. "Clear the picked facility" already removes all of a facility's cells, including ones off the grid, so the user can always fix them.

## Migration and defaults

No migration and no `migrateData` change. `shared` is additive and defaults to `{id: "", squares: null}`, so every existing character reads as solo: the same grid (`mapSize(level)`), the same cells and the same turn. Facility Items are untouched, and `system.json` document types do not change. Under the standing permission for optional fields this needs no prior approval; record it in `project-state.md`.

## UI

1. **Sheet Bastion section** (`actor-sheet.hbs:316`, context in `actor-sheet.mjs:116-121`). It is still shown only when `bastionInfo` exists (level 5 or higher, or the character has facilities).
   - **Solo:** a select of the visible groups, Join, and Found a shared Bastion.
   - **Member:** the members with their pooled squares, the total ground and grid side, a "Squares pooled" number input (blank means all), and Leave.
   - The slots and defenders line stays per character.
   - Controls are disabled when the sheet is not editable.
2. **Bastion map** (`bastion-map.mjs`, `templates/apps/bastion-map.hbs`). When the actor is in a group:
   - The window id is `wildpath-bastion-map-shared-${id}`, and the title names the members.
   - The size is `sharedGrid(...).size`, and the map validates with `most = capacity`.
   - `this.cells` holds only the cells of members the user owns, which are the local unsaved edits. Other members' cells are read live from their actors on every render. They are drawn hatched and read-only, titled "<facility> (<member>)", and `#paint` refuses them.
   - The sidebar lists facilities grouped by member. Only facilities the user owns can be picked.
   - **Save** validates the union of the local owned cells and the other members' live cells, and refuses on any problem. It then updates each owned member Actor with only its own cells. Because the other members' cells are read live, this is also the "re-read before save" step.
   - **Re-render.** An `updateActor` hook re-renders when any group member's `system.bastion` changes. It is added in `_onFirstRender` and removed in `_onClose`. Local edits survive because they sit in `this.cells`.
   - **Make a Scene** (GM only) draws the union of the members' cells, labels each facility "Facility (Member)", and names the Scene after the group.
   - Solo mode stays exactly as today.
3. **Bastion Turn chat:** lines are grouped by shared Bastion.
4. **`lang/en.json`**, about 12 keys under `WILDPATH.BASTION`: SharedTitle, Found, Join, Leave, Members, Pooled, Ground, MapFull, MapTaken, Joined, Left, plus the Make a Scene label.
5. **Docs:**
   - `docs/architecture/combat-timeline.md` (the Bastions section at lines 100-127) gets this data model.
   - `docs/guide/05-gm-tools.md` and `06-exploration.md` each get a short paragraph.
   - `docs/development/project-state.md` gets the milestone status.

## Tests

All in `test/bastions.test.mjs` (`npm test`):
- **`pooledSquares`:** `null` gives all of `mapSize(level)²`; values above that are clamped after level loss; 0 is allowed; garbage reads as 0.
- **`sharedGrid`:** two level-5 members pooling everything give capacity 288 and side 17; pools of 0 and 144 give 144 and 12; no members gives 0.
- **`bastionGroups`:** characters with the same id form one group; blank ids give groups of one; two solo characters are never merged.
- **`mapProblems` with `most`:** more cells than `most` gives `MapFull`; namespaced `a.f1` and `b.f1` are counted separately; the same square under two members gives `MapOverlap`; called without `most`, the existing assertions are unchanged.
- **Rules kept (regression):**
  - a level-5 member in a group with a level-17 member still has 2 slots in `admitFacility`;
  - two quiet members each report `quiet` from `bastionTurn`, giving one event each.
- **Leaving:** after the capacity shrinks, the remaining cells give `MapFull`/`MapOutside` and no cell is removed.
- **`runBastionTurn`, with stubbed `game`, `ChatMessage` and facilities:**
  - it does nothing on a client that is not the active GM;
  - an order changed between `carryOut` and the reset survives;
  - members of one group appear under one chat heading.
- **Live check in two browsers (foundry-gm, foundry-player):**
  - the player founds a group, a second character joins, and each paints only its own facility;
  - the other member's cells are read-only, and a save writes only the player's own actor;
  - the GM's turn runs both members' orders, grouped in chat;
  - a member leaves and keeps its facilities and defenders, and the remaining map shows problems without losing data;
  - this also settles whether `game.actors` holds Actors the player cannot open.

Commands: `npm test` and `npm run typecheck`. The project has no lint script, and `.mjs` files have no build step.

## Staged build order (about 300 lines including tests)

0. **Turn fixes (existing bugs, independent):** the active-GM gate and the order-reset guard, with their tests. Done `81b189a5`.
1. **Data and helpers:** the `shared` field, `pooledSquares`, `sharedGrid`, `bastionGroups`, and `mapProblems({most})`, with their tests. Done.
2. **Map:** stop dropping out-of-grid cells; add shared mode (namespaced keys, read-only other members, the `updateActor` hook, union save, Make a Scene). Done; a member who joins while the map is open is read-only there until it is reopened, so a save never overwrites squares the window did not load.
3. **Sheet:** Found, Join and Leave, the pooled input, the members line, chat lines, lang keys. Done: `shareBastion` in `applications/bastions.mjs` writes the id and posts the chat line; the GM's ✕ beside a member removes it.
4. **Turn chat grouping, docs and project-state, then the live check in two browsers.** Done but for the live check: solo lines come first, then each shared Bastion's under one heading.
5. **Owner questions 8 and 9:** the zero-defender shutdown rule (done: an Attack that leaves no defenders shuts a random special facility down; it carries out no order, counts as maintaining, and is repaired after the next turn), then covering an ally's losses (done: each member opts in with `shared.cover` on its sheet; `coverLosses` takes an Attack's losses one at a time from the coverer with the most defenders left, the earlier member on a tie, and the attacked member loses what they can't cover; they cover only what it could lose, so one with no defenders still shuts down).

## Owner questions

1. **What is shared?** Only the map. Slots, orders, hirelings, defenders, events and payments stay per character, which matches the DMG.
   - Options: (a) map only; (b) also pool Recruit housing, Armory and Smithy, and draw one event per group.
   - **Recommend (a).** Option (b) contradicts the DMG.
2. **Where is it stored?** Options: (a) one optional field on each member; (b) a new "bastion" Actor type the members own; (c) a world setting the GM writes.
   - **Recommend (a).** There is nothing to orphan, no relay, and Foundry's ownership does the permission checks.
3. **Joining.**
   - Options: (a) open to any visible group, announced in chat, and the GM can remove anyone; (b) invite and approve through a GM query (about 60 more lines).
   - **Recommend (a).**
4. **Partial pooling.** Does a member who pools fewer than all its squares keep a private map for the rest?
   - Options: (a) no, the unpooled ground is simply unused while it is a member; (b) yes, which needs a per-cell flag.
   - **Recommend (a).**
5. **Out-of-grid squares.** Today they are dropped silently when the map opens.
   - Options: (a) keep them and show a problem until cleared, for solo maps too; (b) keep dropping them.
   - **Recommend (a).** Joining and leaving would otherwise lose layouts.
6. **Cells on join.**
   - Options: (a) keep them, and show overlaps and out-of-bounds squares as problems; (b) clear them on join.
   - **Recommend (a).** Nothing is discarded.
7. **The shared Bastion's name.**
   - Options: (a) show the members' names, with no new field; (b) one shared name copied to every member.
   - **Recommend (a).**
8. **Zero-defender shutdown.** The DMG's Attack event shuts down a special facility when a Bastion has no defenders left. It is not built, even for solo Bastions.
   - Options: (a) build it as its own item; (b) leave it to the GM.
   - **Recommend (a),** before question 9.
9. **Covering an ally's defender losses.**
   - Options: (a) each member opts in, and losses move automatically (most defenders first); (b) a chat button for the other members; (c) leave it out.
   - **Recommend (c) until question 8 is built,** then (a). Without the shutdown rule, covering losses changes no outcome.
10. **Grid shape.**
    - Options: (a) a square of side ceil(sqrt(total)), with painting capped at the total; (b) a rectangle (the first member's width plus extra rows).
    - **Recommend (a).** `mapProblems` and `mapSize` stay as they are.
11. **Defensive Walls (not built yet).** When they are built: do walls around a combined Bastion protect every member, and who pays?
    - Options: (a) whoever builds them pays and every member benefits; (b) split the cost by pooled squares; (c) each member pays for its own.
    - **Recommend deciding when the walls are built.**

Open runtime risk: whether V14 sends players the data of member Actors they cannot open; the live check settles it.
