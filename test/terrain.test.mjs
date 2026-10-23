import {test} from "node:test";
import assert from "node:assert/strict";
import {difficultTerrainBehavior, difficultTerrainPolicy, regionDifficulty} from "../module/adapters/foundry-v14-terrain.mjs";

const grid = {isSquare: true, isHexagonal: false, isGridless: false, size: 100, sizeX: 100, sizeY: 100, distance: 5, type: 1};
/** A Region over the squares from x = `from` to `to` (in squares) of row 10, with a "Modify Movement Cost" behavior. */
const region = ({from=11, to=11, difficulties={walk: 2}, types=null, disabled=false}={}) => ({
  behaviors: [{type: "modifyMovementCost", disabled, system: {difficulties}}],
  testPoint: ({x, y}) => (x >= from * 100) && (x < (to + 1) * 100) && (y >= 1000) && (y < 1100),
  ...(types ? {flags: {wildpath: {area: {difficultTerrain: {types}}}}} : {})
});
const hero = (regions, ignored=[]) => ({elevation: 0, parent: {grid, dimensions: {size: 100, sceneX: 0, sceneY: 0}, regions},
  actor: {getStatistic: ([domain]) => ({totalModifier: ignored.includes(domain) ? 1 : 0})}});
const step = (x, extra={}) => ({toFootprint: {fields: [{x, y: 10}]}, defaultAmount: 5, movementKind: "voluntary", movementMode: "walk", ...extra});

test("a step into Difficult Terrain costs twice its distance; beside it, forced or teleported, it costs nothing extra", () => {
  const cost = difficultTerrainPolicy(hero([region()]));
  assert.deepEqual(cost(step(11)), {amount: 10, source: "difficult-terrain"});
  assert.equal(cost(step(12)), null, "beside it");
  assert.equal(cost(step(11, {movementKind: "forced"})), null, "pushed into it");
  assert.equal(difficultTerrainPolicy(hero([])), null, "a Scene without any");
  assert.equal(difficultTerrainPolicy(hero([region({disabled: true})])), null, "a disabled behavior");
  assert.deepEqual(difficultTerrainPolicy(hero([region({difficulties: {walk: 1, fly: 3}})]))(step(11, {movementMode: "fly"})).amount, 15,
    "each movement action its own difficulty");
  assert.equal(regionDifficulty(region({difficulties: {walk: 1}})), 1);
});

test("Freedom of Movement ignores all Difficult Terrain; Boots of the Winterlands only ice and snow", () => {
  assert.equal(difficultTerrainPolicy(hero([region()], ["terrain.ignore"])), null);
  const web = region({types: ["web"]});
  assert.equal(difficultTerrainPolicy(hero([web], ["terrain.ignore.ice"]))(step(11)).amount, 10, "webs are not ice");
  assert.equal(difficultTerrainPolicy(hero([region({types: ["ice"]})], ["terrain.ignore.ice"]))(step(11)), null);
  assert.equal(difficultTerrainPolicy(hero([region()], ["terrain.ignore.ice"]))(step(11)).amount, 10,
    "terrain of no kind (painted by the GM) is ignored only by what ignores it all");
});

test("a Difficult Terrain area's Region costs twice as much for each movement action", () => {
  assert.deepEqual(difficultTerrainBehavior(), {type: "modifyMovementCost", name: "Difficult Terrain", system: {difficulties: {walk: 2}}});
});
