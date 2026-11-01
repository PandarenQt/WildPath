import {test} from "node:test";
import assert from "node:assert/strict";
import {creatureOccupancyPolicy, creatureSpaceTerrainPolicy} from "../module/adapters/foundry-v14-occupancy.mjs";
import {evaluateMovementPath} from "../module/helpers/movement-paths.mjs";
import {movementMessage} from "../module/helpers/refusal-messages.mjs";

/**
 * A 100-px, 5-ft square Scene: the mover at square 0 of row 0, each other creature at its own square of that row.
 * `others` are [id, x, {size, disposition, modifiers, statuses, elevation, level}].
 */
function world({size="medium", modifiers=[], elevation=0, others=[]}={}) {
  const scene = {grid: {type: 1, size: 100, distance: 5}, dimensions: {size: 100, distance: 5}, tokens: []};
  const token = (id, x, {size="medium", disposition=-1, modifiers=[], statuses=[], elevation=0, level="ground"}={}) => ({id,
    x: x * 100, y: 0, width: 1, height: 1, elevation, level, disposition, parent: scene, actor: {system: {traits: {size}}, statuses: new Set(statuses),
      getStatistic: ([domain]) => ({totalModifier: modifiers.includes(domain) ? 1 : 0})}});
  scene.tokens.push(token("mover", 0, {size, disposition: 1, modifiers, elevation}), ...others.map(([id, x, options]) => token(id, x, options)));
  return scene.tokens[0];
}

/** Whether a walk from square 0 to square `to` along row 0 is allowed, and what it costs. */
function walk(mover, to, {occupancy=creatureOccupancyPolicy(mover), stepCost=null}={}) {
  const anchors = Array.from({length: to + 1}, (_, x) => ({x, y: 0}));
  const result = evaluateMovementPath({anchors}, {gridDistance: 5, occupancyPolicy: occupancy, stepCostPolicy: stepCost});
  return {ok: result.valid, cost: result.routeCost.amount, reason: result.failures[0]?.reason ?? null};
}

test("a creature moves through an ally's space but not through a hostile one of its own size", () => {
  assert.equal(walk(world({others: [["ally", 1, {disposition: 1}]]}), 2).ok, true, "an ally");
  assert.equal(walk(world({others: [["neutral", 1, {disposition: 0}]]}), 2).ok, true, "neutral is not hostile");
  const blocked = walk(world({others: [["orc", 1]]}), 2);
  assert.deepEqual([blocked.ok, /blocked/.test(blocked.reason)], [false, true], "a hostile creature of its size");
  assert.equal(walk(world({others: [["orc", 3]]}), 2).ok, true, "a hostile creature off its route");
});

test("through a hostile creature when it is Tiny, two sizes apart, or can't act", () => {
  assert.equal(walk(world({size: "tiny", others: [["orc", 1]]}), 2).ok, true, "a Tiny mover past a Medium one");
  assert.equal(walk(world({size: "tiny", others: [["kobold", 1, {size: "small"}]]}), 2).ok, false, "but not past a Small one");
  assert.equal(walk(world({others: [["rat", 1, {size: "tiny"}]]}), 2).ok, true, "a Tiny hostile creature");
  // A Large creature fills squares 1 and 2 (and row 1), a Huge one 1 to 3: the walk ends past them.
  assert.equal(walk(world({others: [["giant", 1, {size: "huge"}]]}), 4).ok, true, "two sizes larger");
  const ogre = walk(world({others: [["ogre", 1, {size: "large"}]]}), 3);
  assert.deepEqual([ogre.ok, /blocked/.test(ogre.reason)], [false, true], "one size larger");
  assert.equal(walk(world({size: "small", others: [["ogre", 1, {size: "large"}]]}), 3).ok, true, "Small past Large");
  assert.equal(walk(world({others: [["orc", 1, {statuses: ["stunned"]}]]}), 2).ok, true, "Incapacitated");
  assert.equal(creatureOccupancyPolicy(world({others: [["orc", 1, {statuses: ["dead"]}]]})), null, "a dead one is not in the way");
});

test("no creature ends its move in another's space, ally or not", () => {
  const ending = walk(world({others: [["ally", 2, {disposition: 1}]]}), 2);
  assert.deepEqual([ending.ok, /occupied/.test(ending.reason)], [false, true]);
  assert.equal(walk(world({size: "tiny", others: [["orc", 2]]}), 2).ok, false, "even where it may pass");
  assert.equal(walk(world({others: [["ally", 2, {disposition: 1}]]}), 3).ok, true, "passing through it is fine");
});

