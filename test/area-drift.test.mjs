import {test} from "node:test";
import assert from "node:assert/strict";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {FOUNDRY_GRID_TYPES} from "../module/adapters/foundry-v14-tactical-grid-adapter.mjs";
import {areaCovers, createFoundryPersistentAreas} from "../module/adapters/foundry-v14-persistent-areas.mjs";

const burn = {schemaVersion: 1, id: "action:burn", label: "Burn", costs: {allOf: []},
  damage: [{id: "fire", expression: {type: "constant", value: 1}, damageType: "fire", provenance: "spell-base"}]};
/** The validation errors' paths of an Action whose area (a 10-ft radial one by default) lasts with this persistence. */
const reasons = (persistence, area={}) => validateActionDefinition({schemaVersion: 1, id: "action:cloud", label: "Cloud",
  costs: {allOf: []}, targeting: {type: "area"}, area: {shape: "radial", size: {value: 10, unit: "ft"}, persistence, ...area}})
  .errors.map(error => error.path);

test("a clock's drift is validated: a placed area only, never a wall that blocks, a section's leftover, nor carrying what it bars", () => {
  assert.deepEqual(reasons({clock: {drift: {distance: 10}}}), [], "Cloudkill");
  assert.deepEqual(reasons({clock: {drift: {distance: 50, carries: true}, resize: {top: -50}}, elevation: {bottom: 0, top: 300}},
    {shape: "wall", size: {value: 300, unit: "ft"}}), [], "Tsunami: carrying, with its falling top");
  assert.deepEqual(reasons({clock: {drift: {distance: 10}}, bars: {}}), [], "a drifting ward that carries nobody");
  for ( const drift of [{}, {distance: 0}, {distance: "10"}, {distance: 10, carries: "yes"}, {distance: 10, toward: "east"}, 10] ) {
    assert.deepEqual(reasons({clock: {drift}}), ["area.persistence.clock.drift"], JSON.stringify(drift));
  }
  const placedOnly = ["area.persistence.clock.drift"];
  assert.deepEqual(reasons({clock: {drift: {distance: 10}}}, {shape: "emanation"}), placedOnly, "an emanation goes with its creature");
  assert.deepEqual(reasons({clock: {drift: {distance: 10}}, onObject: "object"}), placedOnly, "one cast on an object");
  assert.deepEqual(reasons({clock: {drift: {distance: 10}}, blocks: ["move"]}, {shape: "wall", size: {value: 30, unit: "ft"}}), placedOnly,
    "a wall that blocks stays where it was made");
  assert.deepEqual(reasons({clock: {drift: {distance: 10, carries: true}}, bars: {}}), ["area.persistence.clock.drift.carries"],
    "its own edge would stop the creatures it carries");
  assert.deepEqual(reasons({blocks: ["move"], sections: {size: 10, ac: 12, hp: 30, leaves: {clock: {drift: {distance: 10}}}}},
    {shape: "wall", size: {value: 30, unit: "ft"}}), ["area.persistence.sections.leaves"], "a leftover stands where its section did");
});

/**
 * A square 100-px, 5-ft grid Scene (Foundry's offsets: i the row, j the column; a GridField's x is the row, y the column) of
 * 1x1 creature Tokens (`[id, x, y]` in pixels) and two-way move walls (`[x0, y0, x1, y1]`); a Token's update first asks
 * the areas adapter which areas the step enters or leaves, as the movement authority does when it approves it.
 */
