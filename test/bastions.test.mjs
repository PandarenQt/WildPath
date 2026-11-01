import {test} from "node:test";
import assert from "node:assert/strict";
import {canAddSpecial, defendersLost, mapProblems, mapSize, recruited, specialSlots, tradeSale} from "../module/helpers/bastions.mjs";
import {admitFacility, bastionTurn} from "../module/applications/bastions.mjs";

test("a Bastion's special facility slots and map size grow with its character's level", () => {
  assert.deepEqual([4, 5, 8, 9, 13, 17, 20].map(specialSlots), [0, 2, 2, 4, 5, 6, 6]);
  assert.deepEqual([5, 9, 13, 17].map(mapSize), [12, 16, 20, 24]);
});

test("a special facility needs character level 5, its own level, and a free slot", () => {
  assert.equal(canAddSpecial({level: 4})?.key, "WILDPATH.BASTION.TooYoung");
  assert.equal(canAddSpecial({level: 5, facilityLevel: 9})?.key, "WILDPATH.BASTION.TooLow");
  assert.equal(canAddSpecial({level: 5, facilityLevel: 5, specialCount: 2})?.key, "WILDPATH.BASTION.NoSlot");
  assert.equal(canAddSpecial({level: 9, facilityLevel: 5, specialCount: 2}), null);
});

test("a Bastion map is refused squares outside it, shared squares, and a facility past its space", () => {
  const facilities = {a: "cramped", b: "roomy"};
  assert.deepEqual(mapProblems([{x: 0, y: 0, facilityId: "a"}, {x: 1, y: 0, facilityId: "b"}], {size: 12, facilities}), []);
  const problems = mapProblems([{x: 12, y: 0, facilityId: "b"}, {x: 0, y: 0, facilityId: "b"}, {x: 0, y: 0, facilityId: "a"},
    ...[1, 2, 3, 4].map(x => ({x, y: 1, facilityId: "a"}))], {size: 12, facilities});
  assert.deepEqual(problems.map(problem => problem.key), ["WILDPATH.BASTION.MapOutside", "WILDPATH.BASTION.MapOverlap", "WILDPATH.BASTION.MapTooBig"]);
  assert.deepEqual(problems[2].data, {id: "a", count: 5, most: 4});
});

test("orders: Recruit adds up to 4 within what the facilities house, Trade sells at its profit, an attack costs each 1", () => {
  assert.equal(recruited(0, 12), 4);
  assert.equal(recruited(10, 12), 2);
  assert.equal(recruited(12, 12), 0);
  assert.equal(tradeSale(500, 10), 550);
  assert.equal(defendersLost([1, 3, 1, 6, 2, 1]), 3);
});

test("a Bastion turn: the orders issued its special facilities, and a quiet one when every facility maintains", () => {
  const facility = (name, kind, order) => ({type: "facility", name, system: {kind, current: {order}}});
  const busy = bastionTurn({items: [facility("Bedroom", "basic", "maintain"), facility("Arcane Study", "special", "craft"),
    facility("Garden", "special", "maintain")]});
  assert.deepEqual([busy.orders.map(entry => [entry.facility.name, entry.order]), busy.quiet], [[["Arcane Study", "craft"]], false]);
  assert.equal(bastionTurn({items: [facility("Garden", "special", "maintain")]}).quiet, true);
  assert.equal(bastionTurn({items: [facility("Bedroom", "basic", "maintain")]}).quiet, false, "no special facility: no Bastion turn");
});

test("facilities added together count against the slots and the gold, as one at a time would", () => {
  const actor = gp => ({type: "character", name: "Bastion", items: [], system: {details: {level: 5}, currency: {gp}}});
  const special = {type: "facility", system: {kind: "special", level: 5}};
  const basic = size => ({type: "facility", system: {kind: "basic", size}});
  const batch = {special: 0, basic: 0, cost: 0};
  const rich = actor(1000);
  assert.deepEqual([special, special, special].map(data => admitFacility(rich, data, batch).ok), [true, true, false], "2 slots at 5th");
  assert.deepEqual([basic("cramped"), basic("roomy"), basic("cramped"), basic("cramped")].map(data => admitFacility(rich, data, batch).cost),
    [0, 0, 500, 500], "the first two are free");
  assert.equal(batch.cost, 1000);
  assert.equal(admitFacility(rich, basic("cramped"), batch).ok, false, "the batch already spends all 1,000 gp");
});