test("a swarm shares spaces both ways; Incorporeal Movement and Halfling Nimbleness pass through but don't stop", () => {
  assert.equal(creatureOccupancyPolicy(world({modifiers: ["occupancy.share"], others: [["orc", 1]]})), null, "a swarm ends anywhere");
  assert.equal(walk(world({others: [["swarm", 1, {modifiers: ["occupancy.share"]}]]}), 1).ok, true, "into a swarm's space");
  const ghost = world({modifiers: ["occupancy.pass"], others: [["orc", 1], ["elf", 2]]});
  assert.deepEqual([walk(ghost, 3).ok, walk(ghost, 2).ok], [true, false]);
  const halfling = world({size: "small", modifiers: ["occupancy.pass.larger"], others: [["orc", 1], ["kobold", 3, {size: "small"}]]});
  assert.deepEqual([walk(halfling, 2).ok, walk(halfling, 4).ok], [true, false], "past the Medium orc, not the Small kobold");
});

test("with the optional rule, a creature's space is Difficult Terrain unless it is Tiny or an ally: twice the cost, not stacking", () => {
  const mover = world({others: [["neutral", 1, {disposition: 0}]]});
  assert.equal(creatureSpaceTerrainPolicy(mover, null), null, "off by default");
  assert.equal(walk(mover, 2, {stepCost: creatureSpaceTerrainPolicy(mover, null, {always: true})}).cost, 15);
  const allied = world({others: [["ally", 1, {disposition: 1}], ["rat", 2, {size: "tiny"}]]});
  assert.equal(walk(allied, 3, {stepCost: creatureSpaceTerrainPolicy(allied, null, {always: true})}).cost, 15, "an ally, a Tiny one");
  const terrain = ({toFootprint}) => ((toFootprint.fieldKeys[0] === "square:1,0") ? {amount: 10, source: "difficult-terrain"} : null);
  assert.equal(walk(mover, 2, {stepCost: creatureSpaceTerrainPolicy(mover, terrain, {always: true})}).cost, 15, "already Difficult Terrain");
  const ghost = world({modifiers: ["occupancy.pass", "occupancy.difficult"], others: [["orc", 1], ["ally", 2, {disposition: 1}]]});
  assert.equal(walk(ghost, 3, {stepCost: creatureSpaceTerrainPolicy(ghost, null)}).cost, 25, "Incorporeal Movement's own, allies too");
  const free = world({modifiers: ["terrain.ignore"], others: [["ally", 1, {disposition: 1}]]});
  assert.equal(creatureSpaceTerrainPolicy(free, null, {always: true}), null, "Freedom of Movement");
});

test("a creature above another, or on another Scene Level, is not in its way", () => {
  const flyer = world({elevation: 30, others: [["orc", 1]]});
  assert.deepEqual([walk(flyer, 2).ok, walk(flyer, 1).ok], [true, true], "passes over it and hovers above it");
  assert.equal(walk(flyer, 1, {occupancy: creatureOccupancyPolicy(flyer, {elevation: 0})}).ok, false, "but doesn't land in its space");
  assert.equal(walk(world({others: [["orc", 1, {elevation: 5}]]}), 2).ok, true, "under one 5 feet up, a cube above");
  assert.equal(walk(world({others: [["orc", 1, {elevation: 2}]]}), 2).ok, false, "not under one 2 feet up, still in its cube");
  assert.equal(walk(world({others: [["orc", 1, {level: "upper"}]]}), 1).ok, true, "another Scene Level");
  const neutral = world({elevation: 30, others: [["neutral", 1, {disposition: 0}]]});
  assert.equal(walk(neutral, 2, {stepCost: creatureSpaceTerrainPolicy(neutral, null, {always: true})}).cost, 10, "no Difficult Terrain over it");
});

test("a move refused for a creature's space says so, not just that something blocks it", () => {
  const game = {user: {isGM: false}, i18n: {localize: key => `loc:${key}`}};
  assert.equal(movementMessage({reason: "Movement is blocked by a hostile creature's space."}, game), "loc:WILDPATH.REFUSAL.CreatureInWay");
  assert.equal(movementMessage({reason: "Movement can't end in an occupied space."}, game), "loc:WILDPATH.REFUSAL.OccupiedSpace");
  assert.equal(movementMessage({reason: "Movement is blocked by a wall."}, game), "loc:WILDPATH.REFUSAL.Blocked");
});