function world(tokens, walls=[]) {
  const scene = {id: "scene", grid: {isSquare: true, size: 100, sizeX: 100, sizeY: 100, distance: 5, units: "ft",
    type: FOUNDRY_GRID_TYPES.SQUARE, isHexagonal: false, isGridless: false,
    getOffset: point => ({i: Math.floor(point.y / 100), j: Math.floor(point.x / 100)}),
    getTopLeftPoint: offset => ({x: offset.j * 100, y: offset.i * 100}),
    getCenterPoint: offset => ({x: (offset.j * 100) + 50, y: (offset.i * 100) + 50}),
    getVertices: ({i, j}) => [{x: j * 100, y: i * 100}, {x: (j + 1) * 100, y: i * 100}, {x: (j + 1) * 100, y: (i + 1) * 100}, {x: j * 100, y: (i + 1) * 100}],
    getAdjacentOffsets: ({i, j}) => [{i: i - 1, j}, {i, j: j + 1}, {i: i + 1, j}, {i, j: j - 1}],
    measurePath: ([a, b]) => ({distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 100 * 5})},
  dimensions: {distance: 5, units: "ft", size: 100, sceneX: 0, sceneY: 0, sceneWidth: 3000, sceneHeight: 3000, columns: 30, rows: 30,
    sceneRect: {contains: (x, y) => (x >= 0) && (y >= 0) && (x < 3000) && (y < 3000)}},
  walls: walls.map(c => ({c, move: 20, sight: 20, light: 20, dir: 0, door: 0, ds: 0})), regions: [], crossings: [], areas: null};
  const list = tokens.map(([id, x, y]) => {
    const token = {id, uuid: `Scene.scene.Token.${id}`, x, y, width: 1, height: 1, elevation: 0, parent: scene, updates: [],
      actor: {id, uuid: `Actor.${id}`, statuses: new Set(), effects: []},
      getCenterPoint: (p=token) => ({x: p.x + 50, y: p.y + 50}),
      getSnappedPosition: p => ({x: Math.round(p.x / 100) * 100, y: Math.round(p.y / 100) * 100}),
      getOccupiedGridSpaceOffsets: (p=token) => [{i: p.y / 100, j: p.x / 100}],
      async update(data, operation) {
        token.updates.push({data, operation});
        const commit = position => {
          const step = {previous: {x: token.x, y: token.y}, position: {x: token.x, y: token.y, ...position}};
          scene.crossings.push(...[...scene.areas.entered(token, step), ...scene.areas.exited(token, step)]
            .map(({region}) => `${token.id} ${region.id}`));
          Object.assign(token, position);
        };
        // As Foundry checkpoints a move on a Scene with a crossing area: its first field now, the rest after the update returns.
        const [dx, dy] = [(data.x ?? token.x) - token.x, (data.y ?? token.y) - token.y];
        if ( Math.max(Math.abs(dx), Math.abs(dy)) <= 100 ) return commit(data);
        commit({x: token.x + (Math.sign(dx) * 100), y: token.y + (Math.sign(dy) * 100)});
        setTimeout(() => commit(data), 0);
      }};
    return token;
  });
  scene.tokens = Object.assign(list, {get: id => list.find(token => token.id === id)});
  return scene;
}

/**
 * A placed lasting area over `fields` (`[row, column]`) of `scene`, cast by "caster", with a round clock drifting as `drift`
 * and an Action on entering and leaving it; the adapter runs on the active GM and records whom each run is for (`ran`).
 */
function driftingArea(scene, fields, drift) {
  const region = {id: "cloud", parent: scene, shapes: [], operations: [],
    flags: {wildpath: {area: {schemaVersion: 1, label: "Cloud", actionDefinitionId: "action:cloud", topology: "square",
      fields: fields.map(([x, y]) => ({x, y})), shape: "wall", size: 25, attached: false, band: {bottom: null, top: null},
      sourceTokenId: "caster", sourceActorRef: "Actor.caster", createdAt: null, applied: {},
      persistence: {oncePerTurn: false, concentration: false, duration: null, clock: {drift},
        triggers: [{on: ["area.entered", "area.exited"], action: burn}]}}}},
    async update(changes, operation) {
      this.operations.push(operation);
      for ( const [path, value] of Object.entries(changes) ) {
        const keys = path.split(".");
        const last = keys.pop();
        keys.reduce((node, key) => (node[key] ??= {}), this)[last] = value;
      }
    },
    async delete() { scene.regions.splice(scene.regions.indexOf(this), 1); }};
  scene.regions.push(region);
  const ran = [];
  const game = {user: {id: "gm"}, users: {activeGM: {id: "gm"}}, combat: null, combats: [], scenes: Object.assign([scene], {get: () => scene})};
  scene.areas = createFoundryPersistentAreas({game, logger: {warn() {}},
    coordinator: {resolveAuthorityAction: async () => ({ok: false})},
    resolveAction: async ({intent}) => {
      ran.push(...intent.targetRefs.map(ref => ref.tokenId));
      return {ok: false, reason: "not run here"};
    }});
  const tick = round => scene.areas.onTurn("turn.started", {combatant: {token: scene.tokens.get("caster"), combat: {id: "combat", round, turn: 0}},
    context: {round, turn: 0}});
  return {region, ran, tick, fields: () => region.flags.wildpath.area.fields.map(({x, y}) => [x, y])};
}

