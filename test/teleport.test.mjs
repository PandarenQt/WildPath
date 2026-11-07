import {test} from "node:test";
import assert from "node:assert/strict";
import {createFoundryTeleports, teleportDestination} from "../module/adapters/foundry-v14-teleport.mjs";
import {sanitizeActionIntentPayload} from "../module/helpers/multiplayer-authority.mjs";
import {convertItem} from "../scripts/content/dnd5e-to-wildpath.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";

/** A square grid of 100-pixel, 5-foot fields, with Medium Tokens at the given top-left points. */
function scene(positions) {
  const grid = {
    getOffset: point => ({i: Math.floor(point.y / 100), j: Math.floor(point.x / 100)}),
    getTopLeftPoint: offset => ({x: offset.j * 100, y: offset.i * 100}),
    // Diagonals count 5 feet (2024's default), as Foundry measures them.
    measurePath: ([a, b]) => ({distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 100 * 5})
  };
  const result = {id: "scene", grid, dimensions: {sceneRect: {contains: (x, y) => (x >= 0) && (y >= 0) && (x < 2000) && (y < 2000)}}, tokens: []};
  result.tokens = positions.map(([id, x, y]) => ({id, x, y, parent: result, updates: [],
    getCenterPoint(data={}) { return {x: (data.x ?? this.x) + 50, y: (data.y ?? this.y) + 50}; },
    getOccupiedGridSpaceOffsets(data={}) { return [grid.getOffset({x: (data.x ?? this.x) + 1, y: (data.y ?? this.y) + 1})]; },
    async update(data, operation) { this.updates.push({data, operation}); Object.assign(this, data); }}));
  result.tokens.get = id => result.tokens.find(token => token.id === id);
  return result;
}

test("a teleport lands on a free field within its distance, on the Scene", () => {
  const {tokens: [caster]} = scene([["caster", 500, 500], ["ogre", 700, 500]]);
  assert.deepEqual(teleportDestination({token: caster, point: {x: 1150, y: 520}, distance: 30}), {ok: true, position: {x: 1100, y: 500}},
    "30 feet east, to the field's top-left");
  assert.deepEqual(teleportDestination({token: caster, point: {x: 1250, y: 520}, distance: 30}), {ok: false, code: "OutOfRange"});
  assert.deepEqual(teleportDestination({token: caster, point: {x: 750, y: 550}, distance: 30}), {ok: false, code: "Occupied"},
    "not onto the ogre");
  assert.deepEqual(teleportDestination({token: caster, point: {x: -50, y: 550}, distance: 30}), {ok: false, code: "OffScene"});
  assert.deepEqual(teleportDestination({token: null, point: {x: 0, y: 0}, distance: 30}), {ok: false, code: "NoToken"});
});

test("the active GM moves the Token as V14's Blink once the Action completes; nobody else does", async () => {
  const where = scene([["caster", 500, 500]]);
  const game = (userId) => ({user: {id: userId}, users: {activeGM: {id: "gm"}}, scenes: {get: id => (id === "scene" ? where : null)}});
  const options = {teleport: {sceneId: "scene", tokenId: "caster", x: 1100, y: 500}};
  assert.equal(await createFoundryTeleports({game: game("player")}).afterResolution({options}), null);
  const moved = await createFoundryTeleports({game: game("gm")}).afterResolution({options});
  assert.deepEqual([moved.x, moved.y], [1100, 500]);
  assert.deepEqual(moved.updates[0].operation, {movement: {caster: {waypoints: [{x: 1100, y: 500, action: "blink"}], showRuler: false}},
    wildpath: {movementKind: "teleport"}});
});

test("withTargets: each target blinks to the free field beside the landing nearest it; without it, or with no free field, it stays", async () => {
  const run = async (positions, teleport, chosen={targets: [{tokenId: "friend"}, {tokenId: "caster"}]}) => {
    const where = scene(positions);
    const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, scenes: {get: id => (id === "scene" ? where : null)}};
    await createFoundryTeleports({game}).afterResolution({options: {teleport: {sceneId: "scene", tokenId: "caster", x: 1500, y: 1500}},
      state: {actionDefinition: {teleport}, ...chosen}});
    return where.tokens;
  };
  // The friend stands diagonally beside the caster, so one field beside the landing is nearest it (5-foot diagonals tie a
  // friend in the caster's row between three).
  const [caster, friend] = await run([["caster", 500, 500], ["friend", 600, 600]], {distance: 500, withTargets: true});
  assert.deepEqual([friend.x, friend.y], [1400, 1400]);
  assert.deepEqual(friend.updates[0].operation, {movement: {friend: {waypoints: [{x: 1400, y: 1400, action: "blink"}], showRuler: false}},
    wildpath: {movementKind: "teleport"}});
  assert.equal(caster.updates.length, 1, "the teleporter is not moved again as a target");
  const [, prompted] = await run([["caster", 500, 500], ["friend", 600, 600]], {distance: 500, withTargets: true},
    {targets: [], results: {targetResolution: {targetContexts: [{target: {target: {tokenId: "friend"}}}]}}});
  assert.deepEqual([prompted.x, prompted.y], [1400, 1400], "a target chosen at the target prompt, not in the intent, goes too");
  const [, alone] = await run([["caster", 500, 500], ["friend", 600, 600]], {distance: 500});
  assert.deepEqual(alone.updates, []);
  const ring = [[1400, 1400], [1500, 1400], [1600, 1400], [1400, 1500], [1600, 1500], [1400, 1600], [1500, 1600], [1600, 1600]]
    .map(([x, y], index) => [`wall${index}`, x, y]);
  const [, stuck] = await run([["caster", 500, 500], ["friend", 600, 600], ...ring], {distance: 500, withTargets: true});
  assert.deepEqual([stuck.x, stuck.y, stuck.updates.length], [600, 600, 0]);
});