test("a Bastion turn runs only on the active GM, and an order its player gave while it ran stays for the next turn", async () => {
  const {runBastionTurn} = await import("../module/applications/bastions.mjs");
  const updates = [];
  const facility = {name: "Workshop", system: {kind: "special", current: {order: "craft", craft: "Item.boots", progress: 0}},
    update: async data => {
      updates.push(data);
      // The player re-orders while the turn runs: after the craft's progress is written, before the reset.
      if ( "system.current.progress" in data ) facility.system.current.order = "trade";
    }};
  const actor = {type: "character", hasPlayerOwner: true, name: "Hero", items: [{...facility, type: "facility"}], system: {bastion: {}}};
  actor.items = [facility];
  facility.type = "facility";
  const messages = [];
  const game = (self, active) => ({user: {id: self}, users: {activeGM: {id: active}}, actors: [actor], time: {advance: async () => {}}});
  const previous = globalThis.fromUuid;
  globalThis.fromUuid = async () => ({name: "Boots", system: {price: 5000, rarity: "rare"}, flags: {}});
  try {
    await runBastionTurn({game: game("gm2", "gm1"), ChatMessage: {create: async data => { messages.push(data); }}});
    assert.deepEqual([updates.length, messages.length], [0, 0], "not the active GM: nothing runs");
    await runBastionTurn({game: game("gm1", "gm1"), ChatMessage: {create: async data => { messages.push(data); }}});
    assert.equal(messages.length, 1);
    assert.equal(facility.system.current.order, "trade", "the order given mid-turn is not reset to Maintain");
    assert.equal(updates.some(data => data["system.current.order"] === "maintain"), false);
  } finally { globalThis.fromUuid = previous; }
});

test("a shared Bastion pools its members' ground on a square grid just large enough", async () => {
  const {pooledSquares, sharedGrid} = await import("../module/helpers/bastions.mjs");
  assert.deepEqual([pooledSquares(5, null), pooledSquares(5), pooledSquares(9, 500), pooledSquares(5, 0), pooledSquares(5, "lots")],
    [144, 144, 256, 0, 0], "null is all its ground; more than it has (after a level lost) is clamped; garbage is none");
  const member = (level, squares=null) => ({system: {details: {level}, bastion: {shared: {id: "g", squares}}}});
  assert.deepEqual(sharedGrid([member(5), member(5)]), {capacity: 288, size: 17});
  assert.deepEqual(sharedGrid([member(5, 0), member(5, 144)]), {capacity: 144, size: 12});
  assert.deepEqual(sharedGrid([]), {capacity: 0, size: 0});
});

test("characters carrying the same shared id are one Bastion; one sharing none is a Bastion of its own", async () => {
  const {bastionGroups} = await import("../module/helpers/bastions.mjs");
  const character = (id, shared="") => ({id, system: {bastion: {shared: {id: shared, squares: null}}}});
  const groups = bastionGroups([character("a", "g"), character("b"), character("c", "g"), character("d")]);
  assert.deepEqual([...groups].map(([id, members]) => [id, members.map(member => member.id)]), [["g", ["a", "c"]], ["b", ["b"]], ["d", ["d"]]]);
});