test("a drifting area moves its distance a tick straight away from its caster, through walls, entering whom it reaches; no update is a GM drag", async () => {
  // Cloudkill, 10 ft a turn: a 2x2 cloud east of its caster, a wall in its way, a creature in it and one ahead.
  const scene = world([["caster", 0, 300], ["inside", 300, 300], ["ahead", 500, 400]], [[450, 0, 450, 3000]]);
  const {region, ran, tick, fields} = driftingArea(scene, [[3, 2], [3, 3], [4, 2], [4, 3]], {distance: 10});
  await tick(1);
  assert.deepEqual(fields(), [[3, 4], [3, 5], [4, 4], [4, 5]], "two fields east, through the wall");
  assert.deepEqual(region.shapes, [{type: "grid", offsets: [{i: 3, j: 4}, {i: 3, j: 5}, {i: 4, j: 4}, {i: 4, j: 5}]}], "redrawn");
  assert.deepEqual(ran, ["ahead"], "the creature it reached is entered; the one it left behind is not");
  assert.deepEqual(scene.tokens.get("inside").updates, [], "without carries nobody moves with it");
  assert.equal(areaCovers(region.flags.wildpath.area, scene.tokens.get("inside")), false);
  assert.ok(region.operations.every(operation => operation?.wildpath?.areaMove === true), "never read as a GM drag");
  await tick(1);
  assert.deepEqual(fields()[0], [3, 4], "the same turn again: no tick, no move");
  await tick(2);
  assert.deepEqual(fields()[0], [3, 6], "the next turn: 10 ft more");
  // With its caster on its center, it has no way away from it.
  const still = world([["caster", 200, 300]]);
  const centered = driftingArea(still, [[2, 1], [2, 2], [2, 3], [3, 1], [3, 2], [3, 3], [4, 1], [4, 2], [4, 3]], {distance: 10});
  await centered.tick(1);
  assert.deepEqual(centered.fields()[0], [2, 1]);
});

test("an even-width area drifts alike from casters mirrored either side of its line (its center is a vertex)", async () => {
  for ( const row of [2, 3] ) {
    const {tick, fields} = driftingArea(world([["caster", 0, row * 100]]), [[2, 6], [2, 7], [3, 6], [3, 7]], {distance: 10});
    await tick(1);
    assert.deepEqual(fields(), [[2, 8], [2, 9], [3, 8], [3, 9]], `caster on row ${row}: straight east`);
  }
});

test("a carrying area moves each creature in it by its own displacement, the front first; a wall leaves one behind", async () => {
  // A Tsunami-like wall two fields thick and five long, north to south, east of its caster: 10 ft a turn, carrying.
  const wall = [3, 4, 5, 6, 7].flatMap(row => [[row, 2], [row, 3]]);
  const scene = world([["caster", 0, 500], ["north", 200, 300], ["south", 300, 700], ["front", 300, 400], ["rear", 200, 400],
    ["walled", 300, 500], ["ahead", 500, 300]], [[390, 500, 390, 600]]);
  const {ran, tick, fields, region} = driftingArea(scene, wall, {distance: 10, carries: true});
  await tick(1);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(fields(), [3, 4, 5, 6, 7].flatMap(row => [[row, 4], [row, 5]]));
  assert.ok(scene.tokens.every(token => token.updates.length !== 1), "each carried two fields in two one-field updates");
  const at = id => [scene.tokens.get(id).x, scene.tokens.get(id).y];
  // Pushed away from its caster's center each would fan out (north and south off the wall's ends); carried, each keeps its row.
  assert.deepEqual([at("north"), at("south")], [[400, 300], [500, 700]], "both ends of a long wall move with it, still in it");
  assert.deepEqual([at("front"), at("rear")], [[500, 400], [400, 400]], "the front creature moved first, so the rear one was not blocked");
  assert.deepEqual(scene.tokens.get("north").updates[0].operation, {wildpath: {movementKind: "forced"}});
  assert.deepEqual(at("walled"), [300, 500], "a wall stopped it at its first step");
  assert.equal(areaCovers(region.flags.wildpath.area, scene.tokens.get("walled")), false, "and the area left it behind");
  assert.deepEqual(at("caster"), [0, 500]);
  assert.deepEqual(scene.crossings, [], "no carried step entered or left the area carrying it");
  assert.deepEqual(ran, ["ahead"], "only the creature it reached is entered");
});
