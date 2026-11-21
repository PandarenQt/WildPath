import {test} from "node:test";
import assert from "node:assert/strict";
import {createFoundryTeleports, swapLandings, teleportDestination} from "../module/adapters/foundry-v14-teleport.mjs";
import {sanitizeActionIntentPayload} from "../module/helpers/multiplayer-authority.mjs";
import {convertItem} from "../scripts/content/dnd5e-to-wildpath.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";

/** A square grid of 100-pixel, 5-foot fields, with Tokens at the given top-left points: Medium, or `size` fields square. */
function scene(positions) {
  const grid = {
    getOffset: point => ({i: Math.floor(point.y / 100), j: Math.floor(point.x / 100)}),
    getTopLeftPoint: offset => ({x: offset.j * 100, y: offset.i * 100}),
    // Diagonals count 5 feet (2024's default), as Foundry measures them.
    measurePath: ([a, b]) => ({distance: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 100 * 5})
  };
  const result = {id: "scene", grid, dimensions: {sceneRect: {contains: (x, y) => (x >= 0) && (y >= 0) && (x < 2000) && (y < 2000)}}, tokens: []};
  result.tokens = positions.map(([id, x, y, size=1]) => ({id, x, y, parent: result, updates: [],
    getCenterPoint(data={}) { return {x: (data.x ?? this.x) + (50 * size), y: (data.y ?? this.y) + (50 * size)}; },
    getOccupiedGridSpaceOffsets(data={}) {
      const {i, j} = grid.getOffset({x: (data.x ?? this.x) + 1, y: (data.y ?? this.y) + 1});
      return Array.from({length: size * size}, (_, index) => ({i: i + Math.floor(index / size), j: j + (index % size)}));
    },
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

test("a space held only by a creature on another plane is a free landing; one on its own plane is not", () => {
  const {tokens: [caster, ghost]} = scene([["caster", 500, 500], ["ghost", 700, 500]]);
  ghost.actor = {statuses: new Set(["ethereal"])};
  assert.deepEqual(teleportDestination({token: caster, point: {x: 750, y: 550}, distance: 30}), {ok: true, position: {x: 700, y: 500}});
  caster.actor = {statuses: new Set(["ethereal"])};
  assert.deepEqual(teleportDestination({token: caster, point: {x: 750, y: 550}, distance: 30}), {ok: false, code: "Occupied"});
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

test("swapLandings: each lands on the other's top-left, refused onto a third creature, off the Scene or onto each other (Q113)", () => {
  const {tokens: [goblin, ally]} = scene([["goblin", 500, 500], ["ally", 600, 500]]);
  assert.deepEqual(swapLandings(goblin, ally), {ok: true, a: {x: 600, y: 500}, b: {x: 500, y: 500}}, "the partner's space is no obstacle");
  // A Large ogre and a Medium goblin: the ogre's four fields at the goblin's top-left.
  const {tokens: [ogre, beside]} = scene([["ogre", 500, 500, 2], ["goblin", 700, 500]]);
  assert.deepEqual(swapLandings(ogre, beside), {ok: true, a: {x: 700, y: 500}, b: {x: 500, y: 500}});
  const {tokens: [crowded, partner]} = scene([["ogre", 500, 500, 2], ["goblin", 700, 500], ["wolf", 800, 600]]);
  assert.deepEqual(swapLandings(crowded, partner), {ok: false, code: "Occupied"}, "the ogre would overlap the wolf");
  const {tokens: [corner, edge]} = scene([["ogre", 1700, 500, 2], ["goblin", 1900, 500]]);
  assert.deepEqual(swapLandings(corner, edge), {ok: false, code: "OffScene"});
  // The goblin up-left of the ogre: the ogre on the goblin's top-left would cover the ogre's old top-left, where the goblin lands.
  const {tokens: [big, small]} = scene([["ogre", 600, 600, 2], ["goblin", 500, 500]]);
  assert.deepEqual(swapLandings(big, small), {ok: false, code: "Occupied"});
  assert.deepEqual(swapLandings(goblin, null), {ok: false, code: "NoToken"});
  assert.deepEqual(swapLandings(goblin, goblin), {ok: false, code: "NoToken"});
  // A hex grid: a hex's top-left corner lies in its up-left neighbour, so the landing is each Token's own x/y, never snapped
  // again (here getOffset of a corner is one field up-left, as Foundry's HexagonalGrid gives).
  const hex = scene([["goblin", 500, 500], ["ally", 600, 500]]);
  hex.grid.getOffset = point => ({i: Math.floor(point.y / 100) - 1, j: Math.floor(point.x / 100) - 1});
  const [hexGoblin, hexAlly] = hex.tokens;
  assert.deepEqual(swapLandings(hexGoblin, hexAlly), {ok: true, a: {x: 600, y: 500}, b: {x: 500, y: 500}});
});

test("swaps after an Action, on the active GM: a rider's riderSwap (Redirect Attack), an Action's swap with its one target", async () => {
  const run = async (state, userId="gm", positions=[["goblin", 500, 500], ["ally", 600, 500]]) => {
    const where = scene(positions);
    const game = {user: {id: userId}, users: {activeGM: {id: "gm"}}, scenes: [where]};
    await createFoundryTeleports({game}).afterResolution({state});
    return where.tokens;
  };
  const [goblin, ally] = await run({input: {riderSwap: {goblin: "ally"}}});
  assert.deepEqual([goblin.x, goblin.y, ally.x, ally.y], [600, 500, 500, 500]);
  assert.deepEqual(goblin.updates[0].operation, {movement: {goblin: {waypoints: [{x: 600, y: 500, action: "blink"}], showRuler: false}},
    wildpath: {movementKind: "teleport"}}, "a Blink: no movement spent, no Opportunity Attack");
  assert.deepEqual(ally.updates[0].operation.movement.ally.waypoints, [{x: 500, y: 500, action: "blink"}]);
  const [still] = await run({input: {riderSwap: {goblin: "ally"}}}, "player");
  assert.deepEqual(still.updates, [], "nobody but the active GM moves them");
  // Bait and Switch: its creature and the target it completed with (in the intent, or chosen at the prompt).
  const swap = {actionDefinition: {swap: true}, source: {tokenId: "goblin"}};
  const [fighter, friend] = await run({...swap, targets: [{tokenId: "ally"}]});
  assert.deepEqual([fighter.x, friend.x], [600, 500]);
  const [prompted] = await run({...swap, targets: [], results: {targetResolution: {targetContexts: [{target: {target: {tokenId: "ally"}}}]}}});
  assert.equal(prompted.x, 600);
  const [alone] = await run({actionDefinition: {}, source: {tokenId: "goblin"}, targets: [{tokenId: "ally"}]});
  assert.deepEqual(alone.updates, [], "no swap without the key");
  // Its outcome gates it as a push's: a failed check, a made save or a miss keeps both put; a failed save or a hit swaps.
  const [checked] = await run({...swap, targets: [{tokenId: "ally"}], results: {checkResolution: {success: false}}});
  assert.deepEqual(checked.updates, [], "a failed check");
  const saved = result => ({...swap, actionDefinition: {swap: true, save: {}}, targets: [{tokenId: "ally"}],
    results: {saveResolution: {results: [{ok: true, success: result, target: {tokenId: "ally"}}]}}});
  assert.deepEqual([(await run(saved(true)))[0].updates.length, (await run(saved(false)))[0].x], [0, 600], "a made save, a failed one");
  const struck = hits => ({...swap, actionDefinition: {swap: true, attack: {}}, targets: [{tokenId: "ally"}], results: {attackResolution: {hits}}});
  assert.deepEqual([(await run(struck([])))[0].updates.length, (await run(struck([{target: {tokenId: "ally"}}])))[0].x], [0, 600], "a miss, a hit");
  // Two redirects in one Action (one attack hitting two Goblin Bosses): each pair swaps.
  const pairs = await run({input: {riderSwap: {goblin: "ally", boss: "guard"}}}, "gm",
    [["goblin", 500, 500], ["ally", 600, 500], ["boss", 900, 900], ["guard", 1000, 900]]);
  assert.deepEqual(pairs.map(token => token.x), [600, 500, 1000, 900]);
  // Refused (a Large creature would land on a third): neither moves.
  const [ogre, goblinToo, wolf] = await run({input: {riderSwap: {ogre: "goblin"}}}, "gm",
    [["ogre", 500, 500, 2], ["goblin", 700, 500], ["wolf", 800, 600]]);
  assert.deepEqual([ogre.updates, goblinToo.updates, wolf.updates], [[], [], []]);
});

test("a swap trades places with one target; a rider's swap goes with a redirect", () => {
  const base = {schemaVersion: 1, id: "action:bait-and-switch", costs: {allOf: [{capability: "movement", amount: 5}]},
    range: {type: "ranged", normal: {value: 5, unit: "ft"}}, swap: true};
  // Bait and Switch written as data: a willing (not hostile) creature within 5 feet that isn't Incapacitated, for 5 feet of movement.
  assert.equal(validateActionDefinition({...base, targeting: {type: "single", required: true, count: 1, notHostile: true,
    eligible: {missingCondition: "incapacitated"}}}).ok, true);
  assert.equal(validateActionDefinition({...base, targeting: {type: "self"}}).ok, false);
  assert.equal(validateActionDefinition({...base, targeting: {type: "single", count: 2}}).ok, false);
  const reaction = {schemaVersion: 1, id: "action:redirect", range: {type: "self"}, targeting: {type: "self"}};
  assert.equal(validateActionDefinition({...reaction, rider: {redirectDamage: {to: "chosen", range: 5}, protects: "target", swap: true}}).ok, true);
  assert.equal(validateActionDefinition({...reaction, rider: {swap: true}}).ok, false);
});

test("an intent carries one teleport point, plain numbers only", () => {
  const intent = sanitizeActionIntentPayload({intent: {actionRef: "Item.misty", teleport: {point: {x: "1150", y: 520, extra: 1}, other: 2}}});
  assert.deepEqual(intent.teleport, {point: {x: 1150, y: 520}});
  assert.equal(sanitizeActionIntentPayload({intent: {teleport: {point: {x: "far"}}}}).teleport, undefined);
  // An aimed push's landing (Telekinesis) the same way.
  assert.deepEqual(sanitizeActionIntentPayload({intent: {push: {point: {x: "1150", y: 520, extra: 1}, tokenId: "x"}}}).push,
    {point: {x: 1150, y: 520}});
  assert.equal(sanitizeActionIntentPayload({intent: {push: {point: {x: 1, y: "near"}}}}).push, undefined);
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