test("a shared map: more squares than its ground, members' facilities apart, and nothing removed when it shrinks", () => {
  const facilities = {"a.f1": "cramped", "b.f1": "cramped"};
  const cells = [0, 1, 2, 3].map(x => ({x, y: 0, facilityId: "a.f1"})).concat([0, 1, 2].map(x => ({x, y: 1, facilityId: "b.f1"})));
  assert.deepEqual(mapProblems(cells, {size: 12, facilities, most: 7}), [], "the same item id under two members counts apart");
  assert.deepEqual(mapProblems(cells, {size: 12, facilities, most: 6}).map(problem => problem.key), ["WILDPATH.BASTION.MapFull"]);
  assert.deepEqual(mapProblems([...cells, {x: 0, y: 0, facilityId: "b.f1"}], {size: 12, facilities, most: 20}).map(problem => problem.key),
    ["WILDPATH.BASTION.MapOverlap"], "two members on one square");
  // A member leaves: the ground shrinks to 2 by 2, and every square is still there to be shown as a problem.
  const shrunk = mapProblems(cells, {size: 2, facilities, most: 4});
  assert.deepEqual([shrunk[0].key, shrunk.filter(problem => problem.key === "WILDPATH.BASTION.MapOutside").length, cells.length],
    ["WILDPATH.BASTION.MapFull", 3, 7]);
});

test("in a shared Bastion each member keeps its own slots and draws its own event", () => {
  const special = {type: "facility", system: {kind: "special", level: 5}};
  const member = level => ({type: "character", name: "Member", system: {details: {level}, bastion: {shared: {id: "g", squares: null}}},
    items: [{...special, system: {...special.system, current: {order: "maintain"}}}, {...special, system: {...special.system, current: {order: "maintain"}}}]});
  assert.equal(admitFacility(member(5), special).ok, false, "a level-5 member beside a level-17 one still has 2 slots");
  assert.equal(admitFacility(member(17), special).ok, true);
  assert.deepEqual([member(5), member(17)].map(actor => bastionTurn(actor).quiet), [true, true]);
});

/** Writes `data`'s dotted paths into `target`, as Document#update would. */
const writer = target => async data => {
  for ( const [path, value] of Object.entries(data) ) {
    const keys = path.split(".");
    const last = keys.pop();
    keys.reduce((object, key) => (object[key] ??= {}), target)[last] = value;
  }
};

test("an Attack that leaves a Bastion no defenders shuts a special facility down for its next turn", async () => {
  const {runBastionTurn} = await import("../module/applications/bastions.mjs");
  const facility = name => {
    const item = {type: "facility", name, system: {kind: "special", current: {order: "maintain"}}};
    item.update = writer(item);
    return item;
  };
  const workshop = facility("Workshop");
  const garden = facility("Garden");
  const actor = {type: "character", hasPlayerOwner: true, name: "Hero", items: [workshop, garden], system: {bastion: {defenders: 1}}};
  actor.update = writer(actor);
  const events = ["Attack", "All Is Well"];
  const table = {results: {size: 1}, draw: async () => ({results: [{name: events.shift()}]})};
  const messages = [];
  const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, actors: [actor], time: {advance: async () => {}},
    packs: [{documentName: "RollTable", getIndex: async () => [{name: "Bastion Events", _id: "t"}], getDocument: async () => table}]};
  const ChatMessage = {create: async data => { messages.push(data.content); }};
  const previous = globalThis.Roll;
  const rolls = [];
  // Every d6 a 1, and the d2 picking the facility a 2: the Garden.
  globalThis.Roll = class {
    constructor(formula) { this.formula = formula; }
    async evaluate() {
      rolls.push(this.formula);
      Object.assign(this, {total: 2, dice: [{results: Array.from({length: 6}, () => ({result: 1}))}]});
      return this;
    }
  };
  try {
    await runBastionTurn({game, ChatMessage});
    assert.deepEqual([actor.system.bastion.defenders, garden.system.current.shutDown, workshop.system.current.shutDown, rolls],
      [0, true, undefined, ["6d6", "1d2"]]);
    assert.match(messages[0], /WILDPATH\.BASTION\.ShutDown/);
    garden.system.current.order = "craft";
    await runBastionTurn({game, ChatMessage});
    assert.equal(garden.system.current.shutDown, false, "repaired after the turn it sat out");
    assert.equal(garden.system.current.order, "craft", "its order was not carried out, and waits");
    assert.match(messages[1], /WILDPATH\.BASTION\.Repaired/);
    assert.match(messages[1], /WILDPATH\.BASTION\.EventDrawn/, "a shut facility counts as maintaining: the Bastion still has its event");
  } finally { globalThis.Roll = previous; }
});

