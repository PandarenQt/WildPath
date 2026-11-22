import {test} from "node:test";
import assert from "node:assert/strict";
import {difficultTerrainBehavior, difficultTerrainPolicy, regionDifficulty} from "../module/adapters/foundry-v14-terrain.mjs";
import {areaSpares} from "../module/adapters/foundry-v14-hostility.mjs";

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

test("an area acting on one side spares by disposition: enemies spares the caster's own, allies affects only them (areaSpares)", () => {
  const caster = {id: "caster", disposition: 1};
  const [friend, foe, neutral, secret] = [1, -1, 0, -2].map((disposition, i) => ({id: `t${i}`, disposition}));
  const spared = (affects, from=caster) => [from, friend, foe, neutral, secret].map(token => areaSpares(affects, from, token));
  assert.deepEqual(spared("enemies"), [true, true, false, false, false], "Spirit Guardians: the caster is spared, neutral and secret creatures burn");
  assert.deepEqual(spared("enemies", {id: "caster", disposition: 0}), [true, false, false, true, false], "a neutral caster's own area spares it and its fellow neutrals");
  assert.deepEqual(spared("allies"), [false, false, true, true, true], "the caster and its side only (Q110 (a))");
  assert.deepEqual(spared("allies", {id: "caster", disposition: -1}), [false, true, false, true, false], "a hostile caster's secret ally is on its side");
  assert.deepEqual(spared("allies", {id: "caster", disposition: 0}), [false, true, true, true, true], "a neutral caster's allies are itself");
  assert.deepEqual(spared(null), [false, false, false, false, false], "absent: everyone");
  assert.deepEqual([areaSpares("allies", null, friend), areaSpares("enemies", null, foe)], [true, true], "no caster: no one");
});

test("a lasting area's Difficult Terrain slows only the side it affects (Conjure Minor Elementals: enemies)", () => {
  const caster = {id: "caster", disposition: 1};
  const sided = affects => ({...region(), flags: {wildpath: {area: {difficultTerrain: {types: []}, sourceTokenId: "caster",
    persistence: {affects}}}}});
  const mover = (regions, disposition, id="mover") => {
    const token = {...hero(regions), id, disposition};
    token.parent.tokens = new Map([["caster", caster]]);
    return token;
  };
  assert.equal(difficultTerrainPolicy(mover([sided("enemies")], -1))(step(11)).amount, 10, "a foe wades through it");
  assert.equal(difficultTerrainPolicy(mover([sided("enemies")], 1))(step(11)), null, "the caster's ally walks");
  assert.equal(difficultTerrainPolicy(mover([sided("enemies")], 1, "caster"))(step(11)), null, "and so does its caster");
  assert.equal(difficultTerrainPolicy(mover([sided("allies")], -1))(step(11)), null, "allies-only terrain spares a foe");
  assert.equal(difficultTerrainPolicy(mover([sided("allies")], 1))(step(11)).amount, 10, "and slows an ally");
  assert.equal(difficultTerrainPolicy(mover([sided(undefined)], 1))(step(11)).amount, 10, "without affects it slows everyone");
  assert.equal(difficultTerrainPolicy(mover([sided("enemies"), region()], 1))(step(11)).amount, 10, "painted terrain still slows");
});