test("an intent carries one teleport point, plain numbers only", () => {
  const intent = sanitizeActionIntentPayload({intent: {actionRef: "Item.misty", teleport: {point: {x: "1150", y: 520, extra: 1}, other: 2}}});
  assert.deepEqual(intent.teleport, {point: {x: 1150, y: 520}});
  assert.equal(sanitizeActionIntentPayload({intent: {teleport: {point: {x: "far"}}}}).teleport, undefined);
});

test("Misty Step converts to a self teleport of 30 feet; Dimension Door may take one willing creature; Teleport stays by hand", () => {
  const SRD = {license: "CC-BY-4.0", rules: "2024", book: ""};
  const spell = (id, name, teleport, description="") => ({_id: id, name, type: "spell", img: "systems/dnd5e/icons/spell.webp", effects: [],
    system: {source: SRD, identifier: name.toLowerCase().replace(/\s+/g, "-"), level: 2, preparation: {mode: "prepared"},
      description: {value: description},
      properties: ["vocal"], activation: {type: "bonus"}, range: {units: "self"}, target: {affects: {}, template: {}},
      activities: {a: {_id: "actteleport", type: "teleport", sort: 0, activation: {type: "action", override: false},
        range: {override: false}, target: {override: false, template: {}, affects: {}}, effects: [], consumption: {targets: [], spellSlot: true},
        teleport}}}});
  const [misty] = convertItem(spell("testMistyStep001", "Misty Step", {override: true, value: "30", units: "ft"})).items;
  const definition = misty.system.definition;
  assert.deepEqual([definition.teleport, definition.targeting, definition.costs.allOf[0].capability], [{distance: 30}, {type: "self"}, "bonus-action"]);
  assert.equal(validateActionDefinition(definition).ok, true);
  assert.deepEqual(misty.flags.wildpath.conversion.notes, []);
  const [door] = convertItem(spell("testDimensionDr1", "Dimension Door", {override: true, value: "500", units: "ft"},
    "<p>You can also teleport one willing creature.</p>")).items;
  const doorDefinition = door.system.definition;
  assert.deepEqual([doorDefinition.teleport, doorDefinition.targeting, doorDefinition.range], [{distance: 500, withTargets: true},
    {type: "single", required: false, count: 1, notHostile: true, notSelf: true}, {type: "ranged", normal: {value: 5, unit: "ft"}}]);
  assert.equal(validateActionDefinition(doorDefinition).ok, true);
  assert.deepEqual(door.flags.wildpath.conversion.notes, []);
  // The Player's Handbook module's Dimension Door predates dnd5e's teleport activity: only its failed arrival's damage.
  const older = spell("testDimensionDr2", "Dimension Door", null, "<p>You teleport to a location within range. You can also teleport one "
    + "willing creature.</p>");
  older.system.range = {value: "500", units: "ft"};
  older.system.activities = {a: {...older.system.activities.a, _id: "actdamage", type: "damage", teleport: undefined,
    damage: {parts: [{number: 4, denomination: 6, types: ["force"]}]}}};
  const [teleports, failed] = convertItem(older).items;
  assert.deepEqual([teleports._id, teleports.name, teleports.system.definition.teleport, failed.name, failed.system.definition.damage.length],
    ["testDimensionDr2", "Dimension Door (teleport)", {distance: 500, withTargets: true}, "Dimension Door (damage)", 1]);
  assert.equal(validateActionDefinition(teleports.system.definition).ok, true);
  const [far] = convertItem(spell("testTeleport0001", "Teleport", {override: true, units: "ft"})).items;
  assert.equal(far.system.definition.teleport, undefined);
  assert.match(far.flags.wildpath.conversion.notes[0], /not automated \(teleport, narrative\)/u, "it leaves the Scene: narrative");
});
