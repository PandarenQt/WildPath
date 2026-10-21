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

test("an intent carries one teleport point, plain numbers only", () => {
  const intent = sanitizeActionIntentPayload({intent: {actionRef: "Item.misty", teleport: {point: {x: "1150", y: 520, extra: 1}, other: 2}}});
  assert.deepEqual(intent.teleport, {point: {x: 1150, y: 520}});
  assert.equal(sanitizeActionIntentPayload({intent: {teleport: {point: {x: "far"}}}}).teleport, undefined);
});

test("Misty Step converts to a self teleport of 30 feet; a teleport anywhere (Teleport) stays by hand", () => {
  const SRD = {license: "CC-BY-4.0", rules: "2024", book: ""};
  const spell = (id, name, teleport) => ({_id: id, name, type: "spell", img: "systems/dnd5e/icons/spell.webp", effects: [],
    system: {source: SRD, identifier: name.toLowerCase().replace(/\s+/g, "-"), level: 2, preparation: {mode: "prepared"},
      properties: ["vocal"], activation: {type: "bonus"}, range: {units: "self"}, target: {affects: {}, template: {}},
      activities: {a: {_id: "actteleport", type: "teleport", sort: 0, activation: {type: "action", override: false},
        range: {override: false}, target: {override: false, template: {}, affects: {}}, effects: [], consumption: {targets: [], spellSlot: true},
        teleport}}}});
  const [misty] = convertItem(spell("testMistyStep001", "Misty Step", {override: true, value: "30", units: "ft"})).items;
  const definition = misty.system.definition;
  assert.deepEqual([definition.teleport, definition.targeting, definition.costs.allOf[0].capability], [{distance: 30}, {type: "self"}, "bonus-action"]);
  assert.equal(validateActionDefinition(definition).ok, true);
  assert.deepEqual(misty.flags.wildpath.conversion.notes, []);
  const [far] = convertItem(spell("testTeleport0001", "Teleport", {override: true, units: "ft"})).items;
  assert.equal(far.system.definition.teleport, undefined);
  assert.match(far.flags.wildpath.conversion.notes[0], /not automated \(teleport, narrative\)/u, "it leaves the Scene: narrative");
});