test("a shared Bastion map edits only this user's members, keeps squares off the grid, and saves each its own", async t => {
  const saved = {foundry: globalThis.foundry, game: globalThis.game, ui: globalThis.ui};
  t.after(() => Object.assign(globalThis, saved));
  globalThis.foundry = {applications: {api: {HandlebarsApplicationMixin: base => base,
    ApplicationV2: class { constructor(options) { this.options = options; } render() {} }}}};
  const {WildPathBastionMap} = await import("../module/applications/bastion-map.mjs");
  const itemsOf = list => Object.assign(list, {get: id => list.find(item => item.id === id), has: id => list.some(item => item.id === id)});
  const updates = [];
  const member = (id, isOwner, facilities, cells) => ({id, name: id, type: "character", isOwner, items: itemsOf(facilities),
    system: {details: {level: 5}, bastion: {shared: {id: "g", squares: null}, map: {cells}}}, update: async data => { updates.push([id, data]); }});
  const ann = member("ann", true, [{id: "f1", type: "facility", name: "Garden", system: {size: "roomy"}},
    {id: "f2", type: "facility", name: "Study", system: {size: "cramped"}}], [{x: 30, y: 0, facilityId: "f1"}, {x: 2, y: 0, facilityId: "f2"}]);
  const bob = member("bob", false, [{id: "f1", type: "facility", name: "Forge", system: {size: "cramped"}}], [{x: 1, y: 0, facilityId: "f1"}]);
  const warns = [];
  globalThis.game = {actors: [ann, bob], user: {isGM: false}, i18n: {format: key => key, localize: key => key}};
  globalThis.ui = {notifications: {warn: message => warns.push(message), info: () => {}}};
  const map = new WildPathBastionMap(ann);
  assert.equal(map.options.id, "wildpath-bastion-map-shared-g");
  const context = await map._prepareContext();
  assert.equal(context.size, 17, "two level-5 members pool 288 squares");
  assert.deepEqual(context.problems, ["WILDPATH.BASTION.MapOutside"], "the square off the grid is kept, as a problem");
  assert.deepEqual([context.rows[0][1].readonly, context.rows[0][2].readonly], [true, false], "Bob's square is his");
  assert.deepEqual(context.groups.map(group => group.facilities.map(facility => [facility.id, facility.pickable, facility.used])),
    [[["ann.f1", true, 1], ["ann.f2", true, 1]], [["bob.f1", false, 1]]]);
  const {pick, clear, save} = WildPathBastionMap.DEFAULT_OPTIONS.actions;
  await save.call(map);
  assert.deepEqual([warns.length, updates.length], [1, 0], "a map with problems is not saved");
  pick.call(map, null, {dataset: {facilityId: "bob.f1"}});
  assert.equal(map.selected, null, "another member's facility can't be picked");
  pick.call(map, null, {dataset: {facilityId: "ann.f1"}});
  clear.call(map);
  await save.call(map);
  assert.deepEqual(updates, [["ann", {"system.bastion.map.cells": [{x: 2, y: 0, facilityId: "f2"}]}]], "only Ann is written, in her own ids");
});

test("covering an ally's losses: one at a time from the member with the most defenders, the earlier on a tie", async () => {
  const {coverLosses} = await import("../module/helpers/bastions.mjs");
  assert.deepEqual(coverLosses(5, [{id: "a", defenders: 3}, {id: "b", defenders: 3}, {id: "c", defenders: 1}]),
    {by: [{id: "a", lost: 3}, {id: "b", lost: 2}], rest: 0});
  assert.deepEqual(coverLosses(4, [{id: "a", defenders: 1}, {id: "b", defenders: 0}]), {by: [{id: "a", lost: 1}], rest: 3},
    "what they can't cover is the attacked member's");
  assert.deepEqual([coverLosses(2, []), coverLosses(0, [{id: "a", defenders: 5}]), coverLosses("x", [{id: "a", defenders: "y"}])],
    [{by: [], rest: 2}, {by: [], rest: 0}, {by: [], rest: 0}]);
});

test("a Bastion turn lists a shared Bastion's lines under its members, and a covering member takes an Attack's losses", async () => {
  const {runBastionTurn} = await import("../module/applications/bastions.mjs");
  const character = (id, shared, defenders, order="maintain", cover=false) => {
    const facility = {type: "facility", name: `${id}-facility`, system: {kind: "special", current: {order}}};
    facility.update = writer(facility);
    const actor = {id, type: "character", hasPlayerOwner: true, name: id, items: [facility],
      system: {bastion: {defenders, shared: {id: shared, squares: null, cover}}}};
    actor.update = writer(actor);
    return actor;
  };
  // Six 1s on the Attack: Ann, attacked first, would lose every defender she has.
  const turn = async actors => {
    const events = ["Attack", "All Is Well"];
    const table = {results: {size: 1}, draw: async () => ({results: [{name: events.shift()}]})};
    const messages = [];
    const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, actors, time: {advance: async () => {}},
      packs: [{documentName: "RollTable", getIndex: async () => [{name: "Bastion Events", _id: "t"}], getDocument: async () => table}]};
    const previous = globalThis.Roll;
    globalThis.Roll = class {
      async evaluate() { return Object.assign(this, {total: 1, dice: [{results: Array.from({length: 6}, () => ({result: 1}))}]}); }
    };
    try {
      await runBastionTurn({game, ChatMessage: {create: async data => { messages.push(data.content); }}});
    } finally { globalThis.Roll = previous; }
    return messages;
  };
  const ann = character("Ann", "g", 1);
  const cal = character("Cal", "", 0, "harvest");
  const bob = character("Bob", "g", 10, "maintain", true);
  const messages = await turn([ann, cal, bob]);
  assert.deepEqual([ann.system.bastion.defenders, bob.system.bastion.defenders, ann.items[0].system.current.shutDown], [1, 9, undefined],
    "Bob takes Ann's one loss, so Ann keeps her defender and nothing shuts down");
  const none = character("Ann", "g", 0);
  const cover = character("Bob", "g", 10, "maintain", true);
  await turn([none, cover]);
  assert.deepEqual([none.system.bastion.defenders, cover.system.bastion.defenders, none.items[0].system.current.shutDown], [0, 10, true],
    "with no defenders Ann has nothing to cover: Bob loses none, and her facility shuts down");
  const [content] = messages;
  const at = key => content.indexOf(key);
  assert.ok((at("WILDPATH.BASTION.Order") < at("WILDPATH.BASTION.SharedTitle")) && (at("WILDPATH.BASTION.SharedTitle") < at("WILDPATH.BASTION.Attack")),
    "the solo Bastion's lines first, then the shared one's under its heading");
  assert.equal(content.split("<h4>").length, 2, "one heading for the shared Bastion");
  assert.match(content, /WILDPATH\.BASTION\.Covered/);
  assert.match(content, /WILDPATH\.BASTION\.EventDrawn/, "Bob draws his own event");
});

test("founding, joining and leaving a shared Bastion writes only the character's own id, and says so in chat", async () => {
  const {shareBastion} = await import("../module/applications/bastions.mjs");
  const character = (name, id="") => {
    const actor = {name, type: "character", visible: true, system: {bastion: {shared: {id, squares: null}}}};
    actor.update = writer(actor);
    return actor;
  };
  const ann = character("Ann");
  const bob = character("Bob");
  const messages = [];
  const options = {game: {actors: [ann, bob]}, ChatMessage: {create: async data => { messages.push(data.content); }}};
  await shareBastion(ann, "g", options);
  await shareBastion(bob, "g", options);
  await shareBastion(bob, "g", options);
  assert.deepEqual([ann.system.bastion.shared.id, bob.system.bastion.shared.id], ["g", "g"]);
  await shareBastion(ann, "", options);
  assert.deepEqual([ann.system.bastion.shared.id, bob.system.bastion.shared.id], ["", "g"], "the one who leaves keeps the rest");
  assert.deepEqual(messages, ["WILDPATH.BASTION.Founded", "WILDPATH.BASTION.Joined", "WILDPATH.BASTION.Left"], "joining twice says nothing");
});
